/**
 * Live pass 5, L18-3: under reduced motion a camera path went to its last
 * keyframe at once, but `camera-path.play` answered as if it had played
 * (`{seconds: 18.3, ended: 'end'}`), and the agent told the person "it ran
 * all 18.3 s"; nothing it could read said that the person's system asks for
 * reduced motion. The play now answers `ended: 'reduced-motion'` with the
 * seconds the camera moved (0), its step says so, and `views.state` names the
 * preference (`reduced_motion`).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { getActionCatalog, getActions } from '../assets/js/app/actions/index.js';
import { createViewReads } from '../assets/js/app/reads/views.js';
import { cameraStateForOrbitPose } from '../assets/js/rendering/camera-state-contract.js';
import { destroyMounted, installModuleEnvironment, mountCinematicCamera } from './helpers/cinematic-camera-harness.mjs';

// One media query list for the whole file: `utils/reduced-motion.js` keeps the first one it is given.
const media = { matches: false, addEventListener() {}, removeEventListener() {} };
const originalMatchMedia = globalThis.matchMedia;
globalThis.matchMedia = () => media;
test.after(() => {
  media.matches = false;
  if (originalMatchMedia === undefined) delete globalThis.matchMedia;
  else globalThis.matchMedia = originalMatchMedia;
});

function camera(index) {
  return cameraStateForOrbitPose({ navigationMode: 'orbit', target: [index, 0, 0], radius: 3 + index, theta: 0.25 * index, phi: 0.75 });
}

async function withPath(body) {
  const environment = installModuleEnvironment();
  try {
    const module = mountCinematicCamera();
    for (let index = 0; index < 3; index++) await getActions().dispatch('camera-path.keyframe.add', { camera: camera(index) });
    await getActions().dispatch('camera-path.duration.set', { seconds: 2 });
    await body(module, environment);
  } finally {
    destroyMounted();
    environment.restore();
  }
}

test('under reduced motion camera-path.play says it went to the end at once, in no time, and its step says so', async () => {
  media.matches = true;
  try {
    await withPath(async module => {
      const played = await getActions().dispatch('camera-path.play', {});
      assert.deepEqual(played.outcome, { seconds: 0, keyframes: 3, ended: 'reduced-motion' });
      assert.equal(module.camera.getPlaybackController().getState(), 'STOPPED', 'nothing plays');
      const end = module.viewer.getCameraState().orbit;
      assert.deepEqual([end.radius, end.target], [5, [2, 0, 0]], 'the camera is at the last keyframe');
      const definition = getActionCatalog().get('camera-path.play');
      assert.equal(definition.describe({}, played.outcome), 'Went to the end of the camera path at once (reduced motion)');
      assert.match(definition.summary, /"reduced-motion"/);
    });
  } finally {
    media.matches = false;
  }
});

test('without reduced motion a play to its end answers ended "end" with the path\'s length', async () => {
  const originalNow = performance.now;
  let clock = 1000;
  performance.now = () => clock;
  try {
    await withPath(async (module, environment) => {
      const playing = getActions().dispatch('camera-path.play', {});
      for (let wait = 0; wait < 20 && module.camera.getPlaybackController().getState() !== 'PLAYING'; wait++) {
        await new Promise(resolve => setImmediate(resolve));
      }
      clock += 5000;
      environment.drainFrames();
      assert.deepEqual((await playing).outcome, { seconds: 4, keyframes: 3, ended: 'end' });
    });
  } finally {
    performance.now = originalNow;
  }
});

test('reduced motion turned on while a path plays: the play says the rest went at once, and how long it moved', async () => {
  const originalNow = performance.now;
  let clock = 1000;
  performance.now = () => clock;
  try {
    await withPath(async (module, environment) => {
      const playing = getActions().dispatch('camera-path.play', {});
      for (let wait = 0; wait < 20 && module.camera.getPlaybackController().getState() !== 'PLAYING'; wait++) {
        await new Promise(resolve => setImmediate(resolve));
      }
      clock += 1500;
      environment.drainFrames();
      media.matches = true;
      clock += 16;
      environment.drainFrames();
      const played = await playing;
      assert.equal(played.outcome.ended, 'reduced-motion');
      assert.equal(played.outcome.seconds, 1.5);
    });
  } finally {
    performance.now = originalNow;
    media.matches = false;
  }
});

function viewReads() {
  const viewer = {
    getViewLayout: () => ({ mode: 'single' }),
    getLiveViewHidden: () => false,
    getSnapshotViews: () => [],
    getViewName: () => null,
    getLiveViewLabel: () => 'cell_type',
    getViewCameraState: () => null,
    getCamerasLocked: () => false,
  };
  const state = {
    pointCount: 10,
    getActiveViewId: () => 'live',
    getFieldForView: () => null,
    getFilterSummaryForView: () => [],
    getHighlightPages: () => [],
  };
  return createViewReads({ state, viewer, documentRef: null, getFigureExport: () => null });
}

test('views.state says whether the person\'s system asks for reduced motion, and its result schema holds it', () => {
  const definition = getActionCatalog().get('views.state');
  assert.ok(definition.result.required.includes('reduced_motion'));
  assert.match(definition.result.properties.reduced_motion.description, /camera path goes to its last keyframe at once/);
  media.matches = false;
  assert.equal(viewReads().viewsState().reduced_motion, false);
  media.matches = true;
  try {
    assert.equal(viewReads().viewsState().reduced_motion, true);
  } finally {
    media.matches = false;
  }
});
