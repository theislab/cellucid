/**
 * Every typed array the readers make goes through `allocateTypedArray`.
 *
 * Every engine caps one `ArrayBuffer` (Chromium at 2,145,386,496 bytes,
 * WebKit at 2^32, Firefox at 2^34; `utils/large-arrays.js`). An array sized
 * by the dataset -- a cell, row, entry, edge, gene or category count, or a
 * read of any of them -- made with `new Float32Array(n)` stops the dataset
 * at that cap: 50 float64 principal components stop a Seurat object at 5.4
 * million cells on Chromium. `allocateTypedArray`
 * (`data/sparse-column-index.js`) makes the array in a WebAssembly memory
 * when the engine refuses an `ArrayBuffer`, and names a refusal of both
 * with its bytes and what it was for (`TOO_LARGE`, and to the memory
 * budgets).
 *
 * So, in `assets/js/data`, `assets/js/formats` and `assets/js/workers`, a
 * typed array made with `new` from one argument must be bounded by the
 * source itself: a number, an upper-case constant, `Math.min` of one, an
 * array literal, or a view (`x.buffer`, an awaited `ArrayBuffer`). Every
 * other one is listed below with what bounds it other than the dataset, and
 * an entry that names no allocation any more fails, so the list never
 * outlives the code. A view over a buffer with an offset and a length (two
 * or more arguments) allocates nothing and is not looked at.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../assets/js/', import.meta.url));
const SCANNED = ['data', 'formats', 'workers'];

const TYPED = 'Int8|Uint8|Uint8Clamped|Int16|Uint16|Int32|Uint32|Float32|Float64|BigInt64|BigUint64';
/**
 * `new` of a typed array: by name, or by a constructor held in a variable
 * (`values.constructor`, `type.valueClass`, a `Type`/`ArrayType`/`Output`/
 * `Values`/`TypedArrayClass` parameter).
 */
const ALLOCATION = new RegExp(
  String.raw`\bnew\s+((?:${TYPED})Array|(?:[A-Za-z_$][\w$]*\.)+(?:constructor|valueClass)|Type|ArrayType|OutputType|Output|Values|TypedArrayClass)\s*\(`,
  'g'
);

/** An expression of numbers and upper-case constants only. */
const CONSTANT = /^(?:\s|0[xX][\da-fA-F_]+|\d[\d_.]*|[+\-*/%<>()]|\b[A-Z][A-Z0-9_]*\b|\.BYTES_PER_ELEMENT)*$/;

/**
 * Allocations bounded by something other than the dataset, by file (under
 * `assets/js/`) and the allocation as written (whitespace collapsed).
 */
const ALLOWED = [
  {
    file: 'data/anndata/subset-entries.js',
    allocations: ['new Int32Array(entries)', 'new Float32Array(entries)', 'new Float64Array(genes)'],
    reason: 'The decode-worker kernel, which depends on nothing: one run of genes, at most `inFlightEntries` entries ' +
      '(matrix-access.js `subsetByColumns`) or one gene, transferred whole to and from the worker.',
  },
  {
    file: 'data/anndata/transcode/zarr-writer.js',
    allocations: ['new Uint8Array(total)', 'new Uint8Array(size)'],
    reason: 'One chunk the converter writes (`CHUNK_BYTES`, 4 MiB), or its vlen-utf8 strings.',
  },
  {
    file: 'data/base-anndata-adapter.js',
    allocations: ['new TypedArrayClass(fieldData.data)'],
    reason: 'A view of the ArrayBuffer a field payload carries: nothing is allocated.',
  },
  {
    file: 'data/data-loaders.js',
    allocations: ['new Float32Array(data.data)', 'new TypedArrayClass(data.data)'],
    reason: 'Views of the ArrayBuffer a field payload carries (checked to be one): nothing is allocated.',
  },
  {
    file: 'data/data-source.js',
    allocations: ['new Uint8Array(byteLength)', 'new Uint8Array(value)'],
    reason: 'A JSON document read whole (`readBoundedBody`), parsed as one string: the engine\'s longest string ' +
      '(2^29 to 2^30 units) bounds it far below one ArrayBuffer; and a view of one stream piece.',
  },
  {
    file: 'data/sources/auth/pkce.js',
    allocations: ['new Uint8Array(bytes)', 'new Uint8Array(digest)'],
    reason: 'A PKCE verifier\'s random bytes and a SHA-256 digest: tens of bytes.',
  },
  {
    file: 'data/viewer-protocol.js',
    allocations: ['new Uint8Array(frame)'],
    reason: 'A view of a received binary frame (an ArrayBuffer): nothing is allocated.',
  },
  {
    file: 'formats/hdf5/heaps.js',
    allocations: ['new Int32Array(maxIndex + 1)'],
    reason: 'Object indexes of one global heap collection are 16-bit: at most 65,536 entries.',
  },
  {
    file: 'formats/hdf5/nodes.js',
    allocations: ['new Uint8Array(type.size)'],
    reason: 'One element\'s fill value.',
  },
  {
    file: 'formats/hdf5/read-plan.js',
    allocations: ['new Uint8Array(needed)'],
    reason: 'A compact dataset, which the HDF5 format keeps in its object header: at most 64 KiB.',
  },
  {
    file: 'formats/hdf5/writer.js',
    allocations: [
      'new Uint8Array(capacity)', 'new Uint8Array(block.length + 4)', 'new Uint8Array(nodeBytes)',
      'new Uint8Array(ATTRIBUTE_HEAP.idLength)',
    ],
    reason: 'The writer\'s metadata (object headers, heaps, B-tree nodes); dataset bytes are parts of their own.',
  },
  {
    file: 'formats/io/byte-source.js',
    allocations: ['new Uint8Array(buffer)', 'new Uint8Array(total)'],
    reason: 'A view of one file read, and one HTTP response: a request of at most the link\'s `maxRequestBytes` ' +
      '(byte-reader.js splits every read). In the closure `allocateTypedArray` imports.',
  },
  {
    file: 'formats/io/page-checks.js',
    allocations: ['new Uint8Array(sums.length * 4)', 'new Uint32Array(bytes.length / 4)'],
    reason: 'One CRC-32 per 16 KiB page (`CHECK_PAGE_BYTES`): one ArrayBuffer of them covers 8 TiB. ' +
      'In the closure `allocateTypedArray` imports.',
  },
  {
    file: 'formats/io/decode-pool.js',
    allocations: ['new Uint8Array(total)'],
    reason: 'A batch of small chunks for one decode worker message.',
  },
  {
    file: 'formats/io/inflate.js',
    allocations: ['new Uint8Array(total)', 'new Uint8Array(expectedSize)'],
    reason: 'One compressed chunk or zip entry, decoded (the decode worker\'s codecs).',
  },
  {
    file: 'formats/io/shuffle.js',
    allocations: ['new Uint8Array(input.length)'],
    reason: 'One chunk, unshuffled (a decode worker codec).',
  },
  {
    file: 'formats/hdf5/lzf.js',
    allocations: ['new Uint8Array(outputSize)'],
    reason: 'One chunk, decoded (a decode worker codec).',
  },
  {
    file: 'formats/zarr/codecs/blosc.js',
    allocations: ['new Uint8Array(count * typesize)', 'new Uint8Array(nbytes)', 'new Uint8Array(blocksize)'],
    reason: 'One chunk and its blocks, decoded (a decode worker codec; Blosc 1 frames hold under 2^31 bytes).',
  },
  {
    file: 'formats/zarr/codecs/lz4.js',
    allocations: ['new Uint8Array(size)'],
    reason: 'One chunk, decoded (a decode worker codec).',
  },
  {
    file: 'formats/zarr/codecs/zstd.js',
    allocations: [
      'new Uint8Array(size)', 'new Uint16Array(size)', 'new Uint16Array(symbolCount)', 'new Int16Array(maxSymbol + 1)',
      'new Uint32Array(maxBits + 2)', 'new Int32Array(size)', 'new Uint8Array(this.fixed ? expectedSize : 64 * 1024)',
      'new Uint8Array(Math.max(needed, this.bytes.length * 2))', 'new Output(expectedSize)',
    ],
    reason: 'Decoding tables of at most a few thousand symbols, and one chunk\'s frame, decoded (a decode worker codec).',
  },
  {
    file: 'formats/zarr/chunks.js',
    allocations: ['new Float32Array(count)'],
    reason: 'One chunk\'s float16 values as float32.',
  },
  {
    file: 'formats/zarr/dtypes.js',
    allocations: [
      'new Uint8Array(type.itemSize)', 'new type.valueClass(count)', 'new Uint8Array(count * fieldSize)',
      'new field.type.valueClass(count * perElement)', 'new Uint8Array(binary.length)',
    ],
    reason: 'One element (a fill value, base64 of one element), and a structured (record) dtype\'s fields: AnnData ' +
      'writes records only in `uns` tables (rank_genes_groups: genes by groups), never per cell.',
  },
  {
    file: 'formats/zarr/stores/mapped.js',
    allocations: ['new Uint8Array(end - start)'],
    reason: 'One entry of a mapped store (a chunk file) padded to its range.',
  },
  {
    file: 'formats/rds/bzip2.js',
    allocations: [
      'new Uint8Array(rest + piece.length)', 'new Int32Array(alphaSize)', 'new Uint8Array(alphaSize)',
      'new Uint8Array(count)', 'new Uint8Array(total)', 'new Uint32Array(blockSize)',
    ],
    reason: 'One bzip2 block (at most 900,000 bytes before its run-length step) and its Huffman tables, and the unread ' +
      'rest of one stream piece.',
  },
  {
    file: 'formats/rds/xz.js',
    allocations: ['new Uint8Array(rest + value.length)', 'new Uint8Array(dictionarySize)', 'new Uint16Array(size)'],
    reason: 'The LZMA2 dictionary the file\'s header names (the writer\'s; 1.5 GiB at most for xz), literal coder ' +
      'probabilities, and the unread rest of one stream piece.',
  },
  {
    file: 'formats/text/lines.js',
    allocations: ['new Uint8Array(carry.length + piece.length)', 'new Uint8Array(carry.length + newline)'],
    reason: 'One line of a text table across two pieces.',
  },
  {
    file: 'formats/text/matrix-market.js',
    allocations: ['new Uint8Array(carry.length + piece.length)'],
    reason: 'One piece of a MatrixMarket file and the partial line before it.',
  },
  {
    file: 'formats/text/matrix-market-entries.js',
    allocations: ['new Uint8Array(end)', 'new Int32Array(capacity)', 'new Values(capacity)'],
    reason: 'The entries of one block of whole lines (the worker kernel, which depends on nothing).',
  },
];

async function sources(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'vendor') out.push(...await sources(full));
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

/** The source with comments blanked out, offsets kept. */
function withoutComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, block => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (line, before) => before + ' '.repeat(line.length - before.length));
}

/** The arguments of the call whose `(` is at `open`, split at top-level commas, and where it ends. */
function callArguments(text, open) {
  let depth = 0;
  let start = open + 1;
  const parts = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        parts.push(text.slice(start, i));
        return { parts: parts.map(part => part.trim()).filter(part => part !== ''), end: i + 1 };
      }
    } else if (c === ',' && depth === 1) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  return null;
}

/** Whether one argument bounds the array by itself (or makes it a view). */
function boundedBySource(argument) {
  if (argument.startsWith('[')) return true;
  if (/\.buffer$/.test(argument) || /^await\s/.test(argument)) return true;
  if (CONSTANT.test(argument)) return true;
  const min = /^Math\.min\(([\s\S]*)\)$/.exec(argument);
  return min !== null && min[1].split(',').some(part => CONSTANT.test(part.trim()));
}

/** Each one-argument allocation of `text` not bounded by the source: `{line, allocation}`. */
function unboundedAllocations(text) {
  const source = withoutComments(text);
  const found = [];
  for (const match of source.matchAll(ALLOCATION)) {
    const call = callArguments(source, match.index + match[0].length - 1);
    if (call === null || call.parts.length !== 1 || boundedBySource(call.parts[0])) continue;
    found.push({
      line: source.slice(0, match.index).split('\n').length,
      allocation: source.slice(match.index, call.end).replace(/\s+/g, ' '),
    });
  }
  return found;
}

test('the scan tells an allocation sized by the dataset from one bounded by the source', () => {
  const flagged = text => unboundedAllocations(text).map(site => site.allocation);
  assert.deepEqual(flagged('const a = new Float32Array(nObs);'), ['new Float32Array(nObs)']);
  assert.deepEqual(flagged('const a = new values.constructor(n * width).fill(NaN);'), ['new values.constructor(n * width)']);
  assert.deepEqual(flagged('const a = new type.valueClass(count);'), ['new type.valueClass(count)']);
  assert.deepEqual(flagged('const a = new Float64Array(\n  nObs * columns\n);'), ['new Float64Array( nObs * columns )']);
  assert.deepEqual(flagged([
    'new Uint8Array(4)', 'new Uint32Array(1 << 16)', 'new Uint16Array(0x300 << 4)', 'new Uint8Array(MAX_BLOCK_BYTES)',
    'new Uint8Array((COLORMAP_TABLE_BUCKETS + 1) * 4)', 'new Uint8Array(Math.min(KEPT_PIECE_BYTES, byteLength - at))',
    'new Int32Array([1, 2])', 'new Float32Array(records.buffer)', 'new Uint8Array(await blob.arrayBuffer())',
    'new Float32Array(buffer, 0, n)', 'new Uint8Array(values.buffer, values.byteOffset, values.byteLength)',
    '// new Float32Array(nObs)', '/* new Float32Array(nObs) */',
  ].join(';\n')), []);
});

test('every typed array sized by the dataset is made by allocateTypedArray', async () => {
  const unlisted = [];
  const used = new Set();
  for (const dir of SCANNED) {
    for (const file of await sources(path.join(ROOT, dir))) {
      const relative = path.relative(ROOT, file).split(path.sep).join('/');
      const allowed = ALLOWED.find(entry => entry.file === relative);
      for (const site of unboundedAllocations(await readFile(file, 'utf8'))) {
        if (allowed?.allocations.includes(site.allocation)) used.add(`${relative}: ${site.allocation}`);
        else unlisted.push(`${relative}:${site.line}: ${site.allocation}`);
      }
    }
  }
  assert.deepEqual(
    unlisted,
    [],
    'Make these with allocateTypedArray(Type, length, label) (data/sparse-column-index.js), or list what bounds them ' +
      'other than the dataset in ALLOWED.'
  );
  const stale = ALLOWED.flatMap(entry => entry.allocations.map(allocation => `${entry.file}: ${allocation}`))
    .filter(key => !used.has(key));
  assert.deepEqual(stale, [], 'These allowed allocations are no longer in the source: remove them from ALLOWED.');
});

test('every allowed allocation says what bounds it', () => {
  for (const entry of ALLOWED) {
    assert.ok(entry.allocations.length > 0, `${entry.file} lists no allocation`);
    assert.ok(typeof entry.reason === 'string' && entry.reason.length > 20, `${entry.file} gives no reason`);
  }
});
