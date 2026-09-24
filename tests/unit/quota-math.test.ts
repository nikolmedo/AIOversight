import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

// The renderer scripts are non-module globals (loaded with <script> tags), so
// they are not require()-able: run the compiled files in a vm context, the
// same way scripts/smoke.js does. Only function declarations are visible on
// the sandbox, not top-level `const`s.
const RENDERER_DIR = path.join(__dirname, '..', '..', 'src', 'renderer');

function loadRenderer(...files: string[]): Record<string, any> {
  const code = files.map(f => fs.readFileSync(path.join(RENDERER_DIR, f), 'utf8')).join('\n');
  const sandbox: Record<string, any> = {};
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox;
}

const H = 3_600_000;
const M = 60_000;

describe('formatCountdown', () => {
  const { formatCountdown } = loadRenderer('quota-math.js');

  it('keeps hours and minutes below 48h', () => {
    assert.equal(formatCountdown(47 * H + 59 * M), '47h 59m');
    assert.equal(formatCountdown(3 * H + 25 * M), '3h 25m');
  });

  it('switches to days and hours from 48h', () => {
    assert.equal(formatCountdown(48 * H), '2d 0h');
    assert.equal(formatCountdown(54 * H + 30 * M), '2d 6h');
    assert.equal(formatCountdown(7 * 24 * H - 1), '6d 23h');
  });

  it('handles the short end unchanged', () => {
    assert.equal(formatCountdown(0), 'now');
    assert.equal(formatCountdown(12 * M), '12m');
    assert.equal(formatCountdown(30_000), '<1m');
  });
});

describe('formatUpdatedAgo', () => {
  const { formatUpdatedAgo } = loadRenderer('quota-math.js');
  const now = 1_700_000_000_000;

  it('reads "just now" for fresh or future timestamps', () => {
    assert.equal(formatUpdatedAgo(now - 9_000, now), 'Updated just now');
    assert.equal(formatUpdatedAgo(now + 5_000, now), 'Updated just now');
  });

  it('counts seconds under a minute, then coarse relative steps', () => {
    assert.equal(formatUpdatedAgo(now - 42_000, now), 'Updated 42s ago');
    assert.equal(formatUpdatedAgo(now - 3 * M, now), 'Updated 3m ago');
    assert.equal(formatUpdatedAgo(now - 5 * H, now), 'Updated 5h ago');
  });
});

describe('projectedRemainingFraction', () => {
  const { projectedRemainingFraction } = loadRenderer('quota-math.js');
  const now = 1_700_000_000_000;
  const W = 5 * H;

  it('projects the share left at reset from the burn so far', () => {
    // Half the window gone, 40% used -> 80% projected, 20% left.
    const b = { used: 40, limit: 100, resetsAt: now + W / 2, windowMs: W };
    assert.ok(Math.abs(projectedRemainingFraction(b, now) - 0.2) < 1e-9);
  });

  it('declines to project early in the window or once it has passed', () => {
    assert.equal(projectedRemainingFraction({ used: 1, limit: 100, resetsAt: now + W - 60_000, windowMs: W }, now), null);
    assert.equal(projectedRemainingFraction({ used: 50, limit: 100, resetsAt: now - 1, windowMs: W }, now), null);
  });
});

describe('paceForecast', () => {
  const { paceForecast } = loadRenderer('quota-math.js');
  const now = 1_700_000_000_000;
  const W = 10 * H;

  it('says when a critical bucket runs out before the reset', () => {
    // 4h of 10h gone, 80% used: the last 20% goes in 1h at this rate.
    const b = { used: 80, limit: 100, resetsAt: now + 6 * H, windowMs: W };
    assert.equal(paceForecast(b, now), 'At this pace: runs out in ~1h, before reset');
  });

  it('gives the share left at reset for a warn bucket', () => {
    // Half gone, 47% used -> 94% projected (warn), ~6% left.
    const b = { used: 47, limit: 100, resetsAt: now + 5 * H, windowMs: W };
    assert.equal(paceForecast(b, now), 'At this pace: ~6% left at reset');
  });

  it('stays silent for ok, static-band, exhausted and no-data buckets', () => {
    assert.equal(paceForecast({ used: 10, limit: 100, resetsAt: now + 5 * H, windowMs: W }, now), null);
    // Critical by the static bands only: no window to project from.
    assert.equal(paceForecast({ used: 95, limit: 100 }, now), null);
    assert.equal(paceForecast({ used: 100, limit: 100, resetsAt: now + 5 * H, windowMs: W }, now), null);
    assert.equal(paceForecast({ used: null, limit: 100, resetsAt: now + 5 * H, windowMs: W }, now), null);
  });
});

describe('formatApproxDuration', () => {
  const { formatApproxDuration } = loadRenderer('quota-math.js');

  it('rounds to one coarse unit', () => {
    assert.equal(formatApproxDuration(30_000), '<1m');
    assert.equal(formatApproxDuration(40 * M), '~40m');
    assert.equal(formatApproxDuration(3 * H + 20 * M), '~3h');
    assert.equal(formatApproxDuration(5 * 24 * H), '~5d');
  });
});

describe('paceStateLabel', () => {
  const { paceStateLabel } = loadRenderer('quota-math.js');

  it('names every pace state for accessible labels', () => {
    assert.equal(paceStateLabel('ok'), 'on track');
    assert.equal(paceStateLabel('warn'), 'running high');
    assert.equal(paceStateLabel('critical'), 'critical');
    assert.equal(paceStateLabel('none'), '');
  });
});

describe('withBillingCycleReset', () => {
  const { withBillingCycleReset } = loadRenderer('quota-math.js');
  const bucket = (over: Record<string, unknown>) => ({
    id: 'b', label: 'B', used: 5, limit: 10, remaining: 5, unit: 'requests', enabled: true, ...over,
  });

  it('fills resetsAt from the cycle end for measured buckets without one', () => {
    const [b] = withBillingCycleReset([bucket({})], '2026-10-01T00:00:00Z');
    assert.equal(b.resetsAt, Date.parse('2026-10-01T00:00:00Z'));
    assert.equal(b.windowMs, undefined);
  });

  it('keeps an explicit resetsAt and skips balances and limit-less totals', () => {
    const [own, balance, total] = withBillingCycleReset(
      [bucket({ resetsAt: 42 }), bucket({ used: null }), bucket({ limit: null })],
      '2026-10-01',
    );
    assert.equal(own.resetsAt, 42);
    assert.equal(balance.resetsAt, undefined);
    assert.equal(total.resetsAt, undefined);
  });

  it('accepts a date-only string and an epoch-ms digit string', () => {
    assert.equal(withBillingCycleReset([bucket({})], '2026-10-01')[0].resetsAt, Date.parse('2026-10-01'));
    assert.equal(withBillingCycleReset([bucket({})], '1790000000000')[0].resetsAt, 1_790_000_000_000);
  });

  it('derives windowMs from the cycle start and end for metered buckets', () => {
    const [metered, own, balance, total] = withBillingCycleReset(
      [bucket({}), bucket({ resetsAt: 42 }), bucket({ used: null }), bucket({ limit: 0 })],
      '2026-10-01T00:00:00Z',
      '2026-09-01T00:00:00Z',
    );
    assert.equal(metered.resetsAt, Date.parse('2026-10-01T00:00:00Z'));
    assert.equal(metered.windowMs, 30 * 24 * H);
    assert.equal(own.windowMs, undefined);
    assert.equal(balance.windowMs, undefined);
    assert.equal(total.windowMs, undefined);
  });

  it('keeps an existing windowMs and accepts epoch-ms cycle dates', () => {
    const [kept, epoch] = withBillingCycleReset(
      [bucket({ windowMs: 5 * H }), bucket({})],
      String(1_790_000_000_000),
      String(1_790_000_000_000 - 31 * 24 * H),
    );
    assert.equal(kept.windowMs, 5 * H);
    assert.equal(epoch.windowMs, 31 * 24 * H);
  });

  it('sets no windowMs when the start is missing, unparsable or not before the end', () => {
    const end = '2026-10-01T00:00:00Z';
    assert.equal(withBillingCycleReset([bucket({})], end)[0].windowMs, undefined);
    assert.equal(withBillingCycleReset([bucket({})], end, 'soon')[0].windowMs, undefined);
    assert.equal(withBillingCycleReset([bucket({})], end, end)[0].windowMs, undefined);
    assert.equal(withBillingCycleReset([bucket({})], end, '2026-10-02T00:00:00Z')[0].windowMs, undefined);
  });

  it('turns on the pace projection for a monthly bucket', () => {
    const { paceStateFor, paceForecast } = loadRenderer('quota-math.js');
    const start = Date.parse('2026-09-01T00:00:00Z');
    const now = start + 10 * 24 * H; // a third of a 30-day cycle
    const [b] = withBillingCycleReset(
      [bucket({ used: 6, limit: 10 })],
      '2026-10-01T00:00:00Z',
      '2026-09-01T00:00:00Z',
    );
    // 60% used a third of the way in projects to 180%: critical, though the
    // static bands alone would call 60% ok.
    assert.equal(paceStateFor(b, now), 'critical');
    assert.match(paceForecast(b, now), /runs out in ~7d, before reset/);
  });

  it('returns the input unchanged for a missing or unparsable date', () => {
    const list = [bucket({})];
    assert.equal(withBillingCycleReset(list, undefined), list);
    assert.equal(withBillingCycleReset(list, 'not a date'), list);
  });
});

describe('freshnessFor', () => {
  const { freshnessFor } = loadRenderer('quota-math.js');
  const now = 1_700_000_000_000;

  it('labels the age and flags data older than twice the poll interval', () => {
    assert.deepEqual({ ...freshnessFor(now - 5 * M, 5 * M, now) }, { text: '5m ago', stale: false });
    assert.deepEqual({ ...freshnessFor(now - 11 * M, 5 * M, now) }, { text: '11m ago', stale: true });
  });

  it('never flags a connector without a known poll interval', () => {
    assert.equal(freshnessFor(now - 5 * H, undefined, now).stale, false);
  });
});
