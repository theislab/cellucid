/**
 * Dropbox shared file links. A `www.dropbox.com` link answers with a redirect
 * that other sites may not follow, while the same file on
 * `dl.dropboxusercontent.com` allows cross-origin range reads, so the link is
 * rewritten to that host and read in place. Folder links can only be read
 * with a Dropbox sign-in, which Cellucid does not ask for: share the file (an
 * `.h5ad`, or a zipped Zarr store) instead.
 *
 * @module data/sources/providers/dropbox
 */

import { DataSourceError, DataSourceErrorCode } from '../../data-source.js';
import { describeRemoteFile } from '../remote-file.js';
import { fileNameOfUrl } from './http.js';

const CONTENT_HOST = 'dl.dropboxusercontent.com';

/** The content-host URL of a Dropbox file link, `folder:<url>`, or null. */
function parseDropbox(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim().replace(/^folder:/, '');
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== 'www.dropbox.com' && host !== 'dropbox.com' && host !== CONTENT_HOST) return null;
  if (url.pathname.startsWith('/scl/fo/') || url.pathname.startsWith('/sh/')) {
    return `folder:${url.origin}${url.pathname}`;
  }
  if (!url.pathname.startsWith('/scl/fi/') && !url.pathname.startsWith('/s/')) return null;
  url.hostname = CONTENT_HOST;
  url.searchParams.delete('dl');
  url.searchParams.delete('raw');
  url.hash = '';
  return url.href;
}

export default Object.freeze({
  id: 'dropbox',
  label: 'Dropbox',
  capabilities: Object.freeze({
    folders: false,
    private: 'none',
    versions: false,
    write: false,
  }),
  match(input) {
    return parseDropbox(input);
  },
  async open(value, { signal = null, onStep = null } = {}) {
    const parsed = parseDropbox(value);
    if (parsed === null) {
      throw new DataSourceError(
        `"${value}" is not a Dropbox file link.`,
        DataSourceErrorCode.INVALID_FORMAT,
        'link',
        { input: value }
      );
    }
    if (parsed.startsWith('folder:')) {
      throw new DataSourceError(
        'A Dropbox folder link can only be read with a Dropbox sign-in. Share ' +
        'the file itself (an .h5ad, or a zipped Zarr store, .zarr.zip) and ' +
        'paste that link.',
        DataSourceErrorCode.UNSUPPORTED,
        'link',
        { input: value }
      );
    }
    const url = new URL(parsed);
    const name = fileNameOfUrl(url);
    const file = await describeRemoteFile({
      url: url.href,
      id: `dropbox:${encodeURIComponent(`${url.pathname}`)}`,
      name,
      attribution: { title: name, url: url.href },
      signal,
      onStep,
    });
    return { title: name, file, attribution: file.attribution };
  },
});
