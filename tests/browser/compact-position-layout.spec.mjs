// Positions are held with exactly the embedding's components per cell.
//
// A 1-D or 2-D embedding is never padded to XYZ: the CPU array, the GPU
// position stream, the compact LOD store, the edge position texture and the
// smoke splat all carry one float per embedding axis, and every reader treats
// a missing axis as the zero it is. These contracts prove the narrower layout
// draws and splats exactly what the zero-padded one did, and that a dataset
// with 1-D, 2-D and 3-D embeddings keeps every view in its own layout through
// dimension switching, kept views, LOD, picking, connectivity and export.

import { expect, test } from './helpers/test.mjs';
import { appUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { installMultiDimensionFixture } from './helpers/multi-dimension-fixture.mjs';

const HARNESS_URL = '/tests/browser/fixtures/webgl-harness.html';
const ROOT = appUrl('/tests/browser/fixtures/generated-multi-dimension/');
const DATASET_ID = 'compact-layout-1d-2d-3d';
const CELL_COUNT = 20_000;

test('a 1D or 2D position stream draws and splats exactly what its zero-padded XYZ stream did', async ({
  page,
}) => {
  await page.goto(HARNESS_URL);
  const result = await page.evaluate(async () => {
    const { HighPerfRenderer } = await import(
      '/assets/js/rendering/high-perf-renderer.js'
    );
    const { buildDensityTextureGPU, disposeDensityPipelineResources } =
      await import('/assets/js/rendering/smoke-cloud/smoke-density.js');
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    document.body.append(canvas);
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      preserveDrawingBuffer: true,
    });
    const pointCount = 4096;
    let seed = 7;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const colors = new Uint8Array(pointCount * 4);
    for (let index = 0; index < pointCount; index++) {
      colors[index * 4] = 40 + (index % 200);
      colors[index * 4 + 1] = 40 + ((index * 7) % 200);
      colors[index * 4 + 2] = 40 + ((index * 13) % 200);
      colors[index * 4 + 3] = 255;
    }
    const identity = () => Float32Array.from([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]);
    const params = dimensionLevel => ({
      autoFog: false,
      cameraDistance: 3,
      cameraPosition: Float32Array.from([0, 0, 3]),
      dimensionLevel,
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
      viewId: 'live',
      viewMatrix: identity(),
      viewportHeight: 128,
      viewportWidth: 128,
    });
    const draw = (renderer, positions, dimensionLevel) => {
      renderer.loadData(positions, colors, {
        dimensionLevel,
      });
      gl.viewport(0, 0, 128, 128);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      renderer.render(params(dimensionLevel), false);
      gl.finish();
      const pixels = new Uint8Array(128 * 128 * 4);
      gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return {
        gpuBytes: renderer._positionGpuByteLength,
        pixels,
      };
    };
    const readVolume = (candidate, gridSize) => {
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      const bytes = new Uint8Array(gridSize * gridSize * gridSize * 4);
      const slice = new Uint8Array(gridSize * gridSize * 4);
      for (let layer = 0; layer < gridSize; layer++) {
        gl.framebufferTextureLayer(
          gl.FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          candidate.texture,
          0,
          layer,
        );
        gl.readPixels(0, 0, gridSize, gridSize, gl.RGBA, gl.UNSIGNED_BYTE, slice);
        bytes.set(slice, layer * slice.length);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(framebuffer);
      return bytes;
    };

    const outcomes = [];
    const renderer = new HighPerfRenderer(gl, {
      USE_FRUSTUM_CULLING: false,
      USE_LOD: false,
    });
    for (const dimension of [1, 2]) {
      const compact = new Float32Array(pointCount * dimension);
      const padded = new Float32Array(pointCount * 3);
      for (let index = 0; index < pointCount; index++) {
        for (let axis = 0; axis < dimension; axis++) {
          const value = random() * 1.8 - 0.9;
          compact[index * dimension + axis] = value;
          padded[index * 3 + axis] = value;
        }
      }
      const compactDraw = draw(renderer, compact, dimension);
      const paddedDraw = draw(renderer, padded, 3);
      let mismatches = 0;
      let litPixels = 0;
      for (let index = 0; index < compactDraw.pixels.length; index += 4) {
        if (compactDraw.pixels[index + 3] !== 0) litPixels++;
        for (let channel = 0; channel < 4; channel++) {
          if (
            compactDraw.pixels[index + channel] !==
              paddedDraw.pixels[index + channel]
          ) {
            mismatches++;
          }
        }
      }

      const gridSize = 16;
      const colors = new Uint8Array((compact.length / dimension) * 4).fill(255);
      const compactVolume = buildDensityTextureGPU(gl, compact, {
        colors,
        dimension,
        gamma: 0.7,
        gridSize,
      });
      const paddedVolume = buildDensityTextureGPU(gl, padded, {
        colors,
        dimension: 3,
        gamma: 0.7,
        gridSize,
      });
      const compactVoxels = readVolume(compactVolume, gridSize);
      const paddedVoxels = readVolume(paddedVolume, gridSize);
      let voxelMismatches = 0;
      let occupiedVoxels = 0;
      for (let index = 0; index < compactVoxels.length; index += 4) {
        if (compactVoxels[index] !== 0) occupiedVoxels++;
        if (compactVoxels[index] !== paddedVoxels[index]) voxelMismatches++;
      }
      gl.deleteTexture(compactVolume.texture);
      gl.deleteTexture(paddedVolume.texture);
      outcomes.push({
        dimension,
        compactGpuBytes: compactDraw.gpuBytes,
        paddedGpuBytes: paddedDraw.gpuBytes,
        litPixels,
        mismatches,
        occupiedVoxels,
        voxelMismatches,
      });
    }
    renderer.dispose();
    disposeDensityPipelineResources(gl);
    return { glError: gl.getError(), outcomes, pointCount };
  });

  expect(result.glError).toBe(0);
  for (const outcome of result.outcomes) {
    expect(outcome.compactGpuBytes).toBe(
      result.pointCount * outcome.dimension * 4,
    );
    expect(outcome.paddedGpuBytes).toBe(result.pointCount * 12);
    expect(outcome.litPixels).toBeGreaterThan(100);
    expect(outcome.mismatches).toBe(0);
    expect(outcome.occupiedVoxels).toBeGreaterThan(0);
    expect(outcome.voxelMismatches).toBe(0);
  }
});

async function exportFigure(page, format) {
  await page.getByLabel('Download format').selectOption(format);
  if (format === 'svg') {
    await page.getByLabel('SVG point strategy').selectOption('full-vector');
  }
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#figure-export-btn').click();
  const download = await downloadPromise;
  await expect(page.locator('#figure-export-btn')).toHaveText('Export');
  expect(await download.failure()).toBeNull();
  const stream = await download.createReadStream();
  let bytes = 0;
  for await (const chunk of stream) bytes += chunk.length;
  return bytes;
}

test('1D, 2D and 3D views each keep their own layout through switching, kept views, LOD, picking and export', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const productErrors = [];
  page.on('pageerror', error => {
    productErrors.push(`page: ${error.stack || error.message}`);
  });
  page.on('console', message => {
    if (message.type() === 'error') {
      productErrors.push(`console: ${message.text()}`);
    }
  });
  await installMultiDimensionFixture(page, {
    root: ROOT,
    datasetId: DATASET_ID,
    name: 'Compact layout fixture',
    cellCount: CELL_COUNT,
  });
  await page.goto(
    `/?sampleCatalog=${encodeURIComponent(ROOT)}&dataset=${DATASET_ID}`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Compact layout fixture',
  );

  const describeViews = () => page.evaluate(async () => {
    const viewer = window._cellucidViewer;
    const state = window._cellucidState;
    const renderer = viewer.getHPRenderer();
    const views = ['live', ...viewer.getSnapshotViews().map(view => view.id)];
    const described = {};
    for (const viewId of views) {
      const dimension = viewer.getViewDimension(viewId);
      const positions = viewer.getViewPositions(viewId);
      const layoutKey = viewer.getViewLayoutKey(viewId);
      if (layoutKey !== state.getViewLayoutKey(viewId)) {
        throw new Error(`View "${viewId}" layout owners disagree.`);
      }
      const normalized = await state.dimensionManager.getPositions(layoutKey);
      const cell = 1234;
      const point = viewer.getCellPosition(cell, viewId);
      described[viewId] = {
        dimension,
        rendererDimension: renderer.getViewPositionDimension(viewId),
        positionLength: positions.length,
        matchesEmbedding:
          positions.length === normalized.length &&
          positions.every((value, index) => value === normalized[index]),
        point: [point.x, point.y, point.z],
        expectedPoint: [0, 1, 2].map(axis => (
          axis < dimension ? normalized[cell * dimension + axis] : 0
        )),
      };
    }
    return {
      described,
      livePositionGpuBytes: renderer._positionGpuByteLength,
      liveStateLength: state.positionsArray.length,
      liveStateDimension: state.positionsDimension,
      pointCount: viewer.getPointCount(),
    };
  });

  const initial = await describeViews();
  expect(initial.pointCount).toBe(CELL_COUNT);
  expect(initial.described.live).toMatchObject({
    dimension: 3,
    rendererDimension: 3,
    positionLength: CELL_COUNT * 3,
    matchesEmbedding: true,
  });
  expect(initial.livePositionGpuBytes).toBe(CELL_COUNT * 12);

  await page.evaluate(() => window._cellucidState.showDefaultRepresentation('live', 2));
  const live2d = await describeViews();
  expect(live2d.described.live).toMatchObject({
    dimension: 2,
    rendererDimension: 2,
    positionLength: CELL_COUNT * 2,
    matchesEmbedding: true,
  });
  expect(live2d.described.live.point).toEqual(
    live2d.described.live.expectedPoint,
  );
  expect(live2d.described.live.point[2]).toBe(0);
  expect(live2d.livePositionGpuBytes).toBe(CELL_COUNT * 8);
  expect(live2d.liveStateLength).toBe(CELL_COUNT * 2);
  expect(live2d.liveStateDimension).toBe(2);

  // Smoke reads the live 2D source in its own layout.
  const smoke = await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const source = window._cellucidState.getSmokeDensitySource();
    const summary = viewer.buildSmokeVolumeGPU(source.positions, {
      colors: source.colors,
      dimension: source.dimension,
      gamma: 0.7,
      gridSize: 16,
    });
    viewer.clearSmokeVolume();
    return {
      dimension: source.dimension,
      empty: summary.empty === true,
      // A 2D embedding has z = 0 for every cell.
      zCenter: (summary.boundsMin[2] + summary.boundsMax[2]) / 2,
    };
  });
  expect(smoke).toEqual({ dimension: 2, empty: false, zCenter: 0 });

  // Keep the 2D view, then move live to 3D and the kept view to 1D.
  await page.locator('#split-keep-view-btn').click();
  await expect.poll(() => page.evaluate(
    () => window._cellucidViewer.getSnapshotViews().length,
  )).toBe(1);
  const snapshotId = await page.evaluate(
    () => window._cellucidViewer.getSnapshotViews()[0].id,
  );
  await page.evaluate(async id => {
    const state = window._cellucidState;
    await state.showDefaultRepresentation('live', 3);
    await state.showDefaultRepresentation(id, 1);
  }, snapshotId);
  const mixed = await describeViews();
  expect(mixed.described.live).toMatchObject({
    dimension: 3,
    rendererDimension: 3,
    positionLength: CELL_COUNT * 3,
    matchesEmbedding: true,
  });
  expect(mixed.described[snapshotId]).toMatchObject({
    dimension: 1,
    rendererDimension: 1,
    positionLength: CELL_COUNT,
    matchesEmbedding: true,
  });
  expect(mixed.described[snapshotId].point).toEqual(
    mixed.described[snapshotId].expectedPoint,
  );
  expect(mixed.described[snapshotId].point.slice(1)).toEqual([0, 0]);

  // LOD, frustum culling, picking and connectivity across the mixed panes.
  const interaction = await page.evaluate(async id => {
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
    const renderer = viewer.getHPRenderer();
    const frames = async count => {
      for (let frame = 0; frame < count; frame++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
    };
    viewer.setAdaptiveLOD(true);
    viewer.setFrustumCulling(true);
    viewer.setForceLOD(0);
    // The trees with their levels are built off the main thread; until they
    // land each pane draws full detail, and each store then takes its tree's
    // order a band at a time.
    for (let frame = 0; frame < 600; frame++) {
      await frames(1);
      if (viewer.getCurrentLODLevel('live') >= 0 && viewer.getCurrentLODLevel(id) >= 0 && viewer.isPresentedGeometrySettled()) break;
    }
    await frames(2);
    const lodLevels = {
      live: viewer.getCurrentLODLevel('live'),
      snapshot: viewer.getCurrentLODLevel(id),
    };
    // The live store holds its 3D positions (12 bytes a cell) in the
    // draw order of its tree, whole (every presented view draws from its
    // final geometry: the renderer compares the store's order with its
    // tree's); LOD keeps no second copy.
    const compactBytesMatchLayout =
      renderer._positionGpuByteLength === viewer.getPointCount() * 3 * 4 &&
      viewer.debugRendererStatus().drawOrderComplete === true &&
      viewer.isPresentedGeometrySettled();
    viewer.setForceLOD(-1);
    viewer.setAdaptiveLOD(false);
    await frames(3);

    const canvas = document.getElementById('glcanvas');
    const rect = canvas.getBoundingClientRect();
    let picked = null;
    for (let step = 0; step < 400 && picked === null; step++) {
      const x = rect.left + rect.width * (0.05 + 0.9 * ((step * 37) % 400) / 400);
      const y = rect.top + rect.height * (0.1 + 0.8 * ((step * 53) % 400) / 400);
      const cell = viewer.pickCellAtScreen(x, y);
      if (cell >= 0) picked = cell;
    }

    const nCells = viewer.getPointCount();
    const sources = new Uint32Array(nCells - 1);
    const destinations = new Uint32Array(nCells - 1);
    for (let index = 0; index < nCells - 1; index++) {
      sources[index] = index;
      destinations[index] = index + 1;
    }
    const liveEdges = viewer.setupEdgesV2(
      edgePayloadOf(sources, destinations, new Float32Array(nCells - 1).fill(1), nCells),
    );
    const snapshotEdges = viewer.setupEdgesV2ForView(id);
    // Each pane reads its shown edges' positions from its own geometry (3D
    // live, 1D snapshot): records are cells whatever the dimension, so a
    // frame draws both panes and holds one record store a pane.
    viewer.setEdgeVisibleTarget(nCells - 1);
    viewer.refreshEdgeSelectionForView('live');
    viewer.refreshEdgeSelectionForView(id);
    viewer.setShowConnectivity(true);
    await frames(2);
    const memory = viewer.getConnectivityMemoryStats();
    const edgePanes = Object.fromEntries(
      memory.panes.map(pane => [pane.viewId, pane.shownCount > 0 && pane.gpuBytes === pane.shownCount * 40]),
    );
    viewer.setShowConnectivity(false);
    viewer.clearEdgesV2();
    return {
      compactBytesMatchLayout,
      edgePanes,
      liveEdges,
      lodLevels,
      picked,
      snapshotEdges,
      snapshotHasStats: viewer.hasRendererStats(id),
    };
  }, snapshotId);
  expect(interaction.compactBytesMatchLayout).toBe(true);
  expect(interaction.lodLevels.live).toBeGreaterThanOrEqual(0);
  expect(interaction.lodLevels.snapshot).toBeGreaterThanOrEqual(0);
  expect(interaction.snapshotHasStats).toBe(true);
  expect(interaction.picked).not.toBeNull();
  expect(interaction.liveEdges).toBe(true);
  expect(interaction.snapshotEdges).toBe(true);
  expect(interaction.edgePanes).toEqual({
    live: true,
    [snapshotId]: true,
  });

  // Figure export of the mixed-dimension multiview, raster and vector.
  await page.locator('#figure-export-section > summary').click();
  await page.getByRole('button', { name: /^Download\b/ }).click();
  expect(await exportFigure(page, 'png')).toBeGreaterThan(1000);
  expect(await exportFigure(page, 'svg')).toBeGreaterThan(1000);

  expect(productErrors).toEqual([]);
});
