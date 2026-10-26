/**
 * Plots laid out for the size they are drawn at.
 *
 * A plot that places its labels, legends and statistics in pixels from the
 * size of its container (the tick labels a category axis can hold, the
 * volcano's band below its axis, the dot plot's legend column, the
 * correlation's statistics boxes) is right only at that size. When its
 * container is resized, Plotly's own resize stretches the plot but keeps the
 * layout, so a label placed for a wider box would land on another in a
 * narrower one. Each such plot registers how to lay itself out again here,
 * and the responsive resize (`shared/plotly-render-slot.js`) does so after
 * every resize.
 *
 * @module plots/size-fit
 */

/** @type {WeakMap<HTMLElement, () => Promise<unknown>|unknown>} */
const refits = new WeakMap();

/**
 * Register how a drawn plot lays itself out again at its container's size.
 *
 * @param {HTMLElement} figure - The Plotly graph div
 * @param {() => Promise<unknown>|unknown} refit
 * @returns {HTMLElement} `figure`
 */
export function fitToSize(figure, refit) {
  if (typeof refit !== 'function') throw new TypeError('A plot refit must be a function.');
  refits.set(figure, refit);
  return figure;
}

/**
 * Lay a resized plot out again at its container's size, when it registered
 * how (`fitToSize`).
 *
 * @param {HTMLElement} figure
 */
export async function refitToSize(figure) {
  const refit = refits.get(figure);
  if (refit !== undefined) await refit();
}
