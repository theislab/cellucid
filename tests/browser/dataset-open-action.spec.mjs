/**
 * An agent opens a dataset by the name the person gives (`dataset.open`,
 * `app/ui/modules/dataset-open-action.js`), through the paths the person's
 * own choices take:
 *
 * - a link the person has not seen in this tab is asked about on the card
 *   before anything of it is requested: declined, its host hears
 *   nothing; allowed once, it opens as the address bar opens it; then, from
 *   My datasets, by the name it was listed under, it opens without asking;
 *   one the person typed into the address bar is not asked about.
 *
 * What the action answers for a name, a fraction or a count, and what it asks
 * before a whole-file download, are held by `tests/dataset-open-action.test.mjs`.
 */
import { expect, test } from './helpers/test.mjs';
import { openDatasetAsAgent } from './helpers/agent-dataset-open.mjs';
import { DEVELOPMENT, START, UNLISTED_OPTION, expectSettledOn, observePage, startUrl } from './helpers/dataset-loading.mjs';
import { SAMPLE_ORIGIN } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const LINK = Object.freeze({ url: `${SAMPLE_ORIGIN}/tests/browser/fixtures/catalog/current-ui.h5ad`, name: 'Current UI fixture', cells: 120, select: UNLISTED_OPTION });
async function start(page) {
  const errors = await observePage(page);
  await page.goto(startUrl(), { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expectSettledOn(page, START);
  return errors;
}

test('a link not seen in this tab is asked first: declined, its host hears nothing; allowed, it opens; from My datasets, it is not asked', async ({ page }) => {
  const errors = await start(page);
  let requests = 0;
  await page.route(`${LINK.url}*`, route => { requests += 1; return route.fallback(); });
  const card = page.locator('#agent-presence .agent-confirm');
  const declining = openDatasetAsAgent(page, { name: LINK.url });
  await expect(card).toHaveAttribute('data-asking', 'unseen-link');
  await expect(card).toHaveAttribute('data-action', 'dataset.open');
  await expect(card.locator('.agent-confirm-why')).toHaveText(`It opens "${LINK.url}", an address not typed, pasted or opened in this tab before.`);
  await card.locator('.agent-confirm-deny').click();
  expect((await declining).refused).toMatchObject({ code: 'declined' });
  expect(requests).toBe(0);
  await expectSettledOn(page, START);

  const allowing = openDatasetAsAgent(page, { name: LINK.url });
  await expect(card).toHaveAttribute('data-asking', 'unseen-link');
  await card.locator('.agent-confirm-allow').click();
  const linked = await allowing;
  expect(linked.outcome).toMatchObject({ name: LINK.name, kind: 'link', cells: LINK.cells, already_open: false });
  await expectSettledOn(page, LINK);
  await expect(page.locator('#data-address')).toHaveValue(LINK.url);

  await openDatasetAsAgent(page, { name: 'development', kind: 'sample' });
  await expectSettledOn(page, DEVELOPMENT);
  // The link was listed in My datasets as it opened; its name opens it again.
  await expect.poll(() => page.evaluate(async () => {
    const { listMyDatasets } = await import('/assets/js/app/library/my-datasets.js');
    return (await listMyDatasets()).map(entry => entry.name);
  })).toContain(LINK.name);
  const mine = await openDatasetAsAgent(page, { name: LINK.name, kind: 'my-datasets' });
  expect(mine.outcome).toMatchObject({ name: LINK.name, kind: 'link', already_open: false });
  await expectSettledOn(page, LINK);
  // Listed in My datasets now: its address opens without a card too.
  await openDatasetAsAgent(page, { name: 'development', kind: 'sample' });
  await expectSettledOn(page, DEVELOPMENT);
  const listed = await openDatasetAsAgent(page, { name: LINK.url });
  expect(listed).toMatchObject({ outcome: { name: LINK.name, kind: 'link' } });
  await expect(card).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a link the person typed into the address bar is one they have seen: an agent opens it without asking', async ({ page }) => {
  const errors = await start(page);
  await page.locator('#data-address').fill(LINK.url);
  await page.locator('#data-address-open-btn').click();
  await expectSettledOn(page, LINK);
  await openDatasetAsAgent(page, { name: 'development', kind: 'sample' });
  await expectSettledOn(page, DEVELOPMENT);
  const card = page.locator('#agent-presence .agent-confirm');
  const opened = await openDatasetAsAgent(page, { name: LINK.url });
  expect(opened).toMatchObject({ outcome: { name: LINK.name, kind: 'link' } });
  await expect(card).toHaveCount(0);
  expect(errors).toEqual([]);
});
