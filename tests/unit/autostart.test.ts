import './../helpers/electron-stub';
import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import {
  setUserDataPath,
  resetElectronStub,
  setAppIsPackaged,
  setAppPath,
  loginItemSettingsCalls,
} from '../helpers/electron-stub';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir';
import {
  buildDesktopEntry,
  escapeExecValue,
  linuxAutostartDir,
  linuxAutostartFile,
  buildExecCommand,
  applyAutoStart,
} from '../../src/main/autostart';

describe('autostart', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir('aioversight-autostart-');
    setUserDataPath(dir);
    resetElectronStub();
  });

  afterEach(() => {
    removeTempDir(dir);
  });

  describe('escapeExecValue', () => {
    it('returns simple commands without spaces unchanged', () => {
      // Arrange
      const command = '/usr/bin/aioversight';

      // Act
      const result = escapeExecValue(command);

      // Assert
      assert.equal(result, '/usr/bin/aioversight');
    });

    it('quotes a path containing spaces', () => {
      // Arrange
      const command = '/home/nicolas/apps/ai oversight/aioversight';

      // Act
      const result = escapeExecValue(command);

      // Assert
      assert.equal(result, '"/home/nicolas/apps/ai oversight/aioversight"');
    });

    it('escapes embedded double quotes inside a quoted value', () => {
      // Arrange
      const command = '/opt/My "App"/run';

      // Act
      const result = escapeExecValue(command);

      // Assert
      assert.equal(result, '"/opt/My \\"App\\"/run"');
    });
  });

  describe('buildDesktopEntry', () => {
    it('produces a freedesktop autostart entry with the expected sections and keys', () => {
      // Arrange
      const execCommand = '/usr/bin/aioversight';

      // Act
      const entry = buildDesktopEntry(execCommand);

      // Assert
      const lines = entry.trim().split('\n');
      assert.equal(lines[0], '[Desktop Entry]');
      assert.ok(lines.includes('Type=Application'));
      assert.ok(lines.includes('Name=AI Oversight'));
      assert.ok(lines.includes('Exec=/usr/bin/aioversight'));
      assert.ok(lines.includes('X-GNOME-Autostart-enabled=true'));
      assert.ok(lines.some(l => l.startsWith('Comment=')));
    });

    it('escapes an Exec value with a path containing spaces', () => {
      // Arrange
      const execCommand = '/home/nicolas/apps/ai oversight/aioversight';

      // Act
      const entry = buildDesktopEntry(execCommand);

      // Assert
      assert.ok(entry.includes('Exec="/home/nicolas/apps/ai oversight/aioversight"'));
    });
  });

  describe('buildExecCommand', () => {
    it('returns just the executable path when packaged', () => {
      // Arrange
      const execPath = 'C:\\Program Files\\AI Oversight\\AI Oversight.exe';
      const appPath = 'C:\\Program Files\\AI Oversight\\resources\\app';

      // Act
      const result = buildExecCommand(execPath, true, appPath);

      // Assert
      assert.equal(result, execPath);
    });

    it('appends the app path when in dev mode (unpackaged)', () => {
      // Arrange
      const execPath = '/usr/local/bin/electron';
      const appPath = '/home/nicolas/projects/aioversight';

      // Act
      const result = buildExecCommand(execPath, false, appPath);

      // Assert
      assert.equal(result, '/usr/local/bin/electron /home/nicolas/projects/aioversight');
    });
  });

  describe('linuxAutostartDir / linuxAutostartFile', () => {
    it('defaults to ~/.config/autostart when XDG_CONFIG_HOME is not set', () => {
      // Arrange
      const env: NodeJS.ProcessEnv = {};
      const home = '/home/nicolas';

      // Act
      const result = linuxAutostartDir(env, home);

      // Assert
      assert.equal(result, path.join('/home/nicolas', '.config', 'autostart'));
    });

    it('honors XDG_CONFIG_HOME when set', () => {
      // Arrange
      const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: '/home/nicolas/.myconfig' };
      const home = '/home/nicolas';

      // Act
      const result = linuxAutostartDir(env, home);

      // Assert
      assert.equal(result, path.join('/home/nicolas/.myconfig', 'autostart'));
    });

    it('linuxAutostartFile appends the desktop entry filename', () => {
      // Arrange
      const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: '/home/nicolas/.myconfig' };
      const home = '/home/nicolas';

      // Act
      const result = linuxAutostartFile(env, home);

      // Assert
      assert.equal(result, path.join('/home/nicolas/.myconfig', 'autostart', 'aioversight.desktop'));
    });
  });

  describe('applyAutoStart on macOS / Windows', () => {
    it('calls app.setLoginItemSettings with openAtLogin=true when packaged', () => {
      // Arrange
      setAppIsPackaged(true);

      // Act
      applyAutoStart(true, undefined, { platform: 'win32' });

      // Assert
      assert.equal(loginItemSettingsCalls.length, 1);
      assert.deepEqual(loginItemSettingsCalls[0], { openAtLogin: true });
    });

    it('calls app.setLoginItemSettings with openAtLogin=false when packaged', () => {
      // Arrange
      setAppIsPackaged(true);

      // Act
      applyAutoStart(false, undefined, { platform: 'darwin' });

      // Assert
      assert.equal(loginItemSettingsCalls.length, 1);
      assert.deepEqual(loginItemSettingsCalls[0], { openAtLogin: false });
    });

    it('passes execPath and resolved app path as args when unpackaged (dev mode)', () => {
      // Arrange
      setAppIsPackaged(false);
      setAppPath(dir);

      // Act
      applyAutoStart(true, undefined, { platform: 'win32' });

      // Assert
      assert.equal(loginItemSettingsCalls.length, 1);
      const call = loginItemSettingsCalls[0];
      assert.equal(call.openAtLogin, true);
      assert.equal(call.path, process.execPath);
      assert.deepEqual(call.args, [path.resolve(dir)]);
    });

    it('does not throw when app.setLoginItemSettings throws, and logs the failure', () => {
      // Arrange
      setAppIsPackaged(true);
      const logs: Array<{ level: string; message: string }> = [];
      const log = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => {
        logs.push({ level, message });
      };

      // Monkeypatch setLoginItemSettings to throw for this test only.
      const electron = require('electron') as { app: { setLoginItemSettings: () => void } };
      const original = electron.app.setLoginItemSettings;
      electron.app.setLoginItemSettings = () => {
        throw new Error('boom');
      };

      try {
        // Act & Assert (must not throw)
        assert.doesNotThrow(() => applyAutoStart(true, log, { platform: 'win32' }));
        assert.equal(logs.length, 1);
        assert.equal(logs[0].level, 'error');
      } finally {
        electron.app.setLoginItemSettings = original;
      }
    });
  });

  describe('applyAutoStart on Linux', () => {
    it('writes a .desktop file when enabled', () => {
      // Arrange
      setAppIsPackaged(true);
      const file = path.join(dir, 'autostart', 'aioversight.desktop');

      // Act
      applyAutoStart(true, undefined, { platform: 'linux', linuxAutostartFile: file });

      // Assert
      assert.ok(fs.existsSync(file));
      const content = fs.readFileSync(file, 'utf8');
      assert.ok(content.includes('[Desktop Entry]'));
      assert.ok(content.includes('Name=AI Oversight'));
      assert.ok(content.includes(`Exec=${escapeExecValue(process.execPath)}`));
    });

    it('removes the .desktop file when disabled', () => {
      // Arrange
      setAppIsPackaged(true);
      const file = path.join(dir, 'autostart', 'aioversight.desktop');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'placeholder');

      // Act
      applyAutoStart(false, undefined, { platform: 'linux', linuxAutostartFile: file });

      // Assert
      assert.equal(fs.existsSync(file), false);
    });

    it('removing a non-existent .desktop file is a no-op (does not throw)', () => {
      // Arrange
      setAppIsPackaged(true);
      const file = path.join(dir, 'autostart', 'aioversight.desktop');

      // Act & Assert
      assert.doesNotThrow(() =>
        applyAutoStart(false, undefined, { platform: 'linux', linuxAutostartFile: file }),
      );
      assert.equal(fs.existsSync(file), false);
    });

    it('uses execPath + resolved app path as Exec when unpackaged (dev mode)', () => {
      // Arrange
      setAppIsPackaged(false);
      setAppPath(dir);
      const file = path.join(dir, 'autostart', 'aioversight.desktop');

      // Act
      applyAutoStart(true, undefined, { platform: 'linux', linuxAutostartFile: file });

      // Assert
      const content = fs.readFileSync(file, 'utf8');
      const expectedExec = `${process.execPath} ${path.resolve(dir)}`;
      assert.ok(content.includes(`Exec=${escapeExecValue(expectedExec)}`));
    });
  });
});
