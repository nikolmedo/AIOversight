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
      };
      this.providers.set(def.id, entry);

      // Kick off an immediate fetch in the background and schedule periodic
      // refresh. We don't await it so applyConfig returns quickly.
      void this.fetchOne(def.id);
      if (minutes > 0) {
        entry.timer = setInterval(() => void this.fetchOne(def.id), intervalMs);
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

  /** Force-fetch a single connector now. Coalesces parallel callers. */
  async refresh(id: string): Promise<QuotaSnapshot | null> {
    if (!this.providers.has(id)) return null;
    return this.fetchOne(id);
  }

  /** Force-fetch every enabled connector. */
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
    const promise = (async () => {
      try {
        this.runtime.log('debug', `[quota] fetching ${id}`);
        const snap = await entry.provider.fetch();
        this.snapshots.set(id, snap);
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
