# CLAUDE.md — Agent Instructions for AI Oversight

This file is loaded automatically by Claude Code. Follow these instructions when working on this project.

---

## Quick reference

```bash
npx tsc --noEmit          # type-check only (fast — run after every change)
npm run build             # compile TypeScript + copy renderer assets
npm run dev               # build then launch Electron in dev mode
npm test                  # unit tests (node:test, compiled to dist-test/, no Electron required)
npm run smoke             # headless integration tests (no Electron required)
npm run package           # build + package for the current platform
npm run clean             # delete dist/, dist-test/ and release/
```

**Always run `npx tsc --noEmit` after any TypeScript change before declaring done.**
Run `npm test` and `npm run smoke` after changes that touch connector logic, the IPC layer, or the runtime.

---

## Architecture at a glance

```
Electron main process (src/main/)
  ├── index.ts              — app entry, IPC handlers, tray, settings window
  ├── settings-store.ts     — disk persistence (OS userData/settings.json)
  ├── notifier.ts           — notification dispatch policy
  ├── updater.ts            — update checks / install via electron-updater (platform capability matrix)
  ├── autostart.ts          — launch-at-login
  ├── tray.ts / tray-popup.ts
  └── connectors/
        ├── registry.ts     — single source of truth for all connectors
        ├── runtime.ts      — detector lifecycle + ConnectorContext factory
        ├── quota-service.ts — quota polling loop (backoff, Retry-After, 45s fetch budget)
        ├── secret-store.ts — encrypted credential storage (safeStorage)
        ├── types.ts        — Connector / QuotaSnapshot contract
        ├── types-parity.ts — compile-time guard keeping renderer types in sync with types.ts
        ├── shared/         — transcript watcher, spend scanner, model pricing, Chromium cookies
        └── <id>/index.ts   — self-contained connector declaration

Preload scripts (src/preload/)  — context bridge, exposes window.aw / window.awPopup

Renderer (src/renderer/)        — vanilla TypeScript, no framework, CommonJS output
  ├── settings.ts / settings.html / settings.css
  ├── tray-popup.ts / tray-popup.html / tray-popup.css
  ├── quota-view.ts / quota-math.ts — meter rendering + pace/format math shared by both windows
  ├── update-banner.ts      — "update available" banner markup shared by both windows
  ├── tokens.css            — design tokens shared by both windows
  └── global.d.ts / tray-popup-global.d.ts / quota-types.d.ts — ambient types
```

The renderer has **no direct access to Node.js** — all cross-process calls go through the preload bridge (`window.aw`). The preload bridge is typed in `src/renderer/global.d.ts` (ambient declarations, no imports).

---

## Connector framework

Every integration lives in `src/main/connectors/<id>/`. The `Connector` object in `index.ts` declares everything:

| Field | When to use |
|---|---|
| `detector` | The tool produces JSONL transcripts or events we can detect |
| `quota` | The tool has an API that returns usage/billing data |
| `login` | The app itself can run the sign-in (OAuth / browser). Only then does `needsLogin: true` show a sign-in button; without `login`, the `error` text must carry the instruction |
| `quotaEnabledByDefault` | Quota works without any extra config (e.g. reads a local file) |
| `integrateInfo` | The connector is an HTTP server — drives the curl example on the Advanced → Webhook page |
| `brandColor` | Optional hex accent; falls back to a slot of the categorical palette (`--cat-N` in `tokens.css`) in the renderer |

Connectors never refresh or rewrite another tool's credential files (e.g. Codex CLI's or Grok CLI's `auth.json`): an expired session returns `needsLogin: true` with an instruction to sign in with that tool.

A quota snapshot sets `appNotRunning: true` only when its sole source is a desktop app that isn't running (Antigravity). `error` carries the notice; the tray popup and tooltip hide the connector, settings shows a neutral notice, and the poller does not back off.

**Adding a connector: edit only `registry.ts`.** All other files (settings store, IPC, UI) iterate `ALL_CONNECTORS` generically. See `src/main/connectors/README.md` for the full authoring guide.

---

## IPC channel reference

### Settings window → main (request/response)

| Channel | Arguments | Returns |
|---|---|---|
| `settings:get` | — | `{ connectors: ConnectorMetadata[], settings: AppSettings, paused, settingsPath, quotas, platform, updates: UpdateState }` |
| `connectors:setEnabled` | `id, { notifications?, quota? }` | `AppSettings` |
| `connectors:setConfig` | `id, config` | `AppSettings` |
| `connectors:setSecret` | `id, key, value \| null` | `ConnectorMetadata[]` |
| `connectors:setPollOverride` | `id, minutes \| null` | `AppSettings` |
| `connectors:setBucketPref` | `id, bucketId, Partial<BucketPref>` | `AppSettings` |
| `settings:update` | `patch` | `AppSettings` |
| `settings:setPopupShortcut` | `accelerator` | `{ ok, reason? }` |
| `settings:clearEvents` | — | `AppSettings` |
| `settings:togglePause` | — | `boolean` |
| `settings:logs` | — | `LogEntry[]` |
| `settings:testNotification` | — | `{ ok, reason? }` |
| `quota:get` | — | `Record<string, QuotaSnapshot>` |
| `quota:refresh` | `id?` | `QuotaSnapshot \| null` (with `id`) or `Record<string, QuotaSnapshot>`; bypasses the poller's backoff gate |
| `connector:login:${id}` | — | `true` |
| `updates:get` | — | `UpdateState` |
| `updates:check` | — | `UpdateState` (never rejects; failures end in `status: 'error'`) |
| `updates:download` | — | `UpdateState`; no-op unless `canInstall` and `status: 'available'` |
| `updates:install` | — | — (quits and installs; no-op unless `status: 'downloaded'`) |
| `updates:openRelease` | — | — (opens the GitHub release page for `latestVersion`) |
| `updates:dismiss` | — | `UpdateState` (hides the banner for this version until restart) |

### Main → settings window (push)

| Channel | Payload |
|---|---|
| `event` | `AgentEvent` |
| `log` | `LogEntry` |
| `paused` | `boolean` |
| `quota:update` | `{ id: string; snapshot: QuotaSnapshot }` |
| `updates:state` | `UpdateState` |

### Tray popup IPC

Channels prefixed with `trayPopup:` — bridge in `src/preload/tray-popup.ts` (`window.awPopup`), handlers in `src/main/index.ts` and `src/main/tray-popup.ts`.

| Channel | Direction | Arguments | Returns / payload |
|---|---|---|---|
| `trayPopup:openSettings` | invoke | — | — |
| `trayPopup:getQuotas` | invoke | — | `Record<string, QuotaSnapshot>` |
| `trayPopup:getConnectors` | invoke | — | `ConnectorMetadata[]` |
| `trayPopup:getBucketPrefs` | invoke | — | `bucketPrefs` map |
| `trayPopup:getUiPrefs` | invoke | — | `{ theme, density, timeFormat, transparentPopup, showSpendCard }` |
| `trayPopup:refresh` | invoke | `id?` | `{ [id]: QuotaSnapshot }` (with `id`) or the full map |
| `trayPopup:setBucketPref` | invoke | `id, bucketId, Partial<BucketPref>` | `bucketPrefs` map |
| `trayPopup:getUpdateState` | invoke | — | `UpdateState` |
| `trayPopup:downloadUpdate` | invoke | — | `UpdateState` |
| `trayPopup:installUpdate` | invoke | — | — |
| `trayPopup:openRelease` | invoke | — | — |
| `trayPopup:dismissUpdate` | invoke | — | `UpdateState` |
| `trayPopup:resize` | send (popup → main) | `height` | — |
| `trayPopup:quotas` | push (main → popup) | `Record<string, QuotaSnapshot>` | — |
| `trayPopup:visibility` | push (main → popup) | `boolean` | — |
| `trayPopup:updateState` | push (main → popup) | `UpdateState` | — |

---

## Key conventions

- **No bundler.** The project uses plain `tsc` → CommonJS. Do not introduce webpack, vite, rollup, or esbuild.
- **No renderer framework.** The renderer is vanilla TypeScript with DOM APIs. Do not add React, Vue, or similar.
- **CommonJS only.** `module: "CommonJS"` in tsconfig. Do not use `import.meta`, top-level `await`, or ESM-only packages.
- **English for all artifacts.** Code, identifiers, comments, UI copy, commit messages — always English.
- **Conventional commits.** No `Co-Authored-By` lines.
- **Connector IDs are stable.** A connector's `id` string is a settings key stored on disk. Never rename it after release.
- **Secrets never leave the main process.** The preload bridge never sends raw secret values; it only sends which keys *exist* (`setSecretKeys`). The renderer uses `setConnectorSecret` to write, never to read.
- **`tsc --noEmit` is the linter.** There is no ESLint or Prettier. TypeScript strict mode is the style enforcer.
- **Version bumps are verified last.** Before committing a `version` change in `package.json`, re-check it against `main` (`git show origin/main:package.json`) and the highest published tag (`git tag --list 'v*' --sort=-v:refname | head -1`). The new version must be strictly higher than both; a repeated version makes the tag push fail and leaves installed apps without an update.
- **Branches.** Name branches `YYMMDD-short-description` (e.g. `260805-update`, `260916-ui-redesign`). Work lands on `main` via PR.
- **License is Apache-2.0.** `LICENSE`, `README.md` and `package.json` must agree.
- **Connector sources are recorded.** When changing a connector's data source, auth, or parsing, re-verify the source and update its section in `docs/CONNECTOR-SOURCES.md` (grade and "Last verified" date).
- **Design tokens pass contrast.** After changing `src/renderer/tokens.css`, run `node scripts/check-contrast.js` (WCAG AA, both themes).

---

## Launching Electron from an agent shell

- Unset `ELECTRON_RUN_AS_NODE` (`env -u ELECTRON_RUN_AS_NODE ...`), or Electron runs as plain Node and crashes.
- Pass `--user-data-dir=<temp dir>`; otherwise the app can exit silently with code 0. Add `--lang=en-US` for screenshots.
- On Windows call `./node_modules/.bin/electron.cmd .`, not `npx electron .`.
- In Git Bash, `gh api /path` is rewritten to a file path: drop the leading slash or set `MSYS_NO_PATHCONV=1`.
- Details: "Running and capturing the app from an automated/agent shell" in `CONTRIBUTING.md`.

---

## Things NOT to do

- Do not hardcode connector IDs outside a connector's own `index.ts`. Any `if (id === 'some-connector')` in `index.ts`, `settings-store.ts`, or the renderer is a smell.
- Do not modify `safeStorage` fallback behavior (the consent file path in `secret-store.ts`) without reading the Electron docs and understanding the implications per platform.
- Do not add new production npm dependencies without a strong reason. The dependency list is intentionally minimal.
- Do not touch `scripts/generate-icons.js` unless the icon glyph or the set of generated files needs changing — it is deliberately self-contained and dependency-free. It also writes the Windows tray `.ico` files.
- Do not run `electron-builder` in CI manually; the GitHub Actions workflow handles packaging.

---

## Common tasks

### Verify a change compiles
```bash
npx tsc --noEmit
```

### Run the full test suite
```bash
npm test
npm run smoke
```

### Launch the app in dev mode
```bash
npm run dev
```

### Add a new connector
1. Create `src/main/connectors/<id>/index.ts` — see `src/main/connectors/README.md`
2. Add it to `ALL_CONNECTORS` in `src/main/connectors/registry.ts`
3. Add classifier test cases in `scripts/smoke.js` if the connector has a detector; add `tests/unit/quota-providers/<id>.test.ts` if it has a quota provider
4. Run `npm test` and `npm run smoke` to verify

### Change the IPC surface
1. Update the handler in `src/main/index.ts`
2. Update the bridge method in `src/preload/settings.ts`
3. Update the type declaration in `src/renderer/global.d.ts`
4. Update the call site in `src/renderer/settings.ts`

### Add a config field to an existing connector
1. Add the field to `configSchema` in the connector's `index.ts`
2. Run `npm run build` — `defaultConfig()` in `settings-store.ts` picks it up automatically

---

## Smoke test structure

`scripts/smoke.js` is a headless Node.js integration test that runs against the compiled `dist/`. It does not require Electron. It covers:

- Registry integrity (all connectors present, field types valid)
- Renderer math and markup run headless: `quota-math` (pace / format), `quota-view` (meter rows, groups, spend card), `update-banner` (install vs. notify-only actions), and the tray line formatter
- `updater` capability matrix and the release artifact names it matches
- Quota parsers and helpers for individual connectors (Cursor, Z.ai, Codex CLI, OpenCode, Claude Code, Grok, Devin, Antigravity)
- `model-pricing` rates and the JSONL spend scanner cache
- `settings-store` bucket-pref sanitizing
- `TranscriptWatcher` idle detection, event dispatch, and dedup
- Each connector's JSONL classifier (`extractStatus`)
- `WebhookDetector` HTTP server (POST `/notify`, token auth, `/health`)

When adding a connector with a detector, add classifier test cases to `scripts/smoke.js` under the appropriate section.

## Unit test structure

`npm test` compiles `src/` and `tests/` with `tsconfig.test.json` into `dist-test/` and runs `node --test` on every `*.test.js`. No extra dependencies and no Electron:

- `tests/unit/` — one file per module (quota service, runtime, registry, notifier, settings/secret stores, pricing, classifiers, …); quota provider tests in `tests/unit/quota-providers/<id>.test.ts` (Claude Code and OpenRouter have none yet)
- `tests/helpers/electron-stub.ts` — replaces `require('electron')`; import it **first** in any test that loads Electron-touching code
- `tests/helpers/fake-context.ts` — fake `ConnectorContext` (captures emitted events, logs, secrets)
- `tests/helpers/fixtures.ts`, `tests/helpers/temp-dir.ts` — canned API responses and temp directories

---

## Build output layout

```
dist/
  main/        # compiled main process + connectors
  preload/     # compiled preload bridges
  renderer/    # HTML + compiled renderer + copied assets
```

`npm run build` = `tsc` + `node scripts/copy-renderer.js` (copies every non-`.ts` file — HTML, CSS — from `src/renderer/` to `dist/renderer/`, and the top-level `assets/` to `dist/renderer/assets/`).

---

## Further reading

- `docs/CONNECTOR-SOURCES.md` — per-connector vendor endpoints, auth, evidence grade, last verified date, alternatives and known gaps. Read before touching a connector.
- `docs/DESIGN.md` — UI design system: tokens, contrast rule, page structure, component rules.
- `docs/ARCHITECTURE.md` — internals, including "Known limitations / deferred work".
- `scripts/readme-assets/README.md` — how to regenerate README screenshots, cover and social preview.
