import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  VelocityOverlay,
} from '../assets/js/rendering/overlays/velocity/velocity-overlay.js';
import {
  buildOverlayContext,
} from '../assets/js/rendering/overlays/overlay-context.js';
import {
  getNotificationCenter,
} from '../assets/js/app/notification-center.js';
import {
  PARTICLE_UPDATE_VS,
  TRAIL_FADE_FS,
} from '../assets/js/rendering/overlays/velocity/velocity-shaders.js';

const viewerSource = readFileSync(
  new URL('../assets/js/rendering/viewer.js', import.meta.url),
  'utf8',
);

test('velocity constructor and config preserve the exact min/max point-size invariant transactionally', () => {
  assert.throws(
    () => new VelocityOverlay({}, { minSize: 10, maxSize: 5 }),
    /minSize must be less than or equal to maxSize/,
  );
  const equal = new VelocityOverlay({}, { minSize: 5, maxSize: 5 });
  assert.equal(equal.config.minSize, 5);
  assert.equal(equal.config.maxSize, 5);

  const overlay = new VelocityOverlay({}, {
    minSize: 6,
    maxSize: 8,
  });
  const trails = { trailClearPending: false };
  overlay._initialized = true;
  overlay._fboByView.set('live', trails);

  assert.throws(
    () => overlay.setConfig('maxSize', 5),
    /maxSize must be greater than or equal to minSize/,
  );
  assert.equal(overlay.config.maxSize, 8);
  assert.equal(trails.trailClearPending, false);
  assert.throws(
    () => overlay.setConfig('minSize', 9),
    /minSize must be less than or equal to maxSize/,
  );
  assert.equal(overlay.config.minSize, 6);
  assert.equal(trails.trailClearPending, false);

  overlay.setConfig('minSize', 8);
  assert.equal(overlay.config.minSize, 8);
  assert.equal(overlay.config.maxSize, 8);
  assert.equal(trails.trailClearPending, true);
});

test('direct velocity enable initializes before publishing enabled state', () => {
  const overlay = new VelocityOverlay({});
  let initCalls = 0;
  overlay._doInit = () => {
    initCalls++;
  };

  overlay.setEnabled(true);

  assert.equal(initCalls, 1);
  assert.equal(overlay._initialized, true);
  assert.equal(overlay.enabled, true);
});

test('transient velocity initialization failure remains retryable on the same overlay', () => {
  const overlay = new VelocityOverlay({});
  let initCalls = 0;
  overlay._doInit = () => {
    initCalls++;
    if (initCalls === 1) {
      throw new Error('synthetic transient initialization failure');
    }
  };

  assert.throws(
    () => overlay.setEnabled(true),
    /synthetic transient initialization failure/,
  );
  assert.equal(overlay.enabled, false);
  assert.equal(overlay._initialized, false);
  assert.equal(overlay._disposed, false);
  assert.equal(overlay._disposePending, false);

  overlay.setEnabled(true);

  assert.equal(initCalls, 2);
  assert.equal(overlay._initialized, true);
  assert.equal(overlay._disposed, false);
  assert.equal(overlay.enabled, true);
});

test('velocity disposal retains failed handles and only publishes disposed after retry', () => {
  const program = { id: 'program' };
  const colormap = { id: 'colormap' };
  const deleteCalls = new Map();
  let failProgramOnce = true;
  const gl = {
    deleteBuffer() {},
    deleteProgram(handle) {
      deleteCalls.set(handle, (deleteCalls.get(handle) ?? 0) + 1);
      if (handle === program && failProgramOnce) {
        failProgramOnce = false;
        throw new Error('synthetic program disposal failure');
      }
    },
    deleteTexture(handle) {
      deleteCalls.set(handle, (deleteCalls.get(handle) ?? 0) + 1);
    },
    deleteTransformFeedback() {},
    deleteVertexArray() {},
  };
  const overlay = new VelocityOverlay(gl);
  overlay._initialized = true;
  overlay.enabled = true;
  overlay._programUpdate = program;
  overlay._colormapTexture = colormap;

  assert.throws(
    () => overlay.dispose(),
    /synthetic program disposal failure/,
  );

  assert.equal(overlay._disposed, false);
  assert.equal(overlay._disposePending, true);
  assert.equal(overlay.enabled, false);
  assert.equal(overlay._programUpdate, program);
  assert.equal(overlay._colormapTexture, null);
  assert.equal(deleteCalls.get(program), 1);
  assert.equal(deleteCalls.get(colormap), 1);
  assert.throws(
    () => overlay.setEnabled(true),
    /disposal-pending/,
  );
  assert.throws(
    () => overlay.init(),
    /cannot initialize after disposal has begun/i,
  );
  assert.throws(
    () => overlay.setActiveField('replacement'),
    /cannot set the active velocity field after disposal has begun/i,
  );
  assert.throws(
    () => overlay.setFailureHandler(() => {}),
    /cannot set a failure handler after disposal has begun/i,
  );
  assert.throws(
    () => overlay.setConfig('particleCount', 1),
    /cannot change configuration after disposal has begun/i,
  );
  overlay.enabled = true;
  let postFenceWork = 0;
  overlay._doUpdate = () => {
    postFenceWork++;
  };
  overlay._doRender = () => {
    postFenceWork++;
  };
  overlay.update(0.016, {});
  overlay.render({});
  assert.equal(postFenceWork, 0);
  overlay.enabled = false;

  overlay.dispose();

  assert.equal(overlay._disposed, true);
  assert.equal(overlay._programUpdate, null);
  assert.equal(deleteCalls.get(program), 2);
  assert.equal(deleteCalls.get(colormap), 1);
});

test('velocity disposal retries notification ownership without deleting detached textures twice', t => {
  const notifications = getNotificationCenter();
  const originalDismiss = notifications.dismiss;
  let failDismissOnce = true;
  notifications.dismiss = id => {
    assert.equal(id, 'spawn-loading');
    if (failDismissOnce) {
      failDismissOnce = false;
      throw new Error('synthetic disposal notification failure');
    }
    return true;
  };
  t.after(() => {
    notifications.dismiss = originalDismiss;
  });

  const spawnTexture = { id: 'spawn' };
  const visibilityTexture = { id: 'visibility' };
  const deleteCalls = [];
  const overlay = new VelocityOverlay({
    deleteTexture(texture) {
      deleteCalls.push(texture);
    },
  });
  overlay._initialized = true;
  overlay._spawnByView.set('live', {
    notificationId: 'spawn-loading',
    ready: true,
    textureInfo: {
      height: 1,
      texture: spawnTexture,
      width: 1,
    },
    version: 1,
    visibilityTextureInfo: {
      height: 1,
      texture: visibilityTexture,
      width: 1,
    },
  });

  assert.throws(
    () => overlay.dispose(),
    /synthetic disposal notification failure/,
  );

  const retained = overlay._spawnByView.get('live');
  assert.equal(overlay._disposed, false);
  assert.equal(retained.notificationId, 'spawn-loading');
  assert.equal(retained.textureInfo, null);
  assert.equal(retained.visibilityTextureInfo, null);
  assert.equal(
    deleteCalls.filter(texture => texture === spawnTexture).length,
    1,
  );
  assert.equal(
    deleteCalls.filter(texture => texture === visibilityTexture).length,
    1,
  );

  overlay.dispose();

  assert.equal(overlay._disposed, true);
  assert.equal(overlay._spawnByView.size, 0);
  assert.equal(
    deleteCalls.filter(texture => texture === spawnTexture).length,
    1,
  );
  assert.equal(
    deleteCalls.filter(texture => texture === visibilityTexture).length,
    1,
  );
});

test('velocity disposal detaches vector texture descriptors into the retry queue', () => {
  const vectorTexture = { id: 'vector' };
  let deleteAttempts = 0;
  const overlay = new VelocityOverlay({
    deleteTexture(texture) {
      assert.equal(texture, vectorTexture);
      deleteAttempts++;
      if (deleteAttempts === 1) {
        throw new Error('synthetic vector texture disposal failure');
      }
    },
  });
  overlay._initialized = true;
  const entry = {
    cellCount: 2,
    components: 3,
    height: 1,
    maxMagnitude: 1,
    texture: vectorTexture,
    width: 2,
  };
  overlay._fieldsById.set(
    'field-a',
    new Map([[3, entry]]),
  );

  assert.throws(
    () => overlay.dispose(),
    /synthetic vector texture disposal failure/,
  );

  assert.equal(overlay._disposed, false);
  assert.equal(entry.texture, null);
  assert.equal(overlay._pendingDerivedTextureDeletes.size, 1);

  overlay.dispose();

  assert.equal(overlay._disposed, true);
  assert.equal(overlay._pendingDerivedTextureDeletes.size, 0);
  assert.equal(deleteAttempts, 2);
});

test('steady velocity flow performs no synchronous WebGL state queries', () => {
  const source = VelocityOverlay.prototype._renderFlow.toString();
  assert.doesNotMatch(
    source,
    /getParameter|readPixels|clientWaitSync/,
  );
  assert.doesNotMatch(source, /for \(const restore|=>\s*gl\./);
  assert.doesNotMatch(
    buildOverlayContext.toString(),
    /Array\.from|const matrixKeys = \[/,
  );
});

function createSimulationGl() {
  const draws = [];
  let boundVao = null;
  let boundOutput = null;
  const gl = {
    POINTS: 0,
    RASTERIZER_DISCARD: 0x8c89,
    TEXTURE0: 0x84c0,
    TEXTURE1: 0x84c1,
    TEXTURE2: 0x84c2,
    TEXTURE_2D: 0x0de1,
    TRANSFORM_FEEDBACK: 0x8e22,
    TRANSFORM_FEEDBACK_BUFFER: 0x8c8e,
    activeTexture() {},
    beginTransformFeedback() {},
    bindBufferBase(_target, _index, value) {
      boundOutput = value;
    },
    bindTexture() {},
    bindTransformFeedback() {},
    bindVertexArray(value) {
      boundVao = value;
    },
    disable() {},
    drawArrays(_mode, _first, count) {
      draws.push({ boundOutput, boundVao, count });
    },
    enable() {},
    endTransformFeedback() {},
    uniform1f() {},
    uniform1i() {},
    useProgram() {},
  };
  return { draws, gl };
}

function createParticleState(id, activeParticleCount = 8) {
  return {
    activeParticleCount,
    buffers: [
      { id: `${id}-buffer-0` },
      { id: `${id}-buffer-1` },
    ],
    cameraMotionAmount: 0,
    capacity: activeParticleCount,
    currentBuffer: 0,
    forceRespawn: true,
    lastAdvancedFrameId: -1,
    lastCameraPosition: null,
    lastViewMatrix: null,
    readyGeneration: 1,
    vaos: [
      { id: `${id}-vao-0` },
      { id: `${id}-vao-1` },
    ],
  };
}

test('failed partial particle cleanup retains exact buffer bytes for retry', () => {
  const buffer = { id: 'partial-buffer' };
  const priorBuffer = { id: 'prior-buffer' };
  const priorVao = { id: 'prior-vao' };
  let failDeleteOnce = true;
  let boundBuffer = priorBuffer;
  let boundVao = priorVao;
  const gl = {
    ARRAY_BUFFER: 0x8892,
    ARRAY_BUFFER_BINDING: 0x8894,
    DYNAMIC_COPY: 0x88ea,
    NO_ERROR: 0,
    VERTEX_ARRAY_BINDING: 0x85b5,
    bindBuffer(target, value) {
      assert.equal(target, this.ARRAY_BUFFER);
      boundBuffer = value;
    },
    bindVertexArray(value) {
      boundVao = value;
    },
    bufferData() {},
    createBuffer() {
      return buffer;
    },
    createVertexArray() {
      return null;
    },
    deleteBuffer(value) {
      assert.equal(value, buffer);
      if (failDeleteOnce) {
        failDeleteOnce = false;
        throw new Error('synthetic partial particle cleanup failure');
      }
    },
    deleteVertexArray() {},
    getError() {
      return this.NO_ERROR;
    },
    getParameter(parameter) {
      if (parameter === this.ARRAY_BUFFER_BINDING) return priorBuffer;
      if (parameter === this.VERTEX_ARRAY_BINDING) return priorVao;
      throw new RangeError(`Unexpected parameter ${parameter}.`);
    },
  };
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    gl,
    _pendingParticleRetirements: new Set(),
    _residentParticleBytes: 0n,
  });

  assert.throws(
    () => overlay._createParticleGeneration(8),
    /particle allocation and cleanup were incomplete/,
  );

  assert.equal(boundBuffer, priorBuffer);
  assert.equal(boundVao, priorVao);
  assert.equal(overlay._pendingParticleRetirements.size, 1);
  assert.equal(overlay._residentParticleBytes, 256n);

  overlay._flushPendingParticleRetirements();

  assert.equal(overlay._pendingParticleRetirements.size, 0);
  assert.equal(overlay._residentParticleBytes, 0n);
});

test('failed particle disposal retains exact ownership and retries only undeleted handles', () => {
  const state = {
    ...createParticleState('live', 8),
    bytes: 512n,
  };
  const failedVao = state.vaos[0];
  const deleteAttempts = new Map();
  const deletedBuffers = [];
  const deletedVaos = [];
  let failOnce = true;
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    gl: {
      deleteBuffer(buffer) {
        deleteAttempts.set(
          buffer,
          (deleteAttempts.get(buffer) ?? 0) + 1,
        );
        deletedBuffers.push(buffer);
      },
      deleteVertexArray(vao) {
        deleteAttempts.set(vao, (deleteAttempts.get(vao) ?? 0) + 1);
        if (vao === failedVao && failOnce) {
          failOnce = false;
          throw new Error('synthetic particle VAO retirement failure');
        }
        deletedVaos.push(vao);
      },
    },
    _particleByView: new Map([['live', state]]),
    _pendingParticleRetirements: new Set(),
    _residentParticleBytes: state.bytes,
  });

  assert.throws(
    () => overlay._disposeParticleState('live'),
    /synthetic particle VAO retirement failure/,
  );

  assert.equal(overlay._particleByView.has('live'), false);
  assert.equal(overlay._pendingParticleRetirements.has(state), true);
  assert.equal(overlay._residentParticleBytes, state.bytes);
  assert.equal(state.vaos[0], failedVao);
  assert.equal(state.vaos[1], null);
  assert.deepEqual(state.buffers, [null, null]);

  overlay._flushPendingParticleRetirements();

  assert.equal(overlay._pendingParticleRetirements.size, 0);
  assert.equal(overlay._residentParticleBytes, 0n);
  assert.equal(deleteAttempts.get(failedVao), 2);
  assert.equal(deletedVaos.length, 2);
  assert.equal(deletedBuffers.length, 2);
  assert.equal(
    [...deleteAttempts.entries()]
      .filter(([handle]) => handle !== failedVao)
      .every(([, count]) => count === 1),
    true,
  );
});

test('failed old-particle retirement leaves the replacement published and accounts both generations until retry', () => {
  const old = {
    ...createParticleState('old', 4),
    bytes: 256n,
    capacity: 4,
  };
  const replacement = {
    ...createParticleState('replacement', 0),
    bytes: 512n,
    capacity: 8,
  };
  const failedBuffer = old.buffers[0];
  const deleteAttempts = new Map();
  let failOnce = true;
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    config: { particleCapacity: 16 },
    gl: {
      deleteBuffer(buffer) {
        deleteAttempts.set(
          buffer,
          (deleteAttempts.get(buffer) ?? 0) + 1,
        );
        if (buffer === failedBuffer && failOnce) {
          failOnce = false;
          throw new Error('synthetic replaced buffer retirement failure');
        }
      },
      deleteVertexArray(vao) {
        deleteAttempts.set(vao, (deleteAttempts.get(vao) ?? 0) + 1);
      },
    },
    _createParticleGeneration(capacity) {
      assert.equal(capacity, 8);
      return replacement;
    },
    _particleByView: new Map([['live', old]]),
    _pendingParticleRetirements: new Set(),
    _residentParticleBytes: old.bytes,
  });

  assert.throws(
    () => overlay._ensureParticleState('live', 8),
    /synthetic replaced buffer retirement failure/,
  );

  assert.equal(overlay._particleByView.get('live'), replacement);
  assert.equal(overlay._pendingParticleRetirements.has(old), true);
  assert.equal(
    overlay._residentParticleBytes,
    old.bytes + replacement.bytes,
  );
  assert.equal(old.buffers[0], failedBuffer);

  overlay._flushPendingParticleRetirements();

  assert.equal(overlay._pendingParticleRetirements.size, 0);
  assert.equal(overlay._residentParticleBytes, replacement.bytes);
  assert.equal(deleteAttempts.get(failedBuffer), 2);
  assert.equal(
    [...deleteAttempts.entries()]
      .filter(([handle]) => handle !== failedBuffer)
      .every(([, count]) => count === 1),
    true,
  );
});

function createSimulationOverlay(gl) {
  return Object.assign(Object.create(VelocityOverlay.prototype), {
    gl,
    _programUpdate: { id: 'update-program' },
    _transformFeedback: { id: 'transform-feedback' },
    _uniformsUpdate: {
      u_dropChanceFast: {},
      u_dropChanceSlow: {},
      u_dt: {},
      u_forceRespawn: {},
      u_lifetime: {},
      u_positionTexWidth: {},
      u_spawnTableSize: {},
      u_spawnTableWidth: {},
      u_speedMultiplier: {},
      u_time: {},
      u_turbulence: {},
      u_velocityBlend: {},
      u_velocityTexWidth: {},
    },
    config: {
      dropRate: 0,
      dropRateBump: 0,
      lifetime: 1,
      speedMultiplier: 1,
      turbulence: 0,
    },
  });
}

test('velocity simulation advances each view-owned ping-pong generation at most once per frame', () => {
  const fixture = createSimulationGl();
  const overlay = createSimulationOverlay(fixture.gl);
  const live = createParticleState('live');
  const snapshot = createParticleState('snapshot');
  const field = { texture: {}, width: 2 };
  const positions = { texture: {}, width: 2 };
  const spawn = {
    generation: 1,
    tableSize: 2,
    tableWidth: 2,
    textureInfo: { texture: {} },
  };

  overlay._simulate(
    0.016,
    { frameId: 41, time: 1 },
    field,
    positions,
    spawn,
    live,
  );
  overlay._simulate(
    0.016,
    { frameId: 41, time: 1 },
    field,
    positions,
    spawn,
    snapshot,
  );
  overlay._simulate(
    0.016,
    { frameId: 41, time: 1 },
    field,
    positions,
    spawn,
    live,
  );

  assert.equal(live.currentBuffer, 1);
  assert.equal(snapshot.currentBuffer, 1);
  assert.equal(live.lastAdvancedFrameId, 41);
  assert.equal(snapshot.lastAdvancedFrameId, 41);
  assert.deepEqual(
    fixture.draws.map(({ boundOutput, boundVao, count }) => [
      boundOutput.id,
      boundVao.id,
      count,
    ]),
    [
      ['live-buffer-1', 'live-vao-0', 8],
      ['snapshot-buffer-1', 'snapshot-vao-0', 8],
    ],
  );
});

test('velocity camera motion history is isolated and elapsed-time normalized per view', () => {
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    config: {
      cameraMotionFade: 0.8,
      cameraMotionThreshold: 0.001,
      trailFade: 0.925,
    },
  });
  const live = createParticleState('live');
  const snapshot = createParticleState('snapshot');
  const identity = new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
  const liveContext = {
    cameraDistance: 10,
    cameraPosition: [0, 0, 10],
    viewMatrix: identity,
  };
  const snapshotContext = {
    cameraDistance: 10,
    cameraPosition: [10, 0, 10],
    viewMatrix: identity,
  };

  overlay._updateCameraMotion(liveContext, live, 1 / 60);
  overlay._updateCameraMotion(snapshotContext, snapshot, 1 / 60);
  overlay._updateCameraMotion(liveContext, live, 1 / 60);
  overlay._updateCameraMotion(snapshotContext, snapshot, 1 / 60);

  assert.equal(live.cameraMotionAmount, 0);
  assert.equal(snapshot.cameraMotionAmount, 0);

  const retentionAt30 = Array.from(
    { length: 30 },
    () => overlay._getEffectiveTrailFade(live, 1 / 30),
  ).reduce((product, value) => product * value, 1);
  const retentionAt60 = Array.from(
    { length: 60 },
    () => overlay._getEffectiveTrailFade(live, 1 / 60),
  ).reduce((product, value) => product * value, 1);
  const retentionAt144 = Array.from(
    { length: 144 },
    () => overlay._getEffectiveTrailFade(live, 1 / 144),
  ).reduce((product, value) => product * value, 1);

  assert.ok(Math.abs(retentionAt30 - retentionAt60) < 1e-12);
  assert.ok(Math.abs(retentionAt60 - retentionAt144) < 1e-12);
});

test('velocity camera-motion threshold and smoothing are refresh-rate invariant', () => {
  const createOverlay = () => Object.assign(
    Object.create(VelocityOverlay.prototype),
    {
      config: {
        cameraMotionFade: 0.8,
        cameraMotionThreshold: 0.001,
        trailFade: 0.925,
      },
    },
  );
  const identity = new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
  const simulateOneSecond = fps => {
    const overlay = createOverlay();
    const state = createParticleState(`camera-${fps}`);
    const context = {
      cameraDistance: 10,
      cameraPosition: [0, 0, 10],
      viewMatrix: identity,
    };
    overlay._updateCameraMotion(context, state, 0);
    for (let frame = 1; frame <= fps; frame++) {
      context.cameraPosition[0] = frame / fps;
      overlay._updateCameraMotion(context, state, 1 / fps);
    }
    return state.cameraMotionAmount;
  };

  const at30 = simulateOneSecond(30);
  const at60 = simulateOneSecond(60);
  const at144 = simulateOneSecond(144);

  assert.ok(Math.abs(at30 - at60) < 1e-12);
  assert.ok(Math.abs(at60 - at144) < 1e-12);
});

test('velocity simulation and complete trail aging preserve 60 Hz timing contracts', () => {
  assert.match(
    PARTICLE_UPDATE_VS,
    /dropChance = mix\(\s*u_dropChanceSlow,\s*u_dropChanceFast,\s*speedNorm/,
  );
  assert.match(
    PARTICLE_UPDATE_VS,
    /mix\(a_velocity, velocity, u_velocityBlend\)/,
  );
  assert.doesNotMatch(
    PARTICLE_UPDATE_VS,
    /pow\(|dropChance \* dt \* 60\.0|mix\(a_velocity, velocity, 0\.25\)/,
  );
  const simulationSource = VelocityOverlay.prototype._simulate.toString();
  assert.match(
    simulationSource,
    /normalizeVelocityDropChance\(this\.config\.dropRate, frameScale\)/,
  );
  assert.match(simulationSource, /1 - Math\.pow\(0\.75, frameScale\)/);

  assert.match(TRAIL_FADE_FS, /uniform float u_frameScale/);
  for (const factorUniform of [
    'u_fadeR',
    'u_fadeG',
    'u_fadeB',
    'u_fadeAlpha',
  ]) {
    assert.match(TRAIL_FADE_FS, new RegExp(`uniform float ${factorUniform}`));
  }
  assert.doesNotMatch(TRAIL_FADE_FS, /pow\(/);
  const passFadeSource = VelocityOverlay.prototype._passFade.toString();
  for (const calibratedFactor of ['0.025', '0.005', '0.035']) {
    assert.match(passFadeSource, new RegExp(`fadeAt60Hz[^;]*${calibratedFactor}`));
  }
  assert.match(passFadeSource, /Math\.min\(1,/);
  assert.doesNotMatch(
    TRAIL_FADE_FS,
    /ambientGlow|hdrBoost|temperatureShift|\+\s*ambient/,
  );
  assert.match(
    TRAIL_FADE_FS,
    /fragColor = vec4\(\s*prev\.r \* u_fadeR,\s*prev\.g \* u_fadeG,\s*prev\.b \* u_fadeB,\s*prev\.a \* u_fadeAlpha/,
  );
  assert.ok(
    TRAIL_FADE_FS.indexOf('if (u_frameScale <= 0.0)') <
      TRAIL_FADE_FS.indexOf('if (prev.a < 0.001)'),
  );

  for (const probability of [0, 0.003, 0.1, 0.2]) {
    const survivalAt30 = Math.pow(
      1 - (1 - Math.pow(1 - probability, 2)),
      30,
    );
    const survivalAt60 = Math.pow(1 - probability, 60);
    const survivalAt144 = Math.pow(
      1 - (1 - Math.pow(1 - probability, 60 / 144)),
      144,
    );
    assert.ok(Math.abs(survivalAt30 - survivalAt60) < 1e-12);
    assert.ok(Math.abs(survivalAt60 - survivalAt144) < 1e-12);
  }
});

test('extreme chromatic trail channels remain non-amplifying before elapsed-time normalization', () => {
  const uniforms = new Map();
  const gl = {
    BLEND: 0x0be2,
    DEPTH_TEST: 0x0b71,
    FRAMEBUFFER: 0x8d40,
    TEXTURE0: 0x84c0,
    TEXTURE_2D: 0x0de1,
    TRIANGLE_STRIP: 0x0005,
    activeTexture() {},
    bindFramebuffer() {},
    bindTexture() {},
    bindVertexArray() {},
    disable() {},
    drawArrays() {},
    uniform1f(location, value) {
      uniforms.set(location, value);
    },
    uniform1i() {},
    useProgram() {},
    viewport() {},
  };
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    config: {
      cameraMotionFade: 1,
      chromaticFade: 1,
      trailFade: 0.999,
    },
    gl,
    _fullscreenVAO: {},
    _programFade: {},
    _uniformsFade: {
      u_fadeAlpha: 'alpha',
      u_fadeB: 'blue',
      u_fadeG: 'green',
      u_fadeR: 'red',
      u_frameScale: 'frame-scale',
      u_previousFrame: 'previous',
    },
  });
  const fbos = {
    height: 1,
    trail: [{}, {}],
    trailFramebuffers: [{}, {}],
    trailIdx: 0,
    width: 1,
  };

  const channels = ['red', 'green', 'blue', 'alpha'];
  const oneSecondRetention = new Map();
  for (const fps of [30, 60, 144]) {
    uniforms.clear();
    overlay._passFade(
      fbos,
      1,
      { cameraMotionAmount: 0 },
      1 / fps,
    );
    oneSecondRetention.set(
      fps,
      channels.map(key => {
        const factor = uniforms.get(key);
        assert.ok(factor >= 0);
        assert.ok(factor <= 1);
        return Math.pow(factor, fps);
      }),
    );
  }
  assert.equal(oneSecondRetention.get(60)[0], 1);
  assert.equal(oneSecondRetention.get(60)[1], 1);
  assert.ok(oneSecondRetention.get(60)[2] < 1);
  assert.ok(oneSecondRetention.get(60)[3] < 1);
  for (let channel = 0; channel < channels.length; channel++) {
    const at30 = oneSecondRetention.get(30)[channel];
    const at60 = oneSecondRetention.get(60)[channel];
    const at144 = oneSecondRetention.get(144)[channel];
    assert.ok(at30 <= 1);
    assert.ok(Math.abs(at30 - at60) < 1e-12);
    assert.ok(Math.abs(at60 - at144) < 1e-12);
  }
});

test('a positive particle-count change force-initializes every active slot and clears trails', () => {
  const positions = new Float32Array([0, 0, 0]);
  const particle = {
    ...createParticleState('live', 8),
    capacity: 16,
    dimensionLevel: 3,
    fieldId: 'velocity',
    positionsRef: positions,
  };
  const spawn = {
    dirty: false,
    generation: 1,
    ready: true,
    tableSize: 1,
    tableWidth: 1,
    textureInfo: { texture: {} },
    visibilityTextureInfo: { texture: {}, width: 1 },
  };
  const disposed = [];
  const trails = { trailClearPending: false };
  let simulatedWithForceRespawn = false;
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    _activeFieldId: 'velocity',
    _fieldsById: new Map([
      ['velocity', new Map([[3, { cellCount: 1 }]])],
    ]),
    _fboByView: new Map([['live', trails]]),
    _particleByView: new Map([['live', particle]]),
    config: {
      particleCount: 12,
      syncWithLOD: false,
    },
    _ensureParticleState: () => particle,
    _ensurePositionTexture: () => ({ texture: {}, width: 1 }),
    _ensureSpawnTable: () => spawn,
    _disposeFBOs: viewId => disposed.push(viewId),
    _updateCameraMotion() {},
    _simulate(_dt, _ctx, _field, _positions, _spawn, state) {
      simulatedWithForceRespawn = state.forceRespawn;
    },
  });

  overlay._doUpdate(1 / 60, {
    dimensionLevel: 3,
    frameId: 7,
    getViewPositions: () => positions,
    time: 1,
    viewId: 'live',
  });

  assert.equal(particle.activeParticleCount, 12);
  assert.equal(simulatedWithForceRespawn, true);
  assert.equal(particle.lastAdvancedFrameId, -1);
  assert.deepEqual(disposed, []);
  assert.equal(overlay._fboByView.get('live'), trails);
  assert.equal(trails.trailClearPending, true);
});

test('field transitions reuse exact same-cell spawn ownership and inactive publication causes no view churn', () => {
  const spawn = {
    cellCount: 2,
    dimensionLevel: 3,
    dirty: false,
    ready: true,
    version: 4,
  };
  const particle = {
    ...createParticleState('live', 8),
    dimensionLevel: 3,
  };
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    _activeFieldId: 'field-a',
    _fboByView: new Map(),
    _fieldsById: new Map([
      ['field-a', new Map([[3, { cellCount: 2 }]])],
      ['field-b', new Map([[3, { cellCount: 2 }]])],
      ['field-c', new Map([[3, { cellCount: 3 }]])],
    ]),
    _particleByView: new Map([['live', particle]]),
    _spawnByView: new Map([['live', spawn]]),
  });

  overlay.setActiveField('field-b');

  assert.equal(overlay.getActiveFieldId(), 'field-b');
  assert.equal(spawn.dirty, false);
  assert.equal(spawn.ready, true);
  assert.equal(spawn.version, 4);
  assert.equal(particle.activeParticleCount, 0);
  assert.equal(particle.forceRespawn, true);

  overlay._invalidateActiveFieldDimension(3, 2);
  assert.equal(spawn.dirty, false);
  assert.equal(spawn.version, 4);

  overlay.setActiveField('field-c');

  assert.equal(spawn.dirty, true);
  assert.equal(spawn.ready, false);
  assert.equal(spawn.version, 5);

  const fixture = createPositionTextureGl();
  let activeInvalidations = 0;
  const publicationOverlay = Object.assign(
    Object.create(VelocityOverlay.prototype),
    {
      _activeFieldId: 'field-a',
      _disposed: false,
      _fieldsById: new Map([
        ['field-a', new Map([[3, { cellCount: 2, texture: {} }]])],
      ]),
      _initialized: true,
      _invalidateActiveFieldDimension() {
        activeInvalidations++;
      },
      gl: fixture.gl,
    },
  );
  publicationOverlay.setVectorFieldData('field-b', 3, {
    cellCount: 2,
    components: 3,
    maxMagnitude: 1,
    vectors: new Float32Array(6),
  });

  assert.equal(activeInvalidations, 0);
  assert.equal(
    publicationOverlay.hasFieldForDimension('field-b', 3),
    true,
  );
  assert.match(
    VelocityOverlay.prototype.setVectorFieldData.toString(),
    /texture: null/,
  );
  assert.match(
    VelocityOverlay.prototype.setVectorFieldData.toString(),
    /_queueDerivedTextureDelete/,
  );
  assert.doesNotMatch(
    VelocityOverlay.prototype.setVectorFieldData.toString(),
    /deleteTexture\(existing\.texture\)/,
  );
});

test('velocity field replacement publishes before retrying a delete-then-throw retirement', t => {
  const fixture = createPositionTextureGl();
  const existingTexture = fixture.gl.createTexture();
  fixture.gl.bindTexture(fixture.gl.TEXTURE_2D, existingTexture);
  const originalDeleteTexture = fixture.gl.deleteTexture;
  let failExistingOnce = true;
  fixture.gl.deleteTexture = texture => {
    originalDeleteTexture(texture);
    if (texture === existingTexture && failExistingOnce) {
      failExistingOnce = false;
      throw new Error('synthetic post-delete field retirement failure');
    }
  };
  const diagnostics = [];
  const originalConsoleError = console.error;
  console.error = error => diagnostics.push(error);
  t.after(() => {
    console.error = originalConsoleError;
  });
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    _activeFieldId: 'field-a',
    _disposed: false,
    _fieldsById: new Map([
      ['field-a', new Map([[
        3,
        {
          cellCount: 2,
          components: 3,
          height: 1,
          maxMagnitude: 1,
          texture: existingTexture,
          width: 2,
        },
      ]])],
    ]),
    _initialized: true,
    _pendingDerivedTextureDeletes: new Map(),
    _invalidateActiveFieldDimension() {},
    gl: fixture.gl,
  });

  assert.doesNotThrow(() => {
    overlay.setVectorFieldData('field-a', 3, {
      cellCount: 2,
      components: 3,
      maxMagnitude: 2,
      vectors: new Float32Array(6),
    });
  });

  const published = overlay._fieldsById.get('field-a').get(3);
  assert.notEqual(published.texture, existingTexture);
  assert.equal(fixture.textureBinding, published.texture);
  assert.equal(overlay._pendingDerivedTextureDeletes.has(existingTexture), true);
  assert.equal(diagnostics.length, 1);

  const retryFailures = overlay._flushPendingDerivedTextureDeletes();

  assert.equal(retryFailures, null);
  assert.equal(overlay._pendingDerivedTextureDeletes.size, 0);
  assert.equal(
    fixture.deletedTextures.filter(
      texture => texture === existingTexture
    ).length,
    2,
  );
});

test('null velocity field retires derived view textures and same-null publication retries failures', () => {
  const positionTexture = { id: 'position' };
  const spawnTexture = { id: 'spawn' };
  const visibilityTexture = { id: 'visibility' };
  const vectorTexture = { id: 'vector-source' };
  const deleteCalls = [];
  let failVisibilityOnce = true;
  const positions = new Float32Array([0, 0, 0]);
  const positionEntry = {
    refs: 1,
    source: positions,
    textureInfo: {
      components: 3,
      height: 1,
      texture: positionTexture,
      width: 1,
    },
  };
  const spawn = {
    building: false,
    buildToken: null,
    dirty: false,
    generation: 2,
    notificationId: null,
    ready: true,
    tableSize: 1,
    tableWidth: 1,
    textureInfo: {
      height: 1,
      texture: spawnTexture,
      width: 1,
    },
    version: 2,
    visibilityTextureInfo: {
      components: 1,
      height: 1,
      texture: visibilityTexture,
      width: 1,
    },
  };
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    _activeFieldId: 'field-a',
    _fboByView: new Map(),
    _fieldsById: new Map([
      ['field-a', new Map([[3, { texture: vectorTexture }]])],
    ]),
    _particleByView: new Map(),
    _pendingDerivedTextureDeletes: new Map(),
    _pendingFBORetirements: new Set(),
    _pendingParticleRetirements: new Set(),
    _positionTexturePool: new Map([[positions, positionEntry]]),
    _positionsRefByView: new Map([['live', positionEntry]]),
    _residentFBOBytes: 0n,
    _residentParticleBytes: 0n,
    _spawnByView: new Map([['live', spawn]]),
    gl: {
      deleteTexture(texture) {
        deleteCalls.push(texture);
        if (texture === visibilityTexture && failVisibilityOnce) {
          failVisibilityOnce = false;
          throw new Error('synthetic inactive visibility deletion failure');
        }
      },
    },
  });

  assert.throws(
    () => overlay.setActiveField(null),
    /synthetic inactive visibility deletion failure/,
  );

  assert.equal(overlay.getActiveFieldId(), null);
  assert.equal(overlay._fieldsById.get('field-a').get(3).texture, vectorTexture);
  assert.equal(overlay._positionTexturePool.size, 0);
  assert.equal(overlay._positionsRefByView.size, 0);
  assert.equal(spawn.textureInfo, null);
  assert.equal(spawn.visibilityTextureInfo, null);
  assert.equal(overlay._pendingDerivedTextureDeletes.size, 1);

  overlay.setActiveField(null);

  assert.equal(overlay._pendingDerivedTextureDeletes.size, 0);
  assert.equal(
    deleteCalls.filter(texture => texture === visibilityTexture).length,
    2,
  );
  assert.equal(
    deleteCalls.filter(texture => texture === positionTexture).length,
    1,
  );
  assert.equal(
    deleteCalls.filter(texture => texture === spawnTexture).length,
    1,
  );
  assert.equal(deleteCalls.includes(vectorTexture), false);
});

function createPositionTextureGl() {
  let nextTextureId = 1;
  let textureBinding = null;
  let unpackAlignment = 4;
  let pixelUnpackBuffer = { id: 'caller-pbo' };
  const deletedTextures = [];
  const uploadedRows = [];
  const gl = {
    CLAMP_TO_EDGE: 0x812f,
    FLOAT: 0x1406,
    MAX_TEXTURE_SIZE: 0x0d33,
    NEAREST: 0x2600,
    NO_ERROR: 0,
    PIXEL_UNPACK_BUFFER: 0x88ec,
    PIXEL_UNPACK_BUFFER_BINDING: 0x88ef,
    R32F: 0x822e,
    RED: 0x1903,
    RG32F: 0x8230,
    RG: 0x8227,
    RGB32F: 0x8815,
    RGB: 0x1907,
    RGBA32F: 0x8814,
    RGBA: 0x1908,
    TEXTURE_2D: 0x0de1,
    TEXTURE_BINDING_2D: 0x8069,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    UNPACK_ALIGNMENT: 0x0cf5,
    bindBuffer(target, value) {
      assert.equal(target, this.PIXEL_UNPACK_BUFFER);
      pixelUnpackBuffer = value;
    },
    bindTexture(target, value) {
      assert.equal(target, this.TEXTURE_2D);
      textureBinding = value;
    },
    createTexture() {
      return { id: `position-${nextTextureId++}` };
    },
    deleteTexture(texture) {
      deletedTextures.push(texture);
    },
    getError() {
      return this.NO_ERROR;
    },
    getParameter(parameter) {
      if (parameter === this.MAX_TEXTURE_SIZE) return 4096;
      if (parameter === this.TEXTURE_BINDING_2D) return textureBinding;
      if (parameter === this.UNPACK_ALIGNMENT) return unpackAlignment;
      if (parameter === this.PIXEL_UNPACK_BUFFER_BINDING) {
        return pixelUnpackBuffer;
      }
      throw new RangeError(`Unexpected parameter ${parameter}.`);
    },
    isTexture(texture) {
      return texture !== null && typeof texture === 'object';
    },
    pixelStorei(parameter, value) {
      assert.equal(parameter, this.UNPACK_ALIGNMENT);
      unpackAlignment = value;
    },
    texImage2D() {},
    texParameteri() {},
    texSubImage2D(
      _target,
      _level,
      _x,
      _y,
      _width,
      _height,
      _format,
      _type,
      row,
    ) {
      uploadedRows.push(Array.from(row));
    },
  };
  return {
    deletedTextures,
    gl,
    get textureBinding() {
      return textureBinding;
    },
    uploadedRows,
  };
}

test('shared position-array mutation republishes one view without corrupting snapshot GPU ownership', () => {
  const fixture = createPositionTextureGl();
  const positions = new Float32Array([0, 1, 2, 3, 4, 5]);
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    gl: fixture.gl,
    _fboByView: new Map(),
    _particleByView: new Map(),
    _pendingDerivedTextureDeletes: new Map(),
    _positionTexturePool: new Map(),
    _positionsRefByView: new Map(),
    _residentFBOBytes: 0n,
    _spawnByView: new Map(),
  });

  const oldTexture = overlay._ensurePositionTexture('live', positions);
  const sharedTexture = overlay._ensurePositionTexture('snap_1', positions);
  const oldEntry = overlay._positionsRefByView.get('snap_1');
  assert.equal(sharedTexture, oldTexture);
  assert.equal(oldEntry.refs, 2);

  positions[0] = 42;
  overlay.markGeometryDirty('live');

  assert.equal(oldEntry.refs, 1);
  assert.equal(overlay._positionsRefByView.get('snap_1'), oldEntry);
  assert.equal(overlay._positionTexturePool.has(positions), false);
  assert.equal(fixture.deletedTextures.includes(oldTexture.texture), false);

  const newTexture = overlay._ensurePositionTexture('live', positions);
  const newEntry = overlay._positionsRefByView.get('live');
  assert.notEqual(newTexture.texture, oldTexture.texture);
  assert.notEqual(newEntry, oldEntry);
  assert.equal(newEntry.refs, 1);
  assert.equal(overlay._positionTexturePool.get(positions), newEntry);
  assert.equal(fixture.uploadedRows.at(-1)[0], 42);
  assert.equal(fixture.deletedTextures.includes(oldTexture.texture), false);
});

test('dimension-only sampling invalidation retains and reuses the exact position texture generation', () => {
  const fixture = createPositionTextureGl();
  const positions = new Float32Array([0, 1, 2, 3, 4, 5]);
  const spawn = {
    dirty: false,
    ready: true,
    version: 2,
  };
  const trails = { trailClearPending: false };
  const particle = createParticleState('live');
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    gl: fixture.gl,
    _fboByView: new Map([['live', trails]]),
    _particleByView: new Map([['live', particle]]),
    _pendingDerivedTextureDeletes: new Map(),
    _positionTexturePool: new Map(),
    _positionsRefByView: new Map(),
    _spawnByView: new Map([['live', spawn]]),
  });

  const textureInfo = overlay._ensurePositionTexture('live', positions);
  const uploadedRowCount = fixture.uploadedRows.length;
  const entry = overlay._positionsRefByView.get('live');

  overlay.markDimensionDirty('live');
  const reused = overlay._ensurePositionTexture('live', positions);

  assert.equal(reused, textureInfo);
  assert.equal(overlay._positionsRefByView.get('live'), entry);
  assert.equal(overlay._positionTexturePool.get(positions), entry);
  assert.equal(entry.refs, 1);
  assert.equal(fixture.uploadedRows.length, uploadedRowCount);
  assert.deepEqual(fixture.deletedTextures, []);
  assert.equal(overlay._pendingDerivedTextureDeletes.size, 0);
  assert.equal(spawn.dirty, true);
  assert.equal(spawn.ready, false);
  assert.equal(spawn.version, 3);
  assert.equal(particle.activeParticleCount, 0);
  assert.equal(trails.trailClearPending, true);
});

test('geometry retirement failure remains byte-accounted and retryable without aborting invalidation', t => {
  const fixture = createPositionTextureGl();
  const positions = new Float32Array([0, 1, 2, 3, 4, 5]);
  const textureInfo = {
    components: 3,
    height: 1,
    texture: { id: 'retained-position' },
    width: 2,
  };
  const entry = {
    refs: 1,
    source: positions,
    textureInfo,
  };
  let failOnce = true;
  let deleteCalls = 0;
  fixture.gl.deleteTexture = texture => {
    assert.equal(texture, textureInfo.texture);
    deleteCalls++;
    if (failOnce) {
      failOnce = false;
      throw new Error('synthetic position retirement failure');
    }
  };
  const diagnostics = [];
  const originalConsoleError = console.error;
  console.error = error => diagnostics.push(error);
  t.after(() => {
    console.error = originalConsoleError;
  });
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    gl: fixture.gl,
    _fboByView: new Map(),
    _particleByView: new Map(),
    _pendingDerivedTextureDeletes: new Map(),
    _positionTexturePool: new Map([[positions, entry]]),
    _positionsRefByView: new Map([['live', entry]]),
    _spawnByView: new Map(),
  });

  assert.doesNotThrow(() => overlay.markGeometryDirty('live'));

  assert.equal(overlay._positionsRefByView.has('live'), false);
  assert.equal(overlay._positionTexturePool.has(positions), false);
  assert.equal(
    overlay._pendingDerivedTextureDeletes.get(textureInfo.texture),
    24n,
  );
  assert.equal(overlay._getResidentDerivedTextureBytes(), 24n);
  assert.equal(diagnostics.length, 1);

  assert.equal(overlay._flushPendingDerivedTextureDeletes(), null);
  assert.equal(overlay._pendingDerivedTextureDeletes.size, 0);
  assert.equal(overlay._getResidentDerivedTextureBytes(), 0n);
  assert.equal(deleteCalls, 2);
});

test('view disposal detaches derived state while retaining failed texture ownership for retry', () => {
  const spawnTexture = { id: 'spawn' };
  const visibilityTexture = { id: 'visibility' };
  const spawn = {
    notificationId: null,
    ready: true,
    textureInfo: {
      height: 1,
      texture: spawnTexture,
      width: 2,
    },
    version: 1,
    visibilityTextureInfo: {
      height: 1,
      texture: visibilityTexture,
      width: 2,
    },
  };
  let failOnce = true;
  const deleteCalls = new Map();
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    gl: {
      deleteTexture(texture) {
        deleteCalls.set(texture, (deleteCalls.get(texture) ?? 0) + 1);
        if (texture === spawnTexture && failOnce) {
          failOnce = false;
          throw new Error('synthetic disposed spawn retirement failure');
        }
      },
    },
    _fboByView: new Map(),
    _particleByView: new Map(),
    _pendingDerivedTextureDeletes: new Map(),
    _pendingFBORetirements: new Set(),
    _pendingParticleRetirements: new Set(),
    _positionTexturePool: new Map(),
    _positionsRefByView: new Map(),
    _spawnByView: new Map([['live', spawn]]),
  });

  assert.throws(
    () => overlay.disposeView('live'),
    /synthetic disposed spawn retirement failure/,
  );

  assert.equal(overlay._spawnByView.has('live'), false);
  assert.equal(
    overlay._pendingDerivedTextureDeletes.get(spawnTexture),
    8n,
  );
  assert.equal(
    overlay._pendingDerivedTextureDeletes.has(visibilityTexture),
    false,
  );

  assert.equal(overlay._flushPendingDerivedTextureDeletes(), null);
  assert.equal(overlay._pendingDerivedTextureDeletes.size, 0);
  assert.equal(deleteCalls.get(spawnTexture), 2);
  assert.equal(deleteCalls.get(visibilityTexture), 1);
});

test('disable retires every derived view texture exactly and retries failed deletion before re-enable', () => {
  const positionTexture = { id: 'position' };
  const spawnTexture = { id: 'spawn' };
  const visibilityTexture = { id: 'visibility' };
  const deleteCalls = [];
  let failVisibilityOnce = true;
  const positionEntry = {
    refs: 1,
    source: new Float32Array(6),
    textureInfo: {
      components: 3,
      height: 1,
      texture: positionTexture,
      width: 2,
    },
  };
  const spawn = {
    building: false,
    dirty: false,
    generation: 1,
    notificationId: null,
    ready: true,
    tableSize: 2,
    tableWidth: 2,
    textureInfo: {
      height: 1,
      texture: spawnTexture,
      width: 2,
    },
    version: 1,
    visibilityTextureInfo: {
      components: 1,
      height: 1,
      texture: visibilityTexture,
      width: 2,
    },
  };
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    enabled: true,
    gl: {
      deleteTexture(texture) {
        deleteCalls.push(texture);
        if (texture === visibilityTexture && failVisibilityOnce) {
          failVisibilityOnce = false;
          throw new Error('synthetic visibility deletion failure');
        }
      },
    },
    _disposePending: false,
    _disposed: false,
    _fboByView: new Map(),
    _fieldsById: new Map(),
    _initialized: true,
    _particleByView: new Map(),
    _pendingFBORetirements: new Set(),
    _pendingParticleRetirements: new Set(),
    _positionTexturePool: new Map([
      [positionEntry.source, positionEntry],
    ]),
    _positionsRefByView: new Map([['live', positionEntry]]),
    _pendingDerivedTextureDeletes: new Map(),
    _residentFBOBytes: 0n,
    _residentParticleBytes: 0n,
    _spawnByView: new Map([['live', spawn]]),
  });

  assert.equal(overlay._getResidentDerivedTextureBytes(), 40n);
  assert.throws(
    () => overlay.setEnabled(false),
    /synthetic visibility deletion failure/,
  );

  assert.equal(overlay.enabled, false);
  assert.equal(overlay._positionTexturePool.size, 0);
  assert.equal(overlay._positionsRefByView.size, 0);
  assert.equal(spawn.textureInfo, null);
  assert.equal(spawn.visibilityTextureInfo, null);
  assert.equal(spawn.tableSize, 0);
  assert.equal(spawn.ready, false);
  assert.equal(spawn.version, 2);
  assert.equal(overlay._getResidentDerivedTextureBytes(), 8n);

  overlay.setEnabled(false);

  assert.equal(overlay._getResidentDerivedTextureBytes(), 0n);
  assert.equal(spawn.version, 2);
  assert.equal(
    deleteCalls.filter(texture => texture === visibilityTexture).length,
    2,
  );

  overlay.setEnabled(true);

  assert.equal(overlay.enabled, true);
  assert.equal(spawn.dirty, true);
  assert.equal(spawn.ready, false);
  assert.equal(spawn.version, 3);
});

test('viewer settles velocity preparation and context construction failures, including non-rendering branches', () => {
  const renderStart = viewerSource.indexOf('  function render() {');
  const renderEnd = viewerSource.indexOf(
    '\n\t\t  function renderSingleView(',
    renderStart,
  );
  assert.ok(renderStart >= 0 && renderEnd > renderStart);
  const renderSource = viewerSource.slice(renderStart, renderEnd);
  assert.equal(
    (renderSource.match(
      /prepareVelocityFrame\(_renderVelocityViewIds\)/g,
    ) ?? []).length,
    5,
  );
  assert.doesNotMatch(
    renderSource,
    /vectorFieldOverlay\.prepareFrame/,
  );

  const singleStart = viewerSource.indexOf(
    '\t\t  function renderSingleView(',
    renderEnd,
  );
  const singleEnd = viewerSource.indexOf(
    '\n    // Draw highlights',
    singleStart,
  );
  const singleSource = viewerSource.slice(singleStart, singleEnd);
  assert.match(
    singleSource,
    /try \{\s*overlayCtx = buildOverlayContext\(overlayOpts\)/,
  );
  assert.match(
    singleSource,
    /catch \(error\) \{\s*settleVelocityRenderFailure\(error\)/,
  );
  assert.match(
    singleSource,
    /if \(overlayCtx !== null\) \{\s*overlayOpts\.target = overlayCtx/,
  );
});

test('dirty or empty visibility generations cannot render stale velocity particles', () => {
  const particle = createParticleState('live');
  particle.activeParticleCount = 15_000;
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    _activeFieldId: 'velocity',
    _fieldsById: new Map([
      ['velocity', new Map([[3, {}]])],
    ]),
    _particleByView: new Map([['live', particle]]),
    _spawnByView: new Map([
      ['live', {
        dirty: false,
        generation: 3,
        ready: true,
        tableSize: 12,
        textureInfo: { texture: {} },
        visibilityTextureInfo: { texture: {}, width: 4 },
        version: 3,
      }],
    ]),
    _fboByView: new Map([[
      'live',
      { id: 'old-trails', trailClearPending: false },
    ]]),
    _disposeFBOs(viewId) {
      this._fboByView.delete(viewId);
    },
    _renderFlow() {
      throw new Error('stale visibility generation rendered');
    },
  });

  overlay.markVisibilityDirty('live');
  overlay._doRender({ dimensionLevel: 3, viewId: 'live' });

  assert.equal(overlay._spawnByView.get('live').ready, false);
  assert.equal(particle.activeParticleCount, 0);
  assert.equal(particle.forceRespawn, true);
  assert.equal(overlay._fboByView.has('live'), true);
  assert.equal(
    overlay._fboByView.get('live').trailClearPending,
    true,
  );

  const spawn = overlay._spawnByView.get('live');
  spawn.dirty = false;
  spawn.ready = true;
  spawn.generation = spawn.version;
  spawn.tableSize = 0;
  spawn.textureInfo = null;
  spawn.visibilityTextureInfo = null;

  overlay._doRender({ dimensionLevel: 3, viewId: 'live' });
});

test('committed empty visibility retires the prior full-resolution trail generation', () => {
  const fboBytes = 188_743_680n;
  const generation = {
    bloom: [],
    bloomFramebuffers: [],
    bytes: fboBytes,
    trail: [],
    trailFramebuffers: [],
  };
  const spawn = {
    dirty: false,
    ready: true,
    tableSize: 0,
    textureInfo: null,
    visibilityTextureInfo: null,
  };
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    _activeFieldId: 'velocity',
    _fieldsById: new Map([
      ['velocity', new Map([[3, { cellCount: 1 }]])],
    ]),
    _fboByView: new Map([['live', generation]]),
    _particleByView: new Map([['live', createParticleState('live')]]),
    _pendingFBORetirements: new Set(),
    _residentFBOBytes: fboBytes,
    config: {
      particleCount: 15_000,
      syncWithLOD: false,
    },
    gl: {
      deleteFramebuffer() {},
      deleteTexture() {},
    },
    _disposeParticleState(viewId) {
      this._particleByView.delete(viewId);
    },
    _ensurePositionTexture() {
      return { texture: {}, width: 1 };
    },
    _ensureSpawnTable() {
      return spawn;
    },
  });

  overlay._doUpdate(1 / 60, {
    dimensionLevel: 3,
    frameId: 1,
    getViewPositions: () => new Float32Array(3),
    viewId: 'live',
  });

  assert.equal(overlay._particleByView.has('live'), false);
  assert.equal(overlay._fboByView.has('live'), false);
  assert.equal(overlay._pendingFBORetirements.size, 0);
  assert.equal(overlay._residentFBOBytes, 0n);
});

test('velocity frame residency evicts every dormant render target before the next view allocates', () => {
  const disposed = [];
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    _contextLost: false,
    _fboByView: new Map([
      ['live', { bytes: 100n }],
      ['snap_1', { bytes: 200n }],
      ['snap_2', { bytes: 300n }],
    ]),
    _particleByView: new Map(),
    _residentFBOBytes: 600n,
    _disposeFBOs(viewId) {
      const generation = this._fboByView.get(viewId);
      if (!generation) return;
      disposed.push(viewId);
      this._residentFBOBytes -= generation.bytes;
      this._fboByView.delete(viewId);
    },
  });

  overlay.prepareFrame(['snap_2']);

  assert.deepEqual(disposed, ['live', 'snap_1']);
  assert.deepEqual(Array.from(overlay._fboByView.keys()), ['snap_2']);
  assert.equal(overlay._residentFBOBytes, 300n);
  assert.doesNotMatch(
    VelocityOverlay.prototype.prepareFrame.toString(),
    /Array\.from|const failures = \[\]|=>\s*viewIds\.includes/,
  );
});

test('velocity context loss fences pending idle spawn publication without GL churn', () => {
  let scheduled = null;
  let glCalls = 0;
  const originalRequestIdleCallback = globalThis.requestIdleCallback;
  globalThis.requestIdleCallback = callback => {
    scheduled = callback;
    return 1;
  };
  const spawn = {
    building: false,
    dirty: true,
    generation: 1,
    lastLod: null,
    notificationId: null,
    ready: true,
    tableSize: 1,
    tableWidth: 1,
    textureInfo: { texture: { id: 'old-spawn' } },
    version: 1,
    visibilityTextureInfo: {
      texture: { id: 'old-visibility' },
      width: 1,
    },
  };
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    gl: new Proxy({}, {
      get() {
        return () => {
          glCalls += 1;
          throw new Error('lost context received a GL call');
        };
      },
    }),
    config: {
      spawnTableSize: 8,
      syncWithLOD: false,
    },
    _contextLost: false,
    _disposed: false,
    _fboByView: new Map(),
    _particleByView: new Map(),
    _pendingFBORetirements: new Set(),
    _pendingParticleRetirements: new Set(),
    _pendingDerivedTextureDeletes: new Map(),
    _positionTexturePool: new Map(),
    _positionsRefByView: new Map(),
    _residentFBOBytes: 0n,
    _residentParticleBytes: 0n,
    _spawnByView: new Map([['live', spawn]]),
  });

  try {
    overlay._ensureSpawnTable(
      'live',
      {
        getLodIndices: () => null,
        getLodLevel: () => -1,
        getViewTransparency: () => new Float32Array([1]),
      },
      1,
    );
    assert.equal(typeof scheduled, 'function');

    overlay.handleContextLost();
    scheduled();

    assert.equal(glCalls, 0);
    assert.equal(overlay._contextLost, true);
    assert.equal(overlay._fboByView.size, 0);
    assert.equal(overlay._particleByView.size, 0);
    assert.equal(spawn.ready, false);
  } finally {
    if (originalRequestIdleCallback === undefined) {
      delete globalThis.requestIdleCallback;
    } else {
      globalThis.requestIdleCallback = originalRequestIdleCallback;
    }
  }
});

test('velocity context loss fences every spawn owner even when one notification dismissal fails', t => {
  const notifications = getNotificationCenter();
  const originalDismiss = notifications.dismiss;
  const dismissCalls = [];
  notifications.dismiss = id => {
    dismissCalls.push(id);
    if (id === 'first') {
      throw new Error('synthetic context-loss dismissal failure');
    }
    return true;
  };
  t.after(() => {
    notifications.dismiss = originalDismiss;
  });
  const createSpawn = notificationId => ({
    buildToken: {},
    building: true,
    dirty: false,
    notificationId,
    ready: true,
    tableSize: 2,
    tableWidth: 2,
    textureInfo: { texture: {} },
    version: 1,
    visibilityTextureInfo: { texture: {} },
  });
  const first = createSpawn('first');
  const second = createSpawn('second');
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    _colormapTexture: { kind: 'invalid-colormap' },
    _contextLost: false,
    _fboByView: new Map([['live', {}]]),
    _particleByView: new Map([['live', {}]]),
    _pendingDerivedTextureDeletes: new Map([[{}, 4n]]),
    _pendingFBORetirements: new Set([{}]),
    _pendingParticleRetirements: new Set([{}]),
    _positionTexturePool: new Map([[new Float32Array(0), {}]]),
    _positionsRefByView: new Map([['live', {}]]),
    _residentFBOBytes: 10n,
    _residentParticleBytes: 20n,
    _spawnByView: new Map([
      ['live', first],
      ['snap_1', second],
    ]),
  });

  assert.throws(
    () => overlay.handleContextLost(),
    /synthetic context-loss dismissal failure/,
  );

  assert.deepEqual(dismissCalls, ['first', 'second']);
  for (const spawn of [first, second]) {
    assert.equal(spawn.buildToken, null);
    assert.equal(spawn.building, false);
    assert.equal(spawn.dirty, true);
    assert.equal(spawn.notificationId, null);
    assert.equal(spawn.ready, false);
    assert.equal(spawn.tableSize, 0);
    assert.equal(spawn.textureInfo, null);
    assert.equal(spawn.visibilityTextureInfo, null);
  }
  assert.equal(overlay._contextLost, true);
  assert.equal(overlay._fboByView.size, 0);
  assert.equal(overlay._particleByView.size, 0);
  assert.equal(overlay._pendingDerivedTextureDeletes.size, 0);
  assert.equal(overlay._pendingFBORetirements.size, 0);
  assert.equal(overlay._pendingParticleRetirements.size, 0);
  assert.equal(overlay._positionTexturePool.size, 0);
  assert.equal(overlay._positionsRefByView.size, 0);
  assert.equal(overlay._colormapTexture, null);
  assert.equal(overlay._residentFBOBytes, 0n);
  assert.equal(overlay._residentParticleBytes, 0n);
});
