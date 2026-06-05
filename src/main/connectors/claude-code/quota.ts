import { ConnectorContext, QuotaBucket, QuotaProvider, QuotaSnapshot } from '../types';
import { fetchClaudeUsage } from './browser-session';

interface UsageWindow {
  utilization?: number;
  resets_at?: string | number;
}

interface UsageResponse {
  five_hour?: UsageWindow;
  seven_day?: UsageWindow;
}

function formatResetsAt(raw: string | number | undefined): string | null {
  if (raw == null) return null;
  const ms = typeof raw === 'number' ? (raw > 1e10 ? raw : raw * 1000) : new Date(raw).getTime();
  if (!Number.isFinite(ms)) return null;
  const diff = ms - Date.now();
  if (diff <= 0) return 'now';
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

class ClaudeCodeQuotaProvider implements QuotaProvider {
  constructor(private readonly ctx: ConnectorContext) {}

  async fetch(): Promise<QuotaSnapshot> {
    const fetchedAt = Date.now();
    const result = await fetchClaudeUsage();

    if (result.kind === 'needs-login') {
      return {
        ok: false,
        fetchedAt,
        needsLogin: true,
        error: 'Sign in to claude.ai to see your plan usage.',
      };
    }
    if (result.kind === 'error') {
      return { ok: false, fetchedAt, error: result.message };
    }

    let parsed: UsageResponse;
    try {
      parsed = JSON.parse(result.body) as UsageResponse;
    } catch {
      return { ok: false, fetchedAt, error: 'claude.ai returned an unexpected usage response.' };
    }

    return this.toSnapshot(parsed, fetchedAt, result.url);
  }

  private toSnapshot(data: UsageResponse, fetchedAt: number, url: string): QuotaSnapshot {
    const buckets: QuotaBucket[] = [];
    const displayMessages: string[] = [];

    const addWindow = (id: string, label: string, w: UsageWindow | undefined) => {
      if (!w || typeof w.utilization !== 'number') return;
      buckets.push({
        id,
        label,
        used: w.utilization,
        limit: 100,
        remaining: Math.max(0, 100 - w.utilization),
        unit: 'requests',
        enabled: true,
      });
      const reset = formatResetsAt(w.resets_at);
      if (reset) displayMessages.push(`${label} resets in ${reset}`);
    };

    addWindow('five-hour', '5-hour limit', data.five_hour);
    addWindow('seven-day', '7-day limit', data.seven_day);

    return {
      ok: true,
      fetchedAt,
      buckets,
      membershipType: 'Claude (claude.ai)',
      displayMessages,
      authMethod: 'cookie',
      source: url,
    };
  }
}

export function createClaudeCodeQuotaProvider(
  _config: Record<string, unknown>,
  ctx: ConnectorContext,
): QuotaProvider {
  return new ClaudeCodeQuotaProvider(ctx);
}
