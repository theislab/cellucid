import assert from 'node:assert/strict';
import test from 'node:test';

import {
  searchCellTypes,
} from '../assets/js/app/community-annotations/cap-api.js';
import { getGitHubWorkerOrigin } from '../assets/js/app/community-annotations/github-auth.js';
import { createHostBook } from '../assets/js/formats/io/hosts.js';
import { ResponseClock } from '../assets/js/formats/io/link.js';
import { virtualTime } from './helpers/virtual-time.mjs';
import {
  mergeCapMarkerGenes,
  parseMarkerGenesInput,
  reconcileEditedMarkerChange,
} from '../assets/js/app/ui/modules/community-annotation-voting-modal.js';

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
      contractVersion: 3,
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

/**
 * A transport on virtual time (`tests/helpers/virtual-time.mjs`): retries,
 * budgets and stall timeouts run their real logic, and every wait is
 * instant, so no test here waits on a real timer.
 */
function virtualTransport(fetchImpl) {
  const time = virtualTime();
  return {
    time,
    transport: {
      fetch: fetchImpl,
      hosts: createHostBook({ now: time.now, after: time.after }),
      clock: new ResponseClock({ clock: time.now, after: time.after }),
    },
  };
}

test('CAP names an older Worker as one to redeploy, any other version as incompatible', async () => {
  for (const [contractVersion, code, words] of [
    [2, 'GITHUB_WORKER_OUTDATED', /older version \(contract 2\).*redeploy/],
    [4, 'GITHUB_WORKER_INCOMPATIBLE', /reload Cellucid/],
    ['3', 'GITHUB_WORKER_INCOMPATIBLE', /does not match/],
  ]) {
    const { transport } = virtualTransport(async () => new Response(JSON.stringify({
      contractVersion,
      results: [],
      omittedInvalidCount: 0,
    }), { status: 200 }));
    await assert.rejects(
      () => searchCellTypes('T cell', 10, { transport }),
      error => error?.code === code && words.test(error.message),
    );
  }
});

test('CAP classifies every missing proxy route before parsing its body', async (t) => {
  for (const body of [
    JSON.stringify({ error: 'Route not found' }),
    '<!doctype html><title>Not found</title>',
    '',
  ]) {
    await t.test(body || 'empty body', async () => {
      const { transport } = virtualTransport(async () => new Response(body, { status: 404 }));
      await assert.rejects(
        () => searchCellTypes('T cell', 10, { transport }),
        error => {
          assert.equal(error?.code, 'GITHUB_WORKER_INCOMPATIBLE');
          assert.match(error?.message ?? '', /deploy the matching Cellucid Worker/);
          return true;
        }
      );
    });
  }
});

test('CAP preserves a final non-success HTTP outcome with arbitrary bodies', async (t) => {
  for (const scenario of [
    {
      name: 'exact Worker error',
      body: JSON.stringify({ error: 'CAP lookup term is not valid' }),
      message: 'CAP proxy error: HTTP 400: CAP lookup term is not valid',
    },
    {
      name: 'HTML edge response',
      body: '<!doctype html><title>Bad request</title>',
      message: 'CAP proxy error: HTTP 400',
    },
    {
      name: 'oversized Worker error detail',
      body: JSON.stringify({ error: 'E'.repeat(513) }),
      message: 'CAP proxy error: HTTP 400',
    },
    {
      name: 'empty edge response',
      body: '',
      message: 'CAP proxy error: HTTP 400',
    },
  ]) {
    await t.test(scenario.name, async () => {
      let calls = 0;
      const { transport } = virtualTransport(async () => {
        calls += 1;
        return new Response(scenario.body, { status: 400 });
      });
      await assert.rejects(
        () => searchCellTypes('T cell', 10, { transport }),
        error => error?.message === scenario.message && error.status === 400
      );
      assert.equal(calls, 1, 'a refusal is not asked again');
    });
  }
});

test('CAP asks again while the Worker is busy or rate limited, paced by what it says', async () => {
  const answers = [
    () => new Response(JSON.stringify({ error: 'busy' }), { status: 503 }),
    () => new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
      status: 429,
      headers: { 'Retry-After': '30', 'Content-Type': 'application/json', 'Content-Length': '31' },
    }),
    () => capResponse([capResult()]),
  ];
  const { transport, time } = virtualTransport(async () => answers.shift()());
  const envelope = await searchCellTypes('T cell', 10, { transport });
  assert.deepEqual(envelope.results, [capResult()]);
  assert.equal(answers.length, 0);
  // The 429's Retry-After was waited for exactly.
  assert.ok(time.now() >= 30_000, `waited ${time.now()} ms`);
});

test('CAP waits for a slow answer that keeps arriving, and gives up on a silent one', async () => {
  // A body that delivers a byte every second for 21 s: never silent for a stall window.
  const body = JSON.stringify({ contractVersion: 3, results: [capResult()], omittedInvalidCount: 0 });
  const slow = virtualTransport(async () => new Response(new ReadableStream({
    async start(controller) {
      const bytes = new TextEncoder().encode(body);
      const step = Math.ceil(bytes.length / 21);
      for (let at = 0; at < bytes.length; at += step) {
        await slow.time.sleep(1000);
        controller.enqueue(bytes.slice(at, at + step));
      }
      controller.close();
    },
  }), { status: 200 }));
  const envelope = await searchCellTypes('T cell', 10, { transport: slow.transport });
  assert.deepEqual(envelope.results, [capResult()]);
  assert.ok(slow.time.now() >= 21_000);

  // A Worker that never answers: stalled, asked again with growing patience, then reported.
  let calls = 0;
  const silent = virtualTransport((_url, init) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  });
  await assert.rejects(
    () => searchCellTypes('T cell', 10, { transport: silent.transport }),
    error => error?.code === 'GITHUB_WORKER_UNREACHABLE' && error.transient === true,
  );
  assert.ok(calls >= 2, `asked ${calls} times`);
});

test('CAP owner aborts are exact before and during fetch', async (t) => {
  await t.test('pre-aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('retired detail');
    reason.name = 'AbortError';
    controller.abort(reason);
    let fetchCalled = false;
    const { transport } = virtualTransport(async () => {
      fetchCalled = true;
      return capResponse([]);
    });
    await assert.rejects(
      () => searchCellTypes('T cell', 10, { signal: controller.signal, transport }),
      error => error === reason
    );
    assert.equal(fetchCalled, false);
  });

  await t.test('in flight', async () => {
    const controller = new AbortController();
    const reason = new Error('superseded form search');
    reason.name = 'AbortError';
    const { transport } = virtualTransport(async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'));
      }, { once: true });
    }));
    const pending = searchCellTypes('T cell', 10, { signal: controller.signal, transport });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(reason);
    await assert.rejects(pending, error => error === reason);
  });
});

test('CAP rejects a UTF-8 BOM instead of accepting an alternate JSON wire form', async () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(
    JSON.stringify({ contractVersion: 3, results: [], omittedInvalidCount: 0 })
  )]);
  const { transport } = virtualTransport(async () => new Response(bytes, { status: 200 }));
  await assert.rejects(
    () => searchCellTypes('T cell', 10, { transport }),
    error => error?.code === 'CAP_RESPONSE_INVALID'
  );
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
