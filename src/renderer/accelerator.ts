// Keyboard-shortcut recorder logic for the settings window. Non-module global
// script (like quota-math.ts): pure functions, no DOM access, loaded before
// settings.js and unit-tested by running the compiled file in a vm context.
//
// Builds Electron accelerator strings
// (https://www.electronjs.org/docs/latest/api/accelerator) from keydown
// events and formats stored accelerators for display.

/** The subset of `KeyboardEvent` the recorder reads, so tests can pass plain objects. */
interface AcceleratorKeyInput {
  code: string;
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

type AcceleratorRecordResult =
  /** Only modifiers held so far: keep listening. */
  | { kind: 'pending' }
  /** Let the browser handle the key (Tab moves focus). */
  | { kind: 'pass' }
  /** Escape: stop recording, keep the stored shortcut. */
  | { kind: 'cancel' }
  /** Backspace / Delete without modifiers: remove the shortcut. */
  | { kind: 'clear' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'accelerator'; accelerator: string };

const ACCELERATOR_MODIFIER_CODES = new Set([
  'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight',
  'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight', 'CapsLock', 'Fn', 'FnLock',
]);

const ACCELERATOR_NAMED_CODES: Record<string, string> = {
  Space: 'Space', Enter: 'Enter', NumpadEnter: 'Enter',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert',
  Backspace: 'Backspace', Delete: 'Delete', PrintScreen: 'PrintScreen',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
};

/**
 * Electron key name for a physical key (`KeyboardEvent.code`), or `null` when
 * the key can't be part of an accelerator. `code` rather than `key`, because
 * Shift and macOS Option change `key` ("Shift+1" reports "!").
 */
function acceleratorKeyForCode(code: string): string | null {
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  m = /^Digit([0-9])$/.exec(code);
  if (m) return m[1];
  m = /^Numpad([0-9])$/.exec(code);
  if (m) return `num${m[1]}`;
  m = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code);
  if (m) return `F${m[1]}`;
  return ACCELERATOR_NAMED_CODES[code] ?? null;
}

/**
 * Turns one keydown into a recorder step. Modifier mapping follows each
 * platform's primary key: Cmd on macOS and Ctrl elsewhere become
 * `CommandOrControl`, so a shortcut stored on one OS keeps working on the
 * other. A shortcut needs Ctrl/Cmd, Alt or Super unless it is F1-F24 alone:
 * a global Shift+letter would swallow that capital letter in every app.
 */
function acceleratorFromKeyEvent(e: AcceleratorKeyInput, platform: string): AcceleratorRecordResult {
  const mac = platform === 'darwin';
  const noModifiers = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
  if (e.code === 'Escape' || e.key === 'Escape') return { kind: 'cancel' };
  if (e.code === 'Tab' || e.key === 'Tab') return { kind: 'pass' };
  if ((e.code === 'Backspace' || e.code === 'Delete') && noModifiers) return { kind: 'clear' };
  if (ACCELERATOR_MODIFIER_CODES.has(e.code) || ['Control', 'Shift', 'Alt', 'Meta', 'OS'].includes(e.key)) {
    return { kind: 'pending' };
  }

  const key = acceleratorKeyForCode(e.code);
  if (!key) return { kind: 'invalid', reason: 'That key cannot be used in a shortcut.' };

  const parts: string[] = [];
  if (mac ? e.metaKey : e.ctrlKey) parts.push('CommandOrControl');
  if (mac && e.ctrlKey) parts.push('Control');
  if (!mac && e.metaKey) parts.push('Super');
  if (e.altKey) parts.push('Alt');
  const hasStrongModifier = parts.length > 0;
  if (e.shiftKey) parts.push('Shift');

  if (!hasStrongModifier && !/^F\d+$/.test(key)) {
    const needed = mac ? '⌘, ⌃ or ⌥' : 'Ctrl or Alt';
    return { kind: 'invalid', reason: `Include ${needed} (F1–F24 also work on their own).` };
  }
  parts.push(key);
  return { kind: 'accelerator', accelerator: parts.join('+') };
}

/**
 * Human form of a stored accelerator: "Ctrl+Shift+U" on Windows/Linux,
 * "⌘⇧U" on macOS. Accepts every modifier alias Electron does, since older
 * builds stored the shortcut as free text. `''` stays `''`.
 */
function formatAccelerator(accelerator: string, platform: string): string {
  const mac = platform === 'darwin';
  const tokens = accelerator.split('+').map(t => t.trim()).filter(Boolean);
  if (tokens.length === 0) return '';
  const names = tokens.map(token => {
    switch (token.toLowerCase()) {
      case 'commandorcontrol':
      case 'cmdorctrl':
        return mac ? '⌘' : 'Ctrl';
      case 'command':
      case 'cmd':
        return mac ? '⌘' : 'Cmd';
      case 'control':
      case 'ctrl':
        return mac ? '⌃' : 'Ctrl';
      case 'alt':
      case 'option':
        return mac ? '⌥' : 'Alt';
      case 'altgr':
        return 'AltGr';
      case 'shift':
        return mac ? '⇧' : 'Shift';
      case 'super':
      case 'meta':
        return mac ? '⌘' : platform === 'win32' ? 'Win' : 'Super';
      case 'up':
        return '↑';
      case 'down':
        return '↓';
      case 'left':
        return '←';
      case 'right':
        return '→';
      default: {
        const num = /^num(\d)$/i.exec(token);
        if (num) return `Num ${num[1]}`;
        return token.length === 1 ? token.toUpperCase() : token;
      }
    }
  });
  return names.join(mac ? '' : '+');
}
