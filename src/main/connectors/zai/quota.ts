import { ConnectorContext, QuotaBucket, QuotaProvider, QuotaSnapshot } from '../types';

/**
 * Z.ai / GLM quota provider.
 *
 * CONFIDENCE NOTES (read before trusting a number):
 *
 * 1. `/api/monitor/usage/quota/limit` response shape — MEDIUM-HIGH, sourced
 *    from two independent community quota tools that agree on the field
 *    names, still unverified against a live key here. The shape is:
 *      data.level                                  -> 'lite' | 'pro' | 'max'
 *      data.limits[].type                          -> TOKENS_LIMIT | CREDIT_LIMIT | TIME_LIMIT
 *      data.limits[].unit                          -> 3 = 5h window, 6 = weekly
 *      data.limits[].usage                         -> the CAP for the window
 *      data.limits[].currentValue                  -> the amount CONSUMED
 *      data.limits[].remaining / .percentage       -> server-computed
 *      data.limits[].nextResetTime                 -> epoch MILLISECONDS
 *    `usage` naming the cap and `currentValue` the consumption is genuinely
 *    counter-intuitive; an earlier version of this file read them the other
 *    way round and reported a 402-of-2000 account as 402/402 = 100% spent.
 * 2. Window classification comes from the numeric `unit` code (3 / 6), not
 *    from a name heuristic — the entries carry no window-length field.
 * 3. Auth form — UNCONFIRMED. One community tool sends
 *    `Authorization: Bearer <key>`, another sends the RAW key with no
 *    prefix (plus `Accept-Language`). Bearer is tried first and a 401 is
 *    retried once with the raw key rather than being reported as a bad key.
 * 4. `parseQuotaItems` / `extractItems` below are the ORIGINAL fuzzy parser,
 *    kept as a fallback for any account whose response has no `data.limits`
 *    array. It reads `item.usage` as CONSUMED, which is the inverted reading
 *    fixed in note 1 — so it must only ever run when the documented shape is
 *    absent. `parseLimits` gates that (see `fetch`).
 *
 * Related sibling endpoints exist but are not called (one undocumented
 * request per poll is enough): `/api/monitor/usage/model-usage` and
 * `/api/monitor/usage/tool-usage`, both taking `startTime` / `endTime`.
 */

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
 * `nextResetTime` arrives as epoch MILLISECONDS, so the raw value is used
 * as-is with no seconds-vs-ms disambiguation. Both community tools that
 * informed this file agree on the unit (see file-header note 1).
 */
function resetsAtMsFromEpochMs(raw: unknown): number | null {
  const n = firstFiniteNumber(raw);
  return n != null && n > 0 ? n : null;
}

type RawItem = Record<string, unknown>;

/**
 * FALLBACK PARSER ONLY — see file-header note 4. This is the original
 * best-effort probe across plausible container paths and field names, used
 * only for a response that carries no `data.limits` array. It reads
 * `item.usage` as the CONSUMED amount, which is the opposite of what the
 * documented shape means by that field, so running it on a `limits` response
 * would re-introduce the inversion `parseLimits` exists to fix.
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

// --- Primary parser: the documented `data.limits` shape -------------------

/** `unit` codes that identify a limit entry's window (file-header note 2). */
const UNIT_FIVE_HOUR = 3;
const UNIT_WEEKLY = 6;

export interface ParsedLimit {
  window: 'session' | 'weekly';
  /** 0..100. Server-reported `percentage` when present, else derived from
   * `currentValue` (consumed) over `usage` (the cap). */
  usedPercent: number;
  resetsAt: number | null;
  windowMs: number;
}

export interface ParsedLimitResponse {
  /** `null` when the response carried no `data.limits` array at all — the
   * signal `fetch` uses to fall back to the legacy fuzzy parser. */
  limits: ParsedLimit[] | null;
  level: string | null;
}

/**
 * Parses the documented response. `TIME_LIMIT` entries are skipped (they
 * describe a subscription's calendar validity, not a usage meter);
 * `TOKENS_LIMIT` and `CREDIT_LIMIT` are both real meters — lite accounts
 * moved to `CREDIT_LIMIT` during 2026, and tools that matched only
 * `TOKENS_LIMIT` went blank for those users. Exported for test coverage.
 */
export function parseLimits(json: unknown): ParsedLimitResponse {
  const data = (json as { data?: unknown } | undefined)?.data;
  const obj = (data ?? {}) as Record<string, unknown>;
  const level = firstString(obj.level);
  const rawLimits = obj.limits;
  if (!Array.isArray(rawLimits)) return { limits: null, level };

  const out: ParsedLimit[] = [];
  for (const raw of rawLimits) {
    if (!isRawItem(raw)) continue;
    const item = raw as RawItem;

    const type = (firstString(item.type) ?? '').toUpperCase();
    if (type === 'TIME_LIMIT') continue;

    const unit = firstFiniteNumber(item.unit);
    const window = unit === UNIT_FIVE_HOUR ? 'session' : unit === UNIT_WEEKLY ? 'weekly' : null;
    if (window == null) continue;

    // `percentage` is taken as already 0..100 (the sampled 402-of-2000
    // account reports 20, not 0.2). Deriving from currentValue/usage is the
    // fallback, never the other way round.
    let usedPercent = firstFiniteNumber(item.percentage);
    if (usedPercent == null) {
      const consumed = firstFiniteNumber(item.currentValue);
      const cap = firstFiniteNumber(item.usage);
      if (consumed == null || cap == null || cap <= 0) continue;
      usedPercent = (consumed / cap) * 100;
    }

    out.push({
      window,
      usedPercent: Math.min(100, Math.max(0, usedPercent)),
      resetsAt: resetsAtMsFromEpochMs(item.nextResetTime),
      windowMs: window === 'session' ? SESSION_WINDOW_MS : WEEKLY_WINDOW_MS,
    });
  }
  return { limits: out, level };
}

/**
 * Buckets from the documented shape. `remaining` is the percent complement,
 * NOT the response's own `remaining` field: that field counts down in the
 * entry's native unit (tokens or credits, per `type`), so dropping it into a
 * percent bucket would mix two scales in one row. The bucket ids stay
 * `session` / `weekly` because both still mean exactly what they meant
 * before — the 5h and 7d windows — so persisted star/hide prefs carry over.
 * Exported for test coverage.
 */
export function limitBuckets(limits: ParsedLimit[]): QuotaBucket[] {
  const buckets: QuotaBucket[] = [];
  for (const window of ['session', 'weekly'] as const) {
    const entry = limits.find(l => l.window === window);
    if (!entry) continue;
    const bucket: QuotaBucket = {
      id: window,
      label: window === 'session' ? 'Session (5h)' : 'Weekly',
      used: entry.usedPercent,
      limit: 100,
      remaining: Math.max(0, 100 - entry.usedPercent),
      unit: 'percent',
      enabled: true,
      windowMs: entry.windowMs,
    };
    // `windowMs` here is genuinely observed (the `unit` code identifies the
    // window), so pairing a real `resetsAt` with it is sound.
    if (entry.resetsAt != null) bucket.resetsAt = entry.resetsAt;
    buckets.push(bucket);
  }
  return buckets;
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

    const quotaResp = await this.fetchQuotaWithAuthFallback(apiKey);
    if (quotaResp.status === 401 || quotaResp.status === 403) {
      return {
        ok: false,
        fetchedAt,
        error:
          `Z.ai rejected the API key (HTTP ${quotaResp.status}), with both the Bearer and raw-key ` +
          'auth forms. Check the key in the Z.ai Quota section.',
        needsLogin: false,
      };
    }
    if (quotaResp.status >= 400) {
      return {
        ok: false,
        fetchedAt,
        error: `Could not fetch Z.ai quota: HTTP ${quotaResp.status}`,
      };
    }

    const documented = parseLimits(quotaResp.json);
    if (documented.limits != null) {
      const buckets = limitBuckets(documented.limits);
      if (buckets.length === 0) {
        return {
          ok: false,
          fetchedAt,
          error:
            'Z.ai returned a quota response with no usable limit windows (every entry was a TIME_LIMIT ' +
            'or carried an unrecognised unit code).',
          source: QUOTA_LIMIT_URL,
        };
      }
      return {
        ok: true,
        fetchedAt,
        buckets,
        membershipType: documented.level ?? undefined,
        displayMessages: [],
        authMethod: 'api-key',
        source: QUOTA_LIMIT_URL,
      };
    }

    // No `data.limits` array — fall back to the legacy fuzzy parser (see
    // file-header note 4).
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

    return {
      ok: true,
      fetchedAt,
      buckets,
      displayMessages: [],
      authMethod: 'api-key',
      source: QUOTA_LIMIT_URL,
    };
  }

  /**
   * Bearer first, then the raw key once on a 401/403 (file-header note 3).
   * The retry also sends `Accept-Language`, which the raw-key tool sends
   * alongside it — cheap, and the canonical form is unconfirmed either way.
   */
  private async fetchQuotaWithAuthFallback(apiKey: string): Promise<{ status: number; json: unknown }> {
    const bearer = await httpsGetJson(QUOTA_LIMIT_URL, {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    });
    if (bearer.status !== 401 && bearer.status !== 403) return bearer;

    return httpsGetJson(QUOTA_LIMIT_URL, {
      Authorization: apiKey,
      Accept: 'application/json',
      'Accept-Language': 'en-US,en',
    });
  }
}

export function createZaiQuotaProvider(
  _config: Record<string, unknown>,
  ctx: ConnectorContext,
): QuotaProvider {
  return new ZaiQuotaProvider(ctx);
}
