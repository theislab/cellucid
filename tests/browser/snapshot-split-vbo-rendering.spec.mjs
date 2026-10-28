import { expect, test } from './helpers/test.mjs';

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
// The pixel, ownership and GL-state contract needs one paired sample of each
// draw path; the timing is diagnostic. A benchmark takes more samples when
// asked (CELLUCID_SNAPSHOT_GPU_BENCH_SAMPLES=7: seven wall-clock and seven
// GPU-timer samples of 32 draws per path). Run by default, the old seven and
// five took about 85 of the spec's 120 s under a software rasterizer.
const configuredSamples = Number.parseInt(
  process.env.CELLUCID_SNAPSHOT_GPU_BENCH_SAMPLES ?? '1',
  10,
);
if (!Number.isSafeInteger(configuredSamples) || configuredSamples < 1) {
  throw new RangeError(
    'CELLUCID_SNAPSHOT_GPU_BENCH_SAMPLES must be a positive safe integer.',
  );
}

test('production split snapshot VBOs match live RGBA-stream pixels and indexed draws', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.goto('/tests/browser/fixtures/webgl-harness.html');

  const result = await page.evaluate(async ({ pointCount, samples }) => {
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
    // A 2D embedding: two position components per point.
    const positions = new Float32Array(pointCount * 2);
    const colors = new Uint8Array(pointCount * 4);
    // The snapshots' transparency (0 or 1 a cell). The live reference reads
    // alpha from the RGBA attribute, so its alpha byte is the R8 byte the
    // snapshots' texture holds for the same cell.
    const transparency = new Uint8Array(pointCount);
    for (let index = 0; index < pointCount; index++) {
      positions[index * 2] =
        (((index % side) + 0.5) / side) * 2 - 1;
      positions[index * 2 + 1] =
        ((Math.floor(index / side) + 0.5) / side) * 2 - 1;
      transparency[index] = index % 7 === 3 ? 0 : 1;
      colors[index * 4] = index & 0xff;
      colors[index * 4 + 1] = (index >>> 3) & 0xff;
      colors[index * 4 + 2] = (index >>> 7) & 0xff;
      colors[index * 4 + 3] = transparency[index] * 255;
    }

    const renderer = new HighPerfRenderer(gl, {
      USE_FRUSTUM_CULLING: false,
      USE_LOD: false,
    });
    renderer.loadData(positions, colors, {
      dimensionLevel: 2,
    });
    // The live stores are written when first drawn; this harness draws the
    // live vertex array itself, so it writes them as a frame would.
    renderer.flushBufferUpdates(2);
    const bytesBeforeSnapshots =
      renderer._refreshGpuMemoryStats();
    renderer.createSnapshotBuffer(
      'split-a',
      colors,
      transparency,
      positions,
      2,
      'live',
    );
    const bytesAfterFirst = renderer._refreshGpuMemoryStats();
    renderer.createSnapshotBuffer(
      'split-b',
      colors,
      transparency,
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
    if (uniforms.u_modelViewMatrix !== null) {
      gl.uniformMatrix4fv(
        uniforms.u_modelViewMatrix,
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
    if (uniforms.u_pointScale !== null) {
      gl.uniform1f(
        uniforms.u_pointScale,
        (canvas.height / (2 * Math.tan(Math.PI / 6))) * 0.01,
      );
    }
    const configureSplitRgbaR8 = () => {
      gl.useProgram(program);
      renderer._bindPointAlpha(
        gl,
        uniforms,
        first.alphaTexture,
        first.alphaTexPlan,
        renderer._ensureSnapshotDrawOrder(first, null),
      );
    };
    const configureLiveRgba = () => {
      gl.useProgram(program);
      // Keep both sampler types complete and on distinct units even though
      // this reference path reads alpha from the RGBA vertex attribute.
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, first.alphaTexture);
      if (uniforms.u_alphaTex !== null) {
        gl.uniform1i(uniforms.u_alphaTex, 0);
      }
      if (uniforms.u_useAlphaTex !== null) {
        gl.uniform1i(uniforms.u_useAlphaTex, 0);
      }
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(
        gl.TEXTURE_2D_ARRAY,
        renderer._dummyLodIndexTexture,
      );
      if (uniforms.u_lodIndexTex !== null) {
        gl.uniform1i(uniforms.u_lodIndexTex, 1);
      }
      if (uniforms.u_orderedSlots !== null) {
        gl.uniform1i(uniforms.u_orderedSlots, 0);
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
      render(configureLiveRgba, renderer.vao.vaos[0], false),
      render(configureSplitRgbaR8, first.vao.vaos[0], false),
    );
    const indexedPixels = comparePixels(
      render(configureLiveRgba, renderer.vao.vaos[0], true),
      render(configureSplitRgbaR8, first.vao.vaos[0], true),
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
    await measure(configureLiveRgba, renderer.vao.vaos[0], false);
    await measure(configureSplitRgbaR8, first.vao.vaos[0], false);
    await measure(configureLiveRgba, renderer.vao.vaos[0], true);
    await measure(configureSplitRgbaR8, first.vao.vaos[0], true);
    const timings = {
      fullLive: [],
      fullSplit: [],
      indexedLive: [],
      indexedSplit: [],
    };
    for (let sample = 0; sample < samples; sample++) {
      const firstLayout = sample % 2 === 0
        ? [
            [
              'fullLive',
              configureLiveRgba,
              renderer.vao.vaos[0],
              false,
            ],
            [
              'fullSplit',
              configureSplitRgbaR8,
              first.vao.vaos[0],
              false,
            ],
            [
              'indexedLive',
              configureLiveRgba,
              renderer.vao.vaos[0],
              true,
            ],
            [
              'indexedSplit',
              configureSplitRgbaR8,
              first.vao.vaos[0],
              true,
            ],
          ]
        : [
            [
              'fullSplit',
              configureSplitRgbaR8,
              first.vao.vaos[0],
              false,
            ],
            [
              'fullLive',
              configureLiveRgba,
              renderer.vao.vaos[0],
              false,
            ],
            [
              'indexedSplit',
              configureSplitRgbaR8,
              first.vao.vaos[0],
              true,
            ],
            [
              'indexedLive',
              configureLiveRgba,
              renderer.vao.vaos[0],
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
          fullLive: [],
          fullSplit: [],
          indexedLive: [],
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
      for (let sample = 0; sample < samples; sample++) {
        const order = sample % 2 === 0
          ? [
              [
                'fullLive',
                configureLiveRgba,
                renderer.vao.vaos[0],
                false,
              ],
              [
                'fullSplit',
                configureSplitRgbaR8,
                first.vao.vaos[0],
                false,
              ],
              [
                'indexedLive',
                configureLiveRgba,
                renderer.vao.vaos[0],
                true,
              ],
              [
                'indexedSplit',
                configureSplitRgbaR8,
                first.vao.vaos[0],
                true,
              ],
            ]
          : [
              [
                'fullSplit',
                configureSplitRgbaR8,
                first.vao.vaos[0],
                false,
              ],
              [
                'fullLive',
                configureLiveRgba,
                renderer.vao.vaos[0],
                false,
              ],
              [
                'indexedSplit',
                configureSplitRgbaR8,
                first.vao.vaos[0],
                true,
              ],
              [
                'indexedLive',
                configureLiveRgba,
                renderer.vao.vaos[0],
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
    // Segmented vertex arrays (point-store-segments.js): one segment here.
    const splitPositionAttribute = requireTrackedAttribute(
      first.vao.vaos[0],
      0,
      'Split snapshot',
    );
    const splitColorAttribute = requireTrackedAttribute(
      first.vao.vaos[0],
      1,
      'Split snapshot',
    );
    const livePositionAttribute = requireTrackedAttribute(
      renderer.vao.vaos[0],
      0,
      'Live full-detail',
    );
    const liveColorAttribute = requireTrackedAttribute(
      renderer.vao.vaos[0],
      1,
      'Live full-detail',
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
    render(configureSplitRgbaR8, first.vao.vaos[0], false);
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
        // Snapshots of the live generation borrow the live 2D position store,
        // so each adds only its RGBA8 colours (4 bytes a point) and R8 (1).
        expectedFirstSnapshot: pointCount * 5,
        expectedSecondSnapshot: pointCount * 5,
      },
      generation: {
        first: renderer.getViewGeometryGeneration('split-a'),
        second: renderer.getViewGeometryGeneration('split-b'),
        live: renderer.getViewGeometryGeneration('live'),
        refCount: geometry.refCount,
      },
      snapshotAlpha: {
        // The texture holds the published transparency, kept by
        // reference: no CPU copy of either view's R8 image.
        transparencyByReference:
          first.alphas === transparency &&
          second.alphas === transparency &&
          !Object.hasOwn(first, 'alphaTexData') &&
          !Object.hasOwn(renderer, '_snapshotAlphaStagingData'),
        byteLength: first.alphaTextureByteLength,
        distinctOwners:
          first.alphaTexture !== second.alphaTexture,
        expectedByteLength: pointCount,
        owned: first.alphaTexture !== null,
      },
      bindings: {
        trackedPointerCallCount: pointerCallCount,
        liveStreamsAreSeparate:
          livePositionAttribute.buffer ===
            renderer.buffers.positions.segments[0].buffer &&
          liveColorAttribute.buffer === renderer.buffers.colors.segments[0].buffer &&
          livePositionAttribute.buffer !== liveColorAttribute.buffer,
        livePosition: {
          normalized: livePositionAttribute.normalized,
          offset: livePositionAttribute.offset,
          size: livePositionAttribute.size,
          stride: livePositionAttribute.stride,
          typeIsFloat:
            livePositionAttribute.type === gl.FLOAT,
        },
        liveColor: {
          normalized: liveColorAttribute.normalized,
          offset: liveColorAttribute.offset,
          size: liveColorAttribute.size,
          stride: liveColorAttribute.stride,
          typeIsUnsignedByte:
            liveColorAttribute.type === gl.UNSIGNED_BYTE,
        },
        splitPositionIsPooled:
          splitPositionAttribute.buffer === geometry.positionBuffer.segments[0].buffer,
        // A snapshot of the live generation draws the live position store.
        splitPositionIsLive:
          splitPositionAttribute.buffer === renderer.buffers.positions.segments[0].buffer,
        splitColorIsPerSnapshot:
          splitColorAttribute.buffer === first.buffer.segments[0].buffer,
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
  }, { pointCount: configuredPointCount, samples: configuredSamples });

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
    transparencyByReference: true,
    byteLength: result.snapshotAlpha.expectedByteLength,
    distinctOwners: true,
    expectedByteLength: result.snapshotAlpha.expectedByteLength,
    owned: true,
  });
  expect(result.bindings).toMatchObject({
    liveStreamsAreSeparate: true,
    livePosition: {
      normalized: false,
      offset: 0,
      size: 2,
      stride: 8,
      typeIsFloat: true,
    },
    liveColor: {
      normalized: true,
      offset: 0,
      size: 4,
      stride: 4,
      typeIsUnsignedByte: true,
    },
    splitPositionIsPooled: true,
    splitPositionIsLive: true,
    splitColorIsPerSnapshot: true,
    sameGenerationPositionShared: true,
    splitPosition: {
      normalized: false,
      offset: 0,
      size: 2,
      stride: 8,
      typeIsFloat: true,
    },
    splitColor: {
      normalized: true,
      offset: 0,
      size: 4,
      stride: 4,
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
    `${result.gpuMedians === null ? 'wall' : 'GPU'} full live RGBA ` +
    `${(result.gpuMedians ?? result.medians).fullLive.toFixed(3)} ms/draw, ` +
    `split RGBA+R8 ${(result.gpuMedians ?? result.medians).fullSplit.toFixed(3)} ms/draw; ` +
    `indexed(${result.indexedCount.toLocaleString()}) live RGBA ` +
    `${(result.gpuMedians ?? result.medians).indexedLive.toFixed(3)} ms/draw, ` +
    `split RGBA+R8 ${(result.gpuMedians ?? result.medians).indexedSplit.toFixed(3)} ms/draw; ` +
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
