import assert from 'node:assert/strict';
import test from 'node:test';

import {
  openFigureExportWorkerSession,
  setFigureExportWorkerFactory,
  setFigureExportWorkerWebgl2,
} from '../assets/js/app/ui/modules/figure-export/utils/figure-export-worker-client.js';
import {
  OBJECT_URL_RELEASE_DELAY_MS,
  downloadBlob,
} from '../assets/js/app/utils/download.js';

test('a worker request aborts promptly and closes its late frame', async () => {
  const requests = [];
  const fakeWorker = {
    onmessage: null,
    postMessage(message) {
      requests.push(message);
    },
    terminate() {},
  };
  const previousImageBitmap = Object.getOwnPropertyDescriptor(globalThis, 'ImageBitmap');
  class FakeImageBitmap {
    closed = false;
    close() {
      this.closed = true;
    }
  }
  globalThis.ImageBitmap = FakeImageBitmap;
  setFigureExportWorkerFactory(() => fakeWorker);
  // A worker that draws: the point pass is its request.
  setFigureExportWorkerWebgl2(true);
  try {
    const controller = new AbortController();
    const session = openFigureExportWorkerSession({ signal: controller.signal });
    const pending = session.request('rasterizePoints', {});
    assert.equal(requests.length, 1);

    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });

    // The worker finishes the pass after the abort: its frame is closed, not
    // delivered to anyone.
    const late = new FakeImageBitmap();
    assert.doesNotThrow(() => {
      fakeWorker.onmessage({ data: { id: requests[0].id, result: late } });
    });
    assert.equal(late.closed, true);
    session.close();
    assert.deepEqual(requests.at(-1), { op: 'close', session: requests[0].session });
  } finally {
    setFigureExportWorkerFactory(null);
    if (previousImageBitmap === undefined) delete globalThis.ImageBitmap;
    else Object.defineProperty(globalThis, 'ImageBitmap', previousImageBitmap);
  }
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
