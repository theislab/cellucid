/**
 * @fileoverview The action catalog as MCP tools: what Claude and ChatGPT
 * see when they list Cellucid's tools.
 *
 * Every action is one tool, named by `toolNameOf` (`history.get` →
 * `history_get`), with its parameter schema as the input schema and its
 * title. The annotations come from the definition, so a new action is a new
 * tool with the right hints without code here:
 *
 * - `readOnlyHint` for a read (`effect: 'read'`): it changes nothing; a move
 *   of the history (`effect: 'history'`: undo, redo, a jump) changes what is
 *   shown, so it is not read-only, and loses nothing, so it is not
 *   destructive; nor is a stop of work under way (`effect: 'control'`:
 *   a playing camera path, a running analysis); nor is opening another
 *   dataset (`effect: 'dataset'`): the
 *   open one's history stays kept in this browser; nor an act outside the
 *   state (`effect: 'outside'`: a file written, a publication, what this
 *   browser keeps), whose `confirm` says how it is destructive;
 * - `destructiveHint` when the action asks the person first (`confirm`): it
 *   writes a file, deletes what was saved, downloads a lot or publishes,
 *   which the history cannot take back; every other change is an undoable
 *   step, so it is not destructive;
 * - `openWorldHint` when it reaches beyond the open dataset (a download, a
 *   publication, or an address its parameters name: `opensLinks`);
 * - `idempotentHint` for reads.
 *
 * A change that is one undoable step says nothing of it: that is the rule,
 * said once in the instructions (`instructions.js`), and every description
 * says only its exception (a read, a move of the history, opening a dataset,
 * an act outside the dataset's state).
 *
 * **The list never changes with the person's settings**, for every way in
 * alike (the chat bar, the connector, a local agent): a model's reasoning is
 * bound to the exact tools it was given, and a changed list rewrites a
 * client's cached prompt (L26-9: a permission changed mid-session cost a
 * connector's next turn about four times its cached price and dropped its
 * earlier reasoning). What the person's permissions, the dataset's data
 * switch and their History settings make of the tools is told to the agent
 * apart: the chat bar's with the person's message, an outside agent's after
 * a tool result (`../settings-told.js`).
 *
 * The tab answers the relay's tool list with this (`relay-client.js`), and
 * the relay's bundled copy for when no tab is connected is made by the same
 * function (`scripts/generate-relay-bundle.mjs`).
 *
 * @module app/agent/bridge/mcp-tools
 */

import { toolNameOf } from '../../actions/catalog.js';
import { RELAY_STATUS_TOOL, VIEW_APP } from './relay-protocol.js';

const OPEN_WORLD_CONFIRMS = new Set(['large-download', 'publishes']);
/**
 * A detail the person's History settings leave out of the history (History
 * v2 §3.15.5: `offDomainsOf`), in the words an agent is told
 * (`notRecordedSentences`).
 */
const NOT_RECORDED = Object.freeze({
  camera: 'Camera moves are not recorded in this history (the person\'s History settings)',
  layout: 'Panels, windows and theme are not recorded in this history (the person\'s History settings)',
});
/** Cellucid's own annotation keywords (`schema.js`), each said in words to an agent instead. */
const ANNOTATION_NOTES = Object.freeze({
  'x-cells': 'Cells by their original position in the dataset (0-based).',
  'x-values': 'Numbers in the order of the cells they are of.',
});

/** The input schema an agent sees: the action's schema with Cellucid's own annotation keywords said in words. */
function toolSchemaOf(schema) {
  if (Array.isArray(schema)) return schema.map(toolSchemaOf);
  if (schema === null || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (Object.hasOwn(ANNOTATION_NOTES, key)) continue;
    out[key] = key === 'properties'
      ? Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, toolSchemaOf(sub)]))
      : toolSchemaOf(value);
  }
  for (const [keyword, note] of Object.entries(ANNOTATION_NOTES)) {
    if (schema[keyword] !== true) continue;
    out.description = out.description === undefined ? note : `${out.description} ${note}`;
  }
  return out;
}

/**
 * What the person's History settings leave out of the history, in the words
 * an agent is told (`../settings-told.js`); empty while everything is
 * recorded.
 * @param {string[]} offDomains - `history-settings.js` `offDomainsOf`
 * @returns {string[]}
 */
export function notRecordedSentences(offDomains) {
  return offDomains.map(domain => `${NOT_RECORDED[domain]}: such a change makes no step, and Undo does not take it back.`);
}

function descriptionOf(action) {
  const sentences = [action.summary];
  if (action.effect === 'read') sentences.push('Reads only; changes nothing.');
  else if (action.effect === 'control') sentences.push('Stops work under way at once (it never waits behind it); that work\'s own step records what it changed, so this records no step.');
  else if (action.effect === 'history') sentences.push('Moves the history; records no step.');
  else if (action.effect === 'dataset') sentences.push('Replaces the open dataset, whose history stays kept in this browser (Undo does not bring it back); records no step.');
  else if (action.effect === 'outside') sentences.push('Acts outside the dataset\'s state (a file, a publication, what this browser keeps); Undo does not take it back, and it records no step.');
  // Any other change is one undoable step: the instructions say so once
  // (`instructions.js` CORE), so no description repeats it (~1,800 tokens a
  // call over the ~95 changes, measured 2026-11-11).
  return sentences.join(' ');
}

/**
 * One catalog entry (`catalogDocument(...).actions[i]`) as an MCP tool.
 * @param {object} action
 */
export function mcpToolOf(action) {
  const read = action.effect === 'read';
  const tool = {
    name: action.tool,
    title: action.title,
    description: descriptionOf(action),
    inputSchema: toolSchemaOf(action.params),
    annotations: {
      title: action.title,
      readOnlyHint: read,
      destructiveHint: !read && action.confirm !== null,
      idempotentHint: read,
      openWorldHint: !read && (OPEN_WORLD_CONFIRMS.has(action.confirm) || action.opensLinks === true),
    },
  };
  // A host that shows MCP Apps draws the result in the view card; the flat
  // key is the one the MCP Apps SDK writes beside it for hosts that read it
  // still. A host without MCP Apps reads the content alone.
  if (VIEW_APP.tools.includes(action.tool)) {
    tool._meta = { ui: { resourceUri: VIEW_APP.uri }, 'ui/resourceUri': VIEW_APP.uri };
  }
  return tool;
}

/**
 * Every action of a catalog document as MCP tools, in the catalog's order
 * (sorted by type), the same list whatever the person's settings (see the
 * module), so a client's cached list and the model's prompt cache stay valid.
 * @param {{schema: number, actions: object[]}} document `catalogDocument(catalog)`
 */
export function mcpToolsOf(document) {
  if (document?.schema !== 1 || !Array.isArray(document.actions)) {
    throw new TypeError('mcpToolsOf takes a catalog document of schema 1');
  }
  const names = new Set([RELAY_STATUS_TOOL.name]);
  return document.actions.map(action => {
    if (names.has(action.tool)) {
      throw new TypeError(`Tool name "${action.tool}" is taken (rename the action "${action.type}")`);
    }
    names.add(action.tool);
    return mcpToolOf(action);
  });
}

/**
 * Each tool name of a catalog with its action definition, for running a
 * call by the name an agent used.
 * @param {{list: () => readonly object[]}} catalog
 * @returns {Map<string, object>}
 */
export function toolIndexOf(catalog) {
  return new Map(catalog.list().map(definition => [toolNameOf(definition.type), definition]));
}
