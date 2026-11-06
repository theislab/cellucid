import { expect } from '@playwright/test';

/**
 * The welcome dialog once the page has shown it (`showWelcomeModal`, which
 * takes `.hidden` off it, its Escape and Start exploring listening by then):
 * the state the product keeps, not how the markup happens to be displayed.
 *
 * Its markup is `class="welcome-modal hidden"`, hidden by a rule of the
 * stylesheet. WebKit used to reach DOMContentLoaded before that stylesheet
 * (Chromium and Firefox wait for it), so right after a navigation the dialog
 * nothing had shown yet answered `toBeVisible()`: an Escape pressed then
 * reached no listener, and the page showed the dialog seconds later over a
 * page the spec believed free of it (Web contracts run 42180485733 and
 * earlier, Linux WebKit: history-graph, highlight-pulse, knn-missing,
 * my-datasets). The page is now parsed only once its stylesheet is in, in
 * every engine (index.html, CELLUCID_STYLE_GATE; `style-gate.spec.mjs`).
 */
export function shownWelcome(page) {
  return page.locator('#welcome-modal:not(.hidden)');
}

export async function expectWelcomeShown(page) {
  await expect(shownWelcome(page)).toBeVisible();
}

export async function dismissWelcome(page) {
  await expectWelcomeShown(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('#welcome-modal')).toBeHidden();
}
