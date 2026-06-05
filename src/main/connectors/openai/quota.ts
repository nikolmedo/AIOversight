import { ConnectorContext, QuotaBucket, QuotaProvider, QuotaSnapshot } from '../types';

const USAGE_COMPLETIONS_URL = 'https://api.openai.com/v1/organization/usage/completions';
const COSTS_URL = 'https://api.openai.com/v1/organization/costs';

async function httpsGetJson(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; json: unknown }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { net } = require('electron') as typeof import('electron');
    if (net?.fetch) {
      const res = await net.fetch(url, { headers });
      const txt = await res.text();
      try {
        return { status: res.status, json: txt ? JSON.parse(txt) : {} };
      } catch {
        return { status: res.status, json: {} };
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

function parseUsage(json: Record<string, unknown>): QuotaBucket[] {
  const data = (json.data ?? []) as Array<Record<string, unknown>>;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let requests = 0;
  for (const bucketDay of data) {
    const results = (bucketDay.results ?? []) as Array<Record<string, unknown>>;
    for (const r of results) {
      inputTokens += Number(r.input_tokens ?? 0);
      outputTokens += Number(r.output_tokens ?? 0);
      cachedTokens += Number(r.input_cached_tokens ?? 0);
      requests += Number(r.num_model_requests ?? 0);
    }
  }
  const buckets: QuotaBucket[] = [];
  if (requests) buckets.push(req('requests', 'Model requests', requests));
  if (inputTokens) buckets.push(req('input-tokens', 'Input tokens', inputTokens));
  if (outputTokens) buckets.push(req('output-tokens', 'Output tokens', outputTokens));
  if (cachedTokens) buckets.push(req('cached-tokens', 'Cached input tokens', cachedTokens));
  return buckets;
}

function parseCost(json: Record<string, unknown>): number | null {
  const data = (json.data ?? []) as Array<Record<string, unknown>>;
  let totalCents = 0;
  let any = false;
  for (const bucketDay of data) {
    const results = (bucketDay.results ?? []) as Array<Record<string, unknown>>;
    for (const r of results) {
      const amount = (r.amount as { value?: number } | undefined)?.value;
      if (amount != null) {
        totalCents += Math.round(Number(amount) * 100);
        any = true;
      }
    }
  }
  return any ? totalCents : null;
}

function req(id: string, label: string, used: number): QuotaBucket {
  return { id, label, used, limit: null, remaining: null, unit: 'requests', enabled: true };
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
