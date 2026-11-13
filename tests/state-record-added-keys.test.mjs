/**
 * A state domain's record saved before a key was added still reads:
 * `app/state/domains/record-keys.js`, and every
 * domain's records declared once (`records.js`). Every sample's published
 * starting view (`cellucid-datasets/anndata/*.cellucid-session`, written
 * before camera path captions existed) restores its camera path through the
 * Camera Path module without a refusal, and a path that never turned
 * captions off saves byte for byte as before; every domain reads every
 * starting view and the history goldens through its declared records.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { listOf, nullable, readRecordKeys, readRecordShape, record, writeRecordKeys, writeRecordShape } from '../assets/js/app/state/domains/record-keys.js';
import { RECORDS } from '../assets/js/app/state/domains/records.js';
import { readingRecords } from '../assets/js/app/state/domains/index.js';
import { DOMAIN_IDS } from '../assets/js/app/actions/domains.js';
import { openHistoryFile } from '../assets/js/app/session/history-file.js';
import { absentSibling, siblingRoot, skipAbsentSibling } from '../scripts/shared-files.mjs';
import { destroyMounted, installModuleEnvironment, mountCinematicCamera } from './helpers/cinematic-camera-harness.mjs';

const KEYS = Object.freeze({ required: Object.freeze(['a', 'b']), added: Object.freeze({ c: true, d: Object.freeze([]) }) });

test('a record of before an added key reads with its default; a truly wrong record is refused', () => {
  assert.deepEqual(readRecordKeys({ a: 1, b: 2 }, KEYS, 'R'), { a: 1, b: 2, c: true, d: [] });
  assert.deepEqual(readRecordKeys({ a: 1, b: 2, c: false }, KEYS, 'R'), { a: 1, b: 2, c: false, d: [] });
  assert.throws(() => readRecordKeys({ a: 1 }, KEYS, 'R'), /R must contain exactly .*missing b/);
  assert.throws(() => readRecordKeys({ a: 1, b: 2, e: 0 }, KEYS, 'R'), /unknown e/);
  assert.throws(() => readRecordKeys(null, KEYS, 'R'), /must be an object/);
  // Written at its default, an added key is left out: the record of before, byte for byte.
  assert.deepEqual(writeRecordKeys({ a: 1, b: 2, c: true, d: [] }, KEYS), { a: 1, b: 2 });
  assert.deepEqual(writeRecordKeys({ a: 1, b: 2, c: false, d: [] }, KEYS), { a: 1, b: 2, c: false });
});

/** The cellucid-datasets checkout (`CELLUCID_DATASETS_ROOT`, else beside this one), or null. */
const DATASETS_ROOT = siblingRoot('cellucid-datasets');
const DATASETS = DATASETS_ROOT === null ? null : pathToFileURL(`${path.resolve(DATASETS_ROOT)}${path.sep}`);

test('every sample\'s published starting view restores its camera path, written before captions existed', async t => {
  if (skipAbsentSibling(t, DATASETS !== null, 'cellucid-datasets is not checked out beside this repository')) return;
  const files = (await readdir(new URL('anndata/', DATASETS))).filter(name => name.endsWith('.cellucid-session'));
  assert.ok(files.length >= 5, 'the five samples publish starting views');
  const { readStartingView } = await import(new URL('scripts/publish_session_preset.mjs', DATASETS).href);
  const { readFile } = await import('node:fs/promises');
  const environment = installModuleEnvironment();
  try {
    for (const name of files) {
      const { values } = await readStartingView(new Uint8Array(await readFile(new URL(`anndata/${name}`, DATASETS))));
      const module = mountCinematicCamera();
      assert.doesNotThrow(() => module.camera.restorePath(values['camera-path']), `${name}'s camera path`);
      assert.equal(module.dom.captionsCheckbox.checked, true, `${name}: a path saved before captions plays with them`);
      assert.deepEqual(module.camera.exportPath(), values['camera-path'], `${name}: saved again, the same record`);
      destroyMounted();
    }
  } finally {
    destroyMounted();
    environment.restore();
  }
});

test('a record shape reads a value of before: added keys filled, the rest given back as it is; a wrong record refused where it is wrong', () => {
  const shape = record({
    required: ['views'],
    fields: { views: listOf(nullable(record({ required: ['a'], optional: ['b'], added: { c: false }, fields: { b: record({ required: ['x'] }) } }))) },
  });
  const same = { views: [null, { a: 1, c: true }] };
  assert.equal(readRecordShape(same, shape, 'V'), same, 'nothing to fill: the value itself');
  assert.deepEqual(readRecordShape({ views: [{ a: 1, b: { x: 2 } }] }, shape, 'V'), { views: [{ a: 1, b: { x: 2 }, c: false }] });
  assert.throws(() => readRecordShape({ views: [null, { a: 1, b: { y: 2 } }] }, shape, 'The views to restore'),
    /The views to restore › views \[2\] › b must contain exactly x; missing x; unknown y\./);
  assert.throws(() => readRecordShape({ views: [{ a: 1, d: 0 }] }, shape, 'V'), /V › views \[1\] must contain exactly a, b \(optional\), c \(optional\); unknown d\./);
  assert.throws(() => readRecordShape({ views: {} }, shape, 'V'), /V › views must be a list\./);
  // Written as before: an added key at its default left out; a shape with none writes nothing.
  assert.deepEqual(writeRecordShape({ views: [{ a: 1, c: false }, { a: 2, c: true }] }, shape), { views: [{ a: 1 }, { a: 2, c: true }] });
  const plain = record({ required: ['a'] });
  const value = { a: 1 };
  assert.equal(writeRecordShape(value, plain), value);
});

/** Every value of every step of every tracker of a session file, by domain. */
async function valuesOfFile(bytes) {
  const file = await openHistoryFile(new Blob([bytes]), { signal: null, onProgress: null });
  const eager = await file.readEager();
  const rest = await file.readRest();
  const pool = new Map([...eager.values, ...(rest.values ?? new Map())]);
  const values = [];
  for (const tracker of eager.history.trackers) {
    for (const step of tracker.steps) {
      for (const side of [step.before ?? {}, step.after ?? {}]) {
        for (const [domain, hash] of Object.entries(side)) {
          assert.ok(pool.has(hash), `${tracker.name} ${step.id} ${domain}: its value is in the file`);
          values.push({ domain, value: pool.get(hash), where: `${tracker.name} ${step.id}` });
        }
      }
    }
  }
  return values;
}

test('every domain reads the history goldens and every published starting view through its records', async t => {
  const { readFile, readdir } = await import('node:fs/promises');
  const files = [];
  // The format pins Python and R read (`scripts/generate-history-golden.mjs`) hold records the app reads too.
  for (const name of ['history-golden.cellucid-session', 'history-golden-state.cellucid-session']) {
    files.push({ name, bytes: await readFile(new URL(`fixtures/${name}`, import.meta.url)) });
  }
  let samples = [];
  if (absentSibling(DATASETS !== null, 'cellucid-datasets is not checked out beside this repository')) {
    t.diagnostic('cellucid-datasets is not checked out beside this repository: its starting views are not read');
  } else {
    samples = (await readdir(new URL('anndata/', DATASETS))).filter(name => name.endsWith('.cellucid-session'));
  }
  for (const name of samples) files.push({ name, bytes: await readFile(new URL(`anndata/${name}`, DATASETS)) });
  const read = new Set();
  for (const { name, bytes } of files) {
    for (const { domain, value, where } of await valuesOfFile(bytes)) {
      assert.ok(DOMAIN_IDS.includes(domain), `${name}: ${domain} is a domain`);
      if (RECORDS[domain] === undefined) continue;
      assert.doesNotThrow(() => readRecordShape(value, RECORDS[domain], `${name} ${where} ${domain}`), `${name} ${where} ${domain}`);
      read.add(domain);
    }
  }
  // Every declared domain was read from a file.
  assert.deepEqual([...read].sort(), Object.keys(RECORDS).sort());
});

test('the domains\' owners read through their records: a value of before restores and describes as today\'s', async () => {
  const restored = [];
  const owner = { capture: () => ({ windows: [], docked: null }), restore: value => restored.push(value), describe: (a, b) => [JSON.stringify(a), JSON.stringify(b)] };
  const reading = readingRecords(owner, RECORDS.analysis, 'analysis');
  await reading.restore({ windows: [], docked: null });
  assert.deepEqual(restored, [{ windows: [], docked: null }]);
  assert.deepEqual(reading.describe({ windows: [], docked: null }, { windows: [], docked: null }), ['{"windows":[],"docked":null}', '{"windows":[],"docked":null}']);
  assert.throws(() => reading.restore({ windows: [], sizes: null, docked: null }), /unknown sizes/);
  assert.throws(() => reading.restore({ windows: [], docked: null, extra: 1 }), /The analysis to restore must contain exactly docked, windows; unknown extra\./);
  assert.deepEqual(reading.capture(), { windows: [], docked: null });
});
