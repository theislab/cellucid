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
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

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
  'index.html',
  'site.webmanifest',
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

// The site is one page, so its sitemap lists one URL. Its <lastmod> is the
// date half of the build id: the day the shipped bytes last changed, which is
// when the page a crawler fetches last changed. The generator writes it beside
// the inventory, and --check refuses a sitemap that names another day.
const SITEMAP_FILENAME = 'sitemap.xml';
export const SITE_URL = 'https://www.cellucid.com/';

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
  const paths = await listSourceControlledAssets(rootDir);
  const args = process.argv.slice(2);
  if (args.length === 0) await stampBuildId({ rootDir, paths });
  const inventory = await buildWebAssetInventory({ rootDir, paths });
  const bytes = serializeWebAssetInventory(inventory);
  const outputPath = join(rootDir, INVENTORY_FILENAME);
  const sitemapBytes = renderSitemap(inventory.build_id);
  const sitemapPath = join(rootDir, SITEMAP_FILENAME);

  if (args.length === 1 && args[0] === '--check') {
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
    return;
  }
  if (args.length !== 0) {
    throw new TypeError(
      'Usage: node scripts/generate-web-asset-inventory.mjs [--check]'
    );
  }
  await writeInventoryAtomically(outputPath, bytes);
  await writeInventoryAtomically(sitemapPath, sitemapBytes);
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
