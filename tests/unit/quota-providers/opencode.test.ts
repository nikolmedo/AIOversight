import './../../helpers/electron-stub';
import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { makeTempDir, removeTempDir } from '../../helpers/temp-dir';
import { createFakeContext } from '../../helpers/fake-context';
import { findConnector } from '../../../src/main/connectors/registry';
import {
  buildZenBuckets,
  extractZenApiKey,
  createOpencodeQuotaProvider,
} from '../../../src/main/connectors/opencode/quota';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The live shape of `GET /zen/go/v1/usage`. No dollar amounts are exposed. */
function zenUsageResponse(): Record<string, unknown> {
  return {
    usage: {
      rolling: { status: 'ok', percent: 12, resetsAt: '2026-09-16T18:00:00Z' },
      weekly: { status: 'ok', percent: 44, resetsAt: 1_800_000_000_000 },
      monthly: { status: 'ok', percent: 61, resetsAt: '2026-10-01T00:00:00Z' },
    },
  };
}

describe('OpenCode Zen usage parsing', () => {
  it('builds percent buckets for the rolling, weekly and monthly windows', () => {
    // Act
    const buckets = buildZenBuckets(zenUsageResponse());

    // Assert
    const byId = Object.fromEntries(buckets.map(b => [b.id, b]));
    assert.equal(buckets.length, 3);
    assert.equal(byId.rolling.used, 12);
    assert.equal(byId.weekly.used, 44);
    assert.equal(byId.monthly.used, 61);
    assert.equal(byId.weekly.remaining, 56);
  });

  it('exposes no dollar amounts, because the API reports none', () => {
    // Assert — the invented $12/$30/$60 budgets are gone.
    const buckets = buildZenBuckets(zenUsageResponse());
    assert.equal(buckets.every(b => b.unit === 'percent'), true);
    assert.equal(buckets.some(b => b.limit === 1200 || b.limit === 3000 || b.limit === 6000), false);
  });

  it('parses resetsAt as either an ISO string or an epoch number', () => {
    // Act
    const byId = Object.fromEntries(buildZenBuckets(zenUsageResponse()).map(b => [b.id, b]));

    // Assert
    assert.equal(byId.rolling.resetsAt, Date.parse('2026-09-16T18:00:00Z'));
    assert.equal(byId.weekly.resetsAt, 1_800_000_000_000);
  });

  it('omits a window with no numeric percent rather than showing zero', () => {
    // Act
    const buckets = buildZenBuckets({ usage: { rolling: { status: 'ok' }, weekly: { percent: 5 } } });

    // Assert
    assert.deepEqual(buckets.map(b => b.id), ['weekly']);
  });

  it('returns nothing for an unrecognised body', () => {
    // Assert
    assert.deepEqual(buildZenBuckets({}), []);
    assert.deepEqual(buildZenBuckets(null), []);
  });
});

describe('OpenCode Zen key resolution', () => {
  it('reads the key from either candidate provider id', () => {
    // Arrange — which id holds the Go key is unconfirmed, so both are probed.
    assert.equal(extractZenApiKey({ opencode: { type: 'api', key: 'k1' } }), 'k1');
    assert.equal(extractZenApiKey({ 'opencode-go': { type: 'api', key: 'k2' } }), 'k2');
  });

  it('returns null for an unrelated auth.json', () => {
    // Assert
    assert.equal(extractZenApiKey({ anthropic: { key: 'nope' } }), null);
    assert.equal(extractZenApiKey(null), null);
  });
});

describe('OpenCode connector definition', () => {
  it('declares a secret field so a user can paste the Zen key', () => {
    // Act
    const def = findConnector('opencode')!;

    // Assert
    const secret = def.configSchema.find(f => f.type === 'secret');
    assert.ok(secret);
    assert.equal(secret.key, 'apiKey');
    assert.equal(secret.section, 'quota');
    assert.equal(secret.requiresEnabled, 'quota');
  });
});

describe('OpenCode quota provider', () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;
  let originalEnvKey: string | undefined;

  beforeEach(() => {
    dir = makeTempDir('aioversight-opencode-quota-');
    originalEnvKey = process.env.OPENCODE_API_KEY;
    delete process.env.OPENCODE_API_KEY;
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEnvKey === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = originalEnvKey;
    removeTempDir(dir);
  });

  it('sends the Zen key as a bearer token and reports its windows', async () => {
    // Arrange
    fs.mkdirSync(dir, { recursive: true });
    const sentHeaders: Array<Record<string, string>> = [];
    globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
      sentHeaders.push((init?.headers ?? {}) as Record<string, string>);
      return jsonResponse(200, zenUsageResponse());
    }) as typeof globalThis.fetch;

    const ctx = createFakeContext({ secrets: { apiKey: 'zen-key' }, cacheDir: dir });
    const provider = createOpencodeQuotaProvider({ dataDirs: [dir] }, ctx);

    // Act
    const snapshot = await provider.fetch();

    // Assert
    assert.equal(snapshot.ok, true);
    if (snapshot.ok) assert.equal(snapshot.buckets.length, 3);
    assert.equal(sentHeaders[0].Authorization, 'Bearer zen-key');
  });

  it('fails honestly when there is neither a key nor a readable database', async () => {
    // Arrange — no fabricated $0 reading.
    const emptyDir = path.join(dir, 'empty');
    fs.mkdirSync(emptyDir, { recursive: true });
    const ctx = createFakeContext({ cacheDir: dir });

    // Act
    const snapshot = await createOpencodeQuotaProvider({ dataDirs: [emptyDir] }, ctx).fetch();

    // Assert
    assert.equal(snapshot.ok, false);
    if (!snapshot.ok) assert.match(snapshot.error, /No OpenCode Zen API key/);
  });

  it('sends the user back to the key field when Zen rejects it', async () => {
    // Arrange
    fs.mkdirSync(dir, { recursive: true });
    globalThis.fetch = (async () => jsonResponse(401, { error: 'unauthorized' })) as typeof globalThis.fetch;
    const ctx = createFakeContext({ secrets: { apiKey: 'stale' }, cacheDir: dir });

    // Act
    const snapshot = await createOpencodeQuotaProvider({ dataDirs: [dir] }, ctx).fetch();

    // Assert
    assert.equal(snapshot.ok, false);
    if (!snapshot.ok) {
      assert.equal(snapshot.needsLogin, true);
      assert.match(snapshot.error, /OpenCode Quota section/);
    }
  });
});
