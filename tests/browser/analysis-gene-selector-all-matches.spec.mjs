/**
 * The analysis gene selector lists every gene that matches the search as one
 * windowed list (ui/components/windowed-listbox.js, the sidebar gene search's
 * list too): only a page of rows near what is shown exists in the document,
 * whatever the match count, and every match is reachable by scrolling or from
 * the keyboard (End reaches the last match, arrows walk the whole list).
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
  const list = page.locator('#probe-gene-dropdown');
  const options = page.locator('#probe-gene-dropdown .dropdown-item');
  const rowCount = () => options.count();
  const activeText = () => page.evaluate(() => {
    const id = document.getElementById('probe-gene-search').getAttribute('aria-activedescendant');
    return id ? document.getElementById(id)?.textContent ?? null : null;
  });

  await input.click();
  await input.fill('GENE');
  // None plus 2,500 matches, of which one page of rows exists. With no gene
  // chosen, None is the chosen value and the active entry.
  await expect(options.first()).toHaveText('None');
  await expect(options.first()).toHaveAttribute('aria-setsize', '2501');
  await expect(options.first()).toHaveClass(/\bselected\b/);
  await expect(options.first()).toHaveClass(/\bactive\b/);
  expect(await rowCount()).toBe(100);

  // Scrolling to the end shows the last match, still as a window of rows.
  await list.evaluate(element => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(options.last()).toHaveText('GENE2499');
  expect(await rowCount()).toBeLessThanOrEqual(400);

  // From the keyboard: End makes the last match active, Enter commits it.
  await input.fill('GENE');
  await input.press('End');
  await expect.poll(activeText).toBe('GENE2499');
  expect(await rowCount()).toBeLessThanOrEqual(400);
  await input.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__chosen.at(-1))).toBe('GENE2499');

  // The chosen gene is the active entry whenever it is listed, wherever it
  // is. Arrowing walks entry by entry past any window edge: down from the last
  // match wraps to None.
  await input.click();
  await input.fill('GENE');
  await expect.poll(activeText).toBe('GENE2499');
  await expect(page.locator('#probe-gene-dropdown .dropdown-item.selected')).toHaveText('GENE2499');
  await input.press('ArrowDown');
  await expect.poll(activeText).toBe('None');
  for (let i = 0; i < 101; i++) await input.press('ArrowDown');
  await expect.poll(activeText).toBe('GENE0100');
  await input.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__chosen.at(-1))).toBe('GENE0100');

  // ArrowUp from None wraps to the last match.
  await input.click();
  await input.fill('GENE');
  await input.press('Home');
  await expect.poll(activeText).toBe('None');
  await input.press('ArrowUp');
  await expect.poll(activeText).toBe('GENE2499');
  await input.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__chosen.at(-1))).toBe('GENE2499');

  // The pointer commits any row it presses, after scrolling to it.
  await input.click();
  await input.fill('GENE12');
  await list.evaluate(element => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll'));
  });
  await options.last().dispatchEvent('mousedown');
  await expect.poll(() => page.evaluate(() => window.__chosen.at(-1))).toBe('GENE1299');
});
