/**
 * The contract suite never reaches the network (`scripts/network-guard-preload.mjs`):
 * `npm test` preloads the guard into every test file's process, a request
 * to any host but this machine's loopback is refused before a lookup, and
 * the file that made it fails naming the URL -- even when the code caught
 * the refusal, or made the request after its test had ended. A test whose
 * subject is a real host allows it by name for its own duration only
 * (`tests/helpers/real-network.mjs`).
 *
 * Every refusal here is made in a run of its own (a refusal fails the file
 * it is made in, this one included), and that run's outcome is checked.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isLoopbackHost } from '../scripts/network-guard-preload.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GUARD = pathToFileURL(path.join(ROOT, 'scripts', 'network-guard-preload.mjs')).href;
const REAL_NETWORK = pathToFileURL(path.join(ROOT, 'tests', 'helpers', 'real-network.mjs')).href;

/** Run test files (name -> source) under the guard as a run of their own: its exit status and output. */
function guardedRun(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cellucid-network-guard-'));
  try {
    const paths = Object.entries(files).map(([name, source]) => {
      const file = path.join(dir, name);
      writeFileSync(file, source);
      return file;
    });
    // Not a part of this run (`node --test` marks its files' processes).
    const { NODE_TEST_CONTEXT: _part, ...env } = process.env;
    // One reporter on every Node version (22 reports TAP to a pipe).
    const run = spawnSync(process.execPath, ['--import', GUARD, '--test', '--test-reporter=spec', ...paths], { encoding: 'utf8', timeout: 60_000, env });
    return { status: run.status, output: `${run.stdout}\n${run.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const failed = (output, name) => new RegExp(`✖ .*${name.replace('.', '\\.')}`).test(output);

test('npm test preloads the guard into every test file\'s process', () => {
  // This file runs under it: its fetch is the guard's.
  assert.equal(globalThis.fetch.name, 'guardedFetch');
});

test('loopback is this machine; every other host is not', () => {
  for (const host of ['localhost', 'LOCALHOST', 'deployed.localhost', '127.0.0.1', '127.8.9.10', '::1', '[::1]', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of ['data.example.org', 'huggingface.co', '10.0.0.1', '192.168.1.2', '0.0.0.0', 'localhost.example.org', '128.0.0.1', '']) {
    assert.equal(isLoopbackHost(host), false, host);
  }
});

test('a request to a real host is refused at once, naming it, by fetch and by a socket alike; a test allows a host by name for itself only', () => {
  const { status, output } = guardedRun({
    'refusals.test.mjs': `
import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { allowRealHost } from '${REAL_NETWORK}';

test('fetch', async () => {
  await assert.rejects(fetch('https://data.example.org/atlas.h5ad', { method: 'HEAD' }), error => {
    assert.ok(error instanceof TypeError);
    // A refused connection, as code that tells network failures apart sees one.
    assert.match(error.message, /^fetch failed: .*https:\\/\\/data\\.example\\.org\\/atlas\\.h5ad is not this machine/);
    return true;
  });
});

test('socket', async () => {
  const socket = net.connect(443, 'data.example.org');
  const error = await new Promise(resolve => socket.once('error', resolve));
  assert.equal(error.code, 'ECONNREFUSED');
  assert.match(error.message, /data\\.example\\.org:443 is not this machine/);
});

test('opt-in', async t => {
  // Stopped before it starts: nothing leaves this machine even when the
  // guard lets it through (the platform's AbortError, not a refusal).
  const stopped = AbortSignal.abort();
  await t.test('allowed', async st => {
    allowRealHost(st, 'real-host.invalid');
    await assert.rejects(fetch('http://real-host.invalid/', { signal: stopped }), { name: 'AbortError' });
  });
  await assert.rejects(fetch('http://real-host.invalid/', { signal: stopped }), /not this machine/);
});
`,
  });
  // Every check held inside the run; the file still fails, for its refusals.
  assert.match(output, /✔ fetch/);
  assert.match(output, /✔ socket/);
  assert.match(output, /✔ opt-in/);
  assert.notEqual(status, 0);
  assert.match(output, /asked the network 3 times/);
  for (const what of ['https://data.example.org/atlas.h5ad', 'data.example.org:443', 'http://real-host.invalid/']) assert.ok(output.includes(`  ${what}\n`), what);
});

test('a file that asked the network fails, naming the URL, even when the request was caught or came after its test ended', () => {
  const { status, output } = guardedRun({
    'leaks.test.mjs': `
import test from 'node:test';
test('passes, and its read goes on after it', () => {
  setTimeout(() => fetch('https://leftover.example.org/X/indptr/0').catch(() => {}), 20);
});
test('catches its refusal', async () => {
  await fetch('https://caught.example.org/a').catch(() => {});
});
`,
    'clean.test.mjs': "import test from 'node:test';\ntest('loopback only', () => {});\n",
  });
  assert.notEqual(status, 0, 'the run fails');
  assert.match(output, /https:\/\/leftover\.example\.org\/X\/indptr\/0/);
  assert.match(output, /https:\/\/caught\.example\.org\/a/);
  assert.ok(failed(output, 'leaks.test.mjs'), 'the file that asked fails');
  assert.ok(!failed(output, 'clean.test.mjs'), 'a file that did not ask passes');
});
