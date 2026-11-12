/**
 * @fileoverview What the person has published to the connected repository,
 * as this browser last saw it, and what of their own work is not published
 * yet.
 *
 * - **The published view** of the person's own file (the open dataset's
 *   section and the profile) is kept per cache scope in this browser
 *   (`cache-scope.js` `toPublishedViewKey`) with the SHA it was read at: set
 *   by every Pull (the own file pulled, or none) and every Publish (the view
 *   written). It counts only while that SHA is the one the session knows for
 *   the file (`session.getRemoteFileShas()`), so a cleared cache or a Publish
 *   from another device makes it unknown until the next Pull, never wrong.
 * - **What is not published** (`pendingChangesOf`): the person's own view
 *   now (`session.buildUserFileDocument`) against the published view, item
 *   by item (a vote, a suggestion, a comment, a deletion, the profile), and,
 *   for an author, the repository settings and merges against what the last
 *   Pull read. The panel says it in one line ("3 changes not published ·
 *   Publish"), and an agent's `annotation.publish` says it in its question
 *   (only its votes and suggestions are published; the rest stays here).
 *
 * @module ui/modules/community-annotation/published-baseline
 */

import { toPublishedViewKey } from '../../../community-annotations/cache-scope.js';
import { formatCountOf } from '../../../../utils/format-units.js';
import { webStorage } from '../../../../utils/web-storage.js';

/** The person's own file path in the repository. */
export function ownUserFilePath(githubUserId) {
  return `annotations/users/ghid_${githubUserId}.json`;
}

function storage() {
  return webStorage('localStorage');
}

/**
 * Keep the published view of the person's own file for one cache scope.
 * @param {{datasetId: string, repoRef: string, userId: number}} scope
 * @param {{sha: string|null, view: object|null}} baseline - `sha` null and
 *   `view` null: nothing is published yet
 */
export function setPublishedBaseline(scope, { sha, view }) {
  const key = toPublishedViewKey(scope);
  if (key === null) return;
  try {
    storage()?.setItem(key, JSON.stringify({ sha: sha ?? null, view: view ?? null }));
  } catch {
    // A browser that keeps no site data: the line stays unknown after a reload.
  }
}

/**
 * The published view of the person's own file, or undefined when this
 * browser does not know it (no Pull since its cache was cleared, or the file
 * changed since): `null` when nothing is published yet.
 * @param {{datasetId: string, repoRef: string, userId: number}} scope
 * @param {Record<string, string>} remoteShas - the session's known SHAs
 * @returns {object|null|undefined}
 */
export function publishedBaseline(scope, remoteShas) {
  const key = toPublishedViewKey(scope);
  if (key === null || !Number.isSafeInteger(scope?.userId)) return undefined;
  let kept;
  try {
    kept = JSON.parse(storage()?.getItem(key) ?? 'null');
  } catch {
    return undefined;
  }
  if (kept === null || typeof kept !== 'object') return undefined;
  const known = remoteShas?.[ownUserFilePath(scope.userId)] ?? null;
  if ((kept.sha ?? null) !== known) return undefined;
  return kept.view ?? null;
}

/** Forget the published view of one cache scope (its local cache cleared). */
export function clearPublishedBaseline(scope) {
  const key = toPublishedViewKey(scope);
  if (key === null) return;
  try {
    storage()?.removeItem(key);
  } catch {
    // Nothing kept.
  }
}

/** JSON with every object's keys in code-unit order, so two equal values read the same whatever order built them. */
function canonical(value) {
  return JSON.stringify(value ?? null, (_key, item) => (item !== null && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
    : item));
}

/** Whether two JSON values are equal, whatever order their keys were built in. */
export function sameJson(left, right) {
  return canonical(left) === canonical(right);
}

/** How many keys of two records differ (added, removed or changed). */
function differingKeys(left = {}, right = {}) {
  let count = 0;
  for (const key of new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})])) {
    if (canonical(left?.[key]) !== canonical(right?.[key])) count += 1;
  }
  return count;
}

/** Suggestions by id, from `{bucket: Suggestion[]}`. */
function suggestionsById(record = {}) {
  const out = {};
  for (const list of Object.values(record ?? {})) {
    for (const suggestion of list ?? []) out[suggestion.id] = suggestion;
  }
  return out;
}

/** Comments by suggestion id and comment id. */
function commentsById(record = {}) {
  const out = {};
  for (const [suggestionId, list] of Object.entries(record ?? {})) {
    for (const comment of list ?? []) out[`${suggestionId}\u0000${comment.id}`] = comment;
  }
  return out;
}

function deletedIds(record = {}) {
  const out = {};
  for (const [bucket, ids] of Object.entries(record ?? {})) {
    for (const id of ids ?? []) out[`${bucket}\u0000${id}`] = true;
  }
  return out;
}

const PROFILE_FIELDS = Object.freeze(['displayName', 'title', 'orcid', 'linkedin']);

/**
 * What of the person's own work is not published: each kind counted item by
 * item. `published` undefined (not known) gives null.
 *
 * @param {{local: object, published: object|null|undefined, settingsChanged?: boolean, mergesChanged?: number}} input -
 *   `local` and `published`: user-document views (`assertUserDocument`);
 *   `settingsChanged`: an author's repository settings differ from the last
 *   Pull's; `mergesChanged`: how many merges an author changed
 * @returns {{votes: number, suggestions: number, comments: number, deletions: number, profile: number,
 *   settings: number, merges: number, total: number}|null}
 */
export function pendingChangesOf({ local, published, settingsChanged = false, mergesChanged = 0 }) {
  if (published === undefined || local === null || local === undefined) return null;
  const base = published ?? {};
  const counts = {
    votes: differingKeys(local.votes, base.votes),
    suggestions: differingKeys(suggestionsById(local.suggestions), suggestionsById(base.suggestions)),
    comments: differingKeys(commentsById(local.comments), commentsById(base.comments)),
    deletions: differingKeys(deletedIds(local.deletedSuggestions), deletedIds(base.deletedSuggestions)),
    profile: PROFILE_FIELDS.some(field => (local[field] ?? '') !== (base[field] ?? '')) ? 1 : 0,
    settings: settingsChanged ? 1 : 0,
    merges: mergesChanged,
  };
  counts.total = counts.votes + counts.suggestions + counts.comments + counts.deletions + counts.profile + counts.settings + counts.merges;
  return counts;
}

/** Two lists of moderation merges compared as sets keyed by bucket and merged suggestion: how many differ. */
export function differingMerges(local = [], published = []) {
  const key = merge => `${merge.datasetId ?? ''}\u0000${merge.bucket}\u0000${merge.fromSuggestionId}`;
  const left = Object.fromEntries((local ?? []).map(merge => [key(merge), merge]));
  const right = Object.fromEntries((published ?? []).map(merge => [key(merge), merge]));
  return differingKeys(left, right);
}

const KIND_WORDS = Object.freeze([
  ['votes', 'vote', 'votes'],
  ['suggestions', 'suggestion', 'suggestions'],
  ['comments', 'comment', 'comments'],
  ['deletions', 'deletion', 'deletions'],
  ['profile', 'profile change', 'profile changes'],
  ['settings', 'repository setting change', 'repository setting changes'],
  ['merges', 'merge', 'merges'],
]);

/** "3 changes not published", or null when none (or not known). */
export function pendingLine(counts) {
  if (counts === null || counts.total === 0) return null;
  return `${formatCountOf(counts.total, 'change')} not published`;
}

/** The pending changes in words, kind by kind: "2 votes, 1 suggestion". */
export function pendingDetail(counts) {
  if (counts === null) return '';
  return KIND_WORDS
    .filter(([kind]) => counts[kind] > 0)
    .map(([kind, one, many]) => formatCountOf(counts[kind], one, many))
    .join(', ');
}

/**
 * The person's view of the open dataset as published now plus the given
 * votes and suggestions of theirs and nothing else: what an agent's
 * `annotation.publish` writes, in one commit (`pushMyUserFile` composes it
 * with the file as published now). Each suggestion comes with the person's
 * upvote, as the voting dialog adds one; then each vote is set (`null`
 * takes it back). The view as published comes back unchanged (the same
 * object) when nothing changes, so nothing is written.
 *
 * @param {object|null} published - the view published now, null when the person has no file
 * @param {{githubUserId: number, login: string,
 *   votes?: Array<{suggestionId: string, direction: 'up'|'down'|null}>,
 *   suggestions?: Array<{bucket: string, suggestion: object}>, now?: string}} changes -
 *   `bucket`: a suggestion's bucket key; `suggestion`: as the user file holds it
 * @returns {object} a user-document view (`assertUserDocument`)
 */
export function withChanges(published, { githubUserId, login, votes = [], suggestions = [], now = new Date().toISOString() }) {
  const base = published ?? {
    version: 1,
    username: `ghid_${githubUserId}`,
    githubUserId,
    ...(login ? { login } : {}),
    updatedAt: now,
    suggestions: {},
    votes: {},
  };
  const nextSuggestions = { ...base.suggestions };
  const nextVotes = { ...base.votes };
  let changed = false;
  for (const { bucket, suggestion } of suggestions) {
    const list = nextSuggestions[bucket] ?? [];
    if (list.some(entry => entry.id === suggestion.id)) continue;
    nextSuggestions[bucket] = [...list, suggestion];
    nextVotes[suggestion.id] = 'up';
    changed = true;
  }
  for (const { suggestionId, direction } of votes) {
    if ((nextVotes[suggestionId] ?? null) === direction) continue;
    if (direction === null) delete nextVotes[suggestionId];
    else nextVotes[suggestionId] = direction;
    changed = true;
  }
  if (!changed) return base;
  return { ...base, updatedAt: now, suggestions: nextSuggestions, votes: nextVotes };
}
