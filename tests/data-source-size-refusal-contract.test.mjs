/**
 * A payload refused for its size must be reported as a size refusal.
 *
 * A document has no fixed ceiling: one is refused for its size only when the
 * browser cannot allocate or decode it, which happens to perfectly well-formed
 * files that are simply too big for this machine. Every advice the app can
 * give about a size refusal is wrong unless it says so:
 *
 * - "Write it again" (the `unreadable` row) sends the user to regenerate a
 *   valid file and meet the identical wall again;
 * - "Check your network" (the `unreachable` row) blames a connection that
 *   worked well enough to deliver more bytes than the app would accept;
 * - the unclassified shape ("Try again; if it keeps failing…") offers a retry
 *   that is guaranteed to fail, and pastes the raw byte-count diagnostic in.
 *
 * The refusal is owned by `readBoundedBody()` and `allocatePayloadBytes()`, so
 * that is where the cause is named. Everything downstream — `fetchJson()`, the
 * remote transport, the failure sentence — reads the published code rather than
 * re-deriving it (CEL-0219).
 */

import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DataSourceError,
  DataSourceErrorCode,
  ERROR_MESSAGES,
  allocatePayloadBytes,
  fetchJson,
  readBoundedBody,
} from '../assets/js/data/data-source.js';
import { RemoteDataSource } from '../assets/js/data/remote-source.js';
import {
  classifyDataSourceFailure,
  dataSourceFailureDetails,
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

/** A JSON response, read while text decoding is made to hit the engine's
 * longest-string limit, the one real limit left on a metadata document. */
function longestTextJsonResponse() {
  return new Response('{"padding": "x"}', {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function hitLongestString(t) {
  const decode = TextDecoder.prototype.decode;
  TextDecoder.prototype.decode = function decodePastLongestString() {
    throw new RangeError('Invalid string length');
  };
  t.after(() => {
    TextDecoder.prototype.decode = decode;
  });
}

test('the layer that owns the byte ceiling names the cause it refused for', async () => {
  assert.equal(DataSourceErrorCode.TOO_LARGE, 'TOO_LARGE');
  assert.match(
    ERROR_MESSAGES[DataSourceErrorCode.TOO_LARGE],
    /\S/,
    'every code must carry a user-facing fallback message'
  );

  // A declared length the browser cannot hold, at its allocation.
  const declared = () => allocatePayloadBytes(
    2 ** 52,
    'Payload obsm/0/0-1-2'
  );
  assert.throws(declared, DataSourceError);
  assert.throws(declared, error => {
    assert.equal(error.code, DataSourceErrorCode.TOO_LARGE);
    return true;
  });

  // A caller-contract violation is not a size refusal: nothing was measured
  // against a ceiling.
  assert.equal(
    classifyDataSourceFailure(
      new RangeError('Payload obsm/0/0-1-2: declared payload length must be')
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

test('a metadata body past the longest string keeps its size cause through fetchJson', async t => {
  installFetch(t, async () => longestTextJsonResponse());
  hitLongestString(t);

  await assert.rejects(
    fetchJson('https://untrusted.test/exports/datasets.json', 'link'),
    error => {
      assert.ok(error instanceof DataSourceError);
      assert.equal(
        error.code,
        DataSourceErrorCode.TOO_LARGE,
        'fetchJson must not relabel a size refusal as a network error'
      );
      assert.match(error.message, /longest text this browser can hold/);
      return true;
    }
  );
});

test('the remote transport reports the longest-string limit as a size refusal', async t => {
  // The real connect() path: the health document is the first thing read, and
  // `requestJson` is the reader that tells the four body-read outcomes apart.
  installFetch(t, async () => longestTextJsonResponse());
  hitLongestString(t);

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

test('a size refusal is never given the write-it-again advice', () => {
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
    /cellucid prepare|write it again/i,
    'writing the file again produces a byte-identical file and hits the same ceiling'
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
    dataSourceFailureDetails(tooLarge),
    tooLarge.message,
    'the raw byte count is kept for the notification\'s Details only'
  );
});

test('the size refusal and the format refusal no longer share a sentence', () => {
  const causes = [];
  const sentences = [];
  for (const error of [
    new DataSourceError(
      'Invalid dataset identity: stats must be an object',
      DataSourceErrorCode.INVALID_FORMAT,
      'remote'
    ),
    new DataSourceError(
      'Remote catalog name does not match the dataset identity',
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
    'a malformed file and an oversized one must not read alike'
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
    assert.doesNotMatch(sentence, /Details:/);
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
    assert.equal(dataSourceFailureDetails(error), error.message);
  }
});
