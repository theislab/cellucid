/**
 * In a grid of views an annotation gesture (Alt+click, Alt+vertical drag) is
 * read on the pane it lands in, and it never moves view focus. So when the
 * focused view is colored by one field and another pane by a different one,
 * the gesture must select by the field of the pane that was pressed, among
 * the cells that pane shows, while focus stays where it was. Reading the
 * focused view's field instead selected a value range of the wrong field.
 *
 * Whether a press can start at all, and the cursor the armed tool shows, are
 * the pressed pane's too: with the focused view colored by no field, an Alt
 * press in a colored pane must still select, and a press in the field-less
 * pane must say why it did nothing.
 */

import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`
  + '&dataset=current-ui&acceptance=annotation-pane-field-ci';

// How long a gesture that did land may take to arm its tool before it counts
// as dropped; see highlight-selection-feedback.spec.mjs.
const GESTURE_LANDING_TIMEOUT_MS = 3_000;

// Mirrors `ANNOTATION_DRAG_VALUE_SCALE` in annotation-cells.js: the value
// span one CSS pixel of vertical drag covers, as a fraction of the range.
const DRAG_VALUE_SCALE = 0.005;

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
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture',
  );
  await expect(page.locator('#filter-count')).toHaveText(
    'Showing all 120 cells',
  );
}

/** Kind of the focused view's field, as the state holds it, or null. */
const focusedFieldKindOf = page => page.evaluate(
  () => window._cellucidState.getActiveField()?.kind ?? null,
);

const canvasCursor = page => page.evaluate(
  () => document.getElementById('glcanvas').style.cursor,
);

const MODE_DESCRIPTION = '#highlight-mode-description';
// The active tool's gesture, or what it needs first: the Selection (i)'s first line.
const TOOL_HINT = '#highlight-tool-hint';

/** Focus as both owners publish it: the viewer's pane and the state's view. */
const focusOf = page => page.evaluate(() => ({
  viewer: window._cellucidViewer.getViewLayout().activeId,
  state: window._cellucidState.activeViewId,
}));

const unifiedState = page => page.evaluate(
  () => {
    // The candidates are a cell list (Uint32Array); hand them over as numbers.
    const state = window._cellucidViewer.getUnifiedSelectionState();
    return { ...state, candidates: Array.from(state.candidates) };
  },
);

const legendRow = (page, name) => page.locator('.legend-item', {
  has: page.locator('.legend-label-main', { hasText: new RegExp(`^${name}$`) }),
});

/**
 * Integer screen points inside pane `viewId` that the viewer's own picker
 * resolves to distinct cells visible in that pane.
 */
async function findPaneCells(page, viewId, limit) {
  const points = await page.evaluate(({ id, max }) => {
    const viewer = window._cellucidViewer;
    const canvas = document.getElementById('glcanvas');
    const rect = canvas.getBoundingClientRect();
    const pane = viewer.getPresentedLayout().panes
      .find(candidate => candidate.viewId === id);
    if (!pane) throw new Error(`No presented pane for view "${id}".`);
    const visible = viewer.getViewTransparency(id);
    const left = Math.ceil(rect.left + pane.cssLeft);
    const top = Math.ceil(rect.top + pane.cssTop);
    const right = Math.floor(rect.left + pane.cssLeft + pane.cssWidth);
    const bottom = Math.floor(rect.top + pane.cssTop + pane.cssHeight);
    const found = [];
    const seen = new Set();
    // Keep clear of the pane's edges and of the bottom, where a vertical drag
    // would otherwise leave the pane.
    for (let y = top + 140; y < bottom - 40; y += 3) {
      for (let x = left + 20; x < right - 20; x += 3) {
        if (document.elementFromPoint(x, y) !== canvas) continue;
        const cellIndex = viewer.pickCellAtScreen(x, y);
        if (cellIndex < 0 || seen.has(cellIndex) || visible[cellIndex] !== 1) {
          continue;
        }
        seen.add(cellIndex);
        found.push({ x, y, cellIndex });
        if (found.length >= max) return found;
      }
    }
    return found;
  }, { id: viewId, max: limit });
  expect(points.length).toBe(limit);
  return points;
}

/** Repeat `gesture` until the annotation step controls appear. */
async function armAnnotation(page, gesture) {
  const controls = page.locator('#annotation-step-controls');
  for (let attempt = 0; attempt < 8; attempt++) {
    await gesture();
    const armed = await controls.waitFor({
      state: 'attached',
      timeout: GESTURE_LANDING_TIMEOUT_MS,
    }).then(() => true, error => {
      if (error?.name !== 'TimeoutError') throw error;
      return false;
    });
    if (armed) return;
  }
  await expect(controls).toBeAttached();
}

/**
 * Two panes: `live` colored by the categorical `cell_type` with `alpha`
 * hidden, and a kept view colored by the continuous `score` with every cell
 * shown. The kept view holds focus.
 */
async function openTwoPanes(page) {
  await openDataset(page);
  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
  await expect(page.locator('.legend-item')).toHaveCount(3);
  await legendRow(page, 'alpha').locator('.legend-checkbox').uncheck();
  await expect(page.locator('#filter-count')).toHaveText('Showing 80 of 120 cells');

  await page.locator('#split-keep-view-btn').click();
  await expect(page.locator('.split-badge')).toHaveCount(2);
  const keptId = await page.evaluate(() => window._cellucidState.activeViewId);
  expect(keptId).not.toBe('live');
  await expect.poll(() => focusOf(page)).toEqual({ viewer: keptId, state: keptId });

  // The kept view diverges: every cell shown, colored by `score`.
  await legendRow(page, 'alpha').locator('.legend-checkbox').check();
  await expect(page.locator('#filter-count')).toHaveText('Showing all 120 cells');
  await page.locator('#continuous-field').selectOption({ label: 'score' });
  await expect.poll(() => focusedFieldKindOf(page)).toBe('continuous');

  const fields = await page.evaluate(kept => ({
    live: window._cellucidState.getFieldForView('live').key,
    kept: window._cellucidState.getFieldForView(kept).key,
  }), keptId);
  expect(fields).toEqual({ live: 'cell_type', kept: 'score' });
  return keptId;
}

test('Alt+click in an unfocused pane selects that pane\'s category among the cells it shows', async ({
  page,
}) => {
  const productErrors = observeProductErrors(page);
  const keptId = await openTwoPanes(page);
  const [point] = await findPaneCells(page, 'live', 1);

  await armAnnotation(page, async () => {
    await page.mouse.move(point.x, point.y);
    await page.keyboard.down('Alt');
    await page.mouse.down();
    await page.mouse.up();
    await page.keyboard.up('Alt');
  });

  const expected = await page.evaluate(cellIndex => {
    const field = window._cellucidState.getFieldForView('live');
    const visible = window._cellucidViewer.getViewTransparency('live');
    const code = field.codes[cellIndex];
    const cells = [];
    for (let cell = 0; cell < field.codes.length; cell++) {
      if (field.codes[cell] === code && visible[cell] === 1) cells.push(cell);
    }
    return { category: field.categories[code], cells };
  }, point.cellIndex);
  // `alpha` is hidden in the pane, so the clicked cell is beta or gamma, and
  // each of those has 40 cells, all shown there.
  expect(['beta', 'gamma']).toContain(expected.category);
  expect(expected.cells).toHaveLength(40);

  const selection = await unifiedState(page);
  expect(selection.inProgress).toBe(true);
  expect([...selection.candidates].sort((a, b) => a - b)).toEqual(expected.cells);
  expect(await focusOf(page), 'an Alt gesture never moves view focus')
    .toEqual({ viewer: keptId, state: keptId });
  // The help line describes the pane that was pressed: a categorical one
  // replaces on a plain Alt gesture, although the focused view is continuous.
  await expect(page.locator('#highlight-mode-description'))
    .toContainText('Alt to replace');

  // Confirming commits exactly those cells as an annotation group; the group
  // names no field, so nothing in it can point at the focused view's.
  await page.locator('#annotation-confirm-btn').click();
  await expect(page.locator('#annotation-step-controls')).toHaveCount(0);
  const group = await page.evaluate(
    () => {
      const saved = window._cellucidState.getHighlightedGroups().at(-1);
      return {
        type: saved.type,
        label: saved.label,
        cells: [...saved.cellIndices].sort((a, b) => a - b),
        fieldKey: saved.fieldKey ?? null,
      };
    },
  );
  expect(group).toEqual({
    type: 'annotation',
    label: 'Annotation (40 cells)',
    cells: expected.cells,
    fieldKey: null,
  });
  expect(await focusOf(page)).toEqual({ viewer: keptId, state: keptId });
  expect(productErrors).toEqual([]);
});

test('an Alt drag in an unfocused pane selects a value range of that pane\'s continuous field', async ({
  page,
}) => {
  const productErrors = observeProductErrors(page);
  const keptId = await openTwoPanes(page);

  // Focus the categorical `live` view; the drag below lands in the kept pane,
  // which is colored by the continuous `score`.
  await page.locator('.split-badge').filter({
    has: page.locator('.split-badge-pill', { hasText: /^1$/ }),
  }).click();
  await expect.poll(() => focusOf(page)).toEqual({ viewer: 'live', state: 'live' });
  await expect.poll(() => focusedFieldKindOf(page)).toBe('category');

  const [point] = await findPaneCells(page, keptId, 1);
  const dragDeltaY = -60;
  const label = page.locator('#selection-range-label');

  await page.mouse.move(point.x, point.y);
  await page.keyboard.down('Alt');
  await page.mouse.down();
  await page.mouse.move(point.x, point.y + dragDeltaY, { steps: 6 });
  // The live preview labels the range of the pane's continuous field while
  // the gesture is still in hand; a categorical field would have no label.
  await expect(label).toBeVisible();
  const labelText = await label.textContent();
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expect(page.locator('#annotation-step-controls')).toBeAttached();
  await expect(label).toBeHidden();

  const expected = await page.evaluate(({ id, cellIndex, deltaY, scale }) => {
    const field = window._cellucidState.getFieldForView(id);
    const visible = window._cellucidViewer.getViewTransparency(id);
    const { min, max } = field._continuousStats;
    const clicked = field.values[cellIndex];
    const dragAmount = -deltaY * scale * (max - min);
    const minVal = clicked;
    const maxVal = Math.min(max, clicked + dragAmount);
    const cells = [];
    for (let cell = 0; cell < field.values.length; cell++) {
      const value = field.values[cell];
      if (value >= minVal && value <= maxVal && visible[cell] === 1) cells.push(cell);
    }
    return { minVal, maxVal, cells };
  }, {
    id: keptId,
    cellIndex: point.cellIndex,
    deltaY: dragDeltaY,
    scale: DRAG_VALUE_SCALE,
  });
  expect(expected.cells).toContain(point.cellIndex);

  const selection = await unifiedState(page);
  expect([...selection.candidates].sort((a, b) => a - b)).toEqual(expected.cells);
  expect(await focusOf(page), 'an Alt gesture never moves view focus')
    .toEqual({ viewer: 'live', state: 'live' });

  // The label read "min → max" of the same range, rounded for display.
  const [shownMin, shownMax] = labelText.split('→').map(part => Number(part.trim()));
  for (const [shown, exact] of [[shownMin, expected.minVal], [shownMax, expected.maxVal]]) {
    expect(Number.isFinite(shown)).toBe(true);
    expect(Math.abs(shown - exact)).toBeLessThanOrEqual(0.01 * Math.max(1, Math.abs(exact)));
  }
  await expect(page.locator('#highlight-mode-description'))
    .toContainText('Alt to intersect');
  expect(productErrors).toEqual([]);
});

/**
 * Two panes: `live` colored by the categorical `cell_type`, and a kept view,
 * which holds focus, colored by no field at all. Every cell is shown in both.
 */
async function openFieldlessFocusedPane(page) {
  await openDataset(page);
  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
  await expect(page.locator('.legend-item')).toHaveCount(3);

  await page.locator('#split-keep-view-btn').click();
  await expect(page.locator('.split-badge')).toHaveCount(2);
  const keptId = await page.evaluate(() => window._cellucidState.activeViewId);
  expect(keptId).not.toBe('live');
  await expect.poll(() => focusOf(page)).toEqual({ viewer: keptId, state: keptId });

  // The focused kept view stops coloring by any field.
  await page.locator('#categorical-field').selectOption({ label: 'None' });
  await expect.poll(() => focusedFieldKindOf(page)).toBe(null);

  const fields = await page.evaluate(kept => ({
    live: window._cellucidState.getFieldForView('live')?.key ?? null,
    kept: window._cellucidState.getFieldForView(kept)?.key ?? null,
  }), keptId);
  expect(fields).toEqual({ live: 'cell_type', kept: null });
  return keptId;
}

test('Alt+click in a colored pane selects although the focused view has no field', async ({
  page,
}) => {
  const productErrors = observeProductErrors(page);
  const keptId = await openFieldlessFocusedPane(page);

  // One pane on screen has a field, so the panel invites a click rather than
  // asking for a field first.
  await expect(page.locator(TOOL_HINT)).toContainText(
    'Alt+click a cell to select',
  );
  await expect(page.locator(TOOL_HINT)).not.toContainText(
    'Color by a field first',
  );

  const [point] = await findPaneCells(page, 'live', 1);
  await armAnnotation(page, async () => {
    await page.mouse.move(point.x, point.y);
    await page.keyboard.down('Alt');
    await page.mouse.down();
    await page.mouse.up();
    await page.keyboard.up('Alt');
  });

  const expected = await page.evaluate(cellIndex => {
    const field = window._cellucidState.getFieldForView('live');
    const visible = window._cellucidViewer.getViewTransparency('live');
    const code = field.codes[cellIndex];
    const cells = [];
    for (let cell = 0; cell < field.codes.length; cell++) {
      if (field.codes[cell] === code && visible[cell] === 1) cells.push(cell);
    }
    return cells;
  }, point.cellIndex);
  expect(expected).toHaveLength(40);

  const selection = await unifiedState(page);
  expect(selection.inProgress).toBe(true);
  expect([...selection.candidates].sort((a, b) => a - b)).toEqual(expected);
  expect(await focusOf(page), 'an Alt gesture never moves view focus')
    .toEqual({ viewer: keptId, state: keptId });
  expect(productErrors).toEqual([]);
});

test('Alt+click in a pane colored by no field changes nothing and says why', async ({
  page,
}) => {
  const productErrors = observeProductErrors(page);
  const keptId = await openFieldlessFocusedPane(page);
  const [point] = await findPaneCells(page, keptId, 1);

  await page.mouse.move(point.x, point.y);
  await page.keyboard.down('Alt');
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up('Alt');

  await expect(page.locator(MODE_DESCRIPTION)).toContainText(
    'That panel is not colored by a field, so there is nothing to select.',
  );
  await expect(page.locator('#annotation-step-controls')).toHaveCount(0);
  expect((await unifiedState(page)).inProgress).toBe(false);
  expect(
    await focusOf(page),
    'a refused press is still the selection tool\'s, so focus stays put',
  ).toEqual({ viewer: keptId, state: keptId });
  expect(productErrors).toEqual([]);
});

test('the armed annotation cursor follows the field of the pane under it', async ({
  page,
}) => {
  const productErrors = observeProductErrors(page);
  const keptId = await openFieldlessFocusedPane(page);
  const [livePoint] = await findPaneCells(page, 'live', 1);
  const [keptPoint] = await findPaneCells(page, keptId, 1);
  // The viewer ignores an Alt key typed into a form control, and the field
  // menus just used keep focus.
  const releaseFormFocus = () => page.evaluate(() => document.activeElement?.blur());

  await releaseFormFocus();
  await page.mouse.move(livePoint.x, livePoint.y);
  await page.keyboard.down('Alt');
  await expect.poll(() => canvasCursor(page)).toBe('cell');
  await page.mouse.move(keptPoint.x, keptPoint.y, { steps: 4 });
  await expect.poll(() => canvasCursor(page)).toBe('not-allowed');
  await page.mouse.move(livePoint.x, livePoint.y, { steps: 4 });
  await expect.poll(() => canvasCursor(page)).toBe('cell');
  await page.keyboard.up('Alt');
  await expect.poll(() => canvasCursor(page)).toBe('grab');

  // Color the focused kept view by the continuous `score`: its pane now
  // offers a value-range drag, while the live pane still offers a category.
  await page.locator('#continuous-field').selectOption({ label: 'score' });
  await expect.poll(() => focusedFieldKindOf(page)).toBe('continuous');
  await releaseFormFocus();
  await page.mouse.move(keptPoint.x, keptPoint.y);
  await page.keyboard.down('Alt');
  await expect.poll(() => canvasCursor(page)).toBe('ns-resize');
  await page.mouse.move(livePoint.x, livePoint.y, { steps: 4 });
  await expect.poll(() => canvasCursor(page)).toBe('cell');
  await page.keyboard.up('Alt');

  expect(await focusOf(page)).toEqual({ viewer: keptId, state: keptId });
  expect(productErrors).toEqual([]);
});
