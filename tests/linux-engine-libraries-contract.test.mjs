/**
 * The Linux CI runner's engine libraries are fetched by
 * `scripts/install-linux-engine-libraries.mjs`, not by apt: apt cannot leave
 * a mirror connection that trickles (its timeout fires only on silence), and
 * one runner in two dozen got one. Held here: a transfer under the speed floor
 * is dropped and the package is fetched from the next mirror of the runner's
 * own mirror list, a file whose hash or size differs from the index is never
 * kept, and the apt and Playwright outputs the script reads are read right.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  candidateUris,
  fetchPackage,
  fetchPackages,
  fetchWithFloor,
  mirrorListsFrom,
  parseMissingPackages,
  parsePrintUris,
} from '../scripts/install-linux-engine-libraries.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BODY = Buffer.from('a Debian package, as far as this test is concerned\n'.repeat(400));
const SHA512 = createHash('sha512').update(BODY).digest('hex');

/**
 * A loopback mirror: `fast` serves the body, `trickle` sends a few bytes a
 * tick and never finishes (it stops short of the body's end and keeps the
 * connection open, so a client that waits it out waits for ever), `corrupt`
 * serves other bytes.
 */
async function mirror(kind) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { 'content-length': String(BODY.length) });
    if (kind === 'fast') return response.end(BODY);
    if (kind === 'corrupt') return response.end(Buffer.alloc(BODY.length, 0x21));
    let sent = 0;
    const timer = setInterval(() => {
      if (response.destroyed) return clearInterval(timer);
      if (sent + 16 >= BODY.length) return;
      response.write(BODY.subarray(sent, sent + 16));
      sent += 16;
    }, 50);
    response.on('close', () => clearInterval(timer));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/ubuntu/`;
  return { base, requests, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

function scratch(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cellucid-engine-libraries-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const PACKAGE = { uri: '', file: 'libtest_1%3a2.0-1_amd64.deb', size: BODY.length, hash: { algorithm: 'sha512', hex: SHA512 } };
// The trickling mirror sends 320 B/s; the floor is 60 times that. The loopback
// body (20 kB) arrives whole long before one window ends, on any machine.
const FAST_FLOOR = { floor: 20_000, windowMs: 1_500 };

test('a trickling mirror is dropped under the floor and the package comes from the next mirror of the list', async (t) => {
  const slow = await mirror('trickle');
  const fast = await mirror('fast');
  t.after(async () => { await slow.close(); await fast.close(); });
  const dir = scratch(t);
  const lists = mirrorListsFrom('URIs: mirror+file:/etc/apt/apt-mirrors.txt\n', () => `${slow.base}\tpriority:1\n${fast.base}\tpriority:2\n`);
  const uri = `${slow.base}pool/main/t/test/${PACKAGE.file}`;
  const dropped = [];
  // The trickle never ends: that this returns at all is the slow transfer given up, not waited out.
  await fetchPackages([{ ...PACKAGE, uri }], lists, dir, { ...FAST_FLOOR, log: (line) => dropped.push(line) });
  assert.deepEqual(readFileSync(path.join(dir, PACKAGE.file)), BODY);
  assert.ok(dropped[0].includes(slow.base), dropped[0]);
  assert.match(dropped[0], /under the 20 kB\/s floor/);
  assert.equal(slow.requests[0], `/ubuntu/pool/main/t/test/${PACKAGE.file}`);
  assert.equal(fast.requests.at(-1), `/ubuntu/pool/main/t/test/${PACKAGE.file}`);
  assert.equal(existsSync(path.join(dir, 'partial', PACKAGE.file)), false);
});

test('a pause of this process is not taken for a slow link', async (t) => {
  const fast = await mirror('fast');
  t.after(() => fast.close());
  const dir = scratch(t);
  const windowMs = 300;
  const transfer = fetchWithFloor(`${fast.base}pool/x.deb`, path.join(dir, 'x.deb'), { floor: 20_000, windowMs, hash: PACKAGE.hash });
  // The process does not run for over three windows, as on a loaded machine,
  // before the request has even been sent: its watchdog's first tick after
  // the pause comes before any byte is read, and saw a window of nothing.
  const pausedUntil = performance.now() + 3 * windowMs + 100;
  while (performance.now() < pausedUntil) { /* not running */ }
  assert.equal(await transfer, BODY.length);
  assert.deepEqual(readFileSync(path.join(dir, 'x.deb')), BODY);
});

test('a file whose hash or size differs from the index is never kept', async (t) => {
  const corrupt = await mirror('corrupt');
  const fast = await mirror('fast');
  t.after(async () => { await corrupt.close(); await fast.close(); });
  const dir = scratch(t);
  await fetchPackages([{ ...PACKAGE, uri: `${corrupt.base}pool/x.deb` }], mirrorListsFrom('mirror+file:/m.txt', () => `${corrupt.base}\n${fast.base}\n`), dir, FAST_FLOOR);
  assert.deepEqual(readFileSync(path.join(dir, PACKAGE.file)), BODY);

  const only = scratch(t);
  await assert.rejects(
    fetchPackages([{ ...PACKAGE, uri: `${corrupt.base}pool/x.deb` }], [], only, { ...FAST_FLOOR, attempts: 2 }),
    /could not be fetched:[\s\S]*sha512 differs from the index[\s\S]*sha512 differs/,
  );
  assert.equal(existsSync(path.join(only, PACKAGE.file)), false);
  await assert.rejects(
    fetchPackage({ ...PACKAGE, size: BODY.length + 1 }, [`${fast.base}pool/x.deb`], only, { ...FAST_FLOOR, attempts: 1, hash: null }),
    /bytes, the index says/,
  );
});

test('candidates follow the runner mirror list for both URI forms apt prints, own mirror first', () => {
  const lists = mirrorListsFrom(
    'Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: resolute\n# deb mirror+file:/etc/apt/apt-mirrors.txt resolute-updates\n',
    (file) => {
      assert.equal(file, '/etc/apt/apt-mirrors.txt');
      return '# the runner list\nhttp://azure.archive.ubuntu.com/ubuntu/\tpriority:1\nhttps://archive.ubuntu.com/ubuntu\tpriority:2\nhttps://security.ubuntu.com/ubuntu/\tpriority:3\n';
    },
  );
  assert.deepEqual(lists, [{ file: '/etc/apt/apt-mirrors.txt', bases: ['http://azure.archive.ubuntu.com/ubuntu/', 'https://archive.ubuntu.com/ubuntu/', 'https://security.ubuntu.com/ubuntu/'] }]);
  const all = ['http://azure.archive.ubuntu.com/ubuntu/pool/a.deb', 'https://archive.ubuntu.com/ubuntu/pool/a.deb', 'https://security.ubuntu.com/ubuntu/pool/a.deb'];
  assert.deepEqual(candidateUris('mirror+file:/etc/apt/apt-mirrors.txt/pool/a.deb', lists), all);
  assert.deepEqual(candidateUris('https://archive.ubuntu.com/ubuntu/pool/a.deb', lists), [all[1], all[0], all[2]]);
  assert.deepEqual(candidateUris('https://packages.microsoft.com/ubuntu/26.04/prod/pool/b.deb', lists), ['https://packages.microsoft.com/ubuntu/26.04/prod/pool/b.deb']);
  assert.throws(() => candidateUris('mirror+file:/elsewhere.txt/pool/a.deb', lists), /names a mirror list the apt sources do not/);
});

test('apt --print-uris and Playwright dry-run output are read as they are printed', () => {
  const printed = [
    "'http://azure.archive.ubuntu.com/ubuntu/pool/universe/f/fonts-ipafont/fonts-ipafont-gothic_00303-23ubuntu1_all.deb' fonts-ipafont-gothic_00303-23ubuntu1_all.deb 3703012 SHA512:" + 'ab'.repeat(64),
    "'mirror+file:/etc/apt/apt-mirrors.txt/pool/main/libp/libproxy/libproxy1v5_0.5.12-1_amd64.deb' libproxy1v5_0.5.12-1_amd64.deb 28330 SHA256:" + 'cd'.repeat(32),
    '',
  ].join('\n');
  assert.deepEqual(parsePrintUris(printed), [
    { uri: 'http://azure.archive.ubuntu.com/ubuntu/pool/universe/f/fonts-ipafont/fonts-ipafont-gothic_00303-23ubuntu1_all.deb', file: 'fonts-ipafont-gothic_00303-23ubuntu1_all.deb', size: 3703012, hash: { algorithm: 'sha512', hex: 'ab'.repeat(64) } },
    { uri: 'mirror+file:/etc/apt/apt-mirrors.txt/pool/main/libp/libproxy/libproxy1v5_0.5.12-1_amd64.deb', file: 'libproxy1v5_0.5.12-1_amd64.deb', size: 28330, hash: { algorithm: 'sha256', hex: 'cd'.repeat(32) } },
  ]);
  assert.throws(() => parsePrintUris("'http://h/p.deb' p.deb 1 SHA3:ff\n"), /unknown hash type SHA3/);

  assert.deepEqual(parseMissingPackages('Missing system dependencies (3):\n  fonts-freefont-ttf\n  libavif16\n  xvfb\n', 1), ['fonts-freefont-ttf', 'libavif16', 'xvfb']);
  assert.deepEqual(parseMissingPackages('All system dependencies are installed.\n', 0), []);
  assert.throws(() => parseMissingPackages('Missing system dependencies (3):\n  xvfb\n', 1), /counted 3 packages and listed 1/);
  assert.throws(() => parseMissingPackages("'apt-get install -s' exited with code 100", 1), /exited 1/);
});

test('the Linux browser jobs install the engine libraries through the script, not through apt downloads', () => {
  const workflow = readFileSync(path.join(ROOT, '.github', 'workflows', 'test.yml'), 'utf8');
  // The browser job anchors the step; the control-walk job repeats it by alias.
  const step = /- &install-linux-libraries\n\s+name: Install the Linux libraries the selected engine needs\n([\s\S]*?)\n\n/.exec(workflow)?.[1];
  assert.ok(step, 'the step exists');
  assert.equal((workflow.match(/^\s+- \*install-linux-libraries$/gm) ?? []).length, 1, 'the control-walk job runs the same step');
  assert.match(step, /run: node scripts\/install-linux-engine-libraries\.mjs \$\{\{ matrix\.browser \}\}/);
  assert.doesNotMatch(workflow, /playwright install-deps/);
});
