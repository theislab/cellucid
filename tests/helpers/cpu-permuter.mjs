import { PointStore } from '../../assets/js/rendering/high-perf/point-store-segments.js';

/**
 * Stands in for `GpuPermuter` (assets/js/rendering/high-perf/gpu-permute.js)
 * on a fake WebGL context, which cannot run a transform-feedback pass: it
 * writes the exact bytes the GPU pass writes, through the fake's
 * `bufferSubData`, so store contents stay checkable. A source in a store is
 * read from the fake's copy of that store, as the GPU copies it.
 *
 * @param {object} gl - The fake context.
 */
export function createCpuPermuter(gl) {
  // A target is a segmented store (`point-store-segments.js`) or one buffer;
  // each segment takes its run of words.
  const segmentsOf = (target, points) => (target instanceof PointStore
    ? target.segments
    : [{ buffer: target, first: 0, count: points }]);
  const write = (target, view, wordsPerPoint) => {
    for (const segment of segmentsOf(target, view.length / wordsPerPoint)) {
      gl.bindBuffer(gl.ARRAY_BUFFER, segment.buffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, view, segment.first * wordsPerPoint, segment.count * wordsPerPoint);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
  };
  const requireOrder = order => {
    if (!order?.texture) {
      throw new Error('GPU permute needs a live draw-order record (permutation texture and width).');
    }
  };
  const bufferWords = (buffer, words) => {
    // A fake that keeps no store contents has nothing to read back: its
    // words are never compared.
    const bytes = gl._state?.stores?.get(buffer) ?? new Uint8Array(words * 4);
    return new Uint32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + words * 4));
  };
  const storeWords = (store, words) => {
    if (!(store instanceof PointStore)) return bufferWords(store, words);
    const out = new Uint32Array(words);
    const wordsPerPoint = words / store.pointCount;
    for (const segment of store.segments) {
      out.set(bufferWords(segment.buffer, segment.count * wordsPerPoint), segment.first * wordsPerPoint);
    }
    return out;
  };
  // A store order (`store-order.js`) maps the slots below its
  // `orderedSlots`; every later slot holds its own point.
  const sourceOf = (order, slot) => (order === null ? slot : order.sourceOf(slot));
  const permuter = {
    /** Writes by words a point: 1 (colours, 1D positions), 2, 3. */
    wordWrites: { 1: 0, 2: 0, 3: 0 },
    writeWords(target, source, order, wordsPerPoint) {
      requireOrder(order);
      // Source words in page memory, or the first `words` words of a store
      // (the store itself for a gather in place), read as they are now.
      const array = ArrayBuffer.isView(source)
        ? source
        : storeWords(source.buffer, source.words);
      const count = array.length / wordsPerPoint;
      const out = new Uint32Array(array.length);
      for (let slot = 0; slot < count; slot++) {
        const from = sourceOf(order, slot) * wordsPerPoint;
        for (let word = 0; word < wordsPerPoint; word++) out[slot * wordsPerPoint + word] = array[from + word];
      }
      permuter.wordWrites[wordsPerPoint] += 1;
      write(target, out, wordsPerPoint);
    },
    /** Slots `[first, end)` only, from the words of points `[first, end)`. */
    writeWordsRange(target, first, end, source, order, wordsPerPoint) {
      requireOrder(order);
      const points = target instanceof PointStore ? target.pointCount : null;
      const current = storeWords(target, (points ?? end) * wordsPerPoint);
      // A source in the store itself: the band's words as the store holds
      // them before the pass (as the GPU copies them first).
      if (!ArrayBuffer.isView(source)) {
        const held = source.buffer === target ? current : storeWords(source.buffer, (points ?? end) * wordsPerPoint);
        source = held.slice(first * wordsPerPoint, end * wordsPerPoint);
      }
      for (let slot = first; slot < end; slot++) {
        const from = (sourceOf(order, slot) - first) * wordsPerPoint;
        if (from < 0 || from >= source.length) throw new RangeError(`slot ${slot} reads outside its band`);
        for (let word = 0; word < wordsPerPoint; word++) current[slot * wordsPerPoint + word] = source[from + word];
      }
      permuter.rangeWrites = (permuter.rangeWrites ?? 0) + 1;
      write(target, current, wordsPerPoint);
    },
    // A held source texture is a GPU allocation; nothing to hold on the CPU.
    holdRangeSource() {},
    releaseRangeSource() {},
    // Nothing to compile on the CPU.
    prewarm() {},
    dispose() {},
    abandon() {},
  };
  return permuter;
}
