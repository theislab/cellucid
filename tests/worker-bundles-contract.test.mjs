// Worker bundles (scripts/build-worker-bundles.mjs): every worker the app
// starts, and every module a worker imports by URL, ships as one file named by
// its bytes, and the page starts each from that file when it is a deployed
// site. These contracts keep the committed bundles exactly what the sources
// build, keep every worker start going through the generated scripts.js, and
// keep a bundle one file.

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  BUNDLE_FILE,
  WORKERS_DIR,
  WORKER_ENTRIES,
  WORKER_SCRIPTS_PATH,
  buildWorkerBundles,
  staleWorkerFiles,
} from '../scripts/build-worker-bundles.mjs';
import { contentTypeForAssetPath } from '../scripts/generate-web-asset-inventory.mjs';
import * as scripts from '../assets/workers/scripts.js';
import {
  onWorkerScriptFailure,
  startWorker,
  startsFromBundles,
} from '../assets/js/workers/worker-script.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const built = await buildWorkerBundles({ rootDir: ROOT });

async function shippedScripts(directory = join(ROOT, 'assets', 'js')) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await shippedScripts(path));
    else if (entry.name.endsWith('.js')) found.push(relative(ROOT, path).split(sep).join('/'));
  }
  return found;
}

/** The code of a module with its comments and string contents blanked. */
function codeOf(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1')
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, "''");
}

test('the committed worker bundles are exactly what the worker sources build', async () => {
  assert.deepEqual(
    await staleWorkerFiles({ rootDir: ROOT, built }),
    [],
    'regenerate with `node scripts/generate-web-asset-inventory.mjs`.'
  );
});

test('a bundle is named by its bytes and holds every module of its worker', async () => {
  assert.equal(built.bundles.length, WORKER_ENTRIES.length);
  for (const { source, path, inputs } of built.bundles) {
    const file = posix.basename(path);
    const match = BUNDLE_FILE.exec(file);
    assert.ok(match, `${path} is not a bundle name`);
    assert.equal(match[1], posix.basename(source, '.js'));
    assert.ok(inputs.includes(source));
    const code = built.files.get(path).toString('utf8');
    // One file: no import or re-export of another module is left in it.
    assert.doesNotMatch(code, /^\s*import\s*[\w{*'"]/m, `${path} imports a module`);
    assert.doesNotMatch(code, /^\s*export\s*(?:\*|\{[^}]*\})\s*from\b/m, `${path} re-exports a module`);
    assert.ok(code.endsWith(`\n//# sourceMappingURL=${file}.map\n`), `${path} names its source map`);
  }
});

test('a bundle source map maps back to the shipped sources', async () => {
  for (const { path, inputs } of built.bundles) {
    const map = JSON.parse(built.files.get(`${path}.map`).toString('utf8'));
    assert.equal(map.version, 3);
    assert.equal(map.sourcesContent, undefined, 'the sources are served beside it');
    const sources = map.sources.map(source => posix.normalize(posix.join(WORKERS_DIR, source)));
    // Every module whose code the bundle holds (re-exporting index modules
    // and modules of which nothing is used contribute none).
    assert.ok(sources.length > 0);
    for (const source of sources) assert.ok(inputs.includes(source), `${path} maps to ${source}`);
    for (const source of sources) {
      assert.ok((await readFile(join(ROOT, ...source.split('/')))).length > 0, source);
    }
  }
});

test('every worker is started, and every worker module named, through the generated scripts.js', async () => {
  const names = new Set(WORKER_ENTRIES.map(({ name }) => `${name}Script`));
  assert.deepEqual(Object.keys(scripts).sort(), [...names].sort());
  const used = new Set();
  for (const path of await shippedScripts()) {
    // The one place a worker is constructed.
    if (path === 'assets/js/workers/worker-script.js') continue;
    // The Cloudflare Worker of community annotations is not a web worker.
    if (path === 'assets/js/app/community-annotations/_worker-code.js') continue;
    const code = codeOf(await readFile(join(ROOT, ...path.split('/')), 'utf8'));
    assert.doesNotMatch(
      code,
      /\bnew\s+(?:globalThis\.|window\.|self\.)?(?:Shared)?Worker\s*\(/,
      `${path} starts a worker itself: use startWorker(<entry>Script(), …) from workers/`
    );
    assert.doesNotMatch(
      code,
      /\bimport\.meta\.url\b/,
      `${path} names a file by import.meta.url, which in a worker bundle names the bundle`
    );
    for (const [, name] of code.matchAll(/\b(\w+Script)\s*\(\s*\)/g)) {
      if (names.has(name)) used.add(name);
    }
    for (const call of code.matchAll(/\bstartWorker\s*\(/g)) {
      const argument = code.slice(call.index + call[0].length, call.index + call[0].length + 80);
      assert.match(argument, /^\s*\w+Script\(\s*\)\s*[,)]/, `${path} starts a worker from ${argument}`);
    }
  }
  assert.deepEqual([...used].sort(), [...names].sort(), 'every entry is started or imported somewhere');
});

test('workers start from their bundles on a deployed site, from their sources on this machine', () => {
  for (const hostname of ['www.cellucid.com', 'theislab.github.io', 'deployed.localhost', 'hub.example.org']) {
    assert.equal(startsFromBundles({ location: { hostname } }), true, hostname);
  }
  for (const hostname of ['localhost', '127.0.0.1', '[::1]']) {
    assert.equal(startsFromBundles({ location: { hostname } }), false, hostname);
  }
  // Node has no page address: its tests run the sources.
  assert.equal(startsFromBundles({}), false);
  for (const [name, script] of Object.entries(scripts)) {
    const entry = WORKER_ENTRIES.find(candidate => `${candidate.name}Script` === name);
    assert.equal(fileURLToPath(script()), join(ROOT, ...entry.source.split('/')));
  }
  const text = built.files.get(WORKER_SCRIPTS_PATH).toString('utf8');
  for (const { name, path } of built.bundles) {
    assert.match(text, new RegExp(`${name}Script = .*'\\./${posix.basename(path).replace(/\./g, '\\.')}'\\);`));
  }
});

test('a worker whose script fails to load is reported to whoever listens', () => {
  const previous = globalThis.Worker;
  class FailingWorker extends EventTarget {
    constructor(script, options) {
      super();
      this.script = script;
      this.options = options;
    }
  }
  globalThis.Worker = FailingWorker;
  const heard = [];
  const stop = onWorkerScriptFailure(event => heard.push(event.type));
  try {
    const worker = startWorker(scripts.decodeWorkerScript(), { type: 'module', name: 'cellucid-decode' });
    assert.deepEqual(worker.options, { type: 'module', name: 'cellucid-decode' });
    worker.dispatchEvent(new Event('error'));
    assert.deepEqual(heard, ['error']);
    stop();
    worker.dispatchEvent(new Event('error'));
    assert.deepEqual(heard, ['error']);
  } finally {
    stop();
    if (previous === undefined) delete globalThis.Worker;
    else globalThis.Worker = previous;
  }
});

test('the bundles live apart from the sources, in a folder of nothing but what the generator writes', async () => {
  // The one rule that keeps generated code out of every source contract:
  // those read assets/js/ (and assets/css/), and nothing generated is there.
  assert.ok(!WORKERS_DIR.startsWith('assets/js/') && !WORKERS_DIR.startsWith('assets/css/'));
  for (const path of await shippedScripts()) {
    assert.doesNotMatch(posix.basename(path), BUNDLE_FILE, `${path} is a generated bundle inside the sources`);
  }
  assert.ok(!(await shippedScripts()).includes('assets/js/workers/scripts.js'));
  assert.deepEqual(
    (await readdir(join(ROOT, ...WORKERS_DIR.split('/')))).map(name => `${WORKERS_DIR}/${name}`).sort(),
    [...built.files.keys()].sort()
  );
});

test('the inventory ships every bundle and source map with its content type', async () => {
  const inventory = JSON.parse(await readFile(join(ROOT, 'cellucid-web-assets.json'), 'utf8'));
  const listed = new Map(inventory.assets.map(asset => [asset.path, asset.content_type]));
  for (const path of built.files.keys()) {
    assert.equal(listed.get(path), contentTypeForAssetPath(path), path);
  }
  assert.equal(contentTypeForAssetPath('assets/workers/decode-worker.0123456789ab.js.map'), 'application/json; charset=utf-8');
  for (const path of listed.keys()) {
    if (path.startsWith(`${WORKERS_DIR}/`)) {
      assert.ok(built.files.has(path), `${path} is listed but no entry builds it`);
    }
  }
});
