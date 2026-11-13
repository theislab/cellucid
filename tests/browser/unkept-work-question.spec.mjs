/**
 * Work on the dataset shown that this browser does not keep (Autosave off)
 * is asked about before anything replaces the dataset: None, another dataset
 * and a synthetic run each ask first (`app/unkept-work-guard.js`), Cancel
 * keeps the dataset shown, and Open anyway lets the replacement go on.
 */
import { expect, test } from './helpers/test.mjs';
import {
  NONE,
  START,
  TRAJECTORY,
  expectSettledOn,
  openStarted,
} from './helpers/dataset-loading.mjs';
import { whenActionsDone } from './helpers/dataset-ready.mjs';

test('work that is not kept is asked about before None, another dataset or a synthetic run replaces it', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    localStorage.setItem('cellucid:history-settings', JSON.stringify({ autosave: false }));
  });
  const productErrors = await openStarted(page);

  // One step of work on the dataset shown: a field colors it.
  await page.waitForFunction(name => {
    const history = window._cellucidHistories?.current();
    return history?.dataset?.name === name && history.active != null;
  }, START.name);
  const field = await page.locator('#categorical-field option:not([value=""])').first().getAttribute('value');
  await page.locator('#categorical-field').selectOption(field);
  await whenActionsDone(page);

  await page.locator('#benchmark-section > summary').click();
  await expect(page.locator('#benchmark-run')).toBeEnabled();
  await page.locator('#benchmark-count').fill('1000');

  const question = page.locator('dialog.confirm-dialog');
  const replacements = [
    ['None', () => page.locator('#dataset-select').selectOption(NONE.select)],
    ['another dataset', () => page.locator('#dataset-select').selectOption(TRAJECTORY.select)],
    ['a synthetic run', () => page.locator('#benchmark-run').click()],
  ];
  for (const [what, replace] of replacements) {
    await test.step(`${what} asks first, and Cancel keeps the dataset shown`, async () => {
      await replace();
      await expect(question).toBeVisible();
      await expect(question.locator('.confirm-dialog-title')).toHaveText('Your work is not kept');
      await expect(question).toContainText('not kept: Autosave in this browser is off');
      await question.getByRole('button', { name: 'Cancel' }).click();
      await expect(question).toHaveCount(0);
      await expectSettledOn(page, START);
    });
  }

  await test.step('Open anyway lets the replacement go on', async () => {
    await page.locator('#dataset-select').selectOption(TRAJECTORY.select);
    await expect(question).toBeVisible();
    await question.getByRole('button', { name: 'Open anyway' }).click();
    await expectSettledOn(page, TRAJECTORY);
  });

  expect(productErrors).toEqual([]);
});
