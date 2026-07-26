import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');

function section(heading, nextHeading) {
  const start = readme.indexOf(heading);
  assert.notEqual(start, -1, `README must contain ${heading}`);
  const end = readme.indexOf(nextHeading, start + heading.length);
  assert.notEqual(end, -1, `README must contain ${nextHeading} after ${heading}`);
  return readme.slice(start, end);
}

test('README documents the 14 current loading workflows exactly', () => {
  const loading = section('## 14 Loading Workflows', '## h5ad / Zarr Requirements');
  const numberedRows = [...loading.matchAll(/^\|\s*(\d+)\s*\|/gm)].map(match =>
    Number(match[1])
  );

  assert.deepEqual(
    numberedRows,
    Array.from({ length: 14 }, (_, index) => index + 1)
  );
  for (const required of [
    'Browser **Zarr ZIP picker**',
    '`.zarr.zip` / `.zip` containing one Zarr v2 store',
    'reads gene-expression chunks on demand',
    'opened read-only-backed',
    'materialized eagerly',
  ]) {
    assert.ok(loading.includes(required), `README loading matrix must state ${required}`);
  }
});

test('README Python examples use the exact current public contract', () => {
  for (const required of [
    'cellucid serve /path/to/data.h5ad --dataset-name "My dataset" --dataset-id my-dataset',
    'cellucid serve /path/to/data.zarr --dataset-name "My dataset" --dataset-id my-dataset',
    'dataset_name="My dataset"',
    'dataset_id="my-dataset"',
    'obs_categorical_dtype="uint16"',
    'embedding = adata.obsm["X_umap_2d"]',
    'X_umap_2d=embedding',
    'out_dir="./my_export"',
    'velocity_umap_1d',
  ]) {
    assert.ok(readme.includes(required), `README must contain ${required}`);
  }

  for (const removed of [
    'show_anndata(adata)',
    'prepare(adata, output_dir="./my_export", compress=True)',
    "obsm['X_umap']",
    'markdown/VECTOR_FIELD_OVERLAY_CONVENTIONS.md',
  ]) {
    assert.ok(!readme.includes(removed), `README must not contain ${removed}`);
  }
});

test('README links current vector documentation and gives portable development steps', () => {
  assert.ok(
    readme.includes(
      'https://cellucid.readthedocs.io/en/latest/user_guide/web_app/i_vector_field_velocity/index.html'
    )
  );
  assert.doesNotMatch(readme, /^open http:\/\/localhost:8000$/m);
  assert.ok(readme.includes('Visit http://localhost:8000 in a supported browser.'));
});
