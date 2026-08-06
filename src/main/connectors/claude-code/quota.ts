import { ConnectorContext, QuotaBucket, QuotaProvider, QuotaSnapshot, SpendTile } from '../types';
import { fetchClaudeUsage } from './browser-session';
import { ClaudeCodeCliQuotaProvider } from './cli-quota';
import { JsonlSpendScanner, SpendRecord } from '../shared/jsonl-spend-scanner';
import { costCentsFor } from '../shared/model-pricing';

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

interface UsageWindow {
  utilization?: number;
  resets_at?: string | number;
}

interface ExtraUsage {
  used?: number;
  limit?: number;
  granted?: number;
  total?: number;
}

interface UsageResponse {
  five_hour?: UsageWindow;
  seven_day?: UsageWindow;
  /** Max-plan-only: a separate weekly cap that just tracks Opus usage. */
  seven_day_opus?: UsageWindow;
  /** Max-plan-only: a separate weekly cap that just tracks Sonnet usage. */
  seven_day_sonnet?: UsageWindow;
  /** Purchased/granted extra usage beyond the plan's included limits. */
  extra_usage?: ExtraUsage;
}

function firstFiniteNumber(...vals: unknown[]): number | null {
  for (const v of vals) {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Epoch ms for a `resets_at` value, or `null` if unparseable. */
function resetsAtMs(raw: string | number | undefined): number | null {
  if (raw == null) return null;
  const ms = typeof raw === 'number' ? (raw > 1e10 ? raw : raw * 1000) : new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function formatResetsAt(raw: string | number | undefined): string | null {
  const ms = resetsAtMs(raw);
  if (ms == null) return null;
  const diff = ms - Date.now();
  if (diff <= 0) return 'now';
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
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
   * a completely different data source from `fetchQuota()`'s claude.ai /
   * CLI plan-usage buckets above. Non-fatal: any failure here is caught by
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
    // Try the claude CLI first — already authenticated, no browser session needed
    try {
      return await new ClaudeCodeCliQuotaProvider().fetch();
    } catch {
      // CLI unavailable, timed out, or output unparseable — fall through to browser session
    }

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

    let parsed: UsageResponse;
    try {
      parsed = JSON.parse(result.body) as UsageResponse;
    } catch {
      return { ok: false, fetchedAt, error: 'claude.ai returned an unexpected usage response.' };
    }

    return this.toSnapshot(parsed, fetchedAt, result.url);
  }

  private toSnapshot(data: UsageResponse, fetchedAt: number, url: string): QuotaSnapshot {
    const buckets: QuotaBucket[] = [];
    const displayMessages: string[] = [];

    // Phase 3: this endpoint's `resets_at` is a real per-window reset
    // timestamp, so we set `resetsAt`/`windowMs` here (activating
    // paceStateFor's projected-exhaustion branch) — unlike cli-quota.ts's
    // parallel path, which only has a human string ("Resets 3am") and must
    // stay on the static-threshold fallback because it has no real timestamp
    // to set `resetsAt` from. Only do this when the value is a REAL API
    // timestamp, never a synthesized one (Phase 2a's reverted mistake, where
    // an over-eager version of this exact pattern set resetsAt/windowMs from
    // data that wasn't actually a real reset).
    const addWindow = (
      id: string,
      label: string,
      w: UsageWindow | undefined,
      windowMs: number,
      defaultVisibility?: 'always' | 'onDemand',
    ) => {
      if (!w || typeof w.utilization !== 'number') return;
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
      const reset = formatResetsAt(w.resets_at);
      if (reset) displayMessages.push(`${label} resets in ${reset}`);
    };

    addWindow('five-hour', '5-hour limit', data.five_hour, FIVE_HOUR_MS);
    addWindow('seven-day', '7-day limit', data.seven_day, SEVEN_DAY_MS);
    addWindow('weekly-opus', 'Weekly Opus limit', data.seven_day_opus, SEVEN_DAY_MS, 'onDemand');
    addWindow('weekly-sonnet', 'Weekly Sonnet limit', data.seven_day_sonnet, SEVEN_DAY_MS, 'onDemand');

    const extra = data.extra_usage;
    if (extra) {
      const used = firstFiniteNumber(extra.used);
      const limit = firstFiniteNumber(extra.limit, extra.granted, extra.total);
      if (used != null || limit != null) {
        buckets.push({
          id: 'extra-usage',
          label: 'Extra usage credits',
          used,
          limit,
          remaining: used != null && limit != null ? Math.max(0, limit - used) : null,
          unit: 'credits',
          enabled: true,
          defaultVisibility: 'onDemand',
        });
      }
    }

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
