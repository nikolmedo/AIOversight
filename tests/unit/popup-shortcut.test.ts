import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { PopupShortcut, ShortcutRegistrar } from '../../src/main/popup-shortcut';

/** Records what is registered; `taken` accelerators fail like another app holds them. */
function fakeRegistrar(taken: Set<string> = new Set()): ShortcutRegistrar & { held: Set<string>; calls: string[] } {
  const held = new Set<string>();
  const calls: string[] = [];
  return {
    held,
    calls,
    register(accelerator) {
      calls.push(`register ${accelerator}`);
      if (accelerator === 'bad') throw new TypeError('conversion failure');
      if (taken.has(accelerator) || held.has(accelerator)) return false;
      held.add(accelerator);
      return true;
    },
    unregister(accelerator) {
      calls.push(`unregister ${accelerator}`);
      held.delete(accelerator);
    },
  };
}

describe('PopupShortcut', () => {
  it('registers a trimmed accelerator and replaces the previous one', () => {
    const reg = fakeRegistrar();
    const shortcut = new PopupShortcut(reg, () => {});

    assert.deepEqual(shortcut.apply(' Alt+K '), { ok: true });
    assert.deepEqual(shortcut.apply('Alt+J'), { ok: true });

    assert.deepEqual([...reg.held], ['Alt+J']);
    assert.equal(shortcut.current(), 'Alt+J');
  });

  it('reports a taken or malformed accelerator without throwing', () => {
    const shortcut = new PopupShortcut(fakeRegistrar(new Set(['Alt+K'])), () => {});

    assert.equal(shortcut.apply('Alt+K').ok, false);
    assert.match(shortcut.apply('bad').reason ?? '', /not a valid shortcut/);
    assert.equal(shortcut.current(), null);
  });

  it('suspends and resumes the current accelerator', () => {
    const reg = fakeRegistrar();
    const shortcut = new PopupShortcut(reg, () => {});
    shortcut.apply('Alt+K');

    shortcut.suspend();
    assert.equal(reg.held.size, 0);
    assert.equal(shortcut.isSuspended(), true);

    assert.deepEqual(shortcut.resume(), { ok: true });
    assert.deepEqual([...reg.held], ['Alt+K']);
    assert.equal(shortcut.isSuspended(), false);
  });

  it('treats a repeated suspend as one and resume without a suspend as a no-op', () => {
    const reg = fakeRegistrar();
    const shortcut = new PopupShortcut(reg, () => {});
    shortcut.apply('Alt+K');

    shortcut.suspend();
    shortcut.suspend();
    shortcut.resume();
    const before = reg.calls.length;
    assert.deepEqual(shortcut.resume(), { ok: true });

    assert.equal(reg.calls.length, before);
    assert.deepEqual([...reg.held], ['Alt+K']);
  });

  it('does not bring the old accelerator back when a save lands before the resume', () => {
    const reg = fakeRegistrar();
    const shortcut = new PopupShortcut(reg, () => {});
    shortcut.apply('Alt+K');

    shortcut.suspend();
    shortcut.apply('Alt+J');
    assert.deepEqual(shortcut.resume(), { ok: true });

    assert.deepEqual([...reg.held], ['Alt+J']);
  });

  it('fails the resume when another application took the accelerator meanwhile', () => {
    const taken = new Set<string>();
    const reg = fakeRegistrar(taken);
    const shortcut = new PopupShortcut(reg, () => {});
    shortcut.apply('Alt+K');

    shortcut.suspend();
    taken.add('Alt+K');
    const result = shortcut.resume();

    assert.equal(result.ok, false);
    assert.equal(shortcut.current(), null);
    assert.equal(shortcut.isSuspended(), false);
  });

  it('suspends with nothing registered and resumes to nothing', () => {
    const reg = fakeRegistrar();
    const shortcut = new PopupShortcut(reg, () => {});

    shortcut.suspend();
    assert.deepEqual(shortcut.resume(), { ok: true });
    assert.equal(reg.calls.length, 0);
  });

  it('calls the trigger through the registered callback', () => {
    let fired = 0;
    let callback: (() => void) | null = null;
    const shortcut = new PopupShortcut(
      { register: (_a, cb) => ((callback = cb), true), unregister: () => {} },
      () => fired++,
    );
    shortcut.apply('Alt+K');
    callback!();
    assert.equal(fired, 1);
  });
});
