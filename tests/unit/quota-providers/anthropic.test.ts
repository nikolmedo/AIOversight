import './../../helpers/electron-stub';
import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { setUserDataPath, resetElectronStub } from '../../helpers/electron-stub';
import { makeTempDir, removeTempDir } from '../../helpers/temp-dir';
import { ConnectorRuntime } from '../../../src/main/connectors/runtime';
import { SecretStore } from '../../../src/main/connectors/secret-store';
import { findConnector } from '../../../src/main/connectors/registry';
import {
  anthropicUsageReportResponse,
  anthropicCostReportResponse,
  anthropicErrorResponse,
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

describe('AnthropicQuotaProvider', () => {
  let dir: string;
  let runtime: ConnectorRuntime;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = makeTempDir('aioversight-anthropic-quota-');
    setUserDataPath(dir);
    resetElectronStub();
    runtime = new ConnectorRuntime(new SecretStore());
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    removeTempDir(dir);
  });

  it('returns a "no admin key" error when neither an admin key nor a claude.ai cookie is available', async () => {
    // Arrange
    const def = findConnector('anthropic')!;
    const ctx = runtime.contextFor(def);
    const provider = def.quota!.create({}, ctx);

    // Act
    const snapshot = await provider.fetch();

    // Assert
    assert.equal(snapshot.ok, false);
    if (!snapshot.ok) {
      assert.match(snapshot.error, /No Anthropic admin API key set/);
    }
  });

  it('returns a populated snapshot from the admin usage + cost reports', async () => {
    // Arrange
    const def = findConnector('anthropic')!;
    const ctx = runtime.contextFor(def);
    ctx.setSecret('adminApiKey', 'sk-ant-admin01-realistic-key');

    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/usage_report/messages')) {
        return jsonResponse(200, anthropicUsageReportResponse());
      }
      if (url.includes('/cost_report')) {
        return jsonResponse(200, anthropicCostReportResponse());
      }
      return jsonResponse(404, {});
    }) as typeof globalThis.fetch;

    const provider = def.quota!.create({}, ctx);

    // Act
    const snapshot = await provider.fetch();

    // Assert
    assert.equal(snapshot.ok, true);
    if (snapshot.ok) {
      assert.equal(snapshot.membershipType, 'anthropic-admin');
      assert.equal(snapshot.authMethod, 'api-key');

      const byId = Object.fromEntries(snapshot.buckets.map(b => [b.id, b]));
      // 12_000 + 8_000 from the two usage_report days.
      assert.equal(byId['input-tokens'].used, 20_000);
      // 4_500 + 3_000.
      assert.equal(byId['output-tokens'].used, 7_500);
      // 800 + 0.
      assert.equal(byId['cache-read-tokens'].used, 800);
      // 200 + 0.
      assert.equal(byId['cache-write-tokens'].used, 200);
      // (1.25 + 0.75) USD -> 200 cents.
      assert.equal(byId['spend-this-period'].used, 200);
      assert.equal(byId['spend-this-period'].unit, 'usd');
    }
  });

  it('falls back to a combined error message when the admin key is rejected and no cookie exists', async () => {
    // Arrange
    const def = findConnector('anthropic')!;
    const ctx = runtime.contextFor(def);
    ctx.setSecret('adminApiKey', 'sk-ant-admin01-revoked-key');

    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/usage_report/messages')) {
        return jsonResponse(401, anthropicErrorResponse('invalid x-api-key'));
      }
      return jsonResponse(404, {});
    }) as typeof globalThis.fetch;

    const provider = def.quota!.create({}, ctx);

    // Act
    const snapshot = await provider.fetch();

    // Assert
    assert.equal(snapshot.ok, false);
    if (!snapshot.ok) {
      assert.match(snapshot.error, /Could not fetch Anthropic usage/);
      assert.match(snapshot.error, /Admin key: Error: HTTP 401/);
    }
  });

  it('surfaces a combined error message when the usage report responds with 429 (rate limited)', async () => {
    // Arrange
    const def = findConnector('anthropic')!;
    const ctx = runtime.contextFor(def);
    ctx.setSecret('adminApiKey', 'sk-ant-admin01-realistic-key');

    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/usage_report/messages')) {
        return jsonResponse(429, anthropicErrorResponse('rate limit exceeded'));
      }
      return jsonResponse(404, {});
    }) as typeof globalThis.fetch;

    const provider = def.quota!.create({}, ctx);

    // Act
    const snapshot = await provider.fetch();

    // Assert
    assert.equal(snapshot.ok, false);
    if (!snapshot.ok) {
      assert.match(snapshot.error, /Could not fetch Anthropic usage/);
      // NOTE: AnthropicQuotaProvider's admin-key path doesn't read the
      // response body for errors -- it always raises a bare `HTTP <status>`,
      // discarding the API's error message (unlike the OpenAI provider).
      assert.match(snapshot.error, /Admin key: Error: HTTP 429/);
      assert.match(snapshot.error, /claude\.ai cookie: Error: No claude\.ai sessionKey cookie found/);
    }
  });

  it('surfaces a combined error message when the usage report responds with 500', async () => {
    // Arrange
    const def = findConnector('anthropic')!;
    const ctx = runtime.contextFor(def);
    ctx.setSecret('adminApiKey', 'sk-ant-admin01-realistic-key');

    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/usage_report/messages')) {
        return jsonResponse(500, anthropicErrorResponse('internal_server_error'));
      }
      return jsonResponse(404, {});
    }) as typeof globalThis.fetch;

    const provider = def.quota!.create({}, ctx);

    // Act
    const snapshot = await provider.fetch();

    // Assert
    assert.equal(snapshot.ok, false);
    if (!snapshot.ok) {
      assert.match(snapshot.error, /Could not fetch Anthropic usage/);
      assert.match(snapshot.error, /Admin key: Error: HTTP 500/);
    }
  });

  it('returns ok:false (no throw) when the usage report responds with a non-JSON error body', async () => {
    // Arrange
    const def = findConnector('anthropic')!;
    const ctx = runtime.contextFor(def);
    ctx.setSecret('adminApiKey', 'sk-ant-admin01-realistic-key');

    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/usage_report/messages')) {
        return rawResponse(500, 'Internal Server Error');
      }
      return jsonResponse(404, {});
    }) as typeof globalThis.fetch;

    const provider = def.quota!.create({}, ctx);

    // Act
    const snapshot = await provider.fetch();

    // Assert
    assert.equal(snapshot.ok, false);
    if (!snapshot.ok) {
      assert.match(snapshot.error, /Could not fetch Anthropic usage/);
      assert.match(snapshot.error, /Admin key: Error: HTTP 500/);
    }
  });

  it('returns ok:true with empty buckets when the usage report responds 200 with a non-JSON body', async () => {
    // Arrange
    const def = findConnector('anthropic')!;
    const ctx = runtime.contextFor(def);
    ctx.setSecret('adminApiKey', 'sk-ant-admin01-realistic-key');

    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/usage_report/messages')) {
        return rawResponse(200, 'not json');
      }
      if (url.includes('/cost_report')) {
        return rawResponse(200, 'not json');
      }
      return jsonResponse(404, {});
    }) as typeof globalThis.fetch;

    const provider = def.quota!.create({}, ctx);

    // Act
    const snapshot = await provider.fetch();

    // Assert
    // NOTE: same httpsGetJson behavior as the OpenAI provider -- a 200 with
    // an unparsable body becomes `{ status: 200, json: {} }`, so
    // parseAdminUsage sees no `data` array and returns zero buckets instead
    // of an error.
    assert.equal(snapshot.ok, true);
    if (snapshot.ok) {
      assert.deepEqual(snapshot.buckets, []);
      assert.equal(snapshot.membershipType, 'anthropic-admin');
    }
  });
});
