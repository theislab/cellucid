/**
 * @fileoverview The chat bar's conversation as it is shown: the person's
 * messages (Edit puts one back in the message field), the agent's replies
 * (Markdown, `markdown.js`; Copy), each tool call as one compact row named by
 * what it was about (`work.js`) that opens to what was asked and answered (a
 * row that made a step shows it in the history, Show), a long turn's calls
 * folded under one summary row (`work.js` `turnFoldOf`: its answer is what
 * shows; opened, the turn as it was made), a question the agent asked with its choices (`ask.js`:
 * their buttons are above the message field while it waits), the selection
 * a message attached (`selection.js`), notes (a failure or a Stop offers Try again, never on a
 * turn the conversation received: `conversation.js` `offersRetry`), and
 * under each finished turn: its steps (shown in the history on a click),
 * Undo turn, and Sent (what left this browser for the provider, and the
 * tokens).
 *
 * Messages are only ever added (`conversation.js`), so each one is drawn
 * once and kept (by identity); a reply being streamed is drawn as it grows,
 * and a tool row is filled in when its result arrives. A row's details are
 * drawn when it is first opened. The log stays at its end while the person
 * reads its end, and stays where it is when they scrolled up.
 *
 * **Notes between calls** (`progress` parts: what a model that writes them
 * found and does next, `providers/anthropic.js`): each is one quiet line
 * before the call it introduces, shown and folded with that call's row
 * (`work.js`); while the model writes, its notes show with its streamed
 * words. A note after the last call (a reply cut short) shows after the work.
 *
 * **Announced** (the log is `role="log"`, additions read out): the agent's
 * words and a turn's summary row once, when it first shows; the calls'
 * rows are not (`aria-live="off"` on each message's rows), so a screen
 * reader is not read forty calls of one turn.
 *
 * **What a streamed piece costs** does not grow with the conversation or
 * the reply: a frame where only the reply grew (or the working line
 * changed) redraws those alone; the reply redraws only its last Markdown
 * block (`markdown.js` `createMarkdownStream`); a finished turn's footer
 * texts (Sent, the tokens) are worked out once. Each conversation shown has
 * its own listeners, let go when another is shown (`reset`), so a
 * conversation left is not kept alive by its buttons.
 *
 * @module app/agent/chat/transcript-view
 */

import { createMarkdownStream, renderMarkdown } from './markdown.js';
import { offersRetry, progressNotes, replyText } from './conversation.js';
import { ASK_TOOL, askOf } from './ask.js';
import { plainText, resultDataOf } from '../bridge/mcp-content.js';
import { RESULT_DATA_TAGS } from '../bridge/relay-protocol.js';
import { selectionLabel, selectionTitle } from './selection.js';
import { bindDisclosure, buttonClassName } from '../../ui/components/controls.js';
import { createDomId } from '../../ui/components/dom-id.js';
import { formatCount, formatCountOf, formatRemaining } from '../../../utils/format-units.js';
import { namedCall, toolRowText, turnFoldOf, workSummaryText } from './work.js';

/** The working line: what the turn does now. */
export function workingTextOf(status, now = Date.now()) {
  if (status === null || status === undefined) return '';
  switch (status.phase) {
    case 'writing': return 'Writing…';
    case 'tool': return `Running: ${status.tool}…`;
    case 'asking': return 'Waiting for your answer above…';
    case 'summarizing': return 'Summarizing the earlier conversation for the model…';
    case 'waiting': return `${status.reason} Next try in ${formatRemaining(Math.max(0, status.retryAt - now))}.`;
    default: return 'Thinking…';
  }
}

/** The tokens of a turn as a short fact. */
export function tokensText(usage) {
  if (usage === null || usage === undefined || usage.calls === 0) return null;
  return `${formatCount(usage.input)} tokens read (${formatCount(usage.cacheRead)} from the cache), ${formatCount(usage.output)} written, in ${formatCountOf(usage.calls, 'call')}`;
}

/**
 * What left this browser in a turn, as one sentence (`conversation.js` `sentOf`). A turn the
 * conversation received (a shared session or a saved state opened) was sent by the browser it
 * came from, not this one: said so, never "your message … left this browser" (L24-9).
 */
export function sentText(sent, provider, { received = false } = {}) {
  const parts = [received ? 'the message' : 'your message'];
  if (sent.results > 0) {
    const pictures = sent.pictures > 0 ? `, ${formatCountOf(sent.pictures, 'picture')}` : '';
    parts.push(`${formatCountOf(sent.results, 'tool result')} (${formatCountOf(sent.resultChars, 'character')}${pictures})`);
  }
  if (received) {
    const carried = sent.summariesOnly
      ? 'its dataset was set to names and summaries only, so no result carried values of cells or a picture'
      : 'a result can carry part of the data (the values of cells, a picture of the plot)';
    return `Nothing of this turn left this browser: it came with the conversation (a shared session or a saved state). The browser it was made in sent ${provider} ${parts.join(' and ')}; ${carried}.`;
  }
  const data = sent.summariesOnly
    ? 'and the dataset was set to names and summaries only, so no result carried values of cells or a picture'
    : 'but a result can carry part of the data (the values of cells, a picture of the plot)';
  return `Sent to ${provider}: ${parts.join(' and ')}. That is all that left this browser for this turn; the dataset's files stay here, ${data}.`;
}

function resultText(result) {
  return result.content.map(item => (item.type === 'image' ? `[A picture (${item.mimeType})]` : item.text)).join('\n');
}

/** A result's text for a person: its data (`RESULT_DATA_TAGS`) as indented JSON, then Cellucid's notes. */
function prettyJson(text) {
  const data = resultDataOf(text);
  // A sentence of Cellucid's (a refusal): its names without the marks the model reads.
  if (data === null) return plainText(text);
  const after = text.slice(text.indexOf(RESULT_DATA_TAGS.close) + RESULT_DATA_TAGS.close.length);
  try {
    return `${JSON.stringify(JSON.parse(data), null, 1)}${after}`;
  } catch {
    // Cut (too long for a chat): shown as it was sent.
    return `${data}${after}`;
  }
}

/**
 * @param {{
 *   log: HTMLElement,
 *   onUndoTurn: (turn: string) => void,
 *   onSuggestion: (text: string) => void,
 *   onRevealStep: (stepId: string) => void,
 *   onEdit: (text: string) => void,
 *   onRetry: (turn: string) => void,
 *   onCopy: (text: string, button: HTMLButtonElement) => void,
 * }} options
 */
export function createTranscriptView({ log, onUndoTurn, onSuggestion, onRevealStep, onEdit, onRetry, onCopy }) {
  const doc = log.ownerDocument;
  const controller = new AbortController();
  const { signal } = controller;
  /** The listeners of the conversation shown (its messages, rows, footers): let go by `reset`. */
  let shown = new AbortController();
  /** The listeners of the suggestions shown: let go when others are shown. */
  let chipsShown = new AbortController();
  /** message → its element (user, assistant, note) */
  const elements = new WeakMap();
  /** assistant message → Map(call id → row parts) */
  const rows = new WeakMap();
  /** assistant message → its parts ({element, body, copy, hasText, asks}) */
  const agentParts = new WeakMap();
  /** turn → its summary row's parts (a turn with more calls than `LIVE_ROWS`) */
  const summaries = new Map();
  /** The turns whose work the person opened. */
  const opened = new Set();
  /** turn → footer parts */
  const footers = new Map();
  /** finished turn → its footer's texts ({sent, tokens}): a finished turn's messages do not change. */
  const footerTexts = new Map();
  /** What the last full draw drew from: a frame that changes none of it redraws only the reply and the working line. */
  let drawnFrom = null;
  /** How many of the log's elements the last full draw put before the reply and the working line. */
  let drawnCount = 0;
  const empty = doc.createElement('div');
  empty.className = 'agent-chat-empty';
  const emptyText = doc.createElement('p');
  emptyText.className = 'empty-state';
  emptyText.textContent = 'Ask about the dataset, or have the agent work in it; it opens datasets too. Every change it makes is a step you can undo.';
  const chips = doc.createElement('div');
  chips.className = 'agent-chat-suggestions';
  empty.append(emptyText, chips);
  let shownSuggestions = '';
  const streaming = doc.createElement('div');
  streaming.className = 'agent-msg agent-msg-agent';
  streaming.dataset.streaming = 'true';
  const streamingNotes = doc.createElement('div');
  streamingNotes.className = 'agent-msg-notes';
  const streamingBody = doc.createElement('div');
  streamingBody.className = 'agent-msg-body';
  streaming.append(streamingNotes, streamingBody);
  const stream = createMarkdownStream(doc, streamingBody);
  let streamedText = null;
  /** The streamed message's notes as drawn (joined), or null. */
  let streamedNotes = null;
  const working = doc.createElement('p');
  working.className = 'agent-chat-working';
  const spinner = doc.createElement('span');
  spinner.className = 'spinner';
  spinner.setAttribute('aria-hidden', 'true');
  const workingText = doc.createElement('span');
  working.append(spinner, workingText);

  function atEnd() {
    return log.scrollHeight - log.scrollTop - log.clientHeight < 24;
  }

  /*
   * Where the log stands (F99). While the person leaves it alone it follows
   * what the agent writes, until the first line of the agent's latest words
   * reaches the top: from then those words are held from their start (a long
   * answer is read from its first line, as the best assistants show it, never
   * dragged to its last), also when the turn ends and its work folds above
   * them. A wheel, a touch, a key or a press in the log leaves the place to
   * the person, until they are back at the end or send a message.
   */
  /** Px between the top of the log and the agent's name above the words held. */
  const HOLD_MARGIN = 8;
  let personMoved = false;
  let holding = false;
  /** The person's latest message drawn: a new one is followed whatever the place. */
  let latestQuestion = null;
  const takeOver = () => {
    personMoved = true;
    holding = false;
  };
  for (const type of ['wheel', 'touchmove', 'pointerdown', 'keydown']) {
    log.addEventListener(type, takeOver, { passive: true, signal });
  }

  /** The agent's latest words after the person's latest message (the reply being written included), or null. */
  function latestWords() {
    for (let at = log.children.length - 1; at >= 0; at--) {
      const node = log.children[at];
      if (node.classList.contains('agent-msg-user')) return null;
      const words = node === streaming
        || (node.classList.contains('agent-msg-agent') && node.dataset.empty !== 'true');
      if (words && node.getClientRects().length > 0) return node;
    }
    return null;
  }

  /** Follow: the end, or the top of the agent's latest words once they reach it. */
  function place() {
    const end = log.scrollHeight - log.clientHeight;
    const words = latestWords();
    let target = end;
    holding = false;
    if (words !== null) {
      const top = words.getBoundingClientRect().top - log.getBoundingClientRect().top + log.scrollTop - HOLD_MARGIN;
      if (top < end) {
        target = Math.max(0, top);
        holding = true;
      }
    }
    log.scrollTop = target;
  }

  /**
   * A message's, a tool row's or a turn's action: quiet, as every action
   * nested in the log (`buttonClassName`); its listener goes with the
   * conversation shown (or `owner`).
   */
  function smallButton(label, className, title, onClick, owner = shown.signal, variant = 'quiet') {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = buttonClassName(variant, className);
    button.textContent = label;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.addEventListener('click', () => onClick(button), { signal: owner });
    return button;
  }

  /** A note the agent showed between its calls (`progress`): one quiet line. */
  function noteLine(text) {
    const note = doc.createElement('p');
    note.className = 'agent-tool-note';
    note.textContent = text;
    return note;
  }

  function messageHead(name, ...actions) {
    const head = doc.createElement('div');
    head.className = 'agent-msg-head';
    const who = doc.createElement('p');
    who.className = 'agent-msg-who';
    who.textContent = name;
    head.append(who, ...actions);
    return head;
  }

  function userElement(message) {
    const element = doc.createElement('div');
    element.className = 'agent-msg agent-msg-user';
    element.dataset.turn = message.turn;
    const text = doc.createElement('p');
    text.className = 'agent-msg-text';
    text.textContent = message.text;
    const edit = smallButton('Edit', 'agent-msg-edit', 'Edit this message and send it again (a new turn)', () => onEdit(message.text));
    element.append(messageHead('You', edit), text);
    const selection = message.attached?.selection ?? null;
    if (selection) {
      const attached = doc.createElement('p');
      attached.className = 'agent-msg-attached';
      attached.textContent = selectionLabel(selection);
      attached.title = `Attached: ${selectionTitle(selection)}`;
      element.appendChild(attached);
    }
    return element;
  }

  function noteElement(conversation, message) {
    const element = doc.createElement('div');
    element.className = 'agent-msg-note';
    element.dataset.kind = message.kind;
    const text = doc.createElement('p');
    text.textContent = message.text;
    element.appendChild(text);
    if (offersRetry(conversation, message)) {
      element.appendChild(smallButton('Try again', 'agent-msg-retry', 'Send this turn\'s message again', () => onRetry(message.turn)));
    }
    return element;
  }

  /** A disclosure's chevron (a tool row's, a turn's summary row's). */
  function chevronElement() {
    const chevron = doc.createElement('span');
    chevron.className = 'disclosure-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    return chevron;
  }

  function toolRow(call) {
    const root = doc.createElement('div');
    root.className = 'agent-tool disclosure disclosure-inline';
    root.dataset.tool = call.name;
    const line = doc.createElement('div');
    line.className = 'agent-tool-line';
    const header = doc.createElement('button');
    header.type = 'button';
    header.className = 'disclosure-header agent-tool-head';
    const mark = doc.createElement('span');
    mark.className = 'agent-tool-mark';
    mark.setAttribute('aria-hidden', 'true');
    const label = doc.createElement('span');
    label.className = 'disclosure-title agent-tool-label';
    header.append(mark, label, chevronElement());
    const show = smallButton('Show', 'agent-tool-show', 'Show this step in the history', () => {
      if (parts.result?.step) onRevealStep(parts.result.step.id);
    });
    show.hidden = true;
    line.append(header, show);
    const content = doc.createElement('div');
    content.className = 'disclosure-content agent-tool-body';
    content.id = createDomId('agent-tool');
    root.append(line, content);
    const parts = { root, label, content, show, call, notes: [], result: null, drawn: false, drawnWithout: false };
    bindDisclosure({
      header, content, expanded: false, signal: shown.signal,
      onToggle: expanded => { if (expanded) drawDetails(parts); },
    });
    return parts;
  }

  function drawDetails(parts) {
    if (parts.drawn && !(parts.result !== null && parts.drawnWithout)) return;
    const block = (className, text) => {
      const pre = doc.createElement('pre');
      pre.className = className;
      const code = doc.createElement('code');
      code.textContent = text;
      pre.appendChild(code);
      return pre;
    };
    const nodes = [block('agent-tool-args', `${parts.call.name}(${JSON.stringify(parts.call.args, null, 1)})`)];
    if (parts.result !== null) nodes.push(block('agent-tool-result', prettyJson(resultText(parts.result))));
    parts.content.replaceChildren(...nodes);
    parts.drawn = true;
    parts.drawnWithout = parts.result === null;
  }

  function updateRow(parts, result, running = true) {
    parts.result = result;
    const { state, label } = toolRowText(parts.call, result, { running });
    parts.root.dataset.state = state;
    if (parts.label.textContent !== label) {
      parts.label.textContent = label;
      parts.label.title = label;
    }
    parts.show.hidden = !(result?.step);
    if (parts.drawn && result !== null && parts.drawnWithout) drawDetails(parts);
  }

  function assistantElement(message, toolIndex) {
    const element = doc.createElement('div');
    element.className = 'agent-msg agent-msg-agent';
    element.dataset.turn = message.turn;
    element.id = createDomId('agent-msg');
    const body = doc.createElement('div');
    body.className = 'agent-msg-body';
    const text = replyText(message);
    const hasText = text.trim() !== '';
    const copy = smallButton('Copy', 'agent-msg-copy', 'Copy this answer', button => onCopy(text, button));
    copy.hidden = !hasText;
    element.append(messageHead(message.agent, copy), body);
    if (hasText) body.appendChild(renderMarkdown(doc, text));
    else element.dataset.empty = 'true';
    const calls = new Map();
    const tools = doc.createElement('div');
    tools.className = 'agent-tools';
    // Rows are not read out as they come (the log announces additions): the agent's words and the turn's summary are.
    tools.setAttribute('aria-live', 'off');
    let asks = 0;
    /** The notes since the last call: they introduce the next one. */
    let notes = [];
    for (const part of message.parts) {
      if (part.type === 'progress') {
        if (part.text.trim() !== '') notes.push(noteLine(part.text.trim()));
        continue;
      }
      if (part.type !== 'tool-call') continue;
      const question = part.name === ASK_TOOL.name ? askOf(part.args) : null;
      if (question !== null && !('problem' in question)) {
        element.append(...notes, askElement(question));
        notes = [];
        asks += 1;
        continue;
      }
      const call = namedCall(part, toolIndex.get(part.name), part.name === ASK_TOOL.name ? ASK_TOOL.title : undefined);
      const row = toolRow({ id: part.id, ...call });
      row.notes = notes;
      notes = [];
      calls.set(part.id, row);
      tools.append(...row.notes, row.root);
    }
    if (calls.size > 0) element.appendChild(tools);
    // Notes after the last call (a reply cut short): after the work.
    element.append(...notes);
    rows.set(message, calls);
    agentParts.set(message, { element, body, copy, hasText, asks, trailing: notes });
    return element;
  }

  /**
   * The summary row of a turn with more calls than `LIVE_ROWS`: the agent's
   * name, then a disclosure that opens the turn's work (`work.js`).
   */
  function summaryFor(turn, agent) {
    let parts = summaries.get(turn);
    if (parts !== undefined) return parts;
    const root = doc.createElement('div');
    root.className = 'agent-msg agent-msg-work';
    root.dataset.turn = turn;
    const work = doc.createElement('div');
    work.className = 'agent-work disclosure disclosure-inline';
    const header = doc.createElement('button');
    header.type = 'button';
    header.className = 'disclosure-header agent-work-head';
    const mark = doc.createElement('span');
    mark.className = 'agent-tool-mark';
    mark.setAttribute('aria-hidden', 'true');
    const label = doc.createElement('span');
    label.className = 'disclosure-title agent-work-label';
    header.append(mark, label, chevronElement());
    header.setAttribute('aria-expanded', 'false');
    work.appendChild(header);
    root.append(messageHead(agent), work);
    parts = { root, header, label, entry: null };
    header.addEventListener('click', () => {
      if (opened.has(turn)) opened.delete(turn);
      else opened.add(turn);
      if (parts.entry !== null) foldTurn(parts.entry);
      // Closed from below (the person read the work), the turn's start comes back into view.
      if (!opened.has(turn)) root.scrollIntoView({ block: 'nearest' });
    }, { signal: shown.signal });
    summaries.set(turn, parts);
    return parts;
  }

  /**
   * Show what a turn's fold shows (`turnFoldOf`), and its summary row's
   * words. Returns the summary row, or null for a short turn (shown whole).
   * @param {{turn: string, running: boolean, items: Array<{message: object, parts: object}>}} entry
   */
  function foldTurn(entry) {
    const rowsOf = message => [...rows.get(message).values()];
    const fold = turnFoldOf(entry.items.map(({ message, parts }) => ({
      text: parts.hasText, asks: parts.asks,
      rows: rowsOf(message).map(row => ({ state: row.root.dataset.state, name: row.call.name, target: row.call.target })),
    })), { running: entry.running, expanded: opened.has(entry.turn) });
    entry.items.forEach(({ message, parts }, index) => {
      parts.element.hidden = !fold.messages[index];
      parts.body.hidden = parts.hasText && !fold.bodies[index];
      parts.copy.hidden = !parts.hasText || parts.body.hidden;
      rowsOf(message).forEach((row, at) => {
        row.root.hidden = !fold.rows[index][at];
        // A note shows with the call it introduces.
        for (const note of row.notes) note.hidden = row.root.hidden;
      });
      const trailingShown = !fold.folded || fold.bodies[index] || fold.rows[index].some(Boolean);
      for (const note of parts.trailing) note.hidden = !trailingShown;
      // The summary row says the agent's name: every message under it continues it.
      if (fold.summary !== null) parts.element.dataset.continued = 'true';
    });
    if (fold.summary === null) return null;
    const summary = summaryFor(entry.turn, entry.items[0].message.agent);
    summary.entry = entry;
    const words = workSummaryText(fold.summary, { running: entry.running });
    if (summary.label.textContent !== words) summary.label.textContent = words;
    const expanded = opened.has(entry.turn);
    summary.header.setAttribute('aria-expanded', String(expanded));
    summary.header.setAttribute('aria-controls', entry.items.map(({ parts }) => parts.element.id).join(' '));
    summary.header.title = expanded ? 'Fold this turn\'s work: show its answer' : 'Show every message and action of this turn';
    summary.root.dataset.state = entry.running ? 'running' : 'ended';
    return summary.root;
  }

  /** A question the agent asked, with its choices as words (their buttons are above the message field). */
  function askElement(question) {
    const block = doc.createElement('div');
    block.className = 'agent-ask';
    const asked = doc.createElement('p');
    asked.className = 'agent-ask-question';
    asked.textContent = question.question;
    const choices = doc.createElement('p');
    choices.className = 'agent-ask-choices';
    choices.textContent = question.choices.join(' · ');
    block.append(asked, choices);
    return block;
  }

  function footerFor(turn, facts) {
    let parts = footers.get(turn);
    if (parts === undefined) {
      const root = doc.createElement('div');
      root.className = 'agent-turn-foot';
      root.dataset.turn = turn;
      const row = doc.createElement('div');
      row.className = 'agent-turn-row';
      // "3 steps ↗": the turn's steps, opened and selected in the history's graph.
      const steps = smallButton('', 'agent-turn-steps', 'Show this turn\'s steps in the history', () => {
        if (parts.last) onRevealStep(parts.last);
      });
      const sentButton = smallButton('Sent', 'agent-turn-sent', 'What left this browser in this turn', () => {
        parts.sent.hidden = !parts.sent.hidden;
        sentButton.setAttribute('aria-expanded', String(!parts.sent.hidden));
        // Opened under the last turn, the line is below the log's fold: bring it into view.
        if (!parts.sent.hidden) parts.sent.scrollIntoView({ block: 'nearest' });
      });
      sentButton.setAttribute('aria-expanded', 'false');
      const undo = smallButton('Undo turn', 'agent-turn-undo', 'Undo this turn', () => onUndoTurn(turn));
      row.append(steps, sentButton, undo);
      const sent = doc.createElement('p');
      sent.className = 'agent-turn-sent-line';
      sent.hidden = true;
      sentButton.setAttribute('aria-controls', (sent.id = createDomId('agent-turn-sent')));
      root.append(row, sent);
      parts = { root, steps, undo, sentButton, sent, last: null };
      footers.set(turn, parts);
    }
    parts.last = facts.last;
    const undone = facts.onPath === 0 && facts.inTree > 0;
    // Only its own steps undone (others acted after it): they went to Recently deleted, where they can be restored.
    const deleted = facts.inTree === 0 && (facts.deleted ?? 0) > 0;
    const words = deleted ? `${formatCountOf(facts.deleted, 'step')} in Recently deleted`
      : facts.inTree === 0 ? 'No steps' : undone ? `${formatCountOf(facts.inTree, 'step')} undone ↗` : `${formatCountOf(facts.onPath, 'step')} ↗`;
    if (parts.steps.textContent !== words) parts.steps.textContent = words;
    parts.steps.title = deleted
      ? `This turn's ${formatCountOf(facts.deleted, 'step')} went to Recently deleted (State panel), where they can be restored`
      : 'Show this turn\'s steps in the history';
    parts.steps.setAttribute('aria-label', parts.steps.title);
    parts.steps.disabled = facts.last === null;
    parts.undo.hidden = facts.inTree === 0;
    parts.undo.textContent = undone ? 'Undone' : 'Undo turn';
    parts.undo.disabled = undone || facts.inTree === 0;
    parts.undo.setAttribute('aria-label', undone ? `This turn's ${formatCountOf(facts.inTree, 'step')} are undone` : `Undo this turn's ${formatCountOf(facts.onPath, 'step')}`);
    const sentLine = facts.tokens ? `${facts.sent} This turn: ${facts.tokens}.` : facts.sent;
    if (parts.sent.textContent !== sentLine) parts.sent.textContent = sentLine;
    return parts.root;
  }

  /**
   * Draw the conversation.
   * @param {object} conversation
   * @param {{streaming: object|null, status: object|null, running: string|null,
   *   turnSteps: Map<string, {onPath: number, inTree: number, last: string|null}>, toolIndex: Map<string, object>,
   *   sentOf: (turn: string) => string, usageOf: (turn: string) => string|null, suggestions: string[]}} state
   */
  function render(conversation, { streaming: live, status, running, turnSteps, toolIndex, sentOf, usageOf, suggestions }) {
    if (atEnd()) personMoved = false;
    const question = conversation.messages.findLast(message => message.role === 'user') ?? null;
    const asked = question !== latestQuestion;
    latestQuestion = question;
    if (asked) personMoved = false;
    const follow = asked || atEnd() || (holding && !personMoved);
    const messages = conversation.messages;
    // The calls' results are kept in one message as each comes (`agent-loop.js`
    // `answered`): their count is part of what was drawn, or a result that
    // came after the first stayed "running" (WebKit on CI, run 43106620008:
    // the refused call of a reply of two, until the turn ended).
    const last = messages.at(-1);
    const from = { conversation, count: messages.length, last, results: last?.role === 'tool' ? last.results.length : null, running, turnSteps, suggestions, empty: messages.length === 0 && live === null };
    const same = drawnFrom !== null && Object.keys(from).every(key => drawnFrom[key] === from[key]);
    // Only the reply grew, or the working line changed: the rest stays as drawn.
    const nodes = same ? [] : drawMessages(conversation, from.empty, running, turnSteps, toolIndex, sentOf, usageOf, suggestions);
    const offset = same ? drawnCount : 0;
    if (!same) {
      drawnFrom = from;
      drawnCount = nodes.length;
    }
    if (live !== null) {
      const text = replyText(live);
      if (text !== streamedText) {
        streamedText = text;
        stream.update(text);
      }
      const notes = progressNotes(live);
      const notesKey = notes.join('\n');
      if (notesKey !== streamedNotes) {
        streamedNotes = notesKey;
        streamingNotes.replaceChildren(...notes.map(noteLine));
      }
      streamingNotes.hidden = notes.length === 0;
      if (text !== '' || notes.length > 0) nodes.push(streaming);
    } else if (streamedText !== null) {
      streamedText = null;
      streamedNotes = null;
      stream.clear();
      streamingNotes.replaceChildren();
    }
    if (status !== null) {
      const words = workingTextOf(status);
      if (workingText.textContent !== words) workingText.textContent = words;
      working.dataset.phase = status.phase;
      nodes.push(working);
    }
    // Keep what is already in place; move or add only what changed.
    nodes.forEach((node, index) => {
      const at = offset + index;
      if (log.children[at] !== node) log.insertBefore(node, log.children[at] ?? null);
    });
    while (log.children.length > offset + nodes.length) log.lastElementChild.remove();
    if (follow) place();
  }

  /**
   * The empty chat's suggestions, drawn when they change. Apart from the
   * full draw: a chip outlives the draw that made it, and a closure made in
   * that draw would keep the conversation drawn then (its messages).
   */
  function drawSuggestions(suggestions) {
    const key = suggestions.join('\n');
    if (key === shownSuggestions) return;
    shownSuggestions = key;
    chipsShown.abort();
    chipsShown = new AbortController();
    // The empty chat's suggestions are the panel's own choices, not a nested action.
    chips.replaceChildren(...suggestions.map(text => smallButton(text, 'btn-compact agent-chat-suggestion', `Ask: ${text}`, () => onSuggestion(text), chipsShown.signal, 'secondary')));
  }

  /** The conversation's messages, tool rows and turn footers, in order (a full draw). */
  function drawMessages(conversation, isEmpty, running, turnSteps, toolIndex, sentOf, usageOf, suggestions) {
    const nodes = [];
    let lastAssistant = null;
    /** turn → its agent messages and where the first is drawn (`foldTurn`) */
    const turns = new Map();
    /** The last message drawn (tool results are drawn into their calls' rows). */
    let previous = null;
    const messages = conversation.messages;
    if (isEmpty) {
      drawSuggestions(suggestions);
      nodes.push(empty);
    }
    messages.forEach((message, index) => {
      if (message.role === 'tool') {
        const calls = lastAssistant === null ? null : rows.get(lastAssistant);
        for (const result of message.results) {
          const row = calls?.get(result.id);
          if (row !== undefined) updateRow(row, result);
        }
      } else {
        let element = elements.get(message);
        if (element === undefined) {
          if (message.role === 'assistant') {
            element = assistantElement(message, toolIndex);
          } else {
            element = message.role === 'user' ? userElement(message) : noteElement(conversation, message);
          }
          elements.set(message, element);
        }
        // The agent's calls one after another are one message: its name said once.
        const continued = message.role === 'assistant' && previous?.role === 'assistant' && previous.turn === message.turn;
        if (continued) element.dataset.continued = 'true';
        else delete element.dataset.continued;
        previous = message;
        if (message.role === 'assistant') {
          lastAssistant = message;
          // A call with no result yet: running while its turn runs, else interrupted.
          for (const row of rows.get(message).values()) if (row.result === null) updateRow(row, null, message.turn === running);
          if (message.turn) {
            if (!turns.has(message.turn)) turns.set(message.turn, { turn: message.turn, running: message.turn === running, items: [], at: nodes.length });
            turns.get(message.turn).items.push({ message, parts: agentParts.get(message) });
          }
        }
        nodes.push(element);
      }
      const next = messages[index + 1];
      const turn = message.turn ?? null;
      const turnEnds = turn !== null && turn !== running && (next === undefined || next.role === 'user');
      if (turnEnds) {
        const facts = turnSteps.get(turn) ?? { inTree: 0, onPath: 0, last: null };
        let texts = footerTexts.get(turn);
        if (texts === undefined) {
          texts = { sent: sentOf(turn), tokens: usageOf(turn) };
          footerTexts.set(turn, texts);
        }
        nodes.push(footerFor(turn, { ...facts, ...texts }));
      }
    });
    // Each turn's fold, its summary row before its first agent message (from the last turn, so the places hold).
    for (const entry of [...turns.values()].reverse()) {
      const summary = foldTurn(entry);
      if (summary !== null) nodes.splice(entry.at, 0, summary);
    }
    return nodes;
  }

  /** Scroll to the person's message of `turn` and mark it for a moment; false when it is not shown. */
  function reveal(turn) {
    const element = log.querySelector(`.agent-msg-user[data-turn="${CSS.escape(turn)}"]`);
    if (element === null) return false;
    element.scrollIntoView({ block: 'nearest' });
    element.dataset.flash = 'true';
    element.addEventListener('animationend', () => { delete element.dataset.flash; }, { once: true, signal });
    return true;
  }

  return Object.freeze({
    render,
    reveal,
    /** Forget what was drawn, and let go of its listeners (another conversation is shown). */
    reset() {
      shown.abort();
      shown = new AbortController();
      summaries.clear();
      opened.clear();
      footers.clear();
      footerTexts.clear();
      drawnFrom = null;
      drawnCount = 0;
      personMoved = false;
      holding = false;
      latestQuestion = null;
      streamedText = null;
      streamedNotes = null;
      stream.clear();
      streamingNotes.replaceChildren();
      log.replaceChildren();
    },
    destroy() {
      shown.abort();
      chipsShown.abort();
      controller.abort();
      log.replaceChildren();
    },
  });
}
