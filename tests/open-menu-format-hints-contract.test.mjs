/**
 * The format hints the interface shows agree with the format registry
 * (`data/input-formats.js`): the File… item names every format a single file
 * opens as, the Folder… item every folder format, and the drop overlay names
 * no format list that the registry can outgrow. The hints were written by
 * hand and fell behind it (no .rda; the overlay named three of eleven), and
 * then named h5Seurat, which the registry recognises only to refuse.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { INPUT_FORMATS } from '../assets/js/data/input-formats.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function hintOf(itemId) {
  const match = new RegExp(`id="${itemId}"[^>]*>.*?<span class="open-menu-item-hint">([^<]*)</span>`).exec(html);
  assert.ok(match, itemId);
  return match[1].toLowerCase();
}

/** A format is named by its label's first word or by one of its names. */
function names(format, layout) {
  const words = [format.label.split(/[\s(]/)[0].toLowerCase(), ...format.names[layout].map(name => name.toLowerCase())];
  return words;
}

test('File… names every single-file format Cellucid opens, and none it refuses', () => {
  const hint = hintOf('user-data-file-item');
  for (const format of INPUT_FORMATS.filter(item => item.names.file)) {
    const named = names(format, 'file').some(word => hint.includes(word.replace(/\.gz$/, '')));
    // A format the registry recognises only to refuse (h5Seurat) is not
    // offered as something that opens: the hint listed it while every such
    // file was refused.
    if (format.refusal === undefined) assert.ok(named, `${format.id}: ${hint}`);
    else assert.ok(!named, `${format.id} is refused, so the hint does not name it: ${hint}`);
  }
});

test('Folder… names every folder format', () => {
  const hint = hintOf('user-data-folder-item');
  for (const format of INPUT_FORMATS.filter(item => item.names.folder || item.id === 'tenx-outs' || item.id === 'mtx')) {
    // Any word of its label (a MuData Zarr store is a Zarr folder) or name.
    const words = [
      ...format.label.toLowerCase().split(/[\s()/]+/).filter(word => word.length > 2 && word !== 'folder'),
      ...(format.names.folder ?? []).map(name => name.replace(/^\./, '').toLowerCase()),
      format.id === 'tenx-outs' ? '10x outs' : null,
    ].filter(Boolean);
    assert.ok(words.some(word => hint.includes(word)), `${format.id}: ${hint}`);
  }
});

test('the drop overlay names no format list', () => {
  const hint = /<p class="dataset-drop-hint">([^<]*)<\/p>/.exec(html)[1];
  assert.doesNotMatch(hint, /\.\w+/, hint);
});
