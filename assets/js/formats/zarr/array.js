/**
 * The store contract's `ArrayNode` for one Zarr array.
 *
 * A read finds the chunks its selection intersects and asks the store for
 * all of them at once (the backend batches and parallelises them), decodes
 * each as it arrives (a few at a time, so decoded chunks do not pile up; a
 * view's chunks ahead of background work's, as the store's reads are) and
 * copies the selected part straight into one output allocated up front.
 * Absent chunks are filled with the fill value; an absent chunk of a Zarr v2
 * array whose fill value is null has undefined contents and is refused.
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
 * A sharded (Zarr v3) array reads each shard's index once (cached), then
 * fetches only the inner chunks a read needs, neighbours in one request.
 *
 * @module formats/zarr/array
 */

import { normalizeSelection, selectionSize } from '../store.js';
import { ZarrFormatError } from './errors.js';
import { decodeRaw, decodeRawField } from './dtypes.js';
import { copyBox, cStrides, decodeChunk, fillBox, ownedCopy, storageStrides, wordsOf } from './chunks.js';
import { expectedSizes } from './codecs/pipeline.js';
import { onAbort } from '../io/abort.js';

const EMPTY_SHARD_ENTRY = -1;

function abortError(signal) {
  return signal?.reason ?? new DOMException('The read was aborted.', 'AbortError');
}

/**
 * `promise`, or a rejection as soon as `signal` aborts. Once it is not waited
 * for, `promise` failing (its fetch cancelled by the same signal) is nobody's
 * failure: it never surfaces as an unhandled rejection.
 */
function untilAborted(promise, signal) {
  if (signal === null || signal === undefined) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(abortError(signal));
  }
  return new Promise((resolve, reject) => {
    const stopWaiting = onAbort(signal, () => reject(abortError(signal)));
    promise.then(
      value => { stopWaiting(); resolve(value); },
      error => { stopWaiting(); reject(error); }
    );
  });
}

function isAbort(error) {
  return error?.name === 'AbortError';
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

  /** Allocate the output of `count` elements. */
  function allocate(count) {
    if (raw) return new Uint8Array(count * type.itemSize);
    if (form === 'vlen') return new Array(count);
    return new type.valueClass(count);
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
   * Register a chunk being produced: later asks for it wait on the same
   * promise, and it is cached when any asker used only part of it.
   */
  function track(key, promise, keep) {
    const entry = { promise, keep, waiters: 1 };
    context.inflight.set(key, entry);
    promise.then(
      decoded => {
        if (context.inflight.get(key) === entry) context.inflight.delete(key);
        if (entry.keep && decoded !== null && !context.closed) {
          const kept = ownedCopy(decoded);
          context.decoded.set(key, kept, kept.bytes);
        }
      },
      () => {
        if (context.inflight.get(key) === entry) context.inflight.delete(key);
      }
    );
    return entry;
  }

  /** The shard index of `shardKey`: offsets and sizes, -1 for empty inner chunks; null when the shard is absent. */
  function shardIndex(shardKey, options) {
    const cacheKey = `${shardKey}#index`;
    const cached = context.indexes.get(cacheKey);
    if (cached !== undefined) return Promise.resolve(cached);
    const running = context.inflight.get(cacheKey);
    if (running !== undefined) return running.promise;
    const range = sharding.location === 'end' ? { suffix: sharding.indexBytes } : { offset: 0, length: sharding.indexBytes };
    const promise = store.getRanges(shardKey, [range], options).then(async parts => {
      if (parts === null) return null;
      let bytes = parts[0];
      if (bytes.length !== sharding.indexBytes) throw new ZarrFormatError(`${what}: the shard '${shardKey}' is shorter than its index.`);
      const decoders = sharding.indexPipeline.decoders;
      const sizes = expectedSizes(decoders, sharding.innerCount * 16);
      for (let i = 0; i < decoders.length; i++) bytes = await decoders[i].decode(bytes, sizes[i]);
      const littleEndian = sharding.indexPipeline.type.littleEndian;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const index = new Float64Array(sharding.innerCount * 2);
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
    });
    const entry = { promise, keep: false, waiters: 1 };
    context.inflight.set(cacheKey, entry);
    promise.finally(() => {
      if (context.inflight.get(cacheKey) === entry) context.inflight.delete(cacheKey);
    }).catch(() => {});
    return promise;
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
  function requestChunks(coordsList, keepList, options, tally) {
    const results = new Array(coordsList.length);
    const toFetch = [];
    coordsList.forEach((coords, i) => {
      const key = cacheId + coords.join(',');
      const cached = context.decoded.get(key);
      if (cached !== undefined) {
        context.stats.cacheHits++;
        results[i] = Promise.resolve({ decoded: cached, shared: true });
        return;
      }
      const running = context.inflight.get(key);
      if (running !== undefined) {
        running.waiters++;
        running.keep ||= keepList[i];
        context.stats.sharedChunks++;
        results[i] = running.promise.then(decoded => ({ decoded, shared: true }));
        return;
      }
      toFetch.push({ i, coords, key });
    });

    if (sharding === null) {
      for (const { i, coords, key } of toFetch) {
        const promise = store.get(meta.chunkKey(coords), options)
          .then(bytes => (bytes === null ? null : decodeLimited(bytes, options, tally)));
        const entry = track(key, promise, keepList[i]);
        results[i] = promise.then(decoded => ({ decoded, shared: entry.waiters > 1 || entry.keep }));
      }
    } else {
      // Group by shard: one index read and one ranged fetch per shard.
      const byShard = new Map();
      for (const item of toFetch) {
        const { shardKey, local } = placeInShard(item.coords);
        let group = byShard.get(shardKey);
        if (group === undefined) byShard.set(shardKey, group = []);
        let settle;
        const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
        promise.catch(() => {});
        const entry = track(item.key, promise, keepList[item.i]);
        group.push({ ...item, local, settle });
        results[item.i] = promise.then(decoded => ({ decoded, shared: entry.waiters > 1 || entry.keep }));
      }
      for (const [shardKey, group] of byShard) {
        (async () => {
          const index = await shardIndex(shardKey, options);
          const present = [];
          for (const item of group) {
            if (index === null || index[item.local * 2] === EMPTY_SHARD_ENTRY) item.settle.resolve(null);
            else present.push(item);
          }
          if (present.length === 0) return;
          const parts = await store.getRanges(shardKey, present.map(item => ({
            offset: index[item.local * 2], length: index[item.local * 2 + 1],
          })), options);
          if (parts === null) throw new ZarrFormatError(`${what}: the shard '${shardKey}' disappeared while it was read.`);
          present.forEach((item, k) => {
            decodeLimited(parts[k], options, tally).then(item.settle.resolve, item.settle.reject);
          });
        })().catch(error => {
          for (const item of group) item.settle.reject(error);
        });
      }
    }
    return results;
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

    const pending = requestChunks(list.map(item => item.coords), list.map(item => !item.whole), options, tally);
    let output = exact ? null : allocate(count);
    const target = output === null ? null : wordsOf(output, raw ? type.itemSize : undefined);
    const work = pending.map((promise, k) => untilAborted(promise, signal).then(({ decoded, shared }) => {
      const item = list[k];
      if (decoded === null) {
        if (fill.value === null) {
          throw new ZarrFormatError(`${what} has an absent chunk while its fill_value is null, so its contents are undefined.`);
        }
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
      copyBox(source.words, item.srcStart, chunkStrides, target.words, item.dstStart, outStrides, item.extents, target.width);
    }));
    try {
      await Promise.all(work);
    } catch (error) {
      // A shared fetch cancelled by another reader's signal is not this
      // read's failure: read again.
      if (isAbort(error) && !signal?.aborted) return assemble(selection, options);
      throw error;
    }
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
    const sums = await Promise.all([...byShard].map(async ([shardKey, locals]) => {
      const index = await shardIndex(shardKey, options);
      if (index === null) return 0;
      let sum = 0;
      for (const local of locals) if (index[local * 2] !== EMPTY_SHARD_ENTRY) sum += index[local * 2 + 1];
      return sum;
    }));
    return sums.reduce((a, b) => a + b, 0);
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
    fillValue: fill.value,
    dimensionNames: meta.dimensionNames,
    zarrFormat: meta.version,
    read,
    storedBytes,
  };
  if (form === 'compound') node.readField = readField;
  return Object.freeze(node);
}
