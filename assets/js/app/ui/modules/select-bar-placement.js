/**
 * @fileoverview Where the selection bar sits over the plot.
 *
 * The bar (`#select-bar`) belongs to the part of the plot the sidebar does not
 * cover, so it is centred there rather than in the window. That region is not
 * measured here: it is the viewer's presented area (`presentedArea` of
 * `viewer.getPresentedLayout()`), the one rectangle the view grid is laid out
 * in, delivered by `viewer.onPresentedLayoutChange`. The bar and the grid
 * therefore read the same numbers and cannot disagree. The canvas fills the
 * window from its top-left corner, so canvas-local CSS pixels are also the
 * viewport pixels the bar's fixed box is laid out in.
 *
 * The bar's height is published as `--select-bar-block-size` on the root, so
 * notifications, which share the bottom edge, stack above it instead of
 * covering it.
 *
 * @module ui/modules/select-bar-placement
 */

/**
 * Centre the bar in the presented area of one resolved layout.
 *
 * @param {HTMLElement} bar
 * @param {{presentedArea: {cssLeft: number, cssWidth: number}}} layout
 */
export function placeSelectBar(bar, layout) {
  const area = layout?.presentedArea;
  if (
    !area
    || !Number.isFinite(area.cssLeft)
    || !Number.isFinite(area.cssWidth)
    || area.cssLeft < 0
    || area.cssWidth <= 0
  ) {
    throw new TypeError('Selection bar placement requires one presented layout.');
  }
  bar.style.setProperty('--select-bar-presented-left', `${area.cssLeft}px`);
  bar.style.setProperty('--select-bar-presented-width', `${area.cssWidth}px`);
}

/**
 * @param {object} options
 * @param {HTMLElement} options.bar the `#select-bar` element
 * @returns {{place: (layout: Object) => void, destroy: () => void}}
 */
export function initSelectBarPlacement({ bar }) {
  if (!(bar instanceof HTMLElement)) {
    throw new TypeError('Selection bar placement requires the bar HTMLElement.');
  }
  const card = bar.firstElementChild;
  if (!(card instanceof HTMLElement)) {
    throw new TypeError('Selection bar placement requires the bar card.');
  }
  const root = bar.ownerDocument.documentElement;
  if (typeof ResizeObserver !== 'function') {
    throw new Error('Selection bar placement requires ResizeObserver support.');
  }
  let destroyed = false;

  // A hidden bar has no box, so the reserved height falls back to zero.
  const publishBlockSize = () => {
    if (destroyed) return;
    const height = card.getBoundingClientRect().height;
    const bottom = height > 0 ? bar.getBoundingClientRect().bottom : 0;
    const reserved = height > 0 ? Math.max(0, root.clientHeight - bottom) + height : 0;
    root.style.setProperty('--select-bar-block-size', `${Math.ceil(reserved)}px`);
  };
  const observer = new ResizeObserver(publishBlockSize);
  observer.observe(card);
  publishBlockSize();

  return {
    place(layout) {
      if (destroyed) return;
      placeSelectBar(bar, layout);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      observer.disconnect();
      root.style.removeProperty('--select-bar-block-size');
    }
  };
}
