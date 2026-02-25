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

import { createKeyframeStore } from './keyframe-store.js';
import { createPlaybackController } from './playback-controller.js';
import { createTransportBar } from './transport-bar.js';
import { getNotificationCenter } from '../../../notification-center.js';
import { clamp } from '../../../utils/number-utils.js';

// SVG icons (12 × 12, 2 px stroke, matching field-action-btn icons)
const SVG_UP = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>`;
const SVG_DOWN = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
const SVG_GOTO = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const SVG_DELETE = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
const LOOP_BACK_LABEL = '\u21A9 Return to Start';

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
  const v = clamp(parseFloat(raw) || 30, 1, 100);
  // Exponential mapping for a nice feel
  return 0.1 * Math.pow(40, v / 100);
}

/**
 * @param {Object} options
 * @param {Object} options.viewer   Viewer API.
 * @param {Object} options.dom      Cached DOM references (cinematicCamera block).
 */
export function initCinematicCamera({ viewer, dom }) {
  if (!dom?.saveBtn) return {};

  const keyframeStore = createKeyframeStore();
  let loopBackKeyframeId = null;

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
    if (dom.freeflyControls) dom.freeflyControls.style.display = mode === 'free' ? 'block' : 'none';
    if (dom.orbitControls) dom.orbitControls.style.display = mode === 'orbit' ? 'block' : 'none';
    if (dom.planarControls) dom.planarControls.style.display = mode === 'planar' ? 'block' : 'none';
  }

  if (dom.navModeSelect) {
    // Sync dropdown → viewer on change
    dom.navModeSelect.addEventListener('change', () => {
      const mode = dom.navModeSelect.value === 'free' ? 'free' : (dom.navModeSelect.value === 'planar' ? 'planar' : 'orbit');
      viewer.setNavigationMode?.(mode);
      toggleNavigationPanels(mode);
      dom.navModeSelect.blur();
    });

    // Sync viewer → dropdown on init
    const startMode = viewer.getNavigationMode?.() || 'orbit';
    dom.navModeSelect.value = startMode;
    toggleNavigationPanels(startMode);
  }

  // ---- Orbit controls ----

  function updateOrbitKeySpeed() {
    if (!dom.orbitKeySpeedInput) return;
    const value = parseFloat(dom.orbitKeySpeedInput.value) / 100;
    if (dom.orbitKeySpeedDisplay) dom.orbitKeySpeedDisplay.textContent = value.toFixed(2) + 'x';
    viewer.setOrbitKeySpeed?.(value);
  }

  if (dom.orbitKeySpeedInput) {
    updateOrbitKeySpeed();
    dom.orbitKeySpeedInput.addEventListener('input', updateOrbitKeySpeed);
  }

  if (dom.orbitReverseCheckbox && viewer.setOrbitInvertRotation) {
    viewer.setOrbitInvertRotation(Boolean(dom.orbitReverseCheckbox.checked));
    dom.orbitReverseCheckbox.addEventListener('change', () => {
      viewer.setOrbitInvertRotation(Boolean(dom.orbitReverseCheckbox.checked));
    });
  }

  if (dom.showOrbitAnchorCheckbox && viewer.setShowOrbitAnchor) {
    viewer.setShowOrbitAnchor(Boolean(dom.showOrbitAnchorCheckbox.checked));
    dom.showOrbitAnchorCheckbox.addEventListener('change', () => {
      viewer.setShowOrbitAnchor(Boolean(dom.showOrbitAnchorCheckbox.checked));
    });
  }

  // ---- Planar controls ----

  function updatePlanarPanSpeed() {
    if (!dom.planarPanSpeedInput) return;
    const t = (parseFloat(dom.planarPanSpeedInput.value) - 1) / 99;
    const value = 0.001 + t * (0.0075 - 0.001);
    if (dom.planarPanSpeedDisplay) dom.planarPanSpeedDisplay.textContent = value.toFixed(4) + 'x';
    viewer.setPlanarPanSpeed?.(value);
  }

  if (dom.planarPanSpeedInput) {
    updatePlanarPanSpeed();
    dom.planarPanSpeedInput.addEventListener('input', updatePlanarPanSpeed);
  }

  if (dom.planarZoomToCursorCheckbox && viewer.setPlanarZoomToCursor) {
    viewer.setPlanarZoomToCursor(Boolean(dom.planarZoomToCursorCheckbox.checked));
    dom.planarZoomToCursorCheckbox.addEventListener('change', () => {
      viewer.setPlanarZoomToCursor(Boolean(dom.planarZoomToCursorCheckbox.checked));
    });
  }

  if (dom.planarInvertAxesCheckbox && viewer.setPlanarInvertAxes) {
    viewer.setPlanarInvertAxes(Boolean(dom.planarInvertAxesCheckbox.checked));
    dom.planarInvertAxesCheckbox.addEventListener('change', () => {
      viewer.setPlanarInvertAxes(Boolean(dom.planarInvertAxesCheckbox.checked));
    });
  }

  // ---- Free-fly controls ----

  function updateLookSensitivity() {
    if (!dom.lookSensitivityInput) return;
    const v = clamp(parseFloat(dom.lookSensitivityInput.value) || 5, 1, 30);
    const sensitivity = v * 0.0005;
    if (dom.lookSensitivityDisplay) dom.lookSensitivityDisplay.textContent = (v / 100).toFixed(2) + 'x';
    viewer.setLookSensitivity?.(sensitivity);
  }

  function updateMoveSpeed() {
    if (!dom.moveSpeedInput) return;
    const v = clamp(parseFloat(dom.moveSpeedInput.value) || 100, 1, 500);
    const speed = v / 100;
    if (dom.moveSpeedDisplay) dom.moveSpeedDisplay.textContent = speed.toFixed(2) + ' u/s';
    viewer.setMoveSpeed?.(speed);
  }

  if (dom.lookSensitivityInput) {
    updateLookSensitivity();
    dom.lookSensitivityInput.addEventListener('input', updateLookSensitivity);
  }

  if (dom.moveSpeedInput) {
    updateMoveSpeed();
    dom.moveSpeedInput.addEventListener('input', updateMoveSpeed);
  }

  if (dom.invertLookCheckbox && viewer.setInvertLook) {
    const setY = viewer.setInvertLookY || viewer.setInvertLook;
    const setX = viewer.setInvertLookX || viewer.setInvertLook;
    const apply = (val) => { setY.call(viewer, val); setX.call(viewer, val); };
    apply(Boolean(dom.invertLookCheckbox.checked));
    dom.invertLookCheckbox.addEventListener('change', () => {
      apply(Boolean(dom.invertLookCheckbox.checked));
    });
  }

  if (dom.pointerLockCheckbox && viewer.setPointerLockEnabled) {
    dom.pointerLockCheckbox.checked = false;
    dom.pointerLockCheckbox.addEventListener('change', () => {
      const mode = dom.navModeSelect?.value;
      if (mode !== 'free') {
        dom.pointerLockCheckbox.checked = false;
        return;
      }
      viewer.setPointerLockEnabled(Boolean(dom.pointerLockCheckbox.checked));
    });
  }

  // =========================================================================
  // Default speed slider
  // =========================================================================

  let autoPaceSpeed = sliderToAutoPaceSpeed(dom.defaultSpeedInput?.value ?? 30);

  function updateDefaultSpeedDisplay() {
    if (!dom.defaultSpeedInput) return;
    const raw = parseFloat(dom.defaultSpeedInput.value) || 30;
    autoPaceSpeed = sliderToAutoPaceSpeed(raw);
    if (dom.defaultSpeedDisplay) dom.defaultSpeedDisplay.textContent = speedLabel(raw);
  }

  if (dom.defaultSpeedInput) {
    updateDefaultSpeedDisplay();
    dom.defaultSpeedInput.addEventListener('input', updateDefaultSpeedDisplay);
  }

  // =========================================================================
  // Interpolation options reader
  // =========================================================================

  function getInterpolationOptions() {
    return {
      positionMethod: dom.positionInterp?.value || 'catmull-rom',
      rotationMethod: dom.rotationInterp?.value || 'slerp',
      easing: dom.easingSelect?.value || 'linear',
      loop: dom.loopCheckbox?.checked || false,
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
  transportBar.create();

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

  if (dom.clearBtn) {
    dom.clearBtn.addEventListener('click', () => {
      if (keyframeStore.getCount() === 0) return;
      playbackController.stop();
      keyframeStore.clear();
    });
  }

  // =========================================================================
  // Set All Timing
  // =========================================================================

  if (dom.setAllBtn) {
    dom.setAllBtn.addEventListener('click', () => {
      const raw = dom.setAllDuration?.value;
      const val = raw === '' || raw == null ? null : parseFloat(raw);
      keyframeStore.setAllDurations(val);
    });
  }

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
      html += `<div class="cinematic-keyframe-item${isLoopBack ? ' cinematic-keyframe-item-loopback' : ''}" data-id="${kf.id}">
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
        setLoopBackEnabled(Boolean(loopBackToggle.checked));
        // keyframeStore.add emits before loopBackKeyframeId is assigned, so force
        // a final render here to avoid the "double click to activate" behavior.
        renderKeyframeList();
        return;
      }
      const input = e.target.closest('.cinematic-duration-input');
      if (!input) return;
      const pairIndex = parseInt(input.dataset.pairIndex, 10);
      const raw = input.value;
      const val = raw === '' ? null : parseFloat(raw);
      keyframeStore.setDuration(pairIndex, val);
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

  keyframeStore.on('changed', () => {
    if (!syncLoopBackState()) return;
    renderKeyframeList();
    transportBar.updateVisibility();
  });

  // =========================================================================
  // Initial render
  // =========================================================================

  syncLoopBackState();
  renderKeyframeList();

  return {
    getKeyframeStore: () => keyframeStore,
    getPlaybackController: () => playbackController
  };
}

// ---- Helpers ----

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
