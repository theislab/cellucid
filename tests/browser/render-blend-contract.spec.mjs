import { expect, test } from './helpers/test.mjs';

import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=render-blend-contract-ci`;

async function installBlendBoundaryAudit(page) {
  await page.addInitScript(() => {
    const prototype = WebGL2RenderingContext.prototype;
    const originalDrawArrays = prototype.drawArrays;
    const originalDrawElements = prototype.drawElements;
    const originalDrawArraysInstanced = prototype.drawArraysInstanced;
    let activeAudit = null;

    const snapshotBlendState = gl => ({
      blend: gl.isEnabled(gl.BLEND),
      dstAlpha: gl.getParameter(gl.BLEND_DST_ALPHA),
      dstRgb: gl.getParameter(gl.BLEND_DST_RGB),
      equationAlpha: gl.getParameter(gl.BLEND_EQUATION_ALPHA),
      equationRgb: gl.getParameter(gl.BLEND_EQUATION_RGB),
      srcAlpha: gl.getParameter(gl.BLEND_SRC_ALPHA),
      srcRgb: gl.getParameter(gl.BLEND_SRC_RGB),
      viewport: Array.from(gl.getParameter(gl.VIEWPORT)),
    });
    const poisonBlendState = gl => {
      gl.disable(gl.BLEND);
      gl.blendEquation(gl.FUNC_REVERSE_SUBTRACT);
      gl.blendFunc(gl.ONE, gl.ZERO);
    };
    const classify = (gl, kind, mode, count, instanceCount) => {
      if (!activeAudit || gl !== activeAudit.gl) return null;
      if (
        kind === 'drawArrays' &&
        mode === gl.TRIANGLES &&
        count === 6
      ) {
        return 'grid';
      }
      if (
        kind === 'drawArraysInstanced' &&
        mode === gl.TRIANGLE_STRIP &&
        count === 4 &&
        instanceCount === activeAudit.edgeCount
      ) {
        return 'connectivity';
      }
      if (mode !== gl.POINTS) return null;
      if (count === activeAudit.pointCount) return 'scatter';
      if (count === activeAudit.highlightCount) return 'highlight';
      if (count === activeAudit.centroidCount) return 'centroid';
      return null;
    };
    const recordBoundary = (
      gl,
      kind,
      mode,
      count,
      instanceCount = null,
    ) => {
      const role = classify(gl, kind, mode, count, instanceCount);
      if (role === null) return false;
      activeAudit.records.push({
        kind,
        role,
        ...snapshotBlendState(gl),
      });
      return role;
    };

    prototype.drawArrays = function (mode, first, count) {
      const role = recordBoundary(
        this,
        'drawArrays',
        mode,
        count,
      );
      const result = Reflect.apply(
        originalDrawArrays,
        this,
        [mode, first, count],
      );
      // A grid pane owns one blend publication for all of its immutable plane
      // draws. Poison only after the pass boundary, not between its planes.
      if (role !== false && role !== 'grid') poisonBlendState(this);
      return result;
    };
    prototype.drawElements = function (mode, count, type, offset) {
      const role = recordBoundary(
        this,
        'drawElements',
        mode,
        count,
      );
      const result = Reflect.apply(
        originalDrawElements,
        this,
        [mode, count, type, offset],
      );
      if (role !== false && role !== 'grid') poisonBlendState(this);
      return result;
    };
    prototype.drawArraysInstanced = function (
      mode,
      first,
      count,
      instanceCount,
    ) {
      const role = recordBoundary(
        this,
        'drawArraysInstanced',
        mode,
        count,
        instanceCount,
      );
      const result = Reflect.apply(
        originalDrawArraysInstanced,
        this,
        [mode, first, count, instanceCount],
      );
      if (role !== false && role !== 'grid') poisonBlendState(this);
      return result;
    };

    Object.defineProperty(window, '__cellucidBlendBoundaryAudit', {
      configurable: false,
      value: {
        start(config) {
          const gl = config.gl;
          activeAudit = {
            centroidCount: config.centroidCount,
            edgeCount: config.edgeCount,
            gl,
            highlightCount: config.highlightCount,
            pointCount: config.pointCount,
            records: [],
          };
          poisonBlendState(gl);
        },
        snapshot() {
          return activeAudit?.records.slice() ?? [];
        },
        stop() {
          const records = activeAudit?.records.slice() ?? [];
          activeAudit = null;
          return records;
        },
      },
    });
  });
}

test('grid multiview scatter, highlight, connectivity, and centroid draws own exact alpha blending', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', error => {
    pageErrors.push(error.stack || error.message);
  });
  await installBlendBoundaryAudit(page);
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture',
  );

  const setup = await page.evaluate(async () => {
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
    const viewer = window._cellucidViewer;
    const state = window._cellucidState;
    const ui = window._cellucidUi;
    const pointCount = viewer.getPointCount();
    const highlightIndices = [0, 1, 2, 3, 4];
    const highlightData = new Uint8Array(pointCount);
    for (const index of highlightIndices) highlightData[index] = 255;
    const centroidPositions = Float32Array.from([
      -0.3, -0.2, 0,
      0, 0.25, 0,
      0.35, -0.1, 0,
    ]);
    const centroidColors = Uint8Array.from([
      230, 30, 50, 180,
      30, 180, 90, 180,
      40, 90, 230, 180,
    ]);
    const positions = viewer.getViewPositions('live');
    const payload = state.getSnapshotPayload();

    viewer.pause();
    viewer.setBackground('grid');
    viewer.setAdaptiveLOD(false);
    viewer.setFrustumCulling(false);
    viewer.updateHighlight(highlightData, highlightIndices);
    viewer.setCentroids({
      positions: centroidPositions,
      colors: centroidColors,
    });
    viewer.setShowCentroidPoints(true, 'live');
    const snapshot = ui.publishSnapshotView({
      label: 'Blend contract',
      fieldKey: payload.fieldKey,
      fieldKind: payload.fieldKind,
      colors: payload.colors,
      transparency: payload.transparency,
      centroidPositions,
      centroidColors,
      dimensionLevel: payload.dimensionLevel,
      sourceViewId: 'live',
      meta: { filtersText: payload.filtersText },
      cameraState: viewer.getViewCameraState('live'),
    });
    viewer.setShowCentroidPoints(true, snapshot.id);

    const edgeCount = 2;
    const edgeSetup = viewer.setupEdgesV2(
      edgePayloadOf(Uint32Array.from([0, 1]), Uint32Array.from([1, 2]), Float32Array.from([1, 0.5]), pointCount),
      positions,
    );
    const snapshotEdgeSetup = viewer.setupEdgesV2ForView(
      snapshot.id,
      viewer.getViewPositions(snapshot.id),
      pointCount,
    );
    viewer.setShowConnectivity(true);
    viewer.setViewLayout('grid', 'live');
    window.__cellucidBlendBoundaryAudit.start({
      centroidCount: 3,
      edgeCount,
      gl: viewer.getGLContext(),
      highlightCount: highlightIndices.length,
      pointCount,
    });
    viewer.resume();
    return {
      edgeSetup,
      snapshotEdgeSetup,
    };
  });
  expect(setup).toEqual({
    edgeSetup: true,
    snapshotEdgeSetup: true,
  });

  await page.waitForFunction(() => {
    const records = window.__cellucidBlendBoundaryAudit.snapshot();
    const roles = new Map();
    for (const record of records) {
      const viewports = roles.get(record.role) ?? new Set();
      viewports.add(record.viewport.join(','));
      roles.set(record.role, viewports);
    }
    return ['grid', 'scatter', 'highlight', 'connectivity', 'centroid']
      .every(role => (roles.get(role)?.size ?? 0) >= 2);
  });
  const records = await page.evaluate(() => {
    window._cellucidViewer.pause();
    return window.__cellucidBlendBoundaryAudit.stop();
  });

  const roles = [
    'grid',
    'scatter',
    'highlight',
    'connectivity',
    'centroid',
  ];
  for (const role of roles) {
    const roleRecords = records.filter(record => record.role === role);
    expect(
      new Set(roleRecords.map(record => record.viewport.join(','))).size,
      `${role} should draw in both multiview panes`,
    ).toBeGreaterThanOrEqual(2);
    for (const record of roleRecords) {
      expect(record, `${role} draw blend state`).toMatchObject({
        blend: true,
        dstAlpha: 0x0303,
        dstRgb: 0x0303,
        equationAlpha: 0x8006,
        equationRgb: 0x8006,
        srcAlpha: 1,
        srcRgb: 0x0302,
      });
    }
  }
  expect(pageErrors).toEqual([]);
});

test('straight-alpha contract preserves exact framebuffer coverage', async ({
  page,
}) => {
  await page.goto('/tests/browser/fixtures/webgl-harness.html');
  const pixels = await page.evaluate(async () => {
    const {
      configureStraightAlphaBlending,
    } = await import('/assets/js/rendering/gl-utils.js');

    const render = clearAlpha => {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const gl = canvas.getContext('webgl2', {
        alpha: true,
        antialias: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: true,
      });
      if (!gl) throw new Error('WebGL2 unavailable');

      const compile = (type, source) => {
        const shader = gl.createShader(type);
        if (!shader) throw new Error('Shader allocation failed');
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          throw new Error(gl.getShaderInfoLog(shader) || 'Shader compile failed');
        }
        return shader;
      };
      const vertexShader = compile(
        gl.VERTEX_SHADER,
        `#version 300 es
        void main() {
          vec2 point = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
          gl_Position = vec4(point * 2.0 - 1.0, 0.0, 1.0);
        }`,
      );
      const fragmentShader = compile(
        gl.FRAGMENT_SHADER,
        `#version 300 es
        precision highp float;
        out vec4 outputColor;
        void main() {
          outputColor = vec4(1.0, 0.0, 0.0, 0.5);
        }`,
      );
      const program = gl.createProgram();
      if (!program) throw new Error('Program allocation failed');
      gl.attachShader(program, vertexShader);
      gl.attachShader(program, fragmentShader);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program) || 'Program link failed');
      }

      gl.viewport(0, 0, 1, 1);
      gl.clearColor(0, 0, 0, clearAlpha);
      gl.clear(gl.COLOR_BUFFER_BIT);
      configureStraightAlphaBlending(gl);
      gl.useProgram(program);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      const pixel = new Uint8Array(4);
      gl.readPixels(
        0,
        0,
        1,
        1,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixel,
      );
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      return Array.from(pixel);
    };

    return {
      opaque: render(1),
      transparent: render(0),
    };
  });

  expect(pixels).toEqual({
    opaque: [128, 0, 0, 255],
    transparent: [128, 0, 0, 128],
  });
});

test('grid draw failure restores depth writes before the frame unwinds', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', error => {
    pageErrors.push(error.message);
  });
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture',
  );

  await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const gl = viewer.getGLContext();
    const prototype = WebGL2RenderingContext.prototype;
    const originalDrawArrays = prototype.drawArrays;
    window.__cellucidGridDepthFailure = {
      gl,
      originalDrawArrays,
      prototype,
      thrown: false,
    };
    prototype.drawArrays = function (mode, first, count) {
      const proof = window.__cellucidGridDepthFailure;
      if (
        !proof.thrown &&
        this === proof.gl &&
        mode === this.TRIANGLES &&
        count === 6
      ) {
        proof.thrown = true;
        viewer.pause();
        throw new Error('synthetic grid draw failure');
      }
      return Reflect.apply(originalDrawArrays, this, [
        mode,
        first,
        count,
      ]);
    };
    viewer.pause();
    viewer.setBackground('grid');
    viewer.resume();
  });
  await page.waitForFunction(
    () => window.__cellucidGridDepthFailure?.thrown === true,
  );
  const proof = await page.evaluate(() => {
    const state = window.__cellucidGridDepthFailure;
    state.prototype.drawArrays = state.originalDrawArrays;
    return {
      depthWrites: state.gl.getParameter(state.gl.DEPTH_WRITEMASK),
      thrown: state.thrown,
    };
  });

  expect(proof).toEqual({
    depthWrites: true,
    thrown: true,
  });
  expect(pageErrors).toContain('synthetic grid draw failure');
});

test('figure-export highlight failure restores depth writes transactionally', async ({
  page,
}) => {
  await page.goto('/tests/browser/fixtures/webgl-harness.html');
  const proof = await page.evaluate(async () => {
    const {
      rasterizePointsWebgl,
    } = await import(
      '/assets/js/app/ui/modules/figure-export/utils/webgl-point-rasterizer.js'
    );
    const prototype = WebGL2RenderingContext.prototype;
    const originalDepthMask = prototype.depthMask;
    const originalDrawArrays = prototype.drawArrays;
    const depthMasks = [];
    let pointDrawCount = 0;
    prototype.depthMask = function (enabled) {
      depthMasks.push(enabled);
      return Reflect.apply(originalDepthMask, this, [enabled]);
    };
    prototype.drawArrays = function (mode, first, count) {
      if (mode === this.POINTS) {
        pointDrawCount++;
        if (pointDrawCount === 2) {
          throw new Error('synthetic export highlight draw failure');
        }
      }
      return Reflect.apply(originalDrawArrays, this, [
        mode,
        first,
        count,
      ]);
    };

    const identity = () => Float32Array.from([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]);
    let failure = null;
    try {
      rasterizePointsWebgl({
        dimension: 3,
        colors: Uint8Array.from([255, 0, 0, 255]),
        highlightArray: Uint8Array.from([255]),
        outputHeightPx: 16,
        outputWidthPx: 16,
        pointSizePx: 4,
        positions: Float32Array.from([0, 0, 0]),
        renderState: {
          antialias: true,
          cameraPosition: [0, 0, 3],
          fogColor: [0, 0, 0],
          fogDensity: 0,
          fogFar: 3.5,
          fogNear: 2.5,
          fov: 1,
          lightDir: [0, 0, 1],
          lightingStrength: 0,
          modelMatrix: identity(),
          mvpMatrix: identity(),
          pointSize: 4,
          projectionMatrix: identity(),
          shaderQuality: 'full',
          sizeAttenuation: 1,
          viewMatrix: identity(),
          viewportHeight: 16,
          viewportWidth: 16,
        },
      });
    } catch (error) {
      failure = error.message;
    } finally {
      prototype.depthMask = originalDepthMask;
      prototype.drawArrays = originalDrawArrays;
    }
    return {
      depthMasks,
      failure,
      pointDrawCount,
    };
  });

  expect(proof).toEqual({
    depthMasks: [false, true],
    failure:
      'Figure-export WebGL2 point rasterization failed: synthetic export highlight draw failure',
    pointDrawCount: 2,
  });
});

test('figure-export canvas and PNG preserve translucent color during compositing', async ({
  page,
}) => {
  await page.goto('/tests/browser/fixtures/webgl-harness.html');
  const proof = await page.evaluate(async () => {
    // The real path: the figure-export worker draws the point pass and
    // encodes it; the page composites the frame it hands back.
    const client = await import(
      '/assets/js/app/ui/modules/figure-export/utils/figure-export-worker-client.js'
    );
    const identity = () => Float32Array.from([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]);
    const session = client.openFigureExportWorkerSession();
    try {
      const frame = await session.request('rasterizePoints', client.pointRasterArgs(session, {
        positions: Float32Array.from([0, 0, 0]),
        dimension: 3,
        colors: Uint8Array.from([255, 0, 0, 128]),
        transparency: null,
        lodMembership: null,
        drawOrder: null,
        renderState: {
          antialias: true,
          cameraPosition: [0, 0, 3],
          fogColor: [0, 0, 0],
          fogDensity: 0,
          fogFar: 3.5,
          fogNear: 2.5,
          fov: 1,
          lightDir: [0, 0, 1],
          lightingStrength: 0,
          modelMatrix: identity(),
          mvpMatrix: identity(),
          pointSize: 16,
          projectionMatrix: identity(),
          shaderQuality: 'ultralight',
          sizeAttenuation: 0,
          viewMatrix: identity(),
          viewportHeight: 16,
          viewportWidth: 16,
        },
        outputWidthPx: 16,
        outputHeightPx: 16,
        viewRect01: null,
        pointSizePx: 16,
        overlayPoints: null,
        highlightArray: null,
        emphasizeSelection: false,
        selectionMutedOpacity: 0.15,
      }));

      const composite = (source, paper) => {
        const canvas = document.createElement('canvas');
        canvas.width = 16;
        canvas.height = 16;
        const context = canvas.getContext('2d', { alpha: true });
        if (paper !== null) {
          context.fillStyle = paper;
          context.fillRect(0, 0, 16, 16);
        }
        context.drawImage(source, 0, 0);
        return Array.from(context.getImageData(8, 8, 1, 1).data);
      };
      // Read back straight: alpha applied once, not twice.
      const straightPixel = composite(frame, null);
      const immediateComposite = composite(frame, '#ffffff');
      // The frame crosses to the encoder as the pixels the page reads.
      const dataUrl = await client.requestPngDataUrl(session, client.pagePixels(frame));
      const base64 = dataUrl.slice('data:image/png;base64,'.length);
      const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
      const decodedPng = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const encodedComposite = composite(decodedPng, '#ffffff');
      decodedPng.close();
      return {
        dataUrlPrefix: dataUrl.slice(0, 'data:image/png;base64,'.length),
        encodedComposite,
        immediateComposite,
        straightPixel,
      };
    } finally {
      session.close();
    }
  });

  expect(proof).toEqual({
    dataUrlPrefix: 'data:image/png;base64,',
    encodedComposite: [255, 127, 127, 255],
    immediateComposite: [255, 127, 127, 255],
    straightPixel: [255, 0, 0, 128],
  });
});

test('repeated raster passes reuse one export context, never losing it', async ({
  page,
}) => {
  await page.goto('/tests/browser/fixtures/webgl-harness.html');
  const proof = await page.evaluate(async () => {
    // The rasterizer runs in the figure-export worker on an OffscreenCanvas;
    // here it runs on the page's own OffscreenCanvas so its contexts can be
    // counted.
    const contexts = [];
    const canvases = new Set();
    const originalGetContext = OffscreenCanvas.prototype.getContext;
    OffscreenCanvas.prototype.getContext = function getContext(type, ...args) {
      const context = originalGetContext.call(this, type, ...args);
      if (type === 'webgl2') {
        contexts.push(context);
        canvases.add(this);
      }
      return context;
    };
    try {
      const { rasterizePointsWebgl } = await import(
        '/assets/js/app/ui/modules/figure-export/utils/webgl-point-rasterizer.js'
      );
      const identity = () => Float32Array.from([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
      ]);
      const renderState = {
        antialias: true,
        cameraPosition: [0, 0, 3],
        fogColor: [0, 0, 0],
        fogDensity: 0,
        fogFar: 3.5,
        fogNear: 2.5,
        fov: 1,
        lightDir: [0, 0, 1],
        lightingStrength: 0,
        modelMatrix: identity(),
        mvpMatrix: identity(),
        pointSize: 4,
        projectionMatrix: identity(),
        shaderQuality: 'ultralight',
        sizeAttenuation: 0,
        viewMatrix: identity(),
        viewportHeight: 8,
        viewportWidth: 8,
      };
      const passes = [];
      for (let index = 0; index < 24; index++) {
        const frame = rasterizePointsWebgl({
          dimension: 3,
          colors: Uint8Array.from([255, 0, 0, 255]),
          outputHeightPx: 8,
          outputWidthPx: 8,
          pointSizePx: 4,
          positions: Float32Array.from([0, 0, 0]),
          renderState,
        });
        const canvas = document.createElement('canvas');
        canvas.width = 8;
        canvas.height = 8;
        const context = canvas.getContext('2d');
        context.drawImage(frame, 0, 0);
        const pixel = context.getImageData(4, 4, 1, 1).data;
        const [rasterCanvas] = canvases;
        passes.push({
          drewRed: pixel[0] > 0 && pixel[3] > 0,
          frameSize: `${frame.width}x${frame.height}`,
          lost: contexts[0].isContextLost(),
          shrunk: rasterCanvas.width === 1 && rasterCanvas.height === 1,
        });
        frame.close();
        await Promise.resolve();
      }
      return { passes, canvasCount: canvases.size, contextCount: contexts.length };
    } finally {
      OffscreenCanvas.prototype.getContext = originalGetContext;
    }
  });

  // Every pass draws on the same canvas and context, which shrinks to one
  // pixel after each frame leaves it.
  expect(proof.canvasCount).toBe(1);
  expect(proof.contextCount).toBe(1);
  expect(proof.passes).toEqual(
    Array.from({ length: 24 }, () => ({
      drewRed: true,
      frameSize: '8x8',
      lost: false,
      shrunk: true,
    })),
  );
});
