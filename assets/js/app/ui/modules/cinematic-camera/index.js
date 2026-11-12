/**
 * @fileoverview Camera Path — main UI module.
 *
 * Wires the "Camera path" accordion: the save-position button, a unified
 * scrollable keyframe + timing list, playback settings, and the viewport
 * transport bar. Navigation itself lives in the Navigation panel; a keyframe
 * goto and playback move the mode through that panel's `syncNavigationMode`.
 * The path's own state (its keyframes and how it plays them, `exportPath`) is
 * the `camera-path` state domain's value; the navigation mode is the camera's
 * and the navigation settings are settings.
 *
 * Every change to the path is a camera path action
 * (`app/actions/definitions/camera.js`): the controls dispatch them, and this
 * module provides their implementations while it lives. A keyframe is named
 * by its label, so labels are unique. Playing, pausing and seeking change
 * nothing but the camera, whose resting place the camera observation records
 * (`camera-controls.js`); going to a keyframe is a `camera.set`.
 *
 * Follows the same factory-function pattern as camera-controls.js.
 *
 * @module ui/modules/cinematic-camera/index
 */

import {
  createKeyframeStore,
  isCameraPathReady,
  isValidCameraKeyframe,
  isValidCameraState,
  isValidKeyframeHold,
  keyframeHold,
  MIN_TRANSITION_DURATION_SECONDS
} from './keyframe-store.js';
import { createPlaybackController } from './playback-controller.js';
import { createTransportBar } from './transport-bar.js';
import { captionAt, createCaptionOverlay } from './captions.js';
import { readRecordKeys, writeRecordKeys } from '../../../state/domains/record-keys.js';
import { assertCameraPathOptions, resolvePathTiming } from './interpolation-engine.js';
import { getNotificationCenter } from '../../../notification-center.js';
import {
  assertNavigationMode,
  cameraInStep,
  cloneCameraState
} from '../../../../rendering/camera-state-contract.js';
import {
  parseIntegerInput,
  parseRangeInput
} from '../../core/numeric-input-contract.js';
import { escapeHtml } from '../../../utils/dom-utils.js';
import { ICONS, readDecimalInput } from '../../components/controls.js';
import { getActions } from '../../../actions/index.js';
import { ActionRefused } from '../../../actions/dispatcher.js';
import { dispatchFromControl } from '../../../actions/control-dispatch.js';
import { viewNameOf } from '../../../actions/targets/views.js';
import { formatCountOf } from '../../../../utils/format-units.js';
import { plainSentence, quoteName } from '../../../actions/targets/names.js';
import { onAbort } from '../../../../utils/abort.js';
import { prefersReducedMotion } from '../../../../utils/reduced-motion.js';
import { defineControlReadout } from '../../core/control-readout.js';

// Keyframe action glyphs. They are drawn at the shared icon-button size
// (`.icon-btn svg`); delete uses the one shared delete glyph.
const SVG_UP = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="18 15 12 9 6 15"/></svg>`;
const SVG_DOWN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>`;
const SVG_GOTO = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const SVG_DELETE = ICONS.delete.replace('<svg ', '<svg aria-hidden="true" ');
const LOOP_BACK_LABEL = '\u21A9 Return to start';
const NOTICE_CATEGORY = 'cinematic';
/**
 * The parts of the Camera Path's own state (`exportPath`): the required
 * keys, sorted, and the keys added since records were first written, with
 * the value their absence means (`app/state/domains/record-keys.js`): a
 * record saved before captions existed reads as captions on.
 */
const CAMERA_PATH_KEYS = Object.freeze({
  required: Object.freeze([
  'autoplay',
  'defaultSpeed',
  'easing',
  'keyframes',
  'loopBackKeyframeId',
  'loopPlayback',
  'nextIndex',
  'positionMethod',
  'rotationMethod',
  ]),
  added: Object.freeze({ captions: true }),
});
const REQUIRED_DOM_KEYS = [
  'saveBtn',
  'keyframeList',
  'clearBtn',
  'timingActions',
  'setAllDuration',
  'setAllBtn',
  'defaultSpeedInput',
  'defaultSpeedDisplay',
  'positionInterp',
  'rotationInterp',
  'easingSelect',
  'loopCheckbox',
  'autoplayCheckbox',
  'captionsCheckbox'
];

// Speed slider labels (maps slider 1-100 to descriptive text)
const SPEED_LABELS = [
  [15, 'Very slow'],
  [35, 'Slow'],
  [55, 'Medium'],
  [75, 'Fast'],
  [100, 'Very fast']
];

function speedLabel(val) {
  for (const [threshold, label] of SPEED_LABELS) {
    if (val <= threshold) return label;
  }
  return 'Very fast';
}

/**
 * Map the speed slider (1-100) to an auto-pace speed constant.
 * 30 (default) ≈ 0.6 units/s → a slow, cinematic feel.
 * 1 ≈ 0.1, 100 ≈ 4.0.
 */
function sliderToAutoPaceSpeed(raw) {
  const v = parseRangeInput(raw, {
    minimum: 1,
    maximum: 100,
    label: 'Camera path default speed'
  });
  // Exponential mapping for a nice feel
  return 0.1 * Math.pow(40, v / 100);
}

/**
 * Check the Camera Path's own state (`exportPath`'s shape): exactly its
 * keyframes, the number the next keyframe takes, the keyframe a loop
 * returns to, and how it plays them.
 *
 * @param {object} data
 * @returns {object} the same state
 */
export function assertCameraPathState(saved) {
  // A record saved before a key was added reads with that key's default.
  const data = readRecordKeys(saved, CAMERA_PATH_KEYS, 'Camera Path state');
  if (
    !Array.isArray(data.keyframes) ||
    !data.keyframes.every(isValidCameraKeyframe)
  ) {
    throw new TypeError('Camera Path state contains invalid keyframes.');
  }
  const ids = new Set(data.keyframes.map(({ id }) => id));
  if (ids.size !== data.keyframes.length) {
    throw new TypeError('Camera Path keyframe ids must be unique.');
  }
  if (!Number.isInteger(data.nextIndex) || data.nextIndex <= 0) {
    throw new TypeError('Camera Path nextIndex must be a positive integer.');
  }
  if (typeof data.defaultSpeed !== 'string') {
    throw new TypeError('Camera Path defaultSpeed must be a range-input string.');
  }
  if (typeof data.autoplay !== 'boolean') {
    throw new TypeError('Camera Path autoplay must be boolean.');
  }
  if (typeof data.captions !== 'boolean') {
    throw new TypeError('Camera Path captions must be boolean.');
  }
  assertCameraPathOptions({
    positionMethod: data.positionMethod,
    rotationMethod: data.rotationMethod,
    easing: data.easing,
    loop: data.loopPlayback,
    autoPaceSpeed: sliderToAutoPaceSpeed(data.defaultSpeed)
  });
  if (data.loopBackKeyframeId !== null) {
    if (
      typeof data.loopBackKeyframeId !== 'string' ||
      data.keyframes.length < 3 ||
      data.keyframes[data.keyframes.length - 1].id !== data.loopBackKeyframeId
    ) {
      throw new TypeError(
        'Camera Path loopBackKeyframeId must be null or identify the final keyframe of a complete loop.'
      );
    }
  }
  return data;
}

/**
 * @param {Object} options
 * @param {Object} options.viewer   Viewer API.
 * @param {Object} options.dom      Cached DOM references (cinematicCamera block).
 * @param {Object} options.navigation The Navigation panel (camera-controls.js):
 *   `syncNavigationMode`.
 * @param {Object} options.dataSourceManager Dataset lifecycle source.
 */
export function initCinematicCamera({
  viewer,
  dom,
  navigation,
  dataSourceManager,
  focusedRepresentation,
  representationNameOf
}) {
  if (typeof representationNameOf !== 'function') {
    throw new TypeError('Camera Path requires representationNameOf(): a representation\'s name, as every menu gives it.');
  }
  if (typeof focusedRepresentation !== 'function') {
    throw new TypeError(
      'Camera Path requires focusedRepresentation(): the embedding the focused view shows.'
    );
  }
  if (!dom || typeof dom !== 'object' || Array.isArray(dom)) {
    throw new TypeError('Camera Path requires a DOM reference object.');
  }
  if (typeof navigation?.syncNavigationMode !== 'function') {
    throw new TypeError('Camera Path requires the Navigation panel\'s syncNavigationMode().');
  }
  for (const key of REQUIRED_DOM_KEYS) {
    if (!dom[key]) {
      throw new Error(`Camera Path UI is missing its required "${key}" element.`);
    }
  }
  if (
    !dataSourceManager ||
    typeof dataSourceManager.onDatasetChange !== 'function' ||
    typeof dataSourceManager.offDatasetChange !== 'function'
  ) {
    throw new TypeError(
      'Camera Path requires dataset change subscription and unsubscription methods.'
    );
  }

  const keyframeStore = createKeyframeStore();
  const lifecycleController = new AbortController();
  const renderFrameIds = new Set();
  let destroyed = false;
  let loopBackKeyframeId = null;
  let suppressTransportReveal = false;
  let pathWasReady = false;

  function requireCinematicActive(operation) {
    if (destroyed) {
      throw new Error(`Camera Path cannot ${operation} after destruction.`);
    }
  }

  function listen(target, eventName, listener, options = {}) {
    const ownedListener = (...args) => {
      if (destroyed) return;
      return listener(...args);
    };
    target.addEventListener(
      eventName,
      ownedListener,
      { ...options, signal: lifecycleController.signal }
    );
    return ownedListener;
  }

  function scheduleRenderFrame(listener) {
    let completedSynchronously = false;
    let frameId = null;
    frameId = requestAnimationFrame(timestamp => {
      completedSynchronously = true;
      if (frameId !== null) renderFrameIds.delete(frameId);
      if (destroyed) return;
      listener(timestamp);
    });
    if (!completedSynchronously) renderFrameIds.add(frameId);
  }

  function hasLoopBackKeyframe() {
    return Boolean(loopBackKeyframeId && keyframeStore.getById(loopBackKeyframeId));
  }

  function getNonLoopBackCount() {
    return keyframeStore.getCount() - (hasLoopBackKeyframe() ? 1 : 0);
  }

  function syncLoopBackState() {
    if (loopBackKeyframeId && !keyframeStore.getById(loopBackKeyframeId)) {
      loopBackKeyframeId = null;
    }
    if (hasLoopBackKeyframe() && getNonLoopBackCount() < 2) {
      const staleId = loopBackKeyframeId;
      loopBackKeyframeId = null;
      keyframeStore.remove(staleId);
      return false;
    }
    return true;
  }

  function setLoopBackEnabled(enabled) {
    if (destroyed) return;
    const loopBackActive = hasLoopBackKeyframe();
    if (!enabled) {
      if (!loopBackActive) return;
      const id = loopBackKeyframeId;
      loopBackKeyframeId = null;
      keyframeStore.remove(id);
      return;
    }

    if (loopBackActive || getNonLoopBackCount() < 2) return;

    const first = keyframeStore.getAll().find((kf) => kf.id !== loopBackKeyframeId);
    if (!first) return;
    loopBackKeyframeId = keyframeStore.add(
      { navigationMode: first.navigationMode, orbit: first.orbit, freefly: first.freefly },
      LOOP_BACK_LABEL,
      first.representation
    );
  }

  function syncNavigationMode(mode) {
    if (destroyed) return;
    assertNavigationMode(mode);
    navigation.syncNavigationMode(mode);
  }

  // =========================================================================
  // Default speed slider
  // =========================================================================

  let autoPaceSpeed = sliderToAutoPaceSpeed(dom.defaultSpeedInput.value);

  // Its readout of any position ("Slow"), for the history as for the row (`core/control-readout.js`).
  defineControlReadout(dom.defaultSpeedInput, value => speedLabel(Number(value)));

  function updateDefaultSpeedDisplay() {
    if (destroyed) return;
    const raw = parseRangeInput(dom.defaultSpeedInput.value, {
      minimum: 1,
      maximum: 100,
      label: 'Camera path default speed'
    });
    autoPaceSpeed = sliderToAutoPaceSpeed(dom.defaultSpeedInput.value);
    dom.defaultSpeedDisplay.textContent = speedLabel(raw);
  }

  updateDefaultSpeedDisplay();
  // The label follows the slider at once; the setting is a step, recorded by
  // observation (`recordPlayback`; a drag is one, the definition coalesces it).
  listen(dom.defaultSpeedInput, 'input', () => {
    updateDefaultSpeedDisplay();
    recordPlayback({
      speed: parseRangeInput(dom.defaultSpeedInput.value, {
        minimum: 1,
        maximum: 100,
        label: 'Camera path default speed'
      })
    });
  });

  // =========================================================================
  // Interpolation options reader
  // =========================================================================

  function getInterpolationOptions() {
    return {
      positionMethod: dom.positionInterp.value,
      rotationMethod: dom.rotationInterp.value,
      easing: dom.easingSelect.value,
      loop: dom.loopCheckbox.checked,
      autoPaceSpeed
    };
  }

  // =========================================================================
  // Playback controller + transport bar
  // =========================================================================

  const playbackController = createPlaybackController({
    viewer,
    keyframeStore,
    getInterpolationOptions
  });

  const transportBar = createTransportBar({
    playbackController,
    keyframeStore,
    getInterpolationOptions
  });

  // Captions (F110): the named keyframe the film is at, over the plot. The
  // timing table is resolved once per path and pace, not per frame.
  let captionTiming = null;
  const captionOverlay = createCaptionOverlay({
    playbackController,
    enabled: () => dom.captionsCheckbox.checked,
    caption: elapsed => {
      const keyframes = keyframeStore.getAll();
      if (captionTiming === null || captionTiming.pace !== autoPaceSpeed || captionTiming.keyframes.length !== keyframes.length) {
        captionTiming = { pace: autoPaceSpeed, keyframes, timing: resolvePathTiming(keyframes, autoPaceSpeed) };
      }
      return captionAt(captionTiming.keyframes, captionTiming.timing, elapsed, loopBackKeyframeId);
    },
  });
  const forgetCaptionTiming = () => { captionTiming = null; };
  keyframeStore.on('changed', forgetCaptionTiming);

  // Keep the nav mode UI in sync when playback changes modes (cross-mode paths)
  // or when playback stops (which jumps to the first keyframe's mode).
  // A path replays camera poses. Recorded on one representation and played on
  // a view that shows another, it still plays; this says so once per play.
  let previousPlaybackState = 'STOPPED';
  playbackController.on('stateChange', (newState) => {
    if (destroyed) return;
    if (newState === 'PLAYING' && previousPlaybackState === 'STOPPED') {
      noteRepresentationMismatch();
    }
    previousPlaybackState = newState;
    if (newState === 'STOPPED') {
      syncNavigationMode(viewer.getNavigationMode());
    }
  });

  function noteRepresentationMismatch() {
    const recorded = keyframeStore.getAll()[0]?.representation ?? null;
    const current = focusedRepresentation();
    if (
      recorded === null ||
      current === null ||
      current.ref === null ||
      (recorded.key === current.ref.key &&
        JSON.stringify(recorded.columns) === JSON.stringify(current.ref.columns))
    ) {
      return;
    }
    const recordedName = representationNameOf({
      layoutKey: recorded.key,
      label: recorded.key,
      provenance: recorded.columns === null ? null : { key: recorded.key, columns: recorded.columns },
    });
    getNotificationCenter().info(
      `This camera path was recorded on ${recordedName}; the view shows ${current.name}.`,
      { category: 'cinematic', duration: 5000 }
    );
  }

  function startAutoplay() {
    if (destroyed) return false;
    if (!dom.autoplayCheckbox.checked || !isCameraPathReady(keyframeStore.getAll())) {
      return false;
    }
    if (playbackController.getState() === 'PLAYING') {
      return true;
    }
    transportBar.updateVisibility({ reveal: true });
    playbackController.play();
    return true;
  }



  // =========================================================================
  // Playback settings: each control is one setting of camera-path.playback.set
  // =========================================================================

  /**
   * A playback setting a person changed on its control. The controls are the
   * settings (`exportPath` reads them, the `camera-path` domain's value), so
   * the person's change is already made when its event arrives: it is
   * recorded as its `camera-path.playback.set` step by observation,
   * synchronously from that event, the way the settings controls are
   * (`settings-actions.js`). A dispatch here would find the control already
   * at the value and leave the change to be kept as "Changed outside the
   * history". An agent's, a notebook's or a replay's step sets the controls
   * through the action (`PLAYBACK_CONTROLS`).
   */
  function recordPlayback(params) {
    try {
      getActions()
        .recordObserved('camera-path.playback.set', params)
        .catch(error => console.error('[CinematicCamera] A playback setting could not be recorded.', error));
    } catch (error) {
      console.error('[CinematicCamera] A playback setting could not be recorded.', error);
    }
  }

  listen(dom.positionInterp, 'change', () => {
    recordPlayback({ position_interpolation: dom.positionInterp.value });
  });
  listen(dom.rotationInterp, 'change', () => {
    recordPlayback({ rotation_interpolation: dom.rotationInterp.value });
  });
  listen(dom.easingSelect, 'change', () => {
    recordPlayback({ easing: dom.easingSelect.value });
  });
  listen(dom.loopCheckbox, 'change', () => {
    recordPlayback({ loop: dom.loopCheckbox.checked });
  });
  listen(dom.captionsCheckbox, 'change', () => {
    recordPlayback({ captions: dom.captionsCheckbox.checked });
    captionOverlay.refresh();
  });
  listen(dom.autoplayCheckbox, 'change', () => {
    recordPlayback({ autoplay: dom.autoplayCheckbox.checked });
    // Turned on with a path ready, it plays, as the action's does.
    if (dom.autoplayCheckbox.checked) startAutoplay();
  });

  /** Dispatch a camera path action from one of its controls. */
  function dispatchPath(type, params, failure) {
    return dispatchFromControl(type, params, { failure, category: NOTICE_CATEGORY });
  }

  // =========================================================================
  // Save Position
  // =========================================================================

  listen(dom.saveBtn, 'click', () => {
    // The camera and embedding of now are the step's own, so a replay saves
    // the same keyframe.
    void dispatchPath('camera-path.keyframe.add', {
      camera: cloneCameraState(viewer.getCameraState(), 'Camera path saved camera'),
      embedding: focusedRepresentation()?.ref ?? null
    }, 'Saving the camera position failed');
  });

  // =========================================================================
  // Clear All
  // =========================================================================

  listen(dom.clearBtn, 'click', () => {
    if (keyframeStore.getCount() === 0) return;
    void dispatchPath('camera-path.clear', {}, 'Clearing the camera path failed');
  });

  // =========================================================================
  // Set All Timing
  // =========================================================================

  /**
   * Read a typed transition duration. Out-of-range or malformed text is the
   * viewer's input, not a programming error: the field reports why it was
   * rejected, shows `revertValue` again, and nothing is stored.
   *
   * @param {HTMLInputElement} input
   * @param {string} revertValue
   * @returns {{ valid: true, value: number|null } | { valid: false }}
   */
  function readTransitionDurationInput(input, revertValue) {
    // A decimal box (`createDecimalInput`): "1.5" or "1,5" in any locale;
    // empty is auto. No longest transition: any finite number of seconds.
    const typed = input.value.trim() === '' ? null : readDecimalInput(input);
    const value = typed === null || (Number.isFinite(typed) && typed >= MIN_TRANSITION_DURATION_SECONDS)
      ? typed
      : undefined;
    if (value === undefined) {
      input.value = revertValue;
      input.setCustomValidity(
        `Enter a duration of at least ${MIN_TRANSITION_DURATION_SECONDS} ` +
        'seconds, or leave it empty for auto.'
      );
      input.reportValidity();
      return { valid: false };
    }
    input.setCustomValidity('');
    return { valid: true, value };
  }

  /**
   * Read a typed hold: empty is none (0), else any finite number of seconds,
   * 0 or more (no longest). Other text is reported on the field, which shows
   * `revertValue` again.
   *
   * @param {HTMLInputElement} input
   * @param {string} revertValue
   * @returns {{ valid: true, value: number } | { valid: false }}
   */
  function readHoldInput(input, revertValue) {
    const typed = input.value.trim() === '' ? 0 : readDecimalInput(input);
    if (!isValidKeyframeHold(typed)) {
      input.value = revertValue;
      input.setCustomValidity('Enter the seconds the camera rests here, 0 or more, or leave it empty for none.');
      input.reportValidity();
      return { valid: false };
    }
    input.setCustomValidity('');
    return { valid: true, value: typed };
  }

  // A rejected entry stays flagged only until the viewer edits it again.
  listen(dom.setAllDuration, 'input', () => {
    dom.setAllDuration.setCustomValidity('');
  });

  listen(dom.setAllBtn, 'click', () => {
    const duration = readTransitionDurationInput(dom.setAllDuration, '');
    if (!duration.valid) return;
    void dispatchPath(
      'camera-path.duration.set',
      { seconds: duration.value },
      'Setting every transition time failed'
    );
  });

  // =========================================================================
  // Unified keyframe + timing list rendering
  // =========================================================================

  /**
   * Identify the list control that holds focus, so a rebuild of the list can
   * put focus back on the equivalent control instead of dropping it to body.
   */
  function captureKeyframeListFocus(listEl) {
    const active = document.activeElement;
    if (!active || active === listEl || !listEl.contains(active)) return null;
    if (active.classList.contains('cinematic-loopback-list-toggle')) {
      return { selector: '.cinematic-loopback-list-toggle' };
    }
    const pairIndex = active.dataset.pairIndex;
    if (pairIndex !== undefined) {
      return { selector: `.cinematic-duration-input[data-pair-index="${pairIndex}"]` };
    }
    const holdIndex = active.dataset.holdIndex;
    if (holdIndex !== undefined) {
      return { selector: `.cinematic-hold-input[data-hold-index="${holdIndex}"]` };
    }
    const item = active.closest('.cinematic-keyframe-item');
    const action = active.dataset.action;
    if (item && action) {
      return {
        itemId: item.dataset.id,
        selector: `[data-action="${action}"]`
      };
    }
    return item ? { itemId: item.dataset.id, selector: '[data-action="rename"]' } : null;
  }

  function restoreKeyframeListFocus(listEl, snapshot) {
    if (snapshot === null) return;
    let scope = listEl;
    if (snapshot.itemId !== undefined) {
      scope = [...listEl.querySelectorAll('.cinematic-keyframe-item')]
        .find(item => item.dataset.id === snapshot.itemId) ?? null;
      if (scope === null) return;
    }
    // A move button that became disabled (the keyframe reached an end) hands
    // focus to the keyframe's first enabled action button instead.
    const candidates = [
      scope.querySelector(`${snapshot.selector}:not(:disabled)`),
      scope.querySelector('.icon-btn:not(:disabled)'),
      scope.querySelector('[data-action]:not(:disabled)'),
    ];
    const target = candidates.find(candidate => candidate !== null) ?? null;
    target?.focus({ preventScroll: true });
  }

  function renderKeyframeList() {
    if (destroyed) return;
    const listEl = dom.keyframeList;
    if (!listEl) return;
    const focusSnapshot = captureKeyframeListFocus(listEl);

    const keyframes = keyframeStore.getAll();
    const hasLoopBack = hasLoopBackKeyframe();
    const nonLoopBackCount = getNonLoopBackCount();
    // Nothing to clear: dimmed, as Undo is with nothing to undo (R9E-9: a
    // click did nothing at all).
    dom.clearBtn.disabled = keyframes.length === 0;

    if (keyframes.length === 0) {
      listEl.innerHTML = '<p class="empty-state">No keyframes saved yet.</p>';
      if (dom.timingActions) dom.timingActions.hidden = true;
      if (focusSnapshot !== null) dom.saveBtn.focus({ preventScroll: true });
      return;
    }

    let html = '';
    const lastMovableIndex = keyframes.length - 1 - (hasLoopBack ? 1 : 0);
    for (let i = 0; i < keyframes.length; i++) {
      const kf = keyframes[i];
      const isLoopBack = hasLoopBack && kf.id === loopBackKeyframeId;
      const actionButtons = isLoopBack
        ? ''
        : `<div class="cinematic-keyframe-actions">
    <button type="button" class="icon-btn" data-action="up" aria-label="Move up" title="Move up"${i === 0 ? ' disabled' : ''}>${SVG_UP}</button>
    <button type="button" class="icon-btn" data-action="down" aria-label="Move down" title="Move down"${i >= lastMovableIndex ? ' disabled' : ''}>${SVG_DOWN}</button>
    <button type="button" class="icon-btn" data-action="goto" aria-label="Go to position" title="Go to position">${SVG_GOTO}</button>
    <button type="button" class="icon-btn icon-btn-danger" data-action="delete" aria-label="Delete keyframe" title="Delete keyframe">${SVG_DELETE}</button>
  </div>`;
      html += `<div class="cinematic-keyframe-item${isLoopBack ? ' cinematic-keyframe-item-loopback' : ''}" data-id="${escapeHtml(kf.id)}">
  <span class="cinematic-keyframe-index">${i + 1}</span>
  ${isLoopBack
    ? `<span class="cinematic-keyframe-label cinematic-keyframe-label-static">${escapeHtml(kf.label)}</span>`
    : `<button type="button" class="cinematic-keyframe-label" data-action="rename" title="${escapeHtml(kf.label)} (click to rename)" aria-label="Rename keyframe ${escapeHtml(kf.label)}">${escapeHtml(kf.label)}</button>`}
  ${actionButtons}
</div>`;

      // The timing row after each keyframe of a path (two or more): its hold
      // (the camera rests there), then the transition to the next one.
      if (keyframes.length < 2) continue;
      const hold = keyframeHold(kf);
      html += `<div class="cinematic-timing-row" data-pair="${i}">
  <input type="text" inputmode="decimal" class="obs-select cinematic-duration-input cinematic-hold-input" autocomplete="off" spellcheck="false"
         value="${hold > 0 ? hold : ''}" placeholder="0" data-hold-index="${i}" aria-label="Hold at ${escapeHtml(kf.label)}, in seconds" title="Seconds the camera rests at ${escapeHtml(kf.label)} before moving on (empty for none)" />
  <span class="cinematic-timing-unit">s hold</span>`;
      if (i < keyframes.length - 1) {
        const dur = kf.transitionDuration;
        const val = dur != null ? dur : '';
        html += `
  <span class="cinematic-timing-label" title="${escapeHtml(kf.label)} → ${escapeHtml(keyframes[i + 1].label)}">→</span>
  <input type="text" inputmode="decimal" class="obs-select cinematic-duration-input" autocomplete="off" spellcheck="false"
         value="${val}" placeholder="auto" data-pair-index="${i}" aria-label="Seconds from ${escapeHtml(kf.label)} to ${escapeHtml(keyframes[i + 1].label)}" title="Duration in seconds (leave empty for auto)" />
  <span class="cinematic-timing-unit">s</span>`;
      } else {
        html += `
  <span class="cinematic-timing-label">at the end</span>`;
      }
      html += `
</div>`;
    }
    if (nonLoopBackCount >= 2) {
      html += `<label class="checkbox-inline cinematic-loopback-row">
  <input type="checkbox" class="cinematic-loopback-list-toggle"${hasLoopBack ? ' checked' : ''} />
  End with a return to the first keyframe
</label>`;
    }
    listEl.innerHTML = html;
    restoreKeyframeListFocus(listEl, focusSnapshot);

    // Show the "Set all" actions row when ≥ 2 keyframes
    if (dom.timingActions) {
      dom.timingActions.hidden = keyframes.length < 2;
    }

    // Toggle scroll-fade mask only when content overflows
    scheduleRenderFrame(() => {
      listEl.classList.toggle('is-scrollable', listEl.scrollHeight > listEl.clientHeight);
    });
  }

  // =========================================================================
  // Keyframe list event delegation
  // =========================================================================

  if (dom.keyframeList) {
    listen(dom.keyframeList, 'click', (e) => {
      const item = e.target.closest('.cinematic-keyframe-item');
      if (!item) return;
      const id = item.dataset.id;

      const actionEl = e.target.closest('[data-action]');
      if (!actionEl) return;
      const action = actionEl.dataset.action;
      const isLoopBack = hasLoopBackKeyframe() && id === loopBackKeyframeId;
      const kf = keyframeStore.getById(id);
      if (!kf) return;

      if (action === 'delete') {
        if (isLoopBack) return;
        void dispatchPath(
          'camera-path.keyframe.remove',
          { keyframe: kf.label },
          'Deleting the keyframe failed'
        );
      } else if (action === 'up' || action === 'down') {
        if (isLoopBack || !canMove(kf, action)) return;
        void dispatchPath(
          'camera-path.keyframe.move',
          { keyframe: kf.label, direction: action },
          'Moving the keyframe failed'
        );
      } else if (action === 'goto') {
        void gotoKeyframe(kf);
      } else if (action === 'rename') {
        if (isLoopBack) return;
        startInlineRename(item, id, actionEl);
      }
    });

    // Timing input changes (event delegation on the same list)
    listen(dom.keyframeList, 'change', (e) => {
      const loopBackToggle = e.target.closest('.cinematic-loopback-list-toggle');
      if (loopBackToggle) {
        void dispatchPath(
          'camera-path.loop-back.set',
          { enabled: loopBackToggle.checked },
          'Changing the return to start failed'
        ).then(result => {
          // A refusal leaves the path as it was: the toggle says so again.
          if (result === null) renderKeyframeList();
        });
        return;
      }
      const holdInput = e.target.closest('.cinematic-hold-input');
      if (holdInput) {
        const index = parseIntegerInput(holdInput.dataset.holdIndex, {
          minimum: 0,
          maximum: Math.max(0, keyframeStore.getCount() - 1),
          label: 'Camera Path keyframe hold index'
        });
        const kf = keyframeStore.getAll()[index];
        const stored = kf === undefined ? 0 : keyframeHold(kf);
        const hold = readHoldInput(holdInput, stored > 0 ? String(stored) : '');
        if (!hold.valid || kf === undefined) return;
        void dispatchPath(
          'camera-path.hold.set',
          { keyframe: kf.label, seconds: hold.value },
          'Setting the hold failed'
        ).then(result => {
          // A refusal (or nothing to change) shows the stored hold again.
          if (result === null) renderKeyframeList();
        });
        return;
      }
      const input = e.target.closest('.cinematic-duration-input');
      if (!input) return;
      const pairIndex = parseIntegerInput(input.dataset.pairIndex, {
        minimum: 0,
        maximum: Math.max(0, keyframeStore.getCount() - 2),
        label: 'Camera Path keyframe pair index'
      });
      const from = keyframeStore.getAll()[pairIndex];
      const stored = from?.transitionDuration;
      const duration = readTransitionDurationInput(
        input,
        stored == null ? '' : String(stored)
      );
      if (!duration.valid || from === undefined) return;
      void dispatchPath(
        'camera-path.duration.set',
        { keyframe: from.label, seconds: duration.value },
        'Setting the transition time failed'
      ).then(result => {
        // A refusal shows the stored time again.
        if (result === null) renderKeyframeList();
      });
    });

    listen(dom.keyframeList, 'input', (e) => {
      const input = e.target.closest('.cinematic-duration-input');
      if (input) input.setCustomValidity('');
    });
  }

  // =========================================================================
  // Inline rename
  // =========================================================================

  function startInlineRename(itemEl, kfId, labelEl) {
    if (destroyed) return;
    if (itemEl.querySelector('.cinematic-keyframe-rename')) return;

    const kf = keyframeStore.getById(kfId);
    if (!kf) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'obs-select cinematic-keyframe-rename';
    input.setAttribute('aria-label', `Rename keyframe ${kf.label}`);
    input.value = kf.label;

    labelEl.hidden = true;
    labelEl.parentElement.insertBefore(input, labelEl.nextSibling);
    input.focus();
    input.select();

    const finish = ({ focusLabel }) => {
      labelEl.hidden = false;
      if (focusLabel) labelEl.focus({ preventScroll: true });
      input.remove();
    };
    // A committed rename rebuilds the list while the input still holds focus,
    // so the rebuild returns focus to the renamed keyframe's label. Every
    // other ending puts focus back on the label explicitly. A label another
    // keyframe has is said on the input, which stays open.
    const commit = ({ focusLabel }) => {
      const current = keyframeStore.getById(kfId);
      const newLabel = input.value.trim();
      if (current === undefined || !newLabel || newLabel === current.label) {
        finish({ focusLabel });
        return true;
      }
      const problem = keyframeLabelProblem(newLabel, kfId);
      if (problem !== null) {
        input.setCustomValidity(plainSentence(problem));
        input.reportValidity();
        return false;
      }
      input.setCustomValidity('');
      void dispatchPath(
        'camera-path.keyframe.rename',
        { keyframe: current.label, label: newLabel },
        'Renaming the keyframe failed'
      ).then(result => {
        if (result === null && input.isConnected) finish({ focusLabel });
      });
      return true;
    };

    let ownedCommit = null;
    const armBlurCommit = () => {
      ownedCommit = listen(
        input,
        'blur',
        () => {
          if (!commit({ focusLabel: false })) armBlurCommit();
        },
        { once: true }
      );
    };
    armBlurCommit();
    listen(input, 'input', () => input.setCustomValidity(''));
    listen(input, 'keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.removeEventListener('blur', ownedCommit);
        if (!commit({ focusLabel: true })) armBlurCommit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        input.removeEventListener('blur', ownedCommit);
        finish({ focusLabel: true });
      }
    });
  }

  // =========================================================================
  // Keyframes by label, and the camera path actions
  // =========================================================================

  /** Whether `kf` can move one place `direction` ('up' or 'down'). */
  function canMove(kf, direction) {
    const all = keyframeStore.getAll();
    const index = all.findIndex(candidate => candidate.id === kf.id);
    if (direction === 'up') return index > 0;
    // The return to start stays last: nothing moves past it.
    return index >= 0 && index < all.length - 1 - (hasLoopBackKeyframe() ? 1 : 0);
  }

  function listKeyframes() {
    const labels = keyframeStore.getAll().map(kf => `${quoteName(kf.label)}`);
    if (labels.length === 0) return 'the camera path has no keyframes';
    return `its keyframes are ${labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`}`;
  }

  /** Why `label` cannot be a keyframe's (other than `exceptId`'s), or null. */
  function keyframeLabelProblem(label, exceptId) {
    if (label === LOOP_BACK_LABEL) {
      return `${quoteName(LOOP_BACK_LABEL)} names the return to the first keyframe; choose another label.`;
    }
    if (keyframeStore.getAll().some(kf => kf.label === label && kf.id !== exceptId)) {
      return `A keyframe is labeled ${quoteName(label)} already; choose another label.`;
    }
    return null;
  }

  function refuseLabel(label, exceptId) {
    const problem = keyframeLabelProblem(label, exceptId);
    if (problem !== null) throw new ActionRefused(problem, { code: 'refused' });
  }

  /** The keyframe labeled `label`, or a refusal that names the keyframes there are. */
  function keyframeNamed(label) {
    const matches = keyframeStore.getAll().filter(kf => kf.label === label);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new ActionRefused(
        `${formatCountOf(matches.length, 'keyframe')} are labeled ${quoteName(label)}; rename all but one first.`,
        { code: 'ambiguous' }
      );
    }
    throw new ActionRefused(`There is no keyframe ${quoteName(label)}; ${listKeyframes()}.`, { code: 'no-target' });
  }

  /** A keyframe a person edits: never the return to start, which follows its toggle. */
  function editableKeyframeNamed(label, verb) {
    const kf = keyframeNamed(label);
    if (hasLoopBackKeyframe() && kf.id === loopBackKeyframeId) {
      throw new ActionRefused(
        `The return to the first keyframe cannot be ${verb}; turn it off with "End with a return to the first keyframe".`,
        { code: 'refused' }
      );
    }
    return kf;
  }

  async function gotoKeyframe(kf) {
    const result = await dispatchPath('camera.set', {
      view: viewNameOf(viewer, viewer.getFocusedViewId()),
      camera: cloneCameraState({
        navigationMode: kf.navigationMode,
        orbit: kf.orbit,
        freefly: kf.freefly
      }, 'Camera path keyframe')
    }, 'Going to the keyframe failed');
    // Keep the navigation dropdown and sub-panels in sync with the
    // keyframe's mode so the user sees the correct controls after goto.
    if (result !== null && !destroyed) syncNavigationMode(kf.navigationMode);
  }

  const PLAYBACK_CONTROLS = Object.freeze({
    position_interpolation: value => { dom.positionInterp.value = value; },
    rotation_interpolation: value => { dom.rotationInterp.value = value; },
    easing: value => { dom.easingSelect.value = value; },
    speed: value => {
      dom.defaultSpeedInput.value = String(value);
      updateDefaultSpeedDisplay();
    },
    loop: value => { dom.loopCheckbox.checked = value; },
    captions: value => {
      dom.captionsCheckbox.checked = value;
      captionOverlay.refresh();
    },
    autoplay: value => {
      dom.autoplayCheckbox.checked = value;
      if (value) startAutoplay();
    }
  });

  const handlers = {
    'camera-path.keyframe.add': (params) => {
      const camera = params.camera === undefined ? viewer.getCameraState() : params.camera;
      if (!isValidCameraState(camera)) {
        throw new ActionRefused(
          'A keyframe needs a complete camera: a radius above 0 and finite angles and positions.',
          { code: 'refused' }
        );
      }
      if (params.label !== undefined) refuseLabel(params.label, null);
      const embedding = params.embedding === undefined
        ? (focusedRepresentation()?.ref ?? null)
        : params.embedding;
      const loopBackWasActive = hasLoopBackKeyframe();
      // A camera composed by hand keeps the pose its mode drives; its
      // free-fly pose (a cross-mode transition flies it) follows that one.
      const id = keyframeStore.add(
        cloneCameraState(cameraInStep(camera), 'Camera path keyframe camera'),
        params.label,
        embedding,
        params.hold ?? 0
      );
      // A new keyframe goes before the return to start.
      if (loopBackWasActive) keyframeStore.reorder(id, -1);
      return { keyframe: keyframeStore.getById(id).label };
    },
    'camera-path.keyframe.remove': (params) => {
      const kf = editableKeyframeNamed(params.keyframe, 'deleted');
      keyframeStore.remove(kf.id);
      return { keyframe: kf.label };
    },
    'camera-path.keyframe.move': (params) => {
      const kf = editableKeyframeNamed(params.keyframe, 'moved');
      if (!canMove(kf, params.direction)) {
        throw new ActionRefused(
          params.direction === 'up'
            ? `${quoteName(kf.label)} is the first keyframe already.`
            : `${quoteName(kf.label)} is the last keyframe${hasLoopBackKeyframe() ? ' before the return to start' : ''} already.`,
          { code: 'refused' }
        );
      }
      keyframeStore.reorder(kf.id, params.direction === 'up' ? -1 : 1);
      return { keyframe: kf.label };
    },
    'camera-path.keyframe.rename': (params) => {
      const kf = editableKeyframeNamed(params.keyframe, 'renamed');
      if (params.label === kf.label) return null;
      refuseLabel(params.label, kf.id);
      keyframeStore.rename(kf.id, params.label);
      return { keyframe: params.label };
    },
    'camera-path.duration.set': (params) => {
      const all = keyframeStore.getAll();
      if (params.keyframe === undefined) {
        if (all.length < 2) {
          throw new ActionRefused(
            'A transition needs two keyframes; save another camera position first.',
            { code: 'refused' }
          );
        }
        keyframeStore.setAllDurations(params.seconds);
        return { keyframes: all.length };
      }
      const kf = keyframeNamed(params.keyframe);
      const index = all.findIndex(candidate => candidate.id === kf.id);
      if (index === all.length - 1) {
        throw new ActionRefused(
          `No transition starts at ${quoteName(kf.label)}: it is the last keyframe.`,
          { code: 'refused' }
        );
      }
      keyframeStore.setDuration(index, params.seconds);
      return { keyframe: kf.label };
    },
    'camera-path.hold.set': (params) => {
      if (params.keyframe === undefined) {
        const count = keyframeStore.getCount();
        if (count === 0) {
          throw new ActionRefused('The camera path has no keyframes; save a camera position first.', { code: 'refused' });
        }
        if (keyframeStore.getAll().every(kf => keyframeHold(kf) === params.seconds)) return null;
        keyframeStore.setAllHolds(params.seconds);
        return { keyframes: count };
      }
      const kf = keyframeNamed(params.keyframe);
      if (keyframeHold(kf) === params.seconds) return null;
      keyframeStore.setHold(keyframeStore.getAll().findIndex(candidate => candidate.id === kf.id), params.seconds);
      return { keyframe: kf.label };
    },
    'camera-path.loop-back.set': (params) => {
      if (params.enabled && !hasLoopBackKeyframe() && getNonLoopBackCount() < 2) {
        throw new ActionRefused(
          'A return to the first keyframe needs two keyframes; save another camera position first.',
          { code: 'refused' }
        );
      }
      setLoopBackEnabled(params.enabled);
      // keyframeStore.add emits before loopBackKeyframeId is assigned, so the
      // list is drawn once more with the toggle as it is now.
      renderKeyframeList();
      return null;
    },
    'camera-path.clear': () => {
      const count = keyframeStore.getCount();
      if (count === 0) return null;
      // Playback stops where the camera is: clearing the path is not a
      // camera move.
      playbackController.stop({ resetCamera: false });
      keyframeStore.clear();
      return { keyframes: count };
    },
    'camera-path.playback.set': (params) => {
      for (const [key, value] of Object.entries(params)) PLAYBACK_CONTROLS[key](value);
      return null;
    },
    'camera-path.play': (params, { signal, meta, ongoing }) => playPath(signal, meta, ongoing),
    // Runs at once, beside a `camera-path.play` still waiting for the path to
    // end (a stepless control): that play then answers ended "stopped".
    'camera-path.stop': () => {
      if (playbackController.getState() === 'STOPPED') return { stopped: false };
      playbackController.stop({ resetCamera: false });
      return { stopped: true };
    },
    'camera-path.get': () => describePath()
  };

  /**
   * Play the path from its first keyframe (`camera-path.play`): the step
   * lasts as long as the playback, so the camera it moves is that step's
   * (the settles on the way are not steps of their own) and undo puts the
   * camera back where it was. A looping path plays on: the step ends at
   * once and Stop (`camera-path.stop`, the transport bar) ends the loop. A
   * replay, a restore or a reduced-motion preference does not animate: the
   * camera goes to the end of the path. Under reduced motion the play says
   * so (`ended: 'reduced-motion'`, `seconds`: how long the camera moved, 0
   * when it went there at once), so an agent never tells the person a film
   * played that did not (live pass 5, L18-3).
   */
  function playPath(signal, meta, ongoing) {
    const keyframes = keyframeStore.getAll();
    if (!isCameraPathReady(keyframes)) {
      throw new ActionRefused(
        `A camera path plays between two keyframes or more; ${listKeyframes()}.`,
        { code: 'refused' }
      );
    }
    const seconds = resolvePathTiming(keyframes, autoPaceSpeed).total;
    const outcome = (ended, moved = seconds) => ({ seconds: Math.round(moved * 10) / 10, keyframes: keyframes.length, ended });
    if (playbackController.getState() !== 'STOPPED') playbackController.stop({ resetCamera: false });
    syncNavigationMode(keyframes[0].navigationMode);
    if (meta?.origin === 'replay' || meta?.origin === 'session' || meta?.origin === 'startup') {
      playbackController.seekTo(1);
      playbackController.stop({ resetCamera: false });
      syncNavigationMode(viewer.getNavigationMode());
      return outcome('end');
    }
    transportBar.updateVisibility({ reveal: true });
    // From its first keyframe, wherever an earlier film stopped (a stop keeps
    // its position for the person's Play, R9R-7).
    playbackController.seekTo(0);
    playbackController.play();
    // Reduced motion completes the path at once: it went to its end without moving.
    if (playbackController.getState() !== 'PLAYING') return outcome('reduced-motion', 0);
    const startedAt = performance.now();
    if (dom.loopCheckbox.checked) {
      // The step of a loop is its start: the camera at the first keyframe now,
      // not at the next frame, so the step holds the change it made (it was
      // answered "it was so already"; L11-6). Where the loop is stopped is
      // recorded then (camera-controls.js `setCameraPathPlaying`).
      playbackController.seekTo(0);
      // The loop plays on after this answers, and belongs to the turn that
      // started it: that turn's Stop stops it where it is (R9R-8); it lets go
      // once the loop comes to rest another way.
      const release = ongoing(() => {
        if (playbackController.getState() !== 'STOPPED') playbackController.stop({ resetCamera: false });
      });
      const onLoopState = state => {
        if (state === 'PLAYING') return;
        playbackController.off('stateChange', onLoopState);
        release();
      };
      playbackController.on('stateChange', onLoopState);
      return outcome('looping');
    }
    return new Promise(resolve => {
      // Played to its end, the last frame is the path's end (progress 1).
      let reachedEnd = false;
      const onTime = ({ globalT }) => {
        if (globalT === 1) reachedEnd = true;
      };
      const onState = state => {
        if (state === 'PLAYING') return;
        finish();
        // Reduced motion turned on while it played: it went the rest of the way at once.
        if (reachedEnd && prefersReducedMotion()) resolve(outcome('reduced-motion', Math.min(seconds, (performance.now() - startedAt) / 1000)));
        else resolve(outcome(reachedEnd ? 'end' : 'stopped'));
      };
      // The person's Stop of the turn stops the film where it is, as a
      // pause and camera-path.stop do: it answers "stopped" and its step
      // keeps that camera (`keepsWhenStopped`, F104).
      const onAbortPlay = () => {
        finish();
        if (playbackController.getState() !== 'STOPPED') playbackController.stop({ resetCamera: false });
        resolve(outcome('stopped'));
      };
      let removeAbort = () => {};
      function finish() {
        playbackController.off('stateChange', onState);
        playbackController.off('timeUpdate', onTime);
        removeAbort();
      }
      playbackController.on('timeUpdate', onTime);
      playbackController.on('stateChange', onState);
      // A turn stopped (the person's Stop) stops the playback where it is.
      removeAbort = onAbort(signal, onAbortPlay);
    });
  }

  /** The path as `camera-path.get` reads it. */
  function describePath() {
    const keyframes = keyframeStore.getAll();
    const timing = resolvePathTiming(keyframes, autoPaceSpeed);
    const tenth = value => Math.round(value * 100) / 100;
    const playing = { PLAYING: 'playing', PAUSED: 'paused', STOPPED: 'stopped' }[playbackController.getState()];
    return {
      keyframes: keyframes.map((kf, index) => ({
        label: kf.label,
        at: tenth(timing.arrivals[index]),
        hold: timing.holds[index],
        seconds: index < timing.transitions.length ? tenth(timing.transitions[index]) : null,
        automatic: index < timing.transitions.length && kf.transitionDuration == null,
        camera: cloneCameraState({ navigationMode: kf.navigationMode, orbit: kf.orbit, freefly: kf.freefly }, 'Camera path keyframe'),
        embedding: kf.representation === null
          ? null
          : { key: kf.representation.key, columns: kf.representation.columns === null ? null : [...kf.representation.columns] },
      })),
      seconds: tenth(timing.total),
      playing,
      return_to_start: hasLoopBackKeyframe(),
      playback: {
        position_interpolation: dom.positionInterp.value,
        rotation_interpolation: dom.rotationInterp.value,
        easing: dom.easingSelect.value,
        speed: parseRangeInput(dom.defaultSpeedInput.value, { minimum: 1, maximum: 100, label: 'Camera path default speed' }),
        loop: dom.loopCheckbox.checked,
        autoplay: dom.autoplayCheckbox.checked,
        captions: dom.captionsCheckbox.checked,
      },
    };
  }


  // =========================================================================
  // React to keyframe store changes
  // =========================================================================

  function handleKeyframeStoreChange() {
    if (destroyed) return;
    if (!syncLoopBackState()) return;
    const pathIsReady = isCameraPathReady(keyframeStore.getAll());
    renderKeyframeList();
    transportBar.updateVisibility({ reveal: !suppressTransportReveal });
    if (
      !suppressTransportReveal &&
      !pathWasReady &&
      pathIsReady &&
      dom.autoplayCheckbox.checked
    ) {
      startAutoplay();
    }
    pathWasReady = pathIsReady;
  }

  keyframeStore.on('changed', handleKeyframeStoreChange);

  // =========================================================================
  // Initial render
  // =========================================================================

  syncLoopBackState();
  renderKeyframeList();
  pathWasReady = isCameraPathReady(keyframeStore.getAll());

  // Camera paths belong to the dataset that was active when they were made.
  // A replacement must never retain or execute coordinates from the old data.
  function resetCameraPath() {
    if (destroyed) return;
    playbackController.stop({ resetCamera: false });
    loopBackKeyframeId = null;
    if (keyframeStore.getCount() > 0) {
      keyframeStore.clear();
    } else {
      transportBar.updateVisibility({ reveal: false });
    }
    pathWasReady = false;
  }

  const handleDatasetChange = () => resetCameraPath();
  dataSourceManager.onDatasetChange(handleDatasetChange);

  // =========================================================================
  // Session export / restore
  // =========================================================================

  /**
   * The Camera Path's own state: its keyframes and how it plays them (the
   * `camera-path` state domain's value). The navigation mode is the
   * camera's, the navigation settings are settings.
   * @returns {object}
   */
  function exportPath() {
    requireCinematicActive('export its path');
    // A key added since records were first written is left out at its
    // default: a path that never turned captions off saves as before.
    return writeRecordKeys({
      ...keyframeStore.exportAll(),
      loopBackKeyframeId,
      autoplay: dom.autoplayCheckbox.checked,
      captions: dom.captionsCheckbox.checked,
      loopPlayback: dom.loopCheckbox.checked,
      positionMethod: dom.positionInterp.value,
      rotationMethod: dom.rotationInterp.value,
      easing: dom.easingSelect.value,
      defaultSpeed: dom.defaultSpeedInput.value,
    }, CAMERA_PATH_KEYS);
  }

  /**
   * Put the Camera Path's own state back (`exportPath`'s shape). Playback
   * stops; autoplay is a setting here, never a start (`startAutoplay` starts
   * a ready path once a session is loaded).
   * @param {object} data
   */
  function restorePath(data) {
    if (destroyed) return;
    // Read as this version reads it: a key added since is its default.
    data = assertCameraPathState(data);
    playbackController.stop({ resetCamera: false });

    suppressTransportReveal = true;
    loopBackKeyframeId = null;
    try {
      const imported = keyframeStore.importAll({
        keyframes: data.keyframes,
        nextIndex: data.nextIndex
      });
      if (!imported) {
        throw new TypeError('Camera Path keyframes failed exact import.');
      }
      loopBackKeyframeId = data.loopBackKeyframeId;

      dom.positionInterp.value = data.positionMethod;
      dom.rotationInterp.value = data.rotationMethod;
      dom.easingSelect.value = data.easing;
      dom.defaultSpeedInput.value = data.defaultSpeed;
      // Not through the slider's own event: that one is a person's step.
      updateDefaultSpeedDisplay();
      dom.loopCheckbox.checked = data.loopPlayback;
      dom.autoplayCheckbox.checked = data.autoplay;
      dom.captionsCheckbox.checked = data.captions;
      captionOverlay.refresh();

      syncLoopBackState();
      renderKeyframeList();
      pathWasReady = isCameraPathReady(keyframeStore.getAll());
      transportBar.updateVisibility({ reveal: false });
    } finally {
      suppressTransportReveal = false;
    }
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    const failures = [];
    const cleanup = operation => {
      try {
        operation();
      } catch (error) {
        failures.push(error);
      }
    };
    cleanup(() => lifecycleController.abort());
    for (const remove of unprovideActions) cleanup(remove);
    for (const frameId of renderFrameIds) {
      cleanup(() => cancelAnimationFrame(frameId));
    }
    renderFrameIds.clear();
    cleanup(() => keyframeStore.off('changed', handleKeyframeStoreChange));
    cleanup(() => dataSourceManager.offDatasetChange(handleDatasetChange));
    cleanup(() => transportBar.destroy());
    cleanup(() => keyframeStore.off('changed', forgetCaptionTiming));
    cleanup(() => captionOverlay.destroy());
    cleanup(() => playbackController.destroy());

    const exactFailures = [...new Set(failures)];
    if (exactFailures.length === 1) throw exactFailures[0];
    if (exactFailures.length > 1) {
      throw new AggregateError(
        exactFailures,
        'Camera Path failed to release every owned resource.'
      );
    }
  }

  // The camera path actions are this module's while it lives; provided last,
  // so a start that failed leaves none behind.
  const actions = getActions();
  const unprovideActions = [];
  try {
    for (const [type, handler] of Object.entries(handlers)) {
      unprovideActions.push(actions.provide(type, handler));
    }
  } catch (error) {
    for (const remove of unprovideActions) remove();
    throw error;
  }

  return {
    getKeyframeStore: () => {
      requireCinematicActive('publish its keyframe store');
      return keyframeStore;
    },
    getPlaybackController: () => {
      requireCinematicActive('publish its playback controller');
      return playbackController;
    },
    exportPath,
    getNavigationMode: () => {
      requireCinematicActive('read navigation mode');
      return viewer.getNavigationMode();
    },
    restorePath,
    startAutoplay,
    resetCameraPath,
    destroy
  };
}
