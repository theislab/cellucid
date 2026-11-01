/**
 * Every analysis result says how the open cells were chosen (audit F-2):
 * the identity of the open cells carries the subsample's specification
 * (`createCellIdentity({choice})`, made by `AnnDataFileSource.getCellIdentity`
 * from the opening), and `describeOpenCellChoice` names the method and share,
 * a warning when the cells are not a random sample of the file at one rate
 * (blocks, stratified balanced or with a minimum, spatial, the first chunks
 * of an opening, an unknown choice). Composition refuses to run on cells
 * stratified by its own cell-type field at unequal shares.
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { describeOpenCellChoice } from '../assets/js/app/analysis/shared/open-cell-choice.js';
import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { AnnDataFileSource } from '../assets/js/data/anndata-file-source.js';
import { createCellIdentity } from '../assets/js/data/cell-identity.js';
import { setNextCellSubsetRequest } from '../assets/js/data/cell-subset-policy.js';

const FOLDER = new URL('./fixtures/subsample-analysis/', import.meta.url);
const REFERENCE = JSON.parse(readFileSync(new URL('reference.json', FOLDER), 'utf8'));

const kept = Uint32Array.from([0, 2, 5, 9]);
const identityOf = (spec, chunked = false) => createCellIdentity({ nObs: 40, kept, choice: { spec, chunked } });

test('a whole opening has no choice to state; a subsample keeps its own', () => {
  const whole = createCellIdentity({ nObs: 4, kept: Uint32Array.from([0, 1, 2, 3]), choice: { spec: null, chunked: false } });
  assert.equal(whole.isSubset, false);
  assert.equal(whole.choice, null);
  assert.equal(describeOpenCellChoice(whole), null);
  assert.equal(describeOpenCellChoice(null), null);
  const spec = Object.freeze({ method: 'uniform', nObs: 40, k: 4, seed: 0 });
  const identity = identityOf(spec);
  assert.equal(identity.choice.spec, spec);
  assert.ok(Object.isFrozen(identity.choice));
  assert.throws(() => createCellIdentity({ nObs: 40, kept, choice: { spec } }), /spec, chunked/);
});

test('the method, the share and whether the cells estimate the file', () => {
  const cases = [
    [{ method: 'uniform', nObs: 40, k: 4, seed: 0 }, false, 'uniform', true, null],
    [{ method: 'blocks', nObs: 40, k: 4, seed: 0, blockSize: 2 }, false, 'blocks', false, null],
    [{ method: 'stratified', nObs: 40, k: 4, seed: 0, field: 'cell_type', allocation: 'proportional', minPerCategory: 0 }, false, 'stratified', true, 'cell_type'],
    [{ method: 'stratified', nObs: 40, k: 4, seed: 0, field: 'cell_type', allocation: 'proportional', minPerCategory: 1 }, false, 'stratified', false, 'cell_type'],
    [{ method: 'stratified', nObs: 40, k: 4, seed: 0, field: 'cell_type', allocation: 'balanced', minPerCategory: 0 }, false, 'stratified', false, 'cell_type'],
    [{ method: 'spatial', nObs: 40, k: 4, seed: 0, embedding: 'X_umap', columns: [0, 1], gridSize: 8 }, false, 'spatial', false, null],
    // The first chunks of an opening still growing, whatever its method.
    [{ method: 'uniform', nObs: 40, k: 4, seed: 0 }, true, 'chunks', false, null],
    [null, false, 'unknown', false, null],
  ];
  for (const [spec, chunked, method, representative, field] of cases) {
    const choice = describeOpenCellChoice(identityOf(spec, chunked));
    const label = `${method}${spec?.allocation ? ` ${spec.allocation}` : ''}`;
    assert.equal(choice.method, method, label);
    assert.equal(choice.representative, representative, label);
    assert.equal(choice.tone, representative ? 'info' : 'warning', label);
    assert.equal(choice.field, field, label);
    assert.equal(choice.open, 4);
    assert.equal(choice.of, 40);
    assert.match(choice.text, /^10% of cells · /, label);
    assert.match(choice.title, /4 of 40 cells/, label);
  }
});

function quiet(t) {
  const notifications = getNotificationCenter();
  const names = ['startDownload', 'updateDownload', 'completeDownload', 'failDownload', 'dismissDownload', 'warning', 'error', 'info', 'loading', 'complete', 'fail', 'dismiss'];
  const originals = new Map(names.map(name => [name, notifications[name]]));
  for (const name of names) notifications[name] = () => `${name}-id`;
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  t.after(() => {
    for (const [name, method] of originals) notifications[name] = method;
    console.log = log;
    console.warn = warn;
  });
}

test('every opening of the differential harness states the method it was opened with', async t => {
  quiet(t);
  for (const opening of REFERENCE.openings.filter(entry => entry.kept.length > 1 && !entry.name.endsWith('-text'))) {
    if (opening.request !== null) setNextCellSubsetRequest({ ...opening.request, strict: true });
    const source = new AnnDataFileSource();
    try {
      await source.loadFile(new File([readFileSync(new URL(opening.file, FOLDER))], opening.file));
      const identity = source.getCellIdentity();
      const choice = describeOpenCellChoice(identity);
      if (opening.request === null) {
        assert.equal(choice, null, opening.name);
        continue;
      }
      assert.equal(identity.choice.spec.method, opening.request.method, opening.name);
      assert.equal(choice.method, opening.request.method, opening.name);
      const representative = opening.request.method === 'uniform'
        || (opening.request.method === 'stratified' && opening.request.allocation === 'proportional');
      assert.equal(choice.representative, representative, opening.name);
      assert.equal(choice.open, opening.kept.length, opening.name);
    } finally {
      source.clear();
    }
  }
});

test('Composition refuses cells stratified by its own cell-type field at unequal shares', async () => {
  const { CompositionUI } = await import('../assets/js/app/analysis/ui/analysis-types/composition-ui.js');
  const blockerOn = (spec, cellTypes) => {
    const ui = Object.create(CompositionUI.prototype);
    ui.dataLayer = { state: { cellIdentity: identityOf(spec) } };
    return ui._getRunBlocker({ cellTypes, samples: 'donor', condition: 'disease', onlyTypes: { mode: 'all', ids: [] } });
  };
  const balanced = { method: 'stratified', nObs: 40, k: 4, seed: 0, field: 'cell_type', allocation: 'balanced', minPerCategory: 0 };
  const proportional = { ...balanced, allocation: 'proportional' };
  assert.match(blockerOn(balanced, 'cell_type'), /keep each cell_type at a chosen size/);
  assert.match(blockerOn({ ...proportional, minPerCategory: 3 }, 'cell_type'), /chosen size/);
  // Proportional at one rate keeps the proportions; another field's design
  // is said by the result's chip, not refused.
  assert.equal(blockerOn(proportional, 'cell_type'), null);
  assert.equal(blockerOn(balanced, 'leiden'), null);
  assert.equal(blockerOn({ method: 'blocks', nObs: 40, k: 4, seed: 0, blockSize: 2 }, 'cell_type'), null);
});
