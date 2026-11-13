/**
 * The open cells in use (`useOpenCells`, `data/open-cells-work.js`): an
 * operation that reads the open cells over several turns -- saving a
 * session (the Save button, the notebook's session request), a cell export
 * -- starts once no growth step or Apply is changing them, and no change
 * commits until it is done, so it never reads two sets of cells. A change
 * begins in the same turn as it sees no work under way
 * (`beginCellsChangeOnceSettled`), so no operation slips under it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SESSION_TEST_VERSION } from './helpers/session-dataset.mjs';

import {
  beginCellsChangeOnceSettled,
  cellWorkRunning,
  cellsSteady,
  useOpenCells,
} from '../assets/js/data/open-cells-work.js';
import { SessionSerializer } from '../assets/js/app/session/session-serializer.js';
import { readHistoryFileManifest } from '../assets/js/app/session/history-file.js';
import { createActionCatalog } from '../assets/js/app/actions/catalog.js';
import { createActionDispatcher } from '../assets/js/app/actions/dispatcher.js';
import { createDomainRegistry } from '../assets/js/app/actions/domains.js';
import { createHistory } from '../assets/js/app/history/history.js';
import { DimensionManager } from '../assets/js/data/dimension-manager.js';
import { initCellExportsUi } from '../assets/js/app/ui/modules/cell-exports-ui.js';
import { createCellIdentity } from '../assets/js/data/cell-identity.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const turn = () => new Promise(resolve => setImmediate(resolve));

test('a change waits for the open cells in use; an operation waits for a change under way', async () => {
  const events = [];
  const release = deferred();
  const using = useOpenCells(async () => {
    events.push('use:start');
    // Work inside may wait for the cells to be steady: no change begins
    // under it, so it never waits on itself.
    assert.equal(cellsSteady(), null);
    await release.promise;
    events.push('use:end');
    return 'read';
  });
  await turn();
  const changing = beginCellsChangeOnceSettled().then(end => {
    events.push('change:begin');
    return end;
  });
  await turn();
  assert.deepEqual(events, ['use:start']);
  release.resolve();
  assert.equal(await using, 'read');
  const end = await changing;
  assert.deepEqual(events, ['use:start', 'use:end', 'change:begin']);

  // While the change is under way, an operation waits for it to end.
  const after = useOpenCells(() => {
    events.push('use:after');
  });
  await turn();
  assert.equal(events.at(-1), 'change:begin');
  end();
  await after;
  assert.equal(events.at(-1), 'use:after');
  assert.equal(cellWorkRunning(), false);
});

/** A DataState stand-in a session fingerprint reads, whose open cells a test changes. */
function datasetState() {
  const dimensionManager = new DimensionManager();
  dimensionManager.registerLayouts([{
    layoutKey: 'X_umap_3d',
    dimension: 3,
    label: 'UMAP 3D',
    path: 'obsm/0/0-1-2',
    provenance: { key: 'X_umap_3d', columns: [0, 1, 2] },
    origin: 'identity',
  }]);
  dimensionManager.setRepresentations(['X_umap_3d'], new Map([[3, 'X_umap_3d']]));
  const state = {
    generation: 1,
    pointCount: 2,
    positionsArray: new Float32Array(6),
    obsData: { fields: [] },
    varData: { fields: [{ key: 'GENE_A' }] },
    dimensionManager,
    dataMapping: Object.freeze({
      kind: 'anndata',
      embeddings: {
        enabled: [{ key: 'X_umap_3d', columns: [0, 1, 2] }],
        defaults: { '1d': null, '2d': null, '3d': { key: 'X_umap_3d', columns: [0, 1, 2] } },
      },
      knn: null,
      geneNames: 'index',
      expression: 'X',
      log1p: {},
      highlyVariable: null,
      latent: null,
      vectorFields: [],
    }),
    getDatasetGeneration() { return this.generation; },
    getViewDimensionLevel: () => 3,
    getDataMapping() { return this.dataMapping; },
    getViewLayoutKey: () => 'X_umap_3d',
    getActiveViewId: () => 'live',
    /** A growth step's commit: more cells, new per-cell arrays. */
    grow() {
      this.pointCount += 2;
      this.positionsArray = new Float32Array(this.pointCount * 3);
    },
  };
  // The reader worker's digest of the cells open now.
  dimensionManager.getCellOrderDigest = async () => state.pointCount.toString(16).padStart(16, '0');
  return state;
}

/** The session files of `state`, over a started history whose domains hold nothing. */
async function sessionFiles(state) {
  const domains = createDomainRegistry();
  for (const id of domains.missing()) domains.provide(id, { capture: () => null, restore: () => {} });
  const dispatcher = createActionDispatcher({ catalog: createActionCatalog([]) });
  const history = createHistory({ dispatcher, domains, dataset: { id: null, name: null, cellOrder: null }, newTrackerId: () => 't-00000000-0000-4000-8000-000000000001' });
  await history.startTracker();
  return new SessionSerializer({ state, dataSourceManager: null, getHistory: () => history, dispatcher, onLoaded: () => {}, version: () => SESSION_TEST_VERSION });
}

test('a growth step waits for a session being saved, and the session describes one set of cells', async () => {
  const state = datasetState();
  const serializer = await sessionFiles(state);
  const entered = deferred();
  const release = deferred();
  // The session's dataset part is taken over several turns (the reader worker answers the digest).
  const digest = state.dimensionManager.getCellOrderDigest;
  state.dimensionManager.getCellOrderDigest = async layoutKey => {
    const answer = await digest(layoutKey);
    entered.resolve();
    await release.promise;
    return answer;
  };
  const saving = serializer.createSessionBundle();
  await entered.promise;
  // A progressive opening's next step asks to change the cells now.
  let committed = false;
  const step = beginCellsChangeOnceSettled().then(end => {
    state.grow();
    committed = true;
    end();
  });
  await turn();
  assert.equal(committed, false, 'the step waits for the session being saved');
  release.resolve();
  const bundle = await saving;
  await step;
  assert.equal(committed, true);
  const manifest = await readHistoryFileManifest(bundle);
  assert.equal(manifest.datasetFingerprint.cellCount, 2, 'saved on the cells open when it began');
  assert.equal(manifest.datasetFingerprint.cellOrder.digest, '0000000000000002');
});

test('a session asked for while a growth step commits is saved on the cells after it', async () => {
  const state = datasetState();
  const serializer = await sessionFiles(state);
  const end = await beginCellsChangeOnceSettled();
  const saving = serializer.createSessionBundle();
  await turn();
  state.grow();
  end();
  const manifest = await readHistoryFileManifest(await saving);
  assert.equal(manifest.datasetFingerprint.cellCount, 4);
  assert.equal(manifest.datasetFingerprint.cellOrder.digest, '0000000000000004');
});

/** The export buttons over fake elements; `exports` records what each export saw. */
function exportsUi({ adapters, state }) {
  const element = () => {
    const target = new EventTarget();
    target.hidden = false;
    target.disabled = false;
    target.value = '0';
    return target;
  };
  const dom = {
    highlightsCsvButton: element(),
    highlightsH5adButton: element(),
    categoricalExportButton: element(),
    continuousExportButton: element(),
    categoricalSelect: element(),
    continuousSelect: element(),
  };
  const outcomes = [];
  const cancels = [];
  const notifications = {
    progress: (_text, _percent, options) => {
      cancels.push(options?.onCancel ?? null);
      return 'progress';
    },
    updateProgress() {},
    complete: (_id, message) => outcomes.push(['complete', message]),
    fail: (_id, message) => outcomes.push(['fail', message]),
    dismiss: () => outcomes.push(['dismiss']),
    info: message => outcomes.push(['info', message]),
  };
  initCellExportsUi({
    state,
    dom,
    getAnnDataSource: () => ({ getAdapter: () => adapters.current }),
    notifications,
  });
  return { dom, outcomes, cancels };
}

test('a growth step waits for a cell export, and an export asked during one reads the cells after it', async () => {
  const originalCreate = URL.createObjectURL;
  const saved = [];
  // `saveExport` hands the file to the browser: recorded here.
  URL.createObjectURL = blob => {
    saved.push(blob);
    return 'blob:export';
  };
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: () => ({ click() {}, remove() {}, set href(_) {}, set download(_) {}, style: {} }),
    body: { appendChild() {}, removeChild() {} },
  };
  try {
    const nameRead = deferred();
    const release = deferred();
    let pointCount = 3;
    const fieldCodes = () => Uint8Array.from({ length: pointCount }, (_, i) => i % 2);
    const adapterOf = generation => ({
      async getObsNames() {
        nameRead.resolve();
        await release.promise;
        // An adapter of an earlier opening is closed once the cells change.
        if (adapters.current.generation !== generation) throw new Error('AnnData adapter is closed; reopen the dataset before requesting data');
        return Array.from({ length: pointCount }, (_, i) => `cell${i}`);
      },
      generation,
    });
    const adapters = { current: null };
    adapters.current = adapterOf(1);
    const state = {
      get pointCount() { return pointCount; },
      get cellIdentity() { return createCellIdentity({ nObs: pointCount }); },
      async ensureFieldLoaded() {
        return { key: 'cluster', kind: 'category', categories: ['a', 'b'], codes: fieldCodes() };
      },
      getActivePageId: () => null,
      getHighlightedCellCountForPage: () => 0,
      on: () => () => {},
    };
    const { dom, outcomes } = exportsUi({ adapters, state });
    const grow = () => {
      pointCount += 2;
      adapters.current = adapterOf(adapters.current.generation + 1);
    };

    // A step asked while the export reads waits for it.
    dom.categoricalExportButton.dispatchEvent(new Event('click'));
    await nameRead.promise;
    let committed = false;
    const step = beginCellsChangeOnceSettled().then(end => {
      grow();
      committed = true;
      end();
    });
    await turn();
    assert.equal(committed, false);
    release.resolve();
    await step;
    while (outcomes.length === 0) await turn();
    // The obs-column CSV: header, kind and categories rows (the field's
    // categories in its order), then a row per cell.
    assert.deepEqual(outcomes[0], ['complete', 'Export the field (CSV): cluster.csv (85 B)']);
    const first = await saved[0].text();
    assert.equal(first, 'obs_name,cluster\nkind,categorical\ncategories,"[""a"",""b""]"\ncell0,a\ncell1,b\ncell2,a\n',
      'the three header rows, then every row of the three cells it began on');

    // An export clicked while a step commits starts on the cells after it,
    // with the adapter of that reading.
    const end = await beginCellsChangeOnceSettled();
    dom.categoricalExportButton.dispatchEvent(new Event('click'));
    await turn();
    grow();
    end();
    while (outcomes.length === 1) await turn();
    assert.equal(outcomes[1][0], 'complete', JSON.stringify(outcomes[1]));
    const second = await saved[1].text();
    assert.equal(second.trim().split('\n').length, 3 + 7, 'the three header rows, then every row of the seven cells after the step');
  } finally {
    URL.createObjectURL = originalCreate;
    globalThis.document = previousDocument;
  }
});

test('a cell export is stopped by its card\'s Cancel: its reads stop, nothing is written, nothing is reported as failed', async () => {
  const release = deferred();
  const named = deferred();
  const adapters = {
    current: {
      async getObsNames() {
        named.resolve();
        await release.promise;
        return ['cell0', 'cell1', 'cell2'];
      },
    },
  };
  const state = {
    get pointCount() { return 3; },
    get cellIdentity() { return createCellIdentity({ nObs: 3 }); },
    async ensureFieldLoaded() {
      return { key: 'cluster', kind: 'category', categories: ['a', 'b'], codes: Uint8Array.of(0, 1, 0) };
    },
    getActivePageId: () => null,
    getHighlightedCellCountForPage: () => 0,
    on: () => () => {},
  };
  const { dom, outcomes, cancels } = exportsUi({ adapters, state });
  dom.categoricalExportButton.dispatchEvent(new Event('click'));
  await named.promise;
  assert.equal(typeof cancels[0], 'function', 'its card can stop it');
  // A second click while it runs is answered, not ignored.
  dom.categoricalExportButton.dispatchEvent(new Event('click'));
  await turn();
  assert.match(outcomes.find(outcome => outcome[0] === 'info')?.[1] ?? '', /being written/);
  cancels[0]();
  release.resolve();
  const ended = () => outcomes.find(outcome => ['dismiss', 'fail', 'complete'].includes(outcome[0]));
  while (ended() === undefined) await turn();
  assert.deepEqual(ended(), ['dismiss'], 'stopped: dismissed, neither written nor failed');
});
