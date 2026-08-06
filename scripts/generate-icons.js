// Generates the PNG icons used by the app at install time.
// We hand-roll a tiny PNG with Node's built-in zlib so the repo stays free
// of binary blobs and the icons regenerate deterministically on every install.
//
// The glyph ("Reserve Ring": an 80°-gap ring with a dot marking the gap's
// center, evoking a capacity meter / reserve being watched over) is
// rasterized with a small signed-distance-field renderer + 4x4 supersampling
// per output pixel, instead of nearest-neighbour-scaling a hand-drawn
// bitmask — this is what gives the small tray sizes clean antialiased edges.
// The PNG encoding (zlib deflate, CRC32, chunk writer) is untouched from the
// previous version of this script; only pixel generation changed.
//
// Files produced:
//   assets/tray-icon-16.png    16x16  Windows tray, 100% DPI (black, light taskbar)
//   assets/tray-icon-24.png    24x24  Windows tray, 150% DPI (black, light taskbar)
//   assets/tray-icon-32.png    32x32  Windows tray, 200% DPI (black, light taskbar)
//   assets/tray-icon-16-white.png  16x16  Windows tray, 100% DPI (white, dark taskbar)
//   assets/tray-icon-24-white.png  24x24  Windows tray, 150% DPI (white, dark taskbar)
//   assets/tray-icon-32-white.png  32x32  Windows tray, 200% DPI (white, dark taskbar)
//   assets/tray-icon.png       22x22  macOS/Linux tray (template image on macOS)
//   assets/tray-icon@2x.png    44x44  macOS/Linux retina (Electron's @2x convention)
//   assets/icon.png            512x512  app icon (installer/dock/notifications)
//   assets/ai-icon.png         256x256  in-app logo, glyph + gradient background
//   assets/ai-icon-no-bkg.png  256x256  in-app logo, glyph only, transparent background
//
// macOS treats any image whose filename ends in `Template` as a template
// image and tints it to match the menu bar; we name explicitly via
// nativeImage.setTemplateImage in tray.ts instead, so the filenames here stay
// plain.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'assets');

// ---------------------------------------------------------------------------
// PNG encoding (untouched apart from being moved verbatim into this file).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// SDF primitives. All coordinates/radii/stroke widths are fractions of a
// normalized 0..1 square (origin top-left, x right, y down), independent of
// the output pixel size — the same shape definitions render identically at
// 16px or 512px, only the sampling density changes.
// ---------------------------------------------------------------------------

/** Signed distance to a filled circle (negative = inside). */
function sdCircleFill(px, py, cx, cy, r) {
  const dx = px - cx;
  const dy = py - cy;
  return Math.sqrt(dx * dx + dy * dy) - r;
}

/** Signed distance to a circle's stroke outline. */
function sdCircleStroke(px, py, cx, cy, r, strokeWidth) {
  const dx = px - cx;
  const dy = py - cy;
  return Math.abs(Math.sqrt(dx * dx + dy * dy) - r) - strokeWidth / 2;
}

/** Signed distance to a filled rounded rectangle (Inigo Quilez's formula). */
function sdRoundedBox(px, py, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(px - cx) - (halfW - radius);
  const qy = Math.abs(py - cy) - (halfH - radius);
  const outsideX = Math.max(qx, 0);
  const outsideY = Math.max(qy, 0);
  const outsideLen = Math.sqrt(outsideX * outsideX + outsideY * outsideY);
  return outsideLen + Math.min(Math.max(qx, qy), 0) - radius;
}

/**
 * Signed distance to a stroked arc, with round caps at both ends.
 *
 * Angles are in degrees from the positive x-axis, sweeping clockwise in this
 * screen-space (y-down) coordinate system, exactly as `startAngle`/`endAngle`
 * are specified by the design (e.g. startAngle=-5, endAngle=275 is a 280°
 * sweep with an 80° gap centered on 315°).
 *
 * The trap this deliberately avoids: naively normalizing `startAngle` into
 * [0,360) first (-5 -> 355) makes it look like start(355) > end(275), which
 * invites "wrap the range in two disjoint pieces" bugs. Instead we normalize
 * *the sample point's* angle relative to the raw, un-normalized start angle
 * via a single mod-360 delta, and compare that delta against the raw sweep
 * (`endAngle - startAngle`) directly. Because -5..275 is already a single
 * monotonic span (it doesn't itself cross the 0/360 seam), this handles the
 * general case correctly without ever treating the arc as two pieces.
 *
 * Points whose angle falls inside [startAngle, endAngle] measure distance to
 * the ring; points outside that range fall back to whichever endpoint (as a
 * capped circle of radius strokeWidth/2) is nearer — that's what produces the
 * round caps "for free", matching the SDF-native round-cap behavior the
 * design brief calls for.
 */
function sdArcStroke(px, py, cx, cy, r, startAngle, endAngle, strokeWidth) {
  const dx = px - cx;
  const dy = py - cy;
  const distFromCenter = Math.sqrt(dx * dx + dy * dy);
  const pointAngle = Math.atan2(dy, dx) * (180 / Math.PI); // (-180, 180]
  const sweep = endAngle - startAngle; // e.g. 280, always positive by design

  // delta = how far clockwise from startAngle the point's angle is, in [0, 360).
  let delta = (pointAngle - startAngle) % 360;
  if (delta < 0) delta += 360;

  if (delta <= sweep) {
    return Math.abs(distFromCenter - r) - strokeWidth / 2;
  }

  const startRad = (startAngle * Math.PI) / 180;
  const endRad = (endAngle * Math.PI) / 180;
  const startCapX = cx + r * Math.cos(startRad);
  const startCapY = cy + r * Math.sin(startRad);
  const endCapX = cx + r * Math.cos(endRad);
  const endCapY = cy + r * Math.sin(endRad);

  const distToStartCap = sdCircleFill(px, py, startCapX, startCapY, strokeWidth / 2);
  const distToEndCap = sdCircleFill(px, py, endCapX, endCapY, strokeWidth / 2);
  return Math.min(distToStartCap, distToEndCap);
}

// ---------------------------------------------------------------------------
// Compositor: 4x4 supersampling per output pixel, shapes composited
// back-to-front using per-shape coverage (0..1) as alpha. Deterministic --
// no Math.random() anywhere -- so re-running this script produces
// byte-identical PNGs and never churns git on a bare `npm install`.
// ---------------------------------------------------------------------------

const SUBSAMPLES = 4; // 4x4 = 16 sub-samples per output pixel

/**
 * Renders a list of shapes into an RGBA buffer of size x size.
 * Each shape is `{ sdf(px, py) -> number, opacity: 0..1, colorAt(px, py) -> [r,g,b] }`.
 * `sdf`/`colorAt` receive normalized 0..1 coordinates. Shapes are composited
 * in array order, first = bottom.
 */
function render(size, shapes) {
  const buf = Buffer.alloc(size * size * 4); // starts fully transparent black
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let outR = 0, outG = 0, outB = 0, outA = 0;
      for (const shape of shapes) {
        let inside = 0;
        for (let sy = 0; sy < SUBSAMPLES; sy++) {
          for (let sx = 0; sx < SUBSAMPLES; sx++) {
            const px = (x + (sx + 0.5) / SUBSAMPLES) / size;
            const py = (y + (sy + 0.5) / SUBSAMPLES) / size;
            if (shape.sdf(px, py) <= 0) inside++;
          }
        }
        if (inside === 0) continue;
        const coverage = inside / (SUBSAMPLES * SUBSAMPLES);
        const effAlpha = coverage * shape.opacity;
        if (effAlpha <= 0) continue;
        const cx = (x + 0.5) / size;
        const cy = (y + 0.5) / size;
        const [r, g, b] = shape.colorAt(cx, cy);
        outR = outR * (1 - effAlpha) + r * effAlpha;
        outG = outG * (1 - effAlpha) + g * effAlpha;
        outB = outB * (1 - effAlpha) + b * effAlpha;
        outA = outA + effAlpha * (1 - outA);
      }
      // outR/outG/outB above were accumulated in PREMULTIPLIED-alpha space
      // (each `over` step scales the existing color by (1-effAlpha) too), but
      // this PNG is color type 6 -- STRAIGHT alpha per the PNG spec. Divide
      // back out before writing, or translucent shapes over a still-transparent
      // destination store too dark (e.g. white at 30% opacity over nothing
      // would bake in as ~76/77 instead of the correct straight-alpha 255).
      // A fully-transparent pixel (outA === 0) has no recoverable color --
      // write 0, it's invisible either way.
      const o = (y * size + x) * 4;
      const unpremul = c => (outA > 0 ? Math.max(0, Math.min(255, Math.round(c / outA))) : 0);
      buf[o] = unpremul(outR);
      buf[o + 1] = unpremul(outG);
      buf[o + 2] = unpremul(outB);
      buf[o + 3] = Math.round(outA * 255);
    }
  }
  return buf;
}

function solidColor(rgb) {
  return () => rgb;
}

// ---------------------------------------------------------------------------
// "Reserve Ring" glyph shape builders.
// ---------------------------------------------------------------------------

const ARC_START = -5;
const ARC_END = 275; // 280deg sweep, 80deg gap centered on 315deg

/** Tray silhouette: an 80deg-gap ring with a dot marking the gap's center.
 * Monochrome (single `rgb` color for both primitives), transparent bg. */
function trayShapes(rgb) {
  return [
    {
      sdf: (px, py) => sdArcStroke(px, py, 0.5, 0.5, 0.33, ARC_START, ARC_END, 0.14),
      opacity: 1,
      colorAt: solidColor(rgb),
    },
    {
      sdf: (px, py) => sdCircleFill(px, py, 0.733, 0.267, 0.105),
      opacity: 1,
      colorAt: solidColor(rgb),
    },
  ];
}

const INDIGO = [0x43, 0x38, 0xca]; // #4338CA
const BLUE = [0x3b, 0x82, 0xf6]; // #3B82F6
const WHITE = [0xff, 0xff, 0xff];

/** App-icon-style glyph (G1 track ring + G2 main arc + G3 dot), already in
 * full-canvas 0..1 coordinates (the 62%-scale-and-center transform is baked
 * into these constants, per the design spec). Optionally preceded by the
 * rounded-square gradient background (icon.png / ai-icon.png) or omitted for
 * a transparent background (ai-icon-no-bkg.png). */
function appIconShapes(includeBackground) {
  const shapes = [];
  if (includeBackground) {
    shapes.push({
      sdf: (px, py) => sdRoundedBox(px, py, 0.5, 0.5, 0.5, 0.5, 0.22),
      opacity: 1,
      colorAt: (px, py) => [
        Math.round(INDIGO[0] + (BLUE[0] - INDIGO[0]) * py),
        Math.round(INDIGO[1] + (BLUE[1] - INDIGO[1]) * py),
        Math.round(INDIGO[2] + (BLUE[2] - INDIGO[2]) * py),
      ],
    });
  }
  shapes.push({
    // G1: track ring, full 360deg, white at 30% opacity.
    sdf: (px, py) => sdCircleStroke(px, py, 0.5, 0.5, 0.205, 0.028),
    opacity: 0.3,
    colorAt: solidColor(WHITE),
  });
  shapes.push({
    // G2: main arc, same gap geometry as the tray glyph, solid white.
    sdf: (px, py) => sdArcStroke(px, py, 0.5, 0.5, 0.205, ARC_START, ARC_END, 0.087),
    opacity: 1,
    colorAt: solidColor(WHITE),
  });
  shapes.push({
    // G3: dot, solid white.
    sdf: (px, py) => sdCircleFill(px, py, 0.645, 0.355, 0.065),
    opacity: 1,
    colorAt: solidColor(WHITE),
  });
  return shapes;
}

/** `rgb` is the glyph fill (fully opaque) — black for light taskbars, white
 * for dark ones. Windows never auto-inverts tray icons the way macOS template
 * images do, so both variants ship as separate files. */
function renderTrayIcon(size, rgb = [0, 0, 0]) {
  return render(size, trayShapes(rgb));
}

function renderAppIcon(size, includeBackground) {
  return render(size, appIconShapes(includeBackground));
}

function write(name, w, h, buf) {
  fs.writeFileSync(path.join(OUT_DIR, name), encodePNG(w, h, buf));
  process.stdout.write(`generated ${name} (${w}x${h})\n`);
}

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// Windows tray (16/24/32 -- 100%/150%/200% DPI). Black glyph for light
// taskbars, white glyph for dark taskbars (tray.ts picks per nativeTheme).
write('tray-icon-16.png', 16, 16, renderTrayIcon(16));
write('tray-icon-24.png', 24, 24, renderTrayIcon(24));
write('tray-icon-32.png', 32, 32, renderTrayIcon(32));
write('tray-icon-16-white.png', 16, 16, renderTrayIcon(16, WHITE));
write('tray-icon-24-white.png', 24, 24, renderTrayIcon(24, WHITE));
write('tray-icon-32-white.png', 32, 32, renderTrayIcon(32, WHITE));

// macOS/Linux tray (template image on macOS) + Electron's @2x convention.
write('tray-icon.png', 22, 22, renderTrayIcon(22));
write('tray-icon@2x.png', 44, 44, renderTrayIcon(44));

// App icon (installer + dock + notifications).
write('icon.png', 512, 512, renderAppIcon(512, true));

// In-app logo (settings window + tray popup header), same glyph as icon.png.
write('ai-icon.png', 256, 256, renderAppIcon(256, true));
write('ai-icon-no-bkg.png', 256, 256, renderAppIcon(256, false));
