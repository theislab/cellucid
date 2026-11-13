/**
 * Undo past a kept view after a category rename, on the page's own history.
 *
 * A kept view's fields are shallow copies of its source's and share the
 * category list and the centroid tables, so a rename and every re-read of the
 * renames must never write them in place (`_syncCentroidCategoryLabels`,
 * `renameCategory`): restoring the renames in the focused view would relabel
 * the other view's centroids under its unchanged categories, and focusing that
 * view (the `views` restore) would fail with "Category centroids of layout
 * "X_umap_2d" reference an unknown category identity", leaving seven domains
 * changed, the rollback meeting the same error. Color by `cell_type`, keep a
 * view, rename a category, then undo three times or jump to the start; or
 * rename before keeping the view and jump to the start in one go. The node
 * contract is `tests/kept-view-category-ownership.test.mjs`.
 *
 * Going back to the opening and forward again, step by step or in one jump,
 * is the node contract's. Here, on the page's real domains: each order takes
 * its steps through the page's dispatcher, and a jump to the opening that
 * fails after the views were put back rolls back to exactly what was shown;
 * the same jump, refused by nothing, then gives the opening back.
 */
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { waitForHistory } from './helpers/state-history.mjs';

const DATASET_URL = `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=kept-view-category-ownership-ci`;
const CELL_TYPE = Object.freeze({ source: 'obs', key: 'cell_type' });
const COLOR = ['color.by', { field: CELL_TYPE }];
const KEEP = ['view.keep', {}];
const RENAME = ['category.rename', { field: CELL_TYPE, category: 'alpha', name: 'Alpha cells' }];

const ORDERS = {
  'keep a view, then rename': [COLOR, KEEP, RENAME],
  'rename, then keep a view': [COLOR, RENAME, KEEP],
};

function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  return errors;
}

/**
 * Open the dataset, then color by nothing: it opens colored by `cell_type`
 * (`app/first-coloring.js`), and each case begins uncolored so that coloring
 * by it is a step and the active field is put back on the way to the opening.
 */
async function open(page) {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await waitForHistory(page);
  await page.evaluate(async () => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    await getActions().dispatch('color.by', { field: null });
    await window._cellucidHistories.current().idle();
  });
}

test('color, keep a view and rename a category, in either order: a jump that fails after the views were put back rolls back exactly', async ({ page }) => {
  await open(page);
  // Each order ends at the opening again (its last jump), where the next begins.
  for (const [order, steps] of Object.entries(ORDERS)) {
    await test.step(`color, ${order}: a jump that fails after the views were put back rolls back exactly`, async () => {
      const outcome = await page.evaluate(async steps => {
        const { getActions, getStateDomains } = await import('/assets/js/app/actions/index.js');
        const { stateFingerprint, differingDomains } = await import('/assets/js/app/state/domains/fingerprint.js');
        const history = window._cellucidHistories.current();
        const domains = getStateDomains();
        await history.idle();
        const opening = { step: history.active.headId, fingerprint: await stateFingerprint(domains) };
        for (const [type, params] of steps) await getActions().dispatch(type, params);
        await history.idle();
        const last = { step: history.active.headId, fingerprint: await stateFingerprint(domains) };
        // The active field is restored after the renames and the views: it is
        // refused once, so the history puts back what was shown. The domain
        // owners are frozen (`readingRecords`), so the refusal is the state's,
        // where the active-field owner sets the field a view is colored by; the
        // stack says the refusal came from that owner, never an earlier one.
        const state = window._cellucidState;
        const setters = ['setActiveField', 'setActiveVarField', 'clearActiveField'];
        const own = Object.fromEntries(setters.map(name => [name, Object.getOwnPropertyDescriptor(state, name)]));
        const putSettersBack = () => {
          for (const name of setters) {
            if (own[name] === undefined) delete state[name];
            else Object.defineProperty(state, name, own[name]);
          }
        };
        let refusedIn = null;
        for (const name of setters) {
          state[name] = () => {
            putSettersBack();
            refusedIn = new Error().stack;
            throw new Error('refused once by the spec');
          };
        }
        let failed = null;
        try {
          await history.jump(opening.step);
        } catch (error) {
          failed = { message: error.message, rollback: error.rollbackError?.message ?? null };
        }
        putSettersBack();
        await history.idle();
        const rolledBack = differingDomains(last.fingerprint, await stateFingerprint(domains));
        const headStayed = history.active.headId === last.step;
        const refusedByActiveField = /domains\/active-field\.js/.test(refusedIn ?? '');
        // And the same jump, refused by nothing, goes through.
        await history.jump(opening.step);
        await history.idle();
        const atOpening = differingDomains(opening.fingerprint, await stateFingerprint(domains));
        return { failed, refusedByActiveField, rolledBack, headStayed, atOpening };
      }, steps);
      expect(outcome).toEqual({
        failed: { message: 'refused once by the spec', rollback: null },
        refusedByActiveField: true,
        rolledBack: [],
        headStayed: true,
        atOpening: [],
      });
    });
  }
});
