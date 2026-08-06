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

  setupTabs();
  renderConnectors();
  renderTotalSpendCardPanel();
  renderCustomizeTab();
  renderEvents(initial.settings.recentEvents);
  renderGeneral(initial.settings, initial.settingsPath);
  renderIntegrate();
  loadLogs();
  reflectPaused();

  bindResetChips(document);
  bindTotalSpendCard(document, renderTotalSpendCardPanel);
  bindRowMenu(document, settingsRowMenuHandlers);
  bindCustomizeTab();
  setInterval(() => refreshResetChips(document), 30_000);

  $('#testBtn').addEventListener('click', () => window.aw.testNotification());
  $('#pauseBtn').addEventListener('click', async () => {
    paused = await window.aw.togglePause();
    reflectPaused();
  });
  $('#clearEvents').addEventListener('click', async () => {
    const s = await window.aw.clearEvents();
    renderEvents(s.recentEvents);
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

// ---------------------------------------------------------------------------
// Total Spend card (Phase 2b)
// ---------------------------------------------------------------------------

function renderTotalSpendCardPanel(): void {
  const el = document.getElementById('totalSpendCard');
  if (!el) return;
  // `#totalSpendCard:empty { display: none }` collapses the hidden card.
  // `initial.settings.showSpendCard` is kept current by renderGeneral's
  // toggle handler, so re-renders triggered by quota pushes respect it.
  el.innerHTML =
    initial.settings.showSpendCard !== false
      ? renderTotalSpendCard(quotas, initial.connectors)
      : '';
}

// ---------------------------------------------------------------------------
// Row context menu (Phase 2c) — shared markup/behavior from quota-view.ts;
// this is the settings-window-specific wiring (bridge calls, tab switch).
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
 * care about that (the row menu, the Customize tab's star button) compare
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
  openCustomize: () => activateTab('customize'),
};

// ---------------------------------------------------------------------------
// Customize tab (Phase 2c)
// ---------------------------------------------------------------------------

/**
 * Delegates to the shared `sortBucketsByDisplayOrder` (quota-math.ts) — the
 * same baseline sort `renderMeterGroup` uses for the live meter's row
 * groups. Deliberately NOT a locally-reimplemented sort: an earlier version
 * of this function sorted unordered buckets by raw declaration order while
 * `renderMeterGroup` sorted by usage-percentage descending, so a move click
 * computed from this tab's (different) baseline could silently reorder
 * buckets the user never touched relative to what they'd see in the live
 * meter. Note this doesn't split main/on-demand the way `renderMeterGroup`
 * does — the Customize tab intentionally lists every bucket in one list
 * regardless of hidden/visibility state.
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
  root.innerHTML = parts.join('') || '<p class="empty small">No quota integrations configured.</p>';
}

function renderCustomizeConnectorGroup(def: ConnectorMetadata, snap: QuotaSnapshot | undefined): string {
  const header = `<h3 class="vendor-heading">${escapeHtml(def.name)}</h3>`;
  if (!snap) {
    return `<div class="customize-group">${header}<p class="empty small">Not loaded yet — enable quota for this integration under Integrations.</p></div>`;
  }
  if (!snap.ok) {
    return `<div class="customize-group">${header}<p class="empty small">Last fetch failed: ${escapeHtml(snap.error)}</p></div>`;
  }
  if (snap.buckets.length === 0) {
    return `<div class="customize-group">${header}<p class="empty small">No usage buckets yet.</p></div>`;
  }

  const bucketPrefs = initial.settings.connectors.bucketPrefs?.[def.id];
  const orderedIds = customizeDisplayOrder(snap.buckets, bucketPrefs);
  const rows = orderedIds
    .map((id, i) => {
      const b = snap.buckets.find(x => x.id === id);
      if (!b) return '';
      return renderCustomizeRow(def.id, b, bucketPrefs?.[id], i === 0, i === orderedIds.length - 1);
    })
    .join('');
  return `<div class="customize-group" data-connector-id="${escapeHtml(def.id)}">${header}<div class="customize-rows">${rows}</div></div>`;
}

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
      <div class="customize-row-main">
        <span class="customize-row-label">${escapeHtml(b.label)}</span>
      </div>
      <div class="customize-row-controls">
        <label class="toggle inline">
          <input type="checkbox" class="switch" data-role="enabled" ${hidden ? '' : 'checked'} />
          <span>Shown</span>
        </label>
        <select class="control control-select" data-role="visibility">
          <option value="always" ${effectiveVisibility === 'always' ? 'selected' : ''}>Always Visible</option>
          <option value="onDemand" ${effectiveVisibility === 'onDemand' ? 'selected' : ''}>On Demand</option>
        </select>
        <button type="button" class="ghost small" data-role="star" aria-pressed="${starred}">${starred ? '★ Starred' : '☆ Star'}</button>
        <button type="button" class="ghost small" data-role="move-up" ${isFirst ? 'disabled' : ''} aria-label="Move up">↑</button>
        <button type="button" class="ghost small" data-role="move-down" ${isLast ? 'disabled' : ''} aria-label="Move down">↓</button>
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
          flashCustomizeMessage(row, `Cap reached — max ${MAX_STARRED_PER_CONNECTOR} starred per integration.`);
        } else {
          renderCustomizeTab();
        }
      });
    } else if (btn.dataset.role === 'move-up' || btn.dataset.role === 'move-down') {
      void moveCustomizeBucket(connectorId, bucketId, btn.dataset.role === 'move-up' ? 'up' : 'down');
    }
  });
}

function reflectPaused(): void {
  $('#pauseBadge').classList.toggle('hidden', !paused);
  ($('#pauseBtn') as HTMLButtonElement).textContent = paused ? 'Resume' : 'Pause';
}

function activateTab(name: string): void {
  $$('.tab').forEach(t => t.classList.toggle('active', (t as HTMLElement).dataset.tab === name));
  $$('.tab-panel').forEach(p => {
    const isTarget = p.id === `tab-${name}`;
    p.classList.toggle('active', isTarget);
    if (isTarget) {
      p.classList.remove('panel-enter');
      void (p as HTMLElement).offsetWidth;
      p.classList.add('panel-enter');
    }
  });
}

function setupTabs(): void {
  for (const tab of $$('.tab')) {
    tab.addEventListener('click', () => activateTab((tab as HTMLElement).dataset.tab!));
  }
}

// ---------------------------------------------------------------------------
// Integrations tab
// ---------------------------------------------------------------------------

function renderConnectors(): void {
  const root = $('#connectors');
  root.innerHTML = '';
  const groups = groupByVendor(initial.connectors);
  for (const [vendor, defs] of groups) {
    const group = document.createElement('div');
    group.className = 'vendor-group';
    group.innerHTML = `<h3 class="vendor-heading">${escapeHtml(vendor)}</h3>`;
    for (const def of defs) {
      group.appendChild(renderConnectorCard(def));
    }
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

function renderConnectorCard(def: ConnectorMetadata): HTMLElement {
  const enabledState =
    initial.settings.connectors.enabled[def.id] ??
    ({ notifications: false, quota: false } as ConnectorEnabled);
  const cfg = initial.settings.connectors.config[def.id] ?? {};

  const card = document.createElement('details');
  card.className = 'connector';
  card.dataset.connectorId = def.id;
  if (enabledState.notifications || enabledState.quota) card.setAttribute('open', '');

  const notifFields = def.configSchema.filter(f => (f.section ?? 'notifications') === 'notifications');
  const quotaFields = def.configSchema.filter(f => f.section === 'quota');

  const notifSection = def.hasDetector
    ? `
      <details class="connector-section" data-section="notifications" ${enabledState.notifications ? 'open' : ''}>
        <summary>
          <span class="section-title">Notifications</span>
          <label class="toggle inline">
            <input type="checkbox" class="switch" data-role="enable-notifications" ${enabledState.notifications ? 'checked' : ''} />
          </label>
        </summary>
        <div class="connector-section-body" data-fields="notifications"></div>
      </details>`
    : '';

  const quotaSection = def.hasQuota
    ? `
      <details class="connector-section" data-section="quota" ${enabledState.quota ? 'open' : ''}>
        <summary>
          <span class="section-title">Quota</span>
          <label class="toggle inline">
            <input type="checkbox" class="switch" data-role="enable-quota" ${enabledState.quota ? 'checked' : ''} />
          </label>
        </summary>
        <div class="connector-section-body" data-fields="quota">
          <div class="quota-snapshot" data-role="quota-snapshot"></div>
          <div class="quota-config"></div>
          <div class="quota-actions">
            <button class="small" data-role="refresh-quota">Refresh now</button>
            <span class="hint">Auto-refresh override:
              <input type="number" min="0" max="1440" class="num small" data-role="poll-override" />
              <span> minutes</span>
            </span>
          </div>
        </div>
      </details>`
    : '';

  card.innerHTML = `
    <summary class="connector-header">
      <div class="connector-title-block">
        <div class="connector-title">${escapeHtml(def.name)}</div>
        <div class="connector-desc">${escapeHtml(def.description)}</div>
      </div>
      <div class="connector-pills">
        ${def.hasDetector ? '<span class="pill pill-section">notifications</span>' : ''}
        ${def.hasQuota ? '<span class="pill pill-section">quota</span>' : ''}
      </div>
    </summary>
    ${notifSection}
    ${quotaSection}
  `;

  // Notification fields
  if (def.hasDetector) {
    const notifBody = card.querySelector(
      '[data-fields="notifications"]',
    ) as HTMLElement;
    for (const field of notifFields) {
      notifBody.appendChild(renderField(def.id, field, cfg[field.key] ?? field.default, def));
    }
    const enableNotif = card.querySelector(
      '[data-role="enable-notifications"]',
    ) as HTMLInputElement;
    enableNotif.addEventListener('change', () => {
      void window.aw.setConnectorEnabled(def.id, { notifications: enableNotif.checked });
      const local = initial.settings.connectors.enabled[def.id];
      if (local) local.notifications = enableNotif.checked;
    });
  }

  // Quota fields + snapshot panel + poll override
  if (def.hasQuota) {
    const cfgBody = card.querySelector('.quota-config') as HTMLElement;
    for (const field of quotaFields) {
      cfgBody.appendChild(renderField(def.id, field, cfg[field.key] ?? field.default, def));
    }
    const enableQuota = card.querySelector('[data-role="enable-quota"]') as HTMLInputElement;
    enableQuota.addEventListener('change', () => {
      void window.aw.setConnectorEnabled(def.id, { quota: enableQuota.checked });
      const local = initial.settings.connectors.enabled[def.id];
      if (local) local.quota = enableQuota.checked;
    });
    const refresh = card.querySelector('[data-role="refresh-quota"]') as HTMLButtonElement;
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
    const poll = card.querySelector('[data-role="poll-override"]') as HTMLInputElement;
    const overrideMin = initial.settings.connectors.pollOverrideMinutes?.[def.id];
    poll.value = overrideMin != null ? String(overrideMin) : '';
    poll.placeholder = String(def.defaultIntervalMinutes ?? 5);
    poll.addEventListener(
      'change',
      debounce(() => {
        const v = poll.value.trim();
        const minutes = v === '' ? null : Math.max(0, Number(v));
        void window.aw.setConnectorPollOverride(def.id, minutes);
      }, 250),
    );

    // The snapshot panel is re-rendered via innerHTML, so delegate the
    // "Sign in" click from the persistent panel element.
    const panel = card.querySelector('[data-role="quota-snapshot"]') as HTMLElement;
    panel.addEventListener('click', async e => {
      const btn = (e.target as HTMLElement).closest('[data-role="connector-login"]') as
        | HTMLButtonElement
        | null;
      if (!btn) return;
      btn.disabled = true;
      btn.textContent = 'Opening sign-in…';
      const id = btn.dataset.connectorId;
      if (id) await window.aw.connectorLogin(id);
    });

    refreshQuotaCardFor(card, def);
  }

  return card;
}

function renderField(
  connectorId: string,
  field: ConnectorConfigField,
  value: unknown,
  def: ConnectorMetadata,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'field';

  const label = document.createElement('label');
  label.textContent = field.label;
  wrap.appendChild(label);

  if (field.type === 'secret') {
    const input = document.createElement('input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.placeholder =
      def.setSecretKeys?.includes(field.key) ? '(set — paste a new value to replace)' : 'Not set';
    const row = document.createElement('div');
    row.className = 'secret-row';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'ghost small';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', async ev => {
      ev.preventDefault();
      const v = input.value;
      if (!v) return;
      const updated = await window.aw.setConnectorSecret(connectorId, field.key, v);
      const updatedDef = updated.find(d => d.id === connectorId);
      if (updatedDef) def.setSecretKeys = updatedDef.setSecretKeys;
      input.value = '';
      input.placeholder = '(set — paste a new value to replace)';
    });
    const clearBtn = document.createElement('button');
    clearBtn.className = 'ghost small';
    clearBtn.textContent = 'Clear';
    clearBtn.addEventListener('click', async ev => {
      ev.preventDefault();
      const updated = await window.aw.setConnectorSecret(connectorId, field.key, null);
      const updatedDef = updated.find(d => d.id === connectorId);
      if (updatedDef) def.setSecretKeys = updatedDef.setSecretKeys;
      input.value = '';
      input.placeholder = 'Not set';
    });
    row.appendChild(input);
    row.appendChild(saveBtn);
    row.appendChild(clearBtn);
    wrap.appendChild(row);
  } else {
    let input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if (field.type === 'paths') {
      input = document.createElement('textarea');
      input.value = Array.isArray(value) ? value.join('\n') : String(value ?? '');
    } else if (field.type === 'boolean') {
      input = document.createElement('input');
      (input as HTMLInputElement).type = 'checkbox';
      (input as HTMLInputElement).checked = Boolean(value);
    } else if (field.type === 'number') {
      input = document.createElement('input');
      (input as HTMLInputElement).type = 'number';
      input.value = String(value ?? field.default);
    } else if (field.type === 'enum') {
      const select = document.createElement('select');
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
      input.value = String(value ?? '');
    }

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
    wrap.appendChild(help);
  }
  return wrap;
}

function refreshQuotaCard(id: string): void {
  const card = document.querySelector(
    `.connector[data-connector-id="${cssEscape(id)}"]`,
  ) as HTMLElement | null;
  if (!card) return;
  const def = initial.connectors.find(c => c.id === id);
  if (!def) return;
  refreshQuotaCardFor(card, def);
}

function refreshQuotaCardFor(card: HTMLElement, def: ConnectorMetadata): void {
  const panel = card.querySelector('[data-role="quota-snapshot"]') as HTMLElement;
  if (!panel) return;
  panel.innerHTML = renderQuotaSnapshot(quotas[def.id], def);
}

function renderQuotaSnapshot(q: QuotaSnapshot | undefined, def?: ConnectorMetadata): string {
  if (!q) {
    return '<p class="empty small">No data yet — click <em>Refresh now</em>.</p>';
  }
  if (!q.ok) {
    const loginLabel = def
      ? (def.loginLabel ?? `Sign in to ${def.name}`)
      : '';
    const loginBtn =
      q.needsLogin && def
        ? `<button class="primary small" data-role="connector-login" data-connector-id="${escapeHtml(def.id)}">${escapeHtml(loginLabel)}</button>`
        : '';
    return `
      <div class="quota-error">${escapeHtml(q.error)}</div>
      ${loginBtn}
      <p class="quota-footnote">Last attempt: ${formatDateTime(q.fetchedAt)}</p>
    `;
  }
  const bucketPrefs = def ? initial.settings.connectors.bucketPrefs?.[def.id] : undefined;
  const buckets =
    q.buckets.length > 0
      ? renderMeterGroup(q.buckets, bucketPrefs, { connectorId: def?.id }) ||
        '<p class="empty small">No usage buckets returned.</p>'
      : '<p class="empty small">No usage buckets returned.</p>';
  const messages =
    q.displayMessages.length > 0
      ? `<ul class="quota-messages">${q.displayMessages.map(m => `<li>${escapeHtml(m)}</li>`).join('')}</ul>`
      : '';
  const metaParts: string[] = [];
  if (q.membershipType) metaParts.push(`Plan: ${q.membershipType}`);
  metaParts.push(`Updated ${formatDateTime(q.fetchedAt)}`);
  const metaLine = `<p class="quota-meta-line">${escapeHtml(metaParts.join(' · '))}</p>`;

  return `${buckets}${messages}${metaLine}`;
}

// renderQuotaBucket / formatQuotaNumber / formatDateTime moved to the shared
// quota-math.ts / quota-view.ts (loaded as global scripts before this file) —
// see renderMeterRow / formatQuotaValue / formatDateTime.

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Recent events
// ---------------------------------------------------------------------------

function renderEvents(events: RecentEvent[]): void {
  const list = $('#events');
  const empty = $('#eventsEmpty');
  list.innerHTML = '';
  if (events.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  for (const e of events) {
    const kind: EventKind = e.kind === 'finished' ? 'finished' : 'waiting';
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="agent">
        ${escapeHtml(e.agent)}
        <span class="pill pill-${kind}">${kind}</span>
      </span>
      <span class="msg">${escapeHtml(e.message)}</span>
      <span class="ts">${formatTime(e.ts)}</span>
    `;
    list.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// General
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
    transparentPopupHint.textContent = 'Not supported on Linux — this option is disabled here.';
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

async function loadLogs(): Promise<void> {
  const logs = await window.aw.logs();
  for (const e of logs) appendLog(e);
}

function appendLog(entry: LogEntry): void {
  const node = $('#logs');
  const meta = entry.meta ? ' ' + JSON.stringify(entry.meta) : '';
  node.textContent += `[${formatTime(entry.ts)}] ${entry.level.toUpperCase().padEnd(5)} ${entry.message}${meta}\n`;
  node.scrollTop = node.scrollHeight;
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
