/**
 * Single shared per-token pricing table used to estimate local spend from
 * transcript/session token counts (Phase 4). No connector should keep its
 * own copy of a rate — add it here instead.
 *
 * VINTAGE / SOURCE (read before trusting a number): the rates below reflect
 * this author's best knowledge of Anthropic's and OpenAI's published
 * per-token pricing as of training data with a cutoff of January 2026 —
 * *not* a live-fetched price list. They will drift as vendors change
 * pricing; that drift is expected and acceptable, but these numbers must
 * never be presented to a user as authoritative for billing purposes. See
 * the per-block comments below for per-vendor confidence notes.
 *
 * Model identifiers are far more numerous than pricing tiers (every dated
 * snapshot, region, or alias is a new string), so `rateFor` matches by
 * normalized SUBSTRING against a small set of tier keys rather than
 * requiring an exact key per model string. Longer/more specific keys are
 * checked first so e.g. `'gpt-5-mini'` wins over the more general `'gpt-5'`
 * for a model string that contains both.
 */

/** Structurally-checkable staleness marker (SUGGESTION, correction round) --
 * the vintage is documented in prose above too, but a constant lets tooling
 * flag it mechanically rather than relying on someone rereading the comment. */
export const PRICING_VINTAGE = '2026-01';

export interface ModelRate {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
  cacheReadPerMTokUsd?: number;
  cacheWritePerMTokUsd?: number;
  /** Above this many total tokens (input+output+cache) in one record, `longContextMultiplier` applies. */
  longContextThresholdTokens?: number;
  longContextMultiplier?: number;
  /** Multiplier applied when the caller signals a priority/fast service tier via `costCentsFor`'s `fastTier` flag. */
  fastTierMultiplier?: number;
}

export const MODEL_RATES: Record<string, ModelRate> = {
  // --- Anthropic (Claude Code) -----------------------------------------
  // Confidence: HIGH for the tier structure (Sonnet/Opus/Haiku pricing has
  // stayed at these levels across the Claude 3.x / 4.x generations); the
  // exact rate for whichever dated snapshot is current on claude.ai today
  // may differ slightly. Cache read/write rates follow Anthropic's
  // documented prompt-caching discounts (~10% of input for reads, ~1.25x
  // input for a 5-minute-ephemeral write — the JSONL usage shape this repo
  // reads doesn't distinguish 5m vs 1h cache writes, so a single blended
  // write rate is used).
  opus: {
    inputPerMTokUsd: 15,
    outputPerMTokUsd: 75,
    cacheReadPerMTokUsd: 1.5,
    cacheWritePerMTokUsd: 18.75,
  },
  sonnet: {
    inputPerMTokUsd: 3,
    outputPerMTokUsd: 15,
    cacheReadPerMTokUsd: 0.3,
    cacheWritePerMTokUsd: 3.75,
  },
  haiku: {
    inputPerMTokUsd: 0.8,
    outputPerMTokUsd: 4,
    cacheReadPerMTokUsd: 0.08,
    cacheWritePerMTokUsd: 1,
  },

  // --- OpenAI (Codex CLI) -----------------------------------------------
  // Confidence: MEDIUM. GPT-5-family pricing (including the long-context
  // >200k-token surcharge and a priority/fast service tier) was publicly
  // documented as of this author's training data, but the exact model id
  // strings Codex CLI's local rollout files record were NOT verified
  // against a real sample on this machine (see the Phase 4 report) — the
  // more specific keys below exist so a real "gpt-5-codex"-flavoured id
  // still resolves correctly even if the exact suffix differs.
  'gpt-5-codex': {
    inputPerMTokUsd: 1.25,
    outputPerMTokUsd: 10,
    cacheReadPerMTokUsd: 0.125,
    longContextThresholdTokens: 272_000,
    longContextMultiplier: 2,
    fastTierMultiplier: 1.5,
  },
  'gpt-5-mini': {
    inputPerMTokUsd: 0.25,
    outputPerMTokUsd: 2,
    cacheReadPerMTokUsd: 0.025,
    longContextThresholdTokens: 272_000,
    longContextMultiplier: 2,
  },
  'gpt-5-nano': {
    inputPerMTokUsd: 0.05,
    outputPerMTokUsd: 0.4,
    cacheReadPerMTokUsd: 0.005,
    longContextThresholdTokens: 272_000,
    longContextMultiplier: 2,
  },
  'gpt-5': {
    inputPerMTokUsd: 1.25,
    outputPerMTokUsd: 10,
    cacheReadPerMTokUsd: 0.125,
    longContextThresholdTokens: 272_000,
    longContextMultiplier: 2,
    fastTierMultiplier: 1.5,
  },
  // --- xAI (Grok CLI) -----------------------------------------------------
  // Confidence: LOW. This dev machine has no `~/.grok` install (verified
  // directly during Phase 5.4 — see grok/quota.ts's file-header CONFIDENCE
  // note), so neither the exact model id strings Grok CLI's local
  // `unified.jsonl` log records nor a live-verified rate list were
  // available. The figures below are this author's best-effort
  // recollection of xAI's publicly documented per-token API pricing as of
  // training data (cutoff January 2026) — treat as more uncertain than the
  // Anthropic/OpenAI tiers above, and expect drift.
  'grok-code-fast': {
    inputPerMTokUsd: 0.2,
    outputPerMTokUsd: 1.5,
    cacheReadPerMTokUsd: 0.02,
  },
  'grok-4-fast': {
    inputPerMTokUsd: 0.2,
    outputPerMTokUsd: 0.5,
    cacheReadPerMTokUsd: 0.05,
  },
  'grok-4': {
    inputPerMTokUsd: 3,
    outputPerMTokUsd: 15,
    cacheReadPerMTokUsd: 0.75,
  },
  'grok-3-mini': {
    inputPerMTokUsd: 0.3,
    outputPerMTokUsd: 0.5,
  },
  'grok-3': {
    inputPerMTokUsd: 3,
    outputPerMTokUsd: 15,
    cacheReadPerMTokUsd: 0.75,
  },

  // Legacy/fallback tiers, kept in case an older Codex session references
  // an o-series or gpt-4.1-era model instead of a GPT-5-family one.
  o3: {
    inputPerMTokUsd: 2,
    outputPerMTokUsd: 8,
    cacheReadPerMTokUsd: 0.5,
  },
  'o4-mini': {
    inputPerMTokUsd: 1.1,
    outputPerMTokUsd: 4.4,
    cacheReadPerMTokUsd: 0.275,
  },
  'gpt-4.1-mini': {
    inputPerMTokUsd: 0.4,
    outputPerMTokUsd: 1.6,
    cacheReadPerMTokUsd: 0.1,
  },
  'gpt-4.1': {
    inputPerMTokUsd: 2,
    outputPerMTokUsd: 8,
    cacheReadPerMTokUsd: 0.5,
  },
};

/**
 * Resolves a model identifier to its pricing tier via normalized substring
 * match, longest/most-specific key first. Returns `null` for an
 * unrecognised model — callers must treat that as "cost unknown", never as
 * a free/zero-cost model.
 */
export function rateFor(model: string | undefined | null): ModelRate | null {
  if (!model) return null;
  const normalized = model.trim().toLowerCase();
  if (!normalized) return null;
  const keys = Object.keys(MODEL_RATES).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (normalized.includes(key)) return MODEL_RATES[key];
  }
  return null;
}

export interface CostCentsInput {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /**
   * Billed at `outputPerMTokUsd` — reasoning tokens aren't broken out as
   * their own priced tier in any rate this table currently covers, and
   * reasoning-capable models (o-series, GPT-5 "thinking") document billing
   * them the same as ordinary output tokens. Stated as an assumption, not a
   * verified per-vendor fact.
   */
  reasoningTokens?: number;
  /**
   * Deliberate, documented deviation from the plan's literal `costCentsFor`
   * sketch: a priority/fast service-tier signal can't be derived from token
   * counts, so it needs its own field. Defaults to `false` when omitted —
   * callers who don't know don't accidentally trigger the surcharge.
   */
  fastTier?: boolean;
}

/**
 * Computes integer cents for one usage record. Returns `null` — never `0`
 * — when the model isn't in `MODEL_RATES`, so an unpriced model can't be
 * silently mistaken for a genuinely free one by the Total Spend card.
 */
export function costCentsFor(model: string, t: CostCentsInput): number | null {
  const rate = rateFor(model);
  if (!rate) return null;

  const inputTokens = Math.max(0, t.inputTokens || 0);
  const outputTokens = Math.max(0, t.outputTokens || 0);
  const cacheReadTokens = Math.max(0, t.cacheReadTokens || 0);
  const cacheWriteTokens = Math.max(0, t.cacheWriteTokens || 0);
  const reasoningTokens = Math.max(0, t.reasoningTokens || 0);

  const totalTokens = inputTokens + outputTokens + reasoningTokens + cacheReadTokens + cacheWriteTokens;
  const overLongContext =
    rate.longContextThresholdTokens != null && totalTokens > rate.longContextThresholdTokens;
  const contextMultiplier = overLongContext ? rate.longContextMultiplier ?? 1 : 1;
  const fastMultiplier = t.fastTier ? rate.fastTierMultiplier ?? 1 : 1;
  const multiplier = contextMultiplier * fastMultiplier;

  const cacheReadRate = rate.cacheReadPerMTokUsd ?? rate.inputPerMTokUsd;
  const cacheWriteRate = rate.cacheWritePerMTokUsd ?? rate.inputPerMTokUsd;

  const dollars =
    (inputTokens / 1_000_000) * rate.inputPerMTokUsd * multiplier +
    (outputTokens / 1_000_000) * rate.outputPerMTokUsd * multiplier +
    (reasoningTokens / 1_000_000) * rate.outputPerMTokUsd * multiplier +
    (cacheReadTokens / 1_000_000) * cacheReadRate * multiplier +
    (cacheWriteTokens / 1_000_000) * cacheWriteRate * multiplier;

  return Math.round(dollars * 100);
}
