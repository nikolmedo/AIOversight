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

describe('connectorColor', () => {
  const { connectorColor, connectorColorIn } = loadRenderer('quota-math.js', 'quota-view.js');

  it('falls back to a categorical palette token, never an arbitrary hue', () => {
    for (const id of ['claude-code', 'codex-cli', 'cursor', 'zai', 'opencode', 'grok', 'devin']) {
      assert.match(connectorColor(id), /^var\(--cat-[1-6]\)$/);
    }
  });

  it('is deterministic per id', () => {
    assert.equal(connectorColor('cursor'), connectorColor('cursor'));
  });

  it('uses the registry index when given, wrapping around the palette', () => {
    assert.equal(connectorColor('a', undefined, 0), 'var(--cat-1)');
    assert.equal(connectorColor('a', undefined, 5), 'var(--cat-6)');
    assert.equal(connectorColor('a', undefined, 6), 'var(--cat-1)');
  });

  it('keeps a well-formed brandColor and rejects a malformed one', () => {
    assert.equal(connectorColor('a', '#ff0000', 2), '#ff0000');
    assert.equal(connectorColor('a', '"><b>', 2), 'var(--cat-3)');
  });

  it('assigns spend colors among spend-reporting providers only', () => {
    const { spendColorFor } = loadRenderer('quota-math.js', 'quota-view.js');
    // Registry positions 2 and 8 would share slot 3 with registry-wide indices.
    const list = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, name: `C${i}` }));
    const spend = [{ period: 'today', label: 'Today', costCents: 1, tokens: 1 }];
    const snap = { ok: true, fetchedAt: 0, buckets: [], displayMessages: [], spend };
    const colorFor = spendColorFor({ c2: snap, c8: snap }, list);
    assert.equal(colorFor('c2'), 'var(--cat-1)');
    assert.equal(colorFor('c8'), 'var(--cat-2)');
  });

  it('gives the first providers in the list distinct slots', () => {
    const list = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => ({ id, name: id }));
    const colors = list.map(c => connectorColorIn(c.id, list));
    assert.equal(new Set(colors).size, 6);
  });
});
