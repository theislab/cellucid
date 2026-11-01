import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertDatasetSourceRecord,
  captureDatasetSourceRecord,
  describeDatasetSourceRecord,
} from '../assets/js/app/session/dataset-source-record.js';
import { getOpeningProgress } from '../assets/js/data/opening-progress.js';
import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { initSessionControls } from '../assets/js/app/ui/modules/session-controls.js';

function manager(sourceType, datasetId, info = null) {
  return {
    getCurrentSourceType: () => sourceType,
    getCurrentDatasetId: () => datasetId,
    activeSource: info === null ? null : { getConnectionInfo: () => info },
  };
}

test('the open dataset is recorded where another person could open it again', () => {
  assert.deepEqual(
    captureDatasetSourceRecord(manager('local-demo', 'suo')),
    { kind: 'sample', dataset: 'suo' },
  );
  assert.deepEqual(
    captureDatasetSourceRecord(manager('link', 'pbmc', {
      connected: true,
      locator: 'zenodo:123:pbmc.h5ad',
    })),
    { kind: 'link', locator: 'zenodo:123:pbmc.h5ad', dataset: 'pbmc' },
  );
  assert.deepEqual(
    captureDatasetSourceRecord(manager('remote', 'a', {
      status: 'connected',
      url: 'http://localhost:8765',
    })),
    { kind: 'remote', url: 'http://localhost:8765', dataset: 'a' },
  );
  // A local file or a notebook cannot be reopened from the session alone.
  assert.equal(captureDatasetSourceRecord(manager('local-user', 'mine')), null);
  assert.equal(captureDatasetSourceRecord(manager('jupyter', 'nb')), null);
  assert.equal(captureDatasetSourceRecord(manager(null, null)), null);
  assert.equal(captureDatasetSourceRecord(null), null);
});

test('a recorded source is validated as untrusted input', () => {
  assert.equal(assertDatasetSourceRecord(null, 'source'), null);
  for (const valid of [
    { kind: 'sample', dataset: 'suo' },
    { kind: 'link', locator: 'gh:owner/repo/exports', dataset: 'x' },
    { kind: 'remote', url: 'https://cells.example.org/', dataset: 'x' },
  ]) {
    assert.equal(assertDatasetSourceRecord(valid, 'source'), valid);
  }
  for (const invalid of [
    {},
    { kind: 'file', dataset: 'x' },
    { kind: 'sample', dataset: '' },
    { kind: 'sample', dataset: ' x' },
    { kind: 'sample', dataset: 'x', locator: 'y' },
    { kind: 'link', dataset: 'x' },
    { kind: 'remote', url: 'javascript:alert(1)', dataset: 'x' },
    { kind: 'remote', url: 'not a url', dataset: 'x' },
  ]) {
    assert.throws(() => assertDatasetSourceRecord(invalid, 'source'), TypeError);
  }
});

test('a recorded source is named the way the person loading the session knows it', () => {
  assert.equal(
    describeDatasetSourceRecord({ kind: 'sample', dataset: 'suo' }),
    'the sample dataset "suo"',
  );
  assert.equal(
    describeDatasetSourceRecord({ kind: 'link', locator: 'hf:a/b', dataset: 'x' }),
    'hf:a/b',
  );
  assert.equal(
    describeDatasetSourceRecord({ kind: 'remote', url: 'http://h:1', dataset: 'x' }),
    'the Cellucid server at http://h:1',
  );
});

function loadButton() {
  let listener = null;
  return {
    addEventListener(_type, fn) {
      listener = fn;
    },
    click: () => listener(),
  };
}

async function loadSession({ recorded, openIdentity, opens = true }) {
  const button = loadButton();
  const calls = [];
  const file = new Blob(['session']);
  // Opening the session's dataset is shown by the opening progress.
  const shown = new Set();
  const stopOpenings = getOpeningProgress().subscribe(snapshot => {
    if (snapshot === null || shown.has(snapshot.id)) return;
    shown.add(snapshot.id);
    calls.push(['notice', snapshot.title]);
  });
  try {
    const controls = initSessionControls({
      dom: { loadBtn: button },
      datasetChanges: {
        recordAction: () => 1,
        settled: true,
        whenSettled: async () => {},
      },
      currentDatasetIdentityId: () => openIdentity,
      localFiles: { kept: async () => null, reopen: async () => false },
      currentCellIdentity: () => null,
      reopenDataset: async () => ({ shown: false, inPlace: false }),
      openDatasetSource: async record => {
        calls.push(['open', record]);
        return opens;
      },
      sessionSerializer: {
        downloadSession() {},
        async readSessionDataset(blob) {
          assert.equal(blob, file);
          return { datasetId: 'suo-identity', source: recorded, cells: null };
        },
        async loadSessionFromFile({ beforeRestore }) {
          const proceed = await beforeRestore(file);
          calls.push(['restore', proceed]);
          return proceed;
        },
      },
    });
    await button.click();
    await controls.destroy();
  } finally {
    stopOpenings();
  }
  return calls;
}

test('loading a session opens the dataset it records before applying it', async () => {
  const recorded = { kind: 'sample', dataset: 'suo' };
  assert.deepEqual(
    await loadSession({ recorded, openIdentity: null }),
    [
      ['notice', 'the session\'s dataset from the sample dataset "suo"'],
      ['open', recorded],
      ['restore', true],
    ],
  );
  // Another dataset is open: the session's own one replaces it.
  assert.deepEqual(
    (await loadSession({ recorded, openIdentity: 'other' })).map(([kind]) => kind),
    ['notice', 'open', 'restore'],
  );
});

test('the session dataset already open, or none recorded, is applied as is', async () => {
  assert.deepEqual(
    await loadSession({
      recorded: { kind: 'sample', dataset: 'suo' },
      openIdentity: 'suo-identity',
    }),
    [['restore', true]],
  );
  assert.deepEqual(
    await loadSession({ recorded: null, openIdentity: 'other' }),
    [['restore', true]],
  );
});

test('a recorded dataset that could not be opened abandons the restore', async () => {
  assert.deepEqual(
    (await loadSession({
      recorded: { kind: 'link', locator: 'hf:a/b', dataset: 'x' },
      openIdentity: null,
      opens: false,
    })).at(-1),
    ['restore', false],
  );
});

/**
 * Load a session saved on a file of this computer (`{kind: 'file'}`) with
 * `kept` (the handle kept of it, `app/local-file-handles.js`), recording
 * what the controls ask and offer.
 */
async function loadLocalSession({ kept, opens = true }) {
  const button = loadButton();
  const calls = [];
  const file = new Blob(['session']);
  const recorded = { kind: 'file', name: 'cells.h5ad', dataset: 'h5ad_cells_1a2b3c4d' };
  let openIdentity = 'suo';
  const notifications = getNotificationCenter();
  const show = notifications.show;
  const offers = [];
  notifications.show = options => {
    offers.push(options);
    return 'offer';
  };
  try {
    const controls = initSessionControls({
      dom: { loadBtn: button },
      datasetChanges: { recordAction: () => 1, settled: true, whenSettled: async () => {} },
      currentDatasetIdentityId: () => openIdentity,
      localFiles: {
        kept: async datasetId => {
          calls.push(['kept', datasetId]);
          return kept;
        },
        reopen: async datasetId => {
          calls.push(['reopen', datasetId]);
          if (opens) openIdentity = recorded.dataset;
          return opens;
        },
      },
      currentCellIdentity: () => null,
      reopenDataset: async () => ({ shown: false, inPlace: false }),
      openDatasetSource: async record => {
        calls.push(['open', record]);
        return false;
      },
      sessionSerializer: {
        downloadSession() {},
        async readSessionDataset() {
          return { datasetId: recorded.dataset, source: recorded, cells: null };
        },
        async loadSessionFromFile({ beforeRestore }) {
          const proceed = await beforeRestore(file);
          calls.push(['restore', proceed]);
          return proceed;
        },
        async restoreFromBlob(blob) {
          assert.equal(blob, file);
          calls.push(['restore', 'offered']);
        },
      },
    });
    await button.click();
    if (offers.length > 0) {
      calls.push(['offer', offers[0].message, offers[0].action.label]);
      offers[0].action.run();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    await controls.destroy();
  } finally {
    notifications.show = show;
  }
  return calls;
}

test('a session saved on a file of this computer opens it from its kept handle', async () => {
  // Leave to read it is given: it opens at once, then the session applies.
  assert.deepEqual(
    await loadLocalSession({ kept: { name: 'cells.h5ad', kind: 'file', granted: true } }),
    [['kept', 'h5ad_cells_1a2b3c4d'], ['reopen', 'h5ad_cells_1a2b3c4d'], ['restore', true]],
  );
  // Leave must be asked in a click: the session offers Reopen, and its click
  // reopens the file, then applies the same session file.
  assert.deepEqual(
    await loadLocalSession({ kept: { name: 'cells.h5ad', kind: 'file', granted: false } }),
    [
      ['kept', 'h5ad_cells_1a2b3c4d'],
      ['restore', false],
      ['offer', 'This session was saved on "cells.h5ad", opened from this computer.', 'Reopen cells.h5ad'],
      ['reopen', 'h5ad_cells_1a2b3c4d'],
      ['restore', 'offered'],
    ],
  );
  // A reopen that failed (refused, gone, changed: said by its opening)
  // applies nothing.
  assert.deepEqual(
    (await loadLocalSession({ kept: { name: 'cells.h5ad', kind: 'file', granted: false }, opens: false })).at(-1),
    ['reopen', 'h5ad_cells_1a2b3c4d'],
  );
  // Nothing kept (another browser, or Firefox and Safari): applied to what is
  // open, as before, and the restore names the file it needs.
  assert.deepEqual(
    await loadLocalSession({ kept: null }),
    [['kept', 'h5ad_cells_1a2b3c4d'], ['restore', true]],
  );
});

test('a newer session file retires the Reopen offer of the last one, and that offer then applies nothing', async () => {
  const button = loadButton();
  const file = new Blob(['session']);
  const recorded = { kind: 'file', name: 'cells.h5ad', dataset: 'h5ad_cells_1a2b3c4d' };
  const notifications = getNotificationCenter();
  const { show, dismiss } = notifications;
  const offers = [];
  const dismissed = [];
  const reopened = [];
  notifications.show = options => {
    offers.push(options);
    return `offer-${offers.length}`;
  };
  notifications.dismiss = id => {
    dismissed.push(id);
    return true;
  };
  try {
    const controls = initSessionControls({
      dom: { loadBtn: button },
      datasetChanges: { recordAction: () => 1, settled: true, whenSettled: async () => {} },
      currentDatasetIdentityId: () => 'suo',
      localFiles: {
        kept: async () => ({ name: 'cells.h5ad', kind: 'file', granted: false }),
        reopen: async datasetId => {
          reopened.push(datasetId);
          return false;
        },
      },
      currentCellIdentity: () => null,
      reopenDataset: async () => ({ shown: false, inPlace: false }),
      openDatasetSource: async () => false,
      sessionSerializer: {
        downloadSession() {},
        async readSessionDataset() {
          return { datasetId: recorded.dataset, source: recorded, cells: null };
        },
        async loadSessionFromFile({ beforeRestore }) {
          return beforeRestore(file);
        },
        async restoreFromBlob() {},
      },
    });
    await button.click();
    await button.click();
    assert.equal(offers.length, 2);
    assert.deepEqual(dismissed, ['offer-1']);
    // The first offer, clicked anyway, is no longer this tab's restore.
    offers[0].action.run();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(reopened, []);
    offers[1].action.run();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(reopened, ['h5ad_cells_1a2b3c4d']);
    await controls.destroy();
  } finally {
    notifications.show = show;
    notifications.dismiss = dismiss;
  }
});
