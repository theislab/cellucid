import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

function extractSourceRange(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

test('default-grid rendering owns immutable plane descriptors outside the per-pane hot path', async () => {
  const source = await readFile(
    new URL('../assets/js/rendering/viewer.js', import.meta.url),
    'utf8',
  );
  const drawGridSource = extractSourceRange(
    source,
    'function drawGrid()',
    '// Smoothstep helper for smooth transitions',
  );

  assert.match(
    source,
    /const gridPlaneDescriptors = Object\.freeze\(\[/,
    'grid plane descriptors must be allocated once with the viewer generation',
  );
  assert.doesNotMatch(
    drawGridSource,
    /\bconst\s+viewDir\s*=\s*\[/,
    'drawGrid must not allocate a direction array for every pane and frame',
  );
  assert.doesNotMatch(
    drawGridSource,
    /\bconst\s+planes\s*=\s*\[/,
    'drawGrid must not allocate plane objects and normals for every pane and frame',
  );
  assert.match(drawGridSource, /\bviewDirX\b/);
  assert.match(drawGridSource, /\bviewDirY\b/);
  assert.match(drawGridSource, /\bviewDirZ\b/);
});

test('custom snapshot fog derives scalar bounds while the render hot path stays allocation-free', async () => {
  const source = await readFile(
    new URL(
      '../assets/js/rendering/high-perf-renderer.js',
      import.meta.url,
    ),
    'utf8',
  );
  const fogScalarSource = extractSourceRange(
    source,
    '_writeFogRange(cameraPosition, overrideBounds, target)',
    '/**\n   * Return one pane',
  );
  const autoFogSource = extractSourceRange(
    source,
    'autoComputeFogRange(cameraPosition, overrideBounds = null)',
    '/**\n   * Extract frustum planes',
  );

  assert.doesNotMatch(
    fogScalarSource,
    /\bsphere\s*=\s*\{/,
    'custom snapshot fog must not allocate a sphere object per pane and frame',
  );
  assert.doesNotMatch(
    fogScalarSource,
    /\bcenter\s*:\s*\[/,
    'custom snapshot fog must not allocate a center array per pane and frame',
  );
  for (const scalar of ['centerX', 'centerY', 'centerZ', 'radius']) {
    assert.match(
      fogScalarSource,
      new RegExp(`\\b${scalar}\\b`),
      `fog derivation must retain scalar ${scalar} ownership`,
    );
  }
  assert.match(
    autoFogSource,
    /this\._writeFogRange\(\s*cameraPosition,\s*overrideBounds,\s*this\s*\)/,
  );
  assert.doesNotMatch(
    autoFogSource,
    /Object\.freeze|\bnew\s+|\{\s*fogNear\s*:|\[\s*this\.fogNear/,
    'per-pane automatic fog must write directly into renderer-owned scalars',
  );
  assert.doesNotMatch(
    fogScalarSource,
    /requireNumericVector|requireFiniteNumber|Object\.freeze/,
    'trusted render inputs must not be revalidated or allocated per pane',
  );
});

test('canvas sizing returns one generation-owned view instead of a per-frame tuple', async () => {
  const source = await readFile(
    new URL('../assets/js/rendering/gl-utils.js', import.meta.url),
    'utf8',
  );
  const trackerSource = extractSourceRange(
    source,
    'export function createCanvasResizeObserver(canvas)',
    'export function normalizePositions(positions)',
  );

  assert.match(
    trackerSource,
    /const cachedSizeView = Object\.freeze\(\{/,
    'the tracker must own one stable read-only size view',
  );
  assert.match(
    trackerSource,
    /return cachedSizeView;/,
    'render-loop reads must reuse the generation-owned size view',
  );
  assert.doesNotMatch(
    trackerSource,
    /return\s*\[\s*cachedWidth\s*,\s*cachedHeight\s*\]/,
    'getSize must not allocate a fresh tuple at frame cadence',
  );
});
