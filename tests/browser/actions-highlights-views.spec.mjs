/**
 * Highlight actions in the page (`app/actions/definitions/highlights.js`,
 * `app/ui/modules/highlight/highlight-actions.js`):
 *
 * - a selection tool's Confirm is one `highlight.cells` step: the cells the
 *   tool confirmed, the cells the step names (original positions) and the
 *   cells the group holds are one set, by identity, and stay that set when
 *   the step is undone and redone (once the state domains are installed);
 * - every Highlighting control (page tabs, the group list, Clear, the X key,
 *   the legend's highlight button) dispatches exactly one action with exact
 *   parameters, named by page and group names, and leaves the exact state;
 * - each action dispatched directly leaves the exact state and tabs, and a
 *   name that does not resolve is refused with a sentence;
 * - once the state domains are installed, undoing each action (putting back
 *   the domains it touches) gives back the whole state, and the action
 *   changes no domain it does not touch.
 */
import { expect, test } from './helpers/test.mjs';
import { applyUndoRedo, takeSteps, waitForHistory } from './helpers/state-history.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { armSelection } from './helpers/selection-gesture.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=actions-highlights`;

function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => {
    errors.push(`page: ${error.stack || error.message}`);
  });
  return errors;
}

async function openDataset(page) {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await expect(page.locator('#filter-count')).toHaveText('Showing all 120 cells');
  // Every dispatch, in order, as {type, params} (cells as numbers); a failed one with its message.
  await page.evaluate(async () => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    window.__dispatched = [];
    getActions().subscribe(event => {
      if (event.kind === 'start') {
        const params = { ...event.params };
        if (ArrayBuffer.isView(params.cells)) params.cells = Array.from(params.cells);
        window.__dispatched.push({ type: event.type, params: JSON.parse(JSON.stringify(params)) });
      } else if (event.kind === 'failed') {
        window.__dispatched.push({ type: event.type, failed: event.error?.message ?? String(event.error) });
      }
    });
  });
}

/** The dispatches since the last call, once the dispatcher is idle. */
async function takeDispatched(page) {
  return page.evaluate(async () => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    await new Promise(resolve => setTimeout(resolve, 0));
    await getActions().idle();
    const taken = window.__dispatched;
    window.__dispatched = [];
    return taken;
  });
}

function dispatch(page, type, params) {
  return page.evaluate(async ([actionType, actionParams]) => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    try {
      const { outcome } = await getActions().dispatch(actionType, actionParams);
      return { outcome };
    } catch (error) {
      return { refused: error.name === 'ActionRefused', message: error.message };
    }
  }, [type, params]);
}

/**
 * The highlight pages as the state holds them: name, color, shown, and each
 * group's label, on/off and cells by original position (ascending).
 */
function readHighlights(page) {
  return page.evaluate(() => {
    const state = window._cellucidState;
    const identity = state.cellIdentity;
    const shown = state.getActivePageId();
    return state.getHighlightPages().map(entry => ({
      name: entry.name,
      color: entry.color,
      shown: entry.id === shown,
      groups: entry.highlightedGroups.map(group => ({
        label: group.label,
        enabled: group.enabled !== false,
        cells: Array.from(identity.toOriginal(group.cellIndices)).sort((a, b) => a - b),
      })),
    }));
  });
}

/** The tab strip as drawn: each tab's name and whether it is selected. */
function readTabs(page) {
  return page.locator('#highlight-pages-tabs .highlight-page-tab').evaluateAll(tabs => tabs.map(tab => [
    tab.querySelector('.highlight-page-tab-name').textContent,
    tab.querySelector('.highlight-page-tab-activate').getAttribute('aria-selected') === 'true',
  ]));
}

function tab(page, name) {
  return page.locator('#highlight-pages-tabs .highlight-page-tab').filter({
    has: page.locator('.highlight-page-tab-name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }),
  });
}

/** The cells of `category` of cell_type, by original position. */
function cellsOfCategory(page, category) {
  return page.evaluate(label => {
    const state = window._cellucidState;
    const field = state.getFields().find(candidate => candidate.key === 'cell_type');
    const code = field.categories.indexOf(label);
    const cells = [];
    for (let cell = 0; cell < field.codes.length; cell++) if (field.codes[cell] === code) cells.push(cell);
    return Array.from(state.cellIdentity.toOriginal(Uint32Array.from(cells))).sort((a, b) => a - b);
  }, category);
}

async function colorByCellType(page) {
  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
  await expect(page.locator('.legend-item')).toHaveCount(3);
  await expect.poll(() => page.evaluate(() => window._cellucidState.getActiveField()?.key)).toBe('cell_type');
}

async function altDraw(page, corners) {
  await page.mouse.move(corners[0][0], corners[0][1]);
  await page.keyboard.down('Alt');
  await page.mouse.down();
  for (const [x, y] of corners.slice(1)) await page.mouse.move(x, y, { steps: 2 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
}

/** The selection the tool holds now, by original position (ascending). */
function candidatesNow(page) {
  return page.evaluate(() => {
    const state = window._cellucidState;
    const candidates = window._cellucidViewer.getUnifiedSelectionState().candidates;
    return Array.from(state.cellIdentity.toOriginal(candidates)).sort((a, b) => a - b);
  });
}

// One opening: the lasso's group stays on the page, and the annotation adds its own after it.
test('a selection confirmed is one highlight.cells step of exactly its cells: a lasso, then an annotation of a category', async ({ page }) => {
  const productErrors = observeProductErrors(page);
  await openDataset(page);

  await test.step('a confirmed lasso is one highlight.cells step: the selection, the step and the group are one set', async () => {
    await takeDispatched(page);

    await page.locator('.highlight-mode-btn[data-mode="lasso"]').click();
    await armSelection(page, 'lasso', () => altDraw(page, [
      [400, 200], [1000, 200], [1000, 900], [400, 900], [400, 200],
    ]));
    const selected = await candidatesNow(page);
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.length).toBeLessThan(120);

    await page.locator('#lasso-confirm-btn').click();
    const dispatched = await takeDispatched(page);
    expect(dispatched).toEqual([{
      type: 'highlight.cells',
      params: {
        cells: selected,
        label: 'Lasso',
        tool: 'lasso',
        page: 'Page 1',
      },
    }]);
    const pages = await readHighlights(page);
    expect(pages).toEqual([{
      name: 'Page 1', color: pages[0].color, shown: true,
      groups: [{ label: dispatched[0].params.label, enabled: true, cells: selected }],
    }]);
    // The renderer draws exactly those cells.
    expect(await page.evaluate(() => {
      const state = window._cellucidState;
      return Array.from(state.cellIdentity.toOriginal(state._highlightedCellIndices)).sort((a, b) => a - b);
    })).toEqual(selected);
    await expect(page.locator('#highlight-count')).toHaveText(`${selected.length} ${selected.length === 1 ? 'cell' : 'cells'} highlighted`);
    expect(productErrors).toEqual([]);
  });

  await test.step('an annotation of a category is one highlight.cells step of exactly its cells', async () => {
    // The lasso tool of the step above gives way to the annotation tool.
    await page.locator('.highlight-mode-btn[data-mode="annotation"]').click();
    await colorByCellType(page);
    await takeDispatched(page);

    // A cell of beta, and a screen point the viewer picks it at.
    const point = await page.evaluate(() => {
      const viewer = window._cellucidViewer;
      const field = window._cellucidState.getActiveField();
      const beta = field.categories.indexOf('beta');
      for (let y = 40; y < 980; y += 5) {
        for (let x = 340; x < 1430; x += 5) {
          const cell = viewer.pickCellAtScreen(x, y);
          if (cell >= 0 && field.codes[cell] === beta) return { x, y };
        }
      }
      return null;
    });
    expect(point).not.toBeNull();
    await armSelection(page, 'annotation', async () => {
      await page.mouse.move(point.x, point.y);
      await page.keyboard.down('Alt');
      await page.mouse.down();
      await page.mouse.up();
      await page.keyboard.up('Alt');
      await page.mouse.move(point.x + 40, point.y + 40);
    });
    const beta = await cellsOfCategory(page, 'beta');
    expect(await candidatesNow(page)).toEqual(beta);
    await page.locator('#annotation-confirm-btn').click();
    expect(await takeDispatched(page)).toEqual([{
      type: 'highlight.cells',
      params: { cells: beta, label: 'beta', tool: 'annotation', page: 'Page 1' },
    }]);
    // The group this step added, after the lasso's.
    expect((await readHighlights(page))[0].groups.slice(1)).toEqual([
      { label: 'beta', enabled: true, cells: beta },
    ]);
    expect(productErrors).toEqual([]);
  });
});

test('every Highlighting control dispatches one action named by page and group, and leaves the exact state', async ({ page }) => {
  const productErrors = observeProductErrors(page);
  await openDataset(page);
  await colorByCellType(page);
  await takeDispatched(page);
  const alpha = await cellsOfCategory(page, 'alpha');
  const beta = await cellsOfCategory(page, 'beta');
  const highlightCategory = async (category, onPage) => {
    expect(await dispatch(page, 'highlight.category', {
      field: { source: 'obs', key: 'cell_type' }, categories: [category], page: onPage,
    })).toMatchObject({ outcome: { groups: [`cell_type: ${category}`] } });
    await takeDispatched(page);
  };

  // + makes a page and shows it.
  await page.locator('#add-highlight-page').click();
  expect(await takeDispatched(page)).toEqual([{ type: 'highlight.page.create', params: {} }]);
  expect(await readTabs(page)).toEqual([['Page 1', false], ['Page 2', true]]);

  // A tab shows its page.
  await tab(page, 'Page 1').locator('.highlight-page-tab-activate').click();
  expect(await takeDispatched(page)).toEqual([{ type: 'highlight.page.switch', params: { page: 'Page 1' } }]);
  expect(await readTabs(page)).toEqual([['Page 1', true], ['Page 2', false]]);

  // Double-click: shown, then renamed.
  await tab(page, 'Page 2').locator('.highlight-page-tab-name').dblclick();
  const rename = page.locator('.highlight-page-tab-input');
  await expect(rename).toBeFocused();
  await rename.fill('T cells');
  await rename.press('Enter');
  expect(await takeDispatched(page)).toEqual([
    { type: 'highlight.page.switch', params: { page: 'Page 2' } },
    { type: 'highlight.page.rename', params: { page: 'Page 2', name: 'T cells' } },
  ]);
  expect(await readTabs(page)).toEqual([['Page 1', false], ['T cells', true]]);

  // The swatch recolors the page (one step for the drag).
  await tab(page, 'T cells').locator('.color-swatch-input').fill('#123456');
  expect(await takeDispatched(page)).toEqual([
    { type: 'highlight.page.recolor', params: { page: 'T cells', color: '#123456' } },
  ]);
  expect((await readHighlights(page))[1].color).toBe('#123456');

  // The group list: off, then removed.
  await highlightCategory('alpha', 'T cells');
  expect((await readHighlights(page))[1].groups).toEqual([{ label: 'cell_type: alpha', enabled: true, cells: alpha }]);
  const row = page.locator('#highlighted-groups-list .list-item').first();
  await row.locator('input[type="checkbox"]').uncheck();
  expect(await takeDispatched(page)).toEqual([{
    type: 'highlight.group.toggle',
    params: { group: 'cell_type: alpha', page: 'T cells', enabled: false },
  }]);
  expect((await readHighlights(page))[1].groups[0].enabled).toBe(false);
  await expect(page.locator('#highlight-count')).toHaveText('No cells highlighted');
  await row.locator('input[type="checkbox"]').check();
  await takeDispatched(page);
  await row.locator('.list-item-remove').click();
  expect(await takeDispatched(page)).toEqual([{
    type: 'highlight.group.remove', params: { group: 'cell_type: alpha', page: 'T cells' },
  }]);

  // Two pages with cells, combined from the ⋈ menu into a page of either.
  await highlightCategory('alpha', 'T cells');
  await highlightCategory('beta', 'Page 1');
  expect(await readTabs(page)).toEqual([['Page 1', true], ['T cells', false]]);
  await tab(page, 'T cells').locator('.highlight-page-tab-combine').click();
  await page.locator('.popup-menu .open-menu-item', { hasText: 'Union with Page 1' }).click();
  expect(await takeDispatched(page)).toEqual([{
    type: 'highlight.page.combine', params: { pages: ['T cells', 'Page 1'], operation: 'union' },
  }]);
  expect(await readTabs(page)).toEqual([['Page 1', false], ['T cells', false], ['T cells ∪ Page 1', true]]);
  expect((await readHighlights(page))[2].groups[0].cells).toEqual([...alpha, ...beta].sort((a, b) => a - b));

  // × deletes the page: no notification offers a second Undo (the history undoes it).
  await tab(page, 'T cells ∪ Page 1').locator('.highlight-page-tab-delete').click();
  expect(await takeDispatched(page)).toEqual([{ type: 'highlight.page.delete', params: { pages: ['T cells ∪ Page 1'] } }]);
  expect(await readTabs(page)).toEqual([['Page 1', true], ['T cells', false]]);
  await expect(page.locator('.notification-center .notification-message', { hasText: /removed/ })).toHaveCount(0);

  // Clear empties the page shown; X does the same from the keyboard.
  await page.locator('#clear-all-highlights').click();
  expect(await takeDispatched(page)).toEqual([{ type: 'highlight.page.clear', params: { page: 'Page 1' } }]);
  expect((await readHighlights(page))[0].groups).toEqual([]);
  await tab(page, 'T cells').locator('.highlight-page-tab-activate').click();
  await takeDispatched(page);
  // X with nothing focused that takes text.
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('x');
  expect(await takeDispatched(page)).toEqual([{ type: 'highlight.page.clear', params: { page: 'T cells' } }]);
  expect((await readHighlights(page)).map(entry => entry.groups.length)).toEqual([0, 0]);
  expect(productErrors).toEqual([]);
});

test('the legend highlight button (annotation mode) dispatches highlight.category, and off again highlight.group.remove', async ({ page }) => {
  const productErrors = observeProductErrors(page);
  await page.addInitScript(() => {
    window._simulate_repo_connected = true;
  });
  await openDataset(page);
  await page.evaluate(async () => {
    const { getCommunityAnnotationSession } = await import('/assets/js/app/community-annotations/session.js');
    getCommunityAnnotationSession().setFieldAnnotated('cell_type', true);
  });
  const annotatedOption = page.locator('#categorical-field option', { hasText: /cell_type$/ });
  await expect(annotatedOption).toHaveCount(1);
  await page.locator('#categorical-field').selectOption(await annotatedOption.getAttribute('value'));
  const button = page.locator('.legend-item', {
    has: page.locator('.legend-label-main', { hasText: /^alpha$/ }),
  }).locator('.legend-highlight-btn');
  await expect(button).toBeEnabled();
  await takeDispatched(page);

  await button.click();
  expect(await takeDispatched(page)).toEqual([{
    type: 'highlight.category',
    params: { field: { source: 'obs', key: 'cell_type' }, categories: ['alpha'], page: 'Page 1' },
  }]);
  expect((await readHighlights(page))[0].groups).toEqual([
    { label: 'cell_type: alpha', enabled: true, cells: await cellsOfCategory(page, 'alpha') },
  ]);
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await button.click();
  expect(await takeDispatched(page)).toEqual([
    { type: 'highlight.group.remove', params: { group: 'cell_type: alpha', page: 'Page 1' } },
  ]);
  expect((await readHighlights(page))[0].groups).toEqual([]);
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  expect(productErrors).toEqual([]);
});

test('undoing each highlight action gives back the whole state, and each changes only what it touches, on the page\'s own history', async ({ page }) => {
  await openDataset(page);
  await waitForHistory(page);
  await takeSteps(page, [
    ['highlight.page.rename', { page: 'Page 1', name: 'A' }],
    ['highlight.cells', { cells: [0, 2, 4], label: 'First' }],
    ['highlight.page.create', { name: 'B' }],
    ['highlight.cells', { cells: [4, 6], label: 'Second' }],
  ]);
  const report = await applyUndoRedo(page, [
    ['highlight.page.create', { name: 'C', color: '#abcdef' }],
    ['highlight.page.switch', { page: 'A' }],
    ['highlight.page.rename', { page: 'C', name: 'D' }],
    ['highlight.page.recolor', { page: 'B', color: '#010203' }],
    ['highlight.cells', { cells: [1, 3, 5], label: 'Third', tool: 'lasso' }],
    ['highlight.cells', { cells: [9], color: '#fedcba' }],
    ['highlight.category', { field: { source: 'obs', key: 'cell_type' }, categories: ['alpha'], page: 'A' }],
    // Several categories: one step, which one undo takes back whole.
    ['highlight.category', { field: { source: 'obs', key: 'cell_type' }, categories: ['beta', 'gamma'], page: 'B' }],
    ['highlight.range', { field: { source: 'obs', key: 'cell_type' }, min: 0, max: 1 }],
    ['highlight.group.toggle', { group: 'First', enabled: false, page: 'A' }],
    ['highlight.group.remove', { group: 'Second', page: 'B' }],
    ['highlight.page.combine', { pages: ['A', 'B'], operation: 'union' }],
    ['highlight.page.clear', { page: 'A' }],
    ['highlight.page.delete', { pages: ['D'] }],
    ['highlight.clear-all', {}],
  ]);
  expect(report.filter(outcome => outcome.type === 'highlight.category').map(outcome => outcome.step)).toEqual([true, true]);
  for (const outcome of report) {
    if (outcome.type === 'highlight.range') {
      // cell_type is categorical: the range is refused and changes nothing.
      expect(outcome.refused, outcome.type).toMatch(/is categorical; highlight one of its categories instead/);
      expect(outcome.changed, outcome.type).toEqual([]);
      continue;
    }
    expect(outcome.refused, outcome.type).toBeNull();
    expect(outcome.step, `${outcome.type} is a step`).toBe(true);
    expect(outcome.untouched, `${outcome.type} changed only the domains it touches`).toEqual([]);
    expect(outcome.differs, `${outcome.type} undone gives back every domain`).toEqual([]);
    expect(outcome.redone, `${outcome.type} redone gives it again`).toEqual([]);
  }
});
