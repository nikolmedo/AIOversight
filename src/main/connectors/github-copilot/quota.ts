import { ConnectorContext, QuotaBucket, QuotaProvider, QuotaSnapshot } from '../types';

/**
 * GitHub Copilot quota provider.
 *
 * Uses a single OAuth token obtained via the device-flow in `copilot-login.ts`.
 * The same token is used for both the personal-quota endpoint and (optionally)
 * the official org metrics endpoint — no PAT or separate mode needed.
 *
 * Personal quota  : GET copilot_internal/user  (internal, unsupported by GitHub)
 * Org metrics     : GET /orgs/{slug}/copilot/metrics  (official API — only when
 *                   `org` config key is set and the token has manage_billing:copilot)
 */

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

// Headers that mirror VS Code Copilot Chat — the internal endpoint may check
// these to verify the request comes from an official editor client.
const EDITOR_HEADERS: Record<string, string> = {
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
  'User-Agent': 'GitHubCopilotChat/0.35.0',
};

const COPILOT_USER_URL = 'https://api.github.com/copilot_internal/user';

// ---- Personal quota parsing -------------------------------------------------

interface QuotaSnapshotEntry {
  entitlement?: number;
  remaining?: number;
  unlimited?: boolean;
}

const QUOTA_LABELS: Record<string, string> = {
  premium_interactions: 'Premium requests',
  chat: 'Chat',
  completions: 'Code completions',
};

function parsePersonalQuota(json: Record<string, unknown>): {
  buckets: QuotaBucket[];
  membershipType?: string;
  billingCycleEnd?: string;
  displayMessages: string[];
} {
  const buckets: QuotaBucket[] = [];
  const snapshots = json.quota_snapshots as Record<string, QuotaSnapshotEntry> | undefined;

  for (const [key, snap] of Object.entries(snapshots ?? {})) {
    if (!snap || typeof snap !== 'object') continue;
    const label = QUOTA_LABELS[key] ?? key;

    if (snap.unlimited) {
      buckets.push({ id: key, label: `${label} (unlimited)`, used: 0, limit: null, remaining: null, unit: 'requests', enabled: true });
      continue;
    }

    const limit = Number.isFinite(snap.entitlement) ? Number(snap.entitlement) : null;
    const remaining = Number.isFinite(snap.remaining) ? Number(snap.remaining) : null;
    if (limit == null && remaining == null) continue;

    buckets.push({
      id: key,
      label,
      used: limit != null && remaining != null ? Math.max(0, limit - remaining) : 0,
      limit,
      remaining,
      unit: 'requests',
      enabled: true,
    });
  }

  const resetDate = typeof json.quota_reset_date === 'string' ? json.quota_reset_date : undefined;
  return {
    buckets,
    membershipType: typeof json.copilot_plan === 'string' ? json.copilot_plan : undefined,
    billingCycleEnd: resetDate,
    displayMessages: resetDate ? [`Quota resets ${resetDate}`] : [],
  };
}

// ---- Org metrics parsing ----------------------------------------------------

function parseOrgMetrics(daily: Array<Record<string, unknown>>): QuotaBucket[] {
  let activeUsersPeak = 0;
  let engagedUsersPeak = 0;
  let suggestionsAccepted = 0;
  let suggestionsTotal = 0;
  let chatTurns = 0;
  let prSummaries = 0;

  for (const day of daily) {
    activeUsersPeak = Math.max(activeUsersPeak, Number(day.total_active_users ?? 0));
    engagedUsersPeak = Math.max(engagedUsersPeak, Number(day.total_engaged_users ?? 0));

    suggestionsAccepted += Number(day.total_acceptances_count ?? 0);
    suggestionsTotal += Number(day.total_suggestions_count ?? 0);
    chatTurns += Number(day.total_chat_turns ?? 0);

    const ide = day.copilot_ide_code_completions as { editors?: Array<{ models?: Array<Record<string, unknown>> }> } | undefined;
    if (ide?.editors) {
      for (const editor of ide.editors) {
        for (const m of editor.models ?? []) {
          suggestionsAccepted += Number(m.total_code_acceptances ?? 0);
          suggestionsTotal += Number(m.total_code_suggestions ?? 0);
        }
      }
    }

    const ideChat = day.copilot_ide_chat as { editors?: Array<{ models?: Array<Record<string, unknown>> }> } | undefined;
    if (ideChat?.editors) {
      for (const editor of ideChat.editors) {
        for (const m of editor.models ?? []) {
          chatTurns += Number(m.total_chats ?? 0);
        }
      }
    }

    const dotcom = day.copilot_dotcom_chat as { models?: Array<Record<string, unknown>> } | undefined;
    if (dotcom?.models) {
      for (const m of dotcom.models) chatTurns += Number(m.total_chats ?? 0);
    }

    const prs = day.copilot_dotcom_pull_requests as { repositories?: Array<Record<string, unknown>> } | undefined;
    if (prs?.repositories) {
      for (const r of prs.repositories) prSummaries += Number(r.total_pr_summaries_created ?? 0);
    }
  }

  const buckets: QuotaBucket[] = [];
  if (activeUsersPeak) buckets.push(orgBucket('active-users-peak', 'Org: peak active users', activeUsersPeak));
  if (engagedUsersPeak) buckets.push(orgBucket('engaged-users-peak', 'Org: peak engaged users', engagedUsersPeak));
  if (suggestionsTotal) {
    buckets.push({
      id: 'org-suggestions',
      label: 'Org: code suggestions (accepted / total)',
      used: suggestionsAccepted,
      limit: suggestionsTotal,
      remaining: Math.max(0, suggestionsTotal - suggestionsAccepted),
      unit: 'requests',
      enabled: true,
    });
  }
  if (chatTurns) buckets.push(orgBucket('org-chat-turns', 'Org: chat turns', chatTurns));
  if (prSummaries) buckets.push(orgBucket('org-pr-summaries', 'Org: PR summaries', prSummaries));
  return buckets;
}

function orgBucket(id: string, label: string, used: number): QuotaBucket {
  return { id, label, used, limit: null, remaining: null, unit: 'requests', enabled: true };
}

function formatGhError(status: number, json: unknown): string {
  const obj = json as { message?: string; documentation_url?: string } | undefined;
  if (obj?.message) {
    return obj.documentation_url ? `${obj.message} (${obj.documentation_url})` : obj.message;
  }
  return `HTTP ${status}`;
}

// ---- Provider ---------------------------------------------------------------

class CopilotQuotaProvider implements QuotaProvider {
  private cfg: Record<string, unknown> = {};
  constructor(private readonly ctx: ConnectorContext) {}
  setConfig(cfg: Record<string, unknown>): void {
    this.cfg = cfg;
  }

  async fetch(): Promise<QuotaSnapshot> {
    const fetchedAt = Date.now();
    const oauthToken = this.ctx.secret('copilotOauthToken');

    if (!oauthToken) {
      return {
        ok: false,
        fetchedAt,
        needsLogin: true,
        error:
          'Not signed in to GitHub Copilot. Click "Sign in to GitHub Copilot" below — ' +
          'it opens a browser once and never asks again.',
      };
    }

    // copilot_internal/user accepts the raw ghu_ OAuth token directly via the
    // `token` scheme. It must NOT use the exchanged short-lived HMAC session
    // token (that one is for inference endpoints only).
    const personalHeaders = {
      Authorization: `token ${oauthToken}`,
      Accept: 'application/json',
      ...EDITOR_HEADERS,
    };

    const res = await httpsGetJson(COPILOT_USER_URL, personalHeaders);

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        fetchedAt,
        needsLogin: true,
        error:
          `GitHub Copilot returned ${res.status} — your session may have expired. ` +
          `Click "Sign in to GitHub Copilot" to reconnect.`,
      };
    }
    if (res.status >= 400) {
      return {
        ok: false,
        fetchedAt,
        error: `GitHub Copilot ${res.status} on ${COPILOT_USER_URL}: ${formatGhError(res.status, res.json)}`,
      };
    }

    const personal = parsePersonalQuota(res.json as Record<string, unknown>);

    // Optionally fetch org metrics if a slug was configured.
    const orgSlug = (this.cfg.org as string | undefined)?.trim();
    const orgBuckets = orgSlug ? await this.fetchOrgMetrics(orgSlug, oauthToken) : [];

    const allBuckets = [...personal.buckets, ...orgBuckets];
    if (allBuckets.length === 0) {
      return {
        ok: false,
        fetchedAt,
        error:
          'GitHub Copilot returned no quota data (the internal endpoint may have changed shape). ' +
          `Raw: ${String(res.raw).slice(0, 200)}`,
        source: COPILOT_USER_URL,
      };
    }

    return {
      ok: true,
      fetchedAt,
      buckets: allBuckets,
      membershipType: personal.membershipType,
      billingCycleEnd: personal.billingCycleEnd,
      displayMessages: personal.displayMessages,
      authMethod: 'oauth',
      source: COPILOT_USER_URL,
    };
  }

  /** Fetches org-level usage metrics. Failures here are non-fatal — personal quota still shows. */
  private async fetchOrgMetrics(slug: string, oauthToken: string): Promise<QuotaBucket[]> {
    const orgHeaders = {
      Authorization: `Bearer ${oauthToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'aioversight',
    };

    const metricsUrl = `https://api.github.com/orgs/${encodeURIComponent(slug)}/copilot/metrics`;
    const metrics = await httpsGetJson(metricsUrl, orgHeaders).catch(() => null);
    if (!metrics || metrics.status >= 400) return [];

    const usageUrl = `https://api.github.com/orgs/${encodeURIComponent(slug)}/copilot/usage`;
    const usage = metrics.status === 200
      ? metrics
      : await httpsGetJson(usageUrl, orgHeaders).catch(() => null);

    if (!usage || usage.status >= 400) return [];
    return parseOrgMetrics((usage.json ?? []) as Array<Record<string, unknown>>);
  }
}

export function createCopilotQuotaProvider(
  config: Record<string, unknown>,
  ctx: ConnectorContext,
): QuotaProvider {
  const provider = new CopilotQuotaProvider(ctx);
  provider.setConfig(config);
  return provider;
}
