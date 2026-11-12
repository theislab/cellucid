/**
 * A `.cellucid-library` file (`assets/js/app/library/library-file.js`): My
 * datasets and the saved states chosen, in one file of the session bundle's
 * framing under its own signature, each history a complete session file
 * (format 4).
 *
 * - Export then import into another browser gives the same datasets and
 *   the same histories (every tracker, step, value, conversation and note),
 *   kept as named saved states "<name> (imported)".
 * - Importing adds beside: a dataset already listed is not replaced, saved
 *   states already kept stay, and importing twice keeps two copies.
 * - Damaged, foreign and truncated files are refused before anything is
 *   added; a session file given to the importer and a library file given to
 *   the session reader are refused naming what they are.
 *
 * The IndexedDB databases are the stand-ins of the autosave tests
 * (`tests/helpers/memory-history-database.mjs`), My datasets' store the
 * page's memory; the real ones run in
 * `tests/browser/my-datasets-library-file.spec.mjs`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  IMPORTED_SUFFIX, LIBRARY_SCOPE, LIBRARY_SIGNATURE, NOT_A_LIBRARY_FILE_MESSAGE, SESSION_FILE_NOT_A_LIBRARY_MESSAGE,
  exportLibrary, importLibrary, readLibraryFile,
} from '../assets/js/app/library/library-file.js';
import { describeExport, describeExportChoice, describeImport } from '../assets/js/app/ui/modules/my-datasets/model.js';
import { createLibrary } from '../assets/js/app/library/my-datasets.js';
import { createHistoryStore } from '../assets/js/app/history/autosave-store.js';
import { createAutosave, keepAsSavedState, listSavedStates, openSavedState } from '../assets/js/app/history/autosave.js';
import { readHistoryFile, writeHistoryFile } from '../assets/js/app/session/history-file.js';
import { readBundle } from '../assets/js/app/session/bundle/reader.js';
import { writeBundle } from '../assets/js/app/session/bundle/writer.js';
import { DAMAGED_FILE, failureDetails, sayFailure } from '../assets/js/utils/errors.js';
import { LIBRARY_FILE_NOT_A_SESSION_MESSAGE } from '../assets/js/app/session/bundle/format.js';
import { getActionCatalog } from '../assets/js/app/actions/index.js';
import { actionStamps } from '../assets/js/app/session/app-stamp.js';
import { APP, HEADER, recordsHistory } from './helpers/history-records.mjs';
import { manualSchedule, memoryDatabase, sharedLocks } from './helpers/memory-history-database.mjs';

const VERSION = '0.9.7';

function clock(start = 1_700_000_000_000) {
  let t = start;
  return () => (t += 1000);
}

/** My datasets' facts of the demo dataset (`shownDatasetFacts`). */
function demoFacts(name = 'Demo') {
  return {
    id: 'demo', name, source: { kind: 'sample', dataset: 'demo' }, link: null,
    storage: { format: 'zarr', zarrVersion: 3, layout: 'folder', remote: true, name: 'demo.zarr', host: 'example.org', bytes: 12_345 },
    cells: 1000, genes: 5, openCells: { cells: 1000, of: 1000, spec: null, fitted: false },
  };
}

/**
 * A browser: its saved states (a database), My datasets, and a history
 * autosaved there as `edit` changes it.
 */
async function browser({ history = null, edit = async () => {}, facts = demoFacts() } = {}) {
  const database = memoryDatabase();
  const store = createHistoryStore(database);
  const library = createLibrary({ now: clock() });
  if (facts !== null) await library.record(facts, { counted: true });
  let live = null;
  if (history !== null) {
    live = history;
    const writes = manualSchedule();
    const autosave = createAutosave({
      history: live, dataset: { id: 'demo', name: 'Demo' }, store, header: async () => HEADER, schedule: writes.schedule, now: clock(), locks: sharedLocks(),
    });
    await writes.run();
    await edit(live);
    await writes.run();
    return { database, store, library, history: live, autosave, writes };
  }
  return { database, store, library, history: live };
}

/** Steps, a conversation and a note. */
async function richEdits(history) {
  await history.step({ colors: { by: 'cell_type' } });
  await history.step({ filters: { cells: new Uint32Array([1, 2, 3, 500]) } });
  history.chat('c1', [{ role: 'user', text: 'Private question' }, { role: 'assistant', parts: [{ type: 'text', text: 'An answer' }] }]);
  history.note('Why this dataset');
}

/** A history of two trackers, given steps, a conversation and a note. */
async function rich() {
  return { history: await recordsHistory({ trackers: 2 }), edit: richEdits };
}

/** What a saved state holds, read whole. */
async function readBack(store, id) {
  const source = await openSavedState(id, store);
  const eager = await source.readEager();
  const rest = await source.readRest();
  return { header: source.header, entry: source.entry, history: eager.history, values: new Map([...eager.values, ...rest.values]) };
}

async function refusal(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('It was accepted.');
}

test('export then import into another browser gives the same datasets and histories, kept as named saved states beside', async () => {
  const from = await browser(await rich());
  const [source] = await listSavedStates(from.store);
  const exported = await exportLibrary({ library: from.library, store: from.store, version: VERSION, now: () => Date.UTC(2026, 10, 4) });
  assert.equal(exported.datasets, 1);
  assert.equal(exported.histories, 1);
  assert.equal(exported.paused, 0);

  // The file: the library signature, its manifest, one complete session file per history, stored as it is.
  const { manifest, sessions } = await readLibraryFile(exported.blob);
  assert.deepEqual(Object.keys(manifest), ['createdAt', 'app', 'datasets', 'histories', 'chunks']);
  assert.equal(manifest.createdAt, '2026-11-04T00:00:00.000Z');
  assert.deepEqual(manifest.app, { version: VERSION });
  assert.deepEqual(manifest.datasets, await from.library.list());
  assert.deepEqual(manifest.histories, [{
    chunk: 'history/0', name: null, kind: 'autosave', dataset: { id: 'demo', name: 'Demo' }, createdAt: source.createdAt, updatedAt: source.updatedAt,
  }]);
  assert.deepEqual(manifest.chunks, [{ id: 'history/0', kind: 'session', codec: 'none', storedBytes: sessions[0].size }]);
  const session = await readHistoryFile(sessions[0]);
  assert.deepEqual({ ...session.manifest.scope, trackers: undefined, branches: undefined }, { ...LIBRARY_SCOPE, trackers: undefined, branches: undefined });
  assert.equal(session.manifest.app.version, VERSION);
  assert.equal(session.history.trackers[0].chats.length, 1, 'conversations are kept');

  const to = await browser({ facts: null });
  const report = await importLibrary(exported.blob, { library: to.library, store: to.store });
  assert.deepEqual(report, {
    datasets: { added: ['Demo'], present: [] },
    histories: { added: [{ id: report.histories.added[0].id, name: `Autosave of Demo${IMPORTED_SUFFIX}` }] },
  });
  assert.equal(describeImport(report), 'Added 1 dataset and 1 saved state.');
  assert.deepEqual(await to.library.list(), await from.library.list());
  const [kept] = await listSavedStates(to.store);
  assert.equal(kept.kind, 'named');
  assert.equal(kept.name, 'Autosave of Demo (imported)');
  assert.deepEqual(kept.dataset, { id: 'demo', name: 'Demo' });
  assert.equal(kept.createdAt, source.createdAt);
  assert.equal(kept.updatedAt, source.updatedAt);
  assert.equal(kept.steps, source.steps);
  assert.equal(kept.chats, 1);

  const before = await readBack(from.store, source.id);
  const after = await readBack(to.store, kept.id);
  assert.deepEqual(after.history, before.history);
  assert.deepEqual(after.values, before.values);
  assert.deepEqual(after.header, HEADER);
});

test('an import adds everything or nothing: no room for the histories, or a dataset that cannot be listed, adds nothing (review S4)', async () => {
  const from = await browser(await rich());
  await keepAsSavedState({
    history: from.history.snapshot(), valueOf: hash => from.history.pool.get(hash), header: HEADER,
    dataset: { id: 'demo', name: 'Demo' }, name: 'Figure 2', createdAt: 1, updatedAt: 1,
  }, from.store);
  const exported = await exportLibrary({ library: from.library, store: from.store, version: VERSION });
  assert.equal(exported.histories, 2);
  // No room: the histories go in one transaction, so neither is kept, and no dataset is listed.
  const full = await browser({ facts: null });
  full.database.failPuts('QuotaExceededError');
  await assert.rejects(importLibrary(exported.blob, { library: full.library, store: full.store }), /no room left/);
  full.database.failPuts(null);
  assert.deepEqual(await listSavedStates(full.store), []);
  assert.deepEqual(await full.library.list(), []);
  // The datasets cannot be listed: the histories kept for them are removed again.
  const refusing = await browser({ facts: null });
  const library = { ...refusing.library, add: async () => { throw new Error('The list of datasets could not be written.'); } };
  await assert.rejects(importLibrary(exported.blob, { library, store: refusing.store }), /could not be written/);
  assert.deepEqual(await listSavedStates(refusing.store), []);
  for (const name of ['values', 'parts', 'arrays', 'steps', 'trackers']) assert.equal(refusing.database.stores.get(name).size, 0, `no ${name} left`);
});

test('a saved state of the steps only stores no value, and a library file keeps what each saved state holds (review)', async () => {
  const from = await browser({ facts: demoFacts() });
  const live = await recordsHistory();
  await live.step({ colors: { by: 'cell_type' } });
  await keepAsSavedState({
    history: live.snapshot(), valueOf: hash => live.pool.get(hash), content: 'steps', header: HEADER,
    dataset: { id: 'demo', name: 'Demo' }, name: 'Plan', createdAt: 1, updatedAt: 1,
  }, from.store);
  assert.equal(from.database.stores.get('values').size, 0, 'no value is kept for a plan of steps');
  const exported = await exportLibrary({ library: from.library, store: from.store, version: VERSION });
  const { sessions } = await readLibraryFile(exported.blob);
  const session = await readHistoryFile(sessions[0]);
  assert.equal(session.manifest.scope.content, 'steps');
  assert.equal(session.manifest.scope.results, 'recompute');
  assert.equal(session.manifest.chunks.filter(chunk => chunk.kind === 'values').length, 0);
});

test('importing adds beside: a dataset listed is not replaced, saved states kept stay, and twice keeps two copies', async () => {
  const from = await browser(await rich());
  await keepAsSavedState({
    history: from.history.snapshot(), valueOf: hash => from.history.pool.get(hash), header: HEADER,
    dataset: { id: 'demo', name: 'Demo' }, name: 'Figure 2', createdAt: 1, updatedAt: 1,
  }, from.store);
  const exported = await exportLibrary({ library: from.library, store: from.store, version: VERSION });
  assert.equal(exported.histories, 2);

  // The other browser lists the same dataset under another name, and has a saved state of its own.
  const to = await browser({ facts: demoFacts('My demo') });
  const mine = await recordsHistory();
  await mine.step({ colors: { by: 'louvain' } });
  await keepAsSavedState({
    history: mine.snapshot(), valueOf: hash => mine.pool.get(hash),
    header: HEADER, dataset: { id: 'demo', name: 'My demo' }, name: 'Mine', createdAt: 1, updatedAt: 2,
  }, to.store);
  const ownStates = await listSavedStates(to.store);
  assert.equal(ownStates.length, 1);

  const first = await importLibrary(exported.blob, { library: to.library, store: to.store });
  assert.deepEqual(first.datasets, { added: [], present: ['Demo'] });
  assert.deepEqual(first.histories.added.map(entry => entry.name).sort(), ['Autosave of Demo (imported)', 'Figure 2 (imported)']);
  assert.equal(describeImport(first), 'Added 2 saved states; 1 dataset was already in My datasets.');
  assert.deepEqual((await to.library.list()).map(record => record.name), ['My demo'], 'the dataset listed is not replaced');

  const second = await importLibrary(exported.blob, { library: to.library, store: to.store });
  assert.equal(second.histories.added.length, 2);
  const states = await listSavedStates(to.store);
  assert.equal(states.length, ownStates.length + 4);
  for (const mine of ownStates) assert.ok(states.some(state => state.id === mine.id && state.name === mine.name), 'what was kept stays');
  assert.deepEqual(
    states.filter(state => state.name?.endsWith(IMPORTED_SUFFIX)).map(state => state.name).sort(),
    ['Autosave of Demo (imported)', 'Autosave of Demo (imported)', 'Figure 2 (imported)', 'Figure 2 (imported)'],
  );
  assert.equal(new Set(states.map(state => state.id)).size, states.length);
});

test('the datasets and saved states chosen are what the file holds; a paused draft is left out and counted', async () => {
  const { history, edit } = await rich();
  const from = await browser({ history, edit });
  await from.library.record({ ...demoFacts('Other'), id: 'other', source: { kind: 'sample', dataset: 'other' } }, { counted: true });
  const [autosaved] = await listSavedStates(from.store);

  const none = await exportLibrary({ datasets: ['other'], library: from.library, store: from.store, version: VERSION });
  assert.deepEqual([none.datasets, none.histories], [1, 0], 'the saved states of the datasets chosen, by default');
  const onlyHistory = await exportLibrary({ datasets: [], savedStates: [autosaved.id], library: from.library, store: from.store, version: VERSION });
  assert.deepEqual([onlyHistory.datasets, onlyHistory.histories], [0, 1]);
  await assert.rejects(exportLibrary({ datasets: ['gone'], library: from.library, store: from.store, version: VERSION }), /no longer in My datasets/);
  await assert.rejects(exportLibrary({ savedStates: ['gone'], library: from.library, store: from.store, version: VERSION }), /no longer kept/);

  await history.pause({ colors: { by: 'louvain' } });
  await from.writes.run();
  const paused = await exportLibrary({ library: from.library, store: from.store, version: VERSION });
  assert.equal(paused.paused, 1);
  const to = await browser({ facts: null });
  const report = await importLibrary(paused.blob, { library: to.library, store: to.store });
  const after = await readBack(to.store, report.histories.added[0].id);
  assert.equal(after.history.trackers.some(tracker => tracker.paused?.draft != null), false);
});

test('a session file is refused by the importer, a library file by the session reader, each naming what it is', async () => {
  const history = await recordsHistory();
  await history.step({ colors: { by: 'cell_type' } });
  const snapshot = history.snapshot();
  const session = await writeHistoryFile({
    header: HEADER, app: APP, actions: await actionStamps(snapshot.trackers.flatMap(tracker => tracker.steps), getActionCatalog()), scope: {
      trackers: snapshot.trackers.map(tracker => tracker.id),
      branches: snapshot.trackers.map(tracker => ({ tracker: tracker.id, branches: tracker.branches.map(branch => branch.id) })),
      ...LIBRARY_SCOPE,
    },
    history: snapshot, valueOf: hash => history.pool.get(hash),
  });
  const to = await browser({ facts: null });
  assert.equal((await refusal(importLibrary(session, { library: to.library, store: to.store }))).message, SESSION_FILE_NOT_A_LIBRARY_MESSAGE);

  const from = await browser(await rich());
  const { blob } = await exportLibrary({ library: from.library, store: from.store, version: VERSION });
  assert.equal((await refusal(readHistoryFile(blob))).message, LIBRARY_FILE_NOT_A_SESSION_MESSAGE);
  assert.match(LIBRARY_FILE_NOT_A_SESSION_MESSAGE, /Session › Open data › My datasets › All… › Import…/);
  assert.match(SESSION_FILE_NOT_A_LIBRARY_MESSAGE, /State › Session › Load… › Open a session file…$/);
  assert.deepEqual(await to.library.list(), []);
  assert.deepEqual(await listSavedStates(to.store), []);
});

test('damaged, foreign and truncated files are refused before anything is added', async () => {
  const from = await browser(await rich());
  const { blob } = await exportLibrary({ library: from.library, store: from.store, version: VERSION });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const to = await browser({ facts: null });
  const nothingAdded = async () => {
    assert.deepEqual(await to.library.list(), []);
    assert.deepEqual(await listSavedStates(to.store), []);
  };
  const tryImport = async file => (await refusal(importLibrary(file, { library: to.library, store: to.store }))).message;
  // A damaged file is said so, its technical words under Details (F141); a foreign one says what it is.
  const said = async file => {
    const error = await refusal(importLibrary(file, { library: to.library, store: to.store }));
    return { sentence: sayFailure(error), details: failureDetails(error).details ?? null };
  };

  // Foreign: not a library file at all, or too short to be one.
  for (const text of ['', 'CELLUCID', 'PNG image bytes long enough to hold a signature']) {
    assert.equal(await tryImport(new Blob([text])), NOT_A_LIBRARY_FILE_MESSAGE, text);
  }
  assert.match(await tryImport(new Blob(['CELLUCID_LIBRARY/2\n{}'])), /newer version of Cellucid \(library format 2\)/);

  // Truncated: the last chunk ends early.
  assert.match(await tryImport(new Blob([bytes.slice(0, bytes.length - 100)])), /truncated|end of file/i);
  // Trailing bytes.
  assert.match(await tryImport(new Blob([bytes, new Uint8Array([1, 2, 3])])), /trailing bytes/);
  for (const damagedFile of [new Blob([bytes.slice(0, bytes.length - 100)]), new Blob([bytes, new Uint8Array([1, 2, 3])])]) {
    const { sentence, details } = await said(damagedFile);
    assert.equal(sentence, DAMAGED_FILE);
    assert.match(details, /truncated|end of file|trailing bytes/i);
  }
  assert.deepEqual(await said(new Blob(['CELLUCID'])), { sentence: NOT_A_LIBRARY_FILE_MESSAGE, details: null });

  // Damaged: one byte of the history's session file changed (its last chunk's bytes).
  const flipped = bytes.slice();
  flipped[flipped.length - 20] ^= 0xff;
  assert.match(await tryImport(new Blob([flipped])), /This library file is damaged: its history "Autosave of Demo" is not a session file this version reads/);

  // Damaged manifests: written in the framing, refused by their check.
  const { manifest, sessions } = await readLibraryFile(blob);
  const chunks = await Promise.all(sessions.map(async session => new Uint8Array(await session.arrayBuffer())));
  const forged = changed => writeBundle({ manifest: { ...manifest, ...changed }, chunks, signature: LIBRARY_SIGNATURE });
  assert.match(await tryImport(forged({ datasets: [{ ...manifest.datasets[0], source: { kind: 'nowhere' } }] })), /dataset 1 is not a My datasets record/);
  assert.match(await tryImport(forged({ datasets: [manifest.datasets[0], manifest.datasets[0]] })), /listed twice/);
  assert.match(await tryImport(forged({ histories: [{ ...manifest.histories[0], kind: 'other' }] })), /kind must be autosave or named/);
  assert.match(await tryImport(forged({ histories: [] })), /one history per chunk/);
  assert.match(await tryImport(forged({ app: { version: VERSION, extra: true } })), /app must be exactly/);
  assert.match(await tryImport(forged({ extra: 1 })), /manifest must be exactly/);
  assert.match(await tryImport(writeBundle({
    manifest: { ...manifest, chunks: [{ ...manifest.chunks[0], codec: 'gzip' }] }, chunks, signature: LIBRARY_SIGNATURE,
  })), /chunk 1 must be exactly/);
  // A session file chunk that is not one.
  const notSession = new TextEncoder().encode('not a session file');
  assert.match(await tryImport(writeBundle({
    manifest: { ...manifest, chunks: [{ ...manifest.chunks[0], storedBytes: notSession.byteLength }] }, chunks: [notSession], signature: LIBRARY_SIGNATURE,
  })), /is not a session file this version reads\.$/);
  const { sentence, details } = await said(writeBundle({
    manifest: { ...manifest, chunks: [{ ...manifest.chunks[0], storedBytes: notSession.byteLength }] }, chunks: [notSession], signature: LIBRARY_SIGNATURE,
  }));
  assert.equal(sentence, DAMAGED_FILE);
  assert.match(details, /is not a session file this version reads.*This file is not a Cellucid session file/);
  await nothingAdded();
});

test('the framing is one: the session signature is the default, the library one is passed', async () => {
  const manifest = { chunks: [] };
  const library = writeBundle({ manifest, chunks: [], signature: LIBRARY_SIGNATURE });
  const session = writeBundle({ manifest, chunks: [] });
  assert.equal(new TextDecoder().decode(new Uint8Array(await library.slice(0, 19).arrayBuffer())), 'CELLUCID_LIBRARY/1\n');
  assert.equal(new TextDecoder().decode(new Uint8Array(await session.slice(0, 19).arrayBuffer())), 'CELLUCID_SESSION/4\n');
  assert.deepEqual((await readBundle(library, { signal: null, onProgress: null, signature: LIBRARY_SIGNATURE })).manifest, manifest);
  assert.equal((await refusal(readBundle(library, { signal: null, onProgress: null }))).message, LIBRARY_FILE_NOT_A_SESSION_MESSAGE);
  assert.equal(
    (await refusal(readBundle(session, { signal: null, onProgress: null, signature: LIBRARY_SIGNATURE }))).message,
    SESSION_FILE_NOT_A_LIBRARY_MESSAGE,
  );
});

test('the export and the import say what they chose, wrote and added', () => {
  assert.equal(describeExportChoice({ datasets: 0, states: [] }), 'Nothing is ticked.');
  assert.equal(describeExportChoice({ datasets: 2, states: [] }), '2 datasets and 0 saved states.');
  assert.match(describeExportChoice({ datasets: 1, states: [{ bytes: 2048 }, { bytes: 2048, paused: true }] }),
    /^1 dataset and 2 saved states \(4(\.0)? KB kept here\)\. Changes made while recording was paused, not yet a step, are not exported\.$/);
  assert.equal(describeExport({ datasets: 1, histories: 2, paused: 0 }), 'Exported 1 dataset and 2 saved states.');
  assert.equal(describeExport({ datasets: 1, histories: 2, paused: 1 }),
    'Exported 1 dataset and 2 saved states. Changes made while recording was paused (1 saved state) were left out.');
  assert.equal(describeImport({ datasets: { added: [], present: [] }, histories: { added: [] } }), 'Nothing was added.');
  assert.equal(describeImport({
    datasets: { added: ['A', 'B'], present: ['C'] }, histories: { added: [{ id: 'x', name: 'n' }] },
  }), 'Added 2 datasets and 1 saved state; 1 dataset was already in My datasets.');
});
