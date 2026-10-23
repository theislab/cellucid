#!/usr/bin/env node
/**
 * Benchmark of the HDF5 reader (assets/js/formats/hdf5) against h5wasm (the
 * HDF5 C library compiled to WebAssembly; the npm devDependency `h5wasm`,
 * its Node build).
 *
 *     npm run bench:hdf5 -- [--cells 200000] [--genes 2000] [--latency 20,80,150]
 *                           [--bandwidth 50] [--url URL --size BYTES]
 *
 * Workloads, on AnnData files generated once (with the repository's Python
 * environment) into the system temp directory:
 *
 * - `open`: open the file and read every object's names and attributes;
 * - `obs`: every obs column (categorical codes and categories, numbers);
 * - `genes`: 20 gene columns of X (CSC: an indptr lookup and two slices per
 *   gene; dense: 20 matrix columns; CSR: one full pass, which is what a gene
 *   needs in that layout);
 * - `obsm`: every embedding.
 *
 * Local: both readers read the file in place (h5wasm through its Node file
 * system, which reads the host file directly; its requests and bytes are
 * the `fs.readSync` calls it makes). Simulated remote: the reader only;
 * every request waits `latency` ms, then its bytes share one `bandwidth`
 * MB/s link, and the reader issues its requests concurrently (6 at a time,
 * as a browser does). h5wasm reads synchronously and has no remote
 * scenario here: the comparison over a simulated link with the earlier app
 * reader, which ran h5wasm, is `scripts/benchmark-anndata.mjs --baseline
 * REF` (`npm run bench:anndata`). Each run is its own process, so peak
 * memory (resident set size) is the run's own.
 *
 * `--url` reads a real remote file with the reader only.
 *
 * @module scripts/benchmark-hdf5-reader
 */

import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PYTHON = path.resolve(ROOT, '..', '.environments', 'python', 'venv', 'bin', 'python');
const SELF = fileURLToPath(import.meta.url);
const MiB = 1024 * 1024;

function argument(name, defaultValue) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : defaultValue;
}

/* ---------- data ---------- */

const GENERATOR = String.raw`
import sys, numpy as np, pandas as pd, scipy.sparse as sp, anndata as ad
out, cells, genes = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
rng = np.random.default_rng(0)
obs = pd.DataFrame(index=[f"cell_{i:07d}" for i in range(cells)])
for i in range(16):
    obs[f"category_{i:02d}"] = pd.Categorical(rng.integers(0, 5 + 10 * i, cells).astype(str))
for i in range(8):
    obs[f"score_{i:02d}"] = rng.standard_normal(cells).astype("float32")
for i in range(4):
    obs[f"count_{i:02d}"] = rng.integers(0, 10_000, cells)
for i in range(4):
    obs[f"flag_{i:02d}"] = rng.random(cells) < 0.3
var = pd.DataFrame(index=[f"gene_{j:05d}" for j in range(genes)])
obsm = {"X_umap": rng.standard_normal((cells, 2)).astype("float32"),
        "X_pca": rng.standard_normal((cells, 50)).astype("float32")}
nnz = int(cells * genes * 0.02)
rows = rng.integers(0, cells, nnz)
cols = rng.integers(0, genes, nnz)
vals = rng.poisson(2, nnz).astype("float32") + 1
csr = sp.csr_matrix((vals, (rows, cols)), shape=(cells, genes))
csr.sum_duplicates()
ad.AnnData(X=csr, obs=obs, var=var, obsm=obsm).write_h5ad(f"{out}/csr.h5ad", compression="gzip")
ad.AnnData(X=csr.tocsc(), obs=obs, var=var, obsm=obsm).write_h5ad(f"{out}/csc.h5ad", compression="gzip")
dense_genes = min(genes, 200)
dense = rng.poisson(0.3, (cells, dense_genes)).astype("float32")
ad.AnnData(X=dense, obs=obs, var=var.iloc[:dense_genes], obsm=obsm).write_h5ad(f"{out}/dense.h5ad", compression="gzip")
`;

function ensureData(cells, genes) {
  const directory = path.join(os.tmpdir(), `cellucid-hdf5-bench-${cells}x${genes}`);
  const files = ['csr', 'csc', 'dense'].map(name => path.join(directory, `${name}.h5ad`));
  if (files.every(file => fs.existsSync(file))) return files;
  fs.mkdirSync(directory, { recursive: true });
  console.log(`Generating ${cells} x ${genes} AnnData files in ${directory} ...`);
  execFileSync(PYTHON, ['-c', GENERATOR, directory, String(cells), String(genes)], { stdio: 'inherit' });
  return files;
}

/* ---------- one run (in its own process) ---------- */

/**
 * A simulated network link: a request reaches the host after `latency` ms
 * and its bytes then share one link of `bandwidth` MB/s with every other
 * transfer (concurrent requests overlap their latency, not their bytes).
 * Returns the milliseconds until the request's last byte arrives.
 */
function createLink(latency, bandwidth) {
  let linkFree = 0;
  return bytes => {
    const now = performance.now();
    const start = Math.max(now + latency, linkFree);
    linkFree = start + (bandwidth > 0 ? (bytes / MiB / bandwidth) * 1000 : 0);
    return linkFree - now;
  };
}

async function runOurs({ file, url, size, latency, bandwidth, workloads }) {
  const { httpByteSource, LOCAL_POLICY, REMOTE_POLICY } = await import('../assets/js/formats/io/byte-source.js');
  const { createByteReader } = await import('../assets/js/formats/io/byte-reader.js');
  const { openHdf5 } = await import('../assets/js/formats/hdf5/index.js');
  const link = createLink(latency, bandwidth);
  let source;
  if (url) {
    source = httpByteSource({ url, size });
  } else {
    const handle = await fs.promises.open(file, 'r');
    const stat = await handle.stat();
    const local = {
      size: stat.size,
      name: path.basename(file),
      identity: Object.freeze({ kind: 'file', name: file }),
      // A remote file gets the policy a browser would use for one.
      policy: latency > 0 ? REMOTE_POLICY : LOCAL_POLICY,
      async read(offset, length) {
        const bytes = new Uint8Array(length);
        await handle.read(bytes, 0, length, offset);
        if (latency > 0) await new Promise(resolve => setTimeout(resolve, link(length)));
        return bytes;
      },
    };
    source = Object.freeze(local);
  }
  const reader = createByteReader(source);
  const results = {};
  let root = null;
  const phase = async (name, work) => {
    const before = reader.stats();
    const started = performance.now();
    await work();
    const after = reader.stats();
    results[name] = { ms: performance.now() - started, requests: after.requests - before.requests, bytes: after.bytes - before.bytes };
  };
  await phase('open', async () => {
    root = await openHdf5(reader);
    const walk = group => {
      for (const key of group.keys()) {
        const child = group.get(key);
        void child.attrs;
        if (child.kind === 'group') walk(child);
      }
    };
    walk(root);
  });
  const layout = root.get('X').kind === 'group' ? root.get('X').attrs['encoding-type'] : 'dense';
  if (workloads.includes('obs')) {
    await phase('obs', async () => {
      const obs = root.get('obs');
      await Promise.all(obs.keys().map(async key => {
        const node = obs.get(key);
        if (node.kind === 'group') {
          await Promise.all([node.get('codes').read(), node.get('categories').read()]);
        } else {
          await node.read();
        }
      }));
    });
  }
  if (workloads.includes('genes')) {
    await phase('genes', async () => {
      const genes = Array.from({ length: 20 }, (_, i) => (i * 97) % (layout === 'dense' ? root.get('X').shape[1] : root.get('var/_index').shape[0]));
      if (layout === 'csc_matrix') {
        const X = root.get('X');
        const indptr = X.get('indptr');
        const bounds = await Promise.all(genes.map(g => indptr.read([[g, g + 2]])));
        await Promise.all(bounds.flatMap(([a, b]) => [X.get('data').read([[Number(a), Number(b)]]), X.get('indices').read([[Number(a), Number(b)]])]));
      } else if (layout === 'csr_matrix') {
        const X = root.get('X');
        await Promise.all([X.get('indptr').read(), X.get('data').read(), X.get('indices').read()]);
      } else {
        const X = root.get('X');
        await Promise.all(genes.map(g => X.read([[0, X.shape[0]], [g, g + 1]])));
      }
    });
  }
  if (workloads.includes('obsm')) {
    await phase('obsm', async () => {
      const obsm = root.get('obsm');
      await Promise.all(obsm.keys().map(key => obsm.get(key).read()));
    });
  }
  return results;
}

async function runH5wasm({ file, workloads }) {
  // The Node build reads host files in place; every byte it reads goes
  // through `fs.readSync` (looked up on the module at each call), so
  // counting those calls counts its requests and bytes.
  const module = await import('h5wasm/node');
  const h5wasm = module.default;
  await h5wasm.ready;
  const counters = { requests: 0, bytes: 0 };
  const readSync = fs.readSync;
  fs.readSync = (...args) => {
    const bytesRead = readSync(...args);
    counters.requests++;
    counters.bytes += bytesRead;
    return bytesRead;
  };
  const results = {};
  let f = null;
  const phase = (name, work) => {
    const before = { ...counters };
    const started = performance.now();
    work();
    results[name] = { ms: performance.now() - started, requests: counters.requests - before.requests, bytes: counters.bytes - before.bytes };
  };
  phase('open', () => {
    f = new h5wasm.File(path.resolve(file), 'r');
    const walk = group => {
      for (const key of group.keys()) {
        const child = group.get(key);
        for (const attribute of Object.values(child.attrs)) void attribute.json_value;
        if (child.type === 'Group') walk(child);
      }
    };
    walk(f);
  });
  const X = f.get('X');
  const layout = X.type === 'Group' ? X.attrs['encoding-type'].json_value : 'dense';
  if (workloads.includes('obs')) {
    phase('obs', () => {
      const obs = f.get('obs');
      for (const key of obs.keys()) {
        const node = obs.get(key);
        if (node.type === 'Group') {
          void node.get('codes').value;
          void node.get('categories').value;
        } else {
          void node.value;
        }
      }
    });
  }
  if (workloads.includes('genes')) {
    phase('genes', () => {
      const count = layout === 'dense' ? X.shape[1] : f.get('var/_index').shape[0];
      const genes = Array.from({ length: 20 }, (_, i) => (i * 97) % count);
      if (layout === 'csc_matrix') {
        for (const g of genes) {
          const [a, b] = X.get('indptr').slice([[g, g + 2]]);
          void X.get('data').slice([[Number(a), Number(b)]]);
          void X.get('indices').slice([[Number(a), Number(b)]]);
        }
      } else if (layout === 'csr_matrix') {
        void X.get('indptr').value;
        void X.get('data').value;
        void X.get('indices').value;
      } else {
        for (const g of genes) void X.slice([[0, X.shape[0]], [g, g + 1]]);
      }
    });
  }
  if (workloads.includes('obsm')) {
    phase('obsm', () => {
      const obsm = f.get('obsm');
      for (const key of obsm.keys()) void obsm.get(key).value;
    });
  }
  results.wasmHeapMiB = module.Module.HEAPU8.length / MiB;
  f.close();
  return results;
}

async function child() {
  const options = JSON.parse(process.env.HDF5_BENCH_OPTIONS);
  let peak = process.memoryUsage().rss;
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 5);
  const results = options.reader === 'ours' ? await runOurs(options) : await runH5wasm(options);
  clearInterval(sampler);
  peak = Math.max(peak, process.memoryUsage().rss);
  results.peakRssMiB = peak / MiB;
  process.stdout.write(`${JSON.stringify(results)}\n`);
}

/* ---------- driver ---------- */

function run(options) {
  const result = spawnSync(process.execPath, ['--expose-gc', SELF, '--child'], {
    cwd: ROOT,
    env: { ...process.env, HDF5_BENCH_OPTIONS: JSON.stringify(options) },
    encoding: 'utf8',
    maxBuffer: 64 * MiB,
    timeout: 30 * 60 * 1000,
  });
  const line = result.stdout.trim().split('\n').pop();
  try {
    return JSON.parse(line);
  } catch {
    return { error: (result.stderr || result.stdout || 'no output').trim().split('\n').slice(-3).join(' | ') };
  }
}

const format = {
  ms: value => (value === undefined ? '—' : value >= 10_000 ? `${(value / 1000).toFixed(1)} s` : `${value.toFixed(0)} ms`),
  bytes: value => (value === undefined ? '—' : value >= MiB ? `${(value / MiB).toFixed(1)} MiB` : `${(value / 1024).toFixed(0)} KiB`),
};

function table(rows) {
  const widths = rows[0].map((_, column) => Math.max(...rows.map(row => String(row[column]).length)));
  return rows.map(row => row.map((cell, column) => String(cell).padEnd(widths[column])).join('  ')).join('\n');
}

async function main() {
  if (process.argv.includes('--child')) {
    await child();
    return;
  }
  const url = argument('url', null);
  const workloads = ['open', 'obs', 'genes', 'obsm'];
  if (url) {
    const size = Number(argument('size', NaN));
    if (!Number.isSafeInteger(size)) throw new Error('--url needs --size (the file size in bytes).');
    const ours = run({ reader: 'ours', url, size, latency: 0, bandwidth: 0, workloads });
    console.log(JSON.stringify(ours, null, 2));
    return;
  }
  const cells = Number(argument('cells', 200_000));
  const genes = Number(argument('genes', 2000));
  const latencies = argument('latency', '20,80,150').split(',').map(Number);
  const bandwidth = Number(argument('bandwidth', 50));
  const files = ensureData(cells, genes);
  const rows = [['file', 'network', 'reader', ...workloads.flatMap(w => [w, `${w} req`, `${w} bytes`]), 'peak RSS', 'WASM heap']];
  for (const file of files) {
    const name = path.basename(file);
    console.log(`${name}: ${format.bytes(fs.statSync(file).size)}`);
    const scenarios = [{ latency: 0, label: 'local' }, ...latencies.map(latency => ({ latency, label: `${latency} ms, ${bandwidth} MB/s` }))];
    for (const scenario of scenarios) {
      const readers = scenario.latency === 0 ? ['ours', 'h5wasm'] : ['ours'];
      for (const reader of readers) {
        const result = run({ reader, file, latency: scenario.latency, bandwidth: scenario.latency > 0 ? bandwidth : 0, workloads });
        if (result.error) {
          rows.push([name, scenario.label, reader, `failed: ${result.error}`]);
          continue;
        }
        rows.push([
          name, scenario.label, reader === 'ours' ? 'formats/hdf5' : 'h5wasm',
          ...workloads.flatMap(w => [format.ms(result[w]?.ms), result[w]?.requests ?? '—', format.bytes(result[w]?.bytes)]),
          `${result.peakRssMiB.toFixed(0)} MiB`,
          result.wasmHeapMiB === undefined ? '—' : `${result.wasmHeapMiB.toFixed(0)} MiB`,
        ]);
        console.log(`  ${scenario.label.padEnd(20)} ${reader.padEnd(7)} ${workloads.map(w => `${w} ${format.ms(result[w]?.ms)}`).join(', ')}`);
      }
    }
  }
  console.log(`\n${table(rows)}`);
}

await main();
