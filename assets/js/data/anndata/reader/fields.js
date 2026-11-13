/**
 * The reader's obs fields: a field's kind and information, its values or
 * codes (of the open cells or a range), the categories found among the
 * open cells (`present-categories.js`), 64-bit identifiers kept exact, and
 * how a subsample represents a categorical field against every cell.
 *
 * A method group of `AnnDataReader` (`reader.js`), mixed onto its
 * prototype: `this` is the reader. It writes `_categoryCodings` (which
 * `_takeCarried` carries and `close` resets), `_identifierColumns`, and the
 * `obs:`, `obs_info:`, `obs_type:`, `obs_categories:`, `obs_counts:` and
 * `obs_representation:` entries of `_cache`. A range of rows is checked by
 * `_rowRange`, which stays with the reader (the names use it too).
 *
 * @module data/anndata/reader/fields
 */

import { codeBooleanColumn, codeDiscoveredColumn } from '../../discovered-categories.js';
import { decodeAnnDataBooleanFlags } from '../../anndata-value-kinds.js';
import { allocateTypedArray } from '../../sparse-column-index.js';
import { isGroup } from '../../../formats/store.js';
import {
  AnnDataFormatError,
  NULLABLE_ENCODINGS,
  child,
  encodingType,
  requireCategoricalOrdered,
  requirePrimitiveKind,
  validateOneDimensional,
  valueKind,
} from '../elements.js';
import {
  categoryCount,
  nullableContract,
  readCategories,
  readCategoriesAt,
  readCodes,
  readBooleanMask,
  readNullableValues,
  resolveCategoricalColumn,
  validateColumnEncoding,
  validateCodes,
} from '../dataframe.js';
import {
  UNSAFE_INTEGERS_AS_TEXT,
  holdsUnsafeIntegers,
  readContinuous,
  readExactIntegers,
  readRowSlabs,
  readStored,
  stores64BitIntegers,
} from '../values.js';
import { gatheredArray, runsOfPositions } from '../views/cell-subset.js';
import { readObsFieldColors } from '../uns.js';
import {
  touchesEveryChunk,
  chunkCount,
  pickedArray,
  leastCategoryBytes,
  codesMissingFrom,
  mergedCoding,
  positionsAmong,
} from '../present-categories.js';

/**
 * Obs columns whose categories are found among the open cells, coded as
 * they are read (`codeDiscoveredColumn`): text, true/false, and integer
 * labels a layout view marks (`labels`).
 */
const DISCOVERED_DTYPES = new Set(['string', 'bool', 'labels']);

export class AnnDataReaderFieldMethods {
  /**
   * How the subsample represents a categorical obs field: each category's
   * share of the kept cells against its share of every cell, read from the
   * field's codes (a few bytes per cell), and the largest difference. Null
   * when every cell is open.
   *
   * @this {import('../reader.js').AnnDataReader}
   * @param {string} key
   * @returns {Promise<{field: string, largestDeviation: number, category: string|null,
   *   shares: Array<{category: string, all: number, kept: number}>}|null>}
   */
  async subsampleRepresentation(key) {
    this._ensureOpen();
    const subset = this._cellSubset;
    if (subset === null || subset.kept === null) return null;
    const column = child(child(this._fullRoot, 'obs'), key);
    if (!isGroup(column) || encodingType(column) !== 'categorical') {
      throw new Error(`obs['${key}'] is not a categorical field`);
    }
    const memo = `obs_representation:${key}`;
    if (this._cache.has(memo)) return this._cache.get(memo);
    const result = this._track('field', `the representation of obs['${key}'] in the subsample`, async readOptions => {
      await column.load([''], readOptions);
      // Every cell's counts are the store's, whatever cells are open: read
      // once (`obs_counts`, carried to a later opening of the same store),
      // then only the open cells' codes.
      const countsKey = `obs_counts:${key}`;
      const known = this._cache.get(countsKey) ?? null;
      let names;
      let all;
      let kept;
      const slotIn = count => code => (Number(code) >= 0 && Number(code) < count ? Number(code) : count);
      if (known === null) {
        const codesNode = column.get('codes');
        const [codes, categories] = await Promise.all([
          readStored(codesNode, 0, codesNode.shape[0], `obs['${key}'] codes`, readOptions),
          readCategories(column.get('categories'), key, this._format, readOptions),
        ]);
        names = Array.from(categories, String);
        all = allocateTypedArray(Float64Array, names.length + 1, `obs['${key}'] category sizes`);
        kept = allocateTypedArray(Float64Array, names.length + 1, `obs['${key}'] category sizes`);
        const slot = slotIn(names.length);
        for (let cell = 0; cell < codes.length; cell++) all[slot(codes[cell])]++;
        const rows = subset.fileRows ?? subset.kept;
        for (let i = 0; i < rows.length; i++) kept[slot(codes[rows[i]])]++;
        this._cache.set(countsKey, Object.freeze({ names, all }));
      } else {
        ({ names, all } = known);
        const openCodes = child(child(this._root, 'obs'), key).get('codes');
        const codes = await readStored(openCodes, 0, openCodes.shape[0], `obs['${key}'] codes`, readOptions);
        kept = allocateTypedArray(Float64Array, names.length + 1, `obs['${key}'] category sizes`);
        const slot = slotIn(names.length);
        for (let i = 0; i < codes.length; i++) kept[slot(codes[i])]++;
      }
      const shares = [];
      let largestDeviation = 0;
      let category = null;
      for (let c = 0; c <= names.length; c++) {
        if (all[c] === 0) continue;
        const entry = { category: c < names.length ? names[c] : null, all: all[c] / subset.nObs, kept: kept[c] / subset.kept.length };
        shares.push(entry);
        const deviation = Math.abs(entry.kept - entry.all);
        if (deviation > largestDeviation) {
          largestDeviation = deviation;
          category = entry.category;
        }
      }
      return { field: key, largestDeviation, category, shares };
    });
    this._cache.set(memo, result);
    result.catch(() => {
      if (this._cache.get(memo) === result) this._cache.delete(memo);
    });
    return result;
  }

  /**
   * How a 64-bit integer obs column is read (`readExactIntegers`): `'text'`
   * when it holds an identifier past 2^53 among every cell of the dataset,
   * else `'numbers'`, the same whatever cells are open. With every cell open
   * and the whole column asked, the read itself decides (`'decide'`); with a
   * subsample, or rows of a growing opening, the column as stored is
   * scanned once (`_holdsIdentifiers`). A caller's `integers` other than
   * `'decide'` stands.
   * @this {import('../reader.js').AnnDataReader}
   * @private
   */
  async _integerReading(key, integers, range, readOptions) {
    if (integers !== 'decide') return integers;
    const everyCell = range === null && (this._fullRoot === null || this._fullRoot === this._root) && this._cellSubset?.fileRows == null;
    if (everyCell) return 'decide';
    return (await this._holdsIdentifiers(key, readOptions)) ? 'text' : 'numbers';
  }

  /**
   * Whether the 64-bit integer obs column `key`, as stored (every cell, not
   * only the open ones), holds a value past 2^53 (`holdsUnsafeIntegers`):
   * read once a reader, slab by slab, stopping at the first such value; a
   * nullable column's missing values passed over.
   * @this {import('../reader.js').AnnDataReader}
   * @private
   */
  _holdsIdentifiers(key, readOptions) {
    let decided = this._identifierColumns.get(key);
    if (decided === undefined) {
      decided = (async () => {
        const obs = (this._fullRoot ?? this._root).get('obs');
        await obs.load([key], readOptions);
        const item = obs.get(key);
        let values = item;
        let mask = null;
        if (isGroup(item) && encodingType(item) === 'nullable-integer') {
          const contract = nullableContract(item, key, 'nullable-integer', this._format, null);
          values = contract.valuesArray;
          mask = await readBooleanMask(contract.maskArray, contract.valuesLength, `Nullable mask for '${key}'`, readOptions);
        }
        for await (const slab of readRowSlabs(values, 0, values.shape[0], readOptions)) {
          if (holdsUnsafeIntegers(slab.values, mask === null ? null : mask.subarray(slab.rowStart, slab.rowEnd))) return true;
        }
        return false;
      })();
      this._identifierColumns.set(key, decided);
      decided.catch(() => {
        if (this._identifierColumns.get(key) === decided) this._identifierColumns.delete(key);
      });
    }
    return decided;
  }

  /** The obs frame, checked to hold the column `key`. @this {import('../reader.js').AnnDataReader} @private */
  _obsColumn(key) {
    const obs = this._root.get('obs');
    if (!isGroup(obs) || !obs.has(key)) throw new Error(`Obs field '${key}' not found`);
    return obs;
  }

  /**
   * Categories of one categorical field, read once per generation.
   * @this {import('../reader.js').AnnDataReader}
   * @private
   */
  async _categories(categorical, key, generation, readOptions = {}) {
    const cacheKey = `obs_categories:${key}`;
    if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);
    const categories = await readCategories(categorical.categories, key, this._format, readOptions);
    this._assertGeneration(generation, `reading categorical labels for '${key}'`);
    if (!this._cache.has(cacheKey)) this._cache.set(cacheKey, categories);
    return this._cache.get(cacheKey);
  }

  /**
   * One obs field's type and (for categoricals) category count or labels,
   * without reading its values.
   * @this {import('../reader.js').AnnDataReader}
   */
  async _fieldInfo(key, { withCategories }) {
    this._ensureOpen();
    const cacheKey = withCategories ? `obs_info:${key}` : `obs_type:${key}`;
    if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);
    if (!withCategories) return this._readFieldInfo(key, cacheKey, false, {});
    return this._track('field', `categories of obs['${key}']`, readOptions => this._readFieldInfo(key, cacheKey, true, readOptions));
  }

  /** @this {import('../reader.js').AnnDataReader} @private */
  async _readFieldInfo(key, cacheKey, withCategories, readOptions) {
    const generation = this._generation;
    const format = this._format;
    const obs = this._obsColumn(key);
    const item = obs.get(key);
    const declared = validateColumnEncoding(item, format, `Observation field '${key}'`);
    if (!withCategories && isGroup(item)) {
      // A field's type from its own metadata (`getObsFieldKind`): a column's
      // parts are not loaded at open (`ANNDATA_OPENING_PATHS`) and a defect
      // in them refuses the column when it is read, never here. A
      // categorical's count is known once its parts are loaded (null until).
      let result;
      if (declared === 'categorical') {
        let count = null;
        if (item.loaded) {
          try {
            count = categoryCount(item.get('categories'), key, format);
          } catch {
            count = null;
          }
        }
        result = { dtype: 'categorical', categoryCount: count, ordered: requireCategoricalOrdered(item, `Categorical field '${key}'`) };
      } else {
        // A nullable column: its values' type names an integer column's.
        await obs.load([key], readOptions);
        this._assertGeneration(generation, `loading observation field '${key}'`);
        let valuesKind = null;
        try {
          valuesKind = nullableContract(item, key, declared, format, this._nObs).valuesKind;
        } catch {
          valuesKind = null;
        }
        result = {
          dtype: declared === 'nullable-integer'
            ? (valuesKind === 'uint' ? 'uint' : 'int')
            : (declared === 'nullable-boolean' ? 'bool' : 'string'),
        };
      }
      this._cache.set(cacheKey, result);
      return result;
    }
    await obs.load([key], readOptions);
    this._assertGeneration(generation, `loading observation field '${key}'`);
    const categorical = resolveCategoricalColumn(obs, key, format);
    let result;
    if (categorical) {
      validateCodes(categorical.codes, key, format, this._nObs);
      if (withCategories && this._categoryCoding(key, categorical).present) {
        // Coded by the categories its open cells hold: none is read before
        // its codes (`_readPresentCategorical`).
        result = { dtype: 'categorical', present: true, categoryCount: categoryCount(categorical.categories, key, format), ordered: categorical.ordered, categories: null, colors: null };
      } else if (withCategories) {
        // The palette is read with the categories it colors, as metadata:
        // the first coloring, a legend or a restored session all need it
        // before any code is read.
        const [categories, colors] = await Promise.all([
          this._categories(categorical, key, generation, readOptions),
          readObsFieldColors(this._root, key, readOptions),
        ]);
        result = { dtype: 'categorical', categories, ordered: categorical.ordered, colors };
      } else {
        result = { dtype: 'categorical', categoryCount: categoryCount(categorical.categories, key, format), ordered: categorical.ordered };
      }
    } else if (NULLABLE_ENCODINGS.has(declared)) {
      const contract = nullableContract(item, key, declared, format, this._nObs);
      result = {
        dtype: declared === 'nullable-integer'
          ? (contract.valuesKind === 'uint' ? 'uint' : 'int')
          : (declared === 'nullable-boolean' ? 'bool' : 'string'),
      };
    } else {
      validateOneDimensional(item, format, `Observation field '${key}'`, this._nObs);
      const kind = valueKind(item);
      // An integer column a layout view says holds labels (a Loom
      // clustering): categories, found when it is read.
      result = { dtype: item.labels === true && (kind === 'int' || kind === 'uint') ? 'labels' : kind };
    }
    this._assertGeneration(generation, `reading observation field metadata '${key}'`);
    this._cache.set(cacheKey, result);
    return result;
  }

  /** An obs field's type and categories, without its values. @this {import('../reader.js').AnnDataReader} */
  getObsFieldInfo(key) {
    return this._fieldInfo(key, { withCategories: true });
  }

  /**
   * An obs field's type from its metadata alone, nothing read: a
   * categorical's `categoryCount` and `ordered`, not its categories (a
   * dictionary of one category per cell is megabytes, read when the field
   * is first loaded).
   * @this {import('../reader.js').AnnDataReader}
   */
  getObsFieldKind(key) {
    return this._fieldInfo(key, { withCategories: false });
  }

  /**
   * One obs column on the open cells: a categorical's codes with its
   * categories, numbers as continuous values (float32, float64 where float32
   * cannot hold an integer exactly), and a text or boolean column coded here
   * as a categorical (`discovered: true`, `codeDiscoveredColumn`): under
   * `categories`, the ones it was coded with before (null the first time),
   * with any label these cells add, in label order. `rows` (`[start, end)`
   * of the open cells) reads only those rows -- what an opening grown in
   * place appends (`AnnDataFileSource.resizeCells`) -- and is not cached;
   * every row, cached, by default (a coded text column never: its codes
   * depend on `categories`). `signal` cancels the read. A column of 64-bit
   * integers holding identifiers past 2^53 arrives as text (`asText` says
   * why, `readExactIntegers`); `integers` is how a column already shown
   * reads again: `'text'`, `'numbers'`, or `'decide'` from what is read.
   *
   * @this {import('../reader.js').AnnDataReader}
   * @param {string} key
   * @param {{signal?: AbortSignal|null, rows?: [number, number]|null, categories?: ReadonlyArray<string|boolean>|null, integers?: 'decide'|'text'|'numbers'}} [options]
   */
  async getObsField(key, { signal = null, rows = null, categories = null, integers = 'decide' } = {}) {
    this._ensureOpen();
    const range = this._rowRange(rows, `obs['${key}']`);
    const cacheKey = range === null && integers !== 'text' ? `obs:${key}` : null;
    if (cacheKey !== null && this._cache.has(cacheKey)) return this._cache.get(cacheKey);
    const label = range === null ? `obs['${key}']` : `obs['${key}'] rows ${range.start}–${range.end}`;
    const field = await this._track('field', label, readOptions => this._readObsField(key, cacheKey, readOptions, range, integers), signal);
    if (DISCOVERED_DTYPES.has(field.dtype)) {
      const { codes, categories: labels } = field.dtype === 'bool'
        ? codeBooleanColumn(field.flags, categories, `Observation field '${key}'`)
        : codeDiscoveredColumn(field.values, categories, `Observation field '${key}'`);
      return {
        dtype: 'categorical',
        discovered: true,
        codes,
        categories: labels,
        ordered: false,
        // Integers read as their text (identifiers past 2^53): why, in one line.
        ...(field.asText === undefined ? {} : { asText: field.asText }),
        // The values each code names, as a stored categorical's (computed
        // once, only when asked for); a code past the labels is missing.
        get values() {
          const computed = Array.from(codes, code => (code < labels.length ? labels[code] : null));
          Object.defineProperty(this, 'values', { value: computed, writable: false });
          return computed;
        },
      };
    }
    return field;
  }

  /** @this {import('../reader.js').AnnDataReader} @private */
  async _readObsField(key, cacheKey, readOptions, range = null, integers = 'decide') {
    const generation = this._generation;
    const format = this._format;
    const obs = this._obsColumn(key);
    await obs.load([key], readOptions);
    this._assertGeneration(generation, `loading observation field '${key}'`);
    const item = obs.get(key);
    const declared = validateColumnEncoding(item, format, `Observation field '${key}'`);
    const categorical = resolveCategoricalColumn(obs, key, format);
    const start = range?.start ?? 0;
    let result;
    if (categorical && this._categoryCoding(key, categorical).present) {
      result = await this._readPresentCategorical(key, categorical, readOptions, range, generation);
    } else if (categorical) {
      const count = categoryCount(categorical.categories, key, format);
      const [categories, codes] = await Promise.all([
        this._categories(categorical, key, generation, readOptions),
        readCodes(categorical.codes, count, key, format, this._nObs, readOptions, range),
      ]);
      result = {
        dtype: 'categorical',
        codes,
        categories,
        ordered: categorical.ordered,
        // Values are rarely needed (codes and categories are); computed once,
        // only when asked for.
        get values() {
          const computed = Array.from(codes, code => (code >= 0 ? categories[code] : null));
          Object.defineProperty(this, 'values', { value: computed, writable: false });
          return computed;
        },
      };
    } else if (NULLABLE_ENCODINGS.has(declared)) {
      const nullableIntegers = declared === 'nullable-integer' && stores64BitIntegers(nullableContract(item, key, declared, format, this._nObs).valuesArray)
        ? await this._integerReading(key, integers, range, readOptions)
        : integers;
      result = await readNullableValues(item, key, declared, format, this._nObs, null, readOptions, range, nullableIntegers);
    } else {
      const label = `Observation field '${key}'`;
      const end = range?.end ?? validateOneDimensional(item, format, label, this._nObs);
      if (range !== null) validateOneDimensional(item, format, label, this._nObs);
      const length = end - start;
      const dtype = requirePrimitiveKind(item, label);
      let values;
      if (stores64BitIntegers(item)) {
        // Integers of 64 bits stay exact: as float64 while every one is a
        // safe integer, else, identifiers past 2^53, as their decimal text,
        // coded as a text column is (`readExactIntegers`).
        const read = await readExactIntegers(item, start, end, label, readOptions, null, await this._integerReading(key, integers, range, readOptions));
        if (read.text !== undefined) result = { dtype: 'string', values: read.text, asText: UNSAFE_INTEGERS_AS_TEXT };
        else if (item.labels === true) result = { dtype: 'labels', values: read.values };
        else values = read.values;
      } else if (dtype === 'float' || dtype === 'int' || dtype === 'uint') {
        // Integers stay exact (float64 where float32 cannot hold them).
        values = await readContinuous(item, start, end, label, readOptions);
        if (item.labels === true && dtype !== 'float') {
          // Labels (a Loom clustering): coded by their caller's categories.
          result = { dtype: 'labels', values };
        }
      } else if (dtype === 'bool') {
        // One byte a cell, coded by `getObsField` (`codeBooleanColumn`).
        const raw = await readStored(item, start, end, label, readOptions);
        result = { dtype, flags: decodeAnnDataBooleanFlags(raw, null, `Observation field '${key}' contains a non-boolean value`) };
      } else {
        const raw = await readStored(item, start, end, label, readOptions);
        values = new Array(length);
        for (let i = 0; i < length; i++) values[i] = raw[i];
      }
      result ??= { dtype, values };
    }
    this._assertGeneration(generation, `reading observation field '${key}'`);
    // A text or boolean column is coded by its caller's categories
    // (`getObsField`): its values are not kept.
    if (cacheKey !== null && !DISCOVERED_DTYPES.has(result.dtype)) this._cache.set(cacheKey, result);
    return result;
  }

  /**
   * How the categorical obs field `key` is coded, decided on its first read
   * and kept (`_categoryCodings`): by the categories its open cells hold
   * (`present: true`) when its dictionary has more categories than there
   * are open cells and more than one request of its source reads (the
   * least its categories can be stored in, `leastCategoryBytes`, past the
   * source policy's request size,
   * `LinkMeter.policyRequestBytes`: 8 MiB from a web host, 32 MiB from this
   * machine, the same on every visit, so a list shows the same categories
   * each time) -- a dictionary of one category
   * per cell (barcodes kept as a categorical: over a million categories,
   * tens of megabytes) is then read for the few a share of the cells
   * names -- else by its stored dictionary, every category listed, the
   * unused ones too (what a request reads whole costs no more read whole).
   * @this {import('../reader.js').AnnDataReader}
   * @private
   */
  _categoryCoding(key, categorical) {
    let coding = this._categoryCodings.get(key);
    if (coding === undefined) {
      const count = categoryCount(categorical.categories, key, this._format);
      const requestBytes = this._link?.policyRequestBytes ?? this._link?.maxRequestBytes ?? Infinity;
      coding = count > this._nObs && count * leastCategoryBytes(categorical.categories) > requestBytes
        ? { present: true, count, stored: new Uint32Array(0), labels: Object.freeze([]), colors: null }
        : { present: false };
      this._categoryCodings.set(key, coding);
    }
    return coding;
  }

  /**
   * A categorical coded by the categories its open cells hold
   * (`_categoryCoding`): its codes (of `range`'s rows, or every open row),
   * then the labels of the stored categories they name that no earlier read
   * found (`readCategoriesAt`: only theirs read), with their colors from
   * `uns['<key>_colors']` at the same positions. The field's categories are
   * every one found so far, in stored order (an ordered categorical keeps
   * its order); its codes are positions among them, -1 missing;
   * `present.stored` the stored position of each (its color by default,
   * `presentCategoryPalette`), `present.count` the dictionary's size and
   * `present.colors` the file's colors of them, or null. Exact: each cell's
   * label is the one its stored code names.
   * @this {import('../reader.js').AnnDataReader}
   * @private
   */
  async _readPresentCategorical(key, categorical, readOptions, range, generation) {
    const format = this._format;
    const coding = this._categoryCodings.get(key);
    const rows = range === null ? this._nObs : range.end - range.start;
    // Rows enough that their codes name a category in every chunk of the
    // dictionary (codes spread over it, as a label-ordered dictionary of
    // barcodes is: of c chunks, rows r leave about c * exp(-r / c) unnamed,
    // fewer than one once r > c * ln c): every chunk is read whatever the
    // codes say, so the dictionary and its colors are read with the codes,
    // in one plan, as a read of the stored dictionary is -- no round trip
    // waits for the codes, no request or byte more -- and the present ones
    // picked.
    const chunks = chunkCount(categorical.categories);
    const whole = chunks !== null && rows > chunks * Math.log(chunks) && coding.stored.length < coding.count
      ? Promise.all([
        readCategories(categorical.categories, key, format, readOptions),
        readObsFieldColors(this._root, key, readOptions),
      ])
      : null;
    whole?.catch(() => {});
    const codes = await readCodes(categorical.codes, coding.count, key, format, this._nObs, readOptions, range);
    this._assertGeneration(generation, `reading categorical codes for '${key}'`);
    const added = codesMissingFrom(codes, coding.stored);
    if (added.length > 0) {
      const gather = (array, positions) => (touchesEveryChunk(array, positions)
        ? pickedArray(array, positions)
        : gatheredArray(array, runsOfPositions(positions), { mergeGapBytes: () => this._mergeGapBytes(), chunks: this._decodedChunks }));
      const [labels, colors] = whole !== null
        ? await whole.then(([all, allColors]) => [
          Object.freeze(Array.from(added, position => all[position])),
          allColors === null || allColors.length < coding.count ? null : Array.from(added, position => allColors[position]),
        ])
        : await Promise.all([
          readCategoriesAt(categorical.categories, added, key, format, readOptions, gather),
          readObsFieldColors(this._root, key, readOptions, { count: coding.count, positions: added, gather }),
        ]);
      this._assertGeneration(generation, `reading categorical labels for '${key}'`);
      // A read that finished meanwhile may have found some of them: merged
      // into the coding as it is now.
      const now = this._categoryCodings.get(key);
      if (now !== undefined && now.present) this._categoryCodings.set(key, mergedCoding(now, added, labels, colors, key));
    }
    const merged = this._categoryCodings.get(key);
    const positions = positionsAmong(codes, merged.stored, key);
    return {
      dtype: 'categorical',
      codes: positions,
      categories: merged.labels,
      ordered: categorical.ordered,
      present: { count: merged.count, stored: merged.stored, colors: merged.colors },
      get values() {
        const computed = Array.from(positions, code => (code >= 0 ? merged.labels[code] : null));
        Object.defineProperty(this, 'values', { value: computed, writable: false });
        return computed;
      },
    };
  }

  /**
   * Restore a category dictionary retained by the adapter after this reader's
   * caches were cleared; the immutable array is shared, not decoded again.
   * @this {import('../reader.js').AnnDataReader}
   */
  seedObsFieldCategories(key, categories, ordered) {
    this._ensureOpen();
    if (!Array.isArray(categories)) return;
    if (typeof ordered !== 'boolean') throw new AnnDataFormatError(`Categorical field '${key}' ordered must be a boolean`);
    const categoriesKey = `obs_categories:${key}`;
    const infoKey = `obs_info:${key}`;
    if (!this._cache.has(categoriesKey)) this._cache.set(categoriesKey, categories);
    if (!this._cache.has(infoKey)) this._cache.set(infoKey, { dtype: 'categorical', categories, ordered });
  }

  /**
   * Hand one observation payload to the caller: the reader forgets it but
   * keeps the field's categories and type, so the payload can be transferred
   * out of the worker without leaving a detached buffer in this cache.
   * @this {import('../reader.js').AnnDataReader}
   */
  detachObsField(key, field) {
    const cacheKey = `obs:${key}`;
    if (this._cache.get(cacheKey) === field) this._cache.delete(cacheKey);
  }

  /**
   * Release one cached observation payload (and category aliases the adapter keeps).
   * @this {import('../reader.js').AnnDataReader}
   */
  releaseObsField(key, expected = undefined) {
    const cacheKey = `obs:${key}`;
    const cached = this._cache.get(cacheKey);
    if (expected !== undefined && cached !== expected) return;
    this._cache.delete(cacheKey);
    const categories = cached?.dtype === 'categorical' ? cached.categories : null;
    if (!Array.isArray(categories)) return;
    const categoriesKey = `obs_categories:${key}`;
    if (this._cache.get(categoriesKey) === categories) this._cache.delete(categoriesKey);
    const infoKey = `obs_info:${key}`;
    const info = this._cache.get(infoKey);
    if (info?.dtype === 'categorical' && info.categories === categories) this._cache.delete(infoKey);
  }
}
