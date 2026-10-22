import { appUrl } from './origins.mjs';

export const PLOT_HARNESS_URL = appUrl('/tests/browser/fixtures/analysis-plot-harness.html');

/**
 * Open the analysis plot harness once the plot theme can be read.
 *
 * The plot modules read their theme tokens (`--font-sans` and the rest) from
 * the application stylesheet when they are imported. A spec that imports them
 * as soon as the document is parsed races that stylesheet, and on a loaded
 * machine it can win: the import then fails with "Plot theme token --font-sans
 * must resolve to a concrete value". This waits for the condition the theme
 * itself requires — the tokens resolve on the root element — rather than for a
 * document event that only usually implies it.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function openPlotHarness(page) {
  await page.goto(PLOT_HARNESS_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (
    getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim().length > 0
  ));
}
