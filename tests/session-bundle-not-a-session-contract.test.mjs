/**
 * Choosing the wrong file for Load State is the commonest session failure, and
 * the documentation tells the reader to recognize it by one sentence,
 * `NOT_A_SESSION_FILE_MESSAGE`. A wrong file shorter than the signature must
 * say so in the same words, not as an end-of-file error about byte counts.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { NOT_A_SESSION_FILE_MESSAGE, otherSessionFormatMessage } from '../assets/js/app/session/bundle/format.js';
import { readBundle } from '../assets/js/app/session/bundle/reader.js';

async function refusal(bytes) {
  try {
    await readBundle(new Blob([bytes]), { signal: null, onProgress: null });
  } catch (error) {
    return error;
  }
  throw new Error('readBundle accepted a file that is not a session.');
}

test('a file too short for the session signature is refused as not a session', async () => {
  for (const text of ['', 'not a session', 'CELLUCID']) {
    const error = await refusal(new TextEncoder().encode(text));
    assert.equal(error.message, NOT_A_SESSION_FILE_MESSAGE, JSON.stringify(text));
  }
});

test('a long file with the wrong signature is refused in the same words', async () => {
  const error = await refusal(
    new TextEncoder().encode('PNG image bytes that are long enough to read'),
  );
  assert.equal(error.message, NOT_A_SESSION_FILE_MESSAGE);
});

test('a session of another format version is refused naming it, not as some other file', async () => {
  // Saved by an earlier Cellucid (format 3 held one state, not the history of
  // its steps; formats 1 and 2 before it), or by a newer one.
  for (const [version, pattern] of [
    [3, /earlier version of Cellucid \(session format 3\), which this version no longer reads: a session file now holds the history of every step \(session format 4\)\. It was not opened\./],
    [2, /session format 2/],
    [1, /session format 1/],
    [5, /newer version of Cellucid \(session format 5\)/],
  ]) {
    const error = await refusal(new TextEncoder().encode(`CELLUCID_SESSION/${version}\n{"manifest": "of another format"}`));
    assert.equal(error.message, otherSessionFormatMessage(version));
    assert.match(error.message, pattern);
    assert.notEqual(error.message, NOT_A_SESSION_FILE_MESSAGE);
  }
  // Not a version: not a session.
  for (const text of ['CELLUCID_SESSION/x\n and more bytes', 'CELLUCID_SESSION\n and more bytes!!']) {
    assert.equal((await refusal(new TextEncoder().encode(text))).message, NOT_A_SESSION_FILE_MESSAGE, text);
  }
});
