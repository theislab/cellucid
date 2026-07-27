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
const REQUIRED_ROOT_ASSETS = Object.freeze([
  'browserconfig.xml',
  'index.html',
  'site.webmanifest',
]);
const REQUIRED_ROOT_ASSET_SET = new Set(REQUIRED_ROOT_ASSETS);
const BUILD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WINDOWS_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/;
const MIME_BY_EXTENSION = Object.freeze({
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

export async function listSourceControlledAssets(rootDir) {
  const options = {
    encoding: 'buffer',
    maxBuffer: 16 * 1024 * 1024,
  };
  const [{ stdout }, { stdout: deletedStdout }] = await Promise.all([
    execFileAsync(
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
      ],
      options
    ),
    execFileAsync(
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
    .filter(path => path.length > 0 && !deletedPaths.has(path));
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
  const inventory = await buildWebAssetInventory({ rootDir, paths });
  const bytes = serializeWebAssetInventory(inventory);
  const outputPath = join(rootDir, INVENTORY_FILENAME);
  const args = process.argv.slice(2);

  if (args.length === 1 && args[0] === '--check') {
    const current = await readFile(outputPath);
    if (!current.equals(bytes)) {
      throw new Error(
        `${INVENTORY_FILENAME} does not match the exact current web source.`
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
