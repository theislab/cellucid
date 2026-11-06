/**
 * @fileoverview Searching a tracker's steps (History v2 §3.13 "Search and
 * filter", `history.search`): words in a step's label, its parameters, its
 * notes and its bookmark (any case, every word), and filters by who took it,
 * what its action changes, the domain it changed, notes, bookmarks, flags,
 * and a time range. One pass over the steps; the State panel's search box
 * and an agent's read apply the same rule (`stepMatches`). Pure.
 *
 * @module app/history/search
 */

import { idNumber } from './model.js';

/** Who took a step, as the search names it (`person`, `agent`, `python`, `r`, `replay`, `outside`, or another origin). */
export function searchByOf(step) {
  const by = step.kind === 'squashed' ? step.squashed.by : [step.by];
  return by.map(each => {
    if (each.origin === 'user') return 'person';
    if (each.origin === 'host') return each.host ?? 'host';
    return each.origin;
  });
}

/** What a step's action changes, as the search names it: its catalogue effect (`state`, `view`, `layout`), or `state`. */
export function searchKindOf(step, effectOf) {
  if (step.type !== null && step.type !== undefined) {
    const effect = effectOf(step.type);
    if (effect === 'view' || effect === 'layout') return effect;
  }
  return 'state';
}

function textOf(step) {
  const parts = [step.label, step.bookmark ?? '', ...(step.squashed?.carried.bookmarks ?? []), step.code ?? '', ...step.notes.map(note => note.text)];
  if (step.params !== null) {
    try { parts.push(JSON.stringify(step.params)); } catch { /* parameters are JSON */ }
  }
  return parts.join('\n').toLowerCase();
}

/** The words of a search text, lower-cased (none: every step's text matches). */
export function searchWords(text) {
  return (text ?? '').toLowerCase().split(/\s+/u).filter(word => word.length > 0);
}

/**
 * Whether one step matches: the one rule `searchSteps` and the State panel's
 * search box apply.
 *
 * @param {object} step - live
 * @param {{text?: string, by?: string, kind?: string, step_kind?: string, domain?: string, has_note?: boolean, bookmarked?: boolean,
 *   flagged?: boolean, from?: number, to?: number}} criteria - `from`, `to`: a time range (ms), its ends included
 * @param {{effectOf?: (type: string) => (string|null), isStale?: (stepId: string) => boolean, words?: string[]}} [context] -
 *   `words`: `searchWords(criteria.text)`, worked out once for many steps
 */
export function stepMatches(step, criteria, { effectOf = () => null, isStale = () => false, words = searchWords(criteria.text) } = {}) {
  if (criteria.by !== undefined && !searchByOf(step).includes(criteria.by)) return false;
  if (criteria.kind !== undefined && (step.parent === null || searchKindOf(step, effectOf) !== criteria.kind)) return false;
  if (criteria.step_kind !== undefined && step.kind !== criteria.step_kind) return false;
  if (criteria.domain !== undefined && !step.touches.includes(criteria.domain)) return false;
  if (criteria.has_note !== undefined && (step.notes.length > 0) !== criteria.has_note) return false;
  const marked = step.bookmark !== null || (step.squashed?.carried.bookmarks.length ?? 0) > 0;
  if (criteria.bookmarked !== undefined && marked !== criteria.bookmarked) return false;
  if (criteria.flagged !== undefined && (step.status === 'unapplicable' || isStale(step.id)) !== criteria.flagged) return false;
  if (criteria.from !== undefined && (step.at === null || (step.until ?? step.at) < criteria.from)) return false;
  if (criteria.to !== undefined && (step.at === null || step.at > criteria.to)) return false;
  if (words.length > 0) {
    const text = textOf(step);
    if (!words.every(word => text.includes(word))) return false;
  }
  return true;
}

/**
 * The steps of `tracker` that match, in step order.
 *
 * @param {object} tracker - live
 * @param {object} criteria - `stepMatches`
 * @param {{catalog?: object, isStale?: (stepId: string) => boolean}} [context]
 * @returns {string[]}
 */
export function searchSteps(tracker, criteria, { catalog = null, isStale = () => false } = {}) {
  const words = searchWords(criteria.text);
  const effectOf = type => (catalog?.has?.(type) ? catalog.get(type).effect : null);
  const out = [];
  for (const step of tracker.steps.values()) {
    if (stepMatches(step, criteria, { effectOf, isStale, words })) out.push(step.id);
  }
  return out.sort((a, b) => idNumber(a) - idNumber(b));
}
