/**
 * The input-format benchmark: every format the browser reads that is not an
 * AnnData file (Loom, a Cell Ranger outs/ folder, a MatrixMarket folder,
 * Seurat and SingleCellExperiment `.rds`, a Seurat `.rda`, `.h5mu`, MuData
 * Zarr), against the same data as a Cellucid-ready `.h5ad`.
 *
 *   python -I scripts/benchmark-formats/generate.py DATA --cells N [--formats ...]
 *   Rscript scripts/benchmark-formats/generate.R DATA/cells-N-r-arrays DATA
 *   npm run bench:formats -- (--data DATA | --file /abs/real[,/abs/other]) [--files a,b] [--out results.json]
 *
 * Every file runs in its own process (`benchmark-formats/run.mjs`), one at a
 * time, so each measures its own time and peak memory. Per file: the time to
 * the first view (open, metadata, the default embedding; for a stream format
 * the open is the whole read-and-transcode pass), the first and next gene,
 * the peak memory, and the ratios the roofline is held to (plan §11.5):
 *
 * - a range format (Loom, 10x, MuData) against the `.h5ad` of the same data:
 *   its first view within 1.3x of the `.h5ad`'s;
 * - a stream format against plain inflate of its own gzip bytes with the
 *   platform's native decompressor, measured in the same run: its pass
 *   within 1.3x of that.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const realFiles = argument('--file');
const data = argument('--data');
if (realFiles === null && data === null) {
  console.error('Usage: npm run bench:formats -- (--data DIR | --file PATH[,PATH]) [--files a,b] [--out results.json]');
  process.exit(2);
}
const manifest = data === null ? { files: {} } : JSON.parse(readFileSync(path.join(data, 'manifest.json'), 'utf8'));
const chosen = argument('--files');
const targets = realFiles !== null
  ? realFiles.split(',').map(file => ({ path: file, entry: { format: null, cells: null, bytes: null } }))
  : Object.entries(manifest.files)
    .filter(([name, entry]) => entry.format !== 'r' && (chosen === null || chosen.split(',').includes(name)))
    .map(([name, entry]) => ({ path: path.join(data, name), entry }));
const out = argument('--out');

/** Stream formats: read once from the start (the input format registry's `access: stream`). */
const STREAM = /\.(rds|rda|rdata)(\.gz)?$|-mtx$/i;

function run(target, mode) {
  const run = spawnSync(process.execPath, [path.join(HERE, 'benchmark-formats', 'run.mjs'), '--file', target, ...(mode === 'inflate' ? ['--inflate'] : [])], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const line = run.stdout.trim().split('\n').filter(text => text.startsWith('{')).at(-1);
  return line ? JSON.parse(line) : { file: path.basename(target), mode, error: run.stderr.trim().split('\n').at(-1) ?? 'no output' };
}

const results = [];
for (const target of targets) {
  const name = path.basename(target.path);
  const view = run(target.path, 'first-view');
  view.format = target.entry.format;
  view.bytes = target.entry.bytes ?? (statSync(target.path).isDirectory() ? null : statSync(target.path).size);
  view.manifestCells = target.entry.cells;
  if (STREAM.test(name)) view.inflate = run(target.path, 'inflate');
  results.push(view);
  const open = view.steps?.find(step => step.step === 'open')?.ms;
  console.error(`${name}: ${view.error ?? `first view ${view.firstViewMs} ms (open ${open} ms), peak ${view.peakRssMB} MB`}${view.inflate ? `; inflate ${view.inflate.ms} ms` : ''}`);
}

const ms = value => (value === undefined || value === null ? '-' : `${Math.round(value).toLocaleString('en-US')} ms`);
const ratio = (a, b) => (a && b ? `${(a / b).toFixed(2)}x` : '-');
const lines = [];
const sizes = [...new Set(results.map(result => result.cells ?? result.manifestCells))].sort((a, b) => a - b);
for (const cells of sizes) {
  const group = results.filter(result => (result.cells ?? result.manifestCells) === cells);
  const baseline = group.find(result => result.format === 'h5ad' || /\.h5ad$/.test(result.file));
  lines.push(`\n${cells === null || cells === undefined ? 'real files' : `${cells.toLocaleString('en-US')} cells`}`);
  lines.push('file | MB | open | first view | first gene | next gene | peak | vs .h5ad first view | pass vs inflate');
  for (const result of group) {
    const step = label => result.steps?.find(item => item.step === label)?.ms;
    const open = step('open');
    const pass = result.inflate && !result.inflate.error ? ratio(open, result.inflate.ms) : '-';
    lines.push([
      result.file,
      result.bytes ? (result.bytes / 1e6).toFixed(0) : '-',
      ms(open),
      ms(result.firstViewMs),
      ms(step('first gene')),
      ms(step('next gene')),
      `${result.peakRssMB ?? '-'} MB`,
      baseline && result !== baseline ? ratio(result.firstViewMs, baseline.firstViewMs) : '-',
      result.inflate ? `${pass} (inflate ${ms(result.inflate.ms)}, ${(result.inflate.inflatedBytes / 1e6).toFixed(0)} MB out)` : '-',
    ].join(' | '));
    if (result.error) lines.push(`  ${result.file} failed: ${result.error}`);
  }
}
console.log(lines.join('\n'));
if (out !== null) {
  writeFileSync(out, JSON.stringify({ date: new Date().toISOString(), node: process.version, results }, null, 2));
}
