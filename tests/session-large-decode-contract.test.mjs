import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  decodeDeltaUvarint,
} from '../assets/js/app/session/codecs/delta-varint.js';
import {
  pushUvarint,
} from '../assets/js/app/session/codecs/varint.js';
import {
  restore as restoreUserDefinedCodes,
} from '../assets/js/app/session/contributors/user-defined-codes.js';

function userCodesPayload({ length, pairs }) {
  const header = [2];
  pushUvarint(length, header);
  pushUvarint(pairs.length, header);
  const pairBytes = [];
  for (const [value, run] of pairs) {
    pushUvarint(value, pairBytes);
    pushUvarint(run, pairBytes);
  }
  const payload = new Uint8Array(header.length + pairBytes.length);
  payload.set(header, 0);
  payload.set(pairBytes, header.length);
  return payload;
}

function userCodesContext(pointCount, signal = null) {
  const template = {
    _userDefinedId: 'field-a',
    _isUserDefined: true,
    kind: 'category',
    key: 'restored_groups',
    codes: null,
    loaded: false,
    _codesLengthHint: pointCount,
    _codesTypeHint: 'Uint8Array',
    centroidsByDim: {},
  };
  const state = {
    pointCount,
    obsData: { fields: [] },
    varData: { fields: [] },
    viewContexts: new Map(),
    getUserDefinedFieldsRegistry() {
      return {
        getField(fieldId) {
          return fieldId === 'field-a' ? template : null;
        },
      };
    },
    getActiveField() {
      return null;
    },
  };
  return {
    context: {
      abortSignal: signal,
      state,
    },
    template,
  };
}

function userCodesMetadata(payload) {
  return {
    id: 'user-defined/codes/field-a',
    contributorId: 'user-defined-codes',
    priority: 'lazy',
    kind: 'binary',
    codec: 'gzip',
    label: 'User-defined codes: restored_groups',
    datasetDependent: true,
    storedBytes: payload.byteLength,
    uncompressedBytes: payload.byteLength,
  };
}

test('large delta-uvarint decode yields so a scheduled cancellation wins', async () => {
  const count = 256 * 1024;
  const countBytes = [];
  pushUvarint(count, countBytes);
  const payload = new Uint8Array(countBytes.length + count);
  payload.set(countBytes, 0);
  payload[countBytes.length] = 0;
  payload.fill(1, countBytes.length + 1);

  const controller = new AbortController();
  const cancellation = new Error('scheduled highlight cancellation');
  let abortFired = false;
  const timer = setTimeout(() => {
    abortFired = true;
    controller.abort(cancellation);
  }, 0);
  try {
    await assert.rejects(
      decodeDeltaUvarint(payload, {
        maxCount: count,
        maxIndex: count - 1,
        signal: controller.signal,
      }),
      error => error === cancellation,
    );
  } finally {
    clearTimeout(timer);
  }
  assert.equal(abortFired, true);
});

test('one very large RLE run yields and never publishes partial codes on cancel', async () => {
  const pointCount = 1024 * 1024;
  const payload = userCodesPayload({
    length: pointCount,
    pairs: [[7, pointCount]],
  });
  const controller = new AbortController();
  const cancellation = new Error('scheduled code cancellation');
  const { context, template } = userCodesContext(
    pointCount,
    controller.signal,
  );
  let abortFired = false;
  const timer = setTimeout(() => {
    abortFired = true;
    controller.abort(cancellation);
  }, 0);
  try {
    await assert.rejects(
      restoreUserDefinedCodes(
        context,
        userCodesMetadata(payload),
        payload,
      ),
      error => error === cancellation,
    );
  } finally {
    clearTimeout(timer);
  }

  assert.equal(abortFired, true);
  assert.equal(template.codes, null);
  assert.equal(template.loaded, false);
  assert.equal(template._codesLengthHint, pointCount);
  assert.equal(template._codesTypeHint, 'Uint8Array');
});

test('high-pair-count RLE decodes directly into its final typed array', async () => {
  const pointCount = 128 * 1024;
  const pairs = new Array(pointCount);
  for (let index = 0; index < pointCount; index++) {
    pairs[index] = [index & 1, 1];
  }
  const payload = userCodesPayload({ length: pointCount, pairs });
  const { context, template } = userCodesContext(pointCount);

  await restoreUserDefinedCodes(
    context,
    userCodesMetadata(payload),
    payload,
  );

  assert.ok(template.codes instanceof Uint8Array);
  assert.equal(template.codes.length, pointCount);
  assert.deepEqual(
    Array.from(template.codes.subarray(0, 8)),
    [0, 1, 0, 1, 0, 1, 0, 1],
  );
  assert.equal(template.codes.at(-1), 1);

  const source = await readFile(
    new URL(
      '../assets/js/app/session/contributors/user-defined-codes.js',
      import.meta.url,
    ),
    'utf8',
  );
  assert.doesNotMatch(source, /new Array\s*\(\s*pairCount\s*\)/);
  assert.match(source, /codes\.fill\s*\(/);
});
