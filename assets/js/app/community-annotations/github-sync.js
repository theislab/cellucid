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
  setAnnotationRepoForDataset
} from './repo-store.js';
import {
  assertConfigDocument,
  assertMergesDocument,
  assertSchemaIdentity,
  assertUserDocument,
  parseExactJson,
} from './wire-contract.js';
import {
  isCanonicalGitHubAccount,
  isCanonicalGitHubBranch,
  isCanonicalGitHubRepositoryFullName,
  isCanonicalGitHubRepositoryName,
  parseCanonicalGitHubRepositoryReference,
} from './github-reference.js';

const GITHUB_DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_USER_PULL_CONCURRENCY = 8;
const MAX_TREE_ITEMS = 100_000;
const GITHUB_SHA = /^[0-9a-f]{40}$/;
const PUBLICATION_MODES = new Set(['direct', 'fork-pull-request']);

function assertExactNonblankString(value, label, { max = 2048 } = {}) {
  if (
    typeof value !== 'string' ||
    !value ||
    /^\s|\s$/.test(value) ||
    Array.from(value).length > max
  ) {
    throw new Error(`${label} must be an exact nonblank string`);
  }
  return value;
}

function assertExactObjectKeys(value, fields, label) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    throw new Error(`${label} must be a JSON object`);
  }
  const keys = Object.keys(value);
  if (
    keys.length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field))
  ) {
    throw new Error(`${label} must contain exactly ${fields.join(', ')}`);
  }
  return value;
}

function assertExactHttpOrigin(value, label) {
  const origin = assertExactNonblankString(value, label);
  let parsed;
  try {
    parsed = new URL(origin);
  } catch (cause) {
    const error = new Error(`${label} must be an exact HTTP(S) origin`);
    error.cause = cause;
    throw error;
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username ||
    parsed.password ||
    origin !== parsed.origin
  ) {
    throw new Error(`${label} must be an exact HTTP(S) origin`);
  }
  return origin;
}

function assertGitHubBranch(value, label = 'GitHub branch') {
  const branch = assertExactNonblankString(value, label, { max: 1024 });
  if (!isCanonicalGitHubBranch(branch)) {
    throw new Error(`${label} is not a canonical GitHub branch`);
  }
  return branch;
}

function assertGitHubSha(value, label) {
  const sha = assertExactNonblankString(value, label, { max: 40 });
  if (!GITHUB_SHA.test(sha)) {
    throw new Error(`${label} must be a lowercase 40-character Git SHA`);
  }
  return sha;
}

function assertOptionalToken(value) {
  if (value === null) return null;
  return assertExactNonblankString(value, 'GitHub token', { max: 4096 });
}

function assertTimeoutMs(timeoutMs) {
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 0
  ) {
    throw new Error('GitHub request timeoutMs must be a nonnegative safe integer');
  }
  return timeoutMs;
}

function assertPublicationMode(value) {
  if (!PUBLICATION_MODES.has(value)) {
    throw new Error(
      'publicationMode must equal "direct" or "fork-pull-request"'
    );
  }
  return value;
}

function assertGitHubLogin(value, label = 'GitHub login') {
  const login = assertExactNonblankString(value, label, { max: 64 });
  if (!isCanonicalGitHubAccount(login)) {
    throw new Error(`${label} is not a canonical GitHub account`);
  }
  return login;
}

function assertGitHubRepositoryFullName(value, label) {
  const fullName = assertExactNonblankString(value, label, { max: 256 });
  if (!isCanonicalGitHubRepositoryFullName(fullName)) {
    throw new Error(`${label} must equal an exact owner/repository name`);
  }
  return fullName;
}

function assertRepositoryPublicationInfo(repoInfo) {
  assertExactObjectKeys(
    repoInfo,
    [
      'full_name',
      'default_branch',
      'private',
      'allow_forking',
      'permissions',
    ],
    'GitHub repository metadata'
  );
  assertGitHubRepositoryFullName(
    repoInfo.full_name,
    'GitHub repository full_name'
  );
  assertGitHubBranch(
    repoInfo.default_branch,
    'GitHub repository default_branch'
  );
  if (typeof repoInfo.private !== 'boolean') {
    throw new Error('GitHub repository private must be boolean');
  }
  if (typeof repoInfo.allow_forking !== 'boolean') {
    throw new Error('GitHub repository allow_forking must be boolean');
  }
  const permissions = repoInfo.permissions;
  assertExactObjectKeys(
    permissions,
    ['pull', 'triage', 'push', 'maintain', 'admin'],
    'GitHub repository permissions'
  );
  for (const key of ['pull', 'triage', 'push', 'maintain', 'admin']) {
    if (typeof permissions[key] !== 'boolean') {
      throw new Error(`GitHub repository permissions.${key} must be boolean`);
    }
  }
  return {
    private: repoInfo.private,
    allowForking: repoInfo.allow_forking,
    canDirectPush:
      permissions.push || permissions.maintain || permissions.admin,
    canManage: permissions.maintain || permissions.admin,
  };
}

export function selectAnnotationPublicationMode(repoInfo) {
  const capability = assertRepositoryPublicationInfo(repoInfo);
  if (capability.canDirectPush) return 'direct';
  if (capability.allowForking) return 'fork-pull-request';
  return null;
}

function assertAuthUserResponse(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, 'id') ||
    !Object.hasOwn(value, 'login')
  ) {
    throw new Error('GitHub auth user response must contain exactly id and login');
  }
  if (!Number.isSafeInteger(value.id) || value.id < 1) {
    throw new Error('GitHub auth user id must be a positive safe integer');
  }
  return {
    id: value.id,
    login: assertGitHubLogin(value.login, 'GitHub auth user login'),
  };
}

function isAbortError(err) {
  return err?.name === 'AbortError';
}

function parseHttpJson(text, label) {
  if (typeof text !== 'string' || text === '') {
    throw new Error(`${label} returned an empty response body`);
  }
  return parseExactJson(text, { path: label });
}

function assertWorkerErrorDocument(value, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, 'error')
  ) {
    throw new Error(`${label} must contain exactly error`);
  }
  return assertExactNonblankString(value.error, `${label} error`, {
    max: 4096,
  });
}

function stableStringifyJson(value) {
  const ancestors = new WeakSet();
  const walk = (v) => {
    if (v === null) return null;
    if (typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v !== 'object') {
      throw new Error('Cannot compare a non-JSON value');
    }
    if (ancestors.has(v)) throw new Error('Cannot compare cyclic JSON');
    ancestors.add(v);
    if (Array.isArray(v)) {
      const array = v.map(walk);
      ancestors.delete(v);
      return array;
    }
    const out = {};
    for (const k of Object.keys(v).sort()) {
      out[k] = walk(v[k]);
    }
    ancestors.delete(v);
    return out;
  };
  return JSON.stringify(walk(value));
}

function encodeBase64Utf8(text) {
  if (typeof text !== 'string') throw new Error('Base64 input must be a string');
  if (typeof TextEncoder === 'undefined') {
    throw new Error('TextEncoder is required for GitHub annotation sync');
  }
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function decodeBase64Utf8(b64) {
  if (typeof b64 !== 'string') {
    throw new Error('GitHub annotation content must be a base64 string');
  }
  const base64 = b64.replaceAll('\r\n', '').replaceAll('\n', '');
  if (
    !base64 ||
    base64.includes('\r') ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      base64
    )
  ) {
    throw new Error(
      'GitHub annotation content must be valid base64 with optional line folding'
    );
  }
  const bin = atob(base64);
  if (typeof TextDecoder === 'undefined') {
    throw new Error('TextDecoder is required for GitHub annotation sync');
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // Preserve a UTF-8 BOM so the exact JSON parser rejects it, matching the
  // repository validator instead of silently discarding it.
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

async function getGitTreeRecursive({ workerOrigin, owner, repo, token = null, ref }) {
  const treeish = assertGitHubBranch(ref, 'Git tree ref');
  const res = await githubRequest(
    workerOrigin,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(treeish)}`,
    { token, query: { recursive: 1 } }
  );
  const list = Array.isArray(res?.tree) ? res.tree : null;
  if (!list) throw new Error('Expected git tree listing');
  if (res?.truncated === true) {
    throw new Error('GitHub returned a truncated git tree; annotation Pull is incomplete');
  }
  if (list.length > MAX_TREE_ITEMS) {
    throw new Error(`Git tree contains more than ${MAX_TREE_ITEMS} entries`);
  }
  return list;
}

async function getGitBlobJson({
  workerOrigin,
  owner,
  repo,
  token = null,
  sha,
  path,
}) {
  const s = assertGitHubSha(sha, 'Git blob SHA');
  const res = await githubRequest(
    workerOrigin,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(s)}`,
    { token }
  );
  if (res?.encoding !== 'base64') {
    throw new Error(`GitHub blob ${JSON.stringify(path)} must use base64 encoding`);
  }
  if (typeof res?.content !== 'string' || !res.content.trim()) {
    throw new Error(`GitHub blob ${JSON.stringify(path)} has empty content`);
  }
  const decoded = decodeBase64Utf8(res.content);
  return parseExactJson(decoded, { path });
}

async function mapWithConcurrency(items, concurrency, fn) {
  if (!Array.isArray(items)) {
    throw new Error('Concurrent map items must be an array');
  }
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1
  ) {
    throw new Error('Concurrent map limit must be a positive safe integer');
  }
  if (typeof fn !== 'function') {
    throw new Error('Concurrent map callback must be a function');
  }
  const list = items;
  const limit = concurrency;
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
  return parseCanonicalGitHubRepositoryReference(input);
}

function sanitizeUserKeyForPath(userKey) {
  if (typeof userKey !== 'string') return null;
  const m = userKey.match(/^ghid_([1-9][0-9]*)$/);
  if (!m) return null;
  const id = Number(m[1]);
  if (!Number.isSafeInteger(id) || id < 1) return null;
  return userKey;
}

function fnv1aHash32(input) {
  const str = assertExactNonblankString(input, 'Hash input', { max: 8192 });
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function encodeGitRefPath(ref) {
  const raw = assertGitHubBranch(ref, 'GitHub ref path');
  return raw.split('/').map((p) => encodeURIComponent(p)).join('/');
}

function toDeterministicPrBranch({ datasetId, baseBranch, fileUser }) {
  const didRaw = assertExactNonblankString(
    datasetId,
    'Pull-request dataset id',
    { max: 256 }
  );
  const baseRaw = assertGitHubBranch(baseBranch, 'Pull-request base branch');
  const userRaw = sanitizeUserKeyForPath(fileUser);
  if (userRaw === null) {
    throw new Error('Pull-request file user must be an exact ghid identity');
  }
  const fingerprint = fnv1aHash32(
    `${didRaw}\u0000${baseRaw}\u0000${userRaw}`
  ).toString(36);
  return `cellucid-annotations/${userRaw}/${fingerprint}`;
}

function toWorkerApiUrl(workerOrigin, githubPath) {
  const origin = assertExactHttpOrigin(workerOrigin, 'GitHub worker origin');
  const p = assertExactNonblankString(githubPath, 'GitHub API path');
  if (!p.startsWith('/')) throw new Error('GitHub API path must start with "/"');
  return new URL(`${origin}/api${p}`);
}

function toWorkerAuthUrl(workerOrigin, workerPath) {
  const origin = assertExactHttpOrigin(workerOrigin, 'GitHub worker origin');
  const p = assertExactNonblankString(workerPath, 'GitHub worker path');
  if (!p.startsWith('/')) throw new Error('Worker path must start with "/"');
  return new URL(`${origin}${p}`);
}

async function githubRequest(workerOrigin, path, { token = null, method = 'GET', query = null, body = null, timeoutMs = GITHUB_DEFAULT_TIMEOUT_MS } = {}) {
  const url = toWorkerApiUrl(workerOrigin, path);
  if (
    query !== null &&
    (
      typeof query !== 'object' ||
      Array.isArray(query)
    )
  ) {
    throw new Error('GitHub query must be a JSON object or null');
  }
  if (query !== null) {
    for (const [k, v] of Object.entries(query)) {
      const key = assertExactNonblankString(k, 'GitHub query key', {
        max: 128,
      });
      let encodedValue;
      if (typeof v === 'string') {
        encodedValue = assertExactNonblankString(
          v,
          `GitHub query ${key}`,
          { max: 2048 }
        );
      } else if (Number.isSafeInteger(v) && v >= 0) {
        encodedValue = `${v}`;
      } else {
        throw new Error(
          `GitHub query ${key} must be an exact string or nonnegative safe integer`
        );
      }
      url.searchParams.set(key, encodedValue);
    }
  }
  if (method !== 'GET' && method !== 'POST' && method !== 'PUT') {
    throw new Error('GitHub request method must equal GET, POST, or PUT');
  }

  const headers = {
    Accept: 'application/vnd.github+json',
  };
  const exactToken = assertOptionalToken(token);
  if (exactToken !== null) headers.Authorization = `Bearer ${exactToken}`;
  if (body != null) headers['Content-Type'] = 'application/json';

  const ms = assertTimeoutMs(timeoutMs);
  if (typeof AbortController === 'undefined') {
    throw new Error('AbortController is required for GitHub annotation requests');
  }
  const controller = new AbortController();

  /** @type {ReturnType<typeof setTimeout> | null} */
  let timeout = null;
  if (ms > 0) {
    timeout = setTimeout(() => {
      controller.abort();
    }, ms);
  }

  try {
    const res = await fetch(url.toString(), {
      method,
      headers,
      body: body !== null ? stableStringifyJson(body) : undefined,
      signal: controller.signal
    });

    const text = await res.text();
    let responseJson;
    try {
      responseJson = parseHttpJson(
        text,
        `GitHub ${method} ${path} response`
      );
    } catch (cause) {
      const error = new Error(
        `GitHub ${method} ${path} returned invalid JSON: ${cause?.message || cause}`
      );
      error.status = res.status;
      error.github = { path, method };
      error.cause = cause;
      throw error;
    }

    if (!res.ok) {
      const msg = assertWorkerErrorDocument(
        responseJson,
        `GitHub ${method} ${path} error response`
      );
      const err = new Error(msg);
      // attach minimal context (no token)
      err.status = res.status;
      err.github = { path, method };
      throw err;
    }

    return responseJson;
  } catch (err) {
    if (isAbortError(err)) {
      const msg = ms > 0 ? `GitHub request timed out after ${Math.max(1, Math.round(ms / 1000))}s` : 'GitHub request aborted';
      const e = new Error(msg);
      e.code = 'TIMEOUT';
      e.github = { path, method };
      throw e;
    }
    if (err && typeof err === 'object' && !err.github) err.github = { path, method };
    throw err;
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
}

async function workerAuthRequest(workerOrigin, path, { token = null, method = 'GET', body = null, timeoutMs = GITHUB_DEFAULT_TIMEOUT_MS } = {}) {
  const url = toWorkerAuthUrl(workerOrigin, path);
  const headers = {};
  const exactToken = assertOptionalToken(token);
  if (exactToken !== null) headers.Authorization = `Bearer ${exactToken}`;
  if (body != null) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && method !== 'POST') {
    throw new Error('GitHub worker request method must equal GET or POST');
  }

  const ms = assertTimeoutMs(timeoutMs);
  if (typeof AbortController === 'undefined') {
    throw new Error('AbortController is required for GitHub worker requests');
  }
  const controller = new AbortController();

  /** @type {ReturnType<typeof setTimeout> | null} */
  let timeout = null;
  if (ms > 0) {
    timeout = setTimeout(() => {
      controller.abort();
    }, ms);
  }

  try {
    const res = await fetch(url.toString(), {
      method,
      headers,
      body: body !== null ? stableStringifyJson(body) : undefined,
      signal: controller.signal
    });

    const text = await res.text();
    let responseJson;
    try {
      responseJson = parseHttpJson(
        text,
        `GitHub worker ${method} ${path} response`
      );
    } catch (cause) {
      const error = new Error(
        `GitHub worker ${method} ${path} returned invalid JSON: ${cause?.message || cause}`
      );
      error.status = res.status;
      error.worker = { path, method };
      error.cause = cause;
      throw error;
    }
    if (!res.ok) {
      const msg = assertWorkerErrorDocument(
        responseJson,
        `GitHub worker ${method} ${path} error response`
      );
      const err = new Error(msg);
      err.status = res.status;
      err.worker = { path, method };
      throw err;
    }
    return responseJson;
  } catch (err) {
    if (isAbortError(err)) {
      const msg = ms > 0 ? `Auth request timed out after ${Math.max(1, Math.round(ms / 1000))}s` : 'Auth request aborted';
      const e = new Error(msg);
      e.code = 'TIMEOUT';
      e.worker = { path, method };
      throw e;
    }
    if (err && typeof err === 'object' && !err.worker) err.worker = { path, method };
    throw err;
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
}

async function getRepoInfo({ workerOrigin, owner, repo, token = null }) {
  return githubRequest(workerOrigin, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { token });
}

async function getContent({ workerOrigin, owner, repo, token = null, path, ref = null }) {
  const p = assertExactNonblankString(path, 'GitHub content path');
  if (p.startsWith('/') || p.split('/').some((segment) => !segment)) {
    throw new Error('GitHub content path must be a canonical relative path');
  }
  const query =
    ref === null ? null : { ref: assertGitHubBranch(ref, 'GitHub content ref') };
  return githubRequest(
    workerOrigin,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${p.split('/').map(encodeURIComponent).join('/')}`,
    { token, query }
  );
}

async function putContent({ workerOrigin, owner, repo, token, path, branch, message, contentBase64, sha = null }) {
  const exactToken = assertExactNonblankString(
    token,
    'GitHub token',
    { max: 4096 }
  );
  const p = assertExactNonblankString(path, 'GitHub content path');
  if (p.startsWith('/') || p.split('/').some((segment) => !segment)) {
    throw new Error('GitHub content path must be a canonical relative path');
  }
  const exactMessage = assertExactNonblankString(
    message,
    'GitHub commit message',
    { max: 256 }
  );
  if (
    typeof contentBase64 !== 'string' ||
    !contentBase64 ||
    /^\s|\s$/.test(contentBase64)
  ) {
    throw new Error('GitHub base64 content must be an exact nonblank string');
  }
  const exactContent = contentBase64;
  const payload = {
    message: exactMessage,
    content: exactContent,
    branch: assertGitHubBranch(branch),
  };
  if (sha !== null) payload.sha = assertGitHubSha(sha, 'Existing content SHA');
  return githubRequest(
    workerOrigin,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${p.split('/').map(encodeURIComponent).join('/')}`,
    { token: exactToken, method: 'PUT', body: payload }
  );
}

function isContentConflictError(error) {
  return error?.status === 409;
}

function decodeJsonContentFile(content, path) {
  if (!content || content.type !== 'file') {
    throw new Error(`Expected file at ${path}`);
  }
  if (content.encoding !== 'base64') {
    throw new Error(`GitHub file ${JSON.stringify(path)} must use base64 encoding`);
  }
  if (
      typeof content.sha !== 'string' ||
      !content.sha ||
      !GITHUB_SHA.test(content.sha)
    ) {
    throw new Error(`GitHub file ${JSON.stringify(path)} is missing an exact SHA`);
  }
  const decoded = decodeBase64Utf8(content.content);
  return {
    json: parseExactJson(decoded, { path }),
    sha: content.sha,
  };
}

async function readJsonFile({ workerOrigin, owner, repo, token = null, path, ref = null }) {
  const content = await getContent({ workerOrigin, owner, repo, token, path, ref });
  return decodeJsonContentFile(content, path);
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

function assertForkRecord(value, index, upstreamFullName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`GitHub fork ${index} must be an object`);
  }
  const fullName = assertGitHubRepositoryFullName(
    value.full_name,
    `GitHub fork ${index} full_name`
  );
  if (!value.owner || typeof value.owner !== 'object' || Array.isArray(value.owner)) {
    throw new Error(`GitHub fork ${index} owner must be an object`);
  }
  const owner = assertGitHubLogin(
    value.owner.login,
    `GitHub fork ${index} owner login`
  );
  const name = assertExactNonblankString(
    value.name,
    `GitHub fork ${index} name`,
    { max: 100 }
  );
  if (!isCanonicalGitHubRepositoryName(name)) {
    throw new Error(`GitHub fork ${index} name is not canonical`);
  }
  if (fullName.toLowerCase() !== `${owner}/${name}`.toLowerCase()) {
    throw new Error(`GitHub fork ${index} identity fields disagree`);
  }
  if (
    value.parent !== undefined &&
    (
      !value.parent ||
      typeof value.parent !== 'object' ||
      Array.isArray(value.parent) ||
      assertGitHubRepositoryFullName(
        value.parent.full_name,
        `GitHub fork ${index} parent full_name`
      ).toLowerCase() !== upstreamFullName.toLowerCase()
    )
  ) {
    throw new Error(`GitHub fork ${index} has a different parent repository`);
  }
  return { owner, name, fullName };
}

async function selectOrCreateForkRepo({
  workerOrigin,
  upstreamOwner,
  upstreamRepo,
  token,
  forkOwner,
}) {
  const upstreamFullName = `${upstreamOwner}/${upstreamRepo}`;
  const exactForkOwner = assertGitHubLogin(forkOwner, 'Fork owner');
  const matching = [];
  const seen = new Set();
  for (let page = 1; page <= 10_000; page += 1) {
    const document = await githubRequest(
      workerOrigin,
      `/repos/${encodeURIComponent(upstreamOwner)}/${encodeURIComponent(upstreamRepo)}/forks`,
      { token, query: { per_page: 100, page } }
    );
    if (!Array.isArray(document)) {
      throw new Error('GitHub forks response must be an array');
    }
    if (document.length > 100) {
      throw new Error('GitHub forks response page exceeds 100 entries');
    }
    document.forEach((raw, index) => {
      const fork = assertForkRecord(
        raw,
        (page - 1) * 100 + index,
        upstreamFullName
      );
      const key = fork.fullName.toLowerCase();
      if (seen.has(key)) {
        throw new Error(`GitHub forks response repeats ${fork.fullName}`);
      }
      seen.add(key);
      if (fork.owner.toLowerCase() === exactForkOwner.toLowerCase()) {
        matching.push(fork);
      }
    });
    if (document.length < 100) break;
    if (page === 10_000) {
      throw new Error('GitHub forks response exceeds 1,000,000 entries');
    }
  }
  if (matching.length > 1) {
    throw new Error(
      `GitHub returned multiple forks owned by ${exactForkOwner}`
    );
  }
  if (matching.length === 1) return matching[0].name;

  const created = await githubRequest(
    workerOrigin,
    `/repos/${encodeURIComponent(upstreamOwner)}/${encodeURIComponent(upstreamRepo)}/forks`,
    { token, method: 'POST', body: {} }
  );
  const fork = assertForkRecord(created, 'created', upstreamFullName);
  if (fork.owner.toLowerCase() !== exactForkOwner.toLowerCase()) {
    throw new Error(
      `GitHub created the fork for ${fork.owner}, expected ${exactForkOwner}`
    );
  }
  return fork.name;
}

function requireBranchTipSha(document, label) {
  if (
    !document ||
    typeof document !== 'object' ||
    Array.isArray(document) ||
    !document.object ||
    typeof document.object !== 'object' ||
    Array.isArray(document.object)
  ) {
    throw new Error(`${label} must contain an object SHA`);
  }
  return assertGitHubSha(document.object.sha, `${label} object SHA`);
}

async function getBranchTipSha({ workerOrigin, owner, repo, token, branch }) {
  const exactBranch = assertGitHubBranch(branch);
  const ref = await githubRequest(
    workerOrigin,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeGitRefPath(exactBranch)}`,
    { token }
  );
  return requireBranchTipSha(ref, 'GitHub branch response');
}

async function ensureBranchExists({ workerOrigin, owner, repo, token, branch, baseSha }) {
  const b = assertGitHubBranch(branch, 'Pull Request branch');
  const sha = assertGitHubSha(baseSha, 'Pull Request base SHA');
  try {
    const existing = await githubRequest(
      workerOrigin,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeGitRefPath(b)}`,
      { token }
    );
    requireBranchTipSha(existing, 'Existing Pull Request branch response');
    return;
  } catch (err) {
    if (err?.status !== 404) throw err;
  }
  await githubRequest(
    workerOrigin,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`,
    {
      token,
      method: 'POST',
      body: { ref: `refs/heads/${b}`, sha }
    }
  );
}

async function upsertFileOnBranch({ workerOrigin, owner, repo, token, branch, path, message, contentBase64 }) {
  const b = assertGitHubBranch(branch, 'Pull Request branch');
  const p = assertExactNonblankString(path, 'Pull Request file path');

  let sha = null;
  try {
    const existing = await getContent({ workerOrigin, owner, repo, token, path: p, ref: b });
    if (!existing || existing.type !== 'file') {
      throw new Error(`Expected file at ${p}`);
    }
    sha = assertGitHubSha(existing.sha, `Existing ${p} SHA`);
  } catch (err) {
    if (err?.status !== 404) throw err;
  }

  await putContent({
    workerOrigin,
    owner,
    repo,
    token,
    path: p,
    branch: b,
    message,
    contentBase64,
    sha,
  });
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
  const exactHeadOwner = assertGitHubLogin(headOwner, 'Pull Request head owner');
  const exactHeadBranch = assertGitHubBranch(
    headBranch,
    'Pull Request head branch'
  );
  const exactBaseBranch = assertGitHubBranch(
    baseBranch,
    'Pull Request base branch'
  );
  const exactTitle = assertExactNonblankString(
    title,
    'Pull Request title',
    { max: 256 }
  );
  const exactBody = assertExactNonblankString(
    body,
    'Pull Request body',
    { max: 65_536 }
  );
  const headQuery = `${exactHeadOwner}:${exactHeadBranch}`;

  const existing = await githubRequest(
    workerOrigin,
    `/repos/${encodeURIComponent(upstreamOwner)}/${encodeURIComponent(upstreamRepo)}/pulls`,
    {
      token,
      query: {
        state: 'open',
        head: headQuery,
        base: exactBaseBranch,
        per_page: 100,
      }
    }
  );
  if (!Array.isArray(existing)) {
    throw new Error('GitHub Pull Request lookup must return an array');
  }
  if (existing.length > 1) {
    throw new Error('GitHub returned multiple open Pull Requests for one head');
  }
  if (existing.length === 1) {
    return { pr: existing[0], reused: true };
  }

  const pr = await githubRequest(
    workerOrigin,
    `/repos/${encodeURIComponent(upstreamOwner)}/${encodeURIComponent(upstreamRepo)}/pulls`,
    {
      token,
      method: 'POST',
      body: {
        title: exactTitle,
        head: headQuery,
        base: exactBaseBranch,
        body: exactBody,
        maintainer_can_modify: true
      }
    }
  );
  return { pr, reused: false };
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
  const upstreamSha = await getBranchTipSha({
    workerOrigin,
    owner: upstreamOwner,
    repo: upstreamRepo,
    token,
    branch: baseBranch,
  });

  await ensureBranchExists({
    workerOrigin,
    owner: headOwner,
    repo: headRepo,
    token,
    branch: headBranch,
    baseSha: upstreamSha,
  });
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

  if (
    !pr ||
    typeof pr !== 'object' ||
    Array.isArray(pr) ||
    !Number.isSafeInteger(pr.number) ||
    pr.number < 1
  ) {
    throw new Error('GitHub Pull Request response has an invalid number');
  }
  const prUrl = assertExactNonblankString(
    pr.html_url,
    'GitHub Pull Request html_url',
    { max: 2048 }
  );
  let parsedPrUrl;
  try {
    parsedPrUrl = new URL(prUrl);
  } catch (cause) {
    const error = new Error('GitHub Pull Request html_url must be an HTTPS URL');
    error.cause = cause;
    throw error;
  }
  if (parsedPrUrl.protocol !== 'https:' || parsedPrUrl.toString() !== prUrl) {
    throw new Error('GitHub Pull Request html_url must be an exact HTTPS URL');
  }
  return { prUrl, prNumber: pr.number, reused };
}

async function publishAnnotationFile({
  publicationMode,
  repoInfo,
  workerOrigin,
  token,
  upstreamOwner,
  upstreamRepo,
  baseBranch,
  datasetId,
  fileUser,
  path,
  title,
  body,
  contentBase64,
  sourceSha,
}) {
  const mode = assertPublicationMode(publicationMode);
  const capability = assertRepositoryPublicationInfo(repoInfo);
  if (mode === 'direct') {
    if (!capability.canDirectPush) {
      throw new Error(
        'Direct annotation publication requires GitHub write permission'
      );
    }
    const response = await putContent({
      workerOrigin,
      owner: upstreamOwner,
      repo: upstreamRepo,
      token,
      path,
      branch: baseBranch,
      message: title,
      contentBase64,
      sha: sourceSha,
    });
    const rawSha = response?.content?.sha;
    return {
      mode,
      sha: assertGitHubSha(rawSha, 'Published GitHub content SHA'),
    };
  }

  if (!capability.allowForking) {
    throw new Error(
      'Fork Pull Request publication is disabled for this repository'
    );
  }
  const authUser = assertAuthUserResponse(
    await workerAuthRequest(workerOrigin, '/auth/user', { token })
  );
  const expectedFileUser = `ghid_${authUser.id}`;
  if (fileUser !== null && fileUser !== expectedFileUser) {
    throw new Error(
      `Pull Request file identity must equal authenticated user ${expectedFileUser}`
    );
  }
  const forkRepo = await selectOrCreateForkRepo({
    workerOrigin,
    upstreamOwner,
    upstreamRepo,
    token,
    forkOwner: authUser.login,
  });
  const headBranch = toDeterministicPrBranch({
    datasetId,
    baseBranch,
    fileUser: expectedFileUser,
  });
  const result = await publishFileViaPullRequest({
    workerOrigin,
    token,
    upstreamOwner,
    upstreamRepo,
    baseBranch,
    headOwner: authUser.login,
    headRepo: forkRepo,
    headBranch,
    path,
    title,
    body,
    contentBase64,
  });
  return { mode, ...result };
}

export class CommunityAnnotationGitHubSync {
  constructor({ datasetId, owner, repo, token = null, branch = null, workerOrigin = null } = {}) {
    this.datasetId = assertExactNonblankString(
      datasetId,
      'Annotation sync datasetId',
      { max: 256 }
    );
    if (
      typeof owner !== 'string' ||
      typeof repo !== 'string' ||
      !isCanonicalGitHubAccount(owner) ||
      !isCanonicalGitHubRepositoryName(repo)
    ) {
      throw new Error('Annotation sync owner and repo must be exact GitHub names');
    }
    this.owner = owner;
    this.repo = repo;
    this.token = assertOptionalToken(token);
    this.branch = branch === null ? null : assertGitHubBranch(branch);
    const configuredOrigin = workerOrigin === null
      ? getGitHubWorkerOrigin()
      : workerOrigin;
    this.workerOrigin = assertExactHttpOrigin(
      configuredOrigin,
      'GitHub worker origin'
    );

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
    assertRepositoryPublicationInfo(repoInfo);
    this._repoInfo = repoInfo;
    const branch = this.branch === null
      ? assertGitHubBranch(
        repoInfo.default_branch,
        'GitHub repository default_branch'
      )
      : this.branch;

    this.branch = branch;

    // Validate the complete, exact contract published by the repository.
    if (this._schemaCheckedRef !== branch) {
      const schemaSpecs = [
        ['user', 'annotations/schema.json'],
        ['config', 'annotations/config.schema.json'],
        ['merges', 'annotations/moderation/merges.schema.json'],
      ];
      const schemas = await Promise.all(
        schemaSpecs.map(async ([kind, path]) => {
          const { json } = await readJsonFile({
            workerOrigin,
            owner: this.owner,
            repo: this.repo,
            token,
            path,
            ref: branch,
          });
          return { kind, path, json };
        })
      );
      schemas.forEach(({ kind, path, json }) => {
        assertSchemaIdentity(json, kind, { path });
      });
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
    assertConfigDocument(config, { path: 'annotations/config.json' });

    const targetDatasetId = datasetId === undefined
      ? this.datasetId
      : assertExactNonblankString(
        datasetId,
        'Annotation config datasetId',
        { max: 256 }
      );
    const supported = config.supportedDatasets;
    const match =
      supported.find((entry) => entry.datasetId === targetDatasetId) ?? null;

    return { repoInfo, branch, config, configSha: configSha || null, datasetId: targetDatasetId, datasetConfig: match };
  }

  async readRepoConfigJson() {
    const token = this.token;
    if (!token) throw new Error('GitHub sign-in required');
    const branch = assertGitHubBranch(
      this.branch,
      'Resolved annotation repository branch'
    );
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
    datasetName,
    fieldsToAnnotate,
    annotatableSettings,
    closedFields,
    commitMessage = null,
    conflictIfRemoteShaNotEqual = null,
    publicationMode,
  } = {}) {
    const mode = assertPublicationMode(publicationMode);
    const token = this.token;
    if (!token) throw new Error('GitHub sign-in required');

    const { repoInfo, branch } = await this.validateAndLoadConfig({ datasetId });
    const capability = assertRepositoryPublicationInfo(repoInfo);
    if (!capability.canManage) {
      throw new Error(
        'Maintain/admin access required to update annotations/config.json'
      );
    }

    const did = datasetId === undefined
      ? this.datasetId
      : assertExactNonblankString(datasetId, 'datasetId', { max: 256 });

    const msg = commitMessage === null
      ? `Update annotatable fields for ${did}`
      : assertExactNonblankString(
        commitMessage,
        'Annotation config commit message',
        { max: 256 }
      );
    const expectedSha = conflictIfRemoteShaNotEqual === null
      ? null
      : assertGitHubSha(
        conflictIfRemoteShaNotEqual,
        'Expected annotation config SHA'
      );
    const { json: current, sha } = await readJsonFile({
      workerOrigin: this.workerOrigin,
      owner: this.owner,
      repo: this.repo,
      token,
      path: 'annotations/config.json',
      ref: branch
    });
    assertConfigDocument(current, { path: 'annotations/config.json' });

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
        'Pull first to review the latest settings, then Publish again.'
      );
      err.code = 'COMMUNITY_ANNOTATION_CONFLICT';
      err.path = 'annotations/config.json';
      err.remoteSha = sha || null;
      err.expectedSha = expectedSha;
      throw err;
    }

    const existing = current.supportedDatasets.find((entry) => entry.datasetId === did) || null;
    const name = datasetName === undefined ? existing?.name : datasetName;
    const replacement = {
      datasetId: did,
      name,
      fieldsToAnnotate,
      annotatableSettings,
      closedFields,
    };
    const nextConfig = {
      version: 1,
      supportedDatasets: existing
        ? current.supportedDatasets.map((entry) =>
          entry.datasetId === did ? replacement : entry
        )
        : [...current.supportedDatasets, replacement],
    };
    assertConfigDocument(nextConfig, { path: 'annotations/config.json publish payload' });

    // Avoid no-op commits: compare semantic JSON ignoring key order.
    const changed = stableStringifyJson(current) !== stableStringifyJson(nextConfig);
    if (!changed) {
      return {
        mode: 'none',
        branch,
        path: 'annotations/config.json',
        sha: sha || null,
        ...replacement,
        changed: false
      };
    }

    const contentBase64 = encodeBase64Utf8(
      JSON.stringify(nextConfig, null, 2) + '\n'
    );
    try {
      const result = await publishAnnotationFile({
        publicationMode: mode,
        repoInfo,
        workerOrigin: this.workerOrigin,
        token,
        upstreamOwner: this.owner,
        upstreamRepo: this.repo,
        baseBranch: branch,
        datasetId: did,
        fileUser: null,
        path: 'annotations/config.json',
        title: msg,
        body: [
          'Community annotation configuration update from Cellucid.',
          '',
          'File: `annotations/config.json`',
        ].join('\n'),
        contentBase64,
        sourceSha: sha,
      });
      return {
        ...result,
        branch,
        path: 'annotations/config.json',
        ...replacement,
        changed: true
      };
    } catch (err) {
      if (isContentConflictError(err)) {
        const conflict = new Error(
          'annotations/config.json changed while publishing.\n' +
          'Pull first to review/merge the latest settings, then Publish again.'
        );
        conflict.code = 'COMMUNITY_ANNOTATION_CONFLICT';
        conflict.path = 'annotations/config.json';
        throw conflict;
      }
      throw err;
    }
  }

  async pullModerationMerges({ knownShas = null } = {}) {
    const token = this.token;
    if (!token) throw new Error('GitHub sign-in required');
    const branch = assertGitHubBranch(
      this.branch,
      'Resolved annotation repository branch'
    );
    const workerOrigin = this.workerOrigin;
    const path = 'annotations/moderation/merges.json';
    if (
      knownShas !== null &&
      (
        typeof knownShas !== 'object' ||
        Array.isArray(knownShas)
      )
    ) {
      throw new Error('Known annotation SHAs must be a JSON object or null');
    }
    const previousSha =
      knownShas !== null && Object.hasOwn(knownShas, path)
        ? assertGitHubSha(knownShas[path], `Known SHA for ${path}`)
        : null;
    try {
      const content = await getContent({
        workerOrigin,
        owner: this.owner,
        repo: this.repo,
        token,
        path,
        ref: branch
      });
      if (!content || content.type !== 'file') {
        throw new Error(`Expected file at ${path}`);
      }
      const sha = assertGitHubSha(content.sha, `${path} SHA`);
      if (previousSha === sha) {
        return { doc: null, sha, path, fetched: false };
      }
      const { json } = decodeJsonContentFile(content, path);
      assertMergesDocument(json, { path });
      return { doc: json, sha, path, fetched: true };
    } catch (err) {
      if (isNotFoundError(err)) return { doc: null, sha: null, path, fetched: false };
      throw err;
    }
  }

  async pushModerationMerges({
    mergesDoc,
    commitMessage = null,
    conflictIfRemoteShaNotEqual = null,
    publicationMode,
  } = {}) {
    const mode = assertPublicationMode(publicationMode);
    const token = this.token;
    if (!token) throw new Error('GitHub sign-in required');

    const repoInfo =
      this._repoInfo === null
        ? await getRepoInfo({
            workerOrigin: this.workerOrigin,
            owner: this.owner,
            repo: this.repo,
            token,
          })
        : this._repoInfo;
    const capability = assertRepositoryPublicationInfo(repoInfo);
    this._repoInfo = repoInfo;
    if (!capability.canManage) {
      throw new Error(
        'Maintain/admin access required to publish moderation merges'
      );
    }

    const branch = this.branch === null
      ? assertGitHubBranch(
        repoInfo?.default_branch,
        'GitHub repository default_branch'
      )
      : assertGitHubBranch(this.branch);
    this.branch = branch;

    const msg = commitMessage === null
      ? 'Update annotation moderation merges'
      : assertExactNonblankString(
        commitMessage,
        'Moderation merges commit message',
        { max: 256 }
      );
    assertMergesDocument(mergesDoc, {
      path: 'annotations/moderation/merges.json publish payload',
    });
    const incoming = mergesDoc;

    const expectedSha = conflictIfRemoteShaNotEqual === null
      ? null
      : assertGitHubSha(
        conflictIfRemoteShaNotEqual,
        'Expected moderation merges SHA'
      );

    const { json: current, sha } = await readJsonFileOrNull({
      workerOrigin: this.workerOrigin,
      owner: this.owner,
      repo: this.repo,
      token,
      path: 'annotations/moderation/merges.json',
      ref: branch
    });

    // If the remote file exists, require a baseline SHA from the last Pull.
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

    if (current !== null) {
      assertMergesDocument(current, { path: 'annotations/moderation/merges.json' });
    }
    const currentComparable = current
      ? { version: current.version, merges: current.merges }
      : null;
    const nextComparable = { version: incoming.version, merges: incoming.merges };
    const changed = stableStringifyJson(currentComparable) !== stableStringifyJson(nextComparable);
    if (!changed) {
      return {
        mode: 'none',
        branch,
        path: 'annotations/moderation/merges.json',
        sha: sha || null,
        changed: false,
      };
    }

    const contentBase64 = encodeBase64Utf8(
      JSON.stringify(incoming, null, 2) + '\n'
    );
    try {
      const result = await publishAnnotationFile({
        publicationMode: mode,
        repoInfo,
        workerOrigin: this.workerOrigin,
        token,
        upstreamOwner: this.owner,
        upstreamRepo: this.repo,
        baseBranch: branch,
        datasetId: this.datasetId,
        fileUser: null,
        path: 'annotations/moderation/merges.json',
        title: msg,
        body: [
          'Community annotation moderation update from Cellucid.',
          '',
          'File: `annotations/moderation/merges.json`',
        ].join('\n'),
        contentBase64,
        sourceSha: sha,
      });
      return {
        ...result,
        branch,
        path: 'annotations/moderation/merges.json',
        changed: true,
      };
    } catch (err) {
      if (isContentConflictError(err)) {
        const conflict = new Error(
          'annotations/moderation/merges.json changed while publishing.\n' +
          'Pull first to review the latest merges, then Publish again.'
        );
        conflict.code = 'COMMUNITY_ANNOTATION_CONFLICT';
        conflict.path = 'annotations/moderation/merges.json';
        throw conflict;
      }
      throw err;
    }
  }

  async getAuthenticatedUser() {
    const token = this.token;
    if (!token) return null;
    return assertAuthUserResponse(
      await workerAuthRequest(this.workerOrigin, '/auth/user', { token })
    );
  }

  async pullAllUsers({ knownShas = null } = {}) {
    const token = this.token;
    if (!token) throw new Error('GitHub sign-in required');
    const branch = assertGitHubBranch(
      this.branch,
      'Resolved annotation repository branch'
    );
    const workerOrigin = this.workerOrigin;

    const tree = await getGitTreeRecursive({ workerOrigin, owner: this.owner, repo: this.repo, token, ref: branch });
    if (!Array.isArray(tree)) {
      throw new Error('Git tree response must contain an array');
    }
    const userBlobs = [];
    for (const entry of tree) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error('Git tree entries must be objects');
      }
      const path = entry.path;
      if (
        typeof path !== 'string' ||
        !path ||
        /^\s|\s$/.test(path)
      ) {
        throw new Error('Git tree entry path must be an exact nonblank string');
      }
      if (!path.startsWith('annotations/users/')) continue;
      if (
        entry.type !== 'blob' ||
        !/^annotations\/users\/ghid_[1-9][0-9]*\.json$/.test(path)
      ) {
        throw new Error(
          `Invalid annotation user-file path ${JSON.stringify(path)}; ` +
          'expected annotations/users/ghid_<positive-github-id>.json'
        );
      }
      userBlobs.push(entry);
    }

    /** @type {Record<string, string>} */
    const nextShas = {};
    for (const f of userBlobs) {
      const path = f.path;
      const sha = assertGitHubSha(
        f.sha,
        `Git tree SHA for ${JSON.stringify(path)}`
      );
      if (Object.hasOwn(nextShas, path)) {
        throw new Error(`Git tree contains duplicate path ${JSON.stringify(path)}`);
      }
      nextShas[path] = sha;
    }

    if (
      knownShas !== null &&
      (
        typeof knownShas !== 'object' ||
        Array.isArray(knownShas)
      )
    ) {
      throw new Error('Known annotation SHAs must be a JSON object or null');
    }
    if (knownShas !== null) {
      for (const [path, sha] of Object.entries(knownShas)) {
        if (
          path !== 'annotations/config.json' &&
          path !== 'annotations/moderation/merges.json' &&
          !/^annotations\/users\/ghid_[1-9][0-9]*\.json$/.test(path)
        ) {
          throw new Error(
            `Known annotation SHA path is invalid: ${JSON.stringify(path)}`
          );
        }
        assertGitHubSha(sha, `Known SHA for ${path}`);
      }
    }
    const needsFetch = (path, sha) => {
      if (knownShas === null || !Object.hasOwn(knownShas, path)) return true;
      return knownShas[path] !== sha;
    };

    const allPaths = Object.keys(nextShas).sort((a, b) => a.localeCompare(b));
    const toFetch = allPaths.filter((path) => needsFetch(path, nextShas[path]));

    const concurrency = DEFAULT_USER_PULL_CONCURRENCY;
    const out = await mapWithConcurrency(toFetch, concurrency, async (path) => {
      const sha = nextShas[path] || null;
      const filename = path.split('/').pop();
      const json = await getGitBlobJson({
        workerOrigin,
        owner: this.owner,
        repo: this.repo,
        token,
        sha,
        path,
      });
      assertUserDocument(json, { path, filename });
      return { path, sha, doc: json };
    });

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
    const branch = assertGitHubBranch(
      this.branch,
      'Resolved annotation repository branch'
    );
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
      assertUserDocument(json, { path, filename: `${key}.json` });
      return { doc: json, sha: sha || null, path };
    } catch (err) {
      if (err?.status === 404) return null;
      throw err;
    }
  }

  async pushMyUserFile({
    userDoc,
    commitMessage = null,
    conflictIfRemoteShaNotEqual = null,
    publicationMode,
  } = {}) {
    const mode = assertPublicationMode(publicationMode);
    const token = this.token;
    if (!token) throw new Error('GitHub token required to push');
    const branch = assertGitHubBranch(
      this.branch,
      'Resolved annotation repository branch'
    );
    const workerOrigin = this.workerOrigin;

    const id = userDoc?.githubUserId;
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new Error('User doc githubUserId must be a positive safe integer');
    }
    const fileUser = `ghid_${id}`;
    const path = `annotations/users/${fileUser}.json`;
    assertUserDocument(userDoc, { path, filename: `${fileUser}.json` });
    const authenticatedUser = assertAuthUserResponse(
      await workerAuthRequest(workerOrigin, '/auth/user', { token })
    );
    if (authenticatedUser.id !== id) {
      throw new Error(
        `User document identity ${fileUser} does not match authenticated GitHub user ghid_${authenticatedUser.id}`
      );
    }

    let sha = null;
    let remoteUpdatedAt = null;
    try {
      const existing = await getContent({ workerOrigin, owner: this.owner, repo: this.repo, token, path, ref: branch });
      const { json: parsed, sha: existingSha } = decodeJsonContentFile(existing, path);
      sha = existingSha;
      assertUserDocument(parsed, { path, filename: `${fileUser}.json` });
      remoteUpdatedAt = parsed.updatedAt;
    } catch (err) {
      if (err?.status !== 404) throw err;
    }

    const expectedSha = conflictIfRemoteShaNotEqual === null
      ? null
      : assertGitHubSha(
        conflictIfRemoteShaNotEqual,
        'Expected remote user-file SHA'
      );
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
        'Pull first to merge changes before publishing.'
      );
      err.code = 'COMMUNITY_ANNOTATION_CONFLICT';
      err.remoteUpdatedAt = remoteUpdatedAt;
      err.remoteSha = sha;
      err.expectedSha = expectedSha;
      err.path = path;
      throw err;
    }

    const repoInfo =
      this._repoInfo === null
        ? await getRepoInfo({
            workerOrigin,
            owner: this.owner,
            repo: this.repo,
            token,
          })
        : this._repoInfo;
    assertRepositoryPublicationInfo(repoInfo);
    this._repoInfo = repoInfo;
    const msg = commitMessage === null
      ? `Update annotations for @${authenticatedUser.login}`
      : assertExactNonblankString(
        commitMessage,
        'Annotation user-file commit message',
        { max: 256 }
      );
    const content = encodeBase64Utf8(JSON.stringify(userDoc, null, 2) + '\n');
    try {
      const result = await publishAnnotationFile({
        publicationMode: mode,
        repoInfo,
        workerOrigin,
        upstreamOwner: this.owner,
        upstreamRepo: this.repo,
        token,
        baseBranch: branch,
        datasetId: this.datasetId,
        fileUser,
        path,
        title: msg,
        body: [
          'Community annotation update from Cellucid.',
          '',
          `User: @${authenticatedUser.login}`,
          `File: \`${path}\``,
        ].join('\n'),
        contentBase64: content,
        sourceSha: sha,
      });
      return { ...result, path, remoteUpdatedAt };
    } catch (err) {
      if (isContentConflictError(err)) {
        const conflict = new Error(
          'Remote user file changed while publishing.\n' +
          'Pull first to merge changes before publishing.'
        );
        conflict.code = 'COMMUNITY_ANNOTATION_CONFLICT';
        conflict.remoteUpdatedAt = remoteUpdatedAt;
        conflict.path = path;
        throw conflict;
      }
      throw err;
    }
  }
}

export function getGitHubSyncForDataset({ datasetId, username = 'local', tokenOverride = null } = {}) {
  const repo = getAnnotationRepoForDataset(datasetId, username);
  if (!repo) return null;
  const parsed = parseOwnerRepo(repo);
  if (!parsed) return null;
  const meta = getAnnotationRepoMetaForDataset(datasetId, username);
  if (!meta || (meta.branchMode !== 'default' && meta.branchMode !== 'explicit')) {
    throw new Error('Stored annotation repository connection is missing exact branchMode');
  }
  if (meta.branchMode === 'explicit' && parsed.ref === null) {
    throw new Error('Explicit annotation repository connection is missing its branch');
  }
  const branchMode = meta.branchMode;
  const token = tokenOverride === null
    ? getGitHubAuthSession().getToken()
    : assertOptionalToken(tokenOverride);
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
  if (!parsed || parsed.ref === null) return false;
  return setAnnotationRepoForDataset(
    datasetId,
    parsed.ownerRepoRef,
    username,
    { branchMode: 'explicit' }
  );
}

export async function setDatasetAnnotationRepoFromUrlParamAsync({ datasetId, urlParamValue, username = 'local', tokenOverride = null } = {}) {
  const parsed = parseOwnerRepo(urlParamValue);
  if (!parsed) return false;

  // Default-branch ownership is resolved once, before the repository reference
  // becomes persistent state.
  if (!parsed.ref) {
    const token = tokenOverride === null
      ? getGitHubAuthSession().getToken()
      : assertOptionalToken(tokenOverride);
    if (!token) return false;
    const repoInfo = await getRepoInfo({
      workerOrigin: getGitHubWorkerOrigin(),
      owner: parsed.owner,
      repo: parsed.repo,
      token
    });
    const head = assertGitHubBranch(
      repoInfo?.default_branch,
      'GitHub repository default_branch'
    );
    return setAnnotationRepoForDataset(
      datasetId,
      `${parsed.ownerRepo}@${head}`,
      username,
      { branchMode: 'default' }
    );
  }

  return setAnnotationRepoForDataset(
    datasetId,
    parsed.ownerRepoRef,
    username,
    { branchMode: 'explicit' }
  );
}
