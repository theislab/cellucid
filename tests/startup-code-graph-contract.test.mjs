/**
 * Startup never stops silently before the application runs.
 *
 * Every startup failure surface lives inside the module graph rooted at
 * `main.js`; before it runs, only the code-load watch
 * (`assets/js/app/ui/core/code-load-watch.js`) can say anything. The watch
 * reports a module that fails to download (`error` on its script element) and
 * one that fails to parse, link or run (an uncaught error while
 * `data-code-started` is missing at DOMContentLoaded). Both rest on what this
 * file pins:
 *
 * - No module of the application awaits at its top level. A module script runs
 *   before DOMContentLoaded only because nothing in its graph does: a top-level
 *   `await` that never settles (a storage, lock or file-system promise a
 *   browser leaves pending) holds every module that imports it, `main.js`
 *   included, with no error for the watch to see, and the page says "Starting
 *   Cellucid" forever. A lazily imported module would hang its feature the
 *   same way. Asynchronous starts belong in functions whose caller owns their
 *   failure and deadline (`app/startup-phase.js`).
 * - The watch is a classic script, loaded before the module graph, on every
 *   page that runs it.
 * - `main.js` marks `data-code-started` before anything else it runs.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { transformSync } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function scripts(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...scripts(location));
    else if (/\.m?js$/.test(entry.name)) found.push(location);
  }
  return found;
}

/** The top-level await esbuild finds in `source` (it cannot write one as CommonJS), or null. */
function topLevelAwait(source, file) {
  try {
    transformSync(source, { format: 'cjs', loader: 'js', logLevel: 'silent', sourcefile: file });
    return null;
  } catch (error) {
    const found = (error.errors ?? []).find(item => /top-level await/i.test(item.text));
    if (found === undefined) throw error;
    return `${path.relative(ROOT, file)}:${found.location?.line ?? '?'}`;
  }
}

test('the detector finds every form of top-level await and nothing else', () => {
  for (const source of [
    'await 1;',
    'for await (const item of items) {}',
    'if (ready) { await settle(); }',
    'export const root = await navigator.storage.getDirectory();',
  ]) {
    assert.notEqual(topLevelAwait(source, 'probe.js'), null, source);
  }
  for (const source of [
    'async function open() { await 1; }',
    'export const start = async () => { for await (const item of items) {} };',
    'export const url = import.meta.url;',
  ]) {
    assert.equal(topLevelAwait(source, 'probe.js'), null, source);
  }
});

test('no module of the application awaits at its top level', () => {
  const files = scripts(path.join(ROOT, 'assets', 'js'));
  assert.ok(files.length > 100, 'the application sources are found');
  const found = files
    .map(file => topLevelAwait(readFileSync(file, 'utf8'), file))
    .filter(location => location !== null);
  assert.deepEqual(found, [], 'a top-level await can hold the module graph without an error');
});

test('the code-load watch runs before the module graph it watches', () => {
  const page = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const tags = [...page.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)];
  const watch = tags.findIndex(([, src]) => src.startsWith('assets/js/app/ui/core/code-load-watch.js'));
  const main = tags.findIndex(([, src]) => src.startsWith('assets/js/app/main.js'));
  assert.ok(watch >= 0, 'index.html loads the code-load watch');
  assert.ok(main >= 0, 'index.html loads main.js');
  assert.ok(watch < main, 'the watch is loaded before the module graph');
  assert.doesNotMatch(tags[watch][0], /\b(type="module"|async|defer)\b/, 'the watch is a classic script that runs at once');
  assert.match(tags[main][0], /\btype="module"/);
  assert.doesNotMatch(tags[main][0], /\basync\b/, 'main.js runs before DOMContentLoaded');
});

test('main.js marks that its code started before anything else it runs', () => {
  const source = readFileSync(path.join(ROOT, 'assets', 'js', 'app', 'main.js'), 'utf8');
  const body = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*import\s[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^\s*import\s+['"][^'"]+['"];?\s*$/gm, '')
    .trim();
  assert.match(body, /^document\.documentElement\.dataset\.codeStarted = 'true';/);
});
