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
      holds: saved.keyframes.map(kf => kf.hold ?? 0),
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
        captions: saved.captions,
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
    'A keyframe is labeled "KF 2" already; choose another label.'
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

  // A hold, typed in the row under its keyframe: one step; the playback bar
  // shows the span the camera rests there after the keyframe's mark.
  const firstHold = page.locator('.cinematic-hold-input[data-hold-index="0"]');
  await firstHold.fill('2');
  await firstHold.press('Tab');
  expect(await takeDispatched(page)).toEqual([
    { type: 'camera-path.hold.set', params: { keyframe: 'KF 3', seconds: 2 } },
  ]);
  expect((await readPath(page)).holds).toEqual([2, 0, 0]);
  await expect(firstHold).toHaveValue('2');
  await expect(page.locator('.cinematic-timeline-hold')).toHaveCount(1);
  // 2 s of a 2 + 1.5 + 1.5 s path, from its start.
  expect(await page.locator('.cinematic-timeline-hold').evaluate(el => [el.style.left, Number.parseFloat(el.style.width).toFixed(1)]))
    .toEqual(['0%', '40.0']);
  await firstHold.fill('');
  await firstHold.press('Tab');
  expect(await takeDispatched(page)).toEqual([
    { type: 'camera-path.hold.set', params: { keyframe: 'KF 3', seconds: 0 } },
  ]);
  await expect(page.locator('.cinematic-timeline-hold')).toHaveCount(0);

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
  await page.locator('#cinematic-captions').uncheck();
  expect(await takeDispatched(page)).toEqual([
    { type: 'camera-path.playback.set', params: { position_interpolation: 'bezier' }, observed: true },
    { type: 'camera-path.playback.set', params: { rotation_interpolation: 'linear' }, observed: true },
    { type: 'camera-path.playback.set', params: { easing: 'ease-in' }, observed: true },
    { type: 'camera-path.playback.set', params: { loop: true }, observed: true },
    { type: 'camera-path.playback.set', params: { captions: false }, observed: true },
  ]);
  expect(await outsideSteps(page)).toBe(outsideBefore);
  expect((await readPath(page)).playback).toEqual({
    position: 'bezier', rotation: 'linear', easing: 'ease-in', speed: '70', loop: true, autoplay: false, captions: false,
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
    ['camera-path.hold.set', { keyframe: 'Start', seconds: 2 }],
    ['camera-path.keyframe.add', { camera: pose(1.4), label: 'E', hold: 1 }],
    ['camera-path.hold.set', { seconds: 0.5 }],
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

/**
 * The share of a group's shown cells inside the view's frame, the half-range
 * (2.5th to 97.5th percentile) it spans across and up in fractions of the
 * half frame, and where that range's middle is: measured through the
 * viewer's own projection of the view (`getViewRenderState`).
 */
async function measureFraming(page, fieldKey, labels) {
  return page.evaluate(({ fieldKey, labels }) => {
    const viewer = window._cellucidViewer;
    const pane = viewer.getPresentedLayout().panes.find(each => each.viewId === 'live');
    const m = viewer.getViewRenderState('live', {
      viewportWidth: Math.round(pane.visibleCssWidth), viewportHeight: Math.round(pane.visibleCssHeight),
    }).mvpMatrix;
    const field = window._cellucidState.obsData.fields.find(each => each.key === fieldKey);
    const wanted = new Set(labels.map(label => field.categories.map(String).indexOf(label)));
    const xs = [];
    const ys = [];
    viewer.withBorrowedViewData('live', data => {
      for (let i = 0; i < data.pointCount; i++) {
        if (data.transparency && !(data.transparency[i] > 0)) continue;
        if (!wanted.has(field.codes[i])) continue;
        const stride = data.positions.length / data.pointCount;
        const [x, y, z] = [0, 1, 2].map(axis => (axis < stride ? data.positions[i * stride + axis] : 0));
        const w = m[3] * x + m[7] * y + m[11] * z + m[15];
        xs.push((m[0] * x + m[4] * y + m[8] * z + m[12]) / w);
        ys.push((m[1] * x + m[5] * y + m[9] * z + m[13]) / w);
      }
    });
    const quantile = (values, p) => [...values].sort((a, b) => a - b)[Math.floor(p * (values.length - 1))];
    const range = values => [quantile(values, 0.025), quantile(values, 0.975)];
    const [x0, x1] = range(xs);
    const [y0, y1] = range(ys);
    return {
      inside: xs.filter((x, i) => Math.abs(x) <= 1 && Math.abs(ys[i]) <= 1).length / xs.length,
      fill: Math.max((x1 - x0) / 2, (y1 - y0) / 2),
      center: [(x0 + x1) / 2, (y0 + y1) / 2],
    };
  }, { fieldKey, labels });
}

test('camera.framing gives cameras that frame each category, and camera-path.play plays a path built from them to its end', async ({ page }) => {
  const productErrors = observeProductErrors(page);
  await openCameraPath(page);
  const field = await page.evaluate(() => window._cellucidState.obsData.fields
    .find(each => each.kind === 'category' && each.categories.length >= 2 && each._isDeleted !== true).key);
  const read = await dispatch(page, 'camera.framing', { field: { source: 'obs', key: field }, fill: 0.8 });
  expect(read.message, 'camera.framing answers').toBeUndefined();
  const { outcome } = read;
  expect(outcome.groups.length).toBeGreaterThanOrEqual(2);
  expect(outcome.frame.fill).toBe(0.8);

  // Each category's camera, applied, frames it: nearly all of it inside, centered, filling much of the frame.
  for (const group of outcome.groups.slice(0, 4)) {
    expect(await dispatch(page, 'camera.set', { view: 'View 1', camera: group.camera })).toEqual({ outcome: { view: 'View 1' } });
    const measured = await measureFraming(page, field, [group.label]);
    expect(measured.inside, `${group.label}: share of its cells in the frame`).toBeGreaterThanOrEqual(0.9);
    expect(measured.fill, `${group.label}: how much of the frame it fills`).toBeGreaterThan(0.35);
    expect(measured.fill, `${group.label}: how much of the frame it fills`).toBeLessThanOrEqual(1);
    expect(Math.hypot(...measured.center), `${group.label}: off center`).toBeLessThan(0.35);
  }

  // A path from the framing read: whole, two categories, a hold on the first; played to its end in one step.
  const [first, second] = outcome.groups;
  const add = (label, camera, hold) => dispatch(page, 'camera-path.keyframe.add', { label, camera, ...(hold === undefined ? {} : { hold }) });
  await add('Establishing', outcome.whole.camera);
  await add(first.label, first.camera, 0.3);
  await add(second.label, second.camera);
  expect(await dispatch(page, 'camera-path.duration.set', { seconds: 0.3 })).toEqual({ outcome: { keyframes: 3 } });
  const path = (await dispatch(page, 'camera-path.get', {})).outcome;
  expect(path.keyframes.map(kf => [kf.at, kf.hold])).toEqual([[0, 0], [0.3, 0.3], [0.9, 0]]);
  expect(path.seconds).toBe(0.9);
  const played = await dispatch(page, 'camera-path.play', {});
  expect(played.outcome).toEqual({ seconds: 0.9, keyframes: 3, ended: 'end' });
  const end = await page.evaluate(() => window._cellucidViewer.getCameraState().orbit);
  expect(end.radius).toBeCloseTo(second.camera.orbit.radius, 4);
  expect(end.target[0]).toBeCloseTo(second.camera.orbit.target[0], 4);
  expect(await dispatch(page, 'camera-path.stop', {})).toEqual({ outcome: { stopped: false } });

  // A stop sent while the play still waits for the path's end runs at once
  // (a stepless control, never queued behind the play on the camera):
  // the play answers ended "stopped" well before the path's length.
  expect(await dispatch(page, 'camera-path.duration.set', { seconds: 20 })).toEqual({ outcome: { keyframes: 3 } });
  const timing = await page.evaluate(async () => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    const actions = getActions();
    const started = performance.now();
    const play = actions.dispatch('camera-path.play', {}, { origin: 'user' });
    // The path is playing (a read, which never waits behind the play).
    while ((await actions.dispatch('camera-path.get', {}, { origin: 'user' })).outcome.playing !== 'playing') {
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    const stop = await actions.dispatch('camera-path.stop', {}, { origin: 'user' });
    const stopAt = performance.now() - started;
    const ended = await play;
    return { stop: stop.outcome, stopStep: stop.step, stopAt, ended: ended.outcome.ended, playStep: ended.step !== null };
  });
  expect(timing.stop).toEqual({ stopped: true });
  expect(timing.stopStep).toBeNull();
  expect(timing.ended).toBe('stopped');
  expect(timing.playStep, 'the play is the one step, ended where the path stopped').toBe(true);
  expect(timing.stopAt, 'the stop did not wait for the 40-second path').toBeLessThan(10000);
  expect(productErrors).toEqual([]);
});

// One opening and one looping path: it is played and stopped by the person, then by an agent.
// Each counts the steps from its own play on.
test('a looping path played and stopped by the person, then by an agent', async ({ page }) => {
  // A looping play is a step of who started it, never "it was so already"; a history move or a
  // turn during the loop must not record the moving camera as the person's own camera move.
  const productErrors = observeProductErrors(page);
  await openCameraPath(page);
  const field = await page.evaluate(() => window._cellucidState.obsData.fields
    .find(each => each.kind === 'category' && each.categories.length >= 2 && each._isDeleted !== true).key);
  const { outcome } = await dispatch(page, 'camera.framing', { field: { source: 'obs', key: field }, fill: 0.8 });
  const [first, second] = outcome.groups;
  await dispatch(page, 'camera-path.keyframe.add', { label: 'Wide', camera: outcome.whole.camera });
  await dispatch(page, 'camera-path.keyframe.add', { label: first.label, camera: first.camera, hold: 0.5 });
  await dispatch(page, 'camera-path.keyframe.add', { label: second.label, camera: second.camera });
  await dispatch(page, 'camera-path.duration.set', { seconds: 1.5 });
  await dispatch(page, 'camera-path.playback.set', { loop: true });
  for (const actor of [{ origin: 'user' }, { origin: 'agent', agent: 'Claude', turn: 'turn-loop' }]) {
    await test.step(`a looping path is one step at its start; while it plays, history moves record no camera move of the person; it is recorded once where it stops, by who stopped it (${actor.origin})`, async () => {
      // The camera elsewhere first, so the loop's start is a change.
      await dispatch(page, 'camera.set', { view: 'View 1', camera: second.camera });

      // Who stops their own loop owns the camera's rest: an agent's is a step of its turn.
      const run = await page.evaluate(async actor => {
        const { getActions } = await import('/assets/js/app/actions/index.js');
        const actions = getActions();
        const history = window._cellucidHistories.current();
        const steps = () => [...history.active.steps.values()];
        const before = steps().length;
        const played = await actions.dispatch('camera-path.play', {}, actor);
        // The camera the loop's step holds: the first keyframe's. (The live
        // camera, read once the play has answered, may already be a frame or
        // more along the path on a slow machine.)
        await history.idle();
        const playStep = steps().slice(before).find(step => step.label === 'Played the camera path on a loop');
        const atStart = playStep === undefined ? null : history.pool.get(playStep.after.camera).views[0].orbit;
        const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
        // While the loop plays: the history's settle (run before every move of
        // the history) on frame after frame for over one pass of the loop, across
        // its hold and its transitions (the playback's own clock).
        const playback = window._cellucidUi.cinematicCamera.getPlaybackController();
        let previous = 0;
        let wrapped = false;
        const onTime = ({ globalT }) => {
          if (globalT < previous - 0.5) wrapped = true;
          previous = globalT;
        };
        playback.on('timeUpdate', onTime);
        // Past the wrap and on its way again: stopped in the frame of the wrap,
        // the camera is exactly at the first keyframe, where the loop's step
        // already holds it, so its rest is rightly no step and the wait below
        // for one would never end.
        while (!(wrapped && previous >= 0.1)) {
          await actions.settle();
          await frame();
        }
        playback.off('timeUpdate', onTime);
        await history.idle();
        const whilePlaying = steps().slice(before).map(step => step.label);
        const stopped = await actions.dispatch('camera-path.stop', {}, actor);
        // Its rest is recorded by observation, from the stop's own state change
        // (synchronously): once the history is idle it holds it, or the
        // assertion below says which step is missing.
        await history.idle();
        const after = steps().slice(before);
        const head = history.active.steps.get(history.active.headId);
        return {
          ended: played.outcome.ended, playStep: played.step?.label ?? null, atStart,
          whilePlaying, stopped: stopped.outcome,
          after: after.map(step => `${step.by.origin}: ${step.label}`),
          turns: after.map(step => step.by.turn),
          headCamera: head.type === 'camera.set' ? head.params.camera.orbit : null,
          camera: window._cellucidViewer.getCameraState().orbit,
        };
      }, actor);
      expect(run.ended).toBe('looping');
      expect(run.playStep, 'the loop is a step: it put the camera at the first keyframe').toBe('Played the camera path on a loop');
      expect(run.atStart.radius, 'the loop\'s step holds the first keyframe\'s camera').toBeCloseTo(outcome.whole.camera.orbit.radius, 4);
      expect(run.whilePlaying, 'nothing but the play while the loop plays').toEqual(['Played the camera path on a loop']);
      expect(run.stopped).toEqual({ stopped: true });
      expect(run.after, 'the stop is recorded once, where the camera rests, by who stopped it').toEqual([
        `${actor.origin}: Played the camera path on a loop`,
        `${actor.origin}: Moved the camera of View 1`,
      ]);
      expect(run.turns).toEqual([actor.turn ?? null, actor.turn ?? null]);
      expect(run.headCamera.radius).toBeCloseTo(run.camera.radius, 6);
      expect(run.headCamera.target).toEqual(run.camera.target);
      expect(productErrors).toEqual([]);
    });
  }
});
