import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { ALL_CONNECTORS } from './connectors/registry';
import {
  ConnectorEnabled,
  ConnectorRuntimeConfig,
  EventKind,
} from './connectors/types';

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
  connectors: ConnectorRuntimeConfig;
  recentEvents: RecentEventRecord[];
}

function defaultEnabled(): Record<string, ConnectorEnabled> {
  const enabled: Record<string, ConnectorEnabled> = {};
  for (const def of ALL_CONNECTORS) {
    enabled[def.id] = {
      // Detector defaults to the connector's enabledByDefault.
      notifications: !!def.detector && def.enabledByDefault,
      // Quota: only enable Cursor by default — everything else needs a key.
      quota: !!def.quota && def.id === 'cursor',
    };
  }
  return enabled;
}

function defaultConfig(): Record<string, Record<string, unknown>> {
  const config: Record<string, Record<string, unknown>> = {};
  for (const def of ALL_CONNECTORS) {
    config[def.id] = {};
    for (const f of def.configSchema) {
      if (f.type === 'secret') continue;
      config[def.id][f.key] = f.default;
    }
  }
  return config;
}

function defaults(): AppSettings {
  return {
    showNotifications: true,
    notifyOnWaiting: true,
    notifyOnFinished: true,
    perSessionCooldownMs: 30_000,
    quietHours: null,
    quotaPollMinutes: 5,
    showQuotaInTray: true,
    connectors: {
      enabled: defaultEnabled(),
      config: defaultConfig(),
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

  constructor() {
    const dir = app.getPath('userData');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'settings.json');
    this.state = this.load();
  }

  private load(): AppSettings {
    if (!fs.existsSync(this.file)) return defaults();
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as
        & Partial<AppSettings>
        & LegacySettings
        & {
          recentEvents?: Array<Partial<RecentEventRecord>>;
        };
      const base = defaults();

      const connectors = mergeConnectors(base.connectors, raw);

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
        connectors,
        recentEvents,
      };
    } catch {
      return defaults();
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
        // Cursor used to ship with quota always-on; preserve that.
        quota: cur.quota || (id === 'cursor' && !!on),
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
