/**
 * @fileoverview How a recorded step is put into words: who took it, which
 * parts of the state it changed, its parameters as short facts, what a
 * squashed step stands for, and the path of steps an export covers (any
 * branch, up to any of its steps) with its runs of grouped steps. Pure
 * (importable in Node): the timeline, the exports and the agent's history
 * reads say a step the same way.
 *
 * Every function reads History v2 records (`app/history/model.js`): a step's
 * `kind`, `by` and `squashed`, a tracker's `branches`, `groups` and `notes`;
 * never the tracker's recording switch.
 *
 * @module app/history/exports/step-text
 */

import { formatCount, formatCountOf } from '../../../utils/format-units.js';
import { domainName } from '../../actions/domains.js';
import { idNumber, nameKey, OUTSIDE_CHANGE_TYPE } from '../model.js';

/** The type of the step the history keeps for a change made outside an action (`model.js`). */
export { OUTSIDE_CHANGE_TYPE };

/**
 * Domains whose change is part of an analysis a methods section reports
 * (what the data means, what is shown of it, what was computed); the others
 * only present it (camera, panels, render settings, kept views, colors).
 */
export const METHOD_DOMAINS = Object.freeze(new Set([
  'mapping', 'field-overlays', 'gene-sets', 'active-field', 'filters', 'visibility', 'highlights', 'analysis',
]));

const AGENT_KEYS = new Map([['claude', 'claude'], ['chatgpt', 'chatgpt']]);
const HOST_NAMES = new Map([['python', 'Python'], ['r', 'R']]);

/**
 * Who acted: a short name for a badge and a key for its look. A person is
 * `person` (named "Person": a shared history does not know who); an agent by
 * its name (Claude, ChatGPT, or another); a notebook by its language; a
 * session file, a replay and the opening by what they are. A change made
 * outside an action has no known author (`outside`, "Not recorded").
 *
 * @param {{origin: string, agent?: string|null, host?: string|null}} by - A `By` record (`step.by`, `note.by`)
 * @returns {{key: string, name: string}}
 */
export function originOf(by) {
  switch (by.origin) {
    case 'outside': return { key: 'outside', name: 'Not recorded' };
    case 'user': return { key: 'person', name: 'Person' };
    case 'agent': {
      const name = typeof by.agent === 'string' && by.agent.length > 0 ? by.agent : 'Agent';
      return { key: AGENT_KEYS.get(name.toLowerCase()) ?? 'agent', name };
    }
    case 'host': {
      const host = typeof by.host === 'string' ? by.host.toLowerCase() : '';
      return { key: HOST_NAMES.has(host) ? host : 'host', name: HOST_NAMES.get(host) ?? 'Notebook' };
    }
    case 'session': return { key: 'session', name: 'Session' };
    case 'replay': return { key: 'replay', name: 'Replay' };
    default: return { key: 'start', name: 'Start' };
  }
}

/**
 * Who acted, as a methods paragraph says it ("an AI assistant (Claude,
 * claude-sonnet-4-6) at the user's request"); null for a change made outside
 * an action, whose author is not known.
 * @param {{origin: string, agent?: string|null, model?: string|null, host?: string|null}} by - A `By` record
 */
export function originPhrase(by) {
  const origin = originOf(by);
  switch (origin.key) {
    case 'outside': return null;
    case 'person': return 'the user';
    case 'claude': case 'chatgpt': case 'agent': {
      const model = typeof by.model === 'string' && by.model.length > 0 ? `, ${by.model}` : '';
      return `an AI assistant (${origin.name}${model}) at the user's request`;
    }
    case 'python': case 'r': return `a ${origin.name} notebook through the Cellucid viewer API`;
    case 'host': return 'a notebook through the Cellucid viewer API';
    case 'session': return 'loading a session file';
    case 'replay': return 'replaying a recorded history';
    default: return 'opening the dataset';
  }
}

/**
 * Everyone who acted in a step: for a squashed step, everyone who acted in
 * what it replaced (`squashed.by`, when it names anyone); else its `by`.
 * @param {{kind: string, by: object, squashed: {by: object[]}|null}} step
 * @returns {object[]} `By` records
 */
export function actorsOf(step) {
  return step.kind === 'squashed' && step.squashed.by.length > 0 ? step.squashed.by : [step.by];
}

/**
 * What a squashed step stands for, as a sentence opening (History v2
 * §3.15.1-3): "Changes made with recording paused", "3 steps merged into
 * one", "A fresh start from the state reached before the history was
 * cleared", "A shared state, received without its history".
 * @param {{cause: string, count: number|null}} squashed - The step's `Squash` record
 */
export function squashPhrase(squashed) {
  switch (squashed.cause) {
    case 'paused': return 'Changes made with recording paused';
    case 'steps': return `${formatCountOf(squashed.count, 'step')} merged into one`;
    case 'clear': return 'A fresh start from the state reached before the history was cleared';
    case 'share': return 'A shared state, received without its history';
    default: throw new RangeError(`A squashed step is made for paused, steps, clear or share, not ${squashed.cause}`);
  }
}

/**
 * A step's bookmarks: its own, then (for a squashed step) those of the steps
 * it replaced, which it keeps (`squashed.carried.bookmarks`), marked carried.
 * @returns {Array<{name: string, carried: boolean}>}
 */
export function bookmarksOf(step) {
  const own = step.bookmark === null || step.bookmark === undefined ? [] : [{ name: step.bookmark, carried: false }];
  const carried = step.kind === 'squashed' ? step.squashed.carried.bookmarks.map(name => ({ name, carried: true })) : [];
  return [...own, ...carried];
}

/** The names of the domains a step changed, in domain order ("Colors", "Filters"). */
export function touchedNames(step) {
  return (step.touches ?? []).map(domainName);
}

/** `all_branches` → "All branches", `fieldKey` → "Field key". */
export function parameterLabel(key) {
  const words = String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.length === 0 ? String(key) : words[0].toUpperCase() + words.slice(1);
}

const LIST_SHOWN = 5;

function isFieldReference(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 2 && (value.source === 'obs' || value.source === 'var')
    && typeof value.key === 'string';
}

function shortNumber(value) {
  if (Number.isInteger(value)) return formatCount(value);
  return String(Number(value.toPrecision(6)));
}

/**
 * One parameter value as a short fact: a field by its name (a gene marked),
 * a list of cells or of per-cell values as their count, a list of names cut after five with the
 * whole list as the title.
 *
 * @param {unknown} value
 * @param {object|null} [schema] - The parameter's schema (`x-cells` marks cells, `x-values` per-cell numbers)
 * @returns {{value: string, title: string|null}}
 */
export function parameterValue(value, schema = null) {
  if (value === null || value === undefined) return { value: 'None', title: null };
  if (typeof value === 'boolean') return { value: value ? 'Yes' : 'No', title: null };
  if (typeof value === 'number') return { value: Number.isFinite(value) ? shortNumber(value) : String(value), title: null };
  if (typeof value === 'string') return { value: value.length === 0 ? '(empty)' : value, title: null };
  if (ArrayBuffer.isView(value) || schema?.['x-cells'] === true) {
    return { value: formatCountOf(value.length, 'cell'), title: null };
  }
  // Per-cell numbers (a column a notebook pushed) as their count, never the values themselves.
  if (Array.isArray(value) && schema?.['x-values'] === true) {
    return { value: formatCountOf(value.length, 'value'), title: null };
  }
  if (isFieldReference(value)) {
    return { value: value.source === 'var' ? `${value.key} (gene)` : value.key, title: null };
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return { value: 'None', title: null };
    const parts = value.map(item => parameterValue(item, schema?.items ?? null).value);
    if (parts.length <= LIST_SHOWN) return { value: parts.join(', '), title: null };
    return {
      value: `${parts.slice(0, LIST_SHOWN).join(', ')} and ${formatCountOf(parts.length - LIST_SHOWN, 'more', 'more')}`,
      title: parts.join(', '),
    };
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    const text = entries.map(([key, item]) => `${parameterLabel(key)}: ${parameterValue(item, schema?.properties?.[key] ?? null).value}`).join('; ');
    return { value: text.length === 0 ? 'None' : text, title: null };
  }
  return { value: String(value), title: null };
}

/**
 * A step's parameters as fact rows (`renderFactList`), in the order its
 * schema lists them.
 *
 * @param {object|null} params
 * @param {object|null} [schema] - The action's params schema, when known
 * @returns {Array<{label: string, value: string, title?: string}>}
 */
export function parameterFacts(params, schema = null) {
  if (params === null || typeof params !== 'object') return [];
  const order = schema?.properties ? Object.keys(schema.properties) : [];
  const keys = [...order.filter(key => key in params), ...Object.keys(params).filter(key => !order.includes(key)).sort()];
  return keys.filter(key => params[key] !== undefined).map(key => {
    const { value, title } = parameterValue(params[key], schema?.properties?.[key] ?? null);
    return title === null ? { label: parameterLabel(key), value } : { label: parameterLabel(key), value, title };
  });
}

/** A tracker's records of one kind as a list (the model's arrays, or a live tracker's Maps). */
function listOf(records) {
  return records instanceof Map ? [...records.values()] : records;
}

/**
 * The steps of a tracker from its root to `stepId`, root first.
 *
 * @param {{steps: Map<string, object>|object[]}} tracker
 * @param {string} stepId
 */
export function pathOf(tracker, stepId) {
  const byId = tracker.steps instanceof Map ? tracker.steps : new Map(tracker.steps.map(step => [step.id, step]));
  const path = [];
  for (let step = byId.get(stepId); step !== undefined; step = step.parent === null ? undefined : byId.get(step.parent)) {
    path.push(step);
  }
  if (path.length === 0) throw new RangeError(`There is no step "${stepId}" in this history`);
  return path.reverse();
}

/**
 * The path an export covers: a branch of the tracker (by id or name; its
 * main branch when null) from the root to its tip, or to `to`, one of the
 * steps on that path (the step shown, after an undo).
 *
 * @param {object} tracker - A `Tracker` record
 * @param {{branch?: string|null, to?: string|null}} [options]
 * @returns {{branch: object, to: string|null, steps: object[]}} `to` is null when the path runs to the tip
 */
export function branchPath(tracker, { branch = null, to = null } = {}) {
  const branches = listOf(tracker.branches);
  const ref = branch ?? tracker.mainBranch;
  const found = branches.find(candidate => candidate.id === ref)
    ?? branches.find(candidate => nameKey(candidate.name) === nameKey(ref));
  if (found === undefined) {
    throw new RangeError(`There is no branch "${ref}"; the branches are ${branches.map(b => `"${b.name}"`).join(', ')}.`);
  }
  const steps = pathOf(tracker, found.tip);
  if (to === null || to === found.tip) return { branch: found, to: null, steps };
  const index = steps.findIndex(step => step.id === to);
  if (index < 0) throw new RangeError(`Step ${idNumber(to)} is not on the path of the branch "${found.name}".`);
  return { branch: found, to, steps: steps.slice(0, index + 1) };
}

/**
 * Consecutive steps that share a group, in order: one run per group, and one
 * per stretch of steps in no group (`group` null).
 *
 * @param {object[]} steps
 * @param {object} tracker - Its `groups` name each run's group
 * @returns {Array<{group: object|null, steps: object[]}>}
 */
export function groupRuns(steps, tracker) {
  const groups = new Map(listOf(tracker.groups ?? []).map(group => [group.id, group]));
  const runs = [];
  for (const step of steps) {
    const id = step.group ?? null;
    const last = runs[runs.length - 1];
    if (last !== undefined && (last.group?.id ?? null) === id) {
      last.steps.push(step);
      continue;
    }
    if (id !== null && !groups.has(id)) throw new RangeError(`Step ${idNumber(step.id)} names the group "${id}", which the tracker does not hold`);
    runs.push({ group: id === null ? null : groups.get(id), steps: [step] });
  }
  return runs;
}

/**
 * The heading of each run of `groupRuns`: a group's name; for steps in no
 * group, "After <the group before>", or "Before <the group after>" for those
 * ahead of every group (a heading holds everything up to the next one, so
 * these steps get their own). A path with no group has no heading (null).
 * @param {Array<{group: object|null}>} runs
 * @returns {Array<string|null>}
 */
export function runHeadings(runs) {
  return runs.map((run, index) => {
    if (run.group !== null) return run.group.name;
    if (index > 0) return `After ${runs[index - 1].group.name}`;
    return runs.length > 1 ? `Before ${runs[1].group.name}` : null;
  });
}

/**
 * Upper-case the first letter of a step's sentence unless it is already a
 * name ("Colored by cell_type", "PCA computed").
 */
export function sentenceStart(text) {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}

/**
 * Lower-case the first word of a step's sentence for use inside a sentence,
 * unless it reads as a name (an acronym, a gene: "PCA", "CD3E").
 */
export function inSentence(text) {
  if (text.length < 2) return text;
  const first = text.split(/\s/, 1)[0];
  if (first.length > 1 && first === first.toUpperCase()) return text;
  return text[0].toLowerCase() + text.slice(1);
}
