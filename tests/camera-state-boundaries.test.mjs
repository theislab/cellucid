import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const {
  assertCameraState,
  assertNavigationMode,
  cameraStatesHaveSamePose,
  isExactCameraState
} = await import('../assets/js/rendering/camera-state-contract.js');
const {
  interpolateCameraState,
  resolvePathTiming
} = await import('../assets/js/app/ui/modules/cinematic-camera/interpolation-engine.js');
const { createCameraDomain } = await import('../assets/js/app/state/domains/camera.js');
const { createViewsDomain } = await import('../assets/js/app/state/domains/views.js');

const scopedSources = await Promise.all([
  '../assets/js/app/state/domains/camera.js',
  '../assets/js/app/state/domains/views.js',
  '../assets/js/app/ui/modules/camera-controls.js',
  '../assets/js/app/ui/modules/view-controls.js',
  '../assets/js/app/ui/modules/cinematic-camera/index.js',
  '../assets/js/app/ui/modules/cinematic-camera/interpolation-engine.js',
  '../assets/js/app/ui/modules/cinematic-camera/keyframe-store.js',
  '../assets/js/app/ui/modules/figure-export/figure-export-engine.js',
  '../assets/js/app/ui/modules/figure-export/figure-export-ui.js',
  '../assets/js/app/ui/modules/figure-export/components/orientation-indicator.js',
  '../assets/js/app/ui/modules/figure-export/renderers/png-renderer.js',
  '../assets/js/app/ui/modules/figure-export/renderers/svg-renderer.js',
  '../assets/js/rendering/viewer.js'
].map(async (relativePath) => ({
  relativePath,
  source: await readFile(new URL(relativePath, import.meta.url), 'utf8')
})));
const filtersDomainSource = await readFile(
  new URL('../assets/js/app/state/domains/filters.js', import.meta.url),
  'utf8'
);
const colorsDomainSource = await readFile(
  new URL('../assets/js/app/state/domains/colors.js', import.meta.url),
  'utf8'
);

function cameraState(navigationMode = 'orbit') {
  return {
    navigationMode,
    orbit: {
      radius: 3,
      targetRadius: 3,
      theta: 0.5,
      phi: 1,
      target: [0, 0, 0]
    },
    freefly: {
      position: [1, 2, 3],
      yaw: 0.25,
      pitch: -0.1
    }
  };
}

test('the camera and views domains hold each view\'s camera and representation as the viewer reports them', () => {
  const currentCamera = cameraState();
  currentCamera.orbit.radius = 2.43;
  currentCamera.orbit.targetRadius = 2.43;
  // The live view shows a 3D representation: columns 0, 2, 1 of an AnnData
  // obsm array, named by provenance.
  const provenance = Object.freeze({
    key: 'X_pca',
    columns: Object.freeze([0, 2, 1])
  });
  const set = [];
  const viewer = {
    getSnapshotViews() {
      return [];
    },
    getLiveViewHidden() {
      return false;
    },
    getFocusedViewId() {
      return 'live';
    },
    setViewCameraState(viewId) {
      set.push(['setViewCameraState', viewId]);
    },
    setNavigationMode(mode) {
      set.push(['setNavigationMode', mode]);
    },
    setCameraState() {
      set.push(['setCameraState']);
    },
    getViewLayout() {
      return { mode: 'grid', activeId: 'live', liveViewHidden: false };
    },
    getCamerasLocked() {
      return true;
    },
    // The focused live view follows the current camera; the viewer, not the
    // domain, decides which views do.
    getViewCameraState(viewId) {
      assert.equal(viewId, 'live');
      return currentCamera;
    },
    getCentroidFlags(viewId) {
      assert.equal(viewId, 'live');
      return { points: true, labels: false };
    },
    getViewName(viewId) {
      assert.equal(viewId, 'live');
      return null;
    }
  };
  const state = {
    viewContexts: new Map(),
    getActiveViewId() {
      return 'live';
    },
    getViewLayoutKey(viewId) {
      assert.equal(viewId, 'live');
      return 'X_pca_3d';
    },
    dimensionManager: {
      viewLayouts: new Map([['live', 'X_pca_3d']]),
      getLayout(layoutKey) {
        assert.equal(layoutKey, 'X_pca_3d');
        return { layoutKey, dimension: 3, provenance };
      }
    }
  };

  // Each view's camera is held once, by the camera domain, as a copy of
  // what the viewer reports.
  const cameras = createCameraDomain({ viewer, refreshUi() {} }).capture();
  assert.deepEqual(cameras, { views: [currentCamera] });
  assert.notStrictEqual(cameras.views[0], currentCamera);
  assert.throws(
    () => createCameraDomain({ viewer, refreshUi() {} }).restore({
      views: [{ ...currentCamera, freefly: { ...currentCamera.freefly, position: [1, 2] } }]
    }),
    /Camera to restore for View 1 must contain an exact navigationMode plus complete orbit and freefly state/
  );
  assert.deepEqual(set, [], 'an incomplete camera is refused before it is set');

  // The live view's geometry is one embedding reference, captured as a plain
  // JSON copy; its dimension is the reference's and is not stored, and the
  // views value holds no camera.
  const views = createViewsDomain({ state, viewer, refreshUi() {} }).capture();
  assert.deepEqual(views, {
    layout: 'grid',
    focus: 0,
    liveHidden: false,
    camerasLinked: true,
    views: [{
      embedding: { key: 'X_pca', columns: [0, 2, 1] },
      followsDefault: true,
      centroids: { points: true, labels: false }
    }]
  });
  assert.notStrictEqual(views.views[0].embedding.columns, provenance.columns);
  assert.equal(Object.isFrozen(views.views[0].embedding.columns), false);
});

test('the current camera-state contract requires both synchronized representations', () => {
  for (const mode of ['orbit', 'planar', 'free']) {
    const state = cameraState(mode);
    assert.equal(assertNavigationMode(mode), mode);
    assert.equal(assertCameraState(state), state);
    assert.equal(isExactCameraState(state), true);
  }

  for (const invalid of [
    null,
    {},
    { ...cameraState(), navigationMode: undefined },
    { ...cameraState(), navigationMode: 'legacy-orbit' },
    { ...cameraState(), orbit: null },
    { ...cameraState(), freefly: null },
    {
      ...cameraState(),
      orbit: { ...cameraState().orbit, radius: Number.NaN }
    },
    {
      ...cameraState(),
      freefly: { ...cameraState().freefly, position: [1, 2] }
    }
  ]) {
    assert.equal(isExactCameraState(invalid), false);
    assert.throws(() => assertCameraState(invalid), /camera state/i);
  }
});

test('camera consumers never synthesize orbit or probe obsolete camera capabilities', () => {
  const forbidden = [
    /cameraState\?\.navigationMode\s*\|\|\s*['"]orbit['"]/,
    /navigationMode\s*\|\|\s*['"]orbit['"]/,
    /getViewCameraState\?\./,
    /getCameraState\?\./,
    /setViewCameraState\?\./,
    /setCameraState\?\./,
    /getNavigationMode\?\./,
    /setNavigationMode\?\./
  ];

  for (const { relativePath, source } of scopedSources) {
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern, `${relativePath} violates ${pattern}`);
    }
  }
});

test('viewer camera and dimension owners never repair missing state', () => {
  const viewer = scopedSources.find(({ relativePath }) =>
    relativePath.endsWith('/rendering/viewer.js')
  ).source;

  for (const pattern of [
    /getFallbackDimensionLevel/,
    /camState\.freefly\.position\s*\|\|/,
    /camState\.freefly\.(?:yaw|pitch)\s*\|\|/,
    /camState\.orbit\.(?:radius|theta|phi|target)\s*(?:\?\?|\|\|)/,
    /orb\.(?:radius|theta|phi|target)\s*(?:\?\?|\|\|)/,
    /old buffer doesn't have dimensionLevel stored/,
    /full reload if incremental update not available/i
  ]) {
    assert.doesNotMatch(viewer, pattern, `viewer violates ${pattern}`);
  }
  assert.match(
    viewer,
    /function computeViewMatrixFromState\([\s\S]*?assertCameraState\(/
  );
  assert.match(
    viewer,
    /function syncFreeflyInCameraState\([\s\S]*?assertCameraState\(/
  );
});

test('camera-path math never invents missing camera coordinates', () => {
  const cameraPathSources = scopedSources.filter(({ relativePath }) =>
    relativePath.endsWith('/interpolation-engine.js') ||
    relativePath.endsWith('/keyframe-store.js')
  );
  for (const { relativePath, source } of cameraPathSources) {
    assert.doesNotMatch(source, /orbit\?\./, relativePath);
    assert.doesNotMatch(source, /freefly\?\./, relativePath);
    assert.doesNotMatch(source, /\?\?\s*(?:0|3|Math\.PI)/, relativePath);
    assert.doesNotMatch(source, /\|\|\s*\[\s*0\s*,\s*0\s*,\s*0\s*\]/, relativePath);
  }

  const cameraPathUi = scopedSources.find(({ relativePath }) =>
    relativePath.endsWith('/cinematic-camera/index.js')
  ).source;
  assert.doesNotMatch(cameraPathUi, /positionMethod:\s*dom\.[^\n]*(?:\|\||\?\?)/);
  assert.doesNotMatch(cameraPathUi, /rotationMethod:\s*dom\.[^\n]*(?:\|\||\?\?)/);
  assert.doesNotMatch(cameraPathUi, /easing:\s*dom\.[^\n]*(?:\|\||\?\?)/);
  assert.match(cameraPathUi, /assertCameraPathState\(data\)/);
});

test('camera-path interpolation rejects incomplete state and unsupported settings', () => {
  const first = {
    id: 'first',
    label: 'First',
    ...cameraState('orbit'),
    representation: null,
    transitionDuration: 1
  };
  const second = {
    id: 'second',
    label: 'Second',
    ...cameraState('orbit'),
    orbit: {
      ...cameraState('orbit').orbit,
      radius: 5,
      targetRadius: 5,
      target: [2, 1, 0]
    },
    representation: null,
    transitionDuration: 1
  };
  const options = {
    positionMethod: 'linear',
    rotationMethod: 'linear',
    easing: 'linear',
    loop: false,
    autoPaceSpeed: 1
  };

  assert.deepEqual(resolvePathTiming([first, second], 1).transitions, [1]);
  assert.equal(
    isExactCameraState(interpolateCameraState([first, second], 0.5, options)),
    true
  );

  const missingOrbit = { ...first, orbit: null };
  assert.throws(
    () => resolvePathTiming([missingOrbit, second], 1),
    /keyframe 0/i
  );
  assert.throws(
    () => resolvePathTiming([first, second], undefined),
    /autoPaceSpeed/i
  );
  assert.throws(
    () => interpolateCameraState(
      [first, second],
      0.5,
      { ...options, positionMethod: 'legacy-linear' }
    ),
    /position method/i
  );
  assert.throws(
    () => interpolateCameraState(
      [first, second],
      0.5,
      { ...options, easing: undefined }
    ),
    /easing/i
  );
  const { loop: _loop, ...missingLoop } = options;
  assert.throws(
    () => interpolateCameraState([first, second], 0.5, missingLoop),
    /loop/i
  );
  assert.throws(
    () => interpolateCameraState(
      [first, second],
      0.5,
      { ...options, legacyPositionMethod: 'linear' }
    ),
    /exactly/i
  );
  assert.throws(
    () => interpolateCameraState([first, second], -0.01, options),
    /from 0 through 1/i
  );
  assert.throws(
    () => interpolateCameraState([first, second], 1.01, options),
    /from 0 through 1/i
  );

  const zoomRadii = [0.001, 0.001, 0.001, 0.1];
  const zoomPath = zoomRadii.map((radius, index) => ({
    id: `zoom-${index}`,
    label: `Zoom ${index}`,
    ...cameraState('orbit'),
    orbit: {
      ...cameraState('orbit').orbit,
      radius,
      targetRadius: radius,
      theta: index * 0.1
    },
    freefly: {
      ...cameraState('orbit').freefly,
      position: [radius, 0, 0]
    },
    representation: null,
    transitionDuration: 1
  }));
  const smoothZoom = interpolateCameraState(
    zoomPath,
    0.39,
    { ...options, positionMethod: 'catmull-rom' }
  );
  assert.equal(
    isExactCameraState(smoothZoom),
    true,
    'smooth zoom interpolation must preserve the positive-radius camera invariant'
  );
  assert.ok(smoothZoom.orbit.radius > 0);
  assert.ok(smoothZoom.orbit.targetRadius > 0);

  const antipodalPath = [0, Math.PI].map((theta, index) => ({
    id: `antipodal-${index}`,
    label: `Antipodal ${index}`,
    ...cameraState('orbit'),
    orbit: {
      ...cameraState('orbit').orbit,
      radius: 3,
      targetRadius: 3,
      theta,
      phi: Math.PI / 2
    },
    freefly: {
      position: [3 * Math.cos(theta), 0, 3 * Math.sin(theta)],
      yaw: index === 0 ? Math.PI : 0,
      pitch: 0
    },
    representation: null,
    transitionDuration: 1
  }));
  let previousPosition = null;
  let maximumStep = 0;
  for (let index = 0; index <= 100; index++) {
    const state = interpolateCameraState(
      antipodalPath,
      index / 100,
      { ...options, rotationMethod: 'slerp' }
    );
    if (previousPosition) {
      maximumStep = Math.max(
        maximumStep,
        Math.hypot(
          state.freefly.position[0] - previousPosition[0],
          state.freefly.position[1] - previousPosition[1],
          state.freefly.position[2] - previousPosition[2]
        )
      );
    }
    previousPosition = state.freefly.position;
  }
  assert.ok(
    maximumStep < 0.11,
    `antipodal SLERP must be continuous; maximum 1% path step was ${maximumStep}`
  );

  const planarEndpoint = {
    id: 'planar-endpoint',
    label: 'Planar endpoint',
    ...cameraState('planar'),
    orbit: {
      ...cameraState('planar').orbit,
      radius: 6,
      targetRadius: 6,
      target: [4, 2, 0]
    },
    freefly: {
      ...cameraState('planar').freefly,
      position: [4, 2, 6]
    },
    representation: null,
    transitionDuration: 1
  };
  const crossModePath = [first, planarEndpoint];
  assert.deepEqual(
    interpolateCameraState(crossModePath, 0, options),
    {
      navigationMode: first.navigationMode,
      orbit: first.orbit,
      freefly: first.freefly
    },
    'a cross-mode path must start at the exact saved camera state'
  );
  assert.deepEqual(
    interpolateCameraState(crossModePath, 1, options),
    {
      navigationMode: planarEndpoint.navigationMode,
      orbit: planarEndpoint.orbit,
      freefly: planarEndpoint.freefly
    },
    'a cross-mode path must finish at the exact saved camera state'
  );
});

test('state-domain, snapshot, and figure-export boundaries assert exact camera state', () => {
  const byPath = new Map(scopedSources.map(({ relativePath, source }) => [relativePath, source]));
  const cameraDomainSource = byPath.get('../assets/js/app/state/domains/camera.js');
  // Every view's camera, captured and restored (a history step, a session
  // load), is checked whole.
  assert.match(
    cameraDomainSource,
    /cloneCameraState\(viewer\.getViewCameraState\(id\), `Camera of view "\$\{id\}"`\)/
  );
  assert.match(
    cameraDomainSource,
    /cloneCameraState\(value\.views\[index\], `Camera to restore for \$\{viewNameInValue\(index, liveHidden\)\}`\)/
  );
  for (const [label, source] of [['filters', filtersDomainSource], ['colors', colorsDomainSource]]) {
    assert.doesNotMatch(
      source,
      /_pushOutliersToViewer|_pushOutlierThresholdToViewer/,
      `a ${label} restore must use the current visibility/transparency owner`
    );
  }
  assert.match(
    filtersDomainSource,
    /state\.endBatch\(\);\s*\}\s*state\.computeGlobalVisibility\(\);/
  );
  assert.match(
    colorsDomainSource,
    /state\.updateColorsContinuous\(active\);\s*state\._pushColorsToViewer\(\);/
  );
  assert.match(
    byPath.get('../assets/js/app/ui/modules/figure-export/figure-export-engine.js'),
    /cloneCameraState\(\s*presented\.cameraState/
  );
  assert.match(
    byPath.get('../assets/js/rendering/viewer.js'),
    /setViewCameraState\(viewId,\s*camState\)[\s\S]*?assertCameraState\(camState/
  );
});

test('camera pose equality compares the half the navigation mode drives, exactly', () => {
  const orbit = {
    navigationMode: 'orbit',
    orbit: {
      radius: 2.353322246692734,
      targetRadius: 2.353322246692734,
      theta: 0.530398163397444,
      phi: 1.4053981633974426,
      target: [0, 0, 0]
    },
    freefly: {
      position: [2.002285713714809, 0.38746291461474713, 1.1742444410048358],
      yaw: -2.611194490192349,
      // Derived by WebKit; Chromium and Firefox derive ...406.
      pitch: -0.16539816339745403
    }
  };
  const otherEngine = structuredClone(orbit);
  otherEngine.freefly.pitch = -0.16539816339745406;
  assert.equal(cameraStatesHaveSamePose(orbit, otherEngine), true);
  assert.equal(
    cameraStatesHaveSamePose(
      { ...orbit, navigationMode: 'planar' },
      { ...otherEngine, navigationMode: 'planar' }
    ),
    true
  );

  // One unit in the last place of each driven value is still a different pose.
  const nextUp = value => value * (1 + Number.EPSILON);
  for (const key of ['radius', 'targetRadius', 'theta', 'phi']) {
    const moved = structuredClone(orbit);
    moved.orbit[key] = nextUp(moved.orbit[key]);
    assert.notEqual(moved.orbit[key], orbit.orbit[key], key);
    assert.equal(cameraStatesHaveSamePose(orbit, moved), false, key);
  }
  const retargeted = structuredClone(orbit);
  retargeted.orbit.target = [0, 0, Number.EPSILON];
  assert.equal(cameraStatesHaveSamePose(orbit, retargeted), false);
  assert.equal(
    cameraStatesHaveSamePose(orbit, { ...orbit, navigationMode: 'free' }),
    false
  );

  const free = { ...structuredClone(orbit), navigationMode: 'free' };
  const freeOtherEngine = structuredClone(free);
  for (const key of ['radius', 'targetRadius', 'theta', 'phi']) {
    freeOtherEngine.orbit[key] = nextUp(freeOtherEngine.orbit[key]);
  }
  assert.equal(cameraStatesHaveSamePose(free, freeOtherEngine), true);
  for (const mutate of [
    camera => { camera.freefly.position[1] += 1e-12; },
    camera => { camera.freefly.yaw += 1e-12; },
    camera => { camera.freefly.pitch += 1e-12; },
    camera => { camera.orbit.target = [1, 0, 0]; }
  ]) {
    const moved = structuredClone(free);
    mutate(moved);
    assert.equal(cameraStatesHaveSamePose(free, moved), false);
  }
  assert.throws(
    () => cameraStatesHaveSamePose(orbit, { navigationMode: 'orbit' }),
    TypeError
  );
});
