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

interface ConnectorConfigField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'paths' | 'secret' | 'enum';
  default: string | number | boolean | string[];
  help?: string;
  section?: 'notifications' | 'quota' | 'general';
  requiresEnabled?: 'notifications' | 'quota';
  options?: Array<{ value: string; label: string }>;
}

interface ConnectorIntegrateInfo {
  type: 'http-notify';
  hostKey: string;
  portKey: string;
  tokenKey?: string;
}

interface ConnectorMetadata {
  id: string;
  name: string;
  vendor: string;
  description: string;
  enabledByDefault: boolean;
  hasDetector: boolean;
  hasQuota: boolean;
  defaultIntervalMinutes?: number;
  configSchema: ConnectorConfigField[];
  setSecretKeys?: string[];
  loginLabel?: string;
  integrateInfo?: ConnectorIntegrateInfo;
}

interface ConnectorEnabled {
  notifications: boolean;
  quota: boolean;
}

interface ConnectorRuntimeConfig {
  enabled: Record<string, ConnectorEnabled>;
  config: Record<string, Record<string, unknown>>;
  pollOverrideMinutes?: Record<string, number>;
}

interface AppSettings {
  showNotifications: boolean;
  notifyOnWaiting: boolean;
  notifyOnFinished: boolean;
  perSessionCooldownMs: number;
  quietHours: { startHour: number; endHour: number } | null;
  quotaPollMinutes: number;
  showQuotaInTray: boolean;
  connectors: ConnectorRuntimeConfig;
  recentEvents: RecentEvent[];
}

interface QuotaBucket {
  id: string;
  label: string;
  used: number;
  limit: number | null;
  remaining: number | null;
  unit: 'credits' | 'requests' | 'usd';
  enabled: boolean;
}

type QuotaSnapshot =
  | {
      ok: true;
      fetchedAt: number;
      buckets: QuotaBucket[];
      membershipType?: string;
      limitType?: string;
      billingCycleStart?: string;
      billingCycleEnd?: string;
      displayMessages: string[];
      authMethod?: string;
      trayLine?: string;
      source?: string;
    }
  | {
      ok: false;
      fetchedAt: number;
      error: string;
      source?: string;
      needsLogin?: boolean;
    };

interface InitialPayload {
  connectors: ConnectorMetadata[];
  settings: AppSettings;
  paused: boolean;
  settingsPath: string;
  quotas: Record<string, QuotaSnapshot>;
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
  update(patch: Partial<AppSettings>): Promise<AppSettings>;
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
