/**
 * @fileoverview The static server the browser suite runs against must outlive
 * anything a client does to it.
 *
 * What prompted this: a whole bounded batch of community-annotation specs
 * failed with `net::ERR_CONNECTION_REFUSED` after the twenty-eighth test in it
 * had already passed. Nothing was wrong with those specs — the server process
 * was gone, and it left no message saying why.
 *
 * That silence is the thing to fix. `serve()` was an `async` function handed
 * straight to `createServer()`, so a rejection from it had nowhere to go but
 * `unhandledRejection`, which ends a Node process; the response object had no
 * `error` listener, so a write to a reset socket raised an unhandled stream
 * error; and the bind-failure handler was registered permanently rather than
 * for the bind, so any later server error reached `process.exit(1)` through it.
 * Three ways for a client to end the server, none of which prints anything a
 * reader could act on.
 *
 * This holds the server to surviving the abort shapes the suite actually
 * produces, and to still refusing a port it cannot take — the one exit that
 * must remain. A failure that reports as `ERR_CONNECTION_REFUSED` in a spec
 * unrelated to its cause is worse than the failure itself.
 */

import assert from 'node:assert/strict';
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
