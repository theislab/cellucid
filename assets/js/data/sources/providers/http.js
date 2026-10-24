/**
 * Any web address: a dataset catalog folder (a URL ending in "/", or its
 * `datasets.json`), a Zarr store folder (`….zarr/`, read through its
 * consolidated metadata), or one `.h5ad` / Zarr ZIP file read in place with
 * range requests. Covers buckets (S3, R2, GCS, B2), lab servers, GitHub Pages, and
 * direct file links from storage services. The host must allow cross-origin
 * reads (CORS); nothing here signs in.
 *
 * @module data/sources/providers/http
 */

import { DataSourceError, DataSourceErrorCode } from '../../data-source.js';
import { describeRemoteFile } from '../remote-file.js';

function parseHttpUrl(input) {
  if (typeof input !== 'string') return null;
  let url;
  try {
    url = new URL(input.trim());
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
    versions: false,
    write: false,
  }),
  match(input) {
    return parseHttpUrl(input)?.href ?? null;
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
    if (/\.zarr\/?$/i.test(url.pathname)) {
      // The folder path ends in "/"; a query string (a signed URL) is kept.
      const path = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
      const folderUrl = `${url.origin}${path}${url.search}`;
      const name = fileNameOfUrl(url);
      return {
        title: name,
        store: {
          url: folderUrl,
          name,
          title: name.replace(/\.zarr$/i, ''),
          id: `url:${encodeURIComponent(folderUrl)}`,
          attribution: { title: name, url: folderUrl },
        },
        attribution: { title: name, url: folderUrl },
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
    const file = await describeRemoteFile({
      url: url.href,
      id: `url:${encodeURIComponent(url.href)}`,
      name,
      attribution: { title: name, url: url.href },
      signal,
      onStep,
    });
    return { title: name, file, attribution: file.attribution };
  },
});
