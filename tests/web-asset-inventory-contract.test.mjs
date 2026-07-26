import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertPortableAssetPath,
  buildWebAssetInventory,
  contentTypeForAssetPath,
  serializeWebAssetInventory,
} from '../scripts/generate-web-asset-inventory.mjs';

test('web asset paths use one Windows-portable root-relative grammar', () => {
  for (const path of [
    'index.html',
    'assets/css/main.css',
    'assets/js/app/main.js',
    'assets/img/icon.svg',
    'browserconfig.xml',
    'site.webmanifest',
  ]) {
    assert.equal(assertPortableAssetPath(path), path);
  }

  for (const path of [
    '',
    '/assets/app.js',
    'assets\\app.js',
    'assets/../app.js',
    'assets//app.js',
    'assets/css/CON.css',
    'assets/css/com1.txt',
    'assets/css/name:dark.css',
    'assets/css/trailing.',
    'assets/css/trailing ',
    'assets/css/app.js?raw',
    'assets/css/app.js#fragment',
  ]) {
    assert.throws(
      () => assertPortableAssetPath(path),
      /portable web asset path/i,
      path
    );
  }
});

test('web inventory MIME types are explicit and never guessed', () => {
  assert.equal(
    contentTypeForAssetPath('index.html'),
    'text/html; charset=utf-8'
  );
  assert.equal(
    contentTypeForAssetPath('assets/js/app.js'),
    'application/javascript; charset=utf-8'
  );
  assert.equal(
    contentTypeForAssetPath('assets/css/app.css'),
    'text/css; charset=utf-8'
  );
  assert.equal(
    contentTypeForAssetPath('assets/data/manifest.json'),
    'application/json; charset=utf-8'
  );
  assert.equal(
    contentTypeForAssetPath('assets/fonts/app.woff2'),
    'font/woff2'
  );
  assert.equal(
    contentTypeForAssetPath('site.webmanifest'),
    'application/manifest+json; charset=utf-8'
  );
  assert.equal(
    contentTypeForAssetPath('browserconfig.xml'),
    'application/xml; charset=utf-8'
  );
  assert.throws(
    () => contentTypeForAssetPath('assets/data/unknown.data'),
    /unsupported web asset extension/i
  );
});

test('web inventory binds exact bytes to the single index build id', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'cellucid-web-inventory-'));
  await mkdir(join(rootDir, 'assets', 'js'), { recursive: true });
  await writeFile(
    join(rootDir, 'index.html'),
    '<!doctype html><meta name="cellucid-web-build-id" content="build-1">\n'
  );
  await writeFile(
    join(rootDir, 'assets', 'js', 'app.js'),
    'export const ready = true;\n'
  );
  await writeFile(join(rootDir, 'browserconfig.xml'), '<browserconfig/>\n');
  await writeFile(join(rootDir, 'site.webmanifest'), '{}\n');

  const inventory = await buildWebAssetInventory({
    rootDir,
    paths: [
      'assets/js/app.js',
      'browserconfig.xml',
      'index.html',
      'site.webmanifest',
    ],
  });
  assert.deepEqual(
    Object.keys(inventory),
    ['version', 'build_id', 'assets']
  );
  assert.equal(inventory.version, 1);
  assert.equal(inventory.build_id, 'build-1');
  assert.deepEqual(
    inventory.assets.map(asset => asset.path),
    [
      'assets/js/app.js',
      'browserconfig.xml',
      'index.html',
      'site.webmanifest',
    ]
  );
  assert.equal(inventory.assets[0].bytes, 27);
  assert.match(inventory.assets[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(
    inventory.assets[0].content_type,
    'application/javascript; charset=utf-8'
  );

  const serialized = serializeWebAssetInventory(inventory);
  assert.equal(serialized.at(-1), 0x0a);
  assert.deepEqual(
    JSON.parse(serialized.toString('utf8')),
    inventory
  );

  await writeFile(
    join(rootDir, 'index.html'),
    '<meta name="cellucid-web-build-id" content="one">\n' +
    '<meta name="cellucid-web-build-id" content="two">\n'
  );
  await assert.rejects(
    buildWebAssetInventory({
      rootDir,
      paths: [
        'assets/js/app.js',
        'browserconfig.xml',
        'index.html',
        'site.webmanifest',
      ],
    }),
    /exactly one.*build id/i
  );

  await writeFile(
    join(rootDir, 'cellucid-web-assets.json'),
    '{}\n'
  );
  await assert.rejects(
    buildWebAssetInventory({
      rootDir,
      paths: [
        'browserconfig.xml',
        'cellucid-web-assets.json',
        'index.html',
        'site.webmanifest',
      ],
    }),
    /inventory.*must not list itself/i
  );

  assert.ok((await readFile(join(rootDir, 'assets', 'js', 'app.js'))).length > 0);
});
