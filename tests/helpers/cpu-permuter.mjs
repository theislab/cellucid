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
  const write = (target, view) => {
    gl.bindBuffer(gl.ARRAY_BUFFER, target);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, view, 0, view.length);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  };
  const requireOrder = order => {
    if (!order?.texture) {
      throw new Error('GPU permute needs a live draw-order record (permutation texture and width).');
    }
  };
  const storeWords = (buffer, words) => {
    // A fake that keeps no store contents has nothing to read back: its
    // words are never compared.
    const bytes = gl._state?.stores?.get(buffer) ?? new Uint8Array(words * 4);
    return new Uint32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + words * 4));
  };
  const sourceOf = (order, slot) => (order === null ? slot : order.drawOrder.indices[slot]);
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
      write(target, out);
    },
    // Nothing to compile on the CPU.
    prewarm() {},
    dispose() {},
    abandon() {},
  };
  return permuter;
}
