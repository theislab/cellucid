/**
 * R files in the browser: `.rds` (one serialized object, `saveRDS`) and
 * `.rda`/`.RData` (`save()`: the magic `RDX2\n`/`RDX3\n`, then one stream
 * whose root is a pairlist of named objects), XDR serialization versions 2
 * and 3, compressed with gzip, bzip2 or xz or not at all.
 *
 * `readRFile` reads one file once from the start (`stream.js`), parsing it
 * as it arrives (`parse.js`); the caller's plan decides, for every vector,
 * whether its payload is kept, and its sink receives the kept payloads that
 * are large. An uncompressed file is read by ranges instead: a payload is
 * jumped over and referred to by its place in the file, so the file's
 * structure is all that is read (`region.store === 'file'`). A vector the
 * plan could decide on only after it went by (`dropByName`) and then kept is
 * read in a second pass over the stream, up to its place
 * (`readAgain`); one dropped is never stored.
 *
 * Nothing here knows about single-cell objects; `data/anndata/transcode`
 * does.
 *
 * @module formats/rds
 */

import { RdsFormatError } from './errors.js';
import { XdrReader } from './xdr.js';
import { hostValues, parseItem, readHeader } from './parse.js';
import { compressionOf, decompressed, rContainerOf, readInOrder } from './stream.js';

export { RdsFormatError, RdsUnsupportedError } from './errors.js';
export { NA_INTEGER, NULL_NODE, INLINE_ELEMENTS, SEXP, parseItem, readHeader, deferredStrings, formatRealAsR, hostValues } from './parse.js';
export { XdrReader } from './xdr.js';
export { compressionOf, decompressed, isUncompressed, rContainerOf, readInOrder } from './stream.js';
export { bunzip2 } from './bzip2.js';
export { unxz } from './xz.js';

/**
 * @typedef {Object} RFile
 * @property {'rds'|'rda'} container - One object, or `save()`'s named objects
 * @property {string[]} compressions - Taken off, outermost first (`[]`: none)
 * @property {boolean} random - Read by ranges (uncompressed): kept payloads
 *   are regions of the file
 * @property {{version: 2|3, writerVersion: string, minReaderVersion: string, nativeEncoding: string|null}} header
 * @property {Object} root - The parsed root (`parse.js` nodes); for `rda`, a
 *   pairlist whose tags name the objects
 */

/**
 * Read one R file.
 *
 * @param {{size: number, read: (offset: number, length: number, options?: Object) => Promise<Uint8Array>}} file
 *   A byte reader (`formats/io/byte-reader.js`) or anything with its `read`
 * @param {{plan?: import('./parse.js').RdsPlan, sink?: import('./parse.js').RdsSink|null,
 *          signal?: AbortSignal|null, activity?: Object|null,
 *          onBytes?: ((read: number) => void)|null, onProgress?: ((position: number) => void)|null,
 *          inlineElements?: number}} [options]
 *   `onBytes(n)`: the file's bytes read so far (a stream's pass);
 *   `onProgress(position)`: how far into the decompressed stream the parse is
 * @returns {Promise<RFile>}
 */
export async function readRFile(file, { plan = {}, sink = null, signal = null, activity = null, onBytes = null, onProgress = null, inlineElements } = {}) {
  if (!(file.size > 0)) throw new RdsFormatError('The R file is empty.');
  const head = await file.read(0, Math.min(16, file.size), { signal, activity });
  const outer = compressionOf(head);
  let reader;
  let container;
  let compressions = [];
  if (outer === 'none') {
    const kind = rContainerOf(head);
    if (kind === null) throw new RdsFormatError('This file is not an R file: it is neither compressed nor starts as saveRDS() or save() write.');
    container = kind.container;
    reader = XdrReader.ofRanges({
      size: file.size,
      read: (offset, length) => file.read(offset, length, { signal, activity }),
    }, { offset: kind.streamOffset });
    onBytes?.(file.size);
  } else {
    const unwrapped = await decompressed(readInOrder(file, { signal, activity, onBytes }), { signal, bytes: file.size });
    compressions = unwrapped.compressions;
    const kind = rContainerOf(unwrapped.head);
    if (kind === null) {
      throw new RdsFormatError(`This ${compressions[0]} file does not hold an R object: what it decompresses to starts as neither saveRDS() nor save() write.`);
    }
    container = kind.container;
    reader = XdrReader.ofStream(unwrapped.pieces);
    if (kind.streamOffset > 0) await reader.transfer(kind.streamOffset, null);
  }
  const header = await readHeader(reader);
  const root = await parseItem(reader, { plan, sink, nativeEncoding: header.nativeEncoding, signal, onProgress, inlineElements });
  if (container === 'rda' && root.kind !== 'pairlist') {
    throw new RdsFormatError('This save() file does not hold a list of named objects.');
  }
  await readAgain(file, rereadNodes(root), { sink, signal, activity, onBytes });
  return { container, compressions, random: reader.random, header, root };
}

/** Every node a pass left to `reread` and the plan kept, in stream order. */
function rereadNodes(root) {
  const found = [];
  const seen = new Set();
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (node.reread) found.push(node);
    for (const value of Object.values(node.attributes ?? {})) stack.push(value);
    for (const entry of node.items ?? []) stack.push(entry?.kind === undefined ? entry?.value : entry);
  }
  return found.sort((a, b) => a.reread.position - b.reread.position);
}

/**
 * Read the kept `reread` vectors in one more pass over the decompressed
 * stream, from its start to the last of them: each goes to the sink (a
 * `region`), or into memory without one (`values`).
 */
async function readAgain(file, nodes, { sink, signal, activity, onBytes }) {
  if (nodes.length === 0) return;
  const unwrapped = await decompressed(readInOrder(file, { signal, activity, onBytes }), { signal, bytes: file.size });
  const reader = XdrReader.ofStream(unwrapped.pieces);
  for (const node of nodes) {
    const { position, byteLength } = node.reread;
    await reader.transfer(position - reader.position, null);
    if (sink !== null) {
      const writer = await sink.open(byteLength, { path: [], kind: node.kind, length: node.length });
      await reader.transfer(byteLength, view => writer.write(view));
      node.region = await writer.close();
    } else {
      node.values = hostValues(node.kind, await reader.bytes(byteLength), node.length);
    }
    delete node.reread;
  }
  await unwrapped.pieces.return?.();
}

/**
 * The named objects of a `save()` file's root, in the order they were saved.
 *
 * @param {Object} root
 * @returns {Array<{name: string, value: Object}>}
 */
export function savedObjects(root) {
  if (root?.kind !== 'pairlist') return [];
  return root.items.filter(item => item.tag !== null).map(item => ({ name: item.tag, value: item.value }));
}
