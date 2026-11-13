/**
 * A history that could not be loaded is said in one sentence, its ids under Details.
 *
 * After a reload, Continue must not fail as "Loading failed. Saved state:
 * tracker 4f3c…: a group cuts the run of turn … between steps "s5" and "s6"; a
 * group holds whole runs of a turn" — the model's own check, with the tracker's
 * uuid, as the sentence. The person reads what happened and that the history
 * shown is as it was (`describeLoadFailure`), the check's words folded under
 * Details; a damaged session file says it is damaged; a refusal written for the
 * person (another dataset, a missing field) is said as it is.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { describeLoadFailure } from '../assets/js/app/session/session-serializer.js';
import { HistoryModelError } from '../assets/js/app/history/model.js';
import { assertPageChrome } from '../assets/js/app/session/history-file.js';
import { DAMAGED_FILE, failureDetails, isDamagedFile, isInternalFailure, sayFailure } from '../assets/js/utils/errors.js';
import { readBundle } from '../assets/js/app/session/bundle/reader.js';
import { writeBundle } from '../assets/js/app/session/bundle/writer.js';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-/;

test('a saved state that does not hold together is said so, never with the ids its check names', () => {
  const check = new HistoryModelError('tracker t-4f3c2a10-1111-4111-8111-111111111111: a group cuts the run of turn "u1" between steps "s5" and "s6"; a group holds whole runs of a turn');
  const said = describeLoadFailure(check);
  assert.equal(said.message, 'it does not hold together as a history, so it was not opened; the history shown is unchanged.');
  assert.doesNotMatch(said.message, UUID);
  assert.match(said.details, /a group cuts the run/);
  // Raised under another failure (a read that wraps it), it is still the history's.
  assert.equal(describeLoadFailure(new Error('reading the saved state failed', { cause: check })).message, said.message);
});

test('a damaged session file says the file is damaged; what is wrong goes under Details', () => {
  let damaged = null;
  try {
    assertPageChrome({ tool: 7 });
  } catch (error) {
    damaged = error;
  }
  assert.ok(damaged !== null && isDamagedFile(damaged));
  const said = describeLoadFailure(damaged);
  assert.equal(said.message, 'the file is damaged, so it was not opened; the history shown is unchanged.');
  assert.match(said.details, /^This session file is damaged: /);
  assert.equal(isDamagedFile(new TypeError('This session file is damaged: forged')), false);
});

test('a session file whose framing breaks (truncated, trailing bytes, a manifest out of the format) is damaged, never raw "Invalid …"', async () => {
  const written = await new Response(writeBundle({ manifest: { chunks: [{ id: 'c', storedBytes: 3 }] }, chunks: [new Uint8Array([1, 2, 3])] })).arrayBuffer();
  const bytes = new Uint8Array(written);
  const read = async blob => {
    const bundle = await readBundle(blob, { signal: null, onProgress: null });
    for await (const chunk of bundle.chunkStream) void chunk;
  };
  const failures = [];
  for (const blob of [new Blob([bytes.slice(0, bytes.length - 1)]), new Blob([bytes, new Uint8Array([9])])]) {
    failures.push(await read(blob).then(() => null, error => error));
  }
  const manifestBytes = new TextEncoder().encode('{"chunks":7}');
  const header = bytes.slice(0, bytes.indexOf(0x7b) - 4);
  const length = new Uint8Array(new Uint32Array([manifestBytes.byteLength]).buffer);
  failures.push(await read(new Blob([header, length, manifestBytes])).then(() => null, error => error));
  for (const error of failures) {
    assert.ok(error !== null && isDamagedFile(error), String(error));
    assert.equal(sayFailure(error), DAMAGED_FILE);
    assert.equal(describeLoadFailure(error).message, 'the file is damaged, so it was not opened; the history shown is unchanged.');
    assert.match(failureDetails(error).details, /Invalid|end of file|trailing/i);
  }
});

test('a refusal written for the person is said as it is; a broken invariant as one', () => {
  const refusal = new RangeError('This session was saved on Pancreas, not on Suo. Open Pancreas, then load the session again.');
  assert.deepEqual(describeLoadFailure(refusal), { message: refusal.message, details: '' });
  const bug = new TypeError('values.get is not a function');
  assert.deepEqual(describeLoadFailure(bug), { message: 'a problem inside Cellucid stopped it.', details: 'values.get is not a function' });
});

test('the history model\'s check is a broken invariant wherever it is said', () => {
  const check = new HistoryModelError('tracker t-1 holds the group "g1" twice');
  assert.equal(isInternalFailure(check), true);
  // Across a thread only its name is left.
  assert.equal(isInternalFailure({ name: 'HistoryModelError', message: check.message }), true);
  assert.equal(sayFailure(check), 'a problem inside Cellucid stopped it.');
  assert.deepEqual(failureDetails(check), { details: check.message });
  assert.deepEqual(failureDetails(new RangeError('No cells are highlighted.')), {});
});
