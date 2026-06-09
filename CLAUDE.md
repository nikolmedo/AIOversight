# CLAUDE.md — Agent Instructions for AI Oversight

This file is loaded automatically by Claude Code. Follow these instructions when working on this project.

---

## Quick reference

```bash
npx tsc --noEmit          # type-check only (fast — run after every change)
npm run build             # compile TypeScript + copy renderer assets
npm run dev               # build then launch Electron in dev mode
npm run smoke             # headless integration tests (no Electron required)
npm run package           # build + package for the current platform
npm run clean             # delete dist/ and release/
```

**Always run `npx tsc --noEmit` after any TypeScript change before declaring done.**
Run `npm run smoke` after changes that touch connector logic, the IPC layer, or the runtime.

---

## Architecture at a glance

```
Electron main process (src/main/)
  ├── index.ts              — app entry, IPC handlers, tray, settings window
  ├── settings-store.ts     — disk persistence (OS userData/settings.json)
  ├── secret-store.ts       — encrypted credential storage (safeStorage)
  ├── notifier.ts           — notification dispatch policy
  ├── tray.ts / tray-popup.ts
  └── connectors/
        ├── registry.ts     — single source of truth for all connectors
        ├── runtime.ts      — detector lifecycle + ConnectorContext factory
        ├── quota-service.ts — quota polling loop
        └── <id>/index.ts   — self-contained connector declaration

Preload scripts (src/preload/)  — context bridge, exposes window.aw / window.awPopup

Renderer (src/renderer/)        — vanilla TypeScript, no framework, CommonJS output
  ├── settings.ts / settings.html
  └── tray-popup.ts / tray-popup.html
```

The renderer has **no direct access to Node.js** — all cross-process calls go through the preload bridge (`window.aw`). The preload bridge is typed in `src/renderer/global.d.ts` (ambient declarations, no imports).

---

## Connector framework

Every integration lives in `src/main/connectors/<id>/`. The `Connector` object in `index.ts` declares everything:

| Field | When to use |
|---|---|
| `detector` | The tool produces JSONL transcripts or events we can detect |
| `quota` | The tool has an API that returns usage/billing data |
| `login` | The quota provider can return `needsLogin: true` (OAuth / browser sign-in) |
| `quotaEnabledByDefault` | Quota works without any extra config (e.g. reads a local file) |
| `integrateInfo` | The connector is an HTTP server — drives the Integrate tab curl example |

**Adding a connector: edit only `registry.ts`.** All other files (settings store, IPC, UI) iterate `ALL_CONNECTORS` generically. See `src/main/connectors/README.md` for the full authoring guide.

---

## IPC channel reference

### Settings window → main (request/response)

| Channel | Arguments | Returns |
|---|---|---|
| `settings:get` | — | `{ connectors: ConnectorMetadata[], settings: AppSettings, paused, settingsPath, quotas }` |
| `connectors:setEnabled` | `id, { notifications?, quota? }` | `AppSettings` |
| `connectors:setConfig` | `id, config` | `AppSettings` |
| `connectors:setSecret` | `id, key, value \| null` | `ConnectorMetadata[]` |
| `connectors:setPollOverride` | `id, minutes \| null` | `AppSettings` |
| `settings:update` | `patch` | `AppSettings` |
| `settings:clearEvents` | — | `AppSettings` |
| `settings:togglePause` | — | `boolean` |
| `settings:logs` | — | `LogEntry[]` |
| `settings:testNotification` | — | `{ ok, reason? }` |
| `quota:get` | — | `Record<string, QuotaSnapshot>` |
| `quota:refresh` | `id?` | `QuotaSnapshot \| Record<string, QuotaSnapshot>` |
| `connector:login:${id}` | — | `true` |

### Main → settings window (push)

| Channel | Payload |
|---|---|
| `event` | `AgentEvent` |
| `log` | `LogEntry` |
| `paused` | `boolean` |
| `quota:update` | `{ id: string; snapshot: QuotaSnapshot }` |

### Tray popup IPC

Channels prefixed with `trayPopup:` — see `src/preload/tray-popup.ts` and `src/main/index.ts`.

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

---

## Things NOT to do

- Do not hardcode connector IDs outside a connector's own `index.ts`. Any `if (id === 'some-connector')` in `index.ts`, `settings-store.ts`, or the renderer is a smell.
- Do not modify `safeStorage` fallback behavior (the consent file path in `secret-store.ts`) without reading the Electron docs and understanding the implications per platform.
- Do not add new production npm dependencies without a strong reason. The dependency list is intentionally minimal.
- Do not touch `scripts/generate-icons.js` unless the icon glyph needs changing — it is deliberately self-contained and dependency-free.
- Do not run `electron-builder` in CI manually; the GitHub Actions workflow handles packaging.

---

## Common tasks

### Verify a change compiles
```bash
npx tsc --noEmit
```

### Run the full test suite
```bash
npm run smoke
```

### Launch the app in dev mode
```bash
npm run dev
```

### Add a new connector
1. Create `src/main/connectors/<id>/index.ts` — see `src/main/connectors/README.md`
2. Add it to `ALL_CONNECTORS` in `src/main/connectors/registry.ts`
3. Add classifier test cases in `scripts/smoke.js` if the connector has a detector
4. Run `npm run smoke` to verify

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
- `TranscriptWatcher` idle detection, event dispatch, and dedup
- Each connector's JSONL classifier (`extractStatus`)
- `WebhookDetector` HTTP server (POST `/notify`, token auth, `/health`)

When adding a connector with a detector, add classifier test cases to `scripts/smoke.js` under the appropriate section.

---

## Build output layout

```
dist/
  main/        # compiled main process + connectors
  preload/     # compiled preload bridges
  renderer/    # HTML + compiled renderer + copied assets
```

`npm run build` = `tsc` + `node scripts/copy-renderer.js` (copies HTML/assets from `src/renderer/` to `dist/renderer/`).
