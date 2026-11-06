/**
 * An agent opens a dataset by the name the person gives (`dataset.open`,
 * `app/ui/modules/dataset-open-action.js`), through the paths the person's
 * own choices take:
 *
 * - a sample by a word of its name; one open already is not opened again;
 *   a name nothing matches is refused naming the samples and My datasets;
 * - a link, as the address bar opens it; then, from My datasets, by the name
 *   it was listed under, after another dataset was shown;
 * - a whole-file download (a host that serves no parts of a file) is asked
 *   about first on the agent presence's card (the dispatcher's confirmer),
 *   with its size and why: declined, the dataset shown stays and the agent
 *   is told; allowed once, it downloads and opens;
 * - opening is no step of either dataset's history.
 */
import { expect, test } from './helpers/test.mjs';
import { DEVELOPMENT, START, TRAJECTORY, UNLISTED_OPTION, expectSettledOn, observePage, startUrl } from './helpers/dataset-loading.mjs';
import { SAMPLE_ORIGIN } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const LINK = Object.freeze({ url: `${SAMPLE_ORIGIN}/tests/browser/fixtures/catalog/current-ui.h5ad`, name: 'Current UI fixture', cells: 120, select: UNLISTED_OPTION });
const WHOLE = Object.freeze({ url: `${SAMPLE_ORIGIN}/whole-only/current-ui.h5ad`, name: 'Current UI fixture', cells: 120, select: UNLISTED_OPTION });

/** Dispatch `dataset.open` as Claude, from the page: its outcome, or its refusal's code and sentence. */
function openAsAgent(page, params) {
  return page.evaluate(async parameters => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    try {
      const { outcome, step } = await getActions().dispatch('dataset.open', parameters, { origin: 'agent', agent: 'Claude', turn: 't1' });
      return { outcome, step };
    } catch (error) {
      return { refused: { code: error.code ?? null, message: error.message } };
    }
  }, params);
}

async function start(page) {
  const errors = await observePage(page);
  await page.goto(startUrl(), { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expectSettledOn(page, START);
  return errors;
}

test('a sample by a word of its name; one open already is not opened again; an unknown name says what exists', async ({ page }) => {
  const errors = await start(page);
  const opened = await openAsAgent(page, { name: 'trajectory' });
  expect(opened.step).toBeNull();
  expect(opened.outcome).toEqual({
    name: TRAJECTORY.name, kind: 'sample', cells: TRAJECTORY.cells, total_cells: TRAJECTORY.cells, genes: TRAJECTORY.genes,
    saved_states: 0, already_open: false,
  });
  await expectSettledOn(page, TRAJECTORY);

  const again = await openAsAgent(page, { name: TRAJECTORY.name, kind: 'sample' });
  expect(again.outcome.already_open).toBe(true);

  const unknown = await openAsAgent(page, { name: 'zebrafish' });
  expect(unknown.refused.code).toBe('unknown-dataset');
  expect(unknown.refused.message).toMatch(/^There is no dataset "zebrafish": the samples are "Synthetic cell-type islands — 2D", "Synthetic branching development — 3D" and "Synthetic trajectory — 1D"; /);
  const several = await openAsAgent(page, { name: 'synthetic' });
  expect(several.refused.message).toMatch(/^"synthetic" names 3 datasets: .* Name one exactly\.$/);
  await expectSettledOn(page, TRAJECTORY);
  // Opening is no step of the history of the dataset it opens.
  const steps = await page.evaluate(async () => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    return (await getActions().dispatch('history.get', {})).outcome.steps.map(step => step.type);
  });
  expect(steps).not.toContain('dataset.open');
  expect(errors).toEqual([]);
});

test('a link opens as the address bar opens it, and again from My datasets by its listed name', async ({ page }) => {
  const errors = await start(page);
  const linked = await openAsAgent(page, { name: LINK.url });
  expect(linked.outcome).toMatchObject({ name: LINK.name, kind: 'link', cells: LINK.cells, already_open: false });
  await expectSettledOn(page, LINK);
  await expect(page.locator('#data-address')).toHaveValue(LINK.url);

  await openAsAgent(page, { name: 'development', kind: 'sample' });
  await expectSettledOn(page, DEVELOPMENT);
  // The link was listed in My datasets as it opened; its name opens it again.
  await expect.poll(() => page.evaluate(async () => {
    const { listMyDatasets } = await import('/assets/js/app/library/my-datasets.js');
    return (await listMyDatasets()).map(entry => entry.name);
  })).toContain(LINK.name);
  const mine = await openAsAgent(page, { name: LINK.name, kind: 'my-datasets' });
  expect(mine.outcome).toMatchObject({ name: LINK.name, kind: 'link', already_open: false });
  await expectSettledOn(page, LINK);
  expect(errors).toEqual([]);
});

test('a whole-file download is asked about first: declined, the dataset shown stays; allowed, it opens', async ({ page }) => {
  const errors = await start(page);
  const bytes = await readFile(path.join(FIXTURES, 'catalog', 'current-ui.h5ad'));
  let downloads = 0;
  // A host that ignores Range: every GET answers the whole file.
  await page.route(WHOLE.url, async route => {
    const headers = {
      'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Length, ETag',
      'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length), ETag: '"whole-1"',
    };
    if (route.request().method() === 'HEAD') return route.fulfill({ status: 200, headers, body: '' });
    if (route.request().headers().range === undefined) downloads += 1;
    return route.fulfill({ status: 200, headers, body: bytes });
  });
  // The person answers on the presence layer's card (the page's confirmer): the
  // opening itself is a change the default settings allow; the download is asked.
  const card = page.locator('#agent-presence .agent-confirm');
  const declining = openAsAgent(page, { name: WHOLE.url });
  await expect(card).toHaveAttribute('data-asking', 'large-download');
  await expect(card).toHaveAttribute('data-action', 'dataset.open');
  await expect(card.locator('.agent-confirm-title')).toHaveText(/^Claude asks to open a dataset: “Opened .+”\.$/);
  await expect(card.locator('.agent-confirm-why')).toHaveText(/^It downloads the whole file current-ui\.h5ad \(\d+ KB\) into this browser: 127\.0\.0\.1:\d+ does not serve parts of files\.$/);
  await card.locator('.agent-confirm-deny').click();
  const declined = await declining;
  expect(declined.refused).toEqual({ code: 'declined', message: `The person declined the download, so "${WHOLE.url}" was not opened.` });
  expect(downloads).toBe(0);
  await expectSettledOn(page, START);

  const allowing = openAsAgent(page, { name: WHOLE.url });
  await expect(card).toHaveAttribute('data-asking', 'large-download');
  await card.locator('.agent-confirm-allow').click();
  const allowed = await allowing;
  expect(allowed.outcome).toMatchObject({ name: WHOLE.name, kind: 'link', cells: WHOLE.cells });
  await expectSettledOn(page, WHOLE);
  expect(downloads).toBe(1);
  await expect(card).toHaveCount(0);
  expect(errors).toEqual([]);
});
