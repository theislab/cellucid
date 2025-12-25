/**
 * Community Annotation - Repo storage helpers.
 *
 * Stores:
 * - datasetId + user -> connected annotation repo (owner/repo[@branch])
 *
 * Security:
 * - No tokens are stored here.
 */

import { dispatchAnnotationConnectionChanged } from './connection-events.js';

const REPO_MAP_KEY = 'cellucid:community-annotations:repo-map';
const LAST_REPO_MAP_KEY = 'cellucid:community-annotations:last-repo-map';

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
  const user = normalizeUsername(username);
  try {
    const raw = localStorage.getItem(REPO_MAP_KEY);
    const parsed = raw ? safeJsonParse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return null;

    const repo = toCleanString(parsed?.[mapKey(id, user)] || '');
    if (repo) return repo;

    return null;
  } catch {
    return null;
  }
}

function _setLastRepoForDataset(datasetId, username, repoRef) {
  const id = normalizeDatasetId(datasetId);
  const user = normalizeUsername(username);
  const repo = toCleanString(repoRef);
  if (!repo || repo.length > 256) return false;
  try {
    const raw = localStorage.getItem(LAST_REPO_MAP_KEY);
    const parsed = (raw ? safeJsonParse(raw) : null) || {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    parsed[mapKey(id, user)] = repo;
    const payload = safeJsonStringify(parsed);
    if (!payload) return false;
    localStorage.setItem(LAST_REPO_MAP_KEY, payload);
    return true;
  } catch {
    return false;
  }
}

export function getLastAnnotationRepoForDataset(datasetId, username = 'local') {
  const id = normalizeDatasetId(datasetId);
  const user = normalizeUsername(username);
  try {
    const raw = localStorage.getItem(LAST_REPO_MAP_KEY);
    const parsed = raw ? safeJsonParse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return null;
    const repo = toCleanString(parsed?.[mapKey(id, user)] || '');
    if (repo) return repo;
  } catch {
    return null;
  }
}

export function setAnnotationRepoForDataset(datasetId, ownerRepo, username = 'local') {
  const id = normalizeDatasetId(datasetId);
  const user = normalizeUsername(username);
  const repo = toCleanString(ownerRepo);
  if (!repo || repo.length > 256) return false;
  try {
    const raw = localStorage.getItem(REPO_MAP_KEY);
    const parsed = (raw ? safeJsonParse(raw) : null) || {};
    if (typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    parsed[mapKey(id, user)] = repo;
    const payload = safeJsonStringify(parsed);
    if (!payload) return false;
    localStorage.setItem(REPO_MAP_KEY, payload);
    _setLastRepoForDataset(id, user, repo);
    dispatchAnnotationConnectionChanged({ datasetId: id, username: user, reason: 'set' });
    return true;
  } catch {
    return false;
  }
}

export function clearAnnotationRepoForDataset(datasetId, username = 'local') {
  const id = normalizeDatasetId(datasetId);
  const user = normalizeUsername(username);
  try {
    const raw = localStorage.getItem(REPO_MAP_KEY);
    const parsed = raw ? safeJsonParse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return true;
    delete parsed[mapKey(id, user)];
    const payload = safeJsonStringify(parsed);
    if (!payload) {
      localStorage.removeItem(REPO_MAP_KEY);
      return true;
    }
    localStorage.setItem(REPO_MAP_KEY, payload);
    dispatchAnnotationConnectionChanged({ datasetId: id, username: user, reason: 'clear' });
    return true;
  } catch {
    return false;
  }
}
