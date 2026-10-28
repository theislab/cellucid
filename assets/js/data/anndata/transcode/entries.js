/**
 * Sparse entries arriving in any order — `(cell, feature, value)`, from a
 * MatrixMarket file, an R `dgTMatrix`, or the pieces of a Seurat v5 split
 * layer — written as one compressed cells × features matrix in the
 * transcode space (`space.js`), streaming: what is held in memory is bounded
 * by a block of entries, never by the matrix.
 *
 * - Entries are written as they arrive, each array to a payload of its own,
 *   while their order is followed.
 * - Entries that arrived by cell (Cell Ranger, STARsolo, one R piece) are
 *   the `csr_matrix` as they are; entries that arrived by feature (kb-python,
 *   alevin-fry) are the same matrix as a `csc_matrix`, again as they are.
 *   Nothing is read back.
 * - Entries in any other order are sorted by cell in two streaming passes:
 *   they are dealt into buckets of consecutive cells (each holding at most
 *   `SORT_BLOCK_ENTRIES`, unless one cell alone holds more), then each bucket
 *   is read back, put in order (cells, then features within a cell) and
 *   appended to the matrix. A bucket is given back as soon as it is written.
 *
 * Arrays are kept in host byte order (little-endian on every engine that
 * runs the app): indices and pointers as `int32` (pointers as `float64` past
 * 2^31 entries), values as the collector's type.
 *
 * @module data/anndata/transcode/entries
 */

import { formatCountOf } from '../../../utils/format-units.js';
import { allocateTypedArray, copyTypedArray } from '../../sparse-column-index.js';

/**
 * Entries in one bucket of the sort, and in one slice read back (a
 * scheduling choice: about 64 MB of memory at a time, whatever the matrix's
 * size).
 */
export const SORT_BLOCK_ENTRIES = 1 << 22;

/**
 * Entries staged before one write to a payload (a scheduling choice,
 * measured): an origin-private file takes a megabyte a write at 2.6 times
 * the rate of 64 KB writes in Chromium (670 against 260 MB/s; Firefox 1.7
 * against 1.2 GB/s).
 */
const STAGE_ENTRIES = 1 << 18;

/** The bytes of a typed array (a memory-backed one's buffer is larger than it). */
function bytesOf(array) {
  return new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
}

/** Values of an array of `Type` read from bytes the caller owns. */
function typedOf(Type, bytes) {
  if (bytes.byteOffset % Type.BYTES_PER_ELEMENT === 0) {
    return new Type(bytes.buffer, bytes.byteOffset, bytes.byteLength / Type.BYTES_PER_ELEMENT);
  }
  const aligned = copyTypedArray(Uint8Array, bytes, 'Matrix entries');
  return new Type(aligned.buffer, aligned.byteOffset, bytes.byteLength / Type.BYTES_PER_ELEMENT);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('The read was aborted.', 'AbortError');
}

/**
 * One payload written in staged blocks of one typed array type, without a
 * promise per entry: a full stage is handed to the sink at once (both sinks
 * of the space write synchronously; a stage handed to one that answers with
 * a promise is not reused before it settles).
 */
class StagedWriter {
  constructor(writer, Type, capacity = STAGE_ENTRIES) {
    this.writer = writer;
    this.stage = allocateTypedArray(Type, capacity, 'Matrix entries');
    this.filled = 0;
    this.pending = [];
  }

  push(value) {
    this.stage[this.filled++] = value;
    if (this.filled === this.stage.length) this.flush();
  }

  /** The first `count` values of `values` (of this writer's type), in order after those pushed: copied, so `values` may be reused. */
  pushArray(values, count) {
    for (let from = 0; from < count;) {
      const take = Math.min(count - from, this.stage.length - this.filled);
      this.stage.set(values.subarray(from, from + take), this.filled);
      this.filled += take;
      from += take;
      if (this.filled === this.stage.length) this.flush();
    }
  }

  flush() {
    if (this.filled === 0) return;
    const pending = this.writer.write(new Uint8Array(this.stage.buffer, 0, this.filled * this.stage.BYTES_PER_ELEMENT));
    this.filled = 0;
    if (pending !== undefined) {
      this.pending.push(pending);
      this.stage = allocateTypedArray(this.stage.constructor, this.stage.length, 'Matrix entries');
    }
  }

  async close() {
    this.flush();
    await Promise.all(this.pending);
    return this.writer.close();
  }
}

/** Pointers from counts: `int32` while they fit, else `float64`. */
function pointersOf(counts) {
  const pointers = allocateTypedArray(Float64Array, counts.length + 1, 'Matrix pointers');
  for (let i = 0; i < counts.length; i++) pointers[i + 1] = pointers[i] + counts[i];
  return pointers[counts.length] < 2 ** 31 ? copyTypedArray(Int32Array, pointers, 'Matrix pointers') : pointers;
}

/**
 * Collects entries in any order into one compressed matrix in the space.
 *
 * ```js
 * const collector = await EntryCollector.open(space, { nCells, nFeatures, entries, Values: Float32Array });
 * for (...) collector.add(cell, feature, value);         // or a block at a time: addBatch(cells, features, values, count)
 * const matrix = await collector.finish();               // {format, shape, indptr, indices, data}
 * ```
 */
export class EntryCollector {
  /**
   * @param {import('./space.js').TranscodeSpace} space
   * @param {{nCells: number, nFeatures: number, entries: number,
   *   Values?: Float32ArrayConstructor|Float64ArrayConstructor, signal?: AbortSignal|null, blockEntries?: number}} options
   *   `entries`: how many will arrive (what the payloads are opened for;
   *   null when it is known only at the end, as for one modality of a
   *   matrix whose entries are dealt among several);
   *   `blockEntries`: the sort's bucket and slice size (tests make it small)
   */
  static async open(space, { nCells, nFeatures, entries, Values = Float32Array, signal = null, blockEntries = SORT_BLOCK_ENTRIES }) {
    const collector = new EntryCollector(space, { nCells, nFeatures, entries, Values, signal, blockEntries });
    const valueBytes = Values.BYTES_PER_ELEMENT;
    const bytes = width => (entries === null ? null : entries * width);
    collector.cells = new StagedWriter(await space.sink.open(bytes(4)), Int32Array);
    collector.features = new StagedWriter(await space.sink.open(bytes(4)), Int32Array);
    collector.values = new StagedWriter(await space.sink.open(bytes(valueBytes)), Values);
    return collector;
  }

  constructor(space, { nCells, nFeatures, entries, Values, signal, blockEntries }) {
    this.space = space;
    this.blockEntries = blockEntries;
    this.nCells = nCells;
    this.nFeatures = nFeatures;
    this.expected = entries;
    this.Values = Values;
    this.signal = signal;
    this.count = 0;
    this.cellCounts = allocateTypedArray(Float64Array, nCells, 'Entries per cell');
    this.featureCounts = allocateTypedArray(Float64Array, nFeatures, 'Entries per feature');
    this.byCell = true;
    this.byFeature = true;
    this.lastCell = -1;
    this.lastFeature = -1;
  }

  /**
   * One entry (synchronous: a MatrixMarket parser calls it per line).
   *
   * @param {number} cell
   * @param {number} feature
   * @param {number} value
   */
  add(cell, feature, value) {
    if (!(cell >= 0 && cell < this.nCells && feature >= 0 && feature < this.nFeatures)) {
      throw new RangeError(`An entry at cell ${cell}, feature ${feature} is outside the ${this.nCells} × ${this.nFeatures} matrix.`);
    }
    if (this.byCell && (cell < this.lastCell || (cell === this.lastCell && feature <= this.lastFeature))) this.byCell = false;
    if (this.byFeature && (feature < this.lastFeature || (feature === this.lastFeature && cell <= this.lastCell))) this.byFeature = false;
    this.lastCell = cell;
    this.lastFeature = feature;
    this.cellCounts[cell]++;
    this.featureCounts[feature]++;
    this.count++;
    this.cells.push(cell);
    this.features.push(feature);
    this.values.push(value);
    if ((this.count & 0xfffff) === 0) throwIfAborted(this.signal);
  }

  /**
   * The first `count` entries of three arrays, as `add` would take them one
   * by one (a MatrixMarket parser hands over a block at a time). `cells` and
   * `features` are `Int32Array`s, `values` of the collector's type; they are
   * copied, so the caller may reuse them.
   *
   * @param {Int32Array} cells
   * @param {Int32Array} features
   * @param {Float32Array|Float64Array} values
   * @param {number} count
   */
  addBatch(cells, features, values, count) {
    if (!(cells instanceof Int32Array) || !(features instanceof Int32Array) || !(values instanceof this.Values) ||
        !Number.isSafeInteger(count) || count < 0 || cells.length < count || features.length < count || values.length < count) {
      throw new TypeError('An entry batch is two Int32Array index arrays and the collector\'s value array, each holding its count.');
    }
    const { nCells, nFeatures, cellCounts, featureCounts } = this;
    let { byCell, byFeature, lastCell, lastFeature } = this;
    for (let k = 0; k < count; k++) {
      const cell = cells[k];
      const feature = features[k];
      if (!(cell >= 0 && cell < nCells && feature >= 0 && feature < nFeatures)) {
        throw new RangeError(`An entry at cell ${cell}, feature ${feature} is outside the ${nCells} × ${nFeatures} matrix.`);
      }
      if (byCell && (cell < lastCell || (cell === lastCell && feature <= lastFeature))) byCell = false;
      if (byFeature && (feature < lastFeature || (feature === lastFeature && cell <= lastCell))) byFeature = false;
      lastCell = cell;
      lastFeature = feature;
      cellCounts[cell]++;
      featureCounts[feature]++;
    }
    this.byCell = byCell;
    this.byFeature = byFeature;
    this.lastCell = lastCell;
    this.lastFeature = lastFeature;
    this.count += count;
    this.cells.pushArray(cells, count);
    this.features.pushArray(features, count);
    this.values.pushArray(values, count);
    throwIfAborted(this.signal);
  }

  /**
   * The matrix: as the entries arrived when they arrived in order, else
   * sorted by cell.
   *
   * @returns {Promise<{format: 'csr'|'csc', shape: [number, number], indptr: Object, indices: Object, data: Object}>}
   */
  async finish() {
    if (this.expected !== null && this.count !== this.expected) {
      throw new Error(`The matrix declared ${formatCountOf(this.expected, 'entry', 'entries')} and ${this.count} arrived.`);
    }
    const cells = await this.cells.close();
    const features = await this.features.close();
    const values = await this.values.close();
    const valueDtype = this.Values === Float64Array ? '<f8' : '<f4';
    const shape = [this.nCells, this.nFeatures];
    if (this.byCell) {
      await this.space.sink.release?.(cells);
      return { format: 'csr', shape, indptr: { values: pointersOf(this.cellCounts) }, indices: { region: features, dtype: '<i4' }, data: { region: values, dtype: valueDtype } };
    }
    if (this.byFeature) {
      await this.space.sink.release?.(features);
      return { format: 'csc', shape, indptr: { values: pointersOf(this.featureCounts) }, indices: { region: cells, dtype: '<i4' }, data: { region: values, dtype: valueDtype } };
    }
    const sorted = await this._sortByCell(cells, features, values);
    return { format: 'csr', shape, indptr: { values: pointersOf(this.cellCounts) }, indices: { region: sorted.features, dtype: '<i4' }, data: { region: sorted.values, dtype: valueDtype } };
  }

  /** Buckets of consecutive cells, each at most `blockEntries` entries (or one cell). */
  _buckets() {
    const starts = [0];
    const sizes = [];
    let size = 0;
    for (let cell = 0; cell < this.nCells; cell++) {
      const count = this.cellCounts[cell];
      if (size > 0 && size + count > this.blockEntries) {
        sizes.push(size);
        starts.push(cell);
        size = 0;
      }
      size += count;
    }
    sizes.push(size);
    const bucketOf = allocateTypedArray(Int32Array, this.nCells, 'Cell buckets');
    for (let b = 0; b < starts.length; b++) {
      const end = b + 1 < starts.length ? starts[b + 1] : this.nCells;
      bucketOf.fill(b, starts[b], end);
    }
    return { starts, sizes, bucketOf };
  }

  async _sortByCell(cellsRegion, featuresRegion, valuesRegion) {
    const { space, Values, signal } = this;
    const valueBytes = Values.BYTES_PER_ELEMENT;
    const { starts, sizes, bucketOf } = this._buckets();
    // Pass 1: deal the entries into their buckets.
    const buckets = [];
    for (const size of sizes) {
      buckets.push({
        cells: new StagedWriter(await space.sink.open(size * 4), Int32Array, 4096),
        features: new StagedWriter(await space.sink.open(size * 4), Int32Array, 4096),
        values: new StagedWriter(await space.sink.open(size * valueBytes), Values, 4096),
      });
    }
    const slice = (region, from, count, bytes) => space.read({ store: region.store, offset: region.offset + from * bytes, byteLength: count * bytes });
    for (let from = 0; from < this.count; from += this.blockEntries) {
      throwIfAborted(signal);
      const count = Math.min(this.blockEntries, this.count - from);
      const cells = typedOf(Int32Array, await slice(cellsRegion, from, count, 4));
      const features = typedOf(Int32Array, await slice(featuresRegion, from, count, 4));
      const values = typedOf(Values, await slice(valuesRegion, from, count, valueBytes));
      for (let k = 0; k < count; k++) {
        const bucket = buckets[bucketOf[cells[k]]];
        bucket.cells.push(cells[k]);
        bucket.features.push(features[k]);
        bucket.values.push(values[k]);
      }
    }
    for (const region of [cellsRegion, featuresRegion, valuesRegion]) await space.sink.release?.(region);
    const dealt = [];
    for (const bucket of buckets) {
      dealt.push({ cells: await bucket.cells.close(), features: await bucket.features.close(), values: await bucket.values.close() });
    }
    // Pass 2: each bucket in order, appended to the matrix.
    const outFeatures = await space.sink.open(this.count * 4);
    const outValues = await space.sink.open(this.count * valueBytes);
    for (let b = 0; b < dealt.length; b++) {
      throwIfAborted(signal);
      const size = sizes[b];
      const first = starts[b];
      const end = b + 1 < starts.length ? starts[b + 1] : this.nCells;
      const cells = typedOf(Int32Array, await space.read(dealt[b].cells));
      const features = typedOf(Int32Array, await space.read(dealt[b].features));
      const values = typedOf(Values, await space.read(dealt[b].values));
      // Where each cell's entries start in this bucket.
      const next = allocateTypedArray(Float64Array, end - first, 'Matrix pointers');
      for (let cell = first + 1; cell < end; cell++) next[cell - first] = next[cell - first - 1] + this.cellCounts[cell - 1];
      const order = allocateTypedArray(Int32Array, size, 'Matrix entries');
      for (let k = 0; k < size; k++) order[next[cells[k] - first]++] = k;
      const sortedFeatures = allocateTypedArray(Int32Array, size, 'Matrix entries');
      const sortedValues = allocateTypedArray(Values, size, 'Matrix entries');
      let at = 0;
      for (let cell = first; cell < end; cell++) {
        const count = this.cellCounts[cell];
        const span = order.subarray(at, at + count);
        let ordered = true;
        for (let k = 1; k < count && ordered; k++) ordered = features[span[k - 1]] < features[span[k]];
        if (!ordered) span.sort((x, y) => features[x] - features[y] || x - y);
        for (let k = 0; k < count; k++) {
          sortedFeatures[at + k] = features[span[k]];
          sortedValues[at + k] = values[span[k]];
        }
        at += count;
      }
      const written = [outFeatures.write(bytesOf(sortedFeatures)), outValues.write(bytesOf(sortedValues))];
      await Promise.all(written);
      for (const region of Object.values(dealt[b])) await space.sink.release?.(region);
    }
    return { features: await outFeatures.close(), values: await outValues.close() };
  }
}

const PART_TYPES = Object.freeze({ i4: Int32Array, u4: Uint32Array, f4: Float32Array, f8: Float64Array });

/** The element count of one matrix part (`{values}` or `{region, dtype}`). */
function partLength(part) {
  if (part.values !== undefined) return part.values.length;
  return part.region.byteLength / PART_TYPES[part.dtype.slice(1)].BYTES_PER_ELEMENT;
}

/**
 * Elements `[from, from + count)` of one matrix part, in host order: a view
 * of held values, or a region read back (R's big-endian payloads swapped).
 */
async function partSlice(part, from, count, readRegion) {
  if (part.values !== undefined) return part.values.subarray(from, from + count);
  const Type = PART_TYPES[part.dtype.slice(1)];
  if (Type === undefined) throw new TypeError(`A matrix part of dtype '${part.dtype}' cannot be reordered.`);
  const width = Type.BYTES_PER_ELEMENT;
  const bytes = await readRegion({ store: part.region.store, offset: part.region.offset + from * width, byteLength: count * width });
  if (part.dtype[0] !== '>') return typedOf(Type, bytes);
  const out = allocateTypedArray(Type, count, 'Matrix entries');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (Type === Float64Array) for (let k = 0; k < count; k++) out[k] = view.getFloat64(k * 8);
  else if (Type === Float32Array) for (let k = 0; k < count; k++) out[k] = view.getFloat32(k * 4);
  else if (Type === Int32Array) for (let k = 0; k < count; k++) out[k] = view.getInt32(k * 4);
  else for (let k = 0; k < count; k++) out[k] = view.getUint32(k * 4);
  return out;
}

/**
 * The order that sorts `keys` (uint32, any order) ascending, stable: two
 * counting passes of 16 bits (least significant first), linear in the
 * entries whatever the keys' range.
 *
 * @param {Uint32Array|Int32Array} keys
 * @returns {Uint32Array}
 */
function stableOrderOf(keys) {
  const size = keys.length;
  let order = allocateTypedArray(Uint32Array, size, 'Matrix entry order');
  for (let k = 0; k < size; k++) order[k] = k;
  let spare = allocateTypedArray(Uint32Array, size, 'Matrix entry order');
  const counts = new Uint32Array(65537);
  for (const shift of [0, 16]) {
    counts.fill(0);
    for (let k = 0; k < size; k++) counts[((keys[k] >>> shift) & 0xffff) + 1]++;
    for (let d = 1; d <= 65536; d++) counts[d] += counts[d - 1];
    for (let k = 0; k < size; k++) {
      const at = order[k];
      spare[counts[(keys[at] >>> shift) & 0xffff]++] = at;
    }
    [order, spare] = [spare, order];
  }
  return order;
}

/** The first position of `segment` holding a value at or past `value` (ascending values). */
function lowerBound(segment, from, to, value) {
  let low = from;
  let high = to;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (segment[middle] < value) low = middle + 1;
    else high = middle;
  }
  return low - from;
}

/**
 * A cells × features matrix stored by feature (`csc_matrix`), so a gene is
 * one contiguous range of the store, as in a Cellucid-ready AnnData: what a
 * transcoded store keeps of its expression matrix, from an R matrix
 * (`dgCMatrix` columns are cells) or a MatrixMarket file sorted by cell.
 *
 * `rows` (optional) renumbers the cells: cell `c` becomes row `rows[c]`
 * (the priority order of a transcoded store, `priority.js`), and within each
 * feature the entries ascend by their new row, so a feature's first entries
 * are its cells of lowest priority rank. `levels` (optional, ascending
 * row counts) adds `prefixCounts`: each feature's entries in rows below each
 * level (`varm['cellucid_prefix_counts']`, level-major).
 *
 * Bounded memory, whatever the matrix's size: the features are cut into
 * buckets of consecutive features of at most `blockEntries` entries (or one
 * feature). A matrix by cell is first counted (one pass over its indices)
 * and dealt, in cell order, into its buckets (each a payload of the space);
 * a matrix by feature is read bucket by bucket as it is. Each bucket is
 * then laid out by feature -- a counting sort, after a stable sort by the
 * new rows when the cells are renumbered -- and appended. Values keep their
 * type (R's doubles stay doubles), in host order. A dense matrix, and a
 * matrix by feature with nothing to renumber, are returned as they are.
 *
 * @param {{format: string, shape: [number, number], indptr?: Object, indices?: Object, data?: Object}} matrix
 * @param {{space: import('./space.js').TranscodeSpace, readRegion: Function, signal?: AbortSignal|null}} context
 * @param {{blockEntries?: number, rows?: Uint32Array|null, levels?: number[]|null}} [options] - `blockEntries`: the bucket and slice size (tests make it small)
 * @returns {Promise<Object>} The `csc_matrix` part set (with `prefixCounts` when `levels` were given)
 */
export async function byFeature(matrix, context, { blockEntries = SORT_BLOCK_ENTRIES, rows = null, levels = null } = {}) {
  if (matrix.format === 'dense' || (matrix.format === 'csc' && rows === null && levels === null)) return matrix;
  if (matrix.format !== 'csr' && matrix.format !== 'csc') throw new TypeError(`A '${matrix.format}' matrix cannot be laid out by feature.`);
  const { space, readRegion, signal = null } = context;
  const [nCells, nFeatures] = matrix.shape;
  const fromCells = matrix.format === 'csr';
  const nMajor = fromCells ? nCells : nFeatures;
  const indptrLength = partLength(matrix.indptr);
  if (indptrLength !== nMajor + 1) {
    throw new Error(`A ${nMajor}-${fromCells ? 'cell' : 'feature'} matrix has ${indptrLength} ${fromCells ? 'row' : 'column'} pointers.`);
  }
  if (rows !== null && rows.length !== nCells) throw new Error(`A renumbering of ${formatCountOf(rows.length, 'cell')} was given for a ${nCells}-cell matrix.`);
  const pointers = copyTypedArray(Float64Array, await partSlice(matrix.indptr, 0, indptrLength, readRegion), 'Matrix pointers');
  const count = pointers[nMajor];
  const dataType = matrix.data.values !== undefined ? matrix.data.values.constructor : PART_TYPES[matrix.data.dtype.slice(1)];
  const Values = dataType === Float32Array ? Float32Array : Float64Array;
  const valueDtype = Values === Float64Array ? '<f8' : '<f4';
  const featureCounts = allocateTypedArray(Float64Array, nFeatures, 'Entries per feature');
  if (fromCells) {
    // Pass 1: entries per feature.
    for (let from = 0; from < count; from += blockEntries) {
      throwIfAborted(signal);
      const take = Math.min(blockEntries, count - from);
      const features = await partSlice(matrix.indices, from, take, readRegion);
      for (let k = 0; k < take; k++) featureCounts[features[k]]++;
    }
  } else {
    for (let feature = 0; feature < nFeatures; feature++) featureCounts[feature] = pointers[feature + 1] - pointers[feature];
  }
  // Buckets of consecutive features.
  const starts = [0];
  const sizes = [];
  let size = 0;
  for (let feature = 0; feature < nFeatures; feature++) {
    if (size > 0 && size + featureCounts[feature] > blockEntries) {
      sizes.push(size);
      starts.push(feature);
      size = 0;
    }
    size += featureCounts[feature];
  }
  sizes.push(size);
  const endOf = b => (b + 1 < starts.length ? starts[b + 1] : nFeatures);
  /** One bucket's entries: their (renumbered) cells, features and values. */
  let bucketEntries;
  let dealt = null;
  if (fromCells) {
    const bucketOf = allocateTypedArray(Int32Array, nFeatures, 'Feature buckets');
    for (let b = 0; b < starts.length; b++) bucketOf.fill(b, starts[b], endOf(b));
    // Pass 2: deal every entry, in cell order, into its bucket.
    const buckets = [];
    for (const entries of sizes) {
      buckets.push({
        cells: new StagedWriter(await space.sink.open(entries * 4), Int32Array, 4096),
        features: new StagedWriter(await space.sink.open(entries * 4), Int32Array, 4096),
        values: new StagedWriter(await space.sink.open(entries * Values.BYTES_PER_ELEMENT), Values, 4096),
      });
    }
    let cell = 0;
    for (let from = 0; from < count; from += blockEntries) {
      throwIfAborted(signal);
      const take = Math.min(blockEntries, count - from);
      const features = await partSlice(matrix.indices, from, take, readRegion);
      const values = await partSlice(matrix.data, from, take, readRegion);
      for (let k = 0; k < take; k++) {
        const entry = from + k;
        while (entry >= pointers[cell + 1]) cell++;
        const bucket = buckets[bucketOf[features[k]]];
        bucket.cells.push(rows === null ? cell : rows[cell]);
        bucket.features.push(features[k]);
        bucket.values.push(values[k]);
      }
    }
    dealt = [];
    for (const bucket of buckets) {
      dealt.push({ cells: await bucket.cells.close(), features: await bucket.features.close(), values: await bucket.values.close() });
    }
    bucketEntries = async b => ({
      cells: typedOf(Int32Array, await space.read(dealt[b].cells)),
      features: typedOf(Int32Array, await space.read(dealt[b].features)),
      values: typedOf(Values, await space.read(dealt[b].values)),
    });
  } else {
    // A matrix by feature: each bucket is one range of its entries.
    bucketEntries = async b => {
      const from = pointers[starts[b]];
      const take = pointers[endOf(b)] - from;
      const stored = await partSlice(matrix.indices, from, take, readRegion);
      const cells = allocateTypedArray(Int32Array, take, 'Matrix entries');
      for (let k = 0; k < take; k++) cells[k] = rows === null ? stored[k] : rows[stored[k]];
      const features = allocateTypedArray(Int32Array, take, 'Matrix entries');
      for (let feature = starts[b]; feature < endOf(b); feature++) {
        features.fill(feature, pointers[feature] - from, pointers[feature + 1] - from);
      }
      return { cells, features, values: Values.from(await partSlice(matrix.data, from, take, readRegion)) };
    };
  }
  const prefixCounts = levels === null ? null : allocateTypedArray(Uint32Array, levels.length * nFeatures, 'Prefix counts');
  // Pass 3: each bucket laid out by feature, appended.
  const outCells = await space.sink.open(count * 4);
  const outValues = await space.sink.open(count * Values.BYTES_PER_ELEMENT);
  for (let b = 0; b < sizes.length; b++) {
    throwIfAborted(signal);
    const first = starts[b];
    const end = endOf(b);
    const { cells, features, values } = await bucketEntries(b);
    const next = allocateTypedArray(Float64Array, end - first, 'Matrix pointers');
    for (let feature = first + 1; feature < end; feature++) next[feature - first] = next[feature - first - 1] + featureCounts[feature - 1];
    const sortedCells = allocateTypedArray(Int32Array, sizes[b], 'Matrix entries');
    const sortedValues = allocateTypedArray(Values, sizes[b], 'Matrix entries');
    // Entries dealt in cell order are in order within a feature; renumbered
    // ones are put in order of their new rows first (a stable sort).
    const visit = rows === null ? null : stableOrderOf(cells);
    for (let i = 0; i < sizes[b]; i++) {
      const k = visit === null ? i : visit[i];
      const at = next[features[k] - first]++;
      sortedCells[at] = cells[k];
      sortedValues[at] = values[k];
    }
    if (prefixCounts !== null) {
      let at = 0;
      for (let feature = first; feature < end; feature++) {
        const stop = at + featureCounts[feature];
        for (let j = 0; j < levels.length; j++) prefixCounts[j * nFeatures + feature] = lowerBound(sortedCells, at, stop, levels[j]);
        at = stop;
      }
    }
    await Promise.all([outCells.write(bytesOf(sortedCells)), outValues.write(bytesOf(sortedValues))]);
    if (dealt !== null) for (const region of Object.values(dealt[b])) await space.sink.release?.(region);
  }
  const result = {
    format: 'csc',
    shape: [nCells, nFeatures],
    indptr: { values: pointersOf(featureCounts) },
    indices: { region: await outCells.close(), dtype: '<i4' },
    data: { region: await outValues.close(), dtype: valueDtype },
  };
  if (prefixCounts !== null) result.prefixCounts = prefixCounts;
  return result;
}

/**
 * A compressed matrix with its major axis in a new order and, optionally,
 * its minor axis renumbered: a cells × features `csr_matrix` with its cells
 * in priority order (a layer kept by cell), or a cells × cells graph with
 * both axes in priority order (`csr_matrix` or `csc_matrix` alike).
 *
 * Line `i` of the result is line `order[i]` of `matrix` (`position` is the
 * inverse: line `l` goes to `position[l]`); `minor` (optional) renumbers the
 * minor axis (position `p` becomes `minor[p]`), and the entries of each line
 * are then put in order of their new positions. Bounded memory, as
 * `byFeature`: buckets of consecutive new lines of at most `blockEntries`
 * entries; one pass deals every entry, in the stored order, into its
 * bucket; each bucket is put in line order (a stable counting sort) and
 * appended.
 *
 * @param {{format: 'csr'|'csc', shape: [number, number], indptr: Object, indices: Object, data: Object}} matrix
 * @param {{space: import('./space.js').TranscodeSpace, readRegion: Function, signal?: AbortSignal|null}} context
 * @param {{order: Uint32Array, position: Uint32Array, minor?: Uint32Array|null, blockEntries?: number}} options
 * @returns {Promise<Object>} The part set, in `matrix`'s format
 */
export async function majorInOrder(matrix, context, { order, position, minor = null, blockEntries = SORT_BLOCK_ENTRIES }) {
  if (matrix.format !== 'csr' && matrix.format !== 'csc') throw new TypeError(`A '${matrix.format}' matrix has no major axis to order.`);
  const { space, readRegion, signal = null } = context;
  const nMajor = matrix.format === 'csr' ? matrix.shape[0] : matrix.shape[1];
  const indptrLength = partLength(matrix.indptr);
  if (indptrLength !== nMajor + 1 || order.length !== nMajor) {
    throw new Error(`A matrix of ${formatCountOf(nMajor, 'line')} has ${formatCountOf(indptrLength, 'pointer')} and an order of ${formatCountOf(order.length, 'line')}.`);
  }
  const pointers = copyTypedArray(Float64Array, await partSlice(matrix.indptr, 0, indptrLength, readRegion), 'Matrix pointers');
  const count = pointers[nMajor];
  const dataType = matrix.data.values !== undefined ? matrix.data.values.constructor : PART_TYPES[matrix.data.dtype.slice(1)];
  const Values = dataType === Float32Array ? Float32Array : Float64Array;
  const valueDtype = Values === Float64Array ? '<f8' : '<f4';
  const lineCounts = allocateTypedArray(Float64Array, nMajor, 'Entries per line');
  for (let i = 0; i < nMajor; i++) lineCounts[i] = pointers[order[i] + 1] - pointers[order[i]];
  // Buckets of consecutive new lines.
  const starts = [0];
  const sizes = [];
  let size = 0;
  for (let line = 0; line < nMajor; line++) {
    if (size > 0 && size + lineCounts[line] > blockEntries) {
      sizes.push(size);
      starts.push(line);
      size = 0;
    }
    size += lineCounts[line];
  }
  sizes.push(size);
  const bucketOfLine = allocateTypedArray(Int32Array, nMajor, 'Line buckets');
  for (let b = 0; b < starts.length; b++) bucketOfLine.fill(b, starts[b], b + 1 < starts.length ? starts[b + 1] : nMajor);
  const buckets = [];
  for (const entries of sizes) {
    buckets.push({
      lines: new StagedWriter(await space.sink.open(entries * 4), Int32Array, 4096),
      indices: new StagedWriter(await space.sink.open(entries * 4), Int32Array, 4096),
      values: new StagedWriter(await space.sink.open(entries * Values.BYTES_PER_ELEMENT), Values, 4096),
    });
  }
  let line = 0;
  for (let from = 0; from < count; from += blockEntries) {
    throwIfAborted(signal);
    const take = Math.min(blockEntries, count - from);
    const indices = await partSlice(matrix.indices, from, take, readRegion);
    const values = await partSlice(matrix.data, from, take, readRegion);
    for (let k = 0; k < take; k++) {
      while (from + k >= pointers[line + 1]) line++;
      const placed = position[line];
      const bucket = buckets[bucketOfLine[placed]];
      bucket.lines.push(placed);
      bucket.indices.push(minor === null ? indices[k] : minor[indices[k]]);
      bucket.values.push(values[k]);
    }
  }
  const outIndices = await space.sink.open(count * 4);
  const outValues = await space.sink.open(count * Values.BYTES_PER_ELEMENT);
  for (let b = 0; b < buckets.length; b++) {
    throwIfAborted(signal);
    const parts = { lines: await buckets[b].lines.close(), indices: await buckets[b].indices.close(), values: await buckets[b].values.close() };
    const lines = typedOf(Int32Array, await space.read(parts.lines));
    const indices = typedOf(Int32Array, await space.read(parts.indices));
    const values = typedOf(Values, await space.read(parts.values));
    const first = starts[b];
    const end = b + 1 < starts.length ? starts[b + 1] : nMajor;
    const next = allocateTypedArray(Float64Array, end - first, 'Matrix pointers');
    for (let l = first + 1; l < end; l++) next[l - first] = next[l - first - 1] + lineCounts[l - 1];
    const placedIndices = allocateTypedArray(Int32Array, sizes[b], 'Matrix entries');
    const placedValues = allocateTypedArray(Values, sizes[b], 'Matrix entries');
    for (let k = 0; k < sizes[b]; k++) {
      const at = next[lines[k] - first]++;
      placedIndices[at] = indices[k];
      placedValues[at] = values[k];
    }
    if (minor !== null) {
      // Each line's entries in order of their new positions.
      let at = 0;
      for (let l = first; l < end; l++) {
        const stop = at + lineCounts[l];
        let ordered = true;
        for (let k = at + 1; k < stop && ordered; k++) ordered = placedIndices[k - 1] < placedIndices[k];
        if (!ordered) {
          const span = Array.from({ length: stop - at }, (_, k) => at + k).sort((x, y) => placedIndices[x] - placedIndices[y]);
          const sortedIndices = Int32Array.from(span, k => placedIndices[k]);
          const sortedValues = Values.from(span, k => placedValues[k]);
          placedIndices.set(sortedIndices, at);
          placedValues.set(sortedValues, at);
        }
        at = stop;
      }
    }
    await Promise.all([outIndices.write(bytesOf(placedIndices)), outValues.write(bytesOf(placedValues))]);
    for (const region of Object.values(parts)) await space.sink.release?.(region);
  }
  return {
    format: matrix.format,
    shape: matrix.shape,
    indptr: { values: pointersOf(lineCounts) },
    indices: { region: await outIndices.close(), dtype: '<i4' },
    data: { region: await outValues.close(), dtype: valueDtype },
  };
}
