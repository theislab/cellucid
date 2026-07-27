import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import {
  loadConnectivityManifest,
  loadDatasetIdentity,
  loadEdges,
  loadObsManifest,
  loadVarManifest,
} from '../assets/js/data/data-loaders.js';
import {
  CONNECTIVITY_MANIFEST_CONTEXT,
  getConnectivityIndexStorage,
  validateConnectivityManifest,
} from '../assets/js/data/connectivity-manifest-contract.js';
import {
  getDataSourceManager,
} from '../assets/js/data/data-source-manager.js';
import {
  resolveUrl,
} from '../assets/js/data/data-source.js';
import { H5adDataSource } from '../assets/js/data/h5ad.js';
import { ZarrDataSource } from '../assets/js/data/zarr.js';

const FILE_MANIFEST = Object.freeze({
  format: 'edge_pairs',
  n_cells: 3,
  n_edges: 2,
  max_neighbors: 2,
  index_bytes: 2,
  index_dtype: 'uint16',
  sourcesPath: 'connectivity/edges.src.bin',
  destinationsPath: 'connectivity/edges.dst.bin',
  weightsPath: 'connectivity/edges.weights.f64.bin',
  weight_bytes: 8,
  weight_dtype: 'float64',
  compression: null,
});

const DIRECT_MANIFEST = Object.freeze({
  format: 'edge_pairs',
  n_cells: 3,
  n_edges: 2,
  max_neighbors: 2,
  index_bytes: 4,
  index_dtype: 'uint32',
});
const EDGE_SIGNAL = new AbortController().signal;

test('artifact URLs use one exact URL-resolution contract', () => {
  assert.equal(
    resolveUrl(
      'https://cellucid.test/data/connectivity_manifest.json',
      'connectivity/edges.src.bin'
    ),
    'https://cellucid.test/data/connectivity/edges.src.bin'
  );
  assert.equal(
    resolveUrl(
      'local-user://dataset-id/obs_manifest.json',
      'obs/cluster.codes.u8'
    ),
    'local-user://dataset-id/obs/cluster.codes.u8'
  );
  assert.throws(
    () => resolveUrl('not an absolute URL', 'connectivity/edges.src.bin'),
    /invalid url/i
  );
  assert.throws(
    () => resolveUrl(
      'https://cellucid.test/data/',
      /** @type {any} */ (null)
    ),
    /relative.*non-empty string/i
  );
});

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
  manifestMethod = async () => DIRECT_MANIFEST,
  omitManifestMethod = false,
  adapterMethods = {},
  edgeMethod = async () => ({
    sources: Uint32Array.from([0, 1]),
    destinations: Uint32Array.from([1, 2]),
    weights: Float64Array.from([1, 2]),
    nCells: 3,
    nEdges: 2,
    maxNeighbors: 2,
  }),
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
  if (!omitManifestMethod) {
    source.getConnectivityManifest = manifestMethod;
  }
  manager.activeSource = source;
  manager.activeDatasetId = id;
  manager.activeDatasetMetadata = { id };

  try {
    return await callback(`${protocol}://${id}/connectivity_manifest.json`);
  } finally {
    manager.activeSource = previous.activeSource;
    manager.activeDatasetId = previous.activeDatasetId;
    manager.activeDatasetMetadata = previous.activeDatasetMetadata;
  }
}

function typedArrayBody(values) {
  return values.buffer.slice(
    values.byteOffset,
    values.byteOffset + values.byteLength
  );
}

async function withBinaryResponses(responses, callback) {
  const originalFetch = globalThis.fetch;
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const originalWindow = globalThis.window;
  if (!hadWindow) {
    globalThis.window = {
      location: { href: 'https://cellucid.test/' },
    };
  }
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    calls.push({ url: href, signal: init?.signal ?? null });
    if (!responses.has(href)) {
      throw new Error(`Unexpected connectivity fetch: ${href}`);
    }
    const body = responses.get(href);
    return new Response(
      ArrayBuffer.isView(body) ? typedArrayBody(body) : body,
      { status: 200 }
    );
  };
  try {
    return await callback(calls);
  } finally {
    globalThis.fetch = originalFetch;
    if (hadWindow) {
      globalThis.window = originalWindow;
    } else {
      delete globalThis.window;
    }
  }
}

test('connectivity index storage uses exact zero-based cell capacity', () => {
  for (const nCells of [65_535, 65_536]) {
    assert.deepEqual(getConnectivityIndexStorage(nCells), {
      dtype: 'uint16',
      bytes: 2,
    });
  }
  assert.deepEqual(getConnectivityIndexStorage(65_537), {
    dtype: 'uint32',
    bytes: 4,
  });
  assert.deepEqual(getConnectivityIndexStorage(0x1_0000_0000), {
    dtype: 'uint32',
    bytes: 4,
  });
  for (const invalid of [
    0,
    -1,
    1.5,
    Number.NaN,
    0x1_0000_0001,
  ]) {
    assert.throws(
      () => getConnectivityIndexStorage(invalid),
      /n_cells.*uint32 cell axis/i
    );
  }
});

test('connectivity summaries preserve an explicit empty graph exactly', () => {
  const fileEmpty = {
    ...FILE_MANIFEST,
    n_edges: 0,
    max_neighbors: 0,
  };
  const directEmpty = {
    ...DIRECT_MANIFEST,
    n_edges: 0,
    max_neighbors: 0,
  };
  assert.strictEqual(
    validateConnectivityManifest(
      fileEmpty,
      CONNECTIVITY_MANIFEST_CONTEXT.FILE
    ),
    fileEmpty
  );
  assert.strictEqual(
    validateConnectivityManifest(
      directEmpty,
      CONNECTIVITY_MANIFEST_CONTEXT.DIRECT
    ),
    directEmpty
  );
  assert.throws(
    () => validateConnectivityManifest(
      { ...FILE_MANIFEST, max_neighbors: 0 },
      CONNECTIVITY_MANIFEST_CONTEXT.FILE
    ),
    /max_neighbors.*edge bounds/i
  );
  assert.throws(
    () => validateConnectivityManifest(
      { ...fileEmpty, max_neighbors: 1 },
      CONNECTIVITY_MANIFEST_CONTEXT.FILE
    ),
    /max_neighbors.*edge bounds/i
  );
});

test('connectivity capacity includes canonical and render-owned weighted edges', async t => {
  const browserLimit = 512 * 1024 * 1024;
  const fixtures = [
    {
      name: 'prepared uint16',
      context: CONNECTIVITY_MANIFEST_CONTEXT.FILE,
      nCells: 65_536,
      bytesPerEdge:
        2 * Uint16Array.BYTES_PER_ELEMENT +
        6 * Uint32Array.BYTES_PER_ELEMENT +
        2 * Float64Array.BYTES_PER_ELEMENT +
        Float32Array.BYTES_PER_ELEMENT,
      createManifest(nEdges) {
        return {
          ...FILE_MANIFEST,
          n_cells: this.nCells,
          n_edges: nEdges,
          max_neighbors: this.nCells - 1,
        };
      },
    },
    {
      name: 'prepared uint32',
      context: CONNECTIVITY_MANIFEST_CONTEXT.FILE,
      nCells: 100_000,
      bytesPerEdge:
        6 * Uint32Array.BYTES_PER_ELEMENT +
        2 * Float64Array.BYTES_PER_ELEMENT +
        Float32Array.BYTES_PER_ELEMENT,
      createManifest(nEdges) {
        return {
          ...FILE_MANIFEST,
          n_cells: this.nCells,
          n_edges: nEdges,
          max_neighbors: this.nCells - 1,
          index_dtype: 'uint32',
          index_bytes: Uint32Array.BYTES_PER_ELEMENT,
        };
      },
    },
    {
      name: 'direct uint32',
      context: CONNECTIVITY_MANIFEST_CONTEXT.DIRECT,
      nCells: 100_000,
      bytesPerEdge:
        6 * Uint32Array.BYTES_PER_ELEMENT +
        2 * Float64Array.BYTES_PER_ELEMENT +
        Float32Array.BYTES_PER_ELEMENT,
      createManifest(nEdges) {
        return {
          ...DIRECT_MANIFEST,
          n_cells: this.nCells,
          n_edges: nEdges,
          max_neighbors: this.nCells - 1,
        };
      },
    },
  ];

  for (const fixture of fixtures) {
    await t.test(fixture.name, () => {
      const degreeBytes =
        fixture.nCells * Uint32Array.BYTES_PER_ELEMENT;
      const boundaryEdges = Math.floor(
        (browserLimit - degreeBytes) / fixture.bytesPerEdge
      );
      const boundary = fixture.createManifest(boundaryEdges);
      assert.strictEqual(
        validateConnectivityManifest(boundary, fixture.context),
        boundary
      );
      assert.throws(
        () => validateConnectivityManifest(
          fixture.createManifest(boundaryEdges + 1),
          fixture.context
        ),
        /browser working-set limit/i
      );
    });
  }
});

test('file connectivity paths and scalar values reject every malformed form', async t => {
  const unsafePaths = [
    '',
    '/absolute/edges.bin',
    String.raw`connectivity\edges.bin`,
    'https://cellucid.test/edges.bin',
    'C:/edges.bin',
    'connectivity//edges.bin',
    'connectivity/./edges.bin',
    'connectivity/../edges.bin',
    'connectivity/%2e%2e/edges.bin',
    'connectivity/edges.bin?download=1',
    'connectivity/edges.bin#fragment',
    'connectivity/\u0000edges.bin',
  ];
  for (const path of unsafePaths) {
    await t.test(`unsafe path ${JSON.stringify(path)}`, () => {
      assert.throws(
        () => validateConnectivityManifest(
          { ...FILE_MANIFEST, sourcesPath: path },
          CONNECTIVITY_MANIFEST_CONTEXT.FILE
        ),
        /sourcesPath.*safe relative POSIX path/i
      );
      assert.throws(
        () => validateConnectivityManifest(
          { ...FILE_MANIFEST, weightsPath: path },
          CONNECTIVITY_MANIFEST_CONTEXT.FILE
        ),
        /weightsPath.*safe relative POSIX path/i
      );
    });
  }

  const malformed = [
    {
      name: 'format',
      value: { ...FILE_MANIFEST, format: 'csr' },
      error: /format.*edge_pairs/i,
    },
    {
      name: 'zero cells',
      value: { ...FILE_MANIFEST, n_cells: 0 },
      error: /n_cells.*positive/i,
    },
    {
      name: 'fractional cells',
      value: { ...FILE_MANIFEST, n_cells: 2.5 },
      error: /n_cells.*positive/i,
    },
    {
      name: 'negative edges',
      value: { ...FILE_MANIFEST, n_edges: -1 },
      error: /n_edges.*non-negative/i,
    },
    {
      name: 'fractional edges',
      value: { ...FILE_MANIFEST, n_edges: 1.5 },
      error: /n_edges.*non-negative/i,
    },
    {
      name: 'impossible pair count',
      value: { ...FILE_MANIFEST, n_edges: 4 },
      error: /unique undirected cell-pair bound/i,
    },
    {
      name: 'fractional max neighbors',
      value: { ...FILE_MANIFEST, max_neighbors: 1.5 },
      error: /max_neighbors.*bounds/i,
    },
    {
      name: 'unsupported dtype',
      value: {
        ...FILE_MANIFEST,
        index_dtype: 'uint64',
        index_bytes: 8,
      },
      error: /index_dtype.*index_bytes|unsigned cell-index width/i,
    },
    {
      name: 'unsupported weight dtype',
      value: { ...FILE_MANIFEST, weight_dtype: 'float32' },
      error: /weight_dtype.*weight_bytes|float64.*8-byte/i,
    },
    {
      name: 'unsupported weight width',
      value: { ...FILE_MANIFEST, weight_bytes: 4 },
      error: /weight_dtype.*weight_bytes|float64.*8-byte/i,
    },
    {
      name: 'compression zero',
      value: { ...FILE_MANIFEST, compression: 0 },
      error: /compression.*1 through 9/i,
    },
    {
      name: 'compression ten',
      value: { ...FILE_MANIFEST, compression: 10 },
      error: /compression.*1 through 9/i,
    },
    {
      name: 'compressed path without compression',
      value: {
        ...FILE_MANIFEST,
        sourcesPath: `${FILE_MANIFEST.sourcesPath}.gz`,
      },
      error: /sourcesPath.*not end in \.gz/i,
    },
    {
      name: 'compression without compressed paths',
      value: { ...FILE_MANIFEST, compression: 6 },
      error: /sourcesPath.*end in \.gz/i,
    },
    {
      name: 'compressed weight path without compression',
      value: {
        ...FILE_MANIFEST,
        weightsPath: `${FILE_MANIFEST.weightsPath}.gz`,
      },
      error: /weightsPath.*not end in \.gz/i,
    },
  ];
  for (const fixture of malformed) {
    await t.test(fixture.name, () => {
      assert.throws(
        () => validateConnectivityManifest(
          fixture.value,
          CONNECTIVITY_MANIFEST_CONTEXT.FILE
        ),
        fixture.error
      );
    });
  }
});

test('file connectivity loading requires its exact transport schema', async t => {
  await t.test('accepts the exact current file manifest', async () => {
    await withJsonResponse(FILE_MANIFEST, async calls => {
      const manifest = await loadConnectivityManifest(
        'https://cellucid.test/connectivity_manifest.json'
      );
      assert.deepEqual(manifest, FILE_MANIFEST);
      assert.deepEqual(calls, [
        'https://cellucid.test/connectivity_manifest.json',
      ]);
    });
  });

  const invalidCases = [
    {
      name: 'HTTP 200 null is malformed rather than absent',
      manifest: null,
      error: /file connectivity manifest.*object|invalid connectivity manifest/i,
    },
    {
      name: 'direct shape cannot select direct dispatch over HTTP',
      manifest: DIRECT_MANIFEST,
      error: /missing.*sourcesPath|file connectivity manifest/i,
    },
    {
      name: 'unknown properties are rejected',
      manifest: { ...FILE_MANIFEST, legacy_path: 'edges.bin' },
      error: /unexpected.*legacy_path|exact.*properties/i,
    },
    {
      name: 'missing properties are rejected',
      manifest: Object.fromEntries(
        Object.entries(FILE_MANIFEST).filter(([key]) => key !== 'compression')
      ),
      error: /missing.*compression|exact.*properties/i,
    },
    {
      name: 'weight metadata is required',
      manifest: Object.fromEntries(
        Object.entries(FILE_MANIFEST).filter(
          ([key]) => key !== 'weightsPath'
        )
      ),
      error: /missing.*weightsPath|exact.*properties/i,
    },
    {
      name: 'unsafe traversal paths are rejected',
      manifest: { ...FILE_MANIFEST, sourcesPath: '../edges.src.bin' },
      error: /sourcesPath.*safe relative|unsafe.*path|traversal/i,
    },
    {
      name: 'source and destination paths must differ',
      manifest: {
        ...FILE_MANIFEST,
        destinationsPath: FILE_MANIFEST.sourcesPath,
      },
      error: /paths must differ|source.*destination.*weight.*differ/i,
    },
    {
      name: 'weight path must differ from endpoints',
      manifest: {
        ...FILE_MANIFEST,
        weightsPath: FILE_MANIFEST.destinationsPath,
      },
      error: /paths must differ|source.*destination.*weight.*differ/i,
    },
    {
      name: 'dtype and width must be consistent',
      manifest: { ...FILE_MANIFEST, index_bytes: 4 },
      error: /index_dtype.*index_bytes|dtype.*width/i,
    },
    {
      name: 'cell bounds are exact',
      manifest: { ...FILE_MANIFEST, max_neighbors: 3 },
      error: /max_neighbors.*cell|cell bounds/i,
    },
  ];

  for (const fixture of invalidCases) {
    await t.test(fixture.name, async () => {
      await withJsonResponse(fixture.manifest, async () => {
        await assert.rejects(
          loadConnectivityManifest(
            'https://cellucid.test/connectivity_manifest.json'
          ),
          fixture.error
        );
      });
    });
  }

  await t.test('exact HTTP 404 remains distinguishable as absence upstream', async () => {
    await withJsonResponse(
      { ignored: true },
      async () => {
        await assert.rejects(
          loadConnectivityManifest(
            'https://cellucid.test/connectivity_manifest.json'
          ),
          error => error?.status === 404
        );
      },
      404
    );
  });
});

test('file edge payloads are exact before rendering or KNN use', async t => {
  const manifestUrl =
    'https://cellucid.test/data/connectivity_manifest.json';
  const responsesFor = (
    manifest,
    sources,
    destinations,
    weights
  ) => new Map([
    [new URL(manifest.sourcesPath, manifestUrl).href, sources],
    [new URL(manifest.destinationsPath, manifestUrl).href, destinations],
    [new URL(manifest.weightsPath, manifestUrl).href, weights],
  ]);

  await t.test('uint16 endpoints and float64 weights load exactly', async () => {
    await withBinaryResponses(
      responsesFor(
        FILE_MANIFEST,
        Uint16Array.from([0, 1]),
        Uint16Array.from([1, 2]),
        Float64Array.from([0.25, 2])
      ),
      async calls => {
        const edges = await loadEdges(
          manifestUrl,
          FILE_MANIFEST,
          { signal: EDGE_SIGNAL }
        );
        assert.ok(edges.sources instanceof Uint32Array);
        assert.ok(edges.destinations instanceof Uint32Array);
        assert.deepEqual(Array.from(edges.sources), [0, 1]);
        assert.deepEqual(Array.from(edges.destinations), [1, 2]);
        assert.ok(edges.weights instanceof Float64Array);
        assert.deepEqual(Array.from(edges.weights), [0.25, 2]);
        assert.deepEqual(Object.keys(edges).sort(), [
          'destinations',
          'maxNeighbors',
          'nCells',
          'nEdges',
          'sources',
          'weights',
        ]);
        assert.equal(calls.length, 3);
        assert.deepEqual(
          calls.map(call => call.url),
          [
            'https://cellucid.test/data/connectivity/edges.src.bin',
            'https://cellucid.test/data/connectivity/edges.dst.bin',
            'https://cellucid.test/data/connectivity/edges.weights.f64.bin',
          ]
        );
        assert.ok(
          calls.every(call => call.signal === EDGE_SIGNAL),
          'every aligned payload fetch must use the exact load owner'
        );
      }
    );
  });

  await t.test('uint32 retains exact boundary indices', async () => {
    const manifest = {
      ...FILE_MANIFEST,
      n_cells: 65_537,
      max_neighbors: 1,
      index_dtype: 'uint32',
      index_bytes: 4,
    };
    await withBinaryResponses(
      responsesFor(
        manifest,
        Uint32Array.from([0, 65_535]),
        Uint32Array.from([1, 65_536]),
        Float64Array.from([1, 4])
      ),
      async () => {
        const edges = await loadEdges(
          manifestUrl,
          manifest,
          { signal: EDGE_SIGNAL }
        );
        assert.deepEqual(Array.from(edges.sources), [0, 65_535]);
        assert.deepEqual(Array.from(edges.destinations), [1, 65_536]);
      }
    );
  });

  await t.test('gzip preserves aligned float64 weights exactly', async () => {
    const manifest = {
      ...FILE_MANIFEST,
      sourcesPath: `${FILE_MANIFEST.sourcesPath}.gz`,
      destinationsPath: `${FILE_MANIFEST.destinationsPath}.gz`,
      weightsPath: `${FILE_MANIFEST.weightsPath}.gz`,
      compression: 6,
    };
    await withBinaryResponses(
      responsesFor(
        manifest,
        gzipSync(typedArrayBody(Uint16Array.from([0, 1]))),
        gzipSync(typedArrayBody(Uint16Array.from([1, 2]))),
        gzipSync(typedArrayBody(Float64Array.from([0.125, 32])))
      ),
      async () => {
        const edges = await loadEdges(
          manifestUrl,
          manifest,
          { signal: EDGE_SIGNAL }
        );
        assert.deepEqual(Array.from(edges.weights), [0.125, 32]);
      }
    );
  });

  await t.test('an explicitly empty file graph stays present', async () => {
    const manifest = {
      ...FILE_MANIFEST,
      n_edges: 0,
      max_neighbors: 0,
    };
    await withBinaryResponses(
      responsesFor(
        manifest,
        new Uint16Array(0),
        new Uint16Array(0),
        new Float64Array(0)
      ),
      async () => {
        const edges = await loadEdges(
          manifestUrl,
          manifest,
          { signal: EDGE_SIGNAL }
        );
        assert.equal(edges.nEdges, 0);
        assert.deepEqual(Array.from(edges.sources), []);
        assert.deepEqual(Array.from(edges.destinations), []);
        assert.deepEqual(Array.from(edges.weights), []);
      }
    );
  });

  const malformedPayloads = [
    {
      name: 'short source bytes',
      manifest: FILE_MANIFEST,
      sources: Uint16Array.from([0]),
      destinations: Uint16Array.from([1, 2]),
      error: /expected exactly 4 bytes/i,
    },
    {
      name: 'trailing source bytes',
      manifest: FILE_MANIFEST,
      sources: Uint16Array.from([0, 1, 2]),
      destinations: Uint16Array.from([1, 2]),
      error: /expected exactly 4 bytes/i,
    },
    {
      name: 'short destination bytes',
      manifest: FILE_MANIFEST,
      sources: Uint16Array.from([0, 1]),
      destinations: Uint16Array.from([1]),
      error: /expected exactly 4 bytes/i,
    },
    {
      name: 'short weight bytes',
      manifest: FILE_MANIFEST,
      sources: Uint16Array.from([0, 1]),
      destinations: Uint16Array.from([1, 2]),
      weights: Float64Array.from([1]),
      error: /expected exactly 16 bytes.*float64 weights/i,
    },
    {
      name: 'trailing weight bytes',
      manifest: FILE_MANIFEST,
      sources: Uint16Array.from([0, 1]),
      destinations: Uint16Array.from([1, 2]),
      weights: Float64Array.from([1, 2, 3]),
      error: /expected exactly 16 bytes.*float64 weights/i,
    },
    {
      name: 'zero weight',
      manifest: FILE_MANIFEST,
      sources: Uint16Array.from([0, 1]),
      destinations: Uint16Array.from([1, 2]),
      weights: Float64Array.from([1, 0]),
      error: /weight 1.*finite and strictly positive/i,
    },
    {
      name: 'negative weight',
      manifest: FILE_MANIFEST,
      sources: Uint16Array.from([0, 1]),
      destinations: Uint16Array.from([1, 2]),
      weights: Float64Array.from([1, -2]),
      error: /weight 1.*finite and strictly positive/i,
    },
    {
      name: 'non-finite weight',
      manifest: FILE_MANIFEST,
      sources: Uint16Array.from([0, 1]),
      destinations: Uint16Array.from([1, 2]),
      weights: Float64Array.from([1, Number.NaN]),
      error: /weight 1.*finite and strictly positive/i,
    },
    {
      name: 'index outside cells',
      manifest: FILE_MANIFEST,
      sources: Uint16Array.from([0, 1]),
      destinations: Uint16Array.from([1, 3]),
      error: /outside the cell bounds/i,
    },
    {
      name: 'self edge',
      manifest: FILE_MANIFEST,
      sources: Uint16Array.from([0, 1]),
      destinations: Uint16Array.from([0, 2]),
      error: /source < destination/i,
    },
    {
      name: 'reversed edge',
      manifest: FILE_MANIFEST,
      sources: Uint16Array.from([1, 1]),
      destinations: Uint16Array.from([0, 2]),
      error: /source < destination/i,
    },
    {
      name: 'duplicate edge',
      manifest: FILE_MANIFEST,
      sources: Uint16Array.from([0, 0]),
      destinations: Uint16Array.from([1, 1]),
      error: /unique and strictly ordered/i,
    },
    {
      name: 'unsorted edges',
      manifest: FILE_MANIFEST,
      sources: Uint16Array.from([1, 0]),
      destinations: Uint16Array.from([2, 1]),
      error: /unique and strictly ordered/i,
    },
    {
      name: 'false max degree',
      manifest: { ...FILE_MANIFEST, max_neighbors: 1 },
      sources: Uint16Array.from([0, 1]),
      destinations: Uint16Array.from([1, 2]),
      error: /max degree 2.*max_neighbors 1/i,
    },
  ];

  for (const fixture of malformedPayloads) {
    await t.test(fixture.name, async () => {
      await withBinaryResponses(
        responsesFor(
          fixture.manifest,
          fixture.sources,
          fixture.destinations,
          fixture.weights ?? Float64Array.from([1, 1])
        ),
        async () => {
          await assert.rejects(
            loadEdges(
              manifestUrl,
              fixture.manifest,
              { signal: EDGE_SIGNAL }
            ),
            fixture.error
          );
        }
      );
    });
  }

  await t.test('invalid dtype fails before binary work', async () => {
    let binaryCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      binaryCalls++;
      throw new Error('binary work must not start');
    };
    try {
      await assert.rejects(
        loadEdges(
          manifestUrl,
          {
            ...FILE_MANIFEST,
            index_dtype: 'uint64',
            index_bytes: 8,
          },
          { signal: EDGE_SIGNAL }
        ),
        /index_dtype.*index_bytes|unsigned cell-index width/i
      );
      assert.equal(binaryCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('direct connectivity absence is exact and method-owned', async t => {
  await t.test('accepts the exact direct manifest', async () => {
    await withDirectSource({}, async url => {
      assert.deepEqual(
        await loadConnectivityManifest(url),
        DIRECT_MANIFEST
      );
    });
  });

  await t.test('a present method may return exact null absence', async () => {
    await withDirectSource({
      manifestMethod: async () => null,
    }, async url => {
      assert.equal(await loadConnectivityManifest(url), null);
    });
  });

  await t.test('an explicitly empty direct graph stays present', async () => {
    const manifest = {
      ...DIRECT_MANIFEST,
      n_edges: 0,
      max_neighbors: 0,
    };
    await withDirectSource({
      manifestMethod: async () => manifest,
      edgeMethod: async () => ({
        sources: new Uint32Array(0),
        destinations: new Uint32Array(0),
        weights: new Float64Array(0),
        nCells: 3,
        nEdges: 0,
        maxNeighbors: 0,
      }),
    }, async url => {
      assert.strictEqual(
        await loadConnectivityManifest(url),
        manifest
      );
      const edges = await loadEdges(
        url,
        manifest,
        { signal: EDGE_SIGNAL }
      );
      assert.equal(edges.nEdges, 0);
      assert.deepEqual(Array.from(edges.sources), []);
      assert.deepEqual(Array.from(edges.destinations), []);
      assert.deepEqual(Array.from(edges.weights), []);
    });
  });

  await t.test('a missing method is a contract error', async () => {
    await withDirectSource({
      omitManifestMethod: true,
    }, async url => {
      await assert.rejects(
        loadConnectivityManifest(url),
        /required.*getConnectivityManifest|missing.*manifest method/i
      );
    });
  });

  for (const value of [undefined, false, 0, '', Number.NaN]) {
    await t.test(`falsy ${String(value)} is not absence`, async () => {
      await withDirectSource({
        manifestMethod: async () => value,
      }, async url => {
        await assert.rejects(
          loadConnectivityManifest(url),
          /exact null|invalid direct connectivity manifest/i
        );
      });
    });
  }

  await t.test('file paths cannot select the direct schema', async () => {
    await withDirectSource({
      manifestMethod: async () => FILE_MANIFEST,
    }, async url => {
      await assert.rejects(
        loadConnectivityManifest(url),
        /unexpected.*sourcesPath|direct connectivity manifest/i
      );
    });
  });
});

test('direct edge payloads must exactly match their adopted manifest', async t => {
  const validEdgeData = () => ({
    sources: Uint32Array.from([0, 1]),
    destinations: Uint32Array.from([1, 2]),
    weights: Float64Array.from([1, 2]),
    nCells: 3,
    nEdges: 2,
    maxNeighbors: 2,
  });
  const invalidCases = [
    {
      name: 'null payload contradicts a present manifest',
      edgeData: null,
      error: /payload is absent despite its manifest/i,
    },
    {
      name: 'falsy payload is malformed',
      edgeData: false,
      error: /edge payload.*object/i,
    },
    {
      name: 'unknown payload properties',
      edgeData: { ...validEdgeData(), legacy: true },
      error: /unexpected legacy|exact properties/i,
    },
    {
      name: 'wrong source array type',
      edgeData: {
        ...validEdgeData(),
        sources: Uint16Array.from([0, 1]),
      },
      error: /endpoints must be Uint32Array/i,
    },
    {
      name: 'wrong weight array type',
      edgeData: {
        ...validEdgeData(),
        weights: Float32Array.from([1, 2]),
      },
      error: /weights must be a Float64Array/i,
    },
    {
      name: 'unequal array lengths',
      edgeData: {
        ...validEdgeData(),
        sources: Uint32Array.from([0]),
      },
      error: /array lengths.*n_edges/i,
    },
    {
      name: 'non-finite weight',
      edgeData: {
        ...validEdgeData(),
        weights: Float64Array.from([1, Number.NaN]),
      },
      error: /weight 1.*finite and strictly positive/i,
    },
    {
      name: 'zero weight',
      edgeData: {
        ...validEdgeData(),
        weights: Float64Array.from([1, 0]),
      },
      error: /weight 1.*finite and strictly positive/i,
    },
    {
      name: 'cell summary mismatch',
      edgeData: { ...validEdgeData(), nCells: 4 },
      error: /summaries.*match the manifest/i,
    },
    {
      name: 'edge summary mismatch',
      edgeData: { ...validEdgeData(), nEdges: 1 },
      error: /summaries.*match the manifest/i,
    },
    {
      name: 'neighbor summary mismatch',
      edgeData: { ...validEdgeData(), maxNeighbors: 1 },
      error: /summaries.*match the manifest/i,
    },
    {
      name: 'out-of-bounds destination',
      edgeData: {
        ...validEdgeData(),
        destinations: Uint32Array.from([1, 3]),
      },
      error: /outside the cell bounds/i,
    },
    {
      name: 'self edge',
      edgeData: {
        ...validEdgeData(),
        destinations: Uint32Array.from([0, 2]),
      },
      error: /source < destination/i,
    },
    {
      name: 'reversed edge',
      edgeData: {
        ...validEdgeData(),
        sources: Uint32Array.from([1, 1]),
        destinations: Uint32Array.from([0, 2]),
      },
      error: /source < destination/i,
    },
    {
      name: 'duplicate edge',
      edgeData: {
        ...validEdgeData(),
        sources: Uint32Array.from([0, 0]),
        destinations: Uint32Array.from([1, 1]),
      },
      error: /unique and strictly ordered/i,
    },
    {
      name: 'unsorted edges',
      edgeData: {
        ...validEdgeData(),
        sources: Uint32Array.from([1, 0]),
        destinations: Uint32Array.from([2, 1]),
      },
      error: /unique and strictly ordered/i,
    },
    {
      name: 'false degree summary',
      manifest: { ...DIRECT_MANIFEST, max_neighbors: 1 },
      edgeData: {
        ...validEdgeData(),
        maxNeighbors: 1,
      },
      error: /max degree 2.*max_neighbors 1/i,
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
            fixture.manifest ?? DIRECT_MANIFEST,
            { signal: EDGE_SIGNAL }
          ),
          fixture.error
        );
      });
    });
  }
});

test('edge dispatch revalidates the manifest for the explicit URL protocol', async () => {
  let edgeCalls = 0;
  await withDirectSource({
    edgeMethod: async () => {
      edgeCalls++;
      return {
        sources: Uint32Array.from([0, 1]),
        destinations: Uint32Array.from([1, 2]),
        weights: Float64Array.from([1, 2]),
        nCells: 3,
        nEdges: 2,
        maxNeighbors: 2,
      };
    },
  }, async url => {
    await assert.rejects(
      loadEdges(
        url,
        {
          ...DIRECT_MANIFEST,
          sourcesPath: 'connectivity/edges.src.bin',
        },
        { signal: EDGE_SIGNAL }
      ),
      /unexpected.*sourcesPath|direct connectivity manifest/i
    );
    assert.equal(edgeCalls, 0, 'invalid metadata must fail before payload work');

    const edges = await loadEdges(
      url,
      DIRECT_MANIFEST,
      { signal: EDGE_SIGNAL }
    );
    assert.equal(edgeCalls, 1);
    assert.deepEqual(Array.from(edges.sources), [0, 1]);
    assert.deepEqual(Array.from(edges.destinations), [1, 2]);
    assert.deepEqual(Array.from(edges.weights), [1, 2]);
    assert.equal(edges.nCells, 3);
    assert.equal(edges.nEdges, 2);
    assert.equal(edges.maxNeighbors, 2);
  });
});

test('H5AD and Zarr manifest access is metadata-only', async t => {
  for (const [label, SourceClass] of [
    ['H5AD', H5adDataSource],
    ['Zarr', ZarrDataSource],
  ]) {
    await t.test(label, async () => {
      const source = new SourceClass();
      let manifestReads = 0;
      let edgeMaterializations = 0;
      const immutableManifest = Object.freeze({ ...DIRECT_MANIFEST });
      source._adapter = {
        getConnectivityManifest() {
          manifestReads++;
          return immutableManifest;
        },
        getConnectivityEdges() {
          edgeMaterializations++;
          throw new Error('manifest access must not materialize edges');
        },
      };

      assert.strictEqual(
        await source.getConnectivityManifest(),
        immutableManifest
      );
      assert.equal(manifestReads, 1);
      assert.equal(edgeMaterializations, 0);

      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        source.getConnectivityManifest({ signal: controller.signal }),
        error => error?.name === 'AbortError'
      );
      assert.equal(manifestReads, 1);
      assert.equal(edgeMaterializations, 0);
    });
  }
});

test('all four public metadata loaders propagate one exact AbortSignal', async t => {
  const loaders = [
    ['identity', loadDatasetIdentity],
    ['observation manifest', loadObsManifest],
    ['variable manifest', loadVarManifest],
    ['connectivity manifest', loadConnectivityManifest],
  ];

  for (const [label, loader] of loaders) {
    await t.test(`${label} pre-abort`, async () => {
      const originalFetch = globalThis.fetch;
      let fetchCalls = 0;
      globalThis.fetch = async () => {
        fetchCalls++;
        throw new Error('pre-aborted metadata must not fetch');
      };
      try {
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(
          loader(
            `https://cellucid.test/${label.replaceAll(' ', '_')}.json`,
            { signal: controller.signal }
          ),
          error => error?.name === 'AbortError'
        );
        assert.equal(fetchCalls, 0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    await t.test(`${label} in-flight abort`, async () => {
      const originalFetch = globalThis.fetch;
      const started = deferred();
      const controller = new AbortController();
      let receivedSignal = null;
      globalThis.fetch = async (_url, init) => {
        receivedSignal = init?.signal ?? null;
        started.resolve();
        return new Promise((_resolve, reject) => {
          receivedSignal.addEventListener('abort', () => {
            const error = new Error('synthetic metadata abort');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      };
      try {
        const loading = loader(
          `https://cellucid.test/${label.replaceAll(' ', '_')}.json`,
          { signal: controller.signal }
        );
        await started.promise;
        assert.strictEqual(receivedSignal, controller.signal);
        controller.abort();
        await assert.rejects(
          loading,
          error => error?.name === 'AbortError'
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }

  await t.test('options reject unknown keys and non-signals', async () => {
    await assert.rejects(
      loadDatasetIdentity(
        'https://cellucid.test/dataset_identity.json',
        { legacySignal: null }
      ),
      /unexpected key.*legacySignal/i
    );
    await assert.rejects(
      loadConnectivityManifest(
        'https://cellucid.test/connectivity_manifest.json',
        { signal: false }
      ),
      /AbortSignal or exact null/i
    );
  });
});

test('direct and local metadata transports receive the exact owner signal', async t => {
  await t.test('direct connectivity', async () => {
    const started = deferred();
    const controller = new AbortController();
    let receivedSignal = null;
    await withDirectSource({
      manifestMethod: ({ signal }) => {
        receivedSignal = signal;
        started.resolve();
        return new Promise(() => {});
      },
    }, async url => {
      const loading = loadConnectivityManifest(
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

  await t.test('local-user resolution and fetch', async () => {
    const manager = getDataSourceManager();
    const previousSource = manager.sources.get('local-user');
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    const started = deferred();
    let resolutionSignal = null;
    let receivedSignal = null;
    manager.sources.set('local-user', {
      getType() {
        return 'local-user';
      },
      async resolveUrl(_url, signal) {
        resolutionSignal = signal;
        return 'https://local.cellucid.test/dataset_identity.json';
      },
    });
    globalThis.fetch = async (_url, init) => {
      receivedSignal = init?.signal ?? null;
      started.resolve();
      return new Promise((_resolve, reject) => {
        receivedSignal.addEventListener('abort', () => {
          const error = new Error('synthetic local metadata abort');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    };
    try {
      const loading = loadDatasetIdentity(
        'local-user://dataset/dataset_identity.json',
        { signal: controller.signal }
      );
      await started.promise;
      assert.strictEqual(resolutionSignal, controller.signal);
      assert.strictEqual(receivedSignal, controller.signal);
      controller.abort();
      await assert.rejects(
        loading,
        error => error?.name === 'AbortError'
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (previousSource === undefined) {
        manager.sources.delete('local-user');
      } else {
        manager.sources.set('local-user', previousSource);
      }
    }
  });

  await t.test('local-user resolution itself is abortable', async () => {
    const manager = getDataSourceManager();
    const previousSource = manager.sources.get('local-user');
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    const started = deferred();
    let receivedSignal = null;
    let fetchCalls = 0;
    manager.sources.set('local-user', {
      getType() {
        return 'local-user';
      },
      resolveUrl(_url, signal) {
        receivedSignal = signal;
        started.resolve();
        return new Promise(() => {});
      },
    });
    globalThis.fetch = async () => {
      fetchCalls++;
      throw new Error('aborted URL resolution must not fetch');
    };
    try {
      const loading = loadDatasetIdentity(
        'local-user://dataset/dataset_identity.json',
        { signal: controller.signal }
      );
      await started.promise;
      assert.strictEqual(receivedSignal, controller.signal);
      controller.abort();
      await assert.rejects(
        loading,
        error => error?.name === 'AbortError'
      );
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousSource === undefined) {
        manager.sources.delete('local-user');
      } else {
        manager.sources.set('local-user', previousSource);
      }
    }
  });
});

test('connectivity edge loading requires and propagates one exact owner signal', async t => {
  await t.test('required options contract', async () => {
    await assert.rejects(
      loadEdges(
        'https://cellucid.test/connectivity_manifest.json',
        FILE_MANIFEST
      ),
      /options must be an object/i
    );
    await assert.rejects(
      loadEdges(
        'https://cellucid.test/connectivity_manifest.json',
        FILE_MANIFEST,
        {}
      ),
      /options\.signal is required/i
    );
    await assert.rejects(
      loadEdges(
        'https://cellucid.test/connectivity_manifest.json',
        FILE_MANIFEST,
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
          DIRECT_MANIFEST,
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
        DIRECT_MANIFEST,
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

  await t.test('all three file payload requests observe owner abort', async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    const started = deferred();
    const receivedSignals = [];
    globalThis.fetch = async (_url, init) => {
      const signal = init?.signal ?? null;
      receivedSignals.push(signal);
      if (receivedSignals.length === 3) started.resolve();
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('synthetic connectivity payload abort');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    };
    try {
      const loading = loadEdges(
        'https://cellucid.test/connectivity_manifest.json',
        FILE_MANIFEST,
        { signal: controller.signal }
      );
      await started.promise;
      assert.deepEqual(
        receivedSignals,
        [controller.signal, controller.signal, controller.signal]
      );
      controller.abort();
      await assert.rejects(
        loading,
        error => error?.name === 'AbortError'
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
