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
  textColor = '#111'
}) {
  if (!plotRect || !viewMatrix) return '';

  const size = 64;
  const margin = 10;
  const x = plotRect.x + plotRect.width - size - margin;
  const y = plotRect.y + margin;
  const cx = x + size / 2;
  const cy = y + size / 2;
  const radius = size * 0.34;

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
  parts.push(`<g font-family="${escapeHtml(fontFamily)}" font-size="${fontSize}" fill="${escapeHtml(textColor)}">`);
  parts.push(`<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="6" fill="rgba(255,255,255,0.85)" stroke="#e5e7eb" stroke-width="1"/>`);

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
    parts.push(`<line x1="${cx}" y1="${cy}" x2="${x2}" y2="${y2}" stroke="${axis.color}" stroke-width="2" stroke-linecap="round" opacity="${opacity.toFixed(3)}"/>`);
    parts.push(`<text x="${x2 + 2}" y="${y2 + 4}" fill="${axis.color}" font-weight="600" opacity="${opacity.toFixed(3)}" stroke="none">${axis.name}</text>`);
  }

  const lines = getAngleLines(cameraState);
  if (lines.length) {
    const textY = y + size - 8;
    const line = lines.join(' · ');
    parts.push(`<text x="${x + size / 2}" y="${textY}" text-anchor="middle" fill="#111" stroke="none">${escapeHtml(line)}</text>`);
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
  fontSize = 11
}) {
  if (!ctx || !plotRect || !viewMatrix) return;

  const size = 64;
  const margin = 10;
  const x = plotRect.x + plotRect.width - size - margin;
  const y = plotRect.y + margin;
  const cx = x + size / 2;
  const cy = y + size / 2;
  const radius = size * 0.34;

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
  beginRoundRectPath(ctx, x, y, size, size, 6);
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
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.fillStyle = axis.color;
    ctx.font = `600 ${fontSize}px ${fontFamily}`;
    ctx.fillText(axis.name, x2 + 2, y2 + 4);
  }

  ctx.globalAlpha = 1;
  const lines = getAngleLines(cameraState);
  if (lines.length) {
    ctx.fillStyle = '#111';
    ctx.font = `${fontSize}px ${fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(lines.join(' · '), x + size / 2, y + size - 8);
  }

  ctx.restore();
}
