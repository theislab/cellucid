/**
 * @fileoverview Legend builders for figure export (SVG + Canvas).
 *
 * The legend model is sourced from DataState.getLegendModel(field) to ensure
 * DRY, color-consistent behavior across the app.
 *
 * Category legends are laid out in as many columns as their entries need, and
 * every entry is drawn whole: no "+N more", no name shortened with "…". The
 * geometry is planned once (`planLegend()`), with the layout's one text
 * measurement (`utils/text-measure.js`), and the layout reserves exactly the
 * box the plan needs (`utils/layout.js`); the builders draw that plan and
 * measure nothing themselves, so the box can never be narrower than what is
 * drawn in it. A legend too large for the browser to draw is refused before
 * the figure is rendered (`utils/figure-canvas.js`), never cut.
 *
 * @module ui/modules/figure-export/components/legend-builder
 */

import { formatSignificant } from '../../../../../utils/format-units.js';
import { LIGHT_INK } from '../utils/figure-ink.js';
import { escapeXml } from '../../../../utils/dom-utils.js';
import {
  areLegendModelsSemanticallyEqual,
} from '../utils/legend-model-equality.js';
import { geneSampleLayersNote, geneSampleText } from '../../../../../data/gene-read-plan.js';
import { categoryCssAt } from '../../../../utils/category-state.js';
import { geneValueLabel } from '../../../../../data/expression-transform.js';
import { categoryDisplayName } from '../../../../actions/targets/names.js';
import { getColormap } from '../../../../../data/palettes.js';

/**
 * @typedef {object} Rect
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/**
 * Suffix marking a category the person hid: it has cells in the panel's
 * cells but they are not drawn.
 *
 * Hidden categories are marked rather than dropped. Dropping them would make a
 * filtered view indistinguishable from a complete one: a reader seeing nine of
 * twelve cell types with no trace of the other three concludes the panel shows
 * the whole composition of the tissue. Marking keeps the fact of the filtering
 * inside the figure, where a reader who never saw the app can find it.
 *
 * A category with no cell left by the filters on other fields is not listed
 * at all (`legendEntries`): the figure has none of its cells to hide, and the
 * filter that emptied it is named in the title (a grid panel's label:
 * `utils/figure-title.js`). Marking those "(hidden)" would list categories as
 * hidden that the person never hid, only filtered away through another field.
 */
export const HIDDEN_LEGEND_ENTRY_SUFFIX = ' (hidden)';

/**
 * Legend ink follows the figure's paper, not a fixed near-black: a legend
 * written in `#111` on a dark-background figure cannot be read at all.
 * `utils/figure-ink.js` owns both palettes.
 */

/** Gap between the colorbar endpoint row and the scale note. */
const SCALE_NOTE_GAP = 4;

/**
 * A note's lines within `maxWidthPx`: words (split at spaces) taken greedily,
 * a word wider than the line on a line of its own. A note is never cut.
 *
 * @param {string} note
 * @param {number} maxWidthPx
 * @param {(text: string) => number} measure
 * @returns {string[]}
 */
function noteLines(note, maxWidthPx, measure) {
  const lines = [];
  let line = '';
  for (const word of note.split(' ')) {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (line !== '' && measure(candidate) > maxWidthPx) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

/** Line height of a legend note, in font sizes. */
const NOTE_LINE_HEIGHT = 1.25;

/**
 * The color bar's stops from a legend model's `colorStops`: CSS colors,
 * each optionally followed by its position (`'rgb(68, 1, 84) 0%'`). The
 * colormaps' own stops (`getCssStopsForColormap`) are bare colors, evenly
 * spaced; a color with spaces inside its parentheses is one color.
 *
 * @param {unknown} colorStops
 * @returns {Array<{color: string, offset: number}>} Offsets from 0 to 1.
 */
function colorBarStops(colorStops) {
  const stops = Array.isArray(colorStops) ? colorStops : [];
  const last = Math.max(1, stops.length - 1);
  return stops.map((stop, index) => {
    const text = String(stop ?? '').trim();
    const positioned = /^(.*\S)\s+(-?\d+(?:\.\d+)?)%$/.exec(text);
    const offset = positioned === null ? index / last : Number(positioned[2]) / 100;
    return { color: positioned === null ? text : positioned[1], offset: Math.min(1, Math.max(0, offset)) };
  }).filter(stop => stop.color !== '');
}

/**
 * The entries a figure's category legend lists, in the model's order: each
 * category with cells after the filters on other fields, `hidden` when the
 * person hid it (unticked: its cells are not drawn). A category the other
 * filters leave no cell is left out — the row the on-screen legend disables
 * as "No cells available in this category after other filters" — whether or
 * not it is ticked: the figure shows none of it, and a publication legend
 * lists what the figure shows (the filters stand in its title, a grid
 * panel's in its label). A model without counts lists every category.
 *
 * @param {any} model - a category legend model (`DataState.getLegendModel`)
 * @returns {Array<{category: number, hidden: boolean}>}
 */
export function legendEntries(model) {
  const count = (model?.categories || []).length;
  const visible = model?.visible instanceof Uint8Array ? model.visible : null;
  const available = Array.isArray(model?.counts?.available) ? model.counts.available : null;
  const entries = [];
  for (let category = 0; category < count; category++) {
    if (available !== null && !(available[category] > 0)) continue;
    entries.push({ category, hidden: visible !== null && visible[category] === 0 });
  }
  return entries;
}

// ============================================================================
// Legend geometry: planned once, drawn as planned
// ============================================================================

/** Inner padding of the legend box (px). */
const LEGEND_PADDING = 8;
/** Side of a category swatch (px). */
const LEGEND_SWATCH = 10;
/** Gap between a swatch and its label (px). */
const LEGEND_SWATCH_GAP = 6;
/** The outline of a filled swatch (px), in both formats. */
const SWATCH_OUTLINE = 0.5;
/**
 * Room kept after the longest label in every column: one em of the legend's
 * font, so columns read apart and a long label never runs into the next
 * column's swatch.
 */
function columnGapPx(fontPx) {
  return Math.round(fontPx);
}
/** Gap between the legend title row and the first entry (px). */
const LEGEND_TITLE_GAP = 8;
/** Height of the color bar (px). */
const COLORBAR_HEIGHT = 12;
/** Gap between the color bar and its end labels (px). */
const COLORBAR_LABEL_GAP = 6;
/** Least room between the two end labels of a color bar (px). */
const COLORBAR_END_LABEL_SPACING = 12;
/** How far a glyph reaches below its baseline, in font sizes (descenders). */
const DESCENT = 0.3;
/** How far below its row's centre a label's baseline sits, in font sizes: half a capital, so the label is centered on its swatch. */
const LABEL_BASELINE_DROP = 0.35;

/**
 * Where a category entry's swatch and label stand in its row (`itemY` is the
 * row's top, `lineHeight` tall): both centered on the row, the label on an
 * alphabetic baseline half a capital below the centre, in both formats.
 * One placement serves both formats: a label set by its bottom edge at the
 * swatch's bottom would sit differently in each format, and in a font larger
 * than the swatch it would rise into the legend's title.
 *
 * @param {number} itemY
 * @param {number} lineHeight
 * @param {number} fontPx
 */
function entryPlacement(itemY, lineHeight, fontPx) {
  const centre = itemY + lineHeight / 2;
  return { swatchY: centre - LEGEND_SWATCH / 2, baseline: centre + fontPx * LABEL_BASELINE_DROP };
}

/** Row height of one category entry. */
function legendLineHeight(fontPx) {
  return Math.max(14, Math.round(fontPx * 1.2));
}

/**
 * The legend's title: the field, with the units of a gene's values when
 * they are not as stored ("Ins1 · log1p(norm.)", Data mapping › Expression
 * values), or what the legend is when there is none.
 */
function legendTitle(fieldKey, model) {
  if (fieldKey) return geneValueLabel(String(fieldKey), model?.values ?? null);
  return model?.kind === 'continuous' ? 'Color scale' : 'Legend';
}

/**
 * Everything a legend builder draws, and the box it needs.
 *
 * @typedef {object} LegendPlan
 * @property {'category'|'continuous'|'other'} kind
 * @property {string} title
 * @property {number} width   - The least box width that holds everything (px)
 * @property {number} height  - The least box height that holds everything (px)
 * @property {number} fontPx
 * @property {number} listTop - Offset of the first entry / the color bar below the box top (px)
 * @property {Array<{category: number, hidden: boolean, label: string}>} [entries] - category: the
 *   entries listed (`legendEntries`), each with its whole text, hidden marker included
 * @property {number} [lineHeight]      - category
 * @property {number} [columns]         - category
 * @property {number} [rowsPerColumn]   - category
 * @property {number} [columnWidth]     - category: swatch, gap, the longest label, margin
 * @property {number} [barWidth]        - continuous
 * @property {string} [minText]         - continuous
 * @property {string} [maxText]         - continuous
 * @property {string[]} [noteLines]     - continuous: the scale note, wrapped to the bar
 * @property {{label: string, color: string, top: number}|null} highlight - the entry for the
 *   highlighted cells the figure draws (`utils/highlight-legend.js`), its row `top` px below
 *   the box top, under everything else; null when it has none
 * @property {{label: string, speed: string, colormapId: string, top: number, rampWidth: number}|null} vectorKey -
 *   the key of the vector field the plot draws (`vectorFieldLegendKey`): an arrow and what the
 *   arrows are, then the colors' ramp and their speed range, its first row `top` px below the
 *   box top, under the highlight's; null when it has none
 */

/** The vector field key's ramp, in ems of the legend's font. */
const VECTOR_RAMP_EMS = 4;

/** The color the key's arrow is drawn in: the middle of the field's colors. */
function vectorKeyArrowCss(colormapId) {
  return `rgb(${getColormap(colormapId).sample(0.6).map(channel => Math.round(Math.max(0, Math.min(1, channel)) * 255)).join(',')})`;
}

/** The ramp's stops (0–1) as CSS colors. */
function vectorKeyRampStops(colormapId) {
  const colormap = getColormap(colormapId);
  return [0, 0.25, 0.5, 0.75, 1].map(offset => ({
    offset,
    color: `rgb(${colormap.sample(offset).map(channel => Math.round(Math.max(0, Math.min(1, channel)) * 255)).join(',')})`,
  }));
}

/**
 * Plan a legend: its entries' whole text, its columns, and the box it needs.
 *
 * The plan is made once, with the one text measurement the layout uses
 * (`utils/text-measure.js`), and both builders draw exactly it: they measure
 * nothing, so the columns the layout reserved are the columns drawn, and a
 * label is never shortened. A column is as wide as its longest entry,
 * `(hidden)` marker included; the title row is as wide as the title.
 *
 * - `placement: 'beside'` — the legend stands beside something `extentPx`
 *   tall (the plot, or the grid): its entries fill as many rows as that height
 *   holds (at least one), and it grows sideways by whole columns.
 * - `placement: 'below'` — the legend stands below something `extentPx`
 *   wide: it takes as many columns as that width holds (at least one) and
 *   grows downwards by rows. A single column wider than `extentPx` makes the
 *   legend wider than it.
 *
 * A `highlight` entry (the highlighted cells the figure draws) is one
 * more row under the entries, the color bar or the title, a title gap below
 * them, as wide as its text needs; beside a plot its row is kept out of the
 * height the entries fill. A `vectorKey` (the vector field the plot draws)
 * is two more rows under those, a title gap below them: an arrow and what
 * the arrows are, the colors' ramp and their speed range. A legend with no
 * model (a view colored by no field) lists the highlight, the key or both.
 *
 * @param {object} options
 * @param {any} options.model                 - legend model (DataState.getLegendModel); null for a legend of the highlight alone
 * @param {string|null} options.fieldKey
 * @param {number} options.fontPx
 * @param {import('../utils/text-measure.js').MeasureText} options.measureText
 * @param {'beside'|'below'} options.placement
 * @param {number} options.extentPx           - height beside, width below (px)
 * @param {number} [options.minWidth=0]       - the least box width (px); a color bar is this long
 * @param {import('../utils/highlight-legend.js').HighlightLegendEntry|null} [options.highlight=null] -
 *   the entry for the highlighted cells the figure draws
 * @param {{label: string, speed: string, colormapId: string}|null} [options.vectorKey=null] -
 *   the key of the vector field the plot draws (`vectorFieldLegendKey`)
 * @returns {LegendPlan}
 */
export function planLegend({
  model,
  fieldKey,
  fontPx,
  measureText,
  placement,
  extentPx,
  minWidth = 0,
  highlight = null,
  vectorKey = null,
}) {
  if (placement !== 'beside' && placement !== 'below') {
    throw new TypeError('A legend is planned beside or below its plot.');
  }
  if (model == null && highlight === null && vectorKey === null) {
    throw new TypeError('A legend lists a model, the highlighted cells, a vector field\'s key, or several.');
  }
  const extent = Math.max(1, Number(extentPx) || 1);
  const title = legendTitle(fieldKey, model);
  const titleWidth = measureText(title, fontPx, 600);
  const listTop = LEGEND_PADDING + fontPx + LEGEND_TITLE_GAP;
  const floorWidth = Math.max(minWidth, placement === 'below' ? extent : 0);
  // The highlight's row: a title gap under the rest, one entry tall.
  const highlightWidth = highlight === null ? 0 : LEGEND_SWATCH + LEGEND_SWATCH_GAP + measureText(highlight.label, fontPx);
  const highlightSpace = highlight === null ? 0 : LEGEND_TITLE_GAP + legendLineHeight(fontPx);
  const highlightAt = (contentBottom) => (highlight === null
    ? null
    : { label: highlight.label, color: highlight.color, top: contentBottom + LEGEND_TITLE_GAP });
  // The vector field's key: two rows under the highlight's, a title gap below.
  const rampWidth = VECTOR_RAMP_EMS * fontPx;
  const vectorWidth = vectorKey === null ? 0 : Math.max(
    LEGEND_SWATCH * 2 + LEGEND_SWATCH_GAP + measureText(vectorKey.label, fontPx),
    rampWidth + LEGEND_SWATCH_GAP + measureText(vectorKey.speed, fontPx)
  );
  const vectorSpace = vectorKey === null ? 0 : LEGEND_TITLE_GAP + legendLineHeight(fontPx) * 2;
  const vectorAt = (contentBottom) => (vectorKey === null
    ? null
    : {
      label: vectorKey.label,
      speed: vectorKey.speed,
      colormapId: vectorKey.colormapId,
      top: contentBottom + highlightSpace + LEGEND_TITLE_GAP,
      rampWidth,
    });
  // The rows under the rest: the highlight's and the key's.
  const trailingSpace = highlightSpace + vectorSpace;
  const boxWidth = (content) => Math.ceil(Math.max(floorWidth, LEGEND_PADDING * 2 + Math.max(content, highlightWidth, vectorWidth), LEGEND_PADDING * 2 + titleWidth));

  if (model?.kind === 'category') {
    const categories = model.categories || [];
    const entries = legendEntries(model).map(({ category, hidden }) => ({
      category, hidden, label: `${categories[category] === undefined ? '' : categoryDisplayName(categories[category])}${hidden ? HIDDEN_LEGEND_ENTRY_SUFFIX : ''}`,
    }));
    const count = entries.length;
    let longest = 0;
    for (const { label } of entries) {
      const width = measureText(label, fontPx);
      if (width > longest) longest = width;
    }
    const lineHeight = legendLineHeight(fontPx);
    const columnWidth = Math.ceil(LEGEND_SWATCH + LEGEND_SWATCH_GAP + longest + columnGapPx(fontPx));
    let rowsPerColumn;
    let columns;
    if (placement === 'beside') {
      rowsPerColumn = Math.max(1, Math.floor((extent - listTop - trailingSpace - LEGEND_PADDING) / lineHeight));
      columns = Math.ceil(count / rowsPerColumn);
    } else {
      const fit = Math.max(1, Math.floor((extent - LEGEND_PADDING * 2) / columnWidth));
      rowsPerColumn = Math.max(1, Math.ceil(count / fit));
      // As few columns as those rows need: no column is left empty.
      columns = Math.ceil(count / rowsPerColumn);
    }
    const rowsUsed = Math.min(count, rowsPerColumn);
    return {
      kind: 'category',
      title,
      fontPx,
      listTop,
      entries,
      lineHeight,
      columns,
      rowsPerColumn,
      columnWidth,
      highlight: highlightAt(listTop + rowsUsed * lineHeight),
      vectorKey: vectorAt(listTop + rowsUsed * lineHeight),
      width: boxWidth(columns * columnWidth),
      height: Math.ceil(listTop + rowsUsed * lineHeight + trailingSpace + LEGEND_PADDING),
    };
  }

  if (model?.kind === 'continuous') {
    const min = model.colorbar?.min ?? model.stats?.min;
    const max = model.colorbar?.max ?? model.stats?.max;
    const minText = formatSignificant(Number(min));
    const maxText = formatSignificant(Number(max));
    const note = buildColorScaleNote(model, min, max);
    const measure = (text) => measureText(text, fontPx);
    let widestWord = 0;
    if (note !== null) {
      for (const word of note.split(' ')) widestWord = Math.max(widestWord, measure(word));
    }
    const width = boxWidth(Math.max(
      measure(minText) + COLORBAR_END_LABEL_SPACING + measure(maxText),
      widestWord
    ));
    const barWidth = width - LEGEND_PADDING * 2;
    const lines = note === null ? [] : noteLines(note, barWidth, measure);
    const labelsTop = listTop + COLORBAR_HEIGHT + COLORBAR_LABEL_GAP;
    const lastBaseline = lines.length === 0
      ? labelsTop + fontPx
      : labelsTop + fontPx * 2 + SCALE_NOTE_GAP + (lines.length - 1) * fontPx * NOTE_LINE_HEIGHT;
    return {
      kind: 'continuous',
      title,
      fontPx,
      listTop,
      barWidth,
      minText,
      maxText,
      noteLines: lines,
      highlight: highlightAt(lastBaseline + fontPx * DESCENT),
      vectorKey: vectorAt(lastBaseline + fontPx * DESCENT),
      width,
      height: Math.ceil(lastBaseline + fontPx * DESCENT + trailingSpace + LEGEND_PADDING),
    };
  }

  // The title alone; the highlight's row under it.
  const titleBottom = LEGEND_PADDING + fontPx * (1 + DESCENT);
  return {
    kind: 'other',
    title,
    fontPx,
    listTop,
    highlight: highlightAt(titleBottom),
    vectorKey: vectorAt(titleBottom),
    width: boxWidth(0),
    height: Math.ceil(titleBottom + trailingSpace + LEGEND_PADDING),
  };
}

/**
 * Where the highlight entry's swatch and label stand (`LegendPlan.highlight`),
 * in the box at (`x`, `y`): one category row, the same in both formats.
 *
 * @param {LegendPlan} plan
 * @param {number} x
 * @param {number} y
 */
function highlightPlacement(plan, x, y) {
  const itemX = x + LEGEND_PADDING;
  const { swatchY, baseline } = entryPlacement(y + plan.highlight.top, legendLineHeight(plan.fontPx), plan.fontPx);
  return { itemX, swatchY, labelX: itemX + LEGEND_SWATCH + LEGEND_SWATCH_GAP, baseline };
}

/**
 * Where the vector field key's arrow, ramp and labels stand
 * (`LegendPlan.vectorKey`), in the box at (`x`, `y`): two category rows, the
 * same in both formats. The arrow is two swatches long, centered on its row.
 *
 * @param {LegendPlan} plan
 * @param {number} x
 * @param {number} y
 */
function vectorKeyPlacement(plan, x, y) {
  const itemX = x + LEGEND_PADDING;
  const lineHeight = legendLineHeight(plan.fontPx);
  const first = entryPlacement(y + plan.vectorKey.top, lineHeight, plan.fontPx);
  const second = entryPlacement(y + plan.vectorKey.top + lineHeight, lineHeight, plan.fontPx);
  const arrowY = first.swatchY + LEGEND_SWATCH / 2;
  const arrowEnd = itemX + LEGEND_SWATCH * 2;
  const head = LEGEND_SWATCH * 0.45;
  return {
    arrow: { x0: itemX, x1: arrowEnd, y: arrowY, head },
    labelX: arrowEnd + LEGEND_SWATCH_GAP,
    labelBaseline: first.baseline,
    ramp: { x: itemX, y: second.swatchY, width: plan.vectorKey.rampWidth, height: LEGEND_SWATCH },
    speedX: itemX + plan.vectorKey.rampWidth + LEGEND_SWATCH_GAP,
    speedBaseline: second.baseline,
  };
}

/**
 * The plan a builder draws must be the plan of the model it is handed.
 *
 * @param {any} model
 * @param {LegendPlan} plan
 */
function assertPlanOfModel(model, plan) {
  if (!plan || typeof plan !== 'object') {
    throw new TypeError('A figure legend is drawn from its plan (planLegend).');
  }
  const kind = model?.kind === 'category' || model?.kind === 'continuous' ? model.kind : 'other';
  if (plan.kind !== kind) {
    throw new TypeError(`A ${kind} legend cannot be drawn from a ${plan.kind} plan.`);
  }
  if (kind === 'category') {
    const listed = legendEntries(model);
    if (plan.entries.length !== listed.length || plan.entries.some((entry, at) => entry.category !== listed[at].category || entry.hidden !== listed[at].hidden)) {
      throw new TypeError('A category legend plan must list the entries of its model (legendEntries).');
    }
  }
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
function isLogColorScale(model) {
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
 * @returns {string|null} Null when the scale is linear and not centered at 0, every open cell's gene is read, and no zero is drawn gray.
 */
export function buildColorScaleNote(model, min, max) {
  // A gene read for a sample of the open cells (`model.geneSample`): the
  // faded cells are those not read, which the figure says, with the gray
  // for 0 when its zeros are drawn gray (`model.zeroGray.drawn`: gray for
  // zero on, or a log scale); without a sample, that gray alone.
  const sample = model?.geneSample ?? null;
  const zeroGray = model?.zeroGray?.drawn === true;
  const layers = sample !== null ? `${geneSampleText(sample)}. ${geneSampleLayersNote(zeroGray)}` : zeroGray ? 'Gray: 0' : null;
  const notes = [scaleNote(model, min, max), layers].filter(note => note !== null);
  return notes.length === 0 ? null : notes.join(' · ');
}

/** The scale's own note (`buildColorScaleNote`). */
function scaleNote(model, min, max) {
  // A diverging map centered on 0 (`computeContinuousDomain`): its middle is 0.
  if (!isLogColorScale(model)) return model?.colorbar?.centered === true ? 'Color scale centered at 0' : null;
  const lo = Number(min);
  const hi = Number(max);
  if (Number.isFinite(lo) && Number.isFinite(hi) && lo > 0 && hi > 0) {
    return `Log10 color scale (midpoint ${formatSignificant(Math.sqrt(lo * hi))})`;
  }
  return 'Log10 color scale';
}

/**
 * May one legend stand for every panel of a grid export?
 *
 * Only when each panel is colored by the same field *and* publishes a legend
 * model equal to the others in every respect — including which categories are
 * hidden. Two panels colored by `cell_type` with different categories filtered
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
 * Draws `legendPlan` (`planLegend()`) inside `legendRect`, which the layout
 * made at least as large as the plan: every entry whole, in the plan's
 * columns. Nothing is measured here.
 *
 * @param {object} options
 * @param {Rect} options.legendRect
 * @param {LegendPlan} options.legendPlan
 * @param {any} options.model - legend model from DataState.getLegendModel; null for a legend of the highlight alone
 * @param {string} [options.fontFamily]
 * @param {string} [options.idPrefix]
 */
export function renderSvgLegend({
  legendRect,
  legendPlan,
  model,
  fontFamily = 'Arial, Helvetica, sans-serif',
  idPrefix = 'legend',
  backgroundFill = '#ffffff',
  ink = LIGHT_INK
}) {
  const HIDDEN_ENTRY_INK = ink.mutedText;
  const ENTRY_INK = ink.text;
  const SCALE_NOTE_INK = ink.mutedText;
  if (!legendRect) return { svg: '', defs: '' };
  assertPlanOfModel(model, legendPlan);

  const { x, y, width: w, height: h } = legendRect;
  const padding = LEGEND_PADDING;
  const fontSize = legendPlan.fontPx;

  const parts = [];
  const defs = [];

  parts.push(
    `<g font-family="${escapeXml(fontFamily)}" font-size="${fontSize}" fill="${ink.text}">`
  );
  const fill = backgroundFill === 'transparent' ? 'none' : backgroundFill;
  parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${escapeXml(fill)}" stroke="${ink.frame}" stroke-width="1"/>`);
  parts.push(`<text x="${x + padding}" y="${y + padding + fontSize}" font-weight="600">${escapeXml(legendPlan.title)}</text>`);

  const listTop = y + legendPlan.listTop;

  if (legendPlan.kind === 'category') {
    const { entries, rowsPerColumn, columnWidth, lineHeight } = legendPlan;
    const colors = model.colors;
    for (let i = 0; i < entries.length; i++) {
      const col = Math.floor(i / rowsPerColumn);
      const row = i % rowsPerColumn;
      const itemX = x + padding + col * columnWidth;
      const { swatchY, baseline } = entryPlacement(listTop + row * lineHeight, lineHeight, fontSize);
      const labelX = itemX + LEGEND_SWATCH + LEGEND_SWATCH_GAP;
      const { category, hidden, label } = entries[i];
      // A hidden category gets a hollow swatch: its color is absent from the
      // figure, so showing it would send the reader hunting for points that
      // were never drawn.
      if (hidden) {
        parts.push(`<rect x="${itemX}" y="${swatchY}" width="${LEGEND_SWATCH}" height="${LEGEND_SWATCH}" fill="none" stroke="${HIDDEN_ENTRY_INK}" stroke-width="1"/>`);
      } else {
        parts.push(`<rect x="${itemX}" y="${swatchY}" width="${LEGEND_SWATCH}" height="${LEGEND_SWATCH}" fill="${categoryCssAt(colors, category)}" stroke="${ENTRY_INK}" stroke-width="${SWATCH_OUTLINE}"/>`);
      }
      parts.push(`<text x="${labelX}" y="${baseline}" fill="${hidden ? HIDDEN_ENTRY_INK : ENTRY_INK}">${escapeXml(label)}</text>`);
    }
  } else if (legendPlan.kind === 'continuous') {
    const gradId = `${idPrefix}_grad`;
    const stops = colorBarStops(model.colorStops);
    defs.push(`<linearGradient id="${gradId}" x1="0" x2="1" y1="0" y2="0">`);
    for (const s of stops) {
      defs.push(`<stop offset="${+(s.offset * 100).toFixed(3)}%" stop-color="${s.color}"/>`);
    }
    defs.push(`</linearGradient>`);

    const barW = legendPlan.barWidth;
    parts.push(`<rect x="${x + padding}" y="${listTop}" width="${barW}" height="${COLORBAR_HEIGHT}" fill="url(#${gradId})" stroke="${ink.text}" stroke-width="0.5"/>`);
    const labelsTop = listTop + COLORBAR_HEIGHT + COLORBAR_LABEL_GAP;
    parts.push(`<text x="${x + padding}" y="${labelsTop + fontSize}" fill="${SCALE_NOTE_INK}">${escapeXml(legendPlan.minText)}</text>`);
    parts.push(`<text x="${x + padding + barW}" y="${labelsTop + fontSize}" text-anchor="end" fill="${SCALE_NOTE_INK}">${escapeXml(legendPlan.maxText)}</text>`);

    // The note, wrapped to the bar's width by the plan: a gene sample's note runs long.
    const noteBaseline = labelsTop + fontSize * 2 + SCALE_NOTE_GAP;
    legendPlan.noteLines.forEach((line, index) => {
      parts.push(`<text x="${x + padding}" y="${noteBaseline + index * fontSize * NOTE_LINE_HEIGHT}" fill="${SCALE_NOTE_INK}">${escapeXml(line)}</text>`);
    });
  }

  if (legendPlan.highlight !== null) {
    const { itemX, swatchY, labelX, baseline } = highlightPlacement(legendPlan, x, y);
    parts.push(`<rect x="${itemX}" y="${swatchY}" width="${LEGEND_SWATCH}" height="${LEGEND_SWATCH}" fill="${escapeXml(legendPlan.highlight.color)}" stroke="${ENTRY_INK}" stroke-width="${SWATCH_OUTLINE}"/>`);
    parts.push(`<text x="${labelX}" y="${baseline}" fill="${ENTRY_INK}">${escapeXml(legendPlan.highlight.label)}</text>`);
  }

  if (legendPlan.vectorKey) {
    const key = vectorKeyPlacement(legendPlan, x, y);
    const arrowColor = vectorKeyArrowCss(legendPlan.vectorKey.colormapId);
    const rampId = `${idPrefix}-vector-ramp`;
    defs.push(`<linearGradient id="${escapeXml(rampId)}">${vectorKeyRampStops(legendPlan.vectorKey.colormapId).map(stop => `<stop offset="${stop.offset}" stop-color="${stop.color}"/>`).join('')}</linearGradient>`);
    const { x0, x1, y: ay, head } = key.arrow;
    parts.push(`<path d="M${x0} ${ay}L${x1 - head} ${ay}" stroke="${arrowColor}" stroke-width="${Math.max(1, fontSize * 0.12)}"/>`);
    parts.push(`<polygon points="${x1} ${ay} ${x1 - head} ${ay - head * 0.6} ${x1 - head} ${ay + head * 0.6}" fill="${arrowColor}"/>`);
    parts.push(`<text x="${key.labelX}" y="${key.labelBaseline}" fill="${ENTRY_INK}">${escapeXml(legendPlan.vectorKey.label)}</text>`);
    parts.push(`<rect x="${key.ramp.x}" y="${key.ramp.y}" width="${key.ramp.width}" height="${key.ramp.height}" fill="url(#${escapeXml(rampId)})"/>`);
    parts.push(`<text x="${key.speedX}" y="${key.speedBaseline}" fill="${ENTRY_INK}">${escapeXml(legendPlan.vectorKey.speed)}</text>`);
  }

  parts.push(`</g>`);

  return { svg: parts.join(''), defs: defs.length ? `<defs>${defs.join('')}</defs>` : '' };
}

/**
 * Draw a legend onto a Canvas2D context.
 *
 * Draws `legendPlan` (`planLegend()`) inside `legendRect`, exactly as
 * `renderSvgLegend` does: the same text, the same columns, nothing measured.
 *
 * @param {object} options
 * @param {CanvasRenderingContext2D} options.ctx
 * @param {Rect} options.legendRect
 * @param {LegendPlan} options.legendPlan
 * @param {any} options.model - null for a legend of the highlight alone
 * @param {string} [options.fontFamily]
 */
export function drawCanvasLegend({
  ctx,
  legendRect,
  legendPlan,
  model,
  fontFamily = 'Arial, Helvetica, sans-serif',
  backgroundFill = '#ffffff',
  ink = LIGHT_INK
}) {
  const HIDDEN_ENTRY_INK = ink.mutedText;
  const ENTRY_INK = ink.text;
  const SCALE_NOTE_INK = ink.mutedText;
  if (!ctx || !legendRect) return;
  assertPlanOfModel(model, legendPlan);

  const { x, y, width: w, height: h } = legendRect;
  const padding = LEGEND_PADDING;
  const fontSize = legendPlan.fontPx;

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
  ctx.fillText(legendPlan.title, x + padding, y + padding + fontSize);

  const listTop = y + legendPlan.listTop;
  ctx.font = `${fontSize}px ${fontFamily}`;

  if (legendPlan.kind === 'category') {
    const { entries, rowsPerColumn, columnWidth, lineHeight } = legendPlan;
    const colors = model.colors;
    for (let i = 0; i < entries.length; i++) {
      const col = Math.floor(i / rowsPerColumn);
      const row = i % rowsPerColumn;
      const itemX = x + padding + col * columnWidth;
      const { swatchY, baseline } = entryPlacement(listTop + row * lineHeight, lineHeight, fontSize);
      const labelX = itemX + LEGEND_SWATCH + LEGEND_SWATCH_GAP;

      const { category, hidden, label } = entries[i];
      // A hidden category gets a hollow swatch: its color is absent from the
      // figure, so showing it would send the reader hunting for points that
      // were never drawn.
      if (hidden) {
        ctx.strokeStyle = HIDDEN_ENTRY_INK;
        ctx.lineWidth = 1;
        ctx.strokeRect(itemX, swatchY, LEGEND_SWATCH, LEGEND_SWATCH);
      } else {
        ctx.fillStyle = categoryCssAt(colors, category);
        ctx.fillRect(itemX, swatchY, LEGEND_SWATCH, LEGEND_SWATCH);
        ctx.strokeStyle = ENTRY_INK;
        ctx.lineWidth = SWATCH_OUTLINE;
        ctx.strokeRect(itemX, swatchY, LEGEND_SWATCH, LEGEND_SWATCH);
      }

      ctx.fillStyle = hidden ? HIDDEN_ENTRY_INK : ENTRY_INK;
      ctx.fillText(label, labelX, baseline);
    }
  } else if (legendPlan.kind === 'continuous') {
    const barW = legendPlan.barWidth;
    const grad = ctx.createLinearGradient(x + padding, 0, x + padding + barW, 0);
    for (const s of colorBarStops(model.colorStops)) grad.addColorStop(s.offset, s.color);
    ctx.fillStyle = grad;
    ctx.fillRect(x + padding, listTop, barW, COLORBAR_HEIGHT);
    ctx.strokeStyle = ink.text;
    ctx.lineWidth = 0.5;
    ctx.strokeRect(x + padding, listTop, barW, COLORBAR_HEIGHT);
    const labelsTop = listTop + COLORBAR_HEIGHT + COLORBAR_LABEL_GAP;

    ctx.fillStyle = SCALE_NOTE_INK;
    ctx.textAlign = 'left';
    ctx.fillText(legendPlan.minText, x + padding, labelsTop + fontSize);
    ctx.textAlign = 'right';
    ctx.fillText(legendPlan.maxText, x + padding + barW, labelsTop + fontSize);

    ctx.textAlign = 'left';
    legendPlan.noteLines.forEach((line, index) => {
      ctx.fillText(line, x + padding, labelsTop + fontSize * 2 + SCALE_NOTE_GAP + index * fontSize * NOTE_LINE_HEIGHT);
    });
  }

  if (legendPlan.highlight !== null) {
    const { itemX, swatchY, labelX, baseline } = highlightPlacement(legendPlan, x, y);
    ctx.fillStyle = legendPlan.highlight.color;
    ctx.fillRect(itemX, swatchY, LEGEND_SWATCH, LEGEND_SWATCH);
    ctx.strokeStyle = ENTRY_INK;
    ctx.lineWidth = SWATCH_OUTLINE;
    ctx.strokeRect(itemX, swatchY, LEGEND_SWATCH, LEGEND_SWATCH);
    ctx.fillStyle = ENTRY_INK;
    ctx.textAlign = 'left';
    ctx.fillText(legendPlan.highlight.label, labelX, baseline);
  }

  if (legendPlan.vectorKey) {
    const key = vectorKeyPlacement(legendPlan, x, y);
    const arrowColor = vectorKeyArrowCss(legendPlan.vectorKey.colormapId);
    const { x0, x1, y: ay, head } = key.arrow;
    ctx.strokeStyle = arrowColor;
    ctx.fillStyle = arrowColor;
    ctx.lineWidth = Math.max(1, fontSize * 0.12);
    ctx.beginPath();
    ctx.moveTo(x0, ay);
    ctx.lineTo(x1 - head, ay);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x1, ay);
    ctx.lineTo(x1 - head, ay - head * 0.6);
    ctx.lineTo(x1 - head, ay + head * 0.6);
    ctx.closePath();
    ctx.fill();
    const ramp = ctx.createLinearGradient(key.ramp.x, 0, key.ramp.x + key.ramp.width, 0);
    for (const stop of vectorKeyRampStops(legendPlan.vectorKey.colormapId)) ramp.addColorStop(stop.offset, stop.color);
    ctx.fillStyle = ramp;
    ctx.fillRect(key.ramp.x, key.ramp.y, key.ramp.width, key.ramp.height);
    ctx.fillStyle = ENTRY_INK;
    ctx.textAlign = 'left';
    ctx.fillText(legendPlan.vectorKey.label, key.labelX, key.labelBaseline);
    ctx.fillText(legendPlan.vectorKey.speed, key.speedX, key.speedBaseline);
  }

  ctx.restore();
}
