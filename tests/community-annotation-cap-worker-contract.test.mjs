import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../assets/js/app/community-annotations/_worker-code.js';
import {
  parseExactJson,
} from '../assets/js/app/community-annotations/wire-contract.js';

const ENV = Object.freeze({
  ALLOWED_ORIGINS: 'https://app.example,http://localhost:8000',
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
});
const CAP_GRAPHQL_URL = 'https://celltype.info/graphql';
const CAP_LOOKUP_APQ_HASH =
  '7669f4698d1243244b365018dc60a69b61969791659814e0b4ad1b65385ddaab';
const CAP_DATASET_APQ_HASH =
  '84226dc93685478baaabbc0687bb8c85fd24ea280c9d1db957d332dc8a9bff57';
const CAP_REQUEST_BODY_MAX_BYTES = 4 * 1024;
const CAP_RESPONSE_BODY_MAX_BYTES = 8 * 1024 * 1024;
const WORKER_DEADLINE_MS = 15_000;
const encoder = new TextEncoder();

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function capRequest(path, {
  body = JSON.stringify({ kind: 'name', term: 'T cell', limit: 1 }),
  headers = null,
  method = 'POST',
  origin = 'https://app.example',
  signal = null,
} = {}) {
  const requestHeaders = new Headers(headers ?? undefined);
  if (origin !== null) requestHeaders.set('Origin', origin);
  if (body !== null && !requestHeaders.has('Content-Type')) {
    requestHeaders.set('Content-Type', 'application/json');
  }
  const options = {
    method,
    headers: requestHeaders,
    signal,
  };
  if (body !== null && method !== 'GET' && method !== 'HEAD') {
    options.body = body;
    if (body && typeof body.getReader === 'function') {
      options.duplex = 'half';
    }
  }
  return new Request(`https://worker.example${path}`, options);
}

function jsonResponse(document, status = 200, headers = null) {
  return new Response(JSON.stringify(document), {
    status,
    headers: new Headers({
      'Content-Type': 'application/json',
      ...(headers ?? {}),
    }),
  });
}

async function responseDocument(response) {
  return parseExactJson(await response.text(), {
    path: `Worker HTTP ${response.status} response`,
  });
}

async function withMockedFetch(mockFetch, callback) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    return await callback();
  } finally {
    globalThis.fetch = previousFetch;
  }
}

function validLookupItem(overrides = {}) {
  return {
    id: '42',
    name: 'T cell',
    fullName: 'T cell',
    ontologyTerm: 'T cell',
    ontologyTermId: 'CL:0000084',
    synonyms: ['T lymphocyte'],
    markerGenes: ['CD3D'],
    canonicalMarkerGenes: ['CD3E'],
    count: 12,
    scores: {
      agree: 7,
      disagree: 2,
      idk: 1,
      __typename: 'CellLabelScores',
    },
    __typename: 'CellLabel',
    ignoredUpstreamField: 'must not cross the gateway',
    ...overrides,
  };
}

function projectedLookupItem(item) {
  return {
    id: item.id,
    name: item.name,
    fullName: item.fullName,
    ontologyTerm: item.ontologyTerm,
    ontologyTermId: item.ontologyTermId,
    synonyms: item.synonyms,
    markerGenes: item.markerGenes,
    canonicalMarkerGenes: item.canonicalMarkerGenes,
    count: item.count,
    scores: {
      agree: item.scores.agree,
      disagree: item.scores.disagree,
      idk: item.scores.idk,
    },
  };
}

function validDatasetItem(overrides = {}) {
  return {
    id: '7',
    name: 'Pancreas atlas',
    cellCount: 1234,
    consortiumTags: [{ name: 'ignored' }],
    labelsets: [{ name: 'ignored' }],
    project: { secret: 'must not cross the gateway' },
    scores: { ignored: true },
    __typename: 'Dataset',
    ...overrides,
  };
}

function installFakeTimers() {
  const previousSetTimeout = globalThis.setTimeout;
  const previousClearTimeout = globalThis.clearTimeout;
  const records = [];
  globalThis.setTimeout = (callback, delay = 0, ...args) => {
    const record = {
      args,
      callback,
      cleared: false,
      delay,
      fired: false,
    };
    records.push(record);
    return record;
  };
  globalThis.clearTimeout = (record) => {
    if (records.includes(record)) {
      record.cleared = true;
      return;
    }
    previousClearTimeout(record);
  };
  return {
    fire(record) {
      assert.equal(record.cleared, false);
      assert.equal(record.fired, false);
      record.fired = true;
      record.callback(...record.args);
    },
    records,
    restore() {
      globalThis.setTimeout = previousSetTimeout;
      globalThis.clearTimeout = previousClearTimeout;
    },
  };
}

test('CAP namespace requires an exact allowed Origin and exact CORS preflight', async () => {
  let upstreamCalls = 0;
  await withMockedFetch(async () => {
    upstreamCalls += 1;
    return jsonResponse({ data: { lookupCells: [] } });
  }, async () => {
    const missingOrigin = await worker.fetch(
      capRequest('/cap/lookup-cells', { origin: null }),
      ENV
    );
    assert.equal(missingOrigin.status, 403);
    assert.equal(
      missingOrigin.headers.get('Access-Control-Allow-Origin'),
      null
    );

    const disallowedOrigin = await worker.fetch(
      capRequest('/cap/lookup-cells', { origin: 'https://evil.example' }),
      ENV
    );
    assert.equal(disallowedOrigin.status, 403);
    assert.equal(
      disallowedOrigin.headers.get('Access-Control-Allow-Origin'),
      null
    );

    for (const path of ['/cap/lookup-cells', '/cap/search-datasets']) {
      const preflight = await worker.fetch(
        capRequest(path, {
          body: null,
          headers: {
            'Access-Control-Request-Headers': 'Content-Type',
            'Access-Control-Request-Method': 'POST',
          },
          method: 'OPTIONS',
        }),
        ENV
      );
      assert.equal(preflight.status, 204);
      assert.equal(
        preflight.headers.get('Access-Control-Allow-Origin'),
        'https://app.example'
      );
      assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'POST');
      assert.equal(
        preflight.headers.get('Access-Control-Allow-Headers'),
        'content-type'
      );
      assert.equal(preflight.headers.get('Access-Control-Expose-Headers'), null);
      assert.equal(
        preflight.headers.get('Access-Control-Allow-Credentials'),
        null
      );
      assert.equal(preflight.headers.get('Access-Control-Max-Age'), '600');
      assert.equal(preflight.headers.get('Vary'), 'Origin');
    }

    for (const headers of [
      {
        'Access-Control-Request-Headers': 'Content-Type',
        'Access-Control-Request-Method': 'GET',
      },
      {
        'Access-Control-Request-Headers': 'Authorization, Content-Type',
        'Access-Control-Request-Method': 'POST',
      },
    ]) {
      const rejected = await worker.fetch(
        capRequest('/cap/lookup-cells', {
          body: null,
          headers,
          method: 'OPTIONS',
        }),
        ENV
      );
      assert.equal(rejected.status, 400);
      assert.equal(rejected.headers.get('Access-Control-Max-Age'), null);
    }

    const wrongMethod = await worker.fetch(
      capRequest('/cap/lookup-cells', { body: null, method: 'GET' }),
      ENV
    );
    assert.equal(wrongMethod.status, 405);

    const unknownRoute = await worker.fetch(
      capRequest('/cap/arbitrary-graphql', {
        body: null,
        headers: {
          'Access-Control-Request-Headers': 'Content-Type',
          'Access-Control-Request-Method': 'POST',
        },
        method: 'OPTIONS',
      }),
      ENV
    );
    assert.equal(unknownRoute.status, 404);
    assert.equal(upstreamCalls, 0);
  });
});

test('lookup route maps every search kind to the exact official APQ fields', async () => {
  const upstreamItem = validLookupItem();
  const captured = [];
  const cases = [
    {
      kind: 'name',
      term: 'T cell',
      search: { name: 'T cell' },
    },
    {
      kind: 'ontology',
      term: 'CL:0000084',
      search: {
        name: 'CL:0000084',
        fields: ['ontologyTermId'],
      },
    },
    {
      kind: 'marker',
      term: 'CD3D',
      search: {
        name: 'CD3D',
        fields: ['markerGenes', 'canonicalMarkerGenes'],
      },
    },
    {
      kind: 'feedback',
      term: 'T cell',
      search: { name: 'T cell' },
    },
  ];
  await withMockedFetch(async (url, options = {}) => {
    captured.push({ options, url: String(url) });
    return jsonResponse(
      {
        data: {
          lookupCells: [upstreamItem],
          ignoredRoot: 'not projected',
        },
        extensions: { ignored: true },
      },
      200,
      {
        'Set-Cookie': 'cap-secret=must-not-leak',
        'X-Upstream-Secret': 'must-not-leak',
      }
    );
  }, async () => {
    for (const lookupCase of cases) {
      const response = await worker.fetch(
        capRequest('/cap/lookup-cells', {
          body: JSON.stringify({
            kind: lookupCase.kind,
            term: lookupCase.term,
            limit: 1,
          }),
        }),
        ENV
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await responseDocument(response), {
        contractVersion: 1,
        results: [projectedLookupItem(upstreamItem)],
        omittedInvalidCount: 0,
      });
      assert.equal(
        response.headers.get('Access-Control-Allow-Origin'),
        'https://app.example'
      );
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.equal(response.headers.get('Set-Cookie'), null);
      assert.equal(response.headers.get('X-Upstream-Secret'), null);
    }
  });

  assert.equal(captured.length, cases.length);
  for (const [index, request] of captured.entries()) {
    assert.equal(request.url, CAP_GRAPHQL_URL);
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.credentials, 'omit');
    assert.equal(request.options.redirect, 'error');
    assert.ok(request.options.signal instanceof AbortSignal);
    assert.deepEqual(
      [...request.options.headers].map(([key, value]) => [key, value]),
      [
        ['accept', 'application/json'],
        ['content-type', 'application/json'],
      ]
    );
    const upstreamDocument = parseExactJson(request.options.body, {
      path: 'forwarded CAP lookup APQ',
    });
    assert.deepEqual(upstreamDocument, {
      operationName: 'LookupCells',
      variables: {
        options: { limit: 1 },
        search: cases[index].search,
      },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash: CAP_LOOKUP_APQ_HASH,
        },
      },
    });
    assert.equal(Object.hasOwn(upstreamDocument, 'query'), false);
  }
});

test('dataset route maps both exact search forms to SearchDatasets APQ data.results', async () => {
  const upstreamRequests = [];
  const upstreamItem = validDatasetItem();
  await withMockedFetch(async (_url, options = {}) => {
    upstreamRequests.push(parseExactJson(options.body));
    return jsonResponse({ data: { results: [upstreamItem] } });
  }, async () => {
    for (const search of [null, 'pancreas']) {
      const response = await worker.fetch(
        capRequest('/cap/search-datasets', {
          body: JSON.stringify({ search, limit: 1 }),
        }),
        ENV
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await responseDocument(response), {
        contractVersion: 1,
        results: [{
          id: upstreamItem.id,
          name: upstreamItem.name,
          cellCount: upstreamItem.cellCount,
        }],
        omittedInvalidCount: 0,
      });
    }
  });
  assert.deepEqual(upstreamRequests, [
    {
      operationName: 'SearchDatasets',
      variables: { options: { limit: 1 }, search: null },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash: CAP_DATASET_APQ_HASH,
        },
      },
    },
    {
      operationName: 'SearchDatasets',
      variables: {
        options: { limit: 1 },
        search: { name: 'pancreas' },
      },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash: CAP_DATASET_APQ_HASH,
        },
      },
    },
  ]);
  assert.equal(
    upstreamRequests.every((document) => !Object.hasOwn(document, 'query')),
    true
  );
});

test('CAP request schemas reject coercion, query material, and credentials before dispatch', async (t) => {
  const scenarios = [
    {
      name: 'lookup missing kind',
      path: '/cap/lookup-cells',
      body: '{"term":"T cell","limit":1}',
      status: 400,
    },
    {
      name: 'lookup unknown field',
      path: '/cap/lookup-cells',
      body: '{"kind":"name","term":"T cell","limit":1,"query":"query X"}',
      status: 400,
    },
    {
      name: 'lookup duplicate decoded key',
      path: '/cap/lookup-cells',
      body:
        '{"kind":"name","\\u006bind":"marker",' +
        '"term":"T cell","limit":1}',
      status: 400,
    },
    {
      name: 'lookup UTF-8 BOM',
      path: '/cap/lookup-cells',
      body: '\ufeff{"kind":"name","term":"T cell","limit":1}',
      status: 400,
    },
    {
      name: 'lookup invalid kind',
      path: '/cap/lookup-cells',
      body: '{"kind":"arbitrary","term":"T cell","limit":1}',
      status: 400,
    },
    {
      name: 'lookup padded term',
      path: '/cap/lookup-cells',
      body: '{"kind":"name","term":" T cell","limit":1}',
      status: 400,
    },
    {
      name: 'lookup coerced limit',
      path: '/cap/lookup-cells',
      body: '{"kind":"name","term":"T cell","limit":"1"}',
      status: 400,
    },
    {
      name: 'lookup limit above ceiling',
      path: '/cap/lookup-cells',
      body: '{"kind":"name","term":"T cell","limit":26}',
      status: 400,
    },
    {
      name: 'dataset missing explicit search',
      path: '/cap/search-datasets',
      body: '{"limit":1}',
      status: 400,
    },
    {
      name: 'dataset blank search',
      path: '/cap/search-datasets',
      body: '{"search":"","limit":1}',
      status: 400,
    },
    {
      name: 'dataset limit above ceiling',
      path: '/cap/search-datasets',
      body: '{"search":null,"limit":11}',
      status: 400,
    },
    {
      name: 'query string',
      path: '/cap/lookup-cells?query=query%20X',
      body: '{"kind":"name","term":"T cell","limit":1}',
      status: 400,
    },
    {
      name: 'wrong content type',
      path: '/cap/lookup-cells',
      body: '{"kind":"name","term":"T cell","limit":1}',
      headers: { 'Content-Type': 'text/plain' },
      status: 415,
    },
    {
      name: 'authorization',
      path: '/cap/lookup-cells',
      body: '{"kind":"name","term":"T cell","limit":1}',
      headers: { Authorization: 'Bearer secret' },
      status: 400,
    },
    {
      name: 'cookie',
      path: '/cap/lookup-cells',
      body: '{"kind":"name","term":"T cell","limit":1}',
      headers: { Cookie: 'secret=value' },
      status: 400,
    },
    {
      name: 'operation header',
      path: '/cap/lookup-cells',
      body: '{"kind":"name","term":"T cell","limit":1}',
      headers: {
        'X-Cellucid-Operation-Id':
          '018f5e3a-7b9c-4d2e-8f10-123456789abc',
      },
      status: 400,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      let upstreamCalls = 0;
      await withMockedFetch(async () => {
        upstreamCalls += 1;
        return jsonResponse({ data: { lookupCells: [] } });
      }, async () => {
        const response = await worker.fetch(
          capRequest(scenario.path, {
            body: scenario.body,
            headers: scenario.headers,
          }),
          ENV
        );
        assert.equal(response.status, scenario.status);
        assert.equal(upstreamCalls, 0);
      });
    });
  }
});

test('CAP term and limit code-point boundaries are exact', async () => {
  const forwarded = [];
  await withMockedFetch(async (_url, options = {}) => {
    const document = parseExactJson(options.body);
    forwarded.push(document);
    const field =
      document.operationName === 'LookupCells' ? 'lookupCells' : 'results';
    return jsonResponse({ data: { [field]: [] } });
  }, async () => {
    const accepted = [
      capRequest('/cap/lookup-cells', {
        body: JSON.stringify({
          kind: 'marker',
          term: 'G'.repeat((50 * 64) + 49),
          limit: 25,
        }),
      }),
      capRequest('/cap/lookup-cells', {
        body: JSON.stringify({
          kind: 'name',
          term: '😀'.repeat(256),
          limit: 25,
        }),
      }),
      capRequest('/cap/search-datasets', {
        body: JSON.stringify({
          search: '😀'.repeat(256),
          limit: 10,
        }),
      }),
    ];
    for (const request of accepted) {
      const response = await worker.fetch(request, ENV);
      assert.equal(response.status, 200);
    }

    for (const [path, body] of [
      [
        '/cap/lookup-cells',
        {
          kind: 'marker',
          term: 'G'.repeat((50 * 64) + 50),
          limit: 1,
        },
      ],
      [
        '/cap/lookup-cells',
        {
          kind: 'name',
          term: '😀'.repeat(257),
          limit: 1,
        },
      ],
      [
        '/cap/search-datasets',
        {
          search: '😀'.repeat(257),
          limit: 1,
        },
      ],
    ]) {
      const response = await worker.fetch(
        capRequest(path, { body: JSON.stringify(body) }),
        ENV
      );
      assert.equal(response.status, 400);
    }
  });
  assert.equal(forwarded.length, 3);
});

test('CAP request body owns the exact 4 KiB UTF-8 boundary', async () => {
  const base = JSON.stringify({ kind: 'name', term: 'T cell', limit: 1 });
  const baseBytes = encoder.encode(base).byteLength;
  const exact = base + ' '.repeat(CAP_REQUEST_BODY_MAX_BYTES - baseBytes);
  const oversized = `${exact} `;
  assert.equal(encoder.encode(exact).byteLength, CAP_REQUEST_BODY_MAX_BYTES);
  assert.equal(
    encoder.encode(oversized).byteLength,
    CAP_REQUEST_BODY_MAX_BYTES + 1
  );

  let upstreamCalls = 0;
  await withMockedFetch(async () => {
    upstreamCalls += 1;
    return jsonResponse({ data: { lookupCells: [] } });
  }, async () => {
    const accepted = await worker.fetch(
      capRequest('/cap/lookup-cells', { body: exact }),
      ENV
    );
    assert.equal(accepted.status, 200);

    const rejected = await worker.fetch(
      capRequest('/cap/lookup-cells', { body: oversized }),
      ENV
    );
    assert.equal(rejected.status, 413);
  });
  assert.equal(upstreamCalls, 1);
});

test('lookup projection omits and counts invalid rows without clipping valid boundaries', async () => {
  const valid = validLookupItem({
    id: 'i'.repeat(64),
    name: '😀'.repeat(512),
    fullName: 'F'.repeat(512),
    ontologyTerm: null,
    ontologyTermId: null,
    synonyms: Array.from({ length: 100 }, (_, index) => `synonym-${index}`),
    markerGenes: Array.from({ length: 200 }, (_, index) => `G${index}`),
    canonicalMarkerGenes: Array.from(
      { length: 200 },
      (_, index) => `CG${index}`
    ),
    count: 0,
    scores: {
      agree: 1,
      disagree: 2,
      idk: 3,
      __typename: 'CellLabelScores',
    },
  });
  const invalid = [
    null,
    validLookupItem({ id: 'i'.repeat(65) }),
    validLookupItem({ name: '' }),
    validLookupItem({ fullName: 'F'.repeat(513) }),
    validLookupItem({ ontologyTerm: 42 }),
    validLookupItem({ ontologyTermId: 'C'.repeat(65) }),
    validLookupItem({ synonyms: Array(101).fill('synonym') }),
    validLookupItem({ synonyms: ['S'.repeat(513)] }),
    validLookupItem({ markerGenes: Array(201).fill('G') }),
    validLookupItem({ markerGenes: ['G'.repeat(65)] }),
    validLookupItem({ canonicalMarkerGenes: null }),
    validLookupItem({ count: -1 }),
    validLookupItem({
      scores: {
        agree: Number.MAX_SAFE_INTEGER,
        disagree: 1,
        idk: 0,
      },
    }),
  ];
  await withMockedFetch(
    async () => jsonResponse({
      data: { lookupCells: [valid, ...invalid] },
    }),
    async () => {
      const response = await worker.fetch(
        capRequest('/cap/lookup-cells', {
          body: JSON.stringify({
            kind: 'name',
            term: 'T cell',
            limit: 25,
          }),
        }),
        ENV
      );
      assert.equal(response.status, 200);
      const document = await responseDocument(response);
      assert.equal(document.contractVersion, 1);
      assert.equal(document.omittedInvalidCount, invalid.length);
      assert.equal(document.results.length, 1);
      assert.deepEqual(document.results[0], projectedLookupItem(valid));
      assert.equal(Object.hasOwn(document.results[0], '__typename'), false);
      assert.equal(
        Object.hasOwn(document.results[0], 'ignoredUpstreamField'),
        false
      );
      assert.deepEqual(Object.keys(document.results[0].scores), [
        'agree',
        'disagree',
        'idk',
      ]);
    }
  );
});

test('dataset projection immediately drops large extras and counts invalid rows', async () => {
  const valid = validDatasetItem({
    id: 'd'.repeat(64),
    name: '😀'.repeat(512),
    cellCount: 0,
    ignoredPadding: 'secret'.repeat(10_000),
  });
  const invalid = [
    null,
    validDatasetItem({ id: '' }),
    validDatasetItem({ id: 'd'.repeat(65) }),
    validDatasetItem({ name: 'N'.repeat(513) }),
    validDatasetItem({ cellCount: -1 }),
    validDatasetItem({ cellCount: 1.5 }),
  ];
  await withMockedFetch(
    async () => jsonResponse({ data: { results: [valid, ...invalid] } }),
    async () => {
      const response = await worker.fetch(
        capRequest('/cap/search-datasets', {
          body: JSON.stringify({ search: null, limit: 10 }),
        }),
        ENV
      );
      assert.equal(response.status, 200);
      const document = await responseDocument(response);
      assert.deepEqual(document, {
        contractVersion: 1,
        results: [{
          id: valid.id,
          name: valid.name,
          cellCount: valid.cellCount,
        }],
        omittedInvalidCount: invalid.length,
      });
      assert.doesNotMatch(JSON.stringify(document), /secret/);
    }
  );
});

test('CAP malformed envelopes and all upstream failures fail closed without APQ fallback', async (t) => {
  const scenarios = [
    {
      name: 'upstream HTTP error',
      fetch: async () =>
        jsonResponse({ message: 'upstream secret' }, 429, {
          'Retry-After': '60',
          'Set-Cookie': 'secret=value',
        }),
    },
    {
      name: 'persisted query error',
      fetch: async () =>
        jsonResponse({
          errors: [{ message: 'PersistedQueryNotFound upstream secret' }],
        }),
    },
    {
      name: 'null data',
      fetch: async () => jsonResponse({ data: null }),
    },
    {
      name: 'wrong root owner',
      fetch: async () => jsonResponse({ data: { lookupCells: {} } }),
    },
    {
      name: 'more rows than requested',
      fetch: async () =>
        jsonResponse({
          data: {
            lookupCells: [validLookupItem(), validLookupItem({ id: '43' })],
          },
        }),
    },
    {
      name: 'duplicate JSON keys',
      fetch: async () =>
        new Response(
          '{"data":{"lookupCells":[]},"\\u0064ata":{"lookupCells":[]}}',
          { status: 200 }
        ),
    },
    {
      name: 'invalid JSON',
      fetch: async () => new Response('not json', { status: 200 }),
    },
    {
      name: 'UTF-8 BOM',
      fetch: async () =>
        new Response(
          '\ufeff{"data":{"lookupCells":[]}}',
          { status: 200 }
        ),
    },
    {
      name: 'network error',
      fetch: async () => {
        throw new TypeError('upstream secret network failure');
      },
    },
    {
      name: 'independent upstream abort',
      fetch: async () => {
        throw new DOMException('upstream secret abort', 'AbortError');
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      let upstreamCalls = 0;
      await withMockedFetch(async (...args) => {
        upstreamCalls += 1;
        return scenario.fetch(...args);
      }, async () => {
        const response = await worker.fetch(
          capRequest('/cap/lookup-cells'),
          ENV
        );
        assert.equal(response.status, 502);
        const document = await responseDocument(response);
        assert.deepEqual(Object.keys(document), ['error']);
        assert.equal(typeof document.error, 'string');
        assert.doesNotMatch(document.error, /secret/i);
        assert.equal(response.headers.get('Retry-After'), null);
        assert.equal(response.headers.get('Set-Cookie'), null);
        assert.equal(upstreamCalls, 1);
      });
    });
  }
});

test('CAP cancels non-success bodies before parsing and preserves a generic failure', async (t) => {
  for (const cancellationFails of [false, true]) {
    await t.test(
      cancellationFails ? 'hostile cancellation' : 'successful cancellation',
      async () => {
        let cancellationAttempts = 0;
        let readerCalls = 0;
        await withMockedFetch(
          async () => ({
            body: {
              cancel() {
                cancellationAttempts += 1;
                if (cancellationFails) {
                  throw new Error('upstream secret cancellation failure');
                }
              },
              getReader() {
                readerCalls += 1;
                throw new Error('non-success body must not be parsed');
              },
            },
            headers: new Headers({
              'Content-Length': String(CAP_RESPONSE_BODY_MAX_BYTES + 1),
            }),
            ok: false,
            status: 503,
          }),
          async () => {
            const response = await worker.fetch(
              capRequest('/cap/lookup-cells'),
              ENV
            );
            assert.equal(response.status, 502);
            assert.deepEqual(await responseDocument(response), {
              error: 'CAP upstream request failed',
            });
          }
        );
        assert.equal(cancellationAttempts, 1);
        assert.equal(readerCalls, 0);
      }
    );
  }
});

test('CAP preflights and cancels oversized canonical Content-Length', async (t) => {
  for (const cancellationFails of [false, true]) {
    await t.test(
      cancellationFails ? 'hostile cancellation' : 'successful cancellation',
      async () => {
        let cancellationAttempts = 0;
        let readerCalls = 0;
        await withMockedFetch(
          async () => ({
            body: {
              cancel() {
                cancellationAttempts += 1;
                if (cancellationFails) {
                  return Promise.reject(
                    new Error('upstream secret cancellation rejection')
                  );
                }
                return Promise.resolve();
              },
              getReader() {
                readerCalls += 1;
                throw new Error('oversized body must not be parsed');
              },
            },
            headers: new Headers({
              'Content-Length': String(CAP_RESPONSE_BODY_MAX_BYTES + 1),
            }),
            ok: true,
            status: 200,
          }),
          async () => {
            const response = await worker.fetch(
              capRequest('/cap/lookup-cells'),
              ENV
            );
            assert.equal(response.status, 502);
            assert.deepEqual(await responseDocument(response), {
              error: 'CAP upstream response was invalid',
            });
          }
        );
        assert.equal(cancellationAttempts, 1);
        assert.equal(readerCalls, 0);
      }
    );
  }
});

test('CAP response cancellation yields to caller abort ownership', async () => {
  const caller = new AbortController();
  const cancellationStarted = deferred();
  const cancellationRelease = deferred();
  let cancellationAttempts = 0;
  await withMockedFetch(
    async () => ({
      body: {
        cancel() {
          cancellationAttempts += 1;
          cancellationStarted.resolve();
          return cancellationRelease.promise;
        },
      },
      headers: new Headers(),
      ok: false,
      status: 503,
    }),
    async () => {
      const workerPromise = worker.fetch(
        capRequest('/cap/lookup-cells', { signal: caller.signal }),
        ENV
      );
      await cancellationStarted.promise;
      caller.abort(new DOMException('caller secret', 'AbortError'));
      try {
        const response = await workerPromise;
        assert.equal(response.status, 499);
      } finally {
        cancellationRelease.resolve();
      }
    }
  );
  assert.equal(cancellationAttempts, 1);
});

test('CAP attempts body cancellation when caller abort wins the preflight race', async () => {
  const caller = new AbortController();
  let cancellationAttempts = 0;
  let readerCalls = 0;
  await withMockedFetch(
    async () => ({
      body: {
        cancel() {
          cancellationAttempts += 1;
        },
        getReader() {
          readerCalls += 1;
          throw new Error('aborted response body must not be parsed');
        },
      },
      headers: new Headers(),
      get ok() {
        caller.abort(new DOMException('caller secret', 'AbortError'));
        return false;
      },
      status: 503,
    }),
    async () => {
      const response = await worker.fetch(
        capRequest('/cap/lookup-cells', { signal: caller.signal }),
        ENV
      );
      assert.equal(response.status, 499);
    }
  );
  assert.equal(cancellationAttempts, 1);
  assert.equal(readerCalls, 0);
});

test('CAP cancels an upstream streamed byte overrun', async () => {
  let overrunCancellations = 0;
  let overrunPull = 0;
  const oversizedBody = new ReadableStream({
    pull(controller) {
      overrunPull += 1;
      if (overrunPull === 1) {
        controller.enqueue(new Uint8Array(CAP_RESPONSE_BODY_MAX_BYTES));
      } else if (overrunPull === 2) {
        controller.enqueue(Uint8Array.of(0x61));
      }
    },
    cancel() {
      overrunCancellations += 1;
    },
  });
  await withMockedFetch(
    async () => new Response(oversizedBody, { status: 200 }),
    async () => {
      const response = await worker.fetch(
        capRequest('/cap/lookup-cells'),
        ENV
      );
      assert.equal(response.status, 502);
      assert.equal(overrunCancellations, 1);
    }
  );
});

test('CAP request cancellation and deadline own the exact upstream signal', async () => {
  const preAborted = new AbortController();
  preAborted.abort(new DOMException('caller secret', 'AbortError'));
  let upstreamCalls = 0;
  await withMockedFetch(async () => {
    upstreamCalls += 1;
    return jsonResponse({ data: { lookupCells: [] } });
  }, async () => {
    const response = await worker.fetch(
      capRequest('/cap/lookup-cells', { signal: preAborted.signal }),
      ENV
    );
    assert.equal(response.status, 499);
    assert.equal(upstreamCalls, 0);
  });

  const caller = new AbortController();
  const callerFetchStarted = deferred();
  await withMockedFetch(async (_url, options = {}) => {
    const signal = options.signal;
    callerFetchStarted.resolve(signal);
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(new DOMException('owned upstream abort', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }, async () => {
    const workerPromise = worker.fetch(
      capRequest('/cap/lookup-cells', { signal: caller.signal }),
      ENV
    );
    const upstreamSignal = await callerFetchStarted.promise;
    caller.abort(new DOMException('caller secret', 'AbortError'));
    assert.equal(upstreamSignal.aborted, true);
    const response = await workerPromise;
    assert.equal(response.status, 499);
  });

  const timers = installFakeTimers();
  const deadlineFetchStarted = deferred();
  let deadlineWorkerPromise = null;
  try {
    await withMockedFetch(async (_url, options = {}) => {
      const signal = options.signal;
      deadlineFetchStarted.resolve(signal);
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          signal.removeEventListener('abort', onAbort);
          reject(new DOMException('owned deadline abort', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }, async () => {
      deadlineWorkerPromise = worker.fetch(
        capRequest('/cap/lookup-cells'),
        ENV
      );
      const upstreamSignal = await deadlineFetchStarted.promise;
      assert.equal(timers.records.length, 1);
      assert.equal(timers.records[0].delay, WORKER_DEADLINE_MS);
      timers.fire(timers.records[0]);
      assert.equal(upstreamSignal.aborted, true);
      const response = await deadlineWorkerPromise;
      assert.equal(response.status, 504);
      assert.equal(timers.records[0].cleared, true);
    });
  } finally {
    if (deadlineWorkerPromise !== null) await deadlineWorkerPromise;
    timers.restore();
  }
});
