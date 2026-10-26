/**
 * Version 2 B-trees ("BTHD" / "BTIN" / "BTLF").
 *
 * Newer-format files index dense groups' links (types 5, 6), dense
 * attributes (8, 9), huge fractal heap objects (1-4) and chunks of datasets
 * with more than one unlimited dimension (10, 11) with them. Every caller
 * here wants every record, so the whole tree is read level by level: all
 * nodes of one level are fetched together, one round trip per level.
 *
 * Records are handed to the caller as (bytes, offset) of the node they are
 * in, to decode straight into its own arrays without an object per record.
 *
 * @module formats/hdf5/btree-v2
 */

import { limitEncodedSize } from './binary.js';
import { formatError } from './errors.js';
import { formatCountOf } from '../../utils/format-units.js';

/** Size of a node's signature, version, type and checksum. */
const NODE_OVERHEAD = 10;

/**
 * Per-depth node geometry, as the library computes it (`H5B2__hdr_init`):
 * how many records a node at each depth holds and how many bytes encode the
 * record counts of its children.
 */
function nodeGeometry(nodeSize, recordSize, depth, offsetSize) {
  const leafMax = Math.floor((nodeSize - NODE_OVERHEAD) / recordSize);
  const countSize = limitEncodedSize(leafMax);
  const levels = [{ maxRecords: leafMax, cumulative: BigInt(leafMax), cumulativeSize: 0 }];
  for (let d = 1; d <= depth; d++) {
    const pointerSize = offsetSize + countSize + (d > 1 ? levels[d - 1].cumulativeSize : 0);
    const maxRecords = Math.floor((nodeSize - (NODE_OVERHEAD + pointerSize)) / (recordSize + pointerSize));
    if (maxRecords < 1) return null;
    const cumulative = BigInt(maxRecords + 1) * levels[d - 1].cumulative + BigInt(maxRecords);
    levels.push({ maxRecords, cumulative, cumulativeSize: limitEncodedSize(cumulative) });
  }
  return { countSize, levels };
}

/**
 * Read a v2 B-tree's header.
 *
 * @returns {Promise<{address: number, type: number, nodeSize: number, recordSize: number, depth: number, root: number|null, rootRecords: number, totalRecords: number}>}
 */
export async function readBtreeV2Header(file, address, signal) {
  const what = 'Version 2 B-tree header';
  const size = 4 + 1 + 1 + 4 + 2 + 2 + 1 + 1 + file.offsetSize + 2 + file.lengthSize + 4;
  const bytes = await file.meta(address, size, what, signal);
  const cursor = file.cursor(bytes, address, what);
  cursor.signature('BTHD');
  const version = cursor.u8();
  if (version !== 0) throw cursor.error(`version ${version} is unknown`);
  const type = cursor.u8();
  const nodeSize = cursor.u32();
  const recordSize = cursor.u16();
  const depth = cursor.u16();
  cursor.skip(2);
  const root = cursor.address();
  const rootRecords = cursor.u16();
  const totalRecords = cursor.length();
  file.checkChecksum(bytes, address, what);
  if (recordSize === 0 || nodeSize <= NODE_OVERHEAD + recordSize) {
    throw formatError(what, file.absolute(address), `node size ${nodeSize} cannot hold a ${recordSize}-byte record`);
  }
  return { address, type, nodeSize, recordSize, depth, root, rootRecords, totalRecords };
}

/**
 * Visit every record of the v2 B-tree at `address`.
 *
 * @param {import('./context.js').FileContext} file
 * @param {number} address
 * @param {(bytes: Uint8Array, offset: number, header: Object) => void} onRecord
 * @param {{signal?: AbortSignal|null, expectType?: number|number[], exact?: boolean}} [options]
 *   `exact`: read the nodes exactly, not as cached blocks (a chunk index,
 *   whose nodes lie among the chunks)
 * @returns {Promise<Object>} the header
 */
export async function walkBtreeV2(file, address, onRecord, { signal = null, expectType = null, exact = false } = {}) {
  const header = await readBtreeV2Header(file, address, signal);
  const expected = expectType === null ? null : [].concat(expectType);
  if (expected !== null && !expected.includes(header.type)) {
    throw formatError('Version 2 B-tree header', file.absolute(address),
      `it indexes records of type ${header.type}, not ${expected.join(' or ')}`);
  }
  if (header.root === null || header.totalRecords === 0) return header;
  const geometry = nodeGeometry(header.nodeSize, header.recordSize, header.depth, file.offsetSize);
  if (geometry === null) {
    throw formatError('Version 2 B-tree header', file.absolute(address), `a ${header.nodeSize}-byte node cannot hold depth ${header.depth}`);
  }
  let level = [{ address: header.root, records: header.rootRecords, depth: header.depth }];
  const seen = new Set();
  let visited = 0;
  while (level.length > 0) {
    for (const node of level) {
      if (seen.has(node.address)) {
        throw formatError('Version 2 B-tree node', file.absolute(node.address), 'it is reached twice; the tree is corrupt');
      }
      seen.add(node.address);
    }
    const nodes = await Promise.all(level.map(node => (exact ? file.dataUpTo(node.address, header.nodeSize, 'Version 2 B-tree node', signal)
      : file.metaUpTo(node.address, header.nodeSize, 'Version 2 B-tree node', signal))));
    const next = [];
    level.forEach((node, index) => {
      const bytes = nodes[index];
      const leaf = node.depth === 0;
      const what = leaf ? 'Version 2 B-tree leaf node' : 'Version 2 B-tree internal node';
      const cursor = file.cursor(bytes, node.address, what);
      cursor.signature(leaf ? 'BTLF' : 'BTIN');
      const version = cursor.u8();
      if (version !== 0) throw cursor.error(`version ${version} is unknown`);
      const type = cursor.u8();
      if (type !== header.type) throw cursor.error(`record type ${type} differs from the tree's type ${header.type}`);
      const limits = geometry.levels[node.depth];
      if (node.records > limits.maxRecords) {
        throw cursor.error(`it claims ${formatCountOf(node.records, 'record')}; a node at depth ${node.depth} holds at most ${limits.maxRecords}`);
      }
      const recordsStart = cursor.position;
      cursor.skip(node.records * header.recordSize);
      for (let i = 0; i < node.records; i++) onRecord(bytes, recordsStart + i * header.recordSize, header);
      visited += node.records;
      if (!leaf) {
        const totalSize = node.depth > 1 ? geometry.levels[node.depth - 1].cumulativeSize : 0;
        for (let i = 0; i <= node.records; i++) {
          const child = cursor.address();
          const records = cursor.uint(geometry.countSize);
          if (totalSize > 0) cursor.skip(totalSize);
          if (child === null) throw cursor.error(`child ${i} has an undefined address`);
          next.push({ address: child, records, depth: node.depth - 1 });
        }
      }
      file.checkChecksum(bytes.subarray(0, cursor.position + 4), node.address, what);
    });
    level = next;
  }
  if (visited !== header.totalRecords) {
    throw formatError('Version 2 B-tree header', file.absolute(address),
      `it declares ${formatCountOf(header.totalRecords, 'record')} but its nodes hold ${visited}`);
  }
  return header;
}
