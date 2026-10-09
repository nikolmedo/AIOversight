import { ConnectorContext, QuotaBucket, QuotaProvider, QuotaSnapshot } from '../types';
import { readChromiumCookie } from '../shared/chromium-cookies';
import { parseClaudeUsage } from '../claude-code/quota';

const ADMIN_USAGE_URL = 'https://api.anthropic.com/v1/organizations/usage_report/messages';
const ADMIN_COST_URL = 'https://api.anthropic.com/v1/organizations/cost_report';
const CLAUDE_AI_USAGE_URL = 'https://claude.ai/api/organizations';
const ADMIN_KEYS_URL = 'platform.claude.com/settings/admin-keys';

/** Both reports default to 7 daily buckets per page; 31 (their maximum)
 * covers a whole calendar month in one request. */
const PAGE_LIMIT = 31;
/** A month fits on one page, so more than a few pages means the cursor is
 * not advancing; stop rather than poll in a loop. */
const MAX_PAGES = 5;

/** Fallback when a 429 arrives with no usable `Retry-After`. */
const DEFAULT_RETRY_AFTER_MS = 60_000;

interface HttpJsonResult {
  status: number;
  json: unknown;
  /** Only populated on a 429. See `parseRetryAfterMs`. */
  retryAfterMs?: number;
}

/**
 * `Retry-After` is either a delta in seconds or an HTTP date (RFC 9110).
 * Anthropic sends seconds, but a proxy in front of it may not, so both are
 * accepted and anything unparseable falls back to a minute — the cadence
 * Anthropic's Admin API docs ask integrations to stay under anyway.
 */
function parseRetryAfterMs(raw: string | null | undefined): number {
  if (!raw) return DEFAULT_RETRY_AFTER_MS;
  const trimmed = raw.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return DEFAULT_RETRY_AFTER_MS;
}

/**
 * Identifies this app to Anthropic, whose docs ask integrations to send a
 * User-Agent. `app.getVersion()` is only reachable inside a live Electron
 * runtime — under plain Node (`scripts/smoke.js`) `require('electron')`
 * resolves to the binary path string — so this falls back to a hardcoded
 * literal that must be bumped alongside package.json's `version` field.
 */
function userAgent(): string {
  let version = '0.2.3';
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron');
    if (typeof app?.getVersion === 'function') version = app.getVersion();
  } catch {
    // keep the hardcoded fallback
  }
  return `AIOversight/${version} (https://github.com/nikolmedo/AIOversight)`;
}

async function httpsGetJson(
  url: string,
  headers: Record<string, string>,
): Promise<HttpJsonResult> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { net } = require('electron') as typeof import('electron');
    if (net?.fetch) {
      // net.fetch has no built-in timeout -- without this, a single hung
      // Anthropic call wedges every future poll and the Refresh button (and,
      // via refreshAll()'s Promise.all, every other connector's refresh too).
      // Pattern ported from openrouter/quota.ts.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const res = await net.fetch(url, { headers, signal: controller.signal });
        const txt = await res.text();
        const retryAfterMs =
          res.status === 429 ? parseRetryAfterMs(res.headers.get('retry-after')) : undefined;
        try {
          return { status: res.status, json: txt ? JSON.parse(txt) : {}, retryAfterMs };
        } catch {
          return { status: res.status, json: {}, retryAfterMs };
        }
      } catch (err) {
        // A deliberate timeout-abort means the destination is unreachable or
        // slow either way -- falling through to the Node https fallback below
        // would just pay the SAME 15s timeout again. Fail closed here (408)
        // instead of retrying via a different transport.
        if (controller.signal.aborted) {
          return { status: 408, json: {} };
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
  } catch {
    // fall through
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const https = require('https') as typeof import('https');
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, res => {
      const chunks: Buffer[] = [];
      const status = res.statusCode ?? 0;
      const retryAfterMs =
        status === 429
          ? parseRetryAfterMs(
              Array.isArray(res.headers['retry-after'])
                ? res.headers['retry-after'][0]
                : res.headers['retry-after'],
            )
          : undefined;
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status, json: body ? JSON.parse(body) : {}, retryAfterMs });
        } catch {
          resolve({ status, json: {}, retryAfterMs });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error('Anthropic API timeout')));
  });
}

/**
 * Carries the vendor's requested backoff out of whichever sub-fetch hit the
 * limit. `fetch()` returns immediately on this instead of falling through to
 * the next auth strategy: a 429 means "stop asking", not "try another door".
 */
class RateLimitedError extends Error {
  constructor(readonly retryAfterMs: number, message: string) {
    super(message);
    this.name = 'RateLimitedError';
  }
}

/** No claude.ai session to try: the expected state for an unconfigured
 * connector, as opposed to a session whose usage request failed. */
class NoCookieError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoCookieError';
  }
}

function startOfMonthIso(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

function nextMonthIso(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}

class AnthropicQuotaProvider implements QuotaProvider {
  constructor(private readonly ctx: ConnectorContext) {}

  async fetch(): Promise<QuotaSnapshot> {
    const fetchedAt = Date.now();
    const adminKey = this.ctx.secret('adminApiKey');
    const failures: string[] = [];

    if (adminKey) {
      try {
        return await this.fetchWithAdminKey(adminKey, fetchedAt);
      } catch (err) {
        if (err instanceof RateLimitedError) return rateLimitedSnapshot(fetchedAt, err);
        failures.push(`Admin key: ${String(err)}`);
      }
    }

    let cookieFailure: string | null = null;
    try {
      return await this.fetchWithCookie(fetchedAt);
    } catch (err) {
      if (err instanceof RateLimitedError) return rateLimitedSnapshot(fetchedAt, err);
      if (!(err instanceof NoCookieError)) cookieFailure = String(err);
      failures.push(`claude.ai cookie: ${String(err)}`);
    }

    let error: string;
    if (adminKey) {
      error = `Could not fetch Anthropic usage (${failures.join('; ')}).`;
    } else if (cookieFailure) {
      error = `Could not read claude.ai usage (${cookieFailure}). An organization admin API key (sk-ant-admin01-…) from ${ADMIN_KEYS_URL} works instead.`;
    } else {
      error = `No Anthropic admin API key set. Paste an organization admin key (sk-ant-admin01-…) from ${ADMIN_KEYS_URL} in the Anthropic Quota section, or sign in at claude.ai in the Claude desktop app.`;
    }
    return { ok: false, fetchedAt, error };
  }

  /**
   * Fetches every page of an Admin API report (`has_more` / `next_page`,
   * passed back as `page`) and returns the concatenated time buckets. A 429
   * on any page means "stop asking"; any other error status throws, so a
   * caller never sums a partial period by accident.
   */
  private async fetchAllPages(
    baseUrl: string,
    headers: Record<string, string>,
    label: string,
  ): Promise<Array<Record<string, unknown>>> {
    const buckets: Array<Record<string, unknown>> = [];
    let page: string | null = null;
    for (let i = 0; i < MAX_PAGES; i++) {
      const url: string = page ? `${baseUrl}&page=${encodeURIComponent(page)}` : baseUrl;
      const resp = await httpsGetJson(url, headers);
      if (resp.status === 429) {
        throw new RateLimitedError(
          resp.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS,
          `Anthropic rate-limited the ${label} (HTTP 429)`,
        );
      }
      if (resp.status === 401) {
        throw new Error(
          `HTTP 401 — the admin API key is invalid, expired or revoked. Create a new one at ${ADMIN_KEYS_URL}.`,
        );
      }
      if (resp.status === 403) {
        throw new Error(
          `HTTP 403 — this key cannot read usage. It must be an organization admin key (sk-ant-admin01-…) from ${ADMIN_KEYS_URL}.`,
        );
      }
      if (resp.status >= 400) throw new Error(`HTTP ${resp.status}`);

      const json = (resp.json ?? {}) as Record<string, unknown>;
      if (Array.isArray(json.data)) buckets.push(...(json.data as Array<Record<string, unknown>>));
      if (json.has_more !== true || typeof json.next_page !== 'string' || !json.next_page) {
        return buckets;
      }
      page = json.next_page;
    }
    this.ctx.log('warn', `[anthropic] ${label} still had more pages after ${MAX_PAGES}; totals are partial`);
    return buckets;
  }

  private async fetchWithAdminKey(adminKey: string, fetchedAt: number): Promise<QuotaSnapshot> {
    const start = startOfMonthIso();
    const end = nextMonthIso();
    const range = `starting_at=${encodeURIComponent(start)}&ending_at=${encodeURIComponent(end)}&bucket_width=1d&limit=${PAGE_LIMIT}`;
    const headers = {
      'x-api-key': adminKey,
      'anthropic-version': '2023-06-01',
      Accept: 'application/json',
      'User-Agent': userAgent(),
    };
    const usageData = await this.fetchAllPages(
      `${ADMIN_USAGE_URL}?${range}&group_by[]=model`,
      headers,
      'usage report',
    );
    const buckets = parseAdminUsage(usageData);

    // Cost report — optional; any failure (a 429 included) only drops the
    // spend bucket, so the usage numbers above still reach the user.
    let usdBucket: QuotaBucket | null = null;
    try {
      const costData = await this.fetchAllPages(`${ADMIN_COST_URL}?${range}`, headers, 'cost report');
      const totalCents = parseAdminCosts(costData);
      if (totalCents != null) {
        usdBucket = {
          id: 'spend-this-period',
          label: 'Spend this period',
          used: totalCents,
          limit: null,
          remaining: null,
          unit: 'usd',
          enabled: true,
        };
      }
    } catch (err) {
      this.ctx.log('warn', '[anthropic] cost report unavailable', { err: String(err) });
    }

    const allBuckets = usdBucket ? [usdBucket, ...buckets] : buckets;
    return {
      ok: true,
      fetchedAt,
      buckets: allBuckets,
      membershipType: 'anthropic-admin',
      billingCycleStart: start,
      billingCycleEnd: end,
      displayMessages: [],
      authMethod: 'api-key',
      source: ADMIN_USAGE_URL,
    };
  }

  private async fetchWithCookie(fetchedAt: number): Promise<QuotaSnapshot> {
    const sessionKey = await readChromiumCookie(
      // claude.ai is normally accessed in a regular browser. We probe the most
      // common Electron-based wrappers; for Chrome / Firefox proper, the user
      // can paste an admin key instead.
      { appName: 'Claude' },
      { cookieName: 'sessionKey', hostPatterns: ['%claude.ai%', '%anthropic.com%'] },
    );
    if (!sessionKey) {
      throw new NoCookieError('No claude.ai sessionKey cookie found');
    }

    // Step 1: list organizations to find the one we belong to.
    const baseHeaders = {
      Cookie: `sessionKey=${sessionKey}`,
      Accept: 'application/json',
      'User-Agent': userAgent(),
    };
    const orgsResp = await httpsGetJson(CLAUDE_AI_USAGE_URL, baseHeaders);
    if (orgsResp.status === 429) {
      throw new RateLimitedError(
        orgsResp.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS,
        'claude.ai rate-limited the organizations request (HTTP 429)',
      );
    }
    if (orgsResp.status >= 400) {
      throw new Error(`HTTP ${orgsResp.status}`);
    }
    const orgs = orgsResp.json as Array<{ uuid?: string; name?: string }>;
    if (!Array.isArray(orgs) || orgs.length === 0 || !orgs[0]?.uuid) {
      throw new Error('No organizations returned');
    }
    const org = orgs[0];

    // Step 2: per-org usage.
    const usageResp = await httpsGetJson(
      `${CLAUDE_AI_USAGE_URL}/${org.uuid}/usage`,
      baseHeaders,
    );
    if (usageResp.status === 429) {
      throw new RateLimitedError(
        usageResp.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS,
        'claude.ai rate-limited the usage request (HTTP 429)',
      );
    }
    if (usageResp.status >= 400) {
      throw new Error(`Usage HTTP ${usageResp.status}`);
    }

    // Same undocumented endpoint the Claude Code connector reads, so its
    // parser (`limits[]`, then the `five_hour` / `seven_day` windows) is reused.
    const { buckets, displayMessages } = parseClaudeUsage(usageResp.json, fetchedAt);
    if (buckets.length === 0) {
      throw new Error('claude.ai usage had no recognizable limits');
    }
    return {
      ok: true,
      fetchedAt,
      buckets,
      membershipType: org.name ?? 'claude.ai',
      displayMessages,
      authMethod: 'cookie',
      source: `${CLAUDE_AI_USAGE_URL}/${org.uuid}/usage`,
    };
  }
}

/** `Number('')` is `0` and `Number('x')` is `NaN`, so a value that is present
 * but not a real number must be rejected rather than coerced — an empty
 * cost `amount` would otherwise report an authoritative $0.00 for a period
 * whose spend is simply unknown. */
function finiteNumber(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Cache writes are split by TTL under `cache_creation`; the flat
 * `cache_creation_input_tokens` is the older shape, kept as a fallback. */
function cacheWriteTokens(r: Record<string, unknown>): number {
  const nested = r.cache_creation;
  if (nested != null && typeof nested === 'object') {
    const c = nested as Record<string, unknown>;
    return (
      (finiteNumber(c.ephemeral_5m_input_tokens) ?? 0) + (finiteNumber(c.ephemeral_1h_input_tokens) ?? 0)
    );
  }
  return finiteNumber(r.cache_creation_input_tokens) ?? 0;
}

function parseAdminUsage(data: Array<Record<string, unknown>>): QuotaBucket[] {
  // Sum input + output tokens across the period.
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const day of data) {
    const results = (day.results ?? []) as Array<Record<string, unknown>>;
    for (const r of results) {
      inputTokens += finiteNumber(r.uncached_input_tokens ?? r.input_tokens) ?? 0;
      outputTokens += finiteNumber(r.output_tokens) ?? 0;
      cacheRead += finiteNumber(r.cache_read_input_tokens) ?? 0;
      cacheWrite += cacheWriteTokens(r);
    }
  }
  const buckets: QuotaBucket[] = [];
  if (inputTokens) buckets.push(bucket('input-tokens', 'Input tokens', inputTokens));
  if (outputTokens) buckets.push(bucket('output-tokens', 'Output tokens', outputTokens));
  if (cacheRead) buckets.push(bucket('cache-read-tokens', 'Cache-read tokens', cacheRead));
  if (cacheWrite) buckets.push(bucket('cache-write-tokens', 'Cache-write tokens', cacheWrite));
  return buckets;
}

/**
 * `amount` is a decimal string already in cents ("123.45" USD is $1.23), so
 * it is summed as-is and rounded once at the end to keep sub-cent precision.
 * The docs say `currency` is currently always USD; anything else is skipped
 * because the 'usd' unit would mislabel it.
 */
function parseAdminCosts(data: Array<Record<string, unknown>>): number | null {
  let totalCents = 0;
  let any = false;
  for (const day of data) {
    const results = (day.results ?? []) as Array<Record<string, unknown>>;
    for (const r of results) {
      const currency = r.currency;
      if (currency != null && String(currency).toUpperCase() !== 'USD') continue;
      const cents = finiteNumber(r.amount);
      if (cents != null) {
        totalCents += cents;
        any = true;
      }
    }
  }
  return any ? Math.round(totalCents) : null;
}

function bucket(id: string, label: string, used: number): QuotaBucket {
  return { id, label, used, limit: null, remaining: null, unit: 'tokens', enabled: true };
}

function rateLimitedSnapshot(fetchedAt: number, err: RateLimitedError): QuotaSnapshot {
  return {
    ok: false,
    fetchedAt,
    error: `${err.message}. Backing off for ${Math.round(err.retryAfterMs / 1000)}s.`,
    retryAfterMs: err.retryAfterMs,
  };
}

export function createAnthropicQuotaProvider(
  _config: Record<string, unknown>,
  ctx: ConnectorContext,
): QuotaProvider {
  return new AnthropicQuotaProvider(ctx);
}
