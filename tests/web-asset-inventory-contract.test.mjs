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
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  assertPortableAssetPath,
  STAMPED_BUILD_ID_PATTERN,
  buildWebAssetInventory,
  computeBuildDigest,
  contentTypeForAssetPath,
  isDirectModuleInvocation,
  isRuntimeCacheAssetPath,
  listSourceControlledAssets,
  serializeWebAssetInventory,
  stalePageScripts,
  stampPageScripts,
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
    contentTypeForAssetPath('favicon.ico'),
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
        'accessibility.html',
        'browserconfig.xml',
        'favicon.ico',
        'index.html',
        'privacy.html',
        'site.webmanifest',
        'terms.html',
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
  await writeFile(join(rootDir, '404.html'), '<!doctype html><title>Not found</title>\n');
  await writeFile(join(rootDir, 'CITATION.cff'), 'cff-version: 1.2.0\n');
  await writeFile(join(rootDir, 'browserconfig.xml'), '<browserconfig/>\n');
  await writeFile(join(rootDir, 'favicon.ico'), 'ico\n');
  await writeFile(join(rootDir, 'privacy.html'), '<!doctype html><title>Privacy</title>\n');
  await writeFile(join(rootDir, 'terms.html'), '<!doctype html><title>Terms</title>\n');
  await writeFile(join(rootDir, 'accessibility.html'), '<!doctype html><title>Accessibility</title>\n');
  await writeFile(join(rootDir, 'site.webmanifest'), '{}\n');

  const inventory = await buildWebAssetInventory({
    rootDir,
    paths: [
      '404.html',
      'CITATION.cff',
      'assets/js/app.js',
      'accessibility.html',
      'browserconfig.xml',
      'favicon.ico',
      'index.html',
      'privacy.html',
      'site.webmanifest',
      'terms.html',
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
      '404.html',
      'CITATION.cff',
      'accessibility.html',
      'assets/js/app.js',
      'browserconfig.xml',
      'favicon.ico',
      'index.html',
      'privacy.html',
      'site.webmanifest',
      'terms.html',
    ]
  );
  assert.equal(inventory.assets[0].content_type, 'text/html; charset=utf-8');
  assert.equal(inventory.assets[1].content_type, 'application/octet-stream');
  assert.equal(inventory.assets[3].bytes, 27);
  assert.match(inventory.assets[3].sha256, /^[0-9a-f]{64}$/);
  assert.equal(
    inventory.assets[3].content_type,
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
        '404.html',
        'CITATION.cff',
        'assets/js/app.js',
        'accessibility.html',
        'browserconfig.xml',
        'favicon.ico',
        'index.html',
        'privacy.html',
        'site.webmanifest',
        'terms.html',
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
  // Name exactly the assets that changed and the one command that regenerates
  // the inventory; the byte comparison after it still guards everything else.
  const entriesByPath = bytes => new Map(
    JSON.parse(bytes.toString('utf8')).assets
      .map(asset => [asset.path, JSON.stringify(asset)])
  );
  const checkedInEntries = entriesByPath(checkedIn);
  const generatedEntries = entriesByPath(generated);
  const staleAssets = [
    ...new Set([...checkedInEntries.keys(), ...generatedEntries.keys()]),
  ]
    .filter(path => checkedInEntries.get(path) !== generatedEntries.get(path))
    .sort();
  assert.deepEqual(
    staleAssets,
    [],
    'cellucid-web-assets.json is stale for the assets listed; regenerate it '
      + 'with `node scripts/generate-web-asset-inventory.mjs`.'
  );
  assert.deepEqual(checkedIn, generated);
});

test('the build id names the exact shipped bytes', async () => {
  // A hand-edited id went stale for months while the site changed under it.
  // The id is stamped by the generator from a digest of every shipped file, so
  // any asset change without a regeneration fails here, and the footer, the
  // situation report and the pip web cache all name the real build.
  const rootDir = fileURLToPath(new URL('..', import.meta.url));
  const paths = await listSourceControlledAssets(rootDir);
  const { build_id: buildId } = await buildWebAssetInventory({ rootDir, paths });
  assert.match(buildId, STAMPED_BUILD_ID_PATTERN);
  assert.equal(
    buildId.split('.')[1],
    await computeBuildDigest({ rootDir, paths }),
    'index.html names a different build than its files; regenerate with '
      + '`node scripts/generate-web-asset-inventory.mjs`.'
  );
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

const sha256Base64 = text => createHash('sha256').update(text, 'utf8').digest('base64');

test('a page names every script by its bytes, and its policy allows exactly its inline scripts', () => {
  const versions = new Map([
    ['assets/js/app/main.js', 'aaaaaaaaaaaa'],
    ['assets/js/lib/dep.js', 'bbbbbbbbbbbb'],
    ['assets/external/vendor.js', 'cccccccccccc'],
  ]);
  const html = [
    '<!doctype html><head>',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\' https://cdn.example \'sha256-stale=\'; style-src \'self\'" />',
    '<!-- a comment may name <script src="assets/js/nowhere.js"></script> without being one -->',
    '<script type="importmap"></script>',
    '<script src="assets/external/vendor.js?v=0123"></script>',
    '<script src="https://cdn.example/x.js"></script>',
    '<script type="application/ld+json">{"a": 1}</script>',
    '</head><body><script type="module" src="assets/js/app/main.js"></script></body>',
  ].join('\n');
  const stamped = stampPageScripts({ html, pagePath: 'index.html', versions });

  const map = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(stamped)[1]);
  assert.deepEqual(map, {
    imports: {
      './assets/external/vendor.js': './assets/external/vendor.js?v=cccccccccccc',
      './assets/js/app/main.js': './assets/js/app/main.js?v=aaaaaaaaaaaa',
      './assets/js/lib/dep.js': './assets/js/lib/dep.js?v=bbbbbbbbbbbb',
    },
  });
  assert.match(stamped, /<script src="assets\/external\/vendor\.js\?v=cccccccccccc"><\/script>/);
  assert.match(stamped, /<script type="module" src="assets\/js\/app\/main\.js\?v=aaaaaaaaaaaa"><\/script>/);
  assert.match(stamped, /<script src="https:\/\/cdn\.example\/x\.js"><\/script>/);
  assert.match(stamped, /<!-- a comment may name <script src="assets\/js\/nowhere\.js"><\/script> without being one -->/);

  const mapText = /<script type="importmap">([\s\S]*?)<\/script>/.exec(stamped)[1];
  const policy = /content="([^"]*)"/.exec(stamped)[1];
  assert.equal(
    policy,
    `default-src 'self'; script-src 'self' https://cdn.example 'sha256-${sha256Base64(mapText)}' `
      + `'sha256-${sha256Base64('{"a": 1}')}'; style-src 'self'`
  );
  assert.equal(stampPageScripts({ html: stamped, pagePath: 'index.html', versions }), stamped);

  // A page below the root keys its map relative to its own folder.
  const nested = stampPageScripts({
    html: '<script type="importmap"></script><script type="module" src="/assets/js/app/main.js"></script>',
    pagePath: 'assets/auth/callback.html',
    versions,
  });
  assert.match(nested, /"\.\.\/js\/lib\/dep\.js": "\.\.\/js\/lib\/dep\.js\?v=bbbbbbbbbbbb"/);
  assert.match(nested, /src="\/assets\/js\/app\/main\.js\?v=aaaaaaaaaaaa"/);
});

test('a page that runs modules declares its one import map before them, and names only shipped scripts', () => {
  const versions = new Map([['assets/js/app/main.js', 'aaaaaaaaaaaa']]);
  const module = '<script type="module" src="assets/js/app/main.js"></script>';
  assert.throws(
    () => stampPageScripts({ html: module, pagePath: 'index.html', versions }),
    /exactly one <script type="importmap">/
  );
  assert.throws(
    () => stampPageScripts({ html: `${module}<script type="importmap"></script>`, pagePath: 'index.html', versions }),
    /import map before its first module script/
  );
  assert.throws(
    () => stampPageScripts({ html: '<script type="importmap"></script>', pagePath: 'index.html', versions }),
    /runs no ES module/
  );
  assert.throws(
    () => stampPageScripts({
      html: '<script type="importmap"></script><script type="module" src="assets/js/gone.js"></script>',
      pagePath: 'index.html',
      versions,
    }),
    /not a shipped asset: assets\/js\/gone\.js/
  );
});

test('every shipped page names the current bytes of every script it loads', async () => {
  const rootDir = fileURLToPath(new URL('..', import.meta.url));
  const paths = await listSourceControlledAssets(rootDir);
  assert.deepEqual(
    (await stalePageScripts({ rootDir, paths })).map(page => page.pagePath),
    [],
    'regenerate with `node scripts/generate-web-asset-inventory.mjs`.'
  );
  // The app's import map lists every shipped script, at its inventory digest.
  const inventory = JSON.parse(await readFile(join(rootDir, 'cellucid-web-assets.json'), 'utf8'));
  const index = await readFile(join(rootDir, 'index.html'), 'utf8');
  const { imports } = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(index)[1]);
  const scripts = inventory.assets.filter(asset => asset.path.startsWith('assets/') && asset.path.endsWith('.js'));
  assert.ok(scripts.some(asset => asset.path === 'assets/js/app/main.js'));
  assert.deepEqual(
    imports,
    Object.fromEntries(scripts.map(asset => [`./${asset.path}`, `./${asset.path}?v=${asset.sha256.slice(0, 12)}`]))
  );
});
