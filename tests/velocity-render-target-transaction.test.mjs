import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeVelocityRenderTargetLayout,
  VelocityOverlay,
} from '../assets/js/rendering/overlays/velocity/velocity-overlay.js';

function createRenderTargetGl({ nullTextureAt = -1 } = {}) {
  const nullTextureCreates = new Set(
    Array.isArray(nullTextureAt) ? nullTextureAt : [nullTextureAt],
  );
  let nextId = 1;
  let textureCreates = 0;
  let activeTexture = 0x84c3;
  let texture = { kind: 'caller-texture', id: 100 };
  let pixelUnpackBuffer = { kind: 'caller-pbo', id: 101 };
  let drawFramebuffer = { kind: 'caller-draw-fbo', id: 102 };
  let readFramebuffer = { kind: 'caller-read-fbo', id: 103 };
  let viewport = [7, 8, 9, 10];
  let scissorBox = [11, 12, 13, 14];
  let scissorEnabled = true;
  let colorMask = [false, true, false, true];
  let error = 0;
  const deletedFramebuffers = [];
  const deletedTextures = [];
  const attachments = [];
  const clears = [];
  const gl = {
    ACTIVE_TEXTURE: 0x84e0,
    CLAMP_TO_EDGE: 0x812f,
    COLOR: 0x1800,
    COLOR_ATTACHMENT0: 0x8ce0,
    COLOR_WRITEMASK: 0x0c23,
    DRAW_FRAMEBUFFER: 0x8ca9,
    DRAW_FRAMEBUFFER_BINDING: 0x8ca6,
    FRAMEBUFFER: 0x8d40,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    HALF_FLOAT: 0x140b,
    LINEAR: 0x2601,
    MAX_TEXTURE_SIZE: 0x0d33,
    MAX_VIEWPORT_DIMS: 0x0d3a,
    NO_ERROR: 0,
    PIXEL_UNPACK_BUFFER: 0x88ec,
    PIXEL_UNPACK_BUFFER_BINDING: 0x88ef,
    READ_FRAMEBUFFER: 0x8ca8,
    READ_FRAMEBUFFER_BINDING: 0x8caa,
    RGBA: 0x1908,
    RGBA16F: 0x881a,
    RGBA32F: 0x8814,
    RGBA8: 0x8058,
    SCISSOR_BOX: 0x0c10,
    SCISSOR_TEST: 0x0c11,
    TEXTURE0: 0x84c0,
    TEXTURE_2D: 0x0de1,
    TEXTURE_BINDING_2D: 0x8069,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    UNSIGNED_BYTE: 0x1401,
    VIEWPORT: 0x0ba2,
    activeTexture(value) {
      activeTexture = value;
    },
    bindBuffer(target, value) {
      assert.equal(target, this.PIXEL_UNPACK_BUFFER);
      pixelUnpackBuffer = value;
    },
    bindFramebuffer(target, value) {
      if (target === this.FRAMEBUFFER) {
        drawFramebuffer = value;
        readFramebuffer = value;
      } else if (target === this.DRAW_FRAMEBUFFER) {
        drawFramebuffer = value;
      } else if (target === this.READ_FRAMEBUFFER) {
        readFramebuffer = value;
      } else {
        throw new RangeError(`Unexpected framebuffer target ${target}.`);
      }
    },
    bindTexture(target, value) {
      assert.equal(target, this.TEXTURE_2D);
      texture = value;
    },
    checkFramebufferStatus() {
      return this.FRAMEBUFFER_COMPLETE;
    },
    clearBufferfv(target, drawBuffer, value) {
      clears.push({
        colorMask: colorMask.slice(),
        drawBuffer,
        framebuffer: drawFramebuffer,
        scissorEnabled,
        target,
        value: Array.from(value),
        viewport: viewport.slice(),
      });
    },
    colorMask(...value) {
      colorMask = value;
    },
    createFramebuffer() {
      return { kind: 'framebuffer', id: nextId++ };
    },
    createTexture() {
      textureCreates += 1;
      if (nullTextureCreates.has(textureCreates)) return null;
      return { kind: 'texture', id: nextId++ };
    },
    deleteFramebuffer(value) {
      deletedFramebuffers.push(value);
    },
    deleteTexture(value) {
      deletedTextures.push(value);
    },
    disable(capability) {
      assert.equal(capability, this.SCISSOR_TEST);
      scissorEnabled = false;
    },
    enable(capability) {
      assert.equal(capability, this.SCISSOR_TEST);
      scissorEnabled = true;
    },
    framebufferTexture2D(
      target,
      attachment,
      textureTarget,
      value,
      level,
    ) {
      attachments.push({
        attachment,
        framebuffer: drawFramebuffer,
        level,
        target,
        texture: value,
        textureTarget,
      });
    },
    getError() {
      const result = error;
      error = this.NO_ERROR;
      return result;
    },
    getParameter(parameter) {
      if (parameter === this.ACTIVE_TEXTURE) return activeTexture;
      if (parameter === this.COLOR_WRITEMASK) return colorMask.slice();
      if (parameter === this.DRAW_FRAMEBUFFER_BINDING) {
        return drawFramebuffer;
      }
      if (parameter === this.MAX_TEXTURE_SIZE) return 4096;
      if (parameter === this.MAX_VIEWPORT_DIMS) {
        return new Int32Array([4096, 4096]);
      }
      if (parameter === this.PIXEL_UNPACK_BUFFER_BINDING) {
        return pixelUnpackBuffer;
      }
      if (parameter === this.READ_FRAMEBUFFER_BINDING) {
        return readFramebuffer;
      }
      if (parameter === this.SCISSOR_BOX) return scissorBox.slice();
      if (parameter === this.TEXTURE_BINDING_2D) return texture;
      if (parameter === this.VIEWPORT) return viewport.slice();
      throw new RangeError(`Unexpected WebGL parameter ${parameter}.`);
    },
    isEnabled(capability) {
      assert.equal(capability, this.SCISSOR_TEST);
      return scissorEnabled;
    },
    scissor(...value) {
      scissorBox = value;
    },
    texParameteri() {},
    texStorage2D() {},
    viewport(...value) {
      viewport = value;
    },
  };
  const readState = () => ({
    activeTexture,
    colorMask: colorMask.slice(),
    drawFramebuffer,
    pixelUnpackBuffer,
    readFramebuffer,
    scissorBox: scissorBox.slice(),
    scissorEnabled,
    texture,
    viewport: viewport.slice(),
  });
  return {
    attachments,
    clears,
    deletedFramebuffers,
    deletedTextures,
    gl,
    readState,
  };
}

function createOverlay(gl) {
  return Object.assign(Object.create(VelocityOverlay.prototype), {
    gl,
    config: {
      bloomEnabled: true,
      bloomStrength: 0.08,
      renderTargetByteBudget: 256 * 1024 * 1024,
      trailResolution: 1,
    },
    _activeRenderViewCount: 1,
    _contextLost: false,
    _fboByView: new Map(),
    _particleByView: new Map(),
    _pendingFBORetirements: new Set(),
    _renderTargetLimits: Object.freeze({
      maxTextureSize: 4096,
      maxViewportHeight: 4096,
      maxViewportWidth: 4096,
    }),
    _residentFBOBytes: 0n,
    _textureFormat: Object.freeze({
      bytesPerPixel: 8,
      format: gl.RGBA,
      internal: gl.RGBA16F,
      type: gl.HALF_FLOAT,
    }),
  });
}

function createOldGeneration() {
  return {
    bloom: [
      { kind: 'old-bloom-texture', id: 1 },
      { kind: 'old-bloom-texture', id: 2 },
    ],
    bloomEnabled: true,
    bloomFramebuffers: [
      { kind: 'old-bloom-fbo', id: 3 },
      { kind: 'old-bloom-fbo', id: 4 },
    ],
    bloomHeight: 50,
    bloomWidth: 50,
    bytes: 200_000n,
    height: 100,
    rasterScale: 1,
    trail: [
      { kind: 'old-trail-texture', id: 5 },
      { kind: 'old-trail-texture', id: 6 },
    ],
    trailFramebuffers: [
      { kind: 'old-trail-fbo', id: 7 },
      { kind: 'old-trail-fbo', id: 8 },
    ],
    trailIdx: 1,
    width: 100,
  };
}

test('velocity render-target layout preserves aspect, caps hardware limits, and counts exact bytes', () => {
  const layout = computeVelocityRenderTargetLayout({
    bloomEnabled: true,
    byteBudget: 256 * 1024 * 1024,
    bytesPerPixel: 8,
    maxTextureSize: 4096,
    maxViewportHeight: 4096,
    maxViewportWidth: 4096,
    resolution: 2,
    viewportHeight: 2160,
    viewportWidth: 3840,
  });

  assert.deepEqual(layout, {
    bloomEnabled: true,
    bloomHeight: 1152,
    bloomWidth: 2048,
    bytes: 188_743_680n,
    height: 2304,
    rasterScale: 2304 / 2160,
    width: 4096,
  });
});

test('4K velocity targets cap exact float+bloom residency to the byte budget', () => {
  const byteBudget = 64 * 1024 * 1024;
  const layout = computeVelocityRenderTargetLayout({
    bloomEnabled: true,
    byteBudget,
    bytesPerPixel: 8,
    maxTextureSize: 16_384,
    maxViewportHeight: 16_384,
    maxViewportWidth: 16_384,
    resolution: 2,
    viewportHeight: 2160,
    viewportWidth: 3840,
  });

  assert.ok(layout.bytes <= BigInt(byteBudget));
  assert.ok(layout.rasterScale < 1);
  assert.ok(
    Math.abs(layout.width / layout.height - 3840 / 2160) < 0.002,
  );
});

test('velocity render-target budget is exact, bounded, and configurable without GPU churn', () => {
  const defaultOverlay = new VelocityOverlay({});
  assert.equal(
    defaultOverlay.config.renderTargetByteBudget,
    256 * 1024 * 1024,
  );
  assert.throws(
    () => new VelocityOverlay({}, {
      renderTargetByteBudget: (1024 * 1024) - 1,
    }),
    /renderTargetByteBudget must be between/,
  );
  assert.throws(
    () => new VelocityOverlay({}, {
      renderTargetByteBudget: (2 * 1024 * 1024) + 0.5,
    }),
    /exact integer number/,
  );
});

test('multiview velocity targets receive deterministic equal byte shares and expose actual scale', () => {
  const fixture = createRenderTargetGl();
  const overlay = createOverlay(fixture.gl);
  const byteBudget = 96 * 1024 * 1024;
  overlay.config.renderTargetByteBudget = byteBudget;
  overlay.config.trailResolution = 2;
  overlay.prepareFrame(['live', 'snap_1']);

  const live = overlay._ensureFBOs('live', 3840, 2160);
  const snapshot = overlay._ensureFBOs('snap_1', 3840, 2160);

  assert.equal(live.targetByteBudget, byteBudget / 2);
  assert.equal(snapshot.targetByteBudget, byteBudget / 2);
  assert.equal(live.width, snapshot.width);
  assert.equal(live.height, snapshot.height);
  assert.ok(live.bytes <= BigInt(byteBudget / 2));
  assert.ok(snapshot.bytes <= BigInt(byteBudget / 2));
  assert.ok(overlay._residentFBOBytes <= BigInt(byteBudget));
  assert.equal(
    overlay.getRenderTargetStatus('live').rasterScale,
    live.rasterScale,
  );
  assert.equal(
    overlay.getRenderTargetStatus('snap_1').byteBudget,
    byteBudget / 2,
  );
});

test('velocity stages immutable complete targets and restores hostile caller state', () => {
  const fixture = createRenderTargetGl();
  const overlay = createOverlay(fixture.gl);
  const before = fixture.readState();

  const generation = overlay._ensureFBOs('live', 640, 480);

  assert.deepEqual(fixture.readState(), before);
  assert.equal(fixture.attachments.length, 4);
  assert.equal(fixture.clears.length, 4);
  assert.ok(
    fixture.clears.every(
      clear =>
        clear.scissorEnabled === false &&
        clear.colorMask.every(Boolean) &&
        clear.framebuffer !== null,
    ),
  );
  assert.equal(generation.trailFramebuffers.length, 2);
  assert.equal(generation.bloomFramebuffers.length, 2);
  assert.equal(generation.bytes, 6_144_000n);
  assert.equal(overlay._residentFBOBytes, generation.bytes);
});

test('steady velocity targets bypass layout allocation and WebGL state queries', () => {
  const fixture = createRenderTargetGl();
  const overlay = createOverlay(fixture.gl);
  const generation = overlay._ensureFBOs('live', 640, 480);
  const attachmentCount = fixture.attachments.length;
  const clearCount = fixture.clears.length;
  const before = fixture.readState();

  const reused = overlay._ensureFBOs('live', 640, 480);

  assert.equal(reused, generation);
  assert.equal(fixture.attachments.length, attachmentCount);
  assert.equal(fixture.clears.length, clearCount);
  assert.deepEqual(fixture.readState(), before);
  const source = VelocityOverlay.prototype._ensureFBOs.toString();
  assert.ok(
    source.indexOf('existing.sourceViewportWidth') <
      source.indexOf('_buildRenderTargetQualityTiers'),
  );
  assert.ok(
    source.indexOf('return existing') <
      source.indexOf('_buildRenderTargetQualityTiers'),
  );
});

test('hot velocity config input coalesces one trail clear without target deletion or allocation', () => {
  const fixture = createRenderTargetGl();
  const overlay = createOverlay(fixture.gl);
  const generation = overlay._ensureFBOs('live', 640, 480);
  const attachmentCount = fixture.attachments.length;
  const residentBytes = overlay._residentFBOBytes;
  const particle = {
    activeParticleCount: 15_000,
    cameraMotionAmount: 1,
    forceRespawn: false,
    lastAdvancedFrameId: 9,
    lastCameraPosition: new Float32Array(3),
    lastViewMatrix: new Float32Array(16),
    readyGeneration: 4,
  };
  Object.assign(overlay.config, {
    colormapId: 'viridis',
    intensity: 0.25,
    particleCapacity: 500_000,
    particleCount: 15_000,
    particleSize: 1,
  });
  Object.assign(overlay, {
    _disposed: false,
    _initialized: true,
    _particleByView: new Map([['live', particle]]),
    _spawnByView: new Map(),
    _updateColormap() {},
  });

  overlay.setConfig('particleSize', 1.1);
  overlay.setConfig('particleSize', 1.2);
  overlay.setConfig('intensity', 0.3);
  overlay.setConfig('intensity', 0.4);
  overlay.setConfig('colormapId', 'plasma');
  overlay.setConfig('colormapId', 'inferno');
  overlay.setConfig('particleCount', 16_000);
  overlay.setConfig('particleCount', 17_000);
  overlay.setConfig('trailResolution', 1.25);
  overlay.setConfig('trailResolution', 1.5);
  overlay.setConfig('renderTargetByteBudget', 192 * 1024 * 1024);
  overlay.setConfig('renderTargetByteBudget', 128 * 1024 * 1024);

  assert.equal(overlay._fboByView.get('live'), generation);
  assert.equal(
    overlay.config.renderTargetByteBudget,
    128 * 1024 * 1024,
  );
  assert.equal(overlay._residentFBOBytes, residentBytes);
  assert.equal(fixture.attachments.length, attachmentCount);
  assert.equal(fixture.deletedFramebuffers.length, 0);
  assert.equal(fixture.deletedTextures.length, 0);
  assert.equal(generation.trailClearPending, true);
  assert.equal(particle.activeParticleCount, 0);
  assert.equal(particle.forceRespawn, true);
  assert.equal(particle.readyGeneration, -1);
});

test('cap-preserving viewport resize refreshes particle raster scale without reallocating targets', () => {
  const fixture = createRenderTargetGl();
  const overlay = createOverlay(fixture.gl);
  const generation = overlay._ensureFBOs('live', 8192, 4096);
  const attachmentCount = fixture.attachments.length;

  assert.equal(generation.width, 4096);
  assert.equal(generation.height, 2048);
  assert.equal(generation.rasterScale, 0.5);

  const reused = overlay._ensureFBOs('live', 16_384, 8192);

  assert.equal(reused, generation);
  assert.equal(reused.width, 4096);
  assert.equal(reused.height, 2048);
  assert.equal(reused.rasterScale, 0.25);
  assert.equal(reused.sourceViewportWidth, 16_384);
  assert.equal(reused.sourceViewportHeight, 8192);
  assert.equal(fixture.attachments.length, attachmentCount);
});

test('velocity allocation failure stages a lower-cost target and reports its actual quality', () => {
  const fixture = createRenderTargetGl({ nullTextureAt: 3 });
  const overlay = createOverlay(fixture.gl);
  const old = createOldGeneration();
  overlay._fboByView.set('live', old);
  overlay._residentFBOBytes = old.bytes;
  const before = fixture.readState();

  const replacement = overlay._ensureFBOs('live', 640, 480);

  assert.equal(overlay._fboByView.get('live'), replacement);
  assert.notEqual(replacement, old);
  assert.equal(replacement.bloomEnabled, false);
  assert.equal(replacement.qualityTier, 1);
  assert.equal(replacement.textureFormat.internal, fixture.gl.RGBA16F);
  assert.equal(overlay._residentFBOBytes, replacement.bytes);
  assert.deepEqual(fixture.readState(), before);
  assert.equal(
    fixture.deletedTextures.some(
      value => value?.kind === 'old-trail-texture',
    ),
    true,
  );
  assert.equal(
    fixture.deletedFramebuffers.some(
      value => value?.kind === 'old-trail-fbo',
    ),
    true,
  );
  const status = overlay.getRenderTargetStatus('live');
  assert.equal(status.degraded, true);
  assert.equal(status.qualityTier, 1);
  assert.equal(status.rasterScale, replacement.rasterScale);
  assert.equal(status.bytes, replacement.bytes);
  assert.equal(status.byteBudget, 256 * 1024 * 1024);
});

test('exhausted velocity quality tiers preserve the published target and caller state', () => {
  const fixture = createRenderTargetGl({
    nullTextureAt: [3, 4, 5, 6],
  });
  const overlay = createOverlay(fixture.gl);
  const old = createOldGeneration();
  overlay._fboByView.set('live', old);
  overlay._residentFBOBytes = old.bytes;
  const before = fixture.readState();

  assert.throws(
    () => overlay._ensureFBOs('live', 640, 480),
    /render-target allocation, restoration, or cleanup was incomplete/,
  );

  assert.equal(overlay._fboByView.get('live'), old);
  assert.equal(overlay._residentFBOBytes, old.bytes);
  assert.deepEqual(fixture.readState(), before);
  assert.equal(
    fixture.deletedTextures.some(value => old.trail.includes(value)),
    false,
  );
  assert.equal(
    fixture.deletedFramebuffers.some(
      value => old.trailFramebuffers.includes(value),
    ),
    false,
  );
});

test('failed partial target cleanup retains exact candidate bytes and retries owned handles', () => {
  const fixture = createRenderTargetGl({ nullTextureAt: 3 });
  const overlay = createOverlay(fixture.gl);
  const deleteTexture = fixture.gl.deleteTexture;
  let failedTexture = null;
  let failOnce = true;
  fixture.gl.deleteTexture = texture => {
    if (failOnce) {
      failOnce = false;
      failedTexture = texture;
      throw new Error('synthetic partial candidate cleanup failure');
    }
    deleteTexture(texture);
  };

  assert.throws(
    () => overlay._ensureFBOs('live', 640, 480),
    /render-target allocation, restoration, or cleanup was incomplete/,
  );

  assert.equal(overlay._fboByView.size, 0);
  assert.equal(overlay._pendingFBORetirements.size, 1);
  assert.equal(
    overlay._residentFBOBytes,
    BigInt(640 * 480 * 8),
  );
  const pending = [...overlay._pendingFBORetirements][0];
  assert.equal(pending.trail.filter(Boolean).length, 1);
  assert.equal(pending.trail.includes(failedTexture), true);

  overlay._flushPendingFBORetirements();

  assert.equal(overlay._pendingFBORetirements.size, 0);
  assert.equal(overlay._residentFBOBytes, 0n);
  assert.equal(
    fixture.deletedTextures.filter(
      texture => texture === failedTexture
    ).length,
    1,
  );
});

test('velocity disposal detaches byte ownership and attempts every resource deletion', () => {
  const fixture = createRenderTargetGl();
  const overlay = createOverlay(fixture.gl);
  const generation = createOldGeneration();
  overlay._fboByView.set('live', generation);
  overlay._residentFBOBytes = generation.bytes;

  overlay._disposeFBOs('live');

  assert.equal(overlay._fboByView.has('live'), false);
  assert.equal(overlay._residentFBOBytes, 0n);
  assert.equal(fixture.deletedFramebuffers.length, 4);
  assert.equal(fixture.deletedTextures.length, 4);
});

test('failed render-target disposal retains exact ownership and retries only undeleted handles', () => {
  const fixture = createRenderTargetGl();
  const overlay = createOverlay(fixture.gl);
  const generation = createOldGeneration();
  const failedFramebuffer = generation.trailFramebuffers[0];
  const deleteAttempts = new Map();
  const deleteFramebuffer = fixture.gl.deleteFramebuffer.bind(fixture.gl);
  let failOnce = true;
  fixture.gl.deleteFramebuffer = value => {
    deleteAttempts.set(value, (deleteAttempts.get(value) ?? 0) + 1);
    if (value === failedFramebuffer && failOnce) {
      failOnce = false;
      throw new Error('synthetic framebuffer retirement failure');
    }
    deleteFramebuffer(value);
  };
  overlay._fboByView.set('live', generation);
  overlay._residentFBOBytes = generation.bytes;

  assert.throws(
    () => overlay._disposeFBOs('live'),
    /synthetic framebuffer retirement failure/,
  );

  assert.equal(overlay._fboByView.has('live'), false);
  assert.equal(overlay._pendingFBORetirements.size, 1);
  assert.equal(overlay._residentFBOBytes, generation.bytes);
  assert.equal(generation.trailFramebuffers[0], failedFramebuffer);
  assert.equal(
    [
      ...generation.trailFramebuffers.slice(1),
      ...generation.bloomFramebuffers,
      ...generation.trail,
      ...generation.bloom,
    ].every(value => value === null),
    true,
  );

  overlay._flushPendingFBORetirements();

  assert.equal(overlay._pendingFBORetirements.size, 0);
  assert.equal(overlay._residentFBOBytes, 0n);
  assert.equal(deleteAttempts.get(failedFramebuffer), 2);
  assert.equal(fixture.deletedFramebuffers.length, 4);
  assert.equal(fixture.deletedTextures.length, 4);
  assert.equal(
    [...deleteAttempts.entries()]
      .filter(([handle]) => handle !== failedFramebuffer)
      .every(([, count]) => count === 1),
    true,
  );
});

test('failed old-target retirement leaves the replacement published and accounts both generations until retry', () => {
  const fixture = createRenderTargetGl();
  const overlay = createOverlay(fixture.gl);
  const old = createOldGeneration();
  const failedTexture = old.trail[0];
  const deleteAttempts = new Map();
  const deleteTexture = fixture.gl.deleteTexture.bind(fixture.gl);
  let failOnce = true;
  fixture.gl.deleteTexture = value => {
    deleteAttempts.set(value, (deleteAttempts.get(value) ?? 0) + 1);
    if (value === failedTexture && failOnce) {
      failOnce = false;
      throw new Error('synthetic replaced texture retirement failure');
    }
    deleteTexture(value);
  };
  overlay._fboByView.set('live', old);
  overlay._residentFBOBytes = old.bytes;

  assert.throws(
    () => overlay._ensureFBOs('live', 640, 480),
    /synthetic replaced texture retirement failure/,
  );

  const replacement = overlay._fboByView.get('live');
  assert.notEqual(replacement, old);
  assert.equal(replacement.width, 640);
  assert.equal(replacement.height, 480);
  assert.equal(overlay._pendingFBORetirements.has(old), true);
  assert.equal(
    overlay._residentFBOBytes,
    old.bytes + replacement.bytes,
  );
  assert.equal(old.trail[0], failedTexture);

  overlay._flushPendingFBORetirements();

  assert.equal(overlay._pendingFBORetirements.size, 0);
  assert.equal(overlay._residentFBOBytes, replacement.bytes);
  assert.equal(deleteAttempts.get(failedTexture), 2);
  assert.equal(
    [...deleteAttempts.entries()]
      .filter(([handle]) => handle !== failedTexture)
      .every(([, count]) => count === 1),
    true,
  );
});
