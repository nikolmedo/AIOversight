/**
 * Connector framework — types shared by every integration.
 *
 * A Connector is a self-contained integration with one or both of:
 *   - a `detector` that emits AgentEvent (waiting / finished) for desktop
 *     notifications.
 *   - a `quota` provider that returns a normalised QuotaSnapshot polled by
 *     the QuotaService.
 *
 * Each integration lives under `src/main/connectors/<id>/` and exports a
 * default `Connector` definition. Adding a new provider is just dropping a
 * folder and registering it in `registry.ts`.
 */

// --- Notification side ------------------------------------------------------

/**
 * Two flavours of notification event:
 *   - 'waiting'  -> the agent has paused mid-task and needs a human to act
 *                   (e.g. a tool call awaiting approval).
 *   - 'finished' -> the agent has completed its turn with a final answer
 *                   and no pending tool calls.
 */
export type EventKind = 'waiting' | 'finished';

export interface AgentEvent {
  /** Stable id for the conversation/session. Used for de-dup and cooldowns. */
  sessionId: string;
  /** Human label for the producing tool: "Cursor", "Claude Code", etc. */
  agent: string;
  /** Which connector raised this event (matches Connector.id). */
  detectorId: string;
  kind: EventKind;
  /** Free-form short message to show in the notification body. */
  message: string;
  /** Optional title override. Defaults vary by kind. */
  title?: string;
  /** Optional file path the user might want to jump to. */
  source?: string;
  detectedAt: number;
}

/** Back-compat alias kept so older imports keep working. */
export type WaitingEvent = AgentEvent;

/**
 * Status of the last meaningful line in a transcript.
 *   - 'pending' : assistant message that contains a tool_use / function_call
 *                 with no following resolution. -> waiting.
 *   - 'final'   : assistant message with text only, no pending tool. -> finished.
 *   - 'tool'    : orphan tool_use / function_call line. -> waiting.
 *   - 'user'    : user is the last speaker; no event fires.
 *   - 'unknown' : couldn't classify; no event fires.
 */
export type LineStatus = 'user' | 'pending' | 'final' | 'tool' | 'unknown';

export interface Detector {
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
}

// --- Quota side -------------------------------------------------------------

/** Unit a bucket's `used`/`limit` values are expressed in. */
export type QuotaUnit = 'credits' | 'requests' | 'usd' | 'tokens' | 'percent';

/** One usage bucket (e.g. individual credits, team pool, per-model requests). */
export interface QuotaBucket {
  /** Stable id. Permanent — keys persisted star/hide/order prefs (`BucketPref`). */
  id: string;
  label: string;
  /**
   * `null` = not measured (this connector doesn't report the value) -> UI
   * shows "No data". `0` = measured and genuinely zero -> UI shows "$0.00" /
   * "0". Always populate a real number when the value is known, even if it's
   * zero — do not default an unmeasured value to `0`.
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
export type SpendPeriod = 'today' | 'yesterday' | 'last30d';

export interface SpendTile {
  period: SpendPeriod;
  label: string;
  /** Integer cents. `null` = not measured (never `0` for "no sessions this period"). */
  costCents: number | null;
  tokens: number | null;
  /** Optional trailing daily series (oldest -> newest), same null-vs-zero convention. */
  series?: Array<number | null>;
}

/**
 * Normalised quota snapshot every connector returns. Renderers and the tray
 * popup work off this shape exclusively, so adding a new connector doesn't
 * require any UI changes.
 */
export type QuotaSnapshot =
  | {
      ok: true;
      fetchedAt: number;
      buckets: QuotaBucket[];
      membershipType?: string;
      limitType?: string;
      billingCycleStart?: string;
      billingCycleEnd?: string;
      displayMessages: string[];
      authMethod?: 'bearer' | 'cookie' | 'api-key' | 'pat' | string;
      /** Optional one-line summary the connector wants in the tray tooltip. */
      trayLine?: string;
      /** Optional source path / URL for the UI's footnote. */
      source?: string;
      /** Optional cross-provider spend summary (Total Spend card). */
      spend?: SpendTile[];
    }
  | {
      ok: false;
      fetchedAt: number;
      error: string;
      /** Optional source path / URL the UI can show as "looked at:". */
      source?: string;
      /**
       * Set when the failure is because the user must sign in interactively
       * (e.g. claude.ai). The UI shows a "Sign in" button that triggers the
       * connector's login flow instead of just displaying the error.
       */
      needsLogin?: boolean;
    };

export interface QuotaProvider {
  fetch(): Promise<QuotaSnapshot>;
}

// --- Configuration schema ---------------------------------------------------

export interface ConnectorConfigField {
  key: string;
  label: string;
  /**
   * 'secret' fields are stored encrypted via Electron safeStorage and never
   * round-tripped to the renderer. They display as `<input type=password>`
   * with placeholder "(set)" once a value exists.
   *
   * 'enum' fields render as a `<select>` populated from `options`.
   */
  type: 'string' | 'number' | 'boolean' | 'paths' | 'secret' | 'enum';
  default: string | number | boolean | string[];
  help?: string;
  /** Which subsection this field belongs to. Defaults to 'notifications'. */
  section?: 'notifications' | 'quota' | 'general';
  /** Hide the field unless `quota` (or `notifications`) is enabled. */
  requiresEnabled?: 'notifications' | 'quota';
  /** For `type: 'enum'`: the available choices. */
  options?: Array<{ value: string; label: string }>;
}

// --- Connector definition ---------------------------------------------------

/**
 * Runtime context handed to every detector / quota provider when constructed.
 * The runtime injects `secret()` for safeStorage-backed values and `log()`
 * for structured logs that surface in the Logs tab.
 */
export interface ConnectorContext {
  /**
   * Emit an event from a detector. The runtime fills in `detectorId` and
   * `detectedAt`, and defaults `kind` to 'waiting' for back-compat.
   */
  emit(
    event: Omit<AgentEvent, 'detectorId' | 'detectedAt' | 'kind'> & {
      detectedAt?: number;
      kind?: EventKind;
    },
  ): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>): void;
  resolvePath(p: string): string;
  /**
   * Absolute path to a directory connectors may use for their own on-disk
   * caches (e.g. `shared/jsonl-spend-scanner.ts`'s per-day rollup cache).
   * Shared across all connectors (one directory), so a scanner instance
   * keyed by this path is reused rather than duplicated per connector — see
   * `JsonlSpendScanner.shared()`. The directory is created lazily by
   * whichever consumer first writes to it; the runtime does not pre-create
   * it.
   */
  cacheDir: string;
  /**
   * Look up a secret stored via SecretStore. Returns null when missing.
   * Secrets are namespaced as `<connectorId>::<key>`.
   */
  secret(key: string): string | null;
  /**
   * Persist a secret via SecretStore (encrypted).
   * Secrets are namespaced as `<connectorId>::<key>`.
   */
  setSecret(key: string, value: string): void;
}

export interface ConnectorLogin {
  /** Button label shown in the UI when `needsLogin: true` (e.g. "Sign in to Claude"). */
  label: string;
  /** Starts the interactive auth flow. Call `onComplete` when the user finishes. */
  handler: (ctx: ConnectorContext, onComplete: () => void) => void;
}

/**
 * Structured hint for the Integrate tab. The renderer uses this to build a
 * connector-agnostic code example without knowing the connector id.
 */
export interface ConnectorIntegrateInfo {
  type: 'http-notify';
  /** Config key holding the server host (e.g. 'host'). */
  hostKey: string;
  /** Config key holding the server port (e.g. 'port'). */
  portKey: string;
  /** Config key holding the optional auth token (e.g. 'token'). */
  tokenKey?: string;
}

export interface Connector {
  /** Stable identifier, matches settings key. */
  id: string;
  /** Display name shown in the UI card header. */
  name: string;
  /** Vendor / company, used for grouping and a small pill in the UI. */
  vendor: string;
  description: string;
  enabledByDefault: boolean;
  /** Settings fields rendered in the Integrations card. */
  configSchema: ConnectorConfigField[];
  /** Optional notification detector. Omit if the integration has no detector. */
  detector?: {
    create(config: Record<string, unknown>, ctx: ConnectorContext): Detector;
  };
  /** Optional quota provider. Omit if the integration has no quota source. */
  quota?: {
    /** Default poll interval in minutes if the user hasn't set an override. */
    defaultIntervalMinutes: number;
    create(config: Record<string, unknown>, ctx: ConnectorContext): QuotaProvider;
  };
  /** When true, the quota toggle is enabled by default for new installs. */
  quotaEnabledByDefault?: boolean;
  /** Interactive login flow. Declare when the quota provider can return `needsLogin: true`. */
  login?: ConnectorLogin;
  /** Hint for the Integrate tab. Declare when this connector acts as an HTTP server. */
  integrateInfo?: ConnectorIntegrateInfo;
  /** Optional brand accent color (hex). Falls back to an id-hash color in the renderer. */
  brandColor?: string;
}

// --- Persisted shape (used by SettingsStore + IPC) --------------------------

export interface ConnectorEnabled {
  notifications: boolean;
  quota: boolean;
}

/**
 * Per-bucket display prefs the user controls (star / hide / reorder). Lives
 * keyed by connector id then bucket id — *not* on `QuotaBucket` itself, since
 * buckets are rebuilt from scratch on every poll and prefs must survive that.
 */
export interface BucketPref {
  hidden?: boolean;
  starred?: boolean;
  order?: number;
  /**
   * Explicit user override of a bucket's effective visibility classification
   * (Customize tab's "Always Visible" / "On Demand" select). Distinct from
   * `hidden` — `hidden` removes the row entirely, `visibility` only decides
   * which section (main vs. on-demand) an otherwise-shown row lands in.
   * When unset, `renderMeterGroup` falls back to
   * `QuotaBucket.defaultVisibility ?? (hasLimit ? 'always' : 'onDemand')`,
   * unchanged from Phase 2a.
   */
  visibility?: 'always' | 'onDemand';
}

/** openusage-parity cap: at most this many starred buckets per connector (tray tooltip is fixed-width). */
export const MAX_STARRED_PER_CONNECTOR = 2;

export interface ConnectorRuntimeConfig {
  enabled: Record<string, ConnectorEnabled>;
  config: Record<string, Record<string, unknown>>;
  /** Optional per-connector poll interval override (minutes). 0 = manual. */
  pollOverrideMinutes?: Record<string, number>;
  /** Per-connector, per-bucket display prefs: bucketPrefs[connectorId][bucketId]. */
  bucketPrefs?: Record<string, Record<string, BucketPref>>;
}

// --- Public metadata sent to the renderer (no secrets) ----------------------

export interface ConnectorMetadata {
  id: string;
  name: string;
  vendor: string;
  description: string;
  enabledByDefault: boolean;
  hasDetector: boolean;
  hasQuota: boolean;
  defaultIntervalMinutes?: number;
  configSchema: ConnectorConfigField[];
  /** Which secret keys exist (so the UI can show "(set)" without value). */
  setSecretKeys?: string[];
  /** Login button label; present only when the connector declares a login flow. */
  loginLabel?: string;
  /** Integrate tab hint; present only when the connector acts as an HTTP server. */
  integrateInfo?: ConnectorIntegrateInfo;
  /** Optional brand accent color (hex). Falls back to an id-hash color in the renderer. */
  brandColor?: string;
}
