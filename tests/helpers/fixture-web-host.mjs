/**
 * A web host for Node contract tests: `fetch` answers from files on disk
 * under one URL prefix, with HEAD, byte ranges (206 + Content-Range) and 404
 * as a static host answers them, so a dataset catalog and the AnnData files
 * it lists are read exactly as the browser reads them from a server. A Zarr
 * store folder `<name>.zarr/` is served from the fixture `<name>.zarr.zip`
 * beside it, unpacked in memory: a fixture store is kept once, zipped.
 */

/**
 * The bytes of `path` inside a Zarr store folder served from its zipped
 * fixture, or null when `path` is not in one.
 */
async function zippedFolderFile(root, path) {
  const match = /^(.*?\.zarr)\/(.*)$/.exec(path);
  if (match === null) return null;
  const zipPath = fileURLToPath(new URL(`${match[1]}.zip`, root));
  if (!existsSync(zipPath)) return null;
  return (await zippedStoreEntries(zipPath)).get(match[2]) ?? null;
}

import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { zippedStoreEntries } from './zarr-corpus.mjs';

/**
 * @param {import('node:test').TestContext} t
 * @param {{prefix: string, root: URL, files?: Map<string, Uint8Array|string>}} options
 *   `prefix` (ending in '/') maps to the directory `root`; `files` adds or
 *   replaces documents by path below the prefix.
 * @returns {{requests: Array<{url: string, method: string, range: string|null}>}}
 */
export function serveFixtureHost(t, { prefix, root, files = new Map() }) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init.headers ?? {});
    const method = init.method ?? 'GET';
    const range = headers.get('Range') ?? headers.get('range');
    requests.push({ url, method, range });
    if (init.signal?.aborted) throw init.signal.reason ?? new DOMException('Aborted', 'AbortError');
    if (!url.startsWith(prefix)) return new Response('not found', { status: 404 });
    const path = decodeURIComponent(new URL(url).pathname.slice(new URL(prefix).pathname.length));
    let bytes;
    if (files.has(path)) {
      const value = files.get(path);
      bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    } else {
      const zipped = await zippedFolderFile(root, path);
      if (zipped !== null) {
        bytes = zipped;
      } else {
        const file = new URL(path, root);
        try {
          if (!statSync(file).isFile()) return new Response('not found', { status: 404 });
          bytes = new Uint8Array(readFileSync(file));
        } catch {
          return new Response('not found', { status: 404 });
        }
      }
    }
    if (method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'Content-Length': String(bytes.byteLength) } });
    }
    if (range !== null) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      const start = Number(match[1]);
      const end = match[2] === '' ? bytes.byteLength - 1 : Math.min(Number(match[2]), bytes.byteLength - 1);
      return new Response(bytes.slice(start, end + 1), {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${bytes.byteLength}`,
          'Content-Length': String(end - start + 1),
        },
      });
    }
    return new Response(bytes, { status: 200, headers: { 'Content-Length': String(bytes.byteLength) } });
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return { requests };
}
