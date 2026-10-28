/**
 * Progressive analysis: a run that answers first on a uniform random sample
 * of the open cells, then on all of them.
 *
 * The sample is the first `m` cells of the open cells' priority order
 * (`data/cell-priority.js`) — the cells the coarsest levels of detail draw,
 * and the cells a smaller subsample with the same seed would open. The first
 * pass runs the analysis unchanged on each group's cells among them; the
 * second pass is the very same run on every open cell, so the final result is
 * exactly what a single run gives, bit for bit, and replaces the first in
 * place. Each result says how many cells it used.
 *
 * The first pass is taken only when it pays, judged from what runs of the
 * same analysis measured on this device (`AnalysisCostModel`): a run costs a
 * part that does not depend on the cells (reading genes, starting workers)
 * plus a part per cell. With nothing measured yet an analysis runs once: a
 * first pass whose cost is unknown could double the part that does not shrink
 * with the cells (every gene read twice).
 *
 * @module shared/progressive-cells
 */

import { createSamplePageId, parseSamplePageId } from './page-derivation-utils.js';
import { formatCount, formatCountOf } from '../../../utils/format-units.js';

/**
 * How soon a first answer should come: the response time below which a
 * person's flow of thought is kept (about one second; Card, Robertson and
 * Mackinlay 1991; Nielsen 1993). It sizes the first pass; it limits nothing:
 * every run still ends on all open cells.
 */
export const FIRST_ANSWER_TARGET_MS = 1000;

const STORAGE_KEY = 'cellucid:analysis-cost:v1';

/**
 * The measured cost of each analysis kind on this device: `fixedMs + perCellMs × cells`,
 * fitted from its last two passes of different sizes (one pass: all of its
 * time per cell). Kept in memory and, as a convenience across visits, in this
 * browser's storage (never required).
 */
export class AnalysisCostModel {
  constructor({ storage = defaultStorage() } = {}) {
    this._storage = storage;
    this._passes = new Map();
    try {
      const saved = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null');
      if (saved !== null && typeof saved === 'object') {
        for (const [kind, passes] of Object.entries(saved)) {
          if (Array.isArray(passes)) {
            this._passes.set(kind, passes.filter(pass => Number.isFinite(pass?.cells) && pass.cells > 0 && Number.isFinite(pass?.ms) && pass.ms >= 0).slice(-2));
          }
        }
      }
    } catch {
      // Storage unavailable or unreadable: measure afresh.
    }
  }

  /** Record a pass of `kind` over `cells` cells that took `ms`. */
  record(kind, cells, ms) {
    if (!(cells > 0) || !(ms >= 0)) return;
    const passes = (this._passes.get(kind) ?? []).filter(pass => pass.cells !== cells);
    passes.push({ cells, ms });
    this._passes.set(kind, passes.slice(-2));
    try {
      this._storage?.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(this._passes)));
    } catch {
      // Storage full or blocked: the model lives on in memory.
    }
  }

  /** `{fixedMs, perCellMs}` of `kind`, or null before any pass. */
  cost(kind) {
    const passes = this._passes.get(kind) ?? [];
    if (passes.length === 0) return null;
    if (passes.length === 1) return { fixedMs: 0, perCellMs: passes[0].ms / passes[0].cells };
    const [a, b] = passes;
    const perCellMs = Math.max(0, (b.ms - a.ms) / (b.cells - a.cells));
    const fixedMs = Math.max(0, a.ms - perCellMs * a.cells);
    return { fixedMs, perCellMs };
  }
}

function defaultStorage() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

let sharedModel = null;

/** The cost model every analysis of this page shares. */
export function getAnalysisCostModel() {
  sharedModel ??= new AnalysisCostModel();
  return sharedModel;
}

/**
 * The size of a first pass over `n` open cells, or null when a single run is
 * as good: when nothing is measured yet, when the whole run is predicted
 * within `FIRST_ANSWER_TARGET_MS`, or when a first pass would not answer at
 * least twice as soon as the whole run (its time is mostly the part that does
 * not depend on the cells). A first pass takes the cells that fit in the
 * target, and never fewer than `ceil(sqrt(n))`.
 *
 * @param {{fixedMs: number, perCellMs: number}|null} cost
 * @param {number} n - Open cells
 * @returns {number|null}
 */
export function firstPassSize(cost, n) {
  if (!(Number.isSafeInteger(n) && n > 1)) return null;
  const floor = Math.ceil(Math.sqrt(n));
  if (floor >= n) return null;
  if (cost === null) return null;
  const predict = cells => cost.fixedMs + cost.perCellMs * cells;
  if (predict(n) <= FIRST_ANSWER_TARGET_MS) return null;
  const withinTarget = cost.perCellMs > 0 ? Math.floor((FIRST_ANSWER_TARGET_MS - cost.fixedMs) / cost.perCellMs) : n;
  const m = Math.min(n - 1, Math.max(floor, withinTarget));
  return predict(m) * 2 <= predict(n) ? m : null;
}

/**
 * The cells of a first pass: the first `m` of `n` open cells in priority
 * order, as each kind of cell scope an analysis has.
 *
 * @param {{cellSample: (m: number) => {has: (cell: number) => boolean, filter: (cells: ArrayLike<number>) => Uint32Array}}} dataLayer
 * @param {number} n
 * @param {number} m
 */
export function createCellSample(dataLayer, n, m) {
  const prefix = dataLayer.cellSample(m);
  return Object.freeze({
    n,
    m,
    /** A page's sample, as a derived page id the data layer resolves. */
    pageId: pageId => createSamplePageId(pageId, m),
    pageIds: pageIds => pageIds.map(pageId => createSamplePageId(pageId, m)),
    /** The page a sample page id stands for (results name their pages by it). */
    basePageId: pageId => parseSamplePageId(pageId)?.baseId ?? pageId,
    /** The sample's cells of an ascending cell list. */
    cells: cells => prefix.filter(cells),
    /**
     * A one-byte-a-cell scope (null: every cell) narrowed to the sample,
     * one byte a cell as every consumer's computation takes it (the counts
     * and groups of composition, dot plot and the genes panel are indexed by
     * cell, as the full run's scope is). Cells open in priority order: the
     * sample is the first `m`, and only they are looked at.
     */
    mask(scope) {
      const out = new Uint8Array(n);
      if (prefix.priority.seed === null) {
        if (scope === null) out.fill(1, 0, m);
        else for (let cell = 0; cell < m; cell++) out[cell] = scope[cell] !== 0 ? 1 : 0;
        return out;
      }
      for (let cell = 0; cell < n; cell++) {
        if ((scope === null || scope[cell] !== 0) && prefix.has(cell)) out[cell] = 1;
      }
      return out;
    },
  });
}

/**
 * What a result says about the cells it used.
 *
 * @param {{m: number, n: number}|null} sample - The first pass's sample; null for all cells
 * @param {number} n - Open cells
 * @param {'refining'|'stopped'|null} state
 * @returns {string}
 */
export function describeCellsUsed(sample, n, state = null) {
  if (sample === null) return `Every cell: computed on all cells of its groups (${formatCountOf(n, 'open cell')}).`;
  const percent = (100 * sample.m) / n;
  const share = `${percent >= 1 ? percent.toFixed(1) : percent.toPrecision(2)}%`;
  const lead = `First pass: each group's cells in a uniform sample of ${share} of the open cells (about ${formatCount(sample.m)} of ${formatCount(n)})`;
  if (state === 'refining') return `${lead} · refining on every cell…`;
  if (state === 'stopped') return `${lead}. Stopped before every cell; run again for all of them.`;
  return `${lead}.`;
}

/**
 * Run an analysis progressively: when a first pass pays (`firstPassSize`),
 * `pass(sample)` on the first pass's cells, `onFirstPass(result, sample)`
 * draws it; then `pass(null)` on every open cell, whose result is returned.
 * Both passes are timed into the cost model under `kind`.
 *
 * A first pass that throws (a sample a group has too few cells in) is
 * skipped, unless the run was cancelled or superseded. `progress.shown` is
 * the sample of the first pass on screen, if any, for a caller whose final
 * pass is cancelled or fails to say what is shown.
 *
 * @template T
 * @param {{
 *   kind: string,
 *   dataLayer: object,
 *   job?: {step?: Function, signal?: AbortSignal}|null,
 *   isCurrent: () => boolean,
 *   pass: (sample: ReturnType<typeof createCellSample>|null) => Promise<T|null>,
 *   onFirstPass: (result: T, sample: ReturnType<typeof createCellSample>) => Promise<boolean|void>,
 *   progress?: {shown: object|null},
 *   model?: AnalysisCostModel,
 * }} run
 * @returns {Promise<T|null>} The result on every open cell; null when superseded
 */
export async function runProgressively({ kind, dataLayer, job = null, isCurrent, pass, onFirstPass, progress = { shown: null }, model = getAnalysisCostModel() }) {
  const n = dataLayer.state?.pointCount ?? 0;
  const m = firstPassSize(model.cost(kind), n);
  if (m !== null && isCurrent()) {
    const sample = createCellSample(dataLayer, n, m);
    job?.step?.(`First pass on about ${formatCount(m)} of ${formatCountOf(n, 'cell')}`);
    const started = performance.now();
    let first;
    try {
      first = await pass(sample);
    } catch (error) {
      if (job?.signal?.aborted === true || !isCurrent()) throw error;
      first = undefined;
    }
    if (first === null || !isCurrent()) return null;
    if (first !== undefined) {
      model.record(kind, m, performance.now() - started);
      const drawn = await onFirstPass(first, sample);
      if (!isCurrent()) return null;
      if (drawn !== false) progress.shown = sample;
    }
    job?.step?.(`Refining on all ${formatCountOf(n, 'cell')}`);
  }
  const started = performance.now();
  const result = isCurrent() ? await pass(null) : null;
  if (result === null || !isCurrent()) return null;
  model.record(kind, n, performance.now() - started);
  return result;
}
