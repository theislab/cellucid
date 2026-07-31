import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertBaselineEligibleRasterizer,
  classifyRasterizer,
  readRendererIdentity,
  rendererBaselineKey,
  SOFTWARE_RASTERIZER_MARKERS
} from '../assets/js/app/ui/modules/benchmark/renderer-identity.js';

const DEBUG_RENDERER_INFO = Object.freeze({
  UNMASKED_RENDERER_WEBGL: 0x9246,
  UNMASKED_VENDOR_WEBGL: 0x9245
});

function createContext({
  renderer = 'ANGLE (Apple, Apple M3 Max, OpenGL 4.1)',
  vendor = 'Google Inc. (Apple)',
  debugInfo = true,
  timerQuery = false,
  canvasWidth = 2880,
  canvasHeight = 2000,
  drawingBufferWidth = 2880,
  drawingBufferHeight = 2000
} = {}) {
  const values = new Map([
    [0x1f01, 'WebKit WebGL'],
    [0x1f00, 'WebKit'],
    [0x1f02, 'WebGL 2.0'],
    [0x8b8c, 'WebGL GLSL ES 3.00'],
    [DEBUG_RENDERER_INFO.UNMASKED_RENDERER_WEBGL, renderer],
    [DEBUG_RENDERER_INFO.UNMASKED_VENDOR_WEBGL, vendor]
  ]);
  return {
    RENDERER: 0x1f01,
    VENDOR: 0x1f00,
    VERSION: 0x1f02,
    SHADING_LANGUAGE_VERSION: 0x8b8c,
    canvas: { width: canvasWidth, height: canvasHeight },
    drawingBufferWidth,
    drawingBufferHeight,
    getParameter(parameter) {
      return values.get(parameter) ?? null;
    },
    getExtension(name) {
      if (name === 'WEBGL_debug_renderer_info') {
        return debugInfo ? DEBUG_RENDERER_INFO : null;
      }
      if (name === 'EXT_disjoint_timer_query_webgl2') {
        return timerQuery ? {} : null;
      }
      return null;
    }
  };
}

test('the identity carries the canvas backing store, not only the ratio', () => {
  // A fill-rate result without a pixel count cannot be compared with anything,
  // and the device pixel ratio alone does not give it: the canvas may clamp.
  const identity = readRendererIdentity(createContext());
  assert.equal(identity.canvas.width, 2880);
  assert.equal(identity.canvas.height, 2000);
  assert.equal(identity.canvas.drawingBufferWidth, 2880);
  assert.equal(identity.canvas.drawingBufferHeight, 2000);
  assert.equal(identity.canvas.backingStorePixels, 2880 * 2000);
  assert.equal(identity.unmaskedRenderer, 'ANGLE (Apple, Apple M3 Max, OpenGL 4.1)');
  assert.equal(identity.debugRendererInfoAvailable, true);
  assert.equal(identity.timerQueryAvailable, false);
  assert.equal(identity.version, 'WebGL 2.0');
});

test('a clamped backing store is reported apart from the CSS size', () => {
  const identity = readRendererIdentity(
    createContext({
      canvasWidth: 4000,
      canvasHeight: 3000,
      drawingBufferWidth: 2048,
      drawingBufferHeight: 1536
    })
  );
  assert.equal(identity.canvas.width, 4000);
  assert.equal(identity.canvas.drawingBufferWidth, 2048);
  assert.equal(identity.canvas.backingStorePixels, 2048 * 1536);
});

test('a software rasterizer is refused as a baseline, by name', () => {
  // Headless Chromium selects SwiftShader by default. A frame time measured
  // there describes the CPU, so it is void rather than merely slow.
  for (const marker of SOFTWARE_RASTERIZER_MARKERS) {
    const identity = readRendererIdentity(
      createContext({ renderer: `Google ${marker} (subzero)` })
    );
    const classification = classifyRasterizer(identity);
    assert.equal(classification.kind, 'software', marker);
    assert.equal(classification.baselineEligible, false, marker);
    assert.equal(classification.matchedMarker, marker);
    assert.throws(
      () => assertBaselineEligibleRasterizer(identity),
      /Benchmark baseline refused/,
      marker
    );
  }
});

test('a missing unmasked string is unknown, never assumed to be hardware', () => {
  const identity = readRendererIdentity(createContext({ debugInfo: false }));
  const classification = classifyRasterizer(identity);
  assert.equal(classification.kind, 'unknown');
  assert.equal(classification.baselineEligible, false);
  assert.match(classification.reason, /cannot be identified/);
  assert.throws(
    () => assertBaselineEligibleRasterizer(identity),
    /Benchmark baseline refused/
  );
});

test('hardware rasterization is eligible and keyed by its own name', () => {
  const identity = readRendererIdentity(createContext());
  const classification = assertBaselineEligibleRasterizer(identity);
  assert.equal(classification.kind, 'hardware');
  assert.equal(classification.baselineEligible, true);
  assert.equal(
    rendererBaselineKey(identity),
    'angle-apple-apple-m3-max-opengl-4-1'
  );
});

test('a baseline key never collides with a path separator', () => {
  const identity = readRendererIdentity(
    createContext({ renderer: '../../etc/passwd (NVIDIA)' })
  );
  const key = rendererBaselineKey(identity);
  assert.match(key, /^[a-z0-9-]+$/);
  assert.equal(key.includes('/'), false);
});

test('identity reading refuses anything that is not a GL context', () => {
  assert.throws(() => readRendererIdentity(null), /WebGL2 rendering context/);
  assert.throws(() => readRendererIdentity({}), /WebGL2 rendering context/);
  assert.throws(() => classifyRasterizer(null), /requires one identity/);
});
