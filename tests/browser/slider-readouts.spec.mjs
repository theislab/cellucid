/**
 * Every slider reads as its owner says, at every position (R9R-3, R9R-10):
 * each slider with a readout defines the readout of any value
 * (`app/ui/core/control-readout.js`) and writes its own with it, so the
 * readout beside it and the history naming a value of the past ("Grid
 * density: 48³", never the position 37) say one thing. A slider added
 * without a readout formatter fails here.
 */
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { whenActionsShown } from './helpers/dataset-ready.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=slider-readouts`;

test('every slider with a readout has its owner\'s formatter, which says what the readout shows', async ({ page }) => {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await whenActionsShown(page);
  const report = await page.evaluate(async () => {
    const { controlReadout } = await import('/assets/js/app/ui/core/control-readout.js');
    const textOf = element => (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const rows = [];
    for (const input of document.querySelectorAll('input[type="range"]')) {
      const readout = input.closest('.slider-row')?.querySelector('.slider-value') ?? null;
      if (readout === null) continue;
      // A preference slider (Max edges) records and shows the person's preference, not the thumb.
      const value = input.dataset.sessionPreference ?? input.value;
      const atMin = controlReadout(input, input.min);
      const atMax = controlReadout(input, input.max);
      rows.push({
        id: input.id,
        formatter: controlReadout(input, value) !== null,
        agrees: controlReadout(input, value) === textOf(readout),
        shown: textOf(readout),
        said: controlReadout(input, value),
        ends: typeof atMin === 'string' && atMin.length > 0 && typeof atMax === 'string' && atMax.length > 0,
      });
    }
    return rows;
  });
  expect(report.length).toBeGreaterThanOrEqual(49);
  expect(report.filter(row => !row.formatter).map(row => row.id)).toEqual([]);
  expect(report.filter(row => !row.ends).map(row => row.id)).toEqual([]);
  expect(report.filter(row => !row.agrees).map(row => `${row.id}: shows ${row.shown}, formatter says ${row.said}`)).toEqual([]);
});
