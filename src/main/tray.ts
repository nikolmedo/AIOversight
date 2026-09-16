import * as fs from 'fs';
import * as path from 'path';
import { Tray, Menu, nativeImage, nativeTheme, app } from 'electron';
import { BucketPref, QuotaBucket, QuotaSnapshot } from './connectors/types';

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

// This is a plain-text tooltip line — no pace coloring here. `quota-math.ts`
// in the renderer (paceStateFor) is the source of truth for pace-based
// coloring; this function only needs a bare percentage/count for text.
function formatBucketForTray(b: QuotaBucket): string {
  if (b.limit != null && b.remaining != null) {
    const pct = b.limit > 0 ? Math.round((b.used! / b.limit) * 100) : 0;
    return `${pct}% used`;
  }
  return `${b.used!.toLocaleString()} ${b.unit}`;
}

/**
 * The measured bucket with the highest raw used/limit ratio. Anthropic's and
 * OpenAI's primary quota buckets are all `limit: null`, which would tie every
 * bucket at ratio -1 and silently degenerate to "first declared" — when no
 * bucket has a determinable ratio, fall back to comparing raw `used` instead.
 */
function highestUsageBucket(buckets: QuotaBucket[]): QuotaBucket {
  const withRatio = buckets.filter(b => b.limit != null && b.limit > 0);
  if (withRatio.length > 0) {
    return withRatio.reduce((best, b) => ((b.used! / b.limit!) > (best.used! / best.limit!) ? b : best));
  }
  return buckets.reduce((best, b) => ((b.used ?? -1) > (best.used ?? -1) ? b : best));
}

/**
 * The OS tray tooltip is fixed-width, so (per the openusage-parity "starred
 * menu-bar pins" design) it prefers buckets the user has starred over a
 * "primary bucket" guess. Buckets with `used === null` ("No data") are always
 * excluded from that list — no placeholder bucket.
 *
 * Until the user stars anything (the default for every connector — the star
 * UI itself ships in Phase 2c), there are zero starred buckets to show; that
 * state falls back to the single measured bucket with the highest usage
 * ratio. As soon as at least one bucket is starred for a connector, only
 * starred buckets show for it.
 *
 * Separately: `ok:true` with zero measured buckets (an empty `buckets[]`, or
 * every bucket's `used === null`) is a healthy, connected state — Anthropic
 * and Copilot both return exactly this shape with `membershipType` still set
 * when there's simply no usage yet this period. That falls back to
 * `membershipType` (or "connected"), matching the pre-2a tooltip line —
 * distinct from the per-bucket "no placeholder" rule above, which only
 * governs which *individual buckets* show alongside real ones.
 */
export function formatTrayLineFor(
  name: string,
  snap: QuotaSnapshot,
  bucketPrefs?: Record<string, BucketPref>,
): string | null {
  if (!snap.ok) return null;
  if (snap.trayLine) return `${name}: ${snap.trayLine}`;
  const measured = snap.buckets.filter(b => b.used != null);
  if (measured.length === 0) return `${name}: ${snap.membershipType ?? 'connected'}`;
  const starred = measured.filter(b => bucketPrefs?.[b.id]?.starred);
  const shown = starred.length > 0 ? starred : [highestUsageBucket(measured)];
  return `${name}: ${shown.map(formatBucketForTray).join(' · ')}`;
}

const BASE_TOOLTIP = 'AI Oversight — monitoring AI agents for approval prompts';

/**
 * Fallback path only, used when `tray-icon[-white].ico` is missing (see
 * `loadTrayImage`): the 16px PNG as the base plus the 24/32px PNGs as extra
 * representations at scaleFactor 1.5/2.0. Verified on a 200% display that
 * Electron's Windows tray ignores those extra representations and the shell
 * upscales the 16px bitmap, which is why the .ico is preferred.
 *
 * Pure and Electron-free on purpose: icons only regenerate via `postinstall`
 * (not `build`/`dev`/`package:win`), so a stale checkout or interrupted
 * install can genuinely be missing the 24/32px files. Exported so
 * `scripts/smoke.js` can exercise the degradation logic headlessly.
 */
export function trayRepresentationsToLoad(
  available: { tray24: boolean; tray32: boolean },
  suffix = '',
): Array<{ file: string; scaleFactor: number }> {
  const reps: Array<{ file: string; scaleFactor: number }> = [];
  if (available.tray24) reps.push({ file: `tray-icon-24${suffix}.png`, scaleFactor: 1.5 });
  if (available.tray32) reps.push({ file: `tray-icon-32${suffix}.png`, scaleFactor: 2.0 });
  return reps;
}

function taskbarIsDark(): boolean {
  return nativeTheme.shouldUseDarkColorsForSystemIntegratedUI;
}

/**
 * `assetsDirOverride` exists only so tests can point this at a temp fixture
 * directory without touching Electron's real runtime assets — production
 * (`createTray`) always calls this with no argument.
 */
export function loadTrayImage(assetsDirOverride?: string): Electron.NativeImage {
  const assetsDir = assetsDirOverride ?? path.join(__dirname, '..', '..', 'assets');

  if (process.platform === 'win32') {
    // Windows never auto-inverts tray glyphs (there is no macOS-style
    // template-image tinting), so a dark taskbar needs the pre-rendered
    // white-glyph variants. The taskbar follows the Windows *system* colour
    // mode, not the app mode: `shouldUseDarkColors` would follow the app's own
    // theme setting (`themeSource`), which can differ from the taskbar.
    const suffix = taskbarIsDark() ? '-white' : '';

    // An .ico carries one frame per notification-area DPI (16..48px) and the
    // shell picks the matching one, so it stays sharp at 125%-300% scaling.
    const icoPath = path.join(assetsDir, `tray-icon${suffix}.ico`);
    if (fs.existsSync(icoPath)) {
      // WARNING FIX: a throw here must never escape into the caller's
      // unguarded `app.whenReady().then()` chain in index.ts (no
      // `.catch()`/`unhandledRejection` handler exists anywhere) and take
      // down tray creation, IPC registration, and the rest of startup — the
      // same rationale as the PNG-representation catch block two lines
      // below, which this was inconsistently missing.
      try {
        const ico = nativeImage.createFromPath(icoPath);
        if (!ico.isEmpty()) return ico;
      } catch (err) {
        console.warn(`[tray] failed to load ${icoPath}, falling back to PNG representations:`, err);
      }
    }

    // `createFromPath` never throws on a missing file — it returns an empty
    // image. The 24/32px extras are gated on `existsSync` and additionally
    // try/catch-guarded (a `readFileSync`/`addRepresentation` throw here must
    // never escape into the caller's unguarded `app.whenReady().then()` chain
    // and take down tray creation, IPC registration, and the rest of startup).
    const image = nativeImage.createFromPath(path.join(assetsDir, `tray-icon-16${suffix}.png`));
    const reps = trayRepresentationsToLoad({
      tray24: fs.existsSync(path.join(assetsDir, `tray-icon-24${suffix}.png`)),
      tray32: fs.existsSync(path.join(assetsDir, `tray-icon-32${suffix}.png`)),
    }, suffix);
    for (const rep of reps) {
      try {
        image.addRepresentation({
          scaleFactor: rep.scaleFactor,
          buffer: fs.readFileSync(path.join(assetsDir, rep.file)),
        });
      } catch (err) {
        console.warn(`[tray] failed to load ${rep.file} representation, continuing without it:`, err);
      }
    }
    return image;
  }

  // macOS/Linux: 22px base + Electron's automatic `@2x` retina convention.
  const image = nativeImage.createFromPath(path.join(assetsDir, 'tray-icon.png'));
  if (process.platform === 'darwin') image.setTemplateImage(true);
  return image;
}

export function createTray(actions: TrayActions): TrayHandle {
  const image = loadTrayImage();

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
  if (process.platform === 'win32') {
    // Swap black/white glyph live when the taskbar's light/dark mode flips.
    // Registered here (not at module scope) because it needs the `tray`
    // instance; `createTray` runs exactly once per app lifetime and the tray
    // lives until quit, so a single listener neither leaks nor double
    // registers. `updated` also fires for changes that don't affect the
    // taskbar (the app's own theme setting, high-contrast toggles) -- the
    // guard skips redundant image reloads.
    let usingDarkTaskbar = taskbarIsDark();
    nativeTheme.on('updated', () => {
      if (taskbarIsDark() === usingDarkTaskbar) return;
      usingDarkTaskbar = taskbarIsDark();
      tray.setImage(loadTrayImage());
    });
  }
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
