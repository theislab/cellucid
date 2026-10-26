/**
 * The transcoders, by input format id (`data/input-formats.js`): how a
 * format that is one stream (no random access) becomes an AnnData Zarr
 * store, in one pass over its bytes. `open.js` hands a transcoder the
 * source, and opens the store it returns with the Zarr reader; everything
 * after that reads it as it reads any AnnData Zarr store.
 *
 * Each transcoder is
 *
 *     {
 *       transcode(source, context): Promise<{store, name, link, conversion}>,
 *     }
 *
 * `source` is the request's (`{file}`, `{files, rootName}` or `{url, name}`);
 * `context` is `{signal, activity, onTransfer, byteReaderOf(file)}`, where
 * `byteReaderOf` gives the byte reader of one file of the source (local or
 * remote, measured as it is read). `store` is a Zarr store
 * (`formats/zarr/stores/*`), `link` the `LinkMeter` the source was read over,
 * `conversion` where the store is kept and what was not read
 * (`session.js`, shown in the Dataset box).
 *
 * @module data/anndata/transcode
 */

import { transcodeRFile } from './r-object.js';
import { transcodeMatrixMarketFolder } from './matrix-market.js';

/** @type {Readonly<Record<string, Readonly<{transcode: Function}>>>} */
export const TRANSCODERS = Object.freeze({
  rds: Object.freeze({ transcode: transcodeRFile }),
  rda: Object.freeze({ transcode: transcodeRFile }),
  mtx: Object.freeze({ transcode: transcodeMatrixMarketFolder }),
});
