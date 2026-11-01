/**
 * The notebook widget in a real JupyterLab, from Python and from R: a cell
 * runs `cellucid.show_anndata(...)` (Python) or `cellucid_view(...)` (R, in
 * IRkernel), the widget's output frames this site's app (another origin than
 * JupyterLab's), the app reads the dataset and talks to the kernel only
 * through the widget (no data server, no port), it renders, a lasso drawn in
 * the frame reaches the kernel as a selection, and a command from the kernel
 * reaches the viewer.
 *
 * Needs CELLUCID_PYTHON set to an interpreter with JupyterLab, anywidget and
 * cellucid's dependencies; without it the file is skipped, as the other
 * live-server specs are. The R test also needs CELLUCID_R, an R with IRkernel
 * and cellucid-r's dependencies (and pkgload), and is skipped without it. The
 * kernels load the cellucid-python and cellucid-r checkouts beside this
 * repository (or CELLUCID_PYTHON_ROOT / CELLUCID_R_ROOT), never an installed
 * copy.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from './helpers/test.mjs';

const PYTHON = process.env.CELLUCID_PYTHON ?? null;
const R = process.env.CELLUCID_R ?? null;
const here = path.dirname(fileURLToPath(import.meta.url));
const PYTHON_SOURCE = path.join(
  process.env.CELLUCID_PYTHON_ROOT ?? path.resolve(here, '..', '..', '..', 'cellucid-python'),
  'src',
);
const R_SOURCE = process.env.CELLUCID_R_ROOT ?? path.resolve(here, '..', '..', '..', 'cellucid-r');

const CELLS = 2_000;

// Two clusters of cells on a 2-D UMAP, a categorical column and three genes.
const MAKE_DATASET = `
import sys
import anndata as ad, numpy as np, pandas as pd
rng = np.random.default_rng(7)
n = ${CELLS}
umap = np.concatenate([rng.normal(-4, 1, (n // 2, 2)), rng.normal(4, 1, (n - n // 2, 2))]).astype(np.float32)
adata = ad.AnnData(
    X=rng.poisson(1.0, (n, 3)).astype(np.float32),
    obs=pd.DataFrame({"cell_type": pd.Categorical(["left"] * (n // 2) + ["right"] * (n - n // 2))},
                     index=[f"cell{i}" for i in range(n)]),
    var=pd.DataFrame(index=["GeneA", "GeneB", "GeneC"]),
    obsm={"X_umap": umap},
)
adata.write_h5ad(sys.argv[1])
`;

// Room for the notebook's toolbar, the output and the viewer's canvas whole.
test.use({ viewport: { width: 1440, height: 1200 } });

const code = source => ({ cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source });

function pythonNotebook(appUrl) {
  return {
    cells: [
      code([
        'import cellucid\n',
        `viewer = cellucid.show_anndata("demo.h5ad", dataset_name="Demo", dataset_id="demo", web_source_url=${JSON.stringify(appUrl)}, height=640)`,
      ]),
      code([
        'selection = viewer.state.selection\n',
        'print("RESULT", viewer.state.ready is not None, viewer._server.is_running(), ',
        'None if selection is None else len(selection["cells"]), None if selection is None else selection["source"])',
      ]),
      code(['viewer.set_color_by("cell_type")']),
    ],
    metadata: { kernelspec: { name: 'python3', display_name: 'Python 3 (ipykernel)', language: 'python' } },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

function rNotebook(appUrl) {
  return {
    cells: [
      code([
        `pkgload::load_all(${JSON.stringify(R_SOURCE)}, quiet = TRUE)\n`,
        `viewer <- cellucid_view("demo.h5ad", dataset_id = "demo", dataset_name = "Demo", web_source_url = ${JSON.stringify(appUrl)})`,
      ]),
      code([
        'selection <- cellucid_selection(viewer)\n',
        'cat("RESULT", !is.null(viewer$ready), is.null(viewer$server), length(selection$cells), selection$source, "\\n")',
      ]),
      code(['cellucid_color_by(viewer, "cell_type")']),
    ],
    metadata: { kernelspec: { name: 'ir', display_name: 'R', language: 'R' } },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForLab(url, child, output) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`JupyterLab exited: ${output()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`JupyterLab did not start: ${output()}`);
}

/**
 * A JupyterLab on a free port serving `root`, whose kernels are exactly
 * `kernels` (name -> kernel.json), whatever the machine has registered.
 */
async function startLab(root, kernels) {
  for (const [name, spec] of Object.entries(kernels)) {
    const directory = path.join(root, '.data', 'kernels', name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'kernel.json'), JSON.stringify(spec));
  }
  const port = await freePort();
  const token = randomBytes(24).toString('hex');
  let output = '';
  // `-m jupyterlab`, not `-m jupyter lab`: the latter runs whichever
  // `jupyter-lab` comes first on PATH, with that installation's extensions.
  const lab = spawn(PYTHON, [
    '-m', 'jupyterlab',
    '--no-browser',
    `--port=${port}`,
    '--ServerApp.ip=127.0.0.1',
    `--ServerApp.root_dir=${root}`,
    `--IdentityProvider.token=${token}`,
    '--LabApp.check_for_updates_class=jupyterlab.NeverCheckForUpdate',
  ], {
    cwd: root,
    env: {
      ...process.env,
      PYTHONPATH: [PYTHON_SOURCE, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      JUPYTER_CONFIG_DIR: path.join(root, '.jupyter'),
      JUPYTER_DATA_DIR: path.join(root, '.data'),
      JUPYTERLAB_WORKSPACES_DIR: path.join(root, '.workspaces'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  lab.stdout.on('data', chunk => { output += chunk; });
  lab.stderr.on('data', chunk => { output += chunk; });
  await waitForLab(`http://127.0.0.1:${port}/api/status?token=${token}`, lab, () => output);
  return {
    url: notebook => `http://127.0.0.1:${port}/lab/tree/${notebook}?token=${token}`,
    async stop() {
      if (lab.exitCode !== null) return;
      const exited = new Promise(resolve => lab.once('exit', resolve));
      lab.kill('SIGTERM');
      await exited;
    },
  };
}

/** Run the notebook cell at `index` (0-based) and wait until it has run. */
async function runCell(page, index, timeout = 60_000) {
  const cell = page.locator('.jp-Notebook .jp-Cell').nth(index);
  await cell.locator('.jp-InputArea-editor').click();
  await page.keyboard.press('Shift+Enter');
  await expect(cell.locator('.jp-InputPrompt')).not.toHaveText(/\[\s*\*?\s*\]/, { timeout });
}

/**
 * The notebook at `url` (three cells: show, report, colour by) run against
 * the widget: it renders, a lasso reaches the kernel, a command reaches the
 * viewer. Returns the report cell's text and the lassoed cell count.
 */
async function exerciseNotebook(page, url, appOrigin, label) {
  const consoleErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.goto(url);
  await expect(page.locator('.jp-Notebook .jp-Cell')).toHaveCount(3, { timeout: 60_000 });
  await expect(page.locator('#jp-main-statusbar')).toContainText('Idle', { timeout: 120_000 });
  // JupyterLab's news question would sit over the output.
  const news = page.getByRole('button', { name: 'No', exact: true });
  if (await news.isVisible().catch(() => false)) await news.click();

  const started = Date.now();
  // The first cell loads the package (R compiles it on first load).
  await runCell(page, 0, 300_000);
  const frameElement = page.locator('iframe.cellucid-widget-frame');
  await expect(frameElement, `the widget did not render: ${consoleErrors.join(' | ')}`).toHaveCount(1, { timeout: 60_000 });
  expect(await frameElement.getAttribute('src')).toBe(`${appOrigin}/?viewer=embedded`);
  const app = page.frameLocator('iframe.cellucid-widget-frame');
  await expect(app.locator('html')).toHaveAttribute('data-startup-phase', 'ready', { timeout: 120_000 });
  console.log(`[notebook widget] ${label}: cell run to viewer ready in ${Date.now() - started} ms`);

  // It drew the cells: the viewer's own picker finds cells across the canvas.
  const appFrame = page.frame({ url: /viewer=embedded/ });
  const found = await appFrame.evaluate(() => {
    const viewer = window._cellucidViewer;
    const canvas = document.getElementById('glcanvas').getBoundingClientRect();
    const seen = new Set();
    for (let y = canvas.top + 5; y < canvas.bottom; y += 6) {
      for (let x = canvas.left + 5; x < canvas.right; x += 6) {
        const cell = viewer.pickCellAtScreen(x, y);
        if (cell >= 0) seen.add(cell);
      }
    }
    return seen.size;
  });
  expect(found).toBeGreaterThan(100);

  // A lasso over the canvas's visible part, confirmed: a saved selection,
  // sent to the kernel.
  await app.locator('.highlight-mode-btn[data-mode="lasso"]').click({ timeout: 30_000 });
  await app.locator('#glcanvas').scrollIntoViewIfNeeded();
  const box = await app.locator('#glcanvas').boundingBox();
  const viewport = page.viewportSize();
  const top = Math.max(box.y, 0) + 10;
  const bottom = Math.min(box.y + box.height, viewport.height) - 10;
  // The sidebar floats over the canvas's left part.
  const sidebar = await app.locator('#sidebar').boundingBox();
  const left = Math.max(box.x, sidebar === null ? box.x : sidebar.x + sidebar.width) + 10;
  const right = Math.min(box.x + box.width, viewport.width) - 10;
  const corners = [[left, top], [right, top], [right, bottom], [left, bottom], [left, top]];
  // A gesture can land before the tool is armed; it is drawn again until the
  // lasso's step controls appear, as highlight-selection-feedback.spec does.
  const controls = app.locator('#lasso-step-controls');
  for (let attempt = 0; attempt < 8; attempt++) {
    await page.mouse.move(corners[0][0], corners[0][1]);
    await page.keyboard.down('Alt');
    await page.mouse.down();
    for (const [x, y] of corners.slice(1)) await page.mouse.move(x, y, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.up('Alt');
    const armed = await controls.waitFor({ state: 'attached', timeout: 5_000 }).then(() => true, () => false);
    if (armed) break;
  }
  // Confirmed by its button's click; where the select bar lands in the
  // output, JupyterLab's own side panel may cover it.
  await app.locator('#lasso-confirm-btn').dispatchEvent('click');
  const lassoLabel = app.locator('text=/Lasso \\([\\d,]+ cells?\\)/').first();
  await expect(lassoLabel).toBeVisible({ timeout: 30_000 });
  const lassoed = Number((await lassoLabel.textContent()).match(/\(([\d,]+) cells?\)/)[1].replace(/,/g, ''));
  expect(lassoed).toBeGreaterThan(0);

  // The next cell reads what reached the kernel between the cells.
  await runCell(page, 1);
  const result = page.locator('.jp-Notebook .jp-Cell').nth(1).locator('.jp-OutputArea-output');
  await expect(result).toContainText('RESULT', { timeout: 30_000 });
  const report = (await result.textContent()).trim();

  // A command from the kernel reaches the viewer: colour by the categorical column.
  await runCell(page, 2);
  await expect(app.locator('#categorical-field option:checked')).toHaveText('cell_type', { timeout: 30_000 });
  expect(consoleErrors.filter(text => /cellucid/i.test(text))).toEqual([]);
  return { report, lassoed };
}

function datasetIn(root) {
  const made = spawnSync(PYTHON, ['-c', MAKE_DATASET, path.join(root, 'demo.h5ad')], { encoding: 'utf8' });
  expect(made.status, made.stderr).toBe(0);
}

test.skip(PYTHON === null, 'CELLUCID_PYTHON names no interpreter with JupyterLab');

test('Python: a notebook cell shows the viewer, and a lasso and a command cross the widget', async ({ page, baseURL }) => {
  test.setTimeout(300_000);
  const appOrigin = new URL(baseURL).origin;
  const root = mkdtempSync(path.join(tmpdir(), 'cellucid-lab-'));
  let lab = null;
  try {
    datasetIn(root);
    writeFileSync(path.join(root, 'demo.ipynb'), JSON.stringify(pythonNotebook(appOrigin)));
    lab = await startLab(root, {
      python3: {
        argv: [PYTHON, '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
        display_name: 'Python 3 (ipykernel)',
        language: 'python',
      },
    });
    const { report, lassoed } = await exerciseNotebook(page, lab.url('demo.ipynb'), appOrigin, 'Python');
    // ready, no server running (the data went through the widget), the cells, the tool.
    expect(report).toBe(`RESULT True False ${lassoed} lasso`);
  } finally {
    await lab?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('R: cellucid_view() in IRkernel shows the viewer, and a lasso and a command cross the widget', async ({ page, baseURL }) => {
  test.skip(R === null, 'CELLUCID_R names no R with IRkernel');
  test.setTimeout(600_000);
  const appOrigin = new URL(baseURL).origin;
  const root = mkdtempSync(path.join(tmpdir(), 'cellucid-lab-r-'));
  let lab = null;
  try {
    datasetIn(root);
    writeFileSync(path.join(root, 'demo.ipynb'), JSON.stringify(rNotebook(appOrigin)));
    lab = await startLab(root, {
      ir: {
        argv: [R, '--slave', '-e', 'IRkernel::main()', '--args', '{connection_file}'],
        display_name: 'R',
        language: 'R',
      },
    });
    const { report, lassoed } = await exerciseNotebook(page, lab.url('demo.ipynb'), appOrigin, 'R');
    // ready, no server (the data went through the widget), the cells, the tool.
    expect(report).toBe(`RESULT TRUE TRUE ${lassoed} lasso`);
  } finally {
    await lab?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
