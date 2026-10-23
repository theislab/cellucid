/**
 * The dataset identity the AnnData adapter builds for every
 * dataset it opens (`BaseAnnDataAdapter.finalizeDirectIdentity`), and the
 * one rule it is checked by (`validateDatasetIdentity`).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { validateDatasetIdentity } from '../assets/js/data/data-source.js';

function identity(id, name, cells) {
  return {
    id,
    name,
    description: `${name} description`,
    stats: {
      n_cells: cells,
      n_genes: 2,
      n_obs_fields: 0,
      n_categorical_fields: 0,
      n_continuous_fields: 0,
      has_connectivity: false,
      n_edges: null,
    },
    embeddings: {
      default_dimension: 2,
      defaults: { '2d': 'X_umap' },
      items: {
        X_umap: {
          label: 'X_umap',
          dimension: 2,
          path: 'obsm/0/0-1',
          source: { key: 'X_umap', columns: [0, 1] },
        },
      },
    },
    obs_fields: [],
  };
}

function embeddingItem(dimension, obsmIndex, key = `X_item_${dimension}d`) {
  const columns = Array.from({ length: dimension }, (_, column) => column);
  return {
    label: key,
    dimension,
    path: `obsm/${obsmIndex}/${columns.join('-')}`,
    source: { key, columns },
  };
}

function identityWithObsFields() {
  const value = identity('invalid', 'Fields identity', 3);
  value.stats.n_obs_fields = 2;
  value.stats.n_categorical_fields = 1;
  value.stats.n_continuous_fields = 1;
  value.obs_fields = [
    { key: 'batch', kind: 'category', n_categories: 2 },
    { key: 'score', kind: 'continuous' },
  ];
  return value;
}

async function expectIdentityRejection(_t, value, pattern) {
  assert.throws(() => validateDatasetIdentity(value, 'invalid', 'test'), pattern);
}

test('a dataset identity rejects every incomplete scientific summary', async t => {
  await t.test('undeclared top-level fields are rejected', async t => {
    const value = identity('invalid', 'Identity', 3);
    value.legacy_stats = {};
    await expectIdentityRejection(
      t,
      value,
      /dataset identity.*unsupported field.*legacy_stats/i
    );
  });

  await t.test('an identity id cannot contradict its catalog id', async t => {
    const value = identity('invalid', 'Identity', 3);
    value.id = 'different';
    await expectIdentityRejection(
      t,
      value,
      /dataset identity.*different.*catalog id.*invalid/i
    );
  });

  await t.test('an identity id cannot be omitted', async t => {
    const value = identity('invalid', 'Identity', 3);
    delete value.id;
    await expectIdentityRejection(
      t,
      value,
      /dataset identity.*missing required field.*id/i
    );
  });

  await t.test('description is required and must remain a string', async t => {
    const value = identity('invalid', 'Identity', 3);
    delete value.description;
    await expectIdentityRejection(
      t,
      value,
      /dataset identity.*description/i
    );
  });

  await t.test('all stats fields are required', async t => {
    const value = identity('invalid', 'Identity', 3);
    delete value.stats.n_edges;
    await expectIdentityRejection(
      t,
      value,
      /dataset identity.*stats.*n_edges/i
    );
  });

  await t.test('field summary counts must add up', async t => {
    const value = identity('invalid', 'Identity', 3);
    value.stats.n_obs_fields = 1;
    await expectIdentityRejection(
      t,
      value,
      /dataset identity.*n_obs_fields.*categorical.*continuous/i
    );
  });

  await t.test('false connectivity requires an exact null edge count', async t => {
    const value = identity('invalid', 'Identity', 3);
    value.stats.n_edges = 0;
    await expectIdentityRejection(
      t,
      value,
      /dataset identity.*n_edges.*null.*has_connectivity.*false/i
    );
  });

  await t.test('true connectivity counts its edges, or leaves them for the first read', async t => {
    const deferredCount = identity('invalid', 'Identity', 3);
    deferredCount.stats.has_connectivity = true;
    assert.strictEqual(validateDatasetIdentity(deferredCount, 'invalid', 'test'), deferredCount);
    for (const edges of [-1, 1.5, '2']) {
      const value = identity('invalid', 'Identity', 3);
      value.stats.has_connectivity = true;
      value.stats.n_edges = edges;
      await expectIdentityRejection(
        t,
        value,
        /dataset identity.*n_edges.*non-negative safe integer/i
      );
    }
  });
});

test('a dataset identity requires exact embedding metadata', async t => {
  await t.test('alias-resolution metadata is not part of the current identity', async t => {
    const value = identity('invalid', 'Identity', 3);
    value.embeddings.umap_resolution = {
      source_key: 'X_umap',
      action: 'used_as',
    };
    await expectIdentityRejection(
      t,
      value,
      /dataset identity.*embeddings.*unsupported field.*umap_resolution/i
    );
  });

  await t.test('embeddings hold no member beyond defaults and items', async t => {
    const value = identity('invalid', 'Identity', 3);
    value.embeddings.available_dimensions = [2];
    await expectIdentityRejection(
      t,
      value,
      /dataset identity.*embeddings.*unsupported field.*available_dimensions/i
    );
  });

  await t.test('embedding items must be a non-empty object', async t => {
    for (const items of [[], {}, null]) {
      const value = identity('invalid', 'Identity', 3);
      value.embeddings.items = items;
      await expectIdentityRejection(
        t,
        value,
        /dataset identity.*embeddings\.items.*non-empty object/i
      );
    }
  });

  await t.test('embedding items must be ordered by dimension, then id', async t => {
    const byDimension = identity('invalid', 'Identity', 3);
    byDimension.embeddings = {
      default_dimension: 3,
      defaults: { '2d': 'X_umap', '3d': 'X_tsne' },
      items: {
        X_tsne: embeddingItem(3, 0),
        X_umap: embeddingItem(2, 1, 'X_umap'),
      },
    };
    await expectIdentityRejection(
      t,
      byDimension,
      /dataset identity.*embeddings\.items.*ordered by dimension.*code-point/i
    );

    const byId = identity('invalid', 'Identity', 3);
    byId.embeddings = {
      default_dimension: 2,
      defaults: { '2d': 'X_umap' },
      items: {
        X_umap: embeddingItem(2, 0, 'X_umap'),
        X_pca: embeddingItem(2, 1, 'X_pca'),
      },
    };
    await expectIdentityRejection(
      t,
      byId,
      /dataset identity.*embeddings\.items.*ordered by dimension.*code-point/i
    );
  });

  await t.test('embedding items hold exactly label, dimension, path, and source', async t => {
    const extra = identity('invalid', 'Identity', 3);
    extra.embeddings.items.X_umap.basis = 'umap';
    await expectIdentityRejection(
      t,
      extra,
      /dataset identity.*embeddings\.items\.X_umap.*unsupported field.*basis/i
    );

    const missing = identity('invalid', 'Identity', 3);
    delete missing.embeddings.items.X_umap.source;
    await expectIdentityRejection(
      t,
      missing,
      /dataset identity.*embeddings\.items\.X_umap.*missing required field.*source/i
    );
  });

  await t.test('embedding ids and labels must be exact display text', async t => {
    const paddedId = identity('invalid', 'Identity', 3);
    paddedId.embeddings.items = {
      ' X_umap': paddedId.embeddings.items.X_umap,
    };
    paddedId.embeddings.defaults['2d'] = ' X_umap';
    await expectIdentityRejection(
      t,
      paddedId,
      /dataset identity.*Embedding id.*cannot be displayed exactly/i
    );

    const emptyLabel = identity('invalid', 'Identity', 3);
    emptyLabel.embeddings.items.X_umap.label = '';
    await expectIdentityRejection(
      t,
      emptyLabel,
      /dataset identity.*embeddings\.items\.X_umap\.label.*cannot be displayed exactly/i
    );
  });

  await t.test('embedding dimensions must be 1, 2, or 3', async t => {
    for (const dimension of [0, 4, 2.5, '2']) {
      const value = identity('invalid', 'Identity', 3);
      value.embeddings.items.X_umap.dimension = dimension;
      await expectIdentityRejection(
        t,
        value,
        /dataset identity.*embeddings\.items\.X_umap\.dimension.*1, 2, or 3/i
      );
    }
  });

  await t.test('default dimension must be named in defaults', async t => {
    const value = identity('invalid', 'Identity', 3);
    value.embeddings.default_dimension = 3;
    await expectIdentityRejection(
      t,
      value,
      /dataset identity.*default_dimension.*embeddings\.defaults/i
    );
  });

  await t.test('defaults must use exact dimensional keys, one per item dimension', async t => {
    for (const defaults of [
      { 2: 'X_umap' },
      {},
      { '2d': 'X_umap', '3d': 'X_umap' },
    ]) {
      const value = identity('invalid', 'Identity', 3);
      value.embeddings.defaults = defaults;
      await expectIdentityRejection(
        t,
        value,
        /dataset identity.*embeddings\.defaults.*exactly one item per embedding dimension/i
      );
    }
  });

  await t.test('defaults must name an item of their own dimension', async t => {
    const unknown = identity('invalid', 'Identity', 3);
    unknown.embeddings.defaults['2d'] = 'X_missing';
    await expectIdentityRejection(
      t,
      unknown,
      /dataset identity.*embeddings\.defaults\.2d.*item of that dimension/i
    );

    const wrongDimension = identity('invalid', 'Identity', 3);
    wrongDimension.embeddings = {
      default_dimension: 3,
      defaults: { '2d': 'X_umap', '3d': 'X_umap' },
      items: {
        X_umap: embeddingItem(2, 0, 'X_umap'),
        X_umap_3d: embeddingItem(3, 1),
      },
    };
    await expectIdentityRejection(
      t,
      wrongDimension,
      /dataset identity.*embeddings\.defaults\.3d.*item of that dimension/i
    );
  });

  await t.test('embedding paths must be the obsm route of their source columns', async t => {
    for (const path of [
      'obsm/0/1-0',
      'obsm/0/0',
      'obsm/0/0-1-2',
      'obsm/x/0-1',
      'obsm/00/0-1',
      './obsm/0/0-1',
      ' obsm/0/0-1',
      'obsm/0/0-1?download=1',
      7,
      null,
    ]) {
      const value = identity('invalid', 'Identity', 3);
      value.embeddings.items.X_umap.path = path;
      await expectIdentityRejection(
        t,
        value,
        /dataset identity.*embeddings\.items\.X_umap\.path must be the obsm route of its source columns/i
      );
    }
  });

  await t.test('embedding source holds its obsm key and one distinct column per axis', async t => {
    for (const source of [
      { key: 'X_umap' },
      { key: null, columns: [0, 1] },
      { key: 'X_umap', columns: [0, 1], basis: 'umap' },
      { key: '', columns: [0, 1] },
      { key: 7, columns: [0, 1] },
      { key: 'X_umap', columns: [0] },
      { key: 'X_umap', columns: [0, 0] },
      { key: 'X_umap', columns: [0, -1] },
      { key: 'X_umap', columns: [0, 1.5] },
      { key: 'X_umap', columns: null },
    ]) {
      const value = identity('invalid', 'Identity', 3);
      value.embeddings.items.X_umap.source = source;
      await expectIdentityRejection(
        t,
        value,
        /dataset identity.*embeddings\.items\.X_umap\.source/i
      );
    }
  });

  await t.test(
    'multi-item embeddings with spaces and single-encoded Unicode ids remain exact',
    async t => {
      const value = identity('invalid', 'Identity', 3);
      value.embeddings = {
        default_dimension: 3,
        defaults: { '1d': 'pseudotime', '2d': 'cell atlas 细胞', '3d': 'X_umap_3d' },
        items: {
          pseudotime: embeddingItem(1, 0),
          X_umap: embeddingItem(2, 1, 'X_umap'),
          'cell atlas 细胞': {
            label: 'Cell atlas 细胞',
            dimension: 2,
            path: 'obsm/2/3-1',
            source: { key: 'X_atlas', columns: [3, 1] },
          },
          X_umap_3d: embeddingItem(3, 3),
        },
      };
      const datasets = [validateDatasetIdentity(value, 'invalid', 'test')];
      assert.deepEqual(datasets[0].embeddings, value.embeddings);
      assert.deepEqual(
        Object.keys(datasets[0].embeddings.items),
        ['pseudotime', 'X_umap', 'cell atlas 细胞', 'X_umap_3d']
      );
    }
  );
});

test('a dataset identity requires exact observation summaries', async t => {
  await t.test('obs_fields length must match stats', async t => {
    const value = identity('invalid', 'Identity', 3);
    value.obs_fields.push({ key: 'score', kind: 'continuous' });
    await expectIdentityRejection(
      t,
      value,
      /dataset identity.*obs_fields length.*n_obs_fields/i
    );
  });

  await t.test('categorical fields require category counts', async t => {
    const value = identityWithObsFields();
    delete value.obs_fields[0].n_categories;
    await expectIdentityRejection(
      t,
      value,
      /dataset identity.*obs_fields\[0\].*n_categories/i
    );
  });

  await t.test('continuous fields cannot carry categorical summaries', async t => {
    const value = identityWithObsFields();
    value.obs_fields[1].n_categories = 2;
    await expectIdentityRejection(
      t,
      value,
      /dataset identity.*obs_fields\[1\].*unsupported.*n_categories/i
    );
  });

  await t.test('field keys must be unique', async t => {
    const value = identityWithObsFields();
    value.obs_fields[1].key = 'batch';
    await expectIdentityRejection(
      t,
      value,
      /dataset identity.*duplicate key.*batch/i
    );
  });

  await t.test('field kinds must agree with aggregate stats', async t => {
    const value = identityWithObsFields();
    value.stats.n_categorical_fields = 2;
    value.stats.n_continuous_fields = 0;
    await expectIdentityRejection(
      t,
      value,
      /dataset identity.*obs_fields kinds.*stats/i
    );
  });
});

test('optional identity metadata is preserved only when valid', async t => {
  await t.test('valid optional metadata is preserved exactly', () => {
    const value = identity('first', 'Identity', 3);
    value.source = {
      name: 'Public source',
      url: 'https://example.test/data',
      filename: 'atlas.h5ad',
    };
    value.citation = { text: 'Doe et al. 2026', url: 'https://doi.org/10.1/x' };
    value.vector_field_default = 'velocity';
    assert.strictEqual(validateDatasetIdentity(value, 'first', 'test'), value);
  });

  await t.test('optional members are checked exactly', async t => {
    const citationInSource = identity('invalid', 'Identity', 3);
    citationInSource.source = { name: 'Lab', citation: 'Doe 2026' };
    await expectIdentityRejection(t, citationInSource, /source contains unsupported field 'citation'/);
    const badCitation = identity('invalid', 'Identity', 3);
    badCitation.citation = { url: 'https://doi.org/10.1/x' };
    await expectIdentityRejection(t, badCitation, /citation is missing required field 'text'/);
    for (const field of ['', ' velocity', null, 3]) {
      const badDefault = identity('invalid', 'Identity', 3);
      badDefault.vector_field_default = field;
      await expectIdentityRejection(t, badDefault, /vector_field_default.*cannot be displayed exactly/);
    }
  });

  await t.test('malformed optional containers are rejected', async t => {
    const value = identity('invalid', 'Identity', 3);
    value.source = [];
    await expectIdentityRejection(
      t,
      value,
      /dataset identity.*source.*object/i
    );
  });

});

