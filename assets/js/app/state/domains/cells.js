/**
 * @fileoverview The `cells` state domain: which cells of the dataset are
 * open, and how many of them genes were asked to be read for. The actions
 * `cells.open` (`ui/modules/subsample-control.js`) and `cells.read-genes`
 * (`ui/modules/gene-read-control.js`) change it; a restore reads the cells
 * again.
 *
 * Value (it names what a person chose, never what the app is still doing on
 * its own: a progressive opening growing toward its share and the gene
 * sample filling its gene time, `DataState.topUpGeneSample`, are no change):
 *
 *     {open: null | {method, k, seed, …the subsample's specification},
 *      genes: null | number}
 *
 * `open` is null when every cell is open (or every cell is the share being
 * grown toward), else the specification of the subsample
 * (`data/subsample.js`) with `k` the cells it grows to: it reproduces the
 * same cells exactly (`strict`). `genes` is the count of open cells genes
 * were asked to be read for (null: never asked on these open cells, the
 * opening's own sample).
 *
 * Restore reads the dataset again on the recorded cells when they differ
 * from the open ones, the way `cells.open` does (`reopen`: what was made is
 * kept by original cell position, the views carried), so the history keeps
 * its tracker across it (`app/history/dataset-history.js`) and captures the
 * domains after this one again before it compares them. A larger `genes`
 * reads genes for more cells; a smaller one keeps what is read (reading is
 * never undone: the cells read stay read, as Stop keeps them).
 *
 * @module app/state/domains/cells
 */

import { askedCellsOf } from '../../../data/cell-subset-policy.js';
import { formatCountOf } from '../../../utils/format-units.js';
import { awaitWithSignal, throwIfAborted } from '../../../utils/abort.js';

/** The parts of a subsample's specification that reproduce its cells. */
const SPEC_KEYS = Object.freeze([
  'method', 'k', 'seed', 'blockSize', 'field', 'allocation', 'minPerCategory', 'embedding', 'columns', 'gridSize',
]);

/**
 * The open cells as the domain names them: null for every cell, else the
 * subsample's specification at the share it grows to (`askedCellsOf`).
 *
 * @param {Object|null} subset - `AnnDataFileSource.getCellSubset()`
 * @returns {Object|null}
 */
export function openCellsValueOf(subset) {
  const asked = askedCellsOf(subset);
  if (asked === null) return null;
  const value = {};
  for (const key of SPEC_KEYS) {
    if (asked.spec[key] === undefined) continue;
    value[key] = Array.isArray(asked.spec[key]) ? [...asked.spec[key]] : asked.spec[key];
  }
  return value;
}

/** The request that opens the cells `open` names (`openCellsValueOf`), exactly. */
export function requestOfOpenCellsValue(open) {
  if (open === null) return { mode: 'all' };
  return { mode: 'subsample', ...open, strict: true };
}

/**
 * What the genes asked for are keyed by: the open cells they were asked on
 * (a count asked on other cells says nothing about these).
 *
 * @param {Object|null} subset - `AnnDataFileSource.getCellSubset()`
 * @returns {string}
 */
export function openCellsKey(subset) {
  return JSON.stringify(openCellsValueOf(subset));
}

function describeOpen(open) {
  return open === null ? 'every cell' : `${formatCountOf(open.k, 'cell')} (${open.method}, seed ${open.seed})`;
}

function describeGenes(count) {
  return count === null ? 'the opening\'s sample' : formatCountOf(count, 'cell');
}

/**
 * @param {{openCells: {
 *   subset: () => (Object|null),
 *   geneSample: () => ({cells: number, of: number}|null),
 *   genesAsked: () => (number|null),
 *   setGenesAsked: (cells: number|null) => void,
 *   reopen: (request: Object, options?: {heavy?: Function|null, signal?: AbortSignal|null}) => Promise<{restoring: Promise<void>}>,
 *   readGenes: (cells: number, options?: {heavy?: Function|null, signal?: AbortSignal|null}) => Promise<unknown>,
 * }}} options - `openCells`: the open data's controls (`ui/core/ui-coordinator.js`):
 *   the cells open, the gene sample, the genes asked for on these cells, a
 *   reading of the dataset again on other cells keeping what was made
 *   (`subsample-control.js` `reopenKeeping`), and genes read for more cells
 */
export function createCellsDomain({ openCells }) {
  for (const name of ['subset', 'geneSample', 'genesAsked', 'setGenesAsked', 'reopen', 'readGenes']) {
    if (typeof openCells?.[name] !== 'function') throw new TypeError(`The cells domain needs openCells.${name}().`);
  }
  function capture() {
    return { open: openCellsValueOf(openCells.subset()), genes: openCells.genesAsked() };
  }
  return {
    capture,
    // `heavy`: the running action's `ctx.heavy` (a history move of an agent): asked before the
    // cells' totals of normalized values are summed for the cells read. `signal`: the move's
    // (its Stop): the reading is canceled and the restore throws why, promptly; the
    // history then puts back what was shown.
    async restore(value, { heavy = null, signal = null } = {}) {
      if (value === null || typeof value !== 'object' || !Object.hasOwn(value, 'open') || !Object.hasOwn(value, 'genes')) {
        throw new TypeError('The open cells to restore name the cells and the genes asked for.');
      }
      if (JSON.stringify(openCellsValueOf(openCells.subset())) !== JSON.stringify(value.open)) {
        const { restoring } = await openCells.reopen(requestOfOpenCellsValue(value.open), { heavy, signal });
        // Stopped, the reading was canceled: the cells open before are still open.
        throwIfAborted(signal);
        await awaitWithSignal(restoring, signal);
        const now = openCellsValueOf(openCells.subset());
        if (JSON.stringify(now) !== JSON.stringify(value.open)) {
          throw new Error(`The cells could not be read again: ${describeOpen(value.open)} were asked for, ${describeOpen(now)} are open.`);
        }
      }
      openCells.setGenesAsked(value.genes);
      const sample = openCells.geneSample();
      if (value.genes !== null && sample !== null && sample.cells < Math.min(value.genes, sample.of)) {
        await openCells.readGenes(value.genes, { heavy, signal });
        throwIfAborted(signal);
      }
    },
    describe(a, b) {
      const lines = [];
      if (JSON.stringify(a.open) !== JSON.stringify(b.open)) lines.push(`Cells open: ${describeOpen(a.open)} → ${describeOpen(b.open)}`);
      if (a.genes !== b.genes) lines.push(`Genes read for: ${describeGenes(a.genes)} → ${describeGenes(b.genes)}`);
      return lines;
    },
  };
}
