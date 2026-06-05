import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ConnectorContext, QuotaBucket, QuotaProvider, QuotaSnapshot } from '../types';
import { readChromiumCookie } from '../shared/chromium-cookies';

const API_BASE = 'https://api2.cursor.sh';
const COOKIE_USAGE_URL = 'https://cursor.com/api/usage-summary';
const TOKEN_KEY = 'cursorAuth/accessToken';
const MEMBERSHIP_KEY = 'cursorAuth/stripeMembershipType';

/** Platform-default path to Cursor's VS Code-style global state database. */
export function defaultCursorStateDbPath(): string {
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    case 'win32':
      return path.join(
        process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
        'Cursor',
        'User',
        'globalStorage',
        'state.vscdb',
      );
    default:
      return path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
}

async function readCursorStateValue(dbPath: string, key: string): Promise<string | null> {
  if (!fs.existsSync(dbPath)) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sqlJsModule = require('sql.js') as
    & { default?: typeof import('sql.js') }
    & typeof import('sql.js');
  const initSqlJs = (typeof sqlJsModule === 'function' ? sqlJsModule : sqlJsModule.default)!;
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  const db = new SQL.Database(fs.readFileSync(dbPath));
  try {
    const escaped = key.replace(/'/g, "''");
    const rows = db.exec(`SELECT value FROM ItemTable WHERE key = '${escaped}' LIMIT 1`);
    const val = rows[0]?.values?.[0]?.[0];
    return typeof val === 'string' ? val : val != null ? String(val) : null;
  } finally {
    db.close();
  }
}

interface UsageCounter {
  enabled?: boolean;
  used?: number;
  limit?: number | null;
  remaining?: number | null;
}

function pushBucket(
  buckets: QuotaBucket[],
  id: string,
  label: string,
  counter: UsageCounter | undefined,
  unit: QuotaBucket['unit'],
): void {
  if (!counter || counter.enabled === false) return;
  const used = Number(counter.used ?? 0);
  const limit = counter.limit == null ? null : Number(counter.limit);
  const remaining =
    counter.remaining != null
      ? Number(counter.remaining)
      : limit != null
        ? Math.max(0, limit - used)
        : null;
  buckets.push({ id, label, used, limit, remaining, unit, enabled: true });
}

async function httpsGetJson(url: string, headers: Record<string, string>): Promise<unknown> {
  // Prefer Electron's net.fetch — it uses the OS certificate store and avoids
  // Node's occasional corporate-proxy TLS issues.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { net } = require('electron') as typeof import('electron');
    if (net?.fetch) {
      const res = await net.fetch(url, { headers });
      if (!res.ok) throw new Error(`Cursor API ${res.status}`);
      return await res.json();
    }
  } catch (err) {
    const msg = String(err);
    if (msg.includes('Cursor API')) throw err;
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const https = require('https') as typeof import('https');
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Cursor API ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body || '{}'));
        } catch {
          reject(new Error('Invalid JSON from Cursor API'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error('Cursor API timeout')));
  });
}

interface ParsedSummary {
  membershipType: string;
  limitType?: string;
  billingCycleStart?: string;
  billingCycleEnd?: string;
  displayMessages: string[];
  buckets: QuotaBucket[];
}

function parseUsageSummary(json: Record<string, unknown>): ParsedSummary {
  const membershipType = String(json.membershipType ?? 'unknown');
  const limitType = json.limitType != null ? String(json.limitType) : undefined;
  const displayMessages: string[] = [];
  if (typeof json.autoModelSelectedDisplayMessage === 'string') {
    displayMessages.push(json.autoModelSelectedDisplayMessage);
  }
  if (typeof json.namedModelSelectedDisplayMessage === 'string') {
    displayMessages.push(json.namedModelSelectedDisplayMessage);
  }
  const buckets: QuotaBucket[] = [];
  const individual = json.individualUsage as Record<string, UsageCounter> | undefined;
  if (individual?.overall) {
    pushBucket(buckets, 'individual-overall', 'Your included usage', individual.overall, 'credits');
  }
  const team = json.teamUsage as Record<string, UsageCounter> | undefined;
  if (team?.onDemand) {
    pushBucket(buckets, 'team-on-demand', 'Team on-demand pool', team.onDemand, 'credits');
  }
  return {
    membershipType,
    limitType,
    billingCycleStart: typeof json.billingCycleStart === 'string' ? json.billingCycleStart : undefined,
    billingCycleEnd: typeof json.billingCycleEnd === 'string' ? json.billingCycleEnd : undefined,
    displayMessages,
    buckets,
  };
}

function parseLegacyUsage(json: Record<string, unknown>): QuotaBucket[] {
  const buckets: QuotaBucket[] = [];
  for (const [model, raw] of Object.entries(json)) {
    if (model === 'startOfMonth' || typeof raw !== 'object' || raw == null) continue;
    const m = raw as Record<string, unknown>;
    const used = Number(m.numRequests ?? m.numRequestsTotal ?? 0);
    const limit = m.maxRequestUsage != null ? Number(m.maxRequestUsage) : null;
    if (limit == null && used === 0) continue;
    buckets.push({
      id: `model-${model}`,
      label: `${model} requests`,
      used,
      limit,
      remaining: limit != null ? Math.max(0, limit - used) : null,
      unit: 'requests',
      enabled: true,
    });
  }
  return buckets;
}

/** Fetch current Cursor quota: bearer token first, WorkosCursorSessionToken cookie fallback. */
class CursorQuotaProvider implements QuotaProvider {
  constructor(
    private readonly stateDbPath: string,
    private readonly ctx: ConnectorContext,
  ) {}

  async fetch(): Promise<QuotaSnapshot> {
    const fetchedAt = Date.now();
    const failures: string[] = [];
    const hasStateDb = fs.existsSync(this.stateDbPath);

    if (hasStateDb) {
      let token: string | null = null;
      try {
        token = await readCursorStateValue(this.stateDbPath, TOKEN_KEY);
      } catch (err) {
        failures.push(`Could not read Cursor database: ${String(err)}`);
      }
      if (token) {
        try {
          return await this.fetchWithBearer(token, fetchedAt);
        } catch (err) {
          failures.push(`Access token API: ${String(err)}`);
        }
      } else if (failures.length === 0) {
        failures.push('No Cursor access token in local database');
      }
    } else {
      failures.push('Cursor state database not found');
    }

    try {
      return await this.fetchWithCookie(fetchedAt);
    } catch (err) {
      failures.push(`Session cookie API: ${String(err)}`);
      return {
        ok: false,
        fetchedAt,
        error: `Could not fetch Cursor usage (${failures.join('; ')}).`,
        source: hasStateDb ? this.stateDbPath : undefined,
      };
    }
  }

  private async fetchWithBearer(token: string, fetchedAt: number): Promise<QuotaSnapshot> {
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    const summaryJson = (await httpsGetJson(`${API_BASE}/auth/usage-summary`, headers)) as Record<
      string,
      unknown
    >;
    const parsed = parseUsageSummary(summaryJson);

    if (parsed.buckets.length === 0) {
      const legacyJson = (await httpsGetJson(`${API_BASE}/auth/usage`, headers)) as Record<
        string,
        unknown
      >;
      parsed.buckets.push(...parseLegacyUsage(legacyJson));
      if (typeof legacyJson.startOfMonth === 'string' && !parsed.billingCycleStart) {
        parsed.billingCycleStart = legacyJson.startOfMonth;
      }
    }

    await this.enrichFromStateDb(parsed);
    return {
      ok: true,
      fetchedAt,
      ...parsed,
      authMethod: 'bearer',
      source: this.stateDbPath,
    };
  }

  private async fetchWithCookie(fetchedAt: number): Promise<QuotaSnapshot> {
    const cookie = await readChromiumCookie(
      { appName: 'Cursor' },
      { cookieName: 'WorkosCursorSessionToken', hostPatterns: ['%cursor.com%'] },
    );
    if (!cookie) {
      throw new Error('No WorkosCursorSessionToken cookie found (sign in at cursor.com in a browser)');
    }
    const headers = { Cookie: `WorkosCursorSessionToken=${cookie}`, Accept: 'application/json' };
    const summaryJson = (await httpsGetJson(COOKIE_USAGE_URL, headers)) as Record<string, unknown>;
    const parsed = parseUsageSummary(summaryJson);
    await this.enrichFromStateDb(parsed);
    return {
      ok: true,
      fetchedAt,
      ...parsed,
      authMethod: 'cookie',
      source: COOKIE_USAGE_URL,
    };
  }

  private async enrichFromStateDb(parsed: ParsedSummary): Promise<void> {
    if (!fs.existsSync(this.stateDbPath)) return;
    try {
      const membershipFromDb = await readCursorStateValue(this.stateDbPath, MEMBERSHIP_KEY);
      if (membershipFromDb && parsed.membershipType === 'unknown') {
        parsed.membershipType = membershipFromDb;
      }
    } catch {
      // optional enrichment
    }
  }
}

export function createCursorQuotaProvider(
  config: Record<string, unknown>,
  ctx: ConnectorContext,
): QuotaProvider {
  const stateDbPath = (config.stateDbPath as string | undefined)?.trim() || defaultCursorStateDbPath();
  return new CursorQuotaProvider(ctx.resolvePath(stateDbPath), ctx);
}
