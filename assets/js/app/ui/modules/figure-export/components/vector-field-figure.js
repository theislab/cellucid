/**
 * @fileoverview The vector field of a figure: a still picture of the flow the
 * overlay animates, drawn as arrows on a grid (scVelo's
 * `velocity_embedding_grid`), the same in PNG, SVG and the preview.
 *
 * The particle overlay is an animation and cannot be a figure. A figure
 * draws what it means instead, from the same arrays the overlay draws: each
 * cell the view shows (its filters and hidden categories) with a vector, at
 * the place the screen shows it, its vector carried through the same camera
 * onto the plot. The plot is covered by a grid (`GRID_ACROSS` nodes along its
 * longer side); each node takes the Gaussian-weighted mean of the nearby
 * cells' vectors (a width of half a grid step, as scVelo's `smooth=0.5`),
 * divided by the larger of 1 and the weight it gathered (scVelo's
 * `V_grid /= max(1, p_mass)`: a node few cells reach draws a short arrow),
 * and a node that gathered under 1% of the 99th percentile of the nodes'
 * weight draws none (scVelo's `min_mass`). The mean arrow is `MEAN_LENGTH` of
 * a grid step. An arrow is colored as the overlay colors a particle: its mean
 * speed in the embedding over the field's largest (`u_invMaxMagnitude`),
 * through the overlay's color scheme. Arrows are outlined in the figure's
 * halo, so they read on any paper.
 *
 * A key names the field, says how it is drawn and gives the speed range of
 * the colors in the embedding's units (`vectorFieldLegendKey`). With the
 * figure's legend on it is two rows of the legend, laid out with it
 * (`planLegend` `vectorKey`, `utils/layout.js`); only a figure without a
 * legend draws it inside the plot's bottom-right corner (the top corners
 * hold the selection badge and the orientation indicator), where on a small
 * plot it covered the cells (found 2026-11-11, F271 check).
 *
 * Pure: the caller hands the arrays (`figure-export-engine.js`), and the
 * builders draw one plan (`planVectorFieldFigure`), so PNG and SVG agree.
 *
 * @module ui/modules/figure-export/components/vector-field-figure
 */

import { escapeXml } from '../../../../utils/dom-utils.js';
import { createPlotPlacement, projectIntoSource } from '../utils/plot-fit.js';
import { getColormap } from '../../../../../data/palettes.js';

/** Grid nodes along the plot's longer side (scVelo's default grid is 50 × 50 at density 1). */
export const GRID_ACROSS = 40;
/** The Gaussian's width in grid steps (scVelo's `smooth`). */
const SMOOTH = 0.5;
/** A node keeps its arrow when its weight is at least this share of the 99th percentile's (scVelo's `min_mass`). */
const MIN_MASS = 0.01;
/**
 * The mean arrow, in grid steps: arrows are scaled by their mean length, as
 * matplotlib's quiver autoscale (which scVelo uses) scales them, so the
 * typical arrow reads at any spread of speeds; a fast region draws arrows
 * longer than a step, as in scVelo.
 */
const MEAN_LENGTH = 0.5;

/**
 * @typedef {object} FigureVectorField
 * @property {string} label - the field as the app names it ("velocity")
 * @property {string} colormapId - the overlay's color scheme
 * @property {Float32Array} vectors - render space, `dimension` components a cell (NaN: no vector)
 * @property {number} maxMagnitude - the field's longest vector, render space
 * @property {number} unitsPerRender - embedding units per render unit (1 / the embedding's scale)
 */

/**
 * The arrows of one plot and its key.
 *
 * @param {object} options
 * @param {FigureVectorField} options.vectorField
 * @param {Float32Array} options.positions - render space, `dimension` a cell
 * @param {number} options.dimension
 * @param {Uint8Array} options.transparency - 1: the view shows the cell
 * @param {object} options.renderState - its `mvpMatrix`, viewport size
 * @param {{x: number, y: number, width: number, height: number}} options.plotRect
 * @param {object|null} [options.crop]
 * @returns {{arrows: Array<{x0: number, y0: number, x1: number, y1: number, head: number, rgb: number[]}>,
 *   step: number, strokeWidth: number, speedMax: number, colormapId: string, label: string, cells: number}}
 */
export function planVectorFieldFigure({ vectorField, positions, dimension, transparency, renderState, plotRect, crop = null }) {
  const { label, colormapId, vectors, maxMagnitude, unitsPerRender } = vectorField;
  const { source, viewportToPlot } = createPlotPlacement({ renderState, plotRect, crop });
  const mvp = renderState.mvpMatrix;
  const origin = viewportToPlot(source.x, source.y);
  const scale = plotRect.width / source.width;
  const step = Math.max(plotRect.width, plotRect.height) / GRID_ACROSS;
  const columns = Math.max(1, Math.round(plotRect.width / step));
  const rows = Math.max(1, Math.round(plotRect.height / step));
  const stepX = plotRect.width / columns;
  const stepY = plotRect.height / rows;
  const sigma = SMOOTH * Math.min(stepX, stepY);
  const reach = 3 * sigma;
  const nodes = columns * rows;
  const mass = new Float64Array(nodes);
  const screen = new Float64Array(nodes * 2);
  const speed = new Float64Array(nodes);
  const here = new Float64Array(3);
  const ahead = new Float64Array(3);
  // A vector's image on the plot: the step to a point a small distance along
  // it, through the same projection, over that distance.
  const along = maxMagnitude > 0 ? 0.01 / maxMagnitude : 0;
  let cells = 0;
  const count = transparency.length;
  for (let i = 0; i < count; i++) {
    if (transparency[i] !== 1) continue;
    const at = i * dimension;
    let length2 = 0;
    let finite = true;
    for (let a = 0; a < dimension; a++) {
      const v = vectors[at + a];
      if (!Number.isFinite(v)) finite = false;
      length2 += v * v;
    }
    if (!finite) continue;
    const x = positions[at];
    const y = dimension > 1 ? positions[at + 1] : 0;
    const z = dimension > 2 ? positions[at + 2] : 0;
    if (!projectIntoSource(mvp, source, x, y, z, here)) continue;
    const vx = vectors[at];
    const vy = dimension > 1 ? vectors[at + 1] : 0;
    const vz = dimension > 2 ? vectors[at + 2] : 0;
    let dx = 0;
    let dy = 0;
    if (along > 0 && length2 > 0) {
      // The end may leave the source: the step is what matters, so project
      // without the bounds test.
      if (!projectUnbounded(mvp, source, x + vx * along, y + vy * along, z + vz * along, ahead)) continue;
      dx = (ahead[0] - here[0]) * scale / along;
      dy = (ahead[1] - here[1]) * scale / along;
    }
    cells++;
    const px = origin.x + here[0] * scale - plotRect.x;
    const py = origin.y + here[1] * scale - plotRect.y;
    const c0 = Math.max(0, Math.ceil((px - reach) / stepX - 0.5));
    const c1 = Math.min(columns - 1, Math.floor((px + reach) / stepX - 0.5));
    const r0 = Math.max(0, Math.ceil((py - reach) / stepY - 0.5));
    const r1 = Math.min(rows - 1, Math.floor((py + reach) / stepY - 0.5));
    const cellSpeed = Math.sqrt(length2);
    for (let r = r0; r <= r1; r++) {
      const ny = (r + 0.5) * stepY - py;
      for (let c = c0; c <= c1; c++) {
        const nx = (c + 0.5) * stepX - px;
        const d2 = nx * nx + ny * ny;
        if (d2 > reach * reach) continue;
        const w = Math.exp(-d2 / (2 * sigma * sigma));
        const node = r * columns + c;
        mass[node] += w;
        screen[node * 2] += w * dx;
        screen[node * 2 + 1] += w * dy;
        speed[node] += w * cellSpeed;
      }
    }
  }
  const empty = { arrows: [], step, strokeWidth: strokeWidthOf(step), speedMax: maxMagnitude * unitsPerRender, colormapId, label, cells };
  if (cells === 0) return empty;
  const weights = [...mass].filter(value => value > 0).sort((left, right) => left - right);
  const p99 = weights[Math.min(weights.length - 1, Math.floor(0.99 * (weights.length - 1)))];
  const floor = MIN_MASS * p99;
  let lengthSum = 0;
  let kept = 0;
  for (let node = 0; node < nodes; node++) {
    if (!(mass[node] > 0) || mass[node] < floor) continue;
    const divisor = Math.max(1, mass[node]);
    lengthSum += Math.hypot(screen[node * 2], screen[node * 2 + 1]) / divisor;
    kept++;
  }
  if (!(lengthSum > 0)) return empty;
  const lengthScale = (MEAN_LENGTH * Math.min(stepX, stepY)) / (lengthSum / kept);
  const colormap = getColormap(colormapId);
  const arrows = [];
  for (let node = 0; node < nodes; node++) {
    if (!(mass[node] > 0) || mass[node] < floor) continue;
    const divisor = Math.max(1, mass[node]);
    const ux = (screen[node * 2] / divisor) * lengthScale;
    const uy = (screen[node * 2 + 1] / divisor) * lengthScale;
    const length = Math.hypot(ux, uy);
    if (!(length > 0.05 * stepX)) continue;
    const cx = plotRect.x + ((node % columns) + 0.5) * stepX;
    const cy = plotRect.y + (Math.floor(node / columns) + 0.5) * stepY;
    // Colored as the overlay colors a particle: speed over the largest.
    const t = Math.min(1, (speed[node] / mass[node]) / maxMagnitude);
    const rgb = colormap.sample(t).map(channel => Math.round(Math.max(0, Math.min(1, channel)) * 255));
    arrows.push({
      x0: cx - ux / 2,
      y0: cy - uy / 2,
      x1: cx + ux / 2,
      y1: cy + uy / 2,
      head: Math.min(length * 0.45, 0.4 * Math.min(stepX, stepY)),
      rgb,
    });
  }
  return { ...empty, arrows };
}

function strokeWidthOf(step) {
  return Math.max(0.6, step * 0.07);
}

function projectUnbounded(mvp, source, x, y, z, out) {
  const clipW = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];
  if (!(clipW > 0) || clipW === Infinity) return false;
  out[0] = ((mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12]) / clipW * 0.5 + 0.5) * source.viewportWidth - source.x;
  out[1] = (0.5 - (mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13]) / clipW * 0.5) * source.viewportHeight - source.y;
  return true;
}

/** An arrow's head: its tip and the two corners behind it. */
function headOf(arrow) {
  const dx = arrow.x1 - arrow.x0;
  const dy = arrow.y1 - arrow.y0;
  const length = Math.hypot(dx, dy);
  const ux = dx / length;
  const uy = dy / length;
  const baseX = arrow.x1 - ux * arrow.head;
  const baseY = arrow.y1 - uy * arrow.head;
  const half = arrow.head * 0.5;
  return [arrow.x1, arrow.y1, baseX - uy * half, baseY + ux * half, baseX + uy * half, baseY - ux * half];
}

/** The shaft ends where the head begins. */
function shaftEnd(arrow) {
  const dx = arrow.x1 - arrow.x0;
  const dy = arrow.y1 - arrow.y0;
  const length = Math.hypot(dx, dy);
  return [arrow.x1 - (dx / length) * arrow.head * 0.8, arrow.y1 - (dy / length) * arrow.head * 0.8];
}

/** "1.23", "0.0045", "120": three significant digits, no exponent below 1e6. */
export function formatSpeed(value) {
  if (value === 0) return '0';
  if (value >= 100) return String(Math.round(value));
  return String(Number(value.toPrecision(3)));
}

/** The key's lines: the field and how it is drawn, then the speed range. */
export function vectorFieldKeyText(plan) {
  return [
    `${plan.label}: mean arrows of nearby cells`,
    `speed 0 – ${formatSpeed(plan.speedMax)}`,
  ];
}

/**
 * The key of a view's vector field as a legend lists it (`planLegend`
 * `vectorKey`): what the arrows are, the speed range of their colors (the
 * field's largest speed in the embedding's units) and the color scheme.
 *
 * @param {FigureVectorField} vectorField
 * @returns {{label: string, speed: string, colormapId: string}}
 */
export function vectorFieldLegendKey(vectorField) {
  const [label, speed] = vectorFieldKeyText({
    label: vectorField.label,
    speedMax: vectorField.maxMagnitude * vectorField.unitsPerRender,
  });
  return { label, speed, colormapId: vectorField.colormapId };
}

const f = value => value.toFixed(2);

/**
 * The arrows and the key as SVG markup (plot space).
 *
 * @param {ReturnType<typeof planVectorFieldFigure>} plan
 * @param {{plotRect: object, ink: object, fontFamily: string, fontSizePx: number, haloColor: string, inPlotKey: boolean}} style -
 *   `inPlotKey`: the key in the plot's corner (a figure without a legend), else none
 * @returns {string}
 */
export function renderSvgVectorField(plan, { plotRect, ink, fontFamily, fontSizePx, haloColor, inPlotKey }) {
  if (typeof inPlotKey !== 'boolean') throw new TypeError('A vector field is drawn with its key in the plot or in the legend (inPlotKey).');
  const parts = [`<g class="cellucid-vector-field" stroke-linecap="round" stroke-linejoin="round">`];
  const width = plan.strokeWidth;
  for (const arrow of plan.arrows) {
    const [sx, sy] = shaftEnd(arrow);
    const head = headOf(arrow).map(f).join(' ');
    const color = `rgb(${arrow.rgb.join(',')})`;
    const halo = escapeXml(haloColor);
    parts.push(
      `<path d="M${f(arrow.x0)} ${f(arrow.y0)}L${f(sx)} ${f(sy)}" fill="none" stroke="${halo}" stroke-width="${f(width * 2.6)}"/>`
      + `<polygon points="${head}" fill="${halo}" stroke="${halo}" stroke-width="${f(width * 1.6)}"/>`
      + `<path d="M${f(arrow.x0)} ${f(arrow.y0)}L${f(sx)} ${f(sy)}" fill="none" stroke="${color}" stroke-width="${f(width)}"/>`
      + `<polygon points="${head}" fill="${color}"/>`
    );
  }
  parts.push('</g>');
  if (inPlotKey) parts.push(renderSvgKey(plan, { plotRect, ink, fontFamily, fontSizePx }));
  return parts.join('');
}

/** Words of `text` in lines no wider than `room` (a word wider than it stands alone). */
function wrapWords(text, room, size, measure) {
  const lines = [];
  for (const word of text.split(' ')) {
    const last = lines.length - 1;
    if (last >= 0 && measure(`${lines[last]} ${word}`, size) <= room) lines[last] = `${lines[last]} ${word}`;
    else lines.push(word);
  }
  return lines;
}

/**
 * The key's box: its lines, the swatch arrow and the color ramp, in plot
 * space, inside the plot's bottom-right corner. Its text keeps the figure's
 * size (a figure set in points, `utils/figure-size.js`), so on a plot
 * narrower than the key's one line (a single-column figure: a plot of 35 mm)
 * the field's line wraps at its words to the plot's width instead of running
 * out of the plot and off the figure (found 2026-11-11, F271 check:
 * "velocity: mean arrows of nearby cells" cut at a single column's left
 * edge).
 *
 * @returns {{lines: string[], labelLines: number, size: number, pad: number, rampWidth: number, x: number, y: number, width: number, height: number}}
 *   `lines`: the field's lines (the first beside the swatch arrow), then the speed line
 */
export function planVectorFieldKey(plan, { plotRect, fontSizePx, measure }) {
  const [label, speed] = vectorFieldKeyText(plan);
  const size = Math.max(8, fontSizePx * 0.85);
  const pad = size * 0.5;
  const rampWidth = size * 5;
  const swatch = size * 2.2;
  // The room inside the plot, past the key's own padding and the swatch arrow.
  const labelRoom = plotRect.width - pad * 4 - swatch;
  const labelLines = measure(label, size) <= labelRoom ? [label] : wrapWords(label, labelRoom, size, measure);
  const lines = [...labelLines, speed];
  const textWidth = Math.max(
    ...labelLines.map(line => measure(line, size) + swatch),
    measure(speed, size) + rampWidth + size * 0.6
  );
  const width = textWidth + pad * 2;
  const height = size * (1.4 * (lines.length - 1) + 1.2) + pad * 2;
  const x = Math.max(plotRect.x + pad, plotRect.x + plotRect.width - width - pad);
  const y = Math.max(plotRect.y + pad, plotRect.y + plotRect.height - height - pad);
  return { lines, labelLines: labelLines.length, size, pad, rampWidth, x, y, width, height };
}

function estimateTextWidth(text, size) {
  // Never narrower than real glyphs (as `utils/text-measure.js` estimates).
  return text.length * size * 0.62;
}

function renderSvgKey(plan, { plotRect, ink, fontFamily, fontSizePx }) {
  if (plan.arrows.length === 0) return '';
  const key = planVectorFieldKey(plan, { plotRect, fontSizePx, measure: estimateTextWidth });
  const colormap = getColormap(plan.colormapId);
  const stops = [0, 0.25, 0.5, 0.75, 1].map(t => {
    const rgb = colormap.sample(t).map(channel => Math.round(Math.max(0, Math.min(1, channel)) * 255));
    return `<stop offset="${t}" stop-color="rgb(${rgb.join(',')})"/>`;
  }).join('');
  const gradientId = `cellucid-vector-ramp-${Math.round(key.x)}-${Math.round(key.y)}`;
  const line1 = key.y + key.pad + key.size;
  // The field's lines, then the speed line under the last of them.
  const lineAt = index => line1 + index * key.size * 1.4;
  const line2 = lineAt(key.labelLines);
  const arrowY = line1 - key.size * 0.35;
  const mid = colormap.sample(0.6).map(channel => Math.round(Math.max(0, Math.min(1, channel)) * 255));
  const ax0 = key.x + key.pad;
  const ax1 = ax0 + key.size * 1.6;
  const labelText = key.lines.slice(0, key.labelLines)
    .map((line, index) => `<text x="${f(ax1 + key.size * 0.6)}" y="${f(lineAt(index))}" fill="${escapeXml(ink.surfaceInk)}">${escapeXml(line)}</text>`)
    .join('');
  return `<g class="cellucid-vector-field-key" font-family="${escapeXml(fontFamily)}" font-size="${f(key.size)}">`
    + `<defs><linearGradient id="${gradientId}">${stops}</linearGradient></defs>`
    + `<rect x="${f(key.x)}" y="${f(key.y)}" width="${f(key.width)}" height="${f(key.height)}" rx="${f(key.size * 0.3)}" fill="${escapeXml(ink.surface)}" fill-opacity="0.85" stroke="${escapeXml(ink.frame)}"/>`
    + `<path d="M${f(ax0)} ${f(arrowY)}L${f(ax1 - key.size * 0.4)} ${f(arrowY)}" stroke="rgb(${mid.join(',')})" stroke-width="${f(Math.max(1, key.size * 0.12))}"/>`
    + `<polygon points="${f(ax1)} ${f(arrowY)} ${f(ax1 - key.size * 0.55)} ${f(arrowY - key.size * 0.3)} ${f(ax1 - key.size * 0.55)} ${f(arrowY + key.size * 0.3)}" fill="rgb(${mid.join(',')})"/>`
    + labelText
    + `<rect x="${f(ax0)}" y="${f(line2 - key.size * 0.75)}" width="${f(key.rampWidth)}" height="${f(key.size * 0.7)}" fill="url(#${gradientId})"/>`
    + `<text x="${f(ax0 + key.rampWidth + key.size * 0.6)}" y="${f(line2)}" fill="${escapeXml(ink.surfaceInk)}">${escapeXml(key.lines[key.labelLines])}</text>`
    + '</g>';
}

/**
 * The arrows and the key on a Canvas2D context (plot space).
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {ReturnType<typeof planVectorFieldFigure>} plan
 * @param {{plotRect: object, ink: object, fontFamily: string, fontSizePx: number, haloColor: string}} style
 */
export function drawCanvasVectorField(ctx, plan, { plotRect, ink, fontFamily, fontSizePx, haloColor, inPlotKey }) {
  if (typeof inPlotKey !== 'boolean') throw new TypeError('A vector field is drawn with its key in the plot or in the legend (inPlotKey).');
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const width = plan.strokeWidth;
  for (const pass of ['halo', 'color']) {
    for (const arrow of plan.arrows) {
      const [sx, sy] = shaftEnd(arrow);
      const head = headOf(arrow);
      const color = pass === 'halo' ? haloColor : `rgb(${arrow.rgb.join(',')})`;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = pass === 'halo' ? width * 2.6 : width;
      ctx.beginPath();
      ctx.moveTo(arrow.x0, arrow.y0);
      ctx.lineTo(sx, sy);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(head[0], head[1]);
      ctx.lineTo(head[2], head[3]);
      ctx.lineTo(head[4], head[5]);
      ctx.closePath();
      ctx.fill();
      if (pass === 'halo') {
        ctx.lineWidth = width * 1.6;
        ctx.stroke();
      }
    }
  }
  if (inPlotKey && plan.arrows.length > 0) {
    const key = planVectorFieldKey(plan, {
      plotRect,
      fontSizePx,
      measure: (text, size) => {
        ctx.font = `${size}px ${fontFamily}`;
        return Math.max(ctx.measureText(text).width, estimateTextWidth(text, size));
      },
    });
    const colormap = getColormap(plan.colormapId);
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = ink.surface;
    ctx.fillRect(key.x, key.y, key.width, key.height);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = ink.frame;
    ctx.lineWidth = 1;
    ctx.strokeRect(key.x, key.y, key.width, key.height);
    const line1 = key.y + key.pad + key.size;
    // The field's lines, then the speed line under the last of them.
    const lineAt = index => line1 + index * key.size * 1.4;
    const line2 = lineAt(key.labelLines);
    const arrowY = line1 - key.size * 0.35;
    const mid = `rgb(${colormap.sample(0.6).map(channel => Math.round(Math.max(0, Math.min(1, channel)) * 255)).join(',')})`;
    const ax0 = key.x + key.pad;
    const ax1 = ax0 + key.size * 1.6;
    ctx.strokeStyle = mid;
    ctx.fillStyle = mid;
    ctx.lineWidth = Math.max(1, key.size * 0.12);
    ctx.beginPath();
    ctx.moveTo(ax0, arrowY);
    ctx.lineTo(ax1 - key.size * 0.4, arrowY);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(ax1, arrowY);
    ctx.lineTo(ax1 - key.size * 0.55, arrowY - key.size * 0.3);
    ctx.lineTo(ax1 - key.size * 0.55, arrowY + key.size * 0.3);
    ctx.closePath();
    ctx.fill();
    const ramp = ctx.createLinearGradient(ax0, 0, ax0 + key.rampWidth, 0);
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      ramp.addColorStop(t, `rgb(${colormap.sample(t).map(channel => Math.round(Math.max(0, Math.min(1, channel)) * 255)).join(',')})`);
    }
    ctx.fillStyle = ramp;
    ctx.fillRect(ax0, line2 - key.size * 0.75, key.rampWidth, key.size * 0.7);
    ctx.fillStyle = ink.surfaceInk;
    ctx.font = `${key.size}px ${fontFamily}`;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    key.lines.slice(0, key.labelLines).forEach((line, index) => ctx.fillText(line, ax1 + key.size * 0.6, lineAt(index)));
    ctx.fillText(key.lines[key.labelLines], ax0 + key.rampWidth + key.size * 0.6, line2);
  }
  ctx.restore();
}

/**
 * A view's vector field as SVG, or '' when it draws none: what each SVG
 * panel calls with its own snapshot.
 *
 * @param {object} options - the view's `data` (its `vectorField`, positions,
 *   transparency), its dimension, render state, plot, crop and the figure's
 *   ink, font and halo
 * @returns {string}
 */
export function vectorFieldSvgOf({ data, dimension, renderState, plotRect, crop, ink, fontFamily, fontSizePx, haloColor, inPlotKey }) {
  if (data.vectorField === null || data.vectorField === undefined) return '';
  const plan = planVectorFieldFigure({
    vectorField: data.vectorField, positions: data.positions, dimension, transparency: data.transparency, renderState, plotRect, crop,
  });
  return renderSvgVectorField(plan, { plotRect, ink, fontFamily, fontSizePx, haloColor, inPlotKey });
}

/**
 * A view's vector field on a canvas, when it draws one: what each PNG panel
 * and the preview call with their own snapshot.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} options - as `vectorFieldSvgOf`
 */
export function drawCanvasVectorFieldOf(ctx, { data, dimension, renderState, plotRect, crop, ink, fontFamily, fontSizePx, haloColor, inPlotKey }) {
  if (data.vectorField === null || data.vectorField === undefined) return;
  const plan = planVectorFieldFigure({
    vectorField: data.vectorField, positions: data.positions, dimension, transparency: data.transparency, renderState, plotRect, crop,
  });
  drawCanvasVectorField(ctx, plan, { plotRect, ink, fontFamily, fontSizePx, haloColor, inPlotKey });
}
