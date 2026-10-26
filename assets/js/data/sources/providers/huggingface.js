/**
 * Hugging Face dataset repositories: a dataset catalog folder (holding
 * `datasets.json`), a Zarr store folder (read through its consolidated
 * metadata) or a dataset file (any single-file input format: an
 * `.h5ad`, a Zarr ZIP, a `.loom`, …), read in place from the Hub's file
 * URLs (which redirect to a CDN that allows cross-origin range reads). The
 * link is pinned to the commit the branch points at when it opens, so files
 * never change under an open dataset.
 *
 * Accepts `hf:<user>/<repo>[@<revision>][/<path>]` and
 * `huggingface.co/datasets/<user>/<repo>[/tree|blob|resolve/<revision>/<path>]`.
 *
 * @module data/sources/providers/huggingface
 */

import { DataSourceError, DataSourceErrorCode, fetchWhenNotBusy } from '../../data-source.js';
import { chooseOpenableFile, describeRemoteFile } from '../remote-file.js';
import { folderFormatOfName, titleOfName } from '../../input-formats.js';

const HUB = 'https://huggingface.co';
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function safePath(path) {
  return path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..' &&
    !/[\u0000-\u001f\u007f]/.test(segment));
}

/**
 * `{user, repo, revision, path}`, or null. The short form (`user/repo…`) is
 * only Hugging Face's after `hf:` (`explicit`), since GitHub's shorthand has
 * the same shape; a huggingface.co link always is.
 */
function parseHf(input, explicit = true) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  let user;
  let repo;
  let revision = 'main';
  let path = '';
  let url = null;
  try {
    url = new URL(text);
  } catch {
    // a short form
  }
  if (url !== null) {
    if (url.hostname.toLowerCase() !== 'huggingface.co') return null;
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== 'datasets' || parts.length < 3) return null;
    [, user, repo] = parts;
    if (parts.length > 3) {
      if (!['tree', 'blob', 'resolve'].includes(parts[3]) || parts.length < 5) return null;
      revision = parts[4];
      path = parts.slice(5).join('/');
    }
  } else {
    if (!explicit) return null;
    const short = /^([^/@\s]+)\/([^/@\s]+)(?:@([^/\s]+))?(?:\/(.+))?$/.exec(text);
    if (short === null) return null;
    [, user, repo] = short;
    revision = short[3] ?? 'main';
    path = (short[4] ?? '').replace(/\/+$/, '');
  }
  if (!NAME.test(user) || !NAME.test(repo) || !REVISION.test(revision)) return null;
  if (path !== '' && !safePath(path)) return null;
  return { user, repo, revision, path };
}

function canonical({ user, repo, revision, path }) {
  return `${user}/${repo}${revision === 'main' ? '' : `@${revision}`}${path ? `/${path}` : ''}`;
}

export default Object.freeze({
  id: 'hf',
  label: 'Hugging Face',
  capabilities: Object.freeze({
    folders: true,
    private: 'none',
    versions: true,
    write: false,
  }),
  match(input, { explicit = true } = {}) {
    const parsed = parseHf(input, explicit);
    return parsed === null ? null : canonical(parsed);
  },
  async open(value, { signal = null, onStep = null } = {}) {
    const parsed = parseHf(value);
    if (parsed === null) {
      throw new DataSourceError(
        `"${value}" is not a Hugging Face dataset repository or file.`,
        DataSourceErrorCode.INVALID_FORMAT,
        'link',
        { input: value }
      );
    }
    const { user, repo, revision, path } = parsed;
    const repoId = `${user}/${repo}`;
    const response = await fetchWhenNotBusy(
      `${HUB}/api/datasets/${repoId}/revision/${encodeURIComponent(revision)}?blobs=true`,
      { signal }
    );
    if (!response.ok) {
      throw new DataSourceError(
        response.status === 401 || response.status === 404
          ? `Hugging Face dataset ${repoId}@${revision} does not exist or is not public.`
          : `Hugging Face dataset ${repoId} could not be read (HTTP ${response.status}).`,
        response.status === 401 || response.status === 404
          ? DataSourceErrorCode.NOT_FOUND
          : DataSourceErrorCode.NETWORK_ERROR,
        'link',
        { repoId, revision, status: response.status }
      );
    }
    const info = await response.json();
    const commit = info.sha;
    if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit) || !Array.isArray(info.siblings)) {
      throw new DataSourceError(
        `Hugging Face dataset ${repoId} has no file listing.`,
        DataSourceErrorCode.INVALID_FORMAT,
        'link',
        { repoId }
      );
    }
    const siblings = new Map(info.siblings.map(sibling => [sibling.rfilename, sibling]));
    const resolve = file => `${HUB}/datasets/${repoId}/resolve/${commit}/${file.split('/').map(encodeURIComponent).join('/')}`;
    const attribution = {
      title: repoId,
      url: `${HUB}/datasets/${repoId}`,
      ...(typeof info.cardData?.license === 'string' ? { licence: info.cardData.license } : {}),
    };
    const prefix = path === '' ? '' : `${path}/`;
    // A Zarr store folder, read through its consolidated metadata.
    if (folderFormatOfName(path) !== null && (siblings.has(`${prefix}.zmetadata`) || siblings.has(`${prefix}zarr.json`))) {
      const name = path.split('/').at(-1);
      return {
        title: `${repoId}/${path}`,
        store: {
          url: resolve(prefix),
          name,
          title: titleOfName(name),
          // Without "/", as it becomes `anndata://<id>/`.
          id: `hf:${encodeURIComponent(`${repoId}/${path}`)}`,
          attribution,
        },
        attribution,
      };
    }
    const isFile = path !== '' && siblings.has(path);
    if (!isFile && siblings.has(`${prefix}datasets.json`)) {
      return {
        title: `${repoId}${path ? `/${path}` : ''}`,
        catalog: { baseUrl: resolve(prefix).replace(/\/?$/, '/') },
        attribution,
      };
    }
    const inFolder = [...siblings.keys()]
      .filter(name => name.startsWith(prefix) && !name.slice(prefix.length).includes('/'))
      .map(name => name.slice(prefix.length));
    const fileName = isFile
      ? path.split('/').pop()
      : chooseOpenableFile(
        inFolder.filter(name => !name.startsWith('.')),
        null,
        `Hugging Face dataset ${repoId}${path ? `/${path}` : ''}`,
        name => `hf:${canonical({ user, repo, revision, path: `${prefix}${name}` })}`
      );
    const filePath = isFile ? path : `${prefix}${fileName}`;
    const sibling = siblings.get(filePath);
    const size = sibling?.lfs?.size ?? sibling?.size ?? null;
    const file = await describeRemoteFile({
      url: resolve(filePath),
      id: `hf:${encodeURIComponent(`${repoId}/${filePath}`)}`,
      name: fileName,
      size: Number.isSafeInteger(size) ? size : null,
      version: `hf:${commit}:${sibling?.lfs?.sha256 ?? sibling?.blobId ?? ''}`,
      attribution,
      signal,
      onStep,
    });
    return { title: `${repoId}/${filePath}`, file, attribution: file.attribution };
  },
});
