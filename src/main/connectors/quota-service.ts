import { EventEmitter } from 'events';
import {
  Connector,
  ConnectorRuntimeConfig,
  QuotaProvider,
  QuotaSnapshot,
} from './types';
import { ALL_CONNECTORS } from './registry';
import { ConnectorRuntime } from './runtime';

interface ProviderEntry {
  connector: Connector;
  provider: QuotaProvider;
  intervalMs: number;
  timer: NodeJS.Timeout | null;
  inFlight: Promise<QuotaSnapshot> | null;
  /** Reset to 0 by any successful fetch; drives the exponential backoff below. */
  consecutiveFailures: number;
  /** Epoch ms before which the periodic tick must not fetch. 0 = no gate. */
  nextAllowedFetchAt: number;
}

/**
 * Upper bound on the automatic backoff. Anthropic's Admin API docs ask
 * integrations to poll at most once a minute; a connector that keeps failing
 * shouldn't be retried faster than the vendor's own patience, but it also
 * shouldn't go dark for hours once the outage clears.
 */
const MAX_BACKOFF_MS = 30 * 60_000;

/**
 * Overall budget for one `provider.fetch()`. Connectors cap each individual
 * HTTP call at 15s, but several chain calls sequentially — github-copilot's
 * org discovery can reach ~225s, cursor ~90s — and `refreshAll()` awaits them
 * all together, so without a ceiling here one slow vendor freezes the tray
 * popup's Refresh button for minutes.
 */
const FETCH_BUDGET_MS = 45_000;

/**
 * Resolves to `null` once the budget elapses. The abandoned `op` keeps
 * running (nothing can cancel a provider mid-flight), so the caller must act
 * on the RACE result only: a late resolution is then discarded by
 * construction and can never overwrite a newer snapshot or the backoff state.
 */
function withBudget(op: Promise<QuotaSnapshot>, budgetMs: number): Promise<QuotaSnapshot | null> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), budgetMs);
  });
  // A late rejection on the abandoned branch would otherwise surface as an
  // unhandled rejection once the race has already settled on the timeout.
  op.catch(() => undefined);
  return Promise.race([op, expiry]).finally(() => clearTimeout(timer));
}

/**
 * Polls every enabled quota provider on its own cadence. Caches the most
 * recent QuotaSnapshot per connector so the renderer / tray can read instantly
 * without waiting for a network round-trip.
 *
 * Emits 'update' (id, snapshot) whenever a provider returns a new snapshot.
 */
export class QuotaService extends EventEmitter {
  private providers = new Map<string, ProviderEntry>();
  private snapshots = new Map<string, QuotaSnapshot>();

  constructor(private readonly runtime: ConnectorRuntime) {
    super();
  }

  /** Latest snapshot keyed by connector id. */
  state(): Record<string, QuotaSnapshot> {
    const out: Record<string, QuotaSnapshot> = {};
    for (const [id, snap] of this.snapshots) out[id] = snap;
    return out;
  }

  get(id: string): QuotaSnapshot | null {
    return this.snapshots.get(id) ?? null;
  }

  enabledIds(): string[] {
    return [...this.providers.keys()];
  }

  onUpdate(listener: (id: string, snapshot: QuotaSnapshot) => void): this {
    return super.on('update', listener);
  }

  async applyConfig(
    rt: ConnectorRuntimeConfig,
    globalDefaultMinutes: number,
  ): Promise<void> {
    const desired = new Set<string>();
    for (const def of ALL_CONNECTORS) {
      if (!def.quota) continue;
      if (!rt.enabled[def.id]?.quota) continue;
      desired.add(def.id);

      const cfg = this.runtime.mergeDefaults(def, rt.config[def.id] ?? {});
      const ctx = this.runtime.contextFor(def);
      const overrideMinutes = rt.pollOverrideMinutes?.[def.id];
      const minutes = pickInterval(
        overrideMinutes,
        globalDefaultMinutes,
        def.quota.defaultIntervalMinutes,
      );

      const existing = this.providers.get(def.id);
      if (existing) {
        // Recreate the provider so config / secret changes take effect.
        if (existing.timer) clearInterval(existing.timer);
        this.providers.delete(def.id);
      }

      const provider = def.quota.create(cfg, ctx);
      const intervalMs = Math.max(60_000, minutes * 60_000);
      const entry: ProviderEntry = {
        connector: def,
        provider,
        intervalMs,
        timer: null,
        inFlight: null,
        consecutiveFailures: 0,
        nextAllowedFetchAt: 0,
      };
      this.providers.set(def.id, entry);

      // Kick off an immediate fetch in the background and schedule periodic
      // refresh. We don't await it so applyConfig returns quickly.
      void this.fetchOne(def.id);
      if (minutes > 0) {
        entry.timer = setInterval(() => this.tick(def.id), intervalMs);
      }
    }

    // Drop providers no longer enabled.
    for (const [id, entry] of [...this.providers]) {
      if (!desired.has(id)) {
        if (entry.timer) clearInterval(entry.timer);
        this.providers.delete(id);
        this.snapshots.delete(id);
        this.emit('removed', id);
      }
    }
  }

  /**
   * Force-fetch a single connector now. Coalesces parallel callers.
   *
   * This is the `quota:refresh` IPC / Refresh button path, so it deliberately
   * ignores the rate-limit gate: a human asking for fresh data is not the
   * poller hammering a vendor, and silently returning a stale snapshot would
   * look like a broken button.
   */
  async refresh(id: string): Promise<QuotaSnapshot | null> {
    if (!this.providers.has(id)) return null;
    return this.fetchOne(id);
  }

  /** Force-fetch every enabled connector. Ignores the gate, same as `refresh`. */
  async refreshAll(): Promise<Record<string, QuotaSnapshot>> {
    await Promise.all([...this.providers.keys()].map(id => this.fetchOne(id)));
    return this.state();
  }

  destroy(): void {
    for (const entry of this.providers.values()) {
      if (entry.timer) clearInterval(entry.timer);
    }
    this.providers.clear();
    this.snapshots.clear();
  }

  /**
   * The scheduled-interval entry point. Unlike `refresh`, it honours the
   * backoff gate set by the previous failure and leaves the cached snapshot
   * untouched when it skips — overwriting it with a fresh error would throw
   * away the last known-good reading for no new information.
   */
  private tick(id: string): void {
    const entry = this.providers.get(id);
    if (!entry) return;
    const now = Date.now();
    if (entry.nextAllowedFetchAt > now) {
      this.runtime.log('debug', `[quota] ${id} poll skipped (backing off)`, {
        retryInMs: entry.nextAllowedFetchAt - now,
        consecutiveFailures: entry.consecutiveFailures,
      });
      return;
    }
    void this.fetchOne(id);
  }

  /**
   * Arms or clears the backoff gate. Our own exponential backoff is anchored at
   * `startedAt` so a slow request doesn't push the next allowed fetch out by its
   * own latency on top of the computed delay; a vendor-supplied `Retry-After`
   * is anchored at "now" instead, because it is relative to the response we
   * just received, not to when we asked.
   */
  private noteResult(entry: ProviderEntry, snapshot: QuotaSnapshot, startedAt: number): void {
    if (snapshot.ok) {
      entry.consecutiveFailures = 0;
      entry.nextAllowedFetchAt = 0;
      return;
    }
    entry.consecutiveFailures += 1;
    const requested = snapshot.retryAfterMs;
    entry.nextAllowedFetchAt =
      requested != null && requested > 0
        ? Date.now() + requested
        : startedAt +
          Math.min(MAX_BACKOFF_MS, entry.intervalMs * 2 ** (entry.consecutiveFailures - 1));
  }

  private async fetchOne(id: string): Promise<QuotaSnapshot> {
    const entry = this.providers.get(id);
    if (!entry) {
      return {
        ok: false,
        fetchedAt: Date.now(),
        error: 'Quota provider is not registered',
      };
    }
    if (entry.inFlight) return entry.inFlight;
    const startedAt = Date.now();
    const promise = (async () => {
      try {
        this.runtime.log('debug', `[quota] fetching ${id}`);
        const raced = await withBudget(entry.provider.fetch(), FETCH_BUDGET_MS);
        // A timeout is an ordinary failure, so it goes through the same
        // `noteResult` path as any other — the existing backoff arms for it.
        const snap: QuotaSnapshot = raced ?? {
          ok: false,
          fetchedAt: Date.now(),
          error: `Quota provider timed out after ${FETCH_BUDGET_MS / 1000}s`,
        };
        this.snapshots.set(id, snap);
        this.noteResult(entry, snap, startedAt);
        if (snap.ok) {
          this.runtime.log('info', `[quota] ${id} ok`, {
            buckets: snap.buckets.length,
            authMethod: snap.authMethod,
          });
        } else {
          this.runtime.log('warn', `[quota] ${id} failed`, { error: snap.error });
        }
        this.emit('update', id, snap);
        return snap;
      } catch (err) {
        const snap: QuotaSnapshot = {
          ok: false,
          fetchedAt: Date.now(),
          error: `Quota provider crashed: ${String(err)}`,
        };
        this.snapshots.set(id, snap);
        this.noteResult(entry, snap, startedAt);
        this.runtime.log('error', `[quota] ${id} crashed`, { err: String(err) });
        this.emit('update', id, snap);
        return snap;
      } finally {
        entry.inFlight = null;
      }
    })();
    entry.inFlight = promise;
    return promise;
  }
}

function pickInterval(
  overrideMinutes: number | undefined,
  globalDefault: number,
  connectorDefault: number,
): number {
  if (overrideMinutes != null && overrideMinutes >= 0) return overrideMinutes;
  if (globalDefault > 0) return globalDefault;
  return connectorDefault;
}
