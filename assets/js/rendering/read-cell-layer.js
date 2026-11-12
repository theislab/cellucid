/**
 * How a field with cells not read is drawn: the look of a gene read for a
 * sample of the open cells (`data/anndata/subsample-plan.js`, `genes`) on a
 * map of all of them.
 *
 * A color's alpha byte names its cell's layer (`alpha-visibility.js`):
 * cells not read (`UNREAD_ALPHA_BYTE`) lie at the bottom, the grey of the
 * cells read with no value (`BENEATH_ALPHA_BYTE`: a gene's zeros, a missing
 * value, a category's missing cells) above them, and the expressing cells on
 * top. Every surface that draws cells follows the same rules, from this
 * module:
 *
 * - **The grey for 0** (`zeroCellColor`). A cell with no value is drawn in a
 *   neutral grey made from the background it is drawn on: its lightness
 *   (CIE L*) a fixed step (`ZERO_LIGHTNESS_CONTRAST`) from the background's,
 *   toward the middle: darker than a light background (on white the grey of
 *   211, as always), lighter than a dark one (a mid-dark grey: 56 on the
 *   dark grid, 38 on black). So it stands out from the background as much
 *   on every theme, and never more than the colors of a field's values:
 *   on a dark background the light grey of 211 outshone the expressing
 *   cells. Its RGB bytes in a colors array are not drawn (`cellLayerColors`
 *   names what is).
 * - **The fade** (`unreadCellColor`). A cell not read is drawn flat in the
 *   view's background moved a small step of lightness toward the grey for
 *   0 (`UNREAD_LIGHTNESS_STEP`, at most half the way, so it never meets that
 *   grey): the map keeps its shape and recedes, and a cell not read never
 *   looks like a 0. It follows the theme because it is made from the
 *   background the view is drawn on (light, dark, a figure's own paper).
 * - **The size** (`readCellSizeMultiplier`). While some cells are not read,
 *   the cells read are drawn larger, by their density on screen: the
 *   diameter at which the read cells shown would cover
 *   `READ_CELLS_COVERED_FRACTION` of the area the map takes on screen, never
 *   below the normal size, and never above the size at which they would be
 *   as dense as every cell drawn at the normal size (so when the sample is
 *   every cell, sizes are normal). 2,000 cells of 2.3M on a whole-screen map
 *   are drawn about ten times larger; a sample of 1M of 10M, already dense
 *   on screen, at the normal size.
 * - **The order**. Cells not read are drawn first, without depth writes, so
 *   every cell read shows over them in 2-D and 3-D; the read cells are drawn
 *   from their own slot list (`ReadCellIndex`) whenever there are no more of
 *   them than a level of detail draws, so a reduced level draws every one
 *   (more of them than that: each level draws its own share,
 *   `HighPerfRenderer`), and are picked at the size they are drawn
 *   (`picking.js`).
 *
 * @module rendering/read-cell-layer
 */

import { NEUTRAL_GRAY_UINT8 } from '../app/state/core/constants.js';
import { BENEATH_ALPHA_BYTE, UNREAD_ALPHA_BYTE } from './alpha-visibility.js';
import { drawnPointRadiusCss } from './picking.js';

/**
 * The lightness step (CIE L*) from the background to the grey for 0: the
 * step of the grey of 211 from white (15.4), the contrast that grey always
 * had on the light themes, kept on every background.
 */
export const ZERO_LIGHTNESS_CONTRAST = 100 - lightnessOf([NEUTRAL_GRAY_UINT8 / 255, NEUTRAL_GRAY_UINT8 / 255, NEUTRAL_GRAY_UINT8 / 255]);

/**
 * The lightness step (CIE L*) from the background to a cell not read: about
 * four just-noticeable differences for large patches, enough for the dense
 * cloud of the map to show its shape, small enough that it recedes behind
 * every cell read.
 */
export const UNREAD_LIGHTNESS_STEP = 8;

/**
 * The share of the map's on-screen area the read cells cover at their
 * drawn size (randomly placed discs: `1 - exp(-n * pi * d^2 / (4 * A))`):
 * enough that the expression pattern reads at once, few enough overlaps
 * that each read cell stays a separate dot.
 */
export const READ_CELLS_COVERED_FRACTION = 0.4;

/**
 * Cells projected each frame to measure the map's area and the read cells'
 * share of it (each set strided over its cells): a fixed sampling cost of
 * well under a millisecond, whatever the dataset's size.
 */
const PROBE_CELLS = 8192;

/**
 * Probes per occupied cell of the area grid: enough that a cell inside the
 * map is never empty by chance, so the area counts the map, not its probes.
 */
const PROBES_PER_AREA_CELL = 8;

/** `n * d^2 / A` at the covered fraction above (discs, randomly placed). */
const READ_CELLS_COVERAGE = (4 / Math.PI) * Math.log(1 / (1 - READ_CELLS_COVERED_FRACTION));

function srgbToLinear(channel) {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** CIE L* of an sRGB color (channels 0..1). */
function lightnessOf(rgb) {
  const y = 0.2126 * srgbToLinear(rgb[0]) + 0.7152 * srgbToLinear(rgb[1]) + 0.0722 * srgbToLinear(rgb[2]);
  return y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (24389 / 27) * y;
}

function requireRgb01(rgb, label) {
  if (rgb === null || typeof rgb !== 'object' || rgb.length < 3) {
    throw new TypeError(`${label} must hold three channels from 0 to 1.`);
  }
  for (let channel = 0; channel < 3; channel++) {
    if (!(rgb[channel] >= 0 && rgb[channel] <= 1)) {
      throw new RangeError(`${label} channel ${channel} must be from 0 to 1, not ${rgb[channel]}.`);
    }
  }
  return rgb;
}

/** The sRGB channel (0..1) of a neutral grey of CIE lightness `lightness`. */
function greyOfLightness(lightness) {
  const l = Math.min(100, Math.max(0, lightness));
  const y = l > 8 ? ((l + 16) / 116) ** 3 : l * (27 / 24389);
  const channel = y <= 0.0031308 ? 12.92 * y : 1.055 * y ** (1 / 2.4) - 0.055;
  return Math.min(1, Math.max(0, channel));
}

/**
 * The color a cell with no value (a gene's 0, a missing value, a
 * category's missing cells) is drawn in over `background` (sRGB, channels
 * 0..1): a neutral grey `ZERO_LIGHTNESS_CONTRAST` of CIE lightness from the
 * background's, darker on a background lighter than the middle (L* 50),
 * lighter on one darker.
 *
 * @param {ArrayLike<number>} background
 * @param {Float32Array} [target] - Written and returned.
 * @returns {Float32Array}
 */
export function zeroCellColor(background, target = new Float32Array(3)) {
  requireRgb01(background, 'The background of the gray for 0');
  const from = lightnessOf(background);
  const grey = greyOfLightness(from >= 50 ? from - ZERO_LIGHTNESS_CONTRAST : from + ZERO_LIGHTNESS_CONTRAST);
  target[0] = grey;
  target[1] = grey;
  target[2] = grey;
  return target;
}

/**
 * The color a cell not read is drawn in over `background` (sRGB, channels
 * 0..1): the background mixed toward the grey for 0 (`zeroCellColor`) until
 * its lightness has moved `UNREAD_LIGHTNESS_STEP`, or half the way to that
 * grey's lightness where the two are closer than twice the step.
 *
 * @param {ArrayLike<number>} background
 * @param {Float32Array} [target] - Written and returned.
 * @returns {Float32Array}
 */
export function unreadCellColor(background, target = new Float32Array(3)) {
  requireRgb01(background, 'The background of cells not read');
  const grey = zeroCellColor(background)[0];
  const from = lightnessOf(background);
  const distance = Math.abs(lightnessOf([grey, grey, grey]) - from);
  const step = Math.min(UNREAD_LIGHTNESS_STEP, distance / 2);
  // Lightness moves monotonically along the mix: bisection finds the share.
  const mixed = [0, 0, 0];
  const mixAt = share => {
    for (let channel = 0; channel < 3; channel++) {
      mixed[channel] = background[channel] + (grey - background[channel]) * share;
    }
    return mixed;
  };
  let low = 0;
  let high = 1;
  if (distance > 0) {
    for (let iteration = 0; iteration < 40; iteration++) {
      const share = (low + high) / 2;
      if (Math.abs(lightnessOf(mixAt(share)) - from) < step) low = share;
      else high = share;
    }
  }
  mixAt(low);
  target[0] = mixed[0];
  target[1] = mixed[1];
  target[2] = mixed[2];
  return target;
}

/**
 * The colors the lower layers are drawn in over `background` (sRGB,
 * channels 0..1), as bytes: `zero`, the grey of the cells with no value
 * (`BENEATH_ALPHA_BYTE`), and `unread`, the fade of the cells not read
 * (`UNREAD_ALPHA_BYTE`). What every surface that draws a cell's color
 * from a colors array substitutes for those layers' RGB bytes
 * (`drawnCellRgb`): the views (`HighPerfRenderer`, smoke), the figures and
 * the cell info card.
 *
 * @param {ArrayLike<number>} background
 * @returns {Readonly<{zero: Readonly<number[]>, unread: Readonly<number[]>}>}
 */
export function cellLayerColors(background) {
  const bytes = rgb => Object.freeze(Array.from(rgb, channel => Math.round(channel * 255)));
  return Object.freeze({ zero: bytes(zeroCellColor(background)), unread: bytes(unreadCellColor(background)) });
}

/**
 * The RGB bytes cell `index` of `colors` (RGBA8, its alpha byte the layer)
 * is drawn in: its own, or its layer's color (`cellLayerColors`).
 *
 * @param {Uint8Array} colors
 * @param {number} index
 * @param {{zero: ArrayLike<number>, unread: ArrayLike<number>}} layerColors
 * @returns {number[]}
 */
export function drawnCellRgb(colors, index, layerColors) {
  const at = index * 4;
  const layer = colors[at + 3];
  if (layer === BENEATH_ALPHA_BYTE) return Array.from(layerColors.zero);
  if (layer === UNREAD_ALPHA_BYTE) return Array.from(layerColors.unread);
  return [colors[at], colors[at + 1], colors[at + 2]];
}

/**
 * The cells a frame projects to size the read cells (`readCellSizeMultiplier`)
 * for one colors array: up to `PROBE_CELLS` of every cell and as many of the
 * cells read, each strided evenly over its cells, and how many are read.
 * Made again when the colors change; null when every cell is read.
 *
 * @param {Uint8Array} colors - RGBA8, the alpha byte the cell's layer.
 * @param {number} unread - Cells not read (`colorLayersOf`).
 * @returns {Readonly<{pointCount: number, readCount: number, all: Uint32Array, read: Uint32Array}>|null}
 */
export function readCellProbes(colors, unread) {
  const pointCount = colors.length >>> 2;
  const readCount = pointCount - unread;
  if (!(unread > 0) || readCount < 0) return null;
  const allCount = Math.min(pointCount, PROBE_CELLS);
  const all = new Uint32Array(allCount);
  for (let k = 0; k < allCount; k++) all[k] = Math.floor(((k + 0.5) * pointCount) / allCount);
  const readProbeCount = Math.min(readCount, PROBE_CELLS);
  const read = new Uint32Array(readProbeCount);
  let taken = 0;
  let seen = 0;
  for (let cell = 0; cell < pointCount && taken < readProbeCount; cell++) {
    if (colors[cell * 4 + 3] === UNREAD_ALPHA_BYTE) continue;
    // The read cell `seen` is the probe `taken` when the stride reaches it.
    if (Math.floor(((taken + 0.5) * readCount) / readProbeCount) === seen) read[taken++] = cell;
    seen++;
  }
  return Object.freeze({ pointCount, readCount, all, read });
}

/** Scratch of the projection below, grown to the largest probe set seen. */
const scratch = { x: new Float32Array(0), y: new Float32Array(0), grid: new Uint8Array(0) };

/**
 * Project probe cell `cell` and say whether it is drawn on screen; its
 * device-pixel position goes to `out` (x, y, clip w).
 */
function projectProbe(cell, frame, out) {
  const { positions, dimension, transparency, mvpMatrix: m, width, height } = frame;
  if (transparency !== null && transparency[cell] === 0) return false;
  const offset = cell * dimension;
  const x = positions[offset];
  const y = dimension > 1 ? positions[offset + 1] : 0;
  const z = dimension > 2 ? positions[offset + 2] : 0;
  // An unplaced cell (NaN) fails every comparison below.
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (!(w > 0)) return false;
  const ndcX = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
  const ndcY = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
  const ndcZ = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
  if (!(ndcX >= -1 && ndcX <= 1 && ndcY >= -1 && ndcY <= 1 && ndcZ >= -1 && ndcZ <= 1)) return false;
  out[0] = (ndcX * 0.5 + 0.5) * width;
  out[1] = (0.5 - ndcY * 0.5) * height;
  out[2] = w;
  return true;
}

/**
 * The size multiplier of the cells read in one frame (1: normal size): the
 * diameter at which the read cells drawn on screen cover
 * `READ_CELLS_COVERED_FRACTION` of the area the map's drawn cells take,
 * over the diameter a read cell is drawn at normally, from 1 up to the
 * square root of the drawn cells over the read ones.
 *
 * The map's area is the cells of a grid over the drawn probes' bounds that
 * hold one (grid cells sized for `PROBES_PER_AREA_CELL` probes each, never
 * narrower than a drawn point); the read cells on screen are the read
 * probes on screen, scaled to every read cell drawn.
 *
 * @param {ReturnType<typeof readCellProbes>} probes
 * @param {Object} frame
 * @param {Float32Array} frame.positions
 * @param {1|2|3} frame.dimension
 * @param {Uint8Array|null} frame.transparency - Null: every cell shown.
 * @param {ArrayLike<number>} frame.mvpMatrix - Column-major, as drawn.
 * @param {number} frame.width - Viewport, device pixels.
 * @param {number} frame.height
 * @param {number} frame.pointSize - u_pointSize of the read cells before this multiplier.
 * @param {number} frame.sizeAttenuation
 * @param {number} frame.fov
 * @param {number} frame.pointSizeMax - u_pointSizeMax (rendering/point-sprite.js)
 * @param {number} [frame.readShare=1] - The share of the read cells this frame draws (a reduced level drawing them by rank).
 * @returns {number}
 */
export function readCellSizeMultiplier(probes, frame) {
  if (probes === null) return 1;
  const { width, height, pointSize, sizeAttenuation, fov, pointSizeMax } = frame;
  const readShare = frame.readShare ?? 1;
  const allCount = probes.all.length;
  if (scratch.x.length < allCount) {
    scratch.x = new Float32Array(allCount);
    scratch.y = new Float32Array(allCount);
  }
  const point = [0, 0, 0];
  let shown = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let k = 0; k < allCount; k++) {
    if (!projectProbe(probes.all[k], frame, point)) continue;
    scratch.x[shown] = point[0];
    scratch.y[shown] = point[1];
    shown++;
    if (point[0] < minX) minX = point[0];
    if (point[0] > maxX) maxX = point[0];
    if (point[1] < minY) minY = point[1];
    if (point[1] > maxY) maxY = point[1];
  }
  const sizeInput = { w: 1, pointSize, sizeAttenuation, fov, framebufferHeight: height, devicePixelRatio: 1, pointSizeMax };
  let readShown = 0;
  let diameterSum = 0;
  for (let k = 0; k < probes.read.length; k++) {
    if (!projectProbe(probes.read[k], frame, point)) continue;
    readShown++;
    sizeInput.w = point[2];
    diameterSum += 2 * drawnPointRadiusCss(sizeInput);
  }
  if (shown === 0 || readShown === 0) return 1;
  const diameter = diameterSum / readShown;
  const readOnScreen = (probes.readCount * readShare * readShown) / probes.read.length;
  const cellsOnScreen = (probes.pointCount * shown) / allCount;

  const across = Math.max(1, Math.floor(Math.sqrt(shown / PROBES_PER_AREA_CELL)));
  const cellWidth = Math.max((maxX - minX) / across, diameter);
  const cellHeight = Math.max((maxY - minY) / across, diameter);
  const columns = Math.max(1, Math.ceil((maxX - minX) / cellWidth));
  const rows = Math.max(1, Math.ceil((maxY - minY) / cellHeight));
  if (scratch.grid.length < columns * rows) scratch.grid = new Uint8Array(columns * rows);
  const grid = scratch.grid;
  grid.fill(0, 0, columns * rows);
  let occupied = 0;
  for (let k = 0; k < shown; k++) {
    const column = Math.min(columns - 1, Math.floor((scratch.x[k] - minX) / cellWidth));
    const row = Math.min(rows - 1, Math.floor((scratch.y[k] - minY) / cellHeight));
    const at = row * columns + column;
    if (grid[at] === 0) {
      grid[at] = 1;
      occupied++;
    }
  }
  const area = occupied * cellWidth * cellHeight;
  const wanted = Math.sqrt((READ_CELLS_COVERAGE * area) / readOnScreen) / diameter;
  const densest = Math.sqrt(Math.max(1, cellsOnScreen / readOnScreen));
  return Math.min(densest, Math.max(1, wanted));
}
