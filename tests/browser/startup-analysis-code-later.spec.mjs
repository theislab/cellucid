/**
 * The analysis code loads beside startup and never holds it (`app/main.js`):
 * with the code held back, startup reaches `ready`, the dataset's history
 * starts, a person colors, highlights and filters, and the Analysis panel says
 * its tools are loading; once the code arrives the panel is usable, and its
 * arrival changes nothing the history holds.
 */
import { expect, test } from './helpers/test.mjs';

import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { takeSteps, waitForHistory } from './helpers/state-history.mjs';

const DATASET_URL = `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui`;
const ANALYSIS_CODE = '**/assets/js/app/analysis/comparison-module.js?v=*';
const CELL_TYPE = { source: 'obs', key: 'cell_type' };

/** The state fingerprint of every domain (`state/domains/fingerprint.js`). */
function fingerprint(page) {
  return page.evaluate(async () => {
    const { getStateDomains } = await import('/assets/js/app/actions/index.js');
    const { stateFingerprint } = await import('/assets/js/app/state/domains/fingerprint.js');
    return stateFingerprint(getStateDomains());
  });
}

function differing(page, a, b) {
  return page.evaluate(async ([before, after]) => {
    const { differingDomains } = await import('/assets/js/app/state/domains/fingerprint.js');
    return differingDomains(before, after);
  }, [a, b]);
}

test('startup is ready, and the page usable, while the analysis code is still loading', async ({ page }) => {
  const held = [];
  let seen;
  const requested = new Promise(resolve => { seen = resolve; });
  await page.route(ANALYSIS_CODE, route => {
    held.push(route);
    seen();
  });
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await requested;

  await expect(page.locator('html')).toHaveAttribute('data-startup-phase', 'ready');
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await waitForHistory(page);
  const panel = page.locator('#page-analysis-section .accordion-content');
  await expect(panel.getByRole('status')).toHaveText('Loading the analysis tools…');
  await expect(page.locator('#analysis-header-genesPanel')).toHaveCount(0);

  // Each change is a step of the history while the code is held.
  const steps = await takeSteps(page, [
    ['color.by', { field: { source: 'obs', key: 'score' } }],
    ['highlight.category', { field: CELL_TYPE, categories: ['alpha'] }],
    ['filter.category.visibility', { field: CELL_TYPE, categories: ['beta'], visible: false }],
  ]);
  expect(steps.map(id => id !== null)).toEqual([true, true, true]);
  await expect(page.locator('#filter-count')).not.toHaveText('Showing all 120 cells');
  const heldPrint = await fingerprint(page);
  expect(held.length).toBeGreaterThan(0);

  await page.unroute(ANALYSIS_CODE);
  await Promise.all(held.splice(0).map(route => route.fallback()));

  // The panel is usable once its code has arrived.
  const header = page.locator('#analysis-header-genesPanel');
  await expect(header).toBeVisible();
  await expect(panel.getByRole('status')).toHaveCount(0);
  expect(await differing(page, heldPrint, await fingerprint(page))).toEqual([]);
  await header.click();
  await expect(header).toHaveAttribute('aria-expanded', 'true');
});
