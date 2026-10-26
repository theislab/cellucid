/**
 * A Cellucid Python server (`cellucid serve`, `serve_anndata()`) or a host
 * viewer's server (`show_anndata()`, R's viewer), answered by request
 * interception: its health, server information and one dataset entry
 * (`_cellucid/datasets`), the dataset's file under `_cellucid/anndata/`,
 * served with `HEAD` and `Range` as the server serves it, and for a host its
 * protocol and viewer channel (a WebSocket at `_cellucid/ws`).
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
 * @param {{version?: string, info?: Object|null, viewerHost?: boolean, holdDatasets?: Promise|null}} [options]
 *   `info`: extra server information fields (`host`, `port`), or null for a
 *   host viewer's server, which has none. `viewerHost` also answers the host's
 *   `protocol` route and its viewer channel: the channel answers `hello`
 *   with `welcome` and records every event the viewer sends after it.
 *   `holdDatasets` holds the dataset list until it settles.
 * @returns {Promise<{events: Object[]}>}
 */
export async function serveAnnDataServer(
  page,
  origin,
  dataset,
  { version = '0.9.5', info = null, viewerHost = false, holdDatasets = null } = {},
) {
  const served = servedDataset(dataset);
  const summary = { format: served.format, ...served.summary };
  const events = [];
  await page.route(`${origin}/_cellucid/health`, route =>
    jsonResponse(route, { status: 'ok', type: 'anndata', version, ...summary }));
  if (info !== null || viewerHost) {
    // A viewer's host names the program serving it (`runtime`).
    await page.route(`${origin}/_cellucid/info`, route =>
      jsonResponse(route, {
        version, type: 'anndata', ...summary, host: '127.0.0.1', port: 8765, runtime: 'python', ...(info ?? {}),
      }));
  }
  await page.route(`${origin}/_cellucid/datasets`, async route => {
    if (holdDatasets !== null) await holdDatasets;
    await jsonResponse(route, { datasets: [served.entry(served.route)] }).catch(() => {});
  });
  await page.route(`${origin}/${served.route}`, route => fulfillFile(route, served.bytes));
  if (viewerHost) {
    // A current host publishes its channel and what it accepts on it.
    await page.route(`${origin}/_cellucid/protocol`, route =>
      jsonResponse(route, { channel: '_cellucid/ws', commands: [], binaryCommands: [], events: ['ready'] }));
    await page.routeWebSocket(`${origin.replace(/^http/, 'ws')}/_cellucid/ws`, socket => {
      let welcomed = false;
      socket.onMessage(message => {
        const value = typeof message === 'string' ? JSON.parse(message) : null;
        if (!welcomed) {
          welcomed = value?.type === 'hello';
          if (welcomed) socket.send(JSON.stringify({ type: 'welcome' }));
          else socket.close({ code: 4401, reason: 'expected hello' });
          return;
        }
        events.push(value);
      });
    });
  }
  return { events };
}
