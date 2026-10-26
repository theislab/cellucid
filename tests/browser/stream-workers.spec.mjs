import { expect, test } from './helpers/test.mjs';

/**
 * The workers a streamed text or R file is read on, in every engine:
 *
 * - a large gzip stream is decompressed on a worker of its own
 *   (`formats/rds/gunzip-worker.js`) and gives the bytes the reader thread's
 *   own decompression gives; a damaged stream is refused the same way, and
 *   an aborted read stops;
 * - the entries of a MatrixMarket file are parsed in blocks on the decode
 *   workers and read exactly as when every block is parsed in the reader
 *   thread.
 */

test('a large gzip stream decompresses on its own worker exactly as in this thread', async ({ page }) => {
  await page.goto('/robots.txt');
  const outcome = await page.evaluate(async () => {
    const { decompressed, readInOrder, GUNZIP_WORKER_MIN_BYTES } = await import('/assets/js/formats/rds/stream.js');
    const made = [];
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        made.push(String(url));
      }
    };
    // Text that compresses about 3:1, so the gzip stream is several megabytes.
    let state = 7;
    const text = new Uint8Array(24 * 1024 * 1024);
    for (let i = 0; i < text.length; i++) {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      text[i] = 0x30 + ((state >>> 24) & 15);
    }
    const gzip = new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    const fileOf = bytes => ({ size: bytes.length, read: async (offset, length) => bytes.slice(offset, offset + length) });
    const read = async (bytes, size, signal = null) => {
      const { pieces } = await decompressed(readInOrder(fileOf(bytes), { signal }), { signal, bytes: size });
      const out = new Uint8Array(text.length + 1);
      let at = 0;
      for await (const piece of pieces) {
        out.set(piece.subarray(0, Math.min(piece.length, out.length - at)), at);
        at += piece.length;
      }
      return { at, same: at === text.length && out.subarray(0, at).every((byte, i) => byte === text[i]) };
    };
    const message = async promise => promise.then(() => 'accepted', error => `${error.name}: ${error.message}`);
    const onWorker = await read(gzip, gzip.length);
    const workersAfterRead = made.filter(url => url.includes('gunzip-worker')).length;
    const inThread = await read(gzip, null);
    const workersInThread = made.filter(url => url.includes('gunzip-worker')).length - workersAfterRead;
    const damaged = gzip.slice();
    damaged[damaged.length >> 1] ^= 0xff;
    damaged[(damaged.length >> 1) + 1] ^= 0xff;
    const damagedOnWorker = await message(read(damaged, damaged.length));
    const damagedInThread = await message(read(damaged, null));
    const controller = new AbortController();
    const aborted = message((async () => {
      const { pieces } = await decompressed(readInOrder(fileOf(gzip), { signal: controller.signal }), { signal: controller.signal, bytes: gzip.length });
      let seen = 0;
      for await (const piece of pieces) {
        seen += piece.length;
        if (seen > 1 << 20) controller.abort();
      }
    })());
    return {
      compressedBytes: gzip.length,
      minBytes: GUNZIP_WORKER_MIN_BYTES,
      onWorker,
      workersAfterRead,
      inThread,
      workersInThread,
      damagedOnWorker,
      damagedInThread,
      aborted: await aborted,
    };
  });
  expect(outcome.compressedBytes).toBeGreaterThan(outcome.minBytes);
  expect(outcome.onWorker).toEqual({ at: 24 * 1024 * 1024, same: true });
  expect(outcome.inThread).toEqual(outcome.onWorker);
  expect(outcome.workersAfterRead).toBe(1);
  expect(outcome.workersInThread).toBe(0);
  expect(outcome.damagedOnWorker).toMatch(/^RdsFormatError: The gzip stream could not be decompressed \(.+\); the file is damaged or truncated\.$/);
  expect(outcome.damagedInThread).toMatch(/^RdsFormatError: The gzip stream could not be decompressed \(.+\); the file is damaged or truncated\.$/);
  expect(outcome.aborted).toMatch(/^AbortError/);
});

test('MatrixMarket entries parsed in blocks on decode workers read as in the reader thread', async ({ page }) => {
  await page.goto('/robots.txt');
  const outcome = await page.evaluate(async () => {
    const { readMatrixMarket } = await import('/assets/js/formats/text/matrix-market.js');
    const { configureDecodePool, decodePoolStats } = await import('/assets/js/formats/io/decode-pool.js');
    const lines = ['%%MatrixMarket matrix coordinate real general', '%metadata_json: {}', '5000 300 200000'];
    for (let k = 0; k < 200000; k++) {
      const value = k % 7 === 0 ? `${k}e-3` : k % 101 === 0 ? 'nan' : `${(k % 13) - 6}.${k % 997}`;
      lines.push(`${1 + (k % 5000)}${k % 5 === 0 ? '\t' : ' '}${1 + (k % 300)} ${value}${k % 9 === 0 ? '\r' : ''}`);
    }
    const bytes = new TextEncoder().encode(`${lines.join('\n')}\n`);
    const read = async () => {
      async function* pieces() {
        for (let at = 0; at < bytes.length; at += 65521) yield bytes.subarray(at, at + 65521);
      }
      const rows = [];
      const columns = [];
      const values = [];
      await readMatrixMarket(pieces(), {
        onSize: () => {},
        valueType: 'float32',
        blockBytes: 1 << 16,
        onEntries: (r, c, v, count) => {
          for (let k = 0; k < count; k++) {
            rows.push(r[k]);
            columns.push(c[k]);
            values.push(Number.isNaN(v[k]) ? 'nan' : v[k]);
          }
        },
      });
      return { rows, columns, values };
    };
    configureDecodePool();
    const onWorkers = await read();
    const workers = decodePoolStats().workers;
    configureDecodePool({ createWorker: null });
    const inThread = await read();
    configureDecodePool();
    return {
      workers,
      count: onWorkers.rows.length,
      same: JSON.stringify(onWorkers) === JSON.stringify(inThread),
      inputIntact: bytes.length > 0 && bytes[0] === 0x25,
    };
  });
  expect(outcome.workers).toBeGreaterThan(0);
  expect(outcome.count).toBe(200000);
  expect(outcome.same).toBe(true);
  expect(outcome.inputIntact).toBe(true);
});
