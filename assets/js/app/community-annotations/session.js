/**
 * Community Annotation & Voting - Local Session Store
 *
 * Offline-first session state persisted to localStorage, scoped by:
 * - datasetId
 * - repo@branch
 * - GitHub user.id (numeric id; not login/username)
 *
 * This keeps the app multi-user + multi-project safe within the same browser profile.
 * GitHub sync is intentionally out of scope for this store; it tracks user
 * intent and votes/suggestions in a merge-friendly shape.
 *
 * Security: This module does not touch the DOM and does not execute any
 * user-provided content.
 */

import { EventEmitter } from '../utils/event-emitter.js';
import { toCacheScopeKey, toSessionStorageKey } from './cache-scope.js';
import { getCommunityAnnotationScopeLock } from './scope-lock.js';

const STORAGE_VERSION = 1;

const MAX_LABEL_LEN = 120;
const MAX_ONTOLOGY_LEN = 64;
const MAX_EVIDENCE_LEN = 2000;
const MAX_SUGGESTIONS_PER_CLUSTER = 200;
const MAX_COMMENT_LEN = 500;
const MAX_COMMENTS_PER_SUGGESTION = 800;
const MAX_MERGE_NOTE_LEN = 512;

const DEFAULT_MIN_ANNOTATORS = 1;
const DEFAULT_CONSENSUS_THRESHOLD = 0.5;
const MAX_TRACKED_DATASETS = 200;

// Bucket and vote keys use ":" as a delimiter. Field keys can contain ":" in other
// parts of the app, so we escape fieldKey only when needed to keep keys unambiguous
// without changing the common case.
const FIELDKEY_ESCAPE_PREFIX = 'fk~';

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toCleanString(value) {
  return String(value ?? '').trim();
}

function normalizeLabelForCompare(value) {
  return toCleanString(value).toLowerCase().replace(/\s+/g, ' ');
}

function nowIso() {
  try {
    return new Date().toISOString();
  } catch {
    return String(Date.now());
  }
}

function normalizeGitHubUserIdOrNull(userId) {
  const n = Number(userId);
  if (!Number.isFinite(n)) return null;
  const safe = Math.max(0, Math.floor(n));
  return safe ? safe : null;
}

function toFileUserKeyFromId(userId) {
  const id = normalizeGitHubUserIdOrNull(userId);
  return id ? `ghid_${id}` : null;
}

function isGitHubUserKey(value) {
  return /^ghid_\d+$/i.test(toCleanString(value));
}

function createId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // ignore
  }
  return `s_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}

function clampLen(text, maxLen) {
  const s = toCleanString(text);
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen);
}

function encodeFieldKeyForKey(fieldKey) {
  const f = toCleanString(fieldKey);
  if (!f) return '';
  if (!f.includes(':')) return f;
  try {
    return `${FIELDKEY_ESCAPE_PREFIX}${encodeURIComponent(f)}`;
  } catch {
    // Fallback for rare invalid surrogate inputs.
    return `${FIELDKEY_ESCAPE_PREFIX}${f.replace(/%/g, '%25').replace(/:/g, '%3A')}`;
  }
}

function decodeFieldKeyFromKey(fieldKeyPart) {
  const raw = toCleanString(fieldKeyPart);
  if (!raw.startsWith(FIELDKEY_ESCAPE_PREFIX)) return raw;
  const encoded = raw.slice(FIELDKEY_ESCAPE_PREFIX.length);
  // Only treat as our encoding when a ":" was present (encodeURIComponent produces "%3A").
  if (!/%3a/i.test(encoded)) return raw;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return raw;
  }
}

function ensureStringArray(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const s = toCleanString(item);
    if (s) out.push(s);
  }
  return out;
}

function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const v of values) {
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function parseDateMsOrNull(value) {
  const s = toCleanString(value);
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

function normalizeDatasetAccessEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const fieldsToAnnotate = uniqueStrings(ensureStringArray(entry.fieldsToAnnotate)).slice(0, 200);
  const lastAccessedAt = clampLen(entry.lastAccessedAt, 64) || null;
  return { fieldsToAnnotate, lastAccessedAt };
}

function normalizeDatasetAccessMap(map) {
  const input = (map && typeof map === 'object' && !Array.isArray(map)) ? map : null;
  /** @type {Record<string, {fieldsToAnnotate:string[], lastAccessedAt:string|null}>} */
  const out = {};
  if (!input) return out;
  for (const [datasetIdRaw, entry] of Object.entries(input)) {
    const datasetId = toCleanString(datasetIdRaw);
    if (!datasetId) continue;
    const normalized = normalizeDatasetAccessEntry(entry);
    if (!normalized) continue;
    out[datasetId] = normalized;
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
    // Both missing/invalid timestamps: prefer the entry with a larger field list.
    out[datasetId] = (entry.fieldsToAnnotate.length >= prev.fieldsToAnnotate.length) ? entry : prev;
  }

  const ids = Object.keys(out);
  if (ids.length <= MAX_TRACKED_DATASETS) return out;

  // Prune to most-recently-accessed datasets to cap file growth.
  ids.sort((x, y) => {
    const ax = parseDateMsOrNull(out[x]?.lastAccessedAt) ?? -1;
    const ay = parseDateMsOrNull(out[y]?.lastAccessedAt) ?? -1;
    if (ay !== ax) return ay - ax;
    return x.localeCompare(y);
  });
  const keep = ids.slice(0, MAX_TRACKED_DATASETS);
  const pruned = {};
  for (const id of keep) pruned[id] = out[id];
  return pruned;
}

function sanitizeProfile(profile) {
  const username = normalizeUsername(profile?.username || '') || 'local';
  const login = clampLen(profile?.login || '', 64);
  const githubUserIdRaw = profile?.githubUserId;
  const githubUserId = Number.isFinite(Number(githubUserIdRaw)) ? Math.max(0, Math.floor(Number(githubUserIdRaw))) : null;
  const displayName = clampLen(profile?.displayName || '', 120);
  const title = clampLen(profile?.title || '', 120);
  const orcid = clampLen(profile?.orcid || '', 64);
  const linkedin = clampLen(profile?.linkedin || '', 120);
  return { username, login, githubUserId, displayName, title, orcid, linkedin };
}

function sanitizeKnownUserProfile(input) {
  const login = clampLen(input?.login || '', 64);
  const displayName = clampLen(input?.displayName || '', 120);
  const title = clampLen(input?.title || '', 120);
  const orcid = clampLen(input?.orcid || '', 64);
  const linkedin = clampLen(input?.linkedin || '', 120);
  if (!login && !displayName && !title && !orcid && !linkedin) return null;
  return { login, displayName, title, orcid, linkedin };
}

function normalizeUsername(username) {
  return clampLen(String(username || '').replace(/^@+/, ''), 64).toLowerCase();
}

function normalizeMinAnnotators(value) {
  if (!Number.isFinite(value)) return DEFAULT_MIN_ANNOTATORS;
  return Math.max(0, Math.min(50, Math.floor(value)));
}

function normalizeConsensusThreshold(value) {
  if (!Number.isFinite(value)) return DEFAULT_CONSENSUS_THRESHOLD;
  return Math.max(-1, Math.min(1, value));
}

function normalizeConsensusSettings(input) {
  const minAnnotators = normalizeMinAnnotators(Number(input?.minAnnotators));
  const threshold = normalizeConsensusThreshold(Number(input?.threshold));
  return { minAnnotators, threshold };
}

function normalizeMarkers(input) {
  if (!Array.isArray(input)) return null;
  const out = [];
  for (const raw of input.slice(0, 200)) {
    if (typeof raw === 'string') {
      const gene = toCleanString(raw);
      if (!gene) continue;
      out.push(gene.slice(0, 64));
      if (out.length >= 50) break;
      continue;
    }
    if (raw && typeof raw === 'object') {
      const gene = toCleanString(raw.gene);
      if (!gene) continue;
      const entry = { gene: gene.slice(0, 64) };
      const logFC = raw.logFC;
      const pval = raw.pval;
      if (Number.isFinite(Number(logFC))) entry.logFC = Number(logFC);
      if (Number.isFinite(Number(pval))) entry.pval = Number(pval);
      out.push(entry);
      if (out.length >= 50) break;
    }
  }
  return out.length ? out : null;
}

function normalizeSuggestion(input, { proposedBy } = {}) {
  const label = clampLen(input?.label, MAX_LABEL_LEN);
  if (!label) return null;

  const ontologyId = clampLen(input?.ontologyId, MAX_ONTOLOGY_LEN);
  const evidence = clampLen(input?.evidence, MAX_EVIDENCE_LEN);
  const editedAt = clampLen(input?.editedAt, 64) || null;

  const upvotes = uniqueStrings(ensureStringArray(input?.upvotes).map((u) => normalizeUsername(u)).filter(Boolean));
  const upSet = new Set(upvotes);
  const downvotes = uniqueStrings(
    ensureStringArray(input?.downvotes)
      .map((u) => normalizeUsername(u))
      .filter((u) => u && !upSet.has(u))
  );

  return {
    id: createId(),
    label,
    ontologyId: ontologyId || null,
    evidence: evidence || null,
    proposedBy: normalizeUsername(proposedBy || input?.proposedBy || 'local') || 'local',
    proposedAt: nowIso(),
    editedAt,
    upvotes,
    downvotes,
    markers: normalizeMarkers(input?.markers),
    comments: []
  };
}

function normalizeComment(input, { authorUsername } = {}) {
  const text = clampLen(input?.text, MAX_COMMENT_LEN);
  if (!text) return null;

  const author = normalizeUsername(authorUsername || input?.authorUsername || 'local') || 'local';
  const id = toCleanString(input?.id) || createId();
  const createdAt = toCleanString(input?.createdAt) || nowIso();
  const editedAt = toCleanString(input?.editedAt) || null;

  return { id, text, authorUsername: author, createdAt, editedAt };
}

function normalizeCommentArray(comments) {
  if (!Array.isArray(comments)) return [];
  const out = [];
  const seenIds = new Set();
  for (const c of comments) {
    const normalized = normalizeComment(c);
    if (!normalized) continue;
    if (seenIds.has(normalized.id)) continue;
    seenIds.add(normalized.id);
    out.push(normalized);
  }
  return out.slice(0, MAX_COMMENTS_PER_SUGGESTION);
}

function suggestionKey(fieldKey, catKey, suggestionId) {
  return `${encodeFieldKeyForKey(fieldKey)}:${catKey}:${suggestionId}`;
}

function bucketKey(fieldKey, catKey) {
  return `${encodeFieldKeyForKey(fieldKey)}:${catKey}`;
}

function parseBucketKey(bucket) {
  const b = toCleanString(bucket);
  if (!b) return null;
  const first = b.indexOf(':');
  if (first < 0) return null;
  const fieldKey = decodeFieldKeyFromKey(b.slice(0, first));
  const catKey = b.slice(first + 1);
  if (!fieldKey || !catKey) return null;
  return { fieldKey, catKey };
}

function isNonNegativeIntegerString(value) {
  return /^\d+$/.test(toCleanString(value));
}

function normalizeModerationMerge(entry) {
  const bucket = toCleanString(entry?.bucket);
  const fromSuggestionId = toCleanString(entry?.fromSuggestionId);
  const intoSuggestionId = toCleanString(entry?.intoSuggestionId);
  if (!bucket || !fromSuggestionId || !intoSuggestionId) return null;
  if (fromSuggestionId === intoSuggestionId) return null;
  const by = normalizeUsername(entry?.by || '');
  const at = toCleanString(entry?.at);
  if (!by || !at) return null;
  const editedAt = clampLen(entry?.editedAt, 64) || null;
  const note = clampLen(entry?.note, MAX_MERGE_NOTE_LEN) || null;

  return {
    bucket,
    fromSuggestionId,
    intoSuggestionId,
    by,
    at,
    ...(editedAt ? { editedAt } : {}),
    ...(note ? { note } : {}),
  };
}

function compactModerationMerges(merges) {
  const list = Array.isArray(merges) ? merges : [];
  /** @type {Map<string, {at: string, index: number, entry: any}>} */
  const newestByKey = new Map();

  const isNewer = (prev, nextAt, nextIndex) => {
    const prevAt = toCleanString(prev?.at || '');
    const nextAtClean = toCleanString(nextAt || '');
    if (prevAt && nextAtClean) {
      if (nextAtClean > prevAt) return true;
      if (nextAtClean < prevAt) return false;
      return nextIndex > (prev?.index ?? -1);
    }
    if (!prevAt && nextAtClean) return true;
    if (prevAt && !nextAtClean) return false;
    return nextIndex > (prev?.index ?? -1);
  };

  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    const bucket = toCleanString(m?.bucket);
    const from = toCleanString(m?.fromSuggestionId);
    const into = toCleanString(m?.intoSuggestionId);
    if (!bucket || !from || !into) continue;
    const k = `${bucket}::${from}`;
    const prev = newestByKey.get(k) || null;
    const time = toCleanString(m?.editedAt || m?.at || '');
    if (!prev || isNewer(prev, time, i)) {
      newestByKey.set(k, { at: time, index: i, entry: m });
    }
  }

  return Array.from(newestByKey.values())
    .map((x) => x.entry)
    .sort((a, b) => {
      const ka = `${toCleanString(a?.bucket)}::${toCleanString(a?.fromSuggestionId)}`;
      const kb = `${toCleanString(b?.bucket)}::${toCleanString(b?.fromSuggestionId)}`;
      return ka.localeCompare(kb);
    })
    .slice(0, 5000);
}

function resolveMergeTarget(fromId, fromToMap) {
  const start = toCleanString(fromId);
  if (!start) return null;
  let cur = start;
  const seen = new Set([cur]);
  while (fromToMap.has(cur)) {
    const next = toCleanString(fromToMap.get(cur));
    if (!next) break;
    if (seen.has(next)) return null; // cycle
    seen.add(next);
    cur = next;
  }
  return cur;
}

function buildEffectiveModerationMergeMapForBucket(merges, bucket) {
  const bucketClean = toCleanString(bucket);
  if (!bucketClean || !Array.isArray(merges) || merges.length === 0) return new Map();

  /** @type {Map<string, {at: string, index: number, into: string}>} */
  const newestByFrom = new Map();
  const fromTo = new Map();

  const isNewer = (prev, nextAt, nextIndex) => {
    const prevAt = toCleanString(prev?.at || '');
    const nextAtClean = toCleanString(nextAt || '');
    if (prevAt && nextAtClean) {
      if (nextAtClean > prevAt) return true;
      if (nextAtClean < prevAt) return false;
      return nextIndex > (prev?.index ?? -1);
    }
    if (!prevAt && nextAtClean) return true;
    if (prevAt && !nextAtClean) return false;
    return nextIndex > (prev?.index ?? -1);
  };

  for (let i = 0; i < merges.length; i++) {
    const m = normalizeModerationMerge(merges[i]);
    if (!m || m.bucket !== bucketClean) continue;
    const from = toCleanString(m.fromSuggestionId);
    const into = toCleanString(m.intoSuggestionId);
    if (!from || !into) continue;
    const prev = newestByFrom.get(from) || null;
    const time = toCleanString(m.editedAt || m.at || '');
    if (!prev || isNewer(prev, time, i)) {
      newestByFrom.set(from, { at: time, index: i, into });
      fromTo.set(from, into);
    }
  }

  return fromTo;
}

function buildEffectiveModerationMergeMapByBucket(merges) {
  /** @type {Map<string, Map<string, string>>} */
  const out = new Map();
  if (!Array.isArray(merges) || merges.length === 0) return out;
  /** @type {Map<string, Map<string, {at: string, index: number, into: string}>>} */
  const newest = new Map();

  const isNewer = (prev, nextAt, nextIndex) => {
    const prevAt = toCleanString(prev?.at || '');
    const nextAtClean = toCleanString(nextAt || '');
    if (prevAt && nextAtClean) {
      if (nextAtClean > prevAt) return true;
      if (nextAtClean < prevAt) return false;
      return nextIndex > (prev?.index ?? -1);
    }
    if (!prevAt && nextAtClean) return true;
    if (prevAt && !nextAtClean) return false;
    return nextIndex > (prev?.index ?? -1);
  };

  for (let i = 0; i < merges.length; i++) {
    const m = normalizeModerationMerge(merges[i]);
    if (!m) continue;
    const bucket = toCleanString(m.bucket);
    const from = toCleanString(m.fromSuggestionId);
    const into = toCleanString(m.intoSuggestionId);
    if (!bucket || !from || !into) continue;
    if (!newest.has(bucket)) newest.set(bucket, new Map());
    const bucketNewest = newest.get(bucket);
    const prev = bucketNewest.get(from) || null;
    const time = toCleanString(m.editedAt || m.at || '');
    if (!prev || isNewer(prev, time, i)) {
      bucketNewest.set(from, { at: time, index: i, into });
    }
  }

  for (const [bucket, bucketNewest] of newest.entries()) {
    const map = new Map();
    for (const [from, meta] of bucketNewest.entries()) {
      map.set(from, meta.into);
    }
    out.set(bucket, map);
  }
  return out;
}

function parseVoteKey(key) {
  const raw = toCleanString(key);
  if (!raw) return null;
  const last = raw.lastIndexOf(':');
  if (last < 0) return null;
  const suggestionId = raw.slice(last + 1);
  const prefix = raw.slice(0, last);
  const first = prefix.indexOf(':');
  if (first < 0) return null;
  const fieldKey = decodeFieldKeyFromKey(prefix.slice(0, first));
  const catKey = prefix.slice(first + 1);
  if (!fieldKey || !catKey || !suggestionId) return null;
  return { fieldKey, catKey, suggestionId };
}

function mergeSuggestionMeta(existing, incoming, { preferIncoming = false } = {}) {
  if (!existing && !incoming) return null;
  if (!existing) return incoming || null;
  if (!incoming) return existing || null;

  const left = existing || {};
  const right = incoming || {};

  const time = (s) => toCleanString(s?.editedAt || s?.proposedAt || '');
  const leftTime = time(left);
  const rightTime = time(right);

  let takeIncoming = false;
  if (leftTime && rightTime) {
    if (rightTime > leftTime) takeIncoming = true;
    else if (rightTime < leftTime) takeIncoming = false;
    else takeIncoming = Boolean(preferIncoming);
  } else if (!leftTime && rightTime) {
    takeIncoming = true;
  } else if (leftTime && !rightTime) {
    takeIncoming = false;
  } else {
    takeIncoming = Boolean(preferIncoming);
  }

  // Use "prefer right" merge so explicit nulls (e.g. clearing evidence) are preserved.
  return takeIncoming
    ? mergeSuggestionMetaPreferRight(left, right)
    : mergeSuggestionMetaPreferRight(right, left);
}

function mergeSuggestionMetaPreferRight(a, b) {
  if (!a && !b) return null;
  const left = a || {};
  const right = b || {};

  const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

  const pickNullableString = (key, maxLen) => {
    if (hasOwn(right, key)) {
      if (right[key] == null) return null;
      const v = clampLen(right[key], maxLen);
      return v ? v : null;
    }
    if (hasOwn(left, key)) {
      if (left[key] == null) return null;
      const v = clampLen(left[key], maxLen);
      return v ? v : null;
    }
    return null;
  };

  const pickMarkers = () => {
    if (hasOwn(right, 'markers')) {
      return Array.isArray(right.markers) ? right.markers.slice(0, 50) : null;
    }
    return Array.isArray(left.markers) ? left.markers.slice(0, 50) : null;
  };

  return {
    id: clampLen(right.id || left.id || '', 128) || createId(),
    label: clampLen(right.label || left.label || '', MAX_LABEL_LEN),
    ontologyId: pickNullableString('ontologyId', MAX_ONTOLOGY_LEN),
    evidence: pickNullableString('evidence', MAX_EVIDENCE_LEN),
    proposedBy: clampLen(right.proposedBy || left.proposedBy || 'local', 64) || 'local',
    proposedAt: clampLen(right.proposedAt || left.proposedAt || nowIso(), 64) || nowIso(),
    editedAt: pickNullableString('editedAt', 64),
    markers: pickMarkers(),
  };
}

function defaultState() {
  return {
    version: STORAGE_VERSION,
    updatedAt: nowIso(),
    annotationFields: [],
    annotatableSettings: {}, // { [fieldKey]: { minAnnotators:number, threshold:number } }
    closedAnnotatableFields: {}, // { [fieldKey]: true }
    datasets: {}, // { [datasetId]: { fieldsToAnnotate:string[], lastAccessedAt:string } } (informational)
    // Persisted locally so profile edits survive refresh until Publish.
    profile: sanitizeProfile({}),
    suggestions: {}, // { [fieldKey:categoryLabel]: Suggestion[] }
    deletedSuggestions: {}, // { [fieldKey:categoryLabel]: string[] } (only the proposer can delete)
    myVotes: {}, // { [fieldKey:categoryLabel:suggestionId]: 'up'|'down' }
    myComments: {}, // { [suggestionId]: Comment[] }
    moderationMerges: [], // { bucket, fromSuggestionId, intoSuggestionId, by, at, note }[]
    // Used to enable incremental GitHub pulls (only fetch files whose sha changed).
    remoteFileShas: {}, // { [path]: sha }
    lastSyncAt: null
  };
}

export class CommunityAnnotationSession extends EventEmitter {
  constructor() {
    super();
    this._datasetId = null;
    this._repoRef = null;
    this._cacheUserId = null;
    this._scopeLock = getCommunityAnnotationScopeLock();
    this._lockScopeKey = null;
    this._persistenceOk = true;
    this._persistenceErrorEmittedForKey = null;
    this._integrityErrorEmittedForScopeKey = null;
    this._state = defaultState();
    this._profile = sanitizeProfile({});
    // Public profile metadata from GitHub user files (in-memory only).
    this._knownProfiles = {}; // { [usernameLower]: { displayName?, title?, orcid? } }
    // In-memory category label lookup for stable bucket keys (fieldKey + categoryLabel).
    this._categoriesByFieldKey = {}; // { [fieldKey]: string[] }
    this._saveTimer = null;
    this._loadedForKey = null;
    this._scopeLock.on('lost', (evt) => {
      try {
        const scopeKey = toCleanString(evt?.scopeKey);
        if (!scopeKey || !this._lockScopeKey) return;
        if (scopeKey !== this._lockScopeKey) return;
        this._lockScopeKey = null;
        this._persistenceOk = false;
        this.emit('lock:lost', {
          ...(evt || {}),
          datasetId: this._datasetId,
          repoRef: this._repoRef,
          userId: this._cacheUserId
        });
      } catch {
        // ignore
      }
    });
    this._ensureLoaded();
  }

  _getEffectiveUserKey() {
    const fromScope = toFileUserKeyFromId(this._cacheUserId);
    if (fromScope) return fromScope;
    const fromProfileId = toFileUserKeyFromId(this._profile?.githubUserId);
    if (fromProfileId) return fromProfileId;
    const fromProfile = normalizeUsername(this._profile?.username);
    return fromProfile || 'local';
  }

  _migrateAttribution({ fromUserKeys = [], toUserKey } = {}) {
    const to = normalizeUsername(toUserKey);
    if (!to) return false;

    const fromSet = new Set(
      (Array.isArray(fromUserKeys) ? fromUserKeys : [fromUserKeys])
        .map((u) => normalizeUsername(u))
        .filter((u) => u && u !== to)
    );
    if (!fromSet.size) return false;

    const arraysEqual = (a, b) => {
      if (a === b) return true;
      if (!Array.isArray(a) || !Array.isArray(b)) return false;
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
      }
      return true;
    };

    const shouldSwapUser = (u) => {
      const key = normalizeUsername(u);
      return key ? fromSet.has(key) : false;
    };

    let didChange = false;

    const migrateVoteArrays = (suggestion) => {
      const up = Array.isArray(suggestion?.upvotes) ? suggestion.upvotes : null;
      const down = Array.isArray(suggestion?.downvotes) ? suggestion.downvotes : null;
      if (!up && !down) return;

      const oldUp = Array.isArray(up) ? up : [];
      const oldDown = Array.isArray(down) ? down : [];

      const nextUp = uniqueStrings(
        oldUp.map((u) => (shouldSwapUser(u) ? to : normalizeUsername(u))).filter(Boolean)
      );
      const upSet = new Set(nextUp);
      const nextDown = uniqueStrings(
        oldDown
          .map((u) => (shouldSwapUser(u) ? to : normalizeUsername(u)))
          .filter((u) => u && !upSet.has(u))
      );

      if (!arraysEqual(oldUp, nextUp)) {
        suggestion.upvotes = nextUp;
        didChange = true;
      }
      if (!arraysEqual(oldDown, nextDown)) {
        suggestion.downvotes = nextDown;
        didChange = true;
      }
    };

    const migrateCommentList = (commentList) => {
      if (!Array.isArray(commentList) || !commentList.length) return;
      for (const c of commentList) {
        if (!c || typeof c !== 'object') continue;
        if (!shouldSwapUser(c.authorUsername)) continue;
        c.authorUsername = to;
        didChange = true;
      }
    };

    // Suggestions: proposedBy + attached vote/comment usernames.
    const suggestions = this._state.suggestions && typeof this._state.suggestions === 'object' ? this._state.suggestions : {};
    for (const list of Object.values(suggestions)) {
      if (!Array.isArray(list)) continue;
      for (const s of list) {
        if (!s || typeof s !== 'object') continue;
        if (shouldSwapUser(s.proposedBy)) {
          s.proposedBy = to;
          didChange = true;
        }
        migrateVoteArrays(s);
        if (Array.isArray(s.comments)) migrateCommentList(s.comments);
      }
    }

    // Local comment cache (authorUsername).
    if (this._state.myComments && typeof this._state.myComments === 'object') {
      for (const list of Object.values(this._state.myComments)) {
        migrateCommentList(list);
      }
    }

    // Moderation merges: by username.
    if (Array.isArray(this._state.moderationMerges)) {
      for (const m of this._state.moderationMerges) {
        if (!m || typeof m !== 'object') continue;
        if (!shouldSwapUser(m.by)) continue;
        m.by = to;
        didChange = true;
      }
    }

    // Known profiles cache keys.
    if (this._knownProfiles && typeof this._knownProfiles === 'object') {
      for (const from of fromSet) {
        const existing = this._knownProfiles[from];
        if (!existing || typeof existing !== 'object') continue;
        if (!this._knownProfiles[to]) {
          this._knownProfiles[to] = existing;
          didChange = true;
        }
        delete this._knownProfiles[from];
        didChange = true;
      }
    }

    return didChange;
  }

  setCacheContext({ datasetId, repoRef, userId } = {}) {
    const prevDatasetId = this._datasetId;
    const prevRepoRef = this._repoRef;
    const prevUserId = this._cacheUserId;
    const prevScopeKey = toCacheScopeKey({ datasetId: prevDatasetId, repoRef: prevRepoRef, userId: prevUserId });

    const nextDatasetId = datasetId === undefined ? this._datasetId : (toCleanString(datasetId) || null);
    const nextRepoRef = repoRef === undefined ? this._repoRef : (toCleanString(repoRef) || null);
    const nextUserId = userId === undefined ? this._cacheUserId : (normalizeGitHubUserIdOrNull(userId) || null);

    const nextScopeKey = toCacheScopeKey({ datasetId: nextDatasetId, repoRef: nextRepoRef, userId: nextUserId });
    const sameContext =
      nextDatasetId === prevDatasetId &&
      nextRepoRef === prevRepoRef &&
      nextUserId === prevUserId;
    const needsLockReacquire = Boolean(
      nextScopeKey &&
      (!this._lockScopeKey || this._lockScopeKey !== nextScopeKey || !this._scopeLock.isHolding(nextScopeKey))
    );
    const needsPersistenceRetry = this._persistenceOk === false;
    if (sameContext && !needsLockReacquire && !needsPersistenceRetry) return;

    try {
      this._saveNow?.();
    } catch {
      // ignore
    }

    // Acquire a strict cross-tab lock for the fully-scoped key (dataset + repo@branch + numeric user id).
    // If we cannot acquire it, fail closed (do not change scope) to prevent silent overwrites across tabs.
    const lockRes = this._scopeLock.setScopeKey(nextScopeKey);
    if (!lockRes?.ok) {
      // Best-effort: restore the previous lock if we were attempting a scope switch.
      let restored = false;
      if (prevScopeKey && nextScopeKey && prevScopeKey !== nextScopeKey) {
        try {
          const res = this._scopeLock.setScopeKey(prevScopeKey);
          restored = Boolean(res?.ok);
        } catch {
          restored = false;
        }
      }

      if (restored) {
        this._lockScopeKey = prevScopeKey;
        this._persistenceOk = true;
      } else {
        this._lockScopeKey = null;
        this._persistenceOk = false;
      }
      this.emit('lock:error', {
        ...(lockRes || {}),
        datasetId: nextDatasetId,
        repoRef: nextRepoRef,
        userId: nextUserId
      });
      return;
    }

    // Category label maps are dataset-specific; clear on dataset changes to avoid
    // transient incorrect bucket canonicalization when datasets share field keys.
    if (nextDatasetId !== prevDatasetId) {
      this._categoriesByFieldKey = {};
    }

    this._datasetId = nextDatasetId;
    this._repoRef = nextRepoRef;
    this._cacheUserId = nextUserId;
    this._lockScopeKey = nextScopeKey || null;
    this._persistenceOk = true;
    this._ensureLoaded();
    this.emit('context:changed', { datasetId: this._datasetId, repoRef: this._repoRef, userId: this._cacheUserId });
  }

  setDatasetId(datasetId) {
    this.setCacheContext({ datasetId });
  }

  clearLocalCache({ keepVotingMode = true } = {}) {
    try {
      if (typeof localStorage !== 'undefined') {
        const key = toSessionStorageKey({ datasetId: this._datasetId, repoRef: this._repoRef, userId: this._cacheUserId });
        if (key) localStorage.removeItem(key);
      }
    } catch {
      // ignore
    }

    const next = defaultState();
    if (keepVotingMode) {
      next.annotationFields = this._state.annotationFields.slice();
      next.profile = sanitizeProfile(this._profile);
    }
    this._state = next;
    this._profile = sanitizeProfile(next.profile);
    this._touch();
    return true;
  }

  getDatasetId() {
    return this._datasetId;
  }

  getRepoRef() {
    return this._repoRef;
  }

  getCacheUserId() {
    return this._cacheUserId;
  }

  getDatasetAccessMap() {
    return normalizeDatasetAccessMap(this._state?.datasets);
  }

  recordDatasetAccess({ datasetId, fieldsToAnnotate = [] } = {}) {
    const did = toCleanString(datasetId);
    if (!did) return false;
    if (!this._state.datasets || typeof this._state.datasets !== 'object' || Array.isArray(this._state.datasets)) {
      this._state.datasets = {};
    }
    this._state.datasets[did] = {
      fieldsToAnnotate: uniqueStrings(ensureStringArray(fieldsToAnnotate)).slice(0, 200),
      lastAccessedAt: nowIso()
    };
    if (Object.keys(this._state.datasets).length > MAX_TRACKED_DATASETS) {
      this._state.datasets = mergeDatasetAccessMaps(this._state.datasets, {});
    }
    this._touch();
    return true;
  }

  getProfile() {
    return { ...this._profile };
  }

  getKnownUserProfile(username) {
    const u = normalizeUsername(username);
    if (!u) return null;
    const p = this._knownProfiles?.[u];
    if (!p || typeof p !== 'object') return null;
    const cleaned = sanitizeKnownUserProfile(p);
    return cleaned ? { ...cleaned } : null;
  }

  formatUserAttribution(username) {
    const uRaw = toCleanString(username).replace(/^@+/, '');
    const u = normalizeUsername(uRaw);
    if (!u) return '@local';
    const prof = this.getKnownUserProfile(u);
    const parts = [];
    let handle = prof?.login ? normalizeUsername(prof.login) : u;
    // Never display GitHub numeric ids (ghid_123...) in the UI.
    if (!prof?.login && /^ghid_\d+$/i.test(handle)) handle = 'unknown';
    if (prof?.displayName) parts.push(prof.displayName);
    if (prof?.title) parts.push(prof.title);
    if (parts.length) return `@${handle} (${parts.join(', ')})`;
    return `@${handle}`;
  }

  _upsertKnownUserProfile(username, profileFields) {
    const u = normalizeUsername(username);
    if (!u) return false;
    const cleaned = sanitizeKnownUserProfile(profileFields || {});
    if (!cleaned) return false;

    if (!this._knownProfiles || typeof this._knownProfiles !== 'object') this._knownProfiles = {};
    this._knownProfiles[u] = cleaned;
    return true;
  }

  setProfile(nextProfile) {
    const next = sanitizeProfile(nextProfile || {});
    const prev = this._profile;
    if (
      prev.username === next.username &&
      prev.login === next.login &&
      prev.githubUserId === next.githubUserId &&
      prev.displayName === next.displayName &&
      prev.title === next.title &&
      prev.orcid === next.orcid &&
      prev.linkedin === next.linkedin
    ) return;

    try {
      const prevKey =
        toFileUserKeyFromId(this._cacheUserId) ||
        toFileUserKeyFromId(prev?.githubUserId) ||
        normalizeUsername(prev?.username) ||
        'local';
      const nextKey =
        toFileUserKeyFromId(this._cacheUserId) ||
        toFileUserKeyFromId(next?.githubUserId) ||
        normalizeUsername(next?.username) ||
        'local';
      if (prevKey !== nextKey && isGitHubUserKey(nextKey)) {
        const fromKeys = [prevKey];
        if (!isGitHubUserKey(prevKey)) fromKeys.push('local');
        this._migrateAttribution({ fromUserKeys: fromKeys, toUserKey: nextKey });
      }
    } catch {
      // ignore
    }

    this._upsertKnownUserProfile(next.username, next);
    this._profile = next;
    this._state.profile = sanitizeProfile(next);
    this._touch();
  }

  getAnnotatedFields() {
    return this._state.annotationFields.slice();
  }

  isFieldAnnotated(fieldKey) {
    const key = toCleanString(fieldKey);
    if (!key) return false;
    return this._state.annotationFields.includes(key);
  }

  setFieldAnnotated(fieldKey, enabled) {
    const key = toCleanString(fieldKey);
    if (!key) return false;
    const on = Boolean(enabled);
    const existing = this._state.annotationFields.includes(key);
    if (on === existing) return true;

    if (on) this._state.annotationFields.push(key);
    else this._state.annotationFields = this._state.annotationFields.filter((k) => k !== key);

    this._state.annotationFields = uniqueStrings(this._state.annotationFields);

    // Consensus settings only apply to annotatable fields; remove them when disabling.
    if (!on && this._state.annotatableSettings && typeof this._state.annotatableSettings === 'object') {
      delete this._state.annotatableSettings[key];
    }
    if (!on && this._state.closedAnnotatableFields && typeof this._state.closedAnnotatableFields === 'object') {
      delete this._state.closedAnnotatableFields[key];
    }

    this._touch();
    return true;
  }

  isFieldClosed(fieldKey) {
    const key = toCleanString(fieldKey);
    if (!key) return false;
    if (!this.isFieldAnnotated(key)) return false;
    const map = this._state?.closedAnnotatableFields;
    return Boolean(map && typeof map === 'object' && map[key] === true);
  }

  getClosedAnnotatableFields() {
    const map = this._state?.closedAnnotatableFields;
    if (!map || typeof map !== 'object') return [];
    const out = [];
    for (const [k, v] of Object.entries(map)) {
      const key = toCleanString(k);
      if (!key) continue;
      if (v === true && this.isFieldAnnotated(key)) out.push(key);
    }
    return out.sort();
  }

  setFieldClosed(fieldKey, closed) {
    const key = toCleanString(fieldKey);
    if (!key) return false;
    if (!this.isFieldAnnotated(key)) return false;
    if (!this._state.closedAnnotatableFields || typeof this._state.closedAnnotatableFields !== 'object') {
      this._state.closedAnnotatableFields = {};
    }
    const next = Boolean(closed);
    const prev = this._state.closedAnnotatableFields[key] === true;
    if (prev === next) return true;
    if (next) this._state.closedAnnotatableFields[key] = true;
    else delete this._state.closedAnnotatableFields[key];
    this._touch();
    return true;
  }

  setClosedAnnotatableFields(nextList) {
    const list = Array.isArray(nextList) ? nextList : [];
    const next = {};
    for (const k of list.slice(0, 500)) {
      const key = toCleanString(k);
      if (!key) continue;
      if (!this.isFieldAnnotated(key)) continue;
      next[key] = true;
    }
    this._state.closedAnnotatableFields = next;
    this._touch();
    return true;
  }

  getAnnotatableConsensusSettings(fieldKey) {
    const key = toCleanString(fieldKey);
    if (!key) return { minAnnotators: DEFAULT_MIN_ANNOTATORS, threshold: DEFAULT_CONSENSUS_THRESHOLD };
    const map = this._state?.annotatableSettings;
    const raw = map && typeof map === 'object' ? map[key] : null;
    return normalizeConsensusSettings(raw || {});
  }

  getAnnotatableConsensusSettingsMap() {
    const map = this._state?.annotatableSettings;
    if (!map || typeof map !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(map)) {
      const key = toCleanString(k);
      if (!key) continue;
      out[key] = normalizeConsensusSettings(v || {});
    }
    return out;
  }

  setAnnotatableConsensusSettings(fieldKey, settings) {
    const key = toCleanString(fieldKey);
    if (!key) return false;
    if (!this._state.annotatableSettings || typeof this._state.annotatableSettings !== 'object') {
      this._state.annotatableSettings = {};
    }
    this._state.annotatableSettings[key] = normalizeConsensusSettings(settings || {});
    this._touch();
    return true;
  }

  setAnnotatableConsensusSettingsMap(nextMap) {
    const input = (nextMap && typeof nextMap === 'object') ? nextMap : {};
    const out = {};
    for (const [k, v] of Object.entries(input)) {
      const key = toCleanString(k);
      if (!key) continue;
      out[key] = normalizeConsensusSettings(v || {});
    }
    this._state.annotatableSettings = out;
    this._touch();
    return true;
  }

  _resolveCategoryKey(fieldKey, catIdxOrKey) {
    const f = toCleanString(fieldKey);
    if (!f) return null;

    if (typeof catIdxOrKey === 'number' && Number.isFinite(catIdxOrKey)) {
      const idx = Math.max(0, Math.floor(catIdxOrKey));
      const categories = this._categoriesByFieldKey?.[f];
      const label = Array.isArray(categories) && categories[idx] != null ? toCleanString(categories[idx]) : '';
      return label || String(idx);
    }

    const catKey = toCleanString(catIdxOrKey);
    return catKey || null;
  }

  toBucketKey(fieldKey, catIdxOrKey) {
    const f = toCleanString(fieldKey);
    const catKey = this._resolveCategoryKey(f, catIdxOrKey);
    if (!f || !catKey) return null;
    return bucketKey(f, catKey);
  }

  _canonicalizeBucketKey(bucket) {
    const parts = parseBucketKey(bucket);
    if (!parts) return null;
    const f = toCleanString(parts.fieldKey);
    const catKeyRaw = toCleanString(parts.catKey);
    if (!f || !catKeyRaw) return null;

    // Upgrade legacy "fieldKey:<catIdx>" buckets to "fieldKey:<categoryLabel>" when possible.
    if (isNonNegativeIntegerString(catKeyRaw)) {
      const categories = this._categoriesByFieldKey?.[f];
      const idx = Math.max(0, Math.floor(Number(catKeyRaw)));
      if (Array.isArray(categories) && idx < categories.length) {
        const label = toCleanString(categories[idx]);
        if (label) return bucketKey(f, label);
      }
    }

    return bucketKey(f, catKeyRaw);
  }

  _migrateLegacyCategoryKeysForField(fieldKey) {
    const f = toCleanString(fieldKey);
    if (!f) return false;
    const categories = this._categoriesByFieldKey?.[f];
    if (!Array.isArray(categories) || !categories.length) return false;
    let didChange = false;
    const fieldPrefix = `${encodeFieldKeyForKey(f)}:`;

    // Suggestions buckets
    if (this._state.suggestions && typeof this._state.suggestions === 'object') {
      const keys = Object.keys(this._state.suggestions);
      for (const bucket of keys) {
        if (!bucket.startsWith(fieldPrefix)) continue;
        const parts = parseBucketKey(bucket);
        if (!parts || toCleanString(parts.fieldKey) !== f) continue;
        const catIdxRaw = toCleanString(parts.catKey);
        if (!isNonNegativeIntegerString(catIdxRaw)) continue;
        const idx = Math.max(0, Math.floor(Number(catIdxRaw)));
        if (!Number.isInteger(idx) || idx >= categories.length) continue;
        const label = toCleanString(categories[idx]);
        if (!label) continue;
        const nextBucket = bucketKey(f, label);
        if (nextBucket === bucket) continue;

        const incoming = Array.isArray(this._state.suggestions[bucket]) ? this._state.suggestions[bucket] : [];
        const existing = Array.isArray(this._state.suggestions[nextBucket]) ? this._state.suggestions[nextBucket] : [];
        const merged = existing.concat(incoming);
        const seen = new Set();
        const out = [];
        for (const s of merged) {
          const sid = toCleanString(s?.id);
          if (sid) {
            if (seen.has(sid)) continue;
            seen.add(sid);
          }
          out.push(s);
          if (out.length >= MAX_SUGGESTIONS_PER_CLUSTER) break;
        }
        this._state.suggestions[nextBucket] = out;
        delete this._state.suggestions[bucket];
        didChange = true;
      }
    }

    // Deleted suggestion markers
    if (this._state.deletedSuggestions && typeof this._state.deletedSuggestions === 'object') {
      const keys = Object.keys(this._state.deletedSuggestions);
      for (const bucket of keys) {
        if (!bucket.startsWith(fieldPrefix)) continue;
        const parts = parseBucketKey(bucket);
        if (!parts || toCleanString(parts.fieldKey) !== f) continue;
        const catIdxRaw = toCleanString(parts.catKey);
        if (!isNonNegativeIntegerString(catIdxRaw)) continue;
        const idx = Math.max(0, Math.floor(Number(catIdxRaw)));
        if (!Number.isInteger(idx) || idx >= categories.length) continue;
        const label = toCleanString(categories[idx]);
        if (!label) continue;
        const nextBucket = bucketKey(f, label);
        if (nextBucket === bucket) continue;

        const incoming = Array.isArray(this._state.deletedSuggestions[bucket]) ? this._state.deletedSuggestions[bucket] : [];
        const existing = Array.isArray(this._state.deletedSuggestions[nextBucket]) ? this._state.deletedSuggestions[nextBucket] : [];
        const merged = uniqueStrings(existing.concat(incoming).map((x) => toCleanString(x)).filter(Boolean)).slice(0, 5000);
        if (merged.length) this._state.deletedSuggestions[nextBucket] = merged;
        else delete this._state.deletedSuggestions[nextBucket];
        delete this._state.deletedSuggestions[bucket];
        didChange = true;
      }
    }

    // Local vote keys
    if (this._state.myVotes && typeof this._state.myVotes === 'object') {
      const keys = Object.keys(this._state.myVotes);
      for (const k of keys) {
        const parsed = parseVoteKey(k);
        if (!parsed || toCleanString(parsed.fieldKey) !== f) continue;
        const catIdxRaw = toCleanString(parsed.catKey);
        if (!isNonNegativeIntegerString(catIdxRaw)) continue;
        const idx = Math.max(0, Math.floor(Number(catIdxRaw)));
        if (!Number.isInteger(idx) || idx >= categories.length) continue;
        const label = toCleanString(categories[idx]);
        if (!label) continue;
        const nextKey = suggestionKey(f, label, parsed.suggestionId);
        if (nextKey === k) continue;
        if (this._state.myVotes[nextKey] !== 'up' && this._state.myVotes[nextKey] !== 'down') {
          this._state.myVotes[nextKey] = this._state.myVotes[k];
        }
        delete this._state.myVotes[k];
        didChange = true;
      }
    }

    // Moderation merges buckets
    if (Array.isArray(this._state.moderationMerges)) {
      let didChangeMerges = false;
      const cleaned = [];
      for (const m of this._state.moderationMerges.slice(0, 5000)) {
        const normalized = normalizeModerationMerge(m);
        if (!normalized) continue;
        const parts = parseBucketKey(normalized.bucket);
        if (parts && toCleanString(parts.fieldKey) === f) {
          const catIdxRaw = toCleanString(parts.catKey);
          if (isNonNegativeIntegerString(catIdxRaw)) {
            const idx = Math.max(0, Math.floor(Number(catIdxRaw)));
            if (Number.isInteger(idx) && idx < categories.length) {
              const label = toCleanString(categories[idx]);
              if (label) {
                const nextBucket = bucketKey(f, label);
                if (nextBucket !== normalized.bucket) {
                  normalized.bucket = nextBucket;
                  didChangeMerges = true;
                }
              }
            }
          }
        }
        cleaned.push(normalized);
      }
      if (didChangeMerges) {
        this._state.moderationMerges = compactModerationMerges(cleaned);
        didChange = true;
      }
    }

    return didChange;
  }

  setFieldCategories(fieldKey, categories) {
    const f = toCleanString(fieldKey);
    const list = Array.isArray(categories) ? categories : null;
    if (!f || !list) return false;

    const cleaned = [];
    for (let i = 0; i < list.length; i++) {
      const label = toCleanString(list[i]);
      cleaned.push(label || `Category ${i}`);
      if (cleaned.length >= 200000) break;
    }

    const prev = this._categoriesByFieldKey?.[f];
    const same =
      Array.isArray(prev) &&
      prev.length === cleaned.length &&
      prev.every((v, i) => v === cleaned[i]);
    if (!same) this._categoriesByFieldKey[f] = cleaned;

    const migrated = this._migrateLegacyCategoryKeysForField(f);
    if (migrated) this._touch();
    return true;
  }

  /**
   * @returns {any[]} suggestions (cloned)
   */
  getSuggestions(fieldKey, catIdx) {
    const f = toCleanString(fieldKey);
    const catKey = this._resolveCategoryKey(f, catIdx);
    if (!f || !catKey) return [];
    const key = bucketKey(f, catKey);
    const list = this._state.suggestions[key] || [];
    const merged = this._applyModerationMergesForBucket(key, list);
    return merged.map((s) => {
      const mergedFrom = Array.isArray(s?.mergedFrom) ? s.mergedFrom : [];
      return {
        ...s,
        upvotes: Array.isArray(s.upvotes) ? s.upvotes.slice() : [],
        downvotes: Array.isArray(s.downvotes) ? s.downvotes.slice() : [],
        comments: Array.isArray(s.comments) ? s.comments.map((c) => ({ ...(c || {}) })) : [],
        mergedFrom: mergedFrom.map((m) => ({
          ...(m || {}),
          upvotes: Array.isArray(m?.upvotes) ? m.upvotes.slice() : [],
          downvotes: Array.isArray(m?.downvotes) ? m.downvotes.slice() : [],
          comments: Array.isArray(m?.comments) ? m.comments.map((c) => ({ ...(c || {}) })) : []
        }))
      };
    });
  }

  _applyModerationMergesForBucket(bucket, suggestionsList) {
    const merges = Array.isArray(this._state.moderationMerges) ? this._state.moderationMerges : [];
    const bucketClean = toCleanString(bucket);
    if (!bucketClean || !merges.length) return Array.isArray(suggestionsList) ? suggestionsList : [];

    const fromTo = buildEffectiveModerationMergeMapForBucket(merges, bucketClean);
    if (!fromTo.size) return Array.isArray(suggestionsList) ? suggestionsList : [];

    const byId = new Map();
    for (const s of Array.isArray(suggestionsList) ? suggestionsList : []) {
      const id = toCleanString(s?.id);
      if (!id) continue;
      const up = uniqueStrings(ensureStringArray(s?.upvotes).map((u) => normalizeUsername(u)).filter(Boolean));
      const upSet = new Set(up);
      const down = uniqueStrings(
        ensureStringArray(s?.downvotes)
          .map((u) => normalizeUsername(u))
          .filter((u) => u && !upSet.has(u))
      );
      byId.set(id, {
        ...s,
        upvotes: up,
        downvotes: down,
        comments: Array.isArray(s.comments) ? s.comments : []
      });
    }

    // Group by resolved merge target and compute:
    // - Bundle vote totals (de-duplicated per user across the bundle)
    // - A non-destructive "mergedFrom" list so original per-suggestion votes/comments remain visible
    const targetForId = new Map();
    /** @type {Map<string, string[]>} */
    const groups = new Map();
    for (const id of byId.keys()) {
      const resolved = resolveMergeTarget(id, fromTo) || id;
      const targetId = byId.has(resolved) ? resolved : id;
      targetForId.set(id, targetId);
      if (!groups.has(targetId)) groups.set(targetId, []);
      groups.get(targetId).push(id);
    }

    for (const [targetId, memberIds] of groups.entries()) {
      if (!targetId || !Array.isArray(memberIds) || memberIds.length <= 1) continue;
      const target = byId.get(targetId);
      if (!target) continue;

      const mergedIds = memberIds.filter((id) => id && id !== targetId);
      /** @type {any[]} */
      const mergedFrom = [];
      for (const mid of mergedIds) {
        const m = byId.get(mid);
        if (!m) continue;
        mergedFrom.push({
          ...m,
          upvotes: Array.isArray(m.upvotes) ? m.upvotes.slice() : [],
          downvotes: Array.isArray(m.downvotes) ? m.downvotes.slice() : [],
          comments: Array.isArray(m.comments) ? m.comments.slice() : []
        });
      }
      mergedFrom.sort((a, b) => {
        const an = (a?.upvotes?.length || 0) - (a?.downvotes?.length || 0);
        const bn = (b?.upvotes?.length || 0) - (b?.downvotes?.length || 0);
        if (bn !== an) return bn - an;
        return toCleanString(a?.label || '').localeCompare(toCleanString(b?.label || ''));
      });
      target.mergedFrom = mergedFrom;

      // Aggregate votes across the bundle (de-duplicated per user).
      // Per-user effective vote rule:
      // - If the user voted the bundle main suggestion (the merge target), that vote wins.
      // - Else, delegate from votes on merged members by majority (ties => no vote).
      /** @type {Map<string, {targetVote: 'up'|'down'|null, up: number, down: number}>} */
      const perUser = new Map();
      const ensure = (u) => {
        const key = toCleanString(u);
        if (!key) return null;
        if (!perUser.has(key)) perUser.set(key, { targetVote: null, up: 0, down: 0 });
        return perUser.get(key);
      };
      for (const mid of memberIds) {
        const m = byId.get(mid);
        if (!m) continue;
        const isTarget = toCleanString(mid) === toCleanString(targetId);
        for (const u of Array.isArray(m.upvotes) ? m.upvotes : []) {
          const entry = ensure(u);
          if (!entry) continue;
          if (isTarget) entry.targetVote = 'up';
          else entry.up++;
        }
        for (const u of Array.isArray(m.downvotes) ? m.downvotes : []) {
          const entry = ensure(u);
          if (!entry) continue;
          if (isTarget) entry.targetVote = 'down';
          else entry.down++;
        }
      }
      const upSet = new Set();
      const downSet = new Set();
      for (const [u, entry] of perUser.entries()) {
        if (entry.targetVote === 'up') {
          upSet.add(u);
          continue;
        }
        if (entry.targetVote === 'down') {
          downSet.add(u);
          continue;
        }
        if (entry.up > entry.down) upSet.add(u);
        else if (entry.down > entry.up) downSet.add(u);
      }
      target.upvotes = uniqueStrings([...upSet]);
      target.downvotes = uniqueStrings([...downSet]);
    }

    const out = [];
    for (const [id, s] of byId.entries()) {
      if ((targetForId.get(id) || id) !== id) continue;
      out.push(s);
    }
    out.sort((a, b) => ((b.upvotes?.length || 0) - (b.downvotes?.length || 0)) - ((a.upvotes?.length || 0) - (a.downvotes?.length || 0)));
    return out;
  }

  addSuggestion(fieldKey, catIdx, { label, ontologyId = null, evidence = null, markers = null } = {}) {
    const f = toCleanString(fieldKey);
    if (!f) throw new Error('[CommunityAnnotationSession] fieldKey required');

    const catKey = this._resolveCategoryKey(f, catIdx);
    if (!catKey) throw new Error('[CommunityAnnotationSession] category required');

    const key = bucketKey(f, catKey);
    const labelNormalized = normalizeLabelForCompare(label);
    if (labelNormalized) {
      const existing = this._state.suggestions?.[key] || [];
      const visible = this._applyModerationMergesForBucket(key, existing);
      for (const s of visible) {
        if (!s) continue;
        if (normalizeLabelForCompare(s.label) === labelNormalized) {
          throw new Error('[CommunityAnnotationSession] suggestion already exists for this label');
        }
      }
    }

    const suggestion = normalizeSuggestion(
      { label, ontologyId, evidence, markers },
      { proposedBy: this._getEffectiveUserKey() }
    );
    if (!suggestion) throw new Error('[CommunityAnnotationSession] label required');

    if (!this._state.suggestions[key]) this._state.suggestions[key] = [];
    if (this._state.suggestions[key].length >= MAX_SUGGESTIONS_PER_CLUSTER) {
      throw new Error('[CommunityAnnotationSession] too many suggestions for this cluster');
    }

    // Auto-upvote by proposer
    const myUserKey = this._getEffectiveUserKey();
    suggestion.upvotes = uniqueStrings([myUserKey, ...suggestion.upvotes]);
    suggestion.downvotes = suggestion.downvotes.filter((u) => normalizeUsername(u) !== normalizeUsername(myUserKey));
    this._state.myVotes[suggestionKey(f, catKey, suggestion.id)] = 'up';

    this._state.suggestions[key].push(suggestion);
    this._touch();
    return suggestion.id;
  }

  editMySuggestion(fieldKey, catIdx, suggestionId, { label, ontologyId, evidence, markers } = {}) {
    const f = toCleanString(fieldKey);
    const id = toCleanString(suggestionId);
    const my = normalizeUsername(this._getEffectiveUserKey());
    if (!f) throw new Error('[CommunityAnnotationSession] fieldKey required');
    if (!id) throw new Error('[CommunityAnnotationSession] suggestionId required');
    if (!my) throw new Error('[CommunityAnnotationSession] username required');

    const catKey = this._resolveCategoryKey(f, catIdx);
    if (!catKey) throw new Error('[CommunityAnnotationSession] category required');

    const bucket = bucketKey(f, catKey);
    const list = this._state.suggestions?.[bucket] || [];
    const suggestion = list.find((x) => x && toCleanString(x.id) === id) || null;
    if (!suggestion) throw new Error('[CommunityAnnotationSession] suggestion not found');
    if (normalizeUsername(suggestion.proposedBy) !== my) {
      throw new Error('[CommunityAnnotationSession] cannot edit a suggestion you did not propose');
    }

    let didUpdate = false;

    if (label !== undefined) {
      const nextLabel = clampLen(label, MAX_LABEL_LEN);
      if (!nextLabel) throw new Error('[CommunityAnnotationSession] label required');
      const nextNorm = normalizeLabelForCompare(nextLabel);
      if (nextNorm) {
        const visible = this._applyModerationMergesForBucket(bucket, list);
        for (const s of visible) {
          if (!s) continue;
          const sid = toCleanString(s.id);
          if (!sid || sid === id) continue;
          if (normalizeLabelForCompare(s.label) === nextNorm) {
            throw new Error('[CommunityAnnotationSession] suggestion already exists for this label');
          }
        }
      }
      if (suggestion.label !== nextLabel) {
        suggestion.label = nextLabel;
        didUpdate = true;
      }
    }

    if (ontologyId !== undefined) {
      const next = clampLen(ontologyId, MAX_ONTOLOGY_LEN);
      const nextValue = next ? next : null;
      if ((suggestion.ontologyId ?? null) !== nextValue) {
        suggestion.ontologyId = nextValue;
        didUpdate = true;
      }
    }

    if (evidence !== undefined) {
      const next = clampLen(evidence, MAX_EVIDENCE_LEN);
      const nextValue = next ? next : null;
      if ((suggestion.evidence ?? null) !== nextValue) {
        suggestion.evidence = nextValue;
        didUpdate = true;
      }
    }

    if (markers !== undefined) {
      const nextMarkers = normalizeMarkers(markers);
      const currentSerialized = (() => {
        try { return JSON.stringify(suggestion.markers ?? null); } catch { return null; }
      })();
      const nextSerialized = (() => {
        try { return JSON.stringify(nextMarkers ?? null); } catch { return null; }
      })();
      if (currentSerialized !== nextSerialized) {
        suggestion.markers = nextMarkers;
        didUpdate = true;
      }
    }

    if (!didUpdate) return true;

    suggestion.editedAt = nowIso();
    this._touch();
    return true;
  }

  deleteMySuggestion(fieldKey, catIdx, suggestionId) {
    const f = toCleanString(fieldKey);
    const id = toCleanString(suggestionId);
    const my = normalizeUsername(this._getEffectiveUserKey());
    if (!f || !id || !my) return false;
    const catKey = this._resolveCategoryKey(f, catIdx);
    if (!catKey) return false;

    const bucket = bucketKey(f, catKey);
    const list = this._state.suggestions?.[bucket] || [];
    const s = list.find((x) => x && toCleanString(x.id) === id) || null;
    const proposer = normalizeUsername(s?.proposedBy || '');
    if (!s || !proposer || proposer !== my) return false;

    // If the user deletes a suggestion that participates in moderation merges, detach the whole
    // merge chain that ultimately resolves to this id (and any merges where this id is a node).
    // This ensures merged items re-appear as independent suggestions after deletion.
    const merges = Array.isArray(this._state.moderationMerges) ? this._state.moderationMerges : [];
    if (merges.length) {
      const fromTo = buildEffectiveModerationMergeMapForBucket(merges, bucket);
      if (fromTo.size) {
        this._state.moderationMerges = merges.filter((mRaw) => {
          const m = normalizeModerationMerge(mRaw);
          if (!m) return false;
          if (m.bucket !== bucket) return true;
          if (m.fromSuggestionId === id || m.intoSuggestionId === id) return false;
          const resolved = resolveMergeTarget(m.fromSuggestionId, fromTo);
          return resolved !== id;
        });
      }
    }

    if (!this._state.deletedSuggestions || typeof this._state.deletedSuggestions !== 'object') this._state.deletedSuggestions = {};
    const existing = Array.isArray(this._state.deletedSuggestions[bucket]) ? this._state.deletedSuggestions[bucket] : [];
    this._state.deletedSuggestions[bucket] = uniqueStrings(existing.concat([id])).slice(0, 5000);

    this._state.suggestions[bucket] = list.filter((x) => toCleanString(x?.id) !== id);

    // Remove my local vote + comments for this suggestion.
    const voteKey = suggestionKey(f, catKey, id);
    if (this._state.myVotes?.[voteKey]) delete this._state.myVotes[voteKey];
    if (this._state.myComments?.[id]) delete this._state.myComments[id];

    this._touch();
    return true;
  }

  vote(fieldKey, catIdx, suggestionId, direction) {
    const f = toCleanString(fieldKey);
    const id = toCleanString(suggestionId);
    const dir = direction === 'down' ? 'down' : 'up';
    const username = normalizeUsername(this._getEffectiveUserKey());
    if (!f || !id || !username) return false;
    const catKey = this._resolveCategoryKey(f, catIdx);
    if (!catKey) return false;

    const key = bucketKey(f, catKey);
    const list = this._state.suggestions[key] || [];
    const suggestion = list.find((s) => s?.id === id) || null;
    if (!suggestion) return false;

    // Per-suggestion voting: allow users to vote independently on merged bundle members.
    // The merged bundle totals are de-duplicated at read/render time.
    const directKey = suggestionKey(f, catKey, id);
    const current = this._state.myVotes?.[directKey] || null;
    const next = current === dir ? null : dir;

    // Remove this user's vote from this suggestion only, then apply the new one (if any).
    suggestion.upvotes = uniqueStrings((suggestion.upvotes || []).filter((u) => normalizeUsername(u) !== username));
    suggestion.downvotes = uniqueStrings((suggestion.downvotes || []).filter((u) => normalizeUsername(u) !== username));
    if (next === 'up') suggestion.upvotes = uniqueStrings([username, ...suggestion.upvotes]);
    if (next === 'down') suggestion.downvotes = uniqueStrings([username, ...suggestion.downvotes]);

    if (next) this._state.myVotes[directKey] = next;
    else if (this._state.myVotes?.[directKey]) delete this._state.myVotes[directKey];

    this._touch();
    return true;
  }

  getMyVoteDirect(fieldKey, catIdx, suggestionId) {
    const f = toCleanString(fieldKey);
    const sid = toCleanString(suggestionId);
    if (!f || !sid) return null;
    const catKey = this._resolveCategoryKey(f, catIdx);
    if (!catKey) return null;
    const directKey = suggestionKey(f, catKey, sid);
    const direct = this._state.myVotes?.[directKey] || null;
    if (direct === 'up' || direct === 'down') return direct;
    return null;
  }

  /**
   * Effective bundle-main vote display helper.
   * Rules:
   * - If you voted the merge target directly, that wins.
   * - Else, delegate from votes on merged members by majority (ties => no vote).
   * @returns {{vote: 'up'|'down'|null, source: 'direct'|'delegated'|'none', delegatedUp: number, delegatedDown: number}}
   */
  getMyBundleVoteInfo(fieldKey, catIdx, suggestionId) {
    const f = toCleanString(fieldKey);
    const sid = toCleanString(suggestionId);
    if (!f || !sid) return { vote: null, source: 'none', delegatedUp: 0, delegatedDown: 0 };
    const catKey = this._resolveCategoryKey(f, catIdx);
    if (!catKey) return { vote: null, source: 'none', delegatedUp: 0, delegatedDown: 0 };

    const direct = this.getMyVoteDirect(f, catKey, sid);
    if (direct) return { vote: direct, source: 'direct', delegatedUp: 0, delegatedDown: 0 };

    const bucket = bucketKey(f, catKey);
    const list = this._state.suggestions?.[bucket] || [];
    const merges = Array.isArray(this._state.moderationMerges) ? this._state.moderationMerges : [];
    const map = buildEffectiveModerationMergeMapForBucket(merges, bucket);
    if (!map.size) return { vote: null, source: 'none', delegatedUp: 0, delegatedDown: 0 };

    const targetId = resolveMergeTarget(sid, map) || sid;
    // Delegate only on the merge target (bundle-main) card.
    if (targetId !== sid) return { vote: null, source: 'none', delegatedUp: 0, delegatedDown: 0 };

    const familyOtherIds = [];
    for (const s of Array.isArray(list) ? list : []) {
      const id = toCleanString(s?.id);
      if (!id || id === sid) continue;
      const resolved = resolveMergeTarget(id, map) || id;
      if (resolved === targetId) familyOtherIds.push(id);
    }
    if (!familyOtherIds.length) return { vote: null, source: 'none', delegatedUp: 0, delegatedDown: 0 };

    let delegatedUp = 0;
    let delegatedDown = 0;
    for (const oid of uniqueStrings(familyOtherIds)) {
      const k = suggestionKey(f, catKey, oid);
      const v = this._state.myVotes?.[k] || null;
      if (v === 'up') delegatedUp++;
      else if (v === 'down') delegatedDown++;
    }
    if (delegatedUp > delegatedDown) return { vote: 'up', source: 'delegated', delegatedUp, delegatedDown };
    if (delegatedDown > delegatedUp) return { vote: 'down', source: 'delegated', delegatedUp, delegatedDown };
    return { vote: null, source: 'none', delegatedUp, delegatedDown };
  }

  getMyVote(fieldKey, catIdx, suggestionId) {
    return this.getMyVoteDirect(fieldKey, catIdx, suggestionId);
  }

  addComment(fieldKey, catIdx, suggestionId, text) {
    const f = toCleanString(fieldKey);
    const sid = toCleanString(suggestionId);
    const trimmedText = toCleanString(text);
    if (!f || !sid || !trimmedText) return null;
    const catKey = this._resolveCategoryKey(f, catIdx);
    if (!catKey) return null;

    const key = bucketKey(f, catKey);
    const list = this._state.suggestions[key] || [];
    let suggestion = list.find((s) => s?.id === sid) || null;
    let storeSid = sid;
    if (!suggestion) {
      const merges = Array.isArray(this._state.moderationMerges) ? this._state.moderationMerges : [];
      const map = buildEffectiveModerationMergeMapForBucket(merges, key);
      if (map.size) {
        const target = resolveMergeTarget(sid, map) || sid;
        suggestion = list.find((s) => s?.id === target) || null;
        storeSid = target;
      }
    }
    if (!suggestion) return null;

    if (!Array.isArray(suggestion.comments)) suggestion.comments = [];
    if (suggestion.comments.length >= MAX_COMMENTS_PER_SUGGESTION) return null;

    const comment = normalizeComment({ text: trimmedText }, { authorUsername: this._getEffectiveUserKey() });
    if (!comment) return null;

    suggestion.comments.push(comment);

    if (!this._state.myComments) this._state.myComments = {};
    if (!this._state.myComments[storeSid]) this._state.myComments[storeSid] = [];
    this._state.myComments[storeSid].push(comment);

    this._touch();
    return comment.id;
  }

  editComment(fieldKey, catIdx, suggestionId, commentId, newText) {
    const f = toCleanString(fieldKey);
    const sid = toCleanString(suggestionId);
    const cid = toCleanString(commentId);
    const trimmedText = toCleanString(newText);
    if (!f || !sid || !cid || !trimmedText) return false;
    const catKey = this._resolveCategoryKey(f, catIdx);
    if (!catKey) return false;

    const key = bucketKey(f, catKey);
    const list = this._state.suggestions[key] || [];
    const merges = Array.isArray(this._state.moderationMerges) ? this._state.moderationMerges : [];
    const map = buildEffectiveModerationMergeMapForBucket(merges, key);
    const target = map.size ? (resolveMergeTarget(sid, map) || sid) : sid;

    let owningSid = null;
    let comment = null;
    for (const s of list) {
      const sId = toCleanString(s?.id);
      if (!sId) continue;
      const t = map.size ? (resolveMergeTarget(sId, map) || sId) : sId;
      if (t !== target) continue;
      if (!Array.isArray(s.comments)) continue;
      const found = s.comments.find((c) => toCleanString(c?.id) === cid) || null;
      if (!found) continue;
      owningSid = sId;
      comment = found;
      break;
    }
    if (!comment || !owningSid) return false;
    if (!this.isMyComment(comment.authorUsername)) return false;

    comment.text = clampLen(trimmedText, MAX_COMMENT_LEN);
    comment.editedAt = nowIso();

    if (this._state.myComments?.[owningSid]) {
      const myComment = this._state.myComments[owningSid].find((c) => c?.id === cid);
      if (myComment) {
        myComment.text = comment.text;
        myComment.editedAt = comment.editedAt;
      }
    }

    this._touch();
    return true;
  }

  deleteComment(fieldKey, catIdx, suggestionId, commentId) {
    const f = toCleanString(fieldKey);
    const sid = toCleanString(suggestionId);
    const cid = toCleanString(commentId);
    if (!f || !sid || !cid) return false;
    const catKey = this._resolveCategoryKey(f, catIdx);
    if (!catKey) return false;

    const key = bucketKey(f, catKey);
    const list = this._state.suggestions[key] || [];
    const merges = Array.isArray(this._state.moderationMerges) ? this._state.moderationMerges : [];
    const map = buildEffectiveModerationMergeMapForBucket(merges, key);
    const target = map.size ? (resolveMergeTarget(sid, map) || sid) : sid;

    let owningSid = null;
    let owningSuggestion = null;
    let commentIndex = -1;
    for (const s of list) {
      const sId = toCleanString(s?.id);
      if (!sId) continue;
      const t = map.size ? (resolveMergeTarget(sId, map) || sId) : sId;
      if (t !== target) continue;
      if (!Array.isArray(s.comments)) continue;
      const idxFound = s.comments.findIndex((c) => toCleanString(c?.id) === cid);
      if (idxFound < 0) continue;
      owningSid = sId;
      owningSuggestion = s;
      commentIndex = idxFound;
      break;
    }
    if (!owningSuggestion || commentIndex < 0 || !owningSid) return false;
    const comment = owningSuggestion.comments[commentIndex];
    if (!this.isMyComment(comment.authorUsername)) return false;

    owningSuggestion.comments.splice(commentIndex, 1);

    if (this._state.myComments?.[owningSid]) {
      this._state.myComments[owningSid] = this._state.myComments[owningSid].filter((c) => c?.id !== cid);
      if (this._state.myComments[owningSid].length === 0) delete this._state.myComments[owningSid];
    }

    this._touch();
    return true;
  }

  getComments(fieldKey, catIdx, suggestionId) {
    const f = toCleanString(fieldKey);
    const sid = toCleanString(suggestionId);
    if (!f || !sid) return [];
    const catKey = this._resolveCategoryKey(f, catIdx);
    if (!catKey) return [];

    const key = bucketKey(f, catKey);
    const list = this._state.suggestions[key] || [];
    const suggestion = list.find((s) => toCleanString(s?.id) === sid) || null;
    if (!suggestion || !Array.isArray(suggestion.comments)) return [];
    return suggestion.comments.map((c) => ({ ...(c || {}) }));
  }

  isMyComment(authorUsername) {
    const myUsername = normalizeUsername(this._getEffectiveUserKey());
    const author = normalizeUsername(authorUsername);
    return myUsername && author && myUsername === author;
  }

  setModerationMergesFromDoc(doc) {
    const merges = Array.isArray(doc?.merges) ? doc.merges : [];
    const cleaned = [];
    for (const m of merges.slice(0, 5000)) {
      const normalized = normalizeModerationMerge(m);
      if (!normalized) continue;
      const canonicalBucket = this._canonicalizeBucketKey(normalized.bucket);
      if (canonicalBucket) normalized.bucket = canonicalBucket;
      cleaned.push(normalized);
    }
    this._state.moderationMerges = compactModerationMerges(cleaned);
    // Votes/comments are auto-combined at runtime from the merge mapping.
    this._touch();
    return true;
  }

  getModerationMerges() {
    return Array.isArray(this._state.moderationMerges) ? this._state.moderationMerges.map((m) => ({ ...m })) : [];
  }

  addModerationMerge({ fieldKey, catIdx, fromSuggestionId, intoSuggestionId, note = null } = {}) {
    const f = toCleanString(fieldKey);
    const catKey = this._resolveCategoryKey(f, catIdx);
    const bucket = catKey ? bucketKey(f, catKey) : '';
    const entry = normalizeModerationMerge({
      bucket,
      fromSuggestionId,
      intoSuggestionId,
      by: this._getEffectiveUserKey(),
      at: nowIso(),
      note
    });
    if (!entry) return false;
    if (!Array.isArray(this._state.moderationMerges)) this._state.moderationMerges = [];
    // Keep moderation merges as the current effective mapping:
    // a "from" suggestion can only be merged into one "into" suggestion at a time.
    this._state.moderationMerges = this._state.moderationMerges.filter((mRaw) => {
      const m = normalizeModerationMerge(mRaw);
      if (!m) return false;
      if (m.bucket !== entry.bucket) return true;
      return m.fromSuggestionId !== entry.fromSuggestionId;
    });
    this._state.moderationMerges.push(entry);
    this._state.moderationMerges = this._state.moderationMerges.slice(0, 5000);
    // Votes/comments are auto-combined at runtime from the merge mapping.
    this._touch();
    return true;
  }

  editModerationMergeNote({ fieldKey, catIdx, fromSuggestionId, note = null } = {}) {
    const f = toCleanString(fieldKey);
    const catKey = this._resolveCategoryKey(f, catIdx);
    const bucket = catKey ? bucketKey(f, catKey) : '';
    const from = toCleanString(fromSuggestionId);
    if (!bucket || !from) return false;

    const merges = Array.isArray(this._state.moderationMerges) ? this._state.moderationMerges : [];
    if (!merges.length) return false;

    const nextNote = clampLen(note, MAX_MERGE_NOTE_LEN) || null;

    const cleaned = [];
    let didUpdate = false;
    for (const mRaw of merges) {
      const m = normalizeModerationMerge(mRaw);
      if (!m) continue;
      if (m.bucket !== bucket || m.fromSuggestionId !== from) {
        cleaned.push(m);
        continue;
      }
      if (!this.isMyComment(m.by)) {
        cleaned.push(m);
        continue;
      }

      const prevNote = clampLen(m?.note, MAX_MERGE_NOTE_LEN) || null;
      if (toCleanString(prevNote || '') === toCleanString(nextNote || '')) {
        cleaned.push(m);
        continue;
      }

      const updated = normalizeModerationMerge({ ...m, note: nextNote, editedAt: nowIso() });
      cleaned.push(updated || m);
      didUpdate = true;
    }
    if (!didUpdate) return false;
    this._state.moderationMerges = compactModerationMerges(cleaned);
    this._touch();
    return true;
  }

  detachModerationMerge({ fieldKey, catIdx, fromSuggestionId } = {}) {
    const f = toCleanString(fieldKey);
    const catKey = this._resolveCategoryKey(f, catIdx);
    const bucket = catKey ? bucketKey(f, catKey) : '';
    const from = toCleanString(fromSuggestionId);
    if (!bucket || !from) return false;
    const merges = Array.isArray(this._state.moderationMerges) ? this._state.moderationMerges : [];
    if (!merges.length) return false;

    const before = merges.length;
    const next = merges.filter((mRaw) => {
      const m = normalizeModerationMerge(mRaw);
      if (!m) return false;
      if (m.bucket !== bucket) return true;
      return m.fromSuggestionId !== from;
    });
    if (next.length === before) return false;
    this._state.moderationMerges = next;
    this._touch();
    return true;
  }

  detachLastModerationMerge({ fieldKey, catIdx, intoSuggestionId = null } = {}) {
    const f = toCleanString(fieldKey);
    const catKey = this._resolveCategoryKey(f, catIdx);
    const bucket = catKey ? bucketKey(f, catKey) : '';
    if (!bucket) return false;
    const merges = Array.isArray(this._state.moderationMerges) ? this._state.moderationMerges : [];
    if (!merges.length) return false;

    const map = buildEffectiveModerationMergeMapForBucket(merges, bucket);
    const target = intoSuggestionId ? (resolveMergeTarget(intoSuggestionId, map) || toCleanString(intoSuggestionId)) : null;

    let best = null;
    for (const mRaw of merges) {
      const m = normalizeModerationMerge(mRaw);
      if (!m || m.bucket !== bucket) continue;
      const fromId = toCleanString(m.fromSuggestionId);
      if (!fromId) continue;
      const resolved = resolveMergeTarget(fromId, map) || fromId;
      if (target && resolved !== target) continue;
      const at = toCleanString(m.at || '');
      if (!best) {
        best = { fromId, at };
        continue;
      }
      if (at && best.at) {
        if (at > best.at) best = { fromId, at };
      } else if (at && !best.at) {
        best = { fromId, at };
      } else if (!at && !best.at) {
        // no timestamps: keep last encountered
        best = { fromId, at };
      }
    }
    if (!best?.fromId) return false;
    return this.detachModerationMerge({ fieldKey: f, catIdx: catKey, fromSuggestionId: best.fromId });
  }

  buildModerationMergesDocument() {
    return {
      version: 1,
      updatedAt: nowIso(),
      merges: this.getModerationMerges()
    };
  }

  // Note: Votes/comments are not stored in merge records.
  // The merge mapping only stores which suggestion was merged into which.

  /**
   * Compute consensus for a field/category bucket.
   * @returns {{status:'pending'|'disputed'|'consensus', label:string|null, confidence:number, voters:number, netVotes:number, suggestionId:string|null}}
   */
  computeConsensus(fieldKey, catIdx, { minAnnotators = DEFAULT_MIN_ANNOTATORS, threshold = DEFAULT_CONSENSUS_THRESHOLD } = {}) {
    const f = toCleanString(fieldKey);
    const catKey = this._resolveCategoryKey(f, catIdx);
    if (!f || !catKey) {
      return { status: 'pending', label: null, confidence: 0, voters: 0, netVotes: 0, suggestionId: null };
    }
    const key = bucketKey(f, catKey);
    const list = this._applyModerationMergesForBucket(key, this._state.suggestions[key] || []);
    if (!list.length) {
      return { status: 'pending', label: null, confidence: 0, voters: 0, netVotes: 0, suggestionId: null };
    }

    let best = null;
    let bestNet = null;
    let bestUp = null;
    /** @type {any[]} */
    const bestSuggestions = [];
    for (const s of list) {
      const up = Array.isArray(s.upvotes) ? s.upvotes.length : 0;
      const down = Array.isArray(s.downvotes) ? s.downvotes.length : 0;
      const net = up - down;
      if (bestNet == null || net > bestNet || (net === bestNet && bestUp != null && up > bestUp)) {
        bestNet = net;
        bestUp = up;
        best = { suggestion: s, netVotes: net, up, down };
        bestSuggestions.length = 0;
        bestSuggestions.push(s);
      } else if (net === bestNet) {
        bestSuggestions.push(s);
      }
    }

    const labelParts = [];
    const seen = new Set();
    for (const s of bestSuggestions) {
      const label = toCleanString(s?.label || '');
      if (!label || seen.has(label)) continue;
      seen.add(label);
      labelParts.push(label);
      if (labelParts.length >= 6) break;
    }
    const bestLabel = labelParts.length ? labelParts.join(', ') : (best?.suggestion?.label || null);
    const isTie = bestSuggestions.length > 1;

    const votersSet = new Set();
    for (const s of list) {
      for (const u of ensureStringArray(s.upvotes)) votersSet.add(u);
      for (const u of ensureStringArray(s.downvotes)) votersSet.add(u);
    }

    const voters = votersSet.size;
    const minA = normalizeMinAnnotators(Number(minAnnotators));
    if (voters < minA) {
      return {
        status: 'pending',
        label: bestLabel,
        confidence: 0,
        voters,
        netVotes: best?.netVotes || 0,
        suggestionId: isTie ? null : (best?.suggestion?.id || null)
      };
    }

    const denom = voters || 1;
    // "Confidence" is net support share (-1..1): (unique_upvotes - unique_downvotes) / unique_total_voters.
    // Voters are unique across all votes in this bucket, so one user counts once in the denominator.
    const rawConfidence = (best?.netVotes || 0) / denom;
    const confidence = Number.isFinite(rawConfidence) ? Math.max(-1, Math.min(1, rawConfidence)) : 0;
    const th = normalizeConsensusThreshold(Number(threshold));
    // Ties are always disputed (no single winning label), even if the top net-vote share crosses threshold.
    const status = (!isTie && confidence >= th) ? 'consensus' : 'disputed';
    return {
      status,
      label: bestLabel,
      confidence,
      voters,
      netVotes: best?.netVotes || 0,
      suggestionId: isTie ? null : (best?.suggestion?.id || null)
    };
  }

  /**
   * Build a derived consensus export document (not persisted).
   *
   * This is the in-browser equivalent of a "compiled" consensus artifact:
   * it merges moderation merges into the visible suggestion list, and computes a
   * per-bucket consensus summary using the current annotatable consensus settings.
   *
   * @param {object} [options]
   * @param {boolean} [options.includeComments=false] - Include suggestion `comments` arrays (can be large).
   * @param {boolean} [options.includeMergedFrom=false] - Include `mergedFrom` bundles for moderated merges.
   * @returns {{version:1, builtAt:string, suggestions:Record<string, any[]>, consensus:Record<string, any>}}
   */
  buildConsensusDocument({ includeComments = false, includeMergedFrom = false } = {}) {
    const now = nowIso();

    /** @type {Record<string, any[]>} */
    const outSuggestions = {};
    /** @type {Record<string, any>} */
    const outConsensus = {};

    const parseBucket = (bucket) => {
      const canonical = this._canonicalizeBucketKey(bucket) || toCleanString(bucket);
      const parts = parseBucketKey(canonical);
      if (!parts) return null;
      const fieldKey = toCleanString(parts.fieldKey);
      const catKey = toCleanString(parts.catKey);
      if (!fieldKey || !catKey) return null;
      return { fieldKey, catKey, bucket: bucketKey(fieldKey, catKey) };
    };

    const buckets = Object.keys(this._state.suggestions || {}).sort((a, b) => a.localeCompare(b));
    for (const rawBucket of buckets) {
      const parts = parseBucket(rawBucket);
      if (!parts) continue;
      const { fieldKey, catKey, bucket } = parts;

      const suggestions = this.getSuggestions(fieldKey, catKey);
      outSuggestions[bucket] = suggestions.map((s) => {
        const out = {
          id: toCleanString(s?.id) || null,
          label: toCleanString(s?.label) || null,
          ontologyId: s?.ontologyId ?? null,
          evidence: s?.evidence ?? null,
          markers: s?.markers ?? null,
          proposedBy: toCleanString(s?.proposedBy) || null,
          proposedAt: toCleanString(s?.proposedAt) || null,
          upvotes: Array.isArray(s?.upvotes) ? s.upvotes.slice() : [],
          downvotes: Array.isArray(s?.downvotes) ? s.downvotes.slice() : [],
          ...(includeComments ? { comments: Array.isArray(s?.comments) ? s.comments.map((c) => ({ ...(c || {}) })) : [] } : {}),
          ...(includeMergedFrom ? { mergedFrom: Array.isArray(s?.mergedFrom) ? s.mergedFrom.map((m) => ({ ...(m || {}) })) : [] } : {}),
        };
        // Remove null id/label if malformed to reduce downstream surprises.
        if (!out.id) delete out.id;
        if (!out.label) delete out.label;
        return out;
      });

      const settings = this.getAnnotatableConsensusSettings(fieldKey);
      outConsensus[bucket] = this.computeConsensus(fieldKey, catKey, settings);
    }

    return {
      version: 1,
      builtAt: now,
      suggestions: outSuggestions,
      consensus: outConsensus
    };
  }

  getStateSnapshot() {
    return {
      datasetId: this._datasetId,
      ...safeJsonParse(JSON.stringify(this._state))
    };
  }

  getRemoteFileShas() {
    const map = this._state?.remoteFileShas;
    if (!map || typeof map !== 'object') return {};
    return { ...map };
  }

  setRemoteFileShas(nextMap) {
    const out = {};
    const input = (nextMap && typeof nextMap === 'object') ? nextMap : {};
    for (const [k, v] of Object.entries(input)) {
      const name = toCleanString(k);
      const sha = toCleanString(v);
      if (!name || !sha) continue;
      if (name.length > 256 || sha.length > 128) continue;
      out[name] = sha;
    }
    this._state.remoteFileShas = out;
    this._touch();
  }

  setRemoteFileSha(path, sha) {
    const p = toCleanString(path);
    const s = toCleanString(sha);
    if (!p || !s) return false;
    const current = this.getRemoteFileShas();
    current[p] = s;
    this.setRemoteFileShas(current);
    return true;
  }

  /**
   * Export the current user's GitHub user file doc (schema v1).
   * Suggestions are filtered to those proposed by the current user; votes are the
   * current user's votes across all suggestions.
   *
   * @returns {object}
   */
  buildUserFileDocument() {
    const profile = this._profile || sanitizeProfile({});
    const username = clampLen(this._getEffectiveUserKey(), 64) || 'local';
    const login = clampLen(profile.login || '', 64) || undefined;
    const githubUserId =
      normalizeGitHubUserIdOrNull(profile.githubUserId) ||
      normalizeGitHubUserIdOrNull(this._cacheUserId) ||
      undefined;
    const linkedin = clampLen(profile.linkedin || '', 120) || undefined;

    const suggestionsOut = {};
    for (const [bucket, list] of Object.entries(this._state.suggestions || {})) {
      if (!Array.isArray(list) || !bucket) continue;
      const mine = [];
      for (const s of list) {
        if (!s || normalizeUsername(s.proposedBy) !== normalizeUsername(username)) continue;
        const normalized = normalizeSuggestion(s, { proposedBy: username });
        if (!normalized) continue;
        // Preserve ids and timestamps so votes/comments remain referentially stable.
        normalized.id = clampLen(s?.id, 128) || normalized.id;
        normalized.proposedAt = clampLen(s?.proposedAt, 64) || normalized.proposedAt;
        // GitHub user file schema stores votes separately; omit upvotes/downvotes.
        delete normalized.upvotes;
        delete normalized.downvotes;
        delete normalized.comments;
        mine.push(normalized);
        if (mine.length >= MAX_SUGGESTIONS_PER_CLUSTER) break;
      }
      if (mine.length) {
        const outBucket = this._canonicalizeBucketKey(bucket) || bucket;
        const existing = Array.isArray(suggestionsOut[outBucket]) ? suggestionsOut[outBucket] : [];
        const merged = existing.concat(mine);
        const seen = new Set();
        const out = [];
        for (const s of merged) {
          const sid = toCleanString(s?.id);
          if (sid) {
            if (seen.has(sid)) continue;
            seen.add(sid);
          }
          out.push(s);
          if (out.length >= MAX_SUGGESTIONS_PER_CLUSTER) break;
        }
        suggestionsOut[outBucket] = out;
      }
    }

    const votesOut = {};
    for (const [k, v] of Object.entries(this._state.myVotes || {})) {
      const parsed = parseVoteKey(k);
      if (!parsed) continue;
      const dir = v === 'down' ? 'down' : (v === 'up' ? 'up' : null);
      if (!dir) continue;
      votesOut[parsed.suggestionId] = dir;
    }

    const commentsOut = {};
    for (const [suggestionId, commentList] of Object.entries(this._state.myComments || {})) {
      if (!Array.isArray(commentList) || !suggestionId) continue;
      const normalized = normalizeCommentArray(commentList);
      if (normalized.length) commentsOut[suggestionId] = normalized;
    }

    const deletedOut = {};
    const deleted = this._state.deletedSuggestions && typeof this._state.deletedSuggestions === 'object' ? this._state.deletedSuggestions : {};
    for (const [bucket, ids] of Object.entries(deleted)) {
      if (!bucket) continue;
      if (!Array.isArray(ids)) continue;
      const cleaned = uniqueStrings(ids.map((x) => toCleanString(x)).filter(Boolean)).slice(0, 2000);
      if (cleaned.length) {
        const outBucket = this._canonicalizeBucketKey(bucket) || bucket;
        const existing = Array.isArray(deletedOut[outBucket]) ? deletedOut[outBucket] : [];
        deletedOut[outBucket] = uniqueStrings(existing.concat(cleaned)).slice(0, 5000);
      }
    }

    const datasetsOut = {};
    const datasets = normalizeDatasetAccessMap(this._state.datasets);
    for (const datasetId of Object.keys(datasets).sort((a, b) => a.localeCompare(b))) {
      const entry = datasets[datasetId] || null;
      const lastAccessedAt = clampLen(entry?.lastAccessedAt, 64);
      datasetsOut[datasetId] = {
        fieldsToAnnotate: uniqueStrings(ensureStringArray(entry?.fieldsToAnnotate)).slice(0, 200),
        lastAccessedAt: lastAccessedAt || nowIso()
      };
    }

    return {
      version: 1,
      username,
      login,
      githubUserId,
      displayName: profile.displayName || undefined,
      title: profile.title || undefined,
      orcid: profile.orcid || undefined,
      linkedin,
      updatedAt: nowIso(),
      ...(Object.keys(datasetsOut).length ? { datasets: datasetsOut } : {}),
      suggestions: suggestionsOut,
      votes: votesOut,
      comments: commentsOut,
      deletedSuggestions: deletedOut
    };
  }

  /**
   * Rebuild the merged suggestions view from a complete set of raw GitHub user files.
   *
   * Why this exists:
   * - The UI "Pull" action should be able to deterministically rebuild the merged view
   *   from cached raw files, without depending on any previously-compiled merged output.
   * - Local (unsynced) intent still lives in this session (myVotes/myComments/my suggestions),
   *   so we append a locally-built user doc as a final input.
   *
   * This method:
   * 1) builds the local user's file doc from the current session state,
   * 2) clears the compiled/merged suggestion view,
   * 3) runs `mergeFromUserFiles()` against the complete inputs.
   *
   * @param {object[]} remoteUserDocs - parsed docs from `annotations/users/*.json`
   * @param {object} [options]
   * @param {boolean} [options.preferLocalVotes=true]
   */
  rebuildMergedViewFromUserFiles(remoteUserDocs, options = {}) {
    const preferLocalVotes = options.preferLocalVotes !== false;

    // Capture local intent before clearing the merged view.
    const localDoc = this.buildUserFileDocument();

    // Clear the previously-compiled merged output (but keep local intent: myVotes/myComments/etc).
    this._state.suggestions = {};

    const docs = Array.isArray(remoteUserDocs) ? remoteUserDocs : [];
    this.mergeFromUserFiles(docs.concat([localDoc]), { preferLocalVotes });
  }

  markSyncedNow() {
    this._state.lastSyncAt = nowIso();
    this._touch();
  }

  /**
   * Merge GitHub per-user files into the local merged view.
   *
   * `userDocs` are expected to follow the template schema:
   * - { username, githubUserId, login, suggestions: { [bucket]: Suggestion[] }, votes: { [suggestionId]: 'up'|'down' } }
   *
   * Security:
   * - Ignores non-objects / invalid JSON shapes.
   * - Does not touch DOM.
   *
   * @param {object[]} userDocs
   * @param {object} [options]
   * @param {boolean} [options.preferLocalVotes=true] - Local `myVotes` wins over pulled votes for the current user.
   */
  mergeFromUserFiles(userDocs, options = {}) {
    const preferLocalVotes = options.preferLocalVotes !== false;
    const myUsername = this._getEffectiveUserKey();
    const myUserLower = normalizeUsername(myUsername);
    const knownProfiles = this._knownProfiles && typeof this._knownProfiles === 'object' ? this._knownProfiles : {};
    const scopeKey = toCacheScopeKey({ datasetId: this._datasetId, repoRef: this._repoRef, userId: this._cacheUserId });

    const getDocUser = (doc) => {
      const id = Number(doc?.githubUserId);
      if (Number.isFinite(id)) {
        const safe = Math.max(0, Math.floor(id));
        if (safe) return normalizeUsername(`ghid_${safe}`);
      }
      const meta = toCleanString(doc?.__fileUser || doc?.__user || '');
      const fromMeta = meta ? normalizeUsername(meta) : '';
      const p = toCleanString(doc?.__path || '');
      let fromPath = '';
      if (p) {
        const m = p.match(/([^/]+)\.json$/i);
        if (m?.[1]) fromPath = normalizeUsername(m[1]);
      }
      const fromDoc = toCleanString(doc?.username || '').replace(/^@+/, '');
      return fromMeta || fromPath || normalizeUsername(fromDoc);
    };

    const docUserCache = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;
    const getCachedDocUser = (doc) => {
      if (!doc || typeof doc !== 'object') return null;
      if (!docUserCache) return getDocUser(doc);
      if (docUserCache.has(doc)) return docUserCache.get(doc);
      const u = getDocUser(doc) || null;
      docUserCache.set(doc, u);
      return u;
    };

    // 0) Capture optional public profile info from user docs (displayName/title/orcid/linkedin).
    // This is local-only UI metadata (not pushed anywhere by the app).
    // Limit growth to avoid unbounded localStorage usage.
    const KNOWN_PROFILE_LIMIT = 500;
    const docsList = Array.isArray(userDocs) ? userDocs : [];
    let knownProfileCount = 0;
    try {
      knownProfileCount = Object.keys(knownProfiles).length;
    } catch {
      knownProfileCount = 0;
    }
    for (const doc of docsList) {
      const u = getCachedDocUser(doc);
      if (!u) continue;
      const already = Boolean(knownProfiles[u]);
      if (knownProfileCount >= KNOWN_PROFILE_LIMIT && !already) continue;
      const cleaned = sanitizeKnownUserProfile(doc || {});
      if (!cleaned) continue;
      if (!already) knownProfileCount++;
      knownProfiles[u] = cleaned;
    }
    this._knownProfiles = knownProfiles;

    // Hydrate my profile fields from my GitHub user file if we don't have them yet.
    try {
      const mine = this._profile || sanitizeProfile({});
      const hasAny = Boolean(mine.displayName || mine.title || mine.orcid || mine.linkedin);
      if (!hasAny) {
        for (const doc of docsList) {
          const docUser = getCachedDocUser(doc);
          if (!docUser) continue;
          if (docUser !== myUserLower) continue;
          this._profile = sanitizeProfile({
            username: myUsername,
            displayName: doc?.displayName || '',
            title: doc?.title || '',
            orcid: doc?.orcid || '',
            linkedin: doc?.linkedin || ''
          });
          this._state.profile = sanitizeProfile(this._profile);
          break;
        }
      }
    } catch {
      // ignore
    }

    // 1) Union suggestion metadata from local + remote.
    const byBucketById = new Map(); // bucket -> Map(id -> suggestionMeta)
    const idToBucket = new Map();
    const duplicateSuggestionIds = [];
    const recordDuplicateSuggestionId = ({ id, firstBucket, secondBucket, sourceUser }) => {
      const sid = toCleanString(id);
      const a = toCleanString(firstBucket);
      const b = toCleanString(secondBucket);
      if (!sid || !a || !b || a === b) return;
      duplicateSuggestionIds.push({
        id: sid,
        firstBucket: a,
        secondBucket: b,
        sourceUser: normalizeUsername(sourceUser || '') || null
      });
    };

    // 1a) Collect deletion markers from remote docs + local session.
    // Only the proposer may delete: a deletion marker from username U only applies
    // to suggestions where `proposedBy` normalizes to U.
    const deletedByBucketById = new Map(); // bucket -> Map(suggestionId -> Set(usernameLower))
    const addDeleted = (bucket, suggestionId, username) => {
      const b = this._canonicalizeBucketKey(bucket) || toCleanString(bucket);
      const sid = toCleanString(suggestionId);
      const u = normalizeUsername(username);
      if (!b || !sid || !u) return;
      if (!deletedByBucketById.has(b)) deletedByBucketById.set(b, new Map());
      const m = deletedByBucketById.get(b);
      if (!m.has(sid)) m.set(sid, new Set());
      m.get(sid).add(u);
    };

    // local deletions (current user)
    const localDeleted = this._state.deletedSuggestions && typeof this._state.deletedSuggestions === 'object' ? this._state.deletedSuggestions : {};
    for (const [bucket, ids] of Object.entries(localDeleted)) {
      if (!Array.isArray(ids)) continue;
      for (const id of ids) addDeleted(bucket, id, myUsername);
    }

    const addSuggestion = (bucket, suggestion, { sourceUser = null } = {}) => {
      const b = this._canonicalizeBucketKey(bucket) || toCleanString(bucket);
      if (!b) return;
      const normalized = normalizeSuggestion(suggestion || {}, { proposedBy: sourceUser || suggestion?.proposedBy || 'local' });
      if (!normalized) return;
      normalized.id = clampLen(suggestion?.id, 128) || normalized.id;
      normalized.proposedAt = clampLen(suggestion?.proposedAt, 64) || normalized.proposedAt;

      const id = toCleanString(normalized.id);
      if (!id) return;
      if (idToBucket.has(id) && idToBucket.get(id) !== b) {
        // Duplicate suggestion id across buckets is a correctness/safety violation:
        // votes are keyed by suggestionId (bucketless), so collisions can cause silent mis-attribution.
        recordDuplicateSuggestionId({
          id,
          firstBucket: idToBucket.get(id),
          secondBucket: b,
          sourceUser
        });
        return;
      }
      idToBucket.set(id, b);

      if (!byBucketById.has(b)) byBucketById.set(b, new Map());
      const m = byBucketById.get(b);
      const existing = m.get(id) || null;
      const sourceLower = sourceUser ? normalizeUsername(sourceUser) : '';
      const preferRemoteMeta = Boolean(sourceLower && myUserLower && sourceLower !== myUserLower);
      m.set(id, mergeSuggestionMeta(existing, normalized, { preferIncoming: preferRemoteMeta }));
    };

    for (const [bucket, list] of Object.entries(this._state.suggestions || {})) {
      if (!Array.isArray(list)) continue;
      for (const s of list) addSuggestion(bucket, s);
    }

    const remoteDocs = Array.isArray(userDocs) ? userDocs : [];
    // The current user's remote doc is special: we may need to hydrate local persisted state
    // (votes/comments/deletions) for multi-device usage. Local intent still wins.
    /** @type {any|null} */
    let myRemoteDoc = null;
    for (const doc of remoteDocs) {
      if (!doc || typeof doc !== 'object' || doc.__invalid) continue;
      const docUser = getCachedDocUser(doc);
      if (!docUser) continue;
      if (docUser === myUserLower) {
        myRemoteDoc = doc;
        break;
      }
    }

    // remote deletion markers
    for (const doc of remoteDocs) {
      if (!doc || typeof doc !== 'object' || doc.__invalid) continue;
      const docUser = getCachedDocUser(doc);
      if (!docUser) continue;
      const deleted = doc.deletedSuggestions && typeof doc.deletedSuggestions === 'object' ? doc.deletedSuggestions : {};
      for (const [bucket, ids] of Object.entries(deleted)) {
        if (!bucket || !Array.isArray(ids)) continue;
        for (const id of ids.slice(0, 5000)) addDeleted(bucket, id, docUser);
      }
    }

    for (const doc of remoteDocs) {
      if (!doc || typeof doc !== 'object' || doc.__invalid) continue;
      const docUser = getCachedDocUser(doc);
      if (!docUser) continue;
      const suggestions = doc.suggestions && typeof doc.suggestions === 'object' ? doc.suggestions : {};
      for (const [bucket, list] of Object.entries(suggestions)) {
        if (!Array.isArray(list)) continue;
        for (const s of list.slice(0, MAX_SUGGESTIONS_PER_CLUSTER)) addSuggestion(bucket, s, { sourceUser: docUser });
      }
    }

    if (duplicateSuggestionIds.length) {
      // Treat as fatal: continuing would produce a misleading consensus view.
      const preview = duplicateSuggestionIds
        .slice(0, 8)
        .map((d) => `- ${d.id}: ${d.firstBucket} ↔ ${d.secondBucket}`)
        .join('\n');
      if (scopeKey && this._integrityErrorEmittedForScopeKey !== scopeKey) {
        this._integrityErrorEmittedForScopeKey = scopeKey;
        this.emit('integrity:error', {
          datasetId: this._datasetId,
          repoRef: this._repoRef,
          userId: this._cacheUserId,
          scopeKey,
          duplicates: duplicateSuggestionIds.slice(0, 50),
          message:
            'Annotation data integrity error: duplicate suggestion ids were found across buckets.\n' +
            'This can corrupt votes and consensus because votes are keyed only by suggestionId.\n\n' +
            'Examples:\n' +
            `${preview || '- (none)'}\n\n` +
            'Fix: remove/repair the offending user files in `annotations/users/`, then Pull again.\n' +
            'Disconnected annotation repo to prevent incorrect merges.'
        });
      }
      // Stop persistence and avoid further local writes for this scope.
      this._persistenceOk = false;
      return;
    }

    // Apply deletion markers now that we have suggestion metadata (including proposedBy).
    if (deletedByBucketById.size) {
      for (const [bucket, m] of byBucketById.entries()) {
        const dels = deletedByBucketById.get(bucket) || null;
        if (!dels) continue;
        for (const [sid, meta] of m.entries()) {
          const proposer = normalizeUsername(meta?.proposedBy || '');
          if (!proposer) continue;
          const delSet = dels.get(sid);
          if (!delSet || !delSet.has(proposer)) continue;
          m.delete(sid);
          idToBucket.delete(sid);
        }
      }
    }

    // Prune local vote/comment attachments for suggestion ids that no longer exist after deletions.
    // This avoids UI states like "I voted" when the aggregated vote arrays exclude the orphaned vote.
    if (this._state.myVotes && typeof this._state.myVotes === 'object') {
      for (const k of Object.keys(this._state.myVotes)) {
        const parsed = parseVoteKey(k);
        if (!parsed) continue;
        if (!idToBucket.has(toCleanString(parsed.suggestionId))) delete this._state.myVotes[k];
      }
    }
    if (this._state.myComments && typeof this._state.myComments === 'object') {
      for (const sid of Object.keys(this._state.myComments)) {
        if (!idToBucket.has(toCleanString(sid))) delete this._state.myComments[sid];
      }
    }

    // Hydrate persisted local state from the user's own remote user file (multi-device Pull/Publish).
    // Only fill gaps: if local state has a vote/comment/deletion, it remains authoritative.
    try {
      if (myRemoteDoc && myUserLower) {
        // 0) Dataset access metadata (informational): union per-user map.
        if (myRemoteDoc.datasets != null) {
          this._state.datasets = mergeDatasetAccessMaps(this._state.datasets, myRemoteDoc.datasets);
        }

        // 1) Deleted suggestions (per-bucket)
        const remoteDeleted = myRemoteDoc.deletedSuggestions && typeof myRemoteDoc.deletedSuggestions === 'object'
          ? myRemoteDoc.deletedSuggestions
          : null;
        if (remoteDeleted) {
          if (!this._state.deletedSuggestions || typeof this._state.deletedSuggestions !== 'object') this._state.deletedSuggestions = {};
          for (const [bucket, ids] of Object.entries(remoteDeleted)) {
            if (!bucket || !Array.isArray(ids)) continue;
            const cleaned = uniqueStrings(ids.map((x) => toCleanString(x)).filter(Boolean)).slice(0, 5000);
            if (!cleaned.length) continue;
            const existing = Array.isArray(this._state.deletedSuggestions[bucket]) ? this._state.deletedSuggestions[bucket] : [];
            this._state.deletedSuggestions[bucket] = uniqueStrings(existing.concat(cleaned)).slice(0, 5000);
          }
        }

        // 2) Votes (schema stores only by suggestionId)
        const remoteVotes = myRemoteDoc.votes && typeof myRemoteDoc.votes === 'object' ? myRemoteDoc.votes : null;
        if (remoteVotes) {
          const merges = Array.isArray(this._state.moderationMerges) ? this._state.moderationMerges : [];
          const mergeMapByBucket = buildEffectiveModerationMergeMapByBucket(merges);

          const resolveTargetForBucket = (bucket, suggestionId) => {
            const map = mergeMapByBucket.get(bucket) || null;
            return map ? (resolveMergeTarget(suggestionId, map) || suggestionId) : suggestionId;
          };

          const localTargetsByBucket = new Map(); // bucket -> Set(targetId)
          for (const [voteKey, v] of Object.entries(this._state.myVotes || {})) {
            const parsed = parseVoteKey(voteKey);
            if (!parsed) continue;
            if (v !== 'up' && v !== 'down') continue;
            const bucket = idToBucket.get(toCleanString(parsed.suggestionId));
            if (!bucket) continue;
            const target = toCleanString(resolveTargetForBucket(bucket, parsed.suggestionId));
            if (!target) continue;
            if (!localTargetsByBucket.has(bucket)) localTargetsByBucket.set(bucket, new Set());
            localTargetsByBucket.get(bucket).add(target);
          }

          const parseBucketToParts = (bucket) => {
            return parseBucketKey(bucket);
          };

          for (const [sidRaw, dir] of Object.entries(remoteVotes)) {
            const sid = toCleanString(sidRaw);
            const d = dir === 'down' ? 'down' : (dir === 'up' ? 'up' : null);
            if (!sid || !d) continue;
            if (!idToBucket.has(sid)) continue; // skip deleted/orphaned ids
            const bucket = idToBucket.get(sid);
            const target = toCleanString(resolveTargetForBucket(bucket, sid));
            const localTargets = localTargetsByBucket.get(bucket) || null;
            if (target && localTargets && localTargets.has(target)) continue;
            const parts = parseBucketToParts(bucket);
            if (!parts) continue;
            const k = suggestionKey(parts.fieldKey, parts.catKey, sid);
            if (!this._state.myVotes) this._state.myVotes = {};
            if (this._state.myVotes[k] !== 'up' && this._state.myVotes[k] !== 'down') {
              this._state.myVotes[k] = d;
            }
          }
        }

        // 3) Comments
        const remoteComments = myRemoteDoc.comments && typeof myRemoteDoc.comments === 'object' ? myRemoteDoc.comments : null;
        if (remoteComments) {
          if (!this._state.myComments || typeof this._state.myComments !== 'object') this._state.myComments = {};
          for (const [sidRaw, commentList] of Object.entries(remoteComments)) {
            const sid = toCleanString(sidRaw);
            if (!sid || !Array.isArray(commentList)) continue;
            if (!idToBucket.has(sid)) continue; // skip deleted/orphaned ids

            const existing = Array.isArray(this._state.myComments[sid]) ? this._state.myComments[sid] : [];
            const byId = new Map();
            for (const c of existing) {
              const normalized = normalizeComment(c);
              if (!normalized) continue;
              byId.set(normalized.id, normalized);
            }
            for (const c of commentList.slice(0, MAX_COMMENTS_PER_SUGGESTION)) {
              const normalized = normalizeComment({ ...(c || {}), authorUsername: myUserLower });
              if (!normalized) continue;
              const prev = byId.get(normalized.id) || null;
              if (prev) {
                const prevTime = toCleanString(prev.editedAt || prev.createdAt || '');
                const nextTime = toCleanString(normalized.editedAt || normalized.createdAt || '');
                if (nextTime && prevTime && nextTime <= prevTime) continue;
              }
              byId.set(normalized.id, normalized);
            }
            const merged = [...byId.values()]
              .sort((a, b) => toCleanString(a?.createdAt || '').localeCompare(toCleanString(b?.createdAt || '')))
              .slice(0, MAX_COMMENTS_PER_SUGGESTION);
            if (merged.length) this._state.myComments[sid] = merged;
          }
        }
      }
    } catch {
      // ignore
    }

    // 2) Aggregate votes (remote + local for current user).
    const upvotesById = new Map(); // id -> Set(username)
    const downvotesById = new Map(); // id -> Set(username)

    const applyVote = (suggestionId, username, direction) => {
      const sid = toCleanString(suggestionId);
      const u = normalizeUsername(username);
      if (!sid || !u) return;
      if (!idToBucket.has(sid)) return;

      if (!upvotesById.has(sid)) upvotesById.set(sid, new Set());
      if (!downvotesById.has(sid)) downvotesById.set(sid, new Set());
      upvotesById.get(sid).delete(u);
      downvotesById.get(sid).delete(u);
      if (direction === 'up') upvotesById.get(sid).add(u);
      if (direction === 'down') downvotesById.get(sid).add(u);
    };

    for (const doc of remoteDocs) {
      if (!doc || typeof doc !== 'object' || doc.__invalid) continue;
      const docUser = getCachedDocUser(doc);
      if (!docUser) continue;
      if (preferLocalVotes && docUser === myUserLower) continue;

      const votes = doc.votes && typeof doc.votes === 'object' ? doc.votes : {};
      for (const [sid, dir] of Object.entries(votes)) {
        const d = dir === 'down' ? 'down' : (dir === 'up' ? 'up' : null);
        if (!d) continue;
        applyVote(sid, docUser, d);
      }
    }

    // Apply local current user's votes last.
    for (const [k, dir] of Object.entries(this._state.myVotes || {})) {
      const parsed = parseVoteKey(k);
      if (!parsed) continue;
      const d = dir === 'down' ? 'down' : (dir === 'up' ? 'up' : null);
      if (!d) continue;
      applyVote(parsed.suggestionId, myUsername, d);
    }

    // 2b) Aggregate comments from all user docs.
    const commentsById = new Map(); // suggestionId -> Map(commentId -> comment)

    const addComment = (suggestionId, comment) => {
      const sid = toCleanString(suggestionId);
      if (!sid || !idToBucket.has(sid)) return;
      const normalized = normalizeComment(comment);
      if (!normalized) return;

      if (!commentsById.has(sid)) commentsById.set(sid, new Map());
      const existing = commentsById.get(sid).get(normalized.id);
      // Last-write-wins: prefer newer editedAt or createdAt
      if (existing) {
        const existingTime = existing.editedAt || existing.createdAt || '';
        const newTime = normalized.editedAt || normalized.createdAt || '';
        if (newTime <= existingTime) return;
      }
      commentsById.get(sid).set(normalized.id, normalized);
    };

    // Collect comments from remote user docs
    for (const doc of remoteDocs) {
      if (!doc || typeof doc !== 'object' || doc.__invalid) continue;
      const docUsername = getCachedDocUser(doc);
      // Skip local user's remote comments (prefer local state)
      if (docUsername === myUserLower) continue;

      const comments = doc.comments && typeof doc.comments === 'object' ? doc.comments : {};
      for (const [suggestionId, commentList] of Object.entries(comments)) {
        if (!Array.isArray(commentList)) continue;
        for (const c of commentList.slice(0, MAX_COMMENTS_PER_SUGGESTION)) {
          addComment(suggestionId, { ...(c || {}), authorUsername: docUsername });
        }
      }
    }

    // Apply local user's comments last (local wins)
    for (const [suggestionId, commentList] of Object.entries(this._state.myComments || {})) {
      if (!Array.isArray(commentList)) continue;
      for (const c of commentList) {
        addComment(suggestionId, c);
      }
    }

    // 3) Materialize merged suggestions back into state (with upvotes/downvotes/comments arrays).
    const nextSuggestions = {};
    for (const [bucket, m] of byBucketById.entries()) {
      const out = [];
      for (const s of m.values()) {
        const sid = toCleanString(s?.id);
        if (!sid) continue;
        const commentMap = commentsById.get(sid) || new Map();
        const commentList = [...commentMap.values()]
          .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))
          .slice(0, MAX_COMMENTS_PER_SUGGESTION);
        out.push({
          ...s,
          upvotes: uniqueStrings([...(upvotesById.get(sid) || new Set())]),
          downvotes: uniqueStrings([...(downvotesById.get(sid) || new Set())]),
          comments: commentList
        });
      }
      out.sort((a, b) => ((b.upvotes?.length || 0) - (b.downvotes?.length || 0)) - ((a.upvotes?.length || 0) - (a.downvotes?.length || 0)));
      nextSuggestions[bucket] = out.slice(0, MAX_SUGGESTIONS_PER_CLUSTER);
    }

    this._state.suggestions = nextSuggestions;
    this._state.lastSyncAt = nowIso();
    this._touch();
  }

  // -------------------------------------------------------------------------
  // Internal: load/save
  // -------------------------------------------------------------------------

  _ensureLoaded() {
    const key = toSessionStorageKey({ datasetId: this._datasetId, repoRef: this._repoRef, userId: this._cacheUserId });
    if (this._loadedForKey === key) return;
    this._loadedForKey = key;

    const raw = (key && typeof localStorage !== 'undefined') ? localStorage.getItem(key) : null;
    const parsed = raw ? safeJsonParse(raw) : null;
    const next = defaultState();

    if (parsed && parsed.version === STORAGE_VERSION) {
      next.annotationFields = uniqueStrings(ensureStringArray(parsed.annotationFields));
      next.profile = sanitizeProfile(parsed.profile || {});
      next.myVotes = parsed.myVotes && typeof parsed.myVotes === 'object' ? { ...parsed.myVotes } : {};
      next.myComments = {};
      const mc = parsed.myComments && typeof parsed.myComments === 'object' ? parsed.myComments : {};
      for (const [suggestionId, commentList] of Object.entries(mc)) {
        if (!Array.isArray(commentList)) continue;
        const normalized = normalizeCommentArray(commentList);
        if (normalized.length) next.myComments[suggestionId] = normalized;
      }
      next.moderationMerges = Array.isArray(parsed.moderationMerges)
        ? parsed.moderationMerges
            .map((m) => normalizeModerationMerge(m))
            .filter(Boolean)
            .slice(0, 5000)
        : [];
      next.moderationMerges = compactModerationMerges(next.moderationMerges);
      next.remoteFileShas = {};
      const shas = parsed.remoteFileShas && typeof parsed.remoteFileShas === 'object' ? parsed.remoteFileShas : {};
      for (const [name, sha] of Object.entries(shas)) {
        const n = toCleanString(name);
        const s = toCleanString(sha);
        if (!n || !s) continue;
        if (n.length > 256 || s.length > 128) continue;
        next.remoteFileShas[n] = s;
      }
      next.lastSyncAt = parsed.lastSyncAt || null;

      next.annotatableSettings = {};
      const a = parsed.annotatableSettings && typeof parsed.annotatableSettings === 'object' ? parsed.annotatableSettings : {};
      for (const [fieldKey, settings] of Object.entries(a)) {
        const k = toCleanString(fieldKey);
        if (!k) continue;
        next.annotatableSettings[k] = normalizeConsensusSettings(settings || {});
      }

      next.closedAnnotatableFields = {};
      const closed = parsed.closedAnnotatableFields && typeof parsed.closedAnnotatableFields === 'object' && !Array.isArray(parsed.closedAnnotatableFields)
        ? parsed.closedAnnotatableFields
        : null;
      if (closed) {
        for (const [k, v] of Object.entries(closed)) {
          const key = toCleanString(k);
          if (!key) continue;
          if (v === true) next.closedAnnotatableFields[key] = true;
        }
      }

      const suggestions = parsed.suggestions && typeof parsed.suggestions === 'object' ? parsed.suggestions : {};
      next.suggestions = {};
      for (const [bucket, items] of Object.entries(suggestions)) {
        if (!Array.isArray(items)) continue;
        const cleaned = [];
        for (const s of items) {
          const normalized = normalizeSuggestion(s || {}, { proposedBy: s?.proposedBy || 'local' });
          if (!normalized) continue;
          // Preserve ids and timestamps if present.
          normalized.id = clampLen(s?.id, 128) || normalized.id;
          normalized.proposedAt = clampLen(s?.proposedAt, 64) || normalized.proposedAt;
          cleaned.push(normalized);
          if (cleaned.length >= MAX_SUGGESTIONS_PER_CLUSTER) break;
        }
        next.suggestions[bucket] = cleaned;
      }
      next.updatedAt = parsed.updatedAt || next.updatedAt;

      next.deletedSuggestions = {};
      const deleted = parsed.deletedSuggestions && typeof parsed.deletedSuggestions === 'object' ? parsed.deletedSuggestions : {};
      for (const [bucket, ids] of Object.entries(deleted)) {
        if (!bucket || !Array.isArray(ids)) continue;
        const cleaned = uniqueStrings(ids.map((x) => toCleanString(x)).filter(Boolean)).slice(0, 5000);
        if (cleaned.length) next.deletedSuggestions[bucket] = cleaned;
      }

      next.datasets = normalizeDatasetAccessMap(parsed.datasets);
    }

    this._state = next;
    this._profile = sanitizeProfile(next.profile || {});

    // The cache key includes the GitHub numeric user id dimension; ensure the persisted
    // identity matches the active scope so attribution/vote ownership stays consistent.
    try {
      const desiredId = normalizeGitHubUserIdOrNull(this._cacheUserId);
      const desiredUserKey = desiredId ? toFileUserKeyFromId(desiredId) : null;
      if (desiredId && desiredUserKey) {
        const prevUserKey = normalizeUsername(this._profile?.username);
        const fixedProfile = sanitizeProfile({ ...this._profile, username: desiredUserKey, githubUserId: desiredId });
        const changed = (
          normalizeGitHubUserIdOrNull(fixedProfile.githubUserId) !== normalizeGitHubUserIdOrNull(this._profile.githubUserId) ||
          normalizeUsername(fixedProfile.username) !== normalizeUsername(this._profile.username)
        );
        if (changed) {
          this._profile = fixedProfile;
          this._state.profile = sanitizeProfile(fixedProfile);
        }

        // Repair any stale "local"/legacy attribution so suggestions and moderation actions remain
        // editable + publishable under the correct file identity.
        const fromKeys = [];
        const desiredLower = normalizeUsername(desiredUserKey);
        if (prevUserKey && desiredLower && prevUserKey !== desiredLower) fromKeys.push(prevUserKey);
        fromKeys.push('local');
        const didMigrate = this._migrateAttribution({ fromUserKeys: fromKeys, toUserKey: desiredUserKey });
        if (changed || didMigrate) {
          this._state.updatedAt = nowIso();
          this._scheduleSave();
        }
      }
    } catch {
      // ignore
    }
    this.emit('changed', { reason: 'load' });
  }

  _touch() {
    this._state.updatedAt = nowIso();
    if (this._persistenceOk) this._scheduleSave();
    this.emit('changed', { reason: 'update' });
  }

  _scheduleSave() {
    if (!this._persistenceOk) return;
    if (this._saveTimer) return;
    const schedule = typeof requestIdleCallback === 'function'
      ? (fn) => requestIdleCallback(fn, { timeout: 800 })
      : (fn) => setTimeout(fn, 150);
    this._saveTimer = schedule(() => {
      this._saveTimer = null;
      this._saveNow();
    });
  }

  _saveNow() {
    const key = toSessionStorageKey({ datasetId: this._datasetId, repoRef: this._repoRef, userId: this._cacheUserId });
    if (!key) return;
    const scopeKey = toCacheScopeKey({ datasetId: this._datasetId, repoRef: this._repoRef, userId: this._cacheUserId });
    if (scopeKey && !this._scopeLock.isHolding(scopeKey)) return;
    // Persist only *local intent* (my suggestions/votes/comments/settings), not the
    // fully-merged remote view (which can be rebuilt from cached raw GitHub files).
    const localDoc = this.buildUserFileDocument?.() || {};
    const persisted = {
      version: STORAGE_VERSION,
      updatedAt: this._state.updatedAt,
      annotationFields: this._state.annotationFields,
      annotatableSettings: this._state.annotatableSettings,
      closedAnnotatableFields: this._state.closedAnnotatableFields,
      datasets: this._state.datasets,
      profile: this._state.profile,
      myVotes: this._state.myVotes,
      myComments: this._state.myComments,
      moderationMerges: this._state.moderationMerges,
      remoteFileShas: this._state.remoteFileShas,
      lastSyncAt: this._state.lastSyncAt,
      suggestions: (localDoc && typeof localDoc === 'object') ? (localDoc.suggestions || {}) : {},
      deletedSuggestions: (localDoc && typeof localDoc === 'object') ? (localDoc.deletedSuggestions || {}) : {}
    };
    const payload = JSON.stringify(persisted);
    try {
      localStorage.setItem(key, payload);
      this._persistenceErrorEmittedForKey = null;
    } catch {
      this._persistenceOk = false;
      if (this._persistenceErrorEmittedForKey !== key) {
        this._persistenceErrorEmittedForKey = key;
        this.emit('persistence:error', {
          datasetId: this._datasetId,
          repoRef: this._repoRef,
          userId: this._cacheUserId,
          message:
            'Local persistence failed (browser storage write error).\n' +
            'To prevent silent data loss, the annotation repo must be disconnected.\n\n' +
            'Fix: free up browser storage (clear site data) and reconnect, then Pull again.'
        });
      }
    }
  }
}

let _session = null;

export function getCommunityAnnotationSession() {
  if (_session) return _session;
  _session = new CommunityAnnotationSession();
  return _session;
}
