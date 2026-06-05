import * as path from 'path';
import { BrowserWindow, Tray, ipcMain, screen } from 'electron';
import type { ConnectorMetadata, QuotaSnapshot } from './connectors/types';

export interface TrayPopupActions {
  openSettings: () => void;
  getQuotas: () => Record<string, QuotaSnapshot>;
  getConnectors: () => ConnectorMetadata[];
}

export interface TrayPopupHandle {
  toggle: (tray: Tray) => void;
  hide: () => void;
  sendQuota: (quotas: Record<string, QuotaSnapshot>) => void;
  destroy: () => void;
}

const POPUP_WIDTH = 360;
const POPUP_INITIAL_HEIGHT = 220;
const POPUP_MIN_HEIGHT = 140;
const POPUP_MAX_HEIGHT = 720;

function positionNearTray(win: BrowserWindow, tray: Tray): void {
  const trayBounds = tray.getBounds();
  const winBounds = win.getBounds();
  const hasTrayPos = trayBounds.width > 0 && trayBounds.height > 0;

  let x: number;
  let y: number;

  if (hasTrayPos) {
    x = Math.round(trayBounds.x + trayBounds.width / 2 - winBounds.width / 2);
    if (process.platform === 'darwin') {
      y = Math.round(trayBounds.y + trayBounds.height + 4);
    } else if (process.platform === 'win32') {
      y = Math.round(trayBounds.y - winBounds.height - 4);
    } else {
      y = Math.round(trayBounds.y + trayBounds.height + 4);
    }
  } else {
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const { workArea } = display;
    x = Math.round(workArea.x + workArea.width - winBounds.width - 12);
    y = Math.round(workArea.y + workArea.height - winBounds.height - 12);
  }

  const display = screen.getDisplayNearestPoint({ x, y });
  const { workArea } = display;
  x = Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - winBounds.width);
  y = Math.min(Math.max(y, workArea.y), workArea.y + workArea.height - winBounds.height);

  win.setPosition(x, y, false);
}

export function createTrayPopup(actions: TrayPopupActions): TrayPopupHandle {
  let popup: BrowserWindow | null = null;
  let blurHideTimer: NodeJS.Timeout | null = null;
  let lastTray: Tray | null = null;

  const resizeListener = (e: Electron.IpcMainEvent, height: number): void => {
    if (!popup || popup.isDestroyed()) return;
    if (e.sender !== popup.webContents) return;
    const clamped = Math.round(Math.max(POPUP_MIN_HEIGHT, Math.min(POPUP_MAX_HEIGHT, height)));
    popup.setContentSize(POPUP_WIDTH, clamped, false);
    if (lastTray && popup.isVisible()) positionNearTray(popup, lastTray);
  };
  ipcMain.on('trayPopup:resize', resizeListener);

  const ensureWindow = (): BrowserWindow => {
    if (popup && !popup.isDestroyed()) return popup;

    popup = new BrowserWindow({
      width: POPUP_WIDTH,
      height: POPUP_INITIAL_HEIGHT,
      useContentSize: true,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: true,
      backgroundColor: '#161b22',
      ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'tray-popup.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    popup.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    popup.loadFile(path.join(__dirname, '..', 'renderer', 'tray-popup.html'));

    popup.on('blur', () => {
      blurHideTimer = setTimeout(() => {
        if (popup && !popup.isDestroyed() && popup.isVisible()) popup.hide();
      }, 120);
    });

    popup.on('focus', () => {
      if (blurHideTimer) {
        clearTimeout(blurHideTimer);
        blurHideTimer = null;
      }
    });

    popup.on('show', () => {
      popup?.webContents.send('trayPopup:visibility', true);
    });
    popup.on('hide', () => {
      popup?.webContents.send('trayPopup:visibility', false);
    });
    popup.on('closed', () => {
      popup = null;
    });

    return popup;
  };

  const hide = () => {
    if (popup && !popup.isDestroyed() && popup.isVisible()) popup.hide();
  };

  const show = (tray: Tray) => {
    lastTray = tray;
    const win = ensureWindow();
    const reveal = () => {
      positionNearTray(win, tray);
      win.show();
      win.focus();
      win.webContents.send('trayPopup:quotas', actions.getQuotas());
    };

    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', reveal);
    } else {
      reveal();
    }
  };

  return {
    toggle(tray) {
      const win = popup && !popup.isDestroyed() ? popup : null;
      if (win?.isVisible()) {
        hide();
        return;
      }
      show(tray);
    },
    hide,
    sendQuota(quotas) {
      if (popup && !popup.isDestroyed()) {
        popup.webContents.send('trayPopup:quotas', quotas);
      }
    },
    destroy() {
      if (blurHideTimer) clearTimeout(blurHideTimer);
      ipcMain.removeListener('trayPopup:resize', resizeListener);
      if (popup && !popup.isDestroyed()) popup.destroy();
      popup = null;
    },
  };
}
