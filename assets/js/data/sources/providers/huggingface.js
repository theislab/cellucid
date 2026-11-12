/**
 * Hugging Face dataset repositories: a dataset catalog folder (holding
 * `datasets.json`), a Zarr store folder (read through its consolidated
 * metadata) or a dataset file (any single-file input format: an
 * `.h5ad`, a Zarr ZIP, a `.loom`, …), read in place from the Hub's file
 * URLs (which redirect to a CDN that allows cross-origin range reads). The
 * link is pinned to the commit that last wrote what it names, asked of the
 * Hub when it opens, so files never change under an open dataset.
 *
 * Only the path the link names is asked for, never the repository's
 * listing (which names every file of every folder: 6.9 MB and 4.6 s for a
 * large dataset repository, measured; a Zarr v2 folder adds one entry per
 * chunk): the path, with what a folder holds that decides what it is
 * (`paths-info`: its `datasets.json`, `.zmetadata`, `zarr.json`), and the
 * revision's commit and licence (a few hundred bytes), together in one
 * round trip; a folder's own files (`tree`, one level, page by page) only
 * when a file must be chosen from them.
 *
 * Accepts `hf:<user>/<repo>[@<revision>][/<path>]` and
 * `huggingface.co/datasets/<user>/<repo>[/tree|blob|resolve/<revision>/<path>]`.
 *
 * @module data/sources/providers/huggingface
 */

import { DataSourceError, DataSourceErrorCode, fetchWhenNotBusy, hostFaultOfResponse } from '../../data-source.js';
import { chooseOpenableFile, describeRemoteFile } from '../remote-file.js';
import { folderFormatOfName, storeFolderOfPath, titleOfName } from '../../input-formats.js';

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
    // `hf.co` is the Hub's short address (it redirects to huggingface.co).
    if (!['huggingface.co', 'www.huggingface.co', 'hf.co'].includes(url.hostname.toLowerCase())) return null;
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
  // A link to what is inside a store folder (its `.zmetadata`) is the store.
  return { user, repo, revision, path: storeFolderOfPath(path) ?? path };
}

function canonical({ user, repo, revision, path }) {
  return `${user}/${repo}${revision === 'main' ? '' : `@${revision}`}${path ? `/${path}` : ''}`;
}

/** One file's content name from the Hub's answer: its LFS object's SHA-256, else its git blob id; null when it names neither. */
function contentVersion(entry) {
  const oid = entry?.lfs?.oid ?? entry?.oid ?? null;
  return typeof oid === 'string' && oid !== '' ? `hf:${oid}` : null;
}

/**
 * The Hub's JSON answer to `url` (`init`: a POST's form), or the refusal
 * naming the repository: a missing or private one, or the Hub failing.
 */
async function hubAnswer(url, init, signal, { repoId, revision }) {
  const response = await fetchWhenNotBusy(url, { ...init, signal, cache: 'no-cache' });
  if (!response.ok) {
    const fault = hostFaultOfResponse(response, `dataset ${repoId}`, { url, repoId, revision });
    if (fault !== null) throw fault;
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
  return { body: await response.json(), link: response.headers.get('Link') };
}

/** The entries of one folder at a commit (one level), every page of them (`Link: <…>; rel="next"`). */
async function folderEntries(api, commit, path, signal, names) {
  const entries = [];
  let url = `${api}/tree/${commit}${path === '' ? '' : `/${path.split('/').map(encodeURIComponent).join('/')}`}?expand=false`;
  while (url !== null) {
    const { body, link } = await hubAnswer(url, {}, signal, names);
    if (Array.isArray(body)) entries.push(...body);
    url = /<([^>]+)>;\s*rel="next"/.exec(link ?? '')?.[1] ?? null;
  }
  return entries;
}

export default Object.freeze({
  id: 'hf',
  label: 'Hugging Face',
  capabilities: Object.freeze({
    folders: true,
    private: 'none',
    public: false,
    versions: true,
    write: false,
  }),
  match(input, { explicit = true } = {}) {
    const parsed = parseHf(input, explicit);
    return parsed === null ? null : canonical(parsed);
  },
  /** A value carries nothing that grants access: it is shown as it is. */
  publicValue(value) {
    return value;
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
    const names = { repoId, revision };
    const api = `${HUB}/api/datasets/${repoId}`;
    const prefix = path === '' ? '' : `${path}/`;
    // The revision's commit and licence, and beside them the path with what
    // decides what a folder is, each with the commit that last wrote it:
    // asked of the Hub now, never a cached answer.
    const [revisionInfo, pathsInfo] = await Promise.all([
      hubAnswer(`${api}/revision/${encodeURIComponent(revision)}?expand%5B%5D=sha&expand%5B%5D=cardData`, {}, signal, names),
      hubAnswer(`${api}/paths-info/${encodeURIComponent(revision)}`, {
        method: 'POST',
        // A form: a request without a preflight.
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams([
          ...(path === '' ? [] : [['paths', path]]),
          ...['datasets.json', '.zmetadata', 'zarr.json'].map(name => ['paths', `${prefix}${name}`]),
          ['expand', 'true'],
        ]).toString(),
      }, signal, names),
    ]);
    const head = revisionInfo.body?.sha;
    const found = new Map((Array.isArray(pathsInfo.body) ? pathsInfo.body : []).map(entry => [entry?.path, entry]));
    if (typeof head !== 'string' || !/^[0-9a-f]{40}$/.test(head)) {
      throw new DataSourceError(
        `Hugging Face dataset ${repoId} names no commit for ${revision}.`,
        DataSourceErrorCode.INVALID_FORMAT,
        'link',
        { repoId }
      );
    }
    const entry = path === '' ? { type: 'directory', path: '', lastCommit: { id: head } } : found.get(path) ?? null;
    if (entry === null) {
      throw new DataSourceError(
        `Hugging Face dataset ${repoId}@${revision} has no ${path}.`,
        DataSourceErrorCode.NOT_FOUND,
        'link',
        { repoId, revision, path }
      );
    }
    // Read at the commit that last wrote the path: what it names, exactly.
    const commit = /^[0-9a-f]{40}$/.test(entry.lastCommit?.id ?? '') ? entry.lastCommit.id : head;
    const resolve = file => `${HUB}/datasets/${repoId}/resolve/${commit}/${file.split('/').map(encodeURIComponent).join('/')}`;
    const attribution = {
      title: repoId,
      url: `${HUB}/datasets/${repoId}`,
      ...(typeof revisionInfo.body?.cardData?.license === 'string' ? { licence: revisionInfo.body.cardData.license } : {}),
    };
    const describe = async (filePath, file) => {
      const size = file?.lfs?.size ?? file?.size ?? null;
      const described = await describeRemoteFile({
        url: resolve(filePath),
        id: `hf:${encodeURIComponent(`${repoId}@${revision}/${filePath}`)}`,
        name: filePath.split('/').pop(),
        size: Number.isSafeInteger(size) ? size : null,
        // The file's own content name (its LFS object's SHA-256, else its git
        // blob id): a commit that changes other files leaves it, and what is
        // kept of the file, as it is. An answer naming neither: no version.
        version: contentVersion(file) ?? `size:${Number.isSafeInteger(size) ? size : 0}`,
        attribution,
        signal,
        onStep,
      });
      return { title: `${repoId}/${filePath}`, file: described, attribution: described.attribution };
    };
    if (entry.type === 'file') return describe(path, entry);
    // A Zarr store folder, read through its consolidated metadata.
    if (folderFormatOfName(path) !== null && (found.has(`${prefix}.zmetadata`) || found.has(`${prefix}zarr.json`))) {
      const name = path.split('/').at(-1);
      return {
        title: `${repoId}/${path}`,
        store: {
          url: resolve(prefix),
          name,
          title: titleOfName(name),
          // Without "/", as it becomes `anndata://<id>/`: the repository,
          // the revision the link names and the path (two revisions are two
          // datasets).
          id: `hf:${encodeURIComponent(`${repoId}@${revision}/${path}`)}`,
          // What names the folder's content: its git tree (a hash of every
          // file below it by its own content name), so a commit that changes
          // other files of the repository keeps what is kept of it.
          version: typeof entry.oid === 'string' && /^[0-9a-f]{40}$/.test(entry.oid) ? `hf-tree:${entry.oid}` : null,
          attribution,
        },
        attribution,
      };
    }
    if (found.has(`${prefix}datasets.json`)) {
      return {
        title: `${repoId}${path ? `/${path}` : ''}`,
        catalog: { baseUrl: resolve(prefix).replace(/\/?$/, '/') },
        attribution,
      };
    }
    // A folder: the one file Cellucid opens in it, or the choices named.
    const files = (await folderEntries(api, commit, path, signal, names)).filter(item => item?.type === 'file');
    const fileName = chooseOpenableFile(
      files.map(item => item.path.slice(prefix.length)).filter(name => !name.startsWith('.')),
      null,
      `Hugging Face dataset ${repoId}${path ? `/${path}` : ''}`,
      name => `hf:${canonical({ user, repo, revision, path: `${prefix}${name}` })}`
    );
    return describe(`${prefix}${fileName}`, files.find(item => item.path === `${prefix}${fileName}`));
  },
});
