/**
 * Patches `Module._load` so `require('electron')` returns a stub object
 * usable under plain Node (no Electron runtime).
 *
 * Must be imported FIRST in every electron-touching test file — `node --test`
 * runs each compiled test file in its own process, and CJS `require` calls
 * execute in source order, so importing this module before the module under
 * test guarantees the patch is installed before `require('electron')` runs.
 *
 * Usage:
 *   import './helpers/electron-stub';
 *   import { setUserDataPath, notifications, ... } from './helpers/electron-stub';
 */
// Use the TS/CJS `import ... = require(...)` form (not `import * as Module`):
// `import * as` compiles to `__importStar`, which copies properties onto a
// NEW object using getter-only, non-configurable descriptors for any
// writable/configurable source property — making `Module._load` impossible
// to redefine on the copy. The `= require(...)` form gives us the real
// `node:module` exports object, whose `_load` is writable & configurable.
import Module = require('node:module');

// --- app --------------------------------------------------------------------

let userDataPath = '';

export function setUserDataPath(dir: string): void {
  userDataPath = dir;
}

// --- login items (app.setLoginItemSettings / getLoginItemSettings) ----------

export interface LoginItemSettings {
  openAtLogin: boolean;
  path?: string;
  args?: string[];
}

let loginItemSettings: LoginItemSettings = { openAtLogin: false };
export const loginItemSettingsCalls: LoginItemSettings[] = [];

let appIsPackaged = false;
let appPath = '';

export function setAppIsPackaged(packaged: boolean): void {
  appIsPackaged = packaged;
}

export function setAppPath(p: string): void {
  appPath = p;
}

export function resetLoginItemSettings(): void {
  loginItemSettings = { openAtLogin: false };
  loginItemSettingsCalls.length = 0;
  appIsPackaged = false;
  appPath = '';
}

const app = {
  getPath(name: string): string {
    if (name === 'userData') return userDataPath;
    return userDataPath;
  },
  getVersion(): string {
    return '0.0.0-test';
  },
  getAppPath(): string {
    return appPath;
  },
  get isPackaged(): boolean {
    return appIsPackaged;
  },
  setLoginItemSettings(settings: LoginItemSettings): void {
    loginItemSettings = { ...settings };
    loginItemSettingsCalls.push({ ...settings });
  },
  getLoginItemSettings(): LoginItemSettings {
    return { ...loginItemSettings };
  },
};

// --- Notification -------------------------------------------------------------

export interface RecordedNotification {
  options: { title?: string; body?: string; silent?: boolean; icon?: string };
  shown: boolean;
  handlers: Record<string, Array<(...args: unknown[]) => void>>;
}

export const notifications: RecordedNotification[] = [];

let notificationSupported = true;

export function setNotificationSupported(supported: boolean): void {
  notificationSupported = supported;
}

export function resetElectronStub(): void {
  notifications.length = 0;
  notificationSupported = true;
  shellCalls.length = 0;
  dialogCalls.length = 0;
  encryptionAvailable = true;
  resetLoginItemSettings();
}

class StubNotification {
  options: RecordedNotification['options'];
  private handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  private record: RecordedNotification;

  constructor(options: RecordedNotification['options']) {
    this.options = options;
    this.record = { options, shown: false, handlers: this.handlers };
    notifications.push(this.record);
  }

  static isSupported(): boolean {
    return notificationSupported;
  }

  on(event: string, handler: (...args: unknown[]) => void): this {
    (this.handlers[event] ??= []).push(handler);
    return this;
  }

  show(): void {
    if (!notificationSupported) {
      throw new Error('Notifications are not supported');
    }
    this.record.shown = true;
    for (const handler of this.handlers['show'] ?? []) handler();
  }

  /** Test helper: simulate the OS firing the 'click' handler. */
  emitClick(): void {
    for (const handler of this.handlers['click'] ?? []) handler();
  }
}

// --- safeStorage --------------------------------------------------------------

let encryptionAvailable = true;

export function setEncryptionAvailable(available: boolean): void {
  encryptionAvailable = available;
}

const safeStorage = {
  isEncryptionAvailable(): boolean {
    return encryptionAvailable;
  },
  /** Reversible fake "encryption": base64-encode with a marker prefix. */
  encryptString(plain: string): Buffer {
    return Buffer.from(`enc:${plain}`, 'utf8');
  },
  decryptString(buf: Buffer): string {
    const text = buf.toString('utf8');
    if (!text.startsWith('enc:')) throw new Error('Cannot decrypt: not an encrypted value');
    return text.slice('enc:'.length);
  },
};

// --- shell / dialog -------------------------------------------------------------

export const shellCalls: Array<{ method: string; args: unknown[] }> = [];
export const dialogCalls: Array<{ method: string; args: unknown[] }> = [];

const shell = {
  showItemInFolder(...args: unknown[]): void {
    shellCalls.push({ method: 'showItemInFolder', args });
  },
  openExternal(...args: unknown[]): Promise<void> {
    shellCalls.push({ method: 'openExternal', args });
    return Promise.resolve();
  },
};

const dialog = {
  showMessageBox(...args: unknown[]): Promise<{ response: number }> {
    dialogCalls.push({ method: 'showMessageBox', args });
    return Promise.resolve({ response: 0 });
  },
  showErrorBox(...args: unknown[]): void {
    dialogCalls.push({ method: 'showErrorBox', args });
  },
};

// --- net (delegates to global fetch so tests can mock fetch directly) ---------

const net = {
  fetch(input: string, init?: RequestInit): Promise<Response> {
    return globalThis.fetch(input, init);
  },
};

// --- electron module shape ------------------------------------------------------

const electronStub = {
  app,
  Notification: StubNotification,
  safeStorage,
  shell,
  dialog,
  net,
};

// --- Module._load patch -----------------------------------------------------

// On modern Node (v22+), `Module._load` is defined via `Object.defineProperty`
// with only a getter on some builds, so a plain assignment (`Module._load = ...`)
// throws "Cannot set property _load of #<Object> which has only a getter".
// Redefine the property descriptor explicitly so the patch applies regardless.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ModuleAny = Module as any;
const originalLoad = ModuleAny._load;

function patchedLoad(this: unknown, request: string, ...rest: unknown[]) {
  if (request === 'electron') {
    return electronStub;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return originalLoad.call(this, request, ...rest);
}

Object.defineProperty(ModuleAny, '_load', {
  value: patchedLoad,
  writable: true,
  configurable: true,
  enumerable: true,
});

export { StubNotification };
