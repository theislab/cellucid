/**
 * The viewer's side of the host channel (`data/viewer-host-source.js`,
 * `data/viewer-channel.js`): configuration, initialization, the commands a
 * host sends over its WebSocket and the events the viewer sends back, the
 * channel's reconnect and end rules, and the pointer delivery around it.
 *
 * Every test talks to a fake host: `fetch` answers `/_cellucid/health` and
 * `/_cellucid/protocol`, and `FakeHostSocket` stands in for the WebSocket,
 * answering `hello` with `welcome` exactly as cellucid-python and cellucid-r
 * do (`viewer-protocol.json`).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  VIEWER_HOST_HEALTH_TIMEOUT_MS,
  ViewerHostDataSource,
  describeViewerHostCommandFailure,
  describeViewerHostCommandType,
  getViewerHostConfig,
  requireViewerHostInfoPayload,
  requireViewerHostProtocolPayload,
} from '../assets/js/data/viewer-host-source.js';
import {
  getNotificationCenter,
} from '../assets/js/app/notification-center.js';
import {
  DataSourceManager,
} from '../assets/js/data/data-source-manager.js';
import {
  createViewerHostPointerDelivery,
} from '../assets/js/app/viewer-host-pointer-delivery.js';
import {
  VIEWER_BINARY_EVENT_HEADER_FIELDS,
  VIEWER_EVENT_FIELDS,
  encodeViewerBinaryCommand,
  encodeViewerCells,
  viewerProtocolDocument,
} from '../assets/js/data/viewer-protocol.js';
import { viewerChannelUrl } from '../assets/js/data/viewer-channel.js';
import { FakeHostSocket, decodeFrames, host, lastSocket } from './helpers/fake-host-socket.mjs';

const CURRENT_PROTOCOL = Object.freeze(viewerProtocolDocument());
const protocolFixture = { passthrough: false, document: CURRENT_PROTOCOL, lastHealth: null };
const nativeFetch = globalThis.fetch;
let assignedFetch = nativeFetch;

/** `/_cellucid/info` of a host whose health is `health`: the same server, Python's. */
function hostInfo(health, runtime = 'python') {
  const { status: _status, ...shared } = health;
  return { ...shared, host: '127.0.0.1', port: 8765, runtime };
}

function fixtureFetch(input, init) {
  const url = String(input);
  if (!protocolFixture.passthrough && url.endsWith('/_cellucid/protocol')) {
    return Promise.resolve(new Response(JSON.stringify(protocolFixture.document), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  }
  if (!protocolFixture.passthrough && url.endsWith('/_cellucid/info')) {
    // The info of the host whose health this test's fetch answered last.
    return Promise.resolve(new Response(JSON.stringify(hostInfo(protocolFixture.lastHealth)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  }
  const answered = assignedFetch(input, init);
  if (!url.endsWith('/_cellucid/health')) return answered;
  return Promise.resolve(answered).then(async response => {
    if (response instanceof Response && response.ok) {
      try {
        protocolFixture.lastHealth = await response.clone().json();
      } catch {
        // A malformed health answer is the test's subject; info follows it.
      }
    }
    return response;
  });
}
Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  get() {
    return fixtureFetch;
  },
  set(value) {
    assignedFetch = value === fixtureFetch ? nativeFetch : value;
  },
});

/** The binary frame of a host's highlight of `cells`, in red. */
function highlightFrame(cells) {
  return encodeViewerBinaryCommand({ type: 'highlight', color: '#ff0000' }, Uint32Array.from(cells));
}

function cellsOf(body) {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  return Array.from({ length: body.byteLength / 4 }, (_, index) => view.getUint32(index * 4, true));
}

function installWindow(search) {
  const href = `http://127.0.0.1:8765/viewer/${search}`;
  globalThis.window = { location: new URL(href) };
}

async function connectedSource() {
  installWindow('?viewer=true&viewerId=viewer-1&viewerToken=secret-1');
  globalThis.fetch = async () => viewerHostHealthResponse();
  const source = new ViewerHostDataSource(getViewerHostConfig());
  assert.equal(await source.initialize(), true);
  return { source, socket: lastSocket() };
}

function silenceNotifications(t) {
  const notifications = getNotificationCenter();
  const originals = { error: notifications.error, info: notifications.info, consoleError: console.error };
  const raised = [];
  notifications.error = (message, options) => {
    raised.push({ level: 'error', message, options });
    return 'notice';
  };
  notifications.info = (message, options) => {
    raised.push({ level: 'info', message, options });
    return 'notice';
  };
  console.error = () => {};
  t.after(() => {
    notifications.error = originals.error;
    notifications.info = originals.info;
    console.error = originals.consoleError;
  });
  return raised;
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function hoverIntent(viewId, cellIndex, offset = 0) {
  return {
    viewId,
    cellIndex,
    position: {
      x: cellIndex + offset,
      y: cellIndex + offset + 0.25,
      z: cellIndex + offset + 0.5,
    },
  };
}

async function nextTask() {
  await new Promise(resolve => setImmediate(resolve));
}

function createDeterministicTimeoutClock() {
  let nextId = 1;
  const pending = new Map();
  return Object.freeze({
    schedule(callback, delay) {
      assert.equal(typeof callback, 'function');
      assert.equal(Number.isFinite(delay) && delay >= 0, true);
      const id = nextId;
      nextId += 1;
      pending.set(id, callback);
      return id;
    },
    cancel(id) {
      pending.delete(id);
    },
    get pendingCount() {
      return pending.size;
    },
    runNext() {
      const entry = pending.entries().next();
      assert.equal(entry.done, false, 'Expected one scheduled timeout.');
      const [id, callback] = entry.value;
      pending.delete(id);
      callback();
    },
  });
}

async function waitFor(condition, label) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (condition()) return;
    await nextTask();
  }
  assert.fail(`Timed out waiting for ${label}.`);
}

function viewerHostHealthResponse() {
  return new Response(JSON.stringify({
    status: 'ok',
    type: 'anndata',
    version: '1.0.0',
    format: 'h5ad',
    n_cells: 3,
    n_genes: 2,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('Viewer host configuration requires one exact viewer id and token', async t => {
  await t.test('current Python URL', () => {
    installWindow('?viewer=true&viewerId=viewer-1&viewerToken=secret-1');
    assert.deepEqual(getViewerHostConfig(), {
      serverUrl: 'http://127.0.0.1:8765/viewer',
      viewerId: 'viewer-1',
      viewerToken: 'secret-1',
    });
  });
  await t.test('current direct AnnData Python URL', () => {
    installWindow(
      '?viewer=true&viewerId=viewer-1&viewerToken=secret-1&anndata=true',
    );
    assert.deepEqual(getViewerHostConfig(), {
      serverUrl: 'http://127.0.0.1:8765/viewer',
      viewerId: 'viewer-1',
      viewerToken: 'secret-1',
    });
  });

  for (const [name, search] of [
    ['missing viewer id', '?viewer=true&viewerToken=secret-1'],
    ['missing viewer token', '?viewer=true&viewerId=viewer-1'],
    ['noncanonical mode', '?viewer=1&viewerId=viewer-1&viewerToken=secret-1'],
    ['duplicate viewer id', '?viewer=true&viewerId=viewer-1&viewerId=viewer-2&viewerToken=secret-1'],
    ['duplicate viewer token', '?viewer=true&viewerId=viewer-1&viewerToken=secret-1&viewerToken=secret-2'],
    ['whitespace viewer id', '?viewer=true&viewerId=%20viewer-1&viewerToken=secret-1'],
    ['whitespace viewer token', '?viewer=true&viewerId=viewer-1&viewerToken=secret%201'],
    ['undeclared remote route', '?viewer=true&viewerId=viewer-1&viewerToken=secret-1&remote=https%3A%2F%2Fexample.test'],
    ['undeclared query field', '?viewer=true&viewerId=viewer-1&viewerToken=secret-1&extra=true'],
    ['noncanonical AnnData discriminator', '?viewer=true&viewerId=viewer-1&viewerToken=secret-1&anndata=1'],
    ['duplicate AnnData discriminator', '?viewer=true&viewerId=viewer-1&viewerToken=secret-1&anndata=true&anndata=true'],
  ]) {
    await t.test(name, () => {
      installWindow(search);
      assert.throws(
        () => getViewerHostConfig(),
        /Viewer host configuration requires exactly one non-whitespace viewerId and viewerToken|viewer page/i,
      );
    });
  }
  // The former key names nothing: a page address with it is not a viewer's.
  await t.test('the retired jupyter key', () => {
    installWindow('?jupyter=true&viewerId=viewer-1&viewerToken=secret-1');
    assert.equal(getViewerHostConfig(), null);
  });
});

test('Viewer host initialization validates both exact Python health variants', async t => {
  installWindow('?viewer=true&viewerId=viewer-1&viewerToken=secret-1');

  await t.test('current direct AnnData server', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      status: 'ok',
      type: 'anndata',
      version: '1.2.3',
      format: 'h5ad',
      n_cells: 120,
      n_genes: 6,
    }), { status: 200 });
    const source = new ViewerHostDataSource();
    assert.equal(await source.initialize(), true);
  });

  for (const [name, payload] of [
    ['fabricated type', { status: 'ok', type: 'prepared', version: '1.2.3' }],
    ['retired prepared-export server', { status: 'ok', type: 'exported', version: '1.2.3' }],
    ['AnnData format missing', {
      status: 'ok',
      type: 'anndata',
      version: '1.2.3',
      n_cells: 120,
      n_genes: 6,
    }],
    ['AnnData retired is_backed field', {
      status: 'ok',
      type: 'anndata',
      version: '1.2.3',
      format: 'h5ad',
      is_backed: false,
      n_cells: 120,
      n_genes: 6,
    }],
    ['AnnData retired in-memory format', {
      status: 'ok',
      type: 'anndata',
      version: '1.2.3',
      format: 'in-memory',
      n_cells: 120,
      n_genes: 6,
    }],
    ['AnnData numeric coercion', {
      status: 'ok',
      type: 'anndata',
      version: '1.2.3',
      format: 'h5ad',
      n_cells: '120',
      n_genes: 6,
    }],
  ]) {
    await t.test(name, async () => {
      globalThis.fetch = async () => new Response(
        JSON.stringify(payload),
        { status: 200 },
      );
      const source = new ViewerHostDataSource();
      await assert.rejects(source.initialize(), /health/i);
      assert.equal(source.isConnected(), false);
      assert.equal(source._config, null);
    });
  }
});

test('a viewer host health request that never answers fails within its deadline', async t => {
  installWindow('?viewer=true&viewerId=viewer-1&viewerToken=secret-1');
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  // The deadline is an ordinary timer, so mock time drives it exactly.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let fetchSignal = null;
  globalThis.fetch = (_url, init) => {
    fetchSignal = init.signal;
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), {
        once: true,
      });
    });
  };
  const source = new ViewerHostDataSource();
  let settled = false;
  const initialization = source.initialize().finally(() => {
    settled = true;
  });
  initialization.catch(() => {});
  const turn = () => new Promise(resolve => setImmediate(resolve));
  await turn();
  assert.notEqual(fetchSignal, null, 'the health request must be in flight');

  t.mock.timers.tick(VIEWER_HOST_HEALTH_TIMEOUT_MS - 1);
  await turn();
  assert.equal(settled, false, 'the request may run until its deadline');

  t.mock.timers.tick(1);
  await assert.rejects(
    initialization,
    /did not answer http:\/\/127\.0\.0\.1:8765.*\/_cellucid\/health within 30 s/
  );
  assert.equal(VIEWER_HOST_HEALTH_TIMEOUT_MS, 30_000);
  assert.equal(fetchSignal.aborted, true);
  assert.equal(source.isConnected(), false);
});

test('Viewer host initialization propagates the exact health failure', async () => {
  installWindow('?viewer=true&viewerId=viewer-1&viewerToken=secret-1');
  const failure = new Error('health transport failed');
  globalThis.fetch = async () => {
    throw failure;
  };
  const source = new ViewerHostDataSource();
  await assert.rejects(source.initialize(), error => error === failure);
  assert.equal(source.isConnected(), false);
});

test('Viewer host initialization accepts one exact current server health response', async () => {
  installWindow('?viewer=true&viewerId=viewer-1&viewerToken=secret-1');
  globalThis.fetch = async () => new Response(JSON.stringify({
    status: 'ok',
    type: 'anndata',
    version: '1.0.0',
    format: 'h5ad',
    n_cells: 3,
    n_genes: 2,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  const source = new ViewerHostDataSource();
  assert.equal(await source.initialize(), true);
  assert.equal(source.isConnected(), true);
});

test('Viewer host mode does not register or enumerate the unrelated demo catalog', async () => {
  const manager = new DataSourceManager();
  let viewerHostAvailabilityCalls = 0;
  let viewerHostListingCalls = 0;
  manager.registerSource('jupyter', {
    async isAvailable() {
      viewerHostAvailabilityCalls += 1;
      return true;
    },
    async listDatasets() {
      viewerHostListingCalls += 1;
      return [{ id: 'python-dataset', name: 'Python dataset' }];
    },
  });

  await manager.initialize({
    registerDemoCatalog: false,
  });

  assert.deepEqual(manager.getSourceTypes(), ['jupyter', 'link']);
  assert.deepEqual(await manager.getAllDatasets(), [{
    sourceType: 'jupyter',
    datasets: [{ id: 'python-dataset', name: 'Python dataset' }],
    error: null,
  }]);
  assert.equal(viewerHostAvailabilityCalls, 1);
  assert.equal(viewerHostListingCalls, 1);
  assert.equal(manager.getSource('local-demo'), null);
  assert.notEqual(manager.getSource('link'), null);
});

test('Viewer host hover delivery serializes sends and coalesces to the latest intent', async () => {
  const sends = [];
  const pending = [];
  let active = 0;
  let maximumActive = 0;
  const errors = [];
  const delivery = createViewerHostPointerDelivery({
    notifyHover(cellIndex, position) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      sends.push({ cellIndex, position });
      const operation = deferred();
      pending.push(operation);
      return operation.promise.finally(() => {
        active -= 1;
      });
    },
    notifyClick: async () => {},
    reportError: (error, channel) => {
      errors.push({ error, channel });
    },
  });

  const first = hoverIntent('left', 1);
  const intermediate = hoverIntent('right', 2);
  const latest = hoverIntent('right', 3);
  assert.equal(delivery.requestHover(first), true);
  assert.equal(delivery.requestHover(intermediate), true);
  assert.equal(delivery.requestHover(latest), true);
  assert.equal(delivery.requestHover(latest), false);
  assert.deepEqual(sends.map(send => send.cellIndex), [1]);

  pending[0].resolve();
  await nextTask();
  assert.deepEqual(sends.map(send => send.cellIndex), [1, 3]);
  pending[1].resolve();
  await delivery.whenIdle();

  assert.equal(maximumActive, 1);
  assert.deepEqual(sends.map(send => send.cellIndex), [1, 3]);
  assert.equal(delivery.requestHover(latest), false);
  assert.deepEqual(errors, []);
});

test('Viewer host hover preserves a final leave while an older hover is in flight', async () => {
  const sends = [];
  const pending = [];
  const delivery = createViewerHostPointerDelivery({
    notifyHover(cellIndex, position) {
      sends.push({ cellIndex, position });
      const operation = deferred();
      pending.push(operation);
      return operation.promise;
    },
    notifyClick: async () => {},
    reportError: error => {
      throw error;
    },
  });

  delivery.requestHover(hoverIntent('pane', 8));
  delivery.requestHover(hoverIntent('pane', 9));
  delivery.requestHover(null);
  assert.deepEqual(sends.map(send => send.cellIndex), [8]);
  pending[0].resolve();
  await nextTask();
  assert.deepEqual(sends.map(send => send.cellIndex), [8, null]);
  pending[1].resolve();
  await delivery.whenIdle();
  assert.deepEqual(sends.map(send => send.cellIndex), [8, null]);
});

test('a repeated in-flight viewer host hover delivers exactly once after success', async () => {
  const sends = [];
  const operation = deferred();
  const delivery = createViewerHostPointerDelivery({
    notifyHover(cellIndex) {
      sends.push(cellIndex);
      return operation.promise;
    },
    notifyClick: async () => {},
    reportError: error => {
      throw error;
    },
  });
  const intent = hoverIntent('pane', 12);

  assert.equal(delivery.requestHover(intent), true);
  assert.equal(delivery.requestHover(intent), true);
  assert.deepEqual(sends, [12]);
  operation.resolve();
  await delivery.whenIdle();
  assert.deepEqual(sends, [12]);
  assert.equal(delivery.requestHover(intent), false);
});

test('failed viewer host hover remains retryable and commits deduplication only on success', async () => {
  const attempts = [];
  const errors = [];
  const firstFailure = new Error('synthetic hover delivery failure');
  const firstAttempt = deferred();
  const retryAttempt = deferred();
  const delivery = createViewerHostPointerDelivery({
    notifyHover(cellIndex) {
      attempts.push(cellIndex);
      return attempts.length === 1
        ? firstAttempt.promise
        : retryAttempt.promise;
    },
    notifyClick: async () => {},
    reportError: (error, channel) => {
      errors.push({ error, channel });
    },
  });
  const intent = hoverIntent('pane', 5);

  assert.equal(delivery.requestHover(intent), true);
  // A duplicate arriving before settlement remains pending. Success would
  // deduplicate it; failure must retry it.
  assert.equal(delivery.requestHover(intent), true);
  assert.deepEqual(attempts, [5]);
  firstAttempt.reject(firstFailure);
  await nextTask();
  assert.deepEqual(attempts, [5, 5]);
  retryAttempt.resolve();
  await delivery.whenIdle();
  assert.deepEqual(errors, [{
    error: firstFailure,
    channel: 'hover',
  }]);

  assert.deepEqual(attempts, [5, 5]);
  assert.equal(delivery.requestHover(intent), false);
});

test('Viewer host click delivery preserves exact FIFO order across deferred sends', async () => {
  const starts = [];
  const pending = [];
  const delivery = createViewerHostPointerDelivery({
    notifyHover: async () => {},
    notifyClick(cellIndex, modifiers) {
      starts.push({ cellIndex, modifiers });
      const operation = deferred();
      pending.push(operation);
      return operation.promise;
    },
    reportError: error => {
      throw error;
    },
  });

  assert.throws(
    () => delivery.requestClick({
      cellIndex: 9,
      button: 3,
      shift: false,
      ctrl: false,
    }),
    /button/i,
  );
  for (const cellIndex of [4, 2, 7]) {
    assert.equal(delivery.requestClick({
      cellIndex,
      button: 0,
      shift: cellIndex === 2,
      ctrl: cellIndex === 7,
    }), true);
  }
  assert.deepEqual(starts.map(entry => entry.cellIndex), [4]);
  pending[0].resolve();
  await nextTask();
  assert.deepEqual(starts.map(entry => entry.cellIndex), [4, 2]);
  pending[1].resolve();
  await nextTask();
  assert.deepEqual(starts.map(entry => entry.cellIndex), [4, 2, 7]);
  pending[2].resolve();
  await delivery.whenIdle();
  assert.deepEqual(
    starts.map(entry => entry.modifiers),
    [
      { button: 0, shift: false, ctrl: false },
      { button: 0, shift: true, ctrl: false },
      { button: 0, shift: false, ctrl: true },
    ],
  );
});

test('Viewer host pointer freeze fences queued and future lifecycle work', async () => {
  const hoverStarts = [];
  const clickStarts = [];
  const hoverFirst = deferred();
  const clickFirst = deferred();
  const delivery = createViewerHostPointerDelivery({
    notifyHover(cellIndex) {
      hoverStarts.push(cellIndex);
      return hoverFirst.promise;
    },
    notifyClick(cellIndex) {
      clickStarts.push(cellIndex);
      return clickFirst.promise;
    },
    reportError: error => {
      throw error;
    },
  });

  delivery.requestHover(hoverIntent('pane', 1));
  delivery.requestHover(hoverIntent('pane', 2));
  delivery.requestClick({
    cellIndex: 3,
    button: 0,
    shift: false,
    ctrl: false,
  });
  delivery.requestClick({
    cellIndex: 4,
    button: 0,
    shift: false,
    ctrl: false,
  });
  assert.equal(delivery.freeze(), true);
  assert.equal(delivery.freeze(), false);
  assert.equal(delivery.isFrozen(), true);
  assert.equal(delivery.requestHover(null), false);
  assert.equal(delivery.requestClick({
    cellIndex: 5,
    button: 0,
    shift: false,
    ctrl: false,
  }), false);

  hoverFirst.resolve();
  clickFirst.resolve();
  await delivery.whenIdle();
  assert.deepEqual(hoverStarts, [1]);
  assert.deepEqual(clickStarts, [3]);
});

test('Viewer host pointer hooks use per-view pick records without changing wire payloads', () => {
  const mainSource = readFileSync(
    new URL('../assets/js/app/main.js', import.meta.url),
    'utf8',
  );
  assert.match(
    mainSource,
    /viewer\.pickCellRecordAtScreen\(\s*event\.clientX,\s*event\.clientY\s*\)/,
  );
  assert.match(
    mainSource,
    /createViewerHostPointerDelivery\(\{/,
  );
  assert.match(
    mainSource,
    /viewerHostPointerDelivery\.requestHover\(pickRecord\)/,
  );
  assert.match(
    mainSource,
    /viewerHostPointerDelivery\.requestClick\(\{\s*cellIndex:\s*pickRecord\.cellIndex,/,
  );
  assert.match(
    mainSource,
    /viewerHostPointerDelivery\?\.freeze\(\)/,
  );
  // The channel's end is the stop signal: nothing polls the host.
  assert.match(mainSource, /viewerHostSource\.onChannelEnd\(end => \{[\s\S]*freezeViewerHostView\(\)/);
  assert.doesNotMatch(mainSource, /setInterval\([\s\S]{0,200}checkHealth/);
  assert.doesNotMatch(
    mainSource,
    /getCellPosition\([^)]*,\s*['"]live['"]\)/,
  );
  assert.match(
    mainSource,
    /const retireViewerHostView = event => \{\s*if \(event\.persisted === true\) return;\s*window\.removeEventListener\('pagehide', retireViewerHostView\);\s*freezeViewerHostView\(\);\s*\};\s*window\.addEventListener\('pagehide', retireViewerHostView\);/,
  );
  assert.doesNotMatch(
    mainSource,
    /freezeViewerHostView\(\);\s*\},\s*\{ once: true \}/,
  );

  const freezeStart = mainSource.indexOf(
    'const freezeViewerHostView = () => {',
  );
  const freezeEnd = mainSource.indexOf(
    '\n      };',
    freezeStart,
  );
  const freezeSource = mainSource.slice(freezeStart, freezeEnd);
  assert.ok(freezeStart >= 0 && freezeEnd > freezeStart);
  assert.ok(
    freezeSource.indexOf('viewerHostFrozen = true;') <
      freezeSource.indexOf('retireViewerHostPointerInputs()'),
  );
  assert.ok(
    freezeSource.indexOf('viewerHostFrozen = true;') <
      freezeSource.indexOf('viewer.pause()'),
  );

  // The channel's end freezes the view before it tells the person.
  const endStart = mainSource.indexOf('viewerHostSource.onChannelEnd(end => {', freezeEnd);
  const endSource = mainSource.slice(endStart, mainSource.indexOf('\n      });', endStart));
  assert.ok(endStart > 0);
  assert.ok(endSource.indexOf('freezeViewerHostView();') < endSource.indexOf('notifications['));
});

test('Viewer host command failure names the command for the person watching', () => {
  assert.deepEqual(
    describeViewerHostCommandFailure(
      'setColorBy',
      new Error('Viewer host set-color-by command requires exactly one field "CD8A"'),
    ),
    {
      title: 'Notebook command failed',
      message:
        'The notebook "setColorBy" command did not run: Viewer host set-color-by ' +
        'command requires exactly one field "CD8A". The viewer is unchanged; ' +
        'correct the notebook cell and run it again.',
    },
  );

  assert.equal(
    describeViewerHostCommandFailure(null, new Error('boom')).message,
    'A notebook command did not run: boom. The viewer is unchanged; ' +
    'correct the notebook cell and run it again.',
  );

  // A thrown non-Error, or an Error with no message, still produces text a
  // reader can act on rather than an empty or "undefined" notification.
  for (const thrown of [new Error(''), 'plain string', null, undefined, { a: 1 }]) {
    assert.equal(
      describeViewerHostCommandFailure('highlight', thrown).message,
      'The notebook "highlight" command did not run: the viewer reported no ' +
      'reason. The viewer is unchanged; correct the notebook cell and run it ' +
      'again.',
    );
  }

  // Newlines and stack-shaped text are collapsed, and an unbounded message is
  // truncated so one failure cannot fill the notification surface.
  assert.equal(
    describeViewerHostCommandFailure(
      'highlight',
      new Error('first line\n  second line\tthird'),
    ).message.startsWith(
      'The notebook "highlight" command did not run: first line second line third.',
    ),
    true,
  );
  const truncated = describeViewerHostCommandFailure(
    'highlight',
    new Error('x'.repeat(4000)),
  ).message;
  assert.equal(truncated.includes(`${'x'.repeat(239)}…`), true);
  assert.equal(truncated.includes('x'.repeat(241)), false);

  // Only recognised command types may be named.
  assert.throws(
    () => describeViewerHostCommandFailure('notACommand', new Error('boom')),
    /one recognised command or null/,
  );
});

test('Viewer host command labels are drawn from the exact command set', () => {
  for (const type of [
    'ping',
    'debug_snapshot',
    'highlight',
    'setColorBy',
    'setVisibility',
    'clearHighlights',
    'resetCamera',
    'freeze',
    'requestSessionBundle',
    'setDataMapping',
  ]) {
    assert.equal(describeViewerHostCommandType({ type }), type);
  }
  for (const data of [
    { type: 'javascript:alert(1)' },
    { type: '__proto__' },
    { type: 'constructor' },
    { type: '' },
    { type: 7 },
    { type: ['highlight'] },
    {},
    null,
    'highlight',
    ['highlight'],
  ]) {
    assert.equal(describeViewerHostCommandType(data), null);
  }
});

const REPORTED_MAPPING = Object.freeze({
  kind: 'anndata',
  embeddings: {
    enabled: [{ key: 'X_umap', columns: [0, 1] }],
    defaults: { '1d': null, '2d': { key: 'X_umap', columns: [0, 1] }, '3d': null },
  },
  knn: 'connectivities',
  geneNames: 'index',
  expression: 'X',
  log1p: {},
  highlyVariable: null,
  latent: null,
  vectorFields: [],
});

test('initialization opens one authenticated channel at the server address and owns its config', async () => {
  installWindow('?viewer=true&viewerId=viewer-1&viewerToken=secret-1');
  const config = getViewerHostConfig();
  const source = new ViewerHostDataSource(config);
  config.viewerId = 'mutated-viewer';
  config.viewerToken = 'mutated-token';
  const requested = [];
  globalThis.fetch = async url => {
    requested.push(String(url));
    return viewerHostHealthResponse();
  };
  const before = FakeHostSocket.instances.length;
  assert.equal(await source.initialize(), true);
  assert.deepEqual(requested, ['http://127.0.0.1:8765/viewer/_cellucid/health']);
  assert.equal(FakeHostSocket.instances.length, before + 1);
  const socket = lastSocket();
  assert.equal(socket.url, 'ws://127.0.0.1:8765/viewer/_cellucid/ws');
  assert.equal(socket.binaryType, 'arraybuffer');
  assert.deepEqual(socket.hello, { type: 'hello', viewerId: 'viewer-1', viewerToken: 'secret-1' });
  assert.deepEqual(source.getConnectionInfo(), {
    serverUrl: 'http://127.0.0.1:8765/viewer',
    viewerId: 'viewer-1',
    status: 'connected',
  });
  source.disconnect();
  assert.equal(source.isConnected(), false);
  assert.deepEqual(socket.closedByViewer, { code: 1000, reason: 'Viewer closed' });
});

test('the channel address keeps the server path and maps http to ws and https to wss', () => {
  assert.equal(viewerChannelUrl('http://127.0.0.1:8765'), 'ws://127.0.0.1:8765/_cellucid/ws');
  assert.equal(
    viewerChannelUrl('https://hub.example.org/user/ana/proxy/8765'),
    'wss://hub.example.org/user/ana/proxy/8765/_cellucid/ws',
  );
  assert.throws(() => viewerChannelUrl('file:///tmp'), /http\(s\)/);
});

test('a host whose credentials check fails is a clear initialization error', async () => {
  installWindow('?viewer=true&viewerId=viewer-1&viewerToken=wrong-token');
  globalThis.fetch = async () => viewerHostHealthResponse();
  const source = new ViewerHostDataSource(getViewerHostConfig());
  await assert.rejects(source.initialize(), /no longer knows this viewer.*Run the cell/);
  assert.equal(source.isConnected(), false);
});

test('a host that answers HTTP but not the WebSocket names the proxy as the cause', async t => {
  installWindow('?viewer=true&viewerId=viewer-1&viewerToken=secret-1');
  globalThis.fetch = async () => viewerHostHealthResponse();
  host.unreachable = true;
  t.after(() => {
    host.unreachable = false;
  });
  const source = new ViewerHostDataSource(getViewerHostConfig());
  await assert.rejects(
    source.initialize(),
    /session is running, but this viewer cannot open its channel \(ws:\/\/127\.0\.0\.1:8765\/viewer\/_cellucid\/ws\).*must pass WebSockets/,
  );
  assert.equal(source.isConnected(), false);
});

test('Viewer host deactivation keeps its authenticated channel', async () => {
  const { source, socket } = await connectedSource();
  source.acceptCommands();
  let calls = 0;
  source.onMessage(() => {
    calls += 1;
  });
  assert.equal(source.onDeactivate(), undefined);
  assert.equal(source.isConnected(), true);
  socket.hostSend({ type: 'freeze' });
  assert.equal(calls, 1);
  source.disconnect();
  assert.equal(source.isConnected(), false);
});

test(
  'Viewer host initialization and disconnect fence every deferred health result',
  async t => {
    await t.test('newest initialization owns publication', async () => {
      installWindow('?viewer=true&viewerId=viewer-1&viewerToken=secret-1');
      const firstHealth = deferred();
      const secondHealth = deferred();
      const healthSignals = [];
      let healthCalls = 0;
      globalThis.fetch = async (_url, init = {}) => {
        healthCalls += 1;
        healthSignals.push(init.signal ?? null);
        return healthCalls === 1 ? firstHealth.promise : secondHealth.promise;
      };
      const source = new ViewerHostDataSource(getViewerHostConfig());
      const first = source.initialize();
      const firstRejection = assert.rejects(first, /superseded/i);
      const second = source.initialize();
      assert.ok(healthSignals[0] instanceof AbortSignal);
      assert.equal(healthSignals[0].aborted, true);

      secondHealth.resolve(viewerHostHealthResponse());
      assert.equal(await second, true);
      firstHealth.resolve(viewerHostHealthResponse());
      await firstRejection;
      assert.equal(source.isConnected(), true);
      source.disconnect();
    });

    await t.test('disconnect retires pending initialization', async () => {
      installWindow('?viewer=true&viewerId=viewer-1&viewerToken=secret-1');
      const health = deferred();
      let healthSignal = null;
      globalThis.fetch = async (_url, init = {}) => {
        healthSignal = init.signal ?? null;
        return health.promise;
      };
      const before = FakeHostSocket.instances.length;
      const source = new ViewerHostDataSource(getViewerHostConfig());
      const initialization = source.initialize();
      const rejection = assert.rejects(initialization, /superseded/i);
      source.disconnect();
      assert.ok(healthSignal instanceof AbortSignal);
      assert.equal(healthSignal.aborted, true);
      health.resolve(viewerHostHealthResponse());
      await rejection;
      assert.equal(source.isConnected(), false);
      assert.equal(FakeHostSocket.instances.length, before, 'no channel was opened');
    });
  },
);

test('commands that arrive before the app is ready run, in order, once it accepts them', async () => {
  const { source, socket } = await connectedSource();
  const seen = [];
  socket.hostSend({ type: 'setColorBy', field: 'leiden' });
  socket.hostSendBinary(highlightFrame([1, 2]));
  socket.hostSend({ type: 'resetCamera' });
  source.onMessage(message => seen.push(message.type));
  source.onHighlight(cells => seen.push(`highlight:${cells === null ? 'clear' : cells.join(',')}`));
  assert.deepEqual(seen, []);
  source.acceptCommands();
  assert.deepEqual(seen, ['setColorBy', 'highlight:1,2', 'resetCamera']);
  socket.hostSend({ type: 'clearHighlights' });
  assert.deepEqual(seen.at(-1), 'highlight:clear');
  source.acceptCommands();
  assert.equal(seen.length, 4, 'accepting twice replays nothing');
  source.disconnect();
});

test('host commands are checked against their exact keys before any handler', async t => {
  const raised = silenceNotifications(t);
  const { source, socket } = await connectedSource();
  source.acceptCommands();
  let highlightCalls = 0;
  const visibility = [];
  source.onHighlight(() => {
    highlightCalls += 1;
  });
  source.onMessage(message => visibility.push(message));
  // A frame of the right shape whose values are wrong reaches no handler,
  // and the host is told; the channel stays open.
  socket.hostSendBinary(encodeViewerBinaryCommand({ type: 'highlight', color: 'red' }, Uint32Array.of(1)));
  assert.equal(highlightCalls, 0);
  assert.equal(raised.length, 1);
  socket.hostSendBinary(highlightFrame([1, 2]));
  assert.equal(highlightCalls, 1);
  socket.hostSendBinary(encodeViewerBinaryCommand({ type: 'setVisibility', visible: false, all: false }, Uint32Array.of(0, 4)));
  socket.hostSendBinary(encodeViewerBinaryCommand({ type: 'setVisibility', visible: true, all: true }, null));
  assert.deepEqual(visibility, [
    { type: 'setVisibility', visible: false, cells: Uint32Array.of(0, 4) },
    { type: 'setVisibility', visible: true, cells: null },
  ]);
  assert.throws(() => source.onHighlight(null), /callback.*function/i);
  assert.equal('onSelectionSync' in source, false);
  source.disconnect();
});

test('a command that names cells is a binary frame, checked as exactly as the hosts check events', async t => {
  silenceNotifications(t);
  const header = text => new TextEncoder().encode(text);
  const frame = (headerText, cells = [1, 2], prefix = null) => {
    const headerBytes = header(headerText);
    const bytes = new Uint8Array(4 + headerBytes.length + cells.length * 4);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, prefix ?? headerBytes.length, true);
    bytes.set(headerBytes, 4);
    cells.forEach((cell, index) => view.setUint32(4 + headerBytes.length + index * 4, cell, true));
    return bytes;
  };
  const refusals = [
    // The old text form of a command that names cells.
    { text: { type: 'highlight', cells: [1, 2], color: '#ff0000' } },
    { text: { type: 'setVisibility', cells: null, visible: true } },
    // Commands carry no credentials: the channel is the viewer's.
    { binary: frame('{"type":"highlight","color":"#ff0000","viewerId":"viewer-1","viewerToken":"secret-1"}') },
    { binary: frame('{"type":"highlight"}') },
    { binary: frame('{"type":"setColorBy","field":"x"}') },
    { binary: frame('{"type":"highlight","color":"#ff0000"}', [2, 1]) },
    { binary: frame('{"type":"highlight","color":"#ff0000"}', [3, 3]) },
    { binary: frame('{"type":"highlight","color":"#ff0000"}', []) },
    { binary: Uint8Array.of(...frame('{"type":"highlight","color":"#ff0000"}', [1]), 0) },
    { binary: frame('{"type":"highlight","color":"#ff0000"}', [1], 400) },
    { binary: frame('{"type":"setVisibility","visible":true,"all":true}', [1]) },
    { binary: frame('{"type":"setVisibility","visible":"yes","all":false}', [1]) },
    { binary: Uint8Array.of(2, 0, 0, 0, 0xff, 0xfe) },
    { binary: Uint8Array.of(1, 0) },
  ];
  for (const refusal of refusals) {
    const { source, socket } = await connectedSource();
    source.acceptCommands();
    const ends = [];
    let handled = 0;
    source.onChannelEnd(end => ends.push(end));
    source.onHighlight(() => {
      handled += 1;
    });
    source.onMessage(() => {
      handled += 1;
    });
    if (refusal.text) socket.hostSend(refusal.text);
    else socket.hostSendBinary(refusal.binary);
    assert.deepEqual(ends.map(end => end.kind), ['protocol'], JSON.stringify(refusal.text ?? [...refusal.binary]));
    assert.equal(socket.closedByViewer.code, 1008);
    assert.equal(handled, 0);
  }
});

test('a frame the viewer cannot read ends the channel as a protocol violation', async t => {
  const raised = [];
  const { source, socket } = await connectedSource();
  source.onChannelEnd(end => raised.push(end));
  socket.hostSend('{not json');
  assert.deepEqual(raised.map(end => end.kind), ['protocol']);
  assert.equal(socket.closedByViewer.code, 1008);
  assert.equal(source.isConnected(), false);
  silenceNotifications(t);
});

test('events go out as exact frames without credentials, binary ones zero-copy', async () => {
  const { source, socket } = await connectedSource();
  await source.notifySelection(Uint32Array.of(1, 2, 70000), 'lasso');
  await source.notifyHover(1, { x: 1, y: 2, z: 3 });
  await source.notifyHover(null, null);
  await source.notifyClick(2, { button: 0, shift: false, ctrl: true });
  await source.notifyReady({ nCells: 120, dimensions: 2 });
  const bundle = new Blob([new TextEncoder().encode('CELLUCID_SESSION\n')]);
  assert.equal(source.sendSessionBundle('request-1', bundle), true);

  const frames = await decodeFrames(socket.frames);
  assert.deepEqual(frames[0].header, { type: 'selection', source: 'lasso' });
  assert.deepEqual(cellsOf(frames[0].body), [1, 2, 70000]);
  assert.deepEqual(frames.slice(1, 5), [
    { type: 'hover', cell: 1, position: { x: 1, y: 2, z: 3 } },
    { type: 'hover', cell: null, position: null },
    { type: 'click', cell: 2, button: 0, shift: false, ctrl: true },
    { type: 'ready', n_cells: 120, dimensions: 2 },
  ]);
  assert.deepEqual(frames[5].header, { type: 'session_bundle', requestId: 'request-1' });
  assert.equal(new TextDecoder().decode(frames[5].body), 'CELLUCID_SESSION\n');
  for (const frame of frames) {
    const record = frame.header ?? frame;
    assert.equal(Object.hasOwn(record, 'viewerId'), false);
    assert.equal(Object.hasOwn(record, 'viewerToken'), false);
  }

  const sentBefore = socket.frames.length;
  await assert.rejects(source.notifyReady({}), /nCells.*dimensions/i);
  await assert.rejects(source.notifySelection(Uint32Array.of(1, 2)), /source/i);
  await assert.rejects(source.notifySelection(Uint32Array.of(2, 1), 'lasso'), /ascending/);
  await assert.rejects(source.notifyClick(2, { button: '0', shift: false, ctrl: false }), /button/i);
  await assert.rejects(source.notifyHover(2, { x: 1, y: Number.NaN, z: 3 }), /finite/i);
  assert.throws(() => source.sendSessionBundle('request-2', new Blob([])), /non-empty Blob/);
  assert.equal(socket.frames.length, sentBefore);
  source.disconnect();
});

test('selection encoding builds no per-cell hash set and copies nothing on little-endian hosts', () => {
  // A JavaScript Set or Map holds at most 2^24 entries, and a selection can
  // exceed 16,777,216 cells; one of either on this path caps every selection.
  const protocol = readFileSync(new URL('../assets/js/data/viewer-protocol.js', import.meta.url), 'utf8');
  const notification = readFileSync(
    new URL('../assets/js/app/ui/modules/highlight/selection-notification.js', import.meta.url),
    'utf8',
  );
  const cellSet = readFileSync(new URL('../assets/js/app/utils/cell-set.js', import.meta.url), 'utf8');
  const bodyOf = (text, signature) => {
    const start = text.indexOf(signature);
    assert.ok(start >= 0, `${signature} must exist`);
    return text.slice(start, text.indexOf('\n}\n', start));
  };
  for (const body of [
    bodyOf(protocol, 'export function encodeViewerCells('),
    bodyOf(protocol, 'export function decodeViewerBinaryCommand('),
    bodyOf(cellSet, 'export function requireCellList('),
    bodyOf(notification, 'function requireDelivery('),
  ]) {
    assert.doesNotMatch(body, /new (?:Set|Map)\b/);
  }

  const many = new Uint32Array(17_000_000);
  for (let index = 0; index < many.length; index++) many[index] = index;
  const started = performance.now();
  const encoded = encodeViewerCells(many);
  const elapsed = performance.now() - started;
  assert.equal(encoded.byteLength, many.length * 4);
  assert.equal(new DataView(encoded.buffer).getUint32((many.length - 1) * 4, true), many.length - 1);
  console.log(`[viewer channel] encoded ${many.length.toLocaleString('en-US')} cells in ${elapsed.toFixed(0)} ms`);
});

test('the viewer sends only event types the protocol declares, each as a literal', () => {
  const declared = new Set([
    ...Object.keys(VIEWER_EVENT_FIELDS),
    ...Object.keys(VIEWER_BINARY_EVENT_HEADER_FIELDS),
  ]);
  assert.deepEqual([...declared].sort(), CURRENT_PROTOCOL.events);
  const source = readFileSync(new URL('../assets/js/data/viewer-host-source.js', import.meta.url), 'utf8');
  const published = [];
  for (const [index, line] of source.split('\n').entries()) {
    const match = /(?:^|[^\w.$])type:\s*(.+?),?\s*$/.exec(line);
    if (match !== null) published.push({ line: index + 1, value: match[1] });
  }
  assert.ok(published.length > 0, 'viewer-host-source.js must still publish event types');
  for (const { line, value } of published) {
    const literal = /^'([a-z_]+)'$/.exec(value);
    assert.ok(literal !== null, `viewer-host-source.js:${line} publishes a computed event type (${value})`);
    assert.ok(declared.has(literal[1]), `viewer-host-source.js:${line} publishes undeclared "${literal[1]}"`);
  }
});

test('main wires the channel: session bundles on it, commands accepted after every handler', () => {
  const mainSource = readFileSync(new URL('../assets/js/app/main.js', import.meta.url), 'utf8');
  assert.match(mainSource, /const viewerHostConfig = getViewerHostConfig\(\);/);
  assert.match(mainSource, /createViewerHostBridgeDataSource\(viewerHostConfig\)/);
  assert.match(mainSource, /viewerHostSource\.sendSessionBundle\(message\.requestId, bundle\)/);
  assert.match(mainSource, /viewerHostSource\.onChannelEnd\(/);
  const accept = mainSource.indexOf('viewerHostSource.acceptCommands();');
  assert.ok(accept > mainSource.indexOf('viewerHostCommandHandlers.handleMessage'));
  assert.ok(accept > mainSource.indexOf('viewerHostSource.sendSessionBundle('));
  // No polling: the host closing the channel is how the viewer learns it stopped.
  assert.doesNotMatch(mainSource, /HealthMonitor|checkHealth\(/);
  assert.doesNotMatch(mainSource, /postMessage|_cellucid\/(?:events|selection|session_bundle)/);
});

test('a dropped channel reopens at once and sends what waited, in order, with the newest hover', async t => {
  silenceNotifications(t);
  const { source, socket } = await connectedSource();
  source.acceptCommands();
  const ends = [];
  source.onChannelEnd(end => ends.push(end));
  socket.hostClose(1006);
  // While it reconnects, events wait.
  await source.notifyHover(1, { x: 1, y: 1, z: 1 });
  await source.notifyClick(1, { button: 0, shift: false, ctrl: false });
  await source.notifyHover(2, { x: 2, y: 2, z: 2 });
  await source.notifySelection(Uint32Array.of(4, 5), 'knn');
  await source.notifyHover(3, { x: 3, y: 3, z: 3 });
  await waitFor(() => lastSocket() !== socket && lastSocket().frames.length === 3, 'the reopened channel');
  const again = lastSocket();
  assert.deepEqual(again.hello, { type: 'hello', viewerId: 'viewer-1', viewerToken: 'secret-1' });
  const frames = await decodeFrames(again.frames);
  assert.deepEqual(frames[0], { type: 'hover', cell: 3, position: { x: 3, y: 3, z: 3 } });
  assert.deepEqual(frames[1].type, 'click');
  assert.deepEqual(frames[2].header, { type: 'selection', source: 'knn' });
  assert.deepEqual(ends, []);
  assert.equal(source.isConnected(), true);
  // Commands keep arriving on the new socket; the old one is ignored.
  const seen = [];
  source.onMessage(message => seen.push(message.type));
  socket.hostSend({ type: 'resetCamera' });
  again.hostSend({ type: 'freeze' });
  assert.deepEqual(seen, ['freeze']);
  source.disconnect();
});

test('a replaced, stopped or unreachable channel ends once, without reopening', async t => {
  silenceNotifications(t);
  for (const [code, kind] of [[4409, 'replaced'], [1001, 'stopped'], [4401, 'stopped'], [1008, 'protocol']]) {
    const { source, socket } = await connectedSource();
    const ends = [];
    source.onChannelEnd(end => ends.push(end));
    const count = FakeHostSocket.instances.length;
    socket.hostClose(code, 'bye');
    await nextTask();
    await nextTask();
    assert.deepEqual(ends.map(end => end.kind), [kind], `code ${code}`);
    assert.equal(FakeHostSocket.instances.length, count, `code ${code} opens nothing`);
    assert.equal(source.isConnected(), false);
    await assert.rejects(source.notifyReady({ nCells: 1, dimensions: 2 }), /not connected/);
  }
});

test('a reopen that fails is told apart by one health request', async t => {
  silenceNotifications(t);
  for (const [healthy, kind, message] of [
    [true, 'unreachable', /must pass WebSockets/],
    [false, 'stopped', /no longer answers/],
  ]) {
    const { source, socket } = await connectedSource();
    const ends = [];
    source.onChannelEnd(end => ends.push(end));
    let healthCalls = 0;
    globalThis.fetch = async () => {
      healthCalls += 1;
      if (healthy) return viewerHostHealthResponse();
      throw new TypeError('Failed to fetch');
    };
    host.unreachable = true;
    socket.hostClose(1006);
    await waitFor(() => ends.length === 1, 'the channel end');
    host.unreachable = false;
    assert.equal(ends[0].kind, kind);
    assert.match(ends[0].message, message);
    assert.equal(healthCalls, 1, 'one health request, no polling');
  }
});

test('a failed notebook command is announced in the viewer and reported to the host', async t => {
  const { source, socket } = await connectedSource();
  source.acceptCommands();
  const notifications = getNotificationCenter();
  const originalNotify = notifications.error;
  const originalConsoleError = console.error;
  const raised = [];
  const logged = [];
  notifications.error = (message, options) => {
    raised.push({ message, options });
    return 'jupyter-command-failure-test';
  };
  console.error = (...args) => {
    logged.push(args);
  };
  t.after(() => {
    notifications.error = originalNotify;
    console.error = originalConsoleError;
    source.disconnect();
  });

  source.onMessage(message => {
    if (message.type === 'setColorBy') {
      throw new Error('Viewer host set-color-by command requires exactly one field "CD8A"');
    }
  });
  socket.hostSend({ type: 'setColorBy', field: 'CD8A' });
  assert.equal(raised.length, 1);
  assert.equal(
    raised[0].message,
    'The notebook "setColorBy" command did not run: Viewer host set-color-by ' +
    'command requires exactly one field "CD8A". The viewer is unchanged; ' +
    'correct the notebook cell and run it again.',
  );
  assert.deepEqual(raised[0].options, {
    category: 'connectivity',
    title: 'Notebook command failed',
    duration: 0,
  });
  assert.equal(logged.length, 1);
  assert.match(logged[0][0], /^\[ViewerHost\] The notebook "setColorBy"/);
  assert.deepEqual(await decodeFrames(socket.frames), [{
    type: 'command_error',
    command: 'setColorBy',
    reason: 'Viewer host set-color-by command requires exactly one field "CD8A"',
  }]);

  // An asynchronous rejection reaches the same surface.
  raised.length = 0;
  source.onHighlight(() => Promise.reject(new Error('highlight page missing')));
  socket.hostSendBinary(highlightFrame([1, 2, 3]));
  await nextTask();
  assert.equal(raised.length, 1);
  assert.match(raised[0].message, /^The notebook "highlight" command did not run: highlight page missing\./);

  // An unknown command type is never echoed into the notification, and the
  // host is not told of a command it cannot have sent.
  raised.length = 0;
  const framesBefore = socket.frames.length;
  for (const type of ['javascript:alert(1)', '<img src=x onerror=alert(1)>']) {
    socket.hostSend({ type });
  }
  assert.equal(raised.length, 2);
  for (const { message } of raised) {
    assert.match(message, /^A notebook command did not run:/);
    assert.equal(message.includes('alert'), false);
  }
  assert.equal(socket.frames.length, framesBefore);

  // Reporting is last-resort: a broken notification surface must not turn
  // the channel's message handler into a thrown failure.
  logged.length = 0;
  notifications.error = () => {
    throw new Error('notification surface unavailable');
  };
  socket.hostSend({ type: 'setColorBy', field: 'CD8A' });
  assert.equal(logged.length, 2);
  assert.match(logged[1][0], /^\[ViewerHost\] Notebook command failure notice failed:/);
});

function protocolServer(protocolResponse, runtime = 'python') {
  return async url => {
    const text = String(url);
    if (text.endsWith('/_cellucid/health')) return viewerHostHealthResponse();
    if (text.endsWith('/_cellucid/protocol')) return protocolResponse();
    if (text.endsWith('/_cellucid/info')) {
      const health = await viewerHostHealthResponse().json();
      return new Response(JSON.stringify(hostInfo(health, runtime)), { status: 200 });
    }
    throw new Error(`unexpected request ${text}`);
  };
}

test('initialization reads the host protocol and gates events on it', async t => {
  installWindow('?viewer=true&viewerId=viewer-1&viewerToken=secret-1');
  protocolFixture.passthrough = true;
  t.after(() => {
    protocolFixture.passthrough = false;
  });
  const requested = [];
  // A host that accepts every event but data_mapping.
  const narrow = { ...CURRENT_PROTOCOL, events: CURRENT_PROTOCOL.events.filter(type => type !== 'data_mapping') };
  const server = protocolServer(() => new Response(JSON.stringify(narrow), { status: 200 }));
  globalThis.fetch = async (url, init) => {
    requested.push(String(url));
    return server(url, init);
  };
  const source = new ViewerHostDataSource(getViewerHostConfig());
  assert.equal(await source.initialize(), true);
  const socket = lastSocket();
  assert.deepEqual(requested, [
    'http://127.0.0.1:8765/viewer/_cellucid/health',
    'http://127.0.0.1:8765/viewer/_cellucid/protocol',
    'http://127.0.0.1:8765/viewer/_cellucid/info',
  ]);
  // The host is named by its info's runtime, by the protocol's names.
  assert.equal(source.getHostLabel(), 'Python');
  assert.equal(source.acceptsEvent('data_mapping'), false);
  assert.equal(
    await source.notifyDataMapping({ origin: 'user', requestId: null, mapping: REPORTED_MAPPING }),
    false,
  );
  assert.deepEqual(socket.frames, []);
  await assert.rejects(
    source.notifyDataMapping({ origin: 'notebook', requestId: null, mapping: REPORTED_MAPPING }),
    /requestId/,
  );
  await assert.rejects(
    source.notifyDataMapping({ origin: 'user', requestId: 'req-1', mapping: REPORTED_MAPPING }),
    /requestId must be null/,
  );
  await assert.rejects(
    source.notifyDataMapping({ origin: 'url', requestId: null, mapping: REPORTED_MAPPING }),
    /origin must be one of/,
  );
  source.disconnect();
});

test('a host without the viewer channel is told to upgrade, and a malformed protocol fails', async t => {
  installWindow('?viewer=true&viewerId=viewer-1&viewerToken=secret-1');
  protocolFixture.passthrough = true;
  t.after(() => {
    protocolFixture.passthrough = false;
  });
  for (const response of [
    () => new Response('missing', { status: 404 }),
    // The protocol of a cellucid package from before the channel.
    () => new Response(JSON.stringify({ events: ['ready'], commands: ['ping'] }), { status: 200 }),
    // From before binary commands: its highlights are JSON text.
    () => new Response(JSON.stringify({
      channel: '_cellucid/ws', events: ['ready'], commands: ['highlight', 'ping'],
    }), { status: 200 }),
  ]) {
    globalThis.fetch = protocolServer(response);
    const source = new ViewerHostDataSource(getViewerHostConfig());
    await assert.rejects(source.initialize(), /older than this viewer.*pip install -U cellucid.*install\.packages/);
    assert.equal(source.isConnected(), false);
  }
  for (const body of [
    { channel: '_cellucid/ws', events: ['ready'], binaryCommands: [] },
    { channel: '_cellucid/ws', events: ['ready', 'ready'], commands: [], binaryCommands: [] },
    { channel: '_cellucid/ws', events: ['ready'], commands: [7], binaryCommands: [] },
    { channel: '_cellucid/ws', events: 'ready', commands: [], binaryCommands: [] },
    { channel: '_cellucid/ws', events: [], commands: [], binaryCommands: [], version: '1' },
    { channel: '_cellucid/ws', events: [], commands: ['ping'], binaryCommands: 'highlight' },
    // A binary command must be one of the host's commands.
    { channel: '_cellucid/ws', events: [], commands: ['ping'], binaryCommands: ['highlight'] },
    { channel: 'elsewhere', events: [], commands: [], binaryCommands: [] },
  ]) {
    globalThis.fetch = protocolServer(() => new Response(JSON.stringify(body), { status: 200 }));
    const source = new ViewerHostDataSource(getViewerHostConfig());
    await assert.rejects(source.initialize(), /protocol|viewer channel must be at/);
    assert.equal(source.isConnected(), false);
  }
  // A command this viewer reads in one form, which the host sends in the other.
  for (const body of [
    { channel: '_cellucid/ws', events: [], commands: ['highlight', 'ping'], binaryCommands: [] },
    { channel: '_cellucid/ws', events: [], commands: ['highlight', 'ping'], binaryCommands: ['highlight', 'ping'] },
  ]) {
    globalThis.fetch = protocolServer(() => new Response(JSON.stringify(body), { status: 200 }));
    const source = new ViewerHostDataSource(getViewerHostConfig());
    await assert.rejects(source.initialize(), /in a form this viewer does not read.*Upgrade both/);
    assert.equal(source.isConnected(), false);
  }
  // A newer host's command this viewer does not know yet is not refused here.
  assert.equal(
    requireViewerHostProtocolPayload({
      channel: '_cellucid/ws', events: [], commands: ['highlight', 'later'], binaryCommands: ['highlight', 'later'],
    }).binaryCommands.has('later'),
    true,
  );
  globalThis.fetch = protocolServer(() => new Response('down', { status: 503 }));
  const source = new ViewerHostDataSource(getViewerHostConfig());
  await assert.rejects(source.initialize(), /HTTP 503/);
  assert.deepEqual(requireViewerHostProtocolPayload(CURRENT_PROTOCOL).channel, '_cellucid/ws');
});

test('the host is named from its server info, and an unknown runtime is refused', async t => {
  installWindow('?viewer=true&viewerId=viewer-1&viewerToken=secret-1');
  protocolFixture.passthrough = true;
  t.after(() => {
    protocolFixture.passthrough = false;
  });
  const protocol = () => new Response(JSON.stringify(CURRENT_PROTOCOL), { status: 200 });
  for (const [runtime, label] of [['r', 'R'], ['jupyter', 'Jupyter'], ['python', 'Python']]) {
    globalThis.fetch = protocolServer(protocol, runtime);
    const source = new ViewerHostDataSource(getViewerHostConfig());
    assert.equal(source.getHostLabel(), null);
    assert.equal(await source.initialize(), true);
    assert.equal(source.getHostLabel(), label);
    source.disconnect();
  }
  globalThis.fetch = protocolServer(protocol, 'perl');
  const source = new ViewerHostDataSource(getViewerHostConfig());
  await assert.rejects(source.initialize(), /runtime must be one of python, jupyter, r/);
  const health = { status: 'ok', type: 'anndata', version: '1.0.0', format: 'h5ad', n_cells: 3, n_genes: 2 };
  assert.throws(
    () => requireViewerHostInfoPayload({ ...hostInfo(health, 'r'), n_cells: 4 }, health),
    /same server and dataset/
  );
});

test('setDataMapping is validated before delivery, and a failure reaches the host', async t => {
  silenceNotifications(t);
  const { source, socket } = await connectedSource();
  source.acceptCommands();
  const delivered = [];
  source.onMessage(message => {
    delivered.push(message);
    if (message.type === 'setDataMapping') {
      throw new RangeError("obsp['distances'] is not symmetric — choose a connectivities matrix");
    }
  });
  socket.hostSend({ type: 'setDataMapping', requestId: 'req-1', mapping: { kind: 'anndata' } });
  assert.equal(delivered.length, 0);
  socket.hostSend({ type: 'setDataMapping', requestId: 'req-2', mapping: REPORTED_MAPPING, extra: 1 });
  assert.equal(delivered.length, 0);
  socket.hostSend({ type: 'setDataMapping', requestId: 'req-3', mapping: REPORTED_MAPPING });
  assert.equal(delivered.length, 1);
  const frames = await decodeFrames(socket.frames);
  assert.deepEqual(frames.map(event => [event.type, event.command]), [
    ['command_error', 'setDataMapping'],
    ['command_error', 'setDataMapping'],
    ['command_error', 'setDataMapping'],
  ]);
  assert.match(frames[2].reason, /not symmetric/);
  source.disconnect();
});
