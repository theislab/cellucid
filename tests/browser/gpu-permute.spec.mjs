/**
 * Stores in a draw order are gathered on the GPU (GpuPermuter): the bytes
 * written must equal a CPU gather exactly -- 1, 2 and 3 words a point
 * (colours, 1D/2D/3D positions), into a new store or in place -- at sizes
 * around the texture row width, and the pass must leave every binding it
 * touches as it found it.
 * End to end, a recolour of an ordered live store holds the recoloured bytes
 * in the live draw order, and an adopted store holds its positions in it.
 */
import { expect, test } from './helpers/test.mjs';

import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const DATASET_URL =
  `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}&dataset=current-ui-prepared`;

test('the GPU gather is byte-exact and restores GL state', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);

  const proof = await page.evaluate(async () => {
    const { GpuPermuter } = await import('/assets/js/rendering/high-perf/gpu-permute.js');
    const linear = await import('/assets/js/rendering/linear-texture.js');
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const permuter = new GpuPermuter(gl);
    let seed = 12345;
    const random = () => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed;
    };
    const results = [];
    for (const count of [1, 3, 4, 5, 7, maxSize - 1, maxSize, maxSize + 3, 70_001]) {
      const indices = new Uint32Array(count);
      for (let i = 0; i < count; i++) indices[i] = i;
      for (let i = count - 1; i > 0; i--) {
        const j = random() % (i + 1);
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
      // The permutation is a linear texture (rendering/linear-texture.js).
      const plan = linear.planLinearTextureFor(gl, count);
      const order = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, order);
      linear.allocateLinearTexture(gl, gl.R32UI, plan);
      linear.writeLinearTextureRows(gl, plan, gl.RED_INTEGER, gl.UNSIGNED_INT, indices, 1);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
      const record = { texture: order, plan };

      // State the pass must leave as it found it.
      const program = gl.createProgram();
      const vao = gl.createVertexArray();
      const sentinel = gl.createBuffer();
      const unit0 = gl.createTexture();
      const unit1 = gl.createTexture();
      const array0 = gl.createTexture();
      const array1 = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, unit0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, array0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, unit1);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, array1);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, sentinel);

      const store = (bytes, data = null) => {
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        if (data === null) gl.bufferData(gl.ARRAY_BUFFER, bytes, gl.DYNAMIC_DRAW);
        else gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, sentinel);
        return buffer;
      };
      // 1-3 words a point: into a new store, and in place over the source
      // order the store held (what an adoption does).
      const words = {};
      const created = [];
      for (const wordsPerPoint of [1, 2, 3]) {
        const array = new Uint32Array(count * wordsPerPoint);
        for (let i = 0; i < array.length; i++) array[i] = random();
        const fresh = store(count * wordsPerPoint * 4);
        permuter.writeWords(fresh, array, record, wordsPerPoint);
        const inPlace = store(0, array);
        permuter.writeWords(inPlace, array, record, wordsPerPoint);
        words[wordsPerPoint] = { array, fresh, inPlace };
        created.push(fresh, inPlace);
      }

      const restored = gl.getParameter(gl.ARRAY_BUFFER_BINDING) === sentinel
        && gl.getParameter(gl.VERTEX_ARRAY_BINDING) === vao
        && gl.getParameter(gl.CURRENT_PROGRAM) === null
        && gl.getParameter(gl.ACTIVE_TEXTURE) === gl.TEXTURE3
        && gl.getParameter(gl.TRANSFORM_FEEDBACK_BINDING) === null
        && gl.isEnabled(gl.RASTERIZER_DISCARD) === false
        && (() => {
          gl.activeTexture(gl.TEXTURE0);
          const zero = gl.getParameter(gl.TEXTURE_BINDING_2D) === unit0
            && gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY) === array0;
          gl.activeTexture(gl.TEXTURE1);
          const one = gl.getParameter(gl.TEXTURE_BINDING_2D) === unit1
            && gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY) === array1;
          gl.activeTexture(gl.TEXTURE3);
          return zero && one;
        })();

      gl.bindVertexArray(null);
      const read = (buffer, bytes) => {
        const out = new Uint8Array(bytes);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.getBufferSubData(gl.ARRAY_BUFFER, 0, out);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        return out;
      };
      let rgbaMismatch = 0;
      for (const wordsPerPoint of [1, 2, 3]) {
        const { array, fresh, inPlace } = words[wordsPerPoint];
        for (const buffer of [fresh, inPlace]) {
          const got = new Uint32Array(read(buffer, count * wordsPerPoint * 4).buffer);
          for (let slot = 0; slot < count; slot++) {
            for (let word = 0; word < wordsPerPoint; word++) {
              if (got[slot * wordsPerPoint + word] !== array[indices[slot] * wordsPerPoint + word]) rgbaMismatch++;
            }
          }
        }
      }
      results.push({
        count,
        rgbaMismatch,
        restored,
        error: gl.getError(),
      });
      for (const buffer of [...created, sentinel]) gl.deleteBuffer(buffer);
      for (const texture of [order, unit0, unit1, array0, array1]) gl.deleteTexture(texture);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
    }
    permuter.dispose();
    return results;
  });

  for (const row of proof) {
    expect(row, `count ${row.count}`).toEqual({
      count: row.count,
      rgbaMismatch: 0,
      restored: true,
      error: 0,
    });
  }
  expect(pageErrors).toEqual([]);
});

test('a recolour of an ordered live store holds the new colours in draw order', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI prepared fixture');

  const proof = await page.evaluate(async () => {
    const viewer = window._cellucidViewer;
    const renderer = viewer.getHPRenderer();
    const gl = viewer.getGLContext();
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    viewer.setAdaptiveLOD(true);
    for (let i = 0; i < 240 && renderer._liveOrder === null; i++) {
      await frame();
    }
    const record = renderer._liveOrder;
    if (record === null) return { ordered: false };
    const count = renderer.pointCount;
    // The adopted store holds the positions, bit for bit, in the draw order.
    const dimension = renderer.currentDimensionLevel;
    const storedPositions = new Uint32Array(count * dimension);
    gl.bindBuffer(gl.ARRAY_BUFFER, renderer.buffers.positions);
    gl.getBufferSubData(gl.ARRAY_BUFFER, 0, storedPositions);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    const sourcePositions = new Uint32Array(renderer._positions.buffer, renderer._positions.byteOffset, count * dimension);
    let positionMismatches = 0;
    for (let slot = 0; slot < count; slot++) {
      for (let axis = 0; axis < dimension; axis++) {
        if (storedPositions[slot * dimension + axis] !== sourcePositions[record.drawOrder.indices[slot] * dimension + axis]) positionMismatches++;
      }
    }
    const colors = new Uint8Array(count * 4);
    for (let i = 0; i < colors.length; i++) colors[i] = (i * 2654435761) >>> 24;
    renderer.updateColors(colors);
    renderer.flushBufferUpdates(renderer.currentDimensionLevel);
    const stored = new Uint8Array(count * 4);
    gl.bindBuffer(gl.ARRAY_BUFFER, renderer.buffers.colors);
    gl.getBufferSubData(gl.ARRAY_BUFFER, 0, stored);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    const indices = record.drawOrder.indices;
    let mismatches = 0;
    for (let slot = 0; slot < count; slot++) {
      for (let c = 0; c < 4; c++) {
        if (stored[slot * 4 + c] !== colors[indices[slot] * 4 + c]) mismatches++;
      }
    }
    return { ordered: true, count, mismatches, positionMismatches, error: gl.getError() };
  });

  expect(proof.ordered).toBe(true);
  expect(proof.mismatches).toBe(0);
  expect(proof.positionMismatches).toBe(0);
  expect(proof.error).toBe(0);
  expect(proof.count).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);
});
