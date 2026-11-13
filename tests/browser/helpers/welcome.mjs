import { expect } from '@playwright/test';

/**
 * The welcome dialog once the page has shown it (`showWelcomeModal`): an
 * open `<dialog>`, its Escape and Start exploring listening by then — the
 * state the product keeps, not how the markup happens to be displayed. A
 * closed `<dialog>` is never displayed, whatever has loaded of the
 * stylesheet (CELLUCID_STYLE_GATE, `style-gate.spec.mjs`).
 */
export function shownWelcome(page) {
  return page.locator('#welcome-modal[open]');
}

export async function expectWelcomeShown(page) {
  await expect(shownWelcome(page)).toBeVisible();
}

export async function dismissWelcome(page) {
  await expectWelcomeShown(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('#welcome-modal')).toBeHidden();
}

/**
 * The "Continue where you left off?" offer (`app/history/dataset-history.js`
 * `offerToContinue`), once it is shown.
 */
export function continueOffer(page) {
  return page.locator('.notification').filter({ hasText: 'Continue where you left off?' });
}

/**
 * Continue the history this browser kept (the offer's Continue, never Start
 * fresh, which drops the very history a reload test means to continue).
 */
export async function continueWhereLeftOff(page, { timeout = 60_000 } = {}) {
  const offer = continueOffer(page);
  await expect(offer).toBeVisible({ timeout });
  await offer.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(offer).toBeHidden({ timeout });
}
