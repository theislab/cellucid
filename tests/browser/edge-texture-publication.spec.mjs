import { expect, test } from '@playwright/test';

import { dismissWelcome } from './helpers/welcome.mjs';

const DATASET_URL =
  '/?exportsBaseUrl=http%3A%2F%2F127.0.0.1%3A4173%2Ftests%2Fbrowser%2Ffixtures%2Fexports%2F&dataset=current-ui-prepared&acceptance=edge-texture-publication-ci';

test('edge generations preserve exact GL state and rollback/retry ownership', async ({
  page,
}) => {
  const pageErrors = [];
  const consoleDiagnostics = [];
  const responseFailures = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() !== 'error' && message.type() !== 'warning') return;
    const text = `${message.type()}: ${message.text()}`;
    if (
      !/GPU stall due to ReadPixels/i.test(text) &&
      !/WebGL warning: texSubImage: (?:Texture has not been initialized|Tex image .*lazy initialization)/i.test(text)
    ) {
      consoleDiagnostics.push(text);
    }
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      responseFailures.push(
        `${response.status()} ${response.request().method()} ${response.url()}`,
      );
    }
  });

  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );

  const proof = await page.evaluate(async () => {
    const viewer = window._cellucidViewer;
    const state = window._cellucidState;
    const gl = viewer.getGLContext();
    const positions = viewer.getViewPositions('live');
    const nCells = viewer.getPointCount();
    viewer.setupEdgesV2({
      sources: Uint32Array.from([0, 1]),
      destinations: Uint32Array.from([1, 2]),
      weights: Float64Array.from([1, 0.5]),
      nEdges: 2,
      nCells,
    }, positions);

    // Exact typed-array uploads must not inherit a caller-owned PBO, texture,
    // or unpack alignment.
    const sentinelTexture = gl.createTexture();
    const sentinelPbo = gl.createBuffer();
    gl.bindTexture(gl.TEXTURE_2D, sentinelTexture);
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, sentinelPbo);
    gl.bufferData(gl.PIXEL_UNPACK_BUFFER, 16, gl.STATIC_DRAW);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const statePreservingSetup = viewer.setupEdgesV2ForView(
      'live',
      positions,
      nCells,
    );
    const glStateRestored = (
      gl.getParameter(gl.TEXTURE_BINDING_2D) === sentinelTexture &&
      gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING) === sentinelPbo &&
      gl.getParameter(gl.UNPACK_ALIGNMENT) === 1
    );
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.deleteTexture(sentinelTexture);
    gl.deleteBuffer(sentinelPbo);

    const payload = state.getSnapshotPayload();
    const makeConfig = (label, sourceViewId) => ({
      label,
      fieldKey: payload.fieldKey,
      fieldKind: payload.fieldKind,
      colors: payload.colors,
      transparency: payload.transparency,
      centroidPositions: payload.centroidPositions,
      centroidColors: payload.centroidColors,
      dimensionLevel: viewer.getViewDimension(sourceViewId),
      sourceViewId,
      meta: { filtersText: payload.filtersText },
      cameraState: viewer.getViewCameraState(sourceViewId),
    });
    const parent = viewer.createSnapshotView(
      makeConfig('Edge parent', 'live'),
    );
    const parentBefore = viewer.getViewPositions(parent.id);
    const parentCandidate = parentBefore.slice();
    parentCandidate[0] += 0.125;

    const prototype = WebGL2RenderingContext.prototype;
    const originalTexImage2D = prototype.texImage2D;
    const originalGetError = prototype.getError;
    let injectedUploadErrors = 0;
    let syntheticUploadErrorPending = false;
    prototype.texImage2D = function (...args) {
      const result = Reflect.apply(originalTexImage2D, this, args);
      if (
        injectedUploadErrors === 0 &&
        args[2] === this.RGB32F
      ) {
        injectedUploadErrors += 1;
        syntheticUploadErrorPending = true;
      }
      return result;
    };
    prototype.getError = function (...args) {
      if (syntheticUploadErrorPending) {
        syntheticUploadErrorPending = false;
        return this.INVALID_ENUM;
      }
      return Reflect.apply(originalGetError, this, args);
    };
    let snapshotPublicationError = null;
    try {
      viewer.setViewPositions(
        parent.id,
        parentCandidate,
        viewer.getViewDimension(parent.id),
      );
    } catch (error) {
      snapshotPublicationError = error.message;
    } finally {
      prototype.texImage2D = originalTexImage2D;
      prototype.getError = originalGetError;
    }

    const parentRestored = (
      viewer.getViewPositions(parent.id)[0] === parentBefore[0] &&
      viewer.hasEdgeTexturesForView(parent.id)
    );
    // This child creation requires the viewer cache to reference the exact
    // renderer-owned geometry copy published by snapshot rollback.
    const child = viewer.createSnapshotView(
      makeConfig('Edge child', parent.id),
    );

    const firstLiveReplacement = positions.slice();
    firstLiveReplacement[1] += 0.05;
    const secondLiveReplacement = positions.slice();
    secondLiveReplacement[1] += 0.1;
    const originalDeleteTexture = prototype.deleteTexture;
    let deleteAttempts = 0;
    let rejectedRetirements = 0;
    prototype.deleteTexture = function (texture) {
      if (
        /drain(?:Edge|Exact)TextureRetirements/.test(
          new Error().stack,
        )
      ) {
        deleteAttempts += 1;
        if (rejectedRetirements === 0) {
          rejectedRetirements += 1;
          throw new Error('synthetic prior edge texture retirement failure');
        }
      }
      return Reflect.apply(originalDeleteTexture, this, [texture]);
    };
    let committedReplacementThrew = false;
    try {
      viewer.setViewPositions(
        'live',
        firstLiveReplacement,
        viewer.getViewDimension('live'),
      );
    } catch {
      committedReplacementThrew = true;
    }
    const firstReplacementPublished = (
      viewer.getViewPositions('live')[1] === firstLiveReplacement[1] &&
      viewer.hasEdgeTexturesForView('live')
    );
    viewer.setViewPositions(
      'live',
      secondLiveReplacement,
      viewer.getViewDimension('live'),
    );
    prototype.deleteTexture = originalDeleteTexture;

    await new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    return {
      childSourceValue: viewer.getViewPositions(child.id)[0],
      committedReplacementThrew,
      deleteAttempts,
      firstReplacementPublished,
      glError: gl.getError(),
      glStateRestored,
      injectedUploadErrors,
      parentRestored,
      rejectedRetirements,
      snapshotPublicationError,
      statePreservingSetup,
    };
  });

  expect(proof.statePreservingSetup).toBe(true);
  expect(proof.glStateRestored).toBe(true);
  expect(proof.injectedUploadErrors).toBe(1);
  expect(proof.snapshotPublicationError).toMatch(
    /weighted connectivity positions.*WebGL error/i,
  );
  expect(proof.parentRestored).toBe(true);
  expect(Number.isFinite(proof.childSourceValue)).toBe(true);
  expect(proof.committedReplacementThrew).toBe(false);
  expect(proof.firstReplacementPublished).toBe(true);
  expect(proof.rejectedRetirements).toBe(1);
  expect(proof.deleteAttempts).toBe(3);
  expect(proof.glError).toBe(0);
  expect(pageErrors).toEqual([]);
  expect(responseFailures).toEqual([]);
  expect(consoleDiagnostics).toHaveLength(1);
  expect(consoleDiagnostics[0]).toMatch(
    /Connectivity prior position generation.*could not be fully retired/i,
  );
});

test('edge texture pooling, streamed tails, and binary visibility stay exact', async ({
  page,
}) => {
  const pageErrors = [];
  const consoleDiagnostics = [];
  const responseFailures = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() !== 'error' && message.type() !== 'warning') return;
    const text = `${message.type()}: ${message.text()}`;
    if (
      !/GPU stall due to ReadPixels/i.test(text) &&
      !/WebGL warning: texSubImage: (?:Texture has not been initialized|Tex image .*lazy initialization)/i.test(text)
    ) {
      consoleDiagnostics.push(text);
    }
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      responseFailures.push(
        `${response.status()} ${response.request().method()} ${response.url()}`,
      );
    }
  });

  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );

  const proof = await page.evaluate(async () => {
    const viewer = window._cellucidViewer;
    const state = window._cellucidState;
    const renderer = viewer.getHPRenderer();
    const gl = viewer.getGLContext();
    viewer.pause();

    const prototype = WebGL2RenderingContext.prototype;
    const originalTexImage2D = prototype.texImage2D;
    const originalTexSubImage2D = prototype.texSubImage2D;
    const originalDeleteTexture = prototype.deleteTexture;
    const rgbAllocations = [];
    const r8Allocations = [];
    const subUploads = [];
    const deletedTextures = [];

    prototype.texImage2D = function (...args) {
      const texture = this.getParameter(this.TEXTURE_BINDING_2D);
      const result = Reflect.apply(originalTexImage2D, this, args);
      const record = {
        data: args[8],
        height: args[4],
        internalFormat: args[2],
        texture,
        width: args[3],
      };
      if (args[2] === this.RGB32F) rgbAllocations.push(record);
      if (args[2] === this.R8) r8Allocations.push(record);
      return result;
    };
    prototype.texSubImage2D = function (...args) {
      const record = {
        data: args[8],
        format: args[6],
        height: args[5],
        srcOffset: args.length > 9 ? args[9] : 0,
        texture: this.getParameter(this.TEXTURE_BINDING_2D),
        type: args[7],
        width: args[4],
        x: args[2],
        y: args[3],
      };
      subUploads.push(record);
      return Reflect.apply(originalTexSubImage2D, this, args);
    };
    prototype.deleteTexture = function (texture) {
      deletedTextures.push(texture);
      return Reflect.apply(originalDeleteTexture, this, [texture]);
    };

    const compileShader = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader));
      }
      return shader;
    };
    const sampleTexture = (texture, dims, index) => {
      const vertexShader = compileShader(
        gl.VERTEX_SHADER,
        `#version 300 es
        precision highp float;
        uniform highp sampler2D u_texture;
        uniform ivec2 u_coord;
        out vec4 captured;
        void main() {
          captured = texelFetch(u_texture, u_coord, 0);
          gl_Position = vec4(0.0);
          gl_PointSize = 1.0;
        }`,
      );
      const fragmentShader = compileShader(
        gl.FRAGMENT_SHADER,
        `#version 300 es
        precision highp float;
        out vec4 color;
        void main() { color = vec4(0.0); }`,
      );
      const program = gl.createProgram();
      gl.attachShader(program, vertexShader);
      gl.attachShader(program, fragmentShader);
      gl.transformFeedbackVaryings(
        program,
        ['captured'],
        gl.INTERLEAVED_ATTRIBS,
      );
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program));
      }
      const vao = gl.createVertexArray();
      const feedback = gl.createTransformFeedback();
      const buffer = gl.createBuffer();
      gl.bindVertexArray(vao);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, feedback);
      gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, buffer);
      gl.bufferData(
        gl.TRANSFORM_FEEDBACK_BUFFER,
        4 * Float32Array.BYTES_PER_ELEMENT,
        gl.STREAM_READ,
      );
      gl.bindBufferBase(
        gl.TRANSFORM_FEEDBACK_BUFFER,
        0,
        buffer,
      );
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE15);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(gl.getUniformLocation(program, 'u_texture'), 15);
      gl.uniform2i(
        gl.getUniformLocation(program, 'u_coord'),
        index % dims[0],
        Math.floor(index / dims[0]),
      );
      gl.enable(gl.RASTERIZER_DISCARD);
      gl.beginTransformFeedback(gl.POINTS);
      gl.drawArrays(gl.POINTS, 0, 1);
      gl.endTransformFeedback();
      gl.disable(gl.RASTERIZER_DISCARD);
      const values = new Float32Array(4);
      gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER, 0, values);

      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
      gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindVertexArray(null);
      gl.useProgram(null);
      gl.deleteBuffer(buffer);
      gl.deleteTransformFeedback(feedback);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      return Array.from(values);
    };

    try {
      const publicPositions = viewer.getViewPositions('live');
      const exactPositions = renderer.getPositions();
      const nCells = viewer.getPointCount();

      const sentinelTexture = gl.createTexture();
      const sentinelPbo = gl.createBuffer();
      gl.bindTexture(gl.TEXTURE_2D, sentinelTexture);
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, sentinelPbo);
      gl.bufferData(gl.PIXEL_UNPACK_BUFFER, 128, gl.STATIC_DRAW);
      const hostileUnpack = new Map([
        [gl.UNPACK_ALIGNMENT, 8],
        [gl.UNPACK_ROW_LENGTH, 17],
        [gl.UNPACK_IMAGE_HEIGHT, 19],
        [gl.UNPACK_SKIP_PIXELS, 2],
        [gl.UNPACK_SKIP_ROWS, 3],
        [gl.UNPACK_SKIP_IMAGES, 1],
      ]);
      for (const [parameter, value] of hostileUnpack) {
        gl.pixelStorei(parameter, value);
      }

      viewer.setupEdgesV2({
        sources: Uint32Array.from([0, 1]),
        destinations: Uint32Array.from([1, 2]),
        weights: Float64Array.from([1, 0.5]),
        nEdges: 2,
        nCells,
      }, publicPositions);
      const unpackRestored = (
        gl.getParameter(gl.TEXTURE_BINDING_2D) === sentinelTexture &&
        gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING) === sentinelPbo &&
        Array.from(hostileUnpack).every(
          ([parameter, value]) =>
            gl.getParameter(parameter) === value,
        )
      );
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      for (const parameter of [
        gl.UNPACK_ROW_LENGTH,
        gl.UNPACK_IMAGE_HEIGHT,
        gl.UNPACK_SKIP_PIXELS,
        gl.UNPACK_SKIP_ROWS,
        gl.UNPACK_SKIP_IMAGES,
      ]) {
        gl.pixelStorei(parameter, 0);
      }
      gl.deleteTexture(sentinelTexture);
      gl.deleteBuffer(sentinelPbo);

      const firstPositionAllocation = rgbAllocations[0];
      const positionUploads = subUploads.filter(
        upload => (
          upload.texture === firstPositionAllocation.texture &&
          upload.format === gl.RGB &&
          upload.type === gl.FLOAT
        ),
      );
      const [positionWidth, positionHeight] = [
        firstPositionAllocation.width,
        firstPositionAllocation.height,
      ];
      const completeRows = Math.floor(nCells / positionWidth);
      const tailLength = nCells % positionWidth;
      const terminalUpload = positionUploads.at(-1);
      const streamedExactOwner = positionUploads.every(
        upload => upload.data === exactPositions,
      );
      const exactTailShape = (
        tailLength > 0 &&
        terminalUpload.width === tailLength &&
        terminalUpload.height === 1 &&
        terminalUpload.y === completeRows &&
        terminalUpload.srcOffset === completeRows * positionWidth * 3
      );
      const tailSample = sampleTexture(
        firstPositionAllocation.texture,
        [positionWidth, positionHeight],
        nCells - 1,
      );
      const expectedTail = Array.from(
        exactPositions.subarray((nCells - 1) * 3, nCells * 3),
      );

      const wrongOwner = publicPositions.slice();
      wrongOwner[0] += 0.25;
      const rgbCountBeforeWrongOwner = rgbAllocations.length;
      let wrongOwnerError = null;
      try {
        viewer.setupEdgesV2ForView('live', wrongOwner, nCells);
      } catch (error) {
        wrongOwnerError = error.message;
      }
      const wrongOwnerRejectedBeforeUpload = (
        rgbAllocations.length === rgbCountBeforeWrongOwner
      );
      const sameGenerationSetup = viewer.setupEdgesV2ForView(
        'live',
        publicPositions,
        nCells,
      );
      const initialStats = viewer.getEdgeTextureStatsV2();

      const payload = state.getSnapshotPayload();
      const makeConfig = (label, sourceViewId) => ({
        label,
        fieldKey: payload.fieldKey,
        fieldKind: payload.fieldKind,
        colors: payload.colors,
        transparency: payload.transparency,
        centroidPositions: payload.centroidPositions,
        centroidColors: payload.centroidColors,
        dimensionLevel: viewer.getViewDimension(sourceViewId),
        sourceViewId,
        meta: { filtersText: payload.filtersText },
        cameraState: viewer.getViewCameraState(sourceViewId),
      });
      const parent = viewer.createSnapshotView(
        makeConfig('Pool parent', 'live'),
      );
      const child = viewer.createSnapshotView(
        makeConfig('Pool child', parent.id),
      );
      const sharedStats = viewer.getEdgeTextureStatsV2();
      const rgbCountAfterSnapshots = rgbAllocations.length;

      const belowHalfBits = new Uint32Array(1);
      const belowHalfValue = new Float32Array(belowHalfBits.buffer);
      belowHalfValue[0] = 0.5;
      belowHalfBits[0] -= 1;
      const aboveHalfBits = new Uint32Array(1);
      const aboveHalfValue = new Float32Array(aboveHalfBits.buffer);
      aboveHalfValue[0] = 0.5;
      aboveHalfBits[0] += 1;
      const visibility = new Float32Array(nCells);
      visibility.fill(1);
      visibility[0] = belowHalfValue[0];
      visibility[1] = 0.5;
      visibility[2] = aboveHalfValue[0];
      const r8SubUploadStart = subUploads.length;
      viewer.updateEdgeVisibilityV2(visibility);
      const liveVisibilityTexture = r8Allocations[0].texture;
      const liveVisibilityDims = [
        r8Allocations[0].width,
        r8Allocations[0].height,
      ];
      const thresholdSamples = [0, 1, 2].map(index =>
        sampleTexture(liveVisibilityTexture, liveVisibilityDims, index)[0]
      );
      const r8UpdateUploads = subUploads
        .slice(r8SubUploadStart)
        .filter(upload => upload.texture === liveVisibilityTexture);
      const binaryUploadContract = r8UpdateUploads.every(
        upload => (
          upload.data instanceof Uint8Array &&
          upload.type === gl.UNSIGNED_BYTE &&
          upload.format === gl.RED
        ),
      );

      const invalidVisibility = visibility.slice();
      invalidVisibility[1] = NaN;
      const r8SubUploadsBeforeInvalid = subUploads.length;
      let invalidVisibilityError = null;
      try {
        viewer.updateEdgeVisibilityV2(invalidVisibility);
      } catch (error) {
        invalidVisibilityError = error.message;
      }
      const invalidVisibilityAtomic = (
        subUploads.length === r8SubUploadsBeforeInvalid &&
        sampleTexture(
          liveVisibilityTexture,
          liveVisibilityDims,
          1,
        )[0] === 1
      );

      const frozenGeneration =
        renderer.getViewGeometryGeneration(parent.id);
      const sameOwner = renderer.getPositions();
      const liveGenerationBeforeSameArray =
        renderer.getViewGeometryGeneration('live');
      viewer.setViewPositions(
        'live',
        sameOwner,
        viewer.getViewDimension('live'),
      );
      const liveGenerationAfterSameArray =
        renderer.getViewGeometryGeneration('live');
      const postRepublishStats = viewer.getEdgeTextureStatsV2();
      const oldTexture = firstPositionAllocation.texture;
      const oldDeletesBeforeParent = deletedTextures.filter(
        texture => texture === oldTexture,
      ).length;
      viewer.removeSnapshotView(parent.id);
      const afterParentRemoval = viewer.getEdgeTextureStatsV2();
      const oldDeletesAfterParent = deletedTextures.filter(
        texture => texture === oldTexture,
      ).length;
      gl.bindTexture(gl.TEXTURE_2D, oldTexture);
      viewer.removeSnapshotView(child.id);
      const boundAfterFinalSharedRelease =
        gl.getParameter(gl.TEXTURE_BINDING_2D);
      const afterChildRemoval = viewer.getEdgeTextureStatsV2();
      const oldDeletesAfterChild = deletedTextures.filter(
        texture => texture === oldTexture,
      ).length;

      const livePositionTexture = rgbAllocations.at(-1).texture;
      gl.bindTexture(gl.TEXTURE_2D, livePositionTexture);
      const originalDeleteDuringClear = prototype.deleteTexture;
      let deleteThenThrowCount = 0;
      prototype.deleteTexture = function (texture) {
        const result = Reflect.apply(
          originalDeleteTexture,
          this,
          [texture],
        );
        if (
          texture === livePositionTexture &&
          deleteThenThrowCount === 0
        ) {
          deleteThenThrowCount += 1;
          throw new Error('synthetic delete-then-throw');
        }
        return result;
      };
      let clearThrew = false;
      try {
        viewer.clearEdgesV2();
      } catch {
        clearThrew = true;
      } finally {
        prototype.deleteTexture = originalDeleteDuringClear;
      }
      const clearedStats = viewer.getEdgeTextureStatsV2();

      return {
        binaryUploadContract,
        boundFinalSharedTextureWasCleared:
          boundAfterFinalSharedRelease === null,
        clearThrew,
        clearedPendingRetirements: clearedStats.pendingRetirements,
        clearedPositionGenerations:
          clearedStats.positionGenerations.length,
        deleteThenThrowCount,
        exactTailShape,
        frozenGeneration,
        initialPoolRefCount:
          initialStats.positionGenerations[0].refCount,
        initialVisibilityFourfold: (
          initialStats.visibilityViews[0].cpuBytes ===
            initialStats.visibilityViews[0].allocatedTexels &&
          initialStats.visibilityViews[0].gpuBytes ===
            initialStats.visibilityViews[0].allocatedTexels
        ),
        invalidVisibilityAtomic,
        invalidVisibilityError,
        liveGenerationAfterSameArray,
        liveGenerationBeforeSameArray,
        noPaddedPositionAllocation:
          firstPositionAllocation.data === null,
        oldDeletesAfterChild,
        oldDeletesAfterParent,
        oldDeletesBeforeParent,
        parentRemovalOldRefCount:
          afterParentRemoval.positionGenerations.find(
            entry => entry.generation === frozenGeneration,
          )?.refCount,
        postRepublishGenerations:
          postRepublishStats.positionGenerations.map(entry => ({
            generation: entry.generation,
            refCount: entry.refCount,
          })),
        rgbCountAfterSnapshots,
        sameGenerationSetup,
        sharedGenerationCount:
          sharedStats.positionGenerations.length,
        sharedGenerationRefCount:
          sharedStats.positionGenerations[0].refCount,
        streamedExactOwner,
        tailSample: tailSample.slice(0, 3),
        expectedTail,
        thresholdSamples,
        unpackRestored,
        visibilityViewCount: sharedStats.visibilityViews.length,
        wrongOwnerError,
        wrongOwnerRejectedBeforeUpload,
        childRemovalFrozenGenerationAbsent:
          !afterChildRemoval.positionGenerations.some(
            entry => entry.generation === frozenGeneration,
          ),
        glError: gl.getError(),
      };
    } finally {
      prototype.texImage2D = originalTexImage2D;
      prototype.texSubImage2D = originalTexSubImage2D;
      prototype.deleteTexture = originalDeleteTexture;
    }
  });

  expect(proof.unpackRestored).toBe(true);
  expect(proof.noPaddedPositionAllocation).toBe(true);
  expect(proof.streamedExactOwner).toBe(true);
  expect(proof.exactTailShape).toBe(true);
  expect(proof.tailSample).toEqual(proof.expectedTail);
  expect(proof.wrongOwnerError).toMatch(/differ.*certified renderer owner/i);
  expect(proof.wrongOwnerRejectedBeforeUpload).toBe(true);
  expect(proof.sameGenerationSetup).toBe(true);
  expect(proof.initialPoolRefCount).toBe(1);
  expect(proof.initialVisibilityFourfold).toBe(true);
  expect(proof.rgbCountAfterSnapshots).toBe(1);
  expect(proof.sharedGenerationCount).toBe(1);
  expect(proof.sharedGenerationRefCount).toBe(3);
  expect(proof.visibilityViewCount).toBe(3);
  expect(proof.binaryUploadContract).toBe(true);
  expect(proof.thresholdSamples).toEqual([0, 1, 1]);
  expect(proof.invalidVisibilityError).toMatch(/finite Float32/i);
  expect(proof.invalidVisibilityAtomic).toBe(true);
  expect(proof.liveGenerationAfterSameArray).not.toBe(
    proof.liveGenerationBeforeSameArray,
  );
  expect(proof.postRepublishGenerations).toEqual(
    expect.arrayContaining([
      { generation: proof.frozenGeneration, refCount: 2 },
      { generation: proof.liveGenerationAfterSameArray, refCount: 1 },
    ]),
  );
  expect(proof.oldDeletesBeforeParent).toBe(0);
  expect(proof.oldDeletesAfterParent).toBe(0);
  expect(proof.parentRemovalOldRefCount).toBe(1);
  expect(proof.oldDeletesAfterChild).toBe(1);
  expect(proof.boundFinalSharedTextureWasCleared).toBe(true);
  expect(proof.childRemovalFrozenGenerationAbsent).toBe(true);
  expect(proof.deleteThenThrowCount).toBe(1);
  expect(proof.clearThrew).toBe(false);
  expect(proof.clearedPendingRetirements).toBe(0);
  expect(proof.clearedPositionGenerations).toBe(0);
  expect(proof.glError).toBe(0);
  expect(pageErrors).toEqual([]);
  expect(responseFailures).toEqual([]);
  expect(consoleDiagnostics).toEqual([]);
});

test('committed setData detaches every prior edge generation before retryable cleanup', async ({
  page,
}) => {
  const pageErrors = [];
  const consoleDiagnostics = [];
  const responseFailures = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() !== 'error' && message.type() !== 'warning') return;
    const text = `${message.type()}: ${message.text()}`;
    if (!/GPU stall due to ReadPixels/i.test(text)) {
      consoleDiagnostics.push(text);
    }
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      responseFailures.push(
        `${response.status()} ${response.request().method()} ${response.url()}`,
      );
    }
  });

  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );

  const proof = await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const state = window._cellucidState;
    const renderer = viewer.getHPRenderer();
    const nCells = viewer.getPointCount();
    viewer.pause();
    viewer.setupEdgesV2({
      sources: Uint32Array.from([0, 1]),
      destinations: Uint32Array.from([1, 2]),
      weights: Float64Array.from([1, 0.5]),
      nEdges: 2,
      nCells,
    });

    const snapshotPayload = state.getSnapshotPayload();
    const makeConfig = (label, sourceViewId) => ({
      label,
      fieldKey: snapshotPayload.fieldKey,
      fieldKind: snapshotPayload.fieldKind,
      colors: snapshotPayload.colors,
      transparency: snapshotPayload.transparency,
      centroidPositions: snapshotPayload.centroidPositions,
      centroidColors: snapshotPayload.centroidColors,
      dimensionLevel: viewer.getViewDimension(sourceViewId),
      sourceViewId,
      meta: { filtersText: snapshotPayload.filtersText },
      cameraState: viewer.getViewCameraState(sourceViewId),
    });
    const parent = viewer.createSnapshotView(
      makeConfig('setData parent', 'live'),
    );
    const child = viewer.createSnapshotView(
      makeConfig('setData child', parent.id),
    );
    const before = viewer.getEdgeTextureStatsV2();
    const oldGeneration =
      renderer.getViewGeometryGeneration('live');

    const replacementPositions = viewer.getViewPositions('live');
    replacementPositions[0] += 0.375;
    const replacementColors = viewer.getColors();
    const replacementTransparency = new Float32Array(
      viewer.getViewTransparency('live'),
    );

    const prototype = WebGL2RenderingContext.prototype;
    const originalDeleteTexture = prototype.deleteTexture;
    let edgeDeleteAttempts = 0;
    let rejectedEdgeRetirements = 0;
    prototype.deleteTexture = function (texture) {
      if (
        /drain(?:Edge|Exact)TextureRetirements/.test(
          new Error().stack,
        )
      ) {
        edgeDeleteAttempts += 1;
        if (rejectedEdgeRetirements === 0) {
          rejectedEdgeRetirements += 1;
          throw new Error(
            'synthetic committed setData edge retirement failure',
          );
        }
      }
      return Reflect.apply(originalDeleteTexture, this, [texture]);
    };

    let setDataError = null;
    try {
      viewer.setData({
        positions: replacementPositions,
        colors: replacementColors,
        transparency: replacementTransparency,
        dimensionLevel: viewer.getViewDimension('live'),
      });
    } catch (error) {
      setDataError = error.message;
    }
    const afterCommit = viewer.getEdgeTextureStatsV2();
    const newGeneration =
      renderer.getViewGeometryGeneration('live');
    const committedPosition =
      viewer.getViewPositions('live')[0];
    const viewIds = ['live', parent.id, child.id];
    const edgeViewsAfterCommit = viewIds.filter(
      viewId => viewer.hasEdgeTexturesForView(viewId),
    );
    const hasConnectivityAfterCommit =
      viewer.hasConnectivityData();
    const instancedAfterCommit =
      viewer.isUsingInstancedEdges();

    let retryError = null;
    try {
      viewer.clearEdgesV2();
    } catch (error) {
      retryError = error.message;
    } finally {
      prototype.deleteTexture = originalDeleteTexture;
    }
    const afterRetry = viewer.getEdgeTextureStatsV2();

    return {
      afterCommit,
      afterRetry,
      before,
      committedPosition,
      edgeDeleteAttempts,
      edgeViewsAfterCommit,
      hasConnectivityAfterCommit,
      instancedAfterCommit,
      newGeneration,
      oldGeneration,
      rejectedEdgeRetirements,
      replacementPosition: replacementPositions[0],
      retryError,
      setDataError,
    };
  });

  expect(proof.before.positionGenerations).toHaveLength(1);
  expect(proof.before.positionGenerations[0].refCount).toBe(3);
  expect(proof.oldGeneration).not.toBe(proof.newGeneration);
  expect(proof.committedPosition).toBe(proof.replacementPosition);
  expect(proof.setDataError).toBeNull();
  expect(proof.hasConnectivityAfterCommit).toBe(false);
  expect(proof.instancedAfterCommit).toBe(false);
  expect(proof.edgeViewsAfterCommit).toEqual([]);
  expect(proof.afterCommit.positionGenerations).toEqual([]);
  expect(proof.afterCommit.positionViewGenerations).toEqual([]);
  expect(proof.afterCommit.visibilityViews).toEqual([]);
  expect(proof.afterCommit.pendingRetirements).toBe(1);
  expect(proof.rejectedEdgeRetirements).toBe(1);
  expect(proof.edgeDeleteAttempts).toBe(7);
  expect(proof.retryError).toBeNull();
  expect(proof.afterRetry.pendingRetirements).toBe(0);
  expect(pageErrors).toEqual([]);
  expect(responseFailures).toEqual([]);
  expect(consoleDiagnostics).toHaveLength(1);
  expect(consoleDiagnostics[0]).toMatch(
    /prior committed dataset generation.*could not be fully retired/i,
  );
});
