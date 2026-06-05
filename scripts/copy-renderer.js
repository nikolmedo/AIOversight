// Copies static renderer assets (HTML/CSS) into dist so Electron can load them
// from the same path layout used in development.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src', 'renderer');
const DST = path.join(__dirname, '..', 'dist', 'renderer');

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile() && !entry.name.endsWith('.ts')) fs.copyFileSync(s, d);
  }
}

copyDir(SRC, DST);

// Also copy top-level assets/ into dist/renderer/assets/ so HTML can reference them
const ASSETS_SRC = path.join(__dirname, '..', 'assets');
const ASSETS_DST = path.join(DST, 'assets');
if (fs.existsSync(ASSETS_SRC)) copyDir(ASSETS_SRC, ASSETS_DST);

process.stdout.write('copied static renderer assets to dist/renderer\n');
