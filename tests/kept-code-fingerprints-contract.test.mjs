/**
 * The code fingerprints of what the browser keeps between visits
 * (`scripts/kept-code-fingerprints.mjs`): each kind of kept directory
 * (converted stores, gene indexes, files downloaded whole, the downloaded
 * parts of files) is stamped with a digest of the code that decides what it
 * holds, and a directory stamped by other code is removed, never read (that
 * behavior: `transcode-cache-contract`, `kept-column-index-contract`,
 * `kept-parts-contract`).
 *
 * - The generated module (`kept-code-fingerprints.js`) is exactly what the
 *   code gives: after changing covered code, the generator is run again. No
 *   fingerprint is written in a test.
 * - A fingerprint follows code, never comments or layout: the same module
 *   with other comments, blank lines and line wrapping gives the same
 *   fingerprint; a changed statement gives another; a module outside the
 *   closure changes nothing.
 * - What each closure covers: the transcoders and what they import; the
 *   index, the reads and the decoders; for the file's own bytes (a download,
 *   a file's parts) only what a kept directory is and how its bytes are
 *   checked, so that no other change downloads a file again.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  KEPT_CODE_FINGERPRINTS_PATH,
  KEPT_KINDS,
  builtKeptCodeFingerprints,
  codeDigest,
  codeOf,
  keptCodeClosure,
  keptCodeFingerprint,
  keptCodeFingerprints,
  renderKeptCodeFingerprints,
  sourceClosure,
} from '../scripts/kept-code-fingerprints.mjs';
import { KEPT_CODE_FINGERPRINTS } from '../assets/js/data/anndata/transcode/kept-code-fingerprints.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KINDS = Object.keys(KEPT_KINDS);
const closures = Object.fromEntries(KINDS.map(kind => [kind, keptCodeClosure(ROOT, kind)]));

/** A new folder for a tree of modules, removed with the test. */
function temporaryTree(t, files = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'cellucid-code-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  for (const [file, text] of Object.entries(files)) write(file, text);
  return { root, write };
}

test('the committed code fingerprints are exactly what the code that writes kept data gives', async () => {
  const built = await builtKeptCodeFingerprints({ rootDir: ROOT });
  assert.equal(built.path, KEPT_CODE_FINGERPRINTS_PATH);
  assert.equal(built.stale, false,
    `${KEPT_CODE_FINGERPRINTS_PATH} is not what the code gives (code that decides what the browser keeps changed): ` +
    'regenerate with `node scripts/generate-web-asset-inventory.mjs`.');
  // The module the app runs says what the generator computes, one fingerprint a kind.
  assert.deepEqual({ ...KEPT_CODE_FINGERPRINTS }, keptCodeFingerprints(ROOT));
  assert.deepEqual(Object.keys(KEPT_CODE_FINGERPRINTS), KINDS);
  for (const kind of KINDS) assert.match(KEPT_CODE_FINGERPRINTS[kind], /^[0-9a-f]{16}$/, kind);
  assert.equal(renderKeptCodeFingerprints(KEPT_CODE_FINGERPRINTS).toString('utf8'), readFileSync(path.join(ROOT, KEPT_CODE_FINGERPRINTS_PATH), 'utf8'));
});

test('a fingerprint follows code, never comments or layout: other comments, blank lines and line wrapping give the same one, a changed statement another', t => {
  const entry = [
    '/**',
    ' * What a kept file is.',
    ' * @module entry',
    ' */',
    'import { pageOf } from \'./checks.js\';',
    'import { say } from \'./words.js\';',
    '',
    '/** The page a byte is on. */',
    'export function describe(offset, pageBytes = 16384) {',
    '  const page = pageOf(offset, pageBytes); // which page',
    '  return say(`page ${page}`, { offset, pageBytes });',
    '}',
    '',
  ].join('\n');
  const checks = 'export const pageOf = (offset, pageBytes) => Math.floor(offset / pageBytes);\n';
  const words = 'export const say = (text, details) => `${text} (${JSON.stringify(details)})`;\n';
  const { root, write } = temporaryTree(t, { 'entry.js': entry, 'checks.js': checks, 'words.js': words });
  const leftOut = new Map([['words.js', 'messages']]);
  const fingerprint = () => {
    const { covered, reached } = sourceClosure(root, ['entry.js'], leftOut);
    assert.deepEqual(covered, ['checks.js', 'entry.js'], 'the import is followed; the left-out module is not covered');
    assert.ok(reached.has('words.js'));
    return codeDigest(root, covered);
  };
  const original = fingerprint();

  // The same code: every comment rewritten or removed, others added (line, block, JSDoc and
  // license comments), blank lines added and removed, indentation changed, statements re-wrapped.
  write('entry.js', [
    '/*! Copyright: kept as a legal comment by some tools. */',
    '// Another header, in another style.',
    'import {',
    '\tpageOf,',
    '} from "./checks.js";',
    '',
    '',
    'import { say } from \'./words.js\'; /* still left out */',
    'export function describe(',
    '    offset,',
    '    pageBytes = 16384, // the page size',
    ') {',
    '',
    '    const page = pageOf(',
    '        offset,',
    '        pageBytes',
    '    );',
    '    /**',
    '     * A rewritten comment of several lines, naming an import that is not one:',
    '     * import { other } from \'./other.js\';',
    '     */',
    '    return say(`page ${page}`, {',
    '        offset,',
    '        pageBytes,',
    '    });',
    '}',
  ].join('\n'));
  write('checks.js', '// Rewrapped.\nexport const pageOf = (\n  offset,\n  pageBytes,\n) =>\n  Math.floor(offset / pageBytes);\n');
  assert.equal(fingerprint(), original, 'comments, blank lines, indentation and line wrapping change nothing');

  // No comment of any kind is printed: an annotation, a license comment, one inside an import, a source map's.
  for (const [commented, plain] of [
    ['const a = /* @__PURE__ */ f();\nexport { a };', 'const a = f();\nexport { a };'],
    ['/*! A license. */\n// @license MIT\n/** @preserve */\nexport const b = 1;', 'export const b = 1;'],
    ['export const c = () => import(/* webpackIgnore: true */ "./x.js");', 'export const c = () => import("./x.js");'],
    ['export const d = /** @type {number} */ (1); //# sourceMappingURL=x.js.map', 'export const d = 1;'],
  ]) assert.equal(codeOf(commented), codeOf(plain), commented);

  // A module outside the closure: its code changes nothing either.
  write('words.js', 'export const say = text => text.toUpperCase();\n');
  assert.equal(fingerprint(), original, 'a left-out module\'s code changes nothing');

  // Code: each of these is another fingerprint.
  const changes = {
    'a number': source => source.replace('16384', '4096'),
    'the text of a string': source => source.replace('`page ${page}`', '`Page ${page}`'),
    'an operator': source => source.replace('offset / pageBytes', 'offset % pageBytes'),
    'a statement added': source => `${source}\nexport const added = 1;\n`,
  };
  for (const [what, change] of Object.entries(changes)) {
    for (const file of ['entry.js', 'checks.js']) {
      const before = readFileSync(path.join(root, file), 'utf8');
      const after = change(before);
      if (after === before) continue;
      write(file, after);
      assert.notEqual(fingerprint(), original, `${what} in ${file} is another fingerprint`);
      write(file, before);
    }
  }
  assert.equal(fingerprint(), original);
  // A module moved is another fingerprint: its path names it, and its importers' code names it too.
  assert.notEqual(codeDigest(root, ['checks.js']), (() => {
    write('moved/checks.js', readFileSync(path.join(root, 'checks.js'), 'utf8'));
    return codeDigest(root, ['moved/checks.js']);
  })());
});

test('a class composed from several modules is followed through `this`: a covered module reaches the module of every method it calls, and no other', t => {
  const { root } = temporaryTree(t, {
    'assets/js/entry.js': "import { Kept } from './composed/kept.js';\nexport const keep = Kept;\n",
    'assets/js/composed/core.js': [
      "import { applyMixin } from '../utils/apply-mixin.js';",
      "import { Kept } from './kept.js';",
      "import { Pointers } from './pointers.js';",
      "import { Unrelated } from './unrelated.js';",
      'export class Core {',
      '  plan() { return 1; }',
      '}',
      'applyMixin(Core.prototype, Kept.prototype);',
      'applyMixin(Core.prototype, Pointers.prototype);',
      'applyMixin(Core.prototype, Unrelated.prototype);',
      '',
    ].join('\n'),
    'assets/js/composed/kept.js': 'export class Kept {\n  keepRun() { return this.pointersOf(this.plan()); }\n}\n',
    'assets/js/composed/pointers.js': "import { width } from '../width.js';\nexport class Pointers {\n  pointersOf(n) { return new Int32Array(n * width); }\n}\n",
    'assets/js/composed/unrelated.js': 'export class Unrelated {\n  names() { return []; }\n}\n',
    'assets/js/width.js': 'export const width = 2;\n',
    'assets/js/utils/apply-mixin.js': 'export function applyMixin() {}\n',
  });
  const followed = sourceClosure(root, ['assets/js/entry.js'], new Map());
  assert.deepEqual(followed.covered, [
    'assets/js/composed/core.js', 'assets/js/composed/kept.js', 'assets/js/composed/pointers.js',
    'assets/js/composed/unrelated.js', 'assets/js/entry.js', 'assets/js/utils/apply-mixin.js', 'assets/js/width.js',
  ], 'the composing module is reached through `this.plan` and imports every mixin');
  // With the composing module left out, a method's module is reached only when a covered module calls it.
  const { covered } = sourceClosure(root, ['assets/js/entry.js'], new Map([['assets/js/composed/core.js', 'plans']]));
  assert.deepEqual(covered, ['assets/js/composed/kept.js', 'assets/js/composed/pointers.js', 'assets/js/entry.js', 'assets/js/width.js']);
});

test('every covered module of every kind prints the same without its comments and layout: rewriting comments changes no real fingerprint', t => {
  const covered = [...new Set(KINDS.flatMap(kind => closures[kind].covered))];
  for (const file of covered) {
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    const printed = codeOf(source, file);
    // The print of the print is the print: code alone decides it.
    assert.equal(codeOf(printed, file), printed, `${file}: printed the same once its comments and layout are gone`);
    assert.equal(codeOf(`/** A header added. */\n\n${source}\n\n// A line added.\n`, file), printed, `${file}: added comments and blank lines change nothing`);
  }
  // The real thing, end to end: the tree of a download's fingerprint, every module replaced by
  // its comment-free one-line print, has the committed fingerprint; a statement added does not.
  const { root, write } = temporaryTree(t);
  for (const file of closures.download.covered) write(file, codeOf(readFileSync(path.join(ROOT, file), 'utf8'), file));
  assert.equal(keptCodeFingerprint(root, 'download'), KEPT_CODE_FINGERPRINTS.download, 'the same code without one comment, on one line a module: the same fingerprint');
  const format = closures.download.covered.find(file => file.endsWith('/kept-format.js'));
  write(format, `${readFileSync(path.join(root, format), 'utf8')}\nexport const added = 1;\n`);
  assert.notEqual(keptCodeFingerprint(root, 'download'), KEPT_CODE_FINGERPRINTS.download, 'a statement added: another fingerprint');
});

test('each closure covers the code that decides what its kind holds, and nothing that only keeps, moves or schedules', () => {
  const format = 'assets/js/data/anndata/transcode/kept-format.js';
  const journal = 'assets/js/data/anndata/transcode/kept-journal.js';
  const checks = 'assets/js/formats/io/page-checks.js';
  for (const kind of KINDS) {
    const { covered, reached } = closures[kind];
    for (const entry of KEPT_KINDS[kind].entries) assert.ok(covered.includes(entry), `${kind}: its entry ${entry} is covered`);
    // What a kept directory is, and the checksums its bytes are checked against, are every kind's.
    assert.ok(covered.includes(format) && covered.includes(checks), `${kind}: covers the kept format and the page checksums`);
    // Never the code that keeps the directories, nor the fingerprints themselves, nor generated names.
    for (const outside of ['assets/js/data/anndata/transcode/space.js', KEPT_CODE_FINGERPRINTS_PATH, 'assets/workers/scripts.js']) {
      assert.ok(!covered.includes(outside), `${kind}: ${outside} is not covered`);
    }
    assert.ok(!reached.has(KEPT_CODE_FINGERPRINTS_PATH), `${kind}: no covered module imports the fingerprints`);
    assert.deepEqual(covered, [...covered].sort());
  }
  // Every left-out module is one a closure that leaves it out reaches (a stale entry is removed).
  const leftOut = new Set(KINDS.flatMap(kind => [...closures[kind].leftOut.keys()]));
  for (const file of leftOut) {
    assert.ok(KINDS.some(kind => closures[kind].leftOut.has(file) && closures[kind].reached.has(file)),
      `${file} is left out but no closure reaches it any more: remove it from scripts/kept-code-fingerprints.mjs`);
  }

  // The file's own bytes: exactly what a kept directory is and how its bytes are checked.
  // A module added here is one more whose every change downloads kept files again.
  assert.deepEqual(closures.download.covered, [
    format,
    'assets/js/data/sources/identity.js',
    'assets/js/data/sources/link-credentials.js',
    checks,
  ], 'a download\'s fingerprint covers these modules and no other');
  assert.deepEqual(closures.parts.covered.filter(file => !closures.download.covered.includes(file)), [journal],
    'the parts\' fingerprint covers a download\'s modules and the journal\'s records, no other');
  assert.ok(closures.download.covered.every(file => closures.parts.covered.includes(file)));
  for (const kind of ['store', 'index', 'download']) assert.ok(!closures[kind].covered.includes(journal), `${kind}: a change to the journal's records is the parts' alone`);

  // A converted store: the transcoders, what they import, and the writers they share.
  for (const file of [
    'assets/js/data/anndata/transcode/r-object.js', 'assets/js/data/anndata/transcode/matrix-market.js',
    'assets/js/data/anndata/transcode/session.js', 'assets/js/data/anndata/write/element-writer.js',
    'assets/js/formats/zarr/format-v2.js', 'assets/js/formats/rds/parse.js', 'assets/js/formats/text/matrix-market.js',
    'assets/js/data/subsample.js', 'assets/js/data/data-mapping.js', 'assets/js/formats/rds/gunzip-worker.js',
  ]) assert.ok(closures.store.covered.includes(file), `store: ${file} is covered`);
  // What only a copy of a dataset writes is not a converted store's.
  for (const file of ['assets/js/formats/zarr/writer.js', 'assets/js/formats/zip/writer.js', 'assets/js/data/anndata/write/copy.js']) {
    assert.ok(!closures.store.reached.has(file), `store: ${file} is not reached`);
  }

  // A gene index: the index, the reads and conversions it is built from, the layouts and the decoders.
  for (const file of [
    'assets/js/data/anndata/kept-column-index.js', 'assets/js/data/sparse-column-index.js', 'assets/js/data/anndata/values.js',
    'assets/js/formats/zarr/codecs/blosc.js', 'assets/js/formats/hdf5/filters.js', 'assets/js/formats/io/decode-worker.js',
    'assets/js/data/anndata/views/cell-subset.js',
    // What a kept run means: its file rows through the open order, its pointers from its first row,
    // and how a segment in store order maps its rows to open rows.
    'assets/js/data/anndata/reader/kept-indexes.js', 'assets/js/data/anndata/reader/gene-segments.js',
    // Reached through `this`, not an import: the pointers a kept run is written with.
    'assets/js/data/anndata/reader/row-pointers.js',
  ]) assert.ok(closures.index.covered.includes(file), `index: ${file} is covered`);
  // Every container reader the reader opens a file with is followed.
  const opens = readFileSync(path.join(ROOT, 'assets/js/data/anndata/open.js'), 'utf8');
  const readers = [...opens.matchAll(/from '(\.\.\/\.\.\/formats\/[^/']+\/index\.js)'/g)].map(([, target]) => path.posix.normalize(path.posix.join('assets/js/data/anndata', target)));
  assert.ok(readers.length >= 3, 'the container readers are found');
  for (const file of readers) assert.ok(closures.index.reached.has(file), `index: ${file}, which opens files, is followed`);
});

test('what a kept directory is touches no storage and holds no lock: the modules a download\'s and the parts\' fingerprints cover are pure', () => {
  // Reading, writing, locking and making room are the keeper's (`space.js`), which no fingerprint
  // covers: a change of when or under which lock a file is written downloads nothing again.
  for (const file of closures.parts.covered) {
    const code = codeOf(readFileSync(path.join(ROOT, file), 'utf8'), file);
    assert.doesNotMatch(code, /\bnavigator\b|\bgetDirectory\b|\bgetFileHandle\b|\bgetDirectoryHandle\b|\bcreateSyncAccessHandle\b|\bcreateWritable\b|\blocks\b|\bremoveEntry\b|\bfetch\(/,
      `${file} reads, writes or locks: that belongs in space.js, outside the fingerprints`);
  }
});

test('the fingerprints are stamped and checked by the module that keeps the directories, and by no other', () => {
  const importers = [];
  const walk = folder => {
    for (const entry of readdirSync(path.join(ROOT, folder), { withFileTypes: true })) {
      const file = `${folder}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith('.js') && /\bfrom\s+'[^']*kept-code-fingerprints\.js'/.test(readFileSync(path.join(ROOT, file), 'utf8'))) importers.push(file);
    }
  };
  walk('assets/js');
  assert.deepEqual(importers, ['assets/js/data/anndata/transcode/space.js']);
});
