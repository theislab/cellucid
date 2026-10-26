/**
 * Files written before anndata 0.8 open through every local route — the H5AD
 * picker, the Zarr ZIP picker and a drop — and show every cell field they
 * store. The reader-level comparison with current-layout twins is
 * `tests/legacy-anndata-contract.test.mjs`; this checks the visible app.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './helpers/test.mjs';
import {
  expectNoFailureAnnounced,
  expectSettledOn,
  fixturesDirectory,
  openStarted,
} from './helpers/dataset-loading.mjs';
import { chooseFiles } from './helpers/file-input.mjs';

const FIELDS = ['batch', 'cell_type', 'stage'];

/**
 * The title each fixture gives itself in `uns['title']`. A local file is
 * named as current files are: `uns['cellucid']['name']`, else
 * `uns['title']`, else its file name; these files have no
 * `uns['cellucid']`, so their title names them.
 */
const TITLES = {
  'legacy-0.6.h5ad': 'Legacy AnnData 0.6 fixture',
  'legacy-0.6-compound-obsm.h5ad': 'Legacy AnnData 0.6 fixture',
  'legacy-0.7-csr.h5ad': 'Legacy AnnData 0.7 fixture',
  'legacy-0.7.zarr.zip': 'Legacy AnnData 0.7 fixture',
  'legacy-seuratdisk.h5ad': 'Legacy AnnData 0.7 fixture',
};

function opened(file) {
  return { name: TITLES[file], cells: 120, select: '__dataset_unlisted__' };
}

async function expectEveryCellField(page) {
  const categorical = page.locator('#categorical-field');
  await expect
    .poll(() => categorical.locator('option').evaluateAll(options =>
      options.map(option => option.textContent.trim()).sort()))
    .toEqual(expect.arrayContaining(FIELDS));
  await categorical.selectOption({ label: 'stage' });
  await expect(categorical.locator('option:checked')).toHaveText('stage');
  await expect(page.locator('#dataset-genes')).toHaveText('6');
}

for (const [file, input] of [
  ['legacy-0.7-csr.h5ad', '#user-data-file-input'],
  ['legacy-seuratdisk.h5ad', '#user-data-file-input'],
  ['legacy-0.6-compound-obsm.h5ad', '#user-data-file-input'],
  ['legacy-0.7.zarr.zip', '#user-data-file-input'],
]) {
  test(`${file} opens from its file picker with every cell field`, async ({ page }) => {
    const productErrors = await openStarted(page);
    await chooseFiles(page.locator(input), path.join(fixturesDirectory, file));
    await expectSettledOn(page, opened(file));
    await expectEveryCellField(page);
    await expectNoFailureAnnounced(page);
    expect(productErrors).toEqual([]);
  });
}

test('a dropped 0.6 .h5ad file opens like a picked one', async ({ page }) => {
  const productErrors = await openStarted(page);
  const base64 = (await readFile(path.join(fixturesDirectory, 'legacy-0.6.h5ad')))
    .toString('base64');
  await page.evaluate(base64 => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(
      [Uint8Array.from(atob(base64), c => c.charCodeAt(0))],
      'legacy-0.6.h5ad',
    ));
    const target = document.getElementById('glcanvas');
    for (const type of ['dragenter', 'dragover', 'drop']) {
      target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
    }
  }, base64);
  await expectSettledOn(page, opened('legacy-0.6.h5ad'));
  await expectEveryCellField(page);
  await expectNoFailureAnnounced(page);
  expect(productErrors).toEqual([]);
});
