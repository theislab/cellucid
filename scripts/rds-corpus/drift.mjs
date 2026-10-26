/**
 * The R object drift check: a corpus written by `generate.R` with the current
 * CRAN SeuratObject and Matrix and the current Bioconductor
 * SingleCellExperiment, read by the transcoders and held to what R read back
 * (`check.mjs`, the rules of `tests/rds-corpus-conformance.test.mjs`), and
 * the slots those packages define (`slots.R`) against the slots the
 * transcoders were checked against (`known-slots.json`). A new or removed
 * slot fails: add it to the slot table of `data/anndata/transcode/seurat.js`
 * or `sce.js` (read, or deliberately not read), then to `known-slots.json`.
 *
 * Usage: node scripts/rds-corpus/drift.mjs <corpus-dir> <slots.json>
 * (`drift.sh` runs the whole check; `.github/workflows/r-corpus-drift.yml`
 * runs it monthly.)
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkCorpusEntry } from './check.mjs';

const [corpusDir, slotsPath] = process.argv.slice(2);
if (!corpusDir || !slotsPath) {
  console.error('Usage: node scripts/rds-corpus/drift.mjs <corpus-dir> <slots.json>');
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const known = JSON.parse(await readFile(path.join(here, 'known-slots.json'), 'utf8'));
const current = JSON.parse(await readFile(slotsPath, 'utf8'));
const failures = [];

console.log(`Packages: ${Object.entries(current.versions).map(([name, version]) => `${name} ${version}`).join(', ')}`);
console.log(`Slots checked against: ${Object.entries(known.checkedWith).map(([name, version]) => `${name} ${version}`).join(', ')}`);
for (const name of new Set([...Object.keys(known.slots), ...Object.keys(current.slots)])) {
  const before = new Set(known.slots[name] ?? []);
  const now = new Set(current.slots[name] ?? []);
  const added = [...now].filter(slot => !before.has(slot));
  const removed = [...before].filter(slot => !now.has(slot));
  if (added.length > 0) failures.push(`${name} has new slot(s) ${added.map(slot => `@${slot}`).join(', ')}`);
  if (removed.length > 0) failures.push(`${name} no longer has slot(s) ${removed.map(slot => `@${slot}`).join(', ')}`);
}

/** Every file below `dir`, relative to it, with `/` separators. */
async function filesBelow(dir, prefix = '') {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...await filesBelow(path.join(dir, entry.name), relative));
    else if (entry.isFile()) found.push(relative);
  }
  return found;
}

const paths = (await filesBelow(corpusDir)).map(file => `rds/${file}`).sort();
const access = {
  paths,
  read: async file => new Uint8Array(await readFile(path.join(corpusDir, file.slice('rds/'.length)))),
};
const expectations = paths.filter(file => file.endsWith('.expected.json'));
let passed = 0;
for (const file of expectations) {
  const name = file.slice('rds/'.length, -'.expected.json'.length);
  const expected = JSON.parse(new TextDecoder().decode(await access.read(file)));
  const started = performance.now();
  try {
    await checkCorpusEntry(access, 'rds', name, expected);
    passed += 1;
    console.log(`ok   ${name} (${Math.round(performance.now() - started)} ms)`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

console.log(`${passed}/${expectations.length} files read as R read them.`);
if (expectations.length === 0) failures.push(`no .expected.json file in ${corpusDir}`);
if (failures.length > 0) {
  console.error(`\nR object drift: ${failures.length} problem(s):\n${failures.map(line => `- ${line}`).join('\n')}`);
  process.exit(1);
}
console.log('No drift: every slot is known, and every file reads as R read it.');
