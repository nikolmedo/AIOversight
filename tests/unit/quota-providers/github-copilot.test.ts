import './../../helpers/electron-stub';
import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { setUserDataPath, resetElectronStub } from '../../helpers/electron-stub';
import { makeTempDir, removeTempDir } from '../../helpers/temp-dir';
import { ConnectorRuntime } from '../../../src/main/connectors/runtime';
import { SecretStore } from '../../../src/main/connectors/secret-store';
import { findConnector } from '../../../src/main/connectors/registry';
import {
  copilotInternalUserResponse,
  copilotTokenBillingUserResponse,
  copilotErrorResponse,
  copilotReportPointerResponse,
  copilotOrgReportNdjson,
  copilotUsersReportNdjson,
} from '../../helpers/fixtures';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function ndjsonResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
}

const ORG_REPORT_DOWNLOAD = 'https://objects.githubusercontent.com/copilot-reports/org-28d.json?sig=redacted';
const USERS_REPORT_DOWNLOAD = 'https://objects.githubusercontent.com/copilot-reports/users-28d.json?sig=redacted';

describe('GitHub Copilot quota provider', () => {
  let dir: string;
  let runtime: ConnectorRuntime;
  let originalFetch: typeof globalThis.fetch;
  const savedEnv: Record<string, string | undefined> = {};

  /** Points every path `resolveOauthToken` consults at the suite's temp dir.
   * `os.homedir()` reads `USERPROFILE` on Windows and `HOME` elsewhere, and
   * the Windows candidates additionally read `APPDATA` — without all three, a
   * developer machine with a real VS Code Copilot Chat or `gh` session on disk
   * would feed this suite a live token and a real api.github.com call. */
  function isolateEnv(): void {
    for (const key of ['PATH', 'APPDATA', 'USERPROFILE', 'HOME']) {
      savedEnv[key] = process.env[key];
    }
    // The last credential fallback shells out to `gh auth token`; an empty
    // PATH makes that spawn fail with ENOENT.
    process.env.PATH = '';
    process.env.APPDATA = dir;
    process.env.USERPROFILE = dir;
    process.env.HOME = dir;
  }

  beforeEach(() => {
    dir = makeTempDir('aioversight-copilot-quota-');
    setUserDataPath(dir);
    resetElectronStub();
    runtime = new ConnectorRuntime(new SecretStore());
    originalFetch = globalThis.fetch;
    isolateEnv();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    removeTempDir(dir);
  });

  it('requests sign-in when no OAuth token is stored', async () => {
    // Arrange
    const def = findConnector('github-copilot')!;
    const ctx = runtime.contextFor(def);
    const provider = def.quota!.create({}, ctx);
    // A stub that answers rather than throws: `httpsGetJson`'s outer catch
    // swallows a throwing fetch and falls through to a REAL `https.get`.
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return jsonResponse(500, {});
    }) as typeof globalThis.fetch;

    // Act
    const snapshot = await provider.fetch();

    // Assert
    assert.equal(called, false);
    assert.equal(snapshot.ok, false);
    if (!snapshot.ok) {
      assert.equal(snapshot.needsLogin, true);
      assert.match(snapshot.error, /Not signed in to GitHub Copilot/);
    }
  });

  it('leaves "used" unmeasured when a snapshot reports remaining without an entitlement', async () => {
    // Arrange — the XOR case: `quota_remaining` present, `entitlement` absent.
    // Usage is genuinely unknowable here, so it must stay null rather than
    // rendering as "you have used none of your quota".
    const def = findConnector('github-copilot')!;
    const ctx = runtime.contextFor(def);
    ctx.setSecret('copilotOauthToken', 'ghu_realisticTokenValue1234567890');

    globalThis.fetch = (async () =>
      jsonResponse(200, {
        copilot_plan: 'individual',
        quota_snapshots: { premium_interactions: { quota_remaining: 120 } },
      })) as typeof globalThis.fetch;

    // Act
    const snapshot = await def.quota!.create({}, ctx).fetch();

    // Assert
    assert.equal(snapshot.ok, true);
    if (snapshot.ok) {
      const premium = snapshot.buckets.find(b => b.id === 'premium_interactions')!;
      assert.equal(premium.used, null);
      assert.equal(premium.limit, null);
      assert.equal(premium.remaining, 120);
    }
  });

  it('parses personal quota snapshots, including unlimited buckets', async () => {
    // Arrange
    const def = findConnector('github-copilot')!;
    const ctx = runtime.contextFor(def);
    ctx.setSecret('copilotOauthToken', 'ghu_realisticTokenValue1234567890');

    globalThis.fetch = (async () => jsonResponse(200, copilotInternalUserResponse())) as typeof globalThis.fetch;

    const provider = def.quota!.create({}, ctx);

    // Act
    const snapshot = await provider.fetch();

    // Assert
    assert.equal(snapshot.ok, true);
    if (snapshot.ok) {
      assert.equal(snapshot.membershipType, 'individual');
      assert.equal(snapshot.authMethod, 'oauth');
      assert.deepEqual(snapshot.displayMessages, ['Quota resets 2026-07-01']);

      const byId = Object.fromEntries(snapshot.buckets.map(b => [b.id, b]));
      assert.equal(byId.premium_interactions.used, 85.5); // 300 - 214.5
      assert.equal(byId.premium_interactions.limit, 300);
      assert.equal(byId.premium_interactions.remaining, 214.5);

      assert.equal(byId.chat.label, 'Chat (unlimited)');
      assert.equal(byId.chat.limit, null);
      assert.equal(byId.completions.label, 'Code completions (unlimited)');
    }
  });

  it('requests sign-in again when the API responds with 401', async () => {
    // Arrange
    const def = findConnector('github-copilot')!;
    const ctx = runtime.contextFor(def);
    ctx.setSecret('copilotOauthToken', 'ghu_expiredTokenValue1234567890');

    globalThis.fetch = (async () => jsonResponse(401, copilotErrorResponse('Bad credentials'))) as typeof globalThis.fetch;

    const provider = def.quota!.create({}, ctx);

    // Act
    const snapshot = await provider.fetch();

    // Assert
    assert.equal(snapshot.ok, false);
    if (!snapshot.ok) {
      assert.equal(snapshot.needsLogin, true);
      assert.match(snapshot.error, /returned 401/);
    }
  });

  it('returns a non-quota error message for other GitHub API failures', async () => {
    // Arrange
    const def = findConnector('github-copilot')!;
    const ctx = runtime.contextFor(def);
    ctx.setSecret('copilotOauthToken', 'ghu_realisticTokenValue1234567890');

    globalThis.fetch = (async () => jsonResponse(500, copilotErrorResponse('Internal Server Error'))) as typeof globalThis.fetch;

    const provider = def.quota!.create({}, ctx);

    // Act
    const snapshot = await provider.fetch();

    // Assert
    assert.equal(snapshot.ok, false);
    if (!snapshot.ok) {
      assert.equal(snapshot.needsLogin, undefined);
      assert.match(snapshot.error, /GitHub Copilot 500/);
      assert.match(snapshot.error, /Internal Server Error/);
    }
  });

  it('parses AI-Credits snapshots, preferring fractional quota_remaining', async () => {
    // Arrange
    const def = findConnector('github-copilot')!;
    const ctx = runtime.contextFor(def);
    ctx.setSecret('copilotOauthToken', 'ghu_realisticTokenValue1234567890');

    globalThis.fetch = (async () => jsonResponse(200, copilotTokenBillingUserResponse())) as typeof globalThis.fetch;

    const provider = def.quota!.create({}, ctx);

    // Act
    const snapshot = await provider.fetch();

    // Assert
    assert.equal(snapshot.ok, true);
    if (snapshot.ok) {
      const byId = Object.fromEntries(snapshot.buckets.map(b => [b.id, b]));
      const premium = byId.premium_interactions;
      // 20000 - 19496.4, NOT 20000 - 19496 (the rounded `remaining`) and NOT
      // the misleading `credits_used: 504`. Compared with a tolerance because
      // the subtraction is binary floating point, not because the value is
      // approximate.
      assert.ok(Math.abs((premium.used ?? 0) - 503.6) < 1e-6, String(premium.used));
      assert.equal(premium.remaining, 19_496.4);
      assert.equal(premium.limit, 20_000);
      assert.equal(premium.unit, 'credits');
      assert.match(premium.note ?? '', /\$0\.01/);

      // `unlimited: true` must still render as unlimited, not as a 0-quota bucket.
      assert.equal(byId.chat.label, 'Chat (unlimited)');
      assert.equal(byId.chat.limit, null);
      assert.equal(byId.chat.remaining, null);

      assert.ok(snapshot.displayMessages.some(m => /AI Credits/.test(m)));
    }
  });

  it('appends org report buckets from the reports API when an org slug is configured', async () => {
    // Arrange
    const def = findConnector('github-copilot')!;
    const ctx = runtime.contextFor(def);
    ctx.setSecret('copilotOauthToken', 'ghu_realisticTokenValue1234567890');

    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes('copilot_internal/user')) {
        return jsonResponse(200, copilotInternalUserResponse());
      }
      if (url.includes('/reports/organization-28-day/latest')) {
        return jsonResponse(200, copilotReportPointerResponse(ORG_REPORT_DOWNLOAD));
      }
      if (url.includes('/reports/users-28-day/latest')) {
        return jsonResponse(200, copilotReportPointerResponse(USERS_REPORT_DOWNLOAD));
      }
      if (url === ORG_REPORT_DOWNLOAD) return ndjsonResponse(copilotOrgReportNdjson());
      if (url === USERS_REPORT_DOWNLOAD) return ndjsonResponse(copilotUsersReportNdjson());
      return jsonResponse(404, {});
    }) as typeof globalThis.fetch;

    const provider = def.quota!.create({ org: 'aioversight-org' }, ctx);

    // Act
    const snapshot = await provider.fetch();

    // Assert
    assert.equal(snapshot.ok, true);
    if (snapshot.ok) {
      const byId = Object.fromEntries(snapshot.buckets.map(b => [b.id, b]));
      // Personal buckets are still present.
      assert.ok('premium_interactions' in byId);
      assert.equal(byId['active-users-peak'].used, 15);
      assert.equal(byId['org-monthly-active-users'].used, 42);
      assert.equal(byId['org-engaged-users'].used, 11);
      assert.equal(byId['org-ai-credits'].used, 200.5);
      assert.equal(byId['org-ai-credits'].unit, 'credits');
      // The winning org's slug is stamped into every org label.
      assert.match(byId['active-users-peak'].label, /aioversight-org/);
    }
  });

  it('explains a 403 on the org reports API instead of failing the snapshot', async () => {
    // Arrange
    const def = findConnector('github-copilot')!;
    const ctx = runtime.contextFor(def);
    ctx.setSecret('copilotOauthToken', 'ghu_realisticTokenValue1234567890');

    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes('copilot_internal/user')) {
        return jsonResponse(200, copilotInternalUserResponse());
      }
      if (url.includes('/reports/')) {
        return jsonResponse(403, copilotErrorResponse('Insufficient permissions.'));
      }
      return jsonResponse(404, {});
    }) as typeof globalThis.fetch;

    const provider = def.quota!.create({ org: 'aioversight-org' }, ctx);

    // Act
    const snapshot = await provider.fetch();

    // Assert — personal buckets survive, the org gap is explained, not an error.
    assert.equal(snapshot.ok, true);
    if (snapshot.ok) {
      assert.ok(snapshot.buckets.some(b => b.id === 'premium_interactions'));
      assert.ok(snapshot.displayMessages.some(m => /org-admin/.test(m)));
    }
  });
});
