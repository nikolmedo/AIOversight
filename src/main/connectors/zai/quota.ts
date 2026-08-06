import { ConnectorContext, QuotaBucket, QuotaProvider, QuotaSnapshot } from '../types';

const SUBSCRIPTION_URL = 'https://api.z.ai/api/biz/subscription/list';
const QUOTA_LIMIT_URL = 'https://api.z.ai/api/monitor/usage/quota/limit';

const SESSION_WINDOW_MS = 18_000_000; // 5h rolling window
const WEEKLY_WINDOW_MS = 604_800_000; // 7d rolling window
const ONE_DAY_MS = 86_400_000;

async function httpsGetJson(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; json: unknown }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { net } = require('electron') as typeof import('electron');
    if (net?.fetch) {
      // net.fetch has no built-in timeout -- without this, a single hung
      // Z.ai call (including the "non-fatal" subscription lookup, whose
      // try/catch only catches thrown errors, not an unresolved promise)
      // wedges every future poll and the Refresh button (and, via
      // refreshAll()'s Promise.all, every other connector's refresh too).
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
    req.setTimeout(15_000, () => req.destroy(new Error('Z.ai API timeout')));
  });
}

/** Exported for smoke coverage. */
export function firstFiniteNumber(...vals: unknown[]): number | null {
  for (const v of vals) {
    // Number('') === 0 -- an empty/whitespace string must NOT parse as a
    // measured zero, or a genuinely absent API field silently becomes a
    // fabricated bucket value instead of staying omitted.
    if (typeof v === 'string' && v.trim() === '') continue;
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

/**
 * Reset times arrive as epoch milliseconds per the plan's note — unlike
 * claude-code's cli-quota.ts, which has to guess seconds-vs-ms, this treats
 * the raw value as already-ms. This is an explicit, stated assumption from
 * the implementation brief, not independently verified against a live
 * Z.ai account in this environment.
 */
function resetsAtMsFromEpochMs(raw: unknown): number | null {
  const n = firstFiniteNumber(raw);
  return n != null && n > 0 ? n : null;
}

type RawItem = Record<string, unknown>;

/**
 * Z.ai's `/api/monitor/usage/quota/limit` response shape is NOT publicly
 * documented and could not be verified against a live key in this
 * environment. Everything below is a best-effort, defensive parse: it probes
 * several plausible container paths and field-name conventions and simply
 * omits a bucket when it can't find a confident match, rather than guessing
 * a value. Confidence: LOW on exact field names, MEDIUM on the general shape
 * (a list of quota-window objects with used/limit/window-length/reset
 * fields), based on the plan's description of session/weekly/%-based buckets
 * plus a web-search request count.
 */
function isRawItem(v: unknown): v is RawItem {
  return typeof v === 'object' && v !== null;
}

/** Exported for smoke coverage. */
export function extractItems(json: unknown): RawItem[] {
  const root = (json as { data?: unknown } | undefined)?.data ?? json;
  if (Array.isArray(root)) return root.filter(isRawItem);
  const obj = (root ?? {}) as Record<string, unknown>;
  for (const key of ['items', 'list', 'quotas', 'quota_list', 'records']) {
    const v = obj[key];
    if (Array.isArray(v)) return v.filter(isRawItem);
  }
  return [];
}

function itemWindowMs(item: RawItem): number | null {
  const seconds = firstFiniteNumber(
    item.window_seconds,
    item.period_seconds,
    item.cycle_seconds,
    item.duration_seconds,
  );
  if (seconds != null) return seconds * 1000;
  const ms = firstFiniteNumber(item.window_ms, item.period_ms, item.duration_ms);
  if (ms != null) return ms;
  return null;
}

function itemKind(item: RawItem): string {
  return (
    firstString(item.type, item.name, item.code, item.category, item.key) ?? ''
  ).toLowerCase();
}

function isWebSearchItem(kind: string): boolean {
  return kind.includes('search') || kind.includes('web_search') || kind.includes('websearch');
}

interface ParsedQuota {
  session?: { used: number; limit: number; resetsAt: number | null; windowMs: number | null };
  weekly?: { used: number; limit: number; resetsAt: number | null; windowMs: number | null };
  webSearches?: { used: number; limit: number | null };
}

export function parseQuotaItems(items: RawItem[]): ParsedQuota {
  const result: ParsedQuota = {};
  for (const item of items) {
    const used = firstFiniteNumber(item.used, item.current, item.count, item.quota_used, item.usage);
    const limit = firstFiniteNumber(item.limit, item.quota_limit, item.max, item.total);
    const kind = itemKind(item);

    if (isWebSearchItem(kind)) {
      if (used != null && !result.webSearches) {
        result.webSearches = { used, limit };
      }
      continue;
    }

    if (used == null || limit == null || limit <= 0) continue;

    const windowMs = itemWindowMs(item);
    const resetsAt = resetsAtMsFromEpochMs(item.reset_at ?? item.resets_at ?? item.reset_time ?? item.next_reset_at);

    // Classify by the window's actual duration rather than by field name
    // alone, per the plan: sub-daily windows feed Session, multi-day windows
    // feed Weekly. When the API doesn't report a window length at all, fall
    // back to a name-based heuristic as a best-effort guess.
    let bucket: 'session' | 'weekly' | null = null;
    if (windowMs != null) {
      // Exactly-24h windows fall to 'weekly' (strict <, not <=) -- a 24h
      // window reads much closer to a daily/weekly cadence than to the 5h
      // session window this connector otherwise expects, so grouping it with
      // the longer bucket is the more conservative choice.
      bucket = windowMs < ONE_DAY_MS ? 'session' : 'weekly';
    } else if (kind.includes('week') || kind.includes('7d')) {
      bucket = 'weekly';
    } else if (kind.includes('session') || kind.includes('5h') || kind.includes('hour')) {
      bucket = 'session';
    }

    if (bucket === 'session' && !result.session) {
      result.session = { used, limit, resetsAt, windowMs };
    } else if (bucket === 'weekly' && !result.weekly) {
      result.weekly = { used, limit, resetsAt, windowMs };
    }
  }
  return result;
}

/**
 * Decides the final windowMs/resetsAt pair for a bucket. The classifier's
 * kind-based fallback branches (see parseQuotaItems above) can legitimately
 * reach "resetsAt observed, windowMs not observed" -- e.g. the API reports a
 * reset timestamp but no window-length field, and the item was classified by
 * name instead. Pairing a REAL resetsAt with a SYNTHESIZED windowMs would
 * corrupt pace-coloring's elapsed-fraction math (see claude-code/quota.ts's
 * equivalent warning), so `resetsAt` is only ever surfaced when a genuinely
 * observed `windowMs` backs it. Exported for smoke coverage.
 */
export function resolveWindowPairing(
  observedWindowMs: number | null,
  observedResetsAt: number | null,
  fallbackWindowMs: number,
): { windowMs: number; resetsAt?: number } {
  // A real observed windowMs is safe to keep even without a resetsAt --
  // paceStateFor only switches into the projected-exhaustion branch when
  // BOTH fields are present, so windowMs alone never drives the risky math.
  // Only resetsAt is gated on windowMs also being genuinely observed.
  const windowMs = observedWindowMs ?? fallbackWindowMs;
  if (observedWindowMs != null && observedResetsAt != null) {
    return { windowMs, resetsAt: observedResetsAt };
  }
  return { windowMs };
}

function extractPlanName(json: unknown): string | null {
  const root = (json as { data?: unknown } | undefined)?.data ?? json;
  if (Array.isArray(root) && root.length) {
    const first = root[0] as Record<string, unknown>;
    return firstString(first.plan_name, first.name, first.plan);
  }
  const obj = (root ?? {}) as Record<string, unknown>;
  return firstString(obj.plan_name, obj.name, obj.plan);
}

class ZaiQuotaProvider implements QuotaProvider {
  constructor(private readonly ctx: ConnectorContext) {}

  private resolveApiKey(): string | null {
    return (
      this.ctx.secret('apiKey') ||
      process.env.ZAI_API_KEY ||
      process.env.GLM_API_KEY ||
      null
    );
  }

  async fetch(): Promise<QuotaSnapshot> {
    const fetchedAt = Date.now();
    const apiKey = this.resolveApiKey();
    if (!apiKey) {
      return {
        ok: false,
        fetchedAt,
        error:
          'No Z.ai API key set. Paste it in the Z.ai Quota section (or set ZAI_API_KEY / GLM_API_KEY).',
      };
    }

    const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };

    const quotaResp = await httpsGetJson(QUOTA_LIMIT_URL, headers);
    if (quotaResp.status === 401 || quotaResp.status === 403) {
      return { ok: false, fetchedAt, error: 'Z.ai API key invalid.', needsLogin: false };
    }
    if (quotaResp.status >= 400) {
      return {
        ok: false,
        fetchedAt,
        error: `Could not fetch Z.ai quota: HTTP ${quotaResp.status}`,
      };
    }

    const items = extractItems(quotaResp.json);
    const parsed = parseQuotaItems(items);

    // Primary data endpoint: missing/malformed quota data is an explicit
    // failure, never a defaulted zero. If we couldn't confidently classify
    // any of the three target buckets, treat the whole snapshot as failed
    // rather than showing partial/guessed numbers.
    if (!parsed.session && !parsed.weekly && !parsed.webSearches) {
      return {
        ok: false,
        fetchedAt,
        error: 'Z.ai returned an unexpected quota response (no recognizable quota windows).',
      };
    }

    const buckets: QuotaBucket[] = [];

    if (parsed.session) {
      const { used, limit, resetsAt, windowMs } = parsed.session;
      const pct = Math.min(100, Math.max(0, (used / limit) * 100));
      const pairing = resolveWindowPairing(windowMs, resetsAt, SESSION_WINDOW_MS);
      buckets.push({
        id: 'session',
        label: 'Session (5h)',
        used: pct,
        limit: 100,
        remaining: Math.max(0, 100 - pct),
        unit: 'percent',
        enabled: true,
        ...pairing,
      });
    }

    if (parsed.weekly) {
      const { used, limit, resetsAt, windowMs } = parsed.weekly;
      const pct = Math.min(100, Math.max(0, (used / limit) * 100));
      const pairing = resolveWindowPairing(windowMs, resetsAt, WEEKLY_WINDOW_MS);
      buckets.push({
        id: 'weekly',
        label: 'Weekly',
        used: pct,
        limit: 100,
        remaining: Math.max(0, 100 - pct),
        unit: 'percent',
        enabled: true,
        ...pairing,
      });
    }

    if (parsed.webSearches) {
      const { used, limit } = parsed.webSearches;
      buckets.push({
        id: 'web-searches',
        label: 'Web searches',
        used,
        limit: limit ?? null,
        remaining: limit != null ? Math.max(0, limit - used) : null,
        unit: 'requests',
        enabled: true,
        defaultVisibility: 'onDemand',
      });
    }

    const displayMessages: string[] = [];

    // Plan name is non-critical metadata — a failure here must not fail the
    // whole snapshot, just omit it from displayMessages.
    try {
      const subResp = await httpsGetJson(SUBSCRIPTION_URL, headers);
      if (subResp.status < 400) {
        const planName = extractPlanName(subResp.json);
        if (planName) displayMessages.push(`Plan: ${planName}`);
      }
    } catch {
      // subscription lookup is best-effort — ignore
    }

    return {
      ok: true,
      fetchedAt,
      buckets,
      displayMessages,
      authMethod: 'bearer',
      source: QUOTA_LIMIT_URL,
    };
  }
}

export function createZaiQuotaProvider(
  _config: Record<string, unknown>,
  ctx: ConnectorContext,
): QuotaProvider {
  return new ZaiQuotaProvider(ctx);
}
