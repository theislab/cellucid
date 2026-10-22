/**
 * A one-million-cell selection reaches Python whole, end to end: the viewer's
 * Jupyter bridge in a real browser encodes it, posts it cross-origin to a real
 * cellucid-python data server (`POST /_cellucid/selection`), and the
 * notebook-side viewer receives every cell, ascending.
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

// A notebook-side viewer and its data server; prints its routing once, then
// one line per selection it receives.
const SERVER = `
import json
import anndata as ad, numpy as np, pandas as pd
import cellucid.jupyter as jupyter
from cellucid.anndata_server import AnnDataServer

adata = ad.AnnData(
    X=np.zeros((2, 1), np.float32),
    obs=pd.DataFrame(index=["a", "b"]),
    var=pd.DataFrame(index=["g"]),
    obsm={"X_umap_2d": np.array([[0, 0], [1, 1]], np.float32)},
)
viewer = jupyter.BaseViewer()
viewer._activate()
server = AnnDataServer(adata, host="127.0.0.1", port=0, quiet=True, serve_web_ui=False,
                       dataset_name="selection", dataset_id="selection")
server.start_background()
host, port = server._server.server_address
print(json.dumps({"url": f"http://{host}:{port}", "viewerId": viewer._viewer_id,
                  "viewerToken": viewer._viewer_token}), flush=True)
try:
    event = viewer.wait_for_event("selection", timeout=120)
    cells = np.asarray(event["cells"], dtype=np.int64)
    print(json.dumps({
        "n": int(cells.size),
        "ascending": bool(np.all(cells[1:] > cells[:-1])),
        "sum": int(cells.sum()),
        "first": cells[:3].tolist(),
        "last": cells[-3:].tolist(),
        "source": event["source"],
        "state": viewer.state.selection is not None and len(viewer.state.selection["cells"]) == cells.size,
    }), flush=True)
finally:
    server.stop()
    viewer.stop()
`;

test.skip(PYTHON === null, 'CELLUCID_PYTHON names no interpreter for the data server');

test('a one-million-cell selection reaches the notebook whole, through the browser', async ({ page }) => {
  test.setTimeout(180_000);
  const child = spawn(PYTHON, ['-c', SERVER], {
    env: {
      ...process.env,
      PYTHONPATH: [PYTHON_SOURCE, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  try {
    const first = await lines.next();
    if (first.done) throw new Error(`the data server exited: ${stderr}`);
    const config = JSON.parse(first.value);

    await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
    const count = 1_000_000;
    const sent = await page.evaluate(async ({ config, count }) => {
      const { JupyterBridgeDataSource } = await import('/assets/js/data/jupyter-source.js');
      const source = new JupyterBridgeDataSource({
        serverUrl: config.url,
        viewerId: config.viewerId,
        viewerToken: config.viewerToken,
      });
      if (!(await source.initialize())) throw new Error('the bridge did not connect');
      // Unordered and spread over 4M indices; 7,919 is prime, so every index
      // is distinct.
      const cells = new Array(count);
      let sum = 0;
      for (let index = 0; index < count; index++) {
        cells[index] = (index * 7_919) % 4_000_003;
        sum += cells[index];
      }
      const started = performance.now();
      await source.notifySelection(cells, 'lasso');
      const deliveredMs = performance.now() - started;
      const sorted = Float64Array.from(cells).sort();
      return {
        deliveredMs,
        first: Array.from(sorted.subarray(0, 3)),
        last: Array.from(sorted.subarray(count - 3)),
        sum,
      };
    }, { config, count });

    const received = JSON.parse((await lines.next()).value);
    expect(received).toEqual({
      n: count,
      ascending: true,
      sum: sent.sum,
      first: sent.first,
      last: sent.last,
      source: 'lasso',
      state: true,
    });
    console.log(`[jupyter selection] ${count.toLocaleString('en-US')} cells delivered in ${sent.deliveredMs.toFixed(0)} ms`);
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
  }
});
