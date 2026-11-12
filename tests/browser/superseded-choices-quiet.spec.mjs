/**
 * A choice superseded by a newer one ends as a quiet cancellation, never a
 * page error and never an error notification.
 *
 * Found 2026-11-11 (round 9, close-b): opening a link right after the start
 * page logged `pageerror: Field interaction was superseded by a newer
 * intent.`: a dataset's UI refresh cleared the gene choice and waited for
 * nobody (`dataset-controls.js` refreshDatasetUI), and the new dataset's
 * first coloring superseded that clear, whose rejection reached no handler.
 * The class: work nobody waits for settles in the background
 * (`settleInBackground`: a cancellation quiet, a failure reported), and a
 * cancellation that still reaches no handler is not a page error
 * (`quietUnhandledCancellations`, installed by the page). An analysis's gene
 * link superseded by a newer choice said "Coloring by … failed".
 */
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { waitForHistory } from './helpers/state-history.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=superseded-choices-quiet`;

test('a superseded field choice, a cancellation nobody handles, and a superseded gene link are quiet', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await waitForHistory(page);

  const outcome = await page.evaluate(async () => {
    const ui = window._cellucidUi;
    const { cancelled } = await import('/assets/js/utils/abort.js');
    const errorsBefore = document.querySelectorAll('.notification[data-tone="error"], .notification.error').length;
    // A dataset refresh clears the gene choice; a field choice made at once supersedes it.
    ui.refreshDatasetUI();
    const shown = await ui.activateField(0);
    // A cancellation that reaches no handler at all.
    Promise.reject(cancelled('superseded', 'A test choice was superseded.'));
    // An analysis's gene link, superseded by a newer one at once.
    const genes = window._comparisonModule.dataLayer.getAvailableVariables('gene_expression').map(gene => gene.key);
    await Promise.all([window._comparisonModule.colorByGene(genes[0]), window._comparisonModule.colorByGene(genes[1])]);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      shown: shown !== null && shown !== undefined,
      genes: genes.slice(0, 2),
      errorNotices: document.querySelectorAll('.notification[data-tone="error"], .notification.error').length - errorsBefore,
      colored: window._cellucidState.getActiveField?.()?.key ?? null,
    };
  });
  expect(outcome.shown).toBe(true);
  // The newer gene is shown; the superseded one said nothing.
  await expect.poll(() => page.evaluate(() => window._cellucidState.getActiveField?.()?.key ?? null)).toBe(outcome.genes[1]);
  expect(outcome.errorNotices).toBe(0);
  await expect(page.locator('.notification', { hasText: 'failed' })).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
