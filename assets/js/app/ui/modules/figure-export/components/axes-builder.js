/**
 * @fileoverview Axis builders for figure export (SVG + Canvas).
 *
 * Produces crisp axes, ticks, and labels for 2D exports.
 *
 * The axis bounds are supplied by the caller: the coordinates the plot
 * rectangle's edges show (`computeSourceAxisBounds` in
 * `utils/coordinate-mapper.js`). An axis is a ruler of the plot: its ends are
 * those bounds, and a tick is drawn where its value lies between them, so it
 * sits over the cells at that value. A short axis gets fewer ticks at a
 * coarser nice step, so its labels, measured with the figure's font
 * (`utils/text-measure.js`), never overlap (`planAxisTicks`).
 *
 * A plot's axes are laid out once (`planFigureAxes`): every line and text,
 * and the margins they need around the plot, from the measured tick labels
 * and the fonts. The figure layout reserves those margins and both formats
 * draw that one plan (`renderSvgAxes`, `drawCanvasAxes`).
 *
 * @module ui/modules/figure-export/components/axes-builder
 */

import { niceNumbers } from '../../../../../utils/nice-ticks.js';
import { formatSignificant, tickFigures } from '../../../../../utils/format-units.js';
import { escapeXml } from '../../../../utils/dom-utils.js';
import { figureSourceRect } from '../utils/plot-fit.js';
import { invertMatrix4 } from '../utils/plot-projection.js';
import { denormalizeXY } from '../utils/coordinate-mapper.js';
import { assertCameraState } from '../../../../../rendering/camera-state-contract.js';

/**
 * @typedef {object} AxisBounds
 * @property {number} minX
 * @property {number} maxX
 * @property {number} minY
 * @property {number} maxY
 */

/** `inverse` · (ndcX, ndcY, ndcZ, 1), divided by w; null at infinity. */
function unproject(inverse, ndcX, ndcY, ndcZ) {
  const x = inverse[0] * ndcX + inverse[4] * ndcY + inverse[8] * ndcZ + inverse[12];
  const y = inverse[1] * ndcX + inverse[5] * ndcY + inverse[9] * ndcZ + inverse[13];
  const z = inverse[2] * ndcX + inverse[6] * ndcY + inverse[10] * ndcZ + inverse[14];
  const w = inverse[3] * ndcX + inverse[7] * ndcY + inverse[11] * ndcZ + inverse[15];
  if (!(Math.abs(w) > 1e-12)) return null;
  return [x / w, y / w, z / w];
}

/**
 * Where the ray through NDC (ndcX, ndcY) meets the plane `z = planeZ` of the
 * space `inverse` unprojects into, or null where it runs parallel to the
 * plane or meets it behind the camera (`forward` · point is clip w).
 */
function rayOnPlane(inverse, forward, ndcX, ndcY, planeZ) {
  const near = unproject(inverse, ndcX, ndcY, -1);
  const far = unproject(inverse, ndcX, ndcY, 1);
  if (near === null || far === null) return null;
  const dz = far[2] - near[2];
  if (dz === 0) return null;
  const t = (planeZ - near[2]) / dz;
  if (!Number.isFinite(t)) return null;
  const point = [
    near[0] + (far[0] - near[0]) * t,
    near[1] + (far[1] - near[1]) * t,
    planeZ,
  ];
  const w = forward[3] * point[0] + forward[7] * point[1] + forward[11] * point[2] + forward[15];
  return w > 0 ? point : null;
}

/**
 * Whether a figure of the view carries axes: only where an axis is a ruler.
 *
 * A 1-D or 2-D embedding seen in planar navigation is looked at straight down
 * its plane (`updateCamera` in `rendering/viewer.js`: the eye on the plane's
 * normal, y up), so every cell lies on the plane the axes measure and a tick
 * sits exactly over the cells at its value. Every other view is a perspective
 * picture of cells at different depths — a 3-D embedding in any navigation, a
 * 1-D or 2-D one orbited or flown — where one length on the plot is a
 * different distance at every depth, and an axis would invite reading
 * coordinates the picture does not have. Such a view has no axes and no axis
 * margins; a 3-D view's directions are shown by the orientation widget
 * (`components/orientation-indicator.js`).
 *
 * @param {{ dimension: number, navigationMode: string }} view
 * @returns {boolean}
 */
export function figureViewHasAxes({ dimension, navigationMode }) {
  return dimension <= 2 && navigationMode === 'planar';
}

/**
 * Which panels of a figure carry axes: the person's Axes choice, for each view
 * that has them (`figureViewHasAxes`), in `views` order.
 *
 * @param {ReadonlyArray<{ scientificState: { dimensionLevel: number }, cameraState: { navigationMode: string } }>} views
 * @param {boolean} includeAxes
 * @returns {boolean[]}
 */
export function figurePanelAxes(views, includeAxes) {
  return views.map(view => includeAxes === true && figureViewHasAxes({
    dimension: view.scientificState.dimensionLevel,
    navigationMode: view.cameraState.navigationMode,
  }));
}

/**
 * The axis bounds of a figure of the pane: the embedding coordinates the left
 * and right edges (`minX`, `maxX`) and the bottom and top edges (`minY`,
 * `maxY`) of the view — or of the framing crop — show, on the embedding's
 * plane (model z = 0), denormalized (`denormalizeXY`). The view fills the plot
 * exactly, so the axes drawn along the plot rectangle's edges frame exactly
 * what is drawn. Only a view with axes is measured (`figureViewHasAxes`).
 *
 * Null when a corner of the view does not meet the plane in front of the
 * camera: no ruler fits it.
 *
 * @param {object} options
 * @param {{ mvpMatrix: Float32Array; viewportWidth: number; viewportHeight: number }} options.renderState
 * @param {object|null} [options.crop]
 * @param {1|2|3} options.dimension
 * @param {object} options.cameraState - `assertCameraState`
 * @param {import('../utils/coordinate-mapper.js').NormTransform} options.normTransform - for embedding coordinates
 * @returns {{ minX: number, maxX: number, minY: number, maxY: number } | null}
 */
export function computeSourceAxisBounds({
  renderState,
  crop = null,
  dimension,
  cameraState,
  normTransform,
}) {
  const source = figureSourceRect({ renderState, crop });
  const camera = assertCameraState(cameraState, 'Figure axis camera state');
  const left = (2 * source.x) / source.viewportWidth - 1;
  const right = (2 * (source.x + source.width)) / source.viewportWidth - 1;
  const top = 1 - (2 * source.y) / source.viewportHeight;
  const bottom = 1 - (2 * (source.y + source.height)) / source.viewportHeight;
  const corners = [[left, bottom], [right, bottom], [left, top], [right, top]];
  if (!figureViewHasAxes({ dimension, navigationMode: camera.navigationMode })) {
    throw new RangeError('Only a 1-D or 2-D view seen planar has axes (figureViewHasAxes).');
  }
  const mvp = renderState.mvpMatrix;
  const inverse = invertMatrix4(mvp);
  if (inverse === null) return null;
  const toAxes = (ndcX, ndcY) => {
    const point = rayOnPlane(inverse, mvp, ndcX, ndcY, 0);
    return point === null ? null : denormalizeXY(point[0], point[1], normTransform);
  };

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [ndcX, ndcY] of corners) {
    const point = toAxes(ndcX, ndcY);
    if (point === null || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  if (!(maxX > minX) || !(maxY > minY)) return null;
  return { minX, maxX, minY, maxY };
}

/**
 * @typedef {object} PlotRect
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/**
 * An axis's tick labels: the one number format (`formatSignificant`), with
 * as many significant figures as tell its ticks apart.
 *
 * @param {{ticks: number[], step: number}} axis - `niceNumbers`' answer
 * @returns {string[]}
 */
export function tickLabels({ ticks, step }) {
  let largest = 0;
  for (const tick of ticks) largest = Math.max(largest, Math.abs(tick));
  const figures = tickFigures(largest, step);
  return ticks.map(tick => formatSignificant(tick, figures));
}

/** The most ticks an axis is given; a shorter axis gets fewer. */
const MAX_AXIS_TICKS = 5;

/** The least room between two neighboring tick labels, in ems of their font. */
const TICK_LABEL_GAP_EM = 0.5;

/**
 * The mantissas of a nice tick step, in the order an axis tries them as it
 * gets shorter: 1, 2, 2.5, 4 and 5 times a power of ten (Talbot, Lin and
 * Hanrahan's nice numbers less 3, which skips zero on a symmetric axis).
 */
const NICE_MANTISSAS = [1, 2, 2.5, 4, 5];

/** The next coarser nice step after `step`. */
function nextNiceStep(step) {
  const exponent = Math.floor(Math.log10(step));
  const decade = Number(`1e${exponent}`);
  const mantissa = step / decade;
  for (const nice of NICE_MANTISSAS) {
    if (nice > mantissa * (1 + 1e-9)) return nice * decade;
  }
  return Number(`1e${exponent + 1}`);
}

/**
 * One axis at one step: the multiples of `step` that lie between `min` and
 * `max`, each with its label and its place along the axis (0 at `min`, 1 at
 * `max`).
 *
 * @param {number} min
 * @param {number} max
 * @param {number} step
 * @returns {{ labels: string[], fractions: number[] }}
 */
export function axisTicksAtStep(min, max, step) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) {
    throw new RangeError('Figure axis bounds must be finite with max above min.');
  }
  if (!(step > 0) || !Number.isFinite(step)) {
    throw new RangeError('Figure axis step must be a finite positive number.');
  }
  const span = max - min;
  // A tick a rounding error past an end is that end.
  const tolerance = span * 1e-9;
  const ticks = [];
  for (let k = Math.ceil((min - tolerance) / step); k * step <= max + tolerance; k++) {
    ticks.push(+(k * step).toFixed(12));
  }
  return {
    labels: tickLabels({ ticks, step }),
    fractions: ticks.map(tick => Math.min(1, Math.max(0, (tick - min) / span))),
  };
}

/**
 * The ticks of one axis whose labels, measured with the figure's font, never
 * overlap and keep a gap: the finest nice step (from the one giving at most
 * `MAX_AXIS_TICKS` ticks, coarser as the axis gets shorter) whose labels fit
 * with at least two ticks; where none does, one tick. Along the x-axis a
 * label's extent is its measured width, centered on its tick; along the y-axis
 * it is one line of the font.
 *
 * @param {object} options
 * @param {number} options.min
 * @param {number} options.max
 * @param {number} options.lengthPx - the axis's length (the plot's side)
 * @param {'x'|'y'} options.direction
 * @param {number} options.fontPx - the tick labels' font size
 * @param {import('../utils/text-measure.js').MeasureText} options.measureText
 * @returns {{ labels: string[], fractions: number[] }}
 */
export function planAxisTicks({ min, max, lengthPx, direction, fontPx, measureText }) {
  if (!(lengthPx > 0) || !Number.isFinite(lengthPx)) {
    throw new RangeError('Figure axis length must be a finite positive number.');
  }
  if (direction !== 'x' && direction !== 'y') {
    throw new TypeError('Figure axis direction must be "x" or "y".');
  }
  const gap = Math.max(4, fontPx * TICK_LABEL_GAP_EM);
  const extentOf = label => (direction === 'x' ? measureText(label, fontPx) : fontPx);
  const fits = (axis) => {
    const extents = axis.labels.map(extentOf);
    for (let i = 1; i < axis.fractions.length; i++) {
      const distance = (axis.fractions[i] - axis.fractions[i - 1]) * lengthPx;
      if (distance < (extents[i - 1] + extents[i]) / 2 + gap) return false;
    }
    return true;
  };
  let step = niceNumbers(min, max, MAX_AXIS_TICKS).step;
  /** The first one-tick axis met: what a ruler too short for two keeps. */
  let single = null;
  for (;;) {
    const axis = axisTicksAtStep(min, max, step);
    if (axis.labels.length >= 2 && fits(axis)) return axis;
    if (axis.labels.length === 1 && single === null) single = axis;
    // A step past the axis's span holds one tick at most: no coarser step
    // can give two.
    if (step >= max - min) return single ?? axis;
    step = nextNiceStep(step);
  }
}

/** Room between the plot's frame and its axis lines (px). */
const AXIS_GAP_PX = 6;
/** A tick's length (px). */
const TICK_LENGTH_PX = 5;
/**
 * How far a line of text reaches above and below its alphabetic baseline, in
 * font sizes: past the capitals and digits above, past p, g and y below, in
 * the faces a figure is drawn with.
 */
const TEXT_ASCENT_EM = 0.8;
const TEXT_DESCENT_EM = 0.3;
/**
 * A y tick label's baseline below its tick, in font sizes: half a digit's
 * height, so the label is centered on the tick at any size.
 */
const Y_TICK_BASELINE_DROP_EM = 0.35;
/** Room between a tick's end and its label, in tick font sizes (at least 3 px). */
const TICK_TEXT_GAP_EM = 0.3;
/** Room between the tick labels and the axis label, in axis label font sizes (at least 4 px). */
const AXIS_LABEL_GAP_EM = 0.4;
/** Room kept between the axes' outermost ink and whatever lies past their margin (px). */
const AXIS_MARGIN_PAD_PX = 4;

/** A figure font size as the axes draw it: whole px, at least 6. */
function axisFontOf(fontPx, what) {
  if (!(Number.isFinite(fontPx) && fontPx > 0)) {
    throw new RangeError(`Figure axes are drawn with a positive ${what} font size, not ${fontPx}.`);
  }
  return Math.max(6, Math.round(fontPx));
}

/**
 * @typedef {object} AxisLine
 * @property {number} x1
 * @property {number} y1
 * @property {number} x2
 * @property {number} y2
 */

/**
 * @typedef {object} AxisText
 * @property {string} text
 * @property {number} x      - the anchor point (px)
 * @property {number} y      - the alphabetic baseline (px)
 * @property {'middle'|'end'} anchor
 * @property {number} fontPx
 * @property {boolean} vertical - turned a quarter counter-clockwise about (x, y)
 */

/**
 * @typedef {object} AxesSpec - what a plot's axes show, before they are laid out
 * @property {AxisBounds} bounds
 * @property {string} xLabel
 * @property {string} yLabel
 * @property {number} tickFontPx
 * @property {number} labelFontPx
 */

/**
 * @typedef {object} FigureAxes - one plot's axes, laid out (`planFigureAxes`)
 * @property {number} plotWidth  - the plot size they were planned for (px)
 * @property {number} plotHeight
 * @property {AxisLine[]} lines  - axis lines and ticks, from the plot's top-left corner
 * @property {AxisText[]} texts  - tick labels and axis labels, from the plot's top-left corner
 * @property {{ left: number, right: number, top: number, bottom: number }} margins -
 *   how far the axes' ink reaches past each side of the plot, with
 *   `AXIS_MARGIN_PAD_PX` of room; 0 on a side it does not pass
 */

/**
 * A plot's axes, laid out once: every line and text both formats draw, and
 * the margins the layout reserves for them.
 *
 * The margins come from the text: the y tick labels are measured
 * (`measureText`, the layout's own measurement) and the y-axis label stands
 * past the widest of them, the x-axis label past the x tick labels' line;
 * a tick label at a plot's corner, or an axis label longer than its side,
 * reaches past the plot's other sides and is reserved there too. Nothing
 * overlaps at any font size, and nothing is cut at the figure's edge. The
 * layout plans each plot's axes with this (`utils/layout.js`), and the PNG
 * and SVG builders draw exactly the plan (`placeFigureAxes`): they measure
 * and place nothing of their own. A label placed at a fixed distance from
 * the axis, or margins of a fixed width, would let a label run into wide tick
 * labels at a large font size, and two formats would place the tick labels
 * differently (36_decisions_figure_export.md).
 *
 * @param {object} options
 * @param {AxisBounds} options.bounds
 * @param {number} options.plotWidth
 * @param {number} options.plotHeight
 * @param {string} [options.xLabel]
 * @param {string} [options.yLabel]
 * @param {number} options.tickFontPx
 * @param {number|null} [options.labelFontPx] - default: the tick font
 * @param {import('../utils/text-measure.js').MeasureText} options.measureText
 * @returns {FigureAxes}
 */
export function planFigureAxes({
  bounds,
  plotWidth,
  plotHeight,
  xLabel = '',
  yLabel = '',
  tickFontPx,
  labelFontPx = null,
  measureText,
}) {
  if (!(plotWidth > 0) || !(plotHeight > 0) || !Number.isFinite(plotWidth) || !Number.isFinite(plotHeight)) {
    throw new RangeError('Figure axes are planned for a plot of finite positive size.');
  }
  const tickFont = axisFontOf(tickFontPx, 'tick');
  const labelFont = labelFontPx === null ? tickFont : axisFontOf(labelFontPx, 'axis label');
  const x = planAxisTicks({ min: bounds.minX, max: bounds.maxX, lengthPx: plotWidth, direction: 'x', fontPx: tickFont, measureText });
  const y = planAxisTicks({ min: bounds.minY, max: bounds.maxY, lengthPx: plotHeight, direction: 'y', fontPx: tickFont, measureText });
  const xLabelText = String(xLabel ?? '').trim();
  const yLabelText = String(yLabel ?? '').trim();
  const tickGap = Math.max(3, Math.round(tickFont * TICK_TEXT_GAP_EM));
  const labelGap = Math.max(4, Math.round(labelFont * AXIS_LABEL_GAP_EM));
  const axisY = plotHeight + AXIS_GAP_PX;
  const axisX = -AXIS_GAP_PX;

  /** @type {AxisLine[]} */
  const lines = [
    { x1: 0, y1: axisY, x2: plotWidth, y2: axisY },
    { x1: axisX, y1: 0, x2: axisX, y2: plotHeight },
  ];
  /** @type {AxisText[]} */
  const texts = [];
  let minX = axisX - TICK_LENGTH_PX;
  let maxX = plotWidth;
  let minY = 0;
  let maxY = axisY + TICK_LENGTH_PX;
  const reach = (left, right, top, bottom) => {
    minX = Math.min(minX, left);
    maxX = Math.max(maxX, right);
    minY = Math.min(minY, top);
    maxY = Math.max(maxY, bottom);
  };

  // y ticks: their labels' right ends a gap left of the ticks' ends.
  const yTickRight = axisX - TICK_LENGTH_PX - tickGap;
  let yTickLeft = yTickRight;
  const yTickBoxes = [];
  y.fractions.forEach((fraction, index) => {
    const at = plotHeight - fraction * plotHeight;
    lines.push({ x1: axisX, y1: at, x2: axisX - TICK_LENGTH_PX, y2: at });
    const baseline = at + Y_TICK_BASELINE_DROP_EM * tickFont;
    const left = yTickRight - measureText(y.labels[index], tickFont);
    yTickLeft = Math.min(yTickLeft, left);
    texts.push({ text: y.labels[index], x: yTickRight, y: baseline, anchor: 'end', fontPx: tickFont, vertical: false });
    yTickBoxes.push({ left, bottom: baseline + TEXT_DESCENT_EM * tickFont });
    reach(left, yTickRight, baseline - TEXT_ASCENT_EM * tickFont, baseline + TEXT_DESCENT_EM * tickFont);
  });

  // x ticks: their labels' tops a gap under the ticks' ends, and under a y
  // tick label at the plot's bottom corner that one of them reaches under.
  const xTickHalves = x.labels.map(text => measureText(text, tickFont) / 2);
  let xTickTop = axisY + TICK_LENGTH_PX + tickGap;
  x.fractions.forEach((fraction, index) => {
    const reachesLeft = fraction * plotWidth - xTickHalves[index];
    for (const box of yTickBoxes) {
      if (reachesLeft < yTickRight && box.left < fraction * plotWidth + xTickHalves[index]) {
        xTickTop = Math.max(xTickTop, box.bottom + tickGap);
      }
    }
  });
  const xTickBaseline = xTickTop + TEXT_ASCENT_EM * tickFont;
  x.fractions.forEach((fraction, index) => {
    const at = fraction * plotWidth;
    lines.push({ x1: at, y1: axisY, x2: at, y2: axisY + TICK_LENGTH_PX });
    const half = xTickHalves[index];
    texts.push({ text: x.labels[index], x: at, y: xTickBaseline, anchor: 'middle', fontPx: tickFont, vertical: false });
    reach(at - half, at + half, xTickTop, xTickBaseline + TEXT_DESCENT_EM * tickFont);
  });

  // The axis labels are centered on their sides; one longer than its side
  // starts at the plot's corner and runs on past the far end, so the two
  // never meet at the corner they share (each keeps to its own side of it).
  // The x-axis label: its top a gap under the x tick labels.
  if (xLabelText) {
    const baseline = xTickBaseline + TEXT_DESCENT_EM * tickFont + labelGap + TEXT_ASCENT_EM * labelFont;
    const half = measureText(xLabelText, labelFont) / 2;
    const centre = Math.max(plotWidth / 2, half);
    texts.push({ text: xLabelText, x: centre, y: baseline, anchor: 'middle', fontPx: labelFont, vertical: false });
    reach(centre - half, centre + half, baseline - TEXT_ASCENT_EM * labelFont, baseline + TEXT_DESCENT_EM * labelFont);
  }
  // The y-axis label, read upwards: its baseline faces the tick labels, its
  // descenders a gap left of the widest of them.
  if (yLabelText) {
    const baseline = yTickLeft - labelGap - TEXT_DESCENT_EM * labelFont;
    const half = measureText(yLabelText, labelFont) / 2;
    const centre = Math.min(plotHeight / 2, plotHeight - half);
    texts.push({ text: yLabelText, x: baseline, y: centre, anchor: 'middle', fontPx: labelFont, vertical: true });
    reach(baseline - TEXT_ASCENT_EM * labelFont, baseline + TEXT_DESCENT_EM * labelFont, centre - half, centre + half);
  }

  const margin = past => (past > 0 ? Math.ceil(past + AXIS_MARGIN_PAD_PX) : 0);
  return {
    plotWidth,
    plotHeight,
    lines,
    texts,
    margins: {
      left: margin(-minX),
      right: margin(maxX - plotWidth),
      top: margin(-minY),
      bottom: margin(maxY - plotHeight),
    },
  };
}

/**
 * A plot's planned axes at the plot's place in the figure: what both builders
 * draw. The plot must be the size the axes were planned for.
 *
 * @param {FigureAxes} axes
 * @param {PlotRect} plotRect
 * @returns {{ lines: AxisLine[], texts: AxisText[] }}
 */
export function placeFigureAxes(axes, plotRect) {
  if (
    Math.abs(plotRect.width - axes.plotWidth) > 1e-6
    || Math.abs(plotRect.height - axes.plotHeight) > 1e-6
  ) {
    throw new RangeError('Figure axes are drawn on the plot they were planned for (planFigureAxes).');
  }
  const { x: dx, y: dy } = plotRect;
  return {
    lines: axes.lines.map(line => ({ x1: line.x1 + dx, y1: line.y1 + dy, x2: line.x2 + dx, y2: line.y2 + dy })),
    texts: axes.texts.map(text => ({ ...text, x: text.x + dx, y: text.y + dy })),
  };
}

/**
 * Render a plot's planned axes (`planFigureAxes`) as SVG.
 *
 * @param {object} options
 * @param {PlotRect} options.plotRect
 * @param {FigureAxes} options.axes
 * @param {string} [options.fontFamily]
 * @param {string} [options.color]
 */
export function renderSvgAxes({
  plotRect,
  axes,
  fontFamily = 'Arial, Helvetica, sans-serif',
  color = '#111',
}) {
  const { lines, texts } = placeFigureAxes(axes, plotRect);
  const parts = [
    `<g font-family="${escapeXml(fontFamily)}" fill="${escapeXml(color)}" stroke="${escapeXml(color)}" stroke-width="1">`,
  ];
  for (const line of lines) {
    parts.push(`<line x1="${line.x1}" y1="${line.y1}" x2="${line.x2}" y2="${line.y2}"/>`);
  }
  for (const text of texts) {
    const turn = text.vertical ? ` transform="rotate(-90 ${text.x} ${text.y})"` : '';
    parts.push(
      `<text x="${text.x}" y="${text.y}" text-anchor="${text.anchor}" font-size="${text.fontPx}" stroke="none"${turn}>${escapeXml(text.text)}</text>`
    );
  }
  parts.push('</g>');
  return parts.join('');
}

/** Canvas `textAlign` for an SVG `text-anchor`. */
const CANVAS_ALIGN = { middle: 'center', end: 'right' };

/**
 * Draw a plot's planned axes (`planFigureAxes`) onto a Canvas2D context,
 * exactly as `renderSvgAxes` writes them.
 *
 * @param {object} options
 * @param {CanvasRenderingContext2D} options.ctx
 * @param {PlotRect} options.plotRect
 * @param {FigureAxes} options.axes
 * @param {string} [options.fontFamily]
 * @param {string} [options.color]
 */
export function drawCanvasAxes({
  ctx,
  plotRect,
  axes,
  fontFamily = 'Arial, Helvetica, sans-serif',
  color = '#111',
}) {
  const { lines, texts } = placeFigureAxes(axes, plotRect);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1;
  ctx.textBaseline = 'alphabetic';
  ctx.beginPath();
  for (const line of lines) {
    ctx.moveTo(line.x1, line.y1);
    ctx.lineTo(line.x2, line.y2);
  }
  ctx.stroke();
  for (const text of texts) {
    ctx.font = `${text.fontPx}px ${fontFamily}`;
    ctx.textAlign = CANVAS_ALIGN[text.anchor];
    if (text.vertical) {
      ctx.save();
      ctx.translate(text.x, text.y);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(text.text, 0, 0);
      ctx.restore();
    } else {
      ctx.fillText(text.text, text.x, text.y);
    }
  }
  ctx.restore();
}
