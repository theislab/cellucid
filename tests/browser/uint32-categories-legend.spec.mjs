import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './helpers/test.mjs';
import { chooseDirectory } from './helpers/directory-upload.mjs';
import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

const fixtureDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'exports',
  'current-ui-prepared',
);

// More categories than uint16 codes carry, so the export uses uint32 codes.
const CATEGORY_COUNT = 70_000;
const UINT32_MISSING = 4_294_967_295;

/**
 * The prepared fixture, rewritten to uint32 categorical codes with a
 * 70,000-category inventory: the three used labels first, then labels no cell
 * holds (an inventory may be larger than the cells that use it).
 */
async function writeUint32Export(directory) {
  await cp(fixtureDirectory, directory, { recursive: true });
  const identityPath = path.join(directory, 'dataset_identity.json');
  const manifestPath = path.join(directory, 'obs_manifest.json');
  const identity = JSON.parse(await readFile(identityPath, 'utf8'));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  identity.export_settings.obs_categorical_dtype = 'uint32';
  identity.name = 'uint32 categories';
  for (const field of manifest._categoricalFields) {
    const [index, key, categories, dtype] = field;
    const oldPath = path.join(directory, 'obs', `${index}.codes.u8`);
    expect(dtype).toBe('uint8');
    const oldCodes = await readFile(oldPath);
    const codes = new Uint32Array(oldCodes.length);
    for (let cell = 0; cell < oldCodes.length; cell++) {
      codes[cell] = oldCodes[cell] === 255 ? UINT32_MISSING : oldCodes[cell];
    }
    await rm(oldPath);
    await writeFile(path.join(directory, 'obs', `${index}.codes.u32`), Buffer.from(codes.buffer));
    for (let next = categories.length; next < CATEGORY_COUNT; next++) {
      categories.push(`zz-${String(next).padStart(6, '0')}`);
    }
    field[3] = 'uint32';
    field[4] = UINT32_MISSING;
    const identityField = identity.obs_fields.find(entry => entry.key === key);
    identityField.n_categories = categories.length;
  }
  await writeFile(identityPath, JSON.stringify(identity, null, 2));
  await writeFile(manifestPath, JSON.stringify(manifest));
}

test('a field with more categories than uint16 carries loads, and its legend builds only the rows in view', async ({ page }, testInfo) => {
  const directory = testInfo.outputPath('current-ui-prepared');
  await writeUint32Export(directory);

  const browserErrors = [];
  page.on('pageerror', error => browserErrors.push(`page: ${error.stack || error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
  });

  await page.goto(
    `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}&dataset=current-ui-prepared&acceptance=browser-ci`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI prepared fixture');

  await chooseDirectory(page.locator('#user-data-file-input'), directory);
  await expect(page.locator('#dataset-name')).toHaveText('uint32 categories');
  await expect(page.locator('#dataset-cells')).toHaveText('120');
  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });

  const list = page.locator('.legend-items-container.legend-items-virtual');
  await expect(list).toBeVisible();
  const rowCount = await page.locator('.legend-item').count();
  expect(rowCount).toBeGreaterThan(0);
  expect(rowCount).toBeLessThan(200);
  await expect(page.locator('.legend-item .legend-label-main').first()).toHaveText('alpha');

  // The end of the inventory is reachable, and only a window of rows exists.
  await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(page.locator('.legend-item .legend-label-main').last())
    .toHaveText(`zz-${String(CATEGORY_COUNT - 1).padStart(6, '0')}`);
  expect(await page.locator('.legend-item').count()).toBeLessThan(200);

  // Hiding a category filters its cells, and the row keeps its state when
  // it is rebuilt after scrolling away and back.
  await list.evaluate(element => { element.scrollTop = 0; });
  const beta = page.locator('.legend-item', { hasText: 'beta' });
  await beta.locator('.legend-checkbox').uncheck();
  // The fixture's cell_type codes hold 40 beta cells.
  await expect(page.locator('#filter-count')).toHaveText('Showing 80 of 120 cells');
  await list.evaluate(element => { element.scrollTop = element.scrollHeight / 2; });
  await list.evaluate(element => { element.scrollTop = 0; });
  await expect(page.locator('.legend-item', { hasText: 'beta' }).locator('.legend-checkbox')).not.toBeChecked();

  expect(browserErrors).toEqual([]);
});
