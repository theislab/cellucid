/**
 * The round trip end to end, in a real browser against a real cellucid-python
 * viewer: Python pushes a column, a score and a gene set and highlights cells
 * by obs name; the viewer -- a subsample of 5 of the dataset's 6 cells -- adds
 * them as fields, a gene set and a highlight group, a person draws a lasso
 * and makes a label field, and `viewer.pull(adata)` writes every one of them
 * onto the AnnData, each cell at its row of `obs`, the cell the viewer did
 * not open left unknown.
 *
 * The page runs the viewer's own modules: the viewer channel
 * (`data/viewer-host-source.js`), the state, the command handler and the
 * results publisher (`app/viewer-host-results.js`).
 *
 * Needs CELLUCID_PYTHON set to an interpreter that has cellucid's
 * dependencies; without it the file is skipped, as the other live-server specs
 * are. The server runs the cellucid-python checkout beside this repository (or
 * CELLUCID_PYTHON_ROOT), never whichever `cellucid` the interpreter has.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { expect, test } from './helpers/test.mjs';

const PYTHON = process.env.CELLUCID_PYTHON ?? null;
const PYTHON_SOURCE = path.join(
  process.env.CELLUCID_PYTHON_ROOT
    ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'cellucid-python'),
  'src',
);

const SERVER = `
import json, math, sys, time
import anndata as ad, numpy as np, pandas as pd
import cellucid.jupyter as jupyter
from cellucid._server_base import CELLUCID_WEB_URL
from cellucid.anndata_server import AnnDataServer

def say(value):
    print(json.dumps(value), flush=True)

def plain(values):
    return [None if (v is pd.NA or (isinstance(v, float) and math.isnan(v))) else (bool(v) if isinstance(v, (bool, np.bool_)) else v) for v in values]

names = [f"c{i}" for i in range(6)]
adata = ad.AnnData(
    X=np.zeros((6, 1), np.float32),
    obs=pd.DataFrame({"leiden": pd.Categorical(["0", "1", "0", "2", "1", "0"])}, index=names),
    var=pd.DataFrame(index=["g"]),
    obsm={"X_umap_2d": np.zeros((6, 2), np.float32)},
)
viewer = object.__new__(jupyter.AnnDataViewer)
viewer._init_state(port=None, client_server_url=None,
                   web_source_url=CELLUCID_WEB_URL, web_cache_dir=None, allowed_hosts=None)
viewer.data = adata
viewer._activate()
server = AnnDataServer(adata, host="127.0.0.1", port=0, quiet=True, serve_web_ui=False,
                       dataset_name="round trip", dataset_id="round-trip")
server.start_background()
host, port = server._server.server_address
try:
    say({"url": f"http://{host}:{port}", "viewerId": viewer._viewer_id, "viewerToken": viewer._viewer_token})
    ready = viewer.wait_for_event("ready", timeout=60)
    # Sent at once; the viewer's answers arrive as results (this thread may
    # wait for them: a browser-tab viewer answers on the server's threads).
    viewer.push(adata.obs["leiden"], key="leiden_nb")
    viewer.push(pd.Series([1.5, 2.5], index=["c4", "c1"], name="score"))
    viewer.push_gene_set("T", ["CD3E", "CD3D", "CD3E"])
    viewer.highlight_cells(pd.Index(["c5", "c0", "c2"]), color="#00ff00", label="From Python")

    def held(kind, name):
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            try:
                for result in viewer.results:
                    if result.kind == kind and name in (result.meta.get("key"), result.meta.get("name"), result.meta.get("label")):
                        return result
            except RuntimeError:
                pass
            time.sleep(0.05)
        raise TimeoutError(f"no {kind} {name}")

    leiden = held("categorical", "leiden_nb")
    score = held("continuous", "score")
    genes = held("geneSet", "T")
    say({
        "ready": ready,
        "leiden": {"cells": leiden.cells.tolist(), "values": leiden.values.tolist(), "categories": leiden.meta["categories"]},
        "score": {"cells": score.cells.tolist(), "values": plain(score.values.tolist())},
        "genes": genes.meta["genes"],
    })
    sys.stdin.readline()
    # What the person made reaches Python as it is made (a notebook's next
    # cell comes later than this script's next line).
    held("highlight", "Lasso")
    held("categorical", "annotation")
    summary = viewer.pull(adata, include_pushed=True)
    obs = adata.obs
    say({
        "columns": sorted(summary.columns),
        "python": plain(obs["cellucid_highlight__highlight_1"].tolist()),
        "lasso": plain(obs["cellucid_highlight__highlight_2"].tolist()),
        "annotation": plain(obs["annotation"].astype(object).tolist()),
        "leiden_nb": plain(obs["leiden_nb"].astype(object).tolist()),
        "score": plain(obs["score"].astype(float).tolist()),
        "gene_sets": adata.uns["cellucid"]["gene_sets"]["T"]["genes"],
        "subset": viewer.subset(adata, "Lasso").obs_names.tolist(),
    })
finally:
    server.stop()
`;

test.skip(PYTHON === null, 'CELLUCID_PYTHON names no interpreter for the data server');

test('columns and gene sets pushed from Python, highlights and labels made in the viewer, pulled in one call', async ({ page }) => {
  test.setTimeout(180_000);
  const child = spawn(PYTHON, ['-c', SERVER], {
    env: {
      ...process.env,
      PYTHONPATH: [PYTHON_SOURCE, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const next = async () => {
    const line = await lines.next();
    if (line.done) throw new Error(`the data server exited: ${stderr}`);
    return JSON.parse(line.value);
  };
  try {
    const config = await next();
    await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
    await page.evaluate(async config => {
      const { ViewerHostDataSource } = await import('/assets/js/data/viewer-host-source.js');
      const { DataState } = await import('/assets/js/app/state/core/data-state.js');
      const { createCellIdentity } = await import('/assets/js/data/cell-identity.js');
      const { createViewerHostResults } = await import('/assets/js/app/viewer-host-results.js');
      const { createViewerHostCommandHandlers } = await import('/assets/js/app/viewer-host-command-handler.js');
      // A subsample: rows 0, 1, 2, 4 and 5 of 6 are open; row 3 is not.
      const identity = createCellIdentity({ nObs: 6, kept: Uint32Array.of(0, 1, 2, 4, 5) });
      const state = new DataState({}, null);
      state.pointCount = 5;
      state.highlightArray = new Uint8Array(5);
      state.colorsArray = new Uint8Array(20);
      state.categoryTransparency = new Uint8Array(5).fill(1);
      state.cellVisibilityMask = new Uint8Array(5).fill(1);
      state.obsData = { fields: [] };
      state.varData = { fields: [] };
      // No embedding is drawn here: a label field has no centroid to place.
      state.dimensionManager = { getRegisteredLayouts: () => [], getResidentPositions: () => null };
      state.ensureHighlightPage();
      const source = new ViewerHostDataSource({
        serverUrl: config.url,
        viewerId: config.viewerId,
        viewerToken: config.viewerToken,
      });
      if (!(await source.initialize())) throw new Error('the channel did not open');
      source.setCellIdentityProvider(() => identity);
      // The host's dataset is the one shown.
      source.setShownDatasetProvider(() => 'round-trip');
      const results = createViewerHostResults({ state, viewerHostSource: source, getCellIdentity: () => identity });
      const handlers = createViewerHostCommandHandlers({
        state,
        viewer: {},
        refreshUi() {},
        reportDataMapping: async () => false,
        getCellIdentity: () => identity,
        getShownHostDataset: () => source.getShownHostDataset(),
        results,
        getHostLabel: () => source.getHostLabel(),
      });
      source.onHighlight(handlers.handleHighlight);
      source.onMessage(handlers.handleMessage);
      source.acceptCommands();
      await source.notifyReady({ dimensions: 2 });
      await results.resync();
      window.__roundTrip = { state };
    }, config);

    const pushed = await next();
    expect(pushed).toEqual({
      ready: { n_cells: 5, n_obs: 6, dimensions: 2 },
      // The column of every cell, kept on the open ones (row 3 is not open).
      leiden: { cells: [0, 1, 2, 4, 5], values: [0, 1, 0, 1, 0], categories: ['0', '1', '2'] },
      score: { cells: [0, 1, 2, 4, 5], values: [null, 2.5, null, 1.5, null] },
      genes: ['CD3E', 'CD3D'],
    });

    // A person lassos two cells and labels the open cells.
    await page.evaluate(() => {
      const { state } = window.__roundTrip;
      state.addHighlightDirect({ type: 'lasso', label: 'Lasso', cellIndices: Uint32Array.of(1, 3) });
      state.upsertUserDefinedCategoricalField({
        key: 'annotation', categories: ['B', 'T'], codes: Uint8Array.of(0, 1, 255, 0, 1),
      });
    });
    child.stdin.write('\n');
    expect(await next()).toEqual({
      columns: ['annotation', 'cellucid_highlight__highlight_1', 'cellucid_highlight__highlight_2', 'leiden_nb', 'score'],
      python: [true, false, true, null, false, true],
      lasso: [false, true, false, null, true, false],
      annotation: ['B', 'T', null, null, 'B', 'T'],
      leiden_nb: ['0', '1', '0', null, '1', '0'],
      score: [null, 2.5, null, null, 1.5, null],
      gene_sets: ['CD3E', 'CD3D'],
      subset: ['c1', 'c4'],
    });
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
  }
});
