import './../../helpers/electron-stub';
import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { makeTempDir, removeTempDir } from '../../helpers/temp-dir';
import { createFakeContext } from '../../helpers/fake-context';
import {
  parseCurrentPeriodUsage,
  parseUsageSummary,
  isHtmlBody,
  decodeStateValue,
  jwtSubject,
  dollarsToCents,
  createCursorQuotaProvider,
} from '../../../src/main/connectors/cursor/quota';

/**
 * The `GetCurrentPeriodUsage` body as reported by current community tools.
 * Every money figure is in CENTS; the billing-cycle bounds are epoch
 * milliseconds delivered as strings.
 */
function currentPeriodUsageResponse(): Record<string, unknown> {
  return {
    planUsage: { totalSpend: 1234, limit: 2000, remaining: 766 },
    totalPercentUsed: 61.7,
    autoPercentUsed: 40,
    apiPercentUsed: 5,
    billingCycleStart: '1800000000000',
    billingCycleEnd: '1802592000000',
  };
}

describe('Cursor GetCurrentPeriodUsage parsing', () => {
  it('treats planUsage amounts as cents, without a dollars conversion', () => {
    // Arrange — passing these through dollarsToCents would be a 100x error.
    const parsed = parseCurrentPeriodUsage(currentPeriodUsageResponse());

    // Assert
    const plan = parsed.buckets.find(b => b.id === 'plan-usage')!;
    assert.equal(plan.used, 1234);
    assert.equal(plan.limit, 2000);
    assert.equal(plan.remaining, 766);
    assert.equal(plan.unit, 'usd');
    assert.notEqual(plan.used, dollarsToCents(1234));
  });

  it('parses the string epoch-millisecond billing cycle bounds', () => {
    // Act
    const parsed = parseCurrentPeriodUsage(currentPeriodUsageResponse());

    // Assert
    assert.equal(parsed.billingCycleStart, new Date(1_800_000_000_000).toISOString());
    assert.equal(parsed.billingCycleEnd, new Date(1_802_592_000_000).toISOString());
  });

  it('exposes the auto and API percentages as on-demand buckets', () => {
    // Act
    const byId = Object.fromEntries(parseCurrentPeriodUsage(currentPeriodUsageResponse()).buckets.map(b => [b.id, b]));

    // Assert
    assert.equal(byId['auto-percent'].used, 40);
    assert.equal(byId['auto-percent'].defaultVisibility, 'onDemand');
    assert.equal(byId['api-percent'].used, 5);
  });

  it('does not restate the dollar meter as a second total-percent row', () => {
    // Act
    const parsed = parseCurrentPeriodUsage(currentPeriodUsageResponse());

    // Assert
    assert.equal(parsed.buckets.some(b => b.id === 'total-percent'), false);
  });

  it('falls back to a total-percent bucket when no dollar figure is present', () => {
    // Act
    const parsed = parseCurrentPeriodUsage({ totalPercentUsed: 33 });

    // Assert
    assert.equal(parsed.buckets.find(b => b.id === 'total-percent')!.used, 33);
  });

  it('reads an optional spendLimitUsage object', () => {
    // Act
    const parsed = parseCurrentPeriodUsage({ spendLimitUsage: { totalSpend: 500, limit: 5000 } });

    // Assert
    const bucket = parsed.buckets.find(b => b.id === 'spend-limit')!;
    assert.equal(bucket.used, 500);
    assert.equal(bucket.remaining, 4500);
  });

  it('returns no buckets for an unrecognised body rather than fabricating zeros', () => {
    // Assert
    assert.deepEqual(parseCurrentPeriodUsage({}).buckets, []);
  });
});

describe('Cursor usage-summary counter parsing', () => {
  it('leaves a counter that reports no "used" figure unmeasured', () => {
    // Arrange — `Number(undefined ?? 0)` is 0, which contradicts this
    // file's own policy: an absent figure is unknown, not a measured zero.
    const parsed = parseUsageSummary({
      membershipType: 'pro',
      individualUsage: { overall: { enabled: true, limit: 500 } },
    });

    // Assert
    const bucket = parsed.buckets.find(b => b.id === 'individual-overall')!;
    assert.equal(bucket.used, null);
    assert.equal(bucket.limit, 500);
    assert.equal(bucket.remaining, null);
  });
});

describe('Cursor WAF HTML detection', () => {
  it('recognises an HTML challenge page by body and by content type', () => {
    // Assert
    assert.equal(isHtmlBody('<!DOCTYPE html><html><body>blocked</body></html>'), true);
    assert.equal(isHtmlBody('{"ok":true}', 'text/html; charset=utf-8'), true);
  });

  it('does not mistake a JSON body for a block page', () => {
    // Assert
    assert.equal(isHtmlBody('{"membershipType":"pro"}', 'application/json'), false);
    assert.equal(isHtmlBody(''), false);
  });
});

describe('Cursor state DB value decoding', () => {
  it('decodes a UTF-16LE blob rather than stringifying the byte array', () => {
    // Arrange — String(Uint8Array) would yield "101,0,121,0,…".
    const bytes = new Uint8Array(Buffer.from('eyJzdWIiOiJ1c2VyXzEifQ', 'utf16le'));

    // Act
    const decoded = decodeStateValue(bytes);

    // Assert
    assert.equal(decoded, 'eyJzdWIiOiJ1c2VyXzEifQ');
  });

  it('decodes a UTF-8 blob and passes a plain string through', () => {
    // Assert
    assert.equal(decodeStateValue(new Uint8Array(Buffer.from('plain-token', 'utf8'))), 'plain-token');
    assert.equal(decodeStateValue('already-a-string'), 'already-a-string');
    assert.equal(decodeStateValue(null), null);
  });

  it('reads the sub claim so the session cookie can be rebuilt', () => {
    // Arrange — cookie form is `{userId}::{jwt}`, userId being the sub claim.
    const payload = Buffer.from(JSON.stringify({ sub: 'user_abc' }), 'utf8').toString('base64');
    const jwt = `header.${payload}.signature`;

    // Assert
    assert.equal(jwtSubject(jwt), 'user_abc');
    assert.equal(jwtSubject('not-a-jwt'), null);
  });
});

describe('Cursor quota provider', () => {
  let dir: string;
  let stateDbPath: string;
  let originalFetch: typeof globalThis.fetch;

  /** A minimal VS Code-style `state.vscdb` holding the access token. */
  async function writeStateDb(token: string): Promise<void> {
    // Same shape-tolerant import the connectors use: sql.js ships both a
    // callable module and a `default` export depending on the build.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqlJsModule = require('sql.js') as
      & { default?: typeof import('sql.js') }
      & typeof import('sql.js');
    const initSqlJs = (typeof sqlJsModule === 'function' ? sqlJsModule : sqlJsModule.default)!;
    const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });

    // `src/main/sql.js.d.ts` declares only the read surface the connectors
    // use (`exec`/`close`); writing a fixture DB needs `run` and `export`.
    const db = new SQL.Database() as unknown as {
      run: (sql: string, params?: unknown[]) => void;
      export: () => Uint8Array;
      close: () => void;
    };
    db.run('CREATE TABLE ItemTable (key TEXT, value TEXT)');
    db.run('INSERT INTO ItemTable VALUES (?, ?)', ['cursorAuth/accessToken', token]);
    fs.writeFileSync(stateDbPath, Buffer.from(db.export()));
    db.close();
  }

  function makeJwt(sub: string): string {
    const payload = Buffer.from(JSON.stringify({ sub }), 'utf8').toString('base64');
    return `header.${payload}.signature`;
  }

  beforeEach(() => {
    dir = makeTempDir('aioversight-cursor-quota-');
    stateDbPath = path.join(dir, 'state.vscdb');
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    removeTempDir(dir);
  });

  it('calls GetCurrentPeriodUsage first, not the vanished usage-summary endpoint', async () => {
    // Arrange
    await writeStateDb(makeJwt('user_abc'));
    const requested: Array<{ url: string; method: string }> = [];
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      requested.push({ url: String(input), method: init?.method ?? 'GET' });
      return new Response(JSON.stringify(currentPeriodUsageResponse()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    const provider = createCursorQuotaProvider({ stateDbPath }, createFakeContext({ cacheDir: dir }));

    // Act
    const snapshot = await provider.fetch();

    // Assert
    assert.equal(snapshot.ok, true);
    assert.equal(requested[0].url, 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage');
    assert.equal(requested[0].method, 'POST');
    assert.equal(requested.some(r => r.url.includes('/auth/usage-summary')), false);
    if (snapshot.ok) {
      assert.equal(snapshot.buckets.find(b => b.id === 'plan-usage')!.used, 1234);
    }
  });

  it('reports a WAF HTML block as transient, not as a rejected session', async () => {
    // Arrange — the edge firewall answers HTML under a 403.
    await writeStateDb(makeJwt('user_abc'));
    globalThis.fetch = (async () =>
      new Response('<!DOCTYPE html><html><head></head><body>Attention Required</body></html>', {
        status: 403,
        headers: { 'content-type': 'text/html' },
      })) as typeof globalThis.fetch;

    const provider = createCursorQuotaProvider({ stateDbPath }, createFakeContext({ cacheDir: dir }));

    // Act
    const snapshot = await provider.fetch();

    // Assert
    assert.equal(snapshot.ok, false);
    if (!snapshot.ok) {
      assert.match(snapshot.error, /temporary/);
      assert.equal(snapshot.needsLogin, undefined);
    }
  });

  it('tells the user how to sign in when Cursor rejects the session', async () => {
    // Arrange — Cursor declares no login handler, so the instruction has to
    // be in the message itself.
    await writeStateDb(makeJwt('user_abc'));
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })) as typeof globalThis.fetch;

    const provider = createCursorQuotaProvider({ stateDbPath }, createFakeContext({ cacheDir: dir }));

    // Act
    const snapshot = await provider.fetch();

    // Assert
    assert.equal(snapshot.ok, false);
    if (!snapshot.ok) {
      assert.equal(snapshot.needsLogin, true);
      assert.match(snapshot.error, /Sign in to Cursor again/);
    }
  });
});
