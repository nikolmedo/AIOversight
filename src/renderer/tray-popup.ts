(function () {
  function $(sel: string): HTMLElement {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`Missing element: ${sel}`);
    return el as HTMLElement;
  }

  // escapeHtml / formatQuotaNumber / formatDateTime moved to the shared
  // quota-math.ts / quota-view.ts (global scripts loaded before this file).

  let connectors: ConnectorMetadata[] = [];
  let bucketPrefs: Record<string, Record<string, BucketPref>> = {};
  let lastQuotas: Record<string, QuotaSnapshot> = {};
  let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let countdownTimer: ReturnType<typeof setInterval> | null = null;
  let resetChipTimer: ReturnType<typeof setInterval> | null = null;
  let nextRefreshAt = 0;

  const AUTO_REFRESH_MS = 30_000;
  const RESET_CHIP_REFRESH_MS = 30_000;

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
    // The popup window is hidden, not destroyed, between shows — this timer
    // (like the two above) must stop while hidden or it leaks indefinitely.
    resetChipTimer = setInterval(() => refreshResetChips(document), RESET_CHIP_REFRESH_MS);
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
    if (resetChipTimer)   { clearInterval(resetChipTimer);   resetChipTimer   = null; }
    const el = document.getElementById('refreshTimer');
    if (el) el.textContent = '';
  }

  // renderBucket / renderBuckets / renderConnectorBlock moved to the shared
  // quota-view.ts as `renderProviderBlock` (used below); it threads
  // `connectorId` through automatically so the row context menu below can
  // identify which connector a right-clicked row belongs to.

  /**
   * Applies theme/density/time-format/transparency prefs to this document.
   * There's no push channel for these — the popup is re-shown constantly
   * (`onVisibilityChange`), so re-fetching on every show is simpler than
   * adding one, and keeps this in sync with changes made in the settings
   * window while the popup was hidden.
   */
  let showSpendCard = true;

  async function applyUiPrefs(): Promise<void> {
    const prefs = await window.awPopup.getUiPrefs();
    setTimeFormatPref(prefs.timeFormat);
    document.body.classList.toggle('density-compact', prefs.density === 'compact');
    document.body.classList.toggle('popup-transparent', prefs.transparentPopup);
    // Coerce: only an explicit `false` hides the card (a bridge that omits
    // the field — e.g. an older main process — must not blank it out).
    const nextShowSpendCard = prefs.showSpendCard !== false;
    if (showSpendCard !== nextShowSpendCard) {
      showSpendCard = nextShowSpendCard;
      // Prefs are re-fetched on every popup show — apply a toggle flipped in
      // the settings window while this popup was hidden.
      renderTotalSpendCardPanel();
      requestAnimationFrame(() => requestAnimationFrame(reportSize));
    }
  }

  function renderTotalSpendCardPanel(): void {
    const el = document.getElementById('totalSpendCard');
    if (!el) return;
    // `#totalSpendCard:empty { display: none }` collapses the hidden card.
    el.innerHTML = showSpendCard ? renderTotalSpendCard(lastQuotas, connectors) : '';
  }

  function render(quotas: Record<string, QuotaSnapshot>): void {
    lastQuotas = quotas;
    renderTotalSpendCardPanel();
    const panel = $('#content');
    const plan = planTrayPopup(connectors, quotas);
    if (plan.emptyMessage != null) {
      panel.innerHTML = `<p class="empty">${escapeHtml(plan.emptyMessage)}</p>`;
      return;
    }
    panel.innerHTML = plan.visible.map(def => renderProviderBlock(def, quotas[def.id], bucketPrefs[def.id])).join('');
  }

  function reportSize(): void {
    // The body is height-locked to the viewport (`height: 100vh` in
    // tray-popup.css) so `main` can be a real scroll container — which
    // also means the body's own rect can never express how tall the
    // content WANTS to be. Measure the fixed chrome (header + spend card
    // + footer + borders) as body-minus-main, then add main's full
    // scrollHeight. Main clamps the result to POPUP_MAX_HEIGHT; anything
    // beyond the clamp scrolls inside `main`.
    const scroller = document.getElementById('scroller');
    if (!scroller) return;
    const chrome = document.body.getBoundingClientRect().height - scroller.clientHeight;
    const desired = Math.ceil(chrome + scroller.scrollHeight);
    if (desired > 0) window.awPopup.resize(desired);
  }

  function bucketPrefFor(connectorId: string, bucketId: string): BucketPref | undefined {
    return bucketPrefs[connectorId]?.[bucketId];
  }

  const trayRowMenuHandlers: RowMenuHandlers = {
    isHidden: t => !!bucketPrefFor(t.connectorId, t.bucketId)?.hidden,
    isStarred: t => !!bucketPrefFor(t.connectorId, t.bucketId)?.starred,
    canStar: t => {
      if (bucketPrefFor(t.connectorId, t.bucketId)?.starred) return true;
      const perConnector = bucketPrefs[t.connectorId] ?? {};
      const starredCount = Object.values(perConnector).filter(p => p.starred).length;
      return starredCount < MAX_STARRED_PER_CONNECTOR;
    },
    toggleHidden: t => {
      const hidden = !bucketPrefFor(t.connectorId, t.bucketId)?.hidden;
      void applyRowMenuBucketPref(t.connectorId, t.bucketId, { hidden });
    },
    toggleStarred: t => {
      const starred = !bucketPrefFor(t.connectorId, t.bucketId)?.starred;
      void applyRowMenuBucketPref(t.connectorId, t.bucketId, { starred });
    },
    refreshConnector: t => {
      void (async () => {
        // main resolves a single-id refresh to `{ [id]: snapshot }`, not the
        // full map — merge onto `lastQuotas` so other connectors' rows don't
        // momentarily disappear.
        const partial = (await window.awPopup.refresh(t.connectorId)) as Record<string, QuotaSnapshot>;
        render({ ...lastQuotas, ...partial });
        requestAnimationFrame(() => requestAnimationFrame(reportSize));
      })();
    },
    // The popup has no Customize tab of its own — open the settings window
    // instead, per the plan's Phase 2c decision.
    openCustomize: () => {
      void window.awPopup.openSettings();
    },
  };

  /** Writes a bucket pref via the popup's own IPC channel, then refreshes the
   * local `bucketPrefs` copy from the (authoritative) response — it's only
   * fetched once at bootstrap otherwise, so a rejected star (past the cap)
   * would silently look accepted until the next full reload. */
  async function applyRowMenuBucketPref(
    connectorId: string,
    bucketId: string,
    patch: Partial<BucketPref>,
  ): Promise<void> {
    bucketPrefs = await window.awPopup.setBucketPref(connectorId, bucketId, patch);
    render(lastQuotas);
    requestAnimationFrame(() => requestAnimationFrame(reportSize));
  }

  /**
   * Re-fetches `connectors` and re-renders with it. `ConnectorMetadata.quotaEnabled`
   * (WARNING FIX: planTrayPopup's source of truth for "should this connector
   * show here") is a snapshot of settings taken at fetch time -- unlike
   * `quotas`, which main pushes on every show/update, `connectors` was
   * previously fetched exactly once in `bootstrap()`. Since the popup window
   * is hidden, not destroyed, between shows (see `applyUiPrefs`'s own
   * comment), that left `quotaEnabled` frozen at whatever it was when the
   * popup first opened: a connector disabled while the popup sat hidden
   * would keep rendering as "Not loaded yet." forever, and one enabled while
   * hidden wouldn't appear even after its snapshot arrived. Called on every
   * show, same rationale as `applyUiPrefs` re-fetching prefs on every show.
   */
  async function refreshConnectors(): Promise<void> {
    connectors = (await window.awPopup.getConnectors()) as ConnectorMetadata[];
    render(lastQuotas);
    requestAnimationFrame(() => requestAnimationFrame(reportSize));
  }

  let lastUpdateBannerHtml = '';

  function renderUpdate(state: UpdateState): void {
    const slot = document.getElementById('updateBanner');
    if (!slot) return;
    const html = renderUpdateBanner(state, true);
    // Progress pushes arrive often while downloading; skip no-op re-renders.
    if (html === lastUpdateBannerHtml) return;
    lastUpdateBannerHtml = html;
    slot.innerHTML = html;
    requestAnimationFrame(() => requestAnimationFrame(reportSize));
  }

  bindUpdateBanner($('#updateBanner'), {
    download: () => void window.awPopup.downloadUpdate().then(renderUpdate),
    install: () => void window.awPopup.installUpdate(),
    'open-release': () => void window.awPopup.openRelease(),
    dismiss: () => void window.awPopup.dismissUpdate().then(renderUpdate),
  });
  window.awPopup.onUpdateState(renderUpdate);

  async function bootstrap(): Promise<void> {
    connectors = (await window.awPopup.getConnectors()) as ConnectorMetadata[];
    bucketPrefs = (await window.awPopup.getBucketPrefs()) as Record<string, Record<string, BucketPref>>;
    await applyUiPrefs();
    renderUpdate(await window.awPopup.getUpdateState());
    const quotas = (await window.awPopup.getQuotas()) as Record<string, QuotaSnapshot>;
    render(quotas);
    requestAnimationFrame(() => requestAnimationFrame(reportSize));
  }

  window.awPopup.onVisibilityChange(visible => {
    if (visible) {
      startAutoRefresh();
      void applyUiPrefs();
      void refreshConnectors();
    } else {
      stopAutoRefresh();
    }
  });

  // bindResetChips/bindRowMenu are one-time delegated listeners (not timers)
  // — safe to leave running while hidden. The countdown-refresh timer itself
  // lives inside startAutoRefresh/stopAutoRefresh above, in lockstep with
  // onVisibilityChange, same as the other two popup timers.
  document.body.insertAdjacentHTML('beforeend', renderRowMenu());
  bindResetChips(document);
  bindRowMenu(document, trayRowMenuHandlers);
  bindTotalSpendCard(document, () => {
    renderTotalSpendCardPanel();
    requestAnimationFrame(() => requestAnimationFrame(reportSize));
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

  $('#openSettingsHeader').addEventListener('click', () => {
    void window.awPopup.openSettings();
  });

  // Error sections render an "Open settings" link (renderProviderBlock);
  // delegated because the content is replaced on every render.
  $('#content').addEventListener('click', e => {
    if ((e.target as HTMLElement).closest('[data-role="open-settings"]')) {
      void window.awPopup.openSettings();
    }
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
