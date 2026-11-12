/**
 * Every mover drawn by script stops under reduced motion (`assets/css/README.md`
 * Site Design Principles 8), reading the one preference
 * (`utils/reduced-motion.js`): the highlight pulse holds its still picture
 * and the smoke stops drifting, so a still scene asks for no frames. The
 * velocity overlay's still picture: `velocity-still-flow-contract.test.mjs`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

// The platform's preference, switched by the tests (the module keeps the
// MediaQueryList it is handed and reads `matches` live).
const media = {
  matches: false,
  addEventListener() {},
  removeEventListener() {},
};
const originalMatchMedia = globalThis.matchMedia;
globalThis.matchMedia = () => media;
test.after(() => {
  if (originalMatchMedia === undefined) delete globalThis.matchMedia;
  else globalThis.matchMedia = originalMatchMedia;
});

const { HighlightRenderer } = await import('../assets/js/rendering/highlight-renderer.js');
const { HIGHLIGHT_STYLES_BY_QUALITY } = await import('../assets/js/rendering/shaders/high-perf-shaders.js');
const { SmokeRenderer } = await import('../assets/js/rendering/smoke-cloud/smoke-renderer.js');

test('the highlight pulse stops under reduced motion and resumes when it clears', () => {
  const renderer = Object.assign(Object.create(HighlightRenderer.prototype), {
    _styleGeneration: 0,
    _totalHighlightedCount: 5,
    highlightStylesByQuality: HIGHLIGHT_STYLES_BY_QUALITY,
  });
  renderer.setQuality('full');
  media.matches = false;
  assert.equal(renderer.isAnimated(), true, 'the animated style pulses');
  media.matches = true;
  try {
    assert.equal(renderer.isAnimated(), false, 'reduced motion: a still picture, no frames');
  } finally {
    media.matches = false;
  }
  assert.equal(renderer.isAnimated(), true);
  // The draw takes the still style's time (zero) whenever it does not pulse.
  const draw = HighlightRenderer.prototype.draw.toString();
  assert.match(draw, /const highlightTime = this\._pulses\(\)\n\s*\? exactFrameTimeSeconds - this\.startTime \* 0\.001\n\s*: 0;/);
});

test('the smoke stops drifting under reduced motion: its time holds and it asks for no frames', () => {
  const renderer = Object.assign(Object.create(SmokeRenderer.prototype), {
    contextLost: false,
    disposed: false,
    _disposeStarted: false,
    textureInfo: {},
    animationSpeed: 1,
    noiseTextures: null,
  });
  media.matches = false;
  assert.equal(renderer.needsContinuousFrames(), true);
  media.matches = true;
  try {
    assert.equal(renderer.needsContinuousFrames(), false);
  } finally {
    media.matches = false;
  }
  const draw = SmokeRenderer.prototype.render.toString();
  assert.match(draw, /const nextAnimationTime = this\._lastRenderTime === null \|\| !this\._drifts\(\)\n\s*\? this\.animationTime/);
});

test('the camera does not glide under reduced motion: no inertia after a release, a zoom at once, free-fly stops with its keys', async () => {
  const { readFileSync } = await import('node:fs');
  const viewer = readFileSync(new URL('../assets/js/rendering/viewer.js', import.meta.url), 'utf8');
  const body = name => {
    const start = viewer.indexOf(`function ${name}(`);
    assert.ok(start >= 0, name);
    return viewer.slice(start, viewer.indexOf('\n  }\n', start));
  };
  assert.match(
    body('updateInertia'),
    /^function updateInertia\(dt\) \{\n(\s*\/\/.*\n)*\s*if \(prefersReducedMotion\(\) && !isMovementKeyHeld\(\)\) \{\n\s*velocityTheta = velocityPhi = velocityPanX = velocityPanY = velocityPanZ = 0;\n\s*return;/,
  );
  assert.match(
    body('updateSmoothZoom'),
    /^function updateSmoothZoom\(dt\) \{\n(\s*\/\/.*\n)*\s*if \(prefersReducedMotion\(\)\) \{\n\s*radius = targetRadius;\n\s*return;/,
  );
  assert.match(
    body('updateFreefly'),
    /\} else if \(prefersReducedMotion\(\)\) \{\n(\s*\/\/.*\n)*\s*vec3\.set\(freeflyVelocity, 0, 0, 0\);\n\s*\} else \{\n\s*\/\/ Coasting/,
  );
});
