/**
 * My datasets (Session › Open data; `app/library/my-datasets.js`,
 * `ui/modules/my-datasets/`): the datasets opened in this browser, kept in
 * its IndexedDB (`cellucid-library`), most recently opened first.
 *
 * - Samples chosen, links and a file of this computer are listed as they
 *   open (the startup's default sample is not: nobody chose it); the menu
 *   offers the five most recent, the one open now marked and not offered
 *   again, then All…, which lists every one with the facts behind it.
 * - One click opens each again: a sample, a link, and a file through its
 *   kept handle where Chromium gives one (the browser asks for leave to read
 *   it inside the click); elsewhere the click opens File… and says which
 *   file to choose.
 * - Continue opens a dataset with its latest saved state, at once: its
 *   history is back, nothing is offered.
 * - Forget asks first in its row, says what goes and what stays; its saved
 *   states stay unless ticked.
 * - A window that gives the site no IndexedDB keeps the list for the page
 *   only, one that keeps nothing for a later visit until it closes; each
 *   says so.
 * - Keyboard alone, a phone's width, both themes.
 */
import { closePageWithApplicationRetirement, expect, test } from './helpers/test.mjs';
import {
  DEVELOPMENT,
  H5AD,
  H5AD_PATH,
  START,
  TRAJECTORY,
  UNLISTED_OPTION,
  expectNoFailureAnnounced,
  expectSettledOn,
  openStarted,
} from './helpers/dataset-loading.mjs';
import { SAMPLE_ORIGIN, appUrl } from './helpers/origins.mjs';
import { answerPickers, pickWithFileItem } from './helpers/local-file-pickers.mjs';
import { openCollapsedPanels, openPhoneSheet } from './helpers/panels.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const H5AD_NAME = 'current-ui-smoke.h5ad';
const LINKS = Object.freeze({
  forms: Object.freeze({ url: `${SAMPLE_ORIGIN}/tests/browser/fixtures/forms-catalog/forms-h5ad.h5ad`, name: 'Forms — .h5ad', cells: 48, select: UNLISTED_OPTION }),
  currentUi: Object.freeze({ url: `${SAMPLE_ORIGIN}/tests/browser/fixtures/catalog/current-ui.h5ad`, name: 'Current UI fixture', cells: 120, select: UNLISTED_OPTION }),
  outliers: Object.freeze({ url: `${SAMPLE_ORIGIN}/tests/browser/fixtures/outliers-stored.h5ad`, name: 'Outliers stored', cells: 600, select: UNLISTED_OPTION }),
});

const button = page => page.locator('#my-datasets-btn');
const menu = page => page.locator('#my-datasets-menu');
const items = page => menu(page).locator('[role="menuitem"]');
const dialog = page => page.locator('#my-datasets-dialog');
const rows = page => page.locator('#my-datasets-list .library-row');
const row = (page, name) => rows(page).filter({ has: page.locator('.library-row-name', { hasText: name }) });

/** The list as the page keeps it: each dataset's name, most recently opened first. */
function listed(page) {
  return page.evaluate(async () => {
    const { listMyDatasets } = await import('/assets/js/app/library/my-datasets.js');
    return (await listMyDatasets()).map(entry => entry.name);
  });
}

/** Wait until the list names `names`, most recent first, and the menu has drawn it. */
async function expectListed(page, names) {
  await expect.poll(() => listed(page)).toEqual(names);
  await expect(button(page)).toBeVisible();
}

async function chooseSample(page, target) {
  await page.locator('#dataset-select').selectOption(target.select);
  await expectSettledOn(page, target);
}

async function openLink(page, target) {
  await page.locator('#data-address').fill(target.url);
  await page.locator('#data-address-open-btn').click();
  await expectSettledOn(page, target);
}

/** Open the menu and return the labels of its items. */
async function menuLabels(page) {
  if (await menu(page).isHidden()) await button(page).click();
  await expect(menu(page)).toBeVisible();
  return items(page).locator('.open-menu-item-label').allTextContents();
}

async function closeMenu(page) {
  if (await menu(page).isVisible()) {
    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
  }
}

async function chooseFromMenu(page, name) {
  if (await menu(page).isHidden()) await button(page).click();
  await items(page).filter({ has: page.locator('.open-menu-item-label', { hasText: name }) }).click();
}

async function openAll(page) {
  if (await menu(page).isHidden()) await button(page).click();
  await items(page).filter({ hasText: 'All…' }).click();
  await expect(dialog(page)).toBeVisible();
}

/** The dataset's saved states (`listSavedStates`): kind and steps. */
function savedStatesOf(page, datasetId) {
  return page.evaluate(async id => {
    const { listSavedStates } = await import('/assets/js/app/history/autosave.js');
    return (await listSavedStates()).filter(state => state.dataset.id === id).map(state => ({ id: state.id, kind: state.kind, steps: state.steps }));
  }, datasetId);
}

/** Colour by a categorical field not shown now and wait until the step is kept in this browser. */
async function takeAStep(page, datasetId) {
  // Its options name fields by index; '-1' is None.
  const field = await page.evaluate(() => {
    const select = document.getElementById('categorical-field');
    const option = [...select.options].find(candidate => candidate.value !== '-1' && candidate.value !== select.value);
    return option === undefined ? null : { value: option.value, key: option.textContent.replace(/ \*$/, '').trim() };
  });
  expect(field).not.toBeNull();
  await page.locator('#categorical-field').selectOption(field.value);
  await expect.poll(() => page.evaluate(() => window._cellucidState.getActiveField()?.key ?? null)).toBe(field.key);
  const key = field.key;
  await page.evaluate(() => window._cellucidHistories.current().reconcile());
  await expect.poll(async () => (await savedStatesOf(page, datasetId)).reduce((sum, state) => sum + state.steps, 0)).toBeGreaterThan(0);
  return key;
}

function offerCard(page) {
  return page.locator('#notification-center .notification').filter({ hasText: 'Continue where you left off?' });
}

test('datasets opened are listed most recent first; the menu offers five of seven; each opens again with one click; All… lists every one', async ({ page, browserName }) => {
  test.setTimeout(240_000);
  const handles = browserName === 'chromium';
  if (handles) await answerPickers(page, { name: H5AD_NAME, url: appUrl('/tests/browser/fixtures/current-ui-smoke.h5ad') });
  const errors = await openStarted(page);
  await openCollapsedPanels(page);
  // The start named by the address is listed (the person's link), as is every dataset opened after it.
  await expectListed(page, [START.name]);
  await chooseSample(page, TRAJECTORY);
  await chooseSample(page, DEVELOPMENT);
  await openLink(page, LINKS.forms);
  await openLink(page, LINKS.currentUi);
  await openLink(page, LINKS.outliers);
  if (handles) {
    await pickWithFileItem(page);
  } else {
    await page.locator('#user-data-open-btn').click();
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#user-data-file-item').click();
    await (await chooser).setFiles(H5AD_PATH);
  }
  await expectSettledOn(page, H5AD);
  const order = [H5AD.name, LINKS.outliers.name, LINKS.currentUi.name, LINKS.forms.name, DEVELOPMENT.name, TRAJECTORY.name, START.name];
  await expectListed(page, order);

  // The button names the dataset open now; the menu: the five most recent, then All….
  await expect(button(page)).toHaveText(H5AD.name);
  expect(await menuLabels(page)).toEqual([...order.slice(0, 5), 'All…']);
  await expect(items(page).first()).toHaveAttribute('aria-disabled', 'true');
  await expect(items(page).first().locator('.open-menu-item-hint')).toHaveText(handles ? 'File · open now' : 'File · choose it again');
  await expect(items(page).nth(1).locator('.open-menu-item-hint')).toHaveText(/^Link · 127\.0\.0\.1:\d+ · (just now|\d+ minutes? ago)$/);
  await expect(items(page).nth(4).locator('.open-menu-item-hint')).toHaveText(/^Sample · /);
  await expect(items(page).last().locator('.open-menu-item-hint')).toHaveText('7 datasets');
  // The one open now is not opened again (a click on it only closes the menu).
  await items(page).first().dispatchEvent('click');
  await expect(menu(page)).toBeHidden();
  await expectSettledOn(page, H5AD);

  // One click each: a sample, a link, the file.
  await chooseFromMenu(page, DEVELOPMENT.name);
  await expectSettledOn(page, DEVELOPMENT);
  await expectListed(page, [DEVELOPMENT.name, H5AD.name, LINKS.outliers.name, LINKS.currentUi.name, LINKS.forms.name, TRAJECTORY.name, START.name]);
  await chooseFromMenu(page, LINKS.forms.name);
  await expectSettledOn(page, LINKS.forms);
  await expect(page.locator('#data-address')).toHaveValue(LINKS.forms.url);
  if (handles) {
    await chooseFromMenu(page, H5AD.name);
    await expectSettledOn(page, H5AD);
    // Opened in this page, the file may be read without asking.
    expect(await page.evaluate(() => window.__reopenAsked)).toEqual([]);
  } else {
    // No handle in this browser: the click opens File… and says which file to choose.
    const chooser = page.waitForEvent('filechooser');
    await chooseFromMenu(page, H5AD.name);
    await (await chooser).setFiles(H5AD_PATH);
    await expect(page.locator('#notification-center')).toContainText(`Choose "${H5AD_NAME}" to open it again`);
    await expectSettledOn(page, H5AD);
  }

  // All…: every one, with the facts behind it.
  await openAll(page);
  await expect(rows(page)).toHaveCount(7);
  await expect(rows(page).locator('.library-row-name')).toHaveText([H5AD.name, LINKS.forms.name, DEVELOPMENT.name, LINKS.outliers.name, LINKS.currentUi.name, TRAJECTORY.name, START.name]);
  // The start has a saved state: opening the panels were its steps.
  await expect(page.locator('#my-datasets-dialog-status')).toHaveText('7 datasets, 1 with saved states, most recently opened first.');
  await expect(row(page, H5AD.name)).toHaveAttribute('data-current', 'true');
  await expect(row(page, H5AD.name).locator('[data-library-action="open"]')).toBeDisabled();
  const link = row(page, LINKS.currentUi.name);
  await expect(link.locator('.history-badge')).toHaveText('Link');
  await expect(link.locator('.library-row-meta')).toHaveText(/^h5ad file · 120 cells · [\d,]+ genes?$/);
  const toggle = link.locator('[data-library-action="details"]');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const facts = link.locator('.library-row-details dl');
  // What is stored of it (downloaded parts) follows, when this browser keeps any.
  expect((await facts.locator('dt').allTextContents()).slice(0, 10))
    .toEqual(['Source', 'Address', 'Opens', 'Format', 'Size', 'Cells', 'Genes', 'Last opened', 'First opened', 'Saved states']);
  await expect(facts.locator('dt:text-is("Address") + dd')).toHaveText(LINKS.currentUi.url);
  await expect(facts.locator('dt:text-is("Opens") + dd')).toHaveText('With one click');
  await expect(facts.locator('dt:text-is("Format") + dd')).toHaveText('AnnData, h5ad file');
  await expect(facts.locator('dt:text-is("Cells") + dd')).toHaveText('Every cell (120)');
  await expect(facts.locator('dt:text-is("Last opened") + dd')).toHaveText(/\(1 time in all\)$/);
  const sample = row(page, DEVELOPMENT.name);
  await sample.locator('[data-library-action="details"]').click();
  await expect(sample.locator('dt:text-is("Source") + dd')).toHaveText('Sample dataset');
  await expect(sample.locator('dt:text-is("Last opened") + dd')).toHaveText(/\(2 times in all\)$/);
  const file = row(page, H5AD.name);
  await file.locator('[data-library-action="details"]').click();
  await expect(file.locator('dt:text-is("Source") + dd')).toHaveText('File on this computer');
  await expect(file.locator('dt:text-is("Name") + dd')).toHaveText(H5AD_NAME);
  await expect(file.locator('dt:text-is("Opens") + dd')).toHaveText(handles
    ? 'With one click; the browser may ask to read it first'
    : 'Choose it again with File… in Session › Open data');
  // The filter narrows by name.
  await page.locator('#my-datasets-filter').fill('synthetic');
  await expect(rows(page)).toHaveCount(3);
  await expect(page.locator('#my-datasets-dialog-status')).toHaveText('3 of 7 datasets match "synthetic".');
  await page.locator('#my-datasets-filter').fill('');
  // A dataset past the menu's five opens from its row.
  await row(page, START.name).locator('[data-library-action="open"]').click();
  await expect(dialog(page)).toBeHidden();
  await expectSettledOn(page, START);
  await expectListed(page, [START.name, H5AD.name, LINKS.forms.name, DEVELOPMENT.name, LINKS.outliers.name, LINKS.currentUi.name, TRAJECTORY.name]);
  await expectNoFailureAnnounced(page);
  expect(errors).toEqual([]);
});

test('a file reopened after a reload: the click asks the browser for leave to read it, inside the click', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Only Chromium gives a page handles of the files it opens (the test above covers choosing it again)');
  await answerPickers(page, { name: H5AD_NAME, url: appUrl('/tests/browser/fixtures/current-ui-smoke.h5ad') });
  const errors = await openStarted(page);
  await pickWithFileItem(page);
  await expectSettledOn(page, H5AD);
  await expectListed(page, [H5AD.name, START.name]);
  await chooseSample(page, START);
  // A new browser session: leave to read the file is asked again.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expectSettledOn(page, START);
  await openCollapsedPanels(page);
  await chooseFromMenu(page, H5AD.name);
  await expectSettledOn(page, H5AD);
  expect(await page.evaluate(() => window.__reopenAsked)).toEqual([{ mode: 'read', inClick: true }]);
  await expectNoFailureAnnounced(page);
  expect(errors).toEqual([]);
});

test('Continue opens a dataset with its latest saved state at once: its history is back, nothing is offered', async ({ page }) => {
  const errors = await openStarted(page);
  await openCollapsedPanels(page);
  const key = await takeAStep(page, START.id);
  const steps = await page.evaluate(() => window._cellucidHistories.current().active.steps.size);
  const [kept] = (await savedStatesOf(page, START.id)).filter(state => state.kind === 'autosave');
  await chooseSample(page, TRAJECTORY);
  await expect(offerCard(page)).toHaveCount(0);

  await openAll(page);
  const start = row(page, START.name);
  await expect(start.locator('.library-row-meta')).toContainText('1 saved state');
  const resume = start.locator('[data-library-action="continue"]');
  await expect(resume).toBeEnabled();
  await expect(resume).toHaveAttribute('aria-label', /^Continue .+ where you left off: its latest saved state, \d+ steps? from /);
  // The dataset shown has no other saved state to continue into.
  await expect(row(page, TRAJECTORY.name).locator('[data-library-action="continue"]')).toBeDisabled();
  await resume.click();
  await expect(dialog(page)).toBeHidden();
  await expectSettledOn(page, START);
  await expect.poll(() => page.evaluate(() => window._cellucidState.getActiveField()?.key ?? null), { timeout: 60_000 }).toBe(key);
  await expect.poll(() => page.evaluate(() => window._cellucidHistories.current()?.active?.steps.size ?? 0)).toBe(steps);
  // Continued, not offered: and the same saved state is written into.
  await expect(offerCard(page)).toHaveCount(0);
  expect((await savedStatesOf(page, START.id)).filter(state => state.kind === 'autosave').map(state => state.id)).toEqual([kept.id]);
  await expectNoFailureAnnounced(page);
  expect(errors).toEqual([]);
});

test('Forget asks in its row and says what goes; saved states stay unless ticked', async ({ page }) => {
  const errors = await openStarted(page);
  await openCollapsedPanels(page);
  await chooseSample(page, TRAJECTORY);
  await takeAStep(page, TRAJECTORY.id);
  await chooseSample(page, START);
  await expectListed(page, [START.name, TRAJECTORY.name]);
  const before = await savedStatesOf(page, TRAJECTORY.id);
  expect(before.length).toBeGreaterThan(0);

  await openAll(page);
  const trajectory = row(page, TRAJECTORY.name);
  await trajectory.locator('[data-library-action="forget"]').click();
  const confirm = trajectory.locator('.library-row-confirm');
  await expect(confirm).toBeVisible();
  await expect(confirm.locator('.library-row-question')).toHaveText(`Forget ${TRAJECTORY.name}?`);
  await expect(confirm.locator('.field-help')).toHaveText('It leaves My datasets. Its saved states and stored data stay.');
  const also = confirm.locator('[data-library-also]');
  await expect(also).not.toBeChecked();
  await expect(confirm.locator('label')).toHaveText(new RegExp(`^Also delete its ${before.length} saved states? \\(`));
  // Keep: nothing changes, the focus is back on Forget.
  await expect(confirm.locator('[data-library-action="keep"]')).toBeFocused();
  await confirm.locator('[data-library-action="keep"]').click();
  await expect(confirm).toBeHidden();
  await expect(trajectory.locator('[data-library-action="forget"]')).toBeFocused();
  // Forget, unticked: off the list, its saved states kept.
  await trajectory.locator('[data-library-action="forget"]').click();
  await confirm.locator('[data-library-action="forget-confirmed"]').click();
  await expect(page.locator('#my-datasets-dialog-status')).toHaveText(`Forgot ${TRAJECTORY.name}.`);
  await expect(rows(page)).toHaveCount(1);
  expect(await savedStatesOf(page, TRAJECTORY.id)).toEqual(before);
  await expect.poll(() => listed(page)).toEqual([START.name]);
  await expect(dialog(page)).toBeVisible();
  expect(await page.evaluate(() => document.getElementById('my-datasets-dialog').contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');

  // Opened again, it is listed again; forgotten with its saved states ticked, they go too.
  await chooseSample(page, TRAJECTORY);
  await chooseSample(page, START);
  await expectListed(page, [START.name, TRAJECTORY.name]);
  await openAll(page);
  await row(page, TRAJECTORY.name).locator('[data-library-action="forget"]').click();
  await row(page, TRAJECTORY.name).locator('[data-library-also]').check();
  await row(page, TRAJECTORY.name).locator('[data-library-action="forget-confirmed"]').click();
  await expect(page.locator('#my-datasets-dialog-status')).toHaveText(new RegExp(`^Forgot ${TRAJECTORY.name}\\. Deleted \\d+ saved states?\\.$`));
  await expect.poll(() => savedStatesOf(page, TRAJECTORY.id)).toEqual([]);
  await expect.poll(() => listed(page)).toEqual([START.name]);
  await expectNoFailureAnnounced(page);
  expect(errors).toEqual([]);
});

test('the Stored dialog counts My datasets in one row, shows it in its own dialog, and Remove forgets the list', async ({ page }) => {
  const errors = await openStarted(page);
  await openCollapsedPanels(page);
  await chooseSample(page, TRAJECTORY);
  await expectListed(page, [TRAJECTORY.name, START.name]);
  // A saved state makes the Stored row show.
  await page.evaluate(() => window._cellucidHistories.savedStates.saveAs('Probe'));
  const manage = page.locator('#kept-stores-manage-btn');
  await expect(manage).toBeVisible();
  await manage.click();
  const library = page.locator('#kept-stores-dialog .kept-library');
  await expect(library.locator('.kept-dataset-name')).toHaveText('My datasets');
  await expect(library.locator('.kept-dataset-facts')).toHaveText('2 datasets opened in this browser');
  // Listed in its own dialog, never twice: no row of its datasets here.
  await expect(library.locator('[data-item-id]')).toHaveCount(0);
  await expect(page.locator('#kept-stores-dialog .kept-local-files')).toHaveCount(0);
  await library.getByRole('button', { name: 'Show My datasets' }).click();
  await expect(page.locator('#kept-stores-dialog')).toBeHidden();
  await expect(dialog(page)).toBeVisible();
  await expect(rows(page)).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await expect(manage).toBeFocused();
  await manage.click();
  await library.getByRole('button', { name: 'Forget every dataset of My datasets' }).click();
  await expect(page.locator('#kept-stores-status')).toHaveText('Forgot 2 datasets of My datasets.');
  await expect(library).toHaveCount(0);
  await expect.poll(() => listed(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(page.locator('#kept-stores-dialog')).toBeHidden();
  // Still shown, empty: its menu offers All… alone, for Import….
  await expect(page.locator('#my-datasets-block')).toBeVisible();
  expect(await menuLabels(page)).toEqual(['All…']);
  await closeMenu(page);
  expect(errors).toEqual([]);
});

test('a window that gives the site no IndexedDB keeps the list for this page; one that keeps nothing for later until it closes', async ({ page, context }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', { configurable: true, get: () => undefined });
  });
  const errors = await openStarted(page);
  await openCollapsedPanels(page);
  await chooseSample(page, TRAJECTORY);
  await expectListed(page, [TRAJECTORY.name, START.name]);
  await expect(page.locator('#my-datasets-status')).toHaveText('Kept for this page only: this window keeps nothing for this site.');
  expect(await menuLabels(page)).toEqual([TRAJECTORY.name, START.name, 'All…']);
  await closeMenu(page);
  await chooseFromMenu(page, START.name);
  await expectSettledOn(page, START);
  expect(errors).toEqual([]);

  // A private window: IndexedDB for this window, no storage for a later visit.
  const other = await context.newPage();
  await other.addInitScript(() => {
    const storage = navigator.storage;
    if (storage !== undefined) {
      Object.defineProperty(storage, 'getDirectory', { configurable: true, value: async () => { throw new DOMException('The operation is insecure.', 'SecurityError'); } });
    }
  });
  const otherErrors = await openStarted(other);
  await openCollapsedPanels(other);
  await expectListed(other, [START.name]);
  await expect(other.locator('#my-datasets-status')).toHaveText('Kept only until this window closes.');
  expect(otherErrors).toEqual([]);
  await closePageWithApplicationRetirement(other);
});

test('keyboard alone: the menu opens, moves and chooses; All… opens, its rows open their facts; Escape gives the focus back', async ({ page, browserName }) => {
  // WebKit's Tab skips buttons unless Option is held (Safari's own setting).
  const tab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
  const errors = await openStarted(page);
  await openCollapsedPanels(page);
  await chooseSample(page, TRAJECTORY);
  await expectListed(page, [TRAJECTORY.name, START.name]);
  await button(page).focus();
  await page.keyboard.press('ArrowDown');
  await expect(menu(page)).toBeVisible();
  await expect(items(page).first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(items(page).nth(1)).toBeFocused();
  await expect(items(page).nth(1)).toContainText(START.name);
  await page.keyboard.press('Enter');
  await expect(menu(page)).toBeHidden();
  await expect(button(page)).toBeFocused();
  await expectSettledOn(page, START);

  await button(page).focus();
  await page.keyboard.press('ArrowUp');
  await expect(items(page).last()).toBeFocused();
  await expect(items(page).last()).toContainText('All…');
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toBeVisible();
  // The rows are drawn from what this browser keeps, after the dialog opens.
  await expect(rows(page)).toHaveCount(2);
  // Tab reaches the filter, Export… and Import…, then each row's name, Open, Continue and Forget.
  await page.locator('#my-datasets-filter').focus();
  await page.keyboard.press(tab);
  await expect(page.locator('#my-datasets-export-btn')).toBeFocused();
  await page.keyboard.press(tab);
  await expect(page.locator('#my-datasets-import-btn')).toBeFocused();
  await page.keyboard.press(tab);
  const first = rows(page).first().locator('[data-library-action="details"]');
  await expect(first).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(first).toHaveAttribute('aria-expanded', 'true');
  await expect(rows(page).first().locator('.library-row-details')).toBeVisible();
  // Then its first action the person can take (the open dataset's Open is not one).
  await page.keyboard.press(tab);
  await expect.poll(() => page.evaluate(() => {
    const active = document.activeElement;
    return active?.closest('.library-row') === document.querySelector('#my-datasets-list .library-row') ? active.dataset.libraryAction : null;
  })).toMatch(/^(continue|forget)$/);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await expect(button(page)).toBeFocused();
  expect(errors).toEqual([]);
});

for (const theme of ['light', 'dark']) {
  test(`at a phone's width, in the ${theme} theme: All… fits, its rows read, nothing scrolls sideways`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(chosen => {
      try {
        localStorage.setItem('cellucid_theme', chosen);
      } catch {
        // The theme the page starts with.
      }
    }, theme);
    const errors = await openStarted(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await openPhoneSheet(page);
    await openCollapsedPanels(page);
    await chooseSample(page, TRAJECTORY);
    await expectListed(page, [TRAJECTORY.name, START.name]);
    await button(page).scrollIntoViewIfNeeded();
    expect(await menuLabels(page)).toEqual([TRAJECTORY.name, START.name, 'All…']);
    const menuBox = await menu(page).boundingBox();
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(390);
    await items(page).last().click();
    await expect(dialog(page)).toBeVisible();
    const box = await dialog(page).boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    // Nothing scrolls sideways, and two rows need no scrolling at all: every row is whole.
    await expect.poll(() => page.evaluate(() => {
      const element = document.getElementById('my-datasets-dialog');
      const list = document.getElementById('my-datasets-list');
      return {
        sideways: element.scrollWidth - element.clientWidth,
        dialog: element.scrollHeight - element.clientHeight,
        list: list.scrollHeight - list.clientHeight,
      };
    })).toEqual({ sideways: 0, dialog: 0, list: 0 });
    // A phone's row: the actions under the name, inside the row.
    const first = rows(page).first();
    const toggle = await first.locator('.library-row-toggle').boundingBox();
    const actions = await first.locator('.library-row-actions').boundingBox();
    expect(actions.y).toBeGreaterThanOrEqual(toggle.y + toggle.height - 1);
    expect(actions.x + actions.width).toBeLessThanOrEqual(box.x + box.width);
    // The theme's own colours, from its tokens.
    const colours = await page.evaluate(() => {
      const probe = document.createElement('div');
      document.body.append(probe);
      const resolve = token => {
        probe.style.color = `var(${token})`;
        return getComputedStyle(probe).color;
      };
      const name = document.querySelector('#my-datasets-list .library-row-name');
      const rowElement = document.querySelector('#my-datasets-list .library-row');
      const out = {
        text: getComputedStyle(name).color,
        textToken: resolve('--color-text-primary'),
        surface: getComputedStyle(rowElement).backgroundColor,
        surfaceToken: resolve('--color-surface-elevated'),
      };
      probe.remove();
      return out;
    });
    expect(colours.text).toBe(colours.textToken);
    expect(colours.surface).toBe(colours.surfaceToken);
    expect(colours.text).not.toBe(colours.surface);
    expect(errors).toEqual([]);
  });
}
