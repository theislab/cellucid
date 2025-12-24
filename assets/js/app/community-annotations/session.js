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
const STORAGE_PREFIX = 'cellucid:community-annotations:v1:';
const DEFAULT_DATASET_KEY = 'default';

const MAX_LABEL_LEN = 120;
const MAX_ONTOLOGY_LEN = 64;
const MAX_EVIDENCE_LEN = 2000;
const MAX_SUGGESTIONS_PER_CLUSTER = 200;

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

function toStorageKey(datasetId) {
  const raw = toCleanString(datasetId);
  const key = raw || DEFAULT_DATASET_KEY;
  return `${STORAGE_PREFIX}${key}`;
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
  const username = clampLen(String(profile?.username || '').replace(/^@+/, ''), 64) || 'local';
  const displayName = clampLen(profile?.displayName || '', 120);
  const title = clampLen(profile?.title || '', 120);
  const orcid = clampLen(profile?.orcid || '', 64);
  return { username, displayName, title, orcid };
}

function normalizeSuggestion(input, { proposedBy } = {}) {
  const label = clampLen(input?.label, MAX_LABEL_LEN);
  if (!label) return null;

  const ontologyId = clampLen(input?.ontologyId, MAX_ONTOLOGY_LEN);
  const evidence = clampLen(input?.evidence, MAX_EVIDENCE_LEN);

  return {
    id: createId(),
    label,
    ontologyId: ontologyId || null,
    evidence: evidence || null,
    proposedBy: clampLen(proposedBy || input?.proposedBy || 'local', 64) || 'local',
    proposedAt: nowIso(),
    upvotes: uniqueStrings(ensureStringArray(input?.upvotes)),
    downvotes: uniqueStrings(ensureStringArray(input?.downvotes)),
    markers: Array.isArray(input?.markers) ? input.markers.slice(0, 50) : null,
    comments: null
  };
}

function suggestionKey(fieldKey, catIdx, suggestionId) {
  return `${fieldKey}:${catIdx}:${suggestionId}`;
}

function bucketKey(fieldKey, catIdx) {
  return `${fieldKey}:${catIdx}`;
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

function defaultState() {
  return {
    version: STORAGE_VERSION,
    updatedAt: nowIso(),
    annotationFields: [],
    profile: sanitizeProfile({}),
    suggestions: {}, // { [fieldKey:catIdx]: Suggestion[] }
    myVotes: {}, // { [fieldKey:catIdx:suggestionId]: 'up'|'down' }
    pendingSync: [],
    lastSyncAt: null
  };
}

export class CommunityAnnotationSession extends EventEmitter {
  constructor() {
    super();
    this._datasetId = null;
    this._state = defaultState();
    this._saveTimer = null;
    this._loadedForKey = null;
    this._ensureLoaded();
  }

  setDatasetId(datasetId) {
    const next = toCleanString(datasetId) || null;
    if (next === this._datasetId) return;
    this._datasetId = next;
    this._ensureLoaded();
    this.emit('context:changed', { datasetId: this._datasetId });
  }

  getDatasetId() {
    return this._datasetId;
  }

  getProfile() {
    return { ...this._state.profile };
  }

  setProfile(nextProfile) {
    const next = sanitizeProfile(nextProfile || {});
    const prev = this._state.profile;
    if (
      prev.username === next.username &&
      prev.displayName === next.displayName &&
      prev.title === next.title &&
      prev.orcid === next.orcid
    ) return;

    this._state.profile = next;
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
    return list.map((s) => ({
      ...s,
      upvotes: Array.isArray(s.upvotes) ? s.upvotes.slice() : [],
      downvotes: Array.isArray(s.downvotes) ? s.downvotes.slice() : []
    }));
  }

  addSuggestion(fieldKey, catIdx, { label, ontologyId = null, evidence = null, markers = null } = {}) {
    const f = toCleanString(fieldKey);
    const idx = Number.isFinite(catIdx) ? Math.max(0, Math.floor(catIdx)) : 0;
    if (!f) throw new Error('[CommunityAnnotationSession] fieldKey required');

    const suggestion = normalizeSuggestion(
      { label, ontologyId, evidence, markers },
      { proposedBy: this._state.profile.username }
    );
    if (!suggestion) throw new Error('[CommunityAnnotationSession] label required');

    const key = bucketKey(f, idx);
    if (!this._state.suggestions[key]) this._state.suggestions[key] = [];
    if (this._state.suggestions[key].length >= MAX_SUGGESTIONS_PER_CLUSTER) {
      throw new Error('[CommunityAnnotationSession] too many suggestions for this cluster');
    }

    // Auto-upvote by proposer
    suggestion.upvotes = uniqueStrings([this._state.profile.username, ...suggestion.upvotes]);
    suggestion.downvotes = suggestion.downvotes.filter((u) => u !== this._state.profile.username);
    this._state.myVotes[suggestionKey(f, idx, suggestion.id)] = 'up';

    this._state.suggestions[key].push(suggestion);
    this._touch();
    return suggestion.id;
  }

  vote(fieldKey, catIdx, suggestionId, direction) {
    const f = toCleanString(fieldKey);
    const idx = Number.isFinite(catIdx) ? Math.max(0, Math.floor(catIdx)) : 0;
    const id = toCleanString(suggestionId);
    const dir = direction === 'down' ? 'down' : 'up';
    const username = this._state.profile.username;
    if (!f || !id) return false;

    const key = bucketKey(f, idx);
    const list = this._state.suggestions[key] || [];
    const suggestion = list.find((s) => s?.id === id);
    if (!suggestion) return false;

    const mapKey = suggestionKey(f, idx, id);
    const current = this._state.myVotes[mapKey] || null;

    // Clicking the same direction toggles off.
    const next = current === dir ? null : dir;

    suggestion.upvotes = uniqueStrings((suggestion.upvotes || []).filter((u) => u !== username));
    suggestion.downvotes = uniqueStrings((suggestion.downvotes || []).filter((u) => u !== username));

    if (next === 'up') suggestion.upvotes = uniqueStrings([username, ...suggestion.upvotes]);
    if (next === 'down') suggestion.downvotes = uniqueStrings([username, ...suggestion.downvotes]);

    if (next) this._state.myVotes[mapKey] = next;
    else delete this._state.myVotes[mapKey];

    this._touch();
    return true;
  }

  /**
   * Compute consensus for a field/category bucket.
   * @returns {{status:'pending'|'disputed'|'consensus', label:string|null, confidence:number, voters:number, netVotes:number, suggestionId:string|null}}
   */
  computeConsensus(fieldKey, catIdx, { minAnnotators = 3, threshold = 0.7 } = {}) {
    const f = toCleanString(fieldKey);
    const idx = Number.isFinite(catIdx) ? Math.max(0, Math.floor(catIdx)) : 0;
    const key = bucketKey(f, idx);
    const list = this._state.suggestions[key] || [];
    if (!list.length) {
      return { status: 'pending', label: null, confidence: 0, voters: 0, netVotes: 0, suggestionId: null };
    }

    let best = null;
    for (const s of list) {
      const up = Array.isArray(s.upvotes) ? s.upvotes.length : 0;
      const down = Array.isArray(s.downvotes) ? s.downvotes.length : 0;
      const net = up - down;
      if (!best || net > best.netVotes) {
        best = { suggestion: s, netVotes: net, up, down };
      }
    }

    const votersSet = new Set();
    for (const s of list) {
      for (const u of ensureStringArray(s.upvotes)) votersSet.add(u);
      for (const u of ensureStringArray(s.downvotes)) votersSet.add(u);
    }

    const voters = votersSet.size;
    if (voters < (Number.isFinite(minAnnotators) ? Math.max(1, Math.floor(minAnnotators)) : 3)) {
      return {
        status: 'pending',
        label: best?.suggestion?.label || null,
        confidence: 0,
        voters,
        netVotes: best?.netVotes || 0,
        suggestionId: best?.suggestion?.id || null
      };
    }

    const denom = voters || 1;
    const confidence = (best?.netVotes || 0) / denom;
    const th = Number.isFinite(threshold) ? threshold : 0.7;
    const status = confidence >= th ? 'consensus' : 'disputed';
    return {
      status,
      label: best?.suggestion?.label || null,
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

  /**
   * Export the current user's GitHub user file doc (schema v1).
   * Suggestions are filtered to those proposed by the current user; votes are the
   * current user's votes across all suggestions.
   *
   * @returns {object}
   */
  buildUserFileDocument() {
    const profile = this._state.profile || sanitizeProfile({});
    const username = clampLen(profile.username || 'local', 64) || 'local';

    const suggestionsOut = {};
    for (const [bucket, list] of Object.entries(this._state.suggestions || {})) {
      if (!Array.isArray(list) || !bucket) continue;
      const mine = [];
      for (const s of list) {
        if (!s || s.proposedBy !== username) continue;
        const normalized = normalizeSuggestion(s, { proposedBy: username });
        if (!normalized) continue;
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

    return {
      version: 1,
      username,
      displayName: profile.displayName || undefined,
      title: profile.title || undefined,
      orcid: profile.orcid || undefined,
      updatedAt: nowIso(),
      suggestions: suggestionsOut,
      votes: votesOut
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
   * - { username, suggestions: { [bucket]: Suggestion[] }, votes: { [suggestionId]: 'up'|'down' } }
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
    const myUsername = this._state.profile?.username || 'local';

    // 1) Union suggestion metadata from local + remote.
    const byBucketById = new Map(); // bucket -> Map(id -> suggestionMeta)
    const idToBucket = new Map();

    const addSuggestion = (bucket, suggestion) => {
      const b = toCleanString(bucket);
      if (!b) return;
      const normalized = normalizeSuggestion(suggestion || {}, { proposedBy: suggestion?.proposedBy || 'local' });
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
      m.set(id, mergeSuggestionMeta(existing, normalized));
    };

    for (const [bucket, list] of Object.entries(this._state.suggestions || {})) {
      if (!Array.isArray(list)) continue;
      for (const s of list) addSuggestion(bucket, s);
    }

    const remoteDocs = Array.isArray(userDocs) ? userDocs : [];
    for (const doc of remoteDocs.slice(0, 1000)) {
      if (!doc || typeof doc !== 'object' || doc.__invalid) continue;
      const suggestions = doc.suggestions && typeof doc.suggestions === 'object' ? doc.suggestions : {};
      for (const [bucket, list] of Object.entries(suggestions)) {
        if (!Array.isArray(list)) continue;
        for (const s of list.slice(0, MAX_SUGGESTIONS_PER_CLUSTER)) addSuggestion(bucket, s);
      }
    }

    // 2) Aggregate votes (remote + local for current user).
    const upvotesById = new Map(); // id -> Set(username)
    const downvotesById = new Map(); // id -> Set(username)

    const applyVote = (suggestionId, username, direction) => {
      const sid = toCleanString(suggestionId);
      const u = toCleanString(username);
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
      const username = clampLen(doc.username || '', 64);
      if (!username) continue;
      if (preferLocalVotes && username === myUsername) continue;

      const votes = doc.votes && typeof doc.votes === 'object' ? doc.votes : {};
      for (const [sid, dir] of Object.entries(votes)) {
        const d = dir === 'down' ? 'down' : (dir === 'up' ? 'up' : null);
        if (!d) continue;
        applyVote(sid, username, d);
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

    // 3) Materialize merged suggestions back into state (with upvotes/downvotes arrays).
    const nextSuggestions = {};
    for (const [bucket, m] of byBucketById.entries()) {
      const out = [];
      for (const s of m.values()) {
        const sid = toCleanString(s?.id);
        if (!sid) continue;
        out.push({
          ...s,
          upvotes: uniqueStrings([...(upvotesById.get(sid) || new Set())]),
          downvotes: uniqueStrings([...(downvotesById.get(sid) || new Set())]),
          comments: null
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
    const key = toStorageKey(this._datasetId);
    if (this._loadedForKey === key) return;
    this._loadedForKey = key;

    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    const parsed = raw ? safeJsonParse(raw) : null;
    const next = defaultState();

    if (parsed && parsed.version === STORAGE_VERSION) {
      next.annotationFields = uniqueStrings(ensureStringArray(parsed.annotationFields));
      next.profile = sanitizeProfile(parsed.profile || {});
      next.myVotes = parsed.myVotes && typeof parsed.myVotes === 'object' ? { ...parsed.myVotes } : {};
      next.pendingSync = Array.isArray(parsed.pendingSync) ? parsed.pendingSync.slice(0, 2000) : [];
      next.lastSyncAt = parsed.lastSyncAt || null;

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
    }

    this._state = next;
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
    const key = toStorageKey(this._datasetId);
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
