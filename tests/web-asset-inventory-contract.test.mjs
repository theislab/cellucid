import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { after } from 'node:test';

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
  namesItsBytes,
  renderPageBoot,
  stalePages,
  stampedStylesheets,
  stampPage,
} from '../scripts/generate-web-asset-inventory.mjs';
import { buildPageBundle } from '../scripts/build-page-bundle.mjs';

// Every temporary folder a test makes, removed once the file's tests are done.
const madeFolders = [];
after(() => Promise.all(madeFolders.map(folder => rm(folder, { recursive: true, force: true }))));

async function temporaryFolder(prefix) {
  const folder = await mkdtemp(join(tmpdir(), prefix));
  madeFolders.push(folder);
  return folder;
}

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

  const rootDir = await temporaryFolder('cellucid-web-inventory-');
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
  const rootDir = await temporaryFolder('cellucid-web-inventory-');
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
  await writeFile(join(rootDir, 'service-worker.js'), '// code cache\n');

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
      'service-worker.js',
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
      'service-worker.js',
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
        'service-worker.js',
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
    const rootDir = await temporaryFolder('cellucid-inventory-cli-');
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
  const stamped = stampPage({ html, pagePath: 'index.html', versions });

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
  assert.equal(stampPage({ html: stamped, pagePath: 'index.html', versions }), stamped);

  // A page below the root keys its map relative to its own folder.
  const nested = stampPage({
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
    () => stampPage({ html: module, pagePath: 'index.html', versions }),
    /exactly one <script type="importmap">/
  );
  assert.throws(
    () => stampPage({ html: `${module}<script type="importmap"></script>`, pagePath: 'index.html', versions }),
    /import map before its first module script/
  );
  assert.throws(
    () => stampPage({ html: '<script type="importmap"></script>', pagePath: 'index.html', versions }),
    /runs no ES module/
  );
  assert.throws(
    () => stampPage({
      html: '<script type="importmap"></script><script type="module" src="assets/js/gone.js"></script>',
      pagePath: 'index.html',
      versions,
    }),
    /not a shipped asset: assets\/js\/gone\.js/
  );
});

test('a stylesheet names what it imports and uses by their bytes, and a page preloads every stylesheet it needs', async () => {
  const rootDir = await temporaryFolder('cellucid-web-styles-');
  await mkdir(join(rootDir, 'assets', 'css', 'parts'), { recursive: true });
  await mkdir(join(rootDir, 'assets', 'fonts'), { recursive: true });
  const write = (path, text) => writeFile(join(rootDir, ...path.split('/')), text);
  await write('assets/fonts/face.woff2', 'font bytes');
  await write('assets/css/parts/_a.css', "/* url('../nowhere.png') is a comment */\n@font-face { src: url('../../fonts/face.woff2?v=000000000000') format('woff2'); }\n");
  await write('assets/css/parts/_index.css', "@import '_a.css';\n");
  await write('assets/css/main.css', "@layer base;\n@import 'parts/_index.css' layer(base);\nbody { background: url(data:image/png;base64,AAAA); }\n");
  const paths = ['assets/css/main.css', 'assets/css/parts/_index.css', 'assets/css/parts/_a.css', 'assets/fonts/face.woff2'];
  const version = text => createHash('sha256').update(text).digest('hex').slice(0, 12);

  const stamped = await stampedStylesheets({ rootDir, paths });
  const a = stamped.get('assets/css/parts/_a.css');
  assert.match(a, new RegExp(`url\\('\\.\\./\\.\\./fonts/face\\.woff2\\?v=${version('font bytes')}'\\) format`));
  assert.match(a, /url\('\.\.\/nowhere\.png'\) is a comment/, 'a comment is not a reference');
  const index = stamped.get('assets/css/parts/_index.css');
  assert.equal(index, `@import '_a.css?v=${version(a)}';\n`, 'a stylesheet names its import by the import\'s stamped bytes');
  const main = stamped.get('assets/css/main.css');
  assert.match(main, new RegExp(`@import 'parts/_index\\.css\\?v=${version(index)}' layer\\(base\\);`));
  assert.match(main, /url\(data:image\/png;base64,AAAA\)/, 'a data URL is not a file');

  const versions = new Map(paths.map(path => [path, version(stamped.get(path) ?? 'font bytes')]));
  const html = [
    '<head>',
    '  <link rel="preload" href="assets/fonts/face.woff2" as="font" type="font/woff2" crossorigin />',
    '  <link rel="preload" as="style" href="assets/css/stale.css?v=000000000000" />',
    '  <link rel="stylesheet" href="assets/css/main.css" />',
    '</head>',
  ].join('\n');
  const page = stampPage({ html, pagePath: 'index.html', versions, stylesheets: stamped });
  assert.equal(page, [
    '<head>',
    `  <link rel="preload" href="assets/fonts/face.woff2?v=${versions.get('assets/fonts/face.woff2')}" as="font" type="font/woff2" crossorigin />`,
    `  <link rel="preload" as="style" href="assets/css/parts/_index.css?v=${versions.get('assets/css/parts/_index.css')}" />`,
    `  <link rel="preload" as="style" href="assets/css/parts/_a.css?v=${versions.get('assets/css/parts/_a.css')}" />`,
    `  <link rel="stylesheet" href="assets/css/main.css?v=${versions.get('assets/css/main.css')}" />`,
    '</head>',
  ].join('\n'));
  assert.equal(stampPage({ html: page, pagePath: 'index.html', versions, stylesheets: stamped }), page);

  await write('assets/css/parts/_b.css', "@import '../gone.css';\n");
  await assert.rejects(
    stampedStylesheets({ rootDir, paths: [...paths, 'assets/css/parts/_b.css'] }),
    /_b\.css names a file that is not a shipped asset: \.\.\/gone\.css/
  );
});

test('a page with a boot script starts its sources on this machine and its bundle anywhere else', async () => {
  const versions = new Map([['assets/js/app/main.js', 'aaaaaaaaaaaa']]);
  const page = { entry: 'assets/page/main.ABCDEFGH.js', preload: ['assets/page/chunk.IJKLMNOP.js'] };
  const html = '<head><script type="importmap"></script><script id="cellucid-page-boot"></script></head>';
  const stamped = stampPage({ html, pagePath: 'index.html', versions, page });
  const boot = /<script id="cellucid-page-boot">([\s\S]*?)<\/script>/.exec(stamped)[1];
  assert.equal(boot, renderPageBoot(page));
  assert.match(boot, /\["localhost","127\.0\.0\.1","\[::1\]"\]\.includes\(location\.hostname\)/);
  assert.match(boot, /"assets\/page\/main\.ABCDEFGH\.js",\s*"assets\/page\/chunk\.IJKLMNOP\.js"/);
  assert.match(boot, /thisMachine \? "assets\/js\/app\/main\.js" : bundle\[0\]/);
  assert.throws(
    () => stampPage({ html, pagePath: 'index.html', versions }),
    /boot script, so it needs the page bundle/
  );
  assert.throws(
    () => stampPage({
      html: '<script id="cellucid-page-boot"></script><script type="importmap"></script>',
      pagePath: 'index.html',
      versions,
      page,
    }),
    /import map before its first module script/
  );

  // Run in a page of either kind: what it preloads, what it imports, and the
  // code cache it registers once the page has loaded, and the files it names
  // to keep once every startup file is in.
  const run = async (hostname, { styleLoadFailed = false } = {}) => {
    const appended = [];
    const imported = [];
    const registered = [];
    const posted = [];
    const failures = [];
    const listeners = new Map();
    const windowListeners = new Map();
    const scope = {
      location: { hostname },
      document: {
        baseURI: `https://${hostname}/`,
        readyState: 'loading',
        // What the style gate leaves on the root when the stylesheet did not load.
        documentElement: { dataset: styleLoadFailed ? { styleLoadFailed: 'true' } : {} },
        createElement: () => {
          const linkListeners = new Map();
          return {
            addEventListener: (type, listener) => linkListeners.set(type, listener),
            fire: type => linkListeners.get(type)?.(),
          };
        },
        head: { append: element => appended.push(element) },
        addEventListener: (type, listener) => listeners.set(type, listener),
        querySelector: selector => (selector === 'link[rel="stylesheet"]'
          ? { href: `https://${hostname}/assets/css/main.css` }
          : { content: '2026-10-29.0123abcd' }),
      },
      window: { dispatchEvent: event => failures.push(event), addEventListener: (type, listener) => windowListeners.set(type, listener) },
      navigator: {
        serviceWorker: {
          register: url => {
            registered.push(url);
            return Promise.resolve();
          },
          ready: Promise.resolve({ active: { postMessage: message => posted.push(message) } }),
        },
      },
      performance: { getEntriesByType: () => [{ name: `https://${hostname}/assets/css/main.css?v=0123456789ab` }, { name: `https://${hostname}/assets/page/chunk.IJKLMNOP.js` }] },
      URL,
      CustomEvent: class {
        constructor(type, { detail }) {
          this.type = type;
          this.detail = detail;
        }
      },
      importModule: url => {
        imported.push(url);
        return Promise.resolve();
      },
    };
    new Function(...Object.keys(scope), boot.replace('import(entry)', 'importModule(entry)'))(...Object.values(scope));
    assert.deepEqual(imported, [], 'nothing is imported before the document is parsed');
    listeners.get('DOMContentLoaded')();
    windowListeners.get('load')?.();
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));
    await settle();
    // Nothing is named while a startup file is still arriving; a file that
    // failed is named too (the worker refuses what is not there).
    const beforeAllIn = posted.length;
    appended[0]?.fire('load');
    await settle();
    const withOneIn = posted.length;
    appended[1]?.fire('error');
    await settle();
    return {
      preloaded: appended.map(link => `${link.rel} ${link.href}`),
      imported,
      registered,
      postedBefore: [beforeAllIn, withOneIn],
      kept: posted.map(message => message.keep),
      failures,
    };
  };
  assert.deepEqual(await run('localhost'), {
    preloaded: [],
    imported: ['https://localhost/assets/js/app/main.js'],
    registered: [],
    postedBefore: [0, 0],
    kept: [],
    failures: [],
  });
  assert.deepEqual(await run('www.cellucid.com'), {
    preloaded: ['modulepreload assets/page/main.ABCDEFGH.js', 'modulepreload assets/page/chunk.IJKLMNOP.js'],
    imported: ['https://www.cellucid.com/assets/page/main.ABCDEFGH.js'],
    registered: ['service-worker.js?build=2026-10-29.0123abcd'],
    postedBefore: [0, 0],
    // Every startup file, whether or not the page's resource timing has it, then the rest it loaded, once each.
    kept: [[
      'https://www.cellucid.com/assets/page/main.ABCDEFGH.js',
      'https://www.cellucid.com/assets/page/chunk.IJKLMNOP.js',
      'https://www.cellucid.com/assets/css/main.css?v=0123456789ab',
    ]],
    failures: [],
  });
  // A page whose stylesheet did not load starts no code: it reports the stylesheet.
  const unstyled = await run('www.cellucid.com', { styleLoadFailed: true });
  assert.deepEqual(unstyled.imported, []);
  assert.deepEqual(
    unstyled.failures.map(event => [event.type, event.detail]),
    [['cellucid-code-load-failed', { entry: 'https://www.cellucid.com/assets/css/main.css', stylesheet: true }]],
  );
});

test('only a worker or page bundle names its bytes by its file name', () => {
  for (const path of [
    'assets/workers/decode-worker.0123456789ab.js',
    'assets/workers/decode-worker.0123456789ab.js.map',
    'assets/page/main.ABCDEFGH.js',
    'assets/page/chunk.ABCD2345.js.map',
  ]) {
    assert.equal(namesItsBytes(path), true, path);
  }
  for (const path of [
    'assets/workers/scripts.js',
    'assets/js/app/main.js',
    'assets/js/app/main.ABCDEFGH.js',
    'assets/page/main.js',
    'assets/css/main.css',
  ]) {
    assert.equal(namesItsBytes(path), false, path);
  }
});

test('every shipped page and stylesheet names the current bytes of every file it loads', async () => {
  const rootDir = fileURLToPath(new URL('..', import.meta.url));
  const paths = await listSourceControlledAssets(rootDir);
  const stylesheets = await stampedStylesheets({ rootDir, paths });
  for (const [path, text] of stylesheets) {
    assert.equal(
      await readFile(join(rootDir, ...path.split('/')), 'utf8'),
      text,
      `${path}: regenerate with \`node scripts/generate-web-asset-inventory.mjs\`.`
    );
  }
  const page = await buildPageBundle({ rootDir });
  assert.deepEqual(
    (await stalePages({ rootDir, paths, stylesheets, page })).map(stale => stale.pagePath),
    [],
    'regenerate with `node scripts/generate-web-asset-inventory.mjs`.'
  );
  // The app's import map lists every shipped script whose name does not
  // already name its bytes, at its inventory digest.
  const inventory = JSON.parse(await readFile(join(rootDir, 'cellucid-web-assets.json'), 'utf8'));
  const index = await readFile(join(rootDir, 'index.html'), 'utf8');
  const { imports } = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(index)[1]);
  const scripts = inventory.assets.filter(asset =>
    asset.path.startsWith('assets/') && asset.path.endsWith('.js') && !namesItsBytes(asset.path));
  assert.ok(scripts.some(asset => asset.path === 'assets/js/app/main.js'));
  assert.deepEqual(
    imports,
    Object.fromEntries(scripts.map(asset => [`./${asset.path}`, `./${asset.path}?v=${asset.sha256.slice(0, 12)}`]))
  );
});
