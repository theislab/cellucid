import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  loadConnectivitySummary,
  loadDatasetIdentity,
  loadEdges,
  loadObsFields,
  loadGeneList,
} from '../assets/js/data/data-loaders.js';
import { validateConnectivitySummary } from '../assets/js/data/connectivity-summary-contract.js';
import {
  getDataSourceManager,
} from '../assets/js/data/data-source-manager.js';
import { H5adDataSource } from '../assets/js/data/h5ad.js';
import { ZarrDataSource } from '../assets/js/data/zarr.js';
import { connectivityEdgesFromPairs, edgeWeightsFrom, edgeWeightsOf, edgeListOf } from './helpers/connectivity-edges.mjs';

const DIRECT_SUMMARY = Object.freeze({
  n_cells: 3,
  n_edges: 2,
  max_neighbors: 2,
});
const EDGE_SIGNAL = new AbortController().signal;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function withJsonResponse(value, callback, status = 200) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(String(url));
    return new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    return await callback(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function withDirectSource({
  id = 'connectivity-contract',
  protocol = 'h5ad',
  summaryMethod = async () => DIRECT_SUMMARY,
  omitSummaryMethod = false,
  adapterMethods = {},
  edgeMethod = async () => connectivityEdgesFromPairs([0, 1], [1, 2], 3, [1, 2]),
}, callback) {
  const manager = getDataSourceManager();
  const previous = {
    activeSource: manager.activeSource,
    activeDatasetId: manager.activeDatasetId,
    activeDatasetMetadata: manager.activeDatasetMetadata,
  };
  const adapter = {
    ...adapterMethods,
    getConnectivityEdges: edgeMethod,
  };
  const source = {
    datasetId: id,
    getType: () => protocol,
    getAdapter: () => adapter,
  };
  if (!omitSummaryMethod) {
    source.getConnectivitySummary = summaryMethod;
  }
  manager.activeSource = source;
  manager.activeDatasetId = id;
  manager.activeDatasetMetadata = { id };

  try {
    return await callback(`${protocol}://${id}/obsp`);
  } finally {
    manager.activeSource = previous.activeSource;
    manager.activeDatasetId = previous.activeDatasetId;
    manager.activeDatasetMetadata = previous.activeDatasetMetadata;
  }
}

test('connectivity summaries preserve an explicit empty graph exactly', () => {
  const directEmpty = {
    ...DIRECT_SUMMARY,
    n_edges: 0,
    max_neighbors: 0,
  };
  assert.strictEqual(validateConnectivitySummary(directEmpty), directEmpty);
  assert.equal(validateConnectivitySummary(null), null);
  assert.throws(
    () => validateConnectivitySummary({ ...DIRECT_SUMMARY, max_neighbors: 0 }),
    /max_neighbors.*edge bounds/i
  );
  assert.throws(
    () => validateConnectivitySummary({ ...directEmpty, max_neighbors: 1 }),
    /max_neighbors.*edge bounds/i
  );
  const deferredSummary = { ...DIRECT_SUMMARY, n_edges: null, max_neighbors: null };
  assert.strictEqual(validateConnectivitySummary(deferredSummary), deferredSummary);
});

test('a summary holds exactly the graph members', () => {
  assert.throws(
    () => validateConnectivitySummary({ ...DIRECT_SUMMARY, sourcesPath: 'obsp/0' }),
    /unexpected sourcesPath/i
  );
  assert.throws(
    () => validateConnectivitySummary({ n_cells: 3, n_edges: 2 }),
    /missing max_neighbors/i
  );
  assert.throws(
    () => validateConnectivitySummary({ ...DIRECT_SUMMARY, n_cells: 2 ** 32 + 1 }),
    /uint32 cell axis/
  );
  assert.throws(() => validateConnectivitySummary(false), /expected an object/i);
});

test('no fixed working-set cap refuses a large graph: a k = 15 graph over 10M and 50M cells validates', () => {
  // A k = 15 neighbour graph has about 11 undirected edges a cell. The
  // summary is checked for consistency only; memory is the engine's to
  // grant when the edges load (a refusal there is a connectivity error, never
  // a failed dataset).
  for (const nCells of [10_000_000, 50_000_000]) {
    const summary = {
      ...DIRECT_SUMMARY,
      n_cells: nCells,
      n_edges: nCells * 11,
      max_neighbors: 40,
    };
    assert.strictEqual(validateConnectivitySummary(summary), summary);
  }
  const source = readFileSync(
    new URL('../assets/js/data/connectivity-summary-contract.js', import.meta.url),
    'utf8'
  );
  assert.doesNotMatch(source, /MAX_CONNECTIVITY_WORKING_BYTES|working-set limit/);
});

test('direct connectivity absence is exact and method-owned', async t => {
  await t.test('accepts the exact direct summary', async () => {
    await withDirectSource({}, async url => {
      assert.deepEqual(
        await loadConnectivitySummary(url),
        DIRECT_SUMMARY
      );
    });
  });

  await t.test('a present method may return exact null absence', async () => {
    await withDirectSource({
      summaryMethod: async () => null,
    }, async url => {
      assert.equal(await loadConnectivitySummary(url), null);
    });
  });

  await t.test('an explicitly empty direct graph stays present', async () => {
    const summary = {
      ...DIRECT_SUMMARY,
      n_edges: 0,
      max_neighbors: 0,
    };
    await withDirectSource({
      summaryMethod: async () => summary,
      edgeMethod: async () => connectivityEdgesFromPairs([], [], 3),
    }, async url => {
      assert.strictEqual(
        await loadConnectivitySummary(url),
        summary
      );
      const edges = await loadEdges(
        url,
        summary,
        { signal: EDGE_SIGNAL }
      );
      assert.equal(edges.nEdges, 0);
      assert.deepEqual(Array.from(edgeListOf(edges).sources), []);
      assert.deepEqual(Array.from(edgeListOf(edges).destinations), []);
      assert.deepEqual(edgeWeightsOf(edges), edgeWeightsFrom([]));
    });
  });

  await t.test('a missing method is a contract error', async () => {
    await withDirectSource({
      omitSummaryMethod: true,
    }, async url => {
      await assert.rejects(
        loadConnectivitySummary(url),
        /required.*getConnectivitySummary/i
      );
    });
  });

  for (const value of [undefined, false, 0, '', Number.NaN]) {
    await t.test(`falsy ${String(value)} is not absence`, async () => {
      await withDirectSource({
        summaryMethod: async () => value,
      }, async url => {
        await assert.rejects(
          loadConnectivitySummary(url),
          /exact null|invalid direct connectivity summary/i
        );
      });
    });
  }

  await t.test('a summary with other members is refused', async () => {
    await withDirectSource({
      summaryMethod: async () => ({ ...DIRECT_SUMMARY, sourcesPath: 'obsp/0' }),
    }, async url => {
      await assert.rejects(
        loadConnectivitySummary(url),
        /unexpected.*sourcesPath/i
      );
    });
  });
});

test('direct edge payloads must exactly match their adopted summary', async t => {
  // The edges themselves (bounds, order, uniqueness, symmetry, weights, the
  // largest degree) are checked where the reader worker builds them
  // (connectivity-extraction-contract); the page checks the payload's shape
  // and counts against the summary.
  const validEdgeData = () => connectivityEdgesFromPairs([0, 1], [1, 2], 3, [1, 2]);
  const invalidCases = [
    {
      name: 'null payload contradicts a present summary',
      edgeData: null,
      error: /absent despite its summary/i,
    },
    {
      name: 'falsy payload is malformed',
      edgeData: false,
      error: /edge payload.*object/i,
    },
    {
      name: 'unknown payload properties',
      edgeData: { ...validEdgeData(), extra: true },
      error: /unexpected extra|exact properties/i,
    },
    {
      name: 'wrong record array type',
      edgeData: {
        ...validEdgeData(),
        records: Float32Array.from({ length: 6 }),
      },
      error: /must be Uint32Array/i,
    },
    {
      name: 'records of another edge count',
      edgeData: {
        ...validEdgeData(),
        records: new Uint32Array(3),
      },
      error: /array lengths.*n_edges/i,
    },
    {
      name: 'neighbours of another edge count',
      edgeData: {
        ...validEdgeData(),
        neighbors: new Uint32Array(2),
      },
      error: /array lengths.*n_edges/i,
    },
    {
      name: 'offsets over other cells',
      edgeData: {
        ...validEdgeData(),
        forwardOffsets: Uint32Array.from([0, 1, 2]),
      },
      error: /n_cells \+ 1/i,
    },
    {
      name: 'cell summary mismatch',
      edgeData: { ...validEdgeData(), nCells: 4 },
      error: /counts must exactly match the graph summary/i,
    },
    {
      name: 'edge summary mismatch',
      edgeData: { ...validEdgeData(), nEdges: 1 },
      error: /counts must exactly match the graph summary/i,
    },
    {
      name: 'neighbor summary mismatch',
      edgeData: { ...validEdgeData(), maxNeighbors: 1 },
      error: /counts must exactly match the graph summary/i,
    },
    {
      name: 'a weightless payload of edges',
      edgeData: { ...validEdgeData(), maxWeight: 0 },
      error: /counts must exactly match the graph summary/i,
    },
  ];

  for (const fixture of invalidCases) {
    await t.test(fixture.name, async () => {
      await withDirectSource({
        edgeMethod: async () => fixture.edgeData,
      }, async url => {
        await assert.rejects(
          loadEdges(
            url,
            DIRECT_SUMMARY,
            { signal: EDGE_SIGNAL }
          ),
          fixture.error
        );
      });
    });
  }
});

test('edge dispatch revalidates the summary for the explicit URL protocol', async () => {
  let edgeCalls = 0;
  await withDirectSource({
    edgeMethod: async () => {
      edgeCalls++;
      return connectivityEdgesFromPairs([0, 1], [1, 2], 3, [1, 2]);
    },
  }, async url => {
    await assert.rejects(
      loadEdges(
        url,
        {
          ...DIRECT_SUMMARY,
          sourcesPath: 'obsp/0',
        },
        { signal: EDGE_SIGNAL }
      ),
      /unexpected.*sourcesPath/i
    );
    assert.equal(edgeCalls, 0, 'invalid metadata must fail before payload work');

    const edges = await loadEdges(
      url,
      DIRECT_SUMMARY,
      { signal: EDGE_SIGNAL }
    );
    assert.equal(edgeCalls, 1);
    assert.deepEqual(Array.from(edgeListOf(edges).sources), [0, 1]);
    assert.deepEqual(Array.from(edgeListOf(edges).destinations), [1, 2]);
    assert.deepEqual(edgeWeightsOf(edges), edgeWeightsFrom([1, 2]));
    assert.equal(edges.nCells, 3);
    assert.equal(edges.nEdges, 2);
    assert.equal(edges.maxNeighbors, 2);
  });
});

test('H5AD and Zarr summary access is metadata-only', async t => {
  for (const [label, SourceClass] of [
    ['H5AD', H5adDataSource],
    ['Zarr', ZarrDataSource],
  ]) {
    await t.test(label, async () => {
      const source = new SourceClass();
      let summaryReads = 0;
      let edgeMaterializations = 0;
      const immutableSummary = Object.freeze({ ...DIRECT_SUMMARY });
      source._adapter = {
        getConnectivitySummary() {
          summaryReads++;
          return immutableSummary;
        },
        getConnectivityEdges() {
          edgeMaterializations++;
          throw new Error('summary access must not materialize edges');
        },
      };

      assert.strictEqual(
        await source.getConnectivitySummary(),
        immutableSummary
      );
      assert.equal(summaryReads, 1);
      assert.equal(edgeMaterializations, 0);

      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        source.getConnectivitySummary({ signal: controller.signal }),
        error => error?.name === 'AbortError'
      );
      assert.equal(summaryReads, 1);
      assert.equal(edgeMaterializations, 0);
    });
  }
});

test('all four public metadata loaders refuse a pre-aborted owner before reading', async t => {
  const loaders = [
    ['identity', loadDatasetIdentity, ''],
    ['obs field list', loadObsFields, 'obs'],
    ['gene list', loadGeneList, 'var'],
    ['connectivity summary', loadConnectivitySummary, 'obsp'],
  ];
  for (const [label, loader, route] of loaders) {
    await t.test(label, async () => {
      let reads = 0;
      await withDirectSource({
        summaryMethod: async () => {
          reads++;
          return DIRECT_SUMMARY;
        },
      }, async url => {
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(
          loader(url.replace(/obsp$/, route), { signal: controller.signal }),
          error => error?.name === 'AbortError'
        );
      });
      assert.equal(reads, 0);
    });
  }

  await t.test('a non-AnnData URL is refused', async () => {
    await assert.rejects(
      loadDatasetIdentity('https://cellucid.test/'),
      /h5ad:\/\/ or zarr:\/\/ URL/
    );
  });

  await t.test('options reject unknown keys and non-signals', async () => {
    await assert.rejects(
      loadDatasetIdentity(
        'h5ad://dataset/',
        { legacySignal: null }
      ),
      /unexpected key.*legacySignal/i
    );
    await assert.rejects(
      loadConnectivitySummary(
        'h5ad://dataset/obsp',
        { signal: false }
      ),
      /AbortSignal or exact null/i
    );
  });
});

test('direct connectivity metadata receives the exact owner signal', async () => {
  const started = deferred();
  const controller = new AbortController();
  let receivedSignal = null;
  await withDirectSource({
    summaryMethod: ({ signal }) => {
      receivedSignal = signal;
      started.resolve();
      return new Promise(() => {});
    },
  }, async url => {
    const loading = loadConnectivitySummary(
      url,
      { signal: controller.signal }
    );
    await started.promise;
    assert.strictEqual(receivedSignal, controller.signal);
    controller.abort();
    await assert.rejects(
      loading,
      error => error?.name === 'AbortError'
    );
  });
});

test('connectivity edge loading requires and propagates one exact owner signal', async t => {
  await t.test('required options contract', async () => {
    await assert.rejects(
      loadEdges(
        'h5ad://dataset/obsp',
        DIRECT_SUMMARY
      ),
      /options must be an object/i
    );
    await assert.rejects(
      loadEdges(
        'h5ad://dataset/obsp',
        DIRECT_SUMMARY,
        {}
      ),
      /options\.signal is required/i
    );
    await assert.rejects(
      loadEdges(
        'h5ad://dataset/obsp',
        DIRECT_SUMMARY,
        { signal: EDGE_SIGNAL, legacyAbort: true }
      ),
      /unexpected key.*legacyAbort/i
    );
  });

  await t.test('pre-aborted owner prevents direct payload work', async () => {
    let edgeCalls = 0;
    await withDirectSource({
      edgeMethod: async () => {
        edgeCalls++;
        throw new Error('pre-aborted edge load must not reach the adapter');
      },
    }, async url => {
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        loadEdges(
          url,
          DIRECT_SUMMARY,
          { signal: controller.signal }
        ),
        error => error?.name === 'AbortError'
      );
      assert.equal(edgeCalls, 0);
    });
  });

  await t.test('direct in-flight payload observes owner abort', async () => {
    const started = deferred();
    const controller = new AbortController();
    let receivedSignal = null;
    await withDirectSource({
      edgeMethod: ({ signal }) => {
        receivedSignal = signal;
        started.resolve();
        return new Promise(() => {});
      },
    }, async url => {
      const loading = loadEdges(
        url,
        DIRECT_SUMMARY,
        { signal: controller.signal }
      );
      await started.promise;
      assert.strictEqual(receivedSignal, controller.signal);
      controller.abort();
      await assert.rejects(
        loading,
        error => error?.name === 'AbortError'
      );
    });
  });
});
