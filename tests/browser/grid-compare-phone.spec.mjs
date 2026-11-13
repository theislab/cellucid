/**
 * Grid compare keeps its panes a usable size on every screen shape.
 *
 * Two or three views always side by side would leave three panes about 120 px
 * wide on a 390 px phone held upright, so the grid takes the arrangement whose
 * panes are largest along their
 * shorter side, in the area the sidebar leaves (`getPresentedGridColumns`,
 * `rendering/viewer/presented-view-layout.js`): stacked on an upright phone,
 * side by side once it is turned, and every pane is drawn where the layout
 * says (its title chip over it).
 */
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { waitForHistory } from './helpers/state-history.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=grid-compare-phone`;

function observeProductErrors(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

function dispatch(page, type, params = {}) {
  return page.evaluate(async ([actionType, actionParams]) => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    try {
      const { outcome } = await getActions().dispatch(actionType, actionParams);
      return { outcome };
    } catch (error) {
      return { refused: error.message };
    }
  }, [type, params]);
}

/** The presented layout: its arrangement and each pane's CSS rectangle and title chip's place. */
function presented(page) {
  return page.evaluate(() => {
    const layout = window._cellucidViewer.getPresentedLayout();
    const canvas = document.getElementById('glcanvas').getBoundingClientRect();
    return {
      cols: layout.cols,
      rows: layout.rows,
      area: { width: layout.presentedArea.cssWidth, height: layout.presentedArea.cssHeight },
      panes: layout.panes.map(pane => ({ width: pane.cssWidth, height: pane.cssHeight, left: pane.cssLeft, top: pane.cssTop })),
      chips: [...document.querySelectorAll('.view-title-chip')].map(chip => {
        const box = chip.getBoundingClientRect();
        return { left: box.left - canvas.left, top: box.top - canvas.top };
      }),
    };
  });
}

test('three views on an upright phone stack, each the full width; turned sideways they stand side by side', async ({ page }) => {
  const errors = observeProductErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await waitForHistory(page);
  expect((await dispatch(page, 'view.keep', { name: 'Second' })).refused).toBeUndefined();
  expect((await dispatch(page, 'view.keep', { name: 'Third' })).refused).toBeUndefined();
  expect((await dispatch(page, 'view.layout.set', { layout: 'grid' })).refused).toBeUndefined();
  // The phone's sidebar over the canvas closed: the panes take the whole width.
  expect((await dispatch(page, 'layout.sidebar.show', { shown: false })).refused).toBeUndefined();
  await expect(page.locator('.view-title-chip')).toHaveCount(3);

  await expect.poll(async () => (await presented(page)).cols).toBe(1);
  const upright = await presented(page);
  expect(upright.rows).toBe(3);
  for (const pane of upright.panes) {
    // Each pane the presented width, a third of its height: never a 120 px sliver.
    expect(pane.width).toBeCloseTo(upright.area.width, 0);
    expect(pane.width).toBeGreaterThan(300);
    expect(pane.height).toBeGreaterThan(200);
  }
  // Each pane's title chip stands in its own pane: one above the other.
  const tops = upright.chips.map(chip => chip.top).sort((a, b) => a - b);
  expect(tops[1] - tops[0]).toBeGreaterThan(upright.panes[0].height * 0.8);

  // Turned sideways: one row of three.
  await page.setViewportSize({ width: 844, height: 390 });
  await expect.poll(async () => (await presented(page)).cols).toBe(3);
  const sideways = await presented(page);
  expect(sideways.rows).toBe(1);
  for (const pane of sideways.panes) expect(pane.width).toBeGreaterThan(250);
  expect(errors).toEqual([]);
});
