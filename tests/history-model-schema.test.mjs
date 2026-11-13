/**
 * The history model document Python and R build their reading model from.
 *
 * `tests/fixtures/history-model.schema.json` is `historyModelDocument()`
 * (`assets/js/app/history/model.js`) as canonical JSON
 * (`scripts/generate-history-model.mjs`), and cellucid-python
 * (`src/cellucid/history_model.schema.json`) and cellucid-r
 * (`inst/history_model.schema.json`) hold it byte for byte
 * (`tests/shared-files-contract.test.mjs` compares the copies). A record or
 * a field changed without regenerating fails here, naming the command.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  HISTORY_MODEL_PATH,
  renderHistoryModel,
} from '../scripts/generate-history-model.mjs';
import { historyModelDocument } from '../assets/js/app/history/model.js';

const REGENERATE = 'Run node scripts/generate-history-model.mjs (it writes the three copies) '
  + 'and update both packages\' reading models to the records it describes.';

test('history-model.schema.json is the model the code makes now', () => {
  const current = readFileSync(HISTORY_MODEL_PATH, 'utf8');
  assert.ok(current === renderHistoryModel(), `tests/fixtures/history-model.schema.json is stale. ${REGENERATE}`);
});

test('the document is canonical: sorted keys, two-space indent, one trailing newline', () => {
  const text = readFileSync(HISTORY_MODEL_PATH, 'utf8');
  const sorted = value => {
    if (Array.isArray(value)) return value.map(sorted);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
    }
    return value;
  };
  const parsed = JSON.parse(text);
  assert.equal(text, `${JSON.stringify(sorted(parsed), null, 2)}\n`);
  assert.deepEqual(parsed, sorted(historyModelDocument()));
});
