(function () {
  function $(sel: string): HTMLElement {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`Missing element: ${sel}`);
    return el as HTMLElement;
  }

  function escapeHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatQuotaNumber(n: number, unit: QuotaBucket['unit']): string {
    if (unit === 'usd') return `$${(n / 100).toFixed(2)}`;
    return n.toLocaleString();
  }

  function formatDateTime(ts: number): string {
    return new Date(ts).toLocaleString();
  }

  let connectors: ConnectorMetadata[] = [];
  let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let countdownTimer: ReturnType<typeof setInterval> | null = null;
  let nextRefreshAt = 0;

  const AUTO_REFRESH_MS = 30_000;

  function updateCountdown(): void {
    const el = document.getElementById('refreshTimer');
    if (!el) return;
    const secs = Math.max(0, Math.round((nextRefreshAt - Date.now()) / 1000));
    el.textContent = `auto · ${secs}s`;
  }

  function startAutoRefresh(): void {
    stopAutoRefresh();
    nextRefreshAt = Date.now() + AUTO_REFRESH_MS;
    updateCountdown();

    countdownTimer = setInterval(updateCountdown, 1_000);
    autoRefreshTimer = setInterval(async () => {
      nextRefreshAt = Date.now() + AUTO_REFRESH_MS;
      const btn = document.getElementById('refreshAll') as HTMLButtonElement | null;
      if (btn) btn.disabled = true;
      try {
        const next = (await window.awPopup.refresh()) as Record<string, QuotaSnapshot>;
        render(next);
        requestAnimationFrame(() => requestAnimationFrame(reportSize));
      } finally {
        if (btn) btn.disabled = false;
      }
    }, AUTO_REFRESH_MS);
  }

  function stopAutoRefresh(): void {
    if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
    if (countdownTimer)   { clearInterval(countdownTimer);   countdownTimer   = null; }
    const el = document.getElementById('refreshTimer');
    if (el) el.textContent = '';
  }

  function renderBucket(b: QuotaBucket, options?: { collapsible?: boolean }): string {
    const pct =
      b.limit != null && b.limit > 0 ? Math.min(100, Math.round((b.used / b.limit) * 100)) : null;
    const fillClass = pct == null ? '' : pct >= 90 ? 'critical' : pct >= 75 ? 'warn' : '';
    const stats =
      b.limit != null
        ? `${formatQuotaNumber(b.used, b.unit)} / ${formatQuotaNumber(b.limit, b.unit)} ${b.unit}`
        : `${formatQuotaNumber(b.used, b.unit)} ${b.unit} used`;
    const remaining =
      b.remaining != null ? ` · ${formatQuotaNumber(b.remaining, b.unit)} left` : '';
    const statsLine = `${stats}${remaining}`;
    const bar =
      pct != null
        ? `<div class="quota-bar"><div class="quota-bar-fill ${fillClass}" style="--fill:${pct}%"></div></div>`
        : '';

    if (options?.collapsible) {
      const hint = pct != null ? `${pct}%` : stats;
      return `
        <details class="quota-bucket quota-bucket-collapsible">
          <summary>
            <span class="quota-bucket-title">${escapeHtml(b.label)}</span>
            <span class="quota-bucket-hint ${fillClass}">${escapeHtml(hint)}</span>
          </summary>
          <div class="quota-bucket-body">
            <div class="quota-bucket-stats">${escapeHtml(statsLine)}</div>
            ${bar}
          </div>
        </details>
      `;
    }

    const pctEl = pct != null
      ? `<span class="quota-bucket-pct ${fillClass}">${pct}%</span>`
      : '';
    return `
      <div class="quota-bucket">
        <div class="quota-bucket-header">
          <div class="quota-bucket-title">${escapeHtml(b.label)}</div>
          ${pctEl}
        </div>
        ${bar}
        <div class="quota-bucket-stats">${escapeHtml(statsLine)}</div>
      </div>
    `;
  }

  function renderBuckets(buckets: QuotaBucket[]): string {
    if (buckets.length === 0) {
      return '<p class="empty small">No usage buckets yet.</p>';
    }
    // First bucket = primary, rest = collapsible.
    return buckets
      .map((b, i) => renderBucket(b, { collapsible: i > 0 }))
      .join('');
  }

  function renderConnectorBlock(def: ConnectorMetadata, snap: QuotaSnapshot | undefined): string {
    if (!snap) {
      return `
        <section class="quota-block">
          <div class="quota-block-header">
            <div class="block-name">${escapeHtml(def.name)}</div>
            <div class="block-vendor">${escapeHtml(def.vendor)}</div>
          </div>
          <p class="empty small">Not loaded yet.</p>
        </section>
      `;
    }
    if (!snap.ok) {
      return `
        <section class="quota-block">
          <div class="quota-block-header">
            <div class="block-name">${escapeHtml(def.name)}</div>
            <div class="block-vendor">${escapeHtml(def.vendor)}</div>
          </div>
          <div class="quota-error">${escapeHtml(snap.error)}</div>
          <p class="quota-footnote">Last attempt: ${formatDateTime(snap.fetchedAt)}</p>
        </section>
      `;
    }
    return `
      <section class="quota-block">
        <div class="quota-block-header">
          <div class="block-name">${escapeHtml(def.name)}</div>
          <div class="block-vendor">${snap.membershipType ? escapeHtml(snap.membershipType) : escapeHtml(def.vendor)}</div>
        </div>
        ${renderBuckets(snap.buckets)}
      </section>
    `;
  }

  function render(quotas: Record<string, QuotaSnapshot>): void {
    const panel = $('#content');
    if (connectors.length === 0) {
      panel.innerHTML = '<p class="empty">No integrations configured.</p>';
      return;
    }
    const blocks: string[] = [];
    let any = false;
    for (const def of connectors) {
      if (!def.hasQuota) continue;
      const snap = quotas[def.id];
      if (!snap) continue; // not enabled
      any = true;
      blocks.push(renderConnectorBlock(def, snap));
    }
    if (!any) {
      panel.innerHTML =
        '<p class="empty">No quota integrations enabled. Open settings to add one.</p>';
      return;
    }
    panel.innerHTML = blocks.join('');
  }

  function reportSize(): void {
    const height = Math.ceil(document.body.getBoundingClientRect().height);
    if (height > 0) window.awPopup.resize(height);
  }

  async function bootstrap(): Promise<void> {
    connectors = (await window.awPopup.getConnectors()) as ConnectorMetadata[];
    const quotas = (await window.awPopup.getQuotas()) as Record<string, QuotaSnapshot>;
    render(quotas);
    requestAnimationFrame(() => requestAnimationFrame(reportSize));
  }

  window.awPopup.onVisibilityChange(visible => {
    if (visible) startAutoRefresh();
    else stopAutoRefresh();
  });

  void bootstrap();

  window.awPopup.onQuotas(q => {
    render(q);
    requestAnimationFrame(() => requestAnimationFrame(reportSize));
  });

  document.addEventListener(
    'toggle',
    e => {
      if ((e.target as HTMLElement).tagName === 'DETAILS') {
        requestAnimationFrame(() => requestAnimationFrame(reportSize));
      }
    },
    true,
  );

  $('#openSettings').addEventListener('click', () => {
    void window.awPopup.openSettings();
  });

  $('#refreshAll').addEventListener('click', async () => {
    const btn = $('#refreshAll') as HTMLButtonElement;
    btn.disabled = true;
    try {
      const next = (await window.awPopup.refresh()) as Record<string, QuotaSnapshot>;
      render(next);
      requestAnimationFrame(() => requestAnimationFrame(reportSize));
      if (autoRefreshTimer) startAutoRefresh();
    } finally {
      btn.disabled = false;
    }
  });
})();
