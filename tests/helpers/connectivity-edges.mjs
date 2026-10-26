/**
 * The edge payload (`ConnectivityEdges`) of a graph given as undirected
 * pairs, built the way the reader worker builds it: from the symmetric CSR
 * matrix of the pairs, with weight 1 unless given.
 */
import { extractConnectivityEdges } from '../../assets/js/data/connectivity-edges.js';
import { createConnectivityEdgeOrder } from '../../assets/js/rendering/connectivity-edge-selection.js';

export function connectivityEdgesFromPairs(sources, destinations, nCells, weights = null) {
  const rows = Array.from({ length: nCells }, () => []);
  for (let edge = 0; edge < sources.length; edge++) {
    const weight = weights === null ? 1 : weights[edge];
    rows[sources[edge]].push([destinations[edge], weight]);
    rows[destinations[edge]].push([sources[edge], weight]);
  }
  const indptr = new Int32Array(nCells + 1);
  const indices = [];
  const data = [];
  rows.forEach((row, cell) => {
    row.sort((left, right) => left[0] - right[0]);
    for (const [column, weight] of row) {
      indices.push(column);
      data.push(weight);
    }
    indptr[cell + 1] = indices.length;
  });
  return extractConnectivityEdges({
    format: 'csr',
    shape: [nCells, nCells],
    indptr,
    indices: Int32Array.from(indices),
    data: Float64Array.from(data),
  }, nCells);
}

/** An edge payload's weights as it carries them: the largest and each relative to it. */
export function edgeWeightsOf(edges) {
  return { maxWeight: edges.maxWeight, strength: Array.from(edgeListOf(edges).strength) };
}

/** What `edgeWeightsOf` reads for edges of these exact weights. */
export function edgeWeightsFrom(weights) {
  const maxWeight = weights.length === 0 ? 0 : Math.max(...weights);
  return { maxWeight, strength: weights.map(weight => Math.fround(weight / maxWeight)) };
}

const EDGE_LISTS = new WeakMap();

/**
 * An edge payload's edges in edge order (source, then destination), read
 * back from what it carries: `forwardOffsets` and the forward end of each
 * cell's `neighbors` give the pairs, the draw-ordered `records` the
 * strengths (record `r` is edge `order.at(r)`).
 *
 * @returns {{sources: Uint32Array, destinations: Uint32Array, strength: Float32Array}}
 */
export function edgeListOf(edges) {
  const known = EDGE_LISTS.get(edges);
  if (known !== undefined) return known;
  const { forwardOffsets, neighborOffsets, neighbors, records, nCells, nEdges } = edges;
  const sources = new Uint32Array(nEdges);
  const destinations = new Uint32Array(nEdges);
  const strength = new Float32Array(nEdges);
  for (let cell = 0; cell < nCells; cell++) {
    const start = forwardOffsets[cell];
    const end = forwardOffsets[cell + 1];
    const first = neighborOffsets[cell + 1] - (end - start);
    for (let edge = start; edge < end; edge++) {
      sources[edge] = cell;
      destinations[edge] = neighbors[first + edge - start];
    }
  }
  const at = createConnectivityEdgeOrder(nEdges).at;
  const recordStrength = new Float32Array(records.buffer, records.byteOffset, records.length);
  for (let rank = 0; rank < nEdges; rank++) strength[at(rank)] = recordStrength[rank * 3 + 2];
  const list = { sources, destinations, strength };
  EDGE_LISTS.set(edges, list);
  return list;
}
