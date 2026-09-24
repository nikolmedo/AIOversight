// Keyboard-shortcut recorder logic for the settings window. Non-module global
// script (like quota-math.ts): pure functions, no DOM access, loaded before
// settings.js and unit-tested by running the compiled file in a vm context.
//
// Builds Electron accelerator strings
// (https://www.electronjs.org/docs/latest/tutorial/keyboard-shortcuts) from
// keydown events and formats stored accelerators for display.

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
 * `KeyboardEvent.code` -> the character that key types on the active layout,
 * unshifted (`navigator.keyboard.getLayoutMap()` in the renderer; a plain
 * `Map` in tests).
 */
interface AcceleratorLayoutMap {
  get(code: string): string | undefined;
}

/**
 * Punctuation Windows defines by the character it types on every layout
 * (`VK_OEM_COMMA`, `VK_OEM_MINUS`, `VK_OEM_PERIOD`). The other `VK_OEM_*`
 * keys "can vary by keyboard", so Electron's `;` / `[` / `` ` `` ... only name
 * the key that types them where the layout agrees with US QWERTY.
 */
const ACCELERATOR_LAYOUT_SAFE_PUNCTUATION = new Set([',', '-', '.']);

/**
 * Characters Electron's accelerator parser maps to a key without adding
 * Shift (`KeyboardCodeFromCharCode` in shell/common/keyboard_util.cc). `+`,
 * `!`, `:` and the other shifted US characters imply Shift there, so a
 * layout that types them unshifted can't be recorded as a character.
 */
const ACCELERATOR_UNSHIFTED_PUNCTUATION = new Set([',', '-', '.', '/', ';', '=', '[', ']', '\\', "'", '`']);

/**
 * Electron key name for a physical key (`KeyboardEvent.code`) as if the
 * layout were US QWERTY, or `null` when the key can't be part of an
 * accelerator.
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

/** Whether `code` is a key that types a character (letters and punctuation, not digits or the numpad). */
function isLayoutCharacterCode(code: string): boolean {
  return /^Key[A-Z]$/.test(code) || code === 'IntlBackslash' || /^[^0-9]$/.test(ACCELERATOR_NAMED_CODES[code] ?? '');
}

/**
 * The unshifted character the key types on the user's layout: the layout
 * map when there is one, else `e.key` when it can't have been changed by
 * Shift or Alt/AltGr/Option (a letter's case doesn't matter). `null` when
 * neither is usable, in which case the US-QWERTY name of the code applies.
 */
function layoutCharacter(e: AcceleratorKeyInput, layout: AcceleratorLayoutMap | null | undefined): string | null {
  const mapped = layout?.get(e.code);
  if (typeof mapped === 'string' && mapped.length === 1) return mapped;
  if (e.key.length !== 1) return null;
  if (/^[a-z]$/i.test(e.key)) return e.key;
  return e.shiftKey || e.altKey ? null : e.key;
}

type AcceleratorKeyResult = { key: string } | { invalid: string };

/**
 * Electron key name for the key in `e`. Windows and Linux resolve an
 * accelerator's character through the active layout, so a character key is
 * named by what it types there (AZERTY's `KeyQ` records "A"). macOS
 * `globalShortcut` ignores the layout and matches US-QWERTY key positions
 * (electron/electron#19747), so there the physical key (`code`) is recorded,
 * which keeps working on the key the user pressed. The digit row, numpad,
 * F-keys, arrows and other named keys always use `code`: Windows digit
 * virtual keys are positional, and AZERTY's unshifted "&" would parse as
 * Shift+7.
 */
function acceleratorKeyFor(
  e: AcceleratorKeyInput,
  platform: string,
  layout: AcceleratorLayoutMap | null | undefined,
): AcceleratorKeyResult | null {
  const usKey = acceleratorKeyForCode(e.code);
  if (platform === 'darwin' || !isLayoutCharacterCode(e.code)) return usKey ? { key: usKey } : null;

  const ch = layoutCharacter(e, layout);
  if (ch == null) return usKey ? { key: usKey } : null;
  if (/^[a-z]$/i.test(ch)) return { key: ch.toUpperCase() };
  if (ACCELERATOR_LAYOUT_SAFE_PUNCTUATION.has(ch) || ch === usKey) return { key: ch };
  // X11 looks a keysym up in the active layout, so Linux takes any
  // unshifted punctuation Electron can parse.
  if (platform === 'linux' && ACCELERATOR_UNSHIFTED_PUNCTUATION.has(ch)) return { key: ch };
  // A letter key typing a non-Latin character (Cyrillic, Greek): Windows and
  // X11 keep US-QWERTY letters on those keys.
  if (/^Key[A-Z]$/.test(e.code) && !/^[\x20-\x7e]$/.test(ch)) return { key: usKey! };
  return { invalid: `The “${ch}” key can't be used in a shortcut on this keyboard layout. Try a letter, a digit or F1–F24.` };
}

/**
 * Turns one keydown into a recorder step. Modifier mapping follows each
 * platform's primary key: Cmd on macOS and Ctrl elsewhere become
 * `CommandOrControl`, so a shortcut stored on one OS keeps working on the
 * other. A shortcut needs Ctrl/Cmd, Alt or Super unless it is F1-F24 alone:
 * a global Shift+letter would swallow that capital letter in every app.
 * `layout` names character keys by what they type on the user's layout
 * (see `acceleratorKeyFor`).
 */
function acceleratorFromKeyEvent(
  e: AcceleratorKeyInput,
  platform: string,
  layout?: AcceleratorLayoutMap | null,
): AcceleratorRecordResult {
  const mac = platform === 'darwin';
  const noModifiers = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
  if (e.code === 'Escape' || e.key === 'Escape') return { kind: 'cancel' };
  if (e.code === 'Tab' || e.key === 'Tab') return { kind: 'pass' };
  if ((e.code === 'Backspace' || e.code === 'Delete') && noModifiers) return { kind: 'clear' };
  if (ACCELERATOR_MODIFIER_CODES.has(e.code) || ['Control', 'Shift', 'Alt', 'Meta', 'OS'].includes(e.key)) {
    return { kind: 'pending' };
  }

  const resolved = acceleratorKeyFor(e, platform, layout);
  if (!resolved) return { kind: 'invalid', reason: 'That key cannot be used in a shortcut.' };
  if ('invalid' in resolved) return { kind: 'invalid', reason: resolved.invalid };
  const key = resolved.key;

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
