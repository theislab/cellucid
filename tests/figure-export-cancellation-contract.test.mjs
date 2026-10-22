import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canvasToBlob,
} from '../assets/js/app/ui/modules/figure-export/utils/export-helpers.js';
import {
  OBJECT_URL_RELEASE_DELAY_MS,
  downloadBlob,
} from '../assets/js/app/utils/download.js';

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

test('abort triggered by the download click cannot roll back the committed file', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
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
  // A clicked download keeps its Object URL alive past the click's task:
  // Firefox and WebKit read it after click() returns.
  assert.deepEqual(calls, ['create-url', 'append', 'click', 'remove']);
  URL.revokeObjectURL = (url) => {
    assert.equal(url, 'blob:committed-fixture');
    calls.push('revoke-url');
  };
  try {
    t.mock.timers.tick(OBJECT_URL_RELEASE_DELAY_MS - 1);
    assert.equal(calls.includes('revoke-url'), false);
    t.mock.timers.tick(1);
  } finally {
    URL.revokeObjectURL = originalRevokeObjectURL;
  }
  assert.deepEqual(calls, [
    'create-url',
    'append',
    'click',
    'remove',
    'revoke-url',
  ]);
});

test('every browser download goes through the one shared helper', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const root = new URL('../assets/js/', import.meta.url);
  const entries = await readdir(root, { recursive: true });
  const owners = [];
  for (const entry of entries.filter(name => name.endsWith('.js')).sort()) {
    const source = await readFile(new URL(entry, root), 'utf8');
    if (/\.download\s*=|setAttribute\(['"]download['"]/.test(source)) {
      // `readdir` reports Windows paths with backslashes.
      owners.push(entry.replaceAll('\\', '/'));
    }
  }
  assert.deepEqual(owners, ['app/utils/download.js']);
});
