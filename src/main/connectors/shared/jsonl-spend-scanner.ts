import * as fs from 'fs';
import * as path from 'path';

import { SpendPeriod, SpendTile } from '../types';

const fsp = fs.promises;

/**
 * One priced usage record extracted from a single transcript/session JSONL
 * line. `costCents` is `null` when the model/line didn't yield a
 * determinable cost — never coerced to `0`.
 */
export interface SpendRecord {
  ts: number;
  costCents: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  model?: string;
}

export interface ScanOptions {
  /** Namespace for this connector's cache entries within the shared cache file (e.g. 'claude-code' | 'codex-cli'). */
  key: string;
  /** Already-resolved (no `~`/`%APPDATA%`) glob patterns supporting `*` and `**`. */
  patterns: string[];
  /** Parses one JSON-parsed transcript line into a spend record, or `null` if the line isn't spend-relevant. */
  extract(line: unknown, file: string): SpendRecord | null;
}

/** Per-day rollup persisted in the cache — NOT raw records, to keep the on-disk cache small. */
interface DayRollup {
  costCentsSum: number;
  /** True if at least one record that day contributed a determinable cost. */
  costCentsKnown: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Per-file cache entry. `scannedBytes` is the byte offset already folded
 * into `days` — a later scan reads only the delta from there (correction
 * round item 4: this file previously re-read+re-parsed a whole growing
 * session file from byte 0 on every poll).
 */
interface FileCacheEntry {
  size: number;
  mtimeMs: number;
  scannedBytes: number;
  days: Record<string, DayRollup>;
}

interface CacheFileShape {
  version: number;
  entries: Record<string, FileCacheEntry>;
}

/** Cache format version. Bumped for the item-4 rewrite (key scheme and
 * entry shape both changed) so an old-format on-disk cache is discarded
 * rather than blindly loaded under a key scheme that no longer matches. */
const CACHE_VERSION = 2;

function localDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function localMidnightMs(dayKey: string): number {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

/**
 * Correction round item 6: the local day key `daysAgo` calendar days before
 * `now`, computed via `Date` year/month/day components rather than
 * subtracting a fixed `daysAgo * 24h` millisecond offset. Fixed-ms
 * subtraction can land on the wrong local calendar day across a DST
 * transition (a 23h or 25h real day), which could make two distinct loop
 * indices resolve to the same `localDayKey` (double-counting) or alias
 * "yesterday" to "today". Constructing the date from components lets the
 * `Date` engine handle DST/month/year rollover correctly.
 */
function dayKeyOffset(now: number, daysAgo: number): string {
  const d = new Date(now);
  return localDayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysAgo).getTime());
}

function emptyRollup(): DayRollup {
  return { costCentsSum: 0, costCentsKnown: false, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function addRecordToRollup(days: Record<string, DayRollup>, record: SpendRecord): void {
  const roll = (days[localDayKey(record.ts)] ??= emptyRollup());
  if (record.costCents != null) {
    roll.costCentsSum += record.costCents;
    roll.costCentsKnown = true;
  }
  roll.inputTokens += record.inputTokens || 0;
  roll.outputTokens += record.outputTokens || 0;
  roll.cacheReadTokens += record.cacheReadTokens || 0;
  roll.cacheWriteTokens += record.cacheWriteTokens || 0;
}

/** Folds a freshly-parsed delta's per-day rollups into an existing entry's rollups in place. */
function mergeRollups(target: Record<string, DayRollup>, delta: Record<string, DayRollup>): void {
  for (const [day, d] of Object.entries(delta)) {
    const t = (target[day] ??= emptyRollup());
    t.costCentsSum += d.costCentsSum;
    t.costCentsKnown = t.costCentsKnown || d.costCentsKnown;
    t.inputTokens += d.inputTokens;
    t.outputTokens += d.outputTokens;
    t.cacheReadTokens += d.cacheReadTokens;
    t.cacheWriteTokens += d.cacheWriteTokens;
  }
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

async function walkDir(dir: string, recursive: boolean, matcher: RegExp, out: string[]): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable/missing directory -- skip, never abort the whole scan
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) await walkDir(full, recursive, matcher, out);
    } else if (entry.isFile() && matcher.test(entry.name)) {
      out.push(full);
    }
  }
}

/**
 * Minimal, dependency-free glob: supports a literal path, or a path with
 * `*`/`**`/`?` wildcards in its final segment(s). Sufficient for the
 * `<dir>/**\/*.jsonl`-shaped patterns every caller of this scanner uses.
 * A missing base directory or unreadable subdirectory yields zero matches,
 * never a thrown error.
 */
async function findMatchingFiles(pattern: string): Promise<string[]> {
  const normalized = pattern.replace(/\\/g, '/');
  const globCharsIndex = normalized.search(/[*?[]/);
  if (globCharsIndex === -1) {
    try {
      const st = await fsp.stat(pattern);
      return st.isFile() ? [path.resolve(pattern)] : [];
    } catch {
      return [];
    }
  }

  const lastSlashBeforeGlob = normalized.lastIndexOf('/', globCharsIndex);
  const baseDir = lastSlashBeforeGlob === -1 ? '.' : normalized.slice(0, lastSlashBeforeGlob);
  const rest = lastSlashBeforeGlob === -1 ? normalized : normalized.slice(lastSlashBeforeGlob + 1);
  const recursive = rest.includes('**');
  const segments = rest.split('/').filter(Boolean);
  const filenamePattern = segments[segments.length - 1] ?? '*';
  const matcher = wildcardToRegExp(filenamePattern);

  const out: string[] = [];
  try {
    const st = await fsp.stat(baseDir);
    if (st.isDirectory()) await walkDir(baseDir, recursive, matcher, out);
  } catch {
    // base directory doesn't exist -- zero matches, not an error
  }
  return out;
}

/**
 * Scans transcript/session JSONL files for priced usage, caching per-day
 * rollups keyed by `key|absPath` so an unchanged file is never re-parsed
 * and a growing file is only ever re-parsed from where the last scan left
 * off (`FileCacheEntry.scannedBytes`). One shared instance per cache root
 * (`shared()`) so two connectors reading overlapping directories don't
 * double-parse the same files.
 */
export class JsonlSpendScanner {
  private static readonly instances = new Map<string, JsonlSpendScanner>();

  private readonly cacheFile: string;
  private readonly cache = new Map<string, FileCacheEntry>();
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private loaded = false;
  private loadPromise: Promise<void> | null = null;

  private constructor(private readonly cacheDir: string) {
    this.cacheFile = path.join(cacheDir, 'spend-cache.json');
  }

  static shared(cacheDir: string): JsonlSpendScanner {
    const key = path.resolve(cacheDir);
    let inst = JsonlSpendScanner.instances.get(key);
    if (!inst) {
      inst = new JsonlSpendScanner(cacheDir);
      JsonlSpendScanner.instances.set(key, inst);
    }
    return inst;
  }

  async scan(opts: ScanOptions): Promise<SpendRecord[]> {
    await this.ensureLoaded();

    const fileSet = new Set<string>();
    for (const pattern of opts.patterns) {
      for (const f of await findMatchingFiles(pattern)) fileSet.add(path.resolve(f));
    }

    const out: SpendRecord[] = [];
    let cacheDirty = false;

    for (const file of fileSet) {
      let stat: fs.Stats;
      try {
        stat = await fsp.stat(file);
      } catch {
        continue; // file disappeared between listing and stat -- skip
      }
      const cacheKey = `${opts.key}|${file}`;
      let entry = this.cache.get(cacheKey);
      // Shrunk, or mtime moved backwards -- the file was rotated/replaced;
      // incremental byte-offset state can't be trusted, start over.
      if (entry && (stat.size < entry.scannedBytes || stat.mtimeMs < entry.mtimeMs)) entry = undefined;

      if (!entry) {
        const { rollups, consumedBytes } = await this.parseRange(file, opts, 0, stat.size);
        entry = { size: stat.size, mtimeMs: stat.mtimeMs, scannedBytes: consumedBytes, days: rollups };
        this.cache.set(cacheKey, entry);
        cacheDirty = true;
      } else if (stat.size > entry.scannedBytes || stat.mtimeMs !== entry.mtimeMs) {
        const { rollups, consumedBytes } = await this.parseRange(file, opts, entry.scannedBytes, stat.size);
        mergeRollups(entry.days, rollups);
        entry.scannedBytes += consumedBytes;
        entry.size = stat.size;
        entry.mtimeMs = stat.mtimeMs;
        cacheDirty = true;
      }

      for (const [dayKey, roll] of Object.entries(entry.days)) {
        out.push({
          ts: localMidnightMs(dayKey),
          costCents: roll.costCentsKnown ? roll.costCentsSum : null,
          inputTokens: roll.inputTokens,
          outputTokens: roll.outputTokens,
          cacheReadTokens: roll.cacheReadTokens,
          cacheWriteTokens: roll.cacheWriteTokens,
        });
      }
    }

    // Correction item 5: a file that no longer matches the glob (deleted,
    // rotated, archived) previously left its cache entry permanently
    // resident -- prune anything under this scan's `key` namespace whose
    // file path isn't in the current `fileSet`.
    const prefix = `${opts.key}|`;
    for (const k of this.cache.keys()) {
      if (k.startsWith(prefix) && !fileSet.has(k.slice(prefix.length))) {
        this.cache.delete(k);
        cacheDirty = true;
      }
    }

    if (cacheDirty) this.scheduleWrite();
    return out;
  }

  /**
   * Rolls a flat `SpendRecord[]` (as returned by `scan()`, already
   * day-collapsed per file) up into Today/Yesterday/Last-30d tiles in LOCAL
   * time, with a 30-entry oldest->newest series. A period with zero
   * matching records is `costCents: null` / `tokens: null` -- never `0`.
   */
  aggregate(records: SpendRecord[], now: number): SpendTile[] {
    const perDay = new Map<string, { costCents: number; costKnown: boolean; tokens: number }>();
    for (const r of records) {
      if (!Number.isFinite(r.ts)) continue;
      const key = localDayKey(r.ts);
      const tokens = (r.inputTokens || 0) + (r.outputTokens || 0) + (r.cacheReadTokens || 0) + (r.cacheWriteTokens || 0);
      const entry = perDay.get(key) ?? { costCents: 0, costKnown: false, tokens: 0 };
      if (r.costCents != null) {
        entry.costCents += r.costCents;
        entry.costKnown = true;
      }
      entry.tokens += tokens;
      perDay.set(key, entry);
    }

    const series: Array<number | null> = [];
    for (let i = 29; i >= 0; i--) {
      const entry = perDay.get(dayKeyOffset(now, i));
      series.push(entry ? (entry.costKnown ? entry.costCents : null) : null);
    }

    const tileFor = (key: string, period: SpendPeriod, label: string): SpendTile => {
      const entry = perDay.get(key);
      if (!entry) return { period, label, costCents: null, tokens: null };
      return { period, label, costCents: entry.costKnown ? entry.costCents : null, tokens: entry.tokens };
    };

    let last30dCents = 0;
    let last30dCostKnown = false;
    let last30dTokens = 0;
    let last30dHasAny = false;
    for (let i = 0; i < 30; i++) {
      const entry = perDay.get(dayKeyOffset(now, i));
      if (!entry) continue;
      last30dHasAny = true;
      if (entry.costKnown) {
        last30dCents += entry.costCents;
        last30dCostKnown = true;
      }
      last30dTokens += entry.tokens;
    }

    return [
      tileFor(dayKeyOffset(now, 0), 'today', 'Today'),
      tileFor(dayKeyOffset(now, 1), 'yesterday', 'Yesterday'),
      {
        period: 'last30d',
        label: 'Last 30 days',
        costCents: last30dHasAny ? (last30dCostKnown ? last30dCents : null) : null,
        tokens: last30dHasAny ? last30dTokens : null,
        series,
      },
    ];
  }

  /** Forces any pending debounced cache write to disk immediately. Safe to call on app shutdown. */
  flushSync(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = null;
    this.writeSync();
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) this.loadPromise = this.load();
    await this.loadPromise;
  }

  private async load(): Promise<void> {
    try {
      const raw = await fsp.readFile(this.cacheFile, 'utf8');
      const parsed = JSON.parse(raw) as Partial<CacheFileShape> | null;
      if (parsed && parsed.version === CACHE_VERSION && parsed.entries && typeof parsed.entries === 'object') {
        for (const [k, v] of Object.entries(parsed.entries)) {
          if (v && typeof v === 'object') this.cache.set(k, v);
        }
      }
    } catch {
      // missing/corrupt/old-format cache file -- start empty, never throw
    } finally {
      this.loaded = true;
    }
  }

  /**
   * Reads and parses only the byte range `[startByte, totalSize)` of `file`,
   * returning per-day rollups for that range plus how many bytes of it were
   * actually consumed. A trailing partial line (the file is still being
   * appended to) is left unconsumed for the next scan rather than parsed
   * early -- `consumedBytes` only ever covers whole lines.
   */
  private async parseRange(
    file: string,
    opts: ScanOptions,
    startByte: number,
    totalSize: number,
  ): Promise<{ rollups: Record<string, DayRollup>; consumedBytes: number }> {
    const rollups: Record<string, DayRollup> = {};
    if (totalSize <= startByte) return { rollups, consumedBytes: 0 };

    let text: string;
    try {
      text = await this.readRange(file, startByte);
    } catch {
      return { rollups, consumedBytes: 0 }; // unreadable -- treat as "no new records", never abort the scan
    }

    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline === -1) return { rollups, consumedBytes: 0 };
    const usable = text.slice(0, lastNewline);
    const consumedBytes = Buffer.byteLength(text.slice(0, lastNewline + 1), 'utf8');

    for (const line of usable.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue; // malformed line -- skip, keep scanning
      }

      let record: SpendRecord | null;
      try {
        record = opts.extract(parsed, file);
      } catch {
        continue; // a throwing extract() must not abort the whole file/scan
      }
      if (!record || !Number.isFinite(record.ts)) continue;
      addRecordToRollup(rollups, record);
    }

    return { rollups, consumedBytes };
  }

  private readRange(file: string, startByte: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = fs.createReadStream(file, { start: startByte });
      stream.on('data', c => chunks.push(c as Buffer));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    });
  }

  private scheduleWrite(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.writeSync();
    }, 500);
    if (typeof this.writeTimer.unref === 'function') this.writeTimer.unref();
  }

  private writeSync(): void {
    try {
      if (!fs.existsSync(this.cacheDir)) fs.mkdirSync(this.cacheDir, { recursive: true });
      const body: CacheFileShape = { version: CACHE_VERSION, entries: Object.fromEntries(this.cache) };
      fs.writeFileSync(this.cacheFile, JSON.stringify(body), 'utf8');
    } catch {
      // best-effort -- a failed cache write must never break spend scanning
    }
  }
}
