import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BROWSER_TEST_PORT_VARIABLE,
  BROWSER_TEST_SAMPLE_PORT_VARIABLE,
  describePortInUse,
  resolveBrowserTestPorts,
} from './browser-test-ports.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { host, port, samplePort } = resolveBrowserTestPorts();
const inventory = JSON.parse(
  await readFile(
    path.join(repositoryRoot, 'cellucid-web-assets.json'),
    'utf8'
  )
);
if (
  inventory === null ||
  typeof inventory !== 'object' ||
  Array.isArray(inventory) ||
  inventory.version !== 1 ||
  !Array.isArray(inventory.assets)
) {
  throw new TypeError(
    'Browser-test server requires the exact web asset inventory v1.'
  );
}
const inventoryContentTypes = new Map();
for (const asset of inventory.assets) {
  if (
    asset === null ||
    typeof asset !== 'object' ||
    Array.isArray(asset) ||
    typeof asset.path !== 'string' ||
    typeof asset.content_type !== 'string' ||
    inventoryContentTypes.has(asset.path)
  ) {
    throw new TypeError(
      'Browser-test server requires unique inventory paths and content types.'
    );
  }
  inventoryContentTypes.set(asset.path, asset.content_type);
}
const contentTypes = new Map([
  ['.bin', 'application/octet-stream'],
  ['.css', 'text/css; charset=utf-8'],
  ['.f32', 'application/octet-stream'],
  ['.glb', 'model/gltf-binary'],
  ['.gz', 'application/gzip'],
  ['.h5ad', 'application/x-hdf5'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/vnd.microsoft.icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.jsonc', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.u8', 'application/octet-stream'],
  ['.u16', 'application/octet-stream'],
  ['.wasm', 'application/wasm'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.xml', 'application/xml; charset=utf-8'],
  ['.zip', 'application/zip'],
]);

function send(response, statusCode, message, allowCors) {
  const body = `${message}\n`;
  response.writeHead(statusCode, {
    ...(allowCors
      ? { 'Access-Control-Allow-Origin': '*' }
      : {}),
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'text/plain; charset=utf-8',
  });
  response.end(body);
}

async function serve(request, response) {
  const allowCors = request.socket.localPort === samplePort;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    send(response, 405, 'Method Not Allowed', allowCors);
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, `http://${host}:${port}`).pathname);
  } catch {
    send(response, 400, 'Invalid request URL', allowCors);
    return;
  }
  if (pathname === '/') pathname = '/index.html';

  const candidate = path.resolve(repositoryRoot, `.${pathname}`);
  const relative = path.relative(repositoryRoot, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    send(response, 403, 'Forbidden', allowCors);
    return;
  }

  let metadata;
  try {
    metadata = await lstat(candidate);
  } catch {
    send(response, 404, 'Not Found', allowCors);
    return;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    send(response, 404, 'Not Found', allowCors);
    return;
  }

  const extension = path.extname(candidate).toLowerCase();
  const portableRelative = relative.split(path.sep).join('/');
  const contentType = pathname === '/_cellucid/health'
    ? 'text/plain; charset=utf-8'
    : inventoryContentTypes.get(portableRelative) ??
      contentTypes.get(extension);
  if (contentType === undefined) {
    send(
      response,
      415,
      `Unsupported file type: ${extension || '(none)'}`,
      allowCors
    );
    return;
  }

  response.writeHead(200, {
    ...(allowCors
      ? { 'Access-Control-Allow-Origin': '*' }
      : {}),
    'Cache-Control': 'no-store',
    'Content-Length': metadata.size,
    'Content-Type': contentType,
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  const stream = createReadStream(candidate);
  stream.on('error', () => {
    if (!response.headersSent) {
      send(response, 500, 'Read failure', allowCors);
    } else {
      response.destroy();
    }
  });
  stream.pipe(response);
}

// A request that never reaches the client is one test's problem. A server that
// stops listening is every later test's problem, and it reports as
// `ERR_CONNECTION_REFUSED` in specs that have nothing to do with the cause --
// which is what a whole batch of community-annotation tests failing after the
// twenty-eighth one looked like. Nothing a client does may end this process.
//
// Two things could. `serve` is `async`, so anything it threw after the request
// was aborted -- writing a head to a socket the client had already reset, which
// is exactly what the publication-abort specs do on purpose -- became an
// unhandled rejection, and an unhandled rejection ends a Node process. And the
// bind-failure handler was registered permanently rather than for the bind, so
// any later server error called `process.exit(1)` through it.
function handle(request, response) {
  const abandon = () => {
    if (!response.destroyed) response.destroy();
  };
  request.on('error', abandon);
  response.on('error', abandon);
  Promise.resolve()
    .then(() => serve(request, response))
    .catch(error => {
      // A client that goes away mid-response is ordinary here and silent. Any
      // other failure is worth seeing, and neither ends the process.
      const code = error?.code;
      if (
        code !== 'ECONNRESET' &&
        code !== 'EPIPE' &&
        code !== 'ERR_STREAM_DESTROYED' &&
        code !== 'ERR_STREAM_WRITE_AFTER_END'
      ) {
        process.stderr.write(
          `Browser-test server request failed: ${error?.stack || error}\n`
        );
      }
      abandon();
    });
}

const server = createServer(handle);
const sampleServer = createServer(handle);

function reportListenFailure(error, role, listenPort, variable) {
  if (error.code === 'EADDRINUSE') {
    process.stderr.write(`${describePortInUse(role, listenPort, variable)}\n`);
  } else {
    process.stderr.write(
      `Browser-test ${role} server cannot bind ${host}:${listenPort}: ` +
        `${error.stack || error}\n`
    );
  }
  // Exit rather than close(): the peer server may already be listening, and a
  // half-bound pair would leave the run waiting for an address that will never
  // answer.
  process.exit(1);
}

/**
 * Bind one server, exiting only if the address itself cannot be taken.
 *
 * The bind handler is `once` and is removed the moment the socket is listening,
 * so a runtime error afterwards is reported and survived rather than being
 * routed into `process.exit(1)` by a handler that outlived its purpose.
 */
function listenOnce(activeServer, role, listenPort, variable, announce) {
  const onBindFailure = error => {
    reportListenFailure(error, role, listenPort, variable);
  };
  activeServer.once('error', onBindFailure);
  activeServer.on('clientError', (_error, socket) => {
    if (!socket.destroyed) socket.destroy();
  });
  activeServer.listen(listenPort, host, () => {
    activeServer.removeListener('error', onBindFailure);
    activeServer.on('error', error => {
      process.stderr.write(
        `Browser-test ${role} server error: ${error.stack || error}\n`
      );
    });
    process.stdout.write(announce);
  });
}

listenOnce(
  server,
  'application',
  port,
  BROWSER_TEST_PORT_VARIABLE,
  `Browser-test server listening on http://${host}:${port}\n`
);
listenOnce(
  sampleServer,
  'CORS sample',
  samplePort,
  BROWSER_TEST_SAMPLE_PORT_VARIABLE,
  `CORS sample server listening on http://${host}:${samplePort}\n`
);

// Last line of defence. Every path above is handled, but a static server that
// dies takes an entire batch with it and reports the death nowhere near its
// cause, so an escape is logged and survived rather than fatal.
process.on('uncaughtException', error => {
  process.stderr.write(
    `Browser-test server uncaught: ${error?.stack || error}\n`
  );
});
process.on('unhandledRejection', reason => {
  process.stderr.write(
    `Browser-test server unhandled rejection: ${reason?.stack || reason}\n`
  );
});

function shutdown() {
  for (const activeServer of [server, sampleServer]) {
    activeServer.close(error => {
      if (error) {
        process.stderr.write(`${error.stack || error}\n`);
        process.exitCode = 1;
      }
    });
    // close() alone only stops new connections; a browser holding a keep-alive
    // socket would keep the event loop -- and the run's teardown -- waiting.
    activeServer.closeAllConnections();
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
