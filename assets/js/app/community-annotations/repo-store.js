/**
 * Community Annotation - Repo storage helpers.
 *
 * Stores:
 * - datasetId -> connected annotation repo (owner/repo)
 *
 * Security:
 * - No tokens are stored here.
 */

const REPO_MAP_KEY = 'cellucid:community-annotations:repo-map';

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

function normalizeUsername(username) {
  return toCleanString(username).replace(/^@+/, '').toLowerCase() || 'local';
}

function mapKey(datasetId, username) {
  return `${normalizeDatasetId(datasetId)}::${normalizeUsername(username)}`;
}

export function getAnnotationRepoForDataset(datasetId, username = 'local') {
  const id = normalizeDatasetId(datasetId);
  try {
    const raw = localStorage.getItem(REPO_MAP_KEY);
    const parsed = raw ? safeJsonParse(raw) : null;
    const repo = toCleanString(parsed?.[mapKey(id, username)] || '');
    return repo || null;
  } catch {
    return null;
  }
}

export function setAnnotationRepoForDataset(datasetId, ownerRepo, username = 'local') {
  const id = normalizeDatasetId(datasetId);
  const repo = toCleanString(ownerRepo);
  if (!repo || repo.length > 256) return false;
  try {
    const raw = localStorage.getItem(REPO_MAP_KEY);
    const parsed = (raw ? safeJsonParse(raw) : null) || {};
    parsed[mapKey(id, username)] = repo;
    const payload = safeJsonStringify(parsed);
    if (!payload) return false;
    localStorage.setItem(REPO_MAP_KEY, payload);
    return true;
  } catch {
    return false;
  }
}

export function clearAnnotationRepoForDataset(datasetId, username = 'local') {
  const id = normalizeDatasetId(datasetId);
  try {
    const raw = localStorage.getItem(REPO_MAP_KEY);
    const parsed = raw ? safeJsonParse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return true;
    delete parsed[mapKey(id, username)];
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
