import * as fs from 'fs';
import * as path from 'path';
import chokidar, { FSWatcher } from 'chokidar';
import { ConnectorContext, Detector, EventKind, LineStatus } from '../types';

/**
 * Generic JSONL transcript watcher used by every connector that watches
 * agent transcripts (Cursor, Claude Code, Codex CLI, custom JSONL).
 *
 * Heuristic: every transcript file is tailed. After N seconds of inactivity,
 * we look at the *last* JSON line and classify it via the connector-supplied
 * `extractStatus` hook:
 *   - 'pending' (assistant turn with a tool_use awaiting result) or
 *     'tool' (orphan tool result) -> emit kind: 'waiting'.
 *   - 'final' (assistant text response with no pending tool) -> emit
 *     kind: 'finished'.
 *   - 'user' or 'unknown' -> nothing fires.
 *
 * We dedup on (file, mtime, kind) so a session's pending->final transition
 * fires both notifications, but the same idle pending state never re-notifies.
 */
export interface TranscriptWatcherOptions {
  agentName: string;
  detectorId: string;
  patterns: string[];
  idleMs: number;
  extractStatus(line: unknown): LineStatus;
  extractSnippet?(line: unknown): string | undefined;
}

interface FileState {
  size: number;
  lastMtime: number;
  lastChange: number;
  lastStatus: LineStatus;
  lastSnippet?: string;
  notifiedAtMtimeByKind: Partial<Record<EventKind, number>>;
}

export class TranscriptWatcher implements Detector {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly state = new Map<string, FileState>();

  constructor(
    public readonly opts: TranscriptWatcherOptions,
    private readonly ctx: ConnectorContext,
  ) {}

  start(): void {
    const patterns = this.opts.patterns.map(p => this.ctx.resolvePath(p));
    this.ctx.log('info', `[${this.opts.detectorId}] watching`, { patterns });
    // chokidar's macOS fsevents backend does NOT reliably emit `change` for
    // streaming O_APPEND writers (which is exactly how every agent transcript
    // is produced). Polling every 250 ms is cheap and gives us deterministic
    // change detection across macOS, Windows, and remote / network mounts.
    this.watcher = chokidar.watch(patterns, {
      persistent: true,
      ignoreInitial: false,
      atomic: false,
      usePolling: true,
      interval: 250,
      binaryInterval: 1000,
    });
    this.watcher.on('add', p => this.onChange(p, /* initial */ true));
    this.watcher.on('change', p => this.onChange(p, false));
    this.watcher.on('unlink', p => this.state.delete(p));
    this.watcher.on('error', err =>
      this.ctx.log('warn', `[${this.opts.detectorId}] watch error`, { err: String(err) }),
    );

    const sweepEvery = Math.max(1000, Math.min(10_000, Math.floor(this.opts.idleMs / 2)));
    this.timer = setInterval(() => this.sweep(), sweepEvery);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.watcher) await this.watcher.close();
    this.watcher = null;
    this.state.clear();
  }

  private onChange(file: string, initial: boolean): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return;
    }
    const prev = this.state.get(file);
    const prevSize = prev?.size ?? 0;
    const newSize = stat.size;
    const startAt = prev ? prevSize : Math.max(0, newSize - 64 * 1024);

    let lastLine: string | undefined;
    if (newSize > startAt) {
      try {
        const fd = fs.openSync(file, 'r');
        const len = newSize - startAt;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, startAt);
        fs.closeSync(fd);
        const text = buf.toString('utf8');
        const lines = text.split('\n').filter(l => l.trim().length > 0);
        lastLine = lines[lines.length - 1];
      } catch (err) {
        this.ctx.log('debug', `[${this.opts.detectorId}] read failed`, { file, err: String(err) });
      }
    }

    let status: LineStatus = prev?.lastStatus ?? 'unknown';
    let snippet = prev?.lastSnippet;
    if (lastLine) {
      try {
        const parsed = JSON.parse(lastLine);
        status = this.opts.extractStatus(parsed);
        snippet = this.opts.extractSnippet?.(parsed) ?? snippet;
      } catch {
        // Malformed last line -- ignore, keep previous status.
      }
    }

    // On the very first observation, mark both kinds as already-notified at
    // the current mtime so we don't spam notifications at startup for stale
    // sessions sitting on disk.
    const notifiedAtMtimeByKind: FileState['notifiedAtMtimeByKind'] = initial
      ? { waiting: stat.mtimeMs, finished: stat.mtimeMs }
      : { ...(prev?.notifiedAtMtimeByKind ?? {}) };

    this.state.set(file, {
      size: newSize,
      lastMtime: stat.mtimeMs,
      lastChange: Date.now(),
      lastStatus: status,
      lastSnippet: snippet,
      notifiedAtMtimeByKind,
    });
  }

  private sweep(): void {
    const now = Date.now();
    for (const [file, st] of this.state) {
      const idle = now - st.lastChange;
      if (idle < this.opts.idleMs) continue;

      const kind = kindForStatus(st.lastStatus);
      if (!kind) continue;
      if (st.notifiedAtMtimeByKind[kind] === st.lastMtime) continue;

      st.notifiedAtMtimeByKind[kind] = st.lastMtime;
      const sessionId = path.basename(file, path.extname(file));
      this.ctx.emit({
        sessionId: `${this.opts.detectorId}:${sessionId}`,
        agent: this.opts.agentName,
        kind,
        message: st.lastSnippet
          ? truncate(st.lastSnippet, 140)
          : kind === 'finished'
            ? `Session ${shortId(sessionId)} finished after ${Math.round(idle / 1000)}s of quiet.`
            : `Session ${shortId(sessionId)} has been idle for ${Math.round(idle / 1000)}s.`,
        source: file,
      });
    }
  }
}

export function kindForStatus(s: LineStatus): EventKind | null {
  if (s === 'pending' || s === 'tool') return 'waiting';
  if (s === 'final') return 'finished';
  return null;
}

export function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…';
}

export function shortId(s: string): string {
  return s.length > 10 ? s.slice(0, 8) : s;
}
