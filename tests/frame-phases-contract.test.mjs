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
  const render = viewer.slice(viewer.indexOf('  function render() {'), viewer.indexOf('  function renderSceneFrame() {'));
  assert.match(render, /if \(isWebGLContextLostForAsyncCommit\(\)\) return;\n(\s*\/\/.*\n)*\s*drainBeforeFramePhase\(\);[\s\S]*nextFrameCause\(frameSize\)/);
  assert.match(render, /settleWindowElapsed\(\)\) \{[\s\S]*?drainAfterFramePhase\(\);\n\s*return;/);
  assert.match(render, /sceneMsaaTarget\.endFrameUnchanged\(\);\n\s*\}\n\s*\}\n(\s*\/\/.*\n)*\s*drainAfterFramePhase\(\);/);
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
  assert.match(viewer, /const handleMouseUp = \(e\) => \{\n[^\n]*\n\s*if \(sidebarFocusPending && sidebarFocusTimer === null\) commitSidebarFocus\(\);/);
  assert.match(viewer, /touchGesture = 'idle';\n\s*if \(sidebarFocusPending && sidebarFocusTimer === null\) commitSidebarFocus\(\);/);
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


test('a grid pane whose scene and camera did not change keeps its pixels', () => {
  const viewer = readFileSync(new URL('../assets/js/rendering/viewer.js', import.meta.url), 'utf8');
  // Generic invalidation bumps the scene generation; a camera change alone
  // does not; time-driven effects other than the camera's bump it per frame.
  assert.match(viewer, /function invalidateFrame\(\) \{\n\s*frameInvalidated = true;\n\s*sceneGeneration \+= 1;/);
  assert.match(viewer, /function invalidateCameraFrame\(\) \{\n\s*frameInvalidated = true;\n(?!\s*sceneGeneration)/);
  assert.match(viewer, /if \(sceneWideAnimationActive\(\)\) sceneGeneration \+= 1;/);
  // A retained pane is skipped; a redrawn one clears its own colour.
  assert.match(viewer, /if \(retainPanes && paneIsUnchanged\(paneDrawRecords\.get\(view\.id\), mvpMatrix, pane, paneNavigationMode\)\) \{\n\s*continue;/);
  assert.match(viewer, /gl\.clear\(retainPanes \? gl\.COLOR_BUFFER_BIT \| gl\.DEPTH_BUFFER_BIT : gl\.DEPTH_BUFFER_BIT\);/);
  // Frames without panes give up retention; a single view keys its own.
  assert.equal((viewer.match(/^\s+retainedLayoutKey = '';/gm) ?? []).length, 4);
  assert.match(viewer, /if \(retainSingle && paneIsUnchanged\(paneDrawRecords\.get\(view\.id\), mvpMatrix, pane, navigationMode\)\) \{\n\s*sceneTargetChangedThisFrame = false;\n\s*return;/);
});


test('a frame that changed no pixel skips the resolve', () => {
  const viewer = readFileSync(new URL('../assets/js/rendering/viewer.js', import.meta.url), 'utf8');
  assert.match(viewer, /if \(sceneTargetChangedThisFrame\) \{\n\s*sceneMsaaTarget\.resolveFrame\(frameSize\.width, frameSize\.height\);\n\s*\} else \{\n\s*sceneMsaaTarget\.endFrameUnchanged\(\);/);
  assert.match(viewer, /sceneTargetChangedThisFrame = false;\n\s*return;/);
  assert.match(viewer, /if \(panesDrawn === 0\) sceneTargetChangedThisFrame = false;/);
});


test('the frame loop stops once the scene has settled and starts again on demand', () => {
  const viewer = readFileSync(new URL('../assets/js/rendering/viewer.js', import.meta.url), 'utf8');
  const render = viewer.slice(viewer.indexOf('  function render() {'), viewer.indexOf('  /** The frame-phase driver'));
  // The callback consumes its arming; only a drawn frame re-arms.
  assert.match(render, /^  function render\(\) \{\n(\s*\/\/.*\n)*\s*animationHandle = null;/);
  assert.doesNotMatch(render, /animationHandle = requestAnimationFrame\(render\)/);
  assert.match(render, /\}\n(\s*\/\/.*\n)*\s*ensureFrameScheduled\(\);\n\s*frameInvalidated = false;\n\s*framesDrawnSinceCause \+= 1;/);
  // The settled branch returns without arming.
  assert.match(render, /settleWindowElapsed\(\)\) \{\n(\s*\/\/.*\n)*\s*lastFrameTime = now;\n\s*drainAfterFramePhase\(\);\n\s*return;/);
  // Everything that can change a frame starts the loop.
  for (const site of [
    /function invalidateFrame\(\) \{\n\s*frameInvalidated = true;\n\s*sceneGeneration \+= 1;\n\s*ensureFrameScheduled\(\);/,
    /function invalidateCameraFrame\(\) \{\n\s*frameInvalidated = true;\n\s*ensureFrameScheduled\(\);/,
    /activeKeys\.add\(code\);\n(\s*\/\/.*\n)*\s*ensureFrameScheduled\(\);/,
    /createCanvasResizeObserver\(canvas, \(\) => ensureFrameScheduled\(\)\)/,
    /requestFrame: \(\) => ensureFrameScheduled\(\)/,
  ]) {
    assert.match(viewer, site);
  }
});


test('a level-of-detail step neither restarts the camera burst nor rebuilds the export preview mid-motion', () => {
  const viewer = readFileSync(new URL('../assets/js/rendering/viewer.js', import.meta.url), 'utf8');
  assert.match(viewer, /publishPresentedViewStateChange\('lod', exactViewId, false\);/);
  const ui = readFileSync(new URL('../assets/js/app/ui/modules/figure-export/figure-export-ui.js', import.meta.url), 'utf8');
  assert.match(ui, /onLodChanged\(\(\) => \{\n\s*if \(previewDisposed\) return;\n(\s*\/\/.*\n)*\s*if \(viewer\.isCameraInMotion\(\)\) invalidatePreviewSamples\(\{ rebuild: false \}\);/);
  assert.match(ui, /event\?\.reason === 'lod' && viewer\.isCameraInMotion\(\)/);
});
