/**
 * A touch screen has no Alt key, and every highlight tool used to start only
 * from an Alt press, so a phone or tablet could not select a single cell.
 * Select mode is the on-screen stand-in: while it is on, one finger runs the
 * active tool exactly as an Alt press does, and two fingers still pinch and
 * pan the camera. With it off, nothing a mouse or a finger does has changed.
 *
 * Taps go through `page.touchscreen.tap`, the browser's own touch input. Drags
 * are dispatched as touch PointerEvents, which every engine builds the same
 * way (WebKit cannot construct a TouchEvent from script); they reach the same
 * canvas listeners a finger's pointers do.
 */

import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`
  + '&dataset=current-ui&acceptance=touch-selection-ci';

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

async function colourByCellType(page) {
  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
  await expect(page.locator('.legend-item')).toHaveCount(3);
  // An annotation press reads the pressed pane's field from the state, so
  // the field is live for Alt+click once the state holds it.
  await expect.poll(
    () => page.evaluate(() => window._cellucidState.getActiveField()?.kind),
  ).toBe('category');
}

async function closeSidebar(page) {
  await page.locator('#sidebar-toggle').tap();
  await expect(page.locator('#sidebar')).toHaveClass(/\bhidden\b/);
}

async function openSidebar(page) {
  await page.locator('#sidebar-toggle').tap();
  await expect(page.locator('#sidebar')).not.toHaveClass(/\bhidden\b/);
}

/** Screen points the viewer's own picker resolves to distinct cells. */
async function findCellPoints(page, limit, region = null) {
  const points = await page.evaluate(({ max, area }) => {
    const viewer = window._cellucidViewer;
    const box = area ?? { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    const found = [];
    const seen = new Set();
    for (let y = box.top + 60; y < box.bottom - 90; y += 4) {
      for (let x = box.left + 20; x < box.right - 20; x += 4) {
        const hit = document.elementFromPoint(x, y);
        if (hit === null || hit.id !== 'glcanvas') continue;
        const cellIndex = viewer.pickCellAtScreen(x, y);
        if (cellIndex >= 0 && !seen.has(cellIndex)) {
          seen.add(cellIndex);
          found.push({ x, y, cellIndex });
          if (found.length >= max) return found;
        }
      }
    }
    return found;
  }, { max: limit, area: region });
  expect(points.length).toBe(limit);
  return points;
}

/**
 * Dispatch one multi-finger gesture as touch PointerEvents on the canvas.
 *
 * `fingers` is one path per finger; every path has the same number of points.
 * Finger `i` lands at `landAt[i]` steps into the gesture, so a second finger
 * can arrive after the first has started drawing.
 */
async function touchGesture(page, fingers, landAt = fingers.map(() => 0)) {
  await page.evaluate(({ paths, starts }) => {
    const canvas = document.getElementById('glcanvas');
    const fire = (type, index, point) => canvas.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: 40 + index,
      pointerType: 'touch',
      isPrimary: index === 0,
      button: type === 'pointermove' ? -1 : 0,
      buttons: type === 'pointerup' ? 0 : 1,
      width: 12,
      height: 12,
      pressure: type === 'pointerup' ? 0 : 0.5,
      clientX: point.x,
      clientY: point.y,
    }));
    const steps = paths[0].length;
    for (let step = 0; step < steps; step++) {
      paths.forEach((path, index) => {
        if (step === starts[index]) fire('pointerdown', index, path[step]);
        else if (step > starts[index]) fire('pointermove', index, path[step]);
      });
    }
    paths.forEach((path, index) => fire('pointerup', index, path[steps - 1]));
  }, { paths: fingers, starts: landAt });
}

function line(from, to, steps = 16) {
  return Array.from({ length: steps + 1 }, (_, i) => ({
    x: from.x + ((to.x - from.x) * i) / steps,
    y: from.y + ((to.y - from.y) * i) / steps,
  }));
}

function loop(corners, stepsPerSide = 8) {
  const points = [];
  for (let i = 0; i < corners.length - 1; i++) {
    const side = line(corners[i], corners[i + 1], stepsPerSide);
    points.push(...(i === 0 ? side : side.slice(1)));
  }
  return points;
}

const cameraOf = page => page.evaluate(() => window._cellucidViewer.getCameraState());

/** How far the orbit angles turned, and how far the target was panned. */
function cameraMotion(before, after) {
  return {
    turned: Math.abs(after.orbit.theta - before.orbit.theta)
      + Math.abs(after.orbit.phi - before.orbit.phi),
    panned: after.orbit.target.reduce(
      (sum, value, axis) => sum + Math.abs(value - before.orbit.target[axis]),
      0,
    ),
  };
}

async function useNavigationMode(page, mode) {
  await page.locator('#navigation-mode').selectOption(mode);
  await expect.poll(
    () => page.evaluate(() => window._cellucidViewer.getNavigationMode()),
  ).toBe(mode);
}
const unifiedState = page => page.evaluate(
  () => {
    // The candidates are a cell list (Uint32Array); hand them over as numbers.
    const state = window._cellucidViewer.getUnifiedSelectionState();
    return { ...state, candidates: Array.from(state.candidates) };
  },
);
const selectModeOf = page => page.evaluate(
  () => window._cellucidViewer.getSelectMode(),
);

// How long a gesture that did land may take to arm its tool before it counts
// as dropped; see highlight-selection-feedback.spec.mjs.
const GESTURE_LANDING_TIMEOUT_MS = 3_000;

async function armSelection(page, tool, gesture) {
  const controls = page.locator(`#${tool}-step-controls`);
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

async function turnOnSelectMode(page) {
  await page.locator('#highlight-select-mode').tap();
  await expect(page.locator('#highlight-select-mode'))
    .toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#select-bar-mode'))
    .toHaveAttribute('aria-checked', 'true');
  expect(await selectModeOf(page)).toEqual({ enabled: true, combine: 'intersect' });
}

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('a press held on the plot is never a text selection', async ({ page }) => {
    const productErrors = observeProductErrors(page);
    await openDataset(page);
    // iOS starts a text selection on a long press wherever the element under
    // the finger is selectable, and Safari reads only -webkit-user-select: on
    // the plot the selection grew to the whole page.
    const surfaces = await page.evaluate(() => [
      '#glcanvas',
      '.select-bar',
      '.split-view-badges',
    ].map(selector => {
      const element = document.querySelector(selector);
      if (!element) return { selector, missing: true };
      const style = getComputedStyle(element);
      return {
        selector,
        webkit: style.getPropertyValue('-webkit-user-select'),
        standard: style.getPropertyValue('user-select'),
        callout: style.getPropertyValue('-webkit-touch-callout'),
      };
    }));
    for (const surface of surfaces) {
      expect(surface.missing, `${surface.selector} exists`).toBeUndefined();
      // Each engine reports the property it implements; none may be selectable.
      for (const value of [surface.webkit, surface.standard]) {
        if (value !== '') expect(value, surface.selector).toBe('none');
      }
      // WebKit, the engine iOS uses, implements the callout property.
      if (surface.callout !== '') expect(surface.callout, surface.selector).toBe('none');
    }
    // A held finger on the plot leaves nothing selected.
    const box = await page.locator('#glcanvas').boundingBox();
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await touchGesture(page, [line(centre, centre)]);
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');
    expect(productErrors).toEqual([]);
  });

  test('Select mode is a named switch in the panel and on the selection bar', async ({
    page,
  }) => {
    const productErrors = observeProductErrors(page);
    await openDataset(page);

    // While the full-screen menu is open only the panel's switch is shown.
    const panelToggle = page.getByRole('switch', { name: 'Select mode' });
    await expect(panelToggle).toHaveCount(1);
    await expect(panelToggle).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('#highlight-select-combine')).toBeHidden();

    await turnOnSelectMode(page);
    const combine = page.getByRole('group', {
      name: 'How each selection gesture combines',
    });
    await expect(combine).toBeVisible();
    await expect(combine.getByRole('button', { name: 'Intersect' }))
      .toHaveAttribute('aria-pressed', 'true');
    await combine.getByRole('button', { name: 'Add' }).tap();
    expect(await selectModeOf(page)).toEqual({ enabled: true, combine: 'union' });
    await combine.getByRole('button', { name: 'Intersect' }).tap();

    // On a phone the full-screen sidebar is closed to reach the plot; the
    // same switch sits on the selection bar over it, on screen, drawn 36px
    // tall with a hit area that reaches 42px.
    await closeSidebar(page);
    const barToggle = page.locator('#select-bar')
      .getByRole('switch', { name: 'Select mode' });
    await expect(barToggle).toHaveCount(1);
    await expect(barToggle).toBeVisible();
    await expect(barToggle).toHaveAttribute('aria-checked', 'true');
    const box = await barToggle.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.y + box.height).toBeLessThanOrEqual(844);
    expect(box.height).toBeGreaterThanOrEqual(36);
    const hitArea = await barToggle.evaluate(element => {
      const area = element.getBoundingClientRect();
      const x = area.left + area.width / 2;
      const owns = y => {
        const hit = document.elementFromPoint(x, y);
        return hit !== null && (hit === element || element.contains(hit));
      };
      let top = area.top;
      let bottom = area.bottom;
      while (top > area.top - 8 && owns(top - 1)) top -= 1;
      while (bottom < area.bottom + 8 && owns(bottom + 0.5)) bottom += 1;
      return bottom - top;
    });
    expect(hitArea).toBeGreaterThanOrEqual(42);
    // The combine choice made in the panel shows on the bar.
    await expect(page.locator('#select-bar-combine-intersect'))
      .toHaveAttribute('aria-pressed', 'true');

    await barToggle.tap();
    await expect(barToggle).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('#highlight-select-mode'))
      .toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('#select-bar-combine')).toBeHidden();
    expect((await selectModeOf(page)).enabled).toBe(false);
    expect(productErrors).toEqual([]);
  });

  test('with Select mode on, a one-finger tap selects the tapped cell', async ({
    page,
  }) => {
    const productErrors = observeProductErrors(page);
    await openDataset(page);
    await colourByCellType(page);
    await turnOnSelectMode(page);
    await closeSidebar(page);
    const [point] = await findCellPoints(page, 1);
    const cameraBefore = await cameraOf(page);

    // The browser's own touch input: if the tap were replayed as mouse
    // events the mouse path would act on it a second time.
    await page.evaluate(() => {
      window.__touchSelectionMouseDowns = 0;
      document.getElementById('glcanvas').addEventListener('mousedown', () => {
        window.__touchSelectionMouseDowns += 1;
      });
    });
    await armSelection(page, 'annotation', () => page.touchscreen.tap(point.x, point.y));

    const state = await unifiedState(page);
    expect(state.inProgress).toBe(true);
    expect(state.candidates).toContain(point.cellIndex);
    expect(await page.evaluate(() => window.__touchSelectionMouseDowns)).toBe(0);
    const cameraAfter = await cameraOf(page);
    expect(cameraAfter.orbit.theta).toBeCloseTo(cameraBefore.orbit.theta, 6);
    expect(cameraAfter.orbit.phi).toBeCloseTo(cameraBefore.orbit.phi, 6);

    // The selection is confirmed from the panel, as with Alt+click.
    await openSidebar(page);
    await expect(page.locator('#annotation-step-controls')).toBeVisible();
    expect(productErrors).toEqual([]);
  });

  test('with Select mode on, a one-finger drag draws a lasso', async ({ page }) => {
    const productErrors = observeProductErrors(page);
    await openDataset(page);
    await page.locator('.highlight-mode-btn[data-mode="lasso"]').tap();
    await turnOnSelectMode(page);
    await closeSidebar(page);
    const cameraBefore = await cameraOf(page);

    await armSelection(page, 'lasso', () => touchGesture(page, [loop([
      { x: 20, y: 70 }, { x: 370, y: 70 }, { x: 370, y: 740 },
      { x: 20, y: 740 }, { x: 20, y: 70 },
    ])]));

    const state = await unifiedState(page);
    expect(state.inProgress).toBe(true);
    expect(state.candidateCount).toBeGreaterThan(0);
    const cameraAfter = await cameraOf(page);
    expect(cameraAfter.orbit.theta).toBeCloseTo(cameraBefore.orbit.theta, 6);
    expect(cameraAfter.orbit.phi).toBeCloseTo(cameraBefore.orbit.phi, 6);

    // Escape cancels the selection in progress first, then leaves the mode.
    await page.keyboard.press('Escape');
    await expect(page.locator('#lasso-step-controls')).toHaveCount(0);
    expect((await selectModeOf(page)).enabled).toBe(true);
    await page.keyboard.press('Escape');
    expect((await selectModeOf(page)).enabled).toBe(false);
    await expect(page.locator('#select-bar-mode'))
      .toHaveAttribute('aria-checked', 'false');
    expect(productErrors).toEqual([]);
  });

  test('with Select mode off, a one-finger drag still orbits or pans', async ({
    page,
  }) => {
    const productErrors = observeProductErrors(page);
    await openDataset(page);
    await page.locator('.highlight-mode-btn[data-mode="lasso"]').tap();

    for (const mode of ['orbit', 'planar']) {
      await useNavigationMode(page, mode);
      await closeSidebar(page);
      const before = await cameraOf(page);
      await touchGesture(page, [line({ x: 120, y: 300 }, { x: 260, y: 420 })]);
      await expect.poll(async () => {
        const motion = cameraMotion(before, await cameraOf(page));
        return mode === 'orbit' ? motion.turned : motion.panned;
      }, { message: `a finger ${mode === 'orbit' ? 'orbits' : 'pans'} in ${mode}` })
        .toBeGreaterThan(mode === 'orbit' ? 0.1 : 1e-3);
      await expect(page.locator('#lasso-step-controls')).toHaveCount(0);
      expect((await unifiedState(page)).inProgress).toBe(false);
      await openSidebar(page);
    }
    expect(productErrors).toEqual([]);
  });

  test('two fingers pinch and pan while Select mode is on, and abandon a lasso', async ({
    page,
  }) => {
    const productErrors = observeProductErrors(page);
    await openDataset(page);
    await page.locator('.highlight-mode-btn[data-mode="lasso"]').tap();
    await useNavigationMode(page, 'orbit');
    await turnOnSelectMode(page);
    await closeSidebar(page);
    const before = await cameraOf(page);

    // The first finger starts drawing; the second lands three steps later and
    // the two spread apart while their midpoint moves down and right.
    await touchGesture(
      page,
      [
        line({ x: 170, y: 380 }, { x: 110, y: 380 + 60 }),
        line({ x: 220, y: 380 }, { x: 330, y: 380 + 60 }),
      ],
      [0, 3],
    );

    await expect.poll(async () => (await cameraOf(page)).orbit.targetRadius)
      .toBeLessThan(before.orbit.targetRadius * 0.8);
    const motion = cameraMotion(before, await cameraOf(page));
    expect(motion.panned, 'the midpoint drag pans the camera').toBeGreaterThan(1e-4);
    expect(motion.turned, 'two fingers never orbit').toBeLessThan(1e-6);

    // The half-drawn lasso is abandoned, never committed, and says why.
    expect((await unifiedState(page)).inProgress).toBe(false);
    await expect(page.locator('#lasso-step-controls')).toHaveCount(0);
    await expect(page.locator('#highlight-mode-description'))
      .toContainText('interrupted');
    expect((await selectModeOf(page)).enabled).toBe(true);
    expect(productErrors).toEqual([]);
  });

  test('Select mode Add and Subtract stand in for Shift and Ctrl', async ({
    page,
  }) => {
    const productErrors = observeProductErrors(page);
    await openDataset(page);
    await page.locator('.highlight-mode-btn[data-mode="lasso"]').tap();
    await turnOnSelectMode(page);
    await closeSidebar(page);
    const top = loop([
      { x: 20, y: 70 }, { x: 370, y: 70 }, { x: 370, y: 400 },
      { x: 20, y: 400 }, { x: 20, y: 70 },
    ]);
    const bottom = loop([
      { x: 20, y: 400 }, { x: 370, y: 400 }, { x: 370, y: 740 },
      { x: 20, y: 740 }, { x: 20, y: 400 },
    ]);
    await armSelection(page, 'lasso', () => touchGesture(page, [top]));
    const first = await unifiedState(page);
    expect(first.candidateCount).toBeGreaterThan(0);

    // The combine is chosen on the selection bar, without the menu.
    await page.locator('#select-bar-combine-union').tap();
    await expect(page.locator('#highlight-select-combine-union'))
      .toHaveAttribute('aria-pressed', 'true');
    await touchGesture(page, [bottom]);
    await expect.poll(async () => (await unifiedState(page)).candidateCount)
      .toBeGreaterThan(first.candidateCount);
    const added = await unifiedState(page);
    for (const cell of first.candidates) expect(added.candidates).toContain(cell);

    await page.locator('#select-bar-combine-subtract').tap();
    await touchGesture(page, [top]);
    await expect.poll(async () => (await unifiedState(page)).candidateCount)
      .toBe(added.candidateCount - first.candidateCount);
    const subtracted = await unifiedState(page);
    for (const cell of first.candidates) {
      expect(subtracted.candidates).not.toContain(cell);
    }
    expect(productErrors).toEqual([]);
  });
});

test.describe('on a tablet in multiview', () => {
  test.use({ viewport: { width: 1180, height: 820 }, hasTouch: true });

  test('a tap in Select mode selects in the pane it lands on, as Alt+click does', async ({
    page,
  }) => {
    const productErrors = observeProductErrors(page);
    await openDataset(page);
    await colourByCellType(page);
    await page.locator('#split-keep-view-btn').tap();
    await expect(page.locator('.split-badge')).toHaveCount(2);
    const viewIds = await page.evaluate(() => [
      'live',
      ...window._cellucidViewer.getSnapshotViews().map(view => view.id),
    ]);
    expect(viewIds.length).toBe(2);
    const focusOf = () => page.evaluate(
      () => window._cellucidViewer.getViewLayout().activeId,
    );
    const sidebarRight = await page.evaluate(
      () => document.getElementById('sidebar').getBoundingClientRect().right,
    );
    const [point] = await findCellPoints(page, 1, {
      left: sidebarRight + (1180 - sidebarRight) / 2,
      top: 0,
      right: 1180,
      bottom: 820,
    });
    // A still mouse press there is camera input, which focuses the pane under
    // it: that names the pane, and the other one is then given focus so the
    // gestures below land on the pane that is not focused.
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.up();
    const pointPane = await focusOf();
    const otherPane = viewIds.find(id => id !== pointPane);
    await page.evaluate(id => window._cellucidViewer.setViewLayout('grid', id), otherPane);
    await expect.poll(focusOf).toBe(otherPane);

    // Alt+click with a mouse at that point is the reference.
    await armSelection(page, 'annotation', async () => {
      await page.mouse.move(point.x, point.y);
      await page.keyboard.down('Alt');
      await page.mouse.down();
      await page.mouse.up();
      await page.keyboard.up('Alt');
    });
    const altState = await unifiedState(page);
    expect(altState.candidates).toContain(point.cellIndex);
    expect(await focusOf(), 'an Alt gesture never moves view focus').toBe(otherPane);
    await page.keyboard.press('Escape');
    await expect(page.locator('#annotation-step-controls')).toHaveCount(0);

    await turnOnSelectMode(page);
    await armSelection(page, 'annotation', () => page.touchscreen.tap(point.x, point.y));
    const touchState = await unifiedState(page);
    expect([...touchState.candidates].sort((a, b) => a - b))
      .toEqual([...altState.candidates].sort((a, b) => a - b));
    expect(await focusOf(), 'nor does a Select mode tap').toBe(otherPane);

    // With Select mode off, a finger on that pane focuses it before moving
    // its camera, as a mouse press there does.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    expect((await selectModeOf(page)).enabled).toBe(false);
    await touchGesture(page, [line(point, { x: point.x + 60, y: point.y + 40 })]);
    await expect.poll(focusOf).toBe(pointPane);
    expect(productErrors).toEqual([]);
  });
});

test.describe('with a mouse', () => {
  test('Alt+click and plain drags behave as before, and the bar shows only in Select mode', async ({
    page,
  }) => {
    const productErrors = observeProductErrors(page);
    await openDataset(page);
    await colourByCellType(page);
    expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches))
      .toBe(false);
    await expect(page.locator('#select-bar')).toBeHidden();
    const [point] = await findCellPoints(page, 1, {
      left: 360, top: 0, right: 1440, bottom: 1000,
    });

    // Alt+click selects.
    await armSelection(page, 'annotation', async () => {
      await page.mouse.move(point.x, point.y);
      await page.keyboard.down('Alt');
      await page.mouse.down();
      await page.mouse.up();
      await page.keyboard.up('Alt');
    });
    expect((await unifiedState(page)).candidates).toContain(point.cellIndex);
    await page.keyboard.press('Escape');
    await expect(page.locator('#annotation-step-controls')).toHaveCount(0);

    // Select mode is offered to a mouse as well: a plain click then selects,
    // and the selection bar appears over the plot.
    await page.locator('#highlight-select-mode').click();
    await expect(page.locator('#select-bar')).toBeVisible();
    await armSelection(page, 'annotation', async () => {
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      await page.mouse.up();
    });
    expect((await unifiedState(page)).candidates).toContain(point.cellIndex);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    expect((await selectModeOf(page)).enabled).toBe(false);
    await expect(page.locator('#select-bar')).toBeHidden();

    // With Select mode off again, a plain drag orbits and selects nothing.
    await useNavigationMode(page, 'orbit');
    const before = await cameraOf(page);
    await page.mouse.move(700, 500);
    await page.mouse.down();
    await page.mouse.move(820, 560, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => cameraMotion(before, await cameraOf(page)).turned)
      .toBeGreaterThan(0.1);
    expect((await unifiedState(page)).inProgress).toBe(false);
    await expect(page.locator('#annotation-step-controls')).toHaveCount(0);
    expect(productErrors).toEqual([]);
  });
});

for (const theme of ['light', 'dark']) {
  test.describe(`in ${theme} theme on a phone`, () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

    test('the bar switch shows its state as clearly as the panel switch', async ({ page }) => {
      await page.addInitScript(value => {
        localStorage.setItem('cellucid_theme', value);
      }, theme);
      await openDataset(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await closeSidebar(page);
      const toggle = page.locator('#select-bar-mode');
      const look = () => toggle.evaluate(element => {
        const track = element.querySelector('.switch-track');
        const trackStyle = getComputedStyle(track);
        const knobStyle = getComputedStyle(track, '::after');
        return {
          track: trackStyle.backgroundColor,
          knob: knobStyle.backgroundColor,
          knobAt: knobStyle.transform,
          width: trackStyle.width,
        };
      });
      // A colour sampled mid-transition is neither state, so every sample
      // waits until the switch's own transitions (track and knob) have ended.
      const settled = () => expect.poll(() => toggle.evaluate(element =>
        element.getAnimations({ subtree: true }).length)).toBe(0);
      await settled();
      const off = await look();
      await toggle.tap();
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await expect.poll(async () => (await look()).knobAt).not.toBe(off.knobAt);
      await settled();
      const on = await look();
      expect(on.track).not.toBe(off.track);
      expect(on.knob).not.toBe(on.track);
      expect(off.knob).not.toBe(off.track);
      // The panel's switch is the same component, drawn the same way.
      await openSidebar(page);
      const trackOf = id => page.locator(`#${id} .switch-track`)
        .evaluate(element => {
          const style = getComputedStyle(element);
          return `${style.backgroundColor} ${style.width}x${style.height}`;
        });
      await expect.poll(async () => {
        const [bar, panel] = [await trackOf('select-bar-mode'), await trackOf('highlight-select-mode')];
        return bar === panel ? panel : `${bar} vs ${panel}`;
      }).toBe(`${on.track} ${on.width}x20px`);
    });
  });
}
