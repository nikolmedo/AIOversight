import { ConnectorContext, QuotaBucket, QuotaProvider, QuotaSnapshot } from '../types';

/**
 * GitHub Copilot quota provider.
 *
 * GitHub deprecated the `/copilot/usage` endpoint in 2025 in favour of
 * `/copilot/metrics`. This provider:
 *
 *   1. Tries the **org** path first (`/orgs/{slug}/...`).
 *   2. If that returns 404 (and the user hasn't pinned a slug type), falls
 *      back to the **enterprise** path (`/enterprises/{slug}/...`).
 *   3. Surfaces aggregated usage metrics + active seat counts when available.
 *
 * Auth: classic PAT with `manage_billing:copilot` (and `read:org` /
 * `read:enterprise` for the matching scope), or a fine-grained token with
 * the equivalent permissions on the target org.
 */

type SlugType = 'org' | 'enterprise' | 'auto';

type Endpoint = 'metrics' | 'billing' | 'usage';

function endpointUrl(slugType: 'org' | 'enterprise', slug: string, endpoint: Endpoint): string {
  const base =
    slugType === 'org'
      ? `https://api.github.com/orgs/${encodeURIComponent(slug)}`
      : `https://api.github.com/enterprises/${encodeURIComponent(slug)}`;
  return `${base}/copilot/${endpoint}`;
}

async function httpsGetJson(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; json: unknown; raw: string }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { net } = require('electron') as typeof import('electron');
    if (net?.fetch) {
      const res = await net.fetch(url, { headers });
      const txt = await res.text();
      try {
        return { status: res.status, json: txt ? JSON.parse(txt) : {}, raw: txt };
      } catch {
        return { status: res.status, json: {}, raw: txt };
      }
    }
  } catch {
    // fall through to Node https
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const https = require('https') as typeof import('https');
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: res.statusCode ?? 0, json: body ? JSON.parse(body) : {}, raw: body });
        } catch {
          resolve({ status: res.statusCode ?? 0, json: {}, raw: body });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error('GitHub API timeout')));
  });
}

class CopilotQuotaProvider implements QuotaProvider {
  private cfg: Record<string, unknown> = {};
  constructor(private readonly ctx: ConnectorContext) {}
  setConfig(cfg: Record<string, unknown>): void {
    this.cfg = cfg;
  }

  async fetch(): Promise<QuotaSnapshot> {
    const fetchedAt = Date.now();
    const pat = this.ctx.secret('githubPat');
    const slug = (this.cfg.org as string | undefined)?.trim();
    const requested = ((this.cfg.slugType as string | undefined) ?? 'auto') as SlugType;

    if (!pat) {
      return {
        ok: false,
        fetchedAt,
        error:
          'No GitHub PAT set. Create a token with `manage_billing:copilot` (+ `read:org` for org slugs, `read:enterprise` for enterprise slugs) and paste it below.',
      };
    }
    if (!slug) {
      return {
        ok: false,
        fetchedAt,
        error:
          'No GitHub slug configured. GitHub does not expose per-user Copilot quota for individual plans — set an org or enterprise slug you administer.',
      };
    }

    const headers = {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'aioversight',
    };

    // Decide which slug types to probe.
    const candidateTypes: Array<'org' | 'enterprise'> =
      requested === 'org'
        ? ['org']
        : requested === 'enterprise'
          ? ['enterprise']
          : ['org', 'enterprise'];

    const attempts: string[] = [];
    let firstError: string | null = null;

    for (const slugType of candidateTypes) {
      this.ctx.log('debug', `[copilot] trying ${slugType} ${slug}`);
      const probe = await this.fetchFor(slugType, slug, headers, attempts, fetchedAt);
      if (probe) return probe;
      // probe is null means 404 (try the next type) or a recoverable miss.
      // If a hard error already happened, fetchFor returns the snapshot directly.
      if (!firstError) {
        firstError = `Tried ${attempts[attempts.length - 1]} → 404`;
      }
    }

    return {
      ok: false,
      fetchedAt,
      error: this.buildNotFoundMessage(slug, requested, attempts),
    };
  }

  /**
   * Tries the {metrics, billing} pair for one slug type. Returns:
   *   - ok snapshot on success.
   *   - error snapshot on a hard failure (auth / 5xx).
   *   - null on 404 so the caller can try the next slug type.
   */
  private async fetchFor(
    slugType: 'org' | 'enterprise',
    slug: string,
    headers: Record<string, string>,
    attempts: string[],
    fetchedAt: number,
  ): Promise<QuotaSnapshot | null> {
    // Metrics is the modern endpoint. Older PATs may only see /usage; we fall
    // back to it on 404 from /metrics specifically.
    const metricsUrl = endpointUrl(slugType, slug, 'metrics');
    attempts.push(metricsUrl);
    const metrics = await httpsGetJson(metricsUrl, headers);

    if (metrics.status === 401 || metrics.status === 403) {
      return {
        ok: false,
        fetchedAt,
        error: `GitHub auth failed (${metrics.status}) on ${metricsUrl}: ${formatGhError(metrics.status, metrics.json)}`,
      };
    }

    let dailyData: Array<Record<string, unknown>> | null = null;
    let metricsSource = metricsUrl;

    if (metrics.status === 404) {
      // Try legacy /usage on the same slug type — some org plans never got /metrics.
      const usageUrl = endpointUrl(slugType, slug, 'usage');
      attempts.push(usageUrl);
      const usage = await httpsGetJson(usageUrl, headers);
      if (usage.status === 404) {
        return null;
      }
      if (usage.status >= 400) {
        return {
          ok: false,
          fetchedAt,
          error: `GitHub ${usage.status} on ${usageUrl}: ${formatGhError(usage.status, usage.json)}`,
        };
      }
      dailyData = (usage.json ?? []) as Array<Record<string, unknown>>;
      metricsSource = usageUrl;
    } else if (metrics.status >= 400) {
      return {
        ok: false,
        fetchedAt,
        error: `GitHub ${metrics.status} on ${metricsUrl}: ${formatGhError(metrics.status, metrics.json)}`,
      };
    } else {
      dailyData = (metrics.json ?? []) as Array<Record<string, unknown>>;
    }

    const buckets = parseCopilotMetrics(dailyData ?? []);

    // Billing endpoint for seat counts. Optional — failures here are non-fatal.
    const billingUrl = endpointUrl(slugType, slug, 'billing');
    attempts.push(billingUrl);
    try {
      const billing = await httpsGetJson(billingUrl, headers);
      if (billing.status < 400) {
        const seatBucket = parseSeatBreakdown(billing.json as Record<string, unknown>);
        if (seatBucket) buckets.unshift(seatBucket);
      }
    } catch {
      // ignore — seats are decoration
    }

    return {
      ok: true,
      fetchedAt,
      buckets,
      membershipType: `copilot-${slugType}:${slug}`,
      displayMessages: [],
      authMethod: 'pat',
      source: metricsSource,
    };
  }

  private buildNotFoundMessage(slug: string, requested: SlugType, attempts: string[]): string {
    const triedList = attempts.length > 0 ? `\nTried:\n  ${attempts.join('\n  ')}` : '';
    if (requested === 'org') {
      return (
        `GitHub returned 404 for org "${slug}". ` +
        `If "${slug}" is actually an enterprise slug (Copilot Standalone customers often have one), switch the slug type to "Enterprise" below. ` +
        `Otherwise verify the slug and that your PAT has manage_billing:copilot + read:org on this org.${triedList}`
      );
    }
    if (requested === 'enterprise') {
      return (
        `GitHub returned 404 for enterprise "${slug}". ` +
        `Verify the slug and that your PAT has manage_billing:copilot + read:enterprise.${triedList}`
      );
    }
    return (
      `GitHub returned 404 for "${slug}" as both an organization and an enterprise. ` +
      `Common causes: typo in the slug; PAT missing manage_billing:copilot; PAT classic vs fine-grained mismatch; ` +
      `or you are not an admin of this org/enterprise (Copilot endpoints return 404 instead of 403 for non-admins).${triedList}`
    );
  }
}

function parseCopilotMetrics(daily: Array<Record<string, unknown>>): QuotaBucket[] {
  // Supports both shapes:
  //   - legacy /usage: { total_active_users, total_acceptances_count,
  //     total_suggestions_count, total_chat_turns }[]
  //   - new /metrics:  { total_active_users, total_engaged_users,
  //     copilot_ide_code_completions: { editors:[{ models:[{ total_code_acceptances, total_code_suggestions, ... }]}] },
  //     copilot_ide_chat: { editors:[{ models:[{ total_chats, total_chat_insertion_events, ... }]}] },
  //     copilot_dotcom_chat / copilot_dotcom_pull_requests, ... }[]
  let activeUsersPeak = 0;
  let engagedUsersPeak = 0;
  let suggestionsAccepted = 0;
  let suggestionsTotal = 0;
  let chatTurns = 0;
  let prSummaries = 0;

  for (const day of daily) {
    activeUsersPeak = Math.max(activeUsersPeak, Number(day.total_active_users ?? 0));
    engagedUsersPeak = Math.max(engagedUsersPeak, Number(day.total_engaged_users ?? 0));

    // Legacy fields
    suggestionsAccepted += Number(day.total_acceptances_count ?? 0);
    suggestionsTotal += Number(day.total_suggestions_count ?? 0);
    chatTurns += Number(day.total_chat_turns ?? 0);

    // New /metrics shape — code completions
    const ide = day.copilot_ide_code_completions as
      | { editors?: Array<{ models?: Array<Record<string, unknown>> }> }
      | undefined;
    if (ide?.editors) {
      for (const editor of ide.editors) {
        for (const m of editor.models ?? []) {
          suggestionsAccepted += Number(m.total_code_acceptances ?? 0);
          suggestionsTotal += Number(m.total_code_suggestions ?? 0);
        }
      }
    }

    // New /metrics shape — IDE chat
    const ideChat = day.copilot_ide_chat as
      | { editors?: Array<{ models?: Array<Record<string, unknown>> }> }
      | undefined;
    if (ideChat?.editors) {
      for (const editor of ideChat.editors) {
        for (const m of editor.models ?? []) {
          chatTurns += Number(m.total_chats ?? 0);
        }
      }
    }

    // New /metrics shape — dotcom chat
    const dotcom = day.copilot_dotcom_chat as
      | { models?: Array<Record<string, unknown>> }
      | undefined;
    if (dotcom?.models) {
      for (const m of dotcom.models) {
        chatTurns += Number(m.total_chats ?? 0);
      }
    }

    // New /metrics shape — PR summaries
    const prs = day.copilot_dotcom_pull_requests as
      | { repositories?: Array<Record<string, unknown>> }
      | undefined;
    if (prs?.repositories) {
      for (const r of prs.repositories) {
        prSummaries += Number(r.total_pr_summaries_created ?? 0);
      }
    }
  }

  const buckets: QuotaBucket[] = [];
  if (activeUsersPeak) buckets.push(req('active-users-peak', 'Peak active users (period)', activeUsersPeak));
  if (engagedUsersPeak) buckets.push(req('engaged-users-peak', 'Peak engaged users (period)', engagedUsersPeak));
  if (suggestionsTotal) {
    buckets.push({
      id: 'suggestions',
      label: 'Code suggestions (accepted / total)',
      used: suggestionsAccepted,
      limit: suggestionsTotal,
      remaining: Math.max(0, suggestionsTotal - suggestionsAccepted),
      unit: 'requests',
      enabled: true,
    });
  }
  if (chatTurns) buckets.push(req('chat-turns', 'Copilot Chat turns', chatTurns));
  if (prSummaries) buckets.push(req('pr-summaries', 'Pull request summaries', prSummaries));
  return buckets;
}

function parseSeatBreakdown(json: Record<string, unknown>): QuotaBucket | null {
  const breakdown = json.seat_breakdown as Record<string, unknown> | undefined;
  if (!breakdown) return null;
  const total = Number(breakdown.total ?? 0);
  const active = Number(breakdown.active_this_cycle ?? 0);
  if (!Number.isFinite(total) || total <= 0) return null;
  return {
    id: 'seats-active',
    label: 'Active Copilot seats',
    used: Number.isFinite(active) ? active : 0,
    limit: total,
    remaining: Math.max(0, total - (Number.isFinite(active) ? active : 0)),
    unit: 'requests',
    enabled: true,
  };
}

function req(id: string, label: string, used: number): QuotaBucket {
  return { id, label, used, limit: null, remaining: null, unit: 'requests', enabled: true };
}

function formatGhError(status: number, json: unknown): string {
  const obj = json as { message?: string; documentation_url?: string } | undefined;
  if (obj?.message) {
    return obj.documentation_url ? `${obj.message} (${obj.documentation_url})` : obj.message;
  }
  return `HTTP ${status}`;
}

export function createCopilotQuotaProvider(
  config: Record<string, unknown>,
  ctx: ConnectorContext,
): QuotaProvider {
  const provider = new CopilotQuotaProvider(ctx);
  provider.setConfig(config);
  return provider;
}
