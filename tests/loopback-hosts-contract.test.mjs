/**
 * Whether a host is this machine, in its two senses (`utils/loopback.js`):
 * a loopback host a browser trusts over plain HTTP (where a secret may go:
 * `ALLOWED_ORIGINS`, a local relay) and this machine (served stores, the
 * address box, kept parts), which adds `0.0.0.0`. Exact tables per host
 * form; the origin allowlist answers by the first (round 9: it kept its own
 * copy, without lower-casing or a bare `::1`).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { isLoopbackHostname, isSecureContextLoopbackHost } from '../assets/js/utils/loopback.js';
import { parseOriginAllowlist } from '../assets/js/utils/origin-allowlist.js';

// host -> [trusted over plain HTTP, this machine]
const HOSTS = [
  ['localhost', true, true],
  ['LOCALHOST', true, true],
  ['LocalHost', true, true],
  ['foo.localhost', true, true],
  ['a.b.localhost', true, true],
  ['127.0.0.1', true, true],
  ['127.0.0.2', true, true],
  ['127.255.255.255', true, true],
  ['[::1]', true, true],
  ['::1', true, true],
  ['0.0.0.0', false, true],
  ['localhost.evil.com', false, false],
  ['localhost.example', false, false],
  ['127.0.0.1.nip.io', false, false],
  ['127.0.0.1.example', false, false],
  ['xlocalhost', false, false],
  ['localhost.', false, false],
  ['128.0.0.1', false, false],
  ['10.0.0.1', false, false],
  ['192.168.1.5', false, false],
  ['[::2]', false, false],
  ['[::]', false, false],
  ['[::ffff:7f00:1]', false, false],
  ['example.com', false, false],
  ['', false, false],
];

test('each host form: trusted over plain HTTP, and this machine', () => {
  for (const [host, trusted, here] of HOSTS) {
    assert.equal(isSecureContextLoopbackHost(host), trusted, `trusted: ${JSON.stringify(host)}`);
    assert.equal(isLoopbackHostname(host), here, `this machine: ${JSON.stringify(host)}`);
  }
});

test('an origin allowlist takes plain HTTP only on a trusted loopback host, never 0.0.0.0', () => {
  const fail = message => Object.assign(new Error(message), { refused: true });
  const answer = raw => {
    try {
      return [...parseOriginAllowlist(raw, fail)];
    } catch (error) {
      assert.equal(error.refused, true, raw);
      return 'refused';
    }
  };
  const allowed = [
    'http://localhost:8000',
    'http://foo.localhost:8000',
    'http://127.0.0.1:8000',
    'http://127.0.0.2',
    'http://[::1]:3000',
    'https://app.example',
    'https://0.0.0.0',
  ];
  for (const origin of allowed) assert.deepEqual(answer(origin), [origin], origin);
  for (const origin of [
    'http://0.0.0.0:8000',
    'http://localhost.evil.com',
    'http://127.0.0.1.nip.io',
    'http://192.168.1.5',
    'http://app.example',
    // The URL parser writes a host in lower case: the entry is not its own origin, so not exact.
    'http://LOCALHOST:8000',
  ]) {
    assert.equal(answer(origin), 'refused', origin);
  }
});
