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
  copilotErrorResponse,
  copilotOrgMetricsResponse,
} from '../../helpers/fixtures';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('GitHub Copilot quota provider', () => {
  let dir: string;
  let runtime: ConnectorRuntime;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = makeTempDir('aioversight-copilot-quota-');
    setUserDataPath(dir);
    resetElectronStub();
    runtime = new ConnectorRuntime(new SecretStore());
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    removeTempDir(dir);
  });

  it('requests sign-in when no OAuth token is stored', async () => {
    // Arrange
    const def = findConnector('github-copilot')!;
    const ctx = runtime.contextFor(def);
    const provider = def.quota!.create({}, ctx);

    // Act
    const snapshot = await provider.fetch();

    // Assert
    assert.equal(snapshot.ok, false);
    if (!snapshot.ok) {
      assert.equal(snapshot.needsLogin, true);
      assert.match(snapshot.error, /Not signed in to GitHub Copilot/);
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

  it('appends org metrics buckets when an org slug is configured', async () => {
    // Arrange
    const def = findConnector('github-copilot')!;
    const ctx = runtime.contextFor(def);
    ctx.setSecret('copilotOauthToken', 'ghu_realisticTokenValue1234567890');

    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes('copilot_internal/user')) {
        return jsonResponse(200, copilotInternalUserResponse());
      }
      if (url.includes('/copilot/metrics') || url.includes('/copilot/usage')) {
        return jsonResponse(200, copilotOrgMetricsResponse());
      }
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
      // Org metrics: peak across the two fixture days.
      assert.equal(byId['active-users-peak'].used, 15);
      assert.equal(byId['engaged-users-peak'].used, 11);
      // suggestions accepted: 80 (day1) + 10 (day1 ide) + 90 (day2) = 180
      // suggestions total:    200 (day1) + 25 (day1 ide) + 220 (day2) = 445
      assert.equal(byId['org-suggestions'].used, 180);
      assert.equal(byId['org-suggestions'].limit, 445);
      assert.equal(byId['org-suggestions'].remaining, 265);
      // chat turns: 30 (day1) + 5 (ide chat) + 2 (dotcom chat) + 35 (day2) = 72
      assert.equal(byId['org-chat-turns'].used, 72);
      assert.equal(byId['org-pr-summaries'].used, 3);
    }
  });
});
