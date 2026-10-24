/**
 * Run the figure-export worker's own handler in-process, for Node contract
 * tests (Node has no Web Worker). Importing this module installs it.
 *
 * Messages take the same path as in the browser: a request is structured-
 * cloned (its typed arrays copied, its transfer list detached on the sending
 * side), handled by `createFigureExportWorkerHandler`, and answered on a
 * later microtask. Node has no OffscreenCanvas, so only the CPU operations
 * (bounds, vector point markup) can succeed here: the worker answers `webgl2`
 * with false, the client runs the point passes on its page host (the same
 * handler), and they fail there as they would in a browser without one.
 */

import { setFigureExportWorkerFactory } from '../../assets/js/app/ui/modules/figure-export/utils/figure-export-worker-client.js';
import { createFigureExportWorkerHandler } from '../../assets/js/app/ui/modules/figure-export/utils/figure-export-worker.js';

export function createInProcessFigureExportWorker() {
  const worker = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    terminated: false,
    requests: [],
  };
  const handle = createFigureExportWorkerHandler();
  let queue = Promise.resolve();
  worker.postMessage = (message, transfer = []) => {
    const received = structuredClone(message, { transfer });
    worker.requests.push(received);
    queue = queue.then(async () => {
      const answer = await handle(received);
      if (answer === null || worker.terminated) return;
      worker.onmessage?.({ data: answer.reply });
    });
  };
  worker.terminate = () => {
    worker.terminated = true;
  };
  return worker;
}

setFigureExportWorkerFactory(() => createInProcessFigureExportWorker());
