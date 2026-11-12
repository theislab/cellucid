/**
 * The analysis results a shared session left out, computed again once it is
 * open (`app/session/recompute-results.js`, History v2 §3.15.4):
 *
 * - only results left out are found, in windows (by number) and in the
 *   docked panel; an analysis that never ran is not;
 * - each is run again through `analysis.run` (origin `session`), and where
 *   the result computed here was computed on other inputs than the shared
 *   one, the person is told why (`staleReasons`);
 * - a refused run is said, and the others still run.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { leftOutResultsOf, recomputeLeftOutResults, recomputeSentences } from '../assets/js/app/session/recompute-results.js';
import { leftOutResultOf } from '../assets/js/app/analysis/shared/analysis-result-session.js';

function provenance(open) {
  return {
    dataset: 'd1', cells: { digest: `cells-${open}`, method: null, of: 60, open, seed: null }, genesReadFor: null,
    mapping: null, values: 'raw', pages: [], visible: null, options: { groupBy: 'cell_type' },
  };
}

const result = open => ({ kind: 'markers', version: 2, payload: { stats: [] }, provenance: provenance(open) });

test('only results left out are found, where analysis.run names them', () => {
  const value = {
    windows: [
      { modeId: 'differential', headerTitle: 'DE', settings: {}, result: null },
      { modeId: 'genesPanel', headerTitle: 'Markers', settings: {}, result: leftOutResultOf(result(30)) },
    ],
    docked: { openMode: 'genesPanel', modes: { genesPanel: { settings: {}, result: leftOutResultOf(result(30)) }, dotplot: { settings: {}, result: result(30) } } },
  };
  assert.deepEqual(leftOutResultsOf(value).map(({ modeId, analysis, title, in: where }) => ({ modeId, analysis, title, where })), [
    { modeId: 'genesPanel', analysis: 'markers', title: 'Marker genes', where: 2 },
    { modeId: 'genesPanel', analysis: 'markers', title: 'Marker genes', where: 'panel' },
  ]);
  assert.deepEqual(leftOutResultsOf({ windows: [], docked: null }), []);
  assert.deepEqual(leftOutResultsOf(null), []);
});

test('each is run again as a step of analysis.run; other inputs and refusals are said', async () => {
  const values = new Map([
    ['s3', { windows: [{ modeId: 'differential', headerTitle: 'DE', settings: {}, result: leftOutResultOf({ ...result(30), kind: 'differential' }) }],
      docked: { openMode: 'genesPanel', modes: { genesPanel: { settings: {}, result: leftOutResultOf(result(30)) } } } }],
    // The panel's run: computed on 60 open cells where the shared one had 30.
    ['s4', { windows: [], docked: { openMode: 'genesPanel', modes: { genesPanel: { settings: {}, result: result(60) } } } }],
  ]);
  const history = { active: { headId: 's3' }, valueAt: (step, domain) => (assert.equal(domain, 'analysis'), values.get(step)) };
  const dispatched = [];
  const dispatcher = {
    async dispatch(type, params, meta) {
      dispatched.push({ type, params, origin: meta.origin });
      if (params.in === 1) throw new Error('Analysis window 1 is folded or hidden, so Differential expression cannot draw.');
      return { outcome: { rows: 3 }, step: { id: 's4' } };
    },
  };
  const outcome = await recomputeLeftOutResults({ history, dispatcher });
  assert.deepEqual(dispatched, [
    { type: 'analysis.run', params: { analysis: 'differential', in: 1 }, origin: 'session' },
    { type: 'analysis.run', params: { analysis: 'markers', in: 'panel' }, origin: 'session' },
  ]);
  assert.deepEqual(outcome, {
    ran: [{ what: 'Marker genes', differs: ['The open cells changed since this result (30 cells then, 60 cells now).'] }],
    notRun: [{ what: 'Differential expression (window 1)', reason: 'Analysis window 1 is folded or hidden, so Differential expression cannot draw.' }],
  });
  assert.deepEqual(recomputeSentences(outcome), [
    { tone: 'warning', text: 'Marker genes was computed again on open, on other inputs than the shared result: The open cells changed since this result (30 cells then, 60 cells now).' },
    { tone: 'warning', text: 'Differential expression (window 1) was left out of the file and not computed again: Analysis window 1 is folded or hidden, so Differential expression cannot draw. Run it to see its result.' },
  ]);
  assert.deepEqual(recomputeSentences({ ran: [{ what: 'Marker genes', differs: [] }], notRun: [] }), [
    { tone: 'info', text: 'Computed again on open (left out of the file): Marker genes.' },
  ]);
  // Nothing left out: nothing runs, nothing is said.
  assert.deepEqual(await recomputeLeftOutResults({ history: { active: { headId: 's4' }, valueAt: () => values.get('s4') }, dispatcher }), { ran: [], notRun: [] });
  assert.deepEqual(recomputeSentences({ ran: [], notRun: [] }), []);
});
