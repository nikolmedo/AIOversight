/**
 * Single shared per-token pricing table used to estimate local spend from
 * transcript/session token counts (Phase 4). No connector should keep its
 * own copy of a rate — add it here instead.
 *
 * VINTAGE / SOURCE (read before trusting a number): the rates below reflect
 * Anthropic's published per-token list pricing as verified in October 2026
 * and OpenAI's as verified in September 2026 — *not* a live-fetched price list. They will drift as
 * vendors change pricing; that drift is expected and acceptable, but these
 * numbers must never be presented to a user as authoritative for billing
 * purposes. See the per-block comments below for per-vendor confidence notes.
 *
 * ANTHROPIC RATES ARE VERSION-KEYED. An earlier revision of this file priced
 * Claude by family alone (`opus` / `sonnet` / `haiku` substring keys) on the
 * assumption that a family's price is stable across generations. That
 * assumption is what broke: Opus dropped from $15/$75 (4.0/4.1) to $5/$25 at
 * 4.5, and Sonnet dropped from $3/$15 to $2/$10 at 5.0, so a `claude-opus-4-8`
 * session was being billed 3x its real cost. `rateFor` now parses the version
 * out of the model id and picks the matching tier; the `fable` and `mythos`
 * families, which matched no key at all before, are covered too.
 *
 * Model identifiers are far more numerous than pricing tiers (every dated
 * snapshot, region, or alias is a new string), so non-Claude models still
 * match by normalized SUBSTRING against a small set of tier keys rather than
 * requiring an exact key per model string. Longer/more specific keys are
 * checked first so e.g. `'gpt-5-mini'` wins over the more general `'gpt-5'`
 * for a model string that contains both.
 *
 * A Claude id with no parseable version (a bare `'opus'`, or a legacy
 * `claude-3-5-sonnet-…` where the family name trails the version) falls
 * through to the substring keys, which point at the NEWEST tier of that
 * family. That is deliberate: guessing "current" is less wrong than guessing
 * "retired" for an id we cannot date, and it never returns null for a model
 * we do recognise by name.
 */

/** Structurally-checkable staleness marker (SUGGESTION, correction round) --
 * the vintage is documented in prose above too, but a constant lets tooling
 * flag it mechanically rather than relying on someone rereading the comment. */
export const PRICING_VINTAGE = '2026-10';

export interface ModelRate {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
  cacheReadPerMTokUsd?: number;
  /** 5-minute cache write. Falls back to `inputPerMTokUsd` when absent. */
  cacheWritePerMTokUsd?: number;
  /** 1-hour cache write. Falls back to `cacheWritePerMTokUsd`, then `inputPerMTokUsd`, when absent. */
  cacheWrite1hPerMTokUsd?: number;
  /** Above this many total tokens (input+output+cache) in one record, `longContextMultiplier` applies. */
  longContextThresholdTokens?: number;
  longContextMultiplier?: number;
  /** Above this many PROMPT tokens (input + cache read + both cache writes; never output) in one record, `promptLengthMultiplier` applies. */
  promptLengthThresholdTokens?: number;
  promptLengthMultiplier?: number;
  /** Multiplier applied when the caller signals a priority/fast service tier via `costCentsFor`'s `fastTier` flag. */
  fastTierMultiplier?: number;
}

// --- Anthropic (Claude Code) -------------------------------------------------
// Confidence: HIGH. Per-1M-token list prices as published October 2026
// (input / output / cache read / 5-minute cache write / 1-hour cache write).
// Claude Code's JSONL usage splits cache writes by duration
// (`usage.cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`),
// so callers can pass both counts to `costCentsFor`; a caller that only has
// the flat `cache_creation_input_tokens` total gets the 5m rate.
//
// No Claude entry declares `longContextThresholdTokens`: Anthropic charges no
// long-context surcharge on the 4.6-and-newer models, so applying one here
// would invent a cost the user is not billed. Haiku 5.5's higher prices for
// prompts over 100,000 tokens are a different rule (prompt length only,
// output excluded) and use `promptLengthThresholdTokens` instead.
//
// Fast mode is 2x standard on Opus 5.5, 5 and 4.8 only (removed on 4.7; 4.6
// bills fast requests at standard rates). The `inference_geo: "us"` 1.1x
// multiplier is not modelled: no transcript this repo reads records it.

/** Opus 5.5. Cache read is 0.05x base input instead of the usual 0.1x. */
const CLAUDE_OPUS_5_5: ModelRate = {
  inputPerMTokUsd: 4,
  outputPerMTokUsd: 20,
  cacheReadPerMTokUsd: 0.2,
  cacheWritePerMTokUsd: 5,
  cacheWrite1hPerMTokUsd: 8,
  fastTierMultiplier: 2,
};
/** Opus 4.8 / 5 — the 4.5 price list plus fast mode. */
const CLAUDE_OPUS_FAST: ModelRate = {
  inputPerMTokUsd: 5,
  outputPerMTokUsd: 25,
  cacheReadPerMTokUsd: 0.5,
  cacheWritePerMTokUsd: 6.25,
  cacheWrite1hPerMTokUsd: 10,
  fastTierMultiplier: 2,
};
/** Opus 4.5 / 4.6 / 4.7 — no fast mode. */
const CLAUDE_OPUS_4_5: ModelRate = {
  inputPerMTokUsd: 5,
  outputPerMTokUsd: 25,
  cacheReadPerMTokUsd: 0.5,
  cacheWritePerMTokUsd: 6.25,
  cacheWrite1hPerMTokUsd: 10,
};
/** Opus 4 / 4.1 — retired, priced here only so an old transcript still totals correctly. */
const CLAUDE_OPUS_LEGACY: ModelRate = {
  inputPerMTokUsd: 15,
  outputPerMTokUsd: 75,
  cacheReadPerMTokUsd: 1.5,
  cacheWritePerMTokUsd: 18.75,
  cacheWrite1hPerMTokUsd: 30,
};
/**
 * Sonnet 5.5. Its cache read dropped from $0.20 to $0.10 on 2026-10-07; the
 * table is dateless, so reads logged between launch (2026-09-28) and then are
 * under-priced by $0.10/MTok.
 */
const CLAUDE_SONNET_5_5: ModelRate = {
  inputPerMTokUsd: 2,
  outputPerMTokUsd: 10,
  cacheReadPerMTokUsd: 0.1,
  cacheWritePerMTokUsd: 2.5,
  cacheWrite1hPerMTokUsd: 4,
};
const CLAUDE_SONNET_5_0: ModelRate = {
  inputPerMTokUsd: 2,
  outputPerMTokUsd: 10,
  cacheReadPerMTokUsd: 0.2,
  cacheWritePerMTokUsd: 2.5,
  cacheWrite1hPerMTokUsd: 4,
};
/** Sonnet 4 / 4.5 / 4.6. */
const CLAUDE_SONNET_LEGACY: ModelRate = {
  inputPerMTokUsd: 3,
  outputPerMTokUsd: 15,
  cacheReadPerMTokUsd: 0.3,
  cacheWritePerMTokUsd: 3.75,
  cacheWrite1hPerMTokUsd: 6,
};
/** Haiku 5.5. A prompt over 100,000 tokens pays 5x on every category, output included. */
const CLAUDE_HAIKU_5_5: ModelRate = {
  inputPerMTokUsd: 0.1,
  outputPerMTokUsd: 0.5,
  cacheReadPerMTokUsd: 0.01,
  cacheWritePerMTokUsd: 0.125,
  cacheWrite1hPerMTokUsd: 0.2,
  promptLengthThresholdTokens: 100_000,
  promptLengthMultiplier: 5,
};
const CLAUDE_HAIKU_4_5: ModelRate = {
  inputPerMTokUsd: 1,
  outputPerMTokUsd: 5,
  cacheReadPerMTokUsd: 0.1,
  cacheWritePerMTokUsd: 1.25,
  cacheWrite1hPerMTokUsd: 2,
};
/** Haiku 3.5 — retired. */
const CLAUDE_HAIKU_LEGACY: ModelRate = {
  inputPerMTokUsd: 0.8,
  outputPerMTokUsd: 4,
  cacheReadPerMTokUsd: 0.08,
  cacheWritePerMTokUsd: 1,
  cacheWrite1hPerMTokUsd: 1.6,
};
/** fable / mythos 5.1+ — same list price as 5.0 except for a cheaper cache read. */
const CLAUDE_FABLE_CURRENT: ModelRate = {
  inputPerMTokUsd: 10,
  outputPerMTokUsd: 50,
  cacheReadPerMTokUsd: 0.25,
  cacheWritePerMTokUsd: 12.5,
  cacheWrite1hPerMTokUsd: 20,
};
const CLAUDE_FABLE_5_0: ModelRate = {
  inputPerMTokUsd: 10,
  outputPerMTokUsd: 50,
  cacheReadPerMTokUsd: 1,
  cacheWritePerMTokUsd: 12.5,
  cacheWrite1hPerMTokUsd: 20,
};

type ClaudeFamily = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'mythos';

/**
 * Version is stored as `major * 10 + minor` (4.8 -> 48, 5 -> 50, 5.1 -> 51) so
 * tier thresholds compare as integers — a float built by dividing the minor by
 * 10 would make `>=` on a threshold like 4.5 a rounding question.
 *
 * Each family's tiers are ordered NEWEST FIRST and the last entry has
 * `minVersion: 0`, so an unrecognised future version (e.g. `claude-opus-6`)
 * resolves to the newest tier and nothing ever falls off the end into `null`.
 */
interface ClaudeTier {
  minVersion: number;
  rate: ModelRate;
}

const CLAUDE_TIERS: Record<ClaudeFamily, ClaudeTier[]> = {
  opus: [
    { minVersion: 55, rate: CLAUDE_OPUS_5_5 },
    { minVersion: 48, rate: CLAUDE_OPUS_FAST },
    { minVersion: 45, rate: CLAUDE_OPUS_4_5 },
    { minVersion: 0, rate: CLAUDE_OPUS_LEGACY },
  ],
  sonnet: [
    { minVersion: 55, rate: CLAUDE_SONNET_5_5 },
    { minVersion: 50, rate: CLAUDE_SONNET_5_0 },
    { minVersion: 0, rate: CLAUDE_SONNET_LEGACY },
  ],
  haiku: [
    { minVersion: 55, rate: CLAUDE_HAIKU_5_5 },
    { minVersion: 45, rate: CLAUDE_HAIKU_4_5 },
    { minVersion: 0, rate: CLAUDE_HAIKU_LEGACY },
  ],
  fable: [
    { minVersion: 51, rate: CLAUDE_FABLE_CURRENT },
    { minVersion: 0, rate: CLAUDE_FABLE_5_0 },
  ],
  mythos: [
    { minVersion: 51, rate: CLAUDE_FABLE_CURRENT },
    { minVersion: 0, rate: CLAUDE_FABLE_5_0 },
  ],
};

/**
 * The minor-version group is capped at two digits AND must not be followed by
 * another digit, which is what keeps a dated snapshot out of the version:
 * `claude-sonnet-4-5-20250929` parses as 4.5 (the `5` is followed by `-`),
 * while `claude-sonnet-4-20250514` parses as plain 4 (no two-digit prefix of
 * `20250514` survives the lookahead) instead of an absurd 4.20.
 *
 * Unanchored on both sides so provider-prefixed ids still match —
 * `opencode/claude-sonnet-4-6`, `anthropic.claude-opus-4-8-v1:0`.
 */
const CLAUDE_MODEL_RE = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2})(?!\d))?/;

function claudeRateFor(normalized: string): ModelRate | null {
  const m = CLAUDE_MODEL_RE.exec(normalized);
  if (!m) return null;
  const family = m[1] as ClaudeFamily;
  const version = Number(m[2]) * 10 + (m[3] != null ? Number(m[3]) : 0);
  if (!Number.isFinite(version)) return null;
  const tiers = CLAUDE_TIERS[family];
  for (const tier of tiers) {
    if (version >= tier.minVersion) return tier.rate;
  }
  return tiers[tiers.length - 1].rate;
}

export const MODEL_RATES: Record<string, ModelRate> = {
  // --- Anthropic fallbacks ----------------------------------------------
  // Only reached for a Claude id `CLAUDE_MODEL_RE` can't date (a bare family
  // name, or the legacy `claude-3-5-sonnet` ordering). They point at the
  // newest tier — see the file header for why.
  opus: CLAUDE_OPUS_5_5,
  sonnet: CLAUDE_SONNET_5_5,
  haiku: CLAUDE_HAIKU_5_5,
  fable: CLAUDE_FABLE_CURRENT,
  mythos: CLAUDE_FABLE_CURRENT,

  // --- OpenAI (Codex CLI) -----------------------------------------------
  // Confidence: MEDIUM-HIGH. Per-1M-token list prices (input / cached input /
  // output) as published September 2026. The >272k-token long-context
  // surcharge applies only to the models that declare it below — OpenAI does
  // not levy it across the whole GPT-5 family.
  //
  // `fastTierMultiplier` is 2, not the 1.5 this table used to carry: OpenAI
  // renamed "Priority processing" to "Fast mode" on 2026-07-30 and repriced
  // it at 2x standard.
  'gpt-5.6-terra': {
    inputPerMTokUsd: 2,
    outputPerMTokUsd: 12,
    cacheReadPerMTokUsd: 0.2,
    fastTierMultiplier: 2,
  },
  'gpt-5.6-luna': {
    inputPerMTokUsd: 0.2,
    outputPerMTokUsd: 1.2,
    cacheReadPerMTokUsd: 0.02,
    fastTierMultiplier: 2,
  },
  'gpt-5.6-sol': {
    inputPerMTokUsd: 4,
    outputPerMTokUsd: 20,
    cacheReadPerMTokUsd: 0.4,
    fastTierMultiplier: 2,
  },
  'gpt-5.5': {
    inputPerMTokUsd: 5,
    outputPerMTokUsd: 30,
    cacheReadPerMTokUsd: 0.5,
    // Same caveat as gpt-5.4: one multiplier covers both sides, so output is
    // over-estimated past the threshold.
    longContextThresholdTokens: 272_000,
    longContextMultiplier: 2,
    fastTierMultiplier: 2,
  },
  'gpt-5.4-mini': {
    inputPerMTokUsd: 0.75,
    outputPerMTokUsd: 4.5,
    cacheReadPerMTokUsd: 0.075,
    fastTierMultiplier: 2,
  },
  'gpt-5.4-nano': {
    inputPerMTokUsd: 0.2,
    outputPerMTokUsd: 1.25,
    cacheReadPerMTokUsd: 0.02,
    fastTierMultiplier: 2,
  },
  'gpt-5.4': {
    inputPerMTokUsd: 2.5,
    outputPerMTokUsd: 15,
    cacheReadPerMTokUsd: 0.25,
    // Past 272k tokens OpenAI charges 2x input but only 1.5x output.
    // `longContextMultiplier` is a single factor applied to every component,
    // so 2 is correct for input and over-estimates output by a third; the
    // alternative (1.5) would under-estimate input, which is the larger term
    // in a long-context request. Split the field if this ever needs to be exact.
    longContextThresholdTokens: 272_000,
    longContextMultiplier: 2,
    fastTierMultiplier: 2,
  },
  'gpt-5.3-codex': {
    inputPerMTokUsd: 1.75,
    outputPerMTokUsd: 14,
    cacheReadPerMTokUsd: 0.175,
    fastTierMultiplier: 2,
  },
  'gpt-5.2-codex': {
    inputPerMTokUsd: 1.75,
    outputPerMTokUsd: 14,
    cacheReadPerMTokUsd: 0.175,
    fastTierMultiplier: 2,
  },
  'gpt-5.2': {
    inputPerMTokUsd: 1.75,
    outputPerMTokUsd: 14,
    cacheReadPerMTokUsd: 0.175,
    fastTierMultiplier: 2,
  },
  'gpt-5.1-codex-mini': {
    inputPerMTokUsd: 0.25,
    outputPerMTokUsd: 2,
    cacheReadPerMTokUsd: 0.025,
    fastTierMultiplier: 2,
  },
  'gpt-5.1-codex': {
    inputPerMTokUsd: 1.25,
    outputPerMTokUsd: 10,
    cacheReadPerMTokUsd: 0.125,
    fastTierMultiplier: 2,
  },
  'gpt-5.1': {
    inputPerMTokUsd: 1.25,
    outputPerMTokUsd: 10,
    cacheReadPerMTokUsd: 0.125,
    fastTierMultiplier: 2,
  },
  'gpt-5-codex': {
    inputPerMTokUsd: 1.25,
    outputPerMTokUsd: 10,
    cacheReadPerMTokUsd: 0.125,
    longContextThresholdTokens: 272_000,
    longContextMultiplier: 2,
    fastTierMultiplier: 2,
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
    fastTierMultiplier: 2,
  },
  // --- xAI (Grok CLI) -----------------------------------------------------
  // Confidence: LOW, and NOT re-verified in the 2026-09 audit — these rates
  // are unchanged since the 2026-01 revision and do not inherit
  // `PRICING_VINTAGE`. This dev machine has no `~/.grok` install (verified
  // directly during Phase 5.4 — see grok/quota.ts's file-header CONFIDENCE
  // note), so neither the exact model id strings Grok CLI's local
  // `unified.jsonl` log records nor a live-verified rate list were
  // available. The figures below are a best-effort reading of xAI's publicly
  // documented per-token API pricing as of January 2026 — treat as more
  // uncertain than the Anthropic/OpenAI tiers above, and expect drift.
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
 * Resolves a model identifier to its pricing tier. Claude ids are matched by
 * family + parsed version first (see `CLAUDE_MODEL_RE`); everything else falls
 * back to a normalized substring match, longest/most-specific key first.
 * Returns `null` for an unrecognised model — callers must treat that as "cost
 * unknown", never as a free/zero-cost model.
 */
export function rateFor(model: string | undefined | null): ModelRate | null {
  if (!model) return null;
  const normalized = model.trim().toLowerCase();
  if (!normalized) return null;
  const claude = claudeRateFor(normalized);
  if (claude) return claude;
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
  /** 5-minute cache writes. Ignored when `cacheWrite5mTokens` is set, so a caller passing both never double-counts. */
  cacheWriteTokens?: number;
  /** 5-minute cache writes, billed at `cacheWritePerMTokUsd`; takes precedence over `cacheWriteTokens`. */
  cacheWrite5mTokens?: number;
  /** 1-hour cache writes, billed at `cacheWrite1hPerMTokUsd`. */
  cacheWrite1hTokens?: number;
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

  // `|| 0` below filters NaN (falsy) but not Infinity (truthy), which would
  // yield an Infinity cost and render as the literal "$Infinity". A token
  // count that is present but not a real number makes the cost unknown, which
  // is the same `null` this function already returns for an unpriced model.
  const present = [
    t.inputTokens,
    t.outputTokens,
    t.cacheReadTokens,
    t.cacheWriteTokens,
    t.cacheWrite5mTokens,
    t.cacheWrite1hTokens,
    t.reasoningTokens,
  ];
  if (present.some(v => v != null && !Number.isFinite(v))) return null;

  const inputTokens = Math.max(0, t.inputTokens || 0);
  const outputTokens = Math.max(0, t.outputTokens || 0);
  const cacheReadTokens = Math.max(0, t.cacheReadTokens || 0);
  const cacheWrite5mTokens = Math.max(0, (t.cacheWrite5mTokens ?? t.cacheWriteTokens) || 0);
  const cacheWrite1hTokens = Math.max(0, t.cacheWrite1hTokens || 0);
  const reasoningTokens = Math.max(0, t.reasoningTokens || 0);

  const promptTokens = inputTokens + cacheReadTokens + cacheWrite5mTokens + cacheWrite1hTokens;
  const totalTokens = promptTokens + outputTokens + reasoningTokens;
  const overLongContext =
    rate.longContextThresholdTokens != null && totalTokens > rate.longContextThresholdTokens;
  const contextMultiplier = overLongContext ? rate.longContextMultiplier ?? 1 : 1;
  const overPromptLength =
    rate.promptLengthThresholdTokens != null && promptTokens > rate.promptLengthThresholdTokens;
  const promptMultiplier = overPromptLength ? rate.promptLengthMultiplier ?? 1 : 1;
  const fastMultiplier = t.fastTier ? rate.fastTierMultiplier ?? 1 : 1;
  const multiplier = contextMultiplier * promptMultiplier * fastMultiplier;

  const cacheReadRate = rate.cacheReadPerMTokUsd ?? rate.inputPerMTokUsd;
  const cacheWriteRate = rate.cacheWritePerMTokUsd ?? rate.inputPerMTokUsd;
  const cacheWrite1hRate = rate.cacheWrite1hPerMTokUsd ?? cacheWriteRate;

  const dollars =
    (inputTokens / 1_000_000) * rate.inputPerMTokUsd * multiplier +
    (outputTokens / 1_000_000) * rate.outputPerMTokUsd * multiplier +
    (reasoningTokens / 1_000_000) * rate.outputPerMTokUsd * multiplier +
    (cacheReadTokens / 1_000_000) * cacheReadRate * multiplier +
    (cacheWrite5mTokens / 1_000_000) * cacheWriteRate * multiplier +
    (cacheWrite1hTokens / 1_000_000) * cacheWrite1hRate * multiplier;

  return Math.round(dollars * 100);
}
