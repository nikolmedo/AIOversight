import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ConnectorContext, QuotaBucket, QuotaProvider, QuotaSnapshot, SpendTile } from '../types';
import { costCentsFor } from '../shared/model-pricing';

/**
 * OpenCode connector — fully offline, zero API calls. Reads OpenCode's own
 * local SQLite database(s) (`opencode*.db`) plus an optional `auth.json`.
 *
 * CONFIDENCE NOTES (read before trusting a number):
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
 * 3. $12 / $30 / $60 session / weekly / monthly dollar caps — these are the
 *    plan's directed figures, implemented as fixed local reference caps
 *    (not fetched from any account/subscription API — there is no such API
 *    call in this connector). No evidence in the verified schema ties these
 *    numbers to a real OpenCode-side plan/tier; treat them as this
 *    connector's own configured budget markers, not authoritative billing
 *    limits sourced from OpenCode itself.
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
const SESSION_WINDOW_MS = 18_000_000; // 5h
const SESSION_CAP_CENTS = 1_200; // $12
const WEEKLY_CAP_CENTS = 3_000; // $30
const MONTHLY_CAP_CENTS = 6_000; // $60

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

// --- Session / weekly / monthly cap buckets (UTC-anchored) -----------------

function utcMondayStart(now: number): number {
  const d = new Date(now);
  const daysSinceMonday = (d.getUTCDay() + 6) % 7; // Mon=0, Tue=1, ..., Sun=6
  const utcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return utcMidnight - daysSinceMonday * DAY_MS;
}

function utcMonthStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function utcNextMonthStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/**
 * Session (rolling trailing 5h, $12), weekly (UTC-Monday-anchored calendar
 * week, $30), and monthly (UTC calendar month, $60) spend caps, summed from
 * local session cost data. The session bucket deliberately has no
 * `resetsAt`/`windowMs` — it's a continuously-sliding look-back with no
 * discrete reset moment, unlike weekly/monthly's real calendar boundaries
 * (never synthesize a reset that doesn't genuinely exist, matching
 * `codex-cli/quota.ts`'s `windowBucket` convention). Exported for smoke
 * coverage.
 */
export function buildCapBuckets(records: OpencodeSpendRecord[], now: number): QuotaBucket[] {
  const sessionStart = now - SESSION_WINDOW_MS;
  const weekStart = utcMondayStart(now);
  const weekEnd = weekStart + 7 * DAY_MS;
  const monthStart = utcMonthStart(now);
  const monthEnd = utcNextMonthStart(now);

  let sessionCents = 0;
  let weekCents = 0;
  let monthCents = 0;
  for (const r of records) {
    if (r.costCents == null) continue;
    if (r.ts >= sessionStart && r.ts <= now) sessionCents += r.costCents;
    if (r.ts >= weekStart && r.ts < weekEnd) weekCents += r.costCents;
    if (r.ts >= monthStart && r.ts < monthEnd) monthCents += r.costCents;
  }

  return [
    {
      id: 'session',
      label: 'Session (rolling 5h)',
      used: sessionCents,
      limit: SESSION_CAP_CENTS,
      remaining: Math.max(0, SESSION_CAP_CENTS - sessionCents),
      unit: 'usd',
      enabled: true,
      note: 'Rolling trailing 5-hour spend, not a fixed reset time',
    },
    {
      id: 'weekly',
      label: 'Weekly (UTC, resets Monday)',
      used: weekCents,
      limit: WEEKLY_CAP_CENTS,
      remaining: Math.max(0, WEEKLY_CAP_CENTS - weekCents),
      unit: 'usd',
      enabled: true,
      resetsAt: weekEnd,
      windowMs: 7 * DAY_MS,
    },
    {
      id: 'monthly',
      label: 'Monthly (UTC calendar month)',
      used: monthCents,
      limit: MONTHLY_CAP_CENTS,
      remaining: Math.max(0, MONTHLY_CAP_CENTS - monthCents),
      unit: 'usd',
      enabled: true,
      resetsAt: monthEnd,
      windowMs: monthEnd - monthStart,
    },
  ];
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

  async fetch(): Promise<QuotaSnapshot> {
    const fetchedAt = Date.now();
    const dirs = resolveDataDirs(this.config, this.ctx);
    const existingDirs = dirs.filter(d => fs.existsSync(d));

    if (existingDirs.length === 0) {
      return {
        ok: false,
        fetchedAt,
        error:
          `No OpenCode data directory found (looked in ${dirs.join(', ')}). Run OpenCode at least once, ` +
          'or set $OPENCODE_DATA_DIR / the data directory setting.',
      };
    }

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

    // CRITICAL fix: distinguish "confirmed zero usage" from "couldn't
    // determine" -- see `noUsableSessionData`'s doc comment.
    if (noUsableSessionData(dbFiles.length, sessionReadsOk)) {
      return {
        ok: false,
        fetchedAt,
        error:
          dbFiles.length === 0
            ? `No opencode*.db file found in ${existingDirs.join(', ')}. Run OpenCode at least once to ` +
              'generate local usage data.'
            : `Found ${dbFiles.length} OpenCode database file(s) but could not read session data from any ` +
              'of them (see the Logs tab for details).',
        source: dbFiles[0] ?? existingDirs[0],
      };
    }

    let membershipType: string | undefined;
    for (const dir of existingDirs) {
      const label = extractAuthLabel(readAuthFile(dir));
      if (label) {
        membershipType = label;
        break;
      }
    }

    const records = toSpendRecords(allRows);
    const buckets = buildCapBuckets(records, fetchedAt);
    const spend = buildSpendTiles(records, fetchedAt);

    return {
      ok: true,
      fetchedAt,
      buckets,
      membershipType,
      displayMessages: [],
      source: dbFiles[0] ?? existingDirs[0],
      spend,
    };
  }
}

export function createOpencodeQuotaProvider(
  config: Record<string, unknown>,
  ctx: ConnectorContext,
): QuotaProvider {
  return new OpencodeQuotaProvider(config, ctx);
}
