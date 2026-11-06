/**
 * View and camera actions in the real page (`app/actions/definitions/views.js`,
 * `camera.js`): every control of the Compare views list, the representation
 * picker, the Navigation panel, the 1/2/3, O/P/G and R keys and the Reset
 * camera button is one dispatched action with exact params, and leaves the
 * exact state; each action dispatched directly does the same and refuses a
 * name that does not resolve; a camera gesture and a click on a pane are
 * recorded by observation, once each, naming the view.
 *
 * The dataset has 1-D, 2-D and 3-D embeddings (`helpers/multi-dimension-
 * fixture.mjs`), so a view can show each and the keys cycle through them.
 */
import { expect, test } from './helpers/test.mjs';
import { appUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { installMultiDimensionFixture } from './helpers/multi-dimension-fixture.mjs';
import { waitForPageAtRest } from './helpers/dataset-ready.mjs';

const ROOT = appUrl('/tests/browser/fixtures/generated-actions-views-camera/');
const DATASET_ID = 'actions-views-camera';
const CELL_COUNT = 400;

function observeProductErrors(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

async function openDataset(page) {
  await installMultiDimensionFixture(page, {
    root: ROOT, datasetId: DATASET_ID, name: 'Views and camera fixture', cellCount: CELL_COUNT,
  });
  await page.goto(`/?sampleCatalog=${encodeURIComponent(ROOT)}&dataset=${DATASET_ID}`, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('Views and camera fixture');
  await waitForPageAtRest(page);
  // Every dispatch that ends, with its exact params and outcome.
  await page.evaluate(async () => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    window.__actionLog = [];
    getActions().subscribe(event => {
      if (event.kind !== 'done' && event.kind !== 'failed') return;
      window.__actionLog.push({
        kind: event.kind,
        type: event.type,
        params: JSON.parse(JSON.stringify(event.params)),
        outcome: event.outcome === undefined ? null : JSON.parse(JSON.stringify(event.outcome)),
        error: event.error?.message ?? null,
      });
    });
  });
}

/** The actions that ended since the last call. */
async function takeActions(page, count) {
  await expect.poll(() => page.evaluate(() => window.__actionLog.length)).toBe(count);
  return page.evaluate(() => window.__actionLog.splice(0));
}

function viewState(page) {
  return page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const state = window._cellucidState;
    const ids = [...(viewer.getLiveViewHidden() ? [] : ['live']), ...viewer.getSnapshotViews().map(view => view.id)];
    return {
      views: ids,
      active: state.getActiveViewId(),
      focused: viewer.getFocusedViewId(),
      layout: viewer.getViewLayout().mode,
      layoutSelect: document.getElementById('view-layout-mode').value,
      linked: viewer.getCamerasLocked(),
      shows: Object.fromEntries(ids.map(id => [id, state.getViewLayoutKey(id)])),
      modes: Object.fromEntries(ids.map(id => [id, viewer.getViewNavigationMode(id)])),
      modeSelect: document.getElementById('navigation-mode').value,
    };
  });
}

function badge(page, pill) {
  return page.locator('#split-view-badges-list .split-badge').filter({
    has: page.locator('.split-badge-pill', { hasText: new RegExp(`^${pill}$`) }),
  });
}

test('every view and camera control is one action with exact params and leaves the exact state', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openDataset(page);
  const opening = await viewState(page);
  expect(opening.views).toEqual(['live']);
  const liveShows = opening.shows.live;

  // Keep view.
  await page.locator('#split-keep-view-btn').click();
  const [keep] = await takeActions(page, 1);
  expect(keep).toEqual({ kind: 'done', type: 'view.keep', params: {}, outcome: { view: 'View 2' }, error: null });
  let views = await viewState(page);
  const kept = views.views[1];
  expect(views).toMatchObject({ views: ['live', kept], active: kept, focused: kept, layout: 'grid', layoutSelect: 'grid' });
  expect(views.shows[kept]).toBe(liveShows);

  // Layout: the selector asks, the viewer holds it.
  await page.locator('#view-layout-mode').selectOption('single');
  expect(await takeActions(page, 1)).toEqual([
    { kind: 'done', type: 'view.layout.set', params: { layout: 'single' }, outcome: { layout: 'single' }, error: null },
  ]);
  expect(await viewState(page)).toMatchObject({ layout: 'single', layoutSelect: 'single', focused: kept });
  await page.locator('#view-layout-mode').selectOption('grid');
  expect((await takeActions(page, 1))[0].params).toEqual({ layout: 'grid' });

  // Select a view by its row.
  await badge(page, 1).locator('.split-badge-select').click();
  expect(await takeActions(page, 1)).toEqual([
    { kind: 'done', type: 'view.focus', params: { view: 'View 1' }, outcome: { view: 'View 1' }, error: null },
  ]);
  expect(await viewState(page)).toMatchObject({ active: 'live', focused: 'live' });

  // Link cameras: they start linked; the button unlinks.
  expect((await viewState(page)).linked).toBe(true);
  await page.locator('#camera-lock-btn').click();
  expect(await takeActions(page, 1)).toEqual([
    { kind: 'done', type: 'view.cameras.link', params: { linked: false }, outcome: { linked: false }, error: null },
  ]);
  expect((await viewState(page)).linked).toBe(false);

  // A row's navigation badge: that view's mode, the next in the cycle.
  const keptMode = (await viewState(page)).modes[kept];
  const nextMode = { orbit: 'planar', planar: 'free', free: 'orbit' }[keptMode];
  await badge(page, 2).locator('.split-badge-nav').click();
  expect(await takeActions(page, 1)).toEqual([{
    kind: 'done', type: 'camera.navigation.set', params: { view: 'View 2', mode: nextMode },
    outcome: { view: 'View 2', mode: nextMode }, error: null,
  }]);
  expect((await viewState(page)).modes[kept]).toBe(nextMode);

  // The mode select drives the focused view (the live one).
  await page.locator('#navigation-mode').selectOption('free');
  expect((await takeActions(page, 1))[0]).toMatchObject({ type: 'camera.navigation.set', params: { view: 'View 1', mode: 'free' } });
  expect(await viewState(page)).toMatchObject({ modeSelect: 'free' });
  expect((await viewState(page)).modes.live).toBe('free');
  // O, P and G turn the select.
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.evaluate(() => document.activeElement?.blur());
  for (const [key, mode] of [['p', 'planar'], ['o', 'orbit'], ['g', 'free']]) {
    await page.keyboard.press(key);
    expect((await takeActions(page, 1))[0]).toMatchObject({ type: 'camera.navigation.set', params: { view: 'View 1', mode } });
    expect((await viewState(page)).modes.live).toBe(mode);
  }

  // The representation picker: an embedding by its obsm key and columns.
  const oneD = await page.evaluate(() => window._cellucidState.getEnabledRepresentations()
    .find(item => item.dimension === 1).layoutKey);
  await page.locator('#view-representation-select').selectOption(oneD);
  const [picked] = await takeActions(page, 1);
  expect(picked).toMatchObject({ type: 'view.embedding.set', params: { view: 'View 1', embedding: { key: 'X_umap_1d', columns: [0] } } });
  await expect.poll(async () => (await viewState(page)).shows.live).not.toBe(liveShows);
  const shows1d = (await viewState(page)).shows.live;
  expect(await page.evaluate(() => window._cellucidViewer.getViewDimension('live'))).toBe(1);

  // 2: the 2-D default; 3: the 3-D default, which the dataset opened on.
  await page.keyboard.press('2');
  expect((await takeActions(page, 1))[0]).toMatchObject({
    type: 'view.embedding.cycle', params: { view: 'View 1', dimension: 2 }, outcome: { view: 'View 1', position: 1, count: 1 },
  });
  expect(await page.evaluate(() => window._cellucidViewer.getViewDimension('live'))).toBe(2);
  await page.keyboard.press('3');
  expect((await takeActions(page, 1))[0]).toMatchObject({ type: 'view.embedding.cycle', params: { view: 'View 1', dimension: 3 } });
  expect((await viewState(page)).shows.live).toBe(liveShows);
  expect(await page.evaluate(() => window._cellucidViewer.getViewDimension('live'))).toBe(3);
  expect(shows1d).not.toBe(liveShows);

  // R: the focused view's camera.
  await page.keyboard.press('r');
  expect(await takeActions(page, 1)).toEqual([
    { kind: 'done', type: 'camera.reset', params: { view: 'View 1' }, outcome: { view: 'View 1' }, error: null },
  ]);

  // Reset camera button: the camera and display.
  await page.locator('#reset-camera-btn').click();
  expect(await takeActions(page, 1)).toEqual([
    { kind: 'done', type: 'display.reset', params: {}, outcome: null, error: null },
  ]);

  // A row's remove control.
  await badge(page, 2).locator('.split-badge-remove').click();
  expect(await takeActions(page, 1)).toEqual([
    { kind: 'done', type: 'view.remove', params: { view: 'View 2' }, outcome: { view: 'View 2' }, error: null },
  ]);
  expect((await viewState(page)).views).toEqual(['live']);

  // Two kept views, then Clear.
  await page.locator('#split-keep-view-btn').click();
  await page.locator('#split-keep-view-btn').click();
  expect((await takeActions(page, 2)).map(action => action.outcome)).toEqual([{ view: 'View 2' }, { view: 'View 3' }]);
  await page.locator('#split-clear-btn').click();
  expect(await takeActions(page, 1)).toEqual([
    { kind: 'done', type: 'view.clear', params: {}, outcome: { views: 2 }, error: null },
  ]);
  expect(await viewState(page)).toMatchObject({ views: ['live'], active: 'live', focused: 'live', layout: 'grid' });
  expect(errors).toEqual([]);
});

test('each view and camera action dispatched directly leaves the exact state; names that do not resolve are refused', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openDataset(page);
  const result = await page.evaluate(async () => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    const actions = getActions();
    const viewer = window._cellucidViewer;
    const state = window._cellucidState;
    const out = {};
    const refusal = async (type, params) => {
      try {
        await actions.dispatch(type, params);
        return 'applied';
      } catch (error) {
        return `${error.name}: ${error.message}`;
      }
    };

    out.keep = (await actions.dispatch('view.keep', {})).outcome;
    const kept = viewer.getSnapshotViews()[0].id;
    out.keptActive = state.getActiveViewId() === kept;
    out.focus = (await actions.dispatch('view.focus', { view: 'View 1' })).outcome;
    out.activeAfterFocus = state.getActiveViewId();
    await actions.dispatch('view.layout.set', { layout: 'single' });
    out.layout = viewer.getViewLayout().mode;
    await actions.dispatch('view.layout.set', { layout: 'grid' });
    await actions.dispatch('view.cameras.link', { linked: false });
    out.linked = viewer.getCamerasLocked();

    out.set3d = (await actions.dispatch('view.embedding.set', { view: 'View 2', embedding: { key: 'X_umap_3d', columns: [0, 1, 2] } })).outcome;
    out.keptDimension = viewer.getViewDimension(kept);
    out.liveDimension = viewer.getViewDimension('live');
    out.default1d = (await actions.dispatch('view.embedding.default', { view: 'View 1', dimension: 1 })).outcome;
    out.liveDimensionAfterDefault = viewer.getViewDimension('live');
    out.liveFollowsDefault = state.viewFollowsDefault('live');
    out.cycle = (await actions.dispatch('view.embedding.cycle', { view: 'View 1', dimension: 2 })).outcome;
    out.liveDimensionAfterCycle = viewer.getViewDimension('live');

    const camera = viewer.getViewCameraState(kept);
    camera.orbit.radius *= 1.5;
    camera.orbit.targetRadius = camera.orbit.radius;
    camera.orbit.theta += 0.25;
    await actions.dispatch('camera.set', { view: 'View 2', camera });
    const placed = viewer.getViewCameraState(kept);
    out.cameraPlaced = placed.orbit.radius === camera.orbit.radius && placed.orbit.theta === camera.orbit.theta;
    await actions.dispatch('camera.navigation.set', { view: 'View 2', mode: 'free' });
    out.keptMode = viewer.getViewNavigationMode(kept);
    await actions.dispatch('camera.reset', { view: 'View 2' });
    const reset = viewer.getViewCameraState(kept);
    out.keptResetMode = reset.navigationMode;
    out.keptResetRadiusChanged = reset.orbit.radius !== camera.orbit.radius;

    out.hide = (await actions.dispatch('cells.visibility.set', { cells: [9, 0, 5, 5], visible: false })).outcome;
    out.maskHidden = [0, 5, 9].map(cell => state.cellVisibilityMask[cell]);
    out.maskOthers = Array.from(state.cellVisibilityMask).filter((value, cell) => ![0, 5, 9].includes(cell) && value !== 1).length;
    out.show = (await actions.dispatch('cells.visibility.set', { cells: null, visible: true })).outcome;
    out.maskAfterShow = Array.from(state.cellVisibilityMask).every(value => value === 1);

    out.refusals = {
      focus: await refusal('view.focus', { view: 'View 7' }),
      camera: await refusal('camera.reset', { view: 'View 9' }),
      cells: await refusal('cells.visibility.set', { cells: [400], visible: false }),
      embedding: await refusal('view.embedding.set', { view: 'View 1', embedding: { key: 'X_none', columns: [0, 1] } }),
      smokeless: await refusal('view.embedding.cycle', { view: 'View 1', dimension: 3 }) === 'applied',
    };
    out.remove = (await actions.dispatch('view.remove', { view: 'View 2' })).outcome;
    out.viewsAfterRemove = viewer.getSnapshotViews().length;
    out.refusals.clear = await refusal('view.clear', {});
    out.refusals.removeLive = await refusal('view.remove', { view: 'View 1' });
    return out;
  });
  expect(result).toEqual({
    keep: { view: 'View 2' },
    keptActive: true,
    focus: { view: 'View 1' },
    activeAfterFocus: 'live',
    layout: 'single',
    linked: false,
    set3d: { view: 'View 2' },
    keptDimension: 3,
    liveDimension: 3,
    default1d: { view: 'View 1', embedding: expect.any(String) },
    liveDimensionAfterDefault: 1,
    liveFollowsDefault: true,
    cycle: { view: 'View 1', embedding: expect.any(String), position: 1, count: 1 },
    liveDimensionAfterCycle: 2,
    cameraPlaced: true,
    keptMode: 'free',
    keptResetMode: 'free',
    keptResetRadiusChanged: true,
    hide: { cells: 3, not_open: 0 },
    maskHidden: [0, 0, 0],
    maskOthers: 0,
    show: { cells: CELL_COUNT, not_open: 0 },
    maskAfterShow: true,
    refusals: {
      focus: 'ActionRefused: There is no View 7: 2 views are open (View 1 and View 2).',
      camera: 'ActionRefused: There is no View 9: 2 views are open (View 1 and View 2).',
      cells: `ActionRefused: Original cell position 400 is outside the ${CELL_COUNT} cells of the dataset.`,
      embedding: expect.stringMatching(/^ActionRefused: .*X_none/),
      smokeless: true,
      clear: 'ActionRefused: There are no kept views to remove.',
      removeLive: 'ActionRefused: The live view is the only view; keep a view before removing it.',
    },
    remove: { view: 'View 2' },
    viewsAfterRemove: 0,
  });
  expect(errors).toEqual([]);
});

test('a camera gesture and a click on a pane are each recorded once by observation, naming the view', async ({ page }) => {
  const errors = observeProductErrors(page);
  await openDataset(page);
  await page.locator('#split-keep-view-btn').click();
  await takeActions(page, 1);
  await page.locator('#camera-lock-btn').click();
  await takeActions(page, 1);
  await waitForPageAtRest(page);
  // What reaches the recorder (the history, once the page has one).
  await page.evaluate(async () => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    window.__observed = [];
    getActions().setRecorder({
      before: async () => null,
      after: async () => null,
      failed: async () => {},
      async observed({ definition, params, meta }) {
        window.__observed.push({ type: definition.type, params: JSON.parse(JSON.stringify(params)), origin: meta.origin });
        return null;
      },
    });
  });

  // Drag the selected (kept) view's pane: one camera.set of that view, with
  // the camera it settled at.
  // The centre of each pane as the page sees it.
  const centres = await page.evaluate(() => {
    const rect = document.getElementById('glcanvas').getBoundingClientRect();
    return Object.fromEntries(window._cellucidViewer.getPresentedLayout().panes.map(pane => [pane.viewId, {
      x: rect.left + pane.visibleCssLeft + pane.visibleCssWidth / 2,
      y: rect.top + pane.visibleCssTop + pane.visibleCssHeight / 2,
    }]));
  });
  const kept = await page.evaluate(() => window._cellucidViewer.getSnapshotViews()[0].id);
  const centre = centres[kept];
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + 60, centre.y + 25, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.__observed.filter(item => item.type === 'camera.set').length)).toBe(1);
  await waitForPageAtRest(page);
  const gesture = await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const kept = viewer.getSnapshotViews()[0].id;
    return {
      observed: window.__observed.filter(item => item.type === 'camera.set'),
      camera: viewer.getViewCameraState(kept),
    };
  });
  expect(gesture.observed).toEqual([{ type: 'camera.set', params: { view: 'View 2', camera: gesture.camera }, origin: 'user' }]);

  // A dispatched camera change is its own step: a settle it causes later
  // observes exactly the camera the action left, which the history compares
  // with what it shows and records nothing for.
  for (const [type, params] of [
    ['camera.reset', { view: 'View 2' }],
    ['camera.set', { view: 'View 2', camera: gesture.camera }],
  ]) {
    await page.evaluate(() => { window.__observed.length = 0; });
    const left = await page.evaluate(async ({ type, params }) => {
      const { getActions } = await import('/assets/js/app/actions/index.js');
      await getActions().dispatch(type, params);
      const viewer = window._cellucidViewer;
      return viewer.getViewCameraState(viewer.getSnapshotViews()[0].id);
    }, { type, params });
    await waitForPageAtRest(page);
    const after = await page.evaluate(() => window.__observed.filter(item => item.type === 'camera.set'));
    for (const record of after) expect(record.params).toEqual({ view: 'View 2', camera: left });
    expect(after.length).toBeLessThanOrEqual(1);
  }

  // A click on the live pane selects it: the viewer focuses it first, the
  // step is observed.
  await page.evaluate(() => { window.__observed.length = 0; });
  await page.mouse.click(centres.live.x, centres.live.y);
  await expect.poll(() => page.evaluate(() => window.__observed.filter(item => item.type === 'view.focus'))).toEqual([
    { type: 'view.focus', params: { view: 'View 1' }, origin: 'user' },
  ]);
  expect(await page.evaluate(() => window._cellucidState.getActiveViewId())).toBe('live');
  expect(errors).toEqual([]);
});
