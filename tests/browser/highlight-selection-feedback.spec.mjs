import { expect, test } from './helpers/test.mjs';
import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const PREPARED_DATASET_URL =
  `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}`
  + '&dataset=current-ui-prepared&acceptance=highlight-selection-feedback-ci';

const MODE_DESCRIPTION = '#highlight-mode-description';

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

async function openPreparedDataset(page) {
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture'
  );
  await expect(page.locator('#filter-count')).toHaveText(
    'Showing all 120 points'
  );
}

/**
 * Colour by `cell_type` and wait until the field is actually live.
 *
 * The field loads asynchronously; an Alt gesture issued before the viewer has
 * left `highlightMode === 'none'` is discarded before any tool sees it.
 */
async function colourByCellType(page) {
  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
  await expect(page.locator('.legend-item')).toHaveCount(3);
  await expect.poll(
    () => page.evaluate(() => window._cellucidViewer.getHighlightMode()),
  ).toBe('categorical');
}

/** Screen point the viewer's own picker resolves to no cell at all. */
async function findEmptyPoint(page) {
  const point = await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    for (let y = 40; y < 980; y += 5) {
      for (let x = 340; x < 1430; x += 5) {
        if (viewer.pickCellAtScreen(x, y) < 0) return { x, y };
      }
    }
    return null;
  });
  expect(point).not.toBeNull();
  return point;
}

/** Screen point that the viewer's own picker resolves to a cell. */
async function findCellPoints(page, limit) {
  const points = await page.evaluate(max => {
    const viewer = window._cellucidViewer;
    const found = [];
    const seen = new Set();
    for (let y = 40; y < 980; y += 5) {
      for (let x = 340; x < 1430; x += 5) {
        const cellIndex = viewer.pickCellAtScreen(x, y);
        if (cellIndex >= 0 && !seen.has(cellIndex)) {
          seen.add(cellIndex);
          found.push({ x, y, cellIndex });
          if (found.length >= max) return found;
        }
      }
    }
    return found;
  }, limit);
  expect(points.length).toBe(limit);
  return points;
}

async function altClick(page, point) {
  await page.mouse.move(point.x, point.y);
  await page.keyboard.down('Alt');
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await page.mouse.move(point.x + 40, point.y + 40);
}

async function altDraw(page, corners) {
  await page.mouse.move(corners[0][0], corners[0][1]);
  await page.keyboard.down('Alt');
  await page.mouse.down();
  for (const [x, y] of corners.slice(1)) {
    await page.mouse.move(x, y, { steps: 8 });
  }
  await page.mouse.up();
  await page.keyboard.up('Alt');
}

async function altDrag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.keyboard.down('Alt');
  await page.mouse.down();
  for (let stepIndex = 1; stepIndex <= 12; stepIndex++) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * stepIndex) / 12,
      from.y + ((to.y - from.y) * stepIndex) / 12,
    );
  }
  await page.mouse.up();
  await page.keyboard.up('Alt');
}

/**
 * Repeat a gesture until it actually arms the tool.
 *
 * A synthetic pointer sequence can land while the renderer is still settling
 * its first frames, and is then dropped before any tool sees it. Retrying keeps
 * the environment's timing out of the assertions below, which are about what
 * the tool does once a gesture has landed.
 */
async function armSelection(page, tool, gesture) {
  const controls = page.locator(`#${tool}-step-controls`);
  for (let attempt = 0; attempt < 8; attempt++) {
    await gesture();
    if (await controls.count() > 0) return;
    await page.waitForTimeout(250);
  }
  await expect(controls).toBeVisible();
}

const unifiedState = page => page.evaluate(
  () => window._cellucidViewer.getUnifiedSelectionState(),
);

test(
  'Escape abandons an in-progress selection in every tool that offers Cancel',
  async ({ page }) => {
    const productErrors = observeProductErrors(page);
    await openPreparedDataset(page);
    await colourByCellType(page);
    const points = await findCellPoints(page, 4);

    // Annotation
    await armSelection(page, 'annotation', () => altClick(page, points[0]));
    expect((await unifiedState(page)).inProgress).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('#annotation-step-controls')).toHaveCount(0);
    expect(await unifiedState(page)).toMatchObject({
      inProgress: false,
      stepCount: 0,
      candidateCount: 0,
    });

    // Lasso
    await page.locator('.highlight-mode-btn[data-mode="lasso"]').click();
    await armSelection(page, 'lasso', () => altDraw(page, [
      [400, 200], [1300, 200], [1300, 900], [400, 900], [400, 200],
    ]));
    expect((await unifiedState(page)).inProgress).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('#lasso-step-controls')).toHaveCount(0);
    expect((await unifiedState(page)).inProgress).toBe(false);

    // Proximity
    await page.locator('.highlight-mode-btn[data-mode="proximity"]').click();
    await armSelection(page, 'proximity', () => altDrag(
      page,
      { x: points[1].x, y: points[1].y },
      { x: points[1].x + 140, y: points[1].y + 80 },
    ));
    expect((await unifiedState(page)).inProgress).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('#proximity-step-controls')).toHaveCount(0);
    expect((await unifiedState(page)).inProgress).toBe(false);

    expect(productErrors).toEqual([]);
  },
);

test(
  'Escape with no selection in progress stays available to the rest of the app',
  async ({ page }) => {
    const productErrors = observeProductErrors(page);
    await openPreparedDataset(page);

    // The info popover owns Escape; an idle selection tool must not eat it.
    await page.locator('#active-filter-scope-btn').click();
    await expect(page.locator('#active-filter-scope-tooltip')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#active-filter-scope-tooltip')).toBeHidden();

    expect(productErrors).toEqual([]);
  },
);

test(
  'the annotation panel names the field it needs and follows the one chosen',
  async ({ page }) => {
    const productErrors = observeProductErrors(page);
    await openPreparedDataset(page);

    // The fixture loads with no colouring field, which is when Alt+click is inert.
    await expect(page.locator('#categorical-field')).toHaveValue('-1');
    await expect(page.locator('#continuous-field')).toHaveValue('-1');
    await expect(page.locator(MODE_DESCRIPTION)).toContainText(
      'Annotation selection needs an active field',
    );
    await expect(page.locator(MODE_DESCRIPTION)).not.toContainText(
      'Alt+click a cell to select',
    );

    const points = await findCellPoints(page, 1);
    await altClick(page, points[0]);
    await expect(page.locator(MODE_DESCRIPTION)).toContainText(
      'Annotation selection needs an active field',
    );

    await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
    await expect(page.locator(MODE_DESCRIPTION)).toContainText(
      'Alt+click a cell to select',
    );
    await expect(page.locator(MODE_DESCRIPTION)).not.toContainText(
      'needs an active field',
    );

    await page.locator('#categorical-field').selectOption({ label: 'None' });
    await expect(page.locator(MODE_DESCRIPTION)).toContainText(
      'Annotation selection needs an active field',
    );

    expect(productErrors).toEqual([]);
  },
);

test(
  'repeating a gesture that selects the same cells costs one step and one undo',
  async ({ page }) => {
    const productErrors = observeProductErrors(page);
    await openPreparedDataset(page);
    await colourByCellType(page);
    const points = await findCellPoints(page, 1);

    await armSelection(page, 'annotation', () => altClick(page, points[0]));
    for (let click = 0; click < 5; click++) {
      await altClick(page, points[0]);
      await expect(page.locator('#annotation-step-controls')).toBeVisible();
    }

    await expect(page.locator(MODE_DESCRIPTION)).toContainText('Step 1:');
    await expect(page.locator(MODE_DESCRIPTION)).toContainText(
      'That gesture did not change the selection.',
    );
    expect(await unifiedState(page)).toMatchObject({
      inProgress: true,
      stepCount: 1,
      candidateCount: 40,
    });

    // One undo, and the tool is back where it started.
    await expect(page.locator('#annotation-undo-btn')).toBeEnabled();
    await page.locator('#annotation-undo-btn').click();
    await expect(page.locator('#annotation-undo-btn')).toBeDisabled();
    expect((await unifiedState(page)).inProgress).toBe(false);

    expect(productErrors).toEqual([]);
  },
);

test(
  'redrawing the same lasso does not advance the step counter',
  async ({ page }) => {
    const productErrors = observeProductErrors(page);
    await openPreparedDataset(page);
    await colourByCellType(page);
    await page.locator('.highlight-mode-btn[data-mode="lasso"]').click();

    const polygon = [
      [400, 200], [1300, 200], [1300, 900], [400, 900], [400, 200],
    ];
    await armSelection(page, 'lasso', () => altDraw(page, polygon));
    const first = await unifiedState(page);
    expect(first.stepCount).toBe(1);

    await altDraw(page, polygon);
    await altDraw(page, polygon);

    await expect(page.locator(MODE_DESCRIPTION)).toContainText(
      'That gesture did not change the selection.',
    );
    expect(await unifiedState(page)).toMatchObject({
      inProgress: true,
      stepCount: 1,
      candidateCount: first.candidateCount,
    });

    expect(productErrors).toEqual([]);
  },
);

test(
  'the step controls are reachable by keyboard and never strand focus',
  async ({ page }) => {
    const productErrors = observeProductErrors(page);
    await openPreparedDataset(page);
    await colourByCellType(page);
    const points = await findCellPoints(page, 2);

    await armSelection(page, 'annotation', () => altClick(page, points[0]));

    // Glyph buttons carry no readable text, so their names come from aria-label.
    await expect(page.locator('#annotation-undo-btn')).toHaveAttribute(
      'aria-label',
      'Undo last selection step',
    );
    await expect(page.locator('#annotation-redo-btn')).toHaveAttribute(
      'aria-label',
      'Redo last selection step',
    );
    await expect(page.locator('#annotation-cancel-btn')).toHaveAttribute(
      'aria-keyshortcuts',
      'Escape',
    );
    await expect(page.locator('#annotation-cancel-btn')).toHaveAttribute(
      'title',
      /\(Esc\)/,
    );

    const focusedMode = () => page.evaluate(() => {
      const active = document.activeElement;
      if (active === null) return null;
      return {
        mode: active.dataset === undefined ? null : active.dataset.mode ?? null,
        pressed: active.getAttribute('aria-pressed'),
        tag: active.tagName,
      };
    });

    await page.locator('#annotation-cancel-btn').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#annotation-step-controls')).toHaveCount(0);
    expect(await focusedMode()).toEqual({
      mode: 'annotation',
      pressed: 'true',
      tag: 'BUTTON',
    });

    await armSelection(page, 'annotation', () => altClick(page, points[1]));
    await page.locator('#annotation-confirm-btn').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#annotation-step-controls')).toHaveCount(0);
    await expect(page.locator('#highlight-count')).toContainText(
      'cells highlighted',
    );
    expect(await focusedMode()).toEqual({
      mode: 'annotation',
      pressed: 'true',
      tag: 'BUTTON',
    });

    expect(productErrors).toEqual([]);
  },
);

test(
  'every mode button keeps the aria-pressed contract across mode switches',
  async ({ page }) => {
    const productErrors = observeProductErrors(page);
    await openPreparedDataset(page);

    const pressedState = () => page.evaluate(
      () => [...document.querySelectorAll('.highlight-mode-btn')].map(button => [
        button.dataset.mode,
        button.getAttribute('aria-pressed'),
      ]),
    );

    for (const mode of ['knn', 'proximity', 'lasso', 'annotation']) {
      await page.locator(`.highlight-mode-btn[data-mode="${mode}"]`).click();
      expect(await pressedState()).toEqual([
        ['annotation', mode === 'annotation' ? 'true' : 'false'],
        ['knn', mode === 'knn' ? 'true' : 'false'],
        ['proximity', mode === 'proximity' ? 'true' : 'false'],
        ['lasso', mode === 'lasso' ? 'true' : 'false'],
      ]);
    }

    // Space activates a focused mode button, and the contract holds for it too.
    await page.locator('.highlight-mode-btn[data-mode="lasso"]').focus();
    await page.keyboard.press('Space');
    expect(await pressedState()).toEqual([
      ['annotation', 'false'],
      ['knn', 'false'],
      ['proximity', 'false'],
      ['lasso', 'true'],
    ]);

    expect(productErrors).toEqual([]);
  },
);

// ---------------------------------------------------------------------------
// A gesture the renderer consumed and could not turn into a step
// ---------------------------------------------------------------------------

const MISSED_CELL_NOTICE = 'That click did not land on a cell';
const OFF_VIEW_NOTICE = 'That gesture ended outside the view';

test(
  'an Alt+click that lands on no cell says so instead of doing nothing at all',
  async ({ page }) => {
    const productErrors = observeProductErrors(page);
    await openPreparedDataset(page);
    await colourByCellType(page);
    const cell = (await findCellPoints(page, 1))[0];
    const empty = await findEmptyPoint(page);

    // Points draw around a pixel wide, so this is the everyday gesture: the
    // user aims at a group and lands beside it.
    await altClick(page, empty);
    await expect(page.locator(MODE_DESCRIPTION)).toContainText(
      MISSED_CELL_NOTICE,
    );
    await expect(page.locator(MODE_DESCRIPTION)).toContainText(
      'Alt+click a cell to select',
    );
    expect(await unifiedState(page)).toMatchObject({
      inProgress: false,
      stepCount: 0,
      candidateCount: 0,
    });

    // Repeating it must not stack a second line onto the panel.
    const afterOneMiss = await page.locator(MODE_DESCRIPTION).innerHTML();
    await altClick(page, empty);
    await altClick(page, empty);
    expect(await page.locator(MODE_DESCRIPTION).innerHTML()).toBe(afterOneMiss);

    // A miss in the middle of a selection leaves that selection standing, and
    // says so over the top of it.
    await armSelection(page, 'annotation', () => altClick(page, cell));
    const armed = await unifiedState(page);
    expect(armed.candidateCount).toBeGreaterThan(0);

    await altClick(page, empty);
    await expect(page.locator(MODE_DESCRIPTION)).toContainText(
      MISSED_CELL_NOTICE,
    );
    await expect(page.locator(MODE_DESCRIPTION)).toContainText('Step 1:');
    await expect(page.locator('#annotation-step-controls')).toBeVisible();
    expect(await unifiedState(page)).toMatchObject({
      inProgress: true,
      stepCount: armed.stepCount,
      candidateCount: armed.candidateCount,
    });

    expect(productErrors).toEqual([]);
  },
);

test(
  'a lasso that encloses no cells lands as the step the user drew',
  async ({ page }) => {
    const productErrors = observeProductErrors(page);
    await openPreparedDataset(page);
    await colourByCellType(page);
    await page.locator('.highlight-mode-btn[data-mode="lasso"]').click();

    await armSelection(page, 'lasso', () => altDraw(page, [
      [400, 200], [1300, 200], [1300, 900], [400, 900], [400, 200],
    ]));
    expect((await unifiedState(page)).candidateCount).toBeGreaterThan(0);

    // A rectangle the picker resolves to nothing anywhere inside it.
    const emptyBox = await page.evaluate(() => {
      const viewer = window._cellucidViewer;
      for (let top = 60; top < 860; top += 20) {
        for (let left = 360; left < 1300; left += 20) {
          let clean = true;
          for (let y = top; y <= top + 120 && clean; y += 4) {
            for (let x = left; x <= left + 120; x += 4) {
              if (viewer.pickCellAtScreen(x, y) >= 0) {
                clean = false;
                break;
              }
            }
          }
          if (clean) return { left, top };
        }
      }
      return null;
    });
    expect(emptyBox).not.toBeNull();

    await altDraw(page, [
      [emptyBox.left + 10, emptyBox.top + 10],
      [emptyBox.left + 110, emptyBox.top + 10],
      [emptyBox.left + 110, emptyBox.top + 110],
      [emptyBox.left + 10, emptyBox.top + 110],
      [emptyBox.left + 10, emptyBox.top + 10],
    ]);

    // Intersecting down to zero is an outcome the user drew on purpose, so it
    // is a step, it is reported, and one Undo takes it back.
    await expect(page.locator(MODE_DESCRIPTION)).toContainText('Step 2:');
    await expect(page.locator(MODE_DESCRIPTION)).toContainText('0 cells');
    expect(await unifiedState(page)).toMatchObject({
      inProgress: true,
      stepCount: 2,
      candidateCount: 0,
    });
    await expect(page.locator('#lasso-confirm-btn')).toBeDisabled();
    await expect(page.locator('#lasso-undo-btn')).toBeEnabled();

    await page.locator('#lasso-undo-btn').click();
    expect((await unifiedState(page)).candidateCount).toBeGreaterThan(0);

    expect(productErrors).toEqual([]);
  },
);

test(
  'a drag that lets go on the sidebar is retired, not committed',
  async ({ page }) => {
    const productErrors = observeProductErrors(page);
    await openPreparedDataset(page);
    await colourByCellType(page);
    await page.locator('.highlight-mode-btn[data-mode="lasso"]').click();

    const modeButton = page.locator('.highlight-mode-btn[data-mode="knn"]');
    await modeButton.scrollIntoViewIfNeeded();
    const box = await modeButton.boundingBox();
    expect(box).not.toBeNull();

    // Draw across the plot, wander onto the sidebar, and release over a
    // control. The polygon behind the sidebar covers cells the user cannot
    // even see, so committing it would select something never drawn.
    await page.mouse.move(500, 300);
    await page.keyboard.down('Alt');
    await page.mouse.down();
    for (const [x, y] of [[1000, 300], [1000, 700], [600, 700]]) {
      await page.mouse.move(x, y, { steps: 8 });
    }
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
      steps: 10,
    });
    await page.mouse.up();
    await page.keyboard.up('Alt');

    await expect(page.locator(MODE_DESCRIPTION)).toContainText(OFF_VIEW_NOTICE);
    await expect(page.locator('#lasso-step-controls')).toHaveCount(0);
    expect(await unifiedState(page)).toMatchObject({
      inProgress: false,
      stepCount: 0,
      candidateCount: 0,
    });

    expect(productErrors).toEqual([]);
  },
);
