/**
 * The browser tests' default catalog listing, instead of `current-ui`, the
 * file beside it with the same cells and a vector field on their UMAP
 * (`fixtures/catalog/current-ui-vector.h5ad`: `velocity_umap_2d`, bound by
 * default; `scripts/generate-browser-catalog-fixtures.py`).
 */
export const VECTOR_DATASET = Object.freeze({
  id: 'current-ui-vector',
  name: 'Current UI vector fixture',
});

export async function listVectorDataset(page) {
  await page.route('**/tests/browser/fixtures/catalog/datasets.json', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      schema: 2,
      default: VECTOR_DATASET.id,
      datasets: [{ id: VECTOR_DATASET.id, path: `${VECTOR_DATASET.id}.h5ad` }],
    }),
  }));
}
