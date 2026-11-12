/**
 * The short names embeddings are listed by (Data mapping's checklist, the
 * View N shows picker, view rows, the Dataset box): a MuData modality's
 * arrays are named as the dataset's own are, their modality after them
 * (R9M-10: they were listed by their raw keys, `rna:X_phate3`, beside
 * `UMAP` and `t-SNE`), and a Seurat key with dots is split at them. Two
 * arrays a menu would list the same way are named by their keys (R9U-6:
 * Garcia, He and Kanemaru listed `X_umap` and `X_umap_2d` both as "UMAP 2D").
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { representationKeyName, representationName } from '../assets/js/data/representation-names.js';

test('a modality\'s array is named as its own, its modality after it', () => {
  assert.equal(representationKeyName('rna:X_umap'), 'UMAP (rna)');
  assert.equal(representationKeyName('prot:X_umap'), 'UMAP (prot)');
  assert.equal(representationKeyName('rna:spatial'), 'Spatial (rna)');
  assert.equal(representationKeyName('rna:X_tsne_3d'), 't-SNE (rna)');
  assert.equal(
    representationName({ label: 'rna:X_pca', layoutKey: 'rna:X_pca[2,3]', provenance: { key: 'rna:X_pca', columns: [2, 3] }, width: 50 }),
    'PCA 3,4 (rna)'
  );
  assert.equal(
    representationName({ label: 'rna:X_umap', layoutKey: 'rna:X_umap', provenance: { key: 'rna:X_umap', columns: [0, 1] }, width: 2 }),
    'UMAP (rna)'
  );
});

test('a Seurat reduction key with dots is split at them; the dataset\'s own keys are named as before', () => {
  assert.equal(representationKeyName('X_wnn.umap'), 'WNN UMAP');
  assert.equal(representationKeyName('X_ref.umap'), 'ref UMAP');
  assert.equal(representationKeyName('X_umap_3d'), 'UMAP');
  assert.equal(representationKeyName('X_draw_graph_fa'), 'ForceAtlas2');
  assert.equal(representationKeyName('UMAP_harmony'), 'UMAP Harmony');
  assert.equal(
    representationName({ label: 'X_pca', layoutKey: 'X_pca[0,1]', provenance: { key: 'X_pca', columns: [0, 1] }, width: 50 }),
    'PCA 1,2'
  );
});

test('arrays a menu would list the same way are named by their keys; ones the dimension tells apart are not (R9U-6)', () => {
  // The Garcia, He and Kanemaru samples' obsm.
  const arrays = [['scvi', 10], ['X_pca', 50], ['X_umap', 2], ['X_umap_1d', 1], ['X_umap_2d', 2], ['X_umap_3d', 3]]
    .map(([key, width]) => ({ key, width }));
  const named = key => representationName({ label: key, layoutKey: key, provenance: { key, columns: null } }, { arrays });
  assert.equal(named('X_umap'), 'UMAP (X_umap)');
  assert.equal(named('X_umap_2d'), 'UMAP (X_umap_2d)');
  assert.equal(named('X_umap_1d'), 'UMAP');
  assert.equal(named('X_umap_3d'), 'UMAP');
  assert.equal(named('X_pca'), 'PCA');
  assert.equal(representationKeyName('X_umap', { arrays }), 'UMAP (X_umap)');
  // A column selection keeps its columns before the key; a modality's twins are named by theirs.
  assert.equal(
    representationName({ label: 'X_umap', layoutKey: 'X_umap[1]', provenance: { key: 'X_umap', columns: [1] }, width: 2 }, { arrays }),
    'UMAP 2 (X_umap)'
  );
  const mudata = [{ key: 'rna:X_umap', width: 2 }, { key: 'rna:X_umap_2d', width: 2 }, { key: 'prot:X_umap', width: 2 }];
  assert.equal(representationKeyName('rna:X_umap', { arrays: mudata }), 'UMAP (rna:X_umap)');
  assert.equal(representationKeyName('prot:X_umap', { arrays: mudata }), 'UMAP (prot)');
  // Without the dataset's arrays (a name read alone), the short name.
  assert.equal(representationKeyName('X_umap'), 'UMAP');
});
