import { ConnectorContext, QuotaBucket, QuotaProvider, QuotaSnapshot } from '../types';

/**
 * Antigravity quota provider — reads the quota from Antigravity's own local
 * language server, which only exists while the app is running.
 *
 * CONFIDENCE NOTES (read before trusting a number) — Antigravity is not
 * installed on this dev machine, so none of this was verified against a live
 * instance. The sourcing below is nevertheless much stronger than the port
 * guessing it replaces:
 *
 * 1. DISCOVERY IS PROCESS-BASED [C, multiple independent tools agree]. The
 *    language server's port is EPHEMERAL — no fixed range exists, and the
 *    `49500-49529` range earlier versions of this file scanned was an
 *    outright guess presented as if it were known. Comparable tools instead
 *    locate the running `language_server*` process whose command line
 *    contains `--app_data_dir antigravity`, and read `--csrf_token`,
 *    `--extension_server_port` and `--extension_server_csrf_token` straight
 *    out of its arguments. Shelling out for this matches the house style
 *    already set by `shared/chromium-cookies.ts`.
 * 2. The port scan is KEPT, but only as a last resort after process
 *    discovery finds nothing, and its range is no longer described as known.
 * 3. The CSRF header is `X-Codeium-Csrf-Token` [C]. This file previously
 *    sent `X-CSRF-Token`, which the server would not have recognised.
 * 4. The request body carries an IDE metadata envelope [C] rather than `{}`.
 * 5. `RetrieveUserQuotaSummary` is the preferred RPC, with `GetUserStatus`
 *    as the legacy fallback [C]. Response shape:
 *      response.groups[].displayName
 *      response.groups[].buckets[].{bucketId,displayName,description,
 *                                   remaining:{remainingFraction}}
 *    Some tools see `groups[]` at the top level rather than under
 *    `response`, so both are handled. The legacy shape is
 *    `userStatus.cascadeModelConfigData.clientModelConfigs[].quotaInfo`
 *    carrying `remainingFraction` and `resetTime` per model.
 * 6. `remainingFraction` is REMAINING, not used: a 0..1 fraction, so
 *    used% = (1 - fraction) * 100. Reading it as "used" would invert every
 *    meter.
 * 7. Tools disagree on the scheme (`https://` vs `http://`), so both are
 *    tried against each candidate port.
 *
 * Deliberately NOT implemented: any OS-credential-store fallback for when
 * Antigravity is closed. There is no login flow for this connector, so a
 * failure to find the server is never `needsLogin: true` — it is reported
 * plainly, telling the user the app has to be running.
 */

// --- Port range parsing ------------------------------------------------------

/**
 * Last-resort scan range (file-header note 2). This is NOT the language
 * server's real port range — the port is ephemeral and no fixed range
 * exists. It is only a small window to sweep when process discovery has
 * already failed, and a user who has read the real port off `netstat` can
 * override it.
 */
export const DEFAULT_PORT_RANGE = '49500-49529';

/**
 * Sanity ceiling on the total ports a configured range can expand to.
 *
 * WARNING FIX: this used to be a hard 64-port cap applied silently, which
 * meant a user who widened `portRange` (the config field's own help text
 * invites this once they've found the real port via Task Manager / netstat)
 * could have that real port fall past position 64 and NEVER get scanned --
 * the connector would then keep reporting the honest-looking-but-wrong "not
 * running" error forever, even while Antigravity genuinely was running on an
 * unscanned port within the user's own configured range.
 *
 * Fix: `scanForLanguageServer` now scans in budget-bounded CHUNKS (see
 * `SCAN_CHUNK_SIZE`), so the real backstop against runaway scan time is
 * `SCAN_TOTAL_BUDGET_MS`, not a port-count cap -- a moderately widened range
 * (tens to low hundreds of ports) scans to completion well within budget
 * (refused-connection probes resolve near-instantly, not after the full
 * per-port timeout). This constant is now just a defensive ceiling against a
 * pathological paste of the entire port space (e.g. "1-65535"), generous
 * enough that no realistic user-narrowed range should ever hit it.
 */
export const MAX_PORT_RANGE_SPAN = 4096;

export interface ParsedPortRange {
  ports: number[];
  /** The raw `end - start + 1` span the user configured, BEFORE any
   * `MAX_PORT_RANGE_SPAN` capping. Compare against `ports.length` to detect
   * whether capping actually dropped anything. */
  requestedSpan: number;
}

/**
 * Parses a `"<start>-<end>"` port range string into a sorted, deduped list of
 * ports (plus the originally-requested span, for truncation detection).
 * Falls back to `DEFAULT_PORT_RANGE` on anything malformed (non-numeric,
 * reversed, out of the valid TCP port space) rather than scanning zero ports
 * or throwing. Exported for smoke coverage.
 */
export function parsePortRangeInfo(raw: string | undefined | null): ParsedPortRange {
  const fallback = parsePortRangeStrict(DEFAULT_PORT_RANGE) ?? { ports: [], requestedSpan: 0 };
  if (!raw || !raw.trim()) return fallback;
  const parsed = parsePortRangeStrict(raw.trim());
  return parsed && parsed.ports.length > 0 ? parsed : fallback;
}

/** Convenience wrapper over `parsePortRangeInfo` for callers that only need
 * the port list. Exported for smoke coverage. */
export function parsePortRange(raw: string | undefined | null): number[] {
  return parsePortRangeInfo(raw).ports;
}

function parsePortRangeStrict(raw: string): ParsedPortRange | null {
  const m = raw.match(/^(\d{1,5})\s*-\s*(\d{1,5})$/);
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 1 || start > 65535 || end < 1 || end > 65535 || end < start) return null;

  const requestedSpan = end - start + 1;
  const cappedEnd = Math.min(end, start + MAX_PORT_RANGE_SPAN - 1);
  const ports: number[] = [];
  for (let p = start; p <= cappedEnd; p++) ports.push(p);
  return { ports, requestedSpan };
}

// --- Local HTTP helper (short, configurable timeout — NOT the 15s external- -
// --- API pattern; localhost probes must be much cheaper) --------------------
//
// Same AbortController + clean-abort-to-408 shape as github-copilot/quota.ts's
// `httpsGetJson`, parameterized on timeout since a port-scan probe (~300ms)
// and a found-server data query (a few seconds) need very different budgets.

interface LocalHttpResult {
  status: number;
  json: unknown;
}

async function httpJsonLocal(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  timeoutMs: number,
): Promise<LocalHttpResult> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { net } = require('electron') as typeof import('electron');
    if (net?.fetch) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await net.fetch(url, {
          method: init.method ?? 'GET',
          headers: init.headers,
          body: init.body,
          signal: controller.signal,
          // Defense-in-depth only (the RPC call always re-targets a
          // hardcoded loopback URL regardless of any redirect, so this
          // isn't guarding a live vulnerability): never silently follow a
          // redirect off of the localhost probe/query target.
          redirect: 'manual',
        });
        const txt = await res.text();
        try {
          return { status: res.status, json: txt ? JSON.parse(txt) : {} };
        } catch {
          return { status: res.status, json: {} };
        }
      } catch (err) {
        // A deliberate timeout-abort just means this port isn't it (or is
        // slow) — fail closed to 408 rather than retrying via a different
        // transport at the SAME cost, which would double scan latency.
        if (controller.signal.aborted) {
          return { status: 408, json: {} };
        }
        // Any OTHER net.fetch failure (most commonly ECONNREFUSED — nothing
        // listening on this port, the expected common case across most of a
        // scan) must resolve to a clean "not it" here too, NOT fall through
        // to the Node http branch below. Unlike github-copilot/zai/devin's
        // single external-API call, this function is invoked once per
        // scanned port — falling through would mean every refused port pays
        // BOTH transports' connection-refused cost, doubling real scan time.
        return { status: 0, json: {} };
      } finally {
        clearTimeout(timer);
      }
    }
  } catch {
    // require('electron') itself failed (e.g. headless smoke tests) — this
    // is the only case that legitimately falls through to Node's http.
  }

  // Pick the module by scheme: candidate URLs now include `https://` (see
  // file-header note 7), and `http.request` on an https URL throws
  // ERR_INVALID_PROTOCOL synchronously rather than failing softly.
  let transport: typeof import('http') | typeof import('https');
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    transport = new URL(url).protocol === 'https:'
      ? (require('https') as typeof import('https'))
      : (require('http') as typeof import('http'));
  } catch {
    return Promise.resolve({ status: 0, json: {} });
  }

  return new Promise(resolve => {
    const headers = { ...(init.headers ?? {}) };
    if (init.body) headers['Content-Length'] = String(Buffer.byteLength(init.body));
    const req = transport.request(url, { method: init.method ?? 'GET', headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: res.statusCode ?? 0, json: body ? JSON.parse(body) : {} });
        } catch {
          resolve({ status: res.statusCode ?? 0, json: {} });
        }
      });
    });
    // Connection errors (most ports: ECONNREFUSED, nothing listening) are the
    // expected common case during a scan — resolve to a clean "not it"
    // rather than rejecting/crashing the whole scan.
    req.on('error', () => resolve({ status: 0, json: {} }));
    // Passing an Error to destroy() (unlike a bare destroy()) reliably fires
    // the 'error' listener above, which is what actually resolves this
    // promise -- a bare destroy() is not guaranteed to emit 'error', which
    // would leave this promise unsettled and wedge the RPC query call that
    // uses this same helper (the port-scan side is protected by
    // scanForLanguageServer's separate overall-budget race, but a query has
    // no such backstop).
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Antigravity local request timed out after ${timeoutMs}ms`)));
    if (init.body) req.write(init.body);
    req.end();
  });
}

// --- Process-based discovery (see file-header note 1) ----------------------

/** One running process, as returned by whichever platform lister ran. */
export interface ProcessEntry {
  pid: number;
  cmdline: string;
}

export interface LanguageServerInfo {
  pid: number;
  csrfToken?: string;
  extensionServerCsrfToken?: string;
  extensionServerPort?: number;
}

/**
 * Pulls `--flag value` and `--flag=value` pairs out of a command line.
 * Quoted values are unwrapped. Exported for test coverage.
 */
export function parseProcessArgs(cmdline: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Split on whitespace that is not inside quotes.
  const tokens = cmdline.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const unquote = (s: string): string =>
    (s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")) ? s.slice(1, -1) : s;

  for (let i = 0; i < tokens.length; i++) {
    const token = unquote(tokens[i]);
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq > 2) {
      out[token.slice(2, eq)] = unquote(token.slice(eq + 1));
      continue;
    }
    const next = tokens[i + 1];
    if (next != null && !unquote(next).startsWith('--')) {
      out[token.slice(2)] = unquote(next);
      i++;
    }
  }
  return out;
}

/**
 * Recognises an Antigravity language-server process and lifts its tokens and
 * port out of the command line. Requires BOTH a `language_server` executable
 * and an `--app_data_dir` naming antigravity, so a sibling Codeium/Windsurf
 * language server on the same machine is not mistaken for this one. Returns
 * `null` for anything else. Exported for test coverage.
 */
export function parseLanguageServerCmdline(entry: ProcessEntry): LanguageServerInfo | null {
  if (!/language_server/i.test(entry.cmdline)) return null;
  const args = parseProcessArgs(entry.cmdline);
  const appDataDir = args.app_data_dir ?? '';
  if (!/antigravity/i.test(appDataDir)) return null;

  const port = Number(args.extension_server_port);
  return {
    pid: entry.pid,
    csrfToken: args.csrf_token || undefined,
    extensionServerCsrfToken: args.extension_server_csrf_token || undefined,
    extensionServerPort: Number.isFinite(port) && port > 0 ? port : undefined,
  };
}

/**
 * Listening TCP ports belonging to `pid`, from `netstat -ano` output.
 * Exported for test coverage.
 */
export function parseNetstatListeningPorts(text: string, pid: number): number[] {
  const ports: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    if (!/^TCP$/i.test(parts[0])) continue;
    if (!/^LISTENING$/i.test(parts[3])) continue;
    if (Number(parts[4]) !== pid) continue;
    const port = Number(parts[1].slice(parts[1].lastIndexOf(':') + 1));
    if (Number.isFinite(port) && port > 0 && !ports.includes(port)) ports.push(port);
  }
  return ports.sort((a, b) => a - b);
}

/**
 * Listening TCP ports from `lsof -nP -iTCP -sTCP:LISTEN` output (macOS and
 * Linux). Exported for test coverage.
 */
export function parseLsofListeningPorts(text: string): number[] {
  const ports: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/:(\d+)\s+\(LISTEN\)/);
    if (!m) continue;
    const port = Number(m[1]);
    if (Number.isFinite(port) && port > 0 && !ports.includes(port)) ports.push(port);
  }
  return ports.sort((a, b) => a - b);
}

/**
 * `Get-CimInstance ... | ConvertTo-Json` emits a bare object for a single
 * match and an array for several. Exported for test coverage.
 */
export function parseWin32ProcessJson(text: string): ProcessEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const out: ProcessEntry[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const pid = Number(r.ProcessId);
    const cmdline = typeof r.CommandLine === 'string' ? r.CommandLine : '';
    if (Number.isFinite(pid) && cmdline) out.push({ pid, cmdline });
  }
  return out;
}

const SHELL_TIMEOUT_MS = 3000;

function runCommand(file: string, args: string[]): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execFileSync } = require('child_process') as typeof import('child_process');
    return execFileSync(file, args, {
      encoding: 'utf8',
      timeout: SHELL_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    // A missing tool, a non-zero exit, or a timeout all mean "no answer".
    return null;
  }
}

/** Running processes, per platform. Returns `[]` when nothing can be listed. */
function listProcesses(): ProcessEntry[] {
  if (process.platform === 'win32') {
    // `tasklist` alone does not report command lines, so CIM is used. A
    // single call returns the whole command line, which is all we need.
    const out = runCommand('powershell.exe', [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name like 'language_server%'\" | " +
        'Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
    ]);
    return out ? parseWin32ProcessJson(out) : [];
  }

  if (process.platform === 'linux') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    const out: ProcessEntry[] = [];
    let pids: string[];
    try {
      pids = fs.readdirSync('/proc').filter(n => /^\d+$/.test(n));
    } catch {
      return [];
    }
    for (const pid of pids) {
      try {
        // /proc/<pid>/cmdline separates arguments with NUL bytes.
        const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if (!raw) continue;
        out.push({ pid: Number(pid), cmdline: raw.replace(/\0/g, ' ').trim() });
      } catch {
        // Process exited between readdir and read, or is not ours to read.
      }
    }
    return out;
  }

  const out = runCommand('ps', ['-Ao', 'pid=,command=']);
  if (!out) return [];
  const entries: ProcessEntry[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    entries.push({ pid: Number(m[1]), cmdline: m[2] });
  }
  return entries;
}

/** Listening ports for a pid, used when the command line carries no port. */
function listeningPortsFor(pid: number): number[] {
  if (process.platform === 'win32') {
    const out = runCommand('netstat', ['-ano', '-p', 'TCP']);
    return out ? parseNetstatListeningPorts(out, pid) : [];
  }
  const out = runCommand('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(pid)]);
  return out ? parseLsofListeningPorts(out) : [];
}

/**
 * Finds the running Antigravity language server. `listProcesses` is
 * injectable so tests never spawn a real process. Exported for test coverage.
 */
export function discoverLanguageServer(
  processes: ProcessEntry[] = listProcesses(),
): LanguageServerInfo | null {
  for (const entry of processes) {
    const info = parseLanguageServerCmdline(entry);
    if (info) return info;
  }
  return null;
}

/**
 * Every base URL worth trying for a discovered server, in priority order:
 * the port from the command line first, then any other port the process is
 * listening on, each over both schemes (file-header note 7). Exported for
 * test coverage.
 */
export function candidateBaseUrls(info: LanguageServerInfo, extraPorts: number[] = []): string[] {
  const ports: number[] = [];
  if (info.extensionServerPort != null) ports.push(info.extensionServerPort);
  for (const p of extraPorts) if (!ports.includes(p)) ports.push(p);

  const urls: string[] = [];
  for (const port of ports) {
    for (const scheme of ['https', 'http']) {
      urls.push(`${scheme}://127.0.0.1:${port}${RPC_SERVICE_PATH}`);
    }
  }
  return urls;
}

/** The CSRF tokens to try, most specific first (file-header note 1). */
export function candidateCsrfTokens(info: LanguageServerInfo): Array<string | null> {
  const tokens: Array<string | null> = [];
  if (info.extensionServerCsrfToken) tokens.push(info.extensionServerCsrfToken);
  if (info.csrfToken && info.csrfToken !== info.extensionServerCsrfToken) tokens.push(info.csrfToken);
  if (tokens.length === 0) tokens.push(null);
  return tokens;
}

// --- Port-scan discovery (last resort, see file-header note 2) --------------

const PROBE_TIMEOUT_MS = 300; // per-port — must stay far below the scan's total budget.
const SCAN_TOTAL_BUDGET_MS = 4000; // whole-scan safety net regardless of port count.
const QUERY_TIMEOUT_MS = 3000; // once a port is found, this is a single localhost call.
/** Ports probed concurrently within one scan chunk. Chunking (rather than
 * firing every configured port at once) keeps a widened `portRange` bounded
 * by wall-clock time (`SCAN_TOTAL_BUDGET_MS`) instead of relying on an
 * arbitrary port-count cap to prevent unbounded concurrency — see
 * `MAX_PORT_RANGE_SPAN`'s doc comment for the bug this replaced. */
const SCAN_CHUNK_SIZE = 64;

/**
 * Races an async operation against a total time budget, resolving to `null`
 * if the budget elapses first. Shared by the port-scan phase
 * (`scanForLanguageServer`) and the post-discovery query phase
 * (`queryQuotaDataWithBudget`) so both follow the identical time-bounding
 * discipline -- the query phase previously had NO overall ceiling across its
 * `RPC_METHODS` fallback loop (each individual attempt had its own
 * `QUERY_TIMEOUT_MS`, but nothing capped the whole loop), so a
 * discovered-but-stalling server could make `fetch()` hang for the sum of
 * all per-method timeouts, awaited directly by the `quota:refresh` IPC
 * handler with no cancel.
 */
async function raceWithBudget<T>(op: () => Promise<T>, totalBudgetMs: number): Promise<T | null> {
  const timeout = new Promise<null>(resolve => setTimeout(() => resolve(null), totalBudgetMs));
  return Promise.race([op(), timeout]);
}

/**
 * Best-effort match test for a probe response body (see file-header note 3).
 * Deliberately conservative: an empty/malformed body, or a body with none of
 * the expected fields, is NOT a match — a bare 200 alone is not enough
 * evidence this is the Antigravity server rather than some unrelated local
 * service. Exported for smoke coverage.
 */
export function looksLikeAntigravityServer(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const obj = body as Record<string, unknown>;
  // Deliberately narrow — generic keys like "sessionId" or "ideVersion" are
  // common enough across unrelated local dev servers that accepting them
  // risks identifying the WRONG local service and then POSTing quota-RPC
  // calls to it. Only names that specifically imply Antigravity/its known
  // lineage (Codeium/Windsurf) qualify.
  const candidateKeys = ['csrfToken', 'csrf_token', 'antigravity', 'languageServerVersion', 'windsurfVersion'];
  return candidateKeys.some(k => typeof obj[k] === 'string' && (obj[k] as string).length > 0);
}

/** Pulls whichever CSRF-token-shaped field matched, so it can be replayed on
 * the follow-up query call. Exported for smoke coverage. */
export function extractCsrfToken(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;
  return firstString(obj.csrfToken, obj.csrf_token);
}

/** GUESS (see file-header note 3) — plausible lightweight discovery path. */
const PROBE_PATH = '/';

export interface ScanMatch {
  port: number;
  /** Present when the probe response carried a recognisable CSRF token — see
   * file-header note 3. `null` when the server matched but no token field
   * was found, in which case the follow-up query call is sent without one. */
  csrfToken: string | null;
}

async function probePort(port: number): Promise<ScanMatch | null> {
  try {
    const res = await httpJsonLocal(`http://127.0.0.1:${port}${PROBE_PATH}`, { method: 'GET' }, PROBE_TIMEOUT_MS);
    if (res.status !== 200) return null;
    if (!looksLikeAntigravityServer(res.json)) return null;
    return { port, csrfToken: extractCsrfToken(res.json) };
  } catch {
    return null;
  }
}

/**
 * Scans `ports` in fixed-size chunks (each chunk probed concurrently, ports
 * within a chunk in ascending order so the first chunk with any match yields
 * the deterministic lowest-port winner), the WHOLE multi-chunk operation
 * wrapped in one overall budget so the detection phase can never run away —
 * this matters both because quota polling runs on a schedule (a slow scan
 * would compound across polls) and because a widened `portRange` no longer
 * has its tail silently dropped by a port-count cap (see
 * `MAX_PORT_RANGE_SPAN`): time, not count, is what's bounded here. Returns
 * the lowest matching port (with its CSRF token, if the probe response
 * carried one), or `null` when nothing in range answered before the budget
 * elapsed. Exported for smoke coverage (with an injectable `probe` so the
 * test doesn't need a real socket).
 */
export async function scanForLanguageServer(
  ports: number[],
  probe: (port: number) => Promise<ScanMatch | null> = probePort,
  totalBudgetMs: number = SCAN_TOTAL_BUDGET_MS,
): Promise<ScanMatch | null> {
  if (ports.length === 0) return null;

  return raceWithBudget(async () => {
    for (let i = 0; i < ports.length; i += SCAN_CHUNK_SIZE) {
      const chunk = ports.slice(i, i + SCAN_CHUNK_SIZE);
      const results = await Promise.all(chunk.map(port => probe(port)));
      const matches = results.filter((m): m is ScanMatch => m != null).sort((a, b) => a.port - b.port);
      if (matches.length > 0) return matches[0];
    }
    return null;
  }, totalBudgetMs);
}

// --- Quota query + parsing ----------------------------------------------------

// Preferred first, legacy second (file-header note 5); the first method that
// returns a recognisable shape wins.
const RPC_METHODS = ['RetrieveUserQuotaSummary', 'GetUserStatus', 'GetCommandModelConfigs'];
const RPC_SERVICE_PATH = '/exa.language_server_pb.LanguageServerService';

/** The CSRF header this server expects (file-header note 3). */
export const CSRF_HEADER = 'X-Codeium-Csrf-Token';

/** The IDE metadata envelope the server expects (file-header note 4). */
export const RPC_REQUEST_BODY = JSON.stringify({
  metadata: {
    ideName: 'antigravity',
    extensionName: 'antigravity',
    locale: 'en',
    ideVersion: 'unknown',
  },
});
/** Overall ceiling across the WHOLE `RPC_METHODS` fallback loop -- see
 * `raceWithBudget`'s doc comment for the hang this closes. 3 methods x
 * `QUERY_TIMEOUT_MS` (3000ms) each could otherwise take up to ~9s with no
 * cancel; this keeps a single `quota:refresh` call bounded. */
const QUERY_TOTAL_BUDGET_MS = 7000;

function firstFiniteNumber(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim() === '') continue;
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

/**
 * Normalizes a raw epoch value that might be seconds or milliseconds — same
 * heuristic as `devin/quota.ts`'s `resetsAtFrom` (values below 1e10 read as
 * seconds and get multiplied up; at/above 1e10 are treated as already-ms),
 * since the exact convention this API uses is unverified (see file-header
 * note 5). Not hoisted to a shared module since this codebase's quota.ts
 * files are self-contained per connector by convention. Exported for smoke
 * coverage.
 */
export function normalizeEpochMs(raw: number): number {
  return raw > 1e10 ? raw : raw * 1000;
}

/** Never pair a real observed `resetsAt` with a synthesized `windowMs` — same
 * discipline as `zai/quota.ts`'s `resolveWindowPairing` / `devin/quota.ts`'s
 * copy of it. Exported for smoke coverage. */
export function resolveWindowPairing(
  observedWindowMs: number | null,
  observedResetsAt: number | null,
  fallbackWindowMs: number,
): { windowMs: number; resetsAt?: number } {
  const windowMs = observedWindowMs ?? fallbackWindowMs;
  if (observedWindowMs != null && observedResetsAt != null) {
    return { windowMs, resetsAt: observedResetsAt };
  }
  return { windowMs };
}

const SESSION_WINDOW_MS = 18_000_000; // 5h, matches every other Phase 5 connector's "session" window
const WEEKLY_WINDOW_MS = 604_800_000; // 7d
const ONE_DAY_MS = 86_400_000;

export type QuotaPool = 'gemini' | 'other';
export type QuotaWindowKind = '5h' | 'weekly';

export interface RawModelQuotaEntry {
  modelId: string;
  usedPercent: number;
  resetsAt: number | null;
  windowMs: number | null;
  /** Always populated (never null) on entries `extractQuotaEntries` emits —
   * an entry whose window can't be classified is dropped there rather than
   * carried forward with a guessed value. See `classifyWindowKind`. */
  windowKind: QuotaWindowKind;
}

/**
 * Classifies a model id into one of the plan's two shared pools: "Gemini
 * (Pro/Flash)" or "non-Gemini (Claude/GPT-OSS)". Unrecognised model ids fall
 * into the non-Gemini pool (the broader, catch-all bucket per the plan's
 * naming), never dropped silently. Exported for smoke coverage.
 */
export function poolForModel(modelId: string): QuotaPool {
  return /gemini/i.test(modelId) ? 'gemini' : 'other';
}

/**
 * Classifies a window into '5h' (session-length) or 'weekly' — duration
 * first (sub-daily -> '5h', >= 1 day -> 'weekly'), then, when no duration
 * was observed, a name-based heuristic over `hint` (whatever type/period/
 * label text came with the entry), same two-tier approach as `zai/quota.ts`'s
 * `parseQuotaItems`. Returns `null` — never a guessed default — when NEITHER
 * signal resolves: this is a genuinely unverified response shape, and
 * silently defaulting every unclassifiable entry into '5h' would (a) drop
 * every real weekly figure and (b) risk displaying a weekly number under the
 * permanent 'gemini-5h' / 'other-5h' bucket id, corrupting that id's meaning
 * across polls (the same class of bug devin/quota.ts's WARNING fix guards
 * against for its weekly/daily fallback). Exported for smoke coverage.
 */
export function classifyWindowKind(windowMs: number | null, hint: string): QuotaWindowKind | null {
  if (windowMs != null) return windowMs < ONE_DAY_MS ? '5h' : 'weekly';
  const h = hint.toLowerCase();
  if (h.includes('week') || h.includes('7d')) return 'weekly';
  if (h.includes('session') || h.includes('5h') || h.includes('hour')) return '5h';
  return null;
}

/**
 * GUESS (see file-header note 5) — extracts a flat list of per-model quota
 * entries from whatever shape the RPC call returned. Probes several plausible
 * container paths and field names; a model entry with no usable
 * used/limit-or-percent figure is skipped, never defaulted to zero. Exported
 * for smoke coverage.
 */
export function extractQuotaEntries(json: unknown): RawModelQuotaEntry[] {
  if (!json || typeof json !== 'object') return [];
  const root = json as Record<string, unknown>;
  const list =
    (root.quotas ?? root.modelQuotas ?? root.model_quotas ?? root.quotaSummaries ?? root.data) ?? null;
  if (!Array.isArray(list)) return [];

  const out: RawModelQuotaEntry[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const modelId = firstString(item.model, item.modelId, item.model_id, item.name) ?? 'unknown';

    let usedPercent = firstFiniteNumber(item.usedPercent, item.used_percent, item.percentUsed, item.percent_used);
    if (usedPercent == null) {
      const used = firstFiniteNumber(item.used, item.count, item.quota_used);
      const limit = firstFiniteNumber(item.limit, item.quota_limit, item.max, item.total);
      if (used != null && limit != null && limit > 0) {
        usedPercent = (used / limit) * 100;
      }
    }
    if (usedPercent == null) continue;

    const windowSeconds = firstFiniteNumber(item.windowSeconds, item.window_seconds, item.periodSeconds);
    const windowMs = windowSeconds != null ? windowSeconds * 1000 : null;
    const resetsAtRaw = firstFiniteNumber(item.resetsAt, item.resets_at, item.resetTime, item.reset_time);
    const resetsAt = resetsAtRaw != null && resetsAtRaw > 0 ? normalizeEpochMs(resetsAtRaw) : null;

    const hint =
      firstString(item.type, item.windowType, item.window_type, item.period, item.quotaType, item.quota_type) ?? '';
    const windowKind = classifyWindowKind(windowMs, hint);
    // Neither a real duration nor a recognisable name hint -- drop the
    // entry rather than guessing which bucket it belongs in (see
    // classifyWindowKind's doc comment).
    if (windowKind == null) continue;

    out.push({
      modelId,
      usedPercent: Math.min(100, Math.max(0, usedPercent)),
      resetsAt,
      windowMs,
      windowKind,
    });
  }
  return out;
}

/**
 * Merges classified per-model entries into pool-level buckets, per the plan:
 * "merged by keeping each pool's worst remaining fraction across models in
 * the pool" — i.e. for each (pool, window) pair, the displayed number is
 * whichever model has the LOWEST remaining fraction (highest used%). A pure,
 * directly-testable function decoupled from HTTP/JSON parsing uncertainty.
 * Exported for smoke coverage.
 */
export function mergePoolQuota(entries: RawModelQuotaEntry[]): QuotaBucket[] {
  const worst = new Map<string, RawModelQuotaEntry>();

  for (const entry of entries) {
    const pool = poolForModel(entry.modelId);
    const window = entry.windowKind;
    const key = `${pool}:${window}`;
    const current = worst.get(key);
    if (!current || entry.usedPercent > current.usedPercent) {
      worst.set(key, entry);
    }
  }

  const POOL_LABEL: Record<QuotaPool, string> = {
    gemini: 'Gemini (Pro/Flash)',
    other: 'Non-Gemini (Claude/GPT-OSS)',
  };
  const WINDOW_LABEL: Record<QuotaWindowKind, string> = { '5h': '5h', weekly: 'Weekly' };
  const FALLBACK_WINDOW_MS: Record<QuotaWindowKind, number> = { '5h': SESSION_WINDOW_MS, weekly: WEEKLY_WINDOW_MS };

  const buckets: QuotaBucket[] = [];
  // Deterministic order: gemini before other, 5h before weekly — independent
  // of Map iteration order (insertion-dependent on response ordering).
  for (const pool of ['gemini', 'other'] as QuotaPool[]) {
    for (const window of ['5h', 'weekly'] as QuotaWindowKind[]) {
      const key = `${pool}:${window}`;
      const entry = worst.get(key);
      if (!entry) continue;
      const pairing = resolveWindowPairing(entry.windowMs, entry.resetsAt, FALLBACK_WINDOW_MS[window]);
      buckets.push({
        id: `${pool}-${window}`,
        label: `${POOL_LABEL[pool]} — ${WINDOW_LABEL[window]}`,
        used: entry.usedPercent,
        limit: 100,
        remaining: Math.max(0, 100 - entry.usedPercent),
        unit: 'percent',
        enabled: true,
        note: `Worst of this pool's models (${entry.modelId})`,
        ...pairing,
      });
    }
  }
  return buckets;
}

// --- RetrieveUserQuotaSummary parsing (primary, file-header notes 5-6) ----

/**
 * `remainingFraction` is a 0..1 REMAINING fraction, so used% inverts it.
 * Rounded to four decimals because `(1 - 0.9) * 100` evaluates to
 * 9.999999999999998 in binary floating point, and that artifact would
 * otherwise reach the UI. Exported for test coverage.
 */
export function usedPercentFromRemainingFraction(fraction: number): number {
  const used = (1 - fraction) * 100;
  return Math.min(100, Math.max(0, Math.round(used * 10_000) / 10_000));
}

/**
 * Buckets from the `groups[].buckets[]` shape. `groups` is read from
 * `response.groups` or from the top level, since tools report both. A bucket
 * with no numeric `remainingFraction` is skipped rather than shown as zero.
 * Exported for test coverage.
 */
export function parseQuotaSummary(json: unknown): QuotaBucket[] {
  if (!json || typeof json !== 'object') return [];
  const root = json as Record<string, unknown>;
  const response = (root.response && typeof root.response === 'object' ? root.response : root) as Record<string, unknown>;
  const groups = response.groups;
  if (!Array.isArray(groups)) return [];

  const buckets: QuotaBucket[] = [];
  const seen = new Set<string>();
  for (const rawGroup of groups) {
    if (!rawGroup || typeof rawGroup !== 'object') continue;
    const group = rawGroup as Record<string, unknown>;
    const groupLabel = firstString(group.displayName, group.display_name);
    const groupBuckets = group.buckets;
    if (!Array.isArray(groupBuckets)) continue;

    for (const rawBucket of groupBuckets) {
      if (!rawBucket || typeof rawBucket !== 'object') continue;
      const item = rawBucket as Record<string, unknown>;

      const remainingRaw = item.remaining;
      const fraction =
        remainingRaw && typeof remainingRaw === 'object'
          ? firstFiniteNumber(
              (remainingRaw as Record<string, unknown>).remainingFraction,
              (remainingRaw as Record<string, unknown>).remaining_fraction,
            )
          : null;
      if (fraction == null) continue;

      const bucketId = firstString(item.bucketId, item.bucket_id);
      const bucketLabel = firstString(item.displayName, item.display_name);
      // Bucket ids key persisted star/hide prefs, so they must be stable and
      // unique; a response without one falls back to its label.
      const id = bucketId ?? bucketLabel;
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const used = usedPercentFromRemainingFraction(fraction);
      const bucket: QuotaBucket = {
        id,
        label: groupLabel && bucketLabel ? `${groupLabel} — ${bucketLabel}` : (bucketLabel ?? groupLabel ?? id),
        used,
        limit: 100,
        remaining: Math.max(0, 100 - used),
        unit: 'percent',
        enabled: true,
      };
      const description = firstString(item.description);
      if (description) bucket.note = description;

      const resetRaw = firstFiniteNumber(item.resetTime, item.reset_time);
      // No window length is reported here. A real reset time is still
      // surfaced on its own; only a SYNTHESIZED window must never be paired
      // with one, which is why `windowMs` is simply omitted.
      if (resetRaw != null && resetRaw > 0) bucket.resetsAt = normalizeEpochMs(resetRaw);

      buckets.push(bucket);
    }
  }
  return buckets;
}

/**
 * Legacy `GetUserStatus` shape: per-model quota under
 * `userStatus.cascadeModelConfigData.clientModelConfigs[].quotaInfo`. These
 * carry model ids, so they still feed the pool merge below. Exported for
 * test coverage.
 */
export function parseLegacyUserStatus(json: unknown): RawModelQuotaEntry[] {
  if (!json || typeof json !== 'object') return [];
  const root = json as Record<string, unknown>;
  const statusRaw = root.userStatus ?? root.user_status ?? root;
  if (!statusRaw || typeof statusRaw !== 'object') return [];
  const status = statusRaw as Record<string, unknown>;

  const cascadeRaw = status.cascadeModelConfigData ?? status.cascade_model_config_data;
  if (!cascadeRaw || typeof cascadeRaw !== 'object') return [];
  const configs = (cascadeRaw as Record<string, unknown>).clientModelConfigs ??
    (cascadeRaw as Record<string, unknown>).client_model_configs;
  if (!Array.isArray(configs)) return [];

  const out: RawModelQuotaEntry[] = [];
  for (const rawConfig of configs) {
    if (!rawConfig || typeof rawConfig !== 'object') continue;
    const config = rawConfig as Record<string, unknown>;
    const quotaRaw = config.quotaInfo ?? config.quota_info;
    if (!quotaRaw || typeof quotaRaw !== 'object') continue;
    const quota = quotaRaw as Record<string, unknown>;

    const fraction = firstFiniteNumber(quota.remainingFraction, quota.remaining_fraction);
    if (fraction == null) continue;

    const modelId = firstString(config.model, config.modelId, config.model_id, config.name) ?? 'unknown';
    const resetRaw = firstFiniteNumber(quota.resetTime, quota.reset_time);
    const resetsAt = resetRaw != null && resetRaw > 0 ? normalizeEpochMs(resetRaw) : null;

    out.push({
      modelId,
      usedPercent: usedPercentFromRemainingFraction(fraction),
      resetsAt,
      windowMs: null,
      // ASSUMPTION, not sourced: the legacy shape reports no window length,
      // and these per-model figures are treated as the session window. If
      // they are in fact weekly, they land under the wrong bucket id.
      windowKind: '5h',
    });
  }
  return out;
}

// --- Quota query (RPC-method fallback loop, budget-bounded overall) --------

export interface QuerySuccess {
  buckets: QuotaBucket[];
  source: string;
}
export interface QueryFailure {
  lastStatus: number;
}
export type QueryOutcome = QuerySuccess | QueryFailure;

function isQuerySuccess(outcome: QueryOutcome): outcome is QuerySuccess {
  return 'buckets' in outcome;
}

/**
 * Tries each `RPC_METHODS` entry in order against an already-discovered
 * server, returning the first that yields recognisable quota data. Exported
 * for smoke coverage (called through `queryQuotaDataWithBudget` in
 * production so the whole loop stays budget-bounded — see that function's
 * doc comment).
 */
export async function queryQuotaData(base: string, headers: Record<string, string>): Promise<QueryOutcome> {
  let lastStatus = 0;
  for (const method of RPC_METHODS) {
    const res = await httpJsonLocal(
      `${base}/${method}`,
      { method: 'POST', headers, body: RPC_REQUEST_BODY },
      QUERY_TIMEOUT_MS,
    );
    lastStatus = res.status;
    if (res.status !== 200) continue;

    // Documented shape first, then the legacy per-model shape, then the
    // original defensive probe (file-header note 5).
    const summaryBuckets = parseQuotaSummary(res.json);
    if (summaryBuckets.length > 0) return { buckets: summaryBuckets, source: `${base}/${method}` };

    const legacyEntries = parseLegacyUserStatus(res.json);
    if (legacyEntries.length > 0) {
      const buckets = mergePoolQuota(legacyEntries);
      if (buckets.length > 0) return { buckets, source: `${base}/${method}` };
    }

    const entries = extractQuotaEntries(res.json);
    if (entries.length === 0) continue;

    const buckets = mergePoolQuota(entries);
    if (buckets.length === 0) continue;

    return { buckets, source: `${base}/${method}` };
  }
  return { lastStatus };
}

/**
 * RESILIENCE FIX: the RPC-method fallback loop previously had no ceiling
 * across the WHOLE loop -- only each individual method attempt had its own
 * `QUERY_TIMEOUT_MS`. A discovered-but-stalling server could therefore make
 * this phase take up to `RPC_METHODS.length * QUERY_TIMEOUT_MS` (~9s), and
 * `fetch()` is awaited directly by the `quota:refresh` IPC handler with no
 * cancel -- a user clicking Refresh could see it hang that whole time. This
 * wraps `queryQuotaData` in the same `raceWithBudget` discipline
 * `scanForLanguageServer` already uses, so the query phase (not just each
 * method) has a hard ceiling too. Exported for smoke coverage (with an
 * injectable `runQuery` so the test doesn't need a real socket).
 */
export async function queryQuotaDataWithBudget(
  runQuery: () => Promise<QueryOutcome>,
  totalBudgetMs: number = QUERY_TOTAL_BUDGET_MS,
): Promise<QueryOutcome | null> {
  return raceWithBudget(runQuery, totalBudgetMs);
}

// --- Provider ------------------------------------------------------------------

class AntigravityQuotaProvider implements QuotaProvider {
  private cfg: Record<string, unknown> = {};
  constructor(_ctx: ConnectorContext) {}

  setConfig(cfg: Record<string, unknown>): void {
    this.cfg = cfg;
  }

  /**
   * Tries every (base URL x CSRF token) candidate for a discovered server,
   * inside one overall budget. Returns `null` — not a failed snapshot — when
   * none answered, so `fetch` can still fall back to the port scan.
   */
  private async fetchFromDiscovered(
    info: LanguageServerInfo,
    fetchedAt: number,
  ): Promise<QuotaSnapshot | null> {
    const extraPorts = info.extensionServerPort == null ? listeningPortsFor(info.pid) : [];
    const bases = candidateBaseUrls(info, extraPorts);
    if (bases.length === 0) return null;

    const tokens = candidateCsrfTokens(info);
    const outcome = await queryQuotaDataWithBudget(async () => {
      let last: QueryOutcome = { lastStatus: 0 };
      for (const base of bases) {
        for (const token of tokens) {
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
          };
          if (token) headers[CSRF_HEADER] = token;
          const result = await queryQuotaData(base, headers);
          if (isQuerySuccess(result)) return result;
          last = result;
        }
      }
      return last;
    });

    if (outcome != null && isQuerySuccess(outcome)) {
      return {
        ok: true,
        fetchedAt,
        buckets: outcome.buckets,
        displayMessages: [],
        authMethod: 'csrf',
        source: outcome.source,
      };
    }
    return null;
  }

  async fetch(): Promise<QuotaSnapshot> {
    const fetchedAt = Date.now();

    // Process discovery first (file-header note 1) — the port is ephemeral,
    // so the scan below is only a fallback.
    const discovered = discoverLanguageServer();
    if (discovered) {
      const viaProcess = await this.fetchFromDiscovered(discovered, fetchedAt);
      if (viaProcess) return viaProcess;
    }

    const portInfo = parsePortRangeInfo(this.cfg.portRange as string | undefined);
    const match = await scanForLanguageServer(portInfo.ports);

    if (match == null) {
      // WARNING FIX: previously silent -- if the configured range's raw span
      // was wider than what actually got scanned (only possible now via the
      // generous MAX_PORT_RANGE_SPAN ceiling, since realistic ranges scan in
      // full), say so explicitly rather than letting the user believe
      // Antigravity truly isn't running.
      const truncationNote =
        portInfo.requestedSpan > portInfo.ports.length
          ? ` (your configured range requested ${portInfo.requestedSpan} ports; only the first ` +
            `${portInfo.ports.length} were scanned -- narrow the range if the real port falls outside that.)`
          : '';
      return {
        ok: false,
        fetchedAt,
        error:
          'Antigravity does not appear to be running. Its quota is only readable from the local language ' +
          `server that the app starts, so open Antigravity and try again.${truncationNote}`,
      };
    }

    const { port, csrfToken } = match;
    const base = `http://127.0.0.1:${port}${RPC_SERVICE_PATH}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
    };
    // Threaded through from the probe response. The header name is
    // `X-Codeium-Csrf-Token` (file-header note 3), not `X-CSRF-Token`.
    if (csrfToken) headers[CSRF_HEADER] = csrfToken;

    const outcome = await queryQuotaDataWithBudget(() => queryQuotaData(base, headers));

    if (outcome == null) {
      return {
        ok: false,
        fetchedAt,
        error:
          `Found Antigravity's local server on port ${port}, but querying its quota endpoints took too long ` +
          `(over ${QUERY_TOTAL_BUDGET_MS}ms) and was abandoned.`,
        source: base,
      };
    }

    if (isQuerySuccess(outcome)) {
      return {
        ok: true,
        fetchedAt,
        buckets: outcome.buckets,
        displayMessages: [],
        authMethod: 'csrf',
        source: outcome.source,
      };
    }

    return {
      ok: false,
      fetchedAt,
      error:
        `Found Antigravity's local server on port ${port}, but none of its quota endpoints returned ` +
        `recognisable data (last HTTP status: ${outcome.lastStatus}).`,
      source: base,
    };
  }
}

export function createAntigravityQuotaProvider(
  config: Record<string, unknown>,
  ctx: ConnectorContext,
): QuotaProvider {
  const provider = new AntigravityQuotaProvider(ctx);
  provider.setConfig(config);
  return provider;
}
