import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import {
  createDataSourceManager
} from '../assets/js/data/data-source-manager.js';

function metadata(id) {
  return Object.freeze({
    version: 2,
    id,
    name: id,
    description: '',
    cellucid_data_version: '1.0.0',
    stats: Object.freeze({
      n_cells: 1,
      n_genes: 0,
      n_obs_fields: 0,
      n_categorical_fields: 0,
      n_continuous_fields: 0,
      has_connectivity: false,
      n_edges: null,
    }),
    embeddings: Object.freeze({
      available_dimensions: Object.freeze([2]),
      default_dimension: 2,
      files: Object.freeze({ '2d': 'points_2d.bin' }),
    }),
    obs_fields: Object.freeze([]),
  });
}

function source(
  type,
  {
    baseUrl = null,
    deactivateError = null,
    identityId = null,
    metadataValue = null,
  } = {}
) {
  const deactivations = [];
  const disconnections = [];
  const metadataCalls = [];
  return {
    deactivations,
    disconnections,
    metadataCalls,
    disconnect() {
      disconnections.push(type);
    },
    async getMetadata(datasetId) {
      metadataCalls.push(datasetId);
      return metadataValue ?? metadata(datasetId);
    },
    getBaseUrl(datasetId) {
      return baseUrl ?? `https://datasets.test/${type}/${datasetId}/`;
    },
    getIdentityId(datasetId) {
      return identityId ?? datasetId;
    },
    getType() {
      return type;
    },
    onDeactivate() {
      deactivations.push(type);
      if (deactivateError !== null) throw deactivateError;
    }
  };
}

test('dataset selection remains side-effect free until final publication', async () => {
  const manager = createDataSourceManager();
  const prior = source('local-user');
  const candidate = source('remote');
  manager.registerSource('local-user', prior);
  manager.registerSource('remote', candidate);
  await manager.switchToDataset('local-user', 'prior');

  const events = [];
  manager.onDatasetChange(event => events.push(event));
  const stage = await manager.stageDatasetSelection(
    'remote',
    'candidate',
    { loadMethod: 'remote-connect' }
  );

  assert.equal(manager.getCurrentSourceType(), 'local-user');
  assert.equal(manager.getCurrentDatasetId(), 'prior');
  assert.equal(prior.deactivations.length, 0);
  assert.equal(events.length, 0);

  // A failed runtime stage explicitly discards its manager candidate. In
  // particular, it never revokes the prior local-user generation's Object
  // URLs/caches and can never be published later.
  manager.discardDatasetSelection(stage);
  assert.equal(manager.getCurrentSourceType(), 'local-user');
  assert.equal(manager.getCurrentDatasetId(), 'prior');
  assert.equal(prior.deactivations.length, 0);
  assert.equal(events.length, 0);
  assert.throws(
    () => manager.commitDatasetSelection(stage),
    /current manager-owned stage/i
  );

  const readyStage = await manager.stageDatasetSelection(
    'remote',
    'candidate',
    { loadMethod: 'remote-connect' }
  );
  const publication = manager.commitDatasetSelection(readyStage);
  assert.equal(prior.deactivations.length, 0);
  assert.equal(manager.getCurrentSourceType(), 'remote');
  assert.equal(manager.getCurrentDatasetId(), 'candidate');
  assert.equal(events.length, 0);

  manager.publishDatasetSelection(publication);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], publication);
  assert.equal(prior.deactivations.length, 0);
  manager.finalizeDatasetSelection(publication);
  assert.equal(prior.deactivations.length, 1);
  assert.throws(
    () => manager.publishDatasetSelection(publication),
    /unpublished manager commit/i
  );
});

test('selection boundaries reject malformed inputs before source I/O', async t => {
  const manager = createDataSourceManager();
  const candidate = source('remote');
  manager.registerSource('remote', candidate);

  for (const [label, sourceType, datasetId] of [
    ['empty source type', '', 'dataset'],
    ['padded source type', ' remote', 'dataset'],
    ['non-string source type', 1, 'dataset'],
    ['empty dataset id', 'remote', ''],
    ['padded dataset id', 'remote', 'dataset '],
    ['non-string dataset id', 'remote', null],
  ]) {
    await t.test(label, async () => {
      await assert.rejects(
        manager.stageDatasetSelection(sourceType, datasetId),
        TypeError
      );
      assert.deepEqual(candidate.metadataCalls, []);
    });
  }

  const inherited = Object.create({ loadMethod: 'inherited' });
  const accessor = {};
  let accessorReads = 0;
  Object.defineProperty(accessor, 'loadMethod', {
    enumerable: true,
    get() {
      accessorReads++;
      return 'accessor';
    },
  });
  const symbol = Object.assign({}, {
    [Symbol('loadMethod')]: 'symbol',
  });
  const nonEnumerable = {};
  Object.defineProperty(nonEnumerable, 'loadMethod', {
    enumerable: false,
    value: 'hidden',
  });

  for (const [label, options] of [
    ['extra option', { extra: true }],
    ['inherited option', inherited],
    ['accessor option', accessor],
    ['symbol option', symbol],
    ['non-enumerable option', nonEnumerable],
    ['array options', []],
    ['null options', null],
    ['non-string load method', { loadMethod: 1 }],
    ['empty load method', { loadMethod: '' }],
    ['padded load method', { loadMethod: 'manual ' }],
  ]) {
    await t.test(label, async () => {
      await assert.rejects(
        manager.stageDatasetSelection('remote', 'dataset', options),
        TypeError
      );
      assert.deepEqual(candidate.metadataCalls, []);
    });
  }
  assert.equal(accessorReads, 0);

  for (const [label, operationName, options] of [
    ['non-boolean switch silent', 'switch', { silent: 1 }],
    ['switch extra option', 'switch', { extra: true }],
    ['non-boolean clear silent', 'clear', { silent: 'false' }],
    ['clear extra option', 'clear', { extra: true }],
  ]) {
    await t.test(label, async () => {
      const operation = operationName === 'clear'
        ? Promise.resolve().then(() => manager.clearActiveDataset(options))
        : manager.switchToDataset('remote', 'dataset', options);
      await assert.rejects(operation, TypeError);
      assert.deepEqual(candidate.metadataCalls, []);
    });
  }
});

test('active source registry cannot be replaced or removed', async () => {
  const manager = createDataSourceManager();
  const active = source('remote');
  const replacement = source('remote');
  manager.registerSource('remote', active);
  await manager.switchToDataset('remote', 'served');

  assert.throws(
    () => manager.registerSource('remote', replacement),
    /cannot replace active data source/i
  );
  assert.equal(manager.getSource('remote'), active);
  assert.equal(manager.getCurrentSourceType(), 'remote');
  assert.equal(manager.getCurrentDatasetId(), 'served');
  assert.throws(
    () => manager.unregisterSource('remote'),
    /cannot unregister active data source/i
  );
  assert.equal(manager.getSource('remote'), active);
  assert.equal(active.disconnections.length, 0);

  manager.clearActiveDataset();
  manager.unregisterSource('remote');
  assert.equal(manager.getSource('remote'), null);
});

test('malformed source results fail before manager publication', async t => {
  const manager = createDataSourceManager();
  const prior = source('prior');
  manager.registerSource('prior', prior);
  await manager.switchToDataset('prior', 'stable');
  const events = [];
  manager.onDatasetChange(event => events.push(event));

  const wrongIdentity = source('wrong-identity', {
    metadataValue: metadata('different-id'),
  });
  const invalidBase = source('invalid-base', {
    baseUrl: ' https://datasets.test/invalid-base/dataset/',
  });
  const invalidLocalIdentity = source('local-user', {
    identityId: 'identity\u0000id',
  });
  manager.registerSource('wrong-identity', wrongIdentity);
  manager.registerSource('invalid-base', invalidBase);
  manager.registerSource('local-user', invalidLocalIdentity);

  await t.test('metadata id mismatch', async () => {
    await assert.rejects(
      manager.stageDatasetSelection('wrong-identity', 'dataset'),
      /does not match catalog id/i
    );
  });
  await t.test('non-exact base URL', async () => {
    await assert.rejects(
      manager.stageDatasetSelection('invalid-base', 'dataset'),
      /exact dataset base URL/i
    );
  });
  await t.test('non-exact local identity id', async () => {
    await assert.rejects(
      manager.stageDatasetSelection('local-user', 'dataset'),
      /exact dataset identity id/i
    );
  });

  assert.equal(manager.getCurrentSourceType(), 'prior');
  assert.equal(manager.getCurrentDatasetId(), 'stable');
  assert.deepEqual(manager.getCurrentMetadata(), metadata('stable'));
  assert.equal(events.length, 0);
  assert.equal(prior.deactivations.length, 0);
});

test('stale and failed staged commits preserve the exact prior selection', async t => {
  await t.test('intervening selection supersedes an older stage', async () => {
    const manager = createDataSourceManager();
    const alpha = source('alpha');
    const beta = source('beta');
    manager.registerSource('alpha', alpha);
    manager.registerSource('beta', beta);
    await manager.switchToDataset('alpha', 'prior');

    const stale = await manager.stageDatasetSelection('beta', 'stale');
    await manager.switchToDataset('alpha', 'newer');
    assert.throws(
      () => manager.commitDatasetSelection(stale),
      /superseded/i
    );
    assert.equal(manager.getCurrentSourceType(), 'alpha');
    assert.equal(manager.getCurrentDatasetId(), 'newer');
    assert.equal(alpha.deactivations.length, 0);
  });

  await t.test('cleanup failure retains the fully published candidate', async () => {
    const deactivationFailure = new Error('cannot retire prior source');
    const manager = createDataSourceManager();
    const prior = source('local-user', {
      deactivateError: deactivationFailure
    });
    manager.registerSource('local-user', prior);
    manager.registerSource('remote', source('remote'));
    await manager.switchToDataset('local-user', 'prior');

    const stage = await manager.stageDatasetSelection(
      'remote',
      'candidate'
    );
    assert.equal(prior.deactivations.length, 0);
    const publication = manager.commitDatasetSelection(stage);
    manager.publishDatasetSelection(publication);
    assert.equal(prior.deactivations.length, 0);
    assert.throws(
      () => manager.finalizeDatasetSelection(publication),
      error => error === deactivationFailure
    );
    assert.equal(manager.getCurrentSourceType(), 'remote');
    assert.equal(manager.getCurrentDatasetId(), 'candidate');
    assert.equal(prior.deactivations.length, 1);
  });
});

test('None selection uses the same deferred commit and listener boundary', async () => {
  const manager = createDataSourceManager();
  const prior = source('remote');
  manager.registerSource('remote', prior);
  await manager.switchToDataset('remote', 'served');
  const events = [];
  manager.onDatasetChange(event => events.push(event));

  const stage = manager.stageDatasetClear({
    loadMethod: 'dataset-dropdown'
  });
  assert.equal(manager.getCurrentSourceType(), 'remote');
  assert.equal(prior.deactivations.length, 0);

  const publication = manager.commitDatasetClear(stage);
  assert.equal(prior.deactivations.length, 0);
  assert.equal(manager.getCurrentSourceType(), null);
  assert.equal(manager.getCurrentDatasetId(), null);
  assert.equal(events.length, 0);

  manager.publishDatasetSelection(publication);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    baseUrl: null,
    datasetId: null,
    loadMethod: 'dataset-dropdown',
    metadata: null,
    previousDatasetId: 'served',
    previousSourceType: 'remote',
    sourceType: null
  });
  assert.equal(prior.deactivations.length, 0);
  manager.finalizeDatasetSelection(publication);
  assert.equal(prior.deactivations.length, 1);
});

test('candidate publication retires one displaced non-active transport', async () => {
  const manager = createDataSourceManager();
  const active = source('local-demo');
  const displaced = source('remote');
  const candidate = source('remote');
  manager.registerSource('local-demo', active);
  manager.registerSource('remote', displaced);
  await manager.switchToDataset('local-demo', 'prior');

  const stage = await manager.stageDatasetSelection(
    'remote',
    'served',
    {
      loadMethod: 'remote-connect',
      source: candidate
    }
  );
  const publication = manager.commitDatasetSelection(stage);
  assert.equal(manager.getSource('remote'), candidate);
  assert.equal(displaced.disconnections.length, 0);
  manager.publishDatasetSelection(publication);
  assert.equal(displaced.disconnections.length, 0);
  manager.finalizeDatasetSelection(publication);
  assert.equal(displaced.disconnections.length, 1);
  assert.equal(active.deactivations.length, 1);
});

test('unpublished manager commit can roll back after runtime publication failure', async () => {
  const manager = createDataSourceManager();
  const prior = source('local-user');
  const displaced = source('remote');
  const candidate = source('remote');
  manager.registerSource('local-user', prior);
  manager.registerSource('remote', displaced);
  await manager.switchToDataset('local-user', 'prior');

  const stage = await manager.stageDatasetSelection(
    'remote',
    'candidate',
    { source: candidate }
  );
  const publication = manager.commitDatasetSelection(stage);
  assert.equal(manager.getCurrentSourceType(), 'remote');
  assert.equal(manager.getSource('remote'), candidate);
  manager.rollbackDatasetSelection(publication);

  assert.equal(manager.getCurrentSourceType(), 'local-user');
  assert.equal(manager.getCurrentDatasetId(), 'prior');
  assert.equal(manager.getSource('remote'), displaced);
  assert.equal(prior.deactivations.length, 0);
  assert.equal(displaced.disconnections.length, 0);
  assert.throws(
    () => manager.publishDatasetSelection(publication),
    /unpublished manager commit/i
  );
});

test(
  'custom-protocol staging resolves through the candidate without replacing the registry',
  async t => {
    for (const [sourceType, url] of [
      ['local-user', 'local-user://dataset/exact/data.bin'],
      ['remote', 'remote://server.test/exports/exact/data.bin'],
      ['remote', 'remotes://server.test/exports/exact/data.bin'],
      ['jupyter', 'jupyter://viewer/exact/data.bin'],
    ]) {
      await t.test(url.split('://')[0], async () => {
        const manager = createDataSourceManager();
        const priorCalls = [];
        const candidateCalls = [];
        const prior = {
          getType() {
            return sourceType;
          },
          async resolveUrl(input, signal) {
            priorCalls.push({ input, signal });
            return 'https://prior.test/data.bin';
          },
        };
        const candidate = {
          getType() {
            return sourceType;
          },
          async resolveUrl(input, signal) {
            candidateCalls.push({ input, signal });
            return 'https://candidate.test/data.bin';
          },
        };
        manager.registerSource(sourceType, prior);
        const signal = new AbortController().signal;

        assert.equal(
          await manager.resolveUrlWithSource(
            url,
            signal,
            candidate
          ),
          'https://candidate.test/data.bin'
        );
        assert.equal(manager.getSource(sourceType), prior);
        assert.deepEqual(priorCalls, []);
        assert.deepEqual(candidateCalls, [{ input: url, signal }]);

        assert.equal(
          await manager.resolveUrl(url, signal),
          'https://prior.test/data.bin'
        );
        assert.equal(priorCalls.length, 1);
        await assert.rejects(
          manager.resolveUrlWithSource(
            url,
            signal,
            {
              getType() {
                return sourceType === 'remote'
                  ? 'jupyter'
                  : 'remote';
              },
              async resolveUrl() {
                throw new Error('wrong source must not run');
              },
            }
          ),
          /requires one exact.*source owner/i
        );
      });
    }

    const manager = createDataSourceManager();
    await assert.rejects(
      manager.resolveUrlWithSource(
        'https://ordinary.test/data.bin',
        null,
        {
          getType() {
            return 'remote';
          },
          async resolveUrl() {
            throw new Error('standard URL must not use a staged source');
          },
        }
      ),
      /requires one registered custom protocol URL/i
    );
  }
);

test(
  'the data source manager exposes exactly the members its consumers reach',
  async () => {
    const managerSource = await readFile(
      new URL('../assets/js/data/data-source-manager.js', import.meta.url),
      'utf8',
    );
    const manager = createDataSourceManager();

    // `fetch` has no literal call site: session restore-from-URL reaches it
    // through `requireMethod(ctx.dataSourceManager, 'fetch', ...)`, and figure
    // export reaches `getStateSnapshot` through a method-name list. Deleting
    // either because a call-site search came back empty breaks a live path, so
    // both the lookup and the member are pinned here.
    const serializerSource = await readFile(
      new URL(
        '../assets/js/app/session/session-serializer.js',
        import.meta.url,
      ),
      'utf8',
    );
    assert.match(
      serializerSource,
      /requireMethod\(\s*ctx\.dataSourceManager,\s*'fetch',/,
    );
    assert.equal(typeof manager.fetch, 'function');

    const exportSource = await readFile(
      new URL(
        '../assets/js/app/ui/modules/figure-export/figure-export-engine.js',
        import.meta.url,
      ),
      'utf8',
    );
    assert.match(exportSource, /'getStateSnapshot',/);
    assert.equal(typeof manager.getStateSnapshot, 'function');

    // Nothing anywhere restores a snapshot through the manager, and nothing
    // fetches JSON through it, so neither member may return.
    for (const removed of ['restoreState', 'fetchJson']) {
      assert.equal(
        manager[removed],
        undefined,
        `${removed} has no consumer; re-adding it re-creates dead surface`,
      );
      assert.equal(managerSource.includes(removed), false);
    }
  },
);
