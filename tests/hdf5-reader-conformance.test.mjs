/**
 * Conformance of the HDF5 reader (assets/js/formats/hdf5) with the HDF5
 * library itself.
 *
 * Every file of the HDF5 corpus (tests/fixtures/hdf5, written by
 * scripts/generate-hdf5-conformance-corpus.py) and every `.h5ad` fixture is
 * walked with the reader and with h5wasm (the HDF5 C library compiled to
 * WebAssembly). For every object they must agree on: the child names, the
 * kind, the attributes, the shape, the element type, every value of every
 * array, deterministic pseudo-random ranges and 2-D sub-blocks (single
 * columns and partial edge chunks included), and each compound member read
 * on its own.
 *
 * Where h5wasm has no answer, the values h5py wrote stand in: half floats
 * come from expected-values.json; LZF-compressed datasets (h5wasm does not
 * bundle the filter) hold the same values as their uncompressed twins in
 * /contiguous. Features the reader refuses must raise its error classes.
 *
 * Name order: h5wasm lists links in the file's index order; the store lists
 * them sorted by code point. Keys are compared as sorted sets.
 */

import assert from 'node:assert/strict';
import fs, { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { bytesByteSource } from '../assets/js/formats/io/byte-source.js';
import { createByteReader } from '../assets/js/formats/io/byte-reader.js';
import { openHdf5, Hdf5FormatError, Hdf5UnsupportedError } from '../assets/js/formats/hdf5/index.js';
import { compareNames } from '../assets/js/formats/store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.join(here, 'fixtures', 'hdf5');
const H5AD = path.join(here, 'browser', 'fixtures');
const EXPECTED = JSON.parse(readFileSync(path.join(CORPUS, 'expected-values.json'), 'utf8'));

const corpusFiles = readdirSync(CORPUS).filter(name => name.endsWith('.h5')).map(name => path.join(CORPUS, name));
const h5adFiles = readdirSync(H5AD).filter(name => name.endsWith('.h5ad')).map(name => path.join(H5AD, name));

/** Groups with thousands of near-identical children: every child's keys and kind, every 97th child in full. */
const WIDE_GROUPS = new Set(['/groups', '/dense_links', '/many_links', '/group']);

// h5wasm writes the HDF5 library's error stack to file descriptor 2 (with
// `fs.writeSync`, piece by piece) for every failed lookup: a dangling soft
// link, an external link. Those failures are expected here and would bury
// the test output. Nothing else in this process writes to descriptor 2 with
// `fs.writeSync`, and h5wasm takes it when it loads: the filter goes first.
const writeSync = fs.writeSync;
fs.writeSync = (fd, buffer, offset, length, ...rest) => {
  if (fd === 2) return length ?? buffer.length;
  return writeSync(fd, buffer, offset, length, ...rest);
};
const { default: h5wasm } = await import('h5wasm/node');
await h5wasm.ready;

async function openOurs(file) {
  const bytes = new Uint8Array(readFileSync(file));
  return openHdf5(createByteReader(bytesByteSource(bytes, { name: path.basename(file) })));
}

/** A deterministic pseudo-random generator per path. */
function generator(seedText) {
  let seed = 2166136261;
  for (const char of seedText) seed = Math.imul(seed ^ char.codePointAt(0), 16777619);
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- normalising values for comparison ---------- */

function decodeExpected(value) {
  if (value === 'NaN') return NaN;
  if (value === 'Infinity') return Infinity;
  if (value === '-Infinity') return -Infinity;
  if (value === '-0') return -0;
  return value;
}

/** A plain, exactly comparable form: arrays of numbers/strings, BigInts as strings, bytes of floats. */
function plain(value) {
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'number') return Number.isNaN(value) ? 'NaN' : Object.is(value, -0) ? '-0' : value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === null || value === undefined) return value;
  if (ArrayBuffer.isView(value)) return Array.from(value, plain);
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === 'object' && value.ref_data instanceof Uint8Array) return Array.from(value.ref_data);
  return value;
}

/** Flatten nested arrays (h5wasm nests array-typed elements; the store flattens them). */
function flatten(value) {
  if (Array.isArray(value)) return value.flatMap(flatten);
  if (ArrayBuffer.isView(value)) return Array.from(value);
  return [value];
}

/** h5wasm's JSON attribute value, normalised like ours (64-bit integers are Numbers there). */
function attributeComparable(value) {
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(attributeComparable);
  return value;
}

/* ---------- element types ---------- */

const H5T = { INTEGER: 0, FLOAT: 1, STRING: 3, BITFIELD: 4, OPAQUE: 5, COMPOUND: 6, REFERENCE: 7, ENUM: 8, VLEN: 9, ARRAY: 10 };

/** Check our dtype against h5wasm's metadata of the same type. */
function assertDtype(dtype, metadata, where) {
  switch (metadata.type) {
    case H5T.INTEGER:
      assert.equal(dtype.kind, metadata.signed ? 'int' : 'uint', where);
      assert.equal(dtype.bytes, metadata.size, where);
      if (metadata.size > 1) assert.equal(dtype.littleEndian, metadata.littleEndian, where);
      break;
    case H5T.FLOAT:
      assert.equal(dtype.kind, 'float', where);
      assert.equal(dtype.bytes, metadata.size, where);
      assert.equal(dtype.littleEndian, metadata.littleEndian, where);
      break;
    case H5T.STRING:
      assert.equal(dtype.kind, 'string', where);
      assert.equal(dtype.variable, Boolean(metadata.vlen), where);
      assert.equal(dtype.encoding, metadata.cset === 1 ? 'utf-8' : 'ascii', where);
      if (!metadata.vlen) assert.equal(dtype.bytes, metadata.size, where);
      break;
    case H5T.ENUM: {
      const members = metadata.enum_type.members;
      const boolean = Object.keys(members).length === 2 && members.FALSE === 0 && members.TRUE === 1;
      assert.equal(dtype.kind, boolean ? 'bool' : 'enum', where);
      if (!boolean) assert.deepEqual({ ...dtype.members }, members, where);
      break;
    }
    case H5T.COMPOUND: {
      assert.equal(dtype.kind, 'compound', where);
      const members = metadata.compound_type.members;
      assert.deepEqual(dtype.fields.map(field => field.name), members.map(member => member.name), where);
      dtype.fields.forEach((field, index) => {
        const member = members[index];
        // (h5wasm reports offsets in its in-memory layout, not the file's.)
        if (member.type === H5T.ARRAY) {
          assert.deepEqual([...field.shape], member.array_type.shape, `${where}.${field.name}`);
          assertDtype(field.dtype, member.array_type, `${where}.${field.name}`);
        } else {
          assertDtype(field.dtype, member, `${where}.${field.name}`);
        }
      });
      break;
    }
    case H5T.ARRAY:
      assert.deepEqual([...dtype.arrayShape], metadata.array_type.shape, where);
      assertDtype({ ...dtype }, metadata.array_type, where);
      break;
    case H5T.VLEN:
      assert.equal(dtype.kind, 'opaque', where);
      assert.ok(dtype.sequence, `${where}: a variable-length sequence`);
      break;
    case H5T.OPAQUE:
    case H5T.REFERENCE:
      assert.equal(dtype.kind, 'opaque', where);
      assert.equal(dtype.bytes, metadata.size, where);
      break;
    default:
      assert.fail(`${where}: h5wasm type class ${metadata.type} not covered`);
  }
}

/* ---------- values ---------- */

/** h5wasm's value in the store's form, for exact comparison. */
function theirsComparable(value, metadata) {
  if (metadata.type === H5T.ARRAY) return plain(flatten(value));
  if (metadata.type === H5T.ENUM) {
    const members = metadata.enum_type.members;
    const boolean = Object.keys(members).length === 2 && members.FALSE === 0 && members.TRUE === 1;
    if (boolean) return plain(ArrayBuffer.isView(value) ? Array.from(value, v => (v ? 1 : 0)) : value ? 1 : 0);
  }
  if (metadata.type === H5T.COMPOUND) {
    const members = metadata.compound_type.members;
    const row = r => r.map((cell, i) => (members[i].type === H5T.ARRAY ? plain(flatten(cell)) : plain(cell)));
    return Array.isArray(value) && Array.isArray(value[0]) ? value.map(row) : row(value);
  }
  if (metadata.type === H5T.REFERENCE) return value.flatMap(reference => Array.from(reference.ref_data));
  if (metadata.type === H5T.OPAQUE) return plain(flatten(value));
  return plain(value);
}

function oursComparable(value, dtype) {
  if (dtype.kind === 'compound') {
    const row = r => r.map((cell, i) => (dtype.fields[i].shape.length > 0 ? plain(flatten(cell)) : plain(cell)));
    return Array.isArray(value) && Array.isArray(value[0]) ? value.map(row) : row(value);
  }
  return plain(value);
}

/** Read h5wasm's value, or null when it cannot (throws). */
function theirValue(dataset, ranges = null) {
  try {
    return ranges === null ? dataset.value : dataset.slice(ranges);
  } catch {
    return undefined;
  }
}

/** What h5py wrote, for datasets h5wasm cannot read. */
function substituteValue(file, h5, nodePath, selection) {
  const name = nodePath.slice(nodePath.lastIndexOf('/') + 1);
  if (name === 'le_f2') {
    const all = EXPECTED['numeric/le_f2'].map(decodeExpected);
    const [start, stop] = selection?.[0] ?? [0, all.length];
    return plain(Float32Array.from(all.slice(start, stop)));
  }
  if (nodePath.startsWith('/lzf/')) {
    const twin = h5.get(`/contiguous/${name}`);
    return plain(theirValue(twin, selection === null ? null : selection.map(([a, b]) => [a, b])));
  }
  return undefined;
}

function assertSameValues(ours, theirs, where) {
  assert.deepStrictEqual(ours, theirs, where);
}

/** Selections to compare beyond the full read: ranges, sub-blocks, columns, the last edge chunk. */
function selectionsFor(node) {
  const shape = node.shape;
  const random = generator(node.path);
  const pick = n => Math.floor(random() * n);
  const selections = [];
  if (shape.length === 1 && shape[0] > 1) {
    for (let i = 0; i < 4; i++) {
      const a = pick(shape[0]);
      const b = a + 1 + pick(shape[0] - a);
      selections.push([[a, b]]);
    }
    if (node.chunks) {
      const c = node.chunks[0];
      const lastStart = Math.floor((shape[0] - 1) / c) * c;
      selections.push([[Math.max(0, lastStart - 1), shape[0]]]);
    }
  } else if (shape.length === 2 && shape[0] > 1 && shape[1] > 1) {
    for (let i = 0; i < 3; i++) {
      const r0 = pick(shape[0]);
      const r1 = r0 + 1 + pick(shape[0] - r0);
      const c0 = pick(shape[1]);
      const c1 = c0 + 1 + pick(shape[1] - c0);
      selections.push([[r0, r1], [c0, c1]]);
    }
    const column = pick(shape[1]);
    selections.push([[0, shape[0]], [column, column + 1]]);
    selections.push([[0, shape[0]], [shape[1] - 1, shape[1]]]);
    selections.push([[shape[0] - 1, shape[0]], [0, shape[1]]]);
  } else if (shape.length === 3 && shape.every(n => n > 1)) {
    selections.push(shape.map(n => [1, n]));
    selections.push([[0, shape[0]], [0, 1], [shape[2] - 1, shape[2]]]);
  }
  return selections;
}

/* ---------- the walk ---------- */

async function compareArray(context, ours, theirs) {
  const where = `${context.name}:${ours.path}`;
  const metadata = theirs.metadata;
  assert.deepEqual([...ours.shape], theirs.shape ?? [0], `${where} shape`);
  if (theirs.shape === null) assert.equal(ours.hdf5.dataspace, 'null', where);
  assertDtype(ours.dtype, metadata, where);
  if (context.unreadable.has(ours.path)) return;
  context.counts.arrays++;

  // h5wasm does not bundle LZF: it reports the failure on stderr but returns
  // the still-compressed bytes as values, so it is not asked at all.
  const lzf = ours.hdf5.filters.some(filter => filter.id === 32000);
  let theirsAll = lzf ? undefined : theirValue(theirs);
  let expected = theirsAll === undefined ? substituteValue(context.file, context.h5, ours.path, null) : theirsComparable(theirsAll, metadata);
  assert.notEqual(expected, undefined, `${where}: no reference value (h5wasm cannot read it and h5py wrote none)`);
  if (theirs.shape === null) expected = [];
  const value = await ours.read();
  assertSameValues(oursComparable(value, ours.dtype), expected, `${where} values`);
  context.counts.values++;

  const perElement = ours.dtype.arrayShape ? ours.dtype.arrayShape.reduce((a, b) => a * b, 1) : 0;
  for (const selection of selectionsFor(ours)) {
    // h5wasm mis-shapes slices of array-typed elements: cut them from the full value.
    const theirsPart = lzf || perElement > 0 ? undefined : theirValue(theirs, selection);
    const reference = perElement > 0
      ? expected.slice(selection[0][0] * perElement, selection[0][1] * perElement)
      : theirsPart === undefined
      ? substituteValue(context.file, context.h5, ours.path, selection)
      : theirsComparable(theirsPart, metadata);
    if (reference === undefined) continue;
    const part = await ours.read(selection);
    assertSameValues(oursComparable(part, ours.dtype), reference, `${where} selection ${JSON.stringify(selection)}`);
    context.counts.selections++;
  }

  if (ours.dtype.kind === 'compound' && theirsAll !== undefined) {
    const rows = Array.isArray(theirsAll[0]) ? theirsAll : [theirsAll];
    for (const [index, field] of ours.dtype.fields.entries()) {
      const column = await ours.readField(field.name);
      const reference = rows.map(row => row[index]);
      const member = metadata.compound_type.members[index];
      let expectedColumn = plain(flatten(reference));
      if (member.type === H5T.ENUM && Object.keys(member.enum_type.members).length === 2) {
        expectedColumn = expectedColumn.map(v => (v ? 1 : 0));
      }
      assert.deepStrictEqual(plain(flatten(ours.shape.length === 0 ? [column] : column)), expectedColumn, `${where} field ${field.name}`);
      if (ours.shape.length === 1 && ours.shape[0] > 3) {
        const part = await ours.readField(field.name, [[1, 3]]);
        assert.deepStrictEqual(plain(flatten(part)), plain(flatten(reference.slice(1, 3))).map(v => (member.type === H5T.ENUM ? (v ? 1 : 0) : v)), `${where} field ${field.name} rows 1-3`);
      }
      context.counts.fields++;
    }
  }
  theirsAll = null;
}

function compareAttributes(context, ours, theirs) {
  const where = `${context.name}:${ours.path}`;
  const theirAttributes = theirs.attrs;
  assert.deepEqual(Object.keys(ours.attrs).sort(compareNames), Object.keys(theirAttributes).sort(compareNames), `${where} attribute names`);
  for (const [name, attribute] of Object.entries(theirAttributes)) {
    const type = ours.attributeType(name);
    assert.ok(type !== null, `${where} attribute ${name} type`);
    assertDtype(type.dtype, attribute.metadata, `${where} @${name}`);
    if (type.dtype.kind === 'opaque') continue;
    assert.deepStrictEqual(attributeComparable(ours.attrs[name]), attribute.json_value, `${where} @${name}`);
    context.counts.attributes++;
  }
}

/** Whether `absolute` names an object, walking h5wasm's link names. */
function existsIn(h5, absolute) {
  let group = h5;
  for (const part of absolute.split('/').filter(Boolean)) {
    if (group?.type !== 'Group' || !group.keys().includes(part)) return false;
    group = group.get(part);
  }
  return true;
}

async function compareGroup(context, ours, theirs, depth) {
  const where = `${context.name}:${ours.path}`;
  const theirKeys = theirs.keys().filter(key => {
    try {
      return theirs.get(key)?.type !== 'Datatype';
    } catch {
      return true;
    }
  });
  assert.deepEqual(ours.keys(), theirKeys.slice().sort(compareNames), `${where} keys`);
  compareAttributes(context, ours, theirs);
  context.counts.groups++;
  const wide = WIDE_GROUPS.has(ours.path);
  for (const [index, key] of ours.keys().entries()) {
    const childPath = ours.path === '/' ? `/${key}` : `${ours.path}/${key}`;
    let child;
    try {
      child = ours.get(key);
    } catch (error) {
      // An external link: h5wasm must agree that it is one.
      assert.ok(error instanceof Hdf5UnsupportedError && error.feature === 'external-link', `${childPath}: ${error}`);
      assert.equal(typeof theirs.get_external_link(key).filename, 'string', `${childPath} is an external link`);
      continue;
    }
    if (child === null) {
      // A soft link leading nowhere (h5wasm returns a bogus group for it):
      // its target must not exist.
      const target = theirs.get_link(key);
      assert.equal(typeof target, 'string', `${childPath} is a soft link`);
      assert.equal(existsIn(context.h5, target.startsWith('/') ? target : `${ours.path}/${target}`), false, `${childPath} -> ${target} is dangling`);
      continue;
    }
    const entity = theirs.get(key);
    if (entity.type === 'Group') {
      assert.equal(child.kind, 'group', `${childPath} kind`);
      // A hard link back up the tree: compared once, not followed again.
      if (key === 'up') continue;
      if (wide && index % 97 !== 0) {
        assert.deepEqual(child.keys(), entity.keys().slice().sort(compareNames), `${childPath} keys`);
        continue;
      }
      await compareGroup(context, child, entity, depth + 1);
    } else {
      assert.equal(child.kind, 'array', `${childPath} kind`);
      compareAttributes(context, child, entity);
      await compareArray(context, child, entity);
    }
  }
}

async function compareFile(file, unreadable = new Set()) {
  const h5 = new h5wasm.File(file, 'r');
  const root = await openOurs(file);
  const context = {
    file,
    h5,
    name: path.basename(file),
    unreadable,
    counts: { groups: 0, arrays: 0, values: 0, selections: 0, attributes: 0, fields: 0 },
  };
  try {
    await compareGroup(context, root, h5, 0);
  } finally {
    h5.close();
    root.close();
  }
  return context.counts;
}

/** Datasets the reader refuses by design; checked in their own test below. */
const REFUSED = new Map([
  ['unsupported-features.h5', new Set(['/virtual', '/scaleoffset', '/nbit', '/external_storage'])],
]);

for (const file of corpusFiles) {
  test(`HDF5 corpus ${path.basename(file)} matches the HDF5 library`, async () => {
    const counts = await compareFile(file, REFUSED.get(path.basename(file)));
    assert.ok(counts.values > 0, 'compared at least one array');
  });
}

test('every .h5ad fixture matches the HDF5 library', async () => {
  assert.ok(h5adFiles.length >= 10, 'the .h5ad fixtures are present');
  const totals = { arrays: 0, fields: 0 };
  for (const file of h5adFiles) {
    const counts = await compareFile(file);
    totals.arrays += counts.arrays;
    totals.fields += counts.fields;
  }
  assert.ok(totals.arrays > 100);
  assert.ok(totals.fields > 0, 'compound (AnnData 0.6) fields compared');
});

test('features the reader does not read fail with Hdf5UnsupportedError, only when used', async () => {
  const root = await openOurs(path.join(CORPUS, 'unsupported-features.h5'));
  assert.deepEqual(root.keys(), ['elsewhere', 'external_storage', 'nbit', 'present', 'scaleoffset', 'vds_source', 'virtual']);
  const expectError = async (promise, feature) => {
    await assert.rejects(promise, error => error instanceof Hdf5UnsupportedError && error.feature === feature && /[a-z]/.test(error.message));
  };
  assert.throws(() => root.get('elsewhere'), error => error instanceof Hdf5UnsupportedError && error.feature === 'external-link');
  assert.equal(root.has('elsewhere'), true);
  await expectError(root.get('virtual').read(), 'virtual-dataset');
  await expectError(root.get('scaleoffset').read(), 'filter:scaleoffset');
  await expectError(root.get('nbit').read([[0, 5]]), 'filter:nbit');
  await expectError(root.get('external_storage').read(), 'external-storage');
  assert.deepEqual(Array.from(await root.get('present').read(), Number), [0, 1, 2]);
  assert.deepEqual(Array.from(await root.get('vds_source').read([[3, 6]])), [3, 4, 5]);
  root.close();
});

test('navigation: soft links, hard-link cycles, UTF-8 names, committed types, absent paths', async () => {
  const root = await openOurs(path.join(CORPUS, 'default-format.h5'));
  assert.equal(root.path, '/');
  assert.equal(root.get('dangling'), null);
  assert.equal(root.has('dangling'), false);
  assert.equal(root.get('no/such/path'), null);
  assert.equal(root.get('nested/deeper/deepest/leaf/below'), null);
  const leaf = root.get('/nested/deeper/deepest/leaf');
  assert.equal(leaf.path, '/nested/deeper/deepest/leaf');
  assert.equal(leaf.name, 'leaf');
  assert.equal(root.get('nested/deeper/deepest/leaf'), leaf, 'the same node for the same path');
  assert.equal(root.get('nested').get('/soft_link').path, '/soft_link');
  assert.deepEqual(Array.from(await root.get('nested/relative_link').read(), Number), [0, 1, 2, 3, 4]);
  assert.equal(root.get('soft_to_group/deepest/leaf').path, '/soft_to_group/deepest/leaf');
  // The cycle: /cycle/a/up is /cycle again, however deep.
  const deep = root.get('cycle/a/up/a/up/a/up/a');
  assert.equal(deep.kind, 'group');
  assert.deepEqual(deep.keys(), ['up']);
  assert.deepEqual(root.get('naïve').keys(), ['日本語']);
  assert.equal(root.get('naïve').attrs['größe'], 'ü');
  // A committed datatype is neither a group nor an array.
  assert.equal(root.keys().includes('named_float'), false);
  assert.equal(root.get('named_float'), null);
  const named = root.get('uses_named_type');
  assert.equal(named.dtype.name, 'float32');
  assert.deepEqual(named.attrs.named_attribute, [0, 1, 2]);
  assert.throws(() => root.get('../x'), RangeError);
  root.close();
});

test('attributes follow the store: booleans, one-element arrays, BigInt beyond the safe range', async () => {
  const root = await openOurs(path.join(CORPUS, 'default-format.h5'));
  const attrs = root.attrs;
  assert.equal(Object.isFrozen(attrs), true);
  assert.equal(attrs.bool, false);
  assert.equal(attrs.ordered, true);
  assert.deepEqual(attrs.shape, [10, 20]);
  assert.equal(attrs['encoding-type'], 'csr_matrix');
  assert.deepEqual(attrs.empty_list, []);
  assert.equal(attrs.scalar_float, 1.25);
  assert.equal(root.attributeType('ordered').dtype.kind, 'bool');
  assert.deepEqual(root.attributeType('shape'), { dtype: root.attributeType('shape').dtype, shape: [2] });
  assert.equal(root.attributeType('missing'), null);
  root.close();
  const h5ad = await openOurs(path.join(H5AD, 'legacy-0.7-csr.h5ad'));
  const walk = group => {
    for (const key of group.keys()) {
      const child = group.get(key);
      for (const [name, value] of Object.entries(child.attrs)) {
        const type = child.attributeType(name);
        if (type.dtype.kind === 'bool') assert.equal(typeof value, 'boolean', `${child.path} @${name}`);
        if (type.shape.length === 1) assert.ok(Array.isArray(value), `${child.path} @${name} is an array`);
      }
      if (child.kind === 'group') walk(child);
    }
  };
  walk(h5ad);
  h5ad.close();
});

test('a file that is not HDF5, or is cut short, fails with Hdf5FormatError', async () => {
  const notHdf5 = createByteReader(bytesByteSource(new TextEncoder().encode('just some text, not an HDF5 file at all'.repeat(100))));
  await assert.rejects(openHdf5(notHdf5), Hdf5FormatError);
  const full = readFileSync(path.join(CORPUS, 'latest-format.h5'));
  const cut = new Uint8Array(full.subarray(0, Math.floor(full.length / 2)));
  await assert.rejects(openHdf5(createByteReader(bytesByteSource(cut))), Hdf5FormatError);
});
