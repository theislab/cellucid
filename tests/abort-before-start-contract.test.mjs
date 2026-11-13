// Work handed a signal that has already aborted does nothing: no byte is
// read, no request admitted, no pass over a matrix run, no gene read for an
// analysis, no export request sent. An `abort` event is never dispatched
// again, so a site that waited on the event would wait for one that had
// already happened and run its work to the end; each answers a stopped
// signal at once through `onAbort` (`utils/abort.js`;
// `tests/abort-listener-contract.test.mjs` pins the helper and the rule).
import './helpers/anndata-reader-in-process.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createHostBook } from '../assets/js/formats/io/hosts.js';
import { createByteReader } from '../assets/js/formats/io/byte-reader.js';
import { bytesByteSource } from '../assets/js/formats/io/byte-source.js';
import { readInOrder } from '../assets/js/formats/rds/stream.js';
import { openDatasetStore } from '../assets/js/data/anndata/open.js';
import { createRunTunerFor, runGeneStream } from '../assets/js/app/analysis/shared/gene-stream-runner.js';
import { loadMetadataBatchAtomically } from '../assets/js/data/metadata-load-contract.js';
import { awaitFigureExportAbortable } from '../assets/js/app/ui/modules/figure-export/figure-export-contract.js';
import { cancelled } from '../assets/js/utils/abort.js';

import { until } from './helpers/until.mjs';

const stoppedSignal = () => {
  const controller = new AbortController();
  controller.abort(cancelled('user', 'Stopped before it began.'));
  return controller.signal;
};
const isAbort = error => error?.name === 'AbortError';

test('a request waiting for its host\'s pace with a stopped signal leaves the queue at once and takes no turn', async () => {
  let at = 0;
  const timers = [];
  const hosts = createHostBook({
    now: () => at,
    after: (ms, run) => {
      const timer = { due: at + ms, run };
      timers.push(timer);
      return () => {
        timer.run = null;
      };
    },
  });
  const url = 'https://example.org/data.h5ad';
  hosts.seedPace(url, 1000);
  const first = hosts.admit(url);
  assert.equal(typeof first, 'function', 'the first request goes at once');
  // Stopped already: answered now, never queued behind the pace.
  await assert.rejects(hosts.admit(url, { signal: stoppedSignal() }), isAbort);
  const next = hosts.admit(url);
  assert.ok(next instanceof Promise, 'the next request waits for the pace');
  at = 1000;
  for (const timer of timers.splice(0)) timer.run?.();
  const answered = await next;
  assert.equal(typeof answered, 'function', 'the turn the stopped request would have taken is the next one\'s');
  first(new Response('ok'));
  answered(new Response('ok'));
});

test('a byte read asked with a stopped signal plans and fetches nothing', async () => {
  const bytes = Uint8Array.from({ length: 64 * 1024 }, (_, i) => i & 0xff);
  const base = bytesByteSource(bytes, { name: 'counted', policy: { blockBytes: 1024, mergeGapBytes: 256, maxRequestBytes: 4096, concurrency: 2, cacheBytes: 8192 } });
  const asked = [];
  const source = { ...base, read: (offset, length, options) => { asked.push([offset, length]); return base.read(offset, length, options); } };
  const reader = createByteReader(source);
  await assert.rejects(reader.read(10_000, 100, { signal: stoppedSignal() }), isAbort);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(asked, [], 'no request for a read nobody waits for');
  // A live read still works.
  assert.deepEqual(await reader.read(10_000, 4), bytes.subarray(10_000, 10_004));
});

test('a stream of a file asked with a stopped signal reads none of it (R objects, text matrices)', async () => {
  let reads = 0;
  const file = { size: 1 << 20, read: async (offset, length) => { reads++; return new Uint8Array(length); } };
  const pieces = readInOrder(file, { signal: stoppedSignal() });
  await assert.rejects(pieces.next(), isAbort);
  assert.equal(reads, 0);
});

/** A Cell Ranger-like folder whose matrix (larger than its map) is read after the map, counting the matrix bytes read. */
function textMatrixFolder(nCells, nGenes) {
  const lines = [];
  for (let cell = 0; cell < nCells; cell++) {
    for (let gene = cell % 3; gene < nGenes; gene += 7) lines.push(`${gene + 1} ${cell + 1} ${1 + ((cell + gene) % 9)}`);
  }
  const text = ['%%MatrixMarket matrix coordinate integer general', `${nGenes} ${nCells} ${lines.length}`, ...lines].join('\n') + '\n';
  const barcodes = Array.from({ length: nCells }, (_, i) => `CELL${i}-1`);
  const counted = { matrix: 0 };
  class CountedMatrix extends File {
    slice(start = 0, end = this.size, type) {
      counted.matrix += Math.min(end, this.size) - start;
      return super.slice(start, end, type);
    }
  }
  const files = new Map([
    ['f/matrix.mtx', new CountedMatrix([text], 'matrix.mtx', { lastModified: 1 })],
    ['f/features.tsv', new File([Array.from({ length: nGenes }, (_, g) => `ENSG${g}\tGENE${g}\tGene Expression`).join('\n') + '\n'], 'features.tsv', { lastModified: 1 })],
    ['f/barcodes.tsv', new File([barcodes.join('\n') + '\n'], 'barcodes.tsv', { lastModified: 1 })],
    ['f/cells.csv', new File(['barcode,UMAP_1,UMAP_2\n' + barcodes.map((cell, i) => `${cell},${i % 17},${(i * 7) % 23}`).join('\n') + '\n'], 'cells.csv', { lastModified: 1 })],
  ]);
  return { source: { files, rootName: 'f' }, counted };
}

test('a pass over a text matrix stopped before it began reads none of the matrix (transcode)', async () => {
  const { source, counted } = textMatrixFolder(4000, 40);
  const opened = await openDatasetStore({ source }, { decodedChunkCacheBytes: 1 << 24, transcoding: { memory: true } });
  const stream = opened.matrixStream;
  assert.ok(stream !== null, 'the matrix is read after its map');
  counted.matrix = 0;
  // Asked with a stopped signal: no pass starts.
  await assert.rejects(stream.ensure(1000, { signal: stoppedSignal() }), isAbort);
  assert.equal(stream.reading, 0);
  // Its only caller withdraws in the same task the pass starts: the pass is
  // stopped before its read begins, and reads nothing.
  const caller = new AbortController();
  const waiting = stream.ensure(1000, { signal: caller.signal });
  caller.abort(cancelled('user', 'Withdrawn at once.'));
  await assert.rejects(waiting, isAbort);
  // The stopped pass has ended (none runs): what it read is all it read.
  await until(() => stream.reading === 0, 'the stopped pass ended');
  assert.equal(stream.held, 0);
  assert.equal(counted.matrix, 0, `the stopped pass read ${counted.matrix} matrix bytes`);
});

test('an analysis gene stream started with a stopped signal reads no gene and dispatches nothing', async () => {
  let reads = 0;
  let dispatched = 0;
  const dataLayer = {
    state: { pointCount: 50 },
    isGeneDeliverable: () => false,
    async readGeneColumn() {
      reads++;
      return { values: new Float32Array(50), owned: true };
    },
  };
  const genes = Array.from({ length: 20 }, (_, g) => `GENE${g}`);
  const outcome = runGeneStream({
    dataLayer,
    genes,
    tuner: createRunTunerFor(dataLayer, 1, genes.length, { budgetBytes: () => 1 << 24 }),
    route: null,
    dispatch: async () => {
      dispatched++;
      return null;
    },
    onResult: () => assert.fail('a stopped run publishes nothing'),
    signal: stoppedSignal(),
  });
  await assert.rejects(outcome, isAbort);
  assert.equal(reads, 0);
  assert.equal(dispatched, 0);
});

test('a metadata batch whose owner stopped before it began loads no item', async () => {
  let loaded = 0;
  await assert.rejects(loadMetadataBatchAtomically([1, 2, 3], stoppedSignal(), async () => { loaded++; }, 'Test metadata'), isAbort);
  assert.equal(loaded, 0);
});

test('an export step awaited with a stopped signal rejects at once, and its late failure is observed', async () => {
  assert.throws(() => awaitFigureExportAbortable(stoppedSignal(), Promise.resolve('blob')), isAbort);
  // Stopped while it waits: rejected at once, whatever the operation does after.
  const controller = new AbortController();
  let fail;
  const operation = new Promise((_resolve, reject) => { fail = reject; });
  const waiting = awaitFigureExportAbortable(controller.signal, operation);
  controller.abort(cancelled('user', 'Export cancelled.'));
  await assert.rejects(waiting, isAbort);
  fail(new Error('the canvas failed after the export was cancelled'));
  await new Promise(resolve => setImmediate(resolve));
});
