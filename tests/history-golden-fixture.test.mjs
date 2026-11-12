/**
 * The golden history the web app, cellucid-python and cellucid-r all read.
 *
 * `scripts/generate-history-golden.mjs` writes one session file of format 4
 * in the History v2 shape (every record `app/history/model.js`'s, validated
 * whole by `validateSession` as it is made) and what reading and applying it
 * must give (`history-golden.expected.json`: the reading, the values at three
 * steps, diffs, the methods paragraph and pseudocode, and the shared apply
 * plans). The three repositories hold the same bytes and pin the same
 * digests (cellucid-python `tests/test_sessions.py`, cellucid-r
 * `tests/testthat/test-sessions.R`). Here the files are pinned, made again by
 * the generator (the same content every run, gzip's bytes aside), and compared with the
 * packages' copies beside this checkout (or `CELLUCID_PYTHON_ROOT`,
 * `CELLUCID_R_ROOT`).
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import {
  HISTORY_GOLDEN_EXPECTED_PATH,
  HISTORY_GOLDEN_SESSION_PATH,
  HISTORY_GOLDEN_STATE_PATH,
  buildHistoryGolden,
  buildHistoryGoldenState,
  historyGoldenContent,
  historyGoldenExpectedOf,
  historyGoldenTargets,
} from '../scripts/generate-history-golden.mjs';

/** Pinned the same in cellucid-python and cellucid-r. */
const SHA256 = Object.freeze({
  session: '9711bbc4dfd19fd91809a2ab3967cab54b6982c2a3907c73432200e72414ca4a',
  expected: '8684353157ec936017b777c395e1d60342dcd4f393ef2a0648fe4a7891a67c34',
  state: 'f9f0a6025679dacb91cbd00b0abd1cd6380ab1e829fa9ea529cbc59c1801e3dd',
});

const REGENERATE = 'Run node scripts/generate-history-golden.mjs (it writes the three copies) and pin the printed digests '
  + 'in the three repositories.';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

test('the golden files are the pinned ones', () => {
  const session = readFileSync(HISTORY_GOLDEN_SESSION_PATH);
  const expected = readFileSync(HISTORY_GOLDEN_EXPECTED_PATH);
  assert.equal(digest(session), SHA256.session, `history-golden.cellucid-session. ${REGENERATE}`);
  assert.equal(digest(expected), SHA256.expected, `history-golden.expected.json. ${REGENERATE}`);
  assert.equal(digest(readFileSync(HISTORY_GOLDEN_STATE_PATH)), SHA256.state, `history-golden-state.cellucid-session. ${REGENERATE}`);
  const reading = JSON.parse(expected.toString('utf8'));
  assert.equal(reading.sha256, SHA256.session);
  assert.equal(reading.apply.provenance.session_sha256, SHA256.session);
});

test('the generator makes the same files again', async () => {
  const { file, expectedText } = await buildHistoryGolden();
  assert.equal(historyGoldenContent(file.bytes), historyGoldenContent(new Uint8Array(readFileSync(HISTORY_GOLDEN_SESSION_PATH))),
    `The golden session no longer matches what the history model makes. ${REGENERATE}`);
  assert.equal(historyGoldenExpectedOf(expectedText, readFileSync(HISTORY_GOLDEN_SESSION_PATH)), readFileSync(HISTORY_GOLDEN_EXPECTED_PATH, 'utf8'),
    `The golden reading no longer matches. ${REGENERATE}`);
  assert.equal(historyGoldenContent(await buildHistoryGoldenState()), historyGoldenContent(new Uint8Array(readFileSync(HISTORY_GOLDEN_STATE_PATH))),
    `The golden's current state only no longer matches what Share writes. ${REGENERATE}`);
});

for (const target of historyGoldenTargets().slice(1)) {
  const absent = target.session === null || !existsSync(target.session);
  test(`${target.repository} holds the same golden files`, { skip: absent ? `no ${target.repository} golden files beside this checkout (set ${target.env})` : false }, () => {
    assert.equal(digest(readFileSync(target.session)), SHA256.session, `${target.session}. ${REGENERATE}`);
    assert.equal(digest(readFileSync(target.expected)), SHA256.expected, `${target.expected}. ${REGENERATE}`);
    assert.equal(digest(readFileSync(target.state)), SHA256.state, `${target.state}. ${REGENERATE}`);
    // The copy a package ships as its help pages' example (cellucid-r's inst/extdata): the same session.
    if (target.example !== null) assert.equal(digest(readFileSync(target.example)), SHA256.session, `${target.example}. ${REGENERATE}`);
  });
}
