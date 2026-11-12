/**
 * @fileoverview Bytes become text in one place (F242, round 9).
 *
 * `utils/byte-text.js` writes bytes as lowercase hex, base64 and base64url
 * and reads them back; `utils/sha256.js` is the one SHA-256 (WebCrypto where
 * there is one, the same digest in script on a plain-HTTP origin). Before,
 * a folder's identity (`local-file-handles.js` `heldBy`), a kept store's
 * directory (`transcode/space.js` `identityDigest`), the AnnData copy's state
 * digest and a sign-in's PKCE challenge each called `crypto.subtle.digest`
 * themselves and failed on `http://<lan-address>` (no `crypto.subtle`), and
 * the hex and base64 writing was copied in eighteen modules.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  base64OfBytes,
  base64UrlOfBytes,
  bytesOfBase64,
  bytesOfBase64Url,
  hexOfByteArray,
  randomHex,
} from '../assets/js/utils/byte-text.js';
import { heldBy } from '../assets/js/app/library/local-file-handles.js';
import { identityDigest, canonicalJson, cacheKey } from '../assets/js/data/anndata/transcode/space.js';
import { codeChallengeOf } from '../assets/js/data/sources/auth/pkce.js';
import { shareIdOf } from '../assets/js/data/sources/providers/onedrive.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = path.join(ROOT, 'assets', 'js');

/** What a browser presents over plain HTTP: crypto without subtle. */
async function withoutSubtle(run) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const real = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { getRandomValues: array => real.getRandomValues(array) },
  });
  try {
    return await run();
  } finally {
    Object.defineProperty(globalThis, 'crypto', descriptor);
  }
}

function sha256Of(bytes, encoding = 'hex') {
  return createHash('sha256').update(bytes).digest(encoding);
}

test('bytes as hex, base64 and base64url agree with Node at every length and every byte', () => {
  // Past three of the 0x8000-byte pieces `String.fromCharCode` is handed.
  for (const length of [0, 1, 2, 3, 31, 32, 0x8000, 0x8000 * 3 + 7]) {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index++) bytes[index] = (index * 131 + 7) & 0xff;
    const buffer = Buffer.from(bytes);
    assert.equal(hexOfByteArray(bytes), buffer.toString('hex'), `hex, ${length} bytes`);
    assert.equal(base64OfBytes(bytes), buffer.toString('base64'), `base64, ${length} bytes`);
    assert.equal(base64UrlOfBytes(bytes), buffer.toString('base64url'), `base64url, ${length} bytes`);
    assert.deepEqual(bytesOfBase64(buffer.toString('base64')), bytes);
    assert.deepEqual(bytesOfBase64Url(buffer.toString('base64url')), bytes);
  }
  assert.throws(() => hexOfByteArray([256]), /integer from 0 through 255/);
  assert.throws(() => base64OfBytes([1, 2]), /Uint8Array/);
});

test('a caller that accounts its allocations gets the bytes where it asks', () => {
  const asked = [];
  const bytes = bytesOfBase64('AAEC', length => {
    asked.push(length);
    return new Uint8Array(length);
  });
  assert.deepEqual([...bytes], [0, 1, 2]);
  assert.deepEqual(asked, [3]);
});

test('random hex has the digits asked for and is not repeated', () => {
  const drawn = new Set();
  for (let index = 0; index < 50; index++) {
    const value = randomHex(16);
    assert.match(value, /^[0-9a-f]{32}$/);
    drawn.add(value);
  }
  assert.equal(drawn.size, 50);
});

test('every digest is made on a plain-HTTP origin too (no crypto.subtle)', async () => {
  const files = [
    { webkitRelativePath: 'data/b.zarr/.zattrs', size: 12, lastModified: 3 },
    { webkitRelativePath: 'data/a.zarr/.zgroup', size: 24, lastModified: 4 },
  ];
  const lines = files.map(file => `${file.webkitRelativePath}\u0000${file.size}\u0000${file.lastModified}`).sort().join('\n');
  const identity = { kind: 'url', href: 'https://example.org/a.h5ad?X-Amz-Signature=abc' };
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

  const secure = {
    held: await heldBy('folder', files),
    directory: await identityDigest(identity),
    challenge: await codeChallengeOf(verifier),
  };
  const plain = await withoutSubtle(async () => ({
    held: await heldBy('folder', files),
    directory: await identityDigest(identity),
    challenge: await codeChallengeOf(verifier),
  }));

  const expected = {
    held: { files: 2, digest: sha256Of(lines) },
    directory: sha256Of(canonicalJson(cacheKey(identity))),
    // RFC 7636 appendix B.
    challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  };
  assert.deepEqual(secure, expected);
  assert.deepEqual(plain, expected);
});

test('a OneDrive share id is the link\'s UTF-8 bytes in base64url', () => {
  const link = 'https://1drv.ms/u/s!Abc?e=Übersicht';
  assert.equal(shareIdOf(link), `u!${Buffer.from(link, 'utf8').toString('base64url')}`);
});

/** Every page and worker module, with its path from `assets/js/`. */
function sources(directory = SOURCES, out = []) {
  for (const name of readdirSync(directory)) {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'vendor') sources(full, out);
    } else if (name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The hand-written forms of one concept, and the module that owns each.
 * A comment line is not code; the owners are named by path.
 */
const RULES = [
  { what: 'a byte written as two hex digits', pattern: /toString\(16\)\.padStart\(2\b|\(value \+ 0x100\)\.toString\(16\)/, owners: ['utils/byte-text.js', 'utils/hex-color.js'] },
  { what: 'a SHA-256 of its own (crypto.subtle.digest)', pattern: /subtle\.digest\(/, owners: ['utils/sha256.js'] },
  { what: 'base64 written or read by hand (btoa/atob)', pattern: /\b(?:btoa|atob)\(/, owners: ['utils/byte-text.js'] },
];

/**
 * Text that is not bytes: HTTP Basic credentials are a string the Worker
 * sends GitHub, not bytes it holds.
 */
const NOT_BYTES = [/Basic \$\{btoa\(`\$\{clientId\}:\$\{clientSecret\}`\)\}/];

test('no module writes bytes as text, or hashes, beside the one owner', () => {
  const offenders = [];
  for (const file of sources()) {
    const relative = path.relative(SOURCES, file).split(path.sep).join('/');
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (NOT_BYTES.some(allowed => allowed.test(line))) return;
      for (const rule of RULES) {
        if (rule.pattern.test(line) && !rule.owners.includes(relative)) {
          offenders.push(`${relative}:${index + 1}: ${rule.what} (use ${rule.owners[0]}): ${line.trim()}`);
        }
      }
    });
  }
  assert.deepEqual(offenders, []);
});
