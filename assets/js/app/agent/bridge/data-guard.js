/**
 * @fileoverview What a tool result may carry of the data while the dataset
 * shown is set to "Agents see names and summaries only" (`../data-scope.js`):
 * names, counts, settings and statistics of groups, never a value of a
 * single cell, a statistic that is one cell's own value, a picture, or a
 * summary of a group an agent shaped by naming cells. Pure; applied by the
 * one tool call both ways in run (`tool-call.js`), so the chat bar and the
 * connector are guarded alike.
 *
 * **Every read is classified** by what its result holds (a read, a move of
 * the history, opening a dataset and an act outside the state answer with
 * their result; a change answers with its step and a short note):
 *
 * - `cells` (`CELL_LEVEL_READS`): values of single cells, or a picture of the
 *   plot (it draws each cell). Refused before it runs, with one sentence.
 * - `summaries` (`SUMMARY_READS`, an analysis's settings, every move or edit
 *   of the history, `OUTSIDE_RESULTS`, a change that declares no result):
 *   names, counts, settings, statistics of groups. Sent, without its
 *   single-cell statistics (`SINGLE_CELL_STATISTICS`: a minimum, a maximum
 *   and a median are each one cell's own value; means, counts, sums and
 *   shares stay).
 * - Anything else (a read nobody classified, an act outside the state nobody
 *   classified, a change that declares a result) is refused while the switch
 *   is on, so an action added later is guarded before anyone classifies it;
 *   `tests/agent-data-guard.test.mjs` fails until it is.
 *
 * **A file the person receives is not sent to the provider.** An export
 * (`figure.export`, `cells.export`, `field.export`, `analysis.export`, `history.report`,
 * `history.share`) writes its file to the person's computer through the
 * browser; what the agent is told is its name, its size and counts
 * (`OUTSIDE_RESULTS`), so it runs with the switch on (owner decision
 * 2026-11-04: the switch keeps cell-level values out of tool results).
 * The report given as text holds what `history.get` holds, never a picture.
 *
 * **Groups an agent shaped** by naming cells (`../data-scope.js`
 * `createShapeTracker`) are refused as the groups of a value summary
 * (`SHAPED_INPUTS`): a field summarized by such a field, an analysis
 * computed on such a page or grouped by such a field. Groups of the
 * dataset's categories and groups the person made stay summarizable.
 *
 * What it does not do: a summary of a very small group the person or the
 * data defines (a narrow range, a filter, a rare category) can still reveal
 * its cells' values. The switch is not anonymization, and every place that
 * describes it says so (`SUMMARIES_ONLY_CAVEAT`); no group size is made up.
 *
 * @module app/agent/bridge/data-guard
 */

import { quoteName } from '../../actions/targets/names.js';
import { ANALYSIS_MODES } from '../../analysis/options/analysis-modes.js';
import { isSteplessEffect } from '../../actions/catalog.js';
import { SUMMARIES_ONLY_LABEL, SUMMARIES_ONLY_PLACE } from '../data-scope.js';
import { setOwnDataProperty } from '../../../utils/exact-record.js';

/** The reads whose results are values of single cells, each with what it would send. */
export const CELL_LEVEL_READS = Object.freeze({
  'cells.values': 'values of single cells',
  'view.picture': 'a picture of the plot, which draws each cell',
});

/** The reads (and the dataset and saved-state openings) whose results are names, counts, settings and statistics of groups. */
export const SUMMARY_READS = Object.freeze(new Set([
  'dataset.summary', 'fields.list', 'field.categories', 'genes.search', 'field.summary', 'views.state',
  // Where groups sit (means and spreads) and the cameras framing them; the camera path's keyframes.
  'camera.framing', 'camera-path.get',
  'settings.list', 'figure-export.get', 'layout.get', 'datasets.list', 'dataset.open', 'history.saved.open',
  'analysis.list', 'analysis.result',
  // An analysis's settings (`analysis.<name>.get`, one per analysis with options).
  ...ANALYSIS_MODES.filter(mode => mode.options !== null).map(mode => `analysis.${mode.name}.get`),
  'history.get', 'history.summary', 'history.step', 'history.diff', 'history.stale', 'history.search',
  'history.methods', 'history.pseudocode', 'history.saved.list',
  'stored.list', 'annotation.suggestions',
  // Where each category's arrows lead: means and shares over its cells.
  'vector-field.summary',
]));

/**
 * The acts outside the state (effect `outside`) whose results are names,
 * sizes, counts and links, never a value of a cell or a picture: the file a
 * person receives is told by its name and size; what is removed or
 * published, by what it was.
 */
export const OUTSIDE_RESULTS = Object.freeze(new Set([
  'history.share', 'history.save', 'history.saved.delete', 'history.report', 'history.anndata.save',
  'my-datasets.forget', 'dataset.share-link', 'stored.remove',
  'figure.export', 'cells.export', 'field.export', 'analysis.export', 'annotation.publish',
]));

/** Whether an action answers with its result rather than a step (a read, a move of the history, a dataset opened, an act outside the state). */
function answersWithResult(definition) {
  return isSteplessEffect(definition.effect);
}

/**
 * What an action's result holds of the data: `cells`, `summaries`, or null
 * when it is not known (a read nobody classified yet).
 * @param {{type: string, effect: string}} definition
 * @returns {'cells'|'summaries'|null}
 */
export function resultDataOf(definition) {
  if (Object.hasOwn(CELL_LEVEL_READS, definition.type)) return 'cells';
  if (SUMMARY_READS.has(definition.type) || OUTSIDE_RESULTS.has(definition.type)) return 'summaries';
  // A move or an edit of the history answers with ids, labels and notes;
  // a stop of work under way (`control`), with whether it stopped.
  if (definition.effect === 'history' || definition.effect === 'control') return 'summaries';
  // A change answers with its step and a short note of what changed; one that declares a result returns data, and is classified first.
  if (!answersWithResult(definition)) return definition.result === null || definition.result === undefined ? 'summaries' : null;
  return null;
}

/**
 * The sentence an agent reads when the dataset's switch refuses `definition`
 * before it runs, or null when it may run.
 * @param {{type: string, title: string, effect: string}} definition
 * @param {{summariesOnly: boolean}} scope
 * @returns {string|null}
 */
export function summariesOnlyRefusal(definition, scope) {
  if (!scope?.summariesOnly) return null;
  const data = resultDataOf(definition);
  if (data === 'summaries') return null;
  const what = data === 'cells' ? CELL_LEVEL_READS[definition.type] : 'what it sends is not known to be names and summaries only';
  return refusalSentence(definition, `it would send ${what}`);
}

/**
 * A refusal of the switch's. Cellucid's own words it quotes (the switch, the
 * action's title) are in typographic quotes; a name it quotes (a field, a
 * page) is in straight quotes, which the tool error marks as data
 * (`mcp-content.js` `refusalText`).
 */
function refusalSentence(definition, why) {
  return `The person set this dataset to “${SUMMARIES_ONLY_LABEL}” in Cellucid, so “${definition.title}” was not done: ${why}. `
    + 'Work from names, counts and summaries of groups the dataset or the person defines (the categories of a field, a field summarized per category, the analyses\' results); '
    + `the person can change it in Cellucid (${SUMMARIES_ONLY_PLACE}). Do not try again.`;
}

// ------------------------------------------------- Single-cell statistics

/** A table column that is one cell's own value: a minimum, a maximum, a median, a quantile. */
export const SINGLE_CELL_COLUMN = /(^|_)(min|max|minimum|maximum|median|quantile|percentile|q\d+)(_|$)/i;

/**
 * The single-cell statistics each summary read's result holds: object keys
 * (anywhere in the result) and table columns (`columns` with `rows`).
 * `tests/agent-data-guard.test.mjs` fails on a summary read whose result
 * schema names such a statistic not listed here (or in `NOT_CELL_STATISTICS`).
 */
export const SINGLE_CELL_STATISTICS = Object.freeze({
  'field.summary': Object.freeze({ keys: Object.freeze(['min', 'max', 'median']) }),
  'analysis.result': Object.freeze({ columns: SINGLE_CELL_COLUMN }),
});

/** Keys named like a statistic that are not of cells (a setting's bounds). */
export const NOT_CELL_STATISTICS = Object.freeze({ 'settings.list': Object.freeze(['min', 'max']) });

/**
 * `json` (a summary read's result) without its single-cell statistics: each
 * listed key's value null, each listed column gone from the table. Returns
 * the result and the names left out (none: the same object).
 * @param {string} type
 * @param {unknown} json
 * @returns {{json: unknown, leftOut: string[]}}
 */
export function withoutSingleCellStatistics(type, json) {
  const rule = SINGLE_CELL_STATISTICS[type];
  if (rule === undefined || json === null || typeof json !== 'object') return { json, leftOut: [] };
  const leftOut = new Set();
  const keys = new Set(rule.keys ?? []);
  const walk = value => {
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== 'object') return value;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      // A key is the data's own (a category named `__proto__` too): an own property, never the prototype.
      if (keys.has(key) && (typeof item === 'number' || item === null)) {
        if (item !== null) leftOut.add(key);
        setOwnDataProperty(out, key, null);
      } else {
        setOwnDataProperty(out, key, walk(item));
      }
    }
    if (rule.columns && Array.isArray(out.columns) && Array.isArray(out.rows)) {
      const dropped = out.columns.map((column, index) => (typeof column === 'string' && rule.columns.test(column) ? index : -1)).filter(index => index !== -1);
      if (dropped.length > 0) {
        for (const index of dropped) leftOut.add(out.columns[index]);
        out.columns = out.columns.filter((_, index) => !dropped.includes(index));
        out.rows = out.rows.map(row => (Array.isArray(row) ? row.filter((_, index) => !dropped.includes(index)) : row));
      }
    }
    return out;
  };
  const reduced = walk(json);
  return leftOut.size === 0 ? { json, leftOut: [] } : { json: reduced, leftOut: [...leftOut] };
}

/** The note that says which single-cell statistics were left out. */
export function statisticsLeftOutNote(names) {
  return `[Cellucid: ${names.join(', ')} left out: each is one cell's own value, and this dataset is set to “${SUMMARIES_ONLY_LABEL}”.]`;
}

// ----------------------------------------------------------- Shaped groups

/**
 * The groups a value summary is of, by read: what to check against what an
 * agent shaped (`scope.shaped`). `params`: before it runs, from its
 * parameters; `inputs`: reads whose results name them (made by the tool
 * call, as the same agent), checked with the result.
 */
export const SHAPED_INPUTS = Object.freeze({
  'field.summary': Object.freeze({ fields: params => [params.by?.key, params.within?.field?.key].filter(key => key !== undefined) }),
  'vector-field.summary': Object.freeze({ fields: params => [params.by?.key] }),
  'analysis.result': Object.freeze({
    inputs: params => [{ type: `analysis.${params.analysis}.get`, params: params.in === undefined ? {} : { in: params.in } }],
  }),
});

/** Every string in a JSON value (an analysis's settings, its pages). */
function stringsOf(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsOf(item, out);
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) stringsOf(item, out);
  return out;
}

/**
 * The sentence an agent reads when a value summary is of a group an agent
 * shaped by naming cells, or null. `inputs`: the results of the read's
 * `SHAPED_INPUTS` reads, as JSON (left out before it runs).
 * @param {{type: string, title: string}} definition
 * @param {object} params
 * @param {{summariesOnly: boolean, shaped?: {page: Function, field: Function}}} scope
 * @param {unknown[]} [inputs]
 */
export function shapedRefusal(definition, params, scope, inputs = []) {
  const rule = SHAPED_INPUTS[definition.type];
  if (!scope?.summariesOnly || rule === undefined || scope.shaped === undefined) return null;
  const fields = (rule.fields?.(params) ?? []).filter(key => typeof key === 'string');
  const named = stringsOf(inputs);
  const shapedField = [...fields, ...named].find(key => scope.shaped.field(key));
  const shapedPage = named.find(name => scope.shaped.page(name));
  const what = shapedField !== undefined ? `the field ${quoteName(shapedField)}` : shapedPage !== undefined ? `the page ${quoteName(shapedPage)}` : null;
  if (what === null) return null;
  return refusalSentence(definition, `it would summarize values over ${what}, whose groups an agent made by naming cells`);
}

/** The sentence when what a value summary was computed on cannot be read (it is not sent). */
export function unknownGroupsRefusal(definition) {
  return refusalSentence(definition, 'what it was computed on could not be read, so it is not known to be of groups an agent did not make');
}

/** The reads a value summary's groups are named by (`SHAPED_INPUTS`), to make with the read. */
export function shapedInputReads(definition, params) {
  return SHAPED_INPUTS[definition.type]?.inputs?.(params) ?? [];
}


/** The note that stands for a picture left out while the switch is on. */
export function pictureLeftOutNote(index) {
  return `[Cellucid: picture ${index} is left out: this dataset is set to “${SUMMARIES_ONLY_LABEL}”.]`;
}

// --------------------------------------------------------- Sent again

/**
 * What an earlier tool result of a conversation is sent as, now that the
 * dataset is set to names and summaries only: a model's request carries the
 * conversation again each time, so a result read before the switch was on
 * (`result.summariesOnly` not true) is withheld when it could hold values of
 * cells (a cell-level or unclassified read, a summary with single-cell
 * statistics or of groups an agent shaped), and its pictures are left out;
 * one sentence says so. A result made under the switch is sent as it was.
 * @param {{type: string, effect: string, result?: object|null}|null} definition - the tool's action (null: not an action)
 * @param {{content: object[], isError: boolean, summariesOnly?: boolean}} result
 * @returns {object[]}
 */
export function earlierResultContent(definition, result) {
  if (result.summariesOnly === true || result.isError || definition === null) return result.content;
  const data = resultDataOf(definition);
  const risky = data !== 'summaries' || Object.hasOwn(SINGLE_CELL_STATISTICS, definition.type) || Object.hasOwn(SHAPED_INPUTS, definition.type);
  if (risky) {
    return [{ type: 'text', text: `[Cellucid: this result is withheld: it was read before the dataset was set to “${SUMMARIES_ONLY_LABEL}”, and it may hold values of cells. Read it again if you need it.]` }];
  }
  if (!result.content.some(item => item.type === 'image')) return result.content;
  return [...result.content.filter(item => item.type !== 'image'),
    { type: 'text', text: `[Cellucid: its pictures are withheld: they were taken before the dataset was set to “${SUMMARIES_ONLY_LABEL}”.]` }];
}
