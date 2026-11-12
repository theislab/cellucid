/**
 * The history model document Python and R build their reading model from.
 *
 * `tests/fixtures/history-model.schema.json` is `historyModelDocument()`
 * (`assets/js/app/history/model.js`) as canonical JSON
 * (`scripts/generate-history-model.mjs`), and cellucid-python
 * (`src/cellucid/history_model.schema.json`) and cellucid-r
 * (`inst/history_model.schema.json`) hold it byte for byte, each pinning the
 * same SHA-256. A record or a field changed without regenerating fails here,
 * naming the command; the copies are compared too when the sibling checkouts
 * are present.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  HISTORY_MODEL_PATH,
  historyModelMirrorPaths,
  renderHistoryModel,
} from '../scripts/generate-history-model.mjs';
import { historyModelDocument } from '../assets/js/app/history/model.js';

/**
 * The digest of `history-model.schema.json`. cellucid-python and cellucid-r
 * pin the same one in their session reader tests.
 */
const HISTORY_MODEL_SHA256 = '0896116c1e791e370b7247d61e734bc22f96047f5d1ed49a39738cf4f8a5333c';

const REGENERATE = 'Run node scripts/generate-history-model.mjs (it writes the three copies and prints the digest), '
  + 'update both packages\' reading models to the records it describes, and pin the printed digest in the three tests.';

test('history-model.schema.json is the model the code makes now, at the pinned digest', () => {
  const current = readFileSync(HISTORY_MODEL_PATH, 'utf8');
  assert.ok(current === renderHistoryModel(), `tests/fixtures/history-model.schema.json is stale. ${REGENERATE}`);
  assert.equal(createHash('sha256').update(current).digest('hex'), HISTORY_MODEL_SHA256, REGENERATE);
});

test('the copies Python and R read are the same bytes', t => {
  const expected = readFileSync(HISTORY_MODEL_PATH, 'utf8');
  for (const mirror of historyModelMirrorPaths()) {
    if (mirror.path === null) {
      t.diagnostic(`${mirror.repository} is not beside this checkout (set ${mirror.env}); its copy is checked there`);
      continue;
    }
    assert.ok(readFileSync(mirror.path, 'utf8') === expected, `${mirror.repository}/${mirror.file} differs. ${REGENERATE}`);
  }
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
