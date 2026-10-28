/**
 * The efficiency floor of a read: the least a reader must fetch, how few
 * requests and round trips that takes, and the least time it can take,
 * computed from the file's stored layout alone (`layout.py`: where each
 * chunk lies and its stored size, read with h5py and zarr-python), never
 * from the reader being measured.
 *
 * - **Bytes**: the union of the stored (compressed) chunks that hold any
 *   element the read needs; for an unchunked (contiguous) array, or chunks
 *   stored as their values' bytes (`rawChunks`: an unfiltered HDF5 chunk, an
 *   uncompressed Zarr chunk, as a served store answers), exactly the needed
 *   elements' bytes. Metadata and chunk indexes are reported as measured
 *   beside it (`classifyReads`), not modelled.
 * - **Requests**: the runs of those bytes: chunks next to each other in one
 *   file are one request; every chunk file of a Zarr folder is its own.
 * - **Round trips**: the dependent steps (an HDF5 chunk index not read
 *   before: its B-tree levels, and the leaves holding the needed chunks'
 *   entries that no earlier step read) plus the requests' turns at the
 *   transport's concurrency.
 * - **Time**: max(bytes / bandwidth, round trips x latency), minimised over
 *   fetching the gaps between runs (a gap fetched saves a request and costs
 *   its bytes), plus decoding every needed chunk at the measured throughput
 *   of its codec in this runtime (`codecs.mjs`).
 *
 * The floor of a sequence of reads is cumulative: a chunk a step needs that
 * an earlier step needed costs nothing (an ideal reader keeps what it read).
 *
 * @module scripts/efficiency-floor/floor
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

// ------------------------------------------------------------------ layout


/** Push every item of `items` onto `target` (a spread of millions of spans overflows the stack). */
function append(target, items) {
  for (const item of items) target.push(item);
}
/** A corpus file's layout and the values its floor reads (`generate.py`). */
export function loadLayout(corpus, name) {
  const layout = JSON.parse(readFileSync(path.join(corpus, `${name}.layout.json`), 'utf8'));
  const contentDir = path.join(corpus, `${name}.content`);
  const cache = new Map();
  // The file the chunks are in, as the recorders name it: the corpus entry,
  // or a file inside a folder entry (a Cell Ranger `outs/` matrix).
  layout.name = layout.file ?? name;
  layout.content = arrayPath => {
    if (cache.has(arrayPath)) return cache.get(arrayPath);
    const record = layout.arrays[arrayPath]?.content;
    if (!record) return null;
    const bytes = readFileSync(path.join(contentDir, record.file));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const values = typedOf(record.dtype, buffer);
    cache.set(arrayPath, values);
    return values;
  };
  for (const [arrayPath, array] of Object.entries(layout.arrays)) {
    array.path = arrayPath;
    if (array.layout === 'chunked') {
      array.byGrid = new Map();
      for (const entry of array.chunkMap) {
        const grid = entry[0].map((offset, axis) => Math.floor(offset / array.chunks[axis]));
        array.byGrid.set(grid.join(','), entry);
      }
    }
  }
  return layout;
}

function typedOf(dtype, buffer) {
  switch (dtype.slice(1)) {
    case 'i4': return new Int32Array(buffer);
    case 'u4': return new Uint32Array(buffer);
    case 'i8': return Float64Array.from(new BigInt64Array(buffer), Number);
    case 'u8': return Float64Array.from(new BigUint64Array(buffer), Number);
    case 'i2': return new Int16Array(buffer);
    case 'i1': return new Int8Array(buffer);
    case 'u1': return new Uint8Array(buffer);
    case 'u2': return new Uint16Array(buffer);
    default: throw new Error(`no reader for content dtype ${dtype}`);
  }
}

/** The file a span of `array` is read from, as the recorders name it. */
function fileOfEntry(layout, entry) {
  // A chunk file of a folder from its start; an inner chunk of a shard file
  // at its place in the shard (`entry[1]`).
  if (layout.kind === 'zarr') return { file: `${layout.name}/${entry[3]}`, start: entry[1] ?? 0, end: (entry[1] ?? 0) + entry[2] };
  return { file: layout.name, start: entry[1], end: entry[1] + entry[2] };
}

/** The codec a chunk of `array` is decoded with, as `codecs.mjs` names it. */
export function codecOf(array) {
  if (array.layout !== 'chunked') return 'none';
  const names = [...(array.filters ?? []), ...(array.codecs ?? [])].join(' ').toLowerCase();
  if (names.includes('blosc')) return names.includes('zstd') ? 'blosc-zstd' : names.includes('zlib') ? 'blosc-zlib' : 'blosc-lz4';
  if (names.includes('zstd')) return 'zstd';
  if (names.includes('gzip') || names.includes('zlib')) return 'gzip';
  if (names.includes('lzf')) return 'lzf';
  return 'none';
}

/**
 * Whether a chunk of `array` is stored as its values' bytes, read in part:
 * an unfiltered HDF5 chunk, a Zarr chunk with no compressor and no filter
 * (in C order, not sharded) -- what a served store answers. A read then
 * needs only the bytes of the elements it reads, as from an array stored in
 * one piece.
 */
export function rawChunks(array) {
  if (array.layout !== 'chunked' || array.shards || /^vlen$|\|O/.test(array.dtype ?? '')) return false;
  if (array.zarrFormat === undefined) return Array.isArray(array.filters) && array.filters.length === 0;
  if ((array.order ?? 'C') !== 'C') return false;
  return (array.codecs ?? []).every(name => name === 'None' || /^BytesCodec/.test(name));
}

function itemBytes(array) {
  if (array.itemsize) return array.dtype === 'vlen' ? 16 : array.itemsize;
  const match = /(\d+)$/.exec(array.dtype ?? '');
  if (/float64|int64|uint64/.test(array.dtype)) return 8;
  if (/float32|int32|uint32/.test(array.dtype)) return 4;
  if (/int16|uint16/.test(array.dtype)) return 2;
  if (/int8|uint8|bool/.test(array.dtype)) return 1;
  return match ? Number(match[1]) / 8 : 16;
}

// ------------------------------------------------------------------- needs

/** Ascending integers as half-open runs `[start, end)`. */
export function runsOf(sorted) {
  const runs = [];
  for (const value of sorted) {
    const last = runs.at(-1);
    if (last !== undefined && last[1] === value) last[1]++;
    else runs.push([value, value + 1]);
  }
  return runs;
}

/** Merge half-open ranges (sorted by start or not). */
export function mergeRanges(ranges) {
  const sorted = ranges.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out.at(-1);
    if (last !== undefined && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/**
 * The stored spans (`{file, start, end, array, decoded, codec}`) that hold
 * the elements of `array` in `rows` (ranges along the first axis) and, for
 * a two-dimensional array, `columns` (one range; every column if null).
 */
export function spansOf(layout, arrayPath, rows, columns = null) {
  const array = layout.arrays[arrayPath];
  if (array === undefined) throw new Error(`${layout.name} has no array ${arrayPath}`);
  const spans = [];
  if (rows.length === 0) return spans;
  const shape = array.shape;
  const width = shape.length > 1 ? shape.slice(1).reduce((a, b) => a * b, 1) : 1;
  const cols = shape.length > 1 ? (columns ?? [0, shape[1]]) : null;
  if (array.layout === 'compact') return spans;
  if (array.layout === 'contiguous') {
    if (array.extent[0] === null) return spans;
    const item = itemBytes(array);
    const rowBytes = width * item;
    const pieces = [];
    for (const [r0, r1] of rows) {
      if (cols === null || (cols[0] === 0 && cols[1] === shape[1])) pieces.push([r0 * rowBytes, r1 * rowBytes]);
      else for (let r = r0; r < r1; r++) pieces.push([r * rowBytes + cols[0] * item, r * rowBytes + cols[1] * item]);
    }
    for (const [s, e] of mergeRanges(pieces)) {
      spans.push({ file: layout.name, start: array.extent[0] + s, end: array.extent[0] + e, array: arrayPath, decoded: e - s, codec: 'none' });
    }
    return spans;
  }
  // An HDF5 string column's strings are global heap objects, read after
  // their references: their bytes, at the column's mean, are the floor's too.
  const heapBytes = array.heapBytesPerElement > 0 ? rows.reduce((sum, [r0, r1]) => sum + (r1 - r0), 0) * array.heapBytesPerElement : 0;
  const chunk = array.chunks;
  const rowChunks = new Set();
  for (const [r0, r1] of rows) {
    for (let c = Math.floor(r0 / chunk[0]); c <= Math.floor((r1 - 1) / chunk[0]); c++) rowChunks.add(c);
  }
  const colChunks = [];
  if (cols !== null) for (let c = Math.floor(cols[0] / chunk[1]); c <= Math.floor((cols[1] - 1) / chunk[1]); c++) colChunks.push(c);
  const decodedPerChunk = chunk.reduce((a, b) => a * b, 1) * itemBytes(array);
  const codec = codecOf(array);
  const raw = rawChunks(array);
  for (const r of [...rowChunks].sort((a, b) => a - b)) {
    const grids = cols === null ? [[r]] : colChunks.map(c => [r, c, ...Array(Math.max(0, shape.length - 2)).fill(0)]);
    for (const grid of grids) {
      const entry = array.byGrid.get(grid.join(','));
      if (entry === undefined) continue; // never written: the fill value, no bytes
      const linear = grid.reduce((at, g, axis) => at * Math.ceil(shape[axis] / chunk[axis]) + g, 0);
      const where = fileOfEntry(layout, entry);
      if (!raw) {
        spans.push({ ...where, array: arrayPath, decoded: decodedPerChunk, codec, linear, ...(array.shards ? { shard: entry[3] } : {}) });
        continue;
      }
      // A chunk read in part: the bytes of its elements the read needs, a
      // piece per row when it needs some of a row's columns (C order).
      for (const piece of rawPieces(array, grid, rows, cols)) {
        spans.push({ file: where.file, start: where.start + piece[0], end: where.start + piece[1], array: arrayPath, decoded: piece[1] - piece[0], codec, linear });
      }
    }
  }
  if (heapBytes > 0 && spans.length > 0) spans[0].heapBytes = Math.round(heapBytes);
  return spans;
}

/**
 * Byte ranges inside chunk `grid` of a raw-chunked `array` (`rawChunks`)
 * holding rows `rows` and, for a two-dimensional array, columns `cols`: the
 * chunk's elements in C order, as its full chunk shape stores them.
 */
function rawPieces(array, grid, rows, cols) {
  const chunk = array.chunks;
  const item = itemBytes(array);
  const rowElements = chunk.slice(1).reduce((a, b) => a * b, 1);
  const first = grid[0] * chunk[0];
  const last = first + chunk[0];
  let c0 = 0;
  let c1 = rowElements;
  if (cols !== null && chunk.length === 2) {
    c0 = Math.max(cols[0], grid[1] * chunk[1]) - grid[1] * chunk[1];
    c1 = Math.min(cols[1], (grid[1] + 1) * chunk[1]) - grid[1] * chunk[1];
  }
  const whole = c0 === 0 && c1 === rowElements;
  const pieces = [];
  for (const [r0, r1] of rows) {
    const from = Math.max(r0, first);
    const to = Math.min(r1, last);
    if (to <= from) continue;
    if (whole) {
      pieces.push([(from - first) * rowElements * item, (to - first) * rowElements * item]);
      continue;
    }
    for (let row = from; row < to; row++) pieces.push([((row - first) * rowElements + c0) * item, ((row - first) * rowElements + c1) * item]);
  }
  return mergeRanges(pieces);
}

/** Ranges of positions `p` in `[0, n)` for which `keep(p)` holds, from ascending candidate ranges. */
function filterRanges(ranges, keep) {
  const out = [];
  for (const [s, e] of ranges) {
    for (let p = s; p < e; p++) {
      if (!keep(p)) continue;
      const last = out.at(-1);
      if (last !== undefined && last[1] === p) last[1]++;
      else out.push([p, p + 1]);
    }
  }
  return out;
}

/** Entry ranges of the rows `rows` of a compressed sparse group (`indptr`). */
function entryRanges(indptr, rows) {
  return mergeRanges(rows.map(([r0, r1]) => [indptr[r0], indptr[r1]]));
}

/** Pointer element ranges a read of `rows` needs: `indptr[r0 .. r1]`. */
function pointerRanges(rows) {
  return mergeRanges(rows.map(([r0, r1]) => [r0, r1 + 1]));
}

/**
 * The spans a read of genes `genes` of the matrix at `group` needs, for the
 * kept file rows `rows` (ranges). `prefix` (a priority file opened at its
 * own prefix of `k` rows): the gene-major entries below row `k` are the
 * kept ones.
 */
export function geneSpans(layout, group, genes, rows, { nRows, prefix = null } = {}) {
  const array = layout.arrays[group] ?? null;
  // Dense: the rows by the genes' columns.
  if (array !== null) {
    return genes.flatMap(g => spansOf(layout, group, rows, [g, g + 1]));
  }
  const indptr = layout.content(`${group}/indptr`);
  const indices = layout.content(`${group}/indices`);
  const pointerLength = layout.arrays[`${group}/indptr`].shape[0];
  const cellMajor = pointerLength === nRows + 1;
  const spans = [];
  if (cellMajor) {
    // Every kept row's entries must be scanned for the genes; values only where they match.
    const entries = entryRanges(indptr, rows);
    const wanted = new Set(genes);
    append(spans, spansOf(layout, `${group}/indptr`, pointerRanges(rows)));
    append(spans, spansOf(layout, `${group}/indices`, entries));
    append(spans, spansOf(layout, `${group}/data`, filterRanges(entries, p => wanted.has(indices[p]))));
    return spans;
  }
  // Gene-major: each gene's entries; the kept ones' values.
  const kept = rowMembership(rows, nRows);
  for (const g of genes) {
    append(spans, spansOf(layout, `${group}/indptr`, [[g, g + 2]]));
    const start = indptr[g];
    let end = indptr[g + 1];
    if (prefix !== null) {
      // Entries ascend by row: the kept ones are the gene's first.
      let lo = start;
      let hi = end;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (indices[mid] < prefix) lo = mid + 1;
        else hi = mid;
      }
      end = lo;
      append(spans, spansOf(layout, `${group}/indices`, [[start, end]]));
      append(spans, spansOf(layout, `${group}/data`, [[start, end]]));
      continue;
    }
    const keptEntries = filterRanges([[start, end]], p => kept[indices[p]] === 1);
    // An ideal reader knows which index chunks hold kept rows (the bound a
    // search over index chunks can reach); `geneSpansScan` is the floor of
    // a reader that reads the gene's whole index.
    append(spans, spansOf(layout, `${group}/indices`, keptEntries));
    append(spans, spansOf(layout, `${group}/data`, keptEntries));
  }
  return spans;
}

/** A gene-major gene read that scans its whole index (no search): every index chunk of the gene. */
export function geneSpansScan(layout, group, genes, rows, { nRows } = {}) {
  const indptr = layout.content(`${group}/indptr`);
  const indices = layout.content(`${group}/indices`);
  const kept = rowMembership(rows, nRows);
  const spans = [];
  for (const g of genes) {
    append(spans, spansOf(layout, `${group}/indptr`, [[g, g + 2]]));
    append(spans, spansOf(layout, `${group}/indices`, [[indptr[g], indptr[g + 1]]]));
    append(spans, spansOf(layout, `${group}/data`, filterRanges([[indptr[g], indptr[g + 1]]], p => kept[indices[p]] === 1)));
  }
  return spans;
}

function rowMembership(rows, nRows) {
  const kept = new Uint8Array(nRows);
  for (const [r0, r1] of rows) kept.fill(1, r0, r1);
  return kept;
}

/** The kept rows' rows of a graph and its entries between kept cells (`readInducedGraph`). */
export function graphSpans(layout, group, rows, { nRows, allValues = false }) {
  const indptr = layout.content(`${group}/indptr`);
  const indices = layout.content(`${group}/indices`);
  const kept = rowMembership(rows, nRows);
  const entries = entryRanges(indptr, rows);
  return [
    ...spansOf(layout, `${group}/indptr`, pointerRanges(rows)),
    ...spansOf(layout, `${group}/indices`, entries),
    // The kept edges' values are known only once the indices are read: one
    // dependent round trip more than reading every kept row's values with them.
    ...spansOf(layout, `${group}/data`, allValues ? entries : filterRanges(entries, p => kept[indices[p]] === 1))
      .map(span => (allValues ? span : { ...span, afterIndices: true })),
  ];
}

/**
 * Every gene of rows `rows` (an analysis reading its cells' every gene).
 * `prefix` (a priority file opened at its own prefix of `k` rows): a
 * gene-major gene's entries of those rows are its first, below the last
 * row asked for.
 */
export function rowSpans(layout, group, rows, { nRows, prefix = null }) {
  const array = layout.arrays[group] ?? null;
  if (array !== null) return spansOf(layout, group, rows);
  const indptr = layout.content(`${group}/indptr`);
  const indices = layout.content(`${group}/indices`);
  const pointerLength = layout.arrays[`${group}/indptr`].shape[0];
  if (pointerLength === nRows + 1) {
    const entries = entryRanges(indptr, rows);
    return [...spansOf(layout, `${group}/indptr`, pointerRanges(rows)), ...spansOf(layout, `${group}/indices`, entries), ...spansOf(layout, `${group}/data`, entries)];
  }
  if (prefix !== null && rows.length > 0) {
    // Entries ascend by row within a gene: the rows' are among its first.
    const below = rows.at(-1)[1];
    const ranges = [];
    for (let g = 0; g + 1 < pointerLength; g++) {
      let lo = indptr[g];
      let hi = indptr[g + 1];
      const start = lo;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (indices[mid] < below) lo = mid + 1;
        else hi = mid;
      }
      if (lo > start) ranges.push([start, lo]);
    }
    return [...spansOf(layout, `${group}/indptr`, [[0, pointerLength]]), ...spansOf(layout, `${group}/indices`, ranges), ...spansOf(layout, `${group}/data`, ranges)];
  }
  // Gene-major: every gene's index, the values of the rows' entries.
  const kept = rowMembership(rows, nRows);
  const all = [[0, indices.length]];
  return [
    ...spansOf(layout, `${group}/indptr`, [[0, pointerLength]]),
    ...spansOf(layout, `${group}/indices`, all),
    ...spansOf(layout, `${group}/data`, filterRanges(all, p => kept[indices[p]] === 1)),
  ];
}

// -------------------------------------------------------------------- floor

/**
 * The floor of one step: `spans` it needs, less what `have` (a Set of
 * span keys, updated) holds already.
 *
 * @param {Array} spans
 * @param {{have: Set<string>, indexKnown: Set<string>, layout: Object,
 *   latencyMs: number, bytesPerMs: number, concurrency: number,
 *   decodeBytesPerMs: Object<string, number>}} context
 */
export function floorOf(spans, context) {
  const { have, indexKnown, layout } = context;
  const unique = new Map();
  for (const span of spans) {
    const key = `${span.file}:${span.start}:${span.end}`;
    if (have.has(key) || unique.has(key)) continue;
    unique.set(key, span);
  }
  let indexLevels = 0;
  // A sparse matrix's entries are found through its pointers: read in the
  // same step, they are one dependent round trip before the entries.
  const pointerGroups = new Set();
  for (const span of unique.values()) if (span.array.endsWith('/indptr')) pointerGroups.add(span.array.slice(0, -'/indptr'.length));
  for (const span of unique.values()) {
    const group = span.array.replace(/\/(indices|data)$/, '');
    if (group !== span.array && pointerGroups.has(group)) indexLevels = Math.max(indexLevels, 1);
  }
  let chunkIndexLevels = 0;
  // An HDF5 chunk index: its upper levels, read at an array's first read
  // (one dependent round trip each), and the leaves (2K = 64 chunks each,
  // h5py's default) that address the needed chunks, each read once in a
  // session, the first time a step needs one of its chunks: one dependent
  // round trip before those chunks, however many (where they lie is not in
  // the layout; a reader may fetch them together). A leaf a later step needs
  // costs that step, as a chunk does: the leaves of an array are not all
  // known after its first read.
  const leaves = new Map();
  let newLeaves = false;
  for (const span of unique.values()) {
    have.add(`${span.file}:${span.start}:${span.end}`);
    const array = layout.arrays[span.array];
    // An HDF5 string is a reference into a global heap: its object is read
    // after the reference, one dependent round trip more (its bytes are not
    // in any chunk: counted as metadata).
    if (layout.kind === 'hdf5' && array.dtype === 'vlen') indexLevels = Math.max(indexLevels, 1);
    if (layout.kind === 'hdf5' && array.layout === 'chunked') {
      // An index of one node (64 chunks or fewer) is one round trip before
      // the chunks, at the array's first read.
      const levels = Math.max(1, Math.ceil(Math.log(Math.max(2, array.chunkMap.length)) / Math.log(64)));
      if (!indexKnown.has(span.array)) chunkIndexLevels = Math.max(chunkIndexLevels, array.chunkMap.length > 64 ? levels - 1 : 1);
      if (array.chunkMap.length > 64) {
        const leaf = `${span.array}#${Math.floor(span.linear / 64)}`;
        if (!indexKnown.has(leaf)) {
          if (!leaves.has(span.array)) leaves.set(span.array, new Set());
          leaves.get(span.array).add(leaf);
          newLeaves = true;
        }
      }
    }
  }
  // A sharded Zarr v3 array's inner chunks are found through their shard's
  // index: a dependent round trip the first time a step needs a shard.
  for (const span of unique.values()) {
    const array = layout.arrays[span.array];
    if (span.shard === undefined) continue;
    const shard = `${span.shard}#index`;
    if (!indexKnown.has(shard)) {
      chunkIndexLevels = Math.max(chunkIndexLevels, 1);
      indexKnown.add(shard);
    }
  }
  for (const span of unique.values()) if (layout.kind === 'hdf5' && layout.arrays[span.array].layout === 'chunked') indexKnown.add(span.array);
  for (const set of leaves.values()) for (const leaf of set) indexKnown.add(leaf);
  indexLevels += chunkIndexLevels;
  const leafRequests = newLeaves ? [...leaves.values()].reduce((sum, set) => sum + set.size, 0) : 0;
  if ([...unique.values()].some(span => span.afterIndices)) indexLevels += 1;
  const byFile = new Map();
  for (const span of unique.values()) {
    if (!byFile.has(span.file)) byFile.set(span.file, []);
    byFile.get(span.file).push([span.start, span.end]);
  }
  const runs = [];
  const gaps = [];
  for (const ranges of byFile.values()) {
    const merged = mergeRanges(ranges);
    for (let i = 0; i < merged.length; i++) {
      runs.push(merged[i]);
      if (i > 0) gaps.push(merged[i][0] - merged[i - 1][1]);
    }
  }
  let bytes = 0;
  let decodeMs = 0;
  let heapBytes = 0;
  for (const span of unique.values()) {
    bytes += span.end - span.start;
    heapBytes += span.heapBytes ?? 0;
    const rate = context.decodeBytesPerMs[span.codec] ?? null;
    if (rate !== null && span.codec !== 'none') decodeMs += span.decoded / rate;
  }
  // The heap's bytes come in their own requests (one per collection: counted
  // with the run requests as one more), after the references.
  if (heapBytes > 0) runs.push([0, 0]);
  bytes += heapBytes;
  // Fetching the smallest gaps first: the quickest plan.
  const { latencyMs, bytesPerMs, concurrency } = context;
  // The leaves are read before the chunks they address: a round trip.
  const leafTurns = leafRequests === 0 ? 0 : 1;
  const timeOf = (requests, b) => Math.max(b / bytesPerMs, (indexLevels + leafTurns + Math.ceil(requests / concurrency)) * latencyMs);
  let best = runs.length === 0 ? 0 : timeOf(runs.length, bytes);
  let plan = { requests: runs.length, bytes };
  let requests = runs.length;
  let fetched = bytes;
  for (const gap of gaps.sort((a, b) => a - b)) {
    requests--;
    fetched += gap;
    const time = timeOf(requests, fetched);
    if (time < best) {
      best = time;
      plan = { requests, bytes: fetched };
    }
  }
  return {
    bytes,
    requests: runs.length,
    // The quickest plan's bytes and requests: the gaps it fetches cost less
    // than the requests they save (contiguous arrays read by column, many
    // small runs over a slow round trip).
    plan,
    roundTrips: runs.length === 0 ? 0 : indexLevels + leafTurns + Math.ceil(plan.requests / concurrency),
    leafRequests,
    transferMs: best,
    decodeMs,
    ms: best + decodeMs,
    spans: [...unique.values()],
  };
}

// --------------------------------------------------------------- the reads

/**
 * What the reads of a step fetched, against what it needed: bytes inside
 * needed spans; bytes of other chunks (by array: the overfetch and whose it
 * is); bytes in no chunk (metadata: headers, chunk indexes, heaps, Zarr
 * metadata documents).
 */
export function classifyReads(reads, needed, layout) {
  const chunkIndex = chunkIndexOf(layout);
  const neededByFile = new Map();
  for (const span of needed) {
    if (!neededByFile.has(span.file)) neededByFile.set(span.file, []);
    neededByFile.get(span.file).push([span.start, span.end]);
  }
  for (const [file, ranges] of neededByFile) neededByFile.set(file, mergeRanges(ranges));
  let useful = 0;
  let metadata = 0;
  let wasted = 0;
  const overfetch = {};
  for (const read of reads) {
    if (read.bytes === 0) continue;
    const ranges = neededByFile.get(read.file) ?? [];
    useful += overlap(ranges, read.start, read.end);
    let inChunks = 0;
    for (const chunk of overlapping(chunkIndex.get(read.file) ?? [], read.start, read.end)) {
      const start = Math.max(read.start, chunk.start);
      const end = Math.min(read.end, chunk.end);
      inChunks += end - start;
      const extra = end - start - overlap(ranges, start, end);
      if (extra > 0) {
        overfetch[chunk.array] = (overfetch[chunk.array] ?? 0) + extra;
        wasted += extra;
      }
    }
    metadata += read.bytes - inChunks;
  }
  return { useful, metadata, wasted, overfetch };
}

function chunkIndexOf(layout) {
  if (layout.chunkIndex) return layout.chunkIndex;
  const index = new Map();
  for (const array of Object.values(layout.arrays)) {
    const entries = array.layout === 'chunked' ? array.chunkMap : array.layout === 'contiguous' && array.extent[0] !== null ? [[null, array.extent[0], array.extent[1]]] : [];
    for (const entry of entries) {
      const where = array.layout === 'chunked' ? fileOfEntry(layout, entry) : { file: layout.name, start: entry[1], end: entry[1] + entry[2] };
      if (!index.has(where.file)) index.set(where.file, []);
      index.get(where.file).push({ ...where, array: array.path });
    }
  }
  for (const list of index.values()) list.sort((a, b) => a.start - b.start);
  layout.chunkIndex = index;
  return index;
}

function overlap(ranges, start, end) {
  let total = 0;
  let lo = 0;
  let hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ranges[mid][1] <= start) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < ranges.length; i++) {
    const [s, e] = ranges[i];
    if (e <= start) continue;
    if (s >= end) break;
    total += Math.min(e, end) - Math.max(s, start);
  }
  return total;
}

function* overlapping(chunks, start, end) {
  let lo = 0;
  let hi = chunks.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (chunks[mid].end <= start) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < chunks.length && chunks[i].start < end; i++) {
    if (chunks[i].end > start) yield chunks[i];
  }
}
