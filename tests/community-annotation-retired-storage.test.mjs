/**
 * Keys an earlier Cellucid left in localStorage and nothing reads any more
 * are deleted when community annotation starts: the per-scope SHA indexes of
 * a Pull (`<prefix><scope>:files:shas`, Cellucid 0.9.6 and earlier), now kept
 * in IndexedDB alone. Only those keys go; the session, the published view and
 * every other key stay.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  removeRetiredFileShaIndexes,
  toCacheScopeKey,
  toPublishedViewKey,
  toSessionStorageKey,
} from '../assets/js/app/community-annotations/cache-scope.js';

/** A Storage with the Web Storage API's key()/length/getItem/setItem/removeItem. */
function memoryStorage(entries) {
  const map = new Map(entries);
  return {
    get length() { return map.size; },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    keys: () => [...map.keys()],
  };
}

const SCOPE = { datasetId: 'pancreas', repoRef: 'team/labels@main', userId: 42 };
const OTHER = { datasetId: 'suo', repoRef: 'team/labels@main', userId: 42 };

test('the retired SHA indexes are deleted, and nothing else', () => {
  const prefix = 'cellucid:community-annotations:cache:';
  const retired = [`${prefix}${toCacheScopeKey(SCOPE)}:files:shas`, `${prefix}${toCacheScopeKey(OTHER)}:files:shas`];
  const kept = [
    toSessionStorageKey(SCOPE),
    toPublishedViewKey(SCOPE),
    toSessionStorageKey(OTHER),
    'cellucid:community-annotations:lock:x',
    // Not under the cache prefix: another feature's key that happens to end the same way.
    'cellucid:something-else:files:shas',
  ];
  const storage = memoryStorage([...retired, ...kept].map((key) => [key, '{}']));
  assert.equal(removeRetiredFileShaIndexes(storage), 2);
  assert.deepEqual(storage.keys().sort(), [...kept].sort());
  assert.equal(removeRetiredFileShaIndexes(storage), 0, 'a second start finds nothing to delete');
});

test('a browser that keeps or allows no site data starts all the same', () => {
  assert.equal(removeRetiredFileShaIndexes(null), 0);
  const refusing = {
    get length() { throw new Error('SecurityError'); },
  };
  assert.equal(removeRetiredFileShaIndexes(refusing), 0);
});

test('community annotation deletes them once, as it starts', () => {
  const source = readFileSync(new URL('../assets/js/app/ui/modules/community-annotation-controls.js', import.meta.url), 'utf8');
  const start = source.slice(source.indexOf('export function initCommunityAnnotationControls('));
  assert.match(start.slice(0, 1500), /removeRetiredFileShaIndexes\(\);/);
  assert.equal(source.match(/removeRetiredFileShaIndexes\(/g).length, 1);
});
