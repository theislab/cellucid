/**
 * A synthetic dataset with 1-D, 2-D and 3-D embeddings of the same cells
 * (`X_umap_1d`, `X_umap_2d`, `X_umap_3d`), served by request interception as
 * a one-dataset catalog under `root`: its `datasets.json` and the dataset's
 * `.zarr.zip`, built in memory (`anndata-zarr-zip.mjs`) for the cell count
 * the spec asks for.
 *
 * A spec that switches a view's dimension, or shows panes of different
 * dimensions side by side, installs this one. The cells form seven
 * deterministic clusters; the 1-D and 2-D embeddings are the leading axes of
 * the 3-D one. It has no genes.
 */
import { serveSyntheticCatalog } from './anndata-zarr-zip.mjs';

function createEmbeddings(cellCount) {
  const embeddings = {};
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
    const data = new Float32Array(cellCount * dimension);
    for (let index = 0; index < cellCount; index++) {
      for (let axis = 0; axis < dimension; axis++) {
        data[index * dimension + axis] = xyz[index * 3 + axis];
      }
    }
    embeddings[`X_umap_${dimension}d`] = { data, columns: dimension };
  }
  return embeddings;
}

export async function installMultiDimensionFixture(page, {
  root,
  datasetId,
  name,
  cellCount,
}) {
  await serveSyntheticCatalog(page, root, {
    id: datasetId,
    name,
    description: 'Exact synthetic fixture with 1-D, 2-D and 3-D embeddings',
    cells: cellCount,
    obsm: createEmbeddings(cellCount),
  });
}
