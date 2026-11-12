/**
 * @fileoverview Camera path captions (F110, owner 2026-11-11): while a path
 * plays, the label of the keyframe the film is at appears over the plot, as
 * a documentary's title — "Beta cells", "Overview".
 *
 * Which caption, when: each named keyframe owns the film from halfway
 * through the move into it to halfway through the move out of it (the first
 * from the start, the last to the end), so its title is up while the camera
 * approaches, rests on and leaves its subject. A keyframe still called by its
 * automatic name ("KF 3") and the return to start have no caption: a caption
 * is a name someone gave. Captions are a playback setting
 * (`#cinematic-captions`, the camera path's own state, on by default); with
 * no keyframe named there is nothing to show.
 *
 * The caption fades in and out (a short opacity transition); under reduced
 * motion it is shown and hidden at once. It is up while the film plays or is
 * paused, and goes when it stops. `readShownCaption` is what a picture of the
 * screen draws and says (`app/reads/views.js`).
 *
 * @module ui/modules/cinematic-camera/captions
 */

import { prefersReducedMotion } from '../../../../utils/reduced-motion.js';

/** The element the caption is drawn in (one per page). */
export const CAPTION_ELEMENT_ID = 'cinematic-caption';
/** The automatic label a keyframe is given ("KF 3", `keyframe-store.js`). */
const AUTOMATIC_LABEL = /^KF [1-9][0-9]*$/;
/** How long the caption takes to fade in or out, in milliseconds. */
export const CAPTION_FADE_MS = 400;

/** Whether `label` is a name someone gave (a caption), not the automatic "KF n". */
export function isCaptionLabel(label) {
  return typeof label === 'string' && label.length > 0 && !AUTOMATIC_LABEL.test(label);
}

/**
 * The caption at `elapsed` seconds of a path: the label of the keyframe that
 * owns that moment, or null (an automatic name, the return to start, or no
 * path).
 *
 * @param {{label: string, id: string}[]} keyframes
 * @param {{arrivals: number[], departures: number[], total: number}} timing - `resolvePathTiming`'s
 * @param {number} elapsed
 * @param {string|null} loopBackKeyframeId - the return to start, never captioned
 * @returns {string|null}
 */
export function captionAt(keyframes, timing, elapsed, loopBackKeyframeId = null) {
  if (!Array.isArray(keyframes) || keyframes.length === 0 || !Number.isFinite(elapsed)) return null;
  let owner = keyframes.length - 1;
  for (let index = 0; index < keyframes.length - 1; index++) {
    // Halfway through the move from this keyframe to the next.
    const handover = (timing.departures[index] + timing.arrivals[index + 1]) / 2;
    if (elapsed < handover) { owner = index; break; }
  }
  const keyframe = keyframes[owner];
  if (keyframe.id === loopBackKeyframeId) return null;
  return isCaptionLabel(keyframe.label) ? keyframe.label : null;
}

/** Whether any keyframe of `keyframes` would show a caption. */
export function hasCaptions(keyframes, loopBackKeyframeId = null) {
  return keyframes.some(keyframe => keyframe.id !== loopBackKeyframeId && isCaptionLabel(keyframe.label));
}

/**
 * The caption on screen now, or null: what a picture of the screen shows.
 *
 * @param {{getElementById: (id: string) => any}|null} documentRef
 * @returns {string|null}
 */
export function readShownCaption(documentRef) {
  const element = documentRef?.getElementById?.(CAPTION_ELEMENT_ID) ?? null;
  if (element === null || element.dataset?.shown !== 'true') return null;
  const text = element.textContent?.trim() ?? '';
  return text.length > 0 ? text : null;
}

/**
 * The caption over the plot, following the playback.
 *
 * @param {{
 *   playbackController: {on: Function, off: Function, getState: () => string},
 *   caption: (elapsed: number) => string|null,
 *   enabled: () => boolean,
 *   documentRef?: Document,
 * }} options - `caption(elapsed)` is the caption at a moment (`captionAt`
 *   with the path now), `enabled()` the playback setting.
 * @returns {{refresh: () => void, destroy: () => void}}
 */
export function createCaptionOverlay({ playbackController, caption, enabled, documentRef = document }) {
  const element = documentRef.createElement('div');
  element.id = CAPTION_ELEMENT_ID;
  element.className = 'cinematic-caption';
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');
  element.dataset.shown = 'false';
  documentRef.body.appendChild(element);

  let wanted = null;
  let fadeTimer = null;
  let lastElapsed = 0;

  function clearFade() {
    if (fadeTimer !== null) clearTimeout(fadeTimer);
    fadeTimer = null;
  }

  function showNow(text) {
    element.textContent = text ?? '';
    element.dataset.shown = text === null ? 'false' : 'true';
    element.classList.toggle('visible', text !== null);
  }

  /** Show `text` (null: none), fading out what is up and in the new one. */
  function present(text) {
    if (text === wanted) return;
    wanted = text;
    clearFade();
    const reduced = prefersReducedMotion();
    element.classList.toggle('no-motion', reduced);
    if (reduced || element.dataset.shown !== 'true') {
      showNow(text);
      return;
    }
    // Fade the shown caption out, then the next in.
    element.classList.remove('visible');
    fadeTimer = setTimeout(() => {
      fadeTimer = null;
      showNow(wanted);
    }, CAPTION_FADE_MS);
  }

  function update(elapsed = lastElapsed) {
    lastElapsed = elapsed;
    const state = playbackController.getState();
    const playing = state === 'PLAYING' || state === 'PAUSED';
    present(playing && enabled() ? caption(elapsed) : null);
  }

  const onTime = ({ elapsed }) => update(elapsed);
  const onState = () => update();
  playbackController.on('timeUpdate', onTime);
  playbackController.on('stateChange', onState);

  return {
    /** The setting or the path changed: show what is due now. */
    refresh: () => update(),
    destroy() {
      clearFade();
      playbackController.off('timeUpdate', onTime);
      playbackController.off('stateChange', onState);
      element.remove();
    },
  };
}
