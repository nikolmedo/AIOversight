import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ConnectorContext, QuotaBucket, QuotaProvider, QuotaSnapshot, SpendTile } from '../types';
import { readChromiumCookie } from '../shared/chromium-cookies';

/**
 * Cursor quota provider.
 *
 * SOURCE ORDER: `GetCurrentPeriodUsage` (bearer, from the local state DB) ->
 * `cursor.com/api/usage-summary` (browser session cookie) -> the legacy
 * `/auth/usage` request counters.
 *
 * CONFIDENCE NOTES (read before trusting a number):
 *
 * 1. `GET api2.cursor.sh/auth/usage-summary`, which this file used to call
 *    first, appears in NO vendor doc, community tool or search result. That
 *    is an inference from the ABSENCE of any reference — it was NOT observed
 *    returning 404 from this machine. Its practical effect was worse than a
 *    hard failure: the call fell through to the legacy `/auth/usage`
 *    endpoint, which counts REQUESTS (`numRequests` / `maxRequestUsage`) and
 *    so reports a meaningless meter for the dollar-denominated plans Cursor
 *    moved to. The legacy path is kept, but last.
 * 2. `POST api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage`
 *    [C] — what current community tools call. Body `{}`, with
 *    `Connect-Protocol-Version: 1`. Its amounts are in CENTS, and
 *    `billingCycleStart` / `billingCycleEnd` arrive as epoch-MILLISECOND
 *    values delivered as STRINGS.
 * 3. TWO MONEY CONVENTIONS LIVE IN THIS FILE. `GetCurrentPeriodUsage`
 *    reports cents, which `unit: 'usd'` already expects, so those values are
 *    used as-is. The Stripe and CSV endpoints report DOLLARS and must go
 *    through `dollarsToCents`. Mixing the two is a silent 100x error.
 * 4. The cookie endpoint intermittently answers with a Vercel WAF HTML page
 *    under a 403 [C]. That is a transient block, not a parse failure, and is
 *    reported as such rather than as a broken response shape.
 * 5. `export-usage-events-csv` STOPPED EMITTING THE COST COLUMN on
 *    2026-08-01 [D, vendor forum]. Tools moved to
 *    `POST cursor.com/api/dashboard/get-filtered-usage-events`. That endpoint
 *    is NOT called here because no request body or response shape for it was
 *    available to implement against; guessing one would mean inventing a
 *    contract. The CSV path instead degrades honestly: no cost column, or no
 *    parseable cost cell, means NO spend reported, never `$0.00`.
 * 6. There is no official API for individual Pro/Ultra usage. Cursor's Admin
 *    API (`api.cursor.com/teams/*`, basic auth, keys prefixed `crsr_` — not
 *    `key_`) is Teams/Enterprise only, so it cannot serve this connector.
 */

const API_BASE = 'https://api2.cursor.sh';
const CURRENT_PERIOD_USAGE_URL = `${API_BASE}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`;
const STRIPE_PROFILE_URL = `${API_BASE}/auth/full_stripe_profile`;
const COOKIE_USAGE_URL = 'https://cursor.com/api/usage-summary';
const STRIPE_URL = 'https://cursor.com/api/auth/stripe';
const CSV_EXPORT_URL = 'https://cursor.com/api/dashboard/export-usage-events-csv';
const TOKEN_KEY = 'cursorAuth/accessToken';

/** Cursor's Stripe/CSV endpoints report DOLLARS — this is the single, tested
 * conversion point to integer cents (`unit: 'usd'` is always cents). The
 * `GetCurrentPeriodUsage` endpoint already reports cents and must NOT pass
 * through here. See file-header note 3. */
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

/**
 * Decodes one `ItemTable.value`. sql.js hands back a `Uint8Array` for a BLOB
 * column, and Cursor stores some of these values as UTF-16LE — on which
 * `String(bytes)` yields `"123,0,34,0,…"` rather than text. A NUL byte at an
 * odd offset (or a `FF FE` BOM) identifies UTF-16LE; everything else decodes
 * as UTF-8. Trailing NULs are trimmed either way. Exported for test coverage.
 */
export function decodeStateValue(val: unknown): string | null {
  if (val == null) return null;
  if (typeof val === 'string') return val;

  if (val instanceof Uint8Array) {
    if (val.length === 0) return null;
    const buf = Buffer.from(val);
    const hasBom = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe;
    const nulAtOddOffset = buf.length >= 2 && buf[1] === 0x00;
    const text = hasBom || nulAtOddOffset ? buf.toString('utf16le') : buf.toString('utf8');
    return text.replace(/\0+$/, '').replace(/^\ufeff/, '') || null;
  }

  return String(val);
}

/**
 * The `sub` claim of a JWT, read WITHOUT verifying the signature — this is
 * only used to rebuild the `WorkosCursorSessionToken={userId}::{jwt}` cookie
 * form, never to make a trust decision. Exported for test coverage.
 */
export function jwtSubject(jwt: string): string | null {
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8')) as Record<string, unknown>;
    const sub = payload.sub;
    return typeof sub === 'string' && sub.trim() ? sub : null;
  } catch {
    return null;
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
    return decodeStateValue(rows[0]?.values?.[0]?.[0]);
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
  // A counter object that is present but reports no `used` figure is
  // unmeasured, not a measured zero — the same policy `firstFiniteNumber`
  // below is documented to enforce for this file's other numeric reads.
  const used = firstFiniteNumber(counter.used);
  const limit = firstFiniteNumber(counter.limit);
  const remaining =
    firstFiniteNumber(counter.remaining) ??
    (limit != null && used != null ? Math.max(0, limit - used) : null);
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

// --- Raw HTTP (status + body, so a caller can inspect a non-2xx body) -----
//
// `httpsGetJson`/`httpsGetText` above throw on a non-2xx before reading the
// body, which makes the WAF-HTML case (file-header note 4) invisible. This
// returns the body regardless of status and lets the caller decide.

interface RawResponse {
  status: number;
  text: string;
  contentType: string;
}

async function httpRaw(
  url: string,
  init: { method?: string; headers: Record<string, string>; body?: string },
): Promise<RawResponse> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { net } = require('electron') as typeof import('electron');
    if (net?.fetch) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const res = await net.fetch(url, {
          method: init.method ?? 'GET',
          headers: init.headers,
          body: init.body,
          signal: controller.signal,
        });
        return {
          status: res.status,
          text: await res.text(),
          contentType: res.headers.get('content-type') ?? '',
        };
      } catch (err) {
        if (controller.signal.aborted) throw new Error('Cursor API timeout');
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (err) {
    if (String(err).includes('Cursor API')) throw err;
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const https = require('https') as typeof import('https');
  return new Promise((resolve, reject) => {
    const headers = { ...init.headers };
    if (init.body) headers['Content-Length'] = String(Buffer.byteLength(init.body));
    const req = https.request(url, { method: init.method ?? 'GET', headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          text: Buffer.concat(chunks).toString('utf8'),
          contentType: String(res.headers['content-type'] ?? ''),
        }),
      );
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error('Cursor API timeout')));
    if (init.body) req.write(init.body);
    req.end();
  });
}

/**
 * True when a response body is an HTML page rather than the JSON we asked
 * for — the signature of the Vercel WAF block described in file-header note
 * 4. Exported for test coverage.
 */
export function isHtmlBody(text: string, contentType = ''): boolean {
  if (contentType.toLowerCase().includes('text/html')) return true;
  const head = text.trimStart().slice(0, 200).toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.includes('<head>');
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

// --- GetCurrentPeriodUsage (primary source, see file-header note 2) -------

/** Epoch-millisecond values arrive as STRINGS here. Rendered as ISO so the
 * UI's billing-cycle line reads as a date rather than a raw integer. */
function epochMsStringToIso(raw: unknown): string | undefined {
  const n = firstFiniteNumber(raw);
  if (n == null || n <= 0) return undefined;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function percentBucket(
  id: string,
  label: string,
  percent: number,
  defaultVisibility?: 'always' | 'onDemand',
): QuotaBucket {
  const used = Math.min(100, Math.max(0, percent));
  const bucket: QuotaBucket = {
    id,
    label,
    used,
    limit: 100,
    remaining: Math.max(0, 100 - used),
    unit: 'percent',
    enabled: true,
  };
  if (defaultVisibility) bucket.defaultVisibility = defaultVisibility;
  return bucket;
}

/**
 * Parses the `GetCurrentPeriodUsage` body. Every money figure here is
 * ALREADY IN CENTS and must not pass through `dollarsToCents` (file-header
 * note 3). Exported for test coverage.
 */
export function parseCurrentPeriodUsage(json: unknown): ParsedSummary {
  const root = (json ?? {}) as Record<string, unknown>;
  const buckets: QuotaBucket[] = [];

  const planUsageRaw = root.planUsage;
  const planUsage = (planUsageRaw && typeof planUsageRaw === 'object' ? planUsageRaw : {}) as Record<string, unknown>;
  const totalSpend = firstFiniteNumber(planUsage.totalSpend);
  const limit = firstFiniteNumber(planUsage.limit);
  const remaining = firstFiniteNumber(planUsage.remaining);

  if (totalSpend != null) {
    buckets.push({
      id: 'plan-usage',
      label: 'Plan usage this period',
      used: totalSpend,
      limit,
      remaining: remaining ?? (limit != null ? Math.max(0, limit - totalSpend) : null),
      unit: 'usd',
      enabled: true,
    });
  }

  const totalPercent = firstFiniteNumber(root.totalPercentUsed);
  // Only surfaced on its own when there is no dollar meter to carry it;
  // otherwise it would restate `plan-usage` in a second row.
  if (totalPercent != null && totalSpend == null) {
    buckets.push(percentBucket('total-percent', 'Total usage', totalPercent));
  }

  const autoPercent = firstFiniteNumber(root.autoPercentUsed);
  if (autoPercent != null) buckets.push(percentBucket('auto-percent', 'Auto model usage', autoPercent, 'onDemand'));

  const apiPercent = firstFiniteNumber(root.apiPercentUsed);
  if (apiPercent != null) buckets.push(percentBucket('api-percent', 'API key usage', apiPercent, 'onDemand'));

  // Shape unconfirmed: accepted as a bare cents number or as an object
  // carrying its own spend/limit pair.
  const spendLimitRaw = root.spendLimitUsage;
  const spendLimitUsed =
    spendLimitRaw && typeof spendLimitRaw === 'object'
      ? firstFiniteNumber((spendLimitRaw as Record<string, unknown>).totalSpend, (spendLimitRaw as Record<string, unknown>).used)
      : firstFiniteNumber(spendLimitRaw);
  if (spendLimitUsed != null) {
    const spendLimitCap =
      spendLimitRaw && typeof spendLimitRaw === 'object'
        ? firstFiniteNumber((spendLimitRaw as Record<string, unknown>).limit)
        : null;
    buckets.push({
      id: 'spend-limit',
      label: 'Spend limit',
      used: spendLimitUsed,
      limit: spendLimitCap,
      remaining: spendLimitCap != null ? Math.max(0, spendLimitCap - spendLimitUsed) : null,
      unit: 'usd',
      enabled: true,
      defaultVisibility: 'onDemand',
    });
  }

  return {
    membershipType: 'unknown',
    billingCycleStart: epochMsStringToIso(root.billingCycleStart),
    billingCycleEnd: epochMsStringToIso(root.billingCycleEnd),
    displayMessages: [],
    buckets,
  };
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

/** Exported for test coverage. */
export function parseUsageSummary(json: Record<string, unknown>): ParsedSummary {
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

/** `Number('')` is `0`, so an empty or whitespace-only string must be
 * rejected before it becomes a fabricated measured zero — the same guard
 * zai, devin and grok already carry. This is what let an empty CSV cost cell
 * report `$0.00` for a day whose real spend was simply unknown. */
function firstFiniteNumber(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim() === '') continue;
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
    // The cost column was dropped from this export on 2026-08-01 (file-header
    // note 5). No column means no spend figure, which is reported as "no
    // data" by returning undefined — never as zero spend.
    if (dateIdx < 0 || costIdx < 0) return undefined;

    const perDayCents = new Map<string, number>();
    const perDayTokens = new Map<string, number>();
    let anyCostParsed = false;
    for (const row of rows.slice(1)) {
      const rawDate = row[dateIdx];
      const ts = /^\d+$/.test(rawDate ?? '') ? Number(rawDate) : Date.parse(rawDate ?? '');
      if (!Number.isFinite(ts)) continue;
      const key = localDayKey(ts);

      // `firstFiniteNumber`, not `Number(...)`: an empty cell in a
      // still-present-but-no-longer-populated cost column would otherwise
      // coerce to a measured `$0.00` for that day.
      const dollars = firstFiniteNumber(row[costIdx]);
      if (dollars != null) {
        anyCostParsed = true;
        perDayCents.set(key, (perDayCents.get(key) ?? 0) + dollarsToCents(dollars));
      }
      if (tokensIdx >= 0) {
        const tok = firstFiniteNumber(row[tokensIdx]);
        if (tok != null) perDayTokens.set(key, (perDayTokens.get(key) ?? 0) + tok);
      }
    }

    // A cost column that is present but empty on every row is the same
    // situation as a missing one: no spend is known.
    if (!anyCostParsed) return undefined;

    return buildSpendTiles(perDayCents, perDayTokens, tokensIdx >= 0, now);
  } catch {
    return undefined;
  }
}

/** A 401/403 — the credentials are the problem, so the user must sign in
 * again. Distinct from a generic failure so the final error copy can say so. */
class CursorAuthError extends Error {}

/** An edge-firewall HTML challenge (file-header note 4) — transient, and
 * explicitly NOT a statement about the user's credentials. */
class CursorBlockedError extends Error {}

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
    let sawAuthFailure = false;
    let blockMessage: string | null = null;

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
          if (err instanceof CursorAuthError) sawAuthFailure = true;
          if (err instanceof CursorBlockedError) blockMessage = err.message;
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
      if (err instanceof CursorBlockedError) blockMessage = err.message;
      if (err instanceof CursorAuthError) sawAuthFailure = true;

      // A WAF block is transient and says nothing about the credentials
      // (file-header note 4), so it must not be reported as a bad session.
      // It wins over the generic copy even when it came from the bearer
      // attempt and the cookie attempt then failed for an unrelated reason.
      if (blockMessage && !sawAuthFailure) {
        return {
          ok: false,
          fetchedAt,
          error: `${blockMessage} This is usually temporary — the next poll normally succeeds.`,
          source: COOKIE_USAGE_URL,
        };
      }
      failures.push(`Session cookie API: ${String(err)}`);

      // Cursor declares no `login` handler, so `needsLogin` renders as plain
      // error text: the instruction has to live in the message itself.
      return {
        ok: false,
        fetchedAt,
        needsLogin: sawAuthFailure || undefined,
        error: sawAuthFailure
          ? 'Cursor rejected the stored session. Sign in to Cursor again — open the Cursor app, or sign ' +
            `in at cursor.com in your browser (${failures.join('; ')}).`
          : `Could not fetch Cursor usage (${failures.join('; ')}).`,
        source: hasStateDb ? this.stateDbPath : undefined,
      };
    }
  }

  /**
   * Primary path. `GetCurrentPeriodUsage` first (file-header note 2), then
   * the legacy request counters only if it yielded nothing — the ordering
   * this file used to have was the other way round in effect, because its
   * first call targeted an endpoint that does not appear to exist.
   */
  private async fetchWithBearer(token: string, fetchedAt: number): Promise<QuotaSnapshot> {
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
      Accept: 'application/json',
    };

    const res = await httpRaw(CURRENT_PERIOD_USAGE_URL, { method: 'POST', headers, body: '{}' });
    // An HTML page is an edge-firewall challenge whichever host serves it,
    // and is never a statement about the token (file-header note 4).
    if (isHtmlBody(res.text, res.contentType)) {
      throw new CursorBlockedError(
        `Cursor's edge firewall returned an HTML challenge page (HTTP ${res.status}) instead of usage data.`,
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new CursorAuthError(`Cursor API ${res.status}`);
    }
    if (res.status >= 400) throw new Error(`Cursor API ${res.status}`);

    let parsed: ParsedSummary;
    try {
      parsed = parseCurrentPeriodUsage(JSON.parse(res.text || '{}'));
    } catch {
      throw new Error('Invalid JSON from Cursor API');
    }

    if (parsed.buckets.length === 0) {
      const legacyJson = (await httpsGetJson(`${API_BASE}/auth/usage`, {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      })) as Record<string, unknown>;
      parsed.buckets.push(...parseLegacyUsage(legacyJson));
      if (typeof legacyJson.startOfMonth === 'string' && !parsed.billingCycleStart) {
        parsed.billingCycleStart = legacyJson.startOfMonth;
      }
    }

    await this.enrichFromStripeProfile(parsed, token);
    await this.enrichFromStateDb(parsed);
    await this.enrichFromBillingEndpoints(parsed, { Authorization: `Bearer ${token}`, Accept: 'application/json' });
    return {
      ok: true,
      fetchedAt,
      ...parsed,
      authMethod: 'bearer',
      source: CURRENT_PERIOD_USAGE_URL,
    };
  }

  /** Plan name and account email, both optional metadata. */
  private async enrichFromStripeProfile(parsed: ParsedSummary, token: string): Promise<void> {
    try {
      const json = (await httpsGetJson(STRIPE_PROFILE_URL, {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      })) as Record<string, unknown>;
      const membership = json.membershipType ?? json.membership_type;
      if (typeof membership === 'string' && membership.trim() && parsed.membershipType === 'unknown') {
        parsed.membershipType = membership;
      }
    } catch {
      // optional enrichment
    }
  }

  private async fetchWithCookie(fetchedAt: number): Promise<QuotaSnapshot> {
    const cookie = await this.resolveSessionCookie();
    if (!cookie) {
      throw new Error('No WorkosCursorSessionToken cookie found (sign in at cursor.com in a browser)');
    }
    const headers = { Cookie: `WorkosCursorSessionToken=${cookie}`, Accept: 'application/json' };

    const res = await httpRaw(COOKIE_USAGE_URL, { headers });
    if (isHtmlBody(res.text, res.contentType)) {
      throw new CursorBlockedError(
        `Cursor's edge firewall returned an HTML challenge page (HTTP ${res.status}) instead of usage data.`,
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new CursorAuthError(`Cursor API ${res.status}`);
    }
    if (res.status >= 400) throw new Error(`Cursor API ${res.status}`);

    let summaryJson: Record<string, unknown>;
    try {
      summaryJson = JSON.parse(res.text || '{}') as Record<string, unknown>;
    } catch {
      throw new Error('Invalid JSON from Cursor API');
    }

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

  /**
   * The browser cookie when one exists, otherwise one rebuilt from the local
   * JWT: the cookie's value is `{userId}::{jwt}`, where `userId` is the JWT's
   * own `sub` claim, so a signed-in Cursor install can serve this path even
   * when the user never signed in through a browser.
   */
  private async resolveSessionCookie(): Promise<string | null> {
    let fromBrowser: string | null = null;
    try {
      fromBrowser = await readChromiumCookie(
        { appName: 'Cursor' },
        { cookieName: 'WorkosCursorSessionToken', hostPatterns: ['%cursor.com%'] },
      );
    } catch {
      // A locked cookie DB or a failed platform decrypt is indistinguishable
      // from having no cookie, and must not abort the JWT rebuild below.
      fromBrowser = null;
    }
    if (fromBrowser) return fromBrowser;

    try {
      const jwt = await readCursorStateValue(this.stateDbPath, TOKEN_KEY);
      if (!jwt) return null;
      const sub = jwtSubject(jwt);
      return sub ? `${sub}::${jwt}` : null;
    } catch {
      return null;
    }
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
