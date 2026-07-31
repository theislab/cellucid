import assert from 'node:assert/strict';
import test from 'node:test';

import { BenchmarkReporter } from '../assets/js/dev/benchmark.js';

test('the environment report records the canvas backing store it drew at', () => {
  // Device pixel ratio alone does not give the pixel count: the backing store
  // may be clamped below the CSS size. A fill-rate result without the pixel
  // count it was measured at cannot be compared with any other result.
  const reporter = new BenchmarkReporter({
    canvas: {
      width: 2880,
      height: 2000,
      clientWidth: 1440,
      clientHeight: 1000,
      getContext: () => null
    }
  });
  const canvas = reporter._collectCanvasBackingStore();
  assert.deepEqual(canvas, {
    width: 2880,
    height: 2000,
    clientWidth: 1440,
    clientHeight: 1000,
    backingStorePixels: 5_760_000
  });
});

test('a report with no canvas states that, rather than inventing a size', () => {
  assert.equal(new BenchmarkReporter()._collectCanvasBackingStore(), null);
  const partial = new BenchmarkReporter({
    canvas: { width: Number.NaN, height: 100, getContext: () => null }
  })._collectCanvasBackingStore();
  assert.equal(partial.width, null);
  assert.equal(partial.backingStorePixels, null);
});

test('the hardware section carries the canvas beside the viewport', () => {
  const reporter = new BenchmarkReporter({
    canvas: { width: 800, height: 600, clientWidth: 800, clientHeight: 600 }
  });
  const hardware = reporter._collectHardware(
    { hardwareConcurrency: 8, userAgent: 'node', maxTouchPoints: 0 },
    {}
  );
  assert.equal(hardware.canvas.backingStorePixels, 480_000);
  assert.equal(Object.hasOwn(hardware, 'viewport'), true);
});
