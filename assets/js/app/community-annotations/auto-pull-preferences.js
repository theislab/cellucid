/**
 * Exact current auto-pull preference contract.
 */

import { toCacheScopeKey } from './cache-scope.js';
import { parseExactJson } from './wire-contract.js';

export const AUTO_PULL_INTERVALS_MS = Object.freeze([
  600_000,
  900_000,
  3_600_000,
]);
export const DEFAULT_AUTO_PULL_INTERVAL_MS = AUTO_PULL_INTERVALS_MS[0];

export function assertAutoPullIntervalMs(value) {
  if (!AUTO_PULL_INTERVALS_MS.includes(value)) {
    throw new Error(
      'Auto-pull interval must equal 600000, 900000, or 3600000 milliseconds'
    );
  }
  return value;
}

export function autoPullIntervalFromSelectValue(value) {
  if (typeof value !== 'string') {
    throw new Error('Auto-pull interval selection must be a string');
  }
  const interval = AUTO_PULL_INTERVALS_MS.find(
    (candidate) => `${candidate}` === value
  );
  if (interval === undefined) {
    throw new Error('Auto-pull interval selection is invalid');
  }
  return interval;
}

function assertCanonicalScopeKey(scopeKey) {
  if (typeof scopeKey !== 'string' || !scopeKey || /^\s|\s$/.test(scopeKey)) {
    throw new Error('Auto-pull preference scope must be an exact cache scope key');
  }
  const parts = scopeKey.split('|');
  if (parts.length !== 4) {
    throw new Error('Auto-pull preference scope must contain four segments');
  }
  let datasetId;
  let ownerRepo;
  let branch;
  let userIdText;
  try {
    [datasetId, ownerRepo, branch, userIdText] = parts.map((part) =>
      decodeURIComponent(part)
    );
  } catch (cause) {
    const error = new Error('Auto-pull preference scope contains invalid URL encoding');
    error.cause = cause;
    throw error;
  }
  if (!/^[1-9][0-9]*$/.test(userIdText)) {
    throw new Error('Auto-pull preference scope user id must be canonical');
  }
  const userId = Number(userIdText);
  if (!Number.isSafeInteger(userId) || `${userId}` !== userIdText) {
    throw new Error('Auto-pull preference scope user id must be a safe integer');
  }
  const canonical = toCacheScopeKey({
    datasetId,
    repoRef: `${ownerRepo}@${branch}`,
    userId,
  });
  if (canonical !== scopeKey) {
    throw new Error('Auto-pull preference scope is not canonical');
  }
  return scopeKey;
}

function assertPreferenceEntry(value, scopeKey) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, 'enabled') ||
    !Object.hasOwn(value, 'intervalMs')
  ) {
    throw new Error(
      `Auto-pull preference ${JSON.stringify(scopeKey)} must contain exactly enabled and intervalMs`
    );
  }
  if (typeof value.enabled !== 'boolean') {
    throw new Error(
      `Auto-pull preference ${JSON.stringify(scopeKey)}.enabled must be boolean`
    );
  }
  assertAutoPullIntervalMs(value.intervalMs);
  return {
    enabled: value.enabled,
    intervalMs: value.intervalMs,
  };
}

export function assertAutoPullPreferences(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Auto-pull preferences must be a JSON object');
  }
  const entries = Object.entries(value);
  if (entries.length > 1000) {
    throw new Error('Auto-pull preferences must contain at most 1000 scopes');
  }
  const output = {};
  for (const [scopeKey, entry] of entries) {
    assertCanonicalScopeKey(scopeKey);
    output[scopeKey] = assertPreferenceEntry(entry, scopeKey);
  }
  return output;
}

export function parseAutoPullPreferences(raw) {
  if (raw === null) return {};
  return assertAutoPullPreferences(
    parseExactJson(raw, { path: 'auto-pull preferences' })
  );
}

export function serializeAutoPullPreferences(value) {
  return JSON.stringify(assertAutoPullPreferences(value));
}
