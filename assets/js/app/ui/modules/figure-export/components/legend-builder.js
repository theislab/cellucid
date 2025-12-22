/**
 * @fileoverview Legend builders for figure export (SVG + Canvas).
 *
 * The legend model is sourced from DataState.getLegendModel(field) to ensure
 * DRY, color-consistent behavior across the app.
 *
 * Category legends are laid out in multiple columns as needed to show all
 * entries (never “+N more” truncation).
 *
 * @module ui/modules/figure-export/components/legend-builder
 */

import { formatTick } from '../utils/tick-calculator.js';
import { escapeHtml } from '../../../../utils/dom-utils.js';

/**
 * @typedef {object} Rect
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

function rgb01ToCss(color01) {
  const r = Math.round((color01?.[0] ?? 0) * 255);
  const g = Math.round((color01?.[1] ?? 0) * 255);
  const b = Math.round((color01?.[2] ?? 0) * 255);
  return `rgb(${r},${g},${b})`;
}

/**
 * Parse a CSS stop string like "rgb(68,1,84) 0%".
 * @param {string} stop
 */
function parseCssStop(stop) {
  const parts = String(stop || '').trim().split(/\s+/);
  if (parts.length < 2) return null;
  const color = parts.slice(0, parts.length - 1).join(' ');
  const offset = parts[parts.length - 1];
  return { color, offset };
}

function estimateTextWidthPxApprox(text, fontSizePx) {
  // SVG has no cheap/portable text measurement; use a conservative average width.
  return String(text ?? '').length * fontSizePx * 0.62;
}

function truncateTextApprox(text, maxWidthPx, fontSizePx) {
  const s = String(text ?? '');
  if (maxWidthPx <= 0) return '';
  if (estimateTextWidthPxApprox(s, fontSizePx) <= maxWidthPx) return s;
  const ell = '…';
  const charW = Math.max(0.0001, fontSizePx * 0.62);
  const maxChars = Math.max(0, Math.floor(maxWidthPx / charW) - 1);
  if (maxChars <= 0) return ell;
  return s.slice(0, maxChars) + ell;
}

function truncateCanvasTextToWidth(ctx, text, maxWidthPx) {
  const s = String(text ?? '');
  if (maxWidthPx <= 0) return '';
  if (ctx.measureText(s).width <= maxWidthPx) return s;
  const ell = '…';
  if (ctx.measureText(ell).width > maxWidthPx) return '';

  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const cand = s.slice(0, mid) + ell;
    if (ctx.measureText(cand).width <= maxWidthPx) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo) + ell;
}

/**
 * Render an SVG legend. Returns `{ svg, defs }` where defs may include gradients.
 *
 * @param {object} options
 * @param {Rect} options.legendRect
 * @param {string|null} options.fieldKey
 * @param {any} options.model - legend model from DataState.getLegendModel
 * @param {string} [options.fontFamily]
 * @param {number} [options.fontSize]
 * @param {string} [options.idPrefix]
 */
export function renderSvgLegend({
  legendRect,
  fieldKey,
  model,
  fontFamily = 'Arial, Helvetica, sans-serif',
  fontSize = 12,
  idPrefix = 'legend',
  backgroundFill = '#ffffff'
}) {
  if (!legendRect || !model) return { svg: '', defs: '' };

  const x = legendRect.x;
  const y = legendRect.y;
  const w = legendRect.width;
  const h = legendRect.height;

  const padding = 8;
  const lineH = Math.max(14, Math.round(fontSize * 1.2));

  const parts = [];
  const defs = [];

  parts.push(`<g font-family="${fontFamily}" font-size="${fontSize}" fill="#111">`);
  const fill = backgroundFill === 'transparent' ? 'none' : backgroundFill;
  parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${escapeHtml(fill)}" stroke="#e5e7eb" stroke-width="1"/>`);

  const title = fieldKey ? String(fieldKey) : (model.kind === 'continuous' ? 'Color scale' : 'Legend');
  parts.push(`<text x="${x + padding}" y="${y + padding + fontSize}" font-weight="600">${escapeHtml(title)}</text>`);

  let cursorY = y + padding + fontSize + 8;

  if (model.kind === 'category') {
    const categories = model.categories || [];
    const colors = model.colors || [];
    const swatch = 10;
    const listTop = cursorY;
    const listBottom = y + h - padding;
    const availH = Math.max(1, listBottom - listTop);
    const rowsPerCol = Math.max(1, Math.floor(availH / lineH));
    const cols = Math.max(1, Math.ceil(categories.length / rowsPerCol));
    const colW = Math.max(1, (w - padding * 2) / cols);

    for (let i = 0; i < categories.length; i++) {
      const col = Math.floor(i / rowsPerCol);
      const row = i % rowsPerCol;
      const itemX = x + padding + col * colW;
      const itemY = listTop + row * lineH;

      const labelX = itemX + swatch + 6;
      const colRight = x + padding + (col + 1) * colW;
      const maxLabelW = Math.max(0, colRight - labelX - 2);

      const label = truncateTextApprox(String(categories[i] ?? ''), maxLabelW, fontSize);
      const colorCss = rgb01ToCss(colors[i]);
      parts.push(`<rect x="${itemX}" y="${itemY}" width="${swatch}" height="${swatch}" fill="${colorCss}" stroke="#111" stroke-width="0.25"/>`);
      parts.push(`<text x="${labelX}" y="${itemY + swatch}" dominant-baseline="ideographic">${escapeHtml(label)}</text>`);
    }
  } else if (model.kind === 'continuous') {
    const gradId = `${idPrefix}_grad`;
    const stops = (model.colorStops || []).map(parseCssStop).filter(Boolean);
    defs.push(`<linearGradient id="${gradId}" x1="0" x2="1" y1="0" y2="0">`);
    for (const s of stops) {
      defs.push(`<stop offset="${s.offset}" stop-color="${s.color}"/>`);
    }
    defs.push(`</linearGradient>`);

    const barH = 12;
    const barW = Math.max(40, w - padding * 2);
    parts.push(`<rect x="${x + padding}" y="${cursorY}" width="${barW}" height="${barH}" fill="url(#${gradId})" stroke="#111" stroke-width="0.5"/>`);
    cursorY += barH + 6;

    const min = model.colorbar?.min ?? model.stats?.min;
    const max = model.colorbar?.max ?? model.stats?.max;
    const minText = formatTick(Number(min));
    const maxText = formatTick(Number(max));
    parts.push(`<text x="${x + padding}" y="${cursorY + fontSize}" fill="#555">${minText}</text>`);
    parts.push(`<text x="${x + padding + barW}" y="${cursorY + fontSize}" text-anchor="end" fill="#555">${maxText}</text>`);
  }

  parts.push(`</g>`);

  return { svg: parts.join(''), defs: defs.length ? `<defs>${defs.join('')}</defs>` : '' };
}

/**
 * Draw a legend onto a Canvas2D context.
 *
 * @param {object} options
 * @param {CanvasRenderingContext2D} options.ctx
 * @param {Rect} options.legendRect
 * @param {string|null} options.fieldKey
 * @param {any} options.model
 * @param {string} [options.fontFamily]
 * @param {number} [options.fontSize]
 */
export function drawCanvasLegend({
  ctx,
  legendRect,
  fieldKey,
  model,
  fontFamily = 'Arial, Helvetica, sans-serif',
  fontSize = 12,
  backgroundFill = '#ffffff'
}) {
  if (!ctx || !legendRect || !model) return;

  const x = legendRect.x;
  const y = legendRect.y;
  const w = legendRect.width;
  const h = legendRect.height;

  const padding = 8;
  const lineH = Math.max(14, Math.round(fontSize * 1.2));

  ctx.save();
  if (backgroundFill !== 'transparent') {
    ctx.fillStyle = backgroundFill;
    ctx.fillRect(x, y, w, h);
  }
  ctx.strokeStyle = '#e5e7eb';
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);

  ctx.fillStyle = '#111';
  ctx.font = `600 ${fontSize}px ${fontFamily}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const title = fieldKey ? String(fieldKey) : (model.kind === 'continuous' ? 'Color scale' : 'Legend');
  ctx.fillText(title, x + padding, y + padding + fontSize);

  let cursorY = y + padding + fontSize + 8;
  ctx.font = `${fontSize}px ${fontFamily}`;

  if (model.kind === 'category') {
    const categories = model.categories || [];
    const colors = model.colors || [];
    const swatch = 10;

    const listTop = cursorY;
    const listBottom = y + h - padding;
    const availH = Math.max(1, listBottom - listTop);
    const rowsPerCol = Math.max(1, Math.floor(availH / lineH));
    const cols = Math.max(1, Math.ceil(categories.length / rowsPerCol));
    const colW = Math.max(1, (w - padding * 2) / cols);

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();

    for (let i = 0; i < categories.length; i++) {
      const col = Math.floor(i / rowsPerCol);
      const row = i % rowsPerCol;
      const itemX = x + padding + col * colW;
      const itemY = listTop + row * lineH;
      const labelX = itemX + swatch + 6;
      const colRight = x + padding + (col + 1) * colW;
      const maxLabelW = Math.max(0, colRight - labelX - 2);

      ctx.fillStyle = rgb01ToCss(colors[i]);
      ctx.fillRect(itemX, itemY, swatch, swatch);
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(itemX, itemY, swatch, swatch);

      ctx.fillStyle = '#111';
      const label = truncateCanvasTextToWidth(ctx, String(categories[i] ?? ''), maxLabelW);
      ctx.fillText(label, labelX, itemY + swatch);
    }
    ctx.restore();
  } else if (model.kind === 'continuous') {
    const barH = 12;
    const barW = Math.max(40, w - padding * 2);
    const grad = ctx.createLinearGradient(x + padding, 0, x + padding + barW, 0);
    const stops = (model.colorStops || []).map(parseCssStop).filter(Boolean);
    for (const s of stops) {
      const pct = Number(String(s.offset).replace('%', '')) / 100;
      if (Number.isFinite(pct)) grad.addColorStop(pct, s.color);
    }
    ctx.fillStyle = grad;
    ctx.fillRect(x + padding, cursorY, barW, barH);
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(x + padding, cursorY, barW, barH);
    cursorY += barH + 6;

    const min = model.colorbar?.min ?? model.stats?.min;
    const max = model.colorbar?.max ?? model.stats?.max;
    ctx.fillStyle = '#555';
    ctx.textAlign = 'left';
    ctx.fillText(formatTick(Number(min)), x + padding, cursorY + fontSize);
    ctx.textAlign = 'right';
    ctx.fillText(formatTick(Number(max)), x + padding + barW, cursorY + fontSize);
  }

  ctx.restore();
}
