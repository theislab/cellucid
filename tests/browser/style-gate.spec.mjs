/**
 * The page is parsed, and its code started, only once its stylesheet is in.
 *
 * WebKit does not hold DOMContentLoaded for a stylesheet (Chromium and
 * Firefox do, through the deferred scripts at the end of the page). The page
 * boot starts the code at DOMContentLoaded, so on a link where the stylesheet
 * came after the document (measured with its response held 4 s) WebKit
 * started the code 0.3 s in, in a page with no styles: no design token had a
 * value, and the analysis tools failed to load on one that resolved to
 * nothing. Markup hidden by a class (the welcome dialog was then a `div`
 * with `class="welcome-modal hidden"`) was displayed, so a spec that navigated
 * and waited for the welcome dialog to be visible saw the markup, pressed
 * Escape before any listener existed, and the page showed the dialog
 * afterwards over a page the spec believed free of it (Web contracts run
 * 42180485733 and earlier, Linux WebKit: history-graph, highlight-pulse,
 * knn-missing, my-datasets). The welcome is now a `<dialog>`, which is not
 * displayed until opened in any page, styled or not.
 *
 * The style gate (index.html, CELLUCID_STYLE_GATE) is a script straight after
 * the stylesheet link: a script waits for the stylesheets before it in every
 * engine, so nothing of the body is parsed, and DOMContentLoaded does not
 * come, before the styles. A stylesheet that did not load is reported like
 * a file of the code that did not, instead of starting the code without it.
 */
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const START_URL = `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&acceptance=style-gate`;

// How long the stylesheet is kept from the page: the slow link is the
// subject. Without the gate WebKit reached DOMContentLoaded and started the
// code a few hundred milliseconds in; with it, nothing does before the
// stylesheet is released, however long that takes.
const HELD_MS = 2500;

/**
 * Has the page note, at DOMContentLoaded and at the first statement of its
 * code (`data-code-started`, main.js), whether its styles are in: the design
 * tokens have values (`--font-sans`, the one the analysis tools failed on),
 * and the welcome dialog, closed while the page is parsed, is laid out as its
 * stylesheet says once the code has opened it (`.dialog-layer[open]`,
 * components/_modals.css: `flex`; `block` in a page without that rule).
 */
async function noteStylesAtStart(page) {
  await page.addInitScript(() => {
    const styles = () => ({
      welcomeMarkup: getComputedStyle(document.getElementById('welcome-modal')).display,
      tokens: getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim() !== '',
    });
    window.__stylesAtStart = { parsed: null, code: null };
    document.addEventListener('DOMContentLoaded', () => {
      window.__stylesAtStart.parsed = styles();
    });
    // Told at the end of the task that set the attribute: the code has opened
    // the dialog by then where it shows one (`flex`), in a styled page.
    new MutationObserver(() => {
      window.__stylesAtStart.code ??= styles();
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-code-started'] });
  });
}

for (const [name, held] of [
  ['the stylesheet', '/assets/css/main.css'],
  ['a stylesheet it imports', '/assets/css/components/_welcome.css'],
]) {
  test(`a page whose styles arrive late is parsed and started only with them: ${name}`, async ({ page }) => {
    await noteStylesAtStart(page);
    await page.route(url => url.pathname.endsWith(held), async route => {
      await new Promise(resolve => setTimeout(resolve, HELD_MS));
      await route.continue();
    });
    await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('data-code-started', 'true');
    expect(await page.evaluate(() => window.__stylesAtStart)).toEqual({
      parsed: { welcomeMarkup: 'none', tokens: true },
      code: { welcomeMarkup: 'flex', tokens: true },
    });

    // What the unstyled start broke: the dialog is dismissed once and stays so.
    await dismissWelcome(page);
    await expect(page.locator('html')).toHaveAttribute('data-startup-phase', 'ready');
    await expect(page.locator('#welcome-modal')).not.toHaveAttribute('open');
    await expect(page.locator('#welcome-modal')).toBeHidden();
  });
}

test('a stylesheet that does not load is reported, and the code is not started without it', async ({ page }) => {
  await page.route(url => url.pathname.endsWith('/assets/css/main.css'), route => route.abort());
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });

  const failure = page.locator('#cellucid-startup-failure');
  await expect(failure).toBeVisible();
  await expect(failure).toHaveAttribute('data-code-failure', 'download');
  await expect(failure.locator('.welcome-title')).toHaveText('Cellucid could not load');
  await expect(failure.locator('.welcome-details-text')).toContainText('stylesheet');
  await expect(failure.locator('.welcome-details-text')).toContainText('/assets/css/main.css');
  await expect(failure.getByRole('link', { name: 'Try again' })).toBeVisible();
  await expect(page.locator('#data-source-status')).toHaveText(
    'Cellucid could not load its code: a request for one of its files failed. ' +
      'Check the network connection, then reload this page.',
  );
  const root = page.locator('html');
  await expect(root).toHaveAttribute('data-code-load-failed', 'true');
  // The failure is reported where the code would have been imported, in its place.
  await expect(root).not.toHaveAttribute('data-code-started', /.*/);
});
