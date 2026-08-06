// Ambient declarations for the renderer. Lives in a .d.ts so settings.ts can
// remain a plain script (no `export {}`), which is required because we compile
// with `module: "CommonJS"` and the browser cannot evaluate the resulting
// `Object.defineProperty(exports, "__esModule", ...)` preamble.

type EventKind = 'waiting' | 'finished';
interface RecentEvent {
  ts: number;
  agent: string;
  sessionId: string;
  message: string;
  kind: EventKind;
  source?: string;
}

// ConnectorConfigField / ConnectorIntegrateInfo / ConnectorMetadata /
// ConnectorEnabled / ConnectorRuntimeConfig / AppSettings live in `quota-types.d.ts`.

// QuotaBucket / QuotaSnapshot / SpendTile / BucketPref live in `quota-types.d.ts`.

interface InitialPayload {
  connectors: ConnectorMetadata[];
  settings: AppSettings;
  paused: boolean;
  settingsPath: string;
  quotas: Record<string, QuotaSnapshot>;
  /** `process.platform` from the main process — used to disable platform-conditional
   * settings (e.g. tray transparency has no Linux implementation). */
  platform: string;
}

interface LogEntry {
  ts: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  meta?: Record<string, unknown>;
}

interface AgentWatcherAPI {
  getInitial(): Promise<InitialPayload>;
  setConnectorEnabled(
    id: string,
    enabled: { notifications?: boolean; quota?: boolean },
  ): Promise<AppSettings>;
  setConnectorConfig(id: string, config: Record<string, unknown>): Promise<AppSettings>;
  setConnectorSecret(
    id: string,
    key: string,
    value: string | null,
  ): Promise<ConnectorMetadata[]>;
  setConnectorPollOverride(id: string, minutes: number | null): Promise<AppSettings>;
  setConnectorBucketPref(
    id: string,
    bucketId: string,
    patch: Partial<BucketPref>,
  ): Promise<AppSettings>;
  update(patch: Partial<AppSettings>): Promise<AppSettings>;
  setPopupShortcut(accelerator: string): Promise<{ ok: boolean; reason?: string }>;
  clearEvents(): Promise<AppSettings>;
  togglePause(): Promise<boolean>;
  testNotification(): Promise<void>;
  logs(): Promise<LogEntry[]>;
  getQuotas(): Promise<Record<string, QuotaSnapshot>>;
  refreshQuota(id?: string): Promise<QuotaSnapshot | Record<string, QuotaSnapshot>>;
  connectorLogin(id: string): Promise<boolean>;
  onEvent(cb: (e: RecentEvent) => void): () => void;
  onLog(cb: (e: LogEntry) => void): () => void;
  onPaused(cb: (paused: boolean) => void): () => void;
  onQuotaUpdate(cb: (e: { id: string; snapshot: QuotaSnapshot }) => void): () => void;
}

interface Window {
  aw: AgentWatcherAPI;
}
