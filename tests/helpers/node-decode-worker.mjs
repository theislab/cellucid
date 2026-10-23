/**
 * The browser's dedicated-worker interface over `node:worker_threads`, for
 * running `assets/js/formats/io/decode-worker.js` (and the decode pool around
 * it) in Node, where no global `Worker` exists.
 *
 * The worker thread gets a `self` with `addEventListener('message')` and
 * `postMessage(message, transfer)`; messages that arrive before the module
 * has registered its listener wait for it, as a browser's port queue does.
 * Workers keep the process alive until terminated: a test ends by calling
 * `configureDecodePool()`, which terminates the pool's workers.
 */
import { Worker } from 'node:worker_threads';

const DECODE_WORKER = new URL('../../assets/js/formats/io/decode-worker.js', import.meta.url).href;

const BOOTSTRAP = `
const { parentPort } = require('node:worker_threads');
const listeners = [];
const waiting = [];
globalThis.self = globalThis;
globalThis.postMessage = (message, transfer) => parentPort.postMessage(message, transfer);
globalThis.addEventListener = (type, listener) => {
  if (type !== 'message') return;
  listeners.push(listener);
  for (const data of waiting.splice(0)) listener({ data });
};
parentPort.on('message', data => {
  if (listeners.length === 0) waiting.push(data);
  else for (const listener of listeners) listener({ data });
});
import(workerData.url).catch(error => {
  parentPort.postMessage({ bootstrapError: String(error && error.stack || error) });
});
`;

/**
 * A worker over `node:worker_threads` with the Web Worker methods the decode
 * pool uses.
 *
 * @param {{url?: string, failToLoad?: boolean}} [options] - `failToLoad`: a
 *   worker whose script cannot load (it reports an `error` event)
 * @returns {{postMessage: Function, addEventListener: Function, terminate: Function}}
 */
export function createNodeDecodeWorker({ url = DECODE_WORKER, failToLoad = false } = {}) {
  const listeners = { message: [], error: [], messageerror: [] };
  const code = BOOTSTRAP.replace('workerData.url', JSON.stringify(failToLoad ? `${url}.missing.js` : url));
  const worker = new Worker(code, { eval: true });
  worker.on('message', data => {
    if (data?.bootstrapError !== undefined) {
      for (const listener of listeners.error) listener({ message: data.bootstrapError, preventDefault() {} });
      return;
    }
    for (const listener of listeners.message) listener({ data });
  });
  worker.on('error', error => {
    for (const listener of listeners.error) listener({ message: String(error), preventDefault() {} });
  });
  return {
    postMessage: (message, transfer) => worker.postMessage(message, transfer),
    addEventListener: (type, listener) => listeners[type]?.push(listener),
    terminate: () => {
      worker.terminate();
    },
  };
}
