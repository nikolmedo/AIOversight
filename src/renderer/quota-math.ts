// Shared quota formatting / pace-coloring math. Non-module global script —
// no top-level `import`/`export` — loaded via <script> before settings.js /
// tray-popup.js so its top-level function declarations land in the same
// global scope those files run in (see settings.ts's header comment for why
// this repo compiles renderer .ts as plain scripts, not CommonJS modules).
//
// Also loaded standalone by scripts/smoke.js via Node's `vm.runInNewContext`
// against the compiled dist/renderer/quota-math.js — keep this file DOM-free
// so it can run outside a browser context.

/** `null` -> "No data". `'usd'` is integer cents. `'tokens'` uses a compact 1.2M/340k style. */
function formatQuotaValue(n: number | null, unit: QuotaUnit): string {
  if (n == null) return 'No data';
  // Preserves the old formatQuotaNumber('usd') convention exactly: 'usd' is
  // integer cents. 'credits'/'requests' fall through to toLocaleString(), same
  // as before.
  if (unit === 'usd') return `$${(n / 100).toFixed(2)}`;
  if (unit === 'tokens') return formatTokens(n);
  if (unit === 'percent') return `${Math.round(n)}%`;
  return n.toLocaleString();
}

/** Compact token formatter: 1.2M / 340k / 950 style. */
function formatTokens(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${trimTrailingZero(n / 1_000_000)}M`;
  if (abs >= 1_000) return `${trimTrailingZero(n / 1_000)}k`;
  return n.toLocaleString();
}

function trimTrailingZero(n: number): string {
  return n.toFixed(1).replace(/\.0$/, '');
}

/** `used/limit*100` clamped 0..100, or `null` if either is null or limit<=0. */
function percentFor(bucket: { used: number | null; limit: number | null }): number | null {
  if (bucket.used == null || bucket.limit == null || bucket.limit <= 0) return null;
  return Math.min(100, Math.max(0, (bucket.used / bucket.limit) * 100));
}

interface PaceBucket {
  used: number | null;
  limit: number | null;
  resetsAt?: number;
  windowMs?: number;
}

/**
 * Today's exact static thresholds (unchanged behavior when no reset/window
 * data is available): >=90% critical, >=75% warn, else ok.
 *
 * Rounds to a whole percent before comparing — byte-for-byte parity with the
 * old renderer code, which computed `Math.round((used/limit)*100)` and then
 * compared that rounded integer against 90/75. Comparing the raw fraction
 * would silently reclassify boundary ratios like 745/1000 (0.745, rounds to
 * 75%) from 'warn' to 'ok'.
 */
function staticPaceState(pct: number): 'ok' | 'warn' | 'critical' {
  const rounded = Math.round(pct * 100);
  if (rounded >= 90) return 'critical';
  if (rounded >= 75) return 'warn';
  return 'ok';
}

/**
 * Pace/burn-rate coloring. With `resetsAt` + `windowMs` present, colors by
 * projected-exhaustion-before-reset; otherwise falls back to the static
 * thresholds above for buckets that don't report reset data.
 */
function paceStateFor(bucket: PaceBucket, now: number): 'none' | 'ok' | 'warn' | 'critical' {
  if (bucket.used == null || bucket.limit == null || bucket.limit <= 0) return 'none';
  const pct = bucket.used / bucket.limit;

  if (bucket.resetsAt == null || bucket.windowMs == null || bucket.windowMs <= 0) {
    return staticPaceState(pct);
  }

  const elapsed = Math.min(bucket.windowMs, Math.max(0, bucket.windowMs - (bucket.resetsAt - now)));
  const f = elapsed / bucket.windowMs;

  // Early-window noise guard: with almost no elapsed window, a tiny amount of
  // usage projects to an absurd burn rate. Fall back to the static bands.
  // Same fallback once the window has already fully elapsed (f>=1, i.e. now
  // is past resetsAt but we haven't polled fresh post-reset data yet) —
  // projection is meaningless past the reset, and the projected-mode
  // thresholds below are more lenient than the static ones (critical only at
  // 100% vs. static's 90%), which would under-report severity on stale data
  // right when it matters most.
  if (f < 0.05 || f >= 1) return staticPaceState(pct);

  const projected = pct / f;
  if (pct >= 1 || projected >= 1.0) return 'critical';
  if (projected >= 0.9) return 'warn';
  return 'ok';
}

/** `max(0, 1 - projected)` when computable, else `null`. */
function projectedRemainingFraction(bucket: PaceBucket, now: number): number | null {
  if (bucket.used == null || bucket.limit == null || bucket.limit <= 0) return null;
  if (bucket.resetsAt == null || bucket.windowMs == null || bucket.windowMs <= 0) return null;
  const pct = bucket.used / bucket.limit;
  const elapsed = Math.min(bucket.windowMs, Math.max(0, bucket.windowMs - (bucket.resetsAt - now)));
  const f = elapsed / bucket.windowMs;
  // Same guards as `paceStateFor`: no projection this early in the window,
  // nor once the window has passed without fresh post-reset data.
  if (f < 0.05 || f >= 1) return null;
  const projected = pct / f;
  return Math.max(0, 1 - projected);
}

/** Coarse duration for forecasts: "<1m", "~40m", "~3h", "~5d". */
function formatApproxDuration(ms: number): string {
  if (ms < 60_000) return '<1m';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `~${m}m`;
  const h = Math.round(ms / 3_600_000);
  if (h < 48) return `~${h}h`;
  return `~${Math.round(ms / 86_400_000)}d`;
}

/**
 * One-line forecast for a bucket whose pace is warn or critical, e.g.
 * "At this pace: runs out in ~3h, before reset" or "At this pace: ~6% left
 * at reset". Built on `projectedRemainingFraction`, so it only speaks when
 * the colour came from the pace projection: `null` for ok/no-data buckets,
 * for the static-band fallback (no `resetsAt`/`windowMs`, first 5% of the
 * window, or past the reset) and for a bucket already at its limit, whose
 * 100% says it all.
 */
function paceForecast(bucket: PaceBucket, now: number): string | null {
  const state = paceStateFor(bucket, now);
  if (state !== 'warn' && state !== 'critical') return null;
  const remaining = projectedRemainingFraction(bucket, now);
  if (remaining == null) return null;
  const used = bucket.used!;
  const limit = bucket.limit!;
  if (used >= limit || used <= 0) return null;
  if (remaining > 0) {
    const pct = Math.round(remaining * 100);
    return `At this pace: ${pct < 1 ? '<1%' : `~${pct}%`} left at reset`;
  }
  // Linear burn since the window opened: time to cover what's left at the
  // average rate so far. `remaining === 0` means this lands before resetsAt.
  const elapsed = bucket.windowMs! - (bucket.resetsAt! - now);
  const msToLimit = ((limit - used) / used) * elapsed;
  return `At this pace: runs out in ${formatApproxDuration(msToLimit)}, before reset`;
}

/** Words for a pace state in accessible labels; `''` for 'none'. */
function paceStateLabel(state: 'none' | 'ok' | 'warn' | 'critical'): string {
  if (state === 'critical') return 'critical';
  if (state === 'warn') return 'running high';
  if (state === 'ok') return 'on track';
  return '';
}

/**
 * Parses a snapshot billing-cycle date: ISO strings (Copilot's date-only
 * form parses as UTC midnight) and epoch-ms digit strings. `null` when
 * missing or unparsable.
 */
function parseBillingCycleDate(value: string | undefined): number | null {
  if (!value) return null;
  const ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Length of the billing cycle in ms (`end - start`), or `null` unless both
 * dates parse and `end > start`.
 */
function billingCycleWindowMs(billingCycleStart: string | undefined, billingCycleEnd: string | undefined): number | null {
  const start = parseBillingCycleDate(billingCycleStart);
  const end = parseBillingCycleDate(billingCycleEnd);
  if (start == null || end == null || end <= start) return null;
  return end - start;
}

/**
 * Buckets with the snapshot's billing cycle filled in where a bucket has no
 * reset of its own, so monthly plans show when they reset and get pace
 * colouring. Only metered buckets get it (measured `used` and a positive
 * `limit`): a remaining-only balance (prepaid credits) and a limit-less
 * running total (Cursor's rolling "last 30 days" usage) don't reset with the
 * cycle. `billingCycleEnd` becomes `resetsAt`; when `billingCycleStart` also
 * parses and precedes it, `end - start` becomes `windowMs`, which turns on
 * the pace projection and forecast. A bucket's own `resetsAt` is never paired
 * with a cycle-derived `windowMs`, and an existing `windowMs` is kept.
 * Returns the input array unchanged when the end date is missing or
 * unparsable.
 */
function withBillingCycleReset(
  buckets: QuotaBucket[],
  billingCycleEnd: string | undefined,
  billingCycleStart?: string,
): QuotaBucket[] {
  const end = parseBillingCycleDate(billingCycleEnd);
  if (end == null) return buckets;
  const windowMs = billingCycleWindowMs(billingCycleStart, billingCycleEnd);
  return buckets.map(b => {
    if (b.resetsAt != null || b.used == null || b.limit == null || b.limit <= 0) return b;
    const next: QuotaBucket = { ...b, resetsAt: end };
    if (windowMs != null && next.windowMs == null) next.windowMs = windowMs;
    return next;
  });
}

/**
 * Per-provider freshness for the tray popup: `formatRelativeTime`'s label
 * ("just now", "5m ago") and whether the data is older than twice the
 * connector's poll interval. `intervalMs` is `undefined` when the connector
 * only refreshes by hand (poll override 0) or the interval is unknown; such
 * data is never flagged stale.
 */
function freshnessFor(
  fetchedAt: number,
  intervalMs: number | undefined,
  now: number,
): { text: string; stale: boolean } {
  const stale = intervalMs != null && intervalMs > 0 && now - fetchedAt > 2 * intervalMs;
  return { text: formatRelativeTime(fetchedAt, now), stale };
}

/** e.g. "2d 6h" (from 48h up), "3h 25m", "12m", "now" for <=0. */
function formatCountdown(msRemaining: number): string {
  if (msRemaining <= 0) return 'now';
  const h = Math.floor(msRemaining / 3_600_000);
  const m = Math.floor((msRemaining % 3_600_000) / 60_000);
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return '<1m';
}

/** e.g. "resets in 3h 25m", "resets now" for <=0. */
function formatResetsIn(msRemaining: number): string {
  return msRemaining <= 0 ? 'resets now' : `resets in ${formatCountdown(msRemaining)}`;
}

/** Coarse past-time label for event lists: "just now", "12m ago", "3h ago", "2d ago". */
function formatRelativeTime(ts: number, now: number): string {
  const diff = now - ts;
  if (diff < 60_000) return 'just now';
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Footer label for the tray popup: "Updated just now", "Updated 42s ago",
 * then `formatRelativeTime`'s coarse steps ("Updated 3m ago"). A timestamp in
 * the future (clock skew) reads as "just now". */
function formatUpdatedAgo(ts: number, now: number): string {
  const diff = now - ts;
  if (diff < 10_000) return 'Updated just now';
  if (diff < 60_000) return `Updated ${Math.floor(diff / 1000)}s ago`;
  return `Updated ${formatRelativeTime(ts, now)}`;
}

type ConnectorStatus = 'off' | 'active' | 'error' | 'needs-login' | 'app-not-running';

/**
 * One status per connector for the Integrations list. A quota error only
 * counts while quota is enabled — a stale failed snapshot from before the
 * user switched quota off must not keep the row red.
 */
function connectorStatusFor(
  enabled: { notifications: boolean; quota: boolean } | undefined,
  snap: { ok: boolean; needsLogin?: boolean; appNotRunning?: boolean } | undefined,
): ConnectorStatus {
  if (!enabled || (!enabled.notifications && !enabled.quota)) return 'off';
  if (enabled.quota && snap && !snap.ok) {
    if (snap.appNotRunning) return 'app-not-running';
    return snap.needsLogin ? 'needs-login' : 'error';
  }
  return 'active';
}

/** A snapshot that stands for "the connector's desktop app is closed" (see `appNotRunning` in types.ts). */
function isAppNotRunning(snap: QuotaSnapshot | undefined): boolean {
  return !!snap && !snap.ok && !!snap.appNotRunning;
}

function formatExactReset(ts: number, fmt: '12h' | '24h'): string {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: fmt === '12h',
  });
}

function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

/**
 * Shared "what order does a set of buckets display in" logic. Single source
 * of truth for both `renderMeterGroup` (quota-view.ts, the live meter's
 * main/on-demand row groups) and the drawer Meters section's pre-move baseline
 * (`customizeDisplayOrder` in settings.ts) — factored out after a review
 * found the two had drifted (the Meters list used raw declaration order,
 * `renderMeterGroup` used pct-desc), which made an up/down click silently
 * move buckets the user never touched relative to what they'd see in the
 * live meter.
 *
 * Buckets carrying an explicit `BucketPref.order` (Phase 2c's up/down move
 * buttons) sort first, ascending; the rest sort by raw (unclamped) used/limit
 * ratio descending — buckets with no determinable limit sort last within
 * that remainder. No bucket has `order` set before a user's first move, so
 * this is a no-op reduction to plain pct-desc until then.
 */
function sortBucketsByDisplayOrder(
  buckets: QuotaBucket[],
  bucketPrefs: Record<string, BucketPref> | undefined,
): QuotaBucket[] {
  const hasLimit = (b: QuotaBucket): boolean => b.limit != null && b.limit > 0;
  // Raw (unclamped) ratio, not percentFor()'s display-clamped [0,100] value —
  // two over-limit buckets must not tie.
  const rawPct = (b: QuotaBucket): number => (b.used != null && hasLimit(b) ? (b.used / b.limit!) * 100 : 0);

  const withOrder = buckets.filter(b => bucketPrefs?.[b.id]?.order != null);
  const withoutOrder = buckets.filter(b => bucketPrefs?.[b.id]?.order == null);
  withOrder.sort((a, b) => bucketPrefs![a.id].order! - bucketPrefs![b.id].order!);
  const withPct = withoutOrder.filter(hasLimit);
  const noPct = withoutOrder.filter(b => !hasLimit(b));
  withPct.sort((a, b) => Math.round(rawPct(b)) - Math.round(rawPct(a)));
  return [...withOrder, ...withPct, ...noPct];
}

/**
 * Pure reorder math for the Meters section's up/down move buttons (Phase 2c —
 * chosen over drag-and-drop, see the plan). `orderedIds` must already be in
 * the connector's current display order (numeric `BucketPref.order` first,
 * ties/absences broken however the caller's existing sort already works —
 * see `customizeDisplayOrder` in settings.ts). Returns `null` when the move
 * is out of bounds (already first/last) or `bucketId` isn't in the list.
 *
 * Every id in `orderedIds` gets a dense `0..n-1` value in the result, not
 * just the two swapped: no bucket has a persisted `order` before the first
 * move, so a partial write would leave the rest with none at all, and
 * `renderMeterGroup`'s order-first sort would then ignore the new order for
 * everyone but the two rows just touched.
 */
function computeReorderedOrders(
  orderedIds: string[],
  bucketId: string,
  direction: 'up' | 'down',
): Record<string, number> | null {
  const idx = orderedIds.indexOf(bucketId);
  if (idx < 0) return null;
  const swapWith = direction === 'up' ? idx - 1 : idx + 1;
  if (swapWith < 0 || swapWith >= orderedIds.length) return null;

  const next = orderedIds.slice();
  const tmp = next[idx];
  next[idx] = next[swapWith];
  next[swapWith] = tmp;

  const out: Record<string, number> = {};
  next.forEach((id, i) => {
    out[id] = i;
  });
  return out;
}
