/**
 * One answer to "is this an AbortSignal" (`utils/abort.js`, round 9): eleven
 * validators said it differently, and the duck-typed ones (gzip, cell sets,
 * bundles, community annotation) took any object with an `aborted` boolean
 * for a signal. The platform's brand check decides: a real signal from any
 * window of the site is one, a look-alike never.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { isAbortSignal, requireSignal, requireSignalOrNull } from '../assets/js/utils/abort.js';
import { gzipCompress } from '../assets/js/app/session/codecs/gzip.js';

const lookAlike = { aborted: false, reason: undefined, addEventListener() {}, removeEventListener() {}, throwIfAborted() {} };

test('a real signal is one; a look-alike, a prototype or a primitive is not', () => {
  assert.equal(isAbortSignal(new AbortController().signal), true);
  assert.equal(isAbortSignal(AbortSignal.abort()), true);
  assert.equal(isAbortSignal(AbortSignal.timeout(1_000)), true);
  for (const value of [lookAlike, { aborted: false }, Object.create(AbortSignal.prototype), null, undefined, false, 'signal']) {
    assert.equal(isAbortSignal(value), false, String(value));
  }
});

test('requireSignal and requireSignalOrNull name what was given wrongly', () => {
  const { signal } = new AbortController();
  assert.equal(requireSignal(signal, 'Gene load signal'), signal);
  assert.throws(() => requireSignal(null, 'Gene load signal'), { name: 'TypeError', message: 'Gene load signal must be an AbortSignal.' });
  assert.equal(requireSignalOrNull(null, 'Download signal'), null);
  assert.equal(requireSignalOrNull(signal, 'Download signal'), signal);
  assert.throws(() => requireSignalOrNull(undefined, 'Download signal'), { message: 'Download signal must be an AbortSignal or null.' });
  assert.throws(() => requireSignalOrNull(lookAlike, 'Download signal'), TypeError);
});

test('a module that took a look-alike for a signal refuses it now (gzip checked only `aborted`)', async () => {
  await assert.rejects(gzipCompress(new Uint8Array([1, 2, 3]), { signal: { aborted: false } }), /Gzip compression signal must be an AbortSignal or null/);
  const packed = await gzipCompress(new Uint8Array([1, 2, 3]), { signal: null });
  assert.ok(packed.length > 0);
});
