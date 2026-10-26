#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  lstat,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, extname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  buildWorkerBundles,
  staleWorkerFiles,
  writeWorkerBundles,
} from './build-worker-bundles.mjs';

const execFileAsync = promisify(execFile);
const INVENTORY_FILENAME = 'cellucid-web-assets.json';
const DEPLOY_ONLY_SOCIAL_PREVIEW_PATH = 'assets/img/og-preview.jpg';
const DEPLOY_ONLY_SOCIAL_PREVIEW_PATHSPEC =
  `:(top,exclude)${DEPLOY_ONLY_SOCIAL_PREVIEW_PATH}`;
const REQUIRED_ROOT_ASSETS = Object.freeze([
  // The page a missing path answers with (GitHub Pages serves it with a 404
  // status); it is built from the shipped stylesheet and theme bootstrap.
  '404.html',
  // The in-app Cite dialog reads the citation from here at runtime, so a
  // server that serves a cached build must carry it too.
  'CITATION.cff',
  'browserconfig.xml',
  // The accessibility statement, linked from the app's footer.
  'accessibility.html',
  // Browsers ask for /favicon.ico on their own; every page links this one.
  'favicon.ico',
  'index.html',
  // The privacy policy the Google and Microsoft sign-in screens link to.
  'privacy.html',
  'site.webmanifest',
  // The terms of use, linked from the footer and from Google's and
  // Microsoft's app branding.
  'terms.html',
]);
const REQUIRED_ROOT_ASSET_SET = new Set(REQUIRED_ROOT_ASSETS);
const BUILD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WINDOWS_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/;
const MIME_BY_EXTENSION = Object.freeze({
  // What GitHub Pages serves a .cff file as; the cache must agree with the
  // origin it copies.
  '.cff': 'application/octet-stream',
  '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/vnd.microsoft.icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // A worker bundle's source map (what GitHub Pages serves one as).
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
});

export function assertPortableAssetPath(path) {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    !/^[A-Za-z0-9._/-]+$/.test(path)
  ) {
    throw new TypeError(`Invalid portable web asset path: ${String(path)}`);
  }

  const segments = path.split('/');
  for (const segment of segments) {
    const stem = segment.split('.', 1)[0].toUpperCase();
    if (
      segment.length === 0 ||
      segment === '.' ||
      segment === '..' ||
      segment.endsWith('.') ||
      segment.endsWith(' ') ||
      WINDOWS_DEVICE_NAME.test(stem)
    ) {
      throw new TypeError(`Invalid portable web asset path: ${path}`);
    }
  }
  return path;
}

export function contentTypeForAssetPath(path) {
  const exactPath = assertPortableAssetPath(path);
  if (basename(exactPath) === '.gitkeep') {
    return 'application/octet-stream';
  }
  const contentType = MIME_BY_EXTENSION[extname(exactPath).toLowerCase()];
  if (contentType === undefined) {
    throw new TypeError(
      `Unsupported web asset extension for "${exactPath}".`
    );
  }
  return contentType;
}

export function isRuntimeCacheAssetPath(path) {
  const exactPath = assertPortableAssetPath(path);
  return exactPath !== DEPLOY_ONLY_SOCIAL_PREVIEW_PATH;
}

function extractBuildId(indexBytes) {
  const indexHtml = indexBytes.toString('utf8');
  const matches = Array.from(indexHtml.matchAll(
    /<meta\s+name="cellucid-web-build-id"\s+content="([^"]+)"\s*\/?>/g
  ));
  if (matches.length !== 1) {
    throw new TypeError(
      'index.html must contain exactly one exact cellucid web build id meta tag.'
    );
  }
  const buildId = matches[0][1];
  if (!BUILD_ID_PATTERN.test(buildId)) {
    throw new TypeError('The cellucid web build id is not canonical.');
  }
  return buildId;
}

// The build id is `<date>.<digest>`: the digest names the exact shipped
// bytes, so the id changes whenever any asset does and never otherwise, and the
// date is the day it last changed. index.html carries the id itself, so its
// bytes are hashed with the id replaced by a fixed placeholder.
const BUILD_ID_META = /(<meta\s+name="cellucid-web-build-id"\s+content=")([^"]+)("\s*\/?>)/;
const BUILD_ID_DIGEST_LENGTH = 8;
export const STAMPED_BUILD_ID_PATTERN = /^\d{4}-\d{2}-\d{2}\.[0-9a-f]{8}$/;

function normalizeIndexForDigest(indexBytes) {
  const html = indexBytes.toString('utf8');
  if (!BUILD_ID_META.test(html)) {
    throw new TypeError('index.html must carry the cellucid web build id meta tag.');
  }
  return Buffer.from(html.replace(BUILD_ID_META, '$1BUILD$3'), 'utf8');
}

/**
 * The digest the build id names: SHA-256 over every inventoried path and its
 * bytes, index.html taken with its own id normalized away.
 */
export async function computeBuildDigest({ rootDir, paths }) {
  const exactRoot = resolve(rootDir);
  const hash = createHash('sha256');
  for (const path of [...new Set(paths)].sort()) {
    if (path === INVENTORY_FILENAME) continue;
    let bytes = await readFile(join(exactRoot, ...path.split('/')));
    if (path === 'index.html') bytes = normalizeIndexForDigest(bytes);
    hash.update(path).update('\0').update(createHash('sha256').update(bytes).digest('hex')).update('\n');
  }
  return hash.digest('hex').slice(0, BUILD_ID_DIGEST_LENGTH);
}

/**
 * Stamp index.html with the build id for the current bytes. The id is kept when
 * the digest it names still matches, so regenerating without a change is a
 * no-op; otherwise it gets today's UTC date and the new digest.
 */
export async function stampBuildId({ rootDir, paths, today = new Date() }) {
  const indexPath = join(resolve(rootDir), 'index.html');
  const html = (await readFile(indexPath)).toString('utf8');
  const current = html.match(BUILD_ID_META)?.[2];
  const digest = await computeBuildDigest({ rootDir, paths });
  if (current !== undefined && STAMPED_BUILD_ID_PATTERN.test(current) && current.endsWith(`.${digest}`)) {
    return current;
  }
  const buildId = `${today.toISOString().slice(0, 10)}.${digest}`;
  await writeFile(indexPath, html.replace(BUILD_ID_META, `$1${buildId}$3`));
  return buildId;
}

// Content-addressed script URLs. A host that caches by path (GitHub Pages
// answers every file with `max-age=600`; a static server's Last-Modified
// lets a browser guess a freshness of its own) can hand a page one module
// from the build before a deploy and the next from the build after it, and
// an import of an export the cached module does not have then stops the app
// before it starts. So every script under assets/ is requested at a URL that
// names its bytes: `<path>?v=<the first 12 hex digits of its SHA-256>`. Each
// shipped page carries one import map listing every such module (an ES import
// is resolved to a URL and then looked up in it, so relative imports are
// covered), the `src` of each script it names says the same, and its
// Content-Security-Policy allows exactly its inline scripts by hash. A file
// whose bytes did not change keeps its URL, so it stays cached across
// deploys. Workers get no import map (no engine has one for workers), so
// each worker is also built into one bundle named by its bytes
// (build-worker-bundles.mjs), written before everything else here.
const MODULE_VERSION_LENGTH = 12;
const SCRIPT_ELEMENT = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
const SCRIPT_SRC = /(\ssrc=")([^"?#]+)(?:\?v=[0-9a-f]*)?(")/;
const CSP_META = /(<meta http-equiv="Content-Security-Policy" content=")([^"]*)(")/;

function isScriptAssetPath(path) {
  return path.startsWith('assets/') && extname(path) === '.js';
}

function inlineScriptHash(text) {
  return `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
}

// A reference to a shipped file from the page at `pagePath`, written as the
// page writes it: root-absolute (`/assets/…`) or relative to the page's folder.
function resolvePageReference(pagePath, reference) {
  const pageDir = posix.dirname(pagePath);
  const resolved = reference.startsWith('/')
    ? reference.slice(1)
    : posix.normalize(posix.join(pageDir, reference));
  return resolved.startsWith('../') ? null : resolved;
}

function pageRelativeSpecifier(pagePath, assetPath) {
  const relativePath = posix.relative(posix.dirname(pagePath), assetPath);
  return relativePath.startsWith('../') ? relativePath : `./${relativePath}`;
}

/**
 * The import map of the page at `pagePath`: every script asset, keyed by its
 * page-relative URL and mapped to the same URL with its content version.
 * One entry per line, so a change to one file is a one-line diff.
 */
export function renderImportMap({ pagePath, versions }) {
  const entries = [...versions.keys()].filter(isScriptAssetPath).sort().map(path => {
    const specifier = pageRelativeSpecifier(pagePath, path);
    return `    ${JSON.stringify(specifier)}: ${JSON.stringify(`${specifier}?v=${versions.get(path)}`)}`;
  });
  return `\n  {\n  "imports": {\n${entries.join(',\n')}\n  }\n  }\n  `;
}

/**
 * The script elements of a page, found with its comments blanked out (a
 * comment may mention `<script …>` without being one), each with its offsets
 * in the page.
 */
function scriptElements(html) {
  const masked = html.replace(/<!--[\s\S]*?-->/g, comment => ' '.repeat(comment.length));
  return [...masked.matchAll(SCRIPT_ELEMENT)].map(match => ({
    start: match.index,
    end: match.index + match[0].length,
    attributes: match[1],
    text: html.slice(
      match.index + '<script'.length + match[1].length + '>'.length,
      match.index + match[0].length - '</script>'.length
    ),
  }));
}

const isModuleScript = element => /\stype="module"/.test(element.attributes);
const isImportMap = element => /\stype="importmap"/.test(element.attributes);

function stampScriptElement({ element, pagePath, versions }) {
  const { attributes, text } = element;
  if (isImportMap(element)) {
    return `<script${attributes}>${renderImportMap({ pagePath, versions })}</script>`;
  }
  const source = SCRIPT_SRC.exec(attributes);
  if (source === null || /^[a-z][a-z0-9+.-]*:/i.test(source[2]) || source[2].startsWith('//')) {
    return `<script${attributes}>${text}</script>`;
  }
  const assetPath = resolvePageReference(pagePath, source[2]);
  if (assetPath === null || !versions.has(assetPath)) {
    throw new TypeError(`${pagePath} names a script that is not a shipped asset: ${source[2]}`);
  }
  const versioned = attributes.replace(SCRIPT_SRC, `$1${source[2]}?v=${versions.get(assetPath)}$3`);
  return `<script${versioned}>${text}</script>`;
}

/**
 * The page with every content version current: the import map of a page
 * that runs ES modules, the `?v=` of each script it names, and the
 * `script-src` hashes of its inline scripts. A page that runs modules
 * declares its one `<script type="importmap">` itself, before its first
 * module script; the generator writes only what is inside it.
 */
export function stampPageScripts({ html, pagePath, versions }) {
  const elements = scriptElements(html);
  const firstModule = elements.findIndex(isModuleScript);
  const importMaps = elements.filter(isImportMap);
  if (firstModule !== -1 && importMaps.length !== 1) {
    throw new TypeError(`${pagePath} runs ES modules, so it must declare exactly one <script type="importmap">.`);
  }
  if (firstModule === -1 && importMaps.length !== 0) {
    throw new TypeError(`${pagePath} declares an import map but runs no ES module.`);
  }
  if (firstModule !== -1 && elements.indexOf(importMaps[0]) > firstModule) {
    throw new TypeError(`${pagePath} must declare its import map before its first module script.`);
  }

  let stamped = '';
  let offset = 0;
  for (const element of elements) {
    stamped += html.slice(offset, element.start) + stampScriptElement({ element, pagePath, versions });
    offset = element.end;
  }
  stamped += html.slice(offset);

  // The policy allows the page's inline scripts by hash, and only them.
  const policy = CSP_META.exec(stamped);
  if (policy === null) return stamped;
  const inlineHashes = scriptElements(stamped)
    .filter(element => !/\ssrc="/.test(element.attributes))
    .map(element => inlineScriptHash(element.text));
  const directives = policy[2].split(';');
  const scriptSrc = directives.findIndex(directive => /^\s*script-src\s/.test(directive));
  if (scriptSrc === -1) {
    if (inlineHashes.length === 0) return stamped;
    throw new TypeError(`${pagePath} has inline scripts but its Content-Security-Policy has no script-src to allow them.`);
  }
  const [, indent] = /^(\s*)/.exec(directives[scriptSrc]);
  const sources = directives[scriptSrc].trim().split(/\s+/).filter(source => !source.startsWith("'sha256-"));
  directives[scriptSrc] = `${indent}${[...sources, ...inlineHashes].join(' ')}`;
  return stamped.replace(CSP_META, (_, open, __, close) => `${open}${directives.join(';')}${close}`);
}

async function readContentVersions({ rootDir, paths }) {
  const exactRoot = resolve(rootDir);
  const versions = new Map();
  for (const path of paths) {
    const bytes = await readFile(join(exactRoot, ...path.split('/')));
    versions.set(path, createHash('sha256').update(bytes).digest('hex').slice(0, MODULE_VERSION_LENGTH));
  }
  return versions;
}

/**
 * The shipped pages whose script versions, import map or CSP hashes are not
 * current, each with the bytes it should have. Writing them is what the
 * generator does; `--check` refuses while any remains.
 */
export async function stalePageScripts({ rootDir, paths }) {
  const exactRoot = resolve(rootDir);
  const versions = await readContentVersions({ rootDir, paths: paths.filter(isScriptAssetPath) });
  const stale = [];
  for (const pagePath of [...paths].filter(path => extname(path) === '.html').sort()) {
    const absolutePath = join(exactRoot, ...pagePath.split('/'));
    const html = (await readFile(absolutePath)).toString('utf8');
    const stamped = stampPageScripts({ html, pagePath, versions });
    if (stamped !== html) stale.push({ pagePath, absolutePath, bytes: Buffer.from(stamped, 'utf8') });
  }
  return stale;
}

// The app is one page, so its sitemap lists one URL. Its <lastmod> is the
// date half of the build id: the day the shipped bytes last changed, which is
// when the page a crawler fetches last changed. The generator writes it beside
// the inventory, and --check refuses a sitemap that names another day. The
// reading pages (privacy, terms, accessibility) are reached by the home page's
// footer links and carry their own canonicals; they are not listed, because
// the build date is not the day they changed.
const SITEMAP_FILENAME = 'sitemap.xml';
export const SITE_URL = 'https://www.cellucid.com/';

// /.well-known/security.txt (RFC 9116): where to report a vulnerability. Its
// contact is the one SECURITY.md names, its policy is SECURITY.md as GitHub
// shows it. RFC 9116 requires an `Expires` less than a year ahead; it is the
// build date plus 365 days, written by the generator beside the sitemap, so
// every deploy renews it and --check refuses one that names another day. It is
// served from the site's origin only, so it is not in the runtime inventory.
const SECURITY_TXT_PATH = '.well-known/security.txt';
const SECURITY_CONTACT = 'mailto:k.inecik@gmail.com';
const SECURITY_POLICY_URL = 'https://github.com/theislab/cellucid/security/policy';
const SECURITY_TXT_LIFETIME_DAYS = 365;

export function renderSecurityTxt(buildId) {
  if (!STAMPED_BUILD_ID_PATTERN.test(buildId)) {
    throw new TypeError(`Cannot date security.txt from build id "${buildId}".`);
  }
  const built = new Date(`${buildId.slice(0, 10)}T00:00:00Z`);
  const expires = new Date(built.getTime() + SECURITY_TXT_LIFETIME_DAYS * 86_400_000);
  return Buffer.from(
    '# Report security problems in Cellucid (www.cellucid.com and its\n'
      + '# packages) privately to the contact below, as the policy describes.\n'
      + `Contact: ${SECURITY_CONTACT}\n`
      + `Expires: ${expires.toISOString().replace('.000Z', 'Z')}\n`
      + `Policy: ${SECURITY_POLICY_URL}\n`
      + 'Preferred-Languages: en\n'
      + `Canonical: ${SITE_URL}${SECURITY_TXT_PATH}\n`,
    'utf8'
  );
}

export function renderSitemap(buildId) {
  if (!STAMPED_BUILD_ID_PATTERN.test(buildId)) {
    throw new TypeError(`Cannot date the sitemap from build id "${buildId}".`);
  }
  const lastmod = buildId.slice(0, 10);
  return Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
      + '  <url>\n'
      + `    <loc>${SITE_URL}</loc>\n`
      + `    <lastmod>${lastmod}</lastmod>\n`
      + '  </url>\n'
      + '</urlset>\n',
    'utf8'
  );
}

export async function buildWebAssetInventory({ rootDir, paths }) {
  if (typeof rootDir !== 'string' || rootDir.length === 0) {
    throw new TypeError('Web inventory rootDir must be a non-empty string.');
  }
  if (!Array.isArray(paths)) {
    throw new TypeError('Web inventory paths must be an array.');
  }

  const uniquePaths = new Set();
  for (const candidate of paths) {
    const path = assertPortableAssetPath(candidate);
    if (!isRuntimeCacheAssetPath(path)) {
      throw new TypeError(
        `Deploy-only social preview must not enter the runtime cache inventory: ${path}`
      );
    }
    if (path === INVENTORY_FILENAME) {
      throw new TypeError('The web asset inventory must not list itself.');
    }
    if (!REQUIRED_ROOT_ASSET_SET.has(path) && !path.startsWith('assets/')) {
      throw new TypeError(
        `Web inventory path is outside the exact source roots: ${path}`
      );
    }
    if (uniquePaths.has(path)) {
      throw new TypeError(`Duplicate web inventory path: ${path}`);
    }
    uniquePaths.add(path);
  }
  for (const path of REQUIRED_ROOT_ASSETS) {
    if (!uniquePaths.has(path)) {
      throw new TypeError(`The web asset inventory requires ${path}.`);
    }
  }

  const exactRoot = resolve(rootDir);
  const assets = [];
  let indexBytes = null;
  for (const path of [...uniquePaths].sort()) {
    const absolutePath = join(exactRoot, ...path.split('/'));
    const stat = await lstat(absolutePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new TypeError(`Web inventory asset must be a regular file: ${path}`);
    }
    const bytes = await readFile(absolutePath);
    if (path === 'index.html') {
      indexBytes = bytes;
    }
    assets.push({
      path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      content_type: contentTypeForAssetPath(path),
    });
  }

  return {
    version: 1,
    build_id: extractBuildId(indexBytes),
    assets,
  };
}

export function serializeWebAssetInventory(inventory) {
  if (
    inventory === null ||
    typeof inventory !== 'object' ||
    Array.isArray(inventory)
  ) {
    throw new TypeError('Web asset inventory must be an object.');
  }
  return Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
}

export async function listSourceControlledAssets(
  rootDir,
  executeGit = execFileAsync
) {
  if (typeof executeGit !== 'function') {
    throw new TypeError('Web inventory Git executor must be a function.');
  }
  const options = {
    encoding: 'buffer',
    maxBuffer: 16 * 1024 * 1024,
  };
  const [{ stdout }, { stdout: deletedStdout }] = await Promise.all([
    executeGit(
      'git',
      [
        '-C',
        rootDir,
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
        '--',
        ...REQUIRED_ROOT_ASSETS,
        'assets',
        DEPLOY_ONLY_SOCIAL_PREVIEW_PATHSPEC,
      ],
      options
    ),
    executeGit(
      'git',
      [
        '-C',
        rootDir,
        'ls-files',
        '-z',
        '--deleted',
        '--',
        ...REQUIRED_ROOT_ASSETS,
        'assets',
        DEPLOY_ONLY_SOCIAL_PREVIEW_PATHSPEC,
      ],
      options
    ),
  ]);
  const deletedPaths = new Set(
    deletedStdout
      .toString('utf8')
      .split('\0')
      .filter(path => path.length > 0)
  );
  return stdout
    .toString('utf8')
    .split('\0')
    .filter(
      path =>
        path.length > 0 &&
        !deletedPaths.has(path) &&
        isRuntimeCacheAssetPath(path)
    );
}

async function writeInventoryAtomically(outputPath, bytes) {
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  let temporaryExists = false;
  try {
    await writeFile(temporaryPath, bytes, { flag: 'wx' });
    temporaryExists = true;
    await rename(temporaryPath, outputPath);
    temporaryExists = false;
  } catch (error) {
    if (temporaryExists) {
      try {
        await unlink(temporaryPath);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Web inventory generation and cleanup both failed for ${outputPath}.`
        );
      }
    }
    throw error;
  }
}

async function runCli() {
  const rootDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const args = process.argv.slice(2);
  // The worker bundles come first: they are shipped files, so the inventory,
  // the import map and the build id are taken over them.
  const workers = await buildWorkerBundles({ rootDir });
  if (args.length === 0) {
    await writeWorkerBundles({ rootDir, built: workers, write: writeInventoryAtomically });
  }
  const paths = await listSourceControlledAssets(rootDir);
  const stalePages = await stalePageScripts({ rootDir, paths });
  if (args.length === 0) {
    for (const { absolutePath, bytes } of stalePages) {
      await writeInventoryAtomically(absolutePath, bytes);
    }
    await stampBuildId({ rootDir, paths });
  }
  const inventory = await buildWebAssetInventory({ rootDir, paths });
  const bytes = serializeWebAssetInventory(inventory);
  const outputPath = join(rootDir, INVENTORY_FILENAME);
  const sitemapBytes = renderSitemap(inventory.build_id);
  const sitemapPath = join(rootDir, SITEMAP_FILENAME);
  const securityTxtBytes = renderSecurityTxt(inventory.build_id);
  const securityTxtPath = join(rootDir, ...SECURITY_TXT_PATH.split('/'));

  if (args.length === 1 && args[0] === '--check') {
    const staleWorkers = await staleWorkerFiles({ rootDir, built: workers });
    if (staleWorkers.length !== 0) {
      throw new Error(
        `${staleWorkers.join(', ')} ${staleWorkers.length === 1 ? 'is' : 'are'} not what the `
          + 'worker sources build.'
      );
    }
    if (stalePages.length !== 0) {
      throw new Error(
        `${stalePages.map(page => page.pagePath).join(', ')} name script versions `
          + 'that are not the current bytes.'
      );
    }
    const current = await readFile(outputPath);
    if (!current.equals(bytes)) {
      throw new Error(
        `${INVENTORY_FILENAME} does not match the exact current web source.`
      );
    }
    if (!(await readFile(sitemapPath)).equals(sitemapBytes)) {
      throw new Error(
        `${SITEMAP_FILENAME} does not carry the current build date.`
      );
    }
    if (!(await readFile(securityTxtPath)).equals(securityTxtBytes)) {
      throw new Error(
        `${SECURITY_TXT_PATH} does not expire a year after the current build date.`
      );
    }
    return;
  }
  if (args.length !== 0) {
    throw new TypeError(
      'Usage: node scripts/generate-web-asset-inventory.mjs [--check]'
    );
  }
  await writeInventoryAtomically(outputPath, bytes);
  await writeInventoryAtomically(sitemapPath, sitemapBytes);
  await writeInventoryAtomically(securityTxtPath, securityTxtBytes);
}

export async function isDirectModuleInvocation({
  argvPath,
  moduleUrl,
}) {
  if (argvPath === undefined) {
    return false;
  }
  const [invokedPath, modulePath] = await Promise.all([
    realpath(argvPath),
    realpath(fileURLToPath(moduleUrl)),
  ]);
  return invokedPath === modulePath;
}

if (await isDirectModuleInvocation({
  argvPath: process.argv[1],
  moduleUrl: import.meta.url,
})) {
  await runCli();
}
