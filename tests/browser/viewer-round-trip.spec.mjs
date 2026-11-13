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
 * results publisher (`app/viewer-host/results.js`).
 *
 * Needs CELLUCID_PYTHON set to an interpreter that has cellucid's
 * dependencies; without it the file is skipped, as the other live-server specs
 * are, and CELLUCID_REQUIRE_VIEWERS=1 (set by the CI job that runs this spec)
 * makes that a failure. The server runs the cellucid-python checkout beside
 * this repository (or CELLUCID_PYTHON_ROOT), never whichever `cellucid` the
 * interpreter has.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { expect, test } from './helpers/test.mjs';
import { viewerInterpreter } from './helpers/viewer-interpreters.mjs';

const PYTHON = viewerInterpreter('CELLUCID_PYTHON');
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
    # Actions, sent at once; the viewer answers each request, and what they
    # made arrives as results (this thread may wait for them: a browser-tab
    # viewer answers on the server's threads).
    pushed = viewer.push(adata.obs["leiden"], key="leiden_nb")
    viewer.push(pd.Series([1.5, 2.5], index=["c4", "c1"], name="score"))
    viewer.gene_set_save(name="T", genes=["CD3E", "CD3D"])
    highlighted = viewer.highlight_cells(cells=pd.Index(["c5", "c0", "c2"]), color="#00ff00", label="From Python")
    pushed_outcome = pushed.result(timeout=60)
    highlighted.result(timeout=60)

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
        "pushed": {"name": pushed_outcome["name"], "kind": pushed_outcome["kind"]},
        "step": highlighted.step,
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
        "annotation_colors": list(adata.uns["annotation_colors"]),
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
      const { createViewerHostResults } = await import('/assets/js/app/viewer-host/results.js');
      const { createViewerHostCommandHandlers } = await import('/assets/js/app/viewer-host/command-handler.js');
      const { createActionDispatcher } = await import('/assets/js/app/actions/dispatcher.js');
      const { getActionCatalog } = await import('/assets/js/app/actions/index.js');
      const { provideHighlightActions } = await import('/assets/js/app/ui/modules/highlight/highlight-actions.js');
      const { installFieldActions } = await import('/assets/js/app/state/actions/field-actions.js');
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
      // No embedding is drawn here: a label field has no centroid to place,
      // and the page's memory budget finds no positions held for this state.
      state.dimensionManager = {
        getRegisteredLayouts: () => [], getResidentPositions: () => null, unshownBytes: () => 0, trimUnshown: () => null,
      };
      state.cellIdentity = identity;
      state.ensureHighlightPage();
      // This state's own actions (the page's are the app's own state's): the
      // host's highlight, pushed columns and gene set are actions applied
      // here, each kept as a step by a recorder that labels it as the
      // history does.
      const actions = createActionDispatcher({ catalog: getActionCatalog() });
      provideHighlightActions({ state, actions });
      installFieldActions({ state, actions });
      let steps = 0;
      actions.setRecorder({
        before: token => token,
        after: ({ definition, params }, outcome) => ({ id: `s${++steps}`, label: definition.describe(params, outcome) }),
        failed: () => {},
        observed: async () => null,
      });
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
        getShownHostDataset: () => source.getShownHostDataset(),
        getHostRuntime: () => source.getHostRuntime(),
        actions,
        // No session is pushed in this round trip.
        loadSession: async () => { throw new Error('No session is loaded here.'); },
      });
      source.onAction(handlers.handleAction);
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
      // Each action's request is answered: the field's outcome, the highlight's step.
      pushed: { name: 'leiden_nb', kind: 'categorical' },
      // One of the four steps (the actions on disjoint state may finish in any order).
      step: { id: expect.stringMatching(/^s[1-4]$/), label: 'Highlighted 3 cells as "From Python" on page "Page 2"' },
    });

    // A person lassos two cells, labels the open cells and recolors T in the legend.
    const openedB = await page.evaluate(async () => {
      const { state } = window.__roundTrip;
      const { withCategoryColor } = await import('/assets/js/app/utils/category-state.js');
      const { hexOfRgb01 } = await import('/assets/js/utils/hex-color.js');
      state.addHighlightDirect({ type: 'lasso', label: 'Lasso', cellIndices: Uint32Array.of(1, 3) });
      state.upsertUserDefinedCategoricalField({
        key: 'annotation', categories: ['B', 'T'], codes: Uint8Array.of(0, 1, 255, 0, 1),
      });
      const annotation = state.getFields().find(field => field.key === 'annotation');
      // As the legend's `setColorForCategory` changes it and says so; this
      // page draws nothing, so the drawing step (the viewer's) is left out.
      state.ensureCategoryMetadata(annotation);
      withCategoryColor(annotation, 1, [0, 0.5, 0.5]);
      state.emit('colors:changed', { field: annotation });
      // B's color as the state gives it (`getColorForCategory`), never the field's own arrays.
      return hexOfRgb01(state.getColorForCategory(annotation, 0));
    });
    child.stdin.write('\n');
    expect(await next()).toEqual({
      columns: ['annotation', 'cellucid_highlight__highlight_1', 'cellucid_highlight__highlight_2', 'leiden_nb', 'score'],
      python: [true, false, true, null, false, true],
      lasso: [false, true, false, null, true, false],
      annotation: ['B', 'T', null, null, 'B', 'T'],
      // The colors it is shown in (the result's colors): B as it opened, T as recolored.
      annotation_colors: [openedB, '#008080'],
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
