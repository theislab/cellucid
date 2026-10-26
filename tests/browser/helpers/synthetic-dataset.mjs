/**
 * Load a synthetic dataset through the Benchmark panel.
 *
 * The run waits for startup to finish (`data-startup-phase="ready"`, set once
 * the start dataset has its first view) with that dataset's cells counted.
 * `#filter-count` alone is not that: it reads "Showing all 0 cells" from the
 * first moment, before the start dataset is read, and a run clicked then
 * meets the start dataset's publication, which lays the sidebar out again
 * (the Session panel's Dataset box fills in) between the click's aim and its
 * landing. Measured on WebKit: 1 run in 24, the click landing on the
 * Synthetic data heading above the run button, the start dataset's 120 cells
 * staying.
 */
import { expect } from './test.mjs';

/**
 * @param {import('@playwright/test').Page} page
 * @param {{pointCount: number, pattern: string}} dataset
 */
export async function loadSyntheticDataset(page, { pointCount, pattern }) {
  await expect(page.locator('html')).toHaveAttribute('data-startup-phase', 'ready', { timeout: 120_000 });
  await expect(page.locator('#filter-count')).toHaveText(/^Showing all [1-9][\d,]* cells$/);
  await page.locator('#benchmark-section > summary').click();
  await expect(page.locator('#benchmark-run')).toBeEnabled();
  await page.locator('#benchmark-count').fill(String(pointCount));
  await page.locator('#benchmark-pattern').selectOption(pattern);
  await page.locator('#benchmark-run').click();
  await expect
    .poll(() => page.evaluate(() => window._cellucidState.pointCount), { timeout: 120_000 })
    .toBe(pointCount);
}
