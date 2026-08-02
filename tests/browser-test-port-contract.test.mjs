/**
 * Two browser-test runs on one machine used to be impossible: the static
 * server hard-coded 4173 and 4174 and the Playwright config hard-coded the
 * same numbers, so the second run either lost the race for the address or was
 * refused by a config that had no way to ask for a different one (CEL-0111).
 * The cost was real — a run lost its Firefox and WebKit coverage and another
 * waited about twenty-five minutes for an address that was never coming free.
 *
 * The address now comes from one module that both halves read, defaulting to
 * the numbers that were literals before so an existing run is unaffected. A
 * taken address is named, with the variable that moves it, instead of being
 * discovered as silence.
 *
 * The failure artifacts have the same shape of collision (CEL-0046): Playwright
 * empties `outputDir` when a run starts, so two runs sharing it delete each
 * other's evidence. That is what produced a stray `test-results-obj7/` at the
 * repository root, outside the ignore rule of the day. The directory is keyed
 * by port for the same reason the address is, and stays inside an ignored path.
 *
 * Moving the servers was only half the fix (CEL-0128). About a hundred absolute
 * URLs in `tests/browser/` still spelled the two ports out, most of them
 * percent-encoded inside the `exportsBaseUrl` query parameter that tells the
 * application where to fetch its fixtures. A moved run then served the page at
 * the new address and asked it for fixtures at the old one, so an overridden
 * port failed the suite instead of relieving the collision. The specs derive
 * every origin from `tests/browser/helpers/origins.mjs` now, and the sweep
 * below is what keeps a new one from reintroducing a literal.
 */

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BROWSER_TEST_HOST,
  BROWSER_TEST_PORT_VARIABLE,
  BROWSER_TEST_SAMPLE_PORT_VARIABLE,
  DEFAULT_BROWSER_TEST_PORT,
  describePortInUse,
  resolveBrowserTestPorts,
} from '../scripts/browser-test-ports.mjs';

const CONFIG_URL = new URL('../playwright.config.mjs', import.meta.url);
const SERVER_URL = new URL(
  '../scripts/serve-browser-tests.mjs',
  import.meta.url
);
const GITIGNORE_URL = new URL('../.gitignore', import.meta.url);
const BROWSER_TESTS_ROOT = fileURLToPath(
  new URL('./browser/', import.meta.url)
);
// The extensions a port can hide in. Fixture payloads are binary and carry no
// URL, so reading them would only slow the sweep down.
const SEARCHABLE_EXTENSIONS = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
]);

async function* searchableFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* searchableFiles(full);
    } else if (
      entry.isFile() &&
      SEARCHABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
    ) {
      yield full;
    }
  }
}

const [configSource, serverSource, gitignore] = await Promise.all([
  readFile(CONFIG_URL, 'utf8'),
  readFile(SERVER_URL, 'utf8'),
  readFile(GITIGNORE_URL, 'utf8'),
]);

test('the default addresses are the ones that were literals', () => {
  const ports = resolveBrowserTestPorts({});
  assert.deepEqual({ ...ports }, {
    host: '127.0.0.1',
    port: 4173,
    samplePort: 4174,
    origin: 'http://127.0.0.1:4173',
    sampleOrigin: 'http://127.0.0.1:4174',
  });
  assert.equal(DEFAULT_BROWSER_TEST_PORT, 4173);
  assert.equal(BROWSER_TEST_HOST, '127.0.0.1');

  // An empty variable is not a request for port zero.
  assert.equal(
    resolveBrowserTestPorts({ [BROWSER_TEST_PORT_VARIABLE]: '' }).port,
    4173
  );
});

test('one override moves both servers, and the sample port moves alone', () => {
  const moved = resolveBrowserTestPorts({
    [BROWSER_TEST_PORT_VARIABLE]: '4183',
  });
  assert.equal(moved.port, 4183);
  assert.equal(moved.samplePort, 4184);
  assert.equal(moved.origin, 'http://127.0.0.1:4183');
  assert.equal(moved.sampleOrigin, 'http://127.0.0.1:4184');

  const split = resolveBrowserTestPorts({
    [BROWSER_TEST_PORT_VARIABLE]: '4183',
    [BROWSER_TEST_SAMPLE_PORT_VARIABLE]: '4199',
  });
  assert.equal(split.port, 4183);
  assert.equal(split.samplePort, 4199);
});

test('an unusable address is named rather than accepted', () => {
  for (const value of ['abc', '', ' 4183', '4183.5', '-1', '80', '65536']) {
    if (value === '') continue;
    assert.throws(
      () => resolveBrowserTestPorts({ [BROWSER_TEST_PORT_VARIABLE]: value }),
      new RegExp(BROWSER_TEST_PORT_VARIABLE),
      `${JSON.stringify(value)} must be refused by name`
    );
  }

  // 65535 + 1 is not a port, and the message has to say where it came from.
  assert.throws(
    () => resolveBrowserTestPorts({ [BROWSER_TEST_PORT_VARIABLE]: '65535' }),
    /derived 65536 from CELLUCID_BROWSER_TEST_PORT=65535/
  );

  assert.throws(
    () =>
      resolveBrowserTestPorts({
        [BROWSER_TEST_PORT_VARIABLE]: '4183',
        [BROWSER_TEST_SAMPLE_PORT_VARIABLE]: '4183',
      }),
    /must differ from/
  );

  for (const blockedPort of [4190, 5060, 5061, 10080]) {
    assert.throws(
      () => resolveBrowserTestPorts({
        [BROWSER_TEST_PORT_VARIABLE]: String(blockedPort),
        [BROWSER_TEST_SAMPLE_PORT_VARIABLE]: '12000',
      }),
      new RegExp(`browser-blocked HTTP\\(S\\) port ${blockedPort}`),
    );
    assert.throws(
      () => resolveBrowserTestPorts({
        [BROWSER_TEST_PORT_VARIABLE]: '12000',
        [BROWSER_TEST_SAMPLE_PORT_VARIABLE]: String(blockedPort),
      }),
      new RegExp(`browser-blocked HTTP\\(S\\) port ${blockedPort}`),
    );
  }
});

test('a taken address reports the port and the way to move it', () => {
  const message = describePortInUse('application', 4173, BROWSER_TEST_PORT_VARIABLE);
  assert.match(message, /127\.0\.0\.1:4173/);
  assert.match(message, /already in use/);
  assert.match(message, new RegExp(BROWSER_TEST_PORT_VARIABLE));
  assert.match(message, new RegExp(BROWSER_TEST_SAMPLE_PORT_VARIABLE));
});

test('the server and the config read the address from the one module', async () => {
  for (const [name, source] of [
    ['playwright.config.mjs', configSource],
    ['scripts/serve-browser-tests.mjs', serverSource],
  ]) {
    assert.match(
      source,
      /browser-test-ports\.mjs/,
      `${name} must resolve its address from the shared module`
    );
    assert.doesNotMatch(
      source,
      /\b417[34]\b/,
      `${name} must not carry a hard-coded browser-test port`
    );
  }

  const config = (await import('../playwright.config.mjs')).default;
  const { origin } = resolveBrowserTestPorts();
  assert.equal(config.use.baseURL, origin);
  assert.equal(config.webServer.url, `${origin}/`);
  assert.equal(
    config.webServer.reuseExistingServer,
    false,
    'adopting another run\'s server would strand this run when that run ends'
  );
});

test('no browser test spells a browser-test port out', async () => {
  const { port, samplePort } = resolveBrowserTestPorts({});
  // Both the plain and the percent-encoded loopback forms, because most of
  // these addresses travel inside a query-parameter value. A bare number is not
  // enough to match on: `tests/browser` legitimately names other ports.
  const forbidden = [port, samplePort].flatMap(value => [
    `${BROWSER_TEST_HOST}:${value}`,
    `${encodeURIComponent(BROWSER_TEST_HOST)}%3A${value}`,
  ]);

  const offenders = [];
  for await (const file of searchableFiles(BROWSER_TESTS_ROOT)) {
    const source = await readFile(file, 'utf8');
    const relative = path.relative(BROWSER_TESTS_ROOT, file);
    for (const needle of forbidden) {
      if (source.includes(needle)) offenders.push(`${relative}: ${needle}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'a browser test must derive its origin from helpers/origins.mjs, ' +
      'because a run moved to a free port still serves its fixtures from ' +
      'the port it was moved to'
  );
});

test('the origins helper derives what the specs import', async () => {
  const helper = await readFile(
    path.join(BROWSER_TESTS_ROOT, 'helpers', 'origins.mjs'),
    'utf8'
  );
  assert.match(
    helper,
    /browser-test-ports\.mjs/,
    'the helper must resolve its address from the shared module'
  );

  const origins = await import('./browser/helpers/origins.mjs');
  const { host, port, samplePort, origin, sampleOrigin } =
    resolveBrowserTestPorts();
  assert.equal(origins.APP_HOST, host);
  assert.equal(origins.APP_PORT, port);
  assert.equal(origins.SAMPLE_PORT, samplePort);
  assert.equal(origins.APP_ORIGIN, origin);
  assert.equal(origins.SAMPLE_ORIGIN, sampleOrigin);
  assert.equal(
    origins.EXPORTS_BASE_URL,
    `${origin}/tests/browser/fixtures/exports/`
  );

  // The encoded form is produced by encoding the resolved URL, so moving the
  // port cannot corrupt the escape sequences around it.
  assert.equal(
    origins.ENCODED_EXPORTS_BASE_URL,
    encodeURIComponent(origins.EXPORTS_BASE_URL)
  );
  assert.equal(
    origins.encodedAppUrl('/tests/browser/fixtures/exports/'),
    origins.ENCODED_EXPORTS_BASE_URL
  );
  assert.equal(origins.appUrl('/_cellucid/health'), `${origin}/_cellucid/health`);
  assert.equal(origins.sampleUrl('/datasets.json'), `${sampleOrigin}/datasets.json`);

  // A path that is not root-relative would silently concatenate into a
  // different host, so it is refused rather than joined.
  assert.throws(() => origins.appUrl('tests/browser/'), /must be absolute/);
  assert.throws(() => origins.sampleUrl('tests/browser/'), /must be absolute/);
});

test('failure artifacts are per-run and inside an ignored path', async () => {
  const config = (await import('../playwright.config.mjs')).default;
  const { port } = resolveBrowserTestPorts();
  assert.equal(config.outputDir, `./test-results/${port}`);

  const rules = gitignore
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));
  assert.ok(
    rules.includes('/test-results*/'),
    'the ignore rule must cover every test-results output directory, ' +
      'not one exact name'
  );
});
