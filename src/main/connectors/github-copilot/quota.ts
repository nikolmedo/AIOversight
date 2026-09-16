import { execFileSync } from 'child_process';
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
 *   5. `gh auth token`. Verified 2026-09-16 on Windows: a normally-authenticated
 *   `gh` writes NO `oauth_token` into hosts.yml (only `git_protocol`/`user`),
 *   because it keeps the token in the OS keyring — Credential Manager here,
 *   Keychain on macOS. Step 4 therefore finds nothing on most modern installs,
 *   and shelling out to the CLI is the only supported way to read it back.
 *
 * Personal quota  : GET copilot_internal/user  (internal, unsupported by
 *                   GitHub — still live, verified 2026-09-16)
 * Org metrics     : GET /orgs/{slug}/copilot/metrics/reports/organization-28-day/latest
 *                   then the signed NDJSON behind its `download_links`
 *                   (official reports API — only when `org` config key is set,
 *                   or auto-discovered via /user/orgs, and the caller has
 *                   org-admin / "View Organization Copilot Metrics" access)
 * Org AI Credits  : same two-step read of .../reports/users-28-day/latest
 * Org billing     : GET /organizations/{slug}/settings/billing/usage/summary
 *                   (official API — org spend, behind
 *                   `defaultVisibility: 'onDemand'`)
 *
 * Everything below the personal endpoint is enrichment: non-fatal, and its
 * absence never fails a snapshot.
 */

/** Org enrichment result. `notes` carries user-facing explanations (e.g. a
 * permissions 403) that belong in `displayMessages`, not in an error. */
interface OrgEnrichment {
  buckets: QuotaBucket[];
  notes: string[];
}

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

  const cliToken = readGhCliToken();
  if (cliToken) return { token: cliToken, source: 'gh auth token' };

  return null;
}

/**
 * Reads the GitHub CLI's token via `gh auth token`, which works whether the
 * CLI stored it in hosts.yml or in the OS keyring. `shell: false` (execFile's
 * default) keeps this free of shell interpolation; a missing `gh` just throws
 * ENOENT and is treated as "no token".
 */
function readGhCliToken(): string | null {
  try {
    const out = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
    return /^[A-Za-z0-9_]+$/.test(out) ? out : null;
  } catch {
    return null;
  }
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

// Headers that mirror VS Code Copilot Chat. Probed live on 2026-09-16: a plain
// `gh` CLI token with NONE of these still returned 200 with a full
// `quota_snapshots` payload, so they are not required — they stay because
// other plan types may be gated differently and every comparable tool sends
// them. What was removed is `X-GitHub-Api-Version: 2025-04-01`: no such REST
// version exists (the public ones are 2022-11-28 and 2026-03-10) and GitHub
// answers 410 for an unsupported version on versioned endpoints, so sending a
// made-up one was a latent breakage waiting for this endpoint to start
// honouring the header.
const EDITOR_HEADERS: Record<string, string> = {
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
  'User-Agent': 'GitHubCopilotChat/0.35.0',
};

/** Reports API (`/copilot/metrics/reports/...`). Distinct from the
 * 2022-11-28 the older org endpoints use. */
const REPORTS_API_VERSION = '2026-03-10';

/** `Number('')` is `0`, so an empty or whitespace-only string is rejected
 * before it can become a fabricated measured zero — the same guard cursor,
 * zai, devin, grok and antigravity carry. */
function firstFiniteNumber(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim() === '') continue;
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

/**
 * Shape verified live on 2026-09-16 against `copilot_internal/user` with a
 * `gh` CLI token (plan `business`). On 2026-06-01 Copilot replaced "premium
 * requests" with AI Credits — 1 credit = $0.01, Pro 1,500/mo, Pro+ 7,000, Max
 * 20,000, reset 00:00 UTC on the 1st — and the payload grew
 * `credits_used`, `token_based_billing`, `overage_entitlement` and the
 * fractional `quota_remaining` alongside the rounded `remaining` this parser
 * used to read.
 *
 * `used_percent` / `over_quota_used_percent` / `is_placeholder` are reported
 * by other Copilot clients but were NOT in the verified payload — treated as
 * optional, never required.
 */
interface QuotaSnapshotEntry {
  entitlement?: number;
  remaining?: number;
  /** Fractional remaining. `remaining` is the same figure rounded, so this is
   * the one to do percentage math with. */
  quota_remaining?: number;
  unlimited?: boolean;
  /** Some plan shapes report only a remaining-percentage, no absolute counts. */
  percent_remaining?: number;
  used_percent?: number;
  over_quota_used_percent?: number;
  /** AI Credits consumed. GitHub returns `0` here even on snapshots that are
   * demonstrably metered (the verified 2026-09-16 payload had
   * `credits_used: 0` next to `quota_remaining: 19496.4` on a 20,000
   * entitlement), so this is a fallback only — never the primary "used". */
  credits_used?: number;
  /** When true, this snapshot's numbers are AI Credits, not request counts. */
  token_based_billing?: boolean;
  overage_count?: number;
  overage_entitlement?: number;
  overage_permitted?: boolean;
  /** Reported by some clients for a stub snapshot with no measured data. */
  is_placeholder?: boolean;
}

const QUOTA_LABELS: Record<string, string> = {
  premium_interactions: 'Premium requests',
  chat: 'Chat',
  completions: 'Code completions',
};

/** AI Credits are billed at $0.01 each. Spelled out on every credit-denominated
 * bucket so the raw number isn't read as a request count. */
const CREDIT_NOTE = 'AI Credits ($0.01 each)';

function parsePersonalQuota(json: Record<string, unknown>): {
  buckets: QuotaBucket[];
  membershipType?: string;
  billingCycleEnd?: string;
  displayMessages: string[];
} {
  const buckets: QuotaBucket[] = [];
  const snapshots = json.quota_snapshots as Record<string, QuotaSnapshotEntry> | undefined;
  const accountTokenBased = json.token_based_billing === true;

  for (const [key, snap] of Object.entries(snapshots ?? {})) {
    if (!snap || typeof snap !== 'object') continue;
    const label = QUOTA_LABELS[key] ?? key;
    const tokenBased = snap.token_based_billing ?? accountTokenBased;
    const unit = tokenBased ? 'credits' : 'requests';

    if (snap.unlimited) {
      buckets.push({ id: key, label: `${label} (unlimited)`, used: 0, limit: null, remaining: null, unit, enabled: true });
      continue;
    }

    // A placeholder snapshot carries no measured value — omit the bucket
    // rather than rendering its zeros as real usage.
    if (snap.is_placeholder === true) continue;

    const limit = firstFiniteNumber(snap.entitlement);
    const remaining = firstFiniteNumber(snap.quota_remaining, snap.remaining);

    if (limit == null && remaining == null) {
      // Some shapes only report percentages, not absolute counts. GitHub
      // reports what's LEFT in `percent_remaining`, so displaying that as-is
      // would be backwards for a "used" meter: invert it. `used_percent`, when
      // present, is already the right way round.
      const usedPercent =
        firstFiniteNumber(snap.used_percent) ??
        (firstFiniteNumber(snap.percent_remaining) != null
          ? 100 - (firstFiniteNumber(snap.percent_remaining) as number)
          : null);
      if (usedPercent != null) {
        buckets.push({
          id: key,
          label,
          used: usedPercent,
          limit: 100,
          remaining: Math.max(0, 100 - usedPercent),
          unit: 'percent',
          enabled: true,
        });
      }
      continue;
    }

    // Only one of the pair present means usage is genuinely unknowable:
    // `credits_used` is a fallback, not a substitute, and defaulting it to 0
    // would tell the user they have spent none of a quota we cannot measure.
    const used =
      limit != null && remaining != null
        ? Math.max(0, limit - remaining)
        : firstFiniteNumber(snap.credits_used);

    const bucket: QuotaBucket = {
      id: key,
      label: tokenBased ? `${label} (credits)` : label,
      used,
      limit,
      remaining,
      unit,
      enabled: true,
    };
    if (tokenBased) bucket.note = CREDIT_NOTE;
    buckets.push(bucket);

    // Paid overage beyond the included entitlement, when the account has it
    // enabled — surfaced as its own always-visible bucket, not folded into
    // the entitlement meter above (different unit of "limit").
    if (key === 'premium_interactions' && snap.overage_permitted) {
      const overageUsed = firstFiniteNumber(snap.overage_count) ?? 0;
      // `overage_entitlement: 0` alongside `overage_permitted: true` (the
      // 2026-09-16 payload) is pay-as-you-go, not a cap of zero — rendering it
      // as a `0 / 0` meter would read as "already exhausted".
      const entitlement = firstFiniteNumber(snap.overage_entitlement);
      const overageLimit = entitlement != null && entitlement > 0 ? entitlement : null;
      const overage: QuotaBucket = {
        id: 'extra-usage',
        label: tokenBased ? 'Extra AI Credits (overage)' : 'Extra premium requests (overage)',
        used: overageUsed,
        limit: overageLimit,
        remaining: overageLimit != null ? Math.max(0, overageLimit - overageUsed) : null,
        unit,
        enabled: true,
      };
      if (tokenBased) overage.note = CREDIT_NOTE;
      buckets.push(overage);
    }
  }

  const resetDate = typeof json.quota_reset_date === 'string' ? json.quota_reset_date : undefined;
  const displayMessages: string[] = [];
  if (resetDate) displayMessages.push(`Quota resets ${resetDate}`);
  if (accountTokenBased) {
    displayMessages.push('Billed in AI Credits (1 credit = $0.01), resetting 00:00 UTC on the 1st.');
  }
  return {
    buckets,
    membershipType: typeof json.copilot_plan === 'string' ? json.copilot_plan : undefined,
    billingCycleEnd: resetDate,
    displayMessages,
  };
}

// ---- Org metrics parsing ----------------------------------------------------
//
// GitHub sunset BOTH endpoints this section used to call: `/copilot/usage`
// first, then `/copilot/metrics` on 2026-04-02. Verified live on 2026-09-16 —
// `GET /orgs/{org}/copilot/metrics` now answers 404. The replacement is the
// reports API, which does NOT return metrics inline: it returns report
// metadata with short-lived signed `download_links`, and each link serves
// NDJSON (one JSON record per line, despite the `.json` extension).
//
// So one logical read is two requests: the `latest` pointer, then the report
// body. The body is fetched WITHOUT our GitHub credentials — the links are
// pre-signed blob URLs, and a stray Authorization header is at best ignored
// and at worst rejected by the storage host.

/** Fields taken from GitHub's "Data available in Copilot usage metrics" ->
 * "API and export fields" reference. Everything is optional: the report
 * schema grows over time and a missing field must omit a bucket, never
 * fabricate a zero. */
function parseOrgReport(records: Array<Record<string, unknown>>): QuotaBucket[] {
  let peakDailyActive: number | null = null;
  let monthlyActive: number | null = null;
  let engagedUsers: number | null = null;

  const keepMax = (current: number | null, candidate: number | null): number | null =>
    candidate == null ? current : current == null ? candidate : Math.max(current, candidate);

  for (const record of records) {
    monthlyActive = keepMax(monthlyActive, firstFiniteNumber(record.monthly_active_users));

    const dayTotals = record.day_totals;
    if (Array.isArray(dayTotals)) {
      for (const day of dayTotals) {
        if (!day || typeof day !== 'object') continue;
        const d = day as Record<string, unknown>;
        peakDailyActive = keepMax(peakDailyActive, firstFiniteNumber(d.daily_active_users));
      }
    }

    const phases = record.totals_by_ai_adoption_phase;
    if (Array.isArray(phases)) {
      let sum: number | null = null;
      for (const phase of phases) {
        if (!phase || typeof phase !== 'object') continue;
        const engaged = firstFiniteNumber((phase as Record<string, unknown>).total_engaged_users);
        if (engaged != null) sum = (sum ?? 0) + engaged;
      }
      engagedUsers = keepMax(engagedUsers, sum);
    }
  }

  const buckets: QuotaBucket[] = [];
  if (peakDailyActive != null) {
    buckets.push(orgBucket('active-users-peak', 'Org: peak daily active users', peakDailyActive));
  }
  if (monthlyActive != null) {
    buckets.push(orgBucket('org-monthly-active-users', 'Org: monthly active users', monthlyActive));
  }
  if (engagedUsers != null) {
    buckets.push(orgBucket('org-engaged-users', 'Org: engaged users', engagedUsers));
  }
  return buckets;
}

/** Per-user reports have carried `ai_credits_used` since June 2026 — summed
 * into one org-wide credit total. */
function parseOrgAiCredits(records: Array<Record<string, unknown>>): QuotaBucket | null {
  let total: number | null = null;
  for (const record of records) {
    const credits = firstFiniteNumber(record.ai_credits_used);
    if (credits != null) total = (total ?? 0) + credits;
  }
  if (total == null) return null;
  const bucket = orgBucket('org-ai-credits', 'Org: AI Credits used (28d)', total);
  bucket.unit = 'credits';
  bucket.note = CREDIT_NOTE;
  return bucket;
}

/** NDJSON, not a JSON array — parse line by line and skip anything unparseable
 * rather than discarding the whole report for one bad line. */
export function parseNdjson(raw: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        out.push(parsed as Record<string, unknown>);
      }
    } catch {
      continue;
    }
  }
  return out;
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
  /** `/usage` reports `quantity`; `/usage/summary` reports the pre/post
   * discount pair instead. */
  quantity?: number;
  netQuantity?: number;
  grossQuantity?: number;
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
    const quantity = firstFiniteNumber(item.quantity, item.netQuantity, item.grossQuantity) ?? 0;
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
    const org = await this.fetchOrgBuckets(oauthToken);

    const allBuckets = [...personal.buckets, ...org.buckets];
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
      displayMessages: [...personal.displayMessages, ...org.notes],
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

  /** Fetches org-level report metrics + billing summary. Failures here are
   * non-fatal — a user with no org, or no org-admin rights, still gets their
   * personal buckets. */
  private async fetchOrgBuckets(oauthToken: string): Promise<OrgEnrichment> {
    const orgHeaders = {
      Authorization: `Bearer ${oauthToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'aioversight',
    };
    // A 403 is the EXPECTED answer for most orgs a user merely belongs to, so
    // it is only worth telling them about when they asked for this org by
    // name. Auto-discovery sweeps up to five orgs and would otherwise produce
    // five "you need admin" notes nobody asked for.
    const explicitOrg = !!(this.cfg.org as string | undefined)?.trim();

    const slugs = await this.resolveOrgSlugs(oauthToken, orgHeaders);
    const notes: string[] = [];
    for (const slug of slugs) {
      const metrics = await this.fetchOrgReport(slug, orgHeaders, explicitOrg);
      notes.push(...metrics.notes);
      const buckets = [...metrics.buckets];
      // The per-user report is two more requests, so only pay for it once the
      // org report has proven this slug is one we can actually read.
      if (buckets.length > 0) {
        const credits = await this.fetchOrgAiCreditsBucket(slug, orgHeaders);
        if (credits) buckets.push(credits);
      }
      const billing = await this.fetchOrgBillingUsage(slug, orgHeaders);
      const combined = [...buckets, ...billing];
      // First org that yields any data wins — avoids merging unrelated orgs'
      // numbers together when a user belongs to several. Pin it for next
      // poll, and stamp the org into each label so it's visible which org
      // the numbers belong to even if the pin later changes.
      if (combined.length > 0) {
        this.pinnedOrgSlug = slug;
        return { buckets: combined.map(b => ({ ...b, label: `${b.label} (${slug})` })), notes };
      }
    }
    return { buckets: [], notes };
  }

  /** Two-step read of the reports API: the `latest` pointer, then the NDJSON
   * body behind its signed download link. */
  private async fetchReportRecords(
    reportUrl: string,
    orgHeaders: Record<string, string>,
  ): Promise<{ records: Array<Record<string, unknown>>; status: number }> {
    const pointer = await httpsGetJson(reportUrl, {
      ...orgHeaders,
      'X-GitHub-Api-Version': REPORTS_API_VERSION,
    }).catch(() => null);
    if (!pointer) return { records: [], status: 0 };
    if (pointer.status >= 400) return { records: [], status: pointer.status };

    const links = (pointer.json as { download_links?: unknown } | undefined)?.download_links;
    if (!Array.isArray(links)) return { records: [], status: pointer.status };

    const records: Array<Record<string, unknown>> = [];
    for (const link of links) {
      if (typeof link !== 'string' || !link) continue;
      // Pre-signed storage URL: send NO GitHub credentials with it.
      const body = await httpsGetJson(link, { 'User-Agent': 'aioversight' }).catch(() => null);
      if (!body || body.status >= 400) continue;
      records.push(...parseNdjson(body.raw));
    }
    return { records, status: pointer.status };
  }

  private async fetchOrgReport(
    slug: string,
    orgHeaders: Record<string, string>,
    explicitOrg: boolean,
  ): Promise<OrgEnrichment> {
    const url =
      `https://api.github.com/orgs/${encodeURIComponent(slug)}` +
      '/copilot/metrics/reports/organization-28-day/latest';
    const { records, status } = await this.fetchReportRecords(url, orgHeaders);
    if (status === 403) {
      // Verified 2026-09-16: a non-admin token gets "Insufficient permissions.
      // This action requires admin, or relevant organization role access."
      return {
        buckets: [],
        notes: explicitOrg
          ? [`Org metrics for ${slug} need org-admin (or "View Organization Copilot Metrics") access.`]
          : [],
      };
    }
    return { buckets: parseOrgReport(records), notes: [] };
  }

  private async fetchOrgAiCreditsBucket(
    slug: string,
    orgHeaders: Record<string, string>,
  ): Promise<QuotaBucket | null> {
    const url =
      `https://api.github.com/orgs/${encodeURIComponent(slug)}` +
      '/copilot/metrics/reports/users-28-day/latest';
    const { records } = await this.fetchReportRecords(url, orgHeaders);
    return parseOrgAiCredits(records);
  }

  private async fetchOrgBillingUsage(slug: string, orgHeaders: Record<string, string>): Promise<QuotaBucket[]> {
    // GitHub documents this one under `/organizations/{org}/...`, not the
    // `/orgs/{org}/...` prefix every other endpoint in this file uses. The
    // `/orgs/` spelling stays as a fallback: it was what this code shipped
    // with, and GitHub has historically accepted both.
    const paths = [
      `https://api.github.com/organizations/${encodeURIComponent(slug)}/settings/billing/usage/summary`,
      `https://api.github.com/orgs/${encodeURIComponent(slug)}/settings/billing/usage/summary`,
    ];
    for (const billingUrl of paths) {
      const billing = await httpsGetJson(billingUrl, orgHeaders).catch(() => null);
      if (!billing || billing.status >= 400) continue;
      const buckets = parseOrgBillingUsage(billing.json as Record<string, unknown>);
      if (buckets.length > 0) return buckets;
    }
    return [];
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
