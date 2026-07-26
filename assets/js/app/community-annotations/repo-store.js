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
import { parseExactJson } from './wire-contract.js';
import { parseCanonicalGitHubRepositoryReference } from './github-reference.js';

const REPO_MAP_KEY = 'cellucid:community-annotations:repo-map';

function normalizeDatasetId(datasetId) {
  if (
    typeof datasetId !== 'string' ||
    !/\S/.test(datasetId) ||
    /^\s|\s$/.test(datasetId) ||
    Array.from(datasetId).length > 256
  ) {
    throw new Error('Annotation repository dataset id must be an exact nonblank string');
  }
  return datasetId;
}

function normalizeUsername(username) {
  if (
    username !== 'local' &&
    (
      typeof username !== 'string' ||
      !/^ghid_[1-9][0-9]*$/.test(username) ||
      Array.from(username).length > 64 ||
      !Number.isSafeInteger(Number(username.slice(5))) ||
      Number(username.slice(5)) < 1 ||
      username !== `ghid_${Number(username.slice(5))}`
    )
  ) {
    throw new Error('Annotation repository user must be "local" or an exact ghid identity');
  }
  return username;
}

function mapKey(datasetId, username) {
  return `${normalizeDatasetId(datasetId)}::${normalizeUsername(username)}`;
}

function normalizeBranchMode(value) {
  if (value !== 'default' && value !== 'explicit') {
    throw new Error('Annotation repository branchMode must equal "default" or "explicit"');
  }
  return value;
}

function storageFailure(operation, cause) {
  const error = new Error(`Annotation repository storage ${operation} failed`);
  error.code = 'COMMUNITY_ANNOTATION_REPO_STORAGE_FAILED';
  error.cause = cause;
  return error;
}

function readStorage(key) {
  try {
    if (typeof localStorage === 'undefined') throw new Error('localStorage is unavailable');
    return localStorage.getItem(key);
  } catch (cause) {
    throw storageFailure('read', cause);
  }
}

function writeStorage(key, value) {
  try {
    if (typeof localStorage === 'undefined') throw new Error('localStorage is unavailable');
    localStorage.setItem(key, value);
  } catch (cause) {
    throw storageFailure('write', cause);
  }
}

function removeStorage(key) {
  try {
    if (typeof localStorage === 'undefined') throw new Error('localStorage is unavailable');
    localStorage.removeItem(key);
  } catch (cause) {
    throw storageFailure('remove', cause);
  }
}

function readExactMap(key, label, validateEntry) {
  const raw = readStorage(key);
  if (raw === null) return {};
  const parsed = parseExactJson(raw, { path: label });
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  for (const [entryKey, entry] of Object.entries(parsed)) {
    const separatorIndex = entryKey.lastIndexOf('::');
    if (separatorIndex < 1) {
      throw new Error(`${label} contains an invalid map key`);
    }
    const datasetId = entryKey.slice(0, separatorIndex);
    const username = entryKey.slice(separatorIndex + 2);
    if (mapKey(datasetId, username) !== entryKey) {
      throw new Error(`${label} contains a noncanonical map key`);
    }
    validateEntry(entry, entryKey);
  }
  return parsed;
}

function assertRepoRef(repoRef) {
  const parsed = parseCanonicalGitHubRepositoryReference(repoRef);
  if (parsed === null || parsed.ref === null) {
    throw new Error(
      'Stored annotation repository reference must equal canonical owner/repo@resolved-branch'
    );
  }
  return repoRef;
}

function readRepoMap(key, label) {
  return readExactMap(key, label, (record) => {
    if (
      !record ||
      typeof record !== 'object' ||
      Array.isArray(record) ||
      Object.keys(record).length !== 2 ||
      !Object.hasOwn(record, 'repoRef') ||
      !Object.hasOwn(record, 'branchMode')
    ) {
      throw new Error(
        'Annotation repository map entries must contain exactly repoRef and branchMode'
      );
    }
    assertRepoRef(record.repoRef);
    normalizeBranchMode(record.branchMode);
  });
}

export function getAnnotationRepoForDataset(datasetId, username = 'local') {
  if (datasetId === null || datasetId === undefined || datasetId === '') {
    return null;
  }
  const id = normalizeDatasetId(datasetId);
  const user = normalizeUsername(username);
  const parsed = readRepoMap(REPO_MAP_KEY, 'annotation repository map');
  return parsed[mapKey(id, user)]?.repoRef ?? null;
}

export function getAnnotationRepoMetaForDataset(datasetId, username = 'local') {
  if (datasetId === null || datasetId === undefined || datasetId === '') {
    return null;
  }
  const id = normalizeDatasetId(datasetId);
  const user = normalizeUsername(username);
  const parsed = readRepoMap(REPO_MAP_KEY, 'annotation repository map');
  const record = parsed[mapKey(id, user)] ?? null;
  return record === null ? null : { branchMode: record.branchMode };
}

export function setAnnotationRepoForDataset(
  datasetId,
  ownerRepo,
  username,
  options
) {
  const id = normalizeDatasetId(datasetId);
  const user = normalizeUsername(username);
  const repo = assertRepoRef(ownerRepo);
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).length !== 1 ||
    !Object.hasOwn(options, 'branchMode')
  ) {
    throw new Error(
      'Annotation repository connection options must contain exactly branchMode'
    );
  }
  const branchMode = normalizeBranchMode(options.branchMode);
  const parsed = readRepoMap(REPO_MAP_KEY, 'annotation repository map');
  parsed[mapKey(id, user)] = { repoRef: repo, branchMode };
  writeStorage(REPO_MAP_KEY, JSON.stringify(parsed));
  dispatchAnnotationConnectionChanged({ datasetId: id, username: user, reason: 'set' });
  return true;
}

export function clearAnnotationRepoForDataset(datasetId, username = 'local') {
  const id = normalizeDatasetId(datasetId);
  const user = normalizeUsername(username);
  const parsed = readRepoMap(REPO_MAP_KEY, 'annotation repository map');
  delete parsed[mapKey(id, user)];
  if (Object.keys(parsed).length) writeStorage(REPO_MAP_KEY, JSON.stringify(parsed));
  else removeStorage(REPO_MAP_KEY);
  dispatchAnnotationConnectionChanged({ datasetId: id, username: user, reason: 'clear' });
  return true;
}
