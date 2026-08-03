import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const VIEWER_URL = new URL('../assets/js/rendering/viewer.js', import.meta.url);

test('viewer visualization setters expose one exact current contract', async () => {
  const source = await readFile(VIEWER_URL, 'utf8');

  assert.doesNotMatch(
    source,
    /case ['"]white['"]:\s*default:|Ignore storage failures|privacy mode/i,
    'unsupported backgrounds and storage failures must not become white/success',
  );
  assert.doesNotMatch(
    source,
    /setRenderMode\(mode\)\s*\{\s*renderMode\s*=\s*mode\s*===\s*['"]smoke['"]\s*\?\s*['"]smoke['"]\s*:\s*['"]points['"]/,
    'unsupported render modes must not become points',
  );
  assert.doesNotMatch(
    source,
    /setPointSize\(size\)\s*\{\s*basePointSize\s*=\s*size|setSizeAttenuation\(value\)\s*\{\s*sizeAttenuation\s*=\s*value|setLightingStrength\(value\)\s*\{\s*lightingStrength\s*=\s*value|setFogDensity\(value\)\s*\{\s*fogDensity\s*=\s*Math\.max/,
    'primary renderer scalars require finite closed-range validation',
  );
  assert.doesNotMatch(
    source,
    /function applyViewerBackgroundMode|cellucid_viewer_background|localStorage\.setItem/,
    'the GPU viewer must not also own browser preference persistence',
  );
  // The bound is imported rather than written here: the slider curve in
  // `render-controls.js` and this bound are the same contract, and the two
  // literals they used to be could disagree — a slider reaching below the
  // viewer's floor throws at its own low end, with nothing the user can do.
  assert.match(
    source,
    /setPointSize\(size\)\s*\{[\s\S]{0,240}assertFiniteNumberInRange\(\s*size,\s*MINIMUM_POINT_SIZE,\s*MAXIMUM_POINT_SIZE,\s*['"]Point size['"]\s*\)/,
  );
  assert.match(
    source,
    /import\s*\{[^}]*MINIMUM_POINT_SIZE[^}]*\}\s*from\s*'\.\/point-size-scale\.js'/,
  );
  assert.doesNotMatch(
    source,
    /assertFiniteNumberInRange\(\s*size,\s*0\.(25|05)\s*,/,
    'the point-size bound must not be re-stated as a literal',
  );
  assert.match(
    source,
    /setLightingStrength\(value\)\s*\{[\s\S]{0,180}assertFiniteNumberInRange\(value,\s*0,\s*1,\s*['"]Lighting strength['"]\)/,
  );
  assert.match(
    source,
    /setFogDensity\(value\)\s*\{[\s\S]{0,180}assertFiniteNumberInRange\(value,\s*0,\s*1,\s*['"]Fog density['"]\)/,
  );
  assert.match(
    source,
    /setSizeAttenuation\(value\)\s*\{[\s\S]{0,400}assertFiniteNumberInRange\([\s\S]{0,120}['"]Perspective size scaling['"]\s*\)/,
  );
  assert.doesNotMatch(
    source,
    /setOrbitInvertX\s*\(|setShowConnectivity\(show\)\s*\{\s*showConnectivity\s*=\s*!!|setLiveViewHidden\(hidden\)\s*\{\s*liveViewHidden\s*=\s*Boolean|setLiveViewLabel\(label\)\s*\{\s*liveViewLabel\s*=\s*label\s*\|\||setConnectivity(LineWidth|Alpha)\([^)]*\)\s*\{[^}]*Math\.(max|min)/,
    'public renderer controls must not expose aliases, coercion, defaults, or clamps',
  );
  assert.match(
    source,
    /setLookSensitivity\(value\)\s*\{[\s\S]{0,220}assertFiniteNumberInRange\([\s\S]{0,120}['"]Look sensitivity['"]\s*\)/,
  );
  assert.match(
    source,
    /setPointerLockEnabled\(enabled\)\s*\{[\s\S]{0,220}assertExactBoolean\(enabled,\s*['"]Pointer lock['"]\)/,
  );
  assert.match(
    source,
    /setConnectivityColor\(r,\s*g,\s*b\)\s*\{[\s\S]{0,400}assertIntegerInRange\(r,\s*0,\s*255,[\s\S]{0,240}assertIntegerInRange\(b,\s*0,\s*255,/,
  );
});
