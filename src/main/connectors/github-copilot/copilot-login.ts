/**
 * GitHub Copilot device-flow OAuth login.
 *
 * GitHub exposes no public API for an individual's Copilot quota — the only
 * source is the internal `copilot_internal/*` surface used by official editor
 * integrations (VS Code, JetBrains, the `gh` CLI). Those clients authenticate
 * via GitHub's OAuth **device flow** against the "GitHub Copilot CLI" app.
 *
 * We mirror that flow once: the user authorizes in their browser, we persist
 * the resulting `ghu_` user-to-server token (encrypted, via SecretStore), and
 * never ask them to sign in again — `quota.ts` uses that token directly against
 * `copilot_internal/user` (and optionally against the official org metrics API).
 */

import { ConnectorContext } from '../types';
import { SecretStore } from '../secret-store';

// OAuth app id of "GitHub Copilot CLI" — the one every working third-party
// Copilot client (copilot.vim, litellm, avante.nvim) authenticates against.
const CLIENT_ID = 'Iv1.b507a08c87ecfe98';

// Scopes:
//   read:user              — required for copilot_internal/user
//   read:org               — required to read org membership for metrics
//   manage_billing:copilot — required for /orgs/{slug}/copilot/metrics
const SCOPE = 'read:user read:org manage_billing:copilot';

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface AccessTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function postForm(url: string, body: Record<string, string>): Promise<unknown> {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  const params = new URLSearchParams(body).toString();

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { net } = require('electron') as typeof import('electron');
    if (net?.fetch) {
      const res = await net.fetch(url, { method: 'POST', headers, body: params });
      const txt = await res.text();
      return txt ? JSON.parse(txt) : {};
    }
  } catch {
    // fall through to Node https
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const https = require('https') as typeof import('https');
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(params) } },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve(text ? JSON.parse(text) : {});
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error('GitHub OAuth request timeout')));
    req.write(params);
    req.end();
  });
}

let loginInFlight = false;

/**
 * Starts the device-flow login: requests a device code, opens the
 * verification page in the user's browser, shows the code in a native dialog,
 * and polls for authorization. Persists the resulting token and calls
 * `onComplete` so the caller can refresh the quota immediately.
 */
export function startCopilotLogin(secrets: SecretStore, ctx: ConnectorContext, onComplete?: () => void): void {
  if (loginInFlight) return;
  loginInFlight = true;
  runLogin(secrets, ctx, onComplete).finally(() => {
    loginInFlight = false;
  });
}

async function runLogin(secrets: SecretStore, ctx: ConnectorContext, onComplete?: () => void): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { shell, dialog } = require('electron') as typeof import('electron');

  try {
    const device = (await postForm(DEVICE_CODE_URL, {
      client_id: CLIENT_ID,
      scope: SCOPE,
    })) as DeviceCodeResponse;

    if (!device?.device_code || !device?.user_code || !device?.verification_uri) {
      ctx.log('error', '[copilot-login] device code request returned an unexpected shape', { device });
      return;
    }

    void shell.openExternal(device.verification_uri);
    void dialog.showMessageBox({
      type: 'info',
      title: 'Sign in to GitHub Copilot',
      message: `Enter this code at ${device.verification_uri}`,
      detail:
        `${device.user_code}\n\n` +
        'Your browser should have opened to the verification page — paste the code above ' +
        'and approve access. AI Oversight will pick up the connection automatically once ' +
        'you finish; you can close this dialog at any time.',
      buttons: ['OK'],
    });

    const token = await pollForToken(device, ctx);
    if (!token) return;

    secrets.set(SecretStore.qualify('github-copilot', 'copilotOauthToken'), token);
    ctx.log('info', '[copilot-login] GitHub Copilot sign-in complete');
    onComplete?.();
  } catch (err) {
    ctx.log('error', '[copilot-login] sign-in failed', { err: String(err) });
  }
}

async function pollForToken(device: DeviceCodeResponse, ctx: ConnectorContext): Promise<string | null> {
  const deadline = Date.now() + device.expires_in * 1000;
  let intervalMs = Math.max(device.interval, 5) * 1000;

  while (Date.now() < deadline) {
    await delay(intervalMs);

    let res: AccessTokenResponse;
    try {
      res = (await postForm(ACCESS_TOKEN_URL, {
        client_id: CLIENT_ID,
        device_code: device.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      })) as AccessTokenResponse;
    } catch (err) {
      ctx.log('debug', '[copilot-login] token poll request failed, retrying', { err: String(err) });
      continue;
    }

    if (res.access_token) return res.access_token;

    switch (res.error) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        intervalMs += 5_000;
        continue;
      case 'expired_token':
        ctx.log('warn', '[copilot-login] device code expired before authorization completed');
        return null;
      case 'access_denied':
        ctx.log('info', '[copilot-login] user declined GitHub Copilot authorization');
        return null;
      default:
        ctx.log('error', '[copilot-login] unexpected token response', { res });
        return null;
    }
  }

  ctx.log('warn', '[copilot-login] device code expired while waiting for authorization');
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
