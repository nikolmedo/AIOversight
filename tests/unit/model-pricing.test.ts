import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  MODEL_RATES,
  PRICING_VINTAGE,
  costCentsFor,
  rateFor,
} from '../../src/main/connectors/shared/model-pricing';

/** Asserts a model resolves to the given per-1M input/output list price. */
function assertRate(model: string, input: number, output: number): void {
  const rate = rateFor(model);
  assert.ok(rate, `${model} should resolve to a rate`);
  assert.equal(rate!.inputPerMTokUsd, input, `${model} input rate`);
  assert.equal(rate!.outputPerMTokUsd, output, `${model} output rate`);
}

describe('model-pricing: Anthropic version-keyed tiers', () => {
  it('prices Opus 4.5+ at the reduced $5/$25 tier', () => {
    assertRate('claude-opus-4-8', 5, 25);
    assertRate('claude-opus-4-7', 5, 25);
    assertRate('claude-opus-4-5', 5, 25);
    assertRate('claude-opus-5', 5, 25);
  });

  it('keeps the retired $15/$75 tier for Opus 4 and 4.1', () => {
    assertRate('claude-opus-4-1', 15, 75);
    assertRate('claude-opus-4', 15, 75);
  });

  it('prices Sonnet 5+ at $2/$10 and everything below it at $3/$15', () => {
    assertRate('claude-sonnet-5', 2, 10);
    assertRate('claude-sonnet-4-6', 3, 15);
    assertRate('claude-sonnet-4-5', 3, 15);
    assertRate('claude-sonnet-4', 3, 15);
  });

  it('prices Haiku 4.5+ at $1/$5 and the retired 3.5 tier at $0.80/$4', () => {
    assertRate('claude-haiku-4-5', 1, 5);
    assertRate('claude-haiku-4', 0.8, 4);
  });

  it('prices the fable and mythos families, which matched no key at all before', () => {
    assertRate('claude-fable-5-1', 10, 50);
    assertRate('claude-mythos-5-1', 10, 50);
    assert.equal(rateFor('claude-fable-5-1')!.cacheReadPerMTokUsd, 0.25);
    // 5.0 shares the token price but not the cheaper cache read.
    assertRate('claude-fable-5', 10, 50);
    assert.equal(rateFor('claude-fable-5')!.cacheReadPerMTokUsd, 1);
    assert.equal(rateFor('claude-mythos-5')!.cacheReadPerMTokUsd, 1);
  });

  it('does not mistake a trailing date snapshot for the minor version', () => {
    // The `5` in `4-5` is the minor; `20250929` is a release date. Reading the
    // date as the minor would push this into the >= 5 tier and under-bill it.
    assertRate('claude-sonnet-4-5-20250929', 3, 15);
    assertRate('claude-opus-4-1-20250805', 15, 75);
    // No minor at all, just a date: must stay at major 4, not become 4.20.
    assertRate('claude-sonnet-4-20250514', 3, 15);
  });

  it('resolves an unknown future version to the newest tier of its family, never null or the retired one', () => {
    assert.equal(rateFor('claude-opus-6'), rateFor('claude-opus-5'));
    assert.equal(rateFor('claude-sonnet-7-3'), rateFor('claude-sonnet-5'));
    assert.notEqual(rateFor('claude-opus-6')!.inputPerMTokUsd, 15);
  });

  it('matches a provider-prefixed or suffixed model id', () => {
    assertRate('opencode/claude-sonnet-4-6', 3, 15);
    assertRate('anthropic.claude-opus-4-8-v1:0', 5, 25);
  });

  it('falls back to the newest tier for a bare family name with no parseable version', () => {
    assert.equal(rateFor('opus'), rateFor('claude-opus-5'));
    assert.equal(rateFor('sonnet'), rateFor('claude-sonnet-5'));
    assert.equal(rateFor('haiku'), rateFor('claude-haiku-4-5'));
  });

  it('declares no long-context surcharge on any Claude tier', () => {
    for (const model of ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-fable-5-1']) {
      assert.equal(rateFor(model)!.longContextThresholdTokens, undefined, model);
    }
  });
});

describe('model-pricing: OpenAI key specificity', () => {
  it('resolves gpt-5.1-codex to its own entry, not the gpt-5 one', () => {
    assertRate('gpt-5.1-codex', 1.25, 10);
    // gpt-5 shares the same token prices, so identity (and the absence of
    // gpt-5's long-context surcharge) is what proves the right key won.
    assert.equal(rateFor('gpt-5.1-codex'), MODEL_RATES['gpt-5.1-codex']);
    assert.notEqual(rateFor('gpt-5.1-codex'), MODEL_RATES['gpt-5']);
    assert.equal(rateFor('gpt-5.1-codex')!.longContextThresholdTokens, undefined);
  });

  it('prefers the longest matching key across the gpt-5.1 family', () => {
    assert.equal(rateFor('gpt-5.1-codex-mini'), MODEL_RATES['gpt-5.1-codex-mini']);
    assert.equal(rateFor('gpt-5.1'), MODEL_RATES['gpt-5.1']);
    assert.equal(rateFor('gpt-5'), MODEL_RATES['gpt-5']);
    assertRate('gpt-5.1-codex-mini', 0.25, 2);
  });

  it('prices the 5.2-5.6 generations', () => {
    assertRate('gpt-5.2', 1.75, 14);
    assertRate('gpt-5.2-codex', 1.75, 14);
    assertRate('gpt-5.3-codex', 1.75, 14);
    assertRate('gpt-5.4', 2.5, 15);
    assertRate('gpt-5.4-mini', 0.75, 4.5);
    assertRate('gpt-5.4-nano', 0.2, 1.25);
    assertRate('gpt-5.5', 5, 30);
    assertRate('gpt-5.6-luna', 0.2, 1.2);
    assertRate('gpt-5.6-terra', 2, 12);
    assertRate('gpt-5.6-sol', 4, 20);
  });

  it('applies the long-context surcharge only to gpt-5.4 and gpt-5.5 among the new entries', () => {
    assert.equal(rateFor('gpt-5.4')!.longContextThresholdTokens, 272_000);
    assert.equal(rateFor('gpt-5.5')!.longContextThresholdTokens, 272_000);
    assert.equal(rateFor('gpt-5.2')!.longContextThresholdTokens, undefined);
    assert.equal(rateFor('gpt-5.6-terra')!.longContextThresholdTokens, undefined);
  });

  it('charges the fast service tier at 2x, not the old 1.5x', () => {
    assert.equal(rateFor('gpt-5.1')!.fastTierMultiplier, 2);
    assert.equal(rateFor('gpt-5-codex')!.fastTierMultiplier, 2);
    const normal = costCentsFor('gpt-5.1', { inputTokens: 1_000_000, outputTokens: 0 });
    const fast = costCentsFor('gpt-5.1', { inputTokens: 1_000_000, outputTokens: 0, fastTier: true });
    assert.equal(normal, 125);
    assert.equal(fast, 250);
  });
});

describe('model-pricing: unknown models and cost math', () => {
  it('returns null for a model it does not recognise', () => {
    assert.equal(rateFor('totally-unknown-model-xyz'), null);
    assert.equal(rateFor(''), null);
    assert.equal(rateFor(null), null);
    assert.equal(rateFor(undefined), null);
    assert.equal(costCentsFor('totally-unknown-model-xyz', { inputTokens: 1000, outputTokens: 1000 }), null);
  });

  it('computes cents from the version-keyed Anthropic rate', () => {
    // Opus 4.8: 1M input @ $5 + 1M output @ $25 = $30.00.
    assert.equal(
      costCentsFor('claude-opus-4-8', { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
      3000,
    );
    // The same call on the retired 4.1 tier costs 3x as much — the exact
    // over-billing this version-keyed table was introduced to stop.
    assert.equal(
      costCentsFor('claude-opus-4-1', { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
      9000,
    );
  });

  it('declares the pricing vintage it was verified against', () => {
    assert.equal(PRICING_VINTAGE, '2026-09');
  });

  it('returns null rather than an Infinity cost for a non-finite token count', () => {
    // Assert - an unbounded token count is an unknown cost, not a huge one.
    assert.equal(costCentsFor('claude-opus-4-8', { inputTokens: Infinity, outputTokens: 0 }), null);
    assert.equal(costCentsFor('claude-opus-4-8', { inputTokens: 0, outputTokens: NaN }), null);
    assert.equal(
      costCentsFor('claude-opus-4-8', { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: Infinity }),
      null,
    );
    // An omitted optional still means zero, not unknown.
    assert.equal(costCentsFor('claude-opus-4-8', { inputTokens: 1_000_000, outputTokens: 0 }), 500);
  });
});
