// How a gene read for a sample of the open cells is drawn (owner decision
// 2026-10-29): cells not read faded from the background, distinct from the
// grey for 0; the read cells on top, larger by their density on screen,
// zeros beneath the expressing cells; every surface by the same rule. And
// the grey for 0 (and every missing value) made from the background at a
// fixed contrast (owner decision 2026-10-30).

import assert from 'node:assert/strict';
import test from 'node:test';

import { NEUTRAL_GRAY_UINT8 } from '../assets/js/app/state/core/constants.js';
import { BENEATH_ALPHA_BYTE, UNREAD_ALPHA_BYTE, colorLayersOf } from '../assets/js/rendering/alpha-visibility.js';
import {
  READ_CELLS_COVERED_FRACTION,
  ZERO_LIGHTNESS_CONTRAST,
  cellLayerColors,
  drawnCellRgb,
  readCellProbes,
  readCellSizeMultiplier,
  unreadCellColor,
  zeroCellColor,
} from '../assets/js/rendering/read-cell-layer.js';
import { backdropLookSurface01, BACKDROP_LOOKS } from '../assets/js/rendering/backdrops/backdrop-looks.js';
import { readCellSlots } from '../assets/js/rendering/high-perf/read-cell-index.js';
import { findScreenSpacePick } from '../assets/js/rendering/picking.js';
import { drawnSequence, figurePointLayersOf } from '../assets/js/app/ui/modules/figure-export/utils/lod-membership.js';
import { writeContinuousColors } from '../assets/js/app/state/managers/continuous-colors.js';
import { CONTINUOUS_COLORMAPS } from '../assets/js/data/palettes.js';
import { createMulberry32 } from '../assets/js/app/utils/random-utils.js';
import { geneSampleLayersNote } from '../assets/js/data/gene-read-plan.js';

/** CIE L* of an sRGB color (0..1), by its definition. */
function lightness(rgb) {
  const linear = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const y = 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
  return y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (24389 / 27) * y;
}

const GREY = NEUTRAL_GRAY_UINT8 / 255;
// The viewer's backgrounds: studio light/dark surfaces, light/dark grid, white, black.
const BACKGROUNDS = {
  studio: [236 / 255, 236 / 255, 236 / 255],
  'studio-dark': [17 / 255, 17 / 255, 17 / 255],
  grid: [0.965, 0.965, 0.97],
  'grid-dark': [0.08, 0.09, 0.1],
  white: [1, 1, 1],
  black: [0, 0, 0],
};

test('the grey for 0 is made from the background at a fixed contrast: today\'s on white, mid-dark on dark backgrounds, never outshining a colormap', () => {
  // On white, exactly the grey of 211 the app always drew.
  assert.deepEqual(cellLayerColors([1, 1, 1]).zero, [GREY * 255, GREY * 255, GREY * 255]);
  assert.ok(Math.abs(ZERO_LIGHTNESS_CONTRAST - (100 - lightness([GREY, GREY, GREY]))) < 1e-9);
  for (const [name, background] of Object.entries(BACKGROUNDS)) {
    const zero = zeroCellColor(background);
    const from = lightness(background);
    // A neutral grey, the contrast step from the background, toward the middle.
    assert.ok(zero[0] === zero[1] && zero[1] === zero[2], `${name}: neutral`);
    assert.ok(Math.abs(Math.abs(lightness(zero) - from) - ZERO_LIGHTNESS_CONTRAST) < 0.05, `${name}: the fixed contrast (${lightness(zero).toFixed(2)} on ${from.toFixed(2)})`);
    assert.equal(Math.sign(lightness(zero) - from), from >= 50 ? -1 : 1, `${name}: darker on light, lighter on dark`);
    if (from < 50) {
      // Mid-dark on a dark background, never the light grey that outshone the expressing cells.
      assert.ok(lightness(zero) < 30, `${name}: mid-dark (${lightness(zero).toFixed(1)} L*)`);
      assert.ok(lightness(zero) < lightness([GREY, GREY, GREY]) - 50, `${name}: far below the light grey`);
    }
    // Never brighter than a colormap's visible range: on every background,
    // most of every colormap stands out from it more than the grey does.
    for (const colormap of CONTINUOUS_COLORMAPS) {
      let standsOut = 0;
      for (let k = 0; k <= 100; k++) {
        if (Math.abs(lightness(colormap.sample(k / 100)) - from) > ZERO_LIGHTNESS_CONTRAST) standsOut++;
      }
      assert.ok(standsOut / 101 >= 0.5, `${name} ${colormap.id}: ${standsOut} of 101 stand out more than the grey`);
    }
  }
  // Every backdrop look's surface follows the same rule.
  for (const look of Object.keys(BACKDROP_LOOKS)) {
    const surface = backdropLookSurface01(look);
    assert.ok(Math.abs(Math.abs(lightness(zeroCellColor(surface)) - lightness(surface)) - ZERO_LIGHTNESS_CONTRAST) < 0.05, look);
  }
  assert.throws(() => zeroCellColor([1, 1]), /three channels/);
});

test('every surface draws a cell from its colors the same way: its own RGB on top, the layer\'s color beneath', () => {
  const colors = Uint8Array.of(10, 20, 30, 255, 211, 211, 211, BENEATH_ALPHA_BYTE, 211, 211, 211, UNREAD_ALPHA_BYTE);
  for (const background of [[1, 1, 1], [0.08, 0.09, 0.1]]) {
    const layerColors = cellLayerColors(background);
    assert.deepEqual(drawnCellRgb(colors, 0, layerColors), [10, 20, 30]);
    assert.deepEqual(drawnCellRgb(colors, 1, layerColors), Array.from(layerColors.zero));
    assert.deepEqual(drawnCellRgb(colors, 2, layerColors), Array.from(layerColors.unread));
    assert.deepEqual(Array.from(layerColors.unread), Array.from(unreadCellColor(background), channel => Math.round(channel * 255)));
  }
  // The dark grid: the grey of 0 a mid-dark 55, the fade between it and the background.
  assert.deepEqual(cellLayerColors([0.08, 0.09, 0.1]).zero, [55, 55, 55]);
});

test('a cell not read is the background faded a small lightness step toward the grey for 0, never reaching it', () => {
  for (const [name, background] of Object.entries(BACKGROUNDS)) {
    const unread = unreadCellColor(background);
    const from = lightness(background);
    const grey = lightness(zeroCellColor(background));
    const step = Math.abs(lightness(unread) - from);
    assert.ok(step > 1, `${name}: the map keeps its shape (${step.toFixed(2)} L*)`);
    // (Float32 channels: a thousandth of an L* of rounding.)
    assert.ok(step <= 8 + 1e-3, `${name}: it recedes, at most the step`);
    assert.ok(step <= Math.abs(grey - from) / 2 + 1e-3, `${name}: at most half way to the grey`);
    assert.ok(Math.abs(lightness(unread) - grey) >= Math.abs(grey - from) / 2 - 1e-3, `${name}: distinct from the grey for 0`);
    // It moves toward the grey: darker on light themes, lighter on dark ones.
    assert.equal(Math.sign(lightness(unread) - from), Math.sign(grey - from), name);
  }
  assert.throws(() => unreadCellColor([1, 1]), /three channels/);
  assert.throws(() => unreadCellColor([2, 0, 0]), /from 0 to 1/);
});

test('the layers of a field\'s colors are counted in one pass, aligned or not', () => {
  const colors = new Uint8Array(4 * 10).fill(255);
  assert.deepEqual(colorLayersOf(colors), { layered: false, unread: 0 });
  colors[3] = BENEATH_ALPHA_BYTE;
  assert.deepEqual(colorLayersOf(colors), { layered: true, unread: 0 });
  for (const cell of [2, 5, 9]) colors[cell * 4 + 3] = UNREAD_ALPHA_BYTE;
  assert.deepEqual(colorLayersOf(colors), { layered: true, unread: 3 });
  const unaligned = new Uint8Array(new ArrayBuffer(41), 1, 40);
  unaligned.set(colors);
  assert.deepEqual(colorLayersOf(unaligned), { layered: true, unread: 3 });
});

/** A map of `n` cells filling a square of the screen, read for every `stride`-th. */
function sampledMap(n, stride, random = createMulberry32(5)) {
  const positions = new Float32Array(n * 2);
  for (let i = 0; i < positions.length; i++) positions[i] = random() * 1.6 - 0.8;
  const colors = new Uint8Array(n * 4).fill(255);
  let unread = 0;
  for (let cell = 0; cell < n; cell++) {
    if (cell % stride !== 0) {
      colors[cell * 4 + 3] = UNREAD_ALPHA_BYTE;
      unread++;
    }
  }
  return { positions, colors, unread };
}

const IDENTITY = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const frameOf = (positions, extra = {}) => ({
  positions, dimension: 2, transparency: null, mvpMatrix: IDENTITY,
  width: 1600, height: 1200, pointSize: 2, sizeAttenuation: 0, fov: Math.PI / 4, pointSizeMax: 160, ...extra,
});

test('the read cells are sized by their density on screen: a sparse sample large, a dense one normal, every cell read normal', () => {
  // 2,000 of 2M cells over 64% of a 1600 x 1200 screen: discs covering the
  // covered fraction of the map have d = sqrt(c * A / n) device pixels.
  const sparse = sampledMap(200_000, 100);
  const probes = readCellProbes(sparse.colors, sparse.unread);
  assert.equal(probes.readCount, 2_000);
  assert.equal(probes.read.length, 2_000);
  const area = 1600 * 0.8 * 1200 * 0.8;
  const coverage = (4 / Math.PI) * Math.log(1 / (1 - READ_CELLS_COVERED_FRACTION));
  // Normal points of 4 px: every cell drawn covers more than that fraction.
  const expected = Math.sqrt((coverage * area) / 2_000) / 4;
  const multiplier = readCellSizeMultiplier(probes, frameOf(sparse.positions, { pointSize: 4 }));
  assert.ok(Math.abs(multiplier - expected) / expected < 0.08, `${multiplier} vs ${expected}`);
  // Capped where the read cells would be as dense as every cell drawn.
  assert.equal(readCellSizeMultiplier(probes, frameOf(sparse.positions, { pointSize: 1 })), 10);

  // A sample already dense on screen at the normal size of 2 px (as 1M of
  // 10M on a whole screen; here 20,000 cells on 400 x 300): normal.
  const dense = sampledMap(200_000, 10);
  const denseMultiplier = readCellSizeMultiplier(readCellProbes(dense.colors, dense.unread), frameOf(dense.positions, { width: 400, height: 300 }));
  assert.equal(denseMultiplier, 1);

  // Every cell read: no probes, normal.
  assert.equal(readCellProbes(new Uint8Array(400).fill(255), 0), null);
  assert.equal(readCellSizeMultiplier(null, frameOf(dense.positions)), 1);

  // Zoomed in 1.5 times: the read cells spread apart and grow with the map
  // (some leave the screen; those on it are as dense as before over less area).
  const zoomed = readCellSizeMultiplier(probes, frameOf(sparse.positions, {
    pointSize: 4,
    mvpMatrix: Float32Array.from([1.5, 0, 0, 0, 0, 1.5, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  }));
  assert.ok(zoomed > multiplier * 1.3, `${zoomed} grows from ${multiplier}`);

  // Filtered to a quarter of the map: fewer read cells on less area, the same density.
  const transparency = new Uint8Array(200_000);
  for (let cell = 0; cell < 200_000; cell++) transparency[cell] = sparse.positions[cell * 2] < -0.4 ? 1 : 0;
  const filtered = readCellSizeMultiplier(probes, frameOf(sparse.positions, { transparency, pointSize: 4 }));
  assert.ok(Math.abs(filtered - multiplier) / multiplier < 0.2, `${filtered} vs ${multiplier}`);
});

test('the read cells\' slot list names every read cell by its local slot, in slot order, for any store order and segments', () => {
  const n = 10;
  const colors = new Uint8Array(n * 4).fill(255);
  for (const cell of [1, 2, 4, 7, 8]) colors[cell * 4 + 3] = UNREAD_ALPHA_BYTE;
  colors[3 * 4 + 3] = BENEATH_ALPHA_BYTE;
  const segments = [{ first: 0, count: 4 }, { first: 4, count: 4 }, { first: 8, count: 2 }];
  const plain = readCellSlots(colors, null, segments, 5);
  assert.deepEqual(Array.from(plain.slots), [0, 3, 1, 2, 1]);
  assert.deepEqual(Array.from(plain.starts), [0, 2, 4, 5]);
  const sources = Uint32Array.from([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  const reversed = readCellSlots(colors, sources, segments, 5);
  // Slot s holds cell 9 - s: read cells 9, 6, 5, 3, 0 sit in slots 0, 3, 4, 6, 9.
  assert.deepEqual(Array.from(reversed.slots), [0, 3, 0, 2, 1]);
  assert.deepEqual(Array.from(reversed.starts), [0, 2, 4, 5]);
  assert.throws(() => readCellSlots(colors, null, segments, 4), /more than the 4/);
  assert.throws(() => readCellSlots(colors, null, segments, 6), /holds 5 of the 6/);
});

test('picking finds a read cell at its drawn size, over the cells not read around it, at every level it is drawn', () => {
  // Two cells on one spot: cell 0 read (drawn larger, on top), cell 1 not read.
  const positions = Float32Array.from([0, 0, 0.02, 0]);
  const transparency = Uint8Array.of(1, 1);
  const colors = Uint8Array.of(200, 0, 0, 255, NEUTRAL_GRAY_UINT8, NEUTRAL_GRAY_UINT8, NEUTRAL_GRAY_UINT8, UNREAD_ALPHA_BYTE);
  const base = {
    dimension: 2, positions, transparency, mvpMatrix: IDENTITY,
    pane: { cssWidth: 100, cssHeight: 100, framebufferHeight: 100 }, pointSize: 2, sizeAttenuation: 0, fov: Math.PI / 4, pointSizeMax: 160,
  };
  // The pointer over cell 1's center: it is drawn there, but the read cell drawn
  // 20 px wide over it is on top.
  const cursor = { x: 51, y: 50 };
  assert.equal(findScreenSpacePick({ ...base, cursor }).cellIndex, 1, 'without layers, the nearer centre');
  const pointLayers = { colors, readEveryLevel: true, readPointSize: 20 };
  assert.equal(findScreenSpacePick({ ...base, cursor, pointLayers }).cellIndex, 0, 'the read layer wins');
  // 8 px from the read cell's center: inside its drawn 10 px radius only.
  assert.equal(findScreenSpacePick({ ...base, cursor: { x: 58, y: 50 }, pointLayers }).cellIndex, 0);
  assert.equal(findScreenSpacePick({ ...base, cursor: { x: 58, y: 50 } }).cellIndex, -1);
  // A level drawing only cell 1: the read cell is still drawn (every level), and picked.
  const lodMembership = Object.freeze({ count: 1, admissionLevels: Uint8Array.of(255, 0), lodLevel: 0, pointCount: 2, dimensionLevel: 2, indices: Uint32Array.of(1), generationToken: Object.freeze({}) });
  assert.equal(findScreenSpacePick({ ...base, cursor, pointLayers, lodMembership }).cellIndex, 0);
  assert.equal(findScreenSpacePick({ ...base, cursor, pointLayers: { ...pointLayers, readEveryLevel: false }, lodMembership }).cellIndex, 1);
  assert.throws(() => findScreenSpacePick({ ...base, cursor, pointLayers: { colors: new Uint8Array(4), readEveryLevel: true, readPointSize: 2 } }), /pointLayers/);
});

test('a figure draws the layers bottom first and every read cell when the pane did, in the pane\'s order', () => {
  // Cells 0..5 in draw order 5..0; a level drawing cells 5, 4, 3.
  const colors = new Uint8Array(6 * 4).fill(255);
  colors[0 * 4 + 3] = UNREAD_ALPHA_BYTE;
  colors[1 * 4 + 3] = BENEATH_ALPHA_BYTE;
  colors[3 * 4 + 3] = UNREAD_ALPHA_BYTE;
  colors[4 * 4 + 3] = BENEATH_ALPHA_BYTE;
  const drawOrder = Uint32Array.of(5, 4, 3, 2, 1, 0);
  const membership = { indices: Uint32Array.of(5, 4, 3) };
  assert.deepEqual(Array.from(drawnSequence(null, drawOrder, colors)), [3, 0, 4, 1, 5, 2]);
  assert.deepEqual(Array.from(drawnSequence(membership, drawOrder, colors)), [3, 4, 5]);
  assert.deepEqual(Array.from(drawnSequence(membership, drawOrder, colors, true)), [3, 4, 1, 5, 2]);
  // The colors of the cells not read and of the grey beneath come from the figure's paper.
  const layers = figurePointLayersOf(colors, { readScale: 3, readEveryLevel: true }, [1, 1, 1]);
  assert.deepEqual(layers.unreadColor, Array.from(unreadCellColor([1, 1, 1])));
  assert.deepEqual(layers.zeroColor, Array.from(zeroCellColor([1, 1, 1])));
  const dark = figurePointLayersOf(colors, { readScale: 3, readEveryLevel: true }, [0, 0, 0]);
  assert.deepEqual(dark.zeroColor, Array.from(zeroCellColor([0, 0, 0])));
  // Every cell read but some beneath (a gene read whole, a missing value): the grey, normal sizes.
  const zerosOnly = Uint8Array.of(255, 255, 255, 255, 211, 211, 211, BENEATH_ALPHA_BYTE);
  assert.deepEqual(figurePointLayersOf(zerosOnly, { readScale: 3, readEveryLevel: true }, [0, 0, 0]), {
    readScale: 1, readEveryLevel: false, unreadColor: Array.from(unreadCellColor([0, 0, 0])), zeroColor: Array.from(zeroCellColor([0, 0, 0])),
  });
  // Every cell on top: none.
  assert.equal(figurePointLayersOf(new Uint8Array(8).fill(255), { readScale: 1, readEveryLevel: true }, [1, 1, 1]), null);
  assert.equal(geneSampleLayersNote(true), 'Faded: not read · gray: 0');
  assert.equal(geneSampleLayersNote(false), 'Faded: not read');
});

test('a gene\'s cells past the sample are not read, whatever a dense column holds there', () => {
  const n = 1000;
  const column = new Float32Array(n);
  for (let cell = 0; cell < n; cell += 7) column[cell] = 1 + (cell % 5);
  column.fill(Number.NaN, 900);
  const colors = new Uint8Array(n * 4);
  writeContinuousColors(colors, column, { min: 0, max: 5, scale: 'linear', neutralAtOrBelow: 0, readRows: 600 }, CONTINUOUS_COLORMAPS[0]);
  for (let cell = 0; cell < n; cell++) {
    const layer = colors[cell * 4 + 3];
    if (cell >= 600) assert.equal(layer, UNREAD_ALPHA_BYTE, `cell ${cell} not read`);
    else assert.equal(layer, column[cell] > 0 ? 255 : BENEATH_ALPHA_BYTE, `cell ${cell}`);
  }
  assert.throws(() => writeContinuousColors(colors, column, { min: 0, max: 5, scale: 'linear', readRows: n + 1 }, CONTINUOUS_COLORMAPS[0]), /cells read/);
});
