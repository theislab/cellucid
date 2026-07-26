import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

import * as zarrArchiveModule from '../assets/js/data/zarr-archive.js';
import {
  prepareZarrArrayAllocation,
  ZarrLoader,
} from '../assets/js/data/zarr.js';

const { readZarrZipArchive } = zarrArchiveModule;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) !== 0
        ? 0xedb88320 ^ (value >>> 1)
        : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function asBytes(value) {
  if (typeof value === 'string') return encoder.encode(value);
  if (value instanceof Uint8Array) return value;
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function writeUint16(bytes, offset, value) {
  new DataView(bytes.buffer).setUint16(offset, value, true);
}

function writeUint32(bytes, offset, value) {
  new DataView(bytes.buffer).setUint32(offset, value, true);
}

function writeUint64(bytes, offset, value) {
  new DataView(bytes.buffer).setBigUint64(offset, BigInt(value), true);
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function buildZip(entries, {
  comment = '',
  eocdDisk = 0
} = {}) {
  const locals = [];
  const centrals = [];
  let localOffset = 0;
  const payloadOffsets = [];

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const localNameBytes = encoder.encode(entry.localName ?? entry.name);
    const content = asBytes(entry.content ?? '');
    const method = entry.method ?? 0;
    const flags = entry.flags ?? 0x0800;
    const compressed = entry.compressed ??
      (method === 8 ? asBytes(deflateRawSync(content)) : content);
    const checksum = entry.crc ?? crc32(content);
    const declaredCompressedSize =
      entry.declaredCompressedSize ?? compressed.byteLength;
    const declaredSize = entry.declaredSize ?? content.byteLength;

    const local = new Uint8Array(30 + localNameBytes.byteLength);
    writeUint32(local, 0, 0x04034b50);
    writeUint16(local, 4, 20);
    writeUint16(local, 6, flags);
    writeUint16(local, 8, method);
    writeUint32(local, 14, checksum);
    writeUint32(local, 18, declaredCompressedSize);
    writeUint32(local, 22, declaredSize);
    writeUint16(local, 26, localNameBytes.byteLength);
    local.set(localNameBytes, 30);
    locals.push(local, compressed);
    payloadOffsets.push(localOffset + local.byteLength);

    const central = new Uint8Array(46 + nameBytes.byteLength);
    writeUint32(central, 0, 0x02014b50);
    writeUint16(central, 4, 0x0314);
    writeUint16(central, 6, 20);
    writeUint16(central, 8, flags);
    writeUint16(central, 10, method);
    writeUint32(central, 16, checksum);
    writeUint32(central, 20, declaredCompressedSize);
    writeUint32(central, 24, declaredSize);
    writeUint16(central, 28, nameBytes.byteLength);
    writeUint32(central, 38, entry.externalAttributes ?? 0);
    writeUint32(central, 42, localOffset);
    central.set(nameBytes, 46);
    centrals.push(central);

    localOffset += local.byteLength + compressed.byteLength;
  }

  const localBytes = concatBytes(locals);
  const centralBytes = concatBytes(centrals);
  const commentBytes = encoder.encode(comment);
  const eocd = new Uint8Array(22 + commentBytes.byteLength);
  writeUint32(eocd, 0, 0x06054b50);
  writeUint16(eocd, 4, eocdDisk);
  writeUint16(eocd, 8, entries.length);
  writeUint16(eocd, 10, entries.length);
  writeUint32(eocd, 12, centralBytes.byteLength);
  writeUint32(eocd, 16, localBytes.byteLength);
  writeUint16(eocd, 20, commentBytes.byteLength);
  eocd.set(commentBytes, 22);

  return {
    bytes: concatBytes([localBytes, centralBytes, eocd]),
    payloadOffsets
  };
}

function buildSmallZip64({ name, content }) {
  const nameBytes = encoder.encode(name);
  const payload = asBytes(content);
  const checksum = crc32(payload);

  const localExtra = new Uint8Array(20);
  writeUint16(localExtra, 0, 0x0001);
  writeUint16(localExtra, 2, 16);
  writeUint64(localExtra, 4, payload.byteLength);
  writeUint64(localExtra, 12, payload.byteLength);
  const local = new Uint8Array(30 + nameBytes.byteLength + localExtra.byteLength);
  writeUint32(local, 0, 0x04034b50);
  writeUint16(local, 4, 45);
  writeUint16(local, 6, 0x0800);
  writeUint32(local, 14, checksum);
  writeUint32(local, 18, 0xffffffff);
  writeUint32(local, 22, 0xffffffff);
  writeUint16(local, 26, nameBytes.byteLength);
  writeUint16(local, 28, localExtra.byteLength);
  local.set(nameBytes, 30);
  local.set(localExtra, 30 + nameBytes.byteLength);
  const localBytes = concatBytes([local, payload]);

  const centralExtra = new Uint8Array(28);
  writeUint16(centralExtra, 0, 0x0001);
  writeUint16(centralExtra, 2, 24);
  writeUint64(centralExtra, 4, payload.byteLength);
  writeUint64(centralExtra, 12, payload.byteLength);
  writeUint64(centralExtra, 20, 0);
  const central = new Uint8Array(
    46 + nameBytes.byteLength + centralExtra.byteLength
  );
  writeUint32(central, 0, 0x02014b50);
  writeUint16(central, 4, 0x032d);
  writeUint16(central, 6, 45);
  writeUint16(central, 8, 0x0800);
  writeUint32(central, 16, checksum);
  writeUint32(central, 20, 0xffffffff);
  writeUint32(central, 24, 0xffffffff);
  writeUint16(central, 28, nameBytes.byteLength);
  writeUint16(central, 30, centralExtra.byteLength);
  writeUint32(central, 42, 0xffffffff);
  central.set(nameBytes, 46);
  central.set(centralExtra, 46 + nameBytes.byteLength);

  const zip64Offset = localBytes.byteLength + central.byteLength;
  const zip64End = new Uint8Array(56);
  writeUint32(zip64End, 0, 0x06064b50);
  writeUint64(zip64End, 4, 44);
  writeUint16(zip64End, 12, 45);
  writeUint16(zip64End, 14, 45);
  writeUint64(zip64End, 24, 1);
  writeUint64(zip64End, 32, 1);
  writeUint64(zip64End, 40, central.byteLength);
  writeUint64(zip64End, 48, localBytes.byteLength);

  const locator = new Uint8Array(20);
  writeUint32(locator, 0, 0x07064b50);
  writeUint64(locator, 8, zip64Offset);
  writeUint32(locator, 16, 1);

  const classicEnd = new Uint8Array(22);
  writeUint32(classicEnd, 0, 0x06054b50);
  writeUint16(classicEnd, 8, 0xffff);
  writeUint16(classicEnd, 10, 0xffff);
  writeUint32(classicEnd, 12, 0xffffffff);
  writeUint32(classicEnd, 16, 0xffffffff);

  return concatBytes([
    localBytes,
    central,
    zip64End,
    locator,
    classicEnd
  ]);
}

function injectedInflater(compressed) {
  return new Uint8Array(inflateRawSync(compressed));
}

function zarrArrayMetadata({
  shape,
  chunks,
  dtype,
  fillValue = 0,
  filters = null
}) {
  return JSON.stringify({
    zarr_format: 2,
    shape,
    chunks,
    dtype,
    compressor: null,
    fill_value: fillValue,
    filters,
    order: 'C'
  });
}

function float32Bytes(values) {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => {
    view.setFloat32(index * 4, value, true);
  });
  return bytes;
}

function vlenUtf8Bytes(values) {
  const encoded = values.map(value => encoder.encode(value));
  const totalBytes = 4 + encoded.reduce(
    (sum, bytes) => sum + 4 + bytes.length,
    0
  );
  const result = new Uint8Array(totalBytes);
  const view = new DataView(result.buffer);
  view.setUint32(0, values.length, true);
  let cursor = 4;
  for (const bytes of encoded) {
    view.setUint32(cursor, bytes.length, true);
    cursor += 4;
    result.set(bytes, cursor);
    cursor += bytes.length;
  }
  return result;
}

test('indexes stored Zarr entries as lazy file-like values', async () => {
  const { bytes } = buildZip([
    { name: 'pbmc.zarr/', content: '' },
    { name: 'pbmc.zarr/.zgroup', content: '{"zarr_format":2}' },
    { name: 'pbmc.zarr/.zattrs', content: '{"encoding-type":"anndata"}' },
    { name: 'pbmc.zarr/X/', content: '' },
    { name: 'pbmc.zarr/X/.zarray', content: '{"shape":[1,1]}' },
    { name: 'pbmc.zarr/X/0.0', content: Uint8Array.from([1, 2, 3, 4]) }
  ], { comment: 'false footer PK\u0005\u0006 inside a ZIP comment' });

  const { files, rootName } = await readZarrZipArchive(bytes, {
    archiveName: 'download.zip'
  });

  assert.equal(rootName, 'pbmc.zarr');
  assert.deepEqual(Array.from(files.keys()), [
    '.zgroup',
    '.zattrs',
    'X/.zarray',
    'X/0.0'
  ]);
  assert.equal(files.get('X/0.0').size, 4);
  assert.equal(await files.get('.zgroup').text(), '{"zarr_format":2}');
  assert.deepEqual(
    Array.from(new Uint8Array(await files.get('X/0.0').arrayBuffer())),
    [1, 2, 3, 4]
  );
});

test('derives a stable Zarr root name for rootless archives', async () => {
  const { bytes } = buildZip([
    { name: '.zgroup', content: '{"zarr_format":2}' },
    { name: '.zattrs', content: '{}' }
  ]);
  const padded = new Uint8Array(bytes.byteLength + 11);
  padded.set(bytes, 7);
  const archiveView = padded.subarray(7, 7 + bytes.byteLength);

  const { files, rootName } = await readZarrZipArchive(archiveView, {
    archiveName: 'experiment.zip'
  });

  assert.equal(rootName, 'experiment.zarr');
  assert.deepEqual(Array.from(files.keys()), ['.zgroup', '.zattrs']);
});

test('ignores ordinary macOS metadata around a wrapper-root Zarr store', async () => {
  const { bytes } = buildZip([
    { name: '.DS_Store', content: 'finder metadata' },
    { name: 'experiment.zarr/.zgroup', content: '{"zarr_format":2}' },
    { name: 'experiment.zarr/.zattrs', content: '{}' },
    {
      name: 'experiment.zarr/.DS_Store',
      content: 'nested finder metadata'
    },
    {
      name: '__MACOSX/experiment.zarr/._.zgroup',
      content: 'appledouble resource fork'
    }
  ]);

  const { files, rootName } = await readZarrZipArchive(bytes);

  assert.equal(rootName, 'experiment.zarr');
  assert.deepEqual(Array.from(files.keys()), ['.zgroup', '.zattrs']);
  assert.equal(await files.get('.zgroup').text(), '{"zarr_format":2}');
});

test('inflates deflate entries through the injected raw-DEFLATE seam', async () => {
  const payload = '{"zarr_format":2,"node_type":"group"}';
  const { bytes } = buildZip([
    {
      name: 'compressed.zarr/.zgroup',
      content: payload,
      method: 8,
      flags: 0x0808
    }
  ]);
  const calls = [];

  const { files } = await readZarrZipArchive(bytes, {
    inflateRaw: async (compressed, context) => {
      calls.push({ compressed: compressed.byteLength, ...context });
      return injectedInflater(compressed);
    }
  });

  assert.equal(await files.get('.zgroup').text(), payload);
  assert.deepEqual(calls, [{
    compressed: deflateRawSync(encoder.encode(payload)).byteLength,
    expectedSize: encoder.encode(payload).byteLength,
    checksum: crc32(encoder.encode(payload)),
    path: '.zgroup'
  }]);
});

test('CEL-AUDIT-0108 ZIP extraction participates in the portable array working-set plan', async t => {
  const mebibyte = 1024 * 1024;
  const estimateArchiveWorkingBytes =
    zarrArchiveModule.estimateZarrZipEntryExtractionWorkingBytes;
  await t.test('exposes the archive-layer extraction lifetime', () => {
    assert.equal(typeof estimateArchiveWorkingBytes, 'function');
  });
  const archiveChunkWorkingBytes =
    typeof estimateArchiveWorkingBytes === 'function'
      ? estimateArchiveWorkingBytes({
          method: 8,
          compressedSize: 64 * mebibyte,
          uncompressedSize: 64 * mebibyte,
        })
      : 192n * BigInt(mebibyte);
  assert.equal(archiveChunkWorkingBytes, 192n * BigInt(mebibyte));

  const metadata = resultMebibytes => ({
    zarr_format: 2,
    shape: [(resultMebibytes * mebibyte) / 4],
    chunks: [16_777_216],
    dtype: '<u4',
    compressor: null,
    fill_value: 0,
    filters: null,
    order: 'C',
  });

  await t.test('preserves the exact non-archive 383/384 MiB boundary', () => {
    assert.doesNotThrow(() => prepareZarrArrayAllocation(metadata(383)));
    assert.throws(
      () => prepareZarrArrayAllocation(metadata(384)),
      /peak working set.*browser limit/i
    );
  });

  await t.test('uses the maximum inner-or-archive chunk lifetime', () => {
    assert.doesNotThrow(
      () => prepareZarrArrayAllocation(
        metadata(320),
        archiveChunkWorkingBytes
      )
    );
    assert.throws(
      () => prepareZarrArrayAllocation(
        {
          ...metadata(320),
          shape: [((320 * mebibyte) / 4) + 1],
        },
        archiveChunkWorkingBytes
      ),
      /ZIP extraction.*working set.*browser limit/i
    );
    assert.throws(
      () => prepareZarrArrayAllocation(
        metadata(383),
        archiveChunkWorkingBytes
      ),
      /ZIP extraction.*working set.*browser limit/i
    );
  });

  await t.test('rejects an indexed archive chunk before payload inflation or result allocation', async () => {
    if (typeof estimateArchiveWorkingBytes !== 'function') {
      assert.fail('archive extraction plan seam is unavailable');
    }
    const archive = buildZip([
      {
        name: 'bounded.zarr/.zarray',
        content: zarrArrayMetadata({
          shape: [(383 * mebibyte) / 4],
          chunks: [16_777_216],
          dtype: '<u4',
        }),
      },
      {
        name: 'bounded.zarr/0',
        content: Uint8Array.of(0),
        compressed: Uint8Array.of(0),
        method: 8,
        declaredCompressedSize: 64 * mebibyte,
        declaredSize: 64 * mebibyte,
      },
    ]);
    let inflateCalls = 0;
    const { files } = await readZarrZipArchive(archive.bytes, {
      inflateRaw() {
        inflateCalls++;
        throw new Error('oversized archive chunk must not inflate');
      },
    });
    const loader = new ZarrLoader();
    loader._files = files;

    await assert.rejects(
      loader._readArray(''),
      /ZIP extraction.*working set.*browser limit/i
    );
    assert.equal(inflateCalls, 0);
  });
});

test('reads ZIP64 footer and per-entry size/offset metadata safely', async () => {
  const bytes = buildSmallZip64({
    name: 'zip64.zarr/.zgroup',
    content: '{"zarr_format":2}'
  });
  const { files, rootName } = await readZarrZipArchive(bytes);

  assert.equal(rootName, 'zip64.zarr');
  assert.equal(await files.get('.zgroup').text(), '{"zarr_format":2}');
});

test('uses one gzip stream path for ZIP DEFLATE across browser engines', async t => {
  const { bytes } = buildZip([{
    name: 'native.zarr/.zgroup',
    content: '{"zarr_format":2}',
    method: 8
  }]);

  await t.test('gzip-only browser API', async () => {
    const NativeDecompressionStream = globalThis.DecompressionStream;
    assert.equal(typeof NativeDecompressionStream, 'function');
    const requestedFormats = [];
    Object.defineProperty(globalThis, 'DecompressionStream', {
      value: class GzipOnlyDecompressionStream {
        constructor(format) {
          requestedFormats.push(format);
          if (format !== 'gzip') {
            throw new TypeError(`Unsupported compression format '${format}'`);
          }
          return new NativeDecompressionStream(format);
        }
      },
      configurable: true,
      writable: true
    });
    try {
      const { files } = await readZarrZipArchive(bytes);
      assert.equal(await files.get('.zgroup').text(), '{"zarr_format":2}');
      assert.deepEqual(requestedFormats, ['gzip']);
    } finally {
      Object.defineProperty(globalThis, 'DecompressionStream', {
        value: NativeDecompressionStream,
        configurable: true,
        writable: true
      });
    }
  });

  await t.test('missing browser API', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'DecompressionStream'
    );
    Object.defineProperty(globalThis, 'DecompressionStream', {
      value: undefined,
      configurable: true,
      writable: true
    });
    try {
      const { files } = await readZarrZipArchive(bytes);
      await assert.rejects(
        files.get('.zgroup').arrayBuffer(),
        /cannot decompress.*gzip DecompressionStream/i
      );
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, 'DecompressionStream', descriptor);
      } else {
        delete globalThis.DecompressionStream;
      }
    }
  });
});

test('range-indexes Blob archives without eagerly reading entry payloads', async () => {
  const archive = buildZip([
    { name: 'lazy.zarr/.zgroup', content: '{"zarr_format":2}' },
    { name: 'lazy.zarr/data/0', content: new Uint8Array(80_000) }
  ]);
  const ranges = [];
  const source = {
    name: 'lazy.zarr.zip',
    size: archive.bytes.byteLength,
    slice(start, end) {
      ranges.push([start, end]);
      return new Blob([archive.bytes.slice(start, end)]);
    }
  };

  const { files } = await readZarrZipArchive(source);
  assert.ok(ranges.length >= 2);
  assert.ok(ranges.every(([start, end]) => end - start < source.size));
  const readsAfterIndex = ranges.length;
  assert.equal(files.get('data/0').size, 80_000);
  assert.equal(ranges.length, readsAfterIndex);

  assert.equal(await files.get('.zgroup').text(), '{"zarr_format":2}');
  assert.ok(ranges.length > readsAfterIndex);
});

test('feeds an archived Zarr store through ZarrLoader.openFileMap', async () => {
  const archive = buildZip([
    { name: 'tiny.zarr/.zgroup', content: '{"zarr_format":2}' },
    {
      name: 'tiny.zarr/.zattrs',
      content: '{"encoding-type":"anndata","encoding-version":"0.1.0"}'
    },
    {
      name: 'tiny.zarr/X/.zattrs',
      content: '{"encoding-type":"array","encoding-version":"0.2.0"}'
    },
    {
      name: 'tiny.zarr/X/.zarray',
      content: zarrArrayMetadata({
        shape: [1, 1],
        chunks: [1, 1],
        dtype: '<f4'
      })
    },
    { name: 'tiny.zarr/X/0.0', content: float32Bytes([3.5]) },
    { name: 'tiny.zarr/obs/.zgroup', content: '{"zarr_format":2}' },
    {
      name: 'tiny.zarr/obs/.zattrs',
      content: '{"encoding-type":"dataframe","encoding-version":"0.2.0","_index":"_index","column-order":[]}'
    },
    {
      name: 'tiny.zarr/obs/_index/.zattrs',
      content: '{"encoding-type":"string-array","encoding-version":"0.2.0"}'
    },
    {
      name: 'tiny.zarr/obs/_index/.zarray',
      content: zarrArrayMetadata({
        shape: [1],
        chunks: [1],
        dtype: '|O',
        fillValue: 0,
        filters: [{ id: 'vlen-utf8' }]
      })
    },
    {
      name: 'tiny.zarr/obs/_index/0',
      content: vlenUtf8Bytes(['c'])
    },
    { name: 'tiny.zarr/var/.zgroup', content: '{"zarr_format":2}' },
    {
      name: 'tiny.zarr/var/.zattrs',
      content: '{"encoding-type":"dataframe","encoding-version":"0.2.0","_index":"_index","column-order":[]}'
    },
    {
      name: 'tiny.zarr/var/_index/.zattrs',
      content: '{"encoding-type":"string-array","encoding-version":"0.2.0"}'
    },
    {
      name: 'tiny.zarr/var/_index/.zarray',
      content: zarrArrayMetadata({
        shape: [1],
        chunks: [1],
        dtype: '|O',
        fillValue: 0,
        filters: [{ id: 'vlen-utf8' }]
      })
    },
    {
      name: 'tiny.zarr/var/_index/0',
      content: vlenUtf8Bytes(['GeneA'])
    }
  ]);
  const { files, rootName } = await readZarrZipArchive(archive.bytes);
  const loader = new ZarrLoader();

  await loader.openFileMap(files, rootName);

  assert.equal(loader.nObs, 1);
  assert.equal(loader.nVars, 1);
  assert.deepEqual(loader.varNames, ['GeneA']);
  assert.deepEqual(Array.from(await loader.getGeneExpression('GeneA')), [3.5]);
});

for (const [label, name] of [
  ['parent traversal', 'bad.zarr/../escape'],
  ['absolute path', '/bad.zarr/.zgroup'],
  ['drive path', 'C:/bad.zarr/.zgroup'],
  ['backslash path', 'bad.zarr\\..\\.zgroup'],
  ['empty segment', 'bad.zarr//.zgroup']
]) {
  test(`rejects ${label} archive entries`, async () => {
    const { bytes } = buildZip([{ name, content: '{}' }]);
    await assert.rejects(
      readZarrZipArchive(bytes),
      /unsafe ZIP entry path/i
    );
  });
}

test('rejects duplicate archive paths before exposing a file map', async () => {
  const { bytes } = buildZip([
    { name: 'duplicate.zarr/.zgroup', content: '{}' },
    { name: 'duplicate.zarr/.zgroup', content: '{}' }
  ]);
  await assert.rejects(
    readZarrZipArchive(bytes),
    /duplicate ZIP entry/i
  );
});

test('rejects encrypted, unsupported, multi-disk, and oversized archives', async t => {
  await t.test('encrypted entry', async () => {
    const { bytes } = buildZip([
      { name: 'bad.zarr/.zgroup', content: '{}', flags: 0x0801 }
    ]);
    await assert.rejects(readZarrZipArchive(bytes), /encrypted ZIP entries/i);
  });

  await t.test('unsupported compression', async () => {
    const { bytes } = buildZip([
      { name: 'bad.zarr/.zgroup', content: '{}', method: 12 }
    ]);
    await assert.rejects(
      readZarrZipArchive(bytes),
      /unsupported ZIP compression method 12/i
    );
  });

  await t.test('multi-disk archive', async () => {
    const { bytes } = buildZip(
      [{ name: 'bad.zarr/.zgroup', content: '{}' }],
      { eocdDisk: 1 }
    );
    await assert.rejects(readZarrZipArchive(bytes), /multi-disk ZIP/i);
  });

  await t.test('unsafe declared entry size', async () => {
    const { bytes } = buildZip([{
      name: 'bad.zarr/.zgroup',
      content: '{}',
      declaredSize: 100 * 1024 * 1024
    }]);
    await assert.rejects(
      readZarrZipArchive(bytes),
      /uncompressed size.*browser limit/i
    );
  });
});

test('validates local headers, expanded lengths, and CRC before returning bytes', async t => {
  await t.test('local name mismatch', async () => {
    const { bytes } = buildZip([{
      name: 'safe.zarr/.zgroup',
      localName: 'evil.zarr/.zgroup',
      content: '{}'
    }]);
    const { files } = await readZarrZipArchive(bytes);
    await assert.rejects(
      files.get('.zgroup').arrayBuffer(),
      /local header name.*central directory/i
    );
  });

  await t.test('expanded length mismatch', async () => {
    const { bytes } = buildZip([{
      name: 'bad.zarr/.zgroup',
      content: '{}',
      method: 8
    }]);
    const { files } = await readZarrZipArchive(bytes, {
      inflateRaw: async () => Uint8Array.from([1])
    });
    await assert.rejects(
      files.get('.zgroup').arrayBuffer(),
      /decompressed size.*declared size/i
    );
  });

  await t.test('CRC mismatch', async () => {
    const archive = buildZip([
      { name: 'bad.zarr/.zgroup', content: '{"zarr_format":2}' }
    ]);
    archive.bytes[archive.payloadOffsets[0]] ^= 0xff;
    const { files } = await readZarrZipArchive(archive.bytes);
    await assert.rejects(
      files.get('.zgroup').arrayBuffer(),
      /CRC-32 mismatch/i
    );
  });
});

test('rejects archives without a Zarr v2 root marker', async () => {
  const { bytes } = buildZip([
    { name: 'not-zarr/readme.txt', content: 'hello' }
  ]);
  await assert.rejects(
    readZarrZipArchive(bytes),
    /Zarr v2 root metadata/i
  );
});
