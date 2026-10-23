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

export const FIGURE_EXPORT_SESSION_SETTINGS_VERSION = 1;

export const FIGURE_EXPORT_SIZE_PRESETS = Object.freeze([
  'screen-half', 'screen', '1200x900', '1600x1200', '1920x1080',
]);
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

const KEYS = Object.freeze([
  'version',
  'sizePreset', 'width', 'height', 'frame',
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

/** The ranges the export itself accepts (`figure-export-ui.js`). */
export const FIGURE_EXPORT_SETTING_RANGES = Object.freeze({
  plotSize: Object.freeze([100, 20_000]),
  fontSize: Object.freeze([1, 500]),
  optimizedTargetCount: Object.freeze([1000, 5_000_000]),
  selectionMutedOpacity: Object.freeze([0, 1]),
});

function context(path) {
  return `Figure-export session settings${path ? `.${path}` : ''}`;
}

function assertPlainObject(value, keys, path) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${context(path)} must be a plain object.`);
  }
  const own = Object.keys(value);
  const unknown = own.filter(key => !keys.includes(key));
  if (unknown.length > 0) {
    throw new TypeError(`${context(path)} has unknown keys: ${unknown.join(', ')}.`);
  }
  const missing = keys.filter(key => !Object.hasOwn(value, key));
  if (missing.length > 0) {
    throw new TypeError(`${context(path)} is missing keys: ${missing.join(', ')}.`);
  }
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

/**
 * Validate one recorded settings object exactly; returns it.
 *
 * @param {unknown} settings
 * @returns {FigureExportSessionSettings}
 */
export function assertFigureExportSessionSettings(settings) {
  assertPlainObject(settings, KEYS, '');
  if (settings.version !== FIGURE_EXPORT_SESSION_SETTINGS_VERSION) {
    throw new RangeError(
      `${context('version')} must be ${FIGURE_EXPORT_SESSION_SETTINGS_VERSION}.`
    );
  }
  assertOneOf(settings.sizePreset, FIGURE_EXPORT_SIZE_PRESETS, 'sizePreset');
  assertInteger(settings.width, FIGURE_EXPORT_SETTING_RANGES.plotSize, 'width');
  assertInteger(settings.height, FIGURE_EXPORT_SETTING_RANGES.plotSize, 'height');

  if (settings.frame !== null) {
    assertPlainObject(settings.frame, FRAME_KEYS, 'frame');
    assertBoolean(settings.frame.lockAspect, 'frame.lockAspect');
    assertPlainObject(settings.frame.rect, RECT_KEYS, 'frame.rect');
    for (const key of RECT_KEYS) {
      if (!Number.isFinite(settings.frame.rect[key])) {
        throw new TypeError(`${context(`frame.rect.${key}`)} must be a finite number.`);
      }
    }
    assertCropRect01({ enabled: true, ...settings.frame.rect });
  }

  assertOneOf(settings.background, FIGURE_EXPORT_BACKGROUNDS, 'background');
  assertString(settings.backgroundColor, 'backgroundColor');
  if (!/^#[0-9a-f]{6}$/.test(settings.backgroundColor)) {
    throw new RangeError(`${context('backgroundColor')} must be a lowercase #rrggbb color.`);
  }
  assertOneOf(settings.fontFamily, FIGURE_EXPORT_FONT_FAMILIES, 'fontFamily');
  assertBoolean(settings.autoTextSize, 'autoTextSize');
  if (settings.autoTextSize) {
    if (settings.fontSizes !== null) {
      throw new TypeError(`${context('fontSizes')} must be null while autoTextSize derives them.`);
    }
  } else {
    assertPlainObject(settings.fontSizes, FONT_SIZE_KEYS, 'fontSizes');
    for (const key of FONT_SIZE_KEYS) {
      assertInteger(settings.fontSizes[key], FIGURE_EXPORT_SETTING_RANGES.fontSize, `fontSizes.${key}`);
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

  assertPlainObject(settings.preview, PREVIEW_KEYS, 'preview');
  assertBoolean(settings.preview.enabled, 'preview.enabled');
  assertOneOf(settings.preview.colorblindMode, FIGURE_EXPORT_COLORBLIND_MODES, 'preview.colorblindMode');
  if (settings.frame !== null && !settings.preview.enabled) {
    // The panel frames on the preview: turning the preview off ends framing.
    throw new TypeError(`${context('frame')} requires preview.enabled.`);
  }

  assertOneOf(settings.download, FIGURE_EXPORT_DOWNLOADS, 'download');
  assertOneOf(settings.dpi, FIGURE_EXPORT_DPIS, 'dpi');
  if (settings.svgStrategy !== null) {
    assertOneOf(settings.svgStrategy, FIGURE_EXPORT_SVG_STRATEGIES, 'svgStrategy');
  }
  assertInteger(
    settings.optimizedTargetCount,
    FIGURE_EXPORT_SETTING_RANGES.optimizedTargetCount,
    'optimizedTargetCount'
  );
  return settings;
}

/**
 * @typedef {object} FigureExportSessionSettings
 * @property {1} version
 * @property {'screen-half'|'screen'|'1200x900'|'1600x1200'|'1920x1080'} sizePreset
 * @property {number} width - plot width in CSS px, 100–20000
 * @property {number} height - plot height in CSS px, 100–20000
 * @property {null|{lockAspect: boolean, rect: {x: number, y: number, width: number, height: number}}} frame
 *   - null while framing is off; the rect is normalized to the viewport
 * @property {'viewer'|'white'|'transparent'|'custom'} background
 * @property {string} backgroundColor - '#rrggbb', the custom background colour control
 * @property {string} fontFamily - one of the panel's font families
 * @property {boolean} autoTextSize
 * @property {null|{base: number, legend: number, ticks: number, axisLabel: number, title: number, centroidLabel: number}} fontSizes
 *   - null while autoTextSize derives them; whole px, 1–500
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
 * @property {null|'full-vector'|'optimized-vector'|'hybrid'} svgStrategy - null until chosen
 * @property {number} optimizedTargetCount - 1000–5000000
 * @property {boolean} exportAllViews
 */

/**
 * The last valid value of one number control, for a session saved while the
 * person is half-way through typing in it: the session records the value
 * the control last held validly, and the box keeps what is typed.
 *
 * The value is taken when the control is focused (so a value the panel set
 * itself, with no event, is the one a fresh edit started from) and on every
 * `input` and `change` that leaves it valid.
 *
 * @param {{value: string, addEventListener: Function}} input
 * @param {object} options
 * @param {string} options.label - named in the error of a value never valid
 * @param {readonly [number, number]} options.range - inclusive
 * @param {boolean} options.integer
 * @param {AbortSignal} [options.signal] - removes the listeners
 * @returns {{ read(): number, commit(): void }}
 */
export function trackCommittedNumber(input, { label, range, integer, signal }) {
  const [minimum, maximum] = range;
  const pattern = integer
    ? /^(0|[1-9][0-9]*)$/
    : /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
  let committed = null;
  const parse = () => {
    const raw = input.value;
    const value = Number(raw);
    return pattern.test(raw) && value >= minimum && value <= maximum ? value : null;
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
          `Figure export ${label} has never held a ${integer ? 'whole ' : ''}number from ${minimum} to ${maximum}.`
        );
      }
      return committed;
    },
    commit,
  };
}
