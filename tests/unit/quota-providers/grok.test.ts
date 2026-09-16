import './../../helpers/electron-stub';
import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { makeTempDir, removeTempDir } from '../../helpers/temp-dir';
import { createFakeContext } from '../../helpers/fake-context';
import {
  extractAccessToken,
  costTicksToCents,
  extractGrokSpend,
  parseBillingJson,
  parsePlanTier,
  createGrokQuotaProvider,
} from '../../../src/main/connectors/grok/quota';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The real auth.json: top-level keys are issuer strings. */
function issuerKeyedAuth(): Record<string, unknown> {
  return {
    'https://auth.x.ai::client-abc': {
      key: 'access-token-xyz',
      refresh_token: 'rotating-refresh',
      expires_at: 1_800_000_000,
      auth_mode: 'oauth',
      email: 'user@example.com',
      team_id: 'team-1',
      user_id: 'user-1',
      principal_type: 'user',
    },
  };
}

describe('Grok auth.json parsing', () => {
  it('reads the access token from an issuer-keyed entry', () => {
    // Arrange — the old parser probed flat access_token/token/api_key keys
    // that this file does not have.
    const parsed = extractAccessToken(issuerKeyedAuth());

    // Assert
    assert.equal(parsed.accessToken, 'access-token-xyz');
    assert.equal(parsed.email, 'user@example.com');
  });

  it('still accepts the old flat shape as a fallback', () => {
    // Assert
    assert.equal(extractAccessToken({ access_token: 'flat-token' }).accessToken, 'flat-token');
    assert.equal(extractAccessToken({ api_key: 'flat-key' }).accessToken, 'flat-key');
  });

  it('ignores top-level keys that are not xAI issuers', () => {
    // Assert
    assert.equal(extractAccessToken({ 'https://evil.example::x': { key: 'nope' } }).accessToken, undefined);
    assert.equal(extractAccessToken(null).accessToken, undefined);
  });
});

describe('Grok spend extraction', () => {
  it('converts costUsdTicks to cents (ten-billionths of a dollar)', () => {
    // Assert — 1e10 ticks is $1.00 is 100 cents.
    assert.equal(costTicksToCents(1e10), 100);
    assert.equal(costTicksToCents(2.5e9), 25);
  });

  it('prefers the vendor-reported cost over the shared price table', () => {
    // Arrange — costUsdTicks is exact, so the estimator must not run.
    const record = extractGrokSpend({
      sessionUpdate: 'turn_completed',
      timestamp: 1_800_000_000_000,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        cachedReadTokens: 200,
        reasoningTokens: 50,
        costUsdTicks: 1.23e10,
        modelUsage: { 'grok-4': { inputTokens: 1000 } },
      },
    })!;

    // Assert
    assert.equal(record.costCents, 123);
    assert.equal(record.inputTokens, 1000);
    assert.equal(record.cacheReadTokens, 200);
  });

  it('falls back to the price table via the modelUsage key when ticks are absent', () => {
    // Act
    const record = extractGrokSpend({
      sessionUpdate: 'turn_completed',
      timestamp: 1_800_000_000_000,
      usage: { inputTokens: 1000, outputTokens: 500, modelUsage: { 'grok-4': {} } },
    })!;

    // Assert
    assert.equal(record.model, 'grok-4');
    assert.notEqual(record.costCents, null);
  });

  it('skips rows that are not turn_completed', () => {
    // Assert
    assert.equal(
      extractGrokSpend({
        sessionUpdate: 'agent_message_chunk',
        timestamp: 1_800_000_000_000,
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
      null,
    );
  });

  it('drops a row with no parseable timestamp rather than dating it to now', () => {
    // Assert
    assert.equal(
      extractGrokSpend({ sessionUpdate: 'turn_completed', usage: { inputTokens: 10, outputTokens: 5 } }),
      null,
    );
  });
});

describe('Grok billing parsing', () => {
  it('reads config.creditUsagePercent and the current period end', () => {
    // Act
    const parsed = parseBillingJson({
      config: {
        creditUsagePercent: 42,
        currentPeriod: { end: 1_800_000_000_000 },
      },
    });

    // Assert
    assert.equal(parsed.weekly!.usedPercent, 42);
    assert.equal(parsed.weekly!.resetsAt, 1_800_000_000_000);
  });

  it('falls back to onDemandUsed over onDemandCap', () => {
    // Act
    const parsed = parseBillingJson({
      config: { onDemandUsed: { val: 25 }, onDemandCap: { val: 100 }, billingPeriodEnd: 1_800_000_000_000 },
    });

    // Assert
    assert.equal(parsed.weekly!.usedPercent, 25);
  });

  it('reads the plan name from subscription_tier_display', () => {
    // Assert
    assert.equal(parsePlanTier({ subscription_tier_display: 'SuperGrok Heavy' }), 'SuperGrok Heavy');
  });
});

describe('Grok quota provider', () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;
  let originalGrokHome: string | undefined;

  beforeEach(() => {
    dir = makeTempDir('aioversight-grok-quota-');
    originalGrokHome = process.env.GROK_HOME;
    process.env.GROK_HOME = dir;
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = originalGrokHome;
    removeTempDir(dir);
  });

  it('sends the required x-xai-token-auth header on the billing call', async () => {
    // Arrange — its absence is the likely cause of the reported 401/403s.
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(issuerKeyedAuth()));
    const sentHeaders: Array<Record<string, string>> = [];
    globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
      sentHeaders.push((init?.headers ?? {}) as Record<string, string>);
      return jsonResponse(200, { config: { creditUsagePercent: 10 } });
    }) as typeof globalThis.fetch;

    // Act
    const snapshot = await createGrokQuotaProvider({}, createFakeContext({ cacheDir: dir })).fetch();

    // Assert
    assert.equal(snapshot.ok, true);
    assert.equal(sentHeaders[0]['x-xai-token-auth'], 'xai-grok-cli');
    assert.equal(sentHeaders[0].Authorization, 'Bearer access-token-xyz');
  });

  it('never refreshes the token or rewrites auth.json on a 401', async () => {
    // Arrange — refresh tokens rotate and the CLI rewrites this file without
    // locking, so a second writer can invalidate the user's session.
    const authPath = path.join(dir, 'auth.json');
    const original = JSON.stringify(issuerKeyedAuth());
    fs.writeFileSync(authPath, original);

    const requested: string[] = [];
    globalThis.fetch = (async (input: string | URL) => {
      requested.push(String(input));
      return jsonResponse(401, { error: 'unauthorized' });
    }) as typeof globalThis.fetch;

    // Act
    const snapshot = await createGrokQuotaProvider({}, createFakeContext({ cacheDir: dir })).fetch();

    // Assert
    assert.equal(snapshot.ok, false);
    if (!snapshot.ok) {
      assert.equal(snapshot.needsLogin, true);
      assert.match(snapshot.error, /grok login/);
    }
    assert.equal(requested.filter(u => u.includes('auth.x.ai')).length, 0);
    assert.equal(fs.readFileSync(authPath, 'utf8'), original);
  });

  it('finds spend in a nested session transcript directory', async () => {
    // Arrange — transcripts live at sessions/<encoded-cwd>/<session-id>/
    // updates.jsonl. The shared scanner only descends when the pattern uses
    // `**`, so a `*/*` pattern would silently match nothing here.
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(issuerKeyedAuth()));
    const sessionDir = path.join(dir, 'sessions', 'encoded-cwd', 'session-1');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'updates.jsonl'),
      `${JSON.stringify({
        sessionUpdate: 'turn_completed',
        timestamp: Date.now(),
        usage: { inputTokens: 100, outputTokens: 50, costUsdTicks: 5e9 },
      })}\n`,
    );

    globalThis.fetch = (async () =>
      jsonResponse(200, { config: { creditUsagePercent: 10 } })) as typeof globalThis.fetch;

    // Act — a cache dir of its own so no earlier scan's rollup is reused.
    const cacheDir = path.join(dir, 'cache');
    const snapshot = await createGrokQuotaProvider({}, createFakeContext({ cacheDir })).fetch();

    // Assert
    assert.equal(snapshot.ok, true);
    if (snapshot.ok) {
      const today = snapshot.spend!.find(t => t.period === 'today')!;
      assert.equal(today.costCents, 50);
    }
  });

  it('explains that an unmigrated account may simply have no meter', async () => {
    // Arrange
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(issuerKeyedAuth()));
    globalThis.fetch = (async () => jsonResponse(200, { config: {} })) as typeof globalThis.fetch;

    // Act
    const snapshot = await createGrokQuotaProvider({}, createFakeContext({ cacheDir: dir })).fetch();

    // Assert
    assert.equal(snapshot.ok, false);
    if (!snapshot.ok) assert.match(snapshot.error, /weekly billing/);
  });
});
