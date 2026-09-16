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

# Run unit tests
npm test

# Run headless integration tests
npm run smoke

# Clean build output (dist/, dist-test/, release/)
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
    notifier.ts           Notification policy (cooldown, quiet hours, kind filter)
    autostart.ts          Launch at login
    tray.ts               System tray icon and context menu
    tray-popup.ts         Floating quota popup window
    connectors/
      registry.ts         ALL_CONNECTORS array — the only place to register connectors
      runtime.ts          Detector lifecycle + ConnectorContext factory
      quota-service.ts    Quota polling loop (backoff, Retry-After, fetch timeout)
      secret-store.ts     Encrypted credential storage (Electron safeStorage)
      types.ts            All shared TypeScript interfaces
      types-parity.ts     Compile-time guard: renderer quota types stay assignable to types.ts
      shared/             Reusable helpers (TranscriptWatcher, JSONL spend scanner, model pricing, chromium-cookies)
      <id>/               One folder per connector
  preload/
    settings.ts           Context bridge for the settings window
    tray-popup.ts         Context bridge for the tray popup
  renderer/
    settings.ts/.html/.css    Settings window (vanilla TypeScript)
    tray-popup.ts/.html/.css  Tray popup (vanilla TypeScript)
    quota-view.ts         Meter / spend-card markup shared by both windows
    quota-math.ts         Pace and formatting math shared by both windows
    tokens.css            Design tokens imported by both stylesheets
    global.d.ts           Ambient type declarations for the settings renderer
    tray-popup-global.d.ts Ambient types for the tray popup renderer
    quota-types.d.ts      Ambient quota/connector types shared by both renderers

tests/
  unit/                   node:test unit tests (quota provider tests in quota-providers/<id>.test.ts)
  helpers/                Electron stub, fake ConnectorContext, fixtures, temp dirs

scripts/
  generate-icons.js       Generates PNG and Windows tray .ico files at npm install time
  copy-renderer.js        Copies HTML/CSS and assets/ from src/ to dist/ after tsc
  smoke.js                Headless integration test suite
  electron-quota-test.js  Manual check: fetches every quota provider with your stored settings (run with `electron`)

assets/                   App and tray icons written by generate-icons.js (electron-builder buildResources)
build/                    macOS entitlements
```

---

## Adding a connector

Read `src/main/connectors/README.md` for the complete guide. The short version:

1. Create `src/main/connectors/<id>/index.ts` with a `Connector` object.
2. Add it to `ALL_CONNECTORS` in `src/main/connectors/registry.ts`.
3. If the connector has a detector, add classifier test cases in `scripts/smoke.js`. If it has a quota provider, add `tests/unit/quota-providers/<id>.test.ts`.
4. Run `npm test` and `npm run smoke` to verify.

No other file needs to know the connector exists.

---

## Testing

There are two suites, neither of which requires Electron or any extra test dependency.

**Unit tests** — Node's built-in `node:test` runner:

```bash
npm test
```

This compiles `src/` and `tests/` with `tsconfig.test.json` into `dist-test/`, then runs every `*.test.js`. Tests live in `tests/unit/` (quota providers under `tests/unit/quota-providers/<id>.test.ts`); shared helpers in `tests/helpers/` include an Electron stub that must be imported first in any test touching Electron-dependent code, and a fake `ConnectorContext`.

**Smoke tests** — a single headless Node.js script:

```bash
npm run smoke
```

This builds, then runs against the compiled `dist/` output. It covers:

- Registry integrity — all connectors present, all `configSchema` field types valid
- Renderer quota math, meter/spend-card markup, and the tray line formatter
- Per-connector quota parsers, model pricing, and the JSONL spend scanner
- `TranscriptWatcher` — idle detection, `waiting`/`finished` dispatch, mtime-based dedup
- JSONL classifiers — Cursor, Claude Code, Codex CLI `extractStatus` functions
- `WebhookDetector` — HTTP server, token auth, kind mapping, `/health` endpoint

When adding or changing a connector detector, add corresponding test cases in the smoke script.

**CI gap:** the release workflow (`release.yml`) runs neither `npm test` nor the smoke test. It goes straight from install to package. Run both locally before opening a PR.

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
2. Make your changes, run `npx tsc --noEmit`, `npm test` and `npm run smoke`
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
| macOS | `.dmg` (x64, arm64) |
| Windows | NSIS installer `.exe`, portable `.exe` (x64) |
| Linux | AppImage, `.deb`, `.tar.gz` |

`electron-builder.yml` also builds macOS `.zip` files, but the workflow only uploads `release/*.dmg`.

To build locally for the current platform: `npm run package`. Platform-specific: `npm run package:mac`, `npm run package:win`, `npm run package:linux`.

---

## Running and capturing the app from an automated/agent shell

Verified on a Windows dev machine while driving the app from Claude Code's shell. A normal interactive terminal may not need any of this.

- **`ELECTRON_RUN_AS_NODE`**: the shell had `ELECTRON_RUN_AS_NODE=1` set, which makes Electron run as plain Node. `require('electron')` then returns a path string, `app` is undefined, and the app crashes at `app.requestSingleInstanceLock()`. Launch with `env -u ELECTRON_RUN_AS_NODE`.
- **userData not writable**: the default userData directory was not writable from the sandboxed shell (GPU cache "Access denied"), and the app then exited silently with code 0 before `whenReady` (single-instance lock). Pass `--user-data-dir=<temp dir>`.
- **`npx electron .`** also ran as Node there. On Windows, use `./node_modules/.bin/electron.cmd .`.
- **Capturing pages** without clicking the tray: use `webContents.capturePage()` from a temporary, env-gated block inside `app.whenReady()` in `src/main/index.ts`. Always back up and restore `src/main/index.ts` and rebuild `dist/` afterwards. The README screenshot block and steps are in `scripts/readme-assets/README.md`.
- **Locale and scale**: pass `--lang=en-US` so numbers don't render in the OS locale (a Spanish locale printed `20.000`), and `--force-device-scale-factor=2` for 2x images.
- **`gh api` in Git Bash**: `gh api /path` gets rewritten to a filesystem path. Omit the leading slash (`gh api user`) or set `MSYS_NO_PATHCONV=1`.
- **Unit tests that exercise credential discovery** must isolate `PATH`, `APPDATA`, `USERPROFILE` and `HOME` (see `tests/unit/quota-providers/github-copilot.test.ts`). `node:child_process` exports are read-only getters, so stubbing `execFileSync` does not work; set `PATH` to an empty string so the spawn fails instead.

Example launch:

```bash
npm run build
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron.cmd . --user-data-dir="$(mktemp -d)" --lang=en-US
```

---

## Architecture notes for contributors

See `docs/ARCHITECTURE.md` for the internal architecture (process model, IPC contract, data flows).

The connector framework is documented in `src/main/connectors/README.md`. Vendor endpoints and their evidence are recorded in `docs/CONNECTOR-SOURCES.md`, and the UI design system in `docs/DESIGN.md`.

Agent instructions for Claude Code are in `CLAUDE.md`.
