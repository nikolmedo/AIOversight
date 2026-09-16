import './../../helpers/electron-stub';
import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { makeTempDir, removeTempDir } from '../../helpers/temp-dir';
import { createFakeContext } from '../../helpers/fake-context';
import {
  parseRemainingPercent,
  parseUserStatus,
  buildUserStatusRequest,
  buildQuotaWindowBuckets,
  createDevinQuotaProvider,
  resolveServerUrl,
} from '../../../src/main/connectors/devin/quota';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Devin GetUserStatus parsing', () => {
  it('converts remaining percent to used percent', () => {
    // Act
    const parsed = parseUserStatus({
      weeklyQuotaRemainingPercent: 30,
      weeklyQuotaResetTime: '2026-09-20T00:00:00Z',
    });

    // Assert
    assert.equal(parsed.weekly!.usedPercent, 70);
  });

  it('treats an omitted percentage next to a live reset time as fully spent', () => {
    // Arrange — the backend drops a quota field when its value is zero, so
    // absence here means 0% remaining, not "unknown".
    const parsed = parseUserStatus({ dailyQuotaResetTime: '2026-09-17T00:00:00Z' });

    // Assert
    assert.equal(parsed.daily!.usedPercent, 100);
  });

  it('leaves a window unmeasured when both the percentage and the reset time are absent', () => {
    // Arrange — no reset time means the window does not exist for this
    // account, which must stay `null` rather than collapsing to zero.
    const parsed = parseUserStatus({ planInfo: { planName: 'Team' } });

    // Assert
    assert.equal(parsed.weekly, undefined);
    assert.equal(parsed.daily, undefined);
  });

  it('distinguishes spent from unmeasured in parseRemainingPercent directly', () => {
    // Assert
    assert.equal(parseRemainingPercent(undefined, true), 0);
    assert.equal(parseRemainingPercent(undefined, false), null);
    assert.equal(parseRemainingPercent(42, true), 42);
    assert.equal(parseRemainingPercent(0, false), 0);
  });

  it('reads planInfo.planName and converts overageBalanceMicros to cents', () => {
    // Act — micros are millionths of a dollar: 12_340_000 micros is $12.34.
    const parsed = parseUserStatus({
      planInfo: { planName: 'Enterprise' },
      overageBalanceMicros: 12_340_000,
      weeklyQuotaRemainingPercent: 50,
      weeklyQuotaResetTime: '2026-09-20T00:00:00Z',
    });

    // Assert
    assert.equal(parsed.planName, 'Enterprise');
    assert.equal(parsed.extraBalanceCents, 1234);
  });

  it('keeps the weekly and daily buckets on separate ids', () => {
    // Arrange
    const parsed = parseUserStatus({
      weeklyQuotaRemainingPercent: 40,
      weeklyQuotaResetTime: '2026-09-20T00:00:00Z',
      dailyQuotaRemainingPercent: 90,
      dailyQuotaResetTime: '2026-09-17T00:00:00Z',
    });

    // Act
    const buckets = buildQuotaWindowBuckets(parsed);

    // Assert
    const byId = Object.fromEntries(buckets.map(b => [b.id, b]));
    assert.equal(byId.weekly.used, 60);
    assert.equal(byId.daily.used, 10);
    assert.equal(byId.daily.defaultVisibility, 'onDemand');
  });
});

describe('Devin server URL transport policy', () => {
  it('refuses to send the API key over plain HTTP to a non-loopback host', () => {
    // Assert — the error names the rejected URL and never the key.
    assert.throws(() => resolveServerUrl('http://evil.example.com'), /evil\.example\.com/);
  });

  it('accepts an https override and a loopback http override', () => {
    // Assert
    assert.equal(resolveServerUrl('https://selfhosted.example.com/'), 'https://selfhosted.example.com');
    assert.equal(resolveServerUrl('http://localhost:8080'), 'http://localhost:8080');
    assert.equal(resolveServerUrl(undefined), 'https://server.codeium.com');
  });
});

describe('Devin request metadata', () => {
  it('sends ide_name "chisel" and semver versions', () => {
    // Arrange — "devin" returns permission_denied, and a non-semver version
    // field returns 500.
    const body = buildUserStatusRequest('key-123') as { metadata: Record<string, string> };

    // Assert
    assert.equal(body.metadata.ide_name, 'chisel');
    assert.equal(body.metadata.api_key, 'key-123');
    assert.match(body.metadata.ide_version, /^\d+\.\d+\.\d+$/);
    assert.match(body.metadata.extension_version, /^\d+\.\d+\.\d+$/);
  });
});

describe('Devin quota provider', () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;
  let originalXdg: string | undefined;

  beforeEach(() => {
    dir = makeTempDir('aioversight-devin-quota-');
    originalXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dir;
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdg;
    removeTempDir(dir);
  });

  function writeCredentials(contents: string): void {
    const credDir = path.join(dir, 'devin');
    fs.mkdirSync(credDir, { recursive: true });
    fs.writeFileSync(path.join(credDir, 'credentials.toml'), contents);
  }

  it('posts to SeatManagementService, not ApiServerService', async () => {
    // Arrange — ApiServerService serves completions and chat, not quota.
    writeCredentials('windsurf_api_key = "abc123"\n');
    const requested: string[] = [];
    globalThis.fetch = (async (input: string | URL) => {
      requested.push(String(input));
      return jsonResponse(200, {
        weeklyQuotaRemainingPercent: 55,
        weeklyQuotaResetTime: '2026-09-20T00:00:00Z',
        planInfo: { planName: 'Team' },
      });
    }) as typeof globalThis.fetch;

    // Act
    const snapshot = await createDevinQuotaProvider({}, createFakeContext()).fetch();

    // Assert
    assert.equal(snapshot.ok, true);
    assert.match(requested[0], /exa\.seat_management_pb\.SeatManagementService\/GetUserStatus$/);
    assert.equal(requested[0].includes('api_server_pb'), false);
    if (snapshot.ok) assert.equal(snapshot.membershipType, 'Team');
  });

  it('hands a rejected key back to the Devin app without rewriting credentials.toml', async () => {
    // Arrange
    writeCredentials('windsurf_api_key = "expired"\n');
    const credPath = path.join(dir, 'devin', 'credentials.toml');
    const before = fs.readFileSync(credPath, 'utf8');
    globalThis.fetch = (async () => jsonResponse(403, { code: 'permission_denied' })) as typeof globalThis.fetch;

    // Act
    const snapshot = await createDevinQuotaProvider({}, createFakeContext()).fetch();

    // Assert
    assert.equal(snapshot.ok, false);
    if (!snapshot.ok) {
      assert.equal(snapshot.needsLogin, true);
      assert.match(snapshot.error, /sign in again/i);
    }
    assert.equal(fs.readFileSync(credPath, 'utf8'), before);
  });

  it('reports a fully spent weekly window when the field is omitted', async () => {
    // Arrange — end-to-end version of the omitted-field trap.
    writeCredentials('windsurf_api_key = "abc123"\n');
    globalThis.fetch = (async () =>
      jsonResponse(200, { weeklyQuotaResetTime: '2026-09-20T00:00:00Z' })) as typeof globalThis.fetch;

    // Act
    const snapshot = await createDevinQuotaProvider({}, createFakeContext()).fetch();

    // Assert
    assert.equal(snapshot.ok, true);
    if (snapshot.ok) {
      const weekly = snapshot.buckets.find(b => b.id === 'weekly')!;
      assert.equal(weekly.used, 100);
      assert.equal(weekly.remaining, 0);
    }
  });
});
