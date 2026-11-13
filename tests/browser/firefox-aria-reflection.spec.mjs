/**
 * The Firefox guard of `helpers/firefox-aria-reflection.mjs` holds what it
 * claims: the crash it guards against is Firefox's own, on a page with no
 * script, and a guarded page survives the same queries.
 */
import { closeContextWithApplicationRetirement, expect, test } from './helpers/test.mjs';
import { FIREFOX_ARIA_REFLECTION_BUG } from './helpers/firefox-aria-reflection.mjs';

const PAGE = '<!doctype html><div role="dialog" aria-labelledby="title"><h2 id="title">Save</h2></div>';

/** A named role query answered in Playwright's utility world, then in the page's world. */
async function queryInBothWorlds(page) {
  const dialog = page.getByRole('dialog', { name: 'Save', exact: true });
  await expect(dialog).toHaveCount(1);
  return dialog.evaluateAll(elements => elements.length);
}

test('a guarded page answers a named role query in both worlds', async ({ page }) => {
  await page.setContent(PAGE);
  expect(await queryInBothWorlds(page)).toBe(1);
});

test('an unguarded Firefox page with no script crashes on the same queries', async ({ browserName, playwright }) => {
  test.skip(browserName !== 'firefox', `the crash is Gecko's (${FIREFOX_ARIA_REFLECTION_BUG})`);
  // A browser of its own: the test's contexts all carry the guard.
  const browser = await playwright.firefox.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    let crashed = false;
    page.on('crash', () => {
      crashed = true;
    });
    await page.setContent(PAGE);
    await expect(queryInBothWorlds(page)).rejects.toThrow(/crashed/);
    expect(crashed).toBe(true);
    // The crashed page ran no application, and nothing can be evaluated in it.
    await page.close();
    await closeContextWithApplicationRetirement(context);
  } finally {
    await browser.close();
  }
});
