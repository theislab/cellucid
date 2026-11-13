/**
 * What opened a viewer is named in one place (`VIEWER_HOST_RUNTIMES`,
 * `data/viewer-protocol.js`): every runtime a host may name has its words,
 * label and language there, and every sentence the viewer channel says names
 * the host by those words (ending `cellucid mcp --open` must not freeze the
 * page with "The notebook or R session that opened this viewer stopped").
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeHostSocket, host } from './helpers/fake-host-socket.mjs';
import {
  VIEWER_HOST_RUNTIMES,
  VIEWER_HOST_UNKNOWN,
  viewerHostSentenceName,
  viewerHostWords,
  viewerProtocolDocumentFixture,
} from '../assets/js/data/viewer-protocol.js';
import {
  ViewerChannel,
  viewerChannelMessages,
  viewerStoppedMessage,
} from '../assets/js/data/viewer-channel.js';

const RUNTIMES = [...Object.keys(VIEWER_HOST_RUNTIMES), null];

test('every runtime has its words, label and language, and the protocol publishes each one', () => {
  // What opened the viewer, told apart: a notebook kernel, a Python script or
  // session, `cellucid serve`, `cellucid mcp --open`, an R session, R's
  // `cellucid_mcp(open = …)`.
  assert.deepEqual(Object.keys(VIEWER_HOST_RUNTIMES), ['jupyter', 'python', 'cellucid-serve', 'cellucid-mcp', 'r', 'r-mcp']);
  for (const [runtime, words] of Object.entries(VIEWER_HOST_RUNTIMES)) {
    assert.deepEqual(Object.keys(words).sort(), ['label', 'language', 'name', 'reopen'], runtime);
    assert.match(words.name, /^the \S/, `${runtime}: a name reads in a sentence`);
    assert.ok(words.label.length > 0, runtime);
    assert.ok(['python', 'r'].includes(words.language), runtime);
    assert.match(words.reopen, /^[A-Z].*\.$/, `${runtime}: one sentence`);
    assert.equal(viewerHostWords(runtime), words);
    assert.equal(viewerHostSentenceName(runtime), words.name[0].toUpperCase() + words.name.slice(1));
  }
  // History steps stay labeled with the host's language.
  assert.deepEqual(
    Object.fromEntries(Object.entries(VIEWER_HOST_RUNTIMES).map(([runtime, { language }]) => [runtime, language])),
    { jupyter: 'python', python: 'python', 'cellucid-serve': 'python', 'cellucid-mcp': 'python', r: 'r', 'r-mcp': 'r' },
  );
  assert.equal(viewerHostWords(null), VIEWER_HOST_UNKNOWN);
  assert.equal(VIEWER_HOST_UNKNOWN.name, 'the program serving this viewer');
  assert.throws(() => viewerHostWords('perl'), /runtime is one of/);
  assert.throws(() => viewerHostWords(undefined), /runtime is one of/);
  // The packages read which runtimes exist, and each one's label and language.
  assert.deepEqual(
    viewerProtocolDocumentFixture().runtimes,
    Object.fromEntries(Object.entries(VIEWER_HOST_RUNTIMES).map(([runtime, { label, language }]) => [runtime, { label, language }])),
  );
});

test('every sentence a viewer channel says names its host by the runtime\'s words', () => {
  for (const runtime of RUNTIMES) {
    const { name, reopen } = viewerHostWords(runtime);
    const messages = viewerChannelMessages(runtime);
    assert.deepEqual(
      Object.keys(messages).sort(),
      ['closed', 'forgotten', 'gone', 'replaced', 'stopped', 'unreachable', 'unreadable'],
    );
    for (const [kind, message] of Object.entries(messages)) {
      const text = typeof message === 'function' ? message('DETAIL') : message;
      assert.ok(text.toLowerCase().includes(name.toLowerCase()), `${runtime} ${kind}: ${text}`);
      assert.doesNotMatch(text, /notebook or R session/, `${runtime} ${kind}`);
      if (typeof message === 'function') assert.ok(text.includes('DETAIL'), `${runtime} ${kind}`);
      if (runtime !== 'jupyter' && runtime !== null) {
        assert.doesNotMatch(text.replace('(A notebook widget needs none: its channel runs over the kernel.)', ''), /notebook/i, `${runtime} ${kind}`);
      }
    }
    assert.equal(messages.stopped, viewerStoppedMessage(runtime));
    assert.ok(messages.forgotten.endsWith(reopen) && messages.gone.endsWith(reopen), `${runtime}: says how to open it again`);
  }
  assert.equal(
    viewerChannelMessages('cellucid-mcp').gone,
    'The agent app\'s cellucid mcp server, which opened this viewer, stopped (its server no longer answers). '
      + 'The last complete view stays as it is. Restart the cellucid mcp server in the agent app.',
  );
  assert.equal(viewerStoppedMessage('cellucid-serve'), 'The cellucid serve command stopped this viewer. The last complete view stays as it is.');
});

test('a channel ends with its host named as the runtime it was given', async () => {
  for (const runtime of RUNTIMES) {
    const ends = [];
    const channel = new ViewerChannel({
      serverUrl: 'http://127.0.0.1:8765',
      viewerId: host.viewerId,
      viewerToken: host.viewerToken,
      runtime,
      onCommand: () => {},
      onEnd: end => ends.push(end),
      isHostAlive: async () => false,
      WebSocketImpl: FakeHostSocket,
    });
    await channel.open();
    FakeHostSocket.instances.at(-1).hostClose(4409, 'replaced');
    assert.deepEqual(ends, [{ kind: 'replaced', message: viewerChannelMessages(runtime).replaced }]);
  }
  assert.throws(() => new ViewerChannel({
    serverUrl: 'http://127.0.0.1:8765', viewerId: 'v', viewerToken: 't', onCommand() {}, onEnd() {}, isHostAlive: async () => true,
  }), /runtime is one of/);
});
