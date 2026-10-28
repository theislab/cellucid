/**
 * The notebook widget's front end (`widget.js`, shared byte for byte by
 * cellucid-python and cellucid-r) relays the page's requests to the kernel,
 * which answers its messages one after another and none while a cell runs:
 * at most two batches are with the kernel at once (one being answered, the
 * next ready), the rest wait in the front end, and a request the page
 * withdraws before it reached the kernel is never sent. Driven here with a
 * fake output, frame and kernel model.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const SOURCE = new URL('../../cellucid-python/src/cellucid/jupyter/static/widget.js', import.meta.url);
const R_COPY = new URL('../../cellucid-r/inst/widget/widget.js', import.meta.url);
const APP = 'https://www.cellucid.com';

const settle = () => new Promise(resolve => setTimeout(resolve, 10));

/** A notebook output with the widget rendered in it, and its page connected. */
async function renderedWidget(t) {
  const { default: widget } = await import(SOURCE.href);
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
    get: name => ({ web_source_url: APP, height: 600, _binary: 'buffers' }[name]),
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
  return {
    page,
    answers,
    batches: () => sent.filter(message => message.t === 'fetch').map(message => message.requests.map(request => request.id)),
    answer: ids => fromKernel({ t: 'answers', answers: ids.map(id => ({ id, status: 404, headers: {}, buffer: -1 })) }),
  };
}

test('the Python and R packages ship the same widget front end', () => {
  assert.deepEqual(readFileSync(R_COPY), readFileSync(SOURCE));
});

test('requests go to the kernel two batches at a time; the rest wait, and one withdrawn before it went is never sent', async t => {
  const widget = await renderedWidget(t);
  const ask = id => widget.page.postMessage({ t: 'fetch', id, method: 'GET', path: `p${id}`, range: null });
  const batchesOf = async count => {
    for (let tries = 0; tries < 100 && widget.batches().length < count; tries++) await settle();
  };
  // Requests asked while the kernel answers nothing (a cell is running).
  ask(0);
  await batchesOf(1);
  ask(1);
  await batchesOf(2);
  [2, 3, 4].forEach(ask);
  await settle();
  await settle();
  const sent = widget.batches();
  assert.equal(sent.length, 2, `two batches with the kernel: ${JSON.stringify(sent)}`);
  const waiting = Array.from({ length: 5 }, (_, id) => id).filter(id => !sent.flat().includes(id));
  assert.ok(waiting.length >= 2, `the rest wait in the front end: ${waiting}`);
  // The page withdraws one of the waiting requests: it never reaches the kernel.
  const [withdrawn, ...kept] = waiting;
  widget.page.postMessage({ t: 'cancel', id: withdrawn });
  await settle();
  widget.answer(sent[0]);
  await settle();
  const next = widget.batches();
  assert.equal(next.length, 3, 'one batch answered: the next goes');
  assert.deepEqual(next[2], kept, 'without the withdrawn request');
  widget.answer([...sent[1], ...kept]);
  await settle();
  assert.deepEqual(widget.answers.map(answer => answer.id).sort((a, b) => a - b), [...sent.flat(), ...kept].sort((a, b) => a - b));
});
