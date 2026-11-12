/**
 * Press guard (classic script, runs before the module graph): one gesture is
 * one press of a button that commits work or starts and stops it.
 *
 * Such a button often changes what it does the moment it is pressed: Export
 * becomes Cancel export, Read becomes Stop, Send gives its place to Stop,
 * Cancel becomes Run again, a confirmation closes its dialog and uncovers
 * what was under it. The second click of a double click, or the next press of
 * a held Enter, then lands on the new role and undoes or repeats what the
 * first press started, silently.
 *
 * So, at the document, before any handler of the page:
 * - a click that continues a multi-click (`event.detail > 1`, as the
 *   platform counts a double click: same place, within its double-click
 *   time) is dropped when it lands on such a button, or when the click that
 *   began the sequence pressed one (wherever the next click lands: the
 *   control that took the button's place, or what its dialog uncovered);
 * - a repeated Enter or Space (`event.repeat`, a held key) does not press
 *   such a button again.
 *
 * A first click, a click after the platform's double-click time, a single
 * key press and a programmatic `click()` (`detail` 0 or 1) always act. The
 * buttons are the primary ones (`.btn-primary`: the one action that commits a
 * panel's work) and those marked `data-single-press` (a button that turns into
 * its own Stop or Cancel, or into Run again).
 *
 * Loaded directly from `index.html` with no dependencies, like
 * `file-drop-guard.js`, so it holds from the first paint and for the page's
 * life.
 */
(() => {
  const SINGLE_PRESS = '.btn-primary, [data-single-press]';
  const singlePressButton = target =>
    target != null && typeof target.closest === 'function' ? target.closest(SINGLE_PRESS) : null;
  // Whether the click that began the current multi-click pressed one.
  let sequenceBeganOnButton = false;
  document.addEventListener('click', event => {
    if (!(event.detail > 1)) {
      if (event.detail === 1) sequenceBeganOnButton = singlePressButton(event.target) !== null;
      return;
    }
    if (!sequenceBeganOnButton && singlePressButton(event.target) === null) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  document.addEventListener('keydown', event => {
    if (!event.repeat || (event.key !== 'Enter' && event.key !== ' ')) return;
    if (singlePressButton(event.target) !== null) event.preventDefault();
  }, true);
})();
