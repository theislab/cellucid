/**
 * @fileoverview The guided tour: the steps shown played back from the
 * opening, one at a time, each with its caption, for a talk or a class. A
 * camera step is flown to through the camera path's interpolation (the two
 * cameras are its keyframes); every other step is applied at once and held
 * for its caption (the step's first note is its second line, and a group's
 * name titles its first step as a chapter). Pause holds the step on screen;
 * Previous and Next step by hand; Stop (or Escape) returns to the step that
 * was shown before. Each step is shown by the history's own move
 * (`history.jump`). An agent, a notebook and a replay start and stop it as
 * the panel's Tour button and Stop do (`history.tour.start`,
 * `history.tour.stop`, provided by `index.js`).
 * Under reduced motion nothing flies: each step is shown at once and held.
 *
 * The bar sits over the top of the viewer, like the camera path's transport
 * bar, and is a labelled region whose caption is announced.
 *
 * @module ui/modules/state/tour
 */

import { tourPlan } from './model.js';
import { STATE_ICONS, reportHistoryFailure } from './shared.js';
import { pathTo } from './history-source.js';
import { prefersReducedMotion } from '../cinematic-camera/playback-controller.js';
import { createCameraPathPlan, interpolatePlannedCameraState } from '../cinematic-camera/interpolation-engine.js';
import { runBeforeNextFrame } from '../../../../rendering/frame-phases.js';
import { onAbort } from '../../../../utils/abort.js';
import { StyleManager } from '../../../../utils/style-manager.js';

const FLY_OPTIONS = Object.freeze({
  autoPaceSpeed: 1, easing: 'ease-in-out', loop: false, positionMethod: 'linear', rotationMethod: 'slerp',
});

/** Two camera states as the keyframes of one flight (`keyframe-store.js` schema). */
function flightPlan(from, to, seconds) {
  const keyframe = (state, id, transitionDuration) => ({
    id, label: id, navigationMode: state.navigationMode, orbit: state.orbit, freefly: state.freefly,
    representation: null, transitionDuration,
  });
  return createCameraPathPlan([keyframe(from, 'from', seconds), keyframe(to, 'to', null)], FLY_OPTIONS);
}

/**
 * @param {object} options
 * @param {Document} options.ownerDocument
 * @param {() => import('./history-source.js').TrackerView|null} options.view - the tracker shown
 * @param {(stepId: string) => Promise<unknown>} options.jump - `history.jump`
 * @param {{getCameraState: () => object, setCameraState: (state: object) => void}|null} options.camera
 * @param {(playing: boolean) => void} [options.onChange]
 * @param {(stepId: string) => object|null} [options.recordedCamera] - the focused view's camera as a
 *   step kept it, while camera moves are not recorded (a jump then leaves the camera; the tour, asked
 *   for, still shows each step's view, History v2 §3.15.5); null while they are recorded
 */
export function createTour({ ownerDocument, view, jump, camera, onChange = () => {}, recordedCamera = () => null }) {
  let session = null;
  /** The play running now (what `stop` waits for), or null. */
  let running = null;

  function sameCamera(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  /** Fly the camera from `from` to `to` in `ms`, frame by frame; resolves at `to`. */
  function fly(from, to, ms, signal) {
    if (camera === null || ms <= 0 || sameCamera(from, to)) return Promise.resolve();
    const plan = flightPlan(from, to, ms / 1000);
    return new Promise(resolve => {
      const start = performance.now();
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        removeAbort();
        camera.setCameraState(interpolatePlannedCameraState(plan, 1));
        resolve();
      };
      const removeAbort = onAbort(signal, finish);
      const tick = () => {
        if (done) return;
        const t = Math.min(1, (performance.now() - start) / ms);
        if (t >= 1 || prefersReducedMotion()) { finish(); return; }
        camera.setCameraState(interpolatePlannedCameraState(plan, t));
        runBeforeNextFrame(tick);
      };
      camera.setCameraState(interpolatePlannedCameraState(plan, 0));
      runBeforeNextFrame(tick);
    });
  }

  function buildBar() {
    const bar = ownerDocument.createElement('div');
    bar.className = 'history-tour-bar';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Guided tour');
    const inner = ownerDocument.createElement('div');
    inner.className = 'history-tour-inner';
    const button = (action, label, icon) => {
      const b = ownerDocument.createElement('button');
      b.type = 'button';
      b.className = 'history-tour-btn';
      b.dataset.tourAction = action;
      b.setAttribute('aria-label', label);
      b.title = label;
      b.innerHTML = icon;
      return b;
    };
    const stop = button('stop', 'Stop the tour and return', STATE_ICONS.stop);
    const previous = button('previous', 'Previous step', STATE_ICONS.previous);
    const pause = button('pause', 'Pause', STATE_ICONS.pause);
    const next = button('next', 'Next step', STATE_ICONS.next);
    const count = ownerDocument.createElement('span');
    count.className = 'history-tour-count';
    const caption = ownerDocument.createElement('p');
    caption.className = 'history-tour-caption';
    caption.setAttribute('aria-live', 'polite');
    const chapter = ownerDocument.createElement('span');
    chapter.className = 'history-tour-chapter';
    const words = ownerDocument.createElement('span');
    words.className = 'history-tour-words';
    const note = ownerDocument.createElement('span');
    note.className = 'history-tour-note';
    caption.append(chapter, words, note);
    const by = ownerDocument.createElement('span');
    by.className = 'history-badge';
    by.hidden = true;
    const progress = ownerDocument.createElement('span');
    progress.className = 'history-tour-progress';
    progress.setAttribute('aria-hidden', 'true');
    inner.append(stop, previous, pause, next, count, caption, by, progress);
    bar.append(inner);
    return { bar, pause, previous, next, count, caption, chapter, words, note, by, progress };
  }

  function wait(ms, signal, isPaused, step) {
    return new Promise(resolve => {
      let left = ms;
      let last = performance.now();
      let timer = null;
      const finish = () => {
        clearInterval(timer);
        removeAbort();
        resolve();
      };
      const removeAbort = onAbort(signal, finish);
      timer = setInterval(() => {
        const now = performance.now();
        if (!isPaused()) left -= now - last;
        last = now;
        step(Math.max(0, 1 - left / Math.max(1, ms)));
        if (left <= 0 || session?.skip) finish();
      }, 50);
    });
  }

  /**
   * Play the tour of the tracker shown; resolves when it ends. `onStart`
   * hears it begin (what it shows), before its first step is shown: the
   * history action `history.tour.start` answers then.
   *
   * @param {{onStart?: (started: {tracker: {id: string, name: string}, branch: {id: string, name: string},
   *   steps: number, returnsTo: string}) => void}} [options]
   */
  function play(options = {}) {
    if (session !== null) return running;
    const run = playTour(options);
    running = run;
    void run.finally(() => { if (running === run) running = null; });
    return run;
  }

  async function playTour({ onStart = () => {} } = {}) {
    const tracker = view();
    if (tracker === null || session !== null) return;
    const steps = pathTo(tracker, tracker.headId);
    const plan = tourPlan(steps, { reducedMotion: prefersReducedMotion(), groupName: id => tracker.group(id)?.name ?? null });
    const ui = buildBar();
    const controller = new AbortController();
    session = {
      tracker: tracker.id, returnTo: tracker.headId, plan, index: 0, paused: false, skip: false,
      controller, ui, target: null,
      // Where the camera was: put back at the end when the tour moved it outside the history.
      cameraAtStart: camera === null ? null : camera.getCameraState(),
    };
    ownerDocument.body.append(ui.bar);
    ownerDocument.body.classList.add('history-touring');
    onChange(true);
    ui.bar.addEventListener('click', event => {
      const action = event.target instanceof Element ? event.target.closest('[data-tour-action]')?.dataset.tourAction : null;
      if (action === 'stop') stop();
      else if (action === 'pause') togglePause();
      else if (action === 'next') seek(+1);
      else if (action === 'previous') seek(-1);
    }, { signal: controller.signal });
    ownerDocument.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); stop(); }
    }, { signal: controller.signal });
    ui.pause.focus({ preventScroll: true });
    const branch = tracker.branch(tracker.activeBranch);
    onStart({
      tracker: { id: tracker.id, name: tracker.name },
      branch: { id: tracker.activeBranch, name: branch?.name ?? tracker.activeBranch },
      steps: plan.length - 1,
      returnsTo: tracker.headId,
    });

    try {
      while (session !== null && !controller.signal.aborted && session.index < plan.length) {
        const item = plan[session.index];
        session.skip = false;
        session.target = null;
        ui.count.textContent = `${item.number} / ${plan.length - 1}`;
        ui.chapter.textContent = item.chapter ?? '';
        ui.chapter.hidden = item.chapter === null;
        ui.words.textContent = item.number === 0 ? `${item.caption}: the start of the tour` : item.caption;
        ui.note.textContent = item.note ?? '';
        ui.note.hidden = item.note === null;
        ui.by.hidden = item.by === null;
        ui.by.textContent = item.by ?? '';
        ui.previous.disabled = session.index === 0;
        ui.next.disabled = session.index === plan.length - 1;
        const from = item.fly && camera !== null ? camera.getCameraState() : null;
        await jump(item.stepId);
        if (controller.signal.aborted) break;
        if (from !== null) {
          // Camera moves not recorded: the jump left the camera; the step's own is flown to.
          const kept = recordedCamera(item.stepId);
          const to = kept ?? camera.getCameraState();
          await fly(from, to, item.flyMs, controller.signal);
          if (kept !== null && !controller.signal.aborted) camera.setCameraState(kept);
        }
        if (controller.signal.aborted) break;
        await wait(item.holdMs, controller.signal, () => session?.paused === true, t => {
          StyleManager.setVariable(ui.progress, '--history-tour-progress', t);
        });
        if (session === null || controller.signal.aborted) break;
        session.index = session.target ?? session.index + 1;
      }
      if (session !== null && !controller.signal.aborted) {
        ui.chapter.hidden = true;
        ui.note.hidden = true;
        ui.words.textContent = 'End of the tour';
        ui.count.textContent = `${plan.length - 1} / ${plan.length - 1}`;
        ui.pause.disabled = true;
        ui.next.disabled = true;
        await wait(1500, controller.signal, () => false, () => {});
      }
    } catch (error) {
      reportHistoryFailure('The tour', error);
    } finally {
      await end();
    }
  }

  function togglePause() {
    if (session === null) return;
    session.paused = !session.paused;
    const label = session.paused ? 'Play' : 'Pause';
    session.ui.pause.setAttribute('aria-label', label);
    session.ui.pause.title = label;
    session.ui.pause.innerHTML = session.paused ? STATE_ICONS.play : STATE_ICONS.pause;
  }

  function seek(delta) {
    if (session === null) return;
    const target = Math.max(0, Math.min(session.plan.length - 1, session.index + delta));
    if (target === session.index) return;
    session.target = target;
    session.skip = true;
  }

  /** Stop the tour; resolves once it has ended (back at the step shown before), with whether one was playing. */
  async function stop() {
    if (session === null) return false;
    const run = running;
    session.controller.abort();
    await run;
    return true;
  }

  async function end() {
    if (session === null) return;
    const { tracker, returnTo, ui, controller, cameraAtStart } = session;
    session = null;
    controller.abort();
    ui.bar.remove();
    ownerDocument.body.classList.remove('history-touring');
    try {
      // Back where the person was, unless they acted meanwhile (a new step is theirs to keep).
      const shown = view();
      if (shown !== null && shown.id === tracker && shown.step(returnTo) !== undefined && shown.headId !== returnTo
        && pathTo(shown, returnTo).some(step => step.id === shown.headId)) {
        await jump(returnTo);
      }
      // A camera the history does not move (camera moves not recorded) goes back where it was.
      if (cameraAtStart !== null && recordedCamera(returnTo) !== null && !sameCamera(camera.getCameraState(), cameraAtStart)) {
        camera.setCameraState(cameraAtStart);
      }
    } catch (error) {
      reportHistoryFailure('Returning from the tour', error);
    }
    onChange(false);
  }

  return {
    play,
    stop,
    get playing() { return session !== null; },
    destroy() {
      void stop();
    },
  };
}
