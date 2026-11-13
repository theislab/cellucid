import { createHash } from 'node:crypto';
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
// `npm run serve` (`--published-catalog`): the app as a developer runs it on
// this machine, the page naming the published sample catalog as deployed.
// Without it, the browser tests' page, naming the suite's own catalog. Either
// way every answer is `Cache-Control: no-store`, so an edited module is the
// one the next reload runs (a server without cache headers, such as
// `python -m http.server`, lets the browser keep a module it guessed fresh).
const PUBLISHED_CATALOG_FLAG = '--published-catalog';
const unknownArguments = process.argv.slice(2).filter(argument => argument !== PUBLISHED_CATALOG_FLAG);
if (unknownArguments.length > 0) {
  throw new TypeError(`serve-browser-tests.mjs takes only ${PUBLISHED_CATALOG_FLAG}; received ${unknownArguments.join(' ')}.`);
}
const publishedCatalog = process.argv.includes(PUBLISHED_CATALOG_FLAG);
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
  ['.glb', 'model/gltf-binary'],
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

function sendBytes(request, response, bytes, contentType, allowCors) {
  response.writeHead(200, {
    ...(allowCors ? { 'Access-Control-Allow-Origin': '*' } : {}),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Length': bytes.length,
    'Content-Type': contentType,
  });
  response.end(request.method === 'HEAD' ? undefined : bytes);
}

// The page as deployed names the published sample catalog, and so does
// `npm run serve`. For the browser tests it names the suite's own: a spec's page never depends on the published site by opening
// the app (`tests/browser/helpers/outside-requests.mjs`), whatever its
// address, and a spec about another catalog still names it (`?sampleCatalog=`).
async function servedIndexPage(request) {
  const html = await readFile(path.join(repositoryRoot, 'index.html'), 'utf8');
  if (publishedCatalog) return Buffer.from(html);
  const catalog = `http://${request.headers.host}/tests/browser/fixtures/catalog/`;
  const page = html.replace(
    /(<meta name="cellucid-sample-catalog" content=")[^"]*(")/,
    (_, before, after) => before + catalog + after
  );
  if (page === html) throw new Error('index.html names no sample catalog to serve the suite\'s own in');
  return Buffer.from(page);
}

// The web asset inventory this server publishes describes the bytes it serves.
// Its `index.html` is the rewritten page above, not the file on disk, so that
// entry's SHA-256 and size are the served page's: a client that verifies the
// site against its inventory (the Python and R packages' web cache, given
// `--web-source-url` this server, the documented way to run a local build)
// accepts the page it is actually given.
async function servedInventory(request) {
  const published = JSON.parse(
    await readFile(path.join(repositoryRoot, 'cellucid-web-assets.json'), 'utf8')
  );
  const page = await servedIndexPage(request);
  const entry = published.assets?.find(asset => asset?.path === 'index.html');
  if (entry === undefined) throw new Error('The web asset inventory declares no index.html');
  entry.sha256 = createHash('sha256').update(page).digest('hex');
  entry.bytes = page.length;
  return Buffer.from(`${JSON.stringify(published, null, 2)}\n`);
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
  // Developer secrets (`.env`: API keys for the live agent tests) and the
  // repository's own metadata are never served, though they sit in the root.
  if (relative.split(path.sep).some(segment => segment === '.git' || /^\.env(?:\.|$)/.test(segment))) {
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
  // The keys of a Zarr store folder carry no extension (`.zgroup`, `X/0.0`,
  // `zarr.json`): every file below a `.zarr/` folder is served as bytes.
  // The CORS port serves datasets opened by link: every file the site does not
  // type (a .loom, an .rds, a MatrixMarket folder's matrix.mtx.gz, whatever the
  // app reads now or later) is its bytes. The application port stays exact:
  // an unknown type there is a site file the inventory has not typed.
  const contentType = pathname === '/_cellucid/health'
    ? 'text/plain; charset=utf-8'
    : inventoryContentTypes.get(portableRelative) ??
      (/\.zarr\//.test(portableRelative) ? 'application/octet-stream' : contentTypes.get(extension)) ??
      (allowCors ? 'application/octet-stream' : undefined);
  if (contentType === undefined) {
    send(
      response,
      415,
      `Unsupported file type: ${extension || '(none)'}`,
      allowCors
    );
    return;
  }

  if (portableRelative === 'index.html') {
    sendBytes(request, response, await servedIndexPage(request), contentType, allowCors);
    return;
  }
  if (portableRelative === 'cellucid-web-assets.json') {
    sendBytes(request, response, await servedInventory(request), contentType, allowCors);
    return;
  }

  // One `bytes=a-b` range, as the link source's in-place reads send, is
  // answered with 206 and that slice; anything else gets the whole file.
  const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
  const start = range === null ? 0 : Number(range[1]);
  const end = range === null ? metadata.size - 1 : Math.min(Number(range[2]), metadata.size - 1);
  if (range !== null && start > end) {
    response.writeHead(416, {
      ...(allowCors ? { 'Access-Control-Allow-Origin': '*' } : {}),
      'Content-Range': `bytes */${metadata.size}`,
    });
    response.end();
    return;
  }
  response.writeHead(range === null ? 200 : 206, {
    ...(allowCors
      ? { 'Access-Control-Allow-Origin': '*' }
      : {}),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Length': end - start + 1,
    'Content-Type': contentType,
    ...(range === null ? {} : { 'Content-Range': `bytes ${start}-${end}/${metadata.size}` }),
  });
  // An empty file (a shipped `.gitkeep`) has no byte to stream: a read
  // stream refuses `end: -1`, and the connection would drop unanswered.
  if (request.method === 'HEAD' || metadata.size === 0) {
    response.end();
    return;
  }

  const stream = createReadStream(candidate, { start, end });
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
// `ERR_CONNECTION_REFUSED` in specs that have nothing to do with the cause.
// Nothing a client does may end this process.
//
// Two things could. `serve` is `async`, so anything it throws after the request
// is aborted -- writing a head to a socket the client has already reset, which
// is exactly what the publication-abort specs do on purpose -- would be an
// unhandled rejection, and an unhandled rejection ends a Node process. And a
// bind-failure handler registered permanently rather than for the bind would
// call `process.exit(1)` on any later server error.
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

// Node closes an idle keep-alive connection after five seconds by default. A
// client that reuses that connection at the same moment gets `ECONNRESET`;
// browsers retry such a request transparently, but Playwright's `route.fetch`
// does not, so a spec proxying through it would fail at random. Idle connections
// are kept far longer than any spec waits between requests, and the header
// deadline must exceed the keep-alive one.
for (const activeServer of [server, sampleServer]) {
  activeServer.keepAliveTimeout = 120_000;
  activeServer.headersTimeout = 121_000;
}

let bindFailed = false;

function reportListenFailure(error, role, listenPort, variable) {
  if (error.code === 'EADDRINUSE') {
    process.stderr.write(`${describePortInUse(role, listenPort, variable)}\n`);
  } else {
    process.stderr.write(
      `Browser-test ${role} server cannot bind ${host}:${listenPort}: ` +
        `${error.stack || error}\n`
    );
  }
  // The peer server may already be listening, and a half-bound pair would
  // leave the run waiting for an address that will never answer: both are
  // closed (one still binding is closed when it binds, in listenOnce) and the
  // process ends with status 1 once nothing holds it. Not process.exit():
  // Node can deadlock there, joining a V8 background thread that waits for a
  // garbage collection only the exiting main thread could run (measured:
  // 38_decisions_testing_and_hosted_runners.md).
  bindFailed = true;
  process.exitCode = 1;
  for (const activeServer of [server, sampleServer]) {
    if (activeServer.listening) activeServer.close();
    activeServer.closeAllConnections();
  }
}

/**
 * Bind one server, exiting only if the address itself cannot be taken.
 *
 * The bind handler is `once` and is removed the moment the socket is listening,
 * so a runtime error afterwards is reported and survived rather than being
 * routed into the bind-failure exit by a handler that outlived its purpose.
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
    if (bindFailed) {
      activeServer.close();
      return;
    }
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

// Last line of defense. Every path above is handled, but a static server that
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
