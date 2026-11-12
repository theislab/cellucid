/**
 * What a Save or a Share chose, written (`assets/js/app/session/share-scope.js`
 * through `history-file.js`), History v2 §3.11, §3.15.3, §6 test 11: each
 * file holds exactly what was chosen, and reads back.
 *
 * - Share: the tracker shown with its main and shown branches; a branch it
 *   forks from comes along to its fork step; the head stays shown.
 * - Notes, conversations and Recently deleted only when chosen; times exact,
 *   rounded to the day, or none; the dataset's source or its name only.
 * - Current state only: one tracker, the dataset as opened and one squashed
 *   step to what is shown, with nothing of who did what when.
 * - Steps only: no values, no cells, recompute.
 * - Results recomputed: every analysis result left out (marked so, with what
 *   it was computed on), its settings kept.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { goldenSession } from '../scripts/generate-history-golden.mjs';
import { SAVE_DEFAULTS, SHARE_DEFAULTS, STATE_DEFAULTS, TIMELESS_CREATED_AT, analysisWithoutResults, shareHistory, withoutCells } from '../assets/js/app/session/share-scope.js';
import { readHistoryFile, valuesAtStep, writeHistoryFile } from '../assets/js/app/session/history-file.js';
import { actionStamps } from '../assets/js/app/session/app-stamp.js';
import { hashValue } from '../assets/js/app/history/value-pool.js';
import { isLeftOutResult } from '../assets/js/app/analysis/shared/analysis-result-session.js';

const NEW_TRACKER = 't-77777777-7777-4777-8777-777777777777';
const NOW = Date.UTC(2026, 10, 4, 15, 30);

/** Share the golden history with `choice`, write it and read it back. */
async function share(choice, { shown = null } = {}) {
  const session = await goldenSession();
  const active = session.trackers.find(tracker => tracker.id === session.activeTracker);
  const snapshot = { dataset: active.dataset, activeTracker: session.activeTracker, trackers: session.trackers };
  const shared = await shareHistory({
    snapshot, shown: shown ?? valuesAtStep(active.steps, active.headId), choice, valueOf: hash => session.values.get(hash),
    catalog: session.catalog, newTrackerId: () => NEW_TRACKER, now: NOW,
  });
  const steps = shared.history.trackers.flatMap(tracker => [
    ...tracker.steps, ...tracker.journal.flatMap(entry => (entry.purged ? [] : [...entry.before.steps, ...entry.after.steps])),
  ]);
  const blob = await writeHistoryFile({
    header: { ...session.header, createdAt: shared.createdAt(session.header.createdAt), source: shared.keepSource ? session.header.source : null },
    app: session.app, actions: await actionStamps(steps, session.catalog), scope: shared.scope, history: shared.history, valueOf: shared.valueOf,
  });
  return { session, shared, read: await readHistoryFile(blob), bytes: blob.size, blob };
}

test('Save keeps the whole history: every tracker, branch, note, Recently deleted; no conversation unless chosen', async () => {
  const { session, read } = await share(SAVE_DEFAULTS);
  assert.deepEqual(read.history.trackers.map(tracker => tracker.id), session.trackers.map(tracker => tracker.id));
  assert.deepEqual(read.history.trackers.map(tracker => tracker.chats), session.trackers.map(() => []));
  // Without conversations, the turns name none either (their conversation and message).
  const unnamed = tracker => ({ ...tracker, turns: tracker.turns.map(turn => ({ ...turn, conversation: null, message: null })) });
  assert.deepEqual(read.history.trackers.map(({ chats, ...tracker }) => tracker), session.trackers.map(({ chats, ...tracker }) => unnamed(tracker)));
  const withChats = await share({ ...SAVE_DEFAULTS, chats: true });
  // The conversations whole, each naming the turns it brings as received (`transcriptForSave`).
  const received = transcript => [...new Set((transcript.messages ?? []).map(message => message.turn).filter(Boolean))];
  assert.deepEqual(withChats.read.history.trackers, session.trackers.map(tracker => ({
    ...tracker, chats: tracker.chats.map(([id, transcript]) => [id, { ...transcript, received: received(transcript) }]),
  })));
});

test('Share holds the tracker shown with its main and shown branches; a branch it forks from ends at its fork step', async () => {
  const { session, read } = await share(SHARE_DEFAULTS);
  const source = session.trackers.find(tracker => tracker.id === session.activeTracker);
  assert.deepEqual(read.history.trackers.map(tracker => tracker.id), [source.id]);
  const [tracker] = read.history.trackers;
  assert.deepEqual(read.manifest.scope.branches, [{ tracker: source.id, branches: [...new Set([source.mainBranch, source.activeBranch])].sort() }]);
  assert.equal(tracker.headId, source.headId);
  assert.ok(tracker.steps.length <= source.steps.length);
  assert.equal(tracker.journal.length, 0);
  assert.equal(read.manifest.scope.journal, false);
  // Every step held is on the path of a branch chosen.
  const byId = new Map(tracker.steps.map(step => [step.id, step]));
  for (const branch of tracker.branches) {
    for (let step = byId.get(branch.tip); step !== undefined; step = byId.get(step.parent)) assert.ok(byId.has(step.id));
  }
  // One branch only: another branch's own steps after its fork are not held.
  const other = source.branches.find(branch => branch.id !== source.mainBranch && branch.id !== source.activeBranch && branch.base !== null);
  const one = await share({ ...SHARE_DEFAULTS, branches: [{ tracker: source.id, branches: [other.id] }] });
  const held = one.read.history.trackers[0];
  assert.deepEqual(held.branches.find(branch => branch.id === other.id), source.branches.find(branch => branch.id === other.id));
  assert.equal(held.activeBranch, other.id);
  assert.ok(held.steps.every(step => step.branch === other.id || held.steps.some(child => child.parent === step.id) || step.id === other.base));
});

test('notes and bookmarks only when chosen; times rounded to the day or none; the dataset by its name only', async () => {
  const { read } = await share({ ...SAVE_DEFAULTS, notes: false, times: 'dates', source: 'name' });
  for (const tracker of read.history.trackers) {
    assert.equal(tracker.notes.length, 0);
    assert.ok(tracker.steps.every(step => step.notes.length === 0 && step.bookmark === null));
    assert.ok(tracker.steps.every(step => step.at === null || step.at % 86_400_000 === 0));
  }
  assert.equal(read.manifest.source, null);
  assert.equal(read.manifest.createdAt, '2026-11-04T00:00:00.000Z');
  const timeless = await share({ ...SAVE_DEFAULTS, times: 'none' });
  assert.equal(timeless.read.manifest.createdAt, TIMELESS_CREATED_AT);
  assert.ok(timeless.read.history.trackers.every(tracker => tracker.createdAt === null && tracker.steps.every(step => step.at === null && step.until === null)));
});

test('without conversations, the turns name none: no conversation, no message; their label and who acted stay (review)', async () => {
  const kept = await share({ ...SAVE_DEFAULTS, chats: true });
  const left = await share(SAVE_DEFAULTS);
  const turns = read => read.history.trackers.flatMap(tracker => tracker.turns);
  assert.ok(turns(kept.read).some(turn => turn.conversation !== null), 'the golden has a turn of a conversation');
  for (const turn of turns(left.read)) assert.deepEqual([turn.conversation, turn.message], [null, null], turn.id);
  assert.deepEqual(turns(left.read).map(turn => [turn.id, turn.label, turn.by]), turns(kept.read).map(turn => [turn.id, turn.label, turn.by]));
});

test('every value a shared step names is in the file, what it read included, whatever the form leaves out (review)', async () => {
  const { stepHashes, everyStep } = await import('../assets/js/app/history/step-records.js');
  const session = await goldenSession();
  const reads = session.trackers.flatMap(everyStep).filter(step => Object.keys(step.reads).some(key => key !== 'history'));
  assert.ok(reads.some(step => Object.hasOwn(step.reads, 'field-overlays') || Object.hasOwn(step.reads, 'analysis')), 'the golden has steps that read');
  for (const choice of [SAVE_DEFAULTS, { ...SAVE_DEFAULTS, results: 'recompute' }, { ...SAVE_DEFAULTS, times: 'none' }, STATE_DEFAULTS]) {
    const { read } = await share(choice);
    for (const tracker of read.history.trackers) {
      for (const step of everyStep(tracker)) {
        for (const hash of stepHashes(step)) assert.ok(read.values.has(hash), `${choice.content} ${choice.results ?? ''} ${choice.times}: ${tracker.id} ${step.id} names ${hash.slice(0, 12)}`);
      }
    }
    // Results left out are in no value, the values steps read included.
    if (choice.results === 'recompute') for (const value of read.values.values()) assert.deepEqual(analysisWithoutResults(value), value);
  }
});

test('Current state only: the dataset as opened and one squashed step to what is shown, nothing of who or when', async () => {
  const { session, read, bytes } = await share(STATE_DEFAULTS);
  assert.equal(read.manifest.scope.content, 'state');
  const [tracker] = read.history.trackers;
  assert.equal(tracker.id, NEW_TRACKER);
  assert.equal(tracker.steps.length, 2);
  const [root, state] = tracker.steps;
  assert.equal(state.kind, 'squashed');
  assert.equal(state.squashed.cause, 'share');
  assert.equal(state.label, 'Shared state');
  assert.equal(tracker.headId, state.id);
  assert.equal(root.by.origin, 'startup');
  assert.equal(state.by.origin, 'user');
  assert.equal(state.at, null);
  // The dataset reference stays (where it opens from): the state is of that dataset.
  assert.deepEqual(read.manifest.source, session.header.source);
  const source = session.trackers.find(candidate => candidate.id === session.activeTracker);
  // What is shown, value for value; the times values hold (a user field's creation) left out, as every time is.
  const shownNow = valuesAtStep(tracker.steps, tracker.headId);
  const shownThen = valuesAtStep(source.steps, source.headId);
  assert.deepEqual(Object.keys(shownNow).sort(), Object.keys(shownThen).sort());
  for (const [domain, hash] of Object.entries(shownThen)) {
    const then = session.values.get(hash);
    const expected = domain === 'field-overlays'
      ? { ...then, userFields: then.userFields.map(item => ({ ...item, createdAt: item.createdAt === null ? null : null })) } : then;
    assert.deepEqual(read.values.get(shownNow[domain]), expected, domain);
  }
  assert.ok(session.values.get(shownThen['field-overlays']).userFields.some(item => item.createdAt !== null), 'the golden has a time to leave out');
  const full = await share(SAVE_DEFAULTS);
  assert.ok(bytes < full.bytes, `the state alone (${bytes} B) is smaller than the history (${full.bytes} B)`);
});

/** Every time a share's JSON says: ISO times and milliseconds since 1970 between 2001 and 2100 (a whole number on its own, not inside a digest). */
async function timesIn(blob) {
  const { readBundle } = await import('../assets/js/app/session/bundle/reader.js');
  const { gzipDecompress } = await import('../assets/js/app/session/codecs/gzip.js');
  const bundle = await readBundle(blob, { signal: null, onProgress: null });
  const texts = [JSON.stringify({ ...bundle.manifest, createdAt: null })];
  let index = 0;
  for await (const { bytes: stored } of bundle.chunkStream) {
    const meta = bundle.manifest.chunks[index++];
    if (meta.kind === 'array') continue;
    texts.push(new TextDecoder().decode(meta.codec === 'gzip' ? await gzipDecompress(stored, { maxOutputBytes: meta.uncompressedBytes, signal: null }) : stored));
  }
  const found = [];
  for (const text of texts) {
    found.push(...(text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/g) ?? []));
    found.push(...(text.match(/(?<![\w.])(9[5-9]\d|[1-3]\d{3}|40\d\d)\d{9}(?![\w.])/g) ?? []).filter(number => Number(number) >= 978307200000));
  }
  return found;
}

test('a share without times holds none, in its records, its values or its conversations (review S1)', async () => {
  for (const choice of [STATE_DEFAULTS, { ...SAVE_DEFAULTS, chats: true, times: 'none' }]) {
    const { read, blob } = await share(choice);
    assert.equal(read.manifest.createdAt, TIMELESS_CREATED_AT);
    assert.deepEqual(await timesIn(blob), [], `${choice.content} with times ${choice.times}`);
  }
  // Rounded to the day: every time that remains is a whole UTC day.
  const { blob } = await share({ ...SAVE_DEFAULTS, chats: true, times: 'dates' });
  for (const found of await timesIn(blob)) {
    if (found.includes('T')) assert.match(found, /T00:00$/, found);
    else assert.equal(Number(found) % 86_400_000, 0, found);
  }
  // Exact: the times are there (the scan sees them).
  assert.ok((await timesIn((await share({ ...SAVE_DEFAULTS, chats: true })).blob)).length > 0);
});

test('Current state only from a paused tab holds what is shown, the paused changes included', async () => {
  const session = await goldenSession();
  const active = session.trackers.find(tracker => tracker.id === session.activeTracker);
  const shown = { ...valuesAtStep(active.steps, active.headId) };
  // A color changed while paused: shown, in no step.
  const other = active.steps.find(step => step.touches.includes('colors') && step.after.colors !== shown.colors);
  shown.colors = other.after.colors;
  const { read } = await share(STATE_DEFAULTS, { shown });
  const [tracker] = read.history.trackers;
  assert.equal(valuesAtStep(tracker.steps, tracker.headId).colors, shown.colors);
});

test('Steps only: no value, no cell, results recomputed; it reads as a replay plan', async () => {
  const { session, read } = await share({ ...SHARE_DEFAULTS, content: 'steps' });
  assert.equal(read.manifest.scope.content, 'steps');
  assert.equal(read.manifest.scope.results, 'recompute');
  assert.equal(read.values.size, 0);
  assert.ok(!read.manifest.chunks.some(chunk => chunk.kind === 'values'));
  let stripped = 0;
  const source = session.trackers.find(tracker => tracker.id === session.activeTracker);
  for (const step of read.history.trackers.flatMap(tracker => tracker.steps)) {
    if (step.params === null || !session.catalog.has(step.type)) continue;
    assert.deepEqual(step.params, withoutCells(step.params, session.catalog.get(step.type).params), `${step.id} names no cells`);
    if (JSON.stringify(step.params) !== JSON.stringify(source.steps.find(other => other.id === step.id).params)) stripped++;
  }
  assert.ok(stripped > 0, 'the golden names cells in some step, and they are gone');
  const schema = { type: 'object', properties: { label: { type: 'string' }, cells: { type: 'array', 'x-cells': true }, values: { type: 'array', 'x-values': true } } };
  assert.deepEqual(withoutCells({ label: 'T', cells: Uint32Array.of(1), values: [1] }, schema), { label: 'T', cells: null, values: null });
});

test('Results recomputed: each analysis result is left out, marked so with what it was computed on, its settings kept, under its own hash', async () => {
  const provenance = { dataset: 'd', cells: { open: 3 } };
  const value = {
    windows: [{ modeId: 'genesPanel', settings: { k: 1 }, result: { kind: 'markers', version: 2, payload: Float32Array.of(1), provenance } }],
    docked: { openMode: 'x', modes: { x: { settings: { a: 1 }, result: { kind: 'x', version: 2, payload: {}, provenance } }, never: { settings: { b: 1 }, result: null } } },
  };
  const left = analysisWithoutResults(value);
  assert.deepEqual(left, {
    windows: [{ modeId: 'genesPanel', settings: { k: 1 }, result: { kind: 'markers', leftOut: true, provenance } }],
    // A result left out is told apart from an analysis that never ran (null stays null).
    docked: { openMode: 'x', modes: { x: { settings: { a: 1 }, result: { kind: 'x', leftOut: true, provenance } }, never: { settings: { b: 1 }, result: null } } },
  });
  assert.ok(isLeftOutResult(left.windows[0].result));
  assert.equal(isLeftOutResult(value.windows[0].result), false);
  assert.equal(isLeftOutResult(null), false);
  // Leaving out what was left out changes nothing.
  assert.deepEqual(analysisWithoutResults(left), left);
  const { session, read } = await share({ ...SAVE_DEFAULTS, results: 'recompute' });
  assert.equal(read.manifest.scope.results, 'recompute');
  for (const tracker of read.history.trackers) {
    for (const step of tracker.steps) {
      if (step.after.analysis === undefined) continue;
      assert.equal(await hashValue(analysisWithoutResults(read.values.get(step.after.analysis))), step.after.analysis);
    }
  }
  assert.equal(read.history.trackers.length, session.trackers.length);
});

test('a choice is checked: what it holds, a tracker or branch it names', async () => {
  await assert.rejects(share({ ...SHARE_DEFAULTS, content: 'pictures' }), /holds one of history, state, steps/);
  await assert.rejects(share({ ...SHARE_DEFAULTS, times: 'hours' }), /Times are one of/);
  await assert.rejects(share({ ...SHARE_DEFAULTS, trackers: ['t-00000000-0000-4000-8000-000000000000'] }), /no tracker/);
  const session = await goldenSession();
  await assert.rejects(share({ ...SHARE_DEFAULTS, branches: [{ tracker: session.activeTracker, branches: ['b99'] }] }), /no branch "b99"/);
});
