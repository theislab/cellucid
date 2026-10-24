/**
 * @fileoverview What the Session panel's address bar opens: a Cellucid
 * server (`cellucid serve`) or linked data (a file, a Zarr store, a dataset
 * catalog, or a repository record a provider knows).
 *
 * The decision is made from the text alone wherever the text settles it, in
 * this order:
 *
 * 1. A port number (`8765`) is a server on this computer:
 *    `http://localhost:8765`.
 * 2. An address without a scheme whose host is this computer (`localhost`,
 *    `127.0.0.1`, `[::1]`) or that ends in a port (`lab-server:8765`) is a
 *    server reached over `http://`.
 * 3. A provider's own form (`hf:user/repo`, `GSE123456`, a DOI, a CELLxGENE,
 *    Zenodo, Figshare, Google Drive, OneDrive, Dropbox, Hugging Face or
 *    GitHub address, `owner/repo/path`) is
 *    linked data.
 * 4. A web address that names a file or store (a name `data/input-formats.js`
 *    knows: `.h5ad`, `.zip`, `.zarr`; or `datasets.json`), carries a query
 *    string or a fragment is linked data.
 * 5. A web address of this computer with no path is a server.
 * 6. Any other web address is asked: a Cellucid server answers its health
 *    endpoint, and anything else (a folder of datasets on a web host, a file
 *    behind a download link) is linked data.
 *
 * So the same text always goes to the same place, and the one case the text
 * cannot settle is settled by what the address answers.
 *
 * @module ui/modules/address-routing
 */

import { getProviderRegistry } from '../../../data/sources/registry.js';
import { fileFormatOfName, folderFormatOfName } from '../../../data/input-formats.js';

/** A port number, as `cellucid serve --port` takes it. */
function asPort(text) {
  if (!/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const SCHEMELESS_SERVER = /^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?(\/[^?#]*)?$/i;
/** Whether a path names a dataset file, a store folder or a catalog. */
function namesData(pathname) {
  return fileFormatOfName(pathname) !== null || folderFormatOfName(pathname) !== null ||
    /\/datasets\.json$/i.test(pathname);
}

/** The one canonical spelling a server address is connected by. */
function serverBase(url) {
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

function invalid(message) {
  return Object.freeze({ kind: 'invalid', message });
}

function server(url) {
  return Object.freeze({ kind: 'server', url });
}

function link(value) {
  return Object.freeze({ kind: 'link', value });
}

/**
 * Decide what one typed address opens.
 *
 * @param {string} text
 * @param {{registry?: import('../../../data/sources/registry.js').ProviderRegistry}} [options]
 * @returns {Readonly<
 *   {kind: 'server', url: string} |
 *   {kind: 'link', value: string} |
 *   {kind: 'ask', url: string, value: string} |
 *   {kind: 'invalid', message: string}
 * >} `ask`: a server when `url` answers as one, else the link `value`.
 */
export function routeAddress(text, { registry = getProviderRegistry() } = {}) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return invalid(
      'Type an address first: a link or id (a CELLxGENE link, GSE123456, a DOI, '
      + 'hf:user/repo, a file address) or a server (localhost:8765).'
    );
  }
  const value = text.trim();

  const port = asPort(value);
  if (port !== null) return server(`http://localhost:${port}`);

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const match = SCHEMELESS_SERVER.exec(value);
    if (match !== null) {
      const host = match[1].toLowerCase();
      if (match[2] !== undefined && asPort(match[2]) === null && registry.get(host) === null) {
        return invalid(`${match[2]} is not a port: a port is a number from 1 to 65535, as in localhost:8765.`);
      }
      const hasPort = match[2] !== undefined;
      // `zenodo:123` is a provider's short form, not a host and port.
      if ((LOOPBACK_HOSTS.has(host) || hasPort) && registry.get(host) === null) {
        return server(serverBase(new URL(`http://${value}`)));
      }
    }
    return link(value);
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    return link(value);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return link(value);
  let provider = null;
  try {
    provider = registry.resolve(value).provider;
  } catch {
    provider = null;
  }
  if (provider !== null && provider.id !== 'url') return link(value);
  if (
    namesData(url.pathname) ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    return link(value);
  }
  if (LOOPBACK_HOSTS.has(url.hostname) || LOOPBACK_HOSTS.has(`[${url.hostname}]`)) {
    if (url.pathname === '/') return server(serverBase(url));
  }
  return Object.freeze({ kind: 'ask', url: serverBase(url), value });
}
