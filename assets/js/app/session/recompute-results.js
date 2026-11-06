/**
 * @fileoverview The analysis results a shared session left out, computed
 * again once it is open (History v2 §3.15.4: Share › Results "compute again
 * on open").
 *
 * A share that leaves results out writes each as the record of a result
 * left out (`analysis/shared/analysis-result-session.js` `leftOutResultOf`:
 * its kind and what it was computed on, no payload), and an analysis
 * restored with one shows its settings and no result. Once a session file or
 * a saved state is shown, each analysis at the head whose result was left
 * out is run again through the catalogue's `analysis.run`: an ordinary step
 * (by "Session"), so undo takes it back and the history says it. A jump
 * later never runs one again: only opening does. A run that is refused (its
 * analysis is not shown, so it cannot draw) or fails is said, and its record
 * stays, so the next opening tries again.
 *
 * What the result computed here was computed on is compared with what the
 * shared one was (`result-provenance.js` `staleReasons`, the one rule a
 * stale result is told by): where they differ, the person is told why.
 *
 * @module session/recompute-results
 */

import { isLeftOutResult } from '../analysis/shared/analysis-result-session.js';
import { analysisModeOfId } from '../analysis/options/analysis-modes.js';
import { requireProvenance, staleReasons } from '../analysis/shared/result-provenance.js';

/**
 * Each result an `analysis` value (`app/state/domains/analysis.js`) holds as
 * left out, with where it is as `analysis.run` names it: `in` a window's
 * number (in the order the windows opened) or `'panel'` (the docked mode).
 *
 * @param {{windows: object[], docked: {modes: Object<string, {result: unknown}>}|null}|null|undefined} value
 * @returns {Array<{modeId: string, analysis: string|null, title: string, in: number|'panel', provenance: object|null}>}
 */
export function leftOutResultsOf(value) {
  if (value === null || typeof value !== 'object') return [];
  const out = [];
  const add = (modeId, where, result) => {
    if (!isLeftOutResult(result)) return;
    const mode = analysisModeOfId(modeId);
    out.push({ modeId, analysis: mode?.name ?? null, title: mode?.title ?? modeId, in: where, provenance: result.provenance });
  };
  (Array.isArray(value.windows) ? value.windows : []).forEach((window, index) => add(window?.modeId, index + 1, window?.result));
  for (const [modeId, mode] of Object.entries(value.docked?.modes ?? {})) add(modeId, 'panel', mode?.result);
  return out;
}

/** Why the result computed here differs from the shared one, from their provenances; empty when it does not (or cannot be told). */
function differences(recorded, current) {
  try {
    requireProvenance(recorded);
    requireProvenance(current);
  } catch {
    return [];
  }
  return staleReasons(recorded, current);
}

/** Where an analysis is, as a sentence names it. */
function placeOf(entry) {
  return entry.in === 'panel' ? entry.title : `${entry.title} (window ${entry.in})`;
}

/**
 * Run again each analysis at the head of the tracker shown whose result a
 * shared session left out, as steps of `analysis.run` (origin `session`).
 * Resolves to what was run (`differs`: why its inputs are not the shared
 * result's, one sentence each) and what was not (`reason`); never rejects
 * for a run, which the history shown already holds the file without.
 *
 * @param {{history: {active: {headId: string}|null, valueAt: (step: string, domain: string) => unknown, idle?: () => Promise<void>},
 *   dispatcher: {dispatch: (type: string, params: object, meta: object) => Promise<{step: object|null}>},
 *   signal?: AbortSignal|null}} options
 * @returns {Promise<{ran: Array<{what: string, differs: string[]}>, notRun: Array<{what: string, reason: string}>}>}
 */
export async function recomputeLeftOutResults({ history, dispatcher, signal = null }) {
  const ran = [];
  const notRun = [];
  if (history?.active == null) return { ran, notRun };
  const leftOut = leftOutResultsOf(history.valueAt(history.active.headId, 'analysis'));
  for (const entry of leftOut) {
    if (signal?.aborted) break;
    const what = placeOf(entry);
    if (entry.analysis === null) {
      notRun.push({ what, reason: 'This version of Cellucid has no such analysis.' });
      continue;
    }
    try {
      const { step } = await dispatcher.dispatch('analysis.run', { analysis: entry.analysis, in: entry.in }, { origin: 'session', signal });
      // The result computed here, as the history keeps it at its step.
      const value = step === null ? null : history.valueAt(step.id, 'analysis');
      const now = entry.in === 'panel' ? value?.docked?.modes?.[entry.modeId]?.result : value?.windows?.[entry.in - 1]?.result;
      ran.push({ what, differs: now?.provenance === undefined ? [] : differences(entry.provenance, now.provenance) });
    } catch (error) {
      if (signal?.aborted) break;
      notRun.push({ what, reason: error?.message || String(error) });
    }
  }
  return { ran, notRun };
}

/**
 * The sentences that tell the person what `recomputeLeftOutResults` did:
 * `{tone, text}` each, none when nothing was left out.
 *
 * @param {{ran: Array<{what: string, differs: string[]}>, notRun: Array<{what: string, reason: string}>}} outcome
 * @returns {Array<{tone: 'info'|'warning', text: string}>}
 */
export function recomputeSentences({ ran, notRun }) {
  const out = [];
  const same = ran.filter(entry => entry.differs.length === 0).map(entry => entry.what);
  if (same.length > 0) out.push({ tone: 'info', text: `Computed again on open (left out of the file): ${same.join(', ')}.` });
  for (const entry of ran.filter(each => each.differs.length > 0)) {
    out.push({ tone: 'warning', text: `${entry.what} was computed again on open, on other inputs than the shared result: ${entry.differs.join(' ')}` });
  }
  for (const entry of notRun) {
    out.push({ tone: 'warning', text: `${entry.what} was left out of the file and not computed again: ${entry.reason} Run it to see its result.` });
  }
  return out;
}
