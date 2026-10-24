/**
 * Every native inflate in the data layer is bounded by its reader.
 *
 * A DEFLATE bomb must be cancelled after a few chunks of output, not after the
 * native decoder has expanded the whole payload. Two readers inflate natively:
 *
 * - the session codec (`app/session/codecs/gzip.js`) feeds the decompressor
 *   in input slices, so a bomb is stopped after a few slices of input and an
 *   abort stops the input early;
 * - the format readers (`formats/io/inflate.js`: Zarr gzip and zlib chunks,
 *   ZIP entries) feed the decompressor in the same input slices and read the
 *   output against the size the format declares, so a bomb is stopped after
 *   a few slices: the reader cancels the stream as soon as the output passes
 *   the declared size. (Written whole, WebKit's decompressor expanded the
 *   whole bomb before the reader could stop it.)
 *
 * Both are properties of the browser's `DecompressionStream` and its
 * backpressure, so they are measured here, in each engine the application
 * runs in: every case wraps the real native decompressor and counts the bytes
 * it was handed and the bytes it produced.
 */

import { deflateRawSync, deflateSync, gzipSync } from 'node:zlib';

import { expect, test } from './helpers/test.mjs';

const BOMB_BYTES = 60 * 1024 * 1024;
const NOISE_BYTES = 32 * 1024 * 1024;

// Level 1 keeps the bombs long enough to span many input slices.
function payloads() {
  const zeros = new Uint8Array(BOMB_BYTES);
  const noise = new Uint8Array(NOISE_BYTES);
  for (let index = 0; index < noise.byteLength; index += 1) {
    noise[index] = (index * 2654435761) >>> 24;
  }
  const encode = bytes => Buffer.from(bytes).toString('base64');
  return {
    gzipBomb: encode(gzipSync(zeros, { level: 1 })),
    zlibBomb: encode(deflateSync(zeros, { level: 1 })),
    rawBomb: encode(deflateRawSync(zeros, { level: 1 })),
    honest: encode(gzipSync(noise, { level: 1 })),
    noiseBytes: NOISE_BYTES,
  };
}

test('native inflate stops a DEFLATE bomb within a few slices of input or output', async ({
  page,
}) => {
  await page.goto('/tests/browser/fixtures/catalog/datasets.json');
  const results = await page.evaluate(async input => {
    const { gzipDecompress } = await import('/assets/js/app/session/codecs/gzip.js');
    const { NATIVE_INFLATE_INPUT_SLICE_BYTES: SLICE } = await import('/assets/js/formats/io/inflate.js');
    const { memoryStore, openZarr } = await import('/assets/js/formats/zarr/index.js');
    const { openZipArchive } = await import('/assets/js/formats/zip/index.js');
    const { bytesByteSource } = await import('/assets/js/formats/io/byte-source.js');
    const { createByteReader } = await import('/assets/js/formats/io/byte-reader.js');

    const decode = base64 => Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    const writeUint16 = (bytes, offset, value) => {
      bytes[offset] = value & 0xff;
      bytes[offset + 1] = (value >>> 8) & 0xff;
    };
    const writeUint32 = (bytes, offset, value) => {
      writeUint16(bytes, offset, value & 0xffff);
      writeUint16(bytes, offset + 2, value >>> 16);
    };
    // One-entry DEFLATE ZIP whose directory under-declares the entry size.
    const deflateBombZip = (name, compressed, declaredSize) => {
      const nameBytes = new TextEncoder().encode(name);
      const local = new Uint8Array(30 + nameBytes.byteLength);
      writeUint32(local, 0, 0x04034b50);
      writeUint16(local, 4, 20);
      writeUint16(local, 6, 0x0800);
      writeUint16(local, 8, 8);
      writeUint32(local, 18, compressed.byteLength);
      writeUint32(local, 22, declaredSize);
      writeUint16(local, 26, nameBytes.byteLength);
      local.set(nameBytes, 30);
      const central = new Uint8Array(46 + nameBytes.byteLength);
      writeUint32(central, 0, 0x02014b50);
      writeUint16(central, 4, 0x0314);
      writeUint16(central, 6, 20);
      writeUint16(central, 8, 0x0800);
      writeUint16(central, 10, 8);
      writeUint32(central, 20, compressed.byteLength);
      writeUint32(central, 24, declaredSize);
      writeUint16(central, 28, nameBytes.byteLength);
      central.set(nameBytes, 46);
      const eocd = new Uint8Array(22);
      writeUint32(eocd, 0, 0x06054b50);
      writeUint16(eocd, 8, 1);
      writeUint16(eocd, 10, 1);
      writeUint32(eocd, 12, central.byteLength);
      writeUint32(eocd, 16, local.byteLength + compressed.byteLength);
      const zip = new Uint8Array(
        local.byteLength + compressed.byteLength + central.byteLength + eocd.byteLength,
      );
      let at = 0;
      for (const part of [local, compressed, central, eocd]) {
        zip.set(part, at);
        at += part.byteLength;
      }
      return zip;
    };
    // A one-chunk Zarr v2 array of 1024 bytes whose only chunk is `chunk`.
    const zarrChunkStore = (compressorId, chunk) => memoryStore({
      '.zarray': new TextEncoder().encode(JSON.stringify({
        zarr_format: 2,
        shape: [1024],
        chunks: [1024],
        dtype: '|u1',
        compressor: { id: compressorId, level: 1 },
        fill_value: 0,
        order: 'C',
        filters: null,
      })),
      0: chunk,
    }, { name: `bomb-${compressorId}.zarr` });

    // Run `operation` with the native decompressor wrapped so its input and
    // output are counted; `onInput` may react to the running input total.
    const measure = async (operation, onInput = () => {}) => {
      const Native = globalThis.DecompressionStream;
      const counts = { input: 0, output: 0, error: null };
      globalThis.DecompressionStream = class CountingDecompressionStream {
        constructor(format) {
          const native = new Native(format);
          const inputCounter = new TransformStream({
            transform(chunk, controller) {
              counts.input += chunk.byteLength;
              onInput(counts.input);
              controller.enqueue(chunk);
            },
          });
          inputCounter.readable.pipeTo(native.writable).catch(() => {});
          const outputCounter = new TransformStream({
            transform(chunk, controller) {
              counts.output += chunk.byteLength;
              controller.enqueue(chunk);
            },
          });
          return {
            writable: inputCounter.writable,
            readable: native.readable.pipeThrough(outputCounter),
          };
        }
      };
      try {
        await operation();
      } catch (error) {
        counts.error = `${error.name}: ${error.message}`;
      } finally {
        globalThis.DecompressionStream = Native;
      }
      return counts;
    };

    const out = { slice: SLICE };

    // gzip with a forged ISIZE that matches the small limit, so only pacing
    // can stop it.
    const gzipBomb = decode(input.gzipBomb);
    const maxOutputBytes = 1024 * 1024;
    new DataView(gzipBomb.buffer).setUint32(
      gzipBomb.byteLength - 4,
      maxOutputBytes,
      true,
    );
    out.gzip = await measure(() => gzipDecompress(gzipBomb, {
      maxOutputBytes,
      signal: null,
    }));
    out.gzip.compressed = gzipBomb.byteLength;

    // A Zarr chunk declares its decoded size by its array's metadata.
    for (const [id, encoded] of [['gzip', input.gzipBomb], ['zlib', input.zlibBomb]]) {
      const chunk = decode(encoded);
      out[`zarr-${id}`] = await measure(async () => {
        const array = await openZarr(zarrChunkStore(id, chunk));
        await array.read();
      });
      out[`zarr-${id}`].compressed = chunk.byteLength;
      out[`zarr-${id}`].declared = 1024;
    }

    // A ZIP entry declares its size in the central directory.
    const rawBomb = decode(input.rawBomb);
    const archive = await openZipArchive(
      createByteReader(bytesByteSource(deflateBombZip('bomb.zarr/.zgroup', rawBomb, 64))),
      { name: 'bomb.zarr.zip' },
    );
    out.zip = await measure(() => archive.entry('bomb.zarr/.zgroup').read());
    out.zip.compressed = rawBomb.byteLength;
    out.zip.declared = 64;

    // Abort while inflating an honest payload: the source stops early.
    const honest = decode(input.honest);
    const controller = new AbortController();
    out.abort = await measure(
      () => gzipDecompress(honest, {
        maxOutputBytes: input.noiseBytes,
        signal: controller.signal,
      }),
      written => {
        if (written > 4 * SLICE) controller.abort();
      },
    );
    out.abort.compressed = honest.byteLength;
    return out;
  }, payloads());

  for (const id of ['gzip', 'zarr-gzip', 'zarr-zlib', 'zip']) {
    const result = results[id];
    expect(result.compressed, `${id} bomb spans many slices`)
      .toBeGreaterThan(8 * results.slice);
    expect(result.error, `${id} bomb is rejected`).not.toBeNull();
  }

  // The session codec paces its input.
  expect(
    results.gzip.input,
    `gzip inflate consumed ${results.gzip.input} of ${results.gzip.compressed} input bytes`,
  ).toBeLessThanOrEqual(4 * results.slice);
  expect(results.gzip.error).toMatch(/Decompressed data exceeds limit/);

  // The format readers pace their input as the session codec does: the
  // decoder is stopped within a few input slices of passing the declared
  // size, so what it produced past it is bounded by DEFLATE's expansion of
  // those slices, never the whole bomb.
  for (const id of ['zarr-gzip', 'zarr-zlib', 'zip']) {
    const result = results[id];
    expect(
      result.input,
      `${id} inflate consumed ${result.input} of ${result.compressed} input bytes for a ${result.declared}-byte declared size`,
    ).toBeLessThanOrEqual(4 * results.slice);
    expect(
      result.output,
      `${id} inflate produced ${result.output} bytes (bomb: ${BOMB_BYTES})`,
    ).toBeLessThan(BOMB_BYTES / 2);
  }
  expect(results['zarr-gzip'].error)
    .toMatch(/^ZarrFormatError: A gzip chunk decompresses to more than the 1024 bytes it declares/);
  expect(results['zarr-zlib'].error)
    .toMatch(/^ZarrFormatError: A zlib chunk decompresses to more than the 1024 bytes it declares/);
  expect(results.zip.error)
    .toMatch(/^ZipFormatError: .*'bomb\.zarr\/\.zgroup' decompresses to more than the 64 bytes it declares/);

  expect(results.abort.error).toMatch(/^AbortError/);
  expect(
    results.abort.input,
    `abort must stop inflation early, wrote ${results.abort.input} of ${results.abort.compressed}`,
  ).toBeLessThan(results.abort.compressed / 2);
});
