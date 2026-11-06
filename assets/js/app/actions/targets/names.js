/**
 * @fileoverview How a sentence of Cellucid's names things: a refusal lists
 * the names there are, a confirmation or a decline says what was asked. A
 * person, an agent and a replay read the same sentence.
 *
 * **Names are marked as data where the sentence is built** (`quoteName`): a
 * field, category, page, label or file name was written by a dataset's
 * authors or by other people (a community annotation label, a shared note),
 * so an agent reads it between the data tags (`RESULT_DATA_TAGS`), as JSON
 * text in which every `<` is written `<`: no name can close the tags,
 * end its quotes or start a line of its own. Nothing marks a finished
 * sentence after the fact (a quote or a newline inside a name would escape
 * such a pass).
 *
 * - `quoteName(name)`: the name marked, for every sentence an agent may read.
 * - `plainSentence(text)`: the same sentence for a person, each marked name
 *   written `"name"` (an `ActionRefused`'s `message`; `marked` keeps the
 *   marked one).
 * - `PLAIN_QUOTE` / `MARKED_QUOTE`: the third argument of an action's
 *   `describe(params, outcome, quote)`: `quote(name)` writes a quoted name,
 *   `quote.bare(name)` one the sentence shows without quotes. Plain for the
 *   timeline, the methods and the confirm card; marked for an agent.
 *
 * @module app/actions/targets/names
 */

import { RESULT_DATA_TAGS } from '../../agent/bridge/relay-protocol.js';

/** At most this many names are listed in a refusal; the rest are counted. */
const LISTED_NAMES = 8;

/**
 * A name marked as data: the data tags around the name as one JSON string,
 * every `<` in it written `<`.
 * @param {unknown} name
 * @returns {string}
 */
export function quoteName(name) {
  return `${RESULT_DATA_TAGS.open}${JSON.stringify(String(name)).replaceAll('<', '\\u003c')}${RESULT_DATA_TAGS.close}`;
}

/**
 * Every name `quoteName` marked: the tags around one JSON string with no raw
 * `<`, newline or unescaped `"` in it. Text outside such a span is never a
 * name's.
 */
export const MARKED_NAME = /<cellucid-data>("(?:[^"\\\n<]|\\.)*")<\/cellucid-data>/g;

/**
 * A sentence with its marked names (`quoteName`) written as a person reads
 * them: `"name"`.
 * @param {unknown} text
 * @returns {string}
 */
export function plainSentence(text) {
  return String(text).replace(MARKED_NAME, (_whole, json) => {
    try {
      return `"${JSON.parse(json)}"`;
    } catch {
      return json;
    }
  });
}

/** `describe`'s names for a person: `"name"`, and a bare name as it is. */
export const PLAIN_QUOTE = Object.freeze(Object.assign(name => `"${name}"`, { bare: name => String(name) }));

/** `describe`'s names for an agent: every name marked (`quoteName`). */
export const MARKED_QUOTE = Object.freeze(Object.assign(name => quoteName(name), { bare: name => quoteName(name) }));

/**
 * An error whose sentence marks names (`quoteName`): its `message` is the
 * plain sentence a person reads, its `marked` the one an agent reads.
 * @template {Error} T
 * @param {new (message: string) => T} ErrorClass
 * @param {string} sentence
 * @returns {T}
 */
export function namedError(ErrorClass, sentence) {
  const error = new ErrorClass(plainSentence(sentence));
  error.marked = sentence;
  return error;
}

/** Names marked (`quoteName`) as a list: `a, b and c`, or the first few and how many more; `none` for none. */
export function listNames(names) {
  const quoted = names.map(quoteName);
  if (quoted.length === 0) return 'none';
  if (quoted.length <= LISTED_NAMES) {
    return quoted.length === 1 ? quoted[0] : `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`;
  }
  return `${quoted.slice(0, LISTED_NAMES).join(', ')} and ${quoted.length - LISTED_NAMES} more`;
}

/** A category as the legend shows it (a number or a boolean category as its text). */
export function categoryLabel(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value.toString();
  return value ? 'true' : 'false';
}
