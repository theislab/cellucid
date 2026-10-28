/**
 * The store contract's `ArrayNode` for one Zarr array.
 *
 * A read finds the chunks its selection intersects and asks the store for
 * all of them at once (the backend batches and parallelises them), decodes
 * each as it arrives (a few at a time, so decoded chunks do not pile up; a
 * view's chunks ahead of background work's, as the store's reads are) and
 * copies the selected part straight into one output allocated up front.
 * Absent chunks are filled with the fill value (a Zarr v2 array whose
 * `fill_value` is null: its data type's default, as zarr-python reads it;
 * `dtypes.js` `defaultFill`).
 *
 * Chunks are shared between reads of one opened store:
 *
 * - a chunk being fetched or decoded for one read is not fetched again for a
 *   read that needs it at the same time (500 column reads issued together
 *   decode each chunk once);
 * - a chunk a read uses only part of is kept, decoded, in a least-recently
 *   used cache (`decodedChunkCacheBytes`), since the next read (the next
 *   column of a dense matrix) usually needs another part of it. A chunk used
 *   whole is not kept: whatever needs it next needs it whole again.
 *
 * A sharded (Zarr v3) array reads each shard's index once (cached; the
 * indexes a read needs all at once), then fetches only the inner chunks it
 * needs, every shard's in the same task once the indexes are in, neighbours
 * in one request.
 *
 * @module formats/zarr/array
 */

import { normalizeSelection, selectionSize } from '../store.js';
import { ZarrFormatError } from './errors.js';
import { decodeRaw, decodeRawField } from './dtypes.js';
import { copyBox, cStrides, decodeChunk, fillBox, ownedCopy, storageStrides, wordsOf } from './chunks.js';
import { expectedSizes } from './codecs/pipeline.js';
import { LOCAL_POLICY } from '../io/byte-source.js';
import { SharedWork, onAbort } from '../io/abort.js';
import { allocateTypedArray } from '../../data/sparse-column-index.js';

const EMPTY_SHARD_ENTRY = -1;

function abortError(signal) {
  return signal?.reason ?? new DOMException('The read was aborted.', 'AbortError');
}

/** Whether a fill needs writing into freshly allocated (zeroed) output. */
function fillIsZero(fill, form) {
  if (fill.raw !== null) return fill.raw.every(byte => byte === 0);
  if (form === 'vlen') return false;
  return fill.value === 0n || (fill.value === 0 && !Object.is(fill.value, -0));
}

/**
 * Create the array node.
 *
 * @param {Object} init
 * @param {string} init.path
 * @param {string} init.name
 * @param {Readonly<Object>} init.attrs
 * @param {ReturnType<import('./metadata.js').parseV2Array>} init.meta
 * @param {Object} init.store - The store backend
 * @param {Object} init.context - Shared by every node of the store (caches, limits, stats)
 * @param {(() => Promise<void>)|null} [init.served] - Settles once the host is
 *   known to serve this array's files, or rejects when it hides them (see
 *   `open.js`); null when there is nothing to check. A read waits for it
 *   alongside its own fetches, never before them.
 */
export function createArrayNode({ path, name, attrs, meta, store, context, served = null }) {
  const what = `The Zarr array '${path}'`;
  const { shape, chunkShape, type, fill, pipeline, sharding } = meta;
  const rank = shape.length;
  const chunkCount = chunkShape.reduce((a, b) => a * b, 1);
  const chunkStrides = storageStrides(chunkShape, pipeline.permutation);
  const form = type.form;
  const raw = form === 'bytes-string' || form === 'utf32' || form === 'opaque' || form === 'compound';
  const fillZero = fill.value === null ? true : fillIsZero(fill, form);
  const cacheId = `${path}#`;
  // A chunk stored as its values' bytes (no compressor, no filter, no
  // shard, fixed-size values) is read in part: only the bytes of the
  // elements a read needs, so a read of a few rows of a large chunk -- a
  // subsample's prefix of a store a kernel serves uncompressed, a gene's
  // first entries -- transfers those rows, not the chunk.
  const rawChunks = sharding === null && pipeline.decoders.length === 0 && pipeline.serializer.kind === 'bytes' &&
    !raw && (form === 'numeric' || form === 'bool') && typeof store.getRanges === 'function';
  /**
   * Bytes a request costs on the store's link (the merge gap it measures,
   * `formats/io/link.js`; a local store's prior otherwise): a part of a
   * chunk is read alone only when it leaves more than this unread, else the
   * whole chunk is read and kept for the reads that want the rest of it.
   */
  const requestCostBytes = () => (typeof store.mergeGapBytes === 'function' ? store.mergeGapBytes() : LOCAL_POLICY.mergeGapBytes);

  /** Allocate the output of `count` elements. */
  function allocate(count) {
    if (raw) return allocateTypedArray(Uint8Array, count * type.itemSize, what);
    if (form === 'vlen') return new Array(count);
    return allocateTypedArray(type.valueClass, count, what);
  }

  // -------------------------------------------------------------------------
  // Chunks: fetching, decoding, sharing.

  function decodeLimited(bytes, options, tally) {
    return context.decodeLimit(async () => {
      const decoded = await decodeChunk(bytes, pipeline, chunkCount, what, options.signal ?? null);
      context.stats.chunksDecoded++;
      context.stats.decodedBytes += decoded.bytes;
      tally.chunks++;
      tally.bytes += decoded.bytes;
      return decoded;
    }, options.signal, options.activity);
  }

  /**
   * The chunk `key` being produced, shared by every read asking for it from
   * now on (`SharedWorks`: it stops only once every one of them withdrew):
   * the one running, else `start(options)` begun now. It is cached when
   * any asker used only part of it (`keep`).
   */
  function shared(key, start, options, keep) {
    let work = context.inflight.get(key);
    if (work !== undefined) {
      context.stats.sharedChunks++;
      work.keep ||= keep;
      return work;
    }
    work = context.inflight.work(key, start, options);
    work.keep = keep;
    const produced = work;
    produced.promise.then(decoded => {
      if (produced.keep && decoded !== null && !context.closed) {
        const kept = ownedCopy(decoded);
        context.decoded.set(key, kept, kept.bytes);
      }
    }, () => {});
    return produced;
  }

  /** The shard index of `shardKey`: offsets and sizes, -1 for empty inner chunks; null when the shard is absent. */
  function shardIndex(shardKey, options) {
    const cacheKey = `${shardKey}#index`;
    const cached = context.indexes.get(cacheKey);
    if (cached !== undefined) return Promise.resolve(cached);
    const range = sharding.location === 'end' ? { suffix: sharding.indexBytes } : { offset: 0, length: sharding.indexBytes };
    // Shared by every read asking for it meanwhile (`SharedWorks`).
    return context.inflight.run(cacheKey, indexOptions => store.getRanges(shardKey, [range], indexOptions).then(async parts => {
      if (parts === null) return null;
      let bytes = parts[0];
      if (bytes.length !== sharding.indexBytes) throw new ZarrFormatError(`${what}: the shard '${shardKey}' is shorter than its index.`);
      const decoders = sharding.indexPipeline.decoders;
      const sizes = expectedSizes(decoders, sharding.innerCount * 16);
      for (let i = 0; i < decoders.length; i++) bytes = await decoders[i].decode(bytes, sizes[i]);
      const littleEndian = sharding.indexPipeline.type.littleEndian;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const index = allocateTypedArray(Float64Array, sharding.innerCount * 2, `${what} shard index`);
      const shardSize = store.storedSize(shardKey);
      for (let i = 0; i < index.length; i += 2) {
        const at = i * 8;
        const offsetHigh = view.getUint32(at + (littleEndian ? 4 : 0), littleEndian);
        const offsetLow = view.getUint32(at + (littleEndian ? 0 : 4), littleEndian);
        const sizeHigh = view.getUint32(at + (littleEndian ? 12 : 8), littleEndian);
        const sizeLow = view.getUint32(at + (littleEndian ? 8 : 12), littleEndian);
        if (offsetHigh === 0xffffffff && offsetLow === 0xffffffff && sizeHigh === 0xffffffff && sizeLow === 0xffffffff) {
          index[i] = EMPTY_SHARD_ENTRY;
          index[i + 1] = EMPTY_SHARD_ENTRY;
          continue;
        }
        const offset = offsetHigh * 2 ** 32 + offsetLow;
        const size = sizeHigh * 2 ** 32 + sizeLow;
        if (!Number.isSafeInteger(offset + size) || (shardSize !== null && offset + size > shardSize)) {
          throw new ZarrFormatError(`${what}: the index of shard '${shardKey}' points outside the shard.`);
        }
        index[i] = offset;
        index[i + 1] = size;
      }
      context.indexes.set(cacheKey, index, index.byteLength);
      return index;
    }), options);
  }

  /** Coordinates of the shard holding read-grid chunk `coords`, and the chunk's index inside it. */
  function placeInShard(coords) {
    const shardCoords = new Array(rank);
    let local = 0;
    for (let axis = 0; axis < rank; axis++) {
      const perShard = sharding.chunksPerShard[axis];
      shardCoords[axis] = Math.floor(coords[axis] / perShard);
      local = local * perShard + (coords[axis] - shardCoords[axis] * perShard);
    }
    return { shardKey: sharding.shardKey(shardCoords), local };
  }

  /**
   * Start getting the decoded chunks at `coordsList`: each resolves to a
   * `Decoded`, or null when the chunk is absent. All fetches are asked for
   * before any is awaited, so the backend plans them together.
   */
  function requestChunks(coordsList, keepList, options, tally, spans = null) {
    const signal = options.signal ?? null;
    const results = new Array(coordsList.length);
    const toFetch = [];
    coordsList.forEach((coords, i) => {
      const key = cacheId + coords.join(',');
      const cached = context.decoded.get(key);
      if (cached !== undefined) {
        context.stats.cacheHits++;
        results[i] = Promise.resolve({ decoded: cached, shared: true, offset: 0 });
        return;
      }
      const span = spans?.[i] ?? null;
      if (span !== null) {
        // Elements [first, first + count) of the chunk, from their bytes alone (never cached).
        const partKey = `${key}@${span.first}+${span.count}`;
        const width = type.itemSize;
        const work = shared(partKey, partOptions => store.getRanges(meta.chunkKey(coords), [{ offset: span.first * width, length: span.count * width }], partOptions)
          .then(parts => (parts === null ? null : context.decodeLimit(async () => {
            const decoded = await decodeChunk(parts[0], pipeline, span.count, what, partOptions.signal);
            tally.chunks++;
            tally.bytes += decoded.bytes;
            return decoded;
          }, partOptions.signal, partOptions.activity))), options, false);
        results[i] = work.join(signal).then(decoded => ({ decoded, shared: work.joins > 1, offset: span.first }));
        return;
      }
      if (context.inflight.has(key)) {
        const work = shared(key, null, options, keepList[i]);
        results[i] = work.join(signal).then(decoded => ({ decoded, shared: true }));
        return;
      }
      toFetch.push({ i, coords, key });
    });

    if (sharding === null) {
      for (const { i, coords, key } of toFetch) {
        const work = shared(key, chunkOptions => store.get(meta.chunkKey(coords), chunkOptions)
          .then(bytes => (bytes === null ? null : decodeLimited(bytes, chunkOptions, tally))), options, keepList[i]);
        results[i] = work.join(signal).then(decoded => ({ decoded, shared: work.joins > 1 || work.keep }));
      }
    } else {
      // Group by shard: one index read and one ranged fetch per shard. The
      // chunks of every shard are fetched as one piece of work (`batch`),
      // which each chunk's own shared work holds while any read waits for
      // that chunk: it stops once every one of them withdrew.
      const byShard = new Map();
      for (const item of toFetch) {
        const { shardKey, local } = placeInShard(item.coords);
        let group = byShard.get(shardKey);
        if (group === undefined) byShard.set(shardKey, group = []);
        item.settled = new Promise((resolve, reject) => { item.settle = { resolve, reject }; });
        item.settled.catch(() => {});
        group.push({ ...item, local });
      }
      const batch = new SharedWork(batchSignal => fetchShards([...byShard], { ...options, signal: batchSignal }, tally));
      for (const item of toFetch) {
        const work = shared(item.key, chunkOptions => {
          const leave = batch.hold();
          const stopWaiting = onAbort(chunkOptions.signal, leave);
          return item.settled.finally(stopWaiting);
        }, options, keepList[item.i]);
        results[item.i] = work.join(signal).then(decoded => ({ decoded, shared: work.joins > 1 || work.keep }));
      }
    }
    return results;
  }

  /**
   * Fetch and decode the chunks of `shards` (`[shardKey, items]`), settling
   * each item. Every shard's index is asked for at once, and the inner
   * chunks of all of them once every index is in: the inner chunk reads go
   * out in one task, which the store plans together (a ZIP's shards are
   * ranges of one file, merged as its link prices them), not shard by shard
   * as each index lands.
   */
  async function fetchShards(shards, options, tally) {
    const indexes = shards.map(([shardKey]) => shardIndex(shardKey, options));
    const fail = (group, error) => {
      for (const item of group) item.settle.reject(error);
    };
    const settled = await Promise.allSettled(indexes);
    const fetched = shards.map(([shardKey, group], s) => {
      if (settled[s].status === 'rejected') {
        fail(group, settled[s].reason);
        return null;
      }
      const index = settled[s].value;
      const present = [];
      for (const item of group) {
        if (index === null || index[item.local * 2] === EMPTY_SHARD_ENTRY) item.settle.resolve(null);
        else present.push(item);
      }
      if (present.length === 0) return null;
      return store.getRanges(shardKey, present.map(item => ({
        offset: index[item.local * 2], length: index[item.local * 2 + 1],
      })), options).then(parts => {
        if (parts === null) throw new ZarrFormatError(`${what}: the shard '${shardKey}' disappeared while it was read.`);
        present.forEach((item, k) => {
          decodeLimited(parts[k], options, tally).then(item.settle.resolve, item.settle.reject);
        });
      }).catch(error => fail(group, error));
    });
    await Promise.all(fetched);
  }

  // -------------------------------------------------------------------------
  // Selections.

  /** Every read-grid chunk the normalized selection touches, with the box it contributes. */
  function chunksOf(selection) {
    const first = selection.map(([start], axis) => Math.floor(start / chunkShape[axis]));
    const last = selection.map(([, stop], axis) => Math.floor((stop - 1) / chunkShape[axis]));
    const outStrides = cStrides(selection.map(([start, stop]) => stop - start));
    const list = [];
    const coords = first.slice();
    for (;;) {
      let srcStart = 0;
      let dstStart = 0;
      let whole = true;
      const extents = new Array(rank);
      for (let axis = 0; axis < rank; axis++) {
        const origin = coords[axis] * chunkShape[axis];
        const from = Math.max(selection[axis][0], origin);
        const to = Math.min(selection[axis][1], origin + chunkShape[axis]);
        extents[axis] = to - from;
        srcStart += (from - origin) * chunkStrides[axis];
        dstStart += (from - selection[axis][0]) * outStrides[axis];
        if (from !== origin || to !== Math.min(origin + chunkShape[axis], shape[axis])) whole = false;
      }
      list.push({ coords: coords.slice(), srcStart, dstStart, extents, whole });
      let axis = rank - 1;
      while (axis >= 0) {
        coords[axis]++;
        if (coords[axis] <= last[axis]) break;
        coords[axis] = first[axis];
        axis--;
      }
      if (axis < 0) break;
    }
    return { list, outStrides };
  }

  /** Read the selection into a fresh output (raw bytes for raw types). */
  async function assemble(selection, options) {
    if (context.closed) throw new ZarrFormatError(`${what}: the store has been closed.`);
    if (meta.unsupported) throw meta.unsupported;
    // A read cancelled before it starts fetches nothing.
    if (options.signal?.aborted) throw abortError(options.signal);
    // An absent chunk reads as the fill value, so a host that hides this
    // array's files must be caught before any value is returned.
    const hostServes = served?.() ?? null;
    hostServes?.catch(() => {});
    const extents = selection.map(([start, stop]) => stop - start);
    const count = selectionSize(selection);
    if (count === 0) return allocate(0);
    const { list, outStrides } = chunksOf(selection);
    const tally = { chunks: 0, bytes: 0 };
    const signal = options.signal ?? null;

    // One chunk that is exactly the selection, stored in C order: its
    // decoded values are the result, with no copy.
    const exact = list.length === 1 && list[0].whole && pipeline.permutation === null &&
      extents.every((extent, axis) => extent === chunkShape[axis]);

    // A chunk read in part when its bytes are its values: the run of them in
    // storage order from the box's first element to its last (a range of a
    // vector, whole rows of a C-order chunk, a range of a column-major
    // chunk's column: exactly the box's bytes; some columns of some rows of
    // a C-order chunk: those rows), when what it leaves unread costs more
    // than a request. Any other box is read with its whole chunk, kept for
    // the reads that want the rest of it (the columns of a dense strip).
    const spans = !rawChunks ? null : list.map(item => {
      if (item.whole) return null;
      let last = item.srcStart;
      for (let axis = 0; axis < rank; axis++) last += (item.extents[axis] - 1) * chunkStrides[axis];
      const count = last - item.srcStart + 1;
      return (chunkCount - count) * type.itemSize > requestCostBytes() ? { first: item.srcStart, count } : null;
    });
    const pending = requestChunks(list.map(item => item.coords), list.map(item => !item.whole), options, tally, spans);
    let output = exact ? null : allocate(count);
    const target = output === null ? null : wordsOf(output, raw ? type.itemSize : undefined);
    // Each chunk is waited for with this read's own signal (`SharedWork`):
    // a chunk another read also waits for never fails this read when that
    // read is cancelled.
    const work = pending.map((promise, k) => promise.then(({ decoded, shared, offset = 0 }) => {
      const item = list[k];
      if (decoded === null) {
        if (output === null) {
          output = allocate(count);
          if (!fillZero) fillBox(output, 0, outStrides, extents, fill.value, raw ? fill.raw : null);
        } else if (!fillZero) {
          fillBox(output, item.dstStart, outStrides, item.extents, fill.value, raw ? fill.raw : null);
        }
        return;
      }
      if (output === null) {
        // The result belongs to the caller (it may be transferred): never a
        // cached or shared chunk, never a view into a larger buffer.
        const data = decoded.data;
        const exclusive = decoded.owned && !shared &&
          (Array.isArray(data) || (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength));
        output = exclusive ? data : data.slice();
        return;
      }
      const source = wordsOf(decoded.data, raw ? type.itemSize : undefined);
      copyBox(source.words, item.srcStart - offset, chunkStrides, target.words, item.dstStart, outStrides, item.extents, target.width);
    }));
    await Promise.all(work);
    if (hostServes !== null) await hostServes;
    if (tally.chunks > 0) options.activity?.decoded?.(tally.chunks, tally.bytes);
    return output;
  }

  function scalarOrValues(values) {
    if (rank > 0) return values;
    return form === 'opaque' ? values : values[0];
  }

  async function read(selection, options = {}) {
    const normalized = normalizeSelection(shape, selection, what);
    const output = await assemble(normalized, options);
    if (!raw) return scalarOrValues(output);
    return scalarOrValues(decodeRaw(output, 0, selectionSize(normalized), type, what));
  }

  async function readField(field, selection, options = {}) {
    if (form !== 'compound') throw new TypeError(`${what} is not compound; it has no fields.`);
    const member = type.fields.find(candidate => candidate.name === field);
    if (member === undefined) throw new RangeError(`${what} has no field '${field}'.`);
    const normalized = normalizeSelection(shape, selection, what);
    const output = await assemble(normalized, options);
    const values = decodeRawField(output, selectionSize(normalized), type, member, what);
    if (rank > 0 || member.count > 1 || member.type.form === 'opaque') return values;
    return values[0];
  }

  async function storedBytes(selection, options = {}) {
    if (meta.unsupported) throw meta.unsupported;
    const normalized = normalizeSelection(shape, selection, what);
    if (selectionSize(normalized) === 0) return 0;
    const { list } = chunksOf(normalized);
    if (sharding === null) {
      let total = 0;
      for (const { coords } of list) {
        const size = store.storedSize(meta.chunkKey(coords));
        if (size === null) return null;
        total += size;
      }
      return total;
    }
    const byShard = new Map();
    for (const { coords } of list) {
      const { shardKey, local } = placeInShard(coords);
      if (!byShard.has(shardKey)) byShard.set(shardKey, []);
      byShard.get(shardKey).push(local);
    }
    // The shard indexes in hand answer exactly, and so do those of a listed
    // store (a folder, a ZIP: it knows each shard's size, and reading an
    // index costs no request). Of the others (a web host's), the first is
    // read and the rest are estimated from the indexes in hand (their inner
    // chunks' mean stored size): what a whole array of hundreds of shards
    // stores costs at most one request, not one per shard.
    const shards = [...byShard];
    const held = shard => context.indexes.get(`${shard[0]}#index`) !== undefined || store.storedSize(shard[0]) !== null;
    const missing = shards.filter(shard => !held(shard));
    const exact = missing.length <= 1 ? shards : [...shards.filter(held), missing[0]];
    let total = 0;
    let sampled = 0;
    let sampledChunks = 0;
    // The indexes are read together, not one after another.
    const indexes = await Promise.all(exact.map(([shardKey]) => shardIndex(shardKey, options)));
    for (const [s, [, locals]] of exact.entries()) {
      const index = indexes[s];
      if (index === null) continue;
      for (const local of locals) if (index[local * 2] !== EMPTY_SHARD_ENTRY) total += index[local * 2 + 1];
      for (let i = 0; i < index.length; i += 2) {
        if (index[i] === EMPTY_SHARD_ENTRY) continue;
        sampled += index[i + 1];
        sampledChunks++;
      }
    }
    if (exact.length === shards.length) return total;
    const meanChunk = sampledChunks === 0 ? 0 : sampled / sampledChunks;
    const answered = new Set(exact.map(shard => shard[0]));
    for (const [shardKey, locals] of shards) {
      if (answered.has(shardKey)) continue;
      total += Math.round(locals.length * meanChunk);
    }
    return total;
  }

  const node = {
    kind: 'array',
    path,
    name,
    attrs,
    attributeType: () => null,
    shape,
    dtype: type.dtype,
    chunks: chunkShape,
    // Rows of a chunk stored as its values' bytes in C order are read alone
    // (`formats/store.js`): a range of rows costs its own bytes.
    partialChunks: rawChunks && (rank <= 1 || pipeline.permutation === null),
    fillValue: fill.value,
    dimensionNames: meta.dimensionNames,
    zarrFormat: meta.version,
    read,
    storedBytes,
  };
  if (form === 'compound') node.readField = readField;
  return Object.freeze(node);
}
