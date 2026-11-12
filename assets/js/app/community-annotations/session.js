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
import { toCleanString } from '../../utils/clean-string.js';
import {
  annotationSuggestionIdOwner,
  assertAnnotationBucket,
  assertConfigDocument,
  assertMergesDocument,
  assertUtcDateTime,
  assertUserDocument,
  exactLabelForCompare,
  hasAnnotationSuggestionIdDelimiter,
  isAnnotationExactNonblank,
  isExactLinkedInHandle,
  isExactOrcidId,
  isReservedAnnotationFieldKey,
  parseExactJson,
} from './wire-contract.js';
import { throwIfAborted, requireSignalOrNull } from '../../utils/abort.js';
import { webStorage } from '../../utils/web-storage.js';

/**
 * The local state format. 2: suggestion ids carry their owner
 * (`ghid_<n>_...`, user file version 3) and only the SHAs the session reads
 * are kept. A state written in another format is reported, never read.
 */
const STORAGE_VERSION = 2;

/** The remote files whose SHAs the session reads: config, merges and the current user's own file. */
const SESSION_SHA_PATHS = Object.freeze([
  'annotations/config.json',
  'annotations/moderation/merges.json',
]);

const DEFAULT_MIN_ANNOTATORS = 1;
const DEFAULT_CONSENSUS_THRESHOLD = 0.5;

// Bucket and vote keys use ":" as a delimiter. Field keys can contain ":" in other
// parts of the app, so we escape fieldKey only when needed to keep keys unambiguous
// without changing the common case.
const FIELDKEY_ESCAPE_PREFIX = 'fk~';

/** Code-unit order: what anything written or exported is sorted by (the same bytes in every locale). */
function compareCodeUnits(left, right) {
  return left < right ? -1 : (left > right ? 1 : 0);
}

/** A contract timestamp as an instant (milliseconds), so `...:00Z` and `...:00.000Z` compare equal. */
function instantOf(value) {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeGitHubUserIdOrNull(userId) {
  if (!Number.isSafeInteger(userId) || userId < 1) return null;
  return userId;
}

function toFileUserKeyFromId(userId) {
  const id = normalizeGitHubUserIdOrNull(userId);
  return id ? `ghid_${id}` : null;
}

function randomId() {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    throw new Error('[CommunityAnnotationSession] crypto.randomUUID is required');
  }
  return crypto.randomUUID();
}

/**
 * A new suggestion id: its owner's identity, then a random UUID
 * (`ghid_<n>_<uuid>`). The owner prefix is the contract's (user file
 * version 3): no file can hold, or forge, another user's suggestion id.
 */
function createSuggestionId(owner) {
  if (!/^ghid_[1-9][0-9]*$/.test(owner)) {
    const error = new Error(
      '[CommunityAnnotationSession] proposing a label requires your GitHub identity; sign in first'
    );
    error.code = 'COMMUNITY_ANNOTATION_IDENTITY_REQUIRED';
    throw error;
  }
  return `${owner}_${randomId()}`;
}

/**
 * Contributor text has no length limit of its own: the annotation file's
 * 1,000,000 bytes bound it (`ANNOTATION_FILE_MAX_UTF8_BYTES`, checked when
 * the file is composed for publishing).
 */
function assertOptionalString(text, fieldName = 'value') {
  if (text === null || text === undefined) return '';
  if (typeof text !== 'string') {
    throw new Error(`[CommunityAnnotationSession] ${fieldName} must be a string`);
  }
  return text;
}

/** An empty string, or text whose first and last characters are not whitespace (the contract's class). */
function assertExactOrEmpty(text, fieldName) {
  if (text && !isAnnotationExactNonblank(text)) {
    throw new Error(
      `[CommunityAnnotationSession] ${fieldName} must not have leading or trailing whitespace`
    );
  }
  return text;
}

function assertExactNonblankString(value, fieldName = 'value') {
  const text = assertOptionalString(value, fieldName);
  if (!isAnnotationExactNonblank(text)) {
    throw new Error(
      `[CommunityAnnotationSession] ${fieldName} must be nonblank without leading or trailing whitespace`
    );
  }
  return text;
}

function assertOptionalExactNonblankString(value, fieldName = 'value') {
  if (value === null) return null;
  return assertExactNonblankString(value, fieldName);
}

function assertSessionFieldKey(value, fieldName = 'fieldKey') {
  const field = assertExactNonblankString(value, fieldName);
  if (isReservedAnnotationFieldKey(field)) {
    throw new Error(
      `[CommunityAnnotationSession] ${fieldName} uses the reserved ` +
      'fk~...%3A field-key encoding form'
    );
  }
  return field;
}

function assertSessionSuggestionId(value, fieldName = 'suggestionId') {
  const id = assertExactNonblankString(value, fieldName);
  if (hasAnnotationSuggestionIdDelimiter(id)) {
    throw new Error(
      `[CommunityAnnotationSession] ${fieldName} must not contain the ":" ` +
      'suggestion-id delimiter'
    );
  }
  return id;
}

function exactNonblankStringOrNull(value) {
  return typeof value === 'string' && isAnnotationExactNonblank(value) ? value : null;
}

function encodeFieldKeyForKey(fieldKey) {
  const f = assertSessionFieldKey(fieldKey);
  if (!f.includes(':')) return f;
  return `${FIELDKEY_ESCAPE_PREFIX}${encodeURIComponent(f)}`;
}

function decodeFieldKeyFromKey(fieldKeyPart) {
  const raw = toCleanString(fieldKeyPart);
  if (!raw.startsWith(FIELDKEY_ESCAPE_PREFIX)) return raw;
  const encoded = raw.slice(FIELDKEY_ESCAPE_PREFIX.length);
  // Only treat as our encoding when a ":" was present (encodeURIComponent produces "%3A").
  if (!/%3a/i.test(encoded)) return raw;
  return decodeURIComponent(encoded);
}

function ensureStringArray(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error('[CommunityAnnotationSession] expected an array of strings');
  }
  value.forEach((item) => {
    if (typeof item !== 'string' || !item) {
      throw new Error('[CommunityAnnotationSession] expected an array of nonempty strings');
    }
  });
  return [...value];
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

function createExactRecord() {
  return Object.create(null);
}

function cloneExactRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`[CommunityAnnotationSession] ${label} must be an object`);
  }
  const out = createExactRecord();
  for (const [key, entry] of Object.entries(value)) {
    out[key] = entry;
  }
  return out;
}

function toPlainOwnRecord(value) {
  return Object.fromEntries(Object.entries(value));
}

function parseDateMsOrNull(value) {
  const s = toCleanString(value);
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

function cloneDatasetAccessMap(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    throw new Error('[CommunityAnnotationSession] datasets must be an object');
  }
  const out = createExactRecord();
  for (const [datasetId, entry] of Object.entries(map)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(
        `[CommunityAnnotationSession] dataset access ${JSON.stringify(datasetId)} must be an object`
      );
    }
    if (!Array.isArray(entry.fieldsToAnnotate)) {
      throw new Error(
        `[CommunityAnnotationSession] dataset access ${JSON.stringify(datasetId)} fieldsToAnnotate must be an array`
      );
    }
    out[datasetId] = {
      fieldsToAnnotate: [...entry.fieldsToAnnotate],
      lastAccessedAt: entry.lastAccessedAt,
    };
  }
  assertUserDocument(
    {
      version: 1,
      username: 'ghid_1',
      githubUserId: 1,
      updatedAt: nowIso(),
      datasets: out,
      suggestions: {},
      votes: {},
    },
    { path: '$ dataset access state', filename: 'ghid_1.json' }
  );
  return out;
}

function mergeDatasetAccessMaps(left, right) {
  const a = cloneDatasetAccessMap(left);
  const b = cloneDatasetAccessMap(right);
  const out = cloneExactRecord(a, 'datasets state');
  for (const [datasetId, entry] of Object.entries(b)) {
    const prev = Object.hasOwn(out, datasetId) ? out[datasetId] : null;
    if (!prev) {
      out[datasetId] = entry;
      continue;
    }
    const prevMs = parseDateMsOrNull(prev.lastAccessedAt);
    const nextMs = parseDateMsOrNull(entry.lastAccessedAt);
    out[datasetId] = nextMs >= prevMs ? entry : prev;
  }

  return out;
}

function sanitizeProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error('[CommunityAnnotationSession] profile must be an object');
  }
  const allowedFields = new Set([
    'username',
    'login',
    'githubUserId',
    'displayName',
    'title',
    'orcid',
    'linkedin',
  ]);
  for (const field of Object.keys(profile)) {
    if (!allowedFields.has(field)) {
      throw new Error(
        `[CommunityAnnotationSession] profile contains unknown field ${JSON.stringify(field)}`
      );
    }
  }
  const username = normalizeUsername(profile?.username ?? '') || 'local';
  const login = assertOptionalString(profile?.login ?? '', 'login');
  const githubUserIdRaw = profile?.githubUserId;
  let githubUserId = null;
  if (githubUserIdRaw !== null && githubUserIdRaw !== undefined) {
    if (!Number.isSafeInteger(githubUserIdRaw) || githubUserIdRaw < 1) {
      throw new Error(
        '[CommunityAnnotationSession] githubUserId must be null or a positive safe integer'
      );
    }
    githubUserId = githubUserIdRaw;
  }
  const displayName = assertOptionalString(profile?.displayName ?? '', 'displayName');
  const title = assertOptionalString(profile?.title ?? '', 'title');
  const orcid = assertOptionalString(profile?.orcid ?? '', 'orcid');
  const linkedin = assertOptionalString(profile?.linkedin ?? '', 'linkedin');
  for (const [field, value] of [
    ['login', login],
    ['displayName', displayName],
    ['title', title],
    ['orcid', orcid],
  ]) {
    assertExactOrEmpty(value, field);
  }
  if (githubUserId === null && username !== 'local') {
    throw new Error(
      '[CommunityAnnotationSession] username must be "local" without a GitHub user id'
    );
  }
  if (githubUserId !== null && username !== `ghid_${githubUserId}`) {
    throw new Error(
      '[CommunityAnnotationSession] username must match the GitHub user id'
    );
  }
  if (linkedin && !isExactLinkedInHandle(linkedin)) {
    throw new Error(
      '[CommunityAnnotationSession] linkedin must be a lowercase LinkedIn handle'
    );
  }
  if (orcid && !isExactOrcidId(orcid)) {
    throw new Error(
      '[CommunityAnnotationSession] orcid must be an exact checksum-valid ORCID iD'
    );
  }
  return { username, login, githubUserId, displayName, title, orcid, linkedin };
}

function sanitizeKnownUserProfile(input) {
  const login = assertOptionalString(input?.login ?? '', 'login');
  const displayName = assertOptionalString(input?.displayName ?? '', 'displayName');
  const title = assertOptionalString(input?.title ?? '', 'title');
  const orcid = assertOptionalString(input?.orcid ?? '', 'orcid');
  const linkedin = assertOptionalString(input?.linkedin ?? '', 'linkedin');
  if (orcid && !isExactOrcidId(orcid)) {
    throw new Error(
      '[CommunityAnnotationSession] known profile orcid must be an exact checksum-valid ORCID iD'
    );
  }
  if (linkedin && !isExactLinkedInHandle(linkedin)) {
    throw new Error(
      '[CommunityAnnotationSession] known profile linkedin must be a lowercase LinkedIn handle'
    );
  }
  if (!login && !displayName && !title && !orcid && !linkedin) return null;
  return { login, displayName, title, orcid, linkedin };
}

function normalizeUsername(username) {
  if (username === null || username === undefined || username === '') return '';
  if (username === 'local') return username;
  if (
    typeof username !== 'string' ||
    !/^ghid_[1-9][0-9]*$/.test(username)
  ) {
    throw new Error(
      '[CommunityAnnotationSession] username must equal "local" or an exact ghid identity'
    );
  }
  const id = Number(username.slice(5));
  if (
    !Number.isSafeInteger(id) ||
    id < 1 ||
    username !== `ghid_${id}`
  ) {
    throw new Error(
      '[CommunityAnnotationSession] username must equal "local" or an exact ghid identity'
    );
  }
  return username;
}

function normalizeConsensusSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('[CommunityAnnotationSession] consensus settings must be an object');
  }
  const keys = Object.keys(input);
  if (
    keys.length !== 2 ||
    !Object.hasOwn(input, 'minAnnotators') ||
    !Object.hasOwn(input, 'threshold')
  ) {
    throw new Error(
      '[CommunityAnnotationSession] consensus settings must contain exactly minAnnotators and threshold'
    );
  }
  if (
    !Number.isSafeInteger(input.minAnnotators) ||
    input.minAnnotators < 0
  ) {
    throw new Error(
      '[CommunityAnnotationSession] minAnnotators must be a non-negative integer'
    );
  }
  if (
    typeof input.threshold !== 'number' ||
    !Number.isFinite(input.threshold) ||
    input.threshold < -1 ||
    input.threshold > 1
  ) {
    throw new Error(
      '[CommunityAnnotationSession] threshold must be a finite number from -1 through 1'
    );
  }
  return { minAnnotators: input.minAnnotators, threshold: input.threshold };
}

function normalizeMarkers(input) {
  if (input === null || input === undefined) return null;
  if (!Array.isArray(input)) {
    throw new Error('[CommunityAnnotationSession] markers must be an array or null');
  }
  const out = [];
  for (const raw of input) {
    if (typeof raw === 'string') {
      if (!isAnnotationExactNonblank(raw)) {
        throw new Error(
          '[CommunityAnnotationSession] marker strings must be nonblank without leading or trailing whitespace'
        );
      }
      out.push(raw);
      continue;
    }
    if (raw && typeof raw === 'object') {
      const unknown = Object.keys(raw).filter(
        (key) => key !== 'gene' && key !== 'logFC' && key !== 'pval'
      );
      if (unknown.length) {
        throw new Error(
          `[CommunityAnnotationSession] marker contains unknown field ${JSON.stringify(unknown[0])}`
        );
      }
      const gene = raw.gene;
      if (typeof gene !== 'string' || !isAnnotationExactNonblank(gene)) {
        throw new Error(
          '[CommunityAnnotationSession] marker gene must be nonblank without leading or trailing whitespace'
        );
      }
      const entry = { gene };
      const logFC = raw.logFC;
      const pval = raw.pval;
      if (Object.hasOwn(raw, 'logFC')) {
        if (typeof logFC !== 'number' || !Number.isFinite(logFC)) {
          throw new Error('[CommunityAnnotationSession] marker logFC must be a finite number');
        }
        entry.logFC = logFC;
      }
      if (Object.hasOwn(raw, 'pval')) {
        if (typeof pval !== 'number' || !Number.isFinite(pval)) {
          throw new Error('[CommunityAnnotationSession] marker pval must be a finite number');
        }
        entry.pval = pval;
      }
      out.push(entry);
      continue;
    }
    throw new Error('[CommunityAnnotationSession] each marker must be a string or object');
  }
  return out;
}

function normalizeSuggestion(input, { proposedBy } = {}) {
  const label = assertExactNonblankString(input?.label, 'label');
  const ontologyId = assertExactOrEmpty(assertOptionalString(input?.ontologyId, 'ontologyId'), 'ontologyId');
  const evidence = assertExactOrEmpty(assertOptionalString(input?.evidence, 'evidence'), 'evidence');
  const owner = normalizeUsername(proposedBy || input?.proposedBy || 'local') || 'local';

  const upvotes = uniqueStrings(ensureStringArray(input?.upvotes).map((u) => normalizeUsername(u)).filter(Boolean));
  const upSet = new Set(upvotes);
  const downvotes = uniqueStrings(
    ensureStringArray(input?.downvotes)
      .map((u) => normalizeUsername(u))
      .filter((u) => u && !upSet.has(u))
  );

  return {
    id: createSuggestionId(owner),
    label,
    ontologyId: ontologyId || null,
    evidence: evidence || null,
    proposedBy: owner,
    proposedAt: nowIso(),
    editedAt: null,
    upvotes,
    downvotes,
    markers: normalizeMarkers(input?.markers),
    comments: []
  };
}

function normalizeComment(input, { authorUsername } = {}) {
  const text = assertExactNonblankString(input?.text, 'comment text');

  const author = normalizeUsername(authorUsername || input?.authorUsername || 'local') || 'local';
  const id = input?.id === undefined
    ? randomId()
    : assertExactNonblankString(input.id, 'comment id');
  const createdAt = input?.createdAt === undefined
    ? nowIso()
    : assertUtcDateTime(input.createdAt, '$ comment createdAt');
  const editedAt =
    input?.editedAt === undefined || input.editedAt === null
      ? null
      : assertUtcDateTime(input.editedAt, '$ comment editedAt');

  return { id, text, authorUsername: author, createdAt, editedAt };
}

function suggestionKey(fieldKey, catKey, suggestionId) {
  const id = assertSessionSuggestionId(suggestionId);
  return `${encodeFieldKeyForKey(fieldKey)}:${catKey}:${id}`;
}

function bucketKey(fieldKey, catKey) {
  return assertAnnotationBucket(
    `${encodeFieldKeyForKey(fieldKey)}:${catKey}`,
    '$ session bucket'
  );
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

/**
 * Validate a whole moderation-merge list once: one merge per (bucket, from),
 * no cycles, every field exact (the contract's merges view). Every list the
 * session keeps passed through here, so nothing that reads it validates again.
 */
function assertModerationMerges(merges, path = '$ moderation merges') {
  if (!Array.isArray(merges)) {
    throw new Error('[CommunityAnnotationSession] moderation merges must be an array');
  }
  assertMergesDocument({ version: 1, updatedAt: nowIso(), merges }, { path });
  return merges;
}

/** A validated merge list in its written order: by bucket, then source id, in code units. */
function compactModerationMerges(merges) {
  assertModerationMerges(merges);
  return merges
    .map((entry) => ({ ...entry }))
    .sort((a, b) =>
      compareCodeUnits(a.bucket, b.bucket) ||
      compareCodeUnits(a.fromSuggestionId, b.fromSuggestionId)
    );
}

function resolveMergeTarget(fromId, fromToMap) {
  let cur = fromId;
  const seen = new Set([cur]);
  while (fromToMap.has(cur)) {
    const next = fromToMap.get(cur);
    if (seen.has(next)) return null; // cycle (a validated list has none)
    seen.add(next);
    cur = next;
  }
  return cur;
}

/**
 * The merge map of every bucket (from id -> into id) of a validated merge
 * list. A list holds one merge per (bucket, from), so the map is the list.
 */
function buildMergeMapsByBucket(merges) {
  /** @type {Map<string, Map<string, string>>} */
  const out = new Map();
  for (const merge of merges) {
    let map = out.get(merge.bucket);
    if (map === undefined) {
      map = new Map();
      out.set(merge.bucket, map);
    }
    map.set(merge.fromSuggestionId, merge.intoSuggestionId);
  }
  return out;
}

const EMPTY_MERGE_MAP = Object.freeze(new Map());

/**
 * The consensus of one bucket's bundled suggestions (`_bucketView`).
 *
 * The leader has the most net votes (up - down), then the most up votes.
 * `confidence` = leader's net votes / unique voters of the bucket. Fewer
 * voters than `minAnnotators`, or no voter at all, is `pending` (zero voters
 * never make a consensus, whatever the settings); a tie for the lead is
 * `disputed`; otherwise `consensus` when confidence reaches `threshold`.
 */
function consensusOf(list, settings) {
  if (!list.length) {
    return { status: 'pending', label: null, confidence: 0, voters: 0, netVotes: 0, suggestionId: null };
  }
  let bestNet = null;
  let bestUp = null;
  const leaders = [];
  for (const s of list) {
    const up = s.upvotes.length;
    const net = up - s.downvotes.length;
    if (bestNet === null || net > bestNet || (net === bestNet && up > bestUp)) {
      bestNet = net;
      bestUp = up;
      leaders.length = 0;
      leaders.push(s);
    } else if (net === bestNet && up === bestUp) {
      leaders.push(s);
    }
  }
  // Bundles have distinct labels, so tied leaders name distinct labels.
  const label = leaders.map((s) => s.label).sort(compareCodeUnits).join(', ');
  const isTie = leaders.length > 1;
  const suggestionId = isTie ? null : leaders[0].id;

  const voterSet = new Set();
  for (const s of list) {
    for (const u of s.upvotes) voterSet.add(u);
    for (const u of s.downvotes) voterSet.add(u);
  }
  const voters = voterSet.size;
  if (voters === 0 || voters < settings.minAnnotators) {
    return { status: 'pending', label, confidence: 0, voters, netVotes: bestNet, suggestionId };
  }
  // Net support share (-1..1) of the unique voters of the bucket.
  const confidence = bestNet / voters;
  // A tie is always disputed: no single label leads.
  const status = (!isTie && confidence >= settings.threshold) ? 'consensus' : 'disputed';
  return { status, label, confidence, voters, netVotes: bestNet, suggestionId };
}

/** A comment's last write (edit, else creation) as an instant. */
function commentInstant(comment) {
  return instantOf(comment.editedAt || comment.createdAt) ?? -Infinity;
}

/** Comments in creation order (instants; then author and id in code units, so every browser writes one order). */
function commentOrder(a, b) {
  return ((instantOf(a.createdAt) ?? 0) - (instantOf(b.createdAt) ?? 0)) ||
    compareCodeUnits(a.authorUsername, b.authorUsername) ||
    compareCodeUnits(a.id, b.id);
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
  const left = existing || null;
  const right = incoming || null;
  if (!left && !right) return null;
  let selected = right || left;
  if (left && right) {
    const leftTime = Date.parse(left.editedAt || left.proposedAt);
    const rightTime = Date.parse(right.editedAt || right.proposedAt);
    selected = rightTime > leftTime || (rightTime === leftTime && preferIncoming)
      ? right
      : left;
  }
  return cloneWireSuggestion(selected);
}

function cloneWireSuggestion(suggestion) {
  if (!suggestion || typeof suggestion !== 'object' || Array.isArray(suggestion)) {
    throw new Error('[CommunityAnnotationSession] suggestion must be an object');
  }
  const allowed = new Set([
    'id',
    'label',
    'ontologyId',
    'evidence',
    'markers',
    'proposedBy',
    'proposedAt',
    'editedAt',
    'upvotes',
    'downvotes',
    'comments',
  ]);
  for (const key of Object.keys(suggestion)) {
    if (!allowed.has(key)) {
      throw new Error(
        `[CommunityAnnotationSession] suggestion contains unknown field ${JSON.stringify(key)}`
      );
    }
  }
  const out = {
    id: assertSessionSuggestionId(suggestion.id, 'suggestion id'),
    label: suggestion.label,
    proposedBy: suggestion.proposedBy,
    proposedAt: suggestion.proposedAt,
  };
  for (const field of ['ontologyId', 'evidence', 'editedAt']) {
    if (Object.hasOwn(suggestion, field)) out[field] = suggestion[field];
  }
  if (Object.hasOwn(suggestion, 'markers')) {
    out.markers = Array.isArray(suggestion.markers)
      ? suggestion.markers.map((marker) =>
        typeof marker === 'string' ? marker : { ...marker }
      )
      : suggestion.markers;
  }
  return out;
}

function defaultState() {
  return {
    version: STORAGE_VERSION,
    updatedAt: nowIso(),
    annotationFields: [],
    annotatableSettings: createExactRecord(), // { [fieldKey]: { minAnnotators:number, threshold:number } }
    closedAnnotatableFields: createExactRecord(), // { [fieldKey]: true }
    datasets: createExactRecord(), // { [datasetId]: { fieldsToAnnotate:string[], lastAccessedAt:string } } (informational)
    // Persisted locally so profile edits survive refresh until Publish.
    profile: sanitizeProfile({}),
    suggestions: {}, // { [fieldKey:categoryLabel]: Suggestion[] }
    deletedSuggestions: {}, // { [fieldKey:categoryLabel]: string[] } (only the proposer can delete)
    myVotes: {}, // { [fieldKey:categoryLabel:suggestionId]: 'up'|'down' }
    myComments: createExactRecord(), // { [suggestionId]: Comment[] }
    moderationMerges: [], // { bucket, fromSuggestionId, intoSuggestionId, by, at, note }[]
    // Used to enable incremental GitHub pulls (only fetch files whose sha changed).
    remoteFileShas: {}, // { [path]: sha }
    lastSyncAt: null
  };
}

function restoreExactIdentityRecords(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('[CommunityAnnotationSession] state must be an object');
  }
  state.annotatableSettings = cloneExactRecord(
    state.annotatableSettings,
    'consensus settings state'
  );
  state.closedAnnotatableFields = cloneExactRecord(
    state.closedAnnotatableFields,
    'closed field state'
  );
  state.datasets = cloneExactRecord(
    state.datasets,
    'datasets state'
  );
  state.myComments = cloneExactRecord(
    state.myComments,
    'local comments state'
  );
  return state;
}

function cloneStateForTransaction(state) {
  return restoreExactIdentityRecords(
    JSON.parse(JSON.stringify(state))
  );
}

const LOCAL_STATE_FIELDS = Object.freeze([
  'version',
  'updatedAt',
  'annotationFields',
  'annotatableSettings',
  'closedAnnotatableFields',
  'datasets',
  'profile',
  'myVotes',
  'myComments',
  'moderationMerges',
  'remoteFileShas',
  'lastSyncAt',
  'suggestions',
  'deletedSuggestions',
]);

function assertLocalRecord(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path}: must be a JSON object`);
  }
  return value;
}

function assertExactLocalFields(value, path, fields) {
  const object = assertLocalRecord(value, path);
  const expected = new Set(fields);
  for (const key of Object.keys(object)) {
    if (!expected.has(key)) throw new Error(`${path}: unknown field ${JSON.stringify(key)}`);
  }
  for (const key of fields) {
    if (!Object.hasOwn(object, key)) {
      throw new Error(`${path}: missing required field ${JSON.stringify(key)}`);
    }
  }
  return object;
}

/**
 * A map of repository paths to Git blob SHAs. `ownPath` given (the SHAs the
 * session keeps): only config, merges and that user file; otherwise (SHAs a
 * Pull hands in) any annotation file.
 */
function assertRemoteFileShaMap(value, path = '$ remote file SHAs', { ownPath } = {}) {
  const map = assertLocalRecord(value, path);
  for (const [filePath, sha] of Object.entries(map)) {
    const supportedPath = ownPath === undefined
      ? SESSION_SHA_PATHS.includes(filePath) || /^annotations\/users\/ghid_[1-9][0-9]*\.json$/.test(filePath)
      : SESSION_SHA_PATHS.includes(filePath) || filePath === ownPath;
    if (
      !supportedPath ||
      typeof sha !== 'string' ||
      !/^[0-9a-f]{40}$/.test(sha)
    ) {
      throw new Error(`${path}: contains an invalid path or SHA`);
    }
  }
  return map;
}

/** The current user's own file path for a profile, or null without a GitHub identity. */
function ownUserFilePath(username) {
  return /^ghid_[1-9][0-9]*$/.test(username) ? `annotations/users/${username}.json` : null;
}

function assertLocalProfile(value, scopeUserId) {
  const profile = assertExactLocalFields(value, '$ local state.profile', [
    'username',
    'login',
    'githubUserId',
    'displayName',
    'title',
    'orcid',
    'linkedin',
  ]);
  if (typeof profile.username !== 'string' || !profile.username) {
    throw new Error('$ local state.profile.username: must be a nonempty string');
  }
  for (const field of ['login', 'displayName', 'title', 'orcid', 'linkedin']) {
    if (typeof profile[field] !== 'string') {
      throw new Error(`$ local state.profile.${field}: must be a string`);
    }
    if (profile[field] && !isAnnotationExactNonblank(profile[field])) {
      throw new Error(
        `$ local state.profile.${field}: must be nonblank without edge whitespace`
      );
    }
  }
  if (
    profile.githubUserId !== null &&
    (!Number.isSafeInteger(profile.githubUserId) || profile.githubUserId < 1)
  ) {
    throw new Error(
      '$ local state.profile.githubUserId: must be null or a positive safe integer'
    );
  }
  if (profile.githubUserId !== null) {
    const expected = `ghid_${profile.githubUserId}`;
    if (profile.username !== expected) {
      throw new Error(
        `$ local state.profile.username: must equal ${JSON.stringify(expected)}`
      );
    }
  } else if (profile.username !== 'local') {
    throw new Error(
      '$ local state.profile.username: must equal "local" when githubUserId is null'
    );
  }
  if (scopeUserId !== null && profile.githubUserId !== scopeUserId) {
    throw new Error(
      '$ local state.profile.githubUserId: does not match the active cache scope'
    );
  }
  if (profile.linkedin && !isExactLinkedInHandle(profile.linkedin)) {
    throw new Error('$ local state.profile.linkedin: has an invalid format');
  }
  if (profile.orcid && !isExactOrcidId(profile.orcid)) {
    throw new Error(
      '$ local state.profile.orcid: must be an exact checksum-valid ORCID iD'
    );
  }
  return profile;
}

function assertLocalPersistenceDocument(value, { scopeUserId = null } = {}) {
  const document = assertExactLocalFields(value, '$ local state', LOCAL_STATE_FIELDS);
  if (document.version !== STORAGE_VERSION) {
    throw new Error(`$ local state.version: must equal ${STORAGE_VERSION}`);
  }
  assertUtcDateTime(document.updatedAt, '$ local state.updatedAt');
  const profile = assertLocalProfile(document.profile, scopeUserId);

  if (!Array.isArray(document.annotationFields)) {
    throw new Error('$ local state.annotationFields: must be an array');
  }
  const annotationFieldSet = new Set();
  document.annotationFields.forEach((field, index) => {
    if (
      typeof field !== 'string' ||
      !isAnnotationExactNonblank(field)
    ) {
      throw new Error(
        `$ local state.annotationFields[${index}]: must be a nonblank string`
      );
    }
    if (annotationFieldSet.has(field)) {
      throw new Error(`$ local state.annotationFields[${index}]: is duplicated`);
    }
    annotationFieldSet.add(field);
  });

  const closedMap = assertLocalRecord(
    document.closedAnnotatableFields,
    '$ local state.closedAnnotatableFields'
  );
  const closedFields = [];
  for (const [field, closed] of Object.entries(closedMap)) {
    if (closed !== true || !annotationFieldSet.has(field)) {
      throw new Error(
        `$ local state.closedAnnotatableFields[${JSON.stringify(field)}]: ` +
        'must equal true for an annotatable field'
      );
    }
    closedFields.push(field);
  }
  if (document.annotationFields.length) {
    assertConfigDocument(
      {
        version: 1,
        supportedDatasets: [
          {
            datasetId: 'local',
            name: 'Local state',
            fieldsToAnnotate: document.annotationFields,
            annotatableSettings: document.annotatableSettings,
            closedFields,
          },
        ],
      },
      { path: '$ local state annotation config' }
    );
  } else {
    const settings = assertLocalRecord(
      document.annotatableSettings,
      '$ local state.annotatableSettings'
    );
    if (Object.keys(settings).length || closedFields.length) {
      throw new Error(
        '$ local state annotation settings and closed fields must be empty when no fields are annotatable'
      );
    }
  }

  const localUsername = profile.username;
  const validationId = profile.githubUserId || 1;
  const validationUsername = `ghid_${validationId}`;
  const suggestions = assertLocalRecord(document.suggestions, '$ local state.suggestions');
  const wireSuggestions = {};
  const localSuggestionBucketById = new Map();
  for (const [bucket, list] of Object.entries(suggestions)) {
    if (!Array.isArray(list)) {
      throw new Error(
        `$ local state.suggestions[${JSON.stringify(bucket)}]: must be an array`
      );
    }
    const bucketParts = parseBucketKey(bucket);
    if (!bucketParts) {
      throw new Error(
        `$ local state.suggestions: invalid bucket ${JSON.stringify(bucket)}`
      );
    }
    const canonicalBucket = bucketKey(
      bucketParts.fieldKey,
      bucketParts.catKey
    );
    wireSuggestions[bucket] = list.map((suggestion, index) => {
      if (!suggestion || typeof suggestion !== 'object' || Array.isArray(suggestion)) {
        throw new Error(
          `$ local state.suggestions[${JSON.stringify(bucket)}][${index}]: must be an object`
        );
      }
      if (suggestion.proposedBy !== localUsername) {
        throw new Error(
          `$ local state.suggestions[${JSON.stringify(bucket)}][${index}].proposedBy: ` +
          `must equal ${JSON.stringify(localUsername)}`
        );
      }
      const suggestionId = assertSessionSuggestionId(
        suggestion.id,
        `$ local state suggestion id`
      );
      if (!localSuggestionBucketById.has(suggestionId)) {
        localSuggestionBucketById.set(suggestionId, canonicalBucket);
      }
      return { ...suggestion, proposedBy: validationUsername };
    });
  }

  const myVotes = assertLocalRecord(document.myVotes, '$ local state.myVotes');
  const wireVotes = createExactRecord();
  for (const [key, direction] of Object.entries(myVotes)) {
    const parsed = parseVoteKey(key);
    if (!parsed) throw new Error(`$ local state.myVotes: invalid key ${JSON.stringify(key)}`);
    const referencedLocalBucket =
      localSuggestionBucketById.get(parsed.suggestionId) ?? null;
    if (
      referencedLocalBucket !== null &&
      referencedLocalBucket !== bucketKey(parsed.fieldKey, parsed.catKey)
    ) {
      throw new Error(
        `$ local state.myVotes: key ${JSON.stringify(key)} does not reference ` +
        'its local suggestion in the exact bucket'
      );
    }
    if (direction !== 'up' && direction !== 'down') {
      throw new Error(
        `$ local state.myVotes[${JSON.stringify(key)}]: must equal "up" or "down"`
      );
    }
    if (
      Object.hasOwn(wireVotes, parsed.suggestionId) &&
      wireVotes[parsed.suggestionId] !== direction
    ) {
      throw new Error(
        `$ local state.myVotes: conflicting votes for ${JSON.stringify(parsed.suggestionId)}`
      );
    }
    wireVotes[parsed.suggestionId] = direction;
  }

  const myComments = assertLocalRecord(document.myComments, '$ local state.myComments');
  const wireComments = createExactRecord();
  for (const [suggestionId, list] of Object.entries(myComments)) {
    assertSessionSuggestionId(
      suggestionId,
      `$ local state.myComments key`
    );
    if (!Array.isArray(list)) {
      throw new Error(
        `$ local state.myComments[${JSON.stringify(suggestionId)}]: must be an array`
      );
    }
    wireComments[suggestionId] = list.map((comment, index) => {
      if (!comment || typeof comment !== 'object' || Array.isArray(comment)) {
        throw new Error(
          `$ local state.myComments[${JSON.stringify(suggestionId)}][${index}]: must be an object`
        );
      }
      if (comment.authorUsername !== localUsername) {
        throw new Error(
          `$ local state.myComments[${JSON.stringify(suggestionId)}][${index}].authorUsername: ` +
          `must equal ${JSON.stringify(localUsername)}`
        );
      }
      return { ...comment, authorUsername: validationUsername };
    });
  }

  assertUserDocument(
    {
      version: 1,
      username: validationUsername,
      githubUserId: validationId,
      updatedAt: document.updatedAt,
      datasets: document.datasets,
      suggestions: wireSuggestions,
      votes: wireVotes,
      comments: wireComments,
      deletedSuggestions: document.deletedSuggestions,
    },
    {
      path: '$ local state intent',
      filename: `${validationUsername}.json`,
    }
  );

  assertMergesDocument(
    {
      version: 1,
      updatedAt: document.updatedAt,
      merges: document.moderationMerges,
    },
    { path: '$ local state moderation' }
  );

  assertRemoteFileShaMap(
    document.remoteFileShas,
    '$ local state.remoteFileShas',
    { ownPath: ownUserFilePath(profile.username) }
  );
  if (document.lastSyncAt !== null) {
    assertUtcDateTime(document.lastSyncAt, '$ local state.lastSyncAt');
  }
  return document;
}

/**
 * The remote user files of one Pull, folded one file at a time as they
 * stream in, so a Pull holds what the merged view needs rather than every raw
 * file at once. Each file is validated on arrival; the merge with local state
 * happens in `CommunityAnnotationSession#_mergeRemoteUserFilesExact`.
 *
 * What is kept: each user's public profile, the current user's own file (for
 * multi-device hydration), deletion markers, every suggestion (a suggestion
 * id names its owner, so it lives in exactly one file), and every other
 * user's votes and comments.
 */
export class RemoteUserFiles {
  /**
   * @param {{ ownUsername: string }} options - The current user's exact key.
   */
  constructor({ ownUsername }) {
    this.ownUsername = normalizeUsername(ownUsername);
    this.count = 0;
    /** @type {Record<string, object>} */
    this.knownProfiles = {};
    /** @type {any|null} */
    this.ownDoc = null;
    /** @type {Array<[string, string, string]>} bucket, suggestion id, owner */
    this.deletions = [];
    /** @type {Map<string, { bucket: string, suggestion: object, sourceUser: string }>} */
    this.suggestions = new Map();
    /** @type {Map<string, Map<string, 'up'|'down'>>} suggestion id -> user -> direction */
    this.votes = new Map();
    /** @type {Map<string, Map<string, object>>} suggestion id -> author and comment id -> comment */
    this.comments = new Map();
    this._usernames = new Set();
  }

  /**
   * Fold one user file's dataset view in. A file that is not a valid view, a
   * second file of one user, or a suggestion whose id does not name its
   * proposer is refused before anything of it is folded, with
   * `code: 'COMMUNITY_ANNOTATION_FILE_REJECTED'` and the file's `path`, so
   * the caller can leave that one file out of the Pull and say so.
   *
   * @param {object} document - One parsed `annotations/users/*.json` dataset view.
   * @param {{path?: string|null}} [options] - The file's repository path.
   */
  add(document, { path = null } = {}) {
    const label = path ?? `$ user documents[${this.count}]`;
    try {
      assertUserDocument(document, { path: label });
      if (this._usernames.has(document.username)) {
        throw new Error(
          `${label}.username: duplicate user file identity ${JSON.stringify(document.username)}`
        );
      }
      for (const [bucket, list] of Object.entries(document.suggestions)) {
        list.forEach((suggestion, listIndex) => {
          if (
            annotationSuggestionIdOwner(suggestion.id) !== document.username ||
            this.suggestions.has(suggestion.id)
          ) {
            throw new Error(
              `${label}.suggestions[${JSON.stringify(bucket)}][${listIndex}].id: ` +
              `${JSON.stringify(suggestion.id)} is not a suggestion id of ${JSON.stringify(document.username)}`
            );
          }
        });
      }
    } catch (cause) {
      const error = new Error(cause?.message || String(cause));
      error.code = 'COMMUNITY_ANNOTATION_FILE_REJECTED';
      error.path = path;
      error.cause = cause;
      throw error;
    }
    const docUser = document.username;
    this._usernames.add(docUser);
    this.count += 1;

    const profile = sanitizeKnownUserProfile(document);
    if (profile) this.knownProfiles[docUser] = profile;
    if (docUser === this.ownUsername) this.ownDoc = document;

    for (const [bucket, ids] of Object.entries(document.deletedSuggestions ?? {})) {
      for (const id of ids) this.deletions.push([bucket, id, docUser]);
    }

    for (const [bucket, list] of Object.entries(document.suggestions)) {
      for (const suggestion of list) {
        this.suggestions.set(suggestion.id, {
          bucket,
          suggestion: cloneWireSuggestion(suggestion),
          sourceUser: docUser,
        });
      }
    }

    if (docUser !== this.ownUsername) {
      for (const [suggestionId, direction] of Object.entries(document.votes)) {
        if (!this.votes.has(suggestionId)) this.votes.set(suggestionId, new Map());
        this.votes.get(suggestionId).set(docUser, direction);
      }
      for (const [suggestionId, commentList] of Object.entries(document.comments ?? {})) {
        if (!this.comments.has(suggestionId)) this.comments.set(suggestionId, new Map());
        const byAuthorAndId = this.comments.get(suggestionId);
        for (const comment of commentList) {
          const normalized = normalizeComment({ ...comment, authorUsername: docUser });
          byAuthorAndId.set(`${normalized.authorUsername}\u0000${normalized.id}`, normalized);
        }
      }
    }
  }
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
    this._state = defaultState();
    this._profile = sanitizeProfile({});
    // Public profile metadata from GitHub user files (in-memory only).
    this._knownProfiles = {}; // { [usernameLower]: { displayName?, title?, orcid? } }
    // In-memory category label lookup for stable bucket keys (fieldKey + categoryLabel).
    this._categoriesByFieldKey = createExactRecord(); // { [fieldKey]: string[] }
    this._saveTimer = null;
    this._loadedForKey = null;
    this._pullApplicationTransactionActive = false;
    // Bumped by every change (`_touch`); with the state object it keys what is
    // derived from the state (`_derived`).
    this._revision = 0;
    this._derivedCache = null;
    // A pending debounced save is written before the page goes away. These
    // listeners are registered here, before the scope lock is ever acquired,
    // so on pagehide they run ahead of the lock's own release listener and the
    // write still holds the lock it requires.
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('pagehide', () => this.flushPendingSave());
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.flushPendingSave();
      });
    }
    this._scopeLock.on('lost', (evt) => {
      if (!evt || typeof evt !== 'object' || Array.isArray(evt)) {
        throw new Error(
          '[CommunityAnnotationSession] lock loss event must be an object'
        );
      }
      const scopeKey = assertExactNonblankString(
        evt.scopeKey,
        'lock loss scopeKey'
      );
      if (!this._lockScopeKey || scopeKey !== this._lockScopeKey) return;
      this._lockScopeKey = null;
      this._persistenceOk = false;
      this.emit('lock:lost', {
        ...evt,
        datasetId: this._datasetId,
        repoRef: this._repoRef,
        userId: this._cacheUserId
      });
    });
    this._ensureLoaded();
  }

  /**
   * Does the current user's own remote file hold intent this session has not
   * seen yet?
   *
   * The own file is a source of new local state only when it is not the
   * version this session last published or pulled (for example, after a
   * Publish from another device). A file at the recorded SHA is already
   * reflected locally, so anything missing from local state was retracted here
   * (a vote cleared, a comment deleted) and must not be filled back in.
   *
   * @param {Record<string, string>} remoteFileShas - SHAs of the files being merged.
   * @returns {boolean}
   */
  ownUserFileNeedsHydration(remoteFileShas) {
    const incoming = assertRemoteFileShaMap(remoteFileShas, '$ merged file SHAs');
    const userKey = this._getEffectiveUserKey();
    if (!/^ghid_[1-9][0-9]*$/.test(userKey)) return true;
    const path = `annotations/users/${userKey}.json`;
    const known = this.getRemoteFileShas()[path];
    return !(typeof known === 'string' && known === incoming[path]);
  }

  _getEffectiveUserKey() {
    const fromScope = toFileUserKeyFromId(this._cacheUserId);
    if (fromScope) return fromScope;
    const fromProfileId = toFileUserKeyFromId(this._profile?.githubUserId);
    if (fromProfileId) return fromProfileId;
    const fromProfile = normalizeUsername(this._profile?.username);
    return fromProfile || 'local';
  }

  setCacheContext({ datasetId, repoRef, userId } = {}) {
    const prevDatasetId = this._datasetId;
    const prevRepoRef = this._repoRef;
    const prevUserId = this._cacheUserId;
    const prevScopeKey = toCacheScopeKey({ datasetId: prevDatasetId, repoRef: prevRepoRef, userId: prevUserId });
    const prevCategoriesByFieldKey = this._categoriesByFieldKey;
    const prevLoadedForKey = this._loadedForKey;
    const prevState = this._state;
    const prevProfile = this._profile;
    const prevPersistenceOk = this._persistenceOk;
    const prevPersistenceErrorEmittedForKey =
      this._persistenceErrorEmittedForKey;

    const nextDatasetId =
      datasetId === undefined
        ? this._datasetId
        : assertOptionalExactNonblankString(datasetId, 'cache datasetId');
    const nextRepoRef =
      repoRef === undefined
        ? this._repoRef
        : assertOptionalExactNonblankString(repoRef, 'cache repoRef');
    let nextUserId = this._cacheUserId;
    if (userId !== undefined) {
      if (userId === null) {
        nextUserId = null;
      } else {
        nextUserId = normalizeGitHubUserIdOrNull(userId);
        if (nextUserId === null) {
          throw new Error(
            '[CommunityAnnotationSession] cache userId must be a positive safe integer or null'
          );
        }
      }
    }

    const nextScopeKey = toCacheScopeKey({ datasetId: nextDatasetId, repoRef: nextRepoRef, userId: nextUserId });
    const sameContext =
      nextDatasetId === prevDatasetId &&
      nextRepoRef === prevRepoRef &&
      nextUserId === prevUserId;
    const needsLockReacquire = Boolean(
      nextScopeKey &&
      (!this._lockScopeKey || this._lockScopeKey !== nextScopeKey || !this._scopeLock.isHolding(nextScopeKey))
    );
    if (sameContext) {
      if (this._persistenceOk === false) {
        const error = new Error(
          'Community annotation persistence is terminally unavailable for the current scope'
        );
        error.code = 'LOCAL_ANNOTATION_PERSISTENCE_UNAVAILABLE';
        throw error;
      }
      if (needsLockReacquire) {
        const error = new Error(
          'The exact community annotation cache-scope lock is no longer held'
        );
        error.code = 'LOCAL_ANNOTATION_LOCK_REQUIRED';
        throw error;
      }
      return;
    }

    if (this._saveTimer !== null) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }

    if (this._persistenceOk === false) {
      if (nextScopeKey !== null) {
        const error = new Error(
          'Community annotation persistence must be disconnected before selecting another scope'
        );
        error.code = 'LOCAL_ANNOTATION_PERSISTENCE_UNAVAILABLE';
        throw error;
      }
    } else {
      this._saveNow();
    }

    // Acquire a strict cross-tab lock for the fully-scoped key (dataset + repo@branch + numeric user id).
    // If we cannot acquire it, fail closed (do not change scope) to prevent silent overwrites across tabs.
    const lockRes = this._scopeLock.setScopeKey(nextScopeKey);
    if (
      !lockRes ||
      typeof lockRes !== 'object' ||
      lockRes.ok !== true ||
      lockRes.scopeKey !== nextScopeKey
    ) {
      // Restore the previous scope before surfacing the failed transaction.
      let restored = false;
      let restorationFailure = null;
      if (prevScopeKey && nextScopeKey && prevScopeKey !== nextScopeKey) {
        try {
          const res = this._scopeLock.setScopeKey(prevScopeKey);
          restored = Boolean(
            res &&
            typeof res === 'object' &&
            res.ok === true &&
            res.scopeKey === prevScopeKey
          );
          if (!restored) {
            restorationFailure = new Error(
              'Previous annotation cache-scope lock could not be restored'
            );
            restorationFailure.lockResult = res;
          }
        } catch (cause) {
          restorationFailure = cause;
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
      const error = new Error(
        lockRes?.message ||
        'Unable to acquire the exact community annotation cache-scope lock'
      );
      error.code = lockRes?.code || 'LOCAL_ANNOTATION_LOCK_FAILED';
      error.scopeKey = nextScopeKey;
      if (restorationFailure !== null) error.cause = restorationFailure;
      else if (lockRes?.cause !== undefined) error.cause = lockRes.cause;
      throw error;
    }

    // Category label maps are dataset-specific; clear on dataset changes to avoid
    // transient incorrect bucket canonicalization when datasets share field keys.
    if (nextDatasetId !== prevDatasetId) {
      this._categoriesByFieldKey = createExactRecord();
    }

    this._datasetId = nextDatasetId;
    this._repoRef = nextRepoRef;
    this._cacheUserId = nextUserId;
    this._lockScopeKey = nextScopeKey || null;
    this._persistenceOk = true;
    try {
      this._ensureLoaded();
    } catch (error) {
      let restoreResult = null;
      let restoreThrown = null;
      try {
        restoreResult = this._scopeLock.setScopeKey(prevScopeKey);
      } catch (restoreError) {
        restoreThrown = restoreError;
      }
      const restored = Boolean(
        restoreThrown === null &&
        restoreResult &&
        typeof restoreResult === 'object' &&
        restoreResult.ok === true &&
        restoreResult.scopeKey === prevScopeKey
      );
      this._datasetId = prevDatasetId;
      this._repoRef = prevRepoRef;
      this._cacheUserId = prevUserId;
      this._categoriesByFieldKey = prevCategoriesByFieldKey;
      this._loadedForKey = prevLoadedForKey;
      this._state = prevState;
      this._profile = prevProfile;
      this._lockScopeKey = restored ? (prevScopeKey || null) : null;
      this._persistenceOk = restored ? prevPersistenceOk : false;
      this._persistenceErrorEmittedForKey =
        prevPersistenceErrorEmittedForKey;
      if (!restored) {
        const restorationFailure = new Error(
          'Previous annotation cache-scope lock could not be restored after a local-state load failure'
        );
        restorationFailure.code =
          restoreThrown?.code ||
          restoreResult?.code ||
          'LOCAL_ANNOTATION_LOCK_RESTORE_FAILED';
        if (restoreThrown !== null) {
          restorationFailure.cause = restoreThrown;
        }
        restorationFailure.lockResult = restoreResult;
        if (error?.cause === undefined) error.cause = restorationFailure;
        else error.restorationFailure = restorationFailure;
      }
      throw error;
    }
    this.emit('context:changed', { datasetId: this._datasetId, repoRef: this._repoRef, userId: this._cacheUserId });
  }

  setDatasetId(datasetId) {
    this.setCacheContext({ datasetId });
  }

  clearLocalCache({ keepVotingMode = true } = {}) {
    const kept = webStorage('localStorage');
    if (kept === null) {
      throw new Error('[CommunityAnnotationSession] localStorage is unavailable');
    }
    const key = toSessionStorageKey({
      datasetId: this._datasetId,
      repoRef: this._repoRef,
      userId: this._cacheUserId,
    });
    if (key) kept.removeItem(key);

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
    return toPlainOwnRecord(cloneDatasetAccessMap(this._state.datasets));
  }

  recordDatasetAccess({ datasetId, fieldsToAnnotate = [] } = {}) {
    const did = assertExactNonblankString(datasetId, 'datasetId');
    if (!Array.isArray(fieldsToAnnotate)) {
      throw new Error('[CommunityAnnotationSession] fieldsToAnnotate must be an array');
    }
    const exactFields = fieldsToAnnotate.map((field, index) => {
      return assertSessionFieldKey(
        field,
        `fieldsToAnnotate[${index}]`
      );
    });
    if (new Set(exactFields).size !== exactFields.length) {
      throw new Error('[CommunityAnnotationSession] fieldsToAnnotate must be unique');
    }
    if (
      !this._state.datasets ||
      typeof this._state.datasets !== 'object' ||
      Array.isArray(this._state.datasets)
    ) {
      throw new Error(
        '[CommunityAnnotationSession] datasets state must be an object'
      );
    }
    this._state.datasets[did] = {
      fieldsToAnnotate: exactFields,
      lastAccessedAt: nowIso()
    };
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
    const u = normalizeUsername(username);
    if (!u) return '@local';
    const prof = this.getKnownUserProfile(u);
    const parts = [];
    let handle = prof?.login || u;
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
    const next = sanitizeProfile(nextProfile);
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

    this._upsertKnownUserProfile(next.username, next);
    this._profile = next;
    this._state.profile = sanitizeProfile(next);
    this._touch();
  }

  getAnnotatedFields() {
    return this._state.annotationFields.slice();
  }

  isFieldAnnotated(fieldKey) {
    if (fieldKey === null || fieldKey === undefined || fieldKey === '') {
      return false;
    }
    const key = assertSessionFieldKey(fieldKey);
    return this._state.annotationFields.includes(key);
  }

  setFieldAnnotated(fieldKey, enabled) {
    const key = assertSessionFieldKey(fieldKey);
    if (typeof enabled !== 'boolean') {
      throw new Error('[CommunityAnnotationSession] enabled must be boolean');
    }
    const on = enabled;
    const existing = this._state.annotationFields.includes(key);
    if (on === existing) return true;

    if (on) {
      if (
        !this._state.annotatableSettings ||
        typeof this._state.annotatableSettings !== 'object' ||
        Array.isArray(this._state.annotatableSettings)
      ) {
        throw new Error(
          '[CommunityAnnotationSession] consensus settings state must be an object'
        );
      }
      this._state.annotationFields.push(key);
      this._state.annotatableSettings[key] = {
        minAnnotators: DEFAULT_MIN_ANNOTATORS,
        threshold: DEFAULT_CONSENSUS_THRESHOLD,
      };
    }
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
    if (fieldKey === null || fieldKey === undefined || fieldKey === '') {
      return false;
    }
    const key = assertSessionFieldKey(fieldKey);
    if (!this.isFieldAnnotated(key)) return false;
    const map = this._state?.closedAnnotatableFields;
    return Boolean(
      map &&
      typeof map === 'object' &&
      Object.hasOwn(map, key) &&
      map[key] === true
    );
  }

  getClosedAnnotatableFields() {
    const map = this._state?.closedAnnotatableFields;
    if (!map || typeof map !== 'object' || Array.isArray(map)) {
      throw new Error('[CommunityAnnotationSession] closed field state must be an object');
    }
    const out = [];
    for (const [k, v] of Object.entries(map)) {
      const key = assertSessionFieldKey(k, 'closed field state key');
      if (typeof v !== 'boolean') {
        throw new Error(
          `[CommunityAnnotationSession] closed field ${JSON.stringify(key)} must be boolean`
        );
      }
      if (v === true && this.isFieldAnnotated(key)) out.push(key);
    }
    return out.sort();
  }

  setFieldClosed(fieldKey, closed) {
    const key = assertSessionFieldKey(fieldKey);
    if (typeof closed !== 'boolean') {
      throw new Error('[CommunityAnnotationSession] closed must be boolean');
    }
    if (!this.isFieldAnnotated(key)) return false;
    if (
      !this._state.closedAnnotatableFields ||
      typeof this._state.closedAnnotatableFields !== 'object' ||
      Array.isArray(this._state.closedAnnotatableFields)
    ) {
      throw new Error(
        '[CommunityAnnotationSession] closed field state must be an object'
      );
    }
    const next = closed;
    const prev =
      Object.hasOwn(this._state.closedAnnotatableFields, key) &&
      this._state.closedAnnotatableFields[key] === true;
    if (prev === next) return true;
    if (next) this._state.closedAnnotatableFields[key] = true;
    else delete this._state.closedAnnotatableFields[key];
    this._touch();
    return true;
  }

  setClosedAnnotatableFields(nextList) {
    if (!Array.isArray(nextList)) {
      throw new Error('[CommunityAnnotationSession] closed fields must be an array');
    }
    const list = nextList;
    const next = createExactRecord();
    for (const k of list) {
      const key = assertSessionFieldKey(k, 'closed field');
      if (!this.isFieldAnnotated(key)) {
        throw new Error(
          `[CommunityAnnotationSession] closed field ${JSON.stringify(key)} is not annotatable`
        );
      }
      if (Object.hasOwn(next, key)) {
        throw new Error(
          `[CommunityAnnotationSession] closed field ${JSON.stringify(key)} is duplicated`
        );
      }
      next[key] = true;
    }
    this._state.closedAnnotatableFields = next;
    this._touch();
    return true;
  }

  getAnnotatableConsensusSettings(fieldKey) {
    if (fieldKey === null || fieldKey === undefined || fieldKey === '') {
      return null;
    }
    const key = assertSessionFieldKey(fieldKey);
    const map = this._state?.annotatableSettings;
    const raw =
      map &&
      typeof map === 'object' &&
      Object.hasOwn(map, key)
        ? map[key]
        : null;
    return raw ? normalizeConsensusSettings(raw) : null;
  }

  getAnnotatableConsensusSettingsMap() {
    const map = this._state?.annotatableSettings;
    if (!map || typeof map !== 'object' || Array.isArray(map)) {
      throw new Error('[CommunityAnnotationSession] consensus settings state must be an object');
    }
    const out = createExactRecord();
    for (const [k, v] of Object.entries(map)) {
      const key = assertSessionFieldKey(k, 'settings field key');
      out[key] = normalizeConsensusSettings(v);
    }
    return toPlainOwnRecord(out);
  }

  setAnnotatableConsensusSettings(fieldKey, settings) {
    const key = assertSessionFieldKey(fieldKey, 'settings field key');
    if (
      !this._state.annotatableSettings ||
      typeof this._state.annotatableSettings !== 'object' ||
      Array.isArray(this._state.annotatableSettings)
    ) {
      throw new Error(
        '[CommunityAnnotationSession] consensus settings state must be an object'
      );
    }
    if (!this.isFieldAnnotated(key)) {
      throw new Error(
        `[CommunityAnnotationSession] settings field ${JSON.stringify(key)} is not annotatable`
      );
    }
    this._state.annotatableSettings[key] = normalizeConsensusSettings(settings);
    this._touch();
    return true;
  }

  setAnnotatableConsensusSettingsMap(nextMap) {
    if (!nextMap || typeof nextMap !== 'object' || Array.isArray(nextMap)) {
      throw new Error('[CommunityAnnotationSession] consensus settings map must be an object');
    }
    const input = nextMap;
    const out = createExactRecord();
    for (const [k, v] of Object.entries(input)) {
      const key = assertSessionFieldKey(k, 'settings field key');
      if (!this.isFieldAnnotated(key)) {
        throw new Error(
          `[CommunityAnnotationSession] settings field ${JSON.stringify(key)} is not annotatable`
        );
      }
      out[key] = normalizeConsensusSettings(v);
    }
    for (const key of this._state.annotationFields) {
      if (!Object.hasOwn(out, key)) {
        throw new Error(
          `[CommunityAnnotationSession] settings missing annotatable field ${JSON.stringify(key)}`
        );
      }
    }
    this._state.annotatableSettings = out;
    this._touch();
    return true;
  }

  _resolveCategoryKey(fieldKey, catIdxOrKey) {
    const f = exactNonblankStringOrNull(fieldKey);
    if (!f) return null;
    if (isReservedAnnotationFieldKey(f)) {
      throw new Error(
        '[CommunityAnnotationSession] fieldKey uses the reserved ' +
        'fk~...%3A field-key encoding form'
      );
    }

    if (typeof catIdxOrKey === 'number') {
      if (!Number.isSafeInteger(catIdxOrKey) || catIdxOrKey < 0) return null;
      const idx = catIdxOrKey;
      const categories =
        Object.hasOwn(this._categoriesByFieldKey, f)
          ? this._categoriesByFieldKey[f]
          : undefined;
      const label = Array.isArray(categories) ? categories[idx] : undefined;
      return typeof label === 'string' ? label : null;
    }

    if (
      typeof catIdxOrKey !== 'string' ||
      !isAnnotationExactNonblank(catIdxOrKey)
    ) {
      return null;
    }
    return catIdxOrKey;
  }

  toBucketKey(fieldKey, catIdxOrKey) {
    const f = exactNonblankStringOrNull(fieldKey);
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

    return bucketKey(f, catKeyRaw);
  }

  setFieldCategories(fieldKey, categories) {
    const f = assertSessionFieldKey(fieldKey);
    if (!Array.isArray(categories)) {
      throw new Error(
        '[CommunityAnnotationSession] categories must be an array'
      );
    }
    const list = categories;

    const cleaned = [];
    const seenCategories = new Set();
    for (let i = 0; i < list.length; i++) {
      if (
        typeof list[i] !== 'string' ||
        !isAnnotationExactNonblank(list[i])
      ) {
        throw new Error(
          `[CommunityAnnotationSession] category at index ${i} must be nonblank ` +
          'without leading or trailing whitespace'
        );
      }
      bucketKey(f, list[i]);
      if (seenCategories.has(list[i])) {
        throw new Error(
          `[CommunityAnnotationSession] category ${JSON.stringify(list[i])} is duplicated`
        );
      }
      seenCategories.add(list[i]);
      cleaned.push(list[i]);
    }

    const prev =
      Object.hasOwn(this._categoriesByFieldKey, f)
        ? this._categoriesByFieldKey[f]
        : undefined;
    const same =
      Array.isArray(prev) &&
      prev.length === cleaned.length &&
      prev.every((v, i) => v === cleaned[i]);
    if (!same) this._categoriesByFieldKey[f] = cleaned;

    return true;
  }

  /**
   * @returns {any[]} suggestions (cloned)
   */
  getSuggestions(fieldKey, catIdx) {
    if (fieldKey === null || fieldKey === undefined || fieldKey === '') {
      return [];
    }
    const f = assertSessionFieldKey(fieldKey);
    const catKey = this._resolveCategoryKey(f, catIdx);
    if (!catKey) return [];
    const merged = this._bucketView(bucketKey(f, catKey)).suggestions;
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

  /**
   * What is derived from the state and kept until it changes: the merge map
   * of every bucket, each bucket's bundled view and its consensus. Keyed by
   * the state object and its revision (`_touch` bumps it, a Pull swaps the
   * object), so a `changed` listener that reads every bucket again costs a
   * lookup per bucket, not a recomputation.
   */
  _derived() {
    const cache = this._derivedCache;
    if (cache !== null && cache.state === this._state && cache.revision === this._revision) {
      return cache;
    }
    const merges = this._state.moderationMerges;
    this._derivedCache = {
      state: this._state,
      revision: this._revision,
      mergeMaps: Array.isArray(merges) && merges.length ? buildMergeMapsByBucket(merges) : new Map(),
      views: new Map(),
      consensus: new Map(),
    };
    return this._derivedCache;
  }

  /** The merge map (from id -> into id) of one bucket. */
  _mergeMapFor(bucket) {
    return this._derived().mergeMaps.get(bucket) ?? EMPTY_MERGE_MAP;
  }

  /**
   * One bucket as it is shown and counted (memoised per revision): every
   * suggestion bundled with the ones it belongs with, each bundle shown once
   * as its main suggestion, with votes de-duplicated per user.
   *
   * 1. Moderation merges: members merged (through any chain) into one target
   *    form a bundle under that target. A user's vote on the target wins;
   *    otherwise the majority of the user's votes on the members (a tie is no
   *    vote).
   * 2. Equal labels: bundles whose main labels are the same text
   *    (`exactLabelForCompare`: Unicode NFC, nothing folded) are one bundle,
   *    so two people who propose "T cell" independently support one label
   *    rather than splitting it into a tie. Its main suggestion is the
   *    earliest proposed (then the lowest id in code units); a user's vote is
   *    the majority of that user's bundle votes (a tie is no vote).
   *
   * `mergedFrom` lists every other member with its own votes, and says how it
   * joined (`bundledBy`: `'merge'` or `'label'`).
   *
   * @param {string} bucket
   * @returns {{suggestions: object[], memberOf: Map<string, string>}} `memberOf`: suggestion id -> main id
   */
  _bucketView(bucket) {
    const derived = this._derived();
    const stored = this._state.suggestions[bucket];
    const cached = derived.views.get(bucket);
    // A bucket whose list was replaced is derived again, whatever the revision.
    if (cached !== undefined && cached.stored === stored) return cached.view;

    const list = Array.isArray(stored) ? stored : [];
    // Labels are compared in NFC once per suggestion, not once per comparison.
    const labelKey = new Map();
    const labelOf = (s) => {
      let key = labelKey.get(s.id);
      if (key === undefined) {
        key = exactLabelForCompare(s.label);
        labelKey.set(s.id, key);
      }
      return key;
    };
    const netOf = (s) => s.upvotes.length - s.downvotes.length;
    // The consensus's own rank (`consensusOf`): net votes, then upvotes, so
    // the first suggestion listed is the one the consensus line names (bug
    // hunt R9A-2: a leader by upvotes was listed after a tied-net label).
    const memberOrder = (a, b) =>
      (netOf(b) - netOf(a)) ||
      (b.upvotes.length - a.upvotes.length) ||
      compareCodeUnits(labelOf(a), labelOf(b)) ||
      compareCodeUnits(a.id, b.id);

    // Without merges and without two equal labels nothing is bundled: the
    // stored suggestions are the view (they hold each user once: `vote` and
    // the Pull keep them so), and are never handed out uncopied
    // (`getSuggestions` copies).
    if (this._mergeMapFor(bucket).size === 0) {
      const seen = new Set();
      let bundled = false;
      for (const s of list) {
        const key = labelOf(s);
        if (seen.has(key)) {
          bundled = true;
          break;
        }
        seen.add(key);
      }
      if (!bundled) {
        const memberOf = new Map();
        for (const s of list) memberOf.set(s.id, s.id);
        const view = { suggestions: list.slice().sort(memberOrder), memberOf };
        derived.views.set(bucket, { stored, view });
        return view;
      }
    }

    const byId = new Map();
    for (const s of list) {
      const id = s?.id;
      if (typeof id !== 'string' || !id) continue;
      const up = uniqueStrings(ensureStringArray(s?.upvotes));
      const upSet = new Set(up);
      const down = uniqueStrings(ensureStringArray(s?.downvotes).filter((u) => !upSet.has(u)));
      byId.set(id, {
        ...s,
        upvotes: up,
        downvotes: down,
        comments: Array.isArray(s.comments) ? s.comments : []
      });
    }

    const memberCopy = (m, bundledBy) => ({
      ...m,
      bundledBy,
      upvotes: m.upvotes.slice(),
      downvotes: m.downvotes.slice(),
      comments: Array.isArray(m.comments) ? m.comments.slice() : []
    });

    // 1) Moderation merges.
    const fromTo = this._mergeMapFor(bucket);
    /** @type {Map<string, string[]>} target id -> member ids (target first) */
    const mergeGroups = new Map();
    for (const id of byId.keys()) {
      const resolved = fromTo.size ? (resolveMergeTarget(id, fromTo) || id) : id;
      const targetId = byId.has(resolved) ? resolved : id;
      if (!mergeGroups.has(targetId)) mergeGroups.set(targetId, [targetId]);
      if (targetId !== id) mergeGroups.get(targetId).push(id);
    }
    /** @type {Map<string, object>} target id -> bundle main with bundle votes */
    const groupMain = new Map();
    for (const [targetId, memberIds] of mergeGroups) {
      const target = byId.get(targetId);
      if (memberIds.length === 1) {
        groupMain.set(targetId, { ...target, mergedFrom: [] });
        continue;
      }
      const perUser = new Map();
      const entryFor = (u) => {
        let entry = perUser.get(u);
        if (entry === undefined) {
          entry = { targetVote: null, up: 0, down: 0 };
          perUser.set(u, entry);
        }
        return entry;
      };
      for (const mid of memberIds) {
        const m = byId.get(mid);
        const isTarget = mid === targetId;
        for (const u of m.upvotes) {
          if (isTarget) entryFor(u).targetVote = 'up';
          else entryFor(u).up++;
        }
        for (const u of m.downvotes) {
          if (isTarget) entryFor(u).targetVote = 'down';
          else entryFor(u).down++;
        }
      }
      const up = [];
      const down = [];
      for (const [u, entry] of perUser) {
        const vote = entry.targetVote ?? (entry.up > entry.down ? 'up' : entry.down > entry.up ? 'down' : null);
        if (vote === 'up') up.push(u);
        else if (vote === 'down') down.push(u);
      }
      const mergedFrom = memberIds
        .filter((mid) => mid !== targetId)
        .map((mid) => memberCopy(byId.get(mid), 'merge'))
        .sort(memberOrder);
      groupMain.set(targetId, { ...target, upvotes: up, downvotes: down, mergedFrom });
    }

    // 2) Equal labels.
    /** @type {Map<string, object[]>} label -> bundle mains */
    const byLabel = new Map();
    for (const main of groupMain.values()) {
      const label = labelOf(main);
      if (!byLabel.has(label)) byLabel.set(label, []);
      byLabel.get(label).push(main);
    }
    const memberOf = new Map();
    const out = [];
    for (const mains of byLabel.values()) {
      if (mains.length === 1) {
        const main = mains[0];
        out.push(main);
        memberOf.set(main.id, main.id);
        for (const m of main.mergedFrom) memberOf.set(m.id, main.id);
        continue;
      }
      mains.sort((a, b) => {
        const at = instantOf(a.proposedAt);
        const bt = instantOf(b.proposedAt);
        if (at !== bt) {
          if (at === null) return 1;
          if (bt === null) return -1;
          return at - bt;
        }
        return compareCodeUnits(a.id, b.id);
      });
      const tally = new Map();
      for (const main of mains) {
        for (const u of main.upvotes) tally.set(u, (tally.get(u) ?? 0) + 1);
        for (const u of main.downvotes) tally.set(u, (tally.get(u) ?? 0) - 1);
      }
      const up = [];
      const down = [];
      for (const [u, net] of tally) {
        if (net > 0) up.push(u);
        else if (net < 0) down.push(u);
      }
      const [lead, ...others] = mains;
      const mergedFrom = [...lead.mergedFrom];
      for (const other of others) {
        const { mergedFrom: otherMembers, ...otherMain } = other;
        mergedFrom.push(memberCopy({ ...otherMain, upvotes: otherMain.upvotes, downvotes: otherMain.downvotes }, 'label'));
        for (const m of otherMembers) mergedFrom.push(m);
      }
      mergedFrom.sort(memberOrder);
      const main = { ...lead, upvotes: up, downvotes: down, mergedFrom };
      out.push(main);
      for (const m of [main, ...mergedFrom]) memberOf.set(m.id, main.id);
    }

    out.sort(memberOrder);
    const view = { suggestions: out, memberOf };
    derived.views.set(bucket, { stored, view });
    return view;
  }

  addSuggestion(fieldKey, catIdx, { label, ontologyId = null, evidence = null, markers = null } = {}) {
    const f = assertSessionFieldKey(fieldKey);

    const catKey = this._resolveCategoryKey(f, catIdx);
    if (!catKey) throw new Error('[CommunityAnnotationSession] category required');

    const key = bucketKey(f, catKey);
    const labelNormalized = exactLabelForCompare(label);
    if (labelNormalized) {
      for (const s of this._bucketView(key).suggestions) {
        if (exactLabelForCompare(s.label) === labelNormalized) {
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
    const f = assertSessionFieldKey(fieldKey);
    const id = assertSessionSuggestionId(suggestionId);
    const my = normalizeUsername(this._getEffectiveUserKey());
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
      const nextLabel = assertExactNonblankString(label, 'label');
      const nextNorm = exactLabelForCompare(nextLabel);
      // Renaming to another label already shown is refused, as proposing it
      // is; keeping the label (or its NFC form) never is, whatever bundle the
      // suggestion is in.
      if (nextNorm !== exactLabelForCompare(suggestion.label)) {
        for (const s of this._bucketView(bucket).suggestions) {
          if (exactLabelForCompare(s.label) === nextNorm) {
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
      const next = assertExactOrEmpty(assertOptionalString(ontologyId, 'ontologyId'), 'ontologyId');
      const nextValue = next ? next : null;
      if ((suggestion.ontologyId ?? null) !== nextValue) {
        suggestion.ontologyId = nextValue;
        didUpdate = true;
      }
    }

    if (evidence !== undefined) {
      const next = assertExactOrEmpty(assertOptionalString(evidence, 'evidence'), 'evidence');
      const nextValue = next ? next : null;
      if ((suggestion.evidence ?? null) !== nextValue) {
        suggestion.evidence = nextValue;
        didUpdate = true;
      }
    }

    if (markers !== undefined) {
      const nextMarkers = normalizeMarkers(markers);
      const currentSerialized = JSON.stringify(suggestion.markers ?? null);
      const nextSerialized = JSON.stringify(nextMarkers ?? null);
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
    const f = assertSessionFieldKey(fieldKey);
    const id = assertSessionSuggestionId(suggestionId);
    const my = normalizeUsername(this._getEffectiveUserKey());
    if (!my) return false;
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
    const fromTo = this._mergeMapFor(bucket);
    if (fromTo.size) {
      // A subset of a valid merge list is valid: no revalidation.
      this._state.moderationMerges = merges.filter((m) => {
        if (m.bucket !== bucket) return true;
        if (m.fromSuggestionId === id || m.intoSuggestionId === id) return false;
        return resolveMergeTarget(m.fromSuggestionId, fromTo) !== id;
      });
    }

    if (!this._state.deletedSuggestions || typeof this._state.deletedSuggestions !== 'object') this._state.deletedSuggestions = {};
    const existing = Array.isArray(this._state.deletedSuggestions[bucket]) ? this._state.deletedSuggestions[bucket] : [];
    const nextDeleted = uniqueStrings(existing.concat([id]));
    this._state.deletedSuggestions[bucket] = nextDeleted;

    this._state.suggestions[bucket] = list.filter((x) => toCleanString(x?.id) !== id);

    // Remove my local vote + comments for this suggestion.
    const voteKey = suggestionKey(f, catKey, id);
    if (this._state.myVotes?.[voteKey]) delete this._state.myVotes[voteKey];
    if (
      this._state.myComments &&
      Object.hasOwn(this._state.myComments, id)
    ) {
      delete this._state.myComments[id];
    }

    this._touch();
    return true;
  }

  vote(fieldKey, catIdx, suggestionId, direction) {
    const f = assertSessionFieldKey(fieldKey);
    const id = assertSessionSuggestionId(suggestionId);
    if (direction !== 'up' && direction !== 'down') {
      throw new Error(
        '[CommunityAnnotationSession] direction must equal "up" or "down"'
      );
    }
    const dir = direction;
    const username = normalizeUsername(this._getEffectiveUserKey());
    if (!username) return false;
    const catKey = this._resolveCategoryKey(f, catIdx);
    if (!catKey) {
      throw new Error('[CommunityAnnotationSession] category required');
    }

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
    if (
      fieldKey === null ||
      fieldKey === undefined ||
      fieldKey === '' ||
      suggestionId === null ||
      suggestionId === undefined ||
      suggestionId === ''
    ) {
      return null;
    }
    const f = assertSessionFieldKey(fieldKey);
    const sid = assertSessionSuggestionId(suggestionId);
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
    if (
      fieldKey === null ||
      fieldKey === undefined ||
      fieldKey === '' ||
      suggestionId === null ||
      suggestionId === undefined ||
      suggestionId === ''
    ) {
      return { vote: null, source: 'none', delegatedUp: 0, delegatedDown: 0 };
    }
    const f = assertSessionFieldKey(fieldKey);
    const sid = assertSessionSuggestionId(suggestionId);
    const catKey = this._resolveCategoryKey(f, catIdx);
    if (!catKey) return { vote: null, source: 'none', delegatedUp: 0, delegatedDown: 0 };

    const direct = this.getMyVoteDirect(f, catKey, sid);
    if (direct) return { vote: direct, source: 'direct', delegatedUp: 0, delegatedDown: 0 };

    // The vote this user's bundle votes add up to (`_bucketView`), shown on
    // the bundle's main card only.
    const bucket = bucketKey(f, catKey);
    const view = this._bucketView(bucket);
    if (view.memberOf.get(sid) !== sid) return { vote: null, source: 'none', delegatedUp: 0, delegatedDown: 0 };
    const main = view.suggestions.find((s) => s.id === sid);
    // An unbundled suggestion is its own view (no `mergedFrom`): nothing to delegate.
    if (!main || !(main.mergedFrom?.length > 0)) return { vote: null, source: 'none', delegatedUp: 0, delegatedDown: 0 };

    let delegatedUp = 0;
    let delegatedDown = 0;
    for (const member of main.mergedFrom) {
      const v = this._state.myVotes?.[suggestionKey(f, catKey, member.id)] || null;
      if (v === 'up') delegatedUp++;
      else if (v === 'down') delegatedDown++;
    }
    const me = normalizeUsername(this._getEffectiveUserKey());
    const vote = main.upvotes.includes(me) ? 'up' : (main.downvotes.includes(me) ? 'down' : null);
    return { vote, source: vote === null ? 'none' : 'delegated', delegatedUp, delegatedDown };
  }

  getMyVote(fieldKey, catIdx, suggestionId) {
    return this.getMyVoteDirect(fieldKey, catIdx, suggestionId);
  }

  addComment(fieldKey, catIdx, suggestionId, text) {
    const f = assertSessionFieldKey(fieldKey);
    const sid = assertSessionSuggestionId(suggestionId);
    const catKey = this._resolveCategoryKey(f, catIdx);
    if (!catKey) {
      throw new Error('[CommunityAnnotationSession] category required');
    }

    const key = bucketKey(f, catKey);
    const list = this._state.suggestions[key] || [];
    let suggestion = list.find((s) => s?.id === sid) || null;
    let storeSid = sid;
    if (!suggestion) {
      const main = this._bucketView(key).memberOf.get(sid);
      if (main !== undefined) {
        suggestion = list.find((s) => s?.id === main) || null;
        storeSid = main;
      }
    }
    if (!suggestion) return null;

    if (!Array.isArray(suggestion.comments)) suggestion.comments = [];

    const comment = normalizeComment(
      { text },
      { authorUsername: this._getEffectiveUserKey() }
    );

    suggestion.comments.push(comment);

    if (
      !this._state.myComments ||
      typeof this._state.myComments !== 'object' ||
      Array.isArray(this._state.myComments)
    ) {
      this._state.myComments = createExactRecord();
    }
    if (!Object.hasOwn(this._state.myComments, storeSid)) {
      this._state.myComments[storeSid] = [];
    }
    if (!Array.isArray(this._state.myComments[storeSid])) {
      throw new Error(
        `[CommunityAnnotationSession] local comments for ${JSON.stringify(storeSid)} must be an array`
      );
    }
    this._state.myComments[storeSid].push(comment);

    this._touch();
    return comment.id;
  }

  editComment(fieldKey, catIdx, suggestionId, commentId, newText) {
    const f = assertSessionFieldKey(fieldKey);
    const sid = assertSessionSuggestionId(suggestionId);
    const cid = assertExactNonblankString(commentId, 'commentId');
    const catKey = this._resolveCategoryKey(f, catIdx);
    if (!catKey) {
      throw new Error('[CommunityAnnotationSession] category required');
    }

    const key = bucketKey(f, catKey);
    const list = this._state.suggestions[key] || [];
    const memberOf = this._bucketView(key).memberOf;
    const target = memberOf.get(sid) ?? sid;

    let owningSid = null;
    let comment = null;
    for (const s of list) {
      const sId = toCleanString(s?.id);
      if (!sId) continue;
      const t = memberOf.get(sId) ?? sId;
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

    const nextText = assertExactNonblankString(newText, 'comment text');
    comment.text = nextText;
    comment.editedAt = nowIso();

    if (
      this._state.myComments &&
      Object.hasOwn(this._state.myComments, owningSid)
    ) {
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
    const f = assertSessionFieldKey(fieldKey);
    const sid = assertSessionSuggestionId(suggestionId);
    const cid = assertExactNonblankString(commentId, 'commentId');
    const catKey = this._resolveCategoryKey(f, catIdx);
    if (!catKey) {
      throw new Error('[CommunityAnnotationSession] category required');
    }

    const key = bucketKey(f, catKey);
    const list = this._state.suggestions[key] || [];
    const memberOf = this._bucketView(key).memberOf;
    const target = memberOf.get(sid) ?? sid;

    let owningSid = null;
    let owningSuggestion = null;
    let commentIndex = -1;
    for (const s of list) {
      const sId = toCleanString(s?.id);
      if (!sId) continue;
      const t = memberOf.get(sId) ?? sId;
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

    if (
      this._state.myComments &&
      Object.hasOwn(this._state.myComments, owningSid)
    ) {
      this._state.myComments[owningSid] = this._state.myComments[owningSid].filter((c) => c?.id !== cid);
      if (this._state.myComments[owningSid].length === 0) delete this._state.myComments[owningSid];
    }

    this._touch();
    return true;
  }

  getComments(fieldKey, catIdx, suggestionId) {
    if (
      fieldKey === null ||
      fieldKey === undefined ||
      fieldKey === '' ||
      suggestionId === null ||
      suggestionId === undefined ||
      suggestionId === ''
    ) {
      return [];
    }
    const f = assertSessionFieldKey(fieldKey);
    const sid = assertSessionSuggestionId(suggestionId);
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
    assertMergesDocument(doc, { path: '$ moderation merges' });
    this._state.moderationMerges = doc.merges.map((merge) => ({ ...merge }));
    // Votes/comments are auto-combined at runtime from the merge mapping.
    this._touch();
    return true;
  }

  getModerationMerges() {
    if (!Array.isArray(this._state.moderationMerges)) {
      throw new Error('[CommunityAnnotationSession] moderation merges state must be an array');
    }
    return this._state.moderationMerges.map((merge) => ({ ...merge }));
  }

  addModerationMerge({ fieldKey, catIdx, fromSuggestionId, intoSuggestionId, note = null } = {}) {
    const f = assertSessionFieldKey(fieldKey);
    const from = assertSessionSuggestionId(
      fromSuggestionId,
      'fromSuggestionId'
    );
    const into = assertSessionSuggestionId(
      intoSuggestionId,
      'intoSuggestionId'
    );
    const catKey = this._resolveCategoryKey(f, catIdx);
    if (!catKey) {
      throw new Error('[CommunityAnnotationSession] category required');
    }
    const bucket = bucketKey(f, catKey);
    const entry = {
      bucket,
      fromSuggestionId: from,
      intoSuggestionId: into,
      by: this._getEffectiveUserKey(),
      at: nowIso(),
      note
    };
    // A "from" suggestion is merged into one "into" suggestion at a time: the
    // new merge replaces an earlier one of the same source. The whole list is
    // validated once (a cycle is refused here, not at Publish).
    const next = this.getModerationMerges().filter(
      (m) => m.bucket !== bucket || m.fromSuggestionId !== from
    );
    next.push(entry);
    this._state.moderationMerges = assertModerationMerges(next);
    this._touch();
    return true;
  }

  editModerationMergeNote({ fieldKey, catIdx, fromSuggestionId, note = null } = {}) {
    const f = assertSessionFieldKey(fieldKey);
    const catKey = this._resolveCategoryKey(f, catIdx);
    if (!catKey) {
      throw new Error('[CommunityAnnotationSession] category required');
    }
    const bucket = bucketKey(f, catKey);
    const from = assertSessionSuggestionId(
      fromSuggestionId,
      'fromSuggestionId'
    );

    const merges = this.getModerationMerges();
    if (!merges.length) return false;

    const nextNote =
      note === null || note === ''
        ? null
        : assertExactNonblankString(note, 'merge note');

    let didUpdate = false;
    const next = merges.map((m) => {
      if (m.bucket !== bucket || m.fromSuggestionId !== from) return m;
      if (!this.isMyComment(m.by)) return m;
      if ((m.note ?? null) === nextNote) return m;
      didUpdate = true;
      return { ...m, note: nextNote, editedAt: nowIso() };
    });
    if (!didUpdate) return false;
    this._state.moderationMerges = compactModerationMerges(next);
    this._touch();
    return true;
  }

  detachModerationMerge({ fieldKey, catIdx, fromSuggestionId } = {}) {
    const f = assertSessionFieldKey(fieldKey);
    const catKey = this._resolveCategoryKey(f, catIdx);
    if (!catKey) {
      throw new Error('[CommunityAnnotationSession] category required');
    }
    const bucket = bucketKey(f, catKey);
    const from = assertSessionSuggestionId(
      fromSuggestionId,
      'fromSuggestionId'
    );
    const merges = Array.isArray(this._state.moderationMerges) ? this._state.moderationMerges : [];
    if (!merges.length) return false;

    // A subset of a valid merge list is valid: no revalidation.
    const next = merges.filter((m) => m.bucket !== bucket || m.fromSuggestionId !== from);
    if (next.length === merges.length) return false;
    this._state.moderationMerges = next;
    this._touch();
    return true;
  }

  detachLastModerationMerge({ fieldKey, catIdx, intoSuggestionId = null } = {}) {
    const f = assertSessionFieldKey(fieldKey);
    const catKey = this._resolveCategoryKey(f, catIdx);
    if (!catKey) {
      throw new Error('[CommunityAnnotationSession] category required');
    }
    const bucket = bucketKey(f, catKey);
    const exactIntoSuggestionId =
      intoSuggestionId === null
        ? null
        : assertSessionSuggestionId(
          intoSuggestionId,
          'intoSuggestionId'
        );
    const merges = Array.isArray(this._state.moderationMerges) ? this._state.moderationMerges : [];
    if (!merges.length) return false;

    const map = this._mergeMapFor(bucket);
    const target =
      exactIntoSuggestionId === null
        ? null
        : (resolveMergeTarget(exactIntoSuggestionId, map) || exactIntoSuggestionId);

    // The latest merge (by instant; among equal instants the later in the list).
    let best = null;
    for (const m of merges) {
      if (m.bucket !== bucket) continue;
      const resolved = resolveMergeTarget(m.fromSuggestionId, map) || m.fromSuggestionId;
      if (target && resolved !== target) continue;
      const at = instantOf(m.at);
      if (best === null || at >= best.at) best = { fromId: m.fromSuggestionId, at };
    }
    if (best === null) return false;
    return this.detachModerationMerge({ fieldKey: f, catIdx: catKey, fromSuggestionId: best.fromId });
  }

  buildModerationMergesDocument() {
    const document = {
      version: 1,
      updatedAt: nowIso(),
      merges: this.getModerationMerges()
    };
    assertMergesDocument(document, { path: '$ moderation merges' });
    return document;
  }

  // Note: Votes/comments are not stored in merge records.
  // The merge mapping only stores which suggestion was merged into which.

  /**
   * Compute consensus for a field/category bucket.
   * @returns {{status:'pending'|'disputed'|'consensus', label:string|null, confidence:number, voters:number, netVotes:number, suggestionId:string|null}}
   */
  computeConsensus(fieldKey, catIdx, { minAnnotators = DEFAULT_MIN_ANNOTATORS, threshold = DEFAULT_CONSENSUS_THRESHOLD } = {}) {
    const f = assertSessionFieldKey(fieldKey);
    const settings = normalizeConsensusSettings({
      minAnnotators,
      threshold,
    });
    const catKey = this._resolveCategoryKey(f, catIdx);
    if (!catKey) {
      return { status: 'pending', label: null, confidence: 0, voters: 0, netVotes: 0, suggestionId: null };
    }
    const key = bucketKey(f, catKey);
    const derived = this._derived();
    const memoKey = `${settings.minAnnotators}\u0000${settings.threshold}\u0000${key}`;
    const view = this._bucketView(key);
    const memo = derived.consensus.get(memoKey);
    if (memo !== undefined && memo.view === view) return { ...memo.result };
    const result = consensusOf(view.suggestions, settings);
    derived.consensus.set(memoKey, { view, result });
    return { ...result };
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
    if (
      typeof includeComments !== 'boolean' ||
      typeof includeMergedFrom !== 'boolean'
    ) {
      throw new Error(
        '[CommunityAnnotationSession] consensus export options must be booleans'
      );
    }
    const now = nowIso();

    /** @type {Record<string, any[]>} */
    const outSuggestions = {};
    /** @type {Record<string, any>} */
    const outConsensus = {};

    const parseBucket = (bucket) => {
      const canonical = this._canonicalizeBucketKey(bucket);
      if (!canonical) {
        throw new Error(
          `[CommunityAnnotationSession] invalid consensus bucket ${JSON.stringify(bucket)}`
        );
      }
      const parts = parseBucketKey(canonical);
      if (!parts) {
        throw new Error(
          `[CommunityAnnotationSession] invalid consensus bucket ${JSON.stringify(bucket)}`
        );
      }
      const fieldKey = assertSessionFieldKey(
        parts.fieldKey,
        'consensus fieldKey'
      );
      const catKey = assertExactNonblankString(
        parts.catKey,
        'consensus category'
      );
      return { fieldKey, catKey, bucket: bucketKey(fieldKey, catKey) };
    };

    if (
      !this._state.suggestions ||
      typeof this._state.suggestions !== 'object' ||
      Array.isArray(this._state.suggestions)
    ) {
      throw new Error(
        '[CommunityAnnotationSession] suggestions state must be an object'
      );
    }
    const buckets = Object.keys(this._state.suggestions).sort(compareCodeUnits);
    for (const rawBucket of buckets) {
      const parts = parseBucket(rawBucket);
      const { fieldKey, catKey, bucket } = parts;

      const suggestions = this.getSuggestions(fieldKey, catKey);
      outSuggestions[bucket] = suggestions.map((s) => {
        if (!s || typeof s !== 'object' || Array.isArray(s)) {
          throw new Error(
            `[CommunityAnnotationSession] suggestion in ${JSON.stringify(bucket)} must be an object`
          );
        }
        if (!Array.isArray(s.upvotes) || !Array.isArray(s.downvotes)) {
          throw new Error(
            `[CommunityAnnotationSession] suggestion votes in ${JSON.stringify(bucket)} must be arrays`
          );
        }
        if (includeComments && !Array.isArray(s.comments)) {
          throw new Error(
            `[CommunityAnnotationSession] suggestion comments in ${JSON.stringify(bucket)} must be an array`
          );
        }
        if (includeMergedFrom && !Array.isArray(s.mergedFrom)) {
          throw new Error(
            `[CommunityAnnotationSession] suggestion mergedFrom in ${JSON.stringify(bucket)} must be an array`
          );
        }
        const out = {
          id: assertSessionSuggestionId(
            s.id,
            'consensus suggestion id'
          ),
          label: assertExactNonblankString(s.label, 'consensus suggestion label'),
          ontologyId: s?.ontologyId ?? null,
          evidence: s?.evidence ?? null,
          markers: s?.markers ?? null,
          proposedBy: normalizeUsername(s.proposedBy),
          proposedAt: assertUtcDateTime(s.proposedAt, '$ consensus suggestion proposedAt'),
          upvotes: s.upvotes.slice(),
          downvotes: s.downvotes.slice(),
          ...(includeComments ? { comments: s.comments.map((c) => ({ ...c })) } : {}),
          ...(includeMergedFrom ? { mergedFrom: s.mergedFrom.map((m) => ({ ...m })) } : {}),
        };
        return out;
      });

      const settings = this.getAnnotatableConsensusSettings(fieldKey);
      if (settings === null) {
        throw new Error(
          `[CommunityAnnotationSession] consensus settings missing field ${JSON.stringify(fieldKey)}`
        );
      }
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
      ...JSON.parse(JSON.stringify(this._state))
    };
  }

  getRemoteFileShas() {
    const map = assertRemoteFileShaMap(this._state.remoteFileShas);
    return { ...map };
  }

  /**
   * Record the remote SHAs of a Pull or Publish. Only the SHAs the session
   * reads are kept (config, merges, the current user's own file): every
   * other user's SHA lives in the file cache (IndexedDB), so this state
   * stays a few hundred bytes however many contributors a repository has.
   *
   * @param {Record<string, string>} nextMap
   */
  setRemoteFileShas(nextMap) {
    const input = assertRemoteFileShaMap(nextMap);
    const ownPath = ownUserFilePath(this._getEffectiveUserKey());
    const kept = {};
    for (const path of [...SESSION_SHA_PATHS, ownPath]) {
      if (path !== null && Object.hasOwn(input, path)) kept[path] = input[path];
    }
    this._state.remoteFileShas = kept;
    this._touch();
  }

  setRemoteFileSha(path, sha) {
    const current = this.getRemoteFileShas();
    current[path] = sha;
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
  buildUserFileDocument(options) {
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Object.keys(options).length !== 1 ||
      !Object.hasOwn(options, 'githubUserId') ||
      !Number.isSafeInteger(options.githubUserId) ||
      options.githubUserId < 1
    ) {
      throw new Error(
        '[CommunityAnnotationSession] user-file export options must contain exactly a positive githubUserId'
      );
    }
    const profile = this._profile;
    const profileId = normalizeGitHubUserIdOrNull(profile?.githubUserId);
    const scopeId = normalizeGitHubUserIdOrNull(this._cacheUserId);
    const githubUserId = options.githubUserId;
    if (profileId === null || profileId !== githubUserId) {
      throw new Error(
        '[CommunityAnnotationSession] profile githubUserId does not match the selected export identity'
      );
    }
    if (scopeId !== null && scopeId !== githubUserId) {
      throw new Error(
        '[CommunityAnnotationSession] profile githubUserId does not match the active cache scope'
      );
    }
    const username = `ghid_${githubUserId}`;
    if (profile?.username !== username) {
      throw new Error(
        `[CommunityAnnotationSession] profile username must equal ${JSON.stringify(username)}`
      );
    }

    const suggestionsOut = {};
    const suggestionBucketById = new Map();
    for (const [bucket, list] of Object.entries(this._state.suggestions)) {
      if (!Array.isArray(list)) {
        throw new Error(
          `[CommunityAnnotationSession] suggestions bucket ${JSON.stringify(bucket)} must be an array`
        );
      }
      const bucketParts = parseBucketKey(bucket);
      if (!bucketParts) {
        throw new Error(
          `[CommunityAnnotationSession] invalid suggestion bucket ${JSON.stringify(bucket)}`
        );
      }
      const canonicalBucket = bucketKey(
        bucketParts.fieldKey,
        bucketParts.catKey
      );
      for (const suggestion of list) {
        const id = assertSessionSuggestionId(
          suggestion?.id,
          'suggestion id'
        );
        const previousBucket = suggestionBucketById.get(id) ?? null;
        if (previousBucket !== null && previousBucket !== canonicalBucket) {
          throw new Error(
            `[CommunityAnnotationSession] suggestion id ${JSON.stringify(id)} ` +
            'appears in multiple buckets'
          );
        }
        suggestionBucketById.set(id, canonicalBucket);
      }
      const mine = list.filter((suggestion) => suggestion?.proposedBy === username);
      if (!mine.length) continue;
      suggestionsOut[bucket] = mine.map(cloneWireSuggestion);
    }

    const votesOut = createExactRecord();
    for (const [key, direction] of Object.entries(this._state.myVotes)) {
      const parsed = parseVoteKey(key);
      if (!parsed) {
        throw new Error(
          `[CommunityAnnotationSession] invalid local vote key ${JSON.stringify(key)}`
        );
      }
      if (direction !== 'up' && direction !== 'down') {
        throw new Error(
          `[CommunityAnnotationSession] invalid local vote direction for ${JSON.stringify(key)}`
        );
      }
      const targetBucket = suggestionBucketById.get(parsed.suggestionId) ?? null;
      if (
        targetBucket !== null &&
        targetBucket !== bucketKey(parsed.fieldKey, parsed.catKey)
      ) {
        throw new Error(
          `[CommunityAnnotationSession] local vote key ${JSON.stringify(key)} ` +
          'does not reference an exact suggestion bucket'
        );
      }
      if (
        Object.hasOwn(votesOut, parsed.suggestionId) &&
        votesOut[parsed.suggestionId] !== direction
      ) {
        throw new Error(
          `[CommunityAnnotationSession] conflicting local votes for ${JSON.stringify(parsed.suggestionId)}`
        );
      }
      votesOut[parsed.suggestionId] = direction;
    }

    const commentsOut = createExactRecord();
    for (const [suggestionId, comments] of Object.entries(this._state.myComments)) {
      if (!Array.isArray(comments)) {
        throw new Error(
          `[CommunityAnnotationSession] comments for ${JSON.stringify(suggestionId)} must be an array`
        );
      }
      commentsOut[suggestionId] = comments.map((comment) => ({ ...comment }));
    }

    const deletedOut = {};
    for (const [bucket, ids] of Object.entries(this._state.deletedSuggestions)) {
      if (!Array.isArray(ids)) {
        throw new Error(
          `[CommunityAnnotationSession] deleted suggestions for ${JSON.stringify(bucket)} must be an array`
        );
      }
      deletedOut[bucket] = [...ids];
    }

    const datasetsOut = createExactRecord();
    for (const [datasetId, entry] of Object.entries(this._state.datasets)) {
      datasetsOut[datasetId] = {
        fieldsToAnnotate: [...entry.fieldsToAnnotate],
        lastAccessedAt: entry.lastAccessedAt,
      };
    }

    const document = {
      version: 1,
      username,
      githubUserId,
      updatedAt: nowIso(),
      ...(Object.keys(datasetsOut).length
        ? { datasets: toPlainOwnRecord(datasetsOut) }
        : {}),
      suggestions: suggestionsOut,
      votes: toPlainOwnRecord(votesOut),
      comments: toPlainOwnRecord(commentsOut),
      deletedSuggestions: deletedOut
    };
    for (const key of ['login', 'displayName', 'title', 'orcid', 'linkedin']) {
      if (profile[key]) document[key] = profile[key];
    }
    assertUserDocument(document, {
      path: '$ local publish document',
      filename: `${username}.json`,
    });
    return document;
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
   * @param {RemoteUserFiles} remoteUserFiles - every `annotations/users/*.json`
   *   of the Pull, folded by `createRemoteUserFiles()`
   * @param {object} [options]
   * @param {boolean} [options.preferLocalVotes=true]
   * @param {boolean} [options.hydrateFromOwnFile=true] - Fill local votes,
   *   comments, deletions and dataset access from the current user's own file.
   */
  /**
   * An empty fold of one Pull's remote user files for this session's user;
   * the Pull adds each file to it as the file streams out of the cache.
   *
   * @returns {RemoteUserFiles}
   */
  createRemoteUserFiles() {
    return new RemoteUserFiles({ ownUsername: this._getEffectiveUserKey() });
  }

  rebuildMergedViewFromUserFiles(remoteUserFiles, options = {}) {
    const preferLocalVotes = options.preferLocalVotes !== false;
    const hydrateFromOwnFile = options.hydrateFromOwnFile !== false;
    if (!(remoteUserFiles instanceof RemoteUserFiles)) {
      throw new TypeError(
        '[CommunityAnnotationSession] remote user files must come from createRemoteUserFiles()'
      );
    }

    const localUser = this._getEffectiveUserKey();
    const localSuggestions = {};
    for (const [bucket, list] of Object.entries(this._state.suggestions)) {
      if (!Array.isArray(list)) {
        throw new Error(
          `[CommunityAnnotationSession] suggestions bucket ${JSON.stringify(bucket)} must be an array`
        );
      }
      const mine = list
        .filter((suggestion) => suggestion?.proposedBy === localUser)
        .map(cloneWireSuggestion);
      if (mine.length) localSuggestions[bucket] = mine;
    }

    if (this._pullApplicationTransactionActive) {
      this._state.suggestions = localSuggestions;
      this._mergeRemoteUserFilesExact(remoteUserFiles, {
        preferLocalVotes,
        hydrateFromOwnFile,
      });
      return;
    }

    const previousState = cloneStateForTransaction(this._state);
    const previousProfile = { ...this._profile };
    const previousKnownProfiles = JSON.parse(
      JSON.stringify(this._knownProfiles)
    );
    try {
      this._state.suggestions = localSuggestions;
      this._mergeRemoteUserFilesExact(remoteUserFiles, {
        preferLocalVotes,
        hydrateFromOwnFile,
      });
    } catch (error) {
      this._state = previousState;
      this._profile = previousProfile;
      this._knownProfiles = previousKnownProfiles;
      throw error;
    }
  }

  _runPulledRepositoryStateTransaction(apply) {
    if (typeof apply !== 'function') {
      throw new TypeError(
        '[CommunityAnnotationSession] Pull application transaction requires a function'
      );
    }
    if (this._pullApplicationTransactionActive) {
      throw new Error(
        '[CommunityAnnotationSession] Pull application transactions must not be nested'
      );
    }

    const previousState = this._state;
    const previousProfile = this._profile;
    const previousKnownProfiles = this._knownProfiles;
    const candidateState = cloneStateForTransaction(previousState);
    const candidateProfile = { ...previousProfile };
    const candidateKnownProfiles = JSON.parse(
      JSON.stringify(previousKnownProfiles)
    );
    this._state = candidateState;
    this._profile = candidateProfile;
    this._knownProfiles = candidateKnownProfiles;
    this._pullApplicationTransactionActive = true;

    let result;
    try {
      result = apply();
      if (
        result !== null &&
        typeof result === 'object' &&
        typeof result.then === 'function'
      ) {
        throw new TypeError(
          '[CommunityAnnotationSession] Pull application transaction must be synchronous'
        );
      }
    } catch (error) {
      this._state = previousState;
      this._profile = previousProfile;
      this._knownProfiles = previousKnownProfiles;
      this._pullApplicationTransactionActive = false;
      throw error;
    }

    this._pullApplicationTransactionActive = false;
    this._touch();
    return result;
  }

  /**
   * Atomically publish one fully compiled GitHub Pull into the visible session.
   * Raw-file caching is owned by the caller and may already be committed; this
   * boundary covers only the synchronous session application. Local suggestions,
   * votes, comments, and unpublished moderation merges remain authoritative.
   *
   * @param {object} options
   * @param {RemoteUserFiles} options.remoteUserFiles - from createRemoteUserFiles()
   * @param {object|null} options.moderationDocument
   * @param {string[]} options.categoricalFieldKeys
   * @param {string[]} options.fieldsToAnnotate
   * @param {Record<string, object>} options.annotatableSettings
   * @param {string[]} options.closedFields
   * @param {string} options.datasetId
   * @param {Record<string, string>} options.remoteFileShas
   * @param {AbortSignal|null} [options.signal]
   */
  applyPulledRepositoryState({
    remoteUserFiles,
    moderationDocument = null,
    categoricalFieldKeys,
    fieldsToAnnotate,
    annotatableSettings,
    closedFields,
    datasetId,
    remoteFileShas,
    signal = null,
  } = {}) {
    requireSignalOrNull(signal, '[CommunityAnnotationSession] Pull application signal');
    if (!Array.isArray(categoricalFieldKeys)) {
      throw new TypeError(
        '[CommunityAnnotationSession] categorical field keys must be an array'
      );
    }
    if (!Array.isArray(fieldsToAnnotate)) {
      throw new TypeError(
        '[CommunityAnnotationSession] annotatable field keys must be an array'
      );
    }
    const exactCategoricalFieldKeys = categoricalFieldKeys.map(
      (fieldKey, index) => assertSessionFieldKey(
        fieldKey,
        `categoricalFieldKeys[${index}]`
      )
    );
    const exactFieldsToAnnotate = fieldsToAnnotate.map(
      (fieldKey, index) => assertSessionFieldKey(
        fieldKey,
        `fieldsToAnnotate[${index}]`
      )
    );
    // A pulled merges document is validated once, where it is applied
    // (`setModerationMergesFromDoc`), inside the transaction.
    const preserveLocalModeration =
      this.getModerationMerges().length > 0;

    return this._runPulledRepositoryStateTransaction(() => {
      throwIfAborted(signal);

      if (moderationDocument !== null && !preserveLocalModeration) {
        this.setModerationMergesFromDoc(moderationDocument);
      }
      throwIfAborted(signal);

      this.rebuildMergedViewFromUserFiles(remoteUserFiles, {
        preferLocalVotes: true,
        hydrateFromOwnFile: this.ownUserFileNeedsHydration(remoteFileShas),
      });
      throwIfAborted(signal);

      const enabled = new Set(exactFieldsToAnnotate);
      for (const key of exactCategoricalFieldKeys) {
        this.setFieldAnnotated(key, enabled.has(key));
      }
      this.setAnnotatableConsensusSettingsMap(annotatableSettings);
      this.setClosedAnnotatableFields(closedFields);
      throwIfAborted(signal);

      this.recordDatasetAccess({
        datasetId,
        fieldsToAnnotate: this.getAnnotatedFields(),
      });
      this.setRemoteFileShas(remoteFileShas);
      throwIfAborted(signal);
      return true;
    });
  }

  /** When the last Pull completed (an ISO instant), or null before the first. */
  getLastPullAt() {
    return this._state.lastSyncAt;
  }

  /**
   * Merge GitHub per-user files into the local merged view.
   *
   * `userDocs` are expected to follow the template schema:
   * - { username, githubUserId, login, suggestions: { [bucket]: Suggestion[] }, votes: { [suggestionId]: 'up'|'down' } }
   *
   * Security:
   * - Validates every complete user document before mutating session state.
   * - Does not touch DOM.
   *
   * @param {object[]} userDocs
   * @param {object} [options]
   * @param {boolean} [options.preferLocalVotes=true] - Local `myVotes` wins over pulled votes for the current user.
   * @param {boolean} [options.hydrateFromOwnFile=true] - Fill local state gaps from the current user's own file.
   */
  mergeFromUserFiles(userDocs, options = {}) {
    const previousState = cloneStateForTransaction(this._state);
    const previousProfile = { ...this._profile };
    const previousKnownProfiles = JSON.parse(JSON.stringify(this._knownProfiles));
    try {
      return this._mergeFromUserFilesExact(userDocs, options);
    } catch (error) {
      this._state = previousState;
      this._profile = previousProfile;
      this._knownProfiles = previousKnownProfiles;
      throw error;
    }
  }

  _mergeFromUserFilesExact(userDocs, options = {}) {
    if (!Array.isArray(userDocs)) {
      throw new Error('[CommunityAnnotationSession] user documents must be an array');
    }
    const remote = new RemoteUserFiles({ ownUsername: this._getEffectiveUserKey() });
    for (const document of userDocs) remote.add(document);
    return this._mergeRemoteUserFilesExact(remote, options);
  }

  /**
   * Merge one Pull's remote user files, already folded by `RemoteUserFiles`
   * as they streamed in, with this session's local state.
   *
   * @param {RemoteUserFiles} remote
   * @param {object} [options]
   */
  _mergeRemoteUserFilesExact(remote, options = {}) {
    if (!(remote instanceof RemoteUserFiles)) {
      throw new TypeError('[CommunityAnnotationSession] remote user files must be a RemoteUserFiles');
    }
    for (const [bucket, list] of Object.entries(this._state.suggestions)) {
      if (!Array.isArray(list)) {
        throw new Error(
          `[CommunityAnnotationSession] suggestions bucket ${JSON.stringify(bucket)} must be an array`
        );
      }
    }

    const preferLocalVotes = options.preferLocalVotes !== false;
    const hydrateFromOwnFile = options.hydrateFromOwnFile !== false;
    const myUsername = this._getEffectiveUserKey();
    const myUserLower = normalizeUsername(myUsername);
    if (remote.ownUsername !== myUserLower) {
      throw new Error(
        '[CommunityAnnotationSession] remote user files were folded for another user'
      );
    }

    // 0) Optional public profile info from user docs (displayName/title/orcid/linkedin).
    // This is local-only UI metadata (not pushed anywhere by the app).
    this._knownProfiles = { ...remote.knownProfiles };

    // Hydrate my profile fields from my GitHub user file if we don't have them yet.
    const mine = this._profile || sanitizeProfile({});
    const hasAny = Boolean(mine.displayName || mine.title || mine.orcid || mine.linkedin);
    if (!hasAny && remote.ownDoc !== null) {
      {
        const doc = remote.ownDoc;
        this._profile = sanitizeProfile({
          username: doc.username,
          githubUserId: doc.githubUserId,
          login: doc.login || '',
          displayName: doc.displayName || '',
          title: doc.title || '',
          orcid: doc.orcid || '',
          linkedin: doc.linkedin || ''
        });
        this._state.profile = { ...this._profile };
      }
    }

    // 1) Union suggestion metadata from local + remote.
    const byBucketById = new Map(); // bucket -> Map(id -> suggestionMeta)
    const idToBucket = new Map();

    // 1a) Collect deletion markers from remote docs + local session.
    // Only the proposer may delete: a deletion marker from username U only applies
    // to suggestions where `proposedBy` normalizes to U.
    const deletedByBucketById = new Map(); // bucket -> Map(suggestionId -> Set(usernameLower))
    const addDeleted = (bucket, suggestionId, username) => {
      const b = this._canonicalizeBucketKey(bucket);
      if (!b) throw new Error(`Invalid deleted-suggestion bucket ${JSON.stringify(bucket)}`);
      const sid = assertSessionSuggestionId(
        suggestionId,
        'deleted suggestion id'
      );
      const u = normalizeUsername(username);
      if (!u) throw new Error('Deleted suggestion owner must be an exact user identity');
      if (!deletedByBucketById.has(b)) deletedByBucketById.set(b, new Map());
      const m = deletedByBucketById.get(b);
      if (!m.has(sid)) m.set(sid, new Set());
      m.get(sid).add(u);
    };

    // local deletions (current user)
    if (
      !this._state.deletedSuggestions ||
      typeof this._state.deletedSuggestions !== 'object' ||
      Array.isArray(this._state.deletedSuggestions)
    ) {
      throw new Error('[CommunityAnnotationSession] deleted suggestions must be an object');
    }
    const localDeleted = this._state.deletedSuggestions;
    for (const [bucket, ids] of Object.entries(localDeleted)) {
      if (!Array.isArray(ids)) {
        throw new Error(
          `Deleted suggestions for ${JSON.stringify(bucket)} must be an array`
        );
      }
      for (const id of ids) addDeleted(bucket, id, myUsername);
    }

    const addSuggestion = (bucket, suggestion, { sourceUser = null } = {}) => {
      const b = this._canonicalizeBucketKey(bucket);
      if (!b) throw new Error(`Invalid suggestion bucket ${JSON.stringify(bucket)}`);
      const normalized = cloneWireSuggestion(suggestion);

      const id = normalized.id;
      if (idToBucket.has(id) && idToBucket.get(id) !== b) {
        throw new Error(
          `Suggestion id ${JSON.stringify(id)} appears in both ` +
          `${JSON.stringify(idToBucket.get(id))} and ${JSON.stringify(b)}`
        );
      }
      idToBucket.set(id, b);

      if (!byBucketById.has(b)) byBucketById.set(b, new Map());
      const m = byBucketById.get(b);
      const existing = m.get(id) || null;
      const sourceLower = sourceUser ? normalizeUsername(sourceUser) : '';
      const preferRemoteMeta = Boolean(sourceLower && myUserLower && sourceLower !== myUserLower);
      m.set(id, mergeSuggestionMeta(existing, normalized, { preferIncoming: preferRemoteMeta }));
    };

    for (const [bucket, list] of Object.entries(this._state.suggestions)) {
      for (const s of list) addSuggestion(bucket, s);
    }

    // The current user's remote doc is special: we may need to hydrate local persisted state
    // (votes/comments/deletions) for multi-device usage. Local intent still wins.
    const myRemoteDoc = remote.ownDoc;

    // remote deletion markers
    for (const [bucket, id, docUser] of remote.deletions) addDeleted(bucket, id, docUser);

    for (const { bucket, suggestion, sourceUser } of remote.suggestions.values()) {
      addSuggestion(bucket, suggestion, { sourceUser });
    }

    // Apply deletion markers now that we have suggestion metadata (including proposedBy).
    if (deletedByBucketById.size) {
      for (const [bucket, m] of byBucketById.entries()) {
        const dels = deletedByBucketById.get(bucket) || null;
        if (!dels) continue;
        for (const [sid, meta] of m.entries()) {
          const proposer = normalizeUsername(meta.proposedBy);
          const delSet = dels.get(sid);
          if (!delSet || !delSet.has(proposer)) continue;
          m.delete(sid);
          idToBucket.delete(sid);
        }
      }
    }

    // Prune local vote/comment attachments for suggestion ids that no longer exist after deletions.
    // This avoids UI states like "I voted" when the aggregated vote arrays exclude the orphaned vote.
    if (
      !this._state.myVotes ||
      typeof this._state.myVotes !== 'object' ||
      Array.isArray(this._state.myVotes)
    ) {
      throw new Error('[CommunityAnnotationSession] local votes must be an object');
    }
    for (const k of Object.keys(this._state.myVotes)) {
      const parsed = parseVoteKey(k);
      if (!parsed) throw new Error(`Invalid local vote key ${JSON.stringify(k)}`);
      const referencedBucket = idToBucket.get(parsed.suggestionId) ?? null;
      if (
        referencedBucket !== null &&
        referencedBucket !== bucketKey(parsed.fieldKey, parsed.catKey)
      ) {
        throw new Error(
          `Local vote key ${JSON.stringify(k)} does not reference its ` +
          'suggestion in the exact bucket'
        );
      }
      if (!idToBucket.has(parsed.suggestionId)) delete this._state.myVotes[k];
    }
    if (
      !this._state.myComments ||
      typeof this._state.myComments !== 'object' ||
      Array.isArray(this._state.myComments)
    ) {
      throw new Error('[CommunityAnnotationSession] local comments must be an object');
    }
    for (const sid of Object.keys(this._state.myComments)) {
      if (!idToBucket.has(sid)) delete this._state.myComments[sid];
    }

    // Hydrate persisted local state from the user's own remote user file (multi-device Pull/Publish).
    // Only fill gaps: if local state has a vote/comment/deletion, it remains authoritative.
    // A Pull skips this when the file is the version this session already
    // published or pulled, so a local retraction is never filled back in.
    if (hydrateFromOwnFile && myRemoteDoc && myUserLower) {
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
            const cleaned = [...ids];
            if (!cleaned.length) continue;
            const existing = Array.isArray(this._state.deletedSuggestions[bucket]) ? this._state.deletedSuggestions[bucket] : [];
            this._state.deletedSuggestions[bucket] = uniqueStrings(existing.concat(cleaned));
          }
        }

        // 2) Votes (schema stores only by suggestionId)
        const remoteVotes = myRemoteDoc.votes && typeof myRemoteDoc.votes === 'object' ? myRemoteDoc.votes : null;
        if (remoteVotes) {
          const resolveTargetForBucket = (bucket, suggestionId) => {
            const map = this._mergeMapFor(bucket);
            return map.size ? (resolveMergeTarget(suggestionId, map) || suggestionId) : suggestionId;
          };

          const localTargetsByBucket = new Map(); // bucket -> Set(targetId)
          for (const [voteKey, v] of Object.entries(this._state.myVotes || {})) {
            const parsed = parseVoteKey(voteKey);
            if (!parsed) throw new Error(`Invalid local vote key ${JSON.stringify(voteKey)}`);
            if (v !== 'up' && v !== 'down') {
              throw new Error(`Invalid local vote direction for ${JSON.stringify(voteKey)}`);
            }
            const bucket = idToBucket.get(parsed.suggestionId);
            if (!bucket) continue;
            const target = resolveTargetForBucket(bucket, parsed.suggestionId);
            if (!target) throw new Error('Moderation merge target resolution failed');
            if (!localTargetsByBucket.has(bucket)) localTargetsByBucket.set(bucket, new Set());
            localTargetsByBucket.get(bucket).add(target);
          }

          const parseBucketToParts = (bucket) => {
            return parseBucketKey(bucket);
          };

          for (const [sidRaw, dir] of Object.entries(remoteVotes)) {
            const sid = sidRaw;
            const d = dir;
            if (!idToBucket.has(sid)) continue; // skip deleted/orphaned ids
            const bucket = idToBucket.get(sid);
            const target = resolveTargetForBucket(bucket, sid);
            const localTargets = localTargetsByBucket.get(bucket) || null;
            if (target && localTargets && localTargets.has(target)) continue;
            const parts = parseBucketToParts(bucket);
            if (!parts) throw new Error(`Invalid exact bucket ${JSON.stringify(bucket)}`);
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
          if (
            !this._state.myComments ||
            typeof this._state.myComments !== 'object' ||
            Array.isArray(this._state.myComments)
          ) {
            this._state.myComments = createExactRecord();
          }
          for (const [sidRaw, commentList] of Object.entries(remoteComments)) {
            const sid = sidRaw;
            if (!idToBucket.has(sid)) continue; // skip deleted/orphaned ids

            const currentComments =
              Object.hasOwn(this._state.myComments, sid)
                ? this._state.myComments[sid]
                : undefined;
            if (currentComments !== undefined && !Array.isArray(currentComments)) {
              throw new Error(`Local comments for ${JSON.stringify(sid)} must be an array`);
            }
            const existing = currentComments ?? [];
            const byId = new Map();
            for (const c of existing) {
              const normalized = normalizeComment(c);
              byId.set(normalized.id, normalized);
            }
            for (const c of commentList) {
              const normalized = normalizeComment({ ...c, authorUsername: myUserLower });
              const prev = byId.get(normalized.id) || null;
              if (prev && commentInstant(normalized) <= commentInstant(prev)) continue;
              byId.set(normalized.id, normalized);
            }
            const merged = [...byId.values()].sort(commentOrder);
            if (merged.length) this._state.myComments[sid] = merged;
          }
        }
    }

    // 2) Aggregate votes (remote + local for current user).
    const upvotesById = new Map(); // id -> Set(username)
    const downvotesById = new Map(); // id -> Set(username)

    const applyVote = (suggestionId, username, direction) => {
      const sid = suggestionId;
      const u = normalizeUsername(username);
      if (typeof sid !== 'string' || !sid || !u) {
        throw new Error('Vote identity must use exact nonempty strings');
      }
      if (!idToBucket.has(sid)) return;

      if (!upvotesById.has(sid)) upvotesById.set(sid, new Set());
      if (!downvotesById.has(sid)) downvotesById.set(sid, new Set());
      upvotesById.get(sid).delete(u);
      downvotesById.get(sid).delete(u);
      if (direction === 'up') upvotesById.get(sid).add(u);
      if (direction === 'down') downvotesById.get(sid).add(u);
    };

    for (const [sid, votes] of remote.votes) {
      for (const [docUser, dir] of votes) applyVote(sid, docUser, dir);
    }
    if (!preferLocalVotes && myRemoteDoc !== null) {
      for (const [sid, dir] of Object.entries(myRemoteDoc.votes)) {
        applyVote(sid, myRemoteDoc.username, dir);
      }
    }

    // Apply local current user's votes last.
    for (const [k, dir] of Object.entries(this._state.myVotes || {})) {
      const parsed = parseVoteKey(k);
      if (!parsed) throw new Error(`Invalid local vote key ${JSON.stringify(k)}`);
      if (dir !== 'up' && dir !== 'down') {
        throw new Error(`Invalid local vote direction for ${JSON.stringify(k)}`);
      }
      applyVote(parsed.suggestionId, myUsername, dir);
    }

    // 2b) Aggregate comments from all user docs.
    const commentsById = new Map(); // suggestionId -> Map(commentId -> comment)

    const addComment = (suggestionId, comment) => {
      const sid = suggestionId;
      if (typeof sid !== 'string' || !sid) {
        throw new Error('Comment target must be an exact nonempty string');
      }
      if (!idToBucket.has(sid)) return;
      const normalized = normalizeComment(comment);

      if (!commentsById.has(sid)) commentsById.set(sid, new Map());
      const aggregateKey = `${normalized.authorUsername}\u0000${normalized.id}`;
      const existing = commentsById.get(sid).get(aggregateKey);
      // Last-write-wins: the later edit (or creation) instant.
      if (existing && commentInstant(normalized) <= commentInstant(existing)) return;
      commentsById.get(sid).set(aggregateKey, normalized);
    };

    // Comments from the other users' remote docs (the local user's own come
    // from local state below).
    for (const [suggestionId, comments] of remote.comments) {
      for (const comment of comments.values()) addComment(suggestionId, comment);
    }

    // Apply local user's comments last (local wins)
    for (const [suggestionId, commentList] of Object.entries(this._state.myComments || {})) {
      if (!Array.isArray(commentList)) {
        throw new Error(`Local comments for ${JSON.stringify(suggestionId)} must be an array`);
      }
      for (const c of commentList) {
        addComment(suggestionId, c);
      }
    }

    // 3) Materialize merged suggestions back into state (with upvotes/downvotes/comments arrays).
    const nextSuggestions = {};
    for (const [bucket, m] of byBucketById.entries()) {
      const out = [];
      for (const s of m.values()) {
        const sid = s.id;
        const commentMap = commentsById.get(sid) || new Map();
        const commentList = [...commentMap.values()].sort(commentOrder);
        out.push({
          ...s,
          upvotes: uniqueStrings([...(upvotesById.get(sid) || new Set())]),
          downvotes: uniqueStrings([...(downvotesById.get(sid) || new Set())]),
          comments: commentList
        });
      }
      out.sort((a, b) => ((b.upvotes?.length || 0) - (b.downvotes?.length || 0)) - ((a.upvotes?.length || 0) - (a.downvotes?.length || 0)));
      nextSuggestions[bucket] = out;
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
    const kept = webStorage('localStorage');
    if (key && kept === null) {
      const error = new Error(
        'localStorage is required for exact community annotation session persistence'
      );
      error.code = 'LOCAL_ANNOTATION_PERSISTENCE_UNAVAILABLE';
      throw error;
    }
    let raw = null;
    if (key) {
      try {
        raw = kept.getItem(key);
      } catch (cause) {
        this._persistenceOk = false;
        const error = new Error(
          `Local community annotation persistence read failed for ${key}: ${cause?.message || cause}`
        );
        error.code = 'LOCAL_ANNOTATION_PERSISTENCE_FAILED';
        error.cause = cause;
        throw error;
      }
    }
    let next = defaultState();
    const scopedUserId = normalizeGitHubUserIdOrNull(this._cacheUserId);
    if (raw === null && scopedUserId !== null) {
      // An empty authenticated scope must still be internally valid before
      // synchronous `changed` listeners observe it. The authoritative GitHub
      // login is applied by the owning UI immediately afterwards; keeping the
      // remaining fields empty avoids copying repo-scoped profile metadata.
      next.profile = sanitizeProfile({
        username: `ghid_${scopedUserId}`,
        githubUserId: scopedUserId,
      });
    }
    if (raw !== null) {
      try {
        const parsed = parseExactJson(raw, { path: `$ local state ${key}` });
        if (parsed?.version !== STORAGE_VERSION) {
          throw new Error(
            `written by another Cellucid version in local format ${JSON.stringify(parsed?.version)}; ` +
            `this Cellucid reads format ${STORAGE_VERSION} only. Clear this repository's local annotation cache ` +
            '(your published annotations stay on GitHub) and Pull again'
          );
        }
        assertLocalPersistenceDocument(parsed, {
          scopeUserId: normalizeGitHubUserIdOrNull(this._cacheUserId),
        });
        next = restoreExactIdentityRecords(
          JSON.parse(JSON.stringify(parsed))
        );
        next.suggestions = {};
        for (const [bucket, list] of Object.entries(parsed.suggestions)) {
          next.suggestions[bucket] = list.map((suggestion) => ({
            ...suggestion,
            markers: Array.isArray(suggestion.markers)
              ? suggestion.markers.map((marker) =>
                typeof marker === 'string' ? marker : { ...marker }
              )
              : suggestion.markers,
            upvotes: [],
            downvotes: [],
            comments: [],
          }));
        }

        const localUser = parsed.profile.username;
        for (const [voteKey, direction] of Object.entries(parsed.myVotes)) {
          const vote = parseVoteKey(voteKey);
          if (!vote) continue;
          const bucket = bucketKey(vote.fieldKey, vote.catKey);
          const suggestion = next.suggestions[bucket]?.find(
            (item) => item.id === vote.suggestionId
          );
          if (!suggestion) continue;
          if (direction === 'up') suggestion.upvotes.push(localUser);
          else suggestion.downvotes.push(localUser);
        }
        for (const [suggestionId, comments] of Object.entries(parsed.myComments)) {
          for (const list of Object.values(next.suggestions)) {
            const suggestion = list.find((item) => item.id === suggestionId);
            if (!suggestion) continue;
            suggestion.comments = comments.map((comment) => ({ ...comment }));
            break;
          }
        }
      } catch (cause) {
        this._persistenceOk = false;
        const error = new Error(
          `Invalid local community annotation state for ${key}: ${cause?.message || cause}`
        );
        error.code = 'LOCAL_ANNOTATION_STATE_INVALID';
        error.cause = cause;
        this.emit('integrity:error', {
          datasetId: this._datasetId,
          repoRef: this._repoRef,
          userId: this._cacheUserId,
          scopeKey: key,
          message: error.message,
        });
        throw error;
      }
    }

    this._loadedForKey = key;
    this._state = next;
    this._profile = { ...next.profile };

    this.emit('changed', { reason: 'load' });
  }

  _touch() {
    this._revision += 1;
    if (this._pullApplicationTransactionActive) {
      return;
    }
    this._state.updatedAt = nowIso();
    if (this._persistenceOk) this._scheduleSave();
    this.emit('changed', { reason: 'update' });
  }

  _scheduleSave() {
    if (!this._persistenceOk) return;
    if (this._saveTimer !== null) return;
    this._saveTimer = setTimeout(() => this._runScheduledSave(), 150);
  }

  /**
   * Write a save that is still waiting for its debounce now. Called when the
   * page is hidden or unloaded, where the debounce timer would never fire.
   */
  flushPendingSave() {
    if (this._saveTimer === null) return;
    this._runScheduledSave();
  }

  _runScheduledSave() {
    if (this._saveTimer !== null) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    try {
      this._saveNow();
    } catch (error) {
      if (
        error?.code !== 'LOCAL_ANNOTATION_STATE_INVALID' &&
        error?.code !== 'LOCAL_ANNOTATION_PERSISTENCE_FAILED'
      ) {
        this._persistenceOk = false;
        this.emit('persistence:error', {
          datasetId: this._datasetId,
          repoRef: this._repoRef,
          userId: this._cacheUserId,
          message:
            typeof error?.message === 'string' && error.message
              ? error.message
              : 'Scheduled community annotation persistence failed',
        });
      }
    }
  }

  _saveNow() {
    const key = toSessionStorageKey({ datasetId: this._datasetId, repoRef: this._repoRef, userId: this._cacheUserId });
    if (!key) return;
    const scopeKey = toCacheScopeKey({ datasetId: this._datasetId, repoRef: this._repoRef, userId: this._cacheUserId });
    if (scopeKey && !this._scopeLock.isHolding(scopeKey)) {
      const error = new Error(
        'Cannot persist community annotations without the exact cache-scope lock'
      );
      error.code = 'LOCAL_ANNOTATION_LOCK_REQUIRED';
      throw error;
    }
    // Persist only local intent, including offline `local` attribution. Publishing
    // remains a separate GitHub-only boundary with the stricter user-file contract.
    const localUser = this._getEffectiveUserKey();
    const localSuggestions = {};
    for (const [bucket, list] of Object.entries(this._state.suggestions)) {
      if (!Array.isArray(list)) {
        throw new Error(
          `[CommunityAnnotationSession] suggestions bucket ${JSON.stringify(bucket)} must be an array`
        );
      }
      const mine = list
        .filter((suggestion) => suggestion?.proposedBy === localUser)
        .map(cloneWireSuggestion);
      if (mine.length) localSuggestions[bucket] = mine;
    }
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
      suggestions: localSuggestions,
      deletedSuggestions: this._state.deletedSuggestions,
    };
    try {
      assertLocalPersistenceDocument(persisted, {
        scopeUserId: normalizeGitHubUserIdOrNull(this._cacheUserId),
      });
    } catch (cause) {
      this._persistenceOk = false;
      const error = new Error(
        `Invalid in-memory community annotation state: ${cause?.message || cause}`
      );
      error.code = 'LOCAL_ANNOTATION_STATE_INVALID';
      error.cause = cause;
      this.emit('integrity:error', {
        datasetId: this._datasetId,
        repoRef: this._repoRef,
        userId: this._cacheUserId,
        scopeKey: key,
        message: error.message,
      });
      throw error;
    }
    const payload = JSON.stringify(persisted);
    try {
      const kept = webStorage('localStorage');
      if (kept === null) throw new Error('localStorage is unavailable');
      kept.setItem(key, payload);
      this._persistenceErrorEmittedForKey = null;
    } catch (cause) {
      this._persistenceOk = false;
      const error = new Error(
        `Local community annotation persistence failed: ${cause?.message || cause}`
      );
      error.code = 'LOCAL_ANNOTATION_PERSISTENCE_FAILED';
      error.cause = cause;
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
      throw error;
    }
  }
}

let _session = null;

export function getCommunityAnnotationSession() {
  if (_session) return _session;
  _session = new CommunityAnnotationSession();
  return _session;
}
