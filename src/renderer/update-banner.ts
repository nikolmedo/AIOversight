// Shared "update available" banner for the settings window and the tray
// popup. Non-module global script (see quota-math.ts's header comment),
// loaded after quota-view.js (uses its `escapeHtml`) and before
// settings.js / tray-popup.js.

type UpdateBannerAction = 'download' | 'install' | 'open-release' | 'dismiss';

const ICON_UPDATE =
  '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10"/></svg>';
const ICON_CLOSE =
  '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

/** Whether the banner has anything to show for this state. */
function isUpdateBannerVisible(state: UpdateState | null | undefined): boolean {
  if (!state || state.dismissed || !state.latestVersion) return false;
  // `checking` with a known newer version is a periodic re-check: keep the
  // banner up instead of blinking it away for the duration of the request.
  return (
    state.status === 'available' ||
    state.status === 'checking' ||
    state.status === 'downloading' ||
    state.status === 'downloaded'
  );
}

/**
 * Banner markup, or '' when there is nothing to show. `compact` is the tray
 * popup variant: shorter copy, no error detail.
 */
function renderUpdateBanner(state: UpdateState | null | undefined, compact = false): string {
  if (!state || !isUpdateBannerVisible(state)) return '';
  const version = escapeHtml(state.latestVersion ?? '');
  let text: string;
  let actions = '';
  let progress = '';

  if (state.status === 'downloading') {
    const pct = Math.max(0, Math.min(100, Math.round(state.progress ?? 0)));
    text = compact ? `Downloading ${version}… ${pct}%` : `Downloading version ${version}… ${pct}%`;
    progress = `<div class="update-banner-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><div class="update-banner-fill" style="--fill:${pct}%"></div></div>`;
  } else if (state.status === 'downloaded' && state.error) {
    // The install failed; the download is still there to retry, and the
    // release page is the way out if it keeps failing.
    text = `Version ${version} could not be installed${compact ? '' : `: ${escapeHtml(state.error)}`}`;
    actions =
      updateBannerButton('install', 'Try again', true) + updateBannerButton('open-release', 'Download', false);
  } else if (state.status === 'downloaded') {
    text = compact ? `${version} is ready to install` : `Version ${version} is ready to install`;
    actions = updateBannerButton('install', 'Restart to update', true);
  } else {
    text = `Version ${version} is available`;
    if (!compact && state.error) text += `. ${escapeHtml(updateErrorText(state))}`;
    actions = state.canInstall
      ? updateBannerButton('download', state.errorPhase === 'download' ? 'Try again' : 'Update now', true)
      : updateBannerButton('open-release', 'Download', true);
  }

  const dismiss = `<button type="button" class="btn btn-ghost btn-icon btn-sm" data-update-action="dismiss" aria-label="Dismiss" title="Dismiss">${ICON_CLOSE}</button>`;
  return `
    <div class="update-banner${compact ? ' update-banner-compact' : ''}" role="status" data-status="${state.status}">
      <div class="update-banner-row">
        ${ICON_UPDATE}
        <span class="update-banner-text">${text}</span>
        <span class="update-banner-actions">${actions}${dismiss}</span>
      </div>
      ${progress}
    </div>`;
}

function updateBannerButton(action: UpdateBannerAction, label: string, primary: boolean): string {
  return `<button type="button" class="btn ${primary ? 'btn-primary' : 'btn-secondary'} btn-sm" data-update-action="${action}">${escapeHtml(label)}</button>`;
}

function updateErrorText(state: UpdateState): string {
  const what = state.errorPhase === 'download' ? 'The download failed' : 'Could not check for updates';
  return `${what}: ${state.error}`;
}

/** One-line status for the Preferences "Updates" row. */
function updateStatusText(state: UpdateState | null | undefined): string {
  if (!state) return '';
  const version = state.latestVersion ?? '';
  switch (state.status) {
    case 'disabled':
      return 'Update checks run only in installed builds.';
    case 'idle':
      return 'Not checked yet.';
    case 'checking':
      return 'Checking for updates…';
    case 'not-available':
      return 'You are on the latest version.';
    case 'available':
      if (state.error) return `Version ${version} is available. ${updateErrorText(state)}`;
      return state.canInstall
        ? `Version ${version} is available.`
        : `Version ${version} is available. This package cannot update itself, download it from the release page.`;
    case 'downloading':
      return `Downloading version ${version} (${Math.round(state.progress ?? 0)}%).`;
    case 'downloaded':
      return state.error
        ? `Version ${version} could not be installed: ${state.error}`
        : `Version ${version} is ready. Restart to update.`;
    case 'error':
      return `Could not check for updates: ${state.error ?? 'unknown error'}`;
    default:
      return '';
  }
}

/** Delegated click handling for banner buttons rendered inside `root`. */
function bindUpdateBanner(root: HTMLElement, handlers: Record<UpdateBannerAction, () => void>): void {
  root.addEventListener('click', e => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-update-action]');
    if (!btn || !root.contains(btn)) return;
    const action = btn.dataset.updateAction as UpdateBannerAction;
    const handler = handlers[action];
    if (!handler) return;
    if (action === 'download' || action === 'install') btn.disabled = true;
    handler();
  });
}
