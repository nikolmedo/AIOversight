import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ConnectorContext, QuotaBucket, QuotaProvider, QuotaSnapshot, SpendTile } from '../types';
import { JsonlSpendScanner, SpendRecord } from '../shared/jsonl-spend-scanner';
import { costCentsFor } from '../shared/model-pricing';

const WHAM_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const WHAM_RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';

// Client id the official Codex CLI uses for its ChatGPT OAuth login. Not
// publicly documented by OpenAI; sourced from the codex-rs login flow. If
// this ever stops working, refresh will simply fail closed (ok:false) —
// never silently fabricate data.
const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

const FIVE_HOUR_MS = 18_000_000;
const SEVEN_DAY_MS = 604_800_000;

// --- Credential file resolution --------------------------------------------

/** Candidate `auth.json` paths, in lookup order. Mirrors the session-path
 * defaults already declared in `index.ts`'s `configSchema` (`~/.codex`,
 * `%APPDATA%\codex`), plus `$CODEX_HOME` when set. All file-based — no
 * keychain, matching this connector's other credential reads. */
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

interface AuthTokensRaw {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  account_id?: string;
}

interface AuthFileRaw {
  OPENAI_API_KEY?: string | null;
  tokens?: AuthTokensRaw;
  last_refresh?: string;
  [key: string]: unknown;
}

interface AuthTokens {
  idToken?: string;
  accessToken?: string;
  refreshToken?: string;
  accountId?: string;
  apiKey?: string;
}

interface LoadedAuth {
  path: string;
  raw: AuthFileRaw;
  tokens: AuthTokens;
}

function loadAuthFile(): LoadedAuth | null {
  for (const p of candidateAuthPaths()) {
    if (!fs.existsSync(p)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as AuthFileRaw;
      const t = raw.tokens ?? {};
      return {
        path: p,
        raw,
        tokens: {
          idToken: t.id_token,
          accessToken: t.access_token,
          refreshToken: t.refresh_token,
          accountId: t.account_id,
          apiKey: raw.OPENAI_API_KEY ?? undefined,
        },
      };
    } catch {
      // Malformed file — try the next candidate rather than failing outright.
      continue;
    }
  }
  return null;
}

/** Writes `data` to `filePath` atomically via a same-directory temp file +
 * rename, so a crash/interrupt mid-write leaves the original untouched
 * instead of truncated. The rename only fires once the temp write fully
 * succeeded. Preserves the original file's permission mode (e.g. `0600`) by
 * `chmod`-ing the temp file before the rename — a plain `writeFileSync` would
 * otherwise silently widen it to Node's default `0666`-minus-umask on every
 * refresh. If the file doesn't exist yet, defaults to owner-only `0600`.
 * Returns whether it succeeded. Exported for smoke coverage. */
export function atomicWriteFile(filePath: string, data: string): boolean {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  let mode = 0o600;
  try {
    mode = fs.statSync(filePath).mode;
  } catch {
    // Original doesn't exist yet (first-ever write) — keep the 0o600 default.
  }
  try {
    fs.writeFileSync(tmpPath, data);
    fs.chmodSync(tmpPath, mode);
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup
    }
    return false;
  }
}

/** Write rotated tokens back into the same auth.json, preserving unknown
 * fields. This is the only connector that writes to another tool's own
 * credential store — a failed write must never corrupt the original file
 * (see `atomicWriteFile`) and must be visible rather than silently
 * swallowed, since it can otherwise lock the separate `codex` CLI out. */
function writeTokensBack(auth: LoadedAuth, ctx: ConnectorContext): void {
  const next: AuthFileRaw = {
    ...auth.raw,
    tokens: {
      ...(auth.raw.tokens ?? {}),
      id_token: auth.tokens.idToken,
      access_token: auth.tokens.accessToken,
      refresh_token: auth.tokens.refreshToken,
      account_id: auth.tokens.accountId,
    },
    last_refresh: new Date().toISOString(),
  };
  const ok = atomicWriteFile(auth.path, JSON.stringify(next, null, 2));
  if (!ok) {
    ctx.log('warn', '[codex-cli] failed to persist refreshed auth.json — original file left untouched', {
      path: auth.path,
    });
  }
}

// --- HTTP helpers ------------------------------------------------------------

async function httpJson(
  url: string,
  init: { method?: string; headers: Record<string, string>; body?: string },
): Promise<{ status: number; json: unknown }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { net } = require('electron') as typeof import('electron');
    if (net?.fetch) {
      // net.fetch has no built-in timeout -- without this, a single hung
      // wham/usage or OAuth-refresh call never settles. QuotaService's
      // fetchOne() clears `inFlight` only in its `finally`, so the dead
      // promise wedges every future poll AND the Refresh button for this
      // connector until the app restarts -- and, via refreshAll()'s
      // Promise.all, every other connector's refresh with it.
      // Pattern matches the fixed helpers in zai/grok/openrouter.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const res = await net.fetch(url, {
          method: init.method ?? 'GET',
          headers: init.headers,
          body: init.body,
          signal: controller.signal,
        });
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
    const headers = { ...init.headers };
    if (init.body) headers['Content-Length'] = String(Buffer.byteLength(init.body));
    const req = https.request(
      url,
      { method: init.method ?? 'GET', headers },
      res => {
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
      },
    );
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error('Codex API timeout')));
    if (init.body) req.write(init.body);
    req.end();
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

/** Refresh the ChatGPT OAuth session. Returns null (never throws) on any failure. */
async function refreshAccessToken(
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken?: string; idToken?: string } | null> {
  try {
    const res = await httpJson(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: CODEX_OAUTH_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: 'openid profile email',
      }),
    });
    if (res.status >= 400) return null;
    const json = res.json as { access_token?: string; refresh_token?: string; id_token?: string };
    if (!json.access_token) return null;
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      idToken: json.id_token,
    };
  } catch {
    return null;
  }
}

/** GET with exactly one 401/403 retry after a token refresh, rotating auth.json on success. */
async function fetchWithRefresh(
  url: string,
  auth: LoadedAuth,
  ctx: ConnectorContext,
): Promise<{ status: number; json: unknown }> {
  if (!auth.tokens.accessToken) return { status: 401, json: {} };
  let res = await httpJson(url, { headers: authHeaders(auth.tokens.accessToken, auth.tokens.accountId) });
  if ((res.status === 401 || res.status === 403) && auth.tokens.refreshToken) {
    const refreshed = await refreshAccessToken(auth.tokens.refreshToken);
    if (refreshed) {
      auth.tokens.accessToken = refreshed.accessToken;
      if (refreshed.refreshToken) auth.tokens.refreshToken = refreshed.refreshToken;
      if (refreshed.idToken) auth.tokens.idToken = refreshed.idToken;
      writeTokensBack(auth, ctx);
      res = await httpJson(url, { headers: authHeaders(auth.tokens.accessToken, auth.tokens.accountId) });
    }
  }
  return res;
}

// --- Response parsing ---------------------------------------------------------
//
// `wham/usage` and `wham/rate-limit-reset-credits` are undocumented internal
// endpoints. Field names below are best-effort and probed defensively (same
// approach as `anthropic/quota.ts`'s `parseClaudeAiUsage`): an unrecognised
// shape yields a missing bucket, never a fabricated `0` or a `NaN`.

function firstFiniteNumber(...vals: unknown[]): number | null {
  for (const v of vals) {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (Number.isFinite(n)) return n;
  }
  return null;
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

function parseRateWindow(raw: unknown): ParsedWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const usedPercent = firstFiniteNumber(r.used_percent, r.usage_percent, r.percent_used);
  if (usedPercent == null) return null;
  const windowMinutes = firstFiniteNumber(r.window_minutes, r.window_duration_minutes);
  const windowMs = windowMinutes != null ? windowMinutes * 60_000 : null;
  const resetsAt = resetsAtFrom(r.resets_at ?? r.reset_at, r.resets_in_seconds ?? r.reset_after_seconds);
  return { usedPercent, windowMs, resetsAt };
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

/** Normalizes a model name into a stable bucket-id fragment, independent of
 * whether the API response used an array or a keyed-object shape — bucket
 * ids are permanent settings keys, so two shapes describing the same model
 * must never mint two different ids. Exported for smoke coverage. */
export function slugifyModel(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-');
}

/** Builds the per-model "Spark" buckets, deduped by normalized model slug
 * (last entry for a given slug wins) so a slug collision within one response
 * — from casing/whitespace differences or the array-vs-object shape — still
 * produces exactly one bucket, not two competing for the same id. */
export function buildSparkBuckets(
  perModel: Array<Record<string, unknown>> | Record<string, unknown> | undefined,
): QuotaBucket[] {
  const out = new Map<string, QuotaBucket>();
  const add = (rawModel: string | undefined, raw: unknown) => {
    if (!rawModel) return;
    const w = parseRateWindow(raw);
    if (!w) return;
    const slug = slugifyModel(rawModel);
    out.set(slug, windowBucket(`spark-${slug}`, `${rawModel} (Spark)`, w, FIVE_HOUR_MS));
  };
  if (Array.isArray(perModel)) {
    for (const entry of perModel) {
      const model =
        typeof entry.model === 'string' ? entry.model : typeof entry.name === 'string' ? entry.name : undefined;
      add(model, entry);
    }
  } else if (perModel && typeof perModel === 'object') {
    for (const [model, raw] of Object.entries(perModel)) add(model, raw);
  }
  return [...out.values()];
}

function parseUsageBuckets(json: Record<string, unknown>): { buckets: QuotaBucket[]; planType?: string } {
  const buckets: QuotaBucket[] = [];
  const rateLimits = (json.rate_limits as Record<string, unknown> | undefined) ?? json;

  const primary = parseRateWindow(rateLimits.primary ?? json.session ?? json.five_hour);
  if (primary) buckets.push(windowBucket('session', 'Session (5h)', primary, FIVE_HOUR_MS));

  const secondary = parseRateWindow(rateLimits.secondary ?? json.weekly ?? json.seven_day);
  if (secondary) buckets.push(windowBucket('weekly', 'Weekly', secondary, SEVEN_DAY_MS));

  const perModel = (rateLimits.per_model ?? rateLimits.spark ?? json.spark ?? json.model_limits) as
    | Array<Record<string, unknown>>
    | Record<string, unknown>
    | undefined;
  buckets.push(...buildSparkBuckets(perModel));

  const planType = typeof json.plan_type === 'string' ? json.plan_type : undefined;
  return { buckets, planType };
}

function expiryTierNote(resetsAt: number, now: number): string {
  const diff = resetsAt - now;
  if (diff <= 0) return 'expired';
  if (diff < 48 * 3_600_000) return 'expires in <48h';
  if (diff < 7 * 24 * 3_600_000) return 'expires in <1wk';
  return 'expires in >1wk';
}

function parseResetCreditsBucket(json: Record<string, unknown>, now: number): QuotaBucket | null {
  const remaining = firstFiniteNumber(json.credits, json.remaining_credits, json.balance);
  const granted = firstFiniteNumber(json.granted_credits, json.total_credits);
  const resetsAt = resetsAtFrom(json.expires_at ?? json.resets_at, json.expires_in_seconds);
  if (remaining == null && granted == null && resetsAt == null) return null;

  const bucket: QuotaBucket = {
    id: 'reset-credits',
    label: 'Reset credits',
    used: null,
    limit: granted,
    remaining,
    unit: 'credits',
    enabled: true,
    defaultVisibility: 'onDemand',
  };
  if (resetsAt != null) {
    bucket.resetsAt = resetsAt;
    bucket.note = expiryTierNote(resetsAt, now);
  }
  return bucket;
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

function firstFiniteNumberLocal(...vals: unknown[]): number | null {
  for (const v of vals) {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (Number.isFinite(n)) return n;
  }
  return null;
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

  const rawInputTokens = firstFiniteNumberLocal(usageRaw.input_tokens) ?? 0;
  const rawCachedInputTokens = firstFiniteNumberLocal(usageRaw.cached_input_tokens) ?? 0;
  const rawOutputTokens = firstFiniteNumberLocal(usageRaw.output_tokens) ?? 0;

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
          'Run `codex login` to sign in with ChatGPT.',
      };
    }
    if (!auth.tokens.accessToken) {
      return {
        ok: false,
        fetchedAt,
        needsLogin: true,
        error: auth.tokens.apiKey
          ? 'This Codex CLI session uses an OpenAI API key, which the ChatGPT usage endpoints don\'t accept. ' +
            'Run `codex login` with ChatGPT to see quota here, or use the OpenAI connector for API-key org usage.'
          : 'Codex CLI is not signed in. Run `codex login` to sign in with ChatGPT.',
        source: auth.path,
      };
    }

    try {
      const usageRes = await fetchWithRefresh(WHAM_USAGE_URL, auth, this.ctx);
      if (usageRes.status === 401 || usageRes.status === 403) {
        return {
          ok: false,
          fetchedAt,
          needsLogin: true,
          error: 'Codex session expired. Run `codex login` to sign in again.',
          source: auth.path,
        };
      }
      if (usageRes.status >= 400) {
        return { ok: false, fetchedAt, error: `Codex usage API HTTP ${usageRes.status}`, source: auth.path };
      }

      const { buckets, planType } = parseUsageBuckets(usageRes.json as Record<string, unknown>);
      if (buckets.length === 0) {
        // A 200 with no recognisable rate-limit fields means the undocumented
        // API shape drifted, not that usage is genuinely empty — surface it
        // so this doesn't silently look like a normal quiet connector.
        this.ctx.log('warn', '[codex-cli] wham/usage returned 200 but no recognisable rate-limit fields', {
          keys: Object.keys((usageRes.json as Record<string, unknown>) ?? {}),
        });
      }

      // Reset-credits is optional — failure here doesn't fail the whole fetch.
      try {
        const creditsRes = await fetchWithRefresh(WHAM_RESET_CREDITS_URL, auth, this.ctx);
        if (creditsRes.status < 400) {
          const creditsBucket = parseResetCreditsBucket(creditsRes.json as Record<string, unknown>, fetchedAt);
          if (creditsBucket) buckets.push(creditsBucket);
        }
      } catch {
        // skip
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
