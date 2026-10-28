/**
 * Gene indexes kept in this browser across visits: the column index a
 * cell-major matrix (CSR, or dense in row chunks) needs before its first
 * gene (`sparse-column-index.js`), built over the open cells, kept in the
 * origin-private file system so a later opening of the same cells of the
 * same file reads genes at once, with nothing read but the genes.
 *
 * **What is kept, and under what.** An index is built in runs of open rows
 * (`prefix-column-index.js`: doubling segments of a subsample's cells in
 * priority order; one run of every row otherwise), and each run built is
 * kept as one directory of `transcode/space.js` (the kept-store machinery:
 * a manifest written last, a shared Web Lock while it is used, removal of
 * what nobody holds under the browser's real quota, the Session panel's
 * Clear), filed under its **group**: the file's identity (`space.js`
 * `persistsAcrossVisits`: kept for later visits only when the identity
 * names a version, a local file's modification time or a remote file's ETag
 * or revision, never its size alone; else for this tab only), the matrix
 * (`X`, `layers/counts`, …), its shape, and the order the opening takes its
 * cells in (`orderKey`: the subsample's method, seed and method settings,
 * never its size, or the file's order). The manifest records the run's
 * first open row and its length; the run keeps the file row of each of its
 * rows and their row pointers.
 *
 * **Which runs an opening uses.** An opening takes every kept run whose rows
 * are its own rows at the same open positions, as far as it has them: one
 * that runs past its last row is used over its first rows (`KeptStore`, a
 * prefix of every column's entries), and it indexes only the rows no kept
 * run covers. Openings of the same method and seed share their first rows
 * when the method's priority order is nested (uniform and blocks: a larger
 * subsample's first rows are a smaller one's rows); a stratified or
 * otherwise rebalanced subsample of another size shares only the rows its
 * two orders happen to agree on, from the first, and indexes the rest.
 *
 * **What a run is checked against before it is used** (`findKeptRuns`):
 *
 * - its manifest is whole (`space.js`: revision `KEPT_INDEX_REVISION`,
 *   identity digest, every file at its size) and well formed;
 * - its file rows equal the opening's at the same open positions;
 * - its row pointers equal the file's for those rows, read now (else the
 *   file changed: the run is removed);
 * - its column starts and per-gene checksums match their own CRC-32s, the
 *   column starts rise to its entry count;
 * - **the file's content, when its identity does not name it**
 *   (`space.js` `namesContent`: a provider's checksum, content hash, fixed
 *   release or commit names the content; a local file's name, size and
 *   modification time, a Last-Modified date, a host's or `cellucid serve`'s
 *   ETag only say when the file was last written, and a rewrite can leave
 *   them as they were). Then the run's **fingerprint** is read again: the
 *   entries (indices and values; a dense row's values) of one seeded row in
 *   each doubling band of the run's rows (`fingerprintRows`), checksummed
 *   when the run was kept. A rewrite that changes the entries of a share
 *   `f` of the run's rows leaves `k` sampled rows as they were with
 *   probability about `(1 - f)^k` (`k` is 1 + log2 of the rows used): a
 *   reordered or re-normalised file is found at once; a change to a few
 *   cells can go unnoticed. Its cost: those rows' chunks of the matrix, read
 *   at once.
 *
 * **What a gene read checks.** Each gene's stored piece of every
 * per-gene array (entry positions, rows, values) carries a CRC-32 written
 * when the run was kept, checked as the piece is read
 * (`sparse-column-index.js`, `KeptStore.checks`); a piece that does not
 * match is damage: the run is removed, the index built again (and kept
 * again), and the gene read from it, so a damaged copy is never served. A
 * CRC-32 finds every accidental change of up to 32 bits and all but one in
 * 2^32 of the others; it is no defence against a deliberate one.
 *
 * @module data/anndata/kept-column-index
 */

import { isGroup } from '../../formats/store.js';
import { PieceChecksums, checksumOf, matchesChecksum } from '../../formats/io/page-checks.js';
import { sparseContract } from './sparse.js';
import { readIntegers, readNumbers } from './values.js';
import { OPTIONAL_COPY_RANK, findKeptStores, identityDigest, makeRoomForRetry, namesContent, openTranscodeSpace } from './transcode/space.js';
import { allocateTypedArray, copyTypedArray } from '../sparse-column-index.js';

/** Element types of a kept array, by its manifest's name. */
const TYPES = Object.freeze({ f64: Float64Array, u32: Uint32Array, f32: Float32Array });

/** The layouts a kept index holds, and the arrays each has (`<name>Checks`: a CRC-32 per gene of `<name>`). */
const LAYOUT_ARRAYS = Object.freeze({
  structure: ['columnStart', 'positions', 'positionsChecks', 'rowPointers', 'fileRows'],
  sparse: ['columnStart', 'rows', 'values', 'rowsChecks', 'valuesChecks', 'rowPointers', 'fileRows'],
  dense: ['values', 'valuesChecks', 'fileRows'],
});

/** The arrays stored a gene after another, checked per gene as a gene is read. */
const PER_GENE = Object.freeze(['positions', 'rows', 'values']);

/** The arrays read whole when a run is checked, each with its own CRC-32. */
const READ_WHOLE = Object.freeze(['columnStart', 'positionsChecks', 'rowsChecks', 'valuesChecks']);

/**
 * The order an opening takes its cells in, as a group key: a subsample's
 * method, seed and method settings (not its size: openings of the same
 * method and seed at any size may share their first rows), or the file's
 * order.
 *
 * @param {Object|null} spec - The opening's subsample specification (`subsample.js`), null for every cell
 * @param {boolean} subset - Whether the opening keeps a subset of the cells
 * @returns {Object}
 */
export function orderKey(spec, subset) {
  if (!subset || spec === null || typeof spec !== 'object') return { order: 'file' };
  const { k: _k, nObs, ...settings } = spec;
  return { order: 'priority', nObs, ...settings };
}

/**
 * The group a matrix's kept runs are filed under.
 *
 * @param {{file: Object, element: string, shape: number[], order: Object}} key
 * @returns {Object}
 */
export function keptIndexGroup({ file, element, shape, order }) {
  return { columnIndex: { file, element, shape: shape.map(Number), order } };
}

/** The bytes of a typed array. */
function bytesOf(array) {
  return new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
}

/**
 * The rows of a run of `nRows` rows its fingerprint reads: one in each
 * doubling band of its rows (`[0, 1)`, `[1, 3)`, `[3, 7)`, …), at a place
 * drawn at random when it is kept, so any first `n` rows of it hold
 * `floor(log2(n + 1))` of them. Ascending.
 *
 * @param {number} nRows
 * @param {() => number} [random]
 * @returns {number[]}
 */
export function fingerprintRows(nRows, random = Math.random) {
  const rows = [];
  for (let low = 0; low < nRows; low = low * 2 + 1) {
    const high = Math.min(nRows, low * 2 + 1);
    rows.push(low + Math.min(high - low - 1, Math.floor(random() * (high - low))));
  }
  return rows;
}

/**
 * What a run's fingerprint reads of an open matrix: the CRC-32 of each of
 * open rows `rows`' entries as the file holds them now (a CSR row's column
 * indices then values, as exact numbers; a dense row's values), the rows
 * read at once.
 *
 * @param {Object} matrix - The open matrix (a subsample's view reads the file's rows)
 * @param {{format: Object, label: string, pointers: () => Promise<Float64Array|null>}} context -
 *   `pointers`: the open rows' row pointers (a CSR matrix)
 * @returns {(rows: number[]) => Promise<Uint32Array>}
 */
export function rowChecksums(matrix, { format, label, pointers }) {
  if (isGroup(matrix)) {
    const sparse = sparseContract(matrix, format, `Sparse ${label}`);
    return async rows => {
      const all = await pointers();
      return Uint32Array.from(await Promise.all(rows.map(async row => {
        const start = all[row];
        const end = all[row + 1];
        if (end === start) return 0;
        const [indices, values] = await Promise.all([
          readIntegers(sparse.indicesArray, start, end, `Sparse ${label} index`),
          readNumbers(sparse.dataArray, start, end, `Sparse ${label} data`),
        ]);
        return checksumOf(bytesOf(Float64Array.from(values, Number)), checksumOf(bytesOf(Float64Array.from(indices, Number))));
      })));
    };
  }
  const nCols = matrix.shape[1];
  return async rows => Uint32Array.from(await Promise.all(rows.map(async row => {
    const values = await matrix.read([[row, row + 1], [0, nCols]]);
    if (!ArrayBuffer.isView(values) || values.length !== nCols) throw new Error(`Dense ${label} row ${row} does not match its selection`);
    return checksumOf(bytesOf(Float64Array.from(values, Number)));
  })));
}

/** Whether two runs of file rows are the same: `null` is rows `start…` in file order. */
function sameRows(kept, opening, start) {
  for (let i = 0; i < opening.length; i++) {
    if ((kept === null ? start + i : kept[i]) !== opening[i]) return false;
  }
  return true;
}

/** Elements `[start, start + count)` of one array of a kept run. */
async function readArray(blobs, entry, start, count) {
  const Type = TYPES[entry.type];
  if (count === 0) return new Type(0);
  const reader = blobs.get(entry.region.store);
  const bytes = await reader.read(entry.region.offset + start * Type.BYTES_PER_ELEMENT, count * Type.BYTES_PER_ELEMENT);
  if (bytes.length !== count * Type.BYTES_PER_ELEMENT) throw new Error(`The kept ${entry.name} is short.`);
  if (bytes.byteOffset % Type.BYTES_PER_ELEMENT === 0) return new Type(bytes.buffer, bytes.byteOffset, count);
  const aligned = copyTypedArray(Uint8Array, bytes, `The kept ${entry.name}`);
  return new Type(aligned.buffer, aligned.byteOffset, count);
}

/** An array read whole, checked against its CRC-32; null when it does not match (damage). */
async function readChecked(blobs, arrays, name) {
  const entry = { ...arrays[name], name };
  const array = await readArray(blobs, entry, 0, entry.length);
  return matchesChecksum(bytesOf(array), entry.crc) ? array : null;
}

/** Whether a manifest is a well-formed kept run of `group`'s matrix. */
function wellFormed(manifest, nCols) {
  const { layout, start, nRows, nnz, arrays, fingerprint } = manifest;
  if (!Object.hasOwn(LAYOUT_ARRAYS, layout) || manifest.nCols !== nCols) return false;
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(nRows) || nRows < 1 || !Number.isSafeInteger(nnz) || nnz < 0) return false;
  if (arrays === null || typeof arrays !== 'object') return false;
  if (fingerprint !== null && !(Array.isArray(fingerprint) && fingerprint.every(item => Number.isSafeInteger(item?.row) && item.row >= 0 && item.row < nRows && Number.isInteger(item.crc)))) return false;
  const lengths = {
    columnStart: nCols + 1,
    rowPointers: nRows + 1,
    fileRows: manifest.rowsInFileOrder === true ? 0 : nRows,
    positions: nnz,
    rows: nnz,
    values: layout === 'dense' ? nRows * nCols : nnz,
    positionsChecks: nCols,
    rowsChecks: nCols,
    valuesChecks: nCols,
  };
  return LAYOUT_ARRAYS[layout].every(name => {
    const entry = arrays[name];
    const Type = TYPES[entry?.type];
    return Type !== undefined && entry.length === lengths[name] && entry.region?.byteLength === lengths[name] * Type.BYTES_PER_ELEMENT &&
      (!READ_WHOLE.includes(name) || Number.isInteger(entry.crc));
  });
}

/**
 * @typedef {Object} KeptRun
 * @property {number} start - Its first open row
 * @property {number} rows - The open rows it covers in this opening (it may hold more)
 * @property {import('../sparse-column-index.js').KeptStore} kept - What the index starts from
 */

/**
 * The kept runs of one matrix an opening can use, checked against its rows
 * and the file: at most one per first row (the longest), in row order;
 * every other kept run of the group is let go at once, and one that is
 * damaged or no longer the file's removed.
 *
 * @param {Object} group - `keptIndexGroup`
 * @param {Object} opening
 * @param {number} opening.nRows - Open rows of the matrix
 * @param {number} opening.nCols
 * @param {(start: number, end: number) => Uint32Array} opening.fileRows - The file row of open rows `[start, end)`
 * @param {(() => Promise<Float64Array>)|null} opening.pointers - The open rows' row pointers (a CSR
 *   matrix), read only when a kept run is checked; null for a dense matrix
 * @param {((rows: number[]) => Promise<Uint32Array>)|null} opening.rowChecksums - The file's
 *   rows now (`rowChecksums`), for a run's fingerprint
 * @param {string} opening.label
 * @param {{environment?: Object, tab?: string}} [where]
 * @returns {Promise<KeptRun[]>}
 */
export async function findKeptRuns(group, { nRows, nCols, fileRows, pointers, rowChecksums: checksums = null, label }, { environment = globalThis, tab } = {}) {
  let found;
  try {
    found = await findKeptStores(group, environment, tab === undefined ? {} : { tab });
  } catch {
    return [];
  }
  // A file its identity does not name the content of is checked against its runs' fingerprints.
  const fingerprinted = !namesContent(group);
  // The longest run at each first row is tried first.
  found.sort((a, b) => a.manifest.start - b.manifest.start || b.manifest.nRows - a.manifest.nRows);
  const letGo = candidate => (candidate.damaged === true ? candidate.discard() : candidate.release());
  // Each candidate checked against what this browser holds; the file's rows
  // its fingerprint samples are gathered, every candidate's at once.
  const prepared = [];
  for (const candidate of found) {
    const { manifest } = candidate;
    const formed = wellFormed(manifest, nCols);
    if (!formed) candidate.damaged = true;
    const usable = formed && manifest.start < nRows &&
      (pointers === null) === (manifest.layout === 'dense') && (!fingerprinted || (manifest.fingerprint !== null && checksums !== null));
    const run = usable
      ? await checkedRun(candidate, { nRows, fileRows, pointers, label }).catch(() => {
        candidate.damaged = true;
        return null;
      })
      : null;
    if (run === null) {
      // Another opening's rows (kept for it), or damaged or of another
      // version of the file (removed).
      await letGo(candidate);
      continue;
    }
    prepared.push({ candidate, run });
  }
  // The file's content: every candidate's fingerprint rows this opening uses,
  // read again in one batch (each row's entries lie in at most two chunks
  // of each array: the reads go out together, not a run after another).
  let now = null;
  if (fingerprinted && prepared.length > 0) {
    const rows = [...new Set(prepared.flatMap(({ run, candidate }) => sampledRows(candidate.manifest, run).map(item => run.start + item.row)))].sort((a, b) => a - b);
    try {
      const sums = await checksums(rows);
      now = new Map(rows.map((row, i) => [row, sums[i]]));
    } catch {
      // The file could not be read now (a dropped connection): no run is used this time, none removed.
      for (const { candidate } of prepared) await candidate.release();
      return [];
    }
  }
  const runs = [];
  for (const { candidate, run } of prepared) {
    if (now !== null && sampledRows(candidate.manifest, run).some(item => now.get(run.start + item.row) !== item.crc)) {
      candidate.damaged = true;
      await letGo(candidate);
      continue;
    }
    if (runs.some(kept => kept.start === run.start)) {
      await letGo(candidate);
      continue;
    }
    runs.push(run);
  }
  return runs;
}

/** The fingerprint rows of a kept run this opening uses (those below its open rows). */
function sampledRows(manifest, run) {
  return manifest.fingerprint.filter(item => item.row < run.rows);
}

/** One kept run checked against the opening's rows and the file, as a `KeptRun`; null when it is not this opening's. */
async function checkedRun(candidate, { nRows, fileRows, pointers, label }) {
  const { manifest, blobs } = candidate;
  const { start, layout, nCols, nnz, arrays } = manifest;
  const open = Math.min(manifest.nRows, nRows - start);
  // Its file rows: the opening's, at the same open positions.
  const keptRows = manifest.rowsInFileOrder === true ? null : await readArray(blobs, { ...arrays.fileRows, name: 'fileRows' }, 0, open);
  if (!sameRows(keptRows, fileRows(start, start + open), start)) return null;
  // From here on the run is these rows': what does not match is damage or
  // another version of the file, and the run is removed.
  const damaged = () => {
    candidate.damaged = true;
    return null;
  };
  let columnStart = null;
  let rowPointers = null;
  if (layout !== 'dense') {
    // Its row pointers: the file's for those rows (their entries are where the index says).
    const [keptPointers, all] = await Promise.all([readArray(blobs, { ...arrays.rowPointers, name: 'rowPointers' }, 0, open + 1), pointers()]);
    rowPointers = allocateTypedArray(Float64Array, open + 1, 'Row pointers');
    for (let i = 0; i <= open; i++) {
      rowPointers[i] = all[start + i] - all[start];
      if (keptPointers[i] !== rowPointers[i]) return damaged();
    }
    columnStart = await readChecked(blobs, arrays, 'columnStart');
    if (columnStart === null) return damaged();
    let rising = columnStart[0] === 0 && columnStart[nCols] === nnz;
    for (let c = 0; rising && c < nCols; c++) rising = columnStart[c] <= columnStart[c + 1];
    if (!rising || (open === manifest.nRows && rowPointers[open] !== nnz)) return damaged();
  }
  const checks = {};
  for (const name of LAYOUT_ARRAYS[layout].filter(item => item.endsWith('Checks'))) {
    const read = await readChecked(blobs, arrays, name);
    if (read === null) return damaged();
    checks[name.slice(0, -'Checks'.length)] = read;
  }
  const named = {};
  for (const name of LAYOUT_ARRAYS[layout]) {
    const entry = arrays[name];
    named[name] = {
      type: entry.type,
      read: (offset, length) => blobs.get(entry.region.store).read(entry.region.offset + offset, length),
    };
  }
  return {
    start,
    rows: open,
    kept: {
      layout,
      nRows: manifest.nRows,
      nCols,
      nnz,
      columnStart,
      rowPointers,
      arrays: named,
      checks,
      label,
      release: candidate.release,
      discard: () => { void candidate.discard(); },
    },
  };
}

/**
 * The CRC-32 of each gene's piece of one array stored a gene after another,
 * as its bytes stream past a piece at a time: gene `c` is elements
 * `[elementStart(c), elementStart(c + 1))`.
 */
function geneChecks(elementStart, nCols, bytesPerElement) {
  return new PieceChecksums(column => elementStart(column + 1) * bytesPerElement, nCols);
}

/**
 * Keep one run of a built index (`RowMajorColumnIndex` `onBuilt`): its
 * store's arrays with a CRC-32 per gene of each per-gene array, its file
 * rows and row pointers, and (for a file whose identity does not name its
 * content) its fingerprint, under `group`, a piece at a time with the
 * reader's other work between pieces. An optional copy: it makes room only
 * from other kept index runs (`space.js` `optional`), and when the browser
 * refuses a write for its quota it removes more of them and tries again,
 * while that frees anything. Resolves when it is kept (true), or when it is
 * not (false: this browser gives the reader no storage it can write, or
 * room could not be made). Never throws.
 *
 * The writer's hold on the run is let go only once `onStore` (told the run
 * is complete) resolves: the page holds it by then for its tab's life, so
 * no moment passes in which nobody holds it.
 *
 * @param {Object} group - `keptIndexGroup`
 * @param {{start: number, fileRows: Uint32Array|null, rowPointers: Float64Array|null, parts: import('../sparse-column-index.js').KeptParts}} run -
 *   `fileRows`: the file row of each of its rows (null: rows `start…` in file order)
 * @param {{file: Object, environment?: Object, tab?: string, onStore?: ((store: {directory: string, state: string}) => (void|Promise<void>))|null,
 *   fingerprint?: {rows: number[], checksums: () => Promise<Uint32Array>}|null, yieldControl?: () => Promise<void>}} where -
 *   `fingerprint`: the run's fingerprint rows (`fingerprintRows`, drawn
 *   before the pass that built it) and their CRC-32s as `rowChecksums`
 *   gives them, taken by that pass as their entries streamed by
 *   (`RowMajorColumnIndex` `fingerprintRows`): keeping reads nothing of the
 *   file again
 * @returns {Promise<boolean>}
 */
export async function keepRun(group, run, where) {
  const { environment = globalThis } = where;
  let fingerprint = null;
  if (!namesContent(group)) {
    const { rows = null, checksums = null } = where.fingerprint ?? {};
    if (typeof checksums !== 'function' || !Array.isArray(rows) || rows.length !== fingerprintRows(run.parts.nRows).length) return false;
    try {
      const sums = await checksums();
      fingerprint = rows.map((row, i) => ({ row, crc: sums[i] }));
    } catch {
      return false;
    }
  }
  for (;;) {
    const outcome = await keepOnce(group, run, where, fingerprint);
    if (outcome.kept) return true;
    // Refused for the quota: other kept index runs nobody holds make room, and it is tried again.
    if (!outcome.full || await makeRoomForRetry(environment, Math.max(1, outcome.written), { upTo: OPTIONAL_COPY_RANK }) === 0) return false;
  }
}

/** Is the error the browser's storage being full (its quota, or a refusal for it)? */
function storageFull(error) {
  return error?.name === 'QuotaExceededError' || error?.details?.reason === 'storage-full';
}

/** One attempt of `keepRun`: `{kept}`, or why not (`full`: refused for the quota, after `written` bytes). */
async function keepOnce(group, { start, fileRows, rowPointers, parts }, { file, environment = globalThis, tab, onStore = null, yieldControl = null }, fingerprint) {
  let space;
  try {
    space = await openTranscodeSpace(group, {
      environment,
      ...(tab === undefined ? {} : { tab }),
      optional: true,
      onDirectory: directory => onStore?.({ directory, state: 'writing' }),
    });
  } catch (error) {
    return { kept: false, full: storageFull(error), written: 0 };
  }
  if (space.kind !== 'opfs') {
    await space.discard();
    return { kept: false, full: false, written: 0 };
  }
  let written = 0;
  try {
    const arrays = {};
    const put = async (name, type, length, pieces, { checks = null, whole = false } = {}) => {
      let region = null;
      let crc = 0;
      for (const piece of pieces) {
        checks?.add(piece);
        if (whole) crc = checksumOf(piece, crc);
        const placed = await space.put(piece);
        written += piece.length;
        if (region === null) region = { ...placed };
        else if (placed.store !== region.store || placed.offset !== region.offset + region.byteLength) throw new Error('A kept array must be one region.');
        else region.byteLength += placed.byteLength;
        await yieldControl?.();
      }
      arrays[name] = { type, length, region: region ?? { store: 'd.bin', offset: 0, byteLength: 0 }, ...(whole ? { crc } : {}) };
    };
    const columnStart = parts.columnStart;
    const elementStart = parts.layout === 'dense' ? column => column * parts.nRows : column => columnStart[column];
    const pending = [];
    for (const array of parts.arrays) {
      const perGene = PER_GENE.includes(array.name);
      const checks = perGene ? geneChecks(elementStart, parts.nCols, TYPES[array.type].BYTES_PER_ELEMENT) : null;
      await put(array.name, array.type, array.length, array.pieces(), { checks, whole: READ_WHOLE.includes(array.name) });
      if (perGene) pending.push({ name: `${array.name}Checks`, checks: checks.finish() });
    }
    for (const { name, checks } of pending) await put(name, 'u32', checks.length, [bytesOf(checks)], { whole: true });
    if (rowPointers !== null) await put('rowPointers', 'f64', rowPointers.length, [bytesOf(rowPointers)]);
    if (fileRows !== null) await put('fileRows', 'u32', fileRows.length, [bytesOf(fileRows)]);
    else arrays.fileRows = { type: 'u32', length: 0, region: { store: 'd.bin', offset: 0, byteLength: 0 } };
    await space.finish({
      kind: 'column-index',
      // The file it indexes, by its identity's digest: the Session panel counts a file once.
      source: await identityDigest(file),
      element: group.columnIndex.element,
      start,
      layout: parts.layout,
      nRows: parts.nRows,
      nCols: parts.nCols,
      nnz: parts.nnz,
      rowsInFileOrder: fileRows === null,
      fingerprint,
      arrays,
    }, new Set(['d.bin']));
  } catch (error) {
    await space.discard();
    return { kept: false, full: storageFull(error), written };
  }
  // Handed over: whoever keeps it for the tab (the page) holds it before
  // this writer lets go; from then on whoever opens it holds it too.
  try {
    await onStore?.({ directory: space.directory, state: 'complete' });
  } finally {
    space.release();
  }
  return { kept: true };
}
