/**
 * Every Zarr store the browser tests use (tests/browser/fixtures/*.zarr.zip)
 * opens with the app's reader (formats/zip + formats/zarr), and every node
 * reads exactly as zarr-python reads it: the same tree, attributes, shapes,
 * chunk shapes, fill values and values. The reference is
 * `tests/browser/fixtures/zarr-fixtures.expected.json`, written by
 * `scripts/generate-zarr-browser-fixture-expected.py`; values are pinned by a
 * SHA-256 digest of their bytes (described in that script).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openAsBlob, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { blobByteSource } from '../assets/js/formats/io/byte-source.js';
import { createByteReader } from '../assets/js/formats/io/byte-reader.js';
import { openZipArchive } from '../assets/js/formats/zip/index.js';
import { openZarr, zipStore } from '../assets/js/formats/zarr/index.js';
import { isGroup, valueArrayClass } from '../assets/js/formats/store.js';

const BROWSER_FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'browser', 'fixtures');
const archives = readdirSync(BROWSER_FIXTURES).filter(name => name.endsWith('.zarr.zip')).sort();
const EXPECTED = JSON.parse(readFileSync(path.join(BROWSER_FIXTURES, 'zarr-fixtures.expected.json'), 'utf8'));

function decodeAttr(value) {
  if (Array.isArray(value)) return value.map(decodeAttr);
  if (value !== null && typeof value === 'object') {
    if ('$bigint' in value) return BigInt(value.$bigint);
    if ('$float' in value) return Number(value.$float);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeAttr(item)]));
  }
  return value;
}

/** The values of a read as the expected encoding digests them. */
function digestOf(values, dtype) {
  const hash = createHash('sha256');
  let count;
  if (dtype.kind === 'string') {
    for (const value of values) {
      const bytes = Buffer.from(value, 'utf8');
      const length = Buffer.alloc(4);
      length.writeUInt32LE(bytes.length);
      hash.update(length);
      hash.update(bytes);
    }
    count = values.length;
  } else {
    hash.update(Buffer.from(values.buffer, values.byteOffset, values.byteLength));
    count = values.length;
  }
  return { count, sha256: hash.digest('hex') };
}

/** A whole read as a list of elements (a scalar array reads as its value). */
function elementsOf(value, node) {
  if (node.shape.length > 0) return value;
  if (node.dtype.kind === 'string') return [value];
  return valueArrayClass(node.dtype).of(value);
}

function encodeFill(fill, dtype) {
  if (fill === null) return null;
  if (dtype.kind === 'bool') return fill ? 1 : 0;
  if (typeof fill === 'bigint') return String(fill);
  if (typeof fill === 'number' && !Number.isFinite(fill)) return Number.isNaN(fill) ? 'NaN' : fill > 0 ? 'Infinity' : '-Infinity';
  return fill;
}

test('the browser fixtures include Zarr stores, each with its reference', () => {
  assert.ok(archives.length >= 4, archives.join(', '));
  assert.deepEqual(Object.keys(EXPECTED).sort(), archives, 'regenerate with scripts/generate-zarr-browser-fixture-expected.py');
});

for (const name of archives) {
  test(`${name}: every node reads as zarr-python reads it`, async () => {
    const file = await openAsBlob(path.join(BROWSER_FIXTURES, name));
    const archive = await openZipArchive(createByteReader(blobByteSource(file, { name })));
    const root = await openZarr(zipStore(archive));
    const expected = EXPECTED[name];
    assert.equal(root.zarrFormat, expected.zarr_format);

    let arrays = 0;
    for (const [nodePath, want] of Object.entries(expected.nodes)) {
      const node = nodePath === '/' ? root : root.get(nodePath);
      assert.ok(node, `${nodePath} exists`);
      assert.equal(node.kind, want.kind, `${nodePath}: kind`);
      assert.deepEqual(node.attrs, decodeAttr(want.attrs), `${nodePath}: attrs`);
      if (want.kind === 'group') {
        assert.ok(isGroup(node));
        continue;
      }
      arrays++;
      assert.deepEqual(node.shape, want.shape, `${nodePath}: shape`);
      assert.deepEqual(node.chunks, want.chunks, `${nodePath}: chunks`);
      if ('fill' in want) {
        // zarr 2 wrote fill_value 0 for text (object) arrays; zarr-python 3
        // reads that as the text '0', the app as the empty string. No
        // AnnData array leaves a chunk unwritten, so neither reaches a value.
        const fill = node.dtype.kind === 'string' && node.dtype.variable && want.fill === '0' ? '' : want.fill;
        assert.deepEqual(encodeFill(node.fillValue, node.dtype), fill, `${nodePath}: fill`);
      }
      const values = elementsOf(await node.read(), node);
      if (want.digest) {
        assert.deepEqual(digestOf(values, node.dtype), want.digest, `${nodePath}: values`);
      } else {
        assert.deepEqual(Array.from(values, value => (typeof value === 'bigint' ? String(value) : value)), want.values, `${nodePath}: values`);
      }
    }
    assert.ok(arrays > 0);
    // Nothing is in the store that zarr-python does not list.
    const listed = new Set(Object.keys(expected.nodes));
    const walk = group => {
      for (const key of group.keys()) {
        const child = group.get(key);
        assert.ok(listed.has(child.path), `${child.path} is in the reference`);
        if (isGroup(child)) walk(child);
      }
    };
    walk(root);
  });
}
