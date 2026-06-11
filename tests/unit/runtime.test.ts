import './../helpers/electron-stub';
import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import { resetElectronStub, setUserDataPath } from '../helpers/electron-stub';
import { makeTempDir } from '../helpers/temp-dir';
import { ConnectorRuntime } from '../../src/main/connectors/runtime';
import { SecretStore } from '../../src/main/connectors/secret-store';
import { findConnector } from '../../src/main/connectors/registry';
import { AgentEvent } from '../../src/main/connectors/types';

describe('ConnectorRuntime', () => {
  let runtime: ConnectorRuntime;
  let secrets: SecretStore;

  beforeEach(() => {
    setUserDataPath(makeTempDir('aioversight-runtime-'));
    resetElectronStub();
    secrets = new SecretStore();
    runtime = new ConnectorRuntime(secrets);
  });

  describe('mergeDefaults', () => {
    it('fills in schema defaults for fields missing from the user config', () => {
      // Arrange
      const def = findConnector('cursor')!;

      // Act
      const merged = runtime.mergeDefaults(def, {});

      // Assert
      assert.equal(merged.idleSeconds, 8);
      assert.deepEqual(merged.paths, [
        '~/.cursor/projects/**/agent-transcripts/**/*.jsonl',
        '~/AppData/Roaming/Cursor/User/projects/**/agent-transcripts/**/*.jsonl',
      ]);
      assert.equal(merged.stateDbPath, '');
    });

    it('preserves user-provided values over schema defaults', () => {
      // Arrange
      const def = findConnector('cursor')!;
      const userConfig = { idleSeconds: 15, paths: ['~/custom/**/*.jsonl'] };

      // Act
      const merged = runtime.mergeDefaults(def, userConfig);

      // Assert
      assert.equal(merged.idleSeconds, 15);
      assert.deepEqual(merged.paths, ['~/custom/**/*.jsonl']);
    });

    it('treats an empty paths array as "unset" and falls back to the schema default', () => {
      // Arrange
      const def = findConnector('cursor')!;
      const userConfig = { paths: [] };

      // Act
      const merged = runtime.mergeDefaults(def, userConfig);

      // Assert
      assert.deepEqual(merged.paths, [
        '~/.cursor/projects/**/agent-transcripts/**/*.jsonl',
        '~/AppData/Roaming/Cursor/User/projects/**/agent-transcripts/**/*.jsonl',
      ]);
    });

    it('ignores fields not declared in configSchema and never includes secret fields', () => {
      // Arrange
      const def = findConnector('anthropic')!;
      const userConfig = { adminApiKey: 'sk-ant-admin01-should-not-appear', unknownField: 'ignored' };

      // Act
      const merged = runtime.mergeDefaults(def, userConfig);

      // Assert
      assert.equal('adminApiKey' in merged, false);
      assert.equal('unknownField' in merged, false);
    });
  });

  describe('contextFor', () => {
    it('resolvePath expands "~" to the home directory', () => {
      // Arrange
      const def = findConnector('cursor')!;
      const ctx = runtime.contextFor(def);

      // Act
      const resolved = ctx.resolvePath('~/.cursor/projects');

      // Assert
      assert.equal(resolved, path.join(os.homedir(), '.cursor', 'projects'));
    });

    it('resolvePath expands $HOME', () => {
      // Arrange
      const def = findConnector('cursor')!;
      const ctx = runtime.contextFor(def);

      // Act
      const resolved = ctx.resolvePath('$HOME/.cursor/projects');

      // Assert
      assert.equal(resolved, `${os.homedir()}/.cursor/projects`);
      assert.ok(!resolved.includes('$HOME'));
    });

    it('resolvePath expands %USERPROFILE%', () => {
      // Arrange
      const def = findConnector('cursor')!;
      const ctx = runtime.contextFor(def);

      // Act
      const resolved = ctx.resolvePath('%USERPROFILE%\\AppData\\Roaming\\Cursor');

      // Assert
      assert.ok(resolved.startsWith(os.homedir()));
      assert.ok(!resolved.toUpperCase().includes('%USERPROFILE%'));
    });

    it('resolvePath expands %APPDATA% and %LOCALAPPDATA%', () => {
      // Arrange
      const def = findConnector('cursor')!;
      const ctx = runtime.contextFor(def);
      const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

      // Act
      const resolvedAppData = ctx.resolvePath('%APPDATA%\\Claude\\projects');
      const resolvedLocalAppData = ctx.resolvePath('%LOCALAPPDATA%\\codex\\sessions');

      // Assert
      assert.ok(resolvedAppData.startsWith(appData));
      assert.ok(resolvedLocalAppData.startsWith(localAppData));
    });

    it('resolvePath passes through absolute paths unchanged', () => {
      // Arrange
      const def = findConnector('cursor')!;
      const ctx = runtime.contextFor(def);
      const absolute = 'C:\\Users\\dev\\transcripts\\session.jsonl';

      // Act
      const resolved = ctx.resolvePath(absolute);

      // Assert
      assert.equal(resolved, absolute);
    });

    it('context.emit reaches runtime "event" listeners with detectorId and detectedAt filled in', () => {
      // Arrange
      const def = findConnector('cursor')!;
      const ctx = runtime.contextFor(def);
      const events: AgentEvent[] = [];
      runtime.onEvent(e => events.push(e));

      // Act
      ctx.emit({
        sessionId: 'cursor:abcd1234',
        agent: 'Cursor',
        kind: 'finished',
        message: 'Session abcd1234 finished after 12s of quiet.',
      });

      // Assert
      assert.equal(events.length, 1);
      assert.equal(events[0].detectorId, 'cursor');
      assert.equal(events[0].kind, 'finished');
      assert.ok(typeof events[0].detectedAt === 'number');
    });

    it('context.emit defaults kind to "waiting" for back-compat', () => {
      // Arrange
      const def = findConnector('webhook')!;
      const ctx = runtime.contextFor(def);
      const events: AgentEvent[] = [];
      runtime.onEvent(e => events.push(e));

      // Act
      ctx.emit({
        sessionId: 'webhook:1234',
        agent: 'External agent',
        message: 'Allow run?',
      } as never); // kind intentionally omitted

      // Assert
      assert.equal(events[0].kind, 'waiting');
    });

    it('secret/setSecret are namespaced per connector via SecretStore.qualify', () => {
      // Arrange
      const def = findConnector('anthropic')!;
      const ctx = runtime.contextFor(def);

      // Act
      ctx.setSecret('adminApiKey', 'sk-ant-admin01-realistic-key');
      const fromCtx = ctx.secret('adminApiKey');
      const fromStoreDirect = secrets.get(SecretStore.qualify('anthropic', 'adminApiKey'));

      // Assert
      assert.equal(fromCtx, 'sk-ant-admin01-realistic-key');
      assert.equal(fromStoreDirect, 'sk-ant-admin01-realistic-key');
    });
  });

  describe('metadata', () => {
    it('reflects existing secret keys via setSecretKeys', () => {
      // Arrange
      secrets.set(SecretStore.qualify('anthropic', 'adminApiKey'), 'sk-ant-admin01-realistic-key');

      // Act
      const meta = runtime.metadata();
      const anthropic = meta.find(m => m.id === 'anthropic')!;

      // Assert
      assert.deepEqual(anthropic.setSecretKeys, ['adminApiKey']);
    });

    it('does not list secret keys that have not been set', () => {
      // Arrange / Act
      const meta = runtime.metadata();
      const openai = meta.find(m => m.id === 'openai')!;

      // Assert
      assert.deepEqual(openai.setSecretKeys, []);
    });
  });

  describe('log ring buffer', () => {
    it('caps recentLogs() at the internal MAX_LOGS limit', () => {
      // Arrange
      const limit = 200; // ConnectorRuntime.MAX_LOGS

      // Act
      for (let i = 0; i < limit + 25; i++) {
        runtime.log('info', `log entry ${i}`);
      }
      const logs = runtime.recentLogs();

      // Assert
      assert.equal(logs.length, limit);
      // The oldest entries were dropped; the most recent survives.
      assert.equal(logs[logs.length - 1].message, `log entry ${limit + 24}`);
      assert.equal(logs[0].message, `log entry 25`);
    });

    it('emits a "log" event for each pushed log entry', () => {
      // Arrange
      const seen: string[] = [];
      runtime.onLog(entry => seen.push(entry.message));

      // Act
      runtime.log('warn', 'detector failed to start', { err: 'ENOENT' });

      // Assert
      assert.deepEqual(seen, ['detector failed to start']);
    });
  });
});
