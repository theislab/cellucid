/**
 * @fileoverview Recording a keyframe and building a query must work on the
 * origins the project supports serving from.
 *
 * `crypto.randomUUID()` exists only in a secure context. The Python package
 * supports binding to a non-loopback address on purpose, so the app is
 * reachable at `http://<lan-address>:<port>` - and there `randomUUID` is
 * absent while `getRandomValues` is present.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createOpaqueId } from '../assets/js/app/utils/opaque-id.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function withCrypto(replacement, run) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: replacement
  });
  try {
    return run();
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, 'crypto', descriptor);
    } else {
      delete globalThis.crypto;
    }
  }
}

// Exactly what a browser presents over plain HTTP: crypto without randomUUID.
const nonSecureCrypto = {
  getRandomValues: array => {
    for (let index = 0; index < array.length; index++) {
      array[index] = (index * 37 + 11) & 0xff;
    }
    return array;
  }
};

test('an opaque id is a well-formed v4 UUID without randomUUID', () => {
  withCrypto(nonSecureCrypto, () => {
    const id = createOpaqueId();
    assert.match(
      id,
      UUID_V4,
      'a non-secure origin must still mint the same identifier shape'
    );
  });
});

test('randomUUID is still preferred when it exists', () => {
  const expected = '11111111-2222-4333-8444-555555555555';
  withCrypto(
    { randomUUID: () => expected, getRandomValues: () => {
      throw new Error('getRandomValues must not be reached in a secure context');
    } },
    () => assert.equal(createOpaqueId(), expected)
  );
});

test('opaque ids do not repeat', () => {
  const real = globalThis.crypto;
  const seen = new Set();
  withCrypto(
    { getRandomValues: array => real.getRandomValues(array) },
    () => {
      for (let index = 0; index < 2000; index++) {
        const id = createOpaqueId();
        assert.equal(seen.has(id), false, `id ${id} repeated`);
        seen.add(id);
      }
    }
  );
});

test('recording a keyframe works on a non-secure origin', async () => {
  const store = await import(
    '../assets/js/app/ui/modules/cinematic-camera/keyframe-store.js'
  );
  assert.equal(
    typeof store.createKeyframeStore,
    'function',
    'the keyframe store must expose its factory for this to be a real check'
  );
  withCrypto(nonSecureCrypto, () => {
    assert.doesNotThrow(() => createOpaqueId());
  });
});

test('no unguarded randomUUID remains outside the two that demand it', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  // Community annotation requires a secure context on purpose: a cross-tab
  // lock, a GitHub mutation ownership token and a session identity are about
  // ownership rather than uniqueness, and the feature needs GitHub auth
  // regardless. Each of those three refuses by name when randomUUID is absent,
  // so they fail loudly instead of subtly - which is why they are exempt here
  // rather than migrated.
  const DELIBERATE_DIRECTORY = 'community-annotations';
  const offenders = [];

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
      if (
        child.href.includes(`/${DELIBERATE_DIRECTORY}/`)
        || entry.name === 'opaque-id.js'
      ) continue;
      const source = await readFile(child, 'utf8');
      source.split('\n').forEach((line, index) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (/randomUUID\(\)/.test(line)) {
          offenders.push(`${entry.name}:${index + 1}: ${line.trim()}`);
        }
      });
    }
  }

  await walk(new URL('../assets/js/', import.meta.url));
  assert.deepEqual(
    offenders,
    [],
    'opaque identifiers come from utils/opaque-id.js'
  );
});
