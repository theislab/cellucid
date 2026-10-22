/**
 * @fileoverview Latent-space outlier quantiles of a direct AnnData file,
 * computed in the reader worker from `obsm` read in row slabs
 * (`data/latent-outliers.js` holds the rule).
 *
 * The latent space is checked as it is read (every value finite and
 * representable as float32, the check every mapped array gets) and narrowed
 * to float32, the values `cellucid serve` computes from. When it fits the
 * reader's residency budget it is kept, one latent space at a time, so the
 * next field's quantiles read no file; a larger one is read again for each
 * pass and never held whole, so no latent space is too large.
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

/**
 * One reader's latent-space computation, with the one latent space it keeps.
 */
export class LatentOutlierReader {
  /**
   * @param {{nObs: number, forEachObsmRowSlab: Function}} loader
   * @param {{budgetBytes?: number}} [options]
   */
  constructor(loader, { budgetBytes = residencyBudgetBytes('adapterCache') } = {}) {
    this._loader = loader;
    this._budgetBytes = budgetBytes;
    this._held = null;
  }

  /** The key of the latent space kept in memory, or null. */
  get heldKey() {
    return this._held?.key ?? null;
  }

  /** Release the kept latent space. */
  clear() {
    this._held = null;
  }

  /**
   * The outlier quantiles of one categorical field in `obsm[key]`.
   *
   * @param {string} key
   * @param {number} width - The array's column count
   * @param {{codes: ArrayLike<number>, nCategories: number, minPoints: number}} field
   * @returns {Promise<Float32Array>}
   */
  async quantiles(key, width, { codes, nCategories, minPoints }) {
    const nCells = this._loader.nObs;
    const outliers = new LatentOutlierQuantiles({ nCells, width, codes, nCategories, minPoints });
    if (!outliers.needsLatent) return outliers.finish();

    if (this._held?.key === key && this._held.width === width) {
      const { latent } = this._held;
      outliers.addCentroidRows(latent, 0);
      outliers.finishCentroids();
      outliers.addDistanceRows(latent, 0);
      return outliers.finish();
    }

    const label = `Latent space '${key}'`;
    const keep = nCells * width * 4 <= this._budgetBytes;
    this._held = null;
    const kept = keep ? allocateTypedArray(Float32Array, nCells * width, label) : null;
    let scratch = null;
    const rowsFor = (rowStart, rowEnd) => {
      if (kept !== null) return kept.subarray(rowStart * width, rowEnd * width);
      const length = (rowEnd - rowStart) * width;
      if (scratch === null || scratch.length < length) scratch = new Float32Array(length);
      return scratch.subarray(0, length);
    };

    // Pass 1, checking every value once.
    await this._loader.forEachObsmRowSlab(key, (block, rowStart, rowEnd) => {
      const defect = valueLoadDefect(block, width, rowStart);
      if (defect !== null) {
        throw new MappingLoadError(key, defect, `${label} cannot be used: ${defect}.`);
      }
      const rows = rowsFor(rowStart, rowEnd);
      narrowInto(rows, block);
      outliers.addCentroidRows(rows, rowStart);
    });
    outliers.finishCentroids();

    if (kept !== null) {
      this._held = { key, width, latent: kept };
      outliers.addDistanceRows(kept, 0);
    } else {
      // Pass 2 reads the file again rather than holding the latent space.
      await this._loader.forEachObsmRowSlab(key, (block, rowStart, rowEnd) => {
        const rows = rowsFor(rowStart, rowEnd);
        narrowInto(rows, block);
        outliers.addDistanceRows(rows, rowStart);
      });
    }
    return outliers.finish();
  }
}
