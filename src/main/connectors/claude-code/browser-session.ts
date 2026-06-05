/**
 * Embedded-Chromium session for claude.ai.
 *
 * claude.ai sits behind a Cloudflare interactive challenge ("Just a moment…").
 * No plain HTTP client can pass it — it needs a real browser engine to execute
 * the challenge JS and obtain a `cf_clearance` cookie. Electron *is* Chromium,
 * so we drive a hidden BrowserWindow on a persistent partition. The user logs in
 * once; the partition keeps the login session and Cloudflare clearance warm.
 */

import type { BrowserWindow as BrowserWindowType } from 'electron';

const PARTITION = 'persist:claude-quota';
const USAGE_PAGE = 'https://claude.ai/settings/usage';
const LOGIN_PAGE = 'https://claude.ai/login';
const CHALLENGE_TIMEOUT_MS = 25_000;

export type UsageResult =
  | { kind: 'ok'; body: string; url: string }
  | { kind: 'needs-login' }
  | { kind: 'error'; message: string };

let cachedWindow: BrowserWindowType | null = null;
let loginWindowShown = false;
// Serialize access — only one window should drive claude.ai at a time.
let chain: Promise<unknown> = Promise.resolve();

export function fetchClaudeUsage(): Promise<UsageResult> {
  const next = chain.then(fetchClaudeUsageImpl, fetchClaudeUsageImpl);
  chain = next.then(() => undefined, () => undefined);
  return next;
}

async function fetchClaudeUsageImpl(): Promise<UsageResult> {
  const win = getWindow();

  // Don't reload while the user is signing in.
  if (loginWindowShown && !win.isDestroyed() && win.isVisible()) {
    return { kind: 'needs-login' };
  }

  await win.loadURL(USAGE_PAGE).catch(() => undefined);
  await delay(2500); // let the page settle / redirect

  // An unauthenticated session lands on /login. Surface "needs-login" so the UI
  // can offer a Sign-in button — never pop the window open during a background poll.
  if (isLoginUrl(win.webContents.getURL())) {
    return { kind: 'needs-login' };
  }

  const orgId = await resolveOrgId(win);
  if (!orgId) return { kind: 'error', message: 'Could not resolve your claude.ai organization.' };

  const usagePath = `/api/organizations/${orgId}/usage`;
  const res = await inPageFetch(win, usagePath);

  if (res.status === 200 && !isChallenge(res.body)) {
    return { kind: 'ok', body: res.body, url: `https://claude.ai${usagePath}` };
  }
  if (res.status === 401) {
    return { kind: 'needs-login' };
  }
  return { kind: 'error', message: `Usage endpoint returned ${res.status}.` };
}

/**
 * Open the claude.ai sign-in window. Called from the UI's "Sign in" button —
 * the only place a window is ever shown. `onComplete` fires once the user has
 * signed in (so the caller can refresh the quota immediately).
 */
export function startClaudeLogin(onComplete?: () => void): void {
  const win = getWindow();
  if (loginWindowShown && win.isVisible()) {
    win.focus();
    return;
  }
  loginWindowShown = true;
  win.loadURL(LOGIN_PAGE).catch(() => undefined);
  win.show();
  win.focus();

  const onNav = (_e: unknown, url: string) => {
    if (url.startsWith('https://claude.ai') && !isLoginUrl(url)) {
      loginWindowShown = false;
      if (!win.isDestroyed()) win.hide();
      win.webContents.removeListener('did-navigate', onNav as never);
      onComplete?.();
    }
  };
  win.webContents.on('did-navigate', onNav as never);
}

function getWindow(): BrowserWindowType {
  if (cachedWindow && !cachedWindow.isDestroyed()) return cachedWindow;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BrowserWindow } = require('electron') as typeof import('electron');
  cachedWindow = new BrowserWindow({
    show: false,
    width: 480,
    height: 720,
    title: 'AI Oversight — Claude sign-in',
    webPreferences: { partition: PARTITION, sandbox: true },
  });
  cachedWindow.on('closed', () => {
    cachedWindow = null;
    loginWindowShown = false;
  });
  return cachedWindow;
}

/** Resolve the active org uuid via the authenticated in-page session. */
async function resolveOrgId(win: BrowserWindowType): Promise<string | null> {
  const deadline = Date.now() + CHALLENGE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await inPageFetch(win, '/api/organizations');
    if (res.status === 200 && !isChallenge(res.body)) {
      try {
        const orgs = JSON.parse(res.body) as Array<{ uuid?: string }>;
        const uuid = Array.isArray(orgs) ? orgs.find(o => o?.uuid)?.uuid : undefined;
        if (uuid) return uuid;
      } catch {
        // fall through
      }
      return null;
    }
    // Cloudflare still solving (or transient) — wait and retry.
    if (isChallenge(res.body) || res.status === 0) {
      await delay(1500);
      continue;
    }
    return null;
  }
  return null;
}

/** Run `fetch(path)` inside the claude.ai page context and return status + body. */
async function inPageFetch(
  win: BrowserWindowType,
  path: string,
): Promise<{ status: number; body: string }> {
  const script = `
    fetch(${JSON.stringify(path)}, { headers: { accept: 'application/json' }, credentials: 'include' })
      .then(async r => JSON.stringify({ status: r.status, body: await r.text() }))
      .catch(() => JSON.stringify({ status: 0, body: '' }))
  `;
  try {
    const raw = await win.webContents.executeJavaScript(script, true);
    return JSON.parse(String(raw));
  } catch {
    // executeJavaScript rejects mid-navigation — treat as transient.
    return { status: 0, body: '' };
  }
}

function isChallenge(body: string): boolean {
  return /Just a moment|cf-mitigated|challenges\.cloudflare\.com|_cf_chl/i.test(body);
}

function isLoginUrl(url: string): boolean {
  return /claude\.ai\/(login|auth|magic-link)/i.test(url);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
