import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getCommunityFeedback,
  searchCellTypes,
  searchDatasets,
} from '../assets/js/app/community-annotations/cap-api.js';
import { getGitHubWorkerOrigin } from '../assets/js/app/community-annotations/github-auth.js';
import {
  mergeCapMarkerGenes,
  parseMarkerGenesInput,
  reconcileEditedMarkerChange,
} from '../assets/js/app/ui/modules/community-annotation-voting-modal.js';

const MAX_CAP_RESPONSE_BYTES = 8 * 1024 * 1024;

function capResult(overrides = {}) {
  return {
    id: 'cap-1',
    name: 'T cell',
    fullName: 'T cell',
    ontologyTerm: 'T cell',
    ontologyTermId: 'CL:0000084',
    synonyms: [],
    markerGenes: ['CD3D'],
    canonicalMarkerGenes: ['CD3E'],
    count: 10,
    scores: { agree: 7, disagree: 2, idk: 1 },
    ...overrides,
  };
}

function capResponse(results, omittedInvalidCount = 0, init = {}) {
  return new Response(
    JSON.stringify({
      contractVersion: 1,
      results,
      omittedInvalidCount,
    }),
    { status: 200, ...init }
  );
}

async function withFetch(fetchImpl, operation) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await operation();
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test('CAP browser client calls only the fixed trusted lookup route', async () => {
  let captured = null;
  const envelope = await withFetch(
    async (url, init) => {
      captured = { url: String(url), init };
      return capResponse([capResult()], 2);
    },
    () => searchCellTypes('T cell', 10)
  );

  assert.equal(
    captured.url,
    `${getGitHubWorkerOrigin()}/cap/lookup-cells`
  );
  assert.equal(new URL(captured.url).search, '');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.credentials, 'omit');
  assert.deepEqual(captured.init.headers, {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  });
  assert.deepEqual(JSON.parse(captured.init.body), {
    kind: 'name',
    term: 'T cell',
    limit: 25,
  });
  assert.equal(captured.init.body.includes('query'), false);
  assert.equal(captured.init.body.includes('sha256Hash'), false);
  assert.deepEqual(envelope, {
    results: [capResult()],
    omittedInvalidCount: 2,
  });
});

test('CAP scoring validates first, selects the best duplicate verbatim, and is stable', async () => {
  const weaker = capResult({
    id: 'z-id',
    fullName: 'T lymphocyte',
    ontologyTermId: 'CL:shared',
    synonyms: ['T cell'],
    markerGenes: ['WEAK'],
    count: 1,
  });
  const better = capResult({
    id: 'a-id',
    fullName: 'T cell',
    ontologyTermId: 'CL:shared',
    markerGenes: ['BEST'],
    count: 5,
  });
  const stableFirst = capResult({
    id: 'same-id',
    fullName: 'B cell',
    name: 'B cell',
    ontologyTerm: 'B cell',
    ontologyTermId: 'CL:stable',
    markerGenes: ['FIRST'],
  });
  const stableSecond = {
    ...stableFirst,
    markerGenes: ['SECOND'],
  };

  const bestEnvelope = await withFetch(
    async () => capResponse([weaker, better]),
    () => searchCellTypes('T cell', 25)
  );
  assert.deepEqual(bestEnvelope.results, [better]);
  assert.deepEqual(bestEnvelope.results[0].markerGenes, ['BEST']);

  const stableEnvelope = await withFetch(
    async () => capResponse([stableFirst, stableSecond]),
    () => searchCellTypes('B cell', 25)
  );
  assert.deepEqual(stableEnvelope.results, [stableFirst]);
});

test('CAP scoring does not treat punctuation-only normalization as a universal match', async () => {
  const envelope = await withFetch(
    async () => capResponse([capResult()]),
    () => searchCellTypes('!!!', 25)
  );
  assert.deepEqual(envelope, {
    results: [],
    omittedInvalidCount: 0,
  });
});

test('CAP marker search sends its persisted kind and does not send marker arrays', async () => {
  let requestBody = null;
  await withFetch(
    async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return capResponse([capResult()]);
    },
    () => searchCellTypes('CD3D', 20, {
      kind: 'marker',
      markerGenes: ['CD3D', 'CD3E'],
    })
  );
  assert.deepEqual(requestBody, {
    kind: 'marker',
    term: 'CD3D',
    limit: 25,
  });
});

test('CAP marker ranking rejects an overlong marker gene before network access', async () => {
  let fetchCalls = 0;
  await withFetch(
    async () => {
      fetchCalls += 1;
      return capResponse([]);
    },
    () => assert.rejects(
      () => searchCellTypes('CD3D', 20, {
        kind: 'marker',
        markerGenes: ['A'.repeat(65)],
      }),
      /at most 64 Unicode code points/
    )
  );
  assert.equal(fetchCalls, 0);
});

test('CAP rejects an oversized serialized marker request before network access', async () => {
  let fetchCalls = 0;
  await withFetch(
    async () => {
      fetchCalls += 1;
      return capResponse([]);
    },
    () => assert.rejects(
      () => searchCellTypes('\u0000'.repeat(1000), 20, {
        kind: 'marker',
      }),
      error => error?.code === 'CAP_REQUEST_TOO_LARGE'
    )
  );
  assert.equal(fetchCalls, 0);
});

test('CAP rejects a semantically stale Worker response on every lookup', async () => {
  await withFetch(
    async () => new Response(JSON.stringify({
      contractVersion: 0,
      results: [],
      omittedInvalidCount: 0,
    }), { status: 200 }),
    () => assert.rejects(
      () => searchCellTypes('T cell'),
      error => error?.code === 'CAP_WORKER_INCOMPATIBLE'
    )
  );
});

test('CAP classifies every missing proxy route before parsing its body', async (t) => {
  for (const body of [
    JSON.stringify({ error: 'Route not found' }),
    '<!doctype html><title>Not found</title>',
    '',
  ]) {
    await t.test(body || 'empty body', async () => {
      await withFetch(
        async () => new Response(body, { status: 404 }),
        () => assert.rejects(
          () => searchCellTypes('T cell'),
          error => {
            assert.equal(error?.code, 'CAP_WORKER_INCOMPATIBLE');
            assert.match(
              error?.message ?? '',
              /deploy the matching Cellucid Worker/
            );
            return true;
          }
        )
      );
    });
  }
});

test('CAP preserves non-success HTTP outcomes with arbitrary bodies', async (t) => {
  for (const scenario of [
    {
      name: 'exact Worker error',
      body: JSON.stringify({ error: 'Rate limit exceeded' }),
      message: 'CAP proxy error: HTTP 429: Rate limit exceeded',
    },
    {
      name: 'HTML edge response',
      body: '<!doctype html><title>Too many requests</title>',
      message: 'CAP proxy error: HTTP 429',
    },
    {
      name: 'oversized Worker error detail',
      body: JSON.stringify({ error: 'E'.repeat(513) }),
      message: 'CAP proxy error: HTTP 429',
    },
    {
      name: 'empty edge response',
      body: '',
      message: 'CAP proxy error: HTTP 429',
    },
  ]) {
    await t.test(scenario.name, async () => {
      await withFetch(
        async () => new Response(scenario.body, { status: 429 }),
        () => assert.rejects(
          () => searchCellTypes('T cell'),
          error => error?.message === scenario.message
        )
      );
    });
  }
});

test('CAP feedback derives its total and preserves omission metadata', async () => {
  const envelope = await withFetch(
    async () => capResponse([capResult()], 3),
    () => getCommunityFeedback('T cell')
  );
  assert.deepEqual(envelope, {
    results: [{
      name: 'T cell',
      feedback: { agree: 7, disagree: 2, idk: 1 },
      total: 10,
      agreePercent: 70,
    }],
    omittedInvalidCount: 3,
  });
});

test('CAP client rejects stale-worker envelopes above each route ceiling', async (t) => {
  await t.test('lookup ceiling', async () => {
    await withFetch(
      async () => capResponse(
        Array.from({ length: 26 }, (_, index) => capResult({
          id: `cap-${index}`,
        }))
      ),
      () => assert.rejects(
        () => searchCellTypes('T cell', 25),
        /at most 25 items/
      )
    );
  });

  await t.test('dataset ceiling', async () => {
    const results = Array.from({ length: 11 }, (_, index) => ({
      id: `dataset-${index}`,
      name: `Dataset ${index}`,
      cellCount: index,
    }));
    await withFetch(
      async () => capResponse(results),
      () => assert.rejects(
        () => searchDatasets({ search: 'immune', limit: 10 }),
        /at most 10 items/
      )
    );
  });

  await t.test('caller dataset limit', async () => {
    const results = Array.from({ length: 2 }, (_, index) => ({
      id: `dataset-${index}`,
      name: `Dataset ${index}`,
      cellCount: index,
    }));
    await withFetch(
      async () => capResponse(results),
      () => assert.rejects(
        () => searchDatasets({ search: 'immune', limit: 1 }),
        /at most 1 items/
      )
    );
  });

  await t.test('lookup partition coherence', async () => {
    await withFetch(
      async () => capResponse(
        Array.from({ length: 24 }, (_, index) => capResult({
          id: `cap-${index}`,
        })),
        2
      ),
      () => assert.rejects(
        () => searchCellTypes('T cell', 25),
        /results plus omittedInvalidCount must not exceed 25/
      )
    );
  });
});

test('CAP dataset search uses the fixed dataset route and exact body', async () => {
  let captured = null;
  const result = await withFetch(
    async (url, init) => {
      captured = { url: String(url), init };
      return capResponse([{
        id: 'dataset-1',
        name: 'Immune atlas',
        cellCount: 123,
      }], 1);
    },
    () => searchDatasets({ search: 'immune', limit: 7 })
  );
  assert.equal(
    captured.url,
    `${getGitHubWorkerOrigin()}/cap/search-datasets`
  );
  assert.deepEqual(JSON.parse(captured.init.body), {
    search: 'immune',
    limit: 7,
  });
  assert.deepEqual(result, {
    results: [{
      id: 'dataset-1',
      name: 'Immune atlas',
      cellCount: 123,
    }],
    omittedInvalidCount: 1,
  });
});

test('CAP owner aborts are exact before and during fetch', async (t) => {
  await t.test('pre-aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('retired detail');
    reason.name = 'AbortError';
    controller.abort(reason);
    let fetchCalled = false;
    await withFetch(
      async () => {
        fetchCalled = true;
        return capResponse([]);
      },
      () => assert.rejects(
        () => searchCellTypes('T cell', 10, {
          signal: controller.signal,
        }),
        error => error === reason
      )
    );
    assert.equal(fetchCalled, false);
  });

  await t.test('in flight', async () => {
    const controller = new AbortController();
    const reason = new Error('superseded form search');
    reason.name = 'AbortError';
    await withFetch(
      async (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      }),
      async () => {
        const pending = searchCellTypes('T cell', 10, {
          signal: controller.signal,
        });
        controller.abort(reason);
        await assert.rejects(pending, error => error === reason);
      }
    );
  });
});

test('CAP distinguishes an independent fetch abort', async () => {
  await withFetch(
    async () => {
      throw new DOMException('transport abort', 'AbortError');
    },
    () => assert.rejects(
      () => searchCellTypes('T cell'),
      error => {
        assert.equal(error?.code, 'CAP_FETCH_ABORTED');
        assert.match(error?.message ?? '', /independently aborted/);
        return true;
      }
    )
  );
});

test('CAP response ceiling preflights and cancels an oversized body', async () => {
  let cancelled = false;
  const response = {
    headers: {
      get(name) {
        return name.toLowerCase() === 'content-length'
          ? String(MAX_CAP_RESPONSE_BYTES + 1)
          : null;
      },
    },
    body: {
      async cancel() {
        cancelled = true;
      },
    },
    ok: true,
    status: 200,
  };
  await withFetch(
    async () => response,
    () => assert.rejects(
      () => searchCellTypes('T cell'),
      error => error?.code === 'CAP_RESPONSE_TOO_LARGE'
    )
  );
  assert.equal(cancelled, true);
});

test('CAP preserves a size violation when body cancellation rejects', async () => {
  let cancelAttempts = 0;
  const response = {
    headers: {
      get: () => String(MAX_CAP_RESPONSE_BYTES + 1),
    },
    body: {
      async cancel() {
        cancelAttempts += 1;
        throw new Error('hostile cancellation failure');
      },
    },
    ok: true,
    status: 200,
  };
  await withFetch(
    async () => response,
    () => assert.rejects(
      () => searchCellTypes('T cell'),
      error => error?.code === 'CAP_RESPONSE_TOO_LARGE'
    )
  );
  assert.equal(cancelAttempts, 1);
});

test('CAP streaming response overrun cancels the reader', async () => {
  let readCount = 0;
  let cancelled = false;
  const response = {
    headers: { get: () => null },
    body: {
      getReader() {
        return {
          async read() {
            readCount += 1;
            if (readCount === 1) {
              return {
                done: false,
                value: new Uint8Array(MAX_CAP_RESPONSE_BYTES),
              };
            }
            return { done: false, value: new Uint8Array(1) };
          },
          async cancel() {
            cancelled = true;
          },
          releaseLock() {},
        };
      },
    },
    ok: true,
    status: 200,
  };
  await withFetch(
    async () => response,
    () => assert.rejects(
      () => searchCellTypes('T cell'),
      error => error?.code === 'CAP_RESPONSE_TOO_LARGE'
    )
  );
  assert.equal(cancelled, true);
});

test('CAP invalid UTF-8 cancels its response reader', async () => {
  let cancelled = false;
  let read = false;
  const response = {
    headers: { get: () => null },
    body: {
      getReader() {
        return {
          async read() {
            if (read) return { done: true, value: undefined };
            read = true;
            return {
              done: false,
              value: new Uint8Array([0xc3, 0x28]),
            };
          },
          async cancel() {
            cancelled = true;
          },
          releaseLock() {},
        };
      },
    },
    ok: true,
    status: 200,
  };
  await withFetch(
    async () => response,
    () => assert.rejects(
      () => searchCellTypes('T cell'),
      error => error?.code === 'CAP_RESPONSE_INVALID'
    )
  );
  assert.equal(cancelled, true);
});

test('CAP rejects a UTF-8 BOM instead of accepting an alternate JSON wire form', async () => {
  const json = new TextEncoder().encode(JSON.stringify({
    contractVersion: 1,
    results: [],
    omittedInvalidCount: 0,
  }));
  const bytes = new Uint8Array(json.byteLength + 3);
  bytes.set([0xef, 0xbb, 0xbf]);
  bytes.set(json, 3);
  await withFetch(
    async () => new Response(bytes, { status: 200 }),
    () => assert.rejects(
      () => searchCellTypes('T cell'),
      /CAP proxy returned invalid JSON/
    )
  );
});

test('CAP preserves invalid UTF-8 when reader cleanup is hostile', async () => {
  let cancelAttempts = 0;
  let releaseAttempts = 0;
  let read = false;
  const response = {
    headers: { get: () => null },
    body: {
      getReader() {
        return {
          async read() {
            if (read) return { done: true, value: undefined };
            read = true;
            return {
              done: false,
              value: new Uint8Array([0xc3, 0x28]),
            };
          },
          async cancel() {
            cancelAttempts += 1;
            throw new Error('hostile reader cancellation failure');
          },
          releaseLock() {
            releaseAttempts += 1;
            throw new Error('hostile reader release failure');
          },
        };
      },
    },
    ok: true,
    status: 200,
  };
  await withFetch(
    async () => response,
    () => assert.rejects(
      () => searchCellTypes('T cell'),
      error => error?.code === 'CAP_RESPONSE_INVALID'
    )
  );
  assert.equal(cancelAttempts, 1);
  assert.equal(releaseAttempts, 1);
});

test('CAP response read failure cancels its active reader', async () => {
  let cancelled = false;
  const readFailure = new Error('synthetic CAP response read failure');
  const response = {
    headers: { get: () => null },
    body: {
      getReader() {
        return {
          async read() {
            throw readFailure;
          },
          async cancel() {
            cancelled = true;
          },
          releaseLock() {},
        };
      },
    },
    ok: true,
    status: 200,
  };
  await withFetch(
    async () => response,
    () => assert.rejects(
      () => searchCellTypes('T cell'),
      error => error === readFailure
    )
  );
  assert.equal(cancelled, true);
});

test('CAP owner abort cancels a stalled response reader', async () => {
  let cancelled = false;
  let markReaderStarted;
  const readerStarted = new Promise(resolve => {
    markReaderStarted = resolve;
  });
  const controller = new AbortController();
  const reason = new Error('retired CAP response owner');
  reason.name = 'AbortError';
  await withFetch(
    async (_url, init) => ({
      headers: { get: () => null },
      body: {
        getReader() {
          return {
            read() {
              markReaderStarted();
              return new Promise((resolve, reject) => {
                init.signal.addEventListener('abort', () => {
                  reject(new DOMException(
                    'Synthetic CAP response read aborted',
                    'AbortError'
                  ));
                }, { once: true });
              });
            },
            async cancel() {
              cancelled = true;
            },
            releaseLock() {},
          };
        },
      },
      ok: true,
      status: 200,
    }),
    async () => {
      const pending = searchCellTypes('T cell', 10, {
        signal: controller.signal,
      });
      await readerStarted;
      controller.abort(reason);
      await assert.rejects(pending, error => error === reason);
    }
  );
  assert.equal(cancelled, true);
});

test('CAP removes its owner abort listener when timer creation throws', async () => {
  const previousSetTimeout = globalThis.setTimeout;
  let listeners = 0;
  const signal = {
    aborted: false,
    reason: undefined,
    addEventListener(type) {
      if (type === 'abort') listeners += 1;
    },
    removeEventListener(type) {
      if (type === 'abort') listeners -= 1;
    },
  };
  globalThis.setTimeout = () => {
    throw new Error('hostile timer creation failure');
  };
  try {
    await assert.rejects(
      () => searchCellTypes('T cell', 10, { signal }),
      /hostile timer creation failure/
    );
    assert.equal(listeners, 0);
  } finally {
    globalThis.setTimeout = previousSetTimeout;
  }
});

test('CAP timeout retires its timer and owner listener before returning', async () => {
  const previousSetTimeout = globalThis.setTimeout;
  const previousClearTimeout = globalThis.clearTimeout;
  const timerHandle = Object.freeze({ timer: 'CAP timeout' });
  let listeners = 0;
  let clearCalls = 0;
  let fetchCalls = 0;
  const signal = {
    aborted: false,
    reason: undefined,
    addEventListener(type) {
      if (type === 'abort') listeners += 1;
    },
    removeEventListener(type) {
      if (type === 'abort') listeners -= 1;
    },
  };
  globalThis.setTimeout = (callback, delay) => {
    assert.equal(delay, 1);
    callback();
    return timerHandle;
  };
  globalThis.clearTimeout = handle => {
    assert.equal(handle, timerHandle);
    clearCalls += 1;
  };
  try {
    await withFetch(
      async () => {
        fetchCalls += 1;
        return capResponse([]);
      },
      () => assert.rejects(
        () => searchCellTypes('T cell', 10, {
          signal,
          timeoutMs: 1,
        }),
        error => error?.code === 'CAP_REQUEST_TIMEOUT'
      )
    );
    assert.equal(fetchCalls, 0);
    assert.equal(clearCalls, 1);
    assert.equal(listeners, 0);
  } finally {
    globalThis.setTimeout = previousSetTimeout;
    globalThis.clearTimeout = previousClearTimeout;
  }
});

test('typed marker parsing is lossless and rejects malformed or excess intent', () => {
  assert.deepEqual(
    parseMarkerGenesInput('CD3D, MS4A1, cd3d'),
    ['CD3D', 'MS4A1']
  );
  assert.throws(
    () => parseMarkerGenesInput('CD3D,,MS4A1'),
    /empty comma-separated entry/
  );
  assert.throws(
    () => parseMarkerGenesInput(`${'A'.repeat(65)}`),
    /at most 64 Unicode characters/
  );
  assert.throws(
    () => parseMarkerGenesInput(
      Array.from({ length: 51 }, (_, index) => `G${index}`).join(',')
    ),
    /at most 50 unique entries/
  );
  assert.deepEqual(parseMarkerGenesInput('🧬'.repeat(64)), ['🧬'.repeat(64)]);
});

test('CAP marker merge preserves local order and reports exact overflow metadata', () => {
  const localGenes = Array.from({ length: 49 }, (_, index) => `LOCAL${index}`);
  const merged = mergeCapMarkerGenes(
    localGenes.join(', '),
    ['local0', 'CAP-A', 'CAP-B', 'CAP-C']
  );
  assert.deepEqual(merged.genes.slice(0, 49), localGenes);
  assert.deepEqual(merged.addedGenes, ['CAP-A']);
  assert.deepEqual(merged.duplicateGenes, ['local0']);
  assert.deepEqual(merged.omittedGenes, ['CAP-B', 'CAP-C']);
  assert.equal(merged.genes.length, 50);
  assert.equal(merged.text.endsWith('CAP-A'), true);
});

test('structured marker reconciliation preserves one identity and counts every loss', () => {
  const first = { gene: 'CD3D', logFC: 1 };
  const second = { gene: 'CD3D', pval: 0.01 };
  const third = { gene: 'MS4A1', logFC: 2, pval: 0.02 };
  const reconciled = reconcileEditedMarkerChange(
    [first, second, third],
    ['CD3D']
  );
  assert.equal(reconciled.markers[0], first);
  assert.deepEqual(reconciled.lostStats, ['CD3D', 'MS4A1']);
});
