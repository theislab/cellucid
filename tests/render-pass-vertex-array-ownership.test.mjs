import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const viewerSource = await readFile(
  new URL('../assets/js/rendering/viewer.js', import.meta.url),
  'utf8',
);

function functionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} must exist`);
  const end = source.indexOf('\n  }\n', start);
  return source.slice(start, end);
}

test('the live centroid pass records attributes only into its own vertex array', () => {
  const body = functionBody(viewerSource, 'function drawCentroids(count, viewportHeight) {');
  const bind = body.indexOf('gl.bindVertexArray(centroidVao);');
  const firstEnable = body.indexOf('gl.enableVertexAttribArray(');
  const draw = body.indexOf('gl.drawArrays(');
  const unbind = body.indexOf('gl.bindVertexArray(null);');
  assert.ok(bind >= 0 && bind < firstEnable, 'the pass VAO is bound before any attribute changes');
  assert.ok(draw > firstEnable && unbind > draw, 'the pass unbinds its VAO after drawing');
  assert.match(
    viewerSource,
    /let centroidVao = gl\.createVertexArray\(\);/,
  );
  assert.match(
    viewerSource,
    /gl\.deleteVertexArray\(centroidVao\);\s*centroidVao = null;/,
    'disposal retires the centroid vertex array',
  );
});
