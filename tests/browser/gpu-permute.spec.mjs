/**
 * Stores in a draw order are gathered on the GPU (GpuPermuter): the bytes
 * written must equal a CPU gather exactly -- 1, 2 and 3 words a point
 * (colours, 1D/2D/3D positions), into a new store, in place from page
 * memory, or in place from the store itself (its words drawn into the
 * source texture on the GPU) -- at sizes around the texture row width, and
 * the pass must leave every binding and state it touches as it found it.
 * The highlight colour words of a store's slots are the CPU's.
 * End to end, a recolour of an ordered live store holds the recoloured bytes
 * in the live draw order, and an adopted store holds its positions in it.
 */
import { expect, test } from './helpers/test.mjs';

import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui`;

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
      // A complete framebuffer of the caller's, bound across the pass.
      const framebuffer = gl.createFramebuffer();
      const colour = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, colour);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, 64, 64);
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, colour);
      gl.viewport(3, 4, 50, 60);
      gl.enable(gl.SCISSOR_TEST);
      gl.enable(gl.BLEND);
      gl.colorMask(true, false, true, false);

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
        const fromStore = store(0, array);
        permuter.writeWords(fromStore, { buffer: fromStore, words: array.length }, record, wordsPerPoint);
        words[wordsPerPoint] = { array, fresh, inPlace, fromStore };
        created.push(fresh, inPlace, fromStore);
      }

      const restored = gl.getParameter(gl.ARRAY_BUFFER_BINDING) === sentinel
        && gl.getParameter(gl.VERTEX_ARRAY_BINDING) === vao
        && gl.getParameter(gl.CURRENT_PROGRAM) === null
        && gl.getParameter(gl.ACTIVE_TEXTURE) === gl.TEXTURE3
        && gl.getParameter(gl.TRANSFORM_FEEDBACK_BINDING) === null
        && gl.isEnabled(gl.RASTERIZER_DISCARD) === false
        && gl.getParameter(gl.FRAMEBUFFER_BINDING) === framebuffer
        && Array.from(gl.getParameter(gl.VIEWPORT)).join() === '3,4,50,60'
        && gl.isEnabled(gl.SCISSOR_TEST) && gl.isEnabled(gl.BLEND)
        && gl.getParameter(gl.COLOR_WRITEMASK).join() === 'true,false,true,false'
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
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(framebuffer);
      gl.deleteRenderbuffer(colour);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.BLEND);
      gl.colorMask(true, true, true, true);
      const read = (buffer, bytes) => {
        const out = new Uint8Array(bytes);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.getBufferSubData(gl.ARRAY_BUFFER, 0, out);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        return out;
      };
      let rgbaMismatch = 0;
      for (const wordsPerPoint of [1, 2, 3]) {
        const { array, fresh, inPlace, fromStore } = words[wordsPerPoint];
        for (const buffer of [fresh, inPlace, fromStore]) {
          const got = new Uint32Array(read(buffer, count * wordsPerPoint * 4).buffer);
          for (let slot = 0; slot < count; slot++) {
            for (let word = 0; word < wordsPerPoint; word++) {
              if (got[slot * wordsPerPoint + word] !== array[indices[slot] * wordsPerPoint + word]) rgbaMismatch++;
            }
          }
        }
      }
      // Highlight words of every slot: bytes a point (intensity, shown),
      // the word the CPU packs for an admitted cell, 0 for any other.
      const byteTexture = bytes => {
        const texture = gl.createTexture();
        const bytePlan = linear.planLinearTextureFor(gl, count);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
        linear.allocateLinearTexture(gl, gl.R8UI, bytePlan);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        linear.writeLinearTextureRows(gl, bytePlan, gl.RED_INTEGER, gl.UNSIGNED_BYTE, bytes, 1);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
        return { texture, plan: bytePlan };
      };
      const intensity = new Uint8Array(count);
      const shown = new Uint8Array(count);
      for (let i = 0; i < count; i++) {
        intensity[i] = [0, 2, 3, 128, 255][random() % 5];
        shown[i] = random() % 3 === 0 ? 0 : 1;
      }
      const highlightTexture = byteTexture(intensity);
      const shownTexture = byteTexture(shown);
      const highlightWords = store(count * 4);
      permuter.writeHighlightWords(highlightWords, count, record, highlightTexture, shownTexture, 3);
      const gotWords = new Uint32Array(read(highlightWords, count * 4).buffer);
      let highlightMismatch = 0;
      for (let slot = 0; slot < count; slot++) {
        const i = indices[slot];
        const expected = intensity[i] >= 3 && shown[i] === 1 ? (0x00ffffff | (intensity[i] << 24)) >>> 0 : 0;
        if (gotWords[slot] !== expected) highlightMismatch++;
      }
      gl.deleteBuffer(highlightWords);
      gl.deleteTexture(highlightTexture.texture);
      gl.deleteTexture(shownTexture.texture);
      results.push({
        count,
        rgbaMismatch,
        highlightMismatch,
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
      highlightMismatch: 0,
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
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');

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
    // Every segment of a segmented store (point-store-segments.js), read
    // with the GL calls themselves: the renderer facade hands out its stores
    // read-only, so none of their methods is called through it.
    const readStore = (store, out) => {
      const segments = store.segments;
      const elements = store.bytesPerPoint / out.BYTES_PER_ELEMENT;
      for (let index = 0; index < segments.length; index++) {
        const segment = segments[index];
        gl.bindBuffer(gl.ARRAY_BUFFER, segment.buffer);
        gl.getBufferSubData(gl.ARRAY_BUFFER, 0, out, segment.first * elements, segment.count * elements);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      return out;
    };
    const storedPositions = readStore(renderer.buffers.positions, new Uint32Array(count * dimension));
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
    const stored = readStore(renderer.buffers.colors, new Uint8Array(count * 4));
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

test('a gather above one chunk is byte-exact, from page memory a chunk at a time, into one buffer or segments', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);

  const proof = await page.evaluate(async () => {
    const { GpuPermuter } = await import('/assets/js/rendering/high-perf/gpu-permute.js');
    const { planStoreSegments } = await import('/assets/js/rendering/high-perf/point-store-segments.js');
    const linear = await import('/assets/js/rendering/linear-texture.js');
    const gl = document.createElement('canvas').getContext('webgl2');
    let seed = 777;
    const random = () => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed;
    };
    const results = [];
    // Chunks of 1000 points: 70,001 points take 71 source chunks x 71 target
    // ranges; segments of 4096 slots split those ranges again.
    const chunkPoints = 1000;
    const permuter = new GpuPermuter(gl, null, { chunkPoints });
    for (const count of [999, 1000, 1001, 70_001]) {
      const indices = new Uint32Array(count);
      for (let i = 0; i < count; i++) indices[i] = i;
      for (let i = count - 1; i > 0; i--) {
        const j = random() % (i + 1);
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
      const plan = linear.planLinearTextureFor(gl, count);
      const orderTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, orderTexture);
      linear.allocateLinearTexture(gl, gl.R32UI, plan);
      linear.writeLinearTextureRows(gl, plan, gl.RED_INTEGER, gl.UNSIGNED_INT, indices, 1);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
      const record = { texture: orderTexture, plan };
      const buffer = (bytes, data = null) => {
        const handle = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, handle);
        gl.bufferData(gl.ARRAY_BUFFER, data ?? bytes, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        return handle;
      };
      const read = (handle, words) => {
        const out = new Uint32Array(words);
        gl.bindBuffer(gl.ARRAY_BUFFER, handle);
        gl.getBufferSubData(gl.ARRAY_BUFFER, 0, out);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        return out;
      };
      let mismatches = 0;
      let refusedWithoutPage = count <= chunkPoints;
      for (const wordsPerPoint of [1, 2, 3]) {
        const array = new Uint32Array(count * wordsPerPoint);
        for (let i = 0; i < array.length; i++) array[i] = random();
        const expected = new Uint32Array(array.length);
        for (let slot = 0; slot < count; slot++) {
          for (let word = 0; word < wordsPerPoint; word++) {
            expected[slot * wordsPerPoint + word] = array[indices[slot] * wordsPerPoint + word];
          }
        }
        // One buffer: from page memory, and in place over its source order.
        const fresh = buffer(count * wordsPerPoint * 4);
        permuter.writeWords(fresh, array, record, wordsPerPoint);
        const inPlace = buffer(0, array);
        permuter.writeWords(inPlace, { buffer: inPlace, words: array.length, page: array }, record, wordsPerPoint);
        // Segments of 4096 slots, from page memory and in place.
        const segments = planStoreSegments(count, 4096).map(segment => ({
          ...segment,
          buffer: buffer(0, array.subarray(segment.first * wordsPerPoint, (segment.first + segment.count) * wordsPerPoint)),
        }));
        permuter.writeWords(segments, { buffer: segments, words: array.length, page: array }, record, wordsPerPoint);
        const segmentWords = new Uint32Array(array.length);
        for (const segment of segments) {
          segmentWords.set(read(segment.buffer, segment.count * wordsPerPoint), segment.first * wordsPerPoint);
        }
        for (const got of [read(fresh, array.length), read(inPlace, array.length), segmentWords]) {
          for (let i = 0; i < got.length; i++) if (got[i] !== expected[i]) mismatches++;
        }
        if (count > chunkPoints) {
          try {
            permuter.writeWords(fresh, { buffer: fresh, words: array.length }, record, wordsPerPoint);
          } catch (error) {
            refusedWithoutPage = /page memory/.test(error.message);
          }
        }
        for (const handle of [fresh, inPlace, ...segments.map(segment => segment.buffer)]) gl.deleteBuffer(handle);
      }
      // Highlight words into segments: slot s holds point order[s].
      const byteTexture = bytes => {
        const texture = gl.createTexture();
        const bytePlan = linear.planLinearTextureFor(gl, count);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
        linear.allocateLinearTexture(gl, gl.R8UI, bytePlan);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        linear.writeLinearTextureRows(gl, bytePlan, gl.RED_INTEGER, gl.UNSIGNED_BYTE, bytes, 1);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
        return { texture, plan: bytePlan };
      };
      const intensity = new Uint8Array(count).map(() => [0, 3, 200][random() % 3]);
      const shown = new Uint8Array(count).map(() => random() % 2);
      const highlight = byteTexture(intensity);
      const visible = byteTexture(shown);
      const wordSegments = planStoreSegments(count, 4096).map(segment => ({ ...segment, buffer: buffer(segment.count * 4) }));
      permuter.writeHighlightWords(wordSegments, count, record, highlight, visible, 3);
      let highlightMismatches = 0;
      for (const segment of wordSegments) {
        const got = read(segment.buffer, segment.count);
        for (let local = 0; local < segment.count; local++) {
          const point = indices[segment.first + local];
          const want = intensity[point] >= 3 && shown[point] === 1 ? (0x00ffffff | (intensity[point] << 24)) >>> 0 : 0;
          if (got[local] !== want) highlightMismatches++;
        }
        gl.deleteBuffer(segment.buffer);
      }
      for (const texture of [orderTexture, highlight.texture, visible.texture]) gl.deleteTexture(texture);
      results.push({ count, mismatches, highlightMismatches, refusedWithoutPage, error: gl.getError() });
    }
    permuter.dispose();
    return results;
  });

  for (const row of proof) {
    expect(row, `count ${row.count}`).toEqual({
      count: row.count, mismatches: 0, highlightMismatches: 0, refusedWithoutPage: true, error: 0,
    });
  }
  expect(pageErrors).toEqual([]);
});
