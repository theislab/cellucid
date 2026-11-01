/**
 * The R package's viewer end to end, in a real browser against a real
 * cellucid-r server (`cellucid_serve()`):
 *
 * - The app opens the object R serves from memory -- an uncompressed
 *   Cellucid-ready AnnData Zarr (no compressor, no shuffle), its cells in
 *   priority order, whose X R makes gene by gene from the object's genes x
 *   cells matrix -- and a gene read through the app's data layer holds
 *   exactly the values R holds, cell by original position.
 * - On the viewer channel, R's highlight and visibility commands arrive as
 *   binary frames, the cells R named, ascending; a selection the page makes
 *   reaches R whole; stopping the viewer ends the page's channel.
 *
 * Needs CELLUCID_RSCRIPT set to an Rscript whose library (R_LIBS) has
 * cellucid and SingleCellExperiment installed; without it the file is skipped,
 * as the other live-server specs are.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { expect, test } from './helpers/test.mjs';

const RSCRIPT = process.env.CELLUCID_RSCRIPT ?? null;

// The R side. It prints one JSON line per step and, before each next one,
// waits for the file `go<n>` in its control folder, so the browser and R take
// turns while R's event loop keeps answering the page.
const SERVER = `
suppressMessages({library(cellucid); library(SingleCellExperiment)})
control <- commandArgs(TRUE)[[1L]]
say <- function(value) { cat(jsonlite::toJSON(value, auto_unbox = TRUE, digits = NA), "\\n", sep = ""); flush(stdout()) }
turn <- 0L
wait_turn <- function() {
  turn <<- turn + 1L
  go <- file.path(control, paste0("go", turn))
  while (!file.exists(go)) later::run_now(0.02)
}
set.seed(7)
n_cells <- 20000L; n_genes <- 60L
# Over 2^16 stored values, so X's data and indices span several chunks.
counts <- Matrix::rsparsematrix(n_genes, n_cells, density = 0.08, rand.x = function(k) round(runif(k, 0.25, 9), 3))
dimnames(counts) <- list(paste0("g", seq_len(n_genes)), paste0("cell", seq_len(n_cells)))
sce <- SingleCellExperiment(assays = list(logcounts = counts))
reducedDim(sce, "UMAP") <- matrix(rnorm(2L * n_cells), ncol = 2L)
gene <- 37L
v <- cellucid_serve(sce, dataset_id = "r-channel", dataset_name = "R channel", serve_web_ui = FALSE, port = 0L, quiet = TRUE)
say(list(url = v$url, viewerId = v$viewer_id, viewerToken = v$viewer_token, cells = n_cells,
         gene = rownames(counts)[[gene]], values = I(as.numeric(counts[gene, ]))))
wait_turn()
cellucid_highlight(v, c(9L, 2L, 5L, 5L), color = "#00ff7f")
cellucid_set_visibility(v, c(3, 1), visible = FALSE)
cellucid_set_visibility(v, NULL, visible = TRUE)
ready <- cellucid_wait_ready(v, timeout = 60)
say(list(ready = ready))
deadline <- proc.time()[["elapsed"]] + 60
while (is.null(cellucid_selection(v)) && proc.time()[["elapsed"]] < deadline) later::run_now(0.02)
selection <- cellucid_selection(v)
say(list(selection = list(n = length(selection$cells), first = selection$cells[[1L]],
                          last = selection$cells[[length(selection$cells)]], name = selection$cell_names[[1L]],
                          source = selection$source)))
wait_turn()
cellucid_stop(v)
say(list(stopped = TRUE))
`;

test.skip(RSCRIPT === null, 'CELLUCID_RSCRIPT names no Rscript for the R viewer');

test('the R viewer serves its object uncompressed and talks binary frames on the channel', async ({ page }) => {
  test.setTimeout(240_000);
  const control = mkdtempSync(path.join(os.tmpdir(), 'cellucid-r-viewer-'));
  const script = path.join(control, 'server.R');
  writeFileSync(script, SERVER);
  const child = spawn(RSCRIPT, [script, control], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const next = async () => {
    const line = await lines.next();
    if (line.done) throw new Error(`the R server exited: ${stderr}`);
    return JSON.parse(line.value);
  };
  let turn = 0;
  const giveTurn = () => writeFileSync(path.join(control, `go${++turn}`), '');
  try {
    const config = await next();

    // The served store declares no codec: its chunks are the values' bytes.
    const metadata = await (await fetch(`${config.url}/_cellucid/anndata/r-channel.zarr/.zmetadata`)).json();
    for (const key of ['X/data/.zarray', 'X/indices/.zarray', 'obsm/X_UMAP/.zarray']) {
      expect(metadata.metadata[key].compressor, key).toBeNull();
      expect(metadata.metadata[key].filters, key).toBeNull();
    }
    expect(metadata.metadata['X/data/.zarray'].shape[0]).toBeGreaterThan(65536);

    await page.goto(`/?source=remote&remote=${encodeURIComponent(config.url)}&anndata=true`);
    await page.waitForFunction(() => {
      const failure = document.getElementById('cellucid-startup-failure');
      if (failure) throw new Error(failure.textContent);
      return document.documentElement.dataset.startupPhase === 'ready' &&
        (window._cellucidViewer?.getPointCount?.() ?? 0) > 0;
    }, null, { timeout: 120_000 });
    expect(await page.evaluate(() => window._cellucidViewer.getPointCount())).toBe(config.cells);
    const read = await page.evaluate(async ({ gene, values }) => {
      const { createDataLayer } = await import('/assets/js/app/analysis/data/data-layer.js');
      const layer = createDataLayer(window._cellucidState);
      // One column a gene: dense values, or the gene's sparse entries.
      const [column] = await layer.readGeneColumns([gene]);
      let got = column;
      if (column.indices instanceof Uint32Array) {
        got = new Float32Array(column.length);
        for (let index = 0; index < column.indices.length; index++) got[column.indices[index]] = column.values[index];
      }
      // R serves its object in priority order (R/priority.R): open cell i
      // is the cell at original position originalAt(i), R's values[that].
      const identity = window._cellucidState.cellIdentity;
      let differ = 0;
      for (let index = 0; index < values.length; index++) {
        if (got[index] !== Math.fround(values[identity.originalAt(index)])) differ += 1;
      }
      return { length: got.length, differ, nonzero: values.filter(value => value !== 0).length };
    }, { gene: config.gene, values: config.values });
    expect(read.length).toBe(config.cells);
    expect(read.nonzero).toBeGreaterThan(0);
    expect(read.differ).toBe(0);

    // The channel: R's commands, then a selection back.
    await page.evaluate(async config => {
      const { ViewerHostDataSource } = await import('/assets/js/data/viewer-host-source.js');
      const source = new ViewerHostDataSource({
        serverUrl: config.url,
        viewerId: config.viewerId,
        viewerToken: config.viewerToken,
      });
      window.__channel = { source, commands: [], highlights: [], ends: [] };
      source.onHighlight((cells, color) => {
        window.__channel.highlights.push(cells === null ? 'clear' : {
          typed: cells instanceof Uint32Array, cells: Array.from(cells), color,
        });
      });
      source.onMessage(message => {
        window.__channel.commands.push(message.type === 'setVisibility'
          ? `setVisibility:${message.visible}:${message.cells === null ? 'all' : Array.from(message.cells).join(',')}`
          : message.type);
      });
      source.onChannelEnd(end => window.__channel.ends.push(end.kind));
      if (!(await source.initialize())) throw new Error('the channel did not open');
      // Every cell open: the channel names cells by their original positions.
      const { createCellIdentity } = await import('/assets/js/data/cell-identity.js');
      const identity = createCellIdentity({ nObs: config.cells });
      source.setCellIdentityProvider(() => identity);
      // The served dataset is the one shown.
      source.setShownDatasetProvider(() => 'r-channel');
      source.acceptCommands();
    }, config);
    giveTurn();
    await expect.poll(() => page.evaluate(() => window.__channel.highlights), { timeout: 30_000 })
      .toEqual([{ typed: true, cells: [1, 4, 8], color: '#00ff7f' }]);
    await expect.poll(() => page.evaluate(() => window.__channel.commands), { timeout: 30_000 })
      .toEqual(['setVisibility:false:0,2', 'setVisibility:true:all']);
    await page.evaluate(async cells => {
      await window.__channel.source.notifyReady({ dimensions: 2 });
      const selected = new Uint32Array(5000);
      for (let index = 0; index < selected.length; index++) selected[index] = index * 4;
      await window.__channel.source.notifySelection(selected, 'lasso');
    }, config.cells);
    expect(await next()).toEqual({ ready: { n_cells: config.cells, n_obs: config.cells, dimensions: 2 } });
    expect(await next()).toEqual({ selection: { n: 5000, first: 1, last: 19997, name: 'cell1', source: 'lasso' } });

    giveTurn();
    expect(await next()).toEqual({ stopped: true });
    await expect.poll(() => page.evaluate(() => window.__channel.ends), { timeout: 30_000 }).toEqual(['stopped']);
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
  }
});
