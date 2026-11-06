/**
 * @fileoverview The `analysis` state domain: the analyses themselves, in the
 * analysis windows and the panel docked in the sidebar: which analysis each
 * shows, its settings and its result.
 *
 * Value:
 *
 *     {windows: [{modeId, headerTitle, settings, result}, …],
 *                              // floating analysis windows, in the order they
 *                              // opened (window 1 first)
 *      docked: {openMode, modes: {[mode]: {settings, result}}} | null}
 *
 * Where each window stands, its size, whether it is folded, and the sizes
 * remembered per analysis are page layout: the `layout` domain holds them
 * (`layout.analysis`, History v2 §3.15.5), so "Panels, windows and theme"
 * covers them as every other panel's geometry.
 *
 * Each `result` is null or `{kind, version, payload}`: JSON values and typed
 * arrays, as the analysis exports it (`analysis/shared/analysis-result-session.js`);
 * a result is restored as it was, never computed again, or
 * `{kind, leftOut: true, provenance}`, a result a shared session left out
 * (restored as no result, and captured as the same record until the
 * analysis has a result again; opening the file runs it again,
 * `session/recompute-results.js`). Null parts: the analysis code never
 * loaded on this page, so nothing was ever opened.
 *
 * A result's typed arrays are kept by reference (an analysis makes a new
 * result each run and never writes one in place), so capturing an unchanged
 * result again hashes nothing new; the settings around them are copied.
 *
 * Restore closes the windows and opens the value's again, from their
 * descriptors (`createFromSessionDescriptor`), when the windows differ: the
 * n-th window opens at the place the n-th open one had (the `layout` domain,
 * restored after this one, puts each at its recorded place when it is
 * restored too), and a window beyond them where a new window of its analysis
 * opens. It hands the docked panel its record (`importSessionState`) when it
 * differs; a mode of the docked panel first opened after the value was taken
 * is unmade there (`AnalysisUIManager.releaseMode`), so it opens with its
 * opening settings again.
 *
 * @module app/state/domains/analysis
 */

import { sameValue } from './same-value.js';
import { formatCountOf } from '../../../utils/format-units.js';

/** A deep copy of plain data that keeps typed arrays (immutable results) by reference. */
function clonePlain(value) {
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return value;
  if (Array.isArray(value)) return value.map(clonePlain);
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = clonePlain(item);
  return out;
}

/**
 * @param {{analysis: () => Promise<{comparisonModule: object, analysisWindowManager: object}|null>}} options -
 *   The analysis module once its code arrived, or null when it could not load.
 */
export function createAnalysisDomain({ analysis }) {
  /** The value captured last: given back as the same object while the analyses are unchanged (see `capture`). */
  let previous = null;

  /**
   * The analyses now. While nothing about them changed, the value captured
   * last is given back itself: the history captures the analyses with every
   * highlight change (their page selections follow the pages,
   * `DERIVED_DOMAINS`), and a value object hashed once is never hashed again
   * (`value-pool.js`), so an unchanged analysis costs a comparison, not a
   * hash of its results.
   */
  async function capture() {
    const refs = await analysis();
    if (refs === null) return { windows: [], docked: null };
    const { comparisonModule, analysisWindowManager } = refs;
    const value = {
      windows: clonePlain(analysisWindowManager.exportSessionWindows()),
      docked: clonePlain(comparisonModule.exportSessionState()),
    };
    if (previous !== null && sameValue(previous, value)) return previous;
    previous = value;
    return value;
  }

  return {
    capture,
    async restore(value) {
      // Checked whole before anything closes: a refusal changes nothing.
      if (value === null || typeof value !== 'object' || Object.keys(value).length !== 2 || !Array.isArray(value.windows)
        || !Object.hasOwn(value, 'docked') || (value.docked !== null && typeof value.docked !== 'object')) {
        throw new TypeError('The analyses to restore must be exactly their windows and the docked analysis.');
      }
      const refs = await analysis();
      if (refs === null) {
        if (value.windows.length === 0 && value.docked === null) return;
        throw new Error('The analysis tools could not load on this page, so its analyses cannot be shown.');
      }
      const current = await capture();
      if (sameValue(current, value)) return;
      const { comparisonModule, analysisWindowManager } = refs;
      if (!sameValue(current.windows, value.windows)) {
        const places = analysisWindowManager.exportWindowPlaces();
        await analysisWindowManager.closeAll();
        for (const [index, descriptor] of value.windows.entries()) {
          await analysisWindowManager.createFromSessionDescriptor(clonePlain(descriptor), places[index] ?? null);
        }
      }
      if (value.docked !== null && !sameValue(current.docked, value.docked)) {
        await comparisonModule.importSessionState(clonePlain(value.docked));
      }
    },
    describe(a, b) {
      const lines = [];
      if (a.windows.length !== b.windows.length) {
        lines.push(`${formatCountOf(b.windows.length, 'analysis window')} (was ${a.windows.length})`);
      } else {
        b.windows.forEach((window, index) => {
          const before = a.windows[index];
          if (sameValue(before, window)) return;
          if (!sameValue(before.result, window.result)) lines.push(`${window.headerTitle}: result changed`);
          else if (!sameValue(before.settings, window.settings)) lines.push(`${window.headerTitle}: settings changed`);
          else lines.push(`Window ${index + 1}: ${window.headerTitle}`);
        });
      }
      const dockedA = a.docked ?? { openMode: null, modes: {} };
      const dockedB = b.docked ?? { openMode: null, modes: {} };
      if (dockedA.openMode !== dockedB.openMode) lines.push(dockedB.openMode === null ? 'Analysis panel closed' : `Analysis ${dockedB.openMode} opened`);
      for (const [mode, record] of Object.entries(dockedB.modes)) {
        const before = dockedA.modes[mode];
        if (before === undefined || sameValue(before, record)) continue;
        lines.push(`Analysis ${mode}: ${sameValue(before.result, record.result) ? 'settings' : 'result'} changed`);
      }
      return lines;
    },
  };
}
