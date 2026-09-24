import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

// Same loading scheme as quota-math.test.ts: the renderer scripts are
// non-module globals, so run the compiled files in a vm context. quota-view
// depends on quota-math's globals, so both are loaded together. Only function
// declarations are visible on the sandbox, not top-level `const`s.
const RENDERER_DIR = path.join(__dirname, '..', '..', 'src', 'renderer');
// tokens.css is not compiled into dist-test; read it from the source tree.
const TOKENS_CSS = path.join(__dirname, '..', '..', '..', 'src', 'renderer', 'tokens.css');

function loadView(): Record<string, any> {
  const code = ['quota-math.js', 'quota-view.js']
    .map(f => fs.readFileSync(path.join(RENDERER_DIR, f), 'utf8'))
    .join('\n');
  const sandbox: Record<string, any> = {};
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox;
}

const H = 3_600_000;
const NOW = 1_700_000_000_000;

function bucket(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'b', label: 'Session', used: 40, limit: 100, remaining: 60, unit: 'requests', enabled: true, ...over };
}

function okSnap(buckets: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ok: true, fetchedAt: NOW, buckets, displayMessages: [], ...extra };
}

describe('connectorColor', () => {
  const { connectorColor } = loadView();

  it('falls back to a categorical palette token, never an arbitrary hue', () => {
    for (const id of ['claude-code', 'codex-cli', 'cursor', 'zai', 'opencode', 'grok', 'devin']) {
      assert.match(connectorColor(id), /^var\(--cat-[1-6]\)$/);
    }
  });

  it('is deterministic per id', () => {
    assert.equal(connectorColor('cursor'), connectorColor('cursor'));
  });

  it('uses the slot index when given, wrapping around the palette', () => {
    assert.equal(connectorColor('a', undefined, 0), 'var(--cat-1)');
    assert.equal(connectorColor('a', undefined, 5), 'var(--cat-6)');
    assert.equal(connectorColor('a', undefined, 6), 'var(--cat-1)');
  });

  it('keeps a well-formed brandColor and rejects a malformed one', () => {
    assert.equal(connectorColor('a', '#ff0000', 2), '#ff0000');
    assert.equal(connectorColor('a', '"><b>', 2), 'var(--cat-3)');
  });

  it('wraps at the number of --cat-N tokens tokens.css defines', () => {
    const css = fs.readFileSync(TOKENS_CSS, 'utf8');
    const slots = new Set(Array.from(css.matchAll(/--cat-(\d+)\s*:/g), m => Number(m[1])));
    assert.equal(connectorColor('a', undefined, slots.size - 1), `var(--cat-${slots.size})`);
    assert.equal(connectorColor('a', undefined, slots.size), 'var(--cat-1)');
  });
});

describe('spendColorFor', () => {
  const { spendColorFor } = loadView();
  // Registry positions 2 and 8 would share slot 3 with registry-wide indices.
  const list = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, name: `C${i}`, reportsSpend: i === 2 || i === 8 }));

  it('assigns slots in order among the connectors that report spend', () => {
    const colorFor = spendColorFor(list);
    assert.equal(colorFor('c2'), 'var(--cat-1)');
    assert.equal(colorFor('c8'), 'var(--cat-2)');
  });

  it('depends on static metadata only, not on which snapshots are ok', () => {
    // The signature takes no snapshots at all; the same list gives the same
    // colors however the providers are doing at runtime.
    assert.equal(spendColorFor.length, 1);
    assert.equal(spendColorFor(list)('c8'), spendColorFor(list)('c8'));
  });

  it('gives the shipped spend connectors distinct colors', () => {
    const ids = ['cursor', 'anthropic', 'claude-code', 'openai', 'codex-cli', 'github-copilot', 'openrouter', 'zai', 'opencode', 'grok'];
    const spend = new Set(['cursor', 'claude-code', 'codex-cli', 'opencode', 'grok']);
    const defs = ids.map(id => ({ id, name: id, reportsSpend: spend.has(id) }));
    const colorFor = spendColorFor(defs);
    assert.equal(new Set([...spend].map(colorFor)).size, spend.size);
  });

  it('falls back to the id hash for a connector without the flag', () => {
    const { connectorColor } = loadView();
    assert.equal(spendColorFor(list)('c3'), connectorColor('c3'));
  });
});

describe('renderSparkline', () => {
  const { renderSparkline, sumDailySeries } = loadView();

  it('draws one bar per day with spend and hides the SVG from assistive tech', () => {
    const html = renderSparkline([null, 0, 100, 300]);
    assert.equal((html.match(/<rect /g) ?? []).length, 2);
    assert.match(html, /<svg class="sparkline"[^>]* aria-hidden="true"/);
    assert.match(html, /<span class="sr-only">Daily cost, last 4 days: \$4\.00 total, peak \$3\.00, spend on 2 of 4 days<\/span>/);
  });

  it('scales the tallest bar to the full height', () => {
    const html = renderSparkline([100, 400], { height: 16 });
    assert.match(html, /y="0" width="\d+" height="16"/);
  });

  it('renders nothing without a positive day', () => {
    assert.equal(renderSparkline([]), '');
    assert.equal(renderSparkline([null, 0]), '');
  });

  it('applies an explicit color through style', () => {
    assert.match(renderSparkline([5], { color: 'var(--cat-2)' }), /style="color:var\(--cat-2\)"/);
  });

  it('sums series day by day, aligned on the newest day, keeping all-null days null', () => {
    assert.deepEqual([...sumDailySeries([[1, null, 3], [null, 5]])], [1, null, 8]);
    assert.deepEqual([...sumDailySeries([[null], [null]])], [null]);
  });
});

describe('spend views with a 30-day series', () => {
  const { renderSpendSummary, renderTotalSpendCard } = loadView();
  const connectors = [{ id: 'x', name: 'X', reportsSpend: true }];
  const spend = [
    { period: 'today', label: 'Today', costCents: 100, tokens: 10 },
    { period: 'last30d', label: '30 days', costCents: 400, tokens: 40, series: [100, null, 300] },
  ];
  const snapshots = { x: okSnap([], { spend }) };

  it('puts the aggregate trend in the Overview 30-day cell in cost mode only', () => {
    const cost = renderSpendSummary(snapshots, connectors, { mode: 'cost', period: 'today' });
    assert.match(cost, /data-spend-period="last30d"[\s\S]*class="sparkline"/);
    const tokens = renderSpendSummary(snapshots, connectors, { mode: 'tokens', period: 'today' });
    assert.ok(!tokens.includes('sparkline'));
  });

  it('puts per-provider trends in the popup legend for the 30-day cost view only', () => {
    assert.match(renderTotalSpendCard(snapshots, connectors, { mode: 'cost', period: 'last30d' }), /spend-legend-trend/);
    assert.ok(!renderTotalSpendCard(snapshots, connectors, { mode: 'cost', period: 'today' }).includes('sparkline'));
  });
});

describe('renderMeterRow', () => {
  const { renderMeterRow } = loadView();

  it('exposes the bar as a labelled progressbar with the used share and pace state', () => {
    const html = renderMeterRow(bucket({ used: 84 }), undefined, { now: NOW });
    assert.match(html, /role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="84"/);
    assert.match(html, /aria-label="Session: 84% used, running high"/);
    assert.match(html, /class="meter-pct warn">84% used</);
  });

  it('adds the forecast line for a pace-projected warn/critical bucket', () => {
    const b = bucket({ used: 80, resetsAt: NOW + 6 * H, windowMs: 10 * H });
    assert.match(renderMeterRow(b, undefined, { now: NOW }), /class="meter-forecast critical">At this pace: runs out in ~1h, before reset</);
    assert.ok(!renderMeterRow(bucket({ used: 10 }), undefined, { now: NOW }).includes('meter-forecast'));
  });

  it('makes menu-targetable rows tab stops', () => {
    assert.match(renderMeterRow(bucket(), undefined, { now: NOW, connectorId: 'c' }), /data-connector-id="c" tabindex="0"/);
    assert.ok(!renderMeterRow(bucket(), undefined, { now: NOW }).includes('tabindex'));
  });

  it('keys the reset chip by connector and bucket, not by timestamp', () => {
    const html = renderMeterRow(bucket({ resetsAt: NOW + H }), undefined, { now: NOW, connectorId: 'c' });
    assert.match(html, /data-chip-key="c:b"/);
  });
});

describe('planTrayPopup', () => {
  const { planTrayPopup } = loadView();
  const def = (id: string) => ({ id, name: id.toUpperCase(), quotaEnabled: true });
  const defs = ['ok', 'none', 'crit', 'warn', 'err', 'ok2'].map(def);
  const quotas = {
    ok: okSnap([bucket({ used: 10 })]),
    none: okSnap([bucket({ used: null, limit: null })]),
    crit: okSnap([bucket({ used: 10 }), bucket({ id: 'c', used: 95 })]),
    warn: okSnap([bucket({ used: 80 })]),
    err: { ok: false, fetchedAt: NOW, error: 'boom' },
    ok2: okSnap([bucket({ used: 20 })]),
  };

  it('orders providers critical > warn > ok > no data, ties in registry order', () => {
    const plan = planTrayPopup(defs, quotas, undefined, NOW);
    assert.deepEqual(plan.visible.map((d: { id: string }) => d.id), ['crit', 'warn', 'ok', 'ok2', 'none', 'err']);
  });

  it('ignores hidden buckets when ranking', () => {
    const plan = planTrayPopup(defs, quotas, { crit: { c: { hidden: true } } }, NOW);
    assert.deepEqual(plan.visible.map((d: { id: string }) => d.id).slice(0, 2), ['warn', 'ok']);
  });
});

describe('planTrayPopup billing-cycle pace', () => {
  const { planTrayPopup } = loadView();
  const def = (id: string) => ({ id, name: id, quotaEnabled: true });

  it('ranks a monthly bucket by its cycle pace, as its row is coloured', () => {
    // 60% used a third of the way through a 30-day cycle projects past 100%.
    const start = NOW - 10 * 24 * H;
    const end = start + 30 * 24 * H;
    const quotas = {
      steady: okSnap([bucket({ used: 70 })]),
      monthly: okSnap([bucket({ used: 60 })], {
        billingCycleStart: new Date(start).toISOString(),
        billingCycleEnd: new Date(end).toISOString(),
      }),
    };
    const plan = planTrayPopup([def('steady'), def('monthly')], quotas, undefined, NOW);
    assert.deepEqual(plan.visible.map((d: { id: string }) => d.id), ['monthly', 'steady']);
  });
});

describe('renderProviderBlock freshness', () => {
  const { renderProviderBlock } = loadView();
  const def = { id: 'c', name: 'C', quotaEnabled: true };

  it('shows a muted age label, flagged stale past twice the poll interval', () => {
    const fresh = renderProviderBlock(def, { ...okSnap([]), fetchedAt: NOW - 5 * 60_000 }, undefined, { now: NOW, pollIntervalMs: 5 * 60_000 });
    assert.match(fresh, /class="provider-updated" data-fetched-at="\d+" data-interval-ms="300000"[^>]*>5m ago</);
    const stale = renderProviderBlock(def, { ...okSnap([]), fetchedAt: NOW - 11 * 60_000 }, undefined, { now: NOW, pollIntervalMs: 5 * 60_000 });
    assert.match(stale, /class="provider-updated stale"[^>]*>11m ago<span class="sr-only">, out of date<\/span>/);
  });

  it('shows no age label on an error snapshot', () => {
    const html = renderProviderBlock(def, { ok: false, fetchedAt: NOW, error: 'boom' }, undefined, { now: NOW });
    assert.ok(!html.includes('provider-updated'));
  });

  it('uses billingCycleEnd as the reset time for buckets without one', () => {
    const end = '2023-12-01T00:00:00Z';
    const html = renderProviderBlock(def, okSnap([bucket()], { billingCycleEnd: end }), undefined, { now: NOW });
    assert.match(html, new RegExp(`data-resets-at="${Date.parse(end)}"`));
  });
});
