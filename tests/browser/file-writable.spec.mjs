/**
 * A page's writable stream writes exactly the bytes it is given, in every
 * engine (`assets/js/utils/file-writable.js`).
 *
 * WebKit writes the whole buffer under a typed-array view handed to
 * `FileSystemWritableFileStream.write()`, not the view: a 1 MB `subarray`
 * of an 8 MB buffer writes an 8 MB file (Chromium and
 * Firefox write the view). Every writable stream of the app is opened
 * through one module, which hands such a view over as a Blob of its bytes.
 * Here each writer of the app that takes bytes on a page is given views of
 * part of a larger buffer, and the file is read back and compared:
 *
 * - the module itself, on a file of the origin-private file system (a
 *   `subarray`, a `DataView`, an array that is its whole buffer);
 * - a file downloaded whole and kept as it arrives (`space.js`
 *   `keepDownload` on the page: its pieces come from a response body or a
 *   decompressor, which hand out views), read back at once and found again
 *   with its checksums;
 * - an export's spool (`cell-exports.js` `createSpool`), which a dataset
 *   copy without a save dialog writes to as well.
 *
 * That no other module opens a writable stream, and the same on a fake
 * engine that writes whole buffers: `tests/file-writable-contract.test.mjs`.
 */
import { expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';

const START_URL = `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}&dataset=current-ui&acceptance=file-writable`;

// A context whose pages have an origin-private file system, as an ordinary
// browser window does (`helpers/test.mjs` `persistentStorage`: WebKit's
// ephemeral contexts have none, and the stream this spec is about is WebKit's).
test.use({ persistentStorage: true });

test('views of part of a larger buffer are written as their own bytes by every writable-stream writer of the app', async ({ page }) => {
  await page.goto(START_URL);
  const result = await page.evaluate(async () => {
    const { openFileWritable } = await import('/assets/js/utils/file-writable.js');
    const space = await import('/assets/js/data/anndata/transcode/space.js');
    const { createSpool } = await import('/assets/js/app/exports/cell-exports.js');

    // 4 MB whose every byte tells where it is; what is written is 700 KB from its middle.
    const large = new Uint8Array(4 << 20);
    for (let i = 0; i < large.length; i++) large[i] = (i * 31 + (i >>> 9)) & 255;
    const START = 1_000_003;
    const LENGTH = 700_000;
    const expected = large.slice(START, START + LENGTH);
    const same = (read, wanted) => read.length === wanted.length && read.every((value, i) => value === wanted[i]);
    /** The 700 KB as pieces, each a view of the 4 MB buffer. */
    function* views(pieceBytes) {
      for (let at = 0; at < LENGTH; at += pieceBytes) yield large.subarray(START + at, START + Math.min(LENGTH, at + pieceBytes));
    }
    const out = { pageWrites: false, helper: null, download: null, found: null, spool: null };

    // The module itself, on a file of this origin's private storage.
    let root = null;
    try {
      root = await navigator.storage.getDirectory();
    } catch {
      root = null;
    }
    if (root !== null) {
      const handle = await root.getFileHandle('file-writable-spec.bin', { create: true });
      out.pageWrites = typeof handle.createWritable === 'function';
      if (out.pageWrites) {
        const writable = await openFileWritable(handle);
        await writable.write(large.subarray(START, START + 300_000));
        await writable.write(new DataView(large.buffer, START + 300_000, 400_000));
        // An array that is its whole buffer, and text.
        await writable.write(Uint8Array.of(1, 2, 3));
        await writable.write('end');
        await writable.close();
        const file = await handle.getFile();
        const read = new Uint8Array(await file.arrayBuffer());
        out.helper = {
          size: file.size,
          bytes: same(read.subarray(0, LENGTH), expected),
          tail: Array.from(read.subarray(LENGTH)),
        };
      }
      await root.removeEntry('file-writable-spec.bin').catch(() => {});
    }

    // A file downloaded whole, kept as it arrives on the page.
    const identity = { kind: 'remote', key: 'spec:file-writable', version: '"v1"' };
    const pieces = async function* arriving() {
      yield* views(65_536);
    };
    const kept = await space.keepDownload(identity, pieces(), { name: 'file-writable-spec.h5ad', size: LENGTH });
    out.download = { kept: kept.kept, size: kept.file.size, bytes: same(new Uint8Array(await kept.file.arrayBuffer()), expected) };
    if (kept.kept === 'opfs') {
      const found = await space.findKeptDownload(identity, 'file-writable-spec.h5ad');
      out.found = found === null ? { size: null, bytes: false, sums: false } : {
        size: found.file.size,
        bytes: same(new Uint8Array(await found.file.arrayBuffer()), expected),
        sums: found.checks.sums.length === kept.checks.sums.length && found.checks.sums.every((sum, i) => sum === kept.checks.sums[i]),
      };
    }
    await space.releaseKeptDownload(identity);

    // An export's spool, a segment a file.
    const spool = await createSpool('file-writable-spec', { segmentBytes: 200_000 });
    for (const view of views(50_000)) await spool.write(view);
    const spooled = await spool.finish();
    out.spool = { size: spooled.size, bytes: same(new Uint8Array(await spooled.arrayBuffer()), expected) };
    await spool.discard();
    return out;
  });

  // Whether this engine's page writes its private storage through a stream is asked of the page,
  // never of the engine's name (Chromium, Firefox and macOS WebKit do; a page that has none keeps
  // the download and the spool in memory, which is held to the same bytes).
  test.info().annotations.push({ type: 'a page writes its private storage through a writable stream', description: String(result.pageWrites) });
  if (result.pageWrites) {
    expect(result.helper, 'the stream writes each view\'s own bytes, not its buffer\'s').toEqual({
      size: 700_000 + 3 + 3,
      bytes: true,
      tail: [1, 2, 3, ...new TextEncoder().encode('end')],
    });
    expect(result.download.kept).toBe('opfs');
    expect(result.found, 'found again, exact, with its checksums').toEqual({ size: 700_000, bytes: true, sums: true });
  }
  expect({ size: result.download.size, bytes: result.download.bytes }, 'the kept download holds the pieces\' bytes, not their buffers\'').toEqual({ size: 700_000, bytes: true });
  expect(result.spool).toEqual({ size: 700_000, bytes: true });
  console.log(`[file-writable] a page of this engine writes its private storage through a writable stream: ${result.pageWrites}`);
});
