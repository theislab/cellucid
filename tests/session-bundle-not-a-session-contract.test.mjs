/**
 * Choosing the wrong file for Load State is the commonest session failure, and
 * the documentation tells the reader to recognise it by one sentence:
 * "Invalid session file (bad MAGIC header)." A wrong file shorter than the
 * 17-byte signature never reached that check; it failed reading the signature
 * itself and surfaced as "Unexpected end of file (need 17 bytes, only 13
 * remaining)." — a byte count instead of "this is not a session file".
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { readBundle } from '../assets/js/app/session/bundle/reader.js';

const NOT_A_SESSION = /^Invalid session file \(bad MAGIC header\)\.$/;

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
    assert.match(error.message, NOT_A_SESSION, JSON.stringify(text));
  }
});

test('a long file with the wrong signature is refused in the same words', async () => {
  const error = await refusal(
    new TextEncoder().encode('PNG image bytes that are long enough to read'),
  );
  assert.match(error.message, NOT_A_SESSION);
});
