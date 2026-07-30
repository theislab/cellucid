import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canvasToBlob,
  downloadBlob,
} from '../assets/js/app/ui/modules/figure-export/utils/export-helpers.js';

test('canvas encoding aborts promptly and ignores its late native callback', async () => {
  let nativeCallback = null;
  const canvas = {
    toBlob(callback, type) {
      assert.equal(type, 'image/png');
      nativeCallback = callback;
    },
  };
  const controller = new AbortController();
  const pending = canvasToBlob(canvas, 'image/png', {
    signal: controller.signal,
    failureMessage: 'fixture encoding failed',
  });
  assert.equal(typeof nativeCallback, 'function');

  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.doesNotThrow(() => {
    nativeCallback(new Blob(['late'], { type: 'image/png' }));
  });
});

test('download abort between append and click cleans every staged browser owner', () => {
  const controller = new AbortController();
  const calls = [];
  const anchor = {
    click() {
      calls.push('click');
    },
    remove() {
      calls.push('remove');
    },
  };
  const originalDocument = globalThis.document;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  globalThis.document = {
    body: {
      appendChild(candidate) {
        assert.equal(candidate, anchor);
        calls.push('append');
        controller.abort();
      },
    },
    createElement(tagName) {
      assert.equal(tagName, 'a');
      return anchor;
    },
  };
  URL.createObjectURL = () => {
    calls.push('create-url');
    return 'blob:fixture';
  };
  URL.revokeObjectURL = (url) => {
    assert.equal(url, 'blob:fixture');
    calls.push('revoke-url');
  };

  try {
    assert.throws(
      () => downloadBlob(
        new Blob(['fixture']),
        'fixture.svg',
        { signal: controller.signal }
      ),
      { name: 'AbortError' }
    );
  } finally {
    if (originalDocument === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = originalDocument;
    }
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  }

  assert.deepEqual(calls, [
    'create-url',
    'append',
    'remove',
    'revoke-url',
  ]);
});

test('abort triggered by the download click cannot roll back the committed file', () => {
  const controller = new AbortController();
  const reason = new DOMException('teardown during click', 'AbortError');
  const calls = [];
  const anchor = {
    click() {
      calls.push('click');
      controller.abort(reason);
    },
    remove() {
      calls.push('remove');
    },
  };
  const originalDocument = globalThis.document;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  globalThis.document = {
    body: {
      appendChild(candidate) {
        assert.equal(candidate, anchor);
        calls.push('append');
      },
    },
    createElement(tagName) {
      assert.equal(tagName, 'a');
      return anchor;
    },
  };
  URL.createObjectURL = () => {
    calls.push('create-url');
    return 'blob:committed-fixture';
  };
  URL.revokeObjectURL = (url) => {
    assert.equal(url, 'blob:committed-fixture');
    calls.push('revoke-url');
  };

  try {
    assert.doesNotThrow(() => {
      downloadBlob(
        new Blob(['committed']),
        'committed.svg',
        { signal: controller.signal }
      );
    });
  } finally {
    if (originalDocument === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = originalDocument;
    }
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  }

  assert.equal(controller.signal.aborted, true);
  assert.equal(controller.signal.reason, reason);
  assert.deepEqual(calls, [
    'create-url',
    'append',
    'click',
    'remove',
    'revoke-url',
  ]);
});
