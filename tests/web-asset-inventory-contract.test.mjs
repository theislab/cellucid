import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  assertPortableAssetPath,
  buildWebAssetInventory,
  contentTypeForAssetPath,
  isDirectModuleInvocation,
  isRuntimeCacheAssetPath,
  listSourceControlledAssets,
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
    contentTypeForAssetPath('assets/img/favicon.ico'),
    'image/vnd.microsoft.icon'
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

test('runtime cache policy excludes only the deploy-only social preview', async () => {
  assert.equal(
    isRuntimeCacheAssetPath('assets/img/og-preview.jpg'),
    false
  );
  for (const path of [
    'assets/img/og-preview.jpeg',
    'assets/img/og-preview-2.jpg',
    'assets/img/other.jpg',
    'index.html',
  ]) {
    assert.equal(isRuntimeCacheAssetPath(path), true, path);
  }

  const rootDir = await mkdtemp(join(tmpdir(), 'cellucid-web-inventory-'));
  await assert.rejects(
    buildWebAssetInventory({
      rootDir,
      paths: [
        'assets/img/og-preview.jpg',
        'browserconfig.xml',
        'index.html',
        'site.webmanifest',
      ],
    }),
    /deploy-only social preview/i
  );
});

test('both Git inventory scans exclude the social preview before traversal', async () => {
  const invocations = [];
  const executeGit = async (command, args, options) => {
    invocations.push({ command, args, options });
    return { stdout: Buffer.alloc(0) };
  };

  assert.deepEqual(
    await listSourceControlledAssets('/exact/web/root', executeGit),
    []
  );
  assert.equal(invocations.length, 2);
  for (const invocation of invocations) {
    assert.equal(invocation.command, 'git');
    assert.ok(invocation.args.includes('-z'));
    assert.ok(invocation.args.includes('--'));
    assert.ok(invocation.args.includes('assets'));
    assert.ok(
      invocation.args.includes(
        ':(top,exclude)assets/img/og-preview.jpg'
      )
    );
    assert.ok(
      invocation.args.indexOf(
        ':(top,exclude)assets/img/og-preview.jpg'
      ) > invocation.args.indexOf('--')
    );
    assert.equal(invocation.options.encoding, 'buffer');
  }
  assert.equal(
    invocations.filter(invocation =>
      invocation.args.includes('--deleted')
    ).length,
    1
  );
  assert.equal(
    invocations.filter(invocation =>
      invocation.args.includes('--cached')
    ).length,
    1
  );
});

test('deploy-only social metadata retains its exact public image URL', async () => {
  const indexHtml = await readFile(
    new URL('../index.html', import.meta.url),
    'utf8'
  );
  const imageUrl =
    'https://www.cellucid.com/assets/img/og-preview.jpg';

  assert.ok(
    indexHtml.includes(
      `<meta property="og:image" content="${imageUrl}" />`
    )
  );
  assert.ok(
    indexHtml.includes(
      `<meta name="twitter:image" content="${imageUrl}" />`
    )
  );
  assert.ok(indexHtml.includes(`"image": "${imageUrl}"`));
  assert.equal(indexHtml.split(imageUrl).length - 1, 3);
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

test('checked-in runtime inventory matches every packaged source byte', async () => {
  const rootDir = fileURLToPath(new URL('..', import.meta.url));
  const paths = await listSourceControlledAssets(rootDir);
  assert.equal(paths.includes('assets/img/og-preview.jpg'), false);

  const generated = serializeWebAssetInventory(
    await buildWebAssetInventory({ rootDir, paths })
  );
  const checkedIn = await readFile(
    join(rootDir, 'cellucid-web-assets.json')
  );
  assert.deepEqual(checkedIn, generated);
});

test(
  'inventory CLI identity resolves an equivalent symlinked script path',
  { skip: process.platform === 'win32' },
  async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'cellucid-inventory-cli-'));
    const realDir = join(rootDir, 'real');
    const aliasDir = join(rootDir, 'alias');
    await mkdir(realDir);
    const modulePath = join(realDir, 'inventory.mjs');
    await writeFile(modulePath, 'export {};\n');
    await symlink(realDir, aliasDir, 'dir');

    assert.equal(
      await isDirectModuleInvocation({
        argvPath: join(aliasDir, 'inventory.mjs'),
        moduleUrl: pathToFileURL(modulePath).href,
      }),
      true
    );
  }
);
