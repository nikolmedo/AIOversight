import * as path from 'path';
import { app, BrowserWindow, ipcMain, Tray, Notification, nativeTheme, globalShortcut } from 'electron';
import { SettingsStore, ConnectorDefaults } from './settings-store';
import { applyAutoStart } from './autostart';
import { Notifier } from './notifier';
import { createTray, TrayHandle, formatTrayLineFor } from './tray';
import { createTrayPopup, TrayPopupHandle } from './tray-popup';
import { ConnectorRuntime, ALL_CONNECTORS } from './connectors/runtime';
import { QuotaService } from './connectors/quota-service';
import { SecretStore } from './connectors/secret-store';
import { QuotaSnapshot, Connector, ConnectorEnabled, BucketPref } from './connectors/types';

let tray: Tray | null = null;
let trayHandle: TrayHandle | null = null;
let trayPopup: TrayPopupHandle | null = null;
let settingsWindow: BrowserWindow | null = null;
let runtime: ConnectorRuntime | null = null;
let quotaService: QuotaService | null = null;
let secretStore: SecretStore | null = null;
let notifier: Notifier | null = null;
let settings: SettingsStore | null = null;
let paused = false;
/** Accelerator currently registered via `globalShortcut`, or `null` when none
 * is. Tracked so `applyPopupShortcut` can unregister the old one before
 * registering a new one — `globalShortcut.unregisterAll()` would also nuke
 * any accelerator another part of the app might register in the future. */
let registeredPopupShortcut: string | null = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => openSettings());
}

if (process.platform === 'darwin' && app.dock) {
  app.dock.hide();
}

if (process.platform === 'win32') {
  app.setAppUserModelId('com.agentwatcher.app');
}

function buildConnectorDefaults(connectors: Connector[]): ConnectorDefaults {
  const enabled: Record<string, ConnectorEnabled> = {};
  const config: Record<string, Record<string, unknown>> = {};
  const quotaDefaultEnabled: Record<string, boolean> = {};
  for (const def of connectors) {
    enabled[def.id] = {
      notifications: !!def.detector && def.enabledByDefault,
      quota: !!def.quota && (def.quotaEnabledByDefault ?? false),
    };
    config[def.id] = {};
    for (const f of def.configSchema) {
      if (f.type === 'secret') continue;
      config[def.id][f.key] = f.default;
    }
    quotaDefaultEnabled[def.id] = def.quotaEnabledByDefault ?? false;
  }
  return { enabled, config, quotaDefaultEnabled };
}

/**
 * Registers (or clears) the global accelerator that toggles the tray popup.
 * Never throws — `globalShortcut.register` can both return `false` (already
 * taken by another application) and, per its docs, throw on a malformed
 * accelerator string; both are surfaced as `{ ok: false, reason }` so the
 * Settings UI can show a concrete failure instead of silently no-op'ing.
 */
function applyPopupShortcut(accelerator: string | undefined): { ok: boolean; reason?: string } {
  if (registeredPopupShortcut) {
    try {
      globalShortcut.unregister(registeredPopupShortcut);
    } catch {
      /* best-effort */
    }
    registeredPopupShortcut = null;
  }
  const trimmed = (accelerator ?? '').trim();
  if (!trimmed) return { ok: true };
  try {
    const ok = globalShortcut.register(trimmed, () => {
      if (tray && trayPopup) trayPopup.toggle(tray);
    });
    if (!ok) return { ok: false, reason: 'That shortcut is already in use by another application.' };
    registeredPopupShortcut = trimmed;
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
}

app.whenReady().then(async () => {
  settings = new SettingsStore(buildConnectorDefaults(ALL_CONNECTORS));
  secretStore = new SecretStore();
  runtime = new ConnectorRuntime(secretStore);
  quotaService = new QuotaService(runtime);
  notifier = new Notifier(
    settings,
    path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    (lvl, msg, meta) => runtime!.log(lvl, msg, meta),
  );

  runtime.onEvent(event => {
    if (paused) {
      runtime!.log('debug', '[main] event dropped (paused)', { sessionId: event.sessionId });
      return;
    }
    notifier!.handle(event);
    settingsWindow?.webContents.send('event', event);
  });
  runtime.onLog(entry => {
    settingsWindow?.webContents.send('log', entry);
  });

  quotaService.onUpdate((id, snap) => {
    settingsWindow?.webContents.send('quota:update', { id, snapshot: snap });
    trayPopup?.sendQuota(quotaService!.state());
    refreshTrayQuotaSummary();
  });

  await runtime.applyConfig(settings.get().connectors);
  void quotaService.applyConfig(
    settings.get().connectors,
    settings.get().quotaPollMinutes,
  );

  applyAutoStart(settings.get().launchAtLogin, (lvl, msg, meta) => runtime!.log(lvl, msg, meta));

  nativeTheme.themeSource = settings.get().theme ?? 'system';

  trayHandle = createTray({
    openSettings,
    togglePopup: () => {
      if (tray && trayPopup) trayPopup.toggle(tray);
    },
    togglePause: () => {
      paused = !paused;
      settingsWindow?.webContents.send('paused', paused);
    },
    isPaused: () => paused,
    testNotification: () => {
      sendTestNotification();
    },
    quit: () => {
      app.quit();
    },
  });
  tray = trayHandle.tray;

  trayPopup = createTrayPopup(
    {
      openSettings,
      getQuotas: () => quotaService!.state(),
      getConnectors: () => runtime!.metadata(),
    },
    !!settings.get().transparentPopup,
  );

  // A previously-saved shortcut can fail to re-register at startup (another
  // app claimed the accelerator since last run) with zero indication
  // anywhere otherwise — settings.json and the Settings UI would both still
  // show it as configured while nothing is actually registered. Log it and
  // clear the persisted value so the UI doesn't lie about it being active.
  const savedPopupShortcut = settings.get().popupShortcut;
  const startupShortcutResult = applyPopupShortcut(savedPopupShortcut);
  if (!startupShortcutResult.ok && savedPopupShortcut) {
    runtime.log('warn', '[main] saved tray-popup shortcut failed to register at startup — clearing it', {
      shortcut: savedPopupShortcut,
      reason: startupShortcutResult.reason,
    });
    settings.update({ popupShortcut: '' });
  }

  registerIpc();
  refreshTrayQuotaSummary();

  // Surface a one-time onboarding notification on first launch so the user
  // knows the app is alive (it has no dock icon by default).
  if (settings.get().recentEvents.length === 0 && Notification.isSupported()) {
    new Notification({
      title: 'AI Oversight is running',
      body: 'Look for the bell icon in your menu bar / system tray.',
    }).show();
  }
});

app.on('window-all-closed', () => {
  // Tray app — keep running.
});

app.on('before-quit', async () => {
  globalShortcut.unregisterAll();
  quotaService?.destroy();
  trayPopup?.destroy();
  await runtime?.stopAllDetectors();
});

function openSettings(): void {
  trayPopup?.hide();
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 880,
    height: 680,
    minWidth: 720,
    minHeight: 480,
    title: 'AI Oversight',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'settings.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  settingsWindow.once('ready-to-show', () => settingsWindow!.show());
  settingsWindow.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

function registerIpc(): void {
  ipcMain.handle('settings:get', () => ({
    connectors: runtime!.metadata(),
    settings: settings!.get(),
    paused,
    settingsPath: settings!.filePath(),
    quotas: quotaService!.state(),
    platform: process.platform,
  }));

  ipcMain.handle(
    'connectors:setEnabled',
    async (_e, id: string, enabled: { notifications?: boolean; quota?: boolean }) => {
      settings!.setConnectorEnabled(id, enabled);
      await runtime!.applyConfig(settings!.get().connectors);
      await quotaService!.applyConfig(
        settings!.get().connectors,
        settings!.get().quotaPollMinutes,
      );
      refreshTrayQuotaSummary();
      return settings!.get();
    },
  );

  ipcMain.handle(
    'connectors:setConfig',
    async (_e, id: string, config: Record<string, unknown>) => {
      settings!.setConnectorConfig(id, config);
      await runtime!.applyConfig(settings!.get().connectors);
      await quotaService!.applyConfig(
        settings!.get().connectors,
        settings!.get().quotaPollMinutes,
      );
      return settings!.get();
    },
  );

  ipcMain.handle(
    'connectors:setSecret',
    async (_e, id: string, key: string, value: string | null) => {
      const qualified = SecretStore.qualify(id, key);
      if (value && value.length > 0) {
        secretStore!.set(qualified, value);
      } else {
        secretStore!.delete(qualified);
      }
      // Recreate the quota provider so it picks up the new secret.
      await quotaService!.applyConfig(
        settings!.get().connectors,
        settings!.get().quotaPollMinutes,
      );
      return runtime!.metadata();
    },
  );

  ipcMain.handle(
    'connectors:setPollOverride',
    async (_e, id: string, minutes: number | null) => {
      settings!.setConnectorPollOverride(id, minutes);
      await quotaService!.applyConfig(
        settings!.get().connectors,
        settings!.get().quotaPollMinutes,
      );
      return settings!.get();
    },
  );

  ipcMain.handle(
    'connectors:setBucketPref',
    (_e, id: string, bucketId: string, patch: Partial<BucketPref>) => {
      settings!.setBucketPref(id, bucketId, patch);
      // Starring/unstarring a bucket changes what `formatTrayLineFor` shows —
      // without this the menu bar / tray tooltip line only catches up on the
      // next poll (or never, when polling is manual).
      refreshTrayQuotaSummary();
      return settings!.get();
    },
  );

  ipcMain.handle('settings:update', async (_e, patch: Record<string, unknown>) => {
    const next = settings!.update(patch);
    if ('quotaPollMinutes' in patch || 'showQuotaInTray' in patch) {
      await quotaService!.applyConfig(next.connectors, next.quotaPollMinutes);
      refreshTrayQuotaSummary();
    }
    if ('launchAtLogin' in patch) {
      applyAutoStart(next.launchAtLogin, (lvl, msg, meta) => runtime!.log(lvl, msg, meta));
    }
    if ('theme' in patch) {
      nativeTheme.themeSource = next.theme ?? 'system';
    }
    if ('transparentPopup' in patch) {
      trayPopup?.setTransparent(!!next.transparentPopup);
    }
    return next;
  });

  // Separate from `settings:update` so a taken-accelerator failure is
  // attributable to this one field instead of the whole General-tab patch.
  ipcMain.handle('settings:setPopupShortcut', (_e, accelerator: string) => {
    const previous = settings!.get().popupShortcut;
    const result = applyPopupShortcut(accelerator);
    if (result.ok) {
      settings!.update({ popupShortcut: accelerator.trim() });
    } else {
      // applyPopupShortcut unregisters the current accelerator before trying
      // the new one — on failure, re-register the old one so a rejected
      // change doesn't silently leave the previously-working shortcut dead
      // while settings.json still names it.
      const rollback = applyPopupShortcut(previous);
      if (!rollback.ok) {
        // Re-registering the *previous* accelerator also failed — nothing is
        // actually registered now, so clear the persisted value rather than
        // leaving the UI showing a shortcut that isn't active.
        runtime!.log('error', '[main] failed to restore previous tray-popup shortcut after a rejected change — clearing it', {
          previous,
          attempted: accelerator,
          reason: rollback.reason,
        });
        settings!.update({ popupShortcut: '' });
      } else {
        runtime!.log('warn', '[main] rejected tray-popup shortcut change, kept the previous shortcut active', {
          attempted: accelerator,
          reason: result.reason,
        });
      }
    }
    return result;
  });

  ipcMain.handle('settings:clearEvents', () => {
    settings!.clearEvents();
    return settings!.get();
  });

  ipcMain.handle('settings:togglePause', () => {
    paused = !paused;
    return paused;
  });

  ipcMain.handle('settings:logs', () => runtime!.recentLogs());

  ipcMain.handle('settings:testNotification', () => sendTestNotification());

  ipcMain.handle('quota:get', () => quotaService!.state());

  ipcMain.handle('quota:refresh', async (_e, id?: string) => {
    if (id) {
      const snap = await quotaService!.refresh(id);
      return snap;
    }
    return await quotaService!.refreshAll();
  });

  for (const connector of ALL_CONNECTORS) {
    if (!connector.login) continue;
    ipcMain.handle(`connector:login:${connector.id}`, () => {
      const ctx = runtime!.contextFor(connector);
      connector.login!.handler(ctx, () => void quotaService!.refresh(connector.id));
      return true;
    });
  }

  ipcMain.handle('trayPopup:openSettings', () => {
    openSettings();
  });

  ipcMain.handle('trayPopup:getQuotas', () => quotaService!.state());
  ipcMain.handle('trayPopup:getConnectors', () => runtime!.metadata());
  ipcMain.handle('trayPopup:getBucketPrefs', () => settings!.get().connectors.bucketPrefs ?? {});
  ipcMain.handle('trayPopup:getUiPrefs', () => {
    const s = settings!.get();
    return {
      theme: s.theme ?? 'system',
      density: s.density ?? 'default',
      timeFormat: s.timeFormat ?? 'auto',
      transparentPopup: !!s.transparentPopup,
      // Missing (pre-upgrade settings.json) defaults to shown.
      showSpendCard: s.showSpendCard !== false,
    };
  });
  ipcMain.handle('trayPopup:refresh', async (_e, id?: string) => {
    // A single-id refresh resolves to `{ [id]: snapshot }`, not the full map
    // — the renderer merges it onto its own last-known state (see
    // tray-popup.ts's row-menu "Refresh this provider" handler).
    if (id) {
      const snap = await quotaService!.refresh(id);
      return { [id]: snap };
    }
    return await quotaService!.refreshAll();
  });
  ipcMain.handle(
    'trayPopup:setBucketPref',
    (_e, id: string, bucketId: string, patch: Partial<BucketPref>) => {
      settings!.setBucketPref(id, bucketId, patch);
      refreshTrayQuotaSummary();
      // Narrower than `connectors:setBucketPref`'s full-AppSettings return —
      // the popup only ever reads `bucketPrefs` out of the response (see
      // tray-popup.ts's `applyRowMenuBucketPref`), so there's no reason to
      // hand it `recentEvents` (transcript excerpts) or every connector's
      // config. Matches the shape `trayPopup:getBucketPrefs` already returns.
      return settings!.get().connectors.bucketPrefs ?? {};
    },
  );
}

function refreshTrayQuotaSummary(): void {
  if (!trayHandle || !settings) return;
  if (!settings.get().showQuotaInTray) {
    trayHandle.setQuotaLine(null);
    return;
  }
  const snapshots = quotaService?.state() ?? {};
  const bucketPrefs = settings.get().connectors.bucketPrefs ?? {};
  const lines: string[] = [];
  for (const def of ALL_CONNECTORS) {
    const snap: QuotaSnapshot | undefined = snapshots[def.id];
    if (!snap || !snap.ok) continue;
    const line = formatTrayLineFor(def.name, snap, bucketPrefs[def.id]);
    if (line) lines.push(line);
  }
  trayHandle.setQuotaLine(lines.length ? lines.join('\n') : null);
}

function sendTestNotification(): { ok: boolean; reason?: string } {
  runtime!.log('info', '[main] test notification requested');
  if (!Notification.isSupported()) {
    runtime!.log('error', '[main] OS reports notifications are not supported');
    return { ok: false, reason: 'unsupported' };
  }
  try {
    const n = new Notification({
      title: 'AI Oversight test',
      body: 'Notifications are working. You will be pinged when an agent waits for you.',
      silent: false,
    });
    n.on('show', () => runtime!.log('info', '[main] test notification shown'));
    n.on('failed', (_e, err) => runtime!.log('error', '[main] test notification failed', { err: String(err) }));
    n.show();
    return { ok: true };
  } catch (err) {
    runtime!.log('error', '[main] test notification threw', { err: String(err) });
    return { ok: false, reason: String(err) };
  }
}
