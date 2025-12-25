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
  const username = clampLen(String(profile?.username || '').replace(/^@+/, ''), 64) || 'local';
  const displayName = clampLen(profile?.displayName || '', 120);
  const title = clampLen(profile?.title || '', 120);
  const orcid = clampLen(profile?.orcid || '', 64);
  return { username, displayName, title, orcid };
}

function sanitizeKnownUserProfile(input) {
  const displayName = clampLen(input?.displayName || '', 120);
  const title = clampLen(input?.title || '', 120);
  const orcid = clampLen(input?.orcid || '', 64);
  if (!displayName && !title && !orcid) return null;
  return { displayName, title, orcid };
}

function normalizeUsername(username) {
  return clampLen(String(username || '').replace(/^@+/, ''), 64).toLowerCase();
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
    comments: []
  };
}

function normalizeComment(input, { authorUsername } = {}) {
  const text = clampLen(input?.text, MAX_COMMENT_LEN);
  if (!text) return null;

  const author = clampLen(authorUsername || input?.authorUsername || 'local', 64) || 'local';
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
  const by = clampLen(toCleanString(entry?.by), 64) || 'local';
  const at = clampLen(toCleanString(entry?.at), 64) || nowIso();
  const note = clampLen(toCleanString(entry?.note), 240) || null;
  return { bucket, fromSuggestionId, intoSuggestionId, by, at, note };
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
    // Persisted locally so profile edits survive refresh until Publish.
    profile: sanitizeProfile({}),
    suggestions: {}, // { [fieldKey:catIdx]: Suggestion[] }
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
    if (prof?.displayName) parts.push(prof.displayName);
    if (prof?.title) parts.push(prof.title);
    if (parts.length) return `@${u} (${parts.join(', ')})`;
    return `@${u}`;
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
      prev.displayName === next.displayName &&
      prev.title === next.title &&
      prev.orcid === next.orcid
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
    return merged.map((s) => ({
      ...s,
      upvotes: Array.isArray(s.upvotes) ? s.upvotes.slice() : [],
      downvotes: Array.isArray(s.downvotes) ? s.downvotes.slice() : []
    }));
  }

  _applyModerationMergesForBucket(bucket, suggestionsList) {
    const merges = Array.isArray(this._state.moderationMerges) ? this._state.moderationMerges : [];
    const bucketClean = toCleanString(bucket);
    if (!bucketClean || !merges.length) return Array.isArray(suggestionsList) ? suggestionsList : [];

    const relevant = merges
      .map((m) => normalizeModerationMerge(m))
      .filter((m) => m && m.bucket === bucketClean);
    if (!relevant.length) return Array.isArray(suggestionsList) ? suggestionsList : [];

    const fromTo = new Map();
    for (const m of relevant) fromTo.set(m.fromSuggestionId, m.intoSuggestionId);

    const byId = new Map();
    for (const s of Array.isArray(suggestionsList) ? suggestionsList : []) {
      const id = toCleanString(s?.id);
      if (!id) continue;
      byId.set(id, {
        ...s,
        upvotes: Array.isArray(s.upvotes) ? uniqueStrings(s.upvotes) : [],
        downvotes: Array.isArray(s.downvotes) ? uniqueStrings(s.downvotes) : [],
        comments: Array.isArray(s.comments) ? s.comments : []
      });
    }

    const removed = new Set();
    const mergeNotesByTarget = new Map(); // targetId -> string[]

    for (const m of relevant) {
      const fromId = m.fromSuggestionId;
      const targetId = resolveMergeTarget(fromId, fromTo);
      if (!targetId || targetId === fromId) continue;
      const from = byId.get(fromId);
      const into = byId.get(targetId);
      if (!from || !into) continue;

      const intoUp = new Set(ensureStringArray(into.upvotes));
      const intoDown = new Set(ensureStringArray(into.downvotes));
      for (const u of ensureStringArray(from.upvotes)) {
        if (intoUp.has(u) || intoDown.has(u)) continue;
        intoUp.add(u);
      }
      for (const u of ensureStringArray(from.downvotes)) {
        if (intoUp.has(u) || intoDown.has(u)) continue;
        intoDown.add(u);
      }
      into.upvotes = uniqueStrings([...intoUp]);
      into.downvotes = uniqueStrings([...intoDown]);

      // Note: Comments are NOT merged. Each suggestion keeps its own separate comment history.
      // After a merge, the target suggestion has a clean start for its own comments.

      removed.add(fromId);
      byId.set(targetId, into);

      const note = m.note || `Merged "${toCleanString(from.label)}" into "${toCleanString(into.label)}" by @${m.by}`;
      if (!mergeNotesByTarget.has(targetId)) mergeNotesByTarget.set(targetId, []);
      mergeNotesByTarget.get(targetId).push(note);
    }

    const out = [];
    for (const [id, s] of byId.entries()) {
      if (removed.has(id)) continue;
      const notes = mergeNotesByTarget.get(id) || null;
      out.push(notes ? { ...s, mergeNotes: notes.slice(0, 6) } : s);
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
      for (const s of existing) {
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

  vote(fieldKey, catIdx, suggestionId, direction) {
    const f = toCleanString(fieldKey);
    const idx = Number.isFinite(catIdx) ? Math.max(0, Math.floor(catIdx)) : 0;
    const id = toCleanString(suggestionId);
    const dir = direction === 'down' ? 'down' : 'up';
    const username = this._profile.username;
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

  getMyVote(fieldKey, catIdx, suggestionId) {
    const f = toCleanString(fieldKey);
    const idx = Number.isFinite(catIdx) ? Math.max(0, Math.floor(catIdx)) : 0;
    const sid = toCleanString(suggestionId);
    if (!f || !sid) return null;
    const key = suggestionKey(f, idx, sid);
    const v = this._state.myVotes?.[key] || null;
    return v === 'up' || v === 'down' ? v : null;
  }

  addComment(fieldKey, catIdx, suggestionId, text) {
    const f = toCleanString(fieldKey);
    const idx = Number.isFinite(catIdx) ? Math.max(0, Math.floor(catIdx)) : 0;
    const sid = toCleanString(suggestionId);
    const trimmedText = toCleanString(text);
    if (!f || !sid || !trimmedText) return null;

    const key = bucketKey(f, idx);
    const list = this._state.suggestions[key] || [];
    const suggestion = list.find((s) => s?.id === sid);
    if (!suggestion) return null;

    if (!Array.isArray(suggestion.comments)) suggestion.comments = [];
    if (suggestion.comments.length >= MAX_COMMENTS_PER_SUGGESTION) return null;

    const comment = normalizeComment({ text: trimmedText }, { authorUsername: this._profile.username });
    if (!comment) return null;

    suggestion.comments.push(comment);

    if (!this._state.myComments) this._state.myComments = {};
    if (!this._state.myComments[sid]) this._state.myComments[sid] = [];
    this._state.myComments[sid].push(comment);

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
    const suggestion = list.find((s) => s?.id === sid);
    if (!suggestion || !Array.isArray(suggestion.comments)) return false;

    const comment = suggestion.comments.find((c) => c?.id === cid);
    if (!comment) return false;
    if (!this.isMyComment(comment.authorUsername)) return false;

    comment.text = clampLen(trimmedText, MAX_COMMENT_LEN);
    comment.editedAt = nowIso();

    if (this._state.myComments?.[sid]) {
      const myComment = this._state.myComments[sid].find((c) => c?.id === cid);
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
    const suggestion = list.find((s) => s?.id === sid);
    if (!suggestion || !Array.isArray(suggestion.comments)) return false;

    const commentIndex = suggestion.comments.findIndex((c) => c?.id === cid);
    if (commentIndex < 0) return false;

    const comment = suggestion.comments[commentIndex];
    if (!this.isMyComment(comment.authorUsername)) return false;

    suggestion.comments.splice(commentIndex, 1);

    if (this._state.myComments?.[sid]) {
      this._state.myComments[sid] = this._state.myComments[sid].filter((c) => c?.id !== cid);
      if (this._state.myComments[sid].length === 0) delete this._state.myComments[sid];
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
    const suggestion = list.find((s) => s?.id === sid);
    if (!suggestion || !Array.isArray(suggestion.comments)) return [];

    return suggestion.comments.map((c) => ({ ...c }));
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
    this._state.moderationMerges = cleaned;
    this._remapMyVotesToMergeTargets();
    // Note: Comments are NOT remapped during merges - each suggestion keeps its own comment history.
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
    this._state.moderationMerges.push(entry);
    this._state.moderationMerges = this._state.moderationMerges.slice(0, 5000);
    this._remapMyVotesToMergeTargets();
    // Note: Comments are NOT remapped during merges - each suggestion keeps its own comment history.
    this._touch();
    return true;
  }

  buildModerationMergesDocument() {
    return {
      version: 1,
      updatedAt: nowIso(),
      merges: this.getModerationMerges()
    };
  }

  _remapMyVotesToMergeTargets() {
    const merges = Array.isArray(this._state.moderationMerges) ? this._state.moderationMerges : [];
    if (!merges.length) return;
    const fromToByBucket = new Map(); // bucket -> Map(fromId -> intoId)
    for (const mRaw of merges) {
      const m = normalizeModerationMerge(mRaw);
      if (!m) continue;
      if (!fromToByBucket.has(m.bucket)) fromToByBucket.set(m.bucket, new Map());
      fromToByBucket.get(m.bucket).set(m.fromSuggestionId, m.intoSuggestionId);
    }

    const nextVotes = { ...(this._state.myVotes || {}) };
    for (const [voteKey, dir] of Object.entries(nextVotes)) {
      const parsed = parseVoteKey(voteKey);
      if (!parsed) continue;
      const bucket = bucketKey(parsed.fieldKey, parsed.catIdx);
      const map = fromToByBucket.get(bucket);
      if (!map) continue;
      const target = resolveMergeTarget(parsed.suggestionId, map);
      if (!target || target === parsed.suggestionId) continue;
      const fromKey = suggestionKey(parsed.fieldKey, parsed.catIdx, parsed.suggestionId);
      const toKey = suggestionKey(parsed.fieldKey, parsed.catIdx, target);
      if (!nextVotes[toKey]) nextVotes[toKey] = dir;
      delete nextVotes[fromKey];
    }
    this._state.myVotes = nextVotes;
  }

  // Note: Comments are intentionally NOT remapped when suggestions are merged.
  // Each suggestion keeps its own separate comment history - after a merge,
  // the target suggestion has a clean start for new comments.

  /**
   * Compute consensus for a field/category bucket.
   * @returns {{status:'pending'|'disputed'|'consensus', label:string|null, confidence:number, voters:number, netVotes:number, suggestionId:string|null}}
   */
  computeConsensus(fieldKey, catIdx, { minAnnotators = 3, threshold = 0.7 } = {}) {
    const f = toCleanString(fieldKey);
    const idx = Number.isFinite(catIdx) ? Math.max(0, Math.floor(catIdx)) : 0;
    const key = bucketKey(f, idx);
    const list = this._applyModerationMergesForBucket(key, this._state.suggestions[key] || []);
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

    const commentsOut = {};
    for (const [suggestionId, commentList] of Object.entries(this._state.myComments || {})) {
      if (!Array.isArray(commentList) || !suggestionId) continue;
      const normalized = normalizeCommentArray(commentList);
      if (normalized.length) commentsOut[suggestionId] = normalized;
    }

    return {
      version: 1,
      username,
      displayName: profile.displayName || undefined,
      title: profile.title || undefined,
      orcid: profile.orcid || undefined,
      updatedAt: nowIso(),
      suggestions: suggestionsOut,
      votes: votesOut,
      comments: commentsOut
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
    const myUsername = this._profile?.username || 'local';
    const knownProfiles = this._knownProfiles && typeof this._knownProfiles === 'object' ? this._knownProfiles : {};

    // 0) Capture optional public profile info from user docs (displayName/title/orcid).
    // This is local-only UI metadata (not pushed anywhere by the app).
    // Limit growth to avoid unbounded localStorage usage.
    const KNOWN_PROFILE_LIMIT = 500;
    for (const doc of (Array.isArray(userDocs) ? userDocs : []).slice(0, 2000)) {
      const username = toCleanString(doc?.username).replace(/^@+/, '');
      const u = normalizeUsername(username);
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
      const hasAny = Boolean(mine.displayName || mine.title || mine.orcid);
      if (!hasAny) {
        for (const doc of (Array.isArray(userDocs) ? userDocs : []).slice(0, 2000)) {
          const username = toCleanString(doc?.username).replace(/^@+/, '');
          if (!username) continue;
          if (normalizeUsername(username) !== normalizeUsername(myUsername)) continue;
          this._profile = sanitizeProfile({
            username: myUsername,
            displayName: doc?.displayName || '',
            title: doc?.title || '',
            orcid: doc?.orcid || ''
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
      const docUsername = toCleanString(doc.username).replace(/^@+/, '');
      // Skip local user's remote comments (prefer local state)
      if (docUsername === myUsername) continue;

      const comments = doc.comments && typeof doc.comments === 'object' ? doc.comments : {};
      for (const [suggestionId, commentList] of Object.entries(comments)) {
        if (!Array.isArray(commentList)) continue;
        for (const c of commentList.slice(0, MAX_COMMENTS_PER_SUGGESTION)) {
          addComment(suggestionId, c);
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
    this._profile = sanitizeProfile(next.profile || {});
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
