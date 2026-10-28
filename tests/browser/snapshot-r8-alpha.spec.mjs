import { expect, test } from './helpers/test.mjs';

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
      getParameter: prototype.getParameter,
      texImage2D: prototype.texImage2D,
      texSubImage2D: prototype.texSubImage2D,
      texStorage3D: prototype.texStorage3D,
      texSubImage3D: prototype.texSubImage3D,
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
    // A rejected write into an accepted texture fails synchronously (WebGL
    // throws for arguments it rejects) and writes nothing; it is counted.
    const rejectInjected = (context, texture, record) => {
      if (context !== gl || texture === null || texture !== injectedTexture) return;
      injectedTexture = null;
      calls.texSubImage2D.push(record);
      throw new TypeError('WebGL rejected the snapshot alpha texture upload.');
    };
    prototype.texSubImage2D = function (...args) {
      const texture = this === gl
        ? this.getParameter(this.TEXTURE_BINDING_2D)
        : null;
      rejectInjected(this, texture, {
        format: args[6],
        height: args[5],
        texture,
        type: args[7],
        width: args[4],
        x: args[2],
        y: args[3],
      });
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
      }
      return result;
    };
    // Per-point textures are linear textures (rendering/linear-texture.js):
    // TEXTURE_2D_ARRAY storage, then rows. An R8 allocation counts as the
    // allocation (texImage2D) and every row write as an upload (texSubImage2D),
    // mirrored the same way.
    prototype.texStorage3D = function (...args) {
      const texture = this === gl
        ? this.getParameter(this.TEXTURE_BINDING_2D_ARRAY)
        : null;
      const result = Reflect.apply(originals.texStorage3D, this, args);
      if (this === gl && args[2] === this.R8) {
        calls.texImage2D.push({
          format: this.RED,
          height: args[4],
          internalFormat: args[2],
          texture,
          type: this.UNSIGNED_BYTE,
          width: args[3],
        });
        textureMirrors.set(texture, {
          bytes: new Uint8Array(args[3] * args[4] * args[5]),
          height: args[4],
          width: args[3],
        });
      }
      return result;
    };
    prototype.texSubImage3D = function (...args) {
      const texture = this === gl
        ? this.getParameter(this.TEXTURE_BINDING_2D_ARRAY)
        : null;
      rejectInjected(this, texture, {
        format: args[8],
        height: args[6],
        texture,
        type: args[9],
        width: args[5],
        x: args[2],
        y: args[3],
      });
      const result = Reflect.apply(originals.texSubImage3D, this, args);
      if (this === gl) {
        // (target, level, x, y, z, width, height, depth, format, type, data, offset)
        calls.texSubImage2D.push({
          format: args[8],
          height: args[6],
          texture,
          type: args[9],
          width: args[5],
          x: args[2],
          y: args[3],
        });
        const mirror = textureMirrors.get(texture);
        const source = args[10];
        if (
          mirror &&
          args[8] === this.RED &&
          args[9] === this.UNSIGNED_BYTE &&
          source instanceof Uint8Array
        ) {
          const sourceOffset = Number.isSafeInteger(args[11]) ? args[11] : 0;
          for (let row = 0; row < args[6]; row++) {
            const sourceStart = sourceOffset + row * args[5];
            mirror.bytes.set(
              source.subarray(sourceStart, sourceStart + args[5]),
              (args[4] * mirror.height + args[3] + row) * mirror.width + args[2],
            );
          }
        }
      }
      return result;
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
      // A 2D embedding: two position components per point.
      const positions = new Float32Array(pointCount * 2);
      const colors = new Uint8Array(pointCount * 4);
      const initialAlphas = new Uint8Array(pointCount);
      for (let index = 0; index < pointCount; index++) {
        const column = index % gridSide;
        const row = Math.floor(index / gridSide);
        // The final eight columns are outside the identity frustum so both
        // indexed frustum branches must reject real geometry.
        positions[index * 2] = column < 24
          ? ((column + 0.5) / 24) * 1.8 - 0.9
          : 1.35 + (column - 24) * 0.04;
        positions[index * 2 + 1] =
          ((row + 0.5) / gridSide) * 1.8 - 0.9;
        colors[index * 4] = 32 + ((index * 17) % 208);
        colors[index * 4 + 1] =
          32 + ((index * 29) % 208);
        colors[index * 4 + 2] =
          32 + ((index * 43) % 208);
        // Deliberately disagree with the authoritative transparency owner.
        colors[index * 4 + 3] = 255;
        initialAlphas[index] =
          [0, 1, 1, 0, 1][index % 5];
      }

      renderer = new HighPerfRenderer(gl, {
        LOD_MAX_DEPTH: 8,
        LOD_MAX_POINTS_PER_NODE: 32,
        USE_FRUSTUM_CULLING: false,
        USE_LOD: false,
      });
      renderer.loadData(positions, colors, {
        alphaValues: initialAlphas,
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
        snapshot.alphas;
      const snapshotMirror =
        textureMirrors.get(snapshotTexture);

      // Stores are segmented (point-store-segments.js): one segment here.
      gl.bindVertexArray(snapshot.vao.vaos[0]);
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
        // The published transparency is kept by reference and is what the
        // texture holds: no CPU copy of the R8 image, per view or shared.
        acceptedTransparencyByReference:
          snapshot.alphas === initialAlphas,
        noCpuImageCopy:
          !Object.hasOwn(snapshot, 'alphaTexData') &&
          !Object.hasOwn(renderer, '_snapshotAlphaStagingData') &&
          !Object.values(snapshot).some(
            value =>
              ArrayBuffer.isView(value) &&
              value !== snapshot.alphas &&
              value !== snapshot.colors &&
              value !== snapshot.positions &&
              value.length >= pointCount,
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
          snapshotMirror?.bytes[index] ===
            expectedInitialBytes[index]
        ),
        paddedTailOpaque:
          snapshotMirror?.bytes.length ===
            snapshot.alphaTexWidth * snapshot.alphaTexHeight &&
          snapshotMirror.bytes
            .subarray(pointCount)
            .every(value => value === 255),
        colorAttribute: {
          bufferMatches: colorAttribute.buffer === snapshot.buffer.segments[0].buffer,
          normalized: colorAttribute.normalized,
          offset: colorAttribute.offset,
          size: colorAttribute.size,
          stride: colorAttribute.stride,
          typeIsUnsignedByte:
            colorAttribute.type === gl.UNSIGNED_BYTE,
        },
        colorBytesExact:
          snapshot.bufferByteLength === pointCount * 4,
        // The published RGBA array is retained by reference, never copied:
        // it is the source of the GPU colour gather.
        noPerSnapshotColorCopy: snapshot.colors === colors,
        noPerSnapshotFloatAlphaOwner:
          !Object.values(snapshot).some(
            value =>
              value instanceof Float32Array &&
              value.length === pointCount,
          ),
        // RGB is packed on the GPU, never in a point-sized CPU scratch.
        noPointSizedColorScratch:
          !Object.hasOwn(renderer, '_snapshotColorStagingData') &&
          !Object.hasOwn(renderer, '_gatherChunkBuffer'),
        sharedGeometryPositionBytes:
          geometry.positionBufferByteLength ===
            pointCount * 8 &&
          geometry.positionBuffer === renderer.buffers.positions,
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
      // The tree with its levels is built off the main thread: ask for it
      // with one forced-level frame, then wait until it has landed.
      renderPair({ forceLOD: 0, frustum: true, name: 'prime' });
      for (let attempt = 0; attempt < 500; attempt++) {
        const tree = renderer.spatialIndices.get(renderer.currentDimensionLevel);
        if (Array.isArray(tree?.lodLevels) && tree.lodLevels.length > 0) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
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
      // The pooled store holds its points in its tree's draw order, so the
      // baked colours are laid out in that order too.
      const drawOrder = renderer.getViewDrawOrder('snapshot-r8');
      const legacyColors = new Uint8Array(colors.length);
      for (let slot = 0; slot < pointCount; slot++) {
        const index = drawOrder === null ? slot : drawOrder[slot];
        legacyColors.set(colors.subarray(index * 4, index * 4 + 3), slot * 4);
        legacyColors[slot * 4 + 3] = expectedInitialBytes[index];
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
        geometry.positionBuffer.segments[0].buffer,
      );
      gl.enableVertexAttribArray(0);
      // The shared geometry store holds the 2D positions: two components.
      gl.vertexAttribPointer(
        0,
        2,
        gl.FLOAT,
        false,
        8,
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
            gl.TEXTURE_2D_ARRAY,
            renderer._dummyLodIndexTexture,
          );
          if (uniforms.u_lodIndexTex !== null) {
            gl.uniform1i(uniforms.u_lodIndexTex, 1);
          }
        }
        if (uniforms.u_orderedSlots !== null) {
          gl.uniform1i(uniforms.u_orderedSlots, 0);
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
        renderer._bindPointAlpha(
          gl,
          uniforms,
          snapshot.alphaTexture,
          snapshot.alphaTexPlan,
          renderer._ensureSnapshotDrawOrder(snapshot, null),
        );
      };
      // Warm shaders, texture sampling, and both attribute layouts.
      await measure(configureProduction, snapshot.vao.vaos[0]);
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
                snapshot.vao.vaos[0],
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
                snapshot.vao.vaos[0],
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
        Uint8Array.from(expectedInitialBytes, value =>
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

      const changedAlphas = Uint8Array.from(
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
      const changedOwner = snapshot.alphas;
      const changedBytes =
        Uint8Array.from(changedAlphas, value =>
          Math.round(value * 255)
        );
      const changedPublication = {
        acceptedOwnerAdvanced:
          changedOwner !== initialAcceptedAlphaOwner &&
          changedOwner === changedAlphas,
        bytesExact: changedBytes.every(
          (value, index) =>
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
        snapshot.alphas;
      const acceptedBytesBeforeFailure =
        Uint8Array.from(acceptedBeforeFailure, value => value * 255);
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
              textureMirrors.get(snapshot.alphaTexture)
                ?.bytes[index] === value,
          ),
        acceptedOwnerPreserved:
          snapshot.alphas === acceptedBeforeFailure,
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
          snapshot.alphas !== acceptedBeforeFailure &&
          snapshot.alphas === failureCandidate,
        bytesExact: retryBytes.every(
          (value, index) =>
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
        snapshot.alphas;
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
          snapshot.alphas === alphaOwnerBeforePositions,
        alphaTexturePreserved:
          snapshot.alphaTexture ===
            alphaTextureBeforePositions,
        // The colour store survives a position change: drawn again when the
        // new geometry holds the same draw order, else kept (under its own
        // order) while the view draws a store gathered into the new one.
        colorBufferPreserved:
          snapshot.buffer === colorBufferBeforePositions ||
          [...(snapshot.colorCache?.values() ?? [])].some(
            entry => entry.buffer === colorBufferBeforePositions,
          ),
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

      // The GL objects of the segmented store and vertex arrays
      // (point-store-segments.js), named before they are deleted.
      const retiredSnapshot = {
        alphaTexture: snapshot.alphaTexture,
        buffer: snapshot.buffer.segments[0].buffer,
        vao: snapshot.vao.vaos[0],
      };
      const retiredGeometry = renderer._snapshotGeometryPools.get(
        snapshot.geometryGeneration,
      );
      const retiredPositionStore = retiredGeometry.positionBuffer;
      const retiredPositionBuffer = retiredPositionStore.segments[0].buffer;
      const lifecycleStart = lifecycle.length;
      // Colour stores the view kept for other draw orders go with it.
      const keptColorStores = snapshot.colorCache?.size ?? 0;
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
      // No view shows the snapshot's positions any more: they stay retained,
      // within the retention budget, until evicted.
      const positionBufferDeleted = events => events.some(
        event =>
          event.kind === 'deleteBuffer' &&
          event.handle === retiredPositionBuffer,
      );
      const retention = {
        pooled:
          renderer._snapshotGeometryPools.get(
            retiredGeometry.generation,
          ) === retiredGeometry,
        positionBufferDeleted:
          positionBufferDeleted(retirementEvents),
        positionBufferHeld:
          retiredGeometry.positionBuffer ===
            retiredPositionStore,
        refCount: retiredGeometry.refCount,
        retained: retiredGeometry.retained,
      };
      const evictionStart = lifecycle.length;
      const beforeEviction = captureCounts();
      renderer.evictRetainedGeometry(Infinity);
      const evictionDelta = countDelta(
        beforeEviction,
        captureCounts(),
      );
      const eviction = {
        pooled: renderer._snapshotGeometryPools.has(
          retiredGeometry.generation,
        ),
        positionBufferDeleted: positionBufferDeleted(
          lifecycle.slice(evictionStart),
        ),
        retained: retiredGeometry.retained,
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
        keptColorStores,
        retryDelta,
        retryPublication,
        changedDelta,
        changedPublication,
        retirement,
        retention,
        eviction,
        evictionDelta,
        supported: true,
        timingDiagnostic,
      };
    } finally {
      injectedTexture = null;
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
        prototype.getParameter = originals.getParameter;
        prototype.texImage2D = originals.texImage2D;
        prototype.texSubImage2D =
          originals.texSubImage2D;
        prototype.texStorage3D = originals.texStorage3D;
        prototype.texSubImage3D = originals.texSubImage3D;
      }
    }
  });

  expect(proof.supported).toBe(true);
  expect(proof.ownership).toEqual({
    acceptedTransparencyByReference: true,
    alphaTextureDistinctFromLive: true,
    alphaTextureMirrored: true,
    alphaTextureShapeExact: true,
    crossRowBoundariesExact: true,
    colorAttribute: {
      bufferMatches: true,
      normalized: true,
      offset: 0,
      size: 4,
      stride: 4,
      typeIsUnsignedByte: true,
    },
    colorBytesExact: true,
    noPerSnapshotColorCopy: true,
    noCpuImageCopy: true,
    noPerSnapshotFloatAlphaOwner: true,
    paddedTailOpaque: true,
    noPointSizedColorScratch: true,
    sharedGeometryPositionBytes: true,
  });
  // One RGBA8 colour store: a snapshot of the live generation borrows the
  // live position store instead of uploading a second copy of it. In source
  // order the colour store is the colours' own bytes, uploaded directly (no
  // gather pass, so no transient texture or pass objects). The R8 alpha
  // texture is a linear texture: its storage (counted as texImage2D) and one
  // write of its padded rows (counted as texSubImage2D).
  expect(proof.createDelta).toEqual({
    bufferData: 1,
    createBuffer: 1,
    createTexture: 1,
    createVertexArray: 1,
    deleteBuffer: 0,
    deleteTexture: 0,
    deleteVertexArray: 0,
    texImage2D: 1,
    texSubImage2D: 1,
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
      message: expect.stringMatching(/rejected the snapshot alpha texture upload/),
      name: 'TypeError',
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
  // The colour buffers only (its own and any it kept for another draw
  // order): the position buffer is retained.
  expect(proof.deleteDelta.deleteBuffer).toBe(1 + proof.keptColorStores);
  expect(proof.retention).toEqual({
    pooled: true,
    positionBufferDeleted: false,
    positionBufferHeld: true,
    refCount: 0,
    retained: true,
  });
  expect(proof.eviction).toEqual({
    pooled: false,
    positionBufferDeleted: true,
    retained: false,
  });
  expect(proof.evictionDelta.deleteBuffer).toBe(1);
  expect(proof.evictionDelta.deleteTexture).toBe(0);
  expect(proof.evictionDelta.deleteVertexArray).toBe(0);
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
