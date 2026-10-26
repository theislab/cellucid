/**
 * No code that runs in a browser releases a stream reader's lock.
 *
 * WebKit's `ReadableStreamDefaultReader::releaseLock` (314030@main) runs the
 * release's JavaScript while it holds the lock its garbage collector takes
 * when it visits the reader. A collection that starts inside the release
 * waits for that lock forever; it has already suspended the JIT worklist,
 * so every later collection in the tab, the page's own included, waits
 * behind it. A dataset whose structure inflates a compressed chunk on the
 * reader thread (`formats/io/inflate.js`) hung on opening that way, and its
 * page then hung its teardown.
 *
 * A reader that has been read to its end or cancelled holds nothing anyone
 * else needs: it is dropped. The community-annotation Cloudflare Worker
 * (`_worker-code.js`) runs on workerd, never in a browser.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BROWSER_CODE = path.join(ROOT, 'assets', 'js');
const NOT_IN_A_BROWSER = new Set([
  path.join('app', 'community-annotations', '_worker-code.js'),
]);
const RELEASE_CALL = /\.releaseLock\s*(?:\?\.)?\s*\(/;

async function* scripts(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* scripts(full);
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) yield full;
  }
}

test('browser code never calls releaseLock() on a stream reader', async () => {
  const offenders = [];
  let scanned = 0;
  for await (const file of scripts(BROWSER_CODE)) {
    const relative = path.relative(BROWSER_CODE, file);
    if (NOT_IN_A_BROWSER.has(relative)) continue;
    scanned += 1;
    const lines = (await readFile(file, 'utf8')).split('\n');
    lines.forEach((line, index) => {
      const code = line.replace(/\/\/.*$/, '').trim();
      if (code.startsWith('*') || code.startsWith('/*')) return;
      if (RELEASE_CALL.test(code)) offenders.push(`${relative}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.ok(scanned > 100, `the sweep reads the browser code (${scanned} files)`);
  assert.deepEqual(offenders, []);
});

test('the sweep recognises a release in any spelling', () => {
  for (const line of ['reader.releaseLock();', 'reader.releaseLock?.();', 'this._reader .releaseLock ()']) {
    assert.match(line, RELEASE_CALL);
  }
  // A Web Locks release (`navigator.locks`) is not a stream reader's.
  assert.doesNotMatch('releaseLock();', RELEASE_CALL);
});
