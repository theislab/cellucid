/**
 * @fileoverview Community annotation voting modal.
 *
 * Centralizes the voting/suggestion UX in a modal so we don't render voting UI
 * inline in sidebar accordions/legends.
 *
 * @module ui/modules/community-annotation-voting-modal
 */

import { getNotificationCenter } from '../../notification-center.js';
import { getCommunityAnnotationSession } from '../../community-annotations/session.js';
import { getCommunityAnnotationAccessStore, isAnnotationRepoConnected } from '../../community-annotations/access-store.js';
import { showConfirmDialog } from '../components/confirm-dialog.js';
import { formatCountOf, formatPercent } from '../components/display-format.js';
import { claimModalDocumentLayer } from '../components/modal-background-owner.js';
import * as capApi from '../../community-annotations/cap-api.js';
import { ANNOTATION_CONNECTION_CHANGED_EVENT } from '../../community-annotations/connection-events.js';
import {
  getCommunityAnnotationCacheContext,
  syncCommunityAnnotationCacheContext
} from '../../community-annotations/runtime-context.js';
import {
  claimCommunityAnnotationModal
} from './community-annotation-modal-owner.js';
import { el, toCleanString } from './community-annotation/dom.js';
import { createDomId } from '../components/dom-id.js';
import { createInfoTip } from '../components/controls.js';

function requireVotingContext(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const expectedKeys = [
    'datasetId',
    'repoRef',
    'simulated',
    'userId',
    'userKey'
  ];
  const actualKeys = Object.keys(value).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    !actualKeys.every((key, index) => key === expectedKeys[index])
  ) {
    throw new TypeError(`${label} must expose the exact cache-context keys`);
  }
  for (const key of ['datasetId', 'repoRef']) {
    const entry = value[key];
    if (
      entry !== null &&
      (
        typeof entry !== 'string' ||
        entry.length === 0 ||
        entry !== entry.trim()
      )
    ) {
      throw new TypeError(`${label}.${key} must be an exact string or null`);
    }
  }
  if (
    typeof value.userKey !== 'string' ||
    value.userKey.length === 0 ||
    value.userKey !== value.userKey.trim()
  ) {
    throw new TypeError(`${label}.userKey must be an exact string`);
  }
  if (
    value.userId !== null &&
    (
      !Number.isSafeInteger(value.userId) ||
      value.userId < 1
    )
  ) {
    throw new TypeError(
      `${label}.userId must be a positive safe integer or null`
    );
  }
  if (typeof value.simulated !== 'boolean') {
    throw new TypeError(`${label}.simulated must be boolean`);
  }
  return value;
}

export function createCommunityAnnotationVotingContextLease(context) {
  if (typeof AbortController !== 'function') {
    throw new TypeError(
      'Community voting context ownership requires AbortController'
    );
  }
  const source = requireVotingContext(
    context,
    'Community voting opening context'
  );
  const openingContext = Object.freeze({
    datasetId: source.datasetId,
    repoRef: source.repoRef,
    simulated: source.simulated,
    userId: source.userId,
    userKey: source.userKey
  });
  const controller = new AbortController();
  return Object.freeze({
    context: openingContext,
    signal: controller.signal,
    isCurrent(candidate) {
      const current = requireVotingContext(
        candidate,
        'Community voting current context'
      );
      return (
        !controller.signal.aborted &&
        current.datasetId === openingContext.datasetId &&
        current.repoRef === openingContext.repoRef &&
        current.simulated === openingContext.simulated &&
        current.userId === openingContext.userId &&
        current.userKey === openingContext.userKey
      );
    },
    retire() {
      if (!controller.signal.aborted) controller.abort();
    }
  });
}

function runExactCleanup(context, entries) {
  const errors = [];
  for (const [label, operation] of entries) {
    if (operation === null || operation === undefined) continue;
    if (typeof operation !== 'function') {
      errors.push(new TypeError(`${label} cleanup must be a function`));
      continue;
    }
    try {
      operation();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      `${context} failed in ${errors.length} cleanup operations`
    );
  }
}

function releaseExactModalDocumentLayer(release, label) {
  if (typeof release !== 'function') {
    throw new TypeError(`${label} release owner must be a function`);
  }
  try {
    if (release() !== true) {
      throw new Error(`${label} lost its exact document-layer owner`);
    }
    return true;
  } catch (primaryError) {
    try {
      if (release() !== true) {
        throw new Error(`${label} document-layer retry lost ownership`);
      }
      return true;
    } catch (retryError) {
      throw new AggregateError(
        [primaryError, retryError],
        `${label} document-layer release failed twice`
      );
    }
  }
}

function describeErrorMessage(err) {
  if (!(err instanceof Error)) {
    throw new TypeError('Community annotation operations must reject with an Error instance');
  }
  if (typeof err.message !== 'string' || err.message.length === 0 || err.message !== err.message.trim()) {
    throw new TypeError('Community annotation errors require a non-empty trimmed message');
  }
  return err.message;
}

function formatCommentAuthorHandle(session, username) {
  if (
    typeof username !== 'string' ||
    username.length === 0 ||
    username !== username.trim() ||
    username.startsWith('@')
  ) {
    throw new TypeError('Comment author username must be an exact handle');
  }
  if (!session || typeof session.getKnownUserProfile !== 'function') {
    throw new TypeError('Comment author formatting requires getKnownUserProfile()');
  }
  const prof = session.getKnownUserProfile(username);
  const login = prof?.login ?? '';
  if (typeof login !== 'string' || login !== login.trim()) {
    throw new TypeError('Known comment author login must be an exact string');
  }
  const handle = login || username;
  // The whole handle: a GitHub login is at most 39 characters.
  return `@${handle}`;
}

function bucketKey(session, fieldKey, catIdx) {
  if (!session || typeof session.toBucketKey !== 'function') {
    throw new TypeError('Community annotation session must expose toBucketKey()');
  }
  const key = session.toBucketKey(fieldKey, catIdx);
  if (typeof key !== 'string' || key.length === 0 || key !== key.trim()) {
    throw new TypeError('Community annotation bucket key must be an exact string');
  }
  return key;
}

function requireSuggestionId(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
  ) {
    throw new TypeError(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

/**
 * Validate and deterministically order the exact merge edges that terminate at
 * one suggestion bundle. Each included edge is returned once.
 *
 * @param {{ targetSuggestionId: string, merges: object[] }} input
 * @returns {{ targetSuggestionId: string, steps: Array<{fromSuggestionId: string, intoSuggestionId: string, merge: object}> }}
 */
export function buildMergeTraversal(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Merge traversal input must be an object');
  }
  const targetSuggestionId = requireSuggestionId(
    input.targetSuggestionId,
    'Merge traversal targetSuggestionId'
  );
  if (!Array.isArray(input.merges)) {
    throw new TypeError('Merge traversal merges must be an array');
  }

  const fromTo = new Map();
  const mergeByFrom = new Map();
  for (let index = 0; index < input.merges.length; index++) {
    const merge = input.merges[index];
    if (!merge || typeof merge !== 'object' || Array.isArray(merge)) {
      throw new TypeError(`Merge traversal entry ${index} must be an object`);
    }
    const fromSuggestionId = requireSuggestionId(
      merge.fromSuggestionId,
      `Merge traversal entry ${index} fromSuggestionId`
    );
    const intoSuggestionId = requireSuggestionId(
      merge.intoSuggestionId,
      `Merge traversal entry ${index} intoSuggestionId`
    );
    if (fromSuggestionId === intoSuggestionId) {
      throw new Error(`Merge traversal entry ${index} cannot merge a suggestion into itself`);
    }
    if (fromTo.has(fromSuggestionId)) {
      throw new Error(`Merge traversal has duplicate source "${fromSuggestionId}"`);
    }
    fromTo.set(fromSuggestionId, intoSuggestionId);
    mergeByFrom.set(fromSuggestionId, merge);
  }

  if (fromTo.has(targetSuggestionId)) {
    throw new Error(`Merge traversal target "${targetSuggestionId}" must be terminal`);
  }

  const terminalByFrom = new Map();
  for (const start of fromTo.keys()) {
    let current = start;
    const path = new Set();
    while (fromTo.has(current)) {
      if (path.has(current)) {
        throw new Error(`Merge traversal contains a cycle at "${current}"`);
      }
      path.add(current);
      current = fromTo.get(current);
    }
    terminalByFrom.set(start, current);
  }

  const includedFromIds = [...fromTo.keys()].filter(
    (fromSuggestionId) => terminalByFrom.get(fromSuggestionId) === targetSuggestionId
  );
  const includedFromSet = new Set(includedFromIds);
  const includedIntoSet = new Set(
    includedFromIds.map((fromSuggestionId) => fromTo.get(fromSuggestionId))
  );
  const roots = includedFromIds
    .filter((fromSuggestionId) => !includedIntoSet.has(fromSuggestionId))
    .sort((left, right) => left.localeCompare(right));

  const emitted = new Set();
  const steps = [];
  for (const root of roots) {
    let current = root;
    while (current !== targetSuggestionId && includedFromSet.has(current)) {
      if (emitted.has(current)) break;
      emitted.add(current);
      steps.push({
        fromSuggestionId: current,
        intoSuggestionId: fromTo.get(current),
        merge: mergeByFrom.get(current)
      });
      current = fromTo.get(current);
    }
  }

  if (emitted.size !== includedFromIds.length) {
    throw new Error('Merge traversal could not reach every included merge from an exact root');
  }

  return { targetSuggestionId, steps };
}

function normalizeLabelForCompare(value) {
  return toCleanString(value).toLowerCase().replace(/\s+/g, ' ');
}

function compareCodeUnitText(left, right) {
  const a = toCleanString(left);
  const b = toCleanString(right);
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function exceedsCodePointLimit(value, maximum) {
  if (value.length <= maximum) return false;
  if (value.length > maximum * 2) return true;
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > maximum) return true;
  }
  return false;
}

function markerGeneKey(value) {
  return value.toLocaleUpperCase('en-US');
}

function requireMarkerGene(value, label) {
  const gene = toCleanString(value);
  if (!gene) {
    throw new Error(`${label} must be nonblank`);
  }
  if (exceedsCodePointLimit(gene, 64)) {
    throw new Error(`${label} must be at most 64 Unicode characters`);
  }
  return gene;
}

export function parseMarkerGenesInput(text) {
  const raw = toCleanString(text);
  if (!raw) return null;
  const parts = raw.split(',').map((s) => toCleanString(s));
  if (parts.some((part) => !part)) {
    throw new Error('Marker genes cannot contain an empty comma-separated entry');
  }
  const seen = new Set();
  const out = [];
  for (let index = 0; index < parts.length; index++) {
    const gene = requireMarkerGene(parts[index], `Marker gene ${index + 1}`);
    const key = markerGeneKey(gene);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(gene);
    if (out.length > 50) {
      throw new Error('Marker genes must contain at most 50 unique entries');
    }
  }
  return out.length ? out : null;
}

function markerEntryGene(marker, index) {
  if (typeof marker === 'string') {
    return requireMarkerGene(marker, `Marker ${index + 1}`);
  }
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
    throw new TypeError(`Marker ${index + 1} must be a string or marker object`);
  }
  return requireMarkerGene(marker.gene, `Marker ${index + 1} gene`);
}

function markersToGeneList(markers) {
  if (markers === null || markers === undefined) return [];
  if (!Array.isArray(markers)) {
    throw new TypeError('Suggestion markers must be an array or null');
  }
  if (markers.length > 50) {
    throw new Error('Suggestion markers must contain at most 50 entries');
  }
  const list = Array.isArray(markers) ? markers : [];
  const out = [];
  const seen = new Set();
  for (let index = 0; index < list.length; index++) {
    const gene = markerEntryGene(list[index], index);
    const key = markerGeneKey(gene);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(gene);
  }
  return out;
}

export function mergeCapMarkerGenes(existingInput, capMarkerGenes) {
  if (!Array.isArray(capMarkerGenes)) {
    throw new TypeError('CAP marker genes must be an array');
  }
  const genes = parseMarkerGenesInput(existingInput) ?? [];
  const seen = new Set(genes.map(markerGeneKey));
  const addedGenes = [];
  const duplicateGenes = [];
  const omittedGenes = [];
  for (let index = 0; index < capMarkerGenes.length; index++) {
    const gene = requireMarkerGene(
      capMarkerGenes[index],
      `CAP marker gene ${index + 1}`
    );
    const key = markerGeneKey(gene);
    if (seen.has(key)) {
      duplicateGenes.push(gene);
      continue;
    }
    seen.add(key);
    if (genes.length < 50) {
      genes.push(gene);
      addedGenes.push(gene);
    } else {
      omittedGenes.push(gene);
    }
  }
  return {
    text: genes.length ? genes.join(', ') : '',
    genes,
    addedGenes,
    duplicateGenes,
    omittedGenes
  };
}

function markerHasStats(marker) {
  return Boolean(
    marker &&
    typeof marker === 'object' &&
    !Array.isArray(marker) &&
    (Object.hasOwn(marker, 'logFC') || Object.hasOwn(marker, 'pval'))
  );
}

export function reconcileEditedMarkerChange(originalMarkers, nextGenes) {
  const original = Array.isArray(originalMarkers) ? originalMarkers : [];
  const byGene = new Map();
  for (let index = 0; index < original.length; index++) {
    const marker = original[index];
    const gene = markerEntryGene(marker, index);
    const key = markerGeneKey(gene);
    if (!byGene.has(key)) byGene.set(key, []);
    byGene.get(key).push({ marker, gene, index });
  }
  const markers = [];
  for (const gene of nextGenes ?? []) {
    const pool = byGene.get(markerGeneKey(gene)) ?? [];
    const preferredIndex = pool.findIndex((entry) => (
      markerHasStats(entry.marker)
    ));
    const selectedIndex = preferredIndex >= 0 ? preferredIndex : 0;
    const selected = pool.length ? pool.splice(selectedIndex, 1)[0] : null;
    markers.push(selected?.marker ?? gene);
  }
  const lostStats = [];
  for (const pool of byGene.values()) {
    for (const entry of pool) {
      if (markerHasStats(entry.marker)) lostStats.push(entry.gene);
    }
  }
  return { markers, lostStats };
}

function formatLostMarkerStats(genes) {
  const counts = new Map();
  for (const gene of genes) {
    counts.set(gene, (counts.get(gene) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([gene, count]) => count === 1 ? gene : `${gene} (${count} entries)`)
    .join(', ');
}

function markersToInputText(markers) {
  const genes = markersToGeneList(markers);
  return genes.length ? genes.join(', ') : '';
}

function formatRelativeTime(isoString) {
  if (isoString === null || isoString === undefined || isoString === '') return '';
  if (
    typeof isoString !== 'string' ||
    isoString !== isoString.trim()
  ) {
    throw new TypeError('Comment timestamp must be an exact string');
  }
  const date = new Date(isoString);
  const timestamp = date.getTime();
  if (!Number.isFinite(timestamp)) {
    throw new RangeError('Comment timestamp must be a valid date');
  }
  const diffMs = Date.now() - timestamp;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHrs = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHrs / 24);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHrs < 24) return `${diffHrs}h ago`;
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function listFocusableElements(root) {
  const container = root;
  if (!container || typeof container.querySelectorAll !== 'function') {
    throw new TypeError('Modal focus root must expose querySelectorAll()');
  }
  const selectors = [
    'a[href]',
    'area[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');
  const nodes = Array.from(container.querySelectorAll(selectors));
  return nodes.filter((node) => {
    if (!(node instanceof HTMLElement)) return false;
    if (typeof window.getComputedStyle !== 'function') {
      throw new TypeError('Modal focus management requires getComputedStyle()');
    }
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return node.getClientRects().length > 0;
  });
}

const MODAL_FOCUS_KEY_ATTRIBUTE = 'data-community-modal-focus-key';
const MODAL_FOCUS_RESTORE_ATTRIBUTE =
  'data-community-modal-focus-restore-key';

function createModalFocusKey(...parts) {
  return JSON.stringify(parts.map(part => String(part ?? '')));
}

function ownModalFocusKey(element, key, { restoreKey = null } = {}) {
  if (!(element instanceof HTMLElement)) {
    throw new TypeError('Modal focus identity owner must be an element');
  }
  if (typeof key !== 'string' || !key) {
    throw new TypeError('Modal focus identity must be a non-empty string');
  }
  element.setAttribute(MODAL_FOCUS_KEY_ATTRIBUTE, key);
  if (restoreKey !== null) {
    if (typeof restoreKey !== 'string' || !restoreKey) {
      throw new TypeError(
        'Modal focus restoration identity must be a non-empty string or null'
      );
    }
    element.setAttribute(MODAL_FOCUS_RESTORE_ATTRIBUTE, restoreKey);
  }
  return element;
}

function captureModalRerenderFocus(root) {
  const active = document.activeElement;
  if (
    !(active instanceof HTMLElement) ||
    !root.contains(active)
  ) {
    return null;
  }
  // An element's own identity comes first: an inline editor that the rebuild
  // reopens keeps focus in its own field. The restoration identity names
  // where focus goes when the rebuild no longer contains the element, such
  // as the Edit button of an editor that its own Save just closed.
  const ownKey = active.getAttribute(MODAL_FOCUS_KEY_ATTRIBUTE);
  const desiredKeys = [
    ownKey,
    active.getAttribute(MODAL_FOCUS_RESTORE_ATTRIBUTE)
  ].filter(key => key !== null);
  const isTextField =
    (active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement) &&
    typeof active.selectionStart === 'number';
  const attributes = {};
  for (const name of [
    'aria-label',
    'data-secondary-action',
    'data-suggestion-id',
    'name',
    'placeholder',
    'type'
  ]) {
    const value = active.getAttribute(name);
    if (value !== null) attributes[name] = value;
  }
  return {
    ownKey,
    desiredKeys,
    tagName: active.tagName,
    attributes,
    text:
      active instanceof HTMLButtonElement
        ? toCleanString(active.textContent)
        : '',
    selection: isTextField
      ? {
          start: active.selectionStart,
          end: active.selectionEnd,
          direction: active.selectionDirection ?? 'none'
        }
      : null
  };
}

const MODAL_DRAFT_ATTRIBUTE = 'data-community-modal-draft';

/**
 * Mark a compose field (new suggestion, new comment) whose unsent text must
 * survive content rebuilds. The field must already own a focus identity.
 *
 * @param {HTMLInputElement|HTMLTextAreaElement} field
 * @returns {HTMLInputElement|HTMLTextAreaElement}
 */
function ownModalDraft(field) {
  if (
    !(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) ||
    !field.hasAttribute(MODAL_FOCUS_KEY_ATTRIBUTE)
  ) {
    throw new TypeError('Modal drafts require a keyed text field');
  }
  field.setAttribute(MODAL_DRAFT_ATTRIBUTE, 'true');
  return field;
}

/**
 * Record what the viewer has typed into every compose field under `root`.
 *
 * Session changes (a Pull, another tab, the viewer's own vote) rebuild the
 * voting content from scratch. Drafts live in `drafts` across those rebuilds,
 * keyed by the same stable identity focus restoration uses, so an unsent
 * suggestion or comment is never wiped by a re-render. A field emptied by its
 * own Add, Send, or Clear action drops its draft here.
 *
 * @param {ParentNode} root
 * @param {Map<string, string>} drafts
 */
function captureModalDrafts(root, drafts) {
  for (const field of root.querySelectorAll(`[${MODAL_DRAFT_ATTRIBUTE}]`)) {
    const key = field.getAttribute(MODAL_FOCUS_KEY_ATTRIBUTE);
    if (field.value) drafts.set(key, field.value);
    else drafts.delete(key);
  }
}

/**
 * Put recorded drafts back into the rebuilt fields with the same identity and
 * let each field's own `input` handler refresh its counter, size, and search
 * state.
 *
 * @param {ParentNode} root
 * @param {Map<string, string>} drafts
 */
function restoreModalDrafts(root, drafts) {
  if (drafts.size === 0) return;
  for (const field of root.querySelectorAll(`[${MODAL_DRAFT_ATTRIBUTE}]`)) {
    const value = drafts.get(field.getAttribute(MODAL_FOCUS_KEY_ATTRIBUTE));
    if (value === undefined || field.disabled || field.value === value) continue;
    field.value = value;
    field.dispatchEvent(new Event('input'));
  }
}

/**
 * The inline editors of existing items (a comment, a suggestion, a merge
 * note) that are open in one voting shell, kept outside the DOM so a content
 * rebuild can reopen each of them.
 *
 * Session changes (another user's vote arriving through a Pull, another tab,
 * the viewer's own vote on a different card) rebuild voting content from
 * scratch. Every editor records its identity, the item it belongs to, and
 * what the viewer has typed here as they type. A renderer that rebuilds an
 * item whose edit is open calls `resume()` and builds that editor open again
 * with the recorded text; the rerender focus snapshot then puts focus and the
 * caret back into the same field.
 *
 * Rebuilds are bracketed by `beginRebuild()` and `finishRebuild()` (nested
 * brackets count as one). An edit that no renderer resumed during a finished
 * rebuild belongs to an item that is no longer shown: it was deleted, merged
 * into another bundle, voting closed for the viewer, or the viewer paged
 * away. Its editor cannot come back, so the edit is dropped and the viewer is
 * told that its text was not saved. Keeping that text as a new draft was
 * rejected: no compose field means the same thing as an edit of a deleted
 * comment or a merged-away suggestion, and refiling the text under another
 * item would be more surprising than a clear notice.
 *
 * Save runs its session mutation through `commit()`, which closes the edit
 * first: the mutation emits `changed` synchronously, and the rebuild it
 * triggers must not reopen an editor whose text is being committed. A save
 * that throws or reports failure leaves the edit open again.
 */
class InlineEditState {
  constructor() {
    /** @type {Map<string, {anchorId: string, noun: string, values: Record<string, string>}>} */
    this._edits = new Map();
    /** @type {Set<string> | null} */
    this._resumed = null;
    this._rebuildDepth = 0;
  }

  /**
   * @param {string} key  the editor's Edit-button focus identity
   * @param {{anchorId: string, noun: string, values: Record<string, string>}} edit
   *   `anchorId` names the listed item (suggestion or comment id) a paged list
   *   keeps on screen while the edit is open; `noun` names the item for the
   *   viewer.
   */
  open(key, { anchorId, noun, values }) {
    if (typeof key !== 'string' || !key) {
      throw new TypeError('Inline edit identity must be a non-empty string');
    }
    if (typeof noun !== 'string' || !noun) {
      throw new TypeError('Inline edit noun must be a non-empty string');
    }
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new TypeError('Inline edit values must be an object');
    }
    this._edits.set(key, {
      anchorId: toCleanString(anchorId),
      noun,
      values: { ...values }
    });
    this._resumed?.add(key);
  }

  /** Record the current text of one field of an open edit. */
  set(key, field, value) {
    const edit = this._edits.get(key);
    if (edit !== undefined) edit.values[field] = String(value);
  }

  close(key) {
    this._edits.delete(key);
  }

  /**
   * Run the save mutation of an open edit with that edit closed.
   *
   * @template T
   * @param {string} key
   * @param {() => T} mutate
   * @returns {T}
   */
  commit(key, mutate) {
    const edit = this._edits.get(key);
    this._edits.delete(key);
    const reopen = () => {
      if (edit !== undefined) this._edits.set(key, edit);
    };
    let result;
    try {
      result = mutate();
    } catch (error) {
      reopen();
      throw error;
    }
    if (!result) reopen();
    return result;
  }

  has(key) {
    return this._edits.has(key);
  }

  /**
   * Claim an open edit for the current rebuild.
   *
   * @returns {Record<string, string> | null} the recorded field text, or null
   *   when this editor is not open
   */
  resume(key) {
    const edit = this._edits.get(key);
    if (edit === undefined) return null;
    this._resumed?.add(key);
    return { ...edit.values };
  }

  /** @returns {Set<string>} the items that have an open edit */
  anchorIds() {
    return new Set(
      [...this._edits.values()].map(edit => edit.anchorId).filter(Boolean)
    );
  }

  beginRebuild() {
    if (this._rebuildDepth === 0) this._resumed = new Set();
    this._rebuildDepth += 1;
  }

  /** End a rebuild that was abandoned or failed, leaving every edit open. */
  cancelRebuild() {
    this._endRebuild();
  }

  /** End a rebuild that is now on screen and drop the edits it did not resume. */
  finishRebuild() {
    const resumed = this._resumed;
    if (!this._endRebuild()) return;
    for (const [key, edit] of [...this._edits]) {
      if (resumed.has(key)) continue;
      this._edits.delete(key);
      getNotificationCenter().warning(
        `Edit not saved: the ${edit.noun} you were editing is no longer ` +
        'shown here (deleted, merged, closed, or on another page).',
        { category: 'annotation' }
      );
    }
  }

  /** Run `build` as one rebuild. */
  rebuild(build) {
    this.beginRebuild();
    let result;
    try {
      result = build();
    } catch (error) {
      this.cancelRebuild();
      throw error;
    }
    this.finishRebuild();
    return result;
  }

  _endRebuild() {
    if (this._rebuildDepth === 0) {
      throw new Error('Inline edit rebuild ended without beginning');
    }
    this._rebuildDepth -= 1;
    if (this._rebuildDepth !== 0) return false;
    this._resumed = null;
    return true;
  }
}

function requireInlineEditState(inlineEdits, owner) {
  if (!(inlineEdits instanceof InlineEditState)) {
    throw new TypeError(`${owner} requires the shell's inline edit state`);
  }
  return inlineEdits;
}

function isRenderedModalFocusTarget(target) {
  if (!isAvailableModalFocusTarget(target)) return false;
  if (
    typeof target.matches === 'function' &&
    target.matches(':disabled')
  ) {
    return false;
  }
  if (
    typeof target.closest === 'function' &&
    target.closest('[inert], [aria-hidden="true"]') !== null
  ) {
    return false;
  }
  if (typeof window.getComputedStyle !== 'function') {
    throw new TypeError(
      'Modal rerender focus restoration requires getComputedStyle()'
    );
  }
  const style = window.getComputedStyle(target);
  return (
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    target.getClientRects().length > 0
  );
}

function focusRenderedModalTarget(target) {
  if (!isRenderedModalFocusTarget(target)) return false;
  target.focus({ preventScroll: true });
  return document.activeElement === target;
}

function restoreModalRerenderFocus(snapshot, root, closeTarget) {
  if (snapshot === null) return false;
  const focusables = listFocusableElements(root);
  let target = null;
  for (const key of snapshot.desiredKeys) {
    target = focusables.find(
      candidate => candidate.getAttribute(MODAL_FOCUS_KEY_ATTRIBUTE) === key
    ) ?? null;
    if (target !== null) break;
  }
  if (target === null) {
    const semanticMatches = focusables.filter(candidate => {
      if (candidate.tagName !== snapshot.tagName) return false;
      for (const [name, value] of Object.entries(snapshot.attributes)) {
        if (candidate.getAttribute(name) !== value) return false;
      }
      return (
        snapshot.text === '' ||
        toCleanString(candidate.textContent) === snapshot.text
      );
    });
    if (semanticMatches.length === 1) target = semanticMatches[0];
  }
  if (target !== null && focusRenderedModalTarget(target)) {
    restoreModalTextSelection(snapshot, target);
    return true;
  }
  if (focusRenderedModalTarget(closeTarget)) return true;
  throw new Error(
    'Modal rerender could not restore focus to its stable close control'
  );
}

/**
 * Put the caret or selection back into the rebuilt copy of the text field the
 * viewer was typing in. Only the same field identity qualifies, and only while
 * the recorded range still fits its restored text.
 */
function restoreModalTextSelection(snapshot, target) {
  const { selection } = snapshot;
  if (
    selection === null ||
    snapshot.ownKey === null ||
    target.getAttribute(MODAL_FOCUS_KEY_ATTRIBUTE) !== snapshot.ownKey ||
    !(
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement
    ) ||
    typeof target.selectionStart !== 'number' ||
    selection.end > target.value.length
  ) {
    return;
  }
  target.setSelectionRange(
    selection.start,
    selection.end,
    selection.direction
  );
}

function focusEnabledPaginationControl(preferred, alternate) {
  for (const target of [preferred, alternate]) {
    if (focusRenderedModalTarget(target)) return target;
  }
  throw new Error(
    'Modal pagination could not focus either enabled navigation control'
  );
}

/**
 * Inline editors mark their cancellable region with `data-esc-cancel="true"`
 * and handle Escape themselves; every voting shell's trap leaves Escape from
 * inside such a region to the editor instead of closing the dialog.
 */
const ESC_CANCEL_SELECTOR = '[data-esc-cancel="true"]';

function trapModalFocus({ overlay, modal, close } = {}) {
  const o = overlay;
  const m = modal;
  if (
    !o ||
    typeof o.addEventListener !== 'function' ||
    typeof o.removeEventListener !== 'function'
  ) {
    throw new TypeError('Modal overlay must expose exact event listener methods');
  }
  if (!m || typeof m.contains !== 'function') {
    throw new TypeError('Modal focus container must expose contains()');
  }
  if (typeof close !== 'function') {
    throw new TypeError('Modal focus trap requires a close callback');
  }

  const onKeyDown = (e) => {
    if (!e || typeof e.preventDefault !== 'function' || typeof e.stopPropagation !== 'function') {
      throw new TypeError('Modal focus trap requires exact keyboard event methods');
    }
    if (e.key === 'Escape') {
      const target = e.target;
      if (target && typeof target.closest === 'function' && target.closest(ESC_CANCEL_SELECTOR)) return;
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }

    if (e.key !== 'Tab') return;

    const focusables = listFocusableElements(m);
    if (!focusables.length) {
      e.preventDefault();
      return;
    }

    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    const containsActive = active && m.contains(active);

    if (e.shiftKey) {
      if (!containsActive || active === first) {
        if (typeof last.focus !== 'function') {
          throw new TypeError('Modal focus target must expose focus()');
        }
        e.preventDefault();
        last.focus();
      }
      return;
    }

    if (!containsActive || active === last) {
      if (typeof first.focus !== 'function') {
        throw new TypeError('Modal focus target must expose focus()');
      }
      e.preventDefault();
      first.focus();
    }
  };

  o.addEventListener('keydown', onKeyDown, true);
  return () => o.removeEventListener('keydown', onKeyDown, true);
}

// =============================================================================
// CAP Integration UI Components
// =============================================================================

/**
 * Render CAP search results dropdown
 */
function renderCapSearchResults({
  results,
  omittedInvalidCount,
  onSelect,
  onClose,
  returnFocusTo
}) {
  if (!Array.isArray(results)) {
    throw new TypeError('CAP result rendering requires an exact results array');
  }
  if (
    !Number.isSafeInteger(omittedInvalidCount) ||
    omittedInvalidCount < 0
  ) {
    throw new TypeError(
      'CAP result rendering requires a nonnegative omitted-invalid count'
    );
  }
  const container = el('div', {
    className: 'cap-search-results',
    role: 'region',
    'aria-label': 'CAP search results',
    'aria-live': 'polite'
  });

  if (omittedInvalidCount > 0) {
    container.appendChild(el('div', {
      className: 'cap-search-warning',
      role: 'status',
      text:
        `CAP omitted ${omittedInvalidCount} invalid upstream ` +
        `result${omittedInvalidCount === 1 ? '' : 's'}.`
    }));
  }

  if (!results.length) {
    container.appendChild(el('p', { className: 'empty-state', text: 'No results found in the CAP database.' }));
  } else {
    const list = el('ul', { className: 'cap-search-result-list' });
    for (const result of results) {
      const listItem = el('li', { className: 'cap-search-result-list-item' });
      const item = el('button', {
        type: 'button',
        className: 'cap-search-item'
      });

      const displayName = toCleanString(result.fullName) || toCleanString(result.ontologyTerm) || toCleanString(result.name);
      const nameRow = el('div', { className: 'cap-search-item-name' });
      nameRow.appendChild(el('span', { text: displayName || '—' }));
      if (result.ontologyTermId) {
        nameRow.appendChild(el('span', { className: 'cap-ontology-id', text: result.ontologyTermId }));
      }
      item.appendChild(nameRow);

      if (result.synonyms?.length) {
        item.appendChild(el('div', { className: 'cap-search-item-synonyms', text: `Synonyms: ${result.synonyms.join(', ')}` }));
      }

      const combinedMarkers = [];
      const markerKeys = new Set();
      for (const gene of [
        ...(result.canonicalMarkerGenes ?? []),
        ...(result.markerGenes ?? [])
      ]) {
        const key = markerGeneKey(gene);
        if (markerKeys.has(key)) continue;
        markerKeys.add(key);
        combinedMarkers.push(gene);
      }
      if (combinedMarkers.length) {
        item.appendChild(el('div', {
          className: 'cap-search-item-markers',
          text:
            `Markers: ${combinedMarkers.join(', ')}`
        }));
      }

      item.setAttribute(
        'aria-label',
        `Use CAP result ${displayName || result.id || 'unnamed result'}`
      );
      item.addEventListener('click', () => {
        try {
          onSelect?.(result);
          onClose?.();
          if (
            returnFocusTo instanceof HTMLElement &&
            returnFocusTo.isConnected &&
            typeof returnFocusTo.focus === 'function'
          ) {
            returnFocusTo.focus();
          }
        } catch (error) {
          getNotificationCenter().error(describeErrorMessage(error), {
            category: 'annotation'
          });
        }
      });

      listItem.appendChild(item);
      list.appendChild(listItem);
    }
    container.appendChild(list);
  }

  const closeBtn = el('button', { type: 'button', className: 'btn cap-search-close', text: 'Close' });
  closeBtn.addEventListener('click', () => {
    onClose?.();
    if (
      returnFocusTo instanceof HTMLElement &&
      returnFocusTo.isConnected &&
      typeof returnFocusTo.focus === 'function'
    ) {
      returnFocusTo.focus();
    }
  });
  container.appendChild(closeBtn);

  return container;
}

function truncateText(text, maxLen) {
  const s = toCleanString(text);
  if (!s) return '';
  const max = Number.isFinite(maxLen) ? Math.max(0, Math.floor(maxLen)) : 160;
  if (s.length <= max) return s;
  return `${s.slice(0, max).trim()}…`;
}

function autoSizeTextarea(textarea, { minHeightPx = null, maxHeightPx = null } = {}) {
  const element = textarea;
  if (!element || !element.style) {
    throw new TypeError('Textarea autosizing requires an exact rendered textarea');
  }
  element.style.height = 'auto';
  const scrollHeight = element.scrollHeight;
  if (!Number.isFinite(scrollHeight)) {
    throw new TypeError('Textarea autosizing requires a finite scrollHeight');
  }
  const next = Math.max(minHeightPx ?? 0, scrollHeight);
  const capped = maxHeightPx != null ? Math.min(next, maxHeightPx) : next;
  element.style.height = `${capped}px`;
  element.style.overflowY = maxHeightPx != null && next > maxHeightPx ? 'auto' : 'hidden';
}

function renderComment({
  session,
  fieldKey,
  catIdx,
  suggestionId,
  comment,
  inlineEdits,
  lifecycle = null,
  canInteract = true,
  onUpdate
}) {
  requireInlineEditState(inlineEdits, 'Comment rendering');
  const isCurrent = () => (
    lifecycle === null ||
    (
      !lifecycle.signal?.aborted &&
      typeof lifecycle.isCurrent === 'function' &&
      lifecycle.isCurrent()
    )
  );
  const isOwn = session.isMyComment(comment?.authorUsername);
  const commentEl = el('div', { className: `community-annotation-comment${isOwn ? ' is-own' : ''}` });
  const commentFocusPrefix = createModalFocusKey(
    'comment',
    fieldKey,
    catIdx,
    suggestionId,
    comment?.id
  );

  const header = el('div', { className: 'community-annotation-comment-header' });
  const author = el('span', { className: 'community-annotation-comment-author', text: formatCommentAuthorHandle(session, comment?.authorUsername || '') });
  const time = el('span', { className: 'community-annotation-comment-time' });
  const edited = comment?.editedAt ? ' (edited)' : '';
  time.textContent = formatRelativeTime(comment?.editedAt || comment?.createdAt) + edited;
  header.appendChild(author);
  header.appendChild(time);
  commentEl.appendChild(header);

  const textEl = el('div', { className: 'community-annotation-comment-text', text: comment?.text || '' });
  commentEl.appendChild(textEl);

  if (isOwn && canInteract) {
    const actions = el('div', { className: 'community-annotation-comment-actions' });
    const editBtn = el('button', { type: 'button', className: 'community-annotation-comment-action-btn', text: 'Edit' });
    const deleteBtn = el('button', { type: 'button', className: 'community-annotation-comment-action-btn', text: 'Delete' });
    const editFocusKey = `${commentFocusPrefix}:edit`;
    ownModalFocusKey(editBtn, editFocusKey);
    ownModalFocusKey(deleteBtn, `${commentFocusPrefix}:delete`);

    const openEditor = (text) => {
      const form = el('div', { className: 'community-annotation-comment-form' });
      const input = el('textarea', {
        className: 'obs-select community-annotation-textarea',
        'aria-label': 'Edit comment',
        placeholder: 'Edit comment…',
        maxlength: '500'
      });
      ownModalFocusKey(input, `${commentFocusPrefix}:edit-input`, {
        restoreKey: editFocusKey
      });
      input.value = text;

      const charCounter = el('div', { className: 'community-annotation-char-counter', text: `${input.value.length}/500` });
      input.addEventListener('input', () => {
        charCounter.textContent = `${input.value.length}/500`;
        inlineEdits.set(editFocusKey, 'text', input.value);
      });

      const formActions = el('div', { className: 'community-annotation-comment-form-actions' });
      const saveBtn = el('button', { type: 'button', className: 'btn', text: 'Save' });
      const cancelBtn = el('button', { type: 'button', className: 'btn', text: 'Cancel' });
      ownModalFocusKey(saveBtn, `${commentFocusPrefix}:save`, {
        restoreKey: editFocusKey
      });
      ownModalFocusKey(cancelBtn, `${commentFocusPrefix}:cancel`, {
        restoreKey: editFocusKey
      });

      saveBtn.addEventListener('click', () => {
        if (!isCurrent()) return;
        const newText = input.value.trim();
        if (!newText) return;
        focusRenderedModalTarget(saveBtn);
        const ok = inlineEdits.commit(
          editFocusKey,
          () => session.editComment(fieldKey, catIdx, suggestionId, comment.id, newText)
        );
        if (ok) {
          getNotificationCenter().success('Comment updated', { category: 'annotation', duration: 1500 });
          onUpdate?.();
        } else {
          getNotificationCenter().error('Failed to update comment', { category: 'annotation' });
        }
      });

      cancelBtn.addEventListener('click', () => {
        inlineEdits.close(editFocusKey);
        onUpdate?.();
      });

      formActions.appendChild(saveBtn);
      formActions.appendChild(cancelBtn);
      form.appendChild(input);
      form.appendChild(charCounter);
      form.appendChild(formActions);

      commentEl.innerHTML = '';
      commentEl.appendChild(form);
      return input;
    };

    editBtn.addEventListener('click', () => {
      const text = comment?.text || '';
      inlineEdits.open(editFocusKey, {
        anchorId: comment?.id,
        noun: 'comment',
        values: { text }
      });
      openEditor(text).focus();
    });

    deleteBtn.addEventListener('click', () => {
      showOwnedConfirmDialog(lifecycle, {
        title: 'Delete comment?',
        message: 'This will remove your comment. This action cannot be undone.',
        confirmText: 'Delete',
        returnFocusTo: deleteBtn,
        onConfirm: () => {
          if (!isCurrent()) return;
          const ok = session.deleteComment(fieldKey, catIdx, suggestionId, comment.id);
          if (ok) {
            getNotificationCenter().success('Comment deleted', { category: 'annotation', duration: 1500 });
            onUpdate?.();
          } else {
            getNotificationCenter().error('Failed to delete comment', { category: 'annotation' });
          }
        }
      });
    });

    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);
    commentEl.appendChild(actions);

    const resumed = inlineEdits.resume(editFocusKey);
    if (resumed !== null) openEditor(resumed.text);
  }

  return commentEl;
}

/** @type {{close: Function} | null} */
let activeVotingModal = null;

/**
 * The voting modal's own shell.
 *
 * This is deliberately separate from `community-annotation/modal-shell.js`
 * rather than duplicated by accident. That module carries the full rationale;
 * the short form is that the two shells have different close orderings
 * (`onClose` retires this shell's render lifecycle *before* the focus trap and
 * the overlay removal), different nested-Escape protocols (the `data-esc-cancel`
 * marker here, `COMMUNITY_MODAL_ESCAPE_OWNER` there), and only this one owns the
 * primary/secondary voting modal cascade.
 *
 * The accessibility contract they *do* share — `role="dialog"`, `aria-modal`,
 * a generated `aria-labelledby`, focus into the dialog on open, focus restored
 * on close, Escape, and Tab wrapping both directions — is pinned by
 * `tests/community-annotation-modal-shell-parity-contract.test.mjs`. Changing
 * any of it here without the same change there fails that test.
 */
function showModal({
  title,
  buildContent,
  onClose = null,
  returnFocusTo = null,
  returnFocusResolver = null
}) {
  if (typeof buildContent !== 'function') {
    throw new TypeError('Community annotation modal requires a content builder');
  }
  if (onClose !== null && typeof onClose !== 'function') {
    throw new TypeError(
      'Community annotation modal onClose must be a function or exact null'
    );
  }
  if (
    returnFocusTo !== null
    && !(returnFocusTo instanceof HTMLElement)
  ) {
    throw new TypeError(
      'Community annotation voting return focus target must be an element or null'
    );
  }
  if (
    returnFocusResolver !== null
    && typeof returnFocusResolver !== 'function'
  ) {
    throw new TypeError(
      'Community annotation voting focus resolver must be a function or null'
    );
  }

  const overlay = el('div', { className: 'community-annotation-modal-overlay', role: 'dialog', 'aria-modal': 'true' });
  const modal = el('div', { className: 'community-annotation-modal', role: 'document' });

  const header = el('div', { className: 'community-annotation-modal-header' });
  const titleEl = el('div', { className: 'community-annotation-modal-title', text: title || 'Community voting' });
  const titleId = createDomId('community-annotation-voting-title');
  titleEl.id = titleId;
  overlay.setAttribute('aria-labelledby', titleId);
  header.appendChild(titleEl);
  const closeBtn = el('button', { type: 'button', className: 'btn community-annotation-modal-close', text: 'Close' });
  header.appendChild(closeBtn);

  const content = el('div', { className: 'community-annotation-modal-body' });
  modal.appendChild(header);
  modal.appendChild(content);
  overlay.appendChild(modal);

  const prevFocus = returnFocusTo ?? document.activeElement;
  let closed = false;
  let closing = false;
  let cleanupTrap = null;
  let releaseOwner = null;
  let releaseDocumentLayer = null;
  const releaseDocumentOwnership = () => {
    if (releaseDocumentLayer === null) return;
    const exactRelease = releaseDocumentLayer;
    releaseExactModalDocumentLayer(
      exactRelease,
      'Community annotation voting modal'
    );
    if (releaseDocumentLayer === exactRelease) {
      releaseDocumentLayer = null;
    }
  };
  const close = () => {
    if (closed || closing) return;
    closing = true;
    try {
      runExactCleanup('Community annotation voting modal teardown', [
        [
          'secondary modal',
          activeSecondaryModal === null
            ? null
            : () => {
                if (typeof activeSecondaryModal.close !== 'function') {
                  throw new TypeError(
                    'Active secondary modal must expose close()'
                  );
                }
                activeSecondaryModal.close();
              }
        ],
        ['owned modal lifecycle', onClose],
        ['focus trap', cleanupTrap],
        ['modal overlay', () => overlay.remove()],
        ['modal document layer', releaseDocumentOwnership],
        [
          'previous focus target',
          prevFocus === null && returnFocusResolver === null
            ? null
            : () => {
                const previousFocusAvailable =
                  prevFocus instanceof HTMLElement
                  && prevFocus.isConnected
                  && !(
                    prevFocus instanceof HTMLButtonElement
                    && prevFocus.disabled
                  );
                const target = previousFocusAvailable
                  ? prevFocus
                  : returnFocusResolver?.() ?? null;
                if (target === null) return;
                if (
                  !(target instanceof HTMLElement)
                  || !target.isConnected
                  || typeof target.focus !== 'function'
                ) {
                  throw new TypeError(
                    'Previous community annotation voting focus target must expose focus()'
                  );
                }
                target.focus();
              }
        ]
      ]);
      if (
        typeof releaseOwner !== 'function' ||
        releaseOwner() !== true
      ) {
        throw new Error(
          'Community annotation voting modal lost its exact shared owner'
        );
      }
      releaseOwner = null;
      closed = true;
      if (activeVotingModal?.close === close) {
        activeVotingModal = null;
      }
    } finally {
      closing = false;
    }
  };
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  let contentBuilt = false;
  let ownerClaimed = false;
  try {
    buildContent(content);
    contentBuilt = true;
    releaseOwner = claimCommunityAnnotationModal(close);
    ownerClaimed = true;
    releaseDocumentLayer = claimModalDocumentLayer(overlay);
    document.body.appendChild(overlay);
    cleanupTrap = trapModalFocus({ overlay, modal, close });
    const modalReference = { close, overlay, modal, content };
    activeVotingModal = modalReference;
    closeBtn.focus();
    return modalReference;
  } catch (error) {
    const errors = [error];
    try {
      if (ownerClaimed) {
        close();
      } else if (contentBuilt || onClose !== null) {
        onClose?.();
      }
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
    if (errors.length === 1) throw error;
    throw new AggregateError(
      errors,
      'Community annotation voting modal creation and rollback failed'
    );
  }
}

/** @type {{close?: Function} | null} */
let activeSecondaryModal = null;

function lifecycleIsCurrent(lifecycle) {
  if (lifecycle === null || lifecycle === undefined) return true;
  return (
    !lifecycle.signal?.aborted &&
    typeof lifecycle.isCurrent === 'function' &&
    lifecycle.isCurrent()
  );
}

function showOwnedConfirmDialog(lifecycle, options) {
  if (!lifecycleIsCurrent(lifecycle)) return null;
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Owned confirmation options must be an object');
  }
  const {
    returnFocusTo = document.activeElement,
    ...dialogOptions
  } = options;
  if (
    returnFocusTo !== null &&
    !(returnFocusTo instanceof HTMLElement)
  ) {
    throw new TypeError(
      'Owned confirmation return focus target must be an element or exact null'
    );
  }
  let settled = false;
  let cancelHandle = null;
  const signal = lifecycle?.signal ?? null;
  const restoreReturnFocus = () => {
    if (
      lifecycleIsCurrent(lifecycle) &&
      isAvailableModalFocusTarget(returnFocusTo)
    ) {
      returnFocusTo.focus();
    }
  };
  const release = () => {
    if (settled) return false;
    settled = true;
    signal?.removeEventListener('abort', cancelForRetiredOwner);
    return true;
  };
  const cancelForRetiredOwner = () => {
    if (settled) return;
    if (cancelHandle !== null) {
      cancelHandle();
      return;
    }
    release();
  };
  if (signal !== null) {
    signal.addEventListener('abort', cancelForRetiredOwner, { once: true });
  }
  try {
    cancelHandle = showConfirmDialog({
      ...dialogOptions,
      onConfirm: (value) => {
        if (!release() || !lifecycleIsCurrent(lifecycle)) return;
        restoreReturnFocus();
        try {
          dialogOptions.onConfirm?.(value);
        } finally {
          restoreReturnFocus();
        }
      },
      onCancel: () => {
        if (!release()) return;
        try {
          dialogOptions.onCancel?.();
        } finally {
          restoreReturnFocus();
        }
      }
    });
  } catch (error) {
    release();
    throw error;
  }
  if (signal?.aborted) cancelForRetiredOwner();
  return cancelHandle;
}

/** @type {null | {fieldKey:string, catIdx:number, suggestionId:string}} */
let activeSuggestionMergeDrag = null;

function renderMergeRow({
  session,
  fieldKey,
  catIdx,
  merge,
  idToLabel,
  inlineEdits,
  lifecycle = null,
  canDetach
}) {
  requireInlineEditState(inlineEdits, 'Merge row rendering');
  const isCurrent = () => lifecycleIsCurrent(lifecycle);
  const fromId = toCleanString(merge?.fromSuggestionId);
  const intoId = toCleanString(merge?.intoSuggestionId);
  const fromLabel = idToLabel?.get(fromId) || fromId || '—';
  const intoLabel = idToLabel?.get(intoId) || intoId || '—';
  const byKey = toCleanString(merge?.by);
  const at = toCleanString(merge?.at);
  const editedAt = toCleanString(merge?.editedAt);
  const noteText = toCleanString(merge?.note);
  const isOwn = byKey ? session.isMyComment(byKey) : false;
  let currentNote = noteText;
  const buildMeta = () => [
    byKey ? session.formatUserAttribution(byKey) : null,
    (() => {
      const t = editedAt || at;
      if (!t) return null;
      const rel = formatRelativeTime(t) || t;
      return `${rel}${editedAt ? ' (edited)' : ''}`;
    })(),
    currentNote ? `“${currentNote}”` : null
  ].filter(Boolean).join(' • ');

  const row = el('div', { className: 'community-annotation-merge-row' });
  row.appendChild(el('div', { className: 'community-annotation-merge-desc', text: `${fromLabel} → ${intoLabel}` }));
  const metaEl = buildMeta() || (canDetach && isOwn)
    ? el('div', { className: 'community-annotation-merge-meta', text: buildMeta() || '' })
    : null;
  if (metaEl) row.appendChild(metaEl);

  if (canDetach && fromId) {
    const actions = el('div', { className: 'community-annotation-merge-actions' });
    const noteFocusPrefix = createModalFocusKey(
      'merge-note',
      fieldKey,
      catIdx,
      fromId
    );
    const editFocusKey = `${noteFocusPrefix}:edit`;
    /** @type {HTMLButtonElement | null} */
    let editBtn = null;

    const renderMetaDisplay = () => {
      if (!metaEl) return;
      metaEl.innerHTML = '';
      metaEl.textContent = buildMeta() || '';
      metaEl.dataset.mode = 'display';
      editBtn = null;

      if (isOwn) {
        editBtn = el('button', { type: 'button', className: 'community-annotation-comment-action-btn', text: 'Edit' });
        ownModalFocusKey(editBtn, editFocusKey);
        editBtn.addEventListener('click', () => {
          inlineEdits.open(editFocusKey, {
            anchorId: fromId,
            noun: 'merge note',
            values: { note: currentNote }
          });
          enterNoteEdit(currentNote).focus();
        });
        const deleteBtn = el('button', { type: 'button', className: 'community-annotation-comment-action-btn', text: 'Delete' });
        ownModalFocusKey(deleteBtn, `${noteFocusPrefix}:delete`);
        deleteBtn.hidden = !currentNote;
        deleteBtn.addEventListener('click', () => {
          showOwnedConfirmDialog(lifecycle, {
            title: 'Delete merge note?',
            message: 'This will remove the note text, but keep the merge.',
            confirmText: 'Delete',
            returnFocusTo: deleteBtn,
            onConfirm: () => {
              if (!isCurrent()) return;
              const ok = session.editModerationMergeNote?.({ fieldKey, catIdx, fromSuggestionId: fromId, note: null });
              if (ok) {
                currentNote = '';
                getNotificationCenter().success('Merge note deleted (local moderation)', { category: 'annotation', duration: 1800 });
                renderMetaDisplay();
              } else {
                getNotificationCenter().error('Unable to delete merge note', { category: 'annotation' });
              }
            }
          });
        });
        const links = el('span', { className: 'community-annotation-inline-action-links' }, [editBtn, deleteBtn]);
        metaEl.appendChild(links);
      }
    };

    const closeNoteEdit = () => {
      inlineEdits.close(editFocusKey);
      renderMetaDisplay();
      if (editBtn !== null) editBtn.focus({ preventScroll: true });
    };

    const enterNoteEdit = (note) => {
      metaEl.dataset.mode = 'edit';
      metaEl.innerHTML = '';
      const inputWrap = el('div', { className: 'community-annotation-comment-bar-wrap community-annotation-comment-bar-wrap--edit' });
      const input = el('textarea', {
        className: 'community-annotation-comment-bar community-annotation-comment-bar--edit',
        maxlength: '512',
        rows: '1',
        'aria-label': 'Merge note',
        placeholder: 'Merge note (optional)…',
        'data-esc-cancel': 'true',
        title: 'Enter to save • Esc to cancel'
      });
      ownModalFocusKey(input, `${noteFocusPrefix}:edit-input`, {
        restoreKey: editFocusKey
      });
      input.value = note;

      const charCounter = el('div', {
        className: 'community-annotation-char-counter community-annotation-char-counter--overlay',
        text: `${input.value.length}/512`
      });

      const resize = () => {
        const cs = getComputedStyle(input);
        const minHeight = Number.parseFloat(cs.minHeight || '') || null;
        const maxHeight = Number.parseFloat(cs.maxHeight || '') || null;
        autoSizeTextarea(input, { minHeightPx: minHeight, maxHeightPx: maxHeight });
      };

      const save = () => {
        if (!isCurrent()) return;
        const nextNote = toCleanString(input.value) || null;
        const ok = inlineEdits.commit(
          editFocusKey,
          () => session.editModerationMergeNote?.({ fieldKey, catIdx, fromSuggestionId: fromId, note: nextNote })
        );
        if (ok) {
          currentNote = toCleanString(nextNote || '');
          getNotificationCenter().success('Merge note updated (local moderation)', { category: 'annotation', duration: 1800 });
          closeNoteEdit();
        } else {
          getNotificationCenter().error('Unable to update merge note', { category: 'annotation' });
        }
      };

      input.addEventListener('input', () => {
        charCounter.textContent = `${input.value.length}/512`;
        inlineEdits.set(editFocusKey, 'note', input.value);
        resize();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          closeNoteEdit();
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          save();
        }
      });

      inputWrap.appendChild(input);
      inputWrap.appendChild(charCounter);
      metaEl.appendChild(inputWrap);
      if (typeof requestAnimationFrame !== 'function') {
        throw new TypeError('Merge note editing requires requestAnimationFrame()');
      }
      requestAnimationFrame(resize);
      return input;
    };

    const detachBtn = el('button', { type: 'button', className: 'btn', text: 'Detach' });
    detachBtn.addEventListener('click', () => {
      showOwnedConfirmDialog(lifecycle, {
        title: 'Detach merge?',
        message: `Detach "${fromLabel}" from its merged bundle?`,
        confirmText: 'Detach',
        returnFocusTo: detachBtn,
        onConfirm: () => {
          if (!isCurrent()) return;
          const ok = session.detachModerationMerge?.({ fieldKey, catIdx, fromSuggestionId: fromId });
          if (ok) getNotificationCenter().success('Detached (local moderation)', { category: 'annotation', duration: 2200 });
          else getNotificationCenter().error('Unable to detach', { category: 'annotation' });
        }
      });
    });
    actions.appendChild(detachBtn);
    row.appendChild(actions);

    renderMetaDisplay();
    const resumed = isOwn ? inlineEdits.resume(editFocusKey) : null;
    if (resumed !== null) enterNoteEdit(resumed.note);
  }

  return row;
}

function isAvailableModalFocusTarget(target) {
  return (
    target instanceof HTMLElement &&
    target.isConnected &&
    typeof target.focus === 'function' &&
    !(
      target instanceof HTMLButtonElement &&
      target.disabled
    )
  );
}

function resolvePrimarySuggestionAction(action, suggestionId) {
  const ownerOverlay = activeVotingModal?.overlay ?? null;
  if (
    !(ownerOverlay instanceof HTMLElement) ||
    !ownerOverlay.isConnected
  ) {
    return null;
  }
  const wantedAction = toCleanString(action);
  const wantedSuggestionId = toCleanString(suggestionId);
  if (!wantedAction || !wantedSuggestionId) return null;
  const candidates = ownerOverlay.querySelectorAll(
    'button[data-secondary-action][data-suggestion-id]'
  );
  for (const candidate of candidates) {
    if (
      candidate instanceof HTMLButtonElement &&
      candidate.dataset.secondaryAction === wantedAction &&
      candidate.dataset.suggestionId === wantedSuggestionId &&
      isAvailableModalFocusTarget(candidate)
    ) {
      return candidate;
    }
  }
  return null;
}

function resolvePrimaryModalCloseButton() {
  const ownerOverlay = activeVotingModal?.overlay ?? null;
  if (
    !(ownerOverlay instanceof HTMLElement) ||
    !ownerOverlay.isConnected
  ) {
    return null;
  }
  const target = ownerOverlay.querySelector(
    '.community-annotation-modal-close'
  );
  return isAvailableModalFocusTarget(target) ? target : null;
}

function showSecondaryModal({
  title,
  buildContent,
  session = null,
  returnFocusTo = null,
  returnFocusResolver = null
}) {
  if (typeof buildContent !== 'function') {
    throw new TypeError('Secondary modal requires a content builder');
  }
  if (
    returnFocusTo !== null &&
    !(returnFocusTo instanceof HTMLElement)
  ) {
    throw new TypeError(
      'Secondary modal return focus target must be an element or exact null'
    );
  }
  if (
    returnFocusResolver !== null &&
    typeof returnFocusResolver !== 'function'
  ) {
    throw new TypeError(
      'Secondary modal return focus resolver must be a function or exact null'
    );
  }
  if (activeSecondaryModal !== null) {
    activeSecondaryModal.close();
  }
  activeSecondaryModal = null;

  const overlay = el('div', { className: 'community-annotation-secondary-overlay', role: 'dialog', 'aria-modal': 'true' });
  const modal = el('div', { className: 'community-annotation-modal community-annotation-secondary-modal', role: 'document' });

  const header = el('div', { className: 'community-annotation-modal-header' });
  const titleEl = el('div', { className: 'community-annotation-modal-title', text: title || 'Details' });
  const titleId = createDomId('community-annotation-secondary-title');
  titleEl.id = titleId;
  overlay.setAttribute('aria-labelledby', titleId);
  header.appendChild(titleEl);
  const closeBtn = el('button', { type: 'button', className: 'btn community-annotation-modal-close', text: 'Close' });
  header.appendChild(closeBtn);

  const content = el('div', { className: 'community-annotation-modal-body' });

  modal.appendChild(header);
  modal.appendChild(content);
  overlay.appendChild(modal);

  let unsubscribe = null;
  let ownerObserver = null;
  let closed = false;
  const ownerOverlay = activeVotingModal?.overlay ?? null;
  const lifecycleController = new AbortController();
  let renderController = null;
  let renderGeneration = 0;
  const modalLifecycle = {
    signal: lifecycleController.signal,
    isCurrent: () => (
      !closed &&
      !lifecycleController.signal.aborted &&
      overlay.isConnected
    )
  };
  const prevFocus = returnFocusTo ?? document.activeElement;
  /** @type {Map<string, string>} */
  const drafts = new Map();
  const inlineEdits = new InlineEditState();
  let cleanupTrap = null;
  let releaseDocumentLayer = null;
  const releaseDocumentOwnership = () => {
    if (releaseDocumentLayer === null) return;
    const exactRelease = releaseDocumentLayer;
    releaseExactModalDocumentLayer(
      exactRelease,
      'Community annotation secondary modal'
    );
    if (releaseDocumentLayer === exactRelease) {
      releaseDocumentLayer = null;
    }
  };

  const render = () => {
    renderGeneration += 1;
    if (renderController !== null && !renderController.signal.aborted) {
      renderController.abort();
    }
    const generation = renderGeneration;
    renderController = new AbortController();
    const ownedController = renderController;
    const abortRender = () => {
      if (!ownedController.signal.aborted) ownedController.abort();
    };
    if (lifecycleController.signal.aborted) abortRender();
    else {
      lifecycleController.signal.addEventListener('abort', abortRender, {
        once: true
      });
      ownedController.signal.addEventListener('abort', () => {
        lifecycleController.signal.removeEventListener(
          'abort',
          abortRender
        );
      }, { once: true });
    }
    const lifecycle = {
      signal: ownedController.signal,
      isCurrent: () => (
        !closed &&
        !ownedController.signal.aborted &&
        generation === renderGeneration &&
        renderController === ownedController &&
        overlay.isConnected
      )
    };
    const focusSnapshot = captureModalRerenderFocus(content);
    captureModalDrafts(content, drafts);
    content.innerHTML = '';
    try {
      inlineEdits.rebuild(
        () => buildContent(content, { close, lifecycle, inlineEdits })
      );
      restoreModalDrafts(content, drafts);
      restoreModalRerenderFocus(focusSnapshot, content, closeBtn);
    } finally {
      // Render ownership remains active until the next render or modal close.
    }
  };

  const close = () => {
    if (closed) return;
    runExactCleanup('Community annotation secondary modal teardown', [
      [
        'secondary modal lifecycle',
        () => {
          if (!lifecycleController.signal.aborted) {
            lifecycleController.abort();
          }
          if (
            renderController !== null &&
            !renderController.signal.aborted
          ) {
            renderController.abort();
          }
        }
      ],
      ['session subscription', unsubscribe],
      [
        'owner observer',
        ownerObserver === null
          ? null
          : () => {
              if (typeof ownerObserver.disconnect !== 'function') {
                throw new TypeError('Secondary modal observer must expose disconnect()');
              }
              ownerObserver.disconnect();
            }
      ],
      ['focus trap', cleanupTrap],
      ['secondary modal overlay', () => overlay.remove()],
      ['modal document layer', releaseDocumentOwnership],
      [
        'previous focus target',
        prevFocus === null &&
        returnFocusResolver === null &&
        activeVotingModal === null
          ? null
          : () => {
              let target = isAvailableModalFocusTarget(prevFocus)
                ? prevFocus
                : null;
              if (target === null && returnFocusResolver !== null) {
                const resolved = returnFocusResolver();
                if (
                  resolved !== null &&
                  !(resolved instanceof HTMLElement)
                ) {
                  throw new TypeError(
                    'Secondary modal return focus resolver must return an element or exact null'
                  );
                }
                if (isAvailableModalFocusTarget(resolved)) {
                  target = resolved;
                }
              }
              target ??= resolvePrimaryModalCloseButton();
              if (target === null) return;
              if (!isAvailableModalFocusTarget(target)) {
                throw new TypeError(
                  'Secondary modal focus target must be connected and enabled'
                );
              }
              target.focus();
            }
      ]
    ]);
    closed = true;
    if (activeSecondaryModal !== null && activeSecondaryModal.close === close) {
      activeSecondaryModal = null;
    }
  };

  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  try {
    cleanupTrap = trapModalFocus({ overlay, modal, close });
    releaseDocumentLayer = claimModalDocumentLayer(overlay);
    document.body.appendChild(overlay);
    activeSecondaryModal = { close, overlay, lifecycle: modalLifecycle };
    closeBtn.focus();

    if (session && typeof session.on === 'function') {
      unsubscribe = session.on('changed', () => render());
      if (typeof unsubscribe !== 'function') {
        throw new TypeError('Secondary modal session subscription must return an unsubscribe function');
      }
    }

    if (ownerOverlay) {
      // The owner's overlay is a child of <body>, so its removal is a
      // childList change of <body> itself; nothing below <body> is watched.
      ownerObserver = new MutationObserver(() => {
        if (!document.body.contains(ownerOverlay)) close();
      });
      ownerObserver.observe(document.body, { childList: true });
    }

    render();
  } catch (primaryError) {
    try {
      close();
    } catch (cleanupError) {
      throw new AggregateError(
        [primaryError, cleanupError],
        'Secondary modal rendering and teardown both failed'
      );
    }
    throw primaryError;
  }

  return { close, overlay, modal, content };
}

function openSuggestionCommentsModal({
  session,
  fieldKey,
  catIdx,
  suggestion,
  canInteract,
  returnFocusTo = null
}) {
  const pageSize = 25;
  let page = 0;
  const suggestionId = toCleanString(suggestion?.id);
  showSecondaryModal({
    title: `Comments · ${toCleanString(suggestion?.label) || 'Suggestion'}`,
    session,
    returnFocusTo,
    returnFocusResolver: () => resolvePrimarySuggestionAction(
      'comments',
      suggestionId
    ),
    buildContent: (content, { lifecycle, inlineEdits }) => {
      const comments = session.getComments(fieldKey, catIdx, suggestion?.id);
      if (!Array.isArray(comments)) {
        throw new TypeError('Comment expansion requires an exact comments array');
      }
      if (comments.length > 800) {
        throw new Error('Community comments exceed the 800-item contract');
      }
      const sorted = comments
        .slice()
        .sort((a, b) => compareCodeUnitText(
          b?.createdAt || '',
          a?.createdAt || ''
        ));
      const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
      page = Math.min(page, pageCount - 1);

      const status = el('div', {
        className: 'community-annotation-page-status',
        role: 'status'
      });
      const list = el('div', {
        className: 'community-annotation-comments-page',
        role: 'list'
      });
      const controls = el('div', {
        className: 'community-annotation-page-controls'
      });
      const previous = el('button', {
        type: 'button',
        className: 'btn',
        text: 'Previous'
      });
      const next = el('button', {
        type: 'button',
        className: 'btn',
        text: 'Next'
      });

      const renderPage = ({ followOpenEdit = false } = {}) => inlineEdits.rebuild(() => {
        const currentComments = session.getComments(
          fieldKey,
          catIdx,
          suggestion?.id
        );
        if (!Array.isArray(currentComments)) {
          throw new TypeError(
            'Comment expansion requires an exact comments array'
          );
        }
        if (currentComments.length > 800) {
          throw new Error('Community comments exceed the 800-item contract');
        }
        const currentSorted = currentComments
          .slice()
          .sort((a, b) => compareCodeUnitText(
            b?.createdAt || '',
            a?.createdAt || ''
          ));
        const currentPageCount = Math.max(
          1,
          Math.ceil(currentSorted.length / pageSize)
        );
        // New comments shift older ones across pages. A rebuild for a session
        // change keeps the page that holds an open inline edit; the viewer's
        // own Previous and Next leave it.
        if (followOpenEdit) {
          const editedAnchors = inlineEdits.anchorIds();
          const editedIndex = currentSorted.findIndex(
            c => editedAnchors.has(toCleanString(c?.id))
          );
          if (editedIndex >= 0) page = Math.floor(editedIndex / pageSize);
        }
        page = Math.min(page, currentPageCount - 1);
        list.innerHTML = '';
        const start = page * pageSize;
        const shown = currentSorted.slice(start, start + pageSize);
        if (!shown.length) {
          list.appendChild(el('div', {
            className: 'empty-state',
            text: 'No comments yet.'
          }));
        } else {
          for (const comment of shown) {
            const row = renderComment({
              session,
              fieldKey,
              catIdx,
              suggestionId: suggestion?.id,
              comment,
              inlineEdits,
              lifecycle,
              canInteract,
              onUpdate: () => {
                if (list.isConnected) renderPage();
              }
            });
            row.setAttribute('role', 'listitem');
            list.appendChild(row);
          }
        }
        status.textContent =
          `Page ${page + 1} of ${currentPageCount} · ` +
          `${currentSorted.length} comment${currentSorted.length === 1 ? '' : 's'}`;
        previous.disabled = page === 0;
        next.disabled = page >= currentPageCount - 1;
      });

      previous.addEventListener('click', () => {
        if (page === 0) return;
        page -= 1;
        renderPage();
        focusEnabledPaginationControl(previous, next);
      });
      next.addEventListener('click', () => {
        page += 1;
        renderPage();
        focusEnabledPaginationControl(next, previous);
      });
      controls.appendChild(previous);
      controls.appendChild(status);
      controls.appendChild(next);
      content.appendChild(list);
      content.appendChild(controls);
      renderPage({ followOpenEdit: true });
    }
  });
}

function openMergedSuggestionsModal({
  session,
  fieldKey,
  catIdx,
  targetSuggestionId,
  returnFocusTo = null
}) {
  const access = getCommunityAnnotationAccessStore();
  const isClosed = session.isFieldClosed?.(fieldKey) === true;
  const canInteract = !isClosed || access.isAuthor();
  const logicalSuggestionId = toCleanString(targetSuggestionId);

  showSecondaryModal({
    title: 'Merged suggestions',
    session,
    returnFocusTo,
    returnFocusResolver: () => resolvePrimarySuggestionAction(
      'merged',
      logicalSuggestionId
    ),
    buildContent: (content, { lifecycle, inlineEdits }) => {
      const bucket = bucketKey(session, fieldKey, catIdx);
      const mergesAll = session.getModerationMerges?.() || [];
      const merges = Array.isArray(mergesAll) ? mergesAll.filter((m) => toCleanString(m?.bucket) === bucket) : [];

      const all = session.getSuggestions?.(fieldKey, catIdx) || [];
      const target = (Array.isArray(all) ? all : []).find((s) => toCleanString(s?.id) === toCleanString(targetSuggestionId)) || null;
      const mergedFrom = Array.isArray(target?.mergedFrom) ? target.mergedFrom : [];

      if (!target || !mergedFrom.length) {
        content.appendChild(el('p', { className: 'empty-state', text: 'No merged suggestions for this bundle.' }));
        return;
      }

      const canDetach = access.isAuthor();

      const idToLabel = new Map();
      const tid = toCleanString(target?.id);
      if (tid) idToLabel.set(tid, toCleanString(target?.label) || tid);
      for (const s of mergedFrom) {
        const id = toCleanString(s?.id);
        if (!id) continue;
        idToLabel.set(id, toCleanString(s?.label) || id);
      }
      if (typeof session.getStateSnapshot !== 'function') {
        throw new TypeError('Merged suggestion rendering requires getStateSnapshot()');
      }
      const snap = session.getStateSnapshot();
      const raw = snap?.suggestions?.[bucket] || [];
      if (!Array.isArray(raw)) {
        throw new TypeError('Merged suggestion snapshot bucket must be an array');
      }
      for (const s of raw) {
        const id = toCleanString(s?.id);
        if (!id || idToLabel.has(id)) continue;
        idToLabel.set(id, toCleanString(s?.label) || id);
      }

      const targetId = toCleanString(target?.id);
      // How bundles count votes is told by the (i); the dialog shows the totals.
      const bundleInfo = createInfoTip({ tip: 'community-bundle', label: 'About merged bundles' });
      content.appendChild(el('div', { className: 'field-label-row' }, [
        el('span', { className: 'community-annotation-inline-help', text: `Bundle: ${toCleanString(target?.label) || '—'}` }),
        bundleInfo.button
      ]));
      content.appendChild(bundleInfo.popover);
      content.appendChild(el('div', {
        className: 'status-line',
        text: `Votes: ▲${target.upvotes?.length || 0} ▼${target.downvotes?.length || 0}`
      }));

      const traversal = buildMergeTraversal({
        targetSuggestionId: targetId,
        merges
      });

      const suggestionById = new Map();
      if (targetId) suggestionById.set(targetId, target);
      for (const s of mergedFrom) {
        const id = toCleanString(s?.id);
        if (!id) continue;
        suggestionById.set(id, s);
      }

      const list = el('div', { className: 'community-annotation-suggestions' });
      const renderedCards = new Set();

      const renderCard = (id) => {
        const sid = toCleanString(id);
        if (!sid || renderedCards.has(sid)) return;
        const s = suggestionById.get(sid) || null;
        if (!s) return;
        renderedCards.add(sid);
        list.appendChild(renderSuggestionCard({
          session,
          fieldKey,
          catIdx,
          suggestion: s,
          inlineEdits,
          lifecycle,
          canInteract,
          duplicateLabelKeys: null,
          variant: 'full',
          showMergedBundleRow: false,
          allowModerationDrag: false,
          voteDisplayMode: sid === targetId ? 'bundle' : 'direct'
        }));
      };

      for (const step of traversal.steps) {
        renderCard(step.fromSuggestionId);
        list.appendChild(renderMergeRow({
          session,
          fieldKey,
          catIdx,
          merge: step.merge,
          idToLabel,
          inlineEdits,
          lifecycle,
          canDetach
        }));
      }

      // Always render the target card last for context.
      renderCard(targetId);

      content.appendChild(list);
    }
  });
}

function renderSuggestionCard({
  session,
  fieldKey,
  catIdx,
  suggestion,
  inlineEdits,
  mergeTargets = [],
  lifecycle = null,
  canInteract = true,
  duplicateLabelKeys = null,
  variant = 'full',
  showMergedBundleRow = true,
  allowModerationDrag = true,
  voteDisplayMode = 'bundle'
}) {
  requireInlineEditState(inlineEdits, 'Suggestion card rendering');
  const isCurrent = () => (
    lifecycle === null ||
    (
      typeof lifecycle.isCurrent === 'function' &&
      lifecycle.isCurrent()
    )
  );
  const isCompact = variant === 'compact';
  const up = suggestion?.upvotes?.length || 0;
  const down = suggestion?.downvotes?.length || 0;
  const net = up - down;
  const directVote = session.getMyVoteDirect?.(fieldKey, catIdx, suggestion?.id) ?? session.getMyVote?.(fieldKey, catIdx, suggestion?.id) ?? null;
  const bundleInfo = voteDisplayMode === 'bundle' && session.getMyBundleVoteInfo
    ? session.getMyBundleVoteInfo(fieldKey, catIdx, suggestion?.id)
    : { vote: directVote, source: directVote ? 'direct' : 'none', delegatedUp: 0, delegatedDown: 0 };
  const myVote = bundleInfo?.vote || null;
  const isDelegated = bundleInfo?.source === 'delegated';
  const delegatedUp = Number(bundleInfo?.delegatedUp || 0);
  const delegatedDown = Number(bundleInfo?.delegatedDown || 0);
  const isDelegationTie = bundleInfo?.source === 'none' && !myVote && (delegatedUp + delegatedDown) > 0;
  const access = getCommunityAnnotationAccessStore();
  const canModerate = access.isAuthor();
  const myUser = toCleanString(session.getProfile?.()?.username || '').replace(/^@+/, '').toLowerCase();
  const proposer = toCleanString(suggestion?.proposedBy || '').replace(/^@+/, '').toLowerCase();
  const isMine = Boolean(myUser && proposer && myUser === proposer);
  const suggestionFocusPrefix = createModalFocusKey(
    'suggestion',
    fieldKey,
    catIdx,
    suggestion?.id
  );

  const card = el('div', { className: 'community-annotation-suggestion-card' });
  const labelKey = normalizeLabelForCompare(suggestion?.label || '');
  const isDuplicate = Boolean(labelKey && duplicateLabelKeys && duplicateLabelKeys.has(labelKey));
  if (isDuplicate) card.classList.add('is-duplicate-label');
  const top = el('div', { className: 'community-annotation-suggestion-top' });
  top.appendChild(el('div', { className: 'community-annotation-suggestion-label', text: suggestion?.label || '' }));
  top.appendChild(el('div', { className: 'community-annotation-suggestion-net', text: `net ${net}` }));
  card.appendChild(top);

  if ((isDelegated && (myVote === 'up' || myVote === 'down')) || isDelegationTie) {
    const icon = isDelegationTie ? '±' : (myVote === 'up' ? '▲' : '▼');
    const label = isDelegationTie ? 'Delegation tie' : (myVote === 'up' ? 'Delegated upvote' : 'Delegated downvote');
    const detail = (delegatedUp || delegatedDown) ? ` (${delegatedUp}▲ / ${delegatedDown}▼)` : '';
    card.appendChild(el('div', {
      className: `community-annotation-delegated-vote ${isDelegationTie ? 'delegated-tie' : `delegated-${myVote}`}`,
      text: `${icon} ${label}${detail}`
    }));
  }

  if (isDuplicate) {
    card.appendChild(el('div', {
      className: 'community-annotation-dup-note',
      text: canModerate ? 'Duplicate label (use Merge… to combine if needed).' : 'Duplicate label (votes may be split).'
    }));
  }

  const meta = el('div', { className: 'community-annotation-suggestion-meta' });
  const ontologyId = toCleanString(suggestion?.ontologyId || '');
  meta.appendChild(el('div', { className: 'community-annotation-suggestion-ontology', text: `Ontology: ${ontologyId || '—'}` }));

  const markers = markersToGeneList(suggestion?.markers);
  const markerSummary = markers.length ? markers.join(', ') : '—';
  meta.appendChild(el('div', { className: 'field-help', text: `Markers: ${markerSummary}` }));

  const evidence = toCleanString(suggestion?.evidence || '');
  const evidenceShort = evidence ? truncateText(evidence, 220) : '';
  const evidenceText = evidenceShort || '—';
  const evidenceRow = el('div', { className: 'community-annotation-suggestion-evidence', text: `Evidence: ${evidenceText}` });
  meta.appendChild(evidenceRow);
  if (evidence && evidenceShort !== evidence) {
    const moreBtn = el('button', {
      type: 'button',
      className: 'community-annotation-merged-comment-btn',
      text: 'View full evidence',
      'data-secondary-action': 'evidence',
      'data-suggestion-id': toCleanString(suggestion?.id)
    });
    ownModalFocusKey(moreBtn, `${suggestionFocusPrefix}:evidence`);
    moreBtn.addEventListener('click', () => {
      showSecondaryModal({
        title: 'Evidence',
        session: null,
        returnFocusTo: moreBtn,
        returnFocusResolver: () => resolvePrimarySuggestionAction(
          'evidence',
          suggestion?.id
        ),
        buildContent: (content) => {
          content.appendChild(el('div', { className: 'community-annotation-inline-help', text: toCleanString(suggestion?.label) || 'Suggestion' }));
          content.appendChild(el('div', { className: 'control-box', text: evidence }));
        }
      });
    });
    meta.appendChild(moreBtn);
  }

  card.appendChild(meta);

  const actions = el('div', { className: 'community-annotation-suggestion-actions' });
  const upBtn = el('button', {
    type: 'button',
    className: 'btn btn-compact community-annotation-vote-btn vote-up',
    text: `▲ ${up}`,
    disabled: !canInteract,
    'aria-label': `Upvote ${toCleanString(suggestion?.label) || 'suggestion'}; ${up} upvotes`,
    'aria-pressed': myVote === 'up' ? 'true' : 'false'
  });
  const downBtn = el('button', {
    type: 'button',
    className: 'btn btn-compact community-annotation-vote-btn vote-down',
    text: `▼ ${down}`,
    disabled: !canInteract,
    'aria-label': `Downvote ${toCleanString(suggestion?.label) || 'suggestion'}; ${down} downvotes`,
    'aria-pressed': myVote === 'down' ? 'true' : 'false'
  });
  ownModalFocusKey(upBtn, `${suggestionFocusPrefix}:vote-up`);
  ownModalFocusKey(downBtn, `${suggestionFocusPrefix}:vote-down`);
  if (myVote === 'up') upBtn.classList.add('is-mine');
  if (myVote === 'down') downBtn.classList.add('is-mine');
  if (isDelegated) {
    if (myVote === 'up') upBtn.classList.add('is-delegated');
    if (myVote === 'down') downBtn.classList.add('is-delegated');
  }

  if (canInteract) {
    // `vote()` reports `false` when this card no longer names a suggestion the
    // session can find — the bucket moved under the modal (the numeric
    // `catIdx` is resolved late, against category registrations another module
    // writes without a `changed` event) or the suggestion was removed by a
    // Pull. Neither case re-renders this card on its own, so an unreported
    // `false` leaves the button looking live while every click is discarded.
    // Reporting only on the failure branch keeps the common path silent.
    const castVote = (button, direction) => {
      if (!isCurrent()) return;
      focusRenderedModalTarget(button);
      const recorded = session.vote(
        fieldKey,
        catIdx,
        suggestion.id,
        direction
      );
      if (typeof recorded !== 'boolean') {
        throw new TypeError(
          'Community annotation vote must report an exact boolean outcome'
        );
      }
      if (recorded) return;
      getNotificationCenter().error(
        'Vote not recorded: this suggestion is no longer part of the ' +
        'category shown here. Close and reopen community voting to see ' +
        'the current suggestions.',
        { category: 'annotation' }
      );
    };
    upBtn.addEventListener('click', () => castVote(upBtn, 'up'));
    downBtn.addEventListener('click', () => castVote(downBtn, 'down'));
  }
  actions.appendChild(upBtn);
  actions.appendChild(downBtn);

  let editBox = null;
  let mergeBox = null;
  if (!isCompact && isMine && canInteract) {
    // Edit opens the editor and stays "Edit" (its state is aria-expanded);
    // Cancel and Save close it, so no second "Hide edit" control competes.
    const editBoxId = createDomId('community-annotation-edit');
    const editBtn = el('button', {
      type: 'button',
      className: 'btn',
      text: 'Edit',
      'aria-expanded': 'false',
      'aria-controls': editBoxId
    });
    const editFocusKey = `${suggestionFocusPrefix}:edit`;
    ownModalFocusKey(editBtn, editFocusKey);

    editBox = el('div', { className: 'control-box', id: editBoxId, hidden: true });
    editBox.appendChild(el('div', { className: 'community-annotation-new-title', text: 'Edit suggestion' }));

    const editForm = el('div', { className: 'community-annotation-new community-annotation-new-vertical' });
    const labelInput = el('input', { type: 'text', className: 'obs-select', 'aria-label': 'Label', placeholder: 'Label (required)', maxlength: '120' });
    const ontInput = el('input', { type: 'text', className: 'obs-select', 'aria-label': 'Ontology id', placeholder: 'Ontology id (optional)', title: 'Ontology id, such as CL:0000625', maxlength: '64' });
    const markerGenesInput = el('input', { type: 'text', className: 'obs-select', 'aria-label': 'Marker genes', placeholder: 'Marker genes (optional)', title: 'Marker genes, separated by commas' });
    const evidenceInput = el('textarea', { className: 'obs-select community-annotation-textarea', 'aria-label': 'Evidence', placeholder: 'Evidence (optional)', maxlength: '2000' });
    ownModalFocusKey(labelInput, `${suggestionFocusPrefix}:edit-label`);
    ownModalFocusKey(
      ontInput,
      `${suggestionFocusPrefix}:edit-ontology`
    );
    ownModalFocusKey(
      markerGenesInput,
      `${suggestionFocusPrefix}:edit-markers`
    );
    ownModalFocusKey(
      evidenceInput,
      `${suggestionFocusPrefix}:edit-evidence`
    );

    const editFields = {
      label: labelInput,
      ontologyId: ontInput,
      markers: markerGenesInput,
      evidence: evidenceInput
    };
    const readEditFields = () => Object.fromEntries(
      Object.entries(editFields).map(([name, input]) => [name, input.value])
    );
    for (const [name, input] of Object.entries(editFields)) {
      input.addEventListener('input', () => {
        inlineEdits.set(editFocusKey, name, input.value);
      });
    }

    let originalMarkerText = '';
    const populateFromSuggestion = () => {
      labelInput.value = suggestion?.label || '';
      ontInput.value = suggestion?.ontologyId || '';
      originalMarkerText = markersToInputText(suggestion?.markers);
      markerGenesInput.value = originalMarkerText;
      evidenceInput.value = suggestion?.evidence || '';
    };
    const showEditBox = (open) => {
      editBox.hidden = !open;
      editBtn.setAttribute('aria-expanded', String(open));
    };

    const editActions = el('div', { className: 'community-annotation-suggestion-actions' });
    const saveBtn = el('button', { type: 'button', className: 'btn', text: 'Save' });
    const cancelBtn = el('button', { type: 'button', className: 'btn', text: 'Cancel' });
    ownModalFocusKey(saveBtn, `${suggestionFocusPrefix}:edit-save`, {
      restoreKey: editFocusKey
    });
    ownModalFocusKey(cancelBtn, `${suggestionFocusPrefix}:edit-cancel`, {
      restoreKey: editFocusKey
    });
    editActions.appendChild(saveBtn);
    editActions.appendChild(cancelBtn);

    saveBtn.addEventListener('click', () => {
      try {
        if (!isCurrent()) return;
        const patch = {
          label: labelInput.value,
          ontologyId: ontInput.value,
          evidence: evidenceInput.value
        };
        const markerTextChanged =
          toCleanString(markerGenesInput.value) !== originalMarkerText;
        let lostStats = [];
        if (markerTextChanged) {
          const nextGenes = parseMarkerGenesInput(markerGenesInput.value);
          const reconciled = reconcileEditedMarkerChange(
            suggestion?.markers,
            nextGenes
          );
          lostStats = reconciled.lostStats;
          patch.markers = nextGenes === null ? null : reconciled.markers;
        }

        const save = () => {
          if (!isCurrent()) return;
          focusRenderedModalTarget(saveBtn);
          const ok = inlineEdits.commit(
            editFocusKey,
            () => session.editMySuggestion?.(
              fieldKey,
              catIdx,
              suggestion?.id,
              patch
            )
          );
          if (!ok) {
            getNotificationCenter().error('Failed to update suggestion', {
              category: 'annotation'
            });
            return;
          }
          getNotificationCenter().success('Suggestion updated', {
            category: 'annotation',
            duration: 1500
          });
          showEditBox(false);
          editBtn.focus({ preventScroll: true });
        };

        if (lostStats.length) {
          showOwnedConfirmDialog(lifecycle, {
            title: 'Remove marker statistics?',
            message:
              `Changing these markers will remove stored logFC/p-value ` +
              `statistics for: ${formatLostMarkerStats(lostStats)}.`,
            confirmText: 'Continue',
            returnFocusTo: saveBtn,
            onConfirm: save
          });
          return;
        }
        save();
      } catch (err) {
        getNotificationCenter().error(describeErrorMessage(err), { category: 'annotation' });
      }
    });

    cancelBtn.addEventListener('click', () => {
      inlineEdits.close(editFocusKey);
      showEditBox(false);
      populateFromSuggestion();
    });

    editBtn.addEventListener('click', () => {
      const open = editBox.hidden;
      if (open) {
        populateFromSuggestion();
        inlineEdits.open(editFocusKey, {
          anchorId: suggestion?.id,
          noun: 'suggestion',
          values: readEditFields()
        });
      } else {
        inlineEdits.close(editFocusKey);
      }
      showEditBox(open);
      if (open) labelInput.focus?.();
    });

    const resumedEdit = inlineEdits.resume(editFocusKey);
    if (resumedEdit !== null) {
      populateFromSuggestion();
      for (const [name, input] of Object.entries(editFields)) {
        input.value = resumedEdit[name] ?? input.value;
      }
      showEditBox(true);
    }

    editForm.appendChild(labelInput);
    editForm.appendChild(ontInput);
    editForm.appendChild(markerGenesInput);
    editForm.appendChild(evidenceInput);
    editForm.appendChild(editActions);
    editBox.appendChild(editForm);

    actions.appendChild(editBtn);

    const delBtn = el('button', { type: 'button', className: 'btn', text: 'Delete' });
    ownModalFocusKey(delBtn, `${suggestionFocusPrefix}:delete`);
    delBtn.addEventListener('click', () => {
      showOwnedConfirmDialog(lifecycle, {
        title: 'Delete your suggestion?',
        message:
          `This will remove your suggestion "${toCleanString(suggestion?.label) || ''}" from the community list once you Publish.\n\n` +
          `Your local vote/comment data for this suggestion will also be removed.`,
        confirmText: 'Delete',
        returnFocusTo: delBtn,
        onConfirm: () => {
          if (!isCurrent()) return;
          const ok = session.deleteMySuggestion?.(fieldKey, catIdx, suggestion?.id);
          if (ok) {
            getNotificationCenter().success('Suggestion deleted (local)', { category: 'annotation', duration: 1800 });
          } else {
            getNotificationCenter().error('Unable to delete this suggestion', { category: 'annotation' });
          }
        }
      });
    });
    actions.appendChild(delBtn);
  }

  if (
    !isCompact &&
    canModerate &&
    canInteract &&
    suggestion?.id &&
    Array.isArray(mergeTargets)
  ) {
    const targets = mergeTargets.filter((target) => (
      toCleanString(target?.id) &&
      toCleanString(target?.id) !== toCleanString(suggestion.id)
    ));
    if (targets.length) {
      const mergeBoxId = createDomId('community-annotation-merge-form');
      const mergeBtn = el('button', {
        type: 'button',
        className: 'btn community-annotation-merge-button',
        text: 'Merge…',
        'aria-expanded': 'false',
        'aria-controls': mergeBoxId
      });
      ownModalFocusKey(mergeBtn, `${suggestionFocusPrefix}:merge`);
      mergeBox = el('div', {
        id: mergeBoxId,
        className: 'control-box community-annotation-merge-form',
        hidden: true
      });
      const labelId = createDomId('community-annotation-merge-target-label');
      const targetSelectId = createDomId(
        'community-annotation-merge-target'
      );
      mergeBox.appendChild(el('label', {
        id: labelId,
        for: targetSelectId,
        className: 'community-annotation-new-title'
      }, [
        `Merge “${toCleanString(suggestion.label)}” into`
      ]));
      const targetSelect = el('select', {
        id: targetSelectId,
        className: 'obs-select',
        'aria-labelledby': labelId
      });
      targetSelect.appendChild(el('option', {
        value: '',
        text: 'Choose a target suggestion'
      }));
      for (const target of targets) {
        targetSelect.appendChild(el('option', {
          value: target.id,
          text: toCleanString(target.label) || target.id
        }));
      }
      const noteInput = el('textarea', {
        className: 'obs-select community-annotation-textarea',
        'aria-label': 'Merge note',
        placeholder: 'Optional merge note',
        maxlength: '512',
        rows: '2'
      });
      ownModalFocusKey(
        targetSelect,
        `${suggestionFocusPrefix}:merge-target`
      );
      ownModalFocusKey(
        noteInput,
        `${suggestionFocusPrefix}:merge-note`
      );
      const mergeActions = el('div', {
        className: 'community-annotation-suggestion-actions'
      });
      const confirmMergeBtn = el('button', {
        type: 'button',
        className: 'btn',
        text: 'Merge suggestion'
      });
      const cancelMergeBtn = el('button', {
        type: 'button',
        className: 'btn',
        text: 'Cancel'
      });
      ownModalFocusKey(
        confirmMergeBtn,
        `${suggestionFocusPrefix}:merge-confirm`,
        { restoreKey: `${suggestionFocusPrefix}:merge` }
      );
      ownModalFocusKey(
        cancelMergeBtn,
        `${suggestionFocusPrefix}:merge-cancel`,
        { restoreKey: `${suggestionFocusPrefix}:merge` }
      );
      const closeMergeForm = () => {
        mergeBox.hidden = true;
        mergeBtn.setAttribute('aria-expanded', 'false');
        mergeBtn.focus?.();
      };
      mergeBtn.addEventListener('click', () => {
        if (!isCurrent()) return;
        const willOpen = mergeBox.hidden;
        mergeBox.hidden = !willOpen;
        mergeBtn.setAttribute(
          'aria-expanded',
          willOpen ? 'true' : 'false'
        );
        if (willOpen) targetSelect.focus?.();
      });
      cancelMergeBtn.addEventListener('click', closeMergeForm);
      confirmMergeBtn.addEventListener('click', () => {
        if (!isCurrent()) return;
        const target = targets.find(
          (entry) => entry.id === targetSelect.value
        );
        if (!target) {
          getNotificationCenter().info(
            'Choose a target suggestion to merge into',
            { category: 'annotation', duration: 1800 }
          );
          targetSelect.focus?.();
          return;
        }
        showOwnedConfirmDialog(lifecycle, {
          title: 'Merge suggestions?',
          tone: 'primary',
          message:
            `Merge “${toCleanString(suggestion.label)}” into ` +
            `“${toCleanString(target.label)}”? Votes will be combined ` +
            `(one per user), while comments remain reviewable.`,
          confirmText: 'Merge',
          returnFocusTo: confirmMergeBtn,
          onConfirm: () => {
            try {
              if (!isCurrent()) return;
              const ok = session.addModerationMerge({
                fieldKey,
                catIdx,
                fromSuggestionId: suggestion.id,
                intoSuggestionId: target.id,
                note: toCleanString(noteInput.value) || null
              });
              if (!ok) {
                throw new Error('Failed to merge suggestions');
              }
              getNotificationCenter().success(
                'Merged suggestions (local moderation)',
                { category: 'annotation', duration: 2400 }
              );
            } catch (error) {
              getNotificationCenter().error(describeErrorMessage(error), {
                category: 'annotation'
              });
            }
          }
        });
      });
      mergeActions.appendChild(confirmMergeBtn);
      mergeActions.appendChild(cancelMergeBtn);
      mergeBox.appendChild(targetSelect);
      mergeBox.appendChild(noteInput);
      mergeBox.appendChild(mergeActions);
      actions.appendChild(mergeBtn);
    }
  }

  card.appendChild(actions);
  if (editBox) card.appendChild(editBox);
  if (mergeBox) card.appendChild(mergeBox);

  const by = el('div', { className: 'field-help', text: session.formatUserAttribution(suggestion?.proposedBy || '') });
  card.appendChild(by);

  const mergedFrom = Array.isArray(suggestion?.mergedFrom) ? suggestion.mergedFrom : [];
  if (!isCompact && showMergedBundleRow && mergedFrom.length && suggestion?.id) {
    const bundleRow = el('div', { className: 'community-annotation-bundle-row' });
    bundleRow.appendChild(el('div', {
      className: 'field-help',
      text: `Merged bundle (${mergedFrom.length + 1} suggestions) • votes de-duplicated`
    }));
    const mergedBtn = el('button', {
      type: 'button',
      className: 'community-annotation-merged-comment-btn',
      text: `View merged (${mergedFrom.length})`,
      title: 'View original votes and comments for merged suggestions',
      'data-secondary-action': 'merged',
      'data-suggestion-id': toCleanString(suggestion?.id)
    });
    ownModalFocusKey(mergedBtn, `${suggestionFocusPrefix}:merged`);
    mergedBtn.addEventListener('click', () => {
      openMergedSuggestionsModal({
        session,
        fieldKey,
        catIdx,
        targetSuggestionId: suggestion.id,
        returnFocusTo: mergedBtn
      });
    });
    bundleRow.appendChild(mergedBtn);
    card.appendChild(bundleRow);
  }

  if (typeof session.getComments !== 'function') {
    throw new TypeError('Comment rendering requires session.getComments()');
  }
  const comments = session.getComments(fieldKey, catIdx, suggestion?.id);
  if (!Array.isArray(comments)) {
    throw new TypeError('Comment rendering requires an exact comments array');
  }
  if (comments.length > 800) {
    throw new Error('Community comments exceed the 800-item contract');
  }
  if (!isCompact && suggestion?.id) {
    const commentsBox = el('div', { className: 'community-annotation-comments-inline' });

    const input = el('textarea', {
      className: 'community-annotation-comment-bar',
      'aria-label': 'Comment',
      placeholder: canInteract ? 'Write a comment and press Enter…' : 'Comments are disabled (closed by author).',
      maxlength: '500',
      rows: '1',
      disabled: !canInteract
    });
    ownModalDraft(
      ownModalFocusKey(input, `${suggestionFocusPrefix}:comment-compose`)
    );
    const charCounter = el('div', {
      className: 'community-annotation-char-counter community-annotation-char-counter--overlay',
      text: `${input.value.length}/500`
    });
    const resizeInput = () => {
      const cs = getComputedStyle(input);
      const minHeight = Number.parseFloat(cs.minHeight || '') || null;
      const maxHeight = Number.parseFloat(cs.maxHeight || '') || null;
      autoSizeTextarea(input, { minHeightPx: minHeight, maxHeightPx: maxHeight });
    };
    input.addEventListener('input', () => {
      charCounter.textContent = `${input.value.length}/500`;
      resizeInput();
    });
    input.addEventListener('keydown', (e) => {
      if (!canInteract) return;
      if (e.key !== 'Enter' || e.shiftKey) return;
      e.preventDefault();
      const text = toCleanString(input.value);
      if (!text) return;
      const id = session.addComment?.(fieldKey, catIdx, suggestion.id, text);
      if (id) {
        input.value = '';
        charCounter.textContent = '0/500';
        resizeInput();
        getNotificationCenter().success('Comment added', { category: 'annotation', duration: 1200 });
      } else {
        getNotificationCenter().error('Failed to add comment', { category: 'annotation' });
      }
    });
    const inputWrap = el('div', { className: 'community-annotation-comment-bar-wrap' });
    inputWrap.appendChild(input);
    inputWrap.appendChild(charCounter);
    commentsBox.appendChild(inputWrap);
    if (typeof requestAnimationFrame !== 'function') {
      throw new TypeError('Comment textarea rendering requires requestAnimationFrame()');
    }
    requestAnimationFrame(resizeInput);

    const sorted = comments
      .slice()
      .sort((a, b) => compareCodeUnitText(
        b?.createdAt || '',
        a?.createdAt || ''
      ));

    const previewEditKey = (c) => `${createModalFocusKey(
      'comment-preview',
      fieldKey,
      catIdx,
      suggestion?.id,
      c?.id
    )}:edit`;
    // The newest five comments, plus any older one whose edit is open: a
    // comment arriving while the viewer edits the fifth must not push that
    // editor out of the preview.
    const previewComments = sorted.filter(
      (c, index) => index < 5 || inlineEdits.has(previewEditKey(c))
    );
    const scroll = el('div', { className: 'community-annotation-comments-scroll' });
    for (const c of previewComments) {
      const commentPreviewFocusPrefix = createModalFocusKey(
        'comment-preview',
        fieldKey,
        catIdx,
        suggestion?.id,
        c?.id
      );
      const author = toCleanString(c?.authorUsername || '') || 'local';
      const time = toCleanString(c?.editedAt || c?.createdAt || '');
      const metaText = `${formatCommentAuthorHandle(session, author)}${time ? ` • ${formatRelativeTime(time)}` : ''}`;
      const isOwn = session.isMyComment(author);

      const item = el('div', { className: 'community-annotation-comment-preview-item' });
      item.appendChild(el('span', { className: 'community-annotation-comment-preview-meta', text: metaText }));

      const body = el('div', { className: 'community-annotation-comment-preview-body' });
      let currentText = toCleanString(c?.text || '');
      let isEditing = false;

      const editBtn = el('button', { type: 'button', className: 'community-annotation-comment-action-btn', text: 'Edit' });
      const deleteBtn = el('button', { type: 'button', className: 'community-annotation-comment-action-btn', text: 'Delete' });
      const editFocusKey = previewEditKey(c);
      ownModalFocusKey(editBtn, editFocusKey);
      ownModalFocusKey(
        deleteBtn,
        `${commentPreviewFocusPrefix}:delete`
      );
      const inlineActions = el('span', { className: 'community-annotation-inline-action-links' }, [
        editBtn,
        deleteBtn
      ]);

      const renderPreview = () => {
        isEditing = false;
        body.innerHTML = '';
        const textWrap = el('span', { className: 'community-annotation-comment-preview-text' }, [currentText]);
        if (isOwn && canInteract) textWrap.appendChild(inlineActions);
        body.appendChild(textWrap);
      };

      const renderEdit = (text) => {
        isEditing = true;
        body.innerHTML = '';

        const inputWrap = el('div', { className: 'community-annotation-comment-bar-wrap community-annotation-comment-bar-wrap--edit' });
        const input = el('textarea', {
          className: 'community-annotation-comment-bar community-annotation-comment-bar--edit',
          'aria-label': 'Edit comment',
          placeholder: 'Edit comment…',
          maxlength: '500',
          rows: '1',
          'data-esc-cancel': 'true',
          title: 'Enter to save • Esc to cancel'
        });
        ownModalFocusKey(input, `${commentPreviewFocusPrefix}:edit-input`, {
          restoreKey: editFocusKey
        });
        input.value = text;
        const counter = el('div', {
          className: 'community-annotation-char-counter community-annotation-char-counter--overlay',
          text: `${input.value.length}/500`
        });

        const resize = () => {
          const cs = getComputedStyle(input);
          const minHeight = Number.parseFloat(cs.minHeight || '') || null;
          const maxHeight = Number.parseFloat(cs.maxHeight || '') || null;
          autoSizeTextarea(input, { minHeightPx: minHeight, maxHeightPx: maxHeight });
        };

        const save = () => {
          if (!isCurrent()) return;
          const nextText = toCleanString(input.value);
          if (!nextText) return;
          focusRenderedModalTarget(input);
          const ok = inlineEdits.commit(
            editFocusKey,
            () => session.editComment?.(fieldKey, catIdx, suggestion.id, c?.id, nextText)
          );
          if (ok) {
            currentText = nextText;
            getNotificationCenter().success('Comment updated', { category: 'annotation', duration: 1500 });
            renderPreview();
            editBtn.focus({ preventScroll: true });
          } else {
            getNotificationCenter().error('Failed to update comment', { category: 'annotation' });
          }
        };

        input.addEventListener('input', () => {
          counter.textContent = `${input.value.length}/500`;
          inlineEdits.set(editFocusKey, 'text', input.value);
          resize();
        });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            inlineEdits.close(editFocusKey);
            renderPreview();
            editBtn.focus({ preventScroll: true });
            return;
          }
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            save();
          }
        });

        inputWrap.appendChild(input);
        inputWrap.appendChild(counter);
        body.appendChild(inputWrap);
        if (typeof requestAnimationFrame !== 'function') {
          throw new TypeError('Comment editing requires requestAnimationFrame()');
        }
        requestAnimationFrame(resize);
        return input;
      };

      if (isOwn && canInteract) {
        editBtn.addEventListener('click', () => {
          if (isEditing) return;
          inlineEdits.open(editFocusKey, {
            anchorId: suggestion?.id,
            noun: 'comment',
            values: { text: currentText }
          });
          renderEdit(currentText).focus();
        });

        deleteBtn.addEventListener('click', () => {
          if (isEditing) return;
          showOwnedConfirmDialog(lifecycle, {
            title: 'Delete comment?',
            message: 'This will remove your comment. This action cannot be undone.',
            confirmText: 'Delete',
            returnFocusTo: deleteBtn,
            onConfirm: () => {
              if (!isCurrent()) return;
              const ok = session.deleteComment?.(fieldKey, catIdx, suggestion.id, c?.id);
              if (ok) {
                getNotificationCenter().success('Comment deleted', { category: 'annotation', duration: 1500 });
              } else {
                getNotificationCenter().error('Failed to delete comment', { category: 'annotation' });
              }
            }
          });
        });
      }

      const resumedEdit = isOwn && canInteract
        ? inlineEdits.resume(editFocusKey)
        : null;
      if (resumedEdit !== null) renderEdit(resumedEdit.text);
      else renderPreview();
      item.appendChild(body);
      scroll.appendChild(item);
    }
    const updateScrollFade = () => {
      const scrollable = scroll.scrollHeight > scroll.clientHeight + 1;
      scroll.classList.toggle('is-scrollable', scrollable);
      if (!scrollable) {
        scroll.classList.remove('is-at-bottom');
        return;
      }
      const atBottom = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 1;
      scroll.classList.toggle('is-at-bottom', atBottom);
    };
    scroll.addEventListener('scroll', updateScrollFade, { passive: true });
    if (typeof requestAnimationFrame !== 'function') {
      throw new TypeError('Comment scrolling requires requestAnimationFrame()');
    }
    requestAnimationFrame(updateScrollFade);
    setTimeout(updateScrollFade, 60);
    commentsBox.appendChild(scroll);
    if (sorted.length > 5) {
      const viewAllBtn = el('button', {
        type: 'button',
        className: 'community-annotation-merged-comment-btn',
        text: `View all ${sorted.length} comments`,
        'aria-label':
          `View all ${sorted.length} comments for ` +
          `${toCleanString(suggestion?.label) || 'this suggestion'}`,
        'data-secondary-action': 'comments',
        'data-suggestion-id': toCleanString(suggestion?.id)
      });
      ownModalFocusKey(viewAllBtn, `${suggestionFocusPrefix}:comments`);
      viewAllBtn.addEventListener('click', () => {
        if (!isCurrent()) return;
        openSuggestionCommentsModal({
          session,
          fieldKey,
          catIdx,
          suggestion,
          canInteract,
          returnFocusTo: viewAllBtn
        });
      });
      commentsBox.appendChild(viewAllBtn);
    }
    card.appendChild(commentsBox);
  }

  if (!isCompact && allowModerationDrag && canModerate && suggestion?.id) {
    card.draggable = true;
    card.classList.add('community-annotation-moderation-draggable');
    card.title = 'Drag this suggestion onto another suggestion to merge (author-only).';
    card.addEventListener('dragstart', (e) => {
      if (!isCurrent()) return;
      if (!e.dataTransfer || typeof e.dataTransfer.setData !== 'function') {
        throw new TypeError('Suggestion merging requires an exact DataTransfer');
      }
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(
        'application/x-cellucid-suggestion-merge',
        JSON.stringify({ fieldKey, catIdx, suggestionId: suggestion.id, label: suggestion?.label || '' })
      );
      activeSuggestionMergeDrag = { fieldKey: toCleanString(fieldKey), catIdx: Number(catIdx), suggestionId: String(suggestion.id) };
    });
    card.addEventListener('dragend', () => {
      activeSuggestionMergeDrag = null;
    });
    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      card.classList.add('is-merge-target');
      if (!e.dataTransfer) {
        throw new TypeError('Suggestion merging requires an exact DataTransfer');
      }
      e.dataTransfer.dropEffect = 'move';
    });
    card.addEventListener('dragleave', () => card.classList.remove('is-merge-target'));
    card.addEventListener('drop', (e) => {
      if (!isCurrent()) return;
      e.preventDefault();
      card.classList.remove('is-merge-target');
      if (!e.dataTransfer || typeof e.dataTransfer.getData !== 'function') {
        throw new TypeError('Suggestion merging requires an exact DataTransfer');
      }
      const payload = JSON.parse(
        e.dataTransfer.getData('application/x-cellucid-suggestion-merge')
      );
      const fromId = toCleanString(payload?.suggestionId || '');
      const fromLabel = toCleanString(payload?.label || '');
      const intoId = toCleanString(suggestion?.id || '');
      const intoLabel = toCleanString(suggestion?.label || '');
      if (!fromId || !intoId || fromId === intoId) return;
      if (toCleanString(payload?.fieldKey || '') !== toCleanString(fieldKey) || Number(payload?.catIdx) !== Number(catIdx)) return;

      showOwnedConfirmDialog(lifecycle, {
        title: 'Merge suggestions?',
        tone: 'primary',
        message:
          `Merge "${fromLabel || fromId}" into "${intoLabel || intoId}"?\n\n` +
          `Votes will be combined (1 per user). Comments stay separate and can be reviewed via “View merged”.`,
        inputLabel: 'Optional merge note',
        inputPlaceholder: 'Why are these equivalent? (optional)',
        inputMaxLength: 512,
        confirmText: 'Merge',
        onConfirm: (note) => {
          try {
            if (!isCurrent()) return;
            const mergeNote = toCleanString(note || '');
            const ok = session.addModerationMerge({
              fieldKey,
              catIdx,
              fromSuggestionId: fromId,
              intoSuggestionId: intoId,
              note: mergeNote || null
            });
            if (!ok) throw new Error('Failed to merge suggestions');
            getNotificationCenter().success('Merged suggestions (local moderation)', { category: 'annotation', duration: 2400 });
          } catch (error) {
            getNotificationCenter().error(describeErrorMessage(error), {
              category: 'annotation'
            });
          }
        }
      });
    });
  }

  return card;
}

function buildVotingDetail({
  session,
  fieldKey,
  catIdx,
  lifecycle,
  viewState
}) {
  const panel = el('div', { className: 'community-annotation-voting-detail' });
  if (
    !lifecycle ||
    typeof lifecycle.isCurrent !== 'function' ||
    !lifecycle.signal
  ) {
    throw new TypeError(
      'Community voting detail requires an exact render lifecycle'
    );
  }
  if (!viewState || typeof viewState !== 'object' || Array.isArray(viewState)) {
    throw new TypeError('Community voting detail requires an exact view state');
  }
  const inlineEdits = requireInlineEditState(
    viewState.inlineEdits,
    'Community voting detail'
  );
  const isCurrent = () => (
    !lifecycle.signal.aborted &&
    lifecycle.isCurrent() &&
    panel.isConnected
  );

  // The bucket this panel is rendering. `catIdx` is a *position*, and the
  // session resolves it late against category registrations that
  // `ui/modules/legend/categorical-legend.js` and
  // `community-annotation/consensus-column.js` overwrite through
  // `setFieldCategories()` — a registration call that deliberately emits no
  // `changed` event, so nothing re-renders and nothing invalidates
  // `isCurrent()`. Every mutation that looks a suggestion up by id then fails
  // and says so, but creating one would succeed against whichever bucket the
  // position now names, filing a contributor's suggestion under a category
  // they never chose. Pin the bucket at render time and refuse instead.
  const renderedBucket = bucketKey(session, fieldKey, catIdx);
  const rendersCurrentBucket = () => (
    bucketKey(session, fieldKey, catIdx) === renderedBucket
  );

  const access = getCommunityAnnotationAccessStore();
  const isClosed = session.isFieldClosed?.(fieldKey) === true;
  const canInteract = !isClosed || access.isAuthor();
  if (isClosed && !access.isAuthor()) {
    panel.appendChild(el('div', { className: 'status-line', text: 'Closed by the author.' }));
  }

  const consensusSettings = session.getAnnotatableConsensusSettings?.(fieldKey) || null;
  const consensus = session.computeConsensus(fieldKey, catIdx, consensusSettings || undefined);
  const consensusLine = el('div', { className: `community-annotation-consensus status-${consensus.status}` });
  const label = consensus.label ? `"${consensus.label}"` : '—';
  consensusLine.textContent =
    consensus.status === 'consensus'
      ? `Consensus: ${label} (${formatPercent(consensus.confidence * 100)} • ${formatCountOf(consensus.voters, 'voter')})`
      : consensus.status === 'disputed'
        ? `Disputed: ${label} (${formatPercent(consensus.confidence * 100)} • ${formatCountOf(consensus.voters, 'voter')})`
        : `Pending (${formatCountOf(consensus.voters, 'voter')})`;
  panel.appendChild(consensusLine);

  const suggestions = session
    .getSuggestions(fieldKey, catIdx)
    .slice()
    .sort(
      (a, b) =>
        ((b.upvotes?.length || 0) - (b.downvotes?.length || 0)) - ((a.upvotes?.length || 0) - (a.downvotes?.length || 0))
    );
  if (suggestions.length > 200) {
    throw new Error('Community suggestions exceed the 200-item contract');
  }

  // Detect duplicate labels (multi-user/offline): votes/comments can be split across duplicate suggestions.
  const labelCounts = new Map();
  for (const s of suggestions) {
    const key = normalizeLabelForCompare(s?.label || '');
    if (!key) continue;
    labelCounts.set(key, (labelCounts.get(key) || 0) + 1);
  }
  const duplicateLabelKeys = new Set();
  for (const [k, count] of labelCounts.entries()) {
    if (count > 1) duplicateLabelKeys.add(k);
  }
  if (duplicateLabelKeys.size) {
    const dupSuggestionCount = suggestions.filter((s) => duplicateLabelKeys.has(normalizeLabelForCompare(s?.label || ''))).length;
    panel.appendChild(el('div', {
      className: 'status-line',
      text: access.isAuthor()
        ? `${dupSuggestionCount} duplicate labels: Merge… combines them.`
        : `${dupSuggestionCount} duplicate labels: votes may be split.`
    }));
  }

  const suggestionPageSize = 25;
  const suggestionPageCount = Math.max(
    1,
    Math.ceil(suggestions.length / suggestionPageSize)
  );
  if (!Number.isSafeInteger(viewState.suggestionPage)) {
    viewState.suggestionPage = 0;
  }
  // Votes reorder the list. Keep the page that holds an open inline edit on
  // screen so a rebuild never pages the viewer's editor away.
  const editedAnchors = inlineEdits.anchorIds();
  const editedIndex = suggestions.findIndex(
    s => editedAnchors.has(toCleanString(s?.id))
  );
  if (editedIndex >= 0) {
    viewState.suggestionPage = Math.floor(editedIndex / suggestionPageSize);
  }
  viewState.suggestionPage = Math.max(
    0,
    Math.min(viewState.suggestionPage, suggestionPageCount - 1)
  );
  const list = el('div', {
    className: 'community-annotation-suggestions',
    role: 'list'
  });
  const suggestionPageStatus = el('div', {
    className: 'community-annotation-page-status',
    role: 'status'
  });
  const previousSuggestionPage = el('button', {
    type: 'button',
    className: 'btn',
    text: 'Previous suggestions'
  });
  const nextSuggestionPage = el('button', {
    type: 'button',
    className: 'btn',
    text: 'Next suggestions'
  });
  const renderSuggestionPage = () => inlineEdits.rebuild(() => {
    list.innerHTML = '';
    const page = viewState.suggestionPage;
    const start = page * suggestionPageSize;
    const shown = suggestions.slice(start, start + suggestionPageSize);
    if (!shown.length) {
      list.appendChild(el('div', {
        className: 'empty-state',
        text: 'No suggestions yet.'
      }));
    } else {
      for (const suggestion of shown) {
        const card = renderSuggestionCard({
          session,
          fieldKey,
          catIdx,
          suggestion,
          inlineEdits,
          mergeTargets: suggestions,
          lifecycle,
          canInteract,
          duplicateLabelKeys
        });
        card.setAttribute('role', 'listitem');
        list.appendChild(card);
      }
    }
    suggestionPageStatus.textContent =
      `Page ${page + 1} of ${suggestionPageCount} · ` +
      `${suggestions.length} suggestion${suggestions.length === 1 ? '' : 's'}`;
    previousSuggestionPage.disabled = page === 0;
    nextSuggestionPage.disabled = page >= suggestionPageCount - 1;
  });
  previousSuggestionPage.addEventListener('click', () => {
    if (!isCurrent() || viewState.suggestionPage === 0) return;
    viewState.suggestionPage -= 1;
    renderSuggestionPage();
    focusEnabledPaginationControl(
      previousSuggestionPage,
      nextSuggestionPage
    );
    list.scrollIntoView?.({ block: 'nearest' });
  });
  nextSuggestionPage.addEventListener('click', () => {
    if (
      !isCurrent() ||
      viewState.suggestionPage >= suggestionPageCount - 1
    ) {
      return;
    }
    viewState.suggestionPage += 1;
    renderSuggestionPage();
    focusEnabledPaginationControl(
      nextSuggestionPage,
      previousSuggestionPage
    );
    list.scrollIntoView?.({ block: 'nearest' });
  });
  renderSuggestionPage();
  panel.appendChild(list);
  if (suggestions.length > suggestionPageSize) {
    const suggestionPageControls = el('div', {
      className: 'community-annotation-page-controls'
    });
    suggestionPageControls.appendChild(previousSuggestionPage);
    suggestionPageControls.appendChild(suggestionPageStatus);
    suggestionPageControls.appendChild(nextSuggestionPage);
    panel.appendChild(suggestionPageControls);
  } else {
    panel.appendChild(suggestionPageStatus);
  }

  const formBox = el('div', { className: 'control-box' });
  formBox.appendChild(el('div', { className: 'community-annotation-new-title', text: 'New suggestion' }));
  if (!canInteract) {
    formBox.appendChild(el('div', { className: 'status-line', text: 'Closed by the author.' }));
  }

  const form = el('div', { className: 'community-annotation-new community-annotation-new-vertical' });
  const newSuggestionFocusPrefix = createModalFocusKey(
    'new-suggestion',
    fieldKey,
    catIdx
  );

  const labelRow = el('div', { className: 'community-annotation-label-row' });
  const labelInput = el('input', { type: 'text', className: 'obs-select', 'aria-label': 'Label', placeholder: 'Label (required)', maxlength: '120', disabled: !canInteract });
  const searchCapBtn = el('button', {
    type: 'button',
    className: 'btn btn-compact cap-btn',
    text: 'Search CAP',
    title: 'Search Cell Annotation Platform for cell types',
    disabled: !canInteract,
    'aria-expanded': 'false'
  });
  ownModalDraft(ownModalFocusKey(labelInput, `${newSuggestionFocusPrefix}:label`));
  ownModalFocusKey(searchCapBtn, `${newSuggestionFocusPrefix}:search-name`);

  labelRow.appendChild(labelInput);
  labelRow.appendChild(searchCapBtn);

  const ontRow = el('div', { className: 'community-annotation-label-row' });
  const ontInput = el('input', { type: 'text', className: 'obs-select', 'aria-label': 'Ontology id', placeholder: 'Ontology id (optional)', title: 'Ontology id, such as CL:0000625', maxlength: '64', disabled: !canInteract });
  const searchOntBtn = el('button', {
    type: 'button',
    className: 'btn btn-compact cap-btn',
    text: 'Search ontology',
    title: 'Search CAP by ontology ID',
    disabled: !canInteract,
    'aria-expanded': 'false'
  });
  ownModalDraft(ownModalFocusKey(ontInput, `${newSuggestionFocusPrefix}:ontology`));
  ownModalFocusKey(
    searchOntBtn,
    `${newSuggestionFocusPrefix}:search-ontology`
  );

  ontRow.appendChild(ontInput);
  ontRow.appendChild(searchOntBtn);

  const markerGenesRow = el('div', { className: 'community-annotation-label-row' });
  const markerGenesInput = el('input', { type: 'text', className: 'obs-select', 'aria-label': 'Marker genes', placeholder: 'Marker genes (optional)', title: 'Marker genes, separated by commas', disabled: !canInteract });
  const searchMarkersBtn = el('button', {
    type: 'button',
    className: 'btn btn-compact cap-btn',
    text: 'Search markers',
    title: 'Search CAP by marker genes',
    disabled: !canInteract,
    'aria-expanded': 'false'
  });
  ownModalDraft(ownModalFocusKey(
    markerGenesInput,
    `${newSuggestionFocusPrefix}:markers`
  ));
  ownModalFocusKey(
    searchMarkersBtn,
    `${newSuggestionFocusPrefix}:search-markers`
  );

  markerGenesRow.appendChild(markerGenesInput);
  markerGenesRow.appendChild(searchMarkersBtn);

  const evidenceInput = el('textarea', { className: 'obs-select community-annotation-textarea', 'aria-label': 'Evidence', placeholder: 'Evidence (optional)', maxlength: '2000', disabled: !canInteract });
  ownModalDraft(ownModalFocusKey(evidenceInput, `${newSuggestionFocusPrefix}:evidence`));
  const capStatus = el('div', {
    className: 'cap-import-status',
    role: 'status',
    'aria-live': 'polite'
  });

  const searchButtons = [
    { button: searchCapBtn, idleText: 'Search CAP' },
    { button: searchOntBtn, idleText: 'Search ontology' },
    { button: searchMarkersBtn, idleText: 'Search markers' }
  ];
  let searchGeneration = 0;
  let activeSearchController = null;
  let activeSearchPanel = null;
  let activeSearchButton = null;

  const setSearchBusy = (busy, ownerButton = null) => {
    formBox.setAttribute('aria-busy', busy ? 'true' : 'false');
    for (const entry of searchButtons) {
      entry.button.disabled = !canInteract || busy;
      entry.button.textContent =
        busy && entry.button === ownerButton
          ? 'Searching…'
          : entry.idleText;
    }
  };
  const removeSearchPanel = () => {
    if (activeSearchPanel !== null) {
      activeSearchPanel.remove();
      activeSearchPanel = null;
    }
    if (activeSearchButton !== null) {
      activeSearchButton.setAttribute('aria-expanded', 'false');
      activeSearchButton.removeAttribute('aria-controls');
      activeSearchButton = null;
    }
  };
  const invalidateCapSearch = () => {
    searchGeneration += 1;
    if (
      activeSearchController !== null &&
      !activeSearchController.signal.aborted
    ) {
      const reason = new Error('CAP form search was superseded');
      reason.name = 'AbortError';
      activeSearchController.abort(reason);
    }
    activeSearchController = null;
    removeSearchPanel();
    setSearchBusy(false);
  };
  lifecycle.signal.addEventListener('abort', invalidateCapSearch, {
    once: true
  });

  const applyCapResult = (result) => {
    if (!isCurrent()) {
      const error = new Error('CAP result belongs to a retired form');
      error.name = 'AbortError';
      throw error;
    }
    const labelCandidates = [
      ['full CAP name', toCleanString(result?.fullName)],
      ['ontology term', toCleanString(result?.ontologyTerm)],
      ['short CAP name', toCleanString(result?.name)]
    ].filter(([, value]) => value);
    const selectedLabel = labelCandidates.find(
      ([, value]) => !exceedsCodePointLimit(value, 120)
    ) ?? null;
    const nextLabel = selectedLabel?.[1] ?? '';
    const nextOntologyId = toCleanString(result?.ontologyTermId);
    if (!nextLabel) {
      throw new Error(
        'Every label for this CAP result exceeds the 120-character suggestion limit'
      );
    }
    if (exceedsCodePointLimit(nextOntologyId, 64)) {
      throw new Error(
        'This CAP ontology ID exceeds the 64-character suggestion limit'
      );
    }
    const markerMerge = mergeCapMarkerGenes(
      markerGenesInput.value,
      [
        ...result.canonicalMarkerGenes,
        ...result.markerGenes
      ]
    );

    labelInput.value = nextLabel;
    ontInput.value = nextOntologyId;
    markerGenesInput.value = markerMerge.text;
    const parts = [
      `Added ${markerMerge.addedGenes.length} CAP marker` +
        `${markerMerge.addedGenes.length === 1 ? '' : 's'}.`
    ];
    if (selectedLabel !== labelCandidates[0]) {
      parts.push(
        `Used the ${selectedLabel[0]} because earlier CAP label ` +
        `candidates exceed 120 characters.`
      );
    }
    if (markerMerge.duplicateGenes.length) {
      parts.push(
        `${markerMerge.duplicateGenes.length} duplicate CAP marker` +
        `${markerMerge.duplicateGenes.length === 1 ? '' : 's'}: ` +
        `${markerMerge.duplicateGenes.join(', ')}.`
      );
    }
    if (markerMerge.omittedGenes.length) {
      parts.push(
        `${markerMerge.omittedGenes.length} CAP marker` +
        `${markerMerge.omittedGenes.length === 1 ? '' : 's'} omitted at ` +
        `the 50-marker limit: ` +
        `${markerMerge.omittedGenes.join(', ')}.`
      );
    }
    capStatus.textContent = parts.join(' ');
  };

  const runCapSearch = async ({
    button,
    failureLabel,
    request
  }) => {
    if (!isCurrent()) return;
    invalidateCapSearch();
    const generation = ++searchGeneration;
    const controller = new AbortController();
    activeSearchController = controller;
    const relayLifecycleAbort = () => {
      if (!controller.signal.aborted) {
        controller.abort(lifecycle.signal.reason);
      }
    };
    if (lifecycle.signal.aborted) relayLifecycleAbort();
    else {
      lifecycle.signal.addEventListener('abort', relayLifecycleAbort, {
        once: true
      });
    }
    setSearchBusy(true, button);
    try {
      const envelope = await request(controller.signal);
      if (
        controller.signal.aborted ||
        generation !== searchGeneration ||
        activeSearchController !== controller ||
        !isCurrent()
      ) {
        return;
      }
      const resultPanelId = createDomId('cap-search-results');
      activeSearchPanel = renderCapSearchResults({
        results: envelope.results,
        omittedInvalidCount: envelope.omittedInvalidCount,
        onSelect: applyCapResult,
        onClose: invalidateCapSearch,
        returnFocusTo: button
      });
      activeSearchPanel.id = resultPanelId;
      activeSearchButton = button;
      button.setAttribute('aria-controls', resultPanelId);
      button.setAttribute('aria-expanded', 'true');
      // The results open under the row whose search produced them, not at
      // the end of the form below Add and Clear.
      const triggerRow = button.closest('.community-annotation-label-row');
      if (triggerRow === null) {
        throw new Error('A CAP search button must sit in its field row');
      }
      triggerRow.after(activeSearchPanel);
    } catch (error) {
      if (
        controller.signal.aborted ||
        generation !== searchGeneration ||
        activeSearchController !== controller ||
        !isCurrent()
      ) {
        return;
      }
      getNotificationCenter().error(
        `${failureLabel}: ${describeErrorMessage(error)}`,
        { category: 'annotation' }
      );
    } finally {
      lifecycle.signal.removeEventListener(
        'abort',
        relayLifecycleAbort
      );
      if (
        generation === searchGeneration &&
        activeSearchController === controller
      ) {
        activeSearchController = null;
        if (isCurrent()) setSearchBusy(false);
      }
    }
  };

  searchCapBtn.addEventListener('click', () => {
    const searchTerm = toCleanString(labelInput.value);
    if (!searchTerm) {
      getNotificationCenter().info('Enter a cell type name to search', {
        category: 'annotation',
        duration: 2000
      });
      labelInput.focus();
      return;
    }
    void runCapSearch({
      button: searchCapBtn,
      failureLabel: 'CAP search failed',
      request: (signal) => capApi.searchCellTypes(
        searchTerm,
        capApi.CAP_LOOKUP_LIMIT,
        { kind: 'name', signal }
      )
    });
  });

  searchOntBtn.addEventListener('click', () => {
    const searchTerm = toCleanString(ontInput.value);
    if (!searchTerm) {
      getNotificationCenter().info('Enter an ontology ID to search', {
        category: 'annotation',
        duration: 2000
      });
      ontInput.focus();
      return;
    }
    void runCapSearch({
      button: searchOntBtn,
      failureLabel: 'CAP ontology search failed',
      request: (signal) => capApi.lookupByOntologyId(
        searchTerm,
        { signal }
      )
    });
  });

  searchMarkersBtn.addEventListener('click', () => {
    let markers;
    try {
      markers = parseMarkerGenesInput(markerGenesInput.value);
    } catch (error) {
      getNotificationCenter().error(describeErrorMessage(error), {
        category: 'annotation'
      });
      return;
    }
    if (!markers?.length) {
      getNotificationCenter().info('Enter marker gene(s) to search', {
        category: 'annotation',
        duration: 2000
      });
      markerGenesInput.focus();
      return;
    }
    const markerSignature = markers
      .slice()
      .sort(compareCodeUnitText)
      .join(',');
    void runCapSearch({
      button: searchMarkersBtn,
      failureLabel: 'CAP marker search failed',
      request: (signal) => capApi.searchCellTypes(
        markerSignature,
        capApi.CAP_LOOKUP_LIMIT,
        { kind: 'marker', markerGenes: markers, signal }
      )
    });
  });

  for (const input of [labelInput, ontInput, markerGenesInput]) {
    input.addEventListener('input', () => {
      if (!isCurrent()) return;
      invalidateCapSearch();
      capStatus.textContent = '';
    });
  }

  const actions = el('div', { className: 'community-annotation-suggestion-actions' });
  const addBtn = el('button', { type: 'button', className: 'btn', text: 'Add', disabled: !canInteract });
  const clearBtn = el('button', { type: 'button', className: 'btn', text: 'Clear', disabled: !canInteract });
  ownModalFocusKey(addBtn, `${newSuggestionFocusPrefix}:add`);
  ownModalFocusKey(clearBtn, `${newSuggestionFocusPrefix}:clear`);
  actions.appendChild(addBtn);
  actions.appendChild(clearBtn);

  if (canInteract) {
    addBtn.addEventListener('click', () => {
      try {
        if (!isCurrent()) return;
        focusRenderedModalTarget(addBtn);
        if (!rendersCurrentBucket()) {
          getNotificationCenter().error(
            'Suggestion not added: the categories of this field changed while ' +
            'the panel was open, so this panel no longer names the same ' +
            'cluster. Close and reopen community voting, then add it again.',
            { category: 'annotation' }
          );
          return;
        }
        const markers = parseMarkerGenesInput(markerGenesInput.value);
        session.addSuggestion(fieldKey, catIdx, { label: labelInput.value, ontologyId: ontInput.value, evidence: evidenceInput.value, markers });
        invalidateCapSearch();
        labelInput.value = '';
        ontInput.value = '';
        markerGenesInput.value = '';
        evidenceInput.value = '';
        capStatus.textContent = '';
      } catch (err) {
        getNotificationCenter().error(describeErrorMessage(err), { category: 'annotation' });
      }
    });
  }
  clearBtn.addEventListener('click', () => {
    if (!canInteract || !isCurrent()) return;
    invalidateCapSearch();
    labelInput.value = '';
    ontInput.value = '';
    markerGenesInput.value = '';
    evidenceInput.value = '';
    capStatus.textContent = '';
  });

  form.appendChild(labelRow);
  form.appendChild(ontRow);
  form.appendChild(markerGenesRow);
  form.appendChild(evidenceInput);
  form.appendChild(capStatus);
  form.appendChild(actions);
  formBox.appendChild(form);
  panel.appendChild(formBox);

  return panel;
}

export function openCommunityAnnotationVotingModal({
  state,
  defaultFieldKey = null,
  defaultCatIdx = null,
  returnFocusTo = null,
  returnFocusResolver = null
} = {}) {
  if (!state) return null;

  const focusField = toCleanString(defaultFieldKey) || null;
  const focusCatIdx = Number.isInteger(defaultCatIdx) && defaultCatIdx >= 0 ? defaultCatIdx : null;

  if (!focusField || focusCatIdx == null) {
    getNotificationCenter().error('No category selected for voting', { category: 'annotation' });
    return null;
  }

  const session = getCommunityAnnotationSession();
  if (typeof session.getDatasetId !== 'function') {
    throw new TypeError('Community voting requires session.getDatasetId()');
  }
  const datasetId = session.getDatasetId();
  const ctx = syncCommunityAnnotationCacheContext({ datasetId });
  // Hide the entire voting UX unless a repo is connected (or dev simulate is enabled).
  if (!isAnnotationRepoConnected(ctx.datasetId, ctx.userKey)) return null;
  const contextLease = createCommunityAnnotationVotingContextLease(ctx);

  /** @type {{close?: Function, overlay?: HTMLElement, modal?: HTMLElement, content?: HTMLElement} | null} */
  let ref = null;
  let retireModalLifecycle = null;
  ref = showModal({
    title: 'Community voting',
    returnFocusTo,
    returnFocusResolver,
    onClose: () => {
      if (retireModalLifecycle !== null) retireModalLifecycle();
    },
    buildContent: (content) => {
      const status = el('p', { className: 'status-line', 'aria-live': 'polite', text: '' });
      content.appendChild(status);

      let cleaned = false;
      let observer = null;
      let unsubscribeChanged = null;
      let unsubscribeContextChanged = null;
      let renderVersion = 0;
      let retireActiveDetail = null;
      /** @type {{suggestionPage: number, drafts: Map<string, string>, inlineEdits: InlineEditState}} */
      const viewState = {
        suggestionPage: 0,
        drafts: new Map(),
        inlineEdits: new InlineEditState()
      };

      const cleanupModalLifecycle = () => {
        if (cleaned) return;
        cleaned = true;
        renderVersion += 1;
        runExactCleanup('Community voting owned lifecycle teardown', [
          ['active voting detail', retireActiveDetail],
          ['field-load and DOM event lifecycle', contextLease.retire],
          ['session change subscription', unsubscribeChanged],
          ['session context subscription', unsubscribeContextChanged],
          [
            'modal observer',
            observer === null
              ? null
              : () => observer.disconnect()
          ]
        ]);
        unsubscribeChanged = null;
        unsubscribeContextChanged = null;
        observer = null;
        retireActiveDetail = null;
      };
      retireModalLifecycle = cleanupModalLifecycle;

      const closeForRetiredContext = () => {
        if (cleaned) return;
        if (ref !== null && typeof ref.close === 'function') {
          ref.close();
          return;
        }
        cleanupModalLifecycle();
      };
      const retainsModalContext = () => {
        if (cleaned || contextLease.signal.aborted) return false;
        const currentDatasetId = session.getDatasetId();
        const current = getCommunityAnnotationCacheContext({
          datasetId: currentDatasetId
        });
        if (
          !contextLease.isCurrent(current) ||
          !isAnnotationRepoConnected(current.datasetId, current.userKey)
        ) {
          closeForRetiredContext();
          return false;
        }
        return true;
      };

      const autoScrollMargin = 48;
      const autoScrollMaxPx = 28;
      const autoScrollMinPx = 6;
      const dragAutoScroll = (clientY) => {
        if (!activeSuggestionMergeDrag) return;
        if (!getCommunityAnnotationAccessStore().isAuthor()) return;
        if (!Number.isFinite(clientY)) return;
        if (content.scrollHeight <= content.clientHeight) return;
        const rect = content.getBoundingClientRect();
        if (!rect || !Number.isFinite(rect.top) || !Number.isFinite(rect.bottom)) {
          throw new TypeError('Community voting drag scrolling requires exact bounds');
        }
        const topZone = rect.top + autoScrollMargin;
        const bottomZone = rect.bottom - autoScrollMargin;
        let delta = 0;
        if (clientY < topZone) {
          const t = Math.min(1, Math.max(0, (topZone - clientY) / autoScrollMargin));
          delta = -Math.ceil(autoScrollMinPx + t * (autoScrollMaxPx - autoScrollMinPx));
        } else if (clientY > bottomZone) {
          const t = Math.min(1, Math.max(0, (clientY - bottomZone) / autoScrollMargin));
          delta = Math.ceil(autoScrollMinPx + t * (autoScrollMaxPx - autoScrollMinPx));
        }
        if (delta) content.scrollTop += delta;
      };
      if (typeof requestAnimationFrame !== 'function') {
        throw new TypeError('Community voting drag scrolling requires requestAnimationFrame()');
      }
      let latestY = null;
      let rafPending = false;
      const onDragOver = (e) => {
        latestY = e.clientY;
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => {
          try {
            dragAutoScroll(latestY);
          } finally {
            rafPending = false;
          }
        });
      };
      const onDropOrLeave = () => {
        latestY = null;
      };
      content.addEventListener('dragover', onDragOver, { signal: contextLease.signal });
      content.addEventListener('drop', onDropOrLeave, { signal: contextLease.signal });
      content.addEventListener('dragleave', onDropOrLeave, { signal: contextLease.signal });

      let isFirstRender = true;
      const replaceContentWithStatus = (message) => {
        const focusSnapshot = captureModalRerenderFocus(content);
        captureModalDrafts(content, viewState.drafts);
        content.innerHTML = '';
        content.appendChild(status);
        status.textContent = message;
        restoreModalRerenderFocus(
          focusSnapshot,
          content,
          resolvePrimaryModalCloseButton()
        );
      };
      const renderFocused = async () => {
        const myVersion = ++renderVersion;
        if (retireActiveDetail !== null) {
          retireActiveDetail();
          retireActiveDetail = null;
        }
        if (!retainsModalContext()) return;

        // Only show loading state on first render - subsequent renders keep old content visible
        if (isFirstRender) {
          content.innerHTML = '';
          content.appendChild(status);
          status.textContent = 'Loading…';
        }

        const fields = state.getFields?.() || [];
        const fieldIndex = fields.findIndex((f) => f && f._isDeleted !== true && f.kind === 'category' && toCleanString(f.key) === focusField);
        if (fieldIndex < 0) {
          replaceContentWithStatus('Field not found in current dataset.');
          return;
        }
        const fieldOwner = fields[fieldIndex];
        try {
          await state.ensureFieldLoaded?.(fieldIndex, {
            signal: contextLease.signal,
            silent: true
          });
        } catch (err) {
          if (
            contextLease.signal.aborted ||
            myVersion !== renderVersion ||
            !retainsModalContext()
          ) {
            return;
          }
          replaceContentWithStatus(describeErrorMessage(err));
          return;
        }

        // Bail if a newer render started while we were loading
        if (
          contextLease.signal.aborted ||
          myVersion !== renderVersion ||
          !retainsModalContext()
        ) {
          return;
        }

        isFirstRender = false;

        const field = state.getFields?.()?.[fieldIndex] || null;
        if (field !== fieldOwner) return;
        const categories = Array.isArray(field?.categories) ? field.categories : [];
        if (focusCatIdx >= categories.length) {
          replaceContentWithStatus(
            'Category not found in current dataset.'
          );
          return;
        }
        if (typeof session.setFieldCategories !== 'function') {
          throw new TypeError('Community voting requires session.setFieldCategories()');
        }
        if (!retainsModalContext()) return;
        session.setFieldCategories(focusField, categories);
        if (
          myVersion !== renderVersion ||
          !retainsModalContext()
        ) {
          return;
        }
        const catLabel = String(categories[focusCatIdx]);

        // Build new content then swap atomically to avoid flashing
        const detailController = new AbortController();
        const retireDetail = () => {
          contextLease.signal.removeEventListener(
            'abort',
            retireDetail
          );
          if (!detailController.signal.aborted) {
            detailController.abort(contextLease.signal.reason);
          }
        };
        if (contextLease.signal.aborted) retireDetail();
        else {
          contextLease.signal.addEventListener('abort', retireDetail, {
            once: true
          });
        }
        const detailLifecycle = {
          signal: detailController.signal,
          isCurrent: () => (
            !cleaned &&
            !detailController.signal.aborted &&
            myVersion === renderVersion &&
            retainsModalContext()
          )
        };
        const newContent = document.createDocumentFragment();
        viewState.inlineEdits.beginRebuild();
        try {
          newContent.appendChild(el('div', { className: 'community-annotation-inline-help', text: `${focusField} • ${catLabel}` }));
          newContent.appendChild(buildVotingDetail({
            session,
            fieldKey: focusField,
            catIdx: focusCatIdx,
            lifecycle: detailLifecycle,
            viewState
          }));
        } catch (error) {
          viewState.inlineEdits.cancelRebuild();
          retireDetail();
          throw error;
        }
        if (
          detailController.signal.aborted ||
          myVersion !== renderVersion ||
          !retainsModalContext()
        ) {
          viewState.inlineEdits.cancelRebuild();
          retireDetail();
          return;
        }

        const focusSnapshot = captureModalRerenderFocus(content);
        captureModalDrafts(content, viewState.drafts);
        retireActiveDetail = retireDetail;
        content.innerHTML = '';
        content.appendChild(newContent);
        viewState.inlineEdits.finishRebuild();
        restoreModalDrafts(content, viewState.drafts);
        restoreModalRerenderFocus(
          focusSnapshot,
          content,
          resolvePrimaryModalCloseButton()
        );
      };

      const requestFocusedRender = () => {
        void renderFocused().catch((error) => {
          if (
            cleaned ||
            contextLease.signal.aborted ||
            !retainsModalContext()
          ) {
            return;
          }
          const message = describeErrorMessage(error);
          replaceContentWithStatus(message);
          getNotificationCenter().error(message, {
            category: 'annotation'
          });
        });
      };

      if (typeof session.on !== 'function') {
        throw new TypeError('Community voting requires session.on()');
      }
      unsubscribeChanged = session.on('changed', () => {
        if (retainsModalContext()) requestFocusedRender();
      });
      if (typeof unsubscribeChanged !== 'function') {
        throw new TypeError('Community voting subscription must return an unsubscribe function');
      }
      unsubscribeContextChanged = session.on('context:changed', () => {
        retainsModalContext();
      });
      if (typeof unsubscribeContextChanged !== 'function') {
        throw new TypeError(
          'Community voting context subscription must return an unsubscribe function'
        );
      }

      requestFocusedRender();

      // The content leaves the document only with its overlay, a child of
      // <body>, so watching <body>'s own children is enough.
      observer = new MutationObserver(() => {
        if (!document.body.contains(content)) {
          cleanupModalLifecycle();
        }
      });
      observer.observe(document.body, { childList: true });

      if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
        throw new TypeError('Community voting requires window.addEventListener()');
      }
      window.addEventListener(
        ANNOTATION_CONNECTION_CHANGED_EVENT,
        retainsModalContext,
        { signal: contextLease.signal }
      );
    }
  });

  return ref;
}
