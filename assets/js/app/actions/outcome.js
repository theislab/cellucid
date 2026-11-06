/**
 * @fileoverview An action's outcome as plain JSON data: what an agent's tool
 * result (`agent/bridge/mcp-content.js`) and a host's `action_result`
 * (`viewer-host/command-handler.js`, `data/viewer-protocol.js`) carry.
 *
 * An outcome is made by the action's implementation for the page; what
 * crosses a boundary is JSON. Values JSON cannot carry are converted, never
 * dropped silently: a typed array becomes an array, a Map an object (or
 * pairs), a Set an array, a BigInt its decimal text, a Date its ISO time, a
 * number that is not finite null, an `undefined` entry is left out. A
 * picture (a `Blob` of an image type anywhere in it) is moved to `images`
 * and the JSON says where it was (`{"image": 1, "mimeType": "image/png",
 * "bytes": …}`); another Blob is named by its type and size.
 *
 * Converting after the action ran never fails on a value the action made, so
 * an action that changed the viewer is never answered as if it had not; only
 * an outcome that refers to itself is refused.
 *
 * @module app/actions/outcome
 */

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function isBlob(value) {
  return typeof Blob === 'function' && value instanceof Blob;
}

/**
 * `value` as plain JSON data, with every image Blob in it moved to `images`.
 *
 * @param {unknown} value
 * @param {Blob[]} [images] - where the pictures go, in the order met
 * @param {Set<object>} [path] - the objects being converted (a cycle is refused)
 * @returns {unknown}
 */
export function outcomeAsJson(value, images = [], path = new Set()) {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case 'string': case 'boolean': return value;
    case 'number': return Number.isFinite(value) ? value : null;
    case 'bigint': return value.toString();
    case 'function': case 'symbol': return null;
    default: break;
  }
  if (path.has(value)) throw new TypeError('The result refers to itself and cannot be written as JSON');
  if (isBlob(value)) {
    if (IMAGE_TYPES.has(value.type)) {
      images.push(value);
      return { image: images.length, mimeType: value.type, bytes: value.size };
    }
    return { file: value.type || 'application/octet-stream', bytes: value.size };
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (ArrayBuffer.isView(value)) {
    return Array.from(value, item => (typeof item === 'bigint' ? item.toString() : outcomeAsJson(item)));
  }
  if (value instanceof ArrayBuffer) return { bytes: value.byteLength };
  path.add(value);
  try {
    // `Array.from` visits a hole as undefined (null in JSON); `map` would keep it.
    if (Array.isArray(value)) return Array.from(value, item => outcomeAsJson(item, images, path));
    if (value instanceof Set) return [...value].map(item => outcomeAsJson(item, images, path));
    if (value instanceof Map) {
      const entries = [...value.entries()];
      return entries.every(([key]) => typeof key === 'string')
        ? Object.fromEntries(entries.map(([key, item]) => [key, outcomeAsJson(item, images, path)]))
        : entries.map(([key, item]) => [outcomeAsJson(key, images, path), outcomeAsJson(item, images, path)]);
    }
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
      // A plain property, never the prototype (an outcome key "__proto__").
      Object.defineProperty(out, key, {
        value: outcomeAsJson(item, images, path), enumerable: true, writable: true, configurable: true,
      });
    }
    return out;
  } finally {
    path.delete(value);
  }
}
