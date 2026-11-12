/**
 * @fileoverview The person's reduced-motion preference, read in one place.
 *
 * CSS stops every transition and animation under
 * `prefers-reduced-motion: reduce` (`assets/css/base/_accessibility.css`);
 * motion drawn by script cannot be reached from CSS, so every such mover
 * asks here: the camera path and the tour (they arrive instead of flying),
 * the viewer's fades and studio surface, the backdrop looks (no fade, no
 * ambient motion) and the velocity overlay (a still picture of the flow).
 * A change of the system setting is announced (`onReducedMotionChange`), so
 * a mover switches at once without waiting for another event.
 *
 * @module utils/reduced-motion
 */

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** @type {MediaQueryList|null} */
let reducedMotionMedia = null;

/**
 * The platform's media query list for the preference, or null where the
 * platform cannot state one (no `matchMedia`: a worker, a test without it).
 *
 * @returns {MediaQueryList|null}
 */
function preferenceMedia() {
  if (reducedMotionMedia !== null) return reducedMotionMedia;
  if (typeof globalThis.matchMedia !== 'function') return null;
  const media = globalThis.matchMedia(REDUCED_MOTION_QUERY);
  if (
    media === null ||
    typeof media !== 'object' ||
    typeof media.matches !== 'boolean'
  ) {
    throw new TypeError(
      'Reduced-motion preference requires an exact MediaQueryList.'
    );
  }
  reducedMotionMedia = media;
  return media;
}

/**
 * The person's live "reduce motion" preference.
 *
 * A platform without `matchMedia` cannot state a preference, so motion stays
 * enabled there; that is the only case in which this reports `false` without
 * having asked the platform.
 *
 * @returns {boolean}
 */
export function prefersReducedMotion() {
  return preferenceMedia()?.matches ?? false;
}

/**
 * Call `listener` with the new preference whenever the system setting
 * changes. Returns the function that stops listening (nothing to stop where
 * the platform cannot state a preference).
 *
 * @param {(reduced: boolean) => void} listener
 * @returns {() => void}
 */
export function onReducedMotionChange(listener) {
  if (typeof listener !== 'function') {
    throw new TypeError('A reduced-motion listener must be a function.');
  }
  const media = preferenceMedia();
  if (media === null) return () => {};
  if (
    typeof media.addEventListener !== 'function' ||
    typeof media.removeEventListener !== 'function'
  ) {
    throw new TypeError(
      'Reduced-motion preference requires a MediaQueryList that announces changes.'
    );
  }
  const onChange = () => listener(media.matches);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}
