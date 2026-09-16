// Vanilla-TS settings UI. Avoids `import` / `export` so tsc emits a plain
// <script>, not a CommonJS module. Type augmentations for `window.aw` live in
// `global.d.ts`.

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;
const $$ = <T extends HTMLElement>(sel: string): T[] =>
  Array.from(document.querySelectorAll(sel)) as T[];

let initial: InitialPayload;
let paused = false;
let quotas: Record<string, QuotaSnapshot> = {};

async function main() {
  initial = await window.aw.getInitial();
  paused = initial.paused;
  quotas = initial.quotas ?? {};

  document.body.insertAdjacentHTML('beforeend', renderRowMenu());

  setupNav();
  setupDrawer();
  renderConnectors();
  renderOverview();
  renderTotalSpendCardPanel();
  renderCustomizeTab();
  renderEvents(initial.settings.recentEvents);
  renderGeneral(initial.settings, initial.settingsPath);
  renderIntegrate();
  bindCopyButtons();
  loadLogs();
  reflectPaused();

  bindResetChips(document);
  bindTotalSpendCard(document, renderTotalSpendCardPanel);
  bindRowMenu(document, settingsRowMenuHandlers);
  bindCustomizeTab();
  bindConnectorLinks();
  setInterval(() => {
    refreshResetChips(document);
    renderEvents(initial.settings.recentEvents);
  }, 30_000);

  for (const btn of [$('#testBtn'), $('#testBtnPrefs')] as HTMLButtonElement[]) {
    btn.addEventListener('click', () => {
      void window.aw.testNotification();
      flashButtonLabel(btn, 'Sent');
    });
  }
  $('#pauseBtn').addEventListener('click', async () => {
    paused = await window.aw.togglePause();
    reflectPaused();
  });
  $('#clearEvents').addEventListener('click', async () => {
    const s = await window.aw.clearEvents();
    initial.settings.recentEvents = s.recentEvents;
    renderEvents(s.recentEvents);
  });
  const refreshAll = $('#refreshAllBtn') as HTMLButtonElement;
  refreshAll.addEventListener('click', async () => {
    refreshAll.disabled = true;
    try {
      const all = (await window.aw.refreshQuota()) as Record<string, QuotaSnapshot>;
      if (all) {
        quotas = { ...quotas, ...all };
        for (const id of Object.keys(all)) refreshQuotaCard(id);
        renderTotalSpendCardPanel();
        renderCustomizeTab();
      }
    } finally {
      refreshAll.disabled = false;
    }
  });

  window.aw.onEvent(e => {
    initial.settings.recentEvents.unshift(e);
    if (initial.settings.recentEvents.length > 50) initial.settings.recentEvents.length = 50;
    renderEvents(initial.settings.recentEvents);
  });
  window.aw.onLog(entry => appendLog(entry));
  window.aw.onPaused(p => {
    paused = p;
    reflectPaused();
  });
  window.aw.onQuotaUpdate(({ id, snapshot }) => {
    quotas[id] = snapshot;
    refreshQuotaCard(id);
    renderTotalSpendCardPanel();
    renderCustomizeTab();
  });
}

function flashButtonLabel(btn: HTMLButtonElement, label: string): void {
  const original = btn.dataset.label ?? btn.textContent ?? '';
  btn.dataset.label = original;
  btn.textContent = label;
  setTimeout(() => {
    btn.textContent = original;
  }, 1500);
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

const PAGES = ['overview', 'integrations', 'activity', 'preferences', 'webhook', 'logs'];
const PAGE_STORAGE_KEY = 'aio.settings.page';

function activatePage(name: string): void {
  const target = PAGES.includes(name) ? name : 'overview';
  for (const item of $$('.nav-item')) {
    if (item.dataset.page === target) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  for (const page of $$('.page')) page.hidden = page.dataset.page !== target;
  $('#content').scrollTop = 0;
  if (target === 'logs') {
    const logs = $('#logs');
    logs.scrollTop = logs.scrollHeight;
  }
  try {
    localStorage.setItem(PAGE_STORAGE_KEY, target);
  } catch {
    /* storage unavailable — page memory is a convenience only */
  }
}

function setupNav(): void {
  for (const item of $$('.nav-item')) {
    item.addEventListener('click', () => activatePage(item.dataset.page!));
  }
  document.addEventListener('click', e => {
    const link = (e.target as HTMLElement).closest('[data-goto]') as HTMLElement | null;
    if (link) activatePage(link.dataset.goto!);
  });
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(PAGE_STORAGE_KEY);
  } catch {
    stored = null;
  }
  activatePage(stored ?? 'overview');
}

function reflectPaused(): void {
  $('#pauseBadge').textContent = paused ? 'Paused' : 'Monitoring';
  $('#monitorDot').classList.toggle('paused', paused);
  ($('#pauseBtn') as HTMLButtonElement).textContent = paused ? 'Resume' : 'Pause';
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function isQuotaActive(def: ConnectorMetadata): boolean {
  return def.hasQuota && (!!initial.settings.connectors.enabled[def.id]?.quota || !!quotas[def.id]);
}

function renderOverview(): void {
  const defs = initial.connectors.filter(isQuotaActive);
  const list = $('#overviewQuotas');
  $('#overviewEmpty').hidden = defs.length > 0;
  list.hidden = defs.length === 0;
  list.innerHTML = defs.map(renderOverviewItem).join('');
}

function renderOverviewItem(def: ConnectorMetadata): string {
  const snap = quotas[def.id];
  const tag = snap?.ok && snap.membershipType ? `<span class="tag">${escapeHtml(snap.membershipType)}</span>` : '';
  const updated = snap
    ? `<span class="overview-updated num" title="${escapeHtml(formatDateTime(snap.fetchedAt))}">${escapeHtml(formatRelativeTime(snap.fetchedAt, Date.now()))}</span>`
    : '';

  let body: string;
  if (!snap) {
    body = '<p class="row-note">Waiting for the first refresh.</p>';
  } else if (!snap.ok && snap.appNotRunning) {
    body = renderAppNotRunningNotice(
      snap.error,
      `<button type="button" class="link-btn" data-open-connector="${escapeHtml(def.id)}">Configure</button>`,
    );
  } else if (!snap.ok) {
    body = `
      <div class="inline-error">
        <span class="inline-error-text" title="${escapeHtml(snap.error)}">${escapeHtml(snap.error)}</span>
        ${loginButtonFor(snap, def)}
        <button type="button" class="link-btn" data-open-connector="${escapeHtml(def.id)}">Configure</button>
      </div>`;
  } else {
    const bucketPrefs = initial.settings.connectors.bucketPrefs?.[def.id];
    body =
      (snap.buckets.length > 0 && renderMeterGroup(snap.buckets, bucketPrefs, { connectorId: def.id })) ||
      '<p class="row-note">No usage buckets returned.</p>';
  }

  return `
    <section class="overview-item" data-overview-id="${escapeHtml(def.id)}">
      <div class="overview-head">
        <button type="button" class="overview-name" data-open-connector="${escapeHtml(def.id)}">${escapeHtml(def.name)}</button>
        ${tag}
        ${updated}
      </div>
      <div class="overview-meters">${body}</div>
    </section>`;
}

// ---------------------------------------------------------------------------
// Total Spend (compact summary on Overview)
// ---------------------------------------------------------------------------

function renderTotalSpendCardPanel(): void {
  const el = document.getElementById('totalSpendCard');
  if (!el) return;
  // `#totalSpendCard:empty { display: none }` collapses the hidden card.
  // `initial.settings.showSpendCard` is kept current by renderGeneral's
  // toggle handler, so re-renders triggered by quota pushes respect it.
  el.innerHTML =
    initial.settings.showSpendCard !== false
      ? renderSpendSummary(quotas, initial.connectors)
      : '';
}

// ---------------------------------------------------------------------------
// Row context menu — shared markup/behavior from quota-view.ts; this is the
// settings-window-specific wiring (bridge calls, page switch).
// ---------------------------------------------------------------------------

function bucketPrefFor(connectorId: string, bucketId: string): BucketPref | undefined {
  return initial.settings.connectors.bucketPrefs?.[connectorId]?.[bucketId];
}

/**
 * Applies a bucket pref patch via the existing `connectors:setBucketPref` IPC
 * channel (exposed on the bridge as `setConnectorBucketPref`), then refreshes
 * `initial.settings` from the (authoritative) response — the star cap is
 * enforced server-side in `SettingsStore.setBucketPref`, so a `starred: true`
 * request past the cap comes back with `starred` still unset; callers that
 * care about that (the row menu, the Display group's star button) compare
 * before/after themselves.
 */
async function applyBucketPref(
  connectorId: string,
  bucketId: string,
  patch: Partial<BucketPref>,
): Promise<void> {
  initial.settings = await window.aw.setConnectorBucketPref(connectorId, bucketId, patch);
  refreshQuotaCard(connectorId);
}

const settingsRowMenuHandlers: RowMenuHandlers = {
  isHidden: t => !!bucketPrefFor(t.connectorId, t.bucketId)?.hidden,
  isStarred: t => !!bucketPrefFor(t.connectorId, t.bucketId)?.starred,
  canStar: t => {
    if (bucketPrefFor(t.connectorId, t.bucketId)?.starred) return true;
    const perConnector = initial.settings.connectors.bucketPrefs?.[t.connectorId] ?? {};
    const starredCount = Object.values(perConnector).filter(p => p.starred).length;
    return starredCount < MAX_STARRED_PER_CONNECTOR;
  },
  toggleHidden: t => {
    const hidden = !bucketPrefFor(t.connectorId, t.bucketId)?.hidden;
    void applyBucketPref(t.connectorId, t.bucketId, { hidden }).then(renderCustomizeTab);
  },
  toggleStarred: t => {
    const starred = !bucketPrefFor(t.connectorId, t.bucketId)?.starred;
    void applyBucketPref(t.connectorId, t.bucketId, { starred }).then(renderCustomizeTab);
  },
  refreshConnector: t => {
    void (async () => {
      const snap = (await window.aw.refreshQuota(t.connectorId)) as QuotaSnapshot;
      if (snap) {
        quotas[t.connectorId] = snap;
        refreshQuotaCard(t.connectorId);
        renderCustomizeTab();
      }
    })();
  },
  openCustomize: () => {
    closeDrawer();
    activatePage('preferences');
    document.getElementById('displayGroup')?.scrollIntoView({ block: 'start' });
  },
};

// ---------------------------------------------------------------------------
// Display group (bucket visibility / star / order)
// ---------------------------------------------------------------------------

/**
 * Delegates to the shared `sortBucketsByDisplayOrder` (quota-math.ts) — the
 * same baseline sort `renderMeterGroup` uses for the live meter's row
 * groups. Deliberately NOT a locally-reimplemented sort: an earlier version
 * of this function sorted unordered buckets by raw declaration order while
 * `renderMeterGroup` sorted by usage-percentage descending, so a move click
 * computed from this list's (different) baseline could silently reorder
 * buckets the user never touched relative to what they'd see in the live
 * meter. Note this doesn't split main/on-demand the way `renderMeterGroup`
 * does — this list intentionally shows every bucket in one list regardless
 * of hidden/visibility state.
 */
function customizeDisplayOrder(buckets: QuotaBucket[], bucketPrefs?: Record<string, BucketPref>): string[] {
  return sortBucketsByDisplayOrder(buckets, bucketPrefs).map(b => b.id);
}

function renderCustomizeTab(): void {
  const root = document.getElementById('customizeList');
  if (!root) return;
  const parts: string[] = [];
  for (const def of initial.connectors) {
    if (!def.hasQuota) continue;
    parts.push(renderCustomizeConnectorGroup(def, quotas[def.id]));
  }
  root.innerHTML = parts.join('') || '<p class="muted-line">No quota integrations configured.</p>';
}

function renderCustomizeConnectorGroup(def: ConnectorMetadata, snap: QuotaSnapshot | undefined): string {
  const header = `<div class="customize-head">${escapeHtml(def.name)}</div>`;
  const note = (text: string): string =>
    `<div class="customize-group surface-block">${header}<p class="customize-note">${text}</p></div>`;
  if (!snap) return note('Not loaded yet. Turn on quota for this integration in Integrations.');
  if (!snap.ok && snap.appNotRunning) return note(escapeHtml(snap.error));
  if (!snap.ok) return note(`Last fetch failed: ${escapeHtml(snap.error)}`);
  if (snap.buckets.length === 0) return note('No usage buckets yet.');

  const bucketPrefs = initial.settings.connectors.bucketPrefs?.[def.id];
  const orderedIds = customizeDisplayOrder(snap.buckets, bucketPrefs);
  const rows = orderedIds
    .map((id, i) => {
      const b = snap.buckets.find(x => x.id === id);
      if (!b) return '';
      return renderCustomizeRow(def.id, b, bucketPrefs?.[id], i === 0, i === orderedIds.length - 1);
    })
    .join('');
  return `<div class="customize-group surface-block" data-connector-id="${escapeHtml(def.id)}">${header}<div class="customize-rows">${rows}</div></div>`;
}

const ICON_STAR =
  '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2l1.8 3.7 4 .6-2.9 2.8.7 4L8 11.4l-3.6 1.9.7-4L2.2 6.5l4-.6z"/></svg>';
const ICON_UP = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 10l4-4 4 4"/></svg>';
const ICON_DOWN = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>';

function renderCustomizeRow(
  connectorId: string,
  b: QuotaBucket,
  pref: BucketPref | undefined,
  isFirst: boolean,
  isLast: boolean,
): string {
  const hidden = !!pref?.hidden;
  const starred = !!pref?.starred;
  const hasLimit = b.limit != null && b.limit > 0;
  const effectiveVisibility = pref?.visibility ?? b.defaultVisibility ?? (hasLimit ? 'always' : 'onDemand');

  return `
    <div class="customize-row" data-connector-id="${escapeHtml(connectorId)}" data-bucket-id="${escapeHtml(b.id)}">
      <label class="customize-row-main">
        <input type="checkbox" class="switch" data-role="enabled" ${hidden ? '' : 'checked'} aria-label="Show ${escapeHtml(b.label)}" />
        <span class="customize-row-label">${escapeHtml(b.label)}</span>
      </label>
      <div class="customize-row-controls">
        <select class="control control-select control-sm" data-role="visibility" aria-label="Visibility">
          <option value="always" ${effectiveVisibility === 'always' ? 'selected' : ''}>Always visible</option>
          <option value="onDemand" ${effectiveVisibility === 'onDemand' ? 'selected' : ''}>On demand</option>
        </select>
        <button type="button" class="btn btn-ghost btn-sm star-btn" data-role="star" aria-pressed="${starred}">${ICON_STAR}<span>${starred ? 'Starred' : 'Star'}</span></button>
        <button type="button" class="btn btn-ghost btn-sm btn-icon" data-role="move-up" ${isFirst ? 'disabled' : ''} aria-label="Move up">${ICON_UP}</button>
        <button type="button" class="btn btn-ghost btn-sm btn-icon" data-role="move-down" ${isLast ? 'disabled' : ''} aria-label="Move down">${ICON_DOWN}</button>
      </div>
    </div>
  `;
}

function flashCustomizeMessage(row: HTMLElement, msg: string): void {
  row.querySelector('.customize-row-note')?.remove();
  const note = document.createElement('div');
  note.className = 'customize-row-note';
  note.textContent = msg;
  row.appendChild(note);
  setTimeout(() => note.remove(), 2500);
}

/**
 * Connector ids with an in-flight reorder. `moveCustomizeBucket` computes its
 * target order from `initial.settings`'s current bucketPrefs and then writes
 * one `order` per bucket sequentially — a second reorder click on the same
 * connector before that sequence finishes would read the same stale
 * baseline and interleave writes with the first. The check-and-add below
 * happens synchronously, before any `await` (a plain `async function` body
 * runs synchronously up to its first `await`), so a rapid second click is a
 * no-op even before the visual disable takes effect.
 */
const pendingReorders = new Set<string>();

function setCustomizeGroupBusy(connectorId: string, busy: boolean): void {
  const group = document.querySelector(`.customize-group[data-connector-id="${cssEscape(connectorId)}"]`);
  if (!group) return;
  group.querySelectorAll<HTMLButtonElement>('[data-role="move-up"], [data-role="move-down"]').forEach(btn => {
    btn.disabled = busy;
  });
}

async function moveCustomizeBucket(
  connectorId: string,
  bucketId: string,
  direction: 'up' | 'down',
): Promise<void> {
  if (pendingReorders.has(connectorId)) return;
  pendingReorders.add(connectorId);
  setCustomizeGroupBusy(connectorId, true);
  try {
    const snap = quotas[connectorId];
    if (!snap || !snap.ok) return;
    const bucketPrefs = initial.settings.connectors.bucketPrefs?.[connectorId];
    const orderedIds = customizeDisplayOrder(snap.buckets, bucketPrefs);
    const next = computeReorderedOrders(orderedIds, bucketId, direction);
    if (!next) return;
    let latest = initial.settings;
    for (const [id, order] of Object.entries(next)) {
      latest = await window.aw.setConnectorBucketPref(connectorId, id, { order });
    }
    initial.settings = latest;
    refreshQuotaCard(connectorId);
  } finally {
    pendingReorders.delete(connectorId);
    // Full rebuild reflects the final state — and, on the no-op early-return
    // paths above, simply undoes the busy-disable with correct
    // per-row first/last disabled states, cheaper than tracking which
    // branch ran.
    renderCustomizeTab();
  }
}

function bindCustomizeTab(): void {
  const root = $('#customizeList');

  root.addEventListener('change', e => {
    const row = (e.target as HTMLElement).closest('.customize-row') as HTMLElement | null;
    if (!row) return;
    const connectorId = row.dataset.connectorId!;
    const bucketId = row.dataset.bucketId!;
    const target = e.target as HTMLElement;
    if (target.matches('[data-role="enabled"]')) {
      const hidden = !(target as HTMLInputElement).checked;
      void applyBucketPref(connectorId, bucketId, { hidden }).then(renderCustomizeTab);
    } else if (target.matches('[data-role="visibility"]')) {
      const visibility = (target as HTMLSelectElement).value as 'always' | 'onDemand';
      void applyBucketPref(connectorId, bucketId, { visibility }).then(renderCustomizeTab);
    }
  });

  root.addEventListener('click', e => {
    const btn = (e.target as HTMLElement).closest('button[data-role]') as HTMLButtonElement | null;
    if (!btn) return;
    const row = btn.closest('.customize-row') as HTMLElement;
    const connectorId = row.dataset.connectorId!;
    const bucketId = row.dataset.bucketId!;
    if (btn.dataset.role === 'star') {
      const wantStar = !bucketPrefFor(connectorId, bucketId)?.starred;
      void applyBucketPref(connectorId, bucketId, { starred: wantStar }).then(() => {
        const after = !!bucketPrefFor(connectorId, bucketId)?.starred;
        if (wantStar && !after) {
          flashCustomizeMessage(row, `Limit reached: at most ${MAX_STARRED_PER_CONNECTOR} starred per integration.`);
        } else {
          renderCustomizeTab();
        }
      });
    } else if (btn.dataset.role === 'move-up' || btn.dataset.role === 'move-down') {
      void moveCustomizeBucket(connectorId, bucketId, btn.dataset.role === 'move-up' ? 'up' : 'down');
    }
  });
}

// ---------------------------------------------------------------------------
// Integrations list
// ---------------------------------------------------------------------------

const STATUS_LABELS: Record<ConnectorStatus, string> = {
  off: 'Not configured',
  active: 'Active',
  error: 'Error',
  'needs-login': 'Needs sign-in',
  'app-not-running': 'App not running',
};

function statusFor(id: string): ConnectorStatus {
  return connectorStatusFor(initial.settings.connectors.enabled[id], quotas[id]);
}

function renderStatusBadge(id: string): string {
  const s = statusFor(id);
  return `<span class="status status-${s}"><span class="status-dot" aria-hidden="true"></span>${STATUS_LABELS[s]}</span>`;
}

function renderConnectors(): void {
  const root = $('#connectors');
  root.innerHTML = '';
  const groups = groupByVendor(initial.connectors);
  for (const [vendor, defs] of groups) {
    const group = document.createElement('section');
    group.className = 'group';
    group.innerHTML = `<h2 class="overline">${escapeHtml(vendor)}</h2>`;
    const list = document.createElement('div');
    list.className = 'surface-block integration-list';
    for (const def of defs) list.appendChild(renderIntegrationRow(def));
    group.appendChild(list);
    root.appendChild(group);
  }
}

function groupByVendor(defs: ConnectorMetadata[]): Map<string, ConnectorMetadata[]> {
  const out = new Map<string, ConnectorMetadata[]>();
  for (const def of defs) {
    const arr = out.get(def.vendor) ?? [];
    arr.push(def);
    out.set(def.vendor, arr);
  }
  return out;
}

function enableSwitch(def: ConnectorMetadata, cap: 'notifications' | 'quota', withLabel: boolean): string {
  const on = !!initial.settings.connectors.enabled[def.id]?.[cap];
  const text = cap === 'notifications' ? 'Notifications' : 'Quota';
  const label = withLabel ? `<span>${text}</span>` : '';
  return `<label class="switch-label">${label}<input type="checkbox" class="switch" data-role="enable-${cap}" data-connector-id="${escapeHtml(def.id)}" ${on ? 'checked' : ''} aria-label="${text} for ${escapeHtml(def.name)}" /></label>`;
}

function renderIntegrationRow(def: ConnectorMetadata): HTMLElement {
  const row = document.createElement('div');
  row.className = 'integration-row';
  row.dataset.connectorId = def.id;
  row.innerHTML = `
    <button type="button" class="integration-main" data-open-connector="${escapeHtml(def.id)}" aria-haspopup="dialog">
      <span class="integration-name">${escapeHtml(def.name)}</span>
      <span class="integration-desc" title="${escapeHtml(def.description)}">${escapeHtml(def.description)}</span>
    </button>
    <span class="integration-status" data-role="status">${renderStatusBadge(def.id)}</span>
    <div class="integration-switches">
      ${def.hasDetector ? enableSwitch(def, 'notifications', true) : '<span class="switch-placeholder"></span>'}
      ${def.hasQuota ? enableSwitch(def, 'quota', true) : '<span class="switch-placeholder"></span>'}
    </div>
  `;
  return row;
}

/** Enable toggles exist both in the list and in the drawer; one delegated
 * handler keeps every copy, the local settings mirror and the status in sync. */
function bindConnectorLinks(): void {
  document.addEventListener('change', e => {
    const input = e.target as HTMLInputElement;
    const role = input.dataset?.role;
    if (role !== 'enable-notifications' && role !== 'enable-quota') return;
    const id = input.dataset.connectorId!;
    const cap = role === 'enable-notifications' ? 'notifications' : 'quota';
    const checked = input.checked;
    const enabledMap = initial.settings.connectors.enabled;
    enabledMap[id] = { ...(enabledMap[id] ?? { notifications: false, quota: false }), [cap]: checked };
    for (const other of $$<HTMLInputElement>(`input[data-role="${role}"][data-connector-id="${cssEscape(id)}"]`)) {
      other.checked = checked;
    }
    // Quota pushes are incremental and never remove a snapshot, so drop it
    // here or Overview keeps showing a connector the user just switched off.
    if (cap === 'quota' && !checked) delete quotas[id];
    refreshQuotaCard(id);
    renderCustomizeTab();
    renderTotalSpendCardPanel();
    void window.aw.setConnectorEnabled(id, { [cap]: checked });
  });

  document.addEventListener('click', async e => {
    const target = e.target as HTMLElement;
    const opener = target.closest('[data-open-connector]') as HTMLElement | null;
    if (opener) {
      const onIntegrations = !!opener.closest('.page[data-page="integrations"]');
      if (!onIntegrations) activatePage('integrations');
      openDrawer(opener.dataset.openConnector!, onIntegrations ? opener : undefined);
      return;
    }
    const login = target.closest('[data-role="connector-login"]') as HTMLButtonElement | null;
    if (login) {
      login.disabled = true;
      login.textContent = 'Opening sign-in…';
      const id = login.dataset.connectorId;
      if (id) await window.aw.connectorLogin(id);
    }
  });
}

// ---------------------------------------------------------------------------
// Connector detail drawer
// ---------------------------------------------------------------------------

let drawerOpener: HTMLElement | null = null;

function drawerEl(): HTMLElement {
  return $('#connectorDrawer');
}

function setupDrawer(): void {
  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#drawerBackdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', e => {
    const drawer = drawerEl();
    if (drawer.hidden) return;
    if (e.key === 'Escape') {
      // The row context menu handles its own Escape first.
      const menu = document.getElementById('rowMenu');
      if (menu && !menu.hidden) return;
      e.preventDefault();
      closeDrawer();
    } else if (e.key === 'Tab') {
      const focusables = Array.from(
        drawer.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])'),
      ).filter(el => !(el as HTMLButtonElement).disabled && el.offsetParent !== null);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === drawer)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });
}

function openDrawer(id: string, opener?: HTMLElement): void {
  const def = initial.connectors.find(c => c.id === id);
  if (!def) return;
  const drawer = drawerEl();
  if (drawer.hidden) drawerOpener = opener ?? null;
  drawer.dataset.connectorId = id;
  $('#drawerTitle').textContent = def.name;
  $('#drawerVendor').textContent = def.vendor;
  const body = $('#drawerBody');
  body.innerHTML = '';
  body.appendChild(renderConnectorDetail(def));
  body.scrollTop = 0;
  $('#drawerBackdrop').hidden = false;
  drawer.hidden = false;
  $('#drawerClose').focus();
}

function closeDrawer(): void {
  const drawer = drawerEl();
  if (drawer.hidden) return;
  drawer.hidden = true;
  $('#drawerBackdrop').hidden = true;
  const id = drawer.dataset.connectorId;
  drawer.dataset.connectorId = '';
  $('#drawerBody').innerHTML = '';
  const target =
    drawerOpener && drawerOpener.isConnected
      ? drawerOpener
      : id
        ? (document.querySelector(`.integration-row[data-connector-id="${cssEscape(id)}"] .integration-main`) as HTMLElement | null)
        : null;
  drawerOpener = null;
  target?.focus();
}

function renderConnectorDetail(def: ConnectorMetadata): HTMLElement {
  const cfg = initial.settings.connectors.config[def.id] ?? {};
  const root = document.createElement('div');
  root.className = 'detail';

  const notifFields = def.configSchema.filter(f => (f.section ?? 'notifications') === 'notifications');
  const quotaFields = def.configSchema.filter(f => f.section === 'quota');

  const notifSection = def.hasDetector
    ? `
      <section class="detail-section" data-section="notifications">
        <div class="detail-section-head">
          <h3 class="overline">Notifications</h3>
          ${enableSwitch(def, 'notifications', false)}
        </div>
        <div class="detail-fields" data-fields="notifications"></div>
      </section>`
    : '';

  const quotaSection = def.hasQuota
    ? `
      <section class="detail-section" data-section="quota">
        <div class="detail-section-head">
          <h3 class="overline">Quota</h3>
          ${enableSwitch(def, 'quota', false)}
        </div>
        <div class="quota-snapshot" data-role="quota-snapshot"></div>
        <div class="detail-fields quota-config"></div>
        <div class="field field-inline">
          <label for="pollOverride-${escapeHtml(def.id)}">Auto-refresh override
            <span class="help">Minutes. Leave empty to use the default.</span>
          </label>
          <input type="number" min="0" max="1440" class="control control-num" id="pollOverride-${escapeHtml(def.id)}" data-role="poll-override" />
        </div>
        <div class="detail-actions">
          <button type="button" class="btn btn-secondary" data-role="refresh-quota">Refresh now</button>
        </div>
      </section>`
    : '';

  root.innerHTML = `
    <p class="detail-desc">${escapeHtml(def.description)}</p>
    ${notifSection}
    ${quotaSection}
  `;

  if (def.hasDetector) {
    const notifBody = root.querySelector('[data-fields="notifications"]') as HTMLElement;
    for (const field of notifFields) {
      notifBody.appendChild(renderField(def.id, field, cfg[field.key] ?? field.default, def));
    }
    if (notifFields.length === 0) notifBody.remove();
  }

  if (def.hasQuota) {
    const cfgBody = root.querySelector('.quota-config') as HTMLElement;
    for (const field of quotaFields) {
      cfgBody.appendChild(renderField(def.id, field, cfg[field.key] ?? field.default, def));
    }
    if (quotaFields.length === 0) cfgBody.remove();

    const refresh = root.querySelector('[data-role="refresh-quota"]') as HTMLButtonElement;
    refresh.addEventListener('click', async () => {
      refresh.disabled = true;
      try {
        const snap = (await window.aw.refreshQuota(def.id)) as QuotaSnapshot;
        if (snap) {
          quotas[def.id] = snap;
          refreshQuotaCard(def.id);
        }
      } finally {
        refresh.disabled = false;
      }
    });
    const poll = root.querySelector('[data-role="poll-override"]') as HTMLInputElement;
    const overrideMin = initial.settings.connectors.pollOverrideMinutes?.[def.id];
    poll.value = overrideMin != null ? String(overrideMin) : '';
    poll.placeholder = String(def.defaultIntervalMinutes ?? 5);
    poll.addEventListener(
      'change',
      debounce(() => {
        const v = poll.value.trim();
        const minutes = v === '' ? null : Math.max(0, Number(v));
        void window.aw.setConnectorPollOverride(def.id, minutes);
        const overrides = (initial.settings.connectors.pollOverrideMinutes ??= {});
        if (minutes == null) delete overrides[def.id];
        else overrides[def.id] = minutes;
      }, 250),
    );

    const panel = root.querySelector('[data-role="quota-snapshot"]') as HTMLElement;
    panel.innerHTML = renderQuotaSnapshot(quotas[def.id], def);
  }

  return root;
}

let fieldSeq = 0;

function renderField(
  connectorId: string,
  field: ConnectorConfigField,
  value: unknown,
  def: ConnectorMetadata,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const inputId = `field-${++fieldSeq}`;

  const label = document.createElement('label');
  label.htmlFor = inputId;
  label.textContent = field.label;
  wrap.appendChild(label);

  if (field.type === 'secret') {
    const isSet = (): boolean => !!def.setSecretKeys?.includes(field.key);
    const state = document.createElement('span');
    const reflect = (): void => {
      state.className = isSet() ? 'tag tag-ok' : 'tag';
      state.textContent = isSet() ? 'Set' : 'Not set';
    };
    label.appendChild(state);

    const input = document.createElement('input');
    input.type = 'password';
    input.id = inputId;
    input.className = 'control';
    input.autocomplete = 'off';
    input.placeholder = isSet() ? 'Paste a new value to replace' : 'Paste value';
    const row = document.createElement('div');
    row.className = 'secret-row';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn btn-secondary';
    saveBtn.textContent = 'Set';
    saveBtn.addEventListener('click', async ev => {
      ev.preventDefault();
      const v = input.value;
      if (!v) return;
      const updated = await window.aw.setConnectorSecret(connectorId, field.key, v);
      const updatedDef = updated.find(d => d.id === connectorId);
      if (updatedDef) def.setSecretKeys = updatedDef.setSecretKeys;
      input.value = '';
      input.placeholder = 'Paste a new value to replace';
      reflect();
    });
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'btn btn-ghost';
    clearBtn.textContent = 'Clear';
    clearBtn.addEventListener('click', async ev => {
      ev.preventDefault();
      const updated = await window.aw.setConnectorSecret(connectorId, field.key, null);
      const updatedDef = updated.find(d => d.id === connectorId);
      if (updatedDef) def.setSecretKeys = updatedDef.setSecretKeys;
      input.value = '';
      input.placeholder = 'Paste value';
      reflect();
    });
    reflect();
    row.appendChild(input);
    row.appendChild(saveBtn);
    row.appendChild(clearBtn);
    wrap.appendChild(row);
  } else {
    let input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if (field.type === 'paths') {
      input = document.createElement('textarea');
      input.className = 'control control-textarea';
      input.value = Array.isArray(value) ? value.join('\n') : String(value ?? '');
    } else if (field.type === 'boolean') {
      input = document.createElement('input');
      (input as HTMLInputElement).type = 'checkbox';
      input.className = 'switch';
      (input as HTMLInputElement).checked = Boolean(value);
      wrap.classList.add('field-inline');
    } else if (field.type === 'number') {
      input = document.createElement('input');
      (input as HTMLInputElement).type = 'number';
      input.className = 'control control-num';
      input.value = String(value ?? field.default);
    } else if (field.type === 'enum') {
      const select = document.createElement('select');
      select.className = 'control control-select';
      const current = String(value ?? field.default);
      for (const opt of field.options ?? []) {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        if (opt.value === current) o.selected = true;
        select.appendChild(o);
      }
      input = select;
    } else {
      input = document.createElement('input');
      (input as HTMLInputElement).type = 'text';
      input.className = 'control';
      input.value = String(value ?? '');
    }
    input.id = inputId;

    const persist = debounce(() => {
      let val: unknown;
      if (field.type === 'paths') {
        val = (input.value as string).split('\n').map(s => s.trim()).filter(Boolean);
      } else if (field.type === 'boolean') {
        val = (input as HTMLInputElement).checked;
      } else if (field.type === 'number') {
        val = Number(input.value);
      } else {
        val = input.value;
      }
      // Drawer content is rebuilt on every open, so keep the local mirror current.
      (initial.settings.connectors.config[connectorId] ??= {})[field.key] = val;
      void window.aw.setConnectorConfig(connectorId, { [field.key]: val });
    }, 350);

    input.addEventListener('input', persist);
    input.addEventListener('change', persist);
    wrap.appendChild(input);
  }

  if (field.help) {
    const help = document.createElement('div');
    help.className = 'help';
    help.textContent = field.help;
    if (field.type === 'boolean') label.appendChild(help);
    else wrap.appendChild(help);
  }
  return wrap;
}

/** Re-renders every surface that shows connector `id`'s quota or status. */
function refreshQuotaCard(id: string): void {
  const def = initial.connectors.find(c => c.id === id);
  if (!def) return;
  const statusCell = document.querySelector(
    `.integration-row[data-connector-id="${cssEscape(id)}"] [data-role="status"]`,
  );
  if (statusCell) statusCell.innerHTML = renderStatusBadge(id);
  const drawer = drawerEl();
  if (!drawer.hidden && drawer.dataset.connectorId === id) {
    const panel = drawer.querySelector('[data-role="quota-snapshot"]') as HTMLElement | null;
    if (panel) panel.innerHTML = renderQuotaSnapshot(quotas[id], def);
  }
  renderOverview();
}

/**
 * `loginLabel` is the renderer's only signal that the connector actually
 * declares a `login` handler (runtime.ts sets it from `c.login?.label`,
 * which is required on ConnectorLogin). Gate on it rather than defaulting
 * to "Sign in to <name>": a connector can legitimately report `needsLogin`
 * for a sign-in that happens OUTSIDE this app (codex-cli wants `codex login`
 * in a terminal), and a button wired to a handler that doesn't exist does
 * nothing when clicked. Without a handler the snapshot's own error text —
 * which carries the instruction — is all the user gets.
 */
function loginButtonFor(q: QuotaSnapshot, def?: ConnectorMetadata): string {
  if (q.ok || !q.needsLogin || !def?.loginLabel) return '';
  return `<button type="button" class="btn btn-primary btn-sm" data-role="connector-login" data-connector-id="${escapeHtml(def.id)}">${escapeHtml(def.loginLabel)}</button>`;
}

function renderQuotaSnapshot(q: QuotaSnapshot | undefined, def?: ConnectorMetadata): string {
  if (!q) {
    return '<p class="row-note">No data yet. Use <em>Refresh now</em>.</p>';
  }
  if (!q.ok && q.appNotRunning) {
    return `
      ${renderAppNotRunningNotice(q.error)}
      <p class="quota-meta-line">Last checked ${escapeHtml(formatDateTime(q.fetchedAt))}</p>
    `;
  }
  if (!q.ok) {
    return `
      <div class="quota-error">${escapeHtml(q.error)}</div>
      ${loginButtonFor(q, def)}
      <p class="quota-meta-line">Last attempt ${escapeHtml(formatDateTime(q.fetchedAt))}</p>
    `;
  }
  const bucketPrefs = def ? initial.settings.connectors.bucketPrefs?.[def.id] : undefined;
  const buckets =
    q.buckets.length > 0
      ? renderMeterGroup(q.buckets, bucketPrefs, { connectorId: def?.id }) ||
        '<p class="row-note">No usage buckets returned.</p>'
      : '<p class="row-note">No usage buckets returned.</p>';
  const messages =
    q.displayMessages.length > 0
      ? `<ul class="quota-messages">${q.displayMessages.map(m => `<li>${escapeHtml(m)}</li>`).join('')}</ul>`
      : '';
  const metaParts: string[] = [];
  if (q.membershipType) metaParts.push(`Plan: ${q.membershipType}`);
  metaParts.push(`Updated ${formatDateTime(q.fetchedAt)}`);
  const metaLine = `<p class="quota-meta-line">${escapeHtml(metaParts.join(' · '))}</p>`;

  return `<div class="snapshot-meters">${buckets}</div>${messages}${metaLine}`;
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

function renderEventItem(e: RecentEvent, now: number): string {
  const kind: EventKind = e.kind === 'finished' ? 'finished' : 'waiting';
  const source = e.source
    ? `<span class="event-source" title="${escapeHtml(e.source)}"><bdi>${escapeHtml(e.source)}</bdi></span>`
    : '';
  return `
    <li class="event-row">
      <span class="pill pill-${kind}">${kind === 'finished' ? 'Finished' : 'Waiting'}</span>
      <span class="event-main">
        <span class="event-line">
          <span class="event-agent">${escapeHtml(e.agent)}</span>
          <span class="event-msg" title="${escapeHtml(e.message)}">${escapeHtml(e.message)}</span>
        </span>
        ${source}
      </span>
      <time class="event-time num" title="${escapeHtml(new Date(e.ts).toLocaleString())}">${escapeHtml(formatRelativeTime(e.ts, now))}</time>
    </li>`;
}

function renderEvents(events: RecentEvent[]): void {
  const now = Date.now();
  const list = $('#events');
  const empty = $('#eventsEmpty');
  list.innerHTML = events.map(e => renderEventItem(e, now)).join('');
  list.hidden = events.length === 0;
  empty.classList.toggle('hidden', events.length > 0);

  const recent = events.slice(0, 5);
  const overview = $('#overviewEvents');
  overview.innerHTML = recent.map(e => renderEventItem(e, now)).join('');
  overview.hidden = recent.length === 0;
  $('#overviewEventsEmpty').hidden = recent.length > 0;
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

function applyDensityClass(mode: 'default' | 'compact'): void {
  document.body.classList.toggle('density-compact', mode === 'compact');
}

function renderGeneral(s: AppSettings, settingsPath: string): void {
  const launchAtLogin = $('#launchAtLogin') as HTMLInputElement;
  const showNotif = $('#showNotifications') as HTMLInputElement;
  const notifyWaiting = $('#notifyOnWaiting') as HTMLInputElement;
  const notifyFinished = $('#notifyOnFinished') as HTMLInputElement;
  const showQuotaTray = $('#showQuotaInTray') as HTMLInputElement;
  const quotaPoll = $('#quotaPollMinutes') as HTMLInputElement;
  const cooldown = $('#cooldown') as HTMLInputElement;
  const quietEnabled = $('#quietEnabled') as HTMLInputElement;
  const quietStart = $('#quietStart') as HTMLInputElement;
  const quietEnd = $('#quietEnd') as HTMLInputElement;
  const theme = $('#theme') as HTMLSelectElement;
  const density = $('#density') as HTMLSelectElement;
  const timeFormat = $('#timeFormat') as HTMLSelectElement;
  const transparentPopup = $('#transparentPopup') as HTMLInputElement;
  const transparentPopupHint = $('#transparentPopupHint');
  const showSpendCard = $('#showSpendCard') as HTMLInputElement;
  const popupShortcut = $('#popupShortcut') as HTMLInputElement;
  const popupShortcutStatus = $('#popupShortcutStatus');

  launchAtLogin.checked = s.launchAtLogin;
  showNotif.checked = s.showNotifications;
  notifyWaiting.checked = s.notifyOnWaiting !== false;
  notifyFinished.checked = s.notifyOnFinished !== false;
  showQuotaTray.checked = s.showQuotaInTray !== false;
  quotaPoll.value = String(s.quotaPollMinutes ?? 5);
  cooldown.value = String(Math.round(s.perSessionCooldownMs / 1000));
  quietEnabled.checked = !!s.quietHours;
  quietStart.value = String(s.quietHours?.startHour ?? 22);
  quietEnd.value = String(s.quietHours?.endHour ?? 8);
  theme.value = s.theme ?? 'system';
  density.value = s.density ?? 'default';
  timeFormat.value = s.timeFormat ?? 'auto';
  transparentPopup.checked = !!s.transparentPopup;
  showSpendCard.checked = s.showSpendCard !== false;
  popupShortcut.value = s.popupShortcut ?? '';
  $('#settingsPath').textContent = `Settings file: ${settingsPath}`;

  applyDensityClass(density.value as 'default' | 'compact');
  setTimeFormatPref(timeFormat.value as 'auto' | '12h' | '24h');

  // Windows/macOS-only per main/tray-popup.ts's setTransparent — Linux has no
  // implementation, so the control is disabled rather than silently no-op'd.
  if (initial.platform === 'linux') {
    transparentPopup.disabled = true;
    transparentPopupHint.textContent = 'Not supported on Linux, so this option is disabled here.';
  }

  const persist = debounce(() => {
    void window.aw.update({
      launchAtLogin: launchAtLogin.checked,
      showNotifications: showNotif.checked,
      notifyOnWaiting: notifyWaiting.checked,
      notifyOnFinished: notifyFinished.checked,
      showQuotaInTray: showQuotaTray.checked,
      quotaPollMinutes: Math.max(0, Number(quotaPoll.value)),
      perSessionCooldownMs: Math.max(1, Number(cooldown.value)) * 1000,
      quietHours: quietEnabled.checked
        ? { startHour: clampHour(quietStart.value), endHour: clampHour(quietEnd.value) }
        : null,
      theme: theme.value as AppSettings['theme'],
      density: density.value as AppSettings['density'],
      timeFormat: timeFormat.value as AppSettings['timeFormat'],
      transparentPopup: transparentPopup.checked,
      showSpendCard: showSpendCard.checked,
    });
    applyDensityClass(density.value as 'default' | 'compact');
    setTimeFormatPref(timeFormat.value as 'auto' | '12h' | '24h');
    // Keep the module-level copy current and reflect the toggle immediately
    // (renderTotalSpendCardPanel reads initial.settings.showSpendCard).
    initial.settings.showSpendCard = showSpendCard.checked;
    renderTotalSpendCardPanel();
  }, 250);

  for (const el of [
    launchAtLogin,
    showNotif,
    notifyWaiting,
    notifyFinished,
    showQuotaTray,
    quotaPoll,
    cooldown,
    quietEnabled,
    quietStart,
    quietEnd,
    theme,
    density,
    timeFormat,
    transparentPopup,
    showSpendCard,
  ]) {
    el.addEventListener('change', persist);
    el.addEventListener('input', persist);
  }

  // The shortcut has its own IPC channel (settings:setPopupShortcut) rather
  // than riding the debounced `update()` above, so a taken-accelerator
  // failure can be attributed to this one field instead of the whole patch.
  $('#popupShortcutSave').addEventListener('click', async () => {
    const res = await window.aw.setPopupShortcut(popupShortcut.value.trim());
    popupShortcutStatus.textContent = res.ok
      ? 'Shortcut set.'
      : `Could not set shortcut: ${res.reason ?? 'unknown error'}`;
  });
  $('#popupShortcutClear').addEventListener('click', async () => {
    popupShortcut.value = '';
    const res = await window.aw.setPopupShortcut('');
    popupShortcutStatus.textContent = res.ok ? 'Shortcut cleared.' : `Failed to clear: ${res.reason ?? 'unknown error'}`;
  });
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

function renderIntegrate(): void {
  const webhookDef = initial.connectors.find(c => c.integrateInfo?.type === 'http-notify');
  if (!webhookDef) return;
  const info = webhookDef.integrateInfo!;
  const cfg = initial.settings.connectors.config[webhookDef.id] ?? {};
  const host = String(cfg[info.hostKey] ?? '127.0.0.1');
  const port = Number(cfg[info.portKey] ?? 53127);
  const token = info.tokenKey ? String(cfg[info.tokenKey] ?? '') : '';
  const tokenLine = token ? `\\\n     -H "X-AI-Oversight-Token: ${token}" ` : '';
  $('#curlExample').textContent =
`# 'waiting' (default): agent is paused on a tool / approval
curl -X POST http://${host}:${port}/notify ${tokenLine}\\
     -H "Content-Type: application/json" \\
     -d '{"agent":"My Tool","message":"Approve database migration?"}'

# 'finished': agent has completed its task
curl -X POST http://${host}:${port}/notify ${tokenLine}\\
     -H "Content-Type: application/json" \\
     -d '{"agent":"My Tool","kind":"finished","message":"Migration applied"}'`;
}

function bindCopyButtons(): void {
  for (const btn of $$<HTMLButtonElement>('[data-copy]')) {
    btn.addEventListener('click', async () => {
      const source = document.getElementById(btn.dataset.copy!);
      if (!source || !navigator.clipboard) return;
      try {
        await navigator.clipboard.writeText(source.textContent ?? '');
        flashButtonLabel(btn, 'Copied');
      } catch {
        /* clipboard permission denied — leave the text selectable instead */
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

async function loadLogs(): Promise<void> {
  const logs = await window.aw.logs();
  for (const e of logs) appendLog(e);
}

function appendLog(entry: LogEntry): void {
  const node = $('#logs');
  const stickToBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
  const meta = entry.meta ? ' ' + JSON.stringify(entry.meta) : '';
  const line = document.createElement('div');
  line.className = 'log-line';
  line.innerHTML = `<span class="log-time num">${escapeHtml(formatTime(entry.ts))}</span><span class="log-level log-${entry.level}">${entry.level.toUpperCase()}</span><span class="log-msg"></span>`;
  (line.lastElementChild as HTMLElement).textContent = entry.message + meta;
  node.appendChild(line);
  if (stickToBottom) node.scrollTop = node.scrollHeight;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampHour(s: string): number {
  const n = Number(s);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(23, Math.round(n)));
}

function debounce<F extends (...args: never[]) => void>(fn: F, ms: number): F {
  let t: ReturnType<typeof setTimeout> | null = null;
  return ((...args: Parameters<F>) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  }) as F;
}

// escapeHtml moved to the shared quota-view.ts (global script).

function cssEscape(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch}`);
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

main().catch(err => console.error(err));
