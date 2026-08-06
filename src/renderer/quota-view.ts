// Shared quota HTML rendering. Non-module global script (see quota-math.ts's
// header comment) — loaded via <script> right after quota-math.js and before
// settings.js / tray-popup.js.
//
// Phase 2a scope: `renderMeterRow` is now the single shared meter-row
// renderer for both settings.ts and tray-popup.ts — label / value / percent /
// pace-colored bar / even-pace tick / reset countdown chip / on-demand
// grouping.
//
// Phase 2b scope: `renderTotalSpendCard` is the shared Total Spend card —
// cross-connector cost/token aggregation + a hand-rolled inline-SVG donut
// breakdown. No connector emits `QuotaSnapshot.spend` yet (that's Phase 4
// wiring), so today this always renders as an empty string; the card only
// becomes visible once a connector starts populating `spend[]`. Kept fully
// functional against the shape now so no renderer changes are needed later.
// `renderRowMenu` remains a minimal placeholder — nothing wires a row
// context menu until Phase 2c.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** `'12h'` unless the runtime's locale default resolves to 24-hour time. */
function inferHourFormat(): '12h' | '24h' {
  try {
    return Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12 === false
      ? '24h'
      : '12h';
  } catch {
    return '12h';
  }
}

/** `AppSettings.timeFormat` — set by both renderers at startup (and on
 * change) via `setTimeFormatPref`. Defaults to `'auto'` so a page that never
 * calls the setter (e.g. a `vm` sandbox in smoke.js) keeps today's behavior. */
let timeFormatPref: 'auto' | '12h' | '24h' = 'auto';

/** Called by settings.ts / tray-popup.ts whenever `AppSettings.timeFormat`
 * loads or changes, so `renderResetChip`'s exact-time mode respects it. */
function setTimeFormatPref(fmt: 'auto' | '12h' | '24h'): void {
  timeFormatPref = fmt;
}

function resolvedHourFormat(): '12h' | '24h' {
  return timeFormatPref === 'auto' ? inferHourFormat() : timeFormatPref;
}

function resetChipLabel(resetsAt: number, mode: 'countdown' | 'exact', now: number): string {
  return mode === 'exact'
    ? formatExactReset(resetsAt, resolvedHourFormat())
    : formatCountdown(resetsAt - now);
}

/**
 * Persists whichever mode (countdown/exact) the user last toggled a reset
 * chip to, keyed by `resetsAt`. Rows fully re-render on every quota poll
 * (`onQuotaUpdate`/`onQuotas`) and on both the popup's network-refetch timer
 * and the countdown-only refresh timer — without this, any of those would
 * silently revert an explicit toggle back to `countdown`.
 *
 * Known/deferred limitation: keyed by raw `resetsAt`, not a connector+bucket
 * composite, so two buckets sharing the exact same reset timestamp would
 * cross-contaminate toggle state, and entries are never evicted. No
 * connector sets `resetsAt` yet, so this is currently dormant with zero
 * production impact — not worth a bucket-id-carrying key until it matters.
 */
const resetChipModes = new Map<number, 'countdown' | 'exact'>();

function renderResetChip(resetsAt: number, now: number): string {
  const mode = resetChipModes.get(resetsAt) ?? 'countdown';
  return `<button type="button" class="reset-chip" data-resets-at="${resetsAt}" data-mode="${mode}">${escapeHtml(resetChipLabel(resetsAt, mode, now))}</button>`;
}

/**
 * Wires click-to-toggle (countdown <-> exact) for every `.reset-chip` under
 * `root`, via one delegated listener. Call once per document — the listener
 * survives `innerHTML` re-renders because it's delegated, not per-element.
 */
function bindResetChips(root: Document): void {
  root.addEventListener('click', e => {
    const btn = (e.target as HTMLElement).closest('.reset-chip') as HTMLButtonElement | null;
    if (!btn) return;
    const nextMode: 'countdown' | 'exact' = btn.dataset.mode === 'exact' ? 'countdown' : 'exact';
    btn.dataset.mode = nextMode;
    const resetsAt = Number(btn.dataset.resetsAt);
    if (Number.isNaN(resetsAt)) return;
    resetChipModes.set(resetsAt, nextMode);
    btn.textContent = resetChipLabel(resetsAt, nextMode, Date.now());
  });
}

/**
 * Re-renders every visible `.reset-chip` label in place, respecting whichever
 * mode (countdown/exact) each chip is currently showing. Intended to be
 * called from a lightweight `setInterval(..., 30_000)` — no network call, no
 * DOM replacement, so it never disturbs a user's toggled chip state.
 */
function refreshResetChips(root: Document): void {
  const now = Date.now();
  const chips = root.querySelectorAll<HTMLButtonElement>('.reset-chip');
  chips.forEach(chip => {
    const resetsAt = Number(chip.dataset.resetsAt);
    if (Number.isNaN(resetsAt)) return;
    const mode: 'countdown' | 'exact' = chip.dataset.mode === 'exact' ? 'exact' : 'countdown';
    chip.textContent = resetChipLabel(resetsAt, mode, now);
  });
}

/** Cap enforced authoritatively in `settings-store.ts`'s `setBucketPref` —
 * duplicated here (not imported; renderer scripts can't import from main) so
 * the row menu / Customize tab can optimistically disable the star control
 * without round-tripping through IPC first. Keep in sync with
 * `MAX_STARRED_PER_CONNECTOR` in `src/main/connectors/types.ts`. */
const MAX_STARRED_PER_CONNECTOR = 2;

interface MeterRowOptions {
  /** Word used after the remaining amount ("remaining" vs "left"). */
  remainingWord?: string;
  /** Injectable for tests; defaults to Date.now(). */
  now?: number;
  /**
   * Connector id this row belongs to. When set, the row carries a
   * `data-connector-id` attribute so the shared row context menu
   * (`bindRowMenu`) can identify which connector+bucket was right-clicked.
   * Threaded through automatically by `renderMeterGroup` when its own
   * caller passes it in `options`.
   */
  connectorId?: string;
  /**
   * Render as an individually-collapsible `<details>` row: label + a
   * one-line hint (percent, or the primary value when there's no percent)
   * stay visible in the `<summary>` even while collapsed. Used for on-demand
   * buckets (`renderMeterGroup`) so a user can see e.g. "Input tokens: 1.2M"
   * at a glance without expanding anything, instead of hiding it behind a
   * second group-level toggle.
   */
  compact?: boolean;
}

/**
 * One usage-bucket row. Single shared implementation used by both
 * settings.ts and tray-popup.ts (replaces settings.ts's old
 * `renderQuotaBucket` and tray-popup.ts's old `renderBucket`).
 *
 * `pref` is the bucket's persisted display prefs (star/hide/order), passed
 * through mainly so callers upstream (`renderMeterGroup`) can group by
 * effective visibility; the star state is surfaced here only as a
 * `data-starred` attribute — no visual star UI yet (that's Phase 2c).
 */
function renderMeterRow(b: QuotaBucket, pref: BucketPref | undefined, options?: MeterRowOptions): string {
  const now = options?.now ?? Date.now();
  const remainingWord = options?.remainingWord ?? 'remaining';

  const pctRaw = percentFor(b);
  const pct = pctRaw == null ? null : Math.round(pctRaw);
  const paceState = paceStateFor(b, now);
  const paceClass = paceState === 'critical' ? 'critical' : paceState === 'warn' ? 'warn' : '';

  // claude-code's percent-with-limit-100 buckets suppress the "/ 100%"
  // denominator — showing a bare "45%" instead of "45% / 100% percent".
  const suppressDenominator = b.unit === 'percent' && b.limit === 100;
  const stats = suppressDenominator
    ? formatQuotaValue(b.used, b.unit)
    : b.limit != null
      ? `${formatQuotaValue(b.used, b.unit)} / ${formatQuotaValue(b.limit, b.unit)} ${b.unit}`
      : `${formatQuotaValue(b.used, b.unit)} ${b.unit} used`;
  const remainingOnly = b.remaining != null ? `${formatQuotaValue(b.remaining, b.unit)} ${remainingWord}` : '';
  const remaining = b.remaining != null ? ` · ${remainingOnly}` : '';
  // A bucket can report ONLY a remaining figure with no `used` (e.g. Cursor's
  // `credits-grant`/`credits-prepaid` buckets, Devin's `extra-balance` bucket:
  // `{used: null, remaining: <cents>}`) -- that's real, displayable data, not
  // "no data". Only fall through to "No data" when BOTH fields are null.
  const hasNoData = b.used == null && b.remaining == null;
  const statsLine = hasNoData ? 'No data' : b.used == null ? remainingOnly : stats + remaining;

  const tickPctRaw = pct != null ? evenPaceTickPercent(b, now) : null;
  // Clamp below 100 so the 2px tick can't poke past the bar's right edge
  // (e.g. when the reset time has passed but the bucket hasn't re-polled yet).
  const tickPct = tickPctRaw != null ? Math.min(99, Math.round(tickPctRaw)) : null;
  const tick = tickPct != null ? `<div class="pace-tick" style="--tick:${tickPct}%"></div>` : '';
  const bar =
    pct != null
      ? `<div class="meter-bar"><div class="meter-bar-fill ${paceClass}" style="--fill:${pct}%"></div>${tick}</div>`
      : '';

  const pctEl = pct != null ? `<span class="meter-pct ${paceClass}">${pct}%</span>` : '';
  const resetChip = b.resetsAt != null ? renderResetChip(b.resetsAt, now) : '';
  const noteEl = b.note ? `<div class="meter-note">${escapeHtml(b.note)}</div>` : '';

  // For plain percent buckets (used% / limit 100) the stats line is fully
  // derivable from the header's percent ("30%" up top vs "30% · 70% left"
  // below — zero new information). Drop the line and move the reset chip up
  // into the header instead: one less line per row, openusage-style. Buckets
  // with real absolute figures (e.g. "327 / 20,000 requests · 19,673 left")
  // keep the stats line — the bar/percent can't express those.
  const statsRedundant = !hasNoData && suppressDenominator;
  const statsEl = statsRedundant
    ? ''
    : `<div class="meter-row-stats">
        <span class="meter-row-value">${escapeHtml(statsLine)}</span>
        ${resetChip}
      </div>`;
  const headerSide = `<div class="meter-row-side">${statsRedundant ? resetChip : ''}${pctEl}</div>`;

  const rowClasses = ['meter-row', hasNoData ? 'no-data' : ''].filter(Boolean).join(' ');
  const starredAttr = pref?.starred ? ' data-starred="true"' : '';
  const connectorAttr = options?.connectorId ? ` data-connector-id="${escapeHtml(options.connectorId)}"` : '';

  const bodyHtml = `
      <div class="meter-row-header">
        <div class="meter-row-title">${escapeHtml(b.label)}</div>
        ${headerSide}
      </div>
      ${bar}
      ${statsEl}
      ${noteEl}
  `;

  if (options?.compact) {
    const hint = pct != null ? `${pct}%` : hasNoData ? 'No data' : b.used == null ? remainingOnly : stats;
    return `
      <details class="${rowClasses} meter-row-compact" data-bucket-id="${escapeHtml(b.id)}"${starredAttr}${connectorAttr}>
        <summary>
          <span class="meter-row-title">${escapeHtml(b.label)}</span>
          <span class="meter-pct ${paceClass}">${escapeHtml(hint)}</span>
        </summary>
        <div class="meter-row-compact-body">${bodyHtml}</div>
      </details>
    `;
  }

  return `
    <div class="${rowClasses}" data-bucket-id="${escapeHtml(b.id)}"${starredAttr}${connectorAttr}>${bodyHtml}</div>
  `;
}

/**
 * Groups+sorts a connector's buckets and renders them: buckets whose
 * effective visibility is hidden (`pref.hidden`) are dropped entirely;
 * buckets whose effective visibility is on-demand render as individually-
 * collapsible compact rows inside a `.meter-extras` section instead of the
 * main row set.
 *
 * `hasLimit` (`limit != null && limit > 0`) is the ONE predicate for "does
 * this bucket have a determinable limit" — used both for the
 * `defaultVisibility` fallback below and for the measurable/no-percent sort
 * split, so the two checks can't disagree (a `limit: 0` bucket, e.g.
 * github-copilot's `entitlement: 0` shape, is unmeasurable exactly like
 * `limit: null`, not "always" visible with a bar-less row).
 *
 * Effective visibility is `defaultVisibility ?? (hasLimit ? 'always' :
 * 'onDemand')` — a bucket with no determinable limit collapses by default
 * unless a connector explicitly opts it into `'always'`. This restores the
 * pre-2a behavior (the old `.quota-bucket-collapsible` path collapsed any
 * bucket without a positive limit) for every currently-shipping connector:
 * no connector sets `defaultVisibility` yet (Phase 3+ work), so without this
 * fallback every `limit: null`/`limit: 0` bucket — Anthropic's spend/per-model
 * buckets, OpenAI's admin buckets, Copilot's unlimited/zero-entitlement
 * buckets — would render fully expanded in the main row set. The tray popup
 * window is non-resizable, height-clamped, and has no scroll container
 * anywhere, so content past that clamp isn't scrollable — it's silently
 * clipped and permanently unreachable.
 *
 * The on-demand section is NOT a single collapsed group with only a count
 * visible (that would hide real data — e.g. Anthropic-admin/OpenAI-admin,
 * where every bucket is on-demand — behind a click with zero information
 * showing). Each on-demand bucket renders `compact: true` instead: its own
 * `<details>` with label + hint always visible in the `<summary>`, full
 * stats/bar one click away. `.meter-extras` is a plain (non-collapsing)
 * section wrapper, purely for visual grouping/spacing.
 */
function renderMeterGroup(
  buckets: QuotaBucket[],
  bucketPrefs: Record<string, BucketPref> | undefined,
  options?: MeterRowOptions,
): string {
  const hasLimit = (b: QuotaBucket): boolean => b.limit != null && b.limit > 0;

  const main: QuotaBucket[] = [];
  const onDemand: QuotaBucket[] = [];
  for (const b of buckets) {
    const pref = bucketPrefs?.[b.id];
    if (pref?.hidden) continue;
    // Customize tab override (Phase 2c) takes precedence; unset falls back to
    // the connector's own default, unchanged from Phase 2a.
    const effectiveVisibility = pref?.visibility ?? b.defaultVisibility ?? (hasLimit(b) ? 'always' : 'onDemand');
    if (effectiveVisibility === 'onDemand') onDemand.push(b);
    else main.push(b);
  }

  // Shared with the Customize tab's pre-move baseline — see
  // `sortBucketsByDisplayOrder`'s header comment in quota-math.ts for why
  // this must not be a locally-reimplemented sort here.
  const renderList = (list: QuotaBucket[], rowOptions?: MeterRowOptions): string =>
    sortBucketsByDisplayOrder(list, bucketPrefs)
      .map(b => renderMeterRow(b, bucketPrefs?.[b.id], rowOptions))
      .join('');

  const mainHtml = renderList(main, options);
  const extrasHtml = onDemand.length
    ? `<div class="meter-extras">
        <div class="meter-extras-heading">More metrics</div>
        <div class="meter-extras-body">${renderList(onDemand, { ...options, compact: true })}</div>
      </div>`
    : '';

  return mainHtml + extrasHtml;
}

// ---------------------------------------------------------------------------
// Total Spend card (Phase 2b)
// ---------------------------------------------------------------------------

type SpendCardMode = 'cost' | 'costPerMtok' | 'tokens';

interface SpendCardState {
  mode: SpendCardMode;
  period: SpendPeriod;
}

/** Local, in-memory UI state only — not persisted. Each renderer window
 * (settings / tray popup) gets its own copy since they're separate JS
 * realms, same as `resetChipModes` above. */
const spendCardState: SpendCardState = { mode: 'cost', period: 'today' };

/**
 * Wires click-to-switch (mode / period) for every `.spend-switch` button,
 * via one delegated listener — same pattern as `bindResetChips`, so it
 * survives `innerHTML` re-renders. Call once per document; pass the
 * re-render callback the caller wants invoked after each switcher click
 * (typically re-rendering just the card's container). `rerender` is captured
 * by the listener's closure — calling this twice would attach two listeners
 * each firing their own callback, so callers wire it exactly once at init,
 * same as `bindResetChips`.
 */
function bindTotalSpendCard(root: Document, rerender: () => void): void {
  root.addEventListener('click', e => {
    const btn = (e.target as HTMLElement).closest('.spend-switch') as HTMLButtonElement | null;
    if (!btn) return;
    if (btn.dataset.spendMode) spendCardState.mode = btn.dataset.spendMode as SpendCardMode;
    if (btn.dataset.spendPeriod) spendCardState.period = btn.dataset.spendPeriod as SpendPeriod;
    rerender();
  });
}

/** True when at least one connector's latest snapshot has a non-empty `spend[]`. */
function hasAnySpendData(snapshots: Record<string, QuotaSnapshot>): boolean {
  return Object.values(snapshots).some(s => s.ok && Array.isArray(s.spend) && s.spend.length > 0);
}

interface SpendAggregateEntry {
  id: string;
  name: string;
  /** `null` = no connector reported a measured value for this period (excluded from sums). */
  costCents: number | null;
  tokens: number | null;
}

interface SpendAggregate {
  /** `null` = zero connectors had a measured cost for this period (not the same as a measured $0). */
  totalCostCents: number | null;
  totalTokens: number | null;
  byConnector: SpendAggregateEntry[];
}

/**
 * Pure renderer-side aggregation over the snapshots both settings.ts and
 * tray-popup.ts already hold in memory — no new IPC. A tile with
 * `costCents: null` (or `tokens: null`) for the selected period is excluded
 * from that metric's sum and from that connector's entry for that metric —
 * never coerced to `0` (Phase 1's null-vs-zero convention).
 */
function aggregateSpendForPeriod(
  snapshots: Record<string, QuotaSnapshot>,
  connectors: ConnectorMetadata[],
  period: SpendPeriod,
): SpendAggregate {
  const byConnector: SpendAggregateEntry[] = [];
  let totalCostCents: number | null = null;
  let totalTokens: number | null = null;

  for (const def of connectors) {
    const snap = snapshots[def.id];
    if (!snap || !snap.ok || !snap.spend) continue;
    const tile = snap.spend.find(t => t.period === period);
    if (!tile) continue;

    const { costCents, tokens } = tile;
    if (costCents != null) totalCostCents = (totalCostCents ?? 0) + costCents;
    if (tokens != null) totalTokens = (totalTokens ?? 0) + tokens;
    if (costCents != null || tokens != null) {
      byConnector.push({ id: def.id, name: def.name, costCents, tokens });
    }
  }

  return { totalCostCents, totalTokens, byConnector };
}

/** Stable 0-360 hue derived from an id string, so the same connector always
 * gets the same color across renders/sessions without a lookup table. */
function hashHue(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return hash % 360;
}

/** Matches a well-formed CSS hex color (#rgb / #rgba / #rrggbb / #rrggbbaa).
 * `brandColor` reaches HTML attribute sinks unescaped (SVG `stroke`, a CSS
 * custom-property `style` value) — validate at the source instead of
 * escaping at each call site, so a malformed value falls back cleanly to
 * the hash-derived color rather than rendering broken markup. No shipping
 * connector sets `brandColor` today, but Phase 5 connectors will. */
const HEX_COLOR_RE = /^#[0-9a-f]{3,8}$/i;

/** `Connector.brandColor` when it's a well-formed hex color, else a
 * deterministic id-hash color. */
function connectorColor(id: string, brandColor?: string): string {
  if (brandColor && HEX_COLOR_RE.test(brandColor)) return brandColor;
  return `hsl(${hashHue(id)}, 62%, 55%)`;
}

interface DonutSlice {
  id: string;
  /** Raw non-negative magnitude (cost cents or tokens) — not yet a fraction. */
  value: number;
}

interface DonutArc {
  id: string;
  /** 0..1, sums to 1 across the full slice set. */
  fraction: number;
}

/** Minimum visible arc length as a fraction of the full circle (~1.5%), so a
 * tiny-share connector doesn't disappear entirely from the donut. */
const MIN_DONUT_ARC_FRACTION = 0.015;

/**
 * Converts raw non-negative values into donut-ready fractions summing to 1.
 * Any slice whose natural share would fall under `MIN_DONUT_ARC_FRACTION` is
 * boosted up to that floor, then the whole set is renormalized so it still
 * sums to 1 (the floor is "borrowed" proportionally from every slice, not
 * just the larger ones, since renormalization divides through uniformly).
 *
 * Callers (`renderTotalSpendCard`) pre-filter to `value > 0` slices before
 * calling this, so the `f > 0` check below never needs to boost an
 * exact-zero fraction in practice — kept as a guard anyway since this
 * function doesn't otherwise enforce that precondition.
 */
function computeDonutArcs(slices: DonutSlice[], minFraction: number = MIN_DONUT_ARC_FRACTION): DonutArc[] {
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  if (total <= 0 || !Number.isFinite(total) || slices.length === 0) {
    return slices.map(s => ({ id: s.id, fraction: 0 }));
  }

  const rawFractions = slices.map(s => s.value / total);
  const boosted = rawFractions.map(f => (f > 0 && f < minFraction ? minFraction : f));
  const boostedTotal = boosted.reduce((a, b) => a + b, 0);
  return slices.map((s, i) => ({ id: s.id, fraction: boosted[i] / boostedTotal }));
}

/** Hand-written inline SVG donut — `<circle>` arcs via stroke-dasharray /
 * stroke-dashoffset. No `<canvas>`, no charting dependency. */
function renderDonutSvg(slices: DonutSlice[], colorFor: (id: string) => string): string {
  const size = 72;
  const strokeWidth = 10;
  const r = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * r;
  const cx = size / 2;
  const cy = size / 2;

  const arcs = computeDonutArcs(slices);
  let offset = 0;
  const circles = arcs
    .map(a => {
      const len = a.fraction * circumference;
      const dasharray = `${len} ${Math.max(0, circumference - len)}`;
      const circle = `<circle data-spend-slice="${escapeHtml(a.id)}" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${colorFor(a.id)}" stroke-width="${strokeWidth}" stroke-dasharray="${dasharray}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})" />`;
      offset += len;
      return circle;
    })
    .join('');

  return `<svg class="spend-donut" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="Spend breakdown by provider">${circles}</svg>`;
}

function formatSpendHeadline(mode: SpendCardMode, totalCostCents: number | null, totalTokens: number | null): string {
  if (mode === 'tokens') {
    return totalTokens != null ? formatQuotaValue(totalTokens, 'tokens') : 'No data';
  }
  if (mode === 'costPerMtok') {
    if (totalCostCents == null || totalTokens == null || totalTokens <= 0) return 'No data';
    const costPerMtokCents = totalCostCents / (totalTokens / 1_000_000);
    return `$${(costPerMtokCents / 100).toFixed(2)} / MTok`;
  }
  return totalCostCents != null ? formatQuotaValue(totalCostCents, 'usd') : 'No data';
}

function renderSpendModeSwitcher(active: SpendCardMode): string {
  const opts: Array<{ value: SpendCardMode; label: string }> = [
    { value: 'cost', label: 'Cost' },
    { value: 'costPerMtok', label: 'Cost / MTok' },
    { value: 'tokens', label: 'Tokens' },
  ];
  return `<div class="spend-switch-group" role="tablist" aria-label="Spend metric">${opts
    .map(
      o =>
        `<button type="button" class="spend-switch${o.value === active ? ' active' : ''}" data-spend-mode="${o.value}" aria-pressed="${o.value === active}">${escapeHtml(o.label)}</button>`,
    )
    .join('')}</div>`;
}

function renderSpendPeriodSwitcher(active: SpendPeriod): string {
  const opts: Array<{ value: SpendPeriod; label: string }> = [
    { value: 'today', label: 'Today' },
    { value: 'yesterday', label: 'Yesterday' },
    { value: 'last30d', label: '30 Days' },
  ];
  return `<div class="spend-switch-group" role="tablist" aria-label="Spend period">${opts
    .map(
      o =>
        `<button type="button" class="spend-switch${o.value === active ? ' active' : ''}" data-spend-period="${o.value}" aria-pressed="${o.value === active}">${escapeHtml(o.label)}</button>`,
    )
    .join('')}</div>`;
}

/**
 * Total Spend card — cross-connector cost/token aggregation with a donut
 * breakdown, plus mode (Cost / Cost-per-MTok / Tokens) and period (Today /
 * Yesterday / 30 Days) switchers. Renders an empty string when no connector
 * has any `spend[]` data at all (true for every connector today, until
 * Phase 4 wires real spend data) — the card simply doesn't exist yet rather
 * than rendering an empty shell.
 */
function renderTotalSpendCard(
  snapshots: Record<string, QuotaSnapshot>,
  connectors: ConnectorMetadata[],
  state: SpendCardState = spendCardState,
): string {
  if (!hasAnySpendData(snapshots)) return '';

  const { totalCostCents, totalTokens, byConnector } = aggregateSpendForPeriod(
    snapshots,
    connectors,
    state.period,
  );

  const colorForId = (id: string): string => connectorColor(id, connectors.find(c => c.id === id)?.brandColor);

  // Cost-per-MTok is a rate, not an additive share — fall back to a cost-share
  // donut for that mode (same as 'cost'); 'tokens' mode shows a token-share donut.
  const donutMetric: 'costCents' | 'tokens' = state.mode === 'tokens' ? 'tokens' : 'costCents';
  // `> 0` excludes both null (unmeasured) and measured-zero entries — relied
  // on by computeDonutArcs's `f > 0` boost guard above, which assumes it's
  // never handed an exact-zero slice to boost. Keep both checks in sync.
  const slices: DonutSlice[] = byConnector
    .filter(e => e[donutMetric] != null && (e[donutMetric] as number) > 0)
    .map(e => ({ id: e.id, value: e[donutMetric] as number }));

  const donutHtml =
    slices.length > 0
      ? renderDonutSvg(slices, colorForId)
      : '<div class="spend-donut-empty">No data</div>';

  const headline = formatSpendHeadline(state.mode, totalCostCents, totalTokens);

  const legendUnit: QuotaUnit = donutMetric === 'tokens' ? 'tokens' : 'usd';
  const legendHtml = byConnector.length
    ? `<ul class="spend-legend">${byConnector
        .map(e => {
          const value = donutMetric === 'tokens' ? e.tokens : e.costCents;
          const display = value != null ? formatQuotaValue(value, legendUnit) : 'No data';
          return `
            <li class="spend-legend-row">
              <span class="spend-legend-dot" style="--dot-color:${colorForId(e.id)}"></span>
              <span class="spend-legend-name">${escapeHtml(e.name)}</span>
              <span class="spend-legend-value">${escapeHtml(display)}</span>
            </li>`;
        })
        .join('')}</ul>`
    : '<p class="empty small">No spend data for this period.</p>';

  return `
    <section class="spend-card" data-role="total-spend-card">
      <div class="spend-card-header">
        <div>
          <h3 class="spend-card-title">Total Spend</h3>
          <p class="spend-card-subtitle">Estimated at API rates — not your bill on a flat-rate plan</p>
        </div>
        ${renderSpendPeriodSwitcher(state.period)}
      </div>
      <div class="spend-card-body">
        <div class="spend-donut-wrap">${donutHtml}</div>
        <div class="spend-card-summary">
          <div class="spend-headline">${escapeHtml(headline)}</div>
          ${renderSpendModeSwitcher(state.mode)}
        </div>
      </div>
      ${legendHtml}
    </section>
  `;
}

/**
 * Per-provider quota block (name / vendor / buckets). Replaces tray-popup.ts's
 * old `renderConnectorBlock` + `renderBuckets` sort helper.
 */
function renderProviderBlock(
  def: ConnectorMetadata,
  snap: QuotaSnapshot | undefined,
  bucketPrefs?: Record<string, BucketPref>,
): string {
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

  const bucketsHtml =
    snap.buckets.length === 0
      ? '<p class="empty small">No usage buckets yet.</p>'
      : renderMeterGroup(snap.buckets, bucketPrefs, { remainingWord: 'left', connectorId: def.id }) ||
        '<p class="empty small">No usage buckets yet.</p>';

  return `
    <section class="quota-block">
      <div class="quota-block-header">
        <div class="block-name">${escapeHtml(def.name)}</div>
        <div class="block-vendor">${snap.membershipType ? escapeHtml(snap.membershipType) : escapeHtml(def.vendor)}</div>
      </div>
      ${bucketsHtml}
    </section>
  `;
}

// ---------------------------------------------------------------------------
// Row context menu (Phase 2c)
// ---------------------------------------------------------------------------

interface RowMenuTarget {
  connectorId: string;
  bucketId: string;
  bucketLabel: string;
}

interface RowMenuHandlers {
  isHidden(t: RowMenuTarget): boolean;
  isStarred(t: RowMenuTarget): boolean;
  /** Whether starring `t` is currently allowed (cap not yet reached for its connector). */
  canStar(t: RowMenuTarget): boolean;
  toggleHidden(t: RowMenuTarget): void;
  toggleStarred(t: RowMenuTarget): void;
  refreshConnector(t: RowMenuTarget): void;
  /**
   * Omit to hide the "Customize…" item entirely. settings.ts supplies this
   * (switches to the Customize tab in-place); tray-popup.ts supplies it as a
   * call to `window.awPopup.openSettings()` — the popup has no Customize tab
   * of its own to switch to.
   */
  openCustomize?(t: RowMenuTarget): void;
}

/**
 * Builds the (single, shared, initially-hidden) row-context-menu markup.
 * Callers append the result to `document.body` once at startup — an in-DOM
 * popup, not a native `Menu.popup()`, because the tray popup is a frameless
 * always-on-top window that hides itself on blur; a native menu would steal
 * focus and dismiss the very popup it belongs to (see the plan's Phase 2c
 * decision table).
 */
function renderRowMenu(): string {
  return `
    <div class="row-menu" id="rowMenu" hidden role="menu">
      <button type="button" class="row-menu-item" data-action="hide" role="menuitem"></button>
      <button type="button" class="row-menu-item" data-action="star" role="menuitem"></button>
      <button type="button" class="row-menu-item" data-action="refresh" role="menuitem">Refresh this provider</button>
      <button type="button" class="row-menu-item" data-action="customize" role="menuitem">Customize…</button>
    </div>
  `;
}

/**
 * Wires the shared row context menu built by `renderRowMenu()` — call once
 * per document, after that markup has been inserted into the DOM.
 * Right-clicking any element under a `[data-bucket-id]` row (rendered by
 * `renderMeterRow` when its caller passed `options.connectorId`) opens the
 * menu near the cursor; a plain click outside it, or Escape, dismisses it.
 *
 * Positioned via `position: fixed` and clamped against
 * `window.innerWidth`/`innerHeight` (the *window's* viewport, not page
 * scroll offsets) — the tray popup is a small, non-resizable,
 * `overflow: hidden` window with no scroll container anywhere, so an
 * absolutely-positioned menu that could render past its bottom/right edge
 * would be silently clipped and unreachable, the same failure mode
 * `renderMeterGroup`'s Phase 2a comment calls out for bucket rows.
 */
function bindRowMenu(root: Document, handlers: RowMenuHandlers): void {
  const menu = root.getElementById('rowMenu');
  if (!menu) return;
  let current: RowMenuTarget | null = null;

  const close = (): void => {
    menu.hidden = true;
    current = null;
  };

  const refreshLabels = (): void => {
    if (!current) return;
    const hideBtn = menu.querySelector('[data-action="hide"]') as HTMLButtonElement;
    hideBtn.textContent = handlers.isHidden(current) ? 'Unhide' : 'Hide';
    const starBtn = menu.querySelector('[data-action="star"]') as HTMLButtonElement;
    const starred = handlers.isStarred(current);
    starBtn.textContent = starred ? 'Unstar' : 'Star for menu bar';
    starBtn.disabled = !starred && !handlers.canStar(current);
    const customizeBtn = menu.querySelector('[data-action="customize"]') as HTMLButtonElement | null;
    if (customizeBtn) customizeBtn.hidden = !handlers.openCustomize;
  };

  root.addEventListener('contextmenu', e => {
    const row = (e.target as HTMLElement).closest('[data-bucket-id]') as HTMLElement | null;
    if (!row) return;
    e.preventDefault();
    const connectorId = row.dataset.connectorId;
    const bucketId = row.dataset.bucketId;
    if (!connectorId || !bucketId) return;
    const titleEl = row.querySelector('.meter-row-title');
    current = { connectorId, bucketId, bucketLabel: titleEl?.textContent ?? bucketId };
    refreshLabels();

    menu.hidden = false;
    const me = e as MouseEvent;
    const win = row.ownerDocument.defaultView;
    const viewportW = win?.innerWidth ?? me.clientX;
    const viewportH = win?.innerHeight ?? me.clientY;
    const menuRect = (menu as HTMLElement).getBoundingClientRect();
    let x = me.clientX;
    let y = me.clientY;
    if (x + menuRect.width > viewportW) x = Math.max(0, viewportW - menuRect.width - 4);
    if (y + menuRect.height > viewportH) y = Math.max(0, y - menuRect.height);
    (menu as HTMLElement).style.left = `${x}px`;
    (menu as HTMLElement).style.top = `${y}px`;
  });

  menu.addEventListener('click', e => {
    const btn = (e.target as HTMLElement).closest('[data-action]') as HTMLButtonElement | null;
    if (!btn || !current || btn.disabled) return;
    const action = btn.dataset.action;
    const target = current;
    close();
    if (action === 'hide') handlers.toggleHidden(target);
    else if (action === 'star') handlers.toggleStarred(target);
    else if (action === 'refresh') handlers.refreshConnector(target);
    else if (action === 'customize') handlers.openCustomize?.(target);
  });

  // A plain left-click anywhere outside the menu dismisses it — separate from
  // `contextmenu`'s own `preventDefault()`, which only stops the browser's
  // native menu from also appearing on the same right-click.
  root.addEventListener('click', e => {
    if (!menu.hidden && !(e.target as HTMLElement).closest('#rowMenu')) close();
  });
  root.addEventListener('keydown', e => {
    if (!menu.hidden && (e as KeyboardEvent).key === 'Escape') close();
  });
}
