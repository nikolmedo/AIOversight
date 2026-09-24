/** The slice of Electron's `globalShortcut` the popup shortcut uses, injectable for tests. */
export interface ShortcutRegistrar {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

export interface ShortcutResult {
  ok: boolean;
  reason?: string;
}

const MODIFIER_TOKENS = new Set([
  'command', 'cmd', 'control', 'ctrl', 'commandorcontrol', 'cmdorctrl',
  'alt', 'option', 'altgr', 'shift', 'super', 'meta',
]);

/**
 * The shortcut recorder's rule (`acceleratorFromKeyEvent` in
 * src/renderer/accelerator.ts), applied to a typed accelerator string: a
 * key needs Ctrl/Cmd, Alt or Super unless it is F1-F24 alone, because a
 * global Shift+letter would swallow that capital letter in every app.
 * Returns the reason a string breaks it, or `null` (also for `''`, which
 * clears the shortcut). Syntax errors are left to Electron's parser.
 *
 * Lives in main, not in a module shared with the renderer: renderer files
 * compile as non-module global scripts that main can't `require`. The
 * recorder enforces the rule on key events; this checks everything that
 * reaches `settings:setPopupShortcut`, so "Edit as text" can't bypass it.
 */
export function acceleratorRuleViolation(accelerator: string, platform: string): string | null {
  const tokens = accelerator.split('+').map(t => t.trim().toLowerCase()).filter(Boolean);
  const keys = tokens.filter(t => !MODIFIER_TOKENS.has(t));
  if (keys.length === 0) return null;
  const strong = tokens.some(t => MODIFIER_TOKENS.has(t) && t !== 'shift');
  if (strong || /^f([1-9]|1[0-9]|2[0-4])$/.test(keys[keys.length - 1])) return null;
  const needed = platform === 'darwin' ? '⌘, ⌃ or ⌥' : 'Ctrl or Alt';
  return `Include ${needed} (F1–F24 also work on their own).`;
}

/**
 * Owns the global accelerator that toggles the tray popup. Every register /
 * unregister goes through here, including the `release()` at quit and before
 * an update installs, so `registered` never drifts from what the OS holds.
 *
 * `suspend()` releases the accelerator while the settings window records a
 * new one: a registered accelerator is delivered to its global handler, not
 * to the page, so the current shortcut could not be re-recorded otherwise.
 * `resume()` re-registers it. `apply()` always ends a suspension, so a save
 * that lands before the recorder's own resume doesn't bring the old
 * accelerator back.
 */
export class PopupShortcut {
  private registered: string | null = null;
  /** Accelerator to hold while suspended; restored by `resume()`. */
  private suspendedAccelerator: string | null = null;
  private suspended = false;

  constructor(
    private readonly registrar: ShortcutRegistrar,
    private readonly onTrigger: () => void,
  ) {}

  isSuspended(): boolean {
    return this.suspended;
  }

  /**
   * Registers (or clears, for `''`) the accelerator. Never throws —
   * `globalShortcut.register` can both return `false` (already taken by
   * another application) and throw on a malformed accelerator string; both
   * come back as `{ ok: false, reason }` with a readable reason.
   */
  apply(accelerator: string | undefined): ShortcutResult {
    this.suspended = false;
    this.suspendedAccelerator = null;
    this.release();
    const trimmed = (accelerator ?? '').trim();
    if (!trimmed) return { ok: true };
    try {
      const ok = this.registrar.register(trimmed, this.onTrigger);
      if (!ok) return { ok: false, reason: 'That shortcut is already in use by another application.' };
      this.registered = trimmed;
      return { ok: true };
    } catch {
      // Electron throws a bare "conversion failure" TypeError for a string
      // its accelerator parser rejects (unknown key, non-ASCII character).
      return {
        ok: false,
        reason: 'That is not a valid shortcut. Use key names like CommandOrControl+Shift+U (ASCII only).',
      };
    }
  }

  /** Releases the accelerator until `resume()` or `apply()`. Idempotent. */
  suspend(): void {
    if (this.suspended) return;
    this.suspendedAccelerator = this.registered;
    this.suspended = true;
    this.release();
  }

  /**
   * Re-registers the accelerator held by `suspend()`. A no-op (`ok: true`)
   * when nothing is suspended. Fails when another application took the
   * accelerator in the meantime.
   */
  resume(): ShortcutResult {
    if (!this.suspended) return { ok: true };
    const accelerator = this.suspendedAccelerator;
    return this.apply(accelerator ?? '');
  }

  /** Unregisters whatever is registered. Used at quit and before an update installs, when nothing is restored. */
  release(): void {
    if (!this.registered) return;
    try {
      this.registrar.unregister(this.registered);
    } catch {
      /* best-effort */
    }
    this.registered = null;
  }
}
