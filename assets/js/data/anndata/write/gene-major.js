/**
 * A cell-major sparse matrix (`csr_matrix`) written gene-major
 * (`csc_matrix`), as a Cellucid-ready AnnData stores every expression
 * matrix, from a source as large as its file: never more of it in memory
 * than the copy's working budget.
 *
 * 1. **Count.** One pass over the source's `indices` (and the row pointers
 *    that bound each window of rows) counts each gene's entries: the
 *    output's `indptr`.
 * 2. **Values.** The genes are cut into consecutive blocks whose entries
 *    (a value and a row each) fit the budget; for each block one pass over
 *    the source's `indices` and `data` places every entry of the block's
 *    genes at its gene's next slot. Rows are visited in order, so each
 *    gene's rows ascend, as in every Cellucid-ready `X`. Each block's values
 *    are appended to `data` as soon as the block is placed.
 * 3. **Rows.** The same passes over `indices` alone (blocks of a row each,
 *    so fewer of them) give `indices`, written after `data`: each array's
 *    chunks lie together in the archive (alternating them makes a read of
 *    one array fetch the other's chunks too).
 *    When the whole matrix fits one block, the rows of step 2 are written
 *    as they are, with no pass more.
 *
 * Each gene's count of rows below each prefix level (the priority order's
 * `varm['cellucid_prefix_counts']`, specification §2 point 4) is taken from
 * its rows as they are placed, when the copy keeps a verified priority
 * order: `n_vars × levels`, `<u4`.
 *
 * Values are copied as stored (their own dtype); `indices` is `<i4`
 * unless the cells number 2^31 or more, `indptr` `<i4` unless the entries
 * do (specification §1, "AnnData encodings"). An entry naming a gene
 * outside the matrix, or row pointers that do not ascend, refuse the source
 * as damaged.
 *
 * @module data/anndata/write/gene-major
 */

import { allocateTypedArray } from '../../sparse-column-index.js';
import { throwIfAborted } from '../../../utils/abort.js';
import { float16Bits } from '../../../formats/zarr/writer.js';
import { zarrV2Dtype } from '../../../formats/zarr/format-v2.js';
import { encodingAttributes as encoding } from './element-writer.js';
import { SLAB_BYTES } from '../values.js';
import { formatCountOf } from '../../../utils/format-units.js';

/** Positions a 32-bit signed index addresses: more cells or entries take 64-bit ones. */
const INT32_SPAN = 2 ** 31;

/** `values` as numbers: a 64-bit integer array converted, any other kept. */
function asNumbers(values, label) {
  if (!(values instanceof BigInt64Array || values instanceof BigUint64Array)) return values;
  const out = allocateTypedArray(Float64Array, values.length, label);
  for (let i = 0; i < values.length; i++) out[i] = Number(values[i]);
  return out;
}

/**
 * The row windows of a CSR matrix, in order: runs of rows whose entries
 * reach about `entries`, with their pointers (`pointers[i]` the first entry
 * of row `r0 + i`; one more at the end). Row pointers are read
 * `entries` rows at a time.
 */
async function* rowWindows(indptr, rows, entries, readOptions, label) {
  const step = Math.max(1, entries);
  let carried = null;
  for (let first = 0; first < rows; first += step) {
    const last = Math.min(rows, first + step);
    const read = asNumbers(await indptr.read([[first, last + 1]], readOptions), `${label} row pointers`);
    for (let row = first; row < last;) {
      // The rows from `row` whose entries stay within `entries` (at least one row).
      let end = row + 1;
      const base = read[row - first];
      while (end < last && read[end + 1 - first] - base <= entries) end++;
      const pointers = read.subarray(row - first, end - first + 1);
      for (let i = 1; i < pointers.length; i++) {
        if (!(pointers[i] >= pointers[i - 1])) throw new RangeError(`${label}: its row pointers do not ascend at row ${row + i - 1}.`);
      }
      if (carried !== null && pointers[0] !== carried) throw new RangeError(`${label}: its row pointers do not ascend at row ${row}.`);
      carried = pointers.at(-1);
      yield { r0: row, r1: end, pointers };
      row = end;
    }
  }
}

/**
 * Write the gene-major copy of the cell-major sparse matrix `matrix`
 * (a `csr_matrix` group) at `path`.
 *
 * @param {import('./ready-writer.js').CellucidReadyWriter} writer
 * @param {string} path
 * @param {Object} matrix - The source group (`data`, `indices`, `indptr`, attribute `shape`)
 * @param {{shape: [number, number], budgetBytes: number, slabBytes?: number, readOptions?: Object,
 *   levels?: number[]|null, window?: {start: number}|null, onValues?: (count: number) => void}} options
 *   `budgetBytes`: the memory a block may hold; `slabBytes`: the values and
 *   indices one read of the source takes; `window`: `{start}` when
 *   `matrix` is a column window of a larger one (its genes `[start, start +
 *   shape[1])`, renumbered from 0); `levels`: the prefix levels
 *   to count each gene's rows below (null: none); `onValues(n)`: `n` more
 *   source values read.
 * @returns {Promise<{prefixCounts: Uint32Array|null, passes: number}>}
 */
export async function writeGeneMajorFromRows(writer, path, matrix, { shape, budgetBytes, slabBytes = SLAB_BYTES, readOptions = {}, levels = null, window = null, onValues = () => {} }) {
  const [rows, genes] = shape;
  // A column window (`views/view-nodes.js` `columnWindowMatrix`): genes `[start, start + genes)` of the real matrix.
  const first = window?.start ?? 0;
  const data = matrix.get('data');
  const indices = matrix.get('indices');
  const indptr = matrix.get('indptr');
  const label = path;
  const signal = readOptions.signal ?? null;
  const stored = data.shape[0];
  if (indices.shape[0] !== stored || indptr.shape[0] !== rows + 1) {
    throw new RangeError(`${label}: its data, indices and row pointers do not describe a ${rows} × ${genes} matrix.`);
  }
  const dataDtype = zarrV2Dtype(data.dtype);
  if (dataDtype === null || dataDtype === '|O') throw new TypeError(`${label}: its values are not numbers.`);
  const valueBytes = data.dtype.bytes;
  // Float16 values arrive as float32 (the store's reading) and are placed as their bits.
  const asStored = dataDtype.endsWith('f2') ? read => float16Bits(read) : read => read;
  const RowArray = rows >= INT32_SPAN ? Float64Array : Int32Array;
  const rowBytes = RowArray.BYTES_PER_ELEMENT;
  /** Entries read per window: a slab of the source's values and indices. */
  const windowEntries = Math.max(1, Math.floor(slabBytes / (valueBytes + 8)));

  // 1. Each gene's entries.
  const counts = allocateTypedArray(Float64Array, genes + 1, `${label} gene counts`);
  for await (const { pointers } of rowWindows(indptr, rows, windowEntries, readOptions, label)) {
    throwIfAborted(signal);
    const p0 = pointers[0];
    const p1 = pointers.at(-1);
    if (p1 === p0) continue;
    const genesOf = asNumbers(await indices.read([[p0, p1]], readOptions), `${label} indices`);
    for (let k = 0; k < genesOf.length; k++) {
      const gene = genesOf[k] - first;
      if (window !== null) {
        if (gene >= 0 && gene < genes) counts[gene + 1]++;
        continue;
      }
      if (!(gene >= 0 && gene < genes)) throw new RangeError(`${label}: entry ${p0 + k} names gene ${gene}, outside its ${formatCountOf(genes, 'gene')}.`);
      counts[gene + 1]++;
    }
    onValues(genesOf.length);
  }
  for (let gene = 0; gene < genes; gene++) counts[gene + 1] += counts[gene];
  const colptr = counts;
  // The entries the copy holds: every stored one, or those of the window's genes.
  const entries = colptr[genes];
  if (window === null && entries !== stored) throw new RangeError(`${label}: its row pointers name ${formatCountOf(entries, 'entry', 'entries')} of ${stored}.`);

  writer.group(path, { ...encoding('csc_matrix', '0.1.0'), shape: [rows, genes] });
  const pointerType = entries >= INT32_SPAN ? BigInt64Array : Int32Array;
  const pointers = allocateTypedArray(pointerType, genes + 1, `${label} gene pointers`);
  for (let gene = 0; gene <= genes; gene++) pointers[gene] = pointerType === BigInt64Array ? BigInt(colptr[gene]) : colptr[gene];
  await writer.array(`${path}/indptr`, { values: pointers, attrs: {}, role: 'whole' });

  /** Consecutive blocks of genes whose entries take at most `bytesPerEntry × entries ≤ budget` (a gene at least). */
  const blocks = bytesPerEntry => {
    const limit = Math.max(1, Math.floor(budgetBytes / bytesPerEntry));
    const made = [];
    for (let g0 = 0; g0 < genes;) {
      let g1 = g0 + 1;
      while (g1 < genes && colptr[g1 + 1] - colptr[g0] <= limit) g1++;
      made.push([g0, g1]);
      g0 = g1;
    }
    return made;
  };
  const dataWriter = writer.stream(`${path}/data`, { shape: [entries], dtype: dataDtype, role: 'gene-entries', expression: true });
  const rowsDtype = rows >= INT32_SPAN ? '<i8' : '<i4';
  const indicesWriter = writer.stream(`${path}/indices`, { shape: [entries], dtype: rowsDtype, role: 'gene-entries' });
  const levelCount = levels?.length ?? 0;
  const prefixCounts = levelCount > 0 ? allocateTypedArray(Uint32Array, genes * levelCount, `${label} prefix counts`) : null;
  let passes = 1;

  /**
   * One pass placing the entries of genes `[g0, g1)`: their rows and, with
   * `values`, their values, each gene's in row order.
   */
  const place = async (g0, g1, withValues) => {
    const start = colptr[g0];
    const size = colptr[g1] - start;
    const placedRows = allocateTypedArray(RowArray, size, `${label} rows of genes ${g0}–${g1 - 1}`);
    const placedValues = withValues ? allocateTypedArray(valueArrayOf(dataDtype), size, `${label} values of genes ${g0}–${g1 - 1}`) : null;
    const cursor = allocateTypedArray(Float64Array, g1 - g0, `${label} cursors`);
    for (let gene = g0; gene < g1; gene++) cursor[gene - g0] = colptr[gene] - start;
    passes++;
    for await (const { r0, pointers } of rowWindows(indptr, rows, windowEntries, readOptions, label)) {
      throwIfAborted(signal);
      const p0 = pointers[0];
      const p1 = pointers.at(-1);
      if (p1 === p0) continue;
      const [genesOf, valuesOf] = await Promise.all([
        indices.read([[p0, p1]], readOptions).then(read => asNumbers(read, `${label} indices`)),
        withValues ? data.read([[p0, p1]], readOptions).then(asStored) : null,
      ]);
      for (let i = 0; i < pointers.length - 1; i++) {
        const row = r0 + i;
        for (let k = pointers[i] - p0, end = pointers[i + 1] - p0; k < end; k++) {
          const gene = genesOf[k] - first;
          if (gene < g0 || gene >= g1) continue;
          const at = cursor[gene - g0]++;
          placedRows[at] = row;
          if (withValues) placedValues[at] = valuesOf[k];
        }
      }
      onValues(genesOf.length * (withValues ? 2 : 1));
    }
    return { placedRows, placedValues, start };
  };

  /** Count each gene's rows below each level (`placedRows` hold genes `[g0, g1)` from `start`). */
  const countLevels = (g0, g1, placedRows, start) => {
    if (prefixCounts === null) return;
    for (let gene = g0; gene < g1; gene++) {
      let low = colptr[gene] - start;
      const high = colptr[gene + 1] - start;
      for (let level = 0; level < levelCount; level++) {
        // Rows ascend within a gene: the first at or past the level.
        let lo = low;
        let hi = high;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (placedRows[mid] < levels[level]) lo = mid + 1;
          else hi = mid;
        }
        prefixCounts[gene * levelCount + level] = lo - (colptr[gene] - start);
        low = lo;
      }
    }
  };

  /** Rows as the dtype `indices` is written in. */
  const rowsOut = placedRows => (rowsDtype === '<i8' ? BigInt64Array.from(placedRows, BigInt) : placedRows);

  // 2. Values, block by block.
  const valueBlocks = blocks(valueBytes + rowBytes);
  if (valueBlocks.length === 1 && genes > 0) {
    const { placedRows, placedValues, start } = await place(0, genes, true);
    await dataWriter.appendRows(placedValues);
    await dataWriter.end();
    countLevels(0, genes, placedRows, start);
    await indicesWriter.appendRows(rowsOut(placedRows));
    await indicesWriter.end();
    return { prefixCounts, passes };
  }
  for (const [g0, g1] of valueBlocks) {
    const { placedValues } = await place(g0, g1, true);
    await dataWriter.appendRows(placedValues);
  }
  await dataWriter.end();
  // 3. Rows, in larger blocks.
  for (const [g0, g1] of blocks(rowBytes)) {
    const { placedRows, start } = await place(g0, g1, false);
    countLevels(g0, g1, placedRows, start);
    await indicesWriter.appendRows(rowsOut(placedRows));
  }
  await indicesWriter.end();
  return { prefixCounts, passes };
}

/** The typed array class of a Zarr numeric dtype as the store reads it. */
function valueArrayOf(dtype) {
  const kind = dtype.slice(1);
  switch (kind) {
    case 'f8': return Float64Array;
    case 'f4': return Float32Array;
    case 'i4': return Int32Array;
    case 'u4': return Uint32Array;
    case 'i2': return Int16Array;
    case 'u2': return Uint16Array;
    case 'i1': return Int8Array;
    case 'u1': case 'b1': return Uint8Array;
    // Float16 values as their bits (`float16Bits`).
    case 'f2': return Uint16Array;
    case 'i8': return BigInt64Array;
    case 'u8': return BigUint64Array;
    default: throw new TypeError(`No typed array holds '${dtype}' values.`);
  }
}

export { valueArrayOf };
