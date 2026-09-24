import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

// accelerator.ts is a non-module renderer script: run the compiled file in a
// vm context and read its function declarations off the sandbox.
const RENDERER_DIR = path.join(__dirname, '..', '..', 'src', 'renderer');

function loadAccelerator(): Record<string, any> {
  const sandbox: Record<string, any> = {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(RENDERER_DIR, 'accelerator.js'), 'utf8'), sandbox);
  return sandbox;
}

const { acceleratorFromKeyEvent, formatAccelerator } = loadAccelerator();

function key(code: string, mods: Partial<Record<'ctrl' | 'meta' | 'alt' | 'shift', boolean>> = {}, keyValue = ''): unknown {
  return {
    code,
    key: keyValue || code,
    ctrlKey: !!mods.ctrl,
    metaKey: !!mods.meta,
    altKey: !!mods.alt,
    shiftKey: !!mods.shift,
  };
}

// vm results come from another realm, so compare plain copies.
const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

describe('acceleratorFromKeyEvent', () => {
  it('maps Ctrl on Windows/Linux and Cmd on macOS to CommandOrControl', () => {
    assert.deepEqual(plain(acceleratorFromKeyEvent(key('KeyU', { ctrl: true, shift: true }), 'win32')), {
      kind: 'accelerator',
      accelerator: 'CommandOrControl+Shift+U',
    });
    assert.deepEqual(plain(acceleratorFromKeyEvent(key('KeyU', { meta: true, shift: true }), 'darwin')), {
      kind: 'accelerator',
      accelerator: 'CommandOrControl+Shift+U',
    });
  });

  it('keeps macOS Control and Windows/Linux Super as their own modifiers', () => {
    assert.equal(acceleratorFromKeyEvent(key('KeyK', { ctrl: true, alt: true }), 'darwin').accelerator, 'Control+Alt+K');
    assert.equal(acceleratorFromKeyEvent(key('KeyK', { meta: true }), 'linux').accelerator, 'Super+K');
  });

  it('reads the physical key, not the shifted character', () => {
    const result = acceleratorFromKeyEvent(key('Digit1', { ctrl: true, shift: true }, '!'), 'win32');
    assert.equal(result.accelerator, 'CommandOrControl+Shift+1');
  });

  it('maps arrows, punctuation, numpad and function keys to Electron names', () => {
    assert.equal(acceleratorFromKeyEvent(key('ArrowUp', { alt: true }), 'win32').accelerator, 'Alt+Up');
    assert.equal(acceleratorFromKeyEvent(key('Slash', { ctrl: true }), 'win32').accelerator, 'CommandOrControl+/');
    assert.equal(acceleratorFromKeyEvent(key('Numpad5', { ctrl: true }), 'win32').accelerator, 'CommandOrControl+num5');
    assert.equal(acceleratorFromKeyEvent(key('F24', { shift: true }), 'win32').accelerator, 'Shift+F24');
  });

  it('accepts a bare function key', () => {
    assert.deepEqual(plain(acceleratorFromKeyEvent(key('F9'), 'win32')), { kind: 'accelerator', accelerator: 'F9' });
  });

  it('rejects a letter without Ctrl/Cmd, Alt or Super, even with Shift', () => {
    assert.equal(acceleratorFromKeyEvent(key('KeyA'), 'win32').kind, 'invalid');
    assert.equal(acceleratorFromKeyEvent(key('KeyA', { shift: true }), 'darwin').kind, 'invalid');
  });

  it('waits while only modifiers are held', () => {
    assert.equal(acceleratorFromKeyEvent(key('ControlLeft', { ctrl: true }, 'Control'), 'win32').kind, 'pending');
    assert.equal(acceleratorFromKeyEvent(key('ShiftRight', { shift: true }, 'Shift'), 'darwin').kind, 'pending');
  });

  it('treats Escape as cancel, Tab as pass-through and bare Backspace/Delete as clear', () => {
    assert.equal(acceleratorFromKeyEvent(key('Escape', { ctrl: true }), 'win32').kind, 'cancel');
    assert.equal(acceleratorFromKeyEvent(key('Tab', { shift: true }), 'win32').kind, 'pass');
    assert.equal(acceleratorFromKeyEvent(key('Backspace'), 'win32').kind, 'clear');
    assert.equal(acceleratorFromKeyEvent(key('Delete'), 'darwin').kind, 'clear');
  });

  it('lets Delete with a modifier be part of a shortcut', () => {
    assert.equal(acceleratorFromKeyEvent(key('Delete', { ctrl: true, alt: true }), 'win32').accelerator, 'CommandOrControl+Alt+Delete');
  });

  it('rejects keys with no accelerator name', () => {
    assert.equal(acceleratorFromKeyEvent(key('IntlBackslash', { ctrl: true }), 'win32').kind, 'invalid');
  });
});

describe('formatAccelerator', () => {
  it('uses Ctrl and plus signs on Windows/Linux', () => {
    assert.equal(formatAccelerator('CommandOrControl+Shift+U', 'win32'), 'Ctrl+Shift+U');
    assert.equal(formatAccelerator('Super+Alt+K', 'win32'), 'Win+Alt+K');
    assert.equal(formatAccelerator('Super+K', 'linux'), 'Super+K');
  });

  it('uses macOS symbols without separators', () => {
    assert.equal(formatAccelerator('CommandOrControl+Shift+U', 'darwin'), '⌘⇧U');
    assert.equal(formatAccelerator('Control+Option+Up', 'darwin'), '⌃⌥↑');
  });

  it('accepts legacy free-text aliases and lower-case keys', () => {
    assert.equal(formatAccelerator('CmdOrCtrl+alt+p', 'win32'), 'Ctrl+Alt+P');
    assert.equal(formatAccelerator('ctrl+num0', 'linux'), 'Ctrl+Num 0');
  });

  it('returns an empty string when no shortcut is set', () => {
    assert.equal(formatAccelerator('', 'win32'), '');
  });
});
