import './../../helpers/electron-stub';
import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { setUserDataPath, resetElectronStub } from '../../helpers/electron-stub';
import { makeTempDir, removeTempDir } from '../../helpers/temp-dir';
import { ConnectorRuntime } from '../../../src/main/connectors/runtime';
import { SecretStore } from '../../../src/main/connectors/secret-store';
import { findConnector } from '../../../src/main/connectors/registry';
import {
  openAiUsageCompletionsResponse,
  openAiCostsResponse,
  openAiErrorResponse,
} from '../../helpers/fixtures';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function rawResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain' },
  });
}

describe('OpenAIQuotaProvider', () => {
  let dir: string;
  let runtime: ConnectorRuntime;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = makeTempDir('aioversight-openai-quota-');
    setUserDataPath(dir);
    resetElectronStub();
    runtime = new ConnectorRuntime(new SecretStore());
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    removeTempDir(dir);
  });

  it('returns a "no admin key" error when no admin API key is configured', async () => {
    // Arrange
    const def = findConnector('openai')!;
    const ctx = runtime.contextFor(def);
    const provider = def.quota!.create({}, ctx);

    // Act
    const snapshot = await provider.fetch();

    // Assert
    assert.equal(snapshot.ok, false);
    if (!snapshot.ok) {
      assert.match(snapshot.error, /No OpenAI admin API key set/);
      assert.match(snapshot.error, /platform\.openai\.com\/settings\/organization\/admin-keys/);
      assert.equal(snapshot.needsLogin, undefined);
    }
  });

  it('returns a populated snapshot from the usage + costs endpoints', async () => {
    // Arrange
    const def = findConnector('openai')!;
    const ctx = runtime.contextFor(def);
    ctx.setSecret('adminApiKey', 'sk-admin-realistic-key');

    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/usage/completions')) {
        return jsonResponse(200, openAiUsageCompletionsResponse());
      }
      if (url.includes('/costs')) {
        return jsonResponse(200, openAiCostsResponse());
      }
      return jsonResponse(404, {});
    }) as typeof globalThis.fetch;

    const provider = def.quota!.create({}, ctx);

    // Act
    const snapshot = await provider.fetch();

    // Assert
    assert.equal(snapshot.ok, true);
    if (snapshot.ok) {
      assert.equal(snapshot.membershipType, 'openai-org');
      assert.equal(snapshot.authMethod, 'api-key');
      assert.equal(snapshot.source, 'https://api.openai.com/v1/organization/usage/completions');

      const byId = Object.fromEntries(snapshot.buckets.map(b => [b.id, b]));
      // 42 + 18 model requests across the two usage buckets.
      assert.equal(byId.requests.used, 60);
      // 50_000 + 30_000 input tokens.
      assert.equal(byId['input-tokens'].used, 80_000);
      // 12_000 + 8_000 output tokens.
      assert.equal(byId['output-tokens'].used, 20_000);
      // 5_000 + 2_000 cached input tokens.
      assert.equal(byId['cached-tokens'].used, 7_000);
      // (2.5 + 1.1) USD -> 360 cents.
      assert.equal(byId['spend-this-period'].used, 360);
      assert.equal(byId['spend-this-period'].unit, 'usd');

      // The cost bucket is unshifted to the front of the list.
      assert.equal(snapshot.buckets[0].id, 'spend-this-period');
    }
  });

  it('requests the usage and costs endpoints for the current month window with the admin key as a Bearer token', async () => {
    // Arrange
    const def = findConnector('openai')!;
    const ctx = runtime.contextFor(def);
    ctx.setSecret('adminApiKey', 'sk-admin-realistic-key');

    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value;
      });
      calls.push({ url, headers });
      if (url.includes('/usage/completions')) {
        return jsonResponse(200, openAiUsageCompletionsResponse());
      }
      if (url.includes('/costs')) {
        return jsonResponse(200, openAiCostsResponse());
      }
      return jsonResponse(404, {});
    }) as typeof globalThis.fetch;

    const provider = def.quota!.create({}, ctx);

    // Act
    const snapshot = await provider.fetch();

    // Assert
    assert.equal(snapshot.ok, true);
    assert.equal(calls.length, 2);

    const now = new Date();
    const expectedStart = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);
    const expectedEnd = Math.floor(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) / 1000,
    );

    const usageCall = calls.find(c => c.url.includes('/usage/completions'))!;
    const costsCall = calls.find(c => c.url.includes('/costs'))!;

    assert.match(usageCall.url, /^https:\/\/api\.openai\.com\/v1\/organization\/usage\/completions\?/);
    assert.match(usageCall.url, new RegExp(`start_time=${expectedStart}`));
    assert.match(usageCall.url, new RegExp(`end_time=${expectedEnd}`));
    assert.match(usageCall.url, /bucket_width=1d/);
    assert.match(usageCall.url, /group_by=model/);
    assert.equal(usageCall.headers.authorization, 'Bearer sk-admin-realistic-key');
    assert.equal(usageCall.headers.accept, 'application/json');

    assert.match(costsCall.url, /^https:\/\/api\.openai\.com\/v1\/organization\/costs\?/);
    assert.match(costsCall.url, new RegExp(`start_time=${expectedStart}`));
    assert.match(costsCall.url, new RegExp(`end_time=${expectedEnd}`));
    assert.match(costsCall.url, /bucket_width=1d/);
    assert.equal(costsCall.headers.authorization, 'Bearer sk-admin-realistic-key');
  });

  it('returns ok:false with the formatted API error message on a 401 invalid key response', async () => {
    // Arrange
    const def = findConnector('openai')!;
    const ctx = runtime.contextFor(def);
    ctx.setSecret('adminApiKey', 'sk-admin-revoked-key');

    globalThis.fetch = (async () =>
      jsonResponse(401, openAiErrorResponse('Incorrect API key provided'))) as typeof globalThis.fetch;

    const provider = def.quota!.create({}, ctx);

    // Act
    const snapshot = await provider.fetch();

    // Assert
    assert.equal(snapshot.ok, false);
    if (!snapshot.ok) {
      assert.match(snapshot.error, /Could not fetch OpenAI usage/);
      assert.match(snapshot.error, /Incorrect API key provided/);
    }
  });

  it('still returns ok:true when the usage endpoint succeeds but the costs endpoint fails', async () => {
    // Arrange
    const def = findConnector('openai')!;
    const ctx = runtime.contextFor(def);
    ctx.setSecret('adminApiKey', 'sk-admin-realistic-key');

    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/usage/completions')) {
        return jsonResponse(200, openAiUsageCompletionsResponse());
      }
      if (url.includes('/costs')) {
        return jsonResponse(500, openAiErrorResponse('Internal Server Error'));
      }
      return jsonResponse(404, {});
    }) as typeof globalThis.fetch;

    const provider = def.quota!.create({}, ctx);

    // Act
    const snapshot = await provider.fetch();

    // Assert
    assert.equal(snapshot.ok, true);
    if (snapshot.ok) {
      const byId = Object.fromEntries(snapshot.buckets.map(b => [b.id, b]));
      // Usage buckets are still present...
      assert.equal(byId.requests.used, 60);
      assert.equal(byId['input-tokens'].used, 80_000);
      // ...but the optional cost bucket is silently skipped.
      assert.equal('spend-this-period' in byId, false);
    }
  });

  it('returns ok:false (no throw) when the usage endpoint fails with a non-JSON body', async () => {
    // Arrange
    const def = findConnector('openai')!;
    const ctx = runtime.contextFor(def);
    ctx.setSecret('adminApiKey', 'sk-admin-realistic-key');

    globalThis.fetch = (async () => rawResponse(500, 'Internal Server Error')) as typeof globalThis.fetch;

    const provider = def.quota!.create({}, ctx);

    // Act
    const snapshot = await provider.fetch();

    // Assert
    assert.equal(snapshot.ok, false);
    if (!snapshot.ok) {
      assert.match(snapshot.error, /Could not fetch OpenAI usage/);
      // NOTE: httpsGetJson swallows the JSON.parse failure and returns `{}`,
      // so formatOpenAIError falls back to "HTTP <status>" rather than
      // surfacing the raw response body.
      assert.match(snapshot.error, /HTTP 500/);
    }
  });

  it('returns ok:true with empty buckets when the usage endpoint returns a 200 with a non-JSON body', async () => {
    // Arrange
    const def = findConnector('openai')!;
    const ctx = runtime.contextFor(def);
    ctx.setSecret('adminApiKey', 'sk-admin-realistic-key');

    globalThis.fetch = (async () => rawResponse(200, 'not json')) as typeof globalThis.fetch;

    const provider = def.quota!.create({}, ctx);

    // Act
    const snapshot = await provider.fetch();

    // Assert
    // NOTE: a 200 response with an unparsable body is treated by httpsGetJson
    // as `{ status: 200, json: {} }` (parse errors are swallowed), so
    // parseUsage sees no `data` array and the fetch succeeds with zero
    // buckets instead of surfacing an error.
    assert.equal(snapshot.ok, true);
    if (snapshot.ok) {
      assert.deepEqual(snapshot.buckets, []);
    }
  });
});
