import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

/**
 * Generic Chromium / Electron Cookies SQLite reader. Used by any connector
 * that needs to look up a session cookie set when the user signs in to a web
 * app (cursor.com -> WorkosCursorSessionToken, claude.ai -> sessionKey, …).
 *
 * Cross-platform decryption of the `encrypted_value` column:
 *   - macOS  : Keychain "<App> Safe Storage" -> AES-128-CBC (v10 prefix)
 *   - Windows: Local State `os_crypt.encrypted_key` -> DPAPI -> AES-256-GCM
 *              (v10/v11)
 *   - Linux  : "peanuts" PBKDF2 -> AES-128-CBC (v10) (best-effort)
 */

export interface BrowserApp {
  /**
   * App name as seen on disk: same string used for both the user-data folder
   * (`~/Library/Application Support/<name>`) and the Keychain entry name
   * (`<name> Safe Storage`).
   */
  appName: string;
  /**
   * Optional Keychain account override. macOS Chromium-derived apps usually
   * use the appName itself, but some do not.
   */
  keychainAccount?: string;
}

/** Resolve all Chromium-style cookie DBs for the given app (main + partitions). */
export function chromiumCookieDbPaths(app: BrowserApp): string[] {
  const home = os.homedir();
  let base: string;
  switch (process.platform) {
    case 'darwin':
      base = path.join(home, 'Library', 'Application Support', app.appName);
      break;
    case 'win32':
      base = path.join(
        process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
        app.appName,
      );
      break;
    default:
      base = path.join(home, '.config', app.appName);
  }

  const out: string[] = [];
  if (!fs.existsSync(base)) return out;

  const main = path.join(base, 'Cookies');
  if (fs.existsSync(main)) out.push(main);

  // Default profile (Chrome / Edge layout)
  const defaultProfile = path.join(base, 'Default', 'Cookies');
  if (fs.existsSync(defaultProfile)) out.push(defaultProfile);

  // Cursor / Electron-style "Partitions/<name>/Cookies"
  const partitions = path.join(base, 'Partitions');
  if (fs.existsSync(partitions)) {
    for (const entry of fs.readdirSync(partitions, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const cookies = path.join(partitions, entry.name, 'Cookies');
      if (fs.existsSync(cookies)) out.push(cookies);
    }
  }

  return out;
}

function localStatePath(app: BrowserApp): string | null {
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', app.appName, 'Local State');
    case 'win32':
      return path.join(
        process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
        app.appName,
        'Local State',
      );
    default:
      return path.join(home, '.config', app.appName, 'Local State');
  }
}

function macKey(app: BrowserApp): Buffer {
  const password = execFileSync(
    'security',
    [
      'find-generic-password',
      '-s',
      `${app.appName} Safe Storage`,
      '-a',
      app.keychainAccount ?? app.appName,
      '-w',
    ],
    { encoding: 'utf8' },
  ).trim();
  return crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
}

function linuxKey(): Buffer {
  return crypto.pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1');
}

function dpapiUnprotect(data: Buffer): Buffer {
  if (process.platform !== 'win32') throw new Error('DPAPI is Windows-only');
  const b64 = data.toString('base64');
  const script = `
Add-Type -AssemblyName System.Security
$bytes = [Convert]::FromBase64String('${b64}')
$plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser')
[Convert]::ToBase64String($plain)
`.trim();
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
  }).trim();
  return Buffer.from(out, 'base64');
}

function windowsKey(app: BrowserApp): Buffer {
  const ls = localStatePath(app);
  if (!ls || !fs.existsSync(ls)) {
    throw new Error(`${app.appName} Local State not found (needed to decrypt cookies on Windows)`);
  }
  const localState = JSON.parse(fs.readFileSync(ls, 'utf8')) as {
    os_crypt?: { encrypted_key?: string };
  };
  const encryptedKeyB64 = localState.os_crypt?.encrypted_key;
  if (!encryptedKeyB64) throw new Error(`No os_crypt.encrypted_key in ${app.appName} Local State`);
  const encryptedKey = Buffer.from(encryptedKeyB64, 'base64');
  // First 5 bytes are the "DPAPI" prefix.
  return dpapiUnprotect(encryptedKey.subarray(5));
}

function getCookieKey(app: BrowserApp): Buffer {
  switch (process.platform) {
    case 'darwin':
      return macKey(app);
    case 'win32':
      return windowsKey(app);
    default:
      return linuxKey();
  }
}

/** Decrypt a Chromium `encrypted_value` blob. */
export function decryptChromiumCookie(encrypted: Buffer | Uint8Array, key: Buffer): string {
  const buf = Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(encrypted);
  const prefix = buf.subarray(0, 3).toString('utf8');

  if (prefix === 'v10' || prefix === 'v11') {
    if (process.platform === 'win32' || (prefix === 'v11' && process.platform === 'linux')) {
      // AES-256-GCM: 12-byte nonce + ciphertext + 16-byte tag
      const nonce = buf.subarray(3, 15);
      const tag = buf.subarray(buf.length - 16);
      const ciphertext = buf.subarray(15, buf.length - 16);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    }

    const iv = Buffer.alloc(16, ' ');
    const decipher = crypto.createDecipheriv('aes-128-cbc', key.subarray(0, 16), iv);
    decipher.setAutoPadding(true);
    return Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()]).toString('utf8');
  }

  return buf.toString('utf8');
}

export interface CookieLookup {
  cookieName: string;
  /** SQL `LIKE` patterns matched against host_key. e.g. ['%cursor.com%']. */
  hostPatterns: string[];
}

async function queryCookieValue(
  dbPath: string,
  lookup: CookieLookup,
): Promise<Buffer | null> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sqlJsModule = require('sql.js') as
    & { default?: typeof import('sql.js') }
    & typeof import('sql.js');
  const initSqlJs = (typeof sqlJsModule === 'function' ? sqlJsModule : sqlJsModule.default)!;
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  const db = new SQL.Database(fs.readFileSync(dbPath));
  try {
    const escapedName = lookup.cookieName.replace(/'/g, "''");
    const hostClauses = lookup.hostPatterns
      .map(p => `host_key LIKE '${p.replace(/'/g, "''")}'`)
      .join(' OR ');
    const where = hostClauses ? `AND (${hostClauses})` : '';
    const rows = db.exec(`
      SELECT encrypted_value FROM cookies
      WHERE name = '${escapedName}' ${where}
      ORDER BY last_access_utc DESC
      LIMIT 1
    `);
    const raw = rows[0]?.values?.[0]?.[0];
    if (raw == null) return null;
    if (Buffer.isBuffer(raw)) return raw;
    if (raw instanceof Uint8Array) return Buffer.from(raw);
    if (typeof raw === 'string') return Buffer.from(raw, 'binary');
    return Buffer.from(String(raw), 'binary');
  } finally {
    db.close();
  }
}

/**
 * Read a session cookie out of one of the given app's Chromium cookie stores.
 * Returns null if no matching cookie can be decrypted.
 */
export async function readChromiumCookie(
  app: BrowserApp,
  lookup: CookieLookup,
): Promise<string | null> {
  let key: Buffer;
  try {
    key = getCookieKey(app);
  } catch {
    return null;
  }

  for (const dbPath of chromiumCookieDbPaths(app)) {
    try {
      const encrypted = await queryCookieValue(dbPath, lookup);
      if (!encrypted || encrypted.length === 0) continue;
      const value = decryptChromiumCookie(encrypted, key).trim();
      if (value) return value;
    } catch {
      // Try the next cookie DB.
    }
  }

  return null;
}
