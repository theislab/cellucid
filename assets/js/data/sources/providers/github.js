/**
 * GitHub: a public repository's dataset catalog (a folder holding
 * `datasets.json`), a Zarr store folder, or one `.h5ad` or Zarr ZIP in it,
 * read from `raw.githubusercontent.com`: single files in place with range
 * requests, a Zarr folder key by key. A file stored with Git LFS is read from
 * `media.githubusercontent.com`, which serves LFS content to any origin, at
 * the size its pointer states. Accepts `owner/repo[/path]`,
 * `owner/repo@ref[/path]`, a `github.com/<owner>/<repo>/tree|blob|raw/<ref>/...`
 * URL, or a `raw.githubusercontent.com` URL.
 *
 * What each link costs, measured against GitHub's hosts (HTTP/2, one
 * connection carrying up to 100 requests; every request answered with
 * `Access-Control-Allow-Origin: *`, every preflight refused):
 *
 * - Shorthand without `@ref` reads `HEAD`, which both hosts resolve to the
 *   repository's default branch (`main`, `master` or any other): no request
 *   finds the branch, and none is ever probed.
 * - A catalog or a Zarr folder costs no request here: the reader's first
 *   request is the catalog or the store's metadata.
 * - One file costs one round trip: a `HEAD` (its size) and, beside it, a
 *   range read of its head -- an `.h5ad`'s first read (`HEAD_BYTES`), which
 *   opening then starts from, or the first kilobyte of any other file. A file
 *   that small may be a Git LFS pointer, and the head holds it whole: the
 *   pointer states the object's size and hash, so the media host is never
 *   probed. The `HEAD` carries `Range: bytes=0-`, for which a browser asks
 *   for the bytes unencoded: its length is the file's, never a compressed
 *   transfer's (GitHub Pages compresses binary files, and a page cannot see
 *   that it did).
 * - Every request is CORS-safelisted (a `HEAD`, a `GET`, one plain range),
 *   so none needs a preflight. A host that says it is busy (429, 503) is
 *   asked again (`fetchWhenNotBusy`).
 *
 * @module data/sources/providers/github
 */

import { DataSourceError, DataSourceErrorCode, fetchWhenNotBusy } from '../../data-source.js';
import { describeRemoteFile, fileFormatOf } from '../remote-file.js';
import { HEAD_BYTES, headOfFile, readFileHead } from '../../../formats/io/byte-source.js';

/**
 * The ref a link without `@ref` reads: the repository's default branch, as
 * `raw.githubusercontent.com` and `media.githubusercontent.com` resolve
 * `HEAD`. No branch can be named `HEAD`, so it never shadows one.
 */
const DEFAULT_GITHUB_REF = 'HEAD';

function isSafeGitHubSegment(value) {
  return !(
    typeof value !== 'string' ||
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('%') ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('?') ||
    value.includes('#') ||
    /[\u0000-\u001f\u007f]/.test(value)
  );
}

function decodeGitHubSegment(value) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  return isSafeGitHubSegment(decoded) ? decoded : null;
}

function splitGitHubSegments(value, { urlPath = false } = {}) {
  let raw = value;
  if (urlPath) {
    if (!raw.startsWith('/')) return null;
    raw = raw.slice(1);
  }
  if (raw.endsWith('/')) {
    raw = raw.slice(0, -1);
  }
  if (raw.length === 0) return [];
  const encodedSegments = raw.split('/');
  if (encodedSegments.some(segment => segment.length === 0)) {
    return null;
  }
  const segments = encodedSegments.map(decodeGitHubSegment);
  return segments.some(segment => segment === null)
    ? null
    : segments;
}

/**
 * What to tell someone whose input `parseGitHubPath` cannot read. It is the
 * one wording for that refusal, whether the connect control refuses the input
 * before trying it or `connect()` refuses it from code.
 */
export const INVALID_GITHUB_PATH_MESSAGE =
  'Invalid GitHub path. Use format: owner/repo/folder (or owner/repo@branch/folder) for a folder holding datasets.json, owner/repo/path/file.h5ad, or paste a GitHub URL.';

/**
 * Parse a GitHub repository URL/path into components
 * @param {string} input - Exact shorthand, GitHub tree URL, or GitHub raw URL
 * @returns {{owner: string, repo: string, branch: string, path: string}|null}
 */
export function parseGitHubPath(input) {
  const parsed = parseGitHubLocation(input);
  if (parsed === null) return null;
  // A link to a catalog's datasets.json names its folder.
  const segments = parsed.path.split('/');
  return segments.at(-1) === 'datasets.json'
    ? { ...parsed, path: segments.slice(0, -1).join('/') }
    : parsed;
}

function parseGitHubLocation(input) {
  if (typeof input !== 'string') return null;
  const cleaned = input.trim();
  if (cleaned.length === 0) return null;

  let url = null;
  try {
    url = new URL(cleaned);
  } catch {
    // Exact shorthand is handled below.
  }

  if (url !== null) {
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== '' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      return null;
    }
    const segments = splitGitHubSegments(
      url.pathname,
      { urlPath: true }
    );
    if (segments === null) return null;

    if (url.hostname.toLowerCase() === 'github.com') {
      // A folder (`tree`), a file page (`blob`) or its Raw button (`raw`,
      // which redirects to raw.githubusercontent.com without CORS: the file
      // is read from there directly).
      if (
        segments.length < 4 ||
        (segments[2] !== 'tree' && segments[2] !== 'blob' && segments[2] !== 'raw')
      ) {
        return null;
      }
      const qualified = segments[3] === 'refs' &&
        (segments[4] === 'heads' || segments[4] === 'tags');
      const branchIndex = qualified ? 5 : 3;
      if (segments.length <= branchIndex) return null;
      return {
        owner: segments[0],
        repo: segments[1],
        branch: segments[branchIndex],
        path: segments.slice(branchIndex + 1).join('/'),
      };
    }
    if (
      url.hostname.toLowerCase() ===
      'raw.githubusercontent.com'
    ) {
      // GitHub's Raw button writes the branch as `refs/heads/<branch>`.
      const qualified = segments[2] === 'refs' &&
        (segments[3] === 'heads' || segments[3] === 'tags');
      const branchIndex = qualified ? 4 : 2;
      if (segments.length <= branchIndex) return null;
      return {
        owner: segments[0],
        repo: segments[1],
        branch: segments[branchIndex],
        path: segments.slice(branchIndex + 1).join('/'),
      };
    }
    return null;
  }

  if (
    cleaned.includes('://') ||
    cleaned.includes('?') ||
    cleaned.includes('#') ||
    /^github\.com\//i.test(cleaned) ||
    /^raw\.githubusercontent\.com\//i.test(cleaned)
  ) {
    return null;
  }
  const segments = splitGitHubSegments(cleaned);
  if (segments === null || segments.length < 2) return null;

  const owner = segments[0];
  const repoSpecifier = segments[1];
  const atIndex = repoSpecifier.indexOf('@');
  let repo = repoSpecifier;
  let branch = DEFAULT_GITHUB_REF;
  if (atIndex !== -1) {
    if (
      atIndex === 0 ||
      atIndex === repoSpecifier.length - 1 ||
      repoSpecifier.indexOf('@', atIndex + 1) !== -1
    ) {
      return null;
    }
    repo = repoSpecifier.slice(0, atIndex);
    branch = repoSpecifier.slice(atIndex + 1);
  }
  if (
    !isSafeGitHubSegment(repo) ||
    !isSafeGitHubSegment(branch)
  ) {
    return null;
  }
  return {
    owner,
    repo,
    branch,
    path: segments.slice(2).join('/'),
  };
}

/**
 * Build raw GitHub content URL from components
 * @param {{owner: string, repo: string, branch: string, path: string}} parsed
 * @returns {string}
 */
export function buildRawUrl(parsed) {
  const { owner, repo, branch, path } = parsed;
  const segments = [owner, repo, branch];
  if (path.length > 0) {
    segments.push(...path.split('/'));
  }
  return (
    'https://raw.githubusercontent.com/' +
    segments.map(segment => encodeURIComponent(segment)).join('/') +
    '/'
  );
}


/** The address of one file, without the folder's trailing "/". */
function rawFileUrl(parsed, host = 'https://raw.githubusercontent.com/') {
  return host + [parsed.owner, parsed.repo, parsed.branch, ...parsed.path.split('/')]
    .map(segment => encodeURIComponent(segment))
    .join('/');
}

/**
 * A Git LFS pointer is a few lines of text, under 1024 bytes by the LFS
 * specification; anything larger is content.
 */
const LFS_POINTER_MAX_BYTES = 1024;
const LFS_POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\n(?:.*\n)*?/;

/**
 * The object an LFS pointer names (`{size, oid}`), or null when `bytes` are
 * not a pointer but the file itself.
 */
function lfsObject(bytes) {
  const text = new TextDecoder().decode(bytes);
  if (!LFS_POINTER.test(text)) return null;
  const size = /^size (\d+)$/m.exec(text);
  const oid = /^oid (sha256:[0-9a-f]{64})$/m.exec(text);
  return size === null ? null : { size: Number(size[1]), oid: oid?.[1] ?? null };
}

function hostFailure(name, url, status) {
  const host = new URL(url).host;
  return new DataSourceError(
    status === 404 || status === 403
      ? `${name} was not found at ${host} (HTTP ${status}). Check the owner, repository, ` +
        '@branch and path; the repository must be public.'
      : `${name} could not be read from ${host} (HTTP ${status}).`,
    status === 404 || status === 403
      ? DataSourceErrorCode.NOT_FOUND
      : DataSourceErrorCode.NETWORK_ERROR,
    'link',
    { url, status }
  );
}

async function gitHubRequest(url, name, init) {
  let response;
  try {
    response = await fetchWhenNotBusy(url, init);
  } catch (error) {
    if (error?.name === 'AbortError' || init.signal?.aborted) throw error;
    throw new DataSourceError(
      `${name} could not be read from ${new URL(url).host}: ${error?.message ?? error}.`,
      DataSourceErrorCode.NETWORK_ERROR,
      'link',
      { url }
    );
  }
  if (!response.ok) {
    await response.body?.cancel?.().catch(() => {});
    throw hostFailure(name, url, response.status);
  }
  return response;
}

/**
 * The exact size of one file on raw.githubusercontent.com, and its `ETag`
 * when the host lets this page see it: one `HEAD`. Its `Range: bytes=0-`
 * makes the browser ask for the bytes unencoded, so the length is the file's
 * own (a host that compresses the transfer would otherwise state the
 * compressed length, and hide that it did).
 */
async function headOf(url, name, signal) {
  const response = await gitHubRequest(url, name, {
    method: 'HEAD',
    headers: { Range: 'bytes=0-' },
    signal,
  });
  const size = Number(response.headers.get('Content-Length'));
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new DataSourceError(
      `${new URL(url).host} does not say how large ${name} is, so it cannot be read in place.`,
      DataSourceErrorCode.NETWORK_ERROR,
      'link',
      { url }
    );
  }
  return { size, etag: response.headers.get('ETag') };
}

async function describeGitHubFile(parsed, { signal }) {
  const name = parsed.path.split('/').at(-1);
  const common = {
    id: `gh:${encodeURIComponent(`${parsed.owner}/${parsed.repo}/${parsed.path}`)}`,
    name,
    attribution: {
      title: `${parsed.owner}/${parsed.repo}`,
      url: `https://github.com/${encodeURIComponent(parsed.owner)}/` +
        `${encodeURIComponent(parsed.repo)}`,
    },
    signal,
  };
  const url = rawFileUrl(parsed);
  // The head goes out beside the HEAD: an .h5ad's first read, else enough to
  // hold an LFS pointer whole.
  const headBytes = fileFormatOf(name) === 'h5ad' ? HEAD_BYTES : LFS_POINTER_MAX_BYTES;
  const headRead = readFileHead(url, headBytes, { signal, fetchImpl: fetchWhenNotBusy });
  headRead.catch(() => {});
  const { size, etag } = await headOf(url, name, signal);
  let head = null;
  try {
    head = headOfFile(await headRead, size, headBytes);
  } catch (error) {
    // The size stands without the head: opening reads it again.
    if (error?.name === 'AbortError' || signal?.aborted) throw error;
  }
  if (size > LFS_POINTER_MAX_BYTES) {
    return describeRemoteFile({ url, size, version: etag, head: headBytes === HEAD_BYTES ? head : null, ...common });
  }
  // Small enough to be a Git LFS pointer: the head holds it, a few lines.
  const pointer = head?.bytes ?? new Uint8Array(await (await gitHubRequest(url, name, { signal })).arrayBuffer());
  const lfs = lfsObject(pointer);
  if (lfs === null) return describeRemoteFile({ url, size, version: etag, head: headBytes === HEAD_BYTES ? head : null, ...common });
  return describeRemoteFile({
    url: rawFileUrl(parsed, 'https://media.githubusercontent.com/media/'),
    size: lfs.size,
    // The object's hash names exactly these bytes.
    version: lfs.oid,
    ...common,
  });
}

function canonicalValue({ owner, repo, branch, path }) {
  const repoPart = branch === DEFAULT_GITHUB_REF ? repo : `${repo}@${branch}`;
  return [owner, repoPart, ...(path.length > 0 ? [path] : [])].join('/');
}

export default Object.freeze({
  id: 'gh',
  label: 'GitHub',
  capabilities: Object.freeze({
    folders: true,
    private: 'none',
    versions: false,
    write: false,
  }),
  match(input) {
    const parsed = parseGitHubPath(input);
    return parsed === null ? null : canonicalValue(parsed);
  },
  async open(value, { signal = null } = {}) {
    const parsed = parseGitHubPath(value);
    if (parsed === null) {
      throw new DataSourceError(
        INVALID_GITHUB_PATH_MESSAGE,
        DataSourceErrorCode.INVALID_FORMAT,
        'link',
        { input: value }
      );
    }
    if (fileFormatOf(parsed.path) !== null) {
      const file = await describeGitHubFile(parsed, { signal });
      return { title: file.name, file, attribution: file.attribution };
    }
    const repository = {
      title: `${parsed.owner}/${parsed.repo}`,
      url: `https://github.com/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`,
    };
    // A Zarr store folder, read through its consolidated metadata.
    if (/\.zarr$/i.test(parsed.path)) {
      const name = parsed.path.split('/').at(-1);
      return {
        title: `${parsed.owner}/${parsed.repo}/${parsed.path}`,
        store: {
          url: buildRawUrl(parsed),
          name,
          title: name.replace(/\.zarr$/i, ''),
          // The dataset id of a store that states none: without "/", as it
          // becomes `zarr://<id>/`.
          id: `gh:${encodeURIComponent(`${parsed.owner}/${parsed.repo}/${parsed.path}`)}`,
          attribution: repository,
        },
        attribution: repository,
      };
    }
    return {
      title: `${parsed.owner}/${parsed.repo}` +
        (parsed.path.length > 0 ? `/${parsed.path}` : '') +
        (parsed.branch === DEFAULT_GITHUB_REF ? '' : ` @ ${parsed.branch}`),
      catalog: { baseUrl: buildRawUrl(parsed) },
      attribution: {
        title: `${parsed.owner}/${parsed.repo}`,
        url: `https://github.com/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`,
      },
    };
  },
});
