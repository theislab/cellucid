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
 * @param {number} [options.tickFontSize]
 * @param {number} [options.labelFontSize]
 * @param {number} [options.axisGapPx] - Gap between plot frame and axes (px)
 * @param {string} [options.color]
 */
export function renderSvgAxes({
  plotRect,
  bounds,
  xLabel = 'X',
  yLabel = 'Y',
  fontFamily = 'Arial, Helvetica, sans-serif',
  tickFontSize = null,
  labelFontSize = null,
  axisGapPx = 6,
  color = '#111'
}) {
  const tickSize = Math.max(6, Math.round(Number(tickFontSize) || 12));
  const labelSize = Number.isFinite(labelFontSize) ? Math.max(6, Math.round(labelFontSize)) : tickSize;
  const model = buildAxesModel(bounds, 5);
  const axisColor = color;
  const axisGap = Math.max(0, Math.round(Number(axisGapPx) || 0));
  const tickLen = 5;
  const labelOffset = Math.max(12, Math.round(labelSize * 1.15));
  const tickTextOffset = 8;
  const xLabelText = String(xLabel ?? '').trim();
  const yLabelText = String(yLabel ?? '').trim();

  const x0 = plotRect.x;
  const x1 = plotRect.x + plotRect.width;
  const y0 = plotRect.y;
  const y1 = plotRect.y + plotRect.height;
  const axisX = x0 - axisGap;
  const axisY = y1 + axisGap;

  const parts = [];
  parts.push(`<g font-family="${fontFamily}" font-size="${tickSize}" fill="${axisColor}" stroke="${axisColor}" stroke-width="1">`);

  // Axis lines (bottom + left).
  parts.push(`<line x1="${x0}" y1="${axisY}" x2="${x1}" y2="${axisY}"/>`);
  parts.push(`<line x1="${axisX}" y1="${y0}" x2="${axisX}" y2="${y1}"/>`);

  const spanX = model.xNice.max - model.xNice.min || 1;
  for (const t of model.xTicks) {
    const frac = (t - model.xNice.min) / spanX;
    const x = x0 + frac * plotRect.width;
    parts.push(`<line x1="${x}" y1="${axisY}" x2="${x}" y2="${axisY + tickLen}"/>`);
    parts.push(
      `<text x="${x}" y="${axisY + tickLen + tickTextOffset}" text-anchor="middle" stroke="none">${formatTick(t)}</text>`
    );
  }

  const spanY = model.yNice.max - model.yNice.min || 1;
  for (const t of model.yTicks) {
    const frac = (t - model.yNice.min) / spanY;
    const y = y1 - frac * plotRect.height;
    parts.push(`<line x1="${axisX}" y1="${y}" x2="${axisX - tickLen}" y2="${y}"/>`);
    parts.push(
      `<text x="${axisX - tickLen - tickTextOffset}" y="${y + 4}" text-anchor="end" stroke="none">${formatTick(t)}</text>`
    );
  }

  // Axis labels.
  if (xLabelText) {
    parts.push(
      `<text x="${(x0 + x1) / 2}" y="${axisY + tickLen + tickTextOffset + labelOffset}" text-anchor="middle" stroke="none" font-size="${labelSize}">${escapeHtml(xLabelText)}</text>`
    );
  }
  if (yLabelText) {
    const lx = axisX - tickLen - tickTextOffset - labelOffset;
    const ly = (y0 + y1) / 2;
    parts.push(
      `<text x="${lx}" y="${ly}" text-anchor="middle" stroke="none" font-size="${labelSize}" transform="rotate(-90 ${lx} ${ly})">${escapeHtml(yLabelText)}</text>`
    );
  }

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
 * @param {number} [options.tickFontSize]
 * @param {number} [options.labelFontSize]
 * @param {number} [options.axisGapPx] - Gap between plot frame and axes (px)
 * @param {string} [options.color]
 */
export function drawCanvasAxes({
  ctx,
  plotRect,
  bounds,
  xLabel = 'X',
  yLabel = 'Y',
  fontFamily = 'Arial, Helvetica, sans-serif',
  tickFontSize = null,
  labelFontSize = null,
  axisGapPx = 6,
  color = '#111'
}) {
  const tickSize = Math.max(6, Math.round(Number(tickFontSize) || 12));
  const labelSize = Number.isFinite(labelFontSize) ? Math.max(6, Math.round(labelFontSize)) : tickSize;
  const model = buildAxesModel(bounds, 5);
  const axisGap = Math.max(0, Math.round(Number(axisGapPx) || 0));
  const tickLen = 5;
  const labelOffset = Math.max(12, Math.round(labelSize * 1.15));
  const tickTextOffset = 8;
  const xLabelText = String(xLabel ?? '').trim();
  const yLabelText = String(yLabel ?? '').trim();

  const x0 = plotRect.x;
  const x1 = plotRect.x + plotRect.width;
  const y0 = plotRect.y;
  const y1 = plotRect.y + plotRect.height;
  const axisX = x0 - axisGap;
  const axisY = y1 + axisGap;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1;
  ctx.font = `${tickSize}px ${fontFamily}`;
  ctx.textBaseline = 'alphabetic';

  // Axis lines.
  ctx.beginPath();
  ctx.moveTo(x0, axisY);
  ctx.lineTo(x1, axisY);
  ctx.moveTo(axisX, y0);
  ctx.lineTo(axisX, y1);
  ctx.stroke();

  const spanX = model.xNice.max - model.xNice.min || 1;
  for (const t of model.xTicks) {
    const frac = (t - model.xNice.min) / spanX;
    const x = x0 + frac * plotRect.width;
    ctx.beginPath();
    ctx.moveTo(x, axisY);
    ctx.lineTo(x, axisY + tickLen);
    ctx.stroke();
    const label = formatTick(t);
    ctx.textAlign = 'center';
    ctx.fillText(label, x, axisY + tickLen + tickTextOffset);
  }

  const spanY = model.yNice.max - model.yNice.min || 1;
  for (const t of model.yTicks) {
    const frac = (t - model.yNice.min) / spanY;
    const y = y1 - frac * plotRect.height;
    ctx.beginPath();
    ctx.moveTo(axisX, y);
    ctx.lineTo(axisX - tickLen, y);
    ctx.stroke();
    const label = formatTick(t);
    ctx.textAlign = 'right';
    ctx.fillText(label, axisX - tickLen - 2, y + 4);
  }

  // Axis labels.
  if (xLabelText || yLabelText) {
    ctx.font = `${labelSize}px ${fontFamily}`;
    ctx.textAlign = 'center';
  }
  if (xLabelText) {
    ctx.fillText(xLabelText, (x0 + x1) / 2, axisY + tickLen + tickTextOffset + labelOffset);
  }
  if (yLabelText) {
    ctx.save();
    ctx.translate(axisX - tickLen - tickTextOffset - labelOffset, (y0 + y1) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText(yLabelText, 0, 0);
    ctx.restore();
  }

  ctx.restore();
}
