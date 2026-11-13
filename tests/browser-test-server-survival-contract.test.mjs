/**
 * @fileoverview The static server the browser suite runs against must outlive
 * anything a client does to it.
 *
 * A server process that ends silently makes a whole bounded batch of specs
 * fail with `net::ERR_CONNECTION_REFUSED` in a spec unrelated to the cause,
 * with no message saying why. Three ways a client could end it, none of which
 * prints anything a reader could act on: `serve()` handed straight to
 * `createServer()` as an `async` function has nowhere to send a rejection but
 * `unhandledRejection`, which ends a Node process; a response object with no
 * `error` listener raises an unhandled stream error on a write to a reset
 * socket; and a bind-failure handler registered permanently rather than for
 * the bind lets any later server error reach `process.exit(1)` through it.
 *
 * This holds the server to surviving the abort shapes the suite actually
 * produces, and to still refusing a port it cannot take - the one exit that
 * must remain.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { connect, createServer } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BROWSER_TEST_PORT_VARIABLE,
  BROWSER_TEST_SAMPLE_PORT_VARIABLE,
} from '../scripts/browser-test-ports.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER_SCRIPT = path.join(
  REPOSITORY_ROOT,
  'scripts',
  'serve-browser-tests.mjs'
);
const HOST = '127.0.0.1';

/** One port pair nothing else in this process is using. */
async function reservePortPair() {
  const ports = [];
  const holders = [];
  for (let index = 0; index < 2; index++) {
    const holder = createServer();
    holder.listen(0, HOST);
    await once(holder, 'listening');
    ports.push(holder.address().port);
    holders.push(holder);
  }
  await Promise.all(
    holders.map(holder => new Promise(resolve => holder.close(resolve)))
  );
  return ports;
}

async function startServer() {
  const [port, samplePort] = await reservePortPair();
  const child = spawn(process.execPath, [SERVER_SCRIPT], {
    cwd: REPOSITORY_ROOT,
    env: {
      ...process.env,
      [BROWSER_TEST_PORT_VARIABLE]: String(port),
      [BROWSER_TEST_SAMPLE_PORT_VARIABLE]: String(samplePort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr = [];
  child.stderr.on('data', chunk => stderr.push(String(chunk)));

  const listening = new Promise((resolve, reject) => {
    let seen = '';
    const onData = chunk => {
      seen += String(chunk);
      if (seen.includes(`http://${HOST}:${samplePort}`)) {
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.once('exit', code => {
      reject(new Error(`server exited with ${code}: ${stderr.join('')}`));
    });
    setTimeout(() => reject(new Error('server never announced a port')), 20_000)
      .unref();
  });
  await listening;
  return { child, port, samplePort, stderr };
}

/** Whether the server still answers a complete request. */
async function isAlive(port) {
  const response = await fetch(`http://${HOST}:${port}/index.html`, {
    cache: 'no-store',
  });
  const body = await response.arrayBuffer();
  return response.ok && body.byteLength > 0;
}

/** Reset the connection the instant the response head arrives. */
function abortMidResponse(port, requestPath) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, HOST, () => {
      socket.write(
        `GET ${requestPath} HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`
      );
    });
    socket.once('data', () => {
      // A reset rather than a graceful close: this is the shape of an aborted
      // fetch, and it is what reached the server as ECONNRESET mid-write.
      socket.resetAndDestroy();
      resolve();
    });
    socket.on('error', () => resolve());
    socket.setTimeout(10_000, () => {
      socket.destroy();
      reject(new Error('server never answered'));
    });
  });
}

test('the browser-test server survives every abort a spec can cause', async t => {
  const server = await startServer();
  t.after(() => {
    server.child.kill('SIGKILL');
  });

  assert.equal(await isAlive(server.port), true, 'server must start alive');

  // The exact shapes the suite produces: a reset while a large file streams, a
  // reset on a small one, and a reset against the CORS sample origin.
  for (let attempt = 0; attempt < 3; attempt++) {
    await abortMidResponse(server.port, '/index.html');
    await abortMidResponse(server.port, '/cellucid-web-assets.json');
    await abortMidResponse(server.samplePort, '/index.html');
  }

  // A malformed request line, which reaches `clientError` rather than `serve`.
  await new Promise(resolve => {
    const socket = connect(server.port, HOST, () => {
      socket.write('NOT-HTTP\r\n\r\n');
    });
    socket.on('error', () => resolve());
    socket.on('close', () => resolve());
    socket.setTimeout(5_000, () => {
      socket.destroy();
      resolve();
    });
  });

  assert.equal(
    server.child.exitCode,
    null,
    `the server exited: ${server.stderr.join('')}`
  );
  assert.equal(
    await isAlive(server.port),
    true,
    'the application origin must still answer after every abort'
  );
  assert.equal(
    await isAlive(server.samplePort),
    true,
    'the CORS sample origin must still answer after every abort'
  );
});

test('every asset of the inventory is served whole, an empty one too', async t => {
  const server = await startServer();
  t.after(() => {
    server.child.kill('SIGKILL');
  });
  // The inventory is what a Python or R host downloads from a web source; one
  // empty asset (a `.gitkeep`) once dropped the connection unanswered.
  const inventory = await (await fetch(`http://${HOST}:${server.port}/cellucid-web-assets.json`)).json();
  const empty = inventory.assets.filter(asset => asset.bytes === 0);
  assert.ok(empty.length > 0, 'the inventory lists an empty asset to serve');
  for (const asset of empty) {
    const response = await fetch(`http://${HOST}:${server.port}/${asset.path}`, { cache: 'no-store' });
    assert.equal(response.status, 200, asset.path);
    assert.equal(response.headers.get('content-length'), '0', asset.path);
    assert.equal((await response.arrayBuffer()).byteLength, 0, asset.path);
  }
  assert.equal(server.child.exitCode, null, `the server exited: ${server.stderr.join('')}`);
  assert.deepEqual(server.stderr.filter(line => /request failed/.test(line)), []);
});

test('the application origin serves one asset of every declared content type with that type and length', async t => {
  const server = await startServer();
  t.after(() => {
    server.child.kill('SIGKILL');
  });
  const origin = `http://${HOST}:${server.port}`;
  const inventoryResponse = await fetch(`${origin}/cellucid-web-assets.json`, { cache: 'no-store' });
  assert.equal(inventoryResponse.status, 200);
  assert.equal(inventoryResponse.headers.get('content-type'), 'application/json; charset=utf-8');
  const inventory = await inventoryResponse.json();
  assert.equal(inventory.version, 1);
  assert.ok(Array.isArray(inventory.assets));
  assert.equal(inventory.assets.some(asset => asset.path === 'assets/img/og-preview.jpg'), false);

  const representativeByContentType = new Map();
  for (const asset of inventory.assets) {
    if (!representativeByContentType.has(asset.content_type)) {
      representativeByContentType.set(asset.content_type, asset);
    }
  }
  assert.ok(representativeByContentType.size > 0);
  for (const asset of representativeByContentType.values()) {
    const response = await fetch(`${origin}/${asset.path}`, { method: 'HEAD', cache: 'no-store' });
    assert.equal(response.status, 200, asset.path);
    assert.equal(response.headers.get('content-type'), asset.content_type, asset.path);
    assert.equal(response.headers.get('content-length'), String(asset.bytes), asset.path);
  }
});

// The suite's server rewrites the page it serves (it names the suite's own sample catalog), and a web
// cache given this origin as its source (the Python and R packages' `--web-source-url`) verifies every
// byte it fetches against the inventory fetched from the same origin: the page must be what the
// inventory says.
test('the page the application origin serves is the one its inventory declares', async t => {
  const server = await startServer();
  t.after(() => {
    server.child.kill('SIGKILL');
  });
  const origin = `http://${HOST}:${server.port}`;
  const inventory = await (await fetch(`${origin}/cellucid-web-assets.json`, { cache: 'no-store' })).json();
  const declared = inventory.assets.find(asset => asset.path === 'index.html');
  assert.ok(declared, 'the inventory declares index.html');
  const page = Buffer.from(await (await fetch(`${origin}/index.html`, { cache: 'no-store' })).arrayBuffer());
  assert.equal(page.length, declared.bytes);
  assert.equal(createHash('sha256').update(page).digest('hex'), declared.sha256);
});

test('the CORS port serves every file of a dataset as its bytes; the application port types only the site', async t => {
  // `npm run serve`'s CORS port, documented for datasets opened by link, must not answer a
  // .loom, an .rds, an .h5mu or a MatrixMarket folder's files with 415 (no web type of their own).
  const server = await startServer();
  t.after(() => {
    server.child.kill('SIGKILL');
  });
  const classes = 'tests/fixtures/subsample-analysis/classes';
  for (const file of ['cells.loom', 'seurat.rds', 'mudata.h5mu', 'outs/filtered_feature_bc_matrix.h5', 'mtx/matrix.mtx', 'mtx/barcodes.tsv']) {
    const response = await fetch(`http://${HOST}:${server.samplePort}/${classes}/${file}`, { cache: 'no-store' });
    assert.equal(response.status, 200, file);
    assert.equal(response.headers.get('content-type'), 'application/octet-stream', file);
    assert.equal(response.headers.get('access-control-allow-origin'), '*', file);
    await response.arrayBuffer();
  }
  const site = await fetch(`http://${HOST}:${server.port}/${classes}/cells.loom`, { cache: 'no-store' });
  assert.equal(site.status, 415, 'the site port types only what the site serves');
  await site.arrayBuffer();
});

test('the server still refuses to start on an address it cannot take', async t => {
  const server = await startServer();
  t.after(() => {
    server.child.kill('SIGKILL');
  });

  // Exiting on a bind failure is the one exit that must survive the hardening:
  // a second run that silently adopted or shared the first run's port would
  // strand itself when the first run tore its server down.
  const collision = spawn(process.execPath, [SERVER_SCRIPT], {
    cwd: REPOSITORY_ROOT,
    env: {
      ...process.env,
      [BROWSER_TEST_PORT_VARIABLE]: String(server.port),
      [BROWSER_TEST_SAMPLE_PORT_VARIABLE]: String(server.samplePort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr = [];
  collision.stderr.on('data', chunk => stderr.push(String(chunk)));
  const [code] = await once(collision, 'exit');
  assert.equal(code, 1, 'a taken port must still be a startup failure');
  assert.match(stderr.join(''), /already in use|EADDRINUSE/i);
});
