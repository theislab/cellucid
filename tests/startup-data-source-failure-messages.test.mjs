/**
 * A data-source failure must reach the user as the cause the loader already
 * published, and must never be given a cause the loader did not publish.
 *
 * The four catalog failures a user actually meets — a wrong address, a private
 * repository, an address that answers with a web page, and a dropped
 * connection — used to arrive as one sentence blaming the network. They are
 * distinguishable before the UI sees them: `DataSourceError` carries a `code`,
 * and a transport failure carries the HTTP status the server answered with.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DataSourceError,
  DataSourceErrorCode
} from '../assets/js/data/data-source.js';
import {
  classifyDataSourceFailure,
  dataSourceFailureDetail,
  describeDataSourceFailure,
  reportDataSourceFailure
} from '../assets/js/app/ui/modules/dataset-connections.js';

const CATALOG_URL = 'https://catalog.cellucid.test/exports/datasets.json';

/** Exactly what each loader produces for the failures reproduced in-browser. */
const LOADER_FAILURES = Object.freeze({
  absent: new DataSourceError(
    `Resource not found: ${CATALOG_URL}`,
    DataSourceErrorCode.NOT_FOUND,
    'local-demo',
    { url: CATALOG_URL, status: 404 }
  ),
  forbidden: new DataSourceError(
    'Failed to fetch: Forbidden',
    DataSourceErrorCode.NETWORK_ERROR,
    'local-demo',
    { url: CATALOG_URL, status: 403 }
  ),
  serverError: new DataSourceError(
    'Failed to fetch: Internal Server Error',
    DataSourceErrorCode.NETWORK_ERROR,
    'local-demo',
    { url: CATALOG_URL, status: 500 }
  ),
  rejected: new DataSourceError(
    'Failed to fetch: Bad Request',
    DataSourceErrorCode.NETWORK_ERROR,
    'local-demo',
    { url: CATALOG_URL, status: 400 }
  ),
  html: new DataSourceError(
    'Network error: Unexpected token \'<\', "<!doctype "... is not valid JSON',
    DataSourceErrorCode.NETWORK_ERROR,
    'local-demo',
    { url: CATALOG_URL, originalError: 'Unexpected token' }
  ),
  malformedCatalog: new DataSourceError(
    'Invalid datasets.json: dataset \'a\' must declare a safe relative path',
    DataSourceErrorCode.INVALID_FORMAT,
    'local-demo',
    { url: CATALOG_URL }
  ),
  offlinePayload: new TypeError('Failed to fetch'),
  corruptPayload: new Error(
    'Payload https://catalog.cellucid.test/exports/a/points_2d.bin.gz: '
    + 'invalid gzip header'
  )
});

test('the loader cause the UI can name is carried through, not replaced', () => {
  assert.equal(classifyDataSourceFailure(LOADER_FAILURES.absent), 'not-found');
  assert.equal(classifyDataSourceFailure(LOADER_FAILURES.forbidden), 'refused');
  assert.equal(
    classifyDataSourceFailure(LOADER_FAILURES.serverError),
    'server'
  );
  assert.equal(
    classifyDataSourceFailure(LOADER_FAILURES.rejected),
    'rejected'
  );
  assert.equal(
    classifyDataSourceFailure(LOADER_FAILURES.malformedCatalog),
    'unreadable'
  );
  assert.equal(
    classifyDataSourceFailure(LOADER_FAILURES.html),
    'unreachable',
    'a body that is not a dataset list and a dropped connection are one '
    + 'bucket, because fetchJson discards which of the two it was'
  );
});

test('a failure the loader did not classify is never given a cause', () => {
  // A bare TypeError is what `fetch()` rejects with when the request never
  // completed -- and also what every broken invariant in this codebase throws.
  // Calling it a network problem would be a guess.
  assert.equal(classifyDataSourceFailure(LOADER_FAILURES.offlinePayload), null);
  assert.equal(classifyDataSourceFailure(LOADER_FAILURES.corruptPayload), null);
  assert.equal(classifyDataSourceFailure(new Error('switch rejected')), null);
  assert.equal(classifyDataSourceFailure('not an error'), null);

  const described = describeDataSourceFailure(
    '"Pancreas"',
    'could not be opened',
    LOADER_FAILURES.corruptPayload
  );
  assert.equal(
    described,
    '"Pancreas" could not be opened. Try again; if it keeps failing, check '
    + 'the address and your connection.'
  );
  for (const invented of [
    /the server/i,
    /connection may have failed/i,
    /not in a format/i,
    /not found/i
  ]) {
    assert.doesNotMatch(described, invented);
  }
});

test('four distinct catalog failures no longer read as one network problem', () => {
  const sentences = ['absent', 'forbidden', 'html', 'malformedCatalog'].map(
    key => describeDataSourceFailure(
      'Sample datasets',
      'could not be loaded',
      LOADER_FAILURES[key]
    )
  );
  assert.equal(
    new Set(sentences).size,
    sentences.length,
    'a wrong address, a private repository, a non-Cellucid reply and a '
    + 'malformed list must not share one sentence'
  );
  for (const sentence of sentences) {
    assert.match(sentence, /^Sample datasets could not be loaded/);
    assert.match(sentence, /try again/i);
    assert.doesNotMatch(
      sentence,
      /https:|CORS|gzip|JSON|HTTP|Error/,
      'the notice names the cause, never the transport diagnostic'
    );
  }
  // The wrong address is the one a `?exportsBaseUrl=` typo produces, and it
  // must not send the user to check their network.
  assert.match(sentences[0], /Check the address for a typo/);
  assert.doesNotMatch(sentences[0], /Check your network/);
  assert.match(sentences[1], /refused access/);
  assert.match(sentences[3], /not in a format Cellucid can read/);
});

test('an unclassified failure keeps its raw text as a labelled detail', () => {
  assert.equal(
    dataSourceFailureDetail(LOADER_FAILURES.absent),
    '',
    'a named cause makes the raw text redundant'
  );
  assert.equal(
    reportDataSourceFailure(
      'The remote server',
      'could not be reached',
      new Error('candidate factory rejected')
    ),
    'The remote server could not be reached. Try again; if it keeps failing, '
    + 'check the address and your connection. Details: candidate factory '
    + 'rejected'
  );
  assert.match(
    reportDataSourceFailure(
      '"Pancreas"',
      'could not be opened',
      new AggregateError(
        [new Error('first cause'), new Error('second cause')],
        'recovery failed'
      )
    ),
    /Details: recovery failed Causes: first cause; second cause$/
  );
});

test('failure descriptions require an exact subject and verb', () => {
  assert.throws(
    () => describeDataSourceFailure('', 'could not be loaded', new Error('x')),
    /subject must be a non-empty string/
  );
  assert.throws(
    () => describeDataSourceFailure('Sample datasets', '', new Error('x')),
    /verb must be a non-empty string/
  );
});
