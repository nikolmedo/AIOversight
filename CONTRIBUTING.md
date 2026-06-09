# Contributing to AI Oversight

## Prerequisites

- **Node.js 20+** (the CI workflow uses Node 20)
- **Git**
- macOS, Windows 10/11, or Linux

No other global tools are required. The build is pure TypeScript → CommonJS via `tsc`, with no native addons and no bundler.

---

## First-time setup

```bash
git clone https://github.com/<your-fork>/AIOversight.git
cd AIOversight
npm install          # installs deps + auto-generates tray icons (postinstall hook)
npm run build        # compile TypeScript + copy renderer assets
npm run dev          # launch Electron in dev mode
```

If `npm run dev` opens the tray icon (system tray on Windows/Linux, menu bar on macOS), the setup is working.

---

## Development workflow

```bash
# Type-check without compiling (fast feedback loop)
npx tsc --noEmit

# Full build
npm run build

# Launch
npm run start        # from existing dist/ (no recompile)
npm run dev          # recompile then launch

# Run headless integration tests
npm run smoke

# Clean build output
npm run clean
```

There is no hot-reload. After changing TypeScript source, run `npm run build` and relaunch `npm run start`.

---

## Project structure

```
src/
  main/
    index.ts              Electron entry point, IPC handlers, tray, settings window
    settings-store.ts     Disk persistence
    secret-store.ts       Encrypted credential storage (Electron safeStorage)
    notifier.ts           Notification policy (cooldown, quiet hours, kind filter)
    tray.ts               System tray icon and context menu
    tray-popup.ts         Floating quota popup window
    connectors/
      registry.ts         ALL_CONNECTORS array — the only place to register connectors
      runtime.ts          Detector lifecycle + ConnectorContext factory
      quota-service.ts    Quota polling loop
      secret-store.ts     (see above)
      types.ts            All shared TypeScript interfaces
      shared/             Reusable helpers (TranscriptWatcher, chromium-cookies)
      <id>/               One folder per connector
  preload/
    settings.ts           Context bridge for the settings window
    tray-popup.ts         Context bridge for the tray popup
  renderer/
    settings.ts           Settings window renderer (vanilla TypeScript)
    tray-popup.ts         Tray popup renderer (vanilla TypeScript)
    global.d.ts           Ambient type declarations for the settings renderer
    tray-popup-global.d.ts Ambient types for the tray popup renderer

scripts/
  generate-icons.js       Generates PNG icon files at npm install time
  copy-renderer.js        Copies HTML/assets from src/ to dist/ after tsc
  smoke.js                Headless integration test suite

assets/                   Build resources (entitlements, installer config)
build/                    macOS entitlements
```

---

## Adding a connector

Read `src/main/connectors/README.md` for the complete guide. The short version:

1. Create `src/main/connectors/<id>/index.ts` with a `Connector` object.
2. Add it to `ALL_CONNECTORS` in `src/main/connectors/registry.ts`.
3. If the connector has a detector, add classifier test cases in `scripts/smoke.js`.
4. Run `npm run smoke` to verify.

No other file needs to know the connector exists.

---

## Testing

There is no test framework. The test suite is a single Node.js script:

```bash
npm run smoke
```

This runs against the compiled `dist/` output (call `npm run build` first). It does **not** require Electron. It covers:

- Registry integrity — all connectors present, all `configSchema` field types valid
- `TranscriptWatcher` — idle detection, `waiting`/`finished` dispatch, mtime-based dedup
- JSONL classifiers — Cursor, Claude Code, Codex CLI `extractStatus` functions
- `WebhookDetector` — HTTP server, token auth, kind mapping, `/health` endpoint

When adding or changing a connector detector, add corresponding test cases in the smoke script.

**CI gap:** the release workflow (`release.yml`) does not run the smoke test. It goes straight from build to package. Run `npm run smoke` locally before opening a PR.

---

## Code style

- **TypeScript strict mode** is the linter. There is no ESLint or Prettier.
- Run `npx tsc --noEmit` before committing. Zero errors is required.
- **No bundler.** Plain `tsc` compiles everything. Do not add webpack, vite, rollup, or esbuild.
- **No renderer framework.** The renderer is vanilla TypeScript + DOM. Do not add React, Vue, or similar.
- **CommonJS only.** `module: "CommonJS"` in tsconfig. Avoid ESM-only packages.
- **English for all code.** Identifiers, comments, UI copy, commit messages — always English.
- Default to writing **no comments**. Add one only when the *why* is non-obvious.

---

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(connector): add Gemini quota provider
fix(webhook): handle body > 16 KB gracefully
refactor(runtime): extract contextFor into separate method
docs: update connector authoring guide
```

Do not add `Co-Authored-By` lines.

---

## Pull request process

1. Fork the repo and create a branch: `git checkout -b feat/my-connector`
2. Make your changes, run `npx tsc --noEmit` and `npm run smoke`
3. Open a PR against `main` with a clear description of what and why
4. Connector PRs should include an entry in the connector table in `README.md`

---

## Release process

Releases are fully automated via GitHub Actions (`release.yml`). To cut a release:

1. Bump `version` in `package.json`
2. Commit: `git commit -m "chore: bump version to X.Y.Z"`
3. Tag: `git tag vX.Y.Z`
4. Push: `git push origin main --tags`

The workflow triggers on `v*` tags, builds for all three platforms (macOS, Windows, Linux), and uploads artifacts to a GitHub Release automatically.

**Artifacts produced:**

| Platform | Files |
|---|---|
| macOS | `.dmg` (x64, arm64), `.zip` (x64, arm64) |
| Windows | NSIS installer `.exe`, portable `.exe` (x64) |
| Linux | AppImage |

To build locally for the current platform: `npm run package`. Platform-specific: `npm run package:mac`, `npm run package:win`, `npm run package:linux`.

---

## Architecture notes for contributors

See `docs/ARCHITECTURE.md` for the internal architecture (process model, IPC contract, data flows).

The connector framework is documented in `src/main/connectors/README.md`.

Agent instructions for Claude Code are in `CLAUDE.md`.
