/**
 * Every way a gene is chosen colors by it or says why not
 * (`app/utils/gene-lookup.js`, `ui/modules/field-selector-gene-expression.js`).
 *
 * Found on the live site: opening the Suo sample from a link, typing
 * `AC058791.1` in Gene expression and pressing Enter did nothing -- no
 * colors, no message. The sample opens progressively (a first view, then
 * more cells in steps); the choice took the dataset generation when Enter
 * was pressed, its load waited for the step under way (as it must), the step
 * advanced the generation, and the choice took its own gene for one of a
 * replaced dataset and dropped it as a cancellation, which says nothing.
 * A choice is now work on the open cells: it starts on the cells after a
 * change under way, and no change commits under it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GeneUnavailableError,
  describeUnavailableGene,
  ensemblStableId,
  rankGeneMatches,
  resolveExactGene,
  resolveTypedGene,
} from '../assets/js/app/utils/gene-lookup.js';
import { createGeneIndex, resolveGenes } from '../assets/js/app/analysis/shared/gene-sets.js';
import {
  createFieldInteractionOwner,
  describeUnshownField,
} from '../assets/js/app/ui/modules/field-interaction-owner.js';
import { beginCellsChange, beginCellsChangeOnceSettled } from '../assets/js/data/open-cells-work.js';
import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { getActions } from '../assets/js/app/actions/index.js';
import { abortReason, cancelled } from '../assets/js/utils/abort.js';
import {
  createFakeDocument,
  emptyState,
  exportedGenes,
  mountGeneSelector,
  press,
  search,
  settleTurn,
  statusRegion,
} from './helpers/gene-selector-harness.mjs';

const lower = keys => keys.map(key => key.toLowerCase());
const ranked = (keys, query) => rankGeneMatches(lower(keys), query).map(index => keys[index]);

/** Every notification shown from now on, as `[type, message]`. */
function recordNotifications(t) {
  const center = getNotificationCenter();
  const shown = [];
  const show = center.show;
  center.show = options => {
    shown.push([options.type, options.message]);
    return `n${shown.length}`;
  };
  t.after(() => { center.show = show; });
  return shown;
}

/** A gene load the test answers: it rejects with its signal's reason when aborted. */
function heldLoads() {
  const loads = [];
  const onLoad = (index, options) => {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => {
      resolve = done;
      reject = fail;
      options.signal?.addEventListener('abort', () => fail(abortReason(options.signal)), { once: true });
    });
    loads.push({ index, priority: options.priority, resolve, reject });
    return promise;
  };
  return { loads, onLoad };
}

test('a name is matched as it is written: dots are characters, case is not', () => {
  const keys = ['AC058791.1', 'AC058791', 'RP11-34P13.7', 'CD3E', 'cd3e-as1'];
  assert.deepEqual(ranked(keys, 'AC058791.1'), ['AC058791.1']);
  assert.deepEqual(ranked(keys, 'ac058791'), ['AC058791', 'AC058791.1']);
  assert.deepEqual(ranked(keys, '  rp11-34p13.7 '), ['RP11-34P13.7']);
  assert.deepEqual(ranked(keys, 'Cd3E'), ['CD3E', 'cd3e-as1']);
  // A dotted name that is not an Ensembl accession keeps its suffix.
  assert.deepEqual(ranked(keys, 'AC058791.2'), []);
  assert.deepEqual(ranked(keys, '   '), []);
});

test('an Ensembl accession finds its gene under any version', () => {
  const keys = ['ENSG00000141510', 'ENSG00000168484.12', 'ENSMUSG00000059552.7', 'CD3E'];
  // Typed with a version, listed without one.
  assert.deepEqual(ranked(keys, 'ENSG00000141510.17'), ['ENSG00000141510']);
  // Typed with another version than the one listed.
  assert.deepEqual(ranked(keys, 'ensg00000168484.3'), ['ENSG00000168484.12']);
  // Typed without one, listed with one: the listed name starts with it.
  assert.deepEqual(ranked(keys, 'ENSG00000168484'), ['ENSG00000168484.12']);
  assert.deepEqual(ranked(keys, 'ENSMUSG00000059552.1'), ['ENSMUSG00000059552.7']);
  // The exact versioned name comes before a bare one it also finds.
  assert.deepEqual(ranked(['ENSG00000141510', 'ENSG00000141510.17'], 'ENSG00000141510.17'), [
    'ENSG00000141510.17', 'ENSG00000141510',
  ]);
  assert.equal(ensemblStableId('ENSG00000141510.17'), 'ensg00000141510');
  assert.equal(ensemblStableId('ensmusg00000059552'), 'ensmusg00000059552');
  // A transcript, a symbol and a dotted clone name are no gene accession.
  assert.equal(ensemblStableId('ENST00000269305.9'), null);
  assert.equal(ensemblStableId('TP53'), null);
  assert.equal(ensemblStableId('AC058791.1'), null);
});

test('a typed name resolves to the best match, or to why there is none', () => {
  const loweredKeys = lower(['TNFAIP3', 'TNF', 'AC058791.1']);
  const listed = { loweredKeys, pending: false, failure: null };
  assert.deepEqual(resolveTypedGene('tnf', listed), { kind: 'match', position: 1 });
  assert.deepEqual(resolveTypedGene('AC058791.1', listed), { kind: 'match', position: 2 });
  assert.deepEqual(resolveTypedGene('  ', listed), { kind: 'empty' });
  assert.deepEqual(resolveTypedGene('NOTAGENE', listed), { kind: 'absent' });
  // Before the gene names are read, nothing typed can choose a gene.
  assert.deepEqual(resolveTypedGene('tnf', { loweredKeys: [], pending: true, failure: null }), { kind: 'pending' });
  const failure = new Error('the var index could not be read');
  assert.deepEqual(resolveTypedGene('tnf', { loweredKeys: [], pending: false, failure }), { kind: 'failed' });
  assert.deepEqual(resolveTypedGene('tnf', { loweredKeys: [], pending: false, failure: null }), { kind: 'no-genes' });
});

test('an exact name (an analysis result) chooses only the gene of that name', () => {
  const list = { keys: ['CD3E', 'AC058791.1'], pending: false, failure: null };
  assert.deepEqual(resolveExactGene('AC058791.1', list), { kind: 'match', position: 1 });
  // A result names the gene of the list it was computed from: a near name
  // is another gene.
  assert.deepEqual(resolveExactGene('cd3e', list), { kind: 'absent' });
  assert.deepEqual(resolveExactGene('CD3', list), { kind: 'absent' });
  assert.deepEqual(resolveExactGene('CD3E', { keys: [], pending: true, failure: null }), { kind: 'pending' });
});

test('a name that chooses no gene is said in words the person can act on', () => {
  assert.equal(
    describeUnavailableGene('AC058791.2', { kind: 'absent' }),
    'AC058791.2 is not a gene in this dataset.'
  );
  assert.equal(
    describeUnavailableGene('CD3E', { kind: 'pending' }),
    'Gene names are still being read: CD3E can be chosen once they are listed.'
  );
  assert.equal(
    describeUnavailableGene('CD3E', { kind: 'failed' }, new Error('HTTP 404')),
    'CD3E cannot be shown: the gene names of this dataset could not be read (HTTP 404).'
  );
  assert.equal(
    describeUnavailableGene('CD3E', { kind: 'no-genes' }),
    'CD3E cannot be shown: this dataset has no gene expression.'
  );
  const error = new GeneUnavailableError('X1', { kind: 'absent' });
  assert.ok(error instanceof Error);
  assert.equal(error.reason, 'absent');
  assert.equal(error.message, 'X1 is not a gene in this dataset.');
  assert.throws(() => describeUnavailableGene('X', { kind: 'match' }), TypeError);
});

test('a gene set finds an Ensembl gene under another version, and reports two it could be', () => {
  const index = createGeneIndex(['ENSG00000141510', 'ENSG00000168484.12', 'CD3E']);
  assert.deepEqual(resolveGenes(['ENSG00000141510.17', 'ENSG00000168484', 'cd3e'], index), {
    resolved: ['ENSG00000141510', 'ENSG00000168484.12', 'CD3E'],
    unmatched: [],
    ambiguous: [],
    renamed: [
      { requested: 'ENSG00000141510.17', gene: 'ENSG00000141510' },
      { requested: 'ENSG00000168484', gene: 'ENSG00000168484.12' },
      { requested: 'cd3e', gene: 'CD3E' },
    ],
  });
  // Symbols named beside their accessions (`geneIdentities`): the accession
  // of another version finds the symbol.
  const named = createGeneIndex(['TP53'], { ids: new Map([['ENSG00000141510.16', 'TP53']]) });
  assert.deepEqual(resolveGenes(['ENSG00000141510.17'], named).resolved, ['TP53']);
  const twice = createGeneIndex(['ENSG00000141510.16', 'ENSG00000141510.17']);
  assert.deepEqual(resolveGenes(['ENSG00000141510'], twice).ambiguous, [
    { requested: 'ENSG00000141510', candidates: ['ENSG00000141510.16', 'ENSG00000141510.17'] },
  ]);
});

test('Enter chooses what the box says, typed, pasted or set, and says when it names no gene', async t => {
  const notifications = recordNotifications(t);
  const { loads, onLoad } = heldLoads();
  const { dom } = mountGeneSelector(exportedGenes('CD3E', 'AC058791.1', 'ENSG00000141510'), { onLoad });

  // A value the box holds without an input event (a paste a browser did not
  // report, a value set by a script) is what Enter chooses.
  dom.geneSearch.value = 'ac058791.1';
  assert.equal(press(dom, 'Enter'), true);
  await settleTurn();
  assert.deepEqual(loads.map(load => load.index), [1]);
  assert.equal(loads[0].priority, 'high');
  assert.equal(dom.geneSearch.value, 'AC058791.1');

  // An Ensembl accession typed with its version.
  search(dom, 'ENSG00000141510.17');
  press(dom, 'Enter');
  await settleTurn();
  assert.deepEqual(loads.map(load => load.index), [1, 2]);

  // A name that is no gene: the list says so and the status announces it.
  search(dom, 'NOTAGENE1');
  press(dom, 'Enter');
  await settleTurn();
  assert.deepEqual(loads.map(load => load.index), [1, 2], 'nothing is read');
  assert.equal(dom.geneDropdown.hidden, false);
  assert.match(emptyState(dom).readText(), /No gene matches “NOTAGENE1”\./);
  assert.equal(statusRegion(dom).textContent, 'NOTAGENE1 is not a gene in this dataset.');

  // Enter in an empty box chooses nothing (and says nothing).
  search(dom, '');
  press(dom, 'Enter');
  await settleTurn();
  assert.deepEqual(loads.map(load => load.index), [1, 2]);
  assert.deepEqual(notifications, []);
  // The choices under way end: the open cells are free again.
  for (const load of loads) load.resolve();
  await settleTurn();
});

test('leaving the box, by Escape or elsewhere, names the gene shown, never a name that chose nothing', async t => {
  // Found 2026-11-10 on Suo: CD19 shown, "CD3E" typed (not among its genes) and
  // Enter, then Escape: the box kept saying CD3E while the cells showed CD19.
  recordNotifications(t);
  const { loads, onLoad } = heldLoads();
  const { dom } = mountGeneSelector(exportedGenes('CD3E', 'CD19'), { onLoad });
  search(dom, 'CD19');
  press(dom, 'Enter');
  await settleTurn();
  for (const load of loads) load.resolve();
  await settleTurn();
  assert.equal(dom.geneSearch.value, 'CD19');

  search(dom, 'NOTAGENE1');
  press(dom, 'Enter');
  await settleTurn();
  assert.equal(statusRegion(dom).textContent, 'NOTAGENE1 is not a gene in this dataset.');
  press(dom, 'Escape');
  assert.equal(dom.geneSearch.value, 'CD19', 'Escape names the gene shown');
  assert.equal(dom.geneDropdown.hidden, true);
  assert.equal(statusRegion(dom).textContent, '', 'and drops what was said of the name it gave up');

  // Typed and left without Enter (a click on the cells, Tab): the gene shown again.
  search(dom, 'CD3');
  dom.geneSearch.dispatch('blur', { relatedTarget: null });
  assert.equal(dom.geneSearch.value, 'CD19');
  assert.equal(loads.length, 1, 'nothing chosen by leaving');
});

test('a gene chosen while the open cells change is shown on the cells after the change', async t => {
  recordNotifications(t);
  const { loads, onLoad } = heldLoads();
  let generation = 7;
  const owner = createFieldInteractionOwner();
  const { dom, shown, state } = mountGeneSelector(exportedGenes('CD3E', 'AC058791.1'), {
    onLoad,
    interactionOwner: owner,
    generation: () => generation,
  });

  // A progressive opening's step is under way when Enter is pressed.
  const end = beginCellsChange();
  search(dom, 'AC058791.1');
  press(dom, 'Enter');
  await settleTurn();
  // The choice shows at once, and reads its gene once the cells settle.
  assert.equal(dom.geneSearch.value, 'AC058791.1');
  assert.deepEqual(loads, []);

  // The step commits: the cells, and so the generation, are new.
  generation += 1;
  end();
  await settleTurn();
  assert.deepEqual(loads.map(load => load.index), [1]);

  // No change of the open cells commits while the gene is read.
  let changeBegan = false;
  const nextChange = beginCellsChangeOnceSettled().then(endNext => {
    changeBegan = true;
    return endNext;
  });
  await settleTurn();
  assert.equal(changeBegan, false);

  loads[0].resolve();
  await settleTurn();
  assert.deepEqual(shown, ['AC058791.1'], 'the gene is shown, not dropped');
  assert.equal(state.activeVarFieldIndex, 1);
  (await nextChange)();
  assert.equal(changeBegan, true);
  await owner.destroy();
});

test('a gene chosen is named and holds the field menus through every refresh until its choice ends', async t => {
  // Found in CI (the obs menus' twin, `h5ad-ui-smoke.spec.mjs`): a refresh
  // of the selector while a choice was under way (the gene list read after
  // the first view, an annotation change) put back what was shown and
  // erased the choice. The choice under way is what a refresh names.
  recordNotifications(t);
  const { loads, onLoad } = heldLoads();
  const owner = createFieldInteractionOwner();
  const { api, dom, shown } = mountGeneSelector(exportedGenes('CD3E', 'AC058791.1'), {
    onLoad,
    interactionOwner: owner,
  });
  // The action waits its turn (as behind a change of the open cells, or a
  // history move): the dispatcher's gate is held.
  let openGate;
  getActions().setGate(() => new Promise(resolve => { openGate = resolve; }));
  t.after(() => getActions().setGate(() => undefined));

  search(dom, 'AC058791.1');
  press(dom, 'Enter');
  await settleTurn();
  assert.deepEqual(loads, [], 'the action waits its turn');
  assert.equal(api.isChoosing(), true);
  api.syncFromState();
  assert.equal(dom.geneSearch.value, 'AC058791.1', 'a refresh names the choice waiting its turn');

  openGate();
  await settleTurn();
  assert.deepEqual(loads.map(load => load.index), [1]);
  assert.equal(api.isChoosing(), true);
  api.initGeneExpressionDropdown();
  api.syncFromState();
  assert.equal(dom.geneSearch.value, 'AC058791.1', 'a refresh names the choice being read');

  loads[0].resolve();
  await settleTurn();
  assert.deepEqual(shown, ['AC058791.1']);
  assert.equal(api.isChoosing(), false);
  api.syncFromState();
  assert.equal(dom.geneSearch.value, 'AC058791.1');
  await owner.destroy();
});

test('a gene chosen while choices are held says why it is not shown', async t => {
  const notifications = recordNotifications(t);
  const { loads, onLoad } = heldLoads();
  const owner = createFieldInteractionOwner();
  const { dom, shown } = mountGeneSelector(exportedGenes('CD3E'), { onLoad, interactionOwner: owner });

  const release = owner.acquireSuspension('the view is being saved');
  assert.equal(owner.suspensionReason(), 'the view is being saved');
  search(dom, 'cd3e');
  press(dom, 'Enter');
  await settleTurn();
  const said = describeUnshownField('CD3E', 'the view is being saved');
  assert.equal(said, 'CD3E is not shown: the view is being saved. Choose it again when that has ended.');
  assert.deepEqual(notifications, [['info', said]]);
  assert.equal(statusRegion(dom).textContent, said);
  assert.deepEqual(loads, []);
  release();
  assert.equal(owner.suspensionReason(), null);

  // Retired by a saved view restored while it was read: said too.
  search(dom, 'cd3e');
  press(dom, 'Enter');
  await settleTurn();
  assert.equal(loads.length, 1);
  const releaseRestore = owner.acquireRetiringSuspension('a saved view is being restored');
  await settleTurn();
  assert.deepEqual(notifications.at(-1), [
    'info',
    'CD3E is not shown: a saved view is being restored. Choose it again when that has ended.',
  ]);
  releaseRestore();

  // A newer choice replaces an older one without a word.
  const count = notifications.length;
  search(dom, 'cd3e');
  press(dom, 'Enter');
  await settleTurn();
  search(dom, 'cd3e');
  press(dom, 'Enter');
  await settleTurn();
  loads.at(-1).resolve();
  await settleTurn();
  assert.equal(notifications.length, count);
  assert.deepEqual(shown, ['CD3E']);
  await owner.destroy();
});

/** Replace the gene list as Data mapping does: new fields, each old one's successor named. */
function replaceGeneList(api, state, fields, keys, successorOf) {
  const previous = [...fields];
  fields.splice(0, fields.length, ...exportedGenes(...keys));
  for (const [position, field] of previous.entries()) {
    const next = successorOf(field, position);
    if (next !== undefined) state.successors.set(field, fields[next]);
  }
  api.initGeneExpressionDropdown();
}

test('a gene list replaced before or while the gene is read: the choice follows its gene to the new list', async t => {
  const notifications = recordNotifications(t);
  const { loads, onLoad } = heldLoads();
  const owner = createFieldInteractionOwner();
  const fields = exportedGenes('CD3E', 'AC058791.1');
  const { api, dom, shown, state } = mountGeneSelector(fields, { onLoad, interactionOwner: owner });

  // Replaced before the gene is read (the cells were changing): another
  // order, the gene found by its name.
  const end = beginCellsChange();
  search(dom, 'AC058791.1');
  press(dom, 'Enter');
  await settleTurn();
  replaceGeneList(api, state, fields, ['AC058791.1', 'MS4A1', 'CD3E'], field => (
    ['AC058791.1', 'MS4A1', 'CD3E'].indexOf(field.key)
  ));
  end();
  await settleTurn();
  assert.deepEqual(loads.map(load => load.index), [0]);
  loads[0].resolve();
  await settleTurn();
  assert.deepEqual(shown, ['AC058791.1']);

  // Replaced while the gene is read (the values of the same genes read
  // another way: the pbmc3k case): the superseded load is read again on the
  // new list, by position, and shown.
  search(dom, 'MS4A1');
  press(dom, 'Enter');
  await settleTurn();
  assert.deepEqual(loads.map(load => load.index), [0, 1]);
  replaceGeneList(api, state, fields, ['AC058791.1', 'MS4A1', 'CD3E'], (field, position) => position);
  // The selector is refreshed for the new list (the app does on
  // `var-axis:changed`): the search keeps naming the gene being chosen, not
  // the one shown (it used to empty).
  api.syncFromState();
  assert.equal(dom.geneSearch.value, 'MS4A1');
  api.clearLocalSelectionUI();
  assert.equal(dom.geneSearch.value, 'MS4A1');
  // The loading layer drops a load whose list was replaced under it.
  loads[1].reject(cancelled('superseded', 'Field loading was superseded by a replacement dataset generation.'));
  await settleTurn();
  assert.deepEqual(loads.map(load => load.index), [0, 1, 1]);
  loads[2].resolve();
  await settleTurn();
  assert.deepEqual(shown, ['AC058791.1', 'MS4A1']);
  assert.equal(state.activeVarFieldIndex, 1);
  assert.equal(api !== null && dom.geneSearch.value, 'MS4A1');

  // Replaced by a list without the gene: said.
  search(dom, 'CD3E');
  press(dom, 'Enter');
  await settleTurn();
  replaceGeneList(api, state, fields, ['AC058791.1', 'MS4A1'], field => (
    field.key === 'CD3E' ? undefined : ['AC058791.1', 'MS4A1'].indexOf(field.key)
  ));
  loads.at(-1).resolve();
  await settleTurn();
  assert.deepEqual(shown, ['AC058791.1', 'MS4A1']);
  assert.deepEqual(notifications.at(-1), [
    'info',
    'CD3E is not shown: the gene list changed while it was read (Session › Data mapping) and no longer has it.',
  ]);
  await owner.destroy();
});

test('coloring by a gene from elsewhere refuses, with the reason, a name the list cannot choose', async () => {
  const { loads, onLoad } = heldLoads();
  const listing = { pending: false, failure: null };
  const { api } = mountGeneSelector(exportedGenes('CD3E'), { onLoad, listing });
  await assert.rejects(api.colorByGene('cd3e'), error => (
    error instanceof GeneUnavailableError && error.message === 'cd3e is not a gene in this dataset.'
  ));
  listing.pending = true;
  await assert.rejects(api.colorByGene('CD3E'), error => (
    error instanceof GeneUnavailableError && error.reason === 'pending'
  ));
  listing.pending = false;
  const shown = api.colorByGene('CD3E');
  await settleTurn();
  assert.deepEqual(loads.map(load => load.index), [0]);
  loads[0].resolve();
  // The action's outcome names what is shown.
  assert.deepEqual(await shown, { field: 'CD3E', source: 'var', kind: 'continuous' });
});

test('the analysis gene picker takes the gene typed on Enter, not None, and says when a name is no gene', async t => {
  const previous = globalThis.document;
  globalThis.document = createFakeDocument();
  t.after(() => { globalThis.document = previous; });
  const { createGeneExpressionSelector } = await import('../assets/js/app/analysis/ui/components/selectors.js');
  const chosen = [];
  const picker = createGeneExpressionSelector({
    genes: [{ key: 'CD3E' }, { key: 'ENSG00000141510' }, { key: 'AC058791.1' }],
    onChange: gene => chosen.push(gene),
    label: '',
  });
  const input = picker.children[0].children[0];
  const dropdown = picker.children[0].children[1];
  const typeAndEnter = text => {
    input.dispatch('focus');
    input.value = text;
    input.dispatch('input');
    input.dispatch('keydown', { key: 'Enter', preventDefault() {} });
  };
  typeAndEnter('ac058791.1');
  typeAndEnter('ENSG00000141510.17');
  // With a gene chosen, typing another and Enter takes it (it used to clear
  // the choice: None stayed active).
  typeAndEnter('cd3');
  assert.deepEqual(chosen, ['AC058791.1', 'ENSG00000141510', 'CD3E']);
  typeAndEnter('NOTAGENE1');
  assert.deepEqual(chosen, ['AC058791.1', 'ENSG00000141510', 'CD3E']);
  assert.equal(dropdown.hidden, false);
  assert.equal(dropdown.querySelector('.dropdown-no-results').textContent, 'NOTAGENE1 is not a gene in this dataset.');
  // Enter in the empty box chooses what is active: the gene chosen.
  typeAndEnter('');
  assert.deepEqual(chosen.at(-1), 'CD3E');
});
