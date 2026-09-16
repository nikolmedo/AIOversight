import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ConnectorContext, QuotaBucket, QuotaProvider, QuotaSnapshot, SpendTile } from '../types';
import { JsonlSpendScanner, SpendRecord } from '../shared/jsonl-spend-scanner';
import { costCentsFor } from '../shared/model-pricing';

/**
 * Grok CLI quota provider — reads the Grok CLI's own `~/.grok/auth.json`
 * (no keychain), calls the billing and settings endpoints, and reports local
 * spend from the CLI's per-session `updates.jsonl` transcripts.
 *
 * READ-ONLY BY POLICY. This connector never writes `auth.json` and never
 * refreshes the OAuth session itself, matching `codex-cli/quota.ts`. Vendor
 * refresh tokens rotate, and the vendor CLI rewrites this file with no
 * locking, so a second writer can invalidate the session of the very tool we
 * are supposed to be observing. An earlier version of this file did both. It
 * also POSTed to `https://auth.x.ai/oauth/token`, which is not the endpoint
 * xAI's OIDC discovery document advertises (`/oauth2/token`), so that refresh
 * could never have succeeded regardless. On a 401/403 the user is sent back
 * to the Grok CLI's own login.
 *
 * CONFIDENCE NOTES (read before trusting a number) — this dev machine has no
 * `~/.grok` directory, so nothing below was verified against a live install:
 *
 * 1. `x-xai-token-auth: xai-grok-cli` on the billing call [C] — a required
 *    header the previous version omitted, and the most likely cause of the
 *    401/403 responses users reported.
 * 2. `auth.json` shape [C] — top-level keys are ISSUER strings of the form
 *    `https://auth.x.ai::<client_id>`, each mapping to an object holding
 *    `key` (the access token), `refresh_token`, `expires_at`, `auth_mode`,
 *    `email`, `team_id`, `user_id` and `principal_type`. The previous
 *    version probed flat `access_token`/`token`/`api_key` keys that this
 *    file does not have. The flat probe is KEPT as a fallback for any build
 *    that does write that shape. `$GROK_HOME` overrides the directory.
 * 3. Billing response [C] — `config.creditUsagePercent`, falling back to
 *    `onDemandUsed.val` over `onDemandCap.val`; reset time from
 *    `config.currentPeriod.end` or `config.billingPeriodEnd`. The older
 *    flat field names stay in the probe list as a fallback.
 * 4. `/v1/settings` [C] — `subscription_tier_display` carries the plan name.
 * 5. Spend source [C] — `~/.grok/sessions/<encoded-cwd>/<session-id>/
 *    updates.jsonl`, rows where `sessionUpdate === 'turn_completed'`.
 *    `usage.costUsdTicks / 1e10` is a vendor-reported EXACT dollar cost, so
 *    it is preferred over estimating from the shared price table. The
 *    previously-scanned `logs/unified.jsonl` carries token counts but no
 *    model id, so it can never be priced — it is kept only as a fallback for
 *    installs with no `sessions/` directory. The row's TIMESTAMP field name
 *    was not specified by the source, so several spellings are probed; a row
 *    with no parseable timestamp is dropped rather than dated to "now".
 */

const BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
const SETTINGS_URL = 'https://cli-chat-proxy.grok.com/v1/settings';

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
// Copied structurally from github-copilot/quota.ts's `httpsGetJson`, with
// codex-cli's POST-capable signature layered on top.

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

/** `x-xai-token-auth` is required by the billing endpoint — see file-header
 * note 1. Omitting it is the likely cause of the 401/403 users reported. */
function authHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'x-xai-token-auth': 'xai-grok-cli',
    Accept: 'application/json',
  };
}

// --- Credential file resolution (see file-header note 2) -------------------

export interface LoadedAuth {
  path: string;
  accessToken?: string;
  /** Present when the token came from an issuer-keyed entry. */
  email?: string;
}

/** `$GROK_HOME` overrides the directory; otherwise `~/.grok`. Exported for
 * test coverage. */
export function grokHomeDir(): string {
  const override = process.env.GROK_HOME;
  return override && override.trim() ? override.trim() : path.join(os.homedir(), '.grok');
}

const ISSUER_PREFIX = 'https://auth.x.ai::';
const FLAT_TOKEN_KEYS = ['access_token', 'accessToken', 'token', 'api_key', 'apiKey'];

/**
 * Parses the real issuer-keyed `auth.json` (file-header note 2): every
 * top-level key is an issuer string, and the access token lives on `key`
 * inside its value. The flat-shape probe is kept as a fallback so a build
 * that writes `access_token` at the top level still works. Exported for test
 * coverage.
 */
export function extractAccessToken(raw: unknown): { accessToken?: string; email?: string } {
  if (!raw || typeof raw !== 'object') return {};
  const obj = raw as Record<string, unknown>;

  for (const [issuer, value] of Object.entries(obj)) {
    if (!issuer.startsWith(ISSUER_PREFIX) || !value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    const token = firstNonEmptyString(entry.key);
    if (token) {
      return { accessToken: token, email: firstNonEmptyString(entry.email) };
    }
  }

  // Fallback: the flat shape this file used to assume.
  for (const k of FLAT_TOKEN_KEYS) {
    const token = firstNonEmptyString(obj[k]);
    if (token) return { accessToken: token };
  }
  return {};
}

function loadAuthFile(): LoadedAuth | null {
  const authPath = path.join(grokHomeDir(), 'auth.json');
  if (!fs.existsSync(authPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(authPath, 'utf8')) as unknown;
    const { accessToken, email } = extractAccessToken(raw);
    return { path: authPath, accessToken, email };
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

/** Unwraps `{ val: n }`, the shape the billing endpoint wraps its numeric
 * amounts in, and tolerates a bare number. */
function amountVal(raw: unknown): number | null {
  if (raw && typeof raw === 'object') {
    return firstFiniteNumber((raw as Record<string, unknown>).val);
  }
  return firstFiniteNumber(raw);
}

/** Exported for smoke coverage. */
export function parseBillingJson(json: unknown): ParsedBilling {
  const root = billingRoot(json);
  const result: ParsedBilling = {};

  // `config` is where the documented fields live (file-header note 3); the
  // flat names stay in the probe list as a fallback for older responses.
  const cfgRaw = root.config;
  const cfg = (cfgRaw && typeof cfgRaw === 'object' ? cfgRaw : {}) as Record<string, unknown>;

  let usedPercent = firstFiniteNumber(
    cfg.creditUsagePercent,
    cfg.credit_usage_percent,
    root.weekly_usage_percent,
    root.weeklyUsagePercent,
    root.used_percent,
    root.usagePercent,
    root.percent_used,
  );
  if (usedPercent == null) {
    const onDemandUsed = amountVal(cfg.onDemandUsed ?? root.onDemandUsed);
    const onDemandCap = amountVal(cfg.onDemandCap ?? root.onDemandCap);
    if (onDemandUsed != null && onDemandCap != null && onDemandCap > 0) {
      usedPercent = (onDemandUsed / onDemandCap) * 100;
    }
  }

  if (usedPercent != null) {
    const windowSeconds = firstFiniteNumber(root.window_seconds, root.windowSeconds);
    const windowMs = windowSeconds != null ? windowSeconds * 1000 : null;
    const currentPeriod = cfg.currentPeriod;
    const periodEnd =
      currentPeriod && typeof currentPeriod === 'object'
        ? (currentPeriod as Record<string, unknown>).end
        : undefined;
    const resetsAt = resetsAtFrom(
      periodEnd ?? cfg.billingPeriodEnd ?? root.resets_at ?? root.resetsAt ?? root.reset_at,
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

/** `subscription_tier_display` is the documented field (file-header note 4);
 * the rest are kept as a fallback. Exported for smoke coverage. */
export function parsePlanTier(json: unknown): string | null {
  const root = billingRoot(json);
  return (
    firstNonEmptyString(
      root.subscription_tier_display,
      root.subscriptionTierDisplay,
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

/** `costUsdTicks` counts ten-billionths of a dollar, so cents = ticks / 1e8.
 * Exported for test coverage. */
export function costTicksToCents(ticks: number): number {
  return Math.round(ticks / 1e8);
}

/** The model id lives on the keys of `usage.modelUsage`, not on the row.
 * Only needed for the price-table fallback. */
function modelFromUsage(usage: Record<string, unknown>): string | undefined {
  const modelUsage = usage.modelUsage;
  if (modelUsage && typeof modelUsage === 'object') {
    const keys = Object.keys(modelUsage as Record<string, unknown>);
    if (keys.length > 0) return keys[0];
  }
  return undefined;
}

/**
 * Parses one `updates.jsonl` row. Only `turn_completed` rows carry usage.
 * `costUsdTicks` is a vendor-reported exact cost and always wins over the
 * shared price table, which is only consulted when the field is absent.
 * Exported for smoke coverage.
 */
export function extractGrokSpend(line: unknown): SpendRecord | null {
  if (!line || typeof line !== 'object') return null;
  const obj = line as Record<string, unknown>;

  const kind = firstNonEmptyString(obj.sessionUpdate, obj.session_update);
  if (kind != null && kind !== 'turn_completed') return null;

  const usage = obj.usage && typeof obj.usage === 'object' ? (obj.usage as Record<string, unknown>) : obj;
  const inputTokens = firstFiniteNumber(usage.inputTokens, usage.input_tokens, usage.prompt_tokens);
  const outputTokens = firstFiniteNumber(usage.outputTokens, usage.output_tokens, usage.completion_tokens);
  if (inputTokens == null && outputTokens == null) return null;

  // The row's timestamp field name is unspecified by the source (file-header
  // note 5), so several spellings are probed. No parseable timestamp means
  // the row is dropped — never dated to "now".
  const ts = parseTsMs(obj.timestamp ?? obj.ts ?? obj.time ?? obj.createdAt ?? obj.created_at);
  if (ts == null) return null;

  const cacheReadTokens =
    firstFiniteNumber(usage.cachedReadTokens, usage.cached_read_tokens, usage.cached_tokens, usage.cache_read_tokens) ?? 0;
  const reasoningTokens = firstFiniteNumber(usage.reasoningTokens, usage.reasoning_tokens) ?? 0;
  const model = firstNonEmptyString(obj.model, usage.model) ?? modelFromUsage(usage);

  const ticks = firstFiniteNumber(usage.costUsdTicks, usage.cost_usd_ticks);
  const costCents =
    ticks != null
      ? costTicksToCents(ticks)
      : model
        ? costCentsFor(model, {
            inputTokens: inputTokens ?? 0,
            outputTokens: outputTokens ?? 0,
            reasoningTokens,
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

  /**
   * Per-session `updates.jsonl` is the primary source (file-header note 5).
   * `logs/unified.jsonl` is only scanned when that yields nothing: it has no
   * model id, so its rows can never be priced, and scanning both would
   * double-count any install that has both.
   */
  private async computeSpend(): Promise<SpendTile[]> {
    const home = grokHomeDir();
    const scanner = JsonlSpendScanner.shared(this.ctx.cacheDir);

    // `**`, not `*/*`: the shared scanner only walks subdirectories when the
    // pattern contains `**`, so a `*/*` form would silently match nothing.
    let records = await scanner.scan({
      key: 'grok',
      patterns: [path.join(home, 'sessions', '**', 'updates.jsonl')],
      extract: line => extractGrokSpend(line),
    });

    if (records.length === 0) {
      records = await scanner.scan({
        key: 'grok-legacy',
        patterns: [path.join(home, 'logs', 'unified.jsonl')],
        extract: line => extractGrokSpend(line),
      });
    }

    return scanner.aggregate(records, Date.now());
  }

  private async fetchQuota(): Promise<QuotaSnapshot> {
    const fetchedAt = Date.now();
    const auth = loadAuthFile();

    if (!auth) {
      return {
        ok: false,
        fetchedAt,
        error: `No Grok auth.json found at ${path.join(grokHomeDir(), 'auth.json')}. Run \`grok login\` to sign in.`,
      };
    }
    if (!auth.accessToken) {
      return {
        ok: false,
        fetchedAt,
        needsLogin: true,
        error: 'Grok CLI auth.json has no recognisable access token. Run `grok login` to sign in.',
        source: auth.path,
      };
    }

    const billingRes = await httpJson(BILLING_URL, { headers: authHeaders(auth.accessToken) });
    if (billingRes.status === 401 || billingRes.status === 403) {
      // No in-process refresh and no write to auth.json — see the file
      // header. The Grok CLI owns this file; we only read it.
      return {
        ok: false,
        fetchedAt,
        needsLogin: true,
        error:
          `Grok rejected the stored session (HTTP ${billingRes.status}). Run \`grok login\` to sign in ` +
          'again — this app deliberately does not refresh or rewrite the CLI\'s auth.json.',
        source: auth.path,
      };
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
        error:
          'Grok reported no usage figures. Accounts that have not been migrated to weekly billing return ' +
          'nothing usable here, so there may be no meter to show rather than a fault.',
        source: BILLING_URL,
      };
    }

    // Plan tier is non-critical metadata -- a failure here must not fail the
    // whole snapshot (per the task's explicit "non-critical" requirement).
    let membershipType: string | undefined;
    try {
      const settingsRes = await httpJson(SETTINGS_URL, { headers: authHeaders(auth.accessToken) });
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

}

export function createGrokQuotaProvider(
  _config: Record<string, unknown>,
  ctx: ConnectorContext,
): QuotaProvider {
  return new GrokQuotaProvider(ctx);
}
