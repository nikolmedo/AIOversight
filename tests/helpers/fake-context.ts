import { AgentEvent, ConnectorContext, EventKind } from '../../src/main/connectors/types';
import { LogEntry } from '../../src/main/connectors/runtime';

/**
 * Fake `ConnectorContext` for unit tests. Mirrors the shape `ConnectorRuntime`
 * builds in `contextFor()` (see scripts/smoke.js's `makeCtx` for the
 * historical headless-test equivalent).
 */
export interface FakeConnectorContext extends ConnectorContext {
  emitted: Array<Omit<AgentEvent, 'detectorId' | 'detectedAt' | 'kind'> & {
    detectedAt?: number;
    kind?: EventKind;
  }>;
  logs: LogEntry[];
  secrets: Map<string, string>;
}

export interface FakeContextOptions {
  resolvePath?: (p: string) => string;
  secrets?: Record<string, string>;
}

export function createFakeContext(opts: FakeContextOptions = {}): FakeConnectorContext {
  const emitted: FakeConnectorContext['emitted'] = [];
  const logs: LogEntry[] = [];
  const secrets = new Map<string, string>(Object.entries(opts.secrets ?? {}));

  return {
    emitted,
    logs,
    secrets,
    emit(event) {
      emitted.push(event);
    },
    log(level, message, meta) {
      logs.push({ ts: Date.now(), level, message, meta });
    },
    resolvePath: opts.resolvePath ?? (p => p),
    secret(key) {
      return secrets.get(key) ?? null;
    },
    setSecret(key, value) {
      secrets.set(key, value);
    },
  };
}
