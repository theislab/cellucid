import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertFigureExportBatchRequest,
  assertFigureExportSingleRequest,
} from '../assets/js/app/ui/modules/figure-export/figure-export-contract.js';
import {
  embedPngTextChunks,
} from '../assets/js/app/ui/modules/figure-export/utils/png-metadata.js';
import {
  createFigureExportZip,
} from '../assets/js/app/ui/modules/figure-export/utils/zip-archive.js';

const figureExportRoot = new URL(
  '../assets/js/app/ui/modules/figure-export/',
  import.meta.url
);

function source(relativePath) {
  return readFile(new URL(relativePath, figureExportRoot), 'utf8');
}

function baseRequest(overrides = {}) {
  return {
    width: 1200,
    height: 900,
    exportAllViews: false,
    title: '',
    includeAxes: true,
    includeLegend: true,
    legendPosition: 'right',
    xLabel: 'X',
    yLabel: 'Y',
    background: 'viewer',
    backgroundColor: '#ffffff',
    fontFamily: 'Arial, sans-serif',
    fontSizePx: 12,
    legendFontSizePx: 12,
    tickFontSizePx: 12,
    axisLabelFontSizePx: 12,
    titleFontSizePx: 15,
    centroidLabelFontSizePx: 12,
    crop: null,
    showOrientation: true,
    depthSort3d: true,
    emphasizeSelection: false,
    selectionMutedOpacity: 0.15,
    signal: new AbortController().signal,
    strategy: null,
    optimizedTargetCount: null,
    ...overrides,
  };
}

test('PNG requests carry no invented SVG strategy', () => {
  const single = baseRequest({ format: 'png', dpi: 300 });
  assert.equal(assertFigureExportSingleRequest(single), single);

  const batch = baseRequest({
    jobs: [
      { format: 'png', dpi: 150 },
      { format: 'png', dpi: 300 },
    ],
  });
  assert.equal(assertFigureExportBatchRequest(batch), batch);

  assert.throws(
    () => assertFigureExportSingleRequest({
      ...single,
      strategy: 'hybrid',
    }),
    /PNG.*strategy|strategy.*PNG/i
  );
});

test('figure-export requests require one exact AbortSignal owner', () => {
  const exact = baseRequest({ format: 'png', dpi: 300 });
  assert.equal(assertFigureExportSingleRequest(exact), exact);

  for (const signal of [
    null,
    {},
    { aborted: false },
    {
      aborted: false,
      addEventListener() {},
      removeEventListener() {},
    },
    undefined,
  ]) {
    assert.throws(
      () => assertFigureExportSingleRequest({ ...exact, signal }),
      /signal.*AbortSignal|AbortSignal.*signal/i
    );
  }
});

test('SVG requests require one exact, explicit strategy', () => {
  const fullVector = baseRequest({
    format: 'svg',
    dpi: null,
    strategy: 'full-vector',
  });
  assert.equal(assertFigureExportSingleRequest(fullVector), fullVector);

  const optimized = baseRequest({
    format: 'svg',
    dpi: null,
    strategy: 'optimized-vector',
    optimizedTargetCount: 100_000,
  });
  assert.equal(assertFigureExportSingleRequest(optimized), optimized);

  for (const invalid of [
    baseRequest({ format: 'svg', dpi: null }),
    baseRequest({ format: 'svg', dpi: null, strategy: 'ask' }),
    baseRequest({ format: 'svg', dpi: null, strategy: 'hybrid', optimizedTargetCount: 100_000 }),
    baseRequest({ format: 'svg', dpi: null, strategy: 'optimized-vector' }),
  ]) {
    assert.throws(
      () => assertFigureExportSingleRequest(invalid),
      /strategy|optimizedTargetCount/i
    );
  }

  assert.throws(
    () => assertFigureExportBatchRequest(baseRequest({
      jobs: [
        { format: 'svg', dpi: null },
        { format: 'png', dpi: 300 },
      ],
    })),
    /strategy/i
  );

  assert.throws(
    () => assertFigureExportSingleRequest({
      ...fullVector,
      dpi: 300,
    }),
    /dpi.*null|SVG.*dpi/i
  );
});

test('figure-export UI never chooses or changes an SVG strategy automatically', async () => {
  const uiSource = await source('figure-export-ui.js');

  assert.doesNotMatch(uiSource, /promptLargeDatasetStrategy|Large data:\s*Ask/);
  assert.doesNotMatch(uiSource, /value:\s*['"]hybrid['"][^)]*selected:\s*true/s);
  assert.doesNotMatch(uiSource, /strategySelect\.value\s*=/);
  assert.doesNotMatch(uiSource, /strategy\s*!==\s*['"]hybrid['"]|requires Hybrid/i);
  assert.match(uiSource, /value:\s*['"]['"][^)]*Choose SVG strategy/);

  await assert.rejects(
    access(new URL('components/large-dataset-dialog.js', figureExportRoot)),
    /ENOENT/
  );
});

test('SVG renderer has explicit branches and no strategy normalization', async () => {
  const svgSource = await source('renderers/svg-renderer.js');

  assert.doesNotMatch(
    svgSource,
    /optimizedTargetCount\s*\|\||Math\.max\(\s*1000,\s*Math\.floor\(\s*opts\.optimizedTargetCount/
  );
  assert.match(svgSource, /else if \(strategy === ['"]full-vector['"]\)/);
  assert.doesNotMatch(
    svgSource,
    /else\s*\{\s*(?:\/\/[^\n]*\n\s*)?(?:const\s+pointScale|forEachProjectedPoint)/s
  );
});

test('engine validates and archives every staged result before one download', async () => {
  const engineSource = await source('figure-export-engine.js');

  assert.doesNotMatch(engineSource, /suggestedExt|strategy\s*===\s*['"]raster['"]/);
  assert.match(engineSource, /blob\.type !== ['"]image\/svg\+xml['"]/);
  assert.match(engineSource, /blob\.type !== ['"]image\/png['"]/);
  assert.match(engineSource, /field !== null/);
  assert.match(engineSource, /field === null \? null : field\.key/);
  assert.doesNotMatch(engineSource, /field === undefined \? null/);
  assert.match(
    engineSource,
    /if \(stagedDownloads\.length === 1\)[\s\S]+await createFigureExportZip\([\s\S]+downloadBlob\(deliveryBlob, deliveryFilename, \{\s*signal\s*\}\)/s
  );
  assert.equal(
    engineSource.match(/\bdownloadBlob\(/g)?.length,
    1,
    'single and batch exports share one browser download call'
  );
  assert.ok(
    engineSource.indexOf('downloadBlob(deliveryBlob, deliveryFilename, { signal })') >
      engineSource.indexOf('await createFigureExportZip('),
    'a batch archive failure must occur before the one download call'
  );
});

function readStoredZip(bytes) {
  const entries = [];
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 6), 0x0800);
    assert.equal(bytes.readUInt16LE(offset + 8), 0);
    assert.equal(bytes.readUInt16LE(offset + 10), 0);
    assert.equal(bytes.readUInt16LE(offset + 12), 0x0021);
    const compressedSize = bytes.readUInt32LE(offset + 18);
    const uncompressedSize = bytes.readUInt32LE(offset + 22);
    assert.equal(compressedSize, uncompressedSize);
    const filenameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    assert.equal(extraLength, 0);
    const nameStart = offset + 30;
    const dataStart = nameStart + filenameLength;
    const dataEnd = dataStart + uncompressedSize;
    entries.push({
      filename: bytes.toString('utf8', nameStart, dataStart),
      bytes: bytes.subarray(dataStart, dataEnd),
    });
    offset = dataEnd;
  }

  const centralOffset = offset;
  const centralNames = [];
  while (bytes.readUInt32LE(offset) === 0x02014b50) {
    assert.equal(bytes.readUInt16LE(offset + 8), 0x0800);
    assert.equal(bytes.readUInt16LE(offset + 10), 0);
    const filenameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    centralNames.push(
      bytes.toString('utf8', nameStart, nameStart + filenameLength)
    );
    offset = nameStart + filenameLength + extraLength + commentLength;
  }

  assert.equal(bytes.readUInt32LE(offset), 0x06054b50);
  assert.equal(bytes.readUInt16LE(offset + 8), entries.length);
  assert.equal(bytes.readUInt16LE(offset + 10), entries.length);
  assert.equal(bytes.readUInt32LE(offset + 12), offset - centralOffset);
  assert.equal(bytes.readUInt32LE(offset + 16), centralOffset);
  assert.equal(bytes.readUInt16LE(offset + 20), 0);
  assert.equal(offset + 22, bytes.length);
  assert.deepEqual(centralNames, entries.map(entry => entry.filename));
  return entries;
}

test('batch ZIP preserves exact entry bytes in deterministic order', async () => {
  const entries = [
    {
      filename: 'figure.svg',
      blob: new Blob(['<svg/>'], { type: 'image/svg+xml' }),
    },
    {
      filename: 'figure.png',
      blob: new Blob([new Uint8Array([137, 80, 78, 71])], {
        type: 'image/png',
      }),
    },
  ];

  const first = await createFigureExportZip(entries);
  const second = await createFigureExportZip(entries);
  assert.equal(first.type, 'application/zip');
  const firstBytes = Buffer.from(await first.arrayBuffer());
  const secondBytes = Buffer.from(await second.arrayBuffer());
  assert.deepEqual(firstBytes, secondBytes);

  const parsed = readStoredZip(firstBytes);
  assert.deepEqual(
    parsed.map(entry => entry.filename),
    ['figure.svg', 'figure.png']
  );
  assert.equal(parsed[0].bytes.toString('utf8'), '<svg/>');
  assert.deepEqual(
    parsed[1].bytes,
    Buffer.from([137, 80, 78, 71])
  );
});

test('batch ZIP cancellation settles while a staged Blob read is pending', async () => {
  let releaseRead;
  class DeferredBlob extends Blob {
    arrayBuffer() {
      return new Promise((resolve) => {
        releaseRead = () => resolve(new Uint8Array([1, 2, 3]).buffer);
      });
    }
  }

  const controller = new AbortController();
  const pending = createFigureExportZip(
    [
      { filename: 'deferred.svg', blob: new DeferredBlob(['abc']) },
      { filename: 'second.png', blob: new Blob(['png']) },
    ],
    { signal: controller.signal }
  );
  await Promise.resolve();
  assert.equal(typeof releaseRead, 'function');

  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  releaseRead();
});

test('batch ZIP rejects invalid or unreadable staging atomically', async () => {
  class RejectingBlob extends Blob {
    async arrayBuffer() {
      throw new Error('staged artifact read failed');
    }
  }

  await assert.rejects(
    createFigureExportZip([
      { filename: 'figure.svg', blob: new Blob(['<svg/>']) },
      { filename: 'figure.png', blob: new RejectingBlob(['png']) },
    ]),
    /staged artifact read failed/
  );
  await assert.rejects(
    createFigureExportZip([
      { filename: 'duplicate.svg', blob: new Blob(['a']) },
      { filename: 'duplicate.svg', blob: new Blob(['b']) },
    ]),
    /duplicate filename/
  );
  await assert.rejects(
    createFigureExportZip([
      { filename: 'single.svg', blob: new Blob(['a']) },
    ]),
    /at least two staged artifacts/
  );
});

test('PNG renderer uses one browser backend and metadata failures are terminal', async () => {
  const [pngSource, metadataSource] = await Promise.all([
    source('renderers/png-renderer.js'),
    source('utils/png-metadata.js'),
  ]);

  assert.doesNotMatch(pngSource, /OffscreenCanvas|convertToBlob/);
  assert.match(pngSource, /payload\.format !== ['"]png['"]/);
  assert.doesNotMatch(metadataSource, /catch\s*\{|return blob/);

  const onePixelPng = new Blob([
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    ),
  ], { type: 'image/png' });
  const annotated = await embedPngTextChunks(onePixelPng, {
    Comment: 'Exact UTF-8 metadata: hücre',
  });
  assert.equal(annotated.type, 'image/png');
  const annotatedBytes = new Uint8Array(await annotated.arrayBuffer());
  assert.notEqual(
    Buffer.from(annotatedBytes).indexOf(Buffer.from('iTXt')),
    -1
  );
  assert.notEqual(
    Buffer.from(annotatedBytes).indexOf(Buffer.from('hücre', 'utf8')),
    -1
  );

  await assert.rejects(
    embedPngTextChunks(
      new Blob(['not a png'], { type: 'image/png' }),
      { Comment: 'must fail' }
    ),
    /invalid PNG signature/i
  );
});
