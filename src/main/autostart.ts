import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';

export type LogFn = (level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) => void;

const LINUX_DESKTOP_FILE_NAME = 'aioversight.desktop';
const LINUX_APP_NAME = 'AI Oversight';

/**
 * Builds the contents of a freedesktop `.desktop` autostart entry.
 *
 * Pure and exported for unit testing. `execCommand` should already be a
 * fully-formed (but unescaped) shell command — this function takes care of
 * escaping it per the Desktop Entry Specification.
 */
export function buildDesktopEntry(execCommand: string): string {
  const lines = [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${LINUX_APP_NAME}`,
    `Exec=${escapeExecValue(execCommand)}`,
    'X-GNOME-Autostart-enabled=true',
    'Comment=Launch AI Oversight at login',
  ];
  return lines.join('\n') + '\n';
}

/**
 * Escapes a value for use in the `Exec=` key of a Desktop Entry file.
 *
 * Per the spec, `Exec` values support a reserved set of `%`-codes and the
 * whole field follows shell-like quoting rules: arguments containing spaces,
 * or any of the reserved characters, must be wrapped in double quotes, and
 * any embedded `"`, `` ` ``, `$`, `\` must be backslash-escaped.
 */
export function escapeExecValue(execCommand: string): string {
  const needsQuoting = /[\s"'\\$`><|;&(){}*?#~\[\]]/.test(execCommand);
  if (!needsQuoting) return execCommand;
  const escaped = execCommand.replace(/(["\\$`])/g, '\\$1');
  return `"${escaped}"`;
}

/**
 * Resolves the directory where the Linux autostart `.desktop` file lives,
 * honoring `$XDG_CONFIG_HOME` if set (falling back to `~/.config`).
 */
export function linuxAutostartDir(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
  const xdgConfigHome = env.XDG_CONFIG_HOME;
  const configDir = xdgConfigHome && xdgConfigHome.length > 0 ? xdgConfigHome : path.join(homeDir, '.config');
  return path.join(configDir, 'autostart');
}

/** Resolves the full path to the autostart `.desktop` file. */
export function linuxAutostartFile(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
  return path.join(linuxAutostartDir(env, homeDir), LINUX_DESKTOP_FILE_NAME);
}

/** Builds the command used in the `Exec=` key, mirroring how the app would be launched. */
export function buildExecCommand(execPath: string, isPackaged: boolean, appPath: string): string {
  if (isPackaged) return execPath;
  return `${execPath} ${appPath}`;
}

export interface ApplyAutoStartOptions {
  /** Override the detected platform. Defaults to `process.platform`. Mainly for tests. */
  platform?: NodeJS.Platform;
  /** Override the resolved Linux autostart `.desktop` file path. Mainly for tests. */
  linuxAutostartFile?: string;
}

/**
 * Syncs the OS "launch at login" registration with the desired state.
 *
 * - macOS / Windows: uses Electron's `app.setLoginItemSettings`.
 * - Linux: writes/removes a freedesktop autostart `.desktop` file.
 *
 * Never throws — failures are logged via `log` (if provided) and swallowed,
 * since a failed registration must not crash the app.
 */
export function applyAutoStart(enabled: boolean, log?: LogFn, options: ApplyAutoStartOptions = {}): void {
  const platform = options.platform ?? process.platform;
  try {
    if (platform === 'linux') {
      applyLinuxAutoStart(enabled, options.linuxAutostartFile ?? linuxAutostartFile());
      return;
    }

    if (!app.isPackaged) {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        path: process.execPath,
        args: [path.resolve(app.getAppPath())],
      });
      return;
    }

    app.setLoginItemSettings({ openAtLogin: enabled });
  } catch (err) {
    log?.('error', '[autostart] failed to apply launch-at-login setting', { err: String(err) });
  }
}

function applyLinuxAutoStart(enabled: boolean, file: string): void {
  if (!enabled) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return;
  }

  const execCommand = buildExecCommand(process.execPath, app.isPackaged, path.resolve(app.getAppPath()));
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, buildDesktopEntry(execCommand));
}
