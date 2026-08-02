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
import test from 'node:test';

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
