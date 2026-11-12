/**
 * The State panel on the page's own history (History v2 core) with the
 * page's own actions (`helpers/state-history.mjs`): steps as rows, Undo and
 * Redo from the buttons, a branch made by acting after going back (the stub
 * where the steps left part, the undone ones kept), a group from a
 * Shift-selection and Ctrl/⌘+G, the recording paused and resumed with the
 * Keep / Discard / Cancel card before going back, and the branch picker.
 * Every state change is the page's own; every history operation is the
 * panel's dispatch of a `history.*` action. A stale step offers Run again
 * only when its action brings the result up to date (`rerun`): a highlight
 * then takes the cells the view shows now, and is no longer stale.
 */
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openPhoneSheet } from './helpers/panels.mjs';
import { takeSteps, turnedCamera, waitForHistory } from './helpers/state-history.mjs';

const DATASET_URL = `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=history-panel`;
const CELL_TYPE = Object.freeze({ source: 'obs', key: 'cell_type' });
const SCORE = Object.freeze({ source: 'obs', key: 'score' });
const hide = categories => ['filter.category.visibility', { field: CELL_TYPE, categories, visible: false }];
const show = categories => ['filter.category.visibility', { field: CELL_TYPE, categories, visible: true }];

function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  return errors;
}

async function open(page) {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openPhoneSheet(page);
  await waitForHistory(page);
  await page.locator('#state-section').evaluate(section => { section.open = true; });
  await page.locator('#history-block').scrollIntoViewIfNeeded();
}

/** The tracker in use as plain facts. */
function facts(page) {
  return page.evaluate(async () => {
    const history = window._cellucidHistories.current();
    await history.idle();
    const t = history.active;
    return { head: t.headId, steps: t.steps.size, branches: t.branches.size, groups: t.groups.size, active: t.activeBranch, paused: t.paused !== null };
  });
}

const labels = page => page.locator('#history-graph .hg-label').allTextContents();
const row = (page, label) => page.locator('#history-graph .hg-row', { has: page.locator('.hg-label', { hasText: new RegExp(`^${label}$`) }) });

test('steps, undo and redo, a branch made by acting after going back, a group, the recording paused and resumed', async ({ page }) => {
  const errors = observeProductErrors(page);
  await open(page);
  await expect(page.locator('#history-status')).toContainText('Every change you make appears here');
  // The fixture opens colored by cell_type (its first coloring, part of "Opened"): color by score is a step.
  await expect(page.locator('#categorical-field option:checked')).toHaveText('cell_type');
  await takeSteps(page, [['color.by', { field: SCORE }], hide(['alpha']), hide(['beta']), hide(['gamma'])]);
  await expect.poll(() => labels(page)).toEqual(['Opened', 'Colored by score', 'Hid alpha of cell_type', 'Hid beta of cell_type', 'Hid gamma of cell_type']);
  await expect(page.locator('#history-status')).toHaveText('4 steps');

  await page.locator('#history-undo-btn').click();
  await expect.poll(async () => (await facts(page)).head).toBe('s3');
  await expect(page.locator('#history-status')).toHaveText('4 steps · 1 undone');
  await page.locator('#history-redo-btn').click();
  await expect.poll(async () => (await facts(page)).head).toBe('s4');

  // A click selects; a double-click shows; acting there starts a branch, and Main stays as a stub.
  await row(page, 'Hid alpha of cell_type').click();
  expect((await facts(page)).head).toBe('s4');
  await row(page, 'Hid alpha of cell_type').locator('.hg-line').dblclick();
  await expect.poll(async () => (await facts(page)).head).toBe('s2');
  await takeSteps(page, [hide(['gamma'])]);
  await expect.poll(async () => (await facts(page)).branches).toBe(2);
  await expect(page.locator('#history-graph .hg-row[data-kind="fork"]')).toHaveCount(1);
  await expect(page.locator('#history-graph .hg-row[data-kind="fork"] .hg-label')).toHaveText('Main');
  await expect(page.locator('#history-branch-btn')).toContainText('Branch 1');

  // Group the first two steps: Shift+click, then Ctrl/⌘+G.
  await row(page, 'Colored by score').click();
  await row(page, 'Hid alpha of cell_type').click({ modifiers: ['Shift'] });
  await page.keyboard.press('ControlOrMeta+g');
  await page.locator('dialog.confirm-dialog .confirm-dialog-textarea').fill('QC');
  await page.locator('dialog.confirm-dialog').getByRole('button', { name: 'Group', exact: true }).click();
  await expect.poll(async () => (await facts(page)).groups).toBe(1);
  await expect(row(page, 'QC')).toHaveAttribute('data-kind', 'group');

  // Paused: a change applies without a step; going back asks first; Keep makes it one step.
  await page.locator('#history-recording').click();
  await expect.poll(async () => (await facts(page)).paused).toBe(true);
  const before = await facts(page);
  await takeSteps(page, [show(['alpha'])]);
  expect((await facts(page)).steps).toBe(before.steps);
  await page.locator('#history-undo-btn').click();
  const ask = page.locator('dialog.confirm-dialog');
  await expect(page.locator('.confirm-dialog-title')).toHaveText('Keep your changes first?');
  await ask.getByRole('button', { name: 'Keep and go' }).click();
  await expect.poll(async () => (await facts(page)).steps).toBe(before.steps + 1);
  await page.locator('#history-recording').click();
  await expect.poll(async () => (await facts(page)).paused).toBe(false);
  await expect(page.locator('#history-graph .hg-label', { hasText: /^While paused: / })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('a stale step: Run again brings a highlight up to date; a keyframe holds the camera it captured and is never stale', async ({ page }) => {
  const errors = observeProductErrors(page);
  await open(page);
  const cellsOfGroup = () => page.evaluate(() => window._cellucidState.getActivePage().highlightedGroups.map(group => group.cellCount));
  await takeSteps(page, [['highlight.range', { field: SCORE, min: -1e9, max: 1e9 }], ['camera-path.keyframe.add', {}]]);
  const [all] = await cellsOfGroup();
  await takeSteps(page, [hide(['alpha']), ['camera.set', await turnedCamera(page, 30)]]);

  const keyframe = page.locator('#history-graph .hg-row', { has: page.locator('.hg-label', { hasText: /^Saved camera path keyframe/ }) });
  await keyframe.locator('.hg-details-btn').click();
  // A keyframe holds the camera it captured (`captures: ['camera']`): the
  // camera moving on after it makes it no older (owner, 2026-11-10, F57).
  await expect(keyframe.locator('.hg-details')).toBeVisible();
  await expect(keyframe.locator('.history-detail-warning')).toHaveCount(0);
  await expect(keyframe.getByRole('button', { name: 'Run again' })).toHaveCount(0);
  const highlight = page.locator('#history-graph .hg-row', { has: page.locator('.hg-label', { hasText: /^Highlighted score from/ }) });
  await highlight.locator('.hg-details-btn').click();
  // Each reason names its own input and the step that changed it (F156).
  await expect(highlight.locator('.history-detail-warning')).toContainText(/Stale: Filters changed at step \d+ \(“Hid alpha of cell_type”\)\./);
  // The details sit inside the list: every action is quiet (no pill, no
  // filled button), one line each, at the details' own text size (F98).
  const detailButtons = await highlight.locator('.hg-details button').evaluateAll(buttons => buttons.map(button => {
    const style = getComputedStyle(button);
    return {
      text: button.textContent.trim(),
      quiet: button.classList.contains('btn-quiet'),
      filled: button.classList.contains('btn-primary'),
      oneLine: button.getBoundingClientRect().height <= parseFloat(style.lineHeight) * 1.5 + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + 2,
      sameSize: style.fontSize === getComputedStyle(button.closest('.hg-details')).fontSize,
    };
  }));
  expect(detailButtons.length).toBeGreaterThan(3);
  for (const each of detailButtons) expect(each, each.text).toEqual({ ...each, quiet: true, filled: false, oneLine: true, sameSize: true });
  expect(detailButtons.map(each => each.text)).toContain('More…');
  expect(detailButtons.map(each => each.text)).toContain('Add note');

  const steps = (await facts(page)).steps;
  await highlight.getByRole('button', { name: 'Run again' }).click();
  await expect.poll(async () => (await facts(page)).steps).toBe(steps + 1);
  const [now] = await cellsOfGroup();
  expect(now, 'the group holds the cells the view shows now').toBeLessThan(all);
  expect(await cellsOfGroup(), 'one group, brought up to date in its place').toHaveLength(1);
  await expect(page.locator('#history-graph .hg-label', { hasText: /^Updated the cells of score from/ })).toHaveCount(1);
  const stale = await page.evaluate(() => window._cellucidHistories.current().stale().map(entry => entry.step.label));
  expect(stale, 'nothing is stale: the highlight is brought up to date, the keyframe never was').toEqual([]);
  expect(errors).toEqual([]);
});

test('the History ⋯ menu shows whole above the page, wherever its section ends, and goes back in place when it closes', async ({ page }) => {
  const errors = observeProductErrors(page);
  await open(page);
  // A step (the fixture opens colored by cell_type, so coloring by it again would be none).
  await takeSteps(page, [['color.by', { field: SCORE }]]);
  const button = page.locator('#history-menu-btn');
  await expect(button).toBeEnabled();
  // The section's last row at the bottom of the sidebar: a menu inside it would overflow the section.
  await page.locator('#state-section').evaluate(section => section.scrollIntoView({ block: 'end' }));
  await button.click();
  const menu = page.locator('#history-menu');
  await expect(menu).toBeVisible();
  const items = menu.getByRole('menuitem');
  const count = await items.count();
  expect(count).toBeGreaterThan(3);
  for (let index = 0; index < count; index++) {
    const item = items.nth(index);
    if (!await item.isVisible()) continue;
    // What a press at the item's center reaches is the item: nothing clips or covers it.
    const reached = await item.evaluate(element => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return element.contains(hit) && box.bottom <= window.innerHeight && box.top >= 0;
    });
    expect(reached, `${await item.textContent()} is shown whole`).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(button).toBeFocused();
  expect(await menu.evaluate(element => element.parentElement?.classList.contains('history-menu')), 'back in place').toBe(true);
  // Opened from the keyboard: a scroll event that did not move the button (as
  // the one of focusing it, told a frame later) leaves it open; a scroll that
  // moves the button closes it.
  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  // The sidebar's scroller: the nearest box holding the button that scrolls (its section is at the bottom).
  const scroller = await button.evaluateHandle(element => {
    for (let node = element.parentElement; node !== null; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollTop > 0) return node;
    }
    return null;
  });
  expect(await scroller.evaluate(node => node !== null), 'the sidebar is scrolled').toBe(true);
  await scroller.evaluate(node => node.dispatchEvent(new Event('scroll')));
  await expect(menu).toBeVisible();
  await scroller.evaluate(node => { node.scrollTop -= 40; });
  await expect(menu).toBeHidden();
  expect(errors).toEqual([]);
});

test('a group says where the step shown is inside it; search by the part changed and the day; the (i) tip opens History settings', async ({ page }) => {
  const errors = observeProductErrors(page);
  await open(page);
  // The fixture opens colored by cell_type: score first, then back to cell_type, are both steps.
  await takeSteps(page, [['color.by', { field: SCORE }], hide(['alpha']), hide(['beta']), ['color.by', { field: CELL_TYPE }]]);
  // Group the three first steps, then show the second of them: the collapsed group says "at 2 of 3".
  await row(page, 'Colored by score').click();
  await row(page, 'Hid beta of cell_type').click({ modifiers: ['Shift'] });
  await page.keyboard.press('ControlOrMeta+g');
  await page.locator('dialog.confirm-dialog .confirm-dialog-textarea').fill('QC');
  await page.locator('dialog.confirm-dialog').getByRole('button', { name: 'Group', exact: true }).click();
  await expect(row(page, 'QC')).toHaveAttribute('data-kind', 'group');
  await expect(row(page, 'QC').locator('.hg-meta')).toHaveText('3 steps');
  await page.evaluate(() => window._cellucidHistories.current().jump('s2'));
  await expect(row(page, 'QC').locator('.hg-meta')).toHaveText('at 2 of 3');

  // Filter › Part changed… lists the parts the steps changed; Day… the days they were taken.
  await page.locator('#history-search-btn').click();
  await page.locator('#history-filter-btn').click();
  await page.getByRole('menuitem', { name: /^Part changed…/ }).click();
  const parts = page.getByRole('menu', { name: 'Steps that changed' });
  await expect(parts).toBeVisible();
  await parts.getByRole('menuitemcheckbox', { name: /^Filters/ }).click();
  await expect(page.locator('#history-status')).toHaveText('2 of 4 steps');
  await expect(page.locator('#history-filter-btn')).toHaveText('Filter · 1');
  await page.locator('#history-filter-btn').click();
  await page.getByRole('menuitem', { name: /^Day…/ }).click();
  await page.getByRole('menu', { name: 'Steps taken on' }).getByRole('menuitemcheckbox', { name: /^Today/ }).click();
  await expect(page.locator('#history-status')).toHaveText('2 of 4 steps');
  await expect(page.locator('#history-filter-btn')).toHaveText('Filter · 2');
  await page.locator('#history-search-input').press('Escape');
  await expect(page.locator('#history-status')).not.toContainText(' of ');

  // The History (i) tip links to History settings, so they are found without ⚙.
  await page.locator('#history-info-btn').click();
  const tip = page.locator('#history-info-tooltip');
  await expect(tip).toBeVisible();
  await tip.getByRole('button', { name: 'History settings…' }).click();
  await expect(tip).toBeHidden();
  await expect(page.locator('#history-settings')).toBeVisible();
  await expect(page.locator('#history-settings-btn')).toHaveAttribute('aria-expanded', 'true');
  expect(errors).toEqual([]);
});

test('Show this step’s view puts the camera back where the step kept it, even while camera moves are not recorded', async ({ page }) => {
  const errors = observeProductErrors(page);
  await page.addInitScript(() => {
    try { localStorage.setItem('cellucid:history-settings', JSON.stringify({ recordCamera: false })); } catch { /* none kept */ }
  });
  await open(page);
  // A step (the fixture opens colored by cell_type, so coloring by it again would be none).
  await takeSteps(page, [['color.by', { field: SCORE }]]);
  const kept = await page.evaluate(() => window._cellucidViewer.getViewCameraState('live'));
  // The camera moves (not recorded), then a step: that step keeps the moved camera; the first keeps the first.
  await takeSteps(page, [['camera.set', await turnedCamera(page, 40)]]);
  await takeSteps(page, [hide(['alpha'])]);
  const steps = (await facts(page)).steps;
  const first = row(page, 'Colored by score');
  await first.locator('.hg-details-btn').click();
  await first.getByRole('button', { name: 'Show this step’s view' }).click();
  await expect.poll(() => page.evaluate(() => window._cellucidViewer.getViewCameraState('live').orbit.theta)).toBeCloseTo(kept.orbit.theta, 6);
  // The history did not move, and no step was made (camera moves are not recorded).
  expect(await facts(page)).toMatchObject({ steps, head: `s${steps - 1}` });
  expect(errors).toEqual([]);
});

test('memory: once the history passes what the device has room for, the status line names the largest parts, with a way to act', async ({ page }) => {
  const errors = observeProductErrors(page);
  await open(page);
  await takeSteps(page, [['highlight.category', { field: CELL_TYPE, categories: ['gamma'] }], ['color.by', { field: SCORE }]]);
  const chip = page.locator('#history-memory-btn');
  await expect(chip).toBeHidden();
  // Something else takes all the room (as a very large dataset would): the history is now past what is left for it.
  await page.evaluate(async () => {
    const { memoryAllowanceBytes, setWorkingSet } = await import('/assets/js/data/memory-budget.js');
    setWorkingSet('spec', memoryAllowanceBytes());
  });
  await expect(chip).toBeVisible();
  await expect(chip).toHaveText(/^⚠ \d/);
  await expect(page.locator('.notification', { hasText: 'The history keeps' })).toContainText('Largest: Highlights at step 1');
  await chip.click();
  const dialog = page.locator('#history-memory-dialog');
  await expect(dialog).toBeVisible();
  const first = dialog.locator('.history-memory-item').first();
  await expect(first.locator('.history-memory-part')).toHaveText('Highlights at step 1');
  await first.getByRole('button', { name: /^Show step 1/ }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#history-graph .hg-details')).toHaveCount(1);
  // Room again: the warning goes.
  await page.evaluate(async () => {
    const { setWorkingSet } = await import('/assets/js/data/memory-budget.js');
    setWorkingSet('spec', 0);
  });
  await expect(chip).toBeHidden();
  expect(errors).toEqual([]);
});
