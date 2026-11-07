/**
 * My datasets › All… › Export… and Import… (`app/library/library-file.js`,
 * `ui/modules/my-datasets/dialog.js`): the datasets and saved states ticked
 * go into one `.cellucid-library` file; another browser (a fresh context,
 * its own IndexedDB) imports it beside what it keeps.
 *
 * - Export… shows every dataset ticked with its saved states under it, says
 *   that conversations go too, and downloads the file.
 * - Import… adds the datasets that browser does not list (one it lists
 *   stays), keeps each saved state as "<name> (imported)", and says what was
 *   added and what was already there; Continue opens an imported history.
 * - A file that is not a library file is refused in the status line, and
 *   nothing is added.
 * - Dropped on the page, a library file is imported in All… the same way; a
 *   session file is refused saying what it is and where it goes.
 */
import { closeContextWithApplicationRetirement, expect, test } from './helpers/test.mjs';
import { expectDownloadNamed } from './helpers/downloads.mjs';
import {
  START, TRAJECTORY, expectAnnouncedOnce, expectNoFailureAnnounced, expectSettledOn, openStarted,
} from './helpers/dataset-loading.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { createDrag, dragAndDrop, filePayload } from './helpers/dataset-drop.mjs';

const button = page => page.locator('#my-datasets-btn');
const menu = page => page.locator('#my-datasets-menu');
const dialog = page => page.locator('#my-datasets-dialog');
const status = page => page.locator('#my-datasets-dialog-status');
const exportPanel = page => page.locator('#my-datasets-export');
const row = (page, name) => page.locator('#my-datasets-list .library-row').filter({ has: page.locator('.library-row-name', { hasText: name }) });

function listed(page) {
  return page.evaluate(async () => {
    const { listMyDatasets } = await import('/assets/js/app/library/my-datasets.js');
    return (await listMyDatasets()).map(entry => entry.name);
  });
}

function savedStates(page) {
  return page.evaluate(async () => {
    const { listSavedStates } = await import('/assets/js/app/history/autosave.js');
    return (await listSavedStates()).map(state => ({ id: state.id, kind: state.kind, name: state.name, dataset: state.dataset.id, steps: state.steps }));
  });
}

async function chooseSample(page, target) {
  await page.locator('#dataset-select').selectOption(target.select);
  await expectSettledOn(page, target);
}

async function openAll(page) {
  if (await menu(page).isHidden()) await button(page).click();
  await menu(page).locator('[role="menuitem"]').filter({ hasText: 'All…' }).click();
  await expect(dialog(page)).toBeVisible();
}

/** Colour by a categorical field not shown now, and wait until the step is kept in this browser. */
async function takeAStep(page, datasetId) {
  const field = await page.evaluate(() => {
    const select = document.getElementById('categorical-field');
    const option = [...select.options].find(candidate => candidate.value !== '-1' && candidate.value !== select.value);
    return option === undefined ? null : { value: option.value, key: option.textContent.replace(/ \*$/, '').trim() };
  });
  expect(field).not.toBeNull();
  await page.locator('#categorical-field').selectOption(field.value);
  await expect.poll(() => page.evaluate(() => window._cellucidState.getActiveField()?.key ?? null)).toBe(field.key);
  await page.evaluate(() => window._cellucidHistories.current().reconcile());
  await expect.poll(async () => (await savedStates(page)).filter(state => state.dataset === datasetId).reduce((sum, state) => sum + state.steps, 0)).toBeGreaterThan(0);
  return field.key;
}

test('Export… writes the datasets and saved states ticked; Import… in another browser adds them beside what it keeps', async ({ page, browser }, testInfo) => {
  test.setTimeout(240_000);
  const errors = await openStarted(page);
  await openCollapsedPanels(page);
  await chooseSample(page, TRAJECTORY);
  const key = await takeAStep(page, TRAJECTORY.id);
  await page.evaluate(() => window._cellucidHistories.savedStates.saveAs('Figure 2'));
  await expect.poll(async () => (await savedStates(page)).filter(state => state.dataset === TRAJECTORY.id).length).toBe(2);
  await expect.poll(() => listed(page)).toEqual([TRAJECTORY.name, START.name]);
  // Every saved state of this browser: the trajectory's two, and the start's autosave when its panels opening made steps there.
  const kept = (await savedStates(page)).length;
  const plural = count => `${count} saved state${count === 1 ? '' : 's'}`;

  await openAll(page);
  const exportButton = page.locator('#my-datasets-export-btn');
  await exportButton.click();
  await expect(exportButton).toHaveAttribute('aria-expanded', 'true');
  await expect(exportPanel(page)).toBeVisible();
  await expect(page.locator('#my-datasets-list')).toBeHidden();
  await expect(exportPanel(page).locator('.field-help').first()).toContainText('conversations with agents');
  // Every dataset ticked, with its saved states under it.
  await expect(exportPanel(page).locator('[data-export-dataset]')).toHaveCount(2);
  await expect(exportPanel(page).locator('[data-export-state]')).toHaveCount(kept);
  for (const box of await exportPanel(page).locator('input[type="checkbox"]').all()) await expect(box).toBeChecked();
  await expect(exportPanel(page).locator('[data-export-summary]')).toHaveText(new RegExp(`^2 datasets and ${plural(kept)} \\(.+ kept here\\)\\.$`));
  // Unticking a dataset unticks its saved states; ticking it again ticks them.
  const trajectoryBox = exportPanel(page).locator(`[data-export-dataset]`).nth(0);
  await trajectoryBox.uncheck();
  await expect(exportPanel(page).locator('[data-export-state]:checked')).toHaveCount(kept - 2);
  // The size is said only with saved states ticked.
  await expect(exportPanel(page).locator('[data-export-summary]')).toHaveText(kept === 2 ? '1 dataset and 0 saved states.' : new RegExp(`^1 dataset and ${plural(kept - 2)} \\(.+ kept here\\)\\.$`));
  await trajectoryBox.check();
  await expect(exportPanel(page).locator('[data-export-state]:checked')).toHaveCount(kept);

  const download = page.waitForEvent('download');
  await exportPanel(page).locator('[data-export-action="confirm"]').click();
  const file = await download;
  expect(await file.failure()).toBeNull();
  await expectDownloadNamed(file, /^cellucid-library-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.cellucid-library$/);
  const path = testInfo.outputPath('my.cellucid-library');
  await file.saveAs(path);
  await expect(status(page)).toHaveText(`Exported 2 datasets and ${plural(kept)}.`);
  await expect(exportPanel(page)).toBeHidden();
  await expect(page.locator('#my-datasets-list')).toBeVisible();
  await expect(exportButton).toBeFocused();
  expect(errors).toEqual([]);

  // Another browser: its own IndexedDB; it lists the start (the address it opened) and keeps its own history.
  const context = await browser.newContext();
  const other = await context.newPage();
  const otherErrors = await openStarted(other);
  await openCollapsedPanels(other);
  await expect.poll(() => listed(other)).toEqual([START.name]);
  const before = await savedStates(other);

  // Not a library file: refused, nothing added.
  await openAll(other);
  const chooser = other.waitForEvent('filechooser');
  await other.locator('#my-datasets-import-btn').click();
  await (await chooser).setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a library file at all') });
  await expect(status(other)).toHaveText('notes.txt was not imported: This file is not a Cellucid library file of format 1 (it does not start with CELLUCID_LIBRARY/1).');
  await expect(status(other)).toHaveAttribute('data-tone', 'danger');
  expect(await listed(other)).toEqual([START.name]);

  const picked = other.waitForEvent('filechooser');
  await other.locator('#my-datasets-import-btn').click();
  await (await picked).setFiles(path);
  await expect(status(other)).toHaveText(`Added 1 dataset and ${plural(kept)}; 1 dataset was already in My datasets.`);
  await expect(other.locator('#my-datasets-import-btn')).toBeFocused();
  await other.keyboard.press('Escape');
  await expect(dialog(other)).toBeHidden();

  // Dropped on the page, the library file is imported in All… the same way.
  await dragAndDrop(other, await createDrag(other, { files: [await filePayload(path, 'my.cellucid-library')] }));
  await expect(dialog(other)).toBeVisible();
  await expect(status(other)).toHaveText(`Added ${plural(kept)}; 2 datasets were already in My datasets.`);
  await expect.poll(async () => (await listed(other)).sort()).toEqual([START.name, TRAJECTORY.name].sort());
  const after = await savedStates(other);
  for (const mine of before) expect(after).toContainEqual(mine);
  expect(after.filter(state => state.dataset === TRAJECTORY.id).map(state => `${state.kind}:${state.name}`).sort()).toEqual([
    'named:Autosave of Synthetic trajectory — 1D (imported)', 'named:Autosave of Synthetic trajectory — 1D (imported)',
    'named:Figure 2 (imported)', 'named:Figure 2 (imported)',
  ]);

  // Continue opens the dataset with an imported history: the field the step coloured by is back.
  const resume = row(other, TRAJECTORY.name).locator('[data-library-action="continue"]');
  await expect(resume).toBeEnabled();
  await resume.click();
  await expect(dialog(other)).toBeHidden();
  await expectSettledOn(other, TRAJECTORY);
  await expect.poll(() => other.evaluate(() => window._cellucidState.getActiveField()?.key ?? null), { timeout: 60_000 }).toBe(key);
  await expectNoFailureAnnounced(other);
  expect(otherErrors).toEqual([]);

  // A session file dropped is no dataset: refused, saying what it is and where it goes.
  const sessionSaid = await other.evaluate(async () => {
    const { cellucidFileOfName } = await import('/assets/js/data/input-formats.js');
    return cellucidFileOfName('x.cellucid-session').said;
  });
  await dragAndDrop(other, await createDrag(other, { files: [{ name: 'work.cellucid-session', base64: Buffer.from('CELLUCID_SESSION/4\n').toString('base64') }] }));
  await expectAnnouncedOnce(other, new RegExp(sessionSaid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await expect(dialog(other)).toBeHidden();
  await closeContextWithApplicationRetirement(context);
});
