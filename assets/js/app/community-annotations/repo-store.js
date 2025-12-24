/**
 * Community Annotation - Repo/token storage helpers.
 *
 * Stores:
 * - datasetId -> connected annotation repo (owner/repo)
 * - repo -> GitHub fine-grained PAT (optional; required for private repos and pushes)
 *   - Stored in-memory for this session by default
 *   - Stored in localStorage only if the user opts in via UI
 *
 * Security:
 * - Tokens are never logged.
 * - Tokens are stored in localStorage only if the user opts in via UI.
 */

const REPO_MAP_KEY = 'cellucid:community-annotations:repo-map:v1';
const TOKEN_PREFIX = 'cellucid:community-annotations:pat:v1:';

// In-memory token store for the current page session only.
// This supports private repo access without persisting PATs to localStorage unless the user opts in.
const sessionTokensByRepo = new Map();

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

function safeJsonStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return null;
  }
}

function normalizeDatasetId(datasetId) {
  const id = toCleanString(datasetId);
  return id || 'default';
}

export function getAnnotationRepoForDataset(datasetId) {
  const id = normalizeDatasetId(datasetId);
  try {
    const raw = localStorage.getItem(REPO_MAP_KEY);
    const parsed = raw ? safeJsonParse(raw) : null;
    const repo = toCleanString(parsed?.[id] || '');
    return repo || null;
  } catch {
    return null;
  }
}

export function setAnnotationRepoForDataset(datasetId, ownerRepo) {
  const id = normalizeDatasetId(datasetId);
  const repo = toCleanString(ownerRepo);
  if (!repo || repo.length > 256) return false;
  try {
    const raw = localStorage.getItem(REPO_MAP_KEY);
    const parsed = (raw ? safeJsonParse(raw) : null) || {};
    parsed[id] = repo;
    const payload = safeJsonStringify(parsed);
    if (!payload) return false;
    localStorage.setItem(REPO_MAP_KEY, payload);
    return true;
  } catch {
    return false;
  }
}

export function clearAnnotationRepoForDataset(datasetId) {
  const id = normalizeDatasetId(datasetId);
  try {
    const raw = localStorage.getItem(REPO_MAP_KEY);
    const parsed = raw ? safeJsonParse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return true;
    delete parsed[id];
    const payload = safeJsonStringify(parsed);
    if (!payload) {
      localStorage.removeItem(REPO_MAP_KEY);
      return true;
    }
    localStorage.setItem(REPO_MAP_KEY, payload);
    return true;
  } catch {
    return false;
  }
}

function tokenKey(ownerRepo) {
  // Repo string is validated elsewhere; treat as opaque key suffix.
  return `${TOKEN_PREFIX}${toCleanString(ownerRepo)}`;
}

export function getSessionPatForRepo(ownerRepo) {
  const repo = toCleanString(ownerRepo);
  if (!repo) return null;
  const token = toCleanString(sessionTokensByRepo.get(repo) || '');
  return token || null;
}

export function setSessionPatForRepo(ownerRepo, token) {
  const repo = toCleanString(ownerRepo);
  const pat = toCleanString(token);
  if (!repo || !pat || pat.length > 1000) return false;
  sessionTokensByRepo.set(repo, pat);
  // Prevent unbounded growth if many repos are connected in one session.
  if (sessionTokensByRepo.size > 25) {
    const oldest = sessionTokensByRepo.keys().next().value;
    sessionTokensByRepo.delete(oldest);
  }
  return true;
}

export function clearSessionPatForRepo(ownerRepo) {
  const repo = toCleanString(ownerRepo);
  if (!repo) return true;
  sessionTokensByRepo.delete(repo);
  return true;
}

/**
 * Returns the best available token for a repo:
 * - session (in-memory) token first
 * - then persisted localStorage token (if previously saved by the user)
 */
export function getEffectivePatForRepo(ownerRepo) {
  const sessionPat = getSessionPatForRepo(ownerRepo);
  if (sessionPat) return sessionPat;
  return getPatForRepo(ownerRepo);
}

export function getPatForRepo(ownerRepo) {
  const repo = toCleanString(ownerRepo);
  if (!repo) return null;
  try {
    const token = toCleanString(localStorage.getItem(tokenKey(repo)) || '');
    return token || null;
  } catch {
    return null;
  }
}

export function setPatForRepo(ownerRepo, token) {
  const repo = toCleanString(ownerRepo);
  const pat = toCleanString(token);
  if (!repo || !pat || pat.length > 1000) return false;
  try {
    localStorage.setItem(tokenKey(repo), pat);
    return true;
  } catch {
    return false;
  }
}

export function clearPatForRepo(ownerRepo) {
  const repo = toCleanString(ownerRepo);
  if (!repo) return true;
  try {
    localStorage.removeItem(tokenKey(repo));
    return true;
  } catch {
    return false;
  }
}
