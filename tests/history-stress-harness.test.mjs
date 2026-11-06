/**
 * The history stress suite (`tests/stress/`, `scripts/history-stress.mjs`)
 * at a size the contract suite runs in seconds: a mixed history of a few
 * hundred steps with branches and trackers, and every kind of step alone.
 * It keeps the suite runnable as the history changes (H1-H3 re-point it at
 * History v2); the figures themselves are measured by `npm run
 * stress:history` and recorded in `tests/stress/RESULTS.md`, never asserted
 * here: a timing on a shared runner is not a result.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { CONNECTOR_RESULT_CHARACTERS, MIX, STEP_KINDS, runMixedHistory, runStepKinds } from './stress/history-stress.mjs';

test('a mixed history is built, measured at each checkpoint and loads back whole from its session file', async () => {
  const result = await runMixedHistory({
    steps: 240, checkpoints: [120, 240], cells: 5_000, genes: 300, branches: 6, trackers: 3, autosaveEvery: 50,
    sampleSteps: 4, deletes: [3, 10], replaySteps: 10, jumps: 4, correlationCells: 500, markerGroups: 3,
  });
  assert.equal(result.stoppedEarly, null);
  assert.deepEqual(result.checkpoints.map(c => c.target), [120, 240]);
  for (const c of result.checkpoints) {
    assert.ok(c.steps >= c.target, `${c.steps} steps at the ${c.target} checkpoint`);
    assert.equal(c.trackers <= 3, true);
    assert.ok(c.branches >= 2, 'undoing then acting made branches');
    assert.ok(c.recordingAll.recorder.n > 0, 'recording was timed');
    assert.ok(c.historyGetPage.characters > 0 && c.historyGetPage.steps <= c.historyGetPage.total);
    assert.equal(c.historyGetPage.overConnectorLimit, false, 'a page of history.get stays under the connector limit');
    assert.equal(c.historySummary.overConnectorLimit, false);
    assert.ok(c.session.bytes > 0 && c.session.breakdown['steps-eager'].chunks === c.trackers);
    // The file opens into a fresh page with every step of every tracker.
    assert.equal(c.session.loadedSteps, c.stepsSaved);
    assert.equal(c.replay.failed, 0);
    assert.ok(c.autosaveStoreAfterSaveAs.bytes >= c.autosaveStoreBeforeSaveAs.bytes);
  }
  const kinds = new Set(Object.keys(result.checkpoints[1].recordingByKind));
  for (const [kind] of MIX) assert.ok(kinds.has(kind), `the mix reports ${kind}`);
});

test('each kind of step alone adds its bytes to the session file and the autosave', async () => {
  const result = await runStepKinds({ cells: 5_000, genes: 300, defaultCount: 3, markerGroups: 3, correlationCells: 500 });
  assert.deepEqual(Object.keys(result), STEP_KINDS.map(([kind]) => kind));
  for (const [kind, measured] of Object.entries(result)) {
    assert.ok(measured.steps > 0, `${kind} made steps`);
    assert.ok(measured.stepsChunkBytesPerStep > 0, `${kind} adds step records`);
    assert.ok(measured.recording.recorder.n === measured.steps, `${kind} recording was timed`);
  }
  // An analysis result is the largest value a step adds; a camera move among the smallest.
  assert.ok(result.markers.fileBytesPerStep > result.camera.fileBytesPerStep * 10);
});
