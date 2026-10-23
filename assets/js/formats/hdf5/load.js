/**
 * Loading a file's whole object tree at open.
 *
 * Every object (group, dataset, committed datatype) is loaded as soon as the
 * link that names it is known, and all loads run at once: one object's
 * header, its group's B-tree or fractal heap, its attributes and its
 * children's headers are each asked for the moment their address is known.
 * The byte reader gathers everything asked for in the same task into one
 * plan, so the number of sequential round trips grows with the depth of the
 * tree (times a small constant per level), not with the number of objects.
 *
 * Each object is loaded once by its header address, however many hard links
 * lead to it, so a hard link cycle cannot loop. Soft links, external links
 * and virtual datasets are recorded, not followed: soft links resolve on
 * navigation; the other two fail only when accessed, so a file that has one
 * still opens.
 *
 * @module formats/hdf5/load
 */

import { readObjectHeader } from './object-header.js';
import {
  MESSAGE, SHAREABLE, parseAttribute, parseAttributeInfo, parseBtreeK, parseDataspace, parseFillValue,
  parseFillValueOld, parseFilterPipeline, parseLayout, parseLink, parseLinkInfo, parseSharedMessage,
  parseSharedMessageTable, parseSymbolTable,
} from './messages.js';
import { parseDatatype, requireDecodable } from './datatype.js';
import { walkBtreeV1, readSymbolNodes } from './btree-v1.js';
import { walkBtreeV2 } from './btree-v2.js';
import { openFractalHeap, readHeapObjects } from './fractal-heap.js';
import { localHeapString, readLocalHeap, withCollections } from './heaps.js';
import { attributeValue, heapAddresses } from './decode.js';
import { decodeText } from './binary.js';
import { Hdf5UnsupportedError, formatError } from './errors.js';

/**
 * @typedef {Object} AttributeInfo
 * @property {string} name
 * @property {Object} type - Hdf5Type
 * @property {import('./messages.js').Dataspace} space
 * @property {unknown} value
 * @property {Error|null} error - Why the value could not be decoded
 */

/**
 * @typedef {Object} ObjectInfo
 * @property {number} address
 * @property {'group'|'dataset'|'datatype'|'unknown'} kind
 * @property {AttributeInfo[]} attributes
 * @property {import('./messages.js').Link[]} [links]
 * @property {import('./messages.js').Dataspace} [space]
 * @property {Object} [type]
 * @property {import('./messages.js').Layout} [layout]
 * @property {import('./messages.js').Filter[]} [filters]
 * @property {import('./messages.js').FillValue} [fill]
 * @property {boolean} [externalStorage]
 * @property {Error|null} [unsupported]
 */

/** Bit of the shared message table's type flags for each shareable message. */
const SHARED_INDEX_BITS = new Map([
  [MESSAGE.DATASPACE, 1],
  [MESSAGE.DATATYPE, 2],
  [MESSAGE.FILL_VALUE, 4],
  [MESSAGE.FILTER_PIPELINE, 8],
  [MESSAGE.ATTRIBUTE, 16],
]);

/**
 * State of one open: object headers, group link lists and heaps asked for so
 * far (each once, by address), and the shared message table.
 */
class OpenSession {
  constructor(file, signal) {
    this.file = file;
    this.signal = signal;
    this.headers = new Map();
    this.heaps = new Map();
    this.groupLinks = new Map();
    this.sharedTable = null;
    /** Called with every group's links as soon as they are known. */
    this.onLinks = null;
  }

  /**
   * An object header. As soon as its first block is parsed, a group's links
   * are asked for too: they need not wait for continuation blocks, shared
   * messages or attributes.
   */
  header(address) {
    let promise = this.headers.get(address);
    if (promise === undefined) {
      promise = readObjectHeader(this.file, address, this.signal, header => this.startLinks(header));
      promise.catch(() => {});
      this.headers.set(address, promise);
    }
    return promise;
  }

  /** Ask for a group's links from the messages of its header's first block. */
  startLinks(header) {
    for (const message of header.messages) {
      if (message.flags & 2) continue;
      let links = null;
      if (message.type === MESSAGE.SYMBOL_TABLE) {
        links = this.symbolTableLinks(parse(this.file, message, parseSymbolTable, 'Symbol table message'));
      } else if (message.type === MESSAGE.LINK_INFO) {
        const linkInfo = parse(this.file, message, parseLinkInfo, 'Link info message');
        if (linkInfo.heapAddress !== null) links = this.denseLinks(linkInfo, header.address);
      }
      // Children are visited as soon as the links are known, without waiting
      // for the rest of this header (continuation blocks, attributes).
      links?.then(found => this.onLinks?.(found), () => {});
    }
  }

  heap(address) {
    let promise = this.heaps.get(address);
    if (promise === undefined) {
      promise = openFractalHeap(this.file, address, this.signal);
      this.heaps.set(address, promise);
    }
    return promise;
  }

  /**
   * The links of an older-format group: its B-tree and local heap read at
   * once, then its symbol table nodes. A child group's entry usually caches
   * that child's own B-tree and heap addresses (cache type 1): its header and
   * its links are asked for right away, in the same round.
   */
  symbolTableLinks({ btreeAddress, heapAddress }) {
    const key = `symbols:${btreeAddress}:${heapAddress}`;
    let promise = this.groupLinks.get(key);
    if (promise === undefined) {
      promise = this.readSymbolTable(btreeAddress, heapAddress);
      this.groupLinks.set(key, promise);
    }
    return promise;
  }

  async readSymbolTable(btreeAddress, heapAddress) {
    const file = this.file;
    const signal = this.signal;
    // The heap holds only names: nothing below waits for it but naming.
    const heapRead = readLocalHeap(file, heapAddress, signal);
    heapRead.catch(() => {});
    const snodes = [];
    await walkBtreeV1(file, btreeAddress, 0, (bytes, keyOffset, child) => snodes.push(child), { signal });
    const entries = [];
    await readSymbolNodes(file, snodes, (nameOffset, objectAddress, cacheType, scratch) => {
      if (cacheType === 2) {
        const valueOffset = scratch[0] | (scratch[1] << 8) | (scratch[2] << 16) | (scratch[3] << 24);
        entries.push({ nameOffset, soft: valueOffset >>> 0 });
        return;
      }
      entries.push({ nameOffset, address: objectAddress });
      if (objectAddress === null) return;
      // The child's header, and a child group's own B-tree and heap (cached in
      // the entry, cache type 1), are asked for now: same round as the names.
      this.header(objectAddress);
      if (cacheType === 1) {
        const cursor = file.cursor(scratch, NaN, 'Symbol table entry');
        const cached = { btreeAddress: cursor.address(), heapAddress: cursor.address() };
        if (cached.btreeAddress !== null && cached.heapAddress !== null) this.symbolTableLinks(cached).catch(() => {});
      }
    }, signal);
    const heap = await heapRead;
    return entries.map(entry => {
      const name = localHeapString(heap, entry.nameOffset, file, decodeText);
      return entry.soft === undefined
        ? { name, type: 'hard', address: entry.address, creationOrder: null }
        : { name, type: 'soft', target: localHeapString(heap, entry.soft, file, decodeText), creationOrder: null };
    });
  }

  /** The links of a newer-format group stored densely (fractal heap + name index). */
  denseLinks(linkInfo, address) {
    const key = `dense:${linkInfo.heapAddress}`;
    let promise = this.groupLinks.get(key);
    if (promise === undefined) {
      promise = this.readDenseLinks(linkInfo, address);
      this.groupLinks.set(key, promise);
    }
    return promise;
  }

  async readDenseLinks(linkInfo, address) {
    const file = this.file;
    const ids = [];
    const [heap] = await Promise.all([
      this.heap(linkInfo.heapAddress),
      walkBtreeV2(file, linkInfo.nameIndexAddress, (bytes, offset) => {
        ids.push(bytes.slice(offset + 4, offset + 11));
      }, { signal: this.signal, expectType: 5 }),
    ]);
    const records = await readHeapObjects(file, heap, ids, this.signal);
    return records.map(bytes => parseLink(file.cursor(bytes, address, 'Link message in a fractal heap')));
  }
}

/**
 * Read the superblock extension: non-default B-tree 'K' values and the
 * shared message table.
 */
async function readExtension(session, address) {
  const header = await session.header(address);
  const file = session.file;
  for (const message of header.messages) {
    const cursor = file.cursor(message.data, message.address, 'Superblock extension message');
    if (message.type === MESSAGE.BTREE_K) {
      const k = parseBtreeK(cursor);
      // Changed in place: `file` may be a per-read view of the file context.
      Object.assign(file.btreeK, { chunk: k.chunk, groupInternal: k.groupInternal, groupLeaf: k.groupLeaf });
    } else if (message.type === MESSAGE.SHARED_MESSAGE_TABLE) {
      session.sharedTable = readSharedTable(session, parseSharedMessageTable(cursor));
      session.sharedTable.catch(() => {});
    }
  }
}

async function readSharedTable(session, { address, indexCount }) {
  const file = session.file;
  const what = 'Shared message table';
  const entrySize = 1 + 1 + 2 + 4 + 2 + 2 + 2 + 2 * file.offsetSize;
  const bytes = await file.meta(address, 4 + indexCount * entrySize + 4, what, session.signal);
  const cursor = file.cursor(bytes, address, what);
  cursor.signature('SMTB');
  const indexes = [];
  for (let i = 0; i < indexCount; i++) {
    const version = cursor.u8();
    if (version !== 0) throw cursor.error(`index version ${version} is unknown`);
    cursor.u8(); // list or B-tree: the messages are read by heap ID either way
    const types = cursor.u16();
    cursor.skip(4 + 2 + 2 + 2);
    cursor.address(); // index address
    indexes.push({ types, heapAddress: cursor.address() });
  }
  file.checkChecksum(bytes, address, what);
  return indexes;
}

/**
 * The data of a shared message: the message it points to in another object
 * header (a committed message) or in the shared message heap.
 */
async function sharedMessageData(session, type, data, address) {
  const file = session.file;
  const pointer = parseSharedMessage(file.cursor(data, address, 'Shared message'));
  if (pointer.kind === 'header') {
    if (pointer.address === null) throw formatError('Shared message', file.absolute(address), 'it points to an undefined address');
    const target = await session.header(pointer.address);
    const message = target.messages.find(candidate => candidate.type === type);
    if (message === undefined) {
      throw formatError('Shared message', file.absolute(address), `the object header at ${pointer.address} holds no message of type ${type}`);
    }
    if (message.flags & 2) return sharedMessageData(session, type, message.data, message.address);
    return { data: message.data, address: message.address };
  }
  const indexes = session.sharedTable === null ? null : await session.sharedTable;
  const bit = SHARED_INDEX_BITS.get(type);
  const index = indexes?.find(candidate => (candidate.types & bit) !== 0);
  if (index === undefined || index.heapAddress === null) {
    throw formatError('Shared message', file.absolute(address), `no shared message index holds messages of type ${type}`);
  }
  const heap = await session.heap(index.heapAddress);
  const [bytes] = await readHeapObjects(file, heap, [pointer.heapId], session.signal);
  return { data: bytes, address: null };
}

/** Replace shared messages by the data they point to. */
async function resolveMessages(session, messages) {
  return Promise.all(messages.map(async message => {
    if ((message.flags & 2) === 0 || !SHAREABLE.has(message.type)) return message;
    const shared = await sharedMessageData(session, message.type, message.data, message.address);
    return { ...message, data: shared.data, address: shared.address ?? message.address, flags: message.flags & ~2 };
  }));
}

/**
 * Load the whole object tree below `rootAddress`.
 *
 * @param {import('./context.js').FileContext} file
 * @param {{rootAddress: number, extensionAddress: number|null}} superblock
 * @param {AbortSignal|null} signal
 * @returns {Promise<Map<number, ObjectInfo>>}
 */
export async function loadTree(file, { rootAddress, rootSymbolTable = null, extensionAddress }, signal = null) {
  const session = new OpenSession(file, signal);
  // The root header (and, from the superblock's cache, its links) is asked
  // for now, alongside the extension.
  session.header(rootAddress);
  if (rootSymbolTable !== null && rootSymbolTable.btreeAddress !== null && rootSymbolTable.heapAddress !== null) {
    session.symbolTableLinks(rootSymbolTable).catch(() => {});
  }
  if (extensionAddress !== null) await readExtension(session, extensionAddress);

  const objects = new Map();
  const started = new Set();
  const pending = new Set();
  let failure = null;
  const track = promise => {
    pending.add(promise);
    promise.then(
      () => pending.delete(promise),
      error => {
        pending.delete(promise);
        failure ??= error;
      }
    );
  };
  // Children are visited as soon as their group's links are known, while
  // the group's own attributes are still loading.
  const visitLinks = links => {
    for (const link of links) {
      if (link.type === 'hard' && link.address !== null) visit(link.address);
    }
  };
  const visit = address => {
    if (started.has(address)) return;
    started.add(address);
    track(loadObject(session, address, visitLinks).then(info => {
      objects.set(address, info);
    }));
  };
  session.onLinks = visitLinks;
  visit(rootAddress);
  while (pending.size > 0 && failure === null) await Promise.allSettled([...pending]);
  if (failure !== null) throw failure;
  return objects;
}

/** Parse a message with its parser, naming the object on failure. */
function parse(file, message, parser, what) {
  return parser(file.cursor(message.data, message.address, what));
}

/**
 * Load one object: its header, what it is, its links (groups) and its
 * attributes, with links and attributes loaded at the same time.
 *
 * @returns {Promise<ObjectInfo>}
 */
async function loadObject(session, address, onLinks) {
  const file = session.file;
  const header = await session.header(address);
  const messages = await resolveMessages(session, header.messages);
  const info = { address, kind: 'unknown', attributes: [], unsupported: null };
  if (header.unknownRequired !== null) {
    info.unsupported = new Hdf5UnsupportedError('object-header-message',
      `The object at address ${address} needs header message type ${header.unknownRequired}, which this reader does not know.`);
  }
  let symbolTable = null;
  let linkInfo = null;
  let attributeInfo = null;
  let isGroup = false;
  const links = [];
  const attributeMessages = [];
  let fillOld = null;
  for (const message of messages) {
    switch (message.type) {
      case MESSAGE.DATASPACE: info.space = parse(file, message, parseDataspace, 'Dataspace message'); break;
      case MESSAGE.DATATYPE: info.type = parse(file, message, parseDatatype, 'Datatype message'); break;
      case MESSAGE.FILL_VALUE_OLD: fillOld = parse(file, message, parseFillValueOld, 'Fill value message'); break;
      case MESSAGE.FILL_VALUE: info.fill = parse(file, message, parseFillValue, 'Fill value message'); break;
      case MESSAGE.LAYOUT: info.layout = parse(file, message, parseLayout, 'Data layout message'); break;
      case MESSAGE.FILTER_PIPELINE: info.filters = parse(file, message, parseFilterPipeline, 'Filter pipeline message'); break;
      case MESSAGE.EXTERNAL_FILES: info.externalStorage = true; break;
      case MESSAGE.LINK: isGroup = true; links.push(parse(file, message, parseLink, 'Link message')); break;
      case MESSAGE.LINK_INFO: isGroup = true; linkInfo = parse(file, message, parseLinkInfo, 'Link info message'); break;
      case MESSAGE.GROUP_INFO: isGroup = true; break;
      case MESSAGE.SYMBOL_TABLE: isGroup = true; symbolTable = parse(file, message, parseSymbolTable, 'Symbol table message'); break;
      case MESSAGE.ATTRIBUTE: attributeMessages.push(message); break;
      case MESSAGE.ATTRIBUTE_INFO: attributeInfo = parse(file, message, parseAttributeInfo, 'Attribute info message'); break;
      default: break;
    }
  }
  // The older fill value message stands in when the newer one is absent.
  if (info.fill === undefined && fillOld !== null) info.fill = fillOld;
  if (info.layout !== undefined) {
    info.kind = 'dataset';
    if (info.space === undefined || info.type === undefined) {
      throw formatError('Dataset object header', file.absolute(address), 'it has no dataspace or no datatype message');
    }
    info.filters ??= [];
  } else if (isGroup) {
    info.kind = 'group';
  } else if (info.type !== undefined) {
    info.kind = 'datatype';
  }

  const [groupLinks, attributes] = await Promise.all([
    info.kind === 'group'
      ? loadLinks(session, address, symbolTable, linkInfo, links).then(found => {
        onLinks(found);
        return found;
      })
      : Promise.resolve(null),
    loadAttributes(session, address, attributeMessages, attributeInfo),
  ]);
  if (groupLinks !== null) info.links = groupLinks;
  info.attributes = attributes;
  return info;
}

/* ---------- links ---------- */

function loadLinks(session, address, symbolTable, linkInfo, compactLinks) {
  if (symbolTable !== null) return session.symbolTableLinks(symbolTable);
  if (linkInfo !== null && linkInfo.heapAddress !== null) return session.denseLinks(linkInfo, address);
  return Promise.resolve(compactLinks);
}

/* ---------- attributes ---------- */

async function loadAttributes(session, address, compactMessages, attributeInfo) {
  const file = session.file;
  const signal = session.signal;
  const messages = compactMessages.map(message => ({ data: message.data, address: message.address }));
  if (attributeInfo !== null && attributeInfo.heapAddress !== null) {
    const records = [];
    const [heap] = await Promise.all([
      session.heap(attributeInfo.heapAddress),
      walkBtreeV2(file, attributeInfo.nameIndexAddress, (bytes, offset) => {
        records.push({ id: bytes.slice(offset, offset + 8), flags: bytes[offset + 8] });
      }, { signal, expectType: 8 }),
    ]);
    const objects = await readHeapObjects(file, heap, records.map(record => record.id), signal);
    const dense = await Promise.all(objects.map((bytes, index) => (records[index].flags & 2
      ? sharedMessageData(session, MESSAGE.ATTRIBUTE, bytes, address)
      : { data: bytes, address })));
    messages.push(...dense.map(entry => ({ data: entry.data, address: entry.address ?? address })));
  }
  if (messages.length === 0) return [];

  // Parse each attribute, resolving shared datatypes and dataspaces.
  const parsed = await Promise.all(messages.map(async message => {
    const parts = parse(file, message, parseAttribute, 'Attribute message');
    const [typeField, spaceField] = await Promise.all([
      parts.typeShared ? sharedMessageData(session, MESSAGE.DATATYPE, parts.typeBytes, message.address) : { data: parts.typeBytes, address: message.address },
      parts.spaceShared ? sharedMessageData(session, MESSAGE.DATASPACE, parts.spaceBytes, message.address) : { data: parts.spaceBytes, address: message.address },
    ]);
    const type = parseDatatype(file.cursor(typeField.data, typeField.address ?? address, `Datatype of attribute '${parts.name}'`));
    const space = parseDataspace(file.cursor(spaceField.data, spaceField.address ?? address, `Dataspace of attribute '${parts.name}'`));
    return { name: parts.name, type, space, data: parts.data };
  }));

  // Variable-length values: every collection of this object's attributes at once.
  const needs = new Map();
  for (const attribute of parsed) {
    const count = attribute.space.kind === 'null' ? 0 : attribute.space.dims.reduce((a, b) => a * b, 1);
    if (attribute.data.length >= count * attribute.type.size) {
      heapAddresses(file, attribute.type, attribute.data, count, needs);
    }
  }
  return withCollections(file, needs, { cache: true, signal }, collections => parsed.map(attribute => {
    let value = null;
    let error = null;
    try {
      requireDecodable(attribute.type, `Attribute '${attribute.name}'`);
      value = attributeValue(file, attribute.type, attribute.space, attribute.data, collections);
    } catch (cause) {
      // An attribute of a kind this reader does not decode is left out of
      // `attrs`; anything else wrong with it is wrong with the file.
      if (!(cause instanceof Hdf5UnsupportedError)) throw cause;
      error = cause;
    }
    return { name: attribute.name, type: attribute.type, space: attribute.space, value, error };
  }));
}
