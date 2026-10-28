/**
 * @fileoverview Latent-space outlier quantiles computed in the reader worker
 * from `obsm` read in row slabs (`data/latent-outliers.js` holds the rule),
 * for a file that stores none for the latent space in use.
 *
 * Every field asked for at once is computed in the same passes over the
 * latent space, so the file is read once for all of them, not once per
 * field. The latent space is checked as it is read (every value finite and
 * representable as float32, the check every mapped array gets) and narrowed
 * to float32, the values the writers compute from. When it fits the reader's
 * residency budget (`latentHold`) it is kept, one latent space at a time, so
 * every later field is computed without reading the file again; a larger one
 * is read again for the second pass and never held whole, so no latent space
 * is too large. Nothing is read before quantiles are asked for.
 *
 * The read runs under one activity of kind `outliers` (`formats/io/activity.js`),
 * so the read log, the progress notification and the outlier control all say
 * how much of the latent space is read, how fast and how long is left.
 *
 * @module data/latent-outliers-stream
 */

import { LatentOutlierQuantiles } from './latent-outliers.js';
import { MappingLoadError, valueLoadDefect } from './data-mapping-candidates.js';
import { residencyBudgetBytes } from './memory-budget.js';
import { allocateTypedArray } from './sparse-column-index.js';

/** Narrow one slab of file values (numbers or BigInts) into `rows`. */
function narrowInto(rows, block) {
  if (typeof block[0] === 'bigint') {
    for (let index = 0; index < rows.length; index++) rows[index] = Number(block[index]);
  } else {
    rows.set(block);
  }
}

/** What the activity of reading `obsm[key]` for outlier quantiles is called. */
export function latentReadLabel(key) {
  return `latent space obsm['${key}'] for outlier quantiles`;
}

/**
 * One reader's latent-space computation, with the one latent space it keeps.
 */
export class LatentOutlierReader {
  /**
   * @param {{nObs: number, forEachObsmRowSlab: Function}} loader
   * @param {{budgetBytes?: number}} [options]
   */
  constructor(loader, { budgetBytes = residencyBudgetBytes('latentHold') } = {}) {
    this._loader = loader;
    this._budgetBytes = budgetBytes;
    /** @type {{key: string, width: number, latent: Float32Array}|null} */
    this._held = null;
  }

  /** The key of the latent space kept in memory, or null. */
  get heldKey() {
    return this._held?.key ?? null;
  }

  /** Whether `obsm[key]` is kept, so quantiles in it read nothing. */
  holds(key, width) {
    return this._held?.key === key && this._held.width === width;
  }

  /** Whether `obsm[key]` would be kept once read. */
  wouldHold(width) {
    return this._loader.nObs * width * 4 <= this._budgetBytes;
  }

  /** Release the kept latent space. */
  clear() {
    this._held = null;
  }

  /**
   * The outlier quantiles of several categorical fields in `obsm[key]`, all
   * from the same passes over the latent space.
   *
   * @param {string} key
   * @param {number} width - The array's column count
   * @param {ReadonlyArray<{codes: ArrayLike<number>, nCategories: number}>} fields
   * @param {number} minPoints
   * @param {{signal?: AbortSignal|null}} [options] - `signal` cancels the passes over the file.
   * @returns {Promise<Float32Array[]>} One array per field, in order.
   */
  async quantiles(key, width, fields, minPoints, { signal = null } = {}) {
    const nCells = this._loader.nObs;
    const tasks = fields.map(({ codes, nCategories }) => (
      new LatentOutlierQuantiles({ nCells, width, codes, nCategories, minPoints })
    ));
    const reading = tasks.filter(task => task.needsLatent);
    if (reading.length === 0) return tasks.map(task => task.finish());

    if (this.holds(key, width)) {
      const { latent } = this._held;
      for (const task of reading) {
        task.addCentroidRows(latent, 0);
        task.finishCentroids();
        task.addDistanceRows(latent, 0);
      }
      return tasks.map(task => task.finish());
    }

    const label = `Latent space '${key}'`;
    const keep = this.wouldHold(width);
    // One latent space is kept at a time: the one being read replaces it.
    this._held = null;
    const kept = keep ? allocateTypedArray(Float32Array, nCells * width, label) : null;
    let scratch = null;
    const rowsFor = (rowStart, rowEnd) => {
      if (kept !== null) return kept.subarray(rowStart * width, rowEnd * width);
      const length = (rowEnd - rowStart) * width;
      if (scratch === null || scratch.length < length) scratch = allocateTypedArray(Float32Array, length, label);
      return scratch.subarray(0, length);
    };
    const read = (visit, pass) => this._loader.forEachObsmRowSlab(key, visit, {
      signal,
      kind: 'outliers',
      label: keep ? latentReadLabel(key) : `${latentReadLabel(key)}, pass ${pass} of 2`,
    });

    // Pass 1, checking every value once.
    await read((block, rowStart, rowEnd) => {
      const defect = valueLoadDefect(block, width, rowStart);
      if (defect !== null) {
        throw new MappingLoadError(key, defect, `${label} cannot be used: ${defect}.`);
      }
      const rows = rowsFor(rowStart, rowEnd);
      narrowInto(rows, block);
      for (const task of reading) task.addCentroidRows(rows, rowStart);
    }, 1);
    for (const task of reading) task.finishCentroids();

    if (kept !== null) {
      this._held = { key, width, latent: kept };
      for (const task of reading) task.addDistanceRows(kept, 0);
    } else {
      // Pass 2 reads the file again rather than holding the latent space.
      await read((block, rowStart, rowEnd) => {
        const rows = rowsFor(rowStart, rowEnd);
        narrowInto(rows, block);
        for (const task of reading) task.addDistanceRows(rows, rowStart);
      }, 2);
    }
    return tasks.map(task => task.finish());
  }
}
