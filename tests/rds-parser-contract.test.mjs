/**
 * The R serialization parser (`assets/js/formats/rds/`): every item type R
 * writes, built here byte by byte as `serialize.c` writes it, read back
 * whole and split into two pieces at every byte offset (engines hand a
 * decompressor's output over in pieces of any size); the plan's skipped
 * and dropped payloads; random access over an uncompressed file (payloads
 * jumped over, never read); and damaged streams, which fail with where in
 * the object they failed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import {
  NA_INTEGER,
  RdsFormatError,
  RdsUnsupportedError,
  XdrReader,
  formatRealAsR,
  parseItem,
  readHeader,
  readRFile,
} from '../assets/js/formats/rds/index.js';
import { R_OBJECT_PLAN } from '../assets/js/data/anndata/transcode/r-object.js';

/** Writes an XDR serialization stream as R does. */
class Writer {
  constructor() {
    this.bytes = [];
  }

  int(value) {
    const view = new DataView(new ArrayBuffer(4));
    view.setInt32(0, value, false);
    this.bytes.push(...new Uint8Array(view.buffer));
    return this;
  }

  double(value) {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, false);
    this.bytes.push(...new Uint8Array(view.buffer));
    return this;
  }

  raw(values) {
    this.bytes.push(...values);
    return this;
  }

  flags(type, { object = false, attr = false, tag = false, levels = 0 } = {}) {
    return this.int(type | (object ? 1 << 8 : 0) | (attr ? 1 << 9 : 0) | (tag ? 1 << 10 : 0) | (levels << 12));
  }

  chars(text, levels = 64) {
    if (text === null) return this.flags(9).int(-1);
    const bytes = new TextEncoder().encode(text);
    return this.flags(9, { levels }).int(bytes.length).raw(bytes);
  }

  symbol(name) {
    return this.flags(1).chars(name);
  }

  nil() {
    return this.int(254);
  }

  header(version = 3) {
    this.raw([0x58, 0x0a]).int(version).int(0x040503).int(0x030500);
    if (version === 3) this.int(5).raw([...new TextEncoder().encode('UTF-8')]);
    return this;
  }

  result() {
    return Uint8Array.from(this.bytes);
  }
}

/** A list(a = 1:3, b = c(1.5, NA), s = c("x", NA), ...) covering every item type. */
function everyType() {
  const w = new Writer().header(3);
  // A named list with class "demo": VECSXP with attributes.
  w.flags(19, { attr: true, object: true }).int(12);
  // [0] integer vector with NA
  w.flags(13).int(3).int(1).int(NA_INTEGER).int(3);
  // [1] double vector with NA (R's NA_real_ is a NaN)
  w.flags(14).int(2).double(1.5).double(NaN);
  // [2] character vector with NA and UTF-8
  w.flags(16).int(3).chars('x').chars(null).chars('é', 8);
  // [3] logical
  w.flags(10).int(2).int(1).int(0);
  // [4] complex and raw
  w.flags(15).int(1).double(1).double(2);
  // [5] raw
  w.flags(24).int(3).raw([1, 2, 3]);
  // [6] an environment registered before its contents, then a reference to it
  w.flags(19).int(2);
  w.int(4).int(0).int(253).flags(2, { tag: true }).symbol('v').flags(14).int(1).double(7).nil().nil().nil();
  w.int((1 << 8) | 255); // REFSXP to item 1: the environment, registered before its symbol `v`
  // [7] a closure (formals, body) with byte code
  w.flags(3, { tag: true }).int(253).flags(2, { tag: true }).symbol('x').int(251).nil()
    .flags(21).int(1)
    .flags(13).int(2).int(12).int(1)
    .int(1).int(6).flags(1).chars('ignored-tag').int(0).symbol('f').int(0).nil();
  // [8] ALTREP compact_intseq 5:9
  w.int(238).flags(2).symbol('compact_intseq').flags(2).symbol('base').flags(2).flags(13).int(1).int(13).nil()
    .flags(14).int(3).double(5).double(5).double(1).nil();
  // [9] ALTREP deferred_string of 0:2
  w.int(238).flags(2).symbol('deferred_string').flags(2).symbol('base').flags(2).flags(13).int(1).int(16).nil()
    .flags(2).flags(13).int(3).int(0).int(1).int(2).flags(13).int(1).int(0).nil();
  // [10] ALTREP wrap_real around c(2.5, 3.5), with dim
  w.int(238).flags(2).symbol('wrap_real').flags(2).symbol('base').flags(2).flags(13).int(1).int(14).nil()
    .flags(19).int(2).flags(14).int(2).double(2.5).double(3.5).flags(13).int(2).int(0).int(0)
    .flags(2, { tag: true }).symbol('dim').flags(13).int(2).int(2).int(1).nil();
  // [11] an S4 object with a NULL slot and an external pointer and builtin
  w.flags(25, { attr: true, object: true, levels: 16 })
    .flags(2, { tag: true }).symbol('empty').symbol('\u0001NULL\u0001')
    .flags(2, { tag: true }).symbol('ptr').flags(22).nil().nil()
    .flags(2, { tag: true }).symbol('fun').flags(8).int(3).raw([0x73, 0x75, 0x6d])
    .flags(2, { tag: true }).symbol('class').flags(16, { attr: true }).int(1).chars('Thing')
    .flags(2, { tag: true }).symbol('package').flags(16).int(1).chars('demo').nil()
    .nil();
  // attributes of the list: names and class
  w.flags(2, { tag: true }).symbol('names').flags(16).int(12);
  for (const name of ['int', 'dbl', 'chr', 'lgl', 'cplx', 'raw', 'env', 'fun', 'seq', 'def', 'wrap', 's4']) w.chars(name);
  w.flags(2, { tag: true }).symbol('class').flags(16).int(1).chars('demo').nil();
  return w.result();
}

/** Pieces of `bytes` split at `at`. */
async function* split(bytes, at) {
  if (at > 0) yield bytes.subarray(0, at);
  if (at < bytes.length) yield bytes.subarray(at);
}

async function parse(bytes, options = {}, at = bytes.length) {
  const reader = XdrReader.ofStream(split(bytes, at));
  const header = await readHeader(reader);
  return parseItem(reader, { nativeEncoding: header.nativeEncoding, ...options });
}

function summary(root) {
  const names = root.attributes.names.values;
  const items = Object.fromEntries(names.map((name, index) => [name, root.items[index]]));
  return {
    int: Array.from(items.int.values),
    dbl: Array.from(items.dbl.values, value => (Number.isNaN(value) ? 'NaN' : value)),
    chr: items.chr.values,
    lgl: Array.from(items.lgl.values),
    cplx: Array.from(items.cplx.values),
    raw: Array.from(items.raw.values),
    env: [items.env.items[0].kind, items.env.items[0] === items.env.items[1]],
    fun: items.fun.kind,
    seq: Array.from(items.seq.values),
    def: items.def.values,
    wrap: [Array.from(items.wrap.values), Array.from(items.wrap.attributes.dim.values)],
    s4: [items.s4.kind, items.s4.s4, items.s4.attributes.empty.name, items.s4.attributes.ptr.kind, items.s4.attributes.class.values[0]],
    class: root.attributes.class.values,
  };
}

const EXPECTED = {
  int: [1, NA_INTEGER, 3],
  dbl: [1.5, 'NaN'],
  chr: ['x', null, 'é'],
  lgl: [1, 0],
  cplx: [1, 2],
  raw: [1, 2, 3],
  env: ['environment', true],
  fun: 'opaque',
  seq: [5, 6, 7, 8, 9],
  def: ['0', '1', '2'],
  wrap: [[2.5, 3.5], [2, 1]],
  s4: ['S4', true, '\u0001NULL\u0001', 'opaque', 'Thing'],
  class: ['demo'],
};

test('every item type R writes reads back', async () => {
  assert.deepEqual(summary(await parse(everyType())), EXPECTED);
});

test('a stream split into two pieces at every byte offset reads the same', async () => {
  const bytes = everyType();
  for (let at = 0; at <= bytes.length; at++) {
    assert.deepEqual(summary(await parse(bytes, {}, at)), EXPECTED, `split at ${at}`);
  }
});

test('the plan skips payloads and drops subtrees, and large kept payloads go to the sink', async () => {
  const w = new Writer().header(2);
  w.flags(19, { attr: true }).int(3);
  w.flags(14).int(100);
  for (let i = 0; i < 100; i++) w.double(i);
  w.flags(13).int(2).int(1).int(2);
  w.flags(16).int(1).chars('dropped');
  w.flags(2, { tag: true }).symbol('names').flags(16).int(3).chars('big').chars('small').chars('gone').nil();
  const bytes = w.result();
  const written = [];
  const sink = {
    open: (byteLength, info) => {
      const parts = [];
      return { write: view => parts.push(view.slice()), close: () => { written.push({ byteLength, path: info.path.join(''), parts }); return { store: 'sink', offset: 0, byteLength }; } };
    },
  };
  const root = await parse(bytes, {
    sink,
    inlineElements: 10,
    plan: { drop: path => path.at(-1) === '[2]', vector: path => (path.at(-1) === '[1]' ? 'skip' : 'keep') },
  });
  assert.equal(root.items[0].region.byteLength, 800);
  assert.equal(root.items[0].values, null);
  assert.deepEqual(written.map(item => [item.byteLength, item.path]), [[800, '[0]']]);
  assert.equal(root.items[1].values, null, 'skipped');
  assert.equal(root.items[1].skipped, true);
  assert.equal(root.items[2].kind, 'skipped');
  assert.deepEqual(root.attributes.names.values, ['big', 'small', 'gone']);
});

/** list(counts = <n doubles>, scale.data = <n doubles>, data = 1:2) as an S4 slot `layers`, then one more slot. */
function layersStream(n) {
  const w = new Writer().header(3);
  w.flags(25, { attr: true, object: true, levels: 16 });
  w.flags(2, { tag: true }).symbol('layers').flags(19, { attr: true }).int(3);
  w.flags(14).int(n);
  for (let i = 0; i < n; i++) w.double(i);
  w.flags(14).int(n);
  for (let i = 0; i < n; i++) w.double(-i);
  w.flags(13).int(2).int(1).int(2);
  w.flags(2, { tag: true }).symbol('names').flags(16).int(3).chars('counts').chars('scale.data').chars('data').nil();
  w.flags(2, { tag: true }).symbol('after').flags(14).int(n);
  for (let i = 0; i < n; i++) w.double(i);
  w.nil();
  return w.result();
}

test('a large list element whose fate waits for its name is passed over, never stored when dropped', async () => {
  const bytes = layersStream(50);
  const opened = [];
  const sink = {
    open: (byteLength, info) => {
      opened.push(info.path.join(''));
      return { write: () => {}, close: () => ({ store: info.path.join(''), offset: 0, byteLength }) };
    },
    release: () => assert.fail('nothing was stored to give back'),
  };
  const plan = { dropByName: path => (path.at(-1) === '@layers' ? name => name === 'scale.data' : null) };
  const root = await parse(bytes, { sink, inlineElements: 10, plan });
  assert.deepEqual(opened, ['@after'], 'the list\'s large elements are not stored while they stream');
  const layers = root.attributes.layers;
  assert.equal(layers.items[0].reread.byteLength, 50 * 8);
  assert.equal(layers.items[0].region, null);
  assert.deepEqual({ ...layers.items[1] }, { kind: 'skipped', attributes: null, bytes: 8 + 50 * 8, empty: false });
  assert.deepEqual(Array.from(layers.items[2].values), [1, 2], 'a small element is read as usual');
  assert.deepEqual(layers.attributes.names.values, ['counts', 'scale.data', 'data']);
});

test('a kept element passed over while the file streamed is read again; a dropped one never is', async () => {
  const bytes = gzipSync(layersStream(50));
  const file = { size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) };
  const plan = { dropByName: path => (path.at(-1) === '@layers' ? name => name === 'scale.data' : null) };
  const stored = new Map();
  const sink = {
    open: (byteLength, info) => {
      const parts = [];
      return {
        write: view => parts.push(view.slice()),
        close: () => {
          const store = `p${stored.size}`;
          stored.set(store, Buffer.concat(parts));
          return { store, offset: 0, byteLength };
        },
      };
    },
  };
  const parsed = await readRFile(file, { plan, sink, inlineElements: 10 });
  const layers = parsed.root.attributes.layers;
  assert.equal(layers.items[0].reread, undefined);
  const kept = stored.get(layers.items[0].region.store);
  const counts = new DataView(kept.buffer, kept.byteOffset, kept.byteLength);
  assert.deepEqual(Array.from({ length: 50 }, (_, i) => counts.getFloat64(i * 8, false)), Array.from({ length: 50 }, (_, i) => i));
  assert.equal(layers.items[1].kind, 'skipped');
  assert.equal(stored.size, 2, 'counts and the slot after the list; scale.data never');
  // Without a sink the kept element is read into memory.
  const inMemory = await readRFile(file, { plan, inlineElements: 10 });
  assert.deepEqual(Array.from(inMemory.root.attributes.layers.items[0].values), Array.from({ length: 50 }, (_, i) => i));
  assert.equal(inMemory.root.attributes.layers.items[1].kind, 'skipped');
});

test('an uncompressed file is read by ranges: payloads are jumped over, never read', async () => {
  const w = new Writer().header(3);
  w.flags(19).int(2);
  w.flags(14).int(200000);
  for (let i = 0; i < 200000; i++) w.double(i);
  w.flags(13).int(1).int(42);
  const bytes = w.result();
  let fetched = 0;
  const file = { size: bytes.length, read: async (offset, length) => { fetched += length; return bytes.subarray(offset, offset + length); } };
  const reader = XdrReader.ofRanges(file, { windowBytes: 256 });
  const header = await readHeader(reader);
  const root = await parseItem(reader, { nativeEncoding: header.nativeEncoding });
  assert.equal(root.items[0].region.store, 'file');
  // The header (23 bytes), the list's flags and length, the vector's flags and length.
  assert.equal(root.items[0].region.offset, 23 + 8 + 8);
  assert.equal(root.items[0].region.byteLength, 1600000);
  assert.deepEqual(Array.from(root.items[1].values), [42]);
  assert.ok(fetched < 2048, `${fetched} bytes read of ${bytes.length}`);
  const viaFile = await readRFile(file);
  assert.equal(viaFile.random, true);
  assert.equal(viaFile.root.items[0].region.byteLength, 1600000);
});

test('damaged streams fail with where they failed', async () => {
  const bytes = everyType();
  for (const cut of [10, 40, Math.floor(bytes.length / 2), bytes.length - 3]) {
    await assert.rejects(parse(bytes.subarray(0, cut)), RdsFormatError, `cut at ${cut}`);
  }
  const unknown = new Writer().header(3).flags(19).int(1).int(99).result();
  await assert.rejects(parse(unknown), error => error instanceof RdsFormatError && /unknown type 99/.test(error.message) && /\[0\]/.test(error.message));
  const reference = new Writer().header(3).int((7 << 8) | 255).result();
  await assert.rejects(parse(reference), /reference to item 7 of 0/);
  const negative = new Writer().header(3).flags(13).int(-5).result();
  await assert.rejects(parse(negative), /length -5/);
  const ascii = new Uint8Array([0x41, 0x0a, 0, 0]);
  await assert.rejects(readHeader(XdrReader.ofStream(split(ascii, 4))), RdsUnsupportedError);
  const version = new Writer().raw([0x58, 0x0a]).int(4).result();
  await assert.rejects(readHeader(XdrReader.ofStream(split(version, version.length))), /version 4/);
});

test('doubles become text as as.character() writes them', () => {
  assert.equal(formatRealAsR(1), '1');
  assert.equal(formatRealAsR(0.1), '0.1');
  assert.equal(formatRealAsR(1 / 3), '0.333333333333333');
  assert.equal(formatRealAsR(1e20), '1e+20');
  assert.equal(formatRealAsR(NaN), null);
  assert.equal(formatRealAsR(-Infinity), '-Inf');
});

/** An S4 object whose slot `x` is n doubles carrying one name each (a dgCMatrix's `@x` after `rep()` of a named vector). */
function namedPayloadStream(n) {
  const w = new Writer().header(3);
  w.flags(25, { attr: true, object: true, levels: 16 });
  w.flags(2, { tag: true }).symbol('x').flags(14, { attr: true }).int(n);
  for (let i = 0; i < n; i++) w.double(i + 0.5);
  w.flags(2, { tag: true }).symbol('names').flags(16).int(n);
  for (let i = 0; i < n; i++) w.chars(`AAAC${i}-1`);
  w.nil();
  w.nil();
  return w.result();
}

test('the names R leaves on a sparse matrix payload are passed over, the values kept', async () => {
  const root = await parse(namedPayloadStream(200), { plan: R_OBJECT_PLAN });
  const x = root.attributes.x;
  assert.deepEqual(Array.from(x.values).slice(0, 3), [0.5, 1.5, 2.5]);
  assert.equal(x.attributes.names.kind, 'skipped', 'one string per stored value is never decoded');
  assert.ok(x.attributes.names.bytes > 200 * 8);
});
