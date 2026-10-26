/**
 * Opening a Zarr store: every node's metadata is read up front, in as few
 * round trips as the store allows, so navigation afterwards is synchronous.
 *
 * - The format version is found from the root: `zarr.json` is Zarr v3;
 *   `.zgroup`, `.zarray`, `.zattrs` or `.zmetadata` is Zarr v2. A store that
 *   cannot be listed is asked for `.zmetadata` first, then `zarr.json` only
 *   when that is absent: a consolidated Zarr v2 store opens in one request.
 * - Consolidated metadata (Zarr v2 `.zmetadata`, the `consolidated_metadata`
 *   of a Zarr v3 root `zarr.json`) describes the whole tree in one read. A
 *   store that can be listed (a folder, a ZIP) also has every metadata file
 *   the consolidated copy does not mention read, all in one batch; a store
 *   that cannot be listed (a web host) must be consolidated.
 * - Without consolidated metadata, every metadata file the listing shows is
 *   read at once (a ZIP archive serves them in a few merged requests).
 *
 * Groups that exist only as the parent of other nodes (no metadata of their
 * own) are opened as empty-attribute groups, so no node is lost.
 *
 * @module formats/zarr/open
 */

import { ZarrFormatError } from './errors.js';
import { deepFreeze, parseJson } from './json.js';
import { parseV2Array, parseV3Array } from './metadata.js';
import { createArrayNode } from './array.js';
import { createGroupNode } from './group.js';
import { ByteLru } from './cache.js';
import { createLimiter } from './stores/common.js';
import { releaseIdleDecodeWorkers } from '../io/decode-pool.js';
import { isObjectRecord } from '../../utils/exact-record.js';

const MiB = 1024 * 1024;
const V2_FILES = ['.zgroup', '.zarray', '.zattrs'];
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Chunks decoded at once: enough to use every core, few enough to bound transient memory. */
const DECODE_CONCURRENCY = Math.max(4, Math.min(16, Number(globalThis.navigator?.hardwareConcurrency) || 4));

function jsonOf(bytes, what) {
  let text;
  try {
    text = utf8.decode(bytes);
  } catch (cause) {
    throw new ZarrFormatError(`${what} is not UTF-8 text.`, { cause });
  }
  return parseJson(text, what);
}

function joinPath(directory, file) {
  return directory === '' ? file : `${directory}/${file}`;
}

/** Split a metadata key into its node path and file name. */
function splitKey(key) {
  const slash = key.lastIndexOf('/');
  return slash < 0 ? ['', key] : [key.slice(0, slash), key.slice(slash + 1)];
}

/** Metadata documents of a Zarr v2 store: path -> {zarray, zgroup, zattrs}. */
async function readV2(store, keys, rootFetched, consolidatedWanted, options, storeName) {
  const docs = new Map();
  const put = (key, json) => {
    const [path, file] = splitKey(key);
    if (!V2_FILES.includes(file)) return;
    if (!docs.has(path)) docs.set(path, {});
    docs.get(path)[file] = json;
  };
  let consolidatedBytes = rootFetched.get('.zmetadata');
  if (consolidatedBytes === undefined && consolidatedWanted && (keys === null || keys.has('.zmetadata'))) {
    consolidatedBytes = await store.get('.zmetadata', options);
  }
  const covered = new Set();
  if (consolidatedWanted && consolidatedBytes) {
    const consolidated = jsonOf(consolidatedBytes, `${storeName}/.zmetadata`);
    if (!isObjectRecord(consolidated) || !isObjectRecord(consolidated.metadata)) {
      throw new ZarrFormatError(`${storeName}/.zmetadata has no 'metadata' object.`);
    }
    for (const [key, json] of Object.entries(consolidated.metadata)) {
      // A listed store is the authority on what exists.
      if (keys !== null && !keys.has(key)) continue;
      put(key, json);
      covered.add(key);
    }
  }
  if (keys === null) {
    if (covered.size === 0) {
      // A web host cannot list: only a store that is one array can be read
      // without consolidated metadata.
      const [zarray, zattrs, zgroup] = await store.getMany(['.zarray', '.zattrs', '.zgroup'], options);
      if (zarray === null && zgroup === null) {
        // Not even a root group: nothing is published at this address, or
        // the host hides files whose names start with '.'.
        throw new ZarrFormatError(`${storeName}: no Zarr store is at this address (no zarr.json, .zmetadata, .zgroup or .zarray). Check the address; a GitHub Pages site serves a store's dot-files only when its repository has a .nojekyll file.`);
      }
      if (zarray === null) {
        throw new ZarrFormatError(`${storeName} has no consolidated metadata (.zmetadata), and a web host cannot list its contents. Consolidate the store (zarr.consolidate_metadata) before publishing it.`);
      }
      put('.zarray', jsonOf(zarray, `${storeName}/.zarray`));
      if (zattrs !== null) put('.zattrs', jsonOf(zattrs, `${storeName}/.zattrs`));
    }
    return docs;
  }
  const missing = [...keys].filter(key => V2_FILES.includes(splitKey(key)[1]) && !covered.has(key));
  const bytes = await store.getMany(missing, options);
  missing.forEach((key, i) => {
    if (bytes[i] !== null) put(key, jsonOf(bytes[i], `${storeName}/${key}`));
  });
  return docs;
}

/** Metadata documents of a Zarr v3 store: path -> zarr.json. */
async function readV3(store, keys, rootFetched, consolidatedWanted, options, storeName) {
  const docs = new Map();
  let rootBytes = rootFetched.get('zarr.json');
  if (rootBytes === undefined) rootBytes = await store.get('zarr.json', options);
  if (rootBytes === null) throw new ZarrFormatError(`${storeName} has no root zarr.json.`);
  const root = jsonOf(rootBytes, `${storeName}/zarr.json`);
  if (!isObjectRecord(root)) throw new ZarrFormatError(`${storeName}/zarr.json is not a JSON object.`);
  docs.set('', root);
  const covered = new Set(['zarr.json']);
  const consolidated = consolidatedWanted ? root.consolidated_metadata?.metadata : undefined;
  if (isObjectRecord(consolidated)) {
    const add = (prefix, entries) => {
      for (const [relative, json] of Object.entries(entries)) {
        const path = joinPath(prefix, relative);
        const key = joinPath(path, 'zarr.json');
        if (keys !== null && !keys.has(key)) continue;
        if (!docs.has(path)) docs.set(path, json);
        covered.add(key);
        // A nested group may carry its own consolidated listing, relative to it.
        if (isObjectRecord(json?.consolidated_metadata?.metadata)) add(path, json.consolidated_metadata.metadata);
      }
    };
    add('', consolidated);
  } else if (keys === null && root.node_type === 'group') {
    throw new ZarrFormatError(`${storeName} has no consolidated metadata, and a web host cannot list its contents. Consolidate the store (zarr.consolidate_metadata) before publishing it.`);
  }
  if (keys !== null) {
    const missing = [...keys].filter(key => splitKey(key)[1] === 'zarr.json' && !covered.has(key));
    const bytes = await store.getMany(missing, options);
    missing.forEach((key, i) => {
      if (bytes[i] !== null) docs.set(splitKey(key)[0], jsonOf(bytes[i], `${storeName}/${key}`));
    });
  }
  return docs;
}

/** A path segment some static hosts never serve (Jekyll, GitHub Pages' default, hides them). */
const HIDDEN_SEGMENT = /^[_.]/;

/**
 * For a store read from consolidated metadata on a web host: which arrays lie
 * under a path segment starting with `_` or `.` (anndata's `obs/_index`), and
 * for each, a check that the host serves that part of the store.
 *
 * Without it such a store opens (its metadata is all in the root document)
 * and every chunk under the hidden path answers 404, which a Zarr read must
 * take as an absent chunk, the fill value: names would come back empty, with
 * no error. So the metadata document of the first hidden node on the path is
 * fetched once, by the first read of an array under it and beside that
 * read's own chunk requests, and every read under it waits for the answer
 * alongside its own fetches: a host that serves everything costs one
 * parallel request per hidden node actually read, no round trip in sequence,
 * and opening or listing a store fetches nothing for it. A host that answers
 * it as absent is refused.
 *
 * @returns {Map<string, () => Promise<void>>} array path -> its check
 */
function hiddenPathChecks(store, nodes, storeName) {
  const checks = new Map();
  const byPrefix = new Map();
  const checkOf = (prefix, docKey) => {
    if (byPrefix.has(prefix)) return byPrefix.get(prefix);
    let running = null;
    const check = () => {
      running ??= store.get(docKey).then(bytes => {
        if (bytes !== null) return;
        throw new ZarrFormatError(`${storeName}: the host hides paths that start with "_" or "." ('${docKey}' answers as absent, so '/${prefix}' would read as empty). On GitHub Pages, add an empty .nojekyll file at the root of the site, or open the store through raw.githubusercontent.com or a gh: link, which serve these paths.`);
      }, error => {
        // A failed request (not an answer) is asked again by the next read.
        running = null;
        throw error;
      });
      return running;
    };
    byPrefix.set(prefix, check);
    return check;
  };
  for (const [path, info] of nodes) {
    if (info.kind !== 'array' || path === '') continue;
    const parts = path.split('/');
    const hidden = parts.findIndex(part => HIDDEN_SEGMENT.test(part));
    if (hidden < 0) continue;
    // The first hidden node that has a metadata document of its own.
    let at = hidden;
    let prefix = parts.slice(0, at + 1).join('/');
    while (nodes.get(prefix)?.docKey === undefined && at < parts.length - 1) prefix = parts.slice(0, ++at + 1).join('/');
    const docKey = nodes.get(prefix)?.docKey;
    if (docKey !== undefined) checks.set(path, checkOf(prefix, docKey));
  }
  return checks;
}

/**
 * Open a Zarr store.
 *
 * @param {Object} store - A store backend (`directoryStore`, `zipStore`, `httpStore`, `memoryStore`)
 * @param {{decodedChunkCacheBytes?: number, shardIndexCacheBytes?: number,
 *          version?: 2|3|null, consolidated?: boolean,
 *          signal?: AbortSignal|null, activity?: Object|null}} [options]
 *   `decodedChunkCacheBytes` (default 64 MiB) budgets the decoded chunks kept
 *   between reads; `version` forces a format when a store holds both;
 *   `consolidated: false` ignores consolidated metadata (listed stores only).
 * @returns {Promise<Object>} The root node (a Group, or an ArrayNode for a
 *   store that is a single array), with `close()` and `stats()`
 */
export async function openZarr(store, {
  decodedChunkCacheBytes = 64 * MiB,
  shardIndexCacheBytes = 16 * MiB,
  version = null,
  consolidated = true,
  signal = null,
  activity = null,
} = {}) {
  if (store === null || typeof store !== 'object' || typeof store.get !== 'function' || typeof store.getMany !== 'function') {
    throw new TypeError('openZarr needs a store backend (directoryStore, zipStore, httpStore or memoryStore).');
  }
  const options = { signal, activity };
  const storeName = store.name ?? 'The Zarr store';
  const listing = typeof store.list === 'function' ? await store.list() : null;
  const keys = listing === null ? null : new Set(listing);
  const rootFetched = new Map();

  let format = version;
  if (format === null) {
    if (keys !== null) {
      if (keys.has('zarr.json')) format = 3;
      else if (['.zgroup', '.zarray', '.zattrs', '.zmetadata'].some(key => keys.has(key))) format = 2;
    } else {
      // A store that cannot be listed opens from its consolidated metadata,
      // asked for first as Zarr v2 writes it (`.zmetadata`, what anndata,
      // cellucid.prepare() and cellucid_prepare() write by default): such a
      // store opens in one request and no request is answered 404. Only
      // without it is the store asked for a Zarr v3 root (`zarr.json`).
      const zmetadata = await store.get('.zmetadata', options);
      rootFetched.set('.zmetadata', zmetadata);
      if (zmetadata !== null) {
        format = 2;
      } else {
        const zarrJson = await store.get('zarr.json', options);
        if (zarrJson !== null) {
          format = 3;
          rootFetched.set('zarr.json', zarrJson);
        } else {
          format = 2;
        }
      }
    }
    if (format === null) {
      throw new ZarrFormatError(`${storeName} is not a Zarr store: it has no zarr.json, .zgroup, .zarray or .zmetadata at its root.`);
    }
  }
  if (format !== 2 && format !== 3) throw new TypeError('openZarr: version must be 2 or 3.');

  const context = {
    decoded: new ByteLru(decodedChunkCacheBytes),
    indexes: new ByteLru(shardIndexCacheBytes),
    inflight: new Map(),
    decodeLimit: createLimiter(DECODE_CONCURRENCY),
    stats: { chunksDecoded: 0, decodedBytes: 0, cacheHits: 0, sharedChunks: 0 },
    closed: false,
  };

  // Every node: path -> {kind, attrs, array metadata}.
  const nodes = new Map();
  if (format === 2) {
    const docs = await readV2(store, keys, rootFetched, consolidated, options, storeName);
    for (const [path, doc] of docs) {
      const what = `The Zarr array '/${path}'`;
      if (doc['.zarray'] !== undefined && doc['.zgroup'] !== undefined) {
        throw new ZarrFormatError(`'/${path}' is both an array (.zarray) and a group (.zgroup).`);
      }
      if (doc['.zgroup'] !== undefined && doc['.zgroup']?.zarr_format !== 2) {
        throw new ZarrFormatError(`'/${path}/.zgroup' must declare "zarr_format": 2.`);
      }
      const attrs = doc['.zattrs'] ?? {};
      if (!isObjectRecord(attrs)) throw new ZarrFormatError(`'/${path}/.zattrs' is not a JSON object.`);
      const docFile = ['.zarray', '.zgroup', '.zattrs'].find(file => doc[file] !== undefined);
      nodes.set(path, doc['.zarray'] !== undefined
        ? { kind: 'array', attrs, meta: parseV2Array(doc['.zarray'], `/${path}`, what), docKey: joinPath(path, docFile) }
        : { kind: 'group', attrs, docKey: joinPath(path, docFile) });
    }
  } else {
    const docs = await readV3(store, keys, rootFetched, consolidated, options, storeName);
    for (const [path, doc] of docs) {
      if (!isObjectRecord(doc) || doc.zarr_format !== 3) {
        throw new ZarrFormatError(`'/${joinPath(path, 'zarr.json')}' must declare "zarr_format": 3.`);
      }
      const attrs = doc.attributes ?? {};
      if (!isObjectRecord(attrs)) throw new ZarrFormatError(`'/${path}': attributes must be a JSON object.`);
      const docKey = joinPath(path, 'zarr.json');
      if (doc.node_type === 'array') {
        nodes.set(path, { kind: 'array', attrs, meta: parseV3Array(doc, `/${path}`, `The Zarr array '/${path}'`), docKey });
      } else if (doc.node_type === 'group') {
        nodes.set(path, { kind: 'group', attrs, docKey });
      } else {
        throw new ZarrFormatError(`'/${path}': node_type must be 'group' or 'array'.`);
      }
    }
  }
  if (!nodes.has('')) {
    if (nodes.size === 0) throw new ZarrFormatError(`${storeName} holds no Zarr metadata.`);
    nodes.set('', { kind: 'group', attrs: {} });
  }
  // Parents that have no metadata of their own.
  for (const path of [...nodes.keys()]) {
    const parts = path === '' ? [] : path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      if (!nodes.has(parent)) nodes.set(parent, { kind: 'group', attrs: {} });
    }
  }

  const rootExtra = {
    zarrFormat: format,
    close() {
      context.closed = true;
      context.decoded.clear();
      context.indexes.clear();
      context.inflight.clear();
      releaseIdleDecodeWorkers();
    },
    stats() {
      return {
        ...store.stats(),
        ...context.stats,
        cachedChunkBytes: context.decoded.bytes,
      };
    },
  };

  const served = keys === null ? hiddenPathChecks(store, nodes, storeName) : new Map();

  const built = new Map();
  const childrenOf = new Map();
  // Parents before children: sorting by depth.
  const ordered = [...nodes.keys()].sort((a, b) => (a === '' ? 0 : a.split('/').length) - (b === '' ? 0 : b.split('/').length));
  for (const path of ordered) {
    const info = nodes.get(path);
    const absolute = `/${path}`;
    const name = path === '' ? '' : path.slice(path.lastIndexOf('/') + 1);
    const attrs = deepFreeze(info.attrs);
    const extra = path === '' ? rootExtra : {};
    let node;
    if (info.kind === 'array') {
      if (path === '') {
        const arrayNode = createArrayNode({ path: absolute, name, attrs, meta: info.meta, store, context, served: served.get(path) ?? null });
        node = Object.freeze({ ...arrayNode, ...rootExtra });
      } else {
        node = createArrayNode({ path: absolute, name, attrs, meta: info.meta, store, context, served: served.get(path) ?? null });
      }
    } else {
      const children = new Map();
      childrenOf.set(path, children);
      node = createGroupNode({ path: absolute, name, attrs, children, extra });
    }
    built.set(path, node);
    if (path !== '') {
      const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      const siblings = childrenOf.get(parentPath);
      if (siblings === undefined) throw new ZarrFormatError(`'/${path}' lies inside the array '/${parentPath}'.`);
      siblings.set(name, node);
    }
  }
  return built.get('');
}
