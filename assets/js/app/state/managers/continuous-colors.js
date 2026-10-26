/**
 * @fileoverview Per-cell kernels of continuous coloring.
 *
 * A continuous field is coloured by one pass that writes each cell's whole
 * RGBA word: the colormap bytes come from the colormap's exact byte table
 * (`getColormapByteTable`), and the alpha byte from the cell's transparency.
 * The per-cell sampler call and three `Math.round`s are gone, and the alpha
 * byte no longer needs a pass of its own.
 *
 * A column is either dense (`Float32Array`/`Float64Array`, one value a cell)
 * or sparse (`{length, indices: Uint32Array, values: Float32Array|Float64Array}`
 * with every cell not in `indices` holding 0). Both kernels accept either and
 * produce the same result for the same cell values; a sparse column costs one
 * word fill over the cells plus its stored entries.
 *
 * @module state/managers/continuous-colors
 */

import {
  COLORMAP_TABLE_BUCKETS,
  getColormapByteTable,
} from '../../../data/palettes.js';
import { NEUTRAL_GRAY_UINT8 } from '../core/constants.js';
import {
  createNonFiniteTally,
  recordNonFiniteValue,
} from '../../../data/continuous-payload-diagnosis.js';

const word = (r, g, b, a) => new Uint32Array(Uint8Array.of(r, g, b, a).buffer)[0];

/** The table's "sample this `t` exactly" byte, as a word mask. */
const EXACT_SAMPLE_MASK = word(0, 0, 0, 1);
/** RGB of a missing value (NaN, or a non-positive value on a log scale). */
const MISSING_RGB = word(NEUTRAL_GRAY_UINT8, NEUTRAL_GRAY_UINT8, NEUTRAL_GRAY_UINT8, 0);
/** Alpha byte of a hidden (0) and a shown (1) cell. */
const ALPHA_WORDS = Uint32Array.of(word(0, 0, 0, 0), word(0, 0, 0, 255));

const sampleBytes = new Uint8Array(4);
const sampleWord = new Uint32Array(sampleBytes.buffer);
const sample = [0, 0, 0];

function isDenseColumn(column) {
  return column instanceof Float32Array || column instanceof Float64Array;
}

/** Sparse columns whose indices are proven strictly increasing and in range. */
const PROVEN_SPARSE_COLUMNS = new WeakSet();

function requireSparseColumn(column) {
  if (PROVEN_SPARSE_COLUMNS.has(column)) return column;
  if (
    column === null
    || typeof column !== 'object'
    || ArrayBuffer.isView(column)
    || !Number.isSafeInteger(column.length)
    || column.length < 0
    || !(column.indices instanceof Uint32Array)
    || !(column.values instanceof Float32Array || column.values instanceof Float64Array)
    || column.indices.length !== column.values.length
  ) {
    throw new TypeError(
      'A continuous column must be a Float32Array, a Float64Array, or {length, indices: Uint32Array, values}.'
    );
  }
  const { indices, length } = column;
  let previous = -1;
  for (let k = 0; k < indices.length; k++) {
    const cell = indices[k];
    if (cell <= previous || cell >= length) {
      throw new RangeError(
        `Sparse column index ${k} must increase strictly and stay below ${length}.`
      );
    }
    previous = cell;
  }
  PROVEN_SPARSE_COLUMNS.add(column);
  return column;
}

/**
 * Number of cells a dense or sparse column covers.
 *
 * @param {unknown} column
 * @returns {number}
 */
function continuousColumnLength(column) {
  if (isDenseColumn(column)) return column.length;
  return requireSparseColumn(column).length;
}

/**
 * Range and non-finite tally of a column's cell values, in one pass over its
 * stored values (a sparse column's implicit zeros count as one value 0).
 *
 * @param {Float32Array|Float64Array|{length: number, indices: Uint32Array, values: Float32Array|Float64Array}} column
 * @returns {{tally: object, min: number, max: number, minPositive: number, maxPositive: number}}
 */
export function scanContinuousColumn(column) {
  const length = continuousColumnLength(column);
  const sparse = !isDenseColumn(column);
  const values = sparse ? column.values : column;
  const indices = sparse ? column.indices : null;
  let min = Infinity;
  let max = -Infinity;
  let minPositive = Infinity;
  let maxPositive = -Infinity;
  const tally = createNonFiniteTally(length);
  if (sparse && values.length < length) {
    // Indices strictly increase, so a stored value never stands for an
    // implicit zero; a column with fewer stored values than cells holds one.
    min = 0;
    max = 0;
  }
  for (let k = 0; k < values.length; k++) {
    const value = values[k];
    if (!Number.isFinite(value)) {
      recordNonFiniteValue(tally, value, sparse ? indices[k] : k);
      continue;
    }
    if (value < min) min = value;
    if (value > max) max = value;
    if (value > 0) {
      if (value < minPositive) minPositive = value;
      if (value > maxPositive) maxPositive = value;
    }
  }
  return { tally, min, max, minPositive, maxPositive };
}

/**
 * Write every cell's RGBA word for a continuous column.
 *
 * Exactly the bytes of the per-cell rule: a missing value is neutral gray; a
 * constant domain samples `t = 0.5`; otherwise `t = (v - min) / (max - min)`,
 * or `(log10(v) - log10(min)) / (log10(max) - log10(min))` on a log scale, and
 * each channel is `Math.round(colormap(t) * 255)`. The alpha byte is 255 for a
 * shown cell and 0 for a hidden one.
 *
 * @param {Uint8Array} colors Word-aligned RGBA8, four bytes a cell.
 * @param {Float32Array|Float64Array|{length: number, indices: Uint32Array, values: Float32Array|Float64Array}} column
 * @param {Uint8Array} transparency Exactly 0 or 1 a cell.
 * @param {{min: number, max: number, scale: 'linear'|'log'}} domain
 * @param {{colors: number[][], sampleInto: Function}} colormap
 */
export function writeContinuousColors(colors, column, transparency, domain, colormap) {
  const n = continuousColumnLength(column);
  if (
    !(colors instanceof Uint8Array)
    || colors.length !== n * 4
    || colors.byteOffset % 4 !== 0
    || !(transparency instanceof Uint8Array)
    || transparency.length !== n
  ) {
    throw new TypeError(
      'Continuous coloring requires word-aligned colors and transparency for every cell.'
    );
  }
  const useLog = domain.scale === 'log';
  const domainMin = domain.min;
  const logMin = useLog ? Math.log10(domainMin) : 0;
  const denom = useLog ? (Math.log10(domain.max) - logMin) : (domain.max - domainMin);
  const constant = denom === 0;
  const table = new Uint32Array(getColormapByteTable(colormap).buffer);
  const buckets = COLORMAP_TABLE_BUCKETS;

  const rgbOf = (value) => {
    if (value !== value || (useLog && value <= 0)) return MISSING_RGB;
    let t;
    if (constant) t = 0.5;
    else if (useLog) t = (Math.log10(value) - logMin) / denom;
    else t = (value - domainMin) / denom;
    const x = t * buckets;
    const rgb = table[x <= 0 ? 0 : x >= buckets ? buckets : x | 0];
    if ((rgb & EXACT_SAMPLE_MASK) === 0) return rgb;
    colormap.sampleInto(t, sample);
    sampleBytes[0] = Math.round(sample[0] * 255);
    sampleBytes[1] = Math.round(sample[1] * 255);
    sampleBytes[2] = Math.round(sample[2] * 255);
    sampleBytes[3] = 0;
    return sampleWord[0];
  };

  const words = new Uint32Array(colors.buffer, colors.byteOffset, n);
  const writeCell = (cell, rgb) => {
    const alpha = transparency[cell];
    if (alpha > 1) {
      throw new RangeError(`Transparency value ${cell} must be exactly 0 or 1.`);
    }
    words[cell] = rgb | ALPHA_WORDS[alpha];
  };

  if (isDenseColumn(column)) {
    // Neighbouring cells often share a value (a gene's zeros, a rounded
    // covariate); the previous cell's word is reused without any arithmetic.
    let previous = NaN;
    let previousRgb = MISSING_RGB;
    for (let cell = 0; cell < n; cell++) {
      const value = column[cell];
      if (value !== previous) {
        previousRgb = rgbOf(value);
        previous = value;
      }
      const alpha = transparency[cell];
      if (alpha > 1) {
        throw new RangeError(`Transparency value ${cell} must be exactly 0 or 1.`);
      }
      words[cell] = previousRgb | ALPHA_WORDS[alpha];
    }
    return;
  }

  const zeroRgb = rgbOf(0);
  for (let cell = 0; cell < n; cell++) writeCell(cell, zeroRgb);
  const { indices, values } = column;
  for (let k = 0; k < values.length; k++) writeCell(indices[k], rgbOf(values[k]));
}
