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
  BUNDLE_FILE,
  WORKERS_DIR,
  WORKER_SCRIPTS_PATH,
  buildWorkerBundles,
  staleWorkerFiles,
  writeWorkerBundles,
} from './build-worker-bundles.mjs';
import {
  PAGE_BUNDLE_FILE,
  PAGE_DIR,
  PAGE_ENTRY,
  buildPageBundle,
  stalePageFiles,
  writePageBundle,
} from './build-page-bundle.mjs';
import { THIS_MACHINE_HOSTS } from '../assets/js/workers/worker-script.js';

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
  // The code cache a deployed page registers (index.html,
  // CELLUCID_PAGE_BOOT). A service worker controls only the pages below its
  // own folder, so it lives at the root.
  'service-worker.js',
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
  // The licences shipped beside third-party files (assets/wasm/LICENSES/,
  // assets/external/).
  '.txt': 'text/plain; charset=utf-8',
  // The WebAssembly decoders: what WebAssembly.compileStreaming requires.
  '.wasm': 'application/wasm',
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

// Content-addressed URLs. A host that caches by path (GitHub Pages answers
// every file with `max-age=600`; a static server's Last-Modified lets a
// browser guess a freshness of its own) can hand a page one module from the
// build before a deploy and the next from the build after it, and an import
// of an export the cached module does not have then stops the app before it
// starts. So every script and stylesheet under assets/ is requested at a URL
// that names its bytes: `<path>?v=<the first 12 hex digits of its SHA-256>`.
// Each shipped page carries one import map listing every such module (an ES
// import is resolved to a URL and then looked up in it, so relative imports
// are covered), the `src` of each script it names says the same, and its
// Content-Security-Policy allows exactly its inline scripts by hash.
// Stylesheets name what they `@import` and the files they use (`url()`) the
// same way, written into assets/css/ by this generator; a stylesheet's version
// is that of its stamped bytes, so a change to a partial changes the URL of
// every stylesheet above it. A page names its stylesheet and the files it
// preloads at their versions, and preloads every stylesheet its stylesheet
// imports, directly or not, so all of them are asked for at once rather than
// one `@import` level per round trip. A file whose bytes did not change keeps
// its URL, so it stays cached across deploys. A file whose name already names
// its bytes (a worker or page bundle) needs no `?v=` and is not in the import
// map. Workers get no import map (no engine has one for workers), so each
// worker is also built into one bundle named by its bytes
// (build-worker-bundles.mjs), written before everything else here; the page's
// own graph is built into the page bundle (build-page-bundle.mjs) that a
// deployed page runs (`renderPageBoot`).
const MODULE_VERSION_LENGTH = 12;
const SCRIPT_ELEMENT = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
const SCRIPT_SRC = /(\ssrc=")([^"?#]+)(?:\?v=[0-9a-f]*)?(")/;
const CSP_META = /(<meta http-equiv="Content-Security-Policy" content=")([^"]*)(")/;
// A stylesheet link, a preload of a shipped file, and a generated stylesheet
// preload, as the shipped pages write them.
const STYLESHEET_LINK = /^([ \t]*)<link rel="stylesheet" href="([^"?#]+)(?:\?v=[0-9a-f]*)?" \/>$/gm;
const PRELOAD_HREF = /(<link rel="preload" href=")([^"?#]+)(?:\?v=[0-9a-f]*)?(")/g;
const STYLE_PRELOAD_LINE = /^[ \t]*<link rel="preload" as="style" href="[^"]*" \/>\n/gm;
// The `@import` and `url()` references of a stylesheet.
const CSS_IMPORT = /(@import\s+)(['"])([^'"?#]+)(?:\?v=[0-9a-f]*)?\2/g;
const CSS_URL = /(url\(\s*)(['"]?)([^'")?#\s]+)(?:\?v=[0-9a-f]*)?\2(\s*\))/g;
/** The id of the page's boot script, whose text the generator writes (`renderPageBoot`). */
export const PAGE_BOOT_ID = 'cellucid-page-boot';

function isScriptAssetPath(path) {
  return path.startsWith('assets/') && extname(path) === '.js';
}

function isStylesheetAssetPath(path) {
  return path.startsWith('assets/') && extname(path) === '.css';
}

/** Whether a shipped file's name already names its bytes: a worker or page bundle. */
export function namesItsBytes(path) {
  const folder = posix.dirname(path);
  const name = posix.basename(path);
  return (folder === WORKERS_DIR && BUNDLE_FILE.test(name))
    || (folder === PAGE_DIR && PAGE_BUNDLE_FILE.test(name));
}

function versionOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, MODULE_VERSION_LENGTH);
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

const isExternalReference = reference =>
  /^[a-z][a-z0-9+.-]*:/i.test(reference) || reference.startsWith('//') || reference.startsWith('#');

/** Every match of `pattern` in `text` outside its `/* … *\/` comments. */
function referencesOutsideComments(text, pattern, commentPattern) {
  const masked = text.replace(commentPattern, comment => ' '.repeat(comment.length));
  return [...masked.matchAll(pattern)].map(match => ({ index: match.index, length: match[0].length }));
}

function replaceReferences(text, pattern, commentPattern, replace) {
  let result = '';
  let offset = 0;
  for (const { index, length } of referencesOutsideComments(text, pattern, commentPattern)) {
    const original = text.slice(index, index + length);
    pattern.lastIndex = 0;
    result += text.slice(offset, index) + original.replace(new RegExp(pattern.source), replace);
    offset = index + length;
  }
  return result + text.slice(offset);
}

const CSS_COMMENT = /\/\*[\s\S]*?\*\//g;

/** The stylesheets `cssText` (at `cssPath`) imports, as shipped paths, in order. */
function stylesheetImports(cssPath, cssText) {
  const masked = cssText.replace(CSS_COMMENT, comment => ' '.repeat(comment.length));
  return [...masked.matchAll(CSS_IMPORT)].map(match => posix.normalize(posix.join(posix.dirname(cssPath), match[3])));
}

/**
 * Every shipped stylesheet with its references stamped: each `@import` and
 * `url()` of a shipped file carries `?v=` and that file's version, a
 * stylesheet's version being that of its own stamped bytes.
 *
 * @param {{ rootDir: string, paths: string[] }} options
 * @returns {Promise<Map<string, string>>} stamped text by path
 */
export async function stampedStylesheets({ rootDir, paths }) {
  const exactRoot = resolve(rootDir);
  const shipped = new Set(paths);
  const sources = new Map();
  for (const path of paths.filter(isStylesheetAssetPath)) {
    sources.set(path, await readFile(join(exactRoot, ...path.split('/')), 'utf8'));
  }
  const fileVersions = new Map();
  const stamped = new Map();
  const visiting = new Set();
  const versionOfFile = async target => {
    if (isStylesheetAssetPath(target)) return versionOf(Buffer.from(await stamp(target), 'utf8'));
    if (!fileVersions.has(target)) {
      fileVersions.set(target, versionOf(await readFile(join(exactRoot, ...target.split('/')))));
    }
    return fileVersions.get(target);
  };
  async function stamp(path) {
    if (stamped.has(path)) return stamped.get(path);
    if (visiting.has(path)) throw new TypeError(`${path} imports itself through its @imports.`);
    visiting.add(path);
    const text = sources.get(path);
    const targets = new Map();
    for (const pattern of [CSS_IMPORT, CSS_URL]) {
      const masked = text.replace(CSS_COMMENT, comment => ' '.repeat(comment.length));
      for (const match of masked.matchAll(pattern)) {
        const reference = match[3];
        if (isExternalReference(reference) || reference.startsWith('data:')) continue;
        const target = posix.normalize(posix.join(posix.dirname(path), reference));
        if (target.startsWith('../') || !shipped.has(target)) {
          throw new TypeError(`${path} names a file that is not a shipped asset: ${reference}`);
        }
        targets.set(reference, await versionOfFile(target));
      }
    }
    const withVersion = (prefix, quote, reference, suffix = '') =>
      targets.has(reference)
        ? `${prefix}${quote}${reference}?v=${targets.get(reference)}${quote}${suffix}`
        : `${prefix}${quote}${reference}${quote}${suffix}`;
    let result = replaceReferences(text, CSS_IMPORT, CSS_COMMENT, (_, prefix, quote, reference) =>
      withVersion(prefix, quote, reference));
    result = replaceReferences(result, CSS_URL, CSS_COMMENT, (_, prefix, quote, reference, close) =>
      withVersion(prefix, quote, reference, close));
    visiting.delete(path);
    stamped.set(path, result);
    return result;
  }
  for (const path of sources.keys()) await stamp(path);
  return stamped;
}

/**
 * The shipped stylesheets whose stamped references are not current, each with
 * the bytes it should have.
 */
export async function staleStylesheets({ rootDir, stylesheets }) {
  const exactRoot = resolve(rootDir);
  const stale = [];
  for (const [path, text] of [...stylesheets].sort(([a], [b]) => a.localeCompare(b))) {
    const absolutePath = join(exactRoot, ...path.split('/'));
    const bytes = Buffer.from(text, 'utf8');
    if (!(await readFile(absolutePath)).equals(bytes)) stale.push({ path, absolutePath, bytes });
  }
  return stale;
}

/**
 * The import map of the page at `pagePath`: every script asset whose name
 * does not already name its bytes, keyed by its page-relative URL and mapped
 * to the same URL with its content version. One entry per line, so a change
 * to one file is a one-line diff.
 */
export function renderImportMap({ pagePath, versions }) {
  const entries = [...versions.keys()]
    .filter(path => isScriptAssetPath(path) && !namesItsBytes(path))
    .sort()
    .map(path => {
      const specifier = pageRelativeSpecifier(pagePath, path);
      return `    ${JSON.stringify(specifier)}: ${JSON.stringify(`${specifier}?v=${versions.get(path)}`)}`;
    });
  return `\n  {\n  "imports": {\n${entries.join(',\n')}\n  }\n  }\n  `;
}

/**
 * The text of the page's boot script (`<script id="cellucid-page-boot">`):
 * where the page's code starts, and when.
 *
 * On this machine (`THIS_MACHINE_HOSTS`, the rule workers follow too:
 * `assets/js/workers/worker-script.js`) the page runs its sources,
 * `assets/js/app/main.js` through the import map, so an edited module is
 * live on the next reload with nothing built. Anywhere else it runs the page
 * bundle: the entry and every chunk it imports at startup are preloaded at
 * once, from the head, while the rest of the document arrives. Either way the
 * entry is imported once the document is parsed (its code reads the page's
 * elements as it starts), and a failure to load, link or run it is handed to
 * the code-load watch (`ui/core/code-load-watch.js`) as a
 * `cellucid-code-load-failed` event.
 *
 * @param {{ entry: string, preload: string[] }} page the page bundle's entry and startup chunks
 */
export function renderPageBoot({ entry, preload }) {
  const list = paths => paths.map(path => `\n      ${JSON.stringify(path)}`).join(',');
  return `
    // Written by scripts/generate-web-asset-inventory.mjs (renderPageBoot):
    // sources on this machine, the page bundle (assets/page/) anywhere else.
    (() => {
      const thisMachine = ${JSON.stringify(THIS_MACHINE_HOSTS)}.includes(location.hostname);
      const bundle = [${list([entry, ...preload])}
      ];
      const entry = new URL(thisMachine ? ${JSON.stringify(PAGE_ENTRY)} : bundle[0], document.baseURI).href;
      if (!thisMachine) {
        for (const path of bundle) {
          const link = document.createElement('link');
          link.rel = 'modulepreload';
          link.href = path;
          document.head.append(link);
        }
        // The code cache (service-worker.js), once the page has loaded: a
        // later visit takes every file whose address names its bytes from
        // this browser. It is told which files this visit loaded, so the next
        // one already finds them.
        if ('serviceWorker' in navigator) {
          window.addEventListener('load', () => {
            const build = document.querySelector('meta[name="cellucid-web-build-id"]')?.content ?? '';
            navigator.serviceWorker.register(\`service-worker.js?build=\${encodeURIComponent(build)}\`)
              .then(() => navigator.serviceWorker.ready)
              .then(registration => registration.active?.postMessage({
                keep: performance.getEntriesByType('resource').map(entry => entry.name),
              }))
              .catch(() => {});
          }, { once: true });
        }
      }
      // The document is parsed only once its stylesheet is in (CELLUCID_STYLE_GATE,
      // after the stylesheet link), so the code starts in a styled page. A
      // stylesheet that did not load is reported like a file of the code that
      // did not: nothing of the app can be shown without it.
      const start = () => {
        if (document.documentElement.dataset.styleLoadFailed === 'true') {
          const stylesheet = document.querySelector('link[rel="stylesheet"]').href;
          window.dispatchEvent(new CustomEvent('cellucid-code-load-failed', { detail: { entry: stylesheet, stylesheet: true } }));
          return;
        }
        import(entry).catch(error => {
          window.dispatchEvent(new CustomEvent('cellucid-code-load-failed', { detail: { entry, error } }));
        });
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
      else start();
    })();
  `;
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
const isPageBoot = element => element.attributes.includes(` id="${PAGE_BOOT_ID}"`);

function stampScriptElement({ element, pagePath, versions, page }) {
  const { attributes, text } = element;
  if (isImportMap(element)) {
    return `<script${attributes}>${renderImportMap({ pagePath, versions })}</script>`;
  }
  if (isPageBoot(element)) {
    if (page === null || page === undefined) {
      throw new TypeError(`${pagePath} has a boot script, so it needs the page bundle's entry and chunks.`);
    }
    return `<script${attributes}>${renderPageBoot(page)}</script>`;
  }
  const source = SCRIPT_SRC.exec(attributes);
  if (source === null || isExternalReference(source[2])) {
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
 * The page's stylesheet links at their versions, each led by a preload of
 * every stylesheet it imports (directly or not, in the order they are met),
 * and its file preloads at their versions.
 */
function stampPageStyles({ html, pagePath, versions, stylesheets }) {
  const reference = (written, assetPath) => {
    const href = written.startsWith('/') ? `/${assetPath}` : posix.relative(posix.dirname(pagePath), assetPath);
    return `${href}?v=${versions.get(assetPath)}`;
  };
  const closure = (path, seen = new Set()) => {
    for (const imported of stylesheetImports(path, stylesheets.get(path) ?? '')) {
      if (seen.has(imported)) continue;
      seen.add(imported);
      closure(imported, seen);
    }
    return seen;
  };
  let stamped = html.replace(STYLE_PRELOAD_LINE, '');
  stamped = stamped.replace(STYLESHEET_LINK, (_, indent, href) => {
    const assetPath = resolvePageReference(pagePath, href);
    if (assetPath === null || !versions.has(assetPath) || !stylesheets.has(assetPath)) {
      throw new TypeError(`${pagePath} names a stylesheet that is not a shipped asset: ${href}`);
    }
    const preloads = [...closure(assetPath)].map(path =>
      `${indent}<link rel="preload" as="style" href="${reference(href, path)}" />\n`);
    return `${preloads.join('')}${indent}<link rel="stylesheet" href="${reference(href, assetPath)}" />`;
  });
  return stamped.replace(PRELOAD_HREF, (match, open, href, close) => {
    if (isExternalReference(href)) return match;
    const assetPath = resolvePageReference(pagePath, href);
    if (assetPath === null || !versions.has(assetPath)) {
      throw new TypeError(`${pagePath} preloads a file that is not a shipped asset: ${href}`);
    }
    return `${open}${href}?v=${versions.get(assetPath)}${close}`;
  });
}

/**
 * The page with every content version current: the import map and the boot
 * script of a page that runs ES modules, the `?v=` of each script it names,
 * its stylesheet links and their preloads, and the `script-src` hashes of
 * its inline scripts. A page that runs modules declares its one
 * `<script type="importmap">` itself, before its first module or boot
 * script; the generator writes only what is inside it.
 *
 * @param {{ html: string, pagePath: string, versions: Map<string, string>,
 *   stylesheets?: Map<string, string>, page?: { entry: string, preload: string[] } }} options
 *   `stylesheets`: the stamped stylesheets (`stampedStylesheets`); `page`:
 *   the page bundle's entry and startup chunks, for a page with a boot script
 */
export function stampPage({ html, pagePath, versions, stylesheets = new Map(), page = null }) {
  const elements = scriptElements(html);
  const firstModule = elements.findIndex(element => isModuleScript(element) || isPageBoot(element));
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
    stamped += html.slice(offset, element.start) + stampScriptElement({ element, pagePath, versions, page });
    offset = element.end;
  }
  stamped += html.slice(offset);
  stamped = stampPageStyles({ html: stamped, pagePath, versions, stylesheets });

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

/**
 * The content version of every shipped file, a stylesheet's taken over its
 * stamped bytes.
 */
async function readContentVersions({ rootDir, paths, stylesheets }) {
  const exactRoot = resolve(rootDir);
  const versions = new Map();
  for (const path of paths) {
    const bytes = stylesheets.has(path)
      ? Buffer.from(stylesheets.get(path), 'utf8')
      : await readFile(join(exactRoot, ...path.split('/')));
    versions.set(path, versionOf(bytes));
  }
  return versions;
}

/**
 * The shipped pages whose script versions, import map, boot script,
 * stylesheet links or CSP hashes are not current, each with the bytes it
 * should have. Writing them is what the generator does; `--check` refuses
 * while any remains.
 *
 * @param {{ rootDir: string, paths: string[], stylesheets: Map<string, string>,
 *   page: { entry: string, preload: string[] } }} options
 */
export async function stalePages({ rootDir, paths, stylesheets, page }) {
  const exactRoot = resolve(rootDir);
  const versions = await readContentVersions({
    rootDir,
    paths: paths.filter(path => path.startsWith('assets/')),
    stylesheets,
  });
  const stale = [];
  for (const pagePath of [...paths].filter(path => extname(path) === '.html').sort()) {
    const absolutePath = join(exactRoot, ...pagePath.split('/'));
    const html = (await readFile(absolutePath)).toString('utf8');
    const stamped = stampPage({ html, pagePath, versions, stylesheets, page });
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
const SECURITY_CONTACT = 'mailto:hello@cellucid.com';
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
  // Then the page bundle, which imports the worker scripts at their version.
  const page = await buildPageBundle({
    rootDir,
    externalBytes: new Map([[WORKER_SCRIPTS_PATH, workers.files.get(WORKER_SCRIPTS_PATH)]]),
  });
  if (args.length === 0) {
    await writePageBundle({ rootDir, built: page, write: writeInventoryAtomically });
  }
  const paths = await listSourceControlledAssets(rootDir);
  // Then the stylesheets' references, and the pages, which name the
  // stylesheets at their stamped bytes.
  const stylesheets = await stampedStylesheets({ rootDir, paths });
  const staleStyles = await staleStylesheets({ rootDir, stylesheets });
  const pages = await stalePages({ rootDir, paths, stylesheets, page });
  if (args.length === 0) {
    for (const { absolutePath, bytes } of [...staleStyles, ...pages]) {
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
    const stalePage = await stalePageFiles({ rootDir, built: page });
    if (stalePage.length !== 0) {
      throw new Error(
        `${stalePage.join(', ')} ${stalePage.length === 1 ? 'is' : 'are'} not what the `
          + 'page sources build.'
      );
    }
    if (staleStyles.length !== 0) {
      throw new Error(
        `${staleStyles.map(style => style.path).join(', ')} name files at versions `
          + 'that are not their current bytes.'
      );
    }
    if (pages.length !== 0) {
      throw new Error(
        `${pages.map(stale => stale.pagePath).join(', ')} name script or stylesheet versions `
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
