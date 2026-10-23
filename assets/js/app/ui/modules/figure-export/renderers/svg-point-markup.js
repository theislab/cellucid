/**
 * @fileoverview The point markup of a Full Vector or Optimized Vector SVG.
 *
 * One `<circle>` per drawn point (and one ring per highlighted point) is the
 * bulk of a vector figure: 562k cells write about 65 MB. It is written in the
 * figure-export worker (`figure-export-worker.js`) and leaves as one Blob, so
 * the page's main thread never projects, shades or formats a point, and never
 * holds the markup as a string.
 *
 * Each circle is encoded straight into one reused buffer of
 * `MARKUP_BUFFER_BYTES`, and every full buffer is copied into a Blob part, so
 * the worker's memory is the Blob store the file needs plus one buffer: the
 * markup never exists as a string, and the only strings are the short-lived
 * circles themselves. The bytes are those of the whole markup encoded at
 * once.
 *
 * @module ui/modules/figure-export/renderers/svg-point-markup
 */

import { forEachProjectedPoint } from '../utils/point-projector.js';
import { reducePointsByDensity } from '../utils/density-reducer.js';
import {
  MIN_VISIBLE_ALPHA_BYTE,
  POINT_VISIBILITY_THRESHOLD,
} from '../utils/lod-membership.js';
import {
  applyFogAlpha,
  applyFogChannel,
  createFogEvaluator,
} from '../utils/fog.js';

const DEFAULT_HIGHLIGHT_RGB = { r: 102, g: 217, b: 255 }; // ~[0.4, 0.85, 1.0]
const DEFAULT_HIGHLIGHT_SCALE = 1.75;

/** Selection muting paints non-selected points this flat grey, as `packBuffers` does. */
const SELECTION_MUTED_RGB = 160;

/** Bytes of markup encoded before they are copied into a Blob part. */
const MARKUP_BUFFER_BYTES = 1024 * 1024;

/**
 * The colour a vector circle must carry to match the shader.
 *
 * Both transformations happen on screen in this order: the export mutes
 * non-selected points before rasterization, and the shader then fogs whatever
 * colour reached it. Reversing them would fog the original colour and mute the
 * result, which is a different image.
 *
 * Returns a reused 4-slot buffer so a 200k-point figure allocates nothing.
 *
 * @param {object} options
 * @returns {(index: number, r: number, g: number, b: number, a: number) => Float64Array}
 */
function createVectorPointShader({
  fog,
  positions,
  dimension,
  highlightArray,
  emphasizeSelection,
  selectionMutedOpacity,
}) {
  const shaded = new Float64Array(4);
  return function shadeVectorPoint(index, r, g, b, a) {
    let rr = r;
    let gg = g;
    let bb = b;
    let aa = a;
    if (
      emphasizeSelection &&
      highlightArray &&
      (highlightArray[index] ?? 0) < MIN_VISIBLE_ALPHA_BYTE
    ) {
      rr = SELECTION_MUTED_RGB;
      gg = SELECTION_MUTED_RGB;
      bb = SELECTION_MUTED_RGB;
      aa *= selectionMutedOpacity;
    }
    if (fog !== null) {
      const base = index * dimension;
      const transmittance = fog.transmittanceAt(
        positions[base],
        dimension > 1 ? positions[base + 1] : 0,
        dimension > 2 ? positions[base + 2] : 0
      );
      if (fog.fadesAlpha) {
        aa = applyFogAlpha(transmittance, aa);
      } else {
        rr = applyFogChannel(fog.fogR, rr, transmittance);
        gg = applyFogChannel(fog.fogG, gg, transmittance);
        bb = applyFogChannel(fog.fogB, bb, transmittance);
      }
    }
    shaded[0] = rr;
    shaded[1] = gg;
    shaded[2] = bb;
    shaded[3] = aa;
    return shaded;
  };
}

function highlightValueToAlpha01(value) {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new RangeError(
      'SVG highlight values must be exact Uint8 intensities.'
    );
  }
  return value < MIN_VISIBLE_ALPHA_BYTE ? 0 : value / 255;
}

/**
 * Gathers markup into Blob parts without ever holding it as one string.
 */
function createMarkupSink() {
  const encoder = new TextEncoder();
  const buffer = new Uint8Array(MARKUP_BUFFER_BYTES);
  const parts = [];
  let used = 0;
  const flush = () => {
    if (used === 0) return;
    // The Blob copies the bytes; the buffer is reused.
    parts.push(new Blob([buffer.subarray(0, used)]));
    used = 0;
  };
  return {
    write(text) {
      // UTF-8 takes at most three bytes per UTF-16 unit.
      if (text.length * 3 > buffer.length - used) flush();
      if (text.length * 3 > buffer.length) {
        parts.push(new Blob([encoder.encode(text)]));
        return;
      }
      used += encoder.encodeInto(text, buffer.subarray(used)).written;
    },
    /** @returns {Blob} */
    finish() {
      flush();
      return new Blob(parts);
    },
  };
}

/**
 * Write one vector point and the highlight ring of source point `index`.
 */
function writeCircle(sink, x, y, radius, shaded, highlightArray, index) {
  const r = shaded[0];
  const g = shaded[1];
  const b = shaded[2];
  const a = shaded[3];
  if (a < POINT_VISIBILITY_THRESHOLD) return;
  if (a >= 0.999) {
    sink.write(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${radius.toFixed(2)}" fill="rgb(${r},${g},${b})"/>`);
  } else {
    sink.write(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${radius.toFixed(2)}" fill="rgb(${r},${g},${b})" fill-opacity="${a.toFixed(3)}"/>`);
  }

  const h = highlightArray ? highlightValueToAlpha01(highlightArray[index] ?? 0) : 0;
  if (h > 0) {
    const ringR = radius * DEFAULT_HIGHLIGHT_SCALE;
    const sw = Math.max(0.75, radius * 0.45);
    const op = Math.max(0.25, 0.85 * h);
    sink.write(
      `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${ringR.toFixed(2)}" ` +
      `fill="none" stroke="rgb(${DEFAULT_HIGHLIGHT_RGB.r},${DEFAULT_HIGHLIGHT_RGB.g},${DEFAULT_HIGHLIGHT_RGB.b})" ` +
      `stroke-width="${sw.toFixed(2)}" stroke-opacity="${op.toFixed(3)}"/>`
    );
  }
}

/**
 * The point markup of one panel, as one Blob.
 *
 * @param {object} options
 * @param {'full-vector'|'optimized-vector'} options.strategy
 * @param {Float32Array} options.positions
 * @param {1|2|3} options.dimension
 * @param {Uint8Array} options.colors
 * @param {Uint8Array|null} options.transparency
 * @param {import('../utils/lod-membership.js').LodMembership|null} options.lodMembership
 * @param {Uint32Array|null} options.drawOrder
 * @param {object} options.renderState - the panel's presented render state
 * @param {object} options.fogRenderState - the render state whose fog the
 *   circles carry: a sculpted point fogs toward the figure's paper
 * @param {Uint8Array|null} options.highlightArray
 * @param {boolean} options.emphasizeSelection
 * @param {number} options.selectionMutedOpacity
 * @param {{x: number, y: number, width: number, height: number}} options.plotRect
 * @param {object|null} options.crop
 * @param {number} options.pointRadiusViewportPx
 * @param {number} [options.radiusPx] - Full Vector: the circle radius in plot units
 * @param {boolean} [options.sortByDepth] - Full Vector: draw back to front
 * @param {number} [options.targetCount] - Optimized Vector: the exact point count
 * @param {number} [options.seed] - Optimized Vector: the reduction's seed
 * @returns {Blob}
 */
export function writeSvgPointMarkup({
  strategy,
  positions,
  dimension,
  colors,
  transparency,
  lodMembership,
  drawOrder,
  renderState,
  fogRenderState,
  highlightArray,
  emphasizeSelection,
  selectionMutedOpacity,
  plotRect,
  crop,
  pointRadiusViewportPx,
  radiusPx,
  sortByDepth,
  targetCount,
  seed,
}) {
  // Vector circles carry no shader, so the depth cue the viewer paints with
  // fog has to be reproduced here or the figure loses its depth axis.
  const shadeVectorPoint = createVectorPointShader({
    fog: createFogEvaluator(fogRenderState),
    positions,
    dimension,
    highlightArray,
    emphasizeSelection,
    selectionMutedOpacity,
  });
  const sink = createMarkupSink();

  if (strategy === 'optimized-vector') {
    const reduced = reducePointsByDensity({
      positions,
      dimension,
      colors,
      transparency,
      lodMembership,
      highlightArray,
      renderState,
      targetCount,
      seed,
      crop
    });
    const scale = Math.min(
      plotRect.width / reduced.viewportWidth,
      plotRect.height / reduced.viewportHeight
    );
    const offsetX = plotRect.x + (plotRect.width - reduced.viewportWidth * scale) / 2;
    const offsetY = plotRect.y + (plotRect.height - reduced.viewportHeight * scale) / 2;
    const pointRadiusPx = pointRadiusViewportPx * scale;

    for (let i = 0; i < reduced.x.length; i++) {
      const srcIndex = reduced.index?.[i] ?? i;
      const x = offsetX + reduced.x[i] * scale;
      const y = offsetY + reduced.y[i] * scale;
      const j = i * 4;
      const shaded = shadeVectorPoint(
        srcIndex,
        reduced.rgba[j],
        reduced.rgba[j + 1],
        reduced.rgba[j + 2],
        reduced.alpha[i] ?? 1.0
      );
      writeCircle(sink, x, y, pointRadiusPx, shaded, highlightArray, srcIndex);
    }
    return sink.finish();
  }

  if (strategy !== 'full-vector') {
    throw new TypeError(
      'SVG point markup requires strategy "full-vector" or "optimized-vector".'
    );
  }
  forEachProjectedPoint({
    positions,
    dimension,
    colors,
    transparency,
    lodMembership,
    drawOrder,
    renderState,
    plotRect,
    radiusPx,
    crop,
    sortByDepth,
    onPoint: (x, y, r, g, b, a, radius, index) => {
      const shaded = shadeVectorPoint(index, r, g, b, a);
      writeCircle(sink, x, y, radius, shaded, highlightArray, index);
    }
  });
  return sink.finish();
}
