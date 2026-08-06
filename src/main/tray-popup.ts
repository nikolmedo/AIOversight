import * as os from 'os';
import * as path from 'path';
import { BrowserWindow, Tray, ipcMain, screen } from 'electron';
import type { ConnectorMetadata, QuotaSnapshot } from './connectors/types';

/**
 * Best-effort "is this Windows 11 22H2 or later" heuristic. Electron's own
 * typings document `setBackgroundMaterial` as "only supported on Windows 11
 * 22H2 and up" — `os.release()` on Windows returns `"10.0.<build>"` (Windows
 * 11 still reports major version 10 there), and build 22621 is 22H2.
 * Returns `false` (assume unsupported) on any parse failure. This only
 * decides whether to *proactively* skip the call when transparency is off —
 * it is not what actually prevents a crash if the heuristic is wrong in
 * either direction; the try/catch around the call itself is.
 */
function supportsBackgroundMaterial(): boolean {
  if (process.platform !== 'win32') return false;
  const build = Number(os.release().split('.')[2]);
  return Number.isFinite(build) && build >= 22621;
}

export interface TrayPopupActions {
  openSettings: () => void;
  getQuotas: () => Record<string, QuotaSnapshot>;
  getConnectors: () => ConnectorMetadata[];
}

export interface TrayPopupHandle {
  toggle: (tray: Tray) => void;
  hide: () => void;
  sendQuota: (quotas: Record<string, QuotaSnapshot>) => void;
  /**
   * Applies (or removes) the platform-conditional "Increase transparency"
   * effect to the live popup window. Windows: `setBackgroundMaterial` +
   * `setBackgroundColor` are both runtime-settable instance methods (verified
   * against this repo's installed Electron typings — no window
   * destroy/recreate needed, despite the plan's original assumption that
   * `vibrancy` is construction-only). macOS: `setVibrancy` is likewise a
   * runtime method. Linux: no-op — the Settings UI disables the checkbox
   * instead of calling this with `true`.
   */
  setTransparent: (enabled: boolean) => void;
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

export function createTrayPopup(actions: TrayPopupActions, initialTransparent = false): TrayPopupHandle {
  let popup: BrowserWindow | null = null;
  let blurHideTimer: NodeJS.Timeout | null = null;
  let lastTray: Tray | null = null;
  let transparentEnabled = initialTransparent;

  const OPAQUE_BG = '#161b22';
  const TRANSPARENT_BG = '#00000000';

  /** Applies `transparentEnabled` to a just-(re)created window. Split out
   * from `setTransparent` so `ensureWindow()` can call it on a fresh window
   * without going through the public toggle path. */
  const applyTransparencyToWindow = (win: BrowserWindow): void => {
    if (process.platform === 'win32') {
      win.setBackgroundColor(transparentEnabled ? TRANSPARENT_BG : OPAQUE_BG);
      // This call is made on *every* window creation/toggle, not just when a
      // user opts into transparency (off by default for everyone) — and
      // there is no process-level uncaughtException handler anywhere in
      // src/, so an unhandled throw here would risk breaking the tray
      // popup's core open/close interaction for every Windows user on an
      // unsupported build (10, or 11 pre-22H2), not just the transparency
      // feature. Proactively skipped when off and the OS heuristic says
      // it's unsupported; the try/catch is the non-negotiable part that
      // actually protects the "on + unsupported" / "heuristic wrong" cases.
      if (transparentEnabled || supportsBackgroundMaterial()) {
        try {
          win.setBackgroundMaterial(transparentEnabled ? 'acrylic' : 'none');
        } catch (err) {
          console.error(
            '[tray-popup] setBackgroundMaterial failed (likely an unsupported Windows build):',
            err,
          );
        }
      }
    } else if (process.platform === 'darwin') {
      win.setBackgroundColor(transparentEnabled ? TRANSPARENT_BG : OPAQUE_BG);
      win.setVibrancy(transparentEnabled ? 'popover' : null);
    }
    // Linux: no native effect — the Settings UI disables the checkbox so
    // `transparentEnabled` should never be true here in practice.
  };

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
      // Gated to win32/darwin — Linux has no native transparency effect
      // (applyTransparencyToWindow no-ops there), so a stale
      // `transparentPopup: true` in settings.json (synced from another OS,
      // hand-edited, ...) must not hand a Linux window a fully transparent
      // background with nothing behind it. The Settings UI disabling the
      // checkbox only prevents *setting* this from Linux, not *loading* it.
      backgroundColor:
        transparentEnabled && process.platform !== 'linux' ? TRANSPARENT_BG : OPAQUE_BG,
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
    applyTransparencyToWindow(popup);

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
    setTransparent(enabled) {
      transparentEnabled = enabled;
      if (popup && !popup.isDestroyed()) applyTransparencyToWindow(popup);
    },
    destroy() {
      if (blurHideTimer) clearTimeout(blurHideTimer);
      ipcMain.removeListener('trayPopup:resize', resizeListener);
      if (popup && !popup.isDestroyed()) popup.destroy();
      popup = null;
    },
  };
}
