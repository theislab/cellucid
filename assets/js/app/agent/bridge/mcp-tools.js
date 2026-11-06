/**
 * @fileoverview The action catalogue as MCP tools: what Claude and ChatGPT
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
 *   destructive; nor is opening another dataset (`effect: 'dataset'`): the
 *   open one's history stays kept in this browser; nor an act outside the
 *   state (`effect: 'outside'`: a file written, a publication, what this
 *   browser keeps), whose `confirm` says how it is destructive;
 * - `destructiveHint` when the action asks the person first (`confirm`): it
 *   writes a file, deletes what was saved, downloads a lot or publishes,
 *   which the history cannot take back; every other change is an undoable
 *   step, so it is not destructive;
 * - `openWorldHint` when it reaches beyond the open dataset (a download or a
 *   publication);
 * - `idempotentHint` for reads.
 *
 * A description also says what the person's History settings make of the
 * action: one that changes only a detail they leave out of the history
 * (camera moves; panels, windows and theme) says it is not recorded
 * (History v2 §3.15.5: "camera moves are not recorded in this history").
 *
 * The tab answers the relay's tool list with this (`relay-client.js`), and
 * the relay's bundled copy for when no tab is connected is made by the same
 * function (`scripts/generate-relay-bundle.mjs`).
 *
 * @module app/agent/bridge/mcp-tools
 */

import { toolNameOf } from '../../actions/catalog.js';
import { RELAY_STATUS_TOOL, VIEW_APP } from './relay-protocol.js';

const CONFIRM_SENTENCES = Object.freeze({
  'writes-file': 'Cellucid asks the person before it writes the file.',
  'deletes-saved': 'Cellucid asks the person before it deletes what was saved.',
  'large-download': 'Cellucid asks the person before a large download starts.',
  publishes: 'Cellucid asks the person before it publishes.',
  'pauses-recording': 'Cellucid asks the person before it pauses the history.',
});
/** What the person's settings make of a kind of action for one connection (`permissionOf`). */
export const AGENT_PERMISSIONS = Object.freeze(['ask', 'allow', 'deny']);
const CHANGE_ASKED = 'The person\'s settings ask them before each change: Cellucid asks, and you wait for the answer.';
const PERMISSION_SENTENCES = Object.freeze({
  allow: 'The person\'s settings let this run without asking.',
  deny: 'The person\'s settings refuse this for you: do not call it; tell the person, who can change it in Cellucid.',
});
const OPEN_WORLD_CONFIRMS = new Set(['large-download', 'publishes']);
/**
 * A detail the person's History settings leave out of the history (History
 * v2 §3.15.5: `offDomainsOf`), said of an action that changes nothing else.
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
 * the tool list uses (the chat bar's model is told it with the person's
 * message, `chat/index.js`); empty while everything is recorded.
 * @param {string[]} offDomains - `history-settings.js` `offDomainsOf`
 * @returns {string[]}
 */
export function notRecordedSentences(offDomains) {
  return offDomains.map(domain => `${NOT_RECORDED[domain]}: such a change makes no step, and Undo does not take it back.`);
}

function descriptionOf(action, permission, offDomains) {
  const sentences = [action.summary];
  const notRecorded = action.touches.length > 0 && action.touches.every(domain => offDomains.includes(domain));
  if (action.effect === 'read') sentences.push('Reads only; changes nothing.');
  else if (action.effect === 'history') sentences.push('Moves the history; records no step.');
  else if (action.effect === 'dataset') sentences.push('Replaces the open dataset, whose history stays kept in this browser (Undo does not bring it back); records no step.');
  else if (action.effect === 'outside') sentences.push('Acts outside the dataset\'s state (a file, a publication, what this browser keeps); Undo does not take it back, and it records no step.');
  else if (action.confirm === null && notRecorded) sentences.push(...new Set(action.touches.map(domain => `${NOT_RECORDED[domain]}: this change makes no step, and Undo does not take it back.`)));
  else if (action.confirm === null) sentences.push('Recorded as one step of the person\'s history; it can be undone.');
  if (action.effect === 'read' || permission === null) return sentences.join(' ');
  if (action.confirm !== null) {
    sentences.push(permission === 'ask' ? CONFIRM_SENTENCES[action.confirm] : PERMISSION_SENTENCES[permission]);
  } else if (permission === 'ask') {
    sentences.push(CHANGE_ASKED);
  } else if (permission === 'deny') {
    sentences.push(PERMISSION_SENTENCES.deny);
  }
  return sentences.join(' ');
}

/**
 * The kind of permission an action is listed under (`app/agent/presence/permissions.js`):
 * its `confirm` (what the history cannot undo), `change` for any other change,
 * null for a read.
 */
export function permissionKindOf(action) {
  if (action.effect === 'read') return null;
  return action.confirm ?? 'change';
}

/** What a connection is told of an action when no settings say otherwise: a change runs, what cannot be undone is asked. */
function defaultPermissionOf(action) {
  return permissionKindOf(action) === 'change' ? 'allow' : 'ask';
}

/**
 * One catalogue entry (`catalogDocument(...).actions[i]`) as an MCP tool.
 * `permission`: what the person's settings make of its kind
 * (`permissionKindOf`) for the connection listing it: `ask`, `allow` or
 * `deny` (by default a change runs and what cannot be undone is asked; a
 * read is never asked); null: its description says none (the agent is told
 * the permissions apart, the chat bar's model with the person's message).
 * `offDomains`: the details the person's History settings leave out of the
 * history (`history-settings.js` `offDomainsOf`): an action that changes
 * only those says it makes no step.
 * @param {object} action
 * @param {'ask'|'allow'|'deny'|null} [permission]
 * @param {{offDomains?: string[]}} [options]
 */
export function mcpToolOf(action, permission = defaultPermissionOf(action), { offDomains = [] } = {}) {
  if (permission !== null && !AGENT_PERMISSIONS.includes(permission)) throw new TypeError(`A permission is one of ${AGENT_PERMISSIONS.join(', ')}, or null`);
  const unknown = offDomains.filter(domain => !Object.hasOwn(NOT_RECORDED, domain));
  if (unknown.length > 0) throw new TypeError(`Only ${Object.keys(NOT_RECORDED).join(' and ')} can be left out of the history, not ${unknown.join(', ')}`);
  const read = action.effect === 'read';
  const tool = {
    name: action.tool,
    title: action.title,
    description: descriptionOf(action, permission, offDomains),
    inputSchema: toolSchemaOf(action.params),
    annotations: {
      title: action.title,
      readOnlyHint: read,
      destructiveHint: !read && action.confirm !== null,
      idempotentHint: read,
      openWorldHint: !read && OPEN_WORLD_CONFIRMS.has(action.confirm),
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
 * Every action of a catalogue document as MCP tools, in the catalogue's
 * order (sorted by type, so a client's cached list and the model's prompt
 * cache stay valid while nothing changes).
 *
 * @param {{schema: number, actions: object[]}} document `catalogDocument(catalog)`
 * @param {{permissionOf?: (kind: string) => ('ask'|'allow'|'deny'|null), withPermissions?: boolean}} [options] -
 *   `permissionOf`: what the person's settings make of each kind of action
 *   (`change`, or a `confirm` kind) for the connection the list is for (null
 *   or left out: the default, `defaultPermissionOf`); `withPermissions`
 *   false: no description says a permission (a list that must stay the same
 *   while the settings change: the chat bar's, whose model's reasoning is
 *   bound to the exact tools it was given; its model is told the
 *   permissions with the person's message); `offDomains`: the details
 *   the person's History settings leave out (`mcpToolOf`)
 */
export function mcpToolsOf(document, { permissionOf = () => null, withPermissions = true, offDomains = [] } = {}) {
  if (document?.schema !== 1 || !Array.isArray(document.actions)) {
    throw new TypeError('mcpToolsOf takes a catalogue document of schema 1');
  }
  const names = new Set([RELAY_STATUS_TOOL.name]);
  return document.actions.map(action => {
    if (names.has(action.tool)) {
      throw new TypeError(`Tool name "${action.tool}" is taken (rename the action "${action.type}")`);
    }
    names.add(action.tool);
    if (!withPermissions) return mcpToolOf(action, null, { offDomains });
    const kind = permissionKindOf(action);
    return mcpToolOf(action, (kind === null ? null : permissionOf(kind)) ?? defaultPermissionOf(action), { offDomains });
  });
}

/**
 * Each tool name of a catalogue with its action definition, for running a
 * call by the name an agent used.
 * @param {{list: () => readonly object[]}} catalog
 * @returns {Map<string, object>}
 */
export function toolIndexOf(catalog) {
  return new Map(catalog.list().map(definition => [toolNameOf(definition.type), definition]));
}
