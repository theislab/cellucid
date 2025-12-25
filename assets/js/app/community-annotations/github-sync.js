/**
 * Community Annotation - GitHub sync (GitHub App OAuth).
 *
 * Static-site friendly GitHub sync using the REST API "contents" endpoints,
 * proxied through a Cloudflare Worker to avoid exposing client secrets.
 * - Pull: list & fetch `annotations/users/*.json`, merge into local session
 * - Push: write only `annotations/users/{username}.json`
 *
 * Security:
 * - Never logs tokens.
 * - Avoids DOM usage (UI layer is separate).
 */

import { getGitHubAuthSession, getGitHubWorkerOrigin } from './github-auth.js';
import { getAnnotationRepoForDataset, setAnnotationRepoForDataset } from './repo-store.js';

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

function sleep(ms) {
  const t = Math.max(0, Math.floor(Number(ms) || 0));
  return new Promise((resolve) => setTimeout(resolve, t));
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

function toWorkerApiUrl(workerOrigin, githubPath) {
  const origin = String(workerOrigin || '').trim().replace(/\/+$/, '') || getGitHubWorkerOrigin();
  const p = String(githubPath || '').trim();
  if (!p.startsWith('/')) throw new Error('GitHub API path must start with "/"');
  return new URL(`${origin}/api${p}`);
}

function toWorkerAuthUrl(workerOrigin, workerPath) {
  const origin = String(workerOrigin || '').trim().replace(/\/+$/, '') || getGitHubWorkerOrigin();
  const p = String(workerPath || '').trim();
  if (!p.startsWith('/')) throw new Error('Worker path must start with "/"');
  return new URL(`${origin}${p}`);
}

async function githubRequest(workerOrigin, path, { token = null, method = 'GET', query = null, body = null } = {}) {
  const url = toWorkerApiUrl(workerOrigin, path);
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

async function workerAuthRequest(workerOrigin, path, { token = null, method = 'GET', body = null } = {}) {
  const url = toWorkerAuthUrl(workerOrigin, path);
  const headers = {};
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
    const msg = toCleanString(asJson?.error || asJson?.message || text) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.worker = { path, method };
    throw err;
  }
  return asJson != null ? asJson : (text || null);
}

async function getRepoInfo({ workerOrigin, owner, repo, token = null }) {
  return githubRequest(workerOrigin, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { token });
}

async function getContent({ workerOrigin, owner, repo, token = null, path, ref = null }) {
  const p = toCleanString(path).replace(/^\/+/, '');
  if (!p) throw new Error('GitHub content path required');
  return githubRequest(
    workerOrigin,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${p.split('/').map(encodeURIComponent).join('/')}`,
    { token, query: ref ? { ref } : null }
  );
}

async function putContent({ workerOrigin, owner, repo, token, path, branch, message, contentBase64, sha = null }) {
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
    workerOrigin,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${p.split('/').map(encodeURIComponent).join('/')}`,
    { token, method: 'PUT', body: payload }
  );
}

async function readJsonFile({ workerOrigin, owner, repo, token = null, path, ref = null }) {
  const content = await getContent({ workerOrigin, owner, repo, token, path, ref });
  if (!content || content.type !== 'file') {
    throw new Error(`Expected file at ${path}`);
  }
  const decoded = decodeBase64Utf8(content.content || '');
  const parsed = safeJsonParse(decoded);
  if (!parsed) throw new Error(`Invalid JSON at ${path}`);
  return { json: parsed, sha: content.sha || null };
}

function isNotFoundError(err) {
  return err?.status === 404;
}

async function listDir({ workerOrigin, owner, repo, token = null, path, ref = null }) {
  const content = await getContent({ workerOrigin, owner, repo, token, path, ref });
  if (!Array.isArray(content)) {
    throw new Error(`Expected directory listing at ${path}`);
  }
  return content;
}

export class CommunityAnnotationGitHubSync {
  constructor({ datasetId, owner, repo, token = null, branch = null, workerOrigin = null } = {}) {
    this.datasetId = toCleanString(datasetId) || null;
    this.owner = owner;
    this.repo = repo;
    this.token = token;
    this.branch = branch;
    this.workerOrigin = toCleanString(workerOrigin) || getGitHubWorkerOrigin();

    this._usersDirEntries = null;
    this._usersDirRef = null;
    this._schemaCheckedRef = null;
    this._repoInfo = null;
  }

  get ownerRepo() {
    return `${this.owner}/${this.repo}`;
  }

  async validateAndLoadConfig({ datasetId } = {}) {
    const token = this.token;
    if (!token) throw new Error('GitHub sign-in required');
    const workerOrigin = this.workerOrigin;
    const repoInfo = await getRepoInfo({ workerOrigin, owner: this.owner, repo: this.repo, token });
    this._repoInfo = repoInfo || null;
    const branch = this.branch || repoInfo?.default_branch || 'main';
    this.branch = branch;

    // Basic structural checks expected by the template.
    // (Public repos may be rate-limited without a token; errors are surfaced to the caller.)
    if (!this._usersDirEntries || this._usersDirRef !== branch) {
      this._usersDirEntries = await listDir({ workerOrigin, owner: this.owner, repo: this.repo, token, path: 'annotations/users', ref: branch });
      this._usersDirRef = branch;
    }
    if (this._schemaCheckedRef !== branch) {
      await readJsonFile({ workerOrigin, owner: this.owner, repo: this.repo, token, path: 'annotations/schema.json', ref: branch });
      this._schemaCheckedRef = branch;
    }

    const { json: config } = await readJsonFile({
      workerOrigin,
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

  async readRepoConfigJson() {
    const token = this.token;
    if (!token) throw new Error('GitHub sign-in required');
    const branch = this.branch || 'main';
    return readJsonFile({
      workerOrigin: this.workerOrigin,
      owner: this.owner,
      repo: this.repo,
      token,
      path: 'annotations/config.json',
      ref: branch
    });
  }

  async updateDatasetFieldsToAnnotate({ datasetId, fieldsToAnnotate, commitMessage = null } = {}) {
    const token = this.token;
    if (!token) throw new Error('GitHub sign-in required');

    const { repoInfo, branch, config } = await this.validateAndLoadConfig({ datasetId });
    const perms = repoInfo?.permissions || null;
    const canManage = perms ? Boolean(perms.maintain || perms.admin) : false;
    if (!canManage) throw new Error('Maintain/admin access required to update annotations/config.json');

    const did = toCleanString(datasetId ?? this.datasetId ?? '') || null;
    if (!did) throw new Error('datasetId required');

    const existing = await this.readRepoConfigJson();
    const sha = existing?.sha || null;

    const nextConfig = config && typeof config === 'object'
      ? { ...config }
      : { version: 1, supportedDatasets: [] };
    if (!Array.isArray(nextConfig.supportedDatasets)) nextConfig.supportedDatasets = [];

    const cleanedFields = Array.isArray(fieldsToAnnotate)
      ? fieldsToAnnotate
          .map((v) => toCleanString(v))
          .filter(Boolean)
          .slice(0, 200)
      : [];

    let found = false;
    nextConfig.supportedDatasets = nextConfig.supportedDatasets.map((d) => {
      if (!d || typeof d !== 'object') return d;
      const dId = toCleanString(d.datasetId);
      if (dId !== did) return d;
      found = true;
      return { ...d, fieldsToAnnotate: cleanedFields };
    });

    if (!found) {
      nextConfig.supportedDatasets = nextConfig.supportedDatasets.concat([
        { datasetId: did, name: did, fieldsToAnnotate: cleanedFields }
      ]);
    }

    const content = encodeBase64Utf8(JSON.stringify(nextConfig, null, 2) + '\n');
    const msg = toCleanString(commitMessage) || `Update annotatable fields for ${did}`;
    await putContent({
      workerOrigin: this.workerOrigin,
      owner: this.owner,
      repo: this.repo,
      token,
      path: 'annotations/config.json',
      branch,
      message: msg,
      contentBase64: content,
      sha
    });
    return { branch, datasetId: did, fieldsToAnnotate: cleanedFields };
  }

  async pullModerationMerges({ knownShas = null } = {}) {
    const token = this.token;
    if (!token) throw new Error('GitHub sign-in required');
    const branch = this.branch || 'main';
    const workerOrigin = this.workerOrigin;
    const path = 'annotations/moderation/merges.json';
    const known = (knownShas && typeof knownShas === 'object') ? knownShas : null;
    try {
      const entries = await listDir({
        workerOrigin,
        owner: this.owner,
        repo: this.repo,
        token,
        path: 'annotations/moderation',
        ref: branch
      });
      const file = Array.isArray(entries)
        ? entries.find((e) => e?.type === 'file' && toCleanString(e?.name) === 'merges.json')
        : null;
      const sha = toCleanString(file?.sha) || null;
      if (!file) return { doc: null, sha: null, path, fetched: false };
      const prev = known ? toCleanString(known[path] || '') : '';
      if (sha && prev && sha === prev) return { doc: null, sha, path, fetched: false };

      const { json } = await readJsonFile({
        workerOrigin,
        owner: this.owner,
        repo: this.repo,
        token,
        path,
        ref: branch
      });
      return { doc: json, sha, path, fetched: true };
    } catch (err) {
      if (isNotFoundError(err)) return { doc: null, sha: null, path, fetched: false };
      throw err;
    }
  }

  async pushModerationMerges({ mergesDoc, commitMessage = null } = {}) {
    const token = this.token;
    if (!token) throw new Error('GitHub sign-in required');

    const repoInfo = this._repoInfo || await getRepoInfo({ workerOrigin: this.workerOrigin, owner: this.owner, repo: this.repo, token });
    this._repoInfo = repoInfo || null;
    const perms = repoInfo?.permissions || null;
    const canManage = perms ? Boolean(perms.maintain || perms.admin) : false;
    if (!canManage) throw new Error('Maintain/admin access required to publish moderation merges');

    const branch = this.branch || repoInfo?.default_branch || 'main';
    this.branch = branch;

    let sha = null;
    try {
      const existing = await getContent({
        workerOrigin: this.workerOrigin,
        owner: this.owner,
        repo: this.repo,
        token,
        path: 'annotations/moderation/merges.json',
        ref: branch
      });
      if (existing?.type === 'file' && existing?.sha) sha = existing.sha;
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }

    const doc = mergesDoc && typeof mergesDoc === 'object'
      ? mergesDoc
      : { version: 1, updatedAt: new Date().toISOString(), merges: [] };
    const content = encodeBase64Utf8(JSON.stringify(doc, null, 2) + '\n');
    const msg = toCleanString(commitMessage) || 'Update annotation moderation merges';
    const res = await putContent({
      workerOrigin: this.workerOrigin,
      owner: this.owner,
      repo: this.repo,
      token,
      path: 'annotations/moderation/merges.json',
      branch,
      message: msg,
      contentBase64: content,
      sha
    });

    const newSha = toCleanString(res?.content?.sha || res?.sha || '') || null;
    return { branch, path: 'annotations/moderation/merges.json', sha: newSha };
  }

  async getAuthenticatedUser() {
    const token = this.token;
    if (!token) return null;
    try {
      return await workerAuthRequest(this.workerOrigin, '/auth/user', { token });
    } catch {
      return null;
    }
  }

  async pullAllUsers({ knownShas = null } = {}) {
    const token = this.token;
    if (!token) throw new Error('GitHub sign-in required');
    const branch = this.branch || 'main';
    const workerOrigin = this.workerOrigin;

    const entries = await listDir({
      workerOrigin,
      owner: this.owner,
      repo: this.repo,
      token,
      path: 'annotations/users',
      ref: branch
    });

    const jsonFiles = entries
      .filter((e) => e?.type === 'file' && typeof e?.name === 'string' && e.name.endsWith('.json'))
      .slice(0, 2000);

    /** @type {Record<string, string>} */
    const nextShas = {};
    for (const f of jsonFiles) {
      const name = toCleanString(f?.name);
      const sha = toCleanString(f?.sha);
      if (!name || !sha) continue;
      nextShas[`annotations/users/${name}`] = sha;
    }

    const known = (knownShas && typeof knownShas === 'object') ? knownShas : null;

    const needsFetch = (name, sha) => {
      if (!known) return true;
      const prev = toCleanString(known[name] || '');
      return !prev || prev !== sha;
    };

    const out = [];
    let fetchedCount = 0;
    for (const f of jsonFiles) {
      const name = toCleanString(f?.name);
      const sha = toCleanString(f?.sha);
      if (!name) continue;
      const path = `annotations/users/${name}`;
      if (sha && !needsFetch(path, sha)) continue;
      try {
        const { json } = await readJsonFile({
          workerOrigin,
          owner: this.owner,
          repo: this.repo,
          token,
          path,
          ref: branch
        });
        out.push(json);
        fetchedCount++;
      } catch (err) {
        // Skip invalid files; surface in UI via aggregate error if needed.
        // (No token in error message.)
        out.push({ __invalid: true, __path: name, __error: err?.message || String(err) });
        fetchedCount++;
      }
    }

    return {
      docs: out,
      shas: nextShas,
      fetchedCount,
      totalCount: jsonFiles.length
    };
  }

  async pullUserFile({ username } = {}) {
    const token = this.token;
    if (!token) throw new Error('GitHub sign-in required');
    const branch = this.branch || 'main';
    const workerOrigin = this.workerOrigin;

    const u = toCleanString(username).replace(/^@+/, '');
    if (!u) throw new Error('username required');
    const fileUser = sanitizeUsernameForPath(u);
    const path = `annotations/users/${fileUser}.json`;

    try {
      const { json, sha } = await readJsonFile({
        workerOrigin,
        owner: this.owner,
        repo: this.repo,
        token,
        path,
        ref: branch
      });
      return { doc: json, sha: sha || null, path };
    } catch (err) {
      if (err?.status === 404) return null;
      throw err;
    }
  }

  async pushMyUserFile({ userDoc, commitMessage = null, conflictIfRemoteNewerThan = null, force = false } = {}) {
    const token = this.token;
    if (!token) throw new Error('GitHub token required to push');
    const branch = this.branch || 'main';
    const workerOrigin = this.workerOrigin;

    const username = toCleanString(userDoc?.username);
    if (!username) throw new Error('User doc missing username');
    const fileUser = sanitizeUsernameForPath(username);
    const path = `annotations/users/${fileUser}.json`;

    let sha = null;
    let remoteUpdatedAt = null;
    try {
      const existing = await getContent({ workerOrigin, owner: this.owner, repo: this.repo, token, path, ref: branch });
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

    const repoInfo = this._repoInfo || await getRepoInfo({ workerOrigin, owner: this.owner, repo: this.repo, token });
    this._repoInfo = repoInfo || null;
    const perms = repoInfo?.permissions || null;
    const canPushDirect = perms ? Boolean(perms?.push || perms?.maintain || perms?.admin) : null;

    const content = encodeBase64Utf8(JSON.stringify(userDoc, null, 2) + '\n');
    const msg = toCleanString(commitMessage) || `Update annotations for @${fileUser}`;

    // Prefer direct push when permitted; if permissions are unknown, try direct push first and fall back to PR.
    if (canPushDirect !== false) {
      try {
        const res = await putContent({
          workerOrigin,
          owner: this.owner,
          repo: this.repo,
          token,
          path,
          branch,
          message: msg,
          contentBase64: content,
          sha
        });
        const newSha = toCleanString(res?.content?.sha || res?.sha || '') || null;
        return { mode: 'push', path, remoteUpdatedAt, sha: newSha };
      } catch (err) {
        const status = err?.status;
        const isDenied = status === 401 || status === 403;
        if (canPushDirect === true || !isDenied) throw err;
        // Permissions were missing/unknown and the push was denied; fall back to fork + PR.
      }
    }

    // No direct write access: fork + PR flow.
    const me = await workerAuthRequest(workerOrigin, '/auth/user', { token });
    const meLogin = toCleanString(me?.login || '');
    if (!meLogin) throw new Error('Unable to determine GitHub user (GET /auth/user)');

    // Ensure a fork exists (or create one).
    try {
      await githubRequest(workerOrigin, `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/forks`, {
        token,
        method: 'POST'
      });
    } catch (err) {
      // "already_exists" / "fork exists" should not block PR flow.
      if (err?.status !== 422) throw err;
    }

    const forkOwner = meLogin;
    const forkRepo = this.repo;

    // Wait for fork to become available.
    let forkInfo = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        forkInfo = await githubRequest(workerOrigin, `/repos/${encodeURIComponent(forkOwner)}/${encodeURIComponent(forkRepo)}`, { token });
        if (forkInfo) break;
      } catch (err) {
        if (err?.status !== 404) throw err;
      }
      await sleep(650 + attempt * 120);
    }
    if (!forkInfo) {
      throw new Error(
        `Fork not ready. Install the GitHub App on your personal account (ideally "All repositories"), then try again.`
      );
    }

    const forkBase = toCleanString(forkInfo?.default_branch || '') || 'main';

    // Create a branch in the fork.
    const baseRef = await githubRequest(
      workerOrigin,
      `/repos/${encodeURIComponent(forkOwner)}/${encodeURIComponent(forkRepo)}/git/ref/heads/${encodeURIComponent(forkBase)}`,
      { token }
    );
    const baseSha = toCleanString(baseRef?.object?.sha || '');
    if (!baseSha) throw new Error('Unable to read fork base branch SHA');

    const branchSuffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const prBranch = `cellucid-annotations/${fileUser}/${branchSuffix}`;

    await githubRequest(workerOrigin, `/repos/${encodeURIComponent(forkOwner)}/${encodeURIComponent(forkRepo)}/git/refs`, {
      token,
      method: 'POST',
      body: { ref: `refs/heads/${prBranch}`, sha: baseSha }
    });

    // Upsert file in the fork branch.
    let forkSha = null;
    try {
      const existingFork = await getContent({ workerOrigin, owner: forkOwner, repo: forkRepo, token, path, ref: prBranch });
      if (existingFork?.type === 'file' && existingFork?.sha) forkSha = existingFork.sha;
    } catch (err) {
      if (err?.status !== 404) throw err;
    }

    await putContent({
      workerOrigin,
      owner: forkOwner,
      repo: forkRepo,
      token,
      path,
      branch: prBranch,
      message: msg,
      contentBase64: content,
      sha: forkSha
    });

    const prBody = [
      'Automated community annotation update from Cellucid.',
      '',
      `User: @${meLogin}`,
      `File: \`${path}\``
    ].join('\n');

    const pr = await githubRequest(workerOrigin, `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/pulls`, {
      token,
      method: 'POST',
      body: {
        title: msg,
        head: `${forkOwner}:${prBranch}`,
        base: branch,
        body: prBody,
        maintainer_can_modify: true
      }
    });

    return {
      mode: 'pr',
      path,
      remoteUpdatedAt,
      prUrl: toCleanString(pr?.html_url || '') || null,
      prNumber: pr?.number ?? null
    };
  }
}

export function getGitHubSyncForDataset({ datasetId, username = 'local', tokenOverride = null } = {}) {
  const repo = getAnnotationRepoForDataset(datasetId, username);
  if (!repo) return null;
  const parsed = parseOwnerRepo(repo);
  if (!parsed) return null;
  const token = tokenOverride || getGitHubAuthSession().getToken() || null;
  return new CommunityAnnotationGitHubSync({
    datasetId,
    owner: parsed.owner,
    repo: parsed.repo,
    token,
    branch: parsed.ref || null,
    workerOrigin: getGitHubWorkerOrigin()
  });
}

export function setDatasetAnnotationRepoFromUrlParam({ datasetId, urlParamValue, username = 'local' }) {
  const parsed = parseOwnerRepo(urlParamValue);
  if (!parsed) return false;
  return setAnnotationRepoForDataset(datasetId, parsed.ownerRepoRef, username);
}
