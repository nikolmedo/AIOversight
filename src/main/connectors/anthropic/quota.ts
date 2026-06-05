import { ConnectorContext, QuotaBucket, QuotaProvider, QuotaSnapshot } from '../types';
import { readChromiumCookie } from '../shared/chromium-cookies';

const ADMIN_USAGE_URL = 'https://api.anthropic.com/v1/organizations/usage_report/messages';
const ADMIN_COST_URL = 'https://api.anthropic.com/v1/organizations/cost_report';
const CLAUDE_AI_USAGE_URL = 'https://claude.ai/api/organizations';

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
    req.setTimeout(15_000, () => req.destroy(new Error('Anthropic API timeout')));
  });
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
        failures.push(`Admin key: ${String(err)}`);
      }
    }

    try {
      return await this.fetchWithCookie(fetchedAt);
    } catch (err) {
      failures.push(`claude.ai cookie: ${String(err)}`);
    }

    return {
      ok: false,
      fetchedAt,
      error: adminKey
        ? `Could not fetch Anthropic usage (${failures.join('; ')}).`
        : 'No Anthropic admin API key set. Paste an `sk-ant-admin01-…` key in the Anthropic Quota section, or sign in at claude.ai in a browser.',
    };
  }

  private async fetchWithAdminKey(adminKey: string, fetchedAt: number): Promise<QuotaSnapshot> {
    const start = startOfMonthIso();
    const end = nextMonthIso();
    const usageUrl = `${ADMIN_USAGE_URL}?starting_at=${encodeURIComponent(start)}&ending_at=${encodeURIComponent(end)}&bucket_width=1d&group_by[]=model`;
    const headers = {
      'x-api-key': adminKey,
      'anthropic-version': '2023-06-01',
      Accept: 'application/json',
    };
    const usageResp = await httpsGetJson(usageUrl, headers);
    if (usageResp.status >= 400) {
      throw new Error(`HTTP ${usageResp.status}`);
    }
    const buckets = parseAdminUsage(usageResp.json as Record<string, unknown>);

    // Cost report — optional; failure here is not fatal.
    let usdBucket: QuotaBucket | null = null;
    try {
      const costUrl = `${ADMIN_COST_URL}?starting_at=${encodeURIComponent(start)}&ending_at=${encodeURIComponent(end)}&bucket_width=1d`;
      const costResp = await httpsGetJson(costUrl, headers);
      if (costResp.status < 400) {
        const totalCents = parseAdminCosts(costResp.json as Record<string, unknown>);
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
      }
    } catch {
      // optional
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
      throw new Error('No claude.ai sessionKey cookie found');
    }

    // Step 1: list organizations to find the one we belong to.
    const baseHeaders = {
      Cookie: `sessionKey=${sessionKey}`,
      Accept: 'application/json',
    };
    const orgsResp = await httpsGetJson(CLAUDE_AI_USAGE_URL, baseHeaders);
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
    if (usageResp.status >= 400) {
      throw new Error(`Usage HTTP ${usageResp.status}`);
    }

    const buckets = parseClaudeAiUsage(usageResp.json as Record<string, unknown>);
    return {
      ok: true,
      fetchedAt,
      buckets,
      membershipType: org.name ?? 'claude.ai',
      displayMessages: [],
      authMethod: 'cookie',
      source: `${CLAUDE_AI_USAGE_URL}/${org.uuid}/usage`,
    };
  }
}

function parseAdminUsage(json: Record<string, unknown>): QuotaBucket[] {
  // Sum input + output tokens across the period.
  const data = (json.data ?? []) as Array<Record<string, unknown>>;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const day of data) {
    const results = (day.results ?? []) as Array<Record<string, unknown>>;
    for (const r of results) {
      inputTokens += Number(r.uncached_input_tokens ?? r.input_tokens ?? 0);
      outputTokens += Number(r.output_tokens ?? 0);
      cacheRead += Number(r.cache_read_input_tokens ?? 0);
      cacheWrite += Number(r.cache_creation_input_tokens ?? 0);
    }
  }
  const buckets: QuotaBucket[] = [];
  if (inputTokens) buckets.push(bucket('input-tokens', 'Input tokens', inputTokens));
  if (outputTokens) buckets.push(bucket('output-tokens', 'Output tokens', outputTokens));
  if (cacheRead) buckets.push(bucket('cache-read-tokens', 'Cache-read tokens', cacheRead));
  if (cacheWrite) buckets.push(bucket('cache-write-tokens', 'Cache-write tokens', cacheWrite));
  return buckets;
}

function parseAdminCosts(json: Record<string, unknown>): number | null {
  const data = (json.data ?? []) as Array<Record<string, unknown>>;
  let totalCents = 0;
  let any = false;
  for (const day of data) {
    const results = (day.results ?? []) as Array<Record<string, unknown>>;
    for (const r of results) {
      const cost = r.amount as { value?: number; currency?: string } | undefined;
      if (cost?.value != null) {
        totalCents += Math.round(Number(cost.value) * 100);
        any = true;
      }
    }
  }
  return any ? totalCents : null;
}

function parseClaudeAiUsage(json: Record<string, unknown>): QuotaBucket[] {
  // claude.ai's web usage endpoint isn't documented; we surface whatever
  // numeric counters we can recognise and skip the rest.
  const buckets: QuotaBucket[] = [];
  for (const [key, raw] of Object.entries(json)) {
    if (raw == null || typeof raw !== 'object') continue;
    const m = raw as Record<string, unknown>;
    const used = Number(m.used ?? m.count ?? m.requests ?? NaN);
    const limit = m.limit != null ? Number(m.limit) : m.max != null ? Number(m.max) : null;
    if (Number.isFinite(used)) {
      buckets.push({
        id: key,
        label: humanise(key),
        used,
        limit: limit != null && Number.isFinite(limit) ? limit : null,
        remaining: limit != null && Number.isFinite(limit) ? Math.max(0, limit - used) : null,
        unit: 'requests',
        enabled: true,
      });
    }
  }
  return buckets;
}

function humanise(key: string): string {
  return key.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function bucket(id: string, label: string, used: number): QuotaBucket {
  return { id, label, used, limit: null, remaining: null, unit: 'requests', enabled: true };
}

export function createAnthropicQuotaProvider(
  _config: Record<string, unknown>,
  ctx: ConnectorContext,
): QuotaProvider {
  return new AnthropicQuotaProvider(ctx);
}
