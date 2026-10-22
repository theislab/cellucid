import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createConnectivityRenderWeights,
} from '../assets/js/rendering/connectivity-weights.js';
import {
  LINE_INSTANCED_FS_SOURCE,
  LINE_INSTANCED_VS_SOURCE,
} from '../assets/js/rendering/shaders/edge-grid-shaders.js';

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

test('instanced edge shaders read each shown edge\'s strength from its instance record as alpha', async () => {
  assert.match(LINE_INSTANCED_VS_SOURCE, /layout\(location = 3\) in float a_strength;/);
  assert.match(
    LINE_INSTANCED_VS_SOURCE,
    /v_alpha = u_lineAlpha \* a_strength \*/
  );
  // No texture is read per edge: positions and strength are attributes.
  assert.doesNotMatch(LINE_INSTANCED_VS_SOURCE, /texelFetch|sampler/);
  assert.match(LINE_INSTANCED_FS_SOURCE, /fragColor = vec4\([^;]*, v_alpha\);/);

  const layerSource = await readFile(
    new URL('../assets/js/rendering/connectivity-edge-layer.js', import.meta.url),
    'utf8'
  );
  // The strength written into a record is the edge's relative strength.
  assert.match(layerSource, /records\[out \+ 6\] = strength\[edge\];/);
  assert.match(layerSource, /createConnectivityRenderWeights\(weights\)\.values/);
});
