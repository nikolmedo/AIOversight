// Single ambient home for the quota/connector-metadata types shared by both
// renderer surfaces (settings window + tray popup). Kept assignable to the
// main-process source of truth (`src/main/connectors/types.ts`) by the
// compile-time parity guard in `src/main/connectors/types-parity.ts` — do not
// let these drift; update both sides together.

/** Unit a bucket's `used`/`limit` values are expressed in. */
type QuotaUnit = 'credits' | 'requests' | 'usd' | 'tokens' | 'percent';

interface QuotaBucket {
  /** Stable id. Permanent — keys persisted star/hide/order prefs (`BucketPref`). */
  id: string;
  label: string;
  /**
   * `null` = not measured (this connector doesn't report the value) -> UI
   * shows "No data". `0` = measured and genuinely zero -> UI shows "$0.00" /
   * "0".
   */
  used: number | null;
  limit: number | null;
  remaining: number | null;
  unit: QuotaUnit;
  enabled: boolean;
  /** Epoch ms this bucket's window resets, when known. */
  resetsAt?: number;
  /** Length of the rolling window in ms (e.g. 5h = 18_000_000), when known. */
  windowMs?: number;
  /** Whether this bucket should render by default or only behind an on-demand toggle. */
  defaultVisibility?: 'always' | 'onDemand';
  /** Optional short annotation shown alongside the bucket (e.g. a caveat). */
  note?: string;
}

/** A single period's spend/token summary. Not a meter — no `limit`, no pace coloring. */
type SpendPeriod = 'today' | 'yesterday' | 'last30d';

interface SpendTile {
  period: SpendPeriod;
  label: string;
  /** Integer cents. `null` = not measured (never `0` for "no sessions this period"). */
  costCents: number | null;
  tokens: number | null;
  /** Optional trailing daily series (oldest -> newest), same null-vs-zero convention. */
  series?: Array<number | null>;
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
      /** Optional cross-provider spend summary (Total Spend card). */
      spend?: SpendTile[];
    }
  | {
      ok: false;
      fetchedAt: number;
      error: string;
      source?: string;
      needsLogin?: boolean;
    };

/** Per-bucket display prefs the user controls (star / hide / reorder). */
interface BucketPref {
  hidden?: boolean;
  starred?: boolean;
  order?: number;
  /** Explicit visibility override — see `BucketPref` in `main/connectors/types.ts`. */
  visibility?: 'always' | 'onDemand';
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
  /** Optional brand accent color (hex). Falls back to an id-hash color in the renderer. */
  brandColor?: string;
}

interface ConnectorEnabled {
  notifications: boolean;
  quota: boolean;
}

interface ConnectorRuntimeConfig {
  enabled: Record<string, ConnectorEnabled>;
  config: Record<string, Record<string, unknown>>;
  pollOverrideMinutes?: Record<string, number>;
  /** Per-connector, per-bucket display prefs: bucketPrefs[connectorId][bucketId]. */
  bucketPrefs?: Record<string, Record<string, BucketPref>>;
}

/**
 * Moved here (Phase 2c) from `global.d.ts` — the tray popup now needs it too
 * (`TrayPopupAPI.getUiPrefs`/`setBucketPref` return shapes), and this file is
 * already the single shared ambient home for cross-surface types.
 * `EventKind`/`RecentEvent` stay declared in `global.d.ts`; being ambient
 * `.d.ts` files under the same `tsc` program, they're still visible here.
 */
interface AppSettings {
  showNotifications: boolean;
  notifyOnWaiting: boolean;
  notifyOnFinished: boolean;
  perSessionCooldownMs: number;
  quietHours: { startHour: number; endHour: number } | null;
  quotaPollMinutes: number;
  showQuotaInTray: boolean;
  launchAtLogin: boolean;
  theme: 'system' | 'light' | 'dark';
  density: 'default' | 'compact';
  timeFormat: 'auto' | '12h' | '24h';
  transparentPopup: boolean;
  /** Show the cross-provider Total Spend card (estimates at API rates). */
  showSpendCard: boolean;
  /** Electron accelerator string, or '' when no shortcut is set. */
  popupShortcut: string;
  connectors: ConnectorRuntimeConfig;
  recentEvents: RecentEvent[];
}
