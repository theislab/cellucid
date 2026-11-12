/**
 * @fileoverview A DOM id must be mintable on every origin the app is served
 * from, and there must be exactly one generator.
 *
 * `crypto.randomUUID()` exists only in a secure context. The Python package
 * supports `--host 0.0.0.0` explicitly, for network exposure, so the app is
 * reachable over a plain-HTTP LAN address - and there `globalThis.crypto`
 * either is absent or has no `randomUUID`. A generator that requires it fails
 * on a deployment the project documents and supports.
 *
 * Uniqueness here is uniqueness *within one document*, which a counter gives by
 * construction. Randomness was never the requirement, so needing a secure
 * context for it was a cost with nothing bought.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createDomId } from '../assets/js/app/ui/components/dom-id.js';

function withCrypto(replacement, run) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: replacement
  });
  try {
    run();
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, 'crypto', descriptor);
    } else {
      delete globalThis.crypto;
    }
  }
}

test('a DOM id is mintable with no crypto at all', () => {
  withCrypto(undefined, () => {
    const first = createDomId('field');
    const second = createDomId('field');
    assert.match(first, /^field-/);
    assert.notEqual(
      first,
      second,
      'two ids from the same prefix must differ'
    );
  });
});

test('a DOM id is mintable in a non-secure context, where randomUUID is absent', () => {
  // Exactly the shape a browser presents over plain HTTP on a LAN address:
  // `crypto` exists, `randomUUID` does not.
  withCrypto({ getRandomValues: array => array }, () => {
    assert.doesNotThrow(
      () => createDomId('label'),
      'a non-secure origin must still be able to label its own controls'
    );
  });
});

test('ids are unique across many mints and usable as selectors', () => {
  const seen = new Set();
  for (let index = 0; index < 5000; index++) {
    const id = createDomId('control');
    assert.equal(seen.has(id), false, `id ${id} was minted twice`);
    assert.match(
      id,
      /^[A-Za-z][\w-]*$/,
      'a DOM id must be usable directly in a selector'
    );
    seen.add(id);
  }
});

test('a bad prefix is still refused', () => {
  assert.throws(() => createDomId(''), /prefix/);
  assert.throws(() => createDomId(' leading'), /prefix/);
  assert.throws(() => createDomId(42), /prefix/);
});

test('there is exactly one DOM id generator in the tree', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const roots = ['../assets/js/app/ui/', '../assets/js/app/'];
  const offenders = [];
  const seenFiles = new Set();

  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = new URL(
        entry.isDirectory() ? `${entry.name}/` : entry.name,
        directory
      );
      if (entry.isDirectory()) {
        await walk(child);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      if (entry.name === 'dom-id.js') continue;
      if (seenFiles.has(child.href)) continue;
      seenFiles.add(child.href);
      const source = await readFile(child, 'utf8');
      source.split('\n').forEach((line, index) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        // A *DOM* id built from randomness or the clock is a second generator,
        // however it is spelled. Opaque domain identifiers - a keyframe, a
        // saved query, a lock - are a different subject and are not swept
        // here; they are tracked separately.
        if (
          /\b(domId|elementId|createDomId|htmlFor|labelledby|aria-controls)\b/i.test(line)
          && /Math\.random\(\)|randomUUID\(\)/.test(line)
        ) {
          offenders.push(`${entry.name}:${index + 1}: ${line.trim()}`);
        }
      });
    }
  }

  for (const relative of roots) {
    await walk(new URL(relative, import.meta.url));
  }
  assert.deepEqual(
    offenders,
    [],
    'DOM ids come from components/dom-id.js'
  );
});

// A minted id is recognized by its form, so the page keeps nothing per id it
// mints (F123, LC-5: a set of every minted id grew for the page's life).

test('a minted id holds the reserved separator, and is recognised by it with nothing kept', async () => {
  const { isGeneratedDomId, MINTED_ID_SEPARATOR } = await import('../assets/js/app/ui/components/dom-id.js');
  assert.equal(MINTED_ID_SEPARATOR, '--');
  const id = createDomId('legend-range');
  assert.match(id, /^legend-range--[0-9a-z]+$/);
  assert.equal(isGeneratedDomId(id), true);
  // Made from a minted id: names nothing on another page either.
  assert.equal(isGeneratedDomId(`${id}-trigger`), true);
  assert.equal(isGeneratedDomId(`${id}-method-x`), true);
  // Written by hand: never.
  for (const authored of ['dataset-select', 'hp-antialias', 'categorical-field', 'a-b-c', '']) {
    assert.equal(isGeneratedDomId(authored), false, authored);
  }
  assert.equal(isGeneratedDomId(null), false);
  // No prefix may forge the separator.
  assert.throws(() => createDomId('a--b'), /prefix/);
  assert.throws(() => createDomId('trailing-'), /prefix/);
  const source = readFileSync(new URL('../assets/js/app/ui/components/dom-id.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /new (?:Set|Map|WeakMap|WeakSet)\b/, 'nothing is kept per minted id');
});

/** Every file under `dir` whose name ends with one of `extensions`. */
function filesUnder(dir, extensions) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      out.push(...filesUnder(full, extensions));
    } else if (extensions.some(extension => entry.name.endsWith(extension))) {
      out.push(full);
    }
  }
  return out;
}

test('no id written by hand holds the minted separator, so only a minted id is taken for one', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pages = readdirSync(root).filter(name => name.endsWith('.html')).map(name => path.join(root, name));
  const sources = filesUnder(path.join(root, 'assets', 'js'), ['.js', '.mjs']);
  // An id as a literal: an HTML attribute, a property, a record field, an
  // attribute set, or an id looked up by name.
  const literal = [
    /\bid\s*=\s*"([^"$]*)"/g,
    /\bid\s*=\s*'([^'$]*)'/g,
    /\.id\s*=\s*['"`]([^'"`$]*)['"`]/g,
    /\bid:\s*['"`]([^'"`$]*)['"`]/g,
    /setAttribute\(\s*['"]id['"]\s*,\s*['"`]([^'"`$]*)['"`]/g,
    /getElementById\(\s*['"`]([^'"`$]*)['"`]/g,
    /querySelector(?:All)?\(\s*['"`]#([\w-]+)/g,
  ];
  const offenders = [];
  for (const file of [...pages, ...sources]) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of literal) {
      for (const match of text.matchAll(pattern)) {
        if (match[1].includes('--')) offenders.push(`${path.relative(root, file)}: ${match[1]}`);
      }
    }
  }
  assert.ok(pages.includes(path.join(root, 'index.html')));
  assert.deepEqual(offenders, []);
});
