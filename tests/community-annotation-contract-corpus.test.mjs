/**
 * The shared accept/reject corpus holds the app's annotation validators to
 * the contract the repository validator applies.
 *
 * tests/fixtures/community-annotation-contract-corpus.json is a byte-identical
 * copy of theislab/cellucid-annotation's tests/fixtures/contract-corpus.json,
 * written by that repository's scripts/generate_contract_corpus.py (run it
 * with `--copy <this file>`). Its test suite (tests/test_contract_corpus.py)
 * pins the same SHA-256 and runs every case through the Python validator;
 * this suite runs every case through wire-contract.js. Update both digests
 * together.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';

import {
  ANNOTATION_FILE_MAX_UTF8_BYTES,
  ANNOTATION_SCHEMA_BLOB_OIDS,
  ANNOTATION_WHITESPACE_CLASS,
  assertConfigDocument,
  assertMergesFile,
  assertUserFile,
  isAnnotationExactNonblank,
  parseExactJson,
  projectMergesFile,
  projectUserFile,
} from '../assets/js/app/community-annotations/wire-contract.js';

const FIXTURE_URL = new URL('./fixtures/community-annotation-contract-corpus.json', import.meta.url);
const FIXTURE_SHA256 = '81239badc82ce335ea3cd82c1685baf5b4ce64021e4e15cc40935156d00508ba';

const raw = readFileSync(FIXTURE_URL);
const corpus = JSON.parse(raw.toString('utf8'));

/** The bytes of one case's file. */
function caseBytes(entry) {
  let bytes = 'base64' in entry
    ? Buffer.from(entry.base64, 'base64')
    : Buffer.from(entry.text, 'utf8');
  if ('padToBytes' in entry) {
    bytes = Buffer.concat([bytes, Buffer.alloc(entry.padToBytes - bytes.length, 0x20)]);
    assert.equal(bytes.length, entry.padToBytes);
  }
  return bytes;
}

/** Read one file as the app does: size bound, strict UTF-8 (a BOM kept), exact JSON. */
function readCase(entry) {
  const bytes = caseBytes(entry);
  if (bytes.byteLength > ANNOTATION_FILE_MAX_UTF8_BYTES) {
    throw new Error(`${entry.path} exceeds ${ANNOTATION_FILE_MAX_UTF8_BYTES} bytes`);
  }
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  return parseExactJson(text, { path: entry.path });
}

function filenameOf(entry) {
  return entry.path.slice(entry.path.lastIndexOf('/') + 1);
}

function verdict(run) {
  try {
    run();
    return { verdict: 'accept' };
  } catch (error) {
    return { verdict: 'reject', error };
  }
}

test('the corpus is the pinned one', () => {
  assert.equal(createHash('sha256').update(raw).digest('hex'), FIXTURE_SHA256);
});

test('ANNOTATION_SCHEMA_BLOB_OIDS are the git blob ids of the canonical schema texts', () => {
  assert.deepEqual(Object.keys(ANNOTATION_SCHEMA_BLOB_OIDS).sort(), ['config', 'merges', 'user']);
  assert.deepEqual(
    Object.fromEntries(Object.entries(corpus.schemas).map(([kind, schema]) => [kind, schema.path])),
    {
      user: 'annotations/schema.json',
      config: 'annotations/config.schema.json',
      merges: 'annotations/moderation/merges.schema.json',
    },
  );
  for (const [kind, schema] of Object.entries(corpus.schemas)) {
    const bytes = Buffer.from(schema.text, 'utf8');
    const oid = createHash('sha1')
      .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`, 'ascii'), bytes]))
      .digest('hex');
    assert.equal(oid, schema.blobOid, kind);
    assert.equal(ANNOTATION_SCHEMA_BLOB_OIDS[kind], oid, kind);
  }
  assert.ok(Object.isFrozen(ANNOTATION_SCHEMA_BLOB_OIDS));
});

test('the app shares the corpus parameters: file bound, nesting depth and whitespace class', () => {
  assert.equal(corpus.fileMaxUtf8Bytes, ANNOTATION_FILE_MAX_UTF8_BYTES);
  assert.equal(corpus.whitespaceClass, ANNOTATION_WHITESPACE_CLASS);

  const depth = corpus.jsonMaxDepth;
  assert.doesNotThrow(() => parseExactJson('['.repeat(depth) + ']'.repeat(depth)));
  assert.throws(
    () => parseExactJson('['.repeat(depth + 1) + ']'.repeat(depth + 1)),
    new RegExp(`JSON nesting exceeds ${depth} levels`),
  );

  const whitespace = new RegExp(`^${ANNOTATION_WHITESPACE_CLASS}$`);
  const matched = [];
  const ecmaScript = [];
  for (let code = 0; code <= 0x10ffff; code += 1) {
    if (code >= 0xd800 && code <= 0xdfff) continue;
    const character = String.fromCodePoint(code);
    if (whitespace.test(character)) matched.push(code);
    if (/^\s$/.test(character)) ecmaScript.push(code);
  }
  assert.deepEqual(matched, corpus.whitespaceCodePoints);
  for (const code of ecmaScript) assert.ok(matched.includes(code), `U+${code.toString(16)}`);
  // Python's str.isspace() adds U+001C-U+001F and U+0085.
  assert.deepEqual(
    matched.filter(code => !ecmaScript.includes(code)),
    [0x1c, 0x1d, 0x1e, 0x1f, 0x85],
  );
  for (const code of matched) {
    const character = String.fromCodePoint(code);
    assert.equal(isAnnotationExactNonblank(`${character}x`), false);
    assert.equal(isAnnotationExactNonblank(`x${character}`), false);
    assert.equal(isAnnotationExactNonblank(`x${character}x`), true);
  }
});

test('every whitespace pattern of the schemas uses the app whitespace class', () => {
  const body = ANNOTATION_WHITESPACE_CLASS.slice(1, -1);
  for (const [kind, schema] of Object.entries(corpus.schemas)) {
    const patterns = [];
    const visit = (node) => {
      if (Array.isArray(node)) node.forEach(visit);
      else if (node && typeof node === 'object') {
        if (typeof node.pattern === 'string') patterns.push(node.pattern);
        Object.values(node).forEach(visit);
      }
    };
    visit(JSON.parse(schema.text));
    assert.ok(patterns.length > 0, kind);
    for (const pattern of patterns) {
      assert.doesNotMatch(pattern.replaceAll('[\\s\\S]', ''), /\\[sS]/, `${kind}: ${pattern}`);
      for (const [, negated] of pattern.matchAll(/\[\^([^\]]*)\]/g)) {
        if (negated !== ':') assert.equal(negated.replace(/^:/, ''), body, `${kind}: ${pattern}`);
      }
    }
  }
});

test('every corpus case gets its verdict from the app validators', () => {
  const kinds = new Set();
  const mismatches = [];
  for (const entry of corpus.cases) {
    kinds.add(entry.kind);
    const filename = filenameOf(entry);
    const result = verdict(() => {
      const document = readCase(entry);
      if (entry.kind === 'user') assertUserFile(document, { path: entry.path, filename });
      else if (entry.kind === 'config') assertConfigDocument(document, { path: entry.path });
      else if (entry.kind === 'merges') assertMergesFile(document, { path: entry.path });
      else throw new Error(`unknown case kind ${entry.kind}`);
    });
    if (result.verdict !== entry.expect) {
      mismatches.push(`${entry.name}: expected ${entry.expect}, got ${result.verdict} ${result.error?.message ?? ''}`);
    }
  }
  assert.deepEqual([...kinds].sort(), ['config', 'merges', 'user']);
  assert.deepEqual(mismatches, []);
});

test('reading one dataset of a file judges only that dataset and the profile', () => {
  const mismatches = [];
  let projected = 0;
  for (const entry of corpus.cases) {
    for (const { datasetId, expect } of entry.project ?? []) {
      projected += 1;
      const result = verdict(() => {
        const document = readCase(entry);
        if (entry.kind === 'user') {
          projectUserFile(document, datasetId, { path: entry.path, filename: filenameOf(entry) });
        } else {
          projectMergesFile(document, datasetId, { path: entry.path });
        }
      });
      if (result.verdict !== expect) {
        mismatches.push(`${entry.name} (${datasetId}): expected ${expect}, got ${result.verdict} ${result.error?.message ?? ''}`);
      }
    }
  }
  assert.ok(projected >= 20);
  assert.deepEqual(mismatches, []);
});

test('every accepted text parses to exactly the value JSON.parse returns', () => {
  for (const entry of corpus.cases) {
    if (entry.expect !== 'accept') continue;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(caseBytes(entry));
    assert.ok(isDeepStrictEqual(parseExactJson(text), JSON.parse(text)), entry.name);
  }
});
