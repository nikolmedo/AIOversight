import './../../helpers/electron-stub';
import Module = require('node:module');
import type * as cp from 'child_process';
import { describe, it, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  parseProcessArgs,
  parseLanguageServerCmdline,
  parseNetstatListeningPorts,
  parseLsofListeningPorts,
  parseWin32ProcessJson,
  discoverLanguageServer,
  candidateBaseUrls,
  candidateCsrfTokens,
  parseQuotaSummary,
  parseLegacyUserStatus,
  usedPercentFromRemainingFraction,
  mergePoolQuota,
  CSRF_HEADER,
  RPC_REQUEST_BODY,
  notFoundSnapshot,
  parsePortRangeInfo,
  APP_NOT_RUNNING_NOTICE,
  runCommand,
  createAntigravityQuotaProvider,
} from '../../../src/main/connectors/antigravity/quota';
import { createFakeContext } from '../../helpers/fake-context';

describe('Antigravity server not reached', () => {
  it('reports appNotRunning with the open-the-app notice when no process was found', () => {
    // Act
    const snap = notFoundSnapshot(null, parsePortRangeInfo(undefined), 1);

    // Assert
    assert.equal(snap.ok, false);
    if (!snap.ok) {
      assert.equal(snap.appNotRunning, true);
      assert.equal(snap.error, APP_NOT_RUNNING_NOTICE);
    }
  });

  it('reports a real error, not appNotRunning, when the process was found but never answered', () => {
    // Arrange
    const discovered = parseLanguageServerCmdline({ pid: 4242, cmdline: LS_CMDLINE });

    // Act
    const snap = notFoundSnapshot(discovered, parsePortRangeInfo(undefined), 1);

    // Assert
    assert.equal(snap.ok, false);
    if (!snap.ok) {
      assert.equal(snap.appNotRunning, undefined);
      assert.match(snap.error, /pid 4242/);
    }
  });

  it('WARNING FIX: reports a real error, not appNotRunning, when discovery itself was inconclusive (mechanism failed, not "found nothing")', () => {
    // Act -- discovery failed (e.g. powershell/ps errored or timed out), so
    // the caller passes inconclusive: true instead of the clean not-found path.
    const snap = notFoundSnapshot(null, parsePortRangeInfo(undefined), 1, true);

    // Assert -- a real, backoff-arming error, never the calm "just open the app" notice.
    assert.equal(snap.ok, false);
    if (!snap.ok) {
      assert.equal(snap.appNotRunning, undefined);
      assert.notEqual(snap.error, APP_NOT_RUNNING_NOTICE);
      assert.match(snap.error, /process listing failed/i);
    }
  });

  it('WARNING FIX: a truncated port-range scan is a real error, not appNotRunning, even with discovered === null', () => {
    // Arrange -- a pathologically wide range whose span was capped by MAX_PORT_RANGE_SPAN.
    const portInfo = parsePortRangeInfo('1-65000');
    assert.ok(portInfo.requestedSpan > portInfo.ports.length, 'precondition: this range must actually be truncated');

    // Act
    const snap = notFoundSnapshot(null, portInfo, 1, false);

    // Assert
    assert.equal(snap.ok, false);
    if (!snap.ok) {
      assert.equal(snap.appNotRunning, undefined);
      assert.match(snap.error, /truncated/i);
    }
  });

  it('a clean "no process, no port hit" outcome (not inconclusive, not truncated) still reports appNotRunning: true', () => {
    // Arrange -- a normal, non-widened range: nothing here should truncate.
    const portInfo = parsePortRangeInfo(undefined);
    assert.equal(portInfo.requestedSpan, portInfo.ports.length, 'precondition: this range must NOT be truncated');

    // Act
    const snap = notFoundSnapshot(null, portInfo, 1, false);

    // Assert
    assert.equal(snap.ok, false);
    if (!snap.ok) assert.equal(snap.appNotRunning, true);
  });
});

/**
 * `child_process.execFile` is non-configurable on this Node version, so it
 * cannot be monkeypatched by reassigning the property (a plain assignment
 * throws "only a getter"; `Object.defineProperty` throws "Cannot redefine
 * property"). Instead, intercept `require('child_process')` itself via
 * `Module._load` -- the same technique `electron-stub.ts` uses for
 * `require('electron')` -- and hand back a shallow copy of the real module
 * with `execFile` swapped, only while `execFileOverride` is set. `runCommand`
 * does a fresh `require('child_process')` on every call, so this is enough;
 * no source change to `runCommand` is needed to make it testable.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ModuleAny = Module as any;
const loadBeforeThisFile = ModuleAny._load;
let execFileOverride: typeof cp.execFile | null = null;

function patchedLoadForChildProcess(this: unknown, request: string, ...rest: unknown[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = loadBeforeThisFile.call(this, request, ...rest);
  if (request === 'child_process' && execFileOverride) {
    return { ...result, execFile: execFileOverride };
  }
  return result;
}

Object.defineProperty(ModuleAny, '_load', {
  value: patchedLoadForChildProcess,
  writable: true,
  configurable: true,
  enumerable: true,
});

function setExecFile(fn: typeof cp.execFile | null): void {
  execFileOverride = fn;
}

describe('Antigravity async command execution (WARNING/RESILIENCE fix: no more execFileSync blocking the event loop)', () => {
  afterEach(() => {
    setExecFile(null);
  });

  it('runCommand returns a Promise rather than blocking synchronously', () => {
    // Act
    const pending = runCommand(process.execPath, ['-e', 'process.exit(0)']);

    // Assert
    assert.equal(typeof pending.then, 'function');
  });

  it('does not block the event loop while the shelled-out command is pending', async () => {
    // Arrange -- a stand-in for a slow real command: it only answers once a
    // timer (proxy for "other event-loop work") has already run.
    setExecFile(((
      _file: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout?: string, stderr?: string) => void,
    ) => {
      setTimeout(() => {
        order.push('timer');
        cb(null, 'stub-output', '');
      }, 20);
    }) as unknown as typeof cp.execFile);
    const order: string[] = [];

    // Act
    const result = await runCommand('whatever', []).then(res => {
      order.push('runCommand');
      return res;
    });

    // Assert -- if `runCommand` still used `execFileSync` (ignoring this
    // mock entirely and either blocking for real or throwing ENOENT
    // synchronously), 'runCommand' would resolve on the current microtask
    // turn, before the 20ms timer ever fires.
    assert.deepEqual(order, ['timer', 'runCommand']);
    assert.deepEqual(result, { ok: true, stdout: 'stub-output' });
  });

  it('reports "not-found" for a missing tool (ENOENT), never confused with a real failure', async () => {
    // Act
    const result = await runCommand('definitely-not-a-real-binary-xyz-123', []);

    // Assert
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'not-found');
  });

  it('reports "failed" (not "not-found") for a command that runs but exits non-zero', async () => {
    // Act -- the tool exists (it's this test's own Node binary) and ran, it
    // just failed -- a real, worth-surfacing problem, not "app is closed".
    const result = await runCommand(process.execPath, ['-e', 'process.exit(3)']);

    // Assert
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'failed');
  });

  it('resolves ok:true with the captured stdout on success', async () => {
    // Act
    const result = await runCommand(process.execPath, ['-e', 'process.stdout.write("hello")']);

    // Assert
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.stdout, 'hello');
  });
});

const LS_CMDLINE =
  '"C:\\Users\\u\\.antigravity\\language_server_windows_x64.exe" --app_data_dir antigravity ' +
  '--csrf_token tok-main --extension_server_port 51234 --extension_server_csrf_token tok-ext';

describe('Antigravity process discovery', () => {
  it('reads flag values in both --flag value and --flag=value forms', () => {
    // Act
    const args = parseProcessArgs('--a one --b=two --c "three four"');

    // Assert
    assert.equal(args.a, 'one');
    assert.equal(args.b, 'two');
    assert.equal(args.c, 'three four');
  });

  it('lifts the tokens and port out of the language-server command line', () => {
    // Act
    const info = parseLanguageServerCmdline({ pid: 4242, cmdline: LS_CMDLINE })!;

    // Assert
    assert.equal(info.pid, 4242);
    assert.equal(info.csrfToken, 'tok-main');
    assert.equal(info.extensionServerCsrfToken, 'tok-ext');
    assert.equal(info.extensionServerPort, 51234);
  });

  it('ignores a sibling language server that is not Antigravity', () => {
    // Arrange — Windsurf and Codeium ship the same binary name.
    const other = { pid: 1, cmdline: '/opt/language_server_linux_x64 --app_data_dir windsurf --csrf_token x' };

    // Assert
    assert.equal(parseLanguageServerCmdline(other), null);
    assert.equal(parseLanguageServerCmdline({ pid: 2, cmdline: '/usr/bin/node server.js' }), null);
  });

  it('picks the Antigravity process out of a full process list', () => {
    // Act
    const info = discoverLanguageServer([
      { pid: 1, cmdline: '/usr/bin/bash' },
      { pid: 2, cmdline: '/opt/language_server --app_data_dir windsurf' },
      { pid: 3, cmdline: LS_CMDLINE },
    ]);

    // Assert
    assert.equal(info!.pid, 3);
    assert.equal(discoverLanguageServer([]), null);
  });

  it('reads listening ports for a pid from netstat output', () => {
    // Arrange
    const netstat = [
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    127.0.0.1:51234        0.0.0.0:0              LISTENING       4242',
      '  TCP    127.0.0.1:9999         0.0.0.0:0              LISTENING       999',
      '  TCP    127.0.0.1:51235        0.0.0.0:0              ESTABLISHED     4242',
    ].join('\n');

    // Assert
    assert.deepEqual(parseNetstatListeningPorts(netstat, 4242), [51234]);
    assert.deepEqual(parseNetstatListeningPorts(netstat, 1), []);
  });

  it('reads listening ports from lsof output', () => {
    // Arrange
    const lsof = [
      'COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
      'language_ 4242 u    12u  IPv4  0x1      0t0  TCP 127.0.0.1:51234 (LISTEN)',
    ].join('\n');

    // Assert
    assert.deepEqual(parseLsofListeningPorts(lsof), [51234]);
  });

  it('accepts both the single-object and array forms of ConvertTo-Json output', () => {
    // Arrange — PowerShell emits a bare object for exactly one match.
    const single = JSON.stringify({ ProcessId: 4242, CommandLine: LS_CMDLINE });
    const many = JSON.stringify([
      { ProcessId: 1, CommandLine: 'a' },
      { ProcessId: 2, CommandLine: 'b' },
    ]);

    // Assert
    assert.equal(parseWin32ProcessJson(single).length, 1);
    assert.equal(parseWin32ProcessJson(single)[0].pid, 4242);
    assert.equal(parseWin32ProcessJson(many).length, 2);
    assert.deepEqual(parseWin32ProcessJson('not json'), []);
  });

  it('builds candidate URLs over both schemes, command-line port first', () => {
    // Arrange — tools disagree on https vs http.
    const info = parseLanguageServerCmdline({ pid: 4242, cmdline: LS_CMDLINE })!;

    // Act
    const urls = candidateBaseUrls(info, [51999]);

    // Assert
    assert.match(urls[0], /^https:\/\/127\.0\.0\.1:51234\//);
    assert.match(urls[1], /^http:\/\/127\.0\.0\.1:51234\//);
    assert.equal(urls.some(u => u.includes(':51999')), true);
  });

  it('tries the extension-server CSRF token before the general one', () => {
    // Act
    const tokens = candidateCsrfTokens(parseLanguageServerCmdline({ pid: 1, cmdline: LS_CMDLINE })!);

    // Assert
    assert.deepEqual(tokens, ['tok-ext', 'tok-main']);
  });
});

describe('Antigravity request shape', () => {
  it('uses the Codeium CSRF header name', () => {
    // Assert — X-CSRF-Token was the wrong name.
    assert.equal(CSRF_HEADER, 'X-Codeium-Csrf-Token');
  });

  it('sends an IDE metadata envelope rather than an empty body', () => {
    // Act
    const body = JSON.parse(RPC_REQUEST_BODY) as { metadata: Record<string, string> };

    // Assert
    assert.equal(body.metadata.ideName, 'antigravity');
    assert.equal(body.metadata.extensionName, 'antigravity');
    assert.equal(body.metadata.locale, 'en');
    assert.equal(body.metadata.ideVersion, 'unknown');
  });
});

describe('Antigravity quota parsing', () => {
  it('inverts remainingFraction into a used percentage', () => {
    // Assert — reading it as "used" would invert every meter.
    assert.equal(usedPercentFromRemainingFraction(1), 0);
    assert.equal(usedPercentFromRemainingFraction(0.25), 75);
    assert.equal(usedPercentFromRemainingFraction(0), 100);
  });

  it('builds buckets from groups[].buckets[]', () => {
    // Arrange
    const body = {
      response: {
        groups: [
          {
            displayName: 'Gemini',
            buckets: [
              {
                bucketId: 'gemini-pro-5h',
                displayName: 'Pro (5h)',
                description: 'Resets every five hours',
                remaining: { remainingFraction: 0.4 },
              },
            ],
          },
        ],
      },
    };

    // Act
    const buckets = parseQuotaSummary(body);

    // Assert
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0].id, 'gemini-pro-5h');
    assert.equal(buckets[0].label, 'Gemini — Pro (5h)');
    assert.equal(buckets[0].used, 60);
    assert.equal(buckets[0].remaining, 40);
    assert.equal(buckets[0].note, 'Resets every five hours');
  });

  it('accepts groups at the top level as well as under response', () => {
    // Arrange — tools report both shapes.
    const body = {
      groups: [{ displayName: 'G', buckets: [{ bucketId: 'b1', remaining: { remainingFraction: 0.5 } }] }],
    };

    // Assert
    assert.equal(parseQuotaSummary(body)[0].used, 50);
  });

  it('skips a bucket with no numeric remainingFraction', () => {
    // Assert
    assert.deepEqual(parseQuotaSummary({ groups: [{ buckets: [{ bucketId: 'b', remaining: {} }] }] }), []);
    assert.deepEqual(parseQuotaSummary({}), []);
  });

  it('parses the legacy per-model GetUserStatus shape', () => {
    // Arrange
    const body = {
      userStatus: {
        cascadeModelConfigData: {
          clientModelConfigs: [
            { model: 'gemini-2-pro', quotaInfo: { remainingFraction: 0.2, resetTime: 1_800_000_000 } },
            { model: 'claude-sonnet', quotaInfo: { remainingFraction: 0.9 } },
          ],
        },
      },
    };

    // Act
    const entries = parseLegacyUserStatus(body);

    // Assert
    assert.equal(entries.length, 2);
    assert.equal(entries[0].usedPercent, 80);
    assert.equal(entries[0].resetsAt, 1_800_000_000_000);

    // The per-model figures still feed the pool merge.
    const merged = mergePoolQuota(entries);
    const byId = Object.fromEntries(merged.map(b => [b.id, b]));
    assert.equal(byId['gemini-5h'].used, 80);
    assert.equal(byId['other-5h'].used, 10);
  });
});

describe('Antigravity fetch() end-to-end wiring for inconclusive discovery (WARNING FIX)', () => {
  afterEach(() => {
    setExecFile(null);
  });

  // The Linux branch of `listProcesses()` reads `/proc` directly rather than
  // shelling out through `runCommand`, so this mock (which only intercepts
  // `execFile`) can't exercise it there.
  const itNonLinux = process.platform !== 'linux' ? it : it.skip;

  itNonLinux(
    'reports a real error (not appNotRunning) and warns, when the platform\'s process-listing command fails outright',
    async () => {
      // Arrange -- every invocation of the platform's process-listing command
      // (powershell.exe on win32, ps elsewhere) fails with a non-ENOENT error,
      // simulating a blocked/erroring tool rather than a missing one.
      setExecFile(((
        _file: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout?: string, stderr?: string) => void,
      ) => {
        cb(Object.assign(new Error('Access is denied'), { code: 1 }));
      }) as unknown as typeof cp.execFile);

      const ctx = createFakeContext();
      // A narrow, almost-certainly-empty port range keeps the port-scan
      // fallback (which still runs) fast and real-network-based, same as the
      // existing "no language-server process and nothing listening" test.
      const provider = createAntigravityQuotaProvider({ portRange: '49500-49501' }, ctx);

      // Act
      const snap = await provider.fetch();

      // Assert -- a real, backoff-arming error, never the calm "closed app" notice.
      assert.equal(snap.ok, false);
      if (!snap.ok) {
        assert.equal(snap.appNotRunning, undefined);
        assert.match(snap.error, /process listing failed/i);
      }
      // WARNING FIX: visible at `warn`, not `debug`, so a permanently
      // misdiagnosed environment problem doesn't stay silent by default.
      assert.ok(
        ctx.logs.some(l => l.level === 'warn' && /process discovery failed/i.test(l.message)),
        JSON.stringify(ctx.logs),
      );
    },
  );
});
