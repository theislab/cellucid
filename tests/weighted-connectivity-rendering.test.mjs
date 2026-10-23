import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { extractConnectivityEdges } from '../assets/js/data/connectivity-edges.js';
import {
  EDGE_GATHER_VARYINGS,
  EDGE_GATHER_VS_SOURCE,
  LINE_INSTANCED_FS_SOURCE,
  LINE_INSTANCED_VS_SOURCE,
} from '../assets/js/rendering/shaders/edge-grid-shaders.js';
import { edgeListOf } from './helpers/connectivity-edges.mjs';

/** A symmetric CSR graph of 3 cells with edges (0, 1) and (1, 2). */
function graphOf(first, second, Data = Float64Array) {
  return {
    format: 'csr',
    shape: [3, 3],
    indptr: Int32Array.from([0, 1, 3, 4]),
    indices: Int32Array.from([1, 0, 2, 1]),
    data: Data.from([first, first, second, second]),
  };
}

test('weighted rendering uses one deterministic relative-strength encoding', () => {
  const matrix = graphOf(1, 2);
  const snapshot = matrix.data.slice();
  const encoded = extractConnectivityEdges(matrix, 3);

  assert.equal(encoded.maxWeight, 2);
  assert.ok(edgeListOf(encoded).strength instanceof Float32Array);
  assert.deepEqual(Array.from(edgeListOf(encoded).strength), [0.5, 1]);
  assert.deepEqual(matrix.data, snapshot);
  assert.deepEqual(Array.from(edgeListOf(extractConnectivityEdges(graphOf(1, 1), 3)).strength), [1, 1]);
  // Float32 weights give the same strengths as the same values in float64.
  const weights = [0.1, 0.7];
  assert.deepEqual(
    Array.from(edgeListOf(extractConnectivityEdges(graphOf(...weights.map(Math.fround), Float32Array), 3)).strength),
    Array.from(edgeListOf(extractConnectivityEdges(graphOf(...weights.map(Math.fround)), 3)).strength)
  );
  assert.throws(
    () => extractConnectivityEdges(graphOf(Number.MIN_VALUE, Number.MAX_VALUE), 3),
    /Float32 rendering precision/i
  );
});

test('instanced edge shaders read each shown edge\'s strength from its instance record as alpha', async () => {
  assert.match(LINE_INSTANCED_VS_SOURCE, /layout\(location = 3\) in float a_strength;/);
  assert.match(
    LINE_INSTANCED_VS_SOURCE,
    /v_alpha = u_lineAlpha \* a_strength \*/
  );
  // The draw fetches nothing: positions and strength are attributes.
  assert.doesNotMatch(LINE_INSTANCED_VS_SOURCE, /texelFetch|sampler/);
  assert.match(LINE_INSTANCED_VS_SOURCE, /layout\(location = 1\) in vec3 a_source;/);
  assert.match(LINE_INSTANCED_FS_SOURCE, /fragColor = vec4\([^;]*, v_alpha\);/);
  // The instance records are gathered on the GPU by copying bits: no
  // arithmetic on a position or a strength.
  assert.match(EDGE_GATHER_VS_SOURCE, /floatBitsToUint\(texelFetch\(/);
  assert.match(EDGE_GATHER_VS_SOURCE, /v_strength = a_strengthBits;/);
  assert.deepEqual(EDGE_GATHER_VARYINGS, ['v_source', 'v_destination', 'v_strength']);

  const selectionSource = await readFile(
    new URL('../assets/js/rendering/connectivity-edge-selection.js', import.meta.url),
    'utf8'
  );
  // The records arrive from the reader worker with each edge's relative
  // strength's bits, and the selection copies them as they are.
  assert.match(selectionSource, /out\[write \+ 2\] = records\[(read|at) \+ 2\];/);
  // The strengths are the payload's own: nothing is derived on the page.
  for (const file of ['connectivity-edge-selection.js', 'connectivity-edge-layer.js']) {
    const source = await readFile(new URL(`../assets/js/rendering/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /weights/);
  }
});
