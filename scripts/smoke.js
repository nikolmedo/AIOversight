// Headless smoke test for the connector framework. Runs without Electron so we
// can validate the watching/idle/webhook logic in CI or locally in seconds.
//
//   npm run build && node scripts/smoke.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const zlib = require('zlib');

const { TranscriptWatcher } = require('../dist/main/connectors/shared/transcript-watcher.js');
const { ALL_CONNECTORS, findConnector } = require('../dist/main/connectors/registry.js');
// tray.ts imports 'electron' at module top level, but only for
// Tray/Menu/nativeImage/app, none of which formatTrayLineFor touches — under
// plain Node (outside the Electron binary) require('electron') resolves to a
// harmless path string, so destructuring those names off it is undefined,
// not a throw, and the module loads fine headless.
const { formatTrayLineFor, trayRepresentationsToLoad } = require('../dist/main/tray.js');
// settings-store.ts imports 'electron' at module top level too, but `app` is
// only touched inside the `SettingsStore` constructor / methods — never
// called here — so this loads fine headless as long as we stick to the
// exported free functions and don't `new SettingsStore(...)`.
const { sanitizeBucketPrefPatch, isTheme, isDensity, isTimeFormat } = require('../dist/main/settings-store.js');
const { dollarsToCents, buildSpendTiles } = require('../dist/main/connectors/cursor/quota.js');
const { dollarsToCents: copilotDollarsToCents } = require('../dist/main/connectors/github-copilot/quota.js');
const { dollarsToCents: openrouterDollarsToCents, firstFiniteNumber: openrouterFirstFiniteNumber } = require('../dist/main/connectors/openrouter/quota.js');
const { extractItems: zaiExtractItems, parseQuotaItems: zaiParseQuotaItems, resolveWindowPairing: zaiResolveWindowPairing, firstFiniteNumber: zaiFirstFiniteNumber } = require('../dist/main/connectors/zai/quota.js');
const { atomicWriteFile, slugifyModel, buildSparkBuckets, extractCodexSpend } = require('../dist/main/connectors/codex-cli/quota.js');
const { extractClaudeCodeSpend } = require('../dist/main/connectors/claude-code/quota.js');
const { JsonlSpendScanner } = require('../dist/main/connectors/shared/jsonl-spend-scanner.js');
const { rateFor, costCentsFor } = require('../dist/main/connectors/shared/model-pricing.js');
const {
  defaultOpencodeDataDirs,
  resolveDataDirs: opencodeResolveDataDirs,
  isOpencodeDbFilename,
  extractAuthLabel: opencodeExtractAuthLabel,
  dollarsToCents: opencodeDollarsToCents,
  toSpendRecords: opencodeToSpendRecords,
  buildCapBuckets: opencodeBuildCapBuckets,
  buildSpendTiles: opencodeBuildSpendTiles,
  noUsableSessionData,
  createOpencodeQuotaProvider,
} = require('../dist/main/connectors/opencode/quota.js');
const {
  resolveWindowPairing: grokResolveWindowPairing,
  atomicWriteFile: grokAtomicWriteFile,
  parseBillingJson: grokParseBillingJson,
  parsePlanTier: grokParsePlanTier,
  extractGrokSpend,
  noRecognisableGrokData,
} = require('../dist/main/connectors/grok/quota.js');
const {
  resolveWindowPairing: devinResolveWindowPairing,
  dollarsToCents: devinDollarsToCents,
  parseFlatToml,
  resolveServerUrl: devinResolveServerUrl,
  parseUserStatus: devinParseUserStatus,
  buildQuotaWindowBuckets,
} = require('../dist/main/connectors/devin/quota.js');
const {
  DEFAULT_PORT_RANGE,
  MAX_PORT_RANGE_SPAN,
  parsePortRange,
  parsePortRangeInfo,
  looksLikeAntigravityServer,
  extractCsrfToken,
  scanForLanguageServer,
  resolveWindowPairing: antigravityResolveWindowPairing,
  normalizeEpochMs,
  poolForModel,
  classifyWindowKind,
  extractQuotaEntries: antigravityExtractQuotaEntries,
  mergePoolQuota,
  queryQuotaData,
  queryQuotaDataWithBudget,
  createAntigravityQuotaProvider,
} = require('../dist/main/connectors/antigravity/quota.js');

let failures = 0;
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

function makeCtx(captured, overrides) {
  return {
    emit: e => captured.push(e),
    log: (lvl, msg, meta) => process.env.DEBUG && console.log(`  [${lvl}] ${msg}`, meta ?? ''),
    resolvePath: p => p,
    secret: () => null,
    setSecret: () => {},
    ...(overrides || {}),
  };
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// --------------------------------------------------------------------------
// ConnectorRegistry sanity
// --------------------------------------------------------------------------
function testRegistry() {
  console.log('Registry: built-in connectors are present');
  const expectedIds = [
    'cursor',
    'anthropic',
    'claude-code',
    'openai',
    'codex-cli',
    'github-copilot',
    'openrouter',
    'zai',
    'opencode',
    'grok',
    'devin',
    'antigravity',
    'generic-jsonl',
    'webhook',
  ];
  for (const id of expectedIds) {
    check(`registry has ${id}`, !!findConnector(id), `missing ${id}`);
  }
  // Cursor must have both detector and quota.
  const cursor = findConnector('cursor');
  check('cursor has detector + quota', !!cursor.detector && !!cursor.quota);
  // Codex CLI (Phase 3): now has its own dedicated quota provider alongside
  // its existing detector -- distinct from the OpenAI connector's org billing.
  const codexCli = findConnector('codex-cli');
  check('codex-cli has detector + quota', !!codexCli.detector && !!codexCli.quota);
  check('codex-cli quota is enabled by default', codexCli.quotaEnabledByDefault === true);
  // Webhook is notifications-only.
  const webhook = findConnector('webhook');
  check('webhook has detector but no quota', !!webhook.detector && !webhook.quota);
  // Anthropic / OpenAI / Copilot / OpenRouter / Z.ai / OpenCode / Grok / Devin / Antigravity are quota-only.
  for (const id of ['anthropic', 'openai', 'github-copilot', 'openrouter', 'zai', 'opencode', 'grok', 'devin', 'antigravity']) {
    const def = findConnector(id);
    check(`${id} has quota`, !!def.quota);
    check(`${id} has no detector`, !def.detector);
  }
  // OpenCode is fully offline -- no secret configSchema field.
  const opencode = findConnector('opencode');
  check('opencode has no secret config field', !opencode.configSchema.some(f => f.type === 'secret'));
  check('opencode quota is enabled by default (reads local files, no config required)',
        opencode.quotaEnabledByDefault === true);
  // Antigravity (Phase 5.6) is the one connector that is off by default in
  // BOTH senses -- unlike every other connector in this codebase, which is
  // either enabled by default or at least quota-enabled by default once
  // configured. This is a deliberate, real behavioral difference (it only
  // works while a local app is running) worth asserting explicitly.
  const antigravity = findConnector('antigravity');
  check('antigravity is NOT enabled by default', antigravity.enabledByDefault === false);
  check('antigravity quota is NOT enabled by default', antigravity.quotaEnabledByDefault === false);
  check('antigravity has a string portRange config field',
        antigravity.configSchema.some(f => f.key === 'portRange' && f.type === 'string'));
  check('antigravity has no secret/login config -- local-server-only, no credential flow',
        !antigravity.configSchema.some(f => f.type === 'secret') && !antigravity.login);
  // Schema fields are well-formed.
  for (const def of ALL_CONNECTORS) {
    for (const f of def.configSchema) {
      const okType = ['string', 'number', 'boolean', 'paths', 'secret', 'enum'].includes(f.type);
      check(`${def.id}.${f.key} field type valid`, okType, `type=${f.type}`);
    }
  }

  // Connector ids are unique (they're permanent settings keys).
  const ids = ALL_CONNECTORS.map(d => d.id);
  const uniqueIds = new Set(ids);
  check('all connector ids are unique', uniqueIds.size === ids.length,
        `${ids.length} defs, ${uniqueIds.size} unique ids`);

  // Any declared brandColor is a valid hex color string.
  const hexColorRe = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
  for (const def of ALL_CONNECTORS) {
    if (def.brandColor === undefined) continue;
    check(`${def.id}.brandColor is valid hex`, hexColorRe.test(def.brandColor),
          `brandColor=${def.brandColor}`);
  }
}

// --------------------------------------------------------------------------
// quota-math.js: pace/format math, run headless via vm against the compiled
// renderer script (it's a non-module global script, not require()-able).
// --------------------------------------------------------------------------
function testQuotaMath() {
  console.log('quota-math: pace state + value formatting');
  const file = path.join(__dirname, '..', 'dist', 'renderer', 'quota-math.js');
  const code = fs.readFileSync(file, 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: file });

  // --- formatQuotaValue -----------------------------------------------------
  check("formatQuotaValue(408, 'usd') === '$4.08'",
        sandbox.formatQuotaValue(408, 'usd') === '$4.08',
        sandbox.formatQuotaValue(408, 'usd'));
  check("formatQuotaValue(null, 'usd') === 'No data'",
        sandbox.formatQuotaValue(null, 'usd') === 'No data',
        sandbox.formatQuotaValue(null, 'usd'));
  check("formatQuotaValue(0, 'usd') === '$0.00'",
        sandbox.formatQuotaValue(0, 'usd') === '$0.00',
        sandbox.formatQuotaValue(0, 'usd'));
  check("formatQuotaValue(45, 'percent') === '45%'",
        sandbox.formatQuotaValue(45, 'percent') === '45%',
        sandbox.formatQuotaValue(45, 'percent'));
  check("formatQuotaValue(null, 'tokens') === 'No data'",
        sandbox.formatQuotaValue(null, 'tokens') === 'No data',
        sandbox.formatQuotaValue(null, 'tokens'));

  // --- formatCountdown --------------------------------------------------
  check("formatCountdown(0) === 'now'", sandbox.formatCountdown(0) === 'now');
  check("formatCountdown(-1000) === 'now'", sandbox.formatCountdown(-1000) === 'now');
  check("formatCountdown(12 * 60_000) === '12m'",
        sandbox.formatCountdown(12 * 60_000) === '12m',
        sandbox.formatCountdown(12 * 60_000));
  check("formatCountdown(3 * 3_600_000 + 25 * 60_000) === '3h 25m'",
        sandbox.formatCountdown(3 * 3_600_000 + 25 * 60_000) === '3h 25m',
        sandbox.formatCountdown(3 * 3_600_000 + 25 * 60_000));

  // --- paceStateFor: static-threshold boundaries (no resetsAt/windowMs) -----
  const staticBucket = used => ({ used, limit: 100 });
  check('paceStateFor: 74% -> ok (static)',
        sandbox.paceStateFor(staticBucket(74), Date.now()) === 'ok');
  check('paceStateFor: 75% -> warn (static)',
        sandbox.paceStateFor(staticBucket(75), Date.now()) === 'warn');
  check('paceStateFor: 89% -> warn (static)',
        sandbox.paceStateFor(staticBucket(89), Date.now()) === 'warn');
  check('paceStateFor: 90% -> critical (static)',
        sandbox.paceStateFor(staticBucket(90), Date.now()) === 'critical');
  // Fractional-limit boundary: 745/1000 = 0.745, which rounds to 75% and must
  // be 'warn'. A raw-fraction comparison (0.745 >= 0.75 is false) would wrongly
  // return 'ok' here — this is the exact bug the rounding fix corrects.
  check("paceStateFor: 745/1000 (0.745, rounds to 75%) -> warn, not ok",
        sandbox.paceStateFor({ used: 745, limit: 1000 }, Date.now()) === 'warn',
        sandbox.paceStateFor({ used: 745, limit: 1000 }, Date.now()));
  // Same shape at the critical boundary: 895/1000 = 0.895, rounds to 90%.
  check("paceStateFor: 895/1000 (0.895, rounds to 90%) -> critical, not warn",
        sandbox.paceStateFor({ used: 895, limit: 1000 }, Date.now()) === 'critical',
        sandbox.paceStateFor({ used: 895, limit: 1000 }, Date.now()));
  check("paceStateFor: used === null -> 'none'",
        sandbox.paceStateFor({ used: null, limit: 100 }, Date.now()) === 'none');
  check("paceStateFor: limit === null -> 'none'",
        sandbox.paceStateFor({ used: 10, limit: null }, Date.now()) === 'none');

  // --- paceStateFor: pace-mode crossings (resetsAt + windowMs present) ------
  const now = Date.now();
  const windowMs = 18_000_000; // 5h
  // Half the window elapsed, used exactly half the limit -> on pace (f=0.5, pct=0.5, projected=1.0).
  const onPaceBucket = {
    used: 50,
    limit: 100,
    windowMs,
    resetsAt: now + windowMs / 2, // half elapsed
  };
  check('paceStateFor: on-pace projected===1.0 -> critical (>=1.0 threshold)',
        sandbox.paceStateFor(onPaceBucket, now) === 'critical');
  // Used well under the pace line -> ok.
  const underPaceBucket = { used: 20, limit: 100, windowMs, resetsAt: now + windowMs / 2 };
  check('paceStateFor: well under pace -> ok',
        sandbox.paceStateFor(underPaceBucket, now) === 'ok');
  // Used just over the 0.90 projected-exhaustion line -> warn.
  const warnPaceBucket = { used: 46, limit: 100, windowMs, resetsAt: now + windowMs / 2 };
  check('paceStateFor: projected ~0.92 -> warn',
        sandbox.paceStateFor(warnPaceBucket, now) === 'warn',
        sandbox.paceStateFor(warnPaceBucket, now));

  // --- paceStateFor: f < 0.05 early-window guard falls back to static -------
  // Only ~2% of the window elapsed -> f<0.05 -> ignore the (huge) projected
  // burn rate and use the plain static 90/75 thresholds on used/limit instead.
  const earlyWindowCritical = { used: 90, limit: 100, windowMs, resetsAt: now + windowMs * 0.98 };
  check('paceStateFor: f<0.05 falls back to static thresholds (90% -> critical via static)',
        sandbox.paceStateFor(earlyWindowCritical, now) === 'critical');
  const earlyWindowOk = { used: 50, limit: 100, windowMs, resetsAt: now + windowMs * 0.98 };
  check('paceStateFor: f<0.05 + 50% used -> ok via static fallback (would be critical if projected)',
        sandbox.paceStateFor(earlyWindowOk, now) === 'ok');

  // --- computeReorderedOrders: Customize tab's up/down move buttons (Phase 2c) ---
  const ids = ['a', 'b', 'c', 'd'];
  const movedUp = sandbox.computeReorderedOrders(ids, 'c', 'up');
  check('computeReorderedOrders: moving "c" up swaps it with "b"',
        JSON.stringify(movedUp) === JSON.stringify({ a: 0, c: 1, b: 2, d: 3 }),
        JSON.stringify(movedUp));
  const movedDown = sandbox.computeReorderedOrders(ids, 'b', 'down');
  check('computeReorderedOrders: moving "b" down swaps it with "c"',
        JSON.stringify(movedDown) === JSON.stringify({ a: 0, c: 1, b: 2, d: 3 }),
        JSON.stringify(movedDown));
  check('computeReorderedOrders: moving the first id up is a no-op (null)',
        sandbox.computeReorderedOrders(ids, 'a', 'up') === null);
  check('computeReorderedOrders: moving the last id down is a no-op (null)',
        sandbox.computeReorderedOrders(ids, 'd', 'down') === null);
  check('computeReorderedOrders: an id not in the list returns null',
        sandbox.computeReorderedOrders(ids, 'zzz', 'up') === null);
  const denseCheck = sandbox.computeReorderedOrders(ids, 'a', 'down');
  check('computeReorderedOrders: result assigns a dense 0..n-1 order to every id, not just the two swapped',
        Object.keys(denseCheck).length === 4 && new Set(Object.values(denseCheck)).size === 4,
        JSON.stringify(denseCheck));
}

// --------------------------------------------------------------------------
// tray.ts: formatTrayLineFor — starred-only filtering, the highest-usage
// fallback when nothing is starred yet, and no-data exclusion.
// --------------------------------------------------------------------------
function testTrayLine() {
  console.log('tray: formatTrayLineFor starred filtering + fallback');
  const bucket = overrides => ({
    id: 'b1', label: 'Requests', used: 10, limit: 100, remaining: 90, unit: 'requests', enabled: true, ...overrides,
  });
  const okSnap = (buckets, extra) => ({ ok: true, fetchedAt: Date.now(), buckets, displayMessages: [], ...extra });

  // No stars anywhere -> falls back to the highest-usage measured bucket,
  // never to the first bucket by declaration order.
  const noStars = okSnap([bucket({ id: 'low', used: 10 }), bucket({ id: 'high', used: 90 })]);
  check('formatTrayLineFor: no stars -> falls back to highest-usage bucket',
        formatTrayLineFor('X', noStars, {}) === 'X: 90% used',
        formatTrayLineFor('X', noStars, {}));

  // All buckets limit:null (Anthropic's/OpenAI's primary quota shape) tie at
  // ratio -1 -> must fall back to raw `used`, not silently to buckets[0].
  const allLimitNull = okSnap([
    bucket({ id: 'a', used: 10, limit: null, remaining: null }),
    bucket({ id: 'b', used: 50, limit: null, remaining: null }),
  ]);
  check('formatTrayLineFor: all limit:null -> falls back to raw used, not declaration order',
        formatTrayLineFor('X', allLimitNull, {}) === 'X: 50 requests',
        formatTrayLineFor('X', allLimitNull, {}));

  // One starred bucket -> only that bucket shows, even if it's not the
  // highest-usage one.
  const oneStar = okSnap([bucket({ id: 'low', used: 10 }), bucket({ id: 'high', used: 90 })]);
  check('formatTrayLineFor: one starred bucket -> shows only that bucket',
        formatTrayLineFor('X', oneStar, { low: { starred: true } }) === 'X: 10% used',
        formatTrayLineFor('X', oneStar, { low: { starred: true } }));

  // ok:true + zero measured buckets (empty array, or every bucket used=null)
  // is a healthy connected state (Anthropic/Copilot with no usage yet this
  // period) -> falls back to membershipType, or "connected" if unset. This
  // is connector-level and distinct from the per-bucket no-placeholder rule
  // below, which only governs which buckets show alongside real ones.
  check('formatTrayLineFor: empty buckets + membershipType -> membershipType fallback',
        formatTrayLineFor('X', okSnap([], { membershipType: 'Pro' }), {}) === 'X: Pro',
        formatTrayLineFor('X', okSnap([], { membershipType: 'Pro' }), {}));
  check('formatTrayLineFor: empty buckets, no membershipType -> "connected" fallback',
        formatTrayLineFor('X', okSnap([]), {}) === 'X: connected',
        formatTrayLineFor('X', okSnap([]), {}));
  const allNoData = okSnap([bucket({ id: 'nd', used: null, remaining: null })]);
  check('formatTrayLineFor: buckets present but all used=null -> same fallback as empty',
        formatTrayLineFor('X', allNoData, {}) === 'X: connected',
        formatTrayLineFor('X', allNoData, {}));

  // A starred bucket with used === null is excluded even though it's
  // starred — a second starred, measured bucket still shows on its own.
  const starredNoData = okSnap([
    bucket({ id: 'nd', used: null, remaining: null }),
    bucket({ id: 'measured', used: 30 }),
  ]);
  check('formatTrayLineFor: starred used=null excluded even when starred',
        formatTrayLineFor('X', starredNoData, { nd: { starred: true }, measured: { starred: true } }) === 'X: 30% used',
        formatTrayLineFor('X', starredNoData, { nd: { starred: true }, measured: { starred: true } }));

  // !ok snapshot -> null.
  check('formatTrayLineFor: !ok snapshot -> null',
        formatTrayLineFor('X', { ok: false, fetchedAt: Date.now(), error: 'nope' }, {}) === null);
}

// --------------------------------------------------------------------------
// quota-view.js: renderMeterRow / renderMeterGroup markup, run headless via
// vm against the compiled renderer scripts (concatenated, since quota-view.js
// calls quota-math.js's globals). Only the DOM-free render functions are
// exercised here — bindResetChips/refreshResetChips touch the DOM and aren't
// invoked.
// --------------------------------------------------------------------------
function testQuotaView() {
  console.log('quota-view: renderMeterRow / renderMeterGroup markup');
  const mathFile = path.join(__dirname, '..', 'dist', 'renderer', 'quota-math.js');
  const viewFile = path.join(__dirname, '..', 'dist', 'renderer', 'quota-view.js');
  const code = fs.readFileSync(mathFile, 'utf8') + '\n' + fs.readFileSync(viewFile, 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: viewFile });

  const now = 1_700_000_000_000;
  const bucket = overrides => ({
    id: 'b1',
    label: 'Requests',
    used: 45,
    limit: 100,
    remaining: 55,
    unit: 'requests',
    enabled: true,
    ...overrides,
  });

  // --- normal bucket ---------------------------------------------------
  const normalHtml = sandbox.renderMeterRow(bucket(), undefined, { now });
  check("renderMeterRow: normal bucket has --fill:45%", normalHtml.includes('--fill:45%'), normalHtml);
  check('renderMeterRow: normal bucket shows 45% pct',
        /class="meter-pct[^"]*">45%</.test(normalHtml), normalHtml);
  check('renderMeterRow: normal bucket has no no-data class', !normalHtml.includes('no-data'));

  // --- used === null -----------------------------------------------------
  const noDataHtml = sandbox.renderMeterRow(bucket({ used: null, remaining: null }), undefined, { now });
  check('renderMeterRow: used=null has no-data class',
        /class="meter-row no-data"/.test(noDataHtml), noDataHtml);
  check('renderMeterRow: used=null shows "No data"', noDataHtml.includes('No data'));
  check('renderMeterRow: used=null has no bar (no --fill)', !noDataHtml.includes('--fill:'));

  // --- used === null but remaining is a real value (WARNING fix) -----------
  // Cursor's credits-grant/credits-prepaid buckets and Devin's extra-balance
  // bucket are both shaped {used: null, remaining: <cents>, unit: 'usd'} --
  // this is real, displayable data, not "no data". Regression test for the
  // dead-shape bug flagged in review.
  const remainingOnlyBucket = bucket({ used: null, remaining: 1234, unit: 'usd', limit: null });
  const remainingOnlyHtml = sandbox.renderMeterRow(remainingOnlyBucket, undefined, { now });
  check('renderMeterRow: used=null + remaining!=null does NOT show "No data"',
        !remainingOnlyHtml.includes('No data'), remainingOnlyHtml);
  check('renderMeterRow: used=null + remaining!=null shows the formatted remaining value',
        remainingOnlyHtml.includes('$12.34'), remainingOnlyHtml);
  check('renderMeterRow: used=null + remaining!=null does NOT carry the no-data class (it has real data)',
        !/class="meter-row no-data"/.test(remainingOnlyHtml), remainingOnlyHtml);
  // Compact/on-demand hint path (the second dead-shape site flagged in review).
  const remainingOnlyCompactHtml = sandbox.renderMeterRow(remainingOnlyBucket, undefined, { now, compact: true });
  check('renderMeterRow (compact hint): used=null + remaining!=null shows the remaining value, not "No data"',
        remainingOnlyCompactHtml.includes('$12.34') && !remainingOnlyCompactHtml.includes('No data'),
        remainingOnlyCompactHtml);

  // --- resetsAt + windowMs -> reset chip + even-pace tick -----------------
  const windowMs = 18_000_000; // 5h
  const resetsAt = now + windowMs / 2;
  const resetHtml = sandbox.renderMeterRow(bucket({ resetsAt, windowMs }), undefined, { now });
  check('renderMeterRow: resetsAt renders a reset-chip',
        resetHtml.includes('class="reset-chip"'), resetHtml);
  check('renderMeterRow: reset-chip carries data-resets-at',
        resetHtml.includes(`data-resets-at="${resetsAt}"`));
  check('renderMeterRow: reset-chip starts in countdown mode',
        resetHtml.includes('data-mode="countdown"'));
  check('renderMeterRow: resetsAt+windowMs renders an even-pace tick',
        resetHtml.includes('--tick:'), resetHtml);

  // --- unit:'percent', limit:100 -> denominator suppressed -----------------
  const pctHtml = sandbox.renderMeterRow(
    bucket({ used: 45, limit: 100, remaining: null, unit: 'percent' }),
    undefined,
    { now },
  );
  check('renderMeterRow: percent/limit100 shows bare 45%', pctHtml.includes('>45%<'), pctHtml);
  check('renderMeterRow: percent/limit100 suppresses "/ 100% percent"',
        !pctHtml.includes('/ 100% percent'), pctHtml);

  // --- renderMeterGroup: hidden pref + on-demand grouping -------------------
  const buckets = [
    bucket({ id: 'visible', label: 'Visible' }),
    bucket({ id: 'hidden-one', label: 'Hidden' }),
    bucket({ id: 'extra', label: 'Extra', defaultVisibility: 'onDemand' }),
    // limit:null with no defaultVisibility (Anthropic/OpenAI/Copilot's real
    // shape today) must default to on-demand, not fully expanded -- the tray
    // popup has no scroll container, so this is the CRITICAL regression.
    bucket({ id: 'no-limit', label: 'NoLimit', limit: null, remaining: null }),
    // limit:0 (github-copilot's entitlement:0 shape) must classify the same
    // as limit:null -- both are "no determinable limit".
    bucket({ id: 'zero-limit', label: 'ZeroEntitlement', limit: 0, remaining: null }),
  ];
  const bucketPrefs = { 'hidden-one': { hidden: true } };
  const groupHtml = sandbox.renderMeterGroup(buckets, bucketPrefs, { now });
  check('renderMeterGroup: hidden bucket omitted entirely', !groupHtml.includes('Hidden'), groupHtml);
  check('renderMeterGroup: visible bucket rendered', groupHtml.includes('Visible'));
  check('renderMeterGroup: onDemand bucket inside meter-extras',
        /<div class="meter-extras">[\s\S]*Extra[\s\S]*<\/div>/.test(groupHtml), groupHtml);
  check('renderMeterGroup: limit:null bucket inside meter-extras',
        /<div class="meter-extras">[\s\S]*NoLimit[\s\S]*<\/div>/.test(groupHtml), groupHtml);
  check('renderMeterGroup: limit:0 bucket also defaults to on-demand (Gap A)',
        /<div class="meter-extras">[\s\S]*ZeroEntitlement[\s\S]*<\/div>/.test(groupHtml), groupHtml);
  const beforeExtras = groupHtml.split('<div class="meter-extras">')[0];
  check('renderMeterGroup: limit:null bucket not in main row set',
        !beforeExtras.includes('NoLimit'), beforeExtras);
  check('renderMeterGroup: limit:0 bucket not in main row set',
        !beforeExtras.includes('ZeroEntitlement'), beforeExtras);
  check('renderMeterGroup: on-demand buckets render as individually-collapsible compact rows',
        groupHtml.includes('meter-row-compact'), groupHtml);

  // --- Regression (Phase 2c review fix #2): the Customize tab's move
  // baseline must match the live meter's own order, or a move click can
  // silently reorder buckets the user never touched. Concrete repro from the
  // review: buckets A(used=10) B(used=20) C(used=90), all limit:100 -- the
  // live meter shows C, B, A (pct-desc); moving B up must swap it with its
  // *adjacent* neighbor C, leaving A (untouched) still last.
  const reproBuckets = [
    bucket({ id: 'A', label: 'A', used: 10, limit: 100 }),
    bucket({ id: 'B', label: 'B', used: 20, limit: 100 }),
    bucket({ id: 'C', label: 'C', used: 90, limit: 100 }),
  ];
  const liveOrderIds = [...sandbox.renderMeterGroup(reproBuckets, undefined, { now }).matchAll(/data-bucket-id="([^"]+)"/g)]
    .map(m => m[1]);
  check("regression: renderMeterGroup's live pct-desc order is C, B, A",
        JSON.stringify(liveOrderIds) === JSON.stringify(['C', 'B', 'A']), JSON.stringify(liveOrderIds));

  const customizeBaseline = sandbox.sortBucketsByDisplayOrder(reproBuckets, undefined).map(b => b.id);
  check('regression: sortBucketsByDisplayOrder (the Customize tab\'s baseline) matches the live meter order exactly',
        JSON.stringify(customizeBaseline) === JSON.stringify(liveOrderIds), JSON.stringify(customizeBaseline));

  const moveResult = sandbox.computeReorderedOrders(customizeBaseline, 'B', 'up');
  const newPrefs = Object.fromEntries(Object.entries(moveResult).map(([id, order]) => [id, { order }]));
  const afterMoveOrder = sandbox.sortBucketsByDisplayOrder(reproBuckets, newPrefs).map(b => b.id);
  check('regression: after moving B up, the live meter shows B, C, A -- A (untouched) does not move',
        JSON.stringify(afterMoveOrder) === JSON.stringify(['B', 'C', 'A']), JSON.stringify(afterMoveOrder));

  // --- renderMeterGroup: BucketPref.visibility override (Phase 2c) ---------
  const visBuckets = [
    // No defaultVisibility, no limit -> would default to onDemand; explicit
    // pref.visibility:'always' must override that.
    bucket({ id: 'forced-always', label: 'ForcedAlways', limit: null, remaining: null }),
    // Has a limit -> would default to 'always'; explicit pref.visibility
    // 'onDemand' must override that.
    bucket({ id: 'forced-ondemand', label: 'ForcedOnDemand' }),
  ];
  const visPrefs = {
    'forced-always': { visibility: 'always' },
    'forced-ondemand': { visibility: 'onDemand' },
  };
  const visHtml = sandbox.renderMeterGroup(visBuckets, visPrefs, { now });
  const visBeforeExtras = visHtml.split('<div class="meter-extras">')[0];
  check('renderMeterGroup: pref.visibility:"always" overrides a limit:null bucket into the main set',
        visBeforeExtras.includes('ForcedAlways'), visHtml);
  check('renderMeterGroup: pref.visibility:"onDemand" overrides a limited bucket into meter-extras',
        /<div class="meter-extras">[\s\S]*ForcedOnDemand[\s\S]*<\/div>/.test(visHtml), visHtml);

  // --- renderMeterGroup: BucketPref.order sorts ahead of the pct-desc fallback (Phase 2c) ---
  const orderBuckets = [
    bucket({ id: 'low-pct', label: 'LowPct', used: 10, limit: 100 }),
    bucket({ id: 'high-pct', label: 'HighPct', used: 90, limit: 100 }),
    bucket({ id: 'ordered-last', label: 'OrderedLast', used: 50, limit: 100 }),
  ];
  const orderPrefs = { 'ordered-last': { order: 0 } };
  const orderHtml = sandbox.renderMeterGroup(orderBuckets, orderPrefs, { now });
  const orderPositions = ['OrderedLast', 'HighPct', 'LowPct'].map(label => orderHtml.indexOf(label));
  check('renderMeterGroup: a bucket with an explicit order renders first, ahead of the pct-desc buckets',
        orderPositions[0] < orderPositions[1] && orderPositions[1] < orderPositions[2],
        JSON.stringify(orderPositions));

  // --- renderMeterGroup: all-on-demand snapshot still shows label+value at a
  // glance (Gap B) -- Anthropic-admin/OpenAI-admin's real shape, where every
  // bucket is limit:null. Must NOT collapse to a bare "More metrics (N)"
  // count with nothing else visible.
  const allOnDemand = [
    bucket({ id: 'in', label: 'Input tokens', used: 1_200_000, limit: null, remaining: null, unit: 'tokens' }),
    bucket({ id: 'out', label: 'Output tokens', used: 300_000, limit: null, remaining: null, unit: 'tokens' }),
  ];
  const allOnDemandHtml = sandbox.renderMeterGroup(allOnDemand, undefined, { now });
  check('renderMeterGroup: all-on-demand -> both labels visible directly',
        allOnDemandHtml.includes('Input tokens') && allOnDemandHtml.includes('Output tokens'),
        allOnDemandHtml);
  check('renderMeterGroup: all-on-demand -> both formatted values visible directly',
        allOnDemandHtml.includes('1.2M') && allOnDemandHtml.includes('300k'),
        allOnDemandHtml);
  check('renderMeterGroup: all-on-demand -> no bare count-only "More metrics (N)" summary',
        !/More metrics \(\d+\)/.test(allOnDemandHtml), allOnDemandHtml);

  // --- renderTotalSpendCard (Phase 2b) --------------------------------------
  const spendConnectors = [
    { id: 'a', name: 'Connector A', vendor: 'V', description: '', enabledByDefault: true,
      hasDetector: false, hasQuota: true, configSchema: [] },
    { id: 'b', name: 'Connector B', vendor: 'V', description: '', enabledByDefault: true,
      hasDetector: false, hasQuota: true, configSchema: [] },
    { id: 'c', name: 'Connector C', vendor: 'V', description: '', enabledByDefault: true,
      hasDetector: false, hasQuota: true, configSchema: [] },
  ];

  // (a) No connector has spend[] at all -- the ONLY state reachable in
  // production today (no connector emits spend[] until Phase 4). Must render
  // nothing, not an empty shell.
  const noSpendSnapshots = {
    a: { ok: true, fetchedAt: now, buckets: [], displayMessages: [] },
    b: { ok: true, fetchedAt: now, buckets: [], displayMessages: [], spend: [] },
  };
  check('renderTotalSpendCard: empty string when no snapshot has spend[]',
        sandbox.renderTotalSpendCard(noSpendSnapshots, spendConnectors) === '',
        JSON.stringify(sandbox.renderTotalSpendCard(noSpendSnapshots, spendConnectors)));

  // (b) Aggregation across 2+ connectors, mixing measured and null costCents
  // for the same period -- null must be excluded from the sum, not coerced
  // to 0 (Phase 1's null-vs-zero convention).
  const mixedSnapshots = {
    a: { ok: true, fetchedAt: now, buckets: [], displayMessages: [],
         spend: [{ period: 'today', label: 'Today', costCents: 500, tokens: 100_000 }] },
    b: { ok: true, fetchedAt: now, buckets: [], displayMessages: [],
         spend: [{ period: 'today', label: 'Today', costCents: null, tokens: 50_000 }] },
    c: { ok: true, fetchedAt: now, buckets: [], displayMessages: [],
         spend: [{ period: 'today', label: 'Today', costCents: 250, tokens: null }] },
  };
  const agg = sandbox.aggregateSpendForPeriod(mixedSnapshots, spendConnectors, 'today');
  check('aggregateSpendForPeriod: sums measured costCents only, excludes null (500+250, not +0)',
        agg.totalCostCents === 750, agg.totalCostCents);
  check('aggregateSpendForPeriod: sums measured tokens only, excludes null (100000+50000, not +0)',
        agg.totalTokens === 150_000, agg.totalTokens);
  check('aggregateSpendForPeriod: byConnector has an entry per connector with any measured field',
        agg.byConnector.length === 3, JSON.stringify(agg.byConnector));
  const bEntry = agg.byConnector.find(e => e.id === 'b');
  check('aggregateSpendForPeriod: connector with costCents:null keeps null, not coerced to 0',
        !!bEntry && bEntry.costCents === null, JSON.stringify(bEntry));

  const cardHtml = sandbox.renderTotalSpendCard(mixedSnapshots, spendConnectors, { mode: 'cost', period: 'today' });
  check('renderTotalSpendCard: non-empty when at least one connector has spend[]',
        cardHtml.length > 0, cardHtml);
  check('renderTotalSpendCard: shows the aggregated cost headline ($7.50)',
        cardHtml.includes('$7.50'), cardHtml);
  // Connector b (costCents:null) is excluded from the cost-mode donut's arc
  // set -- pins the spec's "excluded from the sum AND the share breakdown"
  // requirement at the donut level, not just the aggregate level.
  check('renderTotalSpendCard: connectors with measured costCents produce a cost-mode donut arc',
        cardHtml.includes('data-spend-slice="a"') && cardHtml.includes('data-spend-slice="c"'), cardHtml);
  check('renderTotalSpendCard: connector with costCents:null produces no cost-mode donut arc',
        !cardHtml.includes('data-spend-slice="b"'), cardHtml);
  // Inspects the actual rendered output (not a re-derivation of the aggregate)
  // so this can catch a regression in the donut's own slice-selection logic.
  const costSliceIds = [...cardHtml.matchAll(/data-spend-slice="([^"]+)"/g)].map(m => m[1]);
  check('renderTotalSpendCard: cost-mode donut renders exactly the connectors with measured costCents',
        JSON.stringify(costSliceIds) === JSON.stringify(['a', 'c']), JSON.stringify(costSliceIds));

  // --- tokens mode --------------------------------------------------------
  const tokensCardHtml = sandbox.renderTotalSpendCard(mixedSnapshots, spendConnectors, { mode: 'tokens', period: 'today' });
  check('renderTotalSpendCard: tokens mode shows the aggregated token headline (150k)',
        tokensCardHtml.includes('150k'), tokensCardHtml);
  // Connector c has tokens:null for this period -- must be excluded from the
  // tokens-mode donut, mirroring connector b's exclusion in cost mode above.
  // This is the donutMetric === 'tokens' branch, otherwise untested.
  const tokensSliceIds = [...tokensCardHtml.matchAll(/data-spend-slice="([^"]+)"/g)].map(m => m[1]);
  check('renderTotalSpendCard: tokens-mode donut renders exactly the connectors with measured tokens',
        JSON.stringify(tokensSliceIds) === JSON.stringify(['a', 'b']), JSON.stringify(tokensSliceIds));

  // --- costPerMtok mode, incl. the divide-by-zero/null-tokens guard --------
  check("formatSpendHeadline('tokens', 750, 150000) formats via formatQuotaValue(tokens)",
        sandbox.formatSpendHeadline('tokens', 750, 150_000) === '150k',
        sandbox.formatSpendHeadline('tokens', 750, 150_000));
  check("formatSpendHeadline('tokens', 750, null) -> 'No data'",
        sandbox.formatSpendHeadline('tokens', 750, null) === 'No data');
  check("formatSpendHeadline('costPerMtok', 750, 150000) computes cents-per-MTok correctly ($50.00 / MTok)",
        sandbox.formatSpendHeadline('costPerMtok', 750, 150_000) === '$50.00 / MTok',
        sandbox.formatSpendHeadline('costPerMtok', 750, 150_000));
  check("formatSpendHeadline('costPerMtok', 500, null) -> 'No data' (null-tokens guard, no divide-by-zero)",
        sandbox.formatSpendHeadline('costPerMtok', 500, null) === 'No data');
  check("formatSpendHeadline('costPerMtok', 500, 0) -> 'No data' (zero-tokens guard, no divide-by-zero)",
        sandbox.formatSpendHeadline('costPerMtok', 500, 0) === 'No data');
  check("formatSpendHeadline('costPerMtok', null, 150000) -> 'No data' (null-cost guard)",
        sandbox.formatSpendHeadline('costPerMtok', null, 150_000) === 'No data');

  const costPerMtokHtml = sandbox.renderTotalSpendCard(mixedSnapshots, spendConnectors, { mode: 'costPerMtok', period: 'today' });
  check('renderTotalSpendCard: costPerMtok mode end-to-end shows the computed rate ($50.00 / MTok)',
        costPerMtokHtml.includes('$50.00 / MTok'), costPerMtokHtml);

  const costOnlySnapshots = {
    a: { ok: true, fetchedAt: now, buckets: [], displayMessages: [],
         spend: [{ period: 'today', label: 'Today', costCents: 500, tokens: null }] },
  };
  const costPerMtokGuardHtml = sandbox.renderTotalSpendCard(costOnlySnapshots, spendConnectors, { mode: 'costPerMtok', period: 'today' });
  check('renderTotalSpendCard: costPerMtok mode end-to-end shows "No data" when no connector has measured tokens',
        costPerMtokGuardHtml.includes('No data') && !/NaN|Infinity/.test(costPerMtokGuardHtml),
        costPerMtokGuardHtml);

  // (c) Minimum-arc-length + renormalization: a tiny-share slice must not
  // disappear, and the full arc set must still sum to a whole circle (1.0).
  const arcs = sandbox.computeDonutArcs([
    { id: 'big', value: 9990 },
    { id: 'tiny', value: 10 }, // natural share 0.1%, well under the 1.5% floor
  ]);
  const tinyArc = arcs.find(a => a.id === 'tiny');
  const bigArc = arcs.find(a => a.id === 'big');
  check('computeDonutArcs: tiny share boosted well above its natural 0.1% share',
        tinyArc.fraction > 0.01, tinyArc.fraction);
  check('computeDonutArcs: boosted fraction never exceeds the configured floor',
        tinyArc.fraction <= 0.015, tinyArc.fraction);
  check('computeDonutArcs: renormalized set still sums to 1 (full circle)',
        Math.abs(tinyArc.fraction + bigArc.fraction - 1) < 1e-9,
        tinyArc.fraction + bigArc.fraction);
  check('computeDonutArcs: dominant slice still dominant after renormalization',
        bigArc.fraction > 0.9, bigArc.fraction);

  // (d) Deterministic id-hash color fallback: same id -> same color across calls.
  const color1 = sandbox.connectorColor('anthropic');
  const color2 = sandbox.connectorColor('anthropic');
  check('connectorColor: same id yields the same fallback color across two calls',
        color1 === color2, `${color1} vs ${color2}`);
  check('connectorColor: fallback color is a well-formed hsl() string',
        /^hsl\(\d+, \d+%, \d+%\)$/.test(color1), color1);
  const brandOverride = sandbox.connectorColor('anthropic', '#ff0000');
  check('connectorColor: an explicit brandColor overrides the hash fallback',
        brandOverride === '#ff0000', brandOverride);
  // Malformed brandColor (e.g. a value carrying a stray '"') must fall back
  // to the hash-derived color instead of reaching the SVG stroke / CSS
  // custom-property sinks unescaped -- no shipping connector sets brandColor
  // yet, but Phase 5 connectors will.
  const malformedBrand = sandbox.connectorColor('anthropic', '"><script>alert(1)</script>');
  check('connectorColor: a malformed brandColor falls back to the hash-derived color, not verbatim',
        malformedBrand === color1, malformedBrand);
  check('connectorColor: the fallback for a malformed brandColor carries no raw quote/bracket chars',
        !/["<>]/.test(malformedBrand), malformedBrand);
}

// --------------------------------------------------------------------------
// Cursor quota.ts: dollarsToCents (Phase 3's flagged 100x conversion trap)
// --------------------------------------------------------------------------
function testConnectorHelpers() {
  console.log('cursor/quota.ts: dollarsToCents');
  check('dollarsToCents(4.08) === 408', dollarsToCents(4.08) === 408, dollarsToCents(4.08));
  check('dollarsToCents(0) === 0', dollarsToCents(0) === 0, dollarsToCents(0));
  check('dollarsToCents(19.999) rounds to 2000, not truncates to 1999',
        dollarsToCents(19.999) === 2000, dollarsToCents(19.999));
  check('dollarsToCents(-3.5) === -350 (credit/refund rows stay signed)',
        dollarsToCents(-3.5) === -350, dollarsToCents(-3.5));

  console.log('github-copilot/quota.ts: dollarsToCents (org billing, same trap, separate copy)');
  check('copilotDollarsToCents(12.5) === 1250', copilotDollarsToCents(12.5) === 1250, copilotDollarsToCents(12.5));

  console.log('openrouter/quota.ts: dollarsToCents');
  check('openrouterDollarsToCents(0) === 0', openrouterDollarsToCents(0) === 0, openrouterDollarsToCents(0));
  check('openrouterDollarsToCents(3.5) === 350', openrouterDollarsToCents(3.5) === 350, openrouterDollarsToCents(3.5));
  check('openrouterDollarsToCents(19.999) rounds to 2000, not truncates to 1999',
        openrouterDollarsToCents(19.999) === 2000, openrouterDollarsToCents(19.999));

  check("openrouterFirstFiniteNumber(''): empty string stays null, not a measured 0",
        openrouterFirstFiniteNumber('') === null, openrouterFirstFiniteNumber(''));
  check("openrouterFirstFiniteNumber('   '): whitespace-only string stays null",
        openrouterFirstFiniteNumber('   ') === null, openrouterFirstFiniteNumber('   '));
  check("openrouterFirstFiniteNumber('', 5): falls through an empty string to the next candidate",
        openrouterFirstFiniteNumber('', 5) === 5, openrouterFirstFiniteNumber('', 5));

  check("zaiFirstFiniteNumber(''): empty string stays null, not a measured 0",
        zaiFirstFiniteNumber('') === null, zaiFirstFiniteNumber(''));
}

// --------------------------------------------------------------------------
// zai/quota.ts: extractItems + parseQuotaItems (undocumented API shape --
// defensive parsing, tested against the plausible container/field-name
// variants the connector probes for).
// --------------------------------------------------------------------------
function testZaiQuotaParsing() {
  console.log('zai/quota.ts: extractItems + parseQuotaItems');

  check('extractItems: reads a top-level array under data',
        zaiExtractItems({ data: [{ a: 1 }] }).length === 1);
  check('extractItems: reads data.items',
        zaiExtractItems({ data: { items: [{ a: 1 }, { a: 2 }] } }).length === 2);
  check('extractItems: unrecognized shape returns an empty array, not a throw',
        Array.isArray(zaiExtractItems({ data: { unexpected: true } })) &&
        zaiExtractItems({ data: { unexpected: true } }).length === 0);
  check('extractItems: a null element in the array is filtered out, not passed through',
        (() => {
          const items = zaiExtractItems({ data: [{ a: 1 }, null, { b: 2 }] });
          return items.length === 2 && items.every(i => typeof i === 'object' && i !== null);
        })());
  check('extractItems: a non-object element (string/number) is filtered out too',
        zaiExtractItems({ data: [{ a: 1 }, 'oops', 42] }).length === 1);
  check('parseQuotaItems: does not throw when fed a null-containing extractItems() result upstream',
        (() => {
          try {
            zaiParseQuotaItems(zaiExtractItems({ data: [null, { type: 'session', used: 1, limit: 2, window_seconds: 18000 }] }));
            return true;
          } catch {
            return false;
          }
        })());

  check('parseQuotaItems([]): no session/weekly/webSearches -> drives the ok:false branch',
        (() => {
          const p = zaiParseQuotaItems([]);
          return !p.session && !p.weekly && !p.webSearches;
        })());

  check('parseQuotaItems: an item missing limit is skipped, not defaulted to {used, limit:0}',
        (() => {
          const p = zaiParseQuotaItems([{ type: 'session', used: 5, window_seconds: 18000 }]);
          return !p.session;
        })());

  check('parseQuotaItems: a sub-daily window (5h) classifies as session',
        (() => {
          const p = zaiParseQuotaItems([{ type: 'x', used: 3, limit: 10, window_seconds: 18000 }]);
          return !!p.session && !p.weekly && p.session.used === 3 && p.session.limit === 10;
        })());

  check('parseQuotaItems: a multi-day window (7d) classifies as weekly',
        (() => {
          const p = zaiParseQuotaItems([{ type: 'x', used: 3, limit: 10, window_seconds: 604800 }]);
          return !!p.weekly && !p.session;
        })());

  check('parseQuotaItems: web-search item captured as a plain count, no percent conversion',
        (() => {
          const p = zaiParseQuotaItems([{ type: 'web_search', used: 4, limit: 20 }]);
          return !!p.webSearches && p.webSearches.used === 4 && p.webSearches.limit === 20;
        })());

  check('parseQuotaItems: observed window length is preserved on the parsed bucket (for pace-safety)',
        (() => {
          const p = zaiParseQuotaItems([{ type: 'x', used: 1, limit: 4, window_seconds: 18000, reset_at: 1700000000000 }]);
          return p.session && p.session.windowMs === 18000000 && p.session.resetsAt === 1700000000000;
        })());

  console.log('zai/quota.ts: resolveWindowPairing (resetsAt must never pair with a synthesized windowMs)');
  check('resolveWindowPairing: both observed -> real windowMs + real resetsAt',
        (() => {
          const r = zaiResolveWindowPairing(18000000, 1700000000000, 604800000);
          return r.windowMs === 18000000 && r.resetsAt === 1700000000000;
        })());
  check('resolveWindowPairing: resetsAt observed but windowMs NOT observed -> resetsAt omitted, fallback windowMs used',
        (() => {
          const r = zaiResolveWindowPairing(null, 1700000000000, 604800000);
          return r.windowMs === 604800000 && r.resetsAt === undefined;
        })());
  check('resolveWindowPairing: windowMs observed but resetsAt NOT observed -> resetsAt omitted, but the real observed windowMs is still kept (safe: pace math needs both fields to activate)',
        (() => {
          const r = zaiResolveWindowPairing(18000000, null, 604800000);
          return r.windowMs === 18000000 && r.resetsAt === undefined;
        })());
  check('resolveWindowPairing: neither observed -> fallback windowMs, no resetsAt',
        (() => {
          const r = zaiResolveWindowPairing(null, null, 604800000);
          return r.windowMs === 604800000 && r.resetsAt === undefined;
        })());
}

// --------------------------------------------------------------------------
// codex-cli/quota.ts: atomicWriteFile (correction round item 1, CRITICAL)
// --------------------------------------------------------------------------
function testCodexAtomicWrite() {
  console.log('codex-cli/quota.ts: atomicWriteFile');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-smoke-codex-'));
  const target = path.join(tmp, 'auth.json');
  fs.writeFileSync(target, '{"orig":true}');

  const ok = atomicWriteFile(target, '{"next":true}');
  check('atomicWriteFile: returns true on success', ok === true);
  check('atomicWriteFile: target now has the new content',
        fs.readFileSync(target, 'utf8') === '{"next":true}');
  const leftovers = fs.readdirSync(tmp).filter(f => f !== 'auth.json');
  check('atomicWriteFile: no leftover temp file after a successful write',
        leftovers.length === 0, JSON.stringify(leftovers));

  // POSIX-only: Windows NTFS doesn't map owner/group/other permission bits,
  // so fs.chmodSync there is a near no-op (only toggles read-only).
  if (process.platform !== 'win32') {
    const modeTarget = path.join(tmp, 'mode-auth.json');
    fs.writeFileSync(modeTarget, '{"orig":true}');
    fs.chmodSync(modeTarget, 0o600);
    atomicWriteFile(modeTarget, '{"next":true}');
    const modeAfter = fs.statSync(modeTarget).mode & 0o777;
    check('atomicWriteFile: preserves the original file\'s permission mode (0600) across a refresh',
          modeAfter === 0o600, modeAfter.toString(8));
  }

  const badTarget = path.join(tmp, 'missing-dir', 'auth.json');
  const failed = atomicWriteFile(badTarget, '{}');
  check('atomicWriteFile: returns false (not throws) when the target directory does not exist', failed === false);
  check('atomicWriteFile: an unrelated failed write leaves the original file untouched',
        fs.readFileSync(target, 'utf8') === '{"next":true}');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// --------------------------------------------------------------------------
// codex-cli/quota.ts: Spark bucket id stability + dedup (correction item 6)
// --------------------------------------------------------------------------
function testCodexSparkBuckets() {
  console.log('codex-cli/quota.ts: slugifyModel + buildSparkBuckets');
  check("slugifyModel(' GPT-5 ') === 'gpt-5'", slugifyModel(' GPT-5 ') === 'gpt-5');
  check("slugifyModel('GPT 5  Codex') collapses whitespace -> 'gpt-5-codex'",
        slugifyModel('GPT 5  Codex') === 'gpt-5-codex', slugifyModel('GPT 5  Codex'));
  check('slugifyModel is case/whitespace-insensitive across two spellings of the same model',
        slugifyModel('gpt-5') === slugifyModel(' GPT-5 '));

  const window = { used_percent: 42 };
  const arrayShape = [{ model: 'GPT-5', ...window }];
  const objectShape = { ' gpt-5 ': window };
  const arrayBuckets = buildSparkBuckets(arrayShape);
  const objectBuckets = buildSparkBuckets(objectShape);
  check('buildSparkBuckets: array shape and object shape yield the same bucket id for the same model',
        arrayBuckets[0].id === objectBuckets[0].id, `${arrayBuckets[0].id} vs ${objectBuckets[0].id}`);

  const dupeShape = [{ model: 'GPT-5', ...window }, { model: ' gpt-5 ', used_percent: 77 }];
  const dupeBuckets = buildSparkBuckets(dupeShape);
  check('buildSparkBuckets: two entries normalizing to the same slug produce exactly one bucket',
        dupeBuckets.length === 1, dupeBuckets.length);
  check('buildSparkBuckets: bucket id is namespaced (spark-<slug>), not a bare model name',
        dupeBuckets[0].id === 'spark-gpt-5', dupeBuckets[0].id);
}

// --------------------------------------------------------------------------
// cursor/quota.ts: buildSpendTiles null-vs-zero contract (correction item 5)
// --------------------------------------------------------------------------
function testCursorSpendTiles() {
  console.log('cursor/quota.ts: buildSpendTiles null-vs-zero');
  function localDayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  const now = Date.now();
  const todayKey = localDayKey(now);
  // Only "today" has a measured CSV row -- every other day in the 30-day
  // window genuinely has zero rows and must render as null, not 0.
  const perDayCents = new Map([[todayKey, 500]]);
  const perDayTokens = new Map([[todayKey, 1000]]);

  const tiles = buildSpendTiles(perDayCents, perDayTokens, true, now);
  const today = tiles.find(t => t.period === 'today');
  const yesterday = tiles.find(t => t.period === 'yesterday');
  const last30d = tiles.find(t => t.period === 'last30d');

  check('buildSpendTiles: measured today keeps its real costCents (500), not coerced', today.costCents === 500);
  check('buildSpendTiles: unmeasured yesterday is costCents:null, not 0', yesterday.costCents === null);
  check('buildSpendTiles: unmeasured yesterday is tokens:null, not 0', yesterday.tokens === null);
  check('buildSpendTiles: last30d sum only includes the one measured day (500)', last30d.costCents === 500);
  check('buildSpendTiles: 30-day series has null for every unmeasured day (29 of 30), not 0',
        last30d.series.filter(v => v === null).length === 29, JSON.stringify(last30d.series));

  const emptyTiles = buildSpendTiles(new Map(), new Map(), false, now);
  check('buildSpendTiles: zero measured days anywhere -> last30d.costCents is null, not 0',
        emptyTiles.find(t => t.period === 'last30d').costCents === null);
  check('buildSpendTiles: hasTokensColumn:false -> tokens is always null, never a fabricated 0',
        emptyTiles.every(t => t.tokens === null));
}

// --------------------------------------------------------------------------
// opencode/quota.ts: data dir resolution, db filename matching, spend record
// aggregation, session/weekly/monthly cap buckets, and spend tiles.
// --------------------------------------------------------------------------
function testOpencodeQuota() {
  console.log('opencode/quota.ts: dollarsToCents');
  check('opencodeDollarsToCents(0) === 0', opencodeDollarsToCents(0) === 0, opencodeDollarsToCents(0));
  check('opencodeDollarsToCents(4.5) === 450', opencodeDollarsToCents(4.5) === 450, opencodeDollarsToCents(4.5));
  check('opencodeDollarsToCents(19.999) rounds to 2000, not truncates to 1999',
        opencodeDollarsToCents(19.999) === 2000, opencodeDollarsToCents(19.999));

  console.log('opencode/quota.ts: isOpencodeDbFilename');
  check('isOpencodeDbFilename("opencode.db") === true', isOpencodeDbFilename('opencode.db') === true);
  check('isOpencodeDbFilename("opencode-preview.db") === true (release channel glob)',
        isOpencodeDbFilename('opencode-preview.db') === true);
  check('isOpencodeDbFilename("opencode.db-wal") === false (WAL sidecar excluded)',
        isOpencodeDbFilename('opencode.db-wal') === false);
  check('isOpencodeDbFilename("opencode.db-shm") === false (SHM sidecar excluded)',
        isOpencodeDbFilename('opencode.db-shm') === false);
  check('isOpencodeDbFilename("other.db") === false', isOpencodeDbFilename('other.db') === false);

  console.log('opencode/quota.ts: resolveDataDirs (env var priority + dedup)');
  const ctx = makeCtx([], { resolvePath: p => p.replace('~', '/home/test') });
  const prevDataDir = process.env.OPENCODE_DATA_DIR;
  const prevXdg = process.env.XDG_DATA_HOME;
  try {
    delete process.env.OPENCODE_DATA_DIR;
    delete process.env.XDG_DATA_HOME;
    const defaults = opencodeResolveDataDirs({}, ctx);
    check('resolveDataDirs: falls back to defaultOpencodeDataDirs() when unconfigured',
          defaults.length === defaultOpencodeDataDirs().length, JSON.stringify(defaults));

    process.env.OPENCODE_DATA_DIR = '/custom/opencode-data';
    process.env.XDG_DATA_HOME = '/xdg/data';
    const withEnv = opencodeResolveDataDirs({}, ctx);
    check('resolveDataDirs: $OPENCODE_DATA_DIR comes first',
          withEnv[0] === require('path').resolve('/custom/opencode-data'), JSON.stringify(withEnv));
    check('resolveDataDirs: $XDG_DATA_HOME/opencode comes second',
          withEnv[1] === require('path').resolve('/xdg/data/opencode'), JSON.stringify(withEnv));

    const dup = opencodeResolveDataDirs({ dataDirs: ['/custom/opencode-data', '/another'] }, ctx);
    check('resolveDataDirs: dedupes a configured path that matches $OPENCODE_DATA_DIR',
          dup.filter(d => d === require('path').resolve('/custom/opencode-data')).length === 1,
          JSON.stringify(dup));
  } finally {
    if (prevDataDir === undefined) delete process.env.OPENCODE_DATA_DIR; else process.env.OPENCODE_DATA_DIR = prevDataDir;
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = prevXdg;
  }

  console.log('opencode/quota.ts: extractAuthLabel (best-effort, unverified shape)');
  check('extractAuthLabel: picks a recognised "plan" field',
        opencodeExtractAuthLabel({ plan: 'pro' }) === 'pro');
  check('extractAuthLabel: unrecognised shape returns null, never a fabricated label',
        opencodeExtractAuthLabel({ foo: 'bar' }) === null);
  check('extractAuthLabel: non-object input returns null', opencodeExtractAuthLabel(null) === null);

  console.log('opencode/quota.ts: toSpendRecords (session-level cost/tokens, null-vs-zero)');
  const nowTs = Date.now();
  const recordsFromRows = opencodeToSpendRecords([
    { timeCreated: nowTs, timeUpdated: nowTs, costDollars: 0.5, inputTokens: 100, outputTokens: 50,
      reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, model: 'opencode/claude-sonnet-4-6' },
    { timeCreated: nowTs, timeUpdated: NaN, costDollars: 1.25, inputTokens: 10, outputTokens: 10,
      reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, model: null },
  ]);
  check('toSpendRecords: converts session.cost dollars to cents', recordsFromRows[0].costCents === 50,
        recordsFromRows[0].costCents);
  check('toSpendRecords: prefers time_updated over time_created when finite',
        recordsFromRows[0].ts === nowTs);
  check('toSpendRecords: falls back to time_created when time_updated is not finite',
        recordsFromRows[1].ts === nowTs);
  check('toSpendRecords: sums input+output+reasoning+cache tokens',
        recordsFromRows[0].tokens === 150, recordsFromRows[0].tokens);

  const fallbackRecords = opencodeToSpendRecords([
    { timeCreated: nowTs, timeUpdated: nowTs, costDollars: null, inputTokens: 1_000_000, outputTokens: 1_000_000,
      reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, model: 'sonnet' },
    { timeCreated: nowTs, timeUpdated: nowTs, costDollars: null, inputTokens: 100, outputTokens: 0,
      reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, model: null },
  ]);
  check('toSpendRecords: falls back to costCentsFor when db cost is genuinely missing and model is known',
        fallbackRecords[0].costCents === costCentsFor('sonnet', { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
        fallbackRecords[0].costCents);
  check('toSpendRecords: missing cost AND unknown model -> costCents:null, never a fabricated 0',
        fallbackRecords[1].costCents === null);

  console.log('opencode/quota.ts: toSpendRecords (WARNING fix -- cost:0 + real tokens re-estimates)');
  const suspiciousZeroRecords = opencodeToSpendRecords([
    // cost:0 with real input/output tokens is suspicious -> re-estimate via costCentsFor.
    { timeCreated: nowTs, timeUpdated: nowTs, costDollars: 0, inputTokens: 1_000_000, outputTokens: 1_000_000,
      reasoningTokens: 200_000, cacheReadTokens: 0, cacheWriteTokens: 0, model: 'sonnet' },
    // cost:0 with NO token usage at all is a genuinely-free/idle session -> trust the reported 0.
    { timeCreated: nowTs, timeUpdated: nowTs, costDollars: 0, inputTokens: 0, outputTokens: 0,
      reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, model: 'sonnet' },
  ]);
  const expectedWithReasoning = costCentsFor('sonnet',
    { inputTokens: 1_000_000, outputTokens: 1_000_000, reasoningTokens: 200_000 });
  check('toSpendRecords: cost:0 + real tokens re-estimates instead of trusting a suspicious $0',
        suspiciousZeroRecords[0].costCents === expectedWithReasoning, suspiciousZeroRecords[0].costCents);
  check('toSpendRecords: reasoningTokens are included in the re-estimate (WARNING item 3)',
        expectedWithReasoning > costCentsFor('sonnet', { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
        expectedWithReasoning);
  check('toSpendRecords: cost:0 with zero tokens is trusted as a genuine $0, not re-estimated',
        suspiciousZeroRecords[1].costCents === 0, suspiciousZeroRecords[1].costCents);

  console.log('shared/model-pricing.ts: costCentsFor bills reasoningTokens like output tokens (WARNING item 3)');
  const withoutReasoning = costCentsFor('sonnet', { inputTokens: 0, outputTokens: 0 });
  const onlyReasoning = costCentsFor('sonnet', { inputTokens: 0, outputTokens: 0, reasoningTokens: 1_000_000 });
  check('costCentsFor: reasoningTokens alone produce a non-zero, non-null cost',
        onlyReasoning !== null && onlyReasoning > (withoutReasoning ?? 0), onlyReasoning);

  console.log('opencode/quota.ts: noUsableSessionData (CRITICAL fix predicate)');
  check('noUsableSessionData: zero db files found -> true', noUsableSessionData(0, 0) === true);
  check('noUsableSessionData: db files found but zero readable -> true', noUsableSessionData(2, 0) === true);
  check('noUsableSessionData: at least one db successfully read -> false', noUsableSessionData(2, 1) === false);

  console.log('opencode/quota.ts: buildCapBuckets (session/weekly/monthly, UTC-anchored)');
  const buckets = opencodeBuildCapBuckets([{ ts: nowTs, costCents: 500, tokens: 100 }], nowTs);
  const session = buckets.find(b => b.id === 'session');
  const weekly = buckets.find(b => b.id === 'weekly');
  const monthly = buckets.find(b => b.id === 'monthly');
  check('buildCapBuckets: session cap is $12 (1200 cents)', session.limit === 1200, session.limit);
  check('buildCapBuckets: weekly cap is $30 (3000 cents)', weekly.limit === 3000, weekly.limit);
  check('buildCapBuckets: monthly cap is $60 (6000 cents)', monthly.limit === 6000, monthly.limit);
  check('buildCapBuckets: a session right now counts toward all three windows',
        session.used === 500 && weekly.used === 500 && monthly.used === 500,
        JSON.stringify({ session: session.used, weekly: weekly.used, monthly: monthly.used }));
  check('buildCapBuckets: session bucket has no resetsAt (rolling look-back, no discrete reset)',
        session.resetsAt === undefined);
  check('buildCapBuckets: weekly bucket has a real resetsAt (UTC calendar boundary)',
        typeof weekly.resetsAt === 'number' && weekly.resetsAt > nowTs);
  check('buildCapBuckets: monthly bucket has a real resetsAt (UTC calendar boundary)',
        typeof monthly.resetsAt === 'number' && monthly.resetsAt > nowTs);

  const staleTs = nowTs - 30 * 24 * 3_600_000; // a month ago -- outside every window
  const staleBuckets = opencodeBuildCapBuckets([{ ts: staleTs, costCents: 500, tokens: 100 }], nowTs);
  check('buildCapBuckets: a session outside every window contributes 0, not the stale cost',
        staleBuckets.every(b => b.used === 0), JSON.stringify(staleBuckets.map(b => b.used)));

  check('buildCapBuckets: a record with costCents:null contributes nothing (never coerced to 0-cost spend)',
        opencodeBuildCapBuckets([{ ts: nowTs, costCents: null, tokens: 100 }], nowTs)
          .every(b => b.used === 0));

  console.log('opencode/quota.ts: buildSpendTiles (Today/Yesterday/Last30d, null-vs-zero)');
  const tiles = opencodeBuildSpendTiles([{ ts: nowTs, costCents: 250, tokens: 500 }], nowTs);
  const today = tiles.find(t => t.period === 'today');
  const yesterday = tiles.find(t => t.period === 'yesterday');
  const last30d = tiles.find(t => t.period === 'last30d');
  check('buildSpendTiles: today has the measured cost', today.costCents === 250, today.costCents);
  check('buildSpendTiles: yesterday has zero sessions -> costCents:null, not 0', yesterday.costCents === null);
  check('buildSpendTiles: yesterday has zero sessions -> tokens:null, not 0', yesterday.tokens === null);
  check('buildSpendTiles: last30d sums the one measured day', last30d.costCents === 250, last30d.costCents);
  check('buildSpendTiles: 30-day series has null for every unmeasured day (29 of 30)',
        last30d.series.filter(v => v === null).length === 29, JSON.stringify(last30d.series));

  const emptyOpencodeTiles = opencodeBuildSpendTiles([], nowTs);
  check('buildSpendTiles: no sessions at all -> every tile is null, never a fabricated 0',
        emptyOpencodeTiles.every(t => t.costCents === null && t.tokens === null));
}

// --------------------------------------------------------------------------
// opencode/quota.ts: fetch() end-to-end -- CRITICAL fix. "no .db found" and
// "every .db read failed" must return ok:false, never a fabricated used:0;
// a real db with a genuinely empty session table must still return ok:true.
// --------------------------------------------------------------------------
async function testOpencodeUnavailableStates() {
  console.log('opencode/quota.ts: fetch() -- no data vs. confirmed zero (CRITICAL fix)');
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-smoke-'));
  const ctxFor = () => makeCtx([], { resolvePath: p => p });

  const emptyDir = path.join(tmpRoot, 'empty');
  fs.mkdirSync(emptyDir);
  const snapNoDb = await createOpencodeQuotaProvider({ dataDirs: [emptyDir] }, ctxFor()).fetch();
  check('fetch(): no opencode*.db file found -> ok:false, not a fabricated zero', snapNoDb.ok === false,
        JSON.stringify(snapNoDb));

  const brokenDir = path.join(tmpRoot, 'broken');
  fs.mkdirSync(brokenDir);
  const brokenDb = new SQL.Database();
  brokenDb.run('CREATE TABLE unrelated (id TEXT)'); // no `session` table at all
  fs.writeFileSync(path.join(brokenDir, 'opencode.db'), Buffer.from(brokenDb.export()));
  brokenDb.close();
  const snapBroken = await createOpencodeQuotaProvider({ dataDirs: [brokenDir] }, ctxFor()).fetch();
  check('fetch(): a .db exists but every session-table read fails -> ok:false, not a fabricated zero',
        snapBroken.ok === false, JSON.stringify(snapBroken));

  const validDir = path.join(tmpRoot, 'valid');
  fs.mkdirSync(validDir);
  const validDb = new SQL.Database();
  validDb.run(
    'CREATE TABLE session (id TEXT, time_created INTEGER, time_updated INTEGER, cost REAL DEFAULT 0 NOT NULL, ' +
      'tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0, tokens_reasoning INTEGER DEFAULT 0, ' +
      'tokens_cache_read INTEGER DEFAULT 0, tokens_cache_write INTEGER DEFAULT 0, model TEXT)',
  );
  fs.writeFileSync(path.join(validDir, 'opencode.db'), Buffer.from(validDb.export()));
  validDb.close();
  const snapValid = await createOpencodeQuotaProvider({ dataDirs: [validDir] }, ctxFor()).fetch();
  check('fetch(): a readable .db with a genuinely empty session table -> ok:true with measured used:0',
        snapValid.ok === true && snapValid.buckets.every(b => b.used === 0), JSON.stringify(snapValid));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

// --------------------------------------------------------------------------
// model-pricing.js: rateFor/costCentsFor -- unknown model -> null (never 0),
// and the long-context/fast-tier multiplier math (correction item, Phase 4)
// --------------------------------------------------------------------------
function testModelPricing() {
  console.log('shared/model-pricing.js: rateFor + costCentsFor');

  check('rateFor: unknown model -> null', rateFor('totally-unknown-model-xyz') === null);
  check('rateFor: recognises a Sonnet-tier model by substring', rateFor('claude-sonnet-5') !== null);
  check('rateFor: recognises an Opus-tier model by substring', rateFor('claude-opus-5') !== null);
  check('rateFor: recognises a bare tier name', rateFor('opus') !== null);
  check('rateFor: more specific key wins over a shorter general one',
        rateFor('gpt-5-mini-2025-01-01').inputPerMTokUsd === rateFor('gpt-5-mini').inputPerMTokUsd &&
        rateFor('gpt-5-mini').inputPerMTokUsd !== rateFor('gpt-5').inputPerMTokUsd);
  check('rateFor: grok-4-fast does not collide with grok-4 (distinct rates)',
        rateFor('grok-4-fast').inputPerMTokUsd !== rateFor('grok-4').inputPerMTokUsd &&
        rateFor('grok-4-fast-2025-01-01').inputPerMTokUsd === rateFor('grok-4-fast').inputPerMTokUsd);
  check('rateFor: grok-3-mini does not collide with grok-3 (distinct rates)',
        rateFor('grok-3-mini').inputPerMTokUsd !== rateFor('grok-3').inputPerMTokUsd &&
        rateFor('grok-3-mini-2025-01-01').inputPerMTokUsd === rateFor('grok-3-mini').inputPerMTokUsd);

  check('costCentsFor: unknown model returns null, never 0',
        costCentsFor('some-unpriced-model', { inputTokens: 1000, outputTokens: 1000 }) === null);

  // Deterministic example: Sonnet-tier, 1M input + 1M output tokens, no cache.
  // inputPerMTokUsd=3, outputPerMTokUsd=15 -> $18.00 -> 1800 cents.
  const sonnetCost = costCentsFor('claude-sonnet-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  check('costCentsFor: known model computes the expected cents ($3+$15 per MTok -> 1800)',
        sonnetCost === 1800, sonnetCost);

  check('costCentsFor: zero tokens on a known model is a measured zero (0), not null',
        costCentsFor('claude-sonnet-5', { inputTokens: 0, outputTokens: 0 }) === 0);

  // Long-context multiplier: gpt-5-codex has longContextThresholdTokens=272_000,
  // longContextMultiplier=2. 300k input tokens (over the threshold) must cost
  // exactly double a request just under it.
  const underThreshold = costCentsFor('gpt-5-codex', { inputTokens: 270_000, outputTokens: 0 });
  const overThreshold = costCentsFor('gpt-5-codex', { inputTokens: 300_000, outputTokens: 0 });
  const expectedUnder = Math.round((270_000 / 1_000_000) * 1.25 * 100);
  const expectedOver = Math.round((300_000 / 1_000_000) * 1.25 * 2 * 100);
  check('costCentsFor: under the long-context threshold uses the base rate',
        underThreshold === expectedUnder, `${underThreshold} vs ${expectedUnder}`);
  check('costCentsFor: over the long-context threshold doubles the rate (longContextMultiplier)',
        overThreshold === expectedOver, `${overThreshold} vs ${expectedOver}`);
  check('costCentsFor: crossing the long-context threshold strictly increases cost per input token',
        overThreshold / 300_000 > underThreshold / 270_000);

  // Fast-tier multiplier: gpt-5-codex has fastTierMultiplier=1.5. Expected
  // values computed directly from the rate (not by re-rounding an already
  // rounded normal-tier result, which would drift from independent rounding).
  const normalTier = costCentsFor('gpt-5-codex', { inputTokens: 100_000, outputTokens: 0, fastTier: false });
  const fastTier = costCentsFor('gpt-5-codex', { inputTokens: 100_000, outputTokens: 0, fastTier: true });
  const expectedNormal = Math.round((100_000 / 1_000_000) * 1.25 * 100);
  const expectedFast = Math.round((100_000 / 1_000_000) * 1.25 * 1.5 * 100);
  check('costCentsFor: fastTier:true applies fastTierMultiplier (1.5x)',
        fastTier === expectedFast, `${fastTier} vs ${expectedFast}`);
  check('costCentsFor: fastTier:false matches the base (unmultiplied) rate',
        normalTier === expectedNormal, `${normalTier} vs ${expectedNormal}`);
  check('costCentsFor: fastTier omitted defaults to the normal (non-multiplied) rate',
        costCentsFor('gpt-5-codex', { inputTokens: 100_000, outputTokens: 0 }) === normalTier);
}

// --------------------------------------------------------------------------
// jsonl-spend-scanner.js: cache short-circuiting, per-day rollup correctness,
// and null-vs-zero for a period with zero matching records (Phase 4)
// --------------------------------------------------------------------------
async function testSpendScanner() {
  console.log('shared/jsonl-spend-scanner.js: scan/aggregate/cache');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-smoke-spend-'));
  const cacheDir = path.join(tmp, 'cache');
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const now = Date.now();
  const today = new Date(now);
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, '0');
  const d = String(today.getDate()).padStart(2, '0');
  const todayIso = `${y}-${m}-${d}T12:00:00.000Z`;

  const file1 = path.join(dataDir, 'session1.jsonl');
  const file2 = path.join(dataDir, 'session2.jsonl');
  fs.writeFileSync(
    file1,
    [
      JSON.stringify({ ts: todayIso, cost: 100, model: 'priced-model-a' }),
      JSON.stringify({ ts: todayIso, cost: 50, model: 'priced-model-a' }),
      'not valid json {{{',
      JSON.stringify({ ts: todayIso, cost: null, model: 'unpriced-model' }),
    ].join('\n') + '\n',
  );
  fs.writeFileSync(file2, JSON.stringify({ ts: todayIso, cost: 25, model: 'priced-model-a' }) + '\n');

  let extractCalls = 0;
  const extract = line => {
    extractCalls++;
    if (!line || typeof line.ts !== 'string') return null;
    const ts = Date.parse(line.ts);
    if (!Number.isFinite(ts)) return null;
    return {
      ts,
      costCents: line.cost == null ? null : line.cost,
      inputTokens: 10,
      outputTokens: 5,
      model: line.model,
    };
  };

  const scanner = JsonlSpendScanner.shared(cacheDir);
  const patterns = [path.join(dataDir, '*.jsonl')];

  const firstRecords = await scanner.scan({ key: 'smoke-test', patterns, extract });
  const callsAfterFirstScan = extractCalls;
  check('scan: extract() is called for every successfully-parsed line across both files (3 in file1 + 1 in file2; the malformed line never reaches extract())',
        callsAfterFirstScan === 4, callsAfterFirstScan);
  check('scan: malformed JSON line is skipped, not thrown',
        firstRecords.length > 0, JSON.stringify(firstRecords));

  const firstTiles = scanner.aggregate(firstRecords, now);
  const todayTile = firstTiles.find(t => t.period === 'today');
  // file1: 100 + 50 (unpriced-model's null is excluded, not coerced to 0) = 150
  // file2: 25 -> total 175
  check('aggregate: today sums measured costCents across files, excluding null (150+25=175, not +0)',
        todayTile.costCents === 175, todayTile.costCents);
  check('aggregate: today has real token counts (4 records x 15 tokens = 60)',
        todayTile.tokens === 60, todayTile.tokens);
  const yesterdayTile = firstTiles.find(t => t.period === 'yesterday');
  check('aggregate: a period with zero matching records is costCents:null, not 0',
        yesterdayTile.costCents === null, yesterdayTile.costCents);
  check('aggregate: a period with zero matching records is tokens:null, not 0',
        yesterdayTile.tokens === null, yesterdayTile.tokens);
  const last30dTile = firstTiles.find(t => t.period === 'last30d');
  check('aggregate: last30d.series has exactly 30 entries',
        last30dTile.series.length === 30, last30dTile.series.length);
  check('aggregate: last30d.series has non-null only on the one day with data',
        last30dTile.series.filter(v => v !== null).length === 1, JSON.stringify(last30dTile.series));

  // Re-scan the same unchanged files on the same shared instance -- must hit
  // the in-memory cache and not call extract() again at all.
  const secondRecords = await scanner.scan({ key: 'smoke-test', patterns, extract });
  check('scan: re-scanning unchanged files does not call extract() again (cache short-circuit)',
        extractCalls === callsAfterFirstScan, `${extractCalls} vs ${callsAfterFirstScan}`);
  check('scan: cached re-scan still returns the same records',
        JSON.stringify(secondRecords.map(r => [r.costCents, r.inputTokens]).sort()) ===
        JSON.stringify(firstRecords.map(r => [r.costCents, r.inputTokens]).sort()));

  // Modifying a file (new size/mtime) must invalidate just that file's cache
  // entry and re-parse it, without needing a second scanner instance.
  fs.appendFileSync(file2, JSON.stringify({ ts: todayIso, cost: 10, model: 'priced-model-a' }) + '\n');
  await sleep(20);
  fs.utimesSync(file2, new Date(), new Date());
  const thirdRecords = await scanner.scan({ key: 'smoke-test', patterns, extract });
  // Correction item 4: an appended (not rewritten) file must be re-parsed
  // INCREMENTALLY -- only the one new line, not the whole file from byte 0.
  check('scan: an appended file is re-parsed incrementally (extract() called exactly once more, for the ONE new line -- not the whole file again)',
        extractCalls === callsAfterFirstScan + 1, `${extractCalls} vs ${callsAfterFirstScan + 1}`);
  const thirdTiles = scanner.aggregate(thirdRecords, now);
  const thirdToday = thirdTiles.find(t => t.period === 'today');
  check('scan: the changed file\'s new total is reflected (175+10=185)',
        thirdToday.costCents === 185, thirdToday.costCents);

  // A different `key` namespace scanning the SAME files must not collide
  // with 'smoke-test's cache entries -- proves multi-connector sharing of
  // one cache root (`shared()`) is safe. Fresh key -> full parse: 3 valid
  // lines in file1 + 2 valid lines in file2 (now including the appended one).
  let otherKeyCalls = 0;
  const otherExtract = line => { otherKeyCalls++; return extract(line); };
  await scanner.scan({ key: 'other-connector', patterns, extract: otherExtract });
  check('scan: a different key namespace re-parses independently (no cross-key cache hit)',
        otherKeyCalls === 5, otherKeyCalls);

  // Correction item 5: a file that stops matching the glob (deleted) must
  // have its cache entry pruned, not left permanently resident. `cache` is
  // a plain (TS-`private`, JS-visible) Map property on the compiled class.
  const file3 = path.join(dataDir, 'session3.jsonl');
  fs.writeFileSync(file3, JSON.stringify({ ts: todayIso, cost: 5, model: 'priced-model-a' }) + '\n');
  await scanner.scan({ key: 'smoke-test', patterns, extract });
  const file3CacheKey = `smoke-test|${path.resolve(file3)}`;
  check('scan: a newly-matching file gets a cache entry', scanner.cache.has(file3CacheKey));
  fs.rmSync(file3);
  await scanner.scan({ key: 'smoke-test', patterns, extract });
  check('scan: a deleted file\'s cache entry is pruned once it no longer matches the glob',
        !scanner.cache.has(file3CacheKey));

  fs.rmSync(tmp, { recursive: true, force: true });

  // Correction item 6: DST-safe calendar-day arithmetic in aggregate()'s
  // day-bucket loops (series/last30d/yesterday) -- records on three
  // adjacent-but-distinct calendar days must land in three distinct,
  // correctly-ordered series slots, not collapse or alias into each other.
  const dstNow = new Date(now);
  const dayMs = (daysAgo) => new Date(dstNow.getFullYear(), dstNow.getMonth(), dstNow.getDate() - daysAgo, 12).getTime();
  const dstRecords = [
    { ts: dayMs(0), costCents: 10, inputTokens: 1, outputTokens: 0 },
    { ts: dayMs(1), costCents: 20, inputTokens: 1, outputTokens: 0 },
    { ts: dayMs(2), costCents: 30, inputTokens: 1, outputTokens: 0 },
  ];
  const dstTiles = scanner.aggregate(dstRecords, now);
  const dstSeries = dstTiles.find(t => t.period === 'last30d').series;
  check('aggregate: three adjacent calendar days land in three distinct, correctly-ordered series slots (not collapsed by fixed-ms arithmetic)',
        dstSeries[29] === 10 && dstSeries[28] === 20 && dstSeries[27] === 30,
        JSON.stringify(dstSeries.slice(-3)));
  check('aggregate: yesterday tile uses the same calendar-day arithmetic as the series (20)',
        dstTiles.find(t => t.period === 'yesterday').costCents === 20);
}

// --------------------------------------------------------------------------
// claude-code/quota.ts + codex-cli/quota.ts: extract() field-shape parsers
// --------------------------------------------------------------------------
function testConnectorSpendExtractors() {
  console.log('claude-code/quota.js + codex-cli/quota.js: spend extract()');

  // Verified against a real local Claude Code transcript line during Phase 4
  // implementation (type:'assistant', message.model, message.usage.*).
  const claudeLine = {
    type: 'assistant',
    timestamp: '2026-08-05T19:06:37.193Z',
    message: {
      model: 'claude-sonnet-5',
      usage: { input_tokens: 2, output_tokens: 1563, cache_creation_input_tokens: 60_114, cache_read_input_tokens: 0 },
    },
  };
  const claudeRecord = extractClaudeCodeSpend(claudeLine);
  check('extractClaudeCodeSpend: parses a real assistant/usage line',
        !!claudeRecord && claudeRecord.inputTokens === 2 && claudeRecord.outputTokens === 1563,
        JSON.stringify(claudeRecord));
  check('extractClaudeCodeSpend: computes a non-null cost for a known model',
        claudeRecord.costCents !== null, claudeRecord.costCents);
  check('extractClaudeCodeSpend: non-assistant lines return null',
        extractClaudeCodeSpend({ type: 'user' }) === null);
  check('extractClaudeCodeSpend: assistant line without usage returns null',
        extractClaudeCodeSpend({ type: 'assistant', message: { model: 'claude-sonnet-5' } }) === null);

  // Correction item 3: Infinity in a usage field must never reach
  // costCentsFor/render as "$Infinity" -- rejected at extraction, not just
  // downstream.
  const infinityLine = {
    type: 'assistant',
    timestamp: '2026-08-05T19:06:37.193Z',
    message: { model: 'claude-sonnet-5', usage: { input_tokens: Infinity, output_tokens: 1000 } },
  };
  const infinityRecord = extractClaudeCodeSpend(infinityLine);
  check('extractClaudeCodeSpend: Infinity input_tokens is rejected (treated as 0), not passed through',
        !!infinityRecord && infinityRecord.inputTokens === 0 && Number.isFinite(infinityRecord.costCents),
        JSON.stringify(infinityRecord));

  // Correction item 1: a numeric epoch timestamp (seconds or ms) must be
  // handled the same way `resetsAtFrom` already handles it elsewhere in
  // this file, and a missing/unparseable timestamp must return null --
  // never fall back to `Date.now()` and silently misattribute the record.
  const numericTsFile = 'smoke-codex-numeric-ts.jsonl';
  const numericSeconds = Math.floor(Date.parse('2026-08-05T00:00:00.000Z') / 1000);
  const numericRec = extractCodexSpend(
    { type: 'event_msg', timestamp: numericSeconds,
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 500, output_tokens: 0 } }, model: 'gpt-5-codex' } },
    numericTsFile,
  );
  check('extractCodexSpend: a numeric (seconds) epoch timestamp is parsed like resetsAtFrom does elsewhere',
        !!numericRec && numericRec.ts === numericSeconds * 1000, JSON.stringify(numericRec));
  const missingTsFile = 'smoke-codex-missing-ts.jsonl';
  const missingTsRec = extractCodexSpend(
    { type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 500, output_tokens: 0 } }, model: 'gpt-5-codex' } },
    missingTsFile,
  );
  check('extractCodexSpend: a missing timestamp returns null, never falls back to Date.now()',
        missingTsRec === null, JSON.stringify(missingTsRec));

  // Correction item 2: `total_token_usage` is treated as cumulative --
  // successive token_count events for the SAME file must emit DELTAS that
  // telescope back to the last raw value, not the raw (potentially
  // cumulative) value summed every time.
  const cumulativeFile = 'smoke-codex-cumulative.jsonl';
  const tokenCountLine = (total, ts) => ({
    type: 'event_msg', timestamp: ts,
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: total, output_tokens: 0 } }, model: 'gpt-5-codex' },
  });
  const firstEvent = extractCodexSpend(tokenCountLine(100, '2026-08-05T00:00:00.000Z'), cumulativeFile);
  const secondEvent = extractCodexSpend(tokenCountLine(300, '2026-08-05T00:05:00.000Z'), cumulativeFile);
  check('extractCodexSpend: first token_count event in a file emits its raw value as the delta (100)',
        !!firstEvent && firstEvent.inputTokens === 100, JSON.stringify(firstEvent));
  check('extractCodexSpend: second (higher cumulative) event emits only the DELTA (300-100=200), not the raw 300',
        !!secondEvent && secondEvent.inputTokens === 200, JSON.stringify(secondEvent));
  check('extractCodexSpend: deltas telescope back to the last raw cumulative value (100+200=300), proving "last value wins" through the additive scanner',
        firstEvent.inputTokens + secondEvent.inputTokens === 300);

  // LOW-CONFIDENCE shape (see the CONFIDENCE note in codex-cli/quota.ts) --
  // this only pins the defensive-null behavior and the documented probed
  // shape; it is not evidence the shape is correct against a real file.
  check('extractCodexSpend: unrecognised line shape returns null, never throws or fabricates',
        extractCodexSpend({ type: 'user_message', text: 'hi' }, 'f.jsonl') === null);
  check('extractCodexSpend: a plausible token_count event with a preceding model hint is priced',
        (() => {
          const file = 'smoke-codex-file.jsonl';
          extractCodexSpend({ type: 'session_meta', model: 'gpt-5-codex' }, file);
          const rec = extractCodexSpend(
            { type: 'event_msg', timestamp: '2026-08-05T00:00:00.000Z',
              payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, output_tokens: 200, cached_input_tokens: 0 } } } },
            file,
          );
          return !!rec && rec.costCents !== null && rec.inputTokens === 1000;
        })());
}

// --------------------------------------------------------------------------
// codex-cli/quota.js: fileCumulativeState must survive an app restart via
// its own persisted state file (correction round 2, item 2's CRITICAL gap).
// A fresh module instance (simulating a real process restart) is obtained
// by busting require.cache for codex-cli/quota.js ONLY -- the scanner
// instance is deliberately NOT recreated, since JsonlSpendScanner's own
// on-disk cache persistence is already covered elsewhere and the bug is
// specifically in codex-cli's separate in-memory delta-tracking map.
// --------------------------------------------------------------------------
async function testCodexCumulativeStateRestart() {
  console.log('codex-cli/quota.js: cumulative-state restart persistence');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-smoke-codex-restart-'));
  const cacheDir = path.join(tmp, 'cache');
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'session.jsonl');
  const patterns = [path.join(dataDir, '*.jsonl')];

  const tokenCountLine = (total, ts) => JSON.stringify({
    type: 'event_msg', timestamp: ts,
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: total, output_tokens: 0 } }, model: 'gpt-5-codex' },
  });

  // "Process 1": the file's first token_count event, cumulative total 1000.
  fs.writeFileSync(file, tokenCountLine(1000, '2026-08-05T00:00:00.000Z') + '\n');

  const quotaPath = require.resolve('../dist/main/connectors/codex-cli/quota.js');
  const quota1 = require(quotaPath);
  quota1.ensureCumulativeStateLoaded(cacheDir);
  const scanner = JsonlSpendScanner.shared(cacheDir);
  const firstRecords = await scanner.scan({ key: 'codex-cli-restart-test', patterns, extract: quota1.extractCodexSpend });
  const firstTotal = firstRecords.reduce((sum, r) => sum + r.inputTokens, 0);
  check('restart test: first scan captures the full 1000-token baseline',
        firstTotal === 1000, firstTotal);
  quota1.flushCumulativeState(cacheDir); // simulate a clean shutdown persisting the baseline

  // "Restart": bust the require cache so the fresh module's
  // fileCumulativeState/cumulativeStateLoadedFrom start empty -- exactly the
  // state that doesn't currently survive a real process restart.
  delete require.cache[quotaPath];
  const quota2 = require(quotaPath);
  check('restart test: the re-required module is genuinely fresh (new function identity)',
        quota2.extractCodexSpend !== quota1.extractCodexSpend);

  // More growth arrives on the SAME file while "the app was restarted"
  // (cumulative total now 1500). The scanner resumes from its own
  // persisted `scannedBytes`, so extractCodexSpend only ever sees this one
  // new line.
  fs.appendFileSync(file, tokenCountLine(1500, '2026-08-05T00:05:00.000Z') + '\n');
  await sleep(20);
  fs.utimesSync(file, new Date(), new Date());

  quota2.ensureCumulativeStateLoaded(cacheDir); // loads the persisted 1000 baseline
  const secondRecords = await scanner.scan({ key: 'codex-cli-restart-test', patterns, extract: quota2.extractCodexSpend });
  const secondTotal = secondRecords.reduce((sum, r) => sum + r.inputTokens, 0);
  // Before this fix: a reset-to-0 baseline post-restart would make the new
  // line's delta the full raw 1500, merged on top of the scanner's already-
  // resident 1000 from the first scan -> a fabricated 2500. After the fix:
  // the new line's delta is the true 1500-1000=500, merged on top of the
  // resident 1000 -> the correct 1500, matching the real final cumulative
  // value with no spike.
  check('restart test: post-restart delta is the TRUE incremental delta, total stays at the real cumulative value (1500), not a fabricated spike (2500)',
        secondTotal === 1500, secondTotal);

  fs.rmSync(tmp, { recursive: true, force: true });
}

// --------------------------------------------------------------------------
// TranscriptWatcher: status classification + kind dispatch
// --------------------------------------------------------------------------
async function testTranscriptWatcher() {
  console.log('TranscriptWatcher: status -> kind dispatch');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-smoke-'));
  const file = path.join(tmp, 'session.jsonl');
  fs.writeFileSync(file, '');

  const captured = [];
  const watcher = new TranscriptWatcher(
    {
      agentName: 'TestAgent',
      detectorId: 'test',
      patterns: [path.join(tmp, '*.jsonl')],
      idleMs: 600,
      extractStatus: line => {
        if (!line) return 'unknown';
        if (line.role === 'user') return 'user';
        if (line.role === 'assistant') {
          return line.tool ? 'pending' : 'final';
        }
        return 'unknown';
      },
      extractSnippet: line => line && line.text,
    },
    makeCtx(captured),
  );
  await watcher.start();
  await sleep(150);

  fs.appendFileSync(file, JSON.stringify({ role: 'user', text: 'do the thing' }) + '\n');
  await sleep(900);
  check('user-only message does not fire', captured.length === 0,
        `got ${captured.length} events: ${JSON.stringify(captured)}`);

  fs.appendFileSync(file, JSON.stringify({ role: 'assistant', text: 'Done. Anything else?' }) + '\n');
  await sleep(1200);
  check('assistant text-only fires once', captured.length === 1,
        `got ${captured.length} events`);
  if (captured[0]) {
    check('text-only event kind is finished', captured[0].kind === 'finished',
          `kind=${captured[0].kind}`);
    check('text-only event has snippet', /Done/.test(captured[0].message));
    check('text-only event has sessionId namespaced', /^test:/.test(captured[0].sessionId));
  }

  await sleep(1000);
  check('does not re-notify same kind on same mtime', captured.length === 1,
        `got ${captured.length} events after extra idle`);

  fs.appendFileSync(file, JSON.stringify({ role: 'user', text: 'now run it' }) + '\n');
  await sleep(400);
  fs.appendFileSync(
    file,
    JSON.stringify({ role: 'assistant', text: 'Running…', tool: 'bash' }) + '\n',
  );
  await sleep(2500);
  check('assistant with pending tool fires waiting', captured.length === 2,
        `got ${captured.length} events after tool turn`);
  if (captured[1]) {
    check('tool-pending event kind is waiting', captured[1].kind === 'waiting',
          `kind=${captured[1].kind}`);
  }

  await watcher.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
}

// --------------------------------------------------------------------------
// Per-connector classifier: Cursor + Claude Code + Codex CLI shape recognition
// --------------------------------------------------------------------------
function testConnectorClassifiers() {
  console.log('Connector classifiers: pending vs final');
  const noopCtx = makeCtx([]);

  const cursor = findConnector('cursor').detector
    .create({ paths: [], idleSeconds: 4 }, noopCtx).opts.extractStatus;
  check('Cursor: assistant + tool_use -> pending',
        cursor({ role: 'assistant', message: { content: [{ type: 'tool_use', name: 'edit' }] } }) === 'pending');
  check('Cursor: assistant + text only -> final',
        cursor({ role: 'assistant', message: { content: [{ type: 'text', text: 'All set.' }] } }) === 'final');
  check('Cursor: user -> user',
        cursor({ role: 'user', message: { content: [] } }) === 'user');
  check('Cursor: tool role -> tool',
        cursor({ role: 'tool', message: {} }) === 'tool');

  const claude = findConnector('claude-code').detector
    .create({ paths: [], idleSeconds: 4 }, noopCtx).opts.extractStatus;
  check('Claude Code: type=user -> user',
        claude({ type: 'user' }) === 'user');
  check('Claude Code: type=tool_use -> tool',
        claude({ type: 'tool_use' }) === 'tool');
  check('Claude Code: assistant + tool_use in content -> pending',
        claude({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }) === 'pending');
  check('Claude Code: assistant + text only -> final',
        claude({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }) === 'final');

  const codex = findConnector('codex-cli').detector
    .create({ paths: [], idleSeconds: 4 }, noopCtx).opts.extractStatus;
  check('Codex: function_call -> pending',
        codex({ type: 'function_call', name: 'shell' }) === 'pending');
  check('Codex: function_call_output -> tool',
        codex({ type: 'function_call_output' }) === 'tool');
  check('Codex: assistant_message -> final',
        codex({ type: 'assistant_message', text: 'done' }) === 'final');
  check('Codex: user_message -> user',
        codex({ type: 'user_message' }) === 'user');
}

// --------------------------------------------------------------------------
// Webhook: kind handling
// --------------------------------------------------------------------------
async function testWebhook() {
  console.log('Webhook: POST /notify emits events with the right kind');
  const captured = [];
  const port = 53129 + Math.floor(Math.random() * 100);
  const def = findConnector('webhook');
  const detector = def.detector.create(
    { host: '127.0.0.1', port, token: 'sek' },
    makeCtx(captured),
  );
  await detector.start();
  await sleep(150);

  const post = (body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request(
      { method: 'POST', host: '127.0.0.1', port, path: '/notify',
        headers: { 'Content-Type': 'application/json', ...headers } },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });

  let res = await post({ agent: 'Copilot', message: 'Allow run?' });
  check('rejects without token', res.status === 401, `status ${res.status}`);

  res = await post(
    { agent: 'Copilot', message: 'Allow run?' },
    { 'X-AI-Oversight-Token': 'sek' },
  );
  check('accepts with token', res.status === 200, `status ${res.status}, body ${res.body}`);
  check('emits one webhook event', captured.length === 1, `got ${captured.length} events`);
  if (captured[0]) {
    check('event has agent', captured[0].agent === 'Copilot');
    check('event has message', captured[0].message === 'Allow run?');
    check('sessionId prefixed', /^webhook:/.test(captured[0].sessionId));
    check('default kind is waiting', captured[0].kind === 'waiting',
          `kind=${captured[0].kind}`);
  }

  res = await post(
    { agent: 'Copilot', kind: 'finished', message: 'Build complete' },
    { 'X-AI-Oversight-Token': 'sek' },
  );
  check('accepts kind=finished', res.status === 200,
        `status ${res.status}, body ${res.body}`);
  check('webhook fired second event', captured.length === 2,
        `got ${captured.length} events`);
  if (captured[1]) {
    check('explicit kind=finished propagates', captured[1].kind === 'finished',
          `kind=${captured[1].kind}`);
  }

  res = await post(
    { agent: 'Copilot', kind: 'frobulated', message: 'oops' },
    { 'X-AI-Oversight-Token': 'sek' },
  );
  check('invalid kind falls back to waiting',
        captured.length === 3 && captured[2].kind === 'waiting',
        `kind=${captured[2] && captured[2].kind}`);

  const health = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/health`, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
  check('GET /health returns ok', health.status === 200 && /"ok":true/.test(health.body));

  await detector.stop();
}

// --------------------------------------------------------------------------
// settings-store.js: sanitizeBucketPrefPatch + the new AppSettings enum
// validators (theme/density/timeFormat) used by `load()`'s disk-merge path.
// --------------------------------------------------------------------------
function testSettingsStore() {
  console.log('settings-store: sanitizeBucketPrefPatch + AppSettings enum validators');

  check('sanitizeBucketPrefPatch: keeps a well-typed hidden/starred/order/visibility patch',
        JSON.stringify(sanitizeBucketPrefPatch({ hidden: true, starred: false, order: 2, visibility: 'always' }))
          === JSON.stringify({ hidden: true, starred: false, order: 2, visibility: 'always' }));
  check("sanitizeBucketPrefPatch: keeps visibility:'onDemand'",
        sanitizeBucketPrefPatch({ visibility: 'onDemand' }).visibility === 'onDemand');
  check('sanitizeBucketPrefPatch: drops an invalid visibility string, keeps other valid fields',
        JSON.stringify(sanitizeBucketPrefPatch({ visibility: 'sometimes', starred: true }))
          === JSON.stringify({ starred: true }));
  check('sanitizeBucketPrefPatch: drops a non-string visibility',
        !('visibility' in sanitizeBucketPrefPatch({ visibility: 1 })));
  check('sanitizeBucketPrefPatch: omits visibility entirely when absent (no clobbering with undefined)',
        !('visibility' in sanitizeBucketPrefPatch({ hidden: true })));
  check('sanitizeBucketPrefPatch: empty/malformed patch -> empty object',
        JSON.stringify(sanitizeBucketPrefPatch(null)) === '{}' &&
        JSON.stringify(sanitizeBucketPrefPatch({ order: 'nope' })) === '{}');

  check("isTheme: accepts 'system'/'light'/'dark'",
        isTheme('system') && isTheme('light') && isTheme('dark'));
  check('isTheme: rejects an arbitrary string', !isTheme('solarized'));
  check("isDensity: accepts 'default'/'compact'", isDensity('default') && isDensity('compact'));
  check('isDensity: rejects an arbitrary string', !isDensity('cozy'));
  check("isTimeFormat: accepts 'auto'/'12h'/'24h'",
        isTimeFormat('auto') && isTimeFormat('12h') && isTimeFormat('24h'));
  check('isTimeFormat: rejects an arbitrary string', !isTimeFormat('25h'));
}

// --------------------------------------------------------------------------
// grok/quota.ts: resolveWindowPairing, atomicWriteFile, billing/plan
// parsing, and the local-spend extractor's null-vs-zero contract.
// --------------------------------------------------------------------------
function testGrokQuota() {
  console.log('grok/quota.ts: resolveWindowPairing');
  check('resolveWindowPairing: both observed -> real windowMs + real resetsAt',
        (() => {
          const r = grokResolveWindowPairing(604800000, 1700000000000, 604800000);
          return r.windowMs === 604800000 && r.resetsAt === 1700000000000;
        })());
  check('resolveWindowPairing: resetsAt observed but windowMs NOT observed -> resetsAt omitted',
        (() => {
          const r = grokResolveWindowPairing(null, 1700000000000, 604800000);
          return r.windowMs === 604800000 && r.resetsAt === undefined;
        })());
  check('resolveWindowPairing: windowMs observed but resetsAt NOT observed -> resetsAt omitted, real windowMs kept',
        (() => {
          const r = grokResolveWindowPairing(604800000, null, 604800000);
          return r.windowMs === 604800000 && r.resetsAt === undefined;
        })());
  check('resolveWindowPairing: neither observed -> fallback windowMs, no resetsAt',
        (() => {
          const r = grokResolveWindowPairing(null, null, 604800000);
          return r.windowMs === 604800000 && r.resetsAt === undefined;
        })());

  console.log('grok/quota.ts: atomicWriteFile (same pattern as codex-cli\'s)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-smoke-grok-'));
  const target = path.join(tmp, 'auth.json');
  fs.writeFileSync(target, '{"orig":true}');
  const ok = grokAtomicWriteFile(target, '{"next":true}');
  check('atomicWriteFile: returns true on success', ok === true);
  check('atomicWriteFile: target now has the new content',
        fs.readFileSync(target, 'utf8') === '{"next":true}');
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log('grok/quota.ts: parseBillingJson');
  check('parseBillingJson: reads weekly_usage_percent + pay_as_you_go under data',
        (() => {
          const p = grokParseBillingJson({ data: { weekly_usage_percent: 42, pay_as_you_go: true } });
          return !!p.weekly && p.weekly.usedPercent === 42 && p.payAsYouGo === true;
        })());
  check('parseBillingJson: clamps an out-of-range percent into [0,100]',
        (() => {
          const p = grokParseBillingJson({ weekly_usage_percent: 142 });
          return p.weekly.usedPercent === 100;
        })());
  check('parseBillingJson: no recognisable fields -> empty result, not a throw',
        (() => {
          const p = grokParseBillingJson({ unexpected: true });
          return !p.weekly && p.payAsYouGo === undefined && p.creditsUsed === undefined;
        })());
  check('parseBillingJson: credits_used without a limit keeps creditsLimit null, not 0',
        (() => {
          const p = grokParseBillingJson({ credits_used: 5 });
          return p.creditsUsed === 5 && p.creditsLimit == null;
        })());

  console.log('grok/quota.ts: parsePlanTier');
  check('parsePlanTier: reads plan_name', grokParsePlanTier({ plan_name: 'Pro' }) === 'Pro');
  check('parsePlanTier: unrecognised shape -> null', grokParsePlanTier({ nope: 1 }) === null);

  console.log('grok/quota.ts: extractGrokSpend (fail-soft on an unrecognised line)');
  check('extractGrokSpend: a well-formed usage line yields a record',
        (() => {
          const r = extractGrokSpend({ timestamp: 1700000000000, model: 'grok-4', usage: { input_tokens: 100, output_tokens: 50 } });
          return !!r && r.inputTokens === 100 && r.outputTokens === 50 && r.ts === 1700000000000;
        })());
  check('extractGrokSpend: no token fields at all -> null, not a fabricated record',
        extractGrokSpend({ timestamp: 1700000000000, foo: 'bar' }) === null);
  check('extractGrokSpend: token fields present but no timestamp -> null (never fabricate "now")',
        extractGrokSpend({ usage: { input_tokens: 10, output_tokens: 5 } }) === null);
  check('extractGrokSpend: unrecognised model -> costCents null, never a fabricated 0',
        (() => {
          const r = extractGrokSpend({ timestamp: 1700000000000, model: 'totally-unknown-model', usage: { input_tokens: 10, output_tokens: 5 } });
          return !!r && r.costCents === null;
        })());
  check('extractGrokSpend: a non-object line -> null, not a throw',
        extractGrokSpend('not an object') === null);

  console.log('grok/quota.ts: noRecognisableGrokData (WARNING fix -- pay-as-you-go-only must NOT be "no data")');
  check('noRecognisableGrokData: zero buckets but a recognised displayMessages entry -> false (recognised data, not a failure)',
        noRecognisableGrokData(0, 1) === false);
  check('noRecognisableGrokData: zero buckets AND zero displayMessages -> true (genuinely no data)',
        noRecognisableGrokData(0, 0) === true);
  check('noRecognisableGrokData: at least one bucket -> false regardless of displayMessages',
        noRecognisableGrokData(1, 0) === false);
}

// --------------------------------------------------------------------------
// devin/quota.ts: parseFlatToml, resolveServerUrl, parseUserStatus,
// resolveWindowPairing, dollarsToCents.
// --------------------------------------------------------------------------
function testDevinQuota() {
  console.log('devin/quota.ts: parseFlatToml');
  check('parseFlatToml: parses a quoted key/value pair',
        parseFlatToml('windsurf_api_key = "abc123"').windsurf_api_key === 'abc123');
  check('parseFlatToml: parses a single-quoted key/value pair',
        parseFlatToml("api_server_url = 'server.codeium.com'").api_server_url === 'server.codeium.com');
  check('parseFlatToml: parses a bare unquoted value',
        parseFlatToml('windsurf_api_key = abc123').windsurf_api_key === 'abc123');
  check('parseFlatToml: strips a trailing inline comment on a bare value',
        parseFlatToml('windsurf_api_key = abc123 # a comment').windsurf_api_key === 'abc123');
  check('parseFlatToml: skips a full-line comment',
        Object.keys(parseFlatToml('# just a comment\nwindsurf_api_key = "abc"')).length === 1);
  check('parseFlatToml: skips a [section] header line, keeps flat keys below it',
        (() => {
          const parsed = parseFlatToml('[default]\nwindsurf_api_key = "abc"');
          return parsed.windsurf_api_key === 'abc' && !('[default]' in parsed);
        })());
  check('parseFlatToml: first occurrence of a duplicate key wins',
        parseFlatToml('windsurf_api_key = "first"\nwindsurf_api_key = "second"').windsurf_api_key === 'first');
  check('parseFlatToml: blank/malformed lines are skipped, not throwing',
        (() => {
          const parsed = parseFlatToml('\n\nnot a kv line\nwindsurf_api_key = "abc"\n');
          return parsed.windsurf_api_key === 'abc';
        })());

  console.log('devin/quota.ts: resolveServerUrl');
  check('resolveServerUrl: accepts a bare host, defaults to https',
        devinResolveServerUrl('server.codeium.com') === 'https://server.codeium.com');
  check('resolveServerUrl: accepts a full https URL, strips a trailing slash',
        devinResolveServerUrl('https://custom.example.com/') === 'https://custom.example.com');
  check('resolveServerUrl: undefined -> the documented default',
        devinResolveServerUrl(undefined) === 'https://server.codeium.com');
  check('resolveServerUrl: a non-http(s) scheme falls back to the default, not used verbatim',
        devinResolveServerUrl('ftp://evil.example.com') === 'https://server.codeium.com');
  check('resolveServerUrl: a malformed value falls back to the default',
        devinResolveServerUrl('::::not a url::::') === 'https://server.codeium.com');

  console.log('devin/quota.ts: parseUserStatus');
  check('parseUserStatus: reads weekly + daily quota under userStatus',
        (() => {
          const p = devinParseUserStatus({ userStatus: { weekly_quota: { used_percent: 30 }, daily_quota: { used_percent: 10 } } });
          return p.weekly.usedPercent === 30 && p.daily.usedPercent === 10;
        })());
  check('parseUserStatus: extra_balance_cents passed through unchanged (no double dollars->cents conversion)',
        devinParseUserStatus({ extra_balance_cents: 1234 }).extraBalanceCents === 1234);
  check('parseUserStatus: extra_balance_usd converted once to cents',
        devinParseUserStatus({ extra_balance_usd: 12.34 }).extraBalanceCents === 1234);
  check('parseUserStatus: unrecognised shape -> empty result, not a throw',
        (() => {
          const p = devinParseUserStatus({ nope: true });
          return !p.weekly && !p.daily && p.extraBalanceCents === undefined;
        })());
  check('parseUserStatus: non-object input -> empty result',
        (() => {
          const p = devinParseUserStatus(null);
          return !p.weekly && !p.daily;
        })());

  console.log('devin/quota.ts: resolveWindowPairing + dollarsToCents');
  check('resolveWindowPairing: both observed -> real pairing',
        (() => {
          const r = devinResolveWindowPairing(86400000, 1700000000000, 604800000);
          return r.windowMs === 86400000 && r.resetsAt === 1700000000000;
        })());
  check('resolveWindowPairing: resetsAt observed but windowMs NOT observed -> resetsAt omitted, fallback windowMs used',
        (() => {
          const r = devinResolveWindowPairing(null, 1700000000000, 604800000);
          return r.windowMs === 604800000 && r.resetsAt === undefined;
        })());
  check('resolveWindowPairing: windowMs observed but resetsAt NOT observed -> resetsAt omitted, real windowMs kept',
        (() => {
          const r = devinResolveWindowPairing(86400000, null, 604800000);
          return r.windowMs === 86400000 && r.resetsAt === undefined;
        })());
  check('resolveWindowPairing: neither observed -> fallback windowMs only',
        (() => {
          const r = devinResolveWindowPairing(null, null, 604800000);
          return r.windowMs === 604800000 && r.resetsAt === undefined;
        })());
  check('dollarsToCents(12.34) === 1234', devinDollarsToCents(12.34) === 1234, devinDollarsToCents(12.34));

  console.log('devin/quota.ts: buildQuotaWindowBuckets (WARNING fix -- weekly/daily fallback uses its OWN id)');
  const weeklyWindow = { usedPercent: 30, resetsAt: null, windowMs: null };
  const dailyWindow = { usedPercent: 10, resetsAt: null, windowMs: null };

  const bothPresent = buildQuotaWindowBuckets({ weekly: weeklyWindow, daily: dailyWindow });
  check('buildQuotaWindowBuckets: weekly+daily both present -> two buckets, ids "weekly" and "daily"',
        bothPresent.length === 2 && bothPresent.map(b => b.id).sort().join(',') === 'daily,weekly',
        JSON.stringify(bothPresent.map(b => b.id)));
  check('buildQuotaWindowBuckets: weekly+daily both present -> the daily bucket is onDemand (secondary role)',
        bothPresent.find(b => b.id === 'daily').defaultVisibility === 'onDemand');
  check('buildQuotaWindowBuckets: weekly+daily both present -> the weekly bucket carries the weekly used%',
        bothPresent.find(b => b.id === 'weekly').used === 30);

  const weeklyOnly = buildQuotaWindowBuckets({ weekly: weeklyWindow });
  check('buildQuotaWindowBuckets: weekly only -> exactly one "weekly" bucket',
        weeklyOnly.length === 1 && weeklyOnly[0].id === 'weekly');

  const dailyOnlyFallback = buildQuotaWindowBuckets({ daily: dailyWindow });
  check('buildQuotaWindowBuckets: no weekly reported, daily present -> exactly ONE bucket, id "daily" (NOT "weekly")',
        dailyOnlyFallback.length === 1 && dailyOnlyFallback[0].id === 'daily',
        JSON.stringify(dailyOnlyFallback.map(b => b.id)));
  check('buildQuotaWindowBuckets: the daily-fallback bucket is the primary figure -> "always" visible (defaultVisibility unset), not onDemand',
        dailyOnlyFallback[0].defaultVisibility === undefined);
  check('buildQuotaWindowBuckets: the daily-fallback bucket carries an explanatory note',
        typeof dailyOnlyFallback[0].note === 'string' && dailyOnlyFallback[0].note.length > 0);
  check('buildQuotaWindowBuckets: the daily-fallback bucket\'s used% is the daily figure (10), not the weekly one',
        dailyOnlyFallback[0].used === 10);

  const neitherPresent = buildQuotaWindowBuckets({});
  check('buildQuotaWindowBuckets: neither weekly nor daily reported -> no buckets', neitherPresent.length === 0);
}

// --------------------------------------------------------------------------
// antigravity/quota.ts: parsePortRange/parsePortRangeInfo,
// looksLikeAntigravityServer, extractCsrfToken, scanForLanguageServer,
// poolForModel, classifyWindowKind, extractQuotaEntries, mergePoolQuota,
// resolveWindowPairing, normalizeEpochMs, queryQuotaData(WithBudget).
// --------------------------------------------------------------------------
function testAntigravityQuota() {
  console.log('antigravity/quota.ts: parsePortRange / parsePortRangeInfo');
  check('parsePortRange: parses a well-formed "start-end" range',
        (() => {
          const ports = parsePortRange('100-104');
          return ports.length === 5 && ports[0] === 100 && ports[4] === 104;
        })());
  check('parsePortRange: undefined -> the documented default range',
        (() => {
          const ports = parsePortRange(undefined);
          const fallback = parsePortRange(DEFAULT_PORT_RANGE);
          return ports.length === fallback.length && ports[0] === fallback[0];
        })());
  check('parsePortRange: empty string -> the default range, not zero ports',
        parsePortRange('').length > 0);
  check('parsePortRange: malformed (non-numeric) -> falls back to the default range',
        parsePortRange('abc-def').length === parsePortRange(DEFAULT_PORT_RANGE).length);
  check('parsePortRange: reversed range (end < start) -> falls back to the default range',
        parsePortRange('200-100').length === parsePortRange(DEFAULT_PORT_RANGE).length);
  check('parsePortRange: out-of-range port numbers (>65535) -> falls back to the default range',
        parsePortRange('100-99999').length === parsePortRange(DEFAULT_PORT_RANGE).length);

  console.log('antigravity/quota.ts: parsePortRangeInfo (WARNING fix -- widened range is no longer silently truncated to a small fixed count)');
  check('parsePortRangeInfo: a moderately widened custom range (200 ports) scans IN FULL -- this is the exact bug scenario: previously only the first 64 of a widened range were ever scanned',
        (() => {
          const info = parsePortRangeInfo('50000-50199');
          return info.ports.length === 200 && info.requestedSpan === 200 && info.ports[199] === 50199;
        })());
  check('parsePortRangeInfo: requestedSpan matches ports.length when nothing was capped (the common, non-pathological case)',
        (() => {
          const info = parsePortRangeInfo(DEFAULT_PORT_RANGE);
          return info.requestedSpan === info.ports.length;
        })());
  check('parsePortRangeInfo: a pathological full-port-space paste is capped at MAX_PORT_RANGE_SPAN, not left unbounded',
        (() => {
          const info = parsePortRangeInfo('1-65000');
          return info.ports.length === MAX_PORT_RANGE_SPAN && info.requestedSpan === 65000;
        })());
  check('parsePortRangeInfo: MAX_PORT_RANGE_SPAN is generous (>=1000) -- the truncation-detection test above only exercises the pathological case, not realistic ranges',
        MAX_PORT_RANGE_SPAN >= 1000, MAX_PORT_RANGE_SPAN);

  console.log('antigravity/quota.ts: looksLikeAntigravityServer');
  check('looksLikeAntigravityServer: recognises a csrfToken field',
        looksLikeAntigravityServer({ csrfToken: 'abc123' }) === true);
  check('looksLikeAntigravityServer: recognises a snake_case csrf_token field',
        looksLikeAntigravityServer({ csrf_token: 'abc123' }) === true);
  check('looksLikeAntigravityServer: rejects an empty object -- no bare-200 false positive',
        looksLikeAntigravityServer({}) === false);
  check('looksLikeAntigravityServer: rejects a body with none of the recognised fields',
        looksLikeAntigravityServer({ hello: 'world' }) === false);
  check('looksLikeAntigravityServer: rejects a non-object body (string) without throwing',
        looksLikeAntigravityServer('not an object') === false);
  check('looksLikeAntigravityServer: rejects null without throwing',
        looksLikeAntigravityServer(null) === false);
  check('looksLikeAntigravityServer: rejects a field present but not a string (e.g. number)',
        looksLikeAntigravityServer({ csrfToken: 12345 }) === false);
  check('looksLikeAntigravityServer: rejects generic fields deliberately excluded (sessionId/ideVersion) -- avoids false-positiving on an unrelated local server',
        looksLikeAntigravityServer({ sessionId: 'abc', ideVersion: '1.0' }) === false);

  console.log('antigravity/quota.ts: extractCsrfToken');
  check('extractCsrfToken: reads a camelCase csrfToken', extractCsrfToken({ csrfToken: 'tok-1' }) === 'tok-1');
  check('extractCsrfToken: reads a snake_case csrf_token', extractCsrfToken({ csrf_token: 'tok-2' }) === 'tok-2');
  check('extractCsrfToken: no recognised field -> null', extractCsrfToken({ hello: 'world' }) === null);
  check('extractCsrfToken: non-object input -> null', extractCsrfToken(null) === null);

  console.log('antigravity/quota.ts: poolForModel + classifyWindowKind');
  check('poolForModel: "gemini-2.5-pro" -> gemini pool', poolForModel('gemini-2.5-pro') === 'gemini');
  check('poolForModel: "Gemini Flash" (case-insensitive) -> gemini pool', poolForModel('Gemini Flash') === 'gemini');
  check('poolForModel: "claude-sonnet-4.5" -> non-Gemini pool', poolForModel('claude-sonnet-4.5') === 'other');
  check('poolForModel: "gpt-oss-120b" -> non-Gemini pool', poolForModel('gpt-oss-120b') === 'other');
  check('poolForModel: an unrecognised model id still lands in the non-Gemini catch-all, never dropped',
        poolForModel('some-future-model') === 'other');
  check('classifyWindowKind: sub-daily duration -> "5h"', classifyWindowKind(3_600_000, '') === '5h');
  check('classifyWindowKind: >= 1 day duration -> "weekly"', classifyWindowKind(604_800_000, '') === 'weekly');
  check('classifyWindowKind: no duration, "weekly" name hint -> "weekly"',
        classifyWindowKind(null, 'weekly_pool') === 'weekly');
  check('classifyWindowKind: no duration, "session" name hint -> "5h"',
        classifyWindowKind(null, 'session_quota') === '5h');
  check('classifyWindowKind: neither duration nor a recognisable hint -> null, NOT a guessed default',
        classifyWindowKind(null, '') === null);
  check('classifyWindowKind: an unrecognised hint string alone -> null',
        classifyWindowKind(null, 'some_other_thing') === null);

  console.log('antigravity/quota.ts: extractQuotaEntries');
  check('extractQuotaEntries: reads a "quotas" list with usedPercent + a sub-daily window (classified "5h")',
        (() => {
          const entries = antigravityExtractQuotaEntries({
            quotas: [{ model: 'gemini-2.5-pro', usedPercent: 42, windowSeconds: 3600 }],
          });
          return entries.length === 1 && entries[0].modelId === 'gemini-2.5-pro' &&
                 entries[0].usedPercent === 42 && entries[0].windowKind === '5h';
        })());
  check('extractQuotaEntries: derives usedPercent from used/limit when no percent field is present',
        (() => {
          const entries = antigravityExtractQuotaEntries({
            quotas: [{ model: 'claude-sonnet-4.5', used: 25, limit: 100, windowSeconds: 604800 }],
          });
          return entries.length === 1 && entries[0].usedPercent === 25 && entries[0].windowKind === 'weekly';
        })());
  check('extractQuotaEntries: a window classifiable only by name hint (no duration field) still keeps the entry',
        (() => {
          const entries = antigravityExtractQuotaEntries({
            quotas: [{ model: 'gpt-oss-120b', usedPercent: 10, type: 'weekly_pool' }],
          });
          return entries.length === 1 && entries[0].windowKind === 'weekly' && entries[0].windowMs === null;
        })());
  check('extractQuotaEntries: (BUG-FIX regression) an entry whose window cannot be classified AT ALL is DROPPED, not defaulted to "5h"',
        (() => {
          const entries = antigravityExtractQuotaEntries({
            quotas: [{ model: 'gemini-2.5-pro', usedPercent: 10 }],
          });
          return entries.length === 0;
        })());
  check('extractQuotaEntries: an entry with no usable used/limit-or-percent is skipped, not defaulted to zero',
        antigravityExtractQuotaEntries({ quotas: [{ model: 'x' }] }).length === 0);
  check('extractQuotaEntries: non-array/unrecognised container -> empty list, not a throw',
        antigravityExtractQuotaEntries({ nope: true }).length === 0);
  check('extractQuotaEntries: non-object input -> empty list', antigravityExtractQuotaEntries(null).length === 0);

  console.log('antigravity/quota.ts: normalizeEpochMs (WARNING fix -- epoch-seconds vs epoch-ms disambiguation)');
  check('normalizeEpochMs: a value already in ms (>= 1e10) passes through unchanged',
        normalizeEpochMs(1_700_000_000_000) === 1_700_000_000_000);
  check('normalizeEpochMs: a value that reads as epoch-SECONDS (< 1e10) is multiplied up to ms',
        normalizeEpochMs(1_700_000_000) === 1_700_000_000_000);
  check('extractQuotaEntries: (WARNING fix regression) a resetsAt reported in epoch-seconds is normalized to ms, not left as a bogus near-1970 value',
        (() => {
          const entries = antigravityExtractQuotaEntries({
            quotas: [{ model: 'gemini-2.5-pro', usedPercent: 10, windowSeconds: 3600, resetsAt: 1_700_000_000 }],
          });
          return entries.length === 1 && entries[0].resetsAt === 1_700_000_000_000;
        })());
  check('extractQuotaEntries: a resetsAt already reported in epoch-ms is left unchanged',
        (() => {
          const entries = antigravityExtractQuotaEntries({
            quotas: [{ model: 'gemini-2.5-pro', usedPercent: 10, windowSeconds: 3600, resetsAt: 1_700_000_000_000 }],
          });
          return entries.length === 1 && entries[0].resetsAt === 1_700_000_000_000;
        })());

  console.log('antigravity/quota.ts: resolveWindowPairing (never pair a real resetsAt with a synthesized windowMs)');
  check('resolveWindowPairing: both observed -> real pairing kept',
        (() => {
          const r = antigravityResolveWindowPairing(18_000_000, 1_700_000_000_000, 604_800_000);
          return r.windowMs === 18_000_000 && r.resetsAt === 1_700_000_000_000;
        })());
  check('resolveWindowPairing: resetsAt observed but windowMs NOT observed -> resetsAt omitted',
        (() => {
          const r = antigravityResolveWindowPairing(null, 1_700_000_000_000, 604_800_000);
          return r.windowMs === 604_800_000 && r.resetsAt === undefined;
        })());

  console.log('antigravity/quota.ts: mergePoolQuota (worst remaining fraction per pool+window)');
  const entries = [
    { modelId: 'gemini-2.5-pro', usedPercent: 30, resetsAt: null, windowMs: 3_600_000, windowKind: '5h' },
    { modelId: 'gemini-2.5-flash', usedPercent: 70, resetsAt: null, windowMs: 3_600_000, windowKind: '5h' },
    { modelId: 'claude-sonnet-4.5', usedPercent: 20, resetsAt: null, windowMs: 604_800_000, windowKind: 'weekly' },
    { modelId: 'gpt-oss-120b', usedPercent: 55, resetsAt: null, windowMs: 604_800_000, windowKind: 'weekly' },
  ];
  const merged = mergePoolQuota(entries);
  const geminiFiveHour = merged.find(b => b.id === 'gemini-5h');
  const otherWeekly = merged.find(b => b.id === 'other-weekly');
  check('mergePoolQuota: gemini 5h bucket picks the WORSE (higher-used%) of the two Gemini models',
        !!geminiFiveHour && geminiFiveHour.used === 70,
        JSON.stringify(geminiFiveHour));
  check('mergePoolQuota: gemini 5h bucket label reads "Gemini (Pro/Flash) — 5h"',
        !!geminiFiveHour && geminiFiveHour.label === 'Gemini (Pro/Flash) — 5h');
  check('mergePoolQuota: non-Gemini weekly bucket picks the WORSE (higher-used%) of its two models',
        !!otherWeekly && otherWeekly.used === 55,
        JSON.stringify(otherWeekly));
  check('mergePoolQuota: buckets without any matching entries are simply absent (no gemini-weekly here)',
        !merged.some(b => b.id === 'gemini-weekly'));
  check('mergePoolQuota: exactly 2 buckets built from these 4 entries (one per populated pool+window pair)',
        merged.length === 2, merged.length);
  check('mergePoolQuota: empty input -> no buckets, not a throw', mergePoolQuota([]).length === 0);

  console.log('antigravity/quota.ts: scanForLanguageServer (injected probe -- no real sockets)');
  return (async () => {
    const found = await scanForLanguageServer(
      [10, 20, 30],
      async port => (port === 20 ? { port, csrfToken: 'tok-20' } : null),
    );
    check('scanForLanguageServer: returns the matching port when the injected probe finds one',
          !!found && found.port === 20);
    check('scanForLanguageServer: threads the probe-supplied CSRF token through to the result',
          !!found && found.csrfToken === 'tok-20');

    const noneFound = await scanForLanguageServer([10, 20, 30], async () => null);
    check('scanForLanguageServer: returns null when nothing matches, does not throw', noneFound === null);

    const lowestWins = await scanForLanguageServer(
      [30, 10, 20],
      async port => ({ port, csrfToken: null }),
    );
    check('scanForLanguageServer: multiple matches -> deterministically returns the lowest port',
          !!lowestWins && lowestWins.port === 10, lowestWins);
    check('scanForLanguageServer: a match with no CSRF token in its probe response surfaces csrfToken:null',
          !!lowestWins && lowestWins.csrfToken === null);

    const emptyRange = await scanForLanguageServer([], async () => ({ port: 1, csrfToken: null }));
    check('scanForLanguageServer: empty port list -> null immediately, no throw', emptyRange === null);

    const start = Date.now();
    const budgetRespected = await scanForLanguageServer(
      [1],
      () => new Promise(() => {}), // a probe that never resolves
      50, // tiny total budget
    );
    const elapsed = Date.now() - start;
    check('scanForLanguageServer: a hung probe is bounded by the total budget, not left to hang',
          budgetRespected === null && elapsed < 2000, `elapsed=${elapsed}ms result=${budgetRespected}`);

    console.log('antigravity/quota.ts: scanForLanguageServer chunking (WARNING fix regression -- a widened range is scanned in full, not truncated)');
    // 130 ports crosses SCAN_CHUNK_SIZE's internal chunk boundary (64) twice
    // -- chunks are roughly [0..63], [64..127], [128..129].
    const manyPorts = Array.from({ length: 130 }, (_, i) => 9000 + i);
    const lateMatch = await scanForLanguageServer(manyPorts, async port => (port === 9129 ? { port, csrfToken: null } : null));
    check('scanForLanguageServer: a match in the LAST chunk of a range spanning multiple chunks is still found -- proves the FULL configured range is scanned, not just the first ~64 ports (the exact bug this fix closes)',
          !!lateMatch && lateMatch.port === 9129, JSON.stringify(lateMatch));

    const chunkStart = Date.now();
    const shortCircuited = await scanForLanguageServer(manyPorts, async port => {
      if (port === 9005) return { port, csrfToken: null }; // first chunk -- should short-circuit here
      if (port >= 9128) return new Promise(() => {}); // last chunk -- would hang forever if ever awaited
      return null;
    });
    const chunkElapsed = Date.now() - chunkStart;
    check('scanForLanguageServer: a match found in an early chunk short-circuits before a later (possibly hanging) chunk is ever probed',
          !!shortCircuited && shortCircuited.port === 9005 && chunkElapsed < 2000,
          `port=${shortCircuited && shortCircuited.port} elapsed=${chunkElapsed}ms`);

    console.log('antigravity/quota.ts: queryQuotaData + queryQuotaDataWithBudget (RESILIENCE fix -- overall budget across the RPC-method fallback loop)');
    const okOutcome = await queryQuotaDataWithBudget(async () => ({ buckets: [{ id: 'gemini-5h' }], source: 'http://x' }));
    check('queryQuotaDataWithBudget: a fast successful outcome passes through unchanged',
          !!okOutcome && Array.isArray(okOutcome.buckets) && okOutcome.buckets.length === 1);

    const failOutcome = await queryQuotaDataWithBudget(async () => ({ lastStatus: 404 }));
    check('queryQuotaDataWithBudget: a fast failure outcome (no recognisable data on any method) passes through unchanged',
          !!failOutcome && failOutcome.lastStatus === 404);

    const queryBudgetStart = Date.now();
    const queryBudgetRespected = await queryQuotaDataWithBudget(() => new Promise(() => {}), 50);
    const queryBudgetElapsed = Date.now() - queryBudgetStart;
    check('queryQuotaDataWithBudget: a hung RPC-method loop is bounded by the overall query budget, not left to hang for up to ~9s across all 3 methods',
          queryBudgetRespected === null && queryBudgetElapsed < 2000, `elapsed=${queryBudgetElapsed}ms`);

    const queryResult = await queryQuotaData('http://127.0.0.1:1', {});
    check('queryQuotaData: no server listening on any RPC method attempt -> a {lastStatus} outcome, not a throw',
          queryResult && typeof queryResult.lastStatus === 'number' && !('buckets' in queryResult),
          JSON.stringify(queryResult));

    // End-to-end through the real provider -- headless Node has no Electron
    // and nothing listens on the default port range, so every probe gets
    // ECONNREFUSED and this exercises the exact contracted "not running"
    // snapshot every real user on a machine without Antigravity running
    // will see. Mirrors testOpencodeUnavailableStates()'s pattern of driving
    // createXQuotaProvider().fetch() directly under Node.
    const provider = createAntigravityQuotaProvider({}, makeCtx([]));
    const snap = await provider.fetch();
    check('fetch(): nothing listening on the scanned range -> ok:false with the honest "not running" message',
          snap.ok === false && typeof snap.error === 'string' &&
          snap.error === 'Antigravity is not running — start the app to see quota.',
          JSON.stringify(snap));
    check('fetch(): the not-running case is NOT needsLogin -- there is no login flow for this connector',
          snap.ok === false && snap.needsLogin === undefined);

    console.log('antigravity/quota.ts: fetch() truncation-aware error message (WARNING fix -- a pathologically wide range no longer just says "not running" with no explanation)');
    const truncatedProvider = createAntigravityQuotaProvider({ portRange: '1-65000' }, makeCtx([]));
    const truncatedSnap = await truncatedProvider.fetch();
    check('fetch(): a configured range wider than MAX_PORT_RANGE_SPAN surfaces an honest truncation note instead of a bare "not running"',
          truncatedSnap.ok === false &&
          truncatedSnap.error.includes('your configured range requested 65000 ports') &&
          truncatedSnap.error.includes(`only the first ${MAX_PORT_RANGE_SPAN} were scanned`),
          truncatedSnap.error);
  })();
}

// Minimal PNG reader matching exactly what generate-icons.js's encodePNG
// writes (8-bit RGBA, color type 6, filter type 0/None on every scanline) --
// not a general-purpose PNG decoder, just enough to smoke-test our own
// generator's output (dimensions + pixel content), so a rasterizer
// regression is caught here instead of only by manual/AI review.
function decodePNG(buf) {
  let offset = 8; // skip the 8-byte PNG signature
  let width = 0, height = 0;
  const idatChunks = [];
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    }
    offset += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw.copy(pixels, y * stride, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  }
  return { width, height, pixels };
}

/** RGBA at normalized (nx, ny) in [0,1] -- matches the generator's own
 * coordinate convention, so test points can be stated the same way the
 * design spec states them. */
function pixelAt(decoded, nx, ny) {
  const x = Math.min(decoded.width - 1, Math.floor(nx * decoded.width));
  const y = Math.min(decoded.height - 1, Math.floor(ny * decoded.height));
  const o = (y * decoded.width + x) * 4;
  return [decoded.pixels[o], decoded.pixels[o + 1], decoded.pixels[o + 2], decoded.pixels[o + 3]];
}

function testIcons() {
  console.log('Icons: generated PNG files exist, match expected dimensions, and have plausible pixel content');
  const expectedSizes = {
    'tray-icon-16.png': 16, 'tray-icon-24.png': 24, 'tray-icon-32.png': 32,
    'tray-icon-16-white.png': 16, 'tray-icon-24-white.png': 24, 'tray-icon-32-white.png': 32,
    'tray-icon.png': 22, 'tray-icon@2x.png': 44,
    'icon.png': 512, 'ai-icon.png': 256, 'ai-icon-no-bkg.png': 256,
  };
  for (const [f, size] of Object.entries(expectedSizes)) {
    const p = path.join(__dirname, '..', 'assets', f);
    const exists = fs.existsSync(p);
    const fsize = exists ? fs.statSync(p).size : 0;
    check(`${f} exists & non-empty`, exists && fsize > 100, `size=${fsize}`);
    if (!exists) continue;
    const decoded = decodePNG(fs.readFileSync(p));
    check(`${f} decodes to the expected ${size}x${size}`,
          decoded.width === size && decoded.height === size,
          `${decoded.width}x${decoded.height}`);
  }

  // The arc ring is a full opaque stroke straight above center at every tray
  // size (270deg is well inside the -5..275 sweep, nowhere near the 315deg
  // gap) -- confirms the rasterizer actually painted something, not a blank
  // transparent image.
  const tray32 = decodePNG(fs.readFileSync(path.join(__dirname, '..', 'assets', 'tray-icon-32.png')));
  const ringPx = pixelAt(tray32, 0.5, 0.17);
  check('tray-icon-32.png: a point on the ring stroke is opaque black',
        ringPx[3] > 200 && ringPx[0] < 40 && ringPx[1] < 40 && ringPx[2] < 40,
        JSON.stringify(ringPx));

  // Same sample point on the dark-taskbar variant must be opaque WHITE --
  // the white files are not just copies of the black ones.
  const tray32White = decodePNG(fs.readFileSync(path.join(__dirname, '..', 'assets', 'tray-icon-32-white.png')));
  const ringPxWhite = pixelAt(tray32White, 0.5, 0.17);
  check('tray-icon-32-white.png: a point on the ring stroke is opaque white',
        ringPxWhite[3] > 200 && ringPxWhite[0] > 215 && ringPxWhite[1] > 215 && ringPxWhite[2] > 215,
        JSON.stringify(ringPxWhite));

  // Regression check for the alpha-premultiplication bug: G1 (30%-opacity
  // white track ring, radius 0.205) sits on ai-icon-no-bkg.png's fully
  // transparent canvas. Straight-up (270deg) and most of the ring is also
  // covered by G2's opaque arc (same radius, wider stroke, sweeps -5..275),
  // so this samples inside G2's 80deg gap (290deg -- within [275,355], clear
  // of both G2 and G3's dot at 315deg) where G1 alone is visible. A correctly
  // un-premultiplied straight-alpha pixel there reads near-white RGB at ~30%
  // alpha (255,255,255,~77) -- the bug stored the premultiplied ~76/77 as if
  // it were straight RGB, i.e. visibly darker white.
  const noBkg = decodePNG(fs.readFileSync(path.join(__dirname, '..', 'assets', 'ai-icon-no-bkg.png')));
  const gapAngleRad = (290 * Math.PI) / 180;
  const trackRingPx = pixelAt(noBkg, 0.5 + 0.205 * Math.cos(gapAngleRad), 0.5 + 0.205 * Math.sin(gapAngleRad));
  check('ai-icon-no-bkg.png: G1 track-ring pixel (in the gap, clear of G2/G3) is un-premultiplied (near-white, not darkened)',
        trackRingPx[0] > 240 && trackRingPx[1] > 240 && trackRingPx[2] > 240 &&
          trackRingPx[3] > 50 && trackRingPx[3] < 100,
        JSON.stringify(trackRingPx));
}

function testTrayRepresentations() {
  console.log('tray.ts: trayRepresentationsToLoad -- win32 DPI-representation degradation logic');
  check('both files present -> both representations attempted',
        JSON.stringify(trayRepresentationsToLoad({ tray24: true, tray32: true })) ===
          JSON.stringify([{ file: 'tray-icon-24.png', scaleFactor: 1.5 }, { file: 'tray-icon-32.png', scaleFactor: 2.0 }]));
  check('tray-icon-24.png missing -> only the 32px representation is attempted (no throw, no crash)',
        JSON.stringify(trayRepresentationsToLoad({ tray24: false, tray32: true })) ===
          JSON.stringify([{ file: 'tray-icon-32.png', scaleFactor: 2.0 }]));
  check('neither file present -> empty list, base 16px representation still stands alone',
        trayRepresentationsToLoad({ tray24: false, tray32: false }).length === 0);
}

(async () => {
  testIcons();
  testTrayRepresentations();
  testRegistry();
  testSettingsStore();
  testQuotaMath();
  testQuotaView();
  testTrayLine();
  testConnectorClassifiers();
  testConnectorHelpers();
  testZaiQuotaParsing();
  testCodexAtomicWrite();
  testCodexSparkBuckets();
  testCursorSpendTiles();
  testOpencodeQuota();
  await testOpencodeUnavailableStates();
  testGrokQuota();
  testDevinQuota();
  await testAntigravityQuota();
  testModelPricing();
  await testSpendScanner();
  testConnectorSpendExtractors();
  await testCodexCumulativeStateRestart();
  await testTranscriptWatcher();
  await testWebhook();
  console.log('---');
  if (failures === 0) {
    console.log('All smoke checks passed.');
    process.exit(0);
  } else {
    console.log(`${failures} check(s) failed.`);
    process.exit(1);
  }
})().catch(err => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
