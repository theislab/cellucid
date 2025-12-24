/**
 * Community Annotation - GitHub sync (fine-grained PAT).
 *
 * Static-site friendly GitHub sync using the REST API "contents" endpoints.
 * - Pull: list & fetch `annotations/users/*.json`, merge into local session
 * - Push: write only `annotations/users/{username}.json`
 *
 * Security:
 * - Never logs tokens.
 * - Avoids DOM usage (UI layer is separate).
 */

import { getAnnotationRepoForDataset, getEffectivePatForRepo, setAnnotationRepoForDataset } from './repo-store.js';

const API_ORIGIN = 'https://api.github.com';
const API_VERSION = '2022-11-28';

function toCleanString(value) {
  return String(value ?? '').trim();
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function encodeBase64Utf8(text) {
  const s = toCleanString(text);
  const bytes = typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s) : null;
  if (!bytes) return btoa(unescape(encodeURIComponent(s)));
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function decodeBase64Utf8(b64) {
  const base64 = toCleanString(b64).replace(/\s+/g, '');
  const bin = atob(base64);
  if (typeof TextDecoder !== 'undefined') {
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  return decodeURIComponent(escape(bin));
}

export function parseOwnerRepo(input) {
  const raw = toCleanString(input);
  if (!raw) return null;

  /** @type {string|null} */
  let ref = null;

  let cleaned = raw
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/^https?:\/\/api\.github\.com\/repos\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/^\/+|\/+$/g, '');

  // Support ".../owner/repo.git"
  cleaned = cleaned.replace(/\.git$/i, '');

  // Support ".../owner/repo/tree/branch[/...]" links.
  const treeMatch = cleaned.match(/^([^/]+\/[^/]+)\/tree\/([^/]+)(?:\/.*)?$/i);
  if (treeMatch) {
    cleaned = treeMatch[1];
    ref = toCleanString(treeMatch[2]) || null;
  }

  // Support "owner/repo@branch" and "owner/repo#branch"
  const hashIdx = cleaned.indexOf('#');
  if (hashIdx >= 0) {
    ref = toCleanString(cleaned.slice(hashIdx + 1)) || null;
    cleaned = cleaned.slice(0, hashIdx);
  } else {
    const atIdx = cleaned.lastIndexOf('@');
    if (atIdx >= 0) {
      ref = toCleanString(cleaned.slice(atIdx + 1)) || null;
      cleaned = cleaned.slice(0, atIdx);
    }
  }

  const parts = cleaned.split('/');
  if (parts.length !== 2) return null;

  const owner = toCleanString(parts[0]);
  const repo = toCleanString(parts[1]);

  // GitHub owner/repo constraints (loose but safe).
  const re = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?$/;
  if (!re.test(owner) || !re.test(repo)) return null;

  if (ref) {
    // Branch names can include slashes; keep validation permissive while preventing obviously invalid input.
    const refOk = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(ref);
    if (!refOk) ref = null;
  }

  const ownerRepo = `${owner}/${repo}`;
  const ownerRepoRef = ref ? `${ownerRepo}@${ref}` : ownerRepo;
  return { owner, repo, ownerRepo, ref, ownerRepoRef };
}

function sanitizeUsernameForPath(username) {
  const raw = toCleanString(username);
  if (!raw) return 'local';
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return cleaned || 'local';
}

async function githubRequest(path, { token = null, method = 'GET', query = null, body = null } = {}) {
  const url = new URL(`${API_ORIGIN}${path}`);
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (v == null) continue;
      url.searchParams.set(k, String(v));
    }
  }

  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body != null) headers['Content-Type'] = 'application/json';

  const res = await fetch(url.toString(), {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  const asJson = text ? safeJsonParse(text) : null;

  if (!res.ok) {
    const msg =
      toCleanString(asJson?.message) ||
      toCleanString(text) ||
      `GitHub HTTP ${res.status}`;
    const err = new Error(msg);
    // attach minimal context (no token)
    err.status = res.status;
    err.github = { path, method };
    throw err;
  }

  return asJson != null ? asJson : (text || null);
}

async function getRepoInfo({ owner, repo, token = null }) {
  return githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { token });
}

async function getContent({ owner, repo, token = null, path, ref = null }) {
  const p = toCleanString(path).replace(/^\/+/, '');
  if (!p) throw new Error('GitHub content path required');
  return githubRequest(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${p.split('/').map(encodeURIComponent).join('/')}`,
    { token, query: ref ? { ref } : null }
  );
}

async function putContent({ owner, repo, token, path, branch, message, contentBase64, sha = null }) {
  if (!token) throw new Error('GitHub token required');
  const p = toCleanString(path).replace(/^\/+/, '');
  if (!p) throw new Error('GitHub content path required');
  const payload = {
    message: toCleanString(message) || 'Update annotations',
    content: contentBase64,
    branch: toCleanString(branch) || undefined,
    sha: sha || undefined
  };
  return githubRequest(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${p.split('/').map(encodeURIComponent).join('/')}`,
    { token, method: 'PUT', body: payload }
  );
}

async function readJsonFile({ owner, repo, token = null, path, ref = null }) {
  const content = await getContent({ owner, repo, token, path, ref });
  if (!content || content.type !== 'file') {
    throw new Error(`Expected file at ${path}`);
  }
  const decoded = decodeBase64Utf8(content.content || '');
  const parsed = safeJsonParse(decoded);
  if (!parsed) throw new Error(`Invalid JSON at ${path}`);
  return { json: parsed, sha: content.sha || null };
}

async function listDir({ owner, repo, token = null, path, ref = null }) {
  const content = await getContent({ owner, repo, token, path, ref });
  if (!Array.isArray(content)) {
    throw new Error(`Expected directory listing at ${path}`);
  }
  return content;
}

export class CommunityAnnotationGitHubSync {
  constructor({ datasetId, owner, repo, token = null, branch = null } = {}) {
    this.datasetId = toCleanString(datasetId) || null;
    this.owner = owner;
    this.repo = repo;
    this.token = token;
    this.branch = branch;

    this._usersDirEntries = null;
    this._usersDirRef = null;
    this._schemaCheckedRef = null;
  }

  get ownerRepo() {
    return `${this.owner}/${this.repo}`;
  }

  async validateAndLoadConfig({ datasetId } = {}) {
    const token = this.token;
    const repoInfo = await getRepoInfo({ owner: this.owner, repo: this.repo, token });
    const branch = this.branch || repoInfo?.default_branch || 'main';
    this.branch = branch;

    // Basic structural checks expected by the template.
    // (Public repos may be rate-limited without a token; errors are surfaced to the caller.)
    if (!this._usersDirEntries || this._usersDirRef !== branch) {
      this._usersDirEntries = await listDir({ owner: this.owner, repo: this.repo, token, path: 'annotations/users', ref: branch });
      this._usersDirRef = branch;
    }
    if (this._schemaCheckedRef !== branch) {
      await readJsonFile({ owner: this.owner, repo: this.repo, token, path: 'annotations/schema.json', ref: branch });
      this._schemaCheckedRef = branch;
    }

    const { json: config } = await readJsonFile({
      owner: this.owner,
      repo: this.repo,
      token,
      path: 'annotations/config.json',
      ref: branch
    });

    const targetDatasetId = toCleanString(datasetId ?? this.datasetId ?? '') || null;
    const supported = Array.isArray(config?.supportedDatasets) ? config.supportedDatasets : [];
    const match = targetDatasetId
      ? supported.find((d) => toCleanString(d?.datasetId) === targetDatasetId) || null
      : null;

    return { repoInfo, branch, config, datasetId: targetDatasetId, datasetConfig: match };
  }

  async getAuthenticatedUser() {
    const token = this.token;
    if (!token) return null;
    try {
      return await githubRequest('/user', { token });
    } catch {
      return null;
    }
  }

  async pullAllUsers() {
    const token = this.token;
    const branch = this.branch || 'main';

    const entries = (this._usersDirEntries && this._usersDirRef === branch)
      ? this._usersDirEntries
      : await listDir({
        owner: this.owner,
        repo: this.repo,
        token,
        path: 'annotations/users',
        ref: branch
      });
    this._usersDirEntries = entries;
    this._usersDirRef = branch;

    const jsonFiles = entries
      .filter((e) => e?.type === 'file' && typeof e?.name === 'string' && e.name.endsWith('.json'))
      .slice(0, 500);

    const out = [];
    for (const f of jsonFiles) {
      try {
        const { json } = await readJsonFile({
          owner: this.owner,
          repo: this.repo,
          token,
          path: `annotations/users/${f.name}`,
          ref: branch
        });
        out.push(json);
      } catch (err) {
        // Skip invalid files; surface in UI via aggregate error if needed.
        // (No token in error message.)
        out.push({ __invalid: true, __path: f?.name, __error: err?.message || String(err) });
      }
    }

    return out;
  }

  async pushMyUserFile({ userDoc, commitMessage = null, conflictIfRemoteNewerThan = null, force = false } = {}) {
    const token = this.token;
    if (!token) throw new Error('GitHub token required to push');
    const branch = this.branch || 'main';

    const username = toCleanString(userDoc?.username);
    if (!username) throw new Error('User doc missing username');
    const fileUser = sanitizeUsernameForPath(username);
    const path = `annotations/users/${fileUser}.json`;

    let sha = null;
    let remoteUpdatedAt = null;
    try {
      const existing = await getContent({ owner: this.owner, repo: this.repo, token, path, ref: branch });
      if (existing?.type === 'file' && existing?.sha) {
        sha = existing.sha;
        const decoded = decodeBase64Utf8(existing?.content || '');
        const parsed = decoded ? safeJsonParse(decoded) : null;
        remoteUpdatedAt = toCleanString(parsed?.updatedAt) || null;
      }
    } catch (err) {
      // If not found, we'll create it. Otherwise bubble up.
      if (err?.status !== 404) throw err;
    }

    if (!force && remoteUpdatedAt && conflictIfRemoteNewerThan) {
      const localMs = Number.isFinite(Date.parse(conflictIfRemoteNewerThan)) ? Date.parse(conflictIfRemoteNewerThan) : null;
      const remoteMs = Number.isFinite(Date.parse(remoteUpdatedAt)) ? Date.parse(remoteUpdatedAt) : null;
      if (localMs != null && remoteMs != null && remoteMs > localMs) {
        const err = new Error(
          `Remote user file was updated at ${remoteUpdatedAt}. Pull first, or force overwrite to push anyway.`
        );
        err.code = 'COMMUNITY_ANNOTATION_CONFLICT';
        err.remoteUpdatedAt = remoteUpdatedAt;
        err.path = path;
        throw err;
      }
    }

    const content = encodeBase64Utf8(JSON.stringify(userDoc, null, 2) + '\n');
    const msg = toCleanString(commitMessage) || `Update annotations for @${fileUser}`;
    await putContent({
      owner: this.owner,
      repo: this.repo,
      token,
      path,
      branch,
      message: msg,
      contentBase64: content,
      sha
    });
    return { path, remoteUpdatedAt };
  }
}

export function getGitHubSyncForDataset({ datasetId, tokenOverride = null } = {}) {
  const repo = getAnnotationRepoForDataset(datasetId);
  if (!repo) return null;
  const parsed = parseOwnerRepo(repo);
  if (!parsed) return null;
  const token = tokenOverride || getEffectivePatForRepo(parsed.ownerRepoRef) || null;
  return new CommunityAnnotationGitHubSync({
    datasetId,
    owner: parsed.owner,
    repo: parsed.repo,
    token,
    branch: parsed.ref || null
  });
}

export function setDatasetAnnotationRepoFromUrlParam({ datasetId, urlParamValue }) {
  const parsed = parseOwnerRepo(urlParamValue);
  if (!parsed) return false;
  return setAnnotationRepoForDataset(datasetId, parsed.ownerRepoRef);
}
