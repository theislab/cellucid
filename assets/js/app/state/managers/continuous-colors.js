/**
 * @fileoverview Per-cell kernels of continuous coloring.
 *
 * A continuous field is coloured by one pass that writes each cell's whole
 * RGBA word: the colormap bytes come from the colormap's exact byte table
 * (`getColormapByteTable`), and an alpha byte that layers it, never its
 * visibility (the view's transparency alone): opaque, the no-value grey's
 * `BENEATH_ALPHA_BYTE`, drawn beneath the coloured cells, or, for a gene
 * sample's cells not read, `UNREAD_ALPHA_BYTE`, drawn faded beneath every
 * cell read (`rendering/read-cell-layer.js`). The per-cell
 * sampler call and three `Math.round`s are gone.
 *
 * A column is either dense (`Float32Array`/`Float64Array`, one value a cell)
 * or sparse (`{length, indices: Uint32Array, values: Float32Array|Float64Array,
 * readRows?}` with every cell not in `indices` below `readRows` holding 0 and
 * every cell from `readRows` on NaN: a gene sample's cells not read; default
 * `length`). Both kernels accept either and produce the same result for the
 * same cell values; a sparse column costs one word fill over the cells plus
 * its stored entries. A dense column whose sparse form was noted beside it
 * (`data/column-forms.js`: a gene's, made by the reader worker) is read
 * through that form, so a gene costs the fill and its entries, not a pass
 * over every cell's value.
 *
 * @module state/managers/continuous-colors
 */

import {
  COLORMAP_TABLE_BUCKETS,
  getColormapByteTable,
} from '../../../data/palettes.js';
import { NEUTRAL_GRAY_UINT8 } from '../core/constants.js';
import { BENEATH_ALPHA_BYTE, UNREAD_ALPHA_BYTE } from '../../../rendering/alpha-visibility.js';
import { columnFormOf } from '../../../data/column-forms.js';
import {
  createNonFiniteTally,
  recordNonFiniteValue,
} from '../../../data/continuous-payload-diagnosis.js';

const word = (r, g, b, a) => new Uint32Array(Uint8Array.of(r, g, b, a).buffer)[0];

/** The table's "sample this `t` exactly" byte, as a word mask. */
const EXACT_SAMPLE_MASK = word(0, 0, 0, 1);
/**
 * The no-value grey (NaN, a non-positive value on a log scale, a value at or
 * below the neutral floor), with the alpha byte that draws it beneath every
 * coloured cell (`BENEATH_ALPHA_BYTE`): its whole word, so no OPAQUE is or'ed
 * in.
 */
const MISSING_WORD = word(NEUTRAL_GRAY_UINT8, NEUTRAL_GRAY_UINT8, NEUTRAL_GRAY_UINT8, BENEATH_ALPHA_BYTE);
/**
 * A cell a gene sample did not read: the bottom layer (`UNREAD_ALPHA_BYTE`),
 * drawn in a colour faded from the view's background
 * (`rendering/read-cell-layer.js`); its RGB bytes are the neutral grey for a
 * reader that draws no layers.
 */
const UNREAD_WORD = word(NEUTRAL_GRAY_UINT8, NEUTRAL_GRAY_UINT8, NEUTRAL_GRAY_UINT8, UNREAD_ALPHA_BYTE);
/** The alpha byte of every color: opaque. */
const OPAQUE = word(0, 0, 0, 255);

const sampleBytes = new Uint8Array(4);
const sampleWord = new Uint32Array(sampleBytes.buffer);
const sample = [0, 0, 0];

function isDenseColumn(column) {
  return column instanceof Float32Array || column instanceof Float64Array;
}

/** Sparse columns whose indices are proven strictly increasing and in range. */
const PROVEN_SPARSE_COLUMNS = new WeakSet();

/** The cells of a sparse column that were read: its `readRows`, else every one. */
function readRowsOf(column) {
  return column.readRows === undefined ? column.length : column.readRows;
}

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
    || (column.readRows !== undefined && (!Number.isSafeInteger(column.readRows) || column.readRows < 0 || column.readRows > column.length))
  ) {
    throw new TypeError(
      'A continuous column must be a Float32Array, a Float64Array, or {length, indices: Uint32Array, values, readRows?}.'
    );
  }
  const { indices } = column;
  const read = readRowsOf(column);
  let previous = -1;
  for (let k = 0; k < indices.length; k++) {
    const cell = indices[k];
    if (cell <= previous || cell >= read) {
      throw new RangeError(
        `Sparse column index ${k} must increase strictly and stay below ${read}.`
      );
    }
    previous = cell;
  }
  PROVEN_SPARSE_COLUMNS.add(column);
  return column;
}

/** A column as the kernels read it: a dense column's noted sparse form, else itself. */
function readableColumn(column) {
  return isDenseColumn(column) ? columnFormOf(column) ?? column : column;
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
  const source = readableColumn(column);
  const sparse = !isDenseColumn(source);
  const values = sparse ? source.values : source;
  const indices = sparse ? source.indices : null;
  let min = Infinity;
  let max = -Infinity;
  let minPositive = Infinity;
  let maxPositive = -Infinity;
  const tally = createNonFiniteTally(length);
  if (sparse) {
    const read = readRowsOf(source);
    // Indices strictly increase, so a stored value never stands for an
    // implicit zero; a column with fewer stored values than cells read holds one.
    if (values.length < read) {
      min = 0;
      max = 0;
    }
    // The cells not read are NaN: counted, as each one would be.
    tally.nan += length - read;
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
 * value at or below `neutralAtOrBelow` (a gene's cells that do not express
 * it: their zeros, when the data has no negative value) is neutral gray too,
 * so the expressing cells are what the colormap shows; a constant domain
 * samples `t = 0.5`; otherwise `t = (v - min) / (max - min)`, or
 * `(log10(v) - log10(min)) / (log10(max) - log10(min))` on a log scale, and
 * each channel is `Math.round(colormap(t) * 255)`. The alpha byte is 255,
 * and `BENEATH_ALPHA_BYTE` for the neutral gray: it is drawn beneath the
 * coloured cells. A sparse column's cells from `readRows` on (not read) are
 * the neutral gray with `UNREAD_ALPHA_BYTE`: drawn faded, beneath every cell
 * read; so are a column's cells from `domain.readRows` on (a gene sample's
 * cells not read, `getGeneSample`), whatever the column holds there -- a
 * dense column cannot tell a cell not read from a missing value itself.
 *
 * @param {Uint8Array} colors Word-aligned RGBA8, four bytes a cell.
 * @param {Float32Array|Float64Array|{length: number, indices: Uint32Array, values: Float32Array|Float64Array}} column
 * @param {{min: number, max: number, scale: 'linear'|'log', neutralAtOrBelow?: number|null, readRows?: number|null}} domain
 * @param {{colors: number[][], sampleInto: Function}} colormap
 */
export function writeContinuousColors(colors, column, domain, colormap) {
  const n = continuousColumnLength(column);
  if (
    !(colors instanceof Uint8Array)
    || colors.length !== n * 4
    || colors.byteOffset % 4 !== 0
  ) {
    throw new TypeError(
      'Continuous coloring requires word-aligned colors for every cell.'
    );
  }
  const useLog = domain.scale === 'log';
  const domainMin = domain.min;
  const logMin = useLog ? Math.log10(domainMin) : 0;
  const denom = useLog ? (Math.log10(domain.max) - logMin) : (domain.max - domainMin);
  const constant = denom === 0;
  const table = new Uint32Array(getColormapByteTable(colormap).buffer);
  const buckets = COLORMAP_TABLE_BUCKETS;

  // NaN never compares: no neutral floor.
  const neutralAtOrBelow = domain.neutralAtOrBelow ?? NaN;
  const rgbOf = (value) => {
    if (value !== value || (useLog && value <= 0) || value <= neutralAtOrBelow) return MISSING_WORD;
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
    sampleBytes[3] = 255;
    return sampleWord[0];
  };

  const words = new Uint32Array(colors.buffer, colors.byteOffset, n);
  const source = readableColumn(column);
  // The cells read: the domain's sample, and a sparse column's own read cells.
  const sampled = domain.readRows ?? n;
  if (!Number.isSafeInteger(sampled) || sampled < 0 || sampled > n) {
    throw new RangeError(`A continuous colouring's cells read must be a whole number from 0 to ${n}.`);
  }
  // `rgbOf` answers whole words: a colormap entry made opaque here, the
  // no-value grey with its own alpha byte.
  const wordOf = rgb => (rgb === MISSING_WORD ? rgb : rgb | OPAQUE);
  const writeCell = (cell, rgb) => {
    words[cell] = wordOf(rgb);
  };

  if (isDenseColumn(source)) {
    // Neighbouring cells often share a value (a gene's zeros, a rounded
    // covariate); the previous cell's word is reused without any arithmetic.
    let previous = NaN;
    let previousWord = MISSING_WORD;
    words.fill(UNREAD_WORD, sampled);
    for (let cell = 0; cell < sampled; cell++) {
      const value = column[cell];
      if (value !== previous) {
        previousWord = wordOf(rgbOf(value));
        previous = value;
      }
      words[cell] = previousWord;
    }
    return;
  }

  // A sparse column, or a dense one's noted form: the cells read hold 0 but
  // for their entries, the others are not read (the bottom layer).
  const read = Math.min(readRowsOf(source), sampled);
  words.fill(wordOf(rgbOf(0)), 0, read);
  words.fill(UNREAD_WORD, read);
  const { indices, values } = source;
  for (let k = 0; k < values.length && indices[k] < read; k++) writeCell(indices[k], rgbOf(values[k]));
}
