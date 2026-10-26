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

/** Values of an array of `Type` read from bytes the caller owns. */
function typedOf(Type, bytes) {
  if (bytes.byteOffset % Type.BYTES_PER_ELEMENT === 0) {
    return new Type(bytes.buffer, bytes.byteOffset, bytes.byteLength / Type.BYTES_PER_ELEMENT);
  }
  return new Type(bytes.slice().buffer);
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
    this.stage = new Type(capacity);
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
      this.stage = new this.stage.constructor(this.stage.length);
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
  const pointers = new Float64Array(counts.length + 1);
  for (let i = 0; i < counts.length; i++) pointers[i + 1] = pointers[i] + counts[i];
  return pointers[counts.length] < 2 ** 31 ? Int32Array.from(pointers) : pointers;
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
    this.cellCounts = new Float64Array(nCells);
    this.featureCounts = new Float64Array(nFeatures);
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
    const bucketOf = new Int32Array(this.nCells);
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
      const next = new Float64Array(end - first);
      for (let cell = first + 1; cell < end; cell++) next[cell - first] = next[cell - first - 1] + this.cellCounts[cell - 1];
      const order = new Int32Array(size);
      for (let k = 0; k < size; k++) order[next[cells[k] - first]++] = k;
      const sortedFeatures = new Int32Array(size);
      const sortedValues = new Values(size);
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
      const written = [outFeatures.write(new Uint8Array(sortedFeatures.buffer)), outValues.write(new Uint8Array(sortedValues.buffer))];
      await Promise.all(written);
      for (const region of Object.values(dealt[b])) await space.sink.release?.(region);
    }
    return { features: await outFeatures.close(), values: await outValues.close() };
  }
}
