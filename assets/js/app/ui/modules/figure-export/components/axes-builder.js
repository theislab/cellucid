/**
 * @fileoverview Axis builders for figure export (SVG + Canvas).
 *
 * Produces crisp axes, ticks, and labels for 2D exports.
 *
 * Note: The axis bounds are supplied by the caller (typically computed from
 * denormalized coordinates of currently visible points).
 *
 * @module ui/modules/figure-export/components/axes-builder
 */

import { niceNumbers, formatTick } from '../utils/tick-calculator.js';
import { escapeHtml } from '../../../../utils/dom-utils.js';

/**
 * @typedef {object} AxisBounds
 * @property {number} minX
 * @property {number} maxX
 * @property {number} minY
 * @property {number} maxY
 */

/**
 * @typedef {object} PlotRect
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/**
 * @param {AxisBounds} bounds
 * @param {number} [targetTicks=5]
 */
export function buildAxesModel(bounds, targetTicks = 5) {
  const x = niceNumbers(bounds.minX, bounds.maxX, targetTicks);
  const y = niceNumbers(bounds.minY, bounds.maxY, targetTicks);
  return {
    xTicks: x.ticks,
    yTicks: y.ticks,
    xNice: { min: x.niceMin, max: x.niceMax },
    yNice: { min: y.niceMin, max: y.niceMax },
  };
}

/**
 * Render SVG axes for the given plot rectangle.
 *
 * @param {object} options
 * @param {PlotRect} options.plotRect
 * @param {AxisBounds} options.bounds
 * @param {string} [options.xLabel]
 * @param {string} [options.yLabel]
 * @param {string} [options.fontFamily]
 * @param {number} [options.fontSize]
 * @param {string} [options.color]
 */
export function renderSvgAxes({
  plotRect,
  bounds,
  xLabel = 'X',
  yLabel = 'Y',
  fontFamily = 'Arial, Helvetica, sans-serif',
  fontSize = 12,
  color = '#111'
}) {
  const model = buildAxesModel(bounds, 5);
  const axisColor = color;
  const tickLen = 5;
  const labelOffset = 12;
  const tickTextOffset = 8;

  const x0 = plotRect.x;
  const x1 = plotRect.x + plotRect.width;
  const y0 = plotRect.y;
  const y1 = plotRect.y + plotRect.height;

  const parts = [];
  parts.push(`<g font-family="${fontFamily}" font-size="${fontSize}" fill="${axisColor}" stroke="${axisColor}" stroke-width="1">`);

  // Axis lines (bottom + left).
  parts.push(`<line x1="${x0}" y1="${y1}" x2="${x1}" y2="${y1}"/>`);
  parts.push(`<line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y1}"/>`);

  const spanX = model.xNice.max - model.xNice.min || 1;
  for (const t of model.xTicks) {
    const frac = (t - model.xNice.min) / spanX;
    const x = x0 + frac * plotRect.width;
    parts.push(`<line x1="${x}" y1="${y1}" x2="${x}" y2="${y1 + tickLen}"/>`);
    parts.push(
      `<text x="${x}" y="${y1 + tickLen + tickTextOffset}" text-anchor="middle" stroke="none">${formatTick(t)}</text>`
    );
  }

  const spanY = model.yNice.max - model.yNice.min || 1;
  for (const t of model.yTicks) {
    const frac = (t - model.yNice.min) / spanY;
    const y = y1 - frac * plotRect.height;
    parts.push(`<line x1="${x0}" y1="${y}" x2="${x0 - tickLen}" y2="${y}"/>`);
    parts.push(
      `<text x="${x0 - tickLen - tickTextOffset}" y="${y + 4}" text-anchor="end" stroke="none">${formatTick(t)}</text>`
    );
  }

  // Axis labels.
  parts.push(
    `<text x="${(x0 + x1) / 2}" y="${y1 + tickLen + tickTextOffset + labelOffset}" text-anchor="middle" stroke="none">${escapeHtml(String(xLabel || ''))}</text>`
  );
  parts.push(
    `<text x="${x0 - tickLen - tickTextOffset - labelOffset}" y="${(y0 + y1) / 2}" text-anchor="middle" stroke="none" transform="rotate(-90 ${x0 - tickLen - tickTextOffset - labelOffset} ${(y0 + y1) / 2})">${escapeHtml(String(yLabel || ''))}</text>`
  );

  parts.push(`</g>`);
  return parts.join('');
}

/**
 * Draw axes onto a Canvas2D context.
 *
 * @param {object} options
 * @param {CanvasRenderingContext2D} options.ctx
 * @param {PlotRect} options.plotRect
 * @param {AxisBounds} options.bounds
 * @param {string} [options.xLabel]
 * @param {string} [options.yLabel]
 * @param {string} [options.fontFamily]
 * @param {number} [options.fontSize]
 * @param {string} [options.color]
 */
export function drawCanvasAxes({
  ctx,
  plotRect,
  bounds,
  xLabel = 'X',
  yLabel = 'Y',
  fontFamily = 'Arial, Helvetica, sans-serif',
  fontSize = 12,
  color = '#111'
}) {
  const model = buildAxesModel(bounds, 5);
  const tickLen = 5;
  const labelOffset = 12;
  const tickTextOffset = 8;

  const x0 = plotRect.x;
  const x1 = plotRect.x + plotRect.width;
  const y0 = plotRect.y;
  const y1 = plotRect.y + plotRect.height;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1;
  ctx.font = `${fontSize}px ${fontFamily}`;
  ctx.textBaseline = 'alphabetic';

  // Axis lines.
  ctx.beginPath();
  ctx.moveTo(x0, y1);
  ctx.lineTo(x1, y1);
  ctx.moveTo(x0, y0);
  ctx.lineTo(x0, y1);
  ctx.stroke();

  const spanX = model.xNice.max - model.xNice.min || 1;
  for (const t of model.xTicks) {
    const frac = (t - model.xNice.min) / spanX;
    const x = x0 + frac * plotRect.width;
    ctx.beginPath();
    ctx.moveTo(x, y1);
    ctx.lineTo(x, y1 + tickLen);
    ctx.stroke();
    const label = formatTick(t);
    ctx.textAlign = 'center';
    ctx.fillText(label, x, y1 + tickLen + tickTextOffset);
  }

  const spanY = model.yNice.max - model.yNice.min || 1;
  for (const t of model.yTicks) {
    const frac = (t - model.yNice.min) / spanY;
    const y = y1 - frac * plotRect.height;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x0 - tickLen, y);
    ctx.stroke();
    const label = formatTick(t);
    ctx.textAlign = 'right';
    ctx.fillText(label, x0 - tickLen - 2, y + 4);
  }

  // Axis labels.
  ctx.textAlign = 'center';
  ctx.fillText(xLabel, (x0 + x1) / 2, y1 + tickLen + tickTextOffset + labelOffset);

  ctx.save();
  ctx.translate(x0 - tickLen - tickTextOffset - labelOffset, (y0 + y1) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillText(yLabel, 0, 0);
  ctx.restore();

  ctx.restore();
}
