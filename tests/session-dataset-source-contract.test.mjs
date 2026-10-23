import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertDatasetSourceRecord,
  captureDatasetSourceRecord,
  describeDatasetSourceRecord,
} from '../assets/js/app/session/dataset-source-record.js';
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
  const notifications = getNotificationCenter();
  const original = {
    loading: notifications.loading,
    dismiss: notifications.dismiss,
  };
  notifications.loading = message => {
    calls.push(['notice', message]);
    return 'opening';
  };
  notifications.dismiss = () => {};
  try {
    const controls = initSessionControls({
      dom: { loadBtn: button },
      datasetChanges: {
        recordAction: () => 1,
        settled: true,
        whenSettled: async () => {},
      },
      currentDatasetIdentityId: () => openIdentity,
      openDatasetSource: async record => {
        calls.push(['open', record]);
        return opens;
      },
      sessionSerializer: {
        downloadSession() {},
        async readSessionDataset(blob) {
          assert.equal(blob, file);
          return { datasetId: 'suo-identity', source: recorded };
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
    Object.assign(notifications, original);
  }
  return calls;
}

test('loading a session opens the dataset it records before applying it', async () => {
  const recorded = { kind: 'sample', dataset: 'suo' };
  assert.deepEqual(
    await loadSession({ recorded, openIdentity: null }),
    [
      ['notice', 'Opening the session\'s dataset from the sample dataset "suo"…'],
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
