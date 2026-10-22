/**
 * Run the AnnData reader worker's own handler in-process, for Node contract
 * tests (Node has no Web Worker). Importing this module installs it.
 *
 * Messages take the same path as in the browser: the request is handled by
 * `createAnnDataReaderHandler`, and the reply is structured-cloned with its
 * typed arrays transferred, so a reader that kept a transferred buffer would
 * find it detached exactly as in a worker. Files are read through
 * `BytesRangeSource` because Node has no `FileReaderSync`.
 */

import { setAnnDataReaderWorkerFactory } from '../../assets/js/data/anndata-reader-client.js';
import { createAnnDataReaderHandler } from '../../assets/js/data/anndata-reader-worker.js';
import { BytesRangeSource } from '../../assets/js/data/range-source.js';

export function createInProcessAnnDataReaderWorker({
  createRangeSource = async file => new BytesRangeSource(
    new Uint8Array(await file.arrayBuffer()),
    { name: file.name ?? '' }
  ),
} = {}) {
  const worker = {
    onmessage: null,
    onerror: null,
    terminated: false,
    messages: [],
  };
  const deliver = data => {
    if (!worker.terminated) worker.onmessage?.({ data });
  };
  const handle = createAnnDataReaderHandler({
    createRangeSource,
    post: message => queueMicrotask(() => deliver(structuredClone(message))),
  });
  worker.postMessage = (message, transfer = []) => {
    // A transferred buffer is detached on the sending side, as in a browser.
    // Messages that transfer nothing are handed over as they are, because
    // some tests stand in for Files with plain objects a clone would refuse.
    const received = transfer.length > 0 ? structuredClone(message, { transfer }) : message;
    worker.messages.push(received);
    handle(received).then(({ reply, transfer }) => {
      deliver(structuredClone(reply, { transfer }));
    });
  };
  worker.terminate = () => {
    if (worker.terminated) return;
    worker.terminated = true;
    handle({ id: -1, method: 'close', args: [] });
  };
  return worker;
}

setAnnDataReaderWorkerFactory(() => createInProcessAnnDataReaderWorker());
