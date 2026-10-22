/**
 * A synthetic dataset with 1-D, 2-D and 3-D embeddings of the same cells,
 * served by request interception under `root`.
 *
 * Every prepared fixture on disk carries a single embedding, so a spec that
 * switches a view's dimension, or shows panes of different dimensions side by
 * side, installs this one. The cells form seven deterministic clusters; the
 * 1-D and 2-D embeddings are the leading axes of the 3-D one.
 */

function createEmbeddings(cellCount) {
  const embeddings = new Map();
  let seed = 11;
  const random = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 2 ** 32;
  };
  const xyz = new Float32Array(cellCount * 3);
  for (let index = 0; index < cellCount; index++) {
    const cluster = index % 7;
    for (let axis = 0; axis < 3; axis++) {
      xyz[index * 3 + axis] =
        Math.cos(cluster * (axis + 1)) * 4 + (random() - 0.5) * 1.5;
    }
  }
  for (const dimension of [1, 2, 3]) {
    const buffer = Buffer.alloc(cellCount * dimension * 4);
    for (let index = 0; index < cellCount; index++) {
      for (let axis = 0; axis < dimension; axis++) {
        buffer.writeFloatLE(
          xyz[index * 3 + axis],
          (index * dimension + axis) * 4,
        );
      }
    }
    embeddings.set(dimension, buffer);
  }
  return embeddings;
}

export async function installMultiDimensionFixture(page, {
  root,
  datasetId,
  name,
  cellCount,
}) {
  const embeddings = createEmbeddings(cellCount);
  const json = value => ({
    body: Buffer.from(JSON.stringify(value)),
    contentType: 'application/json; charset=utf-8',
  });
  const responses = new Map([
    ['datasets.json', json({
      version: 1,
      default: datasetId,
      datasets: [{
        id: datasetId,
        name,
        path: `${datasetId}/`,
        n_cells: cellCount,
        n_genes: 0,
      }],
    })],
    [`${datasetId}/dataset_identity.json`, json({
      version: 3,
      id: datasetId,
      name: name,
      description: 'Exact synthetic fixture with 1-D, 2-D and 3-D embeddings',
      created_at: '2026-10-18T00:00:00Z',
      cellucid_data_version: '0.0.9',
      stats: {
        n_cells: cellCount,
        n_genes: 0,
        n_obs_fields: 0,
        n_categorical_fields: 0,
        n_continuous_fields: 0,
        has_connectivity: false,
        n_edges: null,
      },
      embeddings: {
        default_dimension: 3,
        defaults: {
          '1d': 'layout_1d',
          '2d': 'layout_2d',
          '3d': 'layout_3d',
        },
        items: Object.fromEntries([1, 2, 3].map(dimension => [
          `layout_${dimension}d`,
          {
            label: `Layout ${dimension}D`,
            dimension,
            file: `embeddings/${dimension - 1}_${dimension}d.bin`,
            source: {
              key: null,
              columns: Array.from({ length: dimension }, (_, axis) => axis),
            },
          },
        ])),
      },
      obs_fields: [],
      export_settings: {
        compression: null,
        var_quantization: null,
        obs_continuous_quantization: null,
        obs_categorical_dtype: 'uint8',
      },
      source: { name: 'Cellucid browser CI' },
    })],
    [`${datasetId}/obs_manifest.json`, json({
      _format: 'compact_v2',
      n_points: cellCount,
      centroid_outlier_quantile: null,
      latent_key: null,
      compression: null,
      _obsSchemas: {},
      _continuousFields: [],
      _categoricalFields: [],
    })],
    ...[1, 2, 3].map(dimension => [
      `${datasetId}/embeddings/${dimension - 1}_${dimension}d.bin`,
      {
        body: embeddings.get(dimension),
        contentType: 'application/octet-stream',
      },
    ]),
  ]);
  const prefix = new URL(root).pathname;
  await page.route(`${root}**`, async route => {
    const pathname = new URL(route.request().url()).pathname;
    const response = responses.get(pathname.slice(prefix.length));
    if (response === undefined) {
      await route.fulfill({
        status: 404,
        contentType: 'text/plain; charset=utf-8',
        body: `Unexpected fixture request: ${pathname}\n`,
      });
      return;
    }
    await route.fulfill({ status: 200, ...response });
  });
}
