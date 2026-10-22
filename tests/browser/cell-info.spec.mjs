/**
 * Cell info: the hover card switched on under Coloring & filtering → Legend (ui/modules/cell-info.js).
 *
 * The card's promises are behavioural, and each one is held here against the
 * running app: it is off until switched on; it names the value the pane under
 * the pointer is coloured by; it never picks while the camera is being dragged;
 * it picks at most once per animation frame however fast the pointer moves; it
 * follows panes in a grid; and on a touch screen it answers a held press.
 */
import { expect, test } from './helpers/test.mjs';
import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

const DATASET_URL = `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}&dataset=current-ui-prepared`;

async function openDataset(page) {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI prepared fixture');
  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
  await expect(page.locator('.legend-item')).toHaveCount(3);
}

/** A canvas point over a pickable cell, optionally inside one pane. */
async function findCell(page, viewId = null) {
  const point = await page.evaluate(wantedView => {
    const viewer = window._cellucidViewer;
    for (let y = 80; y < innerHeight - 220; y += 4) {
      for (let x = 20; x < innerWidth - 20; x += 4) {
        const hit = document.elementFromPoint(x, y);
        if (!hit || hit.id !== 'glcanvas') continue;
        const record = viewer.pickCellRecordAtScreen(x, y);
        if (record === null) continue;
        if (wantedView !== null && record.viewId !== wantedView) continue;
        return { x, y, viewId: record.viewId, cellIndex: record.cellIndex };
      }
    }
    return null;
  }, viewId);
  expect(point).not.toBeNull();
  return point;
}

/** The category label the colouring field of a pane gives one cell. */
function expectedLabel(page, { viewId, cellIndex }) {
  return page.evaluate(({ viewId: id, cellIndex: index }) => {
    const field = window._cellucidState.getFieldForView(id);
    return String(field.categories[field.codes[index]]);
  }, { viewId, cellIndex });
}

/** Count the card's picks from here on. */
async function countPicks(page) {
  await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    if (viewer.__pickCount !== undefined) {
      viewer.__pickCount = 0;
      return;
    }
    const original = viewer.pickReadyCellRecordAtScreen.bind(viewer);
    viewer.__pickCount = 0;
    viewer.pickReadyCellRecordAtScreen = (x, y) => {
      viewer.__pickCount += 1;
      return original(x, y);
    };
  });
  return () => page.evaluate(() => window._cellucidViewer.__pickCount);
}

/**
 * 'still' once the camera has stopped; otherwise why it is still moving, so a
 * poll that times out names the cause.
 *
 * Polls on it keep the suite's expect timeout. Coming to rest is counted in
 * frames, not seconds: inertia decays once per frame, each frame advancing it
 * by at most MAX_FRAME_DT (0.25 s), and the presented camera then needs two
 * unchanged frames to settle. A renderer drawing a frame every 1.5-2 s (hosted
 * macOS Firefox) needs longer than a fixed ten seconds for a release with a
 * fling, while the camera is behaving exactly as designed.
 */
function cameraMotion(page) {
  return page.evaluate(() => {
    const viewer = window._cellucidViewer;
    if (!viewer.isCameraInMotion()) return 'still';
    return `moving: ${JSON.stringify(viewer.getFrameScheduleState())}`;
  });
}

async function enable(page) {
  await page.locator('#cell-info-toggle').check();
}

test('cell info is on by default; unticked, a hover shows nothing', async ({ page }) => {
  await openDataset(page);
  await expect(page.locator('#cell-info-toggle')).toBeChecked();
  await expect(page.locator('#cell-info-categories-toggle')).toBeEnabled();
  await page.locator('#cell-info-toggle').uncheck();
  // Its option means nothing while the card is off.
  await expect(page.locator('#cell-info-categories-toggle')).toBeDisabled();
  const cell = await findCell(page);
  await page.mouse.move(cell.x - 10, cell.y - 10);
  await page.mouse.move(cell.x, cell.y, { steps: 3 });
  await page.waitForTimeout(300);
  await expect(page.locator('#cell-info-card')).toBeHidden();
});

test('a hover names the value the pane is coloured by, and leaving hides it', async ({ page }) => {
  await openDataset(page);
  await enable(page);
  const cell = await findCell(page);
  await page.mouse.move(cell.x - 10, cell.y - 10);
  await page.mouse.move(cell.x, cell.y, { steps: 3 });
  const card = page.locator('#cell-info-card');
  await expect(card).toBeVisible();
  await expect(card.locator('.cell-info-value')).toHaveText(await expectedLabel(page, cell));
  await expect(card.locator('.cell-info-field')).toHaveText('cell_type');
  // The count is what selecting this category in this pane would pick.
  const expectedCount = await page.evaluate(({ viewId, cellIndex }) => {
    const field = window._cellucidState.getFieldForView(viewId);
    const visible = window._cellucidViewer.getViewTransparency(viewId);
    const code = field.codes[cellIndex];
    let count = 0;
    for (let i = 0; i < field.codes.length; i++) {
      if (field.codes[i] === code && visible[i] > 0) count++;
    }
    return count;
  }, cell);
  await expect(card.locator('.cell-info-count')).toHaveText(`${expectedCount} cells`);
  await expect(card).not.toContainText(/Cell \d/);
  await expect(card).toHaveCSS('pointer-events', 'none');

  // Off the canvas, the card goes.
  await page.locator('#sidebar').hover();
  await expect(card).toBeHidden();

  // Switching it off removes it at once, even under a resting pointer.
  await page.mouse.move(cell.x, cell.y);
  await expect(card).toBeVisible();
  await page.locator('#cell-info-toggle').uncheck();
  await expect(card).toBeHidden();
});

test('a continuous field shows its value on the colour scale', async ({ page }) => {
  await openDataset(page);
  await page.locator('#continuous-field').selectOption({ label: 'score' });
  await enable(page);
  const cell = await findCell(page);
  await page.mouse.move(cell.x - 10, cell.y - 10);
  await page.mouse.move(cell.x, cell.y, { steps: 3 });
  const card = page.locator('#cell-info-card');
  await expect(card).toBeVisible();
  const value = await page.evaluate(({ viewId, cellIndex }) => (
    window._cellucidState.getFieldForView(viewId).values[cellIndex]
  ), cell);
  await expect(card.locator('.cell-info-field')).toHaveText('score');
  expect(Number(await card.locator('.cell-info-value').textContent()))
    .toBeCloseTo(value, 3);
  await expect(card.locator('.cell-info-scale')).toBeVisible();
  // Only the field the pane is coloured by: nothing left over from the
  // categorical field shown before, and no category count.
  await expect(card).not.toContainText('cell_type');
  await expect(card.locator('.cell-info-count')).toBeHidden();

  // Show recent fields, when asked for, lists the loaded categorical field too.
  await page.locator('#cell-info-categories-toggle').check();
  await page.mouse.move(cell.x + 1, cell.y);
  await page.mouse.move(cell.x, cell.y);
  await expect(card.locator('.cell-info-rows dt')).toHaveText(['cell_type']);
  await page.locator('#cell-info-categories-toggle').uncheck();
  await page.mouse.move(cell.x + 1, cell.y);
  await page.mouse.move(cell.x, cell.y);
  await expect(card.locator('.cell-info-rows')).toBeHidden();
});

test('no pick runs while the camera is dragged or the pointer sweeps; one runs on rest', async ({ page }) => {
  await openDataset(page);
  await enable(page);
  const cell = await findCell(page);
  const picks = await countPicks(page);

  // A drag: the card goes and nothing is picked until the camera settles.
  await page.mouse.move(cell.x, cell.y);
  await page.mouse.down();
  const before = await picks();
  for (let step = 1; step <= 12; step++) {
    await page.mouse.move(cell.x + step * 6, cell.y + step * 3);
  }
  expect(await picks()).toBe(before);
  await expect(page.locator('#cell-info-card')).toBeHidden();
  await page.mouse.up();

  // Once the camera settles, the pointer resting where the drag ended costs
  // exactly one lookup, whether or not it lands on a cell: the release and the
  // rest that follows it look up the same spot of the same scene once.
  await expect.poll(() => cameraMotion(page)).toBe('still');
  await expect.poll(async () => (await picks()) - before).toBe(1);

  // A sweep costs no pick at all; the pointer coming to rest costs one.
  const start = await picks();
  // One sweep, in one task: the moves themselves cost no pick, and the frames
  // that follow cost none either until the pointer has rested. (Two sweeps
  // with a pause between them would be two rests, and two lookups.)
  const sweep = await page.evaluate(({ x, y }) => new Promise(resolve => {
    const canvas = document.getElementById('glcanvas');
    const viewer = window._cellucidViewer;
    const before = viewer.__pickCount;
    for (let index = 0; index < 120; index++) {
      canvas.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        pointerType: 'mouse',
        clientX: x + (index % 7) * 3,
        clientY: y + (index % 5) * 3,
      }));
    }
    const duringMoves = viewer.__pickCount - before;
    let frames = 0;
    const tick = () => {
      frames += 1;
      if (frames === 3) resolve({ duringMoves, frames });
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), cell);
  expect(sweep.duringMoves).toBe(0);
  expect(sweep.frames).toBe(3);
  await expect.poll(async () => (await picks()) - start, { timeout: 5_000 }).toBe(1);
});

/** What selecting the cell's category in its pane would pick. */
function selectionCount(page, { viewId, cellIndex }) {
  return page.evaluate(({ viewId: id, cellIndex: index }) => {
    const field = window._cellucidState.getFieldForView(id);
    // The rule the annotation tool applies (getCellIndicesForCategory): the
    // cell's category, among the cells visible in that pane.
    const visible = window._cellucidViewer.getViewTransparency(id);
    const code = field.codes[index];
    let count = 0;
    for (let i = 0; i < field.codes.length; i++) {
      if (field.codes[i] === code && visible[i] >= 0.5) count++;
    }
    return count;
  }, { viewId, cellIndex });
}

async function hoverAndRest(page, cell) {
  await page.mouse.move(cell.x - 12, cell.y - 12);
  await page.mouse.move(cell.x, cell.y, { steps: 3 });
  await expect(page.locator('#cell-info-card')).toBeVisible();
}

test('the card comes back after a selection tool has handled a press', async ({ page }) => {
  await openDataset(page);
  const cell = await findCell(page);
  // An Alt+click with the annotation tool: the tool owns that press and its
  // release. The card used to stay suppressed for good after it.
  await page.keyboard.down('Alt');
  await page.mouse.click(cell.x, cell.y);
  await page.keyboard.up('Alt');
  await page.mouse.move(cell.x + 40, cell.y + 40);
  await hoverAndRest(page, cell);
  // A drag that started on the plot and ended off it, too. The drag pans the
  // camera, so the cell is looked up again once it has settled.
  await page.mouse.move(cell.x, cell.y);
  await page.mouse.down();
  // Off the plot onto the sidebar in a few moves. The pause before the release
  // is what keeps it from reading as a fling (a release more than 50 ms after
  // the last move hands the camera no inertia), and the pan is the total
  // distance however it is divided: more steps would only add moves, each of
  // which waits for a redrawn frame on a slow renderer.
  const sidebar = await page.locator('#sidebar').boundingBox();
  await page.mouse.move(sidebar.x + sidebar.width - 20, cell.y, { steps: 4 });
  await page.waitForTimeout(100);
  await page.mouse.up();
  await expect.poll(() => cameraMotion(page)).toBe('still');
  await hoverAndRest(page, await findCell(page));
});

test('a shortcut, a focus change or a lost release never leaves the card off', async ({ page }) => {
  await openDataset(page);
  const cell = await findCell(page);
  const inMotion = () => page.evaluate(() => window._cellucidViewer.isCameraInMotion());
  const keyEvent = (type, init) => page.evaluate(([eventType, eventInit]) => {
    window.dispatchEvent(new KeyboardEvent(eventType, { bubbles: true, ...eventInit }));
  }, [type, init]);
  // Held keys and drags move the camera, so the cell is found again each time.
  const rest = async () => {
    await expect.poll(inMotion).toBe(false);
    const target = await findCell(page);
    await page.mouse.move(target.x + 40, target.y + 40);
    await hoverAndRest(page, target);
  };

  // Cmd+Shift+4 on macOS: the screenshot overlay takes the keys, and no keyup
  // arrives for a key pressed while Cmd was held, only Cmd's own.
  await keyEvent('keydown', { key: 'Meta', code: 'MetaLeft', metaKey: true });
  await keyEvent('keydown', { key: 'Shift', code: 'ShiftLeft', metaKey: true, shiftKey: true });
  await keyEvent('keydown', { key: '$', code: 'Digit4', metaKey: true, shiftKey: true });
  await keyEvent('keyup', { key: 'Meta', code: 'MetaLeft' });
  expect(await inMotion()).toBe(false);
  await rest();

  // A movement key held while the window loses focus never sends its keyup.
  await keyEvent('keydown', { key: 'w', code: 'KeyW' });
  expect(await inMotion()).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect.poll(inMotion).toBe(false);
  await rest();

  // Shift only speeds a movement key up; held alone it moves nothing, and the
  // selection modifiers it combines with must not hide the card.
  await page.keyboard.down('Shift');
  expect(await inMotion()).toBe(false);
  await page.keyboard.up('Shift');
  await rest();

  // A drag released outside the page: the next move arrives with no button.
  await page.mouse.move(cell.x, cell.y);
  await page.mouse.down();
  await page.mouse.move(cell.x + 6, cell.y + 4, { steps: 3 });
  expect(await inMotion()).toBe(true);
  await page.evaluate(({ x, y }) => {
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y, buttons: 0 }));
  }, { x: cell.x + 8, y: cell.y + 5 });
  await expect.poll(inMotion).toBe(false);
  await page.mouse.up();
  await rest();
});

test('in every pane the count follows that pane\'s filters, as selecting would', async ({ page }) => {
  await openDataset(page);
  await openCollapsedPanels(page);
  await page.locator('#split-keep-view-btn').click();
  await expect.poll(() => page.evaluate(() => (
    window._cellucidViewer.getSnapshotViews().length
  ))).toBe(1);
  // The kept view is active: hide one category there only.
  await page.locator('.legend-item').filter({ hasText: 'beta' }).locator('.legend-checkbox').uncheck();
  for (const viewId of ['live', 'snap_1']) {
    const cell = await findCell(page, viewId);
    await hoverAndRest(page, cell);
    const expected = await selectionCount(page, cell);
    expect(expected).toBeGreaterThan(0);
    await expect(page.locator('#cell-info-card .cell-info-count')).toHaveText(`${expected} cells`);
    // A hidden cell is never the one under the pointer.
    expect(await expectedLabel(page, cell)).not.toBe(viewId === 'snap_1' ? 'beta' : '');
  }
});

test('with level of detail on, only drawn cells are read and counts still follow filters', async ({ page }) => {
  await openDataset(page);
  await openCollapsedPanels(page);
  await page.locator('#hp-lod-enabled').check();
  await expect(page.locator('#lod-force-container')).toBeVisible();
  const cell = await findCell(page);
  await hoverAndRest(page, cell);
  await expect(page.locator('#cell-info-card .cell-info-value')).toHaveText(await expectedLabel(page, cell));
  await expect(page.locator('#cell-info-card .cell-info-count'))
    .toHaveText(`${await selectionCount(page, cell)} cells`);
});

test('in a grid, the card reads the pane under the pointer, naming its field once', async ({ page }) => {
  await openDataset(page);
  await openCollapsedPanels(page);
  await page.locator('#split-keep-view-btn').click();
  await expect.poll(() => page.evaluate(() => (
    window._cellucidViewer.getSnapshotViews().length
  ))).toBe(1);
  await enable(page);
  const titles = page.locator('.view-title-chip');
  await expect(titles).toHaveCount(2);
  for (const viewId of ['live', 'snap_1']) {
    const cell = await findCell(page, viewId);
    await page.mouse.move(cell.x - 10, cell.y - 10);
    await page.mouse.move(cell.x, cell.y, { steps: 3 });
    const card = page.locator('#cell-info-card');
    await expect(card).toBeVisible();
    await expect(card.locator('.cell-info-value')).toHaveText(await expectedLabel(page, cell));
    // The field, once: the pane's own title chip already names the pane.
    await expect(card.locator('.cell-info-field')).toHaveText('cell_type');
    await expect(card).toHaveText(/^[^]*cell_type$/);
    expect((await card.innerText()).match(/cell_type/g)).toHaveLength(1);
  }
});

test.describe('touch', () => {
  test.use({ hasTouch: true });

  test('a held press shows the card, a tap does not, the next touch clears it', async ({ page }) => {
    await openDataset(page);
    await enable(page);
    const cell = await findCell(page);
    const touch = (type, pointerId) => page.evaluate(({ x, y, type: kind, id }) => {
      document.getElementById('glcanvas').dispatchEvent(new PointerEvent(kind, {
        bubbles: true,
        cancelable: true,
        pointerType: 'touch',
        pointerId: id,
        isPrimary: true,
        clientX: x,
        clientY: y,
      }));
    }, { x: cell.x, y: cell.y, type, id: pointerId });
    const card = page.locator('#cell-info-card');

    // A quick tap: no card.
    await touch('pointerdown', 11);
    await touch('pointerup', 11);
    await page.waitForTimeout(700);
    await expect(card).toBeHidden();

    // A held press: the card, which stays after the finger lifts.
    await touch('pointerdown', 12);
    await expect(card).toBeVisible();
    await expect(card.locator('.cell-info-value')).toHaveText(await expectedLabel(page, cell));
    await touch('pointerup', 12);
    await page.waitForTimeout(300);
    await expect(card).toBeVisible();

    // The next touch takes it away.
    await touch('pointerdown', 13);
    await expect(card).toBeHidden();
    await touch('pointerup', 13);
  });
});
