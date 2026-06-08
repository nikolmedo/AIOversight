import * as path from 'path';
import { app, BrowserWindow, ipcMain, Tray, Notification } from 'electron';
import { SettingsStore } from './settings-store';
import { Notifier } from './notifier';
import { createTray, TrayHandle } from './tray';
import { createTrayPopup, TrayPopupHandle } from './tray-popup';
import { ConnectorRuntime, ALL_CONNECTORS } from './connectors/runtime';
import { QuotaService } from './connectors/quota-service';
import { SecretStore } from './connectors/secret-store';
import { QuotaSnapshot } from './connectors/types';
import { startClaudeLogin } from './connectors/claude-code/browser-session';
import { startCopilotLogin } from './connectors/github-copilot/copilot-login';
import CopilotConnector from './connectors/github-copilot';

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

app.whenReady().then(async () => {
  settings = new SettingsStore();
  secretStore = new SecretStore();
  runtime = new ConnectorRuntime(secretStore);
  quotaService = new QuotaService(runtime);
  notifier = new Notifier(settings, (lvl, msg, meta) => runtime!.log(lvl, msg, meta));

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

  trayPopup = createTrayPopup({
    openSettings,
    getQuotas: () => quotaService!.state(),
    getConnectors: () => runtime!.metadata(),
  });

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

  ipcMain.handle('settings:update', async (_e, patch: Record<string, unknown>) => {
    const next = settings!.update(patch);
    if ('quotaPollMinutes' in patch || 'showQuotaInTray' in patch) {
      await quotaService!.applyConfig(next.connectors, next.quotaPollMinutes);
      refreshTrayQuotaSummary();
    }
    return next;
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

  ipcMain.handle('claude:login', () => {
    // Refresh the Claude quota as soon as the user finishes signing in, so the
    // panel updates without waiting for the next poll.
    startClaudeLogin(() => void quotaService!.refresh('claude-code'));
    return true;
  });

  ipcMain.handle('copilot:login', () => {
    // Same idea as claude:login — refresh the moment the device-flow completes.
    startCopilotLogin(secretStore!, runtime!.contextFor(CopilotConnector), () =>
      void quotaService!.refresh('github-copilot'),
    );
    return true;
  });

  ipcMain.handle('trayPopup:openSettings', () => {
    openSettings();
  });

  ipcMain.handle('trayPopup:getQuotas', () => quotaService!.state());
  ipcMain.handle('trayPopup:getConnectors', () => runtime!.metadata());
  ipcMain.handle('trayPopup:refresh', async () => {
    return await quotaService!.refreshAll();
  });
}

function refreshTrayQuotaSummary(): void {
  if (!trayHandle || !settings) return;
  if (!settings.get().showQuotaInTray) {
    trayHandle.setQuotaLine(null);
    return;
  }
  const snapshots = quotaService?.state() ?? {};
  const lines: string[] = [];
  for (const def of ALL_CONNECTORS) {
    const snap: QuotaSnapshot | undefined = snapshots[def.id];
    if (!snap || !snap.ok) continue;
    const line = formatTrayLineFor(def.name, snap);
    if (line) lines.push(line);
  }
  trayHandle.setQuotaLine(lines.length ? lines.join('\n') : null);
}

function formatTrayLineFor(name: string, snap: QuotaSnapshot): string | null {
  if (!snap.ok) return null;
  if (snap.trayLine) return `${name}: ${snap.trayLine}`;
  const primary = snap.buckets[0];
  if (!primary) return `${name}: ${snap.membershipType ?? 'connected'}`;
  if (primary.limit != null && primary.remaining != null) {
    const pct = primary.limit > 0 ? Math.round((primary.used / primary.limit) * 100) : 0;
    return `${name}: ${pct}% used`;
  }
  return `${name}: ${primary.used.toLocaleString()} ${primary.unit}`;
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
