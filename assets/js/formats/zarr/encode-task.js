/**
 * Encoding a Zarr v2 chunk on a decode worker (`formats/io/decode-pool.js`,
 * `runOnDecodeWorker`): deflate is the slow part of writing a store (measured:
 * 25_decisions_exports.md), so a copy's chunks are encoded on
 * every core while the reader thread reads the next ones
 * (`data/anndata/write/pool-encoder.js`). It depends on nothing a worker
 * cannot load.
 *
 * @module formats/zarr/encode-task
 */

import { encodeV2Chunk } from './writer.js';

/**
 * @param {{values: Uint8Array|Array<string|null>, codecs: {filters: Array<Object>|null, compressor: Object|null}}} args
 * @returns {{bytes: Uint8Array}}
 */
export function encodeChunk({ values, codecs }) {
  return { bytes: encodeV2Chunk(values, codecs) };
}
