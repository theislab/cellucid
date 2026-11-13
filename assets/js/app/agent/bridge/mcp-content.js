/**
 * @fileoverview What an action's outcome looks like to an agent: MCP tool
 * result content.
 *
 * - A read, and a move of the history (undo, redo, a jump), answers with
 *   its result; a change answers with the step it made
 *   (`{step: {id, label, turn}, result}`: `turn` for an agent's step). A change that made no step
 *   (`step: null`) says why in a sentence after the data
 *   (`UNRECORDED_NOTES`): nothing changed (it was so already: the agent
 *   must not tell the person it did it), or the change is not recorded
 *   (recording paused, a kind the person does not record, …). Both as JSON in one text item, between the data tags
 *   (`relay-protocol.js` `RESULT_DATA_TAGS`: `<cellucid-data>…</cellucid-data>`):
 *   every MCP client passes text to its model, the JSON keeps names, counts
 *   and tables exact, and the tags mark everything in it (names, labels,
 *   notes, a dataset's own text, written by others) as data the agent never
 *   takes for instructions; nothing in it can close them. Cellucid's own
 *   sentences (a picture left out, a result cut) follow the data.
 * - Values JSON cannot carry are converted, never dropped silently
 *   (`app/actions/outcome.js`, as a host's answer is).
 * - A picture becomes an `image` content item, and the JSON says where it
 *   was (`{"image": 1, "mimeType": "image/png", "bytes": …}`): a `Blob` of
 *   an image type anywhere in the result, and a string the action's result
 *   schema marks as an image's bytes (`contentEncoding: 'base64'`,
 *   `contentMediaType: 'image/…'`, as `view.picture`'s PNG: what a notebook
 *   receives as text, an agent sees). A picture larger than a chat takes
 *   (`RESULT_IMAGE_MAX_SIDE` pixels a side, `RESULT_IMAGE_MAX_BYTES`) is
 *   left out with a sentence that says so, never sent to be refused.
 * - While the dataset is set to names and summaries only (`summariesOnly`,
 *   `data-guard.js`), no picture is sent and the statistics that are one
 *   cell's own value (a minimum, a maximum, a median) are left out, each
 *   said after the data.
 * - Text longer than a chat accepts (`RESULT_TEXT_CHARS`) is cut with a
 *   sentence that states both counts and how to read the rest, never
 *   silently.
 * - A failure is a tool error (`isError: true`) with one sentence the model
 *   can act on (the action's own refusal names what did not match). The
 *   names a sentence quotes (a field, a category, a page, a branch: written
 *   by others) are marked as data the same way where the sentence is built
 *   (`targets/names.js` `quoteName`), and no other `<` in it can open or
 *   close the marks (`refusalText`).
 *
 * @module app/agent/bridge/mcp-content
 */

import { isSteplessEffect } from '../../actions/catalog.js';
import { ActionRefused } from '../../actions/dispatcher.js';
import { MARKED_NAME, plainSentence } from '../../actions/targets/names.js';
import { outcomeAsJson } from '../../actions/outcome.js';
import { isCancellation } from '../../../utils/abort.js';
import { formatCount, formatCountOf } from '../../../utils/format-units.js';
import { pictureLeftOutNote, statisticsLeftOutNote, withoutSingleCellStatistics } from './data-guard.js';
import {
  RESULT_DATA_TAGS, RESULT_IMAGE_MAX_BYTES, RESULT_IMAGE_MAX_SIDE, RESULT_TEXT_CHARS, resultDataText,
} from './relay-protocol.js';
import { base64OfBytes, bytesOfBase64 } from '../../../utils/byte-text.js';
import { pngSidesOf } from '../../ui/modules/figure-export/utils/png-metadata.js';
import { lowerFirst } from '../../../utils/text-case.js';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function cutNote(total, shown) {
  return `[Cellucid: this result is ${formatCountOf(total, 'character')}; `
    + `the first ${formatCount(shown)} are shown. Ask for fewer rows or a narrower read to see the rest.]`;
}

/** Where `text` may be cut to keep at most `room` characters: never between the halves of a surrogate pair. */
function cutAt(text, room) {
  let shown = Math.max(0, room);
  const last = text.charCodeAt(shown - 1);
  if (last >= 0xd800 && last <= 0xdbff) shown -= 1;
  return shown;
}

/**
 * `text` cut to `limit` characters with a sentence that says so.
 * @param {string} text
 * @param {number} [limit]
 */
export function limitText(text, limit = RESULT_TEXT_CHARS) {
  if (text.length <= limit) return text;
  const shown = cutAt(text, limit - cutNote(text.length, limit).length - 1);
  return `${text.slice(0, shown)}\n${cutNote(text.length, shown)}`;
}

/**
 * A result's JSON as its data (`RESULT_DATA_TAGS`) followed by Cellucid's
 * `notes`, all within `limit` characters: JSON too long is cut, the tags
 * kept whole, and a sentence after them says so.
 * @param {string} json
 * @param {string[]} notes
 * @param {number} [limit]
 */
export function resultText(json, notes = [], limit = RESULT_TEXT_CHARS) {
  const data = resultDataText(json);
  const after = notes.map(note => `\n${note}`).join('');
  if (data.length + after.length <= limit) return `${data}${after}`;
  const tags = RESULT_DATA_TAGS.open.length + RESULT_DATA_TAGS.close.length;
  // The escaped text (each `<` six characters) is what is cut, so the count stated is the data's own.
  const escaped = data.slice(RESULT_DATA_TAGS.open.length, -RESULT_DATA_TAGS.close.length);
  const shown = cutAt(escaped, limit - tags - after.length - cutNote(escaped.length, limit).length - 1);
  return `${RESULT_DATA_TAGS.open}${escaped.slice(0, shown)}${RESULT_DATA_TAGS.close}${after}\n${cutNote(escaped.length, shown)}`;
}

/**
 * The data of a result's text (`resultText`): the text between the data
 * tags, which is the result's JSON (cut, when the result was), or null when
 * the text holds none.
 * @param {string} text
 * @returns {string|null}
 */
export function resultDataOf(text) {
  const start = text.indexOf(RESULT_DATA_TAGS.open);
  const end = text.indexOf(RESULT_DATA_TAGS.close);
  if (start !== 0 || end === -1) return null;
  return text.slice(RESULT_DATA_TAGS.open.length, end);
}

/** The bytes a base64 text holds. */
function base64Bytes(text) {
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return Math.floor((text.length * 3) / 4) - padding;
}

/** A PNG's width and height from its header (IHDR), or null when the bytes are not a PNG's. */
export function pngSides(base64) {
  let head;
  try {
    head = bytesOfBase64(base64.slice(0, 32));
  } catch {
    return null;
  }
  return pngSidesOf(head);
}

/** Why a chat would refuse this picture (its bytes or its size), or null. */
function imageProblem(image) {
  if (image.data.length > RESULT_IMAGE_MAX_BYTES) {
    return `${formatCountOf(base64Bytes(image.data), 'byte')}, more than a chat takes (${formatCount(RESULT_IMAGE_MAX_BYTES)} encoded)`;
  }
  const sides = image.mimeType === 'image/png' ? pngSides(image.data) : null;
  if (sides !== null && (sides.width > RESULT_IMAGE_MAX_SIDE || sides.height > RESULT_IMAGE_MAX_SIDE)) {
    return `${formatCount(sides.width)} × ${formatCount(sides.height)} pixels, more than a chat takes (${formatCount(RESULT_IMAGE_MAX_SIDE)} a side)`;
  }
  return null;
}

/**
 * `json` with every string `schema` marks as an image's bytes moved to
 * `images` (`{data, mimeType}`) and named where it was.
 */
function liftPictures(json, schema, images) {
  if (schema === null || typeof schema !== 'object' || json === null || typeof json !== 'object') return json;
  if (Array.isArray(json)) {
    return schema.items === undefined ? json : json.map(item => liftPictures(item, schema.items, images));
  }
  const properties = schema.properties ?? {};
  let out = json;
  for (const [key, sub] of Object.entries(properties)) {
    const value = json[key];
    let lifted = value;
    if (typeof value === 'string' && sub.contentEncoding === 'base64' && IMAGE_TYPES.has(sub.contentMediaType)) {
      images.push({ data: value, mimeType: sub.contentMediaType });
      lifted = { image: images.length, mimeType: sub.contentMediaType, bytes: base64Bytes(value) };
    } else if (value !== null && typeof value === 'object') {
      lifted = liftPictures(value, sub, images);
    }
    if (lifted !== value) {
      if (out === json) out = { ...json };
      out[key] = lifted;
    }
  }
  return out;
}

/**
 * Why a change made no step, as the agent is told it after the result (the
 * dispatcher's `unrecorded`): a change asked for what was so already must
 * not be reported to the person as done ("Color by cell_type" on a
 * dataset that opens colored by it). One note per reason of
 * the closed set (`data/viewer-protocol.js` `VIEWER_ACTION_UNRECORDED`, what a
 * notebook hears; a test keeps the two the same).
 */
export const UNRECORDED_NOTES = Object.freeze({
  unchanged: '[Cellucid: this changed nothing: it was so already, so no step was recorded. Tell the person it was already so; do not say you changed it.]',
  retracted: '[Cellucid: this put back what the step just before it changed, so that step is taken out and the history is as before it.]',
  off: '[Cellucid: done, but the person\'s History settings do not record this kind of change, so no step was recorded and Undo turn does not take it back.]',
  paused: '[Cellucid: done, but the history\'s recording is paused, so no step was recorded and Undo turn does not take it back.]',
  elsewhere: '[Cellucid: done, but another tracker of the history was shown meanwhile, so no step was recorded.]',
  'no-history': '[Cellucid: done, but the dataset\'s history has not started yet, so no step was recorded.]',
});

/**
 * The step a change made, as its result names it: its id and label, and the
 * turn it belongs to (an agent's step: the id a note on the turn, or Undo
 * turn, names; nothing else tells an agent outside the chat bar its turn).
 */
function stepOf(step) {
  if (step === null || step === undefined) return null;
  const turn = step.by?.turn ?? null;
  return turn === null ? { id: step.id, label: step.label } : { id: step.id, label: step.label, turn };
}

/**
 * The MCP result of an action that ran.
 * @param {{definition: object, outcome: unknown, step: object|null, unrecorded?: string|null, summariesOnly?: boolean, told?: string[]}} ran -
 *   `unrecorded`: why a change made no step (`UNRECORDED_NOTES`); `summariesOnly`: the dataset is set
 *   to names and summaries only (no picture, no single-cell statistic); `told`: Cellucid's notes said
 *   last (the person's settings, `agent-calls.js`), kept within the text's bound
 * @returns {Promise<{content: object[], isError: false}>}
 */
export async function toolResultOf({ definition, outcome, step, unrecorded = null, summariesOnly = false, told = [] }) {
  // Blob pictures are numbered by outcomeAsJson (1, 2, …); the result
  // schema's pictures follow them.
  const blobs = [];
  const json = outcomeAsJson(outcome, blobs);
  const images = [];
  for (const blob of blobs) images.push({ data: base64OfBytes(new Uint8Array(await blob.arrayBuffer())), mimeType: blob.type });
  const lifted = liftPictures(json, definition.result ?? null, images);
  const { json: result, leftOut } = summariesOnly ? withoutSingleCellStatistics(definition.type, lifted) : { json: lifted, leftOut: [] };
  // A read, a history move and a dataset opened record no step: their result is the answer.
  const stepless = isSteplessEffect(definition.effect);
  const body = stepless
    ? result
    : { step: stepOf(step), result };
  const notes = leftOut.length === 0 ? [] : [statisticsLeftOutNote(leftOut)];
  if (!stepless && (step === null || step === undefined) && unrecorded !== null) {
    const note = UNRECORDED_NOTES[unrecorded];
    if (note === undefined) throw new RangeError(`No step was recorded for a reason Cellucid does not know: ${unrecorded}`);
    notes.push(note);
  }
  const sent = [];
  for (const [index, image] of images.entries()) {
    const problem = summariesOnly ? null : imageProblem(image);
    if (summariesOnly) notes.push(pictureLeftOutNote(index + 1));
    else if (problem === null) sent.push({ type: 'image', data: image.data, mimeType: image.mimeType });
    else notes.push(`[Cellucid: picture ${index + 1} is ${problem}, so it is left out. Ask for a smaller one.]`);
  }
  notes.push(...told);
  return { content: [{ type: 'text', text: resultText(JSON.stringify(body), notes) }, ...sent], isError: false };
}

/**
 * Text split around the names marked where the sentence was built
 * (`targets/names.js` `quoteName`): `[outside, marked, outside, …]`.
 * @param {string} text
 */
function splitMarked(text) {
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(MARKED_NAME)) {
    parts.push(text.slice(last, match.index), match[0]);
    last = match.index + match[0].length;
  }
  parts.push(text.slice(last));
  return parts;
}

/**
 * A sentence of Cellucid's as an agent reads it: the names in it were
 * marked as data where it was built (`quoteName`); outside them every `<`
 * is escaped, so nothing else in it can open or close a mark. Nothing is
 * marked here: a name the sentence did not mark stays unmarked text.
 * @param {string} text
 */
export function refusalText(text) {
  return splitMarked(String(text)).map((part, index) => (index % 2 === 1 ? part : part.replaceAll('<', '\\u003c'))).join('');
}

/**
 * A sentence as a person reads it (the chat's tool row, an exported chat):
 * each marked name written `"name"` (`plainSentence`), each `<` as it was.
 * @param {string} text
 */
export function plainText(text) {
  return splitMarked(String(text)).map((part, index) => (index % 2 === 1 ? plainSentence(part) : part.replaceAll('\\u003c', '<'))).join('');
}

/** A tool error with one sentence, its names marked as data where it was built (`refusalText`), and Cellucid's notes `told` after it. */
export function toolErrorOf(text, told = []) {
  return { content: [{ type: 'text', text: limitText(`${refusalText(text)}${told.map(note => `\n${note}`).join('')}`) }], isError: true };
}

/**
 * The sentence an agent reads when an action did not run or failed.
 * @param {unknown} error
 * @param {{title: string}|null} definition
 */
export function errorSentenceOf(error, definition) {
  // An error whose sentence marks names keeps that sentence for an agent (`marked`; `message` is the person's).
  const marked = typeof error?.marked === 'string' ? error.marked : null;
  if (error instanceof ActionRefused) return marked ?? error.message;
  if (isCancellation(error)) return `Stopped before it finished: ${error.message}`;
  if (error instanceof TypeError || error instanceof RangeError) return marked ?? error.message;
  const what = definition === null ? 'do that' : lowerFirst(definition.title);
  const detail = error instanceof Error && error.message ? `: ${error.message}` : '';
  return `Cellucid could not ${what}${detail}`;
}
