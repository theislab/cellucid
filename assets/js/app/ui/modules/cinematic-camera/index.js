/**
 * @fileoverview Camera Path — main UI module.
 *
 * Wires the "Camera path" accordion: the save-position button, a unified
 * scrollable keyframe + timing list, playback settings, and the viewport
 * transport bar. Navigation itself lives in the Navigation panel; a keyframe
 * goto, playback and a restore move the mode through that panel's
 * `syncNavigationMode`, and the navigation settings a path records are read
 * and restored through its `exportSettings` / `restoreSettings`.
 *
 * Follows the same factory-function pattern as camera-controls.js.
 *
 * @module ui/modules/cinematic-camera/index
 */

import { representationName } from '../../../../data/representation-names.js';
import {
  createKeyframeStore,
  isCameraPathReady,
  isValidCameraKeyframe,
  MIN_TRANSITION_DURATION_SECONDS
} from './keyframe-store.js';
import {
  createPlaybackController,
  prefersReducedMotion
} from './playback-controller.js';
import { createTransportBar } from './transport-bar.js';
import { assertCameraPathOptions } from './interpolation-engine.js';
import { getNotificationCenter } from '../../../notification-center.js';
import {
  assertCameraState,
  assertNavigationMode,
  cloneCameraState
} from '../../../../rendering/camera-state-contract.js';
import {
  parseIntegerInput,
  parseRangeInput
} from '../../core/numeric-input-contract.js';
import { escapeHtml } from '../../../utils/dom-utils.js';
import { ICONS } from '../../components/controls.js';

// Keyframe action glyphs. They are drawn at the shared icon-button size
// (`.icon-btn svg`); delete uses the one shared delete glyph.
const SVG_UP = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="18 15 12 9 6 15"/></svg>`;
const SVG_DOWN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>`;
const SVG_GOTO = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const SVG_DELETE = ICONS.delete.replace('<svg ', '<svg aria-hidden="true" ');
const LOOP_BACK_LABEL = '\u21A9 Return to start';
const CAMERA_PATH_SESSION_KEYS = [
  'autoplay',
  'defaultSpeed',
  'easing',
  'invertLook',
  'keyframes',
  'lookSensitivity',
  'loopBackKeyframeId',
  'loopPlayback',
  'moveSpeed',
  'navigationMode',
  'nextIndex',
  'orbitKeySpeed',
  'orbitReverse',
  'planarInvertAxes',
  'planarPanSpeed',
  'planarZoomToCursor',
  'positionMethod',
  'rotationMethod',
  'showOrbitAnchor'
];
const PLAYBACK_SNAPSHOT_KEYS = ['camera', 'globalT', 'state'];
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
  'autoplayCheckbox'
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

export function assertCameraPathSessionState(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new TypeError('Camera Path session state must be an object.');
  }
  const keys = Object.keys(data).sort();
  if (
    keys.length !== CAMERA_PATH_SESSION_KEYS.length ||
    keys.some((key, index) => key !== CAMERA_PATH_SESSION_KEYS[index])
  ) {
    throw new TypeError(
      `Camera Path session state must contain exactly ${CAMERA_PATH_SESSION_KEYS.join(', ')}.`
    );
  }
  if (
    !Array.isArray(data.keyframes) ||
    !data.keyframes.every(isValidCameraKeyframe)
  ) {
    throw new TypeError('Camera Path session state contains invalid keyframes.');
  }
  const ids = new Set(data.keyframes.map(({ id }) => id));
  if (ids.size !== data.keyframes.length) {
    throw new TypeError('Camera Path session keyframe ids must be unique.');
  }
  if (!Number.isInteger(data.nextIndex) || data.nextIndex <= 0) {
    throw new TypeError('Camera Path session nextIndex must be a positive integer.');
  }
  if (typeof data.defaultSpeed !== 'string') {
    throw new TypeError('Camera Path session defaultSpeed must be a range-input string.');
  }
  if (typeof data.autoplay !== 'boolean') {
    throw new TypeError('Camera Path session autoplay must be boolean.');
  }
  for (const booleanKey of [
    'invertLook',
    'orbitReverse',
    'planarInvertAxes',
    'planarZoomToCursor',
    'showOrbitAnchor'
  ]) {
    if (typeof data[booleanKey] !== 'boolean') {
      throw new TypeError(`Camera Path session ${booleanKey} must be boolean.`);
    }
  }
  parseRangeInput(data.orbitKeySpeed, {
    minimum: 1,
    maximum: 100,
    label: 'Camera Path session orbit keyboard speed'
  });
  parseRangeInput(data.planarPanSpeed, {
    minimum: 1,
    maximum: 100,
    label: 'Camera Path session planar keyboard speed'
  });
  parseRangeInput(data.lookSensitivity, {
    minimum: 1,
    maximum: 30,
    label: 'Camera Path session look sensitivity'
  });
  parseRangeInput(data.moveSpeed, {
    minimum: 1,
    maximum: 500,
    label: 'Camera Path session move speed'
  });
  assertCameraPathOptions({
    positionMethod: data.positionMethod,
    rotationMethod: data.rotationMethod,
    easing: data.easing,
    loop: data.loopPlayback,
    autoPaceSpeed: sliderToAutoPaceSpeed(data.defaultSpeed)
  });
  assertNavigationMode(data.navigationMode);

  if (data.loopBackKeyframeId !== null) {
    if (
      typeof data.loopBackKeyframeId !== 'string' ||
      data.keyframes.length < 3 ||
      data.keyframes[data.keyframes.length - 1].id !== data.loopBackKeyframeId
    ) {
      throw new TypeError(
        'Camera Path session loopBackKeyframeId must be null or identify the final keyframe of a complete loop.'
      );
    }
  }
  return data;
}

export function assertCameraPathPlaybackSnapshot(value) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
  ) {
    throw new TypeError('Camera Path playback snapshot must be an object.');
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== PLAYBACK_SNAPSHOT_KEYS.length
    || keys.some((key, index) => key !== PLAYBACK_SNAPSHOT_KEYS[index])
  ) {
    throw new TypeError(
      'Camera Path playback snapshot must contain exact camera, globalT, and state keys.'
    );
  }
  if (
    value.state !== 'STOPPED'
    && value.state !== 'PLAYING'
    && value.state !== 'PAUSED'
  ) {
    throw new TypeError('Camera Path playback snapshot state is invalid.');
  }
  if (
    !Number.isFinite(value.globalT)
    || value.globalT < 0
    || value.globalT > 1
    || (value.state === 'STOPPED' && value.globalT !== 0)
  ) {
    throw new RangeError(
      'Camera Path playback snapshot globalT must match its exact playback state.'
    );
  }
  assertCameraState(value.camera, 'Camera Path playback snapshot camera');
  return value;
}

/**
 * @param {Object} options
 * @param {Object} options.viewer   Viewer API.
 * @param {Object} options.dom      Cached DOM references (cinematicCamera block).
 * @param {Object} options.navigation The Navigation panel (camera-controls.js):
 *   `syncNavigationMode`, `exportSettings`, `restoreSettings`.
 * @param {Object} options.dataSourceManager Dataset lifecycle source.
 */
export function initCinematicCamera({
  viewer,
  dom,
  navigation,
  dataSourceManager,
  focusedRepresentation
}) {
  if (typeof focusedRepresentation !== 'function') {
    throw new TypeError(
      'Camera Path requires focusedRepresentation(): the embedding the focused view shows.'
    );
  }
  if (!dom || typeof dom !== 'object' || Array.isArray(dom)) {
    throw new TypeError('Camera Path requires a DOM reference object.');
  }
  for (const method of ['syncNavigationMode', 'exportSettings', 'restoreSettings']) {
    if (typeof navigation?.[method] !== 'function') {
      throw new TypeError(`Camera Path requires the Navigation panel's ${method}().`);
    }
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
  listen(dom.defaultSpeedInput, 'input', updateDefaultSpeedDisplay);

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
    const recordedName = representationName({
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

  function stopAutoplay() {
    if (destroyed) return;
    if (playbackController.getState() !== 'STOPPED') {
      playbackController.stop({ resetCamera: false });
    }
  }

  function capturePlaybackSnapshot() {
    requireCinematicActive('capture playback');
    if (typeof viewer.getCameraState !== 'function') {
      throw new TypeError(
        'Camera Path playback snapshot requires viewer.getCameraState().'
      );
    }
    return {
      state: playbackController.getState(),
      globalT: playbackController.getProgress(),
      camera: cloneCameraState(
        viewer.getCameraState(),
        'Camera Path playback snapshot camera'
      )
    };
  }

  function restorePlaybackSnapshot(snapshot) {
    if (destroyed) return;
    const exact = assertCameraPathPlaybackSnapshot(snapshot);
    stopAutoplay();
    // A reduced-motion preference completes a path instead of animating it, so
    // playback is never live and there is no transport state to resume. The
    // exact saved camera is still published below.
    if (exact.state !== 'STOPPED' && !prefersReducedMotion()) {
      if (!isCameraPathReady(keyframeStore.getAll())) {
        throw new Error(
          'Camera Path playback restore requires a complete path.'
        );
      }
      transportBar.updateVisibility({ reveal: true });
      playbackController.play();
      playbackController.seekTo(exact.globalT);
      if (exact.state === 'PAUSED') playbackController.pause();
    }
    viewer.setCameraState(
      cloneCameraState(
        exact.camera,
        'Camera Path playback restore camera'
      )
    );
  }

  listen(dom.autoplayCheckbox, 'change', () => {
    if (dom.autoplayCheckbox.checked) {
      startAutoplay();
    }
  });

  // =========================================================================
  // Save Position
  // =========================================================================

  listen(dom.saveBtn, 'click', () => {
    const loopBackWasActive = hasLoopBackKeyframe();

    // Capture the viewer's current camera state (uses whatever mode is active)
    const newId = keyframeStore.add(
      viewer.getCameraState(),
      undefined,
      focusedRepresentation()?.ref ?? null
    );
    if (loopBackWasActive && newId) {
      keyframeStore.reorder(newId, -1);
    }
  });

  // =========================================================================
  // Clear All
  // =========================================================================

  listen(dom.clearBtn, 'click', () => {
    if (keyframeStore.getCount() === 0) return;
    playbackController.stop({ resetCamera: true });
    keyframeStore.clear();
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
    let value;
    try {
      if (input.validity?.badInput) {
        throw new TypeError('Camera Path transition duration must be a number.');
      }
      value = input.value === ''
        ? null
        : parseRangeInput(input.value, {
            minimum: MIN_TRANSITION_DURATION_SECONDS,
            // No longest transition: any finite number of seconds.
            maximum: Number.MAX_VALUE,
            label: 'Camera Path transition duration'
          });
    } catch (error) {
      if (!(error instanceof RangeError || error instanceof TypeError)) {
        throw error;
      }
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

  // A rejected entry stays flagged only until the viewer edits it again.
  listen(dom.setAllDuration, 'input', () => {
    dom.setAllDuration.setCustomValidity('');
  });

  listen(dom.setAllBtn, 'click', () => {
    const duration = readTransitionDurationInput(dom.setAllDuration, '');
    if (!duration.valid) return;
    keyframeStore.setAllDurations(duration.value);
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

      // Insert timing row between consecutive keyframes
      if (i < keyframes.length - 1) {
        const dur = kf.transitionDuration;
        const val = dur != null ? dur : '';
        html += `<div class="cinematic-timing-row" data-pair="${i}">
  <span class="cinematic-timing-label" title="${escapeHtml(kf.label)} → ${escapeHtml(keyframes[i + 1].label)}">${escapeHtml(kf.label)} → ${escapeHtml(keyframes[i + 1].label)}</span>
  <input type="number" class="obs-select cinematic-duration-input" min="0.1" step="0.1"
         value="${val}" placeholder="auto" data-pair-index="${i}" title="Duration in seconds (leave empty for auto)" />
  <span class="cinematic-timing-unit">s</span>
</div>`;
      }
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

      if (action === 'delete') {
        if (isLoopBack) return;
        keyframeStore.remove(id);
      } else if (action === 'up') {
        if (isLoopBack) return;
        keyframeStore.reorder(id, -1);
      } else if (action === 'down') {
        if (isLoopBack) return;
        const all = keyframeStore.getAll();
        const idx = all.findIndex((kf) => kf.id === id);
        const maxDownIndex = all.length - 1 - (hasLoopBackKeyframe() ? 1 : 0);
        if (idx >= maxDownIndex) return;
        keyframeStore.reorder(id, 1);
      } else if (action === 'goto') {
        const kf = keyframeStore.getById(id);
        if (kf) {
          viewer.setCameraState({
            navigationMode: kf.navigationMode,
            orbit: kf.orbit,
            freefly: kf.freefly
          });
          // Keep the navigation dropdown and sub-panels in sync with the
          // keyframe's mode so the user sees the correct controls after goto.
          syncNavigationMode(kf.navigationMode);
        }
      } else if (action === 'rename') {
        if (isLoopBack) return;
        startInlineRename(item, id, actionEl);
      }
    });

    // Timing input changes (event delegation on the same list)
    listen(dom.keyframeList, 'change', (e) => {
      const loopBackToggle = e.target.closest('.cinematic-loopback-list-toggle');
      if (loopBackToggle) {
        setLoopBackEnabled(loopBackToggle.checked);
        // keyframeStore.add emits before loopBackKeyframeId is assigned, so force
        // a final render here to avoid the "double click to activate" behavior.
        renderKeyframeList();
        return;
      }
      const input = e.target.closest('.cinematic-duration-input');
      if (!input) return;
      const pairIndex = parseIntegerInput(input.dataset.pairIndex, {
        minimum: 0,
        maximum: Math.max(0, keyframeStore.getCount() - 2),
        label: 'Camera Path keyframe pair index'
      });
      const stored = keyframeStore.getAll()[pairIndex]?.transitionDuration;
      const duration = readTransitionDurationInput(
        input,
        stored == null ? '' : String(stored)
      );
      if (!duration.valid) return;
      keyframeStore.setDuration(pairIndex, duration.value);
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

    // A committed rename rebuilds the list while the input still holds focus,
    // so the rebuild returns focus to the renamed keyframe's label. Every
    // other ending puts focus back on the label explicitly.
    const commit = ({ focusLabel }) => {
      const newLabel = input.value.trim();
      if (newLabel && newLabel !== kf.label) {
        keyframeStore.rename(kfId, newLabel);
        return;
      }
      labelEl.hidden = false;
      if (focusLabel) labelEl.focus({ preventScroll: true });
      input.remove();
    };

    const ownedCommit = listen(
      input,
      'blur',
      () => commit({ focusLabel: false }),
      { once: true }
    );
    listen(input, 'keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.removeEventListener('blur', ownedCommit);
        commit({ focusLabel: true });
      } else if (e.key === 'Escape') {
        e.preventDefault();
        input.removeEventListener('blur', ownedCommit);
        labelEl.hidden = false;
        labelEl.focus({ preventScroll: true });
        input.remove();
      }
    });
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
   * Export all cinematic camera state for session serialization.
   * @returns {object}
   */
  function exportSessionState() {
    requireCinematicActive('export session state');
    return {
      ...keyframeStore.exportAll(),
      loopBackKeyframeId,
      // Interpolation & playback settings
      autoplay: dom.autoplayCheckbox.checked,
      loopPlayback: dom.loopCheckbox.checked,
      positionMethod: dom.positionInterp.value,
      rotationMethod: dom.rotationInterp.value,
      easing: dom.easingSelect.value,
      defaultSpeed: dom.defaultSpeedInput.value,
      // Navigation interaction settings
      ...navigation.exportSettings(),
      // Navigation mode
      navigationMode: viewer.getNavigationMode()
    };
  }

  /**
   * Restore cinematic camera state from a session snapshot.
   * @param {object} data
   */
  function restoreSessionState(data) {
    if (destroyed) return;
    assertCameraPathSessionState(data);
    playbackController.stop({ resetCamera: false });

    suppressTransportReveal = true;
    loopBackKeyframeId = null;
    try {
      const imported = keyframeStore.importAll({
        keyframes: data.keyframes,
        nextIndex: data.nextIndex
      });
      if (!imported) {
        throw new TypeError('Camera Path session keyframes failed exact import.');
      }
      loopBackKeyframeId = data.loopBackKeyframeId;

      dom.positionInterp.value = data.positionMethod;
      dom.rotationInterp.value = data.rotationMethod;
      dom.easingSelect.value = data.easing;
      dom.defaultSpeedInput.value = data.defaultSpeed;
      dom.defaultSpeedInput.dispatchEvent(new Event('input', { bubbles: true }));
      dom.loopCheckbox.checked = data.loopPlayback;
      dom.autoplayCheckbox.checked = data.autoplay;
      viewer.setNavigationMode(data.navigationMode);
      syncNavigationMode(data.navigationMode);

      navigation.restoreSettings(data);

      syncLoopBackState();
      renderKeyframeList();
      pathWasReady = isCameraPathReady(keyframeStore.getAll());
      // The session transaction starts enabled autoplay only after every
      // session chunk has restored successfully.
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
    for (const frameId of renderFrameIds) {
      cleanup(() => cancelAnimationFrame(frameId));
    }
    renderFrameIds.clear();
    cleanup(() => keyframeStore.off('changed', handleKeyframeStoreChange));
    cleanup(() => dataSourceManager.offDatasetChange(handleDatasetChange));
    cleanup(() => transportBar.destroy());
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

  return {
    getKeyframeStore: () => {
      requireCinematicActive('publish its keyframe store');
      return keyframeStore;
    },
    getPlaybackController: () => {
      requireCinematicActive('publish its playback controller');
      return playbackController;
    },
    exportSessionState,
    capturePlaybackSnapshot,
    getNavigationMode: () => {
      requireCinematicActive('read navigation mode');
      return viewer.getNavigationMode();
    },
    restoreSessionState,
    restorePlaybackSnapshot,
    startAutoplay,
    stopAutoplay,
    resetCameraPath,
    destroy
  };
}
