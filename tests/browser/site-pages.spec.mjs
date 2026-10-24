/**
 * The standalone pages (404.html, privacy.html, terms.html,
 * accessibility.html, assets/auth/callback.html) are the brand card in the
 * visitor's theme, fit a phone without sideways scrolling, and show keyboard
 * focus (assets/css/README.md, "Site Design Principles";
 * tests/site-pages-design-contract.test.mjs holds their markup). The app's
 * footer reaches the reading pages, each in a new tab so the app keeps its
 * state.
 */
import { expect, test } from './helpers/test.mjs';

const PAGES = [
  ['/404.html', 'Page not found'],
  ['/privacy.html', 'Privacy policy'],
  ['/terms.html', 'Terms of use'],
  ['/accessibility.html', 'Accessibility'],
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

test('the footer keeps its links to one quiet line and opens each page in a new tab', async ({ page }) => {
  await page.goto('/');
  const footer = page.locator('#copyright');
  const links = footer.locator('p').nth(1).locator('a');
  await expect(links).toHaveText(['Docs', 'Cite', 'GitHub', 'Privacy', 'Terms']);
  // One line at the sidebar's default width: every link starts on the same row.
  const rows = await links.evaluateAll(anchors => anchors.map(anchor => {
    const box = anchor.getBoundingClientRect();
    return box.width > 0 ? Math.round(box.top) : null;
  }));
  expect(rows).not.toContain(null);
  expect(new Set(rows).size).toBe(1);
  // The accessibility statement sits beside the licence, on its line.
  const license = footer.locator('p').nth(2).locator('a');
  await expect(license).toHaveText(['BSD 3-Clause license', 'Accessibility']);
  const licenseRows = await license.evaluateAll(anchors => anchors.map(anchor => Math.round(anchor.getBoundingClientRect().top)));
  expect(new Set(licenseRows).size).toBe(1);

  for (const [name, heading] of [['Privacy', 'Privacy policy'], ['Terms', 'Terms of use'], ['Accessibility', 'Accessibility']]) {
    const link = footer.getByRole('link', { name, exact: true });
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /\bnoopener\b/);
    const response = await page.request.get(new URL(await link.getAttribute('href'), page.url()).href);
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain(`class="welcome-title">${heading}</h1>`);
  }
});

test('the sign-in return page with nothing to finish says so', async ({ page }) => {
  await page.goto('/assets/auth/callback.html');
  await expect(page.locator('#status')).toHaveText(
    'There is no sign-in to finish here. You can close this window.',
  );
});
