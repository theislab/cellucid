/**
 * Community Annotation - GitHub sync (GitHub App OAuth).
 *
 * Static-site friendly GitHub sync using the REST API "contents" endpoints,
 * proxied through a Cloudflare Worker to avoid exposing client secrets.
 * - Pull: list & fetch `annotations/users/ghid_*.json`, merge into local session
 * - Push: write only `annotations/users/ghid_<id>.json`
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

function nowIso() {
  try {
    return new Date().toISOString();
  } catch {
    return String(Date.now());
  }
}

function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const v of Array.isArray(values) ? values : []) {
    const s = toCleanString(v);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function stableStringifyJson(value) {
  const seen = new WeakSet();
  const walk = (v) => {
    if (v == null) return null;
    if (typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(walk);
    if (seen.has(v)) return null;
    seen.add(v);
    const out = {};
    for (const k of Object.keys(v).sort()) {
      out[k] = walk(v[k]);
    }
    return out;
  };
  try {
    return JSON.stringify(walk(value));
  } catch {
    return '';
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

function sanitizeUserKeyForPath(userKey) {
  const raw = toCleanString(userKey).replace(/^@+/, '').toLowerCase();
  const m = raw.match(/^ghid_(\d+)$/);
  if (!m) return null;
  const id = Number(m[1]);
  if (!Number.isFinite(id)) return null;
  const safe = Math.max(0, Math.floor(id));
  return safe ? `ghid_${safe}` : null;
}

function sanitizeBranchPart(value, { maxLen = 40 } = {}) {
  const raw = toCleanString(value).toLowerCase();
  const cleaned = raw
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, Math.max(8, Math.floor(Number(maxLen) || 40)));
  return cleaned || 'default';
}

function toDeterministicPrBranch({ datasetId, baseBranch, fileUser }) {
  const did = sanitizeBranchPart(datasetId || 'default', { maxLen: 32 });
  const base = sanitizeBranchPart(baseBranch || 'main', { maxLen: 32 });
  const user = sanitizeBranchPart(fileUser || 'local', { maxLen: 48 });
  return `cellucid-annotations/${did}/${base}/${user}`;
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

async function putContentWithSingleRetry({ workerOrigin, owner, repo, token, path, branch, message, contentBase64, sha = null, refForRefresh = null }) {
  try {
    return await putContent({ workerOrigin, owner, repo, token, path, branch, message, contentBase64, sha });
  } catch (err) {
    // Resolve rare sha mismatch races (concurrent writes).
    if (err?.status !== 409) throw err;
    const ref = toCleanString(refForRefresh) || toCleanString(branch) || null;
    const existing = await getContent({ workerOrigin, owner, repo, token, path, ref });
    const nextSha = existing?.type === 'file' ? toCleanString(existing?.sha || '') || null : null;
    return putContent({ workerOrigin, owner, repo, token, path, branch, message, contentBase64, sha: nextSha });
  }
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

async function readJsonFileOrNull({ workerOrigin, owner, repo, token, path, ref }) {
  try {
    return await readJsonFile({ workerOrigin, owner, repo, token, path, ref });
  } catch (err) {
    if (isNotFoundError(err)) return { json: null, sha: null };
    throw err;
  }
}

function normalizeModerationMergesDoc(doc) {
  const input = (doc && typeof doc === 'object') ? doc : {};
  const merges = Array.isArray(input?.merges) ? input.merges : [];

  const clamp = (value, maxLen) => {
    const s = toCleanString(value);
    if (!s) return '';
    return s.length > maxLen ? s.slice(0, maxLen) : s;
  };

  const isNewer = (prev, next) => {
    const ax = toCleanString(prev?.at || '');
    const ay = toCleanString(next?.at || '');
    if (ax && ay && ay > ax) return true;
    if (ax && ay && ax > ay) return false;
    if (!ax && ay) return true;
    if (ax && !ay) return false;
    const score = (m) => (toCleanString(m?.by || '') ? 1 : 0) + (toCleanString(m?.note || '') ? 1 : 0);
    return score(next) > score(prev);
  };

  // Moderation merges are an author-maintained "current mapping", not an append-only event log.
  // Keep at most one active merge per (bucket, fromSuggestionId).
  const newestByKey = new Map();
  for (const raw of merges.slice(0, 10000)) {
    const bucket = toCleanString(raw?.bucket);
    const fromSuggestionId = toCleanString(raw?.fromSuggestionId);
    const intoSuggestionId = toCleanString(raw?.intoSuggestionId);
    if (!bucket || !fromSuggestionId || !intoSuggestionId) continue;
    if (fromSuggestionId === intoSuggestionId) continue;

    const entry = {
      bucket,
      fromSuggestionId,
      intoSuggestionId,
      ...(toCleanString(raw?.by || '') ? { by: clamp(raw?.by, 64) } : {}),
      ...(toCleanString(raw?.at || '') ? { at: clamp(raw?.at, 64) } : {}),
      ...(toCleanString(raw?.note || '') ? { note: clamp(raw?.note, 500) } : {})
    };
    const key = `${bucket}::${fromSuggestionId}`;
    const prev = newestByKey.get(key) || null;
    if (!prev || isNewer(prev, entry)) newestByKey.set(key, entry);
  }

  const mergedList = Array.from(newestByKey.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, v]) => v)
    .slice(0, 5000);

  return {
    version: 1,
    updatedAt: nowIso(),
    merges: mergedList
  };
}

async function listDir({ workerOrigin, owner, repo, token = null, path, ref = null }) {
  const content = await getContent({ workerOrigin, owner, repo, token, path, ref });
  if (!Array.isArray(content)) {
    throw new Error(`Expected directory listing at ${path}`);
  }
  return content;
}

async function ensureForkRepo({ workerOrigin, upstreamOwner, upstreamRepo, token, forkOwner }) {
  // Best effort: ask GitHub to create a fork; if it already exists, that's fine.
  /** @type {string|null} */
  let forkRepoName = null;
  try {
    const created = await githubRequest(workerOrigin, `/repos/${encodeURIComponent(upstreamOwner)}/${encodeURIComponent(upstreamRepo)}/forks`, {
      token,
      method: 'POST'
    });
    forkRepoName = toCleanString(created?.name || '') || null;
  } catch (err) {
    // "already_exists" / "fork exists" should not block PR flow.
    if (err?.status !== 422) throw err;
  }

  // If we got a name from the fork-creation response, prefer it.
  if (forkRepoName) return forkRepoName;

  // Common case: fork repo has the same name as upstream.
  try {
    const maybe = await githubRequest(workerOrigin, `/repos/${encodeURIComponent(forkOwner)}/${encodeURIComponent(upstreamRepo)}`, { token });
    const parent = toCleanString(maybe?.parent?.full_name || '') || null;
    if (parent && parent.toLowerCase() === `${upstreamOwner}/${upstreamRepo}`.toLowerCase()) return upstreamRepo;
  } catch (err) {
    if (err?.status !== 404) throw err;
  }

  // Edge case: fork was renamed (or upstream repo name collides). Find the user's fork via the upstream forks listing.
  for (let page = 1; page <= 5; page++) {
    const forks = await githubRequest(workerOrigin, `/repos/${encodeURIComponent(upstreamOwner)}/${encodeURIComponent(upstreamRepo)}/forks`, {
      token,
      query: { per_page: 100, page }
    });
    const list = Array.isArray(forks) ? forks : [];
    for (const f of list) {
      const full = toCleanString(f?.full_name || '');
      if (!full) continue;
      const [o, r] = full.split('/');
      if (!o || !r) continue;
      if (o.toLowerCase() === String(forkOwner).toLowerCase()) return r;
    }
    if (list.length < 100) break;
  }

  throw new Error(
    `Unable to locate your fork for ${upstreamOwner}/${upstreamRepo}. ` +
    `If you renamed your fork or cannot fork into your account, create a fork manually and ensure it's visible to the GitHub App, then try again.`
  );
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

  async updateDatasetFieldsToAnnotate({ datasetId, fieldsToAnnotate, annotatableSettings = null, closedFields = null, commitMessage = null } = {}) {
    const token = this.token;
    if (!token) throw new Error('GitHub sign-in required');

    const { repoInfo, branch } = await this.validateAndLoadConfig({ datasetId });
    const perms = repoInfo?.permissions || null;
    const canManage = perms ? Boolean(perms.maintain || perms.admin) : false;
    if (!canManage) throw new Error('Maintain/admin access required to update annotations/config.json');

    const did = toCleanString(datasetId ?? this.datasetId ?? '') || null;
    if (!did) throw new Error('datasetId required');

    const cleanedFields = Array.isArray(fieldsToAnnotate)
      ? fieldsToAnnotate
          .map((v) => toCleanString(v))
          .filter(Boolean)
          .slice(0, 200)
      : [];

      const cleanSettings = (settings) => {
        const input = (settings && typeof settings === 'object') ? settings : {};
        const out = {};
        for (const [fieldKey, raw] of Object.entries(input)) {
          const k = toCleanString(fieldKey);
          if (!k) continue;
          const minAnnotators = Number.isFinite(Number(raw?.minAnnotators)) ? Math.max(0, Math.min(50, Math.floor(Number(raw.minAnnotators)))) : 1;
          const thresholdRaw = Number(raw?.threshold);
          const threshold = Number.isFinite(thresholdRaw) ? Math.max(-1, Math.min(1, thresholdRaw)) : 0.5;
          out[k] = { minAnnotators, threshold };
        }
        return out;
      };

    const cleanClosed = (values) => {
      const input = Array.isArray(values) ? values : [];
      const out = [];
      const seen = new Set();
      for (const v of input.slice(0, 500)) {
        const k = toCleanString(v);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        out.push(k);
      }
      return out;
    };

    // Only persist settings for fields that are currently annotatable.
    const settingsMap = cleanSettings(annotatableSettings);

    const msg = toCleanString(commitMessage) || `Update annotatable fields for ${did}`;

    // Concurrency-safe: rebase onto the latest config on 409, preserving other authors' edits.
    for (let attempt = 0; attempt < 3; attempt++) {
      const { json: current, sha } = await readJsonFileOrNull({
        workerOrigin: this.workerOrigin,
        owner: this.owner,
        repo: this.repo,
        token,
        path: 'annotations/config.json',
        ref: branch
      });

      const nextConfig = (current && typeof current === 'object')
        ? { ...current }
        : { version: 1, supportedDatasets: [] };
      if (!Array.isArray(nextConfig.supportedDatasets)) nextConfig.supportedDatasets = [];

      let found = false;
      nextConfig.supportedDatasets = nextConfig.supportedDatasets.map((d) => {
        if (!d || typeof d !== 'object') return d;
        const dId = toCleanString(d.datasetId);
        if (dId !== did) return d;
        found = true;
        const next = { ...d, fieldsToAnnotate: cleanedFields };
        if (annotatableSettings != null) {
          const merged = { ...cleanSettings(d.annotatableSettings), ...settingsMap };
          const pruned = {};
          for (const k of cleanedFields) {
            if (merged[k]) pruned[k] = merged[k];
          }
          next.annotatableSettings = pruned;
        }
        if (closedFields != null) {
          const merged = uniqueStrings(cleanClosed(d.closedFields).concat(cleanClosed(closedFields)));
          next.closedFields = merged.filter((k) => cleanedFields.includes(k)).slice(0, 500);
        }
        return next;
      });

      if (!found) {
        const pruned = {};
        for (const k of cleanedFields) {
          if (settingsMap[k]) pruned[k] = settingsMap[k];
        }
        const prunedClosed = closedFields != null
          ? cleanClosed(closedFields).filter((k) => cleanedFields.includes(k)).slice(0, 500)
          : undefined;
        nextConfig.supportedDatasets = nextConfig.supportedDatasets.concat([
          {
            datasetId: did,
            name: did,
            fieldsToAnnotate: cleanedFields,
            ...(annotatableSettings != null ? { annotatableSettings: pruned } : {}),
            ...(closedFields != null ? { closedFields: prunedClosed } : {})
          }
        ]);
      }

      // Avoid no-op commits: compare semantic JSON ignoring key order.
      if (current && typeof current === 'object') {
        const changed = stableStringifyJson(current) !== stableStringifyJson(nextConfig);
        if (!changed) {
          const retSettings = {};
          for (const k of cleanedFields) {
            if (settingsMap[k]) retSettings[k] = settingsMap[k];
          }
          const retClosed = closedFields != null
            ? cleanClosed(closedFields).filter((k) => cleanedFields.includes(k)).slice(0, 500)
            : [];
          return {
            branch,
            datasetId: did,
            fieldsToAnnotate: cleanedFields,
            annotatableSettings: retSettings,
            closedFields: retClosed,
            changed: false
          };
        }
      }

      const contentBase64 = encodeBase64Utf8(JSON.stringify(nextConfig, null, 2) + '\n');
      try {
        await putContent({
          workerOrigin: this.workerOrigin,
          owner: this.owner,
          repo: this.repo,
          token,
          path: 'annotations/config.json',
          branch,
          message: msg,
          contentBase64,
          sha
        });
        break;
      } catch (err) {
        if (err?.status !== 409 || attempt === 2) throw err;
      }
    }

    const retSettings = {};
    for (const k of cleanedFields) {
      if (settingsMap[k]) retSettings[k] = settingsMap[k];
    }
    const retClosed = closedFields != null
      ? cleanClosed(closedFields).filter((k) => cleanedFields.includes(k)).slice(0, 500)
      : [];
    return { branch, datasetId: did, fieldsToAnnotate: cleanedFields, annotatableSettings: retSettings, closedFields: retClosed, changed: true };
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

    const msg = toCleanString(commitMessage) || 'Update annotation moderation merges';
    const incoming = normalizeModerationMergesDoc(mergesDoc && typeof mergesDoc === 'object' ? mergesDoc : {});

    // Concurrency-safe: retry with latest sha on 409.
    for (let attempt = 0; attempt < 3; attempt++) {
      const { json: current, sha } = await readJsonFileOrNull({
        workerOrigin: this.workerOrigin,
        owner: this.owner,
        repo: this.repo,
        token,
        path: 'annotations/moderation/merges.json',
        ref: branch
      });

      const currentNorm = (current && typeof current === 'object') ? normalizeModerationMergesDoc(current) : null;
      const currentComparable = currentNorm ? { version: 1, merges: Array.isArray(currentNorm?.merges) ? currentNorm.merges : [] } : null;
      const nextComparable = { version: 1, merges: Array.isArray(incoming?.merges) ? incoming.merges : [] };
      const changed = stableStringifyJson(currentComparable) !== stableStringifyJson(nextComparable);
      if (!changed) {
        return { branch, path: 'annotations/moderation/merges.json', sha: sha || null, changed: false };
      }

      const docToWrite = { version: 1, updatedAt: nowIso(), merges: nextComparable.merges };
      const contentBase64 = encodeBase64Utf8(JSON.stringify(docToWrite, null, 2) + '\n');
      try {
        const res = await putContent({
          workerOrigin: this.workerOrigin,
          owner: this.owner,
          repo: this.repo,
          token,
          path: 'annotations/moderation/merges.json',
          branch,
          message: msg,
          contentBase64,
          sha
        });
        const newSha = toCleanString(res?.content?.sha || res?.sha || '') || null;
        return { branch, path: 'annotations/moderation/merges.json', sha: newSha, changed: true };
      } catch (err) {
        if (err?.status !== 409 || attempt === 2) throw err;
      }
    }

    throw new Error('Unable to publish moderation merges (retry limit)');
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
      .filter((e) => e?.type === 'file' && typeof e?.name === 'string' && /^ghid_\d+\.json$/i.test(e.name))
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
        const fileUser = toCleanString(name.replace(/\.json$/i, '')) || null;
        const doc = (json && typeof json === 'object')
          ? { ...json, __path: path, __fileUser: fileUser, __sha: sha || null }
          : { __invalid: true, __path: name, __error: 'Invalid JSON shape (expected object)' };
        out.push(doc);
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

  async pullUserFile({ userKey = null } = {}) {
    const token = this.token;
    if (!token) throw new Error('GitHub sign-in required');
    const branch = this.branch || 'main';
    const workerOrigin = this.workerOrigin;

    const key = sanitizeUserKeyForPath(userKey);
    if (!key) throw new Error('userKey required');

    try {
      const path = `annotations/users/${key}.json`;
      const { json, sha } = await readJsonFile({
        workerOrigin,
        owner: this.owner,
        repo: this.repo,
        token,
        path,
        ref: branch
      });
      const doc = (json && typeof json === 'object')
        ? { ...json, __path: path, __fileUser: key, __sha: sha || null }
        : null;
      return doc ? { doc, sha: sha || null, path } : null;
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

    const idRaw = userDoc?.githubUserId;
    const id = Number.isFinite(Number(idRaw)) ? Math.max(0, Math.floor(Number(idRaw))) : 0;
    if (!id) throw new Error('User doc missing githubUserId');
    const fileUser = `ghid_${id}`;
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
    const isPrivateRepo = Boolean(repoInfo?.private);
    const allowForking = repoInfo?.allow_forking !== false;

    const docToWrite = { ...(userDoc && typeof userDoc === 'object' ? userDoc : {}), username: fileUser, githubUserId: id };
    const content = encodeBase64Utf8(JSON.stringify(docToWrite, null, 2) + '\n');
    const login = toCleanString(userDoc?.login || '') || null;
    const msg = toCleanString(commitMessage) || `Update annotations for @${login || fileUser}`;

    // Prefer direct push when permitted; if permissions are unknown, try direct push first and fall back to PR.
    if (canPushDirect !== false) {
      try {
        const res = await putContentWithSingleRetry({
          workerOrigin,
          owner: this.owner,
          repo: this.repo,
          token,
          path,
          branch,
          message: msg,
          contentBase64: content,
          sha,
          refForRefresh: branch
        });
        const newSha = toCleanString(res?.content?.sha || res?.sha || '') || null;
        return { mode: 'push', path, remoteUpdatedAt, sha: newSha };
      } catch (err) {
        const status = err?.status;
        const isDenied = status === 401 || status === 403;
        if (canPushDirect === true || !isDenied) throw err;
        if (!allowForking) {
          throw new Error(
            'This repository does not allow forking, so you cannot publish via Pull Request. ' +
            'Ask the repo admins to enable forking or grant you GitHub role "Write" (or higher).'
          );
        }
        // Permissions were missing/unknown and the push was denied; fall back to fork + PR.
      }
    }

    if (!allowForking) {
      throw new Error(
        'This repository does not allow forking, so you cannot publish via Pull Request. ' +
        'Ask the repo admins to enable forking or grant you GitHub role "Write" (or higher).'
      );
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
      if (err?.status !== 422) {
        const status = err?.status;
        if (status === 401 || status === 403) {
          throw new Error(
            'Unable to create or access a fork for Pull Request publishing. ' +
            'Make sure the GitHub App is installed for your account, and that you have permission to fork this repository.'
          );
        }
        throw err;
      }
    }

    const forkOwner = meLogin;
    let forkRepo = null;
    try {
      forkRepo = await ensureForkRepo({
        workerOrigin,
        upstreamOwner: this.owner,
        upstreamRepo: this.repo,
        token,
        forkOwner
      });
    } catch (err) {
      const msg = isPrivateRepo
        ? (
          `Unable to locate your fork for this private repository. ` +
          `Install the Cellucid GitHub App on your personal account (ideally "All repositories"), ` +
          `then retry Publish.`
        )
        : null;
      if (msg) throw new Error(msg);
      throw err;
    }

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

    // Deterministic branch per (datasetId, baseBranch, user) so repeated Publish updates a single PR.
    const prBranch = toDeterministicPrBranch({ datasetId: this.datasetId, baseBranch: branch, fileUser });

    // Create the branch if missing (base on the upstream branch tip for cleaner PR diffs).
    let upstreamBaseSha = null;
    try {
      const upstreamRef = await githubRequest(
        workerOrigin,
        `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/ref/heads/${encodeURIComponent(branch)}`,
        { token }
      );
      upstreamBaseSha = toCleanString(upstreamRef?.object?.sha || '') || null;
    } catch {
      upstreamBaseSha = null;
    }
    if (!upstreamBaseSha) {
      const forkBase = toCleanString(forkInfo?.default_branch || '') || 'main';
      const baseRef = await githubRequest(
        workerOrigin,
        `/repos/${encodeURIComponent(forkOwner)}/${encodeURIComponent(forkRepo)}/git/ref/heads/${encodeURIComponent(forkBase)}`,
        { token }
      );
      upstreamBaseSha = toCleanString(baseRef?.object?.sha || '') || null;
    }
    if (!upstreamBaseSha) throw new Error('Unable to determine base SHA for PR branch');

    let branchExists = false;
    try {
      await githubRequest(
        workerOrigin,
        `/repos/${encodeURIComponent(forkOwner)}/${encodeURIComponent(forkRepo)}/git/ref/heads/${encodeURIComponent(prBranch)}`,
        { token }
      );
      branchExists = true;
    } catch (err) {
      if (err?.status !== 404) throw err;
      branchExists = false;
    }
    if (!branchExists) {
      try {
        await githubRequest(workerOrigin, `/repos/${encodeURIComponent(forkOwner)}/${encodeURIComponent(forkRepo)}/git/refs`, {
          token,
          method: 'POST',
          body: { ref: `refs/heads/${prBranch}`, sha: upstreamBaseSha }
        });
      } catch (err) {
        // If another publish created it concurrently, proceed.
        if (err?.status !== 422) throw err;
      }
    }

    // Upsert file in the fork branch.
    let forkSha = null;
    try {
      const existingFork = await getContent({ workerOrigin, owner: forkOwner, repo: forkRepo, token, path, ref: prBranch });
      if (existingFork?.type === 'file' && existingFork?.sha) forkSha = existingFork.sha;
    } catch (err) {
      if (err?.status !== 404) throw err;
    }

    await putContentWithSingleRetry({
      workerOrigin,
      owner: forkOwner,
      repo: forkRepo,
      token,
      path,
      branch: prBranch,
      message: msg,
      contentBase64: content,
      sha: forkSha,
      refForRefresh: prBranch
    });

    // If an open PR already exists for this head/base, reuse it (avoids PR spam).
    try {
      const existing = await githubRequest(workerOrigin, `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/pulls`, {
        token,
        query: { state: 'open', head: `${forkOwner}:${prBranch}`, base: branch, per_page: 5 }
      });
      const pr0 = Array.isArray(existing) ? existing[0] : null;
      if (pr0) {
        return {
          mode: 'pr',
          path,
          remoteUpdatedAt,
          prUrl: toCleanString(pr0?.html_url || '') || null,
          prNumber: pr0?.number ?? null,
          reused: true
        };
      }
    } catch {
      // ignore and fall through to creating a PR
    }

    const prBody = [
      'Automated community annotation update from Cellucid.',
      '',
      `User: @${meLogin}`,
      `File: \`${path}\``
    ].join('\n');

    let pr = null;
    let reused = false;
    try {
      pr = await githubRequest(workerOrigin, `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/pulls`, {
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
    } catch (err) {
      // GitHub returns 422 if a PR already exists for this head/base (sometimes even if closed).
      if (err?.status !== 422) throw err;
      try {
        const prs = await githubRequest(workerOrigin, `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/pulls`, {
          token,
          query: { state: 'all', head: `${forkOwner}:${prBranch}`, base: branch, per_page: 10 }
        });
        const list = Array.isArray(prs) ? prs : [];
        const existing = list.find((p) => p && p.number) || null;
        if (!existing) throw err;
        reused = true;
        // If the previous PR was merged, you cannot reopen it; create a fresh PR from a new branch
        // that points to the current fork branch head (avoids PR spam during review, but supports
        // a new review cycle after merge).
        const mergedAt = toCleanString(existing?.merged_at || '');
        if (existing?.state === 'closed' && mergedAt) {
          reused = false;
          const ref = await githubRequest(
            workerOrigin,
            `/repos/${encodeURIComponent(forkOwner)}/${encodeURIComponent(forkRepo)}/git/ref/heads/${encodeURIComponent(prBranch)}`,
            { token }
          );
          const headSha = toCleanString(ref?.object?.sha || '') || null;
          if (!headSha) throw err;
          let alt = null;
          for (let attempt = 0; attempt < 5; attempt++) {
            const suffix = `${Date.now().toString(36)}${attempt ? `_${attempt}` : ''}`;
            alt = `${prBranch}-${suffix}`;
            try {
              await githubRequest(workerOrigin, `/repos/${encodeURIComponent(forkOwner)}/${encodeURIComponent(forkRepo)}/git/refs`, {
                token,
                method: 'POST',
                body: { ref: `refs/heads/${alt}`, sha: headSha }
              });
              break;
            } catch (createErr) {
              if (createErr?.status !== 422 || attempt === 4) throw createErr;
            }
          }
          pr = await githubRequest(workerOrigin, `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/pulls`, {
            token,
            method: 'POST',
            body: {
              title: msg,
              head: `${forkOwner}:${alt}`,
              base: branch,
              body: prBody,
              maintainer_can_modify: true
            }
          });
        } else if (existing?.state === 'closed') {
          try {
            pr = await githubRequest(workerOrigin, `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/pulls/${encodeURIComponent(existing.number)}`, {
              token,
              method: 'PATCH',
              body: { state: 'open' }
            });
          } catch {
            // If reopen fails (permissions), still return the existing PR link so the user can act.
            pr = existing;
          }
        } else {
          pr = existing;
        }
      } catch (fallbackErr) {
        // If we can't recover, surface the original error.
        throw fallbackErr || err;
      }
    }

    return {
      mode: 'pr',
      path,
      remoteUpdatedAt,
      prUrl: toCleanString(pr?.html_url || '') || null,
      prNumber: pr?.number ?? null,
      reused
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

export async function setDatasetAnnotationRepoFromUrlParamAsync({ datasetId, urlParamValue, username = 'local', tokenOverride = null } = {}) {
  const parsed = parseOwnerRepo(urlParamValue);
  if (!parsed) return false;

  // If no branch is specified, resolve the repo's default branch ("HEAD") and persist owner/repo@branch.
  if (!parsed.ref) {
    const token = tokenOverride || getGitHubAuthSession().getToken() || null;
    if (!token) return false;
    const repoInfo = await getRepoInfo({
      workerOrigin: getGitHubWorkerOrigin(),
      owner: parsed.owner,
      repo: parsed.repo,
      token
    });
    const head = toCleanString(repoInfo?.default_branch || '') || 'main';
    return setAnnotationRepoForDataset(datasetId, `${parsed.ownerRepo}@${head}`, username);
  }

  return setAnnotationRepoForDataset(datasetId, parsed.ownerRepoRef, username);
}
