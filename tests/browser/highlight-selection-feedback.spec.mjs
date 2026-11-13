import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { armSelection } from './helpers/selection-gesture.mjs';

const PREPARED_DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`
  + '&dataset=current-ui&acceptance=highlight-selection-feedback-ci';

const MODE_DESCRIPTION = '#highlight-mode-description';
const OFF_VIEW_NOTICE = 'That gesture ended outside the view';

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
    'Current UI fixture'
  );
  await expect(page.locator('#filter-count')).toHaveText(
    'Showing all 120 cells'
  );
}

/**
 * Color by `cell_type` and wait until the field is actually live.
 *
 * The field loads asynchronously; an Alt gesture issued before the state holds
 * it lands in a pane colored by no field and selects nothing.
 */
async function colorByCellType(page) {
  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
  await expect(page.locator('.legend-item')).toHaveCount(3);
  // An annotation press reads the pressed pane's field from the state, so
  // the field is live for Alt+click once the state holds it.
  await expect.poll(
    () => page.evaluate(() => window._cellucidState.getActiveField()?.kind),
  ).toBe('category');
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

/**
 * Draw a lasso through `corners` with Alt held. Each edge is two moves: the
 * polygon is the corners whatever lies between them on a straight edge, so
 * more moves would not change what the lasso encloses. They would only add
 * lasso previews, each redrawing the scene, and every pointer move waits for
 * that frame where a renderer takes a second or more to draw one.
 */
async function altDraw(page, corners) {
  await page.mouse.move(corners[0][0], corners[0][1]);
  await page.keyboard.down('Alt');
  await page.mouse.down();
  for (const [x, y] of corners.slice(1)) {
    await page.mouse.move(x, y, { steps: 2 });
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

const unifiedState = page => page.evaluate(
  () => {
    // The candidates are a cell list (Uint32Array); hand them over as numbers.
    const state = window._cellucidViewer.getUnifiedSelectionState();
    return { ...state, candidates: Array.from(state.candidates) };
  },
);

test(
  'a selection walked through every tool: Escape, the step controls by keyboard, an empty lasso, a drag let go on the sidebar',
  async ({ page }) => {
    const productErrors = observeProductErrors(page);
    await openPreparedDataset(page);
    await colorByCellType(page);
    const points = await findCellPoints(page, 4);

    await test.step('Escape abandons an in-progress selection in every tool that offers Cancel', async () => {
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
    });

    await test.step('the step controls are reachable by keyboard and never strand focus', async () => {
      await page.locator('.highlight-mode-btn[data-mode="annotation"]').click();
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
    });

    await test.step('a lasso that encloses no cells lands as the step the user drew', async () => {
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

      // Cancel, so the next step starts with nothing in progress.
      await page.keyboard.press('Escape');
      await expect(page.locator('#lasso-step-controls')).toHaveCount(0);
    });

    await test.step('a drag that lets go on the sidebar is retired, not committed', async () => {
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
    });
  },
);
