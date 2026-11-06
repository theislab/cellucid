/**
 * Floating analysis windows and the docked analysis panel are a view of
 * restored state: their settings name highlight pages by id, and opening one
 * validates those pages against the live page inventory. The history puts
 * domains back in domain order (`app/actions/domains.js`: `highlights` before
 * `analysis`), whatever order a saved state lists them in, so the analyses
 * are reopened once the pages they name are shown; and a failure puts back
 * every domain the restore had already changed (`app/history/history.js`).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createActionCatalog } from '../assets/js/app/actions/catalog.js';
import { createActionDispatcher } from '../assets/js/app/actions/dispatcher.js';
import { DOMAIN_IDS, createDomainRegistry } from '../assets/js/app/actions/domains.js';
import { createHistory } from '../assets/js/app/history/history.js';
import { createAnalysisDomain } from '../assets/js/app/state/domains/analysis.js';
import { createHighlightsDomain } from '../assets/js/app/state/domains/highlights.js';

function createState() {
  return {
    pointCount: 10,
    cellIdentity: null,
    highlightPages: [{ id: 'page_1', name: 'Page 1', color: '#ff0000', highlightedGroups: [] }],
    activePageId: 'page_1',
    _highlightPageIdCounter: 1,
    _highlightIdCounter: 0,
    obsData: { fields: [] },
    varData: { fields: [] },
    getHighlightPages() {
      return this.highlightPages;
    },
    getActivePageId() {
      return this.activePageId;
    },
    _recomputeHighlightArray() {},
    _notifyHighlightPageChange() {},
    _notifyHighlightChange() {},
  };
}

function createManager(state, opened) {
  return {
    exportSessionWindows: () => opened.map(entry => entry.descriptor),
    exportWindowPlaces: () => opened.map(entry => entry.place),
    async closeAll() {
      opened.length = 0;
    },
    async createFromSessionDescriptor(descriptor, place = null) {
      const pageIds = state.getHighlightPages().map(page => page.id);
      for (const pageId of descriptor.settings.selectedPages) {
        if (!pageIds.includes(pageId)) {
          throw new RangeError(`page "${pageId}" was not found`);
        }
      }
      opened.push({ descriptor, place: place ?? { rect: { left: 0, top: 0, width: 300, height: 200 }, open: true }, pageIds });
    },
  };
}

/** The docked panel: what it exports, and every state it was handed. */
function createDocked(initial = { openMode: null, modes: {} }) {
  let current = structuredClone(initial);
  const imported = [];
  return {
    imported,
    current: () => current,
    exportSessionState: () => structuredClone(current),
    async importSessionState(state) {
      imported.push(state);
      current = structuredClone(state);
    },
  };
}

/**
 * A page whose highlights and analyses are the real domain owners and whose
 * other domains hold nothing; `extra` provides owners of its own.
 */
function createPage({ state, analysisWindowManager, comparisonModule, extra = {} }) {
  const domains = createDomainRegistry();
  domains.provide('highlights', createHighlightsDomain({ state, refreshUi: () => {} }));
  domains.provide('analysis', createAnalysisDomain({ analysis: async () => ({ comparisonModule, analysisWindowManager }) }));
  for (const [id, owner] of Object.entries(extra)) domains.provide(id, owner);
  for (const id of domains.missing()) domains.provide(id, { capture: () => null, restore: () => {} });
  const history = createHistory({
    dispatcher: createActionDispatcher({ catalog: createActionCatalog([]) }),
    domains,
    dataset: { id: 'analysis-order', name: null, cellOrder: null },
    newTrackerId: () => 't-00000000-0000-4000-8000-000000000001',
  });
  return { domains, history };
}

const WINDOW = {
  modeId: 'differential',
  settings: { selectedPages: ['page_1', 'page_2'] },
  headerTitle: 'Differential expression',
  // A result's numeric columns stay typed arrays.
  result: { genes: ['CD3E', 'MS4A1'], log2FoldChange: Float32Array.from([1.5, -2.25]) },
};

const HIGHLIGHTS = {
  active: 'page_2',
  pages: [
    { id: 'page_1', name: 'A', color: '#ff0000', groups: [] },
    { id: 'page_2', name: 'B', color: '#00ff00', groups: [] },
  ],
};

test('analysis windows reopen against the restored highlight pages', async () => {
  assert.ok(
    DOMAIN_IDS.indexOf('highlights') < DOMAIN_IDS.indexOf('analysis'),
    'highlights are put back before the analyses that name their pages',
  );
  const state = createState();
  const opened = [];
  const { history } = createPage({
    state,
    analysisWindowManager: createManager(state, opened),
    comparisonModule: createDocked(),
  });

  // Listed analysis first: the history puts them back in domain order.
  await history.showValues({
    analysis: { windows: [WINDOW], docked: { openMode: null, modes: {} } },
    highlights: HIGHLIGHTS,
  });

  assert.equal(opened.length, 1);
  assert.deepEqual(opened[0].pageIds, ['page_1', 'page_2']);
  assert.ok(opened[0].descriptor.result.log2FoldChange instanceof Float32Array);
  assert.deepEqual([...opened[0].descriptor.result.log2FoldChange], [1.5, -2.25]);
  assert.deepEqual(state.getHighlightPages().map(page => page.id), ['page_1', 'page_2']);
});

test('a failed window reopen rolls the restored pages and windows back', async () => {
  const state = createState();
  const previousPages = structuredClone(state.highlightPages);
  const opened = [];
  const previousWindow = { ...WINDOW, settings: { selectedPages: ['page_1'] } };
  const manager = createManager(state, opened);
  await manager.createFromSessionDescriptor(previousWindow);
  const { domains, history } = createPage({ state, analysisWindowManager: manager, comparisonModule: createDocked() });
  const highlightsBefore = domains.owner('highlights').capture();

  const missingPageWindow = { ...WINDOW, settings: { selectedPages: ['page_9'] } };
  await assert.rejects(
    history.showValues({
      analysis: { windows: [missingPageWindow], docked: { openMode: null, modes: {} } },
      highlights: HIGHLIGHTS,
    }),
    /page "page_9" was not found/,
  );

  assert.deepEqual(state.highlightPages, previousPages);
  assert.equal(state.activePageId, 'page_1');
  assert.deepEqual(domains.owner('highlights').capture(), highlightsBefore);
  assert.deepEqual(opened.map(entry => entry.descriptor), [previousWindow]);
});

test('the docked analysis panel round-trips its open mode, settings and typed result, and a later failure puts it back', async () => {
  const saved = {
    openMode: 'differential',
    modes: {
      differential: {
        settings: { selectedPages: ['page_1', 'page_2'] },
        result: { genes: ['CD3E'], pValue: Float64Array.from([1e-12]) },
      },
      simple: { settings: { selectedPages: ['page_1'] }, result: null },
    },
  };
  const idleManager = {
    exportSessionWindows: () => [],
    exportWindowPlaces: () => [],
    async closeAll() {},
    async createFromSessionDescriptor() {
      throw new Error('no window is reopened while the windows are unchanged');
    },
  };
  const source = createAnalysisDomain({
    analysis: async () => ({ comparisonModule: { exportSessionState: () => saved }, analysisWindowManager: idleManager }),
  });
  const value = await source.capture();
  assert.deepEqual(value.docked, saved);
  assert.equal(value.docked.modes.differential.result.pValue, saved.modes.differential.result.pValue,
    'a result\'s typed arrays are kept by reference');

  const state = createState();
  const docked = createDocked();
  const lateFailure = new Error('late presentation failure');
  let layout = null;
  const { history } = createPage({
    state,
    analysisWindowManager: idleManager,
    comparisonModule: docked,
    extra: {
      // A domain put back after the analyses (`layout`) that refuses its value.
      layout: {
        capture: () => layout,
        restore(next) {
          if (next === 'refused') throw lateFailure;
          layout = next;
        },
      },
    },
  });
  assert.ok(DOMAIN_IDS.indexOf('analysis') < DOMAIN_IDS.indexOf('layout'));

  await history.showValues({ analysis: value });
  assert.equal(docked.imported.length, 1);
  assert.deepEqual(docked.imported[0], saved);
  assert.ok(docked.imported[0].modes.differential.result.pValue instanceof Float64Array);

  // A later failure puts the panel back as the restore found it.
  const before = structuredClone(docked.current());
  await assert.rejects(
    history.showValues({
      analysis: { ...value, docked: { openMode: null, modes: { simple: { settings: { selectedPages: [] }, result: null } } } },
      layout: 'refused',
    }),
    error => error === lateFailure,
  );
  assert.deepEqual(docked.current(), before);
  assert.equal(layout, null);
});
