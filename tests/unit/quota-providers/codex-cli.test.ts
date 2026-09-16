import './../../helpers/electron-stub';
import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { setUserDataPath, resetElectronStub } from '../../helpers/electron-stub';
import { makeTempDir, removeTempDir } from '../../helpers/temp-dir';
import { ConnectorRuntime } from '../../../src/main/connectors/runtime';
import { SecretStore } from '../../../src/main/connectors/secret-store';
import { findConnector } from '../../../src/main/connectors/registry';
import { parseUsageBuckets, parseRateWindow } from '../../../src/main/connectors/codex-cli/quota';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * The `wham/usage` body as confirmed against openai/codex's
 * `codex-backend-openapi-models` and the `app-server` rate-limits fixture.
 */
function whamUsageResponse(): Record<string, unknown> {
  return {
    plan_type: 'pro',
    account_id: 'acct_redacted',
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 12.5,
        limit_window_seconds: 18_000,
        reset_after_seconds: 1_234,
        reset_at: '2026-09-16T18:00:00Z',
      },
      secondary_window: {
        used_percent: 40,
        limit_window_seconds: 604_800,
        reset_after_seconds: 5_678,
        reset_at: '2026-09-20T00:00:00Z',
      },
    },
    additional_rate_limits: [
      {
        limit_name: 'Codex Mini',
        metered_feature: 'codex',
        normal_model_slug: 'gpt-5.3-codex',
        rate_limit: { used_percent: 33, limit_window_seconds: 18_000, reset_after_seconds: 900 },
      },
    ],
    credits: { has_credits: true, unlimited: false, balance: 42 },
    rate_limit_reset_credits: { available_count: 3 },
  };
}

describe('Codex CLI usage parsing', () => {
  it('builds session + weekly buckets from rate_limit.primary/secondary_window', () => {
    // Act
    const parsed = parseUsageBuckets(whamUsageResponse());

    // Assert
    const byId = Object.fromEntries(parsed.buckets.map(b => [b.id, b]));
    assert.equal(parsed.planType, 'pro');
    assert.equal(byId.session.used, 12.5);
    assert.equal(byId.session.unit, 'percent');
    assert.equal(byId.weekly.used, 40);
    assert.equal(byId.weekly.windowMs, 604_800_000);
    assert.equal(parsed.windowCount, 3);
  });

  it('classifies windows by duration, not by slot, when the weekly window arrives first', () => {
    // Arrange — observed since ~July 2026: primary_window carries the 7d window.
    const body = {
      rate_limit: {
        primary_window: { used_percent: 70, limit_window_seconds: 604_800 },
        secondary_window: { used_percent: 5, limit_window_seconds: 18_000 },
      },
    };

    // Act
    const parsed = parseUsageBuckets(body);

    // Assert
    const byId = Object.fromEntries(parsed.buckets.map(b => [b.id, b]));
    assert.equal(byId.weekly.used, 70);
    assert.equal(byId.session.used, 5);
  });

  it('builds a per-model bucket from additional_rate_limits[]', () => {
    // Act
    const parsed = parseUsageBuckets(whamUsageResponse());

    // Assert
    const model = parsed.buckets.find(b => b.id.startsWith('model-'));
    assert.ok(model);
    assert.equal(model.id, 'model-gpt-5.3-codex-session');
    assert.equal(model.label, 'Codex Mini (5h)');
    assert.equal(model.used, 33);
  });

  it('maps credits and reset credits onto their own buckets', () => {
    // Act
    const parsed = parseUsageBuckets(whamUsageResponse());

    // Assert
    const byId = Object.fromEntries(parsed.buckets.map(b => [b.id, b]));
    assert.equal(byId.credits.remaining, 42);
    assert.equal(byId['reset-credits'].remaining, 3);
  });

  it('reports zero recognised windows for the old rate_limits/window_minutes shape', () => {
    // Act — the shape the parser used to read, which never existed on the wire.
    const parsed = parseUsageBuckets({ rate_limits: { primary: { used_percent: 10, window_minutes: 300 } } });

    // Assert
    assert.equal(parsed.windowCount, 0);
    assert.equal(parsed.buckets.length, 0);
  });

  it('treats an empty-string used_percent as unmeasured, not as 0%', () => {
    // Assert — `Number('')` is 0, which would render a full-quota meter for a
    // window the API did not actually report.
    assert.equal(parseRateWindow({ used_percent: '', limit_window_seconds: 18_000 }), null);
  });
});

describe('Codex CLI quota provider', () => {
  let dir: string;
  let codexHome: string;
  let runtime: ConnectorRuntime;
  let originalFetch: typeof globalThis.fetch;
  let originalCodexHome: string | undefined;

  beforeEach(() => {
    dir = makeTempDir('aioversight-codex-quota-');
    codexHome = path.join(dir, 'codex-home');
    fs.mkdirSync(codexHome, { recursive: true });
    originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    setUserDataPath(dir);
    resetElectronStub();
    runtime = new ConnectorRuntime(new SecretStore());
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    removeTempDir(dir);
  });

  it('hands a rejected session back to `codex login` without attempting a token refresh', async () => {
    // Arrange — refresh tokens rotate, and a second writer corrupts auth.json,
    // so a 401 must never trigger an OAuth round-trip or a write.
    const authPath = path.join(codexHome, 'auth.json');
    const authJson = {
      OPENAI_API_KEY: null,
      tokens: { access_token: 'expired-access', refresh_token: 'rotating-refresh', account_id: 'acct_1' },
    };
    fs.writeFileSync(authPath, JSON.stringify(authJson));

    const requested: string[] = [];
    globalThis.fetch = (async (input: string | URL) => {
      requested.push(String(input));
      return jsonResponse(401, { detail: 'unauthorized' });
    }) as typeof globalThis.fetch;

    const def = findConnector('codex-cli')!;
    const provider = def.quota!.create({}, runtime.contextFor(def));

    // Act
    const snapshot = await provider.fetch();

    // Assert
    assert.equal(snapshot.ok, false);
    if (!snapshot.ok) {
      assert.equal(snapshot.needsLogin, true);
      assert.match(snapshot.error, /codex login/);
    }
    assert.equal(requested.filter(u => u.includes('auth.openai.com')).length, 0);
    assert.equal(fs.readFileSync(authPath, 'utf8'), JSON.stringify(authJson));
  });

  it('mentions the keyring credential store when no auth.json exists', async () => {
    // Arrange — `cli_auth_credentials_store = keyring` is a supported Codex
    // setting, so a missing file does not mean the user never logged in.
    const def = findConnector('codex-cli')!;
    const provider = def.quota!.create({}, runtime.contextFor(def));

    // Act
    const snapshot = await provider.fetch();

    // Assert
    assert.equal(snapshot.ok, false);
    if (!snapshot.ok) {
      assert.match(snapshot.error, /keyring/);
    }
  });
});
