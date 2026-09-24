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

describe('acceleratorFromKeyEvent with a keyboard layout', () => {
  // Unshifted characters per KeyboardEvent.code, as navigator.keyboard.getLayoutMap() reports them.
  const AZERTY = new Map([
    ['KeyQ', 'a'], ['KeyA', 'q'], ['KeyW', 'z'], ['KeyZ', 'w'], ['Semicolon', 'm'], ['KeyM', ','],
    ['Comma', ';'], ['Period', ':'], ['Slash', '!'], ['Digit1', '&'], ['Digit2', 'é'], ['Minus', ')'], ['Equal', '='],
  ]);
  const SPANISH = new Map([['Semicolon', 'ñ'], ['Slash', '-'], ['Quote', '´'], ['KeyU', 'u']]);
  const RUSSIAN = new Map([['KeyQ', 'й'], ['KeyU', 'г']]);
  const accel = (code: string, platform: string, layout: unknown, mods = { ctrl: true, alt: true }, keyValue = '') =>
    acceleratorFromKeyEvent(key(code, mods, keyValue), platform, layout);

  it('records the letter the layout types on Windows and Linux', () => {
    assert.equal(accel('KeyQ', 'win32', AZERTY).accelerator, 'CommandOrControl+Alt+A');
    assert.equal(accel('Semicolon', 'linux', AZERTY).accelerator, 'CommandOrControl+Alt+M');
    assert.equal(accel('KeyU', 'win32', SPANISH).accelerator, 'CommandOrControl+Alt+U');
  });

  it('keeps the physical key on macOS, whose global shortcuts ignore the layout', () => {
    assert.equal(accel('KeyQ', 'darwin', AZERTY, { meta: true, alt: true } as never).accelerator, 'CommandOrControl+Alt+Q');
  });

  it('keeps digits positional, so AZERTY "&" does not become Shift+7', () => {
    assert.equal(accel('Digit1', 'win32', AZERTY).accelerator, 'CommandOrControl+Alt+1');
    assert.equal(accel('Digit2', 'linux', AZERTY).accelerator, 'CommandOrControl+Alt+2');
  });

  it('records punctuation Windows names by character on every layout', () => {
    assert.equal(accel('KeyM', 'win32', AZERTY).accelerator, 'CommandOrControl+Alt+,');
    assert.equal(accel('Slash', 'win32', SPANISH).accelerator, 'CommandOrControl+Alt+-');
    assert.equal(accel('Equal', 'win32', AZERTY).accelerator, 'CommandOrControl+Alt+=');
  });

  it('takes other unshifted punctuation on Linux only', () => {
    assert.equal(accel('Comma', 'linux', AZERTY).accelerator, 'CommandOrControl+Alt+;');
    assert.equal(accel('Comma', 'win32', AZERTY).kind, 'invalid');
  });

  it('rejects characters Electron cannot parse or would read as Shift+key', () => {
    const spanish = accel('Semicolon', 'win32', SPANISH);
    assert.equal(spanish.kind, 'invalid');
    assert.match(spanish.reason, /“ñ”/);
    assert.equal(accel('Slash', 'linux', AZERTY).kind, 'invalid');
    assert.equal(accel('Period', 'linux', AZERTY).kind, 'invalid');
    assert.equal(accel('Minus', 'win32', AZERTY).kind, 'invalid');
  });

  it('falls back to the US letter on a non-Latin layout', () => {
    assert.equal(accel('KeyQ', 'win32', RUSSIAN).accelerator, 'CommandOrControl+Alt+Q');
    assert.equal(accel('KeyU', 'linux', RUSSIAN).accelerator, 'CommandOrControl+Alt+U');
  });

  it('uses the unshifted event key without a layout map, and the code after that', () => {
    assert.equal(accel('KeyQ', 'win32', null, { ctrl: true } as never, 'a').accelerator, 'CommandOrControl+A');
    assert.equal(accel('KeyQ', 'win32', null, { ctrl: true, shift: true } as never, 'A').accelerator, 'CommandOrControl+Shift+A');
    assert.equal(accel('KeyM', 'win32', null, { ctrl: true } as never, ',').accelerator, 'CommandOrControl+,');
    // Shifted "?" says nothing about the unshifted key: fall back to the code.
    assert.equal(accel('KeyM', 'win32', null, { ctrl: true, shift: true } as never, '?').accelerator, 'CommandOrControl+Shift+M');
    assert.equal(accel('Slash', 'win32', undefined, { ctrl: true, alt: true }, '/').accelerator, 'CommandOrControl+Alt+/');
  });

  it('keeps named keys code-based whatever the layout says', () => {
    assert.equal(accel('Space', 'win32', AZERTY, { ctrl: true } as never, ' ').accelerator, 'CommandOrControl+Space');
    assert.equal(accel('Numpad1', 'win32', AZERTY).accelerator, 'CommandOrControl+Alt+num1');
    assert.equal(accel('F5', 'linux', AZERTY, {} as never).accelerator, 'F5');
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
