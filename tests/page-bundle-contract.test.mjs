// The page bundle (scripts/build-page-bundle.mjs): the app's module graph,
// built into a few files named by their content, which a deployed page runs
// (index.html, CELLUCID_PAGE_BOOT). These contracts keep the committed bundle
// exactly what the sources build, keep the boot script naming its entry and
// every file it imports at startup, keep every module that reads its own
// address out of the bundle, and keep the bundle apart from the sources.

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  PAGE_BUNDLE_FILE,
  PAGE_DIR,
  PAGE_ENTRY,
  PAGE_EXTERNALS,
  buildPageBundle,
  stalePageFiles,
} from '../scripts/build-page-bundle.mjs';
import { contentTypeForAssetPath, renderPageBoot } from '../scripts/generate-web-asset-inventory.mjs';
import { createHash } from 'node:crypto';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const built = await buildPageBundle({ rootDir: ROOT });
const INDEX = await readFile(join(ROOT, 'index.html'), 'utf8');
const version = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 12);

test('the committed page bundle is exactly what the page sources build', async () => {
  assert.deepEqual(
    await stalePageFiles({ rootDir: ROOT, built }),
    [],
    'regenerate with `node scripts/generate-web-asset-inventory.mjs`.'
  );
});

test('the boot script names the bundle entry and every file it imports at startup', () => {
  const boot = /<script id="cellucid-page-boot">([\s\S]*?)<\/script>/.exec(INDEX)?.[1];
  assert.equal(boot, renderPageBoot(built), 'regenerate with `node scripts/generate-web-asset-inventory.mjs`.');
  assert.ok(built.entry.startsWith(`${PAGE_DIR}/main.`));
  // Every file the entry imports statically, through any other, is preloaded;
  // none it imports on demand is.
  const code = path => built.files.get(path).toString('utf8');
  const staticImports = path => [...code(path).matchAll(/(?:^|[;}])import\s*(?:[\w$*{][^"']*?from\s*)?"\.\/([^"]+)"/g)]
    .map(match => `${PAGE_DIR}/${match[1]}`);
  const reached = new Set();
  const pending = [built.entry];
  while (pending.length > 0) {
    for (const imported of staticImports(pending.pop())) {
      if (!reached.has(imported)) {
        reached.add(imported);
        pending.push(imported);
      }
    }
  }
  assert.deepEqual([...reached].sort(), built.preload);
  const onDemand = [...code(built.entry).matchAll(/import\("\.\/([^"]+)"\)/g)].map(match => `${PAGE_DIR}/${match[1]}`);
  assert.ok(onDemand.length > 0, 'the entry imports parts on demand');
  for (const path of onDemand) assert.ok(built.files.has(path), path);
});

test('a bundle file is named by its content and maps back to the shipped sources', async () => {
  for (const [path, bytes] of built.files) {
    assert.equal(posix.dirname(path), PAGE_DIR);
    assert.match(posix.basename(path), PAGE_BUNDLE_FILE, path);
    if (path.endsWith('.map')) {
      const map = JSON.parse(bytes.toString('utf8'));
      assert.equal(map.version, 3);
      assert.equal(map.sourcesContent, undefined, 'the sources are served beside it');
      for (const source of map.sources) {
        const shipped = posix.normalize(posix.join(PAGE_DIR, source));
        assert.ok(built.inputs.includes(shipped), `${path} maps to ${shipped}`);
      }
    } else {
      // A file of nothing but re-exports maps nothing, and names no map.
      const named = /\/\/# sourceMappingURL=(\S+)\n$/.exec(bytes.toString('utf8'))?.[1];
      if (named !== undefined) assert.equal(named, `${posix.basename(path)}.map`, path);
      assert.ok(built.files.has(`${path}.map`), `${path} has its source map`);
    }
  }
  assert.ok(built.inputs.includes(PAGE_ENTRY));
});

test('modules that read their own address are imported at their version, never bundled', async () => {
  const code = [...built.files].filter(([path]) => path.endsWith('.js')).map(([, bytes]) => bytes.toString('utf8')).join('\n');
  assert.doesNotMatch(code, /\bimport\.meta\b/, 'no bundled module reads import.meta');
  for (const path of PAGE_EXTERNALS) {
    assert.ok(!built.inputs.includes(path), `${path} is not bundled`);
    const bytes = await readFile(join(ROOT, ...path.split('/')));
    const specifier = `${posix.relative(PAGE_DIR, path)}?v=${version(bytes)}`;
    // Each is imported at the URL naming its bytes; the one module instance
    // the page and the worker scripts share.
    for (const [, imported] of code.matchAll(/from"(\.\.\/[^"]+)"/g)) {
      if (imported.split('?')[0] === specifier.split('?')[0]) assert.equal(imported, specifier);
    }
  }
  assert.ok(code.includes(`"${posix.relative(PAGE_DIR, 'assets/js/workers/worker-script.js')}?v=`));
});

test('the bundle lives apart from the sources, in a folder of nothing but what the generator writes', async () => {
  assert.ok(!PAGE_DIR.startsWith('assets/js/') && !PAGE_DIR.startsWith('assets/css/'));
  assert.deepEqual(
    (await readdir(join(ROOT, ...PAGE_DIR.split('/')))).map(name => `${PAGE_DIR}/${name}`).sort(),
    [...built.files.keys()].sort()
  );
});

test('the inventory ships every bundle file with its content type', async () => {
  const inventory = JSON.parse(await readFile(join(ROOT, 'cellucid-web-assets.json'), 'utf8'));
  const listed = new Map(inventory.assets.map(asset => [asset.path, asset.content_type]));
  for (const path of built.files.keys()) {
    assert.equal(listed.get(path), contentTypeForAssetPath(path), path);
  }
  for (const path of listed.keys()) {
    if (path.startsWith(`${PAGE_DIR}/`)) assert.ok(built.files.has(path), `${path} is listed but the build does not write it`);
  }
});
