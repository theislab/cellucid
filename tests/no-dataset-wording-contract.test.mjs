/**
 * One wording for "no dataset is open": "No dataset selected", "No dataset
 * loaded", "No dataset is open yet.", "Load a dataset to …", "Open a dataset
 * before …", "History starts when …" and "The history starts once the
 * dataset is open." must not say the same state in different panels, "Load"
 * being the session file's verb. Every place says it through
 * `app/ui/no-dataset.js`.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  HISTORY_WAITS_FOR_DATASET,
  NO_DATASET_LABEL,
  NO_DATASET_OPEN,
  noDatasetOpenTo,
  openADatasetTo,
} from '../assets/js/app/ui/no-dataset.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function sources(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sources(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('the page starts with the same words the modules say', async () => {
  const html = await readFile(path.join(ROOT, 'index.html'), 'utf8');
  for (const id of ['dataset-name', 'phone-sheet-name']) {
    const match = new RegExp(`id="${id}"[^>]*>([^<]*)<`).exec(html);
    assert.equal(match?.[1], NO_DATASET_LABEL, id);
  }
  assert.equal(/id="history-status"[^>]*>([^<]*)</.exec(html)?.[1], HISTORY_WAITS_FOR_DATASET);
});

test('the wording: one fact, one verb, one place', () => {
  assert.equal(NO_DATASET_OPEN, 'No dataset is open.');
  assert.equal(openADatasetTo('keep views'), 'Open a dataset to keep views.');
  assert.equal(noDatasetOpenTo('analyze it'), 'No dataset is open. Open one in Session › Open data to analyze it.');
});
