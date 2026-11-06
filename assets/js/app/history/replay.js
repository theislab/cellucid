/**
 * @fileoverview Replaying a recorded history on the dataset shown ("run my
 * workflow on my next sample"): a saved history's branch (a session file, or
 * a saved state of this browser; of this dataset or of another) is applied
 * again by name, in a new tracker whose start says where it comes from
 * (`start.kind 'replay'`, a `Link`, the report and the name mapping kept;
 * `history.js` `replay`). Each step's parameters are brought to this
 * catalogue's version first (`upgradeParams`), then the mapping's names put
 * in place of the recorded ones (`mapParams`). A step that does not match
 * here is kept in the new tracker, flagged with the reason, never dropped.
 *
 * Pure (importable in Node): a saved history's plan, the name mapping, the
 * step a parameter names in the replay, how a report is said, and where a
 * replayed tracker comes from. An action is applied again by its parameters;
 * a squashed step or a change made outside the actions names no action, so
 * on the dataset it was recorded on its values are put back (a step of the
 * same kind), and on another it is flagged, never dropped.
 *
 * @module app/history/replay
 */

import { assembleHistory } from '../session/history-file.js';
import { HISTORY_ID_PATTERNS, nameKey, OUTSIDE_CHANGE_TYPE, REPLAY_OUTCOMES } from './model.js';
import { formatCountOf } from '../../utils/format-units.js';
import { throwIfAborted } from '../../utils/abort.js';
import { CATEGORY_LABEL } from '../actions/definitions/params.js';

/**
 * The plan of a replay from a saved history (`history.snapshot()`'s shape, a
 * model `History`): the steps on the path from a tracker's root to a
 * branch's tip (the tracker shown and its main branch unless named; the root,
 * which records no action, left out), the `Link` the new tracker keeps, and
 * its default name.
 *
 * @param {{activeTracker: string, trackers: object[]}} saved
 * @param {{tracker?: string|null, branch?: string|null, saved?: string|null, file?: string|null}} [choice]
 * @returns {{steps: object[], from: object, name: string}}
 */
export function replayPlanOf(saved, { tracker: trackerRef = null, branch: branchRef = null, saved: savedId = null, file = null } = {}) {
  const trackers = saved?.trackers ?? [];
  const tracker = trackerRef === null
    ? trackers.find(record => record.id === saved.activeTracker)
    : trackers.find(record => record.id === trackerRef || nameKey(record.name) === nameKey(trackerRef));
  if (tracker === undefined) {
    if (trackerRef === null) throw new RangeError('This history names an active tracker it does not hold, so it cannot be replayed.');
    throw new RangeError(`This history has no tracker "${trackerRef}"; its trackers are ${trackers.map(record => `"${record.name}"`).join(', ')}.`);
  }
  const branches = tracker.branches ?? [];
  const branch = branchRef === null
    ? branches.find(record => record.id === tracker.mainBranch)
    : branches.find(record => record.id === branchRef || nameKey(record.name) === nameKey(branchRef));
  if (branch === undefined) {
    if (branchRef === null) throw new RangeError('This history names a main branch it does not hold, so it cannot be replayed.');
    throw new RangeError(`The tracker "${tracker.name}" has no branch "${branchRef}"; its branches are ${branches.map(record => `"${record.name}"`).join(', ')}.`);
  }
  const byId = new Map(tracker.steps.map(step => [step.id, step]));
  const path = [];
  const seen = new Set();
  for (let id = branch.tip; id !== null; id = byId.get(id).parent) {
    if (!byId.has(id) || seen.has(id)) throw new RangeError('This history\'s steps do not lead from its first step to its branch\'s tip, so it cannot be replayed.');
    seen.add(id);
    path.push(byId.get(id));
  }
  path.reverse();
  if (path[0].id !== tracker.rootId) throw new RangeError('This history\'s steps do not lead from its first step to its branch\'s tip, so it cannot be replayed.');
  const dataset = { id: tracker.dataset?.id ?? null, name: tracker.dataset?.name ?? null };
  const fromName = dataset.name ?? dataset.id;
  return {
    steps: path.slice(1),
    from: {
      dataset,
      tracker: { id: tracker.id, name: tracker.name },
      branch: { id: branch.id, name: branch.name },
      step: branch.tip,
      file,
      saved: savedId,
    },
    name: fromName === null ? `Replay of ${tracker.name}` : `Replay of ${fromName}`,
  };
}

/**
 * Read a saved history whole, every chunk or record checked, and give its
 * plan (`replayPlanOf`). Its values are read to be checked and then dropped.
 *
 * @param {{readEager: () => Promise<{history: object}>, readRest: () => Promise<unknown>,
 *   cancel: (reason: unknown) => Promise<void>}} source - `SavedHistorySource`
 * @param {{signal?: AbortSignal|null, tracker?: string|null, branch?: string|null, saved?: string|null, file?: string|null}} [options]
 */
export async function readReplayPlan(source, { signal = null, ...choice } = {}) {
  try {
    throwIfAborted(signal);
    const eager = await source.readEager();
    throwIfAborted(signal);
    const rest = await source.readRest();
    throwIfAborted(signal);
    // Parameters that name arrays only the rest holds come with it (`history-file.js` `assembleHistory`).
    return replayPlanOf(assembleHistory(eager, rest).history, choice);
  } catch (error) {
    await Promise.resolve(source.cancel?.(error)).catch(() => {});
    throw error;
  }
}

/**
 * The parameters of an action that name a step of the history (`history.step.revert`'s
 * `step`): in a replay each names the step the replay made of it (`stepParamsIn`).
 */
export function stepParamsOf(definition) {
  const out = [];
  for (const [key, schema] of Object.entries(definition.params?.properties ?? {})) {
    if (schema?.type === 'string' && schema.pattern === HISTORY_ID_PATTERNS.step.source) out.push(key);
  }
  return out;
}

/**
 * `params` with each step it names put as the replay made it (`made`: source
 * step → step made), or kept when `kept(id)` says the step is there as it is
 * (a step before the replayed ones on the path shown). Returns
 * `{params}`, or `{missing: id}` naming a step the replay did not make.
 */
export function stepParamsIn(definition, params, made, kept = () => false) {
  let out = params;
  for (const key of stepParamsOf(definition)) {
    const id = params[key];
    if (typeof id !== 'string') continue;
    if (made.has(id)) out = { ...out, [key]: made.get(id) };
    else if (!kept(id)) return { missing: id };
  }
  return { params: out };
}

/** Whether a schema holds a list of cells or of one value per cell (`x-cells`, `x-values`), at any depth. */
function holdsCells(schema) {
  if (schema === null || typeof schema !== 'object') return false;
  if (schema['x-cells'] === true || schema['x-values'] === true) return true;
  if (Object.values(schema.properties ?? {}).some(holdsCells)) return true;
  if (holdsCells(schema.items)) return true;
  return Array.isArray(schema.oneOf) && schema.oneOf.some(holdsCells);
}

const NAMES_CELLS = new WeakMap();

/**
 * Whether an action's parameters name cells by their original positions (a
 * selection, a pushed column: `x-cells`, `x-values`). Such a step applies
 * only on the dataset it was recorded on: another dataset lists its cells in
 * its own order, so a position there is another cell, even with the same
 * number of cells (`history.js` `replaySteps`).
 * @param {{params: object}} definition
 */
export function namesCells(definition) {
  let named = NAMES_CELLS.get(definition);
  if (named === undefined) {
    named = holdsCells(definition.params);
    NAMES_CELLS.set(definition, named);
  }
  return named;
}

/** Whether a recorded step names an action a replay applies again (not the root, an outside change or a squashed step). */
export function isReplayable(step) {
  return step?.kind === 'action' && typeof step.type === 'string' && step.type !== OUTSIDE_CHANGE_TYPE;
}

// ---------------------------------------------------------------------------
// Names mapped (History v2 §3.10: "Use instead")

/** Whether a schema allows values of JSON type `type` (`type` alone, or in a list: `['object', 'null']`). */
function allows(schema, type) {
  return Array.isArray(schema?.type) ? schema.type.includes(type) : schema?.type === type;
}

/** Whether a schema names a field or a gene (`params.js` FIELD and its forms: `{source, key}`, nullable ones too). */
function isFieldSchema(schema) {
  return allows(schema, 'object') && schema.properties?.source !== undefined && schema.properties?.key?.type === 'string';
}

/** Whether a schema is a category label (`params.js` CATEGORY_LABEL and its forms, which keep its examples). */
function isCategorySchema(schema) {
  return allows(schema, 'string') && schema.examples === CATEGORY_LABEL.examples;
}

function lookup(list, from) {
  return list.find(entry => entry.from === from)?.to ?? null;
}

/**
 * `params` with the mapping's names in place of the recorded ones: an obs
 * field's key (`fields`), a gene's (`genes`), and each category label of a
 * field (`categories`, by the field's recorded key), wherever the action's
 * parameter schema names them. Nothing else changes.
 *
 * @param {{params: object}} definition
 * @param {object} params
 * @param {{fields: Array<{from: string, to: string}>, categories: Array<{field: string, from: string, to: string}>,
 *   genes: Array<{from: string, to: string}>}} mapping
 */
export function mapParams(definition, params, mapping) {
  const fields = mapping?.fields ?? [];
  const genes = mapping?.genes ?? [];
  const categories = mapping?.categories ?? [];
  if (fields.length + genes.length + categories.length === 0) return params;
  const mapCategory = (field, label) => {
    if (field === null) return label;
    return categories.find(entry => entry.field === field && entry.from === label)?.to ?? label;
  };
  const walk = (schema, value, field) => {
    if (value === null || value === undefined || schema === undefined || schema === null) return value;
    if (isFieldSchema(schema) && typeof value === 'object' && typeof value.key === 'string') {
      const to = lookup(value.source === 'var' ? genes : fields, value.key);
      return to === null ? value : { ...value, key: to };
    }
    if (isCategorySchema(schema) && typeof value === 'string') return mapCategory(field, value);
    if (allows(schema, 'array') && Array.isArray(value)) return value.map(item => walk(schema.items, item, field));
    if (allows(schema, 'object') && typeof value === 'object' && !Array.isArray(value)) {
      // The field a category beside it belongs to: the sibling that names a field, by its recorded key.
      const sibling = Object.entries(schema.properties ?? {}).find(([key, child]) => isFieldSchema(child) && value[key]?.source === 'obs');
      const context = sibling === undefined ? field : value[sibling[0]].key;
      const out = {};
      for (const [key, child] of Object.entries(value)) out[key] = walk(schema.properties?.[key], child, context);
      return out;
    }
    if (Array.isArray(schema.oneOf)) {
      for (const option of schema.oneOf) {
        const mapped = walk(option, value, field);
        if (mapped !== value) return mapped;
      }
    }
    return value;
  };
  return walk(definition.params, params, null);
}

/**
 * The key a name missing in a replay is chosen by: the same name missing in
 * several steps (a gene coloured by twice) is chosen once.
 * @param {{kind: string, name: string, field: string|null}} missing - `ReplayEntry.missing`
 */
export function missingKey(missing) {
  return `${missing.kind}\u0000${missing.field ?? ''}\u0000${missing.name}`;
}

/**
 * `mapping` with the names chosen in a replay's report ("Use instead") put
 * in: each a recorded name and the name to use here. A name missing in the
 * replay is the one the step gave after the mapping, so a name the mapping
 * already put in is mapped again from the recorded one; a category is
 * named by its field's recorded key, as the mapping names it (`mapParams`).
 *
 * @param {{fields: object[], categories: object[], genes: object[]}|null} mapping - the replayed tracker's (`start.mapping`)
 * @param {Array<{missing: {kind: 'field'|'category'|'gene', name: string, field: string|null}, to: string}>} choices
 * @returns {{fields: Array<{from: string, to: string}>, categories: Array<{field: string, from: string, to: string}>,
 *   genes: Array<{from: string, to: string}>}}
 */
export function mappingWith(mapping, choices) {
  const out = {
    fields: [...(mapping?.fields ?? [])],
    categories: [...(mapping?.categories ?? [])],
    genes: [...(mapping?.genes ?? [])],
  };
  const put = (list, entry, same) => {
    const at = list.findIndex(same);
    if (at === -1) list.push(entry); else list[at] = entry;
  };
  for (const { missing, to } of choices) {
    if (typeof to !== 'string' || to === '') continue;
    if (missing.kind === 'category') {
      const field = out.fields.find(entry => entry.to === missing.field)?.from ?? missing.field;
      const from = out.categories.find(entry => entry.field === field && entry.to === missing.name)?.from ?? missing.name;
      put(out.categories, { field, from, to }, entry => entry.field === field && entry.from === from);
    } else {
      const list = missing.kind === 'gene' ? out.genes : out.fields;
      const from = list.find(entry => entry.to === missing.name)?.from ?? missing.name;
      put(list, { from, to }, entry => entry.from === from);
    }
  }
  return out;
}

/**
 * A replay's report in numbers and in one sentence (the State panel's status
 * line, the progress notification's last word).
 *
 * @param {Array<{outcome: string}>} report
 */
export function summarizeReplay(report) {
  const count = outcome => report.filter(entry => entry.outcome === outcome).length;
  const counts = Object.fromEntries(REPLAY_OUTCOMES.map(outcome => [outcome, count(outcome)]));
  const total = report.length;
  const matched = counts.applied + counts.unchanged;
  const parts = [];
  if (counts.unmatched > 0) parts.push(`${formatCountOf(counts.unmatched, 'step')} did not match`);
  if (counts.skipped > 0) parts.push(`${formatCountOf(counts.skipped, 'change')} made outside the steps ${counts.skipped === 1 ? 'was' : 'were'} skipped`);
  let text;
  if (counts.stopped > 0) {
    text = `Replay stopped: ${matched} of ${formatCountOf(total, 'step')} applied`;
    if (parts.length > 0) text += `; ${parts.join('; ')}`;
  } else if (total === 0) {
    text = 'Replayed: the history has no steps.';
  } else if (parts.length === 0) {
    text = `Replayed ${formatCountOf(total, 'step')}; every one matched`;
  } else {
    text = `Replayed ${formatCountOf(total, 'step')}: ${matched} applied; ${parts.join('; ')}`;
  }
  if (!text.endsWith('.')) text += '.';
  return { total, ...counts, text, tone: counts.unmatched + counts.stopped + counts.skipped > 0 ? 'warning' : 'success' };
}

/**
 * Where a tracker's steps were replayed from, and which of them did not
 * match here, read from the tracker itself (its `start`); null for a tracker
 * no replay started.
 *
 * @param {{start: object, steps: Map<string, object>}} tracker - live
 * @returns {{dataset: string, tracker: string, replayed: number,
 *   unmatched: Array<{id: string, label: string, note: string}>}|null}
 */
export function replayedFrom(tracker) {
  if (tracker?.start?.kind !== 'replay' || tracker.start.from === null) return null;
  const link = tracker.start.from;
  const replayed = [...tracker.steps.values()].filter(step => step.replayOf !== null);
  return {
    dataset: link.dataset?.name ?? link.dataset?.id ?? 'another dataset',
    tracker: link.tracker?.name ?? 'a tracker',
    replayed: replayed.length,
    unmatched: replayed
      .filter(step => step.status === 'unapplicable')
      .map(step => ({ id: step.id, label: step.label, note: step.reason ?? 'It could not be applied here.' })),
  };
}
