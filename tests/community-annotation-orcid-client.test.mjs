import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fetchOrcidExpandedSearch,
  fetchOrcidPerson,
  ORCID_RESPONSE_MAX_UTF8_BYTES,
  readBoundedOrcidJson,
} from '../assets/js/app/community-annotations/orcid-client.js';

async function withFetch(fetchImpl, operation) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await operation();
  } finally {
    globalThis.fetch = previousFetch;
  }
}

function expandedResult(orcid, given, family) {
  return {
    'orcid-id': orcid,
    'given-names': given,
    'family-names': family,
  };
}

test('expanded ORCID search sends the exact private bounded request and projection', async () => {
  const controller = new AbortController();
  let request = null;
  const result = await withFetch(
    async (url, options) => {
      request = { url: String(url), options };
      return new Response(JSON.stringify({
        'expanded-result': [
          expandedResult(
            '0000-0002-1825-0097',
            'Alice',
            'Researcher'
          ),
        ],
      }), { status: 200 });
    },
    () => fetchOrcidExpandedSearch('Alice Researcher', {
      signal: controller.signal,
    })
  );

  assert.equal(
    request.url,
    'https://pub.orcid.org/v3.0/expanded-search/' +
      '?q=Alice%20Researcher&rows=8'
  );
  assert.deepEqual(request.options.headers, {
    Accept: 'application/vnd.orcid+json',
  });
  assert.equal(request.options.signal, controller.signal);
  assert.equal(request.options.cache, 'no-store');
  assert.equal(request.options.credentials, 'omit');
  assert.equal(request.options.mode, 'cors');
  assert.equal(request.options.referrerPolicy, 'no-referrer');
  assert.deepEqual(result, [{
    orcid: '0000-0002-1825-0097',
    name: 'Alice Researcher',
  }]);
});

test('direct ORCID lookup uses the same bounded strict response path', async () => {
  const result = await withFetch(
    async () => new Response(JSON.stringify({
      name: {
        'given-names': { value: 'Ada' },
        'family-name': { value: 'Lovelace' },
      },
    }), { status: 200 }),
    () => fetchOrcidPerson('0000-0001-5109-3700')
  );
  assert.deepEqual(result, {
    name: 'Ada Lovelace',
    orcid: '0000-0001-5109-3700',
  });
});

test('ORCID JSON rejects duplicate keys before projection', async () => {
  await withFetch(
    async () => new Response(
      '{"expanded-result":[],"expanded-result":[]}',
      { status: 200 }
    ),
    () => assert.rejects(
      () => fetchOrcidExpandedSearch('duplicate keys'),
      error =>
        error?.code === 'ORCID_RESPONSE_INVALID' &&
        /duplicate JSON object key/.test(error?.message ?? '')
    )
  );
});

test('ORCID search rejects more than eight projected records', async () => {
  const records = Array.from({ length: 9 }, (_, index) =>
    expandedResult(
      [
        '0000-0002-1825-0097',
        '0000-0001-5109-3700',
        '0000-0003-1419-2405',
        '0000-0002-9079-593X',
      ][index % 4],
      `Name ${index}`,
      null
    )
  );
  await withFetch(
    async () => new Response(JSON.stringify({
      'expanded-result': records,
    }), { status: 200 }),
    () => assert.rejects(
      () => fetchOrcidExpandedSearch('too many records'),
      /more than the requested 8 results/
    )
  );
});

test('known oversized ORCID response cancels before opening its reader', async () => {
  let cancelled = false;
  let readerOpened = false;
  const response = {
    headers: {
      get(name) {
        return name.toLowerCase() === 'content-length'
          ? String(ORCID_RESPONSE_MAX_UTF8_BYTES + 1)
          : null;
      },
    },
    body: {
      async cancel() {
        cancelled = true;
      },
      getReader() {
        readerOpened = true;
        throw new Error('reader must not open');
      },
    },
  };

  await assert.rejects(
    () => readBoundedOrcidJson(response, {
      label: 'ORCID synthetic response',
    }),
    error => error?.code === 'ORCID_RESPONSE_TOO_LARGE'
  );
  assert.equal(cancelled, true);
  assert.equal(readerOpened, false);
});

test('streaming ORCID overrun and invalid UTF-8 cancel the live reader', async (t) => {
  await t.test('overrun', async () => {
    let reads = 0;
    let cancelled = false;
    const response = {
      headers: { get: () => null },
      body: {
        getReader() {
          return {
            async read() {
              reads += 1;
              return {
                done: false,
                value: new Uint8Array(
                  reads === 1 ? ORCID_RESPONSE_MAX_UTF8_BYTES : 1
                ),
              };
            },
            async cancel() {
              cancelled = true;
            },
            releaseLock() {},
          };
        },
      },
    };
    await assert.rejects(
      () => readBoundedOrcidJson(response, {
        label: 'ORCID synthetic response',
      }),
      error => error?.code === 'ORCID_RESPONSE_TOO_LARGE'
    );
    assert.equal(cancelled, true);
  });

  await t.test('invalid UTF-8', async () => {
    let cancelled = false;
    const response = {
      headers: { get: () => null },
      body: {
        getReader() {
          return {
            async read() {
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
    };
    await assert.rejects(
      () => readBoundedOrcidJson(response, {
        label: 'ORCID synthetic response',
      }),
      error => error?.code === 'ORCID_RESPONSE_INVALID'
    );
    assert.equal(cancelled, true);
  });
});

test('owner abort remains the exact first cause and cancels a failed live reader', async () => {
  const controller = new AbortController();
  const reason = new DOMException(
    'Synthetic ORCID modal was superseded',
    'AbortError'
  );
  let cancelled = false;
  const transportFailure = new Error('synthetic reader failure');
  const response = {
    headers: { get: () => null },
    body: {
      getReader() {
        return {
          async read() {
            controller.abort(reason);
            throw transportFailure;
          },
          async cancel() {
            cancelled = true;
          },
          releaseLock() {},
        };
      },
    },
  };

  await assert.rejects(
    () => readBoundedOrcidJson(response, {
      label: 'ORCID synthetic response',
      signal: controller.signal,
    }),
    error => error === reason
  );
  assert.equal(cancelled, true);
});

test('a pre-aborted bounded read cancels its owned response before opening a reader', async () => {
  const controller = new AbortController();
  const reason = new DOMException(
    'Synthetic ORCID owner already closed',
    'AbortError'
  );
  controller.abort(reason);
  let cancelled = false;
  let readerOpened = false;
  const response = {
    headers: { get: () => null },
    body: {
      async cancel() {
        cancelled = true;
      },
      getReader() {
        readerOpened = true;
        throw new Error('reader must not open after owner cancellation');
      },
    },
  };

  await assert.rejects(
    () => readBoundedOrcidJson(response, {
      label: 'ORCID synthetic response',
      signal: controller.signal,
    }),
    error => error === reason
  );
  assert.equal(cancelled, true);
  assert.equal(readerOpened, false);
});

test('an abort after fetch settlement cancels the response before its reader opens', async () => {
  const controller = new AbortController();
  const reason = new DOMException(
    'Synthetic ORCID fetch owner closed',
    'AbortError'
  );
  let cancelled = false;
  let readerOpened = false;
  const response = {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      async cancel() {
        cancelled = true;
      },
      getReader() {
        readerOpened = true;
        throw new Error('reader must not open after fetch owner cancellation');
      },
    },
  };

  await withFetch(
    async () => {
      controller.abort(reason);
      return response;
    },
    () => assert.rejects(
      () => fetchOrcidExpandedSearch(
        'Synthetic pre-reader cancellation',
        { signal: controller.signal }
      ),
      error => error === reason
    )
  );
  assert.equal(cancelled, true);
  assert.equal(readerOpened, false);
});
