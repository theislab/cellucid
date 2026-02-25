/**
 * @fileoverview Transport bar overlay for cinematic camera playback.
 *
 * Creates a fixed-position bar at the top of the 3D viewport with play/pause,
 * stop, a scrubable timeline with keyframe markers, and a time readout.
 * Auto-hides after inactivity and reappears on mouse movement.
 *
 * @module ui/modules/cinematic-camera/transport-bar
 */

import { resolveSegmentDurations } from './interpolation-engine.js';

const HIDE_DELAY = 3000; // ms

// SVG icon helpers (matches the feather-style 2 px stroke used elsewhere)
const ICON_PLAY = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="8,5 19,12 8,19"/></svg>`;
const ICON_PAUSE = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>`;
const ICON_STOP = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12"/></svg>`;

/**
 * @param {Object} options
 * @param {import('./playback-controller.js').ReturnType<typeof import('./playback-controller.js').createPlaybackController>} options.playbackController
 * @param {import('./keyframe-store.js').ReturnType<typeof import('./keyframe-store.js').createKeyframeStore>} options.keyframeStore
 * @param {() => Object} [options.getInterpolationOptions]  Returns { autoPaceSpeed, ... }.
 */
export function createTransportBar({ playbackController, keyframeStore, getInterpolationOptions }) {
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

    barEl = document.createElement('div');
    barEl.className = 'cinematic-transport-bar';
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

    playBtn = barEl.querySelector('.cinematic-play-btn');
    progressEl = barEl.querySelector('.cinematic-timeline-progress');
    scrubberEl = barEl.querySelector('.cinematic-timeline-scrubber');
    markersEl = barEl.querySelector('.cinematic-timeline-markers');
    readoutEl = barEl.querySelector('.cinematic-time-readout');

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
        playbackController.stop();
      }
    });

    // Scrubber interaction
    scrubberEl.addEventListener('pointerdown', () => {
      isScrubbing = true;
      wasPlayingBeforeScrub = playbackController.getState() === 'PLAYING';
      if (wasPlayingBeforeScrub) playbackController.pause();
    });

    scrubberEl.addEventListener('input', () => {
      const globalT = parseInt(scrubberEl.value, 10) / 1000;
      playbackController.seekTo(globalT);
    });

    const endScrub = () => {
      if (!isScrubbing) return;
      isScrubbing = false;
      if (wasPlayingBeforeScrub) playbackController.play();
    };

    scrubberEl.addEventListener('pointerup', endScrub);
    scrubberEl.addEventListener('pointercancel', endScrub);

    // Auto-hide: track mouse movement over the viewport area
    document.addEventListener('mousemove', onMouseActivity, { passive: true });
    document.addEventListener('pointerdown', onMouseActivity, { passive: true });

    // Keep bar visible while hovering it
    barEl.addEventListener('mouseenter', () => { clearTimeout(hideTimeout); });
    barEl.addEventListener('mouseleave', () => { scheduleHide(); });

    // Playback state changes
    playbackController.on('stateChange', onPlaybackStateChange);
    playbackController.on('timeUpdate', onTimeUpdate);

    // Keyframe changes
    keyframeStore.on('changed', onKeyframeChange);
  }

  // ---- Sidebar awareness ----

  function observeSidebar() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar || !barEl) return;

    const update = () => {
      barEl.classList.toggle('sidebar-hidden', sidebar.classList.contains('hidden'));
    };
    update();

    sidebarObserver = new MutationObserver(update);
    sidebarObserver.observe(sidebar, { attributes: true, attributeFilter: ['class'] });
  }

  // ---- Visibility ----

  function show() {
    if (!barEl) return;
    barEl.classList.add('visible');
    scheduleHide();
  }

  function hide() {
    if (!barEl) return;
    // Don't hide during playback
    if (playbackController.getState() === 'PLAYING') return;
    barEl.classList.remove('visible');
  }

  function scheduleHide() {
    clearTimeout(hideTimeout);
    hideTimeout = setTimeout(hide, HIDE_DELAY);
  }

  function onMouseActivity(e) {
    if (!barEl) return;
    // Only react to mouse events over the viewport (not the sidebar)
    const sidebar = document.getElementById('sidebar');
    if (sidebar && !sidebar.classList.contains('hidden') && e.clientX < sidebar.getBoundingClientRect().right) {
      return;
    }
    if (keyframeStore.getCount() >= 2) {
      show();
    }
  }

  /** Update visibility based on keyframe count. */
  function updateVisibility() {
    if (keyframeStore.getCount() >= 2) {
      if (!barEl) create();
      updateMarkers();
      show();
    } else {
      hide();
    }
  }

  // ---- Markers ----

  function updateMarkers() {
    if (!markersEl) return;
    markersEl.innerHTML = '';

    const keyframes = keyframeStore.getAll();
    if (keyframes.length < 2) return;

    const speed = getInterpolationOptions ? getInterpolationOptions().autoPaceSpeed : undefined;
    const durations = resolveSegmentDurations(keyframes, speed);
    const total = durations.reduce((s, d) => s + d, 0);
    if (total <= 0) return;

    let cum = 0;
    for (let i = 0; i < keyframes.length; i++) {
      const pct = total > 0 ? (cum / total) * 100 : 0;
      const marker = document.createElement('div');
      marker.className = 'cinematic-timeline-marker';
      marker.style.left = `${pct}%`;
      markersEl.appendChild(marker);
      if (i < durations.length) cum += durations[i];
    }
  }

  // ---- Progress updates ----

  function updateProgress(globalT) {
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
    const s = Math.max(0, seconds);
    const mins = Math.floor(s / 60);
    const secs = Math.floor(s % 60);
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }

  // ---- Callbacks ----

  function onPlaybackStateChange(playbackState) {
    if (!playBtn) return;
    if (playbackState === 'PLAYING') {
      playBtn.innerHTML = ICON_PAUSE;
      playBtn.title = 'Pause';
      if (barEl) barEl.classList.add('visible');
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

  function onKeyframeChange() {
    updateMarkers();
    updateVisibility();
  }

  // ---- Cleanup ----

  function destroy() {
    clearTimeout(hideTimeout);
    document.removeEventListener('mousemove', onMouseActivity);
    document.removeEventListener('pointerdown', onMouseActivity);
    playbackController.off('stateChange', onPlaybackStateChange);
    playbackController.off('timeUpdate', onTimeUpdate);
    keyframeStore.off('changed', onKeyframeChange);
    if (sidebarObserver) sidebarObserver.disconnect();
    if (barEl) {
      barEl.remove();
      barEl = null;
    }
  }

  return { create, show, hide, updateVisibility, updateMarkers, destroy };
}
