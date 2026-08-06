import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ConnectorContext, QuotaBucket, QuotaProvider, QuotaSnapshot } from '../types';

/**
 * GitHub Copilot quota provider.
 *
 * Token resolution order (first hit wins), all file-based except the first —
 * no keychain:
 *   1. `copilotOauthToken` secret, set by this connector's own device-flow login.
 *   2. `~/.config/github-copilot/apps.json` (VS Code Copilot Chat's device-flow token)
 *   3. `~/.config/github-copilot/hosts.json` (legacy VS Code Copilot format)
 *   4. `~/.config/gh/hosts.yml`'s `oauth_token` (GitHub CLI's session)
 *   On Windows, `%APPDATA%\github-copilot\` and `%APPDATA%\GitHub CLI\hosts.yml`
 *   are checked too (ahead of the `~/.config` paths, which rarely exist there).
 *
 * Personal quota  : GET copilot_internal/user  (internal, unsupported by GitHub)
 * Org metrics     : GET /orgs/{slug}/copilot/metrics  (official API — only when
 *                   `org` config key is set, or auto-discovered via /user/orgs,
 *                   and the token has manage_billing:copilot)
 * Org billing     : GET /orgs/{slug}/settings/billing/usage/summary (official
 *                   API — org spend, behind `defaultVisibility: 'onDemand'`)
 */

// --- Credential resolution ---------------------------------------------------

interface ResolvedToken {
  token: string;
  source: string;
}

function parseGhHostsYaml(text: string): string | null {
  const lines = text.split(/\r?\n/);
  let inGithubBlock = false;
  for (const line of lines) {
    const topLevelKey = line.match(/^(\S[^:]*):\s*$/);
    if (topLevelKey) {
      inGithubBlock = /^github\.com$/i.test(topLevelKey[1].trim());
      continue;
    }
    if (!inGithubBlock) continue;
    if (line.trim() && !/^\s/.test(line)) {
      inGithubBlock = false;
      continue;
    }
    const tokenLine = line.match(/^\s+oauth_token:\s*(.+?)\s*$/);
    if (tokenLine) {
      return tokenLine[1].trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return null;
}

/** Any JSON object shaped like `{ "<key>": { oauth_token: "..." } }` — both
 * `apps.json` and legacy `hosts.json` follow this shape. */
function extractTokenFromCopilotJson(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  for (const val of Object.values(json as Record<string, unknown>)) {
    if (!val || typeof val !== 'object') continue;
    const entry = val as Record<string, unknown>;
    const token = entry.oauth_token ?? entry.token;
    if (typeof token === 'string' && token) return token;
  }
  return null;
}

function credentialFileCandidates(): Array<{ file: string; kind: 'json' | 'yaml' }> {
  const home = os.homedir();
  const out: Array<{ file: string; kind: 'json' | 'yaml' }> = [];
  const push = (file: string, kind: 'json' | 'yaml') => {
    if (!out.some(o => o.file === file)) out.push({ file, kind });
  };

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    push(path.join(appData, 'github-copilot', 'apps.json'), 'json');
    push(path.join(appData, 'github-copilot', 'hosts.json'), 'json');
    push(path.join(appData, 'GitHub CLI', 'hosts.yml'), 'yaml');
  }
  push(path.join(home, '.config', 'github-copilot', 'apps.json'), 'json');
  push(path.join(home, '.config', 'github-copilot', 'hosts.json'), 'json');
  push(path.join(home, '.config', 'gh', 'hosts.yml'), 'yaml');
  return out;
}

function resolveOauthToken(ctx: ConnectorContext): ResolvedToken | null {
  const secretToken = ctx.secret('copilotOauthToken');
  if (secretToken) return { token: secretToken, source: 'AI Oversight sign-in' };

  for (const { file, kind } of credentialFileCandidates()) {
    if (!fs.existsSync(file)) continue;
    try {
      const text = fs.readFileSync(file, 'utf8');
      const token = kind === 'json' ? extractTokenFromCopilotJson(JSON.parse(text)) : parseGhHostsYaml(text);
      if (token) return { token, source: file };
    } catch {
      // Malformed/unreadable — try the next candidate.
      continue;
    }
  }
  return null;
}

async function httpsGetJson(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; json: unknown; raw: string }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { net } = require('electron') as typeof import('electron');
    if (net?.fetch) {
      // net.fetch has no built-in timeout — without this, a single hung org
      // call (this file chains up to ~16 of them for discovery) wedges every
      // future poll and the Refresh button, not just this fetch.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const res = await net.fetch(url, { headers, signal: controller.signal });
        const txt = await res.text();
        try {
          return { status: res.status, json: txt ? JSON.parse(txt) : {}, raw: txt };
        } catch {
          return { status: res.status, json: {}, raw: txt };
        }
      } catch (err) {
        // A deliberate timeout-abort means the destination is unreachable or
        // slow either way -- falling through to the Node https fallback below
        // would just pay the SAME 15s timeout again, doubling worst-case
        // latency across the org-discovery chain. Fail closed here (408, so
        // every existing `status >= 400` caller treats it as an error)
        // instead of retrying via a different transport.
        if (controller.signal.aborted) {
          return { status: 408, json: {}, raw: `GitHub API timed out after 15000ms: ${url}` };
        }
        throw err;
      } finally {
        clearTimeout(timer);
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
  'X-GitHub-Api-Version': '2025-04-01',
};

function firstFiniteNumber(...vals: unknown[]): number | null {
  for (const v of vals) {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Org billing usage reports dollars — the one conversion point this file's
 * spend path needs. A local copy rather than importing cursor/quota.ts's
 * `dollarsToCents`: this codebase's quota.ts files are self-contained per
 * connector by convention (each keeps its own `httpsGetJson`, for example),
 * not shared across connector folders. Exported for smoke coverage. */
export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

const COPILOT_USER_URL = 'https://api.github.com/copilot_internal/user';

// ---- Personal quota parsing -------------------------------------------------

interface QuotaSnapshotEntry {
  entitlement?: number;
  remaining?: number;
  unlimited?: boolean;
  /** Some plan shapes report only a remaining-percentage, no absolute counts. */
  percent_remaining?: number;
  overage_count?: number;
  overage_permitted?: boolean;
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

    if (limit == null && remaining == null) {
      // Some shapes only report a "percent remaining" figure, not absolute
      // counts — GitHub reports what's LEFT, so displaying it as-is would be
      // backwards for a "used" meter. Must invert: used% = 100 - remaining%.
      const percentRemaining = firstFiniteNumber(snap.percent_remaining);
      if (percentRemaining != null) {
        buckets.push({
          id: key,
          label,
          used: 100 - percentRemaining,
          limit: 100,
          remaining: percentRemaining,
          unit: 'percent',
          enabled: true,
        });
      }
      continue;
    }

    buckets.push({
      id: key,
      label,
      used: limit != null && remaining != null ? Math.max(0, limit - remaining) : 0,
      limit,
      remaining,
      unit: 'requests',
      enabled: true,
    });

    // Paid overage beyond the included entitlement, when the account has it
    // enabled — surfaced as its own always-visible bucket, not folded into
    // the entitlement meter above (different unit of "limit").
    if (key === 'premium_interactions' && snap.overage_permitted) {
      const overageUsed = firstFiniteNumber(snap.overage_count) ?? 0;
      buckets.push({
        id: 'extra-usage',
        label: 'Extra premium requests (overage)',
        used: overageUsed,
        limit: null,
        remaining: null,
        unit: 'requests',
        enabled: true,
      });
    }
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
      defaultVisibility: 'onDemand',
    });
  }
  if (chatTurns) buckets.push(orgBucket('org-chat-turns', 'Org: chat turns', chatTurns));
  if (prSummaries) buckets.push(orgBucket('org-pr-summaries', 'Org: PR summaries', prSummaries));
  return buckets;
}

function orgBucket(id: string, label: string, used: number): QuotaBucket {
  return {
    id,
    label,
    used,
    limit: null,
    remaining: null,
    unit: 'requests',
    enabled: true,
    defaultVisibility: 'onDemand',
  };
}

// ---- Org billing usage summary parsing --------------------------------------
//
// GitHub's org billing usage API is documented for the enhanced-billing
// platform, but the exact `usageItems` shape can vary by account type — this
// probes defensively (same approach as `parseClaudeAiUsage` elsewhere in this
// codebase) and never fabricates a `0` for a field it doesn't recognise.

interface BillingUsageItem {
  product?: string;
  sku?: string;
  quantity?: number;
  netAmount?: number;
  grossAmount?: number;
}

function parseOrgBillingUsage(json: Record<string, unknown>): QuotaBucket[] {
  const items = (json.usageItems ?? json.usage_items ?? []) as BillingUsageItem[];
  if (!Array.isArray(items) || items.length === 0) return [];

  let netDollars = 0;
  let hasNet = false;
  let chatQuantity = 0;
  let completionsQuantity = 0;

  for (const item of items) {
    const product = String(item.product ?? '').toLowerCase();
    if (!product.includes('copilot')) continue;

    const net = firstFiniteNumber(item.netAmount, item.grossAmount);
    if (net != null) {
      netDollars += net;
      hasNet = true;
    }

    const sku = String(item.sku ?? '').toLowerCase();
    const quantity = firstFiniteNumber(item.quantity) ?? 0;
    if (sku.includes('chat')) chatQuantity += quantity;
    else if (sku.includes('completion')) completionsQuantity += quantity;
  }

  const buckets: QuotaBucket[] = [];
  if (hasNet) {
    // Billing usage API reports dollars, not cents — convert once, here.
    buckets.push({
      id: 'org-spend',
      label: 'Org: Copilot spend this period',
      used: dollarsToCents(netDollars),
      limit: null,
      remaining: null,
      unit: 'usd',
      enabled: true,
      defaultVisibility: 'onDemand',
    });
  }
  if (chatQuantity) buckets.push(orgBucket('org-billed-chat', 'Org: billed chat requests', chatQuantity));
  if (completionsQuantity) {
    buckets.push(orgBucket('org-billed-completions', 'Org: billed completions', completionsQuantity));
  }
  return buckets;
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
  /** The org whose data won on the last successful poll — reused first on
   * later polls so a multi-org user's numbers don't silently swap between
   * orgs cycle to cycle just because /user/orgs' ordering shifted. */
  private pinnedOrgSlug: string | null = null;
  constructor(private readonly ctx: ConnectorContext) {}
  setConfig(cfg: Record<string, unknown>): void {
    this.cfg = cfg;
  }

  async fetch(): Promise<QuotaSnapshot> {
    const fetchedAt = Date.now();
    const resolved = resolveOauthToken(this.ctx);

    if (!resolved) {
      return {
        ok: false,
        fetchedAt,
        needsLogin: true,
        error:
          'Not signed in to GitHub Copilot. Click "Sign in to GitHub Copilot" below — ' +
          'it opens a browser once and never asks again. (Also checked for an existing ' +
          'VS Code Copilot Chat or `gh` CLI session — none found.)',
      };
    }
    const oauthToken = resolved.token;

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
        source: resolved.source,
      };
    }
    if (res.status >= 400) {
      return {
        ok: false,
        fetchedAt,
        error: `GitHub Copilot ${res.status} on ${COPILOT_USER_URL}: ${formatGhError(res.status, res.json)}`,
        source: resolved.source,
      };
    }

    const personal = parsePersonalQuota(res.json as Record<string, unknown>);

    // Org path — behind an explicit config slug or auto-discovered via
    // /user/orgs when unset. Failures anywhere in here are non-fatal.
    const orgBuckets = await this.fetchOrgBuckets(oauthToken);

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

  /** Resolves which org slug(s) to try, in order: the configured one; else
   * the previously-pinned org (stability across polls); else discovery via
   * /user/orgs sorted alphabetically (deterministic — API ordering isn't
   * guaranteed stable, so "whoever answers first" could otherwise silently
   * swap orgs between polls). */
  private async resolveOrgSlugs(oauthToken: string, orgHeaders: Record<string, string>): Promise<string[]> {
    const configured = (this.cfg.org as string | undefined)?.trim();
    if (configured) return [configured];

    try {
      const res = await httpsGetJson('https://api.github.com/user/orgs', orgHeaders);
      if (res.status >= 400) return this.pinnedOrgSlug ? [this.pinnedOrgSlug] : [];
      const orgs = res.json as Array<{ login?: string }>;
      if (!Array.isArray(orgs)) return this.pinnedOrgSlug ? [this.pinnedOrgSlug] : [];
      // Cap discovery to a handful of orgs — this is a convenience fallback,
      // not a broad sweep, and most users belong to very few.
      const discovered = orgs
        .map(o => o.login)
        .filter((l): l is string => !!l)
        .sort((a, b) => a.localeCompare(b))
        .slice(0, 5);
      if (this.pinnedOrgSlug && discovered.includes(this.pinnedOrgSlug)) {
        return [this.pinnedOrgSlug, ...discovered.filter(s => s !== this.pinnedOrgSlug)];
      }
      return discovered;
    } catch {
      return this.pinnedOrgSlug ? [this.pinnedOrgSlug] : [];
    }
  }

  /** Fetches org-level usage metrics + billing summary. Failures here are non-fatal. */
  private async fetchOrgBuckets(oauthToken: string): Promise<QuotaBucket[]> {
    const orgHeaders = {
      Authorization: `Bearer ${oauthToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'aioversight',
    };

    const slugs = await this.resolveOrgSlugs(oauthToken, orgHeaders);
    for (const slug of slugs) {
      const buckets = await this.fetchOrgMetrics(slug, orgHeaders);
      const billing = await this.fetchOrgBillingUsage(slug, orgHeaders);
      const combined = [...buckets, ...billing];
      // First org that yields any data wins — avoids merging unrelated orgs'
      // numbers together when a user belongs to several. Pin it for next
      // poll, and stamp the org into each label so it's visible which org
      // the numbers belong to even if the pin later changes.
      if (combined.length > 0) {
        this.pinnedOrgSlug = slug;
        return combined.map(b => ({ ...b, label: `${b.label} (${slug})` }));
      }
    }
    return [];
  }

  private async fetchOrgMetrics(slug: string, orgHeaders: Record<string, string>): Promise<QuotaBucket[]> {
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

  private async fetchOrgBillingUsage(slug: string, orgHeaders: Record<string, string>): Promise<QuotaBucket[]> {
    const billingUrl = `https://api.github.com/orgs/${encodeURIComponent(slug)}/settings/billing/usage/summary`;
    const billing = await httpsGetJson(billingUrl, orgHeaders).catch(() => null);
    if (!billing || billing.status >= 400) return [];
    return parseOrgBillingUsage(billing.json as Record<string, unknown>);
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
