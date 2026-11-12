/**
 * Summing the cells' totals of normalized expression values is heavy work,
 * asked for by whatever change needs it (F151, lane queue-5 L25-2):
 *
 * - the dispatcher's `ctx.heavy(estimate)`: heavy work an implementation
 *   finds while it runs is asked of an agent's action as heavy work (its
 *   start already judged heavy covers it); the person and a replay are not
 *   asked; a decline refuses the action;
 * - normalizing (`setExpressionTransform`) and a data mapping onto another
 *   counts matrix while normalized (the genes stage) price the pass and ask
 *   before reading any gene; declined, nothing is read or changed;
 * - a mapping restored with the Expression values beside it shows its
 *   matrix in them at once, so a matrix is never summed for values the
 *   restore does not end on;
 * - a matrix keeps its totals in the dataset (one lineage per matrix): a
 *   mapping back onto it reads nothing again;
 * - rows read for cells past the totals kept, by every loaded gene at once
 *   (a growth), sum the matrix in those cells once, not once per gene;
 * - reading genes for more cells counts the totals of the cells added in
 *   its price;
 * - an agent's history move restoring normalized values passes the action's
 *   asker to the domain's restore.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createActionCatalog, defineAction } from '../assets/js/app/actions/catalog.js';
import { ActionRefused, createActionDispatcher } from '../assets/js/app/actions/dispatcher.js';
import { createDomainRegistry } from '../assets/js/app/actions/domains.js';
import { historyActions } from '../assets/js/app/actions/definitions/history.js';
import { createHistory } from '../assets/js/app/history/history.js';
import { DEFAULT_PERMISSIONS, HEAVY_MS, decide, kindsOf } from '../assets/js/app/agent/presence/permissions.js';
import { DataState } from '../assets/js/app/state/core/data-state.js';
import { createInMemoryDimensionManager } from '../assets/js/data/dimension-manager.js';
import { RAW_VALUES, requireExpressionTransform } from '../assets/js/data/expression-transform.js';
import { createExpressionDomain } from '../assets/js/app/state/domains/expression.js';
import { keptLibrarySizes } from '../assets/js/data/library-sizes.js';
import { CELL_TOTALS_DOING, shownLoaderParts } from '../assets/js/app/state/managers/expression-values.js';

const NONE = Object.freeze({ type: 'object', additionalProperties: false, properties: {} });
const AGENT = Object.freeze({ origin: 'agent', agent: 'Claude', turn: 'turn-1' });
const HEAVY = Object.freeze({ ms: 2 * HEAVY_MS, bytes: 1e9, what: 'Sums all 3 genes of X once for each cell\'s total (normalized values)' });
const NORMALIZED = Object.freeze({ normalize: true, log1p: false });

// ---------------------------------------------------------------------------
// The dispatcher's ctx.heavy

function heavyDispatcher({ startEstimate = null } = {}) {
  const catalog = createActionCatalog([
    defineAction({ type: 't.work', title: 'Work', summary: 'x', group: 'T', params: NONE, touches: ['filters'], reads: [], effect: 'state', describe: () => 'work', code: () => 'work()' }),
  ]);
  const dispatcher = createActionDispatcher({ catalog });
  const done = [];
  dispatcher.provide('t.work', async (params, { heavy }) => {
    await heavy(HEAVY);
    done.push('ran');
  });
  if (startEstimate !== null) dispatcher.provideEstimate('t.work', () => startEstimate);
  const questions = [];
  let answer = true;
  // The presence's own rule (`decide`), Ask before heavy: what it would ask the person.
  dispatcher.setConfirmer(async question => {
    const ruling = decide(question, DEFAULT_PERMISSIONS);
    questions.push({ stage: question.stage, kinds: ruling.kinds, decision: ruling.decision });
    return ruling.decision === 'allow' ? true : answer;
  });
  return { dispatcher, done, questions, decline: () => { answer = false; } };
}

test('heavy work a handler finds is asked of an agent as heavy work; its start judged heavy covers it; the person is not asked', async () => {
  const found = heavyDispatcher();
  await found.dispatcher.dispatch('t.work', {}, AGENT);
  assert.deepEqual(found.questions, [
    { stage: 'start', kinds: ['change'], decision: 'allow' },
    { stage: 'handler', kinds: ['heavy'], decision: 'ask' },
  ]);
  assert.deepEqual(found.done, ['ran']);

  const priced = heavyDispatcher({ startEstimate: HEAVY });
  await priced.dispatcher.dispatch('t.work', {}, AGENT);
  assert.deepEqual(priced.questions.map(q => [q.stage, q.kinds.join('+'), q.decision]), [
    ['start', 'change+heavy', 'ask'],
    ['handler', '', 'allow'],
  ], 'asked once, at the start');

  const person = heavyDispatcher();
  await person.dispatcher.dispatch('t.work', {}, { origin: 'user' });
  assert.deepEqual(person.questions, [], 'the person acting is not asked');
  assert.deepEqual(person.done, ['ran']);

  const declined = heavyDispatcher();
  declined.decline();
  await assert.rejects(declined.dispatcher.dispatch('t.work', {}, AGENT), error => error instanceof ActionRefused && error.code === 'declined'
    && /Sums all 3 genes of X/.test(error.message));
  assert.deepEqual(declined.done, [], 'declined: it does not run on');

  assert.deepEqual(kindsOf({ stage: 'handler', estimate: HEAVY }), ['heavy']);
  assert.deepEqual(kindsOf({ stage: 'handler', estimate: { ms: HEAVY_MS - 1, what: 'x' } }), []);
  assert.deepEqual(kindsOf({ stage: 'handler', estimate: HEAVY, started: HEAVY }), []);
  assert.deepEqual(kindsOf({ stage: 'handler', confirm: 'large-download', estimate: HEAVY }), ['large-download']);
});

// ---------------------------------------------------------------------------
// The state: a real DataState over a counts matrix without a column of totals

const N = 4;
const COUNTS = { A: [1, 0, 3, 0], B: [0, 2, 0, 4], C: [5, 0, 0, 1] };

function geneList(keys) {
  return { n_points: N, fields: keys.map((key, index) => ({ key, kind: 'continuous', path: `var/${index}` })) };
}

/** A matrix's own loader over `COUNTS`, counting what it reads. */
function matrixLoader(reads, label = 'X') {
  const values = field => Float32Array.from(COUNTS[field.key]);
  const base = async field => {
    reads.push(`${label}:${field.key}`);
    return { loaded: true, values: values(field) };
  };
  base.readSparseColumn = async field => {
    reads.push(`${label}:sum:${field.key}`);
    const dense = values(field);
    const indices = [];
    for (let cell = 0; cell < dense.length; cell++) if (dense[cell] !== 0) indices.push(cell);
    return { length: dense.length, indices: Uint32Array.from(indices), values: Float32Array.from(indices, cell => dense[cell]) };
  };
  base.readCellSubset = async (fields, cells) => {
    reads.push(`${label}:cells:${cells.length}`);
    const pointers = [0];
    const positions = [];
    const out = [];
    for (const field of fields) {
      const dense = values(field);
      cells.forEach((cell, position) => { if (dense[cell] !== 0) { positions.push(position); out.push(dense[cell]); } });
      pointers.push(positions.length);
    }
    return { pointers: Uint32Array.from(pointers), positions: Uint32Array.from(positions), values: Float32Array.from(out) };
  };
  base.readRows = async (field, [from, to]) => values(field).slice(from, to);
  base.readPlan = async () => ({ scan: null, entries: 2_000_000, bytesPerSecond: 1_000_000 });
  base.storedTotals = () => null;
  base.geneSampleCost = async () => ({ bytes: 1000, ms: 10, target: N });
  base.resized = () => base;
  return base;
}

async function makeState({ genesReadFor = null } = {}) {
  const state = new DataState(null, null);
  state.viewer = new Proxy({ getViewLayout: () => ({ mode: 'grid' }) }, {
    get(target, property) { return Object.hasOwn(target, property) ? target[property] : () => {}; },
  });
  state.pointCount = N;
  state.dimensionManager = createInMemoryDimensionManager({ positions: new Float32Array(N * 2), dimension: 2 });
  state.activeDimensionLevel = 2;
  state.colorsArray = new Uint8Array(N * 4);
  state.categoryTransparency = new Uint8Array(N).fill(1);
  state.obsData = { fields: [] };
  state.dataMapping = Object.freeze({ expression: 'X', modality: null, log1p: {}, geneNames: 'index', highlyVariable: null });
  state.mappingMatrixHoldsCounts = () => true;
  state.getGeneSample = () => (genesReadFor === null ? null : { cells: genesReadFor.cells, of: N });
  const reads = [];
  state.setVarFieldLoader(matrixLoader(reads));
  state.initVarData(geneList(['A', 'B', 'C']));
  state._resetViewContexts();
  return { state, reads };
}

test('normalizing prices the pass and asks before reading any gene; declined, nothing is read or changed', async () => {
  const { state, reads } = await makeState();
  const asked = [];
  const decline = async estimate => {
    asked.push({ estimate, readsSoFar: reads.length });
    throw new ActionRefused('The person declined', { code: 'declined' });
  };
  await assert.rejects(state.setExpressionTransform(NORMALIZED, { heavy: decline }), { code: 'declined' });
  assert.equal(asked.length, 1);
  assert.match(asked[0].estimate.what, /^Sums all 3 genes of X once for each cell's total/);
  assert.equal(asked[0].estimate.bytes, 16_000_000, 'priced from the read plan (entries × 8)');
  assert.equal(asked[0].estimate.ms, 16_000);
  assert.equal(asked[0].readsSoFar, 0, 'asked before any gene is read');
  assert.deepEqual(reads, []);
  assert.deepEqual(state.getExpressionTransform(), RAW_VALUES, 'nothing changed');

  const allowed = [];
  await state.setExpressionTransform(NORMALIZED, { heavy: async estimate => { allowed.push(estimate); } });
  assert.equal(allowed.length, 1);
  assert.deepEqual(reads.filter(read => read.startsWith('X:sum:')).sort(), ['X:sum:A', 'X:sum:B', 'X:sum:C']);
  assert.deepEqual(state.getShownExpressionTransform(), NORMALIZED);
  // Kept: off and on again reads nothing more and asks nothing.
  await state.setExpressionTransform(RAW_VALUES);
  const again = [];
  await state.setExpressionTransform(NORMALIZED, { heavy: async estimate => { again.push(estimate); } });
  assert.deepEqual(again, []);
  assert.equal(reads.filter(read => read.startsWith('X:sum:')).length, 3);
});

/** The genes stage of a mapping onto `expression`, with the new matrix's own loader. */
function stageOnto(state, reads, next, options = {}) {
  state.mappingVarLoaderOf = async mapping => ({ geneList: geneList(['A', 'B', 'C']), varFieldLoader: matrixLoader(reads, mapping.expression) });
  state._mappingRuntime = { resetGeneAnalysis: () => {} };
  return state._stageMappingGroups(state.dataMapping, next, { requireCurrent: () => {}, ...options });
}

test('a mapping onto another counts matrix while normalized asks before summing it; back onto a matrix reads nothing again', async () => {
  const { state, reads } = await makeState();
  await state.setExpressionTransform(NORMALIZED);
  reads.length = 0;
  const counts = { ...state.dataMapping, expression: 'layer:counts' };
  // Declined: the stage stops before any read of the new matrix.
  await assert.rejects(stageOnto(state, reads, counts, { heavy: async () => { throw new ActionRefused('declined', { code: 'declined' }); } }), { code: 'declined' });
  assert.deepEqual(reads, []);
  // Allowed: priced for that matrix, summed before the gene list is replaced.
  const asked = [];
  const groups = await stageOnto(state, reads, counts, { heavy: async estimate => { asked.push(estimate.what); } });
  assert.deepEqual(asked, ["Sums all 3 genes of layers['counts'] once for each cell's total (normalized values)"]);
  assert.equal(reads.filter(read => read.startsWith('layer:counts:sum:')).length, 3);
  await groups.commit();
  state.dataMapping = Object.freeze(counts);
  // Back onto X: its totals are kept for the dataset (one lineage per matrix).
  reads.length = 0;
  const back = [];
  const toX = await stageOnto(state, reads, { ...counts, expression: 'X' }, { heavy: async estimate => { back.push(estimate); } });
  assert.deepEqual(back, []);
  assert.deepEqual(reads.filter(read => read.includes(':sum:')), []);
  await toX.commit();
});

test('a mapping restored with the Expression values beside it never sums a matrix for values it does not end on', async () => {
  const { state, reads } = await makeState();
  await state.setExpressionTransform(NORMALIZED);
  reads.length = 0;
  const counts = { ...state.dataMapping, expression: 'layer:counts' };
  const asked = [];
  const groups = await stageOnto(state, reads, counts, { heavy: async estimate => { asked.push(estimate); }, expression: RAW_VALUES });
  assert.deepEqual(asked, []);
  assert.deepEqual(reads.filter(read => read.includes(':sum:') || read.includes(':cells:')), []);
  await groups.commit();
  assert.deepEqual(state.getExpressionTransform(), RAW_VALUES, 'the values asked with the mapping are asked now');
  assert.deepEqual(state.getShownExpressionTransform(), RAW_VALUES);
});

test('rows read past the totals kept by every loaded gene at once sum the matrix in those cells once', async () => {
  const { state, reads } = await makeState({ genesReadFor: { cells: 2 } });
  await state.setExpressionTransform(NORMALIZED);
  const parts = shownLoaderParts(state.varFieldLoader);
  assert.equal(keptLibrarySizes(parts.lineage).readTo, 2);
  reads.length = 0;
  const fields = state._varFieldDescriptors;
  await Promise.all(fields.map(field => state.varFieldLoader.readRows(field, [2, 4])));
  assert.deepEqual(reads, ['X:cells:2'], 'one pass over the cells added, not one per gene');
  assert.equal(keptLibrarySizes(parts.lineage).readTo, 4);
});

test('reading genes for more cells counts the totals of the cells added in its price', async () => {
  const { state } = await makeState({ genesReadFor: { cells: 2 } });
  await state.setExpressionTransform(NORMALIZED);
  state._geneSampleDriver = () => state._varFieldDescriptors[0];
  const cost = await state.geneSampleCost(4);
  // The cells added are half of the open cells: half the pass.
  assert.deepEqual(cost.totals, { ms: 8000, bytes: 8_000_000, what: 'Sums all 3 genes of X in 2 cells more for their totals (normalized values)' });
  assert.deepEqual([cost.bytes, cost.ms, cost.target], [8_001_000, 8010, 4]);
  await state.setExpressionTransform(RAW_VALUES);
  assert.equal((await state.geneSampleCost(4)).totals, undefined, 'values as stored: no totals');
});

// ---------------------------------------------------------------------------
// History: an agent's move passes its asker to the restore

test('an agent\'s undo and redo of normalized values hand the action\'s heavy asker to the Expression values restore', async () => {
  const restoreAsks = [];
  const state = {
    transform: RAW_VALUES,
    getExpressionTransform() { return this.transform; },
    async setExpressionTransform(next, { heavy = null } = {}) {
      if (next.normalize) {
        restoreAsks.push(typeof heavy);
        await heavy?.(HEAVY);
      }
      this.transform = requireExpressionTransform(next);
      return { changed: true, shown: this.transform, dropped: [] };
    },
  };
  const domains = createDomainRegistry();
  domains.provide('expression', createExpressionDomain({ state, refreshUi: () => {} }));
  for (const id of domains.missing()) domains.provide(id, { capture: () => null, restore: () => {} });
  const catalog = createActionCatalog([
    defineAction({
      type: 'expression.set', title: 'Expression values', summary: 'x', group: 'T',
      params: { type: 'object', additionalProperties: false, required: ['normalize', 'log1p'], properties: { normalize: { type: 'boolean' }, log1p: { type: 'boolean' } } },
      touches: ['expression'], reads: [], effect: 'state', describe: () => 'values', code: () => 'values()',
    }),
    ...historyActions,
  ]);
  const dispatcher = createActionDispatcher({ catalog });
  dispatcher.provide('expression.set', params => state.setExpressionTransform(params));
  const questions = [];
  dispatcher.setConfirmer(async question => {
    const ruling = decide(question, DEFAULT_PERMISSIONS);
    questions.push(`${question.definition.type}:${question.stage}:${ruling.kinds.join('+')}`);
    return true;
  });
  let t = 0;
  const history = createHistory({
    dispatcher, domains, dataset: { id: 'd1', name: 'Demo', cellOrder: null },
    newTrackerId: () => `t-00000000-0000-4000-8000-${String(++t).padStart(12, '0')}`, now: () => ++t * 1000,
  });
  await history.startTracker();
  await dispatcher.dispatch('expression.set', { normalize: true, log1p: false }, { origin: 'user' });
  restoreAsks.length = 0;
  await dispatcher.dispatch('history.undo', {}, AGENT);
  await dispatcher.dispatch('history.redo', {}, AGENT);
  assert.deepEqual(restoreAsks, ['function'], 'the redo restoring normalized values was given the asker');
  assert.deepEqual(questions, ['history.undo:start:change', 'history.redo:start:change', 'history.redo:handler:heavy']);
  // The person's own undo is not asked.
  questions.length = 0;
  await dispatcher.dispatch('history.undo', {}, { origin: 'user' });
  await dispatcher.dispatch('history.redo', {}, { origin: 'user' });
  assert.deepEqual(questions, []);
});

test('the pass gives its words for a progress line; a load and a replay of normalized values hand it to the load (F167)', async () => {
  const { state } = await makeState();
  const found = [];
  await state.setExpressionTransform(NORMALIZED, { heavy: async estimate => { found.push(estimate.doing); } });
  assert.deepEqual(found, [CELL_TOTALS_DOING]);
  assert.equal(CELL_TOTALS_DOING, 'Summing each cell\'s counts for normalized values…');

  // A history whose step normalizes: loaded, and replayed, each with the load's `heavy`.
  const restoreAsks = [];
  const fake = {
    transform: RAW_VALUES,
    getExpressionTransform() { return this.transform; },
    async setExpressionTransform(next, { heavy = null } = {}) {
      if (next.normalize) await heavy?.({ ...HEAVY, doing: CELL_TOTALS_DOING });
      this.transform = requireExpressionTransform(next);
      return { changed: true, shown: this.transform, dropped: [] };
    },
  };
  const domains = createDomainRegistry();
  domains.provide('expression', createExpressionDomain({ state: fake, refreshUi: () => {} }));
  for (const id of domains.missing()) domains.provide(id, { capture: () => null, restore: () => {} });
  const catalog = createActionCatalog([
    defineAction({
      type: 'expression.set', title: 'Expression values', summary: 'x', group: 'T',
      params: { type: 'object', additionalProperties: false, required: ['normalize', 'log1p'], properties: { normalize: { type: 'boolean' }, log1p: { type: 'boolean' } } },
      touches: ['expression'], reads: [], effect: 'state', describe: () => 'values', code: () => 'values()',
    }),
    ...historyActions,
  ]);
  const dispatcher = createActionDispatcher({ catalog });
  dispatcher.provide('expression.set', (params, { heavy }) => fake.setExpressionTransform(params, { heavy }));
  let t = 0;
  const history = createHistory({
    dispatcher, domains, dataset: { id: 'd1', name: 'Demo', cellOrder: null },
    newTrackerId: () => `t-00000000-0000-4000-8000-${String(++t).padStart(12, '0')}`, now: () => ++t * 1000,
  });
  await history.startTracker();
  await dispatcher.dispatch('expression.set', { normalize: true, log1p: false }, { origin: 'user' });
  const saved = history.snapshot();
  const values = new Map(history.pool.hashes().map(hash => [hash, history.pool.get(hash)]));
  await dispatcher.dispatch('history.undo', {}, { origin: 'user' });
  fake.transform = RAW_VALUES;
  await history.load(saved, { values, heavy: async estimate => { restoreAsks.push(['load', estimate.doing]); } });
  fake.transform = RAW_VALUES;
  const { replayPlanOf } = await import('../assets/js/app/history/replay.js');
  await history.replay(replayPlanOf(saved), { heavy: async estimate => { restoreAsks.push(['replay', estimate.doing]); } });
  assert.deepEqual(restoreAsks, [['load', CELL_TOTALS_DOING], ['replay', CELL_TOTALS_DOING]]);
});
