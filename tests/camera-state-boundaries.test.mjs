import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const {
  assertCameraState,
  assertNavigationMode,
  isExactCameraState
} = await import('../assets/js/rendering/camera-state-contract.js');
const {
  interpolateCameraState,
  resolveSegmentDurations
} = await import('../assets/js/app/ui/modules/cinematic-camera/interpolation-engine.js');

const scopedSources = await Promise.all([
  '../assets/js/app/session/contributors/core-state.js',
  '../assets/js/app/state-serializer/multiview.js',
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
  assert.match(cameraPathUi, /assertCameraPathSessionState\(data\)/);
});

test('camera-path interpolation rejects incomplete state and unsupported settings', () => {
  const first = {
    id: 'first',
    label: 'First',
    ...cameraState('orbit'),
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
    transitionDuration: 1
  };
  const options = {
    positionMethod: 'linear',
    rotationMethod: 'linear',
    easing: 'linear',
    loop: false,
    autoPaceSpeed: 1
  };

  assert.deepEqual(resolveSegmentDurations([first, second], 1), [1]);
  assert.equal(
    isExactCameraState(interpolateCameraState([first, second], 0.5, options)),
    true
  );

  const missingOrbit = { ...first, orbit: null };
  assert.throws(
    () => resolveSegmentDurations([missingOrbit, second], 1),
    /keyframe 0/i
  );
  assert.throws(
    () => resolveSegmentDurations([first, second], undefined),
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

test('session, snapshot, and figure-export boundaries assert exact camera state', () => {
  const byPath = new Map(scopedSources.map(({ relativePath, source }) => [relativePath, source]));
  const coreStateSource = byPath.get(
    '../assets/js/app/session/contributors/core-state.js'
  );
  assert.match(
    coreStateSource,
    /assertCameraState\([\s\S]*?viewer\.getCameraState\(\)/
  );
  assert.doesNotMatch(
    coreStateSource,
    /_pushOutliersToViewer|_pushOutlierThresholdToViewer/,
    'session restore must use the current visibility/transparency owner'
  );
  assert.match(
    coreStateSource,
    /state\.updateOutlierQuantiles\(\);\s*state\.computeGlobalVisibility\(\);/
  );
  assert.match(
    byPath.get('../assets/js/app/state-serializer/multiview.js'),
    /assertCameraState\(multiview\.liveCameraState/
  );
  assert.match(
    byPath.get('../assets/js/app/ui/modules/figure-export/figure-export-engine.js'),
    /assertCameraState\(\s*viewer\.getViewCameraState/
  );
  assert.match(
    byPath.get('../assets/js/rendering/viewer.js'),
    /setViewCameraState\(viewId,\s*camState\)[\s\S]*?assertCameraState\(camState/
  );
});
