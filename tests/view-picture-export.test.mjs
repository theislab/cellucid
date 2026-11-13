/**
 * An agent preparing a figure sees the figure it is about to export:
 * `view.picture` takes `source: 'export'`, the figure exactly as Export would
 * download it (the Figure export panel's settings, every view while Export
 * all views is on), scaled down into the box asked for. A picture of one view
 * with plain settings (the screen's background and grid, no title, 12 px
 * text, no frame) cannot show a white background, no grid, a frame and 24 px
 * text, or a panel title cut off.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createViewReads } from '../assets/js/app/reads/views.js';
import { getActionCatalog } from '../assets/js/app/actions/index.js';

function pngBytes(width, height) {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

function setUp({ figure = { width: 1572, height: 1199 }, plot = null, renderExportPicture = undefined } = {}) {
  const drawn = [];
  const calls = [];
  const documentRef = {
    getElementById: () => null,
    createElement: () => {
      const out = { width: 0, height: 0 };
      out.getContext = () => ({
        drawImage: (...args) => drawn.push(args),
        getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(200) }),
        putImageData: (image) => drawn.push(['put', image.data[0]]),
      });
      out.toBlob = (done, type) => {
        assert.equal(type, 'image/png');
        done(new Blob([pngBytes(out.width, out.height)]));
      };
      return out;
    },
  };
  const viewer = {
    getLiveViewLabel: () => 'cell_type',
    getSnapshotViews: () => [{ id: 'v2', label: 'Sox9' }],
    getLiveViewHidden: () => false,
    getViewName: id => (id === 'v2' ? 'Sox9 (ductal)' : null),
    getShowConnectivity: () => false,
    hasConnectivityData: () => false,
  };
  const state = { pointCount: 3696, getActiveViewId: () => 'live' };
  const figureExport = {
    renderFigure: async () => { throw new Error('an export picture is not a plain figure picture'); },
    renderExportPicture: renderExportPicture ?? (async how => {
      calls.push(how);
      // The panel's figure fills the width it asks (figure pixels), a PNG download at 300 dpi.
      return { blob: new Blob([pngBytes(figure.width, figure.height)]), notes: [], plot, asked: { width: figure.width }, dpi: 300 };
    }),
  };
  const reads = createViewReads({ state, viewer, documentRef, getFigureExport: () => figureExport });
  return { reads, drawn, calls };
}

const previousBitmap = globalThis.createImageBitmap;
test.before(() => {
  // The figure's PNG, decoded: its size from the header.
  globalThis.createImageBitmap = async blob => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer);
    return { width: view.getUint32(16), height: view.getUint32(20), close() {} };
  };
});
test.after(() => { globalThis.createImageBitmap = previousBitmap; });

test('source "export" is the figure Export would write, scaled down into the box asked for', async () => {
  const { reads, drawn, calls } = setUp();
  const signal = new AbortController().signal;
  const out = await reads.picture({ source: 'export', width: 800, height: 800, legend: true }, { signal });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].signal, signal, 'the caller\'s Stop reaches the render');
  // 1572 × 1199 fitted into 800 × 800: width-bound.
  assert.equal(out.width, 800);
  assert.equal(out.height, 610);
  assert.equal(drawn.length, 1);
  // Its printed size first: millimetres, and a PNG download's pixels at its DPI.
  assert.equal(out.notes[0], 'The figure is 416 × 317 mm as printed (its text at its point sizes); a PNG at 300 dpi is 4913 × 3747 px, an SVG the same size in millimetres.');
  assert.match(out.notes[1], /^Its height follows from its plots' shapes/);
  assert.equal(out.notes[2], 'The picture is the figure at 96 dpi (1572 × 1199 px), shown at 51% (800 × 610).');
  // Every view composed: no single view or plot.
  assert.equal(out.view, null);
  assert.equal(out.plot, null);
});

test('a figure smaller than the box is returned as drawn, never enlarged', async () => {
  const { reads, drawn } = setUp({ figure: { width: 700, height: 500 }, plot: { width: 600, height: 480 } });
  const out = await reads.picture({ source: 'export', width: 1200, height: 1200, legend: true }, { signal: new AbortController().signal });
  assert.equal(out.width, 700);
  assert.equal(out.height, 500);
  assert.deepEqual(out.plot, { width: 600, height: 480 });
  assert.equal(out.view, 'View 1');
  assert.equal(out.notes[2], 'The picture is the figure at 96 dpi (700 × 500 px).');
  assert.equal(drawn.length, 1);
});

test('a view named with source "export" is refused with what to do; no export, no picture', async () => {
  const { reads, calls } = setUp();
  await assert.rejects(
    reads.picture({ source: 'export', view: 'View 2', width: 640, height: 480, legend: true }, { signal: new AbortController().signal }),
    /draws what Export would download.*leave view out/,
  );
  assert.equal(calls.length, 0);
});

test('the figure\'s own refusals and notes reach the agent', async () => {
  const refused = setUp({ renderExportPicture: async () => { throw new Error('The figure export settings are not valid: Width must be at least 100.'); } });
  await assert.rejects(
    refused.reads.picture({ source: 'export', width: 640, height: 480, legend: true }, { signal: new AbortController().signal }),
    /not valid: Width/,
  );
  const noted = setUp({
    renderExportPicture: async () => ({ blob: new Blob([pngBytes(640, 480)]), notes: ['Velocity overlay not exported: …'], plot: { width: 600, height: 450 }, asked: { width: 640 }, dpi: 300 }),
  });
  const out = await noted.reads.picture({ source: 'export', width: 640, height: 480, legend: true }, { signal: new AbortController().signal });
  // After the size (two notes) and the picture's own.
  assert.deepEqual(out.notes.slice(3), ['Velocity overlay not exported: …']);
});

test('the figure says its printed size, and when it is wider than the width asked, why', async () => {
  const signal = new AbortController().signal;
  const picture = async (figure, askedWidth) => (await setUp({
    renderExportPicture: async () => ({ blob: new Blob([pngBytes(figure.width, figure.height)]), notes: [], plot: null, asked: { width: askedWidth }, dpi: 300 }),
  }).reads.picture({ source: 'export', width: 4000, height: 4000, legend: true }, { signal })).notes;
  // 180 mm asked (680 figure pixels, 1/96 inch): the figure fills it; its height is its plots'.
  const filled = await picture({ width: 680, height: 584 }, 680);
  assert.equal(filled[0], 'The figure is 180 × 155 mm as printed (its text at its point sizes); a PNG at 300 dpi is 2125 × 1825 px, an SVG the same size in millimetres.');
  assert.match(filled[1], /^Its height follows from its plots' shapes \(each keeps its view's, or its frame's: frame "cells" fits the cells\)\.$/);
  // A figure its legends or its plots' least readable size make wider than asked says so.
  const wider = await picture({ width: 954, height: 841 }, 680);
  assert.match(wider[0], /^The figure is 252 × 223 mm as printed/);
  assert.match(wider[1], /^It is wider than the 180 mm asked: its plots' least readable size, a title or a legend needs more\./);
  // A legend asked beside the plot that stands below it to keep to the width is said.
  const moved = (await setUp({
    renderExportPicture: async () => ({ blob: new Blob([pngBytes(336, 300)]), notes: [], plot: null, asked: { width: 336 }, dpi: 300, legendMovedBelow: true }),
  }).reads.picture({ source: 'export', width: 4000, height: 4000, legend: true }, { signal })).notes;
  assert.ok(moved.includes('Its legend stands below the plot: beside it, the figure would be wider than asked.'));
  assert.equal(filled.some(note => /legend stands below/.test(note)), false);
});

test('with the preview\'s color-vision simulation on, the export picture is drawn as that reader sees it', async () => {
  const signal = new AbortController().signal;
  const { reads, drawn } = setUp({ renderExportPicture: async () => ({ blob: new Blob([pngBytes(400, 300)]), notes: [], plot: null, asked: { width: 400 }, dpi: 300, colorblindMode: 'deuteranopia' }) });
  const out = await reads.picture({ source: 'export', width: 800, height: 800, legend: true }, { signal });
  assert.ok(out.notes.includes('Drawn as a reader with deuteranopia sees it (the preview\'s color-vision simulation); Export writes the true colors.'));
  const plain = setUp({ renderExportPicture: async () => ({ blob: new Blob([pngBytes(400, 300)]), notes: [], plot: null, asked: { width: 400 }, dpi: 300, colorblindMode: 'none' }) });
  const shown = await plain.reads.picture({ source: 'export', width: 800, height: 800, legend: true }, { signal });
  assert.equal(shown.notes.some(note => /color-vision/.test(note)), false);
  assert.ok(drawn.some(entry => entry[0] === 'put'), 'the simulated pixels are what is encoded');
});

test('the catalog offers the export picture, and the figure actions point to it', () => {
  const catalog = getActionCatalog();
  const picture = catalog.get('view.picture');
  assert.ok(picture.params.properties.source.enum.includes('export'));
  assert.match(picture.summary, /source "export"/);
  assert.match(catalog.get('figure-export.set').summary, /view\.picture with source "export"/);
  assert.match(catalog.get('figure.export').summary, /view\.picture with source "export"/);
  assert.deepEqual(picture.result.properties.view.type, ['string', 'null']);
});
