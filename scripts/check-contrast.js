#!/usr/bin/env node
/**
 * WCAG AA contrast check for the renderer design tokens.
 *
 * Reads both themes straight from src/renderer/tokens.css (the first `:root`
 * block is dark, the `@media (prefers-color-scheme: light)` block overrides it)
 * and checks every pair the UI actually uses against 4.5:1:
 *   - text, text-2, text-3, accent, ok, warn, danger on bg / surface / surface-2
 *   - white on accent-solid (primary button, checked switch)
 *   - ok / warn / danger on their -soft pill background, composited over surface
 *   - accent on accent-soft, composited over surface
 * and the categorical palette (cat-1..cat-N: donut arcs and legend dots,
 * graphical objects under WCAG 1.4.11) against surface at 3:1.
 *
 * Usage: node scripts/check-contrast.js
 * Exit code 1 if any pair fails. Dependency-free.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const TOKENS_PATH = path.join(__dirname, '..', 'src', 'renderer', 'tokens.css');
const MIN_RATIO = 4.5;
const MIN_GRAPHIC_RATIO = 3;

function parseBlock(text) {
  const out = {};
  for (const m of text.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

/** Returns `{ dark, light }` token maps; light inherits anything it does not override. */
function readTokens(cssText = fs.readFileSync(TOKENS_PATH, 'utf8')) {
  const css = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  const rootMatch = css.match(/:root\s*\{([^}]*)\}/);
  const lightMatch = css.match(/@media\s*\(prefers-color-scheme:\s*light\)\s*\{\s*:root\s*\{([^}]*)\}/);
  if (!rootMatch || !lightMatch) {
    throw new Error(`Could not find the :root and light-theme blocks in ${TOKENS_PATH}`);
  }
  const dark = parseBlock(rootMatch[1]);
  const light = { ...dark, ...parseBlock(lightMatch[1]) };
  return { dark, light };
}

/** Parses `#RRGGBB` or `rgba(r, g, b, a)` into `{ rgb: [r, g, b], a }`. */
function parseColor(value) {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1];
    return { rgb: [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)), a: 1 };
  }
  const rgba = value.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (rgba) {
    return { rgb: [rgba[1], rgba[2], rgba[3]].map(Number), a: rgba[4] == null ? 1 : Number(rgba[4]) };
  }
  throw new Error(`Unsupported color value: ${value}`);
}

function composite(fg, bgRgb) {
  return fg.rgb.map((v, i) => Math.round(v * fg.a + bgRgb[i] * (1 - fg.a)));
}

function luminance(rgb) {
  const [r, g, b] = rgb.map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(aRgb, bRgb) {
  const x = luminance(aRgb);
  const y = luminance(bRgb);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function checkTheme(name, t) {
  const solid = key => {
    if (!(key in t)) throw new Error(`Token --${key} missing in ${name} theme`);
    const c = parseColor(t[key]);
    if (c.a !== 1) throw new Error(`Token --${key} is expected to be opaque in ${name} theme`);
    return c.rgb;
  };
  const results = [];
  const add = (label, fg, bg, min = MIN_RATIO) => results.push({ label, r: ratio(fg, bg), min });

  for (const fg of ['text', 'text-2', 'text-3', 'accent', 'ok', 'warn', 'danger']) {
    for (const bg of ['bg', 'surface', 'surface-2']) add(`${fg} on ${bg}`, solid(fg), solid(bg));
  }
  add('white on accent-solid', [255, 255, 255], solid('accent-solid'));
  const surface = solid('surface');
  for (const s of ['ok', 'warn', 'danger', 'accent']) {
    const softBg = composite(parseColor(t[`${s}-soft`]), surface);
    add(`${s} on ${s}-soft over surface`, solid(s), softBg);
  }
  const catKeys = Object.keys(t).filter(k => /^cat-\d+$/.test(k));
  if (catKeys.length === 0) throw new Error(`No --cat-N palette tokens in ${name} theme`);
  for (const k of catKeys) add(`${k} on surface (graphic)`, solid(k), surface, MIN_GRAPHIC_RATIO);

  console.log(`== ${name}`);
  let failures = 0;
  for (const { label, r, min } of results) {
    const bad = r < min;
    if (bad) failures++;
    console.log(`  ${bad ? 'FAIL' : 'ok  '}  ${r.toFixed(2).padStart(5)}  ${label}${min !== MIN_RATIO ? ` (min ${min}:1)` : ''}`);
  }
  return failures;
}

function main() {
  const { dark, light } = readTokens();
  const failures = checkTheme('dark', dark) + checkTheme('light', light);
  if (failures) {
    console.log(`\n${failures} pair(s) below their minimum ratio`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll pairs meet their minimum (${MIN_RATIO}:1 text, ${MIN_GRAPHIC_RATIO}:1 palette)`);
  }
}

module.exports = { readTokens };

if (require.main === module) main();
