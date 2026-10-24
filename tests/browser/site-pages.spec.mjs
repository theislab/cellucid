/**
 * The standalone pages (404.html, privacy.html, assets/auth/callback.html) are
 * the brand card in the visitor's theme, fit a phone without sideways
 * scrolling, and show keyboard focus (assets/css/README.md, "Site Design
 * Principles"; tests/site-pages-design-contract.test.mjs holds their markup).
 */
import { expect, test } from './helpers/test.mjs';

const PAGES = [
  ['/404.html', 'Page not found'],
  ['/privacy.html', 'Privacy policy'],
  ['/assets/auth/callback.html', 'Sign-in'],
];

for (const [address, heading] of PAGES) {
  test(`${address} is the brand card in both themes and on a phone`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(address);
    await expect(page.locator('h1.welcome-title')).toHaveText(heading);
    await expect(page.locator('.welcome-logo')).toBeVisible();
    // A phone never scrolls sideways.
    expect(await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    )).toBe(true);

    const light = await page.locator('.welcome-content').evaluate(
      card => getComputedStyle(card).backgroundColor,
    );
    // The theme chosen in the app is the page's theme too.
    await page.evaluate(() => localStorage.setItem('cellucid_theme', 'dark'));
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const dark = await page.locator('.welcome-content').evaluate(
      card => getComputedStyle(card).backgroundColor,
    );
    expect(dark).not.toBe(light);
    expect(await page.locator('.welcome-logo').evaluate(
      logo => getComputedStyle(logo).filter,
    )).toContain('invert');
    await page.evaluate(() => localStorage.removeItem('cellucid_theme'));

    // Keyboard focus is drawn. WebKit, like Safari, moves to links with
    // Option+Tab (plain Tab reaches them only with "Press Tab to highlight
    // each item" on).
    const tab = test.info().project.name === 'webkit' ? 'Alt+Tab' : 'Tab';
    let outline = 'none';
    for (let step = 0; step < 4 && outline === 'none'; step += 1) {
      await page.keyboard.press(tab);
      outline = await page.evaluate(() => {
        const focused = document.activeElement;
        return focused === document.body ? 'none' : getComputedStyle(focused).outlineStyle;
      });
    }
    expect(outline).not.toBe('none');
    expect(errors).toEqual([]);
  });
}

test('the sign-in return page with nothing to finish says so', async ({ page }) => {
  await page.goto('/assets/auth/callback.html');
  await expect(page.locator('#status')).toHaveText(
    'There is no sign-in to finish here. You can close this window.',
  );
});
