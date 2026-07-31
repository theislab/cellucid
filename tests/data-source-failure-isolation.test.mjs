// One unreachable catalog must never disable the whole dataset selector.
//
// `getAllDatasets()` probes every registered source. A probe failure belongs to
// the source that produced it: the remaining sources — including purely local
// ones that need no network at all — must still publish their datasets.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDataSourceManager,
} from '../assets/js/data/data-source-manager.js';

function createStubSource(type, behaviour) {
  return {
    type,
    getType() {
      return type;
    },
    isAvailable: behaviour.isAvailable,
    listDatasets: behaviour.listDatasets,
    refresh: behaviour.refresh ?? (() => {}),
  };
}

function datasetRecord(id) {
  return {
    id,
    name: id,
    description: '',
    sourceType: 'stub',
  };
}

test('one failing source never fails the sibling sources', async () => {
  const manager = createDataSourceManager();
  const catalogFailure = new Error('catalog host is unreachable');

  manager.registerSource(
    'unreachable-catalog',
    createStubSource('unreachable-catalog', {
      isAvailable: async () => {
        throw catalogFailure;
      },
      listDatasets: async () => {
        throw catalogFailure;
      },
    })
  );
  manager.registerSource(
    'local-user',
    createStubSource('local-user', {
      isAvailable: async () => true,
      listDatasets: async () => [datasetRecord('local-file')],
    })
  );

  const results = await manager.getAllDatasets();

  const local = results.find(
    entry => entry.sourceType === 'local-user'
  );
  assert.ok(
    local,
    'the local source must still publish its datasets when a remote catalog fails'
  );
  assert.deepEqual(
    local.datasets.map(dataset => dataset.id),
    ['local-file']
  );
  assert.equal(local.error, null);

  const failed = results.find(
    entry => entry.sourceType === 'unreachable-catalog'
  );
  assert.ok(
    failed,
    'the failing source must be reported instead of silently disappearing'
  );
  assert.equal(failed.error, catalogFailure);
  assert.deepEqual(failed.datasets, []);
});

test('a source that rejects listDatasets is isolated exactly like a failing probe', async () => {
  const manager = createDataSourceManager();
  const listFailure = new Error('catalog manifest is malformed');

  manager.registerSource(
    'broken-list',
    createStubSource('broken-list', {
      isAvailable: async () => true,
      listDatasets: async () => {
        throw listFailure;
      },
    })
  );
  manager.registerSource(
    'healthy',
    createStubSource('healthy', {
      isAvailable: async () => true,
      listDatasets: async () => [datasetRecord('healthy-dataset')],
    })
  );

  const results = await manager.getAllDatasets();

  assert.deepEqual(
    results
      .filter(entry => entry.error === null)
      .map(entry => entry.sourceType),
    ['healthy']
  );
  assert.equal(
    results.find(entry => entry.sourceType === 'broken-list').error,
    listFailure
  );
});

test('a source violating the probe contract is isolated, not propagated', async () => {
  const manager = createDataSourceManager();

  manager.registerSource(
    'contract-violation',
    createStubSource('contract-violation', {
      isAvailable: async () => 'yes',
      listDatasets: async () => [],
    })
  );
  manager.registerSource(
    'healthy',
    createStubSource('healthy', {
      isAvailable: async () => true,
      listDatasets: async () => [datasetRecord('healthy-dataset')],
    })
  );

  const results = await manager.getAllDatasets();

  const violation = results.find(
    entry => entry.sourceType === 'contract-violation'
  );
  assert.ok(violation.error instanceof TypeError);
  assert.match(
    violation.error.message,
    /isAvailable\(\) must resolve to a boolean/
  );
  assert.deepEqual(
    results
      .filter(entry => entry.error === null)
      .map(entry => entry.sourceType),
    ['healthy']
  );
});

test('unavailable sources stay omitted and carry no failure', async () => {
  const manager = createDataSourceManager();

  manager.registerSource(
    'absent',
    createStubSource('absent', {
      isAvailable: async () => false,
      listDatasets: async () => {
        throw new Error('listDatasets must not run for an absent source');
      },
    })
  );

  assert.deepEqual(await manager.getAllDatasets(), []);
});

test('an explicit refresh clears a cached source failure and never rejects', async () => {
  const manager = createDataSourceManager();
  let failNext = true;
  let refreshCalls = 0;

  manager.registerSource(
    'recoverable',
    createStubSource('recoverable', {
      isAvailable: async () => {
        if (failNext) throw new Error('transient outage');
        return true;
      },
      listDatasets: async () => [datasetRecord('recovered')],
      refresh() {
        refreshCalls++;
        failNext = false;
      },
    })
  );
  manager.registerSource(
    'always-throws-on-refresh',
    createStubSource('always-throws-on-refresh', {
      isAvailable: async () => false,
      listDatasets: async () => [],
      async refresh() {
        throw new Error('this source cannot be refreshed');
      },
    })
  );

  const before = await manager.getAllDatasets();
  assert.match(
    before.find(entry => entry.sourceType === 'recoverable').error.message,
    /transient outage/
  );

  const outcomes = await manager.refreshAll();
  assert.equal(refreshCalls, 1);
  assert.equal(
    outcomes.find(entry => entry.sourceType === 'recoverable').error,
    null
  );
  assert.match(
    outcomes.find(
      entry => entry.sourceType === 'always-throws-on-refresh'
    ).error.message,
    /cannot be refreshed/
  );

  const after = await manager.getAllDatasets();
  const recovered = after.find(
    entry => entry.sourceType === 'recoverable'
  );
  assert.equal(recovered.error, null);
  assert.deepEqual(
    recovered.datasets.map(dataset => dataset.id),
    ['recovered']
  );
});

test('getAllDatasets can clear cached failures in one pass', async () => {
  const manager = createDataSourceManager();
  let failNext = true;

  manager.registerSource(
    'recoverable',
    createStubSource('recoverable', {
      isAvailable: async () => {
        if (failNext) throw new Error('transient outage');
        return true;
      },
      listDatasets: async () => [datasetRecord('recovered')],
      refresh() {
        failNext = false;
      },
    })
  );

  assert.match(
    (await manager.getAllDatasets())[0].error.message,
    /transient outage/
  );

  const refreshed = await manager.getAllDatasets({ refresh: true });
  assert.equal(refreshed[0].error, null);
  assert.deepEqual(
    refreshed[0].datasets.map(dataset => dataset.id),
    ['recovered']
  );
});

test('getAllDatasets rejects unsupported option records', async () => {
  const manager = createDataSourceManager();
  await assert.rejects(
    manager.getAllDatasets({ refreshEverything: true }),
    /supports only: refresh/i
  );
  await assert.rejects(
    manager.getAllDatasets({ refresh: 'yes' }),
    /refresh must be a boolean/i
  );
});
