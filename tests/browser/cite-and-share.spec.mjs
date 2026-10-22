/**
 * Cite Cellucid and Share this dataset, against the running app.
 *
 * The Cite dialog must say what the deployed CITATION.cff says — read through
 * the same module the contract test holds to the documentation — and say it is
 * a placeholder while there is no DOI. Both dialogs are native modal dialogs:
 * Escape closes them and focus returns to the control that opened them.
 */
import { expect, test } from './helpers/test.mjs';
import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const DATASET_URL = `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}&dataset=current-ui-prepared`;

async function expectedCitation(page) {
  return page.evaluate(async () => {
    const { apa, bibtex, parsePreferredCitation } = await import('/assets/js/app/citation.js');
    const citation = parsePreferredCitation(await (await fetch('/CITATION.cff')).text());
    return { reference: apa(citation), bibtex: bibtex(citation), placeholder: citation.placeholder };
  });
}

test('the footer Cite link opens the citation read from CITATION.cff', async ({ page }) => {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI prepared fixture');
  const expected = await expectedCitation(page);

  const opener = page.locator('#footer-cite-link');
  await opener.scrollIntoViewIfNeeded();
  await opener.click();
  const dialog = page.locator('#cite-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#cite-reference')).toHaveText(expected.reference);
  await expect(page.locator('#cite-bibtex')).toHaveText(expected.bibtex.trimEnd());
  await expect(page.locator('#cite-placeholder')).toBeVisible({ visible: expected.placeholder });
  await expect(page.locator('#cite-copy-bibtex')).toBeEnabled();
  // A real link underneath: without this module the page would open the docs.
  await expect(opener).toHaveAttribute('href', 'https://docs.cellucid.com/en/latest/citing.html');

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test('a sample dataset can be shared as a link, a badge and an embed', async ({ page }) => {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI prepared fixture');
  const share = page.locator('#share-dataset-btn');
  await expect(share).toBeVisible();
  await share.click();
  const dialog = page.locator('#share-dialog');
  await expect(dialog).toBeVisible();
  const link = 'https://www.cellucid.com/?dataset=current-ui-prepared&source=local-demo';
  await expect(page.locator('#share-link')).toHaveValue(link);
  await expect(page.locator('#share-badge')).toHaveValue(
    `[![Open in Cellucid](https://www.cellucid.com/assets/img/open-in-cellucid.svg)](${link})`,
  );
  await expect(page.locator('#share-embed')).toHaveValue(
    new RegExp(`^<iframe src="${link.replace('&', '&amp;').replace(/[.?]/g, '\\$&')}" title="Cellucid: Current UI prepared fixture"`),
  );
  // The badge image the snippet points at is served by the site.
  const badge = await page.request.get('/assets/img/open-in-cellucid.svg');
  expect(badge.status()).toBe(200);
  expect(badge.headers()['content-type']).toContain('image/svg+xml');

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(share).toBeFocused();
});

test('an (i) tip inside a dialog opens over it, and Escape closes the tip first', async ({ page }) => {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI prepared fixture');
  await page.locator('#share-dataset-btn').click();
  const dialog = page.locator('#share-dialog');
  await expect(dialog).toBeVisible();
  await page.locator('#share-embed-info-btn').click();
  const tip = page.locator('#share-embed-info-tooltip');
  await expect(tip).toBeVisible();
  await expect(tip.getByRole('link', { name: 'Embedding' })).toBeVisible();
  // The tip is on top and reachable: a click on its link target lands in it.
  const box = await tip.boundingBox();
  const topmost = await page.evaluate(({ x, y }) => (
    document.elementFromPoint(x, y)?.closest('.info-tooltip')?.id ?? null
  ), { x: box.x + box.width / 2, y: box.y + 10 });
  expect(topmost).toBe('share-embed-info-tooltip');

  await page.keyboard.press('Escape');
  await expect(tip).toBeHidden();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
