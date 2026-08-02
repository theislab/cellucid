/**
 * A payload refused for its size must be reported as a size refusal.
 *
 * The byte ceilings in `data-source.js` are the only thing standing between the
 * browser and an untrusted dataset that declares gigabytes, so they fire on
 * perfectly well-formed exports that are simply too big. Every advice the app
 * can give about a size refusal is wrong unless it says so:
 *
 * - "Re-export it with cellucid prepare" (the `unreadable` row) sends the user
 *   to regenerate a valid file and meet the identical wall again;
 * - "Check your network" (the `unreachable` row) blames a connection that
 *   worked well enough to deliver more bytes than the app would accept;
 * - the unclassified shape ("Try again; if it keeps failing…") offers a retry
 *   that is guaranteed to fail, and pastes the raw byte-count diagnostic in.
 *
 * The ceiling is owned by `readBoundedBody()` and `requirePayloadBudget()`, so
 * that is where the cause is named. Everything downstream — `fetchJson()`, the
 * remote transport, the failure sentence — reads the published code rather than
 * re-deriving it (CEL-0219).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DataSourceError,
  DataSourceErrorCode,
  ERROR_MESSAGES,
  MAX_METADATA_JSON_BYTES,
  MAX_PREPARED_BROWSER_BYTES,
  fetchJson,
  readBoundedBody,
  requirePayloadBudget,
} from '../assets/js/data/data-source.js';
import { RemoteDataSource } from '../assets/js/data/remote-source.js';
import {
  LocalUserDirDataSource,
} from '../assets/js/data/local-user-source.js';
import {
  classifyDataSourceFailure,
  dataSourceFailureDetail,
  describeDataSourceFailure,
} from '../assets/js/app/ui/modules/dataset-connections.js';

const MEGABYTE = 1024 * 1024;

function installFetch(t, handler) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  });
}

/** A JSON response whose body streams past the metadata ceiling. */
function oversizedJsonResponse(counter) {
  const filler = new Uint8Array(MEGABYTE).fill(0x20);
  const chunks = MAX_METADATA_JSON_BYTES / MEGABYTE + 4;
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(Uint8Array.of(0x7b));
        for (let index = 0; index < chunks; index++) {
          controller.enqueue(filler);
        }
        controller.enqueue(Uint8Array.of(0x7d));
        controller.close();
      },
      cancel() {
        if (counter) counter.cancelled = true;
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

test('the layer that owns the byte ceiling names the cause it refused for', async () => {
  assert.equal(DataSourceErrorCode.TOO_LARGE, 'TOO_LARGE');
  assert.match(
    ERROR_MESSAGES[DataSourceErrorCode.TOO_LARGE],
    /\S/,
    'every code must carry a user-facing fallback message'
  );

  // Declared up front, before a single byte is requested.
  const declared = () => requirePayloadBudget(
    MAX_PREPARED_BROWSER_BYTES + 1,
    'Payload points_3d.bin'
  );
  assert.throws(declared, DataSourceError);
  assert.throws(declared, error => {
    assert.equal(error.code, DataSourceErrorCode.TOO_LARGE);
    return true;
  });

  // A declared length that is not a length at all remains a caller-contract
  // violation, not a size refusal: nothing was measured against the ceiling.
  assert.throws(
    () => requirePayloadBudget(-1, 'Payload points_3d.bin'),
    RangeError
  );
  assert.equal(
    classifyDataSourceFailure(
      new RangeError('Payload points_3d.bin: declared payload length must be')
    ),
    null,
    'a caller-contract violation still publishes no cause'
  );

  // Measured mid-stream, once the body outgrows the ceiling.
  const streamed = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(64));
        controller.close();
      },
    })
  );
  await assert.rejects(
    readBoundedBody(streamed, { label: 'Metadata catalog', maxBytes: 8 }),
    error => {
      assert.ok(error instanceof DataSourceError);
      assert.equal(error.code, DataSourceErrorCode.TOO_LARGE);
      assert.match(error.message, /exceeds/i);
      return true;
    }
  );
});

test('an over-ceiling metadata body keeps its size cause through fetchJson', async t => {
  const counter = { cancelled: false };
  installFetch(t, async () => oversizedJsonResponse(counter));

  await assert.rejects(
    fetchJson('https://untrusted.test/exports/datasets.json', 'github-repo'),
    error => {
      assert.ok(error instanceof DataSourceError);
      assert.equal(
        error.code,
        DataSourceErrorCode.TOO_LARGE,
        'fetchJson must not relabel a size refusal as a network error'
      );
      return true;
    }
  );
  assert.ok(counter.cancelled, 'the oversized body must be cancelled, not buffered');
});

test('the remote transport reports its own ceiling as a size refusal', async t => {
  // The real connect() path: the health document is the first thing read, and
  // `requestJson` is the reader that tells the four body-read outcomes apart.
  installFetch(t, async () => oversizedJsonResponse());

  const source = new RemoteDataSource();
  await assert.rejects(
    source.connect({ url: 'http://127.0.0.1:8765' }),
    error => {
      assert.ok(error instanceof DataSourceError);
      assert.equal(
        error.code,
        DataSourceErrorCode.TOO_LARGE,
        'a refused-for-size response is not a failed contract validation'
      );
      return true;
    }
  );
});

test('a prepared directory refused for its size is not called malformed', async () => {
  // Same ceiling, third producer. A prepared export whose identity document is
  // over the metadata limit is a valid export that is merely too big, and it
  // reaches the same failure sentence through the dataset dropdown.
  const file = (path, contents, size = null) => {
    const blob = new Blob([contents]);
    Object.defineProperties(blob, {
      name: { configurable: true, value: path.split('/').at(-1) },
      webkitRelativePath: { configurable: true, value: path },
      ...(size === null ? {} : { size: { configurable: true, value: size } }),
    });
    return blob;
  };

  const source = new LocalUserDirDataSource();
  await assert.rejects(
    source.loadFromPreparedDirectory([
      file(
        'oversized/dataset_identity.json',
        '{}',
        MAX_METADATA_JSON_BYTES + 1
      ),
      file('oversized/obs_manifest.json', '{}'),
      file('oversized/points_2d.bin', new Uint8Array(16)),
    ]),
    error => {
      assert.ok(error instanceof DataSourceError);
      assert.equal(error.code, DataSourceErrorCode.TOO_LARGE);
      assert.doesNotMatch(
        error.message,
        /^Invalid /,
        'nothing parsed the document, so nothing may call it invalid'
      );
      assert.equal(classifyDataSourceFailure(error), 'too-large');
      return true;
    }
  );
});

test('a size refusal is never given the re-export advice', () => {
  const tooLarge = new DataSourceError(
    'Remote health response: transfer of at least 67108865 bytes exceeds '
    + 'its 67108864-byte ceiling',
    DataSourceErrorCode.TOO_LARGE,
    'remote',
    { url: 'http://127.0.0.1:8765/_cellucid/health' }
  );
  assert.equal(classifyDataSourceFailure(tooLarge), 'too-large');

  const sentence = describeDataSourceFailure(
    'The remote server',
    'could not be reached',
    tooLarge
  );
  assert.doesNotMatch(
    sentence,
    /cellucid prepare|Re-export/i,
    're-exporting produces a byte-identical file and hits the same ceiling'
  );
  assert.doesNotMatch(
    sentence,
    /network|connection/i,
    'the connection delivered more bytes than the app would accept'
  );
  assert.match(sentence, /larger/i, 'the sentence must name size as the cause');
  assert.match(sentence, /try again/i, 'every row still ends in a next step');
  assert.doesNotMatch(
    sentence,
    /https:|CORS|gzip|JSON|HTTP|Error|\d/,
    'the notice names the cause, never the transport diagnostic'
  );
  assert.equal(
    dataSourceFailureDetail(tooLarge),
    '',
    'a named cause makes the raw byte count redundant'
  );
});

test('the size refusal and the format refusal no longer share a sentence', () => {
  const causes = [];
  const sentences = [];
  for (const error of [
    new DataSourceError(
      'Invalid dataset_identity.json: stats must be an object',
      DataSourceErrorCode.INVALID_FORMAT,
      'remote'
    ),
    new DataSourceError(
      'Remote catalog name does not match dataset_identity.json',
      DataSourceErrorCode.VALIDATION_ERROR,
      'remote'
    ),
    new DataSourceError(
      'Metadata datasets.json: transfer exceeds its 67108864-byte ceiling',
      DataSourceErrorCode.TOO_LARGE,
      'remote'
    ),
  ]) {
    causes.push(classifyDataSourceFailure(error));
    sentences.push(
      describeDataSourceFailure('Sample datasets', 'could not be loaded', error)
    );
  }

  assert.deepEqual(
    causes,
    ['unreadable', 'unreadable', 'too-large'],
    'a contract violation stays unreadable; only the size refusal moves'
  );
  assert.equal(
    sentences[0],
    sentences[1],
    'the two contract violations still share one sentence'
  );
  assert.notEqual(
    sentences[2],
    sentences[0],
    'a malformed export and an oversized one must not read alike'
  );
});

test('every failure row is reachable, distinct, and shaped alike', () => {
  const reachable = new Map([
    ['not-found', new DataSourceError('x', DataSourceErrorCode.NOT_FOUND)],
    ['refused', new DataSourceError('x', DataSourceErrorCode.PERMISSION_DENIED)],
    ['rejected', new DataSourceError(
      'x', DataSourceErrorCode.NETWORK_ERROR, 'remote', { status: 400 }
    )],
    ['server', new DataSourceError(
      'x', DataSourceErrorCode.NETWORK_ERROR, 'remote', { status: 503 }
    )],
    ['unreadable', new DataSourceError('x', DataSourceErrorCode.INVALID_FORMAT)],
    ['unreachable', new DataSourceError('x', DataSourceErrorCode.NETWORK_ERROR)],
    ['too-large', new DataSourceError('x', DataSourceErrorCode.TOO_LARGE)],
  ]);

  const sentences = new Set();
  for (const [expected, error] of reachable) {
    assert.equal(
      classifyDataSourceFailure(error),
      expected,
      `nothing reaches the "${expected}" row any more`
    );
    const sentence = describeDataSourceFailure(
      'Sample datasets',
      'could not be loaded',
      error
    );
    // Every classified row is one clause, not the full-stop shape the
    // unclassified fallback uses, and none of them carries a raw detail.
    assert.match(sentence, /^Sample datasets could not be loaded: /);
    assert.match(sentence, /try again/i);
    assert.equal(dataSourceFailureDetail(error), '');
    sentences.add(sentence);
  }
  assert.equal(
    sentences.size,
    reachable.size,
    'two rows must never produce the same sentence'
  );
});

test('the unclassified shape keeps exactly the cases it had', () => {
  // A cancelled request publishes no code, and neither does a broken invariant.
  // Both must stay in the "Details: …" shape rather than being handed a cause.
  const cancelled = new Error('Dataset metadata loading was cancelled');
  cancelled.name = 'AbortError';
  for (const error of [
    cancelled,
    new TypeError('Failed to fetch'),
    new Error('candidate factory rejected'),
  ]) {
    assert.equal(classifyDataSourceFailure(error), null);
    assert.match(
      describeDataSourceFailure('Sample datasets', 'could not be loaded', error),
      /^Sample datasets could not be loaded\. Try again;/
    );
    assert.match(dataSourceFailureDetail(error), /^ Details: /);
  }
});
