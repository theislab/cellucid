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
import {
  getAnnotationRepoForDataset,
  getAnnotationRepoMetaForDataset,
  setAnnotationRepoForDataset,
  setAnnotationRepoMetaForDataset
} from './repo-store.js';

const GITHUB_DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_USER_PULL_CONCURRENCY = 8;
const MAX_TREE_ITEMS = 250_000;

function toCleanString(value) {
  return String(value ?? '').trim();
}

function normalizeTimeoutMs(rawTimeoutMs, fallbackMs) {
  const n = Number(rawTimeoutMs);
  if (!Number.isFinite(n)) return fallbackMs;
  return Math.max(0, Math.floor(n));
}

function isAbortError(err) {
  return err?.name === 'AbortError';
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

function parseDateMsOrNull(value) {
  const s = toCleanString(value);
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

function normalizeDatasetAccessMap(map) {
  const input = (map && typeof map === 'object' && !Array.isArray(map)) ? map : null;
  const out = {};
  if (!input) return out;
  for (const [datasetIdRaw, entry] of Object.entries(input)) {
    const datasetId = toCleanString(datasetIdRaw);
    if (!datasetId || !entry || typeof entry !== 'object') continue;
    const fields = uniqueStrings(Array.isArray(entry.fieldsToAnnotate) ? entry.fieldsToAnnotate : []).slice(0, 200);
    const lastAccessedAt = toCleanString(entry.lastAccessedAt) || null;
    out[datasetId] = { fieldsToAnnotate: fields, lastAccessedAt };
  }
  return out;
}

function mergeDatasetAccessMaps(left, right) {
  const a = normalizeDatasetAccessMap(left);
  const b = normalizeDatasetAccessMap(right);
  const out = { ...a };
  for (const [datasetId, entry] of Object.entries(b)) {
    const prev = out[datasetId] || null;
    if (!prev) {
      out[datasetId] = entry;
      continue;
    }
    const prevMs = parseDateMsOrNull(prev.lastAccessedAt);
    const nextMs = parseDateMsOrNull(entry.lastAccessedAt);
    if (prevMs != null && nextMs != null) {
      out[datasetId] = nextMs >= prevMs ? entry : prev;
      continue;
    }
    if (prevMs == null && nextMs != null) {
      out[datasetId] = entry;
      continue;
    }
    if (prevMs != null && nextMs == null) {
      out[datasetId] = prev;
      continue;
    }
    out[datasetId] = entry.fieldsToAnnotate.length >= prev.fieldsToAnnotate.length ? entry : prev;
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

function assertSupportedUserFileSchema(schema, { path = 'annotations/schema.json' } = {}) {
  const doc = (schema && typeof schema === 'object') ? schema : null;
  if (!doc) throw new Error(`Invalid JSON schema at ${path}`);

  const versionConst = doc?.properties?.version?.const;
  const version = Number.isFinite(Number(versionConst)) ? Number(versionConst) : null;
  if (version !== 1) {
    throw new Error(
      `Unsupported annotation user-file schema version in ${path}.\n` +
      `Expected version=1 but got ${versionConst == null ? 'missing' : String(versionConst)}.`
    );
  }

  const required = Array.isArray(doc?.required) ? doc.required.map((v) => toCleanString(v)).filter(Boolean) : [];
  const req = new Set(required);
  for (const key of ['version', 'username', 'githubUserId', 'updatedAt', 'suggestions', 'votes']) {
    if (!req.has(key)) {
      throw new Error(`Unsupported annotation user-file schema at ${path} (missing required field: ${key}).`);
    }
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

async function getGitTreeRecursive({ workerOrigin, owner, repo, token = null, ref }) {
  const treeish = toCleanString(ref);
  if (!treeish) throw new Error('Ref required');
  const res = await githubRequest(
    workerOrigin,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(treeish)}`,
    { token, query: { recursive: 1 } }
  );
  const list = Array.isArray(res?.tree) ? res.tree : null;
  if (!list) throw new Error('Expected git tree listing');
  // Hard cap to avoid pathological repos freezing the browser.
  return list.slice(0, MAX_TREE_ITEMS);
}

async function getGitBlobJson({ workerOrigin, owner, repo, token = null, sha }) {
  const s = toCleanString(sha);
  if (!s) throw new Error('Blob sha required');
  const res = await githubRequest(
    workerOrigin,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(s)}`,
    { token }
  );
  const encoding = toCleanString(res?.encoding || '');
  const content = toCleanString(res?.content || '');
  if (!content) throw new Error('Empty blob content');
  const decoded = encoding.toLowerCase() === 'base64' ? decodeBase64Utf8(content) : content;
  const parsed = safeJsonParse(decoded);
  if (!parsed) throw new Error('Invalid JSON');
  return parsed;
}

function sleep(ms) {
  const t = Math.max(0, Math.floor(Number(ms) || 0));
  return new Promise((resolve) => setTimeout(resolve, t));
}

async function mapWithConcurrency(items, concurrency, fn) {
  const list = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Math.floor(Number(concurrency) || 1));
  const results = new Array(list.length);
  if (!list.length) return results;

  let nextIndex = 0;
  const workers = new Array(Math.min(limit, list.length)).fill(null).map(async () => {
    while (true) {
      const idx = nextIndex;
      nextIndex += 1;
      if (idx >= list.length) return;
      results[idx] = await fn(list[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

export function parseOwnerRepo(input) {
  const raw = toCleanString(input);
  if (!raw) return null;

  /** @type {string|null} */
  let ref = null;
  /** @type {string|null} */
  let treeRefPath = null;

  let cleaned = raw
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/^https?:\/\/api\.github\.com\/repos\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/^\/+|\/+$/g, '');

  // Drop query params for URL pastes (e.g. "...?tab=readme").
  const qIdx = cleaned.indexOf('?');
  if (qIdx >= 0) cleaned = cleaned.slice(0, qIdx);

  // Support ".../owner/repo.git"
  cleaned = cleaned.replace(/\.git$/i, '');

  // Support ".../owner/repo/tree/branch[/...]" links.
  // Note: branch names can include slashes, so we capture the entire tail after `/tree/`.
  const treeMatch = cleaned.match(/^([^/]+\/[^/]+)\/tree\/(.+)$/i);
  if (treeMatch) {
    cleaned = treeMatch[1];
    treeRefPath = toCleanString(treeMatch[2]) || null;
    // Keep the full tree ref+path tail (may include path segments). We resolve it to a real branch
    // during connect by probing for the required template files (schema/config).
    ref = treeRefPath;
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
    const refOk = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/.test(ref);
    if (!refOk) ref = null;
  }

  const ownerRepo = `${owner}/${repo}`;
  const ownerRepoRef = ref ? `${ownerRepo}@${ref}` : ownerRepo;
  return { owner, repo, ownerRepo, ref, ownerRepoRef, treeRefPath };
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

function fnv1aHash32(input) {
  const str = String(input ?? '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function encodeGitRefPath(ref) {
  const raw = toCleanString(ref);
  if (!raw) return '';
  return raw.split('/').map((p) => encodeURIComponent(p)).join('/');
}

function toDeterministicPrBranch({ datasetId, baseBranch, fileUser }) {
  const didRaw = toCleanString(datasetId || 'default') || 'default';
  const baseRaw = toCleanString(baseBranch || 'main') || 'main';
  const userRaw = toCleanString(fileUser || 'local') || 'local';

  const did = sanitizeBranchPart(didRaw, { maxLen: 32 });
  const base = sanitizeBranchPart(baseRaw, { maxLen: 32 });
  const user = sanitizeBranchPart(userRaw, { maxLen: 48 });

  // Avoid collisions from truncation/normalization by suffixing a stable hash.
  const fingerprint = fnv1aHash32(`${didRaw}::${baseRaw}::${userRaw}`).toString(36);
  return `cellucid-annotations/${did}/${base}/${user}-${fingerprint}`;
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

async function githubRequest(workerOrigin, path, { token = null, method = 'GET', query = null, body = null, timeoutMs = GITHUB_DEFAULT_TIMEOUT_MS } = {}) {
  const url = toWorkerApiUrl(workerOrigin, path);
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (v == null) continue;
      url.searchParams.set(k, String(v));
    }
  }

  const headers = {
    Accept: 'application/vnd.github+json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body != null) headers['Content-Type'] = 'application/json';

  const ms = normalizeTimeoutMs(timeoutMs, GITHUB_DEFAULT_TIMEOUT_MS);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const signal = controller?.signal;

  /** @type {ReturnType<typeof setTimeout> | null} */
  let timeout = null;
  if (controller && ms > 0) {
    timeout = setTimeout(() => {
      try { controller.abort(); } catch { /* ignore */ }
    }, ms);
  }

  try {
    const res = await fetch(url.toString(), {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
      signal: signal || undefined
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
  } catch (err) {
    if (isAbortError(err)) {
      const msg = ms > 0 ? `GitHub request timed out after ${Math.max(1, Math.round(ms / 1000))}s` : 'GitHub request aborted';
      const e = new Error(msg);
      e.code = 'TIMEOUT';
      e.github = { path, method };
      throw e;
    }
    try {
      if (err && typeof err === 'object' && !err.github) err.github = { path, method };
    } catch {
      // ignore
    }
    throw err;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function workerAuthRequest(workerOrigin, path, { token = null, method = 'GET', body = null, timeoutMs = GITHUB_DEFAULT_TIMEOUT_MS } = {}) {
  const url = toWorkerAuthUrl(workerOrigin, path);
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body != null) headers['Content-Type'] = 'application/json';

  const ms = normalizeTimeoutMs(timeoutMs, GITHUB_DEFAULT_TIMEOUT_MS);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const signal = controller?.signal;

  /** @type {ReturnType<typeof setTimeout> | null} */
  let timeout = null;
  if (controller && ms > 0) {
    timeout = setTimeout(() => {
      try { controller.abort(); } catch { /* ignore */ }
    }, ms);
  }

  try {
    const res = await fetch(url.toString(), {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
      signal: signal || undefined
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
  } catch (err) {
    if (isAbortError(err)) {
      const msg = ms > 0 ? `Auth request timed out after ${Math.max(1, Math.round(ms / 1000))}s` : 'Auth request aborted';
      const e = new Error(msg);
      e.code = 'TIMEOUT';
      e.worker = { path, method };
      throw e;
    }
    try {
      if (err && typeof err === 'object' && !err.worker) err.worker = { path, method };
    } catch {
      // ignore
    }
    throw err;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
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

function isWriteDeniedError(err) {
  const status = err?.status;
  return status === 401 || status === 403;
}

function isProtectedBranchError(err) {
  const msg = toCleanString(err?.message || '').toLowerCase();
  if (!msg) return false;
  return (
    msg.includes('protected branch') ||
    msg.includes('branch protection') ||
    msg.includes('protected branch hook declined') ||
    msg.includes('pushes to this branch are restricted') ||
    msg.includes('required pull request') ||
    msg.includes('required status checks') ||
    msg.includes('required reviews')
  );
}

function isShaMismatchError(err) {
  const status = err?.status;
  const msg = toCleanString(err?.message || '').toLowerCase();
  if (status === 422) {
    // GitHub often reports sha mismatches / missing sha as 422 with message containing "sha".
    // Avoid treating protected-branch failures as sha mismatches.
    if (isProtectedBranchError(err)) return false;
    return msg.includes('sha');
  }
  if (status !== 409) return false;
  // 409 can be used for non-sha errors (e.g., protected branch update failures).
  if (isProtectedBranchError(err)) return false;
  return msg.includes('sha') || msg.includes('does not match') || msg.includes('was not supplied') || msg.includes("wasn't supplied");
}

async function putContentWithRetry({
  workerOrigin,
  owner,
  repo,
  token,
  path,
  branch,
  message,
  contentBase64,
  sha = null,
  refForRefresh = null,
  maxAttempts = 3
}) {
  const max = Math.max(1, Math.floor(Number(maxAttempts) || 3));
  let nextSha = sha;
  for (let attempt = 0; attempt < max; attempt++) {
    try {
      return await putContent({ workerOrigin, owner, repo, token, path, branch, message, contentBase64, sha: nextSha });
    } catch (err) {
      // Resolve rare sha mismatch races (concurrent writes).
      const isShaMismatch = isShaMismatchError(err);
      if (!isShaMismatch || attempt === max - 1) throw err;
      const ref = toCleanString(refForRefresh) || toCleanString(branch) || null;
      const existing = await getContent({ workerOrigin, owner, repo, token, path, ref });
      nextSha = existing?.type === 'file' ? toCleanString(existing?.sha || '') || null : null;
      // Small backoff helps when multiple publishes race in different tabs.
      await sleep(120 * Math.pow(2, attempt));
    }
  }
  throw new Error('Unable to publish file (retry limit)');
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
    const ax = toCleanString(prev?.editedAt || prev?.at || '');
    const ay = toCleanString(next?.editedAt || next?.at || '');
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

    const byRaw = toCleanString(raw?.by || '').replace(/^@+/, '').toLowerCase();
    const atRaw = toCleanString(raw?.at || '');
    const by = clamp(byRaw, 64);
    const at = clamp(atRaw, 64);
    if (!by || !at) continue;

    const entry = {
      bucket,
      fromSuggestionId,
      intoSuggestionId,
      by,
      at,
      ...(toCleanString(raw?.editedAt || '') ? { editedAt: clamp(raw?.editedAt, 64) } : {}),
      ...(toCleanString(raw?.note || '') ? { note: clamp(raw?.note, 512) } : {})
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

async function getBranchTipShaOrNull({ workerOrigin, owner, repo, token, branch }) {
  const b = toCleanString(branch);
  if (!b) return null;
  try {
    const ref = await githubRequest(
      workerOrigin,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeGitRefPath(b)}`,
      { token }
    );
    return toCleanString(ref?.object?.sha || '') || null;
  } catch (err) {
    if (err?.status === 404) return null;
    throw err;
  }
}

async function ensureBranchExists({ workerOrigin, owner, repo, token, branch, baseSha }) {
  const b = toCleanString(branch);
  if (!b) throw new Error('PR branch required');
  const sha = toCleanString(baseSha);
  if (!sha) throw new Error('Unable to determine base SHA for PR branch');
  try {
    await githubRequest(
      workerOrigin,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeGitRefPath(b)}`,
      { token }
    );
    return;
  } catch (err) {
    if (err?.status !== 404) throw err;
  }
  try {
    await githubRequest(workerOrigin, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`, {
      token,
      method: 'POST',
      body: { ref: `refs/heads/${b}`, sha }
    });
  } catch (err) {
    // If another publish created it concurrently, proceed.
    if (err?.status !== 422) throw err;
  }
}

async function upsertFileOnBranch({ workerOrigin, owner, repo, token, branch, path, message, contentBase64 }) {
  const b = toCleanString(branch);
  if (!b) throw new Error('branch required');
  const p = toCleanString(path).replace(/^\/+/, '');
  if (!p) throw new Error('path required');

  let sha = null;
  try {
    const existing = await getContent({ workerOrigin, owner, repo, token, path: p, ref: b });
    if (existing?.type === 'file') sha = toCleanString(existing?.sha || '') || null;
  } catch (err) {
    if (err?.status !== 404) throw err;
  }

  await putContentWithRetry({
    workerOrigin,
    owner,
    repo,
    token,
    path: p,
    branch: b,
    message,
    contentBase64,
    sha,
    refForRefresh: b
  });
}

function formatPullRequestHeadForCreate({ upstreamOwner, headOwner, headBranch }) {
  const u = toCleanString(upstreamOwner).toLowerCase();
  const h = toCleanString(headOwner).toLowerCase();
  const b = toCleanString(headBranch);
  if (!b) throw new Error('headBranch required');
  return u && h && u === h ? b : `${toCleanString(headOwner)}:${b}`;
}

async function openOrReusePullRequest({
  workerOrigin,
  token,
  upstreamOwner,
  upstreamRepo,
  baseBranch,
  headOwner,
  headRepo,
  headBranch,
  title,
  body
}) {
  const headQuery = `${toCleanString(headOwner)}:${toCleanString(headBranch)}`;

  // If an open PR already exists for this head/base, reuse it (avoids PR spam).
  try {
    const existing = await githubRequest(workerOrigin, `/repos/${encodeURIComponent(upstreamOwner)}/${encodeURIComponent(upstreamRepo)}/pulls`, {
      token,
      query: { state: 'open', head: headQuery, base: baseBranch, per_page: 5 }
    });
    const pr0 = Array.isArray(existing) ? existing[0] : null;
    if (pr0) return { pr: pr0, reused: true };
  } catch {
    // ignore and fall through to creating a PR
  }

  const prBody = toCleanString(body);
  const headCreate = formatPullRequestHeadForCreate({ upstreamOwner, headOwner, headBranch });

  let pr = null;
  let reused = false;
  try {
    pr = await githubRequest(workerOrigin, `/repos/${encodeURIComponent(upstreamOwner)}/${encodeURIComponent(upstreamRepo)}/pulls`, {
      token,
      method: 'POST',
      body: {
        title: toCleanString(title) || 'Update annotations',
        head: headCreate,
        base: baseBranch,
        body: prBody || undefined,
        maintainer_can_modify: true
      }
    });
  } catch (err) {
    // GitHub returns 422 if a PR already exists for this head/base (sometimes even if closed).
    if (err?.status !== 422) throw err;
    try {
      const prs = await githubRequest(workerOrigin, `/repos/${encodeURIComponent(upstreamOwner)}/${encodeURIComponent(upstreamRepo)}/pulls`, {
        token,
        query: { state: 'all', head: headQuery, base: baseBranch, per_page: 10 }
      });
      const list = Array.isArray(prs) ? prs : [];
      const existing = list.find((p) => p && p.number) || null;
      if (!existing) throw err;
      reused = true;

      const mergedAt = toCleanString(existing?.merged_at || '');
      if (existing?.state === 'closed' && mergedAt) {
        reused = false;
        const ref = await githubRequest(
          workerOrigin,
          `/repos/${encodeURIComponent(headOwner)}/${encodeURIComponent(headRepo)}/git/ref/heads/${encodeGitRefPath(headBranch)}`,
          { token }
        );
        const headSha = toCleanString(ref?.object?.sha || '') || null;
        if (!headSha) throw err;

        let alt = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          const suffix = `${Date.now().toString(36)}${attempt ? `_${attempt}` : ''}`;
          alt = `${toCleanString(headBranch)}-${suffix}`;
          try {
            await githubRequest(workerOrigin, `/repos/${encodeURIComponent(headOwner)}/${encodeURIComponent(headRepo)}/git/refs`, {
              token,
              method: 'POST',
              body: { ref: `refs/heads/${alt}`, sha: headSha }
            });
            break;
          } catch (createErr) {
            if (createErr?.status !== 422 || attempt === 4) throw createErr;
          }
        }

        const headAlt = formatPullRequestHeadForCreate({ upstreamOwner, headOwner, headBranch: alt });
        pr = await githubRequest(workerOrigin, `/repos/${encodeURIComponent(upstreamOwner)}/${encodeURIComponent(upstreamRepo)}/pulls`, {
          token,
          method: 'POST',
          body: {
            title: toCleanString(title) || 'Update annotations',
            head: headAlt,
            base: baseBranch,
            body: prBody || undefined,
            maintainer_can_modify: true
          }
        });
      } else if (existing?.state === 'closed') {
        try {
          pr = await githubRequest(workerOrigin, `/repos/${encodeURIComponent(upstreamOwner)}/${encodeURIComponent(upstreamRepo)}/pulls/${encodeURIComponent(existing.number)}`, {
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
      throw fallbackErr || err;
    }
  }

  return { pr, reused };
}

async function publishFileViaPullRequest({
  workerOrigin,
  token,
  upstreamOwner,
  upstreamRepo,
  baseBranch,
  headOwner,
  headRepo,
  headBranch,
  path,
  title,
  body,
  contentBase64
}) {
  const upstreamSha = await getBranchTipShaOrNull({ workerOrigin, owner: upstreamOwner, repo: upstreamRepo, token, branch: baseBranch });

  let baseSha = upstreamSha;
  if (!baseSha) {
    const headInfo = await getRepoInfo({ workerOrigin, owner: headOwner, repo: headRepo, token });
    const fallback = toCleanString(headInfo?.default_branch || '') || 'main';
    baseSha = await getBranchTipShaOrNull({ workerOrigin, owner: headOwner, repo: headRepo, token, branch: fallback });
  }
  if (!baseSha) throw new Error('Unable to determine base SHA for PR branch');

  await ensureBranchExists({ workerOrigin, owner: headOwner, repo: headRepo, token, branch: headBranch, baseSha });
  await upsertFileOnBranch({
    workerOrigin,
    owner: headOwner,
    repo: headRepo,
    token,
    branch: headBranch,
    path,
    message: title,
    contentBase64
  });

  const { pr, reused } = await openOrReusePullRequest({
    workerOrigin,
    token,
    upstreamOwner,
    upstreamRepo,
    baseBranch,
    headOwner,
    headRepo,
    headBranch,
    title,
    body
  });

  return {
    prUrl: toCleanString(pr?.html_url || '') || null,
    prNumber: pr?.number ?? null,
    reused
  };
}

export class CommunityAnnotationGitHubSync {
  constructor({ datasetId, owner, repo, token = null, branch = null, workerOrigin = null } = {}) {
    this.datasetId = toCleanString(datasetId) || null;
    this.owner = owner;
    this.repo = repo;
    this.token = token;
    this.branch = branch;
    this.workerOrigin = toCleanString(workerOrigin) || getGitHubWorkerOrigin();

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
    let branch = this.branch || repoInfo?.default_branch || 'main';

    // If the branch came from a GitHub "/tree/<ref>/path" paste, it may include extra path segments
    // (and ref names can include slashes). Resolve the actual branch by probing git refs.
    if (branch && branch.includes('/')) {
      try {
        const resolved = await this.resolveBranchFromTreeRefPath(branch);
        if (resolved) branch = resolved;
      } catch {
        // ignore and fall through to normal validation (which will surface a clear error)
      }
    }

    this.branch = branch;

    // Basic structural checks expected by the template.
    // Note: we intentionally avoid listing `annotations/users/` via the Contents API because
    // large directories can fail or be truncated; `pullAllUsers()` uses the git tree API.
    if (this._schemaCheckedRef !== branch) {
      const { json: schema } = await readJsonFile({
        workerOrigin,
        owner: this.owner,
        repo: this.repo,
        token,
        path: 'annotations/schema.json',
        ref: branch
      });
      assertSupportedUserFileSchema(schema, { path: 'annotations/schema.json' });
      this._schemaCheckedRef = branch;
    }

    const { json: config, sha: configSha } = await readJsonFile({
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

    return { repoInfo, branch, config, configSha: configSha || null, datasetId: targetDatasetId, datasetConfig: match };
  }

  async resolveBranchFromTreeRefPath(treeRefPath, { maxSegments = 40 } = {}) {
    const token = this.token;
    if (!token) throw new Error('GitHub sign-in required');

    const raw = toCleanString(treeRefPath);
    if (!raw) return null;

    const parts = raw.split('/').map((s) => toCleanString(s)).filter(Boolean);
    if (!parts.length) return null;

    const cap = Math.max(1, Math.min(parts.length, Math.floor(Number(maxSegments) || 12)));
    const workerOrigin = this.workerOrigin;

    for (let n = cap; n >= 1; n--) {
      const candidate = parts.slice(0, n).join('/');
      try {
        await githubRequest(
          workerOrigin,
          `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/ref/${encodeGitRefPath(`heads/${candidate}`)}`,
          { token }
        );
        return candidate;
      } catch (err) {
        if (err?.status === 404) continue;
        throw err;
      }
    }

    return null;
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

  async updateDatasetFieldsToAnnotate({
    datasetId,
    fieldsToAnnotate,
    annotatableSettings = null,
    closedFields = null,
    commitMessage = null,
    conflictIfRemoteShaNotEqual = null,
    force = false
  } = {}) {
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
        const minAnnotators = Number.isFinite(Number(raw?.minAnnotators))
          ? Math.max(0, Math.min(50, Math.floor(Number(raw.minAnnotators))))
          : 1;
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

    const expectedSha = toCleanString(conflictIfRemoteShaNotEqual) || null;

    const { json: current, sha } = await readJsonFileOrNull({
      workerOrigin: this.workerOrigin,
      owner: this.owner,
      repo: this.repo,
      token,
      path: 'annotations/config.json',
      ref: branch
    });

    if (!force) {
      if (!expectedSha) {
        const err = new Error(
          'Missing baseline version for annotations/config.json.\n' +
          'Pull first to load the latest config, then Publish again.'
        );
        err.code = 'COMMUNITY_ANNOTATION_CONFLICT';
        err.path = 'annotations/config.json';
        err.remoteSha = sha || null;
        err.expectedSha = null;
        throw err;
      }
      if (sha !== expectedSha) {
        const err = new Error(
          'annotations/config.json changed since your last Pull.\n' +
          'Pull first to review/merge the latest settings, then Publish again.'
        );
        err.code = 'COMMUNITY_ANNOTATION_CONFLICT';
        err.path = 'annotations/config.json';
        err.remoteSha = sha || null;
        err.expectedSha = expectedSha;
        throw err;
      }
    }

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
          path: 'annotations/config.json',
          sha: sha || null,
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
      const res = await putContent({
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
      const newSha = toCleanString(res?.content?.sha || res?.sha || '') || null;
      const retSettings = {};
      for (const k of cleanedFields) {
        if (settingsMap[k]) retSettings[k] = settingsMap[k];
      }
      return {
        mode: 'push',
        branch,
        path: 'annotations/config.json',
        sha: newSha,
        datasetId: did,
        fieldsToAnnotate: cleanedFields,
        annotatableSettings: retSettings,
        closedFields: closedFields != null ? cleanClosed(closedFields).filter((k) => cleanedFields.includes(k)).slice(0, 500) : [],
        changed: true
      };
    } catch (err) {
      if (!force && isShaMismatchError(err)) {
        const conflict = new Error(
          'annotations/config.json changed while publishing.\n' +
          'Pull first to review/merge the latest settings, then Publish again.'
        );
        conflict.code = 'COMMUNITY_ANNOTATION_CONFLICT';
        conflict.path = 'annotations/config.json';
        throw conflict;
      }

      if (!(isWriteDeniedError(err) || isProtectedBranchError(err))) throw err;

      const me = await workerAuthRequest(this.workerOrigin, '/auth/user', { token });
      const meLogin = toCleanString(me?.login || '');
      if (!meLogin) throw err;

      const prBranch = toDeterministicPrBranch({ datasetId: did, baseBranch: branch, fileUser: `${meLogin}-config` });
      const prBody = [
        'Automated community annotation config update from Cellucid.',
        '',
        `User: @${meLogin}`,
        'File: `annotations/config.json`'
      ].join('\n');

      const prRes = await publishFileViaPullRequest({
        workerOrigin: this.workerOrigin,
        token,
        upstreamOwner: this.owner,
        upstreamRepo: this.repo,
        baseBranch: branch,
        headOwner: this.owner,
        headRepo: this.repo,
        headBranch: prBranch,
        path: 'annotations/config.json',
        title: msg,
        body: prBody,
        contentBase64
      });

      const retSettings = {};
      for (const k of cleanedFields) {
        if (settingsMap[k]) retSettings[k] = settingsMap[k];
      }

      return {
        mode: 'pr',
        branch,
        path: 'annotations/config.json',
        sha: sha || null,
        datasetId: did,
        fieldsToAnnotate: cleanedFields,
        annotatableSettings: retSettings,
        closedFields: closedFields != null ? cleanClosed(closedFields).filter((k) => cleanedFields.includes(k)).slice(0, 500) : [],
        changed: true,
        prUrl: prRes?.prUrl || null,
        prNumber: prRes?.prNumber ?? null,
        reused: Boolean(prRes?.reused)
      };
    }

    // Unreachable (returns above).
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

      try {
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
        // Treat invalid JSON as a recoverable case so callers can cache the SHA and surface UX.
        const msg = err?.message || String(err);
        if (/invalid json/i.test(String(msg))) {
          return { doc: { __invalid: true, __error: msg }, sha, path, fetched: true };
        }
        throw err;
      }
    } catch (err) {
      if (isNotFoundError(err)) return { doc: null, sha: null, path, fetched: false };
      throw err;
    }
  }

  async pushModerationMerges({ mergesDoc, commitMessage = null, conflictIfRemoteShaNotEqual = null, force = false } = {}) {
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

    const expectedSha = toCleanString(conflictIfRemoteShaNotEqual) || null;

    const { json: current, sha } = await readJsonFileOrNull({
      workerOrigin: this.workerOrigin,
      owner: this.owner,
      repo: this.repo,
      token,
      path: 'annotations/moderation/merges.json',
      ref: branch
    });

    if (!force) {
      // If the remote file exists, require a baseline SHA from the last Pull to avoid overwrites.
      if (!expectedSha && sha) {
        const err = new Error(
          'Missing baseline version for annotations/moderation/merges.json.\n' +
          'Pull first to load the latest merges, then Publish again.'
        );
        err.code = 'COMMUNITY_ANNOTATION_CONFLICT';
        err.path = 'annotations/moderation/merges.json';
        err.remoteSha = sha || null;
        err.expectedSha = null;
        throw err;
      }
      if (expectedSha && sha !== expectedSha) {
        const err = new Error(
          'annotations/moderation/merges.json changed since your last Pull.\n' +
          'Pull first to review the latest merges, then Publish again.'
        );
        err.code = 'COMMUNITY_ANNOTATION_CONFLICT';
        err.path = 'annotations/moderation/merges.json';
        err.remoteSha = sha || null;
        err.expectedSha = expectedSha;
        throw err;
      }
    }

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
      return { mode: 'push', branch, path: 'annotations/moderation/merges.json', sha: newSha, changed: true };
    } catch (err) {
      if (!force && isShaMismatchError(err)) {
        const conflict = new Error(
          'annotations/moderation/merges.json changed while publishing.\n' +
          'Pull first to review the latest merges, then Publish again.'
        );
        conflict.code = 'COMMUNITY_ANNOTATION_CONFLICT';
        conflict.path = 'annotations/moderation/merges.json';
        throw conflict;
      }

      if (!(isWriteDeniedError(err) || isProtectedBranchError(err))) throw err;

      const me = await workerAuthRequest(this.workerOrigin, '/auth/user', { token });
      const meLogin = toCleanString(me?.login || '');
      if (!meLogin) throw err;

      const prBranch = toDeterministicPrBranch({
        datasetId: this.datasetId || 'default',
        baseBranch: branch,
        fileUser: `${meLogin}-merges`
      });
      const prBody = [
        'Automated community annotation moderation merges update from Cellucid.',
        '',
        `User: @${meLogin}`,
        'File: `annotations/moderation/merges.json`'
      ].join('\n');

      const prRes = await publishFileViaPullRequest({
        workerOrigin: this.workerOrigin,
        token,
        upstreamOwner: this.owner,
        upstreamRepo: this.repo,
        baseBranch: branch,
        headOwner: this.owner,
        headRepo: this.repo,
        headBranch: prBranch,
        path: 'annotations/moderation/merges.json',
        title: msg,
        body: prBody,
        contentBase64
      });

      return {
        mode: 'pr',
        branch,
        path: 'annotations/moderation/merges.json',
        sha: sha || null,
        changed: true,
        prUrl: prRes?.prUrl || null,
        prNumber: prRes?.prNumber ?? null,
        reused: Boolean(prRes?.reused)
      };
    }
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

    const tree = await getGitTreeRecursive({ workerOrigin, owner: this.owner, repo: this.repo, token, ref: branch });
    const userBlobs = tree.filter((e) => {
      const path = toCleanString(e?.path || '');
      if (!path) return false;
      return e?.type === 'blob' && /^annotations\/users\/ghid_\d+\.json$/i.test(path);
    });

    /** @type {Record<string, string>} */
    const nextShas = {};
    for (const f of userBlobs) {
      const path = toCleanString(f?.path || '');
      const sha = toCleanString(f?.sha || '');
      if (!path || !sha) continue;
      nextShas[path] = sha;
    }

    const known = (knownShas && typeof knownShas === 'object') ? knownShas : null;
    const needsFetch = (path, sha) => {
      if (!known) return true;
      const prev = toCleanString(known[path] || '');
      return !prev || prev !== sha;
    };

    const allPaths = Object.keys(nextShas).sort((a, b) => a.localeCompare(b));
    const toFetch = allPaths.filter((path) => needsFetch(path, nextShas[path]));

    const concurrency = DEFAULT_USER_PULL_CONCURRENCY;
    const out = (await mapWithConcurrency(toFetch, concurrency, async (path) => {
      const sha = nextShas[path] || null;
      const fileUser = toCleanString(path.split('/').pop() || '').replace(/\.json$/i, '') || null;
      try {
        const json = await getGitBlobJson({ workerOrigin, owner: this.owner, repo: this.repo, token, sha });
        return (json && typeof json === 'object')
          ? { ...json, __path: path, __fileUser: fileUser, __sha: sha || null }
          : { __invalid: true, __path: path, __fileUser: fileUser, __sha: sha || null, __error: 'Invalid JSON shape (expected object)' };
      } catch (err) {
        const msg = err?.message || String(err);
        return { __invalid: true, __path: path, __fileUser: fileUser, __sha: sha || null, __error: msg || 'Failed to load blob' };
      }
    })).filter(Boolean);

    return {
      docs: out,
      shas: nextShas,
      fetchedCount: toFetch.length,
      totalCount: allPaths.length,
      concurrency
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

  async pushMyUserFile({
    userDoc,
    commitMessage = null,
    conflictIfRemoteNewerThan = null,
    conflictIfRemoteShaNotEqual = null,
    force = false
  } = {}) {
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
    let remoteDoc = null;
    try {
      const existing = await getContent({ workerOrigin, owner: this.owner, repo: this.repo, token, path, ref: branch });
      if (existing?.type === 'file' && existing?.sha) {
        sha = existing.sha;
        const decoded = decodeBase64Utf8(existing?.content || '');
        const parsed = decoded ? safeJsonParse(decoded) : null;
        remoteDoc = (parsed && typeof parsed === 'object') ? parsed : null;
        remoteUpdatedAt = toCleanString(remoteDoc?.updatedAt) || null;
      }
    } catch (err) {
      // If not found, we'll create it. Otherwise bubble up.
      if (err?.status !== 404) throw err;
    }

    // Strong conflict detection: GitHub blob sha is the real source-of-truth version.
    // This avoids clock-skew issues with `updatedAt` when the same user publishes from multiple devices.
    const expectedSha = toCleanString(conflictIfRemoteShaNotEqual) || null;
    if (!force) {
      // If the remote file exists, require a baseline SHA from the last Pull to avoid overwrites.
      if (!expectedSha && sha) {
        const err = new Error(
          'Missing baseline version for your remote user file.\n' +
          'Pull first to merge any existing votes/suggestions, then Publish again.'
        );
        err.code = 'COMMUNITY_ANNOTATION_CONFLICT';
        err.remoteUpdatedAt = remoteUpdatedAt;
        err.remoteSha = sha;
        err.expectedSha = null;
        err.path = path;
        throw err;
      }

      if (expectedSha && sha !== expectedSha) {
        const err = new Error(
          'Remote user file changed since your last Pull.\n' +
          'Pull first to merge changes, or force overwrite to publish anyway.'
        );
        err.code = 'COMMUNITY_ANNOTATION_CONFLICT';
        err.remoteUpdatedAt = remoteUpdatedAt;
        err.remoteSha = sha;
        err.expectedSha = expectedSha;
        err.path = path;
        throw err;
      }
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
    // Preserve per-user dataset access metadata across publishes (informational; does not affect annotations).
    if (remoteDoc?.datasets != null || docToWrite.datasets != null) {
      const merged = mergeDatasetAccessMaps(remoteDoc?.datasets, docToWrite.datasets);
      if (Object.keys(merged).length) docToWrite.datasets = merged;
      else delete docToWrite.datasets;
    }
    const content = encodeBase64Utf8(JSON.stringify(docToWrite, null, 2) + '\n');
    const login = toCleanString(userDoc?.login || '') || null;
    const msg = toCleanString(commitMessage) || `Update annotations for @${login || fileUser}`;

    let lastDirectPushError = null;
    if (canPushDirect !== false) {
      try {
        const res = force
          ? await putContentWithRetry({
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
          })
          : await putContent({
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
        if (!force && isShaMismatchError(err)) {
          const conflict = new Error(
            'Remote user file changed while publishing.\n' +
            'Pull first to merge changes, or force overwrite to publish anyway.'
          );
          conflict.code = 'COMMUNITY_ANNOTATION_CONFLICT';
          conflict.remoteUpdatedAt = remoteUpdatedAt;
          conflict.path = path;
          throw conflict;
        }
        if (!(isWriteDeniedError(err) || isProtectedBranchError(err))) throw err;
        lastDirectPushError = err;
      }
    }

    // At this point, direct publishing was either not allowed or was blocked (e.g. protected branch).
    if (canPushDirect !== true && !allowForking) {
      throw new Error(
        'You do not have permission to publish annotations.\n\n' +
        'GitHub reports you cannot push, and this repo disables forking, so Pull Request publishing is not possible.'
      );
    }

    const me = await workerAuthRequest(workerOrigin, '/auth/user', { token });
    const meLogin = toCleanString(me?.login || '');
    if (!meLogin) throw new Error('Unable to determine GitHub user (GET /auth/user)');

    const prBranch = toDeterministicPrBranch({ datasetId: this.datasetId, baseBranch: branch, fileUser });
    const prBody = [
      'Automated community annotation update from Cellucid.',
      '',
      `User: @${meLogin}`,
      `File: \`${path}\``
    ].join('\n');

    // Prefer same-repo PR branches when possible (works even when forking is disabled).
    const shouldTryUpstreamPrFirst =
      canPushDirect === true ||
      !allowForking ||
      isProtectedBranchError(lastDirectPushError);

    if (shouldTryUpstreamPrFirst) {
      try {
        const prRes = await publishFileViaPullRequest({
          workerOrigin,
          token,
          upstreamOwner: this.owner,
          upstreamRepo: this.repo,
          baseBranch: branch,
          headOwner: this.owner,
          headRepo: this.repo,
          headBranch: prBranch,
          path,
          title: msg,
          body: prBody,
          contentBase64: content
        });
        return {
          mode: 'pr',
          path,
          remoteUpdatedAt,
          prUrl: prRes?.prUrl || null,
          prNumber: prRes?.prNumber ?? null,
          reused: Boolean(prRes?.reused)
        };
      } catch (err) {
        if (!allowForking) throw err;
      }
    }

    // Fork + PR flow (no direct write access, or upstream branch PR failed).
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
      const status = err?.status;
      if (status === 401 || status === 403) {
        throw new Error(
          'Unable to create or access a fork for Pull Request publishing. ' +
          'Make sure the GitHub App is installed for your account, and that you have permission to fork this repository.'
        );
      }
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
        'Fork not ready. Install the GitHub App on your personal account (ideally "All repositories"), then try again.'
      );
    }

    const prRes = await publishFileViaPullRequest({
      workerOrigin,
      token,
      upstreamOwner: this.owner,
      upstreamRepo: this.repo,
      baseBranch: branch,
      headOwner: forkOwner,
      headRepo: forkRepo,
      headBranch: prBranch,
      path,
      title: msg,
      body: prBody,
      contentBase64: content
    });

    return {
      mode: 'pr',
      path,
      remoteUpdatedAt,
      prUrl: prRes?.prUrl || null,
      prNumber: prRes?.prNumber ?? null,
      reused: Boolean(prRes?.reused)
    };
  }
}

export function getGitHubSyncForDataset({ datasetId, username = 'local', tokenOverride = null } = {}) {
  const repo = getAnnotationRepoForDataset(datasetId, username);
  if (!repo) return null;
  const parsed = parseOwnerRepo(repo);
  if (!parsed) return null;
  const meta = getAnnotationRepoMetaForDataset(datasetId, username);
  const branchMode = meta?.branchMode === 'explicit' ? 'explicit' : 'default';
  const token = tokenOverride || getGitHubAuthSession().getToken() || null;
  return new CommunityAnnotationGitHubSync({
    datasetId,
    owner: parsed.owner,
    repo: parsed.repo,
    token,
    branch: branchMode === 'explicit' ? (parsed.ref || null) : null,
    workerOrigin: getGitHubWorkerOrigin()
  });
}

export function setDatasetAnnotationRepoFromUrlParam({ datasetId, urlParamValue, username = 'local' }) {
  const parsed = parseOwnerRepo(urlParamValue);
  if (!parsed) return false;
  const ok = setAnnotationRepoForDataset(datasetId, parsed.ownerRepoRef, username);
  if (!ok) return false;
  setAnnotationRepoMetaForDataset(datasetId, username, { branchMode: parsed.ref ? 'explicit' : 'default' });
  return true;
}

export async function setDatasetAnnotationRepoFromUrlParamAsync({ datasetId, urlParamValue, username = 'local', tokenOverride = null } = {}) {
  const parsed = parseOwnerRepo(urlParamValue);
  if (!parsed) return false;

  // Support GitHub tree URLs where the branch may contain slashes by resolving the
  // longest matching `refs/heads/...` prefix via the API.
  if (parsed.treeRefPath) {
    const token = tokenOverride || getGitHubAuthSession().getToken() || null;
    if (!token) return false;
    const sync = new CommunityAnnotationGitHubSync({
      datasetId,
      owner: parsed.owner,
      repo: parsed.repo,
      token,
      branch: null,
      workerOrigin: getGitHubWorkerOrigin()
    });
    const resolved = await sync.resolveBranchFromTreeRefPath(parsed.treeRefPath).catch(() => null);
    if (!resolved) return false;
    const ok = setAnnotationRepoForDataset(datasetId, `${parsed.ownerRepo}@${resolved}`, username);
    if (!ok) return false;
    setAnnotationRepoMetaForDataset(datasetId, username, { branchMode: 'explicit' });
    return true;
  }

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
    const ok = setAnnotationRepoForDataset(datasetId, `${parsed.ownerRepo}@${head}`, username);
    if (!ok) return false;
    setAnnotationRepoMetaForDataset(datasetId, username, { branchMode: 'default' });
    return true;
  }

  const ok = setAnnotationRepoForDataset(datasetId, parsed.ownerRepoRef, username);
  if (!ok) return false;
  setAnnotationRepoMetaForDataset(datasetId, username, { branchMode: 'explicit' });
  return true;
}
