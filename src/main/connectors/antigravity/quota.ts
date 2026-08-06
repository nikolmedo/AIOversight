import { ConnectorContext, QuotaBucket, QuotaProvider, QuotaSnapshot } from '../types';

/**
 * Antigravity quota provider — local-language-server-only, reduced scope.
 *
 * CONFIDENCE NOTES (read before trusting a number) — this connector could NOT
 * be verified against a running Antigravity install in this environment (the
 * tool isn't installed on this dev machine, and almost no one has it). Every
 * piece below marked "GUESS" is a best-effort, defensive implementation, not
 * a transcription of observed behavior:
 *
 * 1. Discovery mechanism — Antigravity is a local IDE/agent tool. Per the
 *    plan, when it's running it exposes a local HTTP language server on some
 *    port, guarded by a CSRF-style token/handshake. There is no known
 *    file-based port registry to read (unlike this codebase's other local
 *    servers), so discovery here is a constrained TCP/HTTP port scan.
 * 2. Default port range (`DEFAULT_PORT_RANGE`) — GUESS. Chosen as a small,
 *    plausible high-numbered ephemeral-ish range typical of local dev-tool
 *    language servers, NOT verified against real Antigravity behavior. The
 *    `portRange` config field lets a user override it once they know the
 *    real port (e.g. from Task Manager / `netstat`) — a widened override is
 *    scanned in full (see `MAX_PORT_RANGE_SPAN`), not silently truncated to
 *    a small fixed port count.
 * 3. Per-port detection signature (`looksLikeAntigravityServer`) — GUESS.
 *    Some local dev-tool servers answer a root/health GET with a small JSON
 *    body advertising a CSRF token; this checks for a small, deliberately
 *    narrow set of field names (CSRF/Antigravity/language-server-lineage
 *    only — generic names like "sessionId" are excluded on purpose, since
 *    they're common enough across unrelated local dev servers to risk
 *    mis-identifying the WRONG local service and then POSTing quota-RPC
 *    calls to it). A false negative on every port is the safe failure mode
 *    (falls through to "not running"); a bare 200 with no recognisable field
 *    is deliberately NOT treated as a match. When a token IS found, it's
 *    threaded through and replayed on the follow-up query call as
 *    `X-CSRF-Token` — the discovery mechanism is documented as CSRF-guarded,
 *    so a query sent without it (once one was found) would be expected to
 *    fail closed.
 * 4. Query RPC path/method names (`RPC_METHODS`) — GUESS, per the plan's
 *    mention of `RetrieveUserQuotaSummary` (primary) and `GetUserStatus` /
 *    `GetCommandModelConfigs` (documented fallbacks). Modeled as Connect-RPC
 *    unary POSTs (`/<package>.<Service>/<Method>`), following the same
 *    convention this codebase's `devin/quota.ts` already uses for a
 *    structurally similar local-agent backend.
 * 5. Quota response shape / pool classification — GUESS. Parsed defensively
 *    across plausible field-name conventions; unrecognised shapes yield no
 *    buckets (explicit `ok:false`), never a fabricated number.
 *
 * Deliberately NOT implemented: any macOS-Keychain (or other OS-credential-
 * store) fallback for when Antigravity is closed. The plan is explicit that
 * no file-based equivalent exists in the source material, and this connector
 * must not invent one — when no local server is found, this returns a plain
 * "Antigravity is not running" error, not `needsLogin: true` (there is no
 * login flow here to begin with).
 */

// --- Port range parsing ------------------------------------------------------

// GUESS (see file-header note 2) — small, bounded, overridable via config.
export const DEFAULT_PORT_RANGE = '49500-49529';

/**
 * Sanity ceiling on the total ports a configured range can expand to.
 *
 * WARNING FIX: this used to be a hard 64-port cap applied silently, which
 * meant a user who widened `portRange` (the config field's own help text
 * invites this once they've found the real port via Task Manager / netstat)
 * could have that real port fall past position 64 and NEVER get scanned --
 * the connector would then keep reporting the honest-looking-but-wrong "not
 * running" error forever, even while Antigravity genuinely was running on an
 * unscanned port within the user's own configured range.
 *
 * Fix: `scanForLanguageServer` now scans in budget-bounded CHUNKS (see
 * `SCAN_CHUNK_SIZE`), so the real backstop against runaway scan time is
 * `SCAN_TOTAL_BUDGET_MS`, not a port-count cap -- a moderately widened range
 * (tens to low hundreds of ports) scans to completion well within budget
 * (refused-connection probes resolve near-instantly, not after the full
 * per-port timeout). This constant is now just a defensive ceiling against a
 * pathological paste of the entire port space (e.g. "1-65535"), generous
 * enough that no realistic user-narrowed range should ever hit it.
 */
export const MAX_PORT_RANGE_SPAN = 4096;

export interface ParsedPortRange {
  ports: number[];
  /** The raw `end - start + 1` span the user configured, BEFORE any
   * `MAX_PORT_RANGE_SPAN` capping. Compare against `ports.length` to detect
   * whether capping actually dropped anything. */
  requestedSpan: number;
}

/**
 * Parses a `"<start>-<end>"` port range string into a sorted, deduped list of
 * ports (plus the originally-requested span, for truncation detection).
 * Falls back to `DEFAULT_PORT_RANGE` on anything malformed (non-numeric,
 * reversed, out of the valid TCP port space) rather than scanning zero ports
 * or throwing. Exported for smoke coverage.
 */
export function parsePortRangeInfo(raw: string | undefined | null): ParsedPortRange {
  const fallback = parsePortRangeStrict(DEFAULT_PORT_RANGE) ?? { ports: [], requestedSpan: 0 };
  if (!raw || !raw.trim()) return fallback;
  const parsed = parsePortRangeStrict(raw.trim());
  return parsed && parsed.ports.length > 0 ? parsed : fallback;
}

/** Convenience wrapper over `parsePortRangeInfo` for callers that only need
 * the port list. Exported for smoke coverage. */
export function parsePortRange(raw: string | undefined | null): number[] {
  return parsePortRangeInfo(raw).ports;
}

function parsePortRangeStrict(raw: string): ParsedPortRange | null {
  const m = raw.match(/^(\d{1,5})\s*-\s*(\d{1,5})$/);
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 1 || start > 65535 || end < 1 || end > 65535 || end < start) return null;

  const requestedSpan = end - start + 1;
  const cappedEnd = Math.min(end, start + MAX_PORT_RANGE_SPAN - 1);
  const ports: number[] = [];
  for (let p = start; p <= cappedEnd; p++) ports.push(p);
  return { ports, requestedSpan };
}

// --- Local HTTP helper (short, configurable timeout — NOT the 15s external- -
// --- API pattern; localhost probes must be much cheaper) --------------------
//
// Same AbortController + clean-abort-to-408 shape as github-copilot/quota.ts's
// `httpsGetJson`, parameterized on timeout since a port-scan probe (~300ms)
// and a found-server data query (a few seconds) need very different budgets.

interface LocalHttpResult {
  status: number;
  json: unknown;
}

async function httpJsonLocal(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  timeoutMs: number,
): Promise<LocalHttpResult> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { net } = require('electron') as typeof import('electron');
    if (net?.fetch) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await net.fetch(url, {
          method: init.method ?? 'GET',
          headers: init.headers,
          body: init.body,
          signal: controller.signal,
          // Defense-in-depth only (the RPC call always re-targets a
          // hardcoded loopback URL regardless of any redirect, so this
          // isn't guarding a live vulnerability): never silently follow a
          // redirect off of the localhost probe/query target.
          redirect: 'manual',
        });
        const txt = await res.text();
        try {
          return { status: res.status, json: txt ? JSON.parse(txt) : {} };
        } catch {
          return { status: res.status, json: {} };
        }
      } catch (err) {
        // A deliberate timeout-abort just means this port isn't it (or is
        // slow) — fail closed to 408 rather than retrying via a different
        // transport at the SAME cost, which would double scan latency.
        if (controller.signal.aborted) {
          return { status: 408, json: {} };
        }
        // Any OTHER net.fetch failure (most commonly ECONNREFUSED — nothing
        // listening on this port, the expected common case across most of a
        // scan) must resolve to a clean "not it" here too, NOT fall through
        // to the Node http branch below. Unlike github-copilot/zai/devin's
        // single external-API call, this function is invoked once per
        // scanned port — falling through would mean every refused port pays
        // BOTH transports' connection-refused cost, doubling real scan time.
        return { status: 0, json: {} };
      } finally {
        clearTimeout(timer);
      }
    }
  } catch {
    // require('electron') itself failed (e.g. headless smoke tests) — this
    // is the only case that legitimately falls through to Node's http.
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const http = require('http') as typeof import('http');
  return new Promise(resolve => {
    const headers = { ...(init.headers ?? {}) };
    if (init.body) headers['Content-Length'] = String(Buffer.byteLength(init.body));
    const req = http.request(url, { method: init.method ?? 'GET', headers }, res => {
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
    // Connection errors (most ports: ECONNREFUSED, nothing listening) are the
    // expected common case during a scan — resolve to a clean "not it"
    // rather than rejecting/crashing the whole scan.
    req.on('error', () => resolve({ status: 0, json: {} }));
    // Passing an Error to destroy() (unlike a bare destroy()) reliably fires
    // the 'error' listener above, which is what actually resolves this
    // promise -- a bare destroy() is not guaranteed to emit 'error', which
    // would leave this promise unsettled and wedge the RPC query call that
    // uses this same helper (the port-scan side is protected by
    // scanForLanguageServer's separate overall-budget race, but a query has
    // no such backstop).
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Antigravity local request timed out after ${timeoutMs}ms`)));
    if (init.body) req.write(init.body);
    req.end();
  });
}

// --- Port-scan discovery ------------------------------------------------------

const PROBE_TIMEOUT_MS = 300; // per-port — must stay far below the scan's total budget.
const SCAN_TOTAL_BUDGET_MS = 4000; // whole-scan safety net regardless of port count.
const QUERY_TIMEOUT_MS = 3000; // once a port is found, this is a single localhost call.
/** Ports probed concurrently within one scan chunk. Chunking (rather than
 * firing every configured port at once) keeps a widened `portRange` bounded
 * by wall-clock time (`SCAN_TOTAL_BUDGET_MS`) instead of relying on an
 * arbitrary port-count cap to prevent unbounded concurrency — see
 * `MAX_PORT_RANGE_SPAN`'s doc comment for the bug this replaced. */
const SCAN_CHUNK_SIZE = 64;

/**
 * Races an async operation against a total time budget, resolving to `null`
 * if the budget elapses first. Shared by the port-scan phase
 * (`scanForLanguageServer`) and the post-discovery query phase
 * (`queryQuotaDataWithBudget`) so both follow the identical time-bounding
 * discipline -- the query phase previously had NO overall ceiling across its
 * `RPC_METHODS` fallback loop (each individual attempt had its own
 * `QUERY_TIMEOUT_MS`, but nothing capped the whole loop), so a
 * discovered-but-stalling server could make `fetch()` hang for the sum of
 * all per-method timeouts, awaited directly by the `quota:refresh` IPC
 * handler with no cancel.
 */
async function raceWithBudget<T>(op: () => Promise<T>, totalBudgetMs: number): Promise<T | null> {
  const timeout = new Promise<null>(resolve => setTimeout(() => resolve(null), totalBudgetMs));
  return Promise.race([op(), timeout]);
}

/**
 * Best-effort match test for a probe response body (see file-header note 3).
 * Deliberately conservative: an empty/malformed body, or a body with none of
 * the expected fields, is NOT a match — a bare 200 alone is not enough
 * evidence this is the Antigravity server rather than some unrelated local
 * service. Exported for smoke coverage.
 */
export function looksLikeAntigravityServer(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const obj = body as Record<string, unknown>;
  // Deliberately narrow — generic keys like "sessionId" or "ideVersion" are
  // common enough across unrelated local dev servers that accepting them
  // risks identifying the WRONG local service and then POSTing quota-RPC
  // calls to it. Only names that specifically imply Antigravity/its known
  // lineage (Codeium/Windsurf) qualify.
  const candidateKeys = ['csrfToken', 'csrf_token', 'antigravity', 'languageServerVersion', 'windsurfVersion'];
  return candidateKeys.some(k => typeof obj[k] === 'string' && (obj[k] as string).length > 0);
}

/** Pulls whichever CSRF-token-shaped field matched, so it can be replayed on
 * the follow-up query call. Exported for smoke coverage. */
export function extractCsrfToken(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;
  return firstString(obj.csrfToken, obj.csrf_token);
}

/** GUESS (see file-header note 3) — plausible lightweight discovery path. */
const PROBE_PATH = '/';

export interface ScanMatch {
  port: number;
  /** Present when the probe response carried a recognisable CSRF token — see
   * file-header note 3. `null` when the server matched but no token field
   * was found, in which case the follow-up query call is sent without one. */
  csrfToken: string | null;
}

async function probePort(port: number): Promise<ScanMatch | null> {
  try {
    const res = await httpJsonLocal(`http://127.0.0.1:${port}${PROBE_PATH}`, { method: 'GET' }, PROBE_TIMEOUT_MS);
    if (res.status !== 200) return null;
    if (!looksLikeAntigravityServer(res.json)) return null;
    return { port, csrfToken: extractCsrfToken(res.json) };
  } catch {
    return null;
  }
}

/**
 * Scans `ports` in fixed-size chunks (each chunk probed concurrently, ports
 * within a chunk in ascending order so the first chunk with any match yields
 * the deterministic lowest-port winner), the WHOLE multi-chunk operation
 * wrapped in one overall budget so the detection phase can never run away —
 * this matters both because quota polling runs on a schedule (a slow scan
 * would compound across polls) and because a widened `portRange` no longer
 * has its tail silently dropped by a port-count cap (see
 * `MAX_PORT_RANGE_SPAN`): time, not count, is what's bounded here. Returns
 * the lowest matching port (with its CSRF token, if the probe response
 * carried one), or `null` when nothing in range answered before the budget
 * elapsed. Exported for smoke coverage (with an injectable `probe` so the
 * test doesn't need a real socket).
 */
export async function scanForLanguageServer(
  ports: number[],
  probe: (port: number) => Promise<ScanMatch | null> = probePort,
  totalBudgetMs: number = SCAN_TOTAL_BUDGET_MS,
): Promise<ScanMatch | null> {
  if (ports.length === 0) return null;

  return raceWithBudget(async () => {
    for (let i = 0; i < ports.length; i += SCAN_CHUNK_SIZE) {
      const chunk = ports.slice(i, i + SCAN_CHUNK_SIZE);
      const results = await Promise.all(chunk.map(port => probe(port)));
      const matches = results.filter((m): m is ScanMatch => m != null).sort((a, b) => a.port - b.port);
      if (matches.length > 0) return matches[0];
    }
    return null;
  }, totalBudgetMs);
}

// --- Quota query + parsing ----------------------------------------------------

// GUESS (see file-header note 4) — Connect-RPC unary-POST convention, tried
// in order; the first that returns a recognisable shape wins.
const RPC_METHODS = ['RetrieveUserQuotaSummary', 'GetUserStatus', 'GetCommandModelConfigs'];
const RPC_SERVICE_PATH = '/exa.language_server_pb.LanguageServerService';
/** Overall ceiling across the WHOLE `RPC_METHODS` fallback loop -- see
 * `raceWithBudget`'s doc comment for the hang this closes. 3 methods x
 * `QUERY_TIMEOUT_MS` (3000ms) each could otherwise take up to ~9s with no
 * cancel; this keeps a single `quota:refresh` call bounded. */
const QUERY_TOTAL_BUDGET_MS = 7000;

function firstFiniteNumber(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim() === '') continue;
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

/**
 * Normalizes a raw epoch value that might be seconds or milliseconds — same
 * heuristic as `devin/quota.ts`'s `resetsAtFrom` (values below 1e10 read as
 * seconds and get multiplied up; at/above 1e10 are treated as already-ms),
 * since the exact convention this API uses is unverified (see file-header
 * note 5). Not hoisted to a shared module since this codebase's quota.ts
 * files are self-contained per connector by convention. Exported for smoke
 * coverage.
 */
export function normalizeEpochMs(raw: number): number {
  return raw > 1e10 ? raw : raw * 1000;
}

/** Never pair a real observed `resetsAt` with a synthesized `windowMs` — same
 * discipline as `zai/quota.ts`'s `resolveWindowPairing` / `devin/quota.ts`'s
 * copy of it. Exported for smoke coverage. */
export function resolveWindowPairing(
  observedWindowMs: number | null,
  observedResetsAt: number | null,
  fallbackWindowMs: number,
): { windowMs: number; resetsAt?: number } {
  const windowMs = observedWindowMs ?? fallbackWindowMs;
  if (observedWindowMs != null && observedResetsAt != null) {
    return { windowMs, resetsAt: observedResetsAt };
  }
  return { windowMs };
}

const SESSION_WINDOW_MS = 18_000_000; // 5h, matches every other Phase 5 connector's "session" window
const WEEKLY_WINDOW_MS = 604_800_000; // 7d
const ONE_DAY_MS = 86_400_000;

export type QuotaPool = 'gemini' | 'other';
export type QuotaWindowKind = '5h' | 'weekly';

export interface RawModelQuotaEntry {
  modelId: string;
  usedPercent: number;
  resetsAt: number | null;
  windowMs: number | null;
  /** Always populated (never null) on entries `extractQuotaEntries` emits —
   * an entry whose window can't be classified is dropped there rather than
   * carried forward with a guessed value. See `classifyWindowKind`. */
  windowKind: QuotaWindowKind;
}

/**
 * Classifies a model id into one of the plan's two shared pools: "Gemini
 * (Pro/Flash)" or "non-Gemini (Claude/GPT-OSS)". Unrecognised model ids fall
 * into the non-Gemini pool (the broader, catch-all bucket per the plan's
 * naming), never dropped silently. Exported for smoke coverage.
 */
export function poolForModel(modelId: string): QuotaPool {
  return /gemini/i.test(modelId) ? 'gemini' : 'other';
}

/**
 * Classifies a window into '5h' (session-length) or 'weekly' — duration
 * first (sub-daily -> '5h', >= 1 day -> 'weekly'), then, when no duration
 * was observed, a name-based heuristic over `hint` (whatever type/period/
 * label text came with the entry), same two-tier approach as `zai/quota.ts`'s
 * `parseQuotaItems`. Returns `null` — never a guessed default — when NEITHER
 * signal resolves: this is a genuinely unverified response shape, and
 * silently defaulting every unclassifiable entry into '5h' would (a) drop
 * every real weekly figure and (b) risk displaying a weekly number under the
 * permanent 'gemini-5h' / 'other-5h' bucket id, corrupting that id's meaning
 * across polls (the same class of bug devin/quota.ts's WARNING fix guards
 * against for its weekly/daily fallback). Exported for smoke coverage.
 */
export function classifyWindowKind(windowMs: number | null, hint: string): QuotaWindowKind | null {
  if (windowMs != null) return windowMs < ONE_DAY_MS ? '5h' : 'weekly';
  const h = hint.toLowerCase();
  if (h.includes('week') || h.includes('7d')) return 'weekly';
  if (h.includes('session') || h.includes('5h') || h.includes('hour')) return '5h';
  return null;
}

/**
 * GUESS (see file-header note 5) — extracts a flat list of per-model quota
 * entries from whatever shape the RPC call returned. Probes several plausible
 * container paths and field names; a model entry with no usable
 * used/limit-or-percent figure is skipped, never defaulted to zero. Exported
 * for smoke coverage.
 */
export function extractQuotaEntries(json: unknown): RawModelQuotaEntry[] {
  if (!json || typeof json !== 'object') return [];
  const root = json as Record<string, unknown>;
  const list =
    (root.quotas ?? root.modelQuotas ?? root.model_quotas ?? root.quotaSummaries ?? root.data) ?? null;
  if (!Array.isArray(list)) return [];

  const out: RawModelQuotaEntry[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const modelId = firstString(item.model, item.modelId, item.model_id, item.name) ?? 'unknown';

    let usedPercent = firstFiniteNumber(item.usedPercent, item.used_percent, item.percentUsed, item.percent_used);
    if (usedPercent == null) {
      const used = firstFiniteNumber(item.used, item.count, item.quota_used);
      const limit = firstFiniteNumber(item.limit, item.quota_limit, item.max, item.total);
      if (used != null && limit != null && limit > 0) {
        usedPercent = (used / limit) * 100;
      }
    }
    if (usedPercent == null) continue;

    const windowSeconds = firstFiniteNumber(item.windowSeconds, item.window_seconds, item.periodSeconds);
    const windowMs = windowSeconds != null ? windowSeconds * 1000 : null;
    const resetsAtRaw = firstFiniteNumber(item.resetsAt, item.resets_at, item.resetTime, item.reset_time);
    const resetsAt = resetsAtRaw != null && resetsAtRaw > 0 ? normalizeEpochMs(resetsAtRaw) : null;

    const hint =
      firstString(item.type, item.windowType, item.window_type, item.period, item.quotaType, item.quota_type) ?? '';
    const windowKind = classifyWindowKind(windowMs, hint);
    // Neither a real duration nor a recognisable name hint -- drop the
    // entry rather than guessing which bucket it belongs in (see
    // classifyWindowKind's doc comment).
    if (windowKind == null) continue;

    out.push({
      modelId,
      usedPercent: Math.min(100, Math.max(0, usedPercent)),
      resetsAt,
      windowMs,
      windowKind,
    });
  }
  return out;
}

/**
 * Merges classified per-model entries into pool-level buckets, per the plan:
 * "merged by keeping each pool's worst remaining fraction across models in
 * the pool" — i.e. for each (pool, window) pair, the displayed number is
 * whichever model has the LOWEST remaining fraction (highest used%). A pure,
 * directly-testable function decoupled from HTTP/JSON parsing uncertainty.
 * Exported for smoke coverage.
 */
export function mergePoolQuota(entries: RawModelQuotaEntry[]): QuotaBucket[] {
  const worst = new Map<string, RawModelQuotaEntry>();

  for (const entry of entries) {
    const pool = poolForModel(entry.modelId);
    const window = entry.windowKind;
    const key = `${pool}:${window}`;
    const current = worst.get(key);
    if (!current || entry.usedPercent > current.usedPercent) {
      worst.set(key, entry);
    }
  }

  const POOL_LABEL: Record<QuotaPool, string> = {
    gemini: 'Gemini (Pro/Flash)',
    other: 'Non-Gemini (Claude/GPT-OSS)',
  };
  const WINDOW_LABEL: Record<QuotaWindowKind, string> = { '5h': '5h', weekly: 'Weekly' };
  const FALLBACK_WINDOW_MS: Record<QuotaWindowKind, number> = { '5h': SESSION_WINDOW_MS, weekly: WEEKLY_WINDOW_MS };

  const buckets: QuotaBucket[] = [];
  // Deterministic order: gemini before other, 5h before weekly — independent
  // of Map iteration order (insertion-dependent on response ordering).
  for (const pool of ['gemini', 'other'] as QuotaPool[]) {
    for (const window of ['5h', 'weekly'] as QuotaWindowKind[]) {
      const key = `${pool}:${window}`;
      const entry = worst.get(key);
      if (!entry) continue;
      const pairing = resolveWindowPairing(entry.windowMs, entry.resetsAt, FALLBACK_WINDOW_MS[window]);
      buckets.push({
        id: `${pool}-${window}`,
        label: `${POOL_LABEL[pool]} — ${WINDOW_LABEL[window]}`,
        used: entry.usedPercent,
        limit: 100,
        remaining: Math.max(0, 100 - entry.usedPercent),
        unit: 'percent',
        enabled: true,
        note: `Worst of this pool's models (${entry.modelId})`,
        ...pairing,
      });
    }
  }
  return buckets;
}

// --- Quota query (RPC-method fallback loop, budget-bounded overall) --------

export interface QuerySuccess {
  buckets: QuotaBucket[];
  source: string;
}
export interface QueryFailure {
  lastStatus: number;
}
export type QueryOutcome = QuerySuccess | QueryFailure;

function isQuerySuccess(outcome: QueryOutcome): outcome is QuerySuccess {
  return 'buckets' in outcome;
}

/**
 * Tries each `RPC_METHODS` entry in order against an already-discovered
 * server, returning the first that yields recognisable quota data. Exported
 * for smoke coverage (called through `queryQuotaDataWithBudget` in
 * production so the whole loop stays budget-bounded — see that function's
 * doc comment).
 */
export async function queryQuotaData(base: string, headers: Record<string, string>): Promise<QueryOutcome> {
  let lastStatus = 0;
  for (const method of RPC_METHODS) {
    const res = await httpJsonLocal(`${base}/${method}`, { method: 'POST', headers, body: '{}' }, QUERY_TIMEOUT_MS);
    lastStatus = res.status;
    if (res.status !== 200) continue;

    const entries = extractQuotaEntries(res.json);
    if (entries.length === 0) continue;

    const buckets = mergePoolQuota(entries);
    if (buckets.length === 0) continue;

    return { buckets, source: `${base}/${method}` };
  }
  return { lastStatus };
}

/**
 * RESILIENCE FIX: the RPC-method fallback loop previously had no ceiling
 * across the WHOLE loop -- only each individual method attempt had its own
 * `QUERY_TIMEOUT_MS`. A discovered-but-stalling server could therefore make
 * this phase take up to `RPC_METHODS.length * QUERY_TIMEOUT_MS` (~9s), and
 * `fetch()` is awaited directly by the `quota:refresh` IPC handler with no
 * cancel -- a user clicking Refresh could see it hang that whole time. This
 * wraps `queryQuotaData` in the same `raceWithBudget` discipline
 * `scanForLanguageServer` already uses, so the query phase (not just each
 * method) has a hard ceiling too. Exported for smoke coverage (with an
 * injectable `runQuery` so the test doesn't need a real socket).
 */
export async function queryQuotaDataWithBudget(
  runQuery: () => Promise<QueryOutcome>,
  totalBudgetMs: number = QUERY_TOTAL_BUDGET_MS,
): Promise<QueryOutcome | null> {
  return raceWithBudget(runQuery, totalBudgetMs);
}

// --- Provider ------------------------------------------------------------------

class AntigravityQuotaProvider implements QuotaProvider {
  private cfg: Record<string, unknown> = {};
  constructor(_ctx: ConnectorContext) {}

  setConfig(cfg: Record<string, unknown>): void {
    this.cfg = cfg;
  }

  async fetch(): Promise<QuotaSnapshot> {
    const fetchedAt = Date.now();

    const portInfo = parsePortRangeInfo(this.cfg.portRange as string | undefined);
    const match = await scanForLanguageServer(portInfo.ports);

    if (match == null) {
      // WARNING FIX: previously silent -- if the configured range's raw span
      // was wider than what actually got scanned (only possible now via the
      // generous MAX_PORT_RANGE_SPAN ceiling, since realistic ranges scan in
      // full), say so explicitly rather than letting the user believe
      // Antigravity truly isn't running.
      const truncationNote =
        portInfo.requestedSpan > portInfo.ports.length
          ? ` (your configured range requested ${portInfo.requestedSpan} ports; only the first ` +
            `${portInfo.ports.length} were scanned -- narrow the range if the real port falls outside that.)`
          : '';
      return {
        ok: false,
        fetchedAt,
        error: `Antigravity is not running — start the app to see quota.${truncationNote}`,
      };
    }

    const { port, csrfToken } = match;
    const base = `http://127.0.0.1:${port}${RPC_SERVICE_PATH}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
    };
    // Threaded through from the probe response, per file-header note 3 --
    // the discovery step is documented as CSRF-guarded, so a query call sent
    // without this (when one was found) would be expected to fail closed.
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

    const outcome = await queryQuotaDataWithBudget(() => queryQuotaData(base, headers));

    if (outcome == null) {
      return {
        ok: false,
        fetchedAt,
        error:
          `Found Antigravity's local server on port ${port}, but querying its quota endpoints took too long ` +
          `(over ${QUERY_TOTAL_BUDGET_MS}ms) and was abandoned.`,
        source: base,
      };
    }

    if (isQuerySuccess(outcome)) {
      return {
        ok: true,
        fetchedAt,
        buckets: outcome.buckets,
        displayMessages: [],
        authMethod: 'csrf',
        source: outcome.source,
      };
    }

    return {
      ok: false,
      fetchedAt,
      error:
        `Found Antigravity's local server on port ${port}, but none of its quota endpoints returned ` +
        `recognisable data (last HTTP status: ${outcome.lastStatus}).`,
      source: base,
    };
  }
}

export function createAntigravityQuotaProvider(
  config: Record<string, unknown>,
  ctx: ConnectorContext,
): QuotaProvider {
  const provider = new AntigravityQuotaProvider(ctx);
  provider.setConfig(config);
  return provider;
}
