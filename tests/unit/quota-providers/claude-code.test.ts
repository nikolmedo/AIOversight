import './../../helpers/electron-stub';
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { claudeUsageLiveResponse } from '../../helpers/fixtures';
import * as fs from 'fs';
import * as path from 'path';
import {
  createClaudeCodeQuotaProvider,
  extractClaudeCodeSpendRecords,
  parseClaudeUsage,
} from '../../../src/main/connectors/claude-code/quota';
import { JsonlSpendScanner, SpendRecord } from '../../../src/main/connectors/shared/jsonl-spend-scanner';
import { costCentsExact } from '../../../src/main/connectors/shared/model-pricing';
import { createFakeContext } from '../../helpers/fake-context';
import { makeTempDir, removeTempDir } from '../../helpers/temp-dir';

const NOW = Date.parse('2026-09-17T03:14:05Z');
const SEVEN_DAY_MS = 604_800_000;
const FIVE_HOUR_MS = 18_000_000;

function byId(body: unknown) {
  const { buckets } = parseClaudeUsage(body, NOW);
  return Object.fromEntries(buckets.map(b => [b.id, b]));
}

function limitEntry(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: 'weekly_scoped',
    group: 'weekly',
    percent: 10,
    severity: 'normal',
    resets_at: '2026-09-18T15:59:59Z',
    scope: null,
    is_active: false,
    ...overrides,
  };
}

describe('Claude usage parsing: limits[] from the live payload', () => {
  it('builds the 5-hour, 7-day and Fable weekly buckets from limits[]', () => {
    // Act
    const buckets = byId(claudeUsageLiveResponse());

    // Assert
    assert.equal(buckets['five-hour'].used, 3);
    assert.equal(buckets['five-hour'].label, '5-hour limit');
    assert.equal(buckets['five-hour'].windowMs, FIVE_HOUR_MS);
    assert.equal(buckets['seven-day'].used, 49);
    assert.equal(buckets['seven-day'].label, '7-day limit');

    const fable = buckets['weekly-model-fable'];
    assert.ok(fable, 'Fable weekly bucket is present');
    assert.equal(fable.label, 'Weekly Fable limit');
    assert.equal(fable.used, 45);
    assert.equal(fable.limit, 100);
    assert.equal(fable.unit, 'percent');
    assert.equal(fable.windowMs, SEVEN_DAY_MS);
    assert.equal(fable.resetsAt, Date.parse('2026-09-18T15:59:59.352216+00:00'));
    assert.equal(fable.defaultVisibility, 'always');
  });

  it('ignores the codename keys: the bucket set is exactly the known limits plus extra usage', () => {
    // Act
    const { buckets } = parseClaudeUsage(claudeUsageLiveResponse(), NOW);

    // Assert
    assert.deepEqual(
      buckets.map(b => b.id).sort(),
      ['extra-usage', 'five-hour', 'seven-day', 'weekly-model-fable'],
    );
  });

  it('adds a weekly breakdown line without 0% rows, largest share first', () => {
    // Act
    const { displayMessages } = parseClaudeUsage(claudeUsageLiveResponse(), NOW);

    // Assert
    assert.ok(displayMessages.includes('This week: Claude Code 93% · Cowork 6% · Chats 1%'));
    assert.ok(displayMessages.includes('Weekly Fable limit resets in 36h 45m'));
  });

  it('does not duplicate buckets when both limits[] and the legacy keys are present', () => {
    // Arrange: the legacy Opus key is also populated.
    const body = claudeUsageLiveResponse();
    body.seven_day_opus = { utilization: 20, resets_at: '2026-09-18T15:59:59Z' };
    (body.limits as unknown[]).push(
      limitEntry({ percent: 20, scope: { model: { id: null, display_name: 'Opus' }, surface: null } }),
    );

    // Act
    const { buckets } = parseClaudeUsage(body, NOW);
    const ids = buckets.map(b => b.id);

    // Assert
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids.filter(id => id === 'five-hour').length, 1);
    assert.equal(ids.filter(id => id === 'weekly-opus').length, 1);
  });
});

describe('Claude usage parsing: dynamic limit entries', () => {
  it('maps a scoped model named Opus or Sonnet to the pre-existing bucket ids, visible by default', () => {
    // Arrange
    const body = {
      limits: [
        limitEntry({ scope: { model: { id: null, display_name: 'Opus' }, surface: null } }),
        limitEntry({ scope: { model: { id: 'claude-sonnet-5', display_name: 'Sonnet' }, surface: null } }),
      ],
    };

    // Act
    const buckets = byId(body);

    // Assert
    assert.equal(buckets['weekly-opus'].label, 'Weekly Opus limit');
    assert.equal(buckets['weekly-opus'].defaultVisibility, 'always');
    assert.equal(buckets['weekly-sonnet'].label, 'Weekly Sonnet limit');
  });

  it('gives an unknown kind a humanized label, a data-derived id, and no guessed window', () => {
    // Arrange
    const body = {
      limits: [
        limitEntry({
          kind: 'monthly_scoped',
          group: 'monthly',
          scope: { model: { id: null, display_name: 'X' }, surface: null },
        }),
        limitEntry({ kind: 'burst_tokens', group: 'burst' }),
      ],
    };

    // Act
    const buckets = byId(body);

    // Assert
    const monthly = buckets['monthly-model-x'];
    assert.ok(monthly, 'monthly bucket is present');
    assert.equal(monthly.label, 'Monthly X limit');
    assert.equal(monthly.resetsAt, Date.parse('2026-09-18T15:59:59Z'));
    assert.equal(monthly.windowMs, undefined);
    assert.equal(buckets['burst-tokens'].label, 'Burst tokens limit');
  });

  it('prefers the model id for the bucket id when the vendor provides one', () => {
    // Act
    const buckets = byId({
      limits: [limitEntry({ scope: { model: { id: 'fable-v2', display_name: 'Fable' }, surface: null } })],
    });

    // Assert
    assert.equal(buckets['weekly-model-fable-v2'].label, 'Weekly Fable limit');
  });

  it('labels surface scopes given as an object or a bare string', () => {
    // Act
    const buckets = byId({
      limits: [
        limitEntry({ scope: { model: null, surface: { display_name: 'Claude Code' } } }),
        limitEntry({ scope: { model: null, surface: 'Cowork' } }),
      ],
    });

    // Assert
    assert.equal(buckets['weekly-surface-claude-code'].label, 'Weekly Claude Code limit');
    assert.equal(buckets['weekly-surface-cowork'].label, 'Weekly Cowork limit');
  });

  it('keeps ids unique when two entries derive the same id', () => {
    // Arrange
    const scope = { model: { id: null, display_name: 'Fable' }, surface: null };

    // Act
    const { buckets } = parseClaudeUsage({ limits: [limitEntry({ scope }), limitEntry({ scope })] }, NOW);

    // Assert
    assert.deepEqual(buckets.map(b => b.id), ['weekly-model-fable', 'weekly-model-fable-2']);
  });

  it('reports a null, non-numeric or non-finite percent as unmeasured, never 0', () => {
    // Arrange
    const scope = (name: string) => ({ model: { id: null, display_name: name }, surface: null });
    const body = {
      limits: [
        limitEntry({ percent: null, scope: scope('A') }),
        limitEntry({ percent: 'Infinity', scope: scope('B') }),
        limitEntry({ percent: '', scope: scope('C') }),
      ],
    };

    // Act
    const { buckets } = parseClaudeUsage(body, NOW);

    // Assert
    assert.equal(buckets.length, 3);
    for (const b of buckets) {
      assert.equal(b.used, null, b.id);
      assert.equal(b.remaining, null, b.id);
    }
  });

  it('skips malformed entries without throwing', () => {
    // Act
    const { buckets } = parseClaudeUsage({ limits: [null, 5, 'x', {}, { kind: '' }] }, NOW);

    // Assert
    assert.deepEqual(buckets, []);
    assert.deepEqual(parseClaudeUsage(null, NOW).buckets, []);
  });
});

describe('Claude usage parsing: legacy named keys (no limits[])', () => {
  it('produces the legacy buckets with their ids, labels and defaults', () => {
    // Arrange
    const body = {
      five_hour: { utilization: 12, resets_at: '2026-09-17T08:00:00Z' },
      seven_day: { utilization: 40, resets_at: '2026-09-18T16:00:00Z' },
      seven_day_opus: { utilization: 5, resets_at: '2026-09-18T16:00:00Z' },
      seven_day_sonnet: { utilization: 7, resets_at: null },
      nimbus_quill: { utilization: 0, resets_at: null },
    };

    // Act
    const { buckets } = parseClaudeUsage(body, NOW);
    const map = Object.fromEntries(buckets.map(b => [b.id, b]));

    // Assert
    assert.deepEqual(buckets.map(b => b.id), ['five-hour', 'seven-day', 'weekly-opus', 'weekly-sonnet']);
    assert.equal(map['five-hour'].label, '5-hour limit');
    assert.equal(map['five-hour'].windowMs, FIVE_HOUR_MS);
    assert.equal(map['seven-day'].used, 40);
    assert.equal(map['weekly-opus'].label, 'Weekly Opus limit');
    assert.equal(map['weekly-opus'].defaultVisibility, 'onDemand');
    assert.equal(map['weekly-sonnet'].defaultVisibility, 'onDemand');
    assert.equal(map['weekly-sonnet'].resetsAt, undefined);
  });

  it('falls back to the legacy keys when limits[] is empty or yields nothing', () => {
    // Act
    const empty = byId({ limits: [], seven_day: { utilization: 40 } });
    const junk = byId({ limits: [null], seven_day: { utilization: 40 } });

    // Assert
    assert.equal(empty['seven-day'].used, 40);
    assert.equal(junk['seven-day'].used, 40);
  });
});

describe('Claude usage parsing: extra usage money', () => {
  it('emits exactly one money bucket from spend when spend and extra_usage are both present', () => {
    // Act
    const { buckets } = parseClaudeUsage(claudeUsageLiveResponse(), NOW);
    const money = buckets.filter(b => b.id === 'extra-usage');

    // Assert
    assert.equal(money.length, 1);
    assert.equal(money[0].unit, 'usd');
    assert.equal(money[0].used, 0);
    assert.equal(money[0].limit, 4000);
    assert.equal(money[0].remaining, 4000);
    assert.equal(money[0].note, 'Turned off: out of credits');
  });

  it('converts amount_minor with its exponent to integer cents', () => {
    // Act
    const buckets = byId({
      spend: {
        used: { amount_minor: 125, currency: 'USD', exponent: 0 },
        limit: { amount_minor: 400_000, currency: 'USD', exponent: 4 },
        enabled: true,
      },
    });

    // Assert
    assert.equal(buckets['extra-usage'].used, 12_500);
    assert.equal(buckets['extra-usage'].limit, 4000);
    assert.equal(buckets['extra-usage'].note, undefined);
  });

  it('falls back to extra_usage when spend is absent or not in USD', () => {
    // Arrange
    const extraUsage = { monthly_limit: 4000, used_credits: 150, currency: 'USD', decimal_places: 2 };

    // Act
    const absent = parseClaudeUsage({ extra_usage: extraUsage }, NOW).buckets;
    const euro = parseClaudeUsage(
      {
        spend: { used: { amount_minor: 1, currency: 'EUR', exponent: 2 }, limit: { amount_minor: 2, currency: 'EUR', exponent: 2 } },
        extra_usage: extraUsage,
      },
      NOW,
    ).buckets;

    // Assert
    for (const buckets of [absent, euro]) {
      assert.equal(buckets.length, 1);
      assert.equal(buckets[0].id, 'extra-usage');
      assert.equal(buckets[0].unit, 'usd');
      assert.equal(buckets[0].used, 150);
      assert.equal(buckets[0].limit, 4000);
    }
  });

  it('keeps the older extra_usage used/limit shape as credits', () => {
    // Act
    const buckets = byId({ extra_usage: { used: 3, limit: 10 } });

    // Assert
    assert.equal(buckets['extra-usage'].unit, 'credits');
    assert.equal(buckets['extra-usage'].remaining, 7);
  });
});

// ---------------------------------------------------------------------------
// Local transcript spend (extractor, scanner dedupe, provider wiring)
// ---------------------------------------------------------------------------

const SPEND_MODEL = 'claude-sonnet-5';
// Large enough that every record costs whole cents (records carry exact cents),
// small enough to stay under any long-context threshold.
const BASE_INPUT = 20_000;
const BASE_CACHE_READ = 100_000;

function assistantLine(overrides: {
  id?: string;
  requestId?: string;
  model?: string;
  output?: number;
  usage?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    type: 'assistant',
    timestamp: new Date().toISOString(),
    requestId: overrides.requestId ?? 'req_1',
    message: {
      id: overrides.id ?? 'msg_1',
      model: overrides.model ?? SPEND_MODEL,
      usage: {
        input_tokens: BASE_INPUT,
        output_tokens: overrides.output ?? 1_000,
        cache_read_input_tokens: BASE_CACHE_READ,
        cache_creation_input_tokens: 0,
        ...overrides.usage,
      },
    },
  };
}

function writeLines(file: string, lines: unknown[], append = false): void {
  const body = lines.map(l => JSON.stringify(l)).join('\n') + '\n';
  if (append) fs.appendFileSync(file, body);
  else fs.writeFileSync(file, body);
}

function sumRecords(records: SpendRecord[]): { cents: number; output: number } {
  return records.reduce(
    (acc, r) => ({ cents: acc.cents + (r.costCents ?? 0), output: acc.output + r.outputTokens }),
    { cents: 0, output: 0 },
  );
}

describe('Claude Code spend: extractClaudeCodeSpendRecords', () => {
  it('prices 1-hour cache writes at the 1h rate (2x input), not the 5m rate', () => {
    // Arrange
    const line = assistantLine({
      output: 0,
      usage: {
        input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 1_000_000,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 },
      },
    });

    // Act
    const [record] = extractClaudeCodeSpendRecords(line);

    // Assert
    const input = costCentsExact(SPEND_MODEL, { inputTokens: 1_000_000, outputTokens: 0 }) ?? 0;
    assert.equal(record.costCents, costCentsExact(SPEND_MODEL, { inputTokens: 0, outputTokens: 0, cacheWrite1hTokens: 1_000_000 }));
    assert.equal(record.costCents, input * 2);
    assert.equal(record.cacheWriteTokens, 1_000_000);
  });

  it('treats a flat cache_creation_input_tokens without the split as 5-minute writes', () => {
    // Arrange
    const line = assistantLine({
      output: 0,
      usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 1_000_000 },
    });

    // Act
    const [record] = extractClaudeCodeSpendRecords(line);

    // Assert
    assert.equal(record.costCents, costCentsExact(SPEND_MODEL, { inputTokens: 0, outputTokens: 0, cacheWrite5mTokens: 1_000_000 }));
  });

  it('applies the fast-mode surcharge when usage.speed is "fast"', () => {
    // Arrange: fast mode is priced only on models that offer it (Opus 5.5)
    const model = 'claude-opus-5-5';

    // Act
    const [std] = extractClaudeCodeSpendRecords(assistantLine({ model, usage: { speed: 'standard' } }));
    const [fst] = extractClaudeCodeSpendRecords(assistantLine({ model, usage: { speed: 'fast' } }));

    // Assert
    assert.equal(
      fst.costCents,
      costCentsExact(model, { inputTokens: BASE_INPUT, outputTokens: 1_000, cacheReadTokens: BASE_CACHE_READ, fastTier: true }),
    );
    assert.ok((fst.costCents ?? 0) > (std.costCents ?? 0));
  });

  it('prices each advisor iteration with its own model as a separate record', () => {
    // Arrange
    const line = assistantLine({
      usage: {
        iterations: [
          { type: 'message', input_tokens: 10, output_tokens: 100 },
          {
            type: 'advisor_message',
            model: 'claude-fable-5-1',
            input_tokens: 50_000,
            output_tokens: 2_000,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        ],
      },
    });

    // Act
    const records = extractClaudeCodeSpendRecords(line);

    // Assert
    assert.equal(records.length, 2);
    const advisor = records[1];
    assert.equal(advisor.model, 'claude-fable-5-1');
    assert.equal(advisor.inputTokens, 50_000);
    assert.equal(advisor.costCents, costCentsExact('claude-fable-5-1', { inputTokens: 50_000, outputTokens: 2_000 }));
    assert.notEqual(advisor.dedupeKey, records[0].dedupeKey);
  });
});

describe('Claude Code spend: duplicate content-block lines', () => {
  it('counts one message once, keeping the largest output, across two incremental reads', async () => {
    // Arrange
    const dir = makeTempDir();
    try {
      const file = path.join(dir, 'session.jsonl');
      const scanner = JsonlSpendScanner.shared(path.join(dir, 'cache'));
      const opts = {
        key: 'claude-code',
        patterns: [path.join(dir, '*.jsonl').replace(/\\/g, '/')],
        extract: (l: unknown) => extractClaudeCodeSpendRecords(l),
      };
      const one = (out: number): number =>
        costCentsExact(SPEND_MODEL, { inputTokens: BASE_INPUT, outputTokens: out, cacheReadTokens: BASE_CACHE_READ }) ?? 0;
      writeLines(file, [assistantLine({ output: 1_000 }), assistantLine({ output: 5_000 })]);

      // Act
      const first = sumRecords(await scanner.scan(opts));
      writeLines(
        file,
        [assistantLine({ output: 10_000 }), assistantLine({ id: 'msg_2', requestId: 'req_2', output: 700 })],
        true,
      );
      const second = sumRecords(await scanner.scan(opts));

      // Assert
      assert.equal(first.output, 5_000);
      assert.equal(first.cents, one(5_000));
      assert.equal(second.output, 10_700);
      assert.equal(second.cents, one(10_000) + one(700));
      assert.ok(one(700) > 0);
    } finally {
      removeTempDir(dir);
    }
  });
});

describe('Claude Code spend: dedupe across a cache reload', () => {
  it('counts a request once when a later duplicate line arrives after a new scanner loaded the cache', async () => {
    // Arrange
    const dir = makeTempDir();
    try {
      const file = path.join(dir, 'session.jsonl');
      const cacheDir = path.join(dir, 'cache');
      const opts = {
        key: 'claude-code',
        patterns: [path.join(dir, '*.jsonl').replace(/\\/g, '/')],
        extract: (l: unknown) => extractClaudeCodeSpendRecords(l),
      };
      const one = (out: number): number =>
        costCentsExact(SPEND_MODEL, { inputTokens: BASE_INPUT, outputTokens: out, cacheReadTokens: BASE_CACHE_READ }) ?? 0;
      writeLines(file, [assistantLine({ output: 1_000 })]);
      const first = sumRecords(await JsonlSpendScanner.shared(cacheDir).scan(opts));
      JsonlSpendScanner.shared(cacheDir).flushSync();

      // Act: a fresh instance must load the persisted cache, not share memory
      const reloaded = new (JsonlSpendScanner as any)(cacheDir) as JsonlSpendScanner;
      writeLines(file, [assistantLine({ output: 5_000 })], true);
      const second = sumRecords(await reloaded.scan(opts));

      // Assert
      assert.equal(first.output, 1_000);
      assert.equal(second.output, 5_000);
      assert.equal(second.cents, one(5_000));
    } finally {
      removeTempDir(dir);
    }
  });
});

describe('Claude Code spend: provider wiring', () => {
  it('attaches local spend even when the claude.ai usage fetch needs a login', async () => {
    // Arrange
    const dir = makeTempDir();
    try {
      writeLines(path.join(dir, 'session.jsonl'), [assistantLine({ output: 100 })]);
      const ctx = createFakeContext({ cacheDir: path.join(dir, 'cache') });
      const provider = createClaudeCodeQuotaProvider(
        { paths: [path.join(dir, '*.jsonl').replace(/\\/g, '/')] },
        ctx,
        { fetchUsage: async () => ({ kind: 'needs-login' }) },
      );

      // Act
      const snapshot = await provider.fetch();

      // Assert
      assert.equal(snapshot.ok, false);
      assert.ok(!snapshot.ok && snapshot.needsLogin);
      const today = snapshot.spend?.find(t => t.period === 'today');
      assert.ok(today && (today.costCents ?? 0) > 0);
    } finally {
      removeTempDir(dir);
    }
  });
});

describe('Claude Code spend: sub-cent records', () => {
  it('sums fractional cents across many small records and rounds once per tile', () => {
    // Arrange - 200 records of ~0.25 cents each (a whole-cent round per record would give 0 or 200).
    const line = assistantLine({ output: 0, usage: { input_tokens: 500, cache_read_input_tokens: 0 } });
    const one = extractClaudeCodeSpendRecords(line)[0];
    assert.ok(one.costCents != null && one.costCents > 0 && one.costCents < 1);
    const records: SpendRecord[] = Array.from({ length: 200 }, () => ({ ...one, ts: Date.now() }));
    const dir = makeTempDir('aioversight-subcent-');
    try {
      // Act
      const tiles = JsonlSpendScanner.shared(dir).aggregate(records, Date.now());

      // Assert
      const today = tiles.find(t => t.period === 'today');
      assert.equal(today?.costCents, Math.round(one.costCents! * 200));
      assert.ok(Number.isInteger(today?.costCents));
    } finally {
      removeTempDir(dir);
    }
  });
});
