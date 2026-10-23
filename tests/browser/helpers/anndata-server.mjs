/**
 * A Cellucid Python server (`cellucid serve`, `serve_anndata()`) or Jupyter
 * bridge (`show_anndata()`), answered by request interception: its health,
 * server information and one dataset entry (`_cellucid/datasets`), and the
 * dataset's file under `_cellucid/anndata/`, served with `HEAD` and `Range`
 * as the server serves it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fulfillFile } from './anndata-zarr-zip.mjs';

export function jsonResponse(route, payload) {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(payload),
  });
}

/**
 * @param {Object} dataset
 * @param {string} dataset.id
 * @param {string} dataset.name
 * @param {string} dataset.file - The `.h5ad` or `.zarr.zip` on disk
 * @param {number} dataset.cells
 * @param {number} dataset.genes
 */
function servedDataset({ id, name, file, cells, genes }) {
  const bytes = readFileSync(file);
  const fileName = path.basename(file);
  const h5ad = fileName.endsWith('.h5ad');
  return {
    bytes,
    route: `_cellucid/anndata/${encodeURIComponent(fileName)}`,
    format: h5ad ? 'h5ad' : 'zarr',
    summary: { n_cells: cells, n_genes: genes },
    entry: (route) => ({
      id,
      name,
      anndata: {
        file: { url: route, kind: h5ad ? 'h5ad' : 'zarr', layout: h5ad ? 'file' : 'zip', size: bytes.length },
        defaults: {},
      },
    }),
  };
}

/**
 * A server at `origin` (no trailing slash) offering `dataset`.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} origin
 * @param {Object} dataset - See `servedDataset`
 * @param {{version?: string, info?: Object|null, jupyter?: boolean, holdDatasets?: Promise|null}} [options]
 *   `info`: extra server information fields (`host`, `port`, `ws_port`), or
 *   null for a Jupyter bridge, which has none. `jupyter` also answers the
 *   bridge's `events` and `protocol` routes, and records every event posted.
 *   `holdDatasets` holds the dataset list until it settles.
 * @returns {Promise<{events: Object[]}>}
 */
export async function serveAnnDataServer(
  page,
  origin,
  dataset,
  { version = '0.9.5', info = null, jupyter = false, holdDatasets = null } = {},
) {
  const served = servedDataset(dataset);
  const summary = { format: served.format, ...served.summary };
  const events = [];
  await page.route(`${origin}/_cellucid/health`, route =>
    jsonResponse(route, { status: 'ok', type: 'anndata', version, ...summary }));
  if (info !== null) {
    await page.route(`${origin}/_cellucid/info`, route =>
      jsonResponse(route, { version, type: 'anndata', ...summary, ...info }));
  }
  await page.route(`${origin}/_cellucid/datasets`, async route => {
    if (holdDatasets !== null) await holdDatasets;
    await jsonResponse(route, { datasets: [served.entry(served.route)] }).catch(() => {});
  });
  await page.route(`${origin}/${served.route}`, route => fulfillFile(route, served.bytes));
  if (jupyter) {
    await page.route(`${origin}/_cellucid/events`, async route => {
      events.push(JSON.parse(route.request().postData() ?? 'null'));
      await jsonResponse(route, { status: 'ok', delivered: true });
    });
    // A current notebook server publishes what it accepts on the wire.
    await page.route(`${origin}/_cellucid/protocol`, route =>
      jsonResponse(route, { events: ['ready'], commands: [] }));
  }
  return { events };
}
