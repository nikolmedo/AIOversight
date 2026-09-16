import './../../helpers/electron-stub';
import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { createFakeContext } from '../../helpers/fake-context';
import { parseLimits, limitBuckets, createZaiQuotaProvider } from '../../../src/main/connectors/zai/quota';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * The `quota/limit` body as reported by two independent community quota
 * tools. `usage` is the CAP and `currentValue` the amount consumed.
 */
function quotaLimitResponse(): Record<string, unknown> {
  return {
    code: 200,
    msg: 'success',
    success: true,
    data: {
      level: 'pro',
      limits: [
        {
          type: 'TOKENS_LIMIT',
          unit: 3,
          number: 1,
          usage: 2000,
          currentValue: 402,
          remaining: 1598,
          percentage: 20,
          nextResetTime: 1_800_000_000_000,
        },
        {
          type: 'TOKENS_LIMIT',
          unit: 6,
          number: 1,
          usage: 50_000,
          currentValue: 12_500,
          remaining: 37_500,
          percentage: 25,
          nextResetTime: 1_800_500_000_000,
        },
        { type: 'TIME_LIMIT', unit: 3, number: 1, usage: 30, currentValue: 12 },
      ],
    },
  };
}

describe('Z.ai quota/limit parsing', () => {
  it('reads currentValue as consumed and usage as the cap (402 of 2000 = 20% used)', () => {
    // Arrange — the inverted reading reported this account as 402/402 spent.
    const parsed = parseLimits(quotaLimitResponse());

    // Assert
    const session = parsed.limits!.find(l => l.window === 'session')!;
    assert.equal(session.usedPercent, 20);
    assert.notEqual(session.usedPercent, 100);
  });

  it('derives the percentage from currentValue/usage when the server omits it', () => {
    // Arrange
    const body = {
      data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, usage: 2000, currentValue: 402 }] },
    };

    // Act
    const parsed = parseLimits(body);

    // Assert
    assert.equal(Math.round(parsed.limits![0].usedPercent), 20);
  });

  it('classifies on the numeric unit code: 3 is the 5h window, 6 is weekly', () => {
    // Act
    const parsed = parseLimits(quotaLimitResponse());

    // Assert
    const byWindow = Object.fromEntries(parsed.limits!.map(l => [l.window, l]));
    assert.equal(byWindow.session.windowMs, 18_000_000);
    assert.equal(byWindow.weekly.windowMs, 604_800_000);
    assert.equal(byWindow.weekly.usedPercent, 25);
  });

  it('skips TIME_LIMIT entries, which describe subscription validity rather than usage', () => {
    // Act
    const parsed = parseLimits(quotaLimitResponse());

    // Assert
    assert.equal(parsed.limits!.length, 2);
  });

  it('handles CREDIT_LIMIT, which lite accounts switched to in 2026', () => {
    // Arrange — tools that filtered only on TOKENS_LIMIT went blank here.
    const body = {
      data: {
        level: 'lite',
        limits: [{ type: 'CREDIT_LIMIT', unit: 3, usage: 100, currentValue: 30, percentage: 30 }],
      },
    };

    // Act
    const parsed = parseLimits(body);

    // Assert
    assert.equal(parsed.limits!.length, 1);
    assert.equal(parsed.limits![0].usedPercent, 30);
  });

  it('treats nextResetTime as epoch milliseconds', () => {
    // Act
    const parsed = parseLimits(quotaLimitResponse());

    // Assert
    assert.equal(parsed.limits!.find(l => l.window === 'session')!.resetsAt, 1_800_000_000_000);
  });

  it('reports a missing limits array as null so the caller can fall back', () => {
    // Act
    const parsed = parseLimits({ data: { level: 'pro' } });

    // Assert
    assert.equal(parsed.limits, null);
    assert.equal(parsed.level, 'pro');
  });

  it('pairs a real resetsAt with the unit-derived window', () => {
    // Act
    const buckets = limitBuckets(parseLimits(quotaLimitResponse()).limits!);

    // Assert
    const byId = Object.fromEntries(buckets.map(b => [b.id, b]));
    assert.equal(byId.session.used, 20);
    assert.equal(byId.session.remaining, 80);
    assert.equal(byId.session.resetsAt, 1_800_000_000_000);
    assert.equal(byId.session.unit, 'percent');
  });
});

describe('Z.ai quota provider', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('takes the plan name from data.level without calling the subscription endpoint', async () => {
    // Arrange — `biz/subscription/list` has no source anywhere, so it was
    // dropped; `data.level` carries the same information.
    const requested: string[] = [];
    globalThis.fetch = (async (input: string | URL) => {
      requested.push(String(input));
      return jsonResponse(200, quotaLimitResponse());
    }) as typeof globalThis.fetch;

    const ctx = createFakeContext({ secrets: { apiKey: 'zai-key' } });
    const provider = createZaiQuotaProvider({}, ctx);

    // Act
    const snapshot = await provider.fetch();

    // Assert
    assert.equal(snapshot.ok, true);
    if (snapshot.ok) assert.equal(snapshot.membershipType, 'pro');
    assert.equal(requested.filter(u => u.includes('subscription')).length, 0);
    assert.equal(requested.length, 1);
  });

  it('retries a 401 once with the raw key before reporting the key as bad', async () => {
    // Arrange — the canonical auth form is unconfirmed: one tool sends
    // Bearer, another the raw key.
    const sentAuth: string[] = [];
    globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
      const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
      sentAuth.push(auth);
      if (auth.startsWith('Bearer ')) return jsonResponse(401, { msg: 'unauthorized' });
      return jsonResponse(200, quotaLimitResponse());
    }) as typeof globalThis.fetch;

    const ctx = createFakeContext({ secrets: { apiKey: 'zai-key' } });

    // Act
    const snapshot = await createZaiQuotaProvider({}, ctx).fetch();

    // Assert
    assert.equal(snapshot.ok, true);
    assert.deepEqual(sentAuth, ['Bearer zai-key', 'zai-key']);
  });

  it('reports both auth forms failing as one rejected-key error', async () => {
    // Arrange
    globalThis.fetch = (async () => jsonResponse(401, { msg: 'nope' })) as typeof globalThis.fetch;
    const ctx = createFakeContext({ secrets: { apiKey: 'zai-key' } });

    // Act
    const snapshot = await createZaiQuotaProvider({}, ctx).fetch();

    // Assert
    assert.equal(snapshot.ok, false);
    if (!snapshot.ok) assert.match(snapshot.error, /Bearer and raw-key/);
  });

  it('fails rather than showing an empty meter when every entry is a TIME_LIMIT', async () => {
    // Arrange
    globalThis.fetch = (async () =>
      jsonResponse(200, {
        data: { level: 'lite', limits: [{ type: 'TIME_LIMIT', unit: 3, usage: 30, currentValue: 1 }] },
      })) as typeof globalThis.fetch;
    const ctx = createFakeContext({ secrets: { apiKey: 'zai-key' } });

    // Act
    const snapshot = await createZaiQuotaProvider({}, ctx).fetch();

    // Assert
    assert.equal(snapshot.ok, false);
  });
});
