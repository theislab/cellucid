/**
 * Undo past a kept view after a category rename, on the page's own history.
 *
 * A kept view's fields are shallow copies of its source's and share the
 * category list and the centroid tables, which a rename and every re-read
 * of the renames wrote in place. Restoring the renames in the focused view
 * then relabeled the other view's centroids under its unchanged categories,
 * and focusing that view (the `views` restore) failed with "Category
 * centroids of layout "X_umap_2d" reference an unknown category identity",
 * leaving seven domains changed; the rollback met the same error. Color by
 * `cell_type`, keep a view, rename a category, then undo three times or jump
 * to the start; or rename before keeping the view and jump to the start in
 * one go. The lists and tables are now never written in place
 * (`_syncCentroidCategoryLabels`, `renameCategory`), and the node contract
 * is `tests/kept-view-category-ownership.test.mjs`.
 *
 * Each case takes the steps through the page's dispatcher, goes back to the
 * opening (step by step or in one jump), compares the state fingerprint with
 * the opening's exactly, goes forward to the last step and compares with
 * the last step's; and a restore that fails after the views were put back
 * rolls back to exactly what was shown.
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

/**
 * Take `steps`, then go back to the opening (`back`: 'undo' one step at a
 * time, or 'jump' in one) and forward to the last step in one jump. Resolves
 * to the domains that differ from the opening's and from the last step's
 * fingerprint, and any failure, with its rollback's.
 */
async function backAndForth(page, steps, back) {
  return page.evaluate(async ({ steps, back }) => {
    const { getActions, getStateDomains } = await import('/assets/js/app/actions/index.js');
    const { stateFingerprint, differingDomains } = await import('/assets/js/app/state/domains/fingerprint.js');
    const history = window._cellucidHistories.current();
    const domains = getStateDomains();
    await history.idle();
    const opening = { step: history.active.headId, fingerprint: await stateFingerprint(domains) };
    for (const [type, params] of steps) await getActions().dispatch(type, params);
    await history.idle();
    const last = { step: history.active.headId, fingerprint: await stateFingerprint(domains) };
    const failure = error => ({ message: error.message, rollback: error.rollbackError?.message ?? null });
    try {
      if (back === 'jump') await history.jump(opening.step);
      else for (let index = 0; index < steps.length; index++) await history.undo();
    } catch (error) {
      return { failed: failure(error) };
    }
    await history.idle();
    const atOpening = differingDomains(opening.fingerprint, await stateFingerprint(domains));
    const headAtOpening = history.active.headId === opening.step;
    try {
      await history.jump(last.step);
    } catch (error) {
      return { failed: failure(error), atOpening, headAtOpening };
    }
    await history.idle();
    const atLast = differingDomains(last.fingerprint, await stateFingerprint(domains));
    return { failed: null, atOpening, headAtOpening, atLast, headAtLast: history.active.headId === last.step };
  }, { steps, back });
}

for (const [order, steps] of Object.entries(ORDERS)) {
  for (const back of ['undo', 'jump']) {
    test(`color, ${order}: ${back === 'jump' ? 'one jump' : 'undo step by step'} to the opening gives it back exactly, and forward again`, async ({ page }) => {
      const errors = observeProductErrors(page);
      await open(page);
      expect(await backAndForth(page, steps, back)).toEqual({
        failed: null, atOpening: [], headAtOpening: true, atLast: [], headAtLast: true,
      });
      expect(errors).toEqual([]);
    });
  }

  test(`color, ${order}: a jump that fails after the views were put back rolls back exactly`, async ({ page }) => {
    await open(page);
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
