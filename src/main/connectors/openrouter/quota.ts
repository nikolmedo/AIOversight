import { ConnectorContext, QuotaBucket, QuotaProvider, QuotaSnapshot } from '../types';

const CREDITS_URL = 'https://openrouter.ai/api/v1/credits';
const KEY_URL = 'https://openrouter.ai/api/v1/key';

async function httpsGetJson(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; json: unknown }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { net } = require('electron') as typeof import('electron');
    if (net?.fetch) {
      // net.fetch has no built-in timeout -- without this, a single hung
      // OpenRouter call wedges every future poll and the Refresh button (and,
      // via refreshAll()'s Promise.all, every other connector's refresh too).
      // Pattern ported from github-copilot/quota.ts's fixed httpsGetJson.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const res = await net.fetch(url, { headers, signal: controller.signal });
        const txt = await res.text();
        try {
          return { status: res.status, json: txt ? JSON.parse(txt) : {} };
        } catch {
          return { status: res.status, json: {} };
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
    // fall through to Node's https module (e.g. headless smoke tests)
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const https = require('https') as typeof import('https');
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, res => {
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
    req.setTimeout(15_000, () => req.destroy(new Error('OpenRouter API timeout')));
  });
}

/** Exported for smoke coverage. */
export function firstFiniteNumber(...vals: unknown[]): number | null {
  for (const v of vals) {
    // Number('') === 0 -- an empty/whitespace string must NOT parse as a
    // measured zero, or a genuinely absent API field silently becomes "$0.00"
    // and bypasses the total-parse-failure guard below.
    if (typeof v === 'string' && v.trim() === '') continue;
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * OpenRouter reports dollar amounts as plain (non-cents) floating point
 * numbers on both `/credits` and `/key` (e.g. `{ "total_usage": 3.5 }` means
 * $3.50) per the publicly documented response shape — this is NOT verified
 * against a live key in this environment, so treat the ×100 conversion below
 * as a documented-but-untested assumption, not a confirmed fact.
 */
export function dollarsToCents(n: number): number {
  return Math.round(n * 100);
}

interface CreditsData {
  total_credits?: unknown;
  total_usage?: unknown;
}

interface KeyData {
  usage?: unknown;
  limit?: unknown;
  limit_remaining?: unknown;
  is_free_tier?: unknown;
  label?: unknown;
  // The following period-breakdown field names are speculative — OpenRouter's
  // documented `/key` response does not include a today/week/month spend
  // breakdown as of this writing. They're probed defensively (several
  // plausible naming conventions) so that if the API ever adds this data the
  // buckets light up automatically; if none of these fields exist (the
  // expected case today), the corresponding buckets are simply omitted, never
  // defaulted to zero.
  usage_daily?: unknown;
  usage_today?: unknown;
  daily_usage?: unknown;
  usage_weekly?: unknown;
  usage_week?: unknown;
  weekly_usage?: unknown;
  usage_monthly?: unknown;
  usage_month?: unknown;
  monthly_usage?: unknown;
}

function formatOpenRouterError(status: number, json: unknown): string {
  const msg =
    (json as { error?: { message?: string } } | undefined)?.error?.message ?? `HTTP ${status}`;
  return msg;
}

class OpenRouterQuotaProvider implements QuotaProvider {
  constructor(private readonly ctx: ConnectorContext) {}

  private resolveApiKey(): string | null {
    return this.ctx.secret('apiKey') || process.env.OPENROUTER_API_KEY || null;
  }

  async fetch(): Promise<QuotaSnapshot> {
    const fetchedAt = Date.now();
    const apiKey = this.resolveApiKey();
    if (!apiKey) {
      return {
        ok: false,
        fetchedAt,
        error:
          'No OpenRouter API key set. Create one at openrouter.ai/settings/keys and paste it in the OpenRouter Quota section (or set OPENROUTER_API_KEY).',
      };
    }

    const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };

    const creditsResp = await httpsGetJson(CREDITS_URL, headers);
    if (creditsResp.status === 401 || creditsResp.status === 403) {
      return { ok: false, fetchedAt, error: 'OpenRouter API key invalid.', needsLogin: false };
    }
    if (creditsResp.status >= 400) {
      return {
        ok: false,
        fetchedAt,
        error: `Could not fetch OpenRouter credits: ${formatOpenRouterError(creditsResp.status, creditsResp.json)}`,
      };
    }

    const buckets: QuotaBucket[] = [];
    const creditsData = ((creditsResp.json as { data?: CreditsData } | undefined)?.data ?? {}) as
      CreditsData;
    const totalCredits = firstFiniteNumber(creditsData.total_credits);
    const totalUsage = firstFiniteNumber(creditsData.total_usage);

    // A 200 response that doesn't contain either expected field means the
    // API's shape has diverged from what this connector was written
    // against -- fail explicitly instead of returning `ok:true` with an
    // empty bucket list, which would render as a silently-connected but
    // blank panel. This is a total-parse-failure guard, distinct from (and
    // not in tension with) the "zero spend is real" convention below: a
    // genuinely absent field stays absent, a genuinely zero field still
    // renders as `$0.00`.
    if (totalCredits == null && totalUsage == null) {
      return {
        ok: false,
        fetchedAt,
        error: 'OpenRouter returned an unexpected /credits response (no recognizable balance fields).',
      };
    }

    // Zero spend is a real, common, correctly-measured state for this
    // connector — render it as a measured `$0.00` (`used: 0`), never
    // "No data". Only a genuinely absent/unparseable field stays `null`.
    if (totalUsage != null) {
      buckets.push({
        id: 'lifetime-spend',
        label: 'Lifetime spend',
        used: dollarsToCents(totalUsage),
        limit: null,
        remaining: null,
        unit: 'usd',
        enabled: true,
      });
    }
    if (totalCredits != null && totalUsage != null) {
      const remainingDollars = totalCredits - totalUsage;
      buckets.push({
        id: 'prepaid-balance',
        label: 'Prepaid balance',
        used: dollarsToCents(totalUsage),
        limit: dollarsToCents(totalCredits),
        remaining: dollarsToCents(Math.max(0, remainingDollars)),
        unit: 'usd',
        enabled: true,
      });
    }

    // `/key` is optional metadata (tier, spending periods, per-key limit) —
    // a failure here must not fail the whole snapshot, just omit those
    // buckets.
    try {
      const keyResp = await httpsGetJson(KEY_URL, headers);
      if (keyResp.status < 400) {
        const keyData = ((keyResp.json as { data?: KeyData } | undefined)?.data ?? {}) as KeyData;

        const keyUsage = firstFiniteNumber(keyData.usage);
        const keyLimit = firstFiniteNumber(keyData.limit);
        const keyLimitRemaining = firstFiniteNumber(keyData.limit_remaining);
        // A `null` `limit` on OpenRouter means "no per-key cap configured" —
        // in that case there's nothing meaningful to show as a meter, so the
        // bucket is only added when a real limit is configured.
        if (keyUsage != null && keyLimit != null) {
          buckets.push({
            id: 'key-limit',
            label: 'Key spend limit',
            used: dollarsToCents(keyUsage),
            limit: dollarsToCents(keyLimit),
            remaining:
              keyLimitRemaining != null
                ? dollarsToCents(Math.max(0, keyLimitRemaining))
                : dollarsToCents(Math.max(0, keyLimit - keyUsage)),
            unit: 'usd',
            enabled: true,
            defaultVisibility: 'onDemand',
          });
        }

        const daily = firstFiniteNumber(keyData.usage_daily, keyData.usage_today, keyData.daily_usage);
        if (daily != null) {
          buckets.push({
            id: 'spend-today',
            label: 'Spend today',
            used: dollarsToCents(daily),
            limit: null,
            remaining: null,
            unit: 'usd',
            enabled: true,
            defaultVisibility: 'onDemand',
          });
        }
        const weekly = firstFiniteNumber(keyData.usage_weekly, keyData.usage_week, keyData.weekly_usage);
        if (weekly != null) {
          buckets.push({
            id: 'spend-week',
            label: 'Spend this week',
            used: dollarsToCents(weekly),
            limit: null,
            remaining: null,
            unit: 'usd',
            enabled: true,
            defaultVisibility: 'onDemand',
          });
        }
        const monthly = firstFiniteNumber(
          keyData.usage_monthly,
          keyData.usage_month,
          keyData.monthly_usage,
        );
        if (monthly != null) {
          buckets.push({
            id: 'spend-month',
            label: 'Spend this month',
            used: dollarsToCents(monthly),
            limit: null,
            remaining: null,
            unit: 'usd',
            enabled: true,
            defaultVisibility: 'onDemand',
          });
        }
      }
    } catch {
      // /key is best-effort — ignore and keep whatever /credits produced.
    }

    return {
      ok: true,
      fetchedAt,
      buckets,
      displayMessages: [],
      authMethod: 'bearer',
      source: CREDITS_URL,
    };
  }
}

export function createOpenRouterQuotaProvider(
  _config: Record<string, unknown>,
  ctx: ConnectorContext,
): QuotaProvider {
  return new OpenRouterQuotaProvider(ctx);
}
