import { spawn } from 'child_process';
import { QuotaProvider, QuotaSnapshot } from '../types';

const TIMEOUT_MS = 5_000;
const FIVE_HOUR_MS = 18_000_000;
const SEVEN_DAY_MS = 604_800_000;

export function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').replace(/\x1B\([A-Za-z]/g, '');
}

export function parseCliOutput(raw: string): QuotaSnapshot | null {
  const text = stripAnsi(raw);

  // Match the first "Current session" block — non-greedy so it won't
  // overshoot into the duplicate block in the "What's contributing" section.
  const sessionMatch = text.match(
    /Current session[\s\S]*?(\d+)%\s+used[\s\n\r]*Resets\s+(.+)/,
  );
  const weekMatch = text.match(
    /Current week[\s\S]*?(\d+)%\s+used[\s\n\r]*Resets\s+(.+)/,
  );

  if (!sessionMatch || !weekMatch) return null;

  const sessionPct = parseInt(sessionMatch[1], 10);
  const weekPct = parseInt(weekMatch[1], 10);
  if (Number.isNaN(sessionPct) || Number.isNaN(weekPct)) return null;

  const sessionReset = sessionMatch[2].trim();
  const weekReset = weekMatch[2].trim();

  return {
    ok: true,
    fetchedAt: Date.now(),
    authMethod: 'cli',
    source: 'cli',
    membershipType: 'Claude (claude.ai)',
    buckets: [
      {
        id: 'five-hour',
        label: '5-Hour Limit',
        unit: 'percent',
        used: sessionPct,
        limit: 100,
        remaining: 100 - sessionPct,
        enabled: true,
        // The CLI's `/usage` output only gives a human string ("Resets 3am"),
        // not a timestamp — no `resetsAt` to parse. `windowMs` alone isn't
        // enough for paceStateFor's projection branch (it also needs
        // `resetsAt`), so this still renders with the static thresholds. This
        // is intentionally different from quota.ts's browser-session path
        // (Phase 3), which sets both because its API response carries a real
        // `resets_at` timestamp — do not synthesize one here from the string.
        windowMs: FIVE_HOUR_MS,
      },
      {
        id: 'seven-day',
        label: '7-Day Limit',
        unit: 'percent',
        used: weekPct,
        limit: 100,
        remaining: 100 - weekPct,
        enabled: true,
        windowMs: SEVEN_DAY_MS,
      },
    ],
    displayMessages: [
      `5-hour limit resets ${sessionReset}`,
      `7-day limit resets ${weekReset}`,
    ],
  };
}

export class ClaudeCodeCliQuotaProvider implements QuotaProvider {
  async fetch(): Promise<QuotaSnapshot> {
    return new Promise((resolve, reject) => {
      // stdin: 'ignore' closes stdin immediately — claude exits after /usage
      const proc = spawn('claude', ['/usage'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      const timer = setTimeout(() => {
        proc.kill();
      }, TIMEOUT_MS);

      proc.on('error', err => {
        clearTimeout(timer);
        reject(err);
      });

      proc.on('close', () => {
        clearTimeout(timer);
        const snap = parseCliOutput(stdout);
        if (!snap) {
          reject(new Error('cli-quota: unexpected output format'));
          return;
        }
        resolve(snap);
      });
    });
  }
}
