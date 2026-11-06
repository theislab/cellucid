/**
 * The State panel's branch graph on a real page (History v2 §3.9, §3.10,
 * §6 test 7): rows match the tree exactly (labels, glyphs, stubs at their
 * fork steps, the undone tail after branching); the owner's row rule (a
 * click selects, a double-click shows, `›` opens the details, ▸ expands);
 * the tree's keys; exact accessible names and levels; nothing truncates at
 * desktop and phone widths; 2 000 steps keep the drawn rows bounded and End
 * reaches the last; a scrolling list keeps its Details buttons clear of the
 * overlay scrollbar's strip; Shift-selection, Group and Merge into one step through
 * their questions; Recently deleted restores; the paused marker and the
 * Keep / Discard / Cancel card; the branch delete confirmation's words.
 *
 * The history is History v2's records, acted on by the history actions
 * (`helpers/history-v2-fake.mjs` provides them on the page's dispatcher, so
 * every operation is the panel's dispatch of a catalogue action).
 */
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openPhoneSheet } from './helpers/panels.mjs';
import { waitForHistory } from './helpers/state-history.mjs';

const DATASET_URL = `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=history-graph`;

function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  return errors;
}

/** Open the page, put the History v2 scene `scene` in it (`helpers/history-v2-scenes.mjs`), and show the panel. */
async function openWith(page, scene) {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openPhoneSheet(page);
  await waitForHistory(page);
  await page.evaluate(async name => {
    const { installScene } = await import('/tests/helpers/history-v2-scenes.mjs');
    await installScene(name);
  }, scene);
  await page.locator('#state-section').evaluate(section => { section.open = true; });
  await page.locator('#history-graph').scrollIntoViewIfNeeded();
  await expect(page.locator('#history-graph .hg-row').first()).toBeVisible();
}

const FORKED = 'forked';

const rows = page => page.locator('#history-graph .hg-row');
const row = (page, label) => page.locator('#history-graph .hg-row', { has: page.locator('.hg-label', { hasText: new RegExp(`^${label}$`) }) });
const head = page => page.evaluate(() => globalThis.__fakeHistory.active.headId);

async function rowFacts(page) {
  return rows(page).evaluateAll(list => list
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
    .map(el => [el.dataset.kind, el.querySelector('.hg-label').textContent, el.querySelector('.hg-node').textContent, el.getAttribute('aria-level')]));
}

test('rows match the tree: the path, the stub where Main parts, the undone tail; ▸ opens the stub on its lane', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openWith(page, FORKED);
  expect(await rowFacts(page)).toEqual([
    ['step', 'Opened', '●', '1'],
    ['step', 'Coloured by cell_type', '●', '1'],
    ['step', 'Hid alpha of cell_type', '●', '1'],
    ['fork', 'Main', '⑂', '1'],
    ['step', 'Kept a view', '◉', '1'],
    ['step', 'Renamed 0 to T cells', '○', '1'],
  ]);
  await expect(page.locator('#history-status')).toHaveText('4 steps · 1 undone');
  await expect(page.locator('#history-branch-btn')).toContainText('Branch 1');
  await row(page, 'Main').locator('.hg-toggle').click();
  await expect.poll(() => rowFacts(page)).toEqual([
    ['step', 'Opened', '●', '1'],
    ['step', 'Coloured by cell_type', '●', '1'],
    ['step', 'Hid alpha of cell_type', '●', '1'],
    ['fork', 'Main', '⑂', '1'],
    ['step', 'Hid gamma of cell_type', '●', '2'],
    ['step', 'Coloured by score', '●', '2'],
    ['step', 'Kept a view', '◉', '1'],
    ['step', 'Renamed 0 to T cells', '○', '1'],
  ]);
  expect(errors).toEqual([]);
});

test('owner rule: a click selects without moving the history; a double-click shows; › opens the details', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openWith(page, FORKED);
  const target = row(page, 'Coloured by cell_type');
  await target.click();
  await expect(target).toHaveAttribute('aria-selected', 'true');
  await expect(target).toBeFocused();
  expect(await head(page), 'a click selects; the step shown stays').toBe('s5');
  await target.locator('.hg-details-btn').click();
  await expect(target.locator('.hg-details')).toBeVisible();
  await expect(target.locator('.hg-details-btn')).toHaveAttribute('aria-expanded', 'true');
  expect(await head(page)).toBe('s5');
  await target.locator('.hg-line').dblclick();
  await expect.poll(() => head(page)).toBe('s1');
  await expect(target).toHaveAttribute('aria-current', 'step');
  expect(errors).toEqual([]);
});

test('keys: arrows move, Enter shows, Space opens details, → opens a stub, Shift+↓ selects, Ctrl/⌘+G groups', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openWith(page, FORKED);
  await row(page, 'Opened').click();
  await page.keyboard.press('ArrowDown');
  await expect(row(page, 'Coloured by cell_type')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => head(page)).toBe('s1');
  await page.keyboard.press('Space');
  await expect(row(page, 'Coloured by cell_type').locator('.hg-details')).toBeVisible();
  await page.keyboard.press('Space');
  await expect(row(page, 'Coloured by cell_type').locator('.hg-details')).toHaveCount(0);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(row(page, 'Main')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(row(page, 'Main')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(row(page, 'Hid gamma of cell_type')).toBeFocused();
  await page.keyboard.press('Shift+ArrowDown');
  await expect(row(page, 'Coloured by score')).toHaveAttribute('aria-selected', 'true');
  await expect(row(page, 'Hid gamma of cell_type')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ControlOrMeta+g');
  const ask = page.locator('.confirm-dialog-overlay');
  await expect(ask).toBeVisible();
  await expect(page.locator('.confirm-dialog-title')).toHaveText('Group 2 steps');
  await page.locator('.confirm-dialog-overlay .confirm-dialog-textarea').fill('QC');
  await ask.getByRole('button', { name: 'Group', exact: true }).click();
  await expect(row(page, 'QC')).toHaveAttribute('data-kind', 'group');
  expect(errors).toEqual([]);
});

test('accessible names, levels and places; the tree is one tab stop on the step shown', async ({ page }) => {
  await openWith(page, FORKED);
  const tree = page.locator('#history-graph');
  await expect(tree).toHaveAttribute('role', 'tree');
  await expect(row(page, 'Hid alpha of cell_type')).toHaveAttribute('aria-label', /^Step 2 of Main, Hid alpha of cell_type, .*branch “Branch 1” starts here$/);
  await expect(row(page, 'Main')).toHaveAttribute('aria-label', /^The rest of branch “Main”, 2 steps, last change .*, main, collapsed$/);
  await expect(row(page, 'Kept a view')).toHaveAttribute('aria-label', /^Step 5 of Branch 1, Kept a view, .*, shown$/);
  await expect(row(page, 'Main')).toHaveAttribute('aria-posinset', '4');
  await expect(row(page, 'Main')).toHaveAttribute('aria-setsize', '6');
  const tabStops = await rows(page).evaluateAll(list => list.filter(el => el.tabIndex === 0).map(el => el.querySelector('.hg-label').textContent));
  expect(tabStops).toEqual(['Kept a view']);
});

for (const [width, height] of [[1440, 1000], [390, 844]]) {
  test(`nothing truncates at ${width} px: long labels wrap and rows grow`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openWith(page, 'long');
    const checked = await page.locator('#history-block').evaluate(block => {
      const out = [];
      for (const el of block.querySelectorAll('.hg-label, .hg-meta, .history-status, .history-branch-name, .history-badge')) {
        const style = getComputedStyle(el);
        if (el.offsetParent === null) continue;
        if (style.textOverflow === 'ellipsis' || el.scrollWidth > el.clientWidth + 1) out.push(el.textContent);
      }
      return out;
    });
    expect(checked).toEqual([]);
    const box = await page.locator('#history-graph .hg-row', { hasText: 'A label that is long' }).boundingBox();
    expect(box.height, 'a wrapped row grows').toBeGreaterThan(30);
  });
}

test('2 000 steps: the drawn rows stay bounded, End reaches the last row, and a new step draws once', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openWith(page, 'steps2000');
  const drawn = await rows(page).count();
  expect(drawn).toBeLessThan(80);
  await rows(page).first().click();
  await page.keyboard.press('End');
  await expect(row(page, 'Step 2000')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(row(page, 'Opened')).toBeFocused();
  await expect(page.locator('#history-where')).toBeVisible();
  await expect(page.locator('#history-where')).toHaveText('Shown: step 2000 ↓');
  await page.locator('#history-where').click();
  await expect(row(page, 'Step 2000')).toBeFocused();
  await page.evaluate(() => globalThis.__fakeHistory.append('Step 2001'));
  await expect(row(page, 'Step 2001')).toHaveAttribute('aria-current', 'step');
  expect(await rows(page).count()).toBeLessThan(80);
  expect(errors).toEqual([]);
});

test('a long history that scrolls: the Details button of a row takes its click once the scrollbar has shown', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openWith(page, 'steps2000');
  const graph = page.locator('#history-graph');
  // The list scrolls to its last row (End), so its overlay scrollbar shows;
  // WebKit's then takes the clicks in a strip at the list's edge.
  await rows(page).first().click();
  await page.keyboard.press('End');
  await expect(row(page, 'Step 2000')).toBeFocused();
  await expect.poll(() => graph.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  // Any smooth scrolling ends: the rows stay where they are for a frame.
  await expect.poll(() => graph.evaluate(element => new Promise(resolve => {
    const before = element.scrollTop;
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(element.scrollTop === before)));
  }))).toBe(true);
  await expect(graph).toHaveAttribute('data-overflows', '');
  const target = page.locator('#history-graph .hg-row').filter({ has: page.locator('.hg-details-btn') });
  const label = await target.evaluateAll(list => {
    const view = document.getElementById('history-graph').getBoundingClientRect();
    const inView = list.filter(element => {
      const box = element.getBoundingClientRect();
      return box.top >= Math.max(0, view.top) + box.height && box.bottom <= Math.min(innerHeight, view.bottom) - box.height;
    });
    return inView[Math.floor(inView.length / 2)].querySelector('.hg-label').textContent;
  });
  const shown = row(page, label);
  const button = shown.locator('.hg-details-btn');
  // Nothing covers the button at its centre: the row ends clear of the strip.
  expect(await button.evaluate(element => {
    const box = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
  })).toBe(true);
  await button.click();
  await expect(shown.locator('.hg-details')).toBeVisible();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await button.click();
  await expect(shown.locator('.hg-details')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('merge 3 steps into one from a selection, then restore them from Recently deleted', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openWith(page, 'recolours');
  // Colour tweaks present the analysis: they fold into one row, and the row stands for its steps.
  const run = page.locator('#history-graph .hg-row[data-kind="run"]');
  await expect(run.locator('.hg-label')).toHaveText('Colors ×3');
  await run.click();
  await run.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Merge 3 steps into one…' }).click();
  await expect(page.locator('.confirm-dialog-title')).toHaveText('Merge 3 steps into one?');
  await page.locator('.confirm-dialog-overlay').getByRole('button', { name: 'Merge into one step' }).click();
  await expect(run).toHaveCount(0);
  await expect(page.locator('#history-graph .hg-row', { hasText: 'Merged 3 steps' })).toHaveCount(1);
  await page.locator('#history-menu-btn').click();
  await page.getByRole('menuitem', { name: 'Recently deleted…' }).click();
  await expect(page.locator('#history-deleted-list li')).toHaveCount(1);
  await page.locator('#history-deleted-list').getByRole('button', { name: /^Restore/ }).click();
  await page.locator('#history-deleted-dialog .app-dialog-close').click();
  await expect(run.locator('.hg-label')).toHaveText('Colors ×3');
  expect(errors).toEqual([]);
});

test('paused: the switch, the marker, and Keep / Discard / Cancel before going back', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openWith(page, 'twoSteps');
  const recording = page.locator('#history-recording');
  await expect(recording).toHaveAttribute('aria-checked', 'true');
  await recording.click();
  await expect(recording).toHaveAttribute('aria-checked', 'false');
  await expect(recording).toHaveText('Paused');
  await expect(page.locator('#history-graph .hg-row[data-kind="paused"]')).toHaveCount(1);
  await expect(page.locator('#history-status')).toContainText('since ');
  await expect(page.locator('#history-recording')).toHaveAttribute('title', /changes still apply/);
  await page.locator('#history-undo-btn').click();
  const ask = page.locator('.confirm-dialog-overlay');
  await expect(page.locator('.confirm-dialog-title')).toHaveText('Keep your changes first?');
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(() => head(page)).toBe('s2');
  await page.locator('#history-undo-btn').click();
  await ask.getByRole('button', { name: 'Keep and go' }).click();
  await expect.poll(() => head(page)).toBe('s1');
  expect(await page.evaluate(() => globalThis.__fakeHistory.pausedChoices)).toEqual(['keep']);
  await recording.click();
  await expect(recording).toHaveAttribute('aria-checked', 'true');
  expect(errors).toEqual([]);
});

test('delete a branch: the confirmation names its steps, where you will be, and main cannot be deleted', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openWith(page, 'forkedAtTip');
  await page.locator('#history-branch-btn').click();
  await page.locator('#history-branches .history-branch[data-branch="b0"] .history-branch-more').click();
  await expect(page.getByRole('menuitem', { name: 'Delete…' })).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await page.locator('#history-branches .history-branch[data-branch="b1"] .history-branch-more').click();
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  await expect(page.locator('.confirm-dialog-title')).toHaveText('Delete branch “Branch 1”?');
  await expect(page.locator('.confirm-dialog-message')).toHaveText(
    'Its 2 steps, from “Kept a view” to “Renamed 0 to T cells”, go to Recently deleted, where you can restore them.');
  await expect(page.locator('.confirm-dialog-list li')).toHaveText(['You are on this branch: you will see step 2 (“Hid alpha of cell_type”).']);
  await page.locator('.confirm-dialog-overlay').getByRole('button', { name: 'Delete branch' }).click();
  await expect.poll(() => head(page)).toBe('s2');
  await expect(row(page, 'Kept a view')).toHaveCount(0);
  expect(errors).toEqual([]);
});

/** Whether the open popup menu sits by its anchor box and is narrower than the page. */
async function menuBy(page, anchor) {
  const menu = page.locator('.history-popup-menu');
  await expect(menu).toBeVisible();
  const box = await menu.boundingBox();
  const width = page.viewportSize().width;
  expect(box.width, 'the menu is as wide as its items, not the page').toBeLessThan(width * 0.8);
  const near = Math.min(Math.abs(box.y - (anchor.y + anchor.height)), Math.abs(box.y + box.height - anchor.y), Math.abs(box.y - anchor.y));
  expect(near, 'the menu opens at its anchor').toBeLessThan(48);
  expect(box.x < anchor.x + anchor.width + 48 && box.x + box.width > anchor.x - 48, 'the menu overlaps its anchor horizontally').toBe(true);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
}

for (const [width, height] of [[1440, 1000], [390, 844]]) {
  test(`popup menus open at their anchor and as wide as their items at ${width} px: row menu, context menu, branch ⋯, Filter`, async ({ page }) => {
    const errors = observeProductErrors(page);
    await page.setViewportSize({ width, height });
    await openWith(page, 'forkedAtTip');
    // The row menu from the keyboard (Shift+F10), anchored at the row.
    const target = row(page, 'Coloured by cell_type');
    await target.click();
    await page.keyboard.press('Shift+F10');
    await menuBy(page, await target.boundingBox());
    // The context menu at the pointer.
    const at = await target.locator('.hg-label').boundingBox();
    await target.locator('.hg-label').click({ button: 'right', position: { x: 4, y: 4 } });
    await menuBy(page, { x: at.x + 4, y: at.y + 4, width: 0, height: 0 });
    // A branch's ⋯ in the picker.
    await page.locator('#history-branch-btn').click();
    const more = page.locator('#history-branches .history-branch[data-branch="b1"] .history-branch-more');
    await more.click();
    await menuBy(page, await more.boundingBox());
    // Filter in the search box.
    await page.keyboard.press('Escape');
    await page.locator('#history-search-btn').click();
    const filter = page.locator('#history-filter-btn');
    await filter.click();
    await menuBy(page, await filter.boundingBox());
    expect(errors).toEqual([]);
  });

  test(`an author's badge never squeezes the label at ${width} px: the label keeps a readable width`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openWith(page, 'badges');
    const facts = await rows(page).evaluateAll(list => list
      .filter(el => !el.querySelector('.history-badge').hidden)
      .map(el => {
        const line = el.querySelector('.hg-line');
        const style = getComputedStyle(line);
        const room = line.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        return { label: el.querySelector('.hg-label').textContent, width: el.querySelector('.hg-label').getBoundingClientRect().width, room };
      }));
    expect(facts.map(each => each.label)).toEqual(['Hid the doublets after the quality check', 'Coloured by the leiden clusters at resolution one']);
    for (const each of facts) expect(each.width, each.label).toBeGreaterThanOrEqual(Math.min(96, each.room) - 1);
  });
}

test('the branch picker closes when a branch is chosen and on a press outside it, and keeps focus while it redraws', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openWith(page, 'forkedAtTip');
  const picker = page.locator('#history-branches');
  const button = page.locator('#history-branch-btn');
  await button.click();
  await expect(picker).toBeVisible();
  await page.locator('#history-branches .history-branch[data-branch="b0"] .history-branch-pick').click();
  await expect(picker).toBeHidden();
  await expect(button).toBeFocused();
  await expect.poll(() => head(page)).toBe('s4');
  await button.click();
  await expect(picker).toBeVisible();
  // A redraw (a new step) keeps the focus on the branch it was on.
  const pick = page.locator('#history-branches .history-branch[data-branch="b1"] .history-branch-pick');
  await pick.focus();
  await page.evaluate(() => globalThis.__fakeHistory.append('Coloured again'));
  await expect(page.locator('#history-branches .history-branch[data-branch="b1"] .history-branch-pick')).toBeFocused();
  await page.locator('#history-status').click();
  await expect(picker).toBeHidden();
  expect(errors).toEqual([]);
});

test('§6 test 8: delete a branch with its sub-branch, the records exact after it, and restore them whole', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openWith(page, 'nested');
  const before = await page.evaluate(() => structuredClone(globalThis.__fakeHistory.records));
  await page.locator('#history-branch-btn').click();
  await page.locator('#history-branches .history-branch[data-branch="b1"] .history-branch-more').click();
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  await expect(page.locator('.confirm-dialog-title')).toHaveText('Delete branch “Branch 1”?');
  await expect(page.locator('.confirm-dialog-message')).toHaveText('Its 2 steps, from “Kept a view” to “Renamed 0 to T cells”, go to Recently deleted, where you can restore them.');
  const option = page.locator('.confirm-dialog-option input');
  await expect(page.locator('.confirm-dialog-option')).toHaveText('Also delete the branch that starts from it (1 step)');
  await option.check();
  await expect(page.locator('.confirm-dialog-list li')).toHaveText(['The branch that starts from it goes too.']);
  await page.locator('.confirm-dialog-overlay').getByRole('button', { name: 'Delete branch' }).click();
  // Exactly Main is left: its steps, its tip shown, nothing of either branch.
  await expect.poll(() => page.evaluate(() => globalThis.__fakeHistory.records.branches.map(each => each.id))).toEqual(['b0']);
  const after = await page.evaluate(() => structuredClone(globalThis.__fakeHistory.records));
  expect(after.steps.map(each => each.id)).toEqual(['s0', 's1', 's2', 's3']);
  expect(after.steps.find(each => each.id === 's1').children).toEqual(['s2']);
  expect(after.steps.map(({ children, ...rest }) => rest)).toEqual(before.steps.filter(each => ['s0', 's1', 's2', 's3'].includes(each.id)).map(({ children, ...rest }) => rest));
  expect(after.headId).toBe('s3');
  await expect(page.locator('#history-graph .hg-row[data-kind="fork"]')).toHaveCount(0);
  // Recently deleted puts back every record as it was.
  await page.locator('#history-menu-btn').click();
  await page.getByRole('menuitem', { name: 'Recently deleted…' }).click();
  await page.locator('#history-deleted-list').getByRole('button', { name: /^Restore/ }).click();
  await page.locator('#history-deleted-dialog .app-dialog-close').click();
  const restored = await page.evaluate(() => structuredClone(globalThis.__fakeHistory.records));
  expect({ ...restored, journal: [], nextJournal: 0 }).toEqual({ ...before, journal: [], nextJournal: 0 });
  await expect(row(page, 'Branch 1')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('§6 test 9: a note and a bookmark, found by search and by the filters', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openWith(page, 'forkedAtTip');
  const target = row(page, 'Hid alpha of cell_type');
  await target.locator('.hg-details-btn').click();
  await target.locator('.history-note-add').click();
  await target.locator('.history-note-editor textarea, textarea').first().fill('Alpha cells are *doublets* here.');
  await target.getByRole('button', { name: 'Save' }).click();
  await expect(target.locator('.history-note-text')).toHaveText('Alpha cells are doublets here.');
  await expect(target.locator('.history-note-text em')).toHaveText('doublets');
  await target.locator('.hg-details-btn').click();
  await target.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Bookmark…' }).click();
  await page.locator('.confirm-dialog-overlay .confirm-dialog-textarea').fill('Before QC');
  await page.locator('.confirm-dialog-overlay').getByRole('button', { name: 'Save' }).click();
  await expect(target).toHaveAttribute('aria-label', /bookmarked “Before QC”, has a note/);
  // Search finds the note's words, and the bookmark's name.
  await page.locator('#history-search-btn').click();
  await page.locator('#history-search-input').fill('doublets');
  await expect(page.locator('#history-status')).toHaveText('1 of 4 steps');
  await expect(rows(page).filter({ has: page.locator('.hg-label', { hasText: /^Hid alpha of cell_type$/ }) })).toHaveCount(1);
  await page.locator('#history-search-input').fill('Before QC');
  await expect(page.locator('#history-status')).toHaveText('1 of 4 steps');
  await page.locator('#history-search-input').fill('');
  // The filter With a note.
  await page.locator('#history-filter-btn').click();
  await page.getByRole('menuitemcheckbox', { name: 'With a note' }).click();
  await expect(page.locator('#history-status')).toHaveText('1 of 4 steps');
  await expect(page.locator('#history-filter-btn')).toHaveText('Filter · 1');
  expect(errors).toEqual([]);
});

test('Add to group: a step after a group joins it from the row menu, and its toast undoes it', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openWith(page, 'forkedAtTip');
  // A group of one step, then the step after it (same branch) joins it.
  await row(page, 'Kept a view').click();
  await page.keyboard.press('ControlOrMeta+g');
  await page.locator('.confirm-dialog-overlay .confirm-dialog-textarea').fill('QC');
  await page.locator('.confirm-dialog-overlay').getByRole('button', { name: 'Group', exact: true }).click();
  await expect(row(page, 'QC')).toHaveAttribute('aria-label', /^Group “QC”, 1 step/);
  await row(page, 'Renamed 0 to T cells').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Add to group “QC”' })).toHaveAttribute('title', 'The group grows to this step, taking in 1 step');
  await page.getByRole('menuitem', { name: 'Add to group “QC”' }).click();
  await expect(row(page, 'QC')).toHaveAttribute('aria-label', /^Group “QC”, 2 steps/);
  await expect(row(page, 'Renamed 0 to T cells')).toHaveCount(0);
  const toast = page.locator('.notification', { hasText: 'Added 1 step to “QC”' });
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(row(page, 'QC')).toHaveAttribute('aria-label', /^Group “QC”, 1 step/);
  // A step on another branch than the group's is not offered.
  await row(page, 'Coloured by cell_type').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: /^Add to group/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('§6 test 12: the keys and chrome: Discard with “Don’t ask again”, settings, F2, Delete, [ ], Alt+↑/↓, the map\'s row rule', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openWith(page, 'forkedAtTip');
  // Paused: Discard and go, remembered: the next move does not ask.
  await page.locator('#history-recording').click();
  await expect(page.locator('#history-recording')).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('#history-recording')).toHaveAttribute('aria-label', 'Recording');
  await page.locator('#history-undo-btn').click();
  await expect(page.locator('.confirm-dialog-title')).toHaveText('Keep your changes first?');
  await page.locator('.confirm-dialog-option input').check();
  await page.locator('.confirm-dialog-overlay').getByRole('button', { name: 'Discard and go' }).click();
  await expect.poll(() => head(page)).toBe('s5');
  await page.locator('#history-redo-btn').click();
  await expect.poll(() => head(page)).toBe('s6');
  await expect(page.locator('.confirm-dialog-overlay')).toHaveCount(0);
  expect(await page.evaluate(() => globalThis.__fakeHistory.pausedChoices)).toEqual(['discard', 'discard']);
  await expect(page.locator('#history-announce')).toHaveText('Redid “Renamed 0 to T cells”');
  await page.locator('#history-recording').click();

  // Settings: a box under the header, its switches from the settings registry; Escape closes it.
  await page.locator('#history-settings-btn').click();
  const settings = page.locator('#history-settings');
  await expect(settings).toBeVisible();
  const autosave = settings.locator('[data-history-setting="autosave"]');
  await expect(autosave).toHaveAttribute('role', 'switch');
  const was = await autosave.getAttribute('aria-checked');
  await autosave.click();
  await expect(autosave).toHaveAttribute('aria-checked', was === 'true' ? 'false' : 'true');
  await autosave.click();
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await expect(page.locator('#history-settings-btn')).toBeFocused();

  // [ and ]: the rows where branches start.
  await row(page, 'Opened').click();
  await page.keyboard.press(']');
  await expect(row(page, 'Hid alpha of cell_type')).toBeFocused();
  await page.keyboard.press(']');
  await expect(row(page, 'Main')).toBeFocused();
  await page.keyboard.press('[');
  await expect(row(page, 'Hid alpha of cell_type')).toBeFocused();
  // Alt+↑/↓ show the step before or after.
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => head(page)).toBe('s1');
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(() => head(page)).toBe('s2');
  // F2 renames a branch; Delete asks before deleting a step.
  await row(page, 'Main').focus();
  await page.keyboard.press('F2');
  await expect(page.locator('.confirm-dialog-title')).toHaveText('Rename “Main”');
  await page.keyboard.press('Escape');
  await row(page, 'Kept a view').focus();
  await page.keyboard.press('Delete');
  await expect(page.locator('.confirm-dialog-title')).toHaveText('Delete step 5 (“Kept a view”)?');
  await page.locator('.confirm-dialog-overlay').getByRole('button', { name: 'Cancel' }).click();
  await expect(row(page, 'Kept a view')).toHaveCount(1);

  // The map's graph follows the row rule: a click selects, a double-click shows.
  await page.locator('#history-branch-btn').click();
  await page.locator('#history-branches').getByRole('button', { name: 'Map ⤢' }).click();
  const map = page.locator('#history-map-dialog');
  await expect(map).toBeVisible();
  const mapRow = map.locator('.hg-row', { has: page.locator('.hg-label', { hasText: /^Hid gamma of cell_type$/ }) });
  await mapRow.click();
  await expect(mapRow).toHaveAttribute('aria-selected', 'true');
  expect(await head(page)).toBe('s2');
  await mapRow.locator('.hg-line').dblclick();
  await expect.poll(() => head(page)).toBe('s3');
  expect(errors).toEqual([]);
});

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test('§6 test 12: a double tap shows the step once; a single tap only selects', async ({ page }) => {
    const errors = observeProductErrors(page);
    await openWith(page, 'forkedAtTip');
    const target = row(page, 'Coloured by cell_type');
    await target.locator('.hg-label').tap();
    await expect(target).toHaveAttribute('aria-selected', 'true');
    expect(await head(page)).toBe('s6');
    const jumpsBefore = await page.evaluate(() => globalThis.__fakeHistory.acted.filter(type => type === 'history.jump').length);
    await target.locator('.hg-label').tap();
    await target.locator('.hg-label').tap();
    await expect.poll(() => head(page)).toBe('s1');
    // The dblclick a browser may send for the same taps (dispatched with them) is not a second show.
    expect(await page.evaluate(() => globalThis.__fakeHistory.acted.filter(type => type === 'history.jump').length) - jumpsBefore).toBe(1);
    expect(errors).toEqual([]);
  });
});
