/**
 * The grammar of R's serialization format (`src/main/serialize.c`,
 * `ReadItem`), versions 2 and 3, XDR: every item type R writes, read into a
 * small tree of plain records while the large payloads go wherever the
 * caller's plan says.
 *
 * Every item starts with a flags word: `type = flags & 0xFF`, the object bit
 * 1 << 8, has-attributes 1 << 9, has-tag 1 << 10, and the general-purpose
 * bits `flags >> 12` (string encodings; the S4 bit 1 << 4). Then, by type:
 *
 * - the singletons (`NULL`, the global, base and empty environments, the
 *   base namespace, the unbound value, the missing argument);
 * - a reference to an item read before (`REFSXP`: symbols, environments,
 *   namespaces, packages, external pointers and weak references enter the
 *   reference table as they are read; strings never do);
 * - pairlist-like nodes (pairlists, calls, closures, promises, `...`): an
 *   optional attribute list, an optional tag, the value, then the rest of the
 *   list as the next item (read in a loop, not by recursion);
 * - vectors: a length (`-1` and two more words for a long vector), then the
 *   elements (atomic payloads in one block; strings and lists item by item),
 *   then the attribute list after the payload;
 * - `S4SXP`: no payload, its slots are its attributes (a `NULL` slot is the
 *   symbol `\001NULL\001`);
 * - environments (registered before their contents), external pointers,
 *   weak references, builtins, byte code (`BCODESXP`, whose constant pool
 *   has its own small grammar and must be parsed to be passed over);
 * - `ALTREP_SXP`: a class (`compact_intseq`, `compact_realseq`,
 *   `deferred_string`, `wrap_*`), its serialized state and attributes,
 *   expanded here to the vector it stands for.
 *
 * **The plan.** The caller says, for each atomic vector as soon as its type,
 * length and place in the object are known (before its payload), whether it
 * is kept or skipped; and for each subtree whether it is kept at all. A
 * skipped payload is consumed (or, over a file read by ranges, jumped over)
 * without being stored; a kept payload larger than `inlineElements` goes to
 * the caller's sink as it streams (or, over ranges, is referred to by its
 * place in the file), and never becomes one JavaScript array. Smaller ones
 * are decoded into typed arrays in host byte order.
 *
 * The place of an item is its path from the root: `@slot` for an attribute
 * (S4 slots are attributes), `$tag` for a pairlist element, `[i]` for a list
 * element. A list's names are its attribute, which comes after its elements,
 * so a plan sees a list element by index; the tree it returns carries the
 * names. A plan that drops list elements by name (`dropByName`, a Seurat v5
 * assay's `scale.data` layer) has the large vectors of that list passed over
 * while the stream goes by (a node with `reread: {position,
 * byteLength}`, its place in the decompressed stream), so a dropped one is never
 * stored; one that is kept is read again afterwards (`readRFile`), and
 * anything else a dropped element held in the sink is released when the
 * names arrive.
 *
 * Nodes (`kind`):
 *
 * - `null`; `symbol` `{name}`;
 * - `logical`, `integer` (`Int32Array`, NA = -2^31), `double`
 *   (`Float64Array`), `complex`, `raw`: `{length, values, region, sequence}`
 *   — `values` when kept in memory, `region` (`{store, offset, byteLength}`,
 *   big-endian elements) when kept in a sink or in the file, `sequence`
 *   (`{start, step}`) for a compact sequence, all null when skipped (or
 *   `reread`, above, until `readRFile` reads it again);
 * - `string`: `{length, values}` (`string|null` per element, null for NA);
 * - `list` (also R expression vectors): `{items}`; `pairlist`: `{items:
 *   [{tag, value}]}`;
 * - `S4`; `environment`; `opaque` `{what}` (closures, calls, promises, byte
 *   code, builtins, external pointers, weak references: parsed and passed
 *   over); `altrep` `{className, packageName}` for an ALTREP class this
 *   reader does not expand; `skipped` for an item inside one the plan
 *   dropped, and for the dropped item itself `{bytes, empty}` (the bytes it
 *   spanned; whether it held nothing).
 *
 * Every node but `null`/`symbol` has `attributes` (a null-prototype record
 * by name, or null), and `s4` (the S4 bit).
 *
 * @module formats/rds/parse
 */

import { RdsFormatError, RdsUnsupportedError } from './errors.js';
import { formatCountOf } from '../../utils/format-units.js';

/** SEXP types (`Rinternals.h`) and serialization pseudo-types (`serialize.c`). */
export const SEXP = Object.freeze({
  NIL: 0, SYM: 1, LIST: 2, CLO: 3, ENV: 4, PROM: 5, LANG: 6, SPECIAL: 7, BUILTIN: 8,
  CHAR: 9, LGL: 10, INT: 13, REAL: 14, CPLX: 15, STR: 16, DOT: 17, ANY: 18, VEC: 19,
  EXPR: 20, BCODE: 21, EXTPTR: 22, WEAKREF: 23, RAW: 24, S4: 25,
  REF: 255, NILVALUE: 254, GLOBALENV: 253, UNBOUNDVALUE: 252, MISSINGARG: 251,
  BASENAMESPACE: 250, NAMESPACE: 249, PACKAGE: 248, PERSIST: 247, CLASSREF: 246,
  GENERICREF: 245, BCREPDEF: 244, BCREPREF: 243, EMPTYENV: 242, BASEENV: 241,
  ATTRLANG: 240, ATTRLIST: 239, ALTREP: 238,
});

const IS_OBJECT = 1 << 8;
const HAS_ATTR = 1 << 9;
const HAS_TAG = 1 << 10;
const UTF8_MASK = 1 << 3;
const LATIN1_MASK = 1 << 2;
const BYTES_MASK = 1 << 1;
const ASCII_MASK = 1 << 6;
const S4_MASK = 1 << 4;

/** R's integer NA. */
export const NA_INTEGER = -2147483648;

/** Elements of a kept atomic vector above which it goes to the sink, not memory. */
export const INLINE_ELEMENTS = 65536;

const ATOMIC = new Map([
  [SEXP.LGL, { kind: 'logical', width: 4 }],
  [SEXP.INT, { kind: 'integer', width: 4 }],
  [SEXP.REAL, { kind: 'double', width: 8 }],
  [SEXP.CPLX, { kind: 'complex', width: 16 }],
  [SEXP.RAW, { kind: 'raw', width: 1 }],
]);

const PAIRLIKE = new Map([
  [SEXP.LIST, 'pairlist'], [SEXP.LANG, 'call'], [SEXP.CLO, 'closure'],
  [SEXP.PROM, 'promise'], [SEXP.DOT, 'dots'],
]);

export const NULL_NODE = Object.freeze({ kind: 'null', attributes: null });
const SKIPPED = Object.freeze({ kind: 'skipped', attributes: null });

/** The singletons, by pseudo-type: what each stands for. */
const SINGLETONS = new Map([
  [SEXP.NILVALUE, NULL_NODE],
  [SEXP.NIL, NULL_NODE],
  [SEXP.GLOBALENV, Object.freeze({ kind: 'environment', name: 'global', attributes: null })],
  [SEXP.EMPTYENV, Object.freeze({ kind: 'environment', name: 'empty', attributes: null })],
  [SEXP.BASEENV, Object.freeze({ kind: 'environment', name: 'base', attributes: null })],
  [SEXP.BASENAMESPACE, Object.freeze({ kind: 'environment', name: 'namespace:base', attributes: null })],
  [SEXP.UNBOUNDVALUE, Object.freeze({ kind: 'opaque', what: 'unbound value', attributes: null })],
  [SEXP.MISSINGARG, Object.freeze({ kind: 'opaque', what: 'missing argument', attributes: null })],
]);

/**
 * A big-endian payload as host-order typed values (`raw`: the bytes;
 * `double`, `complex`: float64; the rest int32), swapped word by word.
 * Bytes the caller gives up (`owned`, a fresh array such as a region read
 * back) are swapped in place; others (a view of the stream) are copied
 * first.
 *
 * @param {string} kind
 * @param {Uint8Array} bytes
 * @param {number} length - Elements (complex: values, each two float64)
 * @param {boolean} [owned=false]
 * @returns {Uint8Array|Int32Array|Float64Array}
 */
export function hostValues(kind, bytes, length, owned = false) {
  let copy = bytes;
  if (!owned || bytes.byteOffset % 8 !== 0) {
    copy = new Uint8Array(bytes.length);
    copy.set(bytes);
  }
  if (kind === 'raw') return copy;
  const words = new Uint32Array(copy.buffer, copy.byteOffset, copy.byteLength >>> 2);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    words[i] = ((w & 0xff) << 24) | ((w & 0xff00) << 8) | ((w >>> 8) & 0xff00) | (w >>> 24);
  }
  if (kind === 'double' || kind === 'complex') {
    // Each 8-byte value's two words also trade places.
    for (let i = 0; i < words.length; i += 2) {
      const high = words[i];
      words[i] = words[i + 1];
      words[i + 1] = high;
    }
    return new Float64Array(copy.buffer, copy.byteOffset, kind === 'double' ? length : length * 2);
  }
  return new Int32Array(copy.buffer, copy.byteOffset, length);
}

const UTF8 = new TextDecoder('utf-8');
const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });
const LATIN1 = new TextDecoder('windows-1252');

/** A TextDecoder for an encoding as R names it (`UTF-8`, `CP1252`, `latin1`), or null. */
function decoderOf(name) {
  if (typeof name !== 'string' || name === '') return null;
  const label = name.trim().toLowerCase().replace(/^cp(\d+)$/, 'windows-$1');
  if (label === 'utf-8' || label === 'utf8') return UTF8;
  try {
    return new TextDecoder(label);
  } catch {
    return null;
  }
}

function isAscii(bytes) {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] > 0x7f) return false;
  return true;
}

function asciiString(bytes) {
  if (bytes.length <= 1024) return String.fromCharCode.apply(null, bytes);
  return LATIN1.decode(bytes);
}

/**
 * The stream header: `X\n`, version, writer and minimum reader version, and
 * (version 3) the native encoding of the writer.
 *
 * @param {import('./xdr.js').XdrReader} reader
 * @returns {Promise<{version: 2|3, writerVersion: string, minReaderVersion: string, nativeEncoding: string|null}>}
 */
export async function readHeader(reader) {
  const magic = await reader.bytes(2);
  const kind = String.fromCharCode(magic[0], magic[1]);
  if (kind === 'A\n') {
    throw new RdsUnsupportedError(
      'ASCII serialization',
      'This R file was saved as text (saveRDS(ascii = TRUE)), which Cellucid does not read. Save it again with saveRDS(object, file).'
    );
  }
  if (kind === 'B\n') {
    throw new RdsUnsupportedError(
      'native binary serialization',
      "This R file was saved in R's native binary form (xdr = FALSE), which Cellucid does not read. Save it again with saveRDS(object, file)."
    );
  }
  if (kind !== 'X\n') throw new RdsFormatError('This is not an R serialization stream (it does not start with X\\n).');
  const version = await reader.int();
  if (version !== 2 && version !== 3) {
    throw new RdsUnsupportedError(
      `serialization version ${version}`,
      `This R file uses serialization version ${version}; Cellucid reads versions 2 and 3. Save it again with saveRDS(object, file, version = 3).`
    );
  }
  const releaseOf = value => `${value >>> 16}.${(value >>> 8) & 0xff}.${value & 0xff}`;
  const writerVersion = releaseOf(await reader.int());
  const minReaderVersion = releaseOf(await reader.int());
  let nativeEncoding = null;
  if (version === 3) {
    const length = await reader.int();
    if (length < 0 || length > 64) throw new RdsFormatError(`The stream header names an encoding of ${formatCountOf(length, 'byte')}.`);
    nativeEncoding = asciiString(await reader.bytes(length));
  }
  return { version, writerVersion, minReaderVersion, nativeEncoding };
}

/**
 * @typedef {Object} RdsPlan
 * @property {(path: string[], node: {type: string, length: number}) => 'keep'|'skip'} [vector] -
 *   Whether a kept subtree's atomic vector is kept (default `keep`)
 * @property {(path: string[]) => boolean} [drop] - Whether the item at
 *   `path` is passed over without keeping anything of it (default never)
 * @property {(path: string[]) => (((name: string) => boolean)|null)} [dropByName] -
 *   For the list at `path`, which of its elements are dropped by their name
 *   (null: none); called when the list starts, the predicate when its names
 *   arrive after its elements. A dropped element becomes a `skipped` node.
 */

/**
 * @typedef {Object} RdsSink
 * @property {(byteLength: number|null, info: {path: string[], kind: string, length: number}) => {write: (view: Uint8Array) => (void|Promise<void>), close: () => (Object|Promise<Object>)}} open -
 *   A writer for one kept payload of `byteLength` bytes (null: not known
 *   yet); `close()` resolves to its store handle
 * @property {(region: Object) => (void|Promise<void>)} [release] - Give back
 *   a payload a plan dropped by name after it was written (`dropByName`)
 */

/**
 * Read one serialized R object (after the header).
 *
 * @param {import('./xdr.js').XdrReader} reader
 * @param {{plan?: RdsPlan, sink?: RdsSink|null, inlineElements?: number,
 *          nativeEncoding?: string|null, signal?: AbortSignal|null,
 *          onProgress?: ((position: number) => void)|null}} [options]
 *   `sink`: where kept payloads larger than `inlineElements` go in stream
 *   mode (over ranges they are referred to in the file, `store: 'file'`);
 *   without one they are kept in memory.
 * @returns {Promise<Object>} The root node
 */
export async function parseItem(reader, {
  plan = {},
  sink = null,
  inlineElements = INLINE_ELEMENTS,
  nativeEncoding = null,
  signal = null,
  onProgress = null,
} = {}) {
  const refs = [];
  const path = [];
  const native = decoderOf(nativeEncoding);
  const wantVector = typeof plan.vector === 'function' ? plan.vector : () => 'keep';
  const wantDrop = typeof plan.drop === 'function' ? plan.drop : () => false;
  const dropsByName = typeof plan.dropByName === 'function' ? plan.dropByName : () => null;
  /** Depth of dropped subtrees around the item being read. */
  let dropping = 0;
  /**
   * The path length of a list element whose fate waits for the list's names
   * (`dropByName`): a large vector there is passed over while it streams
   * and read again only if kept (`reread`).
   */
  let awaitingName = -1;
  let items = 0;
  /** Elements of the vectors passed over inside dropped items (`countDropped`). */
  let droppedElements = 0;
  /** Whether the item being read is a plain attribute (not an S4 slot). */
  let inPlainAttributes = false;

  const slot = () => (path.length === 0 ? '<root>' : path.join(''));
  const fail = message => new RdsFormatError(message, { slot: slot() });

  function decodeChars(bytes, levels) {
    if (levels & ASCII_MASK) return asciiString(bytes);
    if (isAscii(bytes)) return asciiString(bytes);
    if (levels & UTF8_MASK) return UTF8.decode(bytes);
    if (levels & (LATIN1_MASK | BYTES_MASK)) return LATIN1.decode(bytes);
    if (native !== null) return native.decode(bytes);
    // A version-2 stream names no encoding: UTF-8 when it is valid UTF-8,
    // else the Windows Latin-1 R wrote on that platform.
    try {
      return UTF8_STRICT.decode(bytes);
    } catch {
      return LATIN1.decode(bytes);
    }
  }

  async function readLength() {
    const length = await reader.int();
    if (length >= 0) return length;
    if (length !== -1) throw fail(`A vector declares the length ${length}.`);
    const high = await reader.int();
    const low = await reader.int();
    return (high >>> 0) * 2 ** 32 + (low >>> 0);
  }

  async function readItem() {
    const flags = await reader.int();
    return readWith(flags);
  }

  /**
   * An item the plan drops: passed over, keeping only what it was — how
   * many bytes of the stream it spanned, and whether it held nothing (NULL,
   * or a vector or list of length 0), so a caller can say what was left out.
   */
  async function readDropped() {
    const from = reader.position;
    const elementsBefore = droppedElements;
    dropping++;
    try {
      await readItem();
    } finally {
      dropping--;
    }
    return Object.freeze({
      kind: 'skipped',
      attributes: null,
      bytes: reader.position - from,
      empty: droppedElements === elementsBefore,
    });
  }

  /**
   * Count the elements of a vector passed over inside a dropped item. What
   * describes a value rather than holding it is not counted: plain
   * attributes (`dim`, `names`, `class`) and an S4 object's class, so an
   * empty matrix, an empty list or an S4 object whose slots are all empty
   * counts nothing.
   */
  function countDropped(length) {
    if (dropping > 0 && !inPlainAttributes && length > 0 && path[path.length - 1] !== '@class') {
      droppedElements += length;
    }
  }

  /** A CHARSXP's text (null for NA), read after its flags. */
  async function readChars(flags, keep = dropping === 0) {
    const length = await reader.int();
    let text;
    if (length === -1) text = null;
    else if (length < 0) throw fail(`A string declares the length ${length}.`);
    else if (!keep) {
      await reader.transfer(length, null);
      text = null;
    } else {
      text = decodeChars(await reader.bytes(length), flags >> 12);
    }
    // Old writers gave strings attributes; they are read and dropped.
    if (flags & HAS_ATTR) await readItem();
    return text;
  }

  /** A STRSXP's elements: a run of CHARSXPs read without a promise each while they are buffered. */
  async function readStrings(length) {
    const values = dropping > 0 ? null : new Array(length);
    for (let index = 0; index < length; index++) {
      if (reader.available >= 8) {
        const flags = reader.view.getInt32(reader.pos, false);
        const count = reader.view.getInt32(reader.pos + 4, false);
        if ((flags & 0xff) === SEXP.CHAR && !(flags & HAS_ATTR)) {
          if (count === -1) {
            reader.pos += 8;
            if (values !== null) values[index] = null;
            continue;
          }
          if (count >= 0 && reader.available >= 8 + count) {
            reader.pos += 8;
            if (values !== null) {
              const bytes = reader.buf.subarray(reader.pos, reader.pos + count);
              values[index] = (flags >> 12) & ASCII_MASK ? asciiString(bytes) : decodeChars(bytes, flags >> 12);
            }
            reader.pos += count;
            continue;
          }
        }
      }
      const flags = await reader.int();
      if ((flags & 0xff) !== SEXP.CHAR) throw fail(`A character vector holds an item of type ${flags & 0xff}, not a string.`);
      const text = await readChars(flags);
      if (values !== null) values[index] = text;
    }
    return values;
  }

  /**
   * An attribute pairlist as a record by name, each attribute read with
   * `@name` on the path (an S4 object's slots are its attributes).
   */
  async function readAttributes(ownerFlags) {
    const outer = inPlainAttributes;
    inPlainAttributes = ((ownerFlags >> 12) & S4_MASK) === 0;
    let node;
    try {
      const flags = await reader.int();
      node = (flags & 0xff) === SEXP.LIST ? await readPairlike(flags, '@') : await readWith(flags);
    } finally {
      inPlainAttributes = outer;
    }
    if (node.kind === 'null' || node.kind === 'skipped') return null;
    if (node.kind !== 'pairlist') throw fail(`An attribute list is a ${node.kind}, not a pairlist.`);
    const record = Object.create(null);
    for (const { tag, value } of node.items) if (tag !== null) record[tag] = value;
    return record;
  }

  function tagName(node) {
    if (node === null) return null;
    if (node.kind === 'symbol') return node.name;
    if (node.kind === 'string') return node.values?.[0] ?? null;
    return null;
  }

  async function readPairlike(flags, prefix = '$') {
    const type = flags & 0xff;
    const what = PAIRLIKE.get(type);
    // Closures, calls, promises and `...` are code: read, never kept.
    const opaque = what !== 'pairlist';
    if (opaque) dropping++;
    const elements = [];
    let attributes = null;
    let first = true;
    let current = flags;
    try {
      for (;;) {
        const currentType = current & 0xff;
        if (!PAIRLIKE.has(currentType)) {
          // A dotted pair's last CDR: kept as one more element.
          const tail = await readWith(current);
          if (tail.kind !== 'null') elements.push({ tag: null, value: tail });
          break;
        }
        let nodeAttributes = null;
        if (current & HAS_ATTR) nodeAttributes = await readAttributes(current);
        if (first) attributes = nodeAttributes;
        first = false;
        const tag = current & HAS_TAG ? tagName(await readItem()) : null;
        path.push(tag === null ? `[${elements.length}]` : `${prefix}${tag}`);
        let value;
        try {
          if (dropping === 0 && wantDrop(path)) {
            value = await readDropped();
          } else {
            value = await readItem();
          }
        } finally {
          path.pop();
        }
        elements.push({ tag, value });
        current = await reader.int();
        if ((current & 0xff) === SEXP.NILVALUE) break;
      }
    } finally {
      if (opaque) dropping--;
    }
    if (opaque || dropping > 0) return opaque ? { kind: 'opaque', what, attributes: null, s4: false } : SKIPPED;
    return { kind: 'pairlist', items: elements, attributes, s4: false };
  }

  /**
   * A `wrap_*` ALTREP's state, `list(x, meta)`: `x` is read in the wrapper's
   * own place (a plan sees the wrapped vector where the wrapper is).
   */
  async function readWrapState() {
    const flags = await reader.int();
    if ((flags & 0xff) !== SEXP.VEC) return readWith(flags);
    const length = await readLength();
    let wrapped = null;
    for (let index = 0; index < length; index++) {
      const value = await readItem();
      if (index === 0) wrapped = value;
    }
    if (flags & HAS_ATTR) await readAttributes(flags);
    return wrapped;
  }

  /** The vector an ALTREP item stands for. */
  async function readAltrep(flags) {
    const info = await readItemKeeping();
    const classSymbol = info.kind === 'pairlist' ? info.items[0]?.value : null;
    const packageSymbol = info.kind === 'pairlist' ? info.items[1]?.value : null;
    const className = classSymbol?.kind === 'symbol' ? classSymbol.name : null;
    const packageName = packageSymbol?.kind === 'symbol' ? packageSymbol.name : null;
    if (className === null) throw fail('An ALTREP item names no class.');
    const state = className.startsWith('wrap_') ? await readWrapState() : await readItem();
    const attributesFlags = await reader.int();
    const attributesNode = (attributesFlags & 0xff) === SEXP.LIST
      ? await readPairlike(attributesFlags, '@')
      : await readWith(attributesFlags);
    if (dropping > 0) return SKIPPED;
    const attributes = attributesNode.kind === 'pairlist'
      ? Object.assign(Object.create(null), Object.fromEntries(attributesNode.items.filter(item => item.tag !== null).map(item => [item.tag, item.value])))
      : null;
    const s4 = ((flags >> 12) & S4_MASK) !== 0;
    switch (className) {
      case 'compact_intseq':
      case 'compact_realseq': {
        const kind = className === 'compact_intseq' ? 'integer' : 'double';
        const numbers = state.values ?? null;
        if (numbers === null) return { kind, length: 0, values: null, region: null, sequence: null, attributes, s4, skipped: true };
        if (numbers.length < 3) throw fail(`A ${className} has no length, start and step.`);
        const length = Number(numbers[0]);
        const start = Number(numbers[1]);
        const step = Number(numbers[2]);
        let values = null;
        if (length <= inlineElements && wantVector(path, { type: kind, length }) !== 'skip') {
          values = kind === 'integer' ? new Int32Array(length) : new Float64Array(length);
          for (let i = 0; i < length; i++) values[i] = start + i * step;
        }
        return { kind, length, values, region: null, sequence: { start, step }, attributes, s4, skipped: false };
      }
      case 'deferred_string': {
        // The state is (the numbers, the formatting setting): the strings are
        // what as.character() makes of the numbers.
        const argument = state.kind === 'pairlist' ? state.items[0]?.value : state;
        const length = argument?.length ?? 0;
        return { kind: 'string', length, values: deferredStrings(argument), deferred: argument, attributes, s4 };
      }
      case 'wrap_integer':
      case 'wrap_real':
      case 'wrap_logical':
      case 'wrap_string':
      case 'wrap_complex':
      case 'wrap_raw':
      case 'wrap_list':
        if (state === null || state === undefined) throw fail(`A ${className} wraps nothing.`);
        return attributes === null ? state : { ...state, attributes, s4 };
      default:
        return { kind: 'altrep', className, packageName, attributes, s4 };
    }
  }

  /** One item read and kept even inside a dropped subtree (an ALTREP class name). */
  async function readItemKeeping() {
    const outer = dropping;
    dropping = 0;
    try {
      return await readItem();
    } finally {
      dropping = outer;
    }
  }

  async function readAtomic(type, flags) {
    const { kind, width } = ATOMIC.get(type);
    const length = await readLength();
    countDropped(length);
    const byteLength = length * width;
    let decision = 'skip';
    if (dropping === 0) decision = wantVector(path, { type: kind, length }) === 'skip' ? 'skip' : 'keep';
    let values = null;
    let region = null;
    let reread = null;
    if (decision === 'skip') {
      await reader.transfer(byteLength, null);
    } else if (length <= inlineElements) {
      values = hostValues(kind, await reader.bytes(byteLength), length);
    } else if (reader.random) {
      region = { store: 'file', offset: reader.position, byteLength };
      await reader.transfer(byteLength, null);
    } else if (awaitingName === path.length) {
      // A list element whose fate waits for the list's names: passed over
      // now, and read again only if it is kept (`readRFile`).
      reread = { position: reader.position, byteLength };
      await reader.transfer(byteLength, null);
    } else if (sink !== null) {
      const writer = await sink.open(byteLength, { path: [...path], kind, length });
      await reader.transfer(byteLength, view => writer.write(view));
      region = await writer.close();
    } else {
      values = hostValues(kind, await reader.bytes(byteLength), length);
    }
    const attributes = flags & HAS_ATTR ? await readAttributes(flags) : null;
    if (dropping > 0) return SKIPPED;
    const node = { kind, length, values, region, sequence: null, attributes, s4: ((flags >> 12) & S4_MASK) !== 0, skipped: decision === 'skip' };
    if (reread !== null) node.reread = reread;
    return node;
  }

  /** Whether a node holds any values (not counting plain attributes such as `dim` or `names`). */
  function holdsValues(node, seen = new Set()) {
    if (node === null || typeof node !== 'object' || seen.has(node)) return false;
    seen.add(node);
    if (node.kind === 'list') return (node.items ?? []).some(entry => holdsValues(entry, seen));
    if (node.kind === 'pairlist') return (node.items ?? []).some(entry => holdsValues(entry.value, seen));
    if (node.kind === 'S4') {
      return Object.entries(node.attributes ?? {}).some(([name, value]) => name !== 'class' && holdsValues(value, seen));
    }
    return typeof node.length === 'number' && node.length > 0;
  }

  /** Release every sink payload a dropped node holds. */
  async function releaseHeld(node, seen = new Set()) {
    if (node === null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (node.region && node.region.store !== 'file') await sink?.release?.(node.region);
    for (const value of Object.values(node.attributes ?? {})) await releaseHeld(value, seen);
    for (const entry of node.items ?? []) await releaseHeld(entry?.kind === undefined ? entry?.value : entry, seen);
  }

  /**
   * A list read for `dropByName`, once its names are known: the dropped
   * elements become `skipped` nodes (what they hold in the sink released);
   * a kept element passed over while it streamed keeps its `reread` place.
   */
  async function settleNamed(node, byName, spans) {
    const names = node.attributes?.names?.values ?? null;
    for (let index = 0; index < node.items.length; index++) {
      const element = node.items[index];
      const name = names?.[index] ?? null;
      if (name !== null && byName(name)) {
        await releaseHeld(element);
        node.items[index] = Object.freeze({
          kind: 'skipped', attributes: null, bytes: spans[index], empty: !holdsValues(element),
        });
      }
    }
  }

  async function readBytecode() {
    const reps = new Array(Math.max(0, await reader.int()));
    dropping++;
    try {
      await readBytecodeOne(reps);
    } finally {
      dropping--;
    }
  }

  async function readBytecodeOne(reps) {
    await readItem();
    const count = await reader.int();
    for (let index = 0; index < count; index++) {
      const type = await reader.int();
      if (type === SEXP.BCODE) await readBytecodeOne(reps);
      else if (type === SEXP.LANG || type === SEXP.LIST || type === SEXP.BCREPDEF ||
               type === SEXP.BCREPREF || type === SEXP.ATTRLANG || type === SEXP.ATTRLIST) {
        await readBytecodeLanguage(type, reps);
      } else {
        await readItem();
      }
    }
  }

  async function readBytecodeLanguage(type, reps) {
    if (type === SEXP.BCREPREF) {
      await reader.int();
      return;
    }
    if (type === SEXP.BCREPDEF || type === SEXP.LANG || type === SEXP.LIST ||
        type === SEXP.ATTRLANG || type === SEXP.ATTRLIST) {
      let kind = type;
      if (kind === SEXP.BCREPDEF) {
        await reader.int();
        kind = await reader.int();
      }
      if (kind === SEXP.ATTRLANG || kind === SEXP.ATTRLIST) await readItem();
      await readItem();
      await readBytecodeLanguage(await reader.int(), reps);
      await readBytecodeLanguage(await reader.int(), reps);
      return;
    }
    await readItem();
  }

  async function readStringList() {
    if ((await reader.int()) !== 0) throw fail('A namespace or package name list does not start with 0.');
    const length = await reader.int();
    if (length < 0) throw fail(`A name list declares the length ${length}.`);
    const values = [];
    for (let i = 0; i < length; i++) {
      const item = await readItem();
      values.push(item.kind === 'string' ? item.values?.[0] ?? null : null);
    }
    return values;
  }

  async function readWith(flags) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('The read was aborted.', 'AbortError');
    if ((++items & 0x3fff) === 0) onProgress?.(reader.position);
    const type = flags & 0xff;
    const singleton = SINGLETONS.get(type);
    if (singleton !== undefined) return singleton;
    switch (type) {
      case SEXP.REF: {
        let index = flags >>> 8;
        if (index === 0) index = await reader.int();
        const target = refs[index - 1];
        if (target === undefined) throw fail(`A reference to item ${index} of ${refs.length} read so far.`);
        return target;
      }
      case SEXP.PERSIST: {
        const names = await readStringList();
        const node = { kind: 'opaque', what: 'persistent reference', names, attributes: null };
        refs.push(node);
        return node;
      }
      case SEXP.SYM: {
        const nameFlags = await reader.int();
        let name = null;
        if ((nameFlags & 0xff) === SEXP.CHAR) {
          // A symbol's name is kept even inside a dropped subtree: a later
          // reference may name a slot with it.
          name = await readChars(nameFlags, true);
        } else {
          await readWith(nameFlags);
        }
        const node = Object.freeze({ kind: 'symbol', name: name ?? '', attributes: null });
        refs.push(node);
        return node;
      }
      case SEXP.PACKAGE:
      case SEXP.NAMESPACE: {
        const node = { kind: 'environment', name: `${type === SEXP.NAMESPACE ? 'namespace' : 'package'}:${(await readStringList()).join(' ')}`, attributes: null };
        refs.push(node);
        return node;
      }
      case SEXP.ENV: {
        await reader.int();
        const node = { kind: 'environment', name: null, attributes: null };
        refs.push(node);
        dropping++;
        try {
          for (let i = 0; i < 4; i++) await readItem();
        } finally {
          dropping--;
        }
        return node;
      }
      case SEXP.LIST:
      case SEXP.LANG:
      case SEXP.CLO:
      case SEXP.PROM:
      case SEXP.DOT:
        return readPairlike(flags);
      case SEXP.ALTREP:
        return readAltrep(flags);
      case SEXP.CLASSREF:
      case SEXP.GENERICREF:
        throw fail('This R file holds a class or generic reference, which R itself no longer reads.');
      default:
        break;
    }
    let node;
    /** A list some of whose elements the plan drops by name, and the bytes each element spanned. */
    let byName = null;
    let spans = null;
    if (ATOMIC.has(type)) return readAtomic(type, flags);
    switch (type) {
      case SEXP.EXTPTR: {
        node = { kind: 'opaque', what: 'external pointer', attributes: null, s4: false };
        refs.push(node);
        dropping++;
        try {
          await readItem();
          await readItem();
        } finally {
          dropping--;
        }
        break;
      }
      case SEXP.WEAKREF:
        node = { kind: 'opaque', what: 'weak reference', attributes: null, s4: false };
        refs.push(node);
        break;
      case SEXP.SPECIAL:
      case SEXP.BUILTIN: {
        const length = await reader.int();
        if (length < 0) throw fail(`A builtin declares a name of ${formatCountOf(length, 'byte')}.`);
        await reader.transfer(length, null);
        node = { kind: 'opaque', what: 'builtin', attributes: null, s4: false };
        break;
      }
      case SEXP.CHAR: {
        const text = await readChars(flags);
        return dropping > 0 ? SKIPPED : { kind: 'string', length: 1, values: [text], attributes: null, s4: false };
      }
      case SEXP.STR: {
        const length = await readLength();
        countDropped(length);
        const values = await readStrings(length);
        node = { kind: 'string', length, values, attributes: null, s4: false };
        break;
      }
      case SEXP.VEC:
      case SEXP.EXPR: {
        const length = await readLength();
        countDropped(length);
        const elements = dropping > 0 ? null : [];
        byName = dropping > 0 ? null : dropsByName(path);
        spans = byName === null ? null : new Float64Array(length);
        const outerAwaiting = awaitingName;
        for (let index = 0; index < length; index++) {
          path.push(`[${index}]`);
          const from = reader.position;
          awaitingName = byName === null ? -1 : path.length;
          try {
            if (dropping === 0 && wantDrop(path)) {
              elements.push(await readDropped());
            } else {
              const value = await readItem();
              elements?.push(value);
            }
          } finally {
            awaitingName = outerAwaiting;
            path.pop();
          }
          if (spans !== null) spans[index] = reader.position - from;
        }
        node = { kind: 'list', items: elements, attributes: null, s4: false };
        break;
      }
      case SEXP.BCODE:
        await readBytecode();
        node = { kind: 'opaque', what: 'byte code', attributes: null, s4: false };
        break;
      case SEXP.S4:
        node = { kind: 'S4', attributes: null, s4: true };
        break;
      default:
        throw fail(`An item of unknown type ${type}: the file is damaged, or was written by a newer R.`);
    }
    if (flags & HAS_ATTR) {
      const attributes = await readAttributes(flags);
      if (node.kind !== 'opaque') node.attributes = attributes;
    }
    if (dropping > 0) return SKIPPED;
    if (byName !== null) await settleNamed(node, byName, spans);
    node.s4 = node.s4 || ((flags >> 12) & S4_MASK) !== 0;
    node.object = (flags & IS_OBJECT) !== 0;
    return node;
  }

  const root = await readItem();
  onProgress?.(reader.position);
  return root;
}

/**
 * What `as.character()` makes of the numbers a deferred string holds.
 * Integers print as decimal integers; doubles with up to 15 significant
 * digits, as R prints them.
 *
 * @param {Object|null} argument
 * @returns {Array<string|null>|null}
 */
export function deferredStrings(argument) {
  let values = argument?.values;
  if ((values === null || values === undefined) && argument?.sequence) {
    const { start, step } = argument.sequence;
    values = Array.from({ length: argument.length }, (_, i) => start + i * step);
  }
  if (values === null || values === undefined) return null;
  const out = new Array(values.length);
  if (argument.kind === 'integer' || argument.kind === 'logical') {
    for (let i = 0; i < values.length; i++) out[i] = values[i] === NA_INTEGER ? null : String(values[i]);
    return out;
  }
  for (let i = 0; i < values.length; i++) out[i] = formatRealAsR(values[i]);
  return out;
}

/** A double as `as.character()` writes it (15 significant digits). */
export function formatRealAsR(value) {
  if (Number.isNaN(value)) return null;
  if (value === Infinity) return 'Inf';
  if (value === -Infinity) return '-Inf';
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  const text = value.toPrecision(15);
  if (text.includes('e')) {
    const [mantissa, exponent] = text.split('e');
    const trimmed = mantissa.includes('.') ? mantissa.replace(/0+$/, '').replace(/\.$/, '') : mantissa;
    const power = Number(exponent);
    return `${trimmed}e${power < 0 ? '-' : '+'}${String(Math.abs(power)).padStart(2, '0')}`;
  }
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}
