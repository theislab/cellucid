/**
 * @fileoverview What the State panel says of a history, as plain data: how
 * long ago, who acted (with the agent's model), a flagged step's flag, a
 * graph row's words and accessible name, the status line, and the plan of a
 * guided tour. Pure (importable in Node); the panel's modules draw from it.
 * The rows themselves are `graph-layout.js`'s.
 *
 * Steps are History v2 records (`app/history/model.js`): who took one is its
 * `by` (`{origin, agent, model, host, person, turn}`).
 *
 * @module ui/modules/state/model
 */

import { OUTSIDE_CHANGE_TYPE, originOf } from '../../../history/exports/step-text.js';
import { countNoun, formatCount, formatCountOf } from '../../../../utils/format-units.js';
import { idNumber } from '../../../history/model.js';

/**
 * The keys of the history's graph (History v2 §3.9, §3.13), as the History
 * (i) tip lists them: one table, so the tip and the keys cannot drift.
 */
export const GRAPH_SHORTCUTS = Object.freeze([
  ['↑ ↓', 'move between rows (Shift: select several)'],
  ['→ ←', 'open or close a branch, turn, group or run'],
  ['Enter or double-click', 'show the step'],
  ['Space or ›', 'open its details'],
  ['Alt+↑ ↓', 'show the step before or after'],
  ['F2', 'rename'],
  ['Delete', 'delete (asks first)'],
  ['Shift+F10', 'the row’s menu'],
  ['[ ]', 'the previous or next fork'],
  ['Ctrl/⌘+G', 'group the steps selected'],
  ['Ctrl/⌘+Shift+B', 'branch from the step selected'],
  ['/', 'search'],
  ['Ctrl/⌘+Z, Ctrl/⌘+Shift+Z', 'undo, redo'],
]);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long ago `at` was, short for a row ("now", "4 min", "2 h", "3 d", then
 * the date) and long for a screen reader and a tooltip.
 *
 * @param {number} at - Milliseconds since the epoch
 * @param {number} now
 * @param {string} [locale]
 * @returns {{short: string, long: string}}
 */
export function formatAgo(at, now, locale = undefined) {
  if (at === null || at === undefined) return { short: '', long: 'at a time not kept' };
  const elapsed = Math.max(0, now - at);
  if (elapsed < 45_000) return { short: 'now', long: 'just now' };
  if (elapsed < HOUR) {
    const n = Math.max(1, Math.round(elapsed / MINUTE));
    return { short: `${n} min`, long: `${n} ${countNoun(n, 'minute')} ago` };
  }
  if (elapsed < DAY) {
    const n = Math.round(elapsed / HOUR);
    return { short: `${n} h`, long: `${n} ${countNoun(n, 'hour')} ago` };
  }
  if (elapsed < 7 * DAY) {
    const n = Math.round(elapsed / DAY);
    return { short: `${n} d`, long: `${n} ${countNoun(n, 'day')} ago` };
  }
  const date = new Date(at);
  return {
    short: formatterOf(locale, 'day').format(date),
    long: `on ${formatterOf(locale, 'longDate').format(date)}`,
  };
}

/**
 * When a step was taken, as short as is clear: the time today, the day and
 * time this year, the date before.
 *
 * @param {number} at
 * @param {number} now
 * @param {string} [locale]
 */
export function formatStepTime(at, now, locale = undefined) {
  if (at === null || at === undefined) return 'Time not kept';
  const date = new Date(at);
  const today = new Date(now);
  const time = formatterOf(locale, 'time').format(date);
  if (date.toDateString() === today.toDateString()) return time;
  if (date.getFullYear() === today.getFullYear()) return `${formatterOf(locale, 'day').format(date)}, ${time}`;
  return formatterOf(locale, 'date').format(date);
}

const FORMATS = Object.freeze({
  time: { hour: '2-digit', minute: '2-digit' },
  day: { day: 'numeric', month: 'short' },
  date: { day: 'numeric', month: 'short', year: 'numeric' },
  longDate: { day: 'numeric', month: 'long', year: 'numeric' },
});
/** One `Intl.DateTimeFormat` per locale and format: making one per row is what costs. */
const FORMATTERS = new Map();
function formatterOf(locale, name) {
  const key = `${locale ?? ''}|${name}`;
  let formatter = FORMATTERS.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(locale, FORMATS[name]);
    FORMATTERS.set(key, formatter);
  }
  return formatter;
}

/**
 * An agent's model as people say it: `claude-sonnet-4-6` → "Sonnet 4.6",
 * `claude-opus-4-1-20250805` → "Opus 4.1"; any other model as it is named.
 * @param {string|null} model
 */
export function modelName(model) {
  if (typeof model !== 'string' || model.length === 0) return null;
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(model);
  if (claude !== null) {
    const family = claude[1].charAt(0).toUpperCase() + claude[1].slice(1);
    return `${family} ${claude[2]}${claude[3] === undefined ? '' : `.${claude[3]}`}`;
  }
  return model;
}

/**
 * Who acted (a step's, a turn's, a note's `by`): a key for its look, a
 * short name, the badge a row shows (null for the person and the opening,
 * whose rows need none), and the phrase a screen reader hears.
 *
 * @param {{origin: string, agent?: string|null, model?: string|null, host?: string|null, person?: string|null}|null} by
 * @param {string|null} [type] - the step's action (an outside change has no known author)
 * @returns {{key: string, name: string, badge: string|null, phrase: string|null}}
 */
export function authorOf(by, type = null) {
  const origin = originOf({ type, origin: by?.origin ?? 'startup', agent: by?.agent ?? null, host: by?.host ?? null });
  if (by?.origin === 'outside') return { key: 'outside', name: 'Not recorded', badge: 'Not recorded', phrase: 'changed outside the history' };
  const model = by?.origin === 'agent' ? modelName(by.model ?? null) : null;
  const name = origin.key === 'person' ? (by?.person ?? 'You') : origin.name;
  const full = model === null ? name : `${name} (${model})`;
  const badgeless = origin.key === 'person' || origin.key === 'start';
  return {
    key: origin.key,
    name,
    badge: badgeless ? null : model === null ? name : `${name} · ${model}`,
    phrase: badgeless ? null : `by ${full}`,
  };
}

/**
 * What a flagged step's flag says, or null: a step a replay could not apply
 * here (kept with no change) did not match; any other flagged step no longer
 * applies (a step it needed was deleted).
 *
 * @param {{status: string, by?: {origin: string}, touches?: string[], reason?: string|null}} step
 * @returns {{text: string, phrase: string}|null} `phrase`: what a screen reader hears after the step
 */
export function flagOf(step) {
  if (step.status !== 'unapplicable') return null;
  const unmatched = step.by?.origin === 'replay' && (step.touches ?? []).length === 0;
  const phrase = unmatched ? 'did not match here' : 'no longer applies';
  const reason = step.reason ?? (unmatched ? 'It could not be applied on this dataset.' : 'It could not be applied again.');
  return { text: `${unmatched ? 'Did not match here' : 'No longer applies'}: ${reason}`, phrase };
}

/** "Camera ×6 · Layout ×2" for a folded run; a filtered run counts its steps. */
export function runLabel(row) {
  if (row.filtered) return `${formatCountOf(row.count, 'step')} hidden`;
  const parts = row.categories.map(({ name, count }) => (count === 1 ? name : `${name} ×${count}`));
  return `${parts.join(' · ')}${row.off ? ' · not recorded now' : ''}`;
}

/** The glyph a row draws at its lane (decorative; its name carries the meaning). */
export function rowGlyph(row) {
  switch (row.kind) {
    case 'fork': return '⑂';
    case 'turn': return '◆';
    case 'group': return '▣';
    case 'run': return '⋯';
    case 'paused': return '⏸';
    default:
      // The changes kept from a pause (one step) are not the paused marker (⏸).
      if (row.step.kind === 'squashed') return row.step.squashed?.cause === 'paused' ? '◐' : '⧉';
      return row.position === 'head' ? '◉' : row.position === 'undone' ? '○' : '●';
  }
}

/**
 * The words of a graph row: its label, what follows it, and its accessible
 * name ("Step 12 of Main, Hid alpha of cell_type, by Claude (Sonnet 4.6), 3
 * minutes ago, has a note, branch “Without alpha” starts here").
 *
 * @param {import('./graph-layout.js').GraphRow} row
 * @param {{view: import('./history-source.js').TrackerView, now: number}} context
 * @returns {{label: string, meta: string, badge: string|null, time: string, name: string, hint: string}}
 */
export function describeRow(row, { view, now }) {
  const branchName = id => view.branch(id)?.name ?? id;
  switch (row.kind) {
    case 'step': {
      const step = row.step;
      const author = authorOf(step.by, step.type);
      const ago = formatAgo(step.at, now);
      const facts = [];
      if (step.bookmark) facts.push(`bookmarked “${step.bookmark}”`);
      if ((step.notes?.length ?? 0) > 0) facts.push(step.notes.length === 1 ? 'has a note' : `has ${step.notes.length} notes`);
      const flag = flagOf(step);
      if (flag !== null) facts.push(flag.phrase);
      if (row.stale !== null) facts.push('stale');
      if (row.off) facts.push('not recorded now');
      const starts = view.branchesFrom(step.id).filter(branch => !branch.archived && branch.id !== step.branch);
      for (const branch of starts) facts.push(`branch “${branch.name}” starts here`);
      const where = row.position === 'head' ? 'shown' : row.position === 'undone' ? 'undone' : null;
      const number = step.parent === null ? 'The opening' : `Step ${idNumber(step.id)} of ${branchName(step.branch)}`;
      const name = [number, step.label, author.phrase, ago.long, where, ...facts].filter(Boolean).join(', ');
      // Inside a turn, the turn's row names who acted: its steps need not repeat it.
      const inTurn = row.parent?.startsWith('t:') === true;
      return {
        label: step.label, meta: '', badge: inTurn ? null : author.badge, time: ago.short, name,
        hint: `${formatStepTime(step.at, now)}${author.phrase === null ? '' : ` · ${author.phrase}`}`,
      };
    }
    case 'fork': {
      const branch = row.branch;
      const ago = formatAgo(row.last, now);
      const count = formatCountOf(row.count, 'step');
      const flags = [branch.id === view.mainBranch ? 'main' : null, branch.locked ? 'locked' : null].filter(Boolean);
      const what = row.continues ? `the rest of branch “${branch.name}”` : `branch “${branch.name}”`;
      const name = [`${what[0].toUpperCase()}${what.slice(1)}, ${count}, last change ${ago.long}`, ...flags,
        row.forksInside > 0 ? `${formatCountOf(row.forksInside, 'branch', 'branches')} start from it` : null,
        row.expanded ? null : 'collapsed'].filter(Boolean).join(', ');
      return { label: branch.name, meta: `${count} · ${ago.short}`, badge: null, time: '', name, hint: `From step ${idNumber(row.base)}` };
    }
    case 'turn': {
      const author = authorOf(row.by, null);
      const count = formatCountOf(row.count, 'step');
      const summary = row.turn?.notes?.[0]?.text ?? null;
      const label = author.badge ?? author.name;
      const at = row.headAt === null ? null : `at step ${idNumber(view.headId)}`;
      const name = [`${author.name}'s turn${row.turn?.label ? ` “${row.turn.label}”` : ''}`, count, at, summary === null ? null : 'has a summary',
        row.position === 'undone' ? 'undone' : null].filter(Boolean).join(', ');
      return { label, meta: [count, at].filter(Boolean).join(' · '), badge: null, time: '', name, hint: summary ?? row.turn?.label ?? '' };
    }
    case 'group': {
      const count = formatCountOf(row.count, 'step');
      const span = row.first === null ? '' : `${formatStepTime(row.first, now)}–${formatStepTime(row.last, now)}`;
      // The head inside the group, by its place among the group's steps (§3.15.2 "▣ QC · at 4 of 7").
      const at = row.headAt === null ? null : `at ${formatCount(row.headAt.index)} of ${formatCount(row.headAt.count)}`;
      const starts = row.forksInside === 1 ? '1 branch starts inside' : `${formatCount(row.forksInside)} branches start inside`;
      const name = [`Group “${row.group.name}”`, count, at, row.forksInside > 0 ? starts : null, row.expanded ? null : 'collapsed'].filter(Boolean).join(', ');
      return {
        label: row.group.name,
        meta: [at ?? count, row.forksInside > 0 ? `⑂ ${formatCount(row.forksInside)}` : null].filter(Boolean).join(' · '),
        badge: null,
        time: formatAgo(row.last, now).short,
        name,
        hint: [span, row.forksInside > 0 ? starts : null].filter(Boolean).join(' · '),
      };
    }
    case 'run': {
      const label = runLabel(row);
      const at = row.headAt === null ? null : `at step ${idNumber(view.headId)}`;
      const name = [row.filtered ? label : `${label}, ${formatCountOf(row.count, 'step')} folded`, at, row.expanded ? null : 'collapsed'].filter(Boolean).join(', ');
      return { label, meta: at ?? '', badge: null, time: formatAgo(row.last, now).short, name, hint: 'Folded for reading; undo still goes step by step.' };
    }
    case 'paused': {
      const since = row.since === null ? '' : ` since ${formatStepTime(row.since, now)}`;
      return { label: 'Paused', meta: '', badge: null, time: '', name: `Recording paused${since}: changes apply but are not steps`, hint: '' };
    }
    default:
      throw new RangeError(`There is no graph row kind "${row.kind}"`);
  }
}

/**
 * The status line's words after the recording switch and the branch picker:
 * "14 steps · ⚠ 2 stale", "14 steps · 5 undone", "8 of 214 steps" while a
 * search folds the rest, "since 10:42" while paused. Steps are counted
 * without the opening, as everywhere in the panel.
 *
 * @param {{steps: number, undone: number, matches: number|null, stale: number, recording: boolean,
 *   pausedAt: number|null, now: number}} facts - `steps`: on the branch shown; `undone`: after the step shown
 */
export function statusWords({ steps, undone, matches, stale, recording, pausedAt, now }) {
  if (!recording) return { text: `since ${formatStepTime(pausedAt, now)}`, stale: null };
  let text;
  if (matches !== null) text = `${formatCount(matches)} of ${formatCountOf(steps, 'step')}`;
  else if (steps === 0) text = 'No steps yet';
  else if (undone === 0) text = formatCountOf(steps, 'step');
  else text = `${formatCountOf(steps, 'step')} · ${formatCount(undone)} undone`;
  return { text, stale: stale > 0 ? `⚠ ${formatCount(stale)} stale` : null };
}

/** Whether a step only moved a camera (a tour flies to it). */
export function isCameraStep(step) {
  return step.kind === 'action' && step.type !== OUTSIDE_CHANGE_TYPE && step.status !== 'unapplicable'
    && (step.touches ?? []).length > 0 && step.touches.every(id => id === 'camera');
}

/**
 * The plan of a guided tour over the steps shown: the opening, then each
 * step with its caption (its first note as a second line) and how long it is
 * held, and the group it opens as a chapter title. A camera step flies to its
 * view first (`flyMs`); under reduced motion nothing flies, every step is
 * shown at once and held.
 *
 * @param {object[]} steps - The steps shown, first first
 * @param {{holdMs?: number, flyMs?: number, reducedMotion?: boolean, groupName?: (id: string) => string|null}} [options]
 * @returns {Array<{stepId: string, number: number, caption: string, note: string|null, chapter: string|null,
 *   by: string|null, fly: boolean, flyMs: number, holdMs: number}>}
 */
export function tourPlan(steps, { holdMs = 2600, flyMs = 1600, reducedMotion = false, groupName = () => null } = {}) {
  if (!Number.isFinite(holdMs) || holdMs < 0 || !Number.isFinite(flyMs) || flyMs < 0) {
    throw new RangeError('A tour holds and flies for a number of milliseconds');
  }
  return steps.map((step, index) => {
    const author = authorOf(step.by, step.type);
    const fly = !reducedMotion && index > 0 && isCameraStep(step);
    const caption = step.status === 'unapplicable' ? `${step.label} (no longer applies)` : step.label;
    const group = step.group ?? null;
    const opens = group !== null && (index === 0 || steps[index - 1].group !== group);
    return {
      stepId: step.id,
      number: index,
      caption,
      note: step.notes?.[0]?.text ?? null,
      chapter: opens ? groupName(group) : null,
      by: author.badge === null || author.key === 'outside' ? null : author.badge,
      fly,
      flyMs: fly ? flyMs : 0,
      holdMs,
    };
  });
}
