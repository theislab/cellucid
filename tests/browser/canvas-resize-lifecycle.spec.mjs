import { expect, test } from './helpers/test.mjs';

const WEBGL_HARNESS = '/tests/browser/fixtures/webgl-harness.html';

test('canvas size tracker follows DPR generations without render-loop allocations', async ({
  page,
}) => {
  await page.goto(WEBGL_HARNESS);

  const proof = await page.evaluate(async () => {
    const {
      createCanvasResizeObserver,
    } = await import('/assets/js/rendering/gl-utils.js');
    let dpr = 1;
    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      get: () => dpr,
    });
    const mediaGenerations = [];
    window.matchMedia = query => {
      const listeners = new Set();
      const generation = {
        emit() {
          for (const listener of [...listeners]) {
            listener({ matches: false, media: query });
          }
        },
        get listenerCount() {
          return listeners.size;
        },
        query,
      };
      mediaGenerations.push(generation);
      return {
        addEventListener(type, listener) {
          if (type === 'change') listeners.add(listener);
        },
        removeEventListener(type, listener) {
          if (type === 'change') listeners.delete(listener);
        },
      };
    };
    let observerDisconnected = false;
    class FakeResizeObserver {
      observe() {}
      disconnect() {
        observerDisconnected = true;
      }
    }
    window.ResizeObserver = FakeResizeObserver;

    const canvas = document.createElement('canvas');
    Object.defineProperties(canvas, {
      clientHeight: { configurable: true, get: () => 10 },
      clientWidth: { configurable: true, get: () => 20 },
    });
    document.body.appendChild(canvas);
    const tracker = createCanvasResizeObserver(canvas);
    const initialSize = tracker.getSize();
    const repeatedSize = tracker.getSize();
    const initial = {
      height: initialSize.height,
      listeners: mediaGenerations.map(item => item.listenerCount),
      queries: mediaGenerations.map(item => item.query),
      stableIdentity: initialSize === repeatedSize,
      width: initialSize.width,
    };

    dpr = 2;
    mediaGenerations[0].emit();
    const changedSize = tracker.getSize();
    const afterDprChange = {
      canvasHeight: canvas.height,
      canvasWidth: canvas.width,
      height: changedSize.height,
      listeners: mediaGenerations.map(item => item.listenerCount),
      queries: mediaGenerations.map(item => item.query),
      stableIdentity: initialSize === changedSize,
      width: changedSize.width,
    };

    const retainedListenerGeneration = mediaGenerations.at(-1);
    tracker.disconnect();
    dpr = 3;
    retainedListenerGeneration.emit();
    const disconnectedSize = tracker.getSize();
    const afterDisconnect = {
      height: disconnectedSize.height,
      listeners: mediaGenerations.map(item => item.listenerCount),
      mediaGenerationCount: mediaGenerations.length,
      observerDisconnected,
      width: disconnectedSize.width,
    };
    canvas.remove();
    return {
      afterDisconnect,
      afterDprChange,
      initial,
    };
  });

  expect(proof).toEqual({
    initial: {
      height: 10,
      listeners: [1],
      queries: ['(resolution: 1dppx)'],
      stableIdentity: true,
      width: 20,
    },
    afterDprChange: {
      canvasHeight: 20,
      canvasWidth: 40,
      height: 20,
      listeners: [0, 1],
      queries: [
        '(resolution: 1dppx)',
        '(resolution: 2dppx)',
      ],
      stableIdentity: true,
      width: 40,
    },
    afterDisconnect: {
      height: 20,
      listeners: [0, 0],
      mediaGenerationCount: 2,
      observerDisconnected: true,
      width: 40,
    },
  });
});

test('canvas size tracker construction rolls back partially attached sources', async ({
  page,
}) => {
  await page.goto(WEBGL_HARNESS);

  const proof = await page.evaluate(async () => {
    const {
      createCanvasResizeObserver,
    } = await import('/assets/js/rendering/gl-utils.js');

    const runObserveFailure = () => {
      let disconnectCalls = 0;
      class FailingResizeObserver {
        observe() {
          throw new Error('synthetic resize observe failure');
        }
        disconnect() {
          disconnectCalls++;
        }
      }
      window.ResizeObserver = FailingResizeObserver;
      window.matchMedia = () => {
        throw new Error('DPR setup must not run after observe failure');
      };
      const canvas = document.createElement('canvas');
      let failure = null;
      try {
        createCanvasResizeObserver(canvas);
      } catch (error) {
        failure = error.message;
      }
      return {
        disconnectCalls,
        failure,
      };
    };

    const runDprFailure = () => {
      let disconnectCalls = 0;
      let listener = null;
      let removeCalls = 0;
      class FakeResizeObserver {
        observe() {}
        disconnect() {
          disconnectCalls++;
        }
      }
      window.ResizeObserver = FakeResizeObserver;
      window.matchMedia = () => ({
        addEventListener(type, candidate) {
          if (type === 'change') listener = candidate;
          throw new Error('synthetic DPR attach failure');
        },
        removeEventListener(type, candidate) {
          if (type === 'change' && candidate === listener) {
            removeCalls++;
            listener = null;
          }
        },
      });
      const canvas = document.createElement('canvas');
      let failure = null;
      try {
        createCanvasResizeObserver(canvas);
      } catch (error) {
        failure = error.message;
      }
      return {
        disconnectCalls,
        failure,
        listenerDetached: listener === null,
        removeCalls,
      };
    };

    return {
      dprFailure: runDprFailure(),
      observeFailure: runObserveFailure(),
    };
  });

  expect(proof).toEqual({
    dprFailure: {
      disconnectCalls: 1,
      failure: 'synthetic DPR attach failure',
      listenerDetached: true,
      removeCalls: 1,
    },
    observeFailure: {
      disconnectCalls: 1,
      failure: 'synthetic resize observe failure',
    },
  });
});

test('canvas size tracker fences callbacks and retries retained cleanup', async ({
  page,
}) => {
  await page.goto(WEBGL_HARNESS);

  const proof = await page.evaluate(async () => {
    const {
      createCanvasResizeObserver,
    } = await import('/assets/js/rendering/gl-utils.js');
    let dpr = 1;
    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      get: () => dpr,
    });
    let listener = null;
    let removeCalls = 0;
    let matchMediaCalls = 0;
    window.matchMedia = () => {
      matchMediaCalls++;
      return {
        addEventListener(type, candidate) {
          if (type === 'change') listener = candidate;
        },
        removeEventListener(type, candidate) {
          if (type !== 'change' || candidate !== listener) return;
          removeCalls++;
          if (removeCalls === 1) {
            throw new Error('synthetic DPR cleanup failure');
          }
          listener = null;
        },
      };
    };
    let disconnectCalls = 0;
    let resizeCallback = null;
    class FakeResizeObserver {
      constructor(callback) {
        resizeCallback = callback;
      }
      observe() {}
      disconnect() {
        disconnectCalls++;
        if (disconnectCalls === 1) {
          throw new Error('synthetic observer cleanup failure');
        }
      }
    }
    window.ResizeObserver = FakeResizeObserver;
    const canvas = document.createElement('canvas');
    Object.defineProperties(canvas, {
      clientHeight: { configurable: true, get: () => 10 },
      clientWidth: { configurable: true, get: () => 20 },
    });
    const tracker = createCanvasResizeObserver(canvas);
    const retainedListener = listener;

    let firstFailure = null;
    try {
      tracker.disconnect();
    } catch (error) {
      firstFailure = {
        messages: error.errors.map(item => item.message),
        name: error.name,
      };
    }
    dpr = 2;
    retainedListener({ matches: false });
    resizeCallback([{
      contentRect: {
        height: 200,
        width: 300,
      },
    }]);
    const fencedSize = tracker.getSize();
    tracker.disconnect();
    return {
      disconnectCalls,
      fencedSize: [fencedSize.width, fencedSize.height],
      firstFailure,
      listenerDetached: listener === null,
      matchMediaCalls,
      removeCalls,
    };
  });

  expect(proof).toEqual({
    disconnectCalls: 2,
    fencedSize: [20, 10],
    firstFailure: {
      messages: [
        'synthetic observer cleanup failure',
        'synthetic DPR cleanup failure',
      ],
      name: 'AggregateError',
    },
    listenerDetached: true,
    matchMediaCalls: 1,
    removeCalls: 2,
  });
});
