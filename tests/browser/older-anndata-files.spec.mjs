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
  'legacy-0.7-csr.h5ad': 'Legacy AnnData 0.7 fixture',
  'legacy-0.7.zarr.zip': 'Legacy AnnData 0.7 fixture',
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

test('older AnnData files open with every cell field: picked as an .h5ad, dropped, and picked as a Zarr ZIP', async ({ page }) => {
  const productErrors = await openStarted(page);

  // The dropped file goes between the two picked ones, whose title is the same: each opening shows another name.
  await test.step('legacy-0.7-csr.h5ad opens from its file picker with every cell field', async () => {
    await chooseFiles(page.locator('#user-data-file-input'), path.join(fixturesDirectory, 'legacy-0.7-csr.h5ad'));
    await expectSettledOn(page, opened('legacy-0.7-csr.h5ad'));
    await expectEveryCellField(page);
    await expectNoFailureAnnounced(page);
  });

  await test.step('a dropped 0.6 .h5ad file opens like a picked one', async () => {
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
  });

  await test.step('legacy-0.7.zarr.zip opens from its file picker with every cell field', async () => {
    await chooseFiles(page.locator('#user-data-file-input'), path.join(fixturesDirectory, 'legacy-0.7.zarr.zip'));
    await expectSettledOn(page, opened('legacy-0.7.zarr.zip'));
    await expectEveryCellField(page);
    await expectNoFailureAnnounced(page);
  });
  expect(productErrors).toEqual([]);
});
