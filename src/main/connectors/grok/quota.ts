import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ConnectorContext, QuotaBucket, QuotaProvider, QuotaSnapshot, SpendTile } from '../types';
import { JsonlSpendScanner, SpendRecord } from '../shared/jsonl-spend-scanner';
import { costCentsFor } from '../shared/model-pricing';

/**
 * Grok CLI quota provider — file-based `~/.grok/auth.json` credentials (the
 * same file the real Grok CLI writes, no keychain), auto-refreshing the
 * token via auth.x.ai when it expires, billing + settings endpoints, plus
 * local spend estimated from `~/.grok/logs/unified.jsonl`.
 *
 * CONFIDENCE NOTES (read before trusting a number) — this dev machine has
 * no `~/.grok` directory at all (checked directly: `ls ~/.grok` fails, see
 * the Phase 5.4 report), so nothing below was verified against a live
 * install:
 *
 * 1. `auth.json` shape — UNVERIFIED. Field names are probed defensively
 *    across several plausible conventions (snake_case and camelCase,
 *    `access_token`/`token`/`api_key`); whichever key name is actually
 *    found is remembered and reused verbatim when writing the refreshed
 *    token back, so this doesn't silently rewrite the file into a
 *    different naming convention than the real Grok CLI expects.
 * 2. Windows path — `~/.grok/auth.json` resolves via `os.homedir()`, same
 *    as `runtime.ts`'s `resolvePath()` does for the `~` prefix elsewhere in
 *    this codebase, so it correctly becomes `%USERPROFILE%\.grok\auth.json`
 *    on Windows. Whether a real Windows Grok CLI install actually uses this
 *    path (vs. some `%APPDATA%`-based convention) is NOT verified — no
 *    Windows-specific fallback is guessed at beyond this.
 * 3. `auth.x.ai` refresh endpoint/grant shape — UNVERIFIED. No client_id is
 *    fabricated (unlike codex-cli's `CODEX_OAUTH_CLIENT_ID`, which is
 *    sourced from a known login flow); if the real endpoint requires one
 *    this call fails closed (`ok:false`, "run grok login"), never a
 *    partial/wrong snapshot.
 * 4. `cli-chat-proxy.grok.com/v1/billing` and `/v1/settings` response
 *    shapes — UNVERIFIED. Parsed defensively across several plausible
 *    field-name conventions; an unrecognised shape yields a missing
 *    bucket/field, never a fabricated value.
 * 5. `~/.grok/logs/unified.jsonl` line shape — UNVERIFIED. Assumes
 *    PER-EVENT (non-cumulative) token counts, the more common JSONL logging
 *    convention in this codebase's own connectors — deliberately does NOT
 *    port codex-cli's cumulative-delta/restart-persistence machinery, since
 *    there's no evidence either way that Grok's log is cumulative. Any line
 *    shape not confidently recognised returns `null`, never a guessed cost.
 */

const BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
const SETTINGS_URL = 'https://cli-chat-proxy.grok.com/v1/settings';
// CONFIDENCE: LOW — see file-header note 3.
const GROK_REFRESH_URL = 'https://auth.x.ai/oauth/token';

const WEEKLY_WINDOW_MS = 604_800_000; // 7d

// --- Small local helpers (self-contained per this codebase's convention) ---

function firstFiniteNumber(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim() === '') continue;
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

/** Epoch ms from a timestamp field, OR from a "resets in N seconds" field. */
/** `null` (never "now") for a missing/unparseable timestamp. Numeric epochs
 * under 1e10 are assumed to be seconds, not ms (a ms epoch this small would
 * be a 1970s date, never a real value here). */
function parseTsMs(raw: unknown): number | null {
  if (raw == null) return null;
  const ms = typeof raw === 'number' ? (raw > 1e10 ? raw : raw * 1000) : new Date(String(raw)).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Epoch ms from a timestamp field, OR from a "resets in N seconds" field.
 * Delegates its timestamp handling to `parseTsMs` rather than duplicating
 * the same epoch-normalization logic inline. */
function resetsAtFrom(tsRaw: unknown, secondsFromNowRaw: unknown): number | null {
  const fromTs = parseTsMs(tsRaw);
  if (fromTs != null) return fromTs;
  const seconds = firstFiniteNumber(secondsFromNowRaw);
  if (seconds != null) return Date.now() + seconds * 1000;
  return null;
}

/**
 * Decides the final windowMs/resetsAt pair for a bucket — a real observed
 * `resetsAt` is only ever surfaced when a genuinely observed `windowMs`
 * backs it (never pair a real reset with a synthesized window; see
 * `zai/quota.ts`'s identical `resolveWindowPairing`, this codebase's
 * established discipline). Exported for smoke coverage.
 */
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

// --- HTTP helper (AbortController + 15s timeout, clean-abort-to-408, no ---
// --- double-timeout stacking on the Node https fallback) -------------------
//
// Copied structurally from github-copilot/quota.ts's `httpsGetJson` (the
// only correct pattern in this codebase) with codex-cli's POST-capable
// signature layered on top — NOT from codex-cli's own `httpJson`, whose
// `net.fetch` branch has no timeout at all.

async function httpJson(
  url: string,
  init: { method?: string; headers: Record<string, string>; body?: string },
): Promise<{ status: number; json: unknown }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { net } = require('electron') as typeof import('electron');
    if (net?.fetch) {
      // net.fetch has no built-in timeout -- without this, a single hung
      // Grok API call wedges every future poll and the Refresh button.
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
        // slow either way -- falling through to the Node https fallback
        // below would just pay the SAME 15s timeout again. Fail closed here
        // (408) instead of retrying via a different transport.
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
    req.setTimeout(15_000, () => req.destroy(new Error('Grok API timeout')));
    if (init.body) req.write(init.body);
    req.end();
  });
}

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
}

// --- Credential file resolution (see file-header notes 1-2) ----------------

interface AuthTokens {
  accessToken?: string;
  refreshToken?: string;
  /** The raw key name the token was found under — reused verbatim on write-back. */
  accessTokenKey?: string;
  refreshTokenKey?: string;
}

interface LoadedAuth {
  path: string;
  raw: Record<string, unknown>;
  tokens: AuthTokens;
}

const ACCESS_TOKEN_KEYS = ['access_token', 'accessToken', 'token', 'api_key', 'apiKey'];
const REFRESH_TOKEN_KEYS = ['refresh_token', 'refreshToken'];

function firstPresentStringKey(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    if (typeof obj[k] === 'string' && obj[k]) return k;
  }
  return undefined;
}

function loadAuthFile(): LoadedAuth | null {
  const authPath = path.join(os.homedir(), '.grok', 'auth.json');
  if (!fs.existsSync(authPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(authPath, 'utf8')) as Record<string, unknown>;
    const accessKey = firstPresentStringKey(raw, ACCESS_TOKEN_KEYS);
    const refreshKey = firstPresentStringKey(raw, REFRESH_TOKEN_KEYS);
    return {
      path: authPath,
      raw,
      tokens: {
        accessToken: accessKey ? (raw[accessKey] as string) : undefined,
        refreshToken: refreshKey ? (raw[refreshKey] as string) : undefined,
        accessTokenKey: accessKey,
        refreshTokenKey: refreshKey,
      },
    };
  } catch {
    return null;
  }
}

/** Writes `data` to `filePath` atomically via a same-directory temp file +
 * rename, preserving the original file's permission mode. Identical to
 * `codex-cli/quota.ts`'s `atomicWriteFile` (self-contained copy per this
 * codebase's per-connector convention). Exported for smoke coverage. */
export function atomicWriteFile(filePath: string, data: string): boolean {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  let mode = 0o600;
  try {
    mode = fs.statSync(filePath).mode;
  } catch {
    // Original doesn't exist yet -- keep the 0o600 default.
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

/** Writes the rotated access/refresh token back into auth.json under
 * whichever key names were originally found (see `AuthTokens.accessTokenKey`
 * / `refreshTokenKey`), preserving every other field. A failed write is
 * logged, never silently swallowed — it can otherwise lock the separate
 * `grok` CLI out. */
function writeTokensBack(auth: LoadedAuth, ctx: ConnectorContext): void {
  const next: Record<string, unknown> = { ...auth.raw };
  next[auth.tokens.accessTokenKey ?? 'access_token'] = auth.tokens.accessToken;
  if (auth.tokens.refreshToken) {
    next[auth.tokens.refreshTokenKey ?? 'refresh_token'] = auth.tokens.refreshToken;
  }
  const ok = atomicWriteFile(auth.path, JSON.stringify(next, null, 2));
  if (!ok) {
    ctx.log('warn', '[grok] failed to persist refreshed auth.json -- original file left untouched', {
      path: auth.path,
    });
  }
}

/** See file-header note 3. Returns `null` (never throws) on any failure. */
async function refreshAccessToken(
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken?: string } | null> {
  try {
    const res = await httpJson(GROK_REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    });
    if (res.status >= 400) return null;
    const json = res.json as Record<string, unknown>;
    const accessToken = firstNonEmptyString(json.access_token, json.accessToken, json.token);
    if (!accessToken) return null;
    const newRefreshToken = firstNonEmptyString(json.refresh_token, json.refreshToken);
    return { accessToken, refreshToken: newRefreshToken };
  } catch {
    return null;
  }
}

// --- Billing / settings response parsing (see file-header note 4) ---------

interface ParsedWindow {
  usedPercent: number;
  resetsAt: number | null;
  windowMs: number | null;
}

interface ParsedBilling {
  weekly?: ParsedWindow;
  payAsYouGo?: boolean;
  creditsUsed?: number;
  creditsLimit?: number | null;
}

/**
 * True when the billing response gave us NOTHING usable at all -- neither a
 * bucket NOR a recognised status message (e.g. a pay-as-you-go-only
 * response, which produces zero buckets but one displayMessages entry, is
 * NOT "no data" -- WARNING fix). Extracted as a pure predicate so the exact
 * branching decision is directly smoke-testable without mocking HTTP/auth.
 * Exported for smoke coverage.
 */
export function noRecognisableGrokData(bucketCount: number, displayMessageCount: number): boolean {
  return bucketCount === 0 && displayMessageCount === 0;
}

function billingRoot(json: unknown): Record<string, unknown> {
  if (!json || typeof json !== 'object') return {};
  const obj = json as Record<string, unknown>;
  return (obj.data && typeof obj.data === 'object' ? obj.data : obj) as Record<string, unknown>;
}

/** Exported for smoke coverage. */
export function parseBillingJson(json: unknown): ParsedBilling {
  const root = billingRoot(json);
  const result: ParsedBilling = {};

  const usedPercent = firstFiniteNumber(
    root.weekly_usage_percent,
    root.weeklyUsagePercent,
    root.used_percent,
    root.usagePercent,
    root.percent_used,
  );
  if (usedPercent != null) {
    const windowSeconds = firstFiniteNumber(root.window_seconds, root.windowSeconds);
    const windowMs = windowSeconds != null ? windowSeconds * 1000 : null;
    const resetsAt = resetsAtFrom(
      root.resets_at ?? root.resetsAt ?? root.reset_at,
      root.resets_in_seconds ?? root.resetsInSeconds,
    );
    result.weekly = { usedPercent: Math.min(100, Math.max(0, usedPercent)), resetsAt, windowMs };
  }

  const payg = root.pay_as_you_go ?? root.payAsYouGo ?? root.is_pay_as_you_go ?? root.paygEnabled;
  if (typeof payg === 'boolean') result.payAsYouGo = payg;

  const creditsUsed = firstFiniteNumber(root.credits_used, root.creditsUsed);
  const creditsLimit = firstFiniteNumber(root.credits_limit, root.creditsLimit, root.credits_total, root.creditsTotal);
  if (creditsUsed != null) {
    result.creditsUsed = creditsUsed;
    result.creditsLimit = creditsLimit;
  }

  return result;
}

/** Exported for smoke coverage. */
export function parsePlanTier(json: unknown): string | null {
  const root = billingRoot(json);
  return (
    firstNonEmptyString(
      root.plan,
      root.planName,
      root.plan_name,
      root.tier,
      root.subscriptionTier,
      root.subscription_tier,
    ) ?? null
  );
}

// --- Local spend scan (see file-header note 5) ------------------------------

/** Exported for smoke coverage. */
export function extractGrokSpend(line: unknown): SpendRecord | null {
  if (!line || typeof line !== 'object') return null;
  const obj = line as Record<string, unknown>;

  const usageRaw = obj.usage && typeof obj.usage === 'object' ? (obj.usage as Record<string, unknown>) : obj;
  const inputTokens = firstFiniteNumber(usageRaw.input_tokens, usageRaw.prompt_tokens);
  const outputTokens = firstFiniteNumber(usageRaw.output_tokens, usageRaw.completion_tokens);
  if (inputTokens == null && outputTokens == null) return null;

  const ts = parseTsMs(obj.timestamp ?? obj.ts ?? obj.time);
  if (ts == null) return null;

  const cacheReadTokens = firstFiniteNumber(usageRaw.cached_tokens, usageRaw.cache_read_tokens) ?? 0;
  const model = firstNonEmptyString(obj.model, usageRaw.model);

  const costCents = model
    ? costCentsFor(model, {
        inputTokens: inputTokens ?? 0,
        outputTokens: outputTokens ?? 0,
        cacheReadTokens,
      })
    : null;

  return {
    ts,
    costCents,
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens,
    model,
  };
}

// --- Provider ----------------------------------------------------------------

class GrokQuotaProvider implements QuotaProvider {
  constructor(private readonly ctx: ConnectorContext) {}

  async fetch(): Promise<QuotaSnapshot> {
    const snapshot = await this.fetchQuota();
    if (!snapshot.ok) return snapshot;
    try {
      const spend = await this.computeSpend();
      return { ...snapshot, spend };
    } catch (err) {
      this.ctx.log('warn', '[grok] local spend scan failed', { err: String(err) });
      return snapshot;
    }
  }

  private async computeSpend(): Promise<SpendTile[]> {
    const patterns = [this.ctx.resolvePath('~/.grok/logs/unified.jsonl')];
    const scanner = JsonlSpendScanner.shared(this.ctx.cacheDir);
    const records = await scanner.scan({
      key: 'grok',
      patterns,
      extract: line => extractGrokSpend(line),
    });
    return scanner.aggregate(records, Date.now());
  }

  private async fetchQuota(): Promise<QuotaSnapshot> {
    const fetchedAt = Date.now();
    const auth = loadAuthFile();

    if (!auth) {
      return {
        ok: false,
        fetchedAt,
        error: 'No Grok auth.json found at ~/.grok/auth.json. Run `grok login` to sign in.',
      };
    }
    if (!auth.tokens.accessToken) {
      return {
        ok: false,
        fetchedAt,
        needsLogin: true,
        error: 'Grok CLI auth.json has no recognisable access token. Run `grok login` to sign in.',
        source: auth.path,
      };
    }

    const billingRes = await this.fetchBillingWithRefresh(auth);
    if (billingRes.status === 401 || billingRes.status === 403) {
      // WARNING fix: don't unconditionally claim a refresh was attempted --
      // `fetchBillingWithRefresh` only refreshes when a refresh token was
      // actually present, so a plain "even after a token refresh attempt"
      // would misreport auth.json files that never had one.
      const error = billingRes.refreshAttempted
        ? `Grok session expired (HTTP ${billingRes.status}) even after a token refresh attempt. ` +
          'Run `grok login` to sign in again.'
        : `Grok session expired (HTTP ${billingRes.status}). No refresh token was available to retry with. ` +
          'Run `grok login` to sign in again.';
      return { ok: false, fetchedAt, needsLogin: true, error, source: auth.path };
    }
    if (billingRes.status >= 400) {
      return { ok: false, fetchedAt, error: `Grok billing API HTTP ${billingRes.status}`, source: BILLING_URL };
    }

    const parsedBilling = parseBillingJson(billingRes.json);
    const buckets: QuotaBucket[] = [];
    const displayMessages: string[] = [];

    if (parsedBilling.weekly) {
      const { usedPercent, resetsAt, windowMs } = parsedBilling.weekly;
      const pairing = resolveWindowPairing(windowMs, resetsAt, WEEKLY_WINDOW_MS);
      const bucket: QuotaBucket = {
        id: 'weekly',
        label: 'Weekly usage',
        used: usedPercent,
        limit: 100,
        remaining: Math.max(0, 100 - usedPercent),
        unit: 'percent',
        enabled: true,
        ...pairing,
      };
      if (parsedBilling.payAsYouGo != null) {
        bucket.note = parsedBilling.payAsYouGo ? 'Pay-as-you-go enabled' : 'Pay-as-you-go disabled';
      }
      buckets.push(bucket);
    } else if (parsedBilling.payAsYouGo != null) {
      // No numeric weekly figure to attach the flag to as a bucket note --
      // a used:null/limit:null bucket would just render "No data", which is
      // worse than surfacing it as a plain status line instead.
      displayMessages.push(parsedBilling.payAsYouGo ? 'Pay-as-you-go: enabled' : 'Pay-as-you-go: disabled');
    }

    if (parsedBilling.creditsUsed != null) {
      buckets.push({
        id: 'credits',
        label: 'Credits',
        used: parsedBilling.creditsUsed,
        limit: parsedBilling.creditsLimit ?? null,
        remaining:
          parsedBilling.creditsLimit != null
            ? Math.max(0, parsedBilling.creditsLimit - parsedBilling.creditsUsed)
            : null,
        unit: 'credits',
        enabled: true,
        defaultVisibility: 'onDemand',
      });
    }

    // WARNING fix: a pay-as-you-go-ONLY response (no weekly %, no credits)
    // is a genuinely recognised, understood shape -- it already produced the
    // `displayMessages` entry above. Only the truly-unrecognised case (no
    // buckets AND nothing in displayMessages) is a real parse failure; an
    // `ok:false` snapshot has no `displayMessages` field at all (confirmed
    // against `QuotaSnapshot`'s type and the renderer's `!q.ok` path), so
    // falling into that branch here would silently discard the message this
    // file just built and misreport a case it actually understood.
    if (noRecognisableGrokData(buckets.length, displayMessages.length)) {
      return {
        ok: false,
        fetchedAt,
        error: 'Grok billing API returned no recognisable usage fields (the endpoint may have changed shape).',
        source: BILLING_URL,
      };
    }

    // Plan tier is non-critical metadata -- a failure here must not fail the
    // whole snapshot (per the task's explicit "non-critical" requirement).
    let membershipType: string | undefined;
    try {
      const settingsRes = await httpJson(SETTINGS_URL, { headers: authHeaders(auth.tokens.accessToken) });
      if (settingsRes.status < 400) {
        membershipType = parsePlanTier(settingsRes.json) ?? undefined;
      }
    } catch {
      // best-effort
    }

    return {
      ok: true,
      fetchedAt,
      buckets,
      membershipType,
      displayMessages,
      authMethod: 'bearer',
      source: BILLING_URL,
    };
  }

  /** Exactly one refresh attempt per poll (not per endpoint call) -- only
   * the billing call is refresh-gated; `/v1/settings` above reuses whatever
   * token is current afterwards and swallows its own failures entirely.
   * `refreshAttempted` reports whether a refresh call was actually made (as
   * opposed to skipped because no refresh token was present) so the caller's
   * error message can say so accurately -- see the WARNING fix above. */
  private async fetchBillingWithRefresh(
    auth: LoadedAuth,
  ): Promise<{ status: number; json: unknown; refreshAttempted: boolean }> {
    let res = await httpJson(BILLING_URL, { headers: authHeaders(auth.tokens.accessToken!) });
    let refreshAttempted = false;
    if ((res.status === 401 || res.status === 403) && auth.tokens.refreshToken) {
      refreshAttempted = true;
      const refreshed = await refreshAccessToken(auth.tokens.refreshToken);
      if (refreshed) {
        auth.tokens.accessToken = refreshed.accessToken;
        if (refreshed.refreshToken) auth.tokens.refreshToken = refreshed.refreshToken;
        writeTokensBack(auth, this.ctx);
        res = await httpJson(BILLING_URL, { headers: authHeaders(auth.tokens.accessToken) });
      }
    }
    return { ...res, refreshAttempted };
  }
}

export function createGrokQuotaProvider(
  _config: Record<string, unknown>,
  ctx: ConnectorContext,
): QuotaProvider {
  return new GrokQuotaProvider(ctx);
}
