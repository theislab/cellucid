import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  shuffleConnectivityEdges,
} from '../assets/js/app/utils/random-utils.js';
import {
  createConnectivityRenderWeights,
} from '../assets/js/rendering/connectivity-weights.js';
import {
  createRequiredTexture,
} from '../assets/js/rendering/gl-utils.js';
import {
  LINE_INSTANCED_FS_SOURCE,
  LINE_INSTANCED_VS_SOURCE,
} from '../assets/js/rendering/shaders/edge-grid-shaders.js';

test('deterministic edge shuffling preserves endpoint-weight identity', () => {
  const sources = Uint32Array.from([0, 0, 1, 2, 3]);
  const destinations = Uint32Array.from([1, 2, 2, 3, 4]);
  const weights = Float64Array.from([11, 12, 22, 33, 44]);
  const expectedWeights = new Map(
    Array.from(sources, (source, index) => [
      `${source}:${destinations[index]}`,
      weights[index],
    ])
  );

  shuffleConnectivityEdges(sources, destinations, weights);

  assert.notDeepEqual(Array.from(sources), [0, 0, 1, 2, 3]);
  for (let index = 0; index < sources.length; index++) {
    assert.equal(
      weights[index],
      expectedWeights.get(`${sources[index]}:${destinations[index]}`)
    );
  }
});

test('weighted rendering uses one deterministic relative-strength encoding', () => {
  const canonical = Float64Array.from([1, 2]);
  const snapshot = canonical.slice();
  const encoded = createConnectivityRenderWeights(canonical);

  assert.equal(encoded.maxWeight, 2);
  assert.deepEqual(Array.from(encoded.values), [0.5, 1]);
  assert.deepEqual(canonical, snapshot);
  assert.deepEqual(
    Array.from(
      createConnectivityRenderWeights(
        Float64Array.from([1, 1])
      ).values
    ),
    [1, 1]
  );
  assert.throws(
    () => createConnectivityRenderWeights(
      Float64Array.from([Number.MIN_VALUE, Number.MAX_VALUE])
    ),
    /Float32 rendering precision/i
  );
});

test('required WebGL texture allocation fails visibly and exactly', () => {
  const allocated = Object.freeze({ texture: 'allocated' });
  assert.equal(
    createRequiredTexture(
      { createTexture: () => allocated },
      'weighted connectivity topology'
    ),
    allocated
  );
  assert.throws(
    () => createRequiredTexture(
      { createTexture: () => null },
      'weighted connectivity weights'
    ),
    /could not allocate.*weighted connectivity weights.*texture/i
  );
  assert.throws(
    () => createRequiredTexture(
      { createTexture: () => allocated },
      ''
    ),
    /non-empty texture role/i
  );
});

test('instanced edge shaders consume the aligned weight texture as alpha', async () => {
  assert.match(LINE_INSTANCED_VS_SOURCE, /u_edgeWeightTexture/);
  assert.match(
    LINE_INSTANCED_VS_SOURCE,
    /v_edgeStrength = texelFetch\(u_edgeWeightTexture, edgeCoord, 0\)\.r/
  );
  assert.match(
    LINE_INSTANCED_FS_SOURCE,
    /u_lineAlpha \* v_edgeStrength/
  );

  const viewerSource = await readFile(
    new URL('../assets/js/rendering/viewer.js', import.meta.url),
    'utf8'
  );
  assert.match(
    viewerSource,
    /gl\.texImage2D\(gl\.TEXTURE_2D, 0, gl\.R32F,[\s\S]+gl\.RED, gl\.FLOAT, weightData\)/
  );
  assert.match(
    viewerSource,
    /queueEdgeTextureRetirement\(retiredTexture\)/
  );
  assert.match(
    viewerSource,
    /gl\.deleteTexture\(texture\);\s*pending\.delete\(texture\)/
  );
});
