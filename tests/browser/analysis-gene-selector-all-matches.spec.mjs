/**
 * The analysis gene selector lists every gene that matches the search. It
 * builds the options a page at a time, so a search matching thousands of genes
 * opens with one page, even when the current gene is further down; scrolling
 * or arrowing to the end of the list builds the next page, and End reaches the
 * last match.
 */
import { expect, test } from './helpers/test.mjs';
import { openPlotHarness } from './helpers/plot-harness.mjs';

test('every matching gene is reachable from the analysis gene selector', async ({ page }) => {
  await openPlotHarness(page);
  await page.evaluate(async () => {
    const { createGeneExpressionSelector } = await import('/assets/js/app/analysis/ui/components/selectors.js');
    const genes = Array.from({ length: 2500 }, (_, i) => ({ key: `GENE${String(i).padStart(4, '0')}` }));
    genes.push({ key: 'OTHER1' });
    window.__chosen = [];
    const selector = createGeneExpressionSelector({
      genes,
      onChange: gene => window.__chosen.push(gene),
      id: 'probe-gene',
    });
    document.getElementById('plot-host').appendChild(selector);
  });
  const input = page.locator('#probe-gene-search');
  const options = page.locator('#probe-gene-dropdown .dropdown-item');
  await input.click();
  await input.fill('GENE');
  // One page of matches (and None) to start with.
  await expect(options).toHaveCount(101);

  // Scrolling to the end builds the next page, until every match is listed.
  for (let pages = 2; pages <= 25; pages++) {
    await page.locator('#probe-gene-dropdown').evaluate(list => {
      list.scrollTop = list.scrollHeight;
      list.dispatchEvent(new Event('scroll'));
    });
    await expect(options).toHaveCount(1 + Math.min(2500, pages * 100));
  }
  await expect(options.last()).toHaveText('GENE2499');

  // From the keyboard: End reaches the last match, ArrowDown past the last
  // built option builds more.
  await input.fill('GENE');
  await expect(options).toHaveCount(101);
  await input.press('End');
  await expect(options).toHaveCount(2501);
  await input.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__chosen.at(-1))).toBe('GENE2499');

  await input.click();
  await input.fill('GENE');
  await expect(options).toHaveCount(101);
  // Arrowing onto the last option built scrolls the list to its end, and
  // past it builds the next page.
  for (let i = 0; i < 101; i++) await input.press('ArrowDown');
  await expect(options).toHaveCount(201);
  await input.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__chosen.at(-1))).toBe('GENE0100');
});
