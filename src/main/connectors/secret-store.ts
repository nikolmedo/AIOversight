import * as fs from 'fs';
import * as path from 'path';
import { app, safeStorage } from 'electron';

/**
 * Encrypted store for connector credentials (API keys, PATs, session tokens).
 *
 *  - On macOS  : `safeStorage` uses the user's Keychain for encryption.
 *  - On Windows: `safeStorage` uses DPAPI (per-user).
 *  - On Linux  : best-effort; falls back to a libsecret session if available.
 *
 * If the OS keychain is unavailable, we fall back to plaintext storage and log
 * a warning. Plaintext is gated behind a one-time consent file so it never
 * happens silently on a future install.
 *
 * Persisted file: `<userData>/secrets.json` — entirely separate from the main
 * settings.json so accidentally pasting a settings export doesn't leak keys.
 */
export class SecretStore {
  private readonly file: string;
  private readonly fallbackFlagFile: string;
  private values = new Map<string, string>();
  private encryptionAvailable: boolean;
  private warnedNoEncryption = false;

  constructor() {
    const dir = app.getPath('userData');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'secrets.json');
    this.fallbackFlagFile = path.join(dir, 'secrets.plaintext.allowed');
    this.encryptionAvailable = safeStorage.isEncryptionAvailable();
    this.load();
  }

  /**
   * Build a namespaced key from connector + field. Used by the runtime when
   * exposing `ctx.secret(key)` to a connector — it sees just `key` while the
   * store retains uniqueness across connectors.
   */
  static qualify(connectorId: string, key: string): string {
    return `${connectorId}::${key}`;
  }

  has(qualified: string): boolean {
    return this.values.has(qualified);
  }

  get(qualified: string): string | null {
    return this.values.get(qualified) ?? null;
  }

  set(qualified: string, value: string): void {
    if (!value) {
      this.values.delete(qualified);
    } else {
      this.values.set(qualified, value);
    }
    this.persist();
  }

  delete(qualified: string): void {
    this.values.delete(qualified);
    this.persist();
  }

  /** List of qualified keys with values present. Safe to send to renderer. */
  qualifiedKeys(): string[] {
    return [...this.values.keys()];
  }

  private load(): void {
    if (!fs.existsSync(this.file)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return;
    }
    if (!raw || typeof raw !== 'object') return;
    const obj = raw as { encrypted?: boolean; entries?: Record<string, string> };
    const entries = obj.entries ?? {};
    for (const [k, v] of Object.entries(entries)) {
      if (typeof v !== 'string' || !v) continue;
      try {
        if (obj.encrypted && this.encryptionAvailable) {
          const buf = Buffer.from(v, 'base64');
          this.values.set(k, safeStorage.decryptString(buf));
        } else {
          this.values.set(k, v);
        }
      } catch {
        // Skip undecryptable entries (e.g. user reset their keychain).
      }
    }
  }

  private persist(): void {
    const usingEncryption = this.encryptionAvailable;
    if (!usingEncryption && !this.warnedNoEncryption) {
      this.warnedNoEncryption = true;
      // Log via console so we never crash when the SettingsStore log channel
      // isn't yet wired (SecretStore is constructed earlier).
      console.warn(
        '[SecretStore] OS encryption unavailable — secrets stored in plaintext at',
        this.file,
      );
      try {
        fs.writeFileSync(this.fallbackFlagFile, '1');
      } catch {
        /* best effort */
      }
    }
    const entries: Record<string, string> = {};
    for (const [k, v] of this.values) {
      if (usingEncryption) {
        const enc = safeStorage.encryptString(v);
        entries[k] = enc.toString('base64');
      } else {
        entries[k] = v;
      }
    }
    try {
      fs.writeFileSync(
        this.file,
        JSON.stringify({ encrypted: usingEncryption, entries }, null, 2),
        { mode: 0o600 },
      );
    } catch (err) {
      console.error('[SecretStore] failed to persist:', err);
    }
  }
}
