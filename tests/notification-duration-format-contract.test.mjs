/**
 * Every user-facing duration and size is written one way. Analysis
 * notifications used their own `(ms / 1000).toFixed(1)` and printed
 * "Loaded 2 fields (0.0s)" next to "Export complete (298ms)"; the read log,
 * the opening progress and the notification center each carried their own
 * duration format ("850ms" beside "850 ms"), and two byte formatters rounded
 * differently ("2 MB" beside "2.0 MB"). They all use `utils/format-units.js`
 * now, and no unit rounds into the next one's ceiling ("1000 ms", "60.0 s",
 * "1 min 60 s", "1024 KB").
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  formatBytes,
  formatDuration,
  formatRemaining,
} from '../assets/js/utils/format-units.js';

test('one duration format, with no unit rounding up into the next', () => {
  assert.equal(formatDuration(0), '0 ms');
  assert.equal(formatDuration(12.4), '12 ms');
  assert.equal(formatDuration(999.4), '999 ms');
  assert.equal(formatDuration(999.6), '1.0 s');
  assert.equal(formatDuration(1234), '1.2 s');
  assert.equal(formatDuration(59_940), '59.9 s');
  assert.equal(formatDuration(59_960), '1 min 0 s');
  assert.equal(formatDuration(119_600), '2 min 0 s');
  assert.equal(formatDuration(185_000), '3 min 5 s');
  assert.equal(formatDuration(2 * 3_600_000 + 4 * 60_000 + 10_000), '2 h 4 min');
  assert.equal(formatRemaining(400), '<1 s');
  assert.equal(formatRemaining(11_200), '~12 s');
  assert.equal(formatRemaining(190_000), '~3 min 10 s');
});

test('one size format, with no unit rounding up into the next', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1023.6), '1.0 KB');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(5_767_168), '5.5 MB');
  assert.equal(formatBytes(10_239), '10 KB');
  assert.equal(formatBytes(1023.6 * 1024), '1.0 MB');
  assert.equal(formatBytes(40 * 1024 * 1024), '40 MB');
  assert.throws(() => formatBytes(-1), /bytes must be/);
  assert.throws(() => formatBytes('1024'), /bytes must be/);
});

const jsRoot = fileURLToPath(new URL('../assets/js/', import.meta.url));

async function sources(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sources(full));
    else if (entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

test('no application or data message formats seconds, durations or sizes by hand', async () => {
  const offenders = [];
  const owner = path.join(jsRoot, 'utils', 'format-units.js');
  const files = [
    ...await sources(path.join(jsRoot, 'app')),
    ...await sources(path.join(jsRoot, 'data')),
    ...await sources(path.join(jsRoot, 'formats')),
  ];
  for (const file of files) {
    if (file === owner) continue;
    const text = await readFile(file, 'utf8');
    if (/\/ ?1000\)\.toFixed\(\d\)\} ?s/.test(text)) {
      offenders.push(`${path.relative(jsRoot, file)}: hand-formatted seconds`);
    }
    if (/\bfunction _?format(?:[A-Z]\w*)?(?:Duration|Bytes|Remaining)\s*\(/.test(text)) {
      offenders.push(`${path.relative(jsRoot, file)}: a private duration or size formatter`);
    }
  }
  assert.deepEqual(offenders, []);
});
