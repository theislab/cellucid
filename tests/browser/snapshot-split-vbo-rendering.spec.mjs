import { expect, test } from '@playwright/test';

const configuredPointCount = Number.parseInt(
  process.env.CELLUCID_SNAPSHOT_GPU_BENCH_POINTS ?? '262144',
  10,
);
if (
  !Number.isSafeInteger(configuredPointCount) ||
  configuredPointCount < 1
) {
  throw new RangeError(
    'CELLUCID_SNAPSHOT_GPU_BENCH_POINTS must be a positive safe integer.',
  );
}

test('production split snapshot VBOs match interleaved pixels and indexed draws', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.goto('/tests/browser/fixtures/webgl-harness.html');

  const result = await page.evaluate(async pointCount => {
    const canvas = document.createElement('canvas');
    canvas.id = 'snapshot-split-benchmark';
    canvas.width = 512;
    canvas.height = 512;
    canvas.style.cssText =
      'width:512px;height:512px;image-rendering:pixelated';
    document.body.append(canvas);
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
      stencil: false,
    });
    if (gl === null) {
      return {
        supported: false,
        userAgent: navigator.userAgent,
      };
    }

    const {
      HighPerfRenderer,
    } = await import(
      '/assets/js/rendering/high-perf-renderer.js'
    );
    const side = Math.ceil(Math.sqrt(pointCount));
    const positions = new Float32Array(pointCount * 3);
    const colors = new Uint8Array(pointCount * 4);
    for (let index = 0; index < pointCount; index++) {
      positions[index * 3] =
        (((index % side) + 0.5) / side) * 2 - 1;
      positions[index * 3 + 1] =
        ((Math.floor(index / side) + 0.5) / side) * 2 - 1;
      positions[index * 3 + 2] = 0;
      colors[index * 4] = index & 0xff;
      colors[index * 4 + 1] = (index >>> 3) & 0xff;
      colors[index * 4 + 2] = (index >>> 7) & 0xff;
      colors[index * 4 + 3] = 255;
    }

    const renderer = new HighPerfRenderer(gl, {
      USE_FRUSTUM_CULLING: false,
      USE_LOD: false,
    });
    renderer.loadData(positions, colors, {
      buildSpatialIndex: false,
      dimensionLevel: 2,
    });
    const bytesBeforeSnapshots =
      renderer._refreshGpuMemoryStats();
    renderer.createSnapshotBuffer(
      'split-a',
      colors,
      null,
      positions,
      2,
      'live',
    );
    const bytesAfterFirst = renderer._refreshGpuMemoryStats();
    renderer.createSnapshotBuffer(
      'split-b',
      colors,
      null,
      positions,
      2,
      'live',
    );
    const bytesAfterSecond =
      renderer._refreshGpuMemoryStats();
    const first = renderer.snapshotBuffers.get('split-a');
    const second = renderer.snapshotBuffers.get('split-b');
    const geometry = renderer._snapshotGeometryPools.get(
      first.geometryGeneration,
    );

    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader));
      }
      return shader;
    };
    const vertexShader = compile(
      gl.VERTEX_SHADER,
      `#version 300 es
      precision highp float;
      layout(location = 0) in vec3 a_position;
      layout(location = 1) in vec4 a_color;
      out vec4 v_color;
      void main() {
        gl_Position = vec4(a_position, 1.0);
        gl_PointSize = 1.0;
        v_color = a_color;
      }`,
    );
    const fragmentShader = compile(
      gl.FRAGMENT_SHADER,
      `#version 300 es
      precision highp float;
      in vec4 v_color;
      out vec4 out_color;
      void main() {
        out_color = v_color;
      }`,
    );
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program));
    }

    const indexedCount = Math.ceil(pointCount / 4);
    const indices = new Uint32Array(indexedCount);
    for (let index = 0; index < indexedCount; index++) {
      indices[index] = index * 4;
    }
    const indexBuffer = gl.createBuffer();
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(
      gl.ELEMENT_ARRAY_BUFFER,
      indices,
      gl.STATIC_DRAW,
    );
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);

    gl.useProgram(program);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DEPTH_TEST);
    const render = (vao, indexed) => {
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindVertexArray(vao);
      if (indexed) {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
        gl.drawElements(
          gl.POINTS,
          indexedCount,
          gl.UNSIGNED_INT,
          0,
        );
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
      } else {
        gl.drawArrays(gl.POINTS, 0, pointCount);
      }
      gl.bindVertexArray(null);
      gl.finish();
      const pixels = new Uint8Array(
        canvas.width * canvas.height * 4,
      );
      gl.readPixels(
        0,
        0,
        canvas.width,
        canvas.height,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels,
      );
      return pixels;
    };
    const comparePixels = (left, right) => {
      let mismatches = 0;
      let leftHash = 2166136261;
      let rightHash = 2166136261;
      for (let index = 0; index < left.length; index++) {
        if (left[index] !== right[index]) mismatches++;
        leftHash = Math.imul(leftHash ^ left[index], 16777619);
        rightHash = Math.imul(rightHash ^ right[index], 16777619);
      }
      return {
        leftHash: leftHash >>> 0,
        mismatches,
        rightHash: rightHash >>> 0,
      };
    };
    const fullPixels = comparePixels(
      render(renderer.vao, false),
      render(first.vao, false),
    );
    const indexedPixels = comparePixels(
      render(renderer.vao, true),
      render(first.vao, true),
    );

    const drawsPerSample = 32;
    const measure = (vao, indexed) => {
      gl.finish();
      const start = performance.now();
      for (let draw = 0; draw < drawsPerSample; draw++) {
        gl.bindVertexArray(vao);
        if (indexed) {
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
          gl.drawElements(
            gl.POINTS,
            indexedCount,
            gl.UNSIGNED_INT,
            0,
          );
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
        } else {
          gl.drawArrays(gl.POINTS, 0, pointCount);
        }
        gl.bindVertexArray(null);
      }
      gl.finish();
      return (performance.now() - start) / drawsPerSample;
    };
    // Compile, allocate, and warm both layouts before paired measurement.
    measure(renderer.vao, false);
    measure(first.vao, false);
    measure(renderer.vao, true);
    measure(first.vao, true);
    const timings = {
      fullInterleaved: [],
      fullSplit: [],
      indexedInterleaved: [],
      indexedSplit: [],
    };
    for (let sample = 0; sample < 7; sample++) {
      const firstLayout = sample % 2 === 0
        ? [
            ['fullInterleaved', renderer.vao, false],
            ['fullSplit', first.vao, false],
            ['indexedInterleaved', renderer.vao, true],
            ['indexedSplit', first.vao, true],
          ]
        : [
            ['fullSplit', first.vao, false],
            ['fullInterleaved', renderer.vao, false],
            ['indexedSplit', first.vao, true],
            ['indexedInterleaved', renderer.vao, true],
          ];
      for (const [key, vao, indexed] of firstLayout) {
        timings[key].push(measure(vao, indexed));
      }
    }
    const median = values => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    };
    const medians = Object.fromEntries(
      Object.entries(timings).map(([key, values]) => [
        key,
        median(values),
      ]),
    );
    const timerExtension = gl.getExtension(
      'EXT_disjoint_timer_query_webgl2',
    );
    const gpuTimings = timerExtension === null
      ? null
      : {
          fullInterleaved: [],
          fullSplit: [],
          indexedInterleaved: [],
          indexedSplit: [],
        };
    const measureGpu = async (vao, indexed) => {
      const query = gl.createQuery();
      gl.beginQuery(timerExtension.TIME_ELAPSED_EXT, query);
      for (let draw = 0; draw < drawsPerSample; draw++) {
        gl.bindVertexArray(vao);
        if (indexed) {
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
          gl.drawElements(
            gl.POINTS,
            indexedCount,
            gl.UNSIGNED_INT,
            0,
          );
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
        } else {
          gl.drawArrays(gl.POINTS, 0, pointCount);
        }
        gl.bindVertexArray(null);
      }
      gl.endQuery(timerExtension.TIME_ELAPSED_EXT);
      gl.flush();
      for (let poll = 0; poll < 300; poll++) {
        if (
          gl.getQueryParameter(
            query,
            gl.QUERY_RESULT_AVAILABLE,
          )
        ) {
          const disjoint = gl.getParameter(
            timerExtension.GPU_DISJOINT_EXT,
          );
          const nanoseconds = disjoint
            ? null
            : gl.getQueryParameter(query, gl.QUERY_RESULT);
          gl.deleteQuery(query);
          return nanoseconds === null
            ? null
            : nanoseconds / 1_000_000 / drawsPerSample;
        }
        await new Promise(resolve => {
          requestAnimationFrame(resolve);
        });
      }
      gl.deleteQuery(query);
      return null;
    };
    if (gpuTimings !== null) {
      for (let sample = 0; sample < 5; sample++) {
        const order = sample % 2 === 0
          ? [
              ['fullInterleaved', renderer.vao, false],
              ['fullSplit', first.vao, false],
              ['indexedInterleaved', renderer.vao, true],
              ['indexedSplit', first.vao, true],
            ]
          : [
              ['fullSplit', first.vao, false],
              ['fullInterleaved', renderer.vao, false],
              ['indexedSplit', first.vao, true],
              ['indexedInterleaved', renderer.vao, true],
            ];
        for (const [key, vao, indexed] of order) {
          const milliseconds = await measureGpu(vao, indexed);
          if (milliseconds !== null) {
            gpuTimings[key].push(milliseconds);
          }
        }
      }
    }
    const gpuMedians =
      gpuTimings !== null &&
      Object.values(gpuTimings).every(values => values.length > 0)
        ? Object.fromEntries(
            Object.entries(gpuTimings).map(([key, values]) => [
              key,
              median(values),
            ]),
          )
        : null;

    const inspectAttributes = vao => {
      gl.bindVertexArray(vao);
      const attributes = [0, 1].map(index => ({
        buffer: gl.getVertexAttrib(
          index,
          gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING,
        ),
        offset: gl.getVertexAttribOffset(
          index,
          gl.VERTEX_ATTRIB_ARRAY_POINTER,
        ),
        stride: gl.getVertexAttrib(
          index,
          gl.VERTEX_ATTRIB_ARRAY_STRIDE,
        ),
      }));
      gl.bindVertexArray(null);
      return attributes;
    };
    const splitAttributes = inspectAttributes(first.vao);
    const interleavedAttributes = inspectAttributes(renderer.vao);
    const debugInfo =
      gl.getExtension('WEBGL_debug_renderer_info');
    const runtime = {
      renderer: debugInfo
        ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER),
      vendor: debugInfo
        ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
        : gl.getParameter(gl.VENDOR),
      version: gl.getParameter(gl.VERSION),
    };

    // Leave the production split full-detail image on the headed canvas for
    // the test artifact, then release every benchmark owner afterward.
    render(first.vao, false);
    window.__disposeSnapshotSplitBenchmark = () => {
      gl.deleteBuffer(indexBuffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      renderer.dispose();
    };
    return {
      supported: true,
      runtime,
      pointCount,
      indexedCount,
      drawsPerSample,
      fullPixels,
      indexedPixels,
      timings,
      medians,
      gpuTimings,
      gpuMedians,
      memory: {
        firstSnapshotDelta:
          bytesAfterFirst - bytesBeforeSnapshots,
        secondSnapshotDelta:
          bytesAfterSecond - bytesAfterFirst,
        expectedFirstSnapshot: pointCount * 16,
        expectedSecondSnapshot: pointCount * 4,
      },
      generation: {
        first: renderer.getViewGeometryGeneration('split-a'),
        second: renderer.getViewGeometryGeneration('split-b'),
        live: renderer.getViewGeometryGeneration('live'),
        refCount: geometry.refCount,
      },
      bindings: {
        interleavedSharesOneBuffer:
          interleavedAttributes[0].buffer ===
          interleavedAttributes[1].buffer,
        interleavedPosition: {
          offset: interleavedAttributes[0].offset,
          stride: interleavedAttributes[0].stride,
        },
        interleavedColor: {
          offset: interleavedAttributes[1].offset,
          stride: interleavedAttributes[1].stride,
        },
        splitPositionIsPooled:
          splitAttributes[0].buffer === geometry.positionBuffer,
        splitColorIsPerSnapshot:
          splitAttributes[1].buffer === first.buffer,
        sameGenerationPositionShared:
          geometry.positionBuffer !== null &&
          first.geometryGeneration === second.geometryGeneration,
        splitPosition: {
          offset: splitAttributes[0].offset,
          stride: splitAttributes[0].stride,
        },
        splitColor: {
          offset: splitAttributes[1].offset,
          stride: splitAttributes[1].stride,
        },
      },
      glError: gl.getError(),
    };
  }, configuredPointCount);

  await testInfo.attach('snapshot-split-vbo-benchmark.json', {
    body: Buffer.from(`${JSON.stringify(result, null, 2)}\n`),
    contentType: 'application/json',
  });
  expect(result.supported, JSON.stringify(result)).toBe(true);
  expect(result.fullPixels.mismatches).toBe(0);
  expect(result.fullPixels.leftHash).toBe(
    result.fullPixels.rightHash,
  );
  expect(result.indexedPixels.mismatches).toBe(0);
  expect(result.indexedPixels.leftHash).toBe(
    result.indexedPixels.rightHash,
  );
  expect(result.memory).toEqual({
    firstSnapshotDelta: result.memory.expectedFirstSnapshot,
    secondSnapshotDelta: result.memory.expectedSecondSnapshot,
    expectedFirstSnapshot: result.memory.expectedFirstSnapshot,
    expectedSecondSnapshot: result.memory.expectedSecondSnapshot,
  });
  expect(result.generation.first).toBe(result.generation.live);
  expect(result.generation.second).toBe(result.generation.live);
  expect(result.generation.refCount).toBe(2);
  expect(result.bindings).toEqual({
    interleavedSharesOneBuffer: true,
    interleavedPosition: { offset: 0, stride: 16 },
    interleavedColor: { offset: 12, stride: 16 },
    splitPositionIsPooled: true,
    splitColorIsPerSnapshot: true,
    sameGenerationPositionShared: true,
    splitPosition: { offset: 0, stride: 12 },
    splitColor: { offset: 0, stride: 4 },
  });
  for (const value of Object.values(result.medians)) {
    expect(Number.isFinite(value)).toBe(true);
    // Some automated browser clocks quantize a completed GPU fence to 0 ms;
    // timing is diagnostic while pixels, ownership, and GL state are exact.
    expect(value).toBeGreaterThanOrEqual(0);
  }
  if (result.gpuMedians !== null) {
    for (const value of Object.values(result.gpuMedians)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  }
  expect(result.glError).toBe(0);
  console.log(
    `[snapshot split VBO ${testInfo.project.name}] ` +
    `${result.pointCount.toLocaleString()} points; ` +
    `${result.gpuMedians === null ? 'wall' : 'GPU'} full interleaved ` +
    `${(result.gpuMedians ?? result.medians).fullInterleaved.toFixed(3)} ms/draw, ` +
    `split ${(result.gpuMedians ?? result.medians).fullSplit.toFixed(3)} ms/draw; ` +
    `indexed(${result.indexedCount.toLocaleString()}) interleaved ` +
    `${(result.gpuMedians ?? result.medians).indexedInterleaved.toFixed(3)} ms/draw, ` +
    `split ${(result.gpuMedians ?? result.medians).indexedSplit.toFixed(3)} ms/draw; ` +
    `pixel mismatches full/indexed ` +
    `${result.fullPixels.mismatches}/${result.indexedPixels.mismatches}; ` +
    `${result.runtime.renderer}`,
  );
  await page.locator('#snapshot-split-benchmark').screenshot({
    path: testInfo.outputPath(
      `snapshot-split-full-${testInfo.project.name}.png`,
    ),
  });
  await page.evaluate(() => {
    window.__disposeSnapshotSplitBenchmark();
  });
});
