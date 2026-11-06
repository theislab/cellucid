/**
 * Chunks encoded on the decode workers (`formats/io/decode-pool.js`
 * `runOnDecodeWorker`, task `formats/zarr/encode-task.js`): a copy's chunks
 * are deflated on every core the pool runs while the reader thread reads
 * the next ones, and the store puts each in its turn
 * (`ZarrV2StoreWriter`'s `inFlight`), so the archive's bytes are those of
 * an encoding in this thread. A chunk too small to be worth a message, or a
 * pool that cannot run here, is encoded in this thread.
 *
 * @module data/anndata/write/pool-encoder
 */

import { runOnDecodeWorker } from '../../../formats/io/decode-pool.js';
import { encodeV2Chunk } from '../../../formats/zarr/writer.js';
import { zarrEncodeTaskScript } from '../../../../workers/scripts.js';
import { reportedCores } from '../../../utils/machine.js';

const ENCODE_MODULE = zarrEncodeTaskScript().href;

/**
 * Chunks encoded at once: two for each core, so a core finishing one has
 * the next at hand (each chunk at most a few hundred KB of values,
 * `layout.js`).
 */
export function encodeInFlight(environment = globalThis) {
  return 2 * (reportedCores(environment) ?? 4);
}

/**
 * An encoder for `ZarrV2StoreWriter` that runs on the decode workers.
 *
 * @param {{signal?: AbortSignal|null}} [options]
 * @returns {(values: Uint8Array|Array<string|null>, codecs: Object) => Promise<Uint8Array>}
 */
export function poolEncoder({ signal = null } = {}) {
  return (values, codecs) => {
    const bytes = ArrayBuffer.isView(values);
    // A view of a larger buffer (a slab read from the source) is copied: only a whole buffer moves.
    const own = bytes && (values.byteOffset !== 0 || values.byteLength !== values.buffer.byteLength) ? values.slice() : values;
    return runOnDecodeWorker({
      module: ENCODE_MODULE,
      name: 'encodeChunk',
      args: { values: own, codecs },
      transfer: bytes ? [own.buffer] : [],
      size: bytes ? own.byteLength : values.length * 16,
      signal,
      inThread: () => ({ bytes: encodeV2Chunk(values, codecs) }),
    }).then(result => result.bytes);
  };
}
