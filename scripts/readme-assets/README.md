# README image generators

Tools that produce the images used by the top-level `README.md` and the GitHub social preview. None of this runs in CI or in `npm run build`.

| Output | Produced by |
|---|---|
| `docs/screenshots/{overview,activity,general,notifications,webhook,integrations-drawer,popup}-{dark,light}.png` | `screenshot-block.ts.txt` (temporary patch to `src/main/index.ts`) |
| `docs/cover-dark.png`, `docs/cover-light.png` (2560x1280) | `render-cover.js` + `cover.html` |
| `docs/social-preview.png` (1280x640, dark) | `render-cover.js` + `cover.html` |

Take screenshots first; the cover is composed from `docs/screenshots/overview-*.png` and `popup-*.png`.

Commands below are for Git Bash on Windows, run from the repo root. On macOS/Linux use `./node_modules/.bin/electron` instead of `electron.cmd`. See also "Running and capturing the app from an automated/agent shell" in `CONTRIBUTING.md`.

## 1. Screenshots

The app has no demo mode, so the screenshots come from a temporary block that replaces the quota service and settings IPC handlers with fictional demo data, then captures each page with `webContents.capturePage()`. It must never be committed into `src/`.

1. Back up the entry point:
   ```bash
   cp src/main/index.ts /tmp/index.ts.backup
   ```
2. Paste the contents of `scripts/readme-assets/screenshot-block.ts.txt` into `src/main/index.ts`, inside `app.whenReady().then(async () => { ... })`, directly after the `refreshTrayQuotaSummary();` line. It has to come after `registerIpc()` because it removes and re-registers some of those handlers.
3. Build: `npm run build`.
4. Capture both themes, each into a throwaway profile:
   ```bash
   OUT="$(mktemp -d)"
   for THEME in dark light; do
     env -u ELECTRON_RUN_AS_NODE \
       AIO_SCREENSHOT_DIR="$OUT" AIO_SCREENSHOT_THEME=$THEME \
       ./node_modules/.bin/electron.cmd . \
       --user-data-dir="$(mktemp -d)" --lang=en-US --force-device-scale-factor=2
   done
   ls "$OUT"
   ```
   - `AIO_SCREENSHOT_ONLY=overview,popup` (comma-separated) limits which images are taken. Names: `popup`, `overview`, `activity`, `general`, `notifications`, `webhook`, `integrations-drawer`, plus two review-only captures that the README does not use: `drawer-meters` (the drawer scrolled to its Meters section) and `shortcut-recorder` (the shortcut recorder while recording). Do not copy those two into `docs/screenshots/`.
   - The app quits by itself when done. The popup is opened programmatically, so no tray click is needed.
5. Review the images, then copy them to `docs/screenshots/`.
6. Restore and rebuild, and confirm `src/main/index.ts` has no diff:
   ```bash
   cp /tmp/index.ts.backup src/main/index.ts
   npm run build
   git diff --stat src/main/index.ts
   ```

If the IPC surface or the quota snapshot types change, the block may no longer compile; update it here, not in `src/`.

## 2. Cover and social preview

```bash
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron.cmd scripts/readme-assets/render-cover.js
```

- Writes to `docs/` by default. Pass `--out=<dir>` to write elsewhere, for example to compare before overwriting.
- Colours are read from `src/renderer/tokens.css`; the layout, tagline and positions are in `cover.html`.
- The script re-launches itself once per device scale factor (2x for the covers, 1x for the social preview) and uses a temporary userData directory under the OS temp dir, never the app's own profile. A leftover `aio-readme-cover-*` temp directory can remain on Windows because Chromium still holds files open at exit; it is safe to delete.
- Output is deterministic on the same machine: re-rendering from unchanged screenshots reproduced the committed PNGs byte for byte (2026-09-16, Windows 11). Fonts differ per OS (the stack prefers Segoe UI Variable), so render on Windows to match the committed images.
- Upload `docs/social-preview.png` manually in the GitHub repository settings (Settings > General > Social preview).

## Environment quirks

These were hit while driving Electron from Claude Code's shell on Windows:

- `ELECTRON_RUN_AS_NODE=1` was set in the shell, which makes Electron behave like plain Node (`require('electron')` returns a path string, `app` is undefined). Always launch with `env -u ELECTRON_RUN_AS_NODE`.
- The default userData directory was not writable from the sandboxed shell. The app then exited silently with code 0 before `whenReady`. Pass `--user-data-dir=<temp dir>` for the app; `render-cover.js` handles this itself.
- `npx electron .` also ran as Node there; call `./node_modules/.bin/electron.cmd` directly.
- `--lang=en-US` keeps numbers in English formatting (a Spanish OS locale rendered `20.000`). `--force-device-scale-factor=2` gives 2x images.
