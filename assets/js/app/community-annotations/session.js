/**
 * Community Annotation & Voting - Local Session Store
 *
 * Offline-first session state persisted to localStorage, keyed by datasetId.
 * GitHub sync is intentionally out of scope for this store; it tracks user
 * intent and votes/suggestions in a merge-friendly shape.
 *
 * Security: This module does not touch the DOM and does not execute any
 * user-provided content.
 */

import { EventEmitter } from '../utils/event-emitter.js';

const STORAGE_VERSION = 1;
const STORAGE_PREFIX = 'cellucid:community-annotations:session:';
const DEFAULT_DATASET_KEY = 'default';

const MAX_LABEL_LEN = 120;
const MAX_ONTOLOGY_LEN = 64;
const MAX_EVIDENCE_LEN = 2000;
const MAX_SUGGESTIONS_PER_CLUSTER = 200;
const MAX_COMMENT_LEN = 500;
const MAX_COMMENTS_PER_SUGGESTION = 800;
const MAX_MERGE_NOTE_LEN = 512;

const DEFAULT_MIN_ANNOTATORS = 1;
const DEFAULT_CONSENSUS_THRESHOLD = 0.5;

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

function normalizeRepoRef(repoRef) {
  const raw = toCleanString(repoRef);
  if (!raw) return { repo: 'local/local', branch: 'local' };
  const at = raw.lastIndexOf('@');
  const repo = toCleanString(at >= 0 ? raw.slice(0, at) : raw) || 'local/local';
  const branch = toCleanString(at >= 0 ? raw.slice(at + 1) : '') || 'main';
  return { repo, branch };
}

function toStorageKey({ datasetId, repoRef, username }) {
  const did = toCleanString(datasetId) || DEFAULT_DATASET_KEY;
  const { repo, branch } = normalizeRepoRef(repoRef);
  const user = clampLen(String(username || '').replace(/^@+/, ''), 64).toLowerCase() || 'local';
  const enc = (s) => encodeURIComponent(String(s || '').trim());
  return `${STORAGE_PREFIX}${enc(did)}|${enc(repo)}|${enc(branch)}|${enc(user)}`;
}

function clampLen(text, maxLen) {
  const s = toCleanString(text);
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen);
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

function sanitizeProfile(profile) {
  const username = normalizeUsername(profile?.username || '') || 'local';
  const login = clampLen(profile?.login || '', 64);
  const githubUserIdRaw = profile?.githubUserId;
  const githubUserId = Number.isFinite(Number(githubUserIdRaw)) ? Math.max(0, Math.floor(Number(githubUserIdRaw))) : null;
  const displayName = clampLen(profile?.displayName || '', 120);
  const title = clampLen(profile?.title || '', 120);
  const orcid = clampLen(profile?.orcid || '', 64);
  const linkedin = clampLen(profile?.linkedin || '', 120);
  const email = clampLen(profile?.email || '', 254);
  return { username, login, githubUserId, displayName, title, orcid, linkedin, email };
}

function sanitizeKnownUserProfile(input) {
  const login = clampLen(input?.login || '', 64);
  const displayName = clampLen(input?.displayName || '', 120);
  const title = clampLen(input?.title || '', 120);
  const orcid = clampLen(input?.orcid || '', 64);
  const linkedin = clampLen(input?.linkedin || '', 120);
  const email = clampLen(input?.email || '', 254);
  if (!login && !displayName && !title && !orcid && !linkedin && !email) return null;
  return { login, displayName, title, orcid, linkedin, email };
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

function suggestionKey(fieldKey, catIdx, suggestionId) {
  return `${fieldKey}:${catIdx}:${suggestionId}`;
}

function bucketKey(fieldKey, catIdx) {
  return `${fieldKey}:${catIdx}`;
}

function normalizeModerationMerge(entry) {
  const bucket = toCleanString(entry?.bucket);
  const fromSuggestionId = toCleanString(entry?.fromSuggestionId);
  const intoSuggestionId = toCleanString(entry?.intoSuggestionId);
  if (!bucket || !fromSuggestionId || !intoSuggestionId) return null;
  if (fromSuggestionId === intoSuggestionId) return null;
  const by = normalizeUsername(entry?.by || '') || null;
  const at = toCleanString(entry?.at) || null;
  const note = clampLen(entry?.note, MAX_MERGE_NOTE_LEN) || null;

  return {
    bucket,
    fromSuggestionId,
    intoSuggestionId,
    ...(by ? { by } : {}),
    ...(at ? { at } : {}),
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
    if (!prev || isNewer(prev, m?.at, i)) {
      newestByKey.set(k, { at: toCleanString(m?.at || ''), index: i, entry: m });
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
    if (!prev || isNewer(prev, m.at, i)) {
      newestByFrom.set(from, { at: toCleanString(m.at || ''), index: i, into });
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
    if (!prev || isNewer(prev, m.at, i)) {
      bucketNewest.set(from, { at: toCleanString(m.at || ''), index: i, into });
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
  const parts = raw.split(':');
  if (parts.length < 3) return null;
  const suggestionId = parts.pop();
  const catIdxRaw = parts.pop();
  const fieldKey = parts.join(':');
  const catIdx = Number.isFinite(Number(catIdxRaw)) ? Math.max(0, Math.floor(Number(catIdxRaw))) : 0;
  if (!fieldKey || !suggestionId) return null;
  return { fieldKey, catIdx, suggestionId };
}

function mergeSuggestionMeta(a, b) {
  if (!a && !b) return null;
  const left = a || {};
  const right = b || {};
  return {
    id: clampLen(left.id || right.id || '', 128) || createId(),
    label: clampLen(left.label || right.label || '', MAX_LABEL_LEN),
    ontologyId: clampLen(left.ontologyId || right.ontologyId || '', MAX_ONTOLOGY_LEN) || null,
    evidence: clampLen(left.evidence || right.evidence || '', MAX_EVIDENCE_LEN) || null,
    proposedBy: clampLen(left.proposedBy || right.proposedBy || 'local', 64) || 'local',
    proposedAt: clampLen(left.proposedAt || right.proposedAt || nowIso(), 64) || nowIso(),
    markers: Array.isArray(left.markers) ? left.markers.slice(0, 50) : (Array.isArray(right.markers) ? right.markers.slice(0, 50) : null),
  };
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
    // Persisted locally so profile edits survive refresh until Publish.
    profile: sanitizeProfile({}),
    suggestions: {}, // { [fieldKey:catIdx]: Suggestion[] }
    deletedSuggestions: {}, // { [fieldKey:catIdx]: string[] } (only the proposer can delete)
    myVotes: {}, // { [fieldKey:catIdx:suggestionId]: 'up'|'down' }
    myComments: {}, // { [suggestionId]: Comment[] }
    moderationMerges: [], // { bucket, fromSuggestionId, intoSuggestionId, by, at, note }[]
    // Used to enable incremental GitHub pulls (only fetch files whose sha changed).
    remoteFileShas: {}, // { [path]: sha }
    pendingSync: [],
    lastSyncAt: null
  };
}

export class CommunityAnnotationSession extends EventEmitter {
  constructor() {
    super();
    this._datasetId = null;
    this._repoRef = null;
    this._cacheUsername = 'local';
    this._state = defaultState();
    this._profile = sanitizeProfile({});
    // Public profile metadata from GitHub user files (in-memory only).
    this._knownProfiles = {}; // { [usernameLower]: { displayName?, title?, orcid? } }
    this._saveTimer = null;
    this._loadedForKey = null;
    this._ensureLoaded();
  }

  setCacheContext({ datasetId, repoRef, username } = {}) {
    const nextDatasetId = datasetId === undefined ? this._datasetId : (toCleanString(datasetId) || null);
    const nextRepoRef = repoRef === undefined ? this._repoRef : (toCleanString(repoRef) || null);
    const nextUser =
      username === undefined
        ? this._cacheUsername
        : (clampLen(String(username || '').replace(/^@+/, ''), 64).toLowerCase() || 'local');

    if (
      nextDatasetId === this._datasetId &&
      nextRepoRef === this._repoRef &&
      nextUser === this._cacheUsername
    ) {
      return;
    }

    try {
      this._saveNow?.();
    } catch {
      // ignore
    }

    this._datasetId = nextDatasetId;
    this._repoRef = nextRepoRef;
    this._cacheUsername = nextUser;
    this._ensureLoaded();
    this.emit('context:changed', { datasetId: this._datasetId, repoRef: this._repoRef, username: this._cacheUsername });
  }

  setDatasetId(datasetId) {
    this.setCacheContext({ datasetId });
  }

  clearLocalCache({ keepVotingMode = true } = {}) {
    try {
      if (typeof localStorage !== 'undefined') {
        const key = toStorageKey({ datasetId: this._datasetId, repoRef: this._repoRef, username: this._cacheUsername });
        localStorage.removeItem(key);
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
    const handle = prof?.login ? normalizeUsername(prof.login) : u;
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
      prev.linkedin === next.linkedin &&
      prev.email === next.email
    ) return;

    if (normalizeUsername(prev.username) !== normalizeUsername(next.username)) {
      this.setCacheContext({ username: next.username });
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

  /**
   * @returns {any[]} suggestions (cloned)
   */
  getSuggestions(fieldKey, catIdx) {
    const f = toCleanString(fieldKey);
    const idx = Number.isFinite(catIdx) ? Math.max(0, Math.floor(catIdx)) : 0;
    const key = bucketKey(f, idx);
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
    const idx = Number.isFinite(catIdx) ? Math.max(0, Math.floor(catIdx)) : 0;
    if (!f) throw new Error('[CommunityAnnotationSession] fieldKey required');

    const key = bucketKey(f, idx);
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
      { proposedBy: this._profile.username }
    );
    if (!suggestion) throw new Error('[CommunityAnnotationSession] label required');

    if (!this._state.suggestions[key]) this._state.suggestions[key] = [];
    if (this._state.suggestions[key].length >= MAX_SUGGESTIONS_PER_CLUSTER) {
      throw new Error('[CommunityAnnotationSession] too many suggestions for this cluster');
    }

    // Auto-upvote by proposer
    suggestion.upvotes = uniqueStrings([this._profile.username, ...suggestion.upvotes]);
    suggestion.downvotes = suggestion.downvotes.filter((u) => u !== this._profile.username);
    this._state.myVotes[suggestionKey(f, idx, suggestion.id)] = 'up';

    this._state.suggestions[key].push(suggestion);
    this._touch();
    return suggestion.id;
  }

  editMySuggestion(fieldKey, catIdx, suggestionId, { label, ontologyId, evidence, markers } = {}) {
    const f = toCleanString(fieldKey);
    const idx = Number.isFinite(catIdx) ? Math.max(0, Math.floor(catIdx)) : 0;
    const id = toCleanString(suggestionId);
    const my = normalizeUsername(this._profile?.username || '');
    if (!f) throw new Error('[CommunityAnnotationSession] fieldKey required');
    if (!id) throw new Error('[CommunityAnnotationSession] suggestionId required');
    if (!my) throw new Error('[CommunityAnnotationSession] username required');

    const bucket = bucketKey(f, idx);
    const list = this._state.suggestions?.[bucket] || [];
    const suggestion = list.find((x) => x && toCleanString(x.id) === id) || null;
    if (!suggestion) throw new Error('[CommunityAnnotationSession] suggestion not found');
    if (normalizeUsername(suggestion.proposedBy) !== my) {
      throw new Error('[CommunityAnnotationSession] cannot edit a suggestion you did not propose');
    }

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
      suggestion.label = nextLabel;
    }

    if (ontologyId !== undefined) {
      const next = clampLen(ontologyId, MAX_ONTOLOGY_LEN);
      suggestion.ontologyId = next ? next : null;
    }

    if (evidence !== undefined) {
      const next = clampLen(evidence, MAX_EVIDENCE_LEN);
      suggestion.evidence = next ? next : null;
    }

    if (markers !== undefined) {
      suggestion.markers = normalizeMarkers(markers);
    }

    this._touch();
    return true;
  }

  deleteMySuggestion(fieldKey, catIdx, suggestionId) {
    const f = toCleanString(fieldKey);
    const idx = Number.isFinite(catIdx) ? Math.max(0, Math.floor(catIdx)) : 0;
    const id = toCleanString(suggestionId);
    const my = normalizeUsername(this._profile?.username || '');
    if (!f || !id || !my) return false;

    const bucket = bucketKey(f, idx);
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
    const voteKey = suggestionKey(f, idx, id);
    if (this._state.myVotes?.[voteKey]) delete this._state.myVotes[voteKey];
    if (this._state.myComments?.[id]) delete this._state.myComments[id];

    this._touch();
    return true;
  }

  vote(fieldKey, catIdx, suggestionId, direction) {
    const f = toCleanString(fieldKey);
    const idx = Number.isFinite(catIdx) ? Math.max(0, Math.floor(catIdx)) : 0;
    const id = toCleanString(suggestionId);
    const dir = direction === 'down' ? 'down' : 'up';
    const username = normalizeUsername(this._profile.username);
    if (!f || !id || !username) return false;

    const key = bucketKey(f, idx);
    const list = this._state.suggestions[key] || [];
    const suggestion = list.find((s) => s?.id === id) || null;
    if (!suggestion) return false;

    // Per-suggestion voting: allow users to vote independently on merged bundle members.
    // The merged bundle totals are de-duplicated at read/render time.
    const directKey = suggestionKey(f, idx, id);
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
    const idx = Number.isFinite(catIdx) ? Math.max(0, Math.floor(catIdx)) : 0;
    const sid = toCleanString(suggestionId);
    if (!f || !sid) return null;
    const directKey = suggestionKey(f, idx, sid);
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
    const idx = Number.isFinite(catIdx) ? Math.max(0, Math.floor(catIdx)) : 0;
    const sid = toCleanString(suggestionId);
    if (!f || !sid) return { vote: null, source: 'none', delegatedUp: 0, delegatedDown: 0 };

    const direct = this.getMyVoteDirect(f, idx, sid);
    if (direct) return { vote: direct, source: 'direct', delegatedUp: 0, delegatedDown: 0 };

    const bucket = bucketKey(f, idx);
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
      const k = suggestionKey(f, idx, oid);
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
    const idx = Number.isFinite(catIdx) ? Math.max(0, Math.floor(catIdx)) : 0;
    const sid = toCleanString(suggestionId);
    const trimmedText = toCleanString(text);
    if (!f || !sid || !trimmedText) return null;

    const key = bucketKey(f, idx);
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

    const comment = normalizeComment({ text: trimmedText }, { authorUsername: this._profile.username });
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
    const idx = Number.isFinite(catIdx) ? Math.max(0, Math.floor(catIdx)) : 0;
    const sid = toCleanString(suggestionId);
    const cid = toCleanString(commentId);
    const trimmedText = toCleanString(newText);
    if (!f || !sid || !cid || !trimmedText) return false;

    const key = bucketKey(f, idx);
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
    const idx = Number.isFinite(catIdx) ? Math.max(0, Math.floor(catIdx)) : 0;
    const sid = toCleanString(suggestionId);
    const cid = toCleanString(commentId);
    if (!f || !sid || !cid) return false;

    const key = bucketKey(f, idx);
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
    const idx = Number.isFinite(catIdx) ? Math.max(0, Math.floor(catIdx)) : 0;
    const sid = toCleanString(suggestionId);
    if (!f || !sid) return [];

    const key = bucketKey(f, idx);
    const list = this._state.suggestions[key] || [];
    const suggestion = list.find((s) => toCleanString(s?.id) === sid) || null;
    if (!suggestion || !Array.isArray(suggestion.comments)) return [];
    return suggestion.comments.map((c) => ({ ...(c || {}) }));
  }

  isMyComment(authorUsername) {
    const myUsername = normalizeUsername(this._profile?.username);
    const author = normalizeUsername(authorUsername);
    return myUsername && author && myUsername === author;
  }

  setModerationMergesFromDoc(doc) {
    const merges = Array.isArray(doc?.merges) ? doc.merges : [];
    const cleaned = [];
    for (const m of merges.slice(0, 5000)) {
      const normalized = normalizeModerationMerge(m);
      if (!normalized) continue;
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
    const idx = Number.isFinite(catIdx) ? Math.max(0, Math.floor(catIdx)) : 0;
    const bucket = bucketKey(f, idx);
    const entry = normalizeModerationMerge({
      bucket,
      fromSuggestionId,
      intoSuggestionId,
      by: this._profile?.username || 'local',
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

  detachModerationMerge({ fieldKey, catIdx, fromSuggestionId } = {}) {
    const f = toCleanString(fieldKey);
    const idx = Number.isFinite(catIdx) ? Math.max(0, Math.floor(catIdx)) : 0;
    const bucket = bucketKey(f, idx);
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
    const idx = Number.isFinite(catIdx) ? Math.max(0, Math.floor(catIdx)) : 0;
    const bucket = bucketKey(f, idx);
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
    return this.detachModerationMerge({ fieldKey: f, catIdx: idx, fromSuggestionId: best.fromId });
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
    const idx = Number.isFinite(catIdx) ? Math.max(0, Math.floor(catIdx)) : 0;
    const key = bucketKey(f, idx);
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
        suggestionId: best?.suggestion?.id || null
      };
    }

    const denom = voters || 1;
    // "Confidence" is net support share (-1..1): (unique_upvotes - unique_downvotes) / unique_total_voters.
    // Voters are unique across all votes in this bucket, so one user counts once in the denominator.
    const rawConfidence = (best?.netVotes || 0) / denom;
    const confidence = Number.isFinite(rawConfidence) ? Math.max(-1, Math.min(1, rawConfidence)) : 0;
    const th = normalizeConsensusThreshold(Number(threshold));
    const status = confidence >= th ? 'consensus' : 'disputed';
    return {
      status,
      label: bestLabel,
      confidence,
      voters,
      netVotes: best?.netVotes || 0,
      suggestionId: best?.suggestion?.id || null
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
    const username = clampLen(profile.username || 'local', 64) || 'local';
    const login = clampLen(profile.login || '', 64) || undefined;
    const githubUserId = profile.githubUserId && Number.isFinite(profile.githubUserId) ? profile.githubUserId : undefined;
    const linkedin = clampLen(profile.linkedin || '', 120) || undefined;
    const email = clampLen(profile.email || '', 254) || undefined;

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
      if (mine.length) suggestionsOut[bucket] = mine;
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
      if (cleaned.length) deletedOut[bucket] = cleaned;
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
      email,
      updatedAt: nowIso(),
      suggestions: suggestionsOut,
      votes: votesOut,
      comments: commentsOut,
      deletedSuggestions: deletedOut
    };
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
    const myUsername = this._profile?.username || 'local';
    const myUserLower = normalizeUsername(myUsername);
    const knownProfiles = this._knownProfiles && typeof this._knownProfiles === 'object' ? this._knownProfiles : {};

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

    // 0) Capture optional public profile info from user docs (displayName/title/orcid/linkedin).
    // This is local-only UI metadata (not pushed anywhere by the app).
    // Limit growth to avoid unbounded localStorage usage.
    const KNOWN_PROFILE_LIMIT = 500;
    for (const doc of (Array.isArray(userDocs) ? userDocs : []).slice(0, 2000)) {
      const u = getDocUser(doc);
      if (!u) continue;
      if (Object.keys(knownProfiles).length >= KNOWN_PROFILE_LIMIT && !knownProfiles[u]) continue;
      const cleaned = sanitizeKnownUserProfile(doc || {});
      if (!cleaned) continue;
      knownProfiles[u] = cleaned;
    }
    this._knownProfiles = knownProfiles;

    // Hydrate my profile fields from my GitHub user file if we don't have them yet.
    try {
      const mine = this._profile || sanitizeProfile({});
      const hasAny = Boolean(mine.displayName || mine.title || mine.orcid || mine.linkedin || mine.email);
      if (!hasAny) {
        for (const doc of (Array.isArray(userDocs) ? userDocs : []).slice(0, 2000)) {
          const docUser = getDocUser(doc);
          if (!docUser) continue;
          if (docUser !== myUserLower) continue;
          this._profile = sanitizeProfile({
            username: myUsername,
            displayName: doc?.displayName || '',
            title: doc?.title || '',
            orcid: doc?.orcid || '',
            linkedin: doc?.linkedin || '',
            email: doc?.email || ''
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

    // 1a) Collect deletion markers from remote docs + local session.
    // Only the proposer may delete: a deletion marker from username U only applies
    // to suggestions where `proposedBy` normalizes to U.
    const deletedByBucketById = new Map(); // bucket -> Map(suggestionId -> Set(usernameLower))
    const addDeleted = (bucket, suggestionId, username) => {
      const b = toCleanString(bucket);
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
      const b = toCleanString(bucket);
      if (!b) return;
      const normalized = normalizeSuggestion(suggestion || {}, { proposedBy: sourceUser || suggestion?.proposedBy || 'local' });
      if (!normalized) return;
      normalized.id = clampLen(suggestion?.id, 128) || normalized.id;
      normalized.proposedAt = clampLen(suggestion?.proposedAt, 64) || normalized.proposedAt;

      const id = toCleanString(normalized.id);
      if (!id) return;
      if (idToBucket.has(id) && idToBucket.get(id) !== b) {
        // Ambiguous id reused across buckets; ignore later duplicates.
        return;
      }
      idToBucket.set(id, b);

      if (!byBucketById.has(b)) byBucketById.set(b, new Map());
      const m = byBucketById.get(b);
      const existing = m.get(id) || null;
      const sourceLower = sourceUser ? normalizeUsername(sourceUser) : '';
      const preferRemoteMeta = Boolean(sourceLower && myUserLower && sourceLower !== myUserLower);
      m.set(id, preferRemoteMeta ? mergeSuggestionMetaPreferRight(existing, normalized) : mergeSuggestionMeta(existing, normalized));
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
      const docUser = getDocUser(doc);
      if (!docUser) continue;
      if (docUser === myUserLower) {
        myRemoteDoc = doc;
        break;
      }
    }

    // remote deletion markers
    for (const doc of remoteDocs.slice(0, 2000)) {
      if (!doc || typeof doc !== 'object' || doc.__invalid) continue;
      const docUser = getDocUser(doc);
      if (!docUser) continue;
      const deleted = doc.deletedSuggestions && typeof doc.deletedSuggestions === 'object' ? doc.deletedSuggestions : {};
      for (const [bucket, ids] of Object.entries(deleted)) {
        if (!bucket || !Array.isArray(ids)) continue;
        for (const id of ids.slice(0, 5000)) addDeleted(bucket, id, docUser);
      }
    }

    for (const doc of remoteDocs.slice(0, 1000)) {
      if (!doc || typeof doc !== 'object' || doc.__invalid) continue;
      const docUser = getDocUser(doc);
      if (!docUser) continue;
      const suggestions = doc.suggestions && typeof doc.suggestions === 'object' ? doc.suggestions : {};
      for (const [bucket, list] of Object.entries(suggestions)) {
        if (!Array.isArray(list)) continue;
        for (const s of list.slice(0, MAX_SUGGESTIONS_PER_CLUSTER)) addSuggestion(bucket, s, { sourceUser: docUser });
      }
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
            const bucket = bucketKey(parsed.fieldKey, parsed.catIdx);
            const target = toCleanString(resolveTargetForBucket(bucket, parsed.suggestionId));
            if (!target) continue;
            if (!localTargetsByBucket.has(bucket)) localTargetsByBucket.set(bucket, new Set());
            localTargetsByBucket.get(bucket).add(target);
          }

          const parseBucketToParts = (bucket) => {
            const b = toCleanString(bucket);
            const last = b.lastIndexOf(':');
            if (last < 0) return null;
            const fieldKey = b.slice(0, last);
            const catIdxRaw = b.slice(last + 1);
            const catIdx = Number.isFinite(Number(catIdxRaw)) ? Math.max(0, Math.floor(Number(catIdxRaw))) : 0;
            if (!fieldKey) return null;
            return { fieldKey, catIdx };
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
            const k = suggestionKey(parts.fieldKey, parts.catIdx, sid);
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

    for (const doc of remoteDocs.slice(0, 1000)) {
      if (!doc || typeof doc !== 'object' || doc.__invalid) continue;
      const docUser = getDocUser(doc);
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
    for (const doc of remoteDocs.slice(0, 1000)) {
      if (!doc || typeof doc !== 'object' || doc.__invalid) continue;
      const docUsername = getDocUser(doc);
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
    const key = toStorageKey({ datasetId: this._datasetId, repoRef: this._repoRef, username: this._cacheUsername });
    if (this._loadedForKey === key) return;
    this._loadedForKey = key;

    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
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
      next.pendingSync = Array.isArray(parsed.pendingSync) ? parsed.pendingSync.slice(0, 2000) : [];
      next.lastSyncAt = parsed.lastSyncAt || null;

      next.annotatableSettings = {};
      const a = parsed.annotatableSettings && typeof parsed.annotatableSettings === 'object' ? parsed.annotatableSettings : {};
      for (const [fieldKey, settings] of Object.entries(a)) {
        const k = toCleanString(fieldKey);
        if (!k) continue;
        next.annotatableSettings[k] = normalizeConsensusSettings(settings || {});
      }

      next.closedAnnotatableFields = {};
      const closed = parsed.closedAnnotatableFields && typeof parsed.closedAnnotatableFields === 'object'
        ? parsed.closedAnnotatableFields
        : (Array.isArray(parsed.closedAnnotatableFields) ? parsed.closedAnnotatableFields : null);
      if (Array.isArray(closed)) {
        for (const k of closed.slice(0, 500)) {
          const key = toCleanString(k);
          if (!key) continue;
          next.closedAnnotatableFields[key] = true;
        }
      } else if (closed && typeof closed === 'object') {
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
    }

    this._state = next;
    this._profile = sanitizeProfile(next.profile || {});
    // The cache key includes the "user" dimension; ensure the persisted profile username
    // matches the active cache username so attribution/vote ownership stays consistent.
    try {
      const desiredUser = clampLen(String(this._cacheUsername || '').replace(/^@+/, ''), 64).toLowerCase() || 'local';
      const currentUser = normalizeUsername(this._profile?.username || '') || 'local';
      if (desiredUser && currentUser !== desiredUser) {
        const fixedProfile = sanitizeProfile({ ...this._profile, username: desiredUser });
        this._profile = fixedProfile;
        this._state.profile = sanitizeProfile(fixedProfile);
        this._scheduleSave();
      }
    } catch {
      // ignore
    }
    this.emit('changed', { reason: 'load' });
  }

  _touch() {
    this._state.updatedAt = nowIso();
    this._scheduleSave();
    this.emit('changed', { reason: 'update' });
  }

  _scheduleSave() {
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
    const key = toStorageKey({ datasetId: this._datasetId, repoRef: this._repoRef, username: this._cacheUsername });
    const payload = JSON.stringify(this._state);
    try {
      localStorage.setItem(key, payload);
    } catch {
      // ignore storage quota errors; session remains in memory
    }
  }
}

let _session = null;

export function getCommunityAnnotationSession() {
  if (_session) return _session;
  _session = new CommunityAnnotationSession();
  return _session;
}
