/**
 * @fileoverview The canvas a PNG figure is composed on, or a refusal saying
 * why the browser cannot draw it.
 *
 * A figure has no size cap of Cellucid's own: its legend is as large as its
 * entries need (`utils/layout.js`). The one real limit is the browser's
 * canvas: every engine refuses a canvas past a side length or an area of its
 * own (Chromium, Firefox and Safari each set theirs, and a machine short of
 * memory refuses sooner), and none of them says so. Past it, a 2D context is
 * either not given at all or given and silently draws nothing, and the PNG
 * would come out blank or cut.
 *
 * So the limit is not guessed from a table: the canvas is allocated at the
 * figure's size, a pixel is drawn in its far corner and read back. Where that
 * pixel is not there, the canvas cannot hold the figure, and the export is
 * refused before anything is rendered, with one sentence naming the size and
 * the remedy. Nothing is ever shrunk or cut to fit.
 *
 * @module ui/modules/figure-export/utils/figure-canvas
 */

import { formatCount } from '../../../../../utils/format-units.js';

/**
 * Does this canvas, at its current size, really draw?
 *
 * @param {HTMLCanvasElement} canvas
 * @param {number} width
 * @param {number} height
 */
function canvasDraws(canvas, width, height) {
  if (canvas.width !== width || canvas.height !== height) return false;
  try {
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) return false;
    context.fillStyle = '#000000';
    context.fillRect(width - 1, height - 1, 1, 1);
    const drawn = context.getImageData(width - 1, height - 1, 1, 1).data[3] === 255;
    context.clearRect(width - 1, height - 1, 1, 1);
    return drawn;
  } catch {
    return false;
  }
}

/**
 * Can this browser draw a canvas of this size now? The probe canvas is
 * released before returning.
 *
 * @param {number} width  - device pixels
 * @param {number} height - device pixels
 * @returns {boolean}
 */
export function browserDrawsCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const draws = canvasDraws(canvas, width, height);
  canvas.width = 0;
  canvas.height = 0;
  return draws;
}

/**
 * The refusal of a figure the browser cannot draw: one sentence, its size, and
 * the remedy for what made it that large.
 *
 * @param {object} options
 * @param {number} options.width  - device pixels
 * @param {number} options.height - device pixels
 * @param {number|null} options.legendCategories - When the legend makes the
 *   figure too large: the categories of its largest legend (0 for a legend
 *   that is not categorical). Null when the figure is too large without it.
 * @returns {string}
 */
function figureTooLargeSentence({ width, height, legendCategories }) {
  const size = `${formatCount(width)}×${formatCount(height)} px`;
  if (legendCategories === null) {
    return `This figure is ${size}, more than this browser can draw; choose a smaller size or a lower DPI.`;
  }
  const legend = legendCategories > 0
    ? `The legend of ${formatCount(legendCategories)} ${legendCategories === 1 ? 'category' : 'categories'}`
    : 'The legend';
  return `${legend} needs a ${size} figure, more than this browser can draw; turn the legend off or show fewer categories.`;
}

/**
 * Allocate the canvas a PNG figure is composed on, or refuse.
 *
 * @param {object} options
 * @param {number} options.width  - device pixels
 * @param {number} options.height - device pixels
 * @param {() => number|null} options.legendCategoriesIfTooLarge - asked only
 *   when the canvas cannot be drawn: whether the legend made the figure too
 *   large (see `figureTooLargeSentence`)
 * @returns {HTMLCanvasElement}
 */
export function createFigureCanvas({ width, height, legendCategoriesIfTooLarge }) {
  if (typeof document === 'undefined') {
    throw new Error('PNG export requires an HTML document.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  if (canvasDraws(canvas, width, height)) return canvas;
  canvas.width = 0;
  canvas.height = 0;
  throw new RangeError(figureTooLargeSentence({
    width,
    height,
    legendCategories: legendCategoriesIfTooLarge(),
  }));
}
