/**
 * "Save AnnData with this state…" as an action (`history.anndata.save`,
 * `app/history/anndata-copy-save.js`): where the bytes go and what is left
 * when they do not all get there. The person's click names a new file in
 * the save dialog (its writable closed once every byte is in; aborted, never
 * closed, on a failure or a cancel, so no partial file stays under the
 * name); otherwise a spool downloaded once whole (its files removed on a
 * failure or a cancel, nothing downloaded). The dataset's own file is
 * never written over, and a name a file cannot hold is refused before a
 * byte is written. The copy itself is the reader's (`tests/anndata-copy-*`),
 * the plan `tests/history-anndata-copy.test.mjs`'s; here both are faked at
 * their boundary (`readCopyTarget`, `writeAnnDataCopy`).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { HISTORY_GOLDEN_EXPECTED_PATH, goldenSession } from '../scripts/generate-history-golden.mjs';
import { createActionCatalog } from '../assets/js/app/actions/catalog.js';
import { ACTION_DEFINITIONS } from '../assets/js/app/actions/definitions/index.js';
import { createActionDispatcher } from '../assets/js/app/actions/dispatcher.js';
import { copyFileName, copyFileNamed, provideAnnDataCopyAction } from '../assets/js/app/history/anndata-copy-save.js';
import { isCancellation } from '../assets/js/utils/abort.js';
import { liveTracker, valuesAt } from '../assets/js/app/history/tree.js';

const expected = JSON.parse(readFileSync(HISTORY_GOLDEN_EXPECTED_PATH, 'utf8'));

/** The page around the action: the golden history shown, a dataset as stored, and every outside call recorded. */
async function page({ copy = async (changes, { sink }) => { await sink.write(new Blob(['PK'])); return copied(); }, geneSets = null } = {}) {
  const session = await goldenSession();
  const calls = [];
  const values = new Map(session.values);
  if (geneSets !== null) {
    // The head's gene sets read as others: a name a file cannot hold.
    const tracker = session.trackers.find(each => each.id === session.activeTracker);
    values.set(valuesAt(liveTracker(tracker), tracker.headId)['gene-sets'], { sets: geneSets });
  }
  const history = {
    active: { id: session.activeTracker },
    snapshot: () => ({ trackers: session.trackers, activeTracker: session.activeTracker }),
    pool: { get: hash => values.get(hash), hold: () => () => {} },
    trackerRecord: id => session.trackers.find(each => each.id === id),
  };
  const dispatcher = createActionDispatcher({ catalog: createActionCatalog(ACTION_DEFINITIONS) });
  const spool = {
    parts: [],
    async write(part) { this.parts.push(part); calls.push(['spool.write', part.size]); },
    async finish() { calls.push(['spool.finish']); return new Blob(this.parts); },
    async discard() { this.parts = []; calls.push(['spool.discard']); },
  };
  const adapter = {
    async readCopyTarget(names) {
      calls.push(['readCopyTarget', names]);
      const columns = Object.fromEntries(names.map(name => [name, {
        kind: 'categorical', categories: [...expected.dataset.obs[name].categories], codes: Int8Array.from(expected.dataset.obs[name].codes), ordered: false,
      }]));
      return { nObs: expected.dataset.n_obs, obsColumns: ['cell_type', 'leiden'], modalityColumns: [], varColumns: [], columns, cellucid: null };
    },
    async writeAnnDataCopy(changes, options) {
      calls.push(['writeAnnDataCopy', changes.obs.map(change => change.name)]);
      return copy(changes, options);
    },
  };
  const notices = [];
  const stop = provideAnnDataCopyAction({
    dispatcher,
    histories: { current: () => history },
    serializer: { writeShare: async () => ({ blob: new Blob(['a state file']) }) },
    state: { cellIdentity: null, varData: { fields: expected.dataset.var_names.map((key, i) => ({ key, path: `var/X/${i}` })) } },
    adapter: () => adapter,
    datasetFacts: () => ({ name: 'History golden' }),
    sourceHandle: async () => 'source-handle',
    createSpool: async () => { calls.push(['spool']); return spool; },
    download: (blob, name) => calls.push(['download', name, blob.size]),
    notifications: {
      warning: message => notices.push(['warning', message]),
      success: message => notices.push(['success', message]),
      error: message => notices.push(['error', message]),
      progress: () => 'n1', updateProgress: () => {}, complete: () => {}, fail: () => {}, dismiss: () => {}, reveal: () => {},
    },
    version: () => '0.9.7',
  });
  return { dispatcher, calls, notices, stop };
}

function copied() {
  return { bytes: 2, entries: 1, zip64: false, chunks: 1, layout: 'anndata', nObs: expected.dataset.n_obs, priorityOrder: false, notes: ['uns/odd was left out: a codec the browser lacks.'] };
}

/** A save dialog that hands back a writable recording what happens to it. */
function withDialog(calls, { pick = async () => null, same = false } = {}) {
  const writable = {
    async write(part) { calls.push(['file.write', part.size]); },
    async close() { calls.push(['file.close']); },
    async abort() { calls.push(['file.abort']); },
  };
  globalThis.showSaveFilePicker = async options => {
    calls.push(['dialog', options.suggestedName]);
    await pick();
    return { name: options.suggestedName, isSameEntry: async other => same && other === 'source-handle', createWritable: async () => writable };
  };
  return () => { delete globalThis.showSaveFilePicker; };
}

test('without a dialog (an agent, or a browser without one): a spool, downloaded once whole; the result says what was applied and left out', async () => {
  const { dispatcher, calls, notices, stop } = await page();
  const { outcome } = await dispatcher.dispatch('history.anndata.save', {}, { origin: 'host', host: 'python' });
  assert.equal(outcome.file, 'History golden with this state.zarr.zip');
  assert.equal(outcome.to, 'download');
  assert.equal(outcome.cells, expected.dataset.n_obs);
  assert.equal(outcome.step, 's13');
  assert.equal(outcome.applied, true);
  assert.deepEqual(outcome.rows.map(row => [row.name, row.status]), expected.apply.sequence[0].rows.map(row => [row.name, row.status]));
  assert.ok(outcome.left_out.includes('Active field: Presentation: not applied to the object.'));
  assert.ok(outcome.left_out.includes('uns/odd was left out: a codec the browser lacks.'));
  assert.deepEqual(calls.filter(([kind]) => kind.startsWith('spool') || kind === 'download'), [
    ['spool'], ['spool.write', 2], ['spool.finish'], ['download', 'History golden with this state.zarr.zip', 2],
  ]);
  assert.deepEqual(calls.find(([kind]) => kind === 'writeAnnDataCopy'),
    ['writeAnnDataCopy', ['cell_type', 'score', 'cell_type (merged)', 'cellucid_highlight__QC__Doublets']]);
  assert.match(notices.at(-1)[1], /^Saved History golden with this state\.zarr\.zip \(2 B\): 5 changes applied, 3 items left out \(see Details\)\.$/);
  stop();
});

test('a copy that fails: the spool\'s files are removed and nothing is downloaded', async () => {
  const { dispatcher, calls, stop } = await page({
    copy: async (changes, { sink }) => {
      await sink.write(new Blob(['partial']));
      throw new Error('The link failed.');
    },
  });
  await assert.rejects(dispatcher.dispatch('history.anndata.save', {}, { origin: 'host', host: 'r' }), /The link failed/);
  assert.deepEqual(calls.filter(([kind]) => kind.startsWith('spool') || kind === 'download'), [['spool'], ['spool.write', 7], ['spool.discard']]);
  stop();
});

test('the person\'s click: a new file in the save dialog, closed once whole; a cancel mid-copy aborts it, never closes it', async () => {
  {
    const { dispatcher, calls, stop } = await page();
    const restore = withDialog(calls);
    try {
      const { outcome } = await dispatcher.dispatch('history.anndata.save', { file: 'Annotated.zarr.zip' }, { origin: 'user' });
      assert.equal(outcome.to, 'file');
      assert.equal(outcome.file, 'Annotated.zarr.zip');
      assert.deepEqual(calls.filter(([kind]) => kind.startsWith('file') || kind === 'dialog' || kind.startsWith('spool')),
        [['dialog', 'Annotated.zarr.zip'], ['file.write', 2], ['file.close']]);
      assert.equal(calls[0][0], 'dialog', 'the dialog opens first, while the click lets the page open it');
    } finally {
      restore();
      stop();
    }
  }
  {
    const stopper = new AbortController();
    const { dispatcher, calls, notices, stop } = await page({
      copy: async (changes, { sink, signal }) => {
        await sink.write(new Blob(['first batch']));
        stopper.abort();
        await new Promise(resolve => setTimeout(resolve, 0));
        if (signal.aborted) throw signal.reason;
        return copied();
      },
    });
    const restore = withDialog(calls);
    try {
      await assert.rejects(dispatcher.dispatch('history.anndata.save', {}, { origin: 'user', signal: stopper.signal }), error => isCancellation(error));
      assert.deepEqual(calls.filter(([kind]) => kind.startsWith('file')), [['file.write', 11], ['file.abort']]);
      assert.deepEqual(notices, [], 'a cancel is no failure and no refusal');
    } finally {
      restore();
      stop();
    }
  }
});

test('the dialog closed without a name: nothing is written; the dataset\'s own file is refused', async () => {
  {
    const { dispatcher, calls, stop } = await page();
    globalThis.showSaveFilePicker = async () => { throw Object.assign(new Error('closed'), { name: 'AbortError' }); };
    try {
      await assert.rejects(dispatcher.dispatch('history.anndata.save', {}, { origin: 'user' }), error => isCancellation(error));
      assert.ok(!calls.some(([kind]) => kind === 'writeAnnDataCopy' || kind === 'spool'));
    } finally {
      delete globalThis.showSaveFilePicker;
      stop();
    }
  }
  {
    const { dispatcher, calls, notices, stop } = await page();
    const restore = withDialog(calls, { same: true });
    try {
      await assert.rejects(dispatcher.dispatch('history.anndata.save', {}, { origin: 'user' }), /That is the file this dataset is open from/);
      assert.ok(!calls.some(([kind]) => kind === 'writeAnnDataCopy' || kind.startsWith('file.')));
      assert.match(notices.at(-1)[1], /^That is the file this dataset is open from; a copy is always saved as a new file, so choose another name\.$/);
    } finally {
      restore();
      stop();
    }
  }
});

test('a gene set whose name a file cannot hold is refused in one sentence, before a byte is written', async () => {
  const { dispatcher, calls, notices, stop } = await page({ geneSets: [{ name: 'CD4+/CD8+ T', description: '', genes: ['CD3E'] }] });
  await assert.rejects(dispatcher.dispatch('history.anndata.save', {}, { origin: 'host', host: 'python' }), /The gene set "CD4\+\/CD8\+ T" cannot be saved in a file under that name/);
  assert.ok(!calls.some(([kind]) => kind === 'writeAnnDataCopy' || kind === 'download'));
  assert.deepEqual(calls.filter(([kind]) => kind.startsWith('spool')), [['spool'], ['spool.discard']]);
  assert.equal(notices.length, 1);
  stop();
});

test('the file\'s name: the dataset\'s, ending .zarr.zip, nothing a file name cannot hold', () => {
  assert.equal(copyFileName('PBMC 3k'), 'PBMC 3k with this state.zarr.zip');
  assert.equal(copyFileName('a/b: c'), 'a_b_ c with this state.zarr.zip');
  assert.equal(copyFileName(null), 'Cellucid dataset with this state.zarr.zip');
  // A name given: kept when the input-format registry reads it as an AnnData Zarr in one ZIP, else the ending added.
  assert.equal(copyFileNamed('Annotated.zarr.zip'), 'Annotated.zarr.zip');
  assert.equal(copyFileNamed('Annotated'), 'Annotated.zarr.zip');
  assert.equal(copyFileNamed('Annotated.h5ad'), 'Annotated.h5ad.zarr.zip');
});
