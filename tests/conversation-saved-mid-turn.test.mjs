/**
 * A conversation a save or a share takes during a turn. A session file an
 * agent's `history_share` writes "with our conversations" must not make the
 * person who opens it read, on that very call, "The page closed before this
 * call finished; nothing was applied" and "The page closed during this
 * turn", nor make an agent continuing a named save tell the person the save
 * had "reported that nothing was applied". A save and a share keep such a
 * turn as it was when saved, said so (`transcriptForSave`, applied by
 * `session/share-scope.js`); a conversation kept whole is kept as it is.
 *
 * A conversation a save or a share holds is **received** where it is opened:
 * the sender's own failure notes must not offer Try again, which would send
 * the sender's message to this page's agent and act again on what the history
 * it came with holds. The transcript names the turns it brought (`received`), and no note of those
 * turns offers Try again (`offersRetry`), nor does a question of theirs offer
 * its choices (`ask.js` `pendingQuestion`); turns sent after are this page's.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INTERRUPTED_LEAD, RECEIVED_TOLD, RETRY_NOTE_KINDS, SAVED_BY_CALL_TEXT, SAVED_MID_CALL_TEXT, SAVED_MID_TURN_TEXT, appendMessage, closeInterrupted, conversationFrom,
  createConversation, modelMessages, offersRetry, sentOf, transcriptForSave, transcriptOf,
} from '../assets/js/app/agent/chat/conversation.js';
import { summaryInputOf } from '../assets/js/app/agent/chat/context.js';
import { ASK_TOOL, pendingQuestion } from '../assets/js/app/agent/chat/ask.js';

const call = (id, name) => ({ type: 'tool-call', id, name, args: {} });
const result = (id, name) => ({ id, name, title: name, isError: false, step: null, content: [{ type: 'text', text: '{}' }] });

function transcript(messages) {
  return { schema: 1, id: 'chat-1', createdAt: 1, updatedAt: 2, summary: null, messages };
}

const DONE = [
  { role: 'user', text: 'Color by score', turn: 't1', at: 1 },
  { role: 'assistant', turn: 't1', parts: [call('c1', 'color_by')], epoch: null },
  { role: 'tool', turn: 't1', results: [result('c1', 'color_by')] },
  { role: 'assistant', turn: 't1', parts: [{ type: 'text', text: 'Done.' }], epoch: null },
];

test('a turn the save was made in ends as saved: its running call answered so, a note after it', () => {
  const saved = transcriptForSave(transcript([
    ...DONE,
    { role: 'user', text: 'Share it with our conversation', turn: 't2', at: 3 },
    { role: 'assistant', turn: 't2', parts: [{ type: 'text', text: 'Writing the file.' }, call('c2', 'history_share')], epoch: null },
  ]));
  const shared = saved.messages.slice(DONE.length + 2);
  // The share call made the file itself: said so, never "still running … not in this save".
  assert.deepEqual(shared[0].results.map(each => [each.name, each.isError, each.content[0].text]), [['history_share', false, SAVED_BY_CALL_TEXT]]);
  assert.deepEqual(shared[1], { role: 'note', turn: 't2', kind: 'saved', text: SAVED_MID_TURN_TEXT });
  // A saved note says what the file holds: it offers no Try again, which in a received file would
  // send the sender's message to this page's agent and act again.
  assert.equal(RETRY_NOTE_KINDS.includes(shared[1].kind), false);
  assert.ok(RETRY_NOTE_KINDS.includes('stopped'));
  // The note is a kind a conversation holds.
  appendMessage(conversationFrom(saved), { ...shared[1] });
  // Opened from the file, nothing is left for "the page closed" to answer.
  const continued = conversationFrom(saved);
  assert.equal(closeInterrupted(continued, { stepsOfTurn: () => [], toolOf: () => undefined }), 0);
  assert.ok(!JSON.stringify(continued.messages).includes(INTERRUPTED_LEAD));
});

test('another call still running when the person saved is answered as running; the saving calls as the save', () => {
  const saved = transcriptForSave(transcript([
    ...DONE,
    { role: 'user', text: 'Run markers and save', turn: 't3', at: 3 },
    { role: 'assistant', turn: 't3', parts: [call('c3', 'analysis_run'), call('c4', 'history_save')], epoch: null },
  ]));
  const answers = saved.messages.at(-2).results.map(each => [each.name, each.content[0].text]);
  assert.deepEqual(answers, [['analysis_run', SAVED_MID_CALL_TEXT], ['history_save', SAVED_BY_CALL_TEXT]]);
  assert.match(SAVED_BY_CALL_TEXT, /made the save this conversation is kept in/);
});

test('a call answered whose turn had not ended yet gets the note only; a whole conversation is kept as it is', () => {
  const midway = transcriptForSave(transcript([
    ...DONE,
    { role: 'user', text: 'Save it', turn: 't2', at: 3 },
    { role: 'assistant', turn: 't2', parts: [call('c2', 'history_save')], epoch: null },
    { role: 'tool', turn: 't2', results: [result('c2', 'history_save')] },
  ]));
  assert.equal(midway.messages.at(-1).text, SAVED_MID_TURN_TEXT);
  assert.equal(midway.messages.filter(message => message.role === 'tool').flatMap(message => message.results).some(each => each.interrupted), false);
  const whole = transcript(DONE);
  assert.deepEqual(transcriptForSave(whole), { ...whole, received: ['t1'] });
  assert.equal(whole.received, undefined, 'the given transcript is not changed');
});

test('a question with choices ends its turn on its result by design: no note', () => {
  const asked = transcript([
    { role: 'user', text: 'Filter the outliers', turn: 't1', at: 1 },
    { role: 'assistant', turn: 't1', parts: [call('c1', ASK_TOOL.name)], epoch: null },
    { role: 'tool', turn: 't1', results: [result('c1', ASK_TOOL.name)] },
  ]);
  assert.deepEqual(transcriptForSave(asked), { ...asked, received: ['t1'] });
});

const FAILED = [
  { role: 'user', text: 'Recolor by score', turn: 't1', at: 1 },
  { role: 'note', turn: 't1', kind: 'error', text: 'The provider refused the request.' },
  { role: 'user', text: 'Stop that', turn: 't2', at: 2 },
  { role: 'note', turn: 't2', kind: 'stopped', text: 'Stopped.' },
];

test('a received conversation offers no Try again on the sender\'s notes; turns sent after it are this page\'s own', () => {
  // In the sender's page the notes offer Try again.
  const own = conversationFrom(transcript(FAILED));
  assert.deepEqual(own.received, []);
  assert.deepEqual(own.messages.filter(message => offersRetry(own, message)).map(message => message.turn), ['t1', 't2']);
  // Opened from a file or a saved state: the sender's turns are received, and none offers it.
  const received = conversationFrom(transcriptForSave(transcript(FAILED)));
  assert.deepEqual(received.received, ['t1', 't2']);
  assert.deepEqual(received.messages.filter(message => offersRetry(received, message)), []);
  // A turn of this page's, failed after it was opened, offers it.
  appendMessage(received, { role: 'user', text: 'Again, here', turn: 't3', at: 3 });
  appendMessage(received, { role: 'note', turn: 't3', kind: 'error', text: 'The provider refused the request.' });
  assert.deepEqual(received.messages.filter(message => offersRetry(received, message)).map(message => message.turn), ['t3']);
  // Kept with the history (the autosave) and continued after a reload, it is still received; saved
  // again, it names every turn it holds.
  const reloaded = conversationFrom(transcriptOf(received));
  assert.deepEqual(reloaded.received, ['t1', 't2']);
  assert.deepEqual(transcriptForSave(transcriptOf(received)).received, ['t1', 't2', 't3']);
  // A conversation of this page's own is kept as it was: no `received` key.
  assert.equal('received' in transcriptOf(createConversation({ id: 'c', now: 1 })), false);
});

test('a model continuing a received conversation is told its turns were another person\'s and their agent\'s', () => {
  // A colleague opens a shared session and asks "what did my colleague find?"; the model must not
  // answer "all 37 earlier steps were taken by me (Claude) at your request".
  const received = conversationFrom(transcriptForSave(transcript(DONE)));
  appendMessage(received, { role: 'user', text: 'What did my colleague find?', turn: 't2', at: 3 });
  const sent = modelMessages(received).filter(message => message.role === 'user');
  assert.equal(sent[0].text, `Color by score\n\n[Cellucid: ${RECEIVED_TOLD}]`);
  assert.equal(sent[1].text, 'What did my colleague find?');
  // The sender's own page sends its turns as its own.
  assert.equal(modelMessages(conversationFrom(transcript(DONE)))[0].text, 'Color by score');
  // What this browser sent for a turn never counts the marker.
  assert.equal(sentOf(received, 't1').message, 'Color by score'.length);
  // A summary of it keeps who was who.
  const summary = summaryInputOf(received, received.messages.length);
  assert.match(summary, /^Another person \(received with the conversation\): Color by score/m);
  assert.match(summary, /^Their agent: Done\./m);
  assert.match(summary, /^Person: What did my colleague find\?/m);
});

test('a received question offers no choices: it was put to the sender', () => {
  const asking = [
    { role: 'user', text: 'Filter the outliers', turn: 't1', at: 1 },
    { role: 'assistant', turn: 't1', parts: [{ type: 'tool-call', id: 'c1', name: ASK_TOOL.name, args: { question: 'Which cutoff?', choices: ['3 MAD', '5 MAD'] } }], epoch: null },
    { role: 'tool', turn: 't1', results: [result('c1', ASK_TOOL.name)] },
  ];
  assert.equal(pendingQuestion(conversationFrom(transcript(asking))).question, 'Which cutoff?');
  assert.equal(pendingQuestion(conversationFrom(transcriptForSave(transcript(asking)))), null);
});

test('a transcript names the turns it received as distinct turn ids, or not at all', () => {
  for (const received of [[], ['t1', 't1'], [''], [3], 't1']) {
    assert.throws(() => conversationFrom({ ...transcript(FAILED), received }), TypeError, JSON.stringify(received));
  }
});

test('a save and a share keep a conversation taken during a turn as saved (share-scope)', async () => {
  const { goldenSession } = await import('../scripts/generate-history-golden.mjs');
  const { SAVE_DEFAULTS, shareHistory } = await import('../assets/js/app/session/share-scope.js');
  const { valuesAtStep } = await import('../assets/js/app/session/history-file.js');
  const session = await goldenSession();
  const active = session.trackers.find(tracker => tracker.id === session.activeTracker);
  const running = transcript([
    { role: 'user', text: 'Share it', turn: 't9', at: 3 },
    { role: 'assistant', turn: 't9', parts: [call('c9', 'history_share')], epoch: null },
  ]);
  const trackers = session.trackers.map(tracker => (tracker === active ? { ...tracker, chats: [...tracker.chats, ['chat-running', running]] } : tracker));
  const shared = await shareHistory({
    snapshot: { dataset: active.dataset, activeTracker: session.activeTracker, trackers },
    shown: valuesAtStep(active.steps, active.headId), choice: { ...SAVE_DEFAULTS, chats: true }, valueOf: hash => session.values.get(hash),
    catalog: session.catalog, newTrackerId: () => 't-77777777-7777-4777-8777-777777777777', now: Date.UTC(2026, 10, 4),
  });
  const kept = shared.history.trackers.find(tracker => tracker.id === active.id).chats.find(([id]) => id === 'chat-running')[1];
  assert.equal(kept.messages.at(-1).text, SAVED_MID_TURN_TEXT);
  assert.equal(kept.messages.at(-2).results[0].content[0].text, SAVED_BY_CALL_TEXT);
  assert.deepEqual(kept.received, ['t9']);
  // The other conversations, whole, are kept as they were, their turns received.
  for (const [id, transcriptKept] of shared.history.trackers.find(tracker => tracker.id === active.id).chats) {
    if (id === 'chat-running') continue;
    const { received, ...rest } = transcriptKept;
    const before = active.chats.find(([other]) => other === id)[1];
    assert.deepEqual(rest, before);
    assert.deepEqual(received, [...new Set(before.messages.map(message => message.turn).filter(Boolean))]);
  }
});
