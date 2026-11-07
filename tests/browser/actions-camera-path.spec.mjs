/**
 * Camera path actions in the page (`app/actions/definitions/camera.js`,
 * `app/ui/modules/cinematic-camera/index.js`): every Camera path control
 * dispatches exactly one action with exact parameters and leaves the exact
 * path; each action dispatched directly leaves the exact path and controls,
 * and a label that does not resolve is refused with a sentence; and, once the
 * state domains are installed, undoing each action (putting back the domains
 * it touches) gives back the whole state.
 */
import { expect, test } from './helpers/test.mjs';
import { applyUndoRedo, takeSteps, waitForHistory } from './helpers/state-history.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { whenActionsShown } from './helpers/dataset-ready.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=actions-camera-path`;
const LOOP_BACK = '↩ Return to start';

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

async function openCameraPath(page) {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  await page.locator('#cinematic-camera-section > summary').click();
  // A change recorded by observation is a step only once the history records.
  await waitForHistory(page);
  // The section's opening is a step: its History row is drawn before a click below it.
  await whenActionsShown(page);
  // Every dispatch, in order, as {type, params}; a failed one with its
  // message; a camera path setting a control made and the history recorded
  // from its event (no dispatch: the control is the setting) with `observed`.
  await page.evaluate(async () => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    window.__dispatched = [];
    const running = new Map();
    getActions().subscribe(event => {
      if (event.kind === 'start') {
        running.set(event.type, (running.get(event.type) ?? 0) + 1);
        window.__dispatched.push({ type: event.type, params: JSON.parse(JSON.stringify(event.params)) });
      } else if (event.kind === 'failed') {
        running.set(event.type, Math.max(0, (running.get(event.type) ?? 0) - 1));
        window.__dispatched.push({ type: event.type, failed: event.error?.message ?? String(event.error) });
      } else if (event.kind === 'done') {
        if ((running.get(event.type) ?? 0) > 0) {
          running.set(event.type, running.get(event.type) - 1);
        } else if (event.type.startsWith('camera-path.')) {
          window.__dispatched.push({ type: event.type, params: JSON.parse(JSON.stringify(event.params)), observed: true });
        }
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
    // And shown: the History panel above draws the step's row on a later
    // frame, moving the controls the next click aims at (`whenActionsShown`).
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const taken = window.__dispatched;
    window.__dispatched = [];
    return taken;
  });
}

/** How many "Changed outside the history" steps the tracker in use holds. */
function outsideSteps(page) {
  return page.evaluate(() => [...window._cellucidHistories.current().active.steps.values()]
    .filter(step => step.type === 'history.outside-change').length);
}

/** The path as the Camera path module holds it (`exportPath`, the `camera-path` domain's value). */
function readPath(page) {
  return page.evaluate(() => {
    const saved = window._cellucidUi.cinematicCamera.exportPath();
    return {
      labels: saved.keyframes.map(kf => kf.label),
      durations: saved.keyframes.map(kf => kf.transitionDuration),
      loopBack: saved.loopBackKeyframeId === null
        ? null
        : saved.keyframes.find(kf => kf.id === saved.loopBackKeyframeId)?.label ?? 'missing',
      playback: {
        position: saved.positionMethod,
        rotation: saved.rotationMethod,
        easing: saved.easing,
        speed: saved.defaultSpeed,
        loop: saved.loopPlayback,
        autoplay: saved.autoplay,
      },
    };
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

function keyframeItem(page, label) {
  return page.locator('.cinematic-keyframe-item').filter({
    has: page.locator('.cinematic-keyframe-label', { hasText: label }),
  });
}

/** The focused view's camera and the embedding it shows, as a keyframe saved now records them. */
function cameraNow(page) {
  return page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const state = window._cellucidState;
    const viewId = viewer.getFocusedViewId();
    return {
      camera: viewer.getCameraState(),
      embedding: state.getDataMapping() === null ? null : state.getViewEmbeddingRef(viewId),
    };
  });
}

test('every Camera path control dispatches one action with exact parameters and leaves the exact path', async ({ page }) => {
  const productErrors = observeProductErrors(page);
  await openCameraPath(page);

  // Save position, three times: the camera and embedding of that moment.
  for (const label of ['KF 1', 'KF 2', 'KF 3']) {
    const expected = await cameraNow(page);
    await page.locator('#cinematic-save-btn').click();
    expect(await takeDispatched(page)).toEqual([{ type: 'camera-path.keyframe.add', params: expected }]);
    await expect(keyframeItem(page, label)).toHaveCount(1);
    await page.evaluate(() => {
      // Move the camera a little, so each keyframe is its own pose.
      const viewer = window._cellucidViewer;
      const camera = viewer.getCameraState();
      camera.orbit.theta += 0.3;
      viewer.setCameraState(camera);
    });
  }
  expect((await readPath(page)).labels).toEqual(['KF 1', 'KF 2', 'KF 3']);

  await keyframeItem(page, 'KF 3').locator('[data-action="up"]').click();
  expect(await takeDispatched(page)).toEqual([
    { type: 'camera-path.keyframe.move', params: { keyframe: 'KF 3', direction: 'up' } },
  ]);
  await keyframeItem(page, 'KF 1').locator('[data-action="down"]').click();
  expect(await takeDispatched(page)).toEqual([
    { type: 'camera-path.keyframe.move', params: { keyframe: 'KF 1', direction: 'down' } },
  ]);
  expect((await readPath(page)).labels).toEqual(['KF 3', 'KF 1', 'KF 2']);
  // The first keyframe cannot move up: its button is off and dispatches nothing.
  await expect(keyframeItem(page, 'KF 3').locator('[data-action="up"]')).toBeDisabled();

  // Rename: a label in use is said on the input and not dispatched.
  await keyframeItem(page, 'KF 1').locator('[data-action="rename"]').click();
  const rename = page.locator('.cinematic-keyframe-rename');
  await rename.fill('KF 2');
  await rename.press('Enter');
  expect(await takeDispatched(page)).toEqual([]);
  expect(await rename.evaluate(input => input.validationMessage)).toBe(
    'A keyframe is labelled "KF 2" already; choose another label.'
  );
  await rename.fill('Close-up');
  await rename.press('Enter');
  expect(await takeDispatched(page)).toEqual([
    { type: 'camera-path.keyframe.rename', params: { keyframe: 'KF 1', label: 'Close-up' } },
  ]);
  await expect(rename).toHaveCount(0);
  expect((await readPath(page)).labels).toEqual(['KF 3', 'Close-up', 'KF 2']);

  // One transition, typed; then every transition.
  const firstPair = page.locator('.cinematic-duration-input[data-pair-index="0"]');
  await firstPair.fill('2.5');
  await firstPair.press('Tab');
  expect(await takeDispatched(page)).toEqual([
    { type: 'camera-path.duration.set', params: { keyframe: 'KF 3', seconds: 2.5 } },
  ]);
  expect((await readPath(page)).durations).toEqual([2.5, null, null]);
  await page.locator('#cinematic-set-all-duration').fill('1.5');
  await page.locator('#cinematic-set-all-btn').click();
  expect(await takeDispatched(page)).toEqual([
    { type: 'camera-path.duration.set', params: { seconds: 1.5 } },
  ]);
  expect((await readPath(page)).durations).toEqual([1.5, 1.5, 1.5]);

  // The return to start.
  await page.locator('.cinematic-loopback-list-toggle').check();
  expect(await takeDispatched(page)).toEqual([
    { type: 'camera-path.loop-back.set', params: { enabled: true } },
  ]);
  expect(await readPath(page)).toMatchObject({ labels: ['KF 3', 'Close-up', 'KF 2', LOOP_BACK], loopBack: LOOP_BACK });
  await expect(page.locator('.cinematic-loopback-list-toggle')).toBeChecked();

  // Delete.
  await keyframeItem(page, 'Close-up').locator('[data-action="delete"]').click();
  expect(await takeDispatched(page)).toEqual([
    { type: 'camera-path.keyframe.remove', params: { keyframe: 'Close-up' } },
  ]);
  expect((await readPath(page)).labels).toEqual(['KF 3', 'KF 2', LOOP_BACK]);

  // Go to a keyframe: the selected view's camera is placed there.
  const target = await page.evaluate(() => {
    const kf = window._cellucidUi.cinematicCamera.getKeyframeStore().getAll()[0];
    return { navigationMode: kf.navigationMode, orbit: { ...kf.orbit, target: [...kf.orbit.target] }, freefly: { ...kf.freefly, position: [...kf.freefly.position] } };
  });
  await keyframeItem(page, 'KF 3').locator('[data-action="goto"]').click();
  expect(await takeDispatched(page)).toEqual([{ type: 'camera.set', params: { view: 'View 1', camera: target } }]);
  expect(await page.evaluate(async keyframe => {
    const { cameraStatesHaveSamePose } = await import('/assets/js/rendering/camera-state-contract.js');
    return cameraStatesHaveSamePose(window._cellucidViewer.getCameraState(), keyframe);
  }, target)).toBe(true);
  await expect(page.locator('#navigation-mode')).toHaveValue(target.navigationMode);

  // Playback settings: one step each, recorded from the control's own event
  // (the control is the setting), never a "Changed outside the history" one.
  const outsideBefore = await outsideSteps(page);
  await page.locator('#cinematic-default-speed').fill('70');
  expect(await takeDispatched(page)).toEqual([{ type: 'camera-path.playback.set', params: { speed: 70 }, observed: true }]);
  await expect(page.locator('#cinematic-default-speed-display')).toHaveText('Fast');
  await page.locator('#cinematic-position-interp').selectOption('bezier');
  await page.locator('#cinematic-rotation-interp').selectOption('linear');
  await page.locator('#cinematic-easing').selectOption('ease-in');
  await page.locator('#cinematic-loop').check();
  expect(await takeDispatched(page)).toEqual([
    { type: 'camera-path.playback.set', params: { position_interpolation: 'bezier' }, observed: true },
    { type: 'camera-path.playback.set', params: { rotation_interpolation: 'linear' }, observed: true },
    { type: 'camera-path.playback.set', params: { easing: 'ease-in' }, observed: true },
    { type: 'camera-path.playback.set', params: { loop: true }, observed: true },
  ]);
  expect(await outsideSteps(page)).toBe(outsideBefore);
  expect((await readPath(page)).playback).toEqual({
    position: 'bezier', rotation: 'linear', easing: 'ease-in', speed: '70', loop: true, autoplay: false,
  });

  // Autoplay on: the ready path starts playing at once.
  await page.locator('#cinematic-autoplay').check();
  expect(await takeDispatched(page)).toEqual([{ type: 'camera-path.playback.set', params: { autoplay: true }, observed: true }]);
  expect(await page.evaluate(() => window._cellucidUi.cinematicCamera.getPlaybackController().getState())).toBe('PLAYING');

  // Clear all: playback stops where the camera is, and the path is empty.
  await page.locator('#cinematic-clear-btn').click();
  expect(await takeDispatched(page)).toEqual([{ type: 'camera-path.clear', params: {} }]);
  expect(await page.evaluate(() => window._cellucidUi.cinematicCamera.getPlaybackController().getState())).toBe('STOPPED');
  expect((await readPath(page)).labels).toEqual([]);
  await expect(page.locator('#cinematic-keyframe-list .empty-state')).toHaveText('No keyframes saved yet.');

  expect(productErrors).toEqual([]);
});

test('each camera path action dispatched directly leaves the exact path, and an unknown label is refused', async ({ page }) => {
  const productErrors = observeProductErrors(page);
  await openCameraPath(page);
  const { camera } = await cameraNow(page);
  const pose = theta => ({ ...camera, orbit: { ...camera.orbit, theta } });

  expect(await dispatch(page, 'camera-path.keyframe.add', { camera: pose(0.1), label: 'Wide' }))
    .toEqual({ outcome: { keyframe: 'Wide' } });
  expect(await dispatch(page, 'camera-path.keyframe.add', { camera: pose(0.4) }))
    .toEqual({ outcome: { keyframe: 'KF 1' } });
  expect(await dispatch(page, 'camera-path.keyframe.add', { camera: pose(0.7), label: 'Wide' }))
    .toEqual({ refused: true, message: 'A keyframe is labelled "Wide" already; choose another label.' });
  await expect(page.locator('.cinematic-keyframe-item')).toHaveCount(2);
  expect(await page.evaluate(() => window._cellucidUi.cinematicCamera.getKeyframeStore().getAll()[0].orbit.theta)).toBe(0.1);

  expect(await dispatch(page, 'camera-path.keyframe.remove', { keyframe: 'Close' }))
    .toEqual({ refused: true, message: 'There is no keyframe "Close"; its keyframes are "Wide" and "KF 1".' });
  expect(await dispatch(page, 'camera-path.keyframe.rename', { keyframe: 'KF 1', label: 'Close' }))
    .toEqual({ outcome: { keyframe: 'Close' } });
  expect(await dispatch(page, 'camera-path.keyframe.move', { keyframe: 'Close', direction: 'up' }))
    .toEqual({ outcome: { keyframe: 'Close' } });
  expect(await dispatch(page, 'camera-path.duration.set', { keyframe: 'Close', seconds: 3 }))
    .toEqual({ outcome: { keyframe: 'Close' } });
  expect(await dispatch(page, 'camera-path.duration.set', { keyframe: 'Wide', seconds: 3 }))
    .toEqual({ refused: true, message: 'No transition starts at "Wide": it is the last keyframe.' });
  expect(await dispatch(page, 'camera-path.loop-back.set', { enabled: true })).toEqual({ outcome: null });
  expect(await readPath(page)).toMatchObject({
    labels: ['Close', 'Wide', LOOP_BACK], durations: [3, null, null], loopBack: LOOP_BACK,
  });
  await expect(page.locator('.cinematic-keyframe-label').first()).toHaveText('Close');
  await expect(page.locator('.cinematic-loopback-list-toggle')).toBeChecked();

  expect(await dispatch(page, 'camera-path.playback.set', { easing: 'ease-out', speed: 5, loop: true }))
    .toEqual({ outcome: null });
  await expect(page.locator('#cinematic-easing')).toHaveValue('ease-out');
  await expect(page.locator('#cinematic-default-speed')).toHaveValue('5');
  await expect(page.locator('#cinematic-default-speed-display')).toHaveText('Very slow');
  await expect(page.locator('#cinematic-loop')).toBeChecked();

  expect(await dispatch(page, 'camera-path.clear', {})).toEqual({ outcome: { keyframes: 3 } });
  expect((await readPath(page)).labels).toEqual([]);
  expect(productErrors).toEqual([]);
});

test('undoing each camera path action gives back the whole state, on the page\'s own history', async ({ page }) => {
  await openCameraPath(page);
  await waitForHistory(page);
  const camera = await page.evaluate(() => window._cellucidViewer.getCameraState());
  const pose = theta => ({ ...camera, orbit: { ...camera.orbit, theta } });
  // A path to act on: three keyframes.
  await takeSteps(page, ['A', 'B', 'C'].map((label, index) => ['camera-path.keyframe.add', { camera: pose(0.2 * index), label }]));
  const report = await applyUndoRedo(page, [
    ['camera-path.keyframe.add', { camera: pose(1.1), label: 'D' }],
    ['camera-path.keyframe.remove', { keyframe: 'B' }],
    ['camera-path.keyframe.move', { keyframe: 'C', direction: 'up' }],
    ['camera-path.keyframe.rename', { keyframe: 'A', label: 'Start' }],
    ['camera-path.duration.set', { keyframe: 'Start', seconds: 2 }],
    ['camera-path.duration.set', { seconds: 1.25 }],
    ['camera-path.loop-back.set', { enabled: true }],
    ['camera-path.playback.set', { position_interpolation: 'linear', speed: 90, loop: true }],
    ['camera-path.clear', {}],
  ]);
  for (const outcome of report) {
    expect(outcome.refused, `${outcome.type} applies`).toBeNull();
    expect(outcome.step, `${outcome.type} is a step`).toBe(true);
    expect(outcome.untouched, `${outcome.type} changed only the domains it touches`).toEqual([]);
    expect(outcome.differs, `${outcome.type} undone gives back every domain`).toEqual([]);
    expect(outcome.redone, `${outcome.type} redone gives it again`).toEqual([]);
  }
});
