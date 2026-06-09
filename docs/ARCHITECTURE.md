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
- Atomic writes — `JSON.stringify` to disk on every mutation

AppSettings shape:
```ts
{
  showNotifications, notifyOnWaiting, notifyOnFinished,
  perSessionCooldownMs, quietHours, quotaPollMinutes, showQuotaInTray,
  connectors: { enabled, config, pollOverrideMinutes },
  recentEvents
}
```

### SecretStore (`connectors/secret-store.ts`)

Wraps Electron `safeStorage`:
- macOS: Keychain AES encryption
- Windows: DPAPI
- Linux: `libsecret` / fallback to plaintext with a consent file

Keys are namespaced as `<connectorId>::<fieldKey>` via `SecretStore.qualify()`.

A consent file (`<userData>/.plaintext-secrets-ok`) is written when the platform cannot encrypt, allowing the user to acknowledge the risk. The `ConnectorContext.secret(key)` and `ConnectorContext.setSecret(key, value)` methods are the only intended access paths for connector code.

### ConnectorRuntime (`connectors/runtime.ts`)

Owns the detector lifecycle:
- `applyConfig(rt)` — stops all running detectors, starts the enabled ones fresh
- `contextFor(connector)` — returns a `ConnectorContext` scoped to that connector (namespaced secrets, namespaced logs)
- Maintains a rolling 200-entry in-memory log buffer, emits `log` events for the settings window Logs tab
- Resolves `~`, `$HOME`, `%APPDATA%`, `%LOCALAPPDATA%`, `%USERPROFILE%` in path strings

### QuotaService (`connectors/quota-service.ts`)

Runs a polling loop per connector:
- Minimum poll interval: 60 seconds (hard floor regardless of user setting)
- Coalesces concurrent refresh calls — if a fetch is already in flight, the second caller awaits the same promise
- Caches the last `QuotaSnapshot` per connector
- Emits `update(id, snapshot)` when fresh data arrives
- `refreshAll()` fans out parallel calls to all enabled providers
- `destroy()` clears all timers on app quit

### Notifier (`notifier.ts`)

Applies notification policy before dispatching to the OS:
- Per-session cooldown keyed on `(sessionId, kind)` — prevents duplicate alerts within `perSessionCooldownMs` (default 30 s)
- Kind filter — `notifyOnWaiting` and `notifyOnFinished` toggles
- Quiet hours — compares wall-clock hour against `[startHour, endHour)` range
- Electron `Notification` — includes the app icon, dispatches click handler to reveal the source file in Finder/Explorer

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

Each `QuotaProvider.fetch()` must return a `QuotaSnapshot` within a reasonable timeout. Conventions:
- Set `needsLogin: true` when authentication is missing/expired (shows a Sign In button in the UI)
- Return `ok: false` with a human-readable `error` string for transient API failures
- Set `authMethod` in the `ok: true` response so the UI's footnote can explain what's being used
- Set `trayLine` for a custom one-line summary in the tray tooltip

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
     Single tsconfig: target ES2022, module CommonJS, strict
     All three process types (main, preload, renderer) compile together

copy-renderer.js: copies src/renderer/*.html → dist/renderer/
                  copies src/renderer/assets/ → dist/renderer/assets/

npm install (postinstall):
  node scripts/generate-icons.js
    → writes assets/tray-icon.png, tray-icon@2x.png, icon.png
      (pure Node.js, no binary dep — zlib.deflateSync + hand-crafted PNG chunks)
```

**Why no bundler?** The main process and preload scripts are CommonJS modules loaded directly by Electron's Node.js runtime. The renderer scripts are also CommonJS (loaded via `<script>` with no module bundling). A bundler would add complexity with no benefit given the vanilla approach.

**Why CommonJS?** Electron 31 supports ESM in both the main process and renderer, but the transition requires careful `type: "module"` management across all three process types. The existing codebase is uniformly CommonJS and this is not a pain point.

---

## Packaging

`electron-builder` reads `electron-builder.yml`. Key decisions:

- `sql.js` is explicitly whitelisted in `files` because it ships its own WASM binary that electron-builder would otherwise exclude
- macOS builds require `hardenedRuntime: true` and entitlements for notarization
- Windows NSIS installer is non-destructive (`oneClick: false`) and supports per-user install
- Icon files are excluded from git and generated at install time (`.gitignore` includes `assets/tray-icon.png` etc.)

---

## IPC surface

Complete reference in `CLAUDE.md`. The short invariants:

- All channels are handled in `registerIpc()` in `src/main/index.ts`
- Login channels (`connector:login:${id}`) are registered dynamically for connectors that declare `login`
- Tray popup channels are prefixed `trayPopup:`
- Push channels (main → renderer) use `webContents.send()`; the renderer subscribes via the preload bridge's `on*` methods
