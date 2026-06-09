import * as path from 'path';
import { Tray, Menu, nativeImage, app } from 'electron';
import { QuotaSnapshot } from './connectors/types';

export interface TrayActions {
  openSettings: () => void;
  togglePopup: () => void;
  togglePause: () => void;
  isPaused: () => boolean;
  testNotification: () => void;
  quit: () => void;
}

export interface TrayHandle {
  tray: Tray;
  /** Update the optional second line in the tray tooltip (Cursor quota). */
  setQuotaLine: (line: string | null) => void;
  rebuildMenu: () => void;
}

export function formatTrayLineFor(name: string, snap: QuotaSnapshot): string | null {
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

const BASE_TOOLTIP = 'AI Oversight — monitoring AI agents for approval prompts';

export function createTray(actions: TrayActions): TrayHandle {
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'tray-icon.png');
  const image = nativeImage.createFromPath(iconPath);
  if (process.platform === 'darwin') image.setTemplateImage(true);

  const tray = new Tray(image);
  let quotaLine: string | null = null;

  const applyTooltip = () => {
    tray.setToolTip(quotaLine ? `${BASE_TOOLTIP}\n${quotaLine}` : BASE_TOOLTIP);
  };

  let contextMenu: Menu | null = null;

  const rebuildMenu = () => {
    const paused = actions.isPaused();
    contextMenu = Menu.buildFromTemplate([
      {
        label: paused ? 'Resume monitoring' : 'Pause monitoring',
        click: () => {
          actions.togglePause();
          rebuildMenu();
        },
      },
      { type: 'separator' },
      { label: 'Open settings…', click: () => actions.openSettings() },
      { label: 'Send test notification', click: () => actions.testNotification() },
      { type: 'separator' },
      { label: `AI Oversight v${app.getVersion()}`, enabled: false },
      { label: 'Quit', click: () => actions.quit() },
    ]);

    // macOS shows setContextMenu on *every* click (left and right). Keep the menu
    // off the tray and pop it up manually on right-click so left-click only toggles
    // the quota popup.
    if (process.platform === 'darwin') {
      tray.setContextMenu(null);
    } else {
      tray.setContextMenu(contextMenu);
    }
  };

  const popupContextMenu = () => {
    if (!contextMenu) return;
    const bounds = tray.getBounds();
    contextMenu.popup({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y + bounds.height),
    });
  };

  applyTooltip();
  rebuildMenu();
  tray.on('click', () => actions.togglePopup());
  if (process.platform === 'darwin') {
    tray.on('right-click', () => popupContextMenu());
  }

  return {
    tray,
    setQuotaLine: line => {
      quotaLine = line;
      applyTooltip();
    },
    rebuildMenu,
  };
}
