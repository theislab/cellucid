import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  loadDatasetGeneration,
  validateDatasetGeneration,
} from '../assets/js/data/dataset-generation-contract.js';
function identityFixture({
  nGenes = 1,
  hasConnectivity = true,
  nEdges = 2,
} = {}) {
  return {
    version: 2,
    id: 'exact-generation',
    name: 'Exact generation',
    description: '',
    cellucid_data_version: '2.0.0',
    stats: {
      n_cells: 3,
      n_genes: nGenes,
      n_obs_fields: 2,
      n_categorical_fields: 1,
      n_continuous_fields: 1,
      has_connectivity: hasConnectivity,
      n_edges: hasConnectivity ? nEdges : null,
    },
    embeddings: {
      available_dimensions: [2],
      default_dimension: 2,
      files: { '2d': 'points_2d.bin' },
    },
    obs_fields: [
      { key: 'score', kind: 'continuous' },
      {
        key: 'cluster',
        kind: 'category',
        n_categories: 2,
      },
    ],
  };
}

function obsManifestFixture() {
  return {
    n_points: 3,
    fields: [
      { key: 'score', kind: 'continuous' },
      {
        key: 'cluster',
        kind: 'category',
        categories: ['A', 'B'],
      },
    ],
  };
}

function varManifestFixture(nGenes = 1) {
  return {
    n_points: 3,
    fields: Array.from(
      { length: nGenes },
      (_, index) => ({ key: `gene-${index + 1}` })
    ),
  };
}

function connectivityManifestFixture(nEdges = 2) {
  return {
    format: 'edge_pairs',
    n_cells: 3,
    n_edges: nEdges,
    max_neighbors: 2,
    index_dtype: 'uint32',
    index_bytes: 4,
  };
}

function bundleFixture(overrides = {}) {
  return {
    expectedIdentityId: 'exact-generation',
    identity: identityFixture(),
    obsManifest: obsManifestFixture(),
    varManifest: varManifestFixture(),
    connectivityManifest: connectivityManifestFixture(),
    ...overrides,
  };
}

function httpNotFound(filename) {
  return Object.assign(new Error(`${filename} returned 404`), {
    status: 404,
  });
}

test('validates one complete identity/manifest generation', () => {
  const bundle = bundleFixture();
  assert.deepEqual(validateDatasetGeneration(bundle), bundle);
});

test('requires exact observation summaries, order, categories, and cell count', async t => {
  await t.test('cell count', () => {
    const obsManifest = obsManifestFixture();
    obsManifest.n_points = 2;
    assert.throws(
      () => validateDatasetGeneration(bundleFixture({ obsManifest })),
      /obs_manifest\.json n_points.*stats\.n_cells/i
    );
  });

  await t.test('field order', () => {
    const obsManifest = obsManifestFixture();
    obsManifest.fields.reverse();
    assert.throws(
      () => validateDatasetGeneration(bundleFixture({ obsManifest })),
      /obs_fields.*obs_manifest\.json.*order/i
    );
  });

  await t.test('category count', () => {
    const obsManifest = obsManifestFixture();
    obsManifest.fields[1].categories.pop();
    assert.throws(
      () => validateDatasetGeneration(bundleFixture({ obsManifest })),
      /obs_manifest\.json.*n_categories/i
    );
  });
});

test('requires exact gene and connectivity generation summaries', async t => {
  await t.test('gene count', () => {
    assert.throws(
      () => validateDatasetGeneration(bundleFixture({
        varManifest: varManifestFixture(0),
      })),
      /stats\.n_genes.*var_manifest\.json/i
    );
  });

  await t.test('var cell count', () => {
    const varManifest = varManifestFixture();
    varManifest.n_points = 4;
    assert.throws(
      () => validateDatasetGeneration(bundleFixture({ varManifest })),
      /var_manifest\.json n_points.*stats\.n_cells/i
    );
  });

  await t.test('edge count', () => {
    assert.throws(
      () => validateDatasetGeneration(bundleFixture({
        connectivityManifest: connectivityManifestFixture(1),
      })),
      /stats\.n_edges.*connectivity_manifest\.json/i
    );
  });

  await t.test('connectivity cell count', () => {
    const connectivityManifest = connectivityManifestFixture();
    connectivityManifest.n_cells = 4;
    assert.throws(
      () => validateDatasetGeneration(bundleFixture({
        connectivityManifest,
      })),
      /connectivity_manifest\.json n_cells.*stats\.n_cells/i
    );
  });
});

test('identity-declared absence prevents optional artifact requests', async () => {
  const identity = identityFixture({
    nGenes: 0,
    hasConnectivity: false,
  });
  const calls = [];
  const result = await loadDatasetGeneration({
    signal: new AbortController().signal,
    expectedIdentityId: 'exact-generation',
    loadIdentity: async () => {
      calls.push('identity');
      return identity;
    },
    loadObsManifest: async () => {
      calls.push('obs');
      return obsManifestFixture();
    },
    loadVarManifest: async () => {
      calls.push('var');
      throw new Error('var manifest must not be requested');
    },
    loadConnectivityManifest: async () => {
      calls.push('connectivity');
      throw new Error('connectivity manifest must not be requested');
    },
  });

  assert.deepEqual(calls, ['identity', 'obs']);
  assert.equal(result.varManifest, null);
  assert.equal(result.connectivityManifest, null);
});

test('identity validation completes before any artifact request', async () => {
  const identity = identityFixture();
  identity.stats.n_genes = -1;
  const calls = [];

  await assert.rejects(
    loadDatasetGeneration({
      signal: new AbortController().signal,
      expectedIdentityId: 'exact-generation',
      loadIdentity: async () => {
        calls.push('identity');
        return identity;
      },
      loadObsManifest: async () => {
        calls.push('obs');
        return obsManifestFixture();
      },
      loadVarManifest: async () => {
        calls.push('var');
        return varManifestFixture();
      },
      loadConnectivityManifest: async () => {
        calls.push('connectivity');
        return connectivityManifestFixture();
      },
    }),
    /n_genes.*non-negative safe integer/i
  );
  assert.deepEqual(calls, ['identity']);
});

test('rejects missing identity or observation manifests unconditionally', async t => {
  for (const [label, key] of [
    ['dataset_identity.json', 'loadIdentity'],
    ['obs_manifest.json', 'loadObsManifest'],
  ]) {
    await t.test(label, async () => {
      const loaders = {
        signal: new AbortController().signal,
        expectedIdentityId: 'exact-generation',
        loadIdentity: async () => identityFixture(),
        loadObsManifest: async () => obsManifestFixture(),
        loadVarManifest: async () => varManifestFixture(),
        loadConnectivityManifest: async () =>
          connectivityManifestFixture(),
      };
      loaders[key] = async () => {
        throw httpNotFound(label);
      };
      await assert.rejects(
        loadDatasetGeneration(loaders),
        new RegExp(`missing required ${label.replace('.', '\\.')}`, 'i')
      );
    });
  }
});

test('rejects identity-declared var or connectivity data when its manifest is absent', async t => {
  await t.test('var manifest', async () => {
    await assert.rejects(
      loadDatasetGeneration({
        signal: new AbortController().signal,
        expectedIdentityId: 'exact-generation',
        loadIdentity: async () => identityFixture(),
        loadObsManifest: async () => obsManifestFixture(),
        loadVarManifest: async () => {
          throw httpNotFound('var_manifest.json');
        },
        loadConnectivityManifest: async () =>
          connectivityManifestFixture(),
      }),
      /missing required var_manifest\.json/i
    );
  });

  await t.test('connectivity manifest', async () => {
    await assert.rejects(
      loadDatasetGeneration({
        signal: new AbortController().signal,
        expectedIdentityId: 'exact-generation',
        loadIdentity: async () => identityFixture(),
        loadObsManifest: async () => obsManifestFixture(),
        loadVarManifest: async () => varManifestFixture(),
        loadConnectivityManifest: async () => {
          throw httpNotFound('connectivity_manifest.json');
        },
      }),
      /missing required connectivity_manifest\.json/i
    );
  });
});

test('rejects unexpected manifests when identity declares absence', () => {
  assert.throws(
    () => validateDatasetGeneration(bundleFixture({
      identity: identityFixture({
        nGenes: 0,
        hasConnectivity: false,
      }),
      varManifest: varManifestFixture(0),
      connectivityManifest: connectivityManifestFixture(0),
    })),
    /does not advertise connectivity.*connectivity_manifest\.json is present/i
  );
});

test('generation failure aborts and settles every sibling before rejecting', async () => {
  const originalFailure = new Error('observation generation rejected');
  const abortedSiblings = [];
  const waitForAbort = label => signal => new Promise((resolve, reject) => {
    assert.ok(signal instanceof AbortSignal);
    signal.addEventListener('abort', () => {
      abortedSiblings.push(label);
      reject(signal.reason);
    }, { once: true });
  });

  const pending = loadDatasetGeneration({
    signal: new AbortController().signal,
    expectedIdentityId: 'exact-generation',
    loadIdentity: async () => identityFixture(),
    loadObsManifest: async signal => {
      assert.ok(signal instanceof AbortSignal);
      await Promise.resolve();
      throw originalFailure;
    },
    loadVarManifest: waitForAbort('var'),
    loadConnectivityManifest: waitForAbort('connectivity'),
  });

  await assert.rejects(pending, error => error === originalFailure);
  assert.deepEqual(
    abortedSiblings.sort(),
    ['connectivity', 'var'],
    'the transaction must not reject while sibling metadata work continues'
  );
});

test('owner cancellation aborts and settles the complete generation', async () => {
  const owner = new AbortController();
  const reason = new Error('dataset selection superseded');
  const aborted = [];
  const started = new Set();
  let allSelectedStarted;
  const selectedStarted = new Promise(resolve => {
    allSelectedStarted = resolve;
  });
  const waitForAbort = label => signal => new Promise((resolve, reject) => {
    started.add(label);
    if (started.size === 3) allSelectedStarted();
    signal.addEventListener('abort', () => {
      aborted.push(label);
      reject(signal.reason);
    }, { once: true });
  });
  const pending = loadDatasetGeneration({
    signal: owner.signal,
    expectedIdentityId: 'exact-generation',
    loadIdentity: async () => identityFixture(),
    loadObsManifest: waitForAbort('obs'),
    loadVarManifest: waitForAbort('var'),
    loadConnectivityManifest: waitForAbort('connectivity'),
  });

  await selectedStarted;
  owner.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.deepEqual(
    aborted.sort(),
    ['connectivity', 'obs', 'var']
  );
});

test('owner cancellation remains terminal when selected loaders ignore abort', async () => {
  const owner = new AbortController();
  const reason = new Error('dataset selection superseded');
  let releaseSelected;
  const selectedReleased = new Promise(resolve => {
    releaseSelected = resolve;
  });
  let selectedCount = 0;
  let allSelectedStarted;
  const selectedStarted = new Promise(resolve => {
    allSelectedStarted = resolve;
  });
  const ignoreAbort = value => async () => {
    selectedCount++;
    if (selectedCount === 3) allSelectedStarted();
    await selectedReleased;
    return value;
  };
  const pending = loadDatasetGeneration({
    signal: owner.signal,
    expectedIdentityId: 'exact-generation',
    loadIdentity: async () => identityFixture(),
    loadObsManifest: ignoreAbort(obsManifestFixture()),
    loadVarManifest: ignoreAbort(varManifestFixture()),
    loadConnectivityManifest: ignoreAbort(connectivityManifestFixture()),
  });

  await selectedStarted;
  owner.abort(reason);
  releaseSelected();
  await assert.rejects(pending, error => error === reason);
});

test('rejects extra loader API keys and non-function loaders', async () => {
  const loaders = {
    signal: new AbortController().signal,
    expectedIdentityId: 'exact-generation',
    loadIdentity: async () => identityFixture(),
    loadObsManifest: async () => obsManifestFixture(),
    loadVarManifest: async () => varManifestFixture(),
    loadConnectivityManifest: async () => connectivityManifestFixture(),
  };
  await assert.rejects(
    loadDatasetGeneration({ ...loaders, legacyFallback: true }),
    /generation loaders.*unexpected key.*legacyFallback/i
  );
  await assert.rejects(
    loadDatasetGeneration({ ...loaders, loadVarManifest: null }),
    /loadVarManifest must be a function/i
  );
  await assert.rejects(
    loadDatasetGeneration({ ...loaders, signal: null }),
    /signal must be an AbortSignal/i
  );
});

test('rejects a coherent foreign identity against the selected identity id', () => {
  assert.throws(
    () => validateDatasetGeneration(bundleFixture({
      expectedIdentityId: 'selected-generation',
    })),
    /id 'exact-generation'.*does not match catalog id 'selected-generation'/i
  );
});

test('bootstrap and reload share one complete staged generation before publication', async () => {
  const mainSource = await readFile(
    new URL('../assets/js/app/main.js', import.meta.url),
    'utf8'
  );
  assert.equal(
    mainSource.match(/await loadDatasetGeneration\(\{/g)?.length,
    1
  );
  assert.doesNotMatch(
    mainSource,
    /loadObsManifestStrict|using empty obs|varManifestPromise.*\.catch|connPromise.*\.catch/
  );

  const stageStart = mainSource.indexOf(
    'async function stageDatasetRuntime'
  );
  const commitStart = mainSource.indexOf(
    'function commitDatasetRuntimeStage'
  );
  const uiSyncStart = mainSource.indexOf(
    'function synchronizePublishedDatasetUi'
  );
  const initialStart = mainSource.indexOf(
    'if (hasInitialDataset) {',
    commitStart
  );
  const reloadStart = mainSource.indexOf(
    'async function reloadActiveDatasetInPlace'
  );
  assert.ok(
    stageStart >= 0 &&
    commitStart > stageStart &&
    uiSyncStart > commitStart &&
    initialStart > uiSyncStart &&
    reloadStart > initialStart
  );

  const stageSource = mainSource.slice(stageStart, commitStart);
  assert.ok(
    stageSource.indexOf('await loadDatasetGeneration({') <
      stageSource.indexOf('await stageDatasetPositionPayload({')
  );
  assert.match(
    stageSource,
    /createDimensionManager\(\{[\s\S]*baseUrl,[\s\S]*candidateAnnDataBinding,[\s\S]*stagedSource[\s\S]*\}\)/
  );
  assert.equal(
    stageSource.match(/candidateAnnDataBinding,/g)?.length,
    6,
    'one staged AnnData binding argument must own the dimension manager and all four generation readers'
  );
  assert.equal(
    stageSource.match(/stagedSource/g)?.length,
    6,
    'one staged custom source must own the stage argument, dimension manager, and all four generation readers'
  );
  assert.doesNotMatch(
    stageSource,
    /state\.(?:setDimensionManager|setFieldLoader|setVarFieldLoader|initVarData|initScene|setVectorFieldManager)/
  );

  const commitSource = mainSource.slice(commitStart, uiSyncStart);
  assert.match(commitSource, /state\.setDimensionManager\(dimensionManager\)/);
  assert.match(commitSource, /state\.setFieldLoader\(stage\.fieldLoader\)/);
  assert.match(commitSource, /state\.setVarFieldLoader\(stage\.varFieldLoader\)/);
  assert.match(commitSource, /state\.initScene\(positions, obs\)/);
  assert.match(
    commitSource,
    /state\.setVectorFieldManager\(stage\.vectorFieldManager\)/
  );
  assert.doesNotMatch(
    commitSource,
    /refreshDatasetUI|resetForDatasetReload|catch\s*\{/
  );

  const initialSource = mainSource.slice(initialStart, reloadStart);
  assert.ok(
    initialSource.indexOf('getCurrentIdentityId()') <
      initialSource.indexOf('await stageDatasetRuntime({')
  );
  assert.ok(
    initialSource.indexOf('await stageDatasetRuntime({') <
      initialSource.indexOf(
        'commitDatasetRuntimeStage(initialStage)'
      )
  );

  const reloadEnd = mainSource.indexOf(
    '// One-time helper to rebuild density',
    reloadStart
  );
  assert.ok(reloadEnd > reloadStart);
  const reloadSource = mainSource.slice(reloadStart, reloadEnd);
  const selectionStageIndex = reloadSource.indexOf(
    'selectionStage = await dataSourceManager.stageDatasetSelection('
  );
  const runtimeStageIndex = reloadSource.indexOf(
    'runtimeStage = await stageDatasetRuntime({'
  );
  const ownerCheckIndex = reloadSource.indexOf(
    'reloadTransaction.assertCurrent()',
    runtimeStageIndex
  );
  const runtimeCommitIndex = reloadSource.indexOf(
    'commitDatasetRuntimeStage(runtimeStage)'
  );
  assert.ok(
    selectionStageIndex >= 0 &&
    runtimeStageIndex > selectionStageIndex &&
    ownerCheckIndex > runtimeStageIndex &&
    runtimeCommitIndex > ownerCheckIndex
  );
  assert.match(
    reloadSource.slice(runtimeStageIndex, ownerCheckIndex),
    /expectedIdentityId:\s*selectionStage\.identityId/
  );
});
