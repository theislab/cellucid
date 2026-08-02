/**
 * A data failure says what is wrong, what to do, and stays on screen with a
 * way back.
 *
 * Two defects are covered here. A catalog failure used to blame the network
 * whatever had happened — a 404, a 403, an address that answered with a web
 * page and a truncated list all produced the same sentence, even though the
 * loader publishes the difference on the error it throws. And a failed dataset
 * switch used to surface a raw browser string in a toast that faded away,
 * leaving nothing behind to read or to act on.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { APP_ORIGIN as ORIGIN } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const fixturesDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
);
const GOOD_EXPORTS = `${ORIGIN}/tests/browser/fixtures/demo-custom-exports/`;
const BROKEN = `${ORIGIN}/tests/browser/fixtures/broken-exports/`;
const NOTICE = '.dataset-info[role="status"]';
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

function exportsUrl(baseUrl, datasetId) {
  const url = new URL('/', ORIGIN);
  url.searchParams.set('exportsBaseUrl', baseUrl);
  if (datasetId !== null) url.searchParams.set('dataset', datasetId);
  return url.toString();
}

function optionValue(datasetId) {
  return `dataset:local-demo:${datasetId}`;
}

async function noticeText(page) {
  return page.locator(`${NOTICE} > div`).first().innerText();
}

/* ------------------------------------------------------------------ *
 * A catalog failure names its own cause
 * ------------------------------------------------------------------ */

/**
 * Each of these is a different thing going wrong, and the loader already knows
 * which: a `DataSourceError` code, or the HTTP status the server answered with.
 */
const CATALOG_FAILURES = Object.freeze([
  Object.freeze({
    label: 'wrong-address',
    base: `${ORIGIN}/tests/browser/fixtures/no-such-export-tree/`,
    status: null,
    expect: /nothing is published at that address/,
    forbid: /Check your network/,
  }),
  Object.freeze({
    label: 'permission-denied',
    base: GOOD_EXPORTS,
    status: 403,
    expect: /the server refused access/,
    forbid: /Check your network/,
  }),
  Object.freeze({
    label: 'server-error',
    base: GOOD_EXPORTS,
    status: 500,
    expect: /the server reported a problem of its own/,
    forbid: /Check your network/,
  }),
  Object.freeze({
    // A body that is not a dataset list and a dropped connection arrive at the
    // UI as the same error, so they honestly share one sentence naming both.
    label: 'not-a-dataset-list',
    base: `${BROKEN}wrong-format-catalog/`,
    status: null,
    expect: /may not hold Cellucid data/,
    forbid: /not found|refused access/,
  }),
]);

const seenCatalogSentences = new Map();

for (const failure of CATALOG_FAILURES) {
  test(
    `a ${failure.label} catalog is reported as ${failure.label}, not as a network problem`,
    async ({ page }, testInfo) => {
      if (failure.status !== null) {
        await page.route(`${failure.base}datasets.json`, route =>
          route.fulfill({
            status: failure.status,
            contentType: 'text/plain',
            body: 'no',
          }));
      }
      await page.goto(exportsUrl(failure.base, null), {
        waitUntil: 'domcontentloaded',
      });
      await dismissWelcome(page);

      await expect(page.locator(NOTICE)).toBeVisible();
      const message = await noticeText(page);
      await testInfo.attach(`catalog-notice-${failure.label}.txt`, {
        body: message,
        contentType: 'text/plain',
      });
      expect(message).toMatch(/^Sample datasets could not be loaded/);
      expect(message).toMatch(failure.expect);
      expect(message).not.toMatch(failure.forbid);
      // The notice speaks to a bench scientist, so no URL, status line or
      // transport term reaches it.
      expect(message).not.toMatch(/https?:|CORS|gzip|JSON|HTTP/);

      // Every failure keeps the persistent retry the notice has always had.
      await expect(page.locator(NOTICE_BUTTON)).toHaveText('Try again');
      await expect(page.locator(NOTICE_BUTTON)).toBeEnabled();

      // No two of these read the same.
      expect(
        seenCatalogSentences.has(message)
          ? seenCatalogSentences.get(message)
          : failure.label,
      ).toBe(failure.label);
      seenCatalogSentences.set(message, failure.label);
    },
  );
}

/* ------------------------------------------------------------------ *
 * A failed dataset switch persists and offers a way back
 * ------------------------------------------------------------------ */

test('an offline dataset switch explains itself and stays on screen', async ({
  page,
  context,
}, testInfo) => {
  await page.goto(exportsUrl(GOOD_EXPORTS, GOOD_DATASET.id), {
    waitUntil: 'domcontentloaded',
  });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(GOOD_DATASET.name);

  await context.setOffline(true);
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
  expect(message).toContain('Try again');
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

test('a damaged dataset payload leads with the dataset, not the file', async ({
  page,
}, testInfo) => {
  await page.goto(exportsUrl(`${BROKEN}mixed-corrupt-payload/`, null), {
    waitUntil: 'domcontentloaded',
  });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(OTHER_DATASET.name);

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
  expect(message).not.toMatch(/https?:|gzip|Payload/);
  expect(message).toContain(`"${OTHER_DATASET.name}" is still open.`);

  // The session survives, and other data still loads from the same controls.
  await expect(page.locator('#dataset-name')).toHaveText(OTHER_DATASET.name);
  await page
    .locator('#user-data-file-input')
    .setInputFiles(path.join(
      fixturesDirectory, 'demo-custom-exports', GOOD_DATASET.id,
    ));
  await expect(page.locator('#dataset-name')).toHaveText(GOOD_DATASET.name);
  // Loading a dataset successfully retires the failure it replaced.
  await expect(page.locator(NOTICE)).toBeHidden();
});
