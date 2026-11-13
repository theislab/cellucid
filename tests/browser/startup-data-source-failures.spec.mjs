/**
 * A data failure says what is wrong, what to do, and stays on screen with a
 * way back.
 *
 * A failed dataset switch does not surface a raw browser string in a toast
 * that fades away, leaving nothing behind to read or to act on. (A catalog
 * that fails names its own cause in `sample-catalog-cors.spec.mjs`.)
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './helpers/test.mjs';
import { fulfillFile, zipEntryData } from './helpers/anndata-zarr-zip.mjs';
import { APP_ORIGIN as ORIGIN } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { goOffline } from './helpers/offline.mjs';
import { chooseFiles } from './helpers/file-input.mjs';

const fixturesDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
);
const GOOD_CATALOG = `${ORIGIN}/tests/browser/fixtures/demo-catalog/`;
const NOTICE = '#dataset-notice';
const NOTICE_BUTTON = `${NOTICE} button`;

const GOOD_DATASET = Object.freeze({
  id: 'synthetic-cell-types-2d',
  name: 'Synthetic cell-type islands — 2D',
  cells: 72,
});
const OTHER_DATASET = Object.freeze({
  id: 'synthetic-development-3d',
  name: 'Synthetic branching development — 3D',
  cells: 96,
});

function catalogUrl(baseUrl, datasetId) {
  const url = new URL('/', ORIGIN);
  url.searchParams.set('sampleCatalog', baseUrl);
  if (datasetId !== null) url.searchParams.set('dataset', datasetId);
  return url.toString();
}

function optionValue(datasetId) {
  return `dataset:local-demo:${datasetId}`;
}

async function noticeText(page) {
  return page.locator(`${NOTICE} .dataset-notice-message`).first().innerText();
}

/* ------------------------------------------------------------------ *
 * A failed dataset switch persists and offers a way back
 * ------------------------------------------------------------------ */

test('an offline dataset switch explains itself and stays on screen', async ({
  page,
  context,
}, testInfo) => {
  await page.goto(catalogUrl(GOOD_CATALOG, GOOD_DATASET.id), {
    waitUntil: 'domcontentloaded',
  });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(GOOD_DATASET.name);
  // The first opening and the samples' listing are over before the link goes
  // (`goOffline`): a read of either still under way would fail offline on its
  // own and say so beside the switch's failure.
  await goOffline(context);
  await page.locator('#dataset-select').selectOption(
    optionValue(OTHER_DATASET.id),
  );

  const notice = page.locator(NOTICE);
  await expect(notice).toBeVisible();
  const message = await noticeText(page);
  await testInfo.attach('dataset-switch-offline-notice.txt', {
    body: message,
    contentType: 'text/plain',
  });
  // It names the dataset that failed, what to do, and what survived.
  expect(message).toContain(`"${OTHER_DATASET.name}" could not be opened`);
  // Why, as it is: this computer is offline (not a host refusing this network),
  // and what to do.
  expect(message).toContain('This computer is offline');
  expect(message).toMatch(/try again/i);
  expect(message).toContain(`"${GOOD_DATASET.name}" is still open.`);
  // Nothing a wet-lab user has to decode.
  expect(message).not.toMatch(/Failed to fetch|https?:|gzip/);

  // Errors intentionally stay until the reader dismisses them. The sidebar
  // notice is the durable recovery owner, so dismissing the diagnostic toast
  // must leave the explanation and its retry in place.
  const failureNotification = page.locator(
    '#notification-center .notification-error',
  );
  await expect(failureNotification).toHaveCount(1);
  await failureNotification.locator(
    '.notification-dismiss[data-role="dismiss"]',
  ).click();
  await expect(failureNotification).toHaveCount(0);
  await expect(notice).toBeVisible();
  expect(await noticeText(page)).toBe(message);

  // And the retry opens the dataset that failed, without a page reload.
  await context.setOffline(false);
  await page.locator(NOTICE_BUTTON).click();
  await expect(page.locator('#dataset-name')).toHaveText(OTHER_DATASET.name);
  await expect(page.locator('#dataset-cells')).toHaveText(
    String(OTHER_DATASET.cells),
  );
  await expect(notice).toBeHidden();
});

/**
 * A catalog whose datasets all describe themselves, but one of which is
 * damaged where only opening it reads: one byte of its embedding is flipped,
 * so its ZIP entry no longer matches its checksum.
 */
async function serveDamagedCatalog(page, base) {
  const demo = id => readFileSync(path.join(fixturesDirectory, 'demo-catalog', `${id}.zarr.zip`));
  const damaged = Buffer.from(demo(GOOD_DATASET.id));
  const embedding = zipEntryData(damaged, `${GOOD_DATASET.id}.zarr/obsm/X_islands/0.0`);
  damaged[embedding.offset + embedding.length - 1] ^= 0xff;
  const files = new Map([
    [`${GOOD_DATASET.id}.zarr.zip`, damaged],
    [`${OTHER_DATASET.id}.zarr.zip`, demo(OTHER_DATASET.id)],
  ]);
  await page.route(`${base}**`, route => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    if (name === 'datasets.json') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          schema: 2,
          default: OTHER_DATASET.id,
          datasets: [...files.keys()].map(file => ({
            id: file.replace(/\.zarr\.zip$/, ''),
            path: file,
          })),
        }),
      });
    }
    return fulfillFile(route, files.get(name));
  });
}

test('a damaged dataset leads with the dataset, not the file', async ({
  page,
}, testInfo) => {
  const base = `${ORIGIN}/tests/browser/fixtures/damaged-catalog/`;
  await serveDamagedCatalog(page, base);
  await page.goto(catalogUrl(base, null), {
    waitUntil: 'domcontentloaded',
  });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(OTHER_DATASET.name);
  // The samples' listing reads their files once the first view has settled
  // (`holdListingUntil`); until it has, the picker (and so the failure) can
  // name the damaged sample only by its file. A switch made while the listing
  // still reads keeps its notice when the listing settles: the contract test
  // "a listing that settles after a failed switch keeps the switch's notice".
  await expect(page.locator(`#dataset-select option[value="${optionValue(GOOD_DATASET.id)}"]`))
    .toHaveText(new RegExp(`${GOOD_DATASET.cells} cells`));

  await page.locator('#dataset-select').selectOption(
    optionValue(GOOD_DATASET.id),
  );
  await expect(page.locator(NOTICE)).toBeVisible();
  const message = await noticeText(page);
  await testInfo.attach('dataset-switch-corrupt-notice.txt', {
    body: message,
    contentType: 'text/plain',
  });
  expect(message).toMatch(
    new RegExp(`^"${GOOD_DATASET.name}" could not be opened`),
  );
  expect(message).not.toMatch(/https?:/);
  expect(message).toContain(`"${OTHER_DATASET.name}" is still open.`);

  // The session survives, and other data still loads from the same controls.
  await expect(page.locator('#dataset-name')).toHaveText(OTHER_DATASET.name);
  await chooseFiles(page.locator('#user-data-file-input'), 
    path.join(fixturesDirectory, 'current-ui-smoke.h5ad'),
  );
  await expect(page.locator('#dataset-name')).toHaveText('current-ui-smoke');
  // Loading a dataset successfully retires the failure it replaced.
  await expect(page.locator(NOTICE)).toBeHidden();
});
