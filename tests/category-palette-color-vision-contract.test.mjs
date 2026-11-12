/**
 * What the app and its pages say about color blindness, held to a measurement
 * (R9U-2, 2026-11-11).
 *
 * The accessibility page, the accessibility guide and the palette's own
 * comment said the first 24 category colors "stay distinct for red–green color
 * blindness". Simulated with Machado et al. (2009), the model the export
 * preview uses, vivid cerulean and iris purple (categories 2 and 10) differ by
 * ΔE2000 1.0 under deuteranopia: the same color. And the preview itself used
 * the old "Coblis" matrices on encoded sRGB, which showed those two as plainly
 * different, so a figure a colorblind reader cannot read passed it.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { getCategoryColor } from '../assets/js/data/palettes.js';
import {
  applyColorblindSimulationToImageData,
  simulateColorVision,
} from '../assets/js/app/ui/modules/figure-export/utils/colorblindness.js';

const read = relative => readFile(new URL(relative, import.meta.url), 'utf8');

/** The shared docs site: CELLUCID_PYTHON_DOCS, else the sibling checkout (absent in this repository's CI). */
const DOCS = process.env.CELLUCID_PYTHON_DOCS
  ?? path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../cellucid-python/docs');
const GUIDE = path.join(DOCS, 'user_guide/web_app/o_accessibility_privacy_security/01_accessibility.md');

/** CIELAB of an sRGB byte triple (D65). */
function lab([r, g, b]) {
  const lin = v => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}

/** CIEDE2000 between two CIELAB colors. */
function deltaE2000([L1, a1, b1], [L2, a2, b2]) {
  const rad = d => (d * Math.PI) / 180;
  const deg = r => (r * 180) / Math.PI;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h1 = (deg(Math.atan2(b1, a1p)) + 360) % 360;
  const h2 = (deg(Math.atan2(b2, a2p)) + 360) % 360;
  let dh = h2 - h1;
  if (C1p * C2p === 0) dh = 0;
  else if (dh > 180) dh -= 360;
  else if (dh < -180) dh += 360;
  const dL = L2 - L1;
  const dC = C2p - C1p;
  const dH = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dh / 2));
  const Lb = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hb = Math.abs(h1 - h2) <= 180 ? (h1 + h2) / 2 : (h1 + h2 < 360 ? (h1 + h2 + 360) / 2 : (h1 + h2 - 360) / 2);
  if (C1p * C2p === 0) hb = h1 + h2;
  const T = 1 - 0.17 * Math.cos(rad(hb - 30)) + 0.24 * Math.cos(rad(2 * hb))
    + 0.32 * Math.cos(rad(3 * hb + 6)) - 0.2 * Math.cos(rad(4 * hb - 63));
  const SL = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2);
  const SC = 1 + 0.045 * Cbp;
  const SH = 1 + 0.015 * Cbp * T;
  const RT = -2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7)) * Math.sin(rad(60 * Math.exp(-(((hb - 275) / 25) ** 2))));
  return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH));
}

const bytes = rgb01 => rgb01.slice(0, 3).map(v => Math.round(v * 255));
const seen = (rgb, mode) => lab(simulateColorVision(rgb, mode));

/** Two colors a reader tells apart at a glance in small marks. */
const DISTINCT_DELTA_E = 10;

/** How many of the first category colors stay distinct for a red–green colorblind reader. */
function distinctRedGreenPrefix(limit = 24) {
  const colors = Array.from({ length: limit }, (_, index) => bytes(getCategoryColor(index)));
  for (let n = 2; n <= limit; n++) {
    for (const mode of ['deuteranopia', 'protanopia']) {
      for (let i = 0; i < n - 1; i++) {
        if (deltaE2000(seen(colors[i], mode), seen(colors[n - 1], mode)) < DISTINCT_DELTA_E) return n - 1;
      }
    }
  }
  return limit;
}

test('the preview simulates Machado et al. (2009) in linear light: the palette\'s known confusion shows', () => {
  const cerulean = bytes(getCategoryColor(1));
  const irisPurple = bytes(getCategoryColor(9));
  assert.deepEqual(cerulean, [0, 119, 200]);
  assert.deepEqual(irisPurple, [125, 87, 194]);
  // Plainly different to normal vision…
  assert.ok(deltaE2000(lab(cerulean), lab(irisPurple)) > 20);
  // …the same color to a deuteranope (the old matrices showed ΔE2000 ≈ 30 here).
  assert.ok(deltaE2000(seen(cerulean, 'deuteranopia'), seen(irisPurple, 'deuteranopia')) < 2.3);
  // A dichromat model keeps grays gray and white white.
  for (const mode of ['deuteranopia', 'protanopia', 'tritanopia']) {
    for (const gray of [0, 64, 128, 200, 255]) {
      const [r, g, b] = simulateColorVision([gray, gray, gray], mode);
      assert.ok(Math.abs(r - gray) <= 1 && Math.abs(g - gray) <= 1 && Math.abs(b - gray) <= 1, `${mode} keeps ${gray}`);
    }
  }
  // 'none' changes nothing; the image path and the one-color path agree.
  assert.deepEqual(simulateColorVision([12, 34, 56], 'none'), [12, 34, 56]);
  const image = { data: new Uint8ClampedArray([...cerulean, 255, ...irisPurple, 128]) };
  applyColorblindSimulationToImageData(image, 'protanopia');
  assert.deepEqual([...image.data], [...simulateColorVision(cerulean, 'protanopia'), 255, ...simulateColorVision(irisPurple, 'protanopia'), 128]);
});

test('no page claims the category colors are colorblind-safe beyond what they measure', async () => {
  const prefix = distinctRedGreenPrefix();
  // Measured 2026-11-11: only the first two colors stay ΔE2000 ≥ 10 apart for both deficiencies.
  // A palette chosen for color blindness changes this number; then say it, with the number.
  assert.ok(prefix < 8, `the first ${prefix} category colors are now colorblind-distinct: say so on the pages`);
  const CLAIM = /stay(?:s)? distinct for red|distinguishable under \*\*protanopia|colorblind-friendly|PROTAN\/DEUTAN safe|color-vision-deficiency safe/i;
  const sources = {
    'accessibility.html': await read('../accessibility.html'),
    'assets/js/data/palettes.js': await read('../assets/js/data/palettes.js'),
  };
  if (existsSync(GUIDE)) sources['docs accessibility guide'] = await readFile(GUIDE, 'utf8');
  for (const [name, text] of Object.entries(sources)) {
    assert.doesNotMatch(text, CLAIM, `${name} claims colorblind-safe category colors`);
  }
  assert.match(sources['accessibility.html'], /Category colors are not chosen for color blindness/);
});
