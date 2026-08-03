/**
 * A continuous payload that cannot be drawn has to say why, and the reader has
 * to be the one that says it.
 *
 * The failure this holds was reported as
 *
 *     Continuous field value 4118237 must be finite or NaN.
 *
 * for a gene, and as `Failed to load gene: A2ML1` for a gene the server refused.
 * Neither names the field, the kind of offending value, how many there were, or
 * anything to do about it, and the second does not even distinguish "never
 * arrived" from "arrived unusable". Four things are held here:
 *
 *   - `NaN` stays drawable and an infinity does not, because `NaN` has a colour
 *     (the neutral grey that means "not measured") and an infinity has no
 *     position on any scale and makes every other cell one colour;
 *   - the refusal counts every offending value in the pass that was already
 *     being made, rather than reporting the first one and stopping;
 *   - a gene and an observation column get different remedies, because they come
 *     out of different places in the object;
 *   - a transport failure is explained by status, including the one status that
 *     has a known cause here — the Python server refuses a non-finite gene
 *     before it sends a byte, and reports that refusal as a bare 500.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NON_FINITE_EXAMPLE_LIMIT,
  UndrawableContinuousPayloadError,
  createNonFiniteTally,
  explainContinuousPayloadFailure,
  hasUndrawableValues,
  recordNonFiniteValue,
} from '../assets/js/data/continuous-payload-diagnosis.js';
import {
  DataStateColorMethods,
} from '../assets/js/app/state/managers/color-manager.js';

function tallyOf(values) {
  const tally = createNonFiniteTally(values.length);
  for (let index = 0; index < values.length; index++) {
    if (!Number.isFinite(values[index])) {
      recordNonFiniteValue(tally, values[index], index);
    }
  }
  return tally;
}

function makeColorOwner(values, activeFieldSource) {
  const owner = Object.create(DataStateColorMethods.prototype);
  owner.pointCount = values.length;
  owner.activeFieldSource = activeFieldSource;
  return owner;
}

test('NaN is drawable and an infinity is not', () => {
  const withNaN = tallyOf([1, Number.NaN, 3]);
  assert.equal(withNaN.nan, 1);
  assert.equal(hasUndrawableValues(withNaN), false);

  const withInfinity = tallyOf([1, Number.POSITIVE_INFINITY, 3]);
  assert.equal(withInfinity.positiveInfinity, 1);
  assert.equal(hasUndrawableValues(withInfinity), true);

  const withNegative = tallyOf([1, Number.NEGATIVE_INFINITY, 3]);
  assert.equal(withNegative.negativeInfinity, 1);
  assert.equal(hasUndrawableValues(withNegative), true);
});

test('the tally counts every offender and names a bounded few', () => {
  const values = new Array(64).fill(1);
  for (let index = 0; index < 20; index++) {
    values[index * 3] = index % 2 === 0
      ? Number.POSITIVE_INFINITY
      : Number.NEGATIVE_INFINITY;
  }
  values[1] = Number.NaN;
  const tally = tallyOf(values);

  assert.equal(tally.positiveInfinity + tally.negativeInfinity, 20);
  assert.equal(tally.nan, 1);
  assert.equal(tally.total, 64);
  assert.equal(tally.examples.length, NON_FINITE_EXAMPLE_LIMIT);
  assert.deepEqual(tally.examples, [0, 3, 6, 9, 12]);
  // The NaN index must not appear: NaN is not an offender, it is a value.
  assert.equal(tally.examples.includes(1), false);
});

test('a gene and a field are given different remedies', () => {
  const tally = tallyOf([1, Number.POSITIVE_INFINITY]);
  const geneMessage = new UndrawableContinuousPayloadError({
    subject: { kind: 'gene', name: 'A2ML1' },
    tally,
  }).message;
  const fieldMessage = new UndrawableContinuousPayloadError({
    subject: { kind: 'field', name: 'HPCA_entropy_Level_1' },
    tally,
  }).message;

  assert.match(geneMessage, /^Gene "A2ML1" contains 1 infinite value,/);
  assert.match(geneMessage, /adata\.X/);
  assert.doesNotMatch(geneMessage, /adata\.obs/);
  assert.match(fieldMessage, /^Field "HPCA_entropy_Level_1" contains/);
  assert.match(fieldMessage, /adata\.obs\["HPCA_entropy_Level_1"\]/);
  for (const message of [geneMessage, fieldMessage]) {
    assert.match(message, /Of 2 cells: 1 \+Infinity\./);
    assert.match(message, /First affected cell: 1\./);
    assert.match(message, /NaN is drawn as missing/);
  }
});

test('a payload with no value at all is a different diagnosis', () => {
  const error = new UndrawableContinuousPayloadError({
    subject: { kind: 'gene', name: 'EMPTY' },
    tally: tallyOf([Number.NaN, Number.NaN, Number.NaN]),
  });
  assert.equal(error.isEmptyPayload, true);
  assert.match(error.message, /has no value in any of 3 cells/);
  assert.match(error.message, /not measured here/);
  assert.doesNotMatch(error.message, /infinite/);
});

test('the reader refuses an infinite field and names it, in one pass', () => {
  const values = new Float32Array([0.5, Number.POSITIVE_INFINITY, 2, 3]);
  const owner = makeColorOwner(values, 'var');
  assert.throws(
    () => owner.ensureContinuousMetadata({
      kind: 'continuous',
      key: 'A2ML1',
      values,
    }),
    error => {
      assert.ok(error instanceof UndrawableContinuousPayloadError);
      assert.equal(error.subject.kind, 'gene');
      assert.equal(error.subject.name, 'A2ML1');
      assert.equal(error.tally.positiveInfinity, 1);
      assert.equal(error.tally.total, 4);
      return true;
    },
  );

  // An observation column takes the same route and is described as a field.
  const obsOwner = makeColorOwner(values, 'obs');
  assert.throws(
    () => obsOwner.ensureContinuousMetadata({
      kind: 'continuous',
      key: 'HPCA_entropy_Level_1',
      values,
    }),
    error => {
      assert.match(
        error.message,
        /^Field "HPCA_entropy_Level_1" contains/,
      );
      return true;
    },
  );
});

test('the reader still accepts a field that is partly missing', () => {
  const values = new Float32Array([Number.NaN, 1, Number.NaN, 4]);
  const owner = makeColorOwner(values, 'var');
  const meta = owner.ensureContinuousMetadata({
    kind: 'continuous',
    key: 'PARTIAL',
    values,
  });
  assert.deepEqual(meta.stats, { min: 1, max: 4 });
});

test('a transport failure is explained by status, with the server quoted', () => {
  const subject = { kind: 'gene', name: 'A2ML1' };
  const refused = Object.assign(
    new Error('Failed to load remote://host/var/0.values.f32: Internal Server Error — Internal server error'),
    { status: 500, serverDetail: 'Internal server error' },
  );
  const message = explainContinuousPayloadFailure({ subject, error: refused });
  assert.match(message, /^Gene "A2ML1" could not be loaded: the server answered 500\./);
  assert.match(message, /The server said: Internal server error/);
  assert.match(message, /refuses a gene containing NaN or ±Infinity/);
  assert.match(message, /A server new enough to say so answers 422/);
  assert.match(message, /prints the reason to its own console/);

  const missing = Object.assign(new Error('Failed to load x: Not Found'), {
    status: 404,
    serverDetail: null,
  });
  const missingMessage = explainContinuousPayloadFailure({
    subject,
    error: missing,
  });
  assert.match(missingMessage, /does not have this payload/);
  assert.doesNotMatch(missingMessage, /The server said/);

  // A server new enough to diagnose the column answers 422 and puts the counted
  // reason in the body, so the classification adds only what the body cannot.
  const refusedPrecisely = Object.assign(
    new Error('Failed to load remote://host/var/0.values.f32: Unprocessable Content'),
    {
      status: 422,
      serverDetail:
        "Gene 'A2ML1' cannot be published: of 18,142,044 cells, 4,118,237 NaN. "
        + 'First affected cells: 3, 11, 12, 19, 24, ... Cellucid publishes '
        + 'finite float32 only.',
    },
  );
  const preciseMessage = explainContinuousPayloadFailure({
    subject,
    error: refusedPrecisely,
  });
  assert.match(preciseMessage, /the server answered 422\./);
  assert.match(preciseMessage, /4,118,237 NaN/);
  assert.match(preciseMessage, /examined this payload and will not publish it/);
  assert.doesNotMatch(
    preciseMessage,
    /most often/,
    'a server that named the cause must not be second-guessed',
  );

  const unclassified = Object.assign(new Error('Failed to load x: Teapot'), {
    status: 418,
    serverDetail: null,
  });
  assert.match(
    explainContinuousPayloadFailure({ subject, error: unclassified }),
    /Failed to load x: Teapot[\s\S]*Check the server console/,
  );
});

test('the reader\'s own refusal is passed through unchanged', () => {
  const error = new UndrawableContinuousPayloadError({
    subject: { kind: 'gene', name: 'A2ML1' },
    tally: tallyOf([1, Number.POSITIVE_INFINITY]),
  });
  assert.equal(
    explainContinuousPayloadFailure({
      subject: { kind: 'gene', name: 'A2ML1' },
      error,
    }),
    error.message,
  );
});

test('a failure with no status is reported as itself', () => {
  const message = explainContinuousPayloadFailure({
    subject: { kind: 'gene', name: 'A2ML1' },
    error: new TypeError('Gene "A2ML1" must load as a Float32Array'),
  });
  assert.equal(
    message,
    'Gene "A2ML1" could not be loaded.\n'
    + 'Gene "A2ML1" must load as a Float32Array',
  );
});
