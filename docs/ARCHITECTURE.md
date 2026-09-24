# Architecture

Internal reference for contributors and agents working on the AI Oversight codebase.

---

## Process model

AI Oversight is a standard Electron application with three process types:

```
┌─────────────────────────────────────────────────────┐
│  Main process (Node.js)                              │
│  src/main/index.ts                                   │
│                                                      │
│  SettingsStore  SecretStore  ConnectorRuntime        │
│  QuotaService   Notifier     Tray / TrayPopup        │
└────────────────────┬────────────────────────────────┘
                     │  IPC (contextBridge)
          ┌──────────┴──────────┐
          │                     │
┌─────────▼──────┐   ┌──────────▼──────────┐
│ Settings window│   │  Tray popup window  │
│ Renderer (DOM) │   │  Renderer (DOM)     │
│ src/renderer/  │   │  src/renderer/      │
│ settings.ts    │   │  tray-popup.ts      │
└────────────────┘   └─────────────────────┘
     ▲                        ▲
     │  preload bridge        │  preload bridge
src/preload/settings.ts   src/preload/tray-popup.ts
```

**Security posture:**
- Both renderer windows have `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false`
- The preload scripts use `contextBridge.exposeInMainWorld` to expose a typed API surface (`window.aw`, `window.awPopup`)
- Renderer code has zero direct access to Node.js or Electron APIs
- Raw secret values never cross the IPC bridge (only existence flags cross)

---

## Main process services

### SettingsStore (`settings-store.ts`)

Reads and writes `<userData>/settings.json`. Handles:
- Schema defaults — `defaultEnabled()` and `defaultConfig()` iterate `ALL_CONNECTORS` generically
- Legacy migration — old `detectors.*` shape from pre-0.2 builds is transparently upgraded
- Recent events — capped at 50 entries, prepended on new events
- Synchronous writes — the whole state is `JSON.stringify`-ed and written with `fs.writeFileSync` on every mutation (no temp-file + rename, so not atomic)

AppSettings shape:
```ts
{
  showNotifications, notifyOnWaiting, notifyOnFinished,
  perSessionCooldownMs, quietHours, quotaPollMinutes, showQuotaInTray,
  launchAtLogin, theme, density, timeFormat, transparentPopup,
  showSpendCard, popupShortcut, checkForUpdates, lastNotifiedUpdateVersion,
  connectors: { enabled, config, pollOverrideMinutes, bucketPrefs },
  recentEvents
}
```

### SecretStore (`connectors/secret-store.ts`)

Wraps Electron `safeStorage`:
- macOS: Keychain AES encryption
- Windows: DPAPI
- Linux: `libsecret` / fallback to plaintext with a consent file

Keys are namespaced as `<connectorId>::<fieldKey>` via `SecretStore.qualify()`.

Secrets are persisted to `<userData>/secrets.json`. When the platform cannot encrypt, values are stored in plaintext, a warning is logged, and a flag file (`<userData>/secrets.plaintext.allowed`) is written. The `ConnectorContext.secret(key)` and `ConnectorContext.setSecret(key, value)` methods are the only intended access paths for connector code.

### ConnectorRuntime (`connectors/runtime.ts`)

Owns the detector lifecycle:
- `applyConfig(rt)` — stops all running detectors, starts the enabled ones fresh
- `contextFor(connector)` — returns a `ConnectorContext` scoped to that connector (namespaced secrets, namespaced logs)
- Maintains a rolling 200-entry in-memory log buffer, emits `log` events for the settings window Logs page
- Resolves `~`, `$HOME`, `%APPDATA%`, `%LOCALAPPDATA%`, `%USERPROFILE%` in path strings

### QuotaService (`connectors/quota-service.ts`)

Runs a polling loop per connector:
- Interval: per-connector override, else the global `quotaPollMinutes`, else the connector's `defaultIntervalMinutes`; `0` means manual only (no timer). Minimum poll interval: 60 seconds (hard floor regardless of user setting)
- Every (re)configuration recreates the provider and fetches immediately
- Coalesces concurrent refresh calls — if a fetch is already in flight, the second caller awaits the same promise
- Fetch budget — each `provider.fetch()` is raced against a 45 s watchdog (`FETCH_BUDGET_MS`). On expiry the snapshot becomes `ok: false` ("timed out") and counts as an ordinary failure; the abandoned fetch's late result is discarded
- Backoff — each failure arms a gate for the periodic tick. If the snapshot carries `retryAfterMs` (e.g. from an HTTP 429 `Retry-After`), the next fetch waits that long from now; otherwise it waits `interval × 2^(failures − 1)` from the start of the failed fetch, capped at 30 minutes. A successful fetch clears the gate, and so does an `appNotRunning` snapshot (the connector's desktop app is closed): that is an expected state, so polling stays at the normal interval and data appears soon after the app opens. A skipped tick leaves the cached snapshot untouched
- Manual refresh — `refresh(id)` / `refreshAll()` (the Refresh buttons) bypass the backoff gate. Only explicit user actions call them; the tray popup has no timed refresh and renders the cached state that main pushes (`trayPopup:quotas`) after every fetch and on every show
- Caches the last `QuotaSnapshot` per connector
- Emits `update(id, snapshot)` after every fetch (success or failure), and `removed(id)` when a connector's quota is disabled
- `refreshAll()` fans out parallel calls to all enabled providers
- `destroy()` clears all timers on app quit

### Notifier (`notifier.ts`)

Applies notification policy before dispatching to the OS:
- Per-session cooldown keyed on `(sessionId, kind)` — prevents duplicate alerts within `perSessionCooldownMs` (default 30 s)
- Kind filter — `notifyOnWaiting` and `notifyOnFinished` toggles
- Quiet hours — compares wall-clock hour against `[startHour, endHour)` range
- Electron `Notification` — includes the app icon, dispatches click handler to reveal the source file in Finder/Explorer
- `notifyUpdate()` — the update notification; honors only `showNotifications` (not pause or quiet hours); click opens the settings window

### UpdateService (`updater.ts`)

Checks GitHub Releases (`nikolmedo/AIOversight`) for a newer version and installs it where the package allows. Built on `electron-updater`, which `index.ts` (`createUpdateService`) injects and only `require`s in packaged builds. `updater.ts` imports neither `electron` nor `electron-updater`, so `tests/unit/updater.test.ts` drives it with a fake emitter.

Capability matrix (`computeUpdateCapability`):

| Running from | Detection | Check source | Install |
|---|---|---|---|
| Not packaged (`npm run dev`) | `!app.isPackaged` | none, status `disabled` | no |
| Windows NSIS | `win32`, no `PORTABLE_EXECUTABLE_DIR` | `latest.yml` | yes, silent, relaunch |
| Windows portable | `PORTABLE_EXECUTABLE_DIR` set | `latest.yml` | no, release page |
| Linux AppImage | `APPIMAGE` set | `latest-linux.yml` | yes, relaunch |
| Linux deb | `resources/package-type` is `deb` | `latest-linux.yml` (DebUpdater) | no, release page |
| Linux tar.gz | none of the above | GitHub API `releases/latest`, asset ending in `.tar.gz` | no, release page |
| macOS | `darwin` | `latest-mac.yml` | no (unsigned; Squirrel.Mac requires signing), release page |

The GitHub API fallback runs whenever `autoUpdater.checkForUpdates()` resolves `null` (electron-updater inactive for that layout) and only reports an update when the latest release has an asset for the running package format (`assetMatchesTarget`).

Behavior:
- `autoDownload = false`: the user starts the download from the banner. `autoInstallOnAppQuit = true`, so a downloaded update is applied on the next quit even without clicking *Restart to update*.
- First check 30 s after launch, then every 6 h, only while `checkForUpdates` is on. The manual *Check for updates* button always works. No checks while a download runs or after it finished.
- States: `disabled`, `idle`, `checking`, `available`, `not-available`, `downloading` (with `progress`), `downloaded`, `error`. A failed check or download after an update was found keeps `available` and sets `error`, so the banner stays.
- Errors (offline, 404 for a release without `latest*.yml`) are logged at `warn` and never notify.
- One OS notification per version: `lastNotifiedUpdateVersion` is persisted in settings.
- The banner ignores pause. *Dismiss* hides it for that version until the app restarts (kept in memory in `UpdateService`, shared by both windows).
- `install()` runs `beforeInstall` (unregister shortcuts, destroy the popup and settings windows), then `quitAndInstall(true, true)`. Nothing in the app vetoes quitting (no `preventDefault` on `close` or `before-quit`), so the quit goes through.
- Every state change is pushed to the settings window (`updates:state`) and the tray popup (`trayPopup:updateState`). Both render `renderUpdateBanner` from `src/renderer/update-banner.ts`.

---

## Connector framework

See `src/main/connectors/README.md` for the authoring guide. Architectural notes:

### TranscriptWatcher (`connectors/shared/transcript-watcher.ts`)

Used by Cursor, Claude Code, Codex CLI, and generic-jsonl connectors. Internally:

1. `chokidar.watch(globs, { usePolling: true, interval: 250 })` — polling mode avoids inotify limits on large path sets
2. On `change` event: reads the last non-empty line of the JSONL file
3. Classifies the line via the connector-supplied `extractStatus(line)` hook
4. Starts an idle timer of `idleMs`; on expiry, emits the event
5. Resets the timer on any new change — only fires if the file is truly quiet
6. Deduplicates on `(file, mtime, kind)` — prevents re-notification on app restart or re-watch

### Quota providers

Each `QuotaProvider.fetch()` must return a `QuotaSnapshot`. The service stops waiting after 45 s, but providers should still put their own timeout on every request. Conventions:
- Set `needsLogin: true` when authentication is missing/expired. The UI shows a sign-in button only when the connector declares a `login` handler; otherwise the `error` string must tell the user how to sign in (e.g. "Run `codex login`")
- Return `ok: false` with a human-readable `error` string for transient API failures; set `retryAfterMs` when the vendor asks to back off
- Set `appNotRunning: true` (with the notice in `error`) only when the source is a desktop app that is not running. The tray popup and tooltip omit the connector, and the settings window shows a neutral notice instead of an error
- Use `null` for bucket values that are not measured; `0` means measured and genuinely zero
- Set `authMethod` in the `ok: true` response so the UI's footnote can explain what's being used
- Set `trayLine` for a custom one-line summary in the tray tooltip
- Read other tools' credentials, never refresh or rewrite them — Codex CLI and Grok CLI return `needsLogin` on an expired session instead of touching their `auth.json`

### Local spend estimates (`connectors/shared/jsonl-spend-scanner.ts`, `connectors/shared/model-pricing.ts`)

`JsonlSpendScanner` rolls token usage from local transcripts up into per-day totals with an on-disk cache under `ConnectorContext.cacheDir` (used by Claude Code, Codex CLI, Grok). `model-pricing.ts` is the single per-token rate table that turns those tokens into estimated cents (also used by OpenCode). Claude rates are keyed by model version, not just family, and the table is stamped with `PRICING_VINTAGE`; an unknown model prices to `null`, never `0`.

### chromium-cookies (`connectors/shared/chromium-cookies.ts`)

Reads Chromium's `Cookies` SQLite file directly — used when a browser-based session token is the fallback authentication method (Cursor, Anthropic). Supports:
- macOS v10 (`chrome-safe-storage` Keychain key + AES-128-CBC)
- Windows v10/v11 (DPAPI-encrypted DPAPIKEY + AES-256-GCM)
- Linux (`peanuts` PBKDF2 + AES-128-CBC)

---

## Data flow

### Agent event (notification path)

```
Transcript file changes
  → TranscriptWatcher.onChange()
    → extractStatus(line) → LineStatus
      → idle timer fires
        → ctx.emit({ sessionId, agent, kind, message })
          → ConnectorRuntime emits 'event'
            → main/index.ts onEvent handler
              → Notifier.handle(event)   [apply policy]
                → new Notification().show()
              → settingsWindow.webContents.send('event', event)
                → renderer: onEvent handler → renderEvents()
```

### Quota update path

```
QuotaService timer fires (per-connector interval)
  → QuotaProvider.fetch()
    → QuotaService caches snapshot
      → QuotaService emits update(id, snapshot)
        → main/index.ts onUpdate handler
          → settingsWindow.webContents.send('quota:update', { id, snapshot })
          → trayPopup.sendQuota(state)
          → refreshTrayQuotaSummary()
```

### Settings write path

```
User changes a setting in the renderer
  → window.aw.setConnector*() (preload bridge)
    → ipcMain.handle('connectors:set*')
      → SettingsStore.set*()         [persist to disk]
      → ConnectorRuntime.applyConfig()  [restart detectors if needed]
      → QuotaService.applyConfig()      [restart pollers if needed]
      → return updated AppSettings
```

---

## Build pipeline

```
npm run build
  = tsc -p tsconfig.json
  + node scripts/copy-renderer.js

tsc: src/**/*.ts → dist/**/*.js + *.js.map
     tsconfig.json: target ES2022, module CommonJS, strict
     All three process types (main, preload, renderer) compile together

copy-renderer.js: copies every non-.ts file in src/renderer/ (HTML, CSS) → dist/renderer/
                  copies top-level assets/ → dist/renderer/assets/

npm test
  = tsc -p tsconfig.test.json   (extends tsconfig.json; src/ + tests/ → dist-test/)
  + node --test "dist-test/tests/**/*.test.js"

npm install (postinstall):
  node scripts/generate-icons.js
    → writes assets/tray-icon-{16,24,32}.png, tray-icon-{16,24,32}-white.png,
      tray-icon.ico, tray-icon-white.ico (16/20/24/28/32/40/48 px PNG frames),
      tray-icon.png, tray-icon@2x.png, icon.png, ai-icon.png, ai-icon-no-bkg.png
      (pure Node.js, no binary dep — zlib.deflateSync + hand-crafted PNG chunks)
```

**Why no bundler?** The main process and preload scripts are CommonJS modules loaded directly by Electron's Node.js runtime. The renderer scripts are also CommonJS (loaded via `<script>` with no module bundling). A bundler would add complexity with no benefit given the vanilla approach.

**Why CommonJS?** Current Electron supports ESM in both the main process and renderer, but the transition requires careful `type: "module"` management across all three process types. The existing codebase is uniformly CommonJS and this is not a pain point.

---

## Packaging

`electron-builder` reads `electron-builder.yml`. Key decisions:

- `publish: github` makes electron-builder write `latest*.yml` next to the artifacts and `resources/app-update.yml` into the app; the scripts still pass `--publish never` and CI uploads the files (see `CONTRIBUTING.md`, Release process)
- `artifactName` templates use `${name}` (no spaces) with distinct `-setup-` / `-portable-` names on Windows, so GitHub does not rename assets and the `latest.yml` URLs stay valid
- Production dependencies (`chokidar`, `electron-updater` and its dependency tree) are collected into the asar by electron-builder automatically; the `files` list does not need to name them
- `sql.js` is explicitly whitelisted in `files` because it ships its own WASM binary that electron-builder would otherwise exclude
- macOS builds require `hardenedRuntime: true` and entitlements for notarization
- Windows NSIS installer is non-destructive (`oneClick: false`) and supports per-user install
- Icon files are generated at install time. Most are gitignored and untracked (`tray-icon.png`, `tray-icon@2x.png`, `tray-icon-{16,24,32}.png`, `tray-icon.ico`, `tray-icon-white.ico`, `icon.png`). Exceptions: `ai-icon.png` and `ai-icon-no-bkg.png` are listed in `.gitignore` but committed anyway (`README.md` uses `ai-icon.png` as its logo), and the `tray-icon-{16,24,32}-white.png` variants are not ignored and are committed. `postinstall` overwrites all of them. `files: assets/**/*` in `electron-builder.yml` packs them from disk, tracked or not
- Windows tray icon: `tray.ts` loads `tray-icon.ico` (light taskbar) or `tray-icon-white.ico` (dark taskbar, from `nativeTheme.shouldUseDarkColorsForSystemIntegratedUI`, which follows the Windows system mode rather than the app theme). The shell picks the frame for the current DPI. The PNGs with 1.5x/2x `addRepresentation` are only a fallback when the .ico is missing: on a 200% display Electron's tray used the 16px bitmap and Windows upscaled it, which made the icon blurry

---

## IPC surface

Complete reference in `CLAUDE.md`. The short invariants:

- All channels are handled in `registerIpc()` in `src/main/index.ts`
- Login channels (`connector:login:${id}`) are registered dynamically for connectors that declare `login`
- Tray popup channels are prefixed `trayPopup:`; `trayPopup:resize` (an `ipcMain.on` listener) and the `trayPopup:quotas` / `trayPopup:visibility` / `trayPopup:updateState` pushes live in `src/main/tray-popup.ts`
- Push channels (main → renderer) use `webContents.send()`; the renderer subscribes via the preload bridge's `on*` methods

---

## Known limitations / deferred work

Confirmed against the code on 2026-09-16; none of these are fixed yet.

- **QuotaService stale-write race.** `applyConfig` deletes and recreates a provider entry when config or secrets change. If a fetch from the old entry is still in flight, its closure in `fetchOne` still calls `this.snapshots.set(id, snap)` and emits `update`, so a snapshot from the old config can overwrite the new one. Fix: in `fetchOne`, skip the write and emit when `this.providers.get(id) !== entry`.
- **sql.js reads of live IDE databases.** Cursor (`state.vscdb`) and OpenCode (`opencode*.db`) are opened with `new SQL.Database(fs.readFileSync(dbPath))`. That is a plain file snapshot taken while the IDE may be writing; it ignores the `-wal` file and could read a torn state.
- **`.gitignore` vs tracked icons.** `assets/ai-icon.png` and `assets/ai-icon-no-bkg.png` are listed in `.gitignore` but tracked (see Packaging above).
- **macOS cannot auto-install updates.** The app is not code-signed, so `UpdateService` treats macOS as notify-only. Adding signing and notarization secrets to `release.yml` would allow turning on `canInstall` for `darwin` in `computeUpdateCapability`.
- **Linux `.deb` is notify-only by choice.** electron-updater 6.x ships a `DebUpdater` (installs through `pkexec` / `sudo dpkg -i`), but it is not enabled here.
- **Dev settings folder unverified.** `productName: AI Oversight` is set only in `electron-builder.yml`. Under `npm run dev`, Electron derives the userData folder from `package.json`, which has `name: aioversight` and no `productName`, so the dev folder is expected to be `aioversight` rather than `AI Oversight`. This has not been checked, and no Linux path is documented.
- **Devin server URL handling is inconsistent.** `resolveServerUrl` in `connectors/devin/quota.ts` throws for plain `http://` to a non-loopback host, but an `ftp://` or unparseable value silently falls back to the default `https://server.codeium.com`.
- **Not implemented** (sources and rationale in [CONNECTOR-SOURCES.md](CONNECTOR-SOURCES.md)):
  - Codex `app-server` JSON-RPC source (`account/rateLimits/read`).
  - Claude Code `statusLine` source (`rate_limits` on the status line command's stdin).
  - Cursor spend via `POST cursor.com/api/dashboard/get-filtered-usage-events`.
