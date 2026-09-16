import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ConnectorContext, QuotaBucket, QuotaProvider, QuotaSnapshot, SpendTile } from '../types';
import { costCentsFor } from '../shared/model-pricing';

/**
 * OpenCode connector — quota windows from the official OpenCode Zen usage
 * API, local spend from OpenCode's own SQLite database(s) (`opencode*.db`).
 *
 * CONFIDENCE NOTES (read before trusting a number):
 *
 * 0. Zen usage endpoint [C, from the vendor's own merged PR] —
 *    `GET https://opencode.ai/zen/go/v1/usage` with
 *    `Authorization: Bearer <OpenCode Go API key>`, answering
 *    `{"usage":{"rolling":{...},"weekly":{...},"monthly":{...}}}` where each
 *    window carries `status`, `percent` and `resetsAt`. DOLLAR AMOUNTS ARE
 *    NOT EXPOSED, so these are percent buckets.
 *
 *    This replaces three fabricated dollar budgets ($12 session / $30 weekly
 *    / $60 monthly) that earlier versions of this file presented as if they
 *    were vendor limits. They never were: real limits vary by model tier
 *    (the 5h window is 20% and the weekly 50% of the monthly cap, which is
 *    roughly $60/month for cheap models but $15 for others), so that triple
 *    was wrong for every user but one tier. The `weekly` and `monthly`
 *    bucket ids survive from that version and now carry `unit: 'percent'`
 *    instead of `unit: 'usd'` — acceptable only because the values they used
 *    to carry were invented rather than measured.
 *
 *    Which `auth.json` provider id holds the Go key is UNCONFIRMED, so both
 *    `opencode` and `opencode-go` are probed, and the key's own field is
 *    assumed to be `key`. A user can always paste the key into the
 *    connector's `apiKey` secret field instead.
 *
 *    `resetsAt` may be an ISO string or an epoch number; both are parsed.
 *    The `status` string is deliberately ignored — its value space is
 *    unknown, and guessing at it would put invented semantics on screen.
 *
 * 1. SQLite `session` table schema — column NAMES/TYPES are HIGH confidence
 *    (the `CREATE TABLE` text was read via `sqlite_master` from a real,
 *    currently-installed OpenCode database on this dev machine at
 *    `~/.local/share/opencode/opencode.db`, not guessed); real ROW VALUES
 *    are UNVERIFIED (every row on that database was empty — fresh install,
 *    0 sessions). That table genuinely has `cost` (real, `DEFAULT 0 NOT
 *    NULL`), `tokens_input`, `tokens_output`, `tokens_reasoning`,
 *    `tokens_cache_read`, `tokens_cache_write` (all integer), and
 *    `time_created`/`time_updated` (epoch ms) columns, pre-aggregated PER
 *    SESSION. The plan this connector was built from expected per-MESSAGE
 *    cost figures; the verified schema instead aggregates cost at the
 *    session level (the `message`/`part` tables only store an opaque JSON
 *    `data` blob with no dedicated cost column) — this implementation
 *    deliberately uses the session-level columns (stronger evidence, no
 *    JSON-shape guessing) rather than attempting to parse the unverified
 *    message/part JSON payloads.
 *
 * 2. "opencode-go" vs "opencode Zen" gateway split — NOT verified, and NOT
 *    implemented as a split. The plan asked for spend tiles aggregated
 *    "from both Go and Zen gateway records", but the verified `session`
 *    schema has no column that reliably distinguishes the two (the closest
 *    candidate, `model`, holds free-form strings like
 *    `opencode/claude-sonnet-4-6` on this machine, which is suggestive of a
 *    Zen-routed session but not a confirmed gateway indicator). Rather than
 *    fabricate a split on unverified heuristics, every session's cost is
 *    summed into ONE unified total — a deliberate, documented deviation
 *    from the plan's literal wording.
 *
 * 3. Local session data is now a SPEND source only. It feeds the Total Spend
 *    tiles and never quota buckets, because nothing in the local database
 *    knows what the account's actual limits are — which is exactly the gap
 *    the invented caps in note 0 used to paper over.
 *
 * 4. `auth.json` ("Go subscription detection") — LOW confidence,
 *    best-effort. This dev machine's real installation has NO `auth.json`
 *    at all; its account/session state instead lives in `account` /
 *    `control_account` / `account_state` SQLite tables (also
 *    schema-verified against the same real file). Those tables were
 *    deliberately NOT surfaced anywhere in this connector's output — the
 *    only fields available on them are personal identifiers (email, login
 *    URL), and `membershipType` is the same display slot every other
 *    connector uses for a plan-tier string ("Pro", "anthropic-admin", …);
 *    putting an email there would be a data-modeling mismatch, not useful
 *    account context. `extractAuthLabel` stays as a defensive fallback for
 *    any OpenCode version/config that does write a JSON credentials file;
 *    the field names it probes are a generic guess, not a confirmed
 *    OpenCode-specific shape. A shape it doesn't recognise yields no label,
 *    never a fabricated one.
 */

// --- Constants -----------------------------------------------------------

const DAY_MS = 24 * 3_600_000;
const ZEN_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';

// --- Data directory resolution --------------------------------------------

/**
 * Portable placeholder defaults for the `dataDirs` configSchema field —
 * mirrors `codex-cli/index.ts`'s `paths` field convention (literal `~`/
 * `%APPDATA%`/`%LOCALAPPDATA%` placeholders expanded later per-user by
 * `ctx.resolvePath`, never this machine's actual resolved env values, so a
 * persisted default stays portable across machines). `$OPENCODE_DATA_DIR`
 * and `$XDG_DATA_HOME` can't be expressed this way (`resolvePath` doesn't
 * expand arbitrary env vars) — they're layered in separately by
 * `resolveDataDirs` below, ahead of these configured defaults. Exported for
 * the connector's `index.ts` and for smoke coverage.
 */
export function defaultOpencodeDataDirs(): string[] {
  return ['~/.local/share/opencode', '%LOCALAPPDATA%\\opencode', '%APPDATA%\\opencode'];
}

/**
 * Final, deduped, resolved candidate data directories: `$OPENCODE_DATA_DIR`
 * → `$XDG_DATA_HOME/opencode` → the (possibly user-configured) `paths` list,
 * in that priority order. Exported for smoke coverage.
 */
export function resolveDataDirs(config: Record<string, unknown>, ctx: ConnectorContext): string[] {
  const raw: string[] = [];
  if (process.env.OPENCODE_DATA_DIR) raw.push(process.env.OPENCODE_DATA_DIR);
  if (process.env.XDG_DATA_HOME) raw.push(path.join(process.env.XDG_DATA_HOME, 'opencode'));
  const configured = (config.dataDirs as string[] | undefined) ?? [];
  raw.push(...(configured.length ? configured : defaultOpencodeDataDirs()));

  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of raw) {
    if (!p) continue;
    const resolved = path.resolve(ctx.resolvePath(p));
    if (!seen.has(resolved)) {
      seen.add(resolved);
      out.push(resolved);
    }
  }
  return out;
}

// --- opencode*.db discovery -------------------------------------------------

/**
 * Matches `opencode*.db` (any release channel — `opencode.db`,
 * `opencode-preview.db`, …) while excluding SQLite's own WAL/SHM/journal
 * sidecar files (`opencode.db-wal`, `opencode.db-shm`), which don't end in
 * literal `.db`. Exported for smoke coverage.
 */
export function isOpencodeDbFilename(name: string): boolean {
  return /^opencode[a-zA-Z0-9_.-]*\.db$/i.test(name);
}

function findDbFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return []; // missing/unreadable directory -- zero matches, not an error
  }
  return entries
    .filter(isOpencodeDbFilename)
    .map(name => path.join(dir, name))
    .sort();
}

// --- SQLite access (reuses cursor/quota.ts's exact sql.js pattern) --------

/** The small subset of sql.js's `Database` surface this file needs. */
interface MinimalSqlDb {
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
  close(): void;
}

async function openSqlJsDatabase(dbPath: string): Promise<MinimalSqlDb> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sqlJsModule = require('sql.js') as
    & { default?: typeof import('sql.js') }
    & typeof import('sql.js');
  const initSqlJs = (typeof sqlJsModule === 'function' ? sqlJsModule : sqlJsModule.default)!;
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  return new SQL.Database(fs.readFileSync(dbPath));
}

interface RawSessionRow {
  timeCreated: number;
  timeUpdated: number;
  /** `null` only if the driver genuinely returns no value — the verified
   * schema declares this column `NOT NULL DEFAULT 0`, so this should not
   * happen in practice; kept nullable defensively for schema drift. */
  costDollars: number | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  model: string | null;
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function rowsFromExecResult(result: Array<{ columns: string[]; values: unknown[][] }>): RawSessionRow[] {
  const first = result[0];
  if (!first) return [];
  const idx = (name: string) => first.columns.indexOf(name);
  const iCreated = idx('time_created');
  const iUpdated = idx('time_updated');
  const iCost = idx('cost');
  const iIn = idx('tokens_input');
  const iOut = idx('tokens_output');
  const iReasoning = idx('tokens_reasoning');
  const iCacheR = idx('tokens_cache_read');
  const iCacheW = idx('tokens_cache_write');
  const iModel = idx('model');

  const out: RawSessionRow[] = [];
  for (const row of first.values) {
    out.push({
      timeCreated: toNumber(row[iCreated]) ?? NaN,
      timeUpdated: toNumber(row[iUpdated]) ?? NaN,
      costDollars: toNumber(row[iCost]),
      inputTokens: toNumber(row[iIn]) ?? 0,
      outputTokens: toNumber(row[iOut]) ?? 0,
      reasoningTokens: toNumber(row[iReasoning]) ?? 0,
      cacheReadTokens: toNumber(row[iCacheR]) ?? 0,
      cacheWriteTokens: toNumber(row[iCacheW]) ?? 0,
      model: typeof row[iModel] === 'string' ? (row[iModel] as string) : null,
    });
  }
  return out;
}

interface DbReadResult {
  sessions: RawSessionRow[];
  /** False when the `session` table couldn't be queried at all (missing
   * table, schema drift) -- distinct from a successful query that simply
   * returned zero rows. `fetch()` uses this to tell "confirmed zero usage"
   * apart from "couldn't determine" (CRITICAL fix). */
  sessionQueryOk: boolean;
}

async function readOpencodeDb(dbPath: string, ctx: ConnectorContext): Promise<DbReadResult> {
  const db = await openSqlJsDatabase(dbPath);
  try {
    let sessions: RawSessionRow[] = [];
    let sessionQueryOk = true;
    try {
      sessions = rowsFromExecResult(
        db.exec(
          'SELECT time_created, time_updated, cost, tokens_input, tokens_output, tokens_reasoning, ' +
            'tokens_cache_read, tokens_cache_write, model FROM session',
        ),
      );
    } catch (err) {
      // Older/mismatched schema without the cost/tokens columns -- no spend
      // data recoverable from this particular db file.
      sessionQueryOk = false;
      ctx.log('warn', '[opencode] session table missing expected cost/token columns', {
        dbPath,
        err: String(err),
      });
    }
    return { sessions, sessionQueryOk };
  } finally {
    db.close();
  }
}

// --- auth.json (best-effort, see file-header confidence note 4) ----------

function readAuthFile(dir: string): unknown | null {
  const p = path.join(dir, 'auth.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** Exported for smoke coverage. See file-header confidence note 4. */
export function extractAuthLabel(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const candidates = [obj.plan, obj.subscription, obj.tier, obj.type, obj.planType, obj.plan_type];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}

// --- Spend record aggregation ----------------------------------------------

/** Dollars in, cents out — this connector's one conversion point (`unit: 'usd'` is always cents). Exported for smoke coverage. */
export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

export interface OpencodeSpendRecord {
  /** Attribution timestamp for windowing -- `time_updated` (most recent
   * activity) when present, else `time_created`. A session's cost is
   * cumulative for its whole lifetime, so a long-running session that
   * receives one more message attributes its ENTIRE accumulated cost to
   * that latest moment -- an inherent limitation of session-level (not
   * per-message) cost data, not a bug in this aggregation. */
  ts: number;
  /** `null` only when neither the db's own cost figure nor a token-based
   * estimate could be determined (see `toSpendRecords`'s doc comment). */
  costCents: number | null;
  tokens: number;
}

/**
 * Falls back to token-based estimation via `costCentsFor` when the db has no
 * cost figure at all, OR when it reports an exact `0` alongside real token
 * usage. The latter is a heuristic, not a certainty: `cost`'s schema default
 * is `NOT NULL DEFAULT 0`, so a genuinely-priced-at-zero session (a free/
 * fully-cached turn) is indistinguishable, column-wise, from "OpenCode
 * failed to price this session" — but a real cost figure that happens to be
 * $0 is comparatively rare, while a $0 report on a row with real input/
 * output tokens is a strong signal something went unpriced. Given this
 * file's "never fabricate a confident number" ethos (see file-header note
 * 3), re-estimating is the safer default; if `costCentsFor` also can't
 * resolve the model, the result is `null` (unknown), never a re-asserted
 * `0`. Exported for smoke coverage.
 */
export function toSpendRecords(rows: RawSessionRow[]): OpencodeSpendRecord[] {
  const out: OpencodeSpendRecord[] = [];
  for (const row of rows) {
    const ts = Number.isFinite(row.timeUpdated) && row.timeUpdated > 0 ? row.timeUpdated : row.timeCreated;
    if (!Number.isFinite(ts)) continue;

    const tokens =
      (row.inputTokens || 0) +
      (row.outputTokens || 0) +
      (row.reasoningTokens || 0) +
      (row.cacheReadTokens || 0) +
      (row.cacheWriteTokens || 0);

    const hasRealTokens = (row.inputTokens || 0) > 0 || (row.outputTokens || 0) > 0;
    const suspiciousZero = row.costDollars === 0 && hasRealTokens;

    let costCents: number | null;
    if (row.costDollars != null && !suspiciousZero) {
      costCents = dollarsToCents(row.costDollars);
    } else {
      costCents = row.model
        ? costCentsFor(row.model, {
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            reasoningTokens: row.reasoningTokens,
            cacheReadTokens: row.cacheReadTokens,
            cacheWriteTokens: row.cacheWriteTokens,
          })
        : null;
    }

    out.push({ ts, costCents, tokens });
  }
  return out;
}

// --- OpenCode Zen usage API (see file-header note 0) ----------------------

/** `resetsAt` may arrive as an ISO string or as an epoch number, and the
 * source did not say which. Both are accepted; anything else yields no reset
 * time rather than a wrong one. */
function parseResetsAt(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw > 1e10 ? raw : raw * 1000;
  }
  if (typeof raw === 'string' && raw.trim()) {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

/**
 * The three windows the Zen endpoint reports, in display order. `windowMs`
 * is only set where the duration is EXACT: a calendar month is 28-31 days,
 * so pairing a synthesised 30-day window with a real `resetsAt` would make
 * pace math read a negative elapsed fraction at the start of a long month.
 * The monthly bucket therefore carries its reset time and no window length.
 */
const ZEN_WINDOWS: Array<{ key: string; id: string; label: string; windowMs?: number }> = [
  { key: 'rolling', id: 'rolling', label: 'Rolling (5h)', windowMs: 18_000_000 },
  { key: 'weekly', id: 'weekly', label: 'Weekly', windowMs: 7 * DAY_MS },
  { key: 'monthly', id: 'monthly', label: 'Monthly' },
];

/**
 * Builds percent buckets from the Zen usage response. Dollar figures are not
 * exposed by this API, so `percent` is the only measure available. A window
 * with no numeric `percent` is omitted rather than shown as zero. Exported
 * for test coverage.
 */
export function buildZenBuckets(json: unknown): QuotaBucket[] {
  const usage = (json as { usage?: unknown } | undefined)?.usage;
  if (!usage || typeof usage !== 'object') return [];
  const windows = usage as Record<string, unknown>;

  const buckets: QuotaBucket[] = [];
  for (const spec of ZEN_WINDOWS) {
    const raw = windows[spec.key];
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const percent = toNumber(entry.percent);
    if (percent == null) continue;

    const used = Math.min(100, Math.max(0, percent));
    const bucket: QuotaBucket = {
      id: spec.id,
      label: spec.label,
      used,
      limit: 100,
      remaining: Math.max(0, 100 - used),
      unit: 'percent',
      enabled: true,
    };
    if (spec.windowMs != null) bucket.windowMs = spec.windowMs;
    const resetsAt = parseResetsAt(entry.resetsAt ?? entry.resets_at);
    if (resetsAt != null) bucket.resetsAt = resetsAt;
    buckets.push(bucket);
  }
  return buckets;
}

// --- Zen API key resolution ------------------------------------------------

/** Provider ids probed in `auth.json` — which one holds the Go key is
 * unconfirmed (file-header note 0), so both are tried. */
const ZEN_PROVIDER_IDS = ['opencode', 'opencode-go'];

/**
 * Pulls an OpenCode Zen key out of an `auth.json` payload. The file's
 * conventional shape is `{ "<providerId>": { "type": "api", "key": "..." } }`,
 * so `key` is the field read. Exported for test coverage.
 */
export function extractZenApiKey(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  for (const id of ZEN_PROVIDER_IDS) {
    const entry = obj[id];
    if (entry && typeof entry === 'object') {
      const key = (entry as Record<string, unknown>).key;
      if (typeof key === 'string' && key.trim()) return key.trim();
    }
    if (typeof entry === 'string' && entry.trim()) return entry.trim();
  }
  return null;
}

async function fetchZenUsage(apiKey: string): Promise<{ status: number; json: unknown }> {
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { net } = require('electron') as typeof import('electron');
    if (net?.fetch) {
      // net.fetch has no built-in timeout, and QuotaService clears its
      // per-connector lock only in a `finally`, so an unsettled request
      // wedges every later poll and the Refresh button.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const res = await net.fetch(ZEN_USAGE_URL, { headers, signal: controller.signal });
        const txt = await res.text();
        try {
          return { status: res.status, json: txt ? JSON.parse(txt) : {} };
        } catch {
          return { status: res.status, json: {} };
        }
      } catch (err) {
        if (controller.signal.aborted) return { status: 408, json: {} };
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
  } catch {
    // fall through to Node's https module (e.g. headless smoke tests)
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const https = require('https') as typeof import('https');
  return new Promise((resolve, reject) => {
    const req = https.get(ZEN_USAGE_URL, { headers }, res => {
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
    req.setTimeout(15_000, () => req.destroy(new Error('OpenCode Zen API timeout')));
  });
}

// --- Today / Yesterday / Last-30d spend tiles (local time) -----------------
//
// Local time here (not the UTC anchoring the cap buckets above use) to match
// the established Phase 1/4 convention every other spend tile in this repo
// follows (`cursor/quota.ts`'s `buildSpendTiles`,
// `shared/jsonl-spend-scanner.ts`'s `aggregate`) — cap buckets are this
// connector's own new UTC-anchored concept, spend tiles are the shared
// cross-connector Total Spend card feature and must stay consistent with it.

function localDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Same DST-safe day-offset construction as `jsonl-spend-scanner.ts`'s `dayKeyOffset`. */
function dayKeyOffset(now: number, daysAgo: number): string {
  const d = new Date(now);
  return localDayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysAgo).getTime());
}

interface DayTotal {
  costCents: number;
  costKnown: boolean;
  tokens: number;
}

/**
 * Today/Yesterday/Last-30d tiles + 30-entry series, matching the
 * `SpendTile`/null-vs-zero contract established in Phase 1/4: `costCents:
 * null` (never `0`) for a period with zero matching sessions. Exported for
 * smoke coverage.
 */
export function buildSpendTiles(records: OpencodeSpendRecord[], now: number): SpendTile[] {
  const perDay = new Map<string, DayTotal>();
  for (const r of records) {
    if (!Number.isFinite(r.ts)) continue;
    const key = localDayKey(r.ts);
    const entry = perDay.get(key) ?? { costCents: 0, costKnown: false, tokens: 0 };
    if (r.costCents != null) {
      entry.costCents += r.costCents;
      entry.costKnown = true;
    }
    entry.tokens += r.tokens;
    perDay.set(key, entry);
  }

  const series: Array<number | null> = [];
  for (let i = 29; i >= 0; i--) {
    const entry = perDay.get(dayKeyOffset(now, i));
    series.push(entry ? (entry.costKnown ? entry.costCents : null) : null);
  }

  const tileFor = (daysAgo: number, period: SpendTile['period'], label: string): SpendTile => {
    const entry = perDay.get(dayKeyOffset(now, daysAgo));
    if (!entry) return { period, label, costCents: null, tokens: null };
    return { period, label, costCents: entry.costKnown ? entry.costCents : null, tokens: entry.tokens };
  };

  let last30dCents = 0;
  let last30dCostKnown = false;
  let last30dTokens = 0;
  let last30dHasAny = false;
  for (let i = 0; i < 30; i++) {
    const entry = perDay.get(dayKeyOffset(now, i));
    if (!entry) continue;
    last30dHasAny = true;
    if (entry.costKnown) {
      last30dCents += entry.costCents;
      last30dCostKnown = true;
    }
    last30dTokens += entry.tokens;
  }

  return [
    tileFor(0, 'today', 'Today'),
    tileFor(1, 'yesterday', 'Yesterday'),
    {
      period: 'last30d',
      label: 'Last 30 days',
      costCents: last30dHasAny ? (last30dCostKnown ? last30dCents : null) : null,
      tokens: last30dHasAny ? last30dTokens : null,
      series,
    },
  ];
}

/**
 * True when no usable session data could be determined at all -- either no
 * `opencode*.db` file was found in any candidate directory, or every file
 * that was found failed to yield a queryable `session` table. `fetch()`
 * fails the whole snapshot (`ok: false`) in this case rather than letting
 * `buildCapBuckets`/`buildSpendTiles` run on an empty array and render a
 * fabricated "confirmed $0" (CRITICAL fix) -- a genuine `used: 0` bucket is
 * only ever produced when at least one db was actually read successfully.
 * Exported for smoke coverage.
 */
export function noUsableSessionData(dbFileCount: number, sessionReadsOk: number): boolean {
  return dbFileCount === 0 || sessionReadsOk === 0;
}

// --- Provider ----------------------------------------------------------------

class OpencodeQuotaProvider implements QuotaProvider {
  constructor(
    private readonly config: Record<string, unknown>,
    private readonly ctx: ConnectorContext,
  ) {}

  /** Secret field first, then the environment, then whichever `auth.json`
   * in a data directory carries a Zen provider entry. */
  private resolveApiKey(existingDirs: string[]): string | null {
    const fromSecret = this.ctx.secret('apiKey');
    if (fromSecret && fromSecret.trim()) return fromSecret.trim();
    const fromEnv = process.env.OPENCODE_API_KEY;
    if (fromEnv && fromEnv.trim()) return fromEnv.trim();
    for (const dir of existingDirs) {
      const key = extractZenApiKey(readAuthFile(dir));
      if (key) return key;
    }
    return null;
  }

  async fetch(): Promise<QuotaSnapshot> {
    const fetchedAt = Date.now();
    const dirs = resolveDataDirs(this.config, this.ctx);
    const existingDirs = dirs.filter(d => fs.existsSync(d));

    // --- Local spend (see file-header note 3) -----------------------------
    const dbFiles: string[] = [];
    for (const dir of existingDirs) dbFiles.push(...findDbFiles(dir));

    const allRows: RawSessionRow[] = [];
    let sessionReadsOk = 0;
    for (const dbFile of dbFiles) {
      try {
        const { sessions, sessionQueryOk } = await readOpencodeDb(dbFile, this.ctx);
        if (sessionQueryOk) {
          sessionReadsOk++;
          allRows.push(...sessions);
        }
      } catch (err) {
        this.ctx.log('warn', '[opencode] failed to open db', { dbFile, err: String(err) });
      }
    }

    // Spend stays `undefined` rather than a zero-filled tile set when no
    // database could be read -- "couldn't determine" is not "$0 spent".
    const haveSpend = !noUsableSessionData(dbFiles.length, sessionReadsOk);
    const spend = haveSpend ? buildSpendTiles(toSpendRecords(allRows), fetchedAt) : undefined;

    // --- Quota windows (see file-header note 0) ---------------------------
    const apiKey = this.resolveApiKey(existingDirs);

    if (!apiKey) {
      if (!haveSpend) {
        return {
          ok: false,
          fetchedAt,
          error:
            'No OpenCode Zen API key and no readable opencode*.db. Paste a key in the OpenCode Quota ' +
            'section (or set OPENCODE_API_KEY) for quota windows, and run OpenCode at least once for ' +
            'local spend.',
          source: existingDirs[0],
        };
      }
      return {
        ok: true,
        fetchedAt,
        buckets: [],
        membershipType: this.membershipFrom(existingDirs),
        displayMessages: [
          'No OpenCode Zen API key set, so quota windows are unavailable. Local spend is shown below.',
        ],
        source: dbFiles[0] ?? existingDirs[0],
        spend,
      };
    }

    const res = await fetchZenUsage(apiKey);
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        fetchedAt,
        needsLogin: true,
        error:
          `OpenCode Zen rejected the API key (HTTP ${res.status}). Paste a current key into the OpenCode ` +
          'Quota section, or sign in again with the OpenCode CLI to refresh it.',
        source: ZEN_USAGE_URL,
      };
    }
    if (res.status >= 400) {
      return {
        ok: false,
        fetchedAt,
        error: `Could not fetch OpenCode Zen usage: HTTP ${res.status}`,
        source: ZEN_USAGE_URL,
      };
    }

    const buckets = buildZenBuckets(res.json);
    if (buckets.length === 0) {
      return {
        ok: false,
        fetchedAt,
        error: 'OpenCode Zen returned no recognisable usage windows.',
        source: ZEN_USAGE_URL,
      };
    }

    return {
      ok: true,
      fetchedAt,
      buckets,
      membershipType: this.membershipFrom(existingDirs),
      displayMessages: [],
      authMethod: 'api-key',
      source: ZEN_USAGE_URL,
      spend,
    };
  }

  private membershipFrom(existingDirs: string[]): string | undefined {
    for (const dir of existingDirs) {
      const label = extractAuthLabel(readAuthFile(dir));
      if (label) return label;
    }
    return undefined;
  }
}

export function createOpencodeQuotaProvider(
  config: Record<string, unknown>,
  ctx: ConnectorContext,
): QuotaProvider {
  return new OpencodeQuotaProvider(config, ctx);
}
