/**
 * The golden history the web app, cellucid-python and cellucid-r all read.
 *
 * `scripts/generate-history-golden.mjs` writes one session file of format 4
 * in the history model's shape (every record `app/history/model.js`'s, validated
 * whole by `validateSession` as it is made) and what reading and applying it
 * must give (`history-golden.expected.json`: the reading, the values at three
 * steps, diffs, the methods paragraph and pseudocode, and the shared apply
 * plans). The three repositories hold the same bytes
 * (`tests/shared-files-contract.test.mjs` compares the packages' copies with
 * these). Here the reading is held to the session file it goes with, and the
 * files are made again by the generator (the same content every run, gzip's
 * bytes aside).
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  HISTORY_GOLDEN_EXPECTED_PATH,
  HISTORY_GOLDEN_SESSION_PATH,
  HISTORY_GOLDEN_STATE_PATH,
  buildHistoryGolden,
  buildHistoryGoldenState,
  historyGoldenContent,
  historyGoldenExpectedOf,
} from '../scripts/generate-history-golden.mjs';

const REGENERATE = 'Run node scripts/generate-history-golden.mjs (it writes the three copies).';

test('the golden reading names the session file it goes with', () => {
  const session = createHash('sha256').update(readFileSync(HISTORY_GOLDEN_SESSION_PATH)).digest('hex');
  const reading = JSON.parse(readFileSync(HISTORY_GOLDEN_EXPECTED_PATH, 'utf8'));
  assert.equal(reading.sha256, session, `history-golden.expected.json. ${REGENERATE}`);
  assert.equal(reading.apply.provenance.session_sha256, session, `history-golden.expected.json. ${REGENERATE}`);
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
