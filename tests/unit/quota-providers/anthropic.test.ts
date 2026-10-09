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
      // cache_creation 5m 150 + 1h 50 on day one, 0 on day two.
      assert.equal(byId['cache-write-tokens'].used, 200);
      // "123.45" is already cents: $1.23, not $123.45.
      assert.equal(byId['spend-this-period'].used, 123);
      assert.equal(byId['spend-this-period'].unit, 'usd');
      for (const id of ['input-tokens', 'output-tokens', 'cache-read-tokens', 'cache-write-tokens']) {
        assert.equal(byId[id].unit, 'tokens', id);
      }
    }
  });

  it('identifies itself to Anthropic with a User-Agent header', async () => {
    // Arrange
    const def = findConnector('anthropic')!;
    const ctx = runtime.contextFor(def);
    ctx.setSecret('adminApiKey', 'sk-ant-admin01-realistic-key');

    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('user-agent') ?? '');
      const url = String(input);
      if (url.includes('/usage_report/messages')) {
        return jsonResponse(200, anthropicUsageReportResponse());
      }
      return jsonResponse(200, anthropicCostReportResponse());
    }) as typeof globalThis.fetch;

    // Act
    await def.quota!.create({}, ctx).fetch();

    // Assert
    assert.ok(seen.length > 0);
    for (const ua of seen) {
      assert.match(ua, /^AIOversight\/\S+ \(https:\/\/github\.com\/nikolmedo\/AIOversight\)$/);
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
      assert.match(snapshot.error, /invalid, expired or revoked/);
      assert.match(snapshot.error, /platform\.claude\.com\/settings\/admin-keys/);
    }
  });

  it('explains a 403 as a key without organization admin access', async () => {
    // Arrange
    const def = findConnector('anthropic')!;
    const ctx = runtime.contextFor(def);
    ctx.setSecret('adminApiKey', 'sk-ant-api03-not-an-admin-key');

    globalThis.fetch = (async (input: string | URL) => {
      if (String(input).includes('/usage_report/messages')) {
        return jsonResponse(403, anthropicErrorResponse('permission denied'));
      }
      return jsonResponse(404, {});
    }) as typeof globalThis.fetch;

    // Act
    const snapshot = await def.quota!.create({}, ctx).fetch();

    // Assert
    assert.equal(snapshot.ok, false);
    if (!snapshot.ok) {
      assert.match(snapshot.error, /HTTP 403/);
      assert.match(snapshot.error, /organization admin key/);
    }
  });

  it('reports a rate-limited snapshot carrying Retry-After when the usage report responds with 429', async () => {
    // Arrange
    const def = findConnector('anthropic')!;
    const ctx = runtime.contextFor(def);
    ctx.setSecret('adminApiKey', 'sk-ant-admin01-realistic-key');

    let calls = 0;
    globalThis.fetch = (async (input: string | URL) => {
      calls++;
      const url = String(input);
      if (url.includes('/usage_report/messages')) {
        return new Response(JSON.stringify(anthropicErrorResponse('rate limit exceeded')), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '120' },
        });
      }
      return jsonResponse(404, {});
    }) as typeof globalThis.fetch;

    const provider = def.quota!.create({}, ctx);

    // Act
    const snapshot = await provider.fetch();

    // Assert
    assert.equal(snapshot.ok, false);
    if (!snapshot.ok) {
      assert.match(snapshot.error, /rate-limited/);
      assert.equal(snapshot.retryAfterMs, 120_000);
    }
    // A 429 means "stop asking", so the cookie strategy is NOT tried as a
    // second door — only the one admin-key request went out.
    assert.equal(calls, 1);
  });

  it('falls back to a 60s backoff when a 429 carries no Retry-After header', async () => {
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
      assert.equal(snapshot.retryAfterMs, 60_000);
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

  it('reports no spend at all when every cost amount is an empty string', async () => {
    // Arrange - `Number('')` is 0, which would render an authoritative $0.00
    // for a period whose real spend is simply unknown.
    const def = findConnector('anthropic')!;
    const ctx = runtime.contextFor(def);
    ctx.setSecret('adminApiKey', 'sk-ant-admin01-realistic-key');

    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/usage_report/messages')) return jsonResponse(200, anthropicUsageReportResponse());
      if (url.includes('/cost_report')) {
        return jsonResponse(200, {
          data: [{ results: [{ amount: '', currency: 'USD' }] }],
        });
      }
      return jsonResponse(404, {});
    }) as typeof globalThis.fetch;

    // Act
    const snapshot = await def.quota!.create({}, ctx).fetch();

    // Assert
    assert.equal(snapshot.ok, true);
    if (snapshot.ok) assert.equal(snapshot.buckets.some(b => b.id === 'spend-this-period'), false);
  });

  it('requests 31 daily buckets per page and follows next_page on both reports', async () => {
    // Arrange
    const def = findConnector('anthropic')!;
    const ctx = runtime.contextFor(def);
    ctx.setSecret('adminApiKey', 'sk-ant-admin01-realistic-key');

    const urls: string[] = [];
    const usageRow = (n: number) => ({
      uncached_input_tokens: n,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    });
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      urls.push(url);
      const second = url.includes('page=page_2');
      if (url.includes('/usage_report/messages')) {
        return jsonResponse(200, {
          data: [{ results: [usageRow(second ? 30 : 100)] }],
          has_more: !second,
          next_page: second ? null : 'page_2',
        });
      }
      if (url.includes('/cost_report')) {
        return jsonResponse(200, {
          data: [{ results: [{ amount: second ? '50.4' : '100.2', currency: 'USD' }] }],
          has_more: !second,
          next_page: second ? null : 'page_2',
        });
      }
      return jsonResponse(404, {});
    }) as typeof globalThis.fetch;

    // Act
    const snapshot = await def.quota!.create({}, ctx).fetch();

    // Assert
    assert.equal(snapshot.ok, true);
    if (snapshot.ok) {
      const byId = Object.fromEntries(snapshot.buckets.map(b => [b.id, b]));
      assert.equal(byId['input-tokens'].used, 130);
      assert.equal(byId['output-tokens'].used, 2);
      // 100.2 + 50.4 = 150.6 cents, rounded once at the end.
      assert.equal(byId['spend-this-period'].used, 151);
    }
    assert.equal(urls.length, 4);
    for (const url of urls) assert.match(url, /[?&]limit=31(&|$)/);
    assert.equal(urls.filter(u => u.includes('page=page_2')).length, 2);
  });

  it('fails the usage period instead of returning partial data after the page bound', async () => {
    // Arrange - a server that always claims there is more.
    const def = findConnector('anthropic')!;
    const ctx = runtime.contextFor(def);
    ctx.setSecret('adminApiKey', 'sk-ant-admin01-realistic-key');

    let usageCalls = 0;
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/usage_report/messages')) {
        usageCalls++;
        return jsonResponse(200, { data: [], has_more: true, next_page: `page_${usageCalls + 1}` });
      }
      return jsonResponse(200, { data: [], has_more: false, next_page: null });
    }) as typeof globalThis.fetch;

    // Act
    const snapshot = await def.quota!.create({}, ctx).fetch();

    // Assert
    assert.equal(snapshot.ok, false);
    if (!snapshot.ok) assert.match(snapshot.error ?? '', /more pages|partial|too many/i);
    assert.equal(usageCalls, 5);
  });

  it('rate-limits when a later usage page responds with 429', async () => {
    // Arrange
    const def = findConnector('anthropic')!;
    const ctx = runtime.contextFor(def);
    ctx.setSecret('adminApiKey', 'sk-ant-admin01-realistic-key');

    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/usage_report/messages') && url.includes('page=page_2')) {
        return new Response('{}', { status: 429, headers: { 'retry-after': '30' } });
      }
      if (url.includes('/usage_report/messages')) {
        return jsonResponse(200, { data: [], has_more: true, next_page: 'page_2' });
      }
      return jsonResponse(404, {});
    }) as typeof globalThis.fetch;

    // Act
    const snapshot = await def.quota!.create({}, ctx).fetch();

    // Assert
    assert.equal(snapshot.ok, false);
    if (!snapshot.ok) assert.equal(snapshot.retryAfterMs, 30_000);
  });

  it('omits spend when the cost report fails part-way through pagination', async () => {
    // Arrange - a partial sum would understate the period's spend.
    const def = findConnector('anthropic')!;
    const ctx = runtime.contextFor(def);
    ctx.setSecret('adminApiKey', 'sk-ant-admin01-realistic-key');

    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/usage_report/messages')) return jsonResponse(200, anthropicUsageReportResponse());
      if (url.includes('page=page_2')) return jsonResponse(500, {});
      return jsonResponse(200, {
        data: [{ results: [{ amount: '500', currency: 'USD' }] }],
        has_more: true,
        next_page: 'page_2',
      });
    }) as typeof globalThis.fetch;

    // Act
    const snapshot = await def.quota!.create({}, ctx).fetch();

    // Assert
    assert.equal(snapshot.ok, true);
    if (snapshot.ok) assert.equal(snapshot.buckets.some(b => b.id === 'spend-this-period'), false);
  });

  it('only sums USD cost amounts', async () => {
    // Arrange
    const def = findConnector('anthropic')!;
    const ctx = runtime.contextFor(def);
    ctx.setSecret('adminApiKey', 'sk-ant-admin01-realistic-key');

    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/usage_report/messages')) return jsonResponse(200, anthropicUsageReportResponse());
      return jsonResponse(200, {
        data: [
          {
            results: [
              { amount: '250', currency: 'USD' },
              { amount: '9999', currency: 'EUR' },
              { amount: '50' },
            ],
          },
        ],
        has_more: false,
        next_page: null,
      });
    }) as typeof globalThis.fetch;

    // Act
    const snapshot = await def.quota!.create({}, ctx).fetch();

    // Assert
    assert.equal(snapshot.ok, true);
    if (snapshot.ok) {
      const spend = snapshot.buckets.find(b => b.id === 'spend-this-period');
      assert.equal(spend?.used, 300);
    }
  });

  it('falls back to the flat cache_creation_input_tokens field when cache_creation is absent', async () => {
    // Arrange
    const def = findConnector('anthropic')!;
    const ctx = runtime.contextFor(def);
    ctx.setSecret('adminApiKey', 'sk-ant-admin01-realistic-key');

    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/usage_report/messages')) {
        return jsonResponse(200, {
          data: [
            { results: [{ uncached_input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 70 }] },
            {
              results: [
                {
                  uncached_input_tokens: 10,
                  output_tokens: 1,
                  cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 25 },
                },
              ],
            },
          ],
          has_more: false,
          next_page: null,
        });
      }
      return jsonResponse(200, anthropicCostReportResponse());
    }) as typeof globalThis.fetch;

    // Act
    const snapshot = await def.quota!.create({}, ctx).fetch();

    // Assert
    assert.equal(snapshot.ok, true);
    if (snapshot.ok) {
      const write = snapshot.buckets.find(b => b.id === 'cache-write-tokens');
      assert.equal(write?.used, 100);
    }
  });
});

describe('AnthropicQuotaProvider claude.ai cookie fallback', () => {
  // The provider calls `readChromiumCookie` through the module's exports at
  // call time, so swapping the export stands in for a real cookie store.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cookies = require('../../../src/main/connectors/shared/chromium-cookies') as {
    readChromiumCookie: (...args: unknown[]) => Promise<string | null>;
  };
  let dir: string;
  let runtime: ConnectorRuntime;
  let originalFetch: typeof globalThis.fetch;
  let originalReadCookie: typeof cookies.readChromiumCookie;

  beforeEach(() => {
    dir = makeTempDir('aioversight-anthropic-cookie-');
    setUserDataPath(dir);
    resetElectronStub();
    runtime = new ConnectorRuntime(new SecretStore());
    originalFetch = globalThis.fetch;
    originalReadCookie = cookies.readChromiumCookie;
    cookies.readChromiumCookie = async () => 'sk-ant-sid01-test-session';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    cookies.readChromiumCookie = originalReadCookie;
    removeTempDir(dir);
  });

  function mockClaudeAi(usageBody: unknown): void {
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/api/organizations')) {
        return jsonResponse(200, [{ uuid: 'org-123', name: 'Personal' }]);
      }
      if (url.endsWith('/api/organizations/org-123/usage')) return jsonResponse(200, usageBody);
      return jsonResponse(404, {});
    }) as typeof globalThis.fetch;
  }

  it('parses utilization windows from the claude.ai usage endpoint', async () => {
    // Arrange
    const resetsAt = new Date(Date.now() + 2 * 3_600_000).toISOString();
    mockClaudeAi({
      five_hour: { utilization: 42, resets_at: resetsAt },
      seven_day: { utilization: 17.5, resets_at: resetsAt },
      seven_day_opus: null,
    });
    const def = findConnector('anthropic')!;
    const ctx = runtime.contextFor(def);

    // Act
    const snapshot = await def.quota!.create({}, ctx).fetch();

    // Assert
    assert.equal(snapshot.ok, true);
    if (snapshot.ok) {
      assert.equal(snapshot.authMethod, 'cookie');
      assert.equal(snapshot.membershipType, 'Personal');
      const byId = Object.fromEntries(snapshot.buckets.map(b => [b.id, b]));
      assert.equal(byId['five-hour'].used, 42);
      assert.equal(byId['five-hour'].unit, 'percent');
      assert.equal(byId['five-hour'].limit, 100);
      assert.equal(byId['five-hour'].resetsAt, Date.parse(resetsAt));
      assert.equal(byId['seven-day'].used, 17.5);
    }
  });

  it('returns an error instead of an empty snapshot when no limit is recognized', async () => {
    // Arrange
    mockClaudeAi({ requests: { used: 3, limit: 10 }, tangelo: null });
    const def = findConnector('anthropic')!;
    const ctx = runtime.contextFor(def);

    // Act
    const snapshot = await def.quota!.create({}, ctx).fetch();

    // Assert
    assert.equal(snapshot.ok, false);
    if (!snapshot.ok) assert.match(snapshot.error, /claude\.ai usage had no recognizable limits/);
  });
});
