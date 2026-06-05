import * as path from 'path';
import { Notification, shell } from 'electron';
import { AgentEvent, EventKind } from './connectors/types';
import { SettingsStore } from './settings-store';

export type NotifyResult =
  | { shown: true }
  | {
      shown: false;
      reason: 'cooldown' | 'disabled' | 'disabled-kind' | 'quiet-hours' | 'unsupported';
    };

type Logger = (
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  meta?: Record<string, unknown>,
) => void;

/**
 * Owns notification policy: cooldowns, quiet hours, OS-level Notification
 * dispatch. Detectors emit at-will; we shape the firehose into something
 * the user actually wants to see.
 *
 * Each suppression reason is logged so the Logs tab can explain to the user
 * why an event didn't pop a toast (the most common dev-time gotcha is the
 * macOS notification permission for "Electron" being denied).
 *
 * Cooldown is keyed on `(sessionId, kind)` so a single conversation can fire
 * its 'waiting' toast and, separately, its 'finished' toast without one
 * suppressing the other.
 */
export class Notifier {
  private readonly recent = new Map<string, number>();
  private readonly iconPath: string;

  constructor(
    private readonly settings: SettingsStore,
    private readonly log: Logger = () => {},
  ) {
    this.iconPath = path.join(__dirname, '..', '..', 'assets', 'icon.png');
  }

  handle(event: AgentEvent): NotifyResult {
    const cfg = this.settings.get();
    const cooldownKey = `${event.sessionId}::${event.kind}`;

    const last = this.recent.get(cooldownKey) ?? 0;
    const since = event.detectedAt - last;
    if (since < cfg.perSessionCooldownMs) {
      this.log('debug', '[notifier] suppressed (cooldown)', {
        sessionId: event.sessionId,
        kind: event.kind,
        sinceMs: since,
      });
      return { shown: false, reason: 'cooldown' };
    }
    this.recent.set(cooldownKey, event.detectedAt);

    this.settings.pushEvent({
      ts: event.detectedAt,
      agent: event.agent,
      sessionId: event.sessionId,
      message: event.message,
      kind: event.kind,
      source: event.source,
    });

    if (!cfg.showNotifications) {
      this.log('info', '[notifier] suppressed (notifications disabled in settings)');
      return { shown: false, reason: 'disabled' };
    }
    if (event.kind === 'waiting' && !cfg.notifyOnWaiting) {
      this.log('info', '[notifier] suppressed (notifyOnWaiting=false)');
      return { shown: false, reason: 'disabled-kind' };
    }
    if (event.kind === 'finished' && !cfg.notifyOnFinished) {
      this.log('info', '[notifier] suppressed (notifyOnFinished=false)');
      return { shown: false, reason: 'disabled-kind' };
    }
    if (this.inQuietHours(cfg.quietHours, new Date(event.detectedAt))) {
      this.log('info', '[notifier] suppressed (quiet hours)');
      return { shown: false, reason: 'quiet-hours' };
    }
    if (!Notification.isSupported()) {
      this.log('warn', '[notifier] OS reports notifications are not supported');
      return { shown: false, reason: 'unsupported' };
    }

    const note = new Notification({
      title: event.title ?? defaultTitle(event.kind, event.agent),
      body: event.message,
      // 'finished' is informational; don't make a sound. 'waiting' is a
      // soft block on the user's work, so it does play the system sound.
      silent: event.kind === 'finished',
      icon: this.iconPath,
    });
    note.on('show', () =>
      this.log('info', `[notifier] shown (${event.kind}): ${event.agent} — ${event.message}`),
    );
    note.on('failed', (_e, err) =>
      this.log('error', '[notifier] OS rejected notification', { err: String(err) }),
    );
    note.on('click', () => {
      if (event.source) shell.showItemInFolder(event.source);
    });
    try {
      note.show();
    } catch (err) {
      this.log('error', '[notifier] threw on show()', { err: String(err) });
      return { shown: false, reason: 'unsupported' };
    }
    return { shown: true };
  }

  private inQuietHours(window: { startHour: number; endHour: number } | null, now: Date): boolean {
    if (!window) return false;
    const hour = now.getHours();
    const { startHour, endHour } = window;
    if (startHour === endHour) return false;
    // Wrap-around (e.g. 22 -> 7).
    if (startHour < endHour) return hour >= startHour && hour < endHour;
    return hour >= startHour || hour < endHour;
  }
}

function defaultTitle(kind: EventKind, agent: string): string {
  return kind === 'finished' ? `${agent} finished` : `${agent} is waiting for you`;
}
