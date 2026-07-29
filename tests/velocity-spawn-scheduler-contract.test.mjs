import assert from 'node:assert/strict';
import test from 'node:test';

import {
  VelocityOverlay,
} from '../assets/js/rendering/overlays/velocity/velocity-overlay.js';
import {
  getNotificationCenter,
} from '../assets/js/app/notification-center.js';

const TIMED_OUT_DEADLINE = Object.freeze({
  didTimeout: true,
  timeRemaining: () => 0,
});

function createSpawnState(version = 1) {
  return {
    buildToken: null,
    building: false,
    dirty: true,
    generation: version - 1,
    lastLod: null,
    notificationId: null,
    ready: false,
    tableSize: 1,
    tableWidth: 1,
    textureInfo: { height: 1, texture: { id: 'old-spawn' }, width: 1 },
    version,
    visibilityTextureInfo: {
      height: 1,
      texture: { id: 'old-visibility' },
      width: 1,
    },
  };
}

function createSpawnOverlay(state, deletedTextures = []) {
  return Object.assign(Object.create(VelocityOverlay.prototype), {
    _contextLost: false,
    _disposed: false,
    _failureHandler: null,
    _fboByView: new Map(),
    _particleByView: new Map(),
    _pendingFBORetirements: new Set(),
    _pendingParticleRetirements: new Set(),
    _pendingDerivedTextureDeletes: new Map(),
    _positionTexturePool: new Map(),
    _positionsRefByView: new Map(),
    _residentFBOBytes: 0n,
    _residentParticleBytes: 0n,
    _spawnByView: new Map([['live', state]]),
    config: {
      spawnTableSize: 1_024,
      syncWithLOD: false,
    },
    enabled: true,
    gl: {
      deleteTexture(texture) {
        deletedTextures.push(texture.id);
      },
    },
  });
}

function createSpawnTextureGl() {
  let nextId = 1;
  let binding = null;
  let unpackAlignment = 4;
  let pixelUnpackBuffer = null;
  const textures = new Set();
  const deleteCalls = new Map();
  const gl = {
    CLAMP_TO_EDGE: 0x812f,
    FLOAT: 0x1406,
    MAX_TEXTURE_SIZE: 0x0d33,
    NEAREST: 0x2600,
    NO_ERROR: 0,
    PIXEL_UNPACK_BUFFER: 0x88ec,
    PIXEL_UNPACK_BUFFER_BINDING: 0x88ef,
    R32F: 0x822e,
    R32UI: 0x8236,
    RED: 0x1903,
    RED_INTEGER: 0x8d94,
    TEXTURE_2D: 0x0de1,
    TEXTURE_BINDING_2D: 0x8069,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    UNPACK_ALIGNMENT: 0x0cf5,
    UNSIGNED_INT: 0x1405,
    failTexture: null,
    failOnce: false,
    bindBuffer(target, value) {
      assert.equal(target, this.PIXEL_UNPACK_BUFFER);
      pixelUnpackBuffer = value;
    },
    bindTexture(target, value) {
      assert.equal(target, this.TEXTURE_2D);
      binding = value;
    },
    createTexture() {
      const texture = { id: `published-${nextId++}` };
      textures.add(texture);
      return texture;
    },
    deleteTexture(texture) {
      deleteCalls.set(texture, (deleteCalls.get(texture) ?? 0) + 1);
      if (texture === this.failTexture && this.failOnce) {
        this.failOnce = false;
        throw new Error('synthetic replaced spawn retirement failure');
      }
      textures.delete(texture);
      if (binding === texture) binding = null;
    },
    getError() {
      return this.NO_ERROR;
    },
    getParameter(parameter) {
      if (parameter === this.MAX_TEXTURE_SIZE) return 4096;
      if (parameter === this.TEXTURE_BINDING_2D) return binding;
      if (parameter === this.UNPACK_ALIGNMENT) return unpackAlignment;
      if (parameter === this.PIXEL_UNPACK_BUFFER_BINDING) {
        return pixelUnpackBuffer;
      }
      throw new RangeError(`Unexpected WebGL parameter ${parameter}.`);
    },
    isTexture(texture) {
      return textures.has(texture);
    },
    pixelStorei(parameter, value) {
      assert.equal(parameter, this.UNPACK_ALIGNMENT);
      unpackAlignment = value;
    },
    texImage2D() {},
    texParameteri() {},
    texSubImage2D() {},
  };
  return { deleteCalls, gl, textures };
}

function withIdleQueue(run) {
  const originalRequestIdleCallback = globalThis.requestIdleCallback;
  const queue = [];
  globalThis.requestIdleCallback = callback => {
    queue.push(callback);
    return queue.length;
  };
  try {
    return run(queue);
  } finally {
    if (originalRequestIdleCallback === undefined) {
      delete globalThis.requestIdleCallback;
    } else {
      globalThis.requestIdleCallback = originalRequestIdleCallback;
    }
  }
}

test('incremental velocity spawn sampling is multi-slice and bit-identical to the synchronous reference', () => {
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    config: { spawnTableSize: 1_024 },
  });
  const cellCount = 140_000;
  const transparency = Float32Array.from(
    { length: cellCount },
    (_, index) => {
      if (index % 7 === 0) return 0;
      if (index % 11 === 0) return 0.01;
      return 1;
    }
  );
  const lodIndices = Uint32Array.from(
    { length: 90_000 },
    (_, index) => cellCount - 1 - index
  );

  for (const candidates of [null, lodIndices]) {
    const expected = overlay._buildSpawnTable(
      transparency,
      cellCount,
      candidates
    );
    const build = overlay._createSpawnTableBuild(
      transparency,
      cellCount,
      candidates
    );

    let slices = 0;
    while (!overlay._advanceSpawnTableBuild(build, TIMED_OUT_DEADLINE)) {
      slices++;
      assert.ok(slices < 100, 'incremental spawn build did not converge');
    }
    slices++;

    assert.ok(slices > 1);
    assert.deepEqual(overlay._finishSpawnTableBuild(build), expected);
  }
});

test('velocity visibility threshold includes alpha exactly 0.01', () => {
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    config: { spawnTableSize: 8 },
  });
  const transparency = new Float32Array([0, 0.009, 0.01, 0.011, 1]);

  assert.deepEqual(
    overlay._buildSpawnTable(transparency, transparency.length, null),
    new Uint32Array([2, 3, 4])
  );
  const build = overlay._createSpawnTableBuild(
    transparency,
    transparency.length,
    null
  );
  assert.equal(
    overlay._advanceSpawnTableBuild(build, TIMED_OUT_DEADLINE),
    true
  );
  assert.deepEqual(
    overlay._finishSpawnTableBuild(build),
    new Uint32Array([2, 3, 4])
  );
});

test('all-hidden velocity generations complete across idle slices without publishing stale particles', () => {
  withIdleQueue(queue => {
    const deletedTextures = [];
    const state = createSpawnState(4);
    const overlay = createSpawnOverlay(state, deletedTextures);
    const cellCount = 150_000;
    const transparency = new Float32Array(cellCount);
    let transparencyReads = 0;
    let lodReads = 0;

    overlay._ensureSpawnTable(
      'live',
      {
        getLodIndices() {
          lodReads++;
          return null;
        },
        getLodLevel: () => -1,
        getViewTransparency() {
          transparencyReads++;
          return transparency;
        },
      },
      cellCount
    );

    assert.equal(state.building, true);
    assert.equal(state.ready, false);
    assert.equal(queue.length, 1);

    let callbacks = 0;
    while (queue.length > 0) {
      const callback = queue.shift();
      callback(TIMED_OUT_DEADLINE);
      callbacks++;
      if (!state.ready) {
        assert.deepEqual(deletedTextures, []);
        assert.equal(state.tableSize, 1);
      }
      assert.ok(callbacks < 100, 'scheduled spawn build did not converge');
    }

    assert.ok(callbacks > 1);
    assert.equal(transparencyReads, 1);
    assert.equal(lodReads, 0);
    assert.equal(state.building, false);
    assert.equal(state.dirty, false);
    assert.equal(state.ready, true);
    assert.equal(state.generation, 4);
    assert.equal(state.tableSize, 0);
    assert.equal(state.tableWidth, 1);
    assert.equal(state.textureInfo, null);
    assert.equal(state.visibilityTextureInfo, null);
    assert.deepEqual(
      deletedTextures.sort(),
      ['old-spawn', 'old-visibility']
    );
  });
});

test('visibility invalidation cancels a partial spawn build before stale GL publication', () => {
  withIdleQueue(queue => {
    const deletedTextures = [];
    const state = createSpawnState(7);
    const overlay = createSpawnOverlay(state, deletedTextures);
    const cellCount = 150_000;
    const transparency = new Float32Array(cellCount);
    let transparencyReads = 0;
    const context = {
      getLodIndices: () => null,
      getLodLevel: () => -1,
      getViewTransparency() {
        transparencyReads++;
        return transparency;
      },
    };

    overlay._ensureSpawnTable('live', context, cellCount);
    queue.shift()(TIMED_OUT_DEADLINE);
    assert.equal(state.building, true);
    assert.equal(queue.length, 1);

    overlay.markVisibilityDirty('live');
    assert.equal(state.version, 8);
    queue.shift()(TIMED_OUT_DEADLINE);

    assert.equal(state.building, false);
    assert.equal(state.dirty, true);
    assert.equal(state.ready, false);
    assert.equal(queue.length, 0);
    assert.equal(transparencyReads, 1);
    assert.deepEqual(deletedTextures, []);

    overlay._ensureSpawnTable('live', context, cellCount);
    let callbacks = 0;
    while (queue.length > 0) {
      queue.shift()(TIMED_OUT_DEADLINE);
      callbacks++;
      assert.ok(callbacks < 100, 'replacement spawn build did not converge');
    }

    assert.equal(transparencyReads, 2);
    assert.equal(state.generation, 8);
    assert.equal(state.ready, true);
    assert.equal(state.tableSize, 0);
    assert.deepEqual(
      deletedTextures.sort(),
      ['old-spawn', 'old-visibility']
    );
  });
});

test('stale spawn cancellation absorbs a notification dismissal failure', t => {
  withIdleQueue(queue => {
    const state = createSpawnState(9);
    state.textureInfo = null;
    state.visibilityTextureInfo = null;
    const overlay = createSpawnOverlay(state);
    const notifications = getNotificationCenter();
    const originalLoading = notifications.loading;
    const originalDismiss = notifications.dismiss;
    const originalConsoleError = console.error;
    const diagnostics = [];
    notifications.loading = () => 'stale-build';
    notifications.dismiss = id => {
      assert.equal(id, 'stale-build');
      throw new Error('Injected stale notification dismissal failure.');
    };
    console.error = error => diagnostics.push(error);
    t.after(() => {
      notifications.loading = originalLoading;
      notifications.dismiss = originalDismiss;
      console.error = originalConsoleError;
    });

    overlay._ensureSpawnTable(
      'live',
      {
        getLodIndices: () => null,
        getLodLevel: () => -1,
        getViewTransparency: () => new Float32Array(150_000),
      },
      150_000,
    );
    queue.shift()(TIMED_OUT_DEADLINE);
    assert.equal(state.building, true);

    overlay.markVisibilityDirty('live');
    assert.doesNotThrow(() => queue.shift()(TIMED_OUT_DEADLINE));

    assert.equal(state.building, false);
    assert.equal(state.dirty, true);
    assert.equal(state.ready, false);
    assert.equal(state.notificationId, null);
    assert.equal(queue.length, 0);
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0].message, /dismissal failure/);
  });
});

test('disabling velocity fences a partial build and retires only published derived textures', () => {
  withIdleQueue(queue => {
    const deletedTextures = [];
    const state = createSpawnState(2);
    const overlay = createSpawnOverlay(state, deletedTextures);
    const cellCount = 150_000;

    overlay._ensureSpawnTable(
      'live',
      {
        getLodIndices: () => null,
        getLodLevel: () => -1,
        getViewTransparency: () => new Float32Array(cellCount),
      },
      cellCount
    );
    queue.shift()(TIMED_OUT_DEADLINE);
    assert.equal(state.building, true);

    overlay.setEnabled(false);
    assert.equal(overlay.enabled, false);
    queue.shift()(TIMED_OUT_DEADLINE);

    assert.equal(state.building, false);
    assert.equal(state.dirty, true);
    assert.equal(state.ready, false);
    assert.equal(queue.length, 0);
    assert.deepEqual(
      deletedTextures.sort(),
      ['old-spawn', 'old-visibility']
    );
  });
});

test('spawn failure does not terminally update the notification dismissed by shutdown', () => {
  withIdleQueue(queue => {
    const state = createSpawnState(3);
    state.textureInfo = null;
    state.visibilityTextureInfo = null;
    const overlay = createSpawnOverlay(state);
    const notifications = getNotificationCenter();
    const originals = {
      dismiss: notifications.dismiss,
      error: notifications.error,
      fail: notifications.fail,
      loading: notifications.loading,
    };
    const events = [];
    notifications.loading = () => {
      events.push('loading');
      return 'velocity-build';
    };
    notifications.dismiss = id => {
      events.push(`dismiss:${id}`);
      return true;
    };
    notifications.error = message => {
      events.push(`error:${message}`);
    };
    notifications.fail = id => {
      throw new RangeError(
        `Notification "${id}" was already dismissed by shutdown.`
      );
    };

    try {
      overlay._ensureSpawnTable(
        'live',
        {
          getLodIndices: () => null,
          getLodLevel: () => -1,
          // The scheduled build must report this contract failure through the
          // overlay circuit instead of leaking a second notification failure.
          getViewTransparency: () => new Float32Array(0),
        },
        1,
      );
      assert.equal(queue.length, 1);
      assert.doesNotThrow(() => queue.shift()(TIMED_OUT_DEADLINE));

      assert.equal(overlay.enabled, false);
      assert.equal(state.notificationId, null);
      assert.equal(state.building, false);
      assert.equal(state.ready, false);
      assert.deepEqual(events.slice(0, 2), [
        'loading',
        'dismiss:velocity-build',
      ]);
      assert.match(events[2], /^error:Velocity overlay preparation failed:/);
    } finally {
      Object.assign(notifications, originals);
    }
  });
});

test('spawn publication remains ready when notification pressure evicts its loading owner', () => {
  withIdleQueue(queue => {
    const state = createSpawnState(5);
    state.textureInfo = null;
    state.visibilityTextureInfo = null;
    const overlay = createSpawnOverlay(state);
    const notifications = getNotificationCenter();
    const originals = {
      complete: notifications.complete,
      hasNotification: notifications.hasNotification,
      loading: notifications.loading,
    };
    const activeIds = new Set();
    let completeCalls = 0;
    notifications.loading = () => {
      activeIds.add('velocity-under-pressure');
      return 'velocity-under-pressure';
    };
    notifications.hasNotification = id => activeIds.has(id);
    notifications.complete = () => {
      completeCalls++;
      throw new RangeError('evicted notification cannot be completed');
    };

    try {
      overlay._ensureSpawnTable(
        'live',
        {
          getLodIndices: () => null,
          getLodLevel: () => -1,
          getViewTransparency: () => new Float32Array(1),
        },
        1,
      );
      assert.equal(queue.length, 1);
      // Simulate the center's five-item capacity pressure before the idle
      // publication owns its terminal transition.
      activeIds.delete('velocity-under-pressure');
      assert.doesNotThrow(() => queue.shift()(TIMED_OUT_DEADLINE));

      assert.equal(completeCalls, 0);
      assert.equal(overlay.enabled, true);
      assert.equal(state.building, false);
      assert.equal(state.dirty, false);
      assert.equal(state.ready, true);
      assert.equal(state.generation, 5);
      assert.equal(state.tableSize, 0);
      assert.equal(state.notificationId, null);
    } finally {
      Object.assign(notifications, originals);
    }
  });
});

test('committed empty spawn generation retains failed old-texture retirement for retry', t => {
  withIdleQueue(queue => {
    const state = createSpawnState(6);
    const overlay = createSpawnOverlay(state);
    const oldSpawnTexture = state.textureInfo.texture;
    const oldVisibilityTexture = state.visibilityTextureInfo.texture;
    const deleteCalls = new Map();
    let failOnce = true;
    overlay.gl.deleteTexture = texture => {
      deleteCalls.set(texture, (deleteCalls.get(texture) ?? 0) + 1);
      if (texture === oldSpawnTexture && failOnce) {
        failOnce = false;
        throw new Error('synthetic committed spawn retirement failure');
      }
    };
    const diagnostics = [];
    const originalConsoleError = console.error;
    console.error = error => diagnostics.push(error);
    t.after(() => {
      console.error = originalConsoleError;
    });

    overlay._ensureSpawnTable(
      'live',
      {
        getLodIndices: () => null,
        getLodLevel: () => -1,
        getViewTransparency: () => new Float32Array(1),
      },
      1,
    );
    assert.equal(queue.length, 1);
    assert.doesNotThrow(() => queue.shift()(TIMED_OUT_DEADLINE));

    assert.equal(overlay.enabled, true);
    assert.equal(state.ready, true);
    assert.equal(state.dirty, false);
    assert.equal(state.generation, 6);
    assert.equal(state.tableSize, 0);
    assert.equal(state.textureInfo, null);
    assert.equal(state.visibilityTextureInfo, null);
    assert.equal(
      overlay._pendingDerivedTextureDeletes.get(oldSpawnTexture),
      4n,
    );
    assert.equal(
      overlay._pendingDerivedTextureDeletes.has(oldVisibilityTexture),
      false,
    );
    assert.equal(diagnostics.length, 1);

    assert.equal(overlay._flushPendingDerivedTextureDeletes(), null);
    assert.equal(overlay._pendingDerivedTextureDeletes.size, 0);
    assert.equal(deleteCalls.get(oldSpawnTexture), 2);
    assert.equal(deleteCalls.get(oldVisibilityTexture), 1);
  });
});

test('committed non-empty spawn replacement stays ready while old retirement retries', t => {
  withIdleQueue(queue => {
    const state = createSpawnState(8);
    const oldSpawnTexture = state.textureInfo.texture;
    const oldVisibilityTexture = state.visibilityTextureInfo.texture;
    const fixture = createSpawnTextureGl();
    fixture.gl.failTexture = oldSpawnTexture;
    fixture.gl.failOnce = true;
    const overlay = createSpawnOverlay(state);
    overlay.gl = fixture.gl;
    const diagnostics = [];
    const originalConsoleError = console.error;
    console.error = error => diagnostics.push(error);
    t.after(() => {
      console.error = originalConsoleError;
    });

    overlay._ensureSpawnTable(
      'live',
      {
        getLodIndices: () => null,
        getLodLevel: () => -1,
        getViewTransparency: () => new Float32Array([1]),
      },
      1,
    );
    assert.equal(queue.length, 1);
    assert.doesNotThrow(() => queue.shift()(TIMED_OUT_DEADLINE));

    assert.equal(overlay.enabled, true);
    assert.equal(state.ready, true);
    assert.equal(state.dirty, false);
    assert.equal(state.generation, 8);
    assert.equal(state.tableSize, 1);
    assert.notEqual(state.textureInfo.texture, oldSpawnTexture);
    assert.notEqual(
      state.visibilityTextureInfo.texture,
      oldVisibilityTexture,
    );
    assert.equal(fixture.textures.has(state.textureInfo.texture), true);
    assert.equal(
      fixture.textures.has(state.visibilityTextureInfo.texture),
      true,
    );
    assert.equal(
      overlay._pendingDerivedTextureDeletes.get(oldSpawnTexture),
      4n,
    );
    assert.equal(
      overlay._pendingDerivedTextureDeletes.has(oldVisibilityTexture),
      false,
    );
    assert.equal(diagnostics.length, 1);

    assert.equal(overlay._flushPendingDerivedTextureDeletes(), null);
    assert.equal(overlay._pendingDerivedTextureDeletes.size, 0);
    assert.equal(fixture.deleteCalls.get(oldSpawnTexture), 2);
    assert.equal(fixture.deleteCalls.get(oldVisibilityTexture), 1);
  });
});
