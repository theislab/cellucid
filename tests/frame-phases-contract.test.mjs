/**
 * Coalesced input runs at the top of the viewer's frame, before it draws, and
 * readouts after (rendering/frame-phases.js). A control's own animation frame
 * would run after the viewer's and show every slider step a frame late.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  drainAfterFramePhase,
  drainBeforeFramePhase,
  runAfterNextFrame,
  runBeforeNextFrame,
  setFramePhaseDriver,
} from '../assets/js/rendering/frame-phases.js';

function withFrames(t) {
  const frames = new Map();
  let next = 1;
  const saved = [globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame];
  globalThis.requestAnimationFrame = callback => {
    frames.set(next, callback);
    return next++;
  };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  t.after(() => {
    [globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame] = saved;
    setFramePhaseDriver(null);
  });
  return {
    frames,
    runFrames() {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback();
    },
  };
}

test('a driven frame runs queued input before the draw and readouts after it', t => {
  const { frames } = withFrames(t);
  let running = true;
  setFramePhaseDriver({ isRunning: () => running });
  const order = [];
  runAfterNextFrame(() => order.push('readout'));
  runBeforeNextFrame(() => order.push('input'));
  assert.equal(frames.size, 0, 'nothing of its own while the viewer drives frames');
  // The viewer's frame: before, draw, after.
  drainBeforeFramePhase();
  order.push('draw');
  drainAfterFramePhase();
  assert.deepEqual(order, ['input', 'draw', 'readout']);
  // Work queued during a phase waits for the next frame.
  runBeforeNextFrame(() => {
    order.push('again');
    runBeforeNextFrame(() => order.push('next frame'));
  });
  drainBeforeFramePhase();
  assert.deepEqual(order.slice(-1), ['again']);
  drainBeforeFramePhase();
  assert.deepEqual(order.slice(-1), ['next frame']);
  running = false;
});

test('cancelled work never runs, and a failure costs no one else their turn', t => {
  withFrames(t);
  setFramePhaseDriver({ isRunning: () => true });
  const ran = [];
  const reported = [];
  const savedReport = globalThis.reportError;
  globalThis.reportError = error => reported.push(error.message);
  t.after(() => { globalThis.reportError = savedReport; });
  const cancel = runBeforeNextFrame(() => ran.push('cancelled'));
  runBeforeNextFrame(() => { throw new Error('boom'); });
  runBeforeNextFrame(() => ran.push('kept'));
  cancel();
  drainBeforeFramePhase();
  assert.deepEqual(ran, ['kept']);
  assert.deepEqual(reported, ['boom']);
});

test('without a running viewer each callback runs from a frame of its own, and a stopping viewer hands its queue over', t => {
  const { frames, runFrames } = withFrames(t);
  const ran = [];
  setFramePhaseDriver(null);
  const cancel = runBeforeNextFrame(() => ran.push('cancelled'));
  runBeforeNextFrame(() => ran.push('undriven'));
  cancel();
  assert.equal(frames.size, 1);
  runFrames();
  assert.deepEqual(ran, ['undriven']);

  let running = true;
  const driver = { isRunning: () => running };
  setFramePhaseDriver(driver);
  runBeforeNextFrame(() => ran.push('queued'));
  runAfterNextFrame(() => ran.push('queued after'));
  running = false;
  setFramePhaseDriver(driver);
  runFrames();
  assert.deepEqual(ran, ['undriven', 'queued', 'queued after']);
});

test('the viewer drains the phases around every frame, drawn or not', () => {
  const viewer = readFileSync(new URL('../assets/js/rendering/viewer.js', import.meta.url), 'utf8');
  const render = viewer.slice(viewer.indexOf('  function render(timestamp) {'), viewer.indexOf('  function renderSceneFrame() {'));
  assert.match(render, /if \(isWebGLContextLostForAsyncCommit\(\)\) return;\n\s*ambientFramePacer\.frameStarted\(timestamp, timedFromLastFrame\);\n(\s*\/\/.*\n)*\s*drainBeforeFramePhase\(\);[\s\S]*nextFrameCause\(frameSize\)/);
  assert.match(render, /settleWindowElapsed\(\)\) \{[\s\S]*?drainAfterFramePhase\(\);\n\s*return;/);
  // Between them only the full-detail frame measurement (full-detail-frame-cost.js).
  // and the fence the ambient pacer reads (ambient-frame-pacing.js).
  assert.match(render, /sceneMsaaTarget\.endFrameUnchanged\(\);\n\s*\}\n(\s*\/\/.*\n)*\s*if \(!sceneDrawn\) fullDetailFrameCost\.frameEnded\(false\);\n\s*\}\n(\s*\/\/.*\n)*\s*if \(sceneDrawn\) fenceDrawnFrame\(\);\n\s*if \(sceneDrawn && fullDetailFrameCost\.isArmed\(\)\) \{\n[^}]*\}\n(\s*\/\/.*\n)*\s*drainAfterFramePhase\(\);/);
  // The measured frame opens before its first command (the GPU timer's query).
  assert.match(render, /if \(fullDetailFrameCost\.isArmed\(\)\) fullDetailFrameCost\.frameStarted\(frameStartedAt\);\n\s*let sceneDrawn = false;\n\s*try \{\n\s*renderSceneFrame\(\);/);
  for (const site of ['start()', 'pause()', 'resume()']) {
    const body = viewer.slice(viewer.indexOf(`    ${site} {`), viewer.indexOf('\n    },', viewer.indexOf(`    ${site} {`)));
    assert.match(body, /reconcileFramePhases\(\);/, site);
  }
  const controls = readFileSync(new URL('../assets/js/app/ui/components/controls.js', import.meta.url), 'utf8');
  assert.match(controls, /runBeforeNextFrame\(run\)/);
  const playback = readFileSync(new URL('../assets/js/app/ui/modules/cinematic-camera/playback-controller.js', import.meta.url), 'utf8');
  assert.doesNotMatch(playback, /requestAnimationFrame\(tick\)/);
});

test('a gesture in another pane moves the camera focus at once and the sidebar when it ends', () => {
  const viewer = readFileSync(new URL('../assets/js/rendering/viewer.js', import.meta.url), 'utf8');
  const focus = viewer.slice(viewer.indexOf('  function focusViewAtScreenPosition('), viewer.indexOf('  /** Start one camera drag at a screen point. */'));
  assert.match(focus, /transferViewFocus\(clickedViewId, \{ saveOutgoing: true \}\);[\s\S]*deferSidebarFocus\(commit\);/);
  assert.doesNotMatch(focus.slice(0, focus.indexOf('let sidebarFocusPending')), /viewFocusHandler\(/);
  // Ends: the release of a press or of the last finger, or a resting wheel.
  assert.match(viewer, /const handleMouseUp = \(e\) => \{\n[^\n]*\n\s*if \(sidebarFocusPending && !commitAtWheelRest\.pending\) commitSidebarFocus\(\);/);
  assert.match(viewer, /touchGesture = 'idle';\n\s*if \(sidebarFocusPending && !commitAtWheelRest\.pending\) commitSidebarFocus\(\);/);
  assert.match(viewer, /focusViewAtScreenPosition\(e\.clientX, e\.clientY, 'wheel'\)/);
  // A wheel that moves nothing draws nothing.
  assert.match(viewer, /if \(targetRadius === oldRadius\) return;\n\s*invalidateCameraFrame\(\);/);
});

test('a camera press captures the mouse; a selection press does not', () => {
  const viewer = readFileSync(new URL('../assets/js/rendering/viewer.js', import.meta.url), 'utf8');
  const press = viewer.slice(viewer.indexOf("addEventListenerWithCleanup(canvas, 'mousedown'"));
  assert.match(press, /^addEventListenerWithCleanup\(canvas, 'mousedown', \(e\) => \{\n\s*if \(highlightTools && highlightTools\.handlePointerDown\(e\)\) \{\n\s*return;\n\s*\}\n\s*captureCameraPointer\(\);/);
  assert.match(viewer, /canvas\.setPointerCapture\(lastMousePointerId\)/);
});

test('a frame that changed no pixel skips the resolve', () => {
  const viewer = readFileSync(new URL('../assets/js/rendering/viewer.js', import.meta.url), 'utf8');
  assert.match(viewer, /if \(sceneTargetChangedThisFrame\) \{\n\s*sceneMsaaTarget\.resolveFrame\(frameSize\.width, frameSize\.height\);\n\s*\} else \{\n\s*sceneMsaaTarget\.endFrameUnchanged\(\);/);
  assert.match(viewer, /sceneTargetChangedThisFrame = false;\n\s*return;/);
  assert.match(viewer, /if \(panesDrawn === 0\) sceneTargetChangedThisFrame = false;/);
});

test('a frame an ambient animation alone asks for waits for the ambient pacer', () => {
  const viewer = readFileSync(new URL('../assets/js/rendering/viewer.js', import.meta.url), 'utf8');
  const render = viewer.slice(viewer.indexOf('  function render(timestamp) {'), viewer.indexOf('  /** The frame-phase driver'));
  // Every frame of the loop is timed from the one before, if that one armed it.
  assert.match(render, /^  function render\(timestamp\) \{\n(\s*\/\/.*\n)*\s*const timedFromLastFrame = animationHandle !== null && animationHandle === frameArmedByLastFrame;\n\s*frameArmedByLastFrame = null;\n\s*animationHandle = null;/);
  assert.match(render, /if \(isWebGLContextLostForAsyncCommit\(\)\) return;\n\s*ambientFramePacer\.frameStarted\(timestamp, timedFromLastFrame\);/);
  // Not yet due: no draw. Held by the GPU rule alone, the next animation
  // frame runs undrawn and is timed; otherwise no animation frame, and the
  // pacer's timer re-arms.
  assert.match(render, /const ambientFrame = AMBIENT_FRAME_CAUSES\.has\(frameCause\);\n\s*if \(ambientFrame && !ambientFramePacer\.isDue\(now\)\) \{\n\s*if \(ambientFramePacer\.watchesNextFrame\(now\)\) \{\n(\s*\/\/.*\n)*\s*ensureFrameScheduled\(\);\n\s*frameArmedByLastFrame = animationHandle;\n\s*\} else \{\n(\s*\/\/.*\n)*\s*ambientFramePacer\.wakeWhenDue\(ensureFrameScheduled\);\n\s*\}\n\s*drainAfterFramePhase\(\);\n\s*return;/);
  // Every drawn frame is measured, and says whether it was an ambient one.
  assert.match(render, /ambientFramePacer\.frameDrawn\(frameStartedAt, ambientFrame\);\n(\s*\/\/.*\n)*\s*if \(fullDetailFrameCost\.isArmed\(\)\) fullDetailFrameCost\.frameStarted\(frameStartedAt\);\n\s*let sceneDrawn = false;\n\s*try \{\n\s*renderSceneFrame\(\);/);
  // The animations that never end are the last causes named, so one of them
  // means nothing else asks; an overlay's frames that converge come first.
  const causes = viewer.slice(viewer.indexOf('  function sceneAnimationCause() {'), viewer.indexOf('  function nextFrameCause('));
  assert.match(causes, /if \(overlayManager\?\.needsOwedFrames\(\) === true\) return 'overlay';\n\s*if \(projectileSystem\.isAnimating\(\)\) return 'projectile';\n\s*if \(presentedCameraSettlement\.isPending\(\)\) return 'camera-settlement';\n\s*if \(lodConvergingInLastFrame\) return 'lod';\n(\s*\/\/.*\n)*\s*const backdropMotionCause = backdropLooks\.motionCause\(\);\n\s*if \(backdropMotionCause !== null\) return backdropMotionCause;\n\s*if \(renderMode === 'smoke' && smokeRenderer\.needsContinuousFrames\(\)\) return 'smoke';\n\s*if \(overlayManager\?\.needsContinuousFrames\(\) === true\) return 'overlay-flow';\n\s*if \(highlightTools !== null && highlightTools\.isHighlightAnimating\(\)\) return 'highlight';\n\s*return null;\n\s*\}/);
  assert.match(viewer, /^const AMBIENT_FRAME_CAUSES = Object\.freeze\(new Set\(\[\n  'backdrop-motion',\n  'smoke',\n  'overlay-flow',\n  'highlight',\n\]\)\);$/m);
  // The pacer reads the GPU through the fence after the last drawn frame.
  assert.match(viewer, /createAmbientFramePacer\(\{ gpuBusy: drawnFrameOnGpu \}\)/);
});

test('a level-of-detail step neither restarts the camera burst nor rebuilds the export preview mid-motion', () => {
  const viewer = readFileSync(new URL('../assets/js/rendering/viewer.js', import.meta.url), 'utf8');
  assert.match(viewer, /publishPresentedViewStateChange\('lod', exactViewId, false\);/);
  const ui = readFileSync(new URL('../assets/js/app/ui/modules/figure-export/figure-export-ui.js', import.meta.url), 'utf8');
  assert.match(ui, /onLodChanged\(\(\) => \{\n\s*if \(previewDisposed\) return;\n(\s*\/\/.*\n)*\s*if \(viewer\.isCameraInMotion\(\)\) invalidatePreviewSamples\(\{ rebuild: false \}\);/);
  assert.match(ui, /event\?\.reason === 'lod' && viewer\.isCameraInMotion\(\)/);
});
