import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ConnectorContext, QuotaBucket, QuotaProvider, QuotaSnapshot } from '../types';

/**
 * Devin quota provider — file-based `~/.local/share/devin/credentials.toml`
 * (Windows: `%LOCALAPPDATA%\devin\credentials.toml`) parsed by hand (no TOML
 * dependency), calling the configured Connect-RPC server's `GetUserStatus`
 * as a plain JSON POST. No token refresh (per the plan) — a 401/403 is a
 * single explicit failure, not a retry loop.
 *
 * CONFIDENCE NOTES (read before trusting a number) — this dev machine has
 * neither `~/.local/share/devin` nor `%LOCALAPPDATA%\devin` (checked
 * directly during Phase 5.5), so nothing below was verified against a live
 * install:
 *
 * 1. `credentials.toml` shape — the two flat keys (`windsurf_api_key`,
 *    `api_server_url`) are exactly what the task brief specified; the
 *    line-based parser below handles quoted/unquoted values, `#` comments,
 *    and `[section]` headers defensively even though the brief describes a
 *    flat file, in case a real install nests these under a header.
 * 2. Connect-RPC service/method path — UNVERIFIED. `RPC_PATH` follows
 *    Connect's documented unary-POST convention
 *    (`/<package>.<Service>/<Method>`) with a plausible package name
 *    inferred from the credentials key `windsurf_api_key` (suggesting this
 *    backend is Codeium/Windsurf's own API surface). If this path is wrong,
 *    the call simply fails closed (non-2xx -> `ok:false`), never a
 *    fabricated snapshot.
 * 3. `GetUserStatus` response shape — UNVERIFIED. Parsed defensively across
 *    several plausible field-name conventions; an unrecognised shape yields
 *    a missing bucket, never a fabricated `0`.
 * 4. Local-state-DB fallback (`sql.js`, mirroring `cursor/quota.ts`) —
 *    deliberately NOT implemented. There is zero grounding on Devin's local
 *    state DB path or schema on this machine; guessing one would mean
 *    querying an unverified table/column shape with unverified consequences
 *    if a query happened to match by coincidence. Documented as a known
 *    limitation rather than a guessed implementation.
 */

const DEFAULT_SERVER_HOST = 'server.codeium.com';
// CONFIDENCE: LOW — see file-header note 2.
const RPC_PATH = '/exa.api_server_pb.ApiServerService/GetUserStatus';

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
// from github-copilot/quota.ts's `httpsGetJson`, not from codex-cli's own
// `httpJson` (whose net.fetch branch has no timeout at all).

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

function candidateCredentialPaths(): string[] {
  const home = os.homedir();
  const out: string[] = [path.join(home, '.local', 'share', 'devin', 'credentials.toml')];
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    out.push(path.join(localAppData, 'devin', 'credentials.toml'));
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

/**
 * Resolves the Connect-RPC server base URL. A bearer token is about to be
 * POSTed to whatever this resolves to, so a value read off disk must
 * validate as a real http(s) URL before it's trusted -- anything else falls
 * back to the documented default rather than being used verbatim. Exported
 * for smoke coverage.
 */
export function resolveServerUrl(raw: string | undefined): string {
  if (raw && raw.trim()) {
    const candidate = raw.includes('://') ? raw.trim() : `https://${raw.trim()}`;
    try {
      const u = new URL(candidate);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        return candidate.replace(/\/+$/, '');
      }
    } catch {
      // fall through to default
    }
  }
  return `https://${DEFAULT_SERVER_HOST}`;
}

// --- GetUserStatus response parsing (see file-header note 3) ---------------

interface ParsedWindow {
  usedPercent: number;
  resetsAt: number | null;
  windowMs: number | null;
}

function parseUsageWindow(raw: unknown): ParsedWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const usedPercent = firstFiniteNumber(r.used_percent, r.usedPercent, r.percent_used, r.usagePercent);
  if (usedPercent == null) return null;
  const windowSeconds = firstFiniteNumber(r.window_seconds, r.windowSeconds);
  const windowMs = windowSeconds != null ? windowSeconds * 1000 : null;
  const resetsAt = resetsAtFrom(r.resets_at ?? r.resetsAt, r.resets_in_seconds ?? r.resetsInSeconds);
  return { usedPercent: Math.min(100, Math.max(0, usedPercent)), resetsAt, windowMs };
}

interface ParsedUserStatus {
  weekly?: ParsedWindow;
  daily?: ParsedWindow;
  extraBalanceCents?: number;
}

/** Exported for smoke coverage. */
export function parseUserStatus(json: unknown): ParsedUserStatus {
  if (!json || typeof json !== 'object') return {};
  const obj = json as Record<string, unknown>;
  const root = (obj.userStatus ?? obj.user_status ?? obj.data ?? obj) as Record<string, unknown>;

  const result: ParsedUserStatus = {};
  const weekly = parseUsageWindow(root.weekly_quota ?? root.weeklyQuota ?? root.weekly);
  if (weekly) result.weekly = weekly;
  const daily = parseUsageWindow(root.daily_quota ?? root.dailyQuota ?? root.daily);
  if (daily) result.daily = daily;

  const balanceCents = firstFiniteNumber(root.extra_balance_cents, root.extraBalanceCents, root.balance_cents, root.balanceCents);
  const balanceDollars = firstFiniteNumber(root.extra_balance_usd, root.extraBalanceUsd, root.balance_usd, root.balanceUsd);
  if (balanceCents != null) {
    result.extraBalanceCents = Math.round(balanceCents);
  } else if (balanceDollars != null) {
    result.extraBalanceCents = dollarsToCents(balanceDollars);
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
          'No Devin credentials.toml found (looked at ~/.local/share/devin and %LOCALAPPDATA%\\devin). ' +
          'Sign in with Devin to generate it.',
      };
    }
    if (!creds.apiKey) {
      return {
        ok: false,
        fetchedAt,
        needsLogin: true,
        error: 'Devin credentials.toml has no windsurf_api_key. Sign in again to regenerate it.',
        source: creds.path,
      };
    }

    const serverUrl = resolveServerUrl(creds.apiServerUrl);
    const url = `${serverUrl}${RPC_PATH}`;

    const res = await httpJson(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        Authorization: `Bearer ${creds.apiKey}`,
      },
      body: '{}',
    });

    // No token refresh for Devin (per the plan) -- there's no second
    // credential source since the local-state-DB fallback wasn't built (see
    // file-header note 4). One straight failure, not a retry against the
    // identical request.
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        fetchedAt,
        needsLogin: true,
        error: `Devin API returned ${res.status} -- the API key may have expired. Sign in again to refresh credentials.toml.`,
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
