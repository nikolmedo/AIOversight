import { ConnectorContext, QuotaBucket, QuotaProvider, QuotaSnapshot, QuotaUnit } from '../types';

const USAGE_COMPLETIONS_URL = 'https://api.openai.com/v1/organization/usage/completions';
const COSTS_URL = 'https://api.openai.com/v1/organization/costs';

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
 * OpenAI sends seconds, but a proxy in front of it may not, so both are
 * accepted and anything unparseable falls back to a minute.
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

async function httpsGetJson(
  url: string,
  headers: Record<string, string>,
): Promise<HttpJsonResult> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { net } = require('electron') as typeof import('electron');
    if (net?.fetch) {
      // net.fetch has no built-in timeout -- without this, a single hung
      // OpenAI call wedges every future poll and the Refresh button (and,
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
    req.setTimeout(15_000, () => req.destroy(new Error('OpenAI API timeout')));
  });
}

function startOfMonthSeconds(): number {
  const d = new Date();
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
}

function nextMonthSeconds(): number {
  const d = new Date();
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000);
}

class OpenAIQuotaProvider implements QuotaProvider {
  constructor(private readonly ctx: ConnectorContext) {}

  async fetch(): Promise<QuotaSnapshot> {
    const fetchedAt = Date.now();
    const adminKey = this.ctx.secret('adminApiKey');
    if (!adminKey) {
      return {
        ok: false,
        fetchedAt,
        error:
          'No OpenAI admin API key set. Create one at platform.openai.com/settings/organization/admin-keys (or use any sk-… key with `api.usage.read` scope) and paste it in the OpenAI Quota section.',
      };
    }

    const start = startOfMonthSeconds();
    const end = nextMonthSeconds();
    const headers = {
      Authorization: `Bearer ${adminKey}`,
      Accept: 'application/json',
    };

    try {
      const usageUrl = `${USAGE_COMPLETIONS_URL}?start_time=${start}&end_time=${end}&bucket_width=1d&group_by=model`;
      const usageResp = await httpsGetJson(usageUrl, headers);
      // Returned, not thrown: the generic catch below would flatten this into
      // an error string and drop the vendor's requested backoff.
      if (usageResp.status === 429) {
        const retryAfterMs = usageResp.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
        return {
          ok: false,
          fetchedAt,
          error: `OpenAI rate-limited the usage report (HTTP 429). Backing off for ${Math.round(retryAfterMs / 1000)}s.`,
          retryAfterMs,
          source: USAGE_COMPLETIONS_URL,
        };
      }
      if (usageResp.status >= 400) {
        throw new Error(formatOpenAIError(usageResp.status, usageResp.json));
      }
      const buckets = parseUsage(usageResp.json as Record<string, unknown>);

      // Costs are optional — failure here doesn't fail the whole fetch.
      try {
        const costResp = await httpsGetJson(
          `${COSTS_URL}?start_time=${start}&end_time=${end}&bucket_width=1d`,
          headers,
        );
        if (costResp.status < 400) {
          const totalCents = parseCost(costResp.json as Record<string, unknown>);
          if (totalCents != null) {
            buckets.unshift({
              id: 'spend-this-period',
              label: 'Spend this period',
              used: totalCents,
              limit: null,
              remaining: null,
              unit: 'usd',
              enabled: true,
            });
          }
        }
      } catch {
        // skip
      }

      const startIso = new Date(start * 1000).toISOString();
      const endIso = new Date(end * 1000).toISOString();
      return {
        ok: true,
        fetchedAt,
        buckets,
        membershipType: 'openai-org',
        billingCycleStart: startIso,
        billingCycleEnd: endIso,
        displayMessages: [],
        authMethod: 'api-key',
        source: USAGE_COMPLETIONS_URL,
      };
    } catch (err) {
      return {
        ok: false,
        fetchedAt,
        error: `Could not fetch OpenAI usage: ${String(err)}`,
      };
    }
  }
}

/** `Number('')` is `0` and `Number('x')` is `NaN`, so a value that is present
 * but not a real number must be rejected rather than coerced — an empty
 * `amount.value` would otherwise report an authoritative $0.00 for a period
 * whose spend is simply unknown. */
function finiteNumber(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function parseUsage(json: Record<string, unknown>): QuotaBucket[] {
  const data = (json.data ?? []) as Array<Record<string, unknown>>;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let requests = 0;
  for (const bucketDay of data) {
    const results = (bucketDay.results ?? []) as Array<Record<string, unknown>>;
    for (const r of results) {
      inputTokens += finiteNumber(r.input_tokens) ?? 0;
      outputTokens += finiteNumber(r.output_tokens) ?? 0;
      cachedTokens += finiteNumber(r.input_cached_tokens) ?? 0;
      requests += finiteNumber(r.num_model_requests) ?? 0;
    }
  }
  const buckets: QuotaBucket[] = [];
  if (requests) buckets.push(counter('requests', 'Model requests', requests, 'requests'));
  if (inputTokens) buckets.push(counter('input-tokens', 'Input tokens', inputTokens, 'tokens'));
  if (outputTokens) buckets.push(counter('output-tokens', 'Output tokens', outputTokens, 'tokens'));
  if (cachedTokens) buckets.push(counter('cached-tokens', 'Cached input tokens', cachedTokens, 'tokens'));
  return buckets;
}

function parseCost(json: Record<string, unknown>): number | null {
  const data = (json.data ?? []) as Array<Record<string, unknown>>;
  let totalCents = 0;
  let any = false;
  for (const bucketDay of data) {
    const results = (bucketDay.results ?? []) as Array<Record<string, unknown>>;
    for (const r of results) {
      const amount = finiteNumber((r.amount as { value?: unknown } | undefined)?.value);
      if (amount != null) {
        totalCents += Math.round(amount * 100);
        any = true;
      }
    }
  }
  return any ? totalCents : null;
}

function counter(id: string, label: string, used: number, unit: QuotaUnit): QuotaBucket {
  return { id, label, used, limit: null, remaining: null, unit, enabled: true };
}

function formatOpenAIError(status: number, json: unknown): string {
  const msg =
    (json as { error?: { message?: string } } | undefined)?.error?.message ?? `HTTP ${status}`;
  return msg;
}

export function createOpenAIQuotaProvider(
  _config: Record<string, unknown>,
  ctx: ConnectorContext,
): QuotaProvider {
  return new OpenAIQuotaProvider(ctx);
}
