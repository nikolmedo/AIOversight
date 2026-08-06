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
 * thresholds above so behavior is unchanged for connectors that don't yet
 * report reset data.
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
  if (f < 0.05) return null;
  const projected = pct / f;
  return Math.max(0, 1 - projected);
}

/** `f * 100` (elapsed fraction of the window, as a percent) when computable, else `null`. */
function evenPaceTickPercent(bucket: PaceBucket, now: number): number | null {
  if (bucket.resetsAt == null || bucket.windowMs == null || bucket.windowMs <= 0) return null;
  const elapsed = Math.min(bucket.windowMs, Math.max(0, bucket.windowMs - (bucket.resetsAt - now)));
  return (elapsed / bucket.windowMs) * 100;
}

/** e.g. "3h 25m", "12m", "now" for <=0. */
function formatCountdown(msRemaining: number): string {
  if (msRemaining <= 0) return 'now';
  const h = Math.floor(msRemaining / 3_600_000);
  const m = Math.floor((msRemaining % 3_600_000) / 60_000);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return '<1m';
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
 * main/on-demand row groups) and the Customize tab's pre-move baseline
 * (`customizeDisplayOrder` in settings.ts) — factored out after a review
 * found the two had drifted (Customize used raw declaration order,
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
 * Pure reorder math for the Customize tab's up/down move buttons (Phase 2c —
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
