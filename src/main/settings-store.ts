import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import {
  BucketPref,
  ConnectorEnabled,
  ConnectorRuntimeConfig,
  EventKind,
  MAX_STARRED_PER_CONNECTOR,
} from './connectors/types';

export interface ConnectorDefaults {
  enabled: Record<string, ConnectorEnabled>;
  config: Record<string, Record<string, unknown>>;
  /** Whether quota is on by default per connector (used in legacy settings migration). */
  quotaDefaultEnabled: Record<string, boolean>;
}

export interface RecentEventRecord {
  ts: number;
  agent: string;
  sessionId: string;
  message: string;
  kind: EventKind;
  source?: string;
}

export interface AppSettings {
  /** Master kill switch for all desktop notifications. */
  showNotifications: boolean;
  notifyOnWaiting: boolean;
  notifyOnFinished: boolean;
  perSessionCooldownMs: number;
  quietHours: { startHour: number; endHour: number } | null;
  /** Default quota poll interval (minutes). 0 = manual only. */
  quotaPollMinutes: number;
  /** Show a quota summary in the menu-bar / tray tooltip. */
  showQuotaInTray: boolean;
  /** Launch the app automatically at system startup / login. */
  launchAtLogin: boolean;
  /** Applied via Electron `nativeTheme.themeSource`. */
  theme: 'system' | 'light' | 'dark';
  /** Renderer-only: toggles a `density-compact` body class in both windows. */
  density: 'default' | 'compact';
  /** Feeds `formatExactReset` in both renderers; 'auto' resolves via `Intl`. */
  timeFormat: 'auto' | '12h' | '24h';
  /** Platform-conditional tray popup blur (Windows acrylic / macOS vibrancy; no-op on Linux). */
  transparentPopup: boolean;
  /**
   * Show the cross-provider Total Spend card. The figures are ESTIMATES at
   * public API rates computed from local usage logs — on a flat-rate
   * subscription they are not a bill, so users who find them noise can turn
   * the card off entirely (both the tray popup and the settings window).
   */
  showSpendCard: boolean;
  /** Electron accelerator string to toggle the tray popup, or '' when unset. */
  popupShortcut: string;
  connectors: ConnectorRuntimeConfig;
  recentEvents: RecentEventRecord[];
}

function defaults(d: ConnectorDefaults): AppSettings {
  return {
    showNotifications: true,
    notifyOnWaiting: true,
    notifyOnFinished: true,
    perSessionCooldownMs: 30_000,
    quietHours: null,
    quotaPollMinutes: 5,
    showQuotaInTray: true,
    launchAtLogin: false,
    theme: 'system',
    density: 'default',
    timeFormat: 'auto',
    transparentPopup: false,
    showSpendCard: true,
    popupShortcut: '',
    connectors: {
      enabled: d.enabled,
      config: d.config,
      pollOverrideMinutes: {},
      bucketPrefs: {},
    },
    recentEvents: [],
  };
}

/**
 * Validate an unknown patch into a `BucketPref` with only well-typed fields
 * kept — invalid/absent fields are omitted (not set to `undefined`), so a
 * caller can safely `{ ...cur, ...sanitizeBucketPrefPatch(patch) }` without
 * clobbering existing values. Shared by `SettingsStore.setBucketPref` (the
 * live IPC-write path) and `mergeConnectors` (the disk-load path) so both
 * enforce the same contract.
 */
export function sanitizeBucketPrefPatch(patch: unknown): Partial<BucketPref> {
  const p = (patch ?? {}) as Partial<Record<keyof BucketPref, unknown>>;
  const out: Partial<BucketPref> = {};
  if (typeof p.hidden === 'boolean') out.hidden = p.hidden;
  if (typeof p.starred === 'boolean') out.starred = p.starred;
  if (typeof p.order === 'number') out.order = p.order;
  if (p.visibility === 'always' || p.visibility === 'onDemand') out.visibility = p.visibility;
  return out;
}

// Exported (not just used internally by `load()`) so smoke.js can exercise
// the same validation `load()` applies to a persisted settings.json, headless
// and without instantiating `SettingsStore` (which needs `app.getPath` at
// construction time).
export function isTheme(v: unknown): v is AppSettings['theme'] {
  return v === 'system' || v === 'light' || v === 'dark';
}
export function isDensity(v: unknown): v is AppSettings['density'] {
  return v === 'default' || v === 'compact';
}
export function isTimeFormat(v: unknown): v is AppSettings['timeFormat'] {
  return v === 'auto' || v === '12h' || v === '24h';
}

interface LegacySettings {
  detectors?: {
    enabled?: Record<string, boolean>;
    config?: Record<string, Record<string, unknown>>;
  };
  cursorQuotaPollMinutes?: number;
  showCursorQuotaInTray?: boolean;
}

export class SettingsStore {
  private readonly file: string;
  private state: AppSettings;

  constructor(private readonly connectorDefaults: ConnectorDefaults) {
    const dir = app.getPath('userData');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'settings.json');
    this.state = this.load();
  }

  private load(): AppSettings {
    if (!fs.existsSync(this.file)) return defaults(this.connectorDefaults);
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as
        & Partial<AppSettings>
        & LegacySettings
        & {
          recentEvents?: Array<Partial<RecentEventRecord>>;
        };
      const base = defaults(this.connectorDefaults);

      const connectors = mergeConnectors(base.connectors, raw, this.connectorDefaults.quotaDefaultEnabled);

      const recentEvents: RecentEventRecord[] = (raw.recentEvents ?? []).map(e => ({
        ts: typeof e?.ts === 'number' ? e.ts : Date.now(),
        agent: String(e?.agent ?? 'Agent'),
        sessionId: String(e?.sessionId ?? ''),
        message: String(e?.message ?? ''),
        kind: e?.kind === 'finished' ? 'finished' : 'waiting',
        source: typeof e?.source === 'string' ? e.source : undefined,
      }));

      return {
        showNotifications: raw.showNotifications ?? base.showNotifications,
        notifyOnWaiting: raw.notifyOnWaiting ?? base.notifyOnWaiting,
        notifyOnFinished: raw.notifyOnFinished ?? base.notifyOnFinished,
        perSessionCooldownMs: raw.perSessionCooldownMs ?? base.perSessionCooldownMs,
        quietHours: raw.quietHours ?? base.quietHours,
        quotaPollMinutes:
          raw.quotaPollMinutes ?? raw.cursorQuotaPollMinutes ?? base.quotaPollMinutes,
        showQuotaInTray:
          raw.showQuotaInTray ?? raw.showCursorQuotaInTray ?? base.showQuotaInTray,
        launchAtLogin: raw.launchAtLogin ?? base.launchAtLogin,
        theme: isTheme(raw.theme) ? raw.theme : base.theme,
        density: isDensity(raw.density) ? raw.density : base.density,
        timeFormat: isTimeFormat(raw.timeFormat) ? raw.timeFormat : base.timeFormat,
        transparentPopup:
          typeof raw.transparentPopup === 'boolean' ? raw.transparentPopup : base.transparentPopup,
        showSpendCard:
          typeof raw.showSpendCard === 'boolean' ? raw.showSpendCard : base.showSpendCard,
        popupShortcut: typeof raw.popupShortcut === 'string' ? raw.popupShortcut : base.popupShortcut,
        connectors,
        recentEvents,
      };
    } catch {
      return defaults(this.connectorDefaults);
    }
  }

  get(): AppSettings {
    return this.state;
  }

  update(patch: Partial<AppSettings>): AppSettings {
    this.state = { ...this.state, ...patch };
    this.persist();
    return this.state;
  }

  setConnectorEnabled(id: string, enabled: Partial<ConnectorEnabled>): void {
    const cur = this.state.connectors.enabled[id] ?? { notifications: false, quota: false };
    this.state.connectors.enabled[id] = { ...cur, ...enabled };
    this.persist();
  }

  setConnectorConfig(id: string, config: Record<string, unknown>): void {
    this.state.connectors.config[id] = {
      ...this.state.connectors.config[id],
      ...config,
    };
    this.persist();
  }

  setConnectorPollOverride(id: string, minutes: number | null): void {
    if (!this.state.connectors.pollOverrideMinutes) {
      this.state.connectors.pollOverrideMinutes = {};
    }
    if (minutes == null) {
      delete this.state.connectors.pollOverrideMinutes[id];
    } else {
      this.state.connectors.pollOverrideMinutes[id] = minutes;
    }
    this.persist();
  }

  /**
   * Update a single bucket's display prefs, enforcing `MAX_STARRED_PER_CONNECTOR`
   * centrally so the settings window and tray popup can't disagree on the cap.
   * Convention: like `setConnectorConfig`/`setConnectorPollOverride`, this is a
   * void mutator — callers re-read via `get()`.
   *
   * Star-cap policy: if starring this bucket would exceed the cap, the request
   * is silently ignored (no-op) rather than un-starring another bucket. There's
   * no timestamp on `BucketPref` to determine an "oldest" star, and `order` is
   * display order, not star history — evicting a choice the user made
   * elsewhere would be surprising. The UI is expected to disable the star
   * control once the cap is reached.
   */
  setBucketPref(connectorId: string, bucketId: string, patch: Partial<BucketPref>): void {
    if (!this.state.connectors.bucketPrefs) {
      this.state.connectors.bucketPrefs = {};
    }
    const perConnector = { ...(this.state.connectors.bucketPrefs[connectorId] ?? {}) };
    const cur = perConnector[bucketId] ?? {};

    // Validate the same way the disk-load path (mergeConnectors) does, so a
    // malformed/untyped IPC payload can't write something load would reject.
    let sanitized = sanitizeBucketPrefPatch(patch);

    if (sanitized.starred === true && !cur.starred) {
      const starredCount = Object.entries(perConnector).filter(
        ([id, p]) => id !== bucketId && p.starred,
      ).length;
      if (starredCount >= MAX_STARRED_PER_CONNECTOR) {
        // At cap — drop the starred:true request, keep any other fields.
        const { starred: _ignored, ...rest } = sanitized;
        sanitized = rest;
      }
    }

    perConnector[bucketId] = { ...cur, ...sanitized };
    this.state.connectors.bucketPrefs[connectorId] = perConnector;
    this.persist();
  }

  pushEvent(e: RecentEventRecord): void {
    this.state.recentEvents.unshift(e);
    if (this.state.recentEvents.length > 50) this.state.recentEvents.length = 50;
    this.persist();
  }

  clearEvents(): void {
    this.state.recentEvents = [];
    this.persist();
  }

  filePath(): string {
    return this.file;
  }

  private persist(): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
    } catch (err) {
      console.error('Failed to write settings:', err);
    }
  }
}

function mergeConnectors(
  base: ConnectorRuntimeConfig,
  raw: Partial<AppSettings> & LegacySettings,
  quotaDefaultEnabled: Record<string, boolean>,
): ConnectorRuntimeConfig {
  const enabled: Record<string, ConnectorEnabled> = { ...base.enabled };
  const config: Record<string, Record<string, unknown>> = { ...base.config };
  const pollOverrideMinutes: Record<string, number> = { ...base.pollOverrideMinutes };
  const bucketPrefs: Record<string, Record<string, BucketPref>> = { ...base.bucketPrefs };

  // Migration path 1: legacy `detectors.{enabled,config}` -> connectors.
  if (raw.detectors?.enabled) {
    for (const [id, on] of Object.entries(raw.detectors.enabled)) {
      const cur = enabled[id] ?? { notifications: false, quota: false };
      enabled[id] = {
        ...cur,
        notifications: !!on,
        quota: cur.quota || (!!(quotaDefaultEnabled[id]) && !!on),
      };
    }
  }
  if (raw.detectors?.config) {
    for (const [id, cfg] of Object.entries(raw.detectors.config)) {
      config[id] = { ...(config[id] ?? {}), ...(cfg as Record<string, unknown>) };
    }
  }

  // Path 2: new connectors block.
  if (raw.connectors?.enabled) {
    for (const [id, on] of Object.entries(raw.connectors.enabled)) {
      const cur = enabled[id] ?? { notifications: false, quota: false };
      // Tolerate older bool-only shape from a development build.
      if (typeof on === 'boolean') {
        enabled[id] = { ...cur, notifications: on };
      } else {
        enabled[id] = {
          notifications: !!on?.notifications,
          quota: !!on?.quota,
        };
      }
    }
  }
  if (raw.connectors?.config) {
    for (const [id, cfg] of Object.entries(raw.connectors.config)) {
      config[id] = { ...(config[id] ?? {}), ...(cfg as Record<string, unknown>) };
    }
  }
  if (raw.connectors?.pollOverrideMinutes) {
    for (const [id, m] of Object.entries(raw.connectors.pollOverrideMinutes)) {
      if (typeof m === 'number') pollOverrideMinutes[id] = m;
    }
  }
  if (raw.connectors?.bucketPrefs) {
    for (const [id, perBucket] of Object.entries(raw.connectors.bucketPrefs)) {
      if (!perBucket || typeof perBucket !== 'object') continue;
      const merged: Record<string, BucketPref> = { ...(bucketPrefs[id] ?? {}) };
      for (const [bucketId, pref] of Object.entries(perBucket)) {
        if (!pref || typeof pref !== 'object') continue;
        merged[bucketId] = sanitizeBucketPrefPatch(pref);
      }
      bucketPrefs[id] = merged;
    }
  }

  return { enabled, config, pollOverrideMinutes, bucketPrefs };
}
