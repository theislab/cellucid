/**
 * @fileoverview Camera Path — main UI module.
 *
 * Wires the "Camera Path" accordion: navigation mode controls (mirroring the
 * Compare Views navigation block), save-position button, a unified scrollable
 * keyframe + timing list, interpolation settings, and the viewport transport
 * bar.
 *
 * Follows the same factory-function pattern as camera-controls.js.
 *
 * @module ui/modules/cinematic-camera/index
 */

import {
  createKeyframeStore,
  isValidCameraKeyframe,
  MAX_KEYFRAMES,
  MAX_TRANSITION_DURATION_SECONDS
} from './keyframe-store.js';
import { createPlaybackController } from './playback-controller.js';
import { createTransportBar } from './transport-bar.js';
import { assertCameraPathOptions } from './interpolation-engine.js';
import { getNotificationCenter } from '../../../notification-center.js';
import { assertNavigationMode } from '../../../../rendering/camera-state-contract.js';
import {
  parseIntegerInput,
  parseRangeInput
} from '../../core/numeric-input-contract.js';

// SVG icons (12 × 12, 2 px stroke, matching field-action-btn icons)
const SVG_UP = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>`;
const SVG_DOWN = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
const SVG_GOTO = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const SVG_DELETE = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
const LOOP_BACK_LABEL = '\u21A9 Return to Start';
const CAMERA_PATH_SESSION_KEYS = [
  'defaultSpeed',
  'easing',
  'keyframes',
  'loopBackKeyframeId',
  'loopPlayback',
  'navigationMode',
  'nextIndex',
  'positionMethod',
  'rotationMethod'
];
const REQUIRED_DOM_KEYS = [
  'navModeSelect',
  'orbitControls',
  'planarControls',
  'freeflyControls',
  'orbitKeySpeedInput',
  'orbitKeySpeedDisplay',
  'orbitReverseCheckbox',
  'showOrbitAnchorCheckbox',
  'planarPanSpeedInput',
  'planarPanSpeedDisplay',
  'planarZoomToCursorCheckbox',
  'planarInvertAxesCheckbox',
  'lookSensitivityInput',
  'lookSensitivityDisplay',
  'moveSpeedInput',
  'moveSpeedDisplay',
  'invertLookCheckbox',
  'pointerLockCheckbox',
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
  'loopCheckbox'
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
    data.keyframes.length > MAX_KEYFRAMES ||
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

/**
 * @param {Object} options
 * @param {Object} options.viewer   Viewer API.
 * @param {Object} options.dom      Cached DOM references (cinematicCamera block).
 * @param {Object} options.dataSourceManager Dataset lifecycle source.
 */
export function initCinematicCamera({
  viewer,
  dom,
  dataSourceManager
}) {
  if (!dom || typeof dom !== 'object' || Array.isArray(dom)) {
    throw new TypeError('Camera Path requires a DOM reference object.');
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
  let loopBackKeyframeId = null;
  let suppressTransportReveal = false;

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
    const loopBackActive = hasLoopBackKeyframe();
    if (!enabled) {
      if (!loopBackActive) return;
      const id = loopBackKeyframeId;
      loopBackKeyframeId = null;
      keyframeStore.remove(id);
      return;
    }

    if (loopBackActive || getNonLoopBackCount() < 2) return;

    if (keyframeStore.getCount() >= keyframeStore.MAX_KEYFRAMES) {
      getNotificationCenter().warning(
        `Maximum ${keyframeStore.MAX_KEYFRAMES} keyframes reached.`,
        { category: 'cinematic', duration: 3000 }
      );
      return;
    }

    const first = keyframeStore.getAll().find((kf) => kf.id !== loopBackKeyframeId);
    if (!first) return;
    loopBackKeyframeId = keyframeStore.add(
      { navigationMode: first.navigationMode, orbit: first.orbit, freefly: first.freefly },
      LOOP_BACK_LABEL
    );
  }

  // =========================================================================
  // Navigation controls (mirrors camera-controls.js wiring)
  // =========================================================================

  function toggleNavigationPanels(mode) {
    dom.freeflyControls.style.display = mode === 'free' ? 'block' : 'none';
    dom.orbitControls.style.display = mode === 'orbit' ? 'block' : 'none';
    dom.planarControls.style.display = mode === 'planar' ? 'block' : 'none';
  }

  function syncNavigationMode(mode) {
    assertNavigationMode(mode);
    dom.navModeSelect.value = mode;
    toggleNavigationPanels(mode);
  }

  // Sync dropdown → viewer on change
  dom.navModeSelect.addEventListener('change', () => {
    viewer.setNavigationMode(dom.navModeSelect.value);
    const mode = dom.navModeSelect.value;
    syncNavigationMode(mode);
    dom.navModeSelect.blur();
  });

  // Sync viewer → dropdown on init
  syncNavigationMode(viewer.getNavigationMode());

  // ---- Orbit controls ----

  function updateOrbitKeySpeed() {
    const rawValue = parseRangeInput(dom.orbitKeySpeedInput.value, {
      minimum: 1,
      maximum: 100,
      label: 'Camera Path orbit keyboard speed'
    });
    const value = rawValue / 100;
    dom.orbitKeySpeedDisplay.textContent = value.toFixed(2) + 'x';
    viewer.setOrbitKeySpeed(value);
  }

  updateOrbitKeySpeed();
  dom.orbitKeySpeedInput.addEventListener('input', updateOrbitKeySpeed);

  viewer.setOrbitInvertRotation(dom.orbitReverseCheckbox.checked);
  dom.orbitReverseCheckbox.addEventListener('change', () => {
    viewer.setOrbitInvertRotation(dom.orbitReverseCheckbox.checked);
  });

  viewer.setShowOrbitAnchor(dom.showOrbitAnchorCheckbox.checked);
  dom.showOrbitAnchorCheckbox.addEventListener('change', () => {
    viewer.setShowOrbitAnchor(dom.showOrbitAnchorCheckbox.checked);
  });

  // ---- Planar controls ----

  function updatePlanarPanSpeed() {
    const rawValue = parseRangeInput(dom.planarPanSpeedInput.value, {
      minimum: 1,
      maximum: 100,
      label: 'Camera Path planar keyboard pan speed'
    });
    const t = (rawValue - 1) / 99;
    const value = 0.001 + t * (0.0075 - 0.001);
    dom.planarPanSpeedDisplay.textContent = value.toFixed(4) + 'x';
    viewer.setPlanarPanSpeed(value);
  }

  updatePlanarPanSpeed();
  dom.planarPanSpeedInput.addEventListener('input', updatePlanarPanSpeed);

  viewer.setPlanarZoomToCursor(dom.planarZoomToCursorCheckbox.checked);
  dom.planarZoomToCursorCheckbox.addEventListener('change', () => {
    viewer.setPlanarZoomToCursor(dom.planarZoomToCursorCheckbox.checked);
  });

  viewer.setPlanarInvertAxes(dom.planarInvertAxesCheckbox.checked);
  dom.planarInvertAxesCheckbox.addEventListener('change', () => {
    viewer.setPlanarInvertAxes(dom.planarInvertAxesCheckbox.checked);
  });

  // ---- Free-fly controls ----

  function updateLookSensitivity() {
    const v = parseRangeInput(dom.lookSensitivityInput.value, {
      minimum: 1,
      maximum: 30,
      label: 'Camera Path look sensitivity'
    });
    const sensitivity = v * 0.0005;
    dom.lookSensitivityDisplay.textContent = (v / 100).toFixed(2) + 'x';
    viewer.setLookSensitivity(sensitivity);
  }

  function updateMoveSpeed() {
    const v = parseRangeInput(dom.moveSpeedInput.value, {
      minimum: 1,
      maximum: 500,
      label: 'Camera Path move speed'
    });
    const speed = v / 100;
    dom.moveSpeedDisplay.textContent = speed.toFixed(2) + ' u/s';
    viewer.setMoveSpeed(speed);
  }

  updateLookSensitivity();
  dom.lookSensitivityInput.addEventListener('input', updateLookSensitivity);

  updateMoveSpeed();
  dom.moveSpeedInput.addEventListener('input', updateMoveSpeed);

  const applyInvertLook = (value) => {
    viewer.setInvertLookY(value);
    viewer.setInvertLookX(value);
  };
  applyInvertLook(dom.invertLookCheckbox.checked);
  dom.invertLookCheckbox.addEventListener('change', () => {
    applyInvertLook(dom.invertLookCheckbox.checked);
  });

  dom.pointerLockCheckbox.checked = false;
  dom.pointerLockCheckbox.addEventListener('change', () => {
    const mode = dom.navModeSelect.value;
    if (mode !== 'free') {
      dom.pointerLockCheckbox.checked = false;
      return;
    }
    viewer.setPointerLockEnabled(dom.pointerLockCheckbox.checked);
  });

  // =========================================================================
  // Default speed slider
  // =========================================================================

  let autoPaceSpeed = sliderToAutoPaceSpeed(dom.defaultSpeedInput.value);

  function updateDefaultSpeedDisplay() {
    const raw = parseRangeInput(dom.defaultSpeedInput.value, {
      minimum: 1,
      maximum: 100,
      label: 'Camera path default speed'
    });
    autoPaceSpeed = sliderToAutoPaceSpeed(dom.defaultSpeedInput.value);
    dom.defaultSpeedDisplay.textContent = speedLabel(raw);
  }

  updateDefaultSpeedDisplay();
  dom.defaultSpeedInput.addEventListener('input', updateDefaultSpeedDisplay);

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
  playbackController.on('stateChange', (newState) => {
    if (newState === 'STOPPED' && dom.navModeSelect) {
      syncNavigationMode(viewer.getNavigationMode());
    }
  });

  // =========================================================================
  // Save Position
  // =========================================================================

  dom.saveBtn.addEventListener('click', () => {
    const loopBackWasActive = hasLoopBackKeyframe();
    if (keyframeStore.getCount() >= keyframeStore.MAX_KEYFRAMES) {
      getNotificationCenter().warning(
        `Maximum ${keyframeStore.MAX_KEYFRAMES} keyframes reached.`,
        { category: 'cinematic', duration: 3000 }
      );
      return;
    }

    // Capture the viewer's current camera state (uses whatever mode is active)
    const newId = keyframeStore.add(viewer.getCameraState());
    if (loopBackWasActive && newId) {
      keyframeStore.reorder(newId, -1);
    }
  });

  // =========================================================================
  // Clear All
  // =========================================================================

  dom.clearBtn.addEventListener('click', () => {
    if (keyframeStore.getCount() === 0) return;
    playbackController.stop({ resetCamera: true });
    keyframeStore.clear();
  });

  // =========================================================================
  // Set All Timing
  // =========================================================================

  dom.setAllBtn.addEventListener('click', () => {
    const raw = dom.setAllDuration.value;
    const value = raw === ''
      ? null
      : parseRangeInput(raw, {
          minimum: 0.1,
          maximum: MAX_TRANSITION_DURATION_SECONDS,
          label: 'Camera Path transition duration'
        });
    keyframeStore.setAllDurations(value);
  });

  // =========================================================================
  // Unified keyframe + timing list rendering
  // =========================================================================

  function renderKeyframeList() {
    const listEl = dom.keyframeList;
    if (!listEl) return;

    const keyframes = keyframeStore.getAll();
    const hasLoopBack = hasLoopBackKeyframe();
    const nonLoopBackCount = getNonLoopBackCount();

    if (keyframes.length === 0) {
      listEl.innerHTML = '<div class="cinematic-empty-state">No keyframes saved yet.</div>';
      if (dom.timingActions) dom.timingActions.style.display = 'none';
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
    <button class="cinematic-kf-btn" data-action="up" title="Move up"${i === 0 ? ' disabled' : ''}>${SVG_UP}</button>
    <button class="cinematic-kf-btn" data-action="down" title="Move down"${i >= lastMovableIndex ? ' disabled' : ''}>${SVG_DOWN}</button>
    <button class="cinematic-kf-btn" data-action="goto" title="Go to position">${SVG_GOTO}</button>
    <button class="cinematic-kf-btn cinematic-kf-delete" data-action="delete" title="Delete">${SVG_DELETE}</button>
  </div>`;
      html += `<div class="cinematic-keyframe-item${isLoopBack ? ' cinematic-keyframe-item-loopback' : ''}" data-id="${escapeHtml(kf.id)}">
  <span class="cinematic-keyframe-index">${i + 1}</span>
  <span class="cinematic-keyframe-label${isLoopBack ? ' cinematic-keyframe-label-static' : ''}"${isLoopBack ? '' : ' data-action="rename" title="Click to rename"'}>${escapeHtml(kf.label)}</span>
  ${actionButtons}
</div>`;

      // Insert timing row between consecutive keyframes
      if (i < keyframes.length - 1) {
        const dur = kf.transitionDuration;
        const val = dur != null ? dur : '';
        html += `<div class="cinematic-timing-row" data-pair="${i}">
  <span class="cinematic-timing-label">${escapeHtml(kf.label)} → ${escapeHtml(keyframes[i + 1].label)}</span>
  <input type="number" class="cinematic-duration-input" min="0.1" max="60" step="0.1"
         value="${val}" placeholder="auto" data-pair-index="${i}" title="Duration in seconds (leave empty for auto)" />
  <span class="cinematic-timing-unit">s</span>
</div>`;
      }
    }
    if (nonLoopBackCount >= 2) {
      html += `<div class="cinematic-loopback-row">
  <span class="cinematic-loopback-row-label">${LOOP_BACK_LABEL}</span>
  <input type="checkbox" class="cinematic-loopback-list-toggle" aria-label="Toggle return to start keyframe"${hasLoopBack ? ' checked' : ''} />
</div>`;
    }
    listEl.innerHTML = html;

    // Show the "Set all" actions row when ≥ 2 keyframes
    if (dom.timingActions) {
      dom.timingActions.style.display = keyframes.length >= 2 ? '' : 'none';
    }

    // Toggle scroll-fade mask only when content overflows
    requestAnimationFrame(() => {
      listEl.classList.toggle('is-scrollable', listEl.scrollHeight > listEl.clientHeight);
    });
  }

  // =========================================================================
  // Keyframe list event delegation
  // =========================================================================

  if (dom.keyframeList) {
    dom.keyframeList.addEventListener('click', (e) => {
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
    dom.keyframeList.addEventListener('change', (e) => {
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
        maximum: keyframeStore.MAX_KEYFRAMES - 1,
        label: 'Camera Path keyframe pair index'
      });
      const raw = input.value;
      const value = raw === ''
        ? null
        : parseRangeInput(raw, {
            minimum: 0.1,
            maximum: MAX_TRANSITION_DURATION_SECONDS,
            label: 'Camera Path transition duration'
          });
      keyframeStore.setDuration(pairIndex, value);
    });
  }

  // =========================================================================
  // Inline rename
  // =========================================================================

  function startInlineRename(itemEl, kfId, labelEl) {
    if (itemEl.querySelector('.cinematic-keyframe-rename')) return;

    const kf = keyframeStore.getById(kfId);
    if (!kf) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cinematic-keyframe-rename';
    input.value = kf.label;
    input.maxLength = 40;

    labelEl.style.display = 'none';
    labelEl.parentElement.insertBefore(input, labelEl.nextSibling);
    input.focus();
    input.select();

    const commit = () => {
      const newLabel = input.value.trim();
      if (newLabel && newLabel !== kf.label) {
        keyframeStore.rename(kfId, newLabel);
      } else {
        labelEl.style.display = '';
        input.remove();
      }
    };

    input.addEventListener('blur', commit, { once: true });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        labelEl.style.display = '';
        input.removeEventListener('blur', commit);
        input.remove();
      }
    });
  }

  // =========================================================================
  // React to keyframe store changes
  // =========================================================================

  function handleKeyframeStoreChange() {
    if (!syncLoopBackState()) return;
    renderKeyframeList();
    transportBar.updateVisibility({ reveal: !suppressTransportReveal });
  }

  keyframeStore.on('changed', handleKeyframeStoreChange);

  // =========================================================================
  // Initial render
  // =========================================================================

  syncLoopBackState();
  renderKeyframeList();

  // Camera paths belong to the dataset that was active when they were made.
  // A replacement must never retain or execute coordinates from the old data.
  function resetCameraPath() {
    playbackController.stop({ resetCamera: false });
    loopBackKeyframeId = null;
    if (keyframeStore.getCount() > 0) {
      keyframeStore.clear();
    } else {
      transportBar.updateVisibility({ reveal: false });
    }
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
    return {
      ...keyframeStore.exportAll(),
      loopBackKeyframeId,
      // Interpolation & playback settings
      loopPlayback: dom.loopCheckbox.checked,
      positionMethod: dom.positionInterp.value,
      rotationMethod: dom.rotationInterp.value,
      easing: dom.easingSelect.value,
      defaultSpeed: dom.defaultSpeedInput.value,
      // Navigation mode
      navigationMode: viewer.getNavigationMode()
    };
  }

  /**
   * Restore cinematic camera state from a session snapshot.
   * @param {object} data
   */
  function restoreSessionState(data) {
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
      viewer.setNavigationMode(data.navigationMode);
      syncNavigationMode(data.navigationMode);

      syncLoopBackState();
      renderKeyframeList();
      // A restored path is available, but stays idle and out of the way until
      // the user explicitly reveals and starts it.
      transportBar.updateVisibility({ reveal: false });
    } finally {
      suppressTransportReveal = false;
    }
  }

  function destroy() {
    keyframeStore.off('changed', handleKeyframeStoreChange);
    dataSourceManager.offDatasetChange(handleDatasetChange);
    transportBar.destroy();
    playbackController.destroy();
  }

  return {
    getKeyframeStore: () => keyframeStore,
    getPlaybackController: () => playbackController,
    exportSessionState,
    restoreSessionState,
    syncNavigationMode,
    resetCameraPath,
    destroy
  };
}

// ---- Helpers ----

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
