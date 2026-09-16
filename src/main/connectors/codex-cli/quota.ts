import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ConnectorContext, QuotaBucket, QuotaProvider, QuotaSnapshot, SpendTile } from '../types';
import { JsonlSpendScanner, SpendRecord } from '../shared/jsonl-spend-scanner';
import { costCentsFor } from '../shared/model-pricing';

const WHAM_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

const FIVE_HOUR_MS = 18_000_000;
const SEVEN_DAY_MS = 604_800_000;
const ONE_DAY_MS = 86_400_000;

// --- Credential file resolution --------------------------------------------
//
// READ-ONLY BY POLICY. This connector reads Codex CLI's `auth.json` and never
// writes it, and never refreshes the OAuth session itself. Both halves of that
// rule exist for verified reasons:
//
//   1. OpenAI's refresh tokens ROTATE. Redeeming one invalidates it, and
//      replaying a spent token is a permanent failure ("refresh token was
//      already used. Please log out and sign in again") that can only be
//      cleared by a fresh `codex login`. An earlier version of this file
//      POSTed to auth.openai.com/oauth/token and wrote the rotated tokens
//      back — so a refresh racing Codex's own refresh locked the user out of
//      the tool we are only supposed to be observing.
//   2. Codex's own `storage.rs` saves `auth.json` with a plain truncate+write
//      and no lock, and OpenAI's CI/CD guidance says not to share this file
//      between concurrent writers. There is no safe way for a second process
//      to write it, atomic temp-file rename included: the clobber happens
//      between Codex's read and its write, not during ours.
//
// Additionally, the old refresh body sent `scope: 'openid profile email'`,
// which Codex's own `RefreshRequest` does not have — we were sending a field
// the vendor client never sends.
//
// So: use the stored access token; when it is rejected, hand the user back to
// `codex login`. Do not add a refresh path here.

/** Candidate `auth.json` paths, in lookup order. Mirrors the session-path
 * defaults already declared in `index.ts`'s `configSchema` (`~/.codex`,
 * `%APPDATA%\codex`), plus `$CODEX_HOME` when set. All file-based — no
 * keychain, matching this connector's other credential reads.
 *
 * Which means a missing `auth.json` does NOT prove the user never logged in:
 * Codex supports `cli_auth_credentials_store = keyring`, under which the
 * tokens live in the OS keychain and no file is written at all. That is a
 * legitimate signed-in state this connector simply cannot read, so the
 * "not found" copy must say so rather than telling the user to log in again. */
function candidateAuthPaths(): string[] {
  const home = os.homedir();
  const out: string[] = [];
  const codexHome = process.env.CODEX_HOME;
  if (codexHome) out.push(path.join(codexHome, 'auth.json'));
  out.push(path.join(home, '.codex', 'auth.json'));
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    out.push(path.join(appData, 'codex', 'auth.json'));
  }
  return out;
}

interface AuthFileRaw {
  OPENAI_API_KEY?: string | null;
  tokens?: {
    id_token?: string;
    access_token?: string;
    account_id?: string;
  };
}

interface LoadedAuth {
  path: string;
  accessToken?: string;
  accountId?: string;
  apiKey?: string;
}

function loadAuthFile(): LoadedAuth | null {
  for (const p of candidateAuthPaths()) {
    if (!fs.existsSync(p)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as AuthFileRaw;
      const t = raw.tokens ?? {};
      return {
        path: p,
        accessToken: t.access_token,
        accountId: t.account_id,
        apiKey: raw.OPENAI_API_KEY ?? undefined,
      };
    } catch {
      // Malformed file — try the next candidate rather than failing outright.
      continue;
    }
  }
  return null;
}

// --- HTTP helpers ------------------------------------------------------------

async function httpJson(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; json: unknown }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { net } = require('electron') as typeof import('electron');
    if (net?.fetch) {
      // net.fetch has no built-in timeout -- without this, a single hung
      // wham/usage call never settles. QuotaService's fetchOne() clears
      // `inFlight` only in its `finally`, so the dead promise wedges every
      // future poll AND the Refresh button for this connector until the app
      // restarts -- and, via refreshAll()'s Promise.all, every other
      // connector's refresh with it.
      // Pattern matches the fixed helpers in zai/grok/openrouter.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const res = await net.fetch(url, { headers, signal: controller.signal });
        const txt = await res.text();
        try {
          return { status: res.status, json: txt ? JSON.parse(txt) : {} };
        } catch {
          return { status: res.status, json: {} };
        }
      } catch (err) {
        // A deliberate timeout-abort means the destination is unreachable or
        // slow either way -- falling through to the Node https fallback would
        // just pay the SAME 15s timeout again. Fail closed here (408).
        if (controller.signal.aborted) return { status: 408, json: {} };
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
  } catch {
    // fall through to Node https
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const https = require('https') as typeof import('https');
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: res.statusCode ?? 0, json: body ? JSON.parse(body) : {} });
        } catch {
          resolve({ status: res.statusCode ?? 0, json: {} });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error('Codex API timeout')));
  });
}

function authHeaders(accessToken: string, accountId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
  };
  if (accountId) headers['chatgpt-account-id'] = accountId;
  return headers;
}

/** Authenticated GET against the ChatGPT backend. No refresh-on-401: see the
 * read-only policy note above the credential-file section. */
async function fetchAuthed(url: string, auth: LoadedAuth): Promise<{ status: number; json: unknown }> {
  if (!auth.accessToken) return { status: 401, json: {} };
  return httpJson(url, authHeaders(auth.accessToken, auth.accountId));
}

// --- Response parsing ---------------------------------------------------------
//
// `wham/usage` is an undocumented internal endpoint, but its body is NOT a
// guess any more: the shapes below are confirmed against the openai/codex
// source tree (Sept 2026) --
//   * `codex-rs/codex-backend-openapi-models/src/models/rate_limit_status_details.rs`
//     (and its sibling window/credits models) for the field names, and
//   * the app-server fixture in `codex-rs/app-server/tests/suite/v2/rate_limits.rs`
//     for a full example body.
//
// An earlier version of this file read `rate_limits.primary.window_minutes` /
// `resets_at`, which exists nowhere on the wire -- that is the INTERNAL
// protocol/rollout shape, not the HTTP response. Every poll therefore produced
// zero buckets and tripped the drift warning below. The real body is:
//
//   {
//     "plan_type": "pro",
//     "rate_limit": {                       // singular
//       "allowed": true, "limit_reached": false,
//       "primary_window":   { "used_percent": 12.5, "limit_window_seconds": 18000,
//                             "reset_after_seconds": 1234, "reset_at": "..." },
//       "secondary_window": { ... same shape, "limit_window_seconds": 604800 }
//     },
//     "additional_rate_limits": [
//       { "limit_name": "...", "metered_feature": "...",
//         "normal_model_slug": "gpt-5.3-codex", "rate_limit": { ...window... } }
//     ],
//     "credits": { "has_credits": true, "unlimited": false, "balance": 0, ... },
//     "rate_limit_reset_credits": { "available_count": 0 }
//   }
//
// Parsing stays defensive anyway (same approach as `anthropic/quota.ts`'s
// `parseClaudeAiUsage`): an unrecognised shape yields a missing bucket, never
// a fabricated `0` or a `NaN`.

/** `Number('')` is `0`, so an empty or whitespace-only string is rejected
 * before it can become a fabricated measured zero — the same guard cursor,
 * zai, devin, grok and antigravity carry. */
function firstFiniteNumber(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim() === '') continue;
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

/** Epoch ms from a timestamp field, OR from a "resets in N seconds" field. */
function resetsAtFrom(tsRaw: unknown, secondsFromNowRaw: unknown): number | null {
  if (tsRaw != null) {
    const ms =
      typeof tsRaw === 'number' ? (tsRaw > 1e10 ? tsRaw : tsRaw * 1000) : new Date(String(tsRaw)).getTime();
    if (Number.isFinite(ms)) return ms;
  }
  const seconds = firstFiniteNumber(secondsFromNowRaw);
  if (seconds != null) return Date.now() + seconds * 1000;
  return null;
}

interface ParsedWindow {
  usedPercent: number;
  windowMs: number | null;
  resetsAt: number | null;
}

/** One `RateLimitWindow`. `limit_window_seconds` is SECONDS (the old code read
 * a `window_minutes` field that does not exist), and the reset timestamp is
 * `reset_at`, with `reset_after_seconds` as the relative form. */
export function parseRateWindow(raw: unknown): ParsedWindow | null {
  const r = asRecord(raw);
  if (!r) return null;
  const usedPercent = firstFiniteNumber(r.used_percent);
  if (usedPercent == null) return null;
  const windowSeconds = firstFiniteNumber(r.limit_window_seconds);
  return {
    usedPercent,
    windowMs: windowSeconds != null ? windowSeconds * 1000 : null,
    resetsAt: resetsAtFrom(r.reset_at, r.reset_after_seconds),
  };
}

function windowBucket(
  id: string,
  label: string,
  w: ParsedWindow,
  fallbackWindowMs: number,
): QuotaBucket {
  const bucket: QuotaBucket = {
    id,
    label,
    used: w.usedPercent,
    limit: 100,
    remaining: Math.max(0, 100 - w.usedPercent),
    unit: 'percent',
    enabled: true,
  };
  // Only set resetsAt/windowMs together, and only when the API actually gave
  // us a reset — never synthesize one (Phase 2a's reverted mistake).
  if (w.resetsAt != null) {
    bucket.resetsAt = w.resetsAt;
    bucket.windowMs = w.windowMs ?? fallbackWindowMs;
  }
  return bucket;
}

type WindowSlot = 'session' | 'weekly';

/**
 * Which bucket a window belongs in, decided by its DURATION rather than by
 * which JSON key carried it. Since ~July 2026 OpenAI has been observed
 * returning the weekly window (`limit_window_seconds: 604800`) as
 * `primary_window`, with the 5-hour window in the secondary slot or under
 * `additional_rate_limits` — so slot position is not a reliable label. Same
 * heuristic (and the same strict `<`, so an exactly-24h window reads as the
 * longer cadence) as `zai/quota.ts`'s classifier. `positional` is only the
 * last resort for a window that reports no duration at all.
 */
function classifyWindow(w: ParsedWindow, positional: WindowSlot): WindowSlot {
  if (w.windowMs == null) return positional;
  return w.windowMs < ONE_DAY_MS ? 'session' : 'weekly';
}

/** Normalizes a model name into a stable bucket-id fragment. Bucket ids are
 * permanent settings keys, so two spellings of the same model (casing or
 * whitespace) must never mint two different ids. Exported for smoke coverage. */
export function slugifyModel(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-');
}

/** The per-entry `rate_limit` in `additional_rate_limits[]` is sometimes a
 * bare window and sometimes the same primary/secondary container as the
 * top-level field, so yield whatever windows it holds with their positional
 * default. */
function windowsOf(raw: unknown): Array<{ window: ParsedWindow; positional: WindowSlot }> {
  const out: Array<{ window: ParsedWindow; positional: WindowSlot }> = [];
  const container = asRecord(raw);
  if (!container) return out;
  if ('primary_window' in container || 'secondary_window' in container) {
    const primary = parseRateWindow(container.primary_window);
    if (primary) out.push({ window: primary, positional: 'session' });
    const secondary = parseRateWindow(container.secondary_window);
    if (secondary) out.push({ window: secondary, positional: 'weekly' });
    return out;
  }
  const bare = parseRateWindow(container);
  if (bare) out.push({ window: bare, positional: 'session' });
  return out;
}

/**
 * Per-model / per-feature buckets from `additional_rate_limits[]`. This
 * replaced a `per_model` / `spark` / `model_limits` probe that was written
 * against a shape nobody ever observed; no user has prefs keyed to those old
 * `spark-*` ids, so the id namespace changed to `model-<slug>-<slot>` with
 * it. Deduped by id (last entry wins) so a slug collision inside one response
 * produces exactly one bucket, not two competing for the same settings key.
 * Exported for smoke coverage.
 */
export function buildAdditionalLimitBuckets(raw: unknown): QuotaBucket[] {
  if (!Array.isArray(raw)) return [];
  const out = new Map<string, QuotaBucket>();
  for (const entry of raw) {
    const e = asRecord(entry);
    if (!e) continue;
    const slugSource =
      typeof e.normal_model_slug === 'string' && e.normal_model_slug.trim()
        ? e.normal_model_slug
        : typeof e.limit_name === 'string' && e.limit_name.trim()
          ? e.limit_name
          : typeof e.metered_feature === 'string' && e.metered_feature.trim()
            ? e.metered_feature
            : null;
    if (!slugSource) continue;
    const label =
      (typeof e.limit_name === 'string' && e.limit_name.trim() ? e.limit_name.trim() : null) ??
      slugSource.trim();
    const slug = slugifyModel(slugSource);

    for (const { window, positional } of windowsOf(e.rate_limit)) {
      const slot = classifyWindow(window, positional);
      const id = `model-${slug}-${slot}`;
      const suffix = slot === 'session' ? '5h' : 'weekly';
      out.set(
        id,
        windowBucket(id, `${label} (${suffix})`, window, slot === 'session' ? FIVE_HOUR_MS : SEVEN_DAY_MS),
      );
    }
  }
  return [...out.values()];
}

/** `credits`: prepaid Codex credit balance. `unlimited` accounts have no
 * meaningful number, so they render as an unlimited bucket rather than a
 * fabricated `0`. */
function parseCreditsBucket(raw: unknown): QuotaBucket | null {
  const r = asRecord(raw);
  if (!r) return null;
  if (r.unlimited === true) {
    return {
      id: 'credits',
      label: 'Credits (unlimited)',
      used: null,
      limit: null,
      remaining: null,
      unit: 'credits',
      enabled: true,
      defaultVisibility: 'onDemand',
    };
  }
  const balance = firstFiniteNumber(r.balance);
  if (balance == null) return null;
  const bucket: QuotaBucket = {
    id: 'credits',
    label: 'Credits',
    used: null,
    limit: null,
    remaining: balance,
    unit: 'credits',
    enabled: true,
    defaultVisibility: 'onDemand',
  };
  if (r.has_credits === false) bucket.note = 'no credits available';
  return bucket;
}

/** `rate_limit_reset_credits`: one-off credits that clear a hit rate limit
 * early. The wire shape carries a single `available_count` — the old probe
 * for `granted_credits` / `expires_at` and an expiry-tier note was written
 * against a shape that does not exist. */
function parseResetCreditsBucket(raw: unknown): QuotaBucket | null {
  const r = asRecord(raw);
  if (!r) return null;
  const available = firstFiniteNumber(r.available_count);
  if (available == null) return null;
  return {
    id: 'reset-credits',
    label: 'Reset credits',
    used: null,
    limit: null,
    remaining: available,
    unit: 'credits',
    enabled: true,
    defaultVisibility: 'onDemand',
  };
}

export interface ParsedUsage {
  buckets: QuotaBucket[];
  planType?: string;
  /** How many rate-limit windows were recognised. The drift warning keys on
   * this, not on `buckets.length`: a body carrying only `credits` would
   * otherwise look healthy while every usage meter was silently missing. */
  windowCount: number;
}

/** Exported for smoke coverage. */
export function parseUsageBuckets(json: Record<string, unknown>): ParsedUsage {
  const buckets: QuotaBucket[] = [];
  const claimed = new Map<WindowSlot, QuotaBucket>();
  let windowCount = 0;

  for (const { window, positional } of windowsOf(json.rate_limit)) {
    windowCount += 1;
    const slot = classifyWindow(window, positional);
    if (claimed.has(slot)) continue;
    claimed.set(
      slot,
      slot === 'session'
        ? windowBucket('session', 'Session (5h)', window, FIVE_HOUR_MS)
        : windowBucket('weekly', 'Weekly', window, SEVEN_DAY_MS),
    );
  }
  const session = claimed.get('session');
  if (session) buckets.push(session);
  const weekly = claimed.get('weekly');
  if (weekly) buckets.push(weekly);

  const modelBuckets = buildAdditionalLimitBuckets(json.additional_rate_limits);
  windowCount += modelBuckets.length;
  buckets.push(...modelBuckets);

  const credits = parseCreditsBucket(json.credits);
  if (credits) buckets.push(credits);

  const resetCredits = parseResetCreditsBucket(json.rate_limit_reset_credits);
  if (resetCredits) buckets.push(resetCredits);

  const planType = typeof json.plan_type === 'string' ? json.plan_type : undefined;
  return { buckets, planType, windowCount };
}

// --- Local spend scan (Phase 4) -----------------------------------------------
//
// A completely different data source from everything above: this reads
// Codex CLI's own local session/rollout JSONL files instead of the wham
// API, to estimate spend the same way openusage does for tools without a
// billing endpoint.
//
// CONFIDENCE: LOW, unverified against a real sample. Unlike claude-code's
// spend extractor (verified against an actual local transcript during
// Phase 4), this dev machine has never run Codex CLI --
// `~/.codex/sessions` doesn't exist here -- so the field names below are a
// best-effort port of the openai/codex rollout schema as documented in
// training data, not a confirmed live shape. `extractCodexSpend` is
// deliberately defensive: any shape it doesn't recognise returns `null`
// per line, never a fabricated number. Worst case today, codex-cli's
// spend tiles show "No data" until these probes are corrected against a
// real rollout file.

// Mirrors codex-cli/index.ts's `configSchema.paths` default, plus archived
// sessions (not part of the detector's own paths, since the detector only
// needs to watch live sessions for notifications).
const DEFAULT_SPEND_PATHS = [
  '~/.codex/sessions/**/*.jsonl',
  '~/AppData/Roaming/codex/sessions/**/*.jsonl',
  '~/.codex/archived_sessions/**/*.jsonl',
  '~/AppData/Roaming/codex/archived_sessions/**/*.jsonl',
];

/**
 * `extractCodexSpend` is called once per line with no cross-line state, but
 * a rollout file is believed to declare its model once early on (a
 * session/turn-context line) and not repeat it on every later token-usage
 * event. This small file-keyed map lets a model seen earlier in a file
 * inform a cost line seen later in the SAME file -- safe because
 * `JsonlSpendScanner` always parses a file's lines top-to-bottom. A stale
 * entry for a file that stops matching is harmless; it just falls out of
 * use.
 */
const fileModelHints = new Map<string, string>();

/**
 * `total_token_usage`'s name strongly suggests a running CUMULATIVE session
 * total, not a per-event delta -- unverified either way (see the CONFIDENCE
 * note above). Summing every event's raw value would silently INFLATE
 * spend if the field really is cumulative, a worse failure than under-
 * counting. Fix (correction round, item 2): emit the DELTA versus the
 * previous token_count event seen for the same file rather than the raw
 * value, so `JsonlSpendScanner`'s existing per-line additive summing
 * telescopes back to exactly the last raw value for a same-day session (the
 * common case) -- equivalent to "last value wins" without needing an
 * end-of-file hook, and still cache-compatible (a cache hit skips extract()
 * entirely, so this per-process state never needs to survive a restart).
 * Known limitation: a session spanning midnight attributes each delta to
 * the day it was actually observed rather than dumping the whole total on
 * the final day -- a deliberate deviation from a literal single last-value
 * record, flagged in the Phase 4 correction report. If a raw value ever
 * decreases (e.g. the field turns out to be per-event, not cumulative), the
 * delta is floored at 0 rather than going negative -- under-counts, never
 * inflates.
 */
const fileCumulativeState = new Map<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number }>();

// --- Restart persistence for fileCumulativeState (correction round 2, item 2) ---
//
// `JsonlSpendScanner`'s own cache (`scannedBytes` + day-rollups) correctly
// persists to disk and resumes incremental byte-range scanning after a
// restart -- but that means `extractCodexSpend` is only ever called on the
// NEW bytes post-restart, never re-invoked on already-scanned content that
// would otherwise re-prime `fileCumulativeState`'s in-memory baseline. Left
// unpersisted, the first token_count event parsed after a restart would
// compute its delta against a false baseline of 0, fabricating a one-time
// spike roughly equal to the file's entire cumulative total -- exactly the
// inflation failure this delta scheme exists to prevent, just moved to the
// restart boundary. Fix: persist this tiny map alongside the scanner's own
// cache, under the same `ctx.cacheDir`, loaded once and written debounced.
const CUMULATIVE_STATE_FILENAME = 'codex-cumulative-state.json';
let cumulativeStateLoadedFrom: string | null = null;
let cumulativeStateWriteTimer: ReturnType<typeof setTimeout> | null = null;

function cumulativeStateFile(cacheDir: string): string {
  return path.join(cacheDir, CUMULATIVE_STATE_FILENAME);
}

/** Loads the persisted per-file cumulative baselines into `fileCumulativeState`
 * (merging, never clearing already-in-memory entries), idempotent per
 * `cacheDir` so it's safe to call at the start of every `computeSpend()`.
 * Missing/corrupt file -> start with whatever's already in memory, never throw. */
export function ensureCumulativeStateLoaded(cacheDir: string): void {
  if (cumulativeStateLoadedFrom === cacheDir) return;
  cumulativeStateLoadedFrom = cacheDir;
  try {
    const raw = fs.readFileSync(cumulativeStateFile(cacheDir), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number }> | null;
    if (parsed && typeof parsed === 'object') {
      for (const [file, entry] of Object.entries(parsed)) {
        if (entry && typeof entry === 'object' && !fileCumulativeState.has(file)) fileCumulativeState.set(file, entry);
      }
    }
  } catch {
    // missing/corrupt cache file -- start empty, never throw
  }
}

/** Synchronously writes `fileCumulativeState` to disk. Exported for smoke
 * coverage (deterministic restart-scenario testing); production code uses
 * the debounced `scheduleCumulativeStateWrite` below instead. */
export function flushCumulativeState(cacheDir: string): void {
  try {
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cumulativeStateFile(cacheDir), JSON.stringify(Object.fromEntries(fileCumulativeState)), 'utf8');
  } catch {
    // best-effort -- a failed write must never break spend scanning
  }
}

/** Debounced persistence, mirroring the pattern `JsonlSpendScanner` already
 * uses for its own cache file. */
function scheduleCumulativeStateWrite(cacheDir: string): void {
  if (cumulativeStateWriteTimer) clearTimeout(cumulativeStateWriteTimer);
  cumulativeStateWriteTimer = setTimeout(() => {
    cumulativeStateWriteTimer = null;
    flushCumulativeState(cacheDir);
  }, 500);
  if (typeof cumulativeStateWriteTimer.unref === 'function') cumulativeStateWriteTimer.unref();
}

function firstNonEmptyString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/** Same numeric-epoch handling as `resetsAtFrom` above -- returns `null`
 * (never a fabricated "now") for a missing or unparseable timestamp. */
function parseTsMs(raw: unknown): number | null {
  if (raw == null) return null;
  const ms = typeof raw === 'number' ? (raw > 1e10 ? raw : raw * 1000) : new Date(String(raw)).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** See the CONFIDENCE note above the `DEFAULT_SPEND_PATHS` block. Exported for smoke coverage. */
export function extractCodexSpend(line: unknown, file: string): SpendRecord | null {
  if (!line || typeof line !== 'object') return null;
  const obj = line as Record<string, unknown>;

  // Remember the model as soon as any line declares it, most-specific probe first.
  const payloadRaw = obj.payload && typeof obj.payload === 'object' ? (obj.payload as Record<string, unknown>) : obj;
  const declaredModel = firstNonEmptyString(payloadRaw.model, obj.model, obj.model_slug);
  if (declaredModel) fileModelHints.set(file, declaredModel);

  const payloadType = typeof payloadRaw.type === 'string' ? payloadRaw.type : obj.type;
  if (payloadType !== 'token_count') return null;

  const infoRaw =
    payloadRaw.info && typeof payloadRaw.info === 'object' ? (payloadRaw.info as Record<string, unknown>) : payloadRaw;
  const usageRaw =
    infoRaw.total_token_usage && typeof infoRaw.total_token_usage === 'object'
      ? (infoRaw.total_token_usage as Record<string, unknown>)
      : infoRaw;

  const rawInputTokens = firstFiniteNumber(usageRaw.input_tokens) ?? 0;
  const rawCachedInputTokens = firstFiniteNumber(usageRaw.cached_input_tokens) ?? 0;
  const rawOutputTokens = firstFiniteNumber(usageRaw.output_tokens) ?? 0;

  // Correction item 1: apply the same numeric-epoch handling `resetsAtFrom`
  // already has above, and return null (never `Date.now()`) when the
  // timestamp is genuinely absent/unparseable -- a fabricated "now"
  // timestamp would silently misattribute this record's cost to today.
  const tsRaw = obj.timestamp ?? payloadRaw.timestamp;
  const ts = parseTsMs(tsRaw);
  if (ts == null) return null;

  // Correction item 2: convert the (possibly cumulative) raw counters into a
  // delta versus this file's last-seen values -- see the comment on
  // `fileCumulativeState` above.
  const prev = fileCumulativeState.get(file) ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  const inputTokens = Math.max(0, rawInputTokens - prev.inputTokens);
  const outputTokens = Math.max(0, rawOutputTokens - prev.outputTokens);
  const cachedInputTokens = Math.max(0, rawCachedInputTokens - prev.cacheReadTokens);
  fileCumulativeState.set(file, {
    inputTokens: rawInputTokens,
    outputTokens: rawOutputTokens,
    cacheReadTokens: rawCachedInputTokens,
  });
  if (inputTokens === 0 && outputTokens === 0 && cachedInputTokens === 0) return null;

  const model = declaredModel ?? fileModelHints.get(file);

  // OpenAI's documented service-tier concept ('auto'|'default'|'flex'|'priority').
  // Only 'priority' is treated as a surcharge -- 'flex' is commonly a
  // REDUCED-cost/slower tier (the opposite direction), so applying the
  // fastTierMultiplier to it would be backwards; excluded per correction
  // round SUGGESTION until verified against a real rollout file.
  const serviceTier = firstNonEmptyString(payloadRaw.service_tier, infoRaw.service_tier, usageRaw.service_tier);
  const fastTier = serviceTier === 'priority';

  const costCents = model
    ? costCentsFor(model, { inputTokens, outputTokens, cacheReadTokens: cachedInputTokens, fastTier })
    : null;

  return {
    ts,
    costCents,
    inputTokens,
    outputTokens,
    cacheReadTokens: cachedInputTokens,
    model,
  };
}

// --- Provider ------------------------------------------------------------------

class CodexCliQuotaProvider implements QuotaProvider {
  constructor(
    private readonly config: Record<string, unknown>,
    private readonly ctx: ConnectorContext,
  ) {}

  async fetch(): Promise<QuotaSnapshot> {
    const snapshot = await this.fetchQuota();
    if (!snapshot.ok) return snapshot;
    try {
      const spend = await this.computeSpend();
      return { ...snapshot, spend };
    } catch (err) {
      this.ctx.log('warn', '[codex-cli] local spend scan failed', { err: String(err) });
      return snapshot;
    }
  }

  /** Local-spend scan (Phase 4) over Codex CLI's own session/rollout JSONL
   * files -- a completely different data source from `fetchQuota()`'s wham
   * API buckets above. Non-fatal: any failure here is caught by `fetch()`
   * and simply omits `spend`, never fails the whole snapshot. */
  private async computeSpend(): Promise<SpendTile[]> {
    // Restart-safety for the delta-tracking in extractCodexSpend (correction
    // round 2, item 2) -- must run before scan() so a post-restart delta is
    // computed against the true last-seen baseline, not a reset-to-0 one.
    ensureCumulativeStateLoaded(this.ctx.cacheDir);

    const rawPaths = this.config.paths as string[] | undefined;
    const patterns = [
      ...(rawPaths && rawPaths.length ? rawPaths : DEFAULT_SPEND_PATHS),
      // Archived sessions aren't part of the detector's own watch paths
      // (see DEFAULT_SPEND_PATHS's comment) -- always include them here
      // even when the user customised `paths` for notifications.
      ...(rawPaths && rawPaths.length
        ? ['~/.codex/archived_sessions/**/*.jsonl', '~/AppData/Roaming/codex/archived_sessions/**/*.jsonl']
        : []),
    ].map(p => this.ctx.resolvePath(p));
    const scanner = JsonlSpendScanner.shared(this.ctx.cacheDir);
    const records = await scanner.scan({
      key: 'codex-cli',
      patterns,
      extract: extractCodexSpend,
    });
    scheduleCumulativeStateWrite(this.ctx.cacheDir);
    return scanner.aggregate(records, Date.now());
  }

  private async fetchQuota(): Promise<QuotaSnapshot> {
    const fetchedAt = Date.now();
    const auth = loadAuthFile();

    if (!auth) {
      return {
        ok: false,
        fetchedAt,
        error:
          'No Codex auth.json found (looked at $CODEX_HOME, ~/.codex, and %APPDATA%\\codex). ' +
          'Run `codex login` to sign in with ChatGPT — or, if Codex is configured with ' +
          '`cli_auth_credentials_store = keyring`, your tokens live in the OS keychain ' +
          'instead of a file and this connector cannot read them.',
      };
    }
    if (!auth.accessToken) {
      return {
        ok: false,
        fetchedAt,
        needsLogin: true,
        error: auth.apiKey
          ? 'This Codex CLI session uses an OpenAI API key, which the ChatGPT usage endpoints don\'t accept. ' +
            'Run `codex login` with ChatGPT to see quota here, or use the OpenAI connector for API-key org usage.'
          : 'Codex CLI is not signed in. Run `codex login` to sign in with ChatGPT.',
        source: auth.path,
      };
    }

    try {
      const usageRes = await fetchAuthed(WHAM_USAGE_URL, auth);
      if (usageRes.status === 401 || usageRes.status === 403) {
        // Deliberately no in-process refresh — see the policy note above
        // `candidateAuthPaths`. Starting Codex refreshes the session on its
        // own, so the user usually does not even need an explicit login.
        return {
          ok: false,
          fetchedAt,
          needsLogin: true,
          error:
            'Codex session expired. Run `codex login` (or just start Codex, which refreshes ' +
            'its own session) and refresh here.',
          source: auth.path,
        };
      }
      if (usageRes.status >= 400) {
        return { ok: false, fetchedAt, error: `Codex usage API HTTP ${usageRes.status}`, source: auth.path };
      }

      const { buckets, planType, windowCount } = parseUsageBuckets(
        (usageRes.json ?? {}) as Record<string, unknown>,
      );
      if (windowCount === 0) {
        // A 200 with no recognisable rate-limit window means the undocumented
        // API shape drifted, not that usage is genuinely empty — surface it
        // so this doesn't silently look like a normal quiet connector.
        this.ctx.log('warn', '[codex-cli] wham/usage returned 200 but no recognisable rate-limit window', {
          keys: Object.keys((usageRes.json as Record<string, unknown>) ?? {}),
        });
      }

      return {
        ok: true,
        fetchedAt,
        buckets,
        membershipType: planType ?? 'Codex (ChatGPT)',
        displayMessages: [],
        authMethod: 'bearer',
        source: WHAM_USAGE_URL,
      };
    } catch (err) {
      return { ok: false, fetchedAt, error: `Could not fetch Codex usage: ${String(err)}`, source: auth.path };
    }
  }
}

export function createCodexCliQuotaProvider(
  config: Record<string, unknown>,
  ctx: ConnectorContext,
): QuotaProvider {
  return new CodexCliQuotaProvider(config, ctx);
}
