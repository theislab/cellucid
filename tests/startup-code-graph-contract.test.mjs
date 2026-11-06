/**
 * Startup never stops silently before the application runs.
 *
 * Every startup failure surface lives inside the module graph rooted at
 * `main.js`; before it runs, only the code-load watch
 * (`assets/js/app/ui/core/code-load-watch.js`) can say anything. The page's
 * boot script (index.html, CELLUCID_PAGE_BOOT) imports the graph's entry once
 * the document is parsed and hands the watch a failure to download, parse,
 * link or run it (`cellucid-code-load-failed`). That rests on what this file
 * pins:
 *
 * - No module of the application awaits at its top level. A top-level
 *   `await` that never settles (a storage, lock or file-system promise a
 *   browser leaves pending) holds every module that imports it, `main.js`
 *   included, and the import of the entry never settles either: no error for
 *   the watch to see, and the page says "Starting Cellucid" forever. A lazily
 *   imported module would hang its feature the same way. Asynchronous starts
 *   belong in functions whose caller owns their failure and deadline
 *   (`app/startup-phase.js`).
 * - The watch is a classic script in the head, which runs before the boot
 *   script imports anything; the boot script reports every failure of the
 *   import to it.
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

test('the code-load watch runs before the module graph it watches, and hears every failure of it', () => {
  const page = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const head = page.slice(0, page.indexOf('</head>'));
  const tags = [...head.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)];
  const watch = tags.find(([, src]) => src.startsWith('assets/js/app/ui/core/code-load-watch.js'));
  assert.ok(watch !== undefined, 'the head loads the code-load watch');
  assert.doesNotMatch(watch[0], /\b(type="module"|async|defer)\b/, 'the watch is a classic script that runs at once');
  assert.doesNotMatch(page, /<script\b[^>]*\btype="module"/, 'no module script starts the graph before the boot script does');
  const boot = /<script id="cellucid-page-boot">([\s\S]*?)<\/script>/.exec(head);
  assert.ok(boot !== null, 'the head carries the boot script');
  assert.match(boot[1], /document\.addEventListener\('DOMContentLoaded', start/, 'the entry is imported once the document is parsed');
  assert.match(boot[1], /import\(entry\)\.catch\(error => \{\s*window\.dispatchEvent\(new CustomEvent\('cellucid-code-load-failed'/);
  const watchSource = readFileSync(path.join(ROOT, 'assets', 'js', 'app', 'ui', 'core', 'code-load-watch.js'), 'utf8');
  assert.match(watchSource, /window\.addEventListener\('cellucid-code-load-failed'/);
});

test('the document is parsed, and the code started, only once the stylesheet is in', () => {
  // A script waits for the stylesheets before it, so the style gate, straight
  // after the stylesheet link, holds the parser there: no <body> exists in an
  // unstyled page, and DOMContentLoaded (the boot's cue) follows the styles in
  // every engine. WebKit does not hold DOMContentLoaded for a stylesheet by
  // itself (tests/browser/style-gate.spec.mjs runs it in the engines).
  const page = readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const head = page.slice(0, page.indexOf('</head>'));
  const stylesheets = [...head.matchAll(/<link rel="stylesheet"[^>]*>/g)];
  assert.equal(stylesheets.length, 1, 'the page has one stylesheet link, in its head');
  assert.doesNotMatch(page.slice(page.indexOf('</head>')), /<link rel="stylesheet"/, 'no stylesheet link follows the gate');
  const afterStylesheet = head.slice(stylesheets[0].index + stylesheets[0][0].length);
  const gate = /^\s*<script id="cellucid-style-gate">([\s\S]*?)<\/script>\s*$/.exec(afterStylesheet);
  assert.ok(gate !== null, 'the style gate is the next and last element of the head after the stylesheet link');
  assert.match(gate[0], /^\s*<script id="cellucid-style-gate">/, 'a classic inline script: not a module, not deferred, not async');
  assert.match(gate[1], /\.sheet\.cssRules\.length > 0/, 'it reads whether the stylesheet has rules');
  assert.match(gate[1], /dataset\.styleLoadFailed = 'true'/, 'and says when it has none');
  const boot = /<script id="cellucid-page-boot">([\s\S]*?)<\/script>/.exec(head);
  assert.match(
    boot[1],
    /if \(document\.documentElement\.dataset\.styleLoadFailed === 'true'\) \{[\s\S]*?stylesheet: true[\s\S]*?return;\s*\}\s*import\(entry\)/,
    'the boot starts no code in a page whose stylesheet did not load',
  );
  const watchSource = readFileSync(path.join(ROOT, 'assets', 'js', 'app', 'ui', 'core', 'code-load-watch.js'), 'utf8');
  assert.match(watchSource, /if \(stylesheet === true\) \{\s*fail\('download'/);
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
