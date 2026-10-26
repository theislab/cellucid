/**
 * Dropbox shared file links. A `www.dropbox.com` link answers with a redirect
 * that other sites may not follow, while the same file on
 * `dl.dropboxusercontent.com` allows cross-origin range reads, so the file
 * is read in place from that host. The share link names it (`?data=`,
 * sessions); the content-host address is only where its bytes come from. Folder links can only be read
 * with a Dropbox sign-in, which Cellucid does not ask for: share the file (an
 * `.h5ad`, a zipped Zarr store, or any other single-file input format)
 * instead.
 *
 * @module data/sources/providers/dropbox
 */

import { DataSourceError, DataSourceErrorCode } from '../../data-source.js';
import { describeRemoteFile } from '../remote-file.js';
import { fileNameOfUrl } from './http.js';
import { openableNamesText } from '../../input-formats.js';

const CONTENT_HOST = 'dl.dropboxusercontent.com';

const SHARE_HOST = 'www.dropbox.com';

/**
 * The share link of a Dropbox file link (`https://www.dropbox.com/scl/fi/…`
 * with its `rlkey`, whichever Dropbox host it was pasted from, without
 * `dl`/`raw`), `folder:<url>`, or null. The share link is the file's `?data=`
 * value; the content-host address its bytes are read from is not
 * (`contentUrlOf`).
 */
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
  if (host !== SHARE_HOST && host !== 'dropbox.com' && host !== CONTENT_HOST) return null;
  if (url.pathname.startsWith('/scl/fo/') || url.pathname.startsWith('/sh/')) {
    return `folder:https://${SHARE_HOST}${url.pathname}`;
  }
  if (!url.pathname.startsWith('/scl/fi/') && !url.pathname.startsWith('/s/')) return null;
  url.protocol = 'https:';
  url.hostname = SHARE_HOST;
  url.searchParams.delete('dl');
  url.searchParams.delete('raw');
  url.hash = '';
  return url.href;
}

/** Where the bytes of a shared file are read: the same path on Dropbox's content host. */
function contentUrlOf(share) {
  const url = new URL(share);
  url.hostname = CONTENT_HOST;
  return url;
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
        `the file itself (${openableNamesText({ layouts: ['file', 'zip'] })}) and ` +
        'paste that link.',
        DataSourceErrorCode.UNSUPPORTED,
        'link',
        { input: value }
      );
    }
    const url = contentUrlOf(parsed);
    const name = fileNameOfUrl(url);
    const file = await describeRemoteFile({
      url: url.href,
      id: `dropbox:${encodeURIComponent(`${url.pathname}`)}`,
      name,
      attribution: { title: name, url: parsed },
      signal,
      onStep,
    });
    return { title: name, file, attribution: file.attribution };
  },
});
