import { expect, test } from '@playwright/test';
import { dismissWelcome } from './helpers/welcome.mjs';

const EXPORTS_ROOT =
  'http://127.0.0.1:4173/tests/browser/fixtures/exports/';
const PREPARED_DATASET_URL =
  `/?exportsBaseUrl=${encodeURIComponent(EXPORTS_ROOT)}` +
  '&dataset=current-ui-prepared&acceptance=dataset-kept-view-lifecycle';
const ALTERNATE_DATASET_ID = 'current-ui-alternate';
const ALTERNATE_DATASET_NAME = 'Current UI alternate fixture';
const ALTERNATE_DATASET_OPTION =
  `dataset:local-demo:${ALTERNATE_DATASET_ID}`;

function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') {
      errors.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', error => {
    errors.push(`page: ${error.stack || error.message}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      errors.push(`http ${response.status()}: ${response.url()}`);
    }
  });
  return errors;
}

async function installAlternatePreparedDataset(page) {
  await page.route(
    '**/tests/browser/fixtures/exports/datasets.json',
    async route => {
      const response = await route.fetch();
      const catalog = await response.json();
      const source = catalog.datasets.find(
        dataset => dataset.id === 'current-ui-prepared',
      );
      if (source === undefined) {
        throw new Error('Prepared fixture is missing from its dataset catalog.');
      }
      catalog.datasets.push({
        ...source,
        id: ALTERNATE_DATASET_ID,
        name: ALTERNATE_DATASET_NAME,
        path: `${ALTERNATE_DATASET_ID}/`,
      });
      await route.fulfill({ response, json: catalog });
    },
  );

  await page.route(
    `**/tests/browser/fixtures/exports/${ALTERNATE_DATASET_ID}/**`,
    async route => {
      const alternateUrl = new URL(route.request().url());
      const preparedUrl = new URL(alternateUrl);
      const alternatePrefix =
        `/tests/browser/fixtures/exports/${ALTERNATE_DATASET_ID}/`;
      if (!alternateUrl.pathname.startsWith(alternatePrefix)) {
        throw new Error(
          `Unexpected alternate fixture URL: ${alternateUrl.pathname}`,
        );
      }
      preparedUrl.pathname =
        '/tests/browser/fixtures/exports/current-ui-prepared/' +
        alternateUrl.pathname.slice(alternatePrefix.length);
      const response = await route.fetch({ url: preparedUrl.href });
      if (alternateUrl.pathname.endsWith('/dataset_identity.json')) {
        const identity = await response.json();
        identity.id = ALTERNATE_DATASET_ID;
        identity.name = ALTERNATE_DATASET_NAME;
        await route.fulfill({ response, json: identity });
        return;
      }
      await route.fulfill({ response });
    },
  );
}

test(
  'direct dataset replacement retires every kept view before refreshing active-view UI',
  async ({ page }) => {
    const productErrors = observeProductErrors(page);
    await installAlternatePreparedDataset(page);
    await page.goto(PREPARED_DATASET_URL, {
      waitUntil: 'domcontentloaded',
    });
    await dismissWelcome(page);

    await expect(page.locator('#dataset-name')).toHaveText(
      'Current UI prepared fixture',
    );
    await expect(
      page.locator(
        `#dataset-select option[value="${ALTERNATE_DATASET_OPTION}"]`,
      ),
    ).toContainText(ALTERNATE_DATASET_NAME);

    await page.locator('#categorical-field').selectOption({
      label: 'cell_type',
    });
    await expect(page.locator('.legend-item')).toHaveCount(3);
    await page.locator('#split-keep-view-btn').click();
    await expect.poll(() => page.evaluate(() => {
      const viewer = window._cellucidViewer;
      const state = window._cellucidState;
      return {
        snapshots: viewer.getSnapshotViews().map(snapshot => snapshot.id),
        activeId: state.getActiveViewId(),
        contexts: Array.from(state.viewContexts.keys()),
        layout: viewer.getViewLayout(),
      };
    })).toEqual({
      snapshots: ['snap_1'],
      activeId: 'snap_1',
      contexts: ['live', 'snap_1'],
      layout: {
        mode: 'grid',
        activeId: 'snap_1',
        liveViewHidden: false,
      },
    });
    await expect(page.locator('.split-badge')).toHaveCount(2);

    await page.locator('#dataset-select').selectOption(
      ALTERNATE_DATASET_OPTION,
    );
    await expect(page.locator('#dataset-name')).toHaveText(
      ALTERNATE_DATASET_NAME,
    );
    await expect.poll(() => page.evaluate(() => {
      const viewer = window._cellucidViewer;
      const state = window._cellucidState;
      return {
        snapshots: viewer.getSnapshotViews().map(snapshot => snapshot.id),
        activeId: state.getActiveViewId(),
        contexts: Array.from(state.viewContexts.keys()),
        layout: viewer.getViewLayout(),
      };
    })).toEqual({
      snapshots: [],
      activeId: 'live',
      contexts: ['live'],
      layout: {
        mode: 'grid',
        activeId: 'live',
        liveViewHidden: false,
      },
    });

    await expect(page.locator('#split-view-badges-box')).toBeHidden();
    await expect(page.locator('.split-badge')).toHaveCount(1);
    await expect(page.locator('.split-badge.active')).toHaveCount(1);
    await expect(page.locator('#split-clear-btn')).toBeDisabled();
    await expect(page.locator('#camera-lock-btn')).toBeDisabled();
    await expect(page.locator('.notification-error')).toHaveCount(0);
    await page.evaluate(() => new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
    expect(productErrors).toEqual([]);
  },
);
