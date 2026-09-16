import './../../helpers/electron-stub';
import { describe, it } from 'node:test';
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
} from '../../../src/main/connectors/antigravity/quota';

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
