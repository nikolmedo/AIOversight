import './../helpers/electron-stub';
import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'fs';
import * as path from 'path';
import { setUserDataPath, resetElectronStub } from '../helpers/electron-stub';
import { makeTempDir, removeTempDir } from '../helpers/temp-dir';
import { SettingsStore } from '../../src/main/settings-store';
import {
  UpdateService,
  UpdateServiceDeps,
  UpdateState,
  UpdaterLike,
  UpdateEnvironment,
  assetMatchesTarget,
  compareVersions,
  computeUpdateCapability,
  releaseUrlFor,
} from '../../src/main/updater';

/** Stand-in for electron-updater's `autoUpdater`, driven by the test. */
class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  logger: unknown = null;
  checkCalls = 0;
  downloadCalls = 0;
  installCalls: Array<[boolean | undefined, boolean | undefined]> = [];
  /** What the next `checkForUpdates()` does. Default: no update. */
  onCheck: (u: FakeUpdater) => Promise<unknown | null> = async u => {
    u.emit('update-not-available', { version: '1.0.0' });
    return { updateInfo: { version: '1.0.0' } };
  };
  onDownload: (u: FakeUpdater) => Promise<unknown> = async u => {
    u.emit('download-progress', { percent: 50.4 });
    u.emit('update-downloaded', { version: '1.1.0' });
    return [];
  };

  checkForUpdates(): Promise<unknown | null> {
    this.checkCalls++;
    return this.onCheck(this);
  }
  downloadUpdate(): Promise<unknown> {
    this.downloadCalls++;
    return this.onDownload(this);
  }
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installCalls.push([isSilent, isForceRunAfter]);
  }
}

const availableCheck = (version: string) => async (u: FakeUpdater) => {
  u.emit('update-available', { version });
  return { updateInfo: { version } };
};

const boomInstall = () => {
  throw new Error('spawn ENOENT');
};

const NSIS: UpdateEnvironment = { platform: 'win32', env: {}, isPackaged: true };

interface Harness {
  service: UpdateService;
  updater: FakeUpdater;
  notified: UpdateState[];
  opened: string[];
  fetched: string[];
  lastNotified: { value: string };
  states: UpdateState[];
}

function makeService(
  environment: UpdateEnvironment = NSIS,
  overrides: Partial<UpdateServiceDeps> = {},
): Harness {
  const updater = new FakeUpdater();
  const notified: UpdateState[] = [];
  const opened: string[] = [];
  const fetched: string[] = [];
  const lastNotified = { value: '' };
  const service = new UpdateService({
    createUpdater: () => updater,
    environment,
    currentVersion: '1.0.0',
    fetchJson: async url => {
      fetched.push(url);
      throw new Error('fetchJson not stubbed');
    },
    notify: s => {
      notified.push(s);
    },
    openExternal: url => opened.push(url),
    isAutoCheckEnabled: () => true,
    getLastNotifiedVersion: () => lastNotified.value,
    setLastNotifiedVersion: v => {
      lastNotified.value = v;
    },
    now: () => 1_700_000_000_000,
    ...overrides,
  });
  const states: UpdateState[] = [];
  service.onChange(s => states.push(s));
  return { service, updater, notified, opened, fetched, lastNotified, states };
}

describe('computeUpdateCapability()', () => {
  const cases: Array<[string, UpdateEnvironment, { enabled: boolean; canInstall: boolean; target: string }]> = [
    ['Windows NSIS', { platform: 'win32', env: {}, isPackaged: true }, { enabled: true, canInstall: true, target: 'nsis' }],
    [
      'Windows portable',
      { platform: 'win32', env: { PORTABLE_EXECUTABLE_DIR: 'C:\\Apps' }, isPackaged: true },
      { enabled: true, canInstall: false, target: 'portable' },
    ],
    [
      'Linux AppImage',
      { platform: 'linux', env: { APPIMAGE: '/home/u/AIOversight.AppImage' }, isPackaged: true },
      { enabled: true, canInstall: true, target: 'appimage' },
    ],
    [
      'Linux deb',
      { platform: 'linux', env: {}, isPackaged: true, packageType: 'deb\n' },
      { enabled: true, canInstall: false, target: 'deb' },
    ],
    ['Linux tar.gz', { platform: 'linux', env: {}, isPackaged: true }, { enabled: true, canInstall: false, target: 'archive' }],
    ['macOS (unsigned)', { platform: 'darwin', env: {}, isPackaged: true }, { enabled: true, canInstall: false, target: 'mac' }],
    [
      'dev (not packaged)',
      { platform: 'win32', env: {}, isPackaged: false },
      { enabled: false, canInstall: false, target: 'dev' },
    ],
    [
      'dev AppImage env but not packaged',
      { platform: 'linux', env: { APPIMAGE: '/x' }, isPackaged: false },
      { enabled: false, canInstall: false, target: 'dev' },
    ],
  ];
  for (const [name, env, expected] of cases) {
    it(name, () => {
      assert.deepEqual(computeUpdateCapability(env), expected);
    });
  }
});

describe('assetMatchesTarget()', () => {
  it('keeps each package format to its own assets', () => {
    const assets = [
      'aioversight-1.1.0-setup-x64.exe',
      'aioversight-1.1.0-portable-x64.exe',
      'aioversight-1.1.0-linux-x86_64.AppImage',
      'aioversight-1.1.0-linux-amd64.deb',
      'aioversight-1.1.0-linux-x64.tar.gz',
      'aioversight-1.1.0-mac-arm64.dmg',
      'latest.yml',
    ];
    const pick = (t: Parameters<typeof assetMatchesTarget>[1]) => assets.filter(a => assetMatchesTarget(a, t));
    assert.deepEqual(pick('nsis'), ['aioversight-1.1.0-setup-x64.exe']);
    assert.deepEqual(pick('portable'), ['aioversight-1.1.0-portable-x64.exe']);
    assert.deepEqual(pick('appimage'), ['aioversight-1.1.0-linux-x86_64.AppImage']);
    assert.deepEqual(pick('deb'), ['aioversight-1.1.0-linux-amd64.deb']);
    assert.deepEqual(pick('archive'), ['aioversight-1.1.0-linux-x64.tar.gz']);
    assert.deepEqual(pick('mac'), ['aioversight-1.1.0-mac-arm64.dmg']);
    assert.deepEqual(pick('dev'), []);
  });
});

describe('compareVersions()', () => {
  it('orders numeric parts, ignores a v prefix and ranks pre-releases lower', () => {
    assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
    assert.equal(compareVersions('v1.2.0', '1.2.0'), 0);
    assert.ok(compareVersions('1.2.0-beta.1', '1.2.0') < 0);
    assert.ok(compareVersions('0.3.0', '0.4.0') < 0);
  });
});

describe('UpdateService', () => {
  it('is disabled in dev and never creates the updater', async () => {
    let created = false;
    const { service } = makeService(
      { platform: 'win32', env: {}, isPackaged: false },
      {
        createUpdater: () => {
          created = true;
          return new FakeUpdater();
        },
      },
    );
    assert.equal(created, false);
    assert.equal(service.getState().status, 'disabled');
    const after = await service.check();
    assert.equal(after.status, 'disabled');
    service.start();
    service.stop();
  });

  it('configures electron-updater for manual downloads', () => {
    const { updater } = makeService();
    assert.equal(updater.autoDownload, false);
    assert.equal(updater.autoInstallOnAppQuit, true);
    assert.ok(updater.listenerCount('error') > 0, 'an error listener must always be attached');
  });

  it('goes idle -> checking -> not-available', async () => {
    const { service, states, notified } = makeService();
    assert.equal(service.getState().status, 'idle');
    const result = await service.check();
    assert.deepEqual(
      states.map(s => s.status),
      ['checking', 'not-available'],
    );
    assert.equal(result.lastChecked, 1_700_000_000_000);
    assert.equal(notified.length, 0);
  });

  it('goes checking -> available -> downloading -> downloaded -> install on NSIS', async () => {
    let beforeInstallCalls = 0;
    const h = makeService(NSIS, { beforeInstall: () => beforeInstallCalls++ });
    h.updater.onCheck = availableCheck('1.1.0');

    const available = await h.service.check();
    assert.equal(available.status, 'available');
    assert.equal(available.errorPhase, undefined);
    assert.equal(available.latestVersion, '1.1.0');
    assert.equal(available.canInstall, true);
    assert.equal(available.releaseUrl, releaseUrlFor('1.1.0'));
    assert.equal(available.releaseUrl, 'https://github.com/nikolmedo/AIOversight/releases/tag/v1.1.0');

    const downloaded = await h.service.download();
    assert.equal(downloaded.status, 'downloaded');
    assert.ok(h.states.some(s => s.status === 'downloading' && s.progress === 50));

    h.service.install();
    assert.equal(beforeInstallCalls, 1);
    assert.deepEqual(h.updater.installCalls, [[true, true]]);
  });

  it('does not download or install on notify-only targets', async () => {
    const h = makeService({ platform: 'darwin', env: {}, isPackaged: true });
    h.updater.onCheck = availableCheck('1.1.0');
    const state = await h.service.check();
    assert.equal(state.status, 'available');
    assert.equal(state.canInstall, false);
    await h.service.download();
    h.service.install();
    assert.equal(h.updater.downloadCalls, 0);
    assert.equal(h.updater.installCalls.length, 0);
    h.service.openRelease();
    assert.deepEqual(h.opened, ['https://github.com/nikolmedo/AIOversight/releases/tag/v1.1.0']);
  });

  it('ignores install() until the update is downloaded', async () => {
    const h = makeService();
    h.updater.onCheck = availableCheck('1.1.0');
    await h.service.check();
    h.service.install();
    assert.equal(h.updater.installCalls.length, 0);
  });

  it('notifies once per version, across checks and restarts', async () => {
    const h = makeService();
    h.updater.onCheck = availableCheck('1.1.0');
    await h.service.check();
    await h.service.check();
    assert.equal(h.notified.length, 1);
    assert.equal(h.lastNotified.value, '1.1.0');

    // A new process with the persisted version does not notify again...
    const restarted = makeService(NSIS, {});
    restarted.lastNotified.value = '1.1.0';
    restarted.updater.onCheck = availableCheck('1.1.0');
    await restarted.service.check();
    assert.equal(restarted.notified.length, 0);

    // ...but a newer version does.
    restarted.updater.onCheck = availableCheck('1.2.0');
    await restarted.service.check();
    assert.equal(restarted.notified.length, 1);
    assert.equal(restarted.lastNotified.value, '1.2.0');
  });

  it('turns check failures into an error state without notifying or throwing', async () => {
    const h = makeService();
    h.updater.onCheck = async u => {
      const err = new Error('HttpError: 404 latest.yml');
      u.emit('error', err);
      throw err;
    };
    const state = await h.service.check();
    assert.equal(state.status, 'error');
    assert.equal(state.errorPhase, 'check');
    assert.match(state.error ?? '', /404/);
    assert.equal(h.notified.length, 0);
    assert.equal(h.states.filter(s => s.status === 'error').length, 1, 'one failure, one transition');
  });

  it('keeps a known update visible when a later check or download fails', async () => {
    const h = makeService();
    h.updater.onCheck = availableCheck('1.1.0');
    await h.service.check();

    h.updater.onCheck = async () => {
      throw new Error('offline');
    };
    const afterCheck = await h.service.check();
    assert.equal(afterCheck.status, 'available');
    assert.equal(afterCheck.error, 'offline');
    assert.equal(afterCheck.errorPhase, 'check');

    h.updater.onDownload = async u => {
      const err = new Error('sha512 checksum mismatch');
      u.emit('error', err);
      throw err;
    };
    const afterDownload = await h.service.download();
    assert.equal(afterDownload.status, 'available');
    assert.equal(afterDownload.errorPhase, 'download');
    assert.match(afterDownload.error ?? '', /sha512/);
  });

  it('shares one in-flight check between concurrent callers', async () => {
    const h = makeService();
    let release!: () => void;
    h.updater.onCheck = u =>
      new Promise(resolve => {
        release = () => {
          u.emit('update-not-available', { version: '1.0.0' });
          resolve({});
        };
      });
    const a = h.service.check();
    const b = h.service.check();
    release();
    await Promise.all([a, b]);
    assert.equal(h.updater.checkCalls, 1);
  });

  it('falls back to the GitHub API when electron-updater is inactive (Linux tar.gz)', async () => {
    const h = makeService(
      { platform: 'linux', env: {}, isPackaged: true },
      {
        fetchJson: async () => ({
          tag_name: 'v1.1.0',
          assets: [{ name: 'aioversight-1.1.0-linux-x64.tar.gz' }, { name: 'latest-linux.yml' }],
        }),
      },
    );
    h.updater.onCheck = async () => null;
    const state = await h.service.check();
    assert.equal(state.status, 'available');
    assert.equal(state.latestVersion, '1.1.0');
    assert.equal(state.canInstall, false);
    assert.equal(h.notified.length, 1);
  });

  it('GitHub API fallback ignores releases without an asset for this package format', async () => {
    const h = makeService(
      { platform: 'linux', env: {}, isPackaged: true },
      {
        fetchJson: async () => ({
          tag_name: 'v1.1.0',
          assets: [{ name: 'aioversight-1.1.0-setup-x64.exe' }],
        }),
      },
    );
    h.updater.onCheck = async () => null;
    const state = await h.service.check();
    assert.equal(state.status, 'not-available');
  });

  it('ignores an update-available event for a version that is not newer', async () => {
    const h = makeService();
    h.updater.onCheck = availableCheck('1.0.0');
    const state = await h.service.check();
    assert.equal(state.status, 'not-available');
    assert.equal(h.notified.length, 0);
  });

  it('lets a failing updater construction throw, for index.ts to contain', () => {
    // index.ts catches this and falls back to a disabled service.
    const boom = () => {
      throw new Error('ERR_UPDATER_INVALID_VERSION');
    };
    assert.throws(() => makeService(NSIS, { createUpdater: boom }), /ERR_UPDATER_INVALID_VERSION/);
  });

  it('keeps a failed install recoverable instead of stranding the app', async () => {
    const h = makeService();
    h.updater.onCheck = availableCheck('1.1.0');
    await h.service.check();
    await h.service.download();

    // A failed install is reported through 'error' and does NOT quit.
    h.updater.quitAndInstall = () => h.updater.emit('error', new Error('AppImage move failed')) as unknown as void;
    h.service.install();
    assert.deepEqual(
      [h.service.getState().status, h.service.getState().errorPhase, h.service.getState().error],
      ['downloaded', 'install', 'AppImage move failed'],
    );

    // A throwing quitAndInstall lands in the same state.
    h.updater.quitAndInstall = boomInstall;
    h.service.install();
    assert.equal(h.service.getState().status, 'downloaded');
    assert.match(h.service.getState().error ?? '', /spawn ENOENT/);
  });

  it('does not mark a version as notified when the notification was suppressed', async () => {
    const h = makeService(NSIS, { notify: () => false });
    h.updater.onCheck = availableCheck('1.1.0');
    await h.service.check();
    assert.equal(h.lastNotified.value, '', 'a suppressed toast must not burn the version');

    // The same version still notifies once notifications are back on.
    const shown = makeService();
    shown.updater.onCheck = availableCheck('1.1.0');
    await shown.service.check();
    assert.deepEqual([shown.notified.length, shown.lastNotified.value], [1, '1.1.0']);
  });

  it('dismiss() hides the banner for that version only', async () => {
    const h = makeService();
    h.updater.onCheck = availableCheck('1.1.0');
    await h.service.check();
    assert.equal(h.service.dismiss().dismissed, true);
    h.updater.onCheck = availableCheck('1.2.0');
    const next = await h.service.check();
    assert.equal(next.dismissed, false);
  });
});

describe('SettingsStore update fields', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir('aioversight-updater-settings-');
    setUserDataPath(dir);
    resetElectronStub();
  });

  afterEach(() => {
    removeTempDir(dir);
  });

  const defaults = { enabled: {}, config: {}, quotaDefaultEnabled: {} };

  it('defaults checkForUpdates to true with no last-notified version', () => {
    const s = new SettingsStore(defaults).get();
    assert.equal(s.checkForUpdates, true);
    assert.equal(s.lastNotifiedUpdateVersion, '');
  });

  it('persists both fields and rejects malformed values on load', () => {
    const store = new SettingsStore(defaults);
    store.update({ checkForUpdates: false, lastNotifiedUpdateVersion: '1.1.0' });
    assert.equal(new SettingsStore(defaults).get().checkForUpdates, false);
    assert.equal(new SettingsStore(defaults).get().lastNotifiedUpdateVersion, '1.1.0');

    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ checkForUpdates: 'no', lastNotifiedUpdateVersion: 7 }),
    );
    const reloaded = new SettingsStore(defaults).get();
    assert.equal(reloaded.checkForUpdates, true);
    assert.equal(reloaded.lastNotifiedUpdateVersion, '');
  });
});
