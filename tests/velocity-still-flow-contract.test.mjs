/**
 * F103: under reduced motion the velocity overlay draws a still picture of
 * the flow (the design rule: `prefers-reduced-motion` stops motion). The
 * picture is traced once from fixed seeds at fixed times, held, traced again
 * only when what it shows changes, and asks for no frame; a change of the
 * setting switches the mode. The preference is read in one place
 * (`utils/reduced-motion.js`).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  STILL_FLOW_STEPS,
  STILL_FLOW_STEP_SECONDS,
  stillFlowTrace,
  trailChannelFades,
  VelocityOverlay,
} from '../assets/js/rendering/overlays/velocity/velocity-overlay.js';
import { PARTICLE_RENDER_FS } from '../assets/js/rendering/overlays/velocity/velocity-shaders.js';
import { repositoryPath, sourceFiles } from './helpers/source-files.mjs';


/** A WebGL2 stand-in that accepts every call: constants are numbers. */
function anyGl() {
  return new Proxy({}, {
    get(_target, key) {
      if (typeof key === 'string' && /^[A-Z_0-9]+$/.test(key)) return 1;
      return () => undefined;
    },
  });
}

function frameContext({ time = 1, deltaTime = 1 / 60, frameId = 1 } = {}) {
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -3, 1]);
  return {
    viewId: 'live',
    frameId,
    time,
    deltaTime,
    reducedMotion: true,
    mvpMatrix: identity.slice(),
    viewMatrix: identity.slice(),
    modelMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    cameraPosition: [0, 0, 3],
    viewportWidth: 640,
    viewportHeight: 480,
    viewportX: 0,
    viewportY: 0,
    scissorEnabled: false,
    outputFramebuffer: null,
    fov: 1,
    sizeAttenuation: 0,
    devicePixelRatio: 2,
    fogDensity: 0,
    fogNear: 0,
    fogFar: 10,
  };
}

const CONFIG = { trailFade: 0.925, chromaticFade: 0, bloomEnabled: false, bloomStrength: 0 };

/** An overlay whose passes record what they were asked to draw. */
function recordingOverlay({ still = true, config = CONFIG } = {}) {
  const fbos = {
    bloom: [{}, {}],
    bloomEnabled: false,
    height: 480,
    rasterScale: 1,
    stillPicture: null,
    trail: [{}, {}],
    trailClearPending: false,
    trailFramebuffers: [{}, {}],
    trailIdx: 0,
    width: 640,
  };
  const steps = [];
  const draws = [];
  const composites = [];
  const field = { cellCount: 4, maxMagnitude: 1 };
  const spawn = { ready: true, dirty: false, building: false, generation: 3, tableEpoch: 1, tableSize: 4, targetCount: 16 };
  const particles = {
    activeParticleCount: 16,
    forceRespawn: false,
    positionTexture: { texture: {}, plan: {} },
    readyGeneration: 3,
    still,
  };
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    gl: anyGl(),
    id: 'velocity',
    enabled: true,
    visible: true,
    _initialized: true,
    _disposed: false,
    _disposeRequested: false,
    _disposePending: false,
    _contextLost: false,
    _configGeneration: 0,
    config: { ...config },
    _presentedViewIds: new Set(['live']),
    _particleByView: new Map([['live', particles]]),
    _spawnByView: new Map([['live', spawn]]),
    _fboByView: new Map([['live', fbos]]),
    _ensureFBOs: () => fbos,
    _advanceParticles(dt, time, _field, _positions, _spawn, state) {
      steps.push({ dt, time, forceRespawn: state.forceRespawn });
      state.forceRespawn = false;
    },
    _passRenderParticles(_ctx, _field, _fbos, writeIdx, _particles, _spawn, weight) {
      draws.push({ writeIdx, weight: Array.from(weight) });
    },
    _passFade() {},
    _passBloom() {},
    _passComposite(_ctx, _fbos, trailIdx, time) {
      composites.push({ trailIdx, time });
    },
  });
  const render = ctx => overlay._renderFlow(ctx, field, 'live', particles, spawn);
  return { overlay, fbos, spawn, particles, field, steps, draws, composites, render };
}

test('the still picture is a fixed trace: fixed steps at fixed times, from one respawn, each drawn with the fade of the steps after it', () => {
  const trace = stillFlowTrace(CONFIG);
  assert.equal(trace.length, STILL_FLOW_STEPS);
  assert.deepEqual(
    trace.map(step => step.time),
    Array.from({ length: STILL_FLOW_STEPS }, (_, step) => step * STILL_FLOW_STEP_SECONDS),
  );
  assert.ok(trace.every(step => step.dt === STILL_FLOW_STEP_SECONDS));
  assert.deepEqual(trace.map(step => step.forceRespawn), [true, ...Array(STILL_FLOW_STEPS - 1).fill(false)]);
  // The head (last step) is drawn at full light; each earlier step as faded
  // as the moving flow's trail would have left it.
  assert.deepEqual(Array.from(trace.at(-1).weight), [1, 1, 1, 1]);
  const fades = trailChannelFades(CONFIG.trailFade, CONFIG.chromaticFade);
  for (const [index, step] of trace.entries()) {
    const later = STILL_FLOW_STEPS - 1 - index;
    assert.deepEqual(Array.from(step.weight), Array.from(new Float32Array(fades.map(fade => fade ** later))));
  }
  // The chromatic fade splits the channels as the flow's fade pass does.
  const chromatic = stillFlowTrace({ trailFade: 0.9, chromaticFade: 1 });
  const [r, g, b] = chromatic[0].weight;
  assert.ok(r > g && g > b, 'red lingers, blue goes first');
  // Equal settings give the equal plan, whatever the clock says.
  assert.deepEqual(stillFlowTrace(CONFIG), trace);
  assert.match(PARTICLE_RENDER_FS, /uniform vec4 u_weight;/);
  assert.match(PARTICLE_RENDER_FS, /fragColor = vec4\(particleColor \* intensity, intensity\) \* u_weight;/);
});

test('a still picture is traced once, held, and draws the same whatever the frame time', () => {
  const first = recordingOverlay();
  first.render(frameContext({ time: 5, deltaTime: 0.03, frameId: 9 }));
  assert.equal(first.steps.length, STILL_FLOW_STEPS);
  assert.deepEqual(first.steps[0], { dt: STILL_FLOW_STEP_SECONDS, time: 0, forceRespawn: true });
  assert.deepEqual(
    first.draws.map(draw => draw.weight),
    stillFlowTrace(CONFIG).map(step => Array.from(step.weight)),
  );
  assert.deepEqual(first.composites, [{ trailIdx: 1, time: 0 }], 'composited at a fixed time (no grain motion)');
  assert.notEqual(first.fbos.stillPicture, null);

  // The same picture on another frame, at another time: nothing is traced,
  // the held trail is composited again.
  first.render(frameContext({ time: 50, deltaTime: 0.001, frameId: 10 }));
  assert.equal(first.steps.length, STILL_FLOW_STEPS);
  assert.deepEqual(first.composites.at(-1), { trailIdx: 1, time: 0 });

  // Another overlay, another clock: the identical trace.
  const second = recordingOverlay();
  second.render(frameContext({ time: 123.4, deltaTime: 0.2, frameId: 77 }));
  assert.deepEqual(second.steps, first.steps);
  assert.deepEqual(second.draws, first.draws);
});

test('a still picture is traced again when what it shows changes, and only then', () => {
  const fixture = recordingOverlay();
  const ctx = frameContext();
  fixture.render(ctx);
  const traced = () => fixture.steps.length / STILL_FLOW_STEPS;
  assert.equal(traced(), 1);
  // The camera moved.
  ctx.mvpMatrix[12] += 0.5;
  fixture.render(ctx);
  assert.equal(traced(), 2);
  // Back to the first camera: traced again, to the same picture.
  ctx.mvpMatrix[12] -= 0.5;
  fixture.render(ctx);
  assert.equal(traced(), 3);
  assert.deepEqual(fixture.draws.slice(0, STILL_FLOW_STEPS), fixture.draws.slice(-STILL_FLOW_STEPS).map(draw => ({ ...draw, writeIdx: 1 })));
  // The look changed (a trail clear: a colormap, a size, a new generation).
  fixture.fbos.trailClearPending = true;
  fixture.render(ctx);
  assert.equal(traced(), 4);
  assert.equal(fixture.fbos.trailClearPending, false);
  // A refill of the table, another particle count, another field.
  fixture.spawn.tableEpoch += 1;
  fixture.render(ctx);
  assert.equal(traced(), 5);
  fixture.particles.activeParticleCount = 8;
  fixture.render(ctx);
  assert.equal(traced(), 6);
  fixture.render(ctx);
  assert.equal(traced(), 6);
  ctx.fogDensity = 0.5;
  fixture.render(ctx);
  assert.equal(traced(), 7);
  // Any setting (Flow speed, Trail persistence, a bloom dial…): each can
  // change the trace or its bloom.
  fixture.overlay._configGeneration += 1;
  fixture.render(ctx);
  assert.equal(traced(), 8);
  const source = readFileSync(repositoryPath('assets/js/rendering/overlays/velocity/velocity-overlay.js'), 'utf8');
  assert.match(source, /cfg\[validated\.key\] = validated\.value;\n\s*this\._configGeneration \+= 1;/);
});

test('the moving flow fades and draws every frame at full light, and holds no still picture', () => {
  const fixture = recordingOverlay({ still: false });
  fixture.fbos.stillPicture = { stale: true };
  const ctx = frameContext({ time: 2 });
  ctx.reducedMotion = false;
  fixture.render(ctx);
  fixture.render(ctx);
  assert.equal(fixture.steps.length, 0, 'the flow advances in update, not here');
  assert.deepEqual(fixture.draws.map(draw => draw.weight), [[1, 1, 1, 1], [1, 1, 1, 1]]);
  assert.deepEqual(fixture.composites.map(composite => composite.time), [2, 2]);
  assert.equal(fixture.fbos.stillPicture, null);
});

test('a held still picture asks for no frame; one not drawn yet is owed; the flow keeps asking', () => {
  const fixture = recordingOverlay();
  const { overlay } = fixture;
  // Not drawn yet: owed (drawn at once, not paced).
  assert.equal(overlay.needsContinuousFrames(), true);
  assert.equal(overlay.needsOwedFrames(), true);
  fixture.render(frameContext());
  assert.equal(overlay.needsContinuousFrames(), false, 'a settled scene requests no frames');
  assert.equal(overlay.needsOwedFrames(), false);
  // Anything that makes the held picture stale asks again.
  fixture.fbos.trailClearPending = true;
  assert.equal(overlay.needsOwedFrames(), true);
  fixture.render(frameContext());
  assert.equal(overlay.needsContinuousFrames(), false);
  fixture.spawn.tableEpoch += 1;
  assert.equal(overlay.needsOwedFrames(), true);
  fixture.render(frameContext());
  fixture.spawn.building = true;
  assert.equal(overlay.needsOwedFrames(), true, 'a table being built is owed');
  fixture.spawn.building = false;
  assert.equal(overlay.needsContinuousFrames(), false);
  overlay._configGeneration += 1;
  assert.equal(overlay.needsOwedFrames(), true, 'a setting changed: traced again');
  fixture.render(frameContext());
  assert.equal(overlay.needsContinuousFrames(), false);
  // The preference cleared: the same particles flow, frames without end, paced.
  fixture.particles.still = false;
  assert.equal(overlay.needsContinuousFrames(), true);
  assert.equal(overlay.needsOwedFrames(), false);
});

function updateFixture() {
  const positions = new Float32Array(3);
  const particle = {
    activeParticleCount: 12,
    fieldId: 'velocity',
    layoutKey: '3d',
    positionsRef: positions,
    readyGeneration: 1,
    forceRespawn: false,
    lastAdvancedFrameId: -1,
    lastCameraPosition: new Float32Array(3),
    lastViewMatrix: new Float32Array(16),
    cameraMotionAmount: 0.5,
    positionTexture: null,
    still: false,
  };
  const spawn = { ready: true, dirty: false, generation: 1, tableSize: 1, textureInfo: {}, visibilityTextureInfo: {} };
  const calls = [];
  const positionTexture = { texture: {}, plan: {} };
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    _activeFieldId: 'velocity',
    _fieldsById: new Map([['velocity', new Map([['3d', { cellCount: 1 }]])]]),
    _fboByView: new Map(),
    _particleByView: new Map([['live', particle]]),
    config: { particleCount: 12, syncWithLOD: false },
    _ensureParticleState: () => particle,
    _ensurePositionTexture: () => positionTexture,
    _ensureSpawnTable: () => spawn,
    _updateCameraMotion: () => calls.push('camera'),
    _simulate: () => calls.push('simulate'),
  });
  const update = reducedMotion => overlay._doUpdate(1 / 60, {
    layoutKey: '3d',
    dimensionLevel: 3,
    frameId: 7,
    getViewPositions: () => positions,
    reducedMotion,
    time: 1,
    viewId: 'live',
  });
  return { overlay, particle, calls, positionTexture, update };
}

test('under reduced motion an update advances nothing; the flow resumes when the setting clears', () => {
  const fixture = updateFixture();
  fixture.update(true);
  assert.deepEqual(fixture.calls, [], 'no simulation, no camera-motion smear');
  assert.equal(fixture.particle.still, true);
  assert.equal(fixture.particle.positionTexture, fixture.positionTexture, 'the trace reads the update\'s positions');
  assert.equal(fixture.particle.lastCameraPosition, null, 'the camera history starts over at the switch');
  assert.equal(fixture.particle.cameraMotionAmount, 0);
  fixture.update(true);
  assert.deepEqual(fixture.calls, []);
  fixture.update(false);
  assert.deepEqual(fixture.calls, ['camera', 'simulate']);
  assert.equal(fixture.particle.still, false);
  assert.throws(() => fixture.update(undefined), /reducedMotion must be an exact boolean/);
});

function spawnTableFixture(stateOverrides) {
  const state = {
    dirty: false,
    version: 2,
    building: false,
    buildToken: null,
    notificationId: null,
    textureInfo: {},
    visibilityTextureInfo: {},
    tableSize: 512,
    lastLod: -1,
    ready: true,
    generation: 2,
    cellCount: 4096,
    layoutKey: '3d',
    placement: null,
    spawnNext: 1024,
    coversAll: false,
    epochStartedAt: 0,
    tableStart: 512,
    tableEpoch: 2,
    ...stateOverrides,
  };
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    config: { lifetime: 8, syncWithLOD: false },
    _spawnByView: new Map([['live', state]]),
    _invalidateViewGeneration() {},
  });
  const ensure = ctx => overlay._ensureSpawnTable('live', {
    layoutKey: '3d',
    getLodLevel: () => -1,
    ...ctx,
  }, 4096, new Float32Array(4096 * 3), 3);
  return { state, ensure };
}

test('a still picture has no respawn epochs: it is drawn from the table that begins the visiting order', () => {
  const scheduled = [];
  const originalIdle = globalThis.requestIdleCallback;
  globalThis.requestIdleCallback = fn => scheduled.push(fn);
  try {
    // The moving flow refills each epoch, from where the last fill stopped.
    const flowing = spawnTableFixture();
    flowing.ensure({ reducedMotion: false, time: 100 });
    assert.equal(flowing.state.dirty, true);
    assert.equal(flowing.state.spawnNext, 1024);
    // Under reduced motion a table that is not the first fill is refilled
    // from the start of the order, once.
    const stillLater = spawnTableFixture();
    stillLater.ensure({ reducedMotion: true, time: 100 });
    assert.equal(stillLater.state.dirty, true);
    assert.equal(stillLater.state.building, true);
    assert.equal(stillLater.state.spawnNext, 0);
    // The first fill holds, however long the picture stays.
    const stillFirst = spawnTableFixture({ tableStart: 0 });
    stillFirst.ensure({ reducedMotion: true, time: 1e6 });
    assert.equal(stillFirst.state.dirty, false);
    assert.equal(stillFirst.state.building, false);
  } finally {
    if (originalIdle === undefined) delete globalThis.requestIdleCallback;
    else globalThis.requestIdleCallback = originalIdle;
  }
  // A build records where its visits began.
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), { config: { spawnTableSize: 8 } });
  const build = overlay._createSpawnTableBuild(new Uint8Array(100).fill(1), 100, null, null, 130, true);
  assert.equal(build.start, 30);
  const source = readFileSync(repositoryPath('assets/js/rendering/overlays/velocity/velocity-overlay.js'), 'utf8');
  assert.match(source, /state\.tableStart = build\.start;\n\s*state\.tableEpoch \+= 1;/);
});

test('the viewer hands the overlay the preference each frame and redraws when it changes', () => {
  const viewer = readFileSync(repositoryPath('assets/js/rendering/viewer.js'), 'utf8');
  assert.match(viewer, /import \{ onReducedMotionChange, prefersReducedMotion \} from '\.\.\/utils\/reduced-motion\.js';/);
  assert.equal(viewer.match(/reducedMotion: prefersReducedMotion\(\),/g)?.length, 1);
  assert.equal(viewer.match(/overlayOpts\.reducedMotion = prefersReducedMotion\(\);/g)?.length, 1);
  assert.match(
    viewer,
    /eventCleanupFns\.push\(onReducedMotionChange\(\(\) => \{\n\s*if \(disposed \|\| webglContextLost\) return;\n\s*invalidateFrame\(\);\n\s*\}\)\);/,
  );
  const context = readFileSync(repositoryPath('assets/js/rendering/overlays/overlay-context.js'), 'utf8');
  assert.match(context, /ctx\.reducedMotion = reducedMotion;/);
});

test('the app reads the reduced-motion preference in one place', () => {
  const readers = sourceFiles('assets/js')
    .filter(file => /prefers-reduced-motion/.test(readFileSync(file.path, 'utf8').replace(/^\s*(\*|\/\/).*$/gm, '')))
    .map(file => `assets/js/${file.relative}`);
  // The benchmark reports the environment of the page it measures (beside
  // its color scheme and contrast); it moves nothing.
  assert.deepEqual(readers, ['assets/js/dev/benchmark.js', 'assets/js/utils/reduced-motion.js']);
});

test('the preference module reads the platform live and announces changes', async () => {
  const originalMatchMedia = globalThis.matchMedia;
  const listeners = new Set();
  const media = {
    matches: false,
    addEventListener(type, listener) { assert.equal(type, 'change'); listeners.add(listener); },
    removeEventListener(type, listener) { assert.equal(type, 'change'); listeners.delete(listener); },
  };
  const queries = [];
  delete globalThis.matchMedia;
  const { prefersReducedMotion, onReducedMotionChange } = await import('../assets/js/utils/reduced-motion.js');
  try {
    // A platform that cannot state a preference: motion stays, nothing to watch.
    assert.equal(prefersReducedMotion(), false);
    assert.equal(typeof onReducedMotionChange(() => {}), 'function');
    globalThis.matchMedia = query => {
      queries.push(query);
      return media;
    };
    assert.equal(prefersReducedMotion(), false);
    media.matches = true;
    assert.equal(prefersReducedMotion(), true, 'read live');
    const heard = [];
    const stop = onReducedMotionChange(reduced => heard.push(reduced));
    for (const listener of listeners) listener();
    assert.deepEqual(heard, [true]);
    stop();
    assert.equal(listeners.size, 0);
    assert.deepEqual(queries, ['(prefers-reduced-motion: reduce)'], 'one media query list, kept');
    assert.throws(() => onReducedMotionChange(null), /must be a function/);
  } finally {
    media.matches = false;
    if (originalMatchMedia === undefined) delete globalThis.matchMedia;
    else globalThis.matchMedia = originalMatchMedia;
  }
});
