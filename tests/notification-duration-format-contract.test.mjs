/**
 * Every user-facing duration is written one way. Analysis notifications used
 * their own `(ms / 1000).toFixed(1)` and printed "Loaded 2 fields (0.0s)" next
 * to "Export complete (298ms)"; two analysis helpers carried private copies of
 * a third format. They all use `formatDuration` now, and it no longer rounds
 * into the next unit's ceiling ("1000ms", "60.0s", "1m 60s").
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  formatDuration,
} from '../assets/js/app/notification-center/formatters.js';

test('one duration format, with no unit rounding up into the next', () => {
  assert.equal(formatDuration(0), '0ms');
  assert.equal(formatDuration(12.4), '12ms');
  assert.equal(formatDuration(999.4), '999ms');
  assert.equal(formatDuration(999.6), '1.0s');
  assert.equal(formatDuration(1234), '1.2s');
  assert.equal(formatDuration(59_940), '59.9s');
  assert.equal(formatDuration(59_960), '1m 0s');
  assert.equal(formatDuration(119_600), '2m 0s');
  assert.equal(formatDuration(185_000), '3m 5s');
  assert.equal(formatDuration(2 * 3_600_000 + 4 * 60_000 + 10_000), '2h 4m');
});

const appRoot = fileURLToPath(new URL('../assets/js/app/', import.meta.url));

async function sources(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sources(full));
    else if (entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

test('no application message formats seconds or durations by hand', async () => {
  const offenders = [];
  const owner = path.join(appRoot, 'notification-center', 'formatters.js');
  for (const file of await sources(appRoot)) {
    if (file === owner) continue;
    const text = await readFile(file, 'utf8');
    if (/\/ ?1000\)\.toFixed\(\d\)\}s/.test(text)) {
      offenders.push(`${path.relative(appRoot, file)}: hand-formatted seconds`);
    }
    if (/\b_formatDuration\s*\(/.test(text)) {
      offenders.push(`${path.relative(appRoot, file)}: private _formatDuration`);
    }
  }
  assert.deepEqual(offenders, []);
});
