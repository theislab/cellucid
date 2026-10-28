/**
 * The GPU gather (`rendering/high-perf/gpu-permute.js`) writes a segmented
 * store again and again, and a failed pass is never silent.
 *
 * A gather of more points than one chunk reads each target range's current
 * words through attribute 1 of its own vertex array. That attribute used to
 * be let go of by pointing it at no buffer, which Chromium never sends to its
 * GPU process: the vertex array kept the last range read (the store's last
 * segment), so the next gather writing that segment with the vertex array
 * bound drew INVALID_OPERATION ("A transform feedback buffer that would be
 * written to is also bound to a non-transform-feedback target") and wrote
 * nothing. A kept view's recolour above one segment (16.7M cells) failed that
 * way. This runs the call sequence that hit it -- a store gathered, drawn
 * through its vertex arrays, gathered again, positions gathered in place from
 * the GPU -- with every write read back against the CPU gather, and checks
 * that a pass that does fail throws an error naming its call and segment.
 */
import { expect, test } from './helpers/test.mjs';

const HARNESS_URL = '/tests/browser/fixtures/webgl-harness.html';

test('a segmented store is gathered again and again, bit for bit, with no WebGL error', async ({ page }) => {
  await page.goto(HARNESS_URL);
  const result = await page.evaluate(async () => {
    const { GpuPermuter } = await import('/assets/js/rendering/high-perf/gpu-permute.js');
    const { PointStore, SegmentedVertexArray } = await import('/assets/js/rendering/high-perf/point-store-segments.js');
    const linear = await import('/assets/js/rendering/linear-texture.js');
    const gl = document.createElement('canvas').getContext('webgl2');
    const count = 60_000;
    const segmentPoints = 4_096;
    const allocate = (_refusal, run) => run();
    const positions = new PointStore(gl, segmentPoints);
    positions.allocate(count, 8, gl.STATIC_DRAW, allocate, 'positions');
    const colors = new PointStore(gl, segmentPoints);
    colors.allocate(count, 4, gl.STATIC_DRAW, allocate, 'colours');
    // Slot s holds source point order[s]: a scrambled permutation.
    const order = new Uint32Array(count);
    for (let slot = 0; slot < count; slot++) order[slot] = (slot * 7_919) % count;
    const plan = linear.planLinearTextureFor(gl, count);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    linear.allocateLinearTexture(gl, gl.R32UI, plan);
    linear.writeLinearTextureRows(gl, plan, gl.RED_INTEGER, gl.UNSIGNED_INT, order, 1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    const record = { texture, plan };
    // Chunks of one segment: every gather above one segment reads back
    // through `a_prev` and the scratch store.
    const permuter = new GpuPermuter(gl, null, { chunkPoints: segmentPoints });
    const wordsOf = (seed, wordsPerPoint) => {
      const words = new Uint32Array(count * wordsPerPoint);
      for (let index = 0; index < words.length; index++) words[index] = (Math.imul(index + 1, seed) ^ (index >>> 3)) >>> 0;
      return words;
    };
    const firstDifference = (store, source, wordsPerPoint) => {
      const got = store.read(new Uint32Array(count * wordsPerPoint));
      for (let slot = 0; slot < count; slot++) {
        for (let word = 0; word < wordsPerPoint; word++) {
          if (got[slot * wordsPerPoint + word] !== source[order[slot] * wordsPerPoint + word]) return slot;
        }
      }
      return -1;
    };
    const steps = [];
    const step = (name, run, store, source, wordsPerPoint) => {
      let error = null;
      try {
        run();
      } catch (thrown) {
        error = thrown.message;
      }
      steps.push({ name, error, glError: gl.getError(), difference: firstDifference(store, source, wordsPerPoint) });
    };
    const first = wordsOf(2_654_435_761, 1);
    step('colours gathered', () => permuter.writeWords(colors, first, record, 1), colors, first, 1);
    // A kept view's vertex arrays, drawn once, then its recolour in place.
    const vao = new SegmentedVertexArray(gl);
    vao.setStores(positions, colors, 2);
    const recolour = wordsOf(40_503, 1);
    step('colours gathered again (recolour)', () => permuter.writeWords(colors, recolour, record, 1), colors, recolour, 1);
    const third = wordsOf(97, 1);
    step('colours gathered a third time', () => permuter.writeWords(colors, third, record, 1), colors, third, 1);
    // Positions in source order on the GPU, gathered in place: the source is
    // drawn from the store itself (`_drawSource`), then written back over it.
    const sourceOrder = wordsOf(31, 2);
    positions.write(sourceOrder);
    step('positions gathered in place from the GPU', () => permuter.writeWords(
      positions, { buffer: positions, words: count * 2, page: sourceOrder }, record, 2
    ), positions, sourceOrder, 2);
    const last = wordsOf(12_345, 1);
    step('colours gathered after the in-place gather', () => permuter.writeWords(colors, last, record, 1), colors, last, 1);
    // The kept view lets go of its colours, which are deleted.
    vao.setColors(null);
    colors.delete();
    const fresh = new PointStore(gl, segmentPoints);
    fresh.allocate(count, 4, gl.STATIC_DRAW, allocate, 'colours');
    step('a new store gathered', () => permuter.writeWords(fresh, first, record, 1), fresh, first, 1);
    return { segments: positions.segments.length, steps };
  });
  expect(result.segments).toBe(15);
  for (const step of result.steps) {
    expect(step, step.name).toEqual({ name: step.name, error: null, glError: 0, difference: -1 });
  }
});

test('a gather pass that fails throws an error naming its call and segment', async ({ page }) => {
  await page.goto(HARNESS_URL);
  const result = await page.evaluate(async () => {
    const { GpuPermuter } = await import('/assets/js/rendering/high-perf/gpu-permute.js');
    const { PointStore } = await import('/assets/js/rendering/high-perf/point-store-segments.js');
    const linear = await import('/assets/js/rendering/linear-texture.js');
    const gl = document.createElement('canvas').getContext('webgl2');
    const count = 10_000;
    const segmentPoints = 4_096;
    const allocate = (_refusal, run) => run();
    const colors = new PointStore(gl, segmentPoints);
    colors.allocate(count, 4, gl.STATIC_DRAW, allocate, 'colours');
    const order = new Uint32Array(count).map((_, slot) => count - 1 - slot);
    const plan = linear.planLinearTextureFor(gl, count);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    linear.allocateLinearTexture(gl, gl.R32UI, plan);
    linear.writeLinearTextureRows(gl, plan, gl.RED_INTEGER, gl.UNSIGNED_INT, order, 1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    const record = { texture, plan };
    const words = new Uint32Array(count).map((_, index) => index * 3 + 1);
    const outcome = run => {
      try {
        run();
        return null;
      } catch (error) {
        return error.message;
      }
    };
    const results = {};
    for (const chunkPoints of [segmentPoints, count]) {
      const permuter = new GpuPermuter(gl, null, { chunkPoints });
      // The last segment also bound as a uniform buffer: WebGL refuses a
      // transform-feedback draw into a buffer bound anywhere else.
      gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, colors.segments[2].buffer);
      const refused = outcome(() => permuter.writeWords(colors, words, record, 1));
      gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, null);
      const queueAfterRefusal = gl.getError();
      const retried = outcome(() => permuter.writeWords(colors, words, record, 1));
      const got = colors.read(new Uint32Array(count));
      // An error some earlier call left pending is named as that.
      gl.bindBuffer(0x1234, null);
      const pending = outcome(() => permuter.writeWords(colors, words, record, 1));
      results[chunkPoints] = {
        refused,
        queueAfterRefusal,
        retried,
        retriedExact: got.every((word, slot) => word === words[order[slot]]),
        pending,
        queue: gl.getError(),
      };
    }
    return results;
  });
  for (const [chunkPoints, outcome] of Object.entries(result)) {
    expect(outcome.refused, `chunks of ${chunkPoints}`).toMatch(
      /^GPU permute write of 10,000 points \(1 word a point\): (beginTransformFeedback|drawArrays) in the w1 pass writing slots \[8192, 10000\) \(segment 3, bytes 0-7232\) raised WebGL error 0x502 \(INVALID_OPERATION\)\.$/
    );
    expect(outcome.queueAfterRefusal, `chunks of ${chunkPoints}`).toBe(0);
    expect(outcome.retried, `chunks of ${chunkPoints}`).toBeNull();
    expect(outcome.retriedExact, `chunks of ${chunkPoints}`).toBe(true);
    expect(outcome.pending, `chunks of ${chunkPoints}`).toMatch(
      /raised WebGL error 0x500 \(INVALID_ENUM\), and run again with every call checked none raised it: an earlier call left it pending\.$/
    );
    expect(outcome.queue, `chunks of ${chunkPoints}`).toBe(0);
  }
});

test('a deferred check waits for nothing, and reports a failed pass in a later frame naming its call', async ({ page }) => {
  await page.goto(HARNESS_URL);
  const result = await page.evaluate(async () => {
    const { GpuPermuter } = await import('/assets/js/rendering/high-perf/gpu-permute.js');
    const { PointStore } = await import('/assets/js/rendering/high-perf/point-store-segments.js');
    const linear = await import('/assets/js/rendering/linear-texture.js');
    const gl = document.createElement('canvas').getContext('webgl2');
    const count = 10_000;
    const segmentPoints = 4_096;
    const allocate = (_refusal, run) => run();
    const store = new PointStore(gl, segmentPoints);
    store.allocate(count, 4, gl.STATIC_DRAW, allocate, 'words');
    const linearTexture = (format, type, data) => {
      const plan = linear.planLinearTextureFor(gl, data.length);
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
      linear.allocateLinearTexture(gl, format, plan);
      linear.writeLinearTextureRows(gl, plan, gl.RED_INTEGER, type, data, 1);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
      return { texture, plan };
    };
    const order = linearTexture(gl.R32UI, gl.UNSIGNED_INT, new Uint32Array(count).map((_, slot) => count - 1 - slot));
    const highlight = linearTexture(gl.R8UI, gl.UNSIGNED_BYTE, new Uint8Array(count).map((_, cell) => (cell % 3 === 0 ? 200 : 0)));
    const visible = linearTexture(gl.R8UI, gl.UNSIGNED_BYTE, new Uint8Array(count).fill(1));
    const permuter = new GpuPermuter(gl, null, { chunkPoints: segmentPoints });
    const frames = n => new Promise(resolve => {
      const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    });
    // Every error read the writes make themselves.
    const getError = gl.getError.bind(gl);
    let reads = 0;
    gl.getError = () => {
      reads++;
      return getError();
    };
    const errors = [];
    const onError = error => errors.push(error.message);
    const write = () => permuter.writeHighlightWords(store, count, order, highlight, visible, 1, { onError });
    const expected = slot => ((count - 1 - slot) % 3 === 0 ? 0xc8ffffff : 0);

    reads = 0;
    write();
    const readsByCleanWrite = reads;
    await frames(10);
    const cleanErrors = errors.splice(0);
    const words = store.read(new Uint32Array(count));
    const cleanExact = words.every((word, slot) => word === expected(slot));

    // The last segment also bound as a uniform buffer: the pass writing it fails.
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, store.segments[2].buffer);
    reads = 0;
    write();
    const readsByFailedWrite = reads;
    const errorsRightAfter = errors.length;
    for (let frame = 0; frame < 120 && errors.length === 0; frame++) await frames(1);
    const deferred = errors.splice(0);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, null);

    // A band of a draw order (one chunk), checked later, failing the same way.
    const source = new Uint32Array(count).map((_, index) => index + 7);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, store.segments[0].buffer);
    permuter.writeWordsRange(store, 0, segmentPoints, source.subarray(0, segmentPoints), order, 1, { onError });
    for (let frame = 0; frame < 120 && errors.length === 0; frame++) await frames(1);
    const band = errors.splice(0);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, null);

    // A synchronous write that reads a deferred batch's error before its
    // check hands it to that batch, and succeeds itself.
    const other = new PointStore(gl, segmentPoints);
    other.allocate(count, 4, gl.STATIC_DRAW, allocate, 'other');
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, store.segments[2].buffer);
    write();
    let syncError = null;
    try {
      permuter.writeWords(other, source, order, 1);
    } catch (error) {
      syncError = error.message;
    }
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, null);
    const claimed = errors.splice(0);
    await frames(10);
    return {
      readsByCleanWrite, cleanErrors, cleanExact,
      readsByFailedWrite, errorsRightAfter, deferred,
      band,
      syncError, claimed, late: errors, queue: getError(),
    };
  });
  // A deferred write reads no error itself.
  expect(result.readsByCleanWrite).toBe(0);
  expect(result.cleanErrors).toEqual([]);
  expect(result.cleanExact).toBe(true);
  expect(result.readsByFailedWrite).toBe(0);
  expect(result.errorsRightAfter).toBe(0);
  expect(result.deferred).toHaveLength(1);
  expect(result.deferred[0]).toMatch(
    /^GPU highlight words of 10,000 slots: (beginTransformFeedback|drawArrays) in the highlight pass writing slots \[8192, 10000\) \(segment 3, bytes 0-7232\) raised WebGL error 0x502 \(INVALID_OPERATION\)\. \(found by a deferred check after GPU highlight words of 10,000 slots\)\.$/
  );
  expect(result.band).toHaveLength(1);
  expect(result.band[0]).toMatch(
    /^GPU permute write of slots \[0, 4096\) \(1 word a point\): (beginTransformFeedback|drawArrays) in the w1 pass writing slots \[0, 4096\) \(segment 1, bytes 0-16384\) raised WebGL error 0x502 \(INVALID_OPERATION\)\. \(found by a deferred check after GPU permute write of slots \[0, 4096\) \(1 word a point\)\)\.$/
  );
  expect(result.syncError).toBeNull();
  expect(result.claimed).toHaveLength(1);
  expect(result.claimed[0]).toMatch(/^GPU highlight words of 10,000 slots: .* \(found by a deferred check after GPU highlight words of 10,000 slots\)\.$/);
  expect(result.late).toEqual([]);
  expect(result.queue).toBe(0);
});
