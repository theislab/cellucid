/**
 * The plot and the sidebar share the screen of a phone or a small tablet in
 * every sidebar state: open, closed, and open again.
 *
 * On a phone the open sidebar is a full-screen sheet with a strip at its top
 * for the close control. That strip lay outside the sheet's scroll area, which
 * is what paints the sheet, so it was transparent and showed a band of the
 * live plot above the menu. Each state here measures the canvas against the
 * viewport, its drawing buffer against the device pixels, the toggle's place,
 * and the paint of the strip; a rotation and a two-finger gesture follow.
 */

import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`
  + '&dataset=current-ui&acceptance=mobile-sidebar-geometry-ci';

async function openDataset(page) {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture',
  );
}

/** Wait until the sidebar's open or close slide has finished. */
async function sidebarSettled(page) {
  await expect.poll(() => page.evaluate(
    () => document.getElementById('sidebar').getAnimations().length,
  )).toBe(0);
}

async function toggleSidebar(page, { hidden }) {
  await page.locator('#sidebar-toggle').tap();
  const sidebar = page.locator('#sidebar');
  if (hidden) await expect(sidebar).toHaveClass(/\bhidden\b/);
  else await expect(sidebar).not.toHaveClass(/\bhidden\b/);
  await sidebarSettled(page);
}

function measure(page) {
  return page.evaluate(() => {
    // Edges in device pixels, the grid every box is drawn on: WebKit lays
    // out in 1/64 px units, so a box ending on the viewport edge can report
    // 1/64 px short of it in CSS pixels.
    const snap = value => Math.round(value * devicePixelRatio);
    const rect = element => {
      const box = element.getBoundingClientRect();
      return {
        left: snap(box.left),
        top: snap(box.top),
        right: snap(box.right),
        bottom: snap(box.bottom),
      };
    };
    const canvas = document.getElementById('glcanvas');
    const sidebar = document.getElementById('sidebar');
    const toggle = document.getElementById('sidebar-toggle');
    const scroll = sidebar.querySelector('.sidebar-scroll');
    const toggleBox = toggle.getBoundingClientRect();
    const hit = document.elementFromPoint(
      toggleBox.left + toggleBox.width / 2,
      toggleBox.top + toggleBox.height / 2,
    );
    const centre = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    return {
      viewport: {
        width: snap(innerWidth),
        height: snap(innerHeight),
      },
      canvas: rect(canvas),
      buffer: { width: canvas.width, height: canvas.height },
      sidebar: rect(sidebar),
      scrollTop: snap(scroll.getBoundingClientRect().top),
      sidebarPaint: getComputedStyle(sidebar).backgroundColor,
      paperPaint: getComputedStyle(scroll).backgroundColor,
      toggle: rect(toggle),
      toggleSize: { width: toggleBox.width, height: toggleBox.height },
      toggleOnTop: hit === toggle || toggle.contains(hit),
      plotAtCentre: centre === canvas,
    };
  });
}

/** The canvas fills the viewport and its buffer matches the device pixels. */
function expectCanvasFillsViewport(geometry) {
  const { canvas, viewport, buffer } = geometry;
  expect(canvas).toEqual({
    left: 0,
    top: 0,
    right: viewport.width,
    bottom: viewport.height,
  });
  expect(buffer).toEqual({
    width: viewport.width,
    height: viewport.height,
  });
}

function expectToggleOnScreen(geometry) {
  const { toggle, viewport } = geometry;
  expect(toggle.left).toBeGreaterThanOrEqual(0);
  expect(toggle.top).toBeGreaterThanOrEqual(0);
  expect(toggle.right).toBeLessThanOrEqual(viewport.width);
  expect(toggle.bottom).toBeLessThanOrEqual(viewport.height);
  // A fingertip target on a touch screen.
  expect(geometry.toggleSize.width).toBeGreaterThanOrEqual(44);
  expect(geometry.toggleSize.height).toBeGreaterThanOrEqual(44);
  expect(geometry.toggleOnTop, 'nothing covers the toggle').toBe(true);
}

/** Alpha of a computed `rgb()`/`rgba()`/`color()` value. */
function alphaOf(color) {
  const slash = color.match(/\/\s*([\d.]+)\s*\)$/);
  if (slash) return Number(slash[1]);
  const rgba = color.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/);
  if (rgba) return Number(rgba[1]);
  return 1;
}

async function expectBufferFollows(page) {
  await expect.poll(async () => {
    const geometry = await measure(page);
    return {
      canvas: geometry.canvas,
      buffer: geometry.buffer,
    };
  }).toEqual(await page.evaluate(() => ({
    canvas: {
      left: 0,
      top: 0,
      right: Math.round(innerWidth * devicePixelRatio),
      bottom: Math.round(innerHeight * devicePixelRatio),
    },
    buffer: {
      width: Math.round(innerWidth * devicePixelRatio),
      height: Math.round(innerHeight * devicePixelRatio),
    },
  })));
}

for (const phone of [
  { name: 'an iPhone', width: 390, height: 844, dpr: 3 },
  { name: 'an Android phone', width: 412, height: 915, dpr: 2.625 },
]) {
  test.describe(`on ${phone.name} held upright`, () => {
    test.use({
      viewport: { width: phone.width, height: phone.height },
      deviceScaleFactor: phone.dpr,
      hasTouch: true,
    });

    test('the sheet covers the plot whole, and closed the plot fills the screen', async ({
      page,
    }) => {
      await openDataset(page);
      await sidebarSettled(page);

      for (const state of ['open', 'closed', 'open again']) {
        if (state === 'closed') await toggleSidebar(page, { hidden: true });
        if (state === 'open again') await toggleSidebar(page, { hidden: false });
        const geometry = await measure(page);
        expectCanvasFillsViewport(geometry);
        expectToggleOnScreen(geometry);

        if (state === 'closed') {
          expect(geometry.sidebar.right, 'the closed sheet is off screen')
            .toBeLessThanOrEqual(0);
          expect(geometry.plotAtCentre).toBe(true);
          expect(geometry.toggle).toMatchObject({ left: 0, top: 0 });
          continue;
        }

        // The open sheet is the whole screen, painted edge to edge in the
        // sidebar's paper, the close-control strip included: no band of the
        // plot shows through above the menu.
        expect(geometry.sidebar).toEqual(geometry.canvas);
        expect(geometry.plotAtCentre).toBe(false);
        expect(geometry.sidebarPaint, `${state}: the strip is painted`)
          .toBe(geometry.paperPaint);
        expect(alphaOf(geometry.sidebarPaint)).toBe(1);
        // The close control sits in the strip, top right, above the menu.
        expect(geometry.toggle).toMatchObject({
          top: 0,
          right: geometry.viewport.width,
        });
        expect(geometry.scrollTop).toBeGreaterThanOrEqual(geometry.toggle.bottom);
      }
    });

    test('the plot redraws at the new size on rotation and keeps its gestures', async ({
      page,
    }) => {
      await openDataset(page);
      await toggleSidebar(page, { hidden: true });

      // Turned on its side the phone is past the sheet breakpoint: the
      // sidebar floats beside the plot instead.
      await page.setViewportSize({ width: phone.height, height: phone.width });
      await expectBufferFollows(page);
      await toggleSidebar(page, { hidden: false });
      let geometry = await measure(page);
      expectCanvasFillsViewport(geometry);
      expectToggleOnScreen(geometry);
      expect(geometry.sidebar.right).toBeLessThan(geometry.viewport.width / 2);
      expect(geometry.toggle.left).toBeGreaterThanOrEqual(geometry.sidebar.right);

      await page.setViewportSize({ width: phone.width, height: phone.height });
      await expectBufferFollows(page);
      geometry = await measure(page);
      expect(geometry.sidebar).toEqual(geometry.canvas);
      expectToggleOnScreen(geometry);

      // After every toggle and turn, two fingers still pinch the plot.
      await toggleSidebar(page, { hidden: true });
      const cameraOf = () => page.evaluate(
        () => JSON.stringify(window._cellucidViewer.getCameraState()),
      );
      const before = await cameraOf();
      // The camera is at rest, so a change below is the gesture's.
      await page.evaluate(() => new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }));
      expect(await cameraOf()).toBe(before);
      await page.evaluate(() => {
        const canvas = document.getElementById('glcanvas');
        const midY = innerHeight / 2;
        const fire = (type, index, x, y) => canvas.dispatchEvent(new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 60 + index,
          pointerType: 'touch',
          isPrimary: index === 0,
          button: type === 'pointermove' ? -1 : 0,
          buttons: type === 'pointerup' ? 0 : 1,
          clientX: x,
          clientY: y,
        }));
        const midX = innerWidth / 2;
        fire('pointerdown', 0, midX - 30, midY);
        fire('pointerdown', 1, midX + 30, midY);
        for (let step = 1; step <= 12; step++) {
          fire('pointermove', 0, midX - 30 - step * 8, midY + step * 3);
          fire('pointermove', 1, midX + 30 + step * 8, midY + step * 3);
        }
        fire('pointerup', 0, midX - 126, midY + 36);
        fire('pointerup', 1, midX + 126, midY + 36);
      });
      await expect.poll(cameraOf).not.toBe(before);
    });
  });
}

test.describe('on a small tablet', () => {
  test.use({
    viewport: { width: 768, height: 1024 },
    deviceScaleFactor: 2,
    hasTouch: true,
  });

  test('the sidebar floats beside the plot in every state', async ({ page }) => {
    await openDataset(page);
    await sidebarSettled(page);
    for (const state of ['open', 'closed', 'open again']) {
      if (state === 'closed') await toggleSidebar(page, { hidden: true });
      if (state === 'open again') await toggleSidebar(page, { hidden: false });
      const geometry = await measure(page);
      expectCanvasFillsViewport(geometry);
      expectToggleOnScreen(geometry);
      expect(geometry.plotAtCentre).toBe(true);
      if (state === 'closed') {
        expect(geometry.sidebar.right).toBeLessThanOrEqual(0);
        expect(geometry.toggle.left).toBeLessThan(geometry.viewport.width / 4);
      } else {
        expect(geometry.sidebar.left).toBeGreaterThan(0);
        expect(geometry.sidebar.right).toBeLessThan(geometry.viewport.width / 2);
        expect(geometry.toggle.left).toBeGreaterThanOrEqual(geometry.sidebar.right);
      }
    }
  });
});
