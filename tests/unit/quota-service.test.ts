import './../helpers/electron-stub';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import { setUserDataPath, resetElectronStub } from '../helpers/electron-stub';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir';
import { ConnectorRuntime } from '../../src/main/connectors/runtime';
import { SecretStore } from '../../src/main/connectors/secret-store';
import { QuotaService } from '../../src/main/connectors/quota-service';
import { ConnectorRuntimeConfig, QuotaSnapshot } from '../../src/main/connectors/types';
import { openAiUsageCompletionsResponse, openAiCostsResponse, openAiErrorResponse } from '../helpers/fixtures';

/** A ConnectorRuntimeConfig enabling quota only for the OpenAI connector. */
function rtConfig(overrides: Partial<ConnectorRuntimeConfig> = {}): ConnectorRuntimeConfig {
  return {
    enabled: {
      cursor: { notifications: false, quota: false },
      anthropic: { notifications: false, quota: false },
      'claude-code': { notifications: false, quota: false },
      openai: { notifications: false, quota: true },
      'codex-cli': { notifications: false, quota: false },
      'github-copilot': { notifications: false, quota: false },
      'generic-jsonl': { notifications: false, quota: false },
      webhook: { notifications: false, quota: false },
    },
    config: {},
    ...overrides,
  };
}

/** Builds a fetch Response-like object backed by a JSON body. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('QuotaService', () => {
  let dir: string;
  let secrets: SecretStore;
  let runtime: ConnectorRuntime;
  let service: QuotaService;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = makeTempDir('aioversight-quota-service-');
    setUserDataPath(dir);
    resetElectronStub();
    secrets = new SecretStore();
    runtime = new ConnectorRuntime(secrets);
    service = new QuotaService(runtime);
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    service.destroy();
    globalThis.fetch = originalFetch;
    mock.timers.reset();
    removeTempDir(dir);
  });

  it('registers an enabled connector and reports a "no admin key" snapshot when none is configured', async () => {
    // Arrange
    const rt = rtConfig();

    // Act
    await service.applyConfig(rt, 0);
    // applyConfig kicks off the first fetch in the background; refresh()
    // coalesces with that in-flight call and lets us await its result.
    const snapshot = await service.refresh('openai');

    // Assert
    assert.deepEqual(service.enabledIds(), ['openai']);
    assert.equal(snapshot?.ok, false);
    if (snapshot && !snapshot.ok) {
      assert.match(snapshot.error, /No OpenAI admin API key set/);
    }
    assert.equal(service.get('openai')?.ok, false);
  });

  it('fetches a real-shaped usage snapshot when an admin key is configured', async () => {
    // Arrange
    const ctx = runtime.contextFor((await import('../../src/main/connectors/registry')).findConnector('openai')!);
    ctx.setSecret('adminApiKey', 'sk-admin-realistic-key-12345');

    let fetchCalls = 0;
    globalThis.fetch = (async (input: string | URL, _init?: RequestInit) => {
      fetchCalls++;
      const url = String(input);
      if (url.includes('/usage/completions')) {
        return jsonResponse(200, openAiUsageCompletionsResponse());
      }
      if (url.includes('/costs')) {
        return jsonResponse(200, openAiCostsResponse());
      }
      return jsonResponse(404, {});
    }) as typeof globalThis.fetch;

    const rt = rtConfig();

    // Act
    await service.applyConfig(rt, 0);
    const snapshot = await service.refresh('openai');

    // Assert
    assert.equal(fetchCalls, 2); // usage + costs
    assert.equal(snapshot?.ok, true);
    if (snapshot && snapshot.ok) {
      assert.equal(snapshot.membershipType, 'openai-org');
      assert.equal(snapshot.authMethod, 'api-key');
      const ids = snapshot.buckets.map(b => b.id);
      assert.ok(ids.includes('spend-this-period'));
      assert.ok(ids.includes('requests'));
      assert.ok(ids.includes('input-tokens'));
      assert.ok(ids.includes('output-tokens'));
      assert.ok(ids.includes('cached-tokens'));
      const requestsBucket = snapshot.buckets.find(b => b.id === 'requests')!;
      assert.equal(requestsBucket.used, 60); // 42 + 18 from the fixture
    }
  });

  it('reports an error snapshot when the OpenAI API responds with an error status', async () => {
    // Arrange
    const ctx = runtime.contextFor((await import('../../src/main/connectors/registry')).findConnector('openai')!);
    ctx.setSecret('adminApiKey', 'sk-admin-revoked-key');

    globalThis.fetch = (async () => jsonResponse(401, openAiErrorResponse('Incorrect API key provided.'))) as typeof globalThis.fetch;

    const rt = rtConfig();

    // Act
    await service.applyConfig(rt, 0);
    const snapshot = await service.refresh('openai');

    // Assert
    assert.equal(snapshot?.ok, false);
    if (snapshot && !snapshot.ok) {
      assert.match(snapshot.error, /Incorrect API key provided/);
    }
  });

  it('coalesces concurrent refresh() calls into a single in-flight fetch', async () => {
    // Arrange
    const ctx = runtime.contextFor((await import('../../src/main/connectors/registry')).findConnector('openai')!);
    ctx.setSecret('adminApiKey', 'sk-admin-realistic-key-12345');

    let fetchCalls = 0;
    let resolveFetch: (() => void) | null = null;
    const gate = new Promise<void>(resolve => {
      resolveFetch = resolve;
    });
    globalThis.fetch = (async (input: string | URL) => {
      fetchCalls++;
      await gate; // hold every request open until the test releases the gate
      const url = String(input);
      if (url.includes('/usage/completions')) return jsonResponse(200, openAiUsageCompletionsResponse());
      return jsonResponse(200, openAiCostsResponse());
    }) as typeof globalThis.fetch;

    const rt = rtConfig();
    await service.applyConfig(rt, 0);

    // Act: fire two concurrent refreshes while the first fetch is still pending.
    const first = service.refresh('openai');
    const second = service.refresh('openai');
    resolveFetch!();
    const [firstSnap, secondSnap] = await Promise.all([first, second]);

    // Assert
    // Only one round of HTTP calls (usage + costs) happened, proving the
    // second refresh() coalesced onto the in-flight promise.
    assert.equal(fetchCalls, 2);
    assert.equal(firstSnap, secondSnap);
  });

  it('pickInterval: an explicit per-connector poll override wins over the global default', async () => {
    // Arrange
    const rt = rtConfig({ pollOverrideMinutes: { openai: 20 } });

    // Act
    await service.applyConfig(rt, 5);

    // Assert
    // Internal field inspection: `providers` is private, but this is the most
    // direct way to verify pickInterval()'s precedence without waiting
    // real minutes for a timer to fire.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = (service as any).providers.get('openai');
    assert.equal(entry.intervalMs, 20 * 60_000);
    assert.notEqual(entry.timer, null);
  });

  it('pickInterval: the global default wins when no per-connector override is set', async () => {
    // Arrange
    const rt = rtConfig();

    // Act
    await service.applyConfig(rt, 5);

    // Assert
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = (service as any).providers.get('openai');
    assert.equal(entry.intervalMs, 5 * 60_000);
  });

  it('pickInterval: the connector default is used when neither override nor global default is set', async () => {
    // Arrange
    const rt = rtConfig();

    // Act
    await service.applyConfig(rt, 0);

    // Assert
    // openai's defaultIntervalMinutes is 15.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = (service as any).providers.get('openai');
    assert.equal(entry.intervalMs, 15 * 60_000);
  });

  it('pickInterval: an override of 0 means manual-only (clamped intervalMs, no timer)', async () => {
    // Arrange
    const rt = rtConfig({ pollOverrideMinutes: { openai: 0 } });

    // Act
    await service.applyConfig(rt, 5);

    // Assert
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = (service as any).providers.get('openai');
    assert.equal(entry.intervalMs, 60_000); // Math.max(60_000, 0 * 60_000)
    assert.equal(entry.timer, null); // `minutes > 0` is false -> no periodic timer
  });

  it('refetches on the configured interval via the periodic timer', async () => {
    // Arrange
    const ctx = runtime.contextFor((await import('../../src/main/connectors/registry')).findConnector('openai')!);
    ctx.setSecret('adminApiKey', 'sk-admin-realistic-key-12345');

    let fetchCalls = 0;
    globalThis.fetch = (async (input: string | URL) => {
      fetchCalls++;
      const url = String(input);
      if (url.includes('/usage/completions')) return jsonResponse(200, openAiUsageCompletionsResponse());
      return jsonResponse(200, openAiCostsResponse());
    }) as typeof globalThis.fetch;

    mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });

    const rt = rtConfig({ pollOverrideMinutes: { openai: 1 } }); // 1 minute -> 60_000ms

    // Act
    await service.applyConfig(rt, 0);
    await service.refresh('openai'); // wait for the initial (immediate) fetch
    const callsAfterInitial = fetchCalls;

    mock.timers.tick(60_000);
    // Allow the async fetchOne triggered by the timer tick (and its nested
    // usage + costs awaits) to settle across several microtask turns.
    for (let i = 0; i < 6; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }

    // Assert
    assert.equal(callsAfterInitial, 2); // initial fetch: usage + costs
    assert.equal(fetchCalls, 4); // timer tick triggers a second usage + costs round
  });

  it('removes a connector and emits "removed" when quota is disabled in a later applyConfig', async () => {
    // Arrange
    const rt = rtConfig();
    await service.applyConfig(rt, 0);
    await service.refresh('openai');
    assert.deepEqual(service.enabledIds(), ['openai']);

    const removed: string[] = [];
    service.on('removed', (id: string) => removed.push(id));

    // Act
    const rtDisabled = rtConfig({
      enabled: { ...rtConfig().enabled, openai: { notifications: false, quota: false } },
    });
    await service.applyConfig(rtDisabled, 0);

    // Assert
    assert.deepEqual(service.enabledIds(), []);
    assert.deepEqual(removed, ['openai']);
    assert.equal(service.get('openai'), null);
  });

  it('emits "update" with the connector id and the resulting snapshot', async () => {
    // Arrange
    const rt = rtConfig();
    const updates: Array<{ id: string; snapshot: QuotaSnapshot }> = [];
    service.onUpdate((id, snapshot) => updates.push({ id, snapshot }));

    // Act
    await service.applyConfig(rt, 0);
    await service.refresh('openai');

    // Assert
    assert.ok(updates.length >= 1);
    assert.equal(updates[0].id, 'openai');
    assert.equal(updates[0].snapshot.ok, false);
  });

  it('wraps a provider crash into an "ok: false" snapshot with a "Quota provider crashed" message', async () => {
    // Arrange
    const rt = rtConfig();
    await service.applyConfig(rt, 0);
    await service.refresh('openai'); // let the initial background fetch settle first

    // Replace the live provider's fetch() with one that rejects, simulating
    // an unexpected crash (e.g. a bug thrown before the provider's own
    // try/catch). `providers` is private; this is the only way to exercise
    // QuotaService's crash-handling branch without a real provider bug.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = (service as any).providers.get('openai');
    entry.provider.fetch = () => Promise.reject(new Error('unexpected null pointer'));

    // Act
    const snapshot = await service.refresh('openai');

    // Assert
    assert.equal(snapshot?.ok, false);
    if (snapshot && !snapshot.ok) {
      assert.match(snapshot.error, /^Quota provider crashed: /);
      assert.match(snapshot.error, /unexpected null pointer/);
    }
  });

  it('refresh() returns null for a connector that is not enabled', async () => {
    // Arrange
    const rt = rtConfig(); // openai enabled, everything else disabled
    await service.applyConfig(rt, 0);

    // Act
    const snapshot = await service.refresh('anthropic');

    // Assert
    assert.equal(snapshot, null);
  });

  it('refreshAll() fetches every enabled connector and returns the full state', async () => {
    // Arrange
    const rt = rtConfig();
    await service.applyConfig(rt, 0);

    // Act
    const state = await service.refreshAll();

    // Assert
    assert.ok('openai' in state);
    assert.equal(state.openai.ok, false);
    assert.deepEqual(service.state(), state);
  });
});
