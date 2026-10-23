/**
 * The store's groups and arrays (formats/store.js) over a loaded HDF5 file.
 *
 * Navigation is synchronous: every object was loaded at open. Nodes are made
 * on first access and kept by path, so asking twice gives the same node.
 * The same object reached by two paths (two hard links, or a soft link) is
 * two nodes sharing one object: its chunk index is read once either way.
 *
 * - Hard links lead to the object they name.
 * - Soft links resolve inside the file, absolute or relative to their group;
 *   one that leads nowhere (or in a circle) reads as absent (`null`).
 * - External links and user-defined links throw `Hdf5UnsupportedError` when
 *   followed; they are listed in `keys()` like any other link.
 * - Committed (named) datatypes are not arrays or groups: they are not
 *   listed and read as absent.
 *
 * @module formats/hdf5/nodes
 */

import { compareNames, normalizeSelection, pathParts } from '../store.js';
import { storeDtype, requireDecodable, containsVariableLength } from './datatype.js';
import { decodeElements, decodeField, heapAddresses } from './decode.js';
import { withCollections } from './heaps.js';
import { filterName } from './filters.js';
import { DatasetReader } from './read-plan.js';
import { Hdf5UnsupportedError } from './errors.js';

function joinPath(parent, name) {
  return parent === '/' ? `/${name}` : `${parent}/${name}`;
}

/** Shared state of one open file's nodes. */
export class Hdf5Tree {
  /**
   * @param {import('./context.js').FileContext} file
   * @param {Map<number, import('./load.js').ObjectInfo>} objects
   * @param {number} rootAddress
   */
  constructor(file, objects, rootAddress) {
    this.file = file;
    this.objects = objects;
    this.rootAddress = rootAddress;
    this.nodes = new Map();
    this.readers = new Map();
  }

  /** The node of the object at `address`, reached as `path`. */
  node(address, path) {
    let node = this.nodes.get(path);
    if (node !== undefined) return node;
    const info = this.objects.get(address);
    if (info === undefined || info.kind === 'datatype' || info.kind === 'unknown') return null;
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
      if (attribute.error === null) attrs[attribute.name] = attribute.value;
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
    this.links = new Map();
    for (const link of info.links ?? []) this.links.set(link.name, link);
    this.sortedKeys = null;
  }

  keys() {
    if (this.sortedKeys === null) {
      const names = [];
      for (const [name, link] of this.links) {
        if (link.type === 'hard') {
          const kind = this.tree.objects.get(link.address)?.kind;
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

export class Hdf5Array extends Hdf5Node {
  constructor(tree, info, path, name) {
    super(tree, info, path, name);
    this.kind = 'array';
    const space = info.space;
    this.shape = Object.freeze(space.kind === 'null' ? [0] : space.dims.slice());
    this.dtype = storeDtype(info.type);
    const layout = info.layout;
    this.chunks = layout.class === 'chunked' ? Object.freeze(layout.chunkDims.slice()) : null;
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
    const { bytes, count } = await this.readBytes(selection, options);
    const type = this.info.type;
    const value = await this.decodeWithHeap(type, bytes, count, options,
      collections => decodeElements(this.tree.file, type, bytes, count, collections));
    if (this.shape.length === 0 && this.info.space.kind === 'scalar') {
      if (this.dtype.arrayShape !== undefined || (this.dtype.kind === 'opaque' && this.dtype.sequence === undefined)) return value;
      return value[0];
    }
    return value;
  }

  /** Stored (compressed) bytes a read of `selection` fetches. */
  async storedBytes(selection, options = {}) {
    const normalized = normalizeSelection(this.shape, selection, this.path);
    return this.reader.storedBytes(normalized, options);
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
