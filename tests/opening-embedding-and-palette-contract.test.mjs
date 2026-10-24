/**
 * What a file without Cellucid metadata opens on, and in which colours: the
 * dimension a view starts in (`openingSlot`), and the Scanpy palette a
 * categorical field is coloured with (`scanpyCategoryPalette`,
 * `defaultCategoryColor`, the `palette` of an obs field descriptor).
 *
 * The shapes are those of a segmentation export: three 2-column
 * `X_umap_scale*_latents`, a 3-column t-SNE or spatial array, and wide PCA and
 * latent matrices, with no `X_umap` and no `uns['cellucid']`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { openingSlot } from '../assets/js/data/data-mapping-candidates.js';
import { resolveEmbeddingSlots } from '../assets/js/data/data-mapping.js';
import {
  defaultCategoryColor,
  getCategoryColor,
  scanpyCategoryPalette,
} from '../assets/js/data/palettes.js';
import { checkObsFields } from '../assets/js/data/data-loaders.js';

const entry = (key, width) => ({ key, width, usable: true, reason: null });

test('a guessed 3-column array does not open over the 2D UMAP the file carries', () => {
  const entries = [
    entry('X_pca_scale0_latents', 500),
    entry('X_umap_scale0_latents', 2),
    entry('X_umap_scale1_latents', 2),
    entry('X_tsne_scale0_latents', 3),
    entry('spatial', 3),
    entry('coordinates', 4),
    entry('scale0_latents', 3136),
  ];
  const { slots, guessed } = resolveEmbeddingSlots(entries, { latentKey: null });
  // The guess still fills 3D with the best 3-column array; 3D stays available.
  assert.deepEqual(slots['3d'], { key: 'X_tsne_scale0_latents', columns: [0, 1, 2] });
  assert.deepEqual(slots['2d'], { key: 'X_umap_scale0_latents', columns: [0, 1] });
  assert.deepEqual(guessed, ['embeddings.2d', 'embeddings.3d']);
  // A view starts on the UMAP.
  assert.equal(openingSlot(slots), '2d');
});

test('the owner\'s file shape opens on its first UMAP in 2D; wide arrays fill no 3D slot', () => {
  const entries = [
    entry('X_pca_scale0_latents', 500),
    entry('X_pca_scale1_latents', 50),
    entry('X_pca_scale2_latents', 50),
    entry('X_umap_scale0_latents', 2),
    entry('X_umap_scale1_latents', 2),
    entry('X_umap_scale2_latents', 2),
    entry('coordinates', 4),
    entry('scale0_latents', 3136),
    entry('scale1_latents', 3584),
    entry('scale2_latents', 192),
  ];
  const { slots } = resolveEmbeddingSlots(entries, { latentKey: null });
  assert.deepEqual(slots, {
    '1d': null,
    '2d': { key: 'X_umap_scale0_latents', columns: [0, 1] },
    '3d': null,
  });
  assert.equal(openingSlot(slots), '2d');
});

test('slots of one rank open in the highest dimension, as every UMAP-only file always has', () => {
  const umaps = {
    '1d': { key: 'X_umap_1d', columns: [0] },
    '2d': { key: 'X_umap_2d', columns: [0, 1] },
    '3d': { key: 'X_umap_3d', columns: [0, 1, 2] },
  };
  assert.equal(openingSlot(umaps), '3d');
  assert.equal(openingSlot({ '1d': null, '2d': umaps['2d'], '3d': null }), '2d');
  // Two arrays no name ranks open in the higher dimension too.
  assert.equal(openingSlot({
    '1d': null,
    '2d': { key: 'cells_xy', columns: [0, 1] },
    '3d': { key: 'cells_xyz', columns: [0, 1, 2] },
  }), '3d');
  // A better-ranked name wins over a higher dimension: a spatial 2D layout
  // over a 3-column latent space.
  assert.equal(openingSlot({
    '1d': null,
    '2d': { key: 'spatial', columns: [0, 1] },
    '3d': { key: 'X_scVI', columns: [0, 1, 2] },
  }), '2d');
  assert.throws(() => openingSlot({ '1d': null, '2d': null, '3d': null }), RangeError);
});

test('a Scanpy palette is read as Scanpy reads it', () => {
  assert.deepEqual(
    scanpyCategoryPalette(['#ff0000', '#00FF00', '#0000ff80'], 3),
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  );
  // Short hex, and a longer palette gives its first colours.
  assert.deepEqual(scanpyCategoryPalette(['#f00', '#0f0', '#00f'], 2), [[1, 0, 0], [0, 1, 0]]);
  // Shorter than the categories: Scanpy draws its own colours, so none is used.
  assert.equal(scanpyCategoryPalette(['#ff0000'], 2), null);
  // Anything but a hex colour among the ones used: none is used.
  assert.equal(scanpyCategoryPalette(['#ff0000', 'grey'], 2), null);
  assert.equal(scanpyCategoryPalette(['#ff0000', 'grey'], 1).length, 1);
  assert.equal(scanpyCategoryPalette(null, 2), null);
  assert.equal(scanpyCategoryPalette(['#ff0000'], 0), null);
  assert.throws(() => scanpyCategoryPalette(['#ff0000'], -1), RangeError);
});

test('a field opens in its file\'s palette while it has one colour per category', () => {
  const palette = [[1, 0, 0], [0, 1, 0]];
  const field = { categories: ['a', 'b'], palette };
  assert.deepEqual(defaultCategoryColor(field, 0), [1, 0, 0]);
  assert.deepEqual(defaultCategoryColor(field, 1), [0, 1, 0]);
  // A fresh array: changing it changes no palette.
  defaultCategoryColor(field, 0)[0] = 0.5;
  assert.deepEqual(palette[0], [1, 0, 0]);
  // Without a palette, or once merging changed the category count, the
  // colours are Cellucid's own.
  assert.deepEqual(defaultCategoryColor({ categories: ['a', 'b'], palette: null }, 1), [...getCategoryColor(1)]);
  assert.deepEqual(defaultCategoryColor({ categories: ['a', 'b'] }, 1), [...getCategoryColor(1)]);
  assert.deepEqual(defaultCategoryColor({ categories: ['ab'], palette }, 0), [...getCategoryColor(0)]);
});

function fieldList(field) {
  return {
    n_points: 1,
    outlier_min_points: 10,
    stored_outlier_latent_key: null,
    latent_key: null,
    fields: [{
      key: 'leiden',
      kind: 'category',
      fieldIndex: 0,
      categories: ['0', '1'],
      codesDtype: 'uint8',
      codesMissingValue: 255,
      palette: null,
      outlierQuantilesPath: null,
      ...field,
    }],
  };
}

test('an obs field descriptor carries one palette colour per category, or none', () => {
  assert.deepEqual(
    checkObsFields(fieldList({ palette: [[1, 0, 0], [0, 0.5, 1]] })).fields[0].palette,
    [[1, 0, 0], [0, 0.5, 1]],
  );
  assert.equal(checkObsFields(fieldList({})).fields[0].palette, null);
  for (const palette of [
    [[1, 0, 0]],
    [[1, 0, 0], [0, 2, 0]],
    [[1, 0, 0], [0, 0]],
    [[1, 0, 0], '#00ff00'],
    'auto',
  ]) {
    assert.throws(() => checkObsFields(fieldList({ palette })), /palette must be null or one RGB colour/);
  }
  // A field whose categories are found on load has no palette.
  assert.throws(
    () => checkObsFields(fieldList({ categories: null, codesDtype: null, codesMissingValue: null, palette: [[1, 0, 0]] })),
    /palette must be null/,
  );
  assert.throws(() => {
    const list = fieldList({});
    delete list.fields[0].palette;
    checkObsFields(list);
  }, /missing palette/);
});
