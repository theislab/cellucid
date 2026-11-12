/**
 * @fileoverview A run's values in the analysis threads: the genes a task
 * gets from the reader (over its gene route, `data/gene-delivery.js`) come
 * as stored, and are put in the run's expression transform
 * (`data/expression-transform.js`) where the task enters a thread, before
 * its kernel sees them.
 *
 * A run that normalizes holds its per-cell factors (`10⁴ / t`, one Float32
 * a position of the genes it sends: every open cell, or a cell subset's
 * positions) in every thread by id (`withCellScale`, `setCellScale`); a
 * task whose genes are delivered names the run's values (`payload.transform`:
 * `{scale: id|null, log1p}`, `taskTransform`), and `transformedTask` turns
 * its columns or block into them (`data-worker.js` `runTask`,
 * `compute-manager.js` on the CPU backend). Genes read on the page come in
 * the run's values already (`DataLayer.readGeneColumn`): their tasks name
 * none, so nothing is transformed twice. A zero stays zero, so a sparse gene
 * stays sparse.
 *
 * @module analysis/compute/task-values
 */

import { isRawValues, transformBlock, transformColumn } from '../../../data/expression-transform.js';
import { OperationType } from './operations.js';

/** @type {Map<string, Float32Array>} */
const heldScales = new Map();

function requireScaleId(scaleId) {
  if (typeof scaleId !== 'string' || scaleId.length === 0) {
    throw new TypeError('A cell scale id must be a non-empty string');
  }
  return scaleId;
}

/**
 * Hold a run's per-position factors. Setting an id again replaces them (a
 * replaced worker is sent its retained state).
 *
 * @param {{scaleId: string, scale: Float32Array}} payload
 * @returns {{positions: number}}
 */
export function setCellScale(payload) {
  const scaleId = requireScaleId(payload?.scaleId);
  if (!(payload.scale instanceof Float32Array)) throw new TypeError('A cell scale is a Float32Array of one factor a position');
  heldScales.set(scaleId, payload.scale);
  return { positions: payload.scale.length };
}

/**
 * Release a run's factors.
 *
 * @param {{scaleId: string}} payload
 * @returns {{released: boolean}}
 */
export function clearCellScale(payload) {
  return { released: heldScales.delete(requireScaleId(payload?.scaleId)) };
}

/**
 * A task's payload with its genes in the values it names (`transform`:
 * `{scale: a held scale's id or null, log1p}`; absent or null: as they
 * are): its whole columns (`columns`) or its block of a cell subset
 * (`block`). The payload returned no longer names them.
 *
 * @param {Object} payload
 * @returns {Object}
 */
export function transformedTask(payload) {
  if (payload === null || typeof payload !== 'object' || payload.transform === undefined) return payload;
  const { transform, ...rest } = payload;
  if (transform === null) return rest;
  if (typeof transform !== 'object' || typeof transform.log1p !== 'boolean' || (transform.scale !== null && typeof transform.scale !== 'string')) {
    throw new TypeError('A task\'s transform is {scale: string|null, log1p: boolean}');
  }
  let factors = null;
  if (transform.scale !== null) {
    factors = heldScales.get(requireScaleId(transform.scale)) ?? null;
    if (factors === null) throw new Error(`Cell scale "${transform.scale}" is not held`);
  }
  if (Array.isArray(rest.columns)) return { ...rest, columns: rest.columns.map(column => transformColumn(column, factors, transform.log1p)) };
  if (rest.block !== undefined && rest.block !== null) return { ...rest, block: transformBlock(rest.block, factors, transform.log1p) };
  throw new TypeError('A transformed task carries its genes as columns or a block');
}

/**
 * What a delivered task of a run names of its values (`transform`), or null
 * for a run on the values as stored.
 *
 * @param {import('../data/data-layer.js').RunValues|null} values
 * @param {string|null} scaleId - The run's held factors (`withCellScale`)
 * @returns {{scale: string|null, log1p: boolean}|null}
 */
export function taskTransform(values, scaleId) {
  if (values === null || isRawValues(values.transform)) return null;
  return { scale: values.transform.normalize ? scaleId : null, log1p: values.transform.log1p };
}

let cellScaleRuns = 0;

/**
 * Run `run(scaleId)` with a run's per-position factors held by every thread
 * its tasks run on (`setCellScale`, broadcast as the run's other contexts
 * are, kept for a replaced worker), released however it ends. With no
 * factors (`scale` null: not normalized), `run(null)`.
 *
 * @template T
 * @param {{broadcast: Function}} computeManager - `compute-manager.js`
 * @param {{scale: Float32Array|null, backend: 'worker'|'cpu', signal?: AbortSignal|null}} options
 * @param {(scaleId: string|null) => Promise<T>} run
 * @returns {Promise<T>}
 */
export async function withCellScale(computeManager, { scale, backend, signal = null }, run) {
  if (scale === null) return run(null);
  const scaleId = `cell-scale-${++cellScaleRuns}`;
  // Owed from the moment it is sent: a cancel during the broadcast leaves
  // the factors in the workers that already took them.
  try {
    await computeManager.broadcast(
      OperationType.SET_CELL_SCALE,
      () => ({ scaleId, scale: scale.slice() }),
      backend === 'worker' ? { backend, signal, retainAs: scaleId, heldBytes: scale.byteLength } : { backend, signal }
    );
    return await run(scaleId);
  } finally {
    await computeManager.broadcast(
      OperationType.CLEAR_CELL_SCALE,
      () => ({ scaleId }),
      backend === 'worker' ? { backend, releases: scaleId } : { backend }
    );
  }
}

/**
 * The factors a run of `values` holds in its threads: every open cell's, or
 * (`cells`) those of a cell subset by position; null when it does not
 * normalize.
 *
 * @param {import('../data/data-layer.js').RunValues|null} values
 * @param {ArrayLike<number>|null} [cells]
 * @returns {Float32Array|null}
 */
export function runScale(values, cells = null) {
  const factors = values?.sizes?.factors ?? null;
  if (factors === null || values.transform.normalize !== true) return null;
  if (cells === null) return factors;
  const out = new Float32Array(cells.length);
  for (let p = 0; p < cells.length; p++) out[p] = factors[cells[p]];
  return out;
}
