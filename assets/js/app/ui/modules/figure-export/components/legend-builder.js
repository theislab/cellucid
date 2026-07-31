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
import { LIGHT_INK } from '../utils/figure-ink.js';
import { escapeHtml } from '../../../../utils/dom-utils.js';
import {
  areLegendModelsSemanticallyEqual,
} from '../utils/legend-model-equality.js';

/**
 * @typedef {object} Rect
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/**
 * Suffix marking a category that is not drawn in the exported figure.
 *
 * Hidden categories are marked rather than dropped. Dropping them would make a
 * filtered view indistinguishable from a complete one: a reader seeing nine of
 * twelve cell types with no trace of the other three concludes the panel shows
 * the whole composition of the tissue. Marking keeps the fact of the filtering
 * inside the figure, where a reader who never saw the app can find it.
 */
export const HIDDEN_LEGEND_ENTRY_SUFFIX = ' (hidden)';

/**
 * Legend ink follows the figure's paper, not a fixed near-black: a legend
 * written in `#111` on a dark-background figure cannot be read at all.
 * `utils/figure-ink.js` owns both palettes.
 */

/** Gap between the colorbar endpoint row and the scale note. */
const SCALE_NOTE_GAP = 4;

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
 * Is this category excluded from the drawn points?
 *
 * @param {any} model
 * @param {number} index
 */
export function isCategoryHidden(model, index) {
  const visible = model?.visible;
  if (visible === null || typeof visible !== 'object') return false;
  return visible[index] === false;
}

/**
 * Compose one category legend label.
 *
 * The hidden marker is reserved out of the available width before the name is
 * shortened, so a narrow column can never truncate away the one word that says
 * the entry is not in the figure. SVG and Canvas pass their own measurement,
 * so the text is identical while the fitting stays exact for each medium.
 *
 * @param {object} options
 * @param {unknown} options.name
 * @param {boolean} options.hidden
 * @param {number} options.maxWidthPx
 * @param {(text: string, maxWidthPx: number) => string} options.fit
 * @param {(text: string) => number} options.measure
 */
export function composeCategoryLabel({ name, hidden, maxWidthPx, fit, measure }) {
  const text = String(name ?? '');
  if (!hidden) return fit(text, maxWidthPx);
  const nameWidth = maxWidthPx - measure(HIDDEN_LEGEND_ENTRY_SUFFIX);
  return `${fit(text, nameWidth)}${HIDDEN_LEGEND_ENTRY_SUFFIX}`;
}

/**
 * Is this continuous model colored on a logarithmic ramp?
 *
 * `logEnabled` and the two `scale` fields are produced together by
 * `DataState.getLegendModel`; any of them reporting a log ramp is enough to
 * annotate one, because failing to annotate is the harmful direction.
 *
 * @param {any} model
 */
export function isLogColorScale(model) {
  return model?.logEnabled === true
    || model?.scale === 'log'
    || model?.colorbar?.scale === 'log';
}

/**
 * Build the note that keeps a logarithmic colorbar from being read linearly.
 *
 * Endpoints alone invite a reader to interpolate a mid-bar color and quote a
 * value that is wrong by orders of magnitude. Naming the scale and giving the
 * true midpoint (the geometric mean, since color position tracks log10(value))
 * removes both halves of that mistake.
 *
 * @param {any} model
 * @param {unknown} min
 * @param {unknown} max
 * @returns {string|null} Null when the scale is linear.
 */
export function buildColorScaleNote(model, min, max) {
  if (!isLogColorScale(model)) return null;
  const lo = Number(min);
  const hi = Number(max);
  if (Number.isFinite(lo) && Number.isFinite(hi) && lo > 0 && hi > 0) {
    return `Log10 color scale (midpoint ${formatTick(Math.sqrt(lo * hi))})`;
  }
  return 'Log10 color scale';
}

/**
 * May one legend stand for every panel of a grid export?
 *
 * Only when each panel is coloured by the same field *and* publishes a legend
 * model equal to the others in every respect — including which categories are
 * hidden. Two panels coloured by `cell_type` with different categories filtered
 * out need two legends: one legend would tell the reader that both panels draw
 * the same set of categories, which is exactly the claim the hidden-entry
 * marking exists to prevent.
 *
 * Panels that fail this test are drawn with their own legend instead; nothing
 * is dropped either way.
 *
 * @param {ReadonlyArray<{ scientificState: { fieldKey: string|null; legendModel: any } }>} views
 * @returns {{ fieldKey: string; model: any }|null}
 */
export function resolveSharedGridLegend(views) {
  let sharedFieldKey = null;
  let sharedModel = null;

  for (const view of views) {
    const fieldKey = view.scientificState.fieldKey;
    const model = view.scientificState.legendModel;
    if (fieldKey === null || model === null) return null;
    if (sharedFieldKey === null) {
      sharedFieldKey = fieldKey;
      sharedModel = model;
      continue;
    }
    if (
      sharedFieldKey !== fieldKey ||
      !areLegendModelsSemanticallyEqual(sharedModel, model)
    ) {
      return null;
    }
  }

  if (sharedFieldKey === null || sharedModel === null) return null;
  return { fieldKey: sharedFieldKey, model: sharedModel };
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
  backgroundFill = '#ffffff',
  ink = LIGHT_INK
}) {
  const HIDDEN_ENTRY_INK = ink.mutedText;
  const ENTRY_INK = ink.text;
  const SCALE_NOTE_INK = ink.mutedText;
  if (!legendRect || !model) return { svg: '', defs: '' };

  const x = legendRect.x;
  const y = legendRect.y;
  const w = legendRect.width;
  const h = legendRect.height;

  const padding = 8;
  const lineH = Math.max(14, Math.round(fontSize * 1.2));

  const parts = [];
  const defs = [];

  parts.push(
    `<g font-family="${escapeHtml(fontFamily)}" font-size="${fontSize}" fill="${ink.text}">`
  );
  const fill = backgroundFill === 'transparent' ? 'none' : backgroundFill;
  parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${escapeHtml(fill)}" stroke="${ink.frame}" stroke-width="1"/>`);

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

      const hidden = isCategoryHidden(model, i);
      const label = composeCategoryLabel({
        name: categories[i],
        hidden,
        maxWidthPx: maxLabelW,
        fit: (text, width) => truncateTextApprox(text, width, fontSize),
        measure: (text) => estimateTextWidthPxApprox(text, fontSize)
      });
      // A hidden category gets a hollow swatch: its color is absent from the
      // figure, so showing it would send the reader hunting for points that
      // were never drawn.
      if (hidden) {
        parts.push(`<rect x="${itemX}" y="${itemY}" width="${swatch}" height="${swatch}" fill="none" stroke="${HIDDEN_ENTRY_INK}" stroke-width="1"/>`);
      } else {
        parts.push(`<rect x="${itemX}" y="${itemY}" width="${swatch}" height="${swatch}" fill="${rgb01ToCss(colors[i])}" stroke="${ENTRY_INK}" stroke-width="0.25"/>`);
      }
      parts.push(`<text x="${labelX}" y="${itemY + swatch}" fill="${hidden ? HIDDEN_ENTRY_INK : ENTRY_INK}" dominant-baseline="ideographic">${escapeHtml(label)}</text>`);
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
    parts.push(`<rect x="${x + padding}" y="${cursorY}" width="${barW}" height="${barH}" fill="url(#${gradId})" stroke="${ink.text}" stroke-width="0.5"/>`);
    cursorY += barH + 6;

    const min = model.colorbar?.min ?? model.stats?.min;
    const max = model.colorbar?.max ?? model.stats?.max;
    const minText = formatTick(Number(min));
    const maxText = formatTick(Number(max));
    parts.push(`<text x="${x + padding}" y="${cursorY + fontSize}" fill="${SCALE_NOTE_INK}">${minText}</text>`);
    parts.push(`<text x="${x + padding + barW}" y="${cursorY + fontSize}" text-anchor="end" fill="${SCALE_NOTE_INK}">${maxText}</text>`);

    const note = buildColorScaleNote(model, min, max);
    if (note !== null) {
      const noteBaseline = cursorY + fontSize * 2 + SCALE_NOTE_GAP;
      parts.push(`<text x="${x + padding}" y="${noteBaseline}" fill="${SCALE_NOTE_INK}">${escapeHtml(note)}</text>`);
    }
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
  backgroundFill = '#ffffff',
  ink = LIGHT_INK
}) {
  const HIDDEN_ENTRY_INK = ink.mutedText;
  const ENTRY_INK = ink.text;
  const SCALE_NOTE_INK = ink.mutedText;
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
  ctx.strokeStyle = ink.frame;
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);

  ctx.fillStyle = ink.text;
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

      const hidden = isCategoryHidden(model, i);
      // A hidden category gets a hollow swatch: its color is absent from the
      // figure, so showing it would send the reader hunting for points that
      // were never drawn.
      if (hidden) {
        ctx.strokeStyle = HIDDEN_ENTRY_INK;
        ctx.lineWidth = 1;
        ctx.strokeRect(itemX, itemY, swatch, swatch);
      } else {
        ctx.fillStyle = rgb01ToCss(colors[i]);
        ctx.fillRect(itemX, itemY, swatch, swatch);
        ctx.strokeStyle = ENTRY_INK;
        ctx.lineWidth = 0.5;
        ctx.strokeRect(itemX, itemY, swatch, swatch);
      }

      ctx.fillStyle = hidden ? HIDDEN_ENTRY_INK : ENTRY_INK;
      const label = composeCategoryLabel({
        name: categories[i],
        hidden,
        maxWidthPx: maxLabelW,
        fit: (text, width) => truncateCanvasTextToWidth(ctx, text, width),
        measure: (text) => ctx.measureText(text).width
      });
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
    ctx.strokeStyle = ink.text;
    ctx.lineWidth = 0.5;
    ctx.strokeRect(x + padding, cursorY, barW, barH);
    cursorY += barH + 6;

    const min = model.colorbar?.min ?? model.stats?.min;
    const max = model.colorbar?.max ?? model.stats?.max;
    ctx.fillStyle = SCALE_NOTE_INK;
    ctx.textAlign = 'left';
    ctx.fillText(formatTick(Number(min)), x + padding, cursorY + fontSize);
    ctx.textAlign = 'right';
    ctx.fillText(formatTick(Number(max)), x + padding + barW, cursorY + fontSize);

    const note = buildColorScaleNote(model, min, max);
    if (note !== null) {
      ctx.textAlign = 'left';
      ctx.fillText(note, x + padding, cursorY + fontSize * 2 + SCALE_NOTE_GAP);
    }
  }

  ctx.restore();
}
