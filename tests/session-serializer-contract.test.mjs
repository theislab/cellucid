/**
 * The page's session files (`assets/js/app/session/session-serializer.js`,
 * format 4): Save writes the open dataset's history with its dataset part
 * taken once, under its settlement and with the open cells in use, refusing
 * a dataset replaced meanwhile; Load verifies before anything is put back,
 * holds its settlement, is cancelled and superseded silently, releases the
 * file it was reading on every failure, and says a failure once; a session
 * using fields the dataset lacks is refused naming them; a dataset's
 * starting view is put back without a step before its first tracker starts,
 * on any subsample of its dataset.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createActionCatalog } from '../assets/js/app/actions/catalog.js';
import { createActionDispatcher } from '../assets/js/app/actions/dispatcher.js';
import { createDomainRegistry } from '../assets/js/app/actions/domains.js';
import { createHistory } from '../assets/js/app/history/history.js';
import { assertNewNotificationOptions, getNotificationCenter } from '../assets/js/app/notification-center.js';
import { SessionSerializer, describeUnrestored } from '../assets/js/app/session/session-serializer.js';
import { CELL_TOTALS_DOING } from '../assets/js/app/state/managers/expression-values.js';
import { SAVE_DEFAULTS, STATE_DEFAULTS } from '../assets/js/app/session/share-scope.js';
import { openHistoryFile, readHistoryFileManifest } from '../assets/js/app/session/history-file.js';
import { trimToPublishedDefault } from '../assets/js/app/session/published-default.js';
import { initSessionControls } from '../assets/js/app/ui/modules/session-controls.js';
import { createCellIdentity } from '../assets/js/data/cell-identity.js';
import { holdPendingCategoryState } from '../assets/js/app/state/managers/field/pending-categories.js';
import { cancellationKind } from '../assets/js/utils/abort.js';
import { isReported } from '../assets/js/utils/errors.js';
import {
  IDENTITY_ORDER, SELECTED_ROWS, SESSION_TEST_VERSION, emptyPages, keyedMapping, makeDataSourceManager, makeDatasetState, makeSerializer,
  selectionPages, sessionOf, withNotificationHarness,
} from './helpers/session-dataset.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const turn = () => new Promise(resolve => setImmediate(resolve));

function selection(state) {
  return state.highlightPages.flatMap(page => page.highlightedGroups.map(group => [...group.cellIndices]));
}

/** The session-file progress entries and toasts, with Cancel on a progress entry. */
async function withNotificationRecorder(run) {
  const notifications = getNotificationCenter();
  const names = ['startDownload', 'updateDownload', 'phaseDownload', 'completeDownload', 'failDownload', 'dismissDownload', 'error', 'success', 'info', 'warning', 'show', 'loading', 'dismiss'];
  const originals = new Map(names.map(name => [name, notifications[name]]));
  const events = [];
  const cancels = new Map();
  let ids = 0;
  notifications.startDownload = (label, total, { onCancel }) => {
    const id = `download-${++ids}`;
    cancels.set(id, onCancel);
    events.push({ id, kind: 'start', label });
    return id;
  };
  notifications.updateDownload = () => {};
  notifications.phaseDownload = (id, doing) => events.push({ id, kind: 'phase', doing });
  notifications.completeDownload = (id, message) => events.push({ id, kind: 'complete', message });
  notifications.failDownload = (id, message) => events.push({ id, kind: 'fail', message });
  notifications.dismissDownload = id => events.push({ id, kind: 'dismiss' });
  notifications.error = message => events.push({ kind: 'ui-error', message });
  notifications.success = message => events.push({ kind: 'ui-success', message });
  notifications.info = message => {
    events.push({ kind: 'ui-info', message });
    return 'n';
  };
  notifications.show = options => {
    // Refused as the real center refuses a new notice (a second load notice once carried `announce`).
    assertNewNotificationOptions(options);
    events.push({ kind: 'ui-show', options });
    return 'n';
  };
  for (const name of ['warning', 'loading', 'dismiss']) notifications[name] = () => 'n';
  try {
    return await run(events, { cancel: id => cancels.get(id)() });
  } finally {
    for (const [name, original] of originals) notifications[name] = original;
  }
}

/** Tracker ids unique across the test's pages, as the app's random ones are. */
let trackerIds = 0;
const nextTrackerId = () => `t-00000000-0000-4000-8000-${String(++trackerIds).padStart(12, '0')}`;

/** A serializer whose history holds one more domain, `colors`, whose restore `onRestore` decides. */
function serializerWithColors(state, onRestore) {
  const base = makeSerializer(state);
  const domains = createDomainRegistry();
  let colors = 'red';
  domains.provide('colors', {
    capture: () => colors,
    restore: async (value, { signal, heavy }) => { await onRestore(value, signal, heavy); colors = value; },
  });
  domains.provide('highlights', { capture: () => ({ pages: state.highlightPages.length }), restore: () => {} });
  for (const id of domains.missing()) domains.provide(id, { capture: () => null, restore: () => {} });
  const dispatcher = createActionDispatcher({ catalog: createActionCatalog([]) });
  const history = createHistory({
    dispatcher, domains, dataset: { id: 'pancreas', name: null, cellOrder: null }, newTrackerId: nextTrackerId,
  });
  void base;
  const serializer = Object.assign(new SessionSerializer({
    state, dataSourceManager: makeDataSourceManager(), getHistory: () => history, dispatcher, onLoaded: () => {},
    version: () => SESSION_TEST_VERSION,
  }), { history, setColors: value => { colors = value; }, colors: () => colors });
  return serializer;
}

/**
 * A session file of two trackers: one started on red, the shown one on
 * blue, so its head (blue) is eager and red is a lazy value.
 */
async function twoTrackerSession() {
  const source = serializerWithColors(makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() }), async () => {});
  await source.history.startTracker({ name: 'Red' });
  source.setColors('blue');
  await source.history.startTracker({ name: 'Blue', start: 'shown' });
  return source.createSessionBundle();
}

test('a saved session holds the history and the dataset part, taken once; loading it restores the history', async () => {
  const source = makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: selectionPages(SELECTED_ROWS) });
  const blob = await sessionOf(source);
  const manifest = await readHistoryFileManifest(blob);
  assert.deepEqual(Object.keys(manifest), ['createdAt', 'app', 'actions', 'scope', 'datasetFingerprint', 'source', 'requires', 'chrome', 'activeTracker', 'trackers', 'chunks']);
  assert.deepEqual(manifest.chrome, { pressed: {} }, 'a page that keeps no chrome writes none');
  assert.equal(manifest.app.version, SESSION_TEST_VERSION);
  assert.equal(manifest.scope.content, 'history');
  assert.deepEqual(manifest.source, { kind: 'sample', dataset: 'pancreas' });
  assert.equal(manifest.trackers.length, 1);
  const destination = makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() });
  const serializer = makeSerializer(destination);
  await withNotificationRecorder(async events => {
    await serializer.restoreFromBlob(blob);
    assert.deepEqual(events.map(event => event.kind), ['start', 'complete']);
    assert.equal(events[1].message, 'Session fully restored.');
  });
  assert.deepEqual(selection(destination), [SELECTED_ROWS]);
  assert.equal(serializer.history.trackers().length, 1);
  assert.equal(serializer.history.active.id, manifest.activeTracker);
  // Shown once loaded: a camera path saved with Autoplay on starts then.
  assert.equal(serializer.loads.count, 1);
  // Its manifest names the dataset it belongs to and where it opens from, without reading a chunk.
  const described = await serializer.readSessionDataset(blob);
  assert.deepEqual({ ...described }, { datasetId: 'pancreas', name: null, source: { kind: 'sample', dataset: 'pancreas' }, cells: null, genes: null });
});

test('a session carries the page chrome outside its history (the selection tool, CEL-0249): written at a save, planned before the load replaces anything, put back once its head is shown', async () => {
  const chrome = { pressed: { 'highlight-mode': 'highlight-mode-lasso' } };
  const events = [];
  const source = makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() });
  const saving = makeSerializer(source, { chrome: { capture: () => chrome, plan: () => ({ notes: [], apply() {} }) } });
  await saving.history.startTracker();
  const blob = await saving.createSessionBundle();
  assert.deepEqual((await readHistoryFileManifest(blob)).chrome, chrome);
  let loading = null;
  loading = makeSerializer(makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() }), {
    chrome: {
      capture: () => ({ pressed: {} }),
      plan: value => {
        events.push(['plan', value, loading.history.trackers().length]);
        return { notes: ['This page has no "lasso" button.'], apply: () => events.push(['apply', loading.history.trackers().length]) };
      },
    },
  });
  await loading.history.startTracker();
  const said = [];
  await withNotificationRecorder(async recorded => {
    await loading.restoreFromBlob(blob);
    said.push(...recorded.filter(event => event.kind === 'ui-info').map(event => event.message));
  });
  // Planned before the file's trackers were added beside this one, applied after.
  assert.deepEqual(events, [['plan', chrome, 1], ['apply', 2]]);
  assert.deepEqual(said, ['This page has no "lasso" button.'], 'what this page lacks is said');
  // The history holds no step for it.
  assert.equal(loading.history.active.steps.size, 1);
});

test('trackers loaded beside the person\'s are offered back with one Undo, which removes them to Recently deleted (review S5)', async () => {
  const source = makeSerializer(makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() }));
  await source.history.startTracker();
  const blob = await source.createSessionBundle();
  const loading = makeSerializer(makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() }));
  await loading.history.startTracker();
  const own = loading.history.active.id;
  let offer = null;
  await withNotificationRecorder(async recorded => {
    await loading.restoreFromBlob(blob);
    // One notice announces the restore, names what it added and offers Undo (found 2026-11-10: a
    // second notice said the same beside "Session fully restored."); the progress notice gives way to it.
    assert.equal(recorded.filter(event => event.kind === 'complete').length, 0, 'the progress notice does not also complete');
    assert.equal(recorded.filter(event => event.kind === 'dismiss').length, 1);
    const shown = recorded.filter(event => event.kind === 'ui-show');
    assert.equal(shown.length, 1, 'one notice');
    offer = shown[0].options.action?.label === 'Undo' ? shown[0].options : null;
  });
  assert.ok(offer !== null, 'an Undo is offered');
  assert.equal(offer.message, 'Session fully restored.');
  assert.equal(offer.title, 'Loaded "Tracker 1 (shared)" beside yours');
  assert.equal(loading.history.trackers().length, 2);
  const said = [];
  await withNotificationRecorder(async recorded => {
    offer.action.run();
    while (loading.history.trackers().length > 1) await new Promise(resolve => setImmediate(resolve));
    said.push(...recorded);
  });
  assert.deepEqual(said.filter(event => event.kind === 'ui-error'), []);
  assert.deepEqual(loading.history.trackers().map(tracker => tracker.id), [own]);
  const removed = loading.history.allTrackers().find(tracker => tracker.id !== own);
  assert.equal(removed.journal.at(-1).op, 'tracker.remove', 'it is in Recently deleted, restorable');
});

test('a save holds what is shown: a change made outside an action is kept as its own step', async () => {
  const serializer = serializerWithColors(makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() }), async () => {});
  await serializer.history.startTracker();
  serializer.setColors('green');
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  let file;
  try {
    file = await openHistoryFile(await serializer.createSessionBundle(), { signal: null, onProgress: null });
  } finally {
    console.warn = warn;
  }
  const eager = await file.readEager();
  await file.readRest();
  const [tracker] = eager.history.trackers;
  assert.deepEqual(tracker.steps.map(step => step.label), ['Opened', 'Changed outside the history']);
  assert.equal(eager.values.get(tracker.steps[1].after.colors), 'green');
  assert.match(warnings.join('\n'), /colors changed outside an action/);
});

test('saving needs a history; it writes what the choice holds, conversations only when chosen', async () => {
  const state = makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() });
  const serializer = makeSerializer(state);
  await assert.rejects(serializer.createSessionBundle(), /There is no history to save: open a dataset first/);
  await serializer.history.startTracker();
  serializer.history.setChat(serializer.history.active.id, 'c1', { messages: ['hello'] });
  const without = await readHistoryFileManifest(await serializer.createSessionBundle());
  assert.deepEqual(without.trackers[0].chats, []);
  assert.deepEqual(without.scope, { ...without.scope, content: 'history', chats: false, journal: true });
  const withChats = await readHistoryFileManifest(await serializer.createSessionBundle({ choice: { ...SAVE_DEFAULTS, chats: true } }));
  assert.equal(withChats.trackers[0].chats.length, 1);
  const state2 = await readHistoryFileManifest(await serializer.createSessionBundle({ choice: STATE_DEFAULTS }));
  assert.equal(state2.scope.content, 'state');
  assert.deepEqual(state2.trackers[0].chats, []);
  await assert.rejects(serializer.createSessionBundle({ choice: { ...SAVE_DEFAULTS, content: 'pictures' } }), /holds one of history, state, steps/);
});

test('a save waits for its settlement and releases it; the dataset part is read only after', async () => {
  const state = makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() });
  const serializer = makeSerializer(state);
  await serializer.history.startTracker();
  const events = [];
  const settlement = deferred();
  const generation = state.getDatasetGeneration;
  state.getDatasetGeneration = () => { events.push('read'); return generation(); };
  serializer.setCaptureSettlement(async () => {
    events.push('settle:start');
    await settlement.promise;
    events.push('settle:done');
    return () => events.push('settle:release');
  });
  const saving = serializer.createSessionBundle();
  await turn();
  assert.deepEqual(events, ['settle:start']);
  settlement.resolve();
  await saving;
  assert.equal(events[0], 'settle:start');
  assert.equal(events[1], 'settle:done');
  assert.ok(events.indexOf('read') > 1);
  assert.equal(events.at(-1), 'settle:release');
  assert.throws(() => serializer.setCaptureSettlement(async () => {}), /already owned/);
});

test('a save refuses a dataset replaced, or remapped, while its dataset part is taken', async () => {
  for (const change of [
    state => { state.getDatasetGeneration = () => 7; },
    state => { state.dataMapping = keyedMapping({ geneNames: 'column:gene_symbols' }); },
  ]) {
    const state = makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() });
    const serializer = makeSerializer(state);
    await serializer.history.startTracker();
    const entered = deferred();
    const release = deferred();
    const digest = state.dimensionManager.getCellOrderDigest.bind(state.dimensionManager);
    state.dimensionManager.getCellOrderDigest = async layout => {
      entered.resolve();
      await release.promise;
      return digest(layout);
    };
    const saving = serializer.createSessionBundle();
    await entered.promise;
    change(state);
    release.resolve();
    await assert.rejects(saving, error => error.code === 'SESSION_CAPTURE_DATASET_CHANGED' && /Save the session again/.test(error.message));
  }
});

test('a load holds its settlement before anything is put back, and releases it on success, failure, cancel and supersession', async () => {
  const blob = await sessionOf(makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: selectionPages(SELECTED_ROWS) }));
  const destination = makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() });
  const serializer = makeSerializer(destination);
  const events = [];
  const settlement = deferred();
  serializer.setRestoreSettlement(async () => {
    events.push('settle:start');
    await settlement.promise;
    events.push('settle:done');
    return () => events.push('settle:release');
  });
  await withNotificationHarness(async () => {
    const loading = serializer.restoreFromBlob(blob);
    await turn();
    assert.deepEqual(events, ['settle:start']);
    assert.deepEqual(selection(destination), []);
    settlement.resolve();
    await loading;
  });
  assert.deepEqual(events, ['settle:start', 'settle:done', 'settle:release']);
  assert.deepEqual(selection(destination), [SELECTED_ROWS]);

  // Failure, cancel and supersession each release what they took.
  let acquisitions = 0;
  let releases = 0;
  const counting = makeSerializer(makeDatasetState({ cellOrder: [5, 4, 3, 2, 1, 0], pages: emptyPages() }));
  counting.setRestoreSettlement(async () => { acquisitions++; return () => { releases++; }; });
  await withNotificationHarness(async () => {
    await assert.rejects(counting.restoreFromBlob(blob), RangeError);
  });
  assert.deepEqual({ acquisitions, releases }, { acquisitions: 1, releases: 1 });
});

test('a save waits for a load under way, a load for a save; saves run one at a time', async () => {
  const source = makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: selectionPages(SELECTED_ROWS) });
  const blob = await sessionOf(source);
  const state = makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() });
  const serializer = makeSerializer(state);
  await serializer.history.startTracker();
  const gate = deferred();
  const events = [];
  serializer.setRestoreSettlement(async () => { events.push('load'); await gate.promise; });
  serializer.setCaptureSettlement(async () => { events.push('save'); });
  await withNotificationHarness(async () => {
    const loading = serializer.restoreFromBlob(blob);
    const saving = serializer.createSessionBundle();
    const savingAgain = serializer.createSessionBundle();
    await turn();
    assert.deepEqual(events, ['load']);
    gate.resolve();
    await loading;
    const [first, second] = await Promise.all([saving, savingAgain]);
    assert.deepEqual(events, ['load', 'save', 'save']);
    // The saves were taken after the load: they hold its selection.
    for (const saved of [first, second]) {
      const file = await openHistoryFile(saved, { signal: null, onProgress: null });
      const eager = await file.readEager();
      await file.cancel('read');
      const highlights = [...eager.values.values()].find(value => value?.pages !== undefined);
      assert.deepEqual([...highlights.pages[0].groups[0].cells], SELECTED_ROWS);
    }
  });
});

test('a load that stops early releases the file it was reading', async () => {
  const blob = await sessionOf(makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: selectionPages(SELECTED_ROWS) }));
  const sources = [];
  class TrackedBlob extends Blob {
    stream() {
      const inner = super.stream().getReader();
      const record = { cancelled: false };
      sources.push(record);
      return new ReadableStream({
        async pull(controller) {
          const { value, done } = await inner.read();
          if (done) controller.close();
          else controller.enqueue(value);
        },
        cancel(reason) {
          record.cancelled = true;
          return inner.cancel(reason);
        },
      }, { highWaterMark: 0 });
    }
  }
  const tracked = new TrackedBlob([await blob.arrayBuffer()]);
  // Refused by its fingerprint after the manifest, before any chunk.
  await withNotificationHarness(async () => {
    await assert.rejects(makeSerializer(makeDatasetState({ cellOrder: [5, 4, 3, 2, 1, 0], pages: emptyPages() })).restoreFromBlob(tracked), RangeError);
  });
  assert.deepEqual(sources, [{ cancelled: true }]);
  // Stopped once the eager chunks are read (Cancel while the head is put back): the lazy ones are never read.
  const twoTrackers = new TrackedBlob([await (await twoTrackerSession()).arrayBuffer()]);
  let serializer;
  serializer = serializerWithColors(makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() }), async value => {
    // Not awaited here: the cancel settles once this restore has.
    if (value === 'blue') void serializer.cancelRestore();
  });
  await withNotificationHarness(async () => {
    await assert.rejects(serializer.restoreFromBlob(twoTrackers), error => cancellationKind(error) === 'user');
  });
  assert.equal(sources.length, 2);
  assert.equal(sources[1].cancelled, true);
  assert.equal(serializer.colors(), 'red');
});

test('a value that cannot be put back is one part not restored (F155): the rest of the file is read and shown, the part named with its words under Details', async () => {
  const blob = await twoTrackerSession();
  const serializer = serializerWithColors(makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() }), value => {
    if (value === 'blue') throw new Error('That color cannot be put back');
  });
  await withNotificationRecorder(async events => {
    await serializer.restoreFromBlob(blob);
    const shown = events.find(event => event.kind === 'ui-show');
    assert.equal(shown.options.type, 'warning');
    assert.equal(shown.options.message.startsWith('Session restored but for 1 part. Colors could not be restored: That color cannot be put back. It is left as it was shown.'), true, shown.options.message);
    assert.match(shown.options.details, /^Colors: That color cannot be put back$/);
    assert.equal(events.some(event => event.kind === 'complete'), false, 'never "fully restored"');
  });
  assert.equal(serializer.colors(), 'red', 'the part keeps what was shown');
  const names = serializer.history.trackers().map(tracker => tracker.name);
  assert.equal(names.filter(name => /Red|Blue/.test(name)).length >= 2, true, 'both trackers of the file are loaded');
});

test('a part another version wrote that this version cannot read is said as that, never as a problem inside Cellucid (F155)', async () => {
  const blob = await twoTrackerSession();
  const serializer = serializerWithColors(makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() }), value => {
    // As the Expression values' owner refused `{normalise, log1p}` after the F149 rename.
    if (value === 'blue') throw new TypeError('The colors to restore is exactly {name: string}');
  });
  // This page is a later release than the one that wrote the file.
  serializer._version = () => '99.0.0';
  await withNotificationRecorder(async events => {
    await serializer.restoreFromBlob(blob);
    const shown = events.find(event => event.kind === 'ui-show');
    assert.match(shown.options.message, new RegExp(`Colors could not be restored: it was saved by an earlier version of Cellucid \\(${SESSION_TEST_VERSION.replaceAll('.', '\\.')}\\), and this version cannot read this part\\. It is left as it was shown\\.`));
    assert.doesNotMatch(shown.options.message, /problem inside Cellucid/);
    assert.match(shown.options.details, /exactly \{name: string\}/);
  });
  // Written by this very version, the same refusal is a problem inside Cellucid, its words under Details.
  const same = serializerWithColors(makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() }), value => {
    if (value === 'blue') throw new TypeError('The colors to restore is exactly {name: string}');
  });
  await withNotificationRecorder(async events => {
    await same.restoreFromBlob(await twoTrackerSession());
    const shown = events.find(event => event.kind === 'ui-show');
    assert.match(shown.options.message, /Colors could not be restored: a problem inside Cellucid stopped it\. It is left as it was shown\./);
  });
});

test('parts of the state this version does not have are said once, as left out, with the version that wrote them (F164)', () => {
  const parts = [
    { part: 'unknown-domain', domain: 'holograms' },
    { part: 'unknown-domain', domain: 'sounds' },
    { part: 'domain', domain: 'colors', error: new Error('That color cannot be put back') },
  ];
  const newer = describeUnrestored(parts, { other: { when: 'newer', version: '0.9.9' } });
  assert.equal(newer.message, 'Session restored but for 3 parts. Parts of the state this version of Cellucid does not have ("holograms", "sounds") are left out: '
    + 'it was saved by a newer version of Cellucid (0.9.9). Colors could not be restored: That color cannot be put back. It is left as it was shown.');
  assert.equal(newer.details.split('\n')[0], 'State part "holograms": not a part of the state in this version of Cellucid; its changes are left out of every step.');
  const view = describeUnrestored([parts[0]], { subject: 'Starting view' });
  assert.equal(view.message, 'Starting view restored but for 1 part. A part of the state this version of Cellucid does not have ("holograms") is left out.');
});

test('heavy work a person\'s load finds is named on its progress line, in the words of the work, with its Cancel (F167)', async () => {
  const totals = { ms: 20_000, bytes: 1e9, what: 'Sums all 3 genes of X once for each cell\'s total (normalized values)', doing: CELL_TOTALS_DOING };
  const restoring = () => serializerWithColors(makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() }), async (value, signal, heavy) => {
    if (value === 'blue') await heavy(totals);
  });
  // A session file, loaded by the person.
  await withNotificationRecorder(async events => {
    await restoring().restoreFromBlob(await twoTrackerSession());
    const start = events.find(event => event.kind === 'start');
    assert.deepEqual(events.filter(event => event.kind === 'phase'), [{ id: start.id, kind: 'phase', doing: 'Summing each cell\'s counts for normalized values…' }]);
  });
  // A saved state of this browser, loaded by the person: the same words on its own line.
  const source = serializerWithColors(makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() }), async () => {});
  await source.history.startTracker({ name: 'Red' });
  source.setColors('blue');
  await source.history.startTracker({ name: 'Blue', start: 'shown' });
  const saved = source.history.snapshot();
  const values = new Map(source.history.pool.hashes().map(hash => [hash, source.history.pool.get(hash)]));
  const header = (await openHistoryFile(await source.createSessionBundle(), { signal: null, onProgress: null })).manifest;
  await withNotificationRecorder(async events => {
    const asked = [];
    await restoring().loadSavedHistory(async () => ({
      header, content: 'history', stamps: { app: header.app },
      readEager: async () => ({ history: saved, values }),
      readRest: async () => ({ values: new Map(), chats: [], journals: [], params: [] }),
      cancel: async () => {},
    }), { label: 'Saved state', heavy: async estimate => { asked.push(estimate.what); } });
    assert.deepEqual(events.filter(event => event.kind === 'phase').map(event => event.doing), [CELL_TOTALS_DOING]);
    assert.deepEqual(asked, [totals.what], 'an agent\'s load is asked first, then names it');
  });
});

test('Cancel stops a load mid-restore, puts back what was shown and says nothing more; a newer load supersedes silently', async () => {
  const blob = await twoTrackerSession();

  const entered = deferred();
  const destinationState = makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() });
  const destination = serializerWithColors(destinationState, (value, signal) => new Promise((resolve, reject) => {
    if (value === 'red') { resolve(); return; }
    entered.resolve();
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  await destination.history.startTracker();
  await withNotificationRecorder(async (events, controls) => {
    const loading = destination.restoreFromBlob(blob);
    await entered.promise;
    controls.cancel('download-1');
    await assert.rejects(loading, error => cancellationKind(error) === 'user');
    assert.deepEqual(events.filter(event => event.id === 'download-1').map(event => event.kind), ['start', 'dismiss']);
    assert.equal(destination.colors(), 'red');
    assert.equal(destination.history.trackers().length, 1);
  });

  // A newer load replaces one under way: the first ends silently, the second restores.
  const blocked = deferred();
  let first = true;
  const superseded = serializerWithColors(makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() }), (value, signal) => {
    if (value !== 'blue' || !first) return undefined;
    first = false;
    blocked.resolve();
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  await withNotificationRecorder(async events => {
    const older = superseded.restoreFromBlob(blob);
    await blocked.promise;
    const newer = superseded.restoreFromBlob(blob);
    await assert.rejects(older, error => cancellationKind(error) === 'superseded');
    await newer;
    assert.equal(superseded.colors(), 'blue');
    assert.deepEqual(events.filter(event => event.id === 'download-1').map(event => event.kind), ['start', 'dismiss']);
    assert.deepEqual(events.filter(event => event.id === 'download-2').map(event => event.kind), ['start', 'complete']);
  });
});

test('a failed load is said once: on its progress, marked so the session controls do not say it again', async () => {
  const blob = await sessionOf(makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: selectionPages(SELECTED_ROWS) }));
  const serializer = makeSerializer(makeDatasetState({ cellOrder: [5, 4, 3, 2, 1, 0], pages: emptyPages() }));
  await withNotificationRecorder(async events => {
    await assert.rejects(serializer.restoreFromBlob(blob), error => {
      assert.equal(isReported(error), true);
      return true;
    });
    assert.deepEqual(events.map(event => event.kind), ['start', 'fail']);
    assert.match(events[1].message, /coordinates differ/);
  });
});

test('the session controls treat Cancel and a newer session as silent no-ops', async () => {
  const blob = await twoTrackerSession();
  for (const mode of ['cancel', 'supersede']) {
    const entered = deferred();
    let blocked = true;
    const serializer = serializerWithColors(makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() }), (value, signal) => {
      if (value !== 'blue' || !blocked) return undefined;
      blocked = false;
      entered.resolve();
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    serializer.pickSessionFile = async () => blob;
    let clickHandler = null;
    const loadButton = { addEventListener: (type, handler) => { clickHandler = handler; } };
    let afterLoads = 0;
    initSessionControls({
      dom: { loadBtn: loadButton },
      datasetChanges: { recordAction: () => 1, settled: true, whenSettled: async () => {} },
      // The session's own dataset is open: it is loaded at once.
      currentDatasetIdentityId: () => 'pancreas',
      localFiles: { kept: async () => null, reopen: async () => false },
      currentCellIdentity: () => null,
      reopenDataset: async () => ({ shown: false, inPlace: false }),
      openDatasetSource: async () => false,
      sessionSerializer: serializer,
      onAfterLoad: () => { afterLoads++; },
    });
    const consoleError = console.error;
    const consoleErrors = [];
    console.error = (...args) => consoleErrors.push(args);
    try {
      await withNotificationRecorder(async (events, controls) => {
        const click = clickHandler();
        await entered.promise;
        let replacement = null;
        if (mode === 'cancel') controls.cancel('download-1');
        else replacement = serializer.restoreFromBlob(blob);
        await click;
        if (replacement !== null) await replacement;
        assert.deepEqual(events.filter(event => event.id === 'download-1').map(event => event.kind), ['start', 'dismiss']);
        assert.deepEqual(events.filter(event => event.kind === 'ui-error' || event.kind === 'ui-success'), []);
      });
    } finally {
      console.error = consoleError;
    }
    assert.deepEqual(consoleErrors, [], mode);
    assert.equal(afterLoads, 0, mode);
  }
});

test('a session using fields the dataset lacks is refused naming them, before anything is put back', async () => {
  const source = makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: selectionPages(SELECTED_ROWS) });
  // Its one category hidden: a filter the session's state uses (the `filters` domain value names the field).
  source.obsData = { fields: [{ key: 'cell_type', kind: 'category', categories: ['a'], _categoryVisible: Uint8Array.of(0), _isUserDefined: false }] };
  const blob = await sessionOf(source);
  const manifest = await readHistoryFileManifest(blob);
  assert.deepEqual(manifest.requires, { obs: ['cell_type'], var: [] });
  const destination = makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() });
  const untouched = destination.highlightPages;
  await withNotificationHarness(async () => {
    await assert.rejects(makeSerializer(destination).restoreFromBlob(blob), error => {
      assert.ok(error instanceof RangeError);
      assert.match(error.message, /^This session uses the observation field "cell_type", which the dataset that is open now does not have\. The session was not opened\./);
      return true;
    });
  });
  assert.strictEqual(destination.highlightPages, untouched);
});

test('a load says once per field which of its categories no open cell holds yet', async () => {
  const source = makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() });
  const save = await sessionOf(source);
  const startingView = await trimToPublishedDefault(save, (await readHistoryFileManifest(save)).datasetFingerprint);
  for (const [blob, what] of [[startingView, 'starting view'], [save, 'session file']]) {
    const target = makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() });
    // A text column on a subsample: what the load put back for labels its
    // open cells lack is held (here held as a domain restore holds it).
    const column = { key: 'donor', kind: 'category', categories: ['d1'], discovered: true };
    target.obsData.fields.push(column);
    holdPendingCategoryState(column, {
      visibility: [{ categoryName: 'd2', visible: false }, { categoryName: 'd3', visible: false }],
      colors: [{ categoryName: 'd2', color: [1, 0, 0] }],
    });
    const serializer = makeSerializer(target);
    const said = [];
    // The recorder puts every notification back when it ends.
    await withNotificationRecorder(async () => {
      getNotificationCenter().info = (message, options) => { said.push([message, options.category]); return 'n'; };
      if (what === 'starting view') {
        await serializer.restorePublishedDefaultState(blob, { signal: new AbortController().signal, refreshUi: () => {} });
      } else {
        await serializer.history.startTracker();
        await serializer.restoreFromBlob(blob);
      }
    });
    assert.deepEqual(said, [[
      `2 categories of "donor" in this ${what} aren't among the open cells; their settings apply when those cells open.`, 'session',
    ]], what);
  }
});

test('a starting view is put back without a step, before the first tracker, on any subsample of its dataset', async () => {
  const source = makeDatasetState({ cellOrder: IDENTITY_ORDER, pages: emptyPages() });
  source.highlightPages[0].name = 'Starting page';
  const save = await sessionOf(source);
  const startingView = await trimToPublishedDefault(save, (await readHistoryFileManifest(save)).datasetFingerprint);
  const subsample = makeDatasetState({ cellOrder: [0, 1, 2, 3], pages: emptyPages() });
  subsample.cellIdentity = createCellIdentity({ nObs: 6, kept: Uint32Array.of(0, 2, 3, 5) });
  const serializer = makeSerializer(subsample);
  const phases = [];
  await withNotificationRecorder(async events => {
    await serializer.restorePublishedDefaultState(startingView, {
      signal: new AbortController().signal,
      refreshUi: ({ phase }) => { phases.push(phase); },
    });
    // A sample's own view restores without a word, and with no transfer line: it is a part of its
    // dataset's opening, not a download ("Loading Starting view 0 B/s" at every start, round 9 close).
    assert.deepEqual(events, []);
  });
  assert.deepEqual(phases, ['commit']);
  assert.equal(subsample.highlightPages[0].name, 'Starting page');
  assert.equal(serializer.history.active, null, 'no step, no tracker: the history starts from it');
  await serializer.history.startTracker();
  assert.equal(serializer.history.active.steps.size, 1);
  // Not a starting view: a save with steps, or one put back once a tracker runs.
  await withNotificationHarness(async () => {
    await assert.rejects(makeSerializer(subsample).restorePublishedDefaultState(save, {
      signal: new AbortController().signal, refreshUi: () => {},
    }), /This is not a starting view: it names a source/);
    await assert.rejects(serializer.restorePublishedDefaultState(startingView, {
      signal: new AbortController().signal, refreshUi: () => {},
    }), /only before the first tracker starts/);
  });
});
