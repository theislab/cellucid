/**
 * MatrixMarket coordinate files (`.mtx`, `.mtx.gz`): the header and the
 * entries, parsed from bytes as they stream (no line is decoded as text).
 *
 * ```
 * %%MatrixMarket matrix coordinate integer general
 * % comments (Cell Ranger adds %metadata_json: {...})
 * rows cols entries
 * i j value        (1-based; `pattern` files have no value)
 * ```
 *
 * `array` (dense) files, and `symmetric`, `skew-symmetric`, `hermitian` or
 * `complex` matrices are not count matrices and are refused.
 *
 * @module formats/text/matrix-market
 */

import { runOnDecodeWorker, decodePoolStats } from '../io/decode-pool.js';
import { lineText } from './lines.js';
import { MatrixMarketError, scanEntryBlock } from './matrix-market-entries.js';
import { matrixMarketEntriesScript } from '../../../workers/scripts.js';
import { formatCountOf } from '../../utils/format-units.js';

const ENTRIES_MODULE = matrixMarketEntriesScript().href;

/**
 * Bytes of whole entry lines parsed as one block (a scheduling choice): a
 * 100,000-cell matrix (590 MB of text) is about 560 blocks, each worth many
 * times the message that carries it, and the blocks in flight hold a few
 * megabytes per decode worker.
 */
export const ENTRY_BLOCK_BYTES = 1 << 20;

/** Parse the header line. */
export function parseBanner(text) {
  const match = /^%%MatrixMarket\s+matrix\s+(\w+)\s+(\w+)\s+(\w+)/i.exec(text.trim());
  if (match === null) throw new MatrixMarketError('This is not a MatrixMarket file: it does not start with %%MatrixMarket matrix.');
  const [, format, field, symmetry] = match.map(part => part.toLowerCase());
  if (format !== 'coordinate') {
    throw new MatrixMarketError(`This MatrixMarket file stores a dense ${format} matrix; Cellucid reads sparse coordinate matrices (as Cell Ranger and STARsolo write).`, { unsupported: true });
  }
  if (field === 'complex') throw new MatrixMarketError('This MatrixMarket matrix holds complex numbers, which are not counts.', { unsupported: true });
  if (symmetry !== 'general') {
    throw new MatrixMarketError(`This MatrixMarket matrix is ${symmetry}, which a count matrix is not.`, { unsupported: true });
  }
  return { field, symmetry };
}

/**
 * Read one MatrixMarket stream: `onSize({rows, columns, entries, field})`
 * once, then `onEntries(rows, columns, values, count)` per block of entries,
 * in file order: the first `count` of each array (0-based indices as
 * `Int32Array`s; `values` as `valueType`, 1 for a pattern file). The arrays
 * are read during the call only: they are reused for a later block.
 *
 * The header (banner, comments, size line) is read line by line here. The
 * entries, nearly all of a file (a 100,000-cell matrix is 44 million lines),
 * are gathered into blocks of whole lines, and each block is parsed on a
 * decode worker (`scanEntryBlock`), so the parse runs beside the
 * decompression and on as many cores as the decode pool has; the results
 * are taken in order, and a refusal names the entry as a single pass would.
 *
 * @param {AsyncIterable<Uint8Array>} pieces - Decompressed bytes
 * @param {{onSize: Function, onEntries: (rows: Int32Array, columns: Int32Array, values: Float32Array|Float64Array, count: number) => void,
 *   valueType?: 'float32'|'float64', signal?: AbortSignal|null, blockBytes?: number}} handlers
 *   `blockBytes`: the block size (tests make it small)
 * @returns {Promise<{rows: number, columns: number, entries: number, field: string, read: number}>}
 */
export async function readMatrixMarket(pieces, { onSize, onEntries, valueType = 'float64', signal = null, blockBytes = ENTRY_BLOCK_BYTES }) {
  let banner = null;
  let size = null;
  let read = 0;
  let pattern = false;

  const aborted = () => signal?.reason ?? new DOMException('The read was aborted.', 'AbortError');

  /** One header line; true once the size line has been read. */
  function headerLine(bytes, start, end) {
    if (banner === null) {
      banner = parseBanner(lineText(bytes, start, end));
      pattern = banner.field === 'pattern';
      return false;
    }
    if (start === end || bytes[start] === 0x25) return false;
    const parts = lineText(bytes, start, end).trim().split(/\s+/).map(Number);
    if (parts.length < 3 || parts.some(part => !Number.isInteger(part) || part < 0)) {
      throw new MatrixMarketError('The MatrixMarket size line is not three whole numbers.');
    }
    size = { rows: parts[0], columns: parts[1], entries: parts[2], field: banner.field };
    onSize(size);
    return true;
  }

  /** Blocks sent to be parsed, oldest first, and the result arrays given back for the next ones. */
  const inFlight = [];
  const spareOut = [];
  /** The pieces of the block being gathered, their bytes, and how many of them hold no line end. */
  let parts = [];
  let gathered = 0;
  let lineless = 0;

  /** Send whole lines to be parsed: the pieces go as they are, their buffers given up. */
  function dispatch(block, bytes) {
    const out = spareOut.pop() ?? null;
    const args = { parts: block, pattern, rows: size.rows, columns: size.columns, values: valueType, out };
    const transfer = block.map(part => part.buffer);
    if (out !== null) transfer.push(out.rows.buffer, out.columns.buffer, out.values.buffer);
    const task = runOnDecodeWorker({
      module: ENTRIES_MODULE,
      name: 'scanEntryBlock',
      args,
      transfer,
      size: bytes,
      signal,
      inThread: () => scanEntryBlock(args),
    });
    // Awaited in order; one settling before its turn is not unhandled.
    task.catch(() => {});
    inFlight.push(task);
  }

  /** The oldest block's entries, handed on; its failure, if any, as the refusal a single pass gives. */
  async function takeOldest() {
    const result = await inFlight.shift();
    if (signal?.aborted) throw aborted();
    if (read + result.count > size.entries) {
      throw new MatrixMarketError(`The MatrixMarket file holds more than the ${formatCountOf(size.entries, 'entry', 'entries')} it declares.`);
    }
    if (result.count > 0) onEntries(result.rows, result.columns, result.values, result.count);
    read += result.count;
    const { failure } = result;
    if (failure !== null) {
      if (failure.kind === 'outside') {
        throw new MatrixMarketError(`Entry ${read + 1} (${failure.row + 1}, ${failure.column + 1}) is outside the ${size.rows} × ${size.columns} matrix.`);
      }
      if (failure.kind === 'not-whole') {
        throw new MatrixMarketError(`Entry ${read + 1} (${failure.row + 1}, ${failure.column + 1}) does not name a row and a column by whole numbers.`);
      }
      if (failure.kind === 'no-value') throw new MatrixMarketError(`Entry ${read + 1} of the MatrixMarket file has no value.`);
      throw new MatrixMarketError(failure.message);
    }
    spareOut.push({ rows: result.rows, columns: result.columns, values: result.values });
  }

  /** Blocks in flight before the oldest is waited for (a scheduling choice): two a decode worker, and one being gathered. */
  const ahead = () => 2 * (decodePoolStats().workers + 1);

  /**
   * Gather entry bytes; once a block's worth is gathered, its pieces up to
   * the last line end go to be parsed, and the rest of that line starts the
   * next block. A piece that is a view of a larger buffer is copied, so
   * every piece's buffer can be given up; the decompressor's own pieces are
   * never copied.
   */
  function append(piece) {
    if (piece.length === 0) return;
    parts.push(piece.byteOffset === 0 && piece.byteLength === piece.buffer.byteLength ? piece : piece.slice());
    gathered += piece.length;
    if (gathered < blockBytes) return;
    // Pieces before `lineless` were searched: none holds a line end (one
    // line longer than a block, which gathers on until it ends).
    for (let k = parts.length - 1; k >= lineless; k--) {
      const last = parts[k].lastIndexOf(0x0a);
      if (last < 0) continue;
      const rest = parts.slice(k + 1);
      if (last + 1 < parts[k].length) rest.unshift(parts[k].slice(last + 1));
      const block = parts.slice(0, k);
      block.push(last + 1 === parts[k].length ? parts[k] : parts[k].subarray(0, last + 1));
      let restBytes = 0;
      for (const part of rest) restBytes += part.length;
      dispatch(block, gathered - restBytes);
      parts = rest;
      gathered = restBytes;
      lineless = 0;
      return;
    }
    lineless = parts.length;
  }

  let carry = null;
  for await (const piece of pieces) {
    if (signal?.aborted) throw aborted();
    if (size !== null) {
      append(piece);
    } else {
      let bytes = piece;
      if (carry !== null) {
        bytes = new Uint8Array(carry.length + piece.length);
        bytes.set(carry);
        bytes.set(piece, carry.length);
        carry = null;
      }
      let start = 0;
      while (size === null) {
        const newline = bytes.indexOf(0x0a, start);
        if (newline < 0) break;
        let end = newline;
        if (end > start && bytes[end - 1] === 0x0d) end--;
        headerLine(bytes, start, end);
        start = newline + 1;
      }
      if (size === null) {
        carry = bytes.slice(start);
        continue;
      }
      append(bytes.subarray(start));
    }
    while (inFlight.length >= ahead()) await takeOldest();
  }
  if (size === null && carry !== null && carry.length > 0) {
    // A last header line with no line end.
    let end = carry.length;
    if (carry[end - 1] === 0x0d) end--;
    headerLine(carry, 0, end);
  }
  if (banner === null) throw new MatrixMarketError('The MatrixMarket file is empty.');
  if (size === null) throw new MatrixMarketError('The MatrixMarket file has no size line.');
  if (gathered > 0) {
    // The last lines; the very last may have no line end.
    const final = parts[parts.length - 1];
    if (final[final.length - 1] !== 0x0a) parts.push(Uint8Array.of(0x0a));
    dispatch(parts, gathered);
    parts = [];
    gathered = 0;
  }
  while (inFlight.length > 0) await takeOldest();
  if (read !== size.entries) throw new MatrixMarketError(`The MatrixMarket file declares ${formatCountOf(size.entries, 'entry', 'entries')} and holds ${read}; it is truncated.`);
  return { ...size, read };
}
