import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HighlightRenderer,
  HighlightTools,
} from '../assets/js/rendering/highlight-renderer.js';

function createRendererForDisposal(gl, {
  buffers = [],
  pointCounts = [],
  program = null,
  vertexArrays = buffers.map(
    (_buffer, index) => ({ id: `vertex-array-${index}` })
  ),
} = {}) {
  const exactGl = {
    deleteVertexArray() {},
    ...gl,
  };
  return Object.assign(Object.create(HighlightRenderer.prototype), {
    gl: exactGl,
    hpRenderer: {},
    program,
    attribLocations: {
      color: 1,
      position: 0,
    },
    uniformLocations: {},
    _viewBuffers: new Map(
      buffers.map((buffer, index) => [
        index === 0 ? 'live' : `snapshot-${index}`,
        {
          buffer,
          dimensionLevel: 3,
          geometryGeneration: 1,
          highlightGeneration: 0,
          lodMembership: null,
          pointCount: pointCounts[index] ?? 1,
          published: true,
          transparencyGeneration: 0,
          vertexArray: vertexArrays[index],
        },
      ])
    ),
    _pendingBufferDeletes: new Set(),
    _pendingVertexArrayDeletes: new Set(),
    _pendingProgramDeletes: new Set(),
    _disposeStarted: false,
    _disposed: false,
    _totalHighlightedCount: pointCounts.reduce(
      (total, count) => total + count,
      0
    ),
    _highlightedIndicesCache: [],
    _highlightDataRef: new Uint8Array(),
    _highlightDataVersion: 0,
  });
}

test('zero-visible highlight rebuilds retire dataset-sized GPU storage before publishing empty', () => {
  const buffer = { id: 'live-buffer' };
  const deletedBuffers = [];
  const renderer = createRendererForDisposal(
    {
      bindBuffer() {
        throw new Error('an empty highlight generation must not upload');
      },
      deleteBuffer(candidate) {
        deletedBuffers.push(candidate);
      },
    },
    {
      buffers: [buffer],
      pointCounts: [1],
    }
  );

  renderer.rebuildBuffer(
    Uint8Array.from([0]),
    Float32Array.from([0, 0, 0]),
    null,
    'live',
    Float32Array.from([1]),
    1,
    3,
    0
  );

  assert.equal(renderer.getTotalPointCount(), 0);
  assert.equal(renderer.getPointCount('live'), 0);
  assert.equal(renderer._viewBuffers.get('live').buffer, null);
  assert.equal(renderer._viewBuffers.get('live').vertexArray, null);
  assert.deepEqual(deletedBuffers, [buffer]);
  assert.equal(renderer._pendingBufferDeletes.size, 0);
  assert.equal(renderer._pendingVertexArrayDeletes.size, 0);
  assert.doesNotThrow(() => renderer.draw({
    dimensionLevel: 3,
    viewId: 'live',
  }));
});

test('empty publication commits no-draw state and retains hostile cleanup for an explicit retry owner', () => {
  const buffer = { id: 'large-live-buffer' };
  let deleteAttempts = 0;
  const renderer = createRendererForDisposal(
    {
      deleteBuffer(candidate) {
        assert.equal(candidate, buffer);
        deleteAttempts++;
        if (deleteAttempts === 1) {
          throw new Error('synthetic empty-publication deletion failure');
        }
      },
    },
    {
      buffers: [buffer],
      pointCounts: [1_000_000],
    }
  );

  assert.throws(
    () => renderer.publishEmptyView('live'),
    error => (
      error instanceof AggregateError &&
      error.errors.some(item => (
        /empty-publication deletion failure/.test(item.message)
      ))
    )
  );

  const published = renderer._viewBuffers.get('live');
  assert.equal(published.buffer, null);
  assert.equal(published.vertexArray, null);
  assert.equal(published.pointCount, 0);
  assert.equal(published.published, true);
  assert.equal(renderer.getTotalPointCount(), 0);
  assert.equal(renderer._pendingBufferDeletes.has(buffer), true);
  assert.equal(renderer._pendingVertexArrayDeletes.size, 0);
  assert.doesNotThrow(() => renderer.draw({
    dimensionLevel: 3,
    viewId: 'live',
  }));

  // A stable empty animation frame is a cache hit and does not turn one
  // hostile deletion into an unbounded RAF retry loop.
  assert.equal(renderer.publishEmptyView('live'), false);
  assert.equal(deleteAttempts, 1);

  // Explicit lifecycle cleanup remains the retry owner and converges.
  assert.equal(renderer.clearViewBuffer('live'), true);
  assert.equal(deleteAttempts, 2);
  assert.equal(renderer._pendingBufferDeletes.size, 0);
});

test('empty highlight updates detach every hidden-view buffer before hostile cleanup', () => {
  const buffers = Array.from(
    { length: 4 },
    (_, index) => ({ id: `buffer-${index}` })
  );
  const vertexArrays = Array.from(
    { length: 4 },
    (_, index) => ({ id: `vertex-array-${index}` })
  );
  const deletionAttempts = [];
  const vertexArrayDeletionAttempts = [];
  const renderer = createRendererForDisposal(
    {
      deleteBuffer(buffer) {
        deletionAttempts.push(buffer);
        if (buffer === buffers[0]) {
          throw new Error('synthetic first-view deletion failure');
        }
      },
      deleteVertexArray(vertexArray) {
        vertexArrayDeletionAttempts.push(vertexArray);
        if (vertexArray === vertexArrays[0]) {
          throw new Error(
            'synthetic first-view vertex-array deletion failure'
          );
        }
      },
    },
    {
      buffers,
      pointCounts: [30_000_000, 30_000_000, 30_000_000, 30_000_000],
      vertexArrays,
    }
  );
  const tools = Object.assign(Object.create(HighlightTools.prototype), {
    highlightArray: null,
    highlightRenderer: renderer,
  });

  assert.throws(
    () => tools.updateHighlight(new Uint8Array(4), []),
    error => (
      error instanceof AggregateError &&
      error.errors.some(item => (
        /first-view deletion failure/.test(item.message)
      ))
    )
  );

  assert.deepEqual(deletionAttempts, buffers);
  assert.deepEqual(vertexArrayDeletionAttempts, vertexArrays);
  assert.equal(renderer.getTotalPointCount(), 0);
  for (const viewBuffer of renderer._viewBuffers.values()) {
    assert.equal(viewBuffer.buffer, null);
    assert.equal(viewBuffer.vertexArray, null);
    assert.equal(viewBuffer.pointCount, 0);
    assert.equal(viewBuffer.published, true);
  }
  assert.deepEqual(
    [...renderer._pendingBufferDeletes],
    [buffers[0]]
  );
  assert.deepEqual(
    [...renderer._pendingVertexArrayDeletes],
    [vertexArrays[0]]
  );
});

test('empty publication retries only the failed owner from one detached VAO/buffer pair', () => {
  const buffer = { id: 'paired-buffer' };
  const vertexArray = { id: 'paired-vertex-array' };
  let bufferDeleteAttempts = 0;
  let vertexArrayDeleteAttempts = 0;
  const renderer = createRendererForDisposal(
    {
      deleteBuffer(candidate) {
        assert.equal(candidate, buffer);
        bufferDeleteAttempts++;
      },
      deleteVertexArray(candidate) {
        assert.equal(candidate, vertexArray);
        vertexArrayDeleteAttempts++;
        if (vertexArrayDeleteAttempts === 1) {
          throw new Error(
            'synthetic paired vertex-array deletion failure'
          );
        }
      },
    },
    {
      buffers: [buffer],
      pointCounts: [1],
      vertexArrays: [vertexArray],
    }
  );

  assert.throws(
    () => renderer.publishEmptyView('live'),
    error => (
      error instanceof AggregateError &&
      error.errors.some(item => (
        /paired vertex-array deletion failure/.test(item.message)
      ))
    )
  );
  const published = renderer._viewBuffers.get('live');
  assert.equal(published.buffer, null);
  assert.equal(published.vertexArray, null);
  assert.equal(published.pointCount, 0);
  assert.equal(bufferDeleteAttempts, 1);
  assert.equal(vertexArrayDeleteAttempts, 1);
  assert.equal(renderer._pendingBufferDeletes.size, 0);
  assert.deepEqual(
    [...renderer._pendingVertexArrayDeletes],
    [vertexArray]
  );

  assert.equal(renderer.clearViewBuffer('live'), true);
  assert.equal(bufferDeleteAttempts, 1);
  assert.equal(vertexArrayDeleteAttempts, 2);
  assert.equal(renderer._pendingVertexArrayDeletes.size, 0);
});

test('zero-length highlight updates retire hidden views without a supplied index cache', () => {
  let invalidations = 0;
  let emptyPublications = 0;
  const renderer = {
    _highlightedIndicesCache: null,
    invalidateHighlightCache() {
      invalidations++;
    },
    publishEmptyViews() {
      emptyPublications++;
      return true;
    },
  };
  const tools = Object.assign(Object.create(HighlightTools.prototype), {
    highlightArray: null,
    highlightRenderer: renderer,
  });

  tools.updateHighlight(new Uint8Array());

  assert.equal(invalidations, 1);
  assert.equal(emptyPublications, 1);
});

test('view-buffer retirement detaches before deletion and retries the exact owner', () => {
  const buffer = { id: 'snapshot-buffer' };
  let deleteAttempts = 0;
  const renderer = createRendererForDisposal(
    {
      deleteBuffer(candidate) {
        assert.equal(candidate, buffer);
        deleteAttempts++;
        if (deleteAttempts === 1) {
          throw new Error('synthetic highlight buffer deletion failure');
        }
      },
    },
    {
      buffers: [
        { id: 'live-buffer' },
        buffer,
      ],
      pointCounts: [2, 3],
    }
  );
  renderer._viewBuffers.delete('live');
  renderer._totalHighlightedCount = 3;

  assert.throws(
    () => renderer.clearViewBuffer('snapshot-1'),
    error => (
      error instanceof AggregateError &&
      error.errors.some(item => (
        /synthetic highlight buffer deletion failure/.test(item.message)
      ))
    )
  );
  assert.equal(renderer._viewBuffers.has('snapshot-1'), false);
  assert.equal(renderer.getTotalPointCount(), 0);
  assert.equal(renderer._pendingBufferDeletes.has(buffer), true);
  assert.equal(renderer._pendingVertexArrayDeletes.size, 0);

  assert.equal(renderer.clearViewBuffer('snapshot-1'), false);
  assert.equal(deleteAttempts, 2);
  assert.equal(renderer._pendingBufferDeletes.size, 0);
  assert.equal(renderer._pendingVertexArrayDeletes.size, 0);
});

test('highlight renderer disposal attempts all owners and retries only failures', () => {
  const failedBuffer = { id: 'failed-buffer' };
  const successfulBuffer = { id: 'successful-buffer' };
  const failedVertexArray = { id: 'failed-vertex-array' };
  const successfulVertexArray = { id: 'successful-vertex-array' };
  const program = { id: 'highlight-program' };
  const bufferAttempts = new Map();
  const vertexArrayAttempts = new Map();
  let programAttempts = 0;
  const renderer = createRendererForDisposal(
    {
      deleteBuffer(buffer) {
        const attempts = (bufferAttempts.get(buffer) ?? 0) + 1;
        bufferAttempts.set(buffer, attempts);
        if (buffer === failedBuffer && attempts === 1) {
          throw new Error('synthetic terminal buffer failure');
        }
      },
      deleteVertexArray(vertexArray) {
        const attempts =
          (vertexArrayAttempts.get(vertexArray) ?? 0) + 1;
        vertexArrayAttempts.set(vertexArray, attempts);
        if (
          vertexArray === failedVertexArray &&
          attempts === 1
        ) {
          throw new Error(
            'synthetic terminal vertex-array failure'
          );
        }
      },
      deleteProgram(candidate) {
        assert.equal(candidate, program);
        programAttempts++;
        if (programAttempts === 1) {
          throw new Error('synthetic terminal program failure');
        }
      },
    },
    {
      buffers: [failedBuffer, successfulBuffer],
      pointCounts: [2, 3],
      program,
      vertexArrays: [failedVertexArray, successfulVertexArray],
    }
  );

  assert.throws(
    () => renderer.dispose(),
    error => (
      error instanceof AggregateError &&
      error.errors.length === 3
    )
  );
  assert.equal(renderer._viewBuffers.size, 0);
  assert.equal(renderer.program, null);
  assert.equal(renderer.getTotalPointCount(), 0);
  assert.equal(renderer._pendingBufferDeletes.has(failedBuffer), true);
  assert.equal(renderer._pendingBufferDeletes.has(successfulBuffer), false);
  assert.equal(
    renderer._pendingVertexArrayDeletes.has(failedVertexArray),
    true
  );
  assert.equal(
    renderer._pendingVertexArrayDeletes.has(successfulVertexArray),
    false
  );
  assert.equal(renderer._pendingProgramDeletes.has(program), true);

  assert.equal(renderer.dispose(), true);
  assert.equal(renderer.dispose(), false);
  assert.equal(bufferAttempts.get(failedBuffer), 2);
  assert.equal(bufferAttempts.get(successfulBuffer), 1);
  assert.equal(vertexArrayAttempts.get(failedVertexArray), 2);
  assert.equal(vertexArrayAttempts.get(successfulVertexArray), 1);
  assert.equal(programAttempts, 2);
  assert.equal(renderer.gl, null);
});

test('highlight renderer context loss drops handles without WebGL deletion', () => {
  const buffer = { id: 'lost-buffer' };
  const vertexArray = { id: 'lost-vertex-array' };
  const program = { id: 'lost-program' };
  const calls = [];
  const renderer = createRendererForDisposal(
    {
      deleteBuffer() {
        calls.push('deleteBuffer');
      },
      deleteProgram() {
        calls.push('deleteProgram');
      },
      deleteVertexArray() {
        calls.push('deleteVertexArray');
      },
    },
    {
      buffers: [buffer],
      pointCounts: [5_000_000],
      program,
      vertexArrays: [vertexArray],
    }
  );

  assert.equal(renderer.handleContextLost(), true);
  assert.equal(renderer.handleContextLost(), false);
  assert.equal(renderer._viewBuffers.size, 0);
  assert.equal(renderer._pendingBufferDeletes.size, 0);
  assert.equal(renderer._pendingVertexArrayDeletes.size, 0);
  assert.equal(renderer._pendingProgramDeletes.size, 0);
  assert.equal(renderer.getTotalPointCount(), 0);
  assert.equal(renderer.program, null);
  assert.equal(renderer.gl, null);
  assert.equal(renderer.dispose(), false);
  assert.deepEqual(calls, []);
});

test('highlight tools disposal fences callbacks and attempts every DOM/GPU owner', () => {
  const callbackNames = [
    'cellSelectionCallback',
    'selectionPreviewCallback',
    'selectionStepCallback',
    'lassoCallback',
    'lassoPreviewCallback',
    'lassoStepCallback',
    'proximityCallback',
    'proximityPreviewCallback',
    'proximityStepCallback',
    'knnCallback',
    'knnPreviewCallback',
    'knnStepCallback',
    'knnEdgeLoadCallback',
    'pickCellAtScreen',
    'screenToRay',
    'getViewportInfoAtScreen',
    'getRenderContext',
    'getNavigationState',
    'getViewPositions',
    'getViewTransparency',
    'getSpatialQueryOwner',
  ];
  const classRemovalAttempts = new Map();
  let cursorCleanupAttempts = 0;
  let cursor = 'crosshair';
  const canvas = {
    classList: {
      remove(className) {
        const attempts = (classRemovalAttempts.get(className) ?? 0) + 1;
        classRemovalAttempts.set(className, attempts);
        if (className === 'lassoing' && attempts === 1) {
          throw new Error('synthetic lasso class cleanup failure');
        }
      },
    },
    style: {
      get cursor() {
        return cursor;
      },
      set cursor(value) {
        cursorCleanupAttempts++;
        cursor = value;
      },
    },
  };
  let observerDisconnectAttempts = 0;
  const resizeSubscription = {
    disconnect() {
      observerDisconnectAttempts++;
      if (observerDisconnectAttempts === 1) {
        throw new Error('synthetic resize observer cleanup failure');
      }
    },
  };
  let lassoCanvasRemoveAttempts = 0;
  const lassoCanvas = {
    remove() {
      lassoCanvasRemoveAttempts++;
    },
  };
  let rendererDisposeAttempts = 0;
  const renderer = {
    dispose() {
      rendererDisposeAttempts++;
      if (rendererDisposeAttempts === 1) {
        throw new Error('synthetic nested renderer cleanup failure');
      }
    },
  };
  const callback = () => {};
  const tools = Object.assign(Object.create(HighlightTools.prototype), {
    _disposeState: null,
    _disposed: false,
    _lassoResizeSubscription: resizeSubscription,
    _previousCanvasCursor: 'wait',
    _lassoParentPositionLease: {
      parentElement: {},
      record: {},
      released: false,
    },
    canvas,
    lassoCanvas,
    lassoCtx: {},
    highlightRenderer: renderer,
    highlightArray: new Uint8Array(1024),
    _transparencyGenerations: new Map([['live', 1]]),
    knnAdjacencyList: new Map([[0, Uint32Array.from([1])]]),
    mat4: {},
    vec3: {},
    gl: {},
    hpRenderer: {},
  });
  for (const callbackName of callbackNames) {
    tools[callbackName] = callback;
  }

  assert.throws(
    () => tools.dispose(),
    error => (
      error instanceof AggregateError &&
      error.errors.length === 3
    )
  );
  assert.equal(tools.canvas, null);
  assert.equal(tools.lassoCanvas, null);
  assert.equal(tools.lassoCtx, null);
  assert.equal(tools.highlightRenderer, null);
  assert.equal(tools.highlightArray, null);
  assert.equal(tools.knnAdjacencyList, null);
  for (const callbackName of callbackNames) {
    assert.equal(tools[callbackName], null, callbackName);
  }
  assert.deepEqual(
    [...tools._disposeState.canvasClasses],
    ['lassoing'],
    'only the failed canvas class remains retry-owned'
  );
  assert.equal(lassoCanvasRemoveAttempts, 1);
  assert.equal(cursorCleanupAttempts, 1);
  assert.equal(canvas.style.cursor, 'wait');

  assert.equal(tools.dispose(), true);
  assert.equal(tools.dispose(), false);
  assert.equal(observerDisconnectAttempts, 2);
  assert.equal(lassoCanvasRemoveAttempts, 1);
  assert.equal(rendererDisposeAttempts, 2);
  assert.equal(classRemovalAttempts.get('lassoing'), 2);
  assert.equal(classRemovalAttempts.get('lasso-mode'), 1);
  assert.equal(cursorCleanupAttempts, 1);
});
