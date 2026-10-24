/**
 * Launch defaults: the choices a dataset opened from an AnnData file starts
 * with when a launch names them (`cellucid serve`, `serve_anndata`,
 * `show_anndata` pass the server options through). Every key is optional and
 * an absent key keeps the automatic choice; a named choice seeds the
 * data-mapping catalog's defaults, so the panel can still change it. Read
 * from a real `.h5ad` and Zarr ZIP through the reader worker's own handler.
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { requireAnnDataLaunchDefaults } from '../assets/js/data/base-anndata-adapter.js';
import { H5adDataSource } from '../assets/js/data/h5ad.js';
import { ZarrDataSource } from '../assets/js/data/zarr.js';
import { AnnDataReaderClient } from '../assets/js/data/anndata-reader-client.js';
import { storedObsm } from './helpers/stored-obsm.mjs';
import { normalizePositions } from '../assets/js/rendering/gl-utils.js';

function silenceNotifications(t) {
  const notifications = getNotificationCenter();
  const names = ['startDownload', 'updateDownload', 'completeDownload', 'failDownload', 'dismissDownload', 'warning', 'error', 'info', 'loading', 'complete', 'fail', 'dismiss'];
  const originals = new Map(names.map(name => [name, notifications[name]]));
  let next = 0;
  for (const name of names) notifications[name] = () => `${name}-${++next}`;
  t.after(() => {
    for (const [name, method] of originals) {
      if (method === undefined) delete notifications[name];
      else notifications[name] = method;
    }
  });
}

async function open(t, format, defaults) {
  silenceNotifications(t);
  if (format === 'H5AD') {
    const file = new File([await readFile(new URL('./browser/fixtures/data-mapping-full.h5ad', import.meta.url))], 'data-mapping-full.h5ad');
    const source = new H5adDataSource();
    t.after(() => source.clear());
    await source.loadFromFile(file, { defaults });
    return source;
  }
  const file = new File([await readFile(new URL('./browser/fixtures/data-mapping-full.zarr.zip', import.meta.url))], 'data-mapping-full.zarr.zip');
  const source = new ZarrDataSource();
  t.after(() => source.clear());
  await source.loadFromArchiveFile(file, { defaults });
  return source;
}

test('launch defaults are checked by name and type before anything is read', () => {
  assert.deepEqual(requireAnnDataLaunchDefaults({}), {});
  assert.throws(
    () => requireAnnDataLaunchDefaults({ knnKey: 'connectivities', embedding: 'X_umap' }),
    /Unknown AnnData launch defaults \['knnKey', 'embedding'\]; the defaults are \['embedding1d'/
  );
  assert.throws(() => requireAnnDataLaunchDefaults({ expression: 'raw' }), /'X', 'raw\/X', 'layers\/<name>' or null/);
  assert.throws(() => requireAnnDataLaunchDefaults({ centroidOutlierQuantile: 0.9 }), /Unknown AnnData launch default \['centroidOutlierQuantile'\]/);
  assert.throws(() => requireAnnDataLaunchDefaults({ centroidMinPoints: 0 }), /positive integer/);
  assert.throws(() => requireAnnDataLaunchDefaults({ obsKeys: [] }), /at least one obs column/);
  assert.throws(() => requireAnnDataLaunchDefaults({ normalizeEmbeddings: 'no' }), /true or false/);
  assert.throws(() => requireAnnDataLaunchDefaults({ embedding2d: ['X_pca'] }), /obsm key, or \{key, columns\}/);
  assert.deepEqual(
    requireAnnDataLaunchDefaults({ embedding2d: { key: 'X_pca', columns: [2, 0] }, knn: null, embedding3d: null }),
    { embedding2d: { key: 'X_pca', columns: [2, 0] }, knn: null }
  );
  // Checked defaults check again unchanged (a source checks them before
  // reading, the adapter when it is made).
  const checked = requireAnnDataLaunchDefaults({ embedding1d: 'X_umap_1d', obsKeys: ['a'], latentKey: null });
  assert.deepEqual(requireAnnDataLaunchDefaults(checked), checked);
});

for (const format of ['H5AD', 'Zarr ZIP']) {
  test(`${format}: named launch defaults seed the catalog, the field lists and the reads`, async t => {
    const source = await open(t, format, {
      embedding2d: { key: 'X_pca', columns: [3, 1] },
      knn: 'scvi_connectivities',
      expression: 'layers/log1p',
      geneIdColumn: 'gene_symbols',
      latentKey: 'X_scVI',
      obsKeys: ['cell_type'],
      normalizeEmbeddings: false,
      centroidMinPoints: 3,
    });
    const adapter = source.getAdapter();
    const defaults = adapter.getMappingCandidates().defaults;
    assert.deepEqual(defaults.embeddings.defaults['2d'], { key: 'X_pca', columns: [3, 1] });
    assert.equal(defaults.knn, 'scvi_connectivities');
    assert.equal(defaults.expression, 'layer:log1p');
    assert.equal(defaults.geneNames, 'column:gene_symbols');
    assert.equal(defaults.latent, 'X_scVI');
    assert.ok(
      !defaults.embeddings.enabled.some(ref => ref.key === 'X_scVI'),
      'the latent space is not offered as an embedding'
    );
    assert.ok(!adapter.getMappingCandidates().guessed.includes('expression'));

    // The obs fields shown, and the latent space they open with.
    const obs = adapter.getObsFields();
    assert.deepEqual(obs.fields.map(field => [field.key, field.kind]), [['cell_type', 'category']]);
    assert.equal(obs.latent_key, 'X_scVI');
    assert.equal(obs.outlier_min_points, 3);
    const latentIndex = adapter.getMappingCandidates().obsm.findIndex(item => item.key === 'X_scVI');
    assert.equal(obs.fields[0].outlierQuantilesPath, `outliers/${latentIndex}/0`);
    const identity = source._metadata;
    assert.deepEqual(identity.obs_fields.map(field => field.key), ['cell_type']);
    assert.equal(identity.stats.n_obs_fields, 1);
    assert.equal(identity.stats.has_connectivity, true);

    // The gene list the dataset opens with is layers['log1p'] named by
    // var['gene_symbols'].
    const geneList = await adapter.getGeneList();
    assert.equal(geneList.geneNames.source, 'gene_symbols');
    const log1p = await adapter.getGeneValues('var/0');
    const fromLayer = await adapter._loader.getMatrixColumn('layers/log1p', 0);
    assert.deepEqual(Array.from(log1p), Array.from(fromLayer));

    // The 2D embedding is X_pca columns 3 and 1, at its own coordinates:
    // shown fitted to the view, with the transform that maps them.
    const shown = identity.embeddings.items[identity.embeddings.defaults['2d']];
    assert.deepEqual(shown.source, { key: 'X_pca', columns: [3, 1] });
    const payload = await adapter.getEmbeddingPayload(shown.path, 2);
    const name = format === 'H5AD' ? 'data-mapping-full.h5ad' : 'data-mapping-full.zarr.zip';
    const file = new File([await readFile(new URL(`./browser/fixtures/${name}`, import.meta.url))], name);
    const own = Float32Array.from(await storedObsm(file, 'X_pca', [3, 1]));
    const fit = normalizePositions(own, 2);
    assert.deepEqual(Array.from(payload.positions), Array.from(own));
    assert.deepEqual(payload.transform, fit);

    // The graph it opens with is the one named.
    const edges = await adapter.getConnectivityEdges({});
    assert.strictEqual(edges, await adapter.getConnectivityEdges({ key: 'scvi_connectivities' }));

    // Latent outlier quantiles count categories from the named minimum.
    const seen = [];
    const original = adapter._loader.latentOutlierQuantiles.bind(adapter._loader);
    adapter._loader.latentOutlierQuantiles = (key, width, fields, minPoints, options) => {
      seen.push([key, minPoints]);
      return original(key, width, fields, minPoints, options);
    };
    await adapter.getLatentOutlierQuantiles(`outliers/${latentIndex}/0`);
    assert.deepEqual(seen, [['X_scVI', 3]]);
  });

  test(`${format}: no graph, a selected vector field, and absent keys keep the automatic choices`, async t => {
    const automatic = (await open(t, format, {})).getAdapter();
    const chosen = await open(t, format, { knn: null, vectorFieldDefault: 'velocity' });
    const adapter = chosen.getAdapter();
    assert.equal(adapter.getMappingCandidates().defaults.knn, null);
    assert.equal(chosen._metadata.stats.has_connectivity, false);
    assert.equal(await adapter.getConnectivityEdges({}), null);
    assert.equal(chosen._metadata.vector_field_default, 'velocity');
    const { knn: _knn, ...rest } = adapter.getMappingCandidates().defaults;
    const { knn: automaticKnn, ...automaticRest } = automatic.getMappingCandidates().defaults;
    assert.equal(automaticKnn, 'connectivities');
    assert.deepEqual(rest, automaticRest);
  });

  test(`${format}: opening reads only the embedding its first view draws; the others when first shown`, async t => {
    const read = [];
    const original = AnnDataReaderClient.prototype.readEmbedding;
    AnnDataReaderClient.prototype.readEmbedding = function (key, columns, ...rest) {
      read.push(`${key}[${columns.join(',')}]`);
      return original.call(this, key, columns, ...rest);
    };
    t.after(() => {
      AnnDataReaderClient.prototype.readEmbedding = original;
    });
    const source = await open(t, format, {
      embedding1d: { key: 'X_pca', columns: [2] },
      embedding2d: { key: 'X_pca', columns: [3, 1] },
      embedding3d: { key: 'X_pca', columns: [0, 1, 2] },
    });
    assert.deepEqual(read, ['X_pca[0,1,2]'], 'only the 3D slot the first view shows is read at open');
    const identity = source._metadata;
    const shown = identity.embeddings.items[identity.embeddings.defaults['2d']];
    await source.getAdapter().getEmbeddingPayload(shown.path, 2);
    assert.deepEqual(read, ['X_pca[0,1,2]', 'X_pca[3,1]'], 'the 2D slot is read when it is first shown');
  });

  test(`${format}: a launch default the file cannot honour is refused at open, naming what it has`, async t => {
    for (const [defaults, pattern] of [
      [{ unknown: true }, /Unknown AnnData launch default \['unknown'\]/],
      [{ knn: 'missing' }, /defaults\.knn names obsp\['missing'\], which this file does not have\. obsp holds: \['connectivities', 'distances', 'scvi_connectivities'\]/],
      [{ expression: 'layers/none' }, /defaults\.expression names layers\['none'\], which this file does not have/],
      [{ latentKey: 'X_none' }, /defaults\.latentKey 'X_none' was not found in obsm/],
      [{ geneIdColumn: 'symbol' }, /defaults\.geneIdColumn 'symbol' not found in var\. Available columns:/],
      [{ geneIdColumn: 'dispersions' }, /defaults\.geneIdColumn 'dispersions': floating-point values cannot name genes/],
      [{ obsKeys: ['cell_type', 'nope'] }, /defaults\.obsKeys contain columns not in obs: \['nope'\]\. Available columns: \['cell_type', 'batch'\]/],
      [{ embedding2d: 'X_none' }, /defaults\.embedding2d names obsm\['X_none'\], which this file does not have/],
      [{ embedding2d: 'X_broken' }, /X_broken/],
      [{ vectorFieldDefault: 'nope' }, /defaults\.vectorFieldDefault 'nope' does not match an available field: \['velocity'\]/],
    ]) {
      await assert.rejects(open(t, format, defaults), pattern, JSON.stringify(defaults));
    }
  });
}
