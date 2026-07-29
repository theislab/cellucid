import { expect, test } from '@playwright/test';
import { dismissWelcome } from './helpers/welcome.mjs';

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
    available_dimensions: [2, 3],
    default_dimension: 3,
    files: {
      '2d': 'points_2d.bin',
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
  const points = [
    [0, 0, 0],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
    [0.7, 0.7, 0.7],
    [-0.7, -0.7, -0.7],
    [0.7, -0.7, 0.7],
    [-0.7, 0.7, -0.7],
    [0.7, 0.7, -0.7],
  ];
  for (let index = 0; index < CELL_COUNT; index++) {
    const point = points[index];
    for (let axis = 0; axis < point.length; axis++) {
      buffer.writeFloatLE(point[axis], ((index * 3) + axis) * 4);
    }
  }
  return buffer;
}

function createDeterministic2dPositions() {
  const positions3d = createDeterministic3dPositions();
  const positions2d = Buffer.alloc(
    CELL_COUNT * 2 * Float32Array.BYTES_PER_ELEMENT,
  );
  for (let index = 0; index < CELL_COUNT; index++) {
    for (let axis = 0; axis < 2; axis++) {
      positions2d.writeFloatLE(
        positions3d.readFloatLE(((index * 3) + axis) * 4),
        ((index * 2) + axis) * 4,
      );
    }
  }
  return positions2d;
}

const position2dBytes = createDeterministic2dPositions();
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
      `/tests/browser/fixtures/generated-3d/${DATASET_ID}/points_2d.bin`,
      {
        body: position2dBytes,
        contentType: 'application/octet-stream',
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

async function readTargetVisualCenter(page) {
  return page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const camera = viewer.getCameraState();
    const render = viewer.getRenderState();
    const matrix = render.mvpMatrix;
    const [x, y, z] = camera.orbit.target;
    const clipX =
      matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
    const clipW =
      matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
    const canvas = document.getElementById('glcanvas');
    const sidebar = document.getElementById('sidebar');
    const canvasRect = canvas.getBoundingClientRect();
    const sidebarRight = sidebar.offsetLeft + sidebar.offsetWidth;
    const visibleLeft = sidebar.classList.contains('hidden')
      ? canvasRect.left
      : Math.max(canvasRect.left, sidebarRight);
    return {
      camera,
      navigationMode: viewer.getNavigationMode(),
      projectedX:
        canvasRect.left + (((clipX / clipW) + 1) * canvasRect.width) / 2,
      expectedX: (visibleLeft + canvasRect.right) / 2,
      expectedY: (canvasRect.top + canvasRect.bottom) / 2,
      sidebarWidth: sidebar.offsetWidth,
    };
  });
}

async function waitForTargetVisualCenter(page, expectedSidebarWidth = null) {
  let settledSample = null;
  await expect.poll(async () => {
    const sample = await readTargetVisualCenter(page);
    const widthMatches =
      expectedSidebarWidth === null ||
      sample.sidebarWidth === expectedSidebarWidth;
    const centerMatches =
      Math.abs(sample.projectedX - sample.expectedX) < 1;
    if (widthMatches && centerMatches) {
      settledSample = sample;
      return true;
    }
    return false;
  }).toBe(true);
  return settledSample;
}

async function keepCurrentViewThroughUi(page) {
  await page.locator('#split-keep-view-btn').click();
  await expect.poll(() => page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const state = window._cellucidState;
    const snapshots = viewer.getSnapshotViews();
    if (snapshots.length !== 1) {
      return { snapshotCount: snapshots.length };
    }
    const snapshotId = snapshots[0].id;
    const layout = viewer.getViewLayout();
    return {
      snapshotCount: snapshots.length,
      snapshotId,
      activeId: state.getActiveViewId(),
      stateDimension: state.getViewDimensionLevel(snapshotId),
      viewerDimension: viewer.getViewDimension(snapshotId),
      layout,
      badgeCount: document.querySelectorAll('.split-badge').length,
    };
  })).toEqual({
    snapshotCount: 1,
    snapshotId: 'snap_1',
    activeId: 'snap_1',
    stateDimension: 3,
    viewerDimension: 3,
    layout: {
      mode: 'grid',
      activeId: 'snap_1',
      liveViewHidden: false,
    },
    badgeCount: 2,
  });
  return 'snap_1';
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
  await dismissWelcome(page);

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

test('snapshot dimension switches publish one exact geometry generation', async ({
  page,
}) => {
  const productErrors = observeProductErrors(page);
  await installSynthetic3dFixture(page);

  await page.goto(
    `/?exportsBaseUrl=${encodeURIComponent(SYNTHETIC_3D_ROOT)}` +
      `&dataset=${DATASET_ID}&acceptance=snapshot-dimension-generation`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Deterministic 3-D orbit fixture',
  );

  const snapshotId = await keepCurrentViewThroughUi(page);
  const result = await page.evaluate(async (viewId) => {
    const state = window._cellucidState;
    const viewer = window._cellucidViewer;
    const publish = async dimensionLevel => {
      await state.setDimensionLevel(dimensionLevel, { viewId });
      await new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      });
      return {
        state: state.getViewDimensionLevel(viewId),
        viewer: viewer.getViewDimension(viewId),
      };
    };
    return {
      twoDimensional: await publish(2),
      threeDimensional: await publish(3),
      webglError: viewer.getGLContext().getError(),
    };
  }, snapshotId);

  expect(result).toEqual({
    twoDimensional: {
      state: 2,
      viewer: 2,
    },
    threeDimensional: {
      state: 3,
      viewer: 3,
    },
    webglError: 0,
  });
  expect(productErrors).toEqual([]);
});

test('a navigation observer failure cannot enter dimension rollback', async ({
  page,
}) => {
  await installSynthetic3dFixture(page);

  await page.goto(
    `/?exportsBaseUrl=${encodeURIComponent(SYNTHETIC_3D_ROOT)}` +
      `&dataset=${DATASET_ID}&acceptance=dimension-observer-boundary`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Deterministic 3-D orbit fixture',
  );

  const result = await page.evaluate(async () => {
    const state = window._cellucidState;
    const viewer = window._cellucidViewer;
    const marker = 'synthetic navigation observer failure';
    const observedErrors = [];
    const onError = event => {
      observedErrors.push(event.error?.message ?? event.message);
      event.preventDefault();
    };
    window.addEventListener('error', onError);
    viewer.setNavigationModeChangeHandler(() => {
      throw new Error(marker);
    });

    let rejection = null;
    try {
      await state.setDimensionLevel(2, { viewId: 'live' });
    } catch (error) {
      rejection = error instanceof Error ? error.message : String(error);
    }
    await new Promise(resolve => setTimeout(resolve, 0));
    window.removeEventListener('error', onError);

    return {
      observedErrors,
      rejection,
      navigationMode: viewer.getNavigationMode(),
      stateDimension: state.getViewDimensionLevel('live'),
      viewerDimension: viewer.getViewDimension('live'),
    };
  });

  expect(result).toEqual({
    observedErrors: ['synthetic navigation observer failure'],
    rejection: null,
    navigationMode: 'planar',
    stateDimension: 2,
    viewerDimension: 2,
  });
});

test('Orbit and Planar targets follow the sidebar-aware visual center', async ({
  page,
}) => {
  const productErrors = observeProductErrors(page);
  await installSynthetic3dFixture(page);

  await page.goto(
    `/?exportsBaseUrl=${encodeURIComponent(SYNTHETIC_3D_ROOT)}` +
      `&dataset=${DATASET_ID}&acceptance=sidebar-aware-camera-center`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Deterministic 3-D orbit fixture',
  );

  const initial = await waitForTargetVisualCenter(page, 280);
  expect(initial.navigationMode).toBe('orbit');

  const resizeHandle = page.locator('#sidebar-resize-handle');
  const handleBox = await resizeHandle.boundingBox();
  expect(handleBox).not.toBeNull();
  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 + 80, handleBox.y + 20);
  await page.mouse.up();

  const resized = await waitForTargetVisualCenter(page);
  expect(resized.sidebarWidth).toBeGreaterThan(initial.sidebarWidth);
  expect(resized.camera).toEqual(initial.camera);

  await page.locator('#sidebar-toggle').click();
  await expect(page.locator('#sidebar')).toHaveClass(/hidden/);
  const collapsed = await waitForTargetVisualCenter(page);
  expect(collapsed.camera).toEqual(initial.camera);

  await page.locator('#sidebar-toggle').click();
  await expect(page.locator('#sidebar')).not.toHaveClass(/hidden/);
  await page.selectOption('#navigation-mode', 'planar');
  await expect(page.locator('#navigation-mode')).toHaveValue('planar');
  const planar = await waitForTargetVisualCenter(page);
  expect(planar.navigationMode).toBe('planar');

  await page.mouse.move(planar.expectedX, planar.expectedY);
  const beforeZoom = planar.camera;
  await page.mouse.wheel(0, -80);
  await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  const afterZoom = await readTargetVisualCenter(page);
  expect(afterZoom.camera.orbit.radius).toBeLessThan(
    beforeZoom.orbit.radius,
  );
  expect(afterZoom.camera.orbit.target).toEqual(beforeZoom.orbit.target);

  await page.locator('#sidebar-toggle').click();
  await expect(page.locator('#sidebar')).toHaveClass(/hidden/);
  const collapsedPlanar = await waitForTargetVisualCenter(page);
  expect(collapsedPlanar.camera).toEqual(afterZoom.camera);
  await page.locator('#sidebar-toggle').click();
  await expect(page.locator('#sidebar')).not.toHaveClass(/hidden/);

  const singlePick = await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const canvas = document.getElementById('glcanvas');
    const sidebar = document.getElementById('sidebar');
    const canvasRect = canvas.getBoundingClientRect();
    const sidebarRight = sidebar.offsetLeft + sidebar.offsetWidth;
    const visualCenterX =
      (Math.max(canvasRect.left, sidebarRight) + canvasRect.right) / 2;
    const centerY = (canvasRect.top + canvasRect.bottom) / 2;
    return viewer.pickCellAtScreen(visualCenterX, centerY);
  });
  expect(singlePick).toBeGreaterThanOrEqual(0);

  const snapshotId = await keepCurrentViewThroughUi(page);
  const snapshotPosition = await page.evaluate(({ id, cellIndex }) => {
    const viewer = window._cellucidViewer;
    const snapshotPositions = viewer.getPositions();
    const offset = cellIndex * 3;
    snapshotPositions[offset] += 0.005;
    snapshotPositions[offset + 1] += 0.004;
    snapshotPositions[offset + 2] += 0.003;
    viewer.setViewPositions(
      id,
      snapshotPositions,
      viewer.getViewDimension(id),
    );
    return {
      x: snapshotPositions[offset],
      y: snapshotPositions[offset + 1],
      z: snapshotPositions[offset + 2],
    };
  }, { id: snapshotId, cellIndex: singlePick });
  const interactionProof = await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const canvas = document.getElementById('glcanvas');
    const sidebar = document.getElementById('sidebar');
    const canvasRect = canvas.getBoundingClientRect();
    const sidebarRight = sidebar.offsetLeft + sidebar.offsetWidth;
    const centerY = (canvasRect.top + canvasRect.bottom) / 2;
    const paneWidth = canvasRect.width / 2;
    const leftPaneRight = canvasRect.left + paneWidth;
    const rightPaneLeft = leftPaneRight;
    const leftX =
      (Math.max(canvasRect.left, sidebarRight) + leftPaneRight) / 2;
    const rightX =
      (rightPaneLeft + canvasRect.right) / 2;
    const leftRecord = viewer.pickCellRecordAtScreen(leftX, centerY);
    const rightRecord = viewer.pickCellRecordAtScreen(rightX, centerY);
    return {
      leftPick: viewer.pickCellAtScreen(leftX, centerY),
      rightPick: viewer.pickCellAtScreen(rightX, centerY),
      leftRecord,
      rightRecord,
      leftRecordFrozen: Object.isFrozen(leftRecord),
      rightRecordFrozen: Object.isFrozen(rightRecord),
      rightPositionFrozen: Object.isFrozen(rightRecord?.position),
      webglError: viewer.getGLContext().getError(),
    };
  });
  expect(interactionProof.leftPick).toBe(singlePick);
  expect(interactionProof.rightPick).toBe(singlePick);
  expect(interactionProof.leftRecord).toEqual({
    viewId: 'live',
    cellIndex: singlePick,
    position: await page.evaluate(
      cellIndex => window._cellucidViewer.getCellPosition(cellIndex, 'live'),
      singlePick,
    ),
  });
  expect(interactionProof.rightRecord).toEqual({
    viewId: snapshotId,
    cellIndex: singlePick,
    position: snapshotPosition,
  });
  expect(interactionProof.leftRecordFrozen).toBe(true);
  expect(interactionProof.rightRecordFrozen).toBe(true);
  expect(interactionProof.rightPositionFrozen).toBe(true);
  expect(interactionProof.webglError).toBe(0);

  const paneTargetRadiusProof = await page.evaluate(id => {
    const viewer = window._cellucidViewer;
    viewer.setCamerasLocked(false);
    const snapshotCamera = viewer.getViewCameraState(id);
    snapshotCamera.orbit.targetRadius = 0.001;
    viewer.setViewCameraState(id, snapshotCamera);

    const canvas = document.getElementById('glcanvas');
    const sidebar = document.getElementById('sidebar');
    const canvasRect = canvas.getBoundingClientRect();
    const sidebarRight = sidebar.offsetLeft + sidebar.offsetWidth;
    const centerY = (canvasRect.top + canvasRect.bottom) / 2;
    const paneWidth = canvasRect.width / 2;
    const leftPaneRight = canvasRect.left + paneWidth;
    const rightPaneLeft = leftPaneRight;
    const liveRecord = viewer.pickCellRecordAtScreen(
      (Math.max(canvasRect.left, sidebarRight) + leftPaneRight) / 2,
      centerY,
    );
    const snapshotRecord = viewer.pickCellRecordAtScreen(
      (rightPaneLeft + canvasRect.right) / 2,
      centerY,
    );
    return {
      liveCell: liveRecord?.cellIndex ?? -1,
      snapshotCell: snapshotRecord?.cellIndex ?? -1,
    };
  }, snapshotId);
  expect(paneTargetRadiusProof.liveCell).toBe(singlePick);
  expect(paneTargetRadiusProof.snapshotCell).toBe(-1);

  expect(productErrors).toEqual([]);
});

test('unlocked mixed-mode panes render orbit anchors only in Orbit panes', async ({
  page,
}) => {
  const productErrors = observeProductErrors(page);
  await installSynthetic3dFixture(page);

  await page.goto(
    `/?exportsBaseUrl=${encodeURIComponent(SYNTHETIC_3D_ROOT)}` +
      `&dataset=${DATASET_ID}&acceptance=per-pane-orbit-anchor`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Deterministic 3-D orbit fixture',
  );

  const snapshotId = await keepCurrentViewThroughUi(page);
  await page.locator('#camera-lock-btn').click();
  await expect(page.locator('#camera-lock-btn')).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect.poll(
    () => page.evaluate(() => window._cellucidViewer.getCamerasLocked()),
  ).toBe(false);

  await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const gl = viewer.getGLContext();
    const drawElements = gl.drawElements.bind(gl);
    window.__orbitAnchorViewportXs = [];
    gl.drawElements = (mode, count, type, offset) => {
      if (mode === gl.TRIANGLES && type === gl.UNSIGNED_SHORT) {
        window.__orbitAnchorViewportXs.push(
          gl.getParameter(gl.VIEWPORT)[0],
        );
      }
      return drawElements(mode, count, type, offset);
    };
    viewer.setShowOrbitAnchor(true);
  });

  const readAnchorPaneXs = () => page.evaluate(() => (
      [...new Set(window.__orbitAnchorViewportXs)].sort((a, b) => a - b)
  ));

  await page.evaluate(id => {
    const viewer = window._cellucidViewer;
    viewer.setViewNavigationMode('live', 'orbit');
    viewer.setViewNavigationMode(id, 'planar');
    window.__orbitAnchorViewportXs.length = 0;
    viewer.setShowOrbitAnchor(false);
    viewer.setShowOrbitAnchor(true);
  }, snapshotId);
  await expect.poll(readAnchorPaneXs).toEqual([0]);
  const orbitFocusedPaneXs = await readAnchorPaneXs();
  expect(orbitFocusedPaneXs).toEqual([0]);

  await page.evaluate(id => {
    const viewer = window._cellucidViewer;
    viewer.setViewNavigationMode('live', 'planar');
    viewer.setViewNavigationMode(id, 'orbit');
    window.__orbitAnchorViewportXs.length = 0;
    viewer.setShowOrbitAnchor(false);
    viewer.setShowOrbitAnchor(true);
  }, snapshotId);
  await expect.poll(async () => {
    const paneXs = await readAnchorPaneXs();
    return paneXs.length === 1 && paneXs[0] > 0;
  }).toBe(true);
  const orbitSnapshotPaneXs = await readAnchorPaneXs();
  expect(orbitSnapshotPaneXs).toHaveLength(1);
  expect(orbitSnapshotPaneXs[0]).toBeGreaterThan(0);

  const webglError = await page.evaluate(
    () => window._cellucidViewer.getGLContext().getError(),
  );
  expect(webglError).toBe(0);
  expect(productErrors).toEqual([]);
});

test('responsive sidebar CSS remains live and republishes the target center', async ({
  page,
}) => {
  const productErrors = observeProductErrors(page);
  await page.setViewportSize({ width: 800, height: 720 });
  await installSynthetic3dFixture(page);

  await page.goto(
    `/?exportsBaseUrl=${encodeURIComponent(SYNTHETIC_3D_ROOT)}` +
      `&dataset=${DATASET_ID}&acceptance=responsive-sidebar-camera-center`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Deterministic 3-D orbit fixture',
  );

  const compact = await waitForTargetVisualCenter(page, 260);
  const resizeHandle = page.locator('#sidebar-resize-handle');
  await expect(resizeHandle).toBeHidden();
  const hiddenDragResult = await page.evaluate(() => {
    const handle = document.getElementById('sidebar-resize-handle');
    const root = document.documentElement;
    handle.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      button: 0,
      clientX: 260,
    }));
    document.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      clientX: 600,
    }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return root.style.getPropertyValue('--sidebar-user-width');
  });
  expect(hiddenDragResult).toBe('');

  await page.setViewportSize({ width: 1000, height: 720 });
  const wide = await waitForTargetVisualCenter(page, 280);
  expect(wide.camera).toEqual(compact.camera);

  await expect(resizeHandle).toBeVisible();
  const handleBox = await resizeHandle.boundingBox();
  expect(handleBox).not.toBeNull();
  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 + 120, handleBox.y + 20);
  await page.mouse.up();
  const userSizedWide = await waitForTargetVisualCenter(page, 400);
  expect(userSizedWide.camera).toEqual(compact.camera);

  await page.setViewportSize({ width: 800, height: 720 });
  const compactAgain = await waitForTargetVisualCenter(page, 260);
  expect(compactAgain.camera).toEqual(compact.camera);

  await page.setViewportSize({ width: 700, height: 720 });
  await expect.poll(async () => (
    await readTargetVisualCenter(page)
  ).sidebarWidth).toBe(700);
  const mobile = await readTargetVisualCenter(page);
  expect(mobile.camera).toEqual(compact.camera);
  await page.setViewportSize({ width: 1000, height: 720 });
  const userSizedWideAgain = await waitForTargetVisualCenter(page, 400);
  expect(userSizedWideAgain.camera).toEqual(compact.camera);

  const resumedHandleBox = await resizeHandle.boundingBox();
  expect(resumedHandleBox).not.toBeNull();
  await page.mouse.move(
    resumedHandleBox.x + resumedHandleBox.width / 2,
    resumedHandleBox.y + resumedHandleBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    resumedHandleBox.x + resumedHandleBox.width / 2 + 20,
    resumedHandleBox.y + 20,
  );
  await expect.poll(() => page.evaluate(
    () => document.documentElement.style.getPropertyValue('--sidebar-user-width'),
  )).toBe('420px');
  await page.setViewportSize({ width: 800, height: 720 });
  await expect(resizeHandle).toBeHidden();
  await expect.poll(() => page.evaluate(() => ({
    resizing: document.getElementById('sidebar').classList.contains('resizing'),
    cursor: document.body.style.cursor,
    userSelect: document.body.style.userSelect,
    userWidth: document.documentElement.style.getPropertyValue(
      '--sidebar-user-width',
    ),
  }))).toEqual({
    resizing: false,
    cursor: '',
    userSelect: '',
    userWidth: '420px',
  });
  await page.mouse.move(700, 200);
  await page.mouse.up();
  expect(await page.evaluate(
    () => document.documentElement.style.getPropertyValue('--sidebar-user-width'),
  )).toBe('420px');
  await page.setViewportSize({ width: 1000, height: 720 });
  const finalWide = await waitForTargetVisualCenter(page, 420);
  expect(finalWide.camera).toEqual(compact.camera);
  expect(productErrors).toEqual([]);
});

test('sidebar drag coalesces camera geometry without synchronous layout reads', async ({
  page,
}) => {
  const productErrors = observeProductErrors(page);
  await page.addInitScript(() => {
    const getBoundingClientRect = Element.prototype.getBoundingClientRect;
    window.__cellucidCanvasRectReads = 0;
    Element.prototype.getBoundingClientRect = function (...args) {
      if (this.id === 'glcanvas') {
        window.__cellucidCanvasRectReads += 1;
      }
      return getBoundingClientRect.apply(this, args);
    };
  });
  await installSynthetic3dFixture(page);
  await page.goto(
    `/?exportsBaseUrl=${encodeURIComponent(SYNTHETIC_3D_ROOT)}` +
      `&dataset=${DATASET_ID}&acceptance=sidebar-resize-performance`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Deterministic 3-D orbit fixture',
  );

  const burst = await page.evaluate(() => {
    const sidebar = document.getElementById('sidebar');
    const handle = document.getElementById('sidebar-resize-handle');
    const startX = sidebar.offsetLeft + sidebar.offsetWidth;
    window.__cellucidCanvasRectReads = 0;
    handle.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      button: 0,
      clientX: startX,
    }));
    for (let delta = 1; delta <= 120; delta += 1) {
      document.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true,
        clientX: startX + delta,
      }));
    }
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return {
      readsDuringBurst: window.__cellucidCanvasRectReads,
      userWidth: document.documentElement.style.getPropertyValue(
        '--sidebar-user-width',
      ),
    };
  });
  expect(burst).toEqual({
    readsDuringBurst: 0,
    userWidth: '400px',
  });
  const readsAfterSettlement = await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve(window.__cellucidCanvasRectReads));
    });
  }));
  expect(readsAfterSettlement).toBeGreaterThanOrEqual(1);
  expect(readsAfterSettlement).toBeLessThanOrEqual(2);

  await waitForTargetVisualCenter(page, 400);
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
  await dismissWelcome(page);
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
      ['setViewportLeftOcclusionRatio', [-0.1]],
      ['setViewportLeftOcclusionRatio', [1.1]],
      ['setViewportLeftOcclusionRatio', ['0.2']],
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
  await dismissWelcome(page);
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
  await dismissWelcome(page);
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
