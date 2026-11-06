/**
 * The history stress suite (`cellucid-private/plans/history-v2.md` §3.15.4,
 * workstream HS): it drives the real history (`app/history/history.js`,
 * `tree.js`, `value-pool.js`), the real dispatcher and catalogue, the real
 * session file (`app/session/history-file.js`) and the real autosave
 * (`app/history/autosave.js` over `autosave-store.js`) on the synthetic page
 * of `synthetic-page.mjs`, and measures where the time, the memory and the
 * bytes go.
 *
 * Two runs:
 *
 * - `runMixedHistory`: one history built from a mix of every kind of step
 *   (camera, colour by field and gene, filters, highlight brushes of 1k,
 *   100k and ~1M cells, label edits, user fields, settings, layout, analysis
 *   results), with branches (undo, then act) and trackers, up to the largest
 *   size asked; at each checkpoint (1k, 10k, 50k, 100k steps) it measures
 *   recording, jumps, undo and redo, delete-a-step, replay, the autosave,
 *   the memory accounting, `history.get`, the session file (write, size,
 *   load) and memory.
 * - `runStepKinds`: each kind of step alone, on a fresh history: the bytes
 *   one step of it adds to a session file and to the autosave, and its
 *   recording cost on a small pool.
 *
 * Nothing here is a limit. A run stops early only when the process holds
 * more memory than `memoryGuardBytes` (a guard for the machine running it,
 * reported as where the run stopped), never because a history is "too big".
 */

import { createHistory } from '../../assets/js/app/history/history.js';
import { createValuePool } from '../../assets/js/app/history/value-pool.js';
import { splitValue } from '../../assets/js/app/history/value-parts.js';
import { pathTo } from '../../assets/js/app/history/tree.js';
import { createAutosave, keepAsSavedState, openSavedState } from '../../assets/js/app/history/autosave.js';
import { createHistoryStore } from '../../assets/js/app/history/autosave-store.js';
import { openHistoryFile } from '../../assets/js/app/session/history-file.js';
import { SAVE_DEFAULTS, STATE_DEFAULTS, writeSharedHistory } from '../../assets/js/app/session/share-scope.js';
import { setWorkingSet } from '../../assets/js/data/memory-budget.js';
import { memoryDatabase } from './memory-database.mjs';
import { syntheticDataset, syntheticPage } from './synthetic-page.mjs';

/** The connector's result limit, in characters (`plans/history-v2.md` §2.4 X3). */
export const CONNECTOR_RESULT_CHARACTERS = 150_000;

/**
 * The mixed history: each kind, its weight per 1000 actions and how it is
 * drawn. Weights are what an exploratory session looks like (camera and
 * settings most, analysis runs and million-cell brushes rare); they are the
 * suite's choice and are reported with every result.
 */
export const MIX = Object.freeze([
  ['camera', 250, 'camera'],
  ['colour-field', 70, 'colorField'],
  ['colour-gene', 40, 'colorGene'],
  ['colormap', 20, 'colormap'],
  ['filter-category', 70, 'filterCategory'],
  ['filter-range', 40, 'filterRange'],
  ['brush-1k', 50, ['brush', 1_000]],
  ['brush-100k', 5, ['brush', 100_000]],
  ['brush-500k', 0.5, ['brush', 'half']],
  ['brush-1m', 0.5, ['brush', 'most']],
  ['highlight-toggle', 20, 'toggleGroup'],
  ['hide-cells', 5, 'hideCells'],
  ['show-all', 3, 'showAll'],
  ['label-edit', 50, 'labelEdit'],
  ['user-field', 1, 'userField'],
  ['setting', 150, 'setting'],
  ['panel', 50, 'panel'],
  ['section', 50, 'section'],
  ['analysis-open', 10, 'analysisOpen'],
  ['de', 1, 'differential'],
  ['markers', 0.5, 'markers'],
  ['correlation', 1, 'correlation'],
]);

/** Highlight groups kept on the page before the oldest is removed (a person clears old brushes). */
const LIVE_GROUPS = 30;

const now = () => performance.now();

function gc() {
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
    globalThis.gc();
  }
}

export function memorySnapshot() {
  gc();
  const usage = process.memoryUsage();
  return { rss: usage.rss, heapUsed: usage.heapUsed, external: usage.external, arrayBuffers: usage.arrayBuffers };
}

export function summarize(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const sum = sorted.reduce((total, value) => total + value, 0);
  return { n: sorted.length, mean: sum / sorted.length, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1], total: sum };
}

function resolveParams(page, recipe) {
  if (Array.isArray(recipe)) {
    const [name, size] = recipe;
    // 'most': every cell but 1000 (a brush of ~1M cells on 1M); 'half': half the cells, scattered (the cell-set codec's worst case).
    const cells = size === 'most' ? Math.max(1, page.dataset.cells - 1_000)
      : size === 'half' ? Math.max(1, Math.floor(page.dataset.cells / 2)) : Math.min(size, page.dataset.cells);
    return page.params[name](cells)();
  }
  return page.params[recipe]();
}

/** A pool whose `put` and `putNew` (hashing a captured value) are timed. */
function timedPool(timing) {
  const pool = createValuePool();
  // Every method of the pool as it is (it grows with the history: hold, release, putNew, …), with
  // the time its hashing puts take counted.
  const timed = name => async value => {
    const start = now();
    try {
      return await pool[name](value);
    } finally {
      timing.hash += now() - start;
      timing.puts++;
    }
  };
  const put = timed('put');
  const putNew = timed('putNew');
  const out = {};
  for (const key of Object.keys(pool)) {
    const descriptor = Object.getOwnPropertyDescriptor(pool, key);
    if (descriptor.get !== undefined) Object.defineProperty(out, key, { get: () => pool[key], enumerable: true });
    else if (typeof descriptor.value === 'function') out[key] = (...args) => pool[key](...args);
    else out[key] = descriptor.value;
  }
  out.put = put;
  out.putNew = putNew;
  return Object.freeze(out);
}

/** The catalogue the dispatcher checks params with, its `check` timed. */
function timedCatalog(timing) {
  return catalog => Object.freeze({
    get: type => catalog.get(type),
    has: type => catalog.has(type),
    list: () => catalog.list(),
    check(type, params) {
      const start = now();
      try {
        return catalog.check(type, params);
      } finally {
        timing.check += now() - start;
      }
    },
  });
}

/**
 * A page with its history, wired as `dataset-history.js` wires the page's
 * own (history, autosave over IndexedDB, the history's memory accounted on
 * each change), except that the accounting and the autosave run when the
 * suite says, so they can be timed apart from recording.
 */
export async function createStressPage({ cells, genes = 20_000, seed = 1, markerGroups, correlationCells, autosave = true, dataset = null }) {
  const timing = { hash: 0, puts: 0, check: 0 };
  const shown = dataset ?? syntheticDataset({ cells, genes });
  const page = syntheticPage({ dataset: shown, seed, markerGroups, correlationCells, catalog: timedCatalog(timing) });
  let trackerCount = 0;
  let clock = 1_700_000_000_000;
  const history = createHistory({
    dispatcher: page.dispatcher, domains: page.domains, dataset: { id: 'stress', name: 'History stress', cellOrder: null },
    newTrackerId: () => `t-00000000-0000-4000-8000-${String(++trackerCount).padStart(12, '0')}`, now: () => (clock += 1000), pool: timedPool(timing),
  });
  const database = memoryDatabase();
  const store = createHistoryStore(database);
  let saver = null;
  if (autosave) {
    saver = createAutosave({
      history, dataset: { id: 'stress', name: 'History stress' }, header: async () => shown.header, store,
      enabled: () => true, now: () => clock,
      // Written when the suite flushes (each step, or every few hundred while a history is built).
      schedule: () => {},
    });
  }
  return { page, history, timing, database, store, autosave: saver, dataset: shown };
}

/** The memory accounting `dataset-history.js` runs after each history change. */
function accountMemory(history) {
  const start = now();
  setWorkingSet('history', history.pool.byteLength());
  return now() - start;
}

async function dispatchTimed(stress, type, params, meta = {}) {
  const { page, timing } = stress;
  const hash0 = timing.hash;
  const check0 = timing.check;
  const handler0 = page.handlerTime.total;
  const capture0 = page.ownerTime.capture;
  const start = now();
  const { step } = await page.dispatcher.dispatch(type, params, meta);
  const total = now() - start;
  const handler = page.handlerTime.total - handler0;
  const check = timing.check - check0;
  const capture = page.ownerTime.capture - capture0;
  const hash = timing.hash - hash0;
  return {
    step, total, handler, check, capture, hash,
    // The history's own share: what recording added around the handler (capture of the touched domains is the owner's).
    recorder: Math.max(0, total - handler - check - capture),
  };
}

function stepCount(history) {
  return history.trackers().reduce((sum, tree) => sum + tree.steps.size - 1, 0);
}

/** One sentence of what a session file holds, by chunk kind (stored and uncompressed bytes). */
function fileBreakdown(manifest) {
  const out = {};
  for (const chunk of manifest.chunks) {
    const key = chunk.kind === 'array' ? `array-${chunk.encoding}-${chunk.priority}` : `${chunk.kind}-${chunk.priority}`;
    out[key] ??= { chunks: 0, storedBytes: 0, uncompressedBytes: 0 };
    out[key].chunks++;
    out[key].storedBytes += chunk.storedBytes;
    out[key].uncompressedBytes += chunk.uncompressedBytes;
  }
  return out;
}

/** The history written as the page's Save writes it, with what `choice` holds (`writeSharedHistory`). */
function sessionFileOf(stress, choice) {
  const { history, dataset, page } = stress;
  return writeSharedHistory({
    snapshot: history.snapshot(), shown: history.shownHashes(), valueOf: hash => history.pool.get(hash), choice,
    header: dataset.header, catalog: page.dispatcher.catalog, version: '0.9.7',
    newTrackerId: () => 't-00000000-0000-4000-8000-0000000000ff', now: Date.now(),
  });
}

/**
 * Write the history as a session file in each form (the whole history; its
 * steps only; the current state only); then open the whole one into a fresh
 * page and time each stage of the load.
 */
export async function measureSessionFile(stress, { load = true } = {}) {
  const { dataset } = stress;
  let start = now();
  const { blob } = await sessionFileOf(stress, SAVE_DEFAULTS);
  const writeMs = now() - start;
  const bytes = blob.size;
  const forms = {};
  for (const [form, choice] of [['steps', { ...SAVE_DEFAULTS, content: 'steps' }], ['state', STATE_DEFAULTS], ['recompute', { ...SAVE_DEFAULTS, results: 'recompute' }]]) {
    start = now();
    const written = await sessionFileOf(stress, choice);
    forms[form] = { bytes: written.blob.size, writeMs: now() - start };
  }
  start = now();
  const file = await openHistoryFile(blob, { signal: null, onProgress: null });
  const manifestMs = now() - start;
  const breakdown = fileBreakdown(file.manifest);
  const result = { writeMs, bytes, forms, breakdown, manifestMs };
  if (!load) {
    await file.cancel('measured');
    return result;
  }
  const fresh = await createStressPage({ cells: dataset.cells, autosave: false, dataset });
  await fresh.history.startTracker();
  start = now();
  const eager = await file.readEager();
  result.readEagerMs = now() - start;
  let restMs = 0;
  start = now();
  await fresh.history.load(eager.history, {
    values: eager.values,
    rest: async () => {
      const restStart = now();
      try {
        return await file.readRest();
      } finally {
        restMs = now() - restStart;
      }
    },
  });
  result.loadMs = now() - start;
  result.readRestMs = restMs;
  result.applyMs = result.loadMs - restMs;
  result.totalLoadMs = result.readEagerMs + result.loadMs;
  result.loadedSteps = stepCount(fresh.history);
  return result;
}

/**
 * Where the history's values go, by domain: how many distinct values each
 * domain holds, the JSON of their skeletons (what the session file's and the
 * autosave's value records hold) and the bytes of the typed arrays they name
 * (each array once per domain).
 */
async function valuesByDomain(history) {
  const domainOf = new Map();
  for (const tree of history.trackers()) {
    for (const step of tree.steps.values()) {
      for (const [domain, hash] of [...Object.entries(step.before), ...Object.entries(step.after)]) domainOf.set(hash, domain);
    }
  }
  const out = {};
  const arraysOf = new Map();
  for (const [hash, domain] of domainOf) {
    out[domain] ??= { values: 0, skeletonBytes: 0, arrayBytes: 0, arrays: 0 };
    if (!arraysOf.has(domain)) arraysOf.set(domain, new Map());
    const skeleton = await splitValue(history.pool.get(hash), arraysOf.get(domain));
    out[domain].values++;
    out[domain].skeletonBytes += JSON.stringify(skeleton).length;
  }
  for (const [domain, arrays] of arraysOf) {
    out[domain].arrays = arrays.size;
    for (const array of arrays.values()) out[domain].arrayBytes += array.byteLength;
  }
  return out;
}

/** Steps on the active tracker's path that a replay can apply again. */
function replayable(history, count) {
  const tree = history.active;
  return pathTo(tree, tree.headId).filter(step => step.type !== null && step.type !== 'history.outside-change').slice(-count);
}

/**
 * The checkpoint measurements, at the history's size now. Each one leaves
 * the history in use as a person would: jumps return to the head, a deleted
 * step is gone, a replay adds its steps.
 */
async function checkpoint(stress, { sampleSteps, deletes, replaySteps, jumps, sessionLoad, savedStateLoad, mixDraw, memoryGuardBytes }) {
  const { history, page, autosave, database } = stress;
  const out = { steps: stepCount(history) };
  const tree = history.active;
  out.activeTrackerSteps = tree.steps.size - 1;
  out.activeDepth = pathTo(tree, tree.headId).length - 1;
  out.trackers = history.trackers().length;
  out.branches = history.trackers().reduce((sum, t) => sum + t.branches.size, 0);
  out.activeBranches = tree.branches.size;
  out.poolValues = history.pool.size;
  const accounting = [];
  for (let i = 0; i < 3; i++) accounting.push(accountMemory(history));
  out.poolBytes = history.pool.byteLength();
  const byDomainStart = now();
  out.valuesByDomain = await valuesByDomain(history);
  out.valuesByDomainMs = now() - byDomainStart;
  out.memoryAccountingMs = summarize(accounting);

  // Recording plus the per-step work around it, one step at a time, as the page does it.
  const sampled = { total: [], recorder: [], hash: [], accounting: [], autosave: [] };
  if (autosave !== null) await autosave.flush();
  for (let i = 0; i < sampleSteps; i++) {
    const [kind, type, params] = mixDraw();
    const timed = await dispatchTimed(stress, type, params);
    if (timed.step === null) continue;
    sampled.total.push(timed.total);
    sampled.recorder.push(timed.recorder);
    sampled.hash.push(timed.hash);
    sampled.accounting.push(accountMemory(history));
    if (autosave !== null) {
      const start = now();
      await autosave.flush();
      sampled.autosave.push(now() - start);
    }
    void kind;
  }
  out.sampledStep = Object.fromEntries(Object.entries(sampled).map(([key, values]) => [key, summarize(values)]));
  out.autosaveStore = database.usage();

  /**
   * Run one measurement; a failure (a crash of the history at this size) is
   * the measurement: recorded with its message and where it was thrown, and
   * the checkpoint goes on.
   */
  const failures = {};
  async function attempt(name, measure) {
    const start = now();
    try {
      await measure();
    } catch (error) {
      failures[name] = {
        message: `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`,
        at: String(error?.stack ?? '').split('\n').slice(1, 3).map(line => line.trim().replace(/^at /, '').replace(/\(?file:\/\/.*\/assets\//, 'assets/')).join(' < '),
        afterMs: now() - start,
      };
    }
  }

  // history.get (one page, as an agent reads it) and history.summary (the whole history without its steps).
  await attempt('historyGetPage', async () => {
    const start = now();
    const { outcome } = await page.dispatcher.dispatch('history.get', {});
    const ms = now() - start;
    const characters = JSON.stringify(outcome).length;
    out.historyGetPage = {
      ms, characters, steps: outcome.steps.length, total: outcome.total, overConnectorLimit: characters > CONNECTOR_RESULT_CHARACTERS,
      charactersPerStep: characters / Math.max(1, outcome.steps.length),
    };
  });
  await attempt('historySummary', async () => {
    const start = now();
    const { outcome } = await page.dispatcher.dispatch('history.summary', {});
    const characters = JSON.stringify(outcome).length;
    out.historySummary = { ms: now() - start, characters, branches: outcome.branches.length, overConnectorLimit: characters > CONNECTOR_RESULT_CHARACTERS };
  });

  // Jumps to random steps of the active tracker, then back to the head.
  const head = history.active.headId;
  await attempt('jump', async () => {
    const ids = [...history.active.steps.keys()];
    const jumpMs = [];
    const jumpDepth = [];
    for (let i = 0; i < jumps; i++) {
      const target = ids[Math.floor(page.random() * ids.length)];
      const start = now();
      await history.jump(target);
      jumpMs.push(now() - start);
      jumpDepth.push(pathTo(history.active, target).length - 1);
      await history.jump(head);
    }
    out.jump = { ...summarize(jumpMs), depthP50: summarize(jumpDepth)?.p50 ?? null };
  });
  await attempt('jumpToRoot', async () => {
    const rootStart = now();
    await history.jump(history.active.rootId);
    out.jumpToRootMs = now() - rootStart;
    const backStart = now();
    await history.jump(head);
    out.jumpRootToHeadMs = now() - backStart;
  });

  await attempt('undoRedo', async () => {
    const undoMs = [];
    const redoMs = [];
    for (let i = 0; i < 10; i++) {
      const start = now();
      await history.undo();
      undoMs.push(now() - start);
    }
    for (let i = 0; i < 10; i++) {
      const start = now();
      await history.redo();
      redoMs.push(now() - start);
    }
    out.undo = summarize(undoMs);
    out.redo = summarize(redoMs);
  });

  // Delete a step with about `below` steps after it on the shown path.
  out.deleteStep = [];
  for (const below of deletes) {
    await attempt(`deleteStep${below}`, async () => {
      const path = pathTo(history.active, history.active.headId);
      const index = path.length - 1 - below;
      if (index < 1) return;
      const target = path[index];
      const start = now();
      const { flagged, reapplied } = await history.deleteStep(target.id);
      const ms = now() - start;
      out.deleteStep.push({ below, ms, msPerReapplied: ms / Math.max(1, reapplied.length), reapplied: reapplied.length, unapplicable: flagged.length });
    });
  }

  // Replay the last steps of the shown path, as "run my workflow" does: in a
  // new tracker on the state shown, linked to the one they come from. The
  // history then goes back to the tracker in use and drops the replay's, so
  // the next checkpoint builds on the same tracker.
  await attempt('replay', async () => {
    const source = history.active;
    const toReplay = replayable(history, replaySteps);
    const from = {
      dataset: { id: source.dataset?.id ?? null, name: source.dataset?.name ?? null },
      tracker: { id: source.id, name: source.name }, branch: null, step: source.headId, file: null, saved: null,
    };
    const replayStart = now();
    const { tracker, report } = await history.replay({ steps: toReplay, from, name: `Replay of ${source.name}` });
    const replayMs = now() - replayStart;
    out.replay = {
      steps: toReplay.length, ms: replayMs, msPerStep: replayMs / Math.max(1, toReplay.length),
      failed: report.filter(entry => entry.outcome === 'unmatched' || entry.outcome === 'stopped').length,
    };
    await history.useTracker(source.id);
    await page.dispatcher.dispatch('history.tracker.remove', { tracker });
    await page.dispatcher.dispatch('history.journal.empty', { tracker });
  });

  // The whole history written at once (what a resumed autosave or "Save as" writes), and read back.
  if (autosave !== null) {
    await attempt('saveAs', async () => {
      await autosave.flush();
      out.autosaveStoreBeforeSaveAs = database.usage();
      let start = now();
      const { id } = await keepAsSavedState({
        history: history.snapshot(), valueOf: hash => history.pool.get(hash), header: stress.dataset.header,
        dataset: { id: 'stress', name: 'History stress' }, name: 'stress', createdAt: 0, updatedAt: 0,
      }, stress.store);
      out.saveAsMs = now() - start;
      out.autosaveStoreAfterSaveAs = database.usage();
      // What a removal of saved states anywhere collects, over every record this browser keeps
      // (only while the records are held: a collect reads them all).
      if (database.retaining) {
        start = now();
        await stress.store.collect();
        out.collectMs = now() - start;
      }
      // A load makes a second copy of the history: skipped (and said) when the process already holds half the guard.
      const roomForCopy = memorySnapshot().rss < memoryGuardBytes / 2;
      if (savedStateLoad && !roomForCopy) out.savedStateLoadSkipped = 'the process held over half its memory guard';
      if (savedStateLoad && roomForCopy) {
        start = now();
        const source = await openSavedState(id, stress.store);
        const eager = await source.readEager();
        out.savedStateReadEagerMs = now() - start;
        const fresh = await createStressPage({ cells: stress.dataset.cells, autosave: false, dataset: stress.dataset });
        await fresh.history.startTracker();
        start = now();
        await fresh.history.load(eager.history, { values: eager.values, rest: source.readRest });
        out.savedStateLoadMs = now() - start;
      }
    });
  }

  out.stepsSaved = stepCount(history);
  const loadRoom = memorySnapshot().rss < memoryGuardBytes / 2;
  if (sessionLoad && !loadRoom) out.sessionLoadSkipped = 'the process held over half its memory guard';
  await attempt('session', async () => {
    out.session = await measureSessionFile(stress, { load: sessionLoad && loadRoom });
  });
  out.failures = failures;
  out.memory = memorySnapshot();
  out.ownerTime = { ...page.ownerTime };
  return out;
}

/**
 * Build one mixed history up to `steps` steps and measure it at each of
 * `checkpoints`.
 *
 * @param {{steps: number, cells: number, genes?: number, seed?: number, checkpoints?: number[],
 *   branches?: number, trackers?: number, autosaveEvery?: number, sampleSteps?: number,
 *   deletes?: number[], replaySteps?: number, jumps?: number, sessionLoad?: boolean, savedStateLoad?: boolean,
 *   savedStateLoadUpTo?: number,
 *   memoryGuardBytes?: number, markerGroups?: number, correlationCells?: number,
 *   onProgress?: (line: string) => void}} options
 */
export async function runMixedHistory({
  steps, cells, genes = 20_000, seed = 1, checkpoints = [1_000, 10_000, 50_000, 100_000], branches = 100, trackers = 10,
  autosaveEvery = 500, sampleSteps = 20, deletes = [10, 100, 1000], replaySteps = 100, jumps = 20, sessionLoad = true,
  savedStateLoad = true, savedStateLoadUpTo = 10_000, memoryGuardBytes = 8 * 1024 ** 3, markerGroups = 12, correlationCells = 50_000, onProgress = () => {},
}) {
  const stress = await createStressPage({ cells, genes, seed, markerGroups, correlationCells });
  const { page, history, autosave } = stress;
  const memory0 = memorySnapshot();
  await history.startTracker({ name: 'Main' });
  const main = history.active.id;
  const weights = MIX.map(([, weight]) => weight);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const mixDraw = () => {
    for (;;) {
      let pick = page.random() * totalWeight;
      let index = 0;
      while (pick >= weights[index]) pick -= weights[index++];
      const [kind, , recipe] = MIX[index];
      const action = resolveParams(page, recipe);
      if (action !== null) return [kind, ...action];
    }
  };
  const marks = checkpoints.filter(mark => mark <= steps).sort((a, b) => a - b);
  if (!marks.includes(steps)) marks.push(steps);
  const branchEvery = Math.max(1, Math.floor(steps / (branches + 1)));
  const sideTrackers = Math.max(0, trackers - 1);
  const trackerEvery = sideTrackers > 0 ? Math.floor(steps / sideTrackers) : Infinity;
  const sideSteps = Math.max(1, Math.floor(steps / 100));

  const kinds = MIX.map(([kind]) => kind);
  const perKind = new Map([...kinds, 'highlight-remove'].map(kind => [kind, { total: [], recorder: [], hash: [], handler: [], coalesced: 0 }]));
  const results = { options: { steps, cells, genes, seed, branches, trackers, autosaveEvery, sampleSteps, deletes, replaySteps, jumps, markerGroups, correlationCells }, mix: MIX.map(([kind, weight]) => [kind, weight]), checkpoints: [], memoryAtStart: memory0 };
  const buildStart = now();
  let dispatches = 0;
  let nextBranch = branchEvery;
  let nextTracker = trackerEvery;
  let sideCount = 0;
  let windowStart = now();
  let stoppedEarly = null;

  async function take(kind, type, params) {
    const timed = await dispatchTimed(stress, type, params);
    dispatches++;
    const record = perKind.get(kind);
    if (timed.step === null) return timed;
    const coalesced = record.lastStep === timed.step;
    if (coalesced) record.coalesced++;
    record.lastStep = timed.step;
    record.total.push(timed.total);
    record.recorder.push(timed.recorder);
    record.hash.push(timed.hash);
    record.handler.push(timed.handler);
    return timed;
  }

  for (const mark of marks) {
    while (stepCount(history) < mark) {
      const count = stepCount(history);
      if (count >= nextTracker && sideCount < sideTrackers) {
        sideCount++;
        nextTracker += trackerEvery;
        await history.startTracker({ name: `Side ${sideCount}`, start: 'shown' });
        for (let i = 0; i < sideSteps; i++) {
          const [kind, type, params] = mixDraw();
          await take(kind, type, params);
        }
        await history.useTracker(main);
        continue;
      }
      if (count >= nextBranch) {
        nextBranch += branchEvery;
        const back = 1 + Math.floor(page.random() * 20);
        for (let i = 0; i < back; i++) await history.undo();
      }
      const [kind, type, params] = mixDraw();
      await take(kind, type, params);
      if (type === 'highlight.cells' && page.state.highlights.pages[0].groups.length > LIVE_GROUPS) {
        const action = page.params.removeOldestGroup();
        await take('highlight-remove', ...action);
      }
      if (autosave !== null && dispatches % autosaveEvery === 0) await autosave.flush();
      if (dispatches % 1000 === 0) {
        let usage = process.memoryUsage();
        // Over the guard: collected first, so garbage not yet collected never stops a run.
        if (usage.rss > memoryGuardBytes) usage = { ...process.memoryUsage(), rss: memorySnapshot().rss };
        onProgress(`${stepCount(history)} steps, ${Math.round((now() - windowStart) / 100) / 10} s for the last 1000 dispatches, rss ${Math.round(usage.rss / 2 ** 20)} MiB, arrays ${Math.round(usage.arrayBuffers / 2 ** 20)} MiB`);
        windowStart = now();
        if (usage.rss > memoryGuardBytes) {
          stoppedEarly = { at: stepCount(history), rss: usage.rss, reason: `the process held ${Math.round(usage.rss / 2 ** 20)} MiB, over the run's guard of ${Math.round(memoryGuardBytes / 2 ** 20)} MiB` };
          break;
        }
      }
    }
    const buildMs = now() - buildStart;
    onProgress(`checkpoint at ${stepCount(history)} steps (target ${mark}), building took ${Math.round(buildMs / 1000)} s so far`);
    const recording = Object.fromEntries([...perKind].map(([kind, record]) => [kind, {
      steps: record.total.length, coalesced: record.coalesced,
      total: summarize(record.total), recorder: summarize(record.recorder), hash: summarize(record.hash), handler: summarize(record.handler),
    }]));
    const allRecorder = [...perKind.values()].flatMap(record => record.recorder);
    const allTotal = [...perKind.values()].flatMap(record => record.total);
    // The window's records are summarised and dropped: each checkpoint reports the steps taken since the last.
    for (const record of perKind.values()) { record.total = []; record.recorder = []; record.hash = []; record.handler = []; record.coalesced = 0; }
    const checkStart = now();
    const readBack = savedStateLoad && mark <= savedStateLoadUpTo;
    const measured = await checkpoint(stress, { sampleSteps, deletes, replaySteps, jumps, sessionLoad, savedStateLoad: readBack, mixDraw, memoryGuardBytes });
    // Past the last checkpoint that reads a saved state back, the stand-in only counts what it is given (a browser keeps it on disk).
    if (!readBack || !marks.some(next => next > mark && next <= savedStateLoadUpTo)) stress.database.dropContents();
    measured.checkpointMs = now() - checkStart;
    results.checkpoints.push({
      target: mark, buildMs, dispatches, recordingByKind: recording,
      recordingAll: { recorder: summarize(allRecorder), total: summarize(allTotal) }, ...measured,
    });
    onProgress(`checkpoint at ${mark} measured in ${Math.round(measured.checkpointMs / 1000)} s: session ${Math.round((measured.session?.bytes ?? 0) / 2 ** 20)} MiB, history.get page ${measured.historyGetPage?.characters} chars, summary ${measured.historySummary?.characters}, jump p50 ${measured.jump?.p50?.toFixed(1)} ms, failures: ${Object.keys(measured.failures).join(', ') || 'none'}`);
    if (stoppedEarly !== null) break;
  }
  results.stoppedEarly = stoppedEarly;
  results.totalMs = now() - buildStart;
  return results;
}

/** The kinds `runStepKinds` measures alone, with the action that makes one step of each. */
export const STEP_KINDS = Object.freeze([
  ['camera', 'camera'],
  ['colour-field', 'colorField'],
  ['colour-gene', 'colorGene'],
  ['filter-category', 'filterCategory'],
  ['filter-range', 'filterRange'],
  ['brush-1k', ['brush', 1_000]],
  ['brush-100k', ['brush', 100_000]],
  ['brush-500k', ['brush', 'half']],
  ['brush-1m', ['brush', 'most']],
  ['hide-cells', 'hideCells'],
  ['label-edit', 'labelEdit'],
  ['user-field', 'userField'],
  ['setting', 'setting'],
  ['panel', 'panel'],
  ['section', 'section'],
  ['analysis-open', 'analysisOpen'],
  ['de', 'differential'],
  ['markers', 'markers'],
  ['correlation', 'correlation'],
]);

/**
 * Each kind of step alone: a fresh history (with one result of each
 * analysis already shown, as a session that ran them has), `count` steps of
 * the kind, and what they add. Steps whose kind coalesces (a camera, a
 * slider, a range, a panel) are each given a turn of their own, so each is
 * one step.
 */
export async function runStepKinds({ cells, genes = 20_000, seed = 7, counts = {}, defaultCount = 100, markerGroups = 12, correlationCells = 50_000, onProgress = () => {} }) {
  const out = {};
  for (const [kind, recipe] of STEP_KINDS) {
    const count = counts[kind] ?? defaultCount;
    const stress = await createStressPage({ cells, genes, seed, markerGroups, correlationCells });
    const { page, history, autosave, database } = stress;
    for (const analysis of ['differential', 'markers', 'correlation']) await page.dispatcher.dispatch('analysis.run', { analysis });
    await page.dispatcher.dispatch('highlight.cells', { cells: Uint32Array.of(1, 2, 3), label: 'Seed group' });
    await history.startTracker({ name: 'Kind' });
    // One step first: the autosave writes the whole history (every root value) at its first write, which is no step's cost.
    for (let tries = 0; ; tries++) {
      const warm = resolveParams(page, recipe);
      const { step } = await page.dispatcher.dispatch(warm[0], warm[1], { turn: `turn-warm-${tries}` });
      if (step !== null) break;
    }
    await autosave.flush();
    const base = await measureSessionFile(stress, { load: false });
    const baseStore = database.usage();
    const records = { total: [], recorder: [], hash: [], handler: [], autosave: [] };
    let made = 0;
    for (let i = 0; i < count; i++) {
      const action = resolveParams(page, recipe);
      const timed = await dispatchTimed(stress, action[0], action[1], { turn: `turn-${i}` });
      if (timed.step === null) continue;
      made++;
      records.total.push(timed.total);
      records.recorder.push(timed.recorder);
      records.hash.push(timed.hash);
      records.handler.push(timed.handler);
      const start = now();
      await autosave.flush();
      records.autosave.push(now() - start);
    }
    const after = await measureSessionFile(stress, { load: true });
    const store = database.usage();
    const per = value => value / Math.max(1, made);
    const chunkDelta = key => per((after.breakdown[key]?.storedBytes ?? 0) - (base.breakdown[key]?.storedBytes ?? 0));
    const stepsBytes = per(after.breakdown['steps-eager'].storedBytes - base.breakdown['steps-eager'].storedBytes);
    const valueBytes = chunkDelta('values-eager') + chunkDelta('values-lazy');
    const arrayBytes = Object.keys(after.breakdown).filter(key => key.startsWith('array-')).reduce((sum, key) => sum + chunkDelta(key), 0);
    out[kind] = {
      steps: made,
      fileBytesPerStep: per(after.bytes - base.bytes),
      stepsChunkBytesPerStep: stepsBytes,
      valueBytesPerStep: valueBytes,
      arrayBytesPerStep: arrayBytes,
      uncompressedValueBytesPerStep: per(['values-eager', 'values-lazy'].reduce((sum, key) => sum + (after.breakdown[key]?.uncompressedBytes ?? 0) - (base.breakdown[key]?.uncompressedBytes ?? 0), 0)),
      autosaveBytesPerStep: per(store.bytes - baseStore.bytes),
      autosaveValueBytesPerStep: per(store.stores.values.bytes - baseStore.stores.values.bytes),
      autosaveArrayBytesPerStep: per(store.stores.arrays.bytes - baseStore.stores.arrays.bytes),
      autosaveStepBytesPerStep: per(store.stores.steps.bytes - baseStore.stores.steps.bytes),
      recording: { total: summarize(records.total), recorder: summarize(records.recorder), hash: summarize(records.hash), handler: summarize(records.handler) },
      autosaveWrite: summarize(records.autosave),
      sessionWriteMs: after.writeMs,
      sessionLoadMs: after.totalLoadMs,
      poolBytes: history.pool.byteLength(),
    };
    onProgress(`${kind}: ${made} steps, ${Math.round(out[kind].fileBytesPerStep)} file bytes/step, recorder p50 ${out[kind].recording.recorder?.p50.toFixed(2)} ms`);
  }
  return out;
}
