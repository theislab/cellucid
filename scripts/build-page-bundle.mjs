// The page bundle: the app's module graph (`assets/js/app/main.js` and every
// module it imports, statically or on demand) built into a few files for a
// deployed site.
//
// A page served from this machine runs its sources, as they are on disk: the
// import map in index.html names each module's bytes (`?v=`), and nothing is
// built while developing. A deployed site asked for those sources would need
// one request per module, found in waves (the browser discovers a module's
// imports only once it has it: 588 modules, seven waves deep, in October
// 2026), with every comment shipped. So the generator also builds the graph
// with esbuild (pinned in package.json) into `assets/page/`: minified, with
// the parts the app imports on demand (`import()`) left in chunks of their
// own, every file named by its content (`<name>.<esbuild content hash>.js`;
// a change to a file's bytes changes its name, so a file at a name is never
// replaced and a cache may keep it for good). index.html names the entry and
// the chunks it imports at startup (`renderPageBoot`), so a deployed page
// asks for all of them at once while the document is still arriving.
//
// What is the same in both: the code. esbuild keeps the modules' evaluation
// order and, with `keepNames`, every function and class name a message
// prints. What a bundle cannot hold is a module that names a file by its own
// address (`import.meta`): in a bundle that is the bundle's address. Those
// modules are left out of it and loaded at their own versioned URL
// (`PAGE_EXTERNALS`); `--check` refuses a bundled module that reads
// `import.meta`.
//
// `generate-web-asset-inventory.mjs` builds the bundle with every run, after
// the worker bundles (the bundle imports `assets/workers/scripts.js` at its
// version), and writes it to `assets/page/`, a folder of nothing but what this
// writes, outside the sources under `assets/js/`. `--check` refuses a tree
// whose bundle is not exactly what the sources build.

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';

import { SHIPPED_MODULE_ROOTS, WORKER_SCRIPTS_PATH } from './build-worker-bundles.mjs';

export const PAGE_DIR = 'assets/page';
export const PAGE_ENTRY = 'assets/js/app/main.js';
/** A file of the page bundle: `<name>.<esbuild content hash>.js`, or its source map. */
export const PAGE_BUNDLE_FILE = /^([a-z0-9-]+)\.([A-Z2-7]{8})\.js(\.map)?$/;

/**
 * Modules the page imports at their own address, never from the bundle:
 * each reads `import.meta`, which in a bundle would name the bundle.
 *
 * - `assets/workers/scripts.js` names every worker's source and bundle
 *   relative to itself (`build-worker-bundles.mjs`).
 * - `assets/js/workers/worker-script.js` holds the listeners of worker start
 *   failures; `scripts.js` imports it, so the page shares that one instance.
 * - `assets/js/utils/listener-set.js`, which `worker-script.js` imports (its
 *   failure listeners are a listener set).
 * - `assets/js/app/asset-url.js` resolves a shipped file through the page's
 *   import map (`import.meta.resolve`).
 *
 * An external imports nothing but other externals (`externalImports`; the
 * build refuses one that does): a module it imported from the sources would
 * be asked for by a deployed page beside its copy in the bundle, a second
 * instance (round 9: `worker-script.js` came to import `listener-set.js`).
 */
export const PAGE_EXTERNALS = Object.freeze([
  WORKER_SCRIPTS_PATH,
  'assets/js/workers/worker-script.js',
  'assets/js/utils/listener-set.js',
  'assets/js/app/asset-url.js',
]);

const MODULE_VERSION_LENGTH = 12;

function versionOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, MODULE_VERSION_LENGTH);
}

/** The import of an external module from a bundle file in PAGE_DIR, at its version. */
function externalSpecifier(path, version) {
  return `${posix.relative(PAGE_DIR, path)}?v=${version}`;
}

/**
 * Build the page bundle.
 *
 * @param {{ rootDir: string, externalBytes?: Map<string, Buffer> }} options
 *   `externalBytes`: the bytes of external modules not yet on disk (the
 *   worker builder's `scripts.js` of this run); the rest are read from disk.
 * @returns {Promise<{ files: Map<string, Buffer>, entry: string, preload: string[], inputs: string[] }>}
 *   `entry`: the entry file; `preload`: every file the entry imports at
 *   startup, directly or through another (not the chunks loaded on demand).
 */
export async function buildPageBundle({ rootDir, externalBytes = new Map() }) {
  const esbuild = await import('esbuild');
  const exactRoot = resolve(rootDir);
  const externals = new Map();
  for (const path of PAGE_EXTERNALS) {
    const bytes = externalBytes.get(path) ?? await readFile(join(exactRoot, ...path.split('/')));
    externals.set(resolve(exactRoot, ...path.split('/')), externalSpecifier(path, versionOf(bytes)));
    for (const imported of externalImports(path, bytes.toString('utf8'))) {
      if (!PAGE_EXTERNALS.includes(imported)) {
        throw new Error(
          `${path} is imported at its own address (PAGE_EXTERNALS) and imports ${imported}, `
            + 'which a deployed page would then ask for from the sources beside its copy in the bundle: '
            + 'an external imports only other externals (add it to PAGE_EXTERNALS, or import nothing).'
        );
      }
    }
  }
  const result = await esbuild.build({
    absWorkingDir: exactRoot,
    entryPoints: [PAGE_ENTRY],
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    // No target: the code ships in the syntax it is written in.
    minify: true,
    keepNames: true,
    charset: 'utf8',
    sourcemap: 'external',
    sourcesContent: false,
    outdir: PAGE_DIR,
    entryNames: '[name].[hash]',
    chunkNames: '[name].[hash]',
    write: false,
    metafile: true,
    logLevel: 'silent',
    plugins: [{
      name: 'cellucid-page-externals',
      setup(build) {
        build.onResolve({ filter: /\.js$/ }, args => {
          if (args.kind === 'entry-point') return undefined;
          const path = resolve(args.resolveDir, args.path);
          return externals.has(path) ? { path: externals.get(path), external: true } : undefined;
        });
      },
    }],
  });
  if (result.warnings.length > 0 || result.errors.length > 0) {
    const messages = await esbuild.formatMessages(
      [...result.errors, ...result.warnings],
      { kind: 'warning' }
    );
    throw new Error(`Bundling ${PAGE_ENTRY} reported:\n${messages.join('\n')}`);
  }
  const inputs = Object.keys(result.metafile.inputs).sort();
  for (const input of inputs) {
    if (!SHIPPED_MODULE_ROOTS.some(root => input.startsWith(root))) {
      throw new Error(`${PAGE_ENTRY} imports ${input}, which is not shipped under ${SHIPPED_MODULE_ROOTS.join(' or ')}.`);
    }
    const text = await readFile(join(exactRoot, ...input.split('/')), 'utf8');
    if (/\bimport\.meta\b/.test(codeOf(text))) {
      throw new Error(
        `${input} reads import.meta, which in the page bundle names the bundle: `
          + 'resolve files through assets/js/app/asset-url.js, or add the module to PAGE_EXTERNALS.'
      );
    }
  }
  const files = new Map();
  for (const file of result.outputFiles) {
    const path = posix.relative(exactRoot.split('\\').join('/'), file.path.split('\\').join('/'));
    if (!PAGE_BUNDLE_FILE.test(posix.basename(path)) || posix.dirname(path) !== PAGE_DIR) {
      throw new Error(`The page bundle wrote ${path}, which is not a page bundle file name.`);
    }
    files.set(path, Buffer.from(file.contents));
  }
  const outputs = result.metafile.outputs;
  const entry = Object.keys(outputs).find(path => outputs[path].entryPoint === PAGE_ENTRY);
  const preload = new Set();
  const pending = [entry];
  while (pending.length > 0) {
    const path = pending.pop();
    for (const { path: imported, kind } of outputs[path].imports) {
      if (kind !== 'import-statement' || outputs[imported] === undefined || preload.has(imported)) continue;
      preload.add(imported);
      pending.push(imported);
    }
  }
  return { files, entry, preload: [...preload].sort(), inputs };
}

/**
 * The modules `path` imports (statically, re-exported or on demand), each as
 * a path from the root: what `text`, its code, names relatively.
 *
 * @param {string} path
 * @param {string} text
 * @returns {string[]}
 */
export function externalImports(path, text) {
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
  const found = [];
  const pattern = /\b(?:import|export)\s*(?:[\w*{}\s,$]*?\bfrom\s*)?(['"])([^'"]+)\1|\bimport\s*\(\s*(['"])([^'"]+)\3\s*\)/g;
  for (const match of code.matchAll(pattern)) {
    const specifier = match[2] ?? match[4];
    found.push(posix.normalize(posix.join(posix.dirname(path), specifier.split('?')[0])));
  }
  return found;
}

/** The code of a module with its comments and string contents blanked. */
function codeOf(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1')
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, "''");
}

async function pageFilesOnDisk(rootDir) {
  const directory = join(resolve(rootDir), ...PAGE_DIR.split('/'));
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return names.map(name => `${PAGE_DIR}/${name}`);
}

/**
 * The page bundle files that are not what the sources build: each expected
 * file that is missing or differs, and each file of the folder that the build
 * does not write (a previous build's).
 *
 * @param {{ rootDir: string, built: { files: Map<string, Buffer> } }} options
 * @returns {Promise<string[]>}
 */
export async function stalePageFiles({ rootDir, built }) {
  const exactRoot = resolve(rootDir);
  const stale = [];
  for (const [path, bytes] of built.files) {
    let current = null;
    try {
      current = await readFile(join(exactRoot, ...path.split('/')));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (current === null || !current.equals(bytes)) stale.push(path);
  }
  for (const path of await pageFilesOnDisk(exactRoot)) {
    if (!built.files.has(path)) stale.push(path);
  }
  return stale.sort();
}

/**
 * Write the built page bundle and remove every other file of its folder.
 *
 * @param {{ rootDir: string, built: { files: Map<string, Buffer> }, write: (absolutePath: string, bytes: Buffer) => Promise<void> }} options
 */
export async function writePageBundle({ rootDir, built, write }) {
  const exactRoot = resolve(rootDir);
  await mkdir(join(exactRoot, ...PAGE_DIR.split('/')), { recursive: true });
  for (const path of await stalePageFiles({ rootDir: exactRoot, built })) {
    const absolutePath = join(exactRoot, ...path.split('/'));
    if (built.files.has(path)) {
      await write(absolutePath, built.files.get(path));
    } else {
      await unlink(absolutePath);
    }
  }
}
