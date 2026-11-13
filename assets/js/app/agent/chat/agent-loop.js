/**
 * @fileoverview One turn of the chat bar's agent: from the person's message
 * to the agent's last word.
 *
 * The model is called with the conversation and the catalog's tools; each
 * tool call it makes is run in this tab (`bridge/tool-call.js`: dispatched as
 * the agent, in this turn, so every change is a step of the person's
 * history labeled with the agent's name); the results go back to the model;
 * and so on until it answers without a call. Every message is added to the
 * conversation as it completes (`conversation.js`), so the chat shows it and
 * keeps it with the history.
 *
 * - **Stop** (the turn's signal) ends the turn at once: the words streamed
 *   so far are kept, a tool call running is stopped (a change it made is
 *   rolled back) and the calls not yet run are answered "not run", so the
 *   conversation stays one the model can be sent again.
 * - **Waiting out failures.** Too many requests, an overloaded provider and
 *   a dropped connection are tried again after a wait that grows (1 s, 2 s,
 *   4 s, … up to a minute, with jitter), or the wait the provider asked for;
 *   a dropped connection is tried again at once when the browser is back
 *   online. The turn says what it waits for and until when, and waits until
 *   the call goes through, the person stops it, or the chat's budget is
 *   spent (checked before each try). An answer Cellucid could not read is
 *   tried once more (a second answer usually reads; each try costs). Every
 *   other failure ends the turn with its sentence (a refused key, no credit,
 *   a model the key may not use).
 * - **Every call is counted.** A call that failed or was stopped after the
 *   provider began to answer cost tokens too, as do the summarizer's calls:
 *   the next message or note of the turn carries them (`otherCalls`,
 *   `conversation.js` `usageOf`), so the chat's tokens and its budget count
 *   every call made.
 * - **A conversation too long** for the model is summarised (`context.js`)
 *   and the call made again.
 * - Calls run one after the other, in the order the model made them: two
 *   changes never race, and each result is the state after it.
 * - **A question with choices** (`ask.js`, the chat's own tool): the call
 *   is answered at once and the turn ends after that reply's calls; the
 *   person's answer is their next message.
 * - **Never silence.** A turn always ends with words for the person: the
 *   reply, a question with choices, or a note (stopped, an error, a
 *   refusal, the longest answer reached, the budget spent, or a reply with
 *   no words: a model may end after its reasoning alone).
 *
 * @module app/agent/chat/agent-loop
 */

import { appendMessage, modelMessages, summarize, usageOf } from './conversation.js';
import { formatCount } from '../../../utils/format-units.js';
import { SUMMARY_SYSTEM, nextPromptTokens, overflows, summaryInputOf } from './context.js';
import { runToolCall } from '../bridge/tool-call.js';
import { ASKED_TEXT, ASK_TOOL, askOf } from './ask.js';
import { earlierResultContent } from '../bridge/data-guard.js';
import { dataScopeNow } from '../data-scope.js';
import { ProviderError, isRetryable } from '../providers/contract.js';
import { awaitWithSignal, isCancellation, throwIfAborted } from '../../../utils/abort.js';
import { backoffDelayMs } from '../../../utils/backoff.js';

/** What a turn was asked: the person's message's first line, its white space folded. */
function turnLabelOf(text) {
  const line = String(text ?? '').split('\n').map(part => part.trim()).find(part => part.length > 0) ?? '';
  return line.length === 0 ? null : line.replace(/\s+/gu, ' ');
}

/** First wait before a call is tried again; each failure doubles it. */
const RETRY_FIRST_MS = 1_000;
/** The longest wait between two tries (coming back online tries at once). */
export const RETRY_CEILING_MS = 60_000;

/** The wait before try `attempt` + 1 (0-based) of a call that failed with `error`. */
export function retryDelayOf(error, attempt, random = Math.random) {
  if (Number.isFinite(error?.retryAfterMs) && error.retryAfterMs > 0) return error.retryAfterMs;
  return Math.round(backoffDelayMs(attempt, { firstMs: RETRY_FIRST_MS, ceilingMs: RETRY_CEILING_MS, random }));
}

function waitFor(ms, signal, win) {
  let timer = null;
  let removeOnline = () => {};
  const done = new Promise(resolve => {
    timer = setTimeout(resolve, ms);
    if (typeof win?.addEventListener === 'function') {
      const back = () => resolve();
      win.addEventListener('online', back, { once: true });
      removeOnline = () => win.removeEventListener('online', back);
    }
  });
  return awaitWithSignal(done, signal).finally(() => {
    clearTimeout(timer);
    removeOnline();
  });
}

/** The chat's budget is spent: no more calls this turn. */
class BudgetSpent extends Error {}

/** No tokens yet. */
function noUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
}

/**
 * Call the model, trying again what may go through later. `onEvent` hears
 * each event; `onFailed` that an attempt failed (its events are void; its
 * tokens are the caller's to count); `beforeRetry` is asked before another
 * try (it throws to give up: the chat's budget).
 */
async function callModel({ provider, request, signal, setStatus, win, random, onFailed, onEvent, beforeRetry }) {
  let unreadable = 0;
  for (let attempt = 0; ; attempt++) {
    throwIfAborted(signal);
    try {
      for await (const event of provider.stream({ ...request, signal })) onEvent(event);
      return;
    } catch (error) {
      if (isCancellation(error) || signal?.aborted) {
        throwIfAborted(signal);
        throw error;
      }
      onFailed();
      const unreadableAgain = error instanceof ProviderError && error.kind === 'unreadable' && unreadable++ > 0;
      if (unreadableAgain) {
        throw new ProviderError('unreadable', `${error.message} It did again when asked once more; send your message again.`, { cause: error });
      }
      if (!isRetryable(error) && !(error instanceof ProviderError && error.kind === 'unreadable')) throw error;
      beforeRetry();
      const delay = retryDelayOf(error, attempt, random);
      const reason = error.kind === 'unreadable' ? `${error.message} Cellucid asks once more.` : error.message;
      setStatus({ phase: 'waiting', reason, retryAt: Date.now() + delay });
      await waitFor(delay, signal, win);
      setStatus({ phase: 'thinking' });
    }
  }
}

/** Ever smaller shares of each tool result the summarizer is sent, until the text fits. */
const SUMMARY_SHARE_FLOOR = 2 ** -20;

/**
 * Summarize the conversation before `before` with the turn's model. Each
 * call's tokens (the failed tries' too) are added to `spent`.
 */
async function writeSummary({ conversation, before, provider, key, model, signal, setStatus, win, random, spent, beforeRetry }) {
  setStatus({ phase: 'summarizing' });
  for (let share = 1; ; share /= 2) {
    let text = '';
    /** The tokens the call in progress reported (a later report replaces an earlier one). */
    let attempt = null;
    /** Count the call in progress; a try refused before any answer (nothing reported) cost nothing. */
    const count = (answered = false) => {
      if (attempt === null && !answered) return;
      for (const field of ['input', 'output', 'cacheRead', 'cacheWrite']) spent[field] += attempt?.[field] ?? 0;
      spent.calls += 1;
      attempt = null;
    };
    try {
      await callModel({
        provider,
        request: {
          key, model: model.id, system: SUMMARY_SYSTEM, tools: [], outputTokens: model.outputTokens,
          messages: [{ role: 'user', text: `${summaryInputOf(conversation, before, share)}\n\nWrite the summary now.` }],
        },
        signal, setStatus, win, random, beforeRetry,
        onFailed: () => {
          text = '';
          count();
        },
        onEvent: event => {
          if (event.type === 'text') text += event.text;
          else if (event.type === 'usage') attempt = event;
        },
      });
    } catch (error) {
      if (isCancellation(error) || signal.aborted) count();
      if (error instanceof ProviderError && error.kind === 'too-long' && share > SUMMARY_SHARE_FLOOR) continue;
      throw error;
    }
    count(true);
    if (text.trim() === '') throw new ProviderError('request', `${provider.label} wrote no summary of the conversation.`);
    summarize(conversation, text.trim(), before);
    return;
  }
}

function stoppedResult(call, toolIndex) {
  return {
    id: call.id, name: call.name, title: call.name === ASK_TOOL.name ? ASK_TOOL.title : toolIndex.get(call.name)?.title ?? call.name,
    content: [{ type: 'text', text: 'Not run: the person stopped this turn.' }], isError: true, step: null,
  };
}

/**
 * Run one turn: the person's message (with `turn`) is in the conversation.
 *
 * @param {{
 *   conversation: object,
 *   provider: object,
 *   key: string|null,
 *   model: {id: string, contextTokens: number|null, outputTokens: number|null},
 *   effort?: string|null,
 *   cacheLength?: string,
 *   budget?: number|null,
 *   system: string,
 *   tools: object[],
 *   toolIndex: Map<string, object>,
 *   actions: {dispatch: Function},
 *   turn: string,
 *   signal: AbortSignal,
 *   onChange: (change: {kind: 'message'|'status'|'text', message?: object, status?: object|null}) => void,
 *   lastUsage?: {input: number, count: number}|null,
 *   win?: object|null,
 *   random?: () => number,
 *   scopeOf?: () => {summariesOnly: boolean},
 * }} options - `lastUsage`: the prompt the conversation's last call reported, after how many
 *   model messages (the context estimate's starting point; null before the first call)
 * @returns {Promise<{ended: 'end'|'asked'|'stopped'|'error'|'refusal'|'max-tokens'|'empty'|'budget', error?: Error,
 *   usage: {input: number, output: number, cacheRead: number, cacheWrite: number, calls: number},
 *   lastUsage: {input: number, count: number}|null}>} `usage`: every call of the turn (`usageOf`)
 */
export async function runAgentTurn({
  conversation, provider, key, model, effort = null, cacheLength = '5m', budget = null, system, tools, toolIndex, actions, turn, signal, onChange,
  lastUsage = null, win = globalThis.window ?? null, random = Math.random, scopeOf = dataScopeNow,
}) {
  const userIndex = conversation.messages.findLastIndex(message => message.role === 'user' && message.turn === turn);
  if (userIndex === -1) throw new RangeError('A turn begins with the person\'s message in the conversation');
  const agent = provider.agent;
  let known = lastUsage;
  /** The reply being streamed, until it is added. */
  let current = null;
  /** The tokens the call in progress reported (a later report replaces an earlier one). */
  let attempt = null;
  /** Calls of this turn not on a message yet (failed or stopped tries, the summarizer's): the next message or note carries them. */
  let unrecorded = noUsage();
  /** The calls of the reply added last, until their results are: {calls, results}. */
  let unanswered = null;
  let lastStatus = null;
  /** What the turn does now; told once per change (a reply streams many pieces, each "writing"). */
  const setStatus = status => {
    if (status !== null && lastStatus !== null && Object.keys(status).length === 1 && Object.keys(lastStatus).length === 1 && status.phase === lastStatus.phase) return;
    lastStatus = status;
    onChange({ kind: 'status', status });
  };
  const add = message => {
    if ((message.role === 'assistant' || message.role === 'note') && unrecorded.calls > 0) {
      message.otherCalls = unrecorded;
      unrecorded = noUsage();
    }
    appendMessage(conversation, message);
    onChange({ kind: 'message', message });
  };
  /**
   * The call in progress ended without its answer (failed, stopped): what it
   * reported is still counted; a try refused before any answer cost nothing.
   */
  const countAttempt = () => {
    if (attempt === null) return;
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite']) unrecorded[field] += attempt?.[field] ?? 0;
    unrecorded.calls += 1;
    attempt = null;
  };
  /** The tokens of this chat so far, the calls not on a message yet included. */
  const spentNow = () => {
    const recorded = usageOf(conversation);
    return recorded.input + recorded.output + unrecorded.input + unrecorded.output;
  };
  /** The prompt the next call would send (the context estimate's, `nextPromptTokens`). */
  const nextPrompt = () => nextPromptTokens({
    conversation, lastInput: known?.input ?? null, lastCount: known?.count ?? 0, system, tools,
  });
  /**
   * Whether the next call would pass the chat's budget: it is not made. The
   * budget is a cap, so the call that would cross it is the one left out
   * (each call reads the whole prompt again, so a check against only what was
   * spent lets a budget end far past itself).
   */
  const overBudget = () => budget !== null && spentNow() + nextPrompt() > budget;
  /** Before another try: past the chat's budget, the turn ends there. */
  const beforeRetry = () => {
    if (overBudget()) throw new BudgetSpent();
  };
  const ended = (how, extra = {}) => ({ ended: how, ...extra, usage: usageOf(conversation, turn), lastUsage: known });

  async function summarizeBefore(before) {
    await writeSummary({ conversation, before, provider, key, model, signal, setStatus, win, random, spent: unrecorded, beforeRetry });
    known = null;
    add({
      role: 'note', turn, kind: 'summary',
      text: 'The conversation grew long for the model, so it now reads a summary of the earlier messages. You still see them all, and the history keeps every step.',
    });
  }

  function budgetNote() {
    const spent = spentNow();
    const next = spent >= budget ? '' : `, and its next call would read about ${formatCount(nextPrompt())} more`;
    add({
      role: 'note', turn, kind: 'limit',
      text: `This chat used ${formatCount(spent)} tokens, its budget is ${formatCount(budget)}${next}; raise it in the chat settings to go on.`,
    });
    return ended('budget');
  }

  try {
    // A conversation that would not fit is summarised before the person's message.
    if (userIndex > (conversation.summary?.before ?? 0) && overflows({
      conversation, window: model.contextTokens, lastInput: known?.input ?? null, lastCount: known?.count ?? 0, system, tools,
    })) {
      await summarizeBefore(userIndex);
    }
    while (true) {
      throwIfAborted(signal);
      // The person's budget for this chat: no model call past it.
      if (overBudget()) return budgetNote();
      setStatus({ phase: 'thinking' });
      current = {
        role: 'assistant', turn, provider: provider.id, agent, model: model.id, parts: [], at: Date.now(),
        epoch: conversation.epoch, stop: null,
      };
      const message = current;
      let sentCount = 0;
      for (let summarised = false; ;) {
        try {
          // Under the dataset's switch, what earlier results held of cells is not sent again.
          const messages = modelMessages(conversation, {
            contentOf: scopeOf().summariesOnly ? result => earlierResultContent(toolIndex.get(result.name) ?? null, result) : null,
          });
          sentCount = messages.length;
          await callModel({
            provider,
            request: { key, model: model.id, system, messages, tools, outputTokens: model.outputTokens, effort, cacheLength },
            signal, setStatus, win, random, beforeRetry,
            onFailed: () => {
              message.parts = [];
              countAttempt();
            },
            onEvent: event => {
              const last = message.parts[message.parts.length - 1];
              switch (event.type) {
                case 'text':
                  if (last?.type === 'text') last.text += event.text;
                  else message.parts.push({ type: 'text', text: event.text });
                  setStatus({ phase: 'writing' });
                  onChange({ kind: 'text', message });
                  break;
                case 'thinking':
                  setStatus({ phase: 'thinking' });
                  break;
                case 'progress':
                  // A note for the person between calls: shown as it comes, before the call it introduces.
                  if (last?.type === 'progress') last.text += event.text;
                  else message.parts.push({ type: 'progress', text: event.text });
                  onChange({ kind: 'text', message });
                  break;
                case 'tool-call':
                  message.parts.push({ type: 'tool-call', id: event.id, name: event.name, args: event.args });
                  break;
                case 'opaque':
                  message.parts.push({ type: 'opaque', provider: provider.id, value: event.value });
                  break;
                case 'usage':
                  attempt = { input: event.input, output: event.output, cacheRead: event.cacheRead, cacheWrite: event.cacheWrite };
                  break;
                case 'stop':
                  message.stop = event.reason;
                  if (event.detail) message.detail = event.detail;
                  break;
                default:
              }
            },
          });
          break;
        } catch (error) {
          if (!(error instanceof ProviderError) || error.kind !== 'too-long' || summarised) throw error;
          // Too long: summarize what came before this turn (or, inside a turn
          // that alone grew too long, everything so far) and call again.
          summarised = true;
          message.parts = [];
          const from = conversation.summary?.before ?? 0;
          const before = userIndex > from ? userIndex : conversation.messages.length;
          if (before <= from) throw error;
          await summarizeBefore(before);
          message.epoch = conversation.epoch;
        }
      }
      current = null;
      if (attempt !== null) {
        message.usage = attempt;
        known = { input: attempt.input, count: sentCount };
        attempt = null;
      }
      add(message);
      const calls = message.parts.filter(part => part.type === 'tool-call');
      if (calls.length === 0) {
        if (message.stop === 'refusal') {
          add({ role: 'note', turn, kind: 'refusal', text: message.detail ? `${agent} declined to go on: ${message.detail}` : `${agent} declined to go on.` });
          return ended('refusal');
        }
        if (message.stop === 'max-tokens') {
          add({ role: 'note', turn, kind: 'limit', text: `The reply reached the longest answer ${model.id} gives at once; ask it to go on.` });
          return ended('max-tokens');
        }
        // Ended with no word for the person (only reasoning, or nothing): the chat says so, never silence.
        if (!message.parts.some(part => part.type === 'text' && part.text.trim() !== '')) {
          add({ role: 'note', turn, kind: 'empty', text: `${agent} ended its turn without a reply; ask it to go on, or try again.` });
          return ended('empty');
        }
        return ended('end');
      }
      // The calls' results, kept as each one comes (the conversation is saved then), so a reload
      // mid-way keeps what finished: a read that ran would be answered "the page closed before this call
      // finished". Nothing is sent to a model before every call is answered.
      const answers = { role: 'tool', turn, results: [] };
      add(answers);
      const results = answers.results;
      const answered = result => {
        results.push(result);
        onChange({ kind: 'message', message: answers });
      };
      unanswered = { calls, results, answers };
      let asked = false;
      for (const call of calls) {
        if (signal.aborted) {
          answered(stoppedResult(call, toolIndex));
          continue;
        }
        if (call.name === ASK_TOOL.name) {
          // The chat's own question: answered here, shown by the chat; the person's answer is their next message.
          const question = askOf(call.args);
          const ok = !('problem' in question);
          asked ||= ok;
          answered({
            id: call.id, name: call.name, title: ASK_TOOL.title, step: null, isError: !ok,
            content: [{ type: 'text', text: ok ? ASKED_TEXT : question.problem }],
          });
          continue;
        }
        const title = toolIndex.get(call.name)?.title ?? call.name;
        setStatus({ phase: 'tool', tool: title });
        const { result, step, summariesOnly, code } = await runToolCall({
          actions, tools: toolIndex, name: call.name, args: call.args, agent, turn, signal,
          // The chat is the connection: a permission granted "in this chat" holds for its calls.
          connection: { id: conversation.id, kind: 'chat' }, scopeOf,
          // The history's turn record: the model, the chat and the message that asked.
          turnMeta: {
            model: model.id, conversation: conversation.id, message: turn,
            turnLabel: turnLabelOf(conversation.messages[userIndex].text),
          },
        });
        answered({
          id: call.id, name: call.name, title, content: result.content, isError: result.isError, step,
          // Made under the dataset's switch: sent again as it is, and the turn's Sent line can say so.
          ...(summariesOnly ? { summariesOnly: true } : {}),
          // Why the action refused, as its code (kept with the chat, never sent: the model reads the sentence).
          ...(code === undefined ? {} : { code }),
        });
      }
      unanswered = null;
      throwIfAborted(signal);
      if (asked) return ended('asked');
    }
  } catch (error) {
    if (isCancellation(error) || signal.aborted) {
      // The call stopped mid-answer cost what it reported so far.
      if (current !== null) countAttempt();
      // What was streamed before the Stop stays, as words only (the reply's, and the notes shown between calls).
      const words = current?.parts.filter(part => (part.type === 'text' || part.type === 'progress') && part.text !== '') ?? [];
      if (words.length > 0) add({ ...current, parts: words, stop: 'stopped' });
      add({ role: 'note', turn, kind: 'stopped', text: 'Stopped.' });
      return ended('stopped');
    }
    if (error instanceof BudgetSpent) return budgetNote();
    // Calls of the last reply not run: answered so, or the next call to the model would be refused.
    if (unanswered !== null) {
      const { calls, results, answers } = unanswered;
      unanswered = null;
      const reason = error?.message ?? String(error);
      answers.results = calls.map(call => results.find(result => result.id === call.id) ?? {
        id: call.id, name: call.name, title: toolIndex.get(call.name)?.title ?? call.name, isError: true, step: null,
        content: [{ type: 'text', text: `Not run: the turn failed (${reason}).` }],
      });
      onChange({ kind: 'message', message: answers });
    }
    add({
      role: 'note', turn, kind: 'error',
      text: error instanceof ProviderError ? error.message : `The chat stopped: ${error?.message ?? String(error)}`,
    });
    return ended('error', { error });
  } finally {
    setStatus(null);
  }
}
