/**
 * Verify must not say a colleague's Figure 2 branch is "not reproduced:
 * Analysis differential: result changed" at the step that ran the test when
 * running it again gives every number the same. The result records its run's
 * wall-clock time (`summary.duration`, which differs between the sender's
 * browser and the replay), so the analysis domain has a canonical form:
 * without one Verify compares it. The analyses' canonical form
 * leaves out what a result records about its run (its duration, whether it
 * came from the cache), never what it found.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createActionCatalog, defineAction } from '../assets/js/app/actions/catalog.js';
import { createActionDispatcher } from '../assets/js/app/actions/dispatcher.js';
import { createDomainRegistry } from '../assets/js/app/actions/domains.js';
import { historyActions } from '../assets/js/app/actions/definitions/history.js';
import { createHistory } from '../assets/js/app/history/history.js';
import { hashValue } from '../assets/js/app/history/value-pool.js';
import { createResultEnvelope } from '../assets/js/app/analysis/shared/analysis-result-session.js';
import { RUN_RECORD_KEYS, canonicalAnalyses, createAnalysisDomain } from '../assets/js/app/state/domains/analysis.js';
import { NONE } from './history-fake-page.mjs';

/** The analyses with a differential result docked, as the real domain captures them. */
function analyses({ duration, pAdjusted = 3e-81, cached = false }) {
  return {
    windows: [],
    docked: {
      openMode: 'differential',
      modes: {
        differential: {
          settings: { field: 'cell_type', a: 'Alpha', b: 'Beta' },
          result: createResultEnvelope('differential', {
            results: [{ gene: 'Arx', pAdjusted, log2FoldChange: 3.24 }, { gene: 'Pdx1', pAdjusted: 1.3e-131, log2FoldChange: -3.63 }],
            summary: { genesTested: 16, groupASize: 481, groupBSize: 591, duration },
            stats: { durationMs: Math.round(duration), cached, genes: ['Arx', 'Pdx1'] },
          }),
        },
      },
    },
  };
}

test('two runs of one analysis differ only in their run records: one canonical form', async () => {
  const sender = canonicalAnalyses(analyses({ duration: 627.2 }));
  const replay = canonicalAnalyses(analyses({ duration: 81.5, cached: true }));
  assert.equal(await hashValue(sender), await hashValue(replay));
  // What a result found is never left out.
  assert.notEqual(await hashValue(sender), await hashValue(canonicalAnalyses(analyses({ duration: 627.2, pAdjusted: 4e-81 }))));
  assert.deepEqual(RUN_RECORD_KEYS, ['duration', 'durationMs', 'cached', 'computedAt', 'computeDuration', 'tuning']);
  // The page's own analysis domain compares by it.
  assert.equal(createAnalysisDomain({ analysis: () => null, analysisArrived: async () => null }).canonical, canonicalAnalyses);
  // The value itself keeps them (a restore shows the run as it was).
  assert.equal(JSON.stringify(analyses({ duration: 627.2 })).includes('627.2'), true);
});

test('Verify reproduces a branch whose analysis ran again in another time; a different finding is not reproduced', async () => {
  const state = { analyses: { windows: [], docked: null }, finding: 3e-81, clock: 600 };
  const domains = createDomainRegistry();
  domains.provide('analysis', {
    capture: () => state.analyses,
    restore: value => { state.analyses = value; },
    canonical: canonicalAnalyses,
    describe: () => ['Analysis differential: result changed'],
  });
  for (const id of domains.missing()) domains.provide(id, { capture: () => null, restore: () => {} });
  const run = defineAction({ type: 'de.run', title: 'Run', summary: 'x', group: 'T', params: NONE, touches: ['analysis'], reads: [], effect: 'state', describe: () => 'Ran Differential expression', code: () => 'run()' });
  const dispatcher = createActionDispatcher({ catalog: createActionCatalog([run, ...historyActions]) });
  // Each run takes another time, as on a real page.
  dispatcher.provide('de.run', () => { state.clock = state.clock / 7; state.analyses = analyses({ duration: state.clock, pAdjusted: state.finding }); });
  let n = 0;
  const history = createHistory({
    dispatcher, domains, dataset: { id: 'd', name: 'D', cellOrder: null },
    newTrackerId: () => `t-00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  });
  await history.startTracker();
  await dispatcher.dispatch('de.run', {});
  const verified = (await dispatcher.dispatch('history.verify', { branch: history.active.activeBranch })).outcome;
  assert.equal(verified.reproduced, true, JSON.stringify(verified.domains));
  // The data changed under it: the finding differs, and Verify says so.
  state.finding = 5e-60;
  const changed = (await dispatcher.dispatch('history.verify', { branch: history.active.activeBranch })).outcome;
  assert.equal(changed.reproduced, false);
  assert.deepEqual(changed.domains.map(domain => domain.domain), ['analysis']);
});

test('a marker genes result run again elsewhere is the same finding: its time, duration and read tuning are run records', async () => {
  // As `marker-discovery-engine.js` and `genes-panel-controller.js` record them (Kanemaru, live).
  const markers = (computedAt, computeDuration, tuning, durationMs, cached, p) => ({
    windows: [],
    docked: { openMode: 'genesPanel', modes: { genesPanel: { settings: {}, result: { payload: {
      $: 'object', keys: ['stats', 'metadata'], values: [
        { $: 'object', keys: ['genes', 'computedAt', 'computeDuration', 'pValuesByGroup'], values: [['FOLR2'], computedAt, computeDuration, [p]] },
        { $: 'object', keys: ['cached', 'durationMs', 'tuning'], values: [cached, durationMs, tuning] },
      ],
    } } } } },
  });
  const sender = canonicalAnalyses(markers(1794409105513, 1690, { $: 'object', keys: ['poolSize'], values: [4] }, 1712, false, 1e-30));
  const replay = canonicalAnalyses(markers(1794409125139, 885.6, null, 4, true, 1e-30));
  assert.equal(await hashValue(sender), await hashValue(replay));
  assert.notEqual(await hashValue(sender), await hashValue(canonicalAnalyses(markers(1794409105513, 1690, null, 1712, false, 2e-30))));
});
