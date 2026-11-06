/**
 * A Cellucid-ready AnnData written as a `.zarr.zip`, streamed: the element
 * layer (`element-writer.js`) over a Zarr v2 store (`formats/zarr/writer.js`)
 * at the top of a stored ZIP archive (`formats/zip/writer.js`), every array
 * chunked and compressed as the specification lays it out for the browser
 * (`layout.js`).
 *
 * Zarr format 2, as `prepare()` and `cellucid_prepare()` write by default:
 * every anndata release since 0.8 and zarr-python 2 and 3 read it, and the
 * web app reads it as fast as format 3 (specification §3, "Zarr v3").
 *
 * In the archive, each array's chunks follow one another in grid order as
 * they are written, then the metadata documents, the consolidated metadata
 * the very last entry: a reader opens the store with its one read of the
 * archive's end (specification §3, "Where things sit in the file").
 *
 * Two ways in: values in hand (`array`, `strings`, and every element method
 * of the base class: what is written from the page's state), and arrays
 * streamed from a source (`stream`: `ZarrV2ArrayWriter.appendRows` or
 * `writeColumnBlock`, `copy.js`). Memory: the chunk being filled of each
 * array being written, the chunks being encoded (`inFlight`, each put in its
 * turn), and what the caller hands in.
 *
 * @module data/anndata/write/ready-writer
 */

import { AnnDataElementWriter, encodingAttributes as encoding } from './element-writer.js';
import { chunkShapeOf, codecsOf } from './layout.js';
import { ZarrV2StoreWriter, zarrZipSink } from '../../../formats/zarr/writer.js';
import { zarrV2Dtype } from '../../../formats/zarr/format-v2.js';
import { createZipWriter } from '../../../formats/zip/writer.js';

export class CellucidReadyWriter extends AnnDataElementWriter {
  /**
   * @param {import('../../../formats/zip/writer.js').ZipSink} sink - Where the archive's bytes go, in order
   * @param {{encode?: Function, inFlight?: number}} [options] - How chunks are encoded, and how many
   *   at once (`ZarrV2StoreWriter`; `pool-encoder.js` encodes them on the decode workers)
   */
  constructor(sink, { encode = undefined, inFlight = 1 } = {}) {
    super();
    this.zip = createZipWriter(sink);
    this.store = new ZarrV2StoreWriter(zarrZipSink(this.zip), { encode, inFlight });
  }

  /** Whether a group or an array is written at `path`. */
  has(path) {
    return this.store.has(path);
  }

  group(path, attrs = {}) {
    this.store.group(path, attrs);
  }

  /**
   * Declare an array laid out by its role and return its writer, to stream
   * its values into (`appendRows` for an array chunked by rows,
   * `writeColumnBlock` for one chunked by columns too).
   *
   * @param {string} path
   * @param {{shape: number[], dtype: string, role?: string, expression?: boolean, attrs?: Object, maxRows?: number}} array
   *   `maxRows`: `layout.js` `chunkShapeOf`'s
   * @returns {import('../../../formats/zarr/writer.js').ZarrV2ArrayWriter}
   */
  stream(path, { shape, dtype, role = 'whole', expression = false, attrs = {}, maxRows = Infinity }) {
    return this.store.array(path, { shape, dtype, attrs, chunks: chunkShapeOf(role, shape, { maxRows }), ...codecsOf(dtype, { expression }) });
  }

  /**
   * A numeric or boolean array from values in hand.
   *
   * @param {string} path
   * @param {import('./element-writer.js').ArraySpec} spec
   */
  async array(path, { values = null, region = null, dtype = null, shape = null, order = 'C', attrs = encoding('array', '0.2.0'), role = 'whole', expression = false }) {
    if (region !== null || values === null) throw new TypeError(`${path}: a Cellucid-ready writer writes values in hand.`);
    if (order !== 'C') throw new TypeError(`${path}: a Cellucid-ready writer writes arrays in C order.`);
    const type = dtype ?? zarrV2Dtype(values);
    const dims = shape ?? [values.length];
    const writer = this.stream(path, { shape: dims, dtype: type, role, expression, attrs });
    await writeValues(writer, values, dims);
  }

  /**
   * A string array, or with `scalar` a 0-dimensional string.
   *
   * @param {string} path
   * @param {Array<string|null>} values
   * @param {Object} [attrs]
   * @param {{role?: string, scalar?: boolean}} [options]
   */
  async strings(path, values, attrs = encoding('string-array', '0.2.0'), { role = 'whole', scalar = false } = {}) {
    const shape = scalar ? [] : [values.length];
    const writer = this.stream(path, { shape, dtype: '|O', role, attrs });
    if (scalar) await writer.writeChunk([], [values[0] ?? '']);
    else if (values.length > 0) {
      await writer.appendRows(values);
      await writer.end();
    }
  }

  /**
   * Finish the store (its metadata, the consolidated metadata last) and the
   * archive.
   *
   * @returns {Promise<{bytes: number, entries: number, zip64: boolean, chunks: number}>}
   */
  async finish() {
    await this.store.finish();
    const archive = await this.zip.finish();
    return { ...archive, chunks: this.store.chunks };
  }
}

/**
 * Write values in hand through an array's writer: a scalar as its one
 * chunk, an array chunked by rows as rows, one chunked by columns too as one
 * block per band of rows.
 *
 * @param {import('../../../formats/zarr/writer.js').ZarrV2ArrayWriter} writer
 * @param {ArrayBufferView} values
 * @param {number[]} shape
 */
export async function writeValues(writer, values, shape) {
  if (shape.length === 0) {
    await writer.writeChunk([], new Uint8Array(values.buffer, values.byteOffset, values.BYTES_PER_ELEMENT));
    return;
  }
  if (shape.some(extent => extent === 0)) return;
  const columnsWhole = writer.chunks.slice(1).every((extent, axis) => extent === shape[axis + 1]);
  if (columnsWhole) {
    await writer.appendRows(values);
    await writer.end();
    return;
  }
  const [rows, columns] = shape;
  const bandRows = writer.chunks[0];
  for (let band = 0; band * bandRows < rows; band++) {
    const first = band * bandRows;
    const last = Math.min(rows, first + bandRows);
    await writer.writeColumnBlock(band, 0, values.subarray(first * columns, last * columns), columns);
  }
}
