// Generates the PNG icons used by the app at install time.
// We hand-roll a tiny PNG with Node's built-in zlib so the repo stays free
// of binary blobs and the icons regenerate deterministically on every install.
//
// Three icons are produced:
//   assets/tray-icon.png      22x22 monochrome bell (macOS template + others)
//   assets/tray-icon@2x.png   44x44 retina variant
//   assets/icon.png           512x512 app icon (rounded square + bell)
//
// The bell glyph is rasterized from a small bitmask. macOS treats any image
// whose filename ends in `Template` as a template image and tints it to match
// the menu bar; we name explicitly via nativeImage in tray.ts instead, so the
// filename here is plain.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'assets');

function crc32(buf) {
  let c;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);  // bit depth
  ihdr.writeUInt8(6, 9);  // color type RGBA
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Bell mask (11x11). 1 = filled, 0 = transparent. Hand-drawn shape.
const BELL = [
  '00000100000',
  '00011111000',
  '00111111100',
  '00111111100',
  '01111111110',
  '01111111110',
  '11111111111',
  '11111111111',
  '00000100000',
  '00001110000',
  '00000100000',
];

function renderBell(size, fg, bg) {
  // Scales the 11x11 mask up to `size` with simple nearest-neighbour scaling
  // and adds a 1px transparent margin. Returns RGBA buffer.
  const mask = BELL.map(row => row.split('').map(c => c === '1'));
  const buf = Buffer.alloc(size * size * 4);
  if (bg) {
    for (let i = 0; i < size * size; i++) {
      buf[i * 4] = bg[0];
      buf[i * 4 + 1] = bg[1];
      buf[i * 4 + 2] = bg[2];
      buf[i * 4 + 3] = bg[3];
    }
  }
  const margin = Math.floor(size * 0.1);
  const inner = size - margin * 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const mx = Math.floor(((x - margin) / inner) * mask[0].length);
      const my = Math.floor(((y - margin) / inner) * mask.length);
      if (mx < 0 || my < 0 || mx >= mask[0].length || my >= mask.length) continue;
      if (mask[my][mx]) {
        const o = (y * size + x) * 4;
        buf[o] = fg[0];
        buf[o + 1] = fg[1];
        buf[o + 2] = fg[2];
        buf[o + 3] = fg[3];
      }
    }
  }
  return buf;
}

function makeAppIcon(size) {
  // Rounded-square background with the bell on top.
  const buf = Buffer.alloc(size * size * 4);
  const radius = Math.floor(size * 0.22);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.max(radius - x, x - (size - 1 - radius), 0);
      const dy = Math.max(radius - y, y - (size - 1 - radius), 0);
      const inside = dx * dx + dy * dy <= radius * radius;
      const o = (y * size + x) * 4;
      if (inside) {
        // Vertical gradient: deep indigo -> blue
        const t = y / size;
        buf[o]     = Math.round(60 + (40 - 60) * t);
        buf[o + 1] = Math.round(70 + (110 - 70) * t);
        buf[o + 2] = Math.round(180 + (220 - 180) * t);
        buf[o + 3] = 255;
      }
    }
  }
  // Overlay the bell in white, centered, scaled to ~60%.
  const inner = Math.floor(size * 0.6);
  const offset = Math.floor((size - inner) / 2);
  const bell = renderBell(inner, [255, 255, 255, 255], null);
  for (let y = 0; y < inner; y++) {
    for (let x = 0; x < inner; x++) {
      const sIdx = (y * inner + x) * 4;
      if (bell[sIdx + 3] === 0) continue;
      const dIdx = ((y + offset) * size + (x + offset)) * 4;
      buf[dIdx]     = bell[sIdx];
      buf[dIdx + 1] = bell[sIdx + 1];
      buf[dIdx + 2] = bell[sIdx + 2];
      buf[dIdx + 3] = bell[sIdx + 3];
    }
  }
  return buf;
}

function write(name, w, h, buf) {
  fs.writeFileSync(path.join(OUT_DIR, name), encodePNG(w, h, buf));
  process.stdout.write(`generated ${name} (${w}x${h})\n`);
}

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// Tray icons: black bell on transparent (template).
write('tray-icon.png',    22, 22, renderBell(22, [0, 0, 0, 255], null));
write('tray-icon@2x.png', 44, 44, renderBell(44, [0, 0, 0, 255], null));

// App icon (used for installer + dock + notifications).
write('icon.png', 512, 512, makeAppIcon(512));
