/**
 * A sink in the reader worker for bytes the page writes (`copy.js`'s
 * archive, written to a file the page holds: the File System Access API's
 * writable, or a spool in this browser's private storage): parts are
 * gathered into batches of about `batchBytes`, each posted to the page with
 * its buffers transferred, and the page answers each batch once it has
 * written it. No more than `windowBytes` are posted and not yet answered,
 * so a slow disk paces the copy and the bytes between the two threads stay
 * bounded, whatever the copy's size.
 *
 * Protocol (`anndata-reader-worker.js` `writeAnnDataCopy`): the worker posts
 * `{event: 'partial', id, copy: ticket, parts: Uint8Array[]}`; the page
 * answers `{copyWritten: ticket}`, or `{copyWritten: ticket, error}` when it
 * could not write them (the copy then fails with that error).
 *
 * @module data/anndata/write/acknowledged-sink
 */

import { onAbort, abortReason } from '../../../utils/abort.js';

/** Bytes gathered into one message to the page (a message per chunk would be thousands). */
export const COPY_BATCH_BYTES = 4 * 1024 * 1024;
/** Bytes posted and not yet written by the page: a few batches in flight keep the disk busy. */
export const COPY_WINDOW_BYTES = 4 * COPY_BATCH_BYTES;

/**
 * @param {(message: {copy: number, parts: Uint8Array[]}) => void} post
 * @param {{ticket: number, signal?: AbortSignal|null, batchBytes?: number, windowBytes?: number}} options
 * @returns {{sink: import('../../../formats/zip/writer.js').ZipSink,
 *   acknowledge: (error?: Error|null) => void, drain: () => Promise<void>, release: () => void}}
 */
export function createAcknowledgedSink(post, { ticket, signal = null, batchBytes = COPY_BATCH_BYTES, windowBytes = COPY_WINDOW_BYTES }) {
  let batch = [];
  let batchSize = 0;
  /** Sizes of the batches posted and not yet answered, oldest first. */
  const posted = [];
  let inFlight = 0;
  let failure = null;
  /** Waiting for an answer: resolved by the next one. */
  let waiting = null;

  const wake = () => {
    const resolve = waiting;
    waiting = null;
    resolve?.();
  };
  const removeAbort = onAbort(signal, () => {
    failure ??= abortReason(signal);
    wake();
  });

  const flush = () => {
    if (batch.length === 0) return;
    const parts = batch;
    posted.push(batchSize);
    inFlight += batchSize;
    batch = [];
    batchSize = 0;
    post({ copy: ticket, parts });
  };

  /** Wait until no more than `limit` bytes are posted and unanswered. */
  const settle = async limit => {
    while (failure === null && inFlight > limit) {
      await new Promise(resolve => {
        waiting = resolve;
      });
    }
    if (failure !== null) throw failure;
  };

  return {
    sink: {
      async write(part) {
        if (failure !== null) throw failure;
        if (!(part instanceof Uint8Array)) throw new TypeError('The copy posts bytes to the page.');
        batch.push(part);
        batchSize += part.byteLength;
        if (batchSize >= batchBytes) {
          flush();
          await settle(windowBytes);
        }
      },
    },
    /** The page wrote the oldest batch (or could not: `error`). */
    acknowledge(error = null) {
      if (error !== null) failure ??= error;
      inFlight -= posted.shift() ?? 0;
      wake();
    },
    /** Post what is gathered and wait until the page has written every byte. */
    async drain() {
      try {
        flush();
        await settle(0);
      } finally {
        removeAbort();
      }
    },
    /** A copy that failed: nothing more is posted, and the signal is let go. */
    release() {
      failure ??= new Error('The copy stopped.');
      removeAbort();
      wake();
    },
  };
}
