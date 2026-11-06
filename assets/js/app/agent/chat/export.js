/**
 * @fileoverview A conversation in words: the whole chat as Markdown (Export,
 * to keep or share it), one reply as text (Copy), and a turn in one short
 * note: what the agent did and why, as the history shows it beside the
 * turn's steps. Pure.
 *
 * @module app/agent/chat/export
 */

import { replyText, usageOf } from './conversation.js';
import { ASK_TOOL, askOf } from './ask.js';
import { selectionTitle } from './selection.js';
import { plainText } from '../bridge/mcp-content.js';
import { formatCount, formatCountOf } from '../../../utils/format-units.js';

function quote(text) {
  return text.split('\n').map(line => `> ${line}`).join('\n');
}

const FENCE = /^\s*(```|~~~)/;
/** A link whose target is not the web or mail (`javascript:`, `data:`, …). */
const UNSAFE_LINK = /\]\((?!\s*(?:https?:|mailto:|#))/gi;

/**
 * Text as Markdown that no renderer runs: raw HTML outside code is escaped
 * (`\<`, which every CommonMark renderer shows as `<`), and a link to
 * anything but the web or mail is left as text. Code (fenced or in
 * backticks) is kept as it is: no renderer reads HTML there.
 * @param {string} text
 */
export function markdownSafe(text) {
  let fenced = false;
  return String(text).split('\n').map(line => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return line;
    }
    if (fenced) return line;
    return line.split(/(`+[^`]*?`+)/).map((piece, index) => (index % 2 === 1 ? piece : piece.replace(/</g, '\\<').replace(UNSAFE_LINK, ']\\('))).join('');
  }).join('\n');
}

/** Text as one code span, whatever backticks it holds (with some, fenced by a longer run and a space a renderer strips). */
function codeSpan(text) {
  const longest = Math.max(0, ...[...String(text).matchAll(/`+/g)].map(run => run[0].length));
  if (longest === 0) return `\`${text}\``;
  const fence = '`'.repeat(longest + 1);
  return `${fence} ${text} ${fence}`;
}

/**
 * The chat as Markdown: who said what, each step the agent made (the history's
 * label), notes, and the tokens used. Tool results are summarised, not
 * copied (they are in the session's history). Every text in it is
 * `markdownSafe`: a renderer that does not sanitise runs nothing of it.
 *
 * @param {object} conversation
 * @param {{dataset?: string|null, version?: string|null, now?: number}} [about]
 */
export function conversationMarkdown(conversation, { dataset = null, version = null, now = Date.now() } = {}) {
  const lines = [`# Cellucid chat${dataset ? `: ${markdownSafe(dataset)}` : ''}`, ''];
  const usage = usageOf(conversation);
  lines.push(`Exported ${new Date(now).toISOString()}${version ? ` from Cellucid ${version}` : ''}. ${formatCountOf(usage.calls, 'model call')}, ${formatCount(usage.input)} prompt tokens, ${formatCount(usage.output)} written.`, '');
  if (conversation.summary !== null) lines.push(`*The model read a summary of the messages before message ${conversation.summary.before + 1}.*`, '');
  for (const message of conversation.messages) {
    if (message.role === 'user') {
      lines.push('**You**', '', quote(markdownSafe(message.text)), '');
      if (message.attached?.selection) lines.push(`*Attached: ${markdownSafe(selectionTitle(message.attached.selection))}.*`, '');
    } else if (message.role === 'assistant') {
      const text = replyText(message).trim();
      const questions = message.parts.filter(part => part.type === 'tool-call' && part.name === ASK_TOOL.name)
        .map(part => askOf(part.args)).filter(question => !('problem' in question));
      if (text !== '' || questions.length > 0) lines.push(`**${markdownSafe(message.agent)}** (${markdownSafe(message.model)})`, '');
      if (text !== '') lines.push(markdownSafe(text), '');
      for (const question of questions) lines.push(`${markdownSafe(question.question)} *(${question.choices.map(markdownSafe).join(' · ')})*`, '');
    } else if (message.role === 'tool') {
      for (const result of message.results) {
        // A question asked is written with the reply that asked it.
        if (result.name === ASK_TOOL.name && !result.isError) continue;
        const what = result.step ? `step "${result.step.label}"` : result.isError ? `refused: ${plainText(result.content[0]?.text ?? '')}` : 'read';
        lines.push(`- ${codeSpan(result.name)} — ${markdownSafe(what)}`);
      }
      if (message.results.some(result => result.name !== ASK_TOOL.name || result.isError)) lines.push('');
    } else if (message.role === 'note') {
      lines.push(`*${markdownSafe(message.text)}*`, '');
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/** The first sentence of `text` (up to a full stop, a question or an exclamation), whole if none. */
function firstSentence(text) {
  const clean = text.replace(/[#*_`>|]/g, '').replace(/\s+/g, ' ').trim();
  const match = clean.match(/^.+?[.!?](?=\s|$)/);
  return (match?.[0] ?? clean).trim();
}

/**
 * One turn as a short note: what the person asked, the steps it made, and
 * the agent's own first sentence of explanation. Null for a turn not in
 * the conversation.
 *
 * @param {object} conversation
 * @param {string} turn
 * @returns {string|null}
 */
export function turnNoteOf(conversation, turn) {
  const own = conversation.messages.filter(message => message.turn === turn);
  const asked = own.find(message => message.role === 'user');
  if (asked === undefined) return null;
  const steps = own.filter(message => message.role === 'tool').flatMap(message => message.results).filter(result => result.step).map(result => result.step.label);
  const replies = own.filter(message => message.role === 'assistant');
  const said = replies.length === 0 ? '' : firstSentence(replyText(replies[replies.length - 1]));
  const parts = [`Asked: "${firstSentence(asked.text)}"`];
  if (steps.length > 0) parts.push(`${steps.length === 1 ? 'Step' : 'Steps'}: ${steps.join('; ')}`);
  if (said !== '') parts.push(`Why: ${said}`);
  // Each part one sentence: ended by its own mark (inside the quote too), else a full stop.
  return parts.map(part => (/[.!?]["”]?$/.test(part) ? part : `${part}.`)).join(' ');
}
