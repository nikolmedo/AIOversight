import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ConnectorContext, QuotaBucket, QuotaProvider, QuotaSnapshot, SpendTile } from '../types';
import { readChromiumCookie } from '../shared/chromium-cookies';

const API_BASE = 'https://api2.cursor.sh';
const COOKIE_USAGE_URL = 'https://cursor.com/api/usage-summary';
const STRIPE_URL = 'https://cursor.com/api/auth/stripe';
const CSV_EXPORT_URL = 'https://cursor.com/api/dashboard/export-usage-events-csv';
const TOKEN_KEY = 'cursorAuth/accessToken';

/** Cursor's Stripe/CSV endpoints report dollars — this is the single, tested
 * conversion point to integer cents (`unit: 'usd'` is always cents). */
export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}
const MEMBERSHIP_KEY = 'cursorAuth/stripeMembershipType';

/** Platform-default path to Cursor's VS Code-style global state database. */
export function defaultCursorStateDbPath(): string {
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    case 'win32':
      return path.join(
        process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
        'Cursor',
        'User',
        'globalStorage',
        'state.vscdb',
      );
    default:
      return path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
}

async function readCursorStateValue(dbPath: string, key: string): Promise<string | null> {
  if (!fs.existsSync(dbPath)) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sqlJsModule = require('sql.js') as
    & { default?: typeof import('sql.js') }
    & typeof import('sql.js');
  const initSqlJs = (typeof sqlJsModule === 'function' ? sqlJsModule : sqlJsModule.default)!;
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  const db = new SQL.Database(fs.readFileSync(dbPath));
  try {
    const escaped = key.replace(/'/g, "''");
    const rows = db.exec(`SELECT value FROM ItemTable WHERE key = '${escaped}' LIMIT 1`);
    const val = rows[0]?.values?.[0]?.[0];
    return typeof val === 'string' ? val : val != null ? String(val) : null;
  } finally {
    db.close();
  }
}

interface UsageCounter {
  enabled?: boolean;
  used?: number;
  limit?: number | null;
  remaining?: number | null;
}

function pushBucket(
  buckets: QuotaBucket[],
  id: string,
  label: string,
  counter: UsageCounter | undefined,
  unit: QuotaBucket['unit'],
): void {
  if (!counter || counter.enabled === false) return;
  const used = Number(counter.used ?? 0);
  const limit = counter.limit == null ? null : Number(counter.limit);
  const remaining =
    counter.remaining != null
      ? Number(counter.remaining)
      : limit != null
        ? Math.max(0, limit - used)
        : null;
  buckets.push({ id, label, used, limit, remaining, unit, enabled: true });
}

async function httpsGetJson(url: string, headers: Record<string, string>): Promise<unknown> {
  // Prefer Electron's net.fetch — it uses the OS certificate store and avoids
  // Node's occasional corporate-proxy TLS issues.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { net } = require('electron') as typeof import('electron');
    if (net?.fetch) {
      // net.fetch has no built-in timeout. QuotaService.fetchOne() clears its
      // per-connector `inFlight` lock only in a `finally`, so a request that
      // never settles wedges every later cursor poll AND the Refresh button
      // permanently -- and refreshAll()'s Promise.all means one hung Cursor
      // call blocks every other connector's refresh too. Restart is the only
      // recovery. Same guard as httpsGetText below.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const res = await net.fetch(url, { headers, signal: controller.signal });
        if (!res.ok) throw new Error(`Cursor API ${res.status}`);
        return await res.json();
      } catch (err) {
        // Test the controller, not the error's identity: an aborted fetch
        // rejects with a DOMException, which does not inherit from Error in
        // Chromium. Failing closed here also keeps the abort from reaching
        // the Node https fallback, which would pay the same 15s a second time.
        if (controller.signal.aborted) throw new Error('Cursor API timeout');
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (err) {
    // Both `Cursor API <status>` and `Cursor API timeout` match here, so a real
    // HTTP failure and a timeout both propagate instead of silently retrying
    // through the fallback.
    const msg = String(err);
    if (msg.includes('Cursor API')) throw err;
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const https = require('https') as typeof import('https');
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Cursor API ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body || '{}'));
        } catch {
          reject(new Error('Invalid JSON from Cursor API'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error('Cursor API timeout')));
  });
}

interface ParsedSummary {
  membershipType: string;
  limitType?: string;
  billingCycleStart?: string;
  billingCycleEnd?: string;
  displayMessages: string[];
  buckets: QuotaBucket[];
  spend?: SpendTile[];
}

/** Probes a UsageCounter-shaped container for the first present candidate key. */
function tryPushBucket(
  buckets: QuotaBucket[],
  container: Record<string, UsageCounter> | undefined,
  candidateKeys: string[],
  id: string,
  label: string,
  unit: QuotaBucket['unit'],
  defaultVisibility?: 'always' | 'onDemand',
): void {
  if (!container) return;
  for (const key of candidateKeys) {
    const counter = container[key];
    if (counter && counter.enabled !== false) {
      const before = buckets.length;
      pushBucket(buckets, id, label, counter, unit);
      if (buckets.length > before && defaultVisibility) {
        buckets[buckets.length - 1].defaultVisibility = defaultVisibility;
      }
      return;
    }
  }
}

function parseUsageSummary(json: Record<string, unknown>): ParsedSummary {
  const membershipType = String(json.membershipType ?? 'unknown');
  const limitType = json.limitType != null ? String(json.limitType) : undefined;
  const displayMessages: string[] = [];
  if (typeof json.autoModelSelectedDisplayMessage === 'string') {
    displayMessages.push(json.autoModelSelectedDisplayMessage);
  }
  if (typeof json.namedModelSelectedDisplayMessage === 'string') {
    displayMessages.push(json.namedModelSelectedDisplayMessage);
  }
  const buckets: QuotaBucket[] = [];
  const individual = json.individualUsage as Record<string, UsageCounter> | undefined;
  if (individual?.overall) {
    pushBucket(buckets, 'individual-overall', 'Your included usage', individual.overall, 'credits');
  }
  const team = json.teamUsage as Record<string, UsageCounter> | undefined;
  if (team?.onDemand) {
    pushBucket(buckets, 'team-on-demand', 'Team on-demand pool', team.onDemand, 'credits');
  }

  // Richer breakdown (Phase 3) — probed defensively (same approach as this
  // file's existing `individual-overall`/`team-on-demand` reads): a shape we
  // don't recognise yields a missing bucket, never a fabricated `0`. Units
  // stay 'requests'/'credits' (this endpoint's existing convention) rather
  // than 'usd' — we don't have confirmed dollar semantics for these fields,
  // unlike the Stripe/CSV endpoints below, which explicitly report dollars.
  tryPushBucket(buckets, individual, ['included', 'requestsIncluded', 'planIncluded'],
    'requests-included', 'Requests included in plan', 'requests');
  tryPushBucket(buckets, individual, ['auto', 'autoUsage'],
    'auto-usage', 'Usage-based (Auto) spend', 'credits', 'onDemand');
  tryPushBucket(buckets, individual, ['api', 'apiUsage', 'apiKeyUsage'],
    'api-usage', 'API key usage', 'credits', 'onDemand');
  tryPushBucket(buckets, individual, ['onDemand', 'extraOnDemand'],
    'extra-on-demand', 'Extra usage on demand', 'credits', 'onDemand');

  return {
    membershipType,
    limitType,
    billingCycleStart: typeof json.billingCycleStart === 'string' ? json.billingCycleStart : undefined,
    billingCycleEnd: typeof json.billingCycleEnd === 'string' ? json.billingCycleEnd : undefined,
    displayMessages,
    buckets,
  };
}

function parseLegacyUsage(json: Record<string, unknown>): QuotaBucket[] {
  const buckets: QuotaBucket[] = [];
  for (const [model, raw] of Object.entries(json)) {
    if (model === 'startOfMonth' || typeof raw !== 'object' || raw == null) continue;
    const m = raw as Record<string, unknown>;
    const used = Number(m.numRequests ?? m.numRequestsTotal ?? 0);
    const limit = m.maxRequestUsage != null ? Number(m.maxRequestUsage) : null;
    if (limit == null && used === 0) continue;
    buckets.push({
      id: `model-${model}`,
      label: `${model} requests`,
      used,
      limit,
      remaining: limit != null ? Math.max(0, limit - used) : null,
      unit: 'requests',
      enabled: true,
    });
  }
  return buckets;
}

function firstFiniteNumber(...vals: unknown[]): number | null {
  for (const v of vals) {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (Number.isFinite(n)) return n;
  }
  return null;
}

async function httpsGetText(url: string, headers: Record<string, string>): Promise<string> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { net } = require('electron') as typeof import('electron');
    if (net?.fetch) {
      // net.fetch has no built-in timeout -- a stalled CSV export would never
      // settle, and QuotaService's fetchOne() clears `inFlight` only in its
      // `finally`, so the dead promise wedges every future cursor poll and the
      // Refresh button until the app restarts (refreshAll's Promise.all drags
      // every other connector down with it). Same fix as zai/grok/openrouter.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const res = await net.fetch(url, { headers, signal: controller.signal });
        if (!res.ok) throw new Error(`Cursor API ${res.status}`);
        return await res.text();
      } catch (err) {
        // Test `controller.signal.aborted`, NOT the caught error's identity:
        // an aborted fetch rejects with a DOMException, which does not
        // inherit from Error in Chromium, so `err instanceof Error` can be
        // false exactly when it matters. Matches every other connector.
        // Failing closed here also stops the abort from reaching the Node
        // https fallback below, which would pay the same 15s a second time.
        if (controller.signal.aborted) throw new Error('Cursor API timeout');
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (err) {
    // Both `Cursor API <status>` and `Cursor API timeout` match here, so a
    // real HTTP failure and a timeout both propagate instead of silently
    // retrying through the fallback.
    const msg = String(err);
    if (msg.includes('Cursor API')) throw err;
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const https = require('https') as typeof import('https');
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Cursor API ${res.statusCode}`));
          return;
        }
        resolve(body);
      });
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error('Cursor API timeout')));
  });
}

/** Fetches prepaid/granted credit balances. Dollars in, cents out — the
 * one conversion point this file's Stripe path needs. Non-fatal: an empty
 * array means "not available", never a fabricated bucket. */
async function fetchStripeBuckets(headers: Record<string, string>): Promise<QuotaBucket[]> {
  try {
    const json = (await httpsGetJson(STRIPE_URL, headers)) as Record<string, unknown>;
    const buckets: QuotaBucket[] = [];

    const grant = firstFiniteNumber(json.creditsGrant, json.grant, json.grantBalance);
    if (grant != null) {
      buckets.push({
        id: 'credits-grant',
        label: 'Granted credits balance',
        used: null,
        limit: null,
        remaining: dollarsToCents(grant),
        unit: 'usd',
        enabled: true,
        defaultVisibility: 'onDemand',
      });
    }

    const prepaid = firstFiniteNumber(json.creditsPrepaid, json.prepaid, json.balance, json.customerBalance);
    if (prepaid != null) {
      buckets.push({
        id: 'credits-prepaid',
        label: 'Prepaid credits balance',
        used: null,
        limit: null,
        remaining: dollarsToCents(prepaid),
        unit: 'usd',
        enabled: true,
        defaultVisibility: 'onDemand',
      });
    }

    return buckets;
  } catch {
    return [];
  }
}

// --- Per-day spend CSV --------------------------------------------------------

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function parseCsv(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter(l => l.length > 0)
    .map(parseCsvLine);
}

function localDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function findColumnIndex(header: string[], candidates: string[]): number {
  const lower = header.map(h => h.trim().toLowerCase());
  for (const c of candidates) {
    const idx = lower.indexOf(c);
    if (idx >= 0) return idx;
  }
  return -1;
}

/** `perDayCents`/`perDayTokens` only hold a key for a day that actually had
 * at least one CSV row — `.has()` is the null-vs-zero signal here, not `?? 0`.
 * Every site below must use it: a day with no row is unmeasured (`null`),
 * not a measured `$0.00`. Exported for smoke coverage. */
export function buildSpendTiles(
  perDayCents: Map<string, number>,
  perDayTokens: Map<string, number>,
  hasTokensColumn: boolean,
  now: number,
): SpendTile[] {
  const series: Array<number | null> = [];
  for (let i = 29; i >= 0; i--) {
    const key = localDayKey(now - i * 24 * 3_600_000);
    series.push(perDayCents.has(key) ? perDayCents.get(key)! : null);
  }

  let last30dCents = 0;
  let last30dHasAny = false;
  let last30dTokens = 0;
  let last30dHasTokens = false;
  for (let i = 0; i < 30; i++) {
    const key = localDayKey(now - i * 24 * 3_600_000);
    if (perDayCents.has(key)) {
      last30dCents += perDayCents.get(key)!;
      last30dHasAny = true;
    }
    if (hasTokensColumn && perDayTokens.has(key)) {
      last30dTokens += perDayTokens.get(key)!;
      last30dHasTokens = true;
    }
  }

  const todayKey = localDayKey(now);
  const yesterdayKey = localDayKey(now - 24 * 3_600_000);
  const tokensFor = (key: string): number | null =>
    hasTokensColumn && perDayTokens.has(key) ? perDayTokens.get(key)! : null;

  return [
    {
      period: 'today',
      label: 'Today',
      costCents: perDayCents.has(todayKey) ? perDayCents.get(todayKey)! : null,
      tokens: tokensFor(todayKey),
    },
    {
      period: 'yesterday',
      label: 'Yesterday',
      costCents: perDayCents.has(yesterdayKey) ? perDayCents.get(yesterdayKey)! : null,
      tokens: tokensFor(yesterdayKey),
    },
    {
      period: 'last30d',
      label: 'Last 30 days',
      costCents: last30dHasAny ? last30dCents : null,
      tokens: hasTokensColumn && last30dHasTokens ? last30dTokens : null,
      series,
    },
  ];
}

/** Fetches per-day spend via the usage-events CSV export. Best-effort: a
 * missing/unrecognised CSV shape returns `undefined` (no spend[] at all),
 * never a fabricated zero-filled tile set. Dollars in, cents out. */
async function fetchSpendFromCsv(headers: Record<string, string>): Promise<SpendTile[] | undefined> {
  try {
    const now = Date.now();
    const start = now - 31 * 24 * 3_600_000;
    const url = `${CSV_EXPORT_URL}?startDate=${start}&endDate=${now}`;
    const text = await httpsGetText(url, headers);
    if (!text || !text.trim()) return undefined;

    const rows = parseCsv(text);
    if (rows.length < 2) return undefined;
    const header = rows[0];
    const dateIdx = findColumnIndex(header, ['date', 'day', 'created_at', 'timestamp']);
    const costIdx = findColumnIndex(header, ['cost', 'amount', 'total_cost', 'usd', 'price']);
    const tokensIdx = findColumnIndex(header, ['tokens', 'total_tokens', 'token_count']);
    if (dateIdx < 0 || costIdx < 0) return undefined;

    const perDayCents = new Map<string, number>();
    const perDayTokens = new Map<string, number>();
    for (const row of rows.slice(1)) {
      const rawDate = row[dateIdx];
      const ts = /^\d+$/.test(rawDate ?? '') ? Number(rawDate) : Date.parse(rawDate ?? '');
      if (!Number.isFinite(ts)) continue;
      const key = localDayKey(ts);

      const dollars = Number(row[costIdx]);
      if (Number.isFinite(dollars)) {
        perDayCents.set(key, (perDayCents.get(key) ?? 0) + dollarsToCents(dollars));
      }
      if (tokensIdx >= 0) {
        const tok = Number(row[tokensIdx]);
        if (Number.isFinite(tok)) perDayTokens.set(key, (perDayTokens.get(key) ?? 0) + tok);
      }
    }

    return buildSpendTiles(perDayCents, perDayTokens, tokensIdx >= 0, now);
  } catch {
    return undefined;
  }
}

/** Fetch current Cursor quota: bearer token first, WorkosCursorSessionToken cookie fallback. */
class CursorQuotaProvider implements QuotaProvider {
  constructor(
    private readonly stateDbPath: string,
    private readonly ctx: ConnectorContext,
  ) {}

  async fetch(): Promise<QuotaSnapshot> {
    const fetchedAt = Date.now();
    const failures: string[] = [];
    const hasStateDb = fs.existsSync(this.stateDbPath);

    if (hasStateDb) {
      let token: string | null = null;
      try {
        token = await readCursorStateValue(this.stateDbPath, TOKEN_KEY);
      } catch (err) {
        failures.push(`Could not read Cursor database: ${String(err)}`);
      }
      if (token) {
        try {
          return await this.fetchWithBearer(token, fetchedAt);
        } catch (err) {
          failures.push(`Access token API: ${String(err)}`);
        }
      } else if (failures.length === 0) {
        failures.push('No Cursor access token in local database');
      }
    } else {
      failures.push('Cursor state database not found');
    }

    try {
      return await this.fetchWithCookie(fetchedAt);
    } catch (err) {
      failures.push(`Session cookie API: ${String(err)}`);
      return {
        ok: false,
        fetchedAt,
        error: `Could not fetch Cursor usage (${failures.join('; ')}).`,
        source: hasStateDb ? this.stateDbPath : undefined,
      };
    }
  }

  private async fetchWithBearer(token: string, fetchedAt: number): Promise<QuotaSnapshot> {
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    const summaryJson = (await httpsGetJson(`${API_BASE}/auth/usage-summary`, headers)) as Record<
      string,
      unknown
    >;
    const parsed = parseUsageSummary(summaryJson);

    if (parsed.buckets.length === 0) {
      const legacyJson = (await httpsGetJson(`${API_BASE}/auth/usage`, headers)) as Record<
        string,
        unknown
      >;
      parsed.buckets.push(...parseLegacyUsage(legacyJson));
      if (typeof legacyJson.startOfMonth === 'string' && !parsed.billingCycleStart) {
        parsed.billingCycleStart = legacyJson.startOfMonth;
      }
    }

    await this.enrichFromStateDb(parsed);
    await this.enrichFromBillingEndpoints(parsed, headers);
    return {
      ok: true,
      fetchedAt,
      ...parsed,
      authMethod: 'bearer',
      source: this.stateDbPath,
    };
  }

  private async fetchWithCookie(fetchedAt: number): Promise<QuotaSnapshot> {
    const cookie = await readChromiumCookie(
      { appName: 'Cursor' },
      { cookieName: 'WorkosCursorSessionToken', hostPatterns: ['%cursor.com%'] },
    );
    if (!cookie) {
      throw new Error('No WorkosCursorSessionToken cookie found (sign in at cursor.com in a browser)');
    }
    const headers = { Cookie: `WorkosCursorSessionToken=${cookie}`, Accept: 'application/json' };
    const summaryJson = (await httpsGetJson(COOKIE_USAGE_URL, headers)) as Record<string, unknown>;
    const parsed = parseUsageSummary(summaryJson);
    await this.enrichFromStateDb(parsed);
    await this.enrichFromBillingEndpoints(parsed, headers);
    return {
      ok: true,
      fetchedAt,
      ...parsed,
      authMethod: 'cookie',
      source: COOKIE_USAGE_URL,
    };
  }

  private async enrichFromStateDb(parsed: ParsedSummary): Promise<void> {
    if (!fs.existsSync(this.stateDbPath)) return;
    try {
      const membershipFromDb = await readCursorStateValue(this.stateDbPath, MEMBERSHIP_KEY);
      if (membershipFromDb && parsed.membershipType === 'unknown') {
        parsed.membershipType = membershipFromDb;
      }
    } catch {
      // optional enrichment
    }
  }

  /** Stripe balance + per-day spend CSV — both optional, both non-fatal.
   * Reuses whichever auth headers the primary summary fetch already
   * established (bearer or cookie); cursor.com/api2.cursor.sh share auth. */
  private async enrichFromBillingEndpoints(
    parsed: ParsedSummary,
    headers: Record<string, string>,
  ): Promise<void> {
    const [stripeBuckets, spend] = await Promise.all([
      fetchStripeBuckets(headers),
      fetchSpendFromCsv(headers),
    ]);
    parsed.buckets.push(...stripeBuckets);

    if (spend) {
      parsed.spend = spend;
      const last30d = spend.find(s => s.period === 'last30d');
      if (last30d && last30d.costCents != null) {
        parsed.buckets.unshift({
          id: 'total-usage',
          label: 'Total usage (last 30 days)',
          used: last30d.costCents,
          limit: null,
          remaining: null,
          unit: 'usd',
          enabled: true,
        });
      }
    }
  }
}

export function createCursorQuotaProvider(
  config: Record<string, unknown>,
  ctx: ConnectorContext,
): QuotaProvider {
  const stateDbPath = (config.stateDbPath as string | undefined)?.trim() || defaultCursorStateDbPath();
  return new CursorQuotaProvider(ctx.resolvePath(stateDbPath), ctx);
}
