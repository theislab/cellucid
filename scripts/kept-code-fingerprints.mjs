// The code fingerprints of what the browser keeps between visits.
//
// The app keeps four kinds of data in the origin-private file system
// (`assets/js/data/anndata/transcode/space.js`): converted stores, gene
// indexes, files downloaded whole, and the downloaded parts of files. Each
// kept directory's manifest is stamped with the code fingerprint of its
// kind: a digest of the code that decides what a directory of that kind
// holds. A directory stamped by other code is removed by the browser, never
// read, and what it held is made again on the next opening. Nothing is
// raised by hand and no digest is written in a test: change that code and
// the fingerprint changes with it.
//
// - **Which modules** (`KEPT_KINDS`): a kind's closure is every module
//   reached from its entries through relative imports (static, re-export,
//   side-effect and dynamic `import('…')`), so a module newly imported by a
//   covered one is covered; a module left out is not, nor what only it
//   imports. A class composed from the methods of several modules
//   (`utils/apply-mixin.js`) calls across them through `this`, not through
//   an import: a covered module of one also reaches every module of it that
//   defines a method it calls (`compositionEdges`). A left-out module is one
//   that never decides what is kept (`LEFT_OUT`, each with why).
// - **What of them** (`codeOf`): each module as esbuild prints it with
//   comments and layout removed and nothing else changed (no renaming, no
//   folding: a semantics-preserving print). A comment, a blank line or a
//   re-wrapped statement changes no fingerprint; any change to what runs
//   changes it. esbuild is pinned in `package.json`; a new version that
//   prints differently changes the fingerprints once.
// - **How narrow**: a converted store or a gene index made again costs
//   minutes, a file downloaded again may be gigabytes. So a download's
//   fingerprint covers only the modules that say what a kept directory is
//   and how its bytes are checked (`kept-format.js`, the page checksums,
//   and the two identity rules they import), and the parts' those and the
//   journal's records; nothing of the reader, the transport or the code
//   that keeps the directories (`space.js`: locks, room, listing, removal)
//   is in them. Those modules hold nothing else on purpose: a helper or a
//   message added to one is code whose every later change empties what
//   browsers keep.
//
// `generate-web-asset-inventory.mjs` writes the fingerprints to
// `KEPT_CODE_FINGERPRINTS_PATH` with every run, before the bundles (which
// hold that module), and `--check` refuses a tree where it is not what the
// code gives; `tests/kept-code-fingerprints-contract.test.mjs` holds the
// same, and what each closure covers.

//
// Run it to see what a change would touch: `node scripts/kept-code-fingerprints.mjs`
// prints every kind's fingerprint and the modules it covers and leaves out
// (`node scripts/kept-code-fingerprints.mjs download` one kind's).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

/** The generated module the fingerprints are written to; `space.js` stamps and checks manifests with it. */
export const KEPT_CODE_FINGERPRINTS_PATH = 'assets/js/data/anndata/transcode/kept-code-fingerprints.js';

/** Hex digits of a fingerprint: it tells one code from another, it is not a secret. */
const FINGERPRINT_DIGITS = 16;

const FORMAT = 'assets/js/data/anndata/transcode/kept-format.js';
const JOURNAL = 'assets/js/data/anndata/transcode/kept-journal.js';
const PAGE_CHECKS = 'assets/js/formats/io/page-checks.js';

/**
 * Modules a closure reaches that never decide what a kept directory holds,
 * each with why; what only they import is left out with them. A module
 * newly imported by a covered one is covered until it is listed here, and
 * an entry no closure reaches any more is removed (the contract test names
 * it).
 */
const LEFT_OUT = new Map([
  // Keeps the directories: when one is written, found, held, listed and removed. What it holds is
  // `kept-format.js`, an entry of every kind. It imports the fingerprints, which are no code of theirs.
  ['assets/js/data/anndata/transcode/space.js', 'keeps the directories (locks, room, listing, removal) and stamps them'],
  ['assets/workers/scripts.js', 'generated names of the worker bundles'],
  // Move bytes: what arrives is the same bytes. With them goes what only they import (the hosts,
  // their fetches and mirrors, the page's memory of bytes fetched).
  ['assets/js/formats/io/byte-source.js', 'transport'],
  ['assets/js/formats/io/link.js', 'link measurement'],
  ['assets/js/formats/zarr/stores/http.js', 'transport: the objects of a store folder on a web host'],
  // Say when work runs, on which thread, and whether it goes on: never what it makes.
  ['assets/js/utils/abort.js', 'cancellation'],
  ['assets/js/utils/machine.js', 'the rates a plan weighs'],
  ['assets/js/formats/io/activity.js', 'progress reporting'],
  ['assets/js/formats/io/decode-pool.js', 'runs decoders and scans on worker threads; what runs there is an entry, or imported by one'],
  ['assets/js/workers/worker-script.js', 'starts a worker from its source or its bundle'],
  ['assets/js/data/memory-budget.js', 'residency policy'],
  ['assets/js/utils/format-units.js', 'messages'],
  // A standard's algorithm, held to the standard's own vectors: its answers cannot change without being wrong.
  ['assets/js/utils/sha256.js', 'SHA-256, held to its vectors (tests/sha256-secure-context-contract.test.mjs)'],
  ['assets/js/formats/zip/crc32.js', 'CRC-32, held to its vectors (tests/zip-format-contract.test.mjs)'],
  // A file recognized otherwise is another reader's, transcoder's or identity's: never other bytes under the same one.
  ['assets/js/data/input-formats.js', 'recognizes formats and words their refusals'],
]);

/**
 * Each kind of kept data (by the name its fingerprint has in the generated
 * module): what it is, the entries its closure is followed from, and what
 * is left out of it besides `LEFT_OUT`.
 */
export const KEPT_KINDS = Object.freeze({
  /**
   * A converted store (an R object, a MatrixMarket folder): every module
   * the transcoders load and the worker script they start, so anything that
   * can change what a pass writes; with what a kept directory is and how
   * its files are checked.
   */
  store: Object.freeze({
    what: 'converted stores',
    entries: Object.freeze([
      'assets/js/data/anndata/transcode/index.js',
      'assets/js/formats/rds/gunzip-worker.js',
      FORMAT,
      PAGE_CHECKS,
    ]),
    leftOut: new Map(),
  }),
  /**
   * A gene index: the index and its kept form (the column stores, the
   * build, the runs of rows, the kept arrays), the values and entries it is
   * built from (the matrix's reads and their conversion, the subsample's
   * view of the file's rows, the layouts a file is presented through) and
   * the readers that decode the file's chunks (Zarr, HDF5, ZIP, and the
   * decode worker that runs their codecs); with what a kept directory is.
   */
  index: Object.freeze({
    what: 'gene indexes',
    entries: Object.freeze([
      'assets/js/data/anndata/kept-column-index.js',
      'assets/js/data/sparse-column-index.js',
      'assets/js/data/anndata/prefix-column-index.js',
      'assets/js/data/anndata/matrix-access.js',
      'assets/js/data/anndata/values.js',
      'assets/js/data/anndata/views/cell-subset.js',
      'assets/js/data/anndata/views/index.js',
      'assets/js/data/anndata/older-layouts.js',
      'assets/js/data/anndata/reader/kept-indexes.js',
      'assets/js/data/anndata/reader/gene-segments.js',
      'assets/js/formats/zarr/index.js',
      'assets/js/formats/hdf5/index.js',
      'assets/js/formats/zip/index.js',
      'assets/js/formats/io/decode-worker.js',
      FORMAT,
    ]),
    leftOut: new Map([
      ['assets/js/data/data-mapping.js', 'names the default modality; the matrix a run indexes is named in its group'],
      // The opening's plan: its order's specification names the key a run is filed under (`orderKey`), so
      // another order is another key and never other bytes under one; the rest is what the opening reads and says.
      ['assets/js/data/anndata/subsample-plan.js', 'plans the opening: names the order a run is filed under'],
      // Opens a matrix, shares its reads and releases its indexes.
      ['assets/js/data/anndata/reader/matrices.js', 'opens matrices and shares their reads'],
      // The reader's own methods the covered ones call plan how a matrix is read (read ahead, yield to the
      // foreground, merge gaps, keep reads inside a chunk): a run another plan makes is filed under its own
      // rows and order, never as other bytes under one.
      ['assets/js/data/anndata/reader.js', 'plans how a matrix is read'],
    ]),
  }),
  /**
   * A file downloaded whole: its own bytes, so only what a kept directory
   * is (its files' names, what it is filed under, its manifest) and the
   * page checksums its bytes are checked against.
   */
  download: Object.freeze({
    what: 'files downloaded whole',
    entries: Object.freeze([FORMAT, PAGE_CHECKS]),
    leftOut: new Map(),
  }),
  /**
   * The downloaded parts of a file: the file's own bytes, in a journal.
   * What a download's covers, and the journal's records.
   */
  parts: Object.freeze({
    what: 'the downloaded parts of files',
    entries: Object.freeze([FORMAT, JOURNAL, PAGE_CHECKS]),
    leftOut: new Map([
      ['assets/js/data/sparse-column-index.js', 'allocates a record\'s array, counted by the memory model; no gene index is part of a journal'],
    ]),
  }),
});

/** A module's code: comments and layout removed, everything that runs kept. */
export function codeOf(source, file = 'module.js') {
  return transformSync(source, { loader: 'js', format: 'esm', minifyWhitespace: true, legalComments: 'none', sourcefile: file }).code;
}

/**
 * Every module reached from `entries` through relative imports, and those
 * covered (reached, not left out), repository-relative and sorted.
 *
 * @param {string} root - The repository's folder
 * @param {Iterable<string>} entries
 * @param {Set<string>|Map<string, string>} leftOut
 * @returns {{covered: string[], reached: Set<string>}}
 */
export function sourceClosure(root, entries, leftOut) {
  const seen = new Set();
  const stack = [...entries];
  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    // What a left-out module imports is left out with it.
    if (leftOut.has(file)) continue;
    // Its code as printed without comments (`codeOf`), so an import named in
    // a comment is not followed: esbuild prints every specifier in double quotes.
    const code = codeOf(readFileSync(path.join(root, file), 'utf8'), file);
    for (const match of code.matchAll(/(?:^|[;}\n])\s*(?:import|export)\b[^;"'`]*?\bfrom\s*"([^"]+)"|(?:^|[;}\n])\s*import\s*"([^"]+)"|\bimport\(\s*"([^"]+)"\s*\)/g)) {
      const target = match[1] ?? match[2] ?? match[3];
      if (target.startsWith('.')) stack.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), target)));
    }
    stack.push(...compositionEdges(root, file, code));
  }
  return { covered: [...seen].filter(file => !leftOut.has(file)).sort(), reached: seen };
}

/** Per repository folder: each composed module's methods, by name (`compositionsOf`). */
const compositionCache = new Map();

/**
 * The classes composed from several modules under `root`: every module
 * that calls `applyMixin(Target.prototype, Mixin.prototype)` (or a mixin
 * object, `applyMixin(Target.prototype, methods)`), with the modules its
 * mixins are imported from. For each module of a composition,
 * the methods it defines, by name (a member written at the class body's
 * indent, `  name(` with its modifiers).
 *
 * @param {string} root
 * @returns {Map<string, Map<string, Set<string>>>} module → (method → the composition's modules defining it)
 */
function compositionsOf(root) {
  const cached = compositionCache.get(root);
  if (cached) return cached;
  const byModule = new Map();
  const sources = path.join(root, 'assets/js');
  for (const entry of existsSync(sources) ? readdirSync(sources, { recursive: true }) : []) {
    const composer = path.posix.join('assets/js', String(entry).split(path.sep).join('/'));
    if (!composer.endsWith('.js')) continue;
    const text = readFileSync(path.join(root, composer), 'utf8');
    const mixins = [...text.matchAll(/\bapplyMixin\(\s*\w+\.prototype\s*,\s*(\w+)(?:\.prototype)?\s*\)/g)].map(([, name]) => name);
    if (mixins.length === 0) continue;
    const modules = [composer];
    for (const name of mixins) {
      const from = text.match(new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*'(\\.[^']+)'`));
      if (from) modules.push(path.posix.normalize(path.posix.join(path.posix.dirname(composer), from[1])));
    }
    const definers = new Map();
    for (const module of modules) {
      const source = readFileSync(path.join(root, module), 'utf8');
      for (const [, name] of source.matchAll(/^ {2}(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?\*?\s*([A-Za-z_$][\w$]*)\s*\(/gm)) {
        if (['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'constructor'].includes(name)) continue;
        if (!definers.has(name)) definers.set(name, new Set());
        definers.get(name).add(module);
      }
    }
    // A module in two compositions calls through `this` into either: its
    // methods' modules are the union of both.
    for (const module of modules) {
      const known = byModule.get(module);
      if (!known) { byModule.set(module, definers); continue; }
      const merged = new Map([...known].map(([name, set]) => [name, new Set(set)]));
      for (const [name, set] of definers) for (const definer of set) (merged.get(name) ?? merged.set(name, new Set()).get(name)).add(definer);
      byModule.set(module, merged);
    }
  }
  compositionCache.set(root, byModule);
  return byModule;
}

/**
 * The modules of `file`'s composition (`compositionsOf`) that define a
 * method `file` calls through `this`; none when it is part of no composition.
 *
 * @param {string} root
 * @param {string} file
 * @param {string} code - `file`'s code (`codeOf`)
 * @returns {string[]}
 */
export function compositionEdges(root, file, code) {
  const definers = compositionsOf(root).get(file);
  if (!definers) return [];
  const reached = new Set();
  for (const [, name] of code.matchAll(/\bthis\.([A-Za-z_$][\w$]*)/g)) {
    for (const module of definers.get(name) ?? []) if (module !== file) reached.add(module);
  }
  return [...reached].sort();
}

/**
 * The digest of `files`' code (`codeOf`), each named by its path.
 *
 * @param {string} root
 * @param {string[]} files
 * @returns {string}
 */
export function codeDigest(root, files) {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(`${file}\n`);
    hash.update(codeOf(readFileSync(path.join(root, file), 'utf8'), file));
    hash.update('\n');
  }
  return hash.digest('hex');
}

/** What is left out of one kind's closure: `LEFT_OUT` and the kind's own. */
function leftOutOf(kind) {
  return new Map([...LEFT_OUT, ...KEPT_KINDS[kind].leftOut]);
}

/**
 * One kind's closure: the modules its fingerprint covers, every module
 * reached, and what was left out of it.
 *
 * @param {string} rootDir
 * @param {keyof typeof KEPT_KINDS} kind
 * @returns {{covered: string[], reached: Set<string>, leftOut: Map<string, string>}}
 */
export function keptCodeClosure(rootDir, kind) {
  const leftOut = leftOutOf(kind);
  return { ...sourceClosure(rootDir, KEPT_KINDS[kind].entries, leftOut), leftOut };
}

/**
 * The code fingerprint of one kind, for the tree at `rootDir`: the start
 * of the digest of the code of every module its closure covers.
 *
 * @param {string} rootDir
 * @param {keyof typeof KEPT_KINDS} kind
 * @returns {string}
 */
export function keptCodeFingerprint(rootDir, kind) {
  return codeDigest(rootDir, keptCodeClosure(rootDir, kind).covered).slice(0, FINGERPRINT_DIGITS);
}

/**
 * The code fingerprint of every kind, for the tree at `rootDir`.
 *
 * @param {string} rootDir
 * @returns {Record<keyof typeof KEPT_KINDS, string>}
 */
export function keptCodeFingerprints(rootDir) {
  return Object.fromEntries(Object.keys(KEPT_KINDS).map(kind => [kind, keptCodeFingerprint(rootDir, kind)]));
}

/** The generated module for the given fingerprints. */
export function renderKeptCodeFingerprints(fingerprints) {
  const lines = [
    '/**',
    ' * Generated by scripts/generate-web-asset-inventory.mjs (the closures are in',
    ' * scripts/kept-code-fingerprints.mjs); do not edit. The code fingerprint of',
    ' * each kind of data kept in this browser between visits: a digest of the code',
    ' * that decides what a kept directory of that kind holds, comments and layout',
    ' * aside. `space.js` stamps every manifest with its kind\'s and removes, never',
    ' * reads, a directory stamped with anything else.',
    ' *',
    ' * @module data/anndata/transcode/kept-code-fingerprints',
    ' */',
    'export const KEPT_CODE_FINGERPRINTS = Object.freeze({',
  ];
  for (const [kind, { what }] of Object.entries(KEPT_KINDS)) {
    lines.push(`  /** ${what[0].toUpperCase()}${what.slice(1)}. */`, `  ${kind}: '${fingerprints[kind]}',`);
  }
  lines.push('});');
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

/**
 * The generated module as the tree's code gives it, and whether the one on
 * disk is not that (`stale`: missing or other bytes).
 *
 * @param {{ rootDir: string }} options
 * @returns {Promise<{ path: string, absolutePath: string, bytes: Buffer, stale: boolean }>}
 */
export async function builtKeptCodeFingerprints({ rootDir }) {
  const exactRoot = path.resolve(rootDir);
  const bytes = renderKeptCodeFingerprints(keptCodeFingerprints(exactRoot));
  const absolutePath = path.join(exactRoot, ...KEPT_CODE_FINGERPRINTS_PATH.split('/'));
  let current = null;
  try {
    current = await readFile(absolutePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { path: KEPT_CODE_FINGERPRINTS_PATH, absolutePath, bytes, stale: current === null || !current.equals(bytes) };
}

// Run directly: what each kind's fingerprint is and covers, for the tree this script is in.
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const rootDir = fileURLToPath(new URL('..', import.meta.url));
  const asked = process.argv.slice(2);
  const unknown = asked.filter(kind => !Object.hasOwn(KEPT_KINDS, kind));
  if (unknown.length > 0) throw new TypeError(`Usage: node scripts/kept-code-fingerprints.mjs [${Object.keys(KEPT_KINDS).join('|')}]…`);
  for (const kind of asked.length > 0 ? asked : Object.keys(KEPT_KINDS)) {
    const { covered, reached, leftOut } = keptCodeClosure(rootDir, kind);
    console.log(`${kind} (${KEPT_KINDS[kind].what}): ${keptCodeFingerprint(rootDir, kind)}, ${covered.length} modules`);
    for (const file of covered) console.log(`  ${file}`);
    for (const [file, why] of leftOut) if (reached.has(file)) console.log(`  left out: ${file} (${why})`);
  }
}
