import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { HighPerfRenderer } from '../assets/js/rendering/high-perf-renderer.js';
import { fogScale } from '../assets/js/rendering/shaders/fog-shaders.js';
import { sculptedCenterShade } from '../assets/js/rendering/shaders/high-perf-shaders.js';

const rendererSource = await readFile(
  new URL('../assets/js/rendering/high-perf-renderer.js', import.meta.url),
  'utf8',
);

test('every point pass publishes its uniforms through one shared helper', () => {
  const occurrences = rendererSource.match(
    /gl\.uniformMatrix4fv\(uniforms\.u_mvpMatrix,/g,
  ) ?? [];
  assert.equal(occurrences.length, 1);
  const calls = rendererSource.match(/this\._applyPointUniforms\(/g) ?? [];
  // Every live and snapshot pass -- full detail, a reduced level, culled or
  // not -- draws through `_drawPoints`, the one caller.
  assert.equal(calls.length, 1, 'every point pass shares the one draw seam');
  assert.match(
    HighPerfRenderer.prototype._drawPoints.toString(),
    /this\._applyPointUniforms\(/,
  );

  const published = [];
  const gl = {
    uniform1f(location, value) { published.push([location, value]); },
    uniform3fv(location, value) { published.push([location, Array.from(value)]); },
    uniformMatrix4fv(location, _transpose, value) { published.push([location, Array.from(value)]); },
  };
  const renderer = Object.assign(Object.create(HighPerfRenderer.prototype), {
    fogFar: 9,
    fogNear: 2,
  });
  const names = [
    'u_mvpMatrix', 'u_modelViewMatrix', 'u_projectionMatrix',
    'u_pointSize', 'u_sizeAttenuation', 'u_pointScale',
    'u_lightingStrength', 'u_fogNear', 'u_fogScale',
    'u_fogColor', 'u_lightDir', 'u_halfDir', 'u_invCenterShade',
  ];
  const uniforms = Object.fromEntries(names.map(name => [name, name]));
  uniforms.u_lightingStrength = null;
  // A translation for the model and a scale for the view: their product is
  // what the vertex shaders used to form per vertex.
  const model = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 5, 1];
  const view = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1];
  const fov = 1.2;
  renderer._applyPointUniforms(
    gl, uniforms, [16], view, model, [17], 7, 0.5, 600, fov,
    0.8, 0.3, [0.1, 0.2, 0.3], [0, 0, 1],
  );
  const pointScale = (600 / (2 * Math.tan(fov / 2))) * 0.01;
  assert.deepEqual(published, [
    ['u_mvpMatrix', [16]],
    ['u_modelViewMatrix', [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 6, 8, 10, 1]],
    ['u_projectionMatrix', [17]],
    ['u_pointSize', 7],
    ['u_sizeAttenuation', 0.5],
    ['u_pointScale', pointScale],
    // The shared fog model's two uniforms (fog-shaders.js).
    ['u_fogNear', 2],
    ['u_fogScale', fogScale(0.3, 2, 9)],
    ['u_fogColor', [0.1, 0.2, 0.3]],
    ['u_lightDir', [0, 0, 1]],
    ['u_halfDir', [0, 0, 1]],
    ['u_invCenterShade', 1 / sculptedCenterShade([0, 0, 1])],
  ]);
});

test('live and snapshot frustum passes validate their spatial owner the same way', () => {
  // Both cull in the one draw seam, which validates the tree it culls.
  assert.match(
    HighPerfRenderer.prototype._drawPoints.toString(),
    /this\._validateSpatialOwnerOnce\(tree\)/,
    '_drawPoints must validate the exact tree it culls',
  );
  let walks = 0;
  const renderer = Object.assign(Object.create(HighPerfRenderer.prototype), {
    _validatedSpatialIndices: new WeakSet(),
  });
  const tree = { validatePointCount() { walks++; return { valid: true }; } };
  renderer._validateSpatialOwnerOnce(tree);
  renderer._validateSpatialOwnerOnce(tree);
  assert.equal(walks, 1);
});
