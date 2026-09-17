/**
 * Update checks against GitHub Releases, scoped to the running platform and
 * package format.
 *
 * `electron-updater` does the heavy lifting where it can: it reads the
 * platform's `latest.yml` / `latest-linux.yml` / `latest-mac.yml`, verifies
 * the sha512 of downloads and installs them. It can only *install* on the
 * Windows NSIS build and the Linux AppImage; every other package is
 * notify-only (banner + notification + link to the release page).
 *
 * This module imports neither `electron` nor `electron-updater` at runtime —
 * `index.ts` injects the real `autoUpdater`, fetch, notification and shell
 * implementations, so the state machine and the capability matrix are unit
 * testable under plain Node.
 */

export const RELEASES_OWNER = 'nikolmedo';
export const RELEASES_REPO = 'AIOversight';

const INITIAL_CHECK_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type UpdateStatus =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export type UpdatePhase = 'check' | 'download' | 'install'; // which one produced `error`

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  latestVersion?: string;
  releaseUrl?: string;
  /** True only where electron-updater can download and install in place. */
  canInstall: boolean;
  /** Download progress, 0-100. Only set while `status` is 'downloading'. */
  progress?: number;
  error?: string;
  errorPhase?: UpdatePhase;
  /** Epoch ms of the last completed check (success or failure). */
  lastChecked?: number;
  /** The user dismissed the banner for `latestVersion` in this app session. */
  dismissed: boolean;
}

/**
 * Package format the app is running from.
 * - `nsis`: Windows installer build (auto-install).
 * - `portable`: Windows portable exe (notify-only).
 * - `appimage`: Linux AppImage (auto-install).
 * - `deb`: Linux .deb (notify-only).
 * - `archive`: Linux .tar.gz or any unknown Linux layout (notify-only).
 * - `mac`: macOS dmg/zip (notify-only: Squirrel.Mac needs a code-signed app).
 * - `dev`: not packaged, or an unsupported platform (updater disabled).
 */
export type UpdateTarget = 'nsis' | 'portable' | 'appimage' | 'deb' | 'archive' | 'mac' | 'dev';

export interface UpdateCapability {
  enabled: boolean;
  canInstall: boolean;
  target: UpdateTarget;
}

export interface UpdateEnvironment {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  isPackaged: boolean;
  /** Contents of `resources/package-type` (written by electron-builder for deb/rpm/pacman), if any. */
  packageType?: string;
}

export function computeUpdateCapability(e: UpdateEnvironment): UpdateCapability {
  if (!e.isPackaged) return { enabled: false, canInstall: false, target: 'dev' };
  switch (e.platform) {
    case 'win32':
      return e.env.PORTABLE_EXECUTABLE_DIR
        ? { enabled: true, canInstall: false, target: 'portable' }
        : { enabled: true, canInstall: true, target: 'nsis' };
    case 'darwin':
      // electron-updater's MacUpdater hands the zip to Squirrel.Mac, which
      // refuses unsigned apps. The release workflow does not sign, so an
      // install button here could never succeed.
      return { enabled: true, canInstall: false, target: 'mac' };
    case 'linux':
      if (e.env.APPIMAGE) return { enabled: true, canInstall: true, target: 'appimage' };
      if ((e.packageType ?? '').trim() === 'deb') return { enabled: true, canInstall: false, target: 'deb' };
      return { enabled: true, canInstall: false, target: 'archive' };
    default:
      return { enabled: false, canInstall: false, target: 'dev' };
  }
}

/** Release asset names that belong to a target, used by the GitHub API fallback. */
export function assetMatchesTarget(name: string, target: UpdateTarget): boolean {
  const n = name.toLowerCase();
  switch (target) {
    case 'nsis':
      return n.endsWith('.exe') && n.includes('-setup-');
    case 'portable':
      return n.endsWith('.exe') && n.includes('-portable-');
    case 'appimage':
      return n.endsWith('.appimage');
    case 'deb':
      return n.endsWith('.deb');
    case 'archive':
      return n.endsWith('.tar.gz');
    case 'mac':
      return n.endsWith('.dmg') || (n.endsWith('.zip') && n.includes('-mac-'));
    default:
      return false;
  }
}

/**
 * Compares dotted numeric versions (an optional leading `v` is ignored). A
 * pre-release suffix sorts before the same release (`1.0.0-beta` < `1.0.0`).
 * Returns a negative number, zero or a positive number.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.trim().replace(/^v/i, '').split('-', 2);
    return { parts: core.split('.').map(p => Number.parseInt(p, 10) || 0), pre: pre ?? '' };
  };
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.parts.length, pb.parts.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa.parts[i] ?? 0) - (pb.parts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

export function releaseUrlFor(version: string): string {
  return `https://github.com/${RELEASES_OWNER}/${RELEASES_REPO}/releases/tag/v${version.replace(/^v/i, '')}`;
}

/** The subset of electron-updater's `AppUpdater` this service uses. */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  logger: unknown;
  on(event: 'update-available', listener: (info: { version: string }) => void): unknown;
  on(event: 'update-not-available', listener: (info: { version: string }) => void): unknown;
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): unknown;
  on(event: 'update-downloaded', listener: (info: { version: string }) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  checkForUpdates(): Promise<unknown | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

type Logger = (
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  meta?: Record<string, unknown>,
) => void;

export interface UpdateServiceDeps {
  /** Only called when the capability is enabled, so dev builds never load electron-updater. */
  createUpdater: () => UpdaterLike;
  environment: UpdateEnvironment;
  currentVersion: string;
  /** GET a JSON document; rejects on network errors or non-2xx responses. */
  fetchJson: (url: string) => Promise<unknown>;
  /** Show the OS notification for a newly found version; `false` = suppressed. */
  notify: (state: UpdateState) => boolean | void;
  openExternal: (url: string) => void;
  log?: Logger;
  /** Scheduled checks run only while this returns true; manual checks always run. */
  isAutoCheckEnabled: () => boolean;
  getLastNotifiedVersion: () => string;
  setLastNotifiedVersion: (version: string) => void;
  /** Runs right before `quitAndInstall` (release windows, shortcuts, ...). */
  beforeInstall?: () => void;
  now?: () => number;
}

export class UpdateService {
  private readonly capability: UpdateCapability;
  private readonly log: Logger;
  private readonly now: () => number;
  private updater: UpdaterLike | null = null;
  private state: UpdateState;
  private dismissedVersion: string | null = null;
  private readonly listeners = new Set<(state: UpdateState) => void>();
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<UpdateState> | null = null;

  constructor(private readonly deps: UpdateServiceDeps) {
    this.capability = computeUpdateCapability(deps.environment);
    this.log = deps.log ?? (() => {});
    this.now = deps.now ?? Date.now;
    this.state = {
      status: this.capability.enabled ? 'idle' : 'disabled',
      currentVersion: deps.currentVersion,
      canInstall: this.capability.canInstall,
      dismissed: false,
    };
    if (this.capability.enabled) this.attachUpdater();
    this.log('info', '[updater] initialized', {
      target: this.capability.target,
      enabled: this.capability.enabled,
      canInstall: this.capability.canInstall,
    });
  }

  getState(): UpdateState {
    return { ...this.state };
  }

  getCapability(): UpdateCapability {
    return { ...this.capability };
  }

  onChange(listener: (state: UpdateState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Schedules the first check shortly after launch, then a periodic one. */
  start(): void {
    if (!this.capability.enabled) return;
    this.stop();
    const scheduled = () => {
      if (!this.deps.isAutoCheckEnabled()) return;
      // A finished or running download needs no further checks.
      if (this.state.status === 'downloading' || this.state.status === 'downloaded') return;
      void this.check();
    };
    this.initialTimer = setTimeout(scheduled, INITIAL_CHECK_DELAY_MS);
    this.intervalTimer = setInterval(scheduled, CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.initialTimer = null;
    this.intervalTimer = null;
  }

  /** Never rejects: failures end in the 'error' state. */
  check(): Promise<UpdateState> {
    if (!this.capability.enabled || !this.updater) return Promise.resolve(this.getState());
    if (this.state.status === 'downloading' || this.state.status === 'downloaded') {
      return Promise.resolve(this.getState());
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runCheck().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async download(): Promise<UpdateState> {
    if (!this.updater || !this.capability.canInstall) return this.getState();
    const { status, latestVersion } = this.state;
    if (status !== 'available' || !latestVersion) return this.getState();
    this.setState({ status: 'downloading', progress: 0, error: undefined });
    try {
      await this.updater.downloadUpdate();
    } catch (err) {
      // The 'error' event usually fired already; only fill in what it missed.
      if (this.state.status === 'downloading') this.fail(err, 'download');
    }
    return this.getState();
  }

  install(): void {
    if (!this.updater || !this.capability.canInstall || this.state.status !== 'downloaded') return;
    this.log('info', '[updater] quitting to install update', { version: this.state.latestVersion });
    try {
      this.deps.beforeInstall?.();
    } catch (err) {
      this.log('warn', '[updater] beforeInstall hook threw', { err: String(err) });
    }
    // Silent install, then relaunch. `quitAndInstall` does NOT quit when the
    // install fails (reported through 'error') and can throw outright — the
    // windows are gone by then, so the banner must become usable again.
    try {
      this.updater.quitAndInstall(true, true);
    } catch (err) {
      this.fail(err, 'install');
    }
  }

  openRelease(): void {
    const version = this.state.latestVersion;
    const url = version ? releaseUrlFor(version) : `https://github.com/${RELEASES_OWNER}/${RELEASES_REPO}/releases/latest`;
    this.deps.openExternal(url);
  }

  /** Hides the banner for the current `latestVersion` until the app restarts. */
  dismiss(): UpdateState {
    if (this.state.latestVersion) {
      this.dismissedVersion = this.state.latestVersion;
      this.setState({});
    }
    return this.getState();
  }

  private attachUpdater(): void {
    const updater = this.deps.createUpdater();
    updater.autoDownload = false;
    // A downloaded update that was not installed via the banner still gets
    // applied the next time the user quits the app.
    updater.autoInstallOnAppQuit = true;
    updater.logger = {
      info: (m: unknown) => this.log('debug', `[updater] ${String(m)}`),
      warn: (m: unknown) => this.log('warn', `[updater] ${String(m)}`),
      error: (m: unknown) => this.log('warn', `[updater] ${String(m)}`),
      debug: (m: unknown) => this.log('debug', `[updater] ${String(m)}`),
    };

    updater.on('update-available', info => this.onAvailable(info.version));
    updater.on('update-not-available', () => {
      if (this.state.status !== 'checking') return;
      this.setState({ status: 'not-available', lastChecked: this.now(), error: undefined });
    });
    updater.on('download-progress', p => {
      if (this.state.status !== 'downloading') return;
      const percent = Math.max(0, Math.min(100, Math.round(p.percent)));
      if (percent !== this.state.progress) this.setState({ progress: percent });
    });
    updater.on('update-downloaded', info => {
      this.log('info', '[updater] update downloaded', { version: info.version });
      this.setState({ status: 'downloaded', progress: 100, latestVersion: info.version, error: undefined });
    });
    // electron-updater re-throws 'error' when nothing listens, so this
    // listener must always be attached.
    updater.on('error', err => {
      if (this.state.status === 'checking') this.fail(err, 'check');
      else if (this.state.status === 'downloading') this.fail(err, 'download');
      else if (this.state.status === 'downloaded') this.fail(err, 'install');
      else this.log('warn', '[updater] error', { err: String(err) });
    });
    this.updater = updater;
  }

  private async runCheck(): Promise<UpdateState> {
    this.setState({ status: 'checking', error: undefined });
    try {
      const result = await this.updater!.checkForUpdates();
      if (result == null && this.state.status === 'checking') {
        // electron-updater is inactive for this layout (e.g. a Linux .tar.gz
        // has neither APPIMAGE nor resources/package-type).
        await this.checkViaGitHubApi();
      }
    } catch (err) {
      if (this.state.status === 'checking') this.fail(err, 'check');
    }
    if (this.state.status === 'checking') {
      // Resolved without any event (should not happen); settle the state.
      this.setState({ status: 'not-available', lastChecked: this.now() });
    }
    return this.getState();
  }

  private async checkViaGitHubApi(): Promise<void> {
    const url = `https://api.github.com/repos/${RELEASES_OWNER}/${RELEASES_REPO}/releases/latest`;
    this.log('debug', '[updater] electron-updater inactive, checking the GitHub releases API', {
      target: this.capability.target,
    });
    const body = (await this.deps.fetchJson(url)) as {
      tag_name?: unknown;
      assets?: Array<{ name?: unknown }>;
    };
    const tag = typeof body?.tag_name === 'string' ? body.tag_name : '';
    const version = tag.replace(/^v/i, '');
    const hasAsset = (body?.assets ?? []).some(
      a => typeof a?.name === 'string' && assetMatchesTarget(a.name, this.capability.target),
    );
    if (version && hasAsset && compareVersions(version, this.deps.currentVersion) > 0) {
      this.onAvailable(version);
    } else {
      this.setState({ status: 'not-available', lastChecked: this.now(), error: undefined });
    }
  }

  private onAvailable(version: string): void {
    if (compareVersions(version, this.deps.currentVersion) <= 0) {
      this.setState({ status: 'not-available', lastChecked: this.now(), error: undefined });
      return;
    }
    this.setState({
      status: 'available',
      latestVersion: version,
      releaseUrl: releaseUrlFor(version),
      lastChecked: this.now(),
      error: undefined,
      progress: undefined,
    });
    if (this.deps.getLastNotifiedVersion() === version) return;
    this.log('info', '[updater] update available', { version, canInstall: this.capability.canInstall });
    try {
      // Only a shown notification counts, otherwise having notifications off
      // would permanently swallow the one toast this version gets.
      if (this.deps.notify(this.getState()) !== false) this.deps.setLastNotifiedVersion(version);
    } catch (err) {
      this.log('warn', '[updater] notification failed', { err: String(err) });
    }
  }

  private fail(err: unknown, phase: UpdatePhase): void {
    const message = err instanceof Error ? err.message : String(err);
    // Offline or a release without latest*.yml is routine; keep it at warn
    // and never notify.
    this.log('warn', `[updater] ${phase} failed`, { err: message });
    if (phase === 'install') {
      // Still downloaded: keep the state that lets the user retry.
      this.setState({ status: 'downloaded', error: message, errorPhase: phase });
      return;
    }
    const known = this.state.latestVersion;
    if (known && compareVersions(known, this.deps.currentVersion) > 0) {
      // Keep the banner: the update found earlier still exists, and a failed
      // download can be retried.
      this.setState({ status: 'available', lastChecked: this.now(), progress: undefined, error: message, errorPhase: phase });
      return;
    }
    this.setState({ status: 'error', lastChecked: this.now(), error: message, errorPhase: phase, progress: undefined });
  }

  private setState(patch: Partial<UpdateState>): void {
    const next: UpdateState = { ...this.state, ...patch };
    // `errorPhase` only ever describes a live `error`.
    if (next.error === undefined) next.errorPhase = undefined;
    next.dismissed = !!next.latestVersion && next.latestVersion === this.dismissedVersion;
    this.state = next;
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (err) {
        this.log('warn', '[updater] state listener threw', { err: String(err) });
      }
    }
  }
}
