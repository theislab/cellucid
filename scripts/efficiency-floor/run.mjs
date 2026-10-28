/**
 * One efficiency-floor case, in its own process: one corpus file, one
 * transport, one cell subset. The real reader (the reader worker's handler,
 * `createAnnDataReaderHandler`, with the calls the app makes) reads every
 * element the file has, step by step; each step's reads are recorded where
 * they reach the bytes (`link.mjs`) and set against the floor computed from
 * the file's layout (`floor.mjs`). Prints one JSON line. `--transport kept`
 * reads the file as a copy kept in this browser (a whole download, read
 * through its page checksums as `anndata/open.js` reads one).
 *
 *   node run.mjs --corpus DIR --file NAME [--transport local|remote|kept]
 *     [--latency 150] [--bandwidth 5] [--protocol http/1.1|h2]
 *     [--subsample '{"mode":"subsample","method":"blocks","fraction":0.1}']
 *     [--codecs codecs.json] [--root REPO]
 *
 * @module scripts/efficiency-floor/run
 */

import { openAsBlob, readdirSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { FLOOR_HOST, Recorder, installLocalRecorder, installRemoteLink } from './link.mjs';
import { classifyReads, floorOf, geneSpans, geneSpansScan, graphSpans, loadLayout, rowSpans, runsOf, spansOf } from './floor.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The reader's own messages go to stderr: stdout carries the one result line.
console.log = console.info = console.debug = (...parts) => process.stderr.write(`${parts.join(' ')}\n`);

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const corpus = path.resolve(argument('--corpus'));
const name = argument('--file');
const transport = argument('--transport', 'local');
const corpusDir = path.resolve(argument('--corpus'));
/**
 * A picked file's cost of one more read (Blob slices, as the app reads it),
 * measured here: the floor's best plan joins gaps cheaper to read than this,
 * as the app's own link measure does (`formats/io/link.js`). A local read is
 * never free: counting it so made reading a small gap look like waste.
 */
async function localReadMs() {
  const files = readdirSync(corpusDir).filter(file => /\.(h5ad|loom|h5|h5mu)$/.test(file));
  const blob = await openAsBlob(path.join(corpusDir, files[0]));
  const reads = 400;
  await blob.slice(0, 4096).arrayBuffer();
  const started = performance.now();
  for (let i = 0; i < reads; i++) {
    const at = Math.floor(((i * 2654435761) % 4294967296) / 4294967296 * Math.max(1, blob.size - 4096));
    await blob.slice(at, at + 4096).arrayBuffer();
  }
  return (performance.now() - started) / reads;
}
const latencyMs = transport === 'local' || transport === 'kept' ? await localReadMs() : Number(argument('--latency', '150'));
const bandwidthMBps = Number(argument('--bandwidth', '5'));
const protocol = argument('--protocol', 'http/1.1');
const cellSubset = JSON.parse(argument('--subsample', '{"mode":"all"}'));
const root = path.resolve(argument('--root', path.join(HERE, '..', '..')));
const codecs = JSON.parse(readFileSync(argument('--codecs', path.join(corpus, 'codecs.json')), 'utf8'));
const target = path.join(corpus, name);
const isFolder = statSync(target).isDirectory();

const recorder = new Recorder();
// `kept`: the file as a copy kept in this browser (a whole download of a host
// that serves no ranges), read as a Blob through its page checksums.
const local = transport === 'local' || transport === 'kept' ? installLocalRecorder(recorder) : null;
const remote = transport === 'remote'
  ? installRemoteLink({ root: corpus, latencyMs, bandwidthMBps, protocol, recorder })
  : null;
// A picked file is read as many requests at once as the app's local policy
// runs (`LOCAL_POLICY`): the floor's plan weighs each wave of them.
const concurrency = remote?.concurrency ?? (await import(pathToFileURL(path.join(root, 'assets/js/formats/io/byte-source.js')).href)).LOCAL_POLICY.concurrency;
// A local read's "bandwidth" is the page cache's (measured with the codecs).
const bytesPerMs = transport === 'local' || transport === 'kept' ? codecs.runtime.diskBytesPerMs : bandwidthMBps * 1e3;

async function folderFiles(folder, prefix) {
  const files = new Map();
  const walk = async (absolute, relative) => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const childAbsolute = path.join(absolute, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(childAbsolute, childRelative);
      else files.set(childRelative, local.tag(new File([await openAsBlob(childAbsolute)], entry.name), `${prefix}/${childRelative}`));
    }
  };
  await walk(folder, '');
  return files;
}

let source;
// The probe a link makes (a range HEAD and the file's head, one round trip:
// `describeRemoteFile`), counted with the opening.
const probeMark = recorder.mark();
const probeStarted = performance.now();
if (transport === 'remote' && !isFolder) {
  const { describeRemoteFile } = await import(pathToFileURL(path.join(root, 'assets/js/data/sources/remote-file.js')).href);
  const entry = await describeRemoteFile({ url: `${FLOOR_HOST}${encodeURIComponent(name)}`, id: name.replaceAll('/', '_'), name, attribution: { title: name, url: FLOOR_HOST } });
  source = { file: entry.resource };
} else if (transport === 'remote') {
  source = { url: `${FLOOR_HOST}${encodeURIComponent(name)}/`, name };
}
const probeMs = performance.now() - probeStarted;
const probeHeadReads = recorder.reads.length - probeMark;
if (transport === 'remote') {
  source = isFolder
    ? { url: `${FLOOR_HOST}${encodeURIComponent(name)}/`, name }
    : source;
} else if (transport === 'kept') {
  if (isFolder) throw new Error('a kept download is one file');
  const { pageChecksumsOf, CHECK_PAGE_BYTES } = await import(pathToFileURL(path.join(root, 'assets/js/formats/io/page-checks.js')).href);
  const sums = pageChecksumsOf(new Uint8Array(readFileSync(target)));
  const downloaded = local.tag(new File([await openAsBlob(target)], name), name);
  source = { file: { url: `${FLOOR_HOST}${encodeURIComponent(name)}`, size: downloaded.size, name,
    identity: { key: `floor:${name}`, version: `etag:${downloaded.size}` }, downloaded,
    downloadedChecks: { sums, pageBytes: CHECK_PAGE_BYTES, directory: null } } };
} else {
  source = isFolder
    ? { files: await folderFiles(target, name), rootName: name }
    : { file: local.tag(new File([await openAsBlob(target)], name), name) };
}

const worker = await import(pathToFileURL(path.join(root, 'assets/js/data/anndata-reader-worker.js')).href);
const { PieceReceiver } = await import(pathToFileURL(path.join(root, 'assets/js/utils/large-arrays.js')).href);
// The page's byte cache every reader worker reaches, as in the app
// (`data/byte-range-cache.js`, its budget from this machine's memory).
const { byteRangeCachePort } = await import(pathToFileURL(path.join(root, 'assets/js/data/byte-range-cache.js')).href);
const { adoptRangeCachePort } = await import(pathToFileURL(path.join(root, 'assets/js/formats/io/range-cache.js')).href);
const rangeCache = byteRangeCachePort();
adoptRangeCachePort(rangeCache.port);
// Arrays posted in pieces before a reply (`utils/large-arrays.js`), by request.
const pieces = new Map();
const handle = worker.createAnnDataReaderHandler({
  post: message => {
    if (message.event !== 'piece') return;
    if (!pieces.has(message.id)) pieces.set(message.id, new PieceReceiver());
    pieces.get(message.id).receive(message);
  },
});
let nextId = 1;
async function call(method, ...args) {
  const id = nextId++;
  const { reply } = await handle({ id, method, args });
  const received = pieces.get(id) ?? new PieceReceiver();
  pieces.delete(id);
  if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
  return received.resolve(reply.result);
}

// ------------------------------------------------------------ the floor's view

const layout = loadLayout(corpus, name);
const arrays = layout.arrays;
const has = p => arrays[p] !== undefined;
const family = has('/matrix') && has('/col_attrs/CellID') ? 'loom'
  : has('/matrix/indptr') ? 'tenx'
  : Object.keys(arrays).some(p => p.startsWith('/mod/')) ? 'mudata'
  : 'anndata';
const context = {
  have: new Set(),
  indexKnown: new Set(),
  layout,
  latencyMs,
  bytesPerMs,
  concurrency,
  decodeBytesPerMs: codecs.runtime.decodeBytesPerMs,
};

const steps = [];
const result = {
  file: name, family, kind: layout.kind, transport, latencyMs, bandwidthMBps, protocol: transport === 'remote' ? protocol : null,
  subsample: cellSubset, steps, error: null,
};

/** Run one step: its reads, its time, its floor and how its bytes split. */
async function step(label, spansOf, operation, { element = label } = {}) {
  const mark = recorder.mark();
  const started = performance.now();
  let error = null;
  try {
    await operation();
  } catch (caught) {
    error = caught.message;
  }
  const ms = performance.now() - started;
  const reads = recorder.since(mark);
  const spans = error === null ? spansOf() : [];
  const floor = floorOf(spans, context);
  const split = classifyReads(reads, floor.spans, layout);
  elementFloors.set(element, {
    requests: (elementFloors.get(element)?.requests ?? 0) + floor.plan.requests,
    ms: (elementFloors.get(element)?.ms ?? 0) + floor.ms,
    actualMs: (elementFloors.get(element)?.actualMs ?? 0) + ms,
  });
  for (const span of floor.spans) {
    if (!elementOfArray.has(span.array)) elementOfArray.set(span.array, element);
  }
  // The plan's bytes go where the measured bytes go: to the element that
  // first needed the step's arrays (a later step of the same arrays, the next
  // gene, counts with them).
  const planElement = floor.spans.length === 0 ? element : elementOfArray.get(floor.spans[0].array);
  planBytesByElement.set(planElement, (planBytesByElement.get(planElement) ?? 0) + floor.plan.bytes);
  for (const span of floor.spans) {
    neededByArray.set(span.array, (neededByArray.get(span.array) ?? 0) + span.end - span.start);
    if (span.heapBytes) heapByArray.set(span.array, (heapByArray.get(span.array) ?? 0) + span.heapBytes);
  }
  steps.push({
    step: label,
    element,
    error,
    actual: { bytes: reads.reduce((sum, read) => sum + read.bytes, 0), requests: reads.length, ms: Math.round(ms * 10) / 10, startedAt: Math.round(started) },
    floor: { bytes: floor.bytes, requests: floor.requests, plan: floor.plan, roundTrips: floor.roundTrips, ms: Math.round(floor.ms * 10) / 10, decodeMs: Math.round(floor.decodeMs * 10) / 10 },
    split,
  });
}

const all = n => [[0, n]];
/** The element each array was first needed for, and the floor's bytes of each array over the run. */
const elementOfArray = new Map();
const neededByArray = new Map();
/** The floor's global heap bytes of each HDF5 string array (measured: metadata, outside every chunk). */
const heapByArray = new Map();
/** Each element's floor requests and time, and its steps' measured time, summed over its steps. */
const elementFloors = new Map();
/** Each element's bytes of the floor's quickest plans, attributed as the measured bytes are. */
const planBytesByElement = new Map();

try {
  let snapshot;
  const openMark = probeMark;
  const openStarted = performance.now();
  snapshot = await call('open', { source, cellSubset });
  const openMs = performance.now() - openStarted + probeMs;
  const subset = snapshot.cellSubset;
  const nRows = subset?.nObs ?? snapshot.nObs;
  // The file rows of the open cells: original positions, through a priority
  // file's position column.
  const positions = layout.content('/obs/cellucid_original_position');
  let fileRowOf = null;
  if (positions !== null) {
    fileRowOf = new Uint32Array(positions.length);
    for (let row = 0; row < positions.length; row++) fileRowOf[positions[row]] = row;
  }
  const keptOriginal = subset?.kept ?? null;
  let keptRows;
  if (keptOriginal === null) keptRows = all(nRows);
  else {
    const rows = fileRowOf === null ? Uint32Array.from(keptOriginal) : Uint32Array.from(keptOriginal, p => fileRowOf[p]);
    rows.sort();
    keptRows = runsOf(rows);
  }
  const prefix = positions !== null && keptRows.length === 1 && keptRows[0][0] === 0 ? keptRows[0][1] : null;
  result.cells = { open: snapshot.nObs, of: nRows, method: subset?.spec?.method ?? null, keptRuns: keptRows.length };
  {
    const reads = recorder.since(openMark);
    // What opening must read besides metadata: the inputs of the method.
    // (blocks are sized from metadata: `defaultBlockSize`; stratified reads
    // the field's codes, spatial the embedding, both whole).
    const method = subset?.spec?.method ?? null;
    const openSpans = [];
    const field = subset?.spec?.field ?? subset?.spec?.by ?? 'cluster';
    if (method === 'stratified' && has(`/obs/${field}/codes`)) openSpans.push(...spansOf(layout, `/obs/${field}/codes`, all(nRows)), ...spansOf(layout, `/obs/${field}/categories`, all(arrays[`/obs/${field}/categories`].shape[0])));
    if (method === 'spatial' && has('/obsm/X_umap')) openSpans.push(...spansOf(layout, '/obsm/X_umap', all(nRows)));
    const floor = floorOf(openSpans, context);
    for (const span of floor.spans) {
      if (!elementOfArray.has(span.array)) elementOfArray.set(span.array, 'subsample method input');
      neededByArray.set(span.array, (neededByArray.get(span.array) ?? 0) + span.end - span.start);
    }
    steps.push({
      step: 'open',
      element: 'open',
      error: null,
      actual: { bytes: reads.reduce((sum, read) => sum + read.bytes, 0), requests: reads.length, ms: Math.round(openMs * 10) / 10 },
      floor: { bytes: floor.bytes, requests: floor.requests, plan: floor.plan, roundTrips: floor.roundTrips, ms: Math.round(floor.ms * 10) / 10, decodeMs: Math.round(floor.decodeMs * 10) / 10 },
      split: classifyReads(reads, floor.spans, layout),
    });
  }
  // Let reads started at open in the background settle into their own step.
  await call('prepareMatrix', 'X').catch(() => {});
  const metadataMark = recorder.mark();
  const metadata = await call('getDatasetMetadata');
  const probes = await call('probeMapping');
  if (recorder.since(metadataMark).length > 0) {
    steps.push({ step: 'metadata and probes', element: 'uns', error: null,
      actual: { bytes: recorder.since(metadataMark).reduce((s, r) => s + r.bytes, 0), requests: recorder.since(metadataMark).length, ms: 0 },
      floor: { bytes: 0, requests: 0, roundTrips: 0, ms: 0, decodeMs: 0 }, split: classifyReads(recorder.since(metadataMark), [], layout) });
  }

  // ------------------------------------------------------------- obs
  const obsBase = family === 'loom' ? '/col_attrs' : '/obs';
  const fieldArrays = key => {
    const candidates = [`${obsBase}/${key}`];
    const colon = key.indexOf(':');
    if (colon > 0) candidates.push(`/mod/${key.slice(0, colon)}/obs/${key.slice(colon + 1)}`);
    for (const base of candidates) {
      if (has(`${base}/codes`)) return [`${base}/codes`, `${base}/categories`];
      if (has(base)) return [base];
    }
    return [];
  };
  const kindOf = key => {
    const [first] = fieldArrays(key);
    if (first === undefined) return null;
    if (first.endsWith('/codes')) return 'categorical';
    const dtype = arrays[first].dtype;
    if (dtype === 'vlen' || /str|object|^\|S|^\|O/.test(dtype)) return 'string';
    if (/bool|\|b1/.test(dtype)) return 'bool';
    return 'continuous';
  };
  const byKind = {};
  for (const key of snapshot.obsKeys) {
    const kind = kindOf(key);
    if (kind !== null && byKind[kind] === undefined) byKind[kind] = key;
  }
  for (const kind of ['categorical', 'continuous', 'string', 'bool']) {
    const key = byKind[kind];
    if (key === undefined) continue;
    await step(`obs ${kind} (${key})`, () => fieldArrays(key).flatMap(p => (p.endsWith('/categories') ? spansOf(layout, p, all(arrays[p].shape[0])) : spansOf(layout, p, keptRows))),
      () => call('getObsField', key), { element: `obs ${kind}` });
  }

  // ------------------------------------------------------------- obsm
  const obsmPath = key => {
    const colon = key.indexOf(':');
    const modality = colon > 0 ? [`/mod/${key.slice(0, colon)}/obsm/${key.slice(colon + 1)}`] : [];
    return [...modality, `/obsm/${key}`, `${obsBase}/${key}`].find(has) ?? null;
  };
  const denseObsm = probes.obsm.filter(entry => entry.storage === 'dense' && entry.numeric !== false && entry.shape?.length === 2);
  const embeddings = denseObsm.filter(entry => entry.shape[1] <= 3 && !entry.key.startsWith('velocity'));
  for (const entry of embeddings) {
    const p = obsmPath(entry.key);
    const columns = Array.from({ length: entry.shape[1] }, (_, i) => i);
    await step(`obsm ${entry.key} (${entry.shape[1]}D)`, () => (p === null ? [] : spansOf(layout, p, keptRows)),
      () => call('readEmbedding', entry.key, columns, false), { element: `obsm ${entry.shape[1]}D` });
  }
  if (embeddings.length > 1) {
    const back = embeddings[0];
    const p = obsmPath(back.key);
    await step(`obsm switch back to ${back.key}`, () => (p === null ? [] : spansOf(layout, p, keptRows)),
      () => call('readEmbedding', back.key, Array.from({ length: back.shape[1] }, (_, i) => i), false), { element: 'obsm switch' });
  }
  const latentEntry = denseObsm.find(entry => entry.shape[1] > 3);
  if (latentEntry) {
    const p = obsmPath(latentEntry.key);
    await step(`obsm ${latentEntry.key} 2 of ${latentEntry.shape[1]} columns`, () => (p === null ? [] : spansOf(layout, p, keptRows, [0, 2])),
      () => call('readObsmColumns', latentEntry.key, [0, 1]), { element: 'obsm latent columns' });
  }
  const velocity = denseObsm.find(entry => entry.key.startsWith('velocity'));
  if (velocity && embeddings.length > 0) {
    const p = obsmPath(velocity.key);
    await step(`vector field ${velocity.key}`, () => (p === null ? [] : spansOf(layout, p, keptRows)),
      () => call('readVectorField', velocity.key, [0, 1], { key: embeddings[0].key, columns: [0, 1] }, false), { element: 'vector field' });
  }

  // ------------------------------------------------------------- obsp
  for (const key of ['connectivities', 'distances']) {
    if (!has(`/obsp/${key}/indptr`)) continue;
    // The induced subgraph's floor: the kept rows' indices with either every
    // kept row's values (one pass) or the kept edges' values after the
    // indices (one round trip more): whichever is quicker on this link.
    const graphFloor = () => {
      const kept = graphSpans(layout, `/obsp/${key}`, keptRows, { nRows });
      if (keptOriginal === null) return kept;
      const onePass = graphSpans(layout, `/obsp/${key}`, keptRows, { nRows, allValues: true });
      const probe = spans => floorOf(spans, { ...context, have: new Set(context.have), indexKnown: new Set(context.indexKnown) }).ms;
      return probe(onePass) <= probe(kept) ? onePass : kept;
    };
    await step(`obsp ${key}`, graphFloor, () => call('getConnectivityEdges', key), { element: `obsp ${key}` });
  }

  // ------------------------------------------------------------- matrices
  const matrixGroup = element => {
    if (family === 'loom') return element === 'X' ? '/matrix' : null;
    if (family === 'tenx') return element === 'X' ? '/matrix' : null;
    const p = `/${element}`;
    return has(p) || has(`${p}/indptr`) ? p : null;
  };
  const nVarsOf = element => (element === 'X' || element.startsWith('layers/') ? snapshot.nVars : null);
  const genesOf = (count, n) => Array.from({ length: count }, (_, i) => Math.floor((i * 7919 + 13) % n));
  const geneFloor = (element, genes) => () => {
    const group = matrixGroup(element);
    if (group === null) return [];
    if (family === 'loom') {
      // Genes are rows of the Loom matrix, cells its columns.
      return genes.flatMap(g => keptRows.flatMap(([c0, c1]) => spansOf(layout, '/matrix', [[g, g + 1]], [c0, c1])));
    }
    if (family === 'tenx') return geneSpans(layout, group, genes, keptRows, { nRows: nRows });
    return geneSpans(layout, group, genes, keptRows, { nRows, prefix });
  };
  const elements = ['X', 'layers/counts', 'raw/X'].filter(element => family === 'anndata' ? matrixGroup(element) !== null : element === 'X');
  if (family === 'mudata') elements.splice(0, elements.length, ...['mod/rna/X', 'mod/prot/X'].filter(e => matrixGroup(e) !== null));
  for (const element of elements) {
    const nVars = element === 'raw/X' ? arrays['/raw/var/_index']?.shape[0] ?? snapshot.nVars
      : element.startsWith('mod/') ? (arrays[`/${element.slice(0, -2)}/var/_index`]?.shape[0] ?? snapshot.nVars) : (nVarsOf(element) ?? snapshot.nVars);
    const [first, second] = genesOf(2, nVars);
    await step(`${element} first gene`, geneFloor(element, [first]), () => call('getMatrixColumn', element, first), { element: `${element} gene` });
    if (element === 'X' || element === 'mod/rna/X') {
      await step(`${element} next gene`, geneFloor(element, [second]), () => call('getMatrixColumn', element, second), { element: `${element} next gene` });
      const hundred = genesOf(102, nVars).slice(2);
      await step(`${element} 100 genes`, geneFloor(element, hundred), () => call('getMatrixColumns', element, hundred), { element: `${element} 100 genes` });
      const set = genesOf(122, nVars).slice(102);
      await step(`${element} gene set of 20`, geneFloor(element, set), () => call('getMatrixColumns', element, set), { element: `${element} gene set` });
    }
  }
  // The scan floor of a gene-major gene for a subsample, beside the searched one.
  if (family === 'anndata' && has('/X/indptr') && arrays['/X/indptr'].shape[0] !== nRows + 1 && prefix === null && keptOriginal !== null) {
    const genes = genesOf(1, snapshot.nVars);
    const scan = floorOf(geneSpansScan(layout, '/X', genes, keptRows, { nRows }), { ...context, have: new Set(), indexKnown: new Set(context.indexKnown) });
    result.cscScanFloor = { bytes: scan.bytes, requests: scan.requests };
  }

  // ------------------------------------------------------------- var, uns, outliers
  await step('var names', () => (has('/var/_index') ? spansOf(layout, '/var/_index', all(arrays['/var/_index'].shape[0])) : []),
    () => call('readVarNames', family === 'mudata' ? 'mod/rna' : 'X', null), { element: 'var names' });
  if (has('/var/highly_variable')) {
    await step('var flags', () => spansOf(layout, '/var/highly_variable', all(arrays['/var/highly_variable'].shape[0])),
      () => call('readVarFlags', 'X', 'highly_variable'), { element: 'var flags' });
  }
  const stored = metadata?.cellucid?.outlierQuantiles ?? null;
  const storedField = Object.keys(stored?.fields ?? {})[0];
  if (storedField !== undefined) {
    const p = `/uns/cellucid/outlierQuantiles/fields/${storedField}`;
    await step(`stored outlier quantiles (${storedField})`, () => spansOf(layout, p, keptRows), () => call('readStoredOutlierQuantiles', storedField), { element: 'stored outliers' });
  }

  // ------------------------------------------------------------- analysis
  if (family === 'anndata' && byKind.categorical !== undefined && has(`/obs/${byKind.categorical}/codes`)) {
    const field = await call('getObsField', byKind.categorical);
    const sizes = new Float64Array(field.categories.length);
    for (const code of field.codes) if (code >= 0) sizes[code]++;
    const [a, b] = Array.from(sizes.keys()).sort((x, y) => sizes[y] - sizes[x] || x - y);
    const cells = [];
    field.codes.forEach((code, cell) => { if (code === a || code === b) cells.push(cell); });
    const genes = Array.from({ length: snapshot.nVars }, (_, g) => g);
    const codes = layout.content(`/obs/${byKind.categorical}/codes`);
    const deRows = () => {
      const kept = new Uint8Array(nRows);
      for (const [r0, r1] of keptRows) kept.fill(1, r0, r1);
      const rows = [];
      for (let r = 0; r < nRows; r++) if (kept[r] && (codes[r] === a || codes[r] === b)) rows.push(r);
      return runsOf(rows);
    };
    await step('DE, two largest groups, every gene', () => rowSpans(layout, '/X', deRows(), { nRows, prefix }),
      () => call('getMatrixCellSubset', 'X', cells, genes), { element: 'DE' });
    // A group against the rest (markers) of a subsample: every open cell,
    // the last among them; over every cell of the file it reads all of X.
    if (keptOriginal !== null) {
      const every = Array.from({ length: snapshot.nObs }, (_, cell) => cell);
      await step('DE, a group against the rest, every gene', () => rowSpans(layout, '/X', keptRows, { nRows, prefix }),
        () => call('getMatrixCellSubset', 'X', every, genes), { element: 'DE, every cell' });
    }
  }
} catch (error) {
  result.error = error.stack ?? error.message;
}
// Over the whole run, by element: every byte read of an element's arrays
// (whichever step read it: reads ahead, at open, in the background)
// against the floor's bytes of those arrays.
{
  // The probe's head read (a link's first bytes, `HEAD_BYTES`, read before
  // the format is known) is its own line, not an element's.
  const reads = recorder.reads.slice(transport === 'remote' && !isFolder ? probeHeadReads : 0);
  const headBytes = recorder.reads.slice(0, transport === 'remote' && !isFolder ? probeHeadReads : 0).reduce((sum, read) => sum + read.bytes, 0);
  const byArray = classifyReads(reads, [], layout).overfetch;
  // Requests touching each element's arrays.
  const requestsOf = new Map();
  const index = new Map();
  for (const [arrayPath, array] of Object.entries(layout.arrays)) {
    if (array.layout !== 'chunked') continue;
    for (const entry of array.chunkMap) {
      const file = layout.kind === 'zarr' ? `${layout.name}/${entry[3]}` : layout.name;
      if (!index.has(file)) index.set(file, []);
      index.get(file).push(layout.kind === 'zarr' ? [entry[1] ?? 0, (entry[1] ?? 0) + entry[2], arrayPath] : [entry[1], entry[1] + entry[2], arrayPath]);
    }
  }
  for (const list of index.values()) list.sort((a, b) => a[0] - b[0]);
  for (const read of reads) {
    const touched = new Set();
    for (const [start, end, arrayPath] of index.get(read.file) ?? []) {
      if (start >= read.end) break;
      if (end > read.start) touched.add(elementOfArray.get(arrayPath) ?? 'needed by no step');
    }
    for (const element of touched) requestsOf.set(element, (requestsOf.get(element) ?? 0) + 1);
  }
  const elements = {};
  const add = (element, key, bytes) => {
    elements[element] ??= { actual: 0, floor: 0, arrays: {} };
    elements[element][key] += bytes;
  };
  for (const [array, bytes] of Object.entries(byArray)) {
    const element = elementOfArray.get(array) ?? 'needed by no step';
    add(element, 'actual', bytes);
    elements[element].arrays[array] = { actual: bytes, floor: neededByArray.get(array) ?? 0 };
  }
  for (const [array, bytes] of neededByArray) {
    const element = elementOfArray.get(array);
    add(element, 'floor', bytes);
    elements[element].arrays[array] ??= { actual: 0, floor: bytes };
  }
  for (const [element, count] of requestsOf) if (elements[element]) elements[element].requests = count;
  for (const [element, floor] of elementFloors) {
    if (!elements[element]) continue;
    elements[element].floorRequests = floor.requests;
    // The bytes of the quickest plan: the floor's own bytes and the gaps
    // fetching which saves more time than it costs.
    elements[element].floorPlanBytes = planBytesByElement.get(element) ?? 0;
    elements[element].floorMs = Math.round(floor.ms * 10) / 10;
    elements[element].ms = Math.round(floor.actualMs * 10) / 10;
  }
  const total = reads.reduce((sum, read) => sum + read.bytes, 0);
  const inChunks = Object.values(byArray).reduce((a, b) => a + b, 0);
  result.totals = {
    headBytes,
    bytes: total,
    requests: reads.length,
    metadataBytes: total - inChunks,
    floorBytes: [...neededByArray.values()].reduce((a, b) => a + b, 0),
    elements,
  };
}
if (process.env.RECORD_READS) result.reads = recorder.reads.map(read => [read.file, read.start, read.end, Math.round(read.t0), Math.round(read.t1)]);
result.peakRssMB = Math.round(process.resourceUsage().maxRSS / 1024);
local?.close();
remote?.close();
adoptRangeCachePort(null);
rangeCache.close();
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(0);
