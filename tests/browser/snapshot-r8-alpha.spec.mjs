import { expect, test } from '@playwright/test';

const WEBGL_HARNESS = '/tests/browser/fixtures/webgl-harness.html';

test('snapshot R8 alpha stays exact through every draw and resource lifecycle', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.goto(WEBGL_HARNESS);

  const proof = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 128;
    canvas.style.cssText =
      'width:512px;height:256px;image-rendering:pixelated';
    document.body.append(canvas);
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      powerPreference: 'high-performance',
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      stencil: false,
    });
    if (!(gl instanceof WebGL2RenderingContext)) {
      return {
        supported: false,
        userAgent: navigator.userAgent,
      };
    }

    const prototype = WebGL2RenderingContext.prototype;
    const originals = {
      bufferData: prototype.bufferData,
      createBuffer: prototype.createBuffer,
      createTexture: prototype.createTexture,
      createVertexArray: prototype.createVertexArray,
      deleteBuffer: prototype.deleteBuffer,
      deleteTexture: prototype.deleteTexture,
      deleteVertexArray: prototype.deleteVertexArray,
      getError: prototype.getError,
      getParameter: prototype.getParameter,
      texImage2D: prototype.texImage2D,
      texSubImage2D: prototype.texSubImage2D,
    };
    const calls = {
      bufferData: [],
      createBuffer: [],
      createTexture: [],
      createVertexArray: [],
      deleteBuffer: [],
      deleteTexture: [],
      deleteVertexArray: [],
      texImage2D: [],
      texSubImage2D: [],
    };
    const lifecycle = [];
    const textureMirrors = new Map();
    const controlledMaxTextureSize = 64;
    let injectedTexture = null;
    let syntheticErrorPending = false;

    const byteLengthOf = value => {
      if (typeof value === 'number') return value;
      if (ArrayBuffer.isView(value)) return value.byteLength;
      if (value instanceof ArrayBuffer) return value.byteLength;
      return 0;
    };
    const captureCounts = () => Object.fromEntries(
      Object.entries(calls).map(([key, values]) => [
        key,
        values.length,
      ]),
    );
    const countDelta = (before, after) => Object.fromEntries(
      Object.keys(after).map(key => [
        key,
        after[key] - before[key],
      ]),
    );

    prototype.createBuffer = function (...args) {
      const handle = Reflect.apply(
        originals.createBuffer,
        this,
        args,
      );
      if (this === gl) calls.createBuffer.push(handle);
      return handle;
    };
    prototype.createTexture = function (...args) {
      const handle = Reflect.apply(
        originals.createTexture,
        this,
        args,
      );
      if (this === gl) calls.createTexture.push(handle);
      return handle;
    };
    prototype.createVertexArray = function (...args) {
      const handle = Reflect.apply(
        originals.createVertexArray,
        this,
        args,
      );
      if (this === gl) calls.createVertexArray.push(handle);
      return handle;
    };
    prototype.bufferData = function (...args) {
      const result = Reflect.apply(
        originals.bufferData,
        this,
        args,
      );
      if (this === gl) {
        calls.bufferData.push({
          byteLength: byteLengthOf(args[1]),
          target: args[0],
        });
      }
      return result;
    };
    prototype.texImage2D = function (...args) {
      const texture = this === gl
        ? this.getParameter(this.TEXTURE_BINDING_2D)
        : null;
      const result = Reflect.apply(
        originals.texImage2D,
        this,
        args,
      );
      if (this === gl) {
        calls.texImage2D.push({
          format: args[6],
          height: args[4],
          internalFormat: args[2],
          texture,
          type: args[7],
          width: args[3],
        });
        if (
          texture !== null &&
          args[2] === this.R8 &&
          args[6] === this.RED &&
          args[7] === this.UNSIGNED_BYTE
        ) {
          const width = args[3];
          const height = args[4];
          const bytes = new Uint8Array(width * height);
          const source = args[8];
          if (source instanceof Uint8Array) {
            bytes.set(source.subarray(0, bytes.length));
          }
          textureMirrors.set(texture, {
            bytes,
            height,
            width,
          });
        }
      }
      return result;
    };
    prototype.texSubImage2D = function (...args) {
      const texture = this === gl
        ? this.getParameter(this.TEXTURE_BINDING_2D)
        : null;
      const result = Reflect.apply(
        originals.texSubImage2D,
        this,
        args,
      );
      if (this === gl) {
        calls.texSubImage2D.push({
          format: args[6],
          height: args[5],
          texture,
          type: args[7],
          width: args[4],
          x: args[2],
          y: args[3],
        });
        const mirror = textureMirrors.get(texture);
        const source = args[8];
        if (
          mirror &&
          args[6] === this.RED &&
          args[7] === this.UNSIGNED_BYTE &&
          source instanceof Uint8Array
        ) {
          const sourceOffset =
            Number.isSafeInteger(args[9]) ? args[9] : 0;
          for (let row = 0; row < args[5]; row++) {
            const sourceStart =
              sourceOffset + row * args[4];
            mirror.bytes.set(
              source.subarray(
                sourceStart,
                sourceStart + args[4],
              ),
              (args[3] + row) * mirror.width + args[2],
            );
          }
        }
        if (texture !== null && texture === injectedTexture) {
          injectedTexture = null;
          syntheticErrorPending = true;
        }
      }
      return result;
    };
    prototype.getError = function (...args) {
      if (this === gl && syntheticErrorPending) {
        syntheticErrorPending = false;
        return this.OUT_OF_MEMORY;
      }
      return Reflect.apply(originals.getError, this, args);
    };
    prototype.getParameter = function (parameter) {
      if (
        this === gl &&
        parameter === this.MAX_TEXTURE_SIZE
      ) {
        // Keep the real WebGL upload/draw path while forcing a compact
        // multi-row layout with a padded final row. Production devices expose
        // a much larger limit, which would make this boundary proof needlessly
        // allocate tens of thousands of points in every browser project.
        return controlledMaxTextureSize;
      }
      return Reflect.apply(
        originals.getParameter,
        this,
        [parameter],
      );
    };
    prototype.deleteVertexArray = function (handle) {
      if (this === gl) {
        calls.deleteVertexArray.push(handle);
        lifecycle.push({
          handle,
          kind: 'deleteVertexArray',
        });
      }
      return Reflect.apply(
        originals.deleteVertexArray,
        this,
        [handle],
      );
    };
    prototype.deleteBuffer = function (handle) {
      if (this === gl) {
        calls.deleteBuffer.push(handle);
        lifecycle.push({
          handle,
          kind: 'deleteBuffer',
        });
      }
      return Reflect.apply(
        originals.deleteBuffer,
        this,
        [handle],
      );
    };
    prototype.deleteTexture = function (handle) {
      if (this === gl) {
        calls.deleteTexture.push(handle);
        lifecycle.push({
          handle,
          kind: 'deleteTexture',
        });
      }
      textureMirrors.delete(handle);
      return Reflect.apply(
        originals.deleteTexture,
        this,
        [handle],
      );
    };

    let renderer = null;
    let legacyBuffer = null;
    let legacyVao = null;
    try {
      const {
        HighPerfRenderer,
      } = await import(
        '/assets/js/rendering/high-perf-renderer.js'
      );
      const pointCount = 1025;
      const gridSide = 32;
      const positions = new Float32Array(pointCount * 3);
      const colors = new Uint8Array(pointCount * 4);
      const initialAlphas = new Float32Array(pointCount);
      for (let index = 0; index < pointCount; index++) {
        const column = index % gridSide;
        const row = Math.floor(index / gridSide);
        // The final eight columns are outside the identity frustum so both
        // indexed frustum branches must reject real geometry.
        positions[index * 3] = column < 24
          ? ((column + 0.5) / 24) * 1.8 - 0.9
          : 1.35 + (column - 24) * 0.04;
        positions[index * 3 + 1] =
          ((row + 0.5) / gridSide) * 1.8 - 0.9;
        positions[index * 3 + 2] = 0;
        colors[index * 4] = 32 + ((index * 17) % 208);
        colors[index * 4 + 1] =
          32 + ((index * 29) % 208);
        colors[index * 4 + 2] =
          32 + ((index * 43) % 208);
        // Deliberately disagree with the authoritative Float alpha owner.
        colors[index * 4 + 3] = 255;
        initialAlphas[index] =
          [0, 0.25, 0.5, 0.75, 1][index % 5];
      }

      renderer = new HighPerfRenderer(gl, {
        LOD_MAX_DEPTH: 8,
        LOD_MAX_POINTS_PER_NODE: 32,
        USE_FRUSTUM_CULLING: false,
        USE_LOD: false,
      });
      renderer.loadData(positions, colors, {
        alphaValues: initialAlphas,
        buildSpatialIndex: false,
        dimensionLevel: 2,
      });

      const beforeCreate = captureCounts();
      renderer.createSnapshotBuffer(
        'snapshot-r8',
        colors,
        initialAlphas,
        positions,
        2,
        'live',
      );
      const afterCreate = captureCounts();
      const createDelta = countDelta(
        beforeCreate,
        afterCreate,
      );
      const snapshot =
        renderer.snapshotBuffers.get('snapshot-r8');
      const geometry = renderer._snapshotGeometryPools.get(
        snapshot.geometryGeneration,
      );
      const snapshotTexture = snapshot.alphaTexture;
      const initialAcceptedAlphaOwner =
        snapshot.alphaTexData;
      const snapshotMirror =
        textureMirrors.get(snapshotTexture);

      gl.bindVertexArray(snapshot.vao);
      const colorAttribute = {
        buffer: gl.getVertexAttrib(
          1,
          gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING,
        ),
        normalized: gl.getVertexAttrib(
          1,
          gl.VERTEX_ATTRIB_ARRAY_NORMALIZED,
        ),
        offset: gl.getVertexAttribOffset(
          1,
          gl.VERTEX_ATTRIB_ARRAY_POINTER,
        ),
        size: gl.getVertexAttrib(
          1,
          gl.VERTEX_ATTRIB_ARRAY_SIZE,
        ),
        stride: gl.getVertexAttrib(
          1,
          gl.VERTEX_ATTRIB_ARRAY_STRIDE,
        ),
        type: gl.getVertexAttrib(
          1,
          gl.VERTEX_ATTRIB_ARRAY_TYPE,
        ),
      };
      gl.bindVertexArray(null);

      const expectedInitialBytes =
        Uint8Array.from(initialAlphas, value =>
          Math.round(value * 255)
        );
      const ownership = {
        acceptedBytesExact:
          snapshot.alphaTexData instanceof Uint8Array &&
          snapshot.alphaTexData.length ===
            snapshot.alphaTexWidth * snapshot.alphaTexHeight &&
          expectedInitialBytes.every(
            (value, index) =>
              snapshot.alphaTexData[index] === value,
          ),
        alphaTextureDistinctFromLive:
          snapshotTexture !== renderer.getAlphaTexture(),
        alphaTextureMirrored:
          snapshotMirror !== undefined &&
          expectedInitialBytes.every(
            (value, index) =>
              snapshotMirror.bytes[index] === value,
          ),
        alphaTextureShapeExact:
          snapshot.alphaTexWidth ===
            controlledMaxTextureSize &&
          snapshot.alphaTexHeight ===
            Math.ceil(
              pointCount / controlledMaxTextureSize
            ) &&
          snapshot.alphaTextureByteLength ===
            snapshot.alphaTexWidth *
              snapshot.alphaTexHeight,
        crossRowBoundariesExact: [
          controlledMaxTextureSize - 1,
          controlledMaxTextureSize,
          controlledMaxTextureSize + 1,
        ].every(index =>
          snapshot.alphaTexData[index] ===
            expectedInitialBytes[index] &&
          snapshotMirror?.bytes[index] ===
            expectedInitialBytes[index]
        ),
        paddedTailOpaque:
          snapshot.alphaTexData
            .subarray(pointCount)
            .every(value => value === 255) &&
          snapshotMirror?.bytes
            .subarray(pointCount)
            .every(value => value === 255),
        colorAttribute: {
          bufferMatches: colorAttribute.buffer === snapshot.buffer,
          normalized: colorAttribute.normalized,
          offset: colorAttribute.offset,
          size: colorAttribute.size,
          stride: colorAttribute.stride,
          typeIsUnsignedByte:
            colorAttribute.type === gl.UNSIGNED_BYTE,
        },
        colorBytesExact:
          snapshot.bufferByteLength === pointCount * 3,
        noPerSnapshotColorOwner:
          !Object.hasOwn(snapshot, 'colors'),
        noPerSnapshotFloatAlphaOwner:
          !Object.values(snapshot).some(
            value =>
              value instanceof Float32Array &&
              value.length === pointCount,
          ),
        sharedColorScratch:
          renderer._snapshotColorStagingData
            instanceof Uint8Array &&
          renderer._snapshotColorStagingData.length ===
            pointCount * 3,
        sharedGeometryPositionBytes:
          geometry.positionBufferByteLength ===
            pointCount * 12,
      };

      const identity = () => Float32Array.from([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
      ]);
      const baseParams = {
        autoFog: false,
        cameraDistance: 3,
        cameraPosition: Float32Array.from([0, 0, 3]),
        dimensionLevel: 2,
        fogColor: Float32Array.from([0, 0, 0]),
        fogDensity: 0,
        forceLOD: -1,
        fov: Math.PI / 3,
        lightDir: Float32Array.from([0, 0, 1]),
        lightingStrength: 0,
        modelMatrix: identity(),
        mvpMatrix: identity(),
        pointSize: 3,
        projectionMatrix: identity(),
        quality: 'ultralight',
        sizeAttenuation: 0,
        useAlphaTexture: false,
        viewMatrix: identity(),
        viewportHeight: 128,
        viewportWidth: 128,
      };
      const comparePanePixels = pixels => {
        let mismatches = 0;
        let leftHash = 2166136261;
        let rightHash = 2166136261;
        for (let y = 0; y < 128; y++) {
          for (let x = 0; x < 128; x++) {
            const leftOffset = (y * 256 + x) * 4;
            const rightOffset =
              (y * 256 + x + 128) * 4;
            for (let channel = 0; channel < 4; channel++) {
              const left = pixels[leftOffset + channel];
              const right = pixels[rightOffset + channel];
              if (left !== right) mismatches++;
              leftHash = Math.imul(
                leftHash ^ left,
                16777619,
              );
              rightHash = Math.imul(
                rightHash ^ right,
                16777619,
              );
            }
          }
        }
        return {
          leftHash: leftHash >>> 0,
          mismatches,
          rightHash: rightHash >>> 0,
        };
      };
      const renderPair = ({
        forceLOD,
        frustum,
        name,
        snapshotUseAlphaTexture = false,
      }) => {
        renderer.setAdaptiveLOD(false);
        renderer.setFrustumCulling(frustum);
        gl.disable(gl.SCISSOR_TEST);
        gl.viewport(0, 0, 256, 128);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.viewport(0, 0, 128, 128);
        const liveStats = renderer.render({
          ...baseParams,
          forceLOD,
          useAlphaTexture: true,
          viewId: 'live',
        });
        gl.viewport(128, 0, 128, 128);
        const snapshotStats =
          renderer.renderWithSnapshot('snapshot-r8', {
            ...baseParams,
            forceLOD,
            useAlphaTexture: snapshotUseAlphaTexture,
            viewId: 'snapshot-r8',
          });
        gl.finish();
        const pixels = new Uint8Array(256 * 128 * 4);
        gl.readPixels(
          0,
          0,
          256,
          128,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          pixels,
        );
        return {
          name,
          pixels: comparePanePixels(pixels),
          stats: {
            live: {
              frustumCulled: liveStats.frustumCulled,
              lodLevel: liveStats.lodLevel,
              visiblePoints: liveStats.visiblePoints,
            },
            snapshot: {
              frustumCulled:
                snapshotStats.frustumCulled,
              lodLevel: snapshotStats.lodLevel,
              visiblePoints: snapshotStats.visiblePoints,
            },
          },
        };
      };
      const drawBranches = [
        renderPair({
          forceLOD: -1,
          frustum: false,
          name: 'direct',
        }),
        renderPair({
          forceLOD: 0,
          frustum: false,
          name: 'reduced-lod',
        }),
        renderPair({
          forceLOD: -1,
          frustum: true,
          name: 'full-frustum',
        }),
        renderPair({
          forceLOD: 0,
          frustum: true,
          name: 'reduced-lod-frustum',
        }),
      ];

      // Build the previous split-RGBA/baked-alpha layout against the same
      // pooled position owner. It is diagnostic-only, but its exact pixels
      // prove the new RGB+R8 publication preserves the old visual contract.
      const legacyColors = colors.slice();
      for (let index = 0; index < pointCount; index++) {
        legacyColors[index * 4 + 3] =
          expectedInitialBytes[index];
      }
      legacyBuffer = gl.createBuffer();
      legacyVao = gl.createVertexArray();
      gl.bindBuffer(gl.ARRAY_BUFFER, legacyBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        legacyColors,
        gl.STATIC_DRAW,
      );
      gl.bindVertexArray(legacyVao);
      gl.bindBuffer(
        gl.ARRAY_BUFFER,
        geometry.positionBuffer,
      );
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(
        0,
        3,
        gl.FLOAT,
        false,
        12,
        0,
      );
      gl.bindBuffer(gl.ARRAY_BUFFER, legacyBuffer);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(
        1,
        4,
        gl.UNSIGNED_BYTE,
        true,
        4,
        0,
      );
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);

      renderer.setAdaptiveLOD(false);
      renderer.setFrustumCulling(false);
      gl.viewport(0, 0, 128, 128);
      gl.clear(gl.COLOR_BUFFER_BIT);
      renderer.renderWithSnapshot('snapshot-r8', {
        ...baseParams,
        viewId: 'snapshot-r8',
      });
      gl.finish();
      const productionPixels = new Uint8Array(128 * 128 * 4);
      gl.readPixels(
        0,
        0,
        128,
        128,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        productionPixels,
      );
      const uniforms =
        renderer.uniformLocations.get('ultralight');
      const program = renderer.activeProgram;
      const configureLegacy = () => {
        gl.useProgram(program);
        if (uniforms.u_useAlphaTex !== null) {
          gl.uniform1i(uniforms.u_useAlphaTex, 0);
        }
        if (renderer._dummyLodIndexTexture) {
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(
            gl.TEXTURE_2D,
            renderer._dummyLodIndexTexture,
          );
          if (uniforms.u_lodIndexTex !== null) {
            gl.uniform1i(uniforms.u_lodIndexTex, 1);
          }
        }
        if (uniforms.u_useLodIndexTex !== null) {
          gl.uniform1i(uniforms.u_useLodIndexTex, 0);
        }
      };
      gl.clear(gl.COLOR_BUFFER_BIT);
      configureLegacy();
      gl.bindVertexArray(legacyVao);
      gl.drawArrays(gl.POINTS, 0, pointCount);
      gl.bindVertexArray(null);
      gl.finish();
      const legacyPixels = new Uint8Array(128 * 128 * 4);
      gl.readPixels(
        0,
        0,
        128,
        128,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        legacyPixels,
      );
      const compareLinearPixels = (left, right) => {
        let mismatches = 0;
        let leftHash = 2166136261;
        let rightHash = 2166136261;
        for (let index = 0; index < left.length; index++) {
          if (left[index] !== right[index]) mismatches++;
          leftHash = Math.imul(
            leftHash ^ left[index],
            16777619,
          );
          rightHash = Math.imul(
            rightHash ^ right[index],
            16777619,
          );
        }
        return {
          leftHash: leftHash >>> 0,
          mismatches,
          rightHash: rightHash >>> 0,
        };
      };
      const legacyPixelsComparison = compareLinearPixels(
        productionPixels,
        legacyPixels,
      );

      // Preserve the original 32-draw timing sample while keeping each
      // synchronous submission batch below browser/driver watchdog windows.
      // Excluding frame-service time keeps the diagnostic about draw work.
      const drawsPerBatch = 8;
      const batchesPerSample = 4;
      const drawsPerSample = drawsPerBatch * batchesPerSample;
      const measure = async (configure, vao) => {
        const start = performance.now();
        let frameServiceTime = 0;
        for (let batch = 0; batch < batchesPerSample; batch++) {
          gl.finish();
          for (let draw = 0; draw < drawsPerBatch; draw++) {
            configure();
            gl.bindVertexArray(vao);
            gl.drawArrays(gl.POINTS, 0, pointCount);
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
      const configureProduction = () => {
        gl.useProgram(program);
        renderer._bindSnapshotAlphaTexture(
          gl,
          uniforms,
          snapshot,
          false,
          2,
        );
      };
      // Warm shaders, texture sampling, and both attribute layouts.
      await measure(configureProduction, snapshot.vao);
      await measure(configureLegacy, legacyVao);
      const timingSamples = {
        legacyRgbaBakedMs: [],
        snapshotRgbR8Ms: [],
      };
      for (let sample = 0; sample < 7; sample++) {
        const order = sample % 2 === 0
          ? [
              [
                'snapshotRgbR8Ms',
                configureProduction,
                snapshot.vao,
              ],
              [
                'legacyRgbaBakedMs',
                configureLegacy,
                legacyVao,
              ],
            ]
          : [
              [
                'legacyRgbaBakedMs',
                configureLegacy,
                legacyVao,
              ],
              [
                'snapshotRgbR8Ms',
                configureProduction,
                snapshot.vao,
              ],
            ];
        for (const [key, configure, vao] of order) {
          timingSamples[key].push(
            await measure(configure, vao),
          );
        }
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      const median = values => {
        const sorted = [...values].sort(
          (left, right) => left - right,
        );
        return sorted[Math.floor(sorted.length / 2)];
      };
      const timingDiagnostic = {
        drawsPerBatch,
        drawsPerSample,
        medians: {
          legacyRgbaBakedMs:
            median(timingSamples.legacyRgbaBakedMs),
          snapshotRgbR8Ms:
            median(timingSamples.snapshotRgbR8Ms),
        },
        runtime: {
          renderer: gl.getParameter(gl.RENDERER),
          userAgent: navigator.userAgent,
          vendor: gl.getParameter(gl.VENDOR),
          version: gl.getParameter(gl.VERSION),
        },
        samples: timingSamples,
      };

      gl.deleteVertexArray(legacyVao);
      gl.deleteBuffer(legacyBuffer);
      legacyVao = null;
      legacyBuffer = null;

      // All draw-path and one-off diagnostic allocations are complete.
      // From this point onward, every resource delta belongs only to the
      // snapshot attribute operation under test.
      const beforeNoOp = captureCounts();
      const r8EquivalentAlphas =
        Float32Array.from(expectedInitialBytes, value =>
          value / 255
        );
      renderer.updateSnapshotAlphas(
        'snapshot-r8',
        r8EquivalentAlphas,
      );
      const noOpDelta = countDelta(
        beforeNoOp,
        captureCounts(),
      );

      const changedAlphas = Float32Array.from(
        initialAlphas,
        value => 1 - value,
      );
      const stableResources = {
        alphaTexture: snapshot.alphaTexture,
        buffer: snapshot.buffer,
        geometryGeneration: snapshot.geometryGeneration,
        positionBuffer: geometry.positionBuffer,
        vao: snapshot.vao,
      };
      const beforeChanged = captureCounts();
      renderer.updateSnapshotAlphas(
        'snapshot-r8',
        changedAlphas,
      );
      const changedDelta = countDelta(
        beforeChanged,
        captureCounts(),
      );
      const changedOwner = snapshot.alphaTexData;
      const changedBytes =
        Uint8Array.from(changedAlphas, value =>
          Math.round(value * 255)
        );
      const changedPublication = {
        acceptedOwnerAdvanced:
          changedOwner !== initialAcceptedAlphaOwner,
        bytesExact: changedBytes.every(
          (value, index) =>
            snapshot.alphaTexData[index] === value &&
            textureMirrors.get(snapshot.alphaTexture)
              ?.bytes[index] === value,
        ),
        resourcesStable:
          snapshot.alphaTexture ===
            stableResources.alphaTexture &&
          snapshot.buffer === stableResources.buffer &&
          snapshot.geometryGeneration ===
            stableResources.geometryGeneration &&
          geometry.positionBuffer ===
            stableResources.positionBuffer &&
          snapshot.vao === stableResources.vao,
      };
      const changedSnapshotDraw = renderPair({
        forceLOD: -1,
        frustum: false,
        name: 'changed-snapshot-alpha',
      });
      const changedLiveOverrideDraw = renderPair({
        forceLOD: -1,
        frustum: false,
        name: 'changed-live-alpha-override',
        snapshotUseAlphaTexture: true,
      });
      const changedRender = {
        liveOverrideMatches:
          changedLiveOverrideDraw.pixels.mismatches === 0 &&
          changedLiveOverrideDraw.pixels.leftHash ===
            changedLiveOverrideDraw.pixels.rightHash,
        snapshotDiverges:
          changedSnapshotDraw.pixels.mismatches > 0 &&
          changedSnapshotDraw.pixels.leftHash !==
            changedSnapshotDraw.pixels.rightHash,
      };

      const failureCandidate = changedAlphas.slice();
      failureCandidate[3] = 0;
      failureCandidate[4] = 0;
      const acceptedBeforeFailure =
        snapshot.alphaTexData;
      const acceptedBytesBeforeFailure =
        snapshot.alphaTexData.slice();
      const beforeFailure = captureCounts();
      injectedTexture = snapshot.alphaTexture;
      let failure = null;
      try {
        renderer.updateSnapshotAlphas(
          'snapshot-r8',
          failureCandidate,
        );
      } catch (error) {
        failure = {
          message: error.message,
          name: error.name,
        };
      }
      const failureDelta = countDelta(
        beforeFailure,
        captureCounts(),
      );
      const failurePublication = {
        acceptedBytesRestored:
          acceptedBytesBeforeFailure.every(
            (value, index) =>
              snapshot.alphaTexData[index] === value &&
              textureMirrors.get(snapshot.alphaTexture)
                ?.bytes[index] === value,
          ),
        acceptedOwnerPreserved:
          snapshot.alphaTexData === acceptedBeforeFailure,
        failure,
        resourcesStable:
          snapshot.alphaTexture ===
            stableResources.alphaTexture &&
          snapshot.buffer === stableResources.buffer &&
          snapshot.geometryGeneration ===
            stableResources.geometryGeneration &&
          snapshot.vao === stableResources.vao,
      };

      const beforeRetry = captureCounts();
      renderer.updateSnapshotAlphas(
        'snapshot-r8',
        failureCandidate,
      );
      const retryDelta = countDelta(
        beforeRetry,
        captureCounts(),
      );
      const retryBytes =
        Uint8Array.from(failureCandidate, value =>
          Math.round(value * 255)
        );
      const retryPublication = {
        acceptedOwnerAdvanced:
          snapshot.alphaTexData !==
            acceptedBeforeFailure,
        bytesExact: retryBytes.every(
          (value, index) =>
            snapshot.alphaTexData[index] === value &&
            textureMirrors.get(snapshot.alphaTexture)
              ?.bytes[index] === value,
        ),
        resourcesStable:
          snapshot.alphaTexture ===
            stableResources.alphaTexture &&
          snapshot.buffer === stableResources.buffer &&
          snapshot.geometryGeneration ===
            stableResources.geometryGeneration &&
          snapshot.vao === stableResources.vao,
      };

      const colorBufferBeforePositions = snapshot.buffer;
      const alphaTextureBeforePositions =
        snapshot.alphaTexture;
      const alphaOwnerBeforePositions =
        snapshot.alphaTexData;
      const vaoBeforePositions = snapshot.vao;
      const generationBeforePositions =
        snapshot.geometryGeneration;
      const beforePositionDraw = renderPair({
        forceLOD: -1,
        frustum: false,
        name: 'before-position-replacement',
      });
      const replacementPositions =
        renderer.getSnapshotPositions('snapshot-r8').slice();
      replacementPositions[0] += 0.12;
      renderer.updateSnapshotPositions(
        'snapshot-r8',
        replacementPositions,
        2,
      );
      const afterPositionDraw = renderPair({
        forceLOD: -1,
        frustum: false,
        name: 'after-position-replacement',
      });
      const positionPublication = {
        alphaOwnerPreserved:
          snapshot.alphaTexData === alphaOwnerBeforePositions,
        alphaTexturePreserved:
          snapshot.alphaTexture ===
            alphaTextureBeforePositions,
        colorBufferPreserved:
          snapshot.buffer === colorBufferBeforePositions,
        geometryAdvanced:
          snapshot.geometryGeneration !==
            generationBeforePositions,
        renderedAlphaOwnerPreserved:
          beforePositionDraw.pixels.mismatches > 0 &&
          afterPositionDraw.pixels.mismatches > 0,
        renderedGeometryAdvanced:
          beforePositionDraw.pixels.rightHash !==
            afterPositionDraw.pixels.rightHash,
        vaoReplaced: snapshot.vao !== vaoBeforePositions,
      };

      const retiredSnapshot = {
        alphaTexture: snapshot.alphaTexture,
        buffer: snapshot.buffer,
        vao: snapshot.vao,
      };
      const lifecycleStart = lifecycle.length;
      const beforeDelete = captureCounts();
      renderer.deleteSnapshotBuffer('snapshot-r8');
      const deleteDelta = countDelta(
        beforeDelete,
        captureCounts(),
      );
      const retirementEvents =
        lifecycle.slice(lifecycleStart);
      const vaoRetirementIndex =
        retirementEvents.findIndex(
          event =>
            event.kind === 'deleteVertexArray' &&
            event.handle === retiredSnapshot.vao,
        );
      const alphaRetirementIndex =
        retirementEvents.findIndex(
          event =>
            event.kind === 'deleteTexture' &&
            event.handle === retiredSnapshot.alphaTexture,
        );
      const retirement = {
        alphaTextureDeleted:
          alphaRetirementIndex >= 0,
        bufferDeleted: retirementEvents.some(
          event =>
            event.kind === 'deleteBuffer' &&
            event.handle === retiredSnapshot.buffer,
        ),
        detached:
          !renderer.snapshotBuffers.has('snapshot-r8'),
        textureAfterVaoBarrier:
          vaoRetirementIndex >= 0 &&
          alphaRetirementIndex > vaoRetirementIndex,
        vaoDeleted: vaoRetirementIndex >= 0,
      };

      return {
        createDelta,
        changedRender,
        deleteDelta,
        drawBranches,
        failureDelta,
        failurePublication,
        glError: gl.getError(),
        legacyPixelsComparison,
        noOpDelta,
        ownership,
        positionPublication,
        retryDelta,
        retryPublication,
        changedDelta,
        changedPublication,
        retirement,
        supported: true,
        timingDiagnostic,
      };
    } finally {
      injectedTexture = null;
      syntheticErrorPending = false;
      if (legacyVao !== null) {
        try {
          gl.deleteVertexArray(legacyVao);
        } catch {
          // Renderer teardown below remains independent.
        }
      }
      if (legacyBuffer !== null) {
        try {
          gl.deleteBuffer(legacyBuffer);
        } catch {
          // Renderer teardown below remains independent.
        }
      }
      try {
        renderer?.dispose();
      } finally {
        prototype.bufferData = originals.bufferData;
        prototype.createBuffer = originals.createBuffer;
        prototype.createTexture = originals.createTexture;
        prototype.createVertexArray =
          originals.createVertexArray;
        prototype.deleteBuffer = originals.deleteBuffer;
        prototype.deleteTexture = originals.deleteTexture;
        prototype.deleteVertexArray =
          originals.deleteVertexArray;
        prototype.getError = originals.getError;
        prototype.getParameter = originals.getParameter;
        prototype.texImage2D = originals.texImage2D;
        prototype.texSubImage2D =
          originals.texSubImage2D;
      }
    }
  });

  expect(proof.supported).toBe(true);
  expect(proof.ownership).toEqual({
    acceptedBytesExact: true,
    alphaTextureDistinctFromLive: true,
    alphaTextureMirrored: true,
    alphaTextureShapeExact: true,
    crossRowBoundariesExact: true,
    colorAttribute: {
      bufferMatches: true,
      normalized: true,
      offset: 0,
      size: 3,
      stride: 3,
      typeIsUnsignedByte: true,
    },
    colorBytesExact: true,
    noPerSnapshotColorOwner: true,
    noPerSnapshotFloatAlphaOwner: true,
    paddedTailOpaque: true,
    sharedColorScratch: true,
    sharedGeometryPositionBytes: true,
  });
  expect(proof.createDelta).toEqual({
    bufferData: 2,
    createBuffer: 2,
    createTexture: 1,
    createVertexArray: 1,
    deleteBuffer: 0,
    deleteTexture: 0,
    deleteVertexArray: 0,
    texImage2D: 1,
    texSubImage2D: 0,
  });

  expect(
    proof.drawBranches.map(branch => ({
      mismatches: branch.pixels.mismatches,
      name: branch.name,
      sameHash:
        branch.pixels.leftHash ===
        branch.pixels.rightHash,
      sameStats:
        JSON.stringify(branch.stats.live) ===
        JSON.stringify(branch.stats.snapshot),
    })),
  ).toEqual([
    {
      mismatches: 0,
      name: 'direct',
      sameHash: true,
      sameStats: true,
    },
    {
      mismatches: 0,
      name: 'reduced-lod',
      sameHash: true,
      sameStats: true,
    },
    {
      mismatches: 0,
      name: 'full-frustum',
      sameHash: true,
      sameStats: true,
    },
    {
      mismatches: 0,
      name: 'reduced-lod-frustum',
      sameHash: true,
      sameStats: true,
    },
  ]);
  expect(
    proof.drawBranches.find(
      branch => branch.name === 'direct',
    ).stats.live,
  ).toEqual({
    frustumCulled: false,
    lodLevel: -1,
    visiblePoints: 1025,
  });
  expect(
    proof.drawBranches.find(
      branch => branch.name === 'reduced-lod',
    ).stats.live,
  ).toEqual({
    frustumCulled: false,
    lodLevel: 0,
    visiblePoints: 1000,
  });
  const fullFrustum = proof.drawBranches.find(
    branch => branch.name === 'full-frustum',
  ).stats.live;
  expect(fullFrustum.frustumCulled).toBe(true);
  expect(fullFrustum.lodLevel).toBe(-1);
  expect(fullFrustum.visiblePoints).toBeLessThan(1025);
  const reducedFrustum = proof.drawBranches.find(
    branch => branch.name === 'reduced-lod-frustum',
  ).stats.live;
  expect(reducedFrustum.frustumCulled).toBe(true);
  expect(reducedFrustum.lodLevel).toBe(0);
  expect(reducedFrustum.visiblePoints).toBeLessThan(1000);
  expect(proof.legacyPixelsComparison.mismatches).toBe(0);
  expect(proof.legacyPixelsComparison.leftHash).toBe(
    proof.legacyPixelsComparison.rightHash,
  );

  expect(proof.noOpDelta).toEqual({
    bufferData: 0,
    createBuffer: 0,
    createTexture: 0,
    createVertexArray: 0,
    deleteBuffer: 0,
    deleteTexture: 0,
    deleteVertexArray: 0,
    texImage2D: 0,
    texSubImage2D: 0,
  });
  expect(proof.changedDelta).toEqual({
    bufferData: 0,
    createBuffer: 0,
    createTexture: 0,
    createVertexArray: 0,
    deleteBuffer: 0,
    deleteTexture: 0,
    deleteVertexArray: 0,
    texImage2D: 0,
    texSubImage2D: 1,
  });
  expect(proof.changedPublication).toEqual({
    acceptedOwnerAdvanced: true,
    bytesExact: true,
    resourcesStable: true,
  });
  expect(proof.changedRender).toEqual({
    liveOverrideMatches: true,
    snapshotDiverges: true,
  });
  expect(proof.failureDelta).toEqual({
    bufferData: 0,
    createBuffer: 0,
    createTexture: 0,
    createVertexArray: 0,
    deleteBuffer: 0,
    deleteTexture: 0,
    deleteVertexArray: 0,
    texImage2D: 0,
    texSubImage2D: 2,
  });
  expect(proof.failurePublication).toEqual({
    acceptedBytesRestored: true,
    acceptedOwnerPreserved: true,
    failure: {
      message: expect.stringMatching(
        /snapshot.*alpha.*WebGL error/i,
      ),
      name: 'Error',
    },
    resourcesStable: true,
  });
  expect(proof.retryDelta).toEqual({
    bufferData: 0,
    createBuffer: 0,
    createTexture: 0,
    createVertexArray: 0,
    deleteBuffer: 0,
    deleteTexture: 0,
    deleteVertexArray: 0,
    texImage2D: 0,
    texSubImage2D: 1,
  });
  expect(proof.retryPublication).toEqual({
    acceptedOwnerAdvanced: true,
    bytesExact: true,
    resourcesStable: true,
  });
  expect(proof.positionPublication).toEqual({
    alphaOwnerPreserved: true,
    alphaTexturePreserved: true,
    colorBufferPreserved: true,
    geometryAdvanced: true,
    renderedAlphaOwnerPreserved: true,
    renderedGeometryAdvanced: true,
    vaoReplaced: true,
  });
  expect(proof.retirement).toEqual({
    alphaTextureDeleted: true,
    bufferDeleted: true,
    detached: true,
    textureAfterVaoBarrier: true,
    vaoDeleted: true,
  });
  expect(proof.deleteDelta.deleteTexture).toBe(1);
  expect(proof.deleteDelta.deleteVertexArray).toBe(1);
  expect(proof.deleteDelta.deleteBuffer).toBeGreaterThanOrEqual(2);
  expect(proof.glError).toBe(0);
  expect(proof.timingDiagnostic).toMatchObject({
    drawsPerBatch: 8,
    drawsPerSample: 32,
  });

  await testInfo.attach('snapshot-r8-draw-diagnostic.json', {
    body: Buffer.from(
      JSON.stringify(proof.timingDiagnostic, null, 2),
    ),
    contentType: 'application/json',
  });
});
