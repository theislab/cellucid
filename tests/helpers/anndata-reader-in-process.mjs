/**
 * Run the AnnData reader worker's own handler in-process, for Node contract
 * tests (Node has no Web Worker). Importing this module installs it.
 *
 * Messages take the same path as in the browser: the request is handled by
 * `createAnnDataReaderHandler`, and the reply is structured-cloned with its
 * typed arrays transferred, so a reader that kept a transferred buffer would
 * find it detached exactly as in a worker. Files are read as in the browser,
 * as `File`/`Blob` slices.
 */

import { setAnnDataReaderWorkerFactory } from '../../assets/js/data/anndata-reader-client.js';
import { createAnnDataReaderHandler } from '../../assets/js/data/anndata-reader-worker.js';

export function createInProcessAnnDataReaderWorker() {
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
    post: message => queueMicrotask(() => deliver(structuredClone(message))),
  });
  worker.postMessage = (message, transfer = []) => {
    // A transferred buffer is detached on the sending side, as in a browser.
    // Messages that transfer nothing are handed over as they are, because
    // some tests stand in for Files with plain objects a clone would refuse.
    const received = transfer.length > 0 ? structuredClone(message, { transfer }) : message;
    worker.messages.push(received);
    handle(received).then(answer => {
      // A cancel message has no reply of its own.
      if (answer !== null) deliver(structuredClone(answer.reply, { transfer: answer.transfer }));
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
