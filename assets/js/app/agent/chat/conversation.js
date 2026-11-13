/**
 * @fileoverview A conversation of the chat bar: what the person and the
 * agent said, the tool calls and their results, as plain data, and what of
 * it is sent to a model and what is saved with the history.
 *
 * A conversation is `{id, createdAt, updatedAt, epoch, summary, messages,
 * received, seen}`; `received` names the turns it brought from a save or a share
 * (`transcriptForSave`): what they did is in the history it came with, so
 * nothing offers to do it again (`offersRetry`: no Try again on their notes);
 * `seen` is the history as its agent's last turn ended (`history-link.js`
 * `historySeen`, or null), kept with it so the next message says what the
 * person did since even after a reload or in a shared session.
 * Messages are the providers' neutral messages (`providers/contract.js`)
 * with what the chat shows besides:
 *
 * - `{role: 'user', text, turn, at, context?, since?, attached?}`: one per message
 *   the person sends; its `turn` names every step the agent takes in answer
 *   (`meta.turn`), so the history undoes the turn in one click; `context`
 *   is what Cellucid tells the model with it and the person does not see
 *   (their permissions for agents and the dataset's switch, when they
 *   changed); `since`: what changed in the history since the agent's last
 *   turn (its steps undone, steps others took: `history-link.js`
 *   `historySinceSentence`); `attached`: what the person attached (`{selection}`: a
 *   reference to their highlighted cells, `selection.js`), shown on the
 *   message and told to the model with it;
 * - `{role: 'assistant', turn, provider, agent, model, parts, at, epoch,
 *   stop, detail?, usage?, otherCalls?}`: one per model call (`usage`: its
 *   tokens; `otherCalls`, here and on a note: the calls before it with no
 *   reply of their own, `usageOf`);
 * - `{role: 'tool', turn, results: [{id, name, title, content, isError,
 *   step}]}`: the results of one call's tool calls, `step` the history step
 *   a change made (`{id, label}`) or null;
 * - `{role: 'note', turn, kind, text, otherCalls?}`: what the chat tells the person and
 *   never sends to a model (`stopped`, `error`, `refusal`, `limit`,
 *   `empty`: a reply with no words, `summary`, `saved`).
 *
 * **Append only.** Nothing sent to a model is edited afterwards: a model's
 * reasoning is bound to the conversation that produced it (Anthropic, and
 * OpenAI's encrypted reasoning, are sent back unchanged), and a prompt cache
 * holds only for a prefix that did not change.
 *
 * **Summary** (`context.js` decides when): the messages before
 * `summary.before` are replaced, for the model, by one user message holding
 * their summary (and what Cellucid last told the model among them, the
 * permissions and the person's instructions); the person still sees them
 * all. A summary starts a new
 * `epoch`: reasoning parts from an earlier epoch are not sent again (they
 * were made with the messages the summary replaced).
 *
 * **Saved with the history** (`transcriptOf`, `history.setChat`): the
 * messages without the providers' reasoning (opaque, of no use to a reader,
 * and bound to the conversation; the notes the person was shown between
 * calls, `progress` parts, are kept) and with each picture a tool returned
 * replaced by a line saying it was there. Such a transcript continues as a
 * conversation of its own (`conversationFrom`). One kept mid-turn (the page
 * closed or reloaded while a call ran or waited for the person) has calls
 * with no result: continued, each is answered with what became of it
 * (`closeInterrupted`: its step, when the history kept one, else nothing
 * applied), so the conversation stays one a model accepts.
 *
 * @module app/agent/chat/conversation
 */

import { quoteName } from '../../actions/targets/names.js';
import { isHistorySeen } from '../history-link.js';
import { createOpaqueId } from '../../../utils/opaque-id.js';
import { selectionContext } from './selection.js';
import { ASK_TOOL } from './ask.js';
import { failureDetailsText, sayFailure } from '../../../utils/errors.js';

export const TRANSCRIPT_SCHEMA = 1;

/** How the summary of earlier messages is put to the model. */
export const SUMMARY_LEAD = 'Summary of the conversation so far (the earlier messages are no longer shown to you; the history, read with history_get, holds every step taken):';

const ROLES = new Set(['user', 'assistant', 'tool', 'note']);
/**
 * A note's kinds. `saved`: the turn a save or a share was made in ends there in the file
 * (`transcriptForSave`); it says what the save holds, not that the turn failed.
 */
const NOTE_KINDS = new Set(['stopped', 'error', 'refusal', 'limit', 'empty', 'summary', 'saved']);

/**
 * The notes that offer Try again: a turn that ended short (an error, a stop, a limit, no
 * answer), made in this page. A `saved` note never does, nor any note of a turn the
 * conversation received (`offersRetry`).
 */
export const RETRY_NOTE_KINDS = Object.freeze(['error', 'stopped', 'limit', 'empty']);

/** A new conversation. */
export function createConversation({ id = `chat-${createOpaqueId()}`, now = Date.now() } = {}) {
  return { id, createdAt: now, updatedAt: now, epoch: 0, summary: null, messages: [], received: [], seen: null };
}

/**
 * Whether a message offers Try again: a note of a turn that ended short, made in this page.
 * A turn the conversation received (a session file opened, a saved state loaded) is the
 * sender's: Try again would send their message to this page's agent and act again on what the
 * history it came with already holds.
 * @param {{received: string[]}} conversation
 * @param {object} message
 */
export function offersRetry(conversation, message) {
  return message.role === 'note' && RETRY_NOTE_KINDS.includes(message.kind)
    && typeof message.turn === 'string' && !conversation.received.includes(message.turn);
}

/** Add one message (module overview) and mark the conversation changed. */
export function appendMessage(conversation, message, now = Date.now()) {
  if (!ROLES.has(message?.role)) throw new TypeError(`A conversation message has a role (${[...ROLES].join(', ')})`);
  if (message.role === 'note' && !NOTE_KINDS.has(message.kind)) throw new TypeError(`A note is one of ${[...NOTE_KINDS].join(', ')}`);
  conversation.messages.push(message);
  conversation.updatedAt = now;
  return message;
}

/** What Cellucid adds to a message of the person for the model: its attachments. */
function attachedText(message) {
  return message.attached?.selection ? selectionContext(message.attached.selection) : null;
}

/**
 * What Cellucid tells the model with a message of a turn the conversation
 * received (a session file or a saved state opened): it was another person's,
 * answered by their agent in their browser. Without it a model continuing a
 * colleague's conversation takes the work for its own and the newcomer for the
 * sender ("all 37 steps were taken by me at your request").
 */
export const RECEIVED_TOLD = 'This message, and the work that answered it, came with the conversation from another browser '
  + '(a session file or a saved state someone shared): another person wrote it and their agent did that work; its steps are '
  + 'in the history they shared. The person writing to you now opened it and may not know what was done.';

/** A message of the person as the model reads it: their words, then what Cellucid tells with them. */
function userText(message, { received = false } = {}) {
  const told = [received ? RECEIVED_TOLD : null, message.context, message.since, attachedText(message)].filter(Boolean);
  return [message.text, ...told.map(text => `[Cellucid: ${text}]`)].join('\n\n');
}

/**
 * The messages a model is sent now: the summary (when there is one), then
 * everything after it. `contentOf`: what an earlier tool result is sent as
 * (left out: as it is; the chat gives the dataset switch's rule,
 * `bridge/data-guard.js` `earlierResultContent`).
 * @param {object} conversation
 * @param {{contentOf?: ((result: object) => object[])|null}} [options]
 */
export function modelMessages(conversation, { contentOf = null } = {}) {
  const out = [];
  const start = conversation.summary?.before ?? 0;
  if (conversation.summary !== null) {
    // What Cellucid last told the model before the summary (the permissions, the person's instructions) goes with it.
    const told = conversation.messages.slice(0, start).findLast(message => message.role === 'user' && message.context)?.context ?? null;
    out.push({ role: 'user', text: `${SUMMARY_LEAD}\n\n${conversation.summary.text}${told === null ? '' : `\n\n[Cellucid: ${told}]`}` });
  }
  for (const message of conversation.messages.slice(start)) {
    if (message.role === 'user') {
      out.push({ role: 'user', text: userText(message, { received: conversation.received.includes(message.turn) }) });
    } else if (message.role === 'assistant') {
      const current = (message.epoch ?? 0) === conversation.epoch;
      const parts = message.parts.filter(part => part.type !== 'opaque' || current);
      if (parts.length > 0) out.push({ role: 'assistant', parts });
    } else if (message.role === 'tool') {
      out.push({ role: 'tool', results: message.results.map(result => ({
        id: result.id, name: result.name, content: contentOf === null ? result.content : contentOf(result), isError: result.isError,
      })) });
    }
  }
  return out;
}

/**
 * Replace, for the model, every message before `before` by `text`: the
 * conversation's next request starts with the summary.
 */
export function summarize(conversation, text, before, now = Date.now()) {
  if (!Number.isSafeInteger(before) || before < 0 || before > conversation.messages.length) {
    throw new RangeError('A summary replaces the messages before a position of the conversation');
  }
  conversation.summary = { text, before, at: now };
  conversation.epoch += 1;
  conversation.updatedAt = now;
}

/** Each turn of the conversation: its user message's index and the turn id. */
export function turnsOf(conversation) {
  const out = [];
  conversation.messages.forEach((message, index) => {
    if (message.role === 'user') out.push({ turn: message.turn, index });
  });
  return out;
}

/** The text of an assistant message (its text parts joined). */
export function replyText(message) {
  return message.parts.filter(part => part.type === 'text').map(part => part.text).join('');
}

/** The notes an assistant message showed the person between its calls (`progress` parts), in order, white space trimmed. */
export function progressNotes(message) {
  return message.parts.filter(part => part.type === 'progress').map(part => part.text.trim()).filter(text => text !== '');
}

function savedContent(content) {
  return content.map(item => (item.type === 'image'
    ? { type: 'text', text: `[A picture (${item.mimeType}) was returned here; it is not kept with the conversation.]` }
    : { type: 'text', text: item.text }));
}

/**
 * The conversation as kept with the history: plain JSON, without the
 * providers' reasoning and without pictures (module overview).
 */
export function transcriptOf(conversation) {
  return {
    schema: TRANSCRIPT_SCHEMA,
    id: conversation.id,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    summary: conversation.summary === null ? null : { ...conversation.summary },
    // Only a conversation that brought turns says so (one of this page's own is kept as it was).
    ...(conversation.received.length > 0 ? { received: [...conversation.received] } : {}),
    // What its agent last saw of the history (none before its first turn ends).
    ...(conversation.seen === null ? {} : { seen: structuredClone(conversation.seen) }),
    messages: conversation.messages.map(message => {
      if (message.role === 'assistant') {
        const { parts, ...rest } = message;
        return { ...rest, epoch: null, parts: parts.filter(part => part.type !== 'opaque').map(part => ({ ...part })) };
      }
      if (message.role === 'tool') {
        return { ...message, results: message.results.map(result => ({ ...result, content: savedContent(result.content) })) };
      }
      return { ...message };
    }),
  };
}

function requireTranscript(transcript) {
  if (transcript?.schema !== TRANSCRIPT_SCHEMA) {
    throw new RangeError(`This conversation was saved by another version of Cellucid (transcript schema ${JSON.stringify(transcript?.schema)})`);
  }
  if (typeof transcript.id !== 'string' || !Array.isArray(transcript.messages)) throw new TypeError('A saved conversation has an id and messages');
  for (const message of transcript.messages) {
    if (!ROLES.has(message?.role)) throw new TypeError('A saved conversation holds a message of no known role');
  }
  const received = transcript.received;
  if (received !== undefined && (!Array.isArray(received) || received.length === 0
    || received.some(turn => typeof turn !== 'string' || turn.length === 0) || new Set(received).size !== received.length)) {
    throw new TypeError('A saved conversation names the turns it received as distinct turn ids, or not at all');
  }
  if (transcript.seen !== undefined && !isHistorySeen(transcript.seen)) {
    throw new TypeError('A saved conversation keeps the history its agent last saw as its steps, tracker and dataset, or not at all');
  }
  return transcript;
}

/**
 * A saved transcript as a conversation that continues: its reasoning was
 * not kept, so every assistant message is of an earlier epoch.
 */
export function conversationFrom(transcript) {
  const exact = requireTranscript(structuredClone(transcript));
  return {
    id: exact.id,
    createdAt: exact.createdAt ?? Date.now(),
    updatedAt: exact.updatedAt ?? exact.createdAt ?? Date.now(),
    epoch: 0,
    summary: exact.summary ?? null,
    messages: exact.messages.map(message => (message.role === 'assistant' ? { ...message, epoch: -1 } : message)),
    received: exact.received ?? [],
    seen: exact.seen ?? null,
  };
}

/** The words a call answered by `closeInterrupted` begins with. */
export const INTERRUPTED_LEAD = 'The page closed before this call';

/** The note of a turn the page closed in (`closeInterrupted`): it says so, with Try again. */
export const INTERRUPTED_TURN_TEXT = 'The page closed during this turn, so it stopped here.';

/**
 * Answer every call a kept conversation holds without a result (the page
 * closed mid-turn): with its step, when the history kept one the turn's
 * results do not name (the call was applied, its answer was not kept),
 * else "nothing was applied". The answers go right after the call's reply,
 * marked `interrupted`. A turn that ends on its calls' results (the page
 * closed while the model was to answer them, or one of them was cut) gets a
 * `stopped` note saying so, with Try again: it ended with no word and no
 * mark. Returns how many calls were answered and turns noted.
 *
 * @param {object} conversation - continued from a transcript (`conversationFrom`): nothing of it was sent in this page
 * @param {{
 *   stepsOfTurn: (turn: string) => Array<{id: string, type: string, label: string}>,
 *   toolOf: (name: string) => ({type: string, title: string}|undefined),
 * }} history - `stepsOfTurn`: the turn's steps in the tracker shown, oldest first;
 *   `toolOf`: the action a tool name runs
 * @returns {number}
 */
export function closeInterrupted(conversation, { stepsOfTurn, toolOf }) {
  let closed = 0;
  const messages = conversation.messages;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    const calls = message.parts.filter(part => part.type === 'tool-call');
    if (calls.length === 0) continue;
    const next = messages[index + 1];
    const answered = next?.role === 'tool' ? next : null;
    const missing = calls.filter(call => !answered?.results.some(result => result.id === call.id));
    if (missing.length === 0) continue;
    // The turn's steps no kept result names: made by the calls whose answers were lost, in their order.
    const named = new Set(messages.filter(other => other.role === 'tool' && other.turn === message.turn)
      .flatMap(other => other.results).map(result => result.step?.id).filter(Boolean));
    const unnamed = stepsOfTurn(message.turn).filter(step => !named.has(step.id));
    const answers = new Map(missing.map(call => {
      const tool = toolOf(call.name);
      const at = tool === undefined ? -1 : unnamed.findIndex(step => step.type === tool.type);
      const step = at === -1 ? null : unnamed.splice(at, 1)[0];
      const text = step === null
        ? `${INTERRUPTED_LEAD} finished; nothing was applied.`
        : `${INTERRUPTED_LEAD}'s answer was kept; it was applied: ${quoteName(step.label)}, a step of the history.`;
      return [call.id, {
        id: call.id, name: call.name, title: tool?.title ?? call.name, isError: step === null, interrupted: true,
        step: step === null ? null : { id: step.id, label: step.label }, content: [{ type: 'text', text }],
      }];
    }));
    const results = calls.map(call => answered?.results.find(result => result.id === call.id) ?? answers.get(call.id));
    if (answered !== null) answered.results = results;
    else messages.splice(index + 1, 0, { role: 'tool', turn: message.turn, results });
    closed += missing.length;
  }
  // A turn whose last message is its calls' results ended there: say so (never sent to a model).
  // A question with choices ends its turn on its result by design: the answer is the next turn.
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== 'tool' || messages[index + 1]?.turn === message.turn) continue;
    if (message.results.some(result => result.name === ASK_TOOL.name)) continue;
    messages.splice(index + 1, 0, { role: 'note', turn: message.turn, kind: 'stopped', text: INTERRUPTED_TURN_TEXT });
    closed++;
  }
  if (closed > 0) conversation.updatedAt = Date.now();
  return closed;
}

/** The words a call still running when its conversation was saved is answered with (`transcriptForSave`). */
export const SAVED_MID_CALL_TEXT = 'This call was still running when this conversation was saved; what it did is not in this save.';

/**
 * The words the call that made the save itself is answered with: an agent's
 * `history_share` or `history_save` holds the conversation as it stood while
 * it ran. Answered "still running … what it did is not in this save", the
 * colleague's agent reading the file would say "the session-file export
 * didn't finish" of the very file it was reading.
 */
export const SAVED_BY_CALL_TEXT = 'This call made the save this conversation is kept in (the session file or saved state it was opened from); its own answer came after, so it is not in the save.';

/** The tools whose call makes a save that holds the conversation (`transcriptForSave`). */
const SAVING_TOOLS = Object.freeze(['history_share', 'history_save']);

/** The note of a turn a save or a share was made in (`transcriptForSave`). */
export const SAVED_MID_TURN_TEXT = 'This conversation was saved during this turn; what followed is not in this save.';

/**
 * A kept transcript as a named save or a session file holds it
 * (`session/share-scope.js`).
 *
 * - **Every turn it holds is received** (`received`): opened from the file
 *   or the saved state, the conversation is the sender's up to there, and
 *   no note of those turns offers Try again (`offersRetry`); turns sent
 *   after it was opened are this page's own.
 * - **A save made during a turn** (the agent's own `history_save` or
 *   `history_share`, or the person's while it works) takes the conversation
 *   as it stands: the turn's last calls have no result yet. They are
 *   answered here as still running when it was saved (the saving call
 *   itself as the save it made, `SAVED_BY_CALL_TEXT`), and the turn ends on
 *   a note saying so, so the conversation opened from the file is whole and
 *   true: `closeInterrupted` would otherwise say the page closed and nothing
 *   was applied, of the very save that holds it.
 * @param {object} transcript - `transcriptOf`'s
 * @returns {object} a new transcript (the given one is not changed)
 */
export function transcriptForSave(transcript) {
  const messages = transcript.messages.map(message => ({ ...message }));
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    const calls = (message.parts ?? []).filter(part => part.type === 'tool-call');
    if (calls.length === 0) continue;
    const next = messages[index + 1];
    const answered = next?.role === 'tool' ? next : null;
    if (calls.every(call => answered?.results.some(result => result.id === call.id))) continue;
    const results = calls.map(call => answered?.results.find(result => result.id === call.id) ?? {
      id: call.id, name: call.name, title: call.name, isError: false, interrupted: true, step: null,
      content: [{ type: 'text', text: SAVING_TOOLS.includes(call.name) ? SAVED_BY_CALL_TEXT : SAVED_MID_CALL_TEXT }],
    });
    if (answered !== null) messages[index + 1] = { ...answered, results };
    else messages.splice(index + 1, 0, { role: 'tool', turn: message.turn, results });
  }
  // The turn the save was made in ends on its calls' results: say why (a question with choices ends so by design).
  const last = messages.at(-1);
  if (last?.role === 'tool' && !last.results.some(result => result.name === ASK_TOOL.name)) {
    messages.push({ role: 'note', turn: last.turn, kind: 'saved', text: SAVED_MID_TURN_TEXT });
  }
  const received = [...new Set([...(transcript.received ?? []), ...messages.map(message => message.turn).filter(turn => typeof turn === 'string')])];
  const { received: _received, ...rest } = transcript;
  return { ...rest, messages, ...(received.length > 0 ? { received } : {}) };
}

/**
 * The tokens of a conversation, or of one of its turns: `{input, output,
 * cacheRead, cacheWrite, calls}` summed over every model call it made
 * (`input` counts each call's whole prompt, cached parts included): each
 * reply's own call (`usage`), and the calls with no reply of their own that
 * a reply or a note carries (`otherCalls`: tries that failed or were stopped
 * after the provider began to answer, the summarizer's).
 * @param {object} conversation
 * @param {string|null} [turn]
 */
export function usageOf(conversation, turn = null) {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
  const add = (usage, calls) => {
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite']) total[field] += usage[field] ?? 0;
    total.calls += calls;
  };
  for (const message of conversation.messages) {
    if (turn !== null && message.turn !== turn) continue;
    if (message.role === 'assistant' && message.usage) add(message.usage, 1);
    if (message.otherCalls) add(message.otherCalls, message.otherCalls.calls ?? 0);
  }
  return total;
}

/**
 * What left this browser in a turn, for the provider: the person's message
 * (and what Cellucid told the model with it), each tool result the model was
 * sent (its characters), the pictures among them. The dataset's files never
 * leave, but a result carries what the tool returned: names and counts, and
 * for some tools part of the data itself (the values of cells
 * `cells.values` reads, a picture of the plot), unless every result of the
 * turn was made under the dataset's switch (names and summaries only: each
 * result marked `summariesOnly` by the tool call).
 * @param {object} conversation
 * @param {string} turn
 * @returns {{message: number, results: number, resultChars: number, pictures: number, tools: string[], summariesOnly: boolean}}
 */
export function sentOf(conversation, turn) {
  const out = { message: 0, results: 0, resultChars: 0, pictures: 0, tools: [], summariesOnly: false };
  let guarded = true;
  for (const message of conversation.messages) {
    if (message.turn !== turn) continue;
    if (message.role === 'user') out.message += userText(message).length;
    else if (message.role === 'tool') {
      for (const result of message.results) {
        out.results += 1;
        // A question asked carries nothing of the data.
        if (result.name !== ASK_TOOL.name) guarded = guarded && result.summariesOnly === true;
        if (!out.tools.includes(result.name)) out.tools.push(result.name);
        for (const item of result.content) {
          if (item.type === 'image') out.pictures += 1;
          else out.resultChars += item.text.length;
        }
      }
    }
  }
  out.summariesOnly = out.results > 0 && guarded;
  return out;
}

/**
 * What the person is told when the conversations kept with a tracker cannot
 * be shown (never lost silently): `chats` holds some, and the newest
 * this version reads (`latestConversation`) is null or `error` was thrown
 * reading it. A transcript of another schema was saved by another version
 * of Cellucid, which this one cannot read, and is said as that; any other
 * failure as `sayFailure` says it, its words under Details. Null when there
 * is nothing to say.
 *
 * @param {Array<[string, unknown]>} chats
 * @param {unknown} [error] - the failure reading the newest readable one, if any
 * @returns {{message: string, details: string}|null}
 */
export function unreadConversationNotice(chats, error = undefined) {
  if (chats.length === 0) return null;
  const lead = chats.length === 1 ? 'The conversation kept with this history' : `${chats.length} conversations kept with this history`;
  const others = chats.map(([, transcript]) => transcript).filter(transcript => transcript?.schema !== TRANSCRIPT_SCHEMA);
  if (error === undefined) {
    if (others.length === 0) return null;
    const newer = others.some(transcript => Number.isInteger(transcript?.schema) && transcript.schema > TRANSCRIPT_SCHEMA);
    return {
      message: `${lead} could not be shown: ${others.length === chats.length ? (chats.length === 1 ? 'it was' : 'they were') : `${others.length} of them ${others.length === 1 ? 'was' : 'were'}`} saved by ${newer ? 'a newer' : 'an earlier'} version of Cellucid, which this version cannot read. ${chats.length === 1 ? 'It stays' : 'They stay'} with the history as kept.`,
      details: others.map(transcript => `transcript schema ${JSON.stringify(transcript?.schema ?? null)}; this version reads ${TRANSCRIPT_SCHEMA}`).join('\n'),
    };
  }
  const said = sayFailure(error);
  return {
    message: `The newest conversation kept with this history could not be shown: ${said}${/[.!?]$/.test(said) ? '' : '.'} It stays with the history as kept.`,
    details: failureDetailsText(error),
  };
}

/** The most recent of the conversations kept with a tracker (`history.chatsOf`), or null. */
export function latestConversation(chats) {
  let latest = null;
  for (const [, transcript] of chats) {
    if (transcript?.schema !== TRANSCRIPT_SCHEMA) continue;
    if (latest === null || (transcript.updatedAt ?? 0) > (latest.updatedAt ?? 0)) latest = transcript;
  }
  return latest;
}
