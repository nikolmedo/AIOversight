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

  setupTabs();
  renderConnectors();
  renderEvents(initial.settings.recentEvents);
  renderGeneral(initial.settings, initial.settingsPath);
  renderIntegrate();
  loadLogs();
  reflectPaused();

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
  });
}

function reflectPaused(): void {
  $('#pauseBadge').classList.toggle('hidden', !paused);
  ($('#pauseBtn') as HTMLButtonElement).textContent = paused ? 'Resume' : 'Pause';
}

function setupTabs(): void {
  for (const tab of $$('.tab')) {
    tab.addEventListener('click', () => {
      $$('.tab').forEach(t => t.classList.toggle('active', t === tab));
      const target = (tab as HTMLElement).dataset.tab!;
      $$('.tab-panel').forEach(p => {
        const isTarget = p.id === `tab-${target}`;
        p.classList.toggle('active', isTarget);
        if (isTarget) {
          p.classList.remove('panel-enter');
          void (p as HTMLElement).offsetWidth;
          p.classList.add('panel-enter');
        }
      });
    });
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
            <input type="checkbox" data-role="enable-notifications" ${enabledState.notifications ? 'checked' : ''} />
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
            <input type="checkbox" data-role="enable-quota" ${enabledState.quota ? 'checked' : ''} />
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
  const buckets =
    q.buckets.length > 0
      ? q.buckets.map(b => renderQuotaBucket(b)).join('')
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

function renderQuotaBucket(b: QuotaBucket): string {
  const pct =
    b.limit != null && b.limit > 0 ? Math.min(100, Math.round((b.used / b.limit) * 100)) : null;
  const fillClass = pct == null ? '' : pct >= 90 ? 'critical' : pct >= 75 ? 'warn' : '';
  const stats =
    b.limit != null
      ? `${formatQuotaNumber(b.used, b.unit)} / ${formatQuotaNumber(b.limit, b.unit)} ${b.unit}`
      : `${formatQuotaNumber(b.used, b.unit)} ${b.unit} used`;
  const remaining =
    b.remaining != null ? ` · ${formatQuotaNumber(b.remaining, b.unit)} remaining` : '';
  const pctEl = pct != null
    ? `<span class="quota-bucket-pct ${fillClass}">${pct}%</span>`
    : '';
  const bar =
    pct != null
      ? `<div class="quota-bar"><div class="quota-bar-fill ${fillClass}" style="--fill:${pct}%"></div></div>`
      : '';
  return `
    <div class="quota-bucket">
      <div class="quota-bucket-header">
        <div class="quota-bucket-title">${escapeHtml(b.label)}</div>
        ${pctEl}
      </div>
      ${bar}
      <div class="quota-bucket-stats">${escapeHtml(stats + remaining)}</div>
    </div>
  `;
}

function formatQuotaNumber(n: number, unit: QuotaBucket['unit']): string {
  if (unit === 'usd') return `$${(n / 100).toFixed(2)}`;
  return n.toLocaleString();
}

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

function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString();
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

function renderGeneral(s: AppSettings, settingsPath: string): void {
  const showNotif = $('#showNotifications') as HTMLInputElement;
  const notifyWaiting = $('#notifyOnWaiting') as HTMLInputElement;
  const notifyFinished = $('#notifyOnFinished') as HTMLInputElement;
  const showQuotaTray = $('#showQuotaInTray') as HTMLInputElement;
  const quotaPoll = $('#quotaPollMinutes') as HTMLInputElement;
  const cooldown = $('#cooldown') as HTMLInputElement;
  const quietEnabled = $('#quietEnabled') as HTMLInputElement;
  const quietStart = $('#quietStart') as HTMLInputElement;
  const quietEnd = $('#quietEnd') as HTMLInputElement;

  showNotif.checked = s.showNotifications;
  notifyWaiting.checked = s.notifyOnWaiting !== false;
  notifyFinished.checked = s.notifyOnFinished !== false;
  showQuotaTray.checked = s.showQuotaInTray !== false;
  quotaPoll.value = String(s.quotaPollMinutes ?? 5);
  cooldown.value = String(Math.round(s.perSessionCooldownMs / 1000));
  quietEnabled.checked = !!s.quietHours;
  quietStart.value = String(s.quietHours?.startHour ?? 22);
  quietEnd.value = String(s.quietHours?.endHour ?? 8);
  $('#settingsPath').textContent = `Settings file: ${settingsPath}`;

  const persist = debounce(() => {
    void window.aw.update({
      showNotifications: showNotif.checked,
      notifyOnWaiting: notifyWaiting.checked,
      notifyOnFinished: notifyFinished.checked,
      showQuotaInTray: showQuotaTray.checked,
      quotaPollMinutes: Math.max(0, Number(quotaPoll.value)),
      perSessionCooldownMs: Math.max(1, Number(cooldown.value)) * 1000,
      quietHours: quietEnabled.checked
        ? { startHour: clampHour(quietStart.value), endHour: clampHour(quietEnd.value) }
        : null,
    });
  }, 250);

  for (const el of [
    showNotif,
    notifyWaiting,
    notifyFinished,
    showQuotaTray,
    quotaPoll,
    cooldown,
    quietEnabled,
    quietStart,
    quietEnd,
  ]) {
    el.addEventListener('change', persist);
    el.addEventListener('input', persist);
  }
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cssEscape(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch}`);
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

main().catch(err => console.error(err));
