/**
 * Choosing the wrong file for Load State is the commonest session failure, and
 * the documentation tells the reader to recognise it by one sentence,
 * `NOT_A_SESSION_FILE_MESSAGE`. A wrong file shorter than the signature must
 * say so in the same words, not as an end-of-file error about byte counts.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { NOT_A_SESSION_FILE_MESSAGE, SESSION_FORMAT_VERSION, otherSessionFormatMessage } from '../assets/js/app/session/bundle/format.js';
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
  // Saved by an earlier Cellucid (format 2: its cell-order digest was taken
  // over display coordinates, which no later version can check), or by a
  // newer one.
  for (const [version, pattern] of [[2, /earlier version of Cellucid \(session format 2\).*cannot be verified/], [1, /session format 1/], [4, /newer version of Cellucid \(session format 4\)/]]) {
    const error = await refusal(new TextEncoder().encode(`CELLUCID_SESSION/${version}\n{"manifest": "of another format"}`));
    assert.equal(error.message, otherSessionFormatMessage(version));
    assert.match(error.message, pattern);
    assert.notEqual(error.message, NOT_A_SESSION_FILE_MESSAGE);
  }
  assert.equal(SESSION_FORMAT_VERSION, 3);
  // Not a version: not a session.
  for (const text of ['CELLUCID_SESSION/x\n and more bytes', 'CELLUCID_SESSION\n and more bytes!!']) {
    assert.equal((await refusal(new TextEncoder().encode(text))).message, NOT_A_SESSION_FILE_MESSAGE, text);
  }
});
