/**
 * The embedded viewer's transport (`data/viewer-embed.js`,
 * `formats/io/host-fetch.js`): the handshake with the frame that embeds the
 * page, the requests to `EMBEDDED_HOST_ORIGIN` answered over its port, the
 * viewer channel over `PortSocket`, the port a reader worker is handed, and
 * a whole `ViewerHostDataSource` initialized through it.
 *
 * The widget is played by this test: it answers the page's `ready` with a
 * `connect` carrying a real `MessagePort`, and the other end of that port is
 * a fake kernel that answers the host's documents and says `welcome`, as
 * cellucid-python's widget does (`cellucid.jupyter._widget`).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EMBEDDED_HOST_ORIGIN,
  adoptHostRequesterPort,
  hasHostRequester,
  hostRequesterPort,
  routedFetch,
  setHostRequester,
} from '../assets/js/formats/io/host-fetch.js';
import {
  VIEWER_EMBED_KEY,
  connectEmbeddedHost,
  isEmbeddedViewerAddress,
  resetEmbeddedHostConnection,
} from '../assets/js/data/viewer-embed.js';
import {
  EMBEDDED_VIEWER_HOST,
  ViewerHostDataSource,
  getViewerHostConfig,
} from '../assets/js/data/viewer-host-source.js';
import { viewerProtocolDocument } from '../assets/js/data/viewer-protocol.js';

/** A window that frames the page: `scope.parent` is `parent`, and the page's messages arrive on `scope`. */
function embeddingPage() {
  const scope = new EventTarget();
  const posted = [];
  const parent = {
    postMessage(data, targetOrigin) {
      posted.push({ data, targetOrigin });
    },
  };
  scope.parent = parent;
  return { scope, parent, posted };
}

/** A window message (Node's MessageEvent takes only a port as its source). */
function deliver(scope, data, { source, ports = [] }) {
  const event = new Event('message');
  Object.defineProperties(event, {
    data: { value: data },
    source: { value: source },
    ports: { value: ports },
  });
  scope.dispatchEvent(event);
}

/** The kernel's end of the page's port: answers requests and channel frames. */
function fakeKernel(port, { documents = {}, files = {} } = {}) {
  const kernel = { opened: [], frames: [], closes: [], requests: [] };
  port.onmessage = event => {
    const message = event.data;
    if (message.t === 'fetch') {
      kernel.requests.push({ method: message.method, path: message.path, range: message.range });
      if (Object.hasOwn(documents, message.path)) {
        const bytes = new TextEncoder().encode(JSON.stringify(documents[message.path])).buffer;
        port.postMessage({ t: 'answer', id: message.id, status: 200, headers: { 'Content-Type': 'application/json' }, bytes }, [bytes]);
        return;
      }
      const file = files[message.path];
      if (file === undefined) {
        port.postMessage({ t: 'answer', id: message.id, status: 404, headers: {}, bytes: new ArrayBuffer(0) });
        return;
      }
      const match = /^bytes=(\d+)-(\d+)$/.exec(message.range ?? '');
      const [start, end] = match === null ? [0, file.length - 1] : [Number(match[1]), Number(match[2])];
      const bytes = file.slice(start, end + 1).buffer;
      port.postMessage({
        t: 'answer',
        id: message.id,
        status: match === null ? 200 : 206,
        headers: match === null ? {} : { 'Content-Range': `bytes ${start}-${end}/${file.length}` },
        bytes,
      }, [bytes]);
      return;
    }
    if (message.t === 'open') {
      kernel.opened.push(message.s);
      return;
    }
    if (message.t === 'close') {
      kernel.closes.push({ s: message.s, code: message.code });
      return;
    }
    kernel.frames.push(message);
    if (message.t === 'text' && message.text.startsWith('{"type":"hello"')) {
      port.postMessage({ t: 'text', s: message.s, text: JSON.stringify({ type: 'welcome' }) });
    }
  };
  return kernel;
}

test.afterEach(() => {
  resetEmbeddedHostConnection();
});

test('the embedded address is exactly viewer=embedded and carries no credentials', () => {
  assert.equal(isEmbeddedViewerAddress(new URLSearchParams('viewer=embedded')), true);
  for (const search of ['viewer=true', 'viewer=framed', 'viewer=embedded&viewerId=a', 'viewer=embedded&viewer=embedded', 'embedded=true']) {
    assert.equal(isEmbeddedViewerAddress(new URLSearchParams(search)), false, search);
  }
  globalThis.window = { location: new URL('https://www.cellucid.com/?viewer=embedded') };
  try {
    assert.equal(getViewerHostConfig(), EMBEDDED_VIEWER_HOST);
  } finally {
    delete globalThis.window;
  }
});

test('the page says ready to its parent and accepts connect only from it, well formed, with one port', async () => {
  const { scope, parent, posted } = embeddingPage();
  const connecting = connectEmbeddedHost({ scope });
  assert.deepEqual(posted, [{ data: { [VIEWER_EMBED_KEY]: 'ready' }, targetOrigin: '*' }]);
  const stranger = {};
  const { port1, port2 } = new MessageChannel();
  const good = { [VIEWER_EMBED_KEY]: 'connect', viewerId: 'v1', viewerToken: 't1' };
  // Another window, a malformed message, a message without a port: ignored.
  deliver(scope, good, { source: stranger, ports: [port2] });
  deliver(scope, { ...good, extra: 1 }, { source: parent, ports: [port2] });
  deliver(scope, { ...good, viewerToken: 'with space' }, { source: parent, ports: [port2] });
  deliver(scope, good, { source: parent, ports: [] });
  let settled = false;
  connecting.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(hasHostRequester(), false);
  deliver(scope, good, { source: parent, ports: [port2] });
  const { config, WebSocketImpl } = await connecting;
  assert.deepEqual(config, { serverUrl: EMBEDDED_HOST_ORIGIN, viewerId: 'v1', viewerToken: 't1' });
  assert.equal(typeof WebSocketImpl, 'function');
  assert.equal(hasHostRequester(), true);
  // Once per page: whoever asks again gets the same connection.
  assert.equal(await connectEmbeddedHost({ scope }), await connecting);
  port1.close();
});

test('requests to the embedded host travel the port, ranges and statuses included; others go to fetch', async () => {
  const { scope, parent } = embeddingPage();
  const connecting = connectEmbeddedHost({ scope });
  const { port1, port2 } = new MessageChannel();
  const file = Uint8Array.from({ length: 64 }, (_, index) => index);
  const kernel = fakeKernel(port1, { files: { '_cellucid/anndata/d.h5ad': file } });
  deliver(scope, { [VIEWER_EMBED_KEY]: 'connect', viewerId: 'v', viewerToken: 't' }, { source: parent, ports: [port2] });
  await connecting;

  const ranged = await routedFetch(`${EMBEDDED_HOST_ORIGIN}/_cellucid/anndata/d.h5ad`, { headers: { Range: 'bytes=8-15' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('Content-Range'), 'bytes 8-15/64');
  assert.deepEqual([...new Uint8Array(await ranged.arrayBuffer())], [8, 9, 10, 11, 12, 13, 14, 15]);
  const missing = await routedFetch(`${EMBEDDED_HOST_ORIGIN}/_cellucid/anndata/absent`);
  assert.equal(missing.status, 404);
  assert.deepEqual(kernel.requests, [
    { method: 'GET', path: '_cellucid/anndata/d.h5ad', range: 'bytes=8-15' },
    { method: 'GET', path: '_cellucid/anndata/absent', range: null },
  ]);
  await assert.rejects(routedFetch(`${EMBEDDED_HOST_ORIGIN}/x`, { method: 'POST' }), TypeError);

  // An aborted request rejects at once; its late answer is dropped.
  const controller = new AbortController();
  const aborted = routedFetch(`${EMBEDDED_HOST_ORIGIN}/_cellucid/anndata/d.h5ad`, { signal: controller.signal });
  controller.abort();
  await assert.rejects(aborted, error => error.name === 'AbortError');

  // A URL of any other origin is fetch's.
  const native = globalThis.fetch;
  globalThis.fetch = async url => new Response(`fetched ${url}`);
  try {
    assert.equal(await (await routedFetch('https://example.org/a')).text(), 'fetched https://example.org/a');
  } finally {
    globalThis.fetch = native;
  }
  port1.close();
});

test('a worker reads the host through the port the page hands it', async () => {
  setHostRequester(async request => ({
    status: 206,
    headers: { 'Content-Range': 'bytes 0-2/3' },
    bytes: new TextEncoder().encode(`${request.method} ${request.path} ${request.range}`).buffer,
  }));
  const port = hostRequesterPort();
  assert.ok(port instanceof MessagePort);
  // The worker's realm is played by the same module: it adopts the port, so
  // its requests now travel to the page's requester above.
  adoptHostRequesterPort(port);
  const answer = await routedFetch(`${EMBEDDED_HOST_ORIGIN}/_cellucid/health`, { headers: { Range: 'bytes=0-2' } });
  assert.equal(await answer.text(), 'GET _cellucid/health bytes=0-2');
  port.close();
  setHostRequester(null);
  assert.equal(hostRequesterPort(), null);
});

test('a viewer host source opens its channel and reads its documents through the widget', async () => {
  const { scope, parent } = embeddingPage();
  globalThis.window = { location: new URL('https://www.cellucid.com/?viewer=embedded') };
  const realParent = Object.getOwnPropertyDescriptor(globalThis, 'parent');
  const realListener = globalThis.addEventListener;
  // `connectEmbeddedHost()` reads the page's own window: this one.
  globalThis.parent = parent;
  globalThis.addEventListener = scope.addEventListener.bind(scope);
  globalThis.removeEventListener = scope.removeEventListener.bind(scope);
  const health = { status: 'ok', type: 'anndata', version: '0.9.6', format: 'h5ad', n_cells: 2, n_genes: 1 };
  const { status: _status, ...shared } = health;
  const { port1, port2 } = new MessageChannel();
  const kernel = fakeKernel(port1, {
    documents: {
      '_cellucid/health': health,
      '_cellucid/info': { ...shared, host: null, port: null, runtime: 'jupyter' },
      '_cellucid/protocol': viewerProtocolDocument(),
    },
  });
  try {
    const source = new ViewerHostDataSource(getViewerHostConfig());
    assert.equal(source.isEmbedded(), true);
    const initialized = source.initialize();
    await new Promise(resolve => setImmediate(resolve));
    deliver(scope, { [VIEWER_EMBED_KEY]: 'connect', viewerId: 'v9', viewerToken: 'secret' }, { source: parent, ports: [port2] });
    assert.equal(await initialized, true);
    assert.equal(source.getHostLabel(), 'Jupyter');
    assert.deepEqual(source.getConnectionInfo(), { serverUrl: EMBEDDED_HOST_ORIGIN, viewerId: 'v9', status: 'connected' });
    assert.deepEqual(kernel.requests.map(request => request.path).sort(), ['_cellucid/health', '_cellucid/info', '_cellucid/protocol']);
    // The channel said hello with the widget's credentials, on socket 0.
    assert.deepEqual(kernel.opened, [0]);
    assert.deepEqual(JSON.parse(kernel.frames[0].text), { type: 'hello', viewerId: 'v9', viewerToken: 'secret' });

    // A command from the kernel reaches the app; an event reaches the kernel.
    const commands = [];
    source.onMessage(message => commands.push(message.type));
    source.acceptCommands();
    port1.postMessage({ t: 'text', s: 0, text: JSON.stringify({ type: 'resetCamera' }) });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(commands, ['resetCamera']);

    // The widget's output went away: the channel ends as stopped.
    const ends = [];
    source.onChannelEnd(end => ends.push(end.kind));
    port1.postMessage({ t: 'close', s: 0, code: 1001, reason: 'The viewer was stopped' });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(ends, ['stopped']);
    source.destroy();
  } finally {
    port1.close();
    delete globalThis.window;
    if (realParent === undefined) delete globalThis.parent;
    else Object.defineProperty(globalThis, 'parent', realParent);
    globalThis.addEventListener = realListener;
    delete globalThis.removeEventListener;
  }
});

test('a port socket sends frames in order, a Blob\'s bytes included, and hands binary frames over as ArrayBuffers', async () => {
  const { scope, parent } = embeddingPage();
  const connecting = connectEmbeddedHost({ scope });
  const { port1, port2 } = new MessageChannel();
  const kernel = fakeKernel(port1);
  deliver(scope, { [VIEWER_EMBED_KEY]: 'connect', viewerId: 'v', viewerToken: 't' }, { source: parent, ports: [port2] });
  const { WebSocketImpl } = await connecting;
  const socket = new WebSocketImpl('wss://host.cellucid.invalid/_cellucid/ws');
  socket.binaryType = 'arraybuffer';
  const received = [];
  socket.onmessage = event => received.push(event.data);
  await new Promise(resolve => { socket.onopen = resolve; });
  socket.send(JSON.stringify({ type: 'hello', viewerId: 'v', viewerToken: 't' }));
  socket.send(new Blob([new Uint8Array([1, 2, 3])]));
  socket.send('after the blob');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(kernel.frames.map(frame => frame.t), ['text', 'binary', 'text']);
  assert.deepEqual([...new Uint8Array(kernel.frames[1].bytes)], [1, 2, 3]);
  assert.equal(kernel.frames[2].text, 'after the blob');
  const body = new Uint8Array([9, 8]).buffer;
  port1.postMessage({ t: 'binary', s: 0, bytes: body }, [body]);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(received[1] instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(received[1])], [9, 8]);
  socket.close(1000, 'done');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(kernel.closes, [{ s: 0, code: 1000 }]);
  port1.close();
});

test('a request the worker withdraws is withdrawn on the page, and the page tells the widget', async () => {
  let pageSignal = null;
  setHostRequester((request, { signal }) => new Promise((resolve, reject) => {
    pageSignal = signal;
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const port = hostRequesterPort();
  adoptHostRequesterPort(port);
  const controller = new AbortController();
  const reading = routedFetch(`${EMBEDDED_HOST_ORIGIN}/_cellucid/anndata/d.h5ad`, { headers: { Range: 'bytes=0-9' }, signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(pageSignal instanceof AbortSignal && !pageSignal.aborted);
  controller.abort();
  await assert.rejects(reading, error => error.name === 'AbortError');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(pageSignal.aborted, true, 'the page\'s request was aborted too');
  port.close();
  setHostRequester(null);

  // The page's end of the widget's port: a withdrawn request is a `cancel`.
  const { scope, parent } = embeddingPage();
  const connecting = connectEmbeddedHost({ scope });
  const { port1, port2 } = new MessageChannel();
  const seen = [];
  port1.onmessage = event => seen.push(event.data);
  deliver(scope, { [VIEWER_EMBED_KEY]: 'connect', viewerId: 'v', viewerToken: 't' }, { source: parent, ports: [port2] });
  await connecting;
  const withdrawn = new AbortController();
  const pending = routedFetch(`${EMBEDDED_HOST_ORIGIN}/_cellucid/anndata/d.h5ad`, { signal: withdrawn.signal });
  await new Promise(resolve => setTimeout(resolve, 10));
  withdrawn.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  await new Promise(resolve => setTimeout(resolve, 10));
  const fetch = seen.find(message => message.t === 'fetch');
  assert.deepEqual(seen.find(message => message.t === 'cancel'), { t: 'cancel', id: fetch.id });
  port1.close();
});

test('a request to a notebook kernel that stays silent is waited for and said, never asked again', async () => {
  const { fetchOnce } = await import('../assets/js/formats/io/byte-source.js');
  const { ResponseClock } = await import('../assets/js/formats/io/link.js');
  let asked = 0;
  let answer = null;
  setHostRequester(() => {
    asked++;
    return new Promise(resolve => { answer = resolve; });
  });
  let now = 0;
  const timers = [];
  const clock = new ResponseClock({
    clock: () => now,
    after: (ms, callback) => {
      const timer = { at: now + ms, callback, done: false };
      timers.push(timer);
      return () => { timer.done = true; };
    },
  });
  const said = [];
  clock.onRetry = error => said.push(error.message);
  const pending = fetchOnce(`${EMBEDDED_HOST_ORIGIN}/_cellucid/health`, {}, { fetchImpl: routedFetch, clock });
  // Ten seconds of silence (a cell running): the timeout passes several times.
  for (let step = 0; step < 10; step++) {
    now += 1000;
    for (const timer of timers.filter(entry => !entry.done && entry.at <= now)) {
      timer.done = true;
      timer.callback();
    }
  }
  assert.equal(asked, 1, 'asked once');
  assert.ok(said.length >= 1 && /still waiting/.test(said[0]), said.join(' | '));
  answer({ status: 200, headers: {}, bytes: new TextEncoder().encode('ok').buffer });
  const { response } = await pending;
  assert.equal(response.status, 200);
  setHostRequester(null);
});
