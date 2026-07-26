/**
 * @fileoverview Transport bar overlay for cinematic camera playback.
 *
 * Creates a fixed-position bar at the top of the 3D viewport with play/pause,
 * stop, a scrubable timeline with keyframe markers, and a time readout.
 * Auto-hides after inactivity and reappears on mouse movement.
 *
 * @module ui/modules/cinematic-camera/transport-bar
 */

import {
  assertCameraPathOptions,
  resolveSegmentDurations
} from './interpolation-engine.js';
import { isCameraPathReady } from './keyframe-store.js';
import { readCameraBooleanOption } from '../camera-input-contract.js';
import { parseIntegerInput } from '../../core/numeric-input-contract.js';

const HIDE_DELAY = 3000; // ms

// SVG icon helpers (matches the feather-style 2 px stroke used elsewhere)
const ICON_PLAY = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="8,5 19,12 8,19"/></svg>`;
const ICON_PAUSE = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>`;
const ICON_STOP = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12"/></svg>`;

/**
 * @param {Object} options
 * @param {import('./playback-controller.js').ReturnType<typeof import('./playback-controller.js').createPlaybackController>} options.playbackController
 * @param {import('./keyframe-store.js').ReturnType<typeof import('./keyframe-store.js').createKeyframeStore>} options.keyframeStore
 * @param {() => Object} options.getInterpolationOptions Returns { autoPaceSpeed, ... }.
 */
export function createTransportBar({ playbackController, keyframeStore, getInterpolationOptions }) {
  if (
    !playbackController ||
    typeof playbackController.getState !== 'function' ||
    typeof playbackController.play !== 'function' ||
    typeof playbackController.pause !== 'function' ||
    typeof playbackController.stop !== 'function' ||
    typeof playbackController.seekTo !== 'function' ||
    typeof playbackController.on !== 'function' ||
    typeof playbackController.off !== 'function'
  ) {
    throw new TypeError('Camera transport requires the exact playback-controller contract.');
  }
  if (!keyframeStore || typeof keyframeStore.getAll !== 'function') {
    throw new TypeError('Camera transport requires the exact keyframe-store contract.');
  }
  if (typeof getInterpolationOptions !== 'function') {
    throw new TypeError('Camera transport requires getInterpolationOptions().');
  }

  /** @type {HTMLElement|null} */
  let barEl = null;
  /** @type {HTMLElement|null} */
  let playBtn = null;
  /** @type {HTMLElement|null} */
  let progressEl = null;
  /** @type {HTMLInputElement|null} */
  let scrubberEl = null;
  /** @type {HTMLElement|null} */
  let markersEl = null;
  /** @type {HTMLElement|null} */
  let readoutEl = null;

  let hideTimeout = null;
  let isScrubbing = false;
  let wasPlayingBeforeScrub = false;
  let sidebarObserver = null;

  // ---- DOM construction ----

  function create() {
    if (barEl) return;
    if (!pathIsReady()) {
      throw new Error('Camera transport can mount only for a ready camera path.');
    }

    barEl = document.createElement('div');
    barEl.className = 'cinematic-transport-bar';
    barEl.setAttribute('role', 'region');
    barEl.setAttribute('aria-label', 'Camera path playback');
    barEl.innerHTML = `
      <div class="cinematic-transport-inner">
        <button class="cinematic-transport-btn" data-action="stop" title="Stop (reset to start)">${ICON_STOP}</button>
        <button class="cinematic-transport-btn cinematic-play-btn" data-action="play" title="Play / Pause">${ICON_PLAY}</button>
        <div class="cinematic-timeline-container">
          <div class="cinematic-timeline-track">
            <div class="cinematic-timeline-progress"></div>
            <div class="cinematic-timeline-markers"></div>
          </div>
          <input type="range" class="cinematic-timeline-scrubber" min="0" max="1000" step="1" value="0" aria-label="Timeline scrubber" />
        </div>
        <span class="cinematic-time-readout">0:00 / 0:00</span>
      </div>
    `;

    document.body.appendChild(barEl);

    const requireElement = (selector) => {
      const element = barEl.querySelector(selector);
      if (!element) {
        throw new Error(`Camera transport failed to create its required "${selector}" element.`);
      }
      return element;
    };
    playBtn = requireElement('.cinematic-play-btn');
    progressEl = requireElement('.cinematic-timeline-progress');
    scrubberEl = requireElement('.cinematic-timeline-scrubber');
    markersEl = requireElement('.cinematic-timeline-markers');
    readoutEl = requireElement('.cinematic-time-readout');

    setInteractive(false);
    bindEvents();
    observeSidebar();
  }

  // ---- Event wiring ----

  function bindEvents() {
    if (!barEl) return;

    // Button clicks (event delegation)
    barEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'play') {
        const s = playbackController.getState();
        if (s === 'PLAYING') {
          playbackController.pause();
        } else {
          playbackController.play();
        }
      } else if (action === 'stop') {
        playbackController.stop({ resetCamera: true });
      }
    });

    // Scrubber interaction
    scrubberEl.addEventListener('pointerdown', (event) => {
      isScrubbing = true;
      wasPlayingBeforeScrub = playbackController.getState() === 'PLAYING';
      scrubberEl.setPointerCapture(event.pointerId);
      if (wasPlayingBeforeScrub) playbackController.pause();
    });

    scrubberEl.addEventListener('input', () => {
      const globalT = parseIntegerInput(scrubberEl.value, {
        minimum: 0,
        maximum: 1000,
        label: 'Camera path timeline position'
      }) / 1000;
      playbackController.seekTo(globalT);
    });

    const endScrub = (event) => {
      if (!isScrubbing) return;
      isScrubbing = false;
      if (scrubberEl.hasPointerCapture(event.pointerId)) {
        scrubberEl.releasePointerCapture(event.pointerId);
      }
      if (wasPlayingBeforeScrub) playbackController.play();
      wasPlayingBeforeScrub = false;
    };

    scrubberEl.addEventListener('pointerup', endScrub);
    scrubberEl.addEventListener('pointercancel', endScrub);

    // Auto-hide: track mouse movement over the viewport area
    document.addEventListener('mousemove', onMouseActivity, { passive: true });
    document.addEventListener('pointerdown', onMouseActivity, { passive: true });
    document.addEventListener('keydown', onKeyboardActivity);

    // Keep bar visible while hovering it
    barEl.addEventListener('mouseenter', () => { clearTimeout(hideTimeout); });
    barEl.addEventListener('mouseleave', () => { scheduleHide(); });
    barEl.addEventListener('focusin', () => { clearTimeout(hideTimeout); });
    barEl.addEventListener('focusout', () => {
      setTimeout(scheduleHide, 0);
    });

    // Playback state changes
    playbackController.on('stateChange', onPlaybackStateChange);
    playbackController.on('timeUpdate', onTimeUpdate);

  }

  // ---- Sidebar awareness ----

  function observeSidebar() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) {
      throw new Error('Camera transport requires the application sidebar.');
    }

    const update = () => {
      barEl.classList.toggle('sidebar-hidden', sidebar.classList.contains('hidden'));
    };
    update();

    sidebarObserver = new MutationObserver(update);
    sidebarObserver.observe(sidebar, { attributes: true, attributeFilter: ['class'] });
  }

  // ---- Visibility ----

  function pathIsReady() {
    return isCameraPathReady(keyframeStore.getAll());
  }

  function setInteractive(interactive) {
    if (!barEl) return;
    barEl.setAttribute('aria-hidden', interactive ? 'false' : 'true');
    barEl.inert = !interactive;
    for (const control of barEl.querySelectorAll('button, input')) {
      control.disabled = !interactive;
    }
  }

  function show() {
    if (!pathIsReady()) return;
    if (!barEl) create();
    setInteractive(true);
    barEl.classList.add('visible');
    scheduleHide();
  }

  function hide(options) {
    const force = readCameraBooleanOption(options, 'force', 'Camera transport hide');
    if (!barEl) return;
    // Don't hide during playback
    if (!force && playbackController.getState() === 'PLAYING') return;
    barEl.classList.remove('visible');
    setInteractive(false);
  }

  function scheduleHide() {
    clearTimeout(hideTimeout);
    if (!barEl || !pathIsReady()) return;
    if (barEl.contains(document.activeElement)) return;
    hideTimeout = setTimeout(() => hide({ force: false }), HIDE_DELAY);
  }

  function onMouseActivity(e) {
    if (!barEl) return;
    // Only react to mouse events over the viewport (not the sidebar)
    const sidebar = document.getElementById('sidebar');
    if (sidebar && !sidebar.classList.contains('hidden') && e.clientX < sidebar.getBoundingClientRect().right) {
      return;
    }
    if (pathIsReady()) {
      show();
    }
  }

  function onKeyboardActivity(event) {
    if (event.key === 'Tab' && pathIsReady()) {
      show();
    }
  }

  /** Update availability based on validated path readiness. */
  function updateVisibility(options) {
    const reveal = readCameraBooleanOption(
      options,
      'reveal',
      'Camera transport visibility'
    );
    if (pathIsReady()) {
      if (!barEl) create();
      updateMarkers();
      if (reveal) {
        show();
      } else {
        hide({ force: true });
      }
    } else {
      playbackController.stop({ resetCamera: false });
      unmount();
    }
  }

  // ---- Markers ----

  function updateMarkers() {
    if (!markersEl) return;
    markersEl.innerHTML = '';

    const keyframes = keyframeStore.getAll();
    if (!isCameraPathReady(keyframes)) return;

    const opts = assertCameraPathOptions(getInterpolationOptions());
    const durations = resolveSegmentDurations(keyframes, opts.autoPaceSpeed);
    const total = durations.reduce((s, d) => s + d, 0);
    if (!Number.isFinite(total) || total <= 0) {
      throw new Error('Camera transport requires a positive finite path duration.');
    }

    let cum = 0;
    for (let i = 0; i < keyframes.length; i++) {
      const pct = (cum / total) * 100;
      const marker = document.createElement('div');
      marker.className = 'cinematic-timeline-marker';
      marker.style.left = `${pct}%`;
      markersEl.appendChild(marker);
      if (i < durations.length) cum += durations[i];
    }
  }

  // ---- Progress updates ----

  function updateProgress(globalT) {
    if (!Number.isFinite(globalT) || globalT < 0 || globalT > 1) {
      throw new RangeError('Camera transport progress must be a finite number from 0 through 1.');
    }
    if (progressEl) {
      progressEl.style.width = `${(globalT * 100).toFixed(2)}%`;
    }
    if (scrubberEl && !isScrubbing) {
      scrubberEl.value = String(Math.round(globalT * 1000));
    }
  }

  function updateTimeReadout(elapsed, totalDuration) {
    if (!readoutEl) return;
    readoutEl.textContent = `${formatTime(elapsed)} / ${formatTime(totalDuration)}`;
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new RangeError('Camera transport time must be a non-negative finite number.');
    }
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }

  // ---- Callbacks ----

  function onPlaybackStateChange(playbackState) {
    if (!playBtn) return;
    if (playbackState === 'PLAYING') {
      if (!pathIsReady()) {
        playbackController.stop({ resetCamera: false });
        return;
      }
      playBtn.innerHTML = ICON_PAUSE;
      playBtn.title = 'Pause';
      show();
      clearTimeout(hideTimeout);
    } else {
      playBtn.innerHTML = ICON_PLAY;
      playBtn.title = 'Play';
      if (playbackState === 'STOPPED') {
        updateProgress(0);
        updateTimeReadout(0, 0);
      }
      scheduleHide();
    }
  }

  function onTimeUpdate({ globalT, elapsed, totalDuration }) {
    updateProgress(globalT);
    updateTimeReadout(elapsed, totalDuration);
  }

  // ---- Cleanup ----

  function unmount() {
    clearTimeout(hideTimeout);
    document.removeEventListener('mousemove', onMouseActivity);
    document.removeEventListener('pointerdown', onMouseActivity);
    document.removeEventListener('keydown', onKeyboardActivity);
    playbackController.off('stateChange', onPlaybackStateChange);
    playbackController.off('timeUpdate', onTimeUpdate);
    if (sidebarObserver) sidebarObserver.disconnect();
    sidebarObserver = null;
    if (barEl) {
      barEl.remove();
      barEl = null;
    }
    playBtn = null;
    progressEl = null;
    scrubberEl = null;
    markersEl = null;
    readoutEl = null;
    isScrubbing = false;
    wasPlayingBeforeScrub = false;
  }

  function destroy() {
    unmount();
  }

  return {
    updateVisibility,
    destroy,
    isMounted: () => Boolean(barEl)
  };
}
