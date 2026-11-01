/**
 * Loading a file's objects as they are navigated into (`formats/store.js`,
 * `Group.load`): nothing is read before something asks for it.
 *
 * An object (group, dataset, committed datatype) is loaded by its header
 * address: its header, its messages (shared ones resolved) and its
 * attributes. A group's links are loaded on their own. Each is read once,
 * however many hard links lead to it and however many loads ask at once
 * (`SharedWorks`: a read stops only once every load waiting on it has
 * withdrawn, and one stopped or failed is read again by the next that
 * asks), and kept while the file is open.
 *
 * Loads that are background work (an activity marked `background`, as a
 * reader completes the tree after its first view) share their reads only
 * among themselves: a load someone waits for starts its own, which the byte
 * reader joins to any background request of the same bytes and lets go
 * first (`io/byte-reader.js`, priority), so it never waits behind background
 * work.
 *
 * A group is loaded (`loadGroup`) with its links and every child's object,
 * and below that to a depth: each child is asked for the moment the links
 * naming it are known, and a child group's own links the moment their
 * address is (an older-format group's symbol table entry caches a child
 * group's B-tree and heap: its links are asked for in the round its header
 * is). Paths below a group (`loadPaths`) are followed the same way: the
 * next group on a path is asked for as soon as its parent's links name it,
 * while the parent's other children still load. The byte reader gathers
 * everything asked for in one task into one plan, so what is asked for
 * loads in as many sequential round trips as it is deep (times a small
 * constant per level), whatever its number of objects, and what is not
 * asked for is not read.
 *
 * One load visits an object once, so a hard link cycle cannot loop. A soft
 * link is loaded through: the groups on the way to its target and the
 * target itself load with the group holding it, so it resolves on
 * navigation. External links and virtual datasets are recorded, not
 * followed: they fail only when accessed, so a file that has one still
 * opens.
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
import { SharedWorks } from '../../utils/abort.js';
import { pathParts } from '../store.js';

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
 * @property {import('./messages.js').Dataspace} [space]
 * @property {Object} [type]
 * @property {import('./messages.js').Layout} [layout]
 * @property {import('./messages.js').Filter[]} [filters]
 * @property {import('./messages.js').FillValue} [fill]
 * @property {boolean} [externalStorage]
 * @property {Error|null} [unsupported]
 */

/**
 * @typedef {Object} LoadOptions
 * @property {AbortSignal|null} [signal]
 * @property {import('../io/activity.js').ReadActivity|null} [activity] - Counts what the load reads
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
 * Every object of one open file loaded so far, and the loads of the rest:
 * object headers, objects, group links and heaps, each read once, by
 * address.
 */
export class ObjectLoader {
  /**
   * @param {import('./context.js').FileContext} file
   * @param {number} rootAddress
   */
  constructor(file, rootAddress) {
    this.file = file;
    this.rootAddress = rootAddress;
    this.headers = new SharedWorks({ keep: true });
    this.heaps = new SharedWorks({ keep: true });
    this.linkWorks = new SharedWorks({ keep: true });
    this.objectWorks = new SharedWorks({ keep: true });
    /** @type {Map<number, ObjectInfo>} Loaded objects by address. */
    this.objects = new Map();
    /** @type {Map<number, import('./messages.js').Link[]>} Loaded groups' links by address. */
    this.links = new Map();
    /** A child group's B-tree and heap, as its parent's symbol table entry caches them, by address. */
    this.cachedTables = new Map();
    /** Groups whose links and every child are loaded (navigable), by address. */
    this.open = new Set();
    /** Groups loaded with every object below them, by address. */
    this.whole = new Set();
    /** @type {Promise<Array<{types: number, heapAddress: number|null}>>|null} */
    this.sharedTable = null;
  }

  /** The file, reading under `activity`. */
  fileOf(options) {
    this.file.requireOpen();
    return this.file.withActivity(options?.activity ?? null);
  }

  /** An object header. */
  header(address, options) {
    return this.headers.run(workKey(address, options), own => readObjectHeader(this.fileOf(own), address, own.signal), options);
  }

  /** A fractal heap (dense links or attributes, the shared message heap). */
  heap(address, options) {
    return this.heaps.run(workKey(address, options), own => openFractalHeap(this.fileOf(own), address, own.signal), options);
  }

  /**
   * Read the superblock extension: non-default B-tree 'K' values and the
   * shared message table.
   */
  async readExtension(address, options) {
    const header = await this.header(address, options);
    const file = this.file;
    for (const message of header.messages) {
      const cursor = file.cursor(message.data, message.address, 'Superblock extension message');
      if (message.type === MESSAGE.BTREE_K) {
        const k = parseBtreeK(cursor);
        Object.assign(file.btreeK, { chunk: k.chunk, groupInternal: k.groupInternal, groupLeaf: k.groupLeaf });
      } else if (message.type === MESSAGE.SHARED_MESSAGE_TABLE) {
        // Read when a shared message first needs it, by whichever load that is.
        const table = parseSharedMessageTable(cursor);
        const tables = new SharedWorks({ keep: true });
        this.sharedTable = own => tables.run(workKey('table', own), start => readSharedTable(this.fileOf(start), table, start.signal), own);
      }
    }
  }

  /** An object: its header, kind, dataspace, datatype, layout and attributes. @returns {Promise<ObjectInfo>} */
  object(address, options) {
    const loaded = this.objects.get(address);
    if (loaded !== undefined) return Promise.resolve(loaded);
    return this.objectWorks.run(workKey(address, options), async own => {
      const info = await loadObject(this, address, own);
      this.objects.set(address, info);
      return info;
    }, options);
  }

  /** A group's links (`object`'s header names where they are). */
  linksOf(address, options) {
    const loaded = this.links.get(address);
    if (loaded !== undefined) return Promise.resolve(loaded);
    return this.linkWorks.run(workKey(`group:${address}`, options), async own => {
      const header = await this.header(address, own);
      let symbolTable = null;
      let linkInfo = null;
      const compact = [];
      for (const message of header.messages) {
        if (message.type === MESSAGE.SYMBOL_TABLE) symbolTable = parse(this.file, message, parseSymbolTable, 'Symbol table message');
        else if (message.type === MESSAGE.LINK_INFO) linkInfo = parse(this.file, message, parseLinkInfo, 'Link info message');
        else if (message.type === MESSAGE.LINK) compact.push(parse(this.file, message, parseLink, 'Link message'));
      }
      let found = compact;
      if (symbolTable !== null) found = await this.tableLinks(symbolTable, own);
      else if (linkInfo !== null && linkInfo.heapAddress !== null) found = await this.denseLinks(linkInfo, address, own);
      this.links.set(address, found);
      return found;
    }, options);
  }

  /**
   * The links of an older-format group: its B-tree and local heap read at
   * once, then its symbol table nodes. Each entry's cached B-tree and heap
   * (cache type 1, a child group) are kept: a load of that child asks for its
   * links with its header.
   */
  tableLinks({ btreeAddress, heapAddress }, options) {
    return this.linkWorks.run(workKey(`symbols:${btreeAddress}:${heapAddress}`, options), own => this.readSymbolTable(btreeAddress, heapAddress, own), options);
  }

  async readSymbolTable(btreeAddress, heapAddress, options) {
    const file = this.fileOf(options);
    const signal = options.signal;
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
      if (objectAddress !== null && cacheType === 1) {
        const cursor = file.cursor(scratch, NaN, 'Symbol table entry');
        const cached = { btreeAddress: cursor.address(), heapAddress: cursor.address() };
        if (cached.btreeAddress !== null && cached.heapAddress !== null) this.cachedTables.set(objectAddress, cached);
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
  denseLinks(linkInfo, address, options) {
    return this.linkWorks.run(workKey(`dense:${linkInfo.heapAddress}`, options), async own => {
      const file = this.fileOf(own);
      const ids = [];
      const [heap] = await Promise.all([
        this.heap(linkInfo.heapAddress, own),
        walkBtreeV2(file, linkInfo.nameIndexAddress, (bytes, offset) => {
          ids.push(bytes.slice(offset + 4, offset + 11));
        }, { signal: own.signal, expectType: 5 }),
      ]);
      const records = await readHeapObjects(file, heap, ids, own.signal);
      return records.map(bytes => parseLink(file.cursor(bytes, address, 'Link message in a fractal heap')));
    }, options);
  }

  /** Ask for a child group's links now when its parent's entry says where they are. */
  warmLinks(address, options) {
    const cached = this.cachedTables.get(address);
    if (cached !== undefined && !this.links.has(address)) this.tableLinks(cached, options).catch(() => {});
  }

  /**
   * Load the group at `address` to `depth` levels: its links and every
   * child's object (1), and every child group the same way to the depth
   * left. `visited` (address → depth loaded by this load) keeps one load
   * from visiting an object twice.
   *
   * @param {number} address
   * @param {number} depth - At least 1
   * @param {LoadOptions} options
   * @param {Map<number, number>} [visited]
   * @returns {Promise<void>}
   */
  async loadGroup(address, depth, options, visited = new Map()) {
    if (this.whole.has(address) || (visited.get(address) ?? 0) >= depth) return;
    visited.set(address, depth);
    const own = settledLater(this.object(address, options));
    this.warmLinks(address, options);
    const links = await this.linksOf(address, options);
    const children = [own];
    const loads = [];
    for (const link of links) {
      if (link.type === 'hard' && link.address !== null) {
        const child = link.address;
        if (depth > 1) this.warmLinks(child, options);
        const object = this.object(child, options);
        children.push(object);
        if (depth > 1) loads.push(settledLater(object.then(info => (info.kind === 'group' ? this.loadGroup(child, depth - 1, options, visited) : null))));
      } else if (link.type === 'soft') {
        // Its target and the way to it, so it resolves on navigation.
        loads.push(settledLater(this.loadSoft(address, link.target, depth - 1, options, visited)));
      }
    }
    await Promise.all(children);
    this.open.add(address);
    await Promise.all(loads);
  }

  /**
   * Load what a soft link of the group at `from` leads to (absolute, or
   * relative to that group): every group on the way opened, and the target
   * to `depth`. A link that leads nowhere loads only the way.
   *
   * @returns {Promise<void>}
   */
  async loadSoft(from, target, depth, options, visited) {
    const address = await this.resolveTo(from, target, options);
    if (address === null) return;
    const info = await this.object(address, options);
    if (info.kind === 'group' && depth > 0) await this.loadGroup(address, depth, options, visited);
  }

  /**
   * Open the group at `address`: its links and every child's object (what
   * navigating it needs), following nothing further.
   */
  async openGroup(address, options) {
    if (this.open.has(address)) return;
    const links = await this.linksOf(address, options);
    await Promise.all([
      this.object(address, options),
      ...links.filter(link => link.type === 'hard' && link.address !== null).map(link => this.object(link.address, options)),
    ]);
    this.open.add(address);
  }

  /**
   * The address a path from the group at `from` leads to (absolute, or
   * relative to it), every group on the way opened; null when it leads
   * nowhere, out of the file, or round soft links in a circle (`visiting`:
   * the soft links being followed, by group and target).
   */
  async resolveTo(from, path, options, visiting = new Set()) {
    let parts;
    try {
      parts = pathParts(path);
    } catch {
      return null;
    }
    let address = path.startsWith('/') ? this.rootAddress : from;
    for (const part of parts) {
      const info = await this.object(address, options);
      if (info.kind !== 'group') return null;
      await this.openGroup(address, options);
      const link = this.links.get(address).find(candidate => candidate.name === part);
      if (link === undefined) return null;
      if (link.type === 'soft') {
        const hop = `${address}:${link.target}`;
        if (visiting.has(hop)) return null;
        visiting.add(hop);
        const through = await this.resolveTo(address, link.target, options, visiting);
        if (through === null) return null;
        address = through;
      } else if (link.type === 'hard' && link.address !== null) {
        address = link.address;
      } else {
        return null;
      }
    }
    return address;
  }

  /**
   * Load paths below the group at `address` (`formats/store.js`,
   * `Group.load`): the group itself to the deepest depth asked of it (and to
   * 1 when a path goes below it), and each path's next group the moment the
   * group's links name it.
   *
   * @param {number} address
   * @param {import('../store.js').LoadSpec[]} specs
   * @param {LoadOptions} options
   * @returns {Promise<void>}
   */
  async loadPaths(address, specs, options) {
    let own = 0;
    const deeper = [];
    for (const spec of specs) {
      if (spec.parts.length === 0) own = Math.max(own, spec.depth);
      else deeper.push(spec);
    }
    if (deeper.length > 0) own = Math.max(own, 1);
    if (own === 0) return;
    // The way on is asked for with the group's own links, before its children load.
    if (deeper.length > 0) this.warmLinks(address, options);
    const loading = settledLater(own === Infinity ? this.loadWhole(address, options) : this.loadGroup(address, own, options));
    if (deeper.length === 0) return loading;
    const links = await this.linksOf(address, options);
    const byChild = new Map();
    for (const { parts: [first, ...rest], depth } of deeper) {
      for (const link of links) {
        if (first !== '*' && link.name !== first) continue;
        if (!byChild.has(link)) byChild.set(link, []);
        byChild.get(link).push({ parts: rest, depth });
      }
    }
    const below = [...byChild].map(async ([link, paths]) => {
      let child = null;
      if (link.type === 'hard') child = link.address;
      else if (link.type === 'soft') child = await this.resolveTo(address, link.target, options);
      if (child === null) return;
      if (paths.some(path => path.parts.length > 0 || path.depth > 0)) this.warmLinks(child, options);
      const info = await this.object(child, options);
      if (info.kind === 'group') await this.loadPaths(child, paths, options);
    });
    await Promise.all([loading, ...below]);
  }

  /** Load the whole subtree of the group at `address`. */
  async loadWhole(address, options) {
    if (this.whole.has(address)) return;
    await this.loadGroup(address, Infinity, options);
    this.whole.add(address);
  }
}

/**
 * `promise`, marked as handled: it is awaited later, after other awaits that
 * may throw first, and its failure must not be reported unhandled then.
 */
function settledLater(promise) {
  promise.catch(() => {});
  return promise;
}

/**
 * The key one piece of loading work is shared under: background loads share
 * theirs apart from the others' (module doc).
 */
function workKey(key, options) {
  return options?.activity?.background === true ? `background:${key}` : key;
}

/**
 * The shared message table: one entry per index, the message types it
 * holds and the heap they are stored in.
 */
async function readSharedTable(file, { address, indexCount }, signal) {
  const what = 'Shared message table';
  const entrySize = 1 + 1 + 2 + 4 + 2 + 2 + 2 + 2 * file.offsetSize;
  const bytes = await file.meta(address, 4 + indexCount * entrySize + 4, what, signal);
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
async function sharedMessageData(loader, type, data, address, options) {
  const file = loader.file;
  const pointer = parseSharedMessage(file.cursor(data, address, 'Shared message'));
  if (pointer.kind === 'header') {
    if (pointer.address === null) throw formatError('Shared message', file.absolute(address), 'it points to an undefined address');
    const target = await loader.header(pointer.address, options);
    const message = target.messages.find(candidate => candidate.type === type);
    if (message === undefined) {
      throw formatError('Shared message', file.absolute(address), `the object header at ${pointer.address} holds no message of type ${type}`);
    }
    if (message.flags & 2) return sharedMessageData(loader, type, message.data, message.address, options);
    return { data: message.data, address: message.address };
  }
  const indexes = loader.sharedTable === null ? null : await loader.sharedTable(options);
  const bit = SHARED_INDEX_BITS.get(type);
  const index = indexes?.find(candidate => (candidate.types & bit) !== 0);
  if (index === undefined || index.heapAddress === null) {
    throw formatError('Shared message', file.absolute(address), `no shared message index holds messages of type ${type}`);
  }
  const heap = await loader.heap(index.heapAddress, options);
  const [bytes] = await readHeapObjects(loader.fileOf(options), heap, [pointer.heapId], options.signal);
  return { data: bytes, address: null };
}

/** Replace shared messages by the data they point to. */
async function resolveMessages(loader, messages, options) {
  return Promise.all(messages.map(async message => {
    if ((message.flags & 2) === 0 || !SHAREABLE.has(message.type)) return message;
    const shared = await sharedMessageData(loader, message.type, message.data, message.address, options);
    return { ...message, data: shared.data, address: shared.address ?? message.address, flags: message.flags & ~2 };
  }));
}

/** Parse a message with its parser, naming the object on failure. */
function parse(file, message, parser, what) {
  return parser(file.cursor(message.data, message.address, what));
}

/**
 * Load one object: its header, what it is and its attributes (a group's
 * links are loaded on their own, `ObjectLoader.linksOf`).
 *
 * @returns {Promise<ObjectInfo>}
 */
async function loadObject(loader, address, options) {
  const file = loader.file;
  const header = await loader.header(address, options);
  const messages = await resolveMessages(loader, header.messages, options);
  const info = { address, kind: 'unknown', attributes: [], unsupported: null };
  if (header.unknownRequired !== null) {
    info.unsupported = new Hdf5UnsupportedError('object-header-message',
      `The object at address ${address} needs header message type ${header.unknownRequired}, which this reader does not know.`);
  }
  let attributeInfo = null;
  let isGroup = false;
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
      case MESSAGE.LINK:
      case MESSAGE.LINK_INFO:
      case MESSAGE.GROUP_INFO:
      case MESSAGE.SYMBOL_TABLE: isGroup = true; break;
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
  info.attributes = await loadAttributes(loader, address, attributeMessages, attributeInfo, options);
  return info;
}

/* ---------- attributes ---------- */

async function loadAttributes(loader, address, compactMessages, attributeInfo, options) {
  const file = loader.fileOf(options);
  const signal = options.signal;
  const messages = compactMessages.map(message => ({ data: message.data, address: message.address }));
  if (attributeInfo !== null && attributeInfo.heapAddress !== null) {
    const records = [];
    const [heap] = await Promise.all([
      loader.heap(attributeInfo.heapAddress, options),
      walkBtreeV2(file, attributeInfo.nameIndexAddress, (bytes, offset) => {
        records.push({ id: bytes.slice(offset, offset + 8), flags: bytes[offset + 8] });
      }, { signal, expectType: 8 }),
    ]);
    const objects = await readHeapObjects(file, heap, records.map(record => record.id), signal);
    const dense = await Promise.all(objects.map((bytes, index) => (records[index].flags & 2
      ? sharedMessageData(loader, MESSAGE.ATTRIBUTE, bytes, address, options)
      : { data: bytes, address })));
    messages.push(...dense.map(entry => ({ data: entry.data, address: entry.address ?? address })));
  }
  if (messages.length === 0) return [];

  // Parse each attribute, resolving shared datatypes and dataspaces.
  const parsed = await Promise.all(messages.map(async message => {
    const parts = parse(file, message, parseAttribute, 'Attribute message');
    const [typeField, spaceField] = await Promise.all([
      parts.typeShared ? sharedMessageData(loader, MESSAGE.DATATYPE, parts.typeBytes, message.address, options) : { data: parts.typeBytes, address: message.address },
      parts.spaceShared ? sharedMessageData(loader, MESSAGE.DATASPACE, parts.spaceBytes, message.address, options) : { data: parts.spaceBytes, address: message.address },
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
