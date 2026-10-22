import { expect, test } from './helpers/test.mjs';
import { readFile } from 'node:fs/promises';

import { EXPORTS_BASE_URL as FIXTURE_ROOT } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

test('consensus snapshot downloads once and reports the exact success', async ({
  page,
}) => {
  const productErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') {
      productErrors.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', error => {
    productErrors.push(`page: ${error.stack || error.message}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      productErrors.push(`http ${response.status()}: ${response.url()}`);
    }
  });
  await page.addInitScript(() => {
    window._simulate_repo_connected = true;
    window._author_mode = true;
  });

  await page.goto(
    `/?exportsBaseUrl=${encodeURIComponent(FIXTURE_ROOT)}` +
      '&dataset=current-ui-prepared' +
      '&annotations=theislab%2Fcellucid-annotation%40main' +
      '&acceptance=community-consensus-export',
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );
  await page.getByText('Community annotation', { exact: true }).click();
  await page.getByRole('button', {
    name: 'Snapshot and cache',
    exact: true,
  }).click();

  // The product retires this success toast after 2.2 s. The proof is the
  // notification the product posted, recorded the moment it enters the
  // page, not whether a poll paced by screenshots and a download's disk I/O
  // on a slow host happens to look while a 2.2 s card is on screen.
  await page.evaluate(() => {
    window.__noticeTexts = [];
    const record = node => {
      if (!(node instanceof Element)) return;
      const messages = node.matches('.notification-message')
        ? [node]
        : node.querySelectorAll('.notification-message');
      for (const element of messages) window.__noticeTexts.push(element.textContent.trim());
    };
    new MutationObserver(records => {
      for (const mutation of records) mutation.addedNodes.forEach(record);
    }).observe(document.body, { childList: true, subtree: true });
  });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download', exact: true }).click(),
  ]);
  await expect.poll(() => page.evaluate(() => window.__noticeTexts)).toContain(
    'Downloaded cellucid-consensus.json',
  );
  expect(download.suggestedFilename()).toBe('cellucid-consensus.json');
  const path = await download.path();
  expect(path).not.toBeNull();
  const document = JSON.parse(await readFile(path, 'utf8'));
  expect(Object.keys(document).sort()).toEqual([
    'builtAt',
    'consensus',
    'suggestions',
    'version',
  ]);
  expect(document.version).toBe(1);
  expect(Number.isNaN(Date.parse(document.builtAt))).toBe(false);
  expect(document.suggestions).toEqual({});
  expect(document.consensus).toEqual({});

  await expect(page.locator('.notification-error')).toHaveCount(0);
  expect(productErrors).toEqual([]);
});
