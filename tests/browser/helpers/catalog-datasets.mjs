/**
 * The browser tests' default catalog (`fixtures/catalog/`) listing other
 * datasets than its own, built in memory (`anndata-zarr-zip.mjs`): beside
 * `current-ui`, or instead of it.
 */
import { anndataZarrZip, fulfillFile } from './anndata-zarr-zip.mjs';

const CATALOG = '**/tests/browser/fixtures/catalog/';
const CELLS = 120;
const GENES = Object.freeze(['GAPDH', 'ACTB', 'CD3E', 'MS4A1', 'NKG7', 'LYZ']);

/**
 * A dataset shaped like `current-ui` -- 120 cells, its six genes, a
 * continuous `score` and a three-category field, a 2-D UMAP and a latent
 * space -- with its own id and name, and values of its own.
 *
 * @param {{id: string, name: string, description?: string, fieldKey?: string, categories?: string[]}} options
 * @returns {Buffer} The `.zarr.zip` bytes
 */
export function currentUiLike({
  id,
  name,
  description = 'Synthetic browser fixture shaped like current-ui',
  fieldKey = 'cell_type',
  categories = ['alpha', 'beta', 'gamma'],
}) {
  const angle = cell => (cell / CELLS) * Math.PI * 2;
  const radius = cell => 2 + (cell % 3);
  return anndataZarrZip({
    cells: CELLS,
    genes: [...GENES],
    X: Float32Array.from({ length: CELLS * GENES.length }, (_, index) => (index * 7) % 11),
    obs: {
      score: Float32Array.from({ length: CELLS }, (_, cell) => 1 - (cell % 40) / 40),
      [fieldKey]: {
        categories: [...categories],
        codes: Int8Array.from({ length: CELLS }, (_, cell) => (cell + 1) % categories.length),
      },
    },
    obsm: {
      X_umap_2d: {
        data: Float32Array.from({ length: CELLS * 2 }, (_, index) => {
          const cell = index >> 1;
          return (index % 2 === 0 ? Math.cos : Math.sin)(angle(cell)) * radius(cell);
        }),
        columns: 2,
      },
      latent_space: {
        data: Float32Array.from({ length: CELLS * 3 }, (_, index) => Math.sin(index * 0.61) * 3),
        columns: 3,
      },
    },
    uns: {
      cellucid: { schema: 1, id, name, description, defaults: { latentKey: 'latent_space' } },
    },
  });
}

/**
 * List `datasets` in the default catalog, `current-ui` first unless
 * `withCurrentUi` is false. Each is `{id, bytes}`, served as `<id>.zarr.zip`
 * beside the catalog, or `{id, path, bytes}` under another file name. Every
 * read of an added file is recorded by its `Range`.
 *
 * @returns {Promise<Map<string, string[]>>} The reads of each added file, by id
 */
export async function listCatalogDatasets(page, datasets, { withCurrentUi = true } = {}) {
  const reads = new Map();
  const entries = datasets.map(({ id, path = `${id}.zarr.zip` }) => ({ id, path }));
  await page.route(`${CATALOG}datasets.json`, route => route.fulfill({
    status: 200,
    json: {
      schema: 2,
      default: withCurrentUi ? 'current-ui' : entries[0].id,
      datasets: [
        ...(withCurrentUi ? [{ id: 'current-ui', path: 'current-ui.h5ad' }] : []),
        ...entries,
      ],
    },
  }));
  for (const [index, { id, bytes }] of datasets.entries()) {
    const ranges = [];
    reads.set(id, ranges);
    await page.route(`${CATALOG}${entries[index].path}`, route => {
      ranges.push(route.request().headers().range ?? 'whole file');
      return fulfillFile(route, bytes);
    });
  }
  return reads;
}
