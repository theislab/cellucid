/**
 * @fileoverview A conversation in words: the whole chat as Markdown (Export,
 * to keep or share it), one reply as text (Copy), and a turn in one short
 * note: what the agent did and why, as the history shows it beside the
 * turn's steps. Pure.
 *
 * @module app/agent/chat/export
 */

import { progressNotes, replyText, usageOf } from './conversation.js';
import { ASK_TOOL, askOf } from './ask.js';
import { selectionTitle } from './selection.js';
import { plainText } from '../bridge/mcp-content.js';
import { parseInline } from './markdown.js';
import { namedCall, saysUnchanged, toolRowText } from './work.js';
import { formatCount, formatCountOf } from '../../../utils/format-units.js';

function quote(text) {
  return text.split('\n').map(line => `> ${line}`).join('\n');
}

/** A fence as the chat draws one (`markdown.js` `parseMarkdown`): its marker and what follows it. */
const FENCE = /^(\s*)(```|~~~)[`~]*(.*)$/;
/** A fence's language, kept only when it is a plain name. */
const FENCE_INFO = /^[\w+#.-]{1,40}$/;
/**
 * Every character of text that can start Markdown other than emphasis,
 * headings, lists, quotes and tables: an escape, a code span or fence
 * (backtick, tilde), raw HTML or an autolink (`<`), a link, a reference
 * definition or a footnote (`[`), an image (`!`, before a link the chat
 * draws). Each is written escaped, which every CommonMark renderer shows as
 * the character itself.
 */
const ACTIVE = /[\\`~<[!]/g;

function escapeText(text) {
  return text.replace(ACTIVE, '\\$&');
}

/** A link target as CommonMark reads it back unchanged: the characters it treats specially percent-encoded. */
function linkTarget(href) {
  return href.replace(/[()<>\\`\s]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

/** Inline runs (`parseInline`) written back: code as `codeSpan`, http(s) links as links, every other text escaped. */
function inlineRuns(runs) {
  const merged = [];
  // Two code runs side by side would make one backtick run of their fences: one span.
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (run.code !== undefined && last?.code !== undefined) merged[merged.length - 1] = { code: `${last.code}${run.code}` };
    else merged.push(run);
  }
  return merged.map(run => {
    if (run.code !== undefined) return codeSpan(run.code);
    if (run.strong !== undefined) return `**${inlineRuns(run.strong)}**`;
    if (run.em !== undefined) return `*${inlineRuns(run.em)}*`;
    if (run.link !== undefined) return `[${escapeText(run.link)}](${linkTarget(run.href)})`;
    return escapeText(run.text);
  }).join('');
}

/**
 * One line of text as Markdown that no renderer runs (for a name, a title,
 * a question: text set inside a line of the export). Its newlines become
 * spaces.
 * @param {string} text
 */
export function markdownInlineSafe(text) {
  return inlineRuns(parseInline(String(text).replace(/[\r\n]+/g, ' ')));
}

/**
 * Text as Markdown that no renderer runs, drawn as the chat draws it
 * (`markdown.js`): the inline Markdown the chat understands (code, bold,
 * italic, http(s) links) is written back as such and every other character
 * that could start Markdown is escaped (`ACTIVE`), so no raw HTML, autolink,
 * script link, image, reference definition or code span of the reply's own
 * is left for a renderer to read; a fenced block the chat draws is written
 * at the margin with a fence longer than any run in its code, always
 * closed, so no line of the code can end it and nothing after it is read as
 * code (or code as text). Code is kept as it is: no renderer reads HTML
 * there.
 *
 * The structure is the chat's own, written in a form every CommonMark
 * renderer reads one way; guessing a renderer's structure from the text
 * (where a code span or a fence ends) is what lets raw HTML through.
 * @param {string} text
 */
export function markdownSafe(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const fence = lines[i].match(FENCE);
    if (fence === null) {
      out.push(inlineRuns(parseInline(lines[i])));
      continue;
    }
    const indent = fence[1].length;
    const info = fence[3].trim();
    const code = [];
    for (i++; i < lines.length && !lines[i].trim().startsWith(fence[2]); i++) {
      code.push(lines[i].replace(new RegExp(`^ {0,${indent}}`), ''));
    }
    const longest = Math.max(2, ...code.flatMap(line => [...line.matchAll(/`+/g)].map(run => run[0].length)));
    const marker = '`'.repeat(longest + 1);
    out.push(`${marker}${FENCE_INFO.test(info) ? info : ''}`, ...code, marker);
  }
  return out.join('\n');
}

/** Text as one code span, whatever backticks it holds (with some, fenced by a longer run and a space a renderer strips). */
function codeSpan(text) {
  const longest = Math.max(0, ...[...String(text).matchAll(/`+/g)].map(run => run[0].length));
  if (longest === 0) return `\`${text}\``;
  const fence = '`'.repeat(longest + 1);
  return `${fence} ${text} ${fence}`;
}

/**
 * The chat as Markdown: who said what (an agent's notes between its calls in
 * italics), every call the agent made (a step by
 * the history's label, a read by what it read, as the chat's rows name them:
 * `work.js`; a refusal with its reason), notes, and the tokens used. Tool
 * results are summarized, not copied (they are in the session's history).
 * Every call is listed, folded or not in the chat. Every text in it is
 * `markdownSafe`: a renderer that does not sanitize runs nothing of it.
 *
 * @param {object} conversation
 * @param {{dataset?: string|null, version?: string|null, now?: number, toolIndex?: Map<string, object>}} [about]
 *   toolIndex: the tools' actions (`toolIndexOf`), which name what a call read
 */
export function conversationMarkdown(conversation, { dataset = null, version = null, now = Date.now(), toolIndex = new Map() } = {}) {
  const lines = [`# Cellucid chat${dataset ? `: ${markdownInlineSafe(dataset)}` : ''}`, ''];
  const usage = usageOf(conversation);
  lines.push(`Exported ${new Date(now).toISOString()}${version ? ` from Cellucid ${version}` : ''}. ${formatCountOf(usage.calls, 'model call')}, ${formatCount(usage.input)} prompt tokens, ${formatCount(usage.output)} written.`, '');
  if (conversation.summary !== null) lines.push(`*The model read a summary of the messages before message ${conversation.summary.before + 1}.*`, '');
  /** call id → the call as asked (its arguments name what it read) */
  const calls = new Map();
  for (const message of conversation.messages) {
    if (message.role === 'user') {
      lines.push('**You**', '', quote(markdownSafe(message.text)), '');
      if (message.attached?.selection) lines.push(`*Attached: ${markdownInlineSafe(selectionTitle(message.attached.selection))}.*`, '');
    } else if (message.role === 'assistant') {
      const text = replyText(message).trim();
      const questions = message.parts.filter(part => part.type === 'tool-call' && part.name === ASK_TOOL.name)
        .map(part => askOf(part.args)).filter(question => !('problem' in question));
      for (const part of message.parts) if (part.type === 'tool-call') calls.set(part.id, part);
      const notes = progressNotes(message);
      if (text !== '' || questions.length > 0 || notes.length > 0) lines.push(`**${markdownInlineSafe(message.agent)}** (${markdownInlineSafe(message.model)})`, '');
      if (text !== '') lines.push(markdownSafe(text), '');
      // The notes it showed between its calls, as the chat showed them: quiet lines.
      for (const note of notes) lines.push(`*${markdownInlineSafe(note)}*`, '');
      for (const question of questions) lines.push(`${markdownInlineSafe(question.question)} *(${question.choices.map(markdownInlineSafe).join(' · ')})*`, '');
    } else if (message.role === 'tool') {
      for (const result of message.results) {
        // A question asked is written with the reply that asked it.
        if (result.name === ASK_TOOL.name && !result.isError) continue;
        lines.push(`- ${codeSpan(result.name)} — ${markdownInlineSafe(exportedCall(calls.get(result.id), toolIndex.get(result.name), result))}`);
      }
      if (message.results.some(result => result.name !== ASK_TOOL.name || result.isError)) lines.push('');
    } else if (message.role === 'note') {
      lines.push(`*${markdownInlineSafe(message.text)}*`, '');
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/**
 * What became of one call, as the export lists it: the step it made; a
 * refusal or a stop with its reason (a stop is not a refusal: the person
 * stopped it, `work.js` tells them apart as the chat's rows do); a change
 * asked for what was so already; a read by what it read; and any other call
 * that made no step (a file written, a note, a stop of a playing path, a move
 * of the history) as done, never as a read.
 * @param {object|undefined} call the call as asked
 * @param {object|undefined} action its action (the tools' index), when known
 * @param {object} result
 */
function exportedCall(call, action, result) {
  if (result.step) return `step "${result.step.label}"`;
  const named = call === undefined || action === undefined ? null : namedCall(call, action);
  const row = toolRowText(named ?? { title: result.name }, result, { running: false });
  if (row.state === 'refused' || row.state === 'stopped') return `${row.state}: ${plainText(result.content[0]?.text ?? '')}`;
  if (row.state === 'interrupted') return 'interrupted: the page closed before it finished';
  if (named === null) return 'read';
  if (saysUnchanged(result)) return `no change: ${row.label}`;
  return `${action.effect === 'read' ? 'read' : 'done'}: ${row.label}`;
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
