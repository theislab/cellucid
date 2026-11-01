/**
 * Viewport bootstrap for iOS and iPadOS (runs before CSS loads).
 *
 * iOS Safari zooms the whole page into a focused input, select or textarea
 * whose text is smaller than 16px, and does not zoom back out; in the phone
 * layout that pushed the full-screen sidebar off the side of the screen.
 * Raising every field to 16px made the touch sidebar look oversized, so the
 * fields keep the interface type scale and this script removes the focus
 * zoom instead: `maximum-scale=1` stops it, and Safari has ignored
 * `maximum-scale` for the user's own pinch zoom since iOS 10, so nothing is
 * lost there. Other platforms keep the viewport as written: Android Chrome
 * does not zoom on focus, and `maximum-scale` there would take away page
 * pinch zoom, which low-vision users rely on.
 *
 * iOS WebKit is recognised by a feature it alone supports
 * (`-webkit-touch-callout`), not by the user-agent string; iPadOS reports a
 * desktop user agent but supports it too.
 *
 * Notes:
 * - Loaded directly from `index.html` (not bundled), before the stylesheet.
 * - `layouts/_responsive.css` documents the touch type scale this enables.
 */
// The phone layout (layouts/_responsive.css, below 721 px) starts with the
// plot: the panel waits as a bar at the foot of the screen (the peek state),
// unless this tab last left it open (`cellucid:phone-sheet` in session
// storage: per tab, never in the address). Marked on the root before the
// stylesheet applies, so the first frame is never covered;
// `ui/modules/sidebar-controls.js` takes the state over.
(() => {
  if (typeof matchMedia !== 'function' || !matchMedia('(max-width: 720px)').matches) return;
  let remembered = null;
  try {
    remembered = sessionStorage.getItem('cellucid:phone-sheet');
  } catch {
    remembered = null;
  }
  if (remembered !== 'open') document.documentElement.dataset.phoneSheet = 'peek';
})();

(() => {
  const meta = document.querySelector('meta[name="viewport"]');
  if (meta === null) {
    throw new Error('Viewport bootstrap requires the viewport meta element.');
  }
  const supportsCss = typeof CSS !== 'undefined' && typeof CSS.supports === 'function';
  if (!supportsCss || !CSS.supports('-webkit-touch-callout', 'none')) return;
  const content = meta.getAttribute('content') || '';
  if (/\bmaximum-scale\s*=/.test(content)) return;
  meta.setAttribute('content', `${content}, maximum-scale=1`);
})();
