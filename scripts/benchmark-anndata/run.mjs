/**
 * One benchmark run, in its own process: one reader implementation, one
 * file, one way of reaching it. Prints one JSON line with what each step took.
 *
 *   node run.mjs --root REPO --implementation current|earlier --file PATH --mode local|remote
 *     [--latency MS] [--bandwidth MBPS] [--protocol http/1.1|h2] [--streams N]
 *
 * `--root` is a checkout of the web app: the current one, or an earlier
 * revision (the orchestrator checks one out to measure the earlier reader).
 * Either implementation is driven through its own reader-worker handler
 * (`createAnnDataReaderHandler`), with the same calls the app makes, in the
 * same order; an earlier revision must speak the same worker protocol
 * (`open({source})`).
 *
 * Bytes reach the reader the way they do in a browser:
 * - local: `File` slices, read asynchronously (each slice read counts as a
 *   request, its bytes as fetched);
 * - remote: `fetch` over a simulated link with a fixed round-trip latency and
 *   a shared bandwidth (concurrent requests overlap their latency), served
 *   from the same file. The host speaks `--protocol`:
 *   - `http/1.1` (the default): a web server such as nginx. A browser keeps
 *     six connections to one host, so six requests are answered at once and
 *     the rest wait in the browser's queue, first come first served. Ranges
 *     of every form are served, suffix ranges (`bytes=-N`) included.
 *   - `h2`: GitHub (Pages, raw, media), as measured: one HTTP/2 connection
 *     whose `SETTINGS_MAX_CONCURRENT_STREAMS` is 100 (`--streams`), so 100
 *     requests are answered at once and the rest wait in the browser's
 *     queue; every CORS preflight is refused, so a range that is not a plain
 *     `bytes=a-b` (a suffix range) fails as a network error and never
 *     reaches the host.
 *   Like a host that sends no `Timing-Allow-Origin`, neither tells the
 *   reader its protocol. A `HEAD` costs a round trip and answers the size.
 */

import { closeSync, openAsBlob, openSync, readSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const root = path.resolve(argument('--root'));
const file = path.resolve(argument('--file'));
const mode = argument('--mode', 'local');
const latencyMs = Number(argument('--latency', '80'));
const bandwidthBytesPerMs = Number(argument('--bandwidth', '50')) * 1e6 / 1000;
const protocol = argument('--protocol', 'http/1.1');
if (protocol !== 'http/1.1' && protocol !== 'h2') throw new Error('--protocol is http/1.1 or h2');
/**
 * Requests the browser has on the wire to the host at once: six connections
 * over HTTP/1.1; over HTTP/2 the host's concurrent stream limit (GitHub: 100).
 */
const connections = protocol === 'http/1.1' ? 6 : Number(argument('--streams', '100'));
let onWire = 0;
const waitingForConnection = [];
async function connection() {
  if (onWire < connections) {
    onWire++;
    return;
  }
  await new Promise(resolve => waitingForConnection.push(resolve));
}
function releaseConnection() {
  const next = waitingForConnection.shift();
  if (next) next();
  else onWire--;
}
const isZarrFolder = statSync(file).isDirectory();
const name = path.basename(file);

// ------------------------------------------------------------------ the link

const counters = { requests: 0, bytes: 0 };
let linkFreeAt = 0;
/** When a transfer of `bytes` asked for now would finish, sharing one link. */
function transferEnd(bytes) {
  const now = performance.now();
  const start = Math.max(now + latencyMs, linkFreeAt);
  linkFreeAt = start + bytes / bandwidthBytesPerMs;
  return linkFreeAt;
}
function readRange(fd, start, end) {
  const bytes = new Uint8Array(end - start);
  readSync(fd, bytes, 0, bytes.length, start);
  return bytes;
}
const fds = new Map();
function fdOf(target) {
  if (!fds.has(target)) fds.set(target, openSync(target, 'r'));
  return fds.get(target);
}
function localPathOfUrl(url) {
  const { pathname } = new URL(url);
  return path.join(path.dirname(file), decodeURIComponent(pathname.slice(1)));
}

if (mode === 'remote') {
  globalThis.fetch = async (url, init = {}) => {
    await connection();
    // A request cancelled while it waited for a connection is never sent,
    // as a browser drops it from its queue.
    if (init.signal?.aborted) {
      releaseConnection();
      throw init.signal.reason ?? new DOMException('The request was aborted.', 'AbortError');
    }
    try {
      return await answer(url, init);
    } finally {
      releaseConnection();
    }
  };
  const answer = async (url, init) => {
    const target = localPathOfUrl(url);
    let size;
    try {
      size = statSync(target).size;
    } catch {
      await new Promise(resolve => setTimeout(resolve, latencyMs));
      counters.requests++;
      return new Response('', { status: 404 });
    }
    if ((init.method ?? 'GET') === 'HEAD') {
      await new Promise(resolve => setTimeout(resolve, latencyMs));
      counters.requests++;
      return new Response(null, { status: 200, headers: { 'Content-Length': String(size) } });
    }
    const asked = init.headers?.Range ?? null;
    let start = 0;
    let end = size;
    let ranged = false;
    if (asked !== null) {
      const plain = /^bytes=(\d+)-(\d*)$/.exec(asked);
      const suffix = /^bytes=-(\d+)$/.exec(asked);
      if (plain !== null) {
        start = Number(plain[1]);
        end = plain[2] === '' ? size : Math.min(size, Number(plain[2]) + 1);
        ranged = true;
      } else if (suffix !== null && protocol === 'http/1.1') {
        start = Math.max(0, size - Number(suffix[1]));
        ranged = true;
      } else {
        // GitHub refuses the CORS preflight such a range needs.
        await new Promise(resolve => setTimeout(resolve, latencyMs));
        counters.requests++;
        throw new TypeError('Failed to fetch (CORS preflight refused)');
      }
    }
    const bytes = readRange(fdOf(target), start, end);
    counters.requests++;
    counters.bytes += bytes.length;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, transferEnd(bytes.length) - performance.now())));
    return new Response(bytes, { status: ranged ? 206 : 200, headers: { 'Content-Length': String(bytes.length) } });
  };
}

// A local file is read through `Blob` slices: each read counts as a request
// and its bytes as fetched, so a local step reports what it read from disk.
if (mode === 'local') {
  const arrayBuffer = Blob.prototype.arrayBuffer;
  Blob.prototype.arrayBuffer = function countedArrayBuffer() {
    counters.requests++;
    counters.bytes += this.size;
    return arrayBuffer.call(this);
  };
}

// ------------------------------------------------------------- the sources

const remoteUrl = relative => `https://bench.local/${encodeURIComponent(relative).replaceAll('%2F', '/')}`;
function remoteFile(target) {
  return { url: remoteUrl(path.basename(target)), size: statSync(target).size, name: path.basename(target), identity: { kind: 'url' } };
}
async function localFile(target) {
  return new File([await openAsBlob(target)], path.basename(target));
}
async function folderFiles(folder) {
  const files = new Map();
  const walk = async (absolute, relative) => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const childAbsolute = path.join(absolute, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(childAbsolute, childRelative);
      else files.set(childRelative, await localFile(childAbsolute));
    }
  };
  await walk(folder, '');
  return files;
}

// ------------------------------------------------------- the implementation

const worker = await import(pathToFileURL(path.join(root, 'assets/js/data/anndata-reader-worker.js')).href);
const earlier = argument('--implementation', 'current') === 'earlier';
const handle = worker.createAnnDataReaderHandler({ post: () => {} });
let nextId = 1;
async function call(method, ...args) {
  const { reply } = await handle({ id: nextId++, method, args });
  if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
  return reply.result;
}

let source;
if (isZarrFolder) {
  source = mode === 'remote' ? { url: `${remoteUrl(name)}/`, name } : { files: await folderFiles(file), rootName: name };
} else {
  source = { file: mode === 'remote' ? remoteFile(file) : await localFile(file) };
}

// ------------------------------------------------------------------ the run

const steps = [];
async function step(label, operation) {
  const before = { ...counters };
  const started = performance.now();
  const result = await operation();
  steps.push({
    step: label,
    ms: Math.round((performance.now() - started) * 10) / 10,
    requests: counters.requests - before.requests,
    bytes: counters.bytes - before.bytes,
  });
  return result;
}

const result = { implementation: earlier ? 'earlier' : 'current', file: name, mode, latencyMs, protocol, steps, error: null };
try {
  const snapshot = await step('open', () => call('open', { source }));
  await call('prepareMatrix', 'X');
  const metadata = await step('metadata', () => call('getDatasetMetadata'));
  const probes = await call('probeMapping');
  const firstField = await step('one obs field', () => call('getObsField', snapshot.obsKeys[0]));
  const otherFields = await step('every other obs field, at once', () => Promise.all(snapshot.obsKeys.slice(1).map(key => call('getObsField', key))));
  const obsFields = [firstField, ...otherFields];
  // Embeddings and vector fields are dense obsm arrays read whole by their
  // columns, as the view reads them (`readEmbedding`): every narrow one (1-3
  // columns).
  const dense = probes.obsm.filter(entry => entry.storage === 'dense' && entry.numeric !== false && entry.shape?.length === 2);
  for (const entry of dense.filter(candidate => candidate.shape[1] <= 3)) {
    await step(`obsm ${entry.key} (${entry.shape[1]} columns)`, () => call('readEmbedding', entry.key, Array.from({ length: entry.shape[1] }, (_, i) => i), false));
  }
  // Outlier quantiles (`data/outlier-quantile-source.js`): the ones the file
  // stores, one field's array; then computed in the latent space (the stored
  // one, else the widest array), every categorical field in one pass, and
  // one more field from the kept latent space.
  {
    const stored = metadata?.cellucid?.outlierQuantiles ?? null;
    const storedFields = Object.keys(stored?.fields ?? {});
    if (storedFields.length > 0) {
      await step(`outliers stored: obs ${storedFields[0]}`, () => call('readStoredOutlierQuantiles', storedFields[0]));
    }
    const latent = dense.find(candidate => candidate.key === stored?.latentKey)
      ?? dense.filter(candidate => candidate.shape[1] > 3).sort((a, b) => b.shape[1] - a.shape[1])[0];
    const categorical = obsFields.filter(field => field?.dtype === 'categorical')
      .map(field => ({ codes: field.codes, nCategories: field.categories.length }));
    if (latent && categorical.length > 0) {
      const width = latent.shape[1];
      await step(`outliers computed in ${latent.key} (${width} columns), ${categorical.length} fields in one pass`,
        () => call('latentOutlierQuantiles', latent.key, width, categorical.map(field => ({ ...field, codes: field.codes.slice() })), 10));
      await step('outliers computed, one more field (latent kept)',
        () => call('latentOutlierQuantiles', latent.key, width, [{ ...categorical[0], codes: categorical[0].codes.slice() }], 10));
    }
  }
  const genes = Array.from({ length: 101 }, (_, i) => Math.floor((i * 7919) % snapshot.nVars));
  await step('first gene', () => call('getMatrixColumn', 'X', genes[0]));
  await step('next gene', () => call('getMatrixColumn', 'X', genes[1]));
  // An analysis asks for many genes at once.
  const batch = genes.slice(2);
  await step(`${batch.length} genes at once`, () => call('getMatrixColumns', 'X', batch));
  {
    const cells = Array.from({ length: 1000 }, (_, i) => Math.floor((i * 104729) % snapshot.nObs));
    await step('1000 cells (rows)', () => call('getMatrixRows', 'X', cells));
  }
  await step('neighbour graph', () => call('getConnectivityEdges', 'connectivities'));
  // Differential expression between two large groups, as the analysis reads
  // it (`readCellSubset`): every gene in the cells of the two largest
  // categories of the first categorical obs field that has two.
  const groups = obsFields.find(field => field?.dtype === 'categorical' && field.categories.length >= 2);
  if (groups !== undefined) {
    const sizes = new Float64Array(groups.categories.length);
    for (const code of groups.codes) if (code >= 0) sizes[code]++;
    const [a, b] = Array.from(sizes.keys()).sort((x, y) => sizes[y] - sizes[x] || x - y);
    const cells = [];
    groups.codes.forEach((code, cell) => { if (code === a || code === b) cells.push(cell); });
    const allGenes = Array.from({ length: snapshot.nVars }, (_, gene) => gene);
    await step('DE, two large groups', () => call('getMatrixCellSubset', 'X', cells, allGenes));
    result.deGroups = [sizes[a], sizes[b]];
  }
} catch (error) {
  result.error = error.message;
}
result.peakRssMB = Math.round(process.resourceUsage().maxRSS / 1024);
for (const fd of fds.values()) closeSync(fd);
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(0);
