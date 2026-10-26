/**
 * @fileoverview The sizes a user gave each analysis's window and expanded
 * view, remembered per analysis.
 *
 * A new window of an analysis opens at the size its last window was resized
 * to, and its expanded view at the size and splits it was last given. The
 * record lives for the dataset (a dataset change clears it) and travels in
 * the session (`analysis/windows` chunk, `sizes`); it is never in the URL.
 *
 * @module analysis/shared/analysis-view-sizes
 */

import { isPlainRecord, requireExactKeys } from '../../../utils/exact-record.js';


const WINDOW_KEYS = ['height', 'width'];
const EXPANDED_VIEW_KEYS = ['footerHeight', 'height', 'optionsWidth', 'statsWidth', 'width'];

function requireSize(value, keys, label) {
  requireExactKeys(value, keys, label);
  for (const key of keys) {
    if (!Number.isFinite(value[key]) || value[key] <= 0) {
      throw new TypeError(`${label} ${key} must be a positive finite number`);
    }
  }
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}

function requireModeId(modeId) {
  if (typeof modeId !== 'string' || modeId.length === 0) {
    throw new TypeError('An analysis size needs a non-empty analysis id');
  }
}

class AnalysisViewSizes {
  constructor() {
    /** @type {Map<string, {width: number, height: number}>} */
    this._window = new Map();
    /** @type {Map<string, {width: number, height: number, optionsWidth: number, footerHeight: number, statsWidth: number}>} */
    this._expandedView = new Map();
  }

  /** @param {string} modeId */
  windowSize(modeId) {
    const size = this._window.get(modeId);
    return size === undefined ? null : { ...size };
  }

  /**
   * @param {string} modeId
   * @param {{width: number, height: number}} size
   */
  rememberWindowSize(modeId, size) {
    requireModeId(modeId);
    this._window.set(modeId, requireSize(size, WINDOW_KEYS, `Window size of "${modeId}"`));
  }

  /** @param {string} modeId */
  expandedViewSize(modeId) {
    const size = this._expandedView.get(modeId);
    return size === undefined ? null : { ...size };
  }

  /**
   * @param {string} modeId
   * @param {{width: number, height: number, optionsWidth: number, footerHeight: number, statsWidth: number}} size
   */
  rememberExpandedViewSize(modeId, size) {
    requireModeId(modeId);
    this._expandedView.set(
      modeId,
      requireSize(size, EXPANDED_VIEW_KEYS, `Expanded view size of "${modeId}"`)
    );
  }

  /** The session record: `{window: {[modeId]: size}, expandedView: {[modeId]: size}}`. */
  exportSizes() {
    return {
      window: Object.fromEntries([...this._window].map(([id, size]) => [id, { ...size }])),
      expandedView: Object.fromEntries(
        [...this._expandedView].map(([id, size]) => [id, { ...size }])
      )
    };
  }

  /**
   * Replace every remembered size with a session's. The record is checked
   * whole before anything changes.
   *
   * @param {{window: Object, expandedView: Object}} sizes
   * @param {(modeId: string) => boolean} isKnownMode
   */
  importSizes(sizes, isKnownMode) {
    requireExactKeys(sizes, ['expandedView', 'window'], 'Analysis view sizes');
    const windowSizes = new Map();
    const expandedViewSizes = new Map();
    for (const [target, record, keys, label] of [
      [windowSizes, sizes.window, WINDOW_KEYS, 'Window size'],
      [expandedViewSizes, sizes.expandedView, EXPANDED_VIEW_KEYS, 'Expanded view size']
    ]) {
      if (!isPlainRecord(record)) throw new TypeError(`${label}s must be an object`);
      for (const [modeId, size] of Object.entries(record)) {
        if (!isKnownMode(modeId)) {
          throw new Error(`${label} names an unknown analysis "${modeId}"`);
        }
        target.set(modeId, requireSize(size, keys, `${label} of "${modeId}"`));
      }
    }
    this._window = windowSizes;
    this._expandedView = expandedViewSizes;
  }

  /** Forget every size (a new dataset). */
  clear() {
    this._window.clear();
    this._expandedView.clear();
  }
}

/** The one record for the page; the analysis panel is a single instance. */
export const analysisViewSizes = new AnalysisViewSizes();
