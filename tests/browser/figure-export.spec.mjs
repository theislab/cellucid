import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import { dismissWelcome } from './helpers/welcome.mjs';

const PREPARED_DATASET_URL =
  '/?exportsBaseUrl=http%3A%2F%2F127.0.0.1%3A4173%2Ftests%2Fbrowser%2Ffixtures%2Fexports%2F&dataset=current-ui-prepared';
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') {
      errors.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', error => {
    errors.push(`page: ${error.stack || error.message}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      errors.push(`http ${response.status()}: ${response.url()}`);
    }
  });
  return errors;
}

async function installExportProbe(page) {
  await page.addInitScript(() => {
    const events = [];
    Object.defineProperty(window, '__figureExportAcceptance', {
      value: { events },
      configurable: false,
      writable: false,
    });

    const createObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => {
      events.push({
        kind: 'download-url',
        type: blob.type,
        size: blob.size,
      });
      return createObjectURL(blob);
    };

    const canvasToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function toBlob(callback, ...args) {
      return canvasToBlob.call(this, blob => {
        events.push({
          kind: 'canvas-blob-ready',
          type: blob?.type ?? null,
          size: blob?.size ?? null,
        });
        callback(blob);
      }, ...args);
    };
  });
}

async function openFigureExport(page, acceptance) {
  await page.goto(
    `${PREPARED_DATASET_URL}&acceptance=${encodeURIComponent(acceptance)}`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );
  await expect(page.locator('#filter-count')).toHaveText(
    'Showing all 120 points',
  );

  await page.locator('#figure-export-section > summary').click();
  await expect(page.locator('#figure-export-section')).toHaveAttribute('open', '');

  await page.getByRole('button', { name: /^Framing\b/ }).click();
  const widthInput = page.getByLabel('Export width (px)');
  const heightInput = page.getByLabel('Export height (px)');
  await expect(widthInput).toHaveAttribute('aria-label', 'Export width (px)');
  await expect(heightInput).toHaveAttribute('aria-label', 'Export height (px)');
  await widthInput.fill('400');
  await heightInput.fill('300');
  await page.getByRole('button', { name: /^Download\b/ }).click();
  await expect(page.getByLabel('Download format')).toHaveAttribute(
    'aria-label',
    'Download format',
  );
  await expect(page.getByLabel('PNG DPI')).toHaveAttribute(
    'aria-label',
    'PNG DPI',
  );
  await expect(page.getByLabel('SVG point strategy')).toHaveAttribute(
    'aria-label',
    'SVG point strategy',
  );
  await expect(page.getByLabel('Optimized vector target points')).toHaveAttribute(
    'aria-label',
    'Optimized vector target points',
  );
}

async function resetExportProbe(page) {
  await page.evaluate(() => {
    window.__figureExportAcceptance.events.length = 0;
  });
}

async function exportOne({
  page,
  testInfo,
  mode,
  strategy,
  artifactLabel,
}) {
  await page.getByLabel('Download format').selectOption(mode);
  if (strategy !== null) {
    await page.getByLabel('SVG point strategy').selectOption(strategy);
  }
  await resetExportProbe(page);

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#figure-export-btn').click();
  const download = await downloadPromise;
  await expect(page.locator('#figure-export-btn')).toHaveText('Export');
  expect(await download.failure()).toBeNull();

  const extension = mode === 'png' ? 'png' : 'svg';
  const outputPath = testInfo.outputPath(`${artifactLabel}.${extension}`);
  await download.saveAs(outputPath);
  await testInfo.attach(`${artifactLabel}.${extension}`, {
    path: outputPath,
    contentType: extension === 'png' ? 'image/png' : 'image/svg+xml',
  });

  const bytes = await readFile(outputPath);
  const events = await page.evaluate(
    () => [...window.__figureExportAcceptance.events],
  );
  const downloadEvents = events.filter(event => event.kind === 'download-url');
  expect(downloadEvents).toHaveLength(1);
  expect(downloadEvents[0]).toEqual({
    kind: 'download-url',
    type: extension === 'png' ? 'image/png' : 'image/svg+xml',
    size: bytes.length,
  });
  expect(download.suggestedFilename()).toMatch(
    new RegExp(`^[A-Za-z0-9._-]+\\.${extension}$`),
  );

  return { bytes, events, outputPath };
}

function parsePngTextChunks(bytes) {
  expect(bytes.subarray(0, PNG_SIGNATURE.length)).toEqual(PNG_SIGNATURE);

  const metadata = new Map();
  let offset = PNG_SIGNATURE.length;
  let sawIend = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    expect(dataEnd + 4).toBeLessThanOrEqual(bytes.length);

    if (type === 'iTXt') {
      const data = bytes.subarray(dataStart, dataEnd);
      const keywordEnd = data.indexOf(0);
      expect(keywordEnd).toBeGreaterThan(0);
      const keyword = data.toString('ascii', 0, keywordEnd);
      let cursor = keywordEnd + 1;
      expect(data[cursor++]).toBe(0);
      expect(data[cursor++]).toBe(0);
      const languageEnd = data.indexOf(0, cursor);
      expect(languageEnd).toBeGreaterThanOrEqual(cursor);
      cursor = languageEnd + 1;
      const translatedEnd = data.indexOf(0, cursor);
      expect(translatedEnd).toBeGreaterThanOrEqual(cursor);
      cursor = translatedEnd + 1;
      metadata.set(keyword, data.toString('utf8', cursor));
    }

    offset = dataEnd + 4;
    if (type === 'IEND') {
      expect(length).toBe(0);
      expect(offset).toBe(bytes.length);
      sawIend = true;
      break;
    }
  }
  expect(sawIend).toBe(true);
  return metadata;
}

function decodeXmlText(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function assertCurrentMetadata(metadata, {
  format,
  strategy,
  dpi,
}) {
  expect(metadata.generator).toBe('https://cellucid.com');
  expect(metadata.exporter).toEqual({
    name: 'Cellucid',
    website: 'https://cellucid.com',
  });
  expect(Number.isFinite(Date.parse(metadata.exportedAt))).toBe(true);
  expect(metadata.dataset.name).toBe('Current UI prepared fixture');
  expect(metadata.dataset.id).toBe('current-ui-prepared');
  expect(metadata.view.id).toBe('live');
  expect(metadata.filters).toEqual(['No filters active']);
  expect(metadata.export).toMatchObject({
    format,
    width: 400,
    height: 300,
    dpi,
    strategy,
    includeAxes: true,
    includeLegend: true,
  });
}

function assertPngArtifact(bytes) {
  expect(bytes.toString('ascii', 12, 16)).toBe('IHDR');
  expect(bytes.readUInt32BE(16)).toBe(2400);
  expect(bytes.readUInt32BE(20)).toBe(1394);
  const chunks = parsePngTextChunks(bytes);
  expect(chunks.get('Software')).toBe('Cellucid (cellucid.com)');
  expect(chunks.get('Website')).toBe('https://cellucid.com');
  const metadata = JSON.parse(chunks.get('Comment'));
  assertCurrentMetadata(metadata, {
    format: 'png',
    strategy: null,
    dpi: 300,
  });
}

function assertSvgArtifact(bytes, strategy) {
  const svg = bytes.toString('utf8');
  expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
  expect(svg.endsWith('</svg>')).toBe(true);
  const jsonMatch = svg.match(
    /<cellucid:json>([\s\S]+?)<\/cellucid:json>/,
  );
  expect(jsonMatch).not.toBeNull();
  const metadata = JSON.parse(decodeXmlText(jsonMatch[1]));
  assertCurrentMetadata(metadata, {
    format: 'svg',
    strategy,
    dpi: null,
  });

  if (strategy === 'hybrid') {
    expect(svg).toMatch(
      /<image [^>]*href="data:image\/png;base64,[A-Za-z0-9+/=]+"/,
    );
  } else {
    expect(svg).not.toMatch(/<image [^>]*href="data:image\/png;base64,/);
    expect(svg).toMatch(/<circle\b/);
  }
}

test('export cancellation settles native canvas work and cleans download staging', async ({
  page,
}, testInfo) => {
  await page.goto(
    `/?acceptance=${encodeURIComponent(
      `figure-export-cancellation-${testInfo.project.name}`
    )}`,
    { waitUntil: 'domcontentloaded' },
  );

  const result = await page.evaluate(async () => {
    const {
      canvasToBlob,
      downloadBlob,
    } = await import(
      '/assets/js/app/ui/modules/figure-export/utils/export-helpers.js'
    );

    let lateCanvasCallback = null;
    const canvasController = new AbortController();
    const canvasPromise = canvasToBlob(
      {
        toBlob(callback, type) {
          if (type !== 'image/png') {
            throw new Error(`Unexpected canvas type: ${type}`);
          }
          lateCanvasCallback = callback;
        },
      },
      'image/png',
      {
        signal: canvasController.signal,
        failureMessage: 'Browser cancellation fixture failed.',
      }
    );
    canvasController.abort();
    let canvasAbortName = null;
    try {
      await canvasPromise;
    } catch (error) {
      canvasAbortName = error?.name ?? null;
    }
    lateCanvasCallback(new Blob(['late'], { type: 'image/png' }));

    const downloadController = new AbortController();
    const originalAppendChild = document.body.appendChild;
    const originalAnchorClick = HTMLAnchorElement.prototype.click;
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const calls = {
      clicks: 0,
      createdUrls: 0,
      revokedUrls: 0,
    };
    document.body.appendChild = function appendAndAbort(node) {
      const result = originalAppendChild.call(this, node);
      downloadController.abort();
      return result;
    };
    HTMLAnchorElement.prototype.click = function countClick() {
      calls.clicks += 1;
    };
    URL.createObjectURL = () => {
      calls.createdUrls += 1;
      return 'blob:figure-export-cancellation';
    };
    URL.revokeObjectURL = (url) => {
      if (url !== 'blob:figure-export-cancellation') {
        throw new Error(`Unexpected Object URL: ${url}`);
      }
      calls.revokedUrls += 1;
    };

    let downloadAbortName = null;
    try {
      downloadBlob(
        new Blob(['cancelled'], { type: 'image/svg+xml' }),
        'cancelled.svg',
        { signal: downloadController.signal }
      );
    } catch (error) {
      downloadAbortName = error?.name ?? null;
    } finally {
      document.body.appendChild = originalAppendChild;
      HTMLAnchorElement.prototype.click = originalAnchorClick;
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    }

    return {
      ...calls,
      canvasAbortName,
      downloadAbortName,
      danglingAnchors:
        document.querySelectorAll('a[download="cancelled.svg"]').length,
    };
  });

  expect(result).toEqual({
    canvasAbortName: 'AbortError',
    clicks: 0,
    createdUrls: 1,
    danglingAnchors: 0,
    downloadAbortName: 'AbortError',
    revokedUrls: 1,
  });
});

test('figure-export UI teardown aborts a pending renderer without download or terminal toast', async ({
  page,
}, testInfo) => {
  const productErrors = observeProductErrors(page);
  await openFigureExport(
    page,
    `figure-export-teardown-${testInfo.project.name}`,
  );
  await page.getByLabel('Download format').selectOption('png');

  const downloads = [];
  page.on('download', download => {
    downloads.push(download.suggestedFilename());
  });
  await page.evaluate(() => {
    window.__figureExportNativeToBlob =
      HTMLCanvasElement.prototype.toBlob;
    window.__figureExportLateToBlob = null;
    HTMLCanvasElement.prototype.toBlob = function holdToBlob(callback) {
      window.__figureExportLateToBlob = callback;
    };
  });

  await page.locator('#figure-export-btn').click();
  await page.waitForFunction(
    () => typeof window.__figureExportLateToBlob === 'function'
  );
  await page.evaluate(() => {
    const controls = document.querySelector('#figure-export-controls');
    if (typeof controls?.__cellucidCleanup !== 'function') {
      throw new Error('Figure-export cleanup owner is unavailable.');
    }
    controls.__cellucidCleanup();
  });
  await page.evaluate(() => {
    const callback = window.__figureExportLateToBlob;
    HTMLCanvasElement.prototype.toBlob =
      window.__figureExportNativeToBlob;
    callback(new Blob(['late encoder result'], { type: 'image/png' }));
    delete window.__figureExportLateToBlob;
    delete window.__figureExportNativeToBlob;
  });

  await page.waitForTimeout(500);
  expect(downloads).toEqual([]);
  await expect(
    page.locator('.notification-message').filter({
      hasText: /Rendering .*PNG|Export complete|Export failed|Exported \d+ file/,
    })
  ).toHaveCount(0);
  expect(productErrors).toEqual([]);
});

test('teardown during the download click cannot roll back a committed export', async ({
  page,
}, testInfo) => {
  const productErrors = observeProductErrors(page);
  await openFigureExport(
    page,
    `figure-export-download-commit-${testInfo.project.name}`,
  );
  await page.getByLabel('Download format').selectOption('svg');
  await page.getByLabel('SVG point strategy').selectOption('full-vector');
  await page.evaluate(() => {
    window.__figureExportNativeAnchorClick =
      HTMLAnchorElement.prototype.click;
    window.__figureExportCommitAbortCount = 0;
    HTMLAnchorElement.prototype.click = function clickAndTearDown() {
      if (
        this.download &&
        window.__figureExportCommitAbortCount === 0
      ) {
        window.__figureExportCommitAbortCount += 1;
        const controls = document.querySelector('#figure-export-controls');
        if (typeof controls?.__cellucidCleanup !== 'function') {
          throw new Error('Figure-export cleanup owner is unavailable.');
        }
        controls.__cellucidCleanup();
      }
      return window.__figureExportNativeAnchorClick.call(this);
    };
  });

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#figure-export-btn').click();
  const download = await downloadPromise;
  expect(await download.failure()).toBeNull();
  expect(path.extname(download.suggestedFilename())).toBe('.svg');
  await expect(
    page.locator('.notification-message').filter({
      hasText: 'Exported 1 file',
    })
  ).toHaveCount(1);
  await expect(
    page.locator('.notification-message').filter({
      hasText: 'Export failed',
    })
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => window.__figureExportCommitAbortCount)
  ).toBe(1);
  await page.evaluate(() => {
    HTMLAnchorElement.prototype.click =
      window.__figureExportNativeAnchorClick;
    delete window.__figureExportNativeAnchorClick;
    delete window.__figureExportCommitAbortCount;
  });
  expect(productErrors).toEqual([]);
});

function crc32(bytes) {
  let value = 0xffff_ffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) === 1
        ? (0xedb8_8320 ^ (value >>> 1))
        : (value >>> 1);
    }
  }
  return (value ^ 0xffff_ffff) >>> 0;
}

function readStoredZipEntries(bytes) {
  const entries = [];
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const localOffset = offset;
    expect(bytes.readUInt16LE(offset + 6)).toBe(0x0800);
    expect(bytes.readUInt16LE(offset + 8)).toBe(0);
    expect(bytes.readUInt16LE(offset + 10)).toBe(0);
    expect(bytes.readUInt16LE(offset + 12)).toBe(0x0021);
    const expectedCrc = bytes.readUInt32LE(offset + 14);
    const compressedSize = bytes.readUInt32LE(offset + 18);
    const uncompressedSize = bytes.readUInt32LE(offset + 22);
    expect(compressedSize).toBe(uncompressedSize);
    const filenameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    expect(extraLength).toBe(0);
    const nameStart = offset + 30;
    const dataStart = nameStart + filenameLength;
    const dataEnd = dataStart + uncompressedSize;
    expect(dataEnd).toBeLessThanOrEqual(bytes.length);
    const entryBytes = bytes.subarray(dataStart, dataEnd);
    expect(crc32(entryBytes)).toBe(expectedCrc);
    entries.push({
      filename: bytes.toString('utf8', nameStart, dataStart),
      bytes: entryBytes,
      crc: expectedCrc,
      localOffset,
    });
    offset = dataEnd;
  }

  const centralOffset = offset;
  const centralNames = [];
  let centralIndex = 0;
  while (bytes.readUInt32LE(offset) === 0x02014b50) {
    const entry = entries[centralIndex];
    expect(entry).toBeDefined();
    expect(bytes.readUInt16LE(offset + 8)).toBe(0x0800);
    expect(bytes.readUInt16LE(offset + 10)).toBe(0);
    expect(bytes.readUInt32LE(offset + 16)).toBe(entry.crc);
    expect(bytes.readUInt32LE(offset + 20)).toBe(entry.bytes.length);
    expect(bytes.readUInt32LE(offset + 24)).toBe(entry.bytes.length);
    expect(bytes.readUInt32LE(offset + 42)).toBe(entry.localOffset);
    const filenameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    centralNames.push(
      bytes.toString('utf8', nameStart, nameStart + filenameLength),
    );
    offset = nameStart + filenameLength + extraLength + commentLength;
    centralIndex++;
  }

  expect(centralIndex).toBe(entries.length);
  expect(bytes.readUInt32LE(offset)).toBe(0x06054b50);
  expect(bytes.readUInt16LE(offset + 8)).toBe(entries.length);
  expect(bytes.readUInt16LE(offset + 10)).toBe(entries.length);
  expect(bytes.readUInt32LE(offset + 12)).toBe(offset - centralOffset);
  expect(bytes.readUInt32LE(offset + 16)).toBe(centralOffset);
  expect(bytes.readUInt16LE(offset + 20)).toBe(0);
  expect(offset + 22).toBe(bytes.length);
  expect(centralNames).toEqual(entries.map(entry => entry.filename));
  return entries;
}

test('exports PNG and every explicit SVG strategy through the visible UI', async ({
  page,
}, testInfo) => {
  const productErrors = observeProductErrors(page);
  await installExportProbe(page);
  await openFigureExport(page, `figure-export-artifacts-${testInfo.project.name}`);

  const png = await exportOne({
    page,
    testInfo,
    mode: 'png',
    strategy: null,
    artifactLabel: `${testInfo.project.name}-figure-export`,
  });
  assertPngArtifact(png.bytes);

  for (const strategy of [
    'full-vector',
    'optimized-vector',
    'hybrid',
  ]) {
    const svg = await exportOne({
      page,
      testInfo,
      mode: 'svg',
      strategy,
      artifactLabel: `${testInfo.project.name}-figure-export-${strategy}`,
    });
    assertSvgArtifact(svg.bytes, strategy);
  }

  expect(productErrors).toEqual([]);
});

test('framing preview exposes an exact keyboard and toggle lifecycle', async ({
  page,
}, testInfo) => {
  const productErrors = observeProductErrors(page);
  await openFigureExport(
    page,
    `figure-export-framing-accessibility-${testInfo.project.name}`,
  );

  const previewStatus = page.locator('.figure-export-preview-status');
  await expect(previewStatus).toHaveAttribute('role', 'status');
  await expect(previewStatus).toHaveAttribute('aria-live', 'polite');
  await expect(previewStatus).toHaveAttribute('aria-atomic', 'true');

  // openFigureExport() finishes in the Download sub-accordion.
  await page.getByRole('button', { name: /^Framing\b/ }).click();
  await page.getByLabel('Show preview').check();
  await page.getByLabel('Frame export').check();
  const previewCanvas = page.locator('canvas.figure-export-preview');
  await expect(previewCanvas).toHaveAttribute('role', 'img');
  await expect(previewCanvas).toHaveAttribute('tabindex', '0');
  await expect(previewCanvas).toHaveAttribute('aria-disabled', 'false');
  await expect(previewCanvas).toHaveAttribute(
    'aria-label',
    /Arrow keys move the frame; Shift plus arrow keys resize it; Home resets it/,
  );

  await previewCanvas.focus();
  await previewCanvas.press('Shift+ArrowLeft');
  await expect(previewCanvas).toHaveAttribute(
    'aria-label',
    /with 98 percent width/,
  );
  await previewCanvas.press('ArrowRight');
  await expect(previewCanvas).toHaveAttribute(
    'aria-label',
    /starts at 2 percent from the left/,
  );
  await previewCanvas.press('Home');
  await expect(previewCanvas).toHaveAttribute(
    'aria-label',
    /with 100 percent width and 100 percent height/,
  );

  const confirm = page.getByRole('button', { name: 'Confirm' });
  await expect(confirm).toHaveAttribute('aria-pressed', 'false');
  await confirm.click();
  const edit = page.getByRole('button', { name: 'Edit' });
  await expect(edit).toHaveAttribute('aria-pressed', 'true');
  await expect(previewCanvas).toHaveAttribute('tabindex', '-1');
  await expect(previewCanvas).toHaveAttribute('aria-disabled', 'true');

  expect(productErrors).toEqual([]);
});

test('figure-export modal confines focus and restores its exact invoker', async ({
  page,
}, testInfo) => {
  const productErrors = observeProductErrors(page);
  await openFigureExport(
    page,
    `figure-export-modal-accessibility-${testInfo.project.name}`,
  );

  const exportButton = page.locator('#figure-export-btn');
  await exportButton.focus();
  await page.evaluate(async () => {
    const { showFigureExportModal } = await import(
      '/assets/js/app/ui/modules/figure-export/components/modal.js'
    );
    window.__figureModalPriorInert = Array.from(document.body.children).map(
      element => element.inert,
    );
    const content = document.createElement('div');
    for (const label of ['First action', 'Last action']) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      content.appendChild(button);
    }
    window.__figureModalClosed = false;
    showFigureExportModal({
      title: 'Focus ownership test',
      content,
      onClose: () => {
        window.__figureModalClosed = true;
      },
    });
  });

  const modal = page.getByRole('dialog', { name: 'Focus ownership test' });
  await expect(modal).toBeVisible();
  await expect(page.getByRole('button', { name: 'First action' })).toBeFocused();
  expect(
    await page.evaluate(() => (
      Array.from(document.body.children)
        .filter(element => !element.classList.contains('figure-export-modal'))
        .every(element => element.inert)
    )),
  ).toBe(true);

  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Last action' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'First action' })).toBeFocused();
  await page.locator('#glcanvas').evaluate(canvas => canvas.focus());
  await expect(page.getByRole('button', { name: 'First action' })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  await expect(exportButton).toBeFocused();
  expect(
    await page.evaluate(() => ({
      closed: window.__figureModalClosed,
      inert: Array.from(document.body.children).map(element => element.inert),
      priorInert: window.__figureModalPriorInert,
    })),
  ).toEqual({
    closed: true,
    inert: await page.evaluate(() => window.__figureModalPriorInert),
    priorInert: await page.evaluate(() => window.__figureModalPriorInert),
  });
  expect(productErrors).toEqual([]);
});

test('delivers the staged SVG and PNG batch as one atomic ZIP', async ({
  page,
}, testInfo) => {
  const productErrors = observeProductErrors(page);
  await installExportProbe(page);
  await openFigureExport(page, `figure-export-batch-${testInfo.project.name}`);

  await page.getByLabel('Download format').selectOption('svg+png');
  await page.getByLabel('SVG point strategy').selectOption('full-vector');
  await resetExportProbe(page);

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#figure-export-btn').click();
  const download = await downloadPromise;
  await expect(page.locator('#figure-export-btn')).toHaveText('Export');
  expect(await download.failure()).toBeNull();
  expect(path.extname(download.suggestedFilename())).toBe('.zip');
  expect(download.suggestedFilename()).toMatch(
    /^[A-Za-z0-9._-]+_batch_[0-9]{8}_[0-9]{6}\.zip$/,
  );
  const outputPath = testInfo.outputPath(
    `${testInfo.project.name}-figure-export-batch.zip`,
  );
  await download.saveAs(outputPath);
  await testInfo.attach(
    `${testInfo.project.name}-figure-export-batch.zip`,
    {
      path: outputPath,
      contentType: 'application/zip',
    },
  );
  const archiveBytes = await readFile(outputPath);

  const events = await page.evaluate(
    () => [...window.__figureExportAcceptance.events],
  );
  const pngReadyIndex = events.findIndex(
    event => (
      event.kind === 'canvas-blob-ready' &&
      event.type === 'image/png'
    ),
  );
  const firstDownloadIndex = events.findIndex(
    event => event.kind === 'download-url',
  );
  expect(pngReadyIndex).toBeGreaterThanOrEqual(0);
  expect(firstDownloadIndex).toBeGreaterThan(pngReadyIndex);
  expect(events.filter(event => event.kind === 'download-url')).toEqual([{
    kind: 'download-url',
    type: 'application/zip',
    size: archiveBytes.length,
  }]);

  const entries = readStoredZipEntries(archiveBytes);
  expect(entries).toHaveLength(2);
  expect(entries.map(entry => path.extname(entry.filename))).toEqual([
    '.svg',
    '.png',
  ]);
  for (const entry of entries) {
    expect(entry.filename).toMatch(/^[A-Za-z0-9._-]+\.(?:svg|png)$/);
  }
  assertSvgArtifact(entries[0].bytes, 'full-vector');
  assertPngArtifact(entries[1].bytes);
  expect(productErrors).toEqual([]);
});
