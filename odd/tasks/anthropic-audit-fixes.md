# Feature: anthropic-audit-fixes

Branch: `261009-anthropic-audit-fixes` · Engram mirror: `odd/anthropic-audit-fixes/tasks`

## Objective
Apply every fix from the 2026-10-09 audit (Anthropic Console connector, Claude Code connector, model pricing, UI/UX).

## Problem / why
- Anthropic Admin API spend never shows (cost `amount` is a cents string), month-to-date covers only 7 days (pagination), cache-write tokens always 0.
- Claude Code local spend is ~2x overcounted (duplicate usage per content block), 1h cache writes underpriced, advisor iterations uncounted, fast mode unpriced.
- Price table is stale for Opus 5.5, Haiku 5.5, Sonnet 5.5 cache reads.
- "Finished" notifications missed on ~62% of turns (trailing metadata lines); subagents spawn extra notifications.
- UI: "NaNd ago" activity, doubled units, first-run red errors, truncated popup errors, oversized empty spend card, undiscoverable row menu, misleading statuses, missing refresh feedback, copy/contrast issues.

## Constraints
- Connector ids and bucket ids are persisted settings keys: never rename.
- No new dependencies, no bundler, no renderer framework, CommonJS, English artifacts, conventional commits without attribution lines.
- Never refresh/rewrite other tools' credentials; do not use the Claude OAuth token.
- After tokens.css changes run `node scripts/check-contrast.js`.

## Delivery
Strategy: ask-on-risk. Forecast > 400 authored lines (≈1500–2500). Chain strategy: single-pr (user choice 2026-10-09).

## Tasks
Route: all delegated (writer trigger: 2+ non-trivial files per stream). Parallel writers run in isolated git worktrees, merged into the feature branch by the parent.

- [x] A — Anthropic Admin API parsing (Opus): cents-string `amount`, USD check, `limit=31` + `next_page` pagination on usage and cost, nested `cache_creation` 5m/1h, 401/403 message, help URL, real-shape fixtures.
- [x] B — Pricing table (Opus): Opus 5.5, Haiku 5.5 (100K prompt-only tier), Sonnet 5.5 cache read, 1h cache-write rate field, fast-mode multiplier, PRICING_VINTAGE.
- [x] C — Claude Code spend (Opus, after B): dedupe by message.id+requestId, 5m/1h split, fast tier, advisor iterations, spend shown without claude.ai login, CLAUDE_CONFIG_DIR, scanner cache version bump.
- [x] D — Watcher/detector (Sonnet): ignore unknown trailing lines, skip subagent transcripts for notifications only.
- [x] E — UI fixes (Sonnet): event ts, unit doubling + USD format, empty spend card, 2-line errors, statuses Off/Needs setup, platform wording, refresh/login feedback, copy, contrast/disabled, small a11y.
- [x] G — First-run "not detected" state + popup error actions (Opus, after E): neutral notDetected outcome for Cursor/Codex/OpenCode, sign-in button in popup, deep-link popup → connector drawer.
- [x] H — Follow-ups (Sonnet, after G): six non-blocking review findings + show spend on ok:false snapshots in renderer + sub-cent rounding (optional).
- [x] F — Docs (Sonnet, last): CONNECTOR-SOURCES.md, DESIGN.md, ARCHITECTURE.md, CLAUDE.md IPC table.
- [x] V — Full verification (Haiku): tsc, npm test, npm run smoke, check-contrast.

## Acceptance criteria
`npx tsc --noEmit`, `npm test`, `npm run smoke`, `node scripts/check-contrast.js` all pass; each finding fixed or explicitly deferred below.

## Progress / evidence
- A: delegated (Opus, worktree). Commit 25c7b61; vendor premises re-verified 2026-10-09; npm test 455 pass, smoke pass (writer); parent tsc after merge clean. Not verified live (no admin key).
- D: delegated (Sonnet, worktree). Commit 455cb1d, merged 38975fb. tsc clean; npm test 451 pass; smoke pass (writer-reported); parent tsc re-run clean.
- B: delegated (Opus, worktree). Commit ea16f95 + smoke fix; rates confirmed against vendor page 2026-10-09; geo 1.1x deferred. Parent smoke re-run: pass.
- C: delegated (Opus, worktree). Commit 10b5510. Local 7-day spend $580.15 -> $330.58 (dedupe; advisor adds ~$29.5). Parent after merge: tsc clean, npm test 504/504. Renderer still hides spend on ok:false snapshots -> task H.
- G: delegated (Opus, worktree). Commits 869489d, 558def1. Parent after merge: tsc clean, npm test 520/520, smoke pass.
- F: delegated (Sonnet, worktree). Commit 8614366; structural readback + grep of every documented name (writer). Rounding limitation line pending H outcome.
- H: delegated (Sonnet, worktree). Commits 8b7ee43, 5315893, cbf1a98 (writer: 530 tests pass, smoke, contrast). RED observed only for items 7-8. Docs aligned by parent.
- Review slice 795e102..HEAD (risk medium, slice budget): consent granted; native review APPROVED and acknowledged (lineage review-020991af7be425f5). Follow-ups fixed in 8ccc474 (login label restore, dedupe across cache reload test).
- V: delegated (Haiku). tsc clean; npm test 530/530; smoke pass; check-contrast pass; tree clean; 0 attribution lines. Parent re-run after 8ccc474: npm test 533/533.
- Release: version 0.4.0 (main and latest tag v0.3.6).
- E: delegated (Sonnet, worktree). Commits 3f327f8, 8ccfecb. Row ⋯ button placed on meter rows (menu is per bucket). Finished-pill mismatch moved to G (detector snippet). Parent re-run after merge: tsc, smoke, check-contrast pass. Visuals not checked on screen yet.
- Review slice 6ae6bd9..A+B+D+E (risk high): consent granted; 4-lens native review APPROVED, acknowledged (lineage review-250d67cc15620e93, authority burned). Non-blocking follow-ups queued as task H: notifier onRecord throw blocks notification; anthropic MAX_PAGES partial sum shown as complete; duplicate busy-state in settings sign-in; hasMissingQuotaSecret naming; split main CSS rule; CLAUDE_CONFIG_DIR untested.

## Deferred
- inference_geo "us" 1.1x pricing (no reliable scoping for 4.5 vs 4.6).
- Removing the duplicate popup header settings icon (design call, kept).
