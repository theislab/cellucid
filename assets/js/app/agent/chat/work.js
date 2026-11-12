/**
 * @fileoverview A turn's work as the chat shows it (pure): each tool call
 * named by what it was about, and a long turn's calls folded under one
 * summary row, so the agent's answer is what the person reads.
 *
 * **Names.** A call that read (or did something no step records) is named
 * by its action's own sentence, `describe(args)` in the catalog: the same
 * words the history, the methods paragraph and the confirm card use ("Read
 * the categories of cell_type", "Looked up 12 gene names", "Read the
 * differential expression result"). A step is named by its step's label.
 * A call still running, refused, stopped or interrupted did not happen, so
 * it is named by its action's title and its subject: the names in its
 * arguments (`subjectOf`: fields and genes by name, highlight pages, views,
 * categories, analyses, lists of them), one rule for every action's
 * parameters ("Run an analysis: differential · refused").
 *
 * **Folding** (`turnFoldOf`). A turn with more calls than `LIVE_ROWS` gets
 * one summary row at its start, a disclosure ("Worked through 42 actions ·
 * 7 steps · 3 analyses"). Folded, an ended turn shows its answer (the last
 * of its messages with words) and nothing of its work but what went wrong
 * (a refused, stopped or interrupted call is information, unless the
 * agent made the same call again in the turn and it went through: a retry
 * that worked) and the questions it asked; a running turn shows its latest `LIVE_ROWS` calls (and the
 * words of the messages that made them) under "12 actions so far". Opened,
 * the turn is as it was made: every message's words and every call, in
 * order. Nothing is removed: the rows, their details, Show and the turn's
 * footer are the same either way. A note the model wrote before a call
 * (what it found, what it does next: `progress`) is shown and folded with
 * that call's row, so a running turn's latest calls come with their notes.
 *
 * @module app/agent/chat/work
 */

import { toolNameOf } from '../../actions/catalog.js';
import { withDefaults } from '../../actions/schema.js';
import { HISTORY_ID_PATTERNS } from '../../history/model.js';
import { UNRECORDED_NOTES } from '../bridge/mcp-content.js';
import { formatCount, formatCountOf } from '../../../utils/format-units.js';

/** How many of a running turn's calls stay shown while it works; a turn with more is folded. */
export const LIVE_ROWS = 3;

/** How many names of a list a subject says before counting the rest. */
const LISTED_NAMES = 3;

/** The tool that runs an analysis: its steps are the summary's analyses. */
const RUN_ANALYSIS = toolNameOf('analysis.run');

/** States of a call that did not do what was asked: shown even when its turn is folded. */
export const FAILED_STATES = Object.freeze(['refused', 'stopped', 'interrupted']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** One name an argument holds: a word as given (white space made one space), or a field or gene (`{source, key}`) by its key. */
function nameIn(value) {
  if (typeof value === 'string') {
    const text = value.replace(/\s+/g, ' ').trim();
    return text === '' ? null : text;
  }
  if (isPlainObject(value) && typeof value.key === 'string' && typeof value.source === 'string') return nameIn(value.key);
  return null;
}

/** The history's generated ids (a step, a note, an entry of Recently deleted, …) as their parameters' patterns give them. */
const HISTORY_ID_SOURCES = new Set(Object.values(HISTORY_ID_PATTERNS).map(pattern => pattern.source));

/**
 * Whether `value` is one of a closed set of words its parameter takes (`enum`,
 * `const`; for a list, its items'), or an id the history generates (a
 * parameter whose pattern is one, `HISTORY_ID_PATTERNS`): how the action is
 * done, or what it is done to as the person never reads it, said by its own
 * sentence in its own words ("Deleted step 3", never "s3").
 */
function isClosed(schema, value) {
  if (!isPlainObject(schema)) return false;
  if (typeof schema.pattern === 'string' && HISTORY_ID_SOURCES.has(schema.pattern)) return true;
  if (Array.isArray(value)) {
    const list = schema.oneOf?.find(branch => branch.type === 'array' || branch.items !== undefined) ?? schema;
    return value.length > 0 && isClosed(list.items, value[0]);
  }
  const among = branch => branch.enum?.includes(value) === true || (branch.const !== undefined && branch.const === value);
  return among(schema) || (Array.isArray(schema.oneOf) && schema.oneOf.some(among));
}

/**
 * The names a call's arguments hold, in order, each with whether it is one
 * of a closed set of words (`isClosed`).
 * @returns {Array<{text: string, closed: boolean}>}
 */
function namesOf(args, schema) {
  if (!isPlainObject(args)) return [];
  const names = [];
  for (const [key, value] of Object.entries(args)) {
    const property = schema?.properties?.[key];
    if (property?.default !== undefined && JSON.stringify(property.default) === JSON.stringify(value)) continue;
    const closed = isClosed(property, value);
    if (Array.isArray(value)) {
      const listed = value.map(nameIn).filter(name => name !== null);
      if (listed.length === 0) continue;
      const more = listed.length - LISTED_NAMES;
      names.push({ text: more > 0 ? `${listed.slice(0, LISTED_NAMES).join(', ')} +${formatCount(more)}` : listed.join(', '), closed });
      continue;
    }
    const name = nameIn(value);
    if (name !== null) names.push({ text: name, closed });
  }
  return names.filter((name, index) => names.findIndex(other => other.text === name.text) === index);
}

/**
 * What a call is about, from its arguments: the names they hold, in order
 * (a field or gene by its key, a page, a view, a category, an analysis, a
 * list of names as its first few and how many more). Numbers, switches and
 * nested options are how, not what, and are left out, as is a value its
 * parameter takes by default (the analysis panel, where nothing else was
 * named). One rule for every action: the catalog's parameters name their
 * targets this way (`actions/catalog.js`: "targets are named, never
 * positional").
 * @param {unknown} args
 * @param {object|null} [schema] - the action's parameters (their defaults, their closed sets)
 * @returns {string} '' when they name nothing
 */
export function subjectOf(args, schema = null) {
  return namesOf(args, schema).map(name => name.text).join(', ');
}

/**
 * A call as the chat names it: its title, its subject, and the sentence its
 * action says of it once done (`describe`, with the defaults it ran with),
 * or null when the call names no action of the catalog or its sentence
 * cannot be made from these arguments. A name the call was given that the
 * sentence leaves out (a field whose values were read, a page, a search's
 * words) follows it ("Read 1 field of 12 cells: SOX9"); a closed word (an
 * analysis's id) does not: the sentence says it in its own words.
 * @param {{name: string, args: unknown}} part
 * @param {object|undefined} definition - the action the tool runs (`toolIndexOf`)
 * @param {string} [title] - for a tool of the chat's own (`ask_person`)
 * @returns {{name: string, args: unknown, title: string, subject: string, target: string, done: string|null}}
 *   target: the call's free names alone (no closed word): what it was done
 *   to, the same when the agent tries it again another way
 */
export function namedCall(part, definition, title = definition?.title ?? part.name) {
  const names = namesOf(part.args, definition?.params ?? null);
  let done = null;
  if (definition !== undefined && isPlainObject(part.args)) {
    try {
      const said = definition.describe(withDefaults(definition.params, part.args));
      if (typeof said === 'string' && said.trim() !== '') {
        const sentence = said.trim();
        const left = names.filter(name => !name.closed && !sentence.includes(name.text)).map(name => name.text);
        done = left.length === 0 ? sentence : `${sentence}: ${left.join(', ')}`;
      }
    } catch {
      // Arguments the action does not take (a refused call): named by its title and subject.
    }
  }
  const target = names.filter(name => !name.closed).map(name => name.text).join(', ');
  return { name: part.name, args: part.args, title, subject: names.map(name => name.text).join(', '), target, done };
}

/** A result's text Cellucid added after the data. */
export function saysUnchanged(result) {
  return result.content.some(item => item.type === 'text' && item.text.includes(UNRECORDED_NOTES.unchanged));
}

/**
 * The label of a tool row: the step it made, the sentence of what it read,
 * or the call and what became of it. A call with no result is running while
 * its turn runs, else it was interrupted (the page closed before it
 * finished).
 * @param {{title: string, subject?: string, done?: string|null}} call
 * @param {object|null} result
 * @param {{running?: boolean}} [options]
 * @returns {{state: string, label: string}}
 */
export function toolRowText(call, result, { running = true } = {}) {
  const named = call.subject ? `${call.title}: ${call.subject}` : call.title;
  if (result === null) return running ? { state: 'running', label: `${named}…` } : { state: 'interrupted', label: `${named} · interrupted` };
  if (result.interrupted && result.step === null) return { state: 'interrupted', label: `${named} · interrupted` };
  if (result.isError) {
    const stopped = /^(Not run|Stopped before it finished)/.test(result.content[0]?.text ?? '');
    return { state: stopped ? 'stopped' : 'refused', label: `${named} · ${stopped ? 'stopped' : 'refused'}` };
  }
  if (result.step !== null && result.step !== undefined) return { state: 'step', label: result.step.label };
  // Asked for what was so already: no step, and nothing was done.
  if (saysUnchanged(result)) return { state: 'read', label: `${named} · already so` };
  return { state: 'read', label: call.done ?? named };
}

/**
 * Which of a turn's messages, words and calls are shown.
 *
 * @param {Array<{text: boolean, asks: number, rows: Array<{state: string, name: string, target?: string}>}>} items
 *   the turn's agent messages in order: whether it has words, how many
 *   questions it asked, and its calls' rows (`toolRowText` state, tool
 *   name, `namedCall` target: a failed call is retried by a later one of
 *   the same tool and target, whatever else it changed)
 * @param {{running?: boolean, expanded?: boolean}} [options]
 * @returns {{summary: {actions: number, steps: number, analyses: number, refused: number, stopped: number, interrupted: number}|null,
 *   folded: boolean, messages: boolean[], bodies: boolean[], rows: boolean[][]}}
 *   summary null: the turn is short, shown whole, with no summary row
 */
export function turnFoldOf(items, { running = false, expanded = false } = {}) {
  const rows = items.flatMap(item => item.rows);
  const whole = {
    summary: null, folded: false,
    messages: items.map(() => true), bodies: items.map(item => item.text), rows: items.map(item => item.rows.map(() => true)),
  };
  if (rows.length <= LIVE_ROWS) return whole;
  const count = state => rows.filter(row => row.state === state).length;
  const summary = {
    actions: rows.length,
    steps: count('step'),
    analyses: rows.filter(row => row.state === 'step' && row.name === RUN_ANALYSIS).length,
    refused: count('refused'), stopped: count('stopped'), interrupted: count('interrupted'),
  };
  if (expanded) return { ...whole, summary };
  // A failure the agent recovered from (the same call later went through) says nothing of the answer.
  const keyOf = row => `${row.name}\u0000${row.target ?? ''}`;
  const recovered = rows.map((row, index) => FAILED_STATES.includes(row.state)
    && rows.slice(index + 1).some(later => keyOf(later) === keyOf(row) && !FAILED_STATES.includes(later.state) && later.state !== 'running'));
  // Running: the latest calls, by their place in the turn. Ended: the answer, the last message with words.
  const liveFrom = rows.length - LIVE_ROWS;
  let at = 0;
  const shownRows = items.map(item => item.rows.map(row => {
    const index = at++;
    return (running && index >= liveFrom) || (FAILED_STATES.includes(row.state) && !recovered[index]);
  }));
  const answer = running ? -1 : items.findLastIndex(item => item.text);
  let firstLive = -1;
  if (running) {
    at = 0;
    firstLive = items.findIndex(item => item.rows.some(() => at++ >= liveFrom));
    if (firstLive === -1) firstLive = items.length - 1;
  }
  const bodies = items.map((item, index) => item.text && (running ? index >= firstLive : index === answer));
  const messages = items.map((item, index) => bodies[index] || item.asks > 0 || shownRows[index].some(Boolean));
  return { summary, folded: true, messages, bodies, rows: shownRows };
}

/**
 * The summary row's words: "Worked through 42 actions · 7 steps · 3
 * analyses · 1 refused" once the turn has ended, "12 actions so far · 2
 * steps" while it runs.
 * @param {NonNullable<ReturnType<typeof turnFoldOf>['summary']>} summary
 * @param {{running?: boolean}} [options]
 */
export function workSummaryText(summary, { running = false } = {}) {
  const actions = formatCountOf(summary.actions, 'action');
  const parts = [running ? `${actions} so far` : `Worked through ${actions}`];
  if (summary.steps > 0) parts.push(formatCountOf(summary.steps, 'step'));
  if (summary.analyses > 0) parts.push(formatCountOf(summary.analyses, 'analysis', 'analyses'));
  for (const state of FAILED_STATES) if (summary[state] > 0) parts.push(`${summary[state]} ${state}`);
  return parts.join(' · ');
}
