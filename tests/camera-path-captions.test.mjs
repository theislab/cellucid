/**
 * Camera path captions (`app/ui/modules/cinematic-camera/captions.js`):
 * which keyframe's label is the caption at each moment of a path, that only
 * a name someone gave is a caption, and the overlay: up while the film plays
 * or is paused and captions are on, faded between captions, at once under
 * reduced motion, gone when the film stops; what a picture of the screen reads.
 * The Camera Path module's setting (`captions`, part of the path's state) and
 * its actions (`camera-path.playback.set`, `camera-path.get`).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CAPTION_ELEMENT_ID,
  CAPTION_FADE_MS,
  captionAt,
  createCaptionOverlay,
  hasCaptions,
  isCaptionLabel,
  readShownCaption,
} from '../assets/js/app/ui/modules/cinematic-camera/captions.js';
import { getActions } from '../assets/js/app/actions/index.js';
import { cameraStateForOrbitPose } from '../assets/js/rendering/camera-state-contract.js';
import { destroyMounted, installModuleEnvironment, mountCinematicCamera } from './helpers/cinematic-camera-harness.mjs';

// Three keyframes: arrive at 0, 4 (hold 2, leave 6), 10.
const KEYFRAMES = [{ id: 'a', label: 'Overview' }, { id: 'b', label: 'Beta cells' }, { id: 'c', label: 'KF 3' }];
const TIMING = { arrivals: [0, 4, 10], departures: [0, 6, 10], total: 10 };

test('each named keyframe is the caption from halfway into its move to halfway out of it', () => {
  // Handovers: (0 + 4) / 2 = 2 and (6 + 10) / 2 = 8.
  assert.equal(captionAt(KEYFRAMES, TIMING, 0), 'Overview');
  assert.equal(captionAt(KEYFRAMES, TIMING, 1.99), 'Overview');
  assert.equal(captionAt(KEYFRAMES, TIMING, 2), 'Beta cells');
  assert.equal(captionAt(KEYFRAMES, TIMING, 5), 'Beta cells', 'held on its subject');
  assert.equal(captionAt(KEYFRAMES, TIMING, 7.99), 'Beta cells');
  assert.equal(captionAt(KEYFRAMES, TIMING, 8), null, 'an automatic name "KF 3" is no caption');
  assert.equal(captionAt(KEYFRAMES, TIMING, 10), null);
  // The return to start is never captioned.
  assert.equal(captionAt([...KEYFRAMES.slice(0, 2), { id: 'back', label: 'Overview again' }], TIMING, 9, 'back'), null);
  assert.equal(captionAt([], TIMING, 1), null);
  assert.equal(isCaptionLabel('KF 12'), false);
  assert.equal(isCaptionLabel('KF 1 close-up'), true);
  assert.equal(hasCaptions([{ id: 'x', label: 'KF 1' }, { id: 'y', label: 'KF 2' }]), false);
  assert.equal(hasCaptions(KEYFRAMES), true);
});

function fakeDocument() {
  const appended = [];
  const element = () => {
    const names = new Set();
    return {
      id: '', className: '', textContent: '', dataset: {}, attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      classList: {
        add: name => names.add(name), remove: name => names.delete(name), contains: name => names.has(name),
        toggle: (name, force) => { const on = force ?? !names.has(name); if (on) names.add(name); else names.delete(name); return on; },
      },
      remove() { appended.splice(appended.indexOf(this), 1); },
    };
  };
  return {
    body: { appendChild: child => appended.push(child) },
    createElement: element,
    getElementById: id => appended.find(child => child.id === id) ?? null,
    appended,
  };
}

function fakeController() {
  const listeners = { timeUpdate: new Set(), stateChange: new Set() };
  let state = 'STOPPED';
  return {
    getState: () => state,
    on: (event, fn) => listeners[event].add(fn),
    off: (event, fn) => listeners[event].delete(fn),
    play(elapsed = 0) { state = 'PLAYING'; for (const fn of listeners.stateChange) fn(state); this.at(elapsed); },
    at(elapsed) { for (const fn of listeners.timeUpdate) fn({ elapsed, globalT: elapsed / 10, totalDuration: 10 }); },
    pause() { state = 'PAUSED'; for (const fn of listeners.stateChange) fn(state); },
    stop() { state = 'STOPPED'; for (const fn of listeners.timeUpdate) fn({ elapsed: 0, globalT: 0, totalDuration: 10 }); for (const fn of listeners.stateChange) fn(state); },
    listeners,
  };
}

// The preference module keeps the MediaQueryList it is first handed and reads
// `matches` live, as a browser reports a change of the system setting.
const MOTION_MEDIA = { matches: false, addEventListener() {}, removeEventListener() {} };
globalThis.matchMedia = () => MOTION_MEDIA;
function withReducedMotion(reduce, run) {
  MOTION_MEDIA.matches = reduce;
  const finish = () => { MOTION_MEDIA.matches = false; };
  try {
    const result = run();
    if (typeof result?.then === 'function') return result.finally(finish);
    finish();
    return result;
  } catch (error) {
    finish();
    throw error;
  }
}

test('the caption is up while the film plays or is paused, fades between captions, and goes when it stops', async () => {
  await withReducedMotion(false, async () => {
    const documentRef = fakeDocument();
    const controller = fakeController();
    let enabled = true;
    const overlay = createCaptionOverlay({
      playbackController: controller, documentRef, enabled: () => enabled,
      caption: elapsed => captionAt(KEYFRAMES, TIMING, elapsed),
    });
    const element = documentRef.getElementById(CAPTION_ELEMENT_ID);
    assert.equal(element.attributes['aria-live'], 'polite');
    assert.equal(readShownCaption(documentRef), null, 'nothing before the film plays');
    controller.play(0.5);
    assert.equal(readShownCaption(documentRef), 'Overview', 'nothing shown before: in at once');
    assert.equal(element.classList.contains('visible'), true);
    controller.at(3);
    // Fading out the shown caption first, then the next in.
    assert.equal(element.classList.contains('visible'), false);
    await new Promise(resolve => setTimeout(resolve, CAPTION_FADE_MS + 30));
    assert.equal(readShownCaption(documentRef), 'Beta cells');
    assert.equal(element.classList.contains('visible'), true);
    controller.pause();
    assert.equal(readShownCaption(documentRef), 'Beta cells', 'a paused film keeps its title');
    enabled = false;
    overlay.refresh();
    await new Promise(resolve => setTimeout(resolve, CAPTION_FADE_MS + 30));
    assert.equal(readShownCaption(documentRef), null, 'captions off');
    enabled = true;
    overlay.refresh();
    assert.equal(readShownCaption(documentRef), 'Beta cells');
    controller.stop();
    await new Promise(resolve => setTimeout(resolve, CAPTION_FADE_MS + 30));
    assert.equal(readShownCaption(documentRef), null, 'gone when the film stops');
    overlay.destroy();
    assert.equal(documentRef.getElementById(CAPTION_ELEMENT_ID), null);
    assert.equal(controller.listeners.timeUpdate.size, 0);
  });
});

test('under reduced motion the caption is shown and hidden at once, without a fade', () => {
  withReducedMotion(true, () => {
    const documentRef = fakeDocument();
    const controller = fakeController();
    const overlay = createCaptionOverlay({
      playbackController: controller, documentRef, enabled: () => true,
      caption: elapsed => captionAt(KEYFRAMES, TIMING, elapsed),
    });
    const element = documentRef.getElementById(CAPTION_ELEMENT_ID);
    controller.play(0.5);
    controller.at(3);
    assert.equal(readShownCaption(documentRef), 'Beta cells', 'switched at once');
    assert.equal(element.classList.contains('no-motion'), true);
    controller.stop();
    assert.equal(readShownCaption(documentRef), null, 'hidden at once');
    overlay.destroy();
  });
});

test('captions are a playback setting of the path: on by default, set by camera-path.playback.set, read by camera-path.get, saved with the path', async () => {
  const environment = installModuleEnvironment();
  try {
    const module = mountCinematicCamera();
    const camera = index => cameraStateForOrbitPose({ navigationMode: 'orbit', target: [index, 0, 0], radius: 3, theta: 0.2 * index, phi: 0.75 });
    await getActions().dispatch('camera-path.keyframe.add', { camera: camera(0), label: 'Overview' });
    await getActions().dispatch('camera-path.keyframe.add', { camera: camera(1), label: 'Beta cells' });
    assert.equal((await getActions().dispatch('camera-path.get', {})).outcome.playback.captions, true);
    // On is the value a record without the key means: it is left out.
    assert.equal(Object.hasOwn(module.camera.exportPath(), 'captions'), false);
    await getActions().dispatch('camera-path.playback.set', { captions: false });
    assert.equal(module.dom.captionsCheckbox.checked, false);
    assert.equal((await getActions().dispatch('camera-path.get', {})).outcome.playback.captions, false);
    const saved = module.camera.exportPath();
    assert.equal(saved.captions, false);
    await getActions().dispatch('camera-path.playback.set', { captions: true });
    module.camera.restorePath(saved);
    assert.equal(module.dom.captionsCheckbox.checked, false, 'restored with the path');
    environment.drainFrames();
  } finally {
    destroyMounted();
    environment.restore();
  }
});
