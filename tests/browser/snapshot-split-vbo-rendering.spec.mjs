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
      // Preserve alpha in readPixels so the R8 fetch is part of the exact
      // split-versus-baked RGBA pixel contract, not only the timing sample.
      alpha: true,
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

    // Track the actual attribute-publication calls instead of querying VAO
    // internals. WebKit on Windows renders these VAOs correctly but reports
    // non-portable null/zero values from getVertexAttrib* introspection.
    const attributePublications = new Map();
    let boundArrayBuffer = null;
    let boundVertexArray = null;
    let pointerCallCount = 0;
    const nativeBindBuffer = gl.bindBuffer;
    const nativeBindVertexArray = gl.bindVertexArray;
    const nativeVertexAttribPointer = gl.vertexAttribPointer;
    gl.bindBuffer = function bindBuffer(target, buffer) {
      if (target === gl.ARRAY_BUFFER) boundArrayBuffer = buffer;
      return Reflect.apply(nativeBindBuffer, gl, arguments);
    };
    gl.bindVertexArray = function bindVertexArray(vao) {
      boundVertexArray = vao;
      return Reflect.apply(nativeBindVertexArray, gl, arguments);
    };
    gl.vertexAttribPointer = function vertexAttribPointer(
      index,
      size,
      type,
      normalized,
      stride,
      offset,
    ) {
      pointerCallCount += 1;
      let attributes = attributePublications.get(boundVertexArray);
      if (attributes === undefined) {
        attributes = new Map();
        attributePublications.set(boundVertexArray, attributes);
      }
      attributes.set(index, {
        buffer: boundArrayBuffer,
        normalized,
        offset,
        size,
        stride,
        type,
      });
      return Reflect.apply(nativeVertexAttribPointer, gl, arguments);
    };

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
      colors[index * 4 + 3] = 32 + (index % 224);
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

    renderer.setQuality('ultralight');
    const program = renderer.activeProgram;
    const uniforms =
      renderer.uniformLocations.get('ultralight');
    if (!program || !uniforms) {
      throw new Error(
        'Production ultralight snapshot shader is unavailable.',
      );
    }
    const identity = Float32Array.from([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]);
    gl.useProgram(program);
    if (uniforms.u_mvpMatrix !== null) {
      gl.uniformMatrix4fv(
        uniforms.u_mvpMatrix,
        false,
        identity,
      );
    }
    if (uniforms.u_viewMatrix !== null) {
      gl.uniformMatrix4fv(
        uniforms.u_viewMatrix,
        false,
        identity,
      );
    }
    if (uniforms.u_modelMatrix !== null) {
      gl.uniformMatrix4fv(
        uniforms.u_modelMatrix,
        false,
        identity,
      );
    }
    if (uniforms.u_projectionMatrix !== null) {
      gl.uniformMatrix4fv(
        uniforms.u_projectionMatrix,
        false,
        identity,
      );
    }
    if (uniforms.u_pointSize !== null) {
      gl.uniform1f(uniforms.u_pointSize, 1);
    }
    if (uniforms.u_sizeAttenuation !== null) {
      gl.uniform1f(uniforms.u_sizeAttenuation, 0);
    }
    if (uniforms.u_viewportHeight !== null) {
      gl.uniform1f(
        uniforms.u_viewportHeight,
        canvas.height,
      );
    }
    if (uniforms.u_fov !== null) {
      gl.uniform1f(uniforms.u_fov, Math.PI / 3);
    }
    const configureSplitRgbR8 = () => {
      gl.useProgram(program);
      renderer._bindSnapshotAlphaTexture(
        gl,
        uniforms,
        first,
        false,
        2,
      );
    };
    const configureInterleavedRgba = () => {
      gl.useProgram(program);
      // Keep both sampler types complete and on distinct units even though
      // this reference path reads alpha from the RGBA vertex attribute.
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, first.alphaTexture);
      if (uniforms.u_alphaTex !== null) {
        gl.uniform1i(uniforms.u_alphaTex, 0);
      }
      if (uniforms.u_useAlphaTex !== null) {
        gl.uniform1i(uniforms.u_useAlphaTex, 0);
      }
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(
        gl.TEXTURE_2D,
        renderer._dummyLodIndexTexture,
      );
      if (uniforms.u_lodIndexTex !== null) {
        gl.uniform1i(uniforms.u_lodIndexTex, 1);
      }
      if (uniforms.u_useLodIndexTex !== null) {
        gl.uniform1i(uniforms.u_useLodIndexTex, 0);
      }
    };

    const indexedCount = Math.ceil(pointCount / 4);
    // drawElements exposes each EBO value as gl_VertexID. These must remain
    // original source IDs so the production shader addresses the matching R8
    // texel rather than a compact 0..indexedCount-1 ordinal.
    const sourceIds = new Uint32Array(indexedCount);
    for (let index = 0; index < indexedCount; index++) {
      sourceIds[index] = index * 4;
    }
    const indexBuffer = gl.createBuffer();
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(
      gl.ELEMENT_ARRAY_BUFFER,
      sourceIds,
      gl.STATIC_DRAW,
    );
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DEPTH_TEST);
    const render = (configure, vao, indexed) => {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      configure();
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
      render(configureInterleavedRgba, renderer.vao, false),
      render(configureSplitRgbR8, first.vao, false),
    );
    const indexedPixels = comparePixels(
      render(configureInterleavedRgba, renderer.vao, true),
      render(configureSplitRgbR8, first.vao, true),
    );

    // Preserve the original 32-draw timing sample while keeping each
    // synchronous submission batch below browser/driver watchdog windows.
    // Frame-service time is excluded from the diagnostic, so the result still
    // measures draw work rather than the cooperative scheduling boundary.
    const drawsPerBatch = 8;
    const batchesPerSample = 4;
    const drawsPerSample = drawsPerBatch * batchesPerSample;
    const measure = async (configure, vao, indexed) => {
      const start = performance.now();
      let frameServiceTime = 0;
      for (let batch = 0; batch < batchesPerSample; batch++) {
        gl.finish();
        for (let draw = 0; draw < drawsPerBatch; draw++) {
          configure();
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
        if (batch + 1 < batchesPerSample) {
          const frameServiceStart = performance.now();
          await new Promise(resolve => requestAnimationFrame(resolve));
          frameServiceTime += performance.now() - frameServiceStart;
        }
      }
      return (
        performance.now() - start - frameServiceTime
      ) / drawsPerSample;
    };
    // Compile, allocate, and warm both production shader paths before paired
    // measurement. The reference path uses baked RGBA; the split path performs
    // the snapshot-owned R8 texel fetch used by production rendering.
    await measure(configureInterleavedRgba, renderer.vao, false);
    await measure(configureSplitRgbR8, first.vao, false);
    await measure(configureInterleavedRgba, renderer.vao, true);
    await measure(configureSplitRgbR8, first.vao, true);
    const timings = {
      fullInterleaved: [],
      fullSplit: [],
      indexedInterleaved: [],
      indexedSplit: [],
    };
    for (let sample = 0; sample < 7; sample++) {
      const firstLayout = sample % 2 === 0
        ? [
            [
              'fullInterleaved',
              configureInterleavedRgba,
              renderer.vao,
              false,
            ],
            [
              'fullSplit',
              configureSplitRgbR8,
              first.vao,
              false,
            ],
            [
              'indexedInterleaved',
              configureInterleavedRgba,
              renderer.vao,
              true,
            ],
            [
              'indexedSplit',
              configureSplitRgbR8,
              first.vao,
              true,
            ],
          ]
        : [
            [
              'fullSplit',
              configureSplitRgbR8,
              first.vao,
              false,
            ],
            [
              'fullInterleaved',
              configureInterleavedRgba,
              renderer.vao,
              false,
            ],
            [
              'indexedSplit',
              configureSplitRgbR8,
              first.vao,
              true,
            ],
            [
              'indexedInterleaved',
              configureInterleavedRgba,
              renderer.vao,
              true,
            ],
          ];
      for (
        const [key, configure, vao, indexed] of firstLayout
      ) {
        timings[key].push(
          await measure(configure, vao, indexed),
        );
      }
      // Let the browser service completed GPU work between benchmark samples.
      // Without this boundary Windows WebKit can reset an otherwise-correct
      // context after hundreds of back-to-back full-dataset draws.
      await new Promise(resolve => requestAnimationFrame(resolve));
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
    const measureGpu = async (configure, vao, indexed) => {
      const query = gl.createQuery();
      gl.beginQuery(timerExtension.TIME_ELAPSED_EXT, query);
      for (let draw = 0; draw < drawsPerSample; draw++) {
        configure();
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
              [
                'fullInterleaved',
                configureInterleavedRgba,
                renderer.vao,
                false,
              ],
              [
                'fullSplit',
                configureSplitRgbR8,
                first.vao,
                false,
              ],
              [
                'indexedInterleaved',
                configureInterleavedRgba,
                renderer.vao,
                true,
              ],
              [
                'indexedSplit',
                configureSplitRgbR8,
                first.vao,
                true,
              ],
            ]
          : [
              [
                'fullSplit',
                configureSplitRgbR8,
                first.vao,
                false,
              ],
              [
                'fullInterleaved',
                configureInterleavedRgba,
                renderer.vao,
                false,
              ],
              [
                'indexedSplit',
                configureSplitRgbR8,
                first.vao,
                true,
              ],
              [
                'indexedInterleaved',
                configureInterleavedRgba,
                renderer.vao,
                true,
              ],
            ];
        for (
          const [key, configure, vao, indexed] of order
        ) {
          const milliseconds = await measureGpu(
            configure,
            vao,
            indexed,
          );
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

    const requireTrackedAttribute = (vao, index, label) => {
      const attribute = attributePublications.get(vao)?.get(index);
      if (attribute === undefined) {
        throw new Error(
          `${label} attribute ${index} was not published through a tracked GL call.`,
        );
      }
      return attribute;
    };
    const splitPositionAttribute = requireTrackedAttribute(
      first.vao,
      0,
      'Split snapshot',
    );
    const splitColorAttribute = requireTrackedAttribute(
      first.vao,
      1,
      'Split snapshot',
    );
    const interleavedPositionAttribute = requireTrackedAttribute(
      renderer.vao,
      0,
      'Live interleaved',
    );
    const interleavedColorAttribute = requireTrackedAttribute(
      renderer.vao,
      1,
      'Live interleaved',
    );
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
    render(configureSplitRgbR8, first.vao, false);
    window.__disposeSnapshotSplitBenchmark = () => {
      gl.deleteBuffer(indexBuffer);
      renderer.dispose();
    };
    return {
      supported: true,
      runtime,
      pointCount,
      indexedCount,
      indexedSourceIds: {
        exactOriginalIds: sourceIds.every(
          (sourceId, index) => sourceId === index * 4,
        ),
        first: sourceIds[0],
        last: sourceIds[sourceIds.length - 1],
      },
      drawsPerBatch,
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
      snapshotAlpha: {
        bytesMatchBakedRgba: first.alphaTexData
          .subarray(0, pointCount)
          .every(
            (alpha, index) =>
              alpha === colors[index * 4 + 3],
          ),
        byteLength: first.alphaTextureByteLength,
        distinctOwners:
          first.alphaTexture !== second.alphaTexture,
        expectedByteLength: pointCount,
        owned: first.alphaTexture !== null,
      },
      bindings: {
        trackedPointerCallCount: pointerCallCount,
        interleavedSharesOneBuffer:
          interleavedPositionAttribute.buffer ===
            interleavedColorAttribute.buffer &&
          interleavedPositionAttribute.buffer ===
            renderer.buffers.interleaved,
        interleavedPosition: {
          normalized: interleavedPositionAttribute.normalized,
          offset: interleavedPositionAttribute.offset,
          size: interleavedPositionAttribute.size,
          stride: interleavedPositionAttribute.stride,
          typeIsFloat:
            interleavedPositionAttribute.type === gl.FLOAT,
        },
        interleavedColor: {
          normalized: interleavedColorAttribute.normalized,
          offset: interleavedColorAttribute.offset,
          size: interleavedColorAttribute.size,
          stride: interleavedColorAttribute.stride,
          typeIsUnsignedByte:
            interleavedColorAttribute.type === gl.UNSIGNED_BYTE,
        },
        splitPositionIsPooled:
          splitPositionAttribute.buffer === geometry.positionBuffer,
        splitColorIsPerSnapshot:
          splitColorAttribute.buffer === first.buffer,
        sameGenerationPositionShared:
          geometry.positionBuffer !== null &&
          first.geometryGeneration === second.geometryGeneration,
        splitPosition: {
          normalized: splitPositionAttribute.normalized,
          offset: splitPositionAttribute.offset,
          size: splitPositionAttribute.size,
          stride: splitPositionAttribute.stride,
          typeIsFloat:
            splitPositionAttribute.type === gl.FLOAT,
        },
        splitColor: {
          normalized: splitColorAttribute.normalized,
          offset: splitColorAttribute.offset,
          size: splitColorAttribute.size,
          stride: splitColorAttribute.stride,
          typeIsUnsignedByte:
            splitColorAttribute.type === gl.UNSIGNED_BYTE,
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
  expect(result.indexedSourceIds).toEqual({
    exactOriginalIds: true,
    first: 0,
    last: (result.indexedCount - 1) * 4,
  });
  expect(result.memory).toEqual({
    firstSnapshotDelta: result.memory.expectedFirstSnapshot,
    secondSnapshotDelta: result.memory.expectedSecondSnapshot,
    expectedFirstSnapshot: result.memory.expectedFirstSnapshot,
    expectedSecondSnapshot: result.memory.expectedSecondSnapshot,
  });
  expect(result.generation.first).toBe(result.generation.live);
  expect(result.generation.second).toBe(result.generation.live);
  expect(result.generation.refCount).toBe(2);
  expect(result.snapshotAlpha).toEqual({
    bytesMatchBakedRgba: true,
    byteLength: result.snapshotAlpha.expectedByteLength,
    distinctOwners: true,
    expectedByteLength: result.snapshotAlpha.expectedByteLength,
    owned: true,
  });
  expect(result.bindings).toMatchObject({
    interleavedSharesOneBuffer: true,
    interleavedPosition: {
      normalized: false,
      offset: 0,
      size: 3,
      stride: 16,
      typeIsFloat: true,
    },
    interleavedColor: {
      normalized: true,
      offset: 12,
      size: 4,
      stride: 16,
      typeIsUnsignedByte: true,
    },
    splitPositionIsPooled: true,
    splitColorIsPerSnapshot: true,
    sameGenerationPositionShared: true,
    splitPosition: {
      normalized: false,
      offset: 0,
      size: 3,
      stride: 12,
      typeIsFloat: true,
    },
    splitColor: {
      normalized: true,
      offset: 0,
      size: 3,
      stride: 3,
      typeIsUnsignedByte: true,
    },
  });
  expect(result.bindings.trackedPointerCallCount).toBeGreaterThanOrEqual(
    6,
  );
  expect(result.drawsPerBatch).toBe(8);
  expect(result.drawsPerSample).toBe(32);
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
    `split RGB+R8 ${(result.gpuMedians ?? result.medians).fullSplit.toFixed(3)} ms/draw; ` +
    `indexed(${result.indexedCount.toLocaleString()}) interleaved ` +
    `${(result.gpuMedians ?? result.medians).indexedInterleaved.toFixed(3)} ms/draw, ` +
    `split RGB+R8 ${(result.gpuMedians ?? result.medians).indexedSplit.toFixed(3)} ms/draw; ` +
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
