/**
 * The viewer channel end to end, in a real browser against a real
 * cellucid-python server: one WebSocket per viewer (`data/viewer-channel.js`,
 * `cellucid._viewer_channel`).
 *
 * - Commands Python sends before the page connects arrive, in order, once it
 *   says hello; later ones arrive as they are sent.
 * - A highlight and a visibility change from Python travel as binary frames
 *   and reach the viewer as the cells Python named, ascending, read in place.
 * - A `ping` is answered with a `pong` event, a selection and a session bundle
 *   travel as binary frames and reach Python whole.
 * - A socket the network drops is reopened by the page at once, and the
 *   commands Python sent meanwhile arrive on the new one, once.
 * - Stopping the viewer ends the page's channel as "stopped".
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

// The notebook side. It prints one JSON line per step and waits for a line on
// stdin before each next one, so the browser and Python take turns.
const SERVER = `
import base64, json, socket, struct, sys
import anndata as ad, numpy as np, pandas as pd
import cellucid._viewer_channel as channel
import cellucid.jupyter as jupyter
from cellucid._server_base import CELLUCID_WEB_URL
from cellucid.anndata_server import AnnDataServer
from cellucid.session_bundle import SESSION_BUNDLE_MAGIC

def say(value):
    print(json.dumps(value), flush=True)

def wait_turn():
    sys.stdin.readline()

adata = ad.AnnData(
    X=np.zeros((2, 1), np.float32),
    obs=pd.DataFrame(index=["a", "b"]),
    var=pd.DataFrame(index=["g"]),
    obsm={"X_umap_2d": np.array([[0, 0], [1, 1]], np.float32)},
)
viewer = object.__new__(jupyter.AnnDataViewer)
viewer._init_state(port=None, height=600, client_server_url=None,
                   web_source_url=CELLUCID_WEB_URL, web_cache_dir=None, allowed_hosts=None)
viewer._activate()
server = AnnDataServer(adata, host="127.0.0.1", port=0, quiet=True, serve_web_ui=False,
                       dataset_name="channel", dataset_id="channel")
server.start_background()
host, port = server._server.server_address
manifest = json.dumps({
    "createdAt": "2026-10-24T00:00:00.000Z",
    "datasetFingerprint": {
        "datasetId": None, "name": None, "cellCount": 0, "varCount": 0,
        "cellOrder": {"embedding": {"key": "X_umap", "columns": [0, 1]}, "dimension": 2,
                      "digest": "0123456789abcdef"},
        "dataMapping": {
            "kind": "anndata",
            "embeddings": {"enabled": [{"key": "X_umap", "columns": [0, 1]}],
                           "defaults": {"1d": None, "2d": {"key": "X_umap", "columns": [0, 1]}, "3d": None}},
            "knn": None, "geneNames": "index", "expression": "X", "log1p": {},
            "highlyVariable": None, "latent": None, "vectorFields": [],
        },
    },
    "source": None,
    "requires": {"obs": [], "var": []},
    "chunks": [],
}, separators=(",", ":")).encode()
bundle = SESSION_BUNDLE_MAGIC + struct.pack("<I", len(manifest)) + manifest
try:
    # Sent before any page is connected: they wait for it.
    viewer.set_color_by("leiden")
    viewer.reset_view()
    say({"url": f"http://{host}:{port}", "viewerId": viewer._viewer_id,
         "viewerToken": viewer._viewer_token, "bundle": base64.b64encode(bundle).decode()})
    ready = viewer.wait_for_event("ready", timeout=60)
    say({"ready": ready})
    # Commands that name cells: binary frames, the cells sorted once here.
    viewer.highlight_cells(np.arange(2_000_000, dtype=np.int64)[::-1] * 3, color="#00ff7f")
    viewer.set_visibility([7, 2], visible=False)
    viewer.set_visibility(None, visible=True)
    viewer.send_message({"type": "ping", "requestId": "p1"})
    pong = viewer.wait_for_event("pong", timeout=60, predicate=lambda e: e["requestId"] == "p1")
    selection = viewer.wait_for_event("selection", timeout=120)
    cells = np.asarray(selection["cells"], dtype=np.int64)
    viewer._displayed = True
    captured = viewer.get_session_bundle(timeout=60)
    say({
        "pong": pong["requestId"],
        "selection": {"n": int(cells.size), "sum": int(cells.sum()),
                      "ascending": bool(np.all(cells[1:] > cells[:-1])), "source": selection["source"]},
        "bundle": captured.path.read_bytes() == bundle,
    })
    captured.path.unlink()
    wait_turn()
    # The network drops the socket: no close frame, the connection just ends.
    registration = channel._event_callbacks[viewer._viewer_id]
    registration.socket._connection.shutdown(socket.SHUT_RDWR)
    viewer.set_color_by("after-drop")
    say({"dropped": True})
    wait_turn()
    viewer.stop()
    say({"stopped": True})
finally:
    server.stop()
`;

test.skip(PYTHON === null, 'CELLUCID_PYTHON names no interpreter for the data server');

test('commands, events, binary frames, a dropped socket and a stop travel the one channel', async ({ page }) => {
  test.setTimeout(240_000);
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
      const source = new ViewerHostDataSource({
        serverUrl: config.url,
        viewerId: config.viewerId,
        viewerToken: config.viewerToken,
      });
      window.__channel = { source, commands: [], ends: [], highlights: [] };
      source.onHighlight((cells, color) => {
        if (cells === null) return;
        let sum = 0;
        let ascending = true;
        for (let index = 0; index < cells.length; index++) {
          sum += cells[index];
          if (index > 0 && cells[index] <= cells[index - 1]) ascending = false;
        }
        window.__channel.highlights.push({
          typed: cells instanceof Uint32Array, n: cells.length, sum, ascending, last: cells[cells.length - 1], color,
        });
      });
      source.onMessage(message => {
        if (message.type === 'setVisibility') {
          window.__channel.commands.push(
            `setVisibility:${message.visible}:${message.cells === null ? 'all' : Array.from(message.cells).join(',')}`
          );
          return;
        }
        window.__channel.commands.push(message.type === 'setColorBy' ? `setColorBy:${message.field}` : message.type);
        if (message.type === 'requestSessionBundle') {
          const bytes = Uint8Array.from(atob(config.bundle), character => character.charCodeAt(0));
          source.sendSessionBundle(message.requestId, new Blob([bytes]));
        }
      });
      source.onChannelEnd(end => window.__channel.ends.push(end.kind));
      if (!(await source.initialize())) throw new Error('the channel did not open');
      source.acceptCommands();
      await source.notifyReady({ nCells: 2, dimensions: 2 });
    }, config);
    // Sent before the page connected, delivered in order once it said hello
    // (they follow the welcome on the socket).
    await expect.poll(() => page.evaluate(() => window.__channel.commands), { timeout: 30_000 })
      .toEqual(['setColorBy:leiden', 'resetCamera']);
    expect(await next()).toEqual({ ready: { n_cells: 2, dimensions: 2 } });
    // Two million cells, sent in descending order as NumPy integers.
    await expect.poll(() => page.evaluate(() => window.__channel.highlights), { timeout: 60_000 }).toEqual([{
      typed: true, n: 2_000_000, sum: 3 * (1_999_999 * 2_000_000) / 2, ascending: true, last: 5_999_997, color: '#00ff7f',
    }]);
    await expect.poll(() => page.evaluate(() => window.__channel.commands.slice(2, 4)), { timeout: 30_000 })
      .toEqual(['setVisibility:false:2,7', 'setVisibility:true:all']);

    const count = 1_000_000;
    const sent = await page.evaluate(async count => {
      const cells = new Uint32Array(count);
      let sum = 0;
      for (let index = 0; index < count; index++) {
        cells[index] = index * 3;
        sum += index * 3;
      }
      const started = performance.now();
      await window.__channel.source.notifySelection(cells, 'lasso');
      return { sum, ms: performance.now() - started };
    }, count);
    expect(await next()).toEqual({
      pong: 'p1',
      selection: { n: count, sum: sent.sum, ascending: true, source: 'lasso' },
      bundle: true,
    });
    console.log(`[viewer channel] ${count.toLocaleString('en-US')} cells handed to the socket in ${sent.ms.toFixed(0)} ms`);

    child.stdin.write('\n');
    expect(await next()).toEqual({ dropped: true });
    // The page reopens the dropped socket by itself and receives what was sent meanwhile, once.
    await expect.poll(
      () => page.evaluate(() => window.__channel.commands.filter(type => type === 'setColorBy:after-drop').length),
      { timeout: 30_000 },
    ).toBe(1);
    expect(await page.evaluate(() => window.__channel.ends)).toEqual([]);

    child.stdin.write('\n');
    expect(await next()).toEqual({ stopped: true });
    await expect.poll(() => page.evaluate(() => window.__channel.ends), { timeout: 30_000 }).toEqual(['stopped']);
    expect(await page.evaluate(() => window.__channel.commands.at(-1))).toBe('freeze');
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
  }
});
