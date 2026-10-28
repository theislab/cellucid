import { expect, test } from './helpers/test.mjs';
import { serveSyntheticCatalog } from './helpers/anndata-zarr-zip.mjs';
import { appUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { drawBands, lodLadder } from '../../assets/js/rendering/high-perf/draw-order.js';
import { formatCountOf } from '../../assets/js/utils/format-units.js';

const SYNTHETIC_3D_ROOT = appUrl('/tests/browser/fixtures/generated-3d/');
const DATASET_ID = 'deterministic-orbit-3d';
const CELL_COUNT = 12;

function createDeterministic3dPositions() {
  const positions = new Float32Array(CELL_COUNT * 3);
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
      positions[(index * 3) + axis] = point[axis];
    }
  }
  return positions;
}

function createDeterministic2dPositions() {
  const positions3d = createDeterministic3dPositions();
  const positions2d = new Float32Array(CELL_COUNT * 2);
  for (let index = 0; index < CELL_COUNT; index++) {
    for (let axis = 0; axis < 2; axis++) {
      positions2d[(index * 2) + axis] = positions3d[(index * 3) + axis];
    }
  }
  return positions2d;
}

const positions2d = createDeterministic2dPositions();
const positions3d = createDeterministic3dPositions();

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
  await serveSyntheticCatalog(page, SYNTHETIC_3D_ROOT, {
    id: DATASET_ID,
    name: 'Deterministic 3-D orbit fixture',
    description: 'Exact synthetic browser fixture for fresh 3-D camera ownership',
    cells: CELL_COUNT,
    obsm: {
      X_umap_2d: { data: positions2d, columns: 2 },
      X_umap_3d: { data: positions3d, columns: 3 },
    },
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
    `/?sampleCatalog=${encodeURIComponent(SYNTHETIC_3D_ROOT)}` +
      `&dataset=${DATASET_ID}&acceptance=fresh-3d-orbit-ci`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await openCollapsedPanels(page);

  await expect(page.locator('#dataset-name')).toHaveText(
    'Deterministic 3-D orbit fixture',
  );
  await expect(page.locator('#dataset-cells')).toHaveText(String(CELL_COUNT));
  await expect(page.locator('#dataset-genes')).toHaveText('0');
  await expect(page.locator('#filter-count')).toHaveText(
    `Showing all ${CELL_COUNT} cells`,
  );
  await expect(page.locator('#view-representation-select option:checked'))
    .toHaveText(/ · 3D$/);
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
    `/?sampleCatalog=${encodeURIComponent(SYNTHETIC_3D_ROOT)}` +
      `&dataset=${DATASET_ID}&acceptance=snapshot-dimension-generation`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Deterministic 3-D orbit fixture',
  );

  const snapshotId = await keepCurrentViewThroughUi(page);
  const result = await page.evaluate(async (viewId) => {
    const state = window._cellucidState;
    const viewer = window._cellucidViewer;
    const publish = async dimensionLevel => {
      await state.showDefaultRepresentation(viewId, dimensionLevel);
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

test('UI teardown fences an in-flight representation switch from the picker', async ({
  page,
}) => {
  const productErrors = observeProductErrors(page);
  await installSynthetic3dFixture(page);

  await page.goto(
    `/?sampleCatalog=${encodeURIComponent(SYNTHETIC_3D_ROOT)}` +
      `&dataset=${DATASET_ID}&acceptance=representation-picker-terminal-owner`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Deterministic 3-D orbit fixture',
  );
  await keepCurrentViewThroughUi(page);

  const result = await page.evaluate(async () => {
    const state = window._cellucidState;
    const viewer = window._cellucidViewer;
    const ui = window._cellucidUi;
    const originalSetViewRepresentation =
      state.setViewRepresentation.bind(state);
    let releaseSwitch;
    let markStarted;
    const started = new Promise(resolve => {
      markStarted = resolve;
    });
    const release = new Promise(resolve => {
      releaseSwitch = resolve;
    });
    let switched = null;
    state.setViewRepresentation = async (...args) => {
      markStarted();
      await release;
      switched = originalSetViewRepresentation(...args);
      return switched;
    };

    // The selected kept view is switched to the 2D representation.
    const picker = document.getElementById('view-representation-select');
    const twoDimensional = picker.querySelector('optgroup[label="2D"] option');
    if (!(twoDimensional instanceof HTMLOptionElement)) {
      throw new Error('Representation terminal regression requires a 2D option.');
    }
    picker.value = twoDimensional.value;
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await started;
    const disabledWhileSwitching = picker.disabled;
    const destroying = ui.destroy();
    await destroying;
    const badgeCountAtFence = document.querySelectorAll(
      '#split-view-badges-list .split-badge',
    ).length;

    releaseSwitch();
    // The switch loads the 2D positions, so it is awaited rather than given
    // a fixed 50 ms: on hosted runners it had not finished by then. A
    // switch that fails shows up below as the dimension it left behind.
    while (switched === null) await new Promise(resolve => setTimeout(resolve, 0));
    await switched.catch(() => {});
    const outcome = {
      badgeCountAfterSwitch: document.querySelectorAll(
        '#split-view-badges-list .split-badge',
      ).length,
      badgeCountAtFence,
      disabledWhileSwitching,
      switchNotices: [...document.querySelectorAll('#notification-center .notification')]
        .filter(notice => /switch/i.test(notice.textContent)).length,
      snapshotDimension: viewer.getViewDimension('snap_1'),
    };
    viewer.dispose();
    return outcome;
  });

  // The switch itself completes in the state it began in; the retired
  // interface publishes nothing for it.
  expect(result).toEqual({
    badgeCountAfterSwitch: 0,
    badgeCountAtFence: 0,
    disabledWhileSwitching: true,
    switchNotices: 0,
    snapshotDimension: 2,
  });
  expect(productErrors).toEqual([]);
});

test('a navigation observer failure cannot enter dimension rollback', async ({
  page,
}) => {
  await installSynthetic3dFixture(page);

  await page.goto(
    `/?sampleCatalog=${encodeURIComponent(SYNTHETIC_3D_ROOT)}` +
      `&dataset=${DATASET_ID}&acceptance=dimension-observer-boundary`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await openCollapsedPanels(page);
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
      await state.showDefaultRepresentation('live', 2);
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
    `/?sampleCatalog=${encodeURIComponent(SYNTHETIC_3D_ROOT)}` +
      `&dataset=${DATASET_ID}&acceptance=sidebar-aware-camera-center`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await openCollapsedPanels(page);
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
    // Both grid cells lie in the canvas area right of the sidebar, each
    // half of it wide; a camera target sits at the centre of its cell.
    const paneWidth = (canvasRect.right - Math.max(canvasRect.left, sidebarRight)) / 2;
    const leftPaneLeft = Math.max(canvasRect.left, sidebarRight);
    const leftX = leftPaneLeft + paneWidth / 2;
    const rightX = leftPaneLeft + paneWidth * 1.5;
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

  expect(productErrors).toEqual([]);
});

test('coarse LOD picking follows the rendered live and snapshot prefixes', async ({
  page,
}) => {
  const productErrors = observeProductErrors(page);
  await installSynthetic3dFixture(page);

  await page.goto(
    `/?sampleCatalog=${encodeURIComponent(SYNTHETIC_3D_ROOT)}` +
      `&dataset=${DATASET_ID}&acceptance=coarse-lod-picking-prefix`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Deterministic 3-D orbit fixture',
  );

  const proof = await page.evaluate(async () => {
    const { createInMemoryDimensionManager } = await import(
      '/assets/js/data/dimension-manager.js'
    );
    const { buildPriorityOrder, DEFAULT_CELL_PRIORITY } = await import(
      '/assets/js/data/cell-priority.js'
    );
    const { lodLadder } = await import(
      '/assets/js/rendering/high-perf/draw-order.js'
    );
    const pointCount = 24_000;
    const positions = new Float32Array(pointCount * 3);
    const colors = new Uint8Array(pointCount * 4);

    // Both candidates lie on the exact planar-camera ray. The closer one is
    // almost one world unit nearer, but its priority rank (the scene's cells
    // are ranked under the default seed) is the first past the coarsest
    // level; the farther one is the first cell of that level.
    const order = buildPriorityOrder(pointCount, DEFAULT_CELL_PRIORITY);
    const coarsestCount = lodLadder(pointCount)[0];
    const closer = order[coarsestCount];
    const farther = order[0];
    for (let cellIndex = 0; cellIndex < pointCount; cellIndex++) {
      const angle =
        (cellIndex * 2.399963229728653) % (Math.PI * 2);
      const positionOffset = cellIndex * 3;
      positions[positionOffset] = Math.cos(angle);
      positions[positionOffset + 1] = Math.sin(angle);
      positions[positionOffset + 2] =
        (cellIndex & 1) === 0 ? 1 : -1;
    }
    positions.set([-0.994, -0.994, 0], closer * 3);
    positions.set([-0.994, -0.994, -0.994], farther * 3);
    for (let cellIndex = 0; cellIndex < pointCount; cellIndex++) {
      const colorOffset = cellIndex * 4;
      colors[colorOffset] = 48;
      colors[colorOffset + 1] = 144;
      colors[colorOffset + 2] = 240;
      colors[colorOffset + 3] = 255;
    }

    const state = window._cellucidState;
    const viewer = window._cellucidViewer;
    const ui = window._cellucidUi;
    state.initSyntheticScene({
      colors,
      dimensionLevel: 3,
      dimensionManager: createInMemoryDimensionManager({
        positions,
        dimension: 3,
      }),
      positions,
    });
    viewer.setCamerasLocked(true);
    viewer.setFrustumCulling(false);
    viewer.setAdaptiveLOD(false);
    viewer.setForceLOD(-1);
    viewer.setCameraState({
      navigationMode: 'planar',
      orbit: {
        radius: 3,
        targetRadius: 3,
        theta: Math.PI / 4,
        phi: Math.PI / 4,
        target: [-0.994, -0.994, -0.994],
      },
      freefly: {
        position: [-0.994, -0.994, 2.006],
        yaw: -Math.PI / 2,
        pitch: 0,
      },
    });

    const waitForFrames = () => new Promise(resolve => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(resolve);
        });
      });
    });
    const getPaneCenters = () => {
      const canvas = document.getElementById('glcanvas');
      const sidebar = document.getElementById('sidebar');
      const canvasRect = canvas.getBoundingClientRect();
      const sidebarRight = sidebar.offsetLeft + sidebar.offsetWidth;
      const centerY = (canvasRect.top + canvasRect.bottom) / 2;
      // Single view and grid share the presented area right of the sidebar;
      // the grid splits it into two equal cells.
      const presentedLeft = Math.max(canvasRect.left, sidebarRight);
      const paneBoundary = (presentedLeft + canvasRect.right) / 2;
      return {
        centerY,
        liveX: (presentedLeft + paneBoundary) / 2,
        singleX: (presentedLeft + canvasRect.right) / 2,
        snapshotX: (paneBoundary + canvasRect.right) / 2,
      };
    };

    await waitForFrames();
    const singlePane = getPaneCenters();
    const fullDetailRecord = viewer.pickCellRecordAtScreen(
      singlePane.singleX,
      singlePane.centerY,
    );

    const payload = state.getSnapshotPayload();
    const snapshot = ui.publishSnapshotView({
      label: 'Coarse LOD picking snapshot',
      fieldKey: payload.fieldKey,
      fieldKind: payload.fieldKind,
      colors: payload.colors,
      transparency: payload.transparency,
      centroidPositions: payload.centroidPositions,
      centroidColors: payload.centroidColors,
      dimensionLevel: payload.dimensionLevel,
      sourceViewId: 'live',
      meta: { filtersText: payload.filtersText },
      cameraState: viewer.getCameraState(),
    });
    viewer.setViewLayout('grid', snapshot.id);
    viewer.setAdaptiveLOD(true);
    viewer.setForceLOD(0);
    // The levels are built off the main thread; draw until both panes have them.
    for (let frame = 0; frame < 600; frame++) {
      if (viewer.getCurrentLODLevel('live') >= 0 && viewer.getCurrentLODLevel(snapshot.id) >= 0) break;
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    await waitForFrames();

    const liveMembership = viewer.getCurrentLodMembership('live', 3);
    const snapshotMembership = viewer.getCurrentLodMembership(
      snapshot.id,
      3,
    );
    const paneCenters = getPaneCenters();
    const liveRecord = viewer.pickCellRecordAtScreen(
      paneCenters.liveX,
      paneCenters.centerY,
    );
    const snapshotRecord = viewer.pickCellRecordAtScreen(
      paneCenters.snapshotX,
      paneCenters.centerY,
    );
    const summarizeMembership = membership => ({
      closerAdmission: membership.admissionLevels[closer],
      fartherAdmission: membership.admissionLevels[farther],
      dimensionLevel: membership.dimensionLevel,
      indexCount: membership.indices.length,
      includesCloser: membership.indices.includes(closer),
      includesFarther: membership.indices.includes(farther),
      lodLevel: membership.lodLevel,
      pointCount: membership.pointCount,
      frozen: Object.isFrozen(membership),
    });
    const summarizeStats = viewId => {
      const stats = viewer.getRendererStats(viewId);
      return {
        lodLevel: stats.lodLevel,
        visiblePoints: stats.visiblePoints,
      };
    };

    return {
      closer,
      farther,
      coarsestCount,
      fullDetail: {
        cellIndex: fullDetailRecord?.cellIndex ?? -1,
        viewId: fullDetailRecord?.viewId ?? null,
      },
      live: {
        cellIndex: liveRecord?.cellIndex ?? -1,
        currentLodLevel: viewer.getCurrentLODLevel('live'),
        membership: summarizeMembership(liveMembership),
        stats: summarizeStats('live'),
        viewId: liveRecord?.viewId ?? null,
      },
      snapshot: {
        cellIndex: snapshotRecord?.cellIndex ?? -1,
        currentLodLevel: viewer.getCurrentLODLevel(snapshot.id),
        membership: summarizeMembership(snapshotMembership),
        stats: summarizeStats(snapshot.id),
        viewId: snapshotRecord?.viewId ?? null,
      },
      snapshotId: snapshot.id,
      webglError: viewer.getGLContext().getError(),
    };
  });

  expect(proof.closer).not.toBe(proof.farther);
  expect(proof.fullDetail).toEqual({
    cellIndex: proof.closer,
    viewId: 'live',
  });
  for (const renderedView of [proof.live, proof.snapshot]) {
    expect(renderedView.cellIndex).toBe(proof.farther);
    expect(renderedView.currentLodLevel).toBe(0);
    expect(renderedView.membership).toMatchObject({
      dimensionLevel: 3,
      indexCount: proof.coarsestCount,
      includesCloser: false,
      includesFarther: true,
      lodLevel: 0,
      pointCount: 24_000,
      frozen: true,
    });
    expect(renderedView.membership.closerAdmission).toBeGreaterThan(0);
    expect(renderedView.membership.fartherAdmission).toBe(0);
    expect(renderedView.stats).toEqual({
      lodLevel: 0,
      visiblePoints: proof.coarsestCount,
    });
  }
  expect(proof.live.viewId).toBe('live');
  expect(proof.snapshot.viewId).toBe(proof.snapshotId);
  expect(proof.webglError).toBe(0);
  expect(productErrors).toEqual([]);
});

test('unlocked mixed-mode panes render orbit anchors only in Orbit panes', async ({
  page,
}) => {
  const productErrors = observeProductErrors(page);
  await installSynthetic3dFixture(page);

  await page.goto(
    `/?sampleCatalog=${encodeURIComponent(SYNTHETIC_3D_ROOT)}` +
      `&dataset=${DATASET_ID}&acceptance=per-pane-orbit-anchor`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await openCollapsedPanels(page);
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
  // Grid cells are laid out right of the sidebar; each anchor is drawn in its
  // own pane's framebuffer viewport.
  const [livePaneX, snapshotPaneX] = await page.evaluate(() => (
    window._cellucidViewer.getPresentedLayout().panes.map(pane => pane.viewportX)
  ));
  expect(livePaneX).toBeGreaterThan(0);
  expect(snapshotPaneX).toBeGreaterThan(livePaneX);
  await expect.poll(readAnchorPaneXs).toEqual([livePaneX]);
  const orbitFocusedPaneXs = await readAnchorPaneXs();
  expect(orbitFocusedPaneXs).toEqual([livePaneX]);

  await page.evaluate(id => {
    const viewer = window._cellucidViewer;
    viewer.setViewNavigationMode('live', 'planar');
    viewer.setViewNavigationMode(id, 'orbit');
    window.__orbitAnchorViewportXs.length = 0;
    viewer.setShowOrbitAnchor(false);
    viewer.setShowOrbitAnchor(true);
  }, snapshotId);
  await expect.poll(readAnchorPaneXs).toEqual([snapshotPaneX]);

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
    `/?sampleCatalog=${encodeURIComponent(SYNTHETIC_3D_ROOT)}` +
      `&dataset=${DATASET_ID}&acceptance=responsive-sidebar-camera-center`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await openCollapsedPanels(page);
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
    `/?sampleCatalog=${encodeURIComponent(SYNTHETIC_3D_ROOT)}` +
      `&dataset=${DATASET_ID}&acceptance=sidebar-resize-performance`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await openCollapsedPanels(page);
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
    `/?sampleCatalog=${encodeURIComponent(SYNTHETIC_3D_ROOT)}` +
      `&dataset=${DATASET_ID}&acceptance=viewer-public-control-contract`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await openCollapsedPanels(page);
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
      edgeTarget: viewer.getEdgeSelectionStatsForView('live')?.shownCount ?? null,
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
      ['setEdgeVisibleTarget', [-1]],
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
        ['velocity', '3d', {
          vectors: new Float32Array([0, 0, Number.NaN]),
          components: 3,
          cellCount: 1,
          maxMagnitude: 1,
        }],
      ],
      ['hasVectorFieldForLayout', ['', '3d']],
      ['hasVectorFieldForLayout', ['velocity', '']],
      ['setViewEmbedding', ['live', { dimension: 3 }]],
      ['setViewEmbedding', ['live', { dimension: 3, layoutKey: '' }]],
      ['setAdaptiveLOD', [1]],
      ['setFrustumCulling', [1]],
      ['setForceLOD', [1.5]],
      ['setViewLayout', ['garbage', 'live']],
      ['setViewLayout', ['grid', 'ghost']],
      ['setEdgeVisibleTarget', ['4.9']],
      ['setViewFieldKindSource', ['categorical']],
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
        [new Uint8Array(liveTransparency.length - 1)],
      ],
      [
        'updateTransparency',
        [Uint8Array.from(liveTransparency, (value, index) =>
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
      edgeTarget: viewer.getEdgeSelectionStatsForView('live')?.shownCount ?? null,
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
        viewer.clearViewDimensionState === undefined &&
        viewer.setEdgeLodLimit === undefined &&
        viewer.setEdgeDebugMode === undefined,
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
    `/?sampleCatalog=${encodeURIComponent(SYNTHETIC_3D_ROOT)}` +
      `&dataset=${DATASET_ID}&acceptance=renderer-data-transaction`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await openCollapsedPanels(page);
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
    // A 2D publication: two position components per point.
    const replacement = {
      positions: new Float32Array(replacementCount * 2),
      colors: new Uint8Array(replacementCount * 4).fill(127),
      transparency: new Uint8Array(replacementCount).fill(1),
      dimensionLevel: 2,
      layoutKey: '2d',
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
    `/?sampleCatalog=${encodeURIComponent(SYNTHETIC_3D_ROOT)}` +
      `&dataset=${DATASET_ID}&acceptance=renderer-lod-transaction`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Deterministic 3-D orbit fixture',
  );

  const result = await page.evaluate(async () => {
    const viewer = window._cellucidViewer;
    viewer.setAdaptiveLOD(true);
    // The tree with its levels is built off the main thread.
    for (let frame = 0; frame < 600; frame++) {
      if (viewer.debugRendererStatus().lodLevelCount > 0) break;
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    const status = viewer.debugRendererStatus();
    return {
      pointCount: status.pointCount,
      dimension: status.currentDimensionLevel,
      useAdaptiveLOD: status.useAdaptiveLOD,
      spatialIndicesCount: status.spatialIndicesCount,
      lodLevelCount: status.lodLevelCount,
      drawOrder: status.drawOrder,
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
  // LOD keeps no GPU copy: its levels are prefixes of the one stored order,
  // the renderer's ladder for this many cells (twelve cells are below its
  // first rung, so their one level is every cell).
  expect(result.lodLevelCount).toBe(lodLadder(CELL_COUNT).length);
  // The live store holds the tree's whole order, in its fixed bands.
  expect(result.drawOrder.split(', ')[0]).toBe(formatCountOf(drawBands(CELL_COUNT).bandEnds.length, 'band'));
  expect(productErrors).toEqual([]);
});
