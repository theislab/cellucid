/**
 * The reader's names: the obs names of the open cells (all, a range, or
 * listed cells, each read by its own rows), the gene names of each var axis
 * and a var column's flags. Opening checks the indexes and reads no name;
 * these read them when asked. A modality's gene positions are split by
 * `_splitModality`, which stays with the reader (the matrices use it too).
 *
 * A method group of `AnnDataReader` (`reader.js`), mixed onto its
 * prototype: `this` is the reader. It writes the `obs_names` and
 * `var_names:` entries of `_cache` (an opening of the same store carries the
 * `var_names:` ones, `open`).
 *
 * @module data/anndata/reader/names
 */

import { isGroup } from '../../../formats/store.js';
import { attributeValue, child, shapeFromAttribute, shapeOf, validateDataFrame } from '../elements.js';
import { readBooleanColumn, readDataFrameIndex, readGeneNameColumn } from '../dataframe.js';
import { readStored } from '../values.js';
import { gatheredArray, runsOfPositions } from '../views/cell-subset.js';
import { formatCount, formatCountOf } from '../../../utils/format-units.js';
import { requirePositions } from '../positions.js';

export class AnnDataReaderNameMethods {
  /**
   * The obs names of some open cells: the whole index when it is held,
   * else each cell's row of it. What names the cells an embedding or a
   * vector field leaves unplaced (`EmbeddingPayloads`).
   * @this {import('../reader.js').AnnDataReader}
   */
  async _cellNames(cells) {
    const held = this._cache.get('obs_names');
    if (held !== undefined) return cells.map(cell => held[cell]);
    return (await Promise.all(cells.map(cell => this.readObsNames({ rows: [cell, cell + 1] })))).map(names => names[0]);
  }

  /**
   * One boolean column of `var` (axis `X`) or `raw.var` (axis `raw`), or of a
   * modality's (`mod/<name>`, `mod/<name>/raw`), as flags, one per gene of
   * that axis, 1 where true: which genes a column such as `highly_variable`
   * marks. Read when asked for, never at open.
   *
   * @this {import('../reader.js').AnnDataReader}
   * @param {string} axis
   * @param {string} column
   * @returns {Promise<Uint8Array>}
   */
  async readVarFlags(axis, column) {
    this._ensureOpen();
    const label = `${this._varAxis(axis).label}['${column}']`;
    return this._track('names', `flags of ${label}`, async readOptions => {
      const generation = this._generation;
      const { index } = await this.readVarNames(axis, null);
      const frame = this._varAxis(axis).frame;
      const { columnOrder } = validateDataFrame(frame, this._format, label);
      if (!columnOrder.includes(column)) throw new Error(`${label} does not exist`);
      await frame.load([column], readOptions);
      const flags = await readBooleanColumn(frame, column, this._format, label, index.length, readOptions);
      this._assertGeneration(generation, `reading ${label}`);
      return flags;
    });
  }

  /**
   * The obs names of the open cells, in their order: the obs index (a CSV or
   * `.h5ad` export names its cells by them). Listed `cells` read their own
   * rows of the index alone, in stored order; `rows` reads that range of the
   * index; with neither, the whole index is read once and kept (a held one
   * answers the others). Opening reads only its length.
   *
   * @this {import('../reader.js').AnnDataReader}
   * @returns {Promise<string[]>}
   */
  async readObsNames({ rows = null, cells = null } = {}) {
    this._ensureOpen();
    if (rows !== null && cells !== null) throw new TypeError('Obs names are read for listed cells or a range of rows, not both');
    const range = this._rowRange(rows, 'obs names');
    const cacheKey = 'obs_names';
    if (cells !== null) {
      // Listed open cells (an export's, a batch at a time): their rows of
      // the index alone, read in the stored order (`gatheredArray`), so the
      // names of cells listed in another order than the file's (every cell
      // of a file opened in a subsample's order, listed by original
      // position) cost their own rows' chunks, once, never every name.
      const listed = requirePositions(cells, this._nObs, 'obs name');
      const held = this._cache.get(cacheKey);
      if (held !== undefined) return Array.from(listed, cell => held[cell]);
      if (listed.length === 0) return [];
      return this._track('names', `obs names of ${formatCountOf(listed.length, 'cell')}`, async readOptions => {
        const obs = this._root.get('obs');
        const { indexKey } = validateDataFrame(obs, this._format, `${this._format.file} obs`);
        const node = obs.get(indexKey);
        await readDataFrameIndex(node, this._format, 'Observation index', this._nObs, false, readOptions);
        const values = isGroup(node) ? node.get('values') : node;
        const gathered = gatheredArray(values, runsOfPositions(listed), { mergeGapBytes: () => this._mergeGapBytes(), chunks: this._decodedChunks });
        const raw = await readStored(gathered, 0, listed.length, 'Observation index', readOptions);
        return Array.from(raw, String);
      });
    }
    if (this._cache.has(cacheKey)) {
      const names = this._cache.get(cacheKey);
      return range === null ? names : names.slice(range.start, range.end);
    }
    if (range !== null) {
      // Rows `[start, end)` of the open cells (an export of a few cells),
      // read as that range of the index; only a whole read is kept.
      return this._track('names', `obs names, open cells ${formatCount(range.start)}–${formatCount(range.end)}`, async readOptions => {
        const obs = this._root.get('obs');
        const { indexKey } = validateDataFrame(obs, this._format, `${this._format.file} obs`);
        const node = obs.get(indexKey);
        // Checked as a whole read checks it (encoding, length, no missing name).
        await readDataFrameIndex(node, this._format, 'Observation index', this._nObs, false, readOptions);
        const raw = await readStored(isGroup(node) ? node.get('values') : node, range.start, range.end, 'Observation index', readOptions);
        return Array.from(raw, String);
      });
    }
    return this._track('names', 'obs names', async readOptions => {
      const obs = this._root.get('obs');
      const { indexKey } = validateDataFrame(obs, this._format, `${this._format.file} obs`);
      const index = await readDataFrameIndex(obs.get(indexKey), this._format, 'Observation index', this._nObs, true, readOptions);
      const names = Array.from(index.values, String);
      this._cache.set(cacheKey, names);
      return names;
    });
  }

  /**
   * The gene names of one var axis, as stored: the var index, or one var
   * column as text (null where a value is missing), with the index that names
   * the genes a column leaves empty. `axis` is `X` (shared by `X` and every
   * layer) or `raw`, or a modality's (`mod/<name>`, `mod/<name>/raw`).
   * Nothing is made unique here.
   *
   * @this {import('../reader.js').AnnDataReader}
   * @param {string} axis
   * @param {string|null} column
   * @returns {Promise<{index: string[], values: Array<string|null>}>}
   */
  async readVarNames(axis, column) {
    this._ensureOpen();
    const cacheKey = `var_names:${axis}:${column === null ? '' : `column:${column}`}`;
    if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);
    const { label: axisLabel } = this._varAxis(axis);
    const what = column === null ? `gene names of ${axisLabel}` : `gene names from ${axisLabel}['${column}']`;
    return this._track('names', what, readOptions => this._readVarNames(axis, column, cacheKey, readOptions));
  }

  /**
   * One var axis: `X` (the var shared by `X` and the layers), `raw`, or a
   * modality's (`mod/<name>`, `mod/<name>/raw`). Its frame, its label, and
   * the element whose gene count it has.
   * @this {import('../reader.js').AnnDataReader}
   * @private
   */
  _varAxis(axis) {
    const { modality, rest } = this._splitModality(axis);
    const base = modality === null ? '' : `mod/${modality.modality.name}/`;
    const where = modality === null ? '' : ` of modality '${modality.modality.name}'`;
    const group = modality === null ? this._root : this._root.get(`mod/${modality.modality.name}`);
    if ((modality === null && rest === 'X') || (modality !== null && rest === '')) {
      return { frame: group.get('var'), label: `var${where}`, element: `${base}X`, root: modality === null };
    }
    if (rest === 'raw') {
      const raw = child(group, 'raw');
      if (!isGroup(raw) || !raw.has('var') || !raw.has('X')) throw new Error(`This file has no raw var axis${where}`);
      return { frame: raw.get('var'), label: `raw.var${where}`, element: `${base}raw/X`, root: false };
    }
    throw new TypeError(`Unknown var axis '${String(axis)}'`);
  }

  /** @this {import('../reader.js').AnnDataReader} @private */
  async _readVarNames(axis, column, cacheKey, readOptions) {
    const generation = this._generation;
    const format = this._format;
    const { frame, label, element, root } = this._varAxis(axis);
    let index;
    if (root) {
      // Read when first asked for (opening checks only its length). A
      // repeated name is kept as stored: the adapter makes the gene list
      // unique with the data-mapping rule, as cellucid serve does.
      const { indexKey } = validateDataFrame(frame, format, `${format.file} ${label}`);
      index = (await readDataFrameIndex(frame.get(indexKey), format, 'Variable index', this._nVars, true, readOptions)).values;
    } else {
      // Its gene count from the matrix's shape as stored: a subsample's CSR
      // matrix need not have its kept rows' pointers read (`_readyRows`)
      // for its gene names.
      const matrixGroup = this._root.get(element.slice(0, element.lastIndexOf('/')) || '/');
      const matrixNode = matrixGroup?.get?.('X') ?? null;
      const nVars = matrixNode === null
        ? null
        : (isGroup(matrixNode) ? shapeFromAttribute(attributeValue(matrixNode, 'shape'), label)[1] : shapeOf(matrixNode, label, 2)[1]);
      const { indexKey } = validateDataFrame(frame, format, `${format.file} ${label}`);
      index = (await readDataFrameIndex(frame.get(indexKey), format, `${label} index`, nVars, true, readOptions)).values;
    }
    let values;
    if (column === null) {
      values = index;
    } else {
      const { columnOrder } = validateDataFrame(frame, format, `${format.file} ${label}`);
      if (!columnOrder.includes(column)) throw new Error(`${label} has no column '${column}'`);
      await frame.load([column], readOptions);
      values = await readGeneNameColumn(frame, column, format, `${label}['${column}']`, index.length, readOptions);
    }
    this._assertGeneration(generation, `reading the gene names of ${label}`);
    const result = Object.freeze({ index, values });
    this._cache.set(cacheKey, result);
    return result;
  }
}
