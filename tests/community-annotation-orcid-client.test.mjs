import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fetchOrcidExpandedSearch,
  fetchOrcidPerson,
  ORCID_RESPONSE_MAX_UTF8_BYTES,
} from '../assets/js/app/community-annotations/orcid-client.js';
import { createHostBook } from '../assets/js/formats/io/hosts.js';
import { ResponseClock } from '../assets/js/formats/io/link.js';
import { virtualTime } from './helpers/virtual-time.mjs';

/** A transport on virtual time: retries and stall timeouts run their real logic, every wait instant. */
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
  // The request runs on its own signal, which the caller's ends.
  assert.ok(request.options.signal instanceof AbortSignal);
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

test('an ORCID response above the ceiling is refused', async () => {
  const { transport } = virtualTransport(async () => new Response(
    new Uint8Array(ORCID_RESPONSE_MAX_UTF8_BYTES + 1).fill(0x20),
    { status: 200 }
  ));
  await assert.rejects(
    () => fetchOrcidExpandedSearch('oversized', { transport }),
    error => error?.code === 'ORCID_RESPONSE_TOO_LARGE'
  );
});

test('invalid UTF-8 and a UTF-8 BOM are refused, not decoded leniently', async () => {
  for (const bytes of [
    new Uint8Array([0x7b, 0xff, 0x7d]),
    new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"expanded-result":[]}')]),
  ]) {
    const { transport } = virtualTransport(async () => new Response(bytes, { status: 200 }));
    await assert.rejects(
      () => fetchOrcidExpandedSearch('bad bytes', { transport }),
      error => error?.code === 'ORCID_RESPONSE_INVALID'
    );
  }
});

test('a busy ORCID is asked again; a refusal is reported once', async () => {
  const answers = [
    () => new Response('', { status: 503 }),
    () => new Response(JSON.stringify({ 'expanded-result': [] }), { status: 200 }),
  ];
  const busy = virtualTransport(async () => answers.shift()());
  assert.deepEqual(await fetchOrcidExpandedSearch('busy', { transport: busy.transport }), []);
  assert.equal(answers.length, 0);

  let calls = 0;
  const refusing = virtualTransport(async () => {
    calls += 1;
    return new Response('', { status: 404 });
  });
  await assert.rejects(
    () => fetchOrcidPerson('0000-0001-5109-3700', { transport: refusing.transport }),
    /ORCID lookup failed \(HTTP 404\)/
  );
  assert.equal(calls, 1);
});

test("a silent ORCID stalls instead of hanging; the caller's abort is exact", async () => {
  const silent = virtualTransport((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  }));
  await assert.rejects(
    () => fetchOrcidExpandedSearch('silent', { transport: silent.transport }),
    error => error?.code === 'stalled' || error?.code === 'network' || /no answer/.test(error?.message ?? '')
  );

  const controller = new AbortController();
  const reason = new Error('superseded ORCID search');
  reason.name = 'AbortError';
  const hanging = virtualTransport((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  }));
  const pending = fetchOrcidExpandedSearch('abort me', { signal: controller.signal, transport: hanging.transport });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
});
