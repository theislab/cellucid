/**
 * The record checks of `utils/exact-record.js` come in two kinds: a plain
 * record (`requirePlainRecord`, `requireKeys`, `requireExactKeys`), for data
 * from JSON, a session file or a worker message, whose prototype must be
 * `Object.prototype` or null; and any object (`requireObjectRecord`,
 * `requireObjectKeys`, `requireExactObjectKeys`), for an owner the app built
 * (a `DataState`, a viewer, a manager), whose prototype is its class.
 *
 * Checking an owner as a plain record refuses every real one: the category
 * builder did so with the `DataState` and the app no longer started, while
 * every node test passed with plain stub states. This contract keeps owner
 * values out of the plain checks by their names, and holds the real state
 * class to the owner checks.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DataState } from '../assets/js/app/state/core/data-state.js';
import {
  isObjectRecord,
  isPlainRecord,
  requireObjectRecord,
  requirePlainRecord,
} from '../assets/js/utils/exact-record.js';

const ROOT = fileURLToPath(new URL('../assets/js/', import.meta.url));

async function modules(directory = ROOT) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await modules(full));
    else if (entry.name.endsWith('.js')) found.push(full);
  }
  return found;
}

/**
 * Values named as owners: the state, a viewer, a renderer, a manager, a
 * controller, a layer, a source. Records of data whose names end in `State`
 * (a figure's frozen render and scientific state) are plain by contract.
 */
const OWNER = /(?:requirePlainRecord|requireKeys|requireExactKeys|requireClonedRecord|isPlainRecord)\(\s*((?:this\.)?_?[A-Za-z]*(?:[Ss]tate|[Oo]wner|[Vv]iewer|[Mm]anager|[Cc]ontroller|[Rr]enderer|[Ll]ayer|[Ss]ource))\b/g;
const DATA_RECORDS = new Set(['renderState', 'scientificState']);
/** A value named `state` that is a persisted record, by module. */
const PERSISTED_STATE = new Map([['app/analysis/ui/shared/page-selector.js', 'state']]);

test('no owner the app builds is checked as a plain record', async () => {
  const offenders = [];
  for (const file of await modules()) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(OWNER)) {
      if (DATA_RECORDS.has(match[1])) continue;
      if (PERSISTED_STATE.get(path.relative(ROOT, file).split(path.sep).join('/')) === match[1]) continue;
      const line = text.slice(0, match.index).split('\n').length;
      offenders.push(`${path.relative(ROOT, file)}:${line} ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the real state class passes the owner checks and fails the plain ones', () => {
  const state = Object.create(DataState.prototype);
  assert.equal(isObjectRecord(state), true);
  assert.equal(requireObjectRecord(state, 'state'), state);
  assert.equal(isPlainRecord(state), false);
  assert.throws(() => requirePlainRecord(state, 'state'), /state must be a plain object; got a DataState/);
});
