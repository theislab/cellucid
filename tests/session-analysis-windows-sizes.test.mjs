/**
 * An analysis window is split between two state domains: what it shows (its
 * analysis, settings and result) is the
 * `analysis` domain's (`app/state/domains/analysis.js`); where it stands, its
 * size, whether it is folded, and the sizes a person gave each analysis's
 * windows and expanded views are the `layout` domain's (`layout.analysis`,
 * `createAnalysisWindowLayout` in `app/state/domains/layout.js`), so History
 * settings › "Panels, windows and theme" covers them as every other panel's
 * geometry. Each record is exact: an analysis value still holding sizes is
 * refused, not migrated, and so is a size of an unknown analysis or with a
 * missing field, or places that do not match the open windows; a refused
 * value leaves the windows and sizes as they were (the history puts back
 * what a failed restore changed, `app/history/history.js`).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { analysisViewSizes } from '../assets/js/app/analysis/shared/analysis-view-sizes.js';
import { createActionCatalog } from '../assets/js/app/actions/catalog.js';
import { createActionDispatcher } from '../assets/js/app/actions/dispatcher.js';
import { createDomainRegistry } from '../assets/js/app/actions/domains.js';
import { createHistory } from '../assets/js/app/history/history.js';
import { createAnalysisDomain } from '../assets/js/app/state/domains/analysis.js';
import { createAnalysisWindowLayout } from '../assets/js/app/state/domains/layout.js';

const KNOWN = new Set(['genesPanel', 'differential', 'dotplot', 'composition']);
const isKnown = modeId => KNOWN.has(modeId);

const SIZES = {
  window: { genesPanel: { width: 520, height: 640 } },
  expandedView: {
    dotplot: { width: 900, height: 700, optionsWidth: 260, footerHeight: 180, statsWidth: 400 }
  }
};

/** Where a window of an analysis opens when no place is given. */
const DEFAULT_PLACE = Object.freeze({ rect: Object.freeze({ left: 40, top: 40, width: 320, height: 240 }), open: true });

/** A window manager over `windows` (`{descriptor, place}` each) and the sizes `store`. */
function managerOver(store, windows = []) {
  const events = [];
  return {
    events,
    windows,
    exportSessionWindows: () => windows.map(entry => structuredClone(entry.descriptor)),
    exportWindowPlaces: () => windows.map(entry => structuredClone(entry.place)),
    applyWindowPlaces(places) {
      // As the manager does: the windows both name, in order; the rest stay, extra places are ignored.
      events.push('places');
      places.slice(0, windows.length).forEach((place, index) => { windows[index].place = structuredClone(place); });
    },
    exportViewSizes: () => store.exportSizes(),
    importViewSizes(sizes) {
      events.push('sizes');
      store.importSizes(sizes, isKnown);
    },
    async closeAll() {
      events.push('close');
      windows.length = 0;
    },
    async createFromSessionDescriptor(descriptor, place) {
      events.push(`open:${descriptor.modeId}:${place === null ? 'new' : `${place.rect.left},${place.open}`}`);
      windows.push({ descriptor: structuredClone(descriptor), place: structuredClone(place ?? DEFAULT_PLACE) });
    }
  };
}

/** The docked panel as the analysis domain reads it: nothing opened. */
const NOTHING_DOCKED = { openMode: null, modes: {} };

function analysisDomainOver(analysisWindowManager) {
  const comparisonModule = {
    exportSessionState: () => structuredClone(NOTHING_DOCKED),
    async importSessionState() {
      throw new Error('the docked panel is not restored when it is unchanged');
    }
  };
  const refs = { comparisonModule, analysisWindowManager };
  return createAnalysisDomain({ analysis: () => refs, analysisArrived: async () => refs });
}

test('remembered sizes round-trip exactly and replace the ones held', () => {
  analysisViewSizes.clear();
  analysisViewSizes.rememberWindowSize('composition', { width: 400, height: 300 });
  analysisViewSizes.importSizes(structuredClone(SIZES), isKnown);
  assert.deepEqual(analysisViewSizes.exportSizes(), SIZES);
  assert.equal(analysisViewSizes.windowSize('composition'), null, 'an import replaces, not merges');
  assert.deepEqual(analysisViewSizes.windowSize('genesPanel'), { width: 520, height: 640 });
  analysisViewSizes.clear();
  assert.deepEqual(analysisViewSizes.exportSizes(), { window: {}, expandedView: {} });
});

test('a sizes record is refused whole: unknown analysis, missing field, bad number', () => {
  analysisViewSizes.clear();
  analysisViewSizes.rememberWindowSize('genesPanel', { width: 300, height: 200 });
  const before = analysisViewSizes.exportSizes();
  assert.throws(
    () => analysisViewSizes.importSizes({ window: { nope: { width: 1, height: 1 } }, expandedView: {} }, isKnown),
    /unknown analysis "nope"/
  );
  assert.throws(
    () => analysisViewSizes.importSizes({ window: {}, expandedView: { dotplot: { width: 1, height: 1 } } }, isKnown),
    /must contain exactly/
  );
  assert.throws(
    () => analysisViewSizes.importSizes({ window: { dotplot: { width: 0, height: 10 } }, expandedView: {} }, isKnown),
    /positive finite/
  );
  assert.throws(() => analysisViewSizes.importSizes({ window: {} }, isKnown), /exactly: expandedView, window/);
  assert.deepEqual(analysisViewSizes.exportSizes(), before, 'nothing changed');
  assert.throws(() => analysisViewSizes.rememberWindowSize('', { width: 1, height: 1 }), /non-empty/);
});

const GENES = { modeId: 'genesPanel', settings: {}, result: null, headerTitle: 'Marker genes' };
const DOTS = { modeId: 'dotplot', settings: { k: 1 }, result: null, headerTitle: 'Dot plot' };
const AT_1 = { rect: { left: 1, top: 2, width: 300, height: 400 }, open: true };
const AT_9 = { rect: { left: 9, top: 9, width: 500, height: 600 }, open: false };

test('an analysis value is the windows\' analyses; their places and the remembered sizes are the layout\'s', async () => {
  analysisViewSizes.clear();
  analysisViewSizes.importSizes(structuredClone(SIZES), isKnown);
  const manager = managerOver(analysisViewSizes, [{ descriptor: GENES, place: AT_1 }, { descriptor: DOTS, place: AT_9 }]);
  const value = await analysisDomainOver(manager).capture();
  assert.deepEqual(value, { windows: [GENES, DOTS], docked: null }, 'nothing docked is no docked analysis');
  const layout = createAnalysisWindowLayout(() => ({ analysisWindowManager: manager }), async () => ({ analysisWindowManager: manager }));
  assert.deepEqual(await layout.capture(), { windows: [AT_1, AT_9], sizes: SIZES });
  assert.deepEqual(await createAnalysisWindowLayout(() => null, async () => null).capture(), { windows: [], sizes: null }, 'no analysis code: no window, no size');
});

test('reopened windows keep the place the window at their position had; the layout then puts each at its own', async () => {
  analysisViewSizes.clear();
  // Two windows open; the value opens three, the second with other settings.
  const manager = managerOver(analysisViewSizes, [{ descriptor: GENES, place: AT_1 }, { descriptor: DOTS, place: AT_9 }]);
  await analysisDomainOver(manager).restore({ windows: [GENES, { ...DOTS, settings: { k: 2 } }, GENES], docked: NOTHING_DOCKED });
  assert.deepEqual(manager.events, ['close', 'open:genesPanel:1,true', 'open:dotplot:9,false', 'open:genesPanel:new']);
  assert.deepEqual(manager.exportWindowPlaces(), [AT_1, AT_9, DEFAULT_PLACE], 'an analysis restored alone moves no window it kept');

  // The layout restored after it: places first (placing remembers sizes), then the sizes exactly.
  const layout = createAnalysisWindowLayout(() => ({ analysisWindowManager: manager }), async () => ({ analysisWindowManager: manager }));
  manager.events.length = 0;
  const target = { windows: [AT_9, AT_1, AT_1], sizes: SIZES };
  await layout.restore(await layout.capture(), target);
  assert.deepEqual(manager.events, ['places', 'sizes']);
  assert.deepEqual(await layout.capture(), target);
  manager.events.length = 0;
  await layout.restore(await layout.capture(), target);
  assert.deepEqual(manager.events, [], 'restoring the value shown changes nothing');
  assert.deepEqual(layout.describe({ windows: [AT_1, AT_9], sizes: null }, { windows: [AT_1, { ...AT_9, open: true, rect: AT_1.rect }], sizes: SIZES }), [
    'Analysis window 2 unfolded', 'Analysis window 2 moved', 'Analysis sizes remembered',
  ]);
});

test('the layout of the analysis windows: a wrong shape is refused whole; places for other windows are applied to those both name; no analysis code', async () => {
  analysisViewSizes.clear();
  const manager = managerOver(analysisViewSizes, [{ descriptor: GENES, place: AT_1 }]);
  const layout = createAnalysisWindowLayout(() => ({ analysisWindowManager: manager }), async () => ({ analysisWindowManager: manager }));
  assert.throws(() => layout.check({ windows: [AT_1] }), /exactly their places and the sizes remembered per analysis/);
  assert.throws(() => layout.check({ windows: [AT_1], sizes: null, extra: 1 }), /exactly their places/);
  // The analysis domain left as it is (its recording off): the places repair what they can, never refuse.
  await layout.restore(await layout.capture(), { windows: [AT_9, AT_1], sizes: null });
  assert.deepEqual(manager.exportWindowPlaces(), [AT_9], 'the one open window took the first place; the extra place is ignored');
  const none = createAnalysisWindowLayout(() => null, async () => null);
  await none.restore({ windows: [], sizes: null }, { windows: [], sizes: null });
  await assert.rejects(none.restore({ windows: [], sizes: null }, { windows: [AT_1], sizes: null }), /could not load on this page/);
});

test('an analysis value still holding sizes is refused, not migrated, and the windows and sizes stay as they were', async () => {
  analysisViewSizes.clear();
  analysisViewSizes.importSizes(structuredClone(SIZES), isKnown);
  const manager = managerOver(analysisViewSizes, [{ descriptor: GENES, place: AT_1 }]);
  const domains = createDomainRegistry();
  domains.provide('analysis', analysisDomainOver(manager));
  for (const id of domains.missing()) domains.provide(id, { capture: () => null, restore: () => {} });
  const history = createHistory({
    dispatcher: createActionDispatcher({ catalog: createActionCatalog([]) }),
    domains,
    dataset: { id: 'sizes', name: null, cellOrder: null },
    newTrackerId: () => 't-00000000-0000-4000-8000-000000000001'
  });

  await assert.rejects(
    history.showValues({ analysis: { windows: [], sizes: SIZES, docked: NOTHING_DOCKED } }),
    /The analyses to restore must be exactly their windows and the docked analysis\./
  );
  assert.deepEqual(analysisViewSizes.exportSizes(), SIZES, 'the sizes held are kept');
  // Refused before anything closed: the window open before was never closed.
  assert.deepEqual(manager.events, []);
  assert.deepEqual(manager.exportSessionWindows(), [GENES], 'the window open before is still open');
});
