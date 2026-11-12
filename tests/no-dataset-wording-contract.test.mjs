/**
 * One wording for "no dataset is open" (R9E-8, found 2026-11-11 by sweeping
 * every panel after choosing None): "No dataset selected", "No dataset
 * loaded", "No dataset is open yet.", "Load a dataset to …", "Open a dataset
 * before …", "History starts when …" and "The history starts once the
 * dataset is open." said the same state in different panels, "Load" being
 * the session file's verb. Every place now says it through
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

/** The variants the one wording replaced. */
const VARIANTS = [
  /\bLoad a dataset\b/,
  /\bNo dataset (?:is )?(?:loaded|selected)\b/,
  /\bNo dataset is open yet\b/,
  /\bOpen a dataset (?:before|first)\b/,
  /\bHistory starts when\b/,
  /\bhistory starts once the dataset\b/i,
];

async function sources(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sources(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** The string literals of a module (comments left out). */
function literalsOf(text) {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
  return [...code.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)].map(match => match[0]);
}

test('no person-facing text says "no dataset" in another wording', async () => {
  const offenders = [];
  for (const file of [...await sources(path.join(ROOT, 'assets/js'))]) {
    for (const literal of literalsOf(await readFile(file, 'utf8'))) {
      if (VARIANTS.some(variant => variant.test(literal))) offenders.push(`${path.relative(ROOT, file)}: ${literal}`);
    }
  }
  const html = (await readFile(path.join(ROOT, 'index.html'), 'utf8')).replace(/<!--[\s\S]*?-->/g, '');
  for (const variant of VARIANTS) {
    if (variant.test(html)) offenders.push(`index.html: ${variant}`);
  }
  assert.deepEqual(offenders, []);
});

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
