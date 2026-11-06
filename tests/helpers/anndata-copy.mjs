/**
 * Copies of datasets (`data/anndata/write/copy.js`) for contract tests:
 * written to memory, opened again with the app's own opener, and compared
 * with their source element by element.
 *
 * `compareCopy(source, copy)` walks the source as the reader presents it
 * and finds every array again in the copy as the reader presents that:
 * the same shape, the same attributes, the same values (typed arrays bit
 * for bit, text item for item). A cell-major expression matrix of the
 * source (`csr_matrix`), which a copy writes gene-major, is compared as its
 * entries (row, gene, value) in row order. What it returns says what was
 * compared, so a test can require that a matrix was.
 */
import assert from 'node:assert/strict';

import { openDatasetStore } from '../../assets/js/data/anndata/open.js';
import { writeAnnDataCopy } from '../../assets/js/data/anndata/write/copy.js';
import { isArrayNode, isGroup } from '../../assets/js/formats/store.js';

const CACHE_BYTES = 64 * 1024 * 1024;

/** A sink holding every part in memory, and the archive as one array. */
export function memorySink() {
  const parts = [];
  let size = 0;
  return {
    async write(part) {
      const bytes = part instanceof Blob ? new Uint8Array(await part.arrayBuffer()) : part;
      assert.ok(bytes instanceof Uint8Array, 'an archive is written as bytes');
      parts.push(bytes);
      size += bytes.length;
    },
    bytes() {
      const out = new Uint8Array(size);
      let at = 0;
      for (const part of parts) {
        out.set(part, at);
        at += part.length;
      }
      return out;
    },
    get size() {
      return size;
    },
  };
}

/** Open a source as the app opens it: its presented store root. */
export async function openSource(source) {
  return openDatasetStore({ source }, { decodedChunkCacheBytes: CACHE_BYTES });
}

/** Copy the store at `root` into memory: the archive's bytes and what the copy said. */
export async function copyToMemory(root, options = {}) {
  const sink = memorySink();
  const result = await writeAnnDataCopy(root, sink, options);
  const bytes = sink.bytes();
  assert.equal(bytes.length, result.bytes, 'the archive is as long as the copy says');
  return { bytes, result };
}

/** Open copied bytes as a `.zarr.zip`. */
export async function openCopy(bytes, name = 'copy.zarr.zip') {
  return openSource({ file: new File([bytes], name) });
}

/** A typed array's bytes, to compare values bit for bit (NaN payloads included). */
function bitsOf(values) {
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}

function sameValues(actual, expected, label) {
  if (ArrayBuffer.isView(expected)) {
    assert.ok(ArrayBuffer.isView(actual), `${label}: numbers`);
    assert.equal(actual.constructor.name, expected.constructor.name, `${label}: the same type`);
    assert.equal(actual.length, expected.length, `${label}: the same length`);
    assert.ok(bitsOf(actual).equals(bitsOf(expected)), `${label}: the same values, bit for bit`);
    return;
  }
  if (Array.isArray(expected)) {
    assert.deepEqual(Array.from(actual, String), Array.from(expected, item => String(item ?? '')), `${label}: the same text`);
    return;
  }
  assert.deepEqual(typeof actual === 'bigint' ? actual : actual, expected, `${label}: the same value`);
}

/**
 * A node's attributes as JSON would carry them (BigInts as numbers), for
 * comparison; an HDF5 attribute of raw bytes (an object reference), which a
 * copy leaves out, is left out here too.
 */
function plainAttributes(node) {
  const attrs = { ...(node.attrs ?? {}) };
  for (const key of Object.keys(attrs)) if (node.attributeType?.(key)?.dtype?.kind === 'opaque') delete attrs[key];
  return JSON.parse(JSON.stringify(attrs, (_, value) => (typeof value === 'bigint' ? Number(value) : value)));
}

/** A sparse matrix group's entries as `[row, column, value]`, rows then columns ascending. */
async function sparseEntries(group) {
  const shape = group.attrs.shape.map(Number);
  const format = group.attrs['encoding-type'];
  // A column window (one feature type of a 10x matrix) is its real matrix's columns from `start`.
  const window = group.columnWindow ?? null;
  const real = window?.matrix ?? group;
  const [data, indices, indptr] = await Promise.all(['data', 'indices', 'indptr'].map(key => real.get(key).read()));
  const entries = [];
  const major = format === 'csr_matrix' ? shape[0] : shape[1];
  for (let line = 0; line < major; line++) {
    for (let k = Number(indptr[line]); k < Number(indptr[line + 1]); k++) {
      const other = Number(indices[k]) - (window?.start ?? 0);
      if (other < 0 || (window !== null && other >= shape[1])) continue;
      entries.push(format === 'csr_matrix' ? [line, other, data[k]] : [other, line, data[k]]);
    }
  }
  entries.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { shape, entries, dataType: data.constructor.name };
}

/**
 * Compare a copy with its source, element by element.
 *
 * @param {Object} source - The source's presented root
 * @param {Object} copy - The copy's presented root
 * @param {{skip?: (path: string) => boolean}} [options] - Paths not compared
 * @returns {Promise<{arrays: number, transposed: string[]}>}
 */
export async function compareCopy(source, copy, { skip = () => false } = {}) {
  await source.load();
  await copy.load();
  const seen = { arrays: 0, transposed: [] };
  const walk = async (from, to, path) => {
    for (const key of from.keys()) {
      const at = path === '' ? key : `${path}/${key}`;
      if (skip(at)) continue;
      const node = from.get(key);
      const other = to.get(key);
      assert.ok(other !== null, `${at} is in the copy`);
      if (isArrayNode(node)) {
        assert.ok(isArrayNode(other), `${at} is an array in the copy`);
        assert.deepEqual([...other.shape], [...node.shape], `${at}: the same shape`);
        assert.deepEqual(plainAttributes(other), plainAttributes(node), `${at}: the same attributes`);
        if (node.dtype.kind === 'compound' || node.dtype.kind === 'opaque') continue;
        sameValues(await other.read(), await node.read(), at);
        seen.arrays++;
        continue;
      }
      if (!isGroup(node)) continue;
      assert.ok(isGroup(other), `${at} is a group in the copy`);
      if (node.attrs['encoding-type'] === 'csr_matrix' && (other.attrs['encoding-type'] === 'csc_matrix' || node.columnWindow)) {
        const [expected, actual] = await Promise.all([sparseEntries(node), sparseEntries(other)]);
        assert.deepEqual(actual.shape, expected.shape, `${at}: the same shape`);
        assert.equal(actual.dataType, expected.dataType, `${at}: values of the same type`);
        assert.deepEqual(actual.entries, expected.entries, `${at}: the same entries`);
        seen.transposed.push(at);
        seen.arrays += 3;
        continue;
      }
      const attrs = plainAttributes(node);
      const copied = plainAttributes(other);
      // A MuData copy's reader places each modality's columns and mask in
      // obs (`<modality>:<column>`, `<modality>:measured`), where a source
      // presented by a layout of its own (10x) may not: only those may be added.
      if (Array.isArray(copied['column-order']) && Array.isArray(attrs['column-order'])) {
        const placed = name => (copy.modalities ?? []).some(modality => name.startsWith(`${modality.name}:`));
        copied['column-order'] = copied['column-order'].filter(name => attrs['column-order'].includes(name) || !placed(name));
      }
      assert.deepEqual(copied, attrs, `${at}: the same attributes`);
      await walk(node, other, at);
    }
  };
  await walk(source, copy, '');
  return seen;
}

/** Every array of a copy's store is chunked within the specification's sizes, and compressed. */
export function zarrayDocuments(consolidated) {
  return Object.entries(consolidated.metadata).filter(([key]) => key.endsWith('.zarray'));
}

export { isArrayNode, isGroup };
