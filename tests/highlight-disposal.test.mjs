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
} = {}) {
  return Object.assign(Object.create(HighlightRenderer.prototype), {
    gl,
    hpRenderer: {},
    program,
    attribLocations: {},
    uniformLocations: {},
    _viewBuffers: new Map(
      buffers.map((buffer, index) => [
        index === 0 ? 'live' : `snapshot-${index}`,
        {
          buffer,
          pointCount: pointCounts[index] ?? 1,
          lodSignature: -1,
          positionsFingerprint: 0,
        },
      ])
    ),
    _pendingBufferDeletes: new Set(),
    _pendingProgramDeletes: new Set(),
    _disposeStarted: false,
    _disposed: false,
    _totalHighlightedCount: pointCounts.reduce(
      (total, count) => total + count,
      0
    ),
    _highlightedIndicesCache: [],
    _highlightDataRef: new Uint8Array(),
    _highlightDataFingerprint: 0,
  });
}

test('zero-visible highlight rebuilds publish an exact total count', () => {
  const renderer = createRendererForDisposal(
    {
      bindBuffer() {
        throw new Error('an empty highlight generation must not upload');
      },
    },
    {
      buffers: [{ id: 'live-buffer' }],
      pointCounts: [1],
    }
  );

  renderer.rebuildBuffer(
    Uint8Array.from([0]),
    Float32Array.from([0, 0, 0]),
    null,
    -1,
    'live',
    Float32Array.from([1])
  );

  assert.equal(renderer.getTotalPointCount(), 0);
  assert.equal(renderer.getPointCount('live'), 0);
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

  assert.equal(renderer.clearViewBuffer('snapshot-1'), false);
  assert.equal(deleteAttempts, 2);
  assert.equal(renderer._pendingBufferDeletes.size, 0);
});

test('highlight renderer disposal attempts all owners and retries only failures', () => {
  const failedBuffer = { id: 'failed-buffer' };
  const successfulBuffer = { id: 'successful-buffer' };
  const program = { id: 'highlight-program' };
  const bufferAttempts = new Map();
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
    }
  );

  assert.throws(
    () => renderer.dispose(),
    error => (
      error instanceof AggregateError &&
      error.errors.length === 2
    )
  );
  assert.equal(renderer._viewBuffers.size, 0);
  assert.equal(renderer.program, null);
  assert.equal(renderer.getTotalPointCount(), 0);
  assert.equal(renderer._pendingBufferDeletes.has(failedBuffer), true);
  assert.equal(renderer._pendingBufferDeletes.has(successfulBuffer), false);
  assert.equal(renderer._pendingProgramDeletes.has(program), true);

  assert.equal(renderer.dispose(), true);
  assert.equal(renderer.dispose(), false);
  assert.equal(bufferAttempts.get(failedBuffer), 2);
  assert.equal(bufferAttempts.get(successfulBuffer), 1);
  assert.equal(programAttempts, 2);
  assert.equal(renderer.gl, null);
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
    _lastUsedPositionsMap: new Map([['live', new Float32Array(3)]]),
    _lastPositionFingerprintMap: new Map([['live', 'positions']]),
    _lastTransparencyFingerprintMap: new Map([['live', 'alpha']]),
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
