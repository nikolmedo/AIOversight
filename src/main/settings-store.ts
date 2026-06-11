import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import {
  ConnectorEnabled,
  ConnectorRuntimeConfig,
  EventKind,
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
    connectors: {
      enabled: d.enabled,
      config: d.config,
      pollOverrideMinutes: {},
    },
    recentEvents: [],
  };
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

  return { enabled, config, pollOverrideMinutes };
}
