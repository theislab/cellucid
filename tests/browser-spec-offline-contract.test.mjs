/**
 * Browser specs take a context offline only through `goOffline`
 * (`tests/browser/helpers/offline.mjs`).
 *
 * A page that is still loading something of its own when the connection
 * goes reports that failure too: the analysis tools it imports as it
 * starts, a read of the opening still under way. Where a machine is fast
 * those are long over; on a slow runner they are not. The helper waits for
 * both on every page of the context, so the wait cannot be left out of a
 * spec.
 */

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const BROWSER_TESTS = fileURLToPath(new URL('./browser/', import.meta.url));
const HELPER = path.join('helpers', 'offline.mjs');

async function sources(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await sources(file));
    else if (entry.name.endsWith('.mjs')) found.push(file);
  }
  return found;
}

test('only the offline helper takes a browser context offline', async () => {
  const offenders = [];
  let helperSets = 0;
  for (const file of await sources(BROWSER_TESTS)) {
    const relative = path.relative(BROWSER_TESTS, file);
    const lines = (await readFile(file, 'utf8')).split('\n');
    lines.forEach((line, index) => {
      // `setOffline(false)` brings the connection back: nothing waits on that.
      if (!/\.setOffline\(\s*(?!false\s*\))/.test(line)) return;
      if (relative === HELPER) helperSets += 1;
      else offenders.push(`${relative}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.equal(helperSets, 1, 'the helper takes the context offline in one place');
  assert.deepEqual(offenders, [], 'use goOffline(context) from tests/browser/helpers/offline.mjs');
});
