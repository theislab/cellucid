import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  loadDatasetGeneration,
  validateCentroidEmbeddings,
  validateDatasetGeneration,
} from '../assets/js/data/dataset-generation-contract.js';

function identityFixture({
  nGenes = 1,
  hasConnectivity = true,
  nEdges = 2,
} = {}) {
  return {
    version: 3,
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
      default_dimension: 3,
      defaults: { '2d': 'X_umap', '3d': 'X_umap_3d' },
      items: {
        X_pca: {
          label: 'PCA',
          dimension: 2,
          file: 'embeddings/0_2d.bin',
          source: { key: 'X_pca', columns: [0, 1] },
        },
        X_umap: {
          label: 'UMAP',
          dimension: 2,
          file: 'embeddings/1_2d.bin',
          source: { key: 'X_umap', columns: [0, 1] },
        },
        X_umap_3d: {
          label: 'X_umap_3d',
          dimension: 3,
          file: 'embeddings/2_3d.bin',
          source: { key: null, columns: [0, 1, 2] },
        },
      },
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
        // Keyed by embedding id: a subset of the identity's items, each
        // position measured on that item's own coordinates.
        centroidsByEmbedding: {
          X_pca: [{ category: 'A', position: [0.5, -0.5], n_points: 2 }],
          X_umap: [
            { category: 'A', position: [0, 0], n_points: 2 },
            { category: 'B', position: [1, 1], n_points: 1 },
          ],
          X_umap_3d: [{ category: 'B', position: [1, 1, 1], n_points: 1 }],
        },
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

test('categorical centroids are keyed by declared embeddings of the matching dimension', async t => {
  await t.test('every declared item, or a subset of them, is accepted', () => {
    const obsManifest = obsManifestFixture();
    delete obsManifest.fields[1].centroidsByEmbedding.X_pca;
    assert.doesNotThrow(
      () => validateDatasetGeneration(bundleFixture({ obsManifest }))
    );
    obsManifest.fields[1].centroidsByEmbedding = {};
    assert.doesNotThrow(
      () => validateDatasetGeneration(bundleFixture({ obsManifest }))
    );
  });

  await t.test('an embedding the identity does not declare', () => {
    const obsManifest = obsManifestFixture();
    obsManifest.fields[1].centroidsByEmbedding.X_tsne = [];
    assert.throws(
      () => validateDatasetGeneration(bundleFixture({ obsManifest })),
      /field "cluster" has centroids for embedding "X_tsne", which dataset_identity\.json does not declare/
    );
  });

  await t.test('a dimension key is not an embedding id', () => {
    const obsManifest = obsManifestFixture();
    obsManifest.fields[1].centroidsByEmbedding = {
      2: [{ category: 'A', position: [0, 0], n_points: 2 }],
    };
    assert.throws(
      () => validateDatasetGeneration(bundleFixture({ obsManifest })),
      /centroids for embedding "2", which dataset_identity\.json does not declare/
    );
  });

  await t.test('a position of another embedding\'s dimension', () => {
    for (const [embeddingId, position, dimension] of [
      ['X_umap', [0, 0, 0], 2],
      ['X_pca', [0], 2],
      ['X_umap_3d', [1, 1], 3],
    ]) {
      const obsManifest = obsManifestFixture();
      obsManifest.fields[1].centroidsByEmbedding[embeddingId] = [
        { category: 'A', position, n_points: 1 },
      ];
      assert.throws(
        () => validateDatasetGeneration(bundleFixture({ obsManifest })),
        new RegExp(
          `centroids for "${embeddingId}" must have ${dimension} coordinates`
        )
      );
    }
  });

  await t.test('the rule is exported for the local folder reader', () => {
    const identity = identityFixture();
    const obsManifest = obsManifestFixture();
    assert.equal(validateCentroidEmbeddings(identity, obsManifest), undefined);
    obsManifest.fields[1].centroidsByEmbedding.X_missing = [];
    assert.throws(
      () => validateCentroidEmbeddings(identity, obsManifest),
      /"X_missing", which dataset_identity\.json does not declare/
    );
  });
});

test('a version-2 identity is not a generation', () => {
  const identity = identityFixture();
  identity.version = 2;
  identity.embeddings = {
    available_dimensions: [2],
    default_dimension: 2,
    files: { '2d': 'points_2d.bin' },
  };
  assert.throws(
    () => validateDatasetGeneration(bundleFixture({ identity })),
    /Unsupported dataset_identity\.json version: 2/
  );
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

test('startup and every reload share one complete staged generation before publication', async () => {
  const mainSource = await readFile(
    new URL('../assets/js/app/main.js', import.meta.url),
    'utf8'
  );
  // The one generation load runs as the startup owner's identity step, which
  // bounds it with the startup deadline; a reload passes its own signal.
  assert.equal(
    mainSource.match(/loadDatasetGeneration\(\{/g)?.length,
    1
  );
  assert.match(
    mainSource,
    /await phases\.step\(\s*'identity',\s*getDatasetIdentityUrl\(baseUrl\),\s*stepSignal => loadDatasetGeneration\(\{/
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
  const reloadStart = mainSource.indexOf(
    'async function reloadActiveDatasetInPlace'
  );
  assert.ok(
    stageStart >= 0 &&
    commitStart > stageStart &&
    uiSyncStart > commitStart &&
    reloadStart > uiSyncStart
  );
  // Startup has no staging path of its own: the startup selection is loaded
  // through the reload, as the first ordinary dataset change.
  assert.equal(
    mainSource.match(/await stageDatasetRuntime\(\{/g)?.length,
    1
  );
  assert.equal(
    mainSource.match(/commitDatasetRuntimeStage\(runtimeStage\)/g)?.length,
    1
  );
  assert.match(
    mainSource,
    /startupOutcome = await ui\.loadStartupDataset\(startupSelection\);/
  );

  const stageSource = mainSource.slice(stageStart, commitStart);
  assert.ok(
    stageSource.indexOf('loadDatasetGeneration({') <
      stageSource.indexOf('await stageDatasetPositionPayload({')
  );
  assert.match(
    stageSource,
    /createDimensionManager\(\{[\s\S]*baseUrl,[\s\S]*candidateAnnDataBinding,[\s\S]*stagedSource[\s\S]*\}\)/
  );
  assert.equal(
    stageSource.match(/candidateAnnDataBinding,/g)?.length,
    7,
    'one staged AnnData binding argument must own the dimension manager, ' +
    'all four generation readers, and the data-mapping resolution'
  );
  assert.equal(
    stageSource.match(/stagedSource/g)?.length,
    7,
    'one staged custom source must own the stage argument, dimension ' +
    'manager, all four generation readers, and the data-mapping resolution'
  );
  // The data mapping is resolved from the staged generation, before any
  // position is staged, and published only by the commit.
  const mappingIndex = stageSource.indexOf(
    'await resolveStagedDataMapping({'
  );
  assert.ok(
    mappingIndex > stageSource.indexOf('loadDatasetGeneration({') &&
    mappingIndex < stageSource.indexOf('await stageDatasetPositionPayload({')
  );
  assert.match(
    stageSource.slice(mappingIndex),
    /^await resolveStagedDataMapping\(\{\s*baseUrl,\s*candidateAnnDataBinding,\s*datasetSource,\s*generation,\s*signal,\s*stagedSource\s*\}\)/
  );
  // The mapping is asked of the source the dataset is staged from, never of
  // the source on screen: a newer choice stages while the shown dataset's
  // source may already be disconnected.
  const resolveStart = mainSource.indexOf('async function resolveStagedDataMapping');
  const resolveSource = mainSource.slice(resolveStart, stageStart);
  assert.ok(resolveStart >= 0 && resolveStart < stageStart);
  assert.doesNotMatch(resolveSource, /getCurrentSourceType|getSource\(/);
  assert.match(resolveSource, /datasetSource\.servesAnnData\(\) === true/);
  // Every AnnData source -- a file read in the browser, or an object a Python
  // server serves -- can plot any obsm array on request, so its candidate
  // manager gets the catalog's layout provider, after the metadata (which
  // resets the provider) is installed. A prepared export has no catalog.
  assert.match(
    stageSource,
    /initFromMetadata\(embeddingsMetadata\);[\s\S]*?if \(mapping\.candidates !== null\) \{\s*candidateDimensionManager\.setLayoutProvider\(\s*createMappingLayoutProvider\(mapping\.candidates\)\s*\);\s*\}/
  );
  // The vector manager takes the vector fields the staged mapping uses,
  // resolved from the whole version-3 identity (never a bare vector_fields
  // block), the staged mapping and its candidates, against the staged
  // dimension manager it is then built with.
  assert.match(
    stageSource,
    /createVectorFieldManager\(\{\s*baseUrl,\s*vectorFields: resolveVectorFields\(\{\s*identity: generation\.identity,\s*mapping: mapping\.mapping,\s*candidates: mapping\.candidates,\s*dimensionManager: candidateDimensionManager\s*\}\),\s*dimensionManager: candidateDimensionManager\s*\}\)/
  );
  assert.doesNotMatch(stageSource, /vectorFieldsMetadata/);
  assert.doesNotMatch(
    stageSource,
    /state\.(?:setDimensionManager|setFieldLoader|setVarFieldLoader|initVarData|initScene|setVectorFieldManager|publishDatasetMapping)/
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
  assert.match(commitSource, /state\.publishDatasetMapping\(stage\.mapping\)/);
  assert.doesNotMatch(
    commitSource,
    /refreshDatasetUI|resetForDatasetReload|catch\s*\{/
  );

  const reloadEnd = mainSource.indexOf(
    '// One-time helper to rebuild density',
    reloadStart
  );
  assert.ok(reloadEnd > reloadStart);
  const reloadSource = mainSource.slice(reloadStart, reloadEnd);
  const selectionStageIndex = reloadSource.indexOf(
    'dataSourceManager.stageDatasetSelection('
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
  assert.match(
    reloadSource.slice(runtimeStageIndex, ownerCheckIndex),
    /datasetSource: source \?\? dataSourceManager\.getSource\(sourceType\)/
  );
});
