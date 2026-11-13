/**
 * Every analysis validator admits the same pages the shared selection can hold.
 *
 * `AnalysisUIManager._currentPages` is one selection shared by every analysis
 * mode. Its setter admits the derived "Rest of X" pages, because the page
 * selectors offer them: `analysis-ui-manager.js` expands the inventory with
 * `expandPagesWithDerived(..., { includeRestOf: true })`.
 *
 * A per-UI validator that computed a narrower domain of its own (a page
 * selector's inventory when one exists, `this.dataLayer.getPages()` - base
 * pages only - when it does not; `base-analysis-ui.js`,
 * `analysis-types/base/form-based-analysis.js`) would refuse a page the
 * selection accepts. `this._pageSelector` is not an occasional null:
 * Differential Expression and Marker Genes never construct one (Quick
 * Insights, Detailed, Correlation and Gene Signature do), so for those two
 * modes the narrow branch would be the only branch.
 *
 * The failure is then a plain sequence, not a race:
 *
 *   1. Detailed analysis is open; its selector carries `includeDerivedPages`
 *      (`detailed-analysis-ui.js`), so "Rest of Page 1" is selectable.
 *   2. The choice reaches `setCurrentPages` through the module's config
 *      callback (`comparison-module.js`) and is accepted.
 *   3. Switching to Differential Expression or Marker Genes runs
 *      `switchToMode` -> `entry.ui.onPageSelectionChange(this._currentPages)`
 *      (`analysis-ui-manager.js`) -> `FormBasedAnalysisUI.onPageSelectionChange`
 *      (`form-based-analysis.js`) -> the validator, which would throw
 *      `Form-based analysis selectedPages page "restof__page_1" was not found`.
 *
 * `_requireSettings` reaches the same wall from `importSettings`, which
 * is how a floating analysis window is populated
 * (`analysis-window-manager.js`): a Correlation or Gene Signature panel can
 * legitimately export a rest-of selection, and the copy validates it before its
 * own selector exists.
 *
 * The domain is therefore one rule, and these tests hold four sites to it.
 * The fourth, `_requireCustomPageColors` (`form-based-analysis.js`), resolves
 * its domain from `selectablePageIdSet` like `_requireSettings`, which
 * validates the same settings object in the same `importSettings` call, and
 * not from `this._pageSelector._getPages()`, the widget's current view: the
 * option `includeDerivedPages` defaults to `false` (`page-selector.js`), so a
 * selector built without it would accept a rest-of page as a selection and
 * refuse a color for that page, out of one saved session. The last two tests
 * pin that the color half does not depend on what a widget happens to be
 * displaying.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AnalysisUIManager } from '../assets/js/app/analysis/ui/analysis-ui-manager.js';
import { BaseAnalysisUI } from '../assets/js/app/analysis/ui/base-analysis-ui.js';
import { FormBasedAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/base/form-based-analysis.js';
import { PageSelectorComponent } from '../assets/js/app/analysis/ui/shared/page-selector.js';
import { createRestOfPageId } from '../assets/js/app/analysis/shared/page-derivation-utils.js';
import { defineOptions } from '../assets/js/app/analysis/options/option-schema.js';

const PAGES = [
  { id: 'page_1', name: 'Page 1' },
  { id: 'page_2', name: 'Page 2' },
];
const REST_OF_PAGE_1 = createRestOfPageId('page_1');

function createDataLayer({ emptyPageIds = [] } = {}) {
  const empty = new Set(emptyPageIds);
  return {
    getPages: () => PAGES.map(page => ({ ...page })),
    getCellCountForPageId: pageId => (empty.has(pageId) ? 0 : 262),
  };
}

/**
 * A UI positioned exactly as Differential Expression and Marker Genes are: real
 * prototype, real data layer, and no page selector, because those two modes
 * never build one.
 */
function createSelectorlessUI(Prototype, dataLayer) {
  const ui = Object.create(Prototype);
  ui.dataLayer = dataLayer;
  ui._getTitle = () => 'Form';
  ui._getOptionsSchema = () => SCHEMA;
  ui._getOptionsContext = () => ({});
  return ui;
}

const SCHEMA = defineOptions({
  id: 'pageDomain',
  groups: [],
  options: [
    { key: 'size', kind: 'number', label: 'Size', tip: 'analysis-signature', group: 'essentials', default: 1 },
  ],
});

/** A form analysis's settings record selecting `selectedPages`. */
function formSettings(selectedPages) {
  return { options: { size: 1 }, selectedPages, view: { disclosures: { more: false, groups: [] } } };
}

/**
 * A form-based UI positioned as Correlation and Gene Signature are: it owns a
 * page selector, so it can carry custom page colors.
 *
 * The selector is the real `PageSelectorComponent` prototype rather than an
 * imitation of it, because `includeDerivedPages` is precisely the behavior
 * under test — `_getPages()` is what decides whether the widget's view of the
 * inventory is narrower than the data's.
 */
function createColorUI(dataLayer, { includeDerivedPages }) {
  const ui = createSelectorlessUI(FormBasedAnalysisUI.prototype, dataLayer);
  const selector = Object.create(PageSelectorComponent.prototype);
  selector.dataLayer = dataLayer;
  selector.includeDerivedPages = includeDerivedPages;
  selector._basePages = [];
  ui._pageSelector = selector;
  return ui;
}

test(
  'a UI with no page selector accepts the rest-of pages the manager admits',
  () => {
    const dataLayer = createDataLayer();
    const ui = createSelectorlessUI(BaseAnalysisUI.prototype, dataLayer);

    ui._requireAvailableSelectedPages(
      [REST_OF_PAGE_1],
      'Form-based analysis selectedPages',
    );
  },
);

test(
  'form settings with no page selector accept the same rest-of pages',
  () => {
    const dataLayer = createDataLayer();
    const ui = createSelectorlessUI(FormBasedAnalysisUI.prototype, dataLayer);

    const validated = ui._requireSettings(formSettings([REST_OF_PAGE_1]));

    assert.deepEqual(validated.selectedPages, [REST_OF_PAGE_1]);
  },
);

test(
  'switching modes into a selectorless UI does not throw on a rest-of page',
  () => {
    // The live path: the shared selection already holds a derived page, and the
    // mode being activated is one that owns no selector.
    const dataLayer = createDataLayer();
    const ui = createSelectorlessUI(FormBasedAnalysisUI.prototype, dataLayer);
    const seen = [];
    const entry = {
      config: { id: 'de' },
      container: {},
      initialized: true,
      ui: {
        onPageSelectionChange(pageIds) {
          ui._requireAvailableSelectedPages(
            pageIds,
            'Form-based analysis selectedPages',
          );
          seen.push([...pageIds]);
        },
      },
    };

    const manager = Object.create(AnalysisUIManager.prototype);
    manager.dataLayer = dataLayer;
    manager._uis = new Map([['de', entry]]);
    manager._registry = new Map([['de', entry.config]]);
    manager._activeMode = 'detailed';
    manager._currentPages = [];

    manager.setCurrentPages([REST_OF_PAGE_1], { notifyActiveUI: false });
    assert.deepEqual(manager._currentPages, [REST_OF_PAGE_1]);

    assert.equal(manager.switchToMode('de'), true);
    assert.deepEqual(seen, [[REST_OF_PAGE_1]]);
  },
);

test(
  'an empty seeded selection reaches a mode as no choice; a given one, even empty, as a choice',
  () => {
    // An analysis takes pages given to it as its own, none included. The
    // module's default (its base pages that hold cells, at start and when a
    // page change leaves no selection) is no choice; when it is empty, handing
    // it as one made Detailed show no page instead of its selector's default
    // ("Rest of Page 1").
    const seen = [];
    const entry = {
      config: { id: 'detailed' },
      container: {},
      initialized: true,
      ui: { onPageSelectionChange: (pageIds, options) => seen.push([[...pageIds], options]) },
    };
    const manager = Object.create(AnalysisUIManager.prototype);
    manager.dataLayer = createDataLayer();
    manager._uis = new Map([['detailed', entry]]);
    manager._registry = new Map([['detailed', entry.config]]);
    manager._activeMode = null;

    manager.seedCurrentPages([]);
    assert.equal(manager.switchToMode('detailed'), true);
    // The page-change default reaches the shown mode the same way.
    manager.seedCurrentPages([], { notifyActiveUI: true });
    // A default that names pages is the shared selection.
    manager.seedCurrentPages([REST_OF_PAGE_1], { notifyActiveUI: true });
    // A selection given, even none, is a choice.
    manager.setCurrentPages([]);
    assert.deepEqual(seen, [
      [[], { given: false }],
      [[], { given: false }],
      [[REST_OF_PAGE_1], { given: true }],
      [[], { given: true }],
    ]);

    // The analysis side: no choice leaves the selector's default to show.
    const ui = createSelectorlessUI(BaseAnalysisUI.prototype, createDataLayer());
    ui._currentConfig = { pages: [] };
    ui._assignPages([], { given: false });
    assert.equal(ui._pageSelectionToShow(), undefined);
    ui._assignPages([]);
    assert.deepEqual(ui._pageSelectionToShow(), []);
  },
);

test('the four page domains are the same domain', () => {
  const dataLayer = createDataLayer();
  const baseUI = createSelectorlessUI(BaseAnalysisUI.prototype, dataLayer);
  const formUI = createSelectorlessUI(FormBasedAnalysisUI.prototype, dataLayer);
  const colorUI = createColorUI(dataLayer, { includeDerivedPages: true });
  const manager = Object.create(AnalysisUIManager.prototype);
  manager.dataLayer = dataLayer;
  manager._uis = new Map();
  manager._currentPages = [];

  const everyDerivedId = PAGES.map(page => createRestOfPageId(page.id));
  const everyId = [...PAGES.map(page => page.id), ...everyDerivedId];

  manager.setCurrentPages(everyId, { notifyActiveUI: false });
  baseUI._requireAvailableSelectedPages(everyId, 'Analysis selectedPages');
  formUI._requireSettings(formSettings(everyId));
  assert.deepEqual(
    colorUI._requireCustomPageColors(everyId.map(id => [id, '#3366cc'])),
    everyId.map(id => [id, '#3366cc']),
  );

  // And the same rejection on both sides of the boundary: a page that is not
  // derived from anything real is refused everywhere.
  const stranger = createRestOfPageId('page_absent');
  assert.throws(
    () => manager.setCurrentPages([stranger], { notifyActiveUI: false }),
    /was not found/,
  );
  assert.throws(
    () => baseUI._requireAvailableSelectedPages([stranger], 'Analysis selectedPages'),
    /was not found/,
  );
  assert.throws(
    () => formUI._requireSettings(formSettings([stranger])),
    /was not found/,
  );
  assert.throws(
    () => colorUI._requireCustomPageColors([[stranger, '#3366cc']]),
    /was not found/,
  );
});

test(
  'a custom page color is judged by the data, not by what the widget shows',
  () => {
    // `includeDerivedPages` defaults to false, so this is the selector a mode
    // gets by forgetting one option — and it is what made the color domain
    // narrower than the selection domain it is validated beside.
    const dataLayer = createDataLayer();
    const ui = createColorUI(dataLayer, { includeDerivedPages: false });

    assert.deepEqual(
      ui._requireSettings(formSettings([REST_OF_PAGE_1])).selectedPages,
      [REST_OF_PAGE_1],
    );
    assert.deepEqual(
      ui._requireCustomPageColors([[REST_OF_PAGE_1, '#3366cc']]),
      [[REST_OF_PAGE_1, '#3366cc']],
      'one saved session cannot have a page it may select and may not color',
    );
  },
);

test('the color domain still refuses what it always refused', () => {
  const dataLayer = createDataLayer();
  const ui = createColorUI(dataLayer, { includeDerivedPages: true });

  assert.throws(
    () => ui._requireCustomPageColors([['page_absent', '#3366cc']]),
    /Custom color page "page_absent" was not found/,
  );
  assert.throws(
    () => ui._requireCustomPageColors([['page_1', 'blue']]),
    /\[pageId, #rrggbb\] pairs/,
  );
  assert.throws(
    () => ui._requireCustomPageColors([
      ['page_1', '#3366cc'],
      ['page_1', '#cc3366'],
    ]),
    /more than one custom color/,
  );
  assert.throws(
    () => ui._requireCustomPageColors('not-an-array'),
    /Custom page colors must be an array/,
  );

  // The selector guard stays: `_applyCustomPageColors` consumes this result, so
  // `importSettings` has to fail here rather than half-way through applying.
  const selectorless = createSelectorlessUI(
    FormBasedAnalysisUI.prototype,
    dataLayer,
  );
  assert.throws(
    () => selectorless._requireCustomPageColors([]),
    /require an initialized page selector/,
  );
});

test('widening the domain does not weaken the empty-page rule', () => {
  // A rest-of page whose complement is empty is still not a selectable page:
  // the domain must widen what exists, not what may be analyzed.
  const dataLayer = createDataLayer({ emptyPageIds: [REST_OF_PAGE_1] });
  const baseUI = createSelectorlessUI(BaseAnalysisUI.prototype, dataLayer);
  const formUI = createSelectorlessUI(FormBasedAnalysisUI.prototype, dataLayer);

  assert.throws(
    () => baseUI._requireAvailableSelectedPages(
      [REST_OF_PAGE_1],
      'Analysis selectedPages',
    ),
    /zero cells/,
  );
  assert.throws(
    () => formUI._requireSettings(formSettings([REST_OF_PAGE_1])),
    /zero cells/,
  );
});
