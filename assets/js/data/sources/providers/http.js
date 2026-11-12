/**
 * Any web address: a dataset catalog folder (a URL ending in "/", or its
 * `datasets.json`), a Zarr store folder (`….zarr/`, read through its
 * consolidated metadata), or one dataset file of any single-file input
 * format (`data/input-formats.js`; `remote-file.js`). Covers buckets (S3,
 * R2, GCS, B2; `s3://` and `gs://` URIs are read at their HTTPS address,
 * `storageUriAddress`), lab servers, GitHub Pages, and direct file links
 * from storage services. The host must allow cross-origin
 * reads (CORS); nothing here signs in.
 *
 * @module data/sources/providers/http
 */

import { DataSourceError, DataSourceErrorCode } from '../../data-source.js';
import { describeRemoteFile } from '../remote-file.js';
import { folderFormatOfName, storeFolderOfPath, titleOfName } from '../../input-formats.js';
import { linkIdentity, publicLink } from '../link-credentials.js';

/**
 * The HTTPS address of a cloud storage URI (`s3://bucket/key`,
 * `gs://bucket/key`, as AWS, Google Cloud and the CELLxGENE Census hand
 * them out), or null when `text` is none: an S3 object at its bucket's
 * virtual-hosted address on S3's global endpoint, which answers from the
 * bucket's region (a bucket whose name holds a dot, which no certificate of
 * that form covers, path-style instead); a Google Cloud Storage object at
 * `storage.googleapis.com`. Whether a page may read it is the bucket's CORS
 * setting, as for any address.
 */
function storageUriAddress(text) {
  const uri = /^(s3|gs):\/\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?$/i.exec(text);
  if (uri === null) return null;
  const [, scheme, bucket, rest = '/', query = ''] = uri;
  if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket)) return null;
  const path = rest.split('/').map(segment => encodeURIComponent(decodeURIComponent(segment))).join('/');
  if (scheme.toLowerCase() === 'gs') return `https://storage.googleapis.com/${bucket}${path}${query}`;
  return bucket.includes('.') ? `https://s3.amazonaws.com/${bucket}${path}${query}` : `https://${bucket}.s3.amazonaws.com${path}${query}`;
}

function parseHttpUrl(input) {
  if (typeof input !== 'string') return null;
  let url;
  try {
    const text = input.trim();
    url = new URL(storageUriAddress(text) ?? text);
  } catch {
    return null;
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== ''
  ) {
    return null;
  }
  url.hash = '';
  // An address inside a store folder (`…/atlas.zarr/.zmetadata`, copied
  // from a host's file listing) is the store. A signed address names its
  // one object and is kept as it is.
  const store = url.search === '' ? storeFolderOfPath(url.pathname) : null;
  if (store !== null) url.pathname = `${store}/`;
  return url;
}

/**
 * The file name a URL names: its last path segment, or the one before a
 * trailing `content` segment (`.../files/<name>/content`, as Zenodo's API).
 */
export function fileNameOfUrl(url) {
  const segments = url.pathname.split('/').filter(Boolean).map(segment => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
  const last = segments.at(-1) ?? url.host;
  return last === 'content' && segments.length >= 2 ? segments.at(-2) : last;
}

export default Object.freeze({
  id: 'url',
  label: 'Web address',
  capabilities: Object.freeze({
    folders: true,
    private: 'none',
    public: false,
    versions: false,
    write: false,
  }),
  match(input) {
    return parseHttpUrl(input)?.href ?? null;
  },
  /** What the address may be shown and kept as (`link-credentials.js`). */
  publicValue(value) {
    return publicLink(value);
  },
  async open(value, { signal = null, onStep = null } = {}) {
    const url = parseHttpUrl(value);
    if (url === null) {
      throw new DataSourceError(
        `"${value}" is not an http(s) address.`,
        DataSourceErrorCode.INVALID_FORMAT,
        'link',
        { input: value }
      );
    }
    // A Zarr store folder (`…/name.zarr` or `…/name.zarr/`), read in place
    // through its consolidated metadata.
    if (folderFormatOfName(url.pathname) !== null) {
      // The folder path ends in "/"; a query string (a signed URL) is kept.
      const path = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
      const folderUrl = `${url.origin}${path}${url.search}`;
      // What the folder is (its identity) and where it is said to come from
      // (its public form): neither holds a credential (`link-credentials.js`),
      // so a link signed again is the same dataset and no signature is saved
      // in a session, a figure or a cache.
      const name = fileNameOfUrl(url);
      return {
        title: name,
        store: {
          url: folderUrl,
          name,
          title: titleOfName(name),
          id: `url:${encodeURIComponent(linkIdentity(folderUrl))}`,
          attribution: { title: name, url: publicLink(folderUrl) },
        },
        attribution: { title: name, url: publicLink(folderUrl) },
      };
    }
    const isCatalogFile = url.pathname.endsWith('/datasets.json');
    if (url.pathname.endsWith('/') || isCatalogFile) {
      if (url.search !== '') {
        throw new DataSourceError(
          'A dataset catalog folder is opened by its plain address, ' +
          'without a query string.',
          DataSourceErrorCode.INVALID_FORMAT,
          'link',
          { input: value }
        );
      }
      const baseUrl = isCatalogFile
        ? url.href.slice(0, -'datasets.json'.length)
        : url.href;
      return {
        title: baseUrl,
        catalog: { baseUrl },
        attribution: { title: url.host, url: baseUrl },
      };
    }
    const name = fileNameOfUrl(url);
    // The file's id (its identity) and attribution (its public form): no
    // credential in either.
    const file = await describeRemoteFile({
      url: url.href,
      id: `url:${encodeURIComponent(linkIdentity(url.href))}`,
      name,
      attribution: { title: name, url: publicLink(url.href) },
      signal,
      onStep,
    });
    return { title: name, file, attribution: file.attribution };
  },
});
