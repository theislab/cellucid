/**
 * @fileoverview The action catalog: what can be done to the open dataset,
 * each thing once.
 *
 * An action is a named, parameterised change (or read) that the person, an
 * agent, a Python or R host, a session and a replay all perform the same way.
 * Its definition here is pure data plus small pure functions, importable in
 * Node, so the catalog document (`catalogDocument`) that Python, R, the
 * agent tools and the docs are generated from is made by the same code the
 * page runs. The implementation of an action is provided by the module that
 * owns the state it changes (`provide` in `dispatcher.js`).
 *
 * Definition fields:
 * - `type`: dotted name, `<group>.<verb>` or deeper (`filter.category.visibility`).
 *   It is the agent's tool name (dots become underscores), Python's method
 *   name and R's function name, so it is stable: renaming one is a breaking
 *   change for every generated surface and is caught by the catalog digest.
 * - `title`, `summary`: one line each, written for a person and an agent.
 * - `group`: the heading it is listed under (docs, tool listing, timeline filter).
 * - `params`: the parameter schema (`schema.js`). Targets are named, never
 *   positional: a field by `{source, key}`, a category by its label, a gene by
 *   its name, so a step replays on another dataset.
 * - `touches`: the state domains it changes (`domains.js`). The history keeps
 *   their values before and after the step; undo puts back the before-values.
 * - `effect`: `state` (the data's meaning: fields, labels, filters, highlights,
 *   results), `view` (how it is shown: coloring, camera, render settings,
 *   views), `layout` (panels, theme), `read` (changes nothing, records no
 *   step), `history` (moves or edits the history itself: undo, redo, a
 *   jump, a branch's name, a note, a delete; it records no step and touches
 *   no domain, and an edit of the history's structure is kept in its
 *   journal, from which it can be undone), `dataset` (opens another
 *   dataset in place of the open one: the open one's history stays kept in
 *   this browser and the new one starts its own, so it records no step and
 *   touches no domain), or `outside` (acts outside the open dataset's state
 *   and its history: writes a file the person receives, publishes, or
 *   removes what this browser keeps for later visits; it records no step,
 *   touches no domain, and what it does the history cannot take back, so it
 *   names its `confirm` unless it only keeps something new in this browser).
 * - `reads`: required. Its **result inputs**: what its result is computed
 *   from beyond its parameters and the domains it touches
 *   (`ACTION_READ_INPUTS`: state domains, and `history` for another
 *   branch's tip), distinct; empty for an action that records no step. The
 *   open cells, the data mapping and the fields' values an analysis reads,
 *   the cells the filters leave a "highlight the visible cells" takes, the
 *   highlight pages a field is made from. A step records the value hash of
 *   each as it was (`app/history/model.js` `Step.reads`): when one differs
 *   later on the path, the step's result is **stale** (`provenance.js`),
 *   whatever the action.
 * - `captures`: optional (none by default). The inputs of `reads` its
 *   result holds the value of itself (a keyframe holds the camera it was
 *   saved at): replay still knows the step read them, but a later change of
 *   one never makes the step stale (`provenance.js`).
 * - `context`: optional (none by default). The **name context**: the state
 *   its parameters' names resolve in, which its result does not follow (a
 *   field's name in `field-overlays`, the view in focus in `views`, a gene's
 *   name in `mapping`, a step's id in `history`). Distinct, never one it
 *   reads or touches; empty for an action that records no step. A rename or
 *   a focus change makes no result stale. Applied in two states that differ
 *   only in domains it neither touches, reads nor resolves names in, an
 *   action gives the same after-values (`tests/action-reads-contract.test.mjs`);
 *   a deleted step's re-apply runs again a step whose inputs or name context
 *   changed.
 * - `confirm`: null, or why the person is asked first when an agent acts:
 *   `writes-file`, `deletes-saved`, `large-download`, `publishes`, and
 *   `pauses-recording` (while the history is paused, an agent's change
 *   cannot be undone on its own). Anything the history can undo needs no
 *   confirmation.
 * - `opensLinks`: true for an action that may fetch an address its
 *   parameters name (a dataset's link, an accession, a server): its
 *   implementation asks the person first (`ctx.confirmLink(address)`, of the
 *   permission kind `unseen-link`) when an agent names an address the person
 *   has not seen in this tab (`ui/modules/seen-addresses.js`), before
 *   anything is requested, so an agent misled by text it read cannot make
 *   the tab send what it read to any host. False by default.
 * - `confirmAt`: when the person is asked: `start` (before the action runs,
 *   the default) or `handler` (its implementation asks, with
 *   `ctx.confirm(detail)`, once it knows what the cost is: a download's
 *   size is known only once its link is resolved, and a download already
 *   kept in this browser costs nothing to ask about).
 * - `coalesce(params)`: optional; consecutive steps with the same key merge
 *   into one (a slider drag, a camera gesture).
 * - `supersede`: a newer dispatch of the same type cancels an unfinished one
 *   (choosing another field while the first is still read).
 * - `keepsWhenStopped`: stopped while it runs (the person's Stop of an agent
 *   turn), it keeps what it did and records it, where any other change is put
 *   back (false by default): a film stopped stays at the frame it stopped on
 *   (`camera-path.play`, whose camera stays where the
 *   path stopped, as a pause and `camera-path.stop` leave it). Its
 *   implementation hears the signal, ends where it is and answers. Only for
 *   an action that records a step.
 * - `rerun`: whether the same params dispatched again bring a step's own
 *   result up to date with its inputs (false by default): the analysis run
 *   again, a category or range group given the cells the view shows now.
 *   Only such a stale step gets Run again in the history
 *   (`ui/modules/state/step-details.js`); an action that adds another of
 *   what it made (a kept view, a copy of a field, a keyframe) or only sets
 *   options does not. Needs `reads` (only a step with inputs is stale).
 * - `describe(params, outcome, quote)`: the timeline label and the sentence
 *   the methods paragraph uses; the confirm card and a decline say it too.
 *   Every name it writes goes through `quote` (`targets/names.js`):
 *   `quote(name)` a quoted name, `quote.bare(name)` one shown without
 *   quotes. Left out, it is `PLAIN_QUOTE` (a person reads it); a sentence an
 *   agent reads passes `MARKED_QUOTE`, so a name written by others is marked
 *   as data. `code(params)`: one line of pseudocode.
 * - `acts`: for an act outside the state that cannot be taken back (effect
 *   `outside` with a `confirm`), how it is counted where an agent's turn is
 *   told: `{one, other}` ("vote published", "votes published"), and
 *   `when(params, outcome)` when it did nothing outside some times (a vote
 *   that changed nothing published nothing). The activity line ("1 vote
 *   published, not undoable"), the history's turn record and Undo turn say
 *   what stays.
 * - `version`: for an action whose steps are recorded (effect `state`,
 *   `view` or `layout`), the version of its parameters, a whole number from
 *   1 (1 when left out); null for every other effect, which records no step.
 *   A step records it (`app/history/model.js` `Step.v`), so a history
 *   recorded with older parameters keeps replaying: `upgradeParams` brings
 *   them to this version first. A change to the shape of `params`
 *   (`actionParamsShape`: the schema without its words) bumps it, adds the
 *   upgrader and keeps examples of the new version
 *   (`tests/fixtures/action-versions/<type>@<version>.json`,
 *   `scripts/generate-action-versions.mjs`); the drift test fails on a
 *   shape that differs from its version's kept one.
 * - `upgrade`: `{<from>: params => params}`, one pure function for each
 *   earlier version (1 … version - 1), taking parameters of version `from`
 *   to those of version `from + 1`. None for version 1. When parameters of
 *   version `from` hold nothing the next version could be made from (a
 *   column recorded as one value per cell, where the next version names the
 *   outcome of each category), its upgrader is `valuesOnlyUpgrade(reason)`:
 *   such a step is not applied again by its parameters; a replay on the
 *   dataset it was recorded on puts its values back, and flags it on another
 *   with `reason` (`app/history/history.js` `replaySteps`).
 *
 * @module app/actions/catalog
 */

import { assertActionSchema, exampleOf, schemaProblem } from './schema.js';
import { DOMAIN_IDS } from './domains.js';

/**
 * What an act outside the state did that no undo takes back, counted
 * (`acts`): its words, or null when it did nothing outside (or is not such
 * an act).
 * @param {{acts: {one: string, other: string, when: Function}|null}} definition
 * @param {object} params
 * @param {unknown} outcome
 * @returns {{one: string, other: string}|null}
 */
export function outsideActOf(definition, params, outcome) {
  if (definition?.acts == null) return null;
  try {
    return definition.acts.when(params, outcome) === false ? null : { one: definition.acts.one, other: definition.acts.other };
  } catch {
    return { one: definition.acts.one, other: definition.acts.other };
  }
}

export const ACTION_EFFECTS = Object.freeze(['state', 'view', 'layout', 'read', 'control', 'history', 'dataset', 'outside']);

/**
 * Whether an action of this effect records no step: a read, a control of
 * work under way (`control`: it stops a playing camera path or a running
 * analysis, whose own step records what it changed), a move of the history
 * itself, opening another dataset (whose history starts anew; the open
 * one's stays kept in this browser while Autosave keeps it, and steps it
 * does not keep are asked about first: `app/unkept-work-guard.js`), or an
 * act outside the state (a file
 * written, a publication, what this browser keeps removed). Such an action
 * touches no domain, is run without the recorder and the history's gate
 * (`dispatcher.js`), and answers with its result rather than a step.
 *
 * A control must be stepless: touching the domain of the work it stops, it
 * would wait in order behind that work and run only once there was nothing
 * left to stop (`camera-path.stop`, a view change on the camera, would wait
 * for the `camera-path.play` it was sent to stop, then be refused "not
 * playing").
 *
 * @param {string} effect
 */
export function isSteplessEffect(effect) {
  return effect === 'read' || effect === 'control' || effect === 'history' || effect === 'dataset' || effect === 'outside';
}

export const ACTION_CONFIRMS = Object.freeze(['writes-file', 'deletes-saved', 'large-download', 'publishes', 'pauses-recording']);

/**
 * What an action's `reads` may name: a state domain, or `history` (another
 * branch's tip, which a kept view of a branch shows).
 */
export const ACTION_READ_INPUTS = Object.freeze([...DOMAIN_IDS, 'history']);

/** When the person is asked about a `confirm` action: before it runs, or by its implementation once it knows. */
export const ACTION_CONFIRM_TIMES = Object.freeze(['start', 'handler']);

/**
 * A dotted action type. The viewer protocol checks a host's `action` against
 * its own copy (`data/viewer-protocol.js`, which may not import the app); a
 * test keeps the two the same.
 */
export const ACTION_TYPE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/;
const DEFINITION_KEYS = new Set([
  'type', 'title', 'summary', 'group', 'params', 'touches', 'reads', 'captures', 'context', 'effect', 'confirm', 'confirmAt', 'opensLinks',
  'coalesce', 'supersede', 'keepsWhenStopped', 'rerun', 'describe', 'code', 'result', 'version', 'upgrade', 'acts',
]);

function requireLine(value, label, type) {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.includes('\n')) {
    throw new TypeError(`Action "${type}" ${label} must be one trimmed line`);
  }
  return value;
}

/**
 * Check and freeze one action definition.
 * @param {object} definition
 */
export function defineAction(definition) {
  if (definition === null || typeof definition !== 'object') throw new TypeError('An action definition must be an object');
  const type = definition.type;
  if (typeof type !== 'string' || !ACTION_TYPE_PATTERN.test(type)) {
    throw new TypeError(`Action type ${JSON.stringify(type)} must be dotted lowercase words`);
  }
  for (const key of Object.keys(definition)) {
    if (!DEFINITION_KEYS.has(key)) throw new TypeError(`Action "${type}" has unknown field "${key}"`);
  }
  requireLine(definition.title, 'title', type);
  requireLine(definition.summary, 'summary', type);
  requireLine(definition.group, 'group', type);
  assertActionSchema(definition.params, `${type} params`);
  if (definition.params.type !== 'object') throw new TypeError(`Action "${type}" params must be an object schema`);
  if (!ACTION_EFFECTS.includes(definition.effect)) throw new TypeError(`Action "${type}" effect must be one of ${ACTION_EFFECTS.join(', ')}`);
  const touches = definition.touches ?? [];
  if (!Array.isArray(touches) || new Set(touches).size !== touches.length) {
    throw new TypeError(`Action "${type}" touches must list distinct domains`);
  }
  for (const domain of touches) {
    if (!DOMAIN_IDS.includes(domain)) throw new TypeError(`Action "${type}" touches unknown domain "${domain}"`);
  }
  if (isSteplessEffect(definition.effect) !== (touches.length === 0)) {
    throw new TypeError(`Action "${type}": a read or a history move touches no domain, and every other action touches one`);
  }
  const reads = definition.reads;
  if (!Array.isArray(reads) || new Set(reads).size !== reads.length) {
    throw new TypeError(`Action "${type}" reads must list distinct inputs (empty when it reads none)`);
  }
  for (const input of reads) {
    if (!ACTION_READ_INPUTS.includes(input)) throw new TypeError(`Action "${type}" reads unknown input "${input}"`);
  }
  if (isSteplessEffect(definition.effect) && reads.length > 0) {
    throw new TypeError(`Action "${type}" records no step, so it records no inputs (reads is empty)`);
  }
  const captures = definition.captures ?? [];
  if (!Array.isArray(captures) || new Set(captures).size !== captures.length || captures.some(input => !reads.includes(input))) {
    throw new TypeError(`Action "${type}" captures must list distinct inputs it reads`);
  }
  const context = definition.context ?? [];
  if (!Array.isArray(context) || new Set(context).size !== context.length) {
    throw new TypeError(`Action "${type}" context must list distinct inputs`);
  }
  for (const input of context) {
    if (!ACTION_READ_INPUTS.includes(input)) throw new TypeError(`Action "${type}" context names unknown input "${input}"`);
    if (reads.includes(input) || touches.includes(input)) {
      throw new TypeError(`Action "${type}" names "${input}" as context and as an input it reads or touches; it is one of them`);
    }
  }
  if (isSteplessEffect(definition.effect) && context.length > 0) {
    throw new TypeError(`Action "${type}" records no step, so it has no name context (context is empty)`);
  }
  const confirm = definition.confirm ?? null;
  if (confirm !== null && !ACTION_CONFIRMS.includes(confirm)) {
    throw new TypeError(`Action "${type}" confirm must be null or one of ${ACTION_CONFIRMS.join(', ')}`);
  }
  const confirmAt = definition.confirmAt ?? 'start';
  if (!ACTION_CONFIRM_TIMES.includes(confirmAt)) {
    throw new TypeError(`Action "${type}" confirmAt must be one of ${ACTION_CONFIRM_TIMES.join(', ')}`);
  }
  if (definition.confirmAt !== undefined && confirm === null) {
    throw new TypeError(`Action "${type}" says when to ask (confirmAt) but asks about nothing (confirm is null)`);
  }
  if (definition.opensLinks !== undefined && typeof definition.opensLinks !== 'boolean') {
    throw new TypeError(`Action "${type}" opensLinks must be a boolean`);
  }
  if (definition.opensLinks === true && definition.effect === 'read') {
    throw new TypeError(`Action "${type}" is a read, which fetches nothing an agent names (opensLinks)`);
  }
  for (const key of ['describe', 'code']) {
    if (typeof definition[key] !== 'function') throw new TypeError(`Action "${type}" needs ${key}(params)`);
  }
  if (definition.coalesce !== undefined && typeof definition.coalesce !== 'function') {
    throw new TypeError(`Action "${type}" coalesce must be a function`);
  }
  if (definition.supersede !== undefined && typeof definition.supersede !== 'boolean') {
    throw new TypeError(`Action "${type}" supersede must be a boolean`);
  }
  if (definition.keepsWhenStopped !== undefined && typeof definition.keepsWhenStopped !== 'boolean') {
    throw new TypeError(`Action "${type}" keepsWhenStopped must be a boolean`);
  }
  if (definition.keepsWhenStopped === true && isSteplessEffect(definition.effect)) {
    throw new TypeError(`Action "${type}" records no step, so there is nothing a Stop could keep (keepsWhenStopped)`);
  }
  if (definition.rerun !== undefined && typeof definition.rerun !== 'boolean') {
    throw new TypeError(`Action "${type}" rerun must be a boolean`);
  }
  if (definition.rerun === true && reads.length === 0) {
    throw new TypeError(`Action "${type}" is run again on a stale step (rerun), but reads no input, so no step of it is ever stale`);
  }
  if (definition.result !== undefined) assertActionSchema(definition.result, `${type} result`);
  const counted = definition.effect === 'outside' && confirm !== null;
  if (counted !== (definition.acts !== undefined)) {
    throw new TypeError(`Action "${type}" ${counted ? 'acts outside the state where no undo reaches, so it says how it is counted (acts)' : 'is no act outside the state that cannot be taken back, so it has no acts'}`);
  }
  if (counted) {
    const { one, other, when } = definition.acts;
    requireLine(one, 'acts.one', type);
    requireLine(other, 'acts.other', type);
    if (when !== undefined && typeof when !== 'function') throw new TypeError(`Action "${type}" acts.when must be a function`);
    for (const key of Object.keys(definition.acts)) {
      if (!['one', 'other', 'when'].includes(key)) throw new TypeError(`Action "${type}" acts has unknown field "${key}"`);
    }
  }
  const recorded = !isSteplessEffect(definition.effect);
  if (!recorded && (definition.version !== undefined || definition.upgrade !== undefined)) {
    throw new TypeError(`Action "${type}" records no step, so its parameters have no version (version, upgrade)`);
  }
  const version = recorded ? definition.version ?? 1 : null;
  if (recorded && (!Number.isSafeInteger(version) || version < 1)) throw new TypeError(`Action "${type}" version must be a whole number from 1`);
  const upgrade = definition.upgrade ?? {};
  if (upgrade === null || typeof upgrade !== 'object' || Array.isArray(upgrade)) {
    throw new TypeError(`Action "${type}" upgrade must map each earlier version to a function`);
  }
  const earlier = Array.from({ length: recorded ? version - 1 : 0 }, (_, index) => String(index + 1));
  const given = Object.keys(upgrade).sort((a, b) => Number(a) - Number(b));
  if (given.length !== earlier.length || given.some((key, index) => key !== earlier[index])) {
    throw new TypeError(`Action "${type}" is at version ${version}, so upgrade must hold exactly one function for each of ${earlier.length === 0 ? 'no earlier version' : `versions ${earlier.join(', ')}`}`);
  }
  for (const key of given) {
    if (typeof upgrade[key] !== 'function') throw new TypeError(`Action "${type}" upgrade from version ${key} must be a function`);
  }
  return Object.freeze({
    ...definition,
    touches: Object.freeze([...touches]),
    reads: Object.freeze([...reads]),
    captures: Object.freeze([...captures]),
    context: Object.freeze([...context]),
    confirm,
    confirmAt,
    opensLinks: definition.opensLinks === true,
    supersede: definition.supersede === true,
    keepsWhenStopped: definition.keepsWhenStopped === true,
    rerun: definition.rerun === true,
    coalesce: definition.coalesce ?? null,
    result: definition.result ?? null,
    acts: counted ? Object.freeze({ one: definition.acts.one, other: definition.acts.other, when: definition.acts.when ?? (() => true) }) : null,
    version,
    upgrade: Object.freeze({ ...upgrade }),
  });
}

/** Words of a schema that are not its shape: changing them changes no parameter. */
const SCHEMA_WORDS = new Set(['description', 'title', 'examples']);

/**
 * A params schema without its words (`description`, `title`, `examples`):
 * what a version of an action's parameters is. A new, renamed or retyped
 * parameter, another enumeration, bound or default changes it; rewording a
 * description does not. The version files and a session's action stamps
 * (`Session.actions[].params`, the SHA-256 of its canonical JSON) hold it.
 * @param {object} schema
 */
export function actionParamsShape(schema) {
  if (Array.isArray(schema)) return schema.map(actionParamsShape);
  if (schema === null || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (SCHEMA_WORDS.has(key)) continue;
    // `properties` names parameters: its keys are kept whatever they are called.
    out[key] = key === 'properties'
      ? Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, actionParamsShape(sub)]))
      : actionParamsShape(value);
  }
  return out;
}

/**
 * Parameters recorded with version `from` of an action, brought to its
 * version now, one upgrader at a time (what a replay dispatches), on a
 * copy: the recorded parameters are never changed. The result is
 * checked by the caller against the schema now, as any parameters are.
 * Throws `ParamsNotUpgradable` when an upgrader on the way is a
 * `valuesOnlyUpgrade`.
 *
 * @param {{type: string, version: number, upgrade: Record<string, (params: object) => object>}} definition
 * @param {number} from - the version the parameters were recorded with (`Step.v`)
 * @param {object} params
 * @returns {object}
 */
export function upgradeParams(definition, from, params) {
  if (definition.version === null) throw new RangeError(`"${definition.type}" records no step, so its parameters have no version`);
  if (!Number.isSafeInteger(from) || from < 1) throw new RangeError(`An action version is a whole number from 1, not ${from}`);
  if (from > definition.version) {
    throw new RangeError(`"${definition.type}" was recorded with version ${from} of its parameters, newer than this catalog's ${definition.version}`);
  }
  let upgraded = structuredClone(params);
  for (let version = from; version < definition.version; version++) upgraded = definition.upgrade[String(version)](upgraded);
  return upgraded;
}

/**
 * Why parameters recorded with an earlier version of an action cannot be
 * brought to its version now (`valuesOnlyUpgrade`): the step is put back by
 * its values on the dataset it was recorded on, and flagged with `reason`
 * on another.
 */
export class ParamsNotUpgradable extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'ParamsNotUpgradable';
    this.reason = reason;
  }
}

/**
 * The upgrader of an earlier version whose parameters hold nothing the next
 * version can be made from: it refuses with `reason` (`ParamsNotUpgradable`),
 * one sentence a replay's report shows.
 * @param {string} reason
 * @returns {(params: object) => never}
 */
export function valuesOnlyUpgrade(reason) {
  if (typeof reason !== 'string' || reason.length === 0 || reason.trim() !== reason) {
    throw new TypeError('A values-only upgrade says why, in one trimmed sentence');
  }
  return () => { throw new ParamsNotUpgradable(reason); };
}

/**
 * A catalog over action definitions: unique types, looked up by type.
 * @param {Iterable<object>} definitions frozen results of `defineAction`
 */
export function createActionCatalog(definitions) {
  const byType = new Map();
  for (const definition of definitions) {
    if (byType.has(definition.type)) throw new TypeError(`Action "${definition.type}" is defined twice`);
    byType.set(definition.type, definition);
  }
  const sorted = Object.freeze([...byType.values()].sort((a, b) => a.type.localeCompare(b.type)));
  return Object.freeze({
    /** @param {string} type */
    get(type) {
      const definition = byType.get(type);
      if (definition === undefined) {
        throw new RangeError(`There is no action "${type}"`);
      }
      return definition;
    },
    has: type => byType.has(type),
    list: () => sorted,
    /**
     * Check `params` against the action's schema, or throw one sentence that
     * names the parameter.
     */
    check(type, params) {
      const definition = this.get(type);
      const problem = schemaProblem(definition.params, params, type);
      if (problem !== null) throw new TypeError(problem);
      return definition;
    },
  });
}

/** The tool name an agent calls an action by (`filter.category.visibility` → `filter_category_visibility`). */
export function toolNameOf(type) {
  return type.replaceAll('.', '_').replaceAll('-', '_');
}

/**
 * The language-neutral catalog document: Python and R generate their
 * methods from it, the agent tools are built from it, the docs reference
 * lists it. Byte-stable for a given catalog (sorted, no functions).
 * @param {ReturnType<typeof createActionCatalog>} catalog
 */
export function catalogDocument(catalog) {
  return {
    schema: 1,
    actions: catalog.list().map(definition => ({
      type: definition.type,
      tool: toolNameOf(definition.type),
      title: definition.title,
      summary: definition.summary,
      group: definition.group,
      version: definition.version,
      effect: definition.effect,
      confirm: definition.confirm,
      opensLinks: definition.opensLinks,
      touches: [...definition.touches],
      reads: [...definition.reads],
      captures: [...definition.captures],
      context: [...definition.context],
      params: definition.params,
      result: definition.result,
      example: exampleOf(definition.params),
    })),
  };
}
