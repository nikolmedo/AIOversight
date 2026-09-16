import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ConnectorContext, QuotaBucket, QuotaProvider, QuotaSnapshot } from '../types';

/**
 * Devin quota provider — reads Devin's local `credentials.toml` (no TOML
 * dependency, hand-parsed) and calls the Codeium backend's
 * `SeatManagementService.GetUserStatus` as a Connect unary JSON POST. No
 * token refresh — a 401/403 is a single explicit failure telling the user
 * where to sign in, never a retry loop or a credential-file rewrite.
 *
 * CONFIDENCE NOTES (read before trusting a number) — this dev machine has no
 * Devin install, so nothing below was verified against live data:
 *
 * 1. `credentials.toml` shape — the two flat keys (`windsurf_api_key`,
 *    `api_server_url`) are as specified; the line parser handles quoted and
 *    unquoted values, `#` comments and `[section]` headers defensively in
 *    case a real install nests them.
 * 2. RPC service — `exa.seat_management_pb.SeatManagementService`, sourced
 *    from the vendor's own issue tracker [D]. This file previously called
 *    `exa.api_server_pb.ApiServerService`, which serves completions and chat
 *    rather than quota, so the quota call could never have worked.
 * 3. Request metadata [C] — `ide_name` must be the literal string
 *    `chisel`. Sending `"devin"` returns `permission_denied: You need a full
 *    seat`. Version fields must parse as SEMVER or the backend answers 500,
 *    hence the literal `1.0.0` placeholders rather than an empty string.
 * 4. Response field names [C] — `dailyQuotaRemainingPercent`,
 *    `weeklyQuotaRemainingPercent`, `planInfo.planName`,
 *    `overageBalanceMicros`. The RESET-timestamp field names were NOT
 *    specified by the source, so several camelCase/snake_case spellings are
 *    probed; an unrecognised one costs a reset time, never a wrong number.
 * 5. OMITTED-FIELD TRAP [C] — a quota percentage field is omitted from the
 *    response when its value is zero. See `parseRemainingPercent`.
 * 6. Local-state-DB fallback — deliberately NOT implemented. There is no
 *    grounding for Devin's local DB path or schema, and guessing one means
 *    querying an unverified shape. A documented limitation, not a guess.
 */

const DEFAULT_SERVER_HOST = 'server.codeium.com';
// See file-header note 2 — the vendor's own service name, not an inference.
const RPC_PATH = '/exa.seat_management_pb.SeatManagementService/GetUserStatus';

/** See file-header note 3 — `chisel`, not `devin`, and semver-shaped versions. */
const IDE_NAME = 'chisel';
const EXTENSION_NAME = 'devin';
const PLACEHOLDER_SEMVER = '1.0.0';

const WEEKLY_WINDOW_MS = 604_800_000; // 7d
const DAILY_WINDOW_MS = 86_400_000; // 1d

// --- Small local helpers (self-contained per this codebase's convention) ---

function firstFiniteNumber(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim() === '') continue;
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

/** Decides the final windowMs/resetsAt pair for a bucket -- a real observed
 * `resetsAt` is only ever surfaced when a genuinely observed `windowMs`
 * backs it (never pair a real reset with a synthesized window; same
 * discipline as `zai/quota.ts`'s `resolveWindowPairing`). Exported for
 * smoke coverage. */
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

/** Dollars in, cents out -- this connector's one conversion point (`unit:
 * 'usd'` is always cents). Exported for smoke coverage. */
export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

// --- HTTP helper (AbortController + 15s timeout, clean-abort-to-408, no ---
// --- double-timeout stacking on the Node https fallback) -------------------
//
// Same fixed pattern as grok/quota.ts's `httpJson` -- copied structurally
// from github-copilot/quota.ts's `httpsGetJson`, with codex-cli's
// POST-capable signature layered on top.

async function httpJson(
  url: string,
  init: { method?: string; headers: Record<string, string>; body?: string },
): Promise<{ status: number; json: unknown }> {
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
        const txt = await res.text();
        try {
          return { status: res.status, json: txt ? JSON.parse(txt) : {} };
        } catch {
          return { status: res.status, json: {} };
        }
      } catch (err) {
        if (controller.signal.aborted) {
          return { status: 408, json: {} };
        }
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
    const headers = { ...init.headers };
    if (init.body) headers['Content-Length'] = String(Buffer.byteLength(init.body));
    const req = https.request(url, { method: init.method ?? 'GET', headers }, res => {
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
    req.setTimeout(15_000, () => req.destroy(new Error('Devin API timeout')));
    if (init.body) req.write(init.body);
    req.end();
  });
}

// --- credentials.toml parsing (hand-rolled, no TOML dependency) ------------

/**
 * Minimal flat-TOML line parser: skips blank lines, `#` comments, and
 * `[section]` headers; accepts `key = "value"`, `key = 'value'`, and
 * `key = value` (bare, with an inline `#comment` stripped). First
 * occurrence of a key wins, matching how a real TOML parser would treat a
 * duplicate top-level key as an error rather than silently letting a later
 * line clobber an earlier one. Exported for smoke coverage.
 */
export function parseFlatToml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('[')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || !/^[A-Za-z0-9_.-]+$/.test(key)) continue;
    if (key in out) continue;

    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      const end = value.indexOf(quote, 1);
      value = end >= 0 ? value.slice(1, end) : value.slice(1);
    } else {
      const hashIdx = value.indexOf('#');
      if (hashIdx >= 0) value = value.slice(0, hashIdx);
      value = value.trim();
    }
    out[key] = value;
  }
  return out;
}

interface DevinCredentials {
  path: string;
  apiKey?: string;
  apiServerUrl?: string;
}

/** Every platform's credential location, in lookup order. `$XDG_DATA_HOME`
 * wins where set; Windows checks both Roaming and Local because which one a
 * given Devin build writes is unconfirmed, and macOS uses the standard
 * Application Support directory. Exported for test coverage. */
export function candidateCredentialPaths(): string[] {
  const home = os.homedir();
  const out: string[] = [];

  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) out.push(path.join(xdg, 'devin', 'credentials.toml'));
  out.push(path.join(home, '.local', 'share', 'devin', 'credentials.toml'));

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    out.push(path.join(appData, 'devin', 'credentials.toml'));
    out.push(path.join(localAppData, 'devin', 'credentials.toml'));
  }
  if (process.platform === 'darwin') {
    out.push(path.join(home, 'Library', 'Application Support', 'devin', 'credentials.toml'));
  }
  return out;
}

function loadCredentials(): DevinCredentials | null {
  for (const p of candidateCredentialPaths()) {
    if (!fs.existsSync(p)) continue;
    try {
      const parsed = parseFlatToml(fs.readFileSync(p, 'utf8'));
      return { path: p, apiKey: parsed.windsurf_api_key, apiServerUrl: parsed.api_server_url };
    } catch {
      continue;
    }
  }
  return null;
}

/** `URL.hostname` keeps the brackets for an IPv6 literal, hence both spellings. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** A rejected `api_server_url`. Carries the URL so the user can fix the file;
 * never the key, which is what the rejection exists to protect. */
export class InsecureServerUrlError extends Error {}

/**
 * Resolves the Connect-RPC server base URL. A bearer token is about to be
 * POSTed to whatever this resolves to, so plain HTTP is only acceptable to a
 * loopback address -- anywhere else it would put the key on the wire in clear
 * text for anything on the path to read. An unparseable or non-http(s) value
 * still falls back to the documented default rather than being used verbatim.
 * Exported for smoke coverage.
 */
export function resolveServerUrl(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed) return `https://${DEFAULT_SERVER_HOST}`;

  const candidate = trimmed.includes('://') ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return `https://${DEFAULT_SERVER_HOST}`;
  }

  if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname))) {
    return candidate.replace(/\/+$/, '');
  }
  if (parsed.protocol === 'http:') {
    throw new InsecureServerUrlError(
      `Devin credentials.toml points api_server_url at ${candidate}. Refusing to send the API key over ` +
        'plain HTTP to a non-loopback host — use an https:// URL, or a localhost address.',
    );
  }
  return `https://${DEFAULT_SERVER_HOST}`;
}

// --- GetUserStatus response parsing (see file-header notes 4-5) ------------

interface ParsedWindow {
  usedPercent: number;
  resetsAt: number | null;
  windowMs: number | null;
}

/**
 * The omitted-field trap (file-header note 5). The backend drops a quota
 * percentage field entirely when its value is zero, so absence is genuinely
 * ambiguous: it means either "fully spent" or "this account has no such
 * window". The reset timestamp disambiguates — a window that has a live
 * reset time exists, so a missing percentage alongside it means 0% remaining.
 *
 * This is the one place in this codebase where a missing field legitimately
 * becomes a measured `0` rather than `null`. Everywhere else the rule holds:
 * `null` means unmeasured and must never be coerced to zero. Absent field AND
 * absent reset time stays `null` — that is "no such window", not "spent".
 *
 * Exported for test coverage.
 */
export function parseRemainingPercent(
  rawPercent: unknown,
  hasLiveResetTime: boolean,
): number | null {
  const explicit = firstFiniteNumber(rawPercent);
  if (explicit != null) return Math.min(100, Math.max(0, explicit));
  return hasLiveResetTime ? 0 : null;
}

interface ParsedUserStatus {
  weekly?: ParsedWindow;
  daily?: ParsedWindow;
  extraBalanceCents?: number;
  planName?: string;
}

/** Reset-time field spellings are unspecified by the source (file-header
 * note 4), so a small set of plausible ones is probed. */
function resetTimeFor(root: Record<string, unknown>, prefix: 'daily' | 'weekly'): number | null {
  const Prefix = prefix === 'daily' ? 'Daily' : 'Weekly';
  return resetsAtFrom(
    root[`${prefix}QuotaResetTime`] ??
      root[`${prefix}_quota_reset_time`] ??
      root[`${prefix}QuotaResetsAt`] ??
      root[`${prefix}ResetTime`] ??
      root[`quota${Prefix}ResetTime`],
    root[`${prefix}QuotaResetsInSeconds`] ?? root[`${prefix}_quota_resets_in_seconds`],
  );
}

function windowFrom(
  root: Record<string, unknown>,
  prefix: 'daily' | 'weekly',
  fallbackWindowMs: number,
): ParsedWindow | null {
  const resetsAt = resetTimeFor(root, prefix);
  const remaining = parseRemainingPercent(
    root[`${prefix}QuotaRemainingPercent`] ?? root[`${prefix}_quota_remaining_percent`],
    resetsAt != null,
  );
  if (remaining == null) return null;
  return {
    usedPercent: Math.min(100, Math.max(0, 100 - remaining)),
    resetsAt,
    // The response carries no window-length field; the window is implied by
    // which field the figure came from, so it counts as observed here.
    windowMs: fallbackWindowMs,
  };
}

/** Exported for smoke coverage. */
export function parseUserStatus(json: unknown): ParsedUserStatus {
  if (!json || typeof json !== 'object') return {};
  const obj = json as Record<string, unknown>;
  const root = (obj.userStatus ?? obj.user_status ?? obj.data ?? obj) as Record<string, unknown>;

  const result: ParsedUserStatus = {};
  const weekly = windowFrom(root, 'weekly', WEEKLY_WINDOW_MS);
  if (weekly) result.weekly = weekly;
  const daily = windowFrom(root, 'daily', DAILY_WINDOW_MS);
  if (daily) result.daily = daily;

  // Micros are millionths of a dollar, so cents = micros / 10_000.
  const overageMicros = firstFiniteNumber(root.overageBalanceMicros, root.overage_balance_micros);
  const balanceCents = firstFiniteNumber(root.extra_balance_cents, root.extraBalanceCents, root.balance_cents, root.balanceCents);
  const balanceDollars = firstFiniteNumber(root.extra_balance_usd, root.extraBalanceUsd, root.balance_usd, root.balanceUsd);
  if (overageMicros != null) {
    result.extraBalanceCents = Math.round(overageMicros / 10_000);
  } else if (balanceCents != null) {
    result.extraBalanceCents = Math.round(balanceCents);
  } else if (balanceDollars != null) {
    result.extraBalanceCents = dollarsToCents(balanceDollars);
  }

  const planInfo = root.planInfo ?? root.plan_info;
  if (planInfo && typeof planInfo === 'object') {
    const p = planInfo as Record<string, unknown>;
    const name = p.planName ?? p.plan_name;
    if (typeof name === 'string' && name.trim()) result.planName = name.trim();
  }

  return result;
}

function windowBucket(id: string, label: string, w: ParsedWindow, fallbackWindowMs: number): QuotaBucket {
  const bucket: QuotaBucket = {
    id,
    label,
    used: w.usedPercent,
    limit: 100,
    remaining: Math.max(0, 100 - w.usedPercent),
    unit: 'percent',
    enabled: true,
  };
  const pairing = resolveWindowPairing(w.windowMs, w.resetsAt, fallbackWindowMs);
  bucket.windowMs = pairing.windowMs;
  if (pairing.resetsAt != null) bucket.resetsAt = pairing.resetsAt;
  return bucket;
}

/**
 * Builds the weekly/daily quota buckets from a parsed `GetUserStatus`
 * response. Extracted as a pure function (rather than inlined in
 * `fetch()`) so this exact branching -- particularly the WARNING-fixed
 * choice to give the "no weekly reported, fall back to daily" case its OWN
 * `'daily'` bucket id rather than overloading the permanent `'weekly'` id
 * -- is directly smoke-testable without mocking HTTP/credentials.
 *
 *   - weekly present (+ daily present)  -> 'weekly' (always) + 'daily' (onDemand)
 *   - weekly present, daily absent      -> 'weekly' (always) only
 *   - weekly absent, daily present      -> 'daily' (always, fallback note) only
 *   - neither present                   -> []
 *
 * Exported for smoke coverage.
 */
export function buildQuotaWindowBuckets(parsed: ParsedUserStatus): QuotaBucket[] {
  const buckets: QuotaBucket[] = [];
  if (parsed.weekly) {
    buckets.push(windowBucket('weekly', 'Weekly quota', parsed.weekly, WEEKLY_WINDOW_MS));
    if (parsed.daily) {
      const dailyBucket = windowBucket('daily', 'Daily quota', parsed.daily, DAILY_WINDOW_MS);
      dailyBucket.defaultVisibility = 'onDemand';
      buckets.push(dailyBucket);
    }
  } else if (parsed.daily) {
    // Fall back: no weekly figure reported at all -- surface the daily
    // figure instead of showing nothing, per the plan's "fall back to a
    // daily figure" instruction. Uses its OWN 'daily' id here, NOT the
    // 'weekly' id -- BucketPref (star/hide/order) is keyed by bucket id, so
    // reusing 'weekly' would let a user's star on the real weekly bucket
    // silently carry over to this substituted daily figure the moment the
    // API's response shape flips between polls (WARNING fix: same id must
    // never mean two different underlying metrics). This branch's bucket is
    // the PRIMARY figure shown (there's nothing else to display), so it
    // stays 'always' visible -- unlike the onDemand secondary role 'daily'
    // plays in the branch above when a real weekly figure is also present.
    const bucket = windowBucket('daily', 'Daily quota (weekly not reported)', parsed.daily, DAILY_WINDOW_MS);
    bucket.note = 'Devin did not report a weekly figure; showing the daily quota instead';
    buckets.push(bucket);
  }
  return buckets;
}

/**
 * The Connect request body. `ide_name` carries the literal `chisel` and the
 * version fields carry a valid semver — see file-header note 3 for what each
 * wrong value costs (a `permission_denied` and a 500 respectively). Exported
 * for test coverage.
 */
export function buildUserStatusRequest(apiKey: string): Record<string, unknown> {
  return {
    metadata: {
      api_key: apiKey,
      ide_name: IDE_NAME,
      ide_version: PLACEHOLDER_SEMVER,
      extension_name: EXTENSION_NAME,
      extension_version: PLACEHOLDER_SEMVER,
    },
  };
}

// --- Provider ----------------------------------------------------------------

class DevinQuotaProvider implements QuotaProvider {
  async fetch(): Promise<QuotaSnapshot> {
    const fetchedAt = Date.now();
    const creds = loadCredentials();

    if (!creds) {
      return {
        ok: false,
        fetchedAt,
        error:
          'No Devin credentials.toml found (looked in ' +
          `${candidateCredentialPaths().join(', ')}). Open the Devin app and sign in to generate it.`,
      };
    }
    if (!creds.apiKey) {
      return {
        ok: false,
        fetchedAt,
        needsLogin: true,
        error:
          'Devin credentials.toml has no windsurf_api_key. Open the Devin app and sign in again to ' +
          'regenerate it.',
        source: creds.path,
      };
    }

    let serverUrl: string;
    try {
      serverUrl = resolveServerUrl(creds.apiServerUrl);
    } catch (err) {
      return {
        ok: false,
        fetchedAt,
        error: err instanceof InsecureServerUrlError ? err.message : String(err),
        source: creds.path,
      };
    }
    const url = `${serverUrl}${RPC_PATH}`;

    const res = await httpJson(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        Authorization: `Bearer ${creds.apiKey}`,
      },
      body: JSON.stringify(buildUserStatusRequest(creds.apiKey)),
    });

    // No token refresh and no credential-file write, matching codex-cli:
    // vendor refresh tokens rotate, and the vendor's own client rewrites this
    // file without locking, so a second writer can invalidate the session of
    // the tool we only observe. A rejected key goes back to the user.
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        fetchedAt,
        needsLogin: true,
        error:
          `Devin API returned ${res.status} — the API key in credentials.toml is no longer accepted. ` +
          'Open the Devin app and sign in again to refresh it.',
        source: creds.path,
      };
    }
    if (res.status >= 400) {
      return { ok: false, fetchedAt, error: `Devin API HTTP ${res.status} on ${url}`, source: creds.path };
    }

    const parsed = parseUserStatus(res.json);
    const buckets: QuotaBucket[] = buildQuotaWindowBuckets(parsed);

    if (parsed.extraBalanceCents != null) {
      buckets.push({
        id: 'extra-balance',
        label: 'Extra balance',
        used: null,
        limit: null,
        remaining: parsed.extraBalanceCents,
        unit: 'usd',
        enabled: true,
        defaultVisibility: 'onDemand',
      });
    }

    if (buckets.length === 0) {
      return {
        ok: false,
        fetchedAt,
        error:
          'Devin GetUserStatus returned no recognisable quota fields (the API shape may differ from what ' +
          'this connector expects).',
        source: url,
      };
    }

    return {
      ok: true,
      fetchedAt,
      buckets,
      membershipType: parsed.planName,
      displayMessages: [],
      authMethod: 'bearer',
      source: url,
    };
  }
}

export function createDevinQuotaProvider(
  _config: Record<string, unknown>,
  _ctx: ConnectorContext,
): QuotaProvider {
  return new DevinQuotaProvider();
}
