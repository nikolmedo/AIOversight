import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import {
  AgentEvent,
  Connector,
  ConnectorContext,
  ConnectorMetadata,
  ConnectorRuntimeConfig,
  Detector,
} from './types';
import { ALL_CONNECTORS, findConnector } from './registry';
import { SecretStore } from './secret-store';

export type LogEntry = {
  ts: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  meta?: Record<string, unknown>;
};

/** Resolves `~`, `$HOME`, `%USERPROFILE%`, `%APPDATA%`, `%LOCALAPPDATA%`. */
function resolvePath(p: string): string {
  if (!p) return p;
  let result = p;
  if (result.startsWith('~')) {
    result = path.join(os.homedir(), result.slice(1));
  }
  result = result.replace(/\$HOME/g, os.homedir());
  result = result.replace(/%USERPROFILE%/gi, os.homedir());
  result = result.replace(/%APPDATA%/gi, process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'));
  result = result.replace(/%LOCALAPPDATA%/gi, process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'));
  return result;
}

/**
 * ConnectorRuntime owns the lifecycle of every connector's detector. It
 * replaces the older DetectorManager. Quota providers are owned by the
 * `QuotaService` (separate file) so the polling logic stays orthogonal to
 * notification dispatch.
 */
export class ConnectorRuntime extends EventEmitter {
  private detectors = new Map<string, Detector>();
  private logs: LogEntry[] = [];
  private static readonly MAX_LOGS = 200;

  constructor(private readonly secrets: SecretStore) {
    super();
  }

  metadata(): ConnectorMetadata[] {
    const allKeys = new Set(this.secrets.qualifiedKeys());
    return ALL_CONNECTORS.map(c => ({
      id: c.id,
      name: c.name,
      vendor: c.vendor,
      description: c.description,
      enabledByDefault: c.enabledByDefault,
      hasDetector: !!c.detector,
      hasQuota: !!c.quota,
      defaultIntervalMinutes: c.quota?.defaultIntervalMinutes,
      configSchema: c.configSchema,
      setSecretKeys: c.configSchema
        .filter(f => f.type === 'secret')
        .map(f => f.key)
        .filter(k => allKeys.has(SecretStore.qualify(c.id, k))),
    }));
  }

  log(level: LogEntry['level'], message: string, meta?: Record<string, unknown>): void {
    this.pushLog(level, message, meta);
  }

  recentLogs(): LogEntry[] {
    return [...this.logs];
  }

  onEvent(listener: (e: AgentEvent) => void): this {
    return super.on('event', listener);
  }
  onLog(listener: (entry: LogEntry) => void): this {
    return super.on('log', listener);
  }

  /**
   * Build a ConnectorContext bound to a specific connector. Used by both the
   * detector lifecycle here and the QuotaService so secrets and logs stay
   * namespaced consistently.
   */
  contextFor(connector: Connector): ConnectorContext {
    return {
      emit: partial => {
        const event: AgentEvent = {
          ...partial,
          kind: partial.kind ?? 'waiting',
          detectorId: connector.id,
          detectedAt: partial.detectedAt ?? Date.now(),
        };
        this.emit('event', event);
      },
      log: (level, message, meta) => this.pushLog(level, message, meta),
      resolvePath,
      secret: key => this.secrets.get(SecretStore.qualify(connector.id, key)),
    };
  }

  async applyConfig(rt: ConnectorRuntimeConfig): Promise<void> {
    await this.stopAllDetectors();
    for (const def of ALL_CONNECTORS) {
      if (!def.detector) continue;
      const enabled = rt.enabled[def.id]?.notifications;
      if (!enabled) continue;

      const cfg = this.mergeDefaults(def, rt.config[def.id] ?? {});
      const ctx = this.contextFor(def);
      try {
        const detector = def.detector.create(cfg, ctx);
        await detector.start();
        this.detectors.set(def.id, detector);
        this.pushLog('info', `Started detector: ${def.name}`);
      } catch (err) {
        this.pushLog('error', `Failed to start ${def.name}`, { err: String(err) });
      }
    }
  }

  async stopAllDetectors(): Promise<void> {
    const detectors = [...this.detectors.values()];
    this.detectors.clear();
    await Promise.allSettled(detectors.map(d => d.stop()));
  }

  mergeDefaults(def: Connector, cfg: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of def.configSchema) {
      // 'secret' fields are NEVER merged into the regular config — they're
      // injected on demand via ctx.secret(key) instead.
      if (field.type === 'secret') continue;
      const v = cfg[field.key];
      const isEmptyArray = Array.isArray(v) && v.length === 0 && field.type !== 'paths';
      out[field.key] =
        v === undefined || v === null || isEmptyArray ? field.default : v;
      if (field.type === 'paths' && Array.isArray(v) && v.length === 0) {
        out[field.key] = field.default;
      }
    }
    return out;
  }

  private pushLog(level: LogEntry['level'], message: string, meta?: Record<string, unknown>): void {
    const entry: LogEntry = { ts: Date.now(), level, message, meta };
    this.logs.push(entry);
    if (this.logs.length > ConnectorRuntime.MAX_LOGS) {
      this.logs.splice(0, this.logs.length - ConnectorRuntime.MAX_LOGS);
    }
    this.emit('log', entry);
  }
}

export { ALL_CONNECTORS, findConnector };
