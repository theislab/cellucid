/**
 * What applying a highlight is allowed to cost.
 *
 * Three separate regressions, all of which cost time proportional to the
 * dataset rather than to what the user changed:
 *
 * - A filter interaction that moves no cell across the visible boundary must
 *   not invalidate the highlight generation. Doing so repacks and re-uploads
 *   one compact buffer of every selected cell, per view, for no change.
 * - Applying a selection must not walk it, copy it, and copy it again. The
 *   index list is a `Uint32Array` from the moment a group is created until the
 *   packer reads it, and validation happens in the pass that writes it.
 * - The reported GPU memory must include the highlight buffers, which are the
 *   largest allocation in the context after the interleaved point buffer.
 *
 * None of this may change what a highlight *is*: the cells, their order, and
 * the packed bytes are asserted against an independent reference.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { HighPerfRenderer } from '../assets/js/rendering/high-perf-renderer.js';
import {
  HighlightRenderer,
  HighlightTools,
} from '../assets/js/rendering/highlight-renderer.js';
import {
  MIN_VISIBLE_ALPHA_BYTE,
  POINT_VISIBILITY_THRESHOLD,
} from '../assets/js/rendering/alpha-visibility.js';
import {
  highlightStateMethods,
} from '../assets/js/app/state/managers/highlight-manager.js';

const POINT_COUNT = 64;

function makeAlphaGl() {
  const calls = { texSubImage2D: 0, uploadedBytes: 0 };
  const gl = {
    TEXTURE_2D: 0x0de1,
    R8: 0x8229,
    RED: 0x1903,
    UNSIGNED_BYTE: 0x1401,
    NO_ERROR: 0,
    MAX_TEXTURE_SIZE: 0x0d33,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    NEAREST: 0x2600,
    CLAMP_TO_EDGE: 0x812f,
    UNPACK_ALIGNMENT: 0x0cf5,
    getParameter(parameter) {
      if (parameter === this.MAX_TEXTURE_SIZE) return 4096;
      if (parameter === this.UNPACK_ALIGNMENT) return 4;
      return 0;
    },
    pixelStorei() {},
    createTexture() { return { kind: 'alpha-texture' }; },
    deleteTexture() {},
    bindTexture() {},
    texParameteri() {},
    texImage2D() {},
    texSubImage2D(_target, _level, _x, _y, _w, _h, _format, _type, data) {
      calls.texSubImage2D += 1;
      calls.uploadedBytes += data.length;
    },
    getError() { return this.NO_ERROR; },
  };
  return { calls, gl };
}

function makeHighPerfRenderer() {
  const { calls, gl } = makeAlphaGl();
  const renderer = Object.assign(Object.create(HighPerfRenderer.prototype), {
    gl,
    pointCount: POINT_COUNT,
    stats: { gpuMemoryMB: 0 },
    buffers: { interleaved: null },
    _interleavedGpuByteLength: 0,
    _alphaTexture: null,
    _alphaTexData: null,
    _alphaTexStagingData: null,
    _alphaTexWidth: 0,
    _alphaTexHeight: 0,
    _alphaTextureByteLength: 0,
    _dummyLodIndexTexture: null,
    _dummyLodIndexTextureByteLength: 0,
    _useAlphaTexture: false,
    _currentAlphas: null,
    _lodResourceOwnersByDimension: new Map(),
    _pendingDataRetirements: new Set(),
    _pendingSnapshotRetirements: new Set(),
    _perViewState: new Map(),
    _snapshotGeometryPools: new Map(),
    snapshotBuffers: new Map(),
    _gpuAllocationReporters: new Set(),
    _assertOperational() {},
    _ensureRetirementOwnershipState() {},
    _queueDataRetirement() {},
    _drainDataRetirements() { return []; },
  });
  return { alphaCalls: calls, renderer };
}

function makeHighlightGl() {
  const uploads = [];
  const gl = {
    ARRAY_BUFFER: 0x8892,
    DYNAMIC_DRAW: 0x88e8,
    FLOAT: 0x1406,
    NO_ERROR: 0,
    UNSIGNED_BYTE: 0x1401,
    createBuffer() { return { kind: 'highlight-buffer' }; },
    createVertexArray() { return { kind: 'highlight-vao' }; },
    bindBuffer() {},
    bindVertexArray() {},
    deleteBuffer() {},
    deleteVertexArray() {},
    enableVertexAttribArray() {},
    getError() { return this.NO_ERROR; },
    bufferData(_target, source) {
      uploads.push(new Uint8Array(
        source.buffer,
        source.byteOffset,
        source.byteLength,
      ).slice());
    },
    vertexAttribPointer() {},
  };
  return { gl, uploads };
}

function makeFixture({ hpRenderer = null } = {}) {
  const { gl, uploads } = makeHighlightGl();
  const highlightRenderer = Object.assign(
    Object.create(HighlightRenderer.prototype),
    {
      _highlightDataRef: null,
      _highlightDataVersion: 0,
      _highlightedIndicesCache: null,
      _pendingBufferDeletes: new Set(),
      _pendingVertexArrayDeletes: new Set(),
      _totalHighlightedCount: 0,
      _viewBuffers: new Map(),
      attribLocations: { color: 1, position: 0 },
      gl,
      hpRenderer,
    },
  );
  const tools = Object.assign(Object.create(HighlightTools.prototype), {
    _transparencyGenerations: new Map(),
    highlightArray: null,
    highlightRenderer,
    hpRenderer: {
      getCurrentLodMembership() { return null; },
      getViewGeometryGeneration() { return 5; },
    },
  });

  const positions = new Float32Array(POINT_COUNT * 3);
  for (let index = 0; index < POINT_COUNT; index++) {
    positions[index * 3] = index * 0.5;
    positions[index * 3 + 1] = index * -0.25;
    positions[index * 3 + 2] = (index % 5) * 1.25;
  }
  const transparency = new Float32Array(POINT_COUNT).fill(1);

  const page = {
    id: 'page_1',
    name: 'Page 1',
    color: '#ff0000',
    highlightedGroups: [],
  };
  const state = Object.create(highlightStateMethods);
  Object.assign(state, {
    pointCount: POINT_COUNT,
    highlightPages: [page],
    activePageId: 'page_1',
    highlightArray: null,
    _highlightedCellIndices: null,
    _highlightMembershipScratch: null,
    _highlightIdCounter: 0,
    _highlightPageIdCounter: 1,
    _cachedHighlightCount: null,
    _cachedTotalHighlightCount: null,
    _cachedHighlightLodMembership: null,
    emit() {},
    viewer: {
      updateHighlight(highlightData, highlightedIndices) {
        tools.updateHighlight(highlightData, highlightedIndices);
      },
    },
  });

  return {
    highlightRenderer,
    page,
    positions,
    state,
    sync: () => tools.syncHighlightBufferForLod(
      positions,
      'live',
      transparency,
      2,
    ),
    tools,
    transparency,
    uploads,
  };
}

/**
 * Pack the highlight buffer from first principles, independently of the
 * renderer, so "the bytes did not change" is checked against the definition
 * rather than against the implementation's own previous output.
 */
function referencePackedBytes({
  highlightData,
  order,
  positions,
  transparency,
}) {
  const visible = [];
  for (const cellIndex of order) {
    if (transparency[cellIndex] < POINT_VISIBILITY_THRESHOLD) continue;
    visible.push(cellIndex);
  }
  const packed = new ArrayBuffer(visible.length * 16);
  const positionView = new Float32Array(packed);
  const colorView = new Uint8Array(packed);
  for (let slot = 0; slot < visible.length; slot++) {
    const cellIndex = visible[slot];
    positionView[slot * 4] = positions[cellIndex * 3];
    positionView[slot * 4 + 1] = positions[cellIndex * 3 + 1];
    positionView[slot * 4 + 2] = positions[cellIndex * 3 + 2];
    colorView[slot * 16 + 12] = 255;
    colorView[slot * 16 + 13] = 255;
    colorView[slot * 16 + 14] = 255;
    colorView[slot * 16 + 15] = highlightData[cellIndex];
  }
  return new Uint8Array(packed);
}

// --- CEL-0142: a filter change that moves no visible cell -------------------

test('an unmoved alpha generation is reported, so a no-op filter change repacks nothing', () => {
  const { alphaCalls, renderer } = makeHighPerfRenderer();
  const alphas = new Float32Array(POINT_COUNT).fill(1);

  assert.equal(
    renderer.updateAlphas(alphas),
    true,
    'the first publication creates the R8 owner and is a new generation'
  );
  const afterCreate = alphaCalls.texSubImage2D;

  const identical = new Float32Array(POINT_COUNT).fill(1);
  assert.equal(
    renderer.updateAlphas(identical),
    false,
    'republishing byte-identical alphas must report that nothing moved'
  );
  assert.equal(
    alphaCalls.texSubImage2D,
    afterCreate,
    'a no-op publication must not upload the alpha texture either'
  );

  // A float change too small to move the R8 byte cannot cross the visibility
  // boundary, because that boundary is defined on the byte.
  const subQuantum = new Float32Array(POINT_COUNT).fill(1);
  subQuantum[3] = 1 - 1 / 1020;
  assert.equal(Math.round(subQuantum[3] * 255), 255);
  assert.equal(
    renderer.updateAlphas(subQuantum),
    false,
    'a float move that rounds to the same byte is not a new generation'
  );

  const moved = new Float32Array(POINT_COUNT).fill(1);
  moved[3] = 0;
  assert.equal(
    renderer.updateAlphas(moved),
    true,
    'a filter change that hides a cell must report a new generation'
  );
  assert.equal(alphaCalls.texSubImage2D, afterCreate + 1);
});

test('the visible-cell predicate is exactly the published R8 byte', () => {
  // This is what makes the skip above sound: everything the highlight
  // publication boundary owns admits a cell by `alpha >= threshold`, and that
  // is the same question as `Math.round(alpha * 255) >= MIN_VISIBLE_ALPHA_BYTE`.
  // Walk the float32 grid across the boundary rather than sampling it.
  const probe = new Float32Array(1);
  const bits = new Int32Array(probe.buffer);
  const boundaryBits = (() => {
    probe[0] = POINT_VISIBILITY_THRESHOLD;
    return bits[0];
  })();
  for (let offset = -4096; offset <= 4096; offset++) {
    bits[0] = boundaryBits + offset;
    const alpha = probe[0];
    assert.equal(
      Math.round(alpha * 255) >= MIN_VISIBLE_ALPHA_BYTE,
      alpha >= POINT_VISIBILITY_THRESHOLD,
      `alpha ${alpha} disagrees with its published byte`
    );
  }
});

test('a no-op filter change uploads zero highlight bytes through the composed path', () => {
  const { renderer } = makeHighPerfRenderer();
  const fixture = makeFixture();
  const cellIndices = Array.from({ length: 16 }, (_, index) => index * 3);
  fixture.state.addHighlightDirect({
    cellIndices,
    label: 'selection',
    type: 'lasso',
  });

  const alphas = new Float32Array(POINT_COUNT).fill(1);
  renderer.updateAlphas(alphas);
  fixture.sync();
  const packedUploads = fixture.uploads.length;
  assert.equal(packedUploads, 1, 'the selection is packed once');

  // Exactly the sequence viewer.js runs for a live transparency publication.
  const publish = (nextAlphas) => {
    const moved = renderer.updateAlphas(nextAlphas);
    if (moved) fixture.tools.handleTransparencyChange('live');
    fixture.sync();
    return moved;
  };

  assert.equal(publish(new Float32Array(POINT_COUNT).fill(1)), false);
  assert.equal(
    fixture.uploads.length,
    packedUploads,
    'a filter change that moves no byte must not re-upload the highlight buffer'
  );

  const hidden = new Float32Array(POINT_COUNT).fill(1);
  hidden[3] = 0;
  assert.equal(publish(hidden), true);
  fixture.transparency[3] = 0;
  fixture.sync();
  assert.equal(
    fixture.uploads.length,
    packedUploads + 1,
    'a filter change that hides a cell must still repack'
  );
});

test('the live transparency publication gates the highlight invalidation', async () => {
  // The viewer factory needs a real WebGL context, so its sequencing is
  // asserted on the source: an unconditional call here is the defect.
  const source = await readFile(
    new URL('../assets/js/rendering/viewer.js', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('updateTransparency(alphaArray) {');
  assert.notEqual(start, -1, 'live updateTransparency must exist');
  const end = source.indexOf('updatePositions(positions, dimensionLevel) {', start);
  assert.notEqual(end, -1);
  const body = source.slice(start, end);

  assert.match(
    body,
    /const\s+alphaGenerationMoved\s*=\s*hpRenderer\.updateAlphas\(alphaArray\)/,
    'the live path must keep the result of the alpha publication'
  );
  assert.match(
    body,
    /if\s*\(alphaGenerationMoved\)\s*\{\s*highlightTools\.handleTransparencyChange\(LIVE_VIEW_ID\);/,
    'handleTransparencyChange must run only when the alpha generation moved'
  );
});

// --- CEL-0143: how many times a selection may be walked and copied ----------

test('a direct highlight reads the caller selection exactly once per cell', () => {
  const fixture = makeFixture();
  const cells = [11, 2, 40, 2, 7];
  let elementReads = 0;
  const counted = new Proxy(cells, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) {
        elementReads += 1;
      }
      return Reflect.get(target, property, receiver);
    },
  });

  fixture.state.addHighlightDirect({
    cellIndices: counted,
    label: 'selection',
    type: 'lasso',
  });

  assert.equal(
    elementReads,
    cells.length,
    'validation and the copy must be the same pass over the selection'
  );
  const [group] = fixture.page.highlightedGroups;
  assert.ok(
    group.cellIndices instanceof Uint32Array,
    'the group owns its cells as a Uint32Array'
  );
  assert.deepEqual([...group.cellIndices], cells);
  assert.notEqual(
    group.cellIndices,
    counted,
    'the group must not alias the caller selection'
  );
});

test('the packed highlight buffer is never copied on the way to the renderer', () => {
  const fixture = makeFixture();
  fixture.state.addHighlightDirect({
    cellIndices: [5, 1, 9],
    label: 'selection',
    type: 'lasso',
  });

  const published = fixture.state._highlightedCellIndices;
  assert.ok(
    published instanceof Uint32Array,
    'the published index list is a Uint32Array'
  );
  assert.equal(
    fixture.highlightRenderer._highlightedIndicesCache,
    published,
    'the renderer adopts the published list instead of allocating a second copy'
  );
});

test('the packed bytes match an independent reference for every selection shape', () => {
  const shapes = [
    { name: 'singleton', groups: [[9]] },
    { name: 'sparse', groups: [[2, 17, 33, 61]] },
    { name: 'dense', groups: [Array.from({ length: 32 }, (_, i) => i * 2)] },
    { name: 'all', groups: [Array.from({ length: POINT_COUNT }, (_, i) => i)] },
    { name: 'out of order', groups: [[61, 2, 33, 17]] },
    { name: 'duplicated across groups', groups: [[1, 2, 3], [3, 2, 8]] },
    {
      name: 'reversed',
      groups: [Array.from({ length: POINT_COUNT }, (_, i) => POINT_COUNT - 1 - i)],
    },
  ];

  for (const shape of shapes) {
    const fixture = makeFixture();
    // A deterministic set of filtered-out cells so the pack is not the identity.
    for (let index = 0; index < POINT_COUNT; index += 7) {
      fixture.transparency[index] = 0;
    }
    for (const cellIndices of shape.groups) {
      fixture.state.addHighlightDirect({
        cellIndices,
        label: `group for ${shape.name}`,
        type: 'lasso',
      });
    }
    fixture.sync();

    const firstSeen = [];
    const seen = new Set();
    for (const cellIndices of shape.groups) {
      for (const cellIndex of cellIndices) {
        if (seen.has(cellIndex)) continue;
        seen.add(cellIndex);
        firstSeen.push(cellIndex);
      }
    }
    assert.deepEqual(
      [...fixture.state._highlightedCellIndices],
      firstSeen,
      `${shape.name}: the published list is the deduplicated first-seen order`
    );

    const expected = referencePackedBytes({
      highlightData: fixture.state.highlightArray,
      order: firstSeen,
      positions: fixture.positions,
      transparency: fixture.transparency,
    });
    assert.equal(fixture.uploads.length, expected.length === 0 ? 0 : 1);
    if (expected.length > 0) {
      assert.deepEqual(
        fixture.uploads[0],
        expected,
        `${shape.name}: the packed vertex bytes must match the reference exactly`
      );
    }
  }
});

test('an empty page publishes an empty list and no buffer', () => {
  const fixture = makeFixture();
  fixture.state._recomputeHighlightArray();
  fixture.sync();

  assert.ok(fixture.state._highlightedCellIndices instanceof Uint32Array);
  assert.equal(fixture.state._highlightedCellIndices.length, 0);
  assert.equal(fixture.uploads.length, 0);
  assert.equal(fixture.state.getTotalHighlightedCellCount(), 0);
});

test('a preview unions the active page with the in-progress selection in one buffer', () => {
  const fixture = makeFixture();
  fixture.state.addHighlightDirect({
    cellIndices: [4, 5],
    label: 'committed',
    type: 'lasso',
  });
  fixture.state.setPreviewHighlightFromIndices([5, 12, 4, 30]);

  const published = fixture.state._highlightedCellIndices;
  assert.ok(published instanceof Uint32Array);
  assert.deepEqual(
    [...published],
    [4, 5, 12, 30],
    'the preview appends only cells the page did not already claim'
  );
  assert.equal(
    published.length,
    4,
    'the published list is exactly sized, never the union capacity'
  );
});

test('a hole in a caller index list is rejected instead of packing a NaN vertex', () => {
  const fixture = makeFixture();
  const highlightData = new Uint8Array(POINT_COUNT);
  highlightData[2] = 255;
  highlightData[6] = 255;
  const sparse = [2];
  sparse[2] = 6; // index 1 is a hole

  assert.throws(
    () => fixture.tools.updateHighlight(highlightData, sparse),
    /Highlighted indices must be an array of valid highlight-data indices/,
  );
});

test('an out-of-range index is still refused at the renderer boundary', () => {
  const fixture = makeFixture();
  const highlightData = new Uint8Array(POINT_COUNT);
  highlightData[1] = 255;

  for (const indices of [
    [POINT_COUNT],
    [-1],
    Uint32Array.from([POINT_COUNT]),
    [0], // highlightData[0] is below the visible byte
  ]) {
    assert.throws(
      () => fixture.tools.updateHighlight(highlightData, indices),
      /Highlighted indices must be an array of valid highlight-data indices/,
      `expected ${JSON.stringify([...indices])} to be refused`,
    );
  }
});

test('a group inventory that outgrows its sizing pass fails loudly', () => {
  // The output buffer is sized from the group lengths, then filled. A silent
  // out-of-range typed-array write would paint cells the published list omits.
  const fixture = makeFixture();
  const growing = [1, 2, 3];
  let capacityReads = 0;
  fixture.page.highlightedGroups.push({
    id: 'highlight_1',
    type: 'lasso',
    label: 'growing',
    enabled: true,
    cellCount: 3,
    get cellIndices() {
      capacityReads += 1;
      return capacityReads === 1 ? growing : [1, 2, 3, 4, 5, 6];
    },
  });

  assert.throws(
    () => fixture.state._recomputeHighlightArray(),
    /produced more cells than its 3-entry buffer holds/,
  );
});

test('a preview union that outgrows its sizing pass fails loudly', () => {
  // The union buffer is sized as "page capacity + preview length" and filled by
  // the collector first. If the page inventory grew after sizing, the collector
  // can consume the whole buffer and leave the preview nothing to write into.
  const fixture = makeFixture();
  let capacityReads = 0;
  fixture.page.highlightedGroups.push({
    id: 'highlight_1',
    type: 'lasso',
    label: 'growing',
    enabled: true,
    cellCount: 1,
    get cellIndices() {
      capacityReads += 1;
      return capacityReads === 1 ? [1] : [1, 2];
    },
  });

  assert.throws(
    () => fixture.state.setPreviewHighlightFromIndices([9]),
    /Preview highlight produced more cells than its 2-entry buffer holds/,
  );
});

// --- CEL-0145: what the reported GPU memory covers --------------------------

test('reported GPU memory includes the per-view highlight buffers', () => {
  const { renderer } = makeHighPerfRenderer();
  const fixture = makeFixture({ hpRenderer: renderer });
  renderer.registerGpuAllocationReporter(
    (add) => fixture.highlightRenderer.collectGpuAllocations(add),
  );

  const before = renderer._refreshGpuMemoryStats();

  const cellIndices = Array.from({ length: 12 }, (_, index) => index * 2);
  fixture.state.addHighlightDirect({
    cellIndices,
    label: 'selection',
    type: 'lasso',
  });
  fixture.sync();

  // Read the published figure without recomputing: a highlight publication has
  // to refresh it itself, or `getStats` reports a stale total.
  const publishedBytes = renderer.stats.gpuMemoryMB * 1024 * 1024;
  assert.equal(
    publishedBytes - before,
    cellIndices.length * 16,
    'packing the highlight buffer must refresh the published GPU total'
  );
  assert.equal(
    renderer._refreshGpuMemoryStats(),
    publishedBytes,
    'recomputing must agree with what was already published'
  );

  fixture.highlightRenderer.clearViewBuffer('live');
  assert.equal(
    renderer.stats.gpuMemoryMB * 1024 * 1024,
    before,
    'retiring the view must remove its bytes from the published total'
  );
});

test('a highlight renderer registers and releases its own memory reporting', () => {
  const { renderer } = makeHighPerfRenderer();
  const { gl } = makeHighlightGl();
  const highlightRenderer = Object.assign(
    Object.create(HighlightRenderer.prototype),
    {
      _disposed: false,
      _disposeStarted: false,
      _highlightDataRef: null,
      _highlightDataVersion: 0,
      _highlightedIndicesCache: null,
      _pendingBufferDeletes: new Set(),
      _pendingProgramDeletes: new Set(),
      _pendingVertexArrayDeletes: new Set(),
      _totalHighlightedCount: 0,
      _viewBuffers: new Map(),
      attribLocations: { color: 1, position: 0 },
      gl,
      hpRenderer: renderer,
      program: null,
    },
  );
  highlightRenderer._gpuAllocationReporter =
    (add) => highlightRenderer.collectGpuAllocations(add);
  renderer.registerGpuAllocationReporter(
    highlightRenderer._gpuAllocationReporter
  );
  assert.equal(renderer._gpuAllocationReporters.size, 1);

  highlightRenderer._viewBuffers.set('live', {
    buffer: { kind: 'highlight-buffer' },
    gpuByteLength: 1024,
    pointCount: 64,
    vertexArray: { kind: 'highlight-vao' },
  });
  assert.equal(renderer._refreshGpuMemoryStats(), 1024);

  highlightRenderer.dispose();
  assert.equal(
    renderer._gpuAllocationReporters.size,
    0,
    'a disposed highlight renderer must not keep reporting retired handles'
  );
  assert.equal(renderer._refreshGpuMemoryStats(), 0);
});

test('a duplicate handle is counted once by the shared inventory', () => {
  const { renderer } = makeHighPerfRenderer();
  const shared = { kind: 'shared-buffer' };
  renderer.registerGpuAllocationReporter((add) => add(shared, 4096));
  renderer.registerGpuAllocationReporter((add) => add(shared, 4096));

  assert.equal(
    renderer._refreshGpuMemoryStats(),
    4096,
    'the inventory deduplicates by WebGL handle across reporters'
  );
});

test('a GPU allocation reporter must be a function', () => {
  const { renderer } = makeHighPerfRenderer();
  assert.throws(
    () => renderer.registerGpuAllocationReporter(null),
    /GPU allocation reporter must be a function/,
  );
  assert.throws(
    () => new HighlightRenderer.prototype.collectGpuAllocations.call(
      { _viewBuffers: new Map() },
      null,
    ),
    TypeError,
  );
});
