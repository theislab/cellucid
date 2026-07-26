import { expect, test } from '@playwright/test';

const SYNTHETIC_3D_ROOT =
  'http://127.0.0.1:4173/tests/browser/fixtures/generated-3d/';
const DATASET_ID = 'deterministic-orbit-3d';
const CELL_COUNT = 12;

const catalog = {
  version: 1,
  default: DATASET_ID,
  datasets: [{
    id: DATASET_ID,
    name: 'Deterministic 3-D orbit fixture',
    path: `${DATASET_ID}/`,
    n_cells: CELL_COUNT,
    n_genes: 0,
  }],
};

const identity = {
  version: 2,
  id: DATASET_ID,
  name: 'Deterministic 3-D orbit fixture',
  description: 'Exact synthetic browser fixture for fresh 3-D camera ownership',
  created_at: '2026-07-26T00:00:00Z',
  cellucid_data_version: '0.0.9',
  stats: {
    n_cells: CELL_COUNT,
    n_genes: 0,
    n_obs_fields: 0,
    n_categorical_fields: 0,
    n_continuous_fields: 0,
    has_connectivity: false,
    n_edges: null,
  },
  embeddings: {
    available_dimensions: [3],
    default_dimension: 3,
    files: {
      '3d': 'points_3d.bin',
    },
  },
  obs_fields: [],
  export_settings: {
    compression: null,
    var_quantization: null,
    obs_continuous_quantization: null,
    obs_categorical_dtype: 'uint8',
  },
  source: {
    name: 'Cellucid browser CI',
  },
};

const obsManifest = {
  _format: 'compact_v1',
  n_points: CELL_COUNT,
  centroid_outlier_quantile: null,
  latent_key: null,
  compression: null,
  _obsSchemas: {},
  _continuousFields: [],
  _categoricalFields: [],
};

function createDeterministic3dPositions() {
  const buffer = Buffer.alloc(CELL_COUNT * 3 * Float32Array.BYTES_PER_ELEMENT);
  for (let index = 0; index < CELL_COUNT; index++) {
    const angle = (2 * Math.PI * index) / CELL_COUNT;
    const point = [
      Math.cos(angle),
      Math.sin(angle),
      (index - ((CELL_COUNT - 1) / 2)) / ((CELL_COUNT - 1) / 2),
    ];
    for (let axis = 0; axis < point.length; axis++) {
      buffer.writeFloatLE(point[axis], ((index * 3) + axis) * 4);
    }
  }
  return buffer;
}

const positionBytes = createDeterministic3dPositions();

function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') {
      errors.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', error => {
    errors.push(`page: ${error.stack || error.message}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      errors.push(`http ${response.status()}: ${response.url()}`);
    }
  });
  return errors;
}

async function installSynthetic3dFixture(page) {
  const responses = new Map([
    [
      '/tests/browser/fixtures/generated-3d/datasets.json',
      {
        body: Buffer.from(JSON.stringify(catalog)),
        contentType: 'application/json; charset=utf-8',
      },
    ],
    [
      `/tests/browser/fixtures/generated-3d/${DATASET_ID}/dataset_identity.json`,
      {
        body: Buffer.from(JSON.stringify(identity)),
        contentType: 'application/json; charset=utf-8',
      },
    ],
    [
      `/tests/browser/fixtures/generated-3d/${DATASET_ID}/obs_manifest.json`,
      {
        body: Buffer.from(JSON.stringify(obsManifest)),
        contentType: 'application/json; charset=utf-8',
      },
    ],
    [
      `/tests/browser/fixtures/generated-3d/${DATASET_ID}/points_3d.bin`,
      {
        body: positionBytes,
        contentType: 'application/octet-stream',
      },
    ],
  ]);

  await page.route(`${SYNTHETIC_3D_ROOT}**`, async route => {
    const pathname = new URL(route.request().url()).pathname;
    const response = responses.get(pathname);
    if (response === undefined) {
      await route.fulfill({
        status: 404,
        contentType: 'text/plain; charset=utf-8',
        body: `Unexpected synthetic fixture request: ${pathname}\n`,
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: response.contentType,
      body: response.body,
    });
  });
}

test('a fresh deterministic 3-D dataset selects dimension 3 and Orbit', async ({
  context,
  page,
}) => {
  expect(await context.storageState()).toEqual({
    cookies: [],
    origins: [],
  });
  const productErrors = observeProductErrors(page);
  await installSynthetic3dFixture(page);

  await page.goto(
    `/?exportsBaseUrl=${encodeURIComponent(SYNTHETIC_3D_ROOT)}` +
      `&dataset=${DATASET_ID}&acceptance=fresh-3d-orbit-ci`,
    { waitUntil: 'domcontentloaded' },
  );

  await expect(page.locator('#dataset-name')).toHaveText(
    'Deterministic 3-D orbit fixture',
  );
  await expect(page.locator('#dataset-cells')).toHaveText(String(CELL_COUNT));
  await expect(page.locator('#dataset-genes')).toHaveText('0');
  await expect(page.locator('#filter-count')).toHaveText(
    `Showing all ${CELL_COUNT} points`,
  );
  await expect(page.locator('#dimension-select')).toHaveValue('3');
  await expect(page.locator('#navigation-mode')).toHaveValue('orbit');
  await expect(page.locator('.cinematic-transport-bar')).toHaveCount(0);

  expect(productErrors).toEqual([]);
});

test('public viewer controls reject invalid values before renderer mutation', async ({
  page,
}) => {
  const productErrors = observeProductErrors(page);
  await installSynthetic3dFixture(page);

  await page.goto(
    `/?exportsBaseUrl=${encodeURIComponent(SYNTHETIC_3D_ROOT)}` +
      `&dataset=${DATASET_ID}&acceptance=viewer-public-control-contract`,
    { waitUntil: 'domcontentloaded' },
  );
  await expect(page.locator('#dataset-name')).toHaveText(
    'Deterministic 3-D orbit fixture',
  );

  const result = await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const gl = viewer.getGLContext();
    const originalCreateShader = gl.createShader.bind(gl);
    let invalidCallShaderCreations = 0;
    gl.createShader = (...args) => {
      invalidCallShaderCreations += 1;
      return originalCreateShader(...args);
    };
    const livePositions = viewer.getPositions();
    const liveColors = viewer.getColors();
    const liveTransparency = viewer.getViewTransparency('live');
    const liveDimension = viewer.getViewDimension('live');
    const before = {
      connectivityShown: viewer.getShowConnectivity(),
      connectivityLineWidth: viewer.getConnectivityLineWidth(),
      connectivityAlpha: viewer.getConnectivityAlpha(),
      connectivityColor: viewer.getConnectivityColor(),
      centroidFlags: viewer.getCentroidFlags('live'),
      liveViewLabel: viewer.getLiveViewLabel(),
      liveViewHidden: viewer.getLiveViewHidden(),
      viewLayout: viewer.getViewLayout(),
      edgeLodLimit: viewer.getEdgeLodLimit(),
      highlightMode: viewer.getHighlightMode(),
      cellSelectionEnabled: viewer.getCellSelectionEnabled(),
      lassoEnabled: viewer.getLassoEnabled(),
      proximityEnabled: viewer.getProximityEnabled(),
      knnEnabled: viewer.getKnnEnabled(),
      positions: Array.from(livePositions),
      colors: Array.from(liveColors),
      transparency: Array.from(liveTransparency),
      pointCount: viewer.getPointCount(),
      dimension: liveDimension,
    };
    const invalidCalls = [
      ['setShowCentroidPoints', [0, 'live']],
      ['setShowCentroidLabels', [0, 'live']],
      ['setLookSensitivity', [1]],
      ['setMoveSpeed', [6]],
      ['setOrbitInvertRotation', ['false']],
      ['setOrbitInvertX', [1]],
      ['setPlanarZoomToCursor', ['true']],
      ['setPlanarInvertAxes', [null]],
      ['setOrbitKeySpeed', [3]],
      ['setPlanarPanSpeed', [0]],
      ['setPointerLockEnabled', ['false']],
      ['setPointerLockEnabled', [true]],
      ['setPointerLockChangeHandler', [42]],
      ['setProjectilesEnabled', ['false']],
      ['setProjectilesEnabled', [false, 42]],
      ['setShowOrbitAnchor', [1]],
      ['setShowConnectivity', ['false']],
      ['setConnectivityLineWidth', [100]],
      ['setConnectivityAlpha', [0]],
      ['setConnectivityColor', [12.5, 20, 30]],
      ['setEdgeDebugMode', [1]],
      ['setViewFocusHandler', [42]],
      ['setNavigationModeChangeHandler', [42]],
      ['setLiveViewLabel', ['   ']],
      ['setLiveViewHidden', [1]],
      ['setLiveViewHidden', [true]],
      ['setCentroidLabels', [null, 'live']],
      [
        'setCentroids',
        [{
          positions: new Float32Array(),
          colors: new Uint8Array(),
          outlierQuantiles: new Float32Array(),
        }],
      ],
      [
        'setCentroids',
        [{
          positions: new Float32Array(3),
          colors: new Uint8Array(3),
        }],
      ],
      ['setVectorFieldOverlayEnabled', [1]],
      ['setVectorFieldConfig', ['', 1]],
      ['setVectorFieldConfig', ['unknown-setting', 1]],
      ['setVectorFieldConfig', ['particleCount', 1.5]],
      ['setActiveVectorField', ['  velocity  ']],
      [
        'setVectorFieldData',
        ['velocity', 3, {
          vectors: new Float32Array([0, 0, Number.NaN]),
          components: 3,
          cellCount: 1,
          maxMagnitude: 1,
        }],
      ],
      ['hasVectorFieldForDimension', ['', 3]],
      ['setAdaptiveLOD', [1]],
      ['setFrustumCulling', [1]],
      ['setForceLOD', [1.5]],
      ['setViewLayout', ['garbage', 'live']],
      ['setViewLayout', ['grid', 'ghost']],
      ['setEdgeLodLimit', ['4.9']],
      ['setHighlightMode', ['garbage']],
      ['setCellSelectionEnabled', ['false']],
      ['setLassoEnabled', ['false']],
      ['setProximityEnabled', ['false']],
      ['setKnnEnabled', ['false']],
      ['setCellSelectionCallback', [42]],
      ['setSelectionStepCallback', [42]],
      ['setSelectionPreviewCallback', [42]],
      ['setLassoCallback', [42]],
      ['setLassoPreviewCallback', [42]],
      ['setLassoStepCallback', [42]],
      ['setProximityCallback', [42]],
      ['setProximityPreviewCallback', [42]],
      ['setProximityStepCallback', [42]],
      ['setKnnCallback', [42]],
      ['setKnnPreviewCallback', [42]],
      ['setKnnStepCallback', [42]],
      ['setKnnEdgeLoadCallback', [42]],
      ['setViewCameraState', ['ghost', viewer.getCameraState()]],
      ['setViewNavigationMode', ['ghost', 'orbit']],
      ['getCurrentLODLevel', ['ghost']],
      ['updatePositions', [Array.from(livePositions)]],
      [
        'updatePositions',
        [new Float32Array(livePositions.length - 3)],
      ],
      [
        'updatePositions',
        [Float32Array.from(livePositions, (value, index) =>
          index === 0 ? Number.NaN : value)],
      ],
      ['updateColors', [new Uint8Array(liveColors.length - 4)]],
      [
        'updateTransparency',
        [new Float32Array(liveTransparency.length - 1)],
      ],
      [
        'updateTransparency',
        [Float32Array.from(liveTransparency, (value, index) =>
          index === 0 ? 2 : value)],
      ],
      [
        'setData',
        [{
          positions: Array.from(livePositions),
          colors: liveColors,
          transparency: liveTransparency,
          dimensionLevel: liveDimension,
        }],
      ],
      [
        'setData',
        [{
          positions: livePositions,
          colors: liveColors,
          transparency: liveTransparency,
          dimensionLevel: liveDimension,
          outlierQuantiles: new Float32Array(liveTransparency.length),
        }],
      ],
      [
        'setViewPositions',
        ['ghost', new Float32Array(viewer.getViewPositions('live').length)],
      ],
    ];
    const accepted = [];
    const rejected = [];
    for (const [method, args] of invalidCalls) {
      try {
        viewer[method](...args);
        accepted.push(method);
      } catch (error) {
        rejected.push({
          method,
          errorName: error?.name,
          message: error?.message,
        });
      }
    }
    gl.createShader = originalCreateShader;
    const validLabel = document.createElement('div');
    viewer.setCentroidLabels([
      {
        el: validLabel,
        position: [0, 0, 0],
        alpha: 0.5,
      },
    ], 'live');
    viewer.setCentroidLabels([], 'live');
    let ghostPositionsReadable = false;
    try {
      viewer.getViewPositions('ghost');
      ghostPositionsReadable = true;
    } catch {
      ghostPositionsReadable = false;
    }
    const after = {
      connectivityShown: viewer.getShowConnectivity(),
      connectivityLineWidth: viewer.getConnectivityLineWidth(),
      connectivityAlpha: viewer.getConnectivityAlpha(),
      connectivityColor: viewer.getConnectivityColor(),
      centroidFlags: viewer.getCentroidFlags('live'),
      liveViewLabel: viewer.getLiveViewLabel(),
      liveViewHidden: viewer.getLiveViewHidden(),
      viewLayout: viewer.getViewLayout(),
      edgeLodLimit: viewer.getEdgeLodLimit(),
      highlightMode: viewer.getHighlightMode(),
      cellSelectionEnabled: viewer.getCellSelectionEnabled(),
      lassoEnabled: viewer.getLassoEnabled(),
      proximityEnabled: viewer.getProximityEnabled(),
      knnEnabled: viewer.getKnnEnabled(),
      positions: Array.from(viewer.getPositions()),
      colors: Array.from(viewer.getColors()),
      transparency: Array.from(viewer.getViewTransparency('live')),
      pointCount: viewer.getPointCount(),
      dimension: viewer.getViewDimension('live'),
    };
    return {
      accepted,
      rejected,
      before,
      after,
      ghostPositionsReadable,
      invalidCallShaderCreations,
      attempted: invalidCalls.length,
      removedMethodsAbsent:
        viewer.updateOutlierQuantiles === undefined &&
        viewer.clearViewDimensionState === undefined,
    };
  });

  expect(result.accepted).toEqual([]);
  expect(result.rejected).toHaveLength(result.attempted);
  expect(result.after).toEqual(result.before);
  expect(result.ghostPositionsReadable).toBe(false);
  expect(result.invalidCallShaderCreations).toBe(0);
  expect(result.removedMethodsAbsent).toBe(true);
  expect(productErrors).toEqual([]);
});

test('a failed GPU dataset publication preserves the complete live renderer', async ({
  page,
}) => {
  const productErrors = observeProductErrors(page);
  await installSynthetic3dFixture(page);

  await page.goto(
    `/?exportsBaseUrl=${encodeURIComponent(SYNTHETIC_3D_ROOT)}` +
      `&dataset=${DATASET_ID}&acceptance=renderer-data-transaction`,
    { waitUntil: 'domcontentloaded' },
  );
  await expect(page.locator('#dataset-name')).toHaveText(
    'Deterministic 3-D orbit fixture',
  );

  const result = await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const gl = viewer.getGLContext();
    const before = {
      pointCount: viewer.getPointCount(),
      dimension: viewer.getViewDimension('live'),
      positions: Array.from(viewer.getPositions()),
      colors: Array.from(viewer.getColors()),
      transparency: Array.from(viewer.getViewTransparency('live')),
      renderer: viewer.debugRendererStatus(),
    };
    const replacementCount = before.pointCount + 1;
    const replacement = {
      positions: new Float32Array(replacementCount * 3),
      colors: new Uint8Array(replacementCount * 4).fill(127),
      transparency: new Float32Array(replacementCount).fill(1),
      dimensionLevel: 2,
    };
    const originalBufferData = gl.bufferData.bind(gl);
    let injected = false;
    gl.bufferData = (...args) => {
      if (!injected && args[0] === gl.ARRAY_BUFFER) {
        injected = true;
        throw new Error('synthetic candidate point-buffer upload failure');
      }
      return originalBufferData(...args);
    };
    let failure = null;
    try {
      viewer.setData(replacement);
    } catch (error) {
      failure = {
        name: error?.name,
        message: error?.message,
      };
    } finally {
      gl.bufferData = originalBufferData;
    }
    const after = {
      pointCount: viewer.getPointCount(),
      dimension: viewer.getViewDimension('live'),
      positions: Array.from(viewer.getPositions()),
      colors: Array.from(viewer.getColors()),
      transparency: Array.from(viewer.getViewTransparency('live')),
      renderer: viewer.debugRendererStatus(),
    };
    return {
      before,
      after,
      failure,
      injected,
      webglError: gl.getError(),
    };
  });

  expect(result.injected).toBe(true);
  expect(result.failure).toEqual({
    name: 'Error',
    message: 'synthetic candidate point-buffer upload failure',
  });
  expect(result.after).toEqual(result.before);
  expect(result.webglError).toBe(0);
  expect(productErrors).toEqual([]);
});

test('adaptive LOD publishes complete dimension-owned GPU resources', async ({
  page,
}) => {
  const productErrors = observeProductErrors(page);
  await installSynthetic3dFixture(page);

  await page.goto(
    `/?exportsBaseUrl=${encodeURIComponent(SYNTHETIC_3D_ROOT)}` +
      `&dataset=${DATASET_ID}&acceptance=renderer-lod-transaction`,
    { waitUntil: 'domcontentloaded' },
  );
  await expect(page.locator('#dataset-name')).toHaveText(
    'Deterministic 3-D orbit fixture',
  );

  const result = await page.evaluate(async () => {
    const viewer = window._cellucidViewer;
    viewer.setAdaptiveLOD(true);
    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    const status = viewer.debugRendererStatus();
    return {
      pointCount: status.pointCount,
      dimension: status.currentDimensionLevel,
      useAdaptiveLOD: status.useAdaptiveLOD,
      spatialIndicesCount: status.spatialIndicesCount,
      lodBuffersCount: status.lodBuffersCount,
      webglError: viewer.getGLContext().getError(),
    };
  });

  expect(result).toMatchObject({
    pointCount: CELL_COUNT,
    dimension: 3,
    useAdaptiveLOD: true,
    spatialIndicesCount: 1,
    webglError: 0,
  });
  expect(result.lodBuffersCount).toBeGreaterThan(0);
  expect(productErrors).toEqual([]);
});
