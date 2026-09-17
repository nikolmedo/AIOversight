import { ConnectorContext, QuotaBucket, QuotaProvider, QuotaSnapshot, SpendTile } from '../types';
import { fetchClaudeUsage } from './browser-session';
import { JsonlSpendScanner, SpendRecord } from '../shared/jsonl-spend-scanner';
import { costCentsFor } from '../shared/model-pricing';

/**
 * Plan-usage source policy for this connector.
 *
 * ONLY source: the claude.ai browser session (`browser-session.ts`).
 *
 * REMOVED — `claude /usage` CLI scraping (was `cli-quota.ts`). Verified on
 * 2026-09-16 on a machine with Claude Code installed: `/usage` is a TUI-only
 * Ink dialog, and BOTH `claude /usage` and `claude -p "/usage"` hang until
 * killed rather than printing anything parseable. There is no headless
 * equivalent — anthropics/claude-code#40793 (`claude usage --json`) was closed
 * unimplemented. The old code therefore burned a 5s spawn-and-kill on every
 * poll before falling through to the browser session it always ended up
 * using. Do not reintroduce a CLI scrape without first confirming a
 * non-interactive output mode exists.
 *
 * DELIBERATELY NOT USED — `GET api.anthropic.com/api/oauth/usage`. It works
 * with a Claude Code OAuth token, but Anthropic stated (Feb 2026) that using
 * Claude Free/Pro/Max OAuth credentials from other products violates their
 * Consumer Terms. That is a product decision this repo's owner has not made,
 * so it stays out regardless of convenience. The officially sanctioned local
 * alternative is Claude Code's `statusLine` hook, whose stdin JSON carries
 * `rate_limits.five_hour` / `rate_limits.seven_day` with no credentials at
 * all — that is the intended future direction if this connector ever needs a
 * second source.
 */

const FIVE_HOUR_MS = 18_000_000;
const SEVEN_DAY_MS = 604_800_000;

// Mirrors claude-code/index.ts's `configSchema.paths` default -- used as the
// fallback when the user hasn't customised transcript paths. Kept as a
// separate copy rather than importing from index.ts to avoid a
// quota.ts -> index.ts -> quota.ts import cycle.
const DEFAULT_SPEND_PATHS = [
  '~/.claude/projects/**/*.jsonl',
  '~/AppData/Roaming/Claude/projects/**/*.jsonl',
];

/**
 * Extracts a priced usage record from one Claude Code transcript JSONL
 * line. Field names below are verified against a real local transcript
 * (`~/.claude/projects/**\/*.jsonl`, `type:'assistant'` lines) during Phase
 * 4 implementation -- see the Phase 4 report for the exact sample. No
 * `costUSD`/cost field exists in the current format, so cost is always
 * computed from `message.model` + `message.usage` via `costCentsFor`.
 */
function finiteNonNegative(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function extractClaudeCodeSpend(line: unknown): SpendRecord | null {
  if (!line || typeof line !== 'object') return null;
  const obj = line as Record<string, unknown>;
  if (obj.type !== 'assistant') return null;

  const message = obj.message;
  if (!message || typeof message !== 'object') return null;
  const msg = message as Record<string, unknown>;

  const usage = msg.usage;
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;

  const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
  if (!Number.isFinite(ts)) return null;

  // Correction item 3: `Number(v) || 0` lets `Infinity` through unguarded
  // (it's truthy), which would otherwise flow into `costCentsFor` and
  // eventually render as the literal string "$Infinity" in the Total Spend
  // card. `finiteNonNegative` rejects it (and NaN, and negatives) the same
  // way codex-cli's sibling extractor's `Number.isFinite` guard already does.
  const inputTokens = finiteNonNegative(u.input_tokens);
  const outputTokens = finiteNonNegative(u.output_tokens);
  const cacheReadTokens = finiteNonNegative(u.cache_read_input_tokens);
  const cacheWriteTokens = finiteNonNegative(u.cache_creation_input_tokens);
  const model = typeof msg.model === 'string' ? msg.model : undefined;

  const costCents = model
    ? costCentsFor(model, { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens })
    : null;

  return { ts, costCents, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, model };
}

type JsonObject = Record<string, unknown>;

function asObject(v: unknown): JsonObject | null {
  return v != null && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : null;
}

function nonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** `Number('')` is `0`, so an empty or whitespace-only string is rejected
 * before it can become a fabricated measured zero — the same guard cursor,
 * zai, devin, grok and antigravity carry. */
function firstFiniteNumber(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim() === '') continue;
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Epoch ms for a `resets_at` value, or `null` if unparseable. */
function resetsAtMs(raw: unknown): number | null {
  let ms: number;
  if (typeof raw === 'number') ms = raw > 1e10 ? raw : raw * 1000;
  else if (typeof raw === 'string' && raw.trim() !== '') ms = new Date(raw).getTime();
  else return null;
  return Number.isFinite(ms) ? ms : null;
}

function formatResetsAt(raw: unknown, now: number): string | null {
  const ms = resetsAtMs(raw);
  if (ms == null) return null;
  const diff = ms - now;
  if (diff <= 0) return 'now';
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function slugify(s: string): string {
  return s
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function sentenceCase(snake: string): string {
  const words = snake.split(/[_\-\s]+/).filter(Boolean).map(w => w.toLowerCase());
  if (words.length === 0) return '';
  words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);
  return words.join(' ');
}

/** Integer cents from `{amount_minor, exponent}`, or `null` when unmeasurable. */
function minorUnitsToCents(amountMinor: unknown, exponent: unknown): number | null {
  const amount = firstFiniteNumber(amountMinor);
  const exp = firstFiniteNumber(exponent);
  if (amount == null || exp == null || !Number.isInteger(exp) || exp < 0 || exp > 12) return null;
  return Math.round(amount * 10 ** (2 - exp));
}

const WINDOW_MS_BY_GROUP = new Map<string, number>([
  ['session', FIVE_HOUR_MS],
  ['weekly', SEVEN_DAY_MS],
]);

interface ScopeName {
  /** Shown to users. */
  label: string;
  /** Source for the bucket id: the vendor id when present, else the display name. */
  idSource: string;
}

/** A scope part (`scope.model` / `scope.surface`) may be an object or a bare string. */
function scopePartName(part: unknown): ScopeName | null {
  const str = nonEmptyString(part);
  if (str) return { label: str, idSource: str };
  const obj = asObject(part);
  if (!obj) return null;
  const display = nonEmptyString(obj.display_name) ?? nonEmptyString(obj.name);
  const id = nonEmptyString(obj.id);
  const label = display ?? id;
  if (!label) return null;
  return { label, idSource: id ?? label };
}

/** Legacy named keys for the per-model weekly caps. Matched on the display
 * name (or id) so a limit that used to arrive as `seven_day_opus` keeps the
 * same bucket id, and with it the user's saved prefs. */
const LEGACY_WEEKLY_MODEL_IDS: Record<string, string> = {
  opus: 'weekly-opus',
  sonnet: 'weekly-sonnet',
};

function legacyWeeklyModelId(model: ScopeName): string | null {
  for (const source of [model.label, model.idSource]) {
    const tokens = slugify(source).split('-');
    for (const [token, id] of Object.entries(LEGACY_WEEKLY_MODEL_IDS)) {
      if (tokens.includes(token)) return id;
    }
  }
  return null;
}

/**
 * Builds buckets from the `limits[]` array, one per entry, with no list of
 * known models or kinds: a renamed model or a new limit shows up on its own.
 *
 * Bucket ids key the user's persisted `bucketPrefs` (hidden / starred /
 * order), so they must stay stable across polls and releases. The limits that
 * existed before `limits[]` keep their old ids; everything else derives its id
 * from the entry's own data, never from its position in the array.
 */
function limitsBuckets(limits: unknown[], now: number, displayMessages: string[]): QuotaBucket[] {
  const buckets: QuotaBucket[] = [];
  const usedIds = new Set<string>();

  for (const raw of limits) {
    const entry = asObject(raw);
    if (!entry) continue;
    const kind = nonEmptyString(entry.kind);
    if (!kind) continue;
    const kindSlug = slugify(kind);
    if (!kindSlug) continue;
    const group = nonEmptyString(entry.group);

    const scope = asObject(entry.scope);
    const model = scope ? scopePartName(scope.model) : null;
    const surface = scope ? scopePartName(scope.surface) : null;

    // `weekly_scoped` -> "weekly", so the label reads "Weekly Fable limit".
    const kindBase = kind.replace(/_(scoped|all)$/i, '') || kind;
    const kindBaseSlug = slugify(kindBase) || kindSlug;

    let id: string;
    let label: string;
    if (!model && !surface && kind === 'session') {
      id = 'five-hour';
      label = '5-hour limit';
    } else if (!model && !surface && kind === 'weekly_all') {
      id = 'seven-day';
      label = '7-day limit';
    } else if (!model && !surface) {
      id = kindSlug;
      label = `${sentenceCase(kindBase)} limit`;
    } else {
      const legacyId = model && !surface && group === 'weekly' ? legacyWeeklyModelId(model) : null;
      const idParts = [kindBaseSlug];
      if (model) idParts.push('model', slugify(model.idSource) || 'unnamed');
      if (surface) idParts.push('surface', slugify(surface.idSource) || 'unnamed');
      id = legacyId ?? idParts.join('-');
      const name = model ?? surface!;
      label = `${sentenceCase(kindBase)} ${name.label} limit`;
      if (model && surface) label += ` (${surface.label})`;
    }

    let uniqueId = id;
    for (let n = 2; usedIds.has(uniqueId); n++) uniqueId = `${id}-${n}`;
    usedIds.add(uniqueId);

    // Percent above 100 is kept: overage is real, and the renderer clamps the bar.
    const pct = firstFiniteNumber(entry.percent);
    const used = pct != null && pct >= 0 ? pct : null;
    const bucket: QuotaBucket = {
      id: uniqueId,
      label,
      used,
      limit: 100,
      remaining: used != null ? Math.max(0, 100 - used) : null,
      unit: 'percent',
      enabled: true,
    };
    const resetMs = resetsAtMs(entry.resets_at);
    if (resetMs != null) {
      bucket.resetsAt = resetMs;
      // An unknown group has no known length; guessing one would drive the
      // pace projection off made-up data, so the meter keeps static colours.
      const windowMs = group != null ? WINDOW_MS_BY_GROUP.get(group) : undefined;
      if (windowMs != null) bucket.windowMs = windowMs;
    }
    if (model) bucket.defaultVisibility = 'always';
    buckets.push(bucket);

    const reset = formatResetsAt(entry.resets_at, now);
    if (reset) displayMessages.push(`${label} resets in ${reset}`);
  }
  return buckets;
}

interface LegacyWindow {
  utilization?: unknown;
  resets_at?: unknown;
}

/** The named keys the endpoint served before `limits[]`. Kept as the fallback
 * because the claude.ai payload's shape is not guaranteed to match
 * api.anthropic.com's. */
function legacyWindowBuckets(data: JsonObject, now: number, displayMessages: string[]): QuotaBucket[] {
  const buckets: QuotaBucket[] = [];
  // This endpoint's `resets_at` is a real per-window reset timestamp, so we
  // set `resetsAt`/`windowMs` here (activating paceStateFor's
  // projected-exhaustion branch). Only do this when the value is a REAL API
  // timestamp, never a synthesized one (Phase 2a's reverted mistake, where an
  // over-eager version of this exact pattern set resetsAt/windowMs from data
  // that wasn't actually a real reset).
  const addWindow = (
    id: string,
    label: string,
    raw: unknown,
    windowMs: number,
    defaultVisibility?: 'always' | 'onDemand',
  ) => {
    const w = asObject(raw) as LegacyWindow | null;
    if (!w || typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return;
    const bucket: QuotaBucket = {
      id,
      label,
      used: w.utilization,
      limit: 100,
      remaining: Math.max(0, 100 - w.utilization),
      unit: 'percent',
      enabled: true,
    };
    const resetMs = resetsAtMs(w.resets_at);
    if (resetMs != null) {
      bucket.resetsAt = resetMs;
      bucket.windowMs = windowMs;
    }
    if (defaultVisibility) bucket.defaultVisibility = defaultVisibility;
    buckets.push(bucket);
    const reset = formatResetsAt(w.resets_at, now);
    if (reset) displayMessages.push(`${label} resets in ${reset}`);
  };

  addWindow('five-hour', '5-hour limit', data.five_hour, FIVE_HOUR_MS);
  addWindow('seven-day', '7-day limit', data.seven_day, SEVEN_DAY_MS);
  addWindow('weekly-opus', 'Weekly Opus limit', data.seven_day_opus, SEVEN_DAY_MS, 'onDemand');
  addWindow('weekly-sonnet', 'Weekly Sonnet limit', data.seven_day_sonnet, SEVEN_DAY_MS, 'onDemand');
  return buckets;
}

const EXTRA_USAGE_ID = 'extra-usage';
const EXTRA_USAGE_LABEL = 'Extra usage credits';

/** `spend` carries the same money as `extra_usage` (live payload: 0 of 4000
 * minor USD units in both) with an explicit exponent, so it wins when usable. */
function spendBucket(raw: unknown): QuotaBucket | null {
  const spend = asObject(raw);
  if (!spend) return null;
  const usedMoney = asObject(spend.used);
  const limitMoney = asObject(spend.limit);
  const currencies = [usedMoney?.currency, limitMoney?.currency].filter(
    (c): c is string => typeof c === 'string',
  );
  // The 'usd' unit renders with a dollar sign; another currency would be mislabelled.
  if (currencies.length === 0 || currencies.some(c => c.toUpperCase() !== 'USD')) return null;
  const used = usedMoney ? minorUnitsToCents(usedMoney.amount_minor, usedMoney.exponent) : null;
  const limit = limitMoney ? minorUnitsToCents(limitMoney.amount_minor, limitMoney.exponent) : null;
  if (used == null && limit == null) return null;
  const bucket: QuotaBucket = {
    id: EXTRA_USAGE_ID,
    label: EXTRA_USAGE_LABEL,
    used,
    limit,
    remaining: used != null && limit != null ? Math.max(0, limit - used) : null,
    unit: 'usd',
    enabled: true,
    defaultVisibility: 'onDemand',
  };
  if (spend.enabled === false) {
    const reason = nonEmptyString(spend.disabled_reason);
    bucket.note = reason ? `Turned off: ${sentenceCase(reason).toLowerCase()}` : 'Turned off';
  }
  return bucket;
}

function extraUsageBucket(raw: unknown): QuotaBucket | null {
  const extra = asObject(raw);
  if (!extra) return null;
  const used = firstFiniteNumber(extra.used);
  const limit = firstFiniteNumber(extra.limit, extra.granted, extra.total);
  if (used != null || limit != null) {
    return {
      id: EXTRA_USAGE_ID,
      label: EXTRA_USAGE_LABEL,
      used,
      limit,
      remaining: used != null && limit != null ? Math.max(0, limit - used) : null,
      unit: 'credits',
      enabled: true,
      defaultVisibility: 'onDemand',
    };
  }
  // The shape actually served (2026-09-17): minor currency units with `decimal_places`.
  const currency = nonEmptyString(extra.currency);
  if (currency?.toUpperCase() !== 'USD') return null;
  const usedCents = minorUnitsToCents(extra.used_credits, extra.decimal_places);
  const limitCents = minorUnitsToCents(extra.monthly_limit, extra.decimal_places);
  if (usedCents == null && limitCents == null) return null;
  return {
    id: EXTRA_USAGE_ID,
    label: EXTRA_USAGE_LABEL,
    used: usedCents,
    limit: limitCents,
    remaining: usedCents != null && limitCents != null ? Math.max(0, limitCents - usedCents) : null,
    unit: 'usd',
    enabled: true,
    defaultVisibility: 'onDemand',
  };
}

/** "This week: Claude Code 93% · Cowork 6% · Chats 1%", or null. */
function weeklyBreakdownMessage(raw: unknown): string | null {
  const rows = asObject(raw)?.rows;
  if (!Array.isArray(rows)) return null;
  const parts = rows
    .map(r => {
      const row = asObject(r);
      const name = row ? nonEmptyString(row.display_name) : null;
      const pct = row ? firstFiniteNumber(row.percent) : null;
      return name && pct != null && Math.round(pct) > 0 ? { name, pct: Math.round(pct) } : null;
    })
    .filter((p): p is { name: string; pct: number } => p != null)
    .sort((a, b) => b.pct - a.pct);
  if (parts.length === 0) return null;
  return `This week: ${parts.map(p => `${p.name} ${p.pct}%`).join(' · ')}`;
}

/**
 * Parses a claude.ai `/api/organizations/{uuid}/usage` body. `limits[]` is
 * the primary source; the named keys (`five_hour`, `seven_day`, ...) are only
 * read when it is absent or yields nothing. The many codename keys the
 * endpoint also returns (`nimbus_quill`, `tangelo`, ...) are ignored on
 * purpose: they are unlabelled, usually null or zero, and renamed freely.
 */
export function parseClaudeUsage(
  body: unknown,
  now: number,
): { buckets: QuotaBucket[]; displayMessages: string[] } {
  const data = asObject(body) ?? {};
  const displayMessages: string[] = [];

  let buckets: QuotaBucket[] = [];
  if (Array.isArray(data.limits) && data.limits.length > 0) {
    buckets = limitsBuckets(data.limits, now, displayMessages);
  }
  if (buckets.length === 0) {
    buckets = legacyWindowBuckets(data, now, displayMessages);
  }

  const money = spendBucket(data.spend) ?? extraUsageBucket(data.extra_usage);
  if (money) buckets.push(money);

  const breakdown = weeklyBreakdownMessage(data.seven_day_breakdown);
  if (breakdown) displayMessages.push(breakdown);

  return { buckets, displayMessages };
}

class ClaudeCodeQuotaProvider implements QuotaProvider {
  constructor(
    private readonly config: Record<string, unknown>,
    private readonly ctx: ConnectorContext,
  ) {}

  async fetch(): Promise<QuotaSnapshot> {
    const snapshot = await this.fetchQuota();
    if (!snapshot.ok) return snapshot;
    try {
      const spend = await this.computeSpend();
      return { ...snapshot, spend };
    } catch (err) {
      this.ctx.log('warn', '[claude-code] local spend scan failed', { err: String(err) });
      return snapshot;
    }
  }

  /** Local-spend scan (Phase 4) over Claude Code's own transcript files —
   * a completely different data source from `fetchQuota()`'s claude.ai
   * plan-usage buckets below. Non-fatal: any failure here is caught by
   * `fetch()` and simply omits `spend`, never fails the whole snapshot. */
  private async computeSpend(): Promise<SpendTile[]> {
    const rawPaths = this.config.paths as string[] | undefined;
    const patterns = (rawPaths && rawPaths.length ? rawPaths : DEFAULT_SPEND_PATHS).map(p =>
      this.ctx.resolvePath(p),
    );
    const scanner = JsonlSpendScanner.shared(this.ctx.cacheDir);
    const records = await scanner.scan({
      key: 'claude-code',
      patterns,
      extract: line => extractClaudeCodeSpend(line),
    });
    return scanner.aggregate(records, Date.now());
  }

  private async fetchQuota(): Promise<QuotaSnapshot> {
    const fetchedAt = Date.now();
    const result = await fetchClaudeUsage();

    if (result.kind === 'needs-login') {
      return {
        ok: false,
        fetchedAt,
        needsLogin: true,
        error: 'Sign in to claude.ai to see your plan usage.',
      };
    }
    if (result.kind === 'error') {
      return { ok: false, fetchedAt, error: result.message };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.body);
    } catch {
      return { ok: false, fetchedAt, error: 'claude.ai returned an unexpected usage response.' };
    }

    return this.toSnapshot(parsed, fetchedAt, result.url);
  }

  private toSnapshot(data: unknown, fetchedAt: number, url: string): QuotaSnapshot {
    const { buckets, displayMessages } = parseClaudeUsage(data, fetchedAt);
    return {
      ok: true,
      fetchedAt,
      buckets,
      membershipType: 'Claude (claude.ai)',
      displayMessages,
      authMethod: 'cookie',
      source: url,
    };
  }
}

export function createClaudeCodeQuotaProvider(
  config: Record<string, unknown>,
  ctx: ConnectorContext,
): QuotaProvider {
  return new ClaudeCodeQuotaProvider(config, ctx);
}
