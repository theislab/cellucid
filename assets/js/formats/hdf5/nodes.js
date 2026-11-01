/**
 * The store's groups and arrays (formats/store.js) over an open HDF5 file.
 *
 * Navigation is synchronous over what is loaded (`load.js`): a group's
 * `keys()`, `get()` and `has()` answer once it is loaded (`load`), and
 * throw `StoreNotLoadedError` before. Nodes are made on first access and
 * kept by path, so asking twice gives the same node. The same object
 * reached by two paths (two hard links, or a soft link) is two nodes
 * sharing one object: it is loaded once, and its chunk index read once,
 * either way.
 *
 * - Hard links lead to the object they name.
 * - Soft links resolve inside the file, absolute or relative to their group;
 *   one that leads nowhere (or in a circle) reads as absent (`null`). A
 *   group's load loads what its soft links lead to.
 * - External links and user-defined links throw `Hdf5UnsupportedError` when
 *   followed; they are listed in `keys()` like any other link.
 * - Committed (named) datatypes are not arrays or groups: they are not
 *   listed and read as absent.
 *
 * @module formats/hdf5/nodes
 */

import { StoreNotLoadedError, compareNames, loadSpecsOf, normalizeSelection, pathParts } from '../store.js';
import { storeDtype, requireDecodable, containsVariableLength } from './datatype.js';
import { decodeElements, decodeField, heapAddresses, rowHeapNeeds } from './decode.js';
import { IncompleteCollectionError, collectionLoads, withCollections } from './heaps.js';
import { CHUNK_GROUP_BYTES } from './context.js';
import { throwIfAborted } from '../../utils/abort.js';
import { allocateTypedArray } from '../../data/sparse-column-index.js';
import { filterName } from './filters.js';
import { DatasetReader } from './read-plan.js';
import { Hdf5UnsupportedError } from './errors.js';
import { setOwnDataProperty } from '../../utils/exact-record.js';

function joinPath(parent, name) {
  return parent === '/' ? `/${name}` : `${parent}/${name}`;
}

/** Shared state of one open file's nodes. */
export class Hdf5Tree {
  /**
   * @param {import('./context.js').FileContext} file
   * @param {import('./load.js').ObjectLoader} loader
   */
  constructor(file, loader) {
    this.file = file;
    this.loader = loader;
    this.rootAddress = loader.rootAddress;
    this.nodes = new Map();
    this.readers = new Map();
  }

  /** The node of the loaded object at `address`, reached as `path`. */
  node(address, path) {
    let node = this.nodes.get(path);
    if (node !== undefined) return node;
    const info = this.loader.objects.get(address);
    if (info === undefined) throw new StoreNotLoadedError(path);
    if (info.kind === 'datatype' || info.kind === 'unknown') return null;
    const name = path === '/' ? '' : path.slice(path.lastIndexOf('/') + 1);
    if (info.kind === 'group') node = new Hdf5Group(this, info, path, name);
    else if (info.type.class === 'compound') node = new Hdf5CompoundArray(this, info, path, name);
    else node = new Hdf5Array(this, info, path, name);
    this.nodes.set(path, node);
    return node;
  }

  /** One reader (and so one chunk index) per object, whatever path reaches it. */
  reader(info, path) {
    let reader = this.readers.get(info.address);
    if (reader === undefined) {
      reader = new DatasetReader(this.file, info, path);
      this.readers.set(info.address, reader);
    }
    return reader;
  }

  get root() {
    return this.node(this.rootAddress, '/');
  }
}

/** What both groups and arrays have. */
class Hdf5Node {
  constructor(tree, info, path, name) {
    this.tree = tree;
    this.info = info;
    this.path = path;
    this.name = name;
    const attrs = {};
    const types = new Map();
    const sorted = info.attributes.slice().sort((a, b) => compareNames(a.name, b.name));
    for (const attribute of sorted) {
      types.set(attribute.name, Object.freeze({
        dtype: storeDtype(attribute.type),
        shape: Object.freeze(attribute.space.dims.slice()),
      }));
      // An attribute named `__proto__` is an attribute, never the map's prototype.
      if (attribute.error === null) setOwnDataProperty(attrs, attribute.name, attribute.value);
    }
    this.attrs = Object.freeze(attrs);
    this.attributeTypes = types;
  }

  /** An attribute's stored type and shape, or null. */
  attributeType(name) {
    return this.attributeTypes.get(name) ?? null;
  }
}

export class Hdf5Group extends Hdf5Node {
  constructor(tree, info, path, name) {
    super(tree, info, path, name);
    this.kind = 'group';
    this.linkMap = null;
    this.sortedKeys = null;
  }

  /** Whether the group's children are known (`load`). */
  get loaded() {
    return this.tree.loader.open.has(this.info.address);
  }

  /**
   * Load paths below this group (`formats/store.js`, `Group.load`); the
   * whole subtree by default.
   *
   * @param {ReadonlyArray<string|{path: string, depth?: number}>} [paths]
   * @param {{signal?: AbortSignal|null, activity?: Object|null}} [options]
   * @returns {Promise<void>}
   */
  async load(paths = [''], { signal = null, activity = null } = {}) {
    const specs = loadSpecsOf(paths);
    await this.tree.loader.loadPaths(this.info.address, specs, { signal, activity });
  }

  /** The group's links by name, once it is loaded. */
  get links() {
    if (this.linkMap === null) {
      if (!this.loaded) throw new StoreNotLoadedError(this.path);
      this.linkMap = new Map();
      for (const link of this.tree.loader.links.get(this.info.address)) this.linkMap.set(link.name, link);
    }
    return this.linkMap;
  }

  keys() {
    if (this.sortedKeys === null) {
      const names = [];
      for (const [name, link] of this.links) {
        if (link.type === 'hard') {
          const kind = this.tree.loader.objects.get(link.address)?.kind;
          if (kind === 'datatype' || kind === 'unknown') continue;
        }
        names.push(name);
      }
      this.sortedKeys = Object.freeze(names.sort(compareNames));
    }
    return this.sortedKeys.slice();
  }

  has(name) {
    try {
      return this.get(name) !== null;
    } catch (error) {
      if (error instanceof Hdf5UnsupportedError) return true;
      throw error;
    }
  }

  /**
   * A child, or a `/`-separated path below this group (absolute from the
   * root when it starts with `/`); `null` when absent.
   */
  get(path) {
    const parts = pathParts(path);
    let node = path.startsWith('/') ? this.tree.root : this;
    for (const part of parts) {
      if (node === null || node.kind !== 'group') return null;
      node = node.child(part, new Set());
    }
    return node;
  }

/** The child named `name`, following soft links (`visiting` stops loops). */
  child(name, visiting) {
    const link = this.links.get(name);
    if (link === undefined) return null;
    const path = joinPath(this.path, name);
    switch (link.type) {
      case 'hard':
        return this.tree.node(link.address, path);
      case 'soft': {
        if (visiting.has(path)) return null;
        visiting.add(path);
        const target = link.target;
        let node = target.startsWith('/') ? this.tree.root : this;
        let parts;
        try {
          parts = pathParts(target);
        } catch {
          return null;
        }
        for (const part of parts) {
          if (node === null || node.kind !== 'group') return null;
          node = node.child(part, visiting);
        }
        if (node === null) return null;
        // The target, named by the link's own path.
        return node.path === path ? node : this.tree.nodeAs(node, path);
      }
      case 'external':
        throw new Hdf5UnsupportedError('external-link',
          `${path} is an external link to '${link.path}' in the file '${link.file}'; this reader reads one file at a time.`);
      default:
        throw new Hdf5UnsupportedError('user-defined-link', `${path} is a user-defined link (type ${link.linkType}), which this reader cannot follow.`);
    }
  }
}

/** The node of `node`'s object, reached as `path`. */
Hdf5Tree.prototype.nodeAs = function nodeAs(node, path) {
  return this.node(node.info.address, path);
};

/**
 * Variable-length elements decoded part by part as the global heap
 * collections they point into arrive: one stream per read (`rowsOf`).
 *
 * The collections the parts given so far point into are loaded together, as
 * one plan, when the link has room for a request (`byte-reader.js`
 * `whenRoom`: a slot free and no request waiting), and the rest at once once
 * no part is to come (`end`); each part is decoded as soon as its own
 * collections are in. While requests queue (six a host over HTTP/1.1, a
 * host whose request budget binds), what arrives meanwhile is gathered: a
 * plan of more collections joins neighbours that one a part could not, and
 * costs no time, since its requests would have waited anyway. While the link
 * has room (a multiplexed link, an idle one), each part's collections are
 * loaded as it arrives: nothing waits for a batch to fill. Measured on a
 * CSR `.h5ad`'s obs index of strings (a lane measurement, 1 % uniform):
 * every part's collections loaded as they arrived took 85.8 s at 10M over
 * 150 ms HTTP/1.1 (2,067 requests) and 71.8 s at 100M over 20 ms HTTP/2;
 * one union after every part 68.8 s and 87.7 s (a barrier: the link idle
 * while every reference arrived); batches of a round of the link's
 * concurrent requests 80.2 s and 87.1 s.
 *
 * A collection is held while a part given still points into it, and let go
 * once every such part has decoded, kept a while among the recently let go
 * within the file's read-ahead (a column's heap is as large as the column:
 * a stream holds the collections of the parts in flight and a window of
 * recent ones, never the heap). A collection a later part needs further
 * into than a load read is completed for it, only its remaining bytes
 * fetched (`IncompleteCollectionError`, `collectionLoads` `held`).
 */
export class HeapStream {
  /**
   * @param {import('./context.js').FileContext} file
   * @param {Object} type - The elements' datatype
   * @param {{signal?: AbortSignal|null, activity?: Object|null}} [options]
   */
  constructor(file, type, options = {}) {
    this.file = file;
    this.scoped = file.withActivity(options.activity ?? null);
    this.type = type;
    this.signal = options.signal ?? null;
    /** Collection address -> its load, while a part points into it. */
    this.loading = new Map();
    /** Collection address -> parts given and not yet decoded that point into it. */
    this.users = new Map();
    /** Collection address -> bytes of it the parts need, not yet asked for. */
    this.pending = new Map();
    /** Collection address -> bytes of it asked for (Infinity: the whole). */
    this.asked = new Map();
    /**
     * Collections no part given points into any more, most recently let go
     * last, within the file's read-ahead (`FileContext.readAheadBytes`): a
     * part arriving later that points into one (the collection a chunk's
     * last rows share with the next chunk's first, which decode in either
     * order) takes it from here instead of fetching it again.
     */
    this.recent = new Map();
    this.recentBytes = 0;
    this.waitingForRoom = false;
    this.ended = false;
    this.flushed = this.nextFlush();
  }

  /** Settled at the next flush: a part waits for the one asking its collections. */
  nextFlush() {
    let resolve;
    const promise = new Promise(settle => { resolve = settle; });
    return { promise, resolve };
  }

  /** Wake the parts waiting for a flush. */
  wake() {
    const done = this.flushed;
    this.flushed = this.nextFlush();
    done.resolve();
  }

  /** Ask for every pending collection, as one plan. */
  flush() {
    if (this.pending.size === 0) return;
    const batch = this.pending;
    this.pending = new Map();
    for (const [address, load] of collectionLoads(this.scoped, batch, { cache: false, signal: this.signal })) {
      load.catch(() => {});
      this.loading.set(address, load);
      this.asked.set(address, batch.get(address));
    }
    this.wake();
  }

  /** Pending collections asked for at once when the link has room (or no part is to come), else when it next has. */
  flushWhenRoom() {
    if (this.pending.size === 0 || this.waitingForRoom) return;
    const reader = this.file.reader;
    if (this.ended || typeof reader.whenRoom !== 'function' || reader.room()) {
      this.flush();
      return;
    }
    this.waitingForRoom = true;
    reader.whenRoom().then(() => {
      this.waitingForRoom = false;
      if (this.signal?.aborted === true) this.wake();
      else this.flush();
    });
  }

  /**
   * A collection asked for in part that a part given later needs further
   * into (the collection one chunk's strings end in and the next's begin):
   * its remaining bytes are asked for as soon as its first part is in, not
   * once a decode finds an object missing, and only those.
   */
  extend(address, need) {
    const first = this.loading.get(address);
    const held = first.then(collection => (collection.complete || collection.bytes.length >= need
      ? collection
      : collectionLoads(this.scoped, new Map([[address, collection.bytes.length]]), {
        cache: false, complete: true, signal: this.signal, held: new Map([[address, collection]]),
      }).get(address)));
    held.catch(() => {});
    this.loading.set(address, held);
    this.asked.set(address, Infinity);
  }

  /** No part is to come: what is pending is asked for now. */
  end() {
    this.ended = true;
    this.flush();
  }

  /**
   * The elements of `bytes` (`count` of them), decoded once the collections
   * they point into are in.
   *
   * @param {Uint8Array} bytes
   * @param {number} count
   * @param {Map<number, number>|null} [needs] - The collections they point
   *   into and the bytes of each to read (`rowHeapNeeds`); by default
   *   measured from the elements alone (`heapAddresses`)
   * @returns {Promise<Array<unknown>>}
   */
  async part(bytes, count, needs = heapAddresses(this.file, this.type, bytes, count)) {
    const { file, type, signal } = this;
    for (const [address, need] of needs) {
      this.users.set(address, (this.users.get(address) ?? 0) + 1);
      const recent = this.recent.get(address);
      if (recent !== undefined) {
        this.recent.delete(address);
        this.recentBytes -= recent.bytes;
        this.loading.set(address, recent.load);
      }
      if (!this.loading.has(address)) this.pending.set(address, Math.max(need, this.pending.get(address) ?? 0));
      else if (need > (this.asked.get(address) ?? 0)) this.extend(address, need);
    }
    try {
      this.flushWhenRoom();
      for (;;) {
        let asked = true;
        for (const address of needs.keys()) {
          if (!this.loading.has(address)) {
            asked = false;
            break;
          }
        }
        if (asked) break;
        await this.flushed.promise;
        throwIfAborted(signal);
      }
      const collections = new Map();
      for (const address of needs.keys()) collections.set(address, await this.loading.get(address));
      try {
        return decodeElements(file, type, bytes, count, collections);
      } catch (error) {
        if (!(error instanceof IncompleteCollectionError)) throw error;
      }
      // Collections read in part miss an object: completed, their remaining bytes alone.
      const incomplete = new Map();
      for (const [address, need] of needs) if (!collections.get(address).complete) incomplete.set(address, need);
      for (const [address, load] of collectionLoads(this.scoped, incomplete, { cache: false, complete: true, signal, held: collections })) {
        load.catch(() => {});
        this.loading.set(address, load);
        this.asked.set(address, Infinity);
        collections.set(address, await load);
      }
      return decodeElements(file, type, bytes, count, collections);
    } finally {
      for (const address of needs.keys()) {
        const left = this.users.get(address) - 1;
        if (left > 0) {
          this.users.set(address, left);
        } else {
          this.users.delete(address);
          this.pending.delete(address);
          this.asked.delete(address);
          const load = this.loading.get(address);
          this.loading.delete(address);
          if (load !== undefined) this.letGo(address, load);
        }
      }
    }
  }

  /** A collection no part points into any more, kept among the recent ones while the read-ahead holds it. */
  letGo(address, load) {
    load.then(collection => {
      if (this.users.has(address) || this.recent.has(address)) return;
      const bytes = collection.bytes.length;
      this.recent.set(address, { load, bytes });
      this.recentBytes += bytes;
      const limit = this.file.readAheadBytes();
      for (const [oldest, entry] of this.recent) {
        if (this.recentBytes <= limit) break;
        this.recent.delete(oldest);
        this.recentBytes -= entry.bytes;
      }
    }, () => {});
  }
}

export class Hdf5Array extends Hdf5Node {
  constructor(tree, info, path, name) {
    super(tree, info, path, name);
    this.kind = 'array';
    const space = info.space;
    this.shape = Object.freeze(space.kind === 'null' ? [0] : space.dims.slice());
    this.dtype = storeDtype(info.type);
    const layout = info.layout;
    this.chunks = layout.class === 'chunked' ? Object.freeze(layout.chunkDims.slice()) : null;
    // Unfiltered chunks are read by the runs a selection needs (`read-plan.js`, `chunkRun`).
    this.partialChunks = layout.class === 'chunked' && info.filters.length === 0;
    // A column of elements in the global heap (strings) reads the rows it is
    // asked for, and of the heap only their objects (`formats/store.js`,
    // `readRows`).
    if (info.type.class === 'variable-length' && this.shape.length === 1) this.readRows = (runs, options) => this.rowsOf(runs, options);
    this.hdf5 = Object.freeze({
      address: info.address,
      dataspace: space.kind,
      maxShape: Object.freeze(space.maxDims.slice()),
      datatypeClass: info.type.class,
      layout: layout.class,
      chunkIndex: layout.index ?? null,
      filters: Object.freeze(info.filters.map(filter => Object.freeze({ id: filter.id, name: filterName(filter), clientData: Object.freeze(filter.clientData.slice()) }))),
    });
    this.fillValue = this.decodeFill();
  }

  get reader() {
    return this.tree.reader(this.info, this.path);
  }

  /** The value unwritten elements read as. */
  decodeFill() {
    const type = this.info.type;
    if (containsVariableLength(type)) return this.dtype.kind === 'string' ? '' : null;
    const fill = this.info.fill;
    const bytes = fill?.defined && fill.bytes?.length === type.size ? fill.bytes.slice() : new Uint8Array(type.size);
    try {
      const value = decodeElements(this.tree.file, type, bytes, 1, new Map());
      if (this.dtype.arrayShape !== undefined || this.dtype.kind === 'opaque') return value;
      return value[0];
    } catch {
      return null;
    }
  }

  /** Normalized selection plus its element bytes. */
  async readBytes(selection, options) {
    const normalized = normalizeSelection(this.shape, selection, this.path);
    requireDecodable(this.info.type, this.path);
    const bytes = await this.reader.read(normalized, options ?? {});
    const count = normalized.reduce((n, [start, stop]) => n * (stop - start), 1);
    return { bytes, count };
  }

  /** Decode with the global heap collections the elements in `bytes` point to. */
  decodeWithHeap(type, bytes, count, options, decode) {
    if (!containsVariableLength(type)) return decode(new Map());
    const file = this.tree.file;
    const needs = heapAddresses(file, type, bytes, count);
    return withCollections(file.withActivity(options?.activity ?? null), needs,
      { cache: false, signal: options?.signal ?? null }, decode);
  }

  /**
   * The selected elements (see formats/store.js for the value of each kind).
   *
   * @param {import('../store.js').Selection} [selection]
   * @param {{signal?: AbortSignal|null, activity?: Object|null}} [options]
   */
  async read(selection, options = {}) {
    if (this.readRows !== undefined) {
      const [[start, stop]] = normalizeSelection(this.shape, selection, this.path);
      return this.readRows({ count: 1, starts: [start], ends: [stop] }, options);
    }
    const type = this.info.type;
    const file = this.tree.file;
    const { bytes, count } = await this.readBytes(selection, options);
    const value = await this.decodeWithHeap(type, bytes, count, options, collections => decodeElements(file, type, bytes, count, collections));
    if (this.shape.length === 0 && this.info.space.kind === 'scalar') {
      if (this.dtype.arrayShape !== undefined || (this.dtype.kind === 'opaque' && this.dtype.sequence === undefined)) return value;
      return value[0];
    }
    return value;
  }

  /**
   * The rows `runs` names of a column of variable-length elements, one run
   * after another (`formats/store.js`, `readRows`): their references, read
   * a stored chunk (or, unchunked or unfiltered, a box of neighbouring runs)
   * at a time, the rows' own picked out as each arrives, and then the global
   * heap objects of those rows alone, decoded as their collections arrive
   * (`HeapStream`). What a part reads and holds is that part's: the
   * references of a chunk go once its rows' are picked, a collection once
   * every part that points into it has decoded. Parts are read ahead no
   * further than the file reads chunks ahead (`FileContext.readAheadBytes`):
   * a read of every row of a column holds a window of it, not the column's
   * references and heap at once, and a share of its rows holds and decodes
   * what that share needs.
   *
   * @param {{count: number, starts: ArrayLike<number>, ends: ArrayLike<number>}} runs -
   *   Rows `[starts[r], ends[r])`, in ascending order of start
   * @param {{signal?: AbortSignal|null, activity?: Object|null}} [options]
   * @returns {Promise<Array<unknown>>}
   */
  async rowsOf(runs, options = {}) {
    const type = this.info.type;
    requireDecodable(type, this.path);
    const file = this.tree.file;
    const signal = options.signal ?? null;
    const n = this.shape[0];
    let total = 0;
    for (let r = 0; r < runs.count; r++) {
      const start = runs.starts[r];
      const end = runs.ends[r];
      if (!(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start <= end && end <= n) ||
          (r > 0 && start < runs.starts[r - 1])) {
        throw new RangeError(`${this.path}: rows ${start} to ${end} are not ascending rows of its ${n}.`);
      }
      total += end - start;
    }
    const out = new Array(total);
    if (total === 0) return out;
    const size = type.size;
    const boxes = this.rowBoxes(runs);
    const stream = new HeapStream(file, type, options);
    const windowBytes = file.readAheadBytes();
    let outstanding = 0;
    let wake = null;
    // Box j's references while a part still uses them: its own, and its
    // neighbours' (they name the objects before the rows' own: one
    // collection holds the end of a chunk's strings and the start of the
    // next's). Let go once all three have.
    const references = new Array(boxes.length);
    const users = boxes.map((_, j) => 1 + (j > 0 ? 1 : 0) + (j + 1 < boxes.length ? 1 : 0));
    const used = j => {
      if (--users[j] === 0) references[j] = null;
    };
    /** Settled once box `j`'s references are asked for. */
    const asked = [];
    const untilAsked = j => {
      if (references[j] !== undefined) return Promise.resolve();
      if (asked[j] === undefined) {
        let resolve;
        const promise = new Promise(settle => { resolve = settle; });
        asked[j] = { promise, resolve };
      }
      return asked[j].promise;
    };
    let unread = boxes.length;
    const parts = [];
    for (let k = 0; k < boxes.length; k++) {
      const box = boxes[k];
      const bytes = (box.end - box.start) * size;
      while (outstanding > 0 && outstanding + bytes > windowBytes) await new Promise(resolve => { wake = resolve; });
      throwIfAborted(signal);
      outstanding += bytes;
      // References are not kept past the read (`options.chunks` is not
      // used): a share holds its own rows' strings, not every row's
      // references (160 MB at 10M cells); a later read of other rows (a
      // growth step) reads their chunks again, a fraction of the heap it
      // reads anyway.
      const read = this.reader.read([[box.start, box.end]], options).finally(() => {
        outstanding -= bytes;
        const resume = wake;
        wake = null;
        resume?.();
        // Every box's references in: what waits for the link's room is asked now.
        if (--unread === 0) stream.end();
      });
      read.catch(() => {});
      references[k] = read;
      asked[k]?.resolve();
      // The neighbours' references, once in (one that failed names nothing).
      const beside = Promise.all([k - 1, k + 1].map(j => {
        if (j < 0 || j >= boxes.length) return null;
        return untilAsked(j).then(() => references[j].then(
          chunk => ({ bytes: chunk, count: boxes[j].end - boxes[j].start }),
          () => null,
        )).finally(() => used(j));
      })).then(found => found.filter(other => other !== null));
      const part = read.then(async chunk => {
        // What of each collection the rows need, measured from every
        // reference of the box, and of its neighbours when the box's own do
        // not name every object before the rows' (the collection the
        // previous chunk's strings began): waited for then only.
        const rows = box.pieces.map(row => row - box.start);
        let needs = rowHeapNeeds(file, type, chunk, box.end - box.start, rows);
        if (needs.unnamed > 0 && boxes.length > 1) needs = rowHeapNeeds(file, type, chunk, box.end - box.start, rows, await beside);
        // The box's own rows, one run after another (the whole box when it is one run).
        let picked = chunk;
        if (box.rows !== box.end - box.start) {
          picked = allocateTypedArray(Uint8Array, box.rows * size, `${this.path} kept references`);
          const pieces = box.pieces;
          for (let p = 0, at = 0; p < pieces.length; p += 2) {
            const from = (pieces[p] - box.start) * size;
            const to = (pieces[p + 1] - box.start) * size;
            picked.set(chunk.subarray(from, to), at);
            at += to - from;
          }
        }
        used(k);
        return stream.part(picked, box.rows, needs);
      }).then(values => {
        for (let i = 0; i < values.length; i++) out[box.at + i] = values[i];
      });
      part.catch(() => {});
      parts.push(part);
    }
    await Promise.all(parts);
    return out;
  }

  /**
   * The boxes `rowsOf` reads `runs` in, in order: rows `[start, end)` read,
   * the rows `pieces` (`[from, to, from, to, ...]`) picked out of them,
   * `rows` of those, from output row `at`. A filtered chunk is decoded whole
   * whatever part of it is read, so a box is a whole chunk (read whole, it is
   * not kept in the file's cache as a chunk used in part would be).
   * Unfiltered or unchunked references are read by their bytes: neighbouring
   * runs share a box while the rows between cost less than a request (the
   * link's merge gap) and the box stays within a chunk group.
   */
  rowBoxes(runs) {
    const layout = this.info.layout;
    const size = this.info.type.size;
    const n = this.shape[0];
    const chunkRows = layout.class === 'chunked' && this.info.filters.length > 0 ? layout.chunkDims[0] : null;
    const shaping = this.tree.file.shaping;
    const gapRows = Math.floor(shaping.mergeGapBytes / size);
    const maxRows = Math.max(1, Math.floor(Math.min(shaping.maxRequestBytes, CHUNK_GROUP_BYTES) / size));
    // A run is cut where a chunk (or a box's reach) ends.
    const step = chunkRows ?? maxRows;
    const boxes = [];
    let box = null;
    let at = 0;
    for (let r = 0; r < runs.count; r++) {
      for (let start = runs.starts[r]; start < runs.ends[r];) {
        const end = Math.min(runs.ends[r], (Math.floor(start / step) + 1) * step);
        const joins = box !== null && (chunkRows !== null
          ? Math.floor(start / chunkRows) === Math.floor((box.end - 1) / chunkRows)
          : start - box.end <= gapRows && Math.max(box.end, end) - box.start <= maxRows);
        if (joins) {
          box.end = Math.max(box.end, end);
          box.pieces.push(start, end);
          box.rows += end - start;
        } else {
          box = { start, end, pieces: [start, end], rows: end - start, at };
          boxes.push(box);
        }
        at += end - start;
        start = end;
      }
    }
    if (chunkRows !== null) {
      for (const one of boxes) {
        one.start = Math.floor(one.start / chunkRows) * chunkRows;
        one.end = Math.min(n, one.start + chunkRows);
      }
    }
    return boxes;
  }

  /** Stored (compressed) bytes a read of `selection` fetches (`toFetch`: still to fetch now). */
  async storedBytes(selection, options = {}) {
    const normalized = normalizeSelection(this.shape, selection, this.path);
    return this.reader.storedBytes(normalized, options);
  }

  /** The bands of chunks along the first dimension a read would fetch nothing of now (`DatasetReader.heldChunkBands`). */
  heldChunkBands(options = {}) {
    return this.reader.heldChunkBands(options);
  }

  /** What reading some bands of chunks would read of the chunk index first (`DatasetReader.chunkIndexReads`). */
  chunkIndexReads(options = {}) {
    return this.reader.chunkIndexReads(options);
  }
}

export class Hdf5CompoundArray extends Hdf5Array {
  /**
   * One member of the selected elements, as its own values: a typed array
   * for numbers (an array member's values follow one another per element),
   * an `Array` for strings.
   *
   * @param {string} field
   * @param {import('../store.js').Selection} [selection]
   * @param {{signal?: AbortSignal|null, activity?: Object|null}} [options]
   */
  async readField(field, selection, options = {}) {
    const type = this.info.type;
    const member = type.members.find(candidate => candidate.name === field);
    if (member === undefined) {
      throw new RangeError(`${this.path} has no field '${field}' (fields: ${type.members.map(m => m.name).join(', ')}).`);
    }
    const { bytes, count } = await this.readBytes(selection, options);
    const memberAsCompound = { ...type, members: [member] };
    const value = await this.decodeWithHeap(memberAsCompound, bytes, count, options,
      collections => decodeField(this.tree.file, type, member, bytes, count, collections));
    if (this.shape.length === 0 && member.shape.length === 0 && storeDtype(member.type).kind !== 'opaque') return value[0];
    return value;
  }
}
