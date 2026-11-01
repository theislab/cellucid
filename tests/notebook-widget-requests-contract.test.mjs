/**
 * The notebook widget's front end (`widget.js`, shared byte for byte by
 * cellucid-python and cellucid-r) relays the page's requests to the kernel:
 * the requests of one task go as one message at once (the kernel answers
 * each as it is ready: Python on threads, R in turn), nothing waits on
 * answers still out, and a request the page withdraws before its message
 * went is never sent; a kernel that takes a few messages at once
 * (`_fetch_messages`, R) has at most that many, the requests asked meanwhile
 * gathered into the next. Driven here with a fake output, frame and kernel
 * model.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { until } from './helpers/until.mjs';

// Both shipped copies, each with the checkout it was read from. The
// behaviour contracts below run on each copy, so when the two differ (a
// sibling repository checked out before its push landed, in CI) the copy
// that is behind is the one named by its failing behaviour tests.
const COPIES = [
  { repository: 'cellucid-python', file: new URL('../../cellucid-python/src/cellucid/jupyter/static/widget.js', import.meta.url) },
  { repository: 'cellucid-r', file: new URL('../../cellucid-r/inst/widget/widget.js', import.meta.url) },
];
const APP = 'https://www.cellucid.com';

/** The commit a sibling checkout is at, with its date, or why it is unknown. */
function checkoutOf(repository) {
  const directory = fileURLToPath(new URL(`../../${repository}`, import.meta.url));
  try {
    return execFileSync('git', ['-C', directory, 'log', '-1', '--format=%h committed %cI'], { encoding: 'utf8' }).trim();
  } catch {
    return 'commit unknown (not a git checkout)';
  }
}

// Messages cross the page's port after no fixed time (later on Windows):
// a test waits for what the widget sends (`until`), or for the widget to have
// heard the page (`quiet`), never for a pause.

/** A notebook output with the widget rendered in it, and its page connected. */
async function renderedWidget(t, source, state = {}) {
  const { default: widget } = await import(source.href);
  const frames = [];
  globalThis.document = {
    createElement(tag) {
      const element = { tag, style: {}, append() {}, setAttribute() {}, addEventListener() {} };
      if (tag === 'iframe') {
        element.posted = [];
        element.contentWindow = { postMessage: (message, origin, transfer) => element.posted.push({ message, origin, transfer }) };
        frames.push(element);
      }
      return element;
    },
  };
  const windowListeners = new Map();
  globalThis.window = {
    addEventListener: (name, listener) => windowListeners.set(name, listener),
    removeEventListener: name => windowListeners.delete(name),
  };
  const sent = [];
  const kernelListeners = [];
  const model = {
    get: name => ({ web_source_url: APP, height: 600, _binary: 'buffers', ...state }[name]),
    send: content => sent.push(content),
    on: (name, listener) => { if (name === 'msg:custom') kernelListeners.push(listener); },
    off: () => {},
  };
  const end = widget.render({ model, el: { append() {} } });
  const view = sent.find(message => message.t === 'attach').v;
  const fromKernel = message => kernelListeners.forEach(listener => listener({ ...message, v: view }, []));
  fromKernel({ t: 'credentials', viewerId: 'v', viewerToken: 't' });
  const frame = frames[0];
  windowListeners.get('message')({ source: frame.contentWindow, origin: APP, data: { cellucidViewerEmbed: 'ready' } });
  const page = frame.posted.at(-1).transfer[0];
  const answers = [];
  page.onmessage = event => answers.push(event.data);
  t.after(() => {
    end();
    page.close();
    delete globalThis.document;
    delete globalThis.window;
  });
  let probes = 0;
  return {
    page,
    answers,
    /**
     * Resolves once the widget heard every message the page sent before, and
     * ran the task that gathers what they asked: a port delivers in order,
     * and an `open` after them is relayed to the kernel as it is heard.
     */
    async quiet() {
      const s = -(++probes);
      page.postMessage({ t: 'open', s });
      await until(() => sent.some(message => message.t === 'open' && message.s === s), 'the widget heard the page');
      await new Promise(resolve => setTimeout(resolve, 0));
    },
    batches: () => sent.filter(message => message.t === 'fetch').map(message => message.requests.map(request => request.id)),
    answer: ids => fromKernel({ t: 'answers', answers: ids.map(id => ({ id, status: 404, headers: {}, buffer: -1 })) }),
  };
}

test('the Python and R packages ship the same widget front end', () => {
  const [python, r] = COPIES.map(({ repository, file }) => {
    const bytes = readFileSync(file);
    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
    return { bytes, said: `${repository} at ${checkoutOf(repository)}: ${bytes.length} bytes, sha256 ${digest}` };
  });
  assert.ok(
    python.bytes.equals(r.bytes),
    `the two widget.js copies differ (${python.said}; ${r.said}). The copy whose behaviour `
      + 'tests below fail is the one behind; in CI, a sibling checkout taken before that '
      + "repository's push landed is behind until the next run.",
  );
});

for (const { repository, file } of COPIES) {
  test(`${repository}: requests of one task go to the kernel as one message at once, whatever is still unanswered; one withdrawn before it went is never sent`, async t => {
    const widget = await renderedWidget(t, file);
    const ask = id => widget.page.postMessage({ t: 'fetch', id, method: 'GET', path: `p${id}`, range: null });
    const batchesOf = count => until(() => widget.batches().length >= count, `${count} messages to the kernel`);
    // Requests asked while nothing is answered yet (a cell running, a slow
    // chunk): each task's go at once, none held back by the ones still out.
    ask(0);
    await batchesOf(1);
    ask(1);
    await batchesOf(2);
    [2, 3, 4].forEach(ask);
    await batchesOf(3);
    assert.deepEqual(widget.batches(), [[0], [1], [2, 3, 4]], 'one message a task, none waiting on answers');
    // Withdrawn in the task that asked it: it never reaches the kernel.
    ask(5);
    ask(6);
    widget.page.postMessage({ t: 'cancel', id: 5 });
    await batchesOf(4);
    assert.deepEqual(widget.batches()[3], [6], 'without the withdrawn request');
    // Answers in any order, matched by id.
    widget.answer([4, 0, 6, 2, 1, 3]);
    await until(() => widget.answers.length === 6, 'every answer reached the page');
    assert.deepEqual(widget.answers.map(answer => answer.id), [4, 0, 6, 2, 1, 3]);
  });

  test(`${repository}: a kernel taking two fetch messages at once has two: the requests asked meanwhile go together once one is answered`, async t => {
    const widget = await renderedWidget(t, file, { _fetch_messages: 2 });
    const ask = id => widget.page.postMessage({ t: 'fetch', id, method: 'GET', path: `p${id}`, range: null });
    const batchesOf = count => until(() => widget.batches().length >= count, `${count} messages to the kernel`);
    ask(0);
    await batchesOf(1);
    [1, 2].forEach(ask);
    await batchesOf(2);
    // Two with the kernel: the next tasks' requests wait, gathered.
    ask(3);
    await widget.quiet();
    ask(4);
    await widget.quiet();
    assert.deepEqual(widget.batches(), [[0], [1, 2]], 'no third message while two are unanswered');
    // The second answered in part: still two with the kernel.
    widget.answer([1]);
    await until(() => widget.answers.length === 1, 'the answer reached the page');
    assert.deepEqual(widget.batches(), [[0], [1, 2]]);
    assert.deepEqual(widget.answers.map(answer => answer.id), [1]);
    // The first answered whole: the gathered requests go as one message.
    widget.answer([0]);
    await batchesOf(3);
    assert.deepEqual(widget.batches(), [[0], [1, 2], [3, 4]]);
    // Two with the kernel again; a request withdrawn while it waits is never sent.
    ask(5);
    await widget.quiet();
    ask(6);
    widget.page.postMessage({ t: 'cancel', id: 5 });
    await widget.quiet();
    assert.equal(widget.batches().length, 3);
    widget.answer([2]);
    await batchesOf(4);
    assert.deepEqual(widget.batches()[3], [6]);
  });
}
