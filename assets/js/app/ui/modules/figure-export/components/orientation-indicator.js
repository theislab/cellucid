/**
 * @fileoverview 3D orientation indicator for figure export (SVG + Canvas).
 *
 * For 3D exports, showing camera orientation improves reproducibility.
 * This component renders a small axis triad and (when available) orbit/freefly
 * angles in the plot corner without touching the main render loop.
 *
 * @module ui/modules/figure-export/components/orientation-indicator
 */

import { escapeHtml } from '../../../../utils/dom-utils.js';
import { clamp } from '../../../../utils/number-utils.js';

/**
 * @typedef {object} PlotRect
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

function toDegrees(rad) {
  return (Number(rad) * 180) / Math.PI;
}

function normalizeDegrees(deg) {
  let d = Number(deg);
  if (!Number.isFinite(d)) return 0;
  while (d <= -180) d += 360;
  while (d > 180) d -= 360;
  return d;
}

/**
 * Transform a world-space direction vector by the rotation part of a view matrix.
 * @param {Float32Array} viewMatrix - column-major mat4
 * @param {[number, number, number]} v - direction vector (x,y,z)
 * @returns {[number, number, number]} camera-space direction
 */
function transformDirection(viewMatrix, v) {
  const m = viewMatrix;
  const x = v[0];
  const y = v[1];
  const z = v[2];
  // Column-major mat4 × vec4(x,y,z,0) (ignore translation)
  return [
    m[0] * x + m[4] * y + m[8] * z,
    m[1] * x + m[5] * y + m[9] * z,
    m[2] * x + m[6] * y + m[10] * z,
  ];
}

function length2(x, y) {
  return Math.sqrt(x * x + y * y) || 1;
}

/**
 * Cross-browser rounded rectangle path helper.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {number} r
 */
function beginRoundRectPath(ctx, x, y, w, h, r) {
  const rr = clamp(r, 0, Math.min(w, h) / 2);
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, rr);
    return;
  }
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * @param {any} cameraState
 */
function getAngleLines(cameraState) {
  const nav = cameraState?.navigationMode || null;
  if (nav === 'orbit') {
    const theta = cameraState?.orbit?.theta ?? null;
    const phi = cameraState?.orbit?.phi ?? null;
    if (theta == null || phi == null) return [];
    const az = normalizeDegrees(toDegrees(theta));
    const el = clamp(normalizeDegrees(90 - toDegrees(phi)), -90, 90);
    return [`az ${az.toFixed(0)}°`, `el ${el.toFixed(0)}°`];
  }
  if (nav === 'free') {
    const yaw = cameraState?.freefly?.yaw ?? null;
    const pitch = cameraState?.freefly?.pitch ?? null;
    if (yaw == null || pitch == null) return [];
    const az = normalizeDegrees(toDegrees(yaw));
    const el = clamp(normalizeDegrees(toDegrees(pitch)), -90, 90);
    return [`yaw ${az.toFixed(0)}°`, `pit ${el.toFixed(0)}°`];
  }
  return [];
}

/**
 * Render a compact SVG orientation widget.
 *
 * @param {object} options
 * @param {PlotRect} options.plotRect
 * @param {Float32Array} options.viewMatrix
 * @param {any} options.cameraState
 * @param {string} [options.fontFamily]
 * @param {number} [options.fontSize]
 * @param {string} [options.textColor]
 * @returns {string}
 */
export function renderSvgOrientationIndicator({
  plotRect,
  viewMatrix,
  cameraState,
  fontFamily = 'Arial, Helvetica, sans-serif',
  fontSize = 11,
  sizePx = null,
  marginPx = null,
  padPx = null,
  textColor = '#111'
}) {
  if (!plotRect || !viewMatrix) return '';

  const fs = clamp(Math.round(Number(fontSize) || 11), 6, 48);
  const margin = clamp(Math.round(Number.isFinite(marginPx) ? marginPx : (fs * 0.9)), 8, 18);
  const maxSize = Math.floor(Math.min(plotRect.width, plotRect.height) - margin * 2);
  if (!Number.isFinite(maxSize) || maxSize < 50) return '';

  const suggestedSize = Number.isFinite(sizePx) ? sizePx : (fs * 6.5);
  const size = clamp(Math.round(suggestedSize), 76, Math.min(160, maxSize));
  const pad = clamp(Math.round(Number.isFinite(padPx) ? padPx : (fs * 0.7)), 6, Math.max(6, Math.round(size * 0.18)));
  const axisStrokeWidth = Math.max(2, Math.round(fs / 5));
  const cornerR = clamp(Math.round(fs * 0.55), 6, 10);
  const x = plotRect.x + plotRect.width - size - margin;
  const y = plotRect.y + margin;
  const cx = x + size / 2;
  const lines = getAngleLines(cameraState);
  const lineH = Math.max(10, Math.round(fs * 1.15));
  const textBlockH = lines.length ? (lines.length * lineH + 4) : 0;
  const triadH = Math.max(1, size - pad * 2 - textBlockH);
  const cy = y + pad + triadH / 2;
  const radius = Math.max(10, Math.min(size - pad * 2, triadH) * 0.38);

  const xDir = transformDirection(viewMatrix, [1, 0, 0]);
  const yDir = transformDirection(viewMatrix, [0, 1, 0]);
  const zDir = transformDirection(viewMatrix, [0, 0, 1]);

  const axes = [
    { name: 'X', v: xDir, color: '#ef4444' },
    { name: 'Y', v: yDir, color: '#22c55e' },
    { name: 'Z', v: zDir, color: '#3b82f6' },
  ];

  // Sort so axes pointing "away" are drawn first (subtle depth cue).
  axes.sort((a, b) => (b.v[2] || 0) - (a.v[2] || 0));

  const parts = [];
  parts.push(`<g font-family="${escapeHtml(fontFamily)}" font-size="${fs}" fill="${escapeHtml(textColor)}">`);
  parts.push(`<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${cornerR}" fill="rgba(255,255,255,0.85)" stroke="#e5e7eb" stroke-width="1"/>`);

  for (const axis of axes) {
    const vx = axis.v[0];
    const vy = axis.v[1];
    const vz = axis.v[2];
    const len = length2(vx, vy);
    const dx = (vx / len) * radius;
    const dy = (-vy / len) * radius;
    const opacity = clamp(0.35 + (1 - (vz + 1) / 2) * 0.65, 0.35, 1);
    const x2 = cx + dx;
    const y2 = cy + dy;
    const ux = dx / Math.max(1e-6, radius);
    const uy = dy / Math.max(1e-6, radius);
    const labelPad = clamp(Math.round(fs * 0.55), 5, 10);
    const lx = x2 + ux * labelPad;
    const ly = y2 + uy * labelPad;
    const anchor = ux > 0.25 ? 'start' : (ux < -0.25 ? 'end' : 'middle');
    parts.push(`<line x1="${cx}" y1="${cy}" x2="${x2}" y2="${y2}" stroke="${axis.color}" stroke-width="${axisStrokeWidth}" stroke-linecap="round" opacity="${opacity.toFixed(3)}"/>`);
    parts.push(`<text x="${lx}" y="${ly}" text-anchor="${anchor}" dominant-baseline="middle" fill="${axis.color}" font-weight="600" opacity="${opacity.toFixed(3)}" stroke="none">${axis.name}</text>`);
  }

  if (lines.length) {
    const baseY = y + size - pad;
    for (let i = 0; i < lines.length; i++) {
      const textY = baseY - (lines.length - 1 - i) * lineH;
      parts.push(`<text x="${x + size / 2}" y="${textY}" text-anchor="middle" fill="#111" stroke="none">${escapeHtml(lines[i])}</text>`);
    }
  }

  parts.push(`</g>`);
  return parts.join('');
}

/**
 * Draw a compact orientation widget on Canvas2D.
 *
 * @param {object} options
 * @param {CanvasRenderingContext2D} options.ctx
 * @param {PlotRect} options.plotRect
 * @param {Float32Array} options.viewMatrix
 * @param {any} options.cameraState
 * @param {string} [options.fontFamily]
 * @param {number} [options.fontSize]
 */
export function drawCanvasOrientationIndicator({
  ctx,
  plotRect,
  viewMatrix,
  cameraState,
  fontFamily = 'Arial, Helvetica, sans-serif',
  fontSize = 11,
  sizePx = null,
  marginPx = null,
  padPx = null
}) {
  if (!ctx || !plotRect || !viewMatrix) return;

  const fs = clamp(Math.round(Number(fontSize) || 11), 6, 48);
  const margin = clamp(Math.round(Number.isFinite(marginPx) ? marginPx : (fs * 0.9)), 8, 18);
  const maxSize = Math.floor(Math.min(plotRect.width, plotRect.height) - margin * 2);
  if (!Number.isFinite(maxSize) || maxSize < 50) return;

  const suggestedSize = Number.isFinite(sizePx) ? sizePx : (fs * 6.5);
  const size = clamp(Math.round(suggestedSize), 76, Math.min(160, maxSize));
  const pad = clamp(Math.round(Number.isFinite(padPx) ? padPx : (fs * 0.7)), 6, Math.max(6, Math.round(size * 0.18)));
  const axisStrokeWidth = Math.max(2, Math.round(fs / 5));
  const cornerR = clamp(Math.round(fs * 0.55), 6, 10);
  const x = plotRect.x + plotRect.width - size - margin;
  const y = plotRect.y + margin;
  const cx = x + size / 2;
  const lines = getAngleLines(cameraState);
  const lineH = Math.max(10, Math.round(fs * 1.15));
  const textBlockH = lines.length ? (lines.length * lineH + 4) : 0;
  const triadH = Math.max(1, size - pad * 2 - textBlockH);
  const cy = y + pad + triadH / 2;
  const radius = Math.max(10, Math.min(size - pad * 2, triadH) * 0.38);

  const xDir = transformDirection(viewMatrix, [1, 0, 0]);
  const yDir = transformDirection(viewMatrix, [0, 1, 0]);
  const zDir = transformDirection(viewMatrix, [0, 0, 1]);

  const axes = [
    { name: 'X', v: xDir, color: '#ef4444' },
    { name: 'Y', v: yDir, color: '#22c55e' },
    { name: 'Z', v: zDir, color: '#3b82f6' },
  ];
  axes.sort((a, b) => (b.v[2] || 0) - (a.v[2] || 0));

  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.strokeStyle = '#e5e7eb';
  ctx.lineWidth = 1;
  beginRoundRectPath(ctx, x, y, size, size, cornerR);
  ctx.fill();
  ctx.stroke();

  for (const axis of axes) {
    const vx = axis.v[0];
    const vy = axis.v[1];
    const vz = axis.v[2];
    const len = length2(vx, vy);
    const dx = (vx / len) * radius;
    const dy = (-vy / len) * radius;
    const opacity = clamp(0.35 + (1 - (vz + 1) / 2) * 0.65, 0.35, 1);
    const x2 = cx + dx;
    const y2 = cy + dy;
    ctx.globalAlpha = opacity;
    ctx.strokeStyle = axis.color;
    ctx.lineWidth = axisStrokeWidth;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    const ux = dx / Math.max(1e-6, radius);
    const uy = dy / Math.max(1e-6, radius);
    const labelPad = clamp(Math.round(fs * 0.55), 5, 10);
    const lx = x2 + ux * labelPad;
    const ly = y2 + uy * labelPad;
    ctx.fillStyle = axis.color;
    ctx.font = `600 ${fs}px ${fontFamily}`;
    ctx.textAlign = ux > 0.25 ? 'left' : (ux < -0.25 ? 'right' : 'center');
    ctx.textBaseline = 'middle';
    ctx.fillText(axis.name, lx, ly);
  }

  ctx.globalAlpha = 1;
  if (lines.length) {
    ctx.fillStyle = '#111';
    ctx.font = `${fs}px ${fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const baseY = y + size - pad;
    for (let i = 0; i < lines.length; i++) {
      const textY = baseY - (lines.length - 1 - i) * lineH;
      ctx.fillText(lines[i], x + size / 2, textY);
    }
  }

  ctx.restore();
}
