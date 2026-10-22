/**
 * The backdrop looks: their table, the data-derived tints,
 * the readability band, and the idle-cost rules the renderer must keep.
 *
 * Every assertion is about produced numbers or the source text of the GL
 * owner, never about a function merely running.
 */

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

import {
  BACKDROP_LOOKS,
  BACKDROP_LOOK_IDS,
  DARK_BAND_MAX_LSTAR,
  LIGHT_BAND_MIN_LSTAR,
  extractDominantColors,
  linearLuminance,
  lstarOfSrgb,
  resolveShadowWindow,
  shapeBackdropTint,
} from '../assets/js/rendering/backdrops/backdrop-looks.js';
import { BACKDROP_LOOK_PROGRAMS } from '../assets/js/rendering/backdrops/backdrop-look-shaders.js';
import { LOOK_VIEWER_BACKGROUNDS } from '../assets/js/rendering/viewer-backgrounds.js';
import { getCategoryColor } from '../assets/js/data/palettes.js';
import {
  figureDrawsBackdropLook,
  resolveBackdropLookPlacement,
} from '../assets/js/app/ui/modules/figure-export/components/backdrop-look-export.js';

const read = (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');

test('six looks: three families, each with a light and a dark twin', () => {
  assert.deepEqual([...BACKDROP_LOOK_IDS].sort(), [...LOOK_VIEWER_BACKGROUNDS].sort());
  assert.equal(BACKDROP_LOOK_IDS.length, 6);
  const families = new Map();
  for (const id of BACKDROP_LOOK_IDS) {
    const look = BACKDROP_LOOKS[id];
    assert.equal(look.id, id);
    if (!families.has(look.family)) families.set(look.family, []);
    families.get(look.family).push(look.tone);
  }
  assert.deepEqual([...families.keys()].sort(), ['abyss', 'atelier', 'aurora']);
  for (const tones of families.values()) assert.deepEqual(tones.sort(), ['dark', 'light']);
});

test('every surface keeps out of the category palettes\' lightness band', () => {
  const palette = Array.from({ length: 24 }, (_, i) => lstarOfSrgb(getCategoryColor(i)));
  const bandMin = Math.min(...palette);
  const bandMax = Math.max(...palette);
  assert.ok(bandMin > DARK_BAND_MAX_LSTAR, 'dark looks sit below every category colour');
  for (const id of BACKDROP_LOOK_IDS) {
    const look = BACKDROP_LOOKS[id];
    const lstar = lstarOfSrgb(look.surface.map((c) => c / 255));
    if (look.tone === 'dark') assert.ok(lstar <= DARK_BAND_MAX_LSTAR, `${id} L* ${lstar}`);
    else assert.ok(lstar >= LIGHT_BAND_MIN_LSTAR, `${id} L* ${lstar}`);
  }
  assert.ok(bandMax < 92);
});

test('dominant colours: distinct, weighted by visibility, blind to filtered cells', () => {
  const count = 3000;
  const colors = new Uint8Array(count * 4);
  const visibility = new Uint8Array(count).fill(1);
  for (let i = 0; i < count; i++) {
    // 60% orange, 30% teal, 10% violet; the last 1000 cells are filtered.
    const rgb = i < 1800 ? [255, 153, 0] : i < 2700 ? [0, 183, 131] : [173, 80, 224];
    colors.set([...rgb, 255], i * 4);
  }
  const all = extractDominantColors(colors, visibility, 3);
  assert.equal(all.colors.length, 3);
  assert.ok(Math.abs(all.colors[0][0] - 1) < 0.02 && Math.abs(all.colors[0][1] - 0.6) < 0.02);
  assert.ok(all.weights[0] > all.weights[1] && all.weights[1] > all.weights[2]);
  for (let i = 2000; i < count; i++) visibility[i] = 0;
  const filtered = extractDominantColors(colors, visibility, 3);
  // Only orange and teal remain visible.
  assert.equal(filtered.colors.length, 2);
  assert.equal(filtered.sampled, 2000);
});

test('a tint keeps its hue at unit luminance, whatever the data colour', () => {
  for (const srgb of [[1, 0.6, 0], [0, 0.47, 0.78], [0.1, 0.1, 0.1], [1, 1, 1]]) {
    const tint = shapeBackdropTint(srgb, 0.8);
    assert.ok(Math.abs(linearLuminance(tint) - 1) < 1e-6);
    assert.ok(tint.every((c) => c >= 0));
  }
  const grey = shapeBackdropTint([1, 0.6, 0], 0);
  for (const c of grey) assert.ok(Math.abs(c - 1) < 1e-6);
});

test('the shadow window covers the data and its cast shadow', () => {
  const geometry = { flat: false, stageX: 0.2, stageZ: -0.1, centerY: 0, extentX: 1, extentY: 0.8, extentZ: 0.6, floorY: -0.92 };
  const window = resolveShadowWindow(geometry);
  assert.equal(window.centerU, 0.2);
  assert.ok(window.halfSize > 1.25 + 0.35);
  const flat = resolveShadowWindow({ ...geometry, flat: true });
  assert.equal(flat.centerV, 0);
});

test('every draw program declares the uniforms the renderer binds', () => {
  for (const key of ['draw:nebula', 'draw:atelier', 'draw:abyss', 'draw:aurora']) {
    const fs = BACKDROP_LOOK_PROGRAMS[key].fs;
    for (const name of ['u_invMvp', 'u_eye', 'u_opacity', 'u_surface', 'u_planar', 'u_tint0']) {
      assert.match(fs, new RegExp(`uniform [a-z0-9]+ ${name};`), `${key} lacks ${name}`);
    }
    // Linear light out to sRGB, then dithered.
    assert.match(fs, /fragColor = finish\(/);
  }
  for (const key of ['bake:nebula', 'bake:abyss', 'bake:aurora']) {
    assert.match(BACKDROP_LOOK_PROGRAMS[key].fs, /uniform int u_face;/);
  }
});

test('idle costs nothing: no animation frame, ambient motion capped and gated', async () => {
  const directory = new URL('../assets/js/rendering/backdrops/', import.meta.url);
  for (const file of await readdir(directory)) {
    const source = await read(`assets/js/rendering/backdrops/${file}`);
    assert.doesNotMatch(source, /requestAnimationFrame\(/, `${file} schedules no frames of its own`);
  }
  const renderer = await read('assets/js/rendering/backdrops/backdrop-look-renderer.js');
  assert.match(renderer, /requestIdleCallback\(runSlice/);
  assert.match(renderer, /setTimeout\(tickAmbient, 1000 \/ BACKDROP_AMBIENT_MAX_HZ\)/);
  assert.match(renderer, /document\.visibilityState !== 'hidden'/);
  assert.match(renderer, /!prefersReducedMotion\(\)/);
  assert.match(renderer, /let ambientEnabled = false;/);
  // The viewer wakes for a look only through its fade, never for idle.
  const viewer = await read('assets/js/rendering/viewer.js');
  assert.match(viewer, /const backdropLookCause = backdropLooks\.frameCause\(\);/);
  assert.match(viewer, /backdropLooks\.forgetView\(exactId\);/);
  assert.match(viewer, /backdropLooks\.abandon\(\);/);
});

test('figure export maps every plot pixel to the pane NDC it shows', () => {
  // A 200 × 100 pane letterboxed into a 300 × 300 plot at (10, 20): the pane
  // fills the width and sits centred vertically, as the points do.
  const renderState = { viewportWidth: 200, viewportHeight: 100 };
  const plotRect = { x: 10, y: 20, width: 300, height: 300 };
  const { ndcTransform: [sx, sy, ox, oy], viewportPerPlot } = resolveBackdropLookPlacement({ renderState, plotRect });
  assert.ok(Math.abs(viewportPerPlot - 200 / 300) < 1e-12);
  const pane = (cx, cy) => [cx * sx + ox, cy * sy + oy];
  // Left and right plot edges are the pane's left and right edges.
  assert.deepEqual(pane(-1, 0).map((v) => +v.toFixed(9)), [-1, 0]);
  assert.deepEqual(pane(1, 0).map((v) => +v.toFixed(9)), [1, 0]);
  // The plot is taller than the pane: its top shows above the pane (NDC > 1).
  assert.ok(Math.abs(pane(0, 1)[1] - 2) < 1e-9);
  assert.ok(Math.abs(pane(0, -1)[1] + 2) < 1e-9);

  // A crop: the right half of the pane fills the plot.
  const crop = { enabled: true, x: 0.5, y: 0, width: 0.5, height: 1 };
  const cropped = resolveBackdropLookPlacement({ renderState, plotRect: { x: 0, y: 0, width: 100, height: 100 }, crop });
  const [csx, , cox] = cropped.ndcTransform;
  assert.ok(Math.abs(-csx + cox - 0) < 1e-9, 'the plot\'s left edge is the pane centre');
  assert.ok(Math.abs(csx + cox - 1) < 1e-9, 'the plot\'s right edge is the pane edge');
});

test('a figure draws the look only on the viewer\'s own paper', () => {
  const renderState = { backdrop: { look: { id: 'nebula' } } };
  const look = { kind: 'look', mode: 'nebula' };
  assert.equal(figureDrawsBackdropLook(look, { viewerPaper: true }, renderState), true);
  assert.equal(figureDrawsBackdropLook(look, { viewerPaper: false }, renderState), false);
  assert.equal(figureDrawsBackdropLook({ kind: 'studio' }, { viewerPaper: true }, renderState), false);
  assert.equal(figureDrawsBackdropLook(look, { viewerPaper: true }, { backdrop: { look: null } }), false);
});

test('the scene redraws while a look fades and never for its tints or its bakes alone', async () => {
  const viewer = await read('assets/js/rendering/viewer.js');
  const sceneWide = viewer.slice(viewer.indexOf('function sceneWideAnimationActive()'));
  assert.match(sceneWide.slice(0, sceneWide.indexOf('\n  }\n')), /backdropLooks\.frameCause\(\) !== null/);
  const renderer = await read('assets/js/rendering/backdrops/backdrop-look-renderer.js');
  const frameCause = renderer.slice(renderer.indexOf('function frameCause()'));
  const body = frameCause.slice(0, frameCause.indexOf('\n  }\n'));
  assert.match(body, /'backdrop-fade'/);
  assert.doesNotMatch(body, /tint/);
  // Only the family on screen keeps its bake; leaving the looks releases all.
  assert.match(renderer, /evictFamiliesExcept\(family\);/);
  assert.match(renderer, /evictFamiliesExcept\(null\);/);
  // A change of the reduced-motion setting is honoured at once.
  assert.match(renderer, /addEventListener\?\.\('change', onReducedMotion\)/);
});
