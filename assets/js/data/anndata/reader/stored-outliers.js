/**
 * The reader's stored outlier quantiles: the array a file keeps for one obs
 * field in `uns['cellucid']['outlierQuantiles']['fields']`, checked and read
 * when the field's outlier filter is used, and its stored bytes. Opening
 * only describes them (`uns.js` `readUnsCellucid`).
 *
 * A method group of `AnnDataReader` (`reader.js`), mixed onto its
 * prototype: `this` is the reader. It writes no field.
 *
 * @module data/anndata/reader/stored-outliers
 */

import { AnnDataFormatError, child, valueKind } from '../elements.js';

export class AnnDataReaderStoredOutlierMethods {
  /**
   * `uns['cellucid']['outlierQuantiles']['fields'][key]`, checked: float32, one value per cell.
   * @this {import('../reader.js').AnnDataReader}
   * @private
   */
  _storedOutlierArray(fieldKey) {
    const label = `uns['cellucid']['outlierQuantiles']['fields']['${fieldKey}']`;
    const fields = child(child(child(child(this._root, 'uns'), 'cellucid'), 'outlierQuantiles'), 'fields');
    const array = fields === null ? null : child(fields, fieldKey);
    if (array?.kind !== 'array') throw new Error(`${label} does not exist in this file`);
    if (valueKind(array) !== 'float' || array.dtype?.bytes !== 4 || array.shape.length !== 1 || array.shape[0] !== this._nObs) {
      throw new AnnDataFormatError(`${label} must be ${this._nObs} float32 values, one per cell`);
    }
    return { array, label };
  }

  /**
   * The outlier quantiles a file stores for one obs field (written by
   * `prepare()` / `cellucid_prepare()` with the latent space), as stored:
   * NaN where a cell has none.
   *
   * @this {import('../reader.js').AnnDataReader}
   * @param {string} fieldKey
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<Float32Array>}
   */
  async readStoredOutlierQuantiles(fieldKey, { signal = null } = {}) {
    this._ensureOpen();
    const generation = this._generation;
    const { array, label } = this._storedOutlierArray(fieldKey);
    return this._track('outliers', `stored outlier quantiles of obs['${fieldKey}']`, async readOptions => {
      const values = await array.read(undefined, readOptions);
      this._assertGeneration(generation, `reading ${label}`);
      if (!(values instanceof Float32Array) || values.length !== this._nObs) {
        throw new Error(`${label} did not read as ${this._nObs} float32 values`);
      }
      return values;
    }, signal);
  }

  /**
   * The stored bytes of one field's stored outlier quantiles, or null when the store cannot say.
   * @this {import('../reader.js').AnnDataReader}
   */
  async storedOutlierQuantilesBytes(fieldKey, { signal = null } = {}) {
    this._ensureOpen();
    const { array } = this._storedOutlierArray(fieldKey);
    if (typeof array.storedBytes !== 'function') return null;
    const bytes = await array.storedBytes([[0, this._nObs]], { signal });
    return Number.isFinite(bytes) ? bytes : null;
  }
}
