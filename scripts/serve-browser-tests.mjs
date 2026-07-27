import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = '127.0.0.1';
const port = 4173;
const samplePort = 4174;
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
  ['.ico', 'image/x-icon'],
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

const server = createServer(serve);
const sampleServer = createServer(serve);

server.on('error', error => {
  throw error;
});
server.listen(port, host, () => {
  process.stdout.write(`Browser-test server listening on http://${host}:${port}\n`);
});
sampleServer.on('error', error => {
  throw error;
});
sampleServer.listen(samplePort, host, () => {
  process.stdout.write(
    `CORS sample server listening on http://${host}:${samplePort}\n`
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
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
