/**
 * The presented area is the part of the canvas the sidebar does not cover.
 * Multiview grid cells are laid out inside it, so a left cell is never under
 * the sidebar and every cell has the same on-screen area, whatever the
 * sidebar is doing: open, closed, mid-resize, sliding, or after a window or
 * device-pixel-ratio change. Every screen-to-view mapping (focus, picking,
 * the highlight tools, projectiles, title chips) follows the same layout.
 *
 * Geometry is read from what was actually drawn: the WebGL scissor rectangle
 * of every grid pane in the last frame, the sidebar's rendered box, and the
 * title chips' boxes.
 */

import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';

// Every test here draws a multiview grid frame by frame, some at pixel ratio
// 2 (four times the pixels). The macOS Firefox runners render in software,
// where these take 70-95 s against the 90 s default, so the file carries its
// own budget, as the other frame-driven WebGL specs do.
test.describe.configure({ timeout: 240_000 });

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`
  + '&dataset=current-ui&acceptance=presented-layout';

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

/** Record the scissor rectangle of every grid pane the viewer draws. */
async function installScissorRecorder(page) {
  await page.evaluate(() => {
    const gl = window._cellucidViewer.getGLContext();
    const scissor = gl.scissor.bind(gl);
    window.__paneScissors = [];
    gl.scissor = (x, y, width, height) => {
      window.__paneScissors.push([x, y, width, height]);
      if (window.__paneScissors.length > 64) window.__paneScissors.shift();
      return scissor(x, y, width, height);
    };
  });
}

async function openGrid(page, viewCount) {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture',
  );
  for (let count = 2; count <= viewCount; count++) {
    await page.locator('#split-keep-view-btn').click();
    await expect(page.locator('.split-badge')).toHaveCount(count);
  }
  await page.evaluate(() => {
    window._cellucidViewer.setViewLayout('grid', 'live');
  });
  await expect(page.locator('.view-title-chip')).toHaveCount(viewCount);
  await installScissorRecorder(page);
  await page.evaluate(`window.__measurePresented = ${measureInPage.toString()};`);
  // The grid may already have been drawn and the scene gone idle before the
  // recorder was installed: an idle viewer draws nothing more. Re-applying the
  // same layout is a public mutation that changes nothing on screen but draws
  // a frame, so every pane's scissor is recorded.
  await page.evaluate(() => {
    window._cellucidViewer.setViewLayout('grid', 'live');
  });
  await waitForFrames(page, 3);
}

function waitForFrames(page, count) {
  return page.evaluate(frames => new Promise(resolve => {
    const step = remaining => {
      if (remaining === 0) resolve();
      else requestAnimationFrame(() => step(remaining - 1));
    };
    step(frames);
  }), count);
}

/**
 * Everything on screen that describes the grid, in client CSS pixels: the
 * sidebar's rendered right edge (transform included), each pane's drawn
 * rectangle (its last scissor), its layout rectangle, and its title chip.
 */
function measureInPage() {
  const viewer = window._cellucidViewer;
  const canvas = document.getElementById('glcanvas');
  const canvasRect = canvas.getBoundingClientRect();
  const sidebar = document.getElementById('sidebar');
  const sidebarRect = sidebar.getBoundingClientRect();
  const layout = viewer.getPresentedLayout();
  const scaleX = layout.cssWidth / layout.canvasWidth;
  const scaleY = layout.cssHeight / layout.canvasHeight;
  const scissors = window.__paneScissors.slice(-layout.panes.length);
  const chips = [...document.querySelectorAll('.view-title-chip')];
  const sidebarCovers = getComputedStyle(sidebar).opacity !== '0';
  return {
    canvas: {
      left: canvasRect.left,
      top: canvasRect.top,
      right: canvasRect.right,
      bottom: canvasRect.bottom,
    },
    sidebarHidden: sidebar.classList.contains('hidden'),
    // The canvas x before which the sidebar hides the plot.
    coveredRight: sidebarCovers
      ? Math.max(canvasRect.left, Math.min(canvasRect.right, sidebarRect.right))
      : canvasRect.left,
    presentedLeft: canvasRect.left + layout.presentedArea.cssLeft,
    dpr: window.devicePixelRatio,
    gridMultiview: layout.gridMultiview,
    panes: layout.panes.map((pane, index) => {
      const [x, y, width, height] = scissors[index] ?? [NaN, NaN, NaN, NaN];
      const chip = chips[index]?.getBoundingClientRect() ?? null;
      return {
        viewId: pane.viewId,
        layout: {
          left: canvasRect.left + pane.cssLeft,
          top: canvasRect.top + pane.cssTop,
          width: pane.cssWidth,
          height: pane.cssHeight,
        },
        drawn: {
          left: canvasRect.left + x * scaleX,
          top: canvasRect.top + (layout.canvasHeight - y - height) * scaleY,
          width: width * scaleX,
          height: height * scaleY,
        },
        chip: chip === null
          ? null
          : { left: chip.left, right: chip.right, top: chip.top, bottom: chip.bottom },
      };
    }),
  };
}

const measure = page => page.evaluate(() => window.__measurePresented());

/** On-screen (uncovered) rectangle of one drawn pane. */
function onScreen(rect, measured) {
  const left = Math.max(rect.left, measured.coveredRight);
  const right = Math.min(rect.left + rect.width, measured.canvas.right);
  return {
    width: Math.max(0, right - left),
    height: Math.max(
      0,
      Math.min(rect.top + rect.height, measured.canvas.bottom)
        - Math.max(rect.top, measured.canvas.top),
    ),
  };
}

/**
 * The grid invariant: every pane is drawn where the layout says, lies wholly
 * in the uncovered area, and shows the same on-screen area as every other
 * pane (within one CSS pixel per side).
 */
function expectEqualUncoveredCells(measured, label, { drawnMatchesLayout = true } = {}) {
  const context = `${label}: ${JSON.stringify(measured)}`;
  expect(measured.gridMultiview, context).toBe(true);
  const areas = [];
  for (const pane of measured.panes) {
    // A frame sampled mid-slide may show the panes drawn one frame before
    // the layout it reads; what is on screen is still the drawn rectangle.
    for (const key of drawnMatchesLayout ? ['left', 'top', 'width', 'height'] : []) {
      expect(Math.abs(pane.drawn[key] - pane.layout[key]), context)
        .toBeLessThanOrEqual(1);
    }
    expect(pane.drawn.left, context)
      .toBeGreaterThanOrEqual(measured.coveredRight - 1);
    const visible = onScreen(pane.drawn, measured);
    expect(Math.abs(visible.width - pane.drawn.width), context)
      .toBeLessThanOrEqual(1);
    expect(Math.abs(visible.height - pane.drawn.height), context)
      .toBeLessThanOrEqual(1);
    areas.push(visible);
  }
  for (const area of areas) {
    expect(Math.abs(area.width - areas[0].width), context).toBeLessThanOrEqual(1);
    expect(Math.abs(area.height - areas[0].height), context).toBeLessThanOrEqual(1);
  }
}

/** The grid uses all of the uncovered width (to within a pixel per column). */
function expectGridFillsUncoveredWidth(measured, label) {
  const context = `${label}: ${JSON.stringify(measured)}`;
  const right = Math.max(
    ...measured.panes.map(pane => pane.drawn.left + pane.drawn.width),
  );
  const left = Math.min(...measured.panes.map(pane => pane.drawn.left));
  expect(left - measured.coveredRight, context).toBeLessThanOrEqual(1);
  expect(measured.canvas.right - right, context).toBeLessThanOrEqual(
    measured.panes.length,
  );
}

async function waitForSettledLayout(page) {
  await expect.poll(async () => {
    const measured = await measure(page);
    return Math.abs(measured.presentedLeft - measured.coveredRight) <= 1;
  }).toBe(true);
  await waitForFrames(page, 2);
  return measure(page);
}

async function toggleSidebar(page, hidden) {
  await page.locator('#sidebar-toggle').click();
  const sidebar = page.locator('#sidebar');
  if (hidden) await expect(sidebar).toHaveClass(/\bhidden\b/);
  else await expect(sidebar).not.toHaveClass(/\bhidden\b/);
  // The slide has finished when the sidebar runs no animation.
  await expect.poll(() => page.evaluate(
    () => document.getElementById('sidebar').getAnimations().length,
  )).toBe(0);
}

/**
 * Sample one sidebar slide at evenly spaced points of its run. The toggle
 * and the sampler are started in the same task; the slide is paused, stepped
 * to each point, and one frame drawn there before it is sampled, then played
 * to its end and sampled settled.
 *
 * Sampling the frames the browser happened to draw saw nothing of the slide
 * wherever a frame outlasted it: the slide is 300 ms, and on a Windows WebKit
 * runner it had already ended by the first frame after the click, so the only
 * samples were that frame and the settled one. A
 * paused slide keeps the sidebar's transition running, which is all the
 * product watches while it slides (`sidebar-controls.js`), so a stepped
 * point is a real frame of the slide on any runner.
 */
const SLIDE_POINTS = 6;

function sampleToggleAnimation(page) {
  return page.evaluate(async points => {
    const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const sidebar = document.getElementById('sidebar');
    document.getElementById('sidebar-toggle').click();
    const slide = sidebar.getAnimations();
    if (slide.length === 0) throw new Error('the sidebar toggle started no slide');
    for (const animation of slide) animation.pause();
    const samples = [];
    for (let point = 0; point < points; point++) {
      for (const animation of slide) {
        const { endTime } = animation.effect.getComputedTiming();
        animation.currentTime = (endTime * point) / points;
      }
      await nextFrame();
      samples.push(window.__measurePresented());
    }
    for (const animation of slide) animation.play();
    while (sidebar.getAnimations().length > 0) await nextFrame();
    await nextFrame();
    samples.push(window.__measurePresented());
    return samples;
  }, SLIDE_POINTS);
}

/** The sampled slide really moved the sidebar through its run. */
function expectSlideSampled(samples, label) {
  expect(samples, label).toHaveLength(SLIDE_POINTS + 1);
  const edges = new Set(samples.map(sample => Math.round(sample.coveredRight)));
  expect(edges.size, `${label}: ${[...edges]}`).toBeGreaterThan(2);
}

for (const viewCount of [2, 4]) {
  test(`${viewCount}-view grid cells stay equal and uncovered through every sidebar and window change`, async ({
    page,
  }) => {
    const productErrors = observeProductErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openGrid(page, viewCount);

    const open = await waitForSettledLayout(page);
    expect(open.sidebarHidden).toBe(false);
    expect(open.coveredRight).toBeGreaterThan(open.canvas.left + 200);
    expectEqualUncoveredCells(open, 'sidebar open');
    expectGridFillsUncoveredWidth(open, 'sidebar open');

    // Live resize drag: every intermediate width re-lays the grid out.
    const handle = page.locator('#sidebar-resize-handle');
    const box = await handle.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 70, box.y + 40, { steps: 4 });
    const midDrag = await waitForSettledLayout(page);
    expect(midDrag.coveredRight).toBeGreaterThan(open.coveredRight + 50);
    expectEqualUncoveredCells(midDrag, 'mid resize drag');
    expectGridFillsUncoveredWidth(midDrag, 'mid resize drag');
    await page.mouse.move(box.x + box.width / 2 + 140, box.y + 40, { steps: 4 });
    await page.mouse.up();
    const dragged = await waitForSettledLayout(page);
    expect(dragged.coveredRight).toBeGreaterThan(midDrag.coveredRight + 50);
    expectEqualUncoveredCells(dragged, 'after resize drag');
    expectGridFillsUncoveredWidth(dragged, 'after resize drag');

    // The close slide: equal, uncovered cells at every point of it.
    const closing = await sampleToggleAnimation(page);
    expectSlideSampled(closing, 'closing');
    for (const [index, frame] of closing.entries()) {
      expectEqualUncoveredCells(frame, `closing frame ${index}`, {
        drawnMatchesLayout: false,
      });
    }
    const closed = await waitForSettledLayout(page);
    expect(closed.sidebarHidden).toBe(true);
    expect(closed.coveredRight).toBe(closed.canvas.left);
    expectEqualUncoveredCells(closed, 'sidebar closed');
    expectGridFillsUncoveredWidth(closed, 'sidebar closed');
    expect(closed.panes[0].drawn.left).toBeLessThanOrEqual(closed.canvas.left + 1);

    // Window resize while closed, then the open slide.
    await page.setViewportSize({ width: 1280, height: 720 });
    const resizedClosed = await waitForSettledLayout(page);
    expect(resizedClosed.canvas.right).toBe(1280);
    expectEqualUncoveredCells(resizedClosed, 'window resized, closed');
    expectGridFillsUncoveredWidth(resizedClosed, 'window resized, closed');

    const opening = await sampleToggleAnimation(page);
    expectSlideSampled(opening, 'opening');
    for (const [index, frame] of opening.entries()) {
      expectEqualUncoveredCells(frame, `opening frame ${index}`, {
        drawnMatchesLayout: false,
      });
    }
    const reopened = await waitForSettledLayout(page);
    expect(reopened.sidebarHidden).toBe(false);
    expectEqualUncoveredCells(reopened, 'reopened');
    expectGridFillsUncoveredWidth(reopened, 'reopened');

    await page.setViewportSize({ width: 1440, height: 900 });
    const resizedOpen = await waitForSettledLayout(page);
    expectEqualUncoveredCells(resizedOpen, 'window resized, open');
    expectGridFillsUncoveredWidth(resizedOpen, 'window resized, open');

    // Title chips sit over their own cells.
    for (const pane of resizedOpen.panes) {
      expect(pane.chip).not.toBeNull();
      expect(pane.chip.left).toBeGreaterThanOrEqual(pane.drawn.left - 1);
      expect(pane.chip.right).toBeLessThanOrEqual(
        pane.drawn.left + pane.drawn.width + 1,
      );
      expect(pane.chip.top).toBeGreaterThanOrEqual(pane.drawn.top - 1);
      expect(pane.chip.bottom).toBeLessThanOrEqual(
        pane.drawn.top + pane.drawn.height / 2,
      );
    }

    const webglError = await page.evaluate(
      () => window._cellucidViewer.getGLContext().getError(),
    );
    expect(webglError).toBe(0);
    expect(productErrors).toEqual([]);
  });
}

test.describe('at device pixel ratio 2', () => {
  test.use({ deviceScaleFactor: 2 });

  for (const viewCount of [2, 4]) {
    test(`${viewCount}-view grid cells are equal and uncovered in backing-store pixels`, async ({
      page,
    }) => {
      const productErrors = observeProductErrors(page);
      await page.setViewportSize({ width: 1280, height: 720 });
      await openGrid(page, viewCount);
      const open = await waitForSettledLayout(page);
      expect(open.dpr).toBe(2);
      expectEqualUncoveredCells(open, 'dpr 2 open');
      expectGridFillsUncoveredWidth(open, 'dpr 2 open');
      await toggleSidebar(page, true);
      const closed = await waitForSettledLayout(page);
      expectEqualUncoveredCells(closed, 'dpr 2 closed');
      expectGridFillsUncoveredWidth(closed, 'dpr 2 closed');
      expect(productErrors).toEqual([]);
    });
  }
});

/**
 * Moving the window to a screen with another pixel ratio changes
 * `devicePixelRatio` and fires the `(resolution: Ndppx)` media query. No
 * engine's automation can move a live page between screens, so the ratio and
 * the query's change event are driven from the page.
 */
async function installDevicePixelRatioControl(page) {
  await page.addInitScript(() => {
    const native = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio')
      ?? Object.getOwnPropertyDescriptor(Window.prototype, 'devicePixelRatio');
    let override = null;
    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      get() {
        return override ?? (native.get ? native.get.call(window) : native.value);
      },
    });
    const resolutionListeners = new Set();
    const nativeMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = query => {
      const list = nativeMatchMedia(query);
      if (!/resolution/.test(query)) return list;
      const add = list.addEventListener.bind(list);
      const remove = list.removeEventListener.bind(list);
      list.addEventListener = (type, handler, options) => {
        if (type === 'change') resolutionListeners.add(handler);
        return add(type, handler, options);
      };
      list.removeEventListener = (type, handler, options) => {
        resolutionListeners.delete(handler);
        return remove(type, handler, options);
      };
      return list;
    };
    window.__setDevicePixelRatio = value => {
      override = value;
      for (const handler of [...resolutionListeners]) handler({ matches: false });
    };
  });
}

test('a live device-pixel-ratio change re-lays the grid out', async ({ page }) => {
  const productErrors = observeProductErrors(page);
  await installDevicePixelRatioControl(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await openGrid(page, 4);
  const before = await waitForSettledLayout(page);
  expectEqualUncoveredCells(before, 'before DPR change');
  const ratio = before.dpr === 2 ? 1 : 2;
  await page.evaluate(value => window.__setDevicePixelRatio(value), ratio);
  await expect.poll(() => page.evaluate(() => {
    const layout = window._cellucidViewer.getPresentedLayout();
    return [window.devicePixelRatio, layout.canvasWidth, layout.canvasHeight];
  })).toEqual([ratio, 1280 * ratio, 720 * ratio]);
  await waitForFrames(page, 3);
  const after = await waitForSettledLayout(page);
  expectEqualUncoveredCells(after, 'after DPR change');
  expectGridFillsUncoveredWidth(after, 'after DPR change');
  for (const [index, pane] of after.panes.entries()) {
    for (const key of ['left', 'top', 'width', 'height']) {
      expect(Math.abs(pane.drawn[key] - before.panes[index].drawn[key]))
        .toBeLessThanOrEqual(1);
    }
  }
  expect(productErrors).toEqual([]);
});

test('with the sidebar hidden the grid uses the full canvas', async ({ page }) => {
  const productErrors = observeProductErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGrid(page, 2);
  await toggleSidebar(page, true);
  const closed = await waitForSettledLayout(page);
  expect(closed.presentedLeft).toBe(closed.canvas.left);
  expect(closed.panes[0].drawn.left).toBe(closed.canvas.left);
  expect(closed.panes[1].drawn.left + closed.panes[1].drawn.width)
    .toBeGreaterThan(closed.canvas.right - 2);
  expectEqualUncoveredCells(closed, 'hidden');
  expect(productErrors).toEqual([]);
});

/** Pane centres in client pixels, from the presented layout. */
function paneCentres(page) {
  return page.evaluate(() => {
    const canvasRect = document.getElementById('glcanvas').getBoundingClientRect();
    return window._cellucidViewer.getPresentedLayout().panes.map(pane => ({
      viewId: pane.viewId,
      x: canvasRect.left + pane.cssLeft + pane.cssWidth / 2,
      y: canvasRect.top + pane.cssTop + pane.cssHeight / 2,
      rect: {
        left: canvasRect.left + pane.cssLeft,
        top: canvasRect.top + pane.cssTop,
        right: canvasRect.left + pane.cssLeft + pane.cssWidth,
        bottom: canvasRect.top + pane.cssTop + pane.cssHeight,
      },
    }));
  });
}

for (const viewCount of [2, 4]) {
  test(`a click at each ${viewCount}-view cell centre focuses that cell`, async ({ page }) => {
    const productErrors = observeProductErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openGrid(page, viewCount);
    const centres = await paneCentres(page);
    for (const centre of [...centres].reverse()) {
      await page.mouse.click(centre.x, centre.y);
      await expect.poll(
        () => page.evaluate(() => window._cellucidViewer.getViewLayout().activeId),
      ).toBe(centre.viewId);
      await expect(page.locator('.view-title-chip.active')).toHaveAttribute(
        'data-view-id',
        centre.viewId,
      );
    }
    expect(productErrors).toEqual([]);
  });
}

test.describe('on a touch screen', () => {
  test.use({ viewport: { width: 1180, height: 820 }, hasTouch: true });

  test('a tap at each 4-view cell centre focuses that cell', async ({ page }) => {
    const productErrors = observeProductErrors(page);
    await openGrid(page, 4);
    const centres = await paneCentres(page);
    const sidebarRight = await page.evaluate(
      () => document.getElementById('sidebar').getBoundingClientRect().right,
    );
    expect(centres[0].rect.left).toBeGreaterThanOrEqual(sidebarRight - 1);
    for (const centre of [...centres].reverse()) {
      await page.touchscreen.tap(centre.x, centre.y);
      await expect.poll(
        () => page.evaluate(() => window._cellucidViewer.getViewLayout().activeId),
      ).toBe(centre.viewId);
    }
    expect(productErrors).toEqual([]);
  });

  test('the selection bar is centred in the same presented area as the grid', async ({
    page,
  }) => {
    const productErrors = observeProductErrors(page);
    await openGrid(page, 2);
    await expect(page.locator('#select-bar')).toBeVisible();
    const placement = () => page.evaluate(() => {
      const layout = window._cellucidViewer.getPresentedLayout();
      const canvasRect = document.getElementById('glcanvas').getBoundingClientRect();
      const bar = document.getElementById('select-bar').getBoundingClientRect();
      const card = document.querySelector('.select-bar-card').getBoundingClientRect();
      const left = canvasRect.left + layout.presentedArea.cssLeft;
      const grid = layout.panes.map(pane => canvasRect.left + pane.cssLeft);
      return {
        barLeft: Math.abs(bar.left - left) < 1,
        barRight: Math.abs(bar.right - (left + layout.presentedArea.cssWidth)) < 1,
        cardCentred: Math.abs(
          card.left + card.width / 2 - (left + layout.presentedArea.cssWidth / 2),
        ) < 1,
        gridStartsWithBar: Math.abs(Math.min(...grid) - bar.left) < 1,
        sidebarHidden: document.getElementById('sidebar').classList.contains('hidden'),
        ...(document.getElementById('sidebar').classList.contains('hidden')
          ? { presentedLeft: layout.presentedArea.cssLeft }
          : {}),
      };
    });
    const aligned = {
      barLeft: true,
      barRight: true,
      cardCentred: true,
      gridStartsWithBar: true,
    };
    await expect.poll(placement).toEqual({ ...aligned, sidebarHidden: false });
    await page.locator('#sidebar-toggle').tap();
    await expect.poll(placement).toEqual({
      ...aligned,
      presentedLeft: 0,
      sidebarHidden: true,
    });
    await page.locator('#sidebar-toggle').tap();
    await expect.poll(placement).toEqual({ ...aligned, sidebarHidden: false });
    expect(productErrors).toEqual([]);
  });
});

test('the hidden sidebar is inert: nothing in it takes focus or a Tab stop', async ({
  page,
}) => {
  const productErrors = observeProductErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGrid(page, 2);
  const sidebarFocusState = () => page.evaluate(() => {
    const sidebar = document.getElementById('sidebar');
    const control = document.getElementById('navigation-mode');
    control.focus();
    return {
      inert: sidebar.inert,
      controlFocusable: document.activeElement === control,
    };
  });
  expect(await sidebarFocusState()).toEqual({ inert: false, controlFocusable: true });

  await toggleSidebar(page, true);
  expect(await sidebarFocusState()).toEqual({ inert: true, controlFocusable: false });
  // Tabbing round the whole page never stops inside the hidden sidebar.
  await page.locator('#sidebar-toggle').focus();
  const stops = [];
  for (let press = 0; press < 40; press++) {
    await page.keyboard.press('Tab');
    stops.push(await page.evaluate(() => (
      document.getElementById('sidebar').contains(document.activeElement)
    )));
  }
  expect(stops.every(inside => inside === false)).toBe(true);

  await toggleSidebar(page, false);
  expect(await sidebarFocusState()).toEqual({ inert: false, controlFocusable: true });
  expect(productErrors).toEqual([]);
});

/**
 * Where every cell of one view lands on screen, from the exact state the pane
 * is presented with.
 */
function projectViewCells(page, viewId) {
  return page.evaluate(id => {
    const viewer = window._cellucidViewer;
    const canvasRect = document.getElementById('glcanvas').getBoundingClientRect();
    const { renderState } = viewer.getPresentedViewState(id);
    const { mvpMatrix: m, pane } = renderState;
    const cells = [];
    for (let cellIndex = 0; cellIndex < viewer.getPointCount(); cellIndex++) {
      const { x, y, z } = viewer.getCellPosition(cellIndex, id);
      const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
      const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
      cells.push({
        cellIndex,
        x: canvasRect.left + pane.cssLeft + ((cx / cw + 1) / 2) * pane.cssWidth,
        y: canvasRect.top + pane.cssTop + ((1 - cy / cw) / 2) * pane.cssHeight,
      });
    }
    return {
      cells,
      pane: {
        left: canvasRect.left + pane.visibleCssLeft,
        top: canvasRect.top + pane.visibleCssTop,
        right: canvasRect.left + pane.visibleCssLeft + pane.visibleCssWidth,
        bottom: canvasRect.top + pane.visibleCssTop + pane.visibleCssHeight,
      },
    };
  }, viewId);
}

/** One cell drawn well inside the left pane, at least `gap` px from others. */
function isolatedCell({ cells, pane }, gap = 12) {
  const inside = cells.filter(cell => (
    cell.x > pane.left + 40 && cell.x < pane.right - 40
    && cell.y > pane.top + 60 && cell.y < pane.bottom - 60
  ));
  const isolated = inside.find(cell => cells.every(other => (
    other === cell || Math.hypot(other.x - cell.x, other.y - cell.y) >= gap
  )));
  expect(isolated).toBeDefined();
  return isolated;
}

test('picking in the left cell returns the cell drawn under the pointer', async ({ page }) => {
  const productErrors = observeProductErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGrid(page, 2);
  const projected = await projectViewCells(page, 'live');
  const target = isolatedCell(projected);
  const record = await page.evaluate(
    ({ x, y }) => window._cellucidViewer.pickCellRecordAtScreen(x, y),
    target,
  );
  expect(record?.viewId).toBe('live');
  expect(record?.cellIndex).toBe(target.cellIndex);
  // Nothing under the sidebar can be picked.
  const underSidebar = await page.evaluate(() => {
    const sidebarRect = document.getElementById('sidebar').getBoundingClientRect();
    return window._cellucidViewer.pickCellRecordAtScreen(
      sidebarRect.right - 20,
      sidebarRect.top + sidebarRect.height / 2,
    );
  });
  expect(underSidebar).toBeNull();
  expect(productErrors).toEqual([]);
});

async function colourByCellType(page) {
  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
  await expect(page.locator('.legend-item')).toHaveCount(3);
  // An annotation press reads the pressed pane's field from the state, so
  // the field is live for Alt+click once the state holds it.
  await expect.poll(
    () => page.evaluate(() => window._cellucidState.getActiveField()?.kind),
  ).toBe('category');
}

const unifiedState = page => page.evaluate(
  () => {
    // The candidates are a cell list (Uint32Array); hand them over as numbers.
    const state = window._cellucidViewer.getUnifiedSelectionState();
    return { ...state, candidates: Array.from(state.candidates) };
  },
);

async function armSelection(page, tool, gesture) {
  const controls = page.locator(`#${tool}-step-controls`);
  for (let attempt = 0; attempt < 8; attempt++) {
    await gesture();
    const armed = await controls.waitFor({
      state: 'attached',
      timeout: 3_000,
    }).then(() => true, error => {
      if (error?.name !== 'TimeoutError') throw error;
      return false;
    });
    if (armed) return;
  }
  await expect(controls).toBeAttached();
}

async function altPath(page, points) {
  await page.mouse.move(points[0].x, points[0].y);
  await page.keyboard.down('Alt');
  await page.mouse.down();
  for (const point of points.slice(1)) {
    await page.mouse.move(point.x, point.y, { steps: 6 });
  }
  await page.mouse.up();
  await page.keyboard.up('Alt');
}

test('a lasso drawn in the left cell selects exactly the cells drawn inside it', async ({ page }) => {
  const productErrors = observeProductErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGrid(page, 2);
  await colourByCellType(page);
  const projected = await projectViewCells(page, 'live');
  const { pane } = projected;
  const rect = {
    left: pane.left + 30,
    right: pane.left + (pane.right - pane.left) * 0.6,
    top: pane.top + 120,
    bottom: pane.bottom - 120,
  };
  await page.locator('.highlight-mode-btn[data-mode="lasso"]').click();
  await armSelection(page, 'lasso', () => altPath(page, [
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.top },
    { x: rect.right, y: rect.bottom },
    { x: rect.left, y: rect.bottom },
    { x: rect.left, y: rect.top },
  ]));
  const selected = new Set((await unifiedState(page)).candidates);
  const margin = 3;
  let inside = 0;
  for (const cell of projected.cells) {
    const clearlyInside = cell.x > rect.left + margin && cell.x < rect.right - margin
      && cell.y > rect.top + margin && cell.y < rect.bottom - margin;
    const clearlyOutside = cell.x < rect.left - margin || cell.x > rect.right + margin
      || cell.y < rect.top - margin || cell.y > rect.bottom + margin;
    if (clearlyInside) {
      inside += 1;
      expect(selected.has(cell.cellIndex), JSON.stringify(cell)).toBe(true);
    }
    if (clearlyOutside) {
      expect(selected.has(cell.cellIndex), JSON.stringify(cell)).toBe(false);
    }
  }
  expect(inside).toBeGreaterThan(5);
  expect(productErrors).toEqual([]);
});

test('proximity and KNN drags in the left cell grow from the cell under the pointer', async ({ page }) => {
  const productErrors = observeProductErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGrid(page, 2);
  await colourByCellType(page);
  const projected = await projectViewCells(page, 'live');
  const seed = isolatedCell(projected);

  await page.locator('.highlight-mode-btn[data-mode="proximity"]').click();
  await armSelection(page, 'proximity', () => altPath(page, [
    seed,
    { x: seed.x + 40, y: seed.y + 30 },
  ]));
  const proximity = await unifiedState(page);
  expect(proximity.candidates).toContain(seed.cellIndex);
  // A proximity sphere grown from a left-cell press stays a left-cell
  // selection: no cell is chosen that the left pane draws far away.
  const near = new Set(projected.cells
    .filter(cell => Math.hypot(cell.x - seed.x, cell.y - seed.y) < 400)
    .map(cell => cell.cellIndex));
  for (const cellIndex of proximity.candidates) {
    expect(near.has(cellIndex)).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(page.locator('#proximity-step-controls')).toHaveCount(0);

  // A chain graph (each cell's neighbours are the previous and next index),
  // handed over as the reader's edge payload.
  await page.evaluate(async () => {
    const { extractConnectivityEdges } = await import('/assets/js/data/connectivity-edges.js');
    const viewer = window._cellucidViewer;
    const count = viewer.getPointCount();
    const indptr = new Int32Array(count + 1);
    const indices = [];
    for (let index = 0; index < count; index++) {
      if (index > 0) indices.push(index - 1);
      if (index + 1 < count) indices.push(index + 1);
      indptr[index + 1] = indices.length;
    }
    viewer.loadKnnEdges(extractConnectivityEdges({
      format: 'csr',
      shape: [count, count],
      indptr,
      indices: Int32Array.from(indices),
      data: new Float32Array(indices.length).fill(1),
    }, count));
  });
  await page.locator('.highlight-mode-btn[data-mode="knn"]').click();
  await armSelection(page, 'knn', () => altPath(page, [
    seed,
    { x: seed.x, y: seed.y + 60 },
  ]));
  const knn = await unifiedState(page);
  expect(knn.candidates).toContain(seed.cellIndex);
  expect(productErrors).toEqual([]);
});

test('a projectile launched in the left cell flies in that cell', async ({ page }) => {
  const productErrors = observeProductErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGrid(page, 2);
  await page.locator('#navigation-mode').selectOption('free');
  await expect(page.locator('#navigation-mode')).toHaveValue('free');
  await page.locator('#projectiles-enabled').check();
  await page.waitForFunction(
    () => window._cellucidViewer.isProjectileSpatialIndexReady(),
  );
  const [left] = await paneCentres(page);
  const aim = { x: left.rect.left + 120, y: left.y - 80 };
  await page.mouse.move(aim.x, aim.y);
  // Press and release in the same task that reads the shot. Read at launch,
  // gravity has not yet bent it by however long a frame took. Released at
  // once, the shot is uncharged: a held press charges it, and a charged shot
  // leaves with more upward loft (`spawnProjectile`), so a hold whose length
  // was the runner's latency (150 ms meant, over 330 ms on a Windows runner)
  // put the launch point 28 px above the aim, and a full charge puts it 38 px
  // above.
  const flight = await page.evaluate(async ({ x, y }) => {
    const viewer = window._cellucidViewer;
    const press = { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y };
    document.getElementById('glcanvas').dispatchEvent(new MouseEvent('mousedown', {
      ...press,
      buttons: 1,
    }));
    window.dispatchEvent(new MouseEvent('mouseup', { ...press, buttons: 0 }));
    const canvasRect = document.getElementById('glcanvas').getBoundingClientRect();
    const project = () => {
      const { renderState } = viewer.getPresentedViewState('live');
      const { mvpMatrix: m, pane } = renderState;
      return viewer.getProjectilePositions().map(([x, y, z]) => {
        const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
        const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
        const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
        return {
          x: canvasRect.left + pane.cssLeft + ((cx / cw + 1) / 2) * pane.cssWidth,
          y: canvasRect.top + pane.cssTop + ((1 - cy / cw) / 2) * pane.cssHeight,
          inFront: cw > 0,
        };
      });
    };
    const first = project();
    await new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    return { first, later: project() };
  }, aim);
  const [shot] = flight.first;
  expect(shot.inFront).toBe(true);
  // The shot leaves from the camera straight through the aim point...
  expect(Math.abs(shot.x - aim.x)).toBeLessThan(25);
  expect(Math.abs(shot.y - aim.y)).toBeLessThan(25);
  // ...and keeps flying inside the left cell.
  for (const point of [...flight.first, ...flight.later]) {
    expect(point.x).toBeGreaterThan(left.rect.left);
    expect(point.x).toBeLessThan(left.rect.right);
  }
  expect(productErrors).toEqual([]);
});
