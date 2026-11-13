/**
 * @fileoverview The figure-export settings a session records.
 *
 * Every control the person sets in the Figure Export panel, as one plain JSON
 * object, versioned within itself. Values the panel derives are not recorded:
 * the font sizes while Auto text is on, the title while it follows the dataset,
 * and the frame rectangle while framing is off (turning framing on starts a
 * new frame). Transient interaction state (a frame being confirmed, a drag,
 * preview samples) is not a setting.
 *
 * `assertFigureExportSessionSettings()` is the only reader: it refuses a
 * missing, unknown or out-of-range key rather than repairing it, so a session
 * restores exactly the settings it saved or fails visibly.
 *
 * @module ui/modules/figure-export/utils/session-settings
 */

import { assertCropRect01 } from './crop.js';
import { requireExactKeys } from '../../../../../utils/exact-record.js';
import { parseDecimalText } from '../../../../../utils/format-units.js';
import { HEX_COLOR } from '../../../../../utils/hex-color.js';
import { FIGURE_DEFAULT_WIDTH_PRESET, FIGURE_WIDTH_PRESETS } from './figure-size.js';

/**
 * The record's version. It sizes the figure physically: its width in
 * millimetres (a journal column, `sizePreset`), which the figure fills at its
 * own height, and text in points. A saved record of any other version is
 * refused whole by `readSavedFigureExportSettings`.
 */
export const FIGURE_EXPORT_SESSION_SETTINGS_VERSION = 3;

/** The width presets (`utils/figure-size.js` `FIGURE_WIDTH_PRESETS`) and a width of one's own. */
export const FIGURE_EXPORT_SIZE_PRESETS = Object.freeze([...Object.keys(FIGURE_WIDTH_PRESETS), 'custom']);
export { FIGURE_DEFAULT_WIDTH_PRESET };
export const FIGURE_EXPORT_FONT_FAMILIES = Object.freeze([
  'Arial, Helvetica, sans-serif',
  'Helvetica, Arial, sans-serif',
  '"Times New Roman", Times, serif',
]);
export const FIGURE_EXPORT_BACKGROUNDS = Object.freeze(['viewer', 'white', 'transparent', 'custom']);
export const FIGURE_EXPORT_LEGEND_POSITIONS = Object.freeze(['right', 'bottom']);
export const FIGURE_EXPORT_COLORBLIND_MODES = Object.freeze(['none', 'deuteranopia', 'protanopia', 'tritanopia']);
export const FIGURE_EXPORT_DOWNLOADS = Object.freeze(['svg', 'png', 'svg+png', 'png-multi', 'all']);
export const FIGURE_EXPORT_DPIS = Object.freeze([150, 300, 600]);
export const FIGURE_EXPORT_SVG_STRATEGIES = Object.freeze(['full-vector', 'optimized-vector', 'hybrid']);
/** How an SVG draws its points until another is chosen: every point, editable. */
export const FIGURE_EXPORT_DEFAULT_SVG_STRATEGY = 'full-vector';

const KEYS = Object.freeze([
  'version',
  'sizePreset', 'width', 'frame',
  'background', 'backgroundColor', 'fontFamily', 'autoTextSize', 'fontSizes',
  'titleFollowsDataset', 'title', 'xLabel', 'yLabel',
  'includeAxes', 'includeLegend', 'referenceGrid', 'showOrientation', 'depthSort', 'legendPosition',
  'emphasizeSelection', 'selectionMutedOpacity',
  'preview',
  'download', 'dpi', 'svgStrategy', 'optimizedTargetCount', 'exportAllViews',
]);
const FRAME_KEYS = Object.freeze(['lockAspect', 'rect']);
const RECT_KEYS = Object.freeze(['x', 'y', 'width', 'height']);
const FONT_SIZE_KEYS = Object.freeze(['base', 'legend', 'ticks', 'axisLabel', 'title', 'centroidLabel']);
const PREVIEW_KEYS = Object.freeze(['enabled', 'colorblindMode']);

/**
 * The ranges the export itself accepts (`figure-export-ui.js`): a figure at
 * least 10 mm wide (a plot and a line of text), with no widest (the browser's
 * canvas decides what a PNG can be, `utils/figure-canvas.js`; an SVG has no
 * limit); text from 1 pt, in steps of half a point, to 375 pt (500 px).
 */
export const FIGURE_EXPORT_SETTING_RANGES = Object.freeze({
  widthMm: Object.freeze([10, Infinity]),
  fontSize: Object.freeze([1, 375]),
  optimizedTargetCount: Object.freeze([1000, 5_000_000]),
  selectionMutedOpacity: Object.freeze([0, 1]),
});

// ---------------------------------------------------------------------------
// The settings as parameters of `figure-export.set`
// ---------------------------------------------------------------------------

/**
 * Settings that change together, so a step that changes one carries the
 * others (typing a title also stops it following the dataset; a font size
 * typed turns Auto text off): a burst of typing is one coalesced step.
 */
export const FIGURE_EXPORT_LINKED_KEYS = Object.freeze([
  // A preset is its own width: the two are read, restored and recorded together.
  Object.freeze(['sizePreset', 'width']),
  Object.freeze(['titleFollowsDataset', 'title']),
  Object.freeze(['autoTextSize', 'fontSizes']),
]);

const snakeOf = key => key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
const camelOf = key => key.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());

function convertKeys(value, convert) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [convert(key), convertKeys(item, convert)]));
}

/**
 * Settings (some keys of a record, `assertFigureExportSessionSettings`'s
 * names) as the parameters of `figure-export.set`: snake_case, as an agent,
 * Python and R write them.
 *
 * @param {Partial<FigureExportSessionSettings>} settings
 * @returns {object}
 */
export function figureExportParamsOf(settings) {
  return convertKeys(settings, snakeOf);
}

/**
 * The parameters of `figure-export.set` as settings (some keys of a record).
 *
 * @param {object} params
 * @returns {Partial<Omit<FigureExportSessionSettings, 'frame'>> & {frame?: FigureExportSessionSettings['frame']|typeof FIGURE_EXPORT_FRAME_CELLS}}
 *   `frame` may be the word that asks for the frame around the cells
 */
export function figureExportSettingsOf(params) {
  return convertKeys(params, camelOf);
}

/**
 * The settings that differ between two records, each linked group whole
 * (`FIGURE_EXPORT_LINKED_KEYS`); `version` is never one.
 *
 * @param {FigureExportSessionSettings} before
 * @param {FigureExportSessionSettings} after
 * @returns {Partial<FigureExportSessionSettings>}
 */
export function changedFigureExportSettings(before, after) {
  const changed = new Set(KEYS.filter(key => key !== 'version' && JSON.stringify(before[key]) !== JSON.stringify(after[key])));
  for (const group of FIGURE_EXPORT_LINKED_KEYS) {
    if (group.some(key => changed.has(key))) for (const key of group) changed.add(key);
  }
  return Object.fromEntries(KEYS.filter(key => changed.has(key)).map(key => [key, structuredClone(after[key])]));
}

// Whole or half points (the action's schema has no step; `assertPointSize` holds it).
const FONT_SIZE = Object.freeze({
  type: 'number', minimum: FIGURE_EXPORT_SETTING_RANGES.fontSize[0], maximum: FIGURE_EXPORT_SETTING_RANGES.fontSize[1],
});
/** The text each font size sizes, said in the schema so that a caller does not take `title` for the panel titles. */
const FONT_SIZE_TEXT = Object.freeze({
  base: 'Panel titles of a multi-panel figure ("A. Cell type") and the other small labels (orientation, selection badge).',
  legend: 'The legend\'s title and entries.',
  ticks: 'Axis tick labels.',
  axisLabel: 'Axis labels.',
  title: 'The figure\'s title above everything (not the panel titles: base sizes those).',
  centroidLabel: 'Category labels drawn at their cells\' centers.',
});
const FRACTION = Object.freeze({ type: 'number', minimum: 0, maximum: 1 });

/** A frame as a record holds it: the part of the view exported, or null for the whole view. */
const FRAME_SETTING = Object.freeze({
  type: ['object', 'null'], additionalProperties: false, required: ['lock_aspect', 'rect'],
  description: 'The part of the view exported (needs the preview on), or null for the whole view.',
  properties: {
    lock_aspect: { type: 'boolean', description: 'Keep the frame\'s shape when it is resized.' },
    rect: {
      type: 'object', additionalProperties: false, required: ['x', 'y', 'width', 'height'],
      description: 'The frame as fractions of the view, from its top left.',
      properties: { x: FRACTION, y: FRACTION, width: FRACTION, height: FRACTION },
    },
  },
});

/** The value of `frame` that fits the frame to the cells (Fit the cells). */
export const FIGURE_EXPORT_FRAME_CELLS = 'cells';

/**
 * The parameter schema of `figure-export.set` (`app/actions/definitions/settings.js`):
 * every setting of a record but its version, each optional, in the names
 * `figureExportParamsOf` gives them; `frame` also takes "cells" (the panel's
 * Fit the cells: the frame every cell drawn fills). `tests/figure-export-session-settings-contract.test.mjs`
 * holds it to the record's keys, so a setting added to the record is a
 * parameter the day it lands. `FIGURE_EXPORT_SETTINGS` is the record as
 * `figure-export.get` reads it back.
 */
export const FIGURE_EXPORT_PARAMS = Object.freeze({
  type: 'object', additionalProperties: false,
  examples: [{ size_preset: 'double-column', include_axes: false }, { width: 180 }, { frame: FIGURE_EXPORT_FRAME_CELLS }],
  properties: {
    size_preset: {
      enum: [...FIGURE_EXPORT_SIZE_PRESETS],
      description: `The figure's width as a journal column: single-column (${FIGURE_WIDTH_PRESETS['single-column']} mm), one-and-half-column (${FIGURE_WIDTH_PRESETS['one-and-half-column']} mm), double-column (${FIGURE_WIDTH_PRESETS['double-column']} mm); custom is the width given. A preset sets width.`,
    },
    // The width is millimetres and text points, no pixels: an agent given pixels converts them wrongly
    // (1800 for "180 mm" at 10 px a mm is a figure 476 mm wide at 300 dpi).
    width: {
      type: 'number', minimum: FIGURE_EXPORT_SETTING_RANGES.widthMm[0],
      description: 'The figure\'s width in millimetres; the figure is exactly this wide, at every resolution, and as tall as its plots make it (each keeps its view\'s shape, or its frame\'s: set a frame to change the shape). A width that is not a preset\'s makes size_preset custom.',
    },
    frame: {
      description: 'The part of the view exported (needs the preview on, which "cells" turns on), null for the whole view, or "cells": the frame every cell the figure draws fills, with a small margin (the panel\'s Fit the cells), so a plot takes the cells\' shape instead of its pane\'s (a narrow pane gives a narrow plot; never rearrange the person\'s screen for a figure). With export_all_views, one frame holding every panel\'s cells.',
      oneOf: [FRAME_SETTING, { const: FIGURE_EXPORT_FRAME_CELLS }],
    },
    background: { enum: [...FIGURE_EXPORT_BACKGROUNDS], description: 'The background: the viewer\'s, white, transparent or custom.' },
    background_color: { type: 'string', pattern: '^#[0-9a-f]{6}$', examples: ['#ffffff'], description: 'The custom background color, lowercase #rrggbb.' },
    font_family: { enum: [...FIGURE_EXPORT_FONT_FAMILIES], description: 'The font of every text.' },
    auto_text_size: { type: 'boolean', description: 'Set the text in the sizes journals print figure text at: 7 pt, ticks and centroid labels 6 pt, the title 8 pt (font_sizes is then null).' },
    font_sizes: {
      type: ['object', 'null'], additionalProperties: false, required: [...FONT_SIZE_KEYS].map(snakeOf),
      description: 'Text sizes in points (1/72 inch; halves allowed) while auto_text_size is off, else null. They keep their printed size at any width and resolution.',
      properties: Object.fromEntries(FONT_SIZE_KEYS.map(key => [snakeOf(key), { ...FONT_SIZE, description: FONT_SIZE_TEXT[key] }])),
    },
    title_follows_dataset: { type: 'boolean', description: 'The title is the dataset\'s name (title is then null).' },
    title: { type: ['string', 'null'], description: 'The figure title while it does not follow the dataset, else null.' },
    x_label: { type: 'string', description: 'The x axis label.' },
    y_label: { type: 'string', description: 'The y axis label.' },
    include_axes: { type: 'boolean', description: 'Draw the axes.' },
    include_legend: { type: 'boolean', description: 'Draw the legend.' },
    reference_grid: { type: 'boolean', description: 'Draw a reference grid.' },
    show_orientation: { type: 'boolean', description: 'Draw the 3D orientation indicator.' },
    depth_sort: { type: 'boolean', description: 'Draw 3D points back to front.' },
    legend_position: { enum: [...FIGURE_EXPORT_LEGEND_POSITIONS], description: 'Where the legend goes.' },
    emphasize_selection: { type: 'boolean', description: 'Fade the cells that are not highlighted.' },
    selection_muted_opacity: { ...FRACTION, description: 'The opacity of the faded cells, 0 to 1.' },
    preview: {
      type: 'object', additionalProperties: false, required: ['enabled', 'colorblind_mode'],
      description: 'The preview in the panel and the color-vision deficiency it simulates; with the preview on, view.picture with source "export" draws that simulation too (Export writes the true colors).',
      properties: {
        enabled: { type: 'boolean' },
        colorblind_mode: { enum: [...FIGURE_EXPORT_COLORBLIND_MODES] },
      },
    },
    download: { enum: [...FIGURE_EXPORT_DOWNLOADS], description: 'What Export downloads.' },
    dpi: { enum: [...FIGURE_EXPORT_DPIS], description: 'The resolution of a PNG: its pixels are the width in inches times this (an SVG is the same size, as vectors).' },
    svg_strategy: { enum: [...FIGURE_EXPORT_SVG_STRATEGIES], description: 'How an SVG draws its points: full-vector (the default: every point a circle, editable; a file grows with the cells drawn), optimized-vector (fewer points, optimized_target_count), hybrid (the points as one image, text and axes as vector: small at any cell count).' },
    optimized_target_count: {
      type: 'integer', minimum: FIGURE_EXPORT_SETTING_RANGES.optimizedTargetCount[0], maximum: FIGURE_EXPORT_SETTING_RANGES.optimizedTargetCount[1],
      description: 'How many points an optimized SVG keeps.',
    },
    export_all_views: { type: 'boolean', description: 'Export every view of the multiview, side by side: each panel is titled by its view\'s name (view_rename; a view with none by its field and filters).' },
  },
});

/**
 * The settings as `figure-export.get` reads them back: every parameter of
 * `figure-export.set`, required, the frame as the record holds it (a rect or
 * null; "cells" is something to do, not a setting).
 */
export const FIGURE_EXPORT_SETTINGS = Object.freeze({
  type: 'object', additionalProperties: false,
  required: Object.keys(FIGURE_EXPORT_PARAMS.properties),
  properties: { ...FIGURE_EXPORT_PARAMS.properties, frame: FRAME_SETTING },
});

function context(path) {
  return `Figure-export session settings${path ? `.${path}` : ''}`;
}

function assertBoolean(value, path) {
  if (typeof value !== 'boolean') throw new TypeError(`${context(path)} must be a boolean.`);
}

function assertString(value, path) {
  if (typeof value !== 'string') throw new TypeError(`${context(path)} must be a string.`);
}

function assertOneOf(value, allowed, path) {
  if (!allowed.includes(value)) {
    throw new RangeError(`${context(path)} must be one of ${allowed.map(v => JSON.stringify(v)).join(', ')}.`);
  }
}

function assertInteger(value, [minimum, maximum], path) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${context(path)} must be a whole number from ${minimum} to ${maximum}.`);
  }
}

/** A text size in points: a whole or half point in its range. */
function assertPointSize(value, [minimum, maximum], path) {
  if (!Number.isFinite(value) || value < minimum || value > maximum || !Number.isInteger(value * 2)) {
    throw new RangeError(`${context(path)} must be a size in points from ${minimum} to ${maximum}, in steps of 0.5.`);
  }
}

/**
 * Validate one recorded settings object exactly; returns it.
 *
 * @param {unknown} settings
 * @returns {FigureExportSessionSettings}
 */
export function assertFigureExportSessionSettings(settings) {
  requireExactKeys(settings, KEYS, context(''));
  if (settings.version !== FIGURE_EXPORT_SESSION_SETTINGS_VERSION) {
    throw new RangeError(
      `${context('version')} must be ${FIGURE_EXPORT_SESSION_SETTINGS_VERSION}.`
    );
  }
  assertOneOf(settings.sizePreset, FIGURE_EXPORT_SIZE_PRESETS, 'sizePreset');
  if (!Number.isFinite(settings.width) || settings.width < FIGURE_EXPORT_SETTING_RANGES.widthMm[0]) {
    throw new RangeError(`${context('width')} must be a width in millimetres, at least ${FIGURE_EXPORT_SETTING_RANGES.widthMm[0]}.`);
  }
  if (settings.sizePreset !== 'custom' && settings.width !== FIGURE_WIDTH_PRESETS[settings.sizePreset]) {
    throw new RangeError(`${context('width')} must be ${FIGURE_WIDTH_PRESETS[settings.sizePreset]} mm, the ${settings.sizePreset} width (or sizePreset custom).`);
  }

  if (settings.frame !== null) {
    requireExactKeys(settings.frame, FRAME_KEYS, context('frame'));
    assertBoolean(settings.frame.lockAspect, 'frame.lockAspect');
    requireExactKeys(settings.frame.rect, RECT_KEYS, context('frame.rect'));
    for (const key of RECT_KEYS) {
      if (!Number.isFinite(settings.frame.rect[key])) {
        throw new TypeError(`${context(`frame.rect.${key}`)} must be a finite number.`);
      }
    }
    assertCropRect01({ enabled: true, ...settings.frame.rect });
  }

  assertOneOf(settings.background, FIGURE_EXPORT_BACKGROUNDS, 'background');
  assertString(settings.backgroundColor, 'backgroundColor');
  if (!HEX_COLOR.test(settings.backgroundColor)) {
    throw new RangeError(`${context('backgroundColor')} must be a lowercase #rrggbb color.`);
  }
  assertOneOf(settings.fontFamily, FIGURE_EXPORT_FONT_FAMILIES, 'fontFamily');
  assertBoolean(settings.autoTextSize, 'autoTextSize');
  if (settings.autoTextSize) {
    if (settings.fontSizes !== null) {
      throw new TypeError(`${context('fontSizes')} must be null while autoTextSize derives them.`);
    }
  } else {
    requireExactKeys(settings.fontSizes, FONT_SIZE_KEYS, context('fontSizes'));
    for (const key of FONT_SIZE_KEYS) {
      assertPointSize(settings.fontSizes[key], FIGURE_EXPORT_SETTING_RANGES.fontSize, `fontSizes.${key}`);
    }
  }

  assertBoolean(settings.titleFollowsDataset, 'titleFollowsDataset');
  if (settings.titleFollowsDataset) {
    if (settings.title !== null) {
      throw new TypeError(`${context('title')} must be null while the title follows the dataset.`);
    }
  } else {
    assertString(settings.title, 'title');
  }
  assertString(settings.xLabel, 'xLabel');
  assertString(settings.yLabel, 'yLabel');

  for (const key of ['includeAxes', 'includeLegend', 'referenceGrid', 'showOrientation', 'depthSort', 'emphasizeSelection', 'exportAllViews']) {
    assertBoolean(settings[key], key);
  }
  assertOneOf(settings.legendPosition, FIGURE_EXPORT_LEGEND_POSITIONS, 'legendPosition');
  const [opacityMin, opacityMax] = FIGURE_EXPORT_SETTING_RANGES.selectionMutedOpacity;
  if (
    !Number.isFinite(settings.selectionMutedOpacity) ||
    settings.selectionMutedOpacity < opacityMin ||
    settings.selectionMutedOpacity > opacityMax
  ) {
    throw new RangeError(`${context('selectionMutedOpacity')} must be a number from ${opacityMin} to ${opacityMax}.`);
  }

  requireExactKeys(settings.preview, PREVIEW_KEYS, context('preview'));
  assertBoolean(settings.preview.enabled, 'preview.enabled');
  assertOneOf(settings.preview.colorblindMode, FIGURE_EXPORT_COLORBLIND_MODES, 'preview.colorblindMode');
  if (settings.frame !== null && !settings.preview.enabled) {
    // The panel frames on the preview: turning the preview off ends framing.
    throw new TypeError(`${context('frame')} requires preview.enabled.`);
  }

  assertOneOf(settings.download, FIGURE_EXPORT_DOWNLOADS, 'download');
  assertOneOf(settings.dpi, FIGURE_EXPORT_DPIS, 'dpi');
  assertOneOf(settings.svgStrategy, FIGURE_EXPORT_SVG_STRATEGIES, 'svgStrategy');
  assertInteger(
    settings.optimizedTargetCount,
    FIGURE_EXPORT_SETTING_RANGES.optimizedTargetCount,
    'optimizedTargetCount'
  );
  return settings;
}

/**
 * @typedef {object} FigureExportSessionSettings
 * @property {3} version
 * @property {'single-column'|'one-and-half-column'|'double-column'|'custom'} sizePreset
 * @property {number} width - the figure's width in millimetres (at least 10); a preset's own width unless custom
 * @property {null|{lockAspect: boolean, rect: {x: number, y: number, width: number, height: number}}} frame
 *   - null while framing is off; the rect is normalized to the viewport
 * @property {'viewer'|'white'|'transparent'|'custom'} background
 * @property {string} backgroundColor - '#rrggbb', the custom background color control
 * @property {string} fontFamily - one of the panel's font families
 * @property {boolean} autoTextSize
 * @property {null|{base: number, legend: number, ticks: number, axisLabel: number, title: number, centroidLabel: number}} fontSizes
 *   - null while autoTextSize sets them; points, 1–375 in steps of 0.5
 * @property {boolean} titleFollowsDataset
 * @property {string|null} title - null while the title follows the dataset
 * @property {string} xLabel
 * @property {string} yLabel
 * @property {boolean} includeAxes
 * @property {boolean} includeLegend
 * @property {boolean} referenceGrid
 * @property {boolean} showOrientation
 * @property {boolean} depthSort
 * @property {'right'|'bottom'} legendPosition
 * @property {boolean} emphasizeSelection
 * @property {number} selectionMutedOpacity - 0–1
 * @property {{enabled: boolean, colorblindMode: 'none'|'deuteranopia'|'protanopia'|'tritanopia'}} preview
 * @property {'svg'|'png'|'svg+png'|'png-multi'|'all'} download
 * @property {150|300|600} dpi
 * @property {'full-vector'|'optimized-vector'|'hybrid'} svgStrategy - full-vector until another is chosen
 * @property {number} optimizedTargetCount - 1000–5000000
 * @property {boolean} exportAllViews
 */

/**
 * A saved record (a session's, a dataset's starting view's, a history
 * step's) read against the settings the panel holds now. A record of another
 * version (or with none) is refused whole: the panel keeps its settings and
 * `unread` names the record and its version. Otherwise every setting the
 * current reader accepts is taken, and a setting it refuses (out of range,
 * unknown) keeps the panel's value and is named in `unread`. One setting
 * never fails the others: a session that saved a value this version cannot
 * use restores everything else instead of losing every figure setting.
 * Settings that go together (`FIGURE_EXPORT_LINKED_KEYS`) are taken together,
 * and one that needs another (a frame needs the preview) is tried again once
 * the others are in.
 *
 * @param {unknown} saved
 * @param {FigureExportSessionSettings} current - the panel's record now (valid)
 * @returns {{settings: FigureExportSessionSettings, unread: Array<{setting: string, reason: string}>}}
 */
export function readSavedFigureExportSettings(saved, current) {
  assertFigureExportSessionSettings(current);
  if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) {
    return { settings: current, unread: [{ setting: 'settings', reason: 'not a record of settings' }] };
  }
  if (saved.version !== FIGURE_EXPORT_SESSION_SETTINGS_VERSION) {
    const saidVersion = Number.isSafeInteger(saved.version) ? `version ${saved.version}` : 'no version it can read';
    return {
      settings: current,
      unread: [{
        setting: 'settings',
        reason: `they were saved as ${saidVersion}, and this version of Cellucid reads version ${FIGURE_EXPORT_SESSION_SETTINGS_VERSION}`,
      }],
    };
  }
  const record = saved;
  const groups = [];
  for (const key of KEYS) {
    if (key === 'version' || groups.some(group => group.includes(key))) continue;
    groups.push(FIGURE_EXPORT_LINKED_KEYS.find(group => group.includes(key)) ?? [key]);
  }
  let settings = { ...current };
  let pending = groups.filter(group => group.some(key => Object.hasOwn(record, key)));
  const refusals = new Map();
  let progressed = true;
  while (pending.length > 0 && progressed) {
    progressed = false;
    const next = [];
    for (const group of pending) {
      const candidate = { ...settings };
      for (const key of group) if (Object.hasOwn(record, key)) candidate[key] = structuredClone(record[key]);
      try {
        settings = assertFigureExportSessionSettings(candidate);
        progressed = true;
      } catch (error) {
        refusals.set(group, String(error?.message ?? error).replace(/^Figure-export session settings\.?\s*/, ''));
        next.push(group);
      }
    }
    pending = next;
  }
  const unread = pending.map(group => ({ setting: group.join(' and '), reason: refusals.get(group) }));
  for (const key of Object.keys(record)) {
    if (!KEYS.includes(key)) unread.push({ setting: key, reason: 'not a setting of this version' });
  }
  return { settings, unread };
}

/**
 * The last valid value of one number control, for a session saved while the
 * person is half-way through typing in it: the session records the value
 * the control last held validly, and the box keeps what is typed.
 *
 * The value is taken when the control is focused (so a value the panel set
 * itself, with no event, is the one a fresh edit started from) and on every
 * `input` and `change` that leaves it valid.
 *
 * @param {{value: string, addEventListener: Function}} input - A whole-number box, or a decimal box
 * @param {object} options
 * @param {string} options.label - named in the error of a value never valid
 * @param {readonly [number, number]} options.range - inclusive
 * @param {boolean} options.integer
 * @param {AbortSignal} [options.signal] - removes the listeners
 * @returns {{ read(): number, commit(): void }}
 */
export function trackCommittedNumber(input, { label, range, integer, signal }) {
  const [minimum, maximum] = range;
  let committed = null;
  // A whole-number box holds digits; a decimal box (`createDecimalInput`)
  // a point or a comma, read by its one rule (`parseDecimalText`), and one
  // that ends in its separator ("1.", "0,") is still being typed.
  const parse = () => {
    const raw = input.value;
    const value = integer
      ? (/^(0|[1-9][0-9]*)$/.test(raw) ? Number(raw) : NaN)
      : (/[.,]\s*$/.test(raw) ? NaN : parseDecimalText(raw));
    return value >= minimum && value <= maximum ? value : null;
  };
  const commit = () => {
    const value = parse();
    if (value !== null) committed = value;
  };
  for (const type of ['focus', 'input', 'change']) {
    input.addEventListener(type, commit, signal ? { signal } : undefined);
  }
  commit();
  return {
    read() {
      commit();
      if (committed === null) {
        throw new TypeError(
          `Figure export ${label} has never held a ${integer ? 'whole ' : ''}number ${maximum === Infinity ? `of at least ${minimum}` : `from ${minimum} to ${maximum}`}.`
        );
      }
      return committed;
    },
    commit,
  };
}
