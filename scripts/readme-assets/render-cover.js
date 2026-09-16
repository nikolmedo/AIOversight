/**
 * Renders the README cover images from docs/screenshots/*:
 *   docs/cover-dark.png, docs/cover-light.png   2560x1280 (1280x640 at 2x)
 *   docs/social-preview.png                     1280x640, dark theme, 1x
 *
 * Must run under Electron, not Node. From the repo root:
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron.cmd scripts/readme-assets/render-cover.js [--out=DIR]
 * (use ./node_modules/.bin/electron on macOS/Linux). --out defaults to docs/.
 *
 * The device scale factor is a process-wide Chromium switch, so the parent
 * process re-launches itself once per scale (--job=covers at 2x, --job=social
 * at 1x). Every run uses a throwaway userData directory in the OS temp dir,
 * never the app's own.
 *
 * Colours come from src/renderer/tokens.css; the layout lives in cover.html.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..', '..');
const WIDTH = 1280;
const HEIGHT = 640;

function argValue(name) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

const outDir = path.resolve(argValue('out') || path.join(REPO, 'docs'));
const job = argValue('job');

const electron = require('electron');
if (typeof electron === 'string' || !electron.app) {
  console.error('render-cover.js must run under Electron with ELECTRON_RUN_AS_NODE unset (see scripts/readme-assets/README.md).');
  process.exit(1);
}
const { app, BrowserWindow } = electron;

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-readme-cover-'));
app.setPath('userData', userData);
// Keep running between renders; Electron's default quits when the last window closes.
app.on('window-all-closed', () => {});

/** `app.exit` skips the quit events, so clean up the temp profile explicitly. */
function finish(code) {
  try {
    fs.rmSync(userData, { recursive: true, force: true });
  } catch {
    // Chromium may still hold a file open on Windows; the OS temp dir is fine to leave.
  }
  app.exit(code);
}

if (!job) {
  // Parent: run one child per scale factor, then exit.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let failed = false;
  for (const j of ['covers', 'social']) {
    const res = spawnSync(process.execPath, [__filename, `--job=${j}`, `--out=${outDir}`], { stdio: 'inherit', env });
    if (res.status !== 0) {
      console.error(`[render-cover] job ${j} failed (exit ${res.status})`);
      failed = true;
      break;
    }
  }
  finish(failed ? 1 : 0);
} else {
  const scale = job === 'covers' ? 2 : 1;
  app.commandLine.appendSwitch('force-device-scale-factor', String(scale));
  app.commandLine.appendSwitch('lang', 'en-US');
  app.whenReady().then(() => runJob(job)).then(
    () => finish(0),
    err => {
      console.error('[render-cover]', err);
      finish(1);
    },
  );
}

function buildHtml(theme) {
  const { readTokens } = require(path.join(REPO, 'scripts', 'check-contrast.js'));
  const tokens = readTokens()[theme];
  let html = fs.readFileSync(path.join(__dirname, 'cover.html'), 'utf8');
  html = html.replace('{{BASE}}', pathToFileURL(REPO + path.sep).href);
  html = html.replace(/\{\{THEME\}\}/g, theme);
  html = html.replace(/\{\{([a-z0-9-]+)\}\}/g, (m, key) => {
    if (!(key in tokens)) throw new Error(`cover.html uses unknown token --${key}`);
    return tokens[key];
  });
  return html;
}

async function render(win, theme, outFile) {
  const tmpHtml = path.join(userData, `cover-${theme}.html`);
  fs.writeFileSync(tmpHtml, buildHtml(theme));
  await win.loadFile(tmpHtml);
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
  await win.webContents.executeJavaScript(
    'Promise.all([...document.images].map(i => i.complete ? 1 : new Promise(r => { i.onload = i.onerror = r; })))',
  );
  await new Promise(r => setTimeout(r, 700));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: WIDTH, height: HEIGHT });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, img.toPNG());
  console.log('[render-cover] wrote', outFile, img.getSize());
}

async function runJob(name) {
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    useContentSize: true,
    paintWhenInitiallyHidden: true,
  });
  if (name === 'covers') {
    await render(win, 'dark', path.join(outDir, 'cover-dark.png'));
    await render(win, 'light', path.join(outDir, 'cover-light.png'));
  } else if (name === 'social') {
    await render(win, 'dark', path.join(outDir, 'social-preview.png'));
  } else {
    throw new Error(`Unknown job: ${name}`);
  }
}
