/**
 * Stands in for `GpuPermuter` (assets/js/rendering/high-perf/gpu-permute.js)
 * on a fake WebGL context, which cannot run a transform-feedback pass: it
 * writes the exact bytes the GPU pass writes, through the fake's
 * `bufferSubData`, so store contents stay checkable.
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
  const sourceOf = (order, slot) => (order === null ? slot : order.drawOrder.indices[slot]);
  const permuter = {
    /** Writes by words a point: 1 (colours, 1D positions), 2, 3. */
    wordWrites: { 1: 0, 2: 0, 3: 0 },
    writeWords(target, array, order, wordsPerPoint) {
      requireOrder(order);
      const count = array.length / wordsPerPoint;
      const out = new Uint32Array(array.length);
      for (let slot = 0; slot < count; slot++) {
        const from = sourceOf(order, slot) * wordsPerPoint;
        for (let word = 0; word < wordsPerPoint; word++) out[slot * wordsPerPoint + word] = array[from + word];
      }
      permuter.wordWrites[wordsPerPoint] += 1;
      write(target, out);
    },
    dispose() {},
    abandon() {},
  };
  return permuter;
}
