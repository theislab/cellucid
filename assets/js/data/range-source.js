/**
 * @fileoverview Random-access byte sources: the one seam every lazy reader
 * (the AnnData reader worker's h5ad and Zarr loaders) reads files through.
 *
 * A source has an exact `size`, a `name`, an `identity` that names its exact
 * content for cache keys, and `readInto(target, position)`, a synchronous
 * read of `target.length` bytes at `position` into `target` (h5wasm's file
 * system calls are synchronous, so the h5ad reader needs one). Nothing reads
 * a whole file: a reader asks for the byte ranges it needs.
 *
 * - `BlobRangeSource` reads a local `File`/`Blob` with `FileReaderSync`, which
 *   exists only in workers; the AnnData reader always runs in one.
 * - `BytesRangeSource` reads bytes already in memory.
 * - `PageCachedRangeSource` keeps recently read small ranges (HDF5 B-tree,
 *   heap and attribute reads are many and tiny) in a bounded page cache.
 *
 * A future remote provider (HTTP Range, object stores, cloud drives) is one
 * more class with the same three members; see
 * `cellucid-private/plans/limits-inventory.md` §7.
 *
 * @module data/range-source
 */

/**
 * Validate one source and return it.
 *
 * @param {unknown} source
 * @returns {{size: number, name: string, identity: Object, readInto: Function}}
 */
export function requireRangeSource(source) {
  if (
    source === null ||
    typeof source !== 'object' ||
    !Number.isSafeInteger(source.size) ||
    source.size < 0 ||
    typeof source.readInto !== 'function' ||
    typeof source.name !== 'string'
  ) {
    throw new TypeError(
      'A range source needs an exact size, a name and a synchronous readInto(target, position).'
    );
  }
  return source;
}

function requireRange(source, target, position) {
  if (!(target instanceof Uint8Array)) {
    throw new TypeError('A range read target must be a Uint8Array.');
  }
  if (!Number.isSafeInteger(position) || position < 0 ||
      position + target.length > source.size) {
    throw new RangeError(
      `Read of ${target.length} bytes at ${String(position)} lies outside the ${source.size}-byte source.`
    );
  }
}

/**
 * A local `File` or `Blob`, read synchronously in a worker.
 */
export class BlobRangeSource {
  /**
   * @param {Blob} blob
   * @param {{name?: string}} [options]
   */
  constructor(blob, { name } = {}) {
    if (typeof blob?.slice !== 'function' || !Number.isSafeInteger(blob.size)) {
      throw new TypeError('BlobRangeSource needs a File or Blob.');
    }
    this._blob = blob;
    this._reader = null;
    this.size = blob.size;
    this.name = name ?? (typeof blob.name === 'string' ? blob.name : '');
    this.identity = Object.freeze({
      kind: 'file',
      name: this.name,
      size: blob.size,
      lastModified: Number.isFinite(blob.lastModified) ? blob.lastModified : null,
    });
  }

  readInto(target, position) {
    requireRange(this, target, position);
    if (target.length === 0) return 0;
    this._reader ??= new FileReaderSync();
    const buffer = this._reader.readAsArrayBuffer(
      this._blob.slice(position, position + target.length)
    );
    if (buffer.byteLength !== target.length) {
      throw new Error(
        `${this.name || 'File'} returned ${buffer.byteLength} of ${target.length} bytes at ${position}; it may have changed on disk.`
      );
    }
    target.set(new Uint8Array(buffer));
    return target.length;
  }
}

/**
 * Bytes already in memory.
 */
export class BytesRangeSource {
  /**
   * @param {Uint8Array} bytes
   * @param {{name?: string, identity?: Object}} [options]
   */
  constructor(bytes, { name = '', identity = null } = {}) {
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError('BytesRangeSource needs a Uint8Array.');
    }
    this._bytes = bytes;
    this.size = bytes.length;
    this.name = name;
    this.identity = identity ?? Object.freeze({ kind: 'bytes', name, size: bytes.length });
  }

  readInto(target, position) {
    requireRange(this, target, position);
    target.set(this._bytes.subarray(position, position + target.length));
    return target.length;
  }
}

/** Page size of `PageCachedRangeSource`. */
const PAGE_BYTES = 64 * 1024;

/**
 * A source whose small reads are served from a least-recently-used cache of
 * aligned pages. Reads of at least one page go straight to the source (HDF5
 * reads a compressed chunk once and caches the decoded chunk itself), so the
 * cache holds what is read repeatedly: superblock, object headers, B-tree
 * nodes and heaps. `maxBytes` is a cache budget, never a limit on reads.
 */
export class PageCachedRangeSource {
  /**
   * @param {{size: number, name: string, identity: Object, readInto: Function}} source
   * @param {{maxBytes?: number}} [options]
   */
  constructor(source, { maxBytes = 16 * 1024 * 1024 } = {}) {
    this._source = requireRangeSource(source);
    this._pages = new Map();
    this._maxPages = Math.max(4, Math.floor(maxBytes / PAGE_BYTES));
    this.size = source.size;
    this.name = source.name;
    this.identity = source.identity;
    this.reads = 0;
    this.bytesRead = 0;
  }

  _page(index) {
    let page = this._pages.get(index);
    if (page !== undefined) {
      this._pages.delete(index);
      this._pages.set(index, page);
      return page;
    }
    const start = index * PAGE_BYTES;
    page = new Uint8Array(Math.min(PAGE_BYTES, this.size - start));
    this._source.readInto(page, start);
    this.reads++;
    this.bytesRead += page.length;
    this._pages.set(index, page);
    if (this._pages.size > this._maxPages) {
      this._pages.delete(this._pages.keys().next().value);
    }
    return page;
  }

  readInto(target, position) {
    requireRange(this, target, position);
    const length = target.length;
    if (length >= PAGE_BYTES) {
      this._source.readInto(target, position);
      this.reads++;
      this.bytesRead += length;
      return length;
    }
    let written = 0;
    while (written < length) {
      const at = position + written;
      const index = Math.floor(at / PAGE_BYTES);
      const page = this._page(index);
      const offset = at - index * PAGE_BYTES;
      const count = Math.min(length - written, page.length - offset);
      target.set(page.subarray(offset, offset + count), written);
      written += count;
    }
    return length;
  }

  /** Drop every cached page. */
  clear() {
    this._pages.clear();
  }
}

/**
 * Mount one source as a read-only file of an Emscripten file system, so a
 * WASM library (h5wasm) reads it through its POSIX calls without a copy.
 * Emscripten's own WORKERFS does the same for Blobs only and asserts a
 * classic worker; this node takes any range source and also runs in tests.
 *
 * @param {Object} FS - The Emscripten `FS` object
 * @param {string} path - Absolute path of a new file in the root directory
 * @param {{size: number, readInto: Function}} source
 * @returns {() => void} Unmount: removes the file
 */
export function mountRangeSource(FS, path, source) {
  requireRangeSource(source);
  if (typeof path !== 'string' || !/^\/[^/]+$/.test(path)) {
    throw new TypeError('A mounted range source needs an absolute root-level path.');
  }
  const size = source.size;
  const root = FS.lookupPath('/').node;
  const node = FS.createNode(root, path.slice(1), 0o100444, 0);
  const timestamp = Date.now();
  node.size = size;
  node.timestamp = timestamp;
  node.node_ops = {
    getattr(target) {
      const date = new Date(timestamp);
      return {
        dev: 1,
        ino: target.id,
        mode: target.mode,
        nlink: 1,
        uid: 0,
        gid: 0,
        rdev: 0,
        size,
        atime: date,
        mtime: date,
        ctime: date,
        blksize: 4096,
        blocks: Math.ceil(size / 4096),
      };
    },
    setattr() {
      throw new FS.ErrnoError(63);
    },
  };
  node.stream_ops = {
    read(stream, buffer, offset, length, position) {
      if (position >= size) return 0;
      const count = Math.min(length, size - position);
      // Emscripten hands HEAP8 (an Int8Array); read through a byte view of it.
      return source.readInto(
        new Uint8Array(buffer.buffer, buffer.byteOffset + offset, count),
        position
      );
    },
    write() {
      throw new FS.ErrnoError(63);
    },
    llseek(stream, offset, whence) {
      let position = offset;
      if (whence === 1) position += stream.position;
      else if (whence === 2) position += size;
      if (position < 0) throw new FS.ErrnoError(28);
      return position;
    },
  };
  let mounted = true;
  return () => {
    if (!mounted) return;
    mounted = false;
    FS.unlink(path);
  };
}
