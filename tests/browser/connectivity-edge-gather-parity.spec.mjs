import { expect, test } from './helpers/test.mjs';

import { pixelParityVerdict } from './helpers/pixel-parity.mjs';

/**
 * The edge layer gathers each shown edge's endpoint positions on the GPU
 * (rendering/connectivity-edge-layer.js), copying bits from a position
 * texture into the instance records the draw shader reads as attributes.
 * A frame must be the frame a CPU copy of the positions draws: on Metal, the
 * same vertex arithmetic on texture-fetched positions rasterized some 3D
 * lines differently (measured 2026-10-23), which is why the draw keeps
 * attribute inputs. This draws one 3D graph both ways, through the same
 * shader program sources, with equal cameras and frame uniforms.
 */
test('GPU-gathered edges draw exactly the pixels of CPU-gathered records', async ({ page }) => {
  await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async () => {
    // An edge payload as the reader worker builds it: the symmetric CSR of
    // the pairs (weights as given, largest 1) through its own extraction.
    const { extractConnectivityEdges } = await import('/assets/js/data/connectivity-edges.js');
    const edgePayloadOf = (sources, destinations, weights, nCells) => {
      const indptr = new Int32Array(nCells + 1);
      for (let edge = 0; edge < sources.length; edge++) {
        indptr[sources[edge] + 1]++;
        indptr[destinations[edge] + 1]++;
      }
      for (let cell = 0; cell < nCells; cell++) indptr[cell + 1] += indptr[cell];
      const fill = indptr.slice(0, nCells);
      const indices = new Int32Array(indptr[nCells]);
      const data = new Float32Array(indptr[nCells]);
      // Edges come ordered by source, so every row is written ascending.
      for (let edge = 0; edge < sources.length; edge++) {
        const s = sources[edge];
        const d = destinations[edge];
        indices[fill[d]] = s;
        data[fill[d]++] = weights[edge];
        indices[fill[s]] = d;
        data[fill[s]++] = weights[edge];
      }
      return extractConnectivityEdges({ format: 'csr', shape: [nCells, nCells], indptr, indices, data }, nCells);
    };
    const { createConnectivityEdgeLayer, CONNECTIVITY_INSTANCE_FLOATS } = await import(
      '/assets/js/rendering/connectivity-edge-layer.js'
    );
    const { createConnectivityEdgeOrder } = await import('/assets/js/rendering/connectivity-edge-selection.js');
    const { LINE_INSTANCED_FS_SOURCE, LINE_INSTANCED_VS_SOURCE } = await import(
      '/assets/js/rendering/shaders/edge-grid-shaders.js'
    );
    const { createProgram, configureStraightAlphaBlending } = await import('/assets/js/rendering/gl-utils.js');
    const { writeFogUniforms } = await import('/assets/js/rendering/shaders/fog-shaders.js');

    const width = 640;
    const height = 480;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });

    // A 3D graph: random cells in [-1, 1]^3, each linked to a few later cells.
    const cellCount = 20_000;
    let state = 11;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
    const positions = Float32Array.from({ length: cellCount * 3 }, () => random() * 2 - 1);
    const pairs = new Set();
    for (let cell = 0; cell < cellCount - 1; cell++) {
      for (let k = 0; k < 3; k++) {
        const other = Math.min(cellCount - 1, cell + 1 + Math.floor(random() * 40));
        pairs.add(cell * cellCount + other);
      }
    }
    const keys = Array.from(pairs).sort((a, b) => a - b);
    const nEdges = keys.length;
    const sources = Uint32Array.from(keys, key => Math.floor(key / cellCount));
    const destinations = Uint32Array.from(keys, key => key % cellCount);
    const strength = Float32Array.from(keys, (_key, edge) => (1 + (edge % 5)) / 5);
    // A filter: every third cell hidden.
    const transparency = Uint8Array.from({ length: cellCount }, (_value, cell) => (cell % 3 === 0 ? 0 : 1));

    // A perspective camera looking at the cloud from an angle.
    const f = 1 / Math.tan(0.45);
    const near = 0.1;
    const far = 40;
    const projection = [f * height / width, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, 2 * far * near / (near - far), 0];
    const angle = 0.8;
    const view = [
      Math.cos(angle), 0.12, -Math.sin(angle), 0,
      0.04, 0.98, 0.17, 0,
      Math.sin(angle), -0.15, Math.cos(angle), 0,
      0.11, -0.05, -3.4, 1,
    ];
    const multiply = (a, b) => {
      const out = new Float32Array(16);
      for (let column = 0; column < 4; column++) {
        for (let row = 0; row < 4; row++) {
          let sum = 0;
          for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[column * 4 + k];
          out[column * 4 + row] = sum;
        }
      }
      return out;
    };
    const frame = {
      mvpMatrix: multiply(projection, view),
      modelViewMatrix: Float32Array.from(view),
      widthPx: width,
      heightPx: height,
      lineWidth: 1,
      lineColor: Float32Array.of(0.1, 0.2, 0.3),
      lineAlpha: 0.6,
      fogDensity: 0.4,
      fogNear: 2,
      fogFar: 5,
    };
    const target = 20_000;

    const framebuffer = gl.createFramebuffer();
    const color = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, color);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
    gl.viewport(0, 0, width, height);
    const capture = draw => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.clearColor(1, 1, 1, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      draw();
      const pixels = new Uint8Array(width * height * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    };

    // The layer: selection, 12-byte records, GPU gather, draw.
    const layer = createConnectivityEdgeLayer({
      gl,
      getViewGeometry: () => ({ positions, dimension: 3, generation: 1 }),
      schedule: callback => setTimeout(callback, 0),
      cancel: handle => clearTimeout(handle),
    });
    layer.setGraph(edgePayloadOf(sources, destinations, strength, cellCount));
    layer.addView('live');
    layer.setVisibleTarget(target);
    layer.publishVisibility('live', { transparency, admissionLevels: null, lodLevel: -1 });
    const shown = layer.refresh('live').shownCount;
    const layerPixels = capture(() => layer.draw('live', frame));

    // The reference: the same first K visible edges, gathered on the CPU into
    // 28-byte records, drawn with the same shader sources and uniforms.
    const order = createConnectivityEdgeOrder(nEdges);
    const records = new Float32Array(shown * CONNECTIVITY_INSTANCE_FLOATS);
    let written = 0;
    for (let rank = 0; rank < nEdges && written < shown; rank++) {
      const edge = order.at(rank);
      const s = sources[edge];
      const d = destinations[edge];
      if (!transparency[s] || !transparency[d]) continue;
      records.set(positions.subarray(s * 3, s * 3 + 3), written * 7);
      records.set(positions.subarray(d * 3, d * 3 + 3), written * 7 + 3);
      records[written * 7 + 6] = strength[edge];
      written++;
    }
    const program = createProgram(gl, LINE_INSTANCED_VS_SOURCE, LINE_INSTANCED_FS_SOURCE);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const instances = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, instances);
    gl.bufferData(gl.ARRAY_BUFFER, records, gl.STATIC_DRAW);
    for (const [location, size, offset] of [[1, 3, 0], [2, 3, 12], [3, 1, 24]]) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 28, offset);
      gl.vertexAttribDivisor(location, 1);
    }
    gl.bindVertexArray(null);
    const referencePixels = capture(() => {
      gl.useProgram(program);
      configureStraightAlphaBlending(gl);
      const at = name => gl.getUniformLocation(program, name);
      gl.uniformMatrix4fv(at('u_mvpMatrix'), false, frame.mvpMatrix);
      gl.uniformMatrix4fv(at('u_modelViewMatrix'), false, frame.modelViewMatrix);
      gl.uniform2f(at('u_viewportSize'), width, height);
      gl.uniform1f(at('u_lineWidth'), frame.lineWidth);
      gl.uniform3fv(at('u_lineColor'), frame.lineColor);
      gl.uniform1f(at('u_lineAlpha'), frame.lineAlpha);
      writeFogUniforms(gl, at('u_fogNear'), at('u_fogScale'), frame.fogDensity, frame.fogNear, frame.fogFar);
      gl.bindVertexArray(vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, shown);
      gl.bindVertexArray(null);
    });

    let lit = 0;
    let mismatched = 0;
    let maxDelta = 0;
    const first = [];
    for (let index = 0; index < layerPixels.length; index += 4) {
      if (referencePixels[index] !== 255 || referencePixels[index + 1] !== 255 || referencePixels[index + 2] !== 255) lit++;
      let delta = 0;
      for (let channel = 0; channel < 4; channel++) {
        delta = Math.max(delta, Math.abs(layerPixels[index + channel] - referencePixels[index + channel]));
      }
      if (delta === 0) continue;
      mismatched++;
      maxDelta = Math.max(maxDelta, delta);
      if (first.length < 8) first.push([(index / 4) % width, Math.floor(index / 4 / width)]);
    }
    layer.dispose();
    return { shown, written, lit, mismatched, maxDelta, first, error: gl.getError() };
  });
  expect(result.error).toBe(0);
  expect(result.shown).toBe(20_000);
  expect(result.written).toBe(result.shown);
  expect(result.lit).toBeGreaterThan(10_000);
  expect(pixelParityVerdict(result, 'GPU gather vs CPU gather')).toBeNull();
});
