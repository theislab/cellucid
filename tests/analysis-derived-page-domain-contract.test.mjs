/**
 * CEL-0218 — every analysis validator admits the same pages the shared
 * selection can hold.
 *
 * `AnalysisUIManager._currentPages` is one selection shared by every analysis
 * mode. Its setter admits the derived "Rest of X" pages, because the page
 * selectors offer them:
 * `assets/js/app/analysis/ui/analysis-ui-manager.js:396` expands the inventory
 * with `expandPagesWithDerived(..., { includeRestOf: true })`.
 *
 * The per-UI validators computed a narrower domain of their own. Both took a
 * page selector's inventory when one existed and `this.dataLayer.getPages()` —
 * base pages only — when it did not:
 *
 *   assets/js/app/analysis/ui/base-analysis-ui.js:463
 *   assets/js/app/analysis/ui/analysis-types/base/form-based-analysis.js:352
 *
 * `this._pageSelector` is not an occasional null. Differential Expression and
 * Marker Genes never construct one — `grep -n 'new PageSelectorComponent'`
 * finds it in Quick Insights, Detailed, Correlation and Gene Signature only —
 * so for those two modes the narrow branch is the only branch there is.
 *
 * That makes the crash a plain sequence, not a race:
 *
 *   1. Detailed analysis is open; its selector carries `includeDerivedPages`
 *      (`detailed-analysis-ui.js:301`), so "Rest of Page 1" is selectable. The
 *      committed screenshot
 *      `cellucid-python/docs/_static/screenshots/analysis/detailed-categorical.png`
 *      shows it selected.
 *   2. The choice reaches `setCurrentPages` through the module's config
 *      callback (`comparison-module.js:453`) and is accepted.
 *   3. Switching to Differential Expression or Marker Genes runs
 *      `switchToMode` → `entry.ui.onPageSelectionChange(this._currentPages)`
 *      (`analysis-ui-manager.js:322`) → `FormBasedAnalysisUI.onPageSelectionChange`
 *      (`form-based-analysis.js:1678`) → the narrow validator, which throws
 *      `Form-based analysis selectedPages page "restof__page_1" was not found`.
 *
 * `_requireExactFormSettings` reaches the same wall from `importSettings`, which
 * is how a floating analysis window is populated
 * (`analysis-window-manager.js:833`) — a Correlation or Gene Signature panel can
 * legitimately export a rest-of selection, and the copy validates it before its
 * own selector exists.
 *
 * The domain is therefore one rule, and these tests hold the four sites to it.
 *
 * CEL-0231 — the fourth site. `_requireCustomPageColors`
 * (`form-based-analysis.js:391`) kept deriving its domain from
 * `this._pageSelector._getPages()`, the widget's current view, while
 * `_requireExactFormSettings` ten lines above it — validating the *same*
 * settings object, in the same `importSettings` call — used the shared rule. The
 * two agree today only because every form-based selector is constructed with
 * `includeDerivedPages: true`; the option defaults to `false`
 * (`page-selector.js:168`), so a selector built without it would have accepted a
 * rest-of page as a selection and refused a colour for that page, out of one
 * saved session. All four sites resolve the domain from `selectablePageIdSet`
 * now, and the last two tests pin that the colour half no longer depends on what
 * a widget happens to be displaying.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AnalysisUIManager } from '../assets/js/app/analysis/ui/analysis-ui-manager.js';
import { BaseAnalysisUI } from '../assets/js/app/analysis/ui/base-analysis-ui.js';
import { FormBasedAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/base/form-based-analysis.js';
import { PageSelectorComponent } from '../assets/js/app/analysis/ui/shared/page-selector.js';
import { createRestOfPageId } from '../assets/js/app/analysis/shared/page-derivation-utils.js';

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
  return ui;
}

/**
 * A form-based UI positioned as Correlation and Gene Signature are: it owns a
 * page selector, so it can carry custom page colours.
 *
 * The selector is the real `PageSelectorComponent` prototype rather than an
 * imitation of it, because `includeDerivedPages` is precisely the behaviour
 * under test — `_getPages()` is what decides whether the widget's view of the
 * inventory is narrower than the data's.
 */
function createColourUI(dataLayer, { includeDerivedPages }) {
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

    const validated = ui._requireExactFormSettings(
      {
        selectedPages: [REST_OF_PAGE_1],
        formControls: {},
      },
      ['formControls', 'selectedPages'],
    );

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

test('the four page domains are the same domain', () => {
  const dataLayer = createDataLayer();
  const baseUI = createSelectorlessUI(BaseAnalysisUI.prototype, dataLayer);
  const formUI = createSelectorlessUI(FormBasedAnalysisUI.prototype, dataLayer);
  const colourUI = createColourUI(dataLayer, { includeDerivedPages: true });
  const manager = Object.create(AnalysisUIManager.prototype);
  manager.dataLayer = dataLayer;
  manager._uis = new Map();
  manager._currentPages = [];

  const everyDerivedId = PAGES.map(page => createRestOfPageId(page.id));
  const everyId = [...PAGES.map(page => page.id), ...everyDerivedId];

  manager.setCurrentPages(everyId, { notifyActiveUI: false });
  baseUI._requireAvailableSelectedPages(everyId, 'Analysis selectedPages');
  formUI._requireExactFormSettings(
    { selectedPages: everyId, formControls: {} },
    ['formControls', 'selectedPages'],
  );
  assert.deepEqual(
    colourUI._requireCustomPageColors(everyId.map(id => [id, '#3366cc'])),
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
    () => formUI._requireExactFormSettings(
      { selectedPages: [stranger], formControls: {} },
      ['formControls', 'selectedPages'],
    ),
    /was not found/,
  );
  assert.throws(
    () => colourUI._requireCustomPageColors([[stranger, '#3366cc']]),
    /was not found/,
  );
});

test(
  'a custom page colour is judged by the data, not by what the widget shows',
  () => {
    // `includeDerivedPages` defaults to false, so this is the selector a mode
    // gets by forgetting one option — and it is what made the colour domain
    // narrower than the selection domain it is validated beside.
    const dataLayer = createDataLayer();
    const ui = createColourUI(dataLayer, { includeDerivedPages: false });

    assert.deepEqual(
      ui._requireExactFormSettings(
        { selectedPages: [REST_OF_PAGE_1], formControls: {} },
        ['formControls', 'selectedPages'],
      ).selectedPages,
      [REST_OF_PAGE_1],
    );
    assert.deepEqual(
      ui._requireCustomPageColors([[REST_OF_PAGE_1, '#3366cc']]),
      [[REST_OF_PAGE_1, '#3366cc']],
      'one saved session cannot have a page it may select and may not colour',
    );
  },
);

test('the colour domain still refuses what it always refused', () => {
  const dataLayer = createDataLayer();
  const ui = createColourUI(dataLayer, { includeDerivedPages: true });

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
  // the fix must widen what exists, not what may be analysed.
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
    () => formUI._requireExactFormSettings(
      { selectedPages: [REST_OF_PAGE_1], formControls: {} },
      ['formControls', 'selectedPages'],
    ),
    /zero cells/,
  );
});
