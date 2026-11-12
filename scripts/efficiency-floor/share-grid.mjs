/**
 * The share grid: every downstream a person reaches (open, first picture,
 * every cell of the share on the map, genes, analyses, the graph, filters,
 * highlights, exports, sessions, figures, frames, a revisit) measured at
 * shares of 1, 10 and 50% (uniform and blocks) and at every cell, on each
 * store or public link given, in the whole app on the machine's GPU
 * (`scale-app.mjs`, one browser per share). Then each cell of the grid as
 * its ratio to every cell's: the rule is that no share costs more than every
 * cell (a ratio above 1.0 is a break), and the aim is about s/n (a ratio far
 * above the share's fraction is flagged with it).
 *
 *   node scripts/efficiency-floor/share-grid.mjs --out grid.jsonl
 *     --store LABEL=PATH [--store LABEL=link:URL ...]
 *     [--shares 1%u,10%u,50%u,1%b,10%b,50%b,100%] [--steps a,b,c]
 *     [--engine chromium|firefox] [--timeout 1800] [--pause 0] [--gene G00010] [--gene-next G00011]
 *   node scripts/efficiency-floor/share-grid.mjs --table grid.jsonl [--markdown]
 *
 * Each run's rows are appended to `--out` as `scale-app.mjs` writes them
 * (one per step), so a run cut short keeps what it measured. `--pause`
 * seconds between runs keeps a public host's traffic paced. Run it alone
 * (`heavy.sh`, a `big`/`atlas` label: 10M stores and atlases run alone).
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argument = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const every = name => argv.flatMap((value, i) => (value === name ? [argv[i + 1]] : []));

/** The grid's steps, in run order (`scale-app.mjs` runs those asked, in its own order). */
export const GRID_STEPS = ['open', 'gene', 'gene-next', 'frames', 'highlight', 'export-csv', 'export-h5ad', 'figure-svg',
  'legend', 'legend-1m', 'filter', 'de', 'markers', 'signature', 'dotplot', 'edges', 'knn', 'session', 'figure', 'revisit'];
export const DEFAULT_SHARES = ['100%', '1%u', '10%u', '50%u', '1%b', '10%b', '50%b'];

/** `10%u` → `{cells: '10%', sample: 'uniform', fraction: 0.1}`; `100%` is every cell. */
export function parseShare(text) {
  const match = /^(\d+(?:\.\d+)?)%([ub]?)$/.exec(text);
  if (match === null) throw new Error(`a share is a percentage and u or b (10%u, 1%b, 100%): ${text}`);
  const fraction = Number(match[1]) / 100;
  return { text, cells: `${match[1]}%`, sample: match[2] === 'u' ? 'uniform' : match[2] === 'b' ? 'blocks' : null, fraction };
}

// ---- the measurements of a grid row ---------------------------------------
/**
 * The metrics of one step's row, by name: its time (a step's own timer when
 * it reports one — the first picture, every cell of the share, a gene's load
 * — else the step's wall time), data bytes and requests (the store server's,
 * else the browser's for a link), and peak memory of the renderer, the GPU
 * process and every JavaScript thread.
 */
export function metricsOf(row) {
  const d = row.detail ?? {};
  const time = {};
  if (row.step === 'open' || row.step === 'revisit') {
    if (d.firstFrameMs !== undefined) time.pictureMs = d.firstFrameMs;
    if (d.settledMs !== undefined) time.shareOnMapMs = d.settledMs;
    if (d.geneMs !== undefined) time.geneMs = d.geneMs;
  } else if (d.loadMs !== undefined) {
    time.loadMs = d.loadMs;
  } else if (row.step === 'frames') {
    if (d.medianMs !== undefined) time.frameMedianMs = d.medianMs;
    if (d.p95Ms !== undefined) time.frameP95Ms = d.p95Ms;
  } else if (d.ms !== undefined) {
    time.ms = d.ms;
  }
  time.stepMs = row.ms;
  const local = row.servedRequests !== undefined && (row.servedRequests > 0 || (row.linkRequests ?? 0) === 0);
  return {
    ...time,
    MB: local ? row.servedMB : row.linkMB ?? null,
    requests: local ? row.servedRequests : row.linkRequests ?? null,
    rendererMB: row.rendererMB ?? null,
    gpuProcessMB: row.gpuProcessMB ?? null,
    jsMB: row.jsMB || null,
    ...(row.step === 'frames' && d.visiblePoints !== undefined ? { drawnPoints: d.visiblePoints } : {}),
  };
}

/** A time or count below which a ratio is noise, not a cost (ms, MB, requests). */
const NOISE = { ms: 150, MB: 0.5, requests: 3, memoryMB: 64 };
const noiseOf = metric => (/Ms$|^ms$/.test(metric) ? NOISE.ms : metric === 'MB' ? NOISE.MB : metric === 'requests' ? NOISE.requests : NOISE.memoryMB);

/**
 * Each (store, share, step, metric) as its ratio to every cell's value of the
 * same store, step and metric: `break` when above 1.0 (beyond the noise floor
 * of that metric in absolute terms), `far` when above twice the share's
 * fraction (and the fraction + 0.05).
 */
export function ratioTable(rows) {
  const key = row => `${row.store}\u0000${row.step}`;
  const whole = new Map();
  // Every cell's step that ran out of its time is known only to take longer:
  // a share's time is judged against that bound (`atLeast`).
  for (const row of rows) {
    if (row.share !== '100%' && row.share !== null) continue;
    if (row.failure === null) whole.set(key(row), metricsOf(row));
    else if (/^timeout (\d+) ms/.test(row.failure) && !whole.has(key(row))) whole.set(key(row), { stepMs: Number(/^timeout (\d+) ms/.exec(row.failure)[1]), atLeast: true });
  }
  const out = [];
  for (const row of rows) {
    if (row.share === '100%' || row.share === null) continue;
    const share = parseShare(row.share.replace(' uniform', 'u').replace(' blocks', 'b'));
    const base = whole.get(key(row));
    if (row.failure !== null) { out.push({ store: row.store, share: share.text, step: row.step, failure: row.failure }); continue; }
    if (base === undefined) continue;
    const metrics = metricsOf(row);
    for (const [metric, value] of Object.entries(metrics)) {
      if (metric === 'atLeast') continue;
      const reference = base[metric];
      if (value === null || value === undefined || reference === null || reference === undefined) continue;
      const ratio = reference === 0 ? (value === 0 ? 0 : Infinity) : value / reference;
      const brk = ratio > 1 && value - reference > noiseOf(metric);
      const far = !brk && ratio > Math.max(2 * share.fraction, share.fraction + 0.05) && value > noiseOf(metric);
      out.push({ store: row.store, share: share.text, step: row.step, metric, value, reference, ratio: Math.round(ratio * 100) / 100, sOverN: share.fraction, break: brk && base.atLeast !== true, far, ...(base.atLeast === true ? { atLeast: true } : {}) });
    }
  }
  return out;
}

/**
 * The other half of the rule: a share never costs more than a larger share
 * of the same kind (1% ≤ 10% ≤ 50%, uniform with uniform, blocks with
 * blocks), metric by metric beyond the noise floor; a step that failed
 * where a larger share's finished is a break too.
 */
export function monotonicBreaks(rows) {
  const byKey = new Map();
  for (const row of rows) {
    if (row.share === '100%' || row.share === null) continue;
    const share = parseShare(row.share.replace(' uniform', 'u').replace(' blocks', 'b'));
    const key = `${row.store}\u0000${row.step}\u0000${share.sample}`;
    if (!byKey.has(key)) byKey.set(key, new Map());
    byKey.get(key).set(share.fraction, row);
  }
  const out = [];
  for (const [key, shares] of byKey) {
    const [store, step, sample] = key.split('\u0000');
    const fractions = [...shares.keys()].sort((a, b) => a - b);
    for (let i = 0; i < fractions.length; i++) {
      for (let j = i + 1; j < fractions.length; j++) {
        const small = shares.get(fractions[i]);
        const large = shares.get(fractions[j]);
        const label = `${store} ${step} ${sample}: ${fractions[i] * 100}% vs ${fractions[j] * 100}%`;
        if (small.failure !== null && large.failure === null) { out.push({ label, metric: 'failure', small: small.failure, large: 'finished' }); continue; }
        if (small.failure !== null || large.failure !== null) continue;
        const a = metricsOf(small);
        const b = metricsOf(large);
        for (const [metric, value] of Object.entries(a)) {
          const reference = b[metric];
          if (value === null || value === undefined || reference === null || reference === undefined) continue;
          if (value > reference && value - reference > noiseOf(metric)) out.push({ label, metric, small: value, large: reference });
        }
      }
    }
  }
  return out;
}

function printTable(rows, markdown) {
  const table = ratioTable(rows);
  const breaks = table.filter(r => r.break);
  const failures = table.filter(r => r.failure);
  if (markdown) {
    console.log('| store | step | metric | every cell | ' + DEFAULT_SHARES.slice(1).join(' | ') + ' |');
    console.log('|' + ' --- |'.repeat(4 + DEFAULT_SHARES.length - 1));
    const groups = new Map();
    for (const r of table) {
      if (r.failure) continue;
      const k = `${r.store}|${r.step}|${r.metric}`;
      if (!groups.has(k)) groups.set(k, { r, cells: {} });
      groups.get(k).cells[r.share] = `${r.atLeast ? '≤' : ''}${r.ratio}${r.break ? ' **✗**' : r.far ? ' ~' : ''}`;
    }
    for (const { r, cells } of groups.values()) console.log(`| ${r.store} | ${r.step} | ${r.metric} | ${r.atLeast ? '>' : ''}${r.reference} | ${DEFAULT_SHARES.slice(1).map(s => cells[s] ?? '').join(' | ')} |`);
  } else {
    for (const r of table) console.log(JSON.stringify(r));
  }
  console.log(`\n${breaks.length} break(s) above every cell; ${table.filter(r => r.far).length} far from s/n; ${failures.length} failed step(s)`);
  for (const r of breaks) console.log(`BREAK ${r.store} ${r.share} ${r.step} ${r.metric}: ${r.value} vs every cell ${r.reference} (${r.ratio}×)`);
  for (const r of failures) console.log(`FAILED ${r.store} ${r.share} ${r.step}: ${r.failure}`);
  const larger = monotonicBreaks(rows);
  console.log(`\n${larger.length} break(s) above a larger share`);
  for (const r of larger) console.log(`ABOVE-LARGER ${r.label} ${r.metric}: ${r.small} vs ${r.large}`);
}

// ---- main -------------------------------------------------------------------
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const table = argument('--table');
  if (table !== null) {
    printTable(readFileSync(table, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.step !== undefined), argv.includes('--markdown'));
  } else {
    const out = argument('--out');
    if (out === null) throw new Error('--out results.jsonl');
    const shares = argument('--shares', DEFAULT_SHARES.join(',')).split(',').map(parseShare);
    const steps = argument('--steps', GRID_STEPS.join(','));
    const timeout = Number(argument('--timeout', '1800'));
    const pause = Number(argument('--pause', '0'));
    const engine = argument('--engine', 'chromium');
    const gene = argument('--gene', null);
    const geneNext = argument('--gene-next', null);
    for (const entry of every('--store')) {
      const [label, target] = [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)];
      for (const share of shares) {
        const args = [path.join(HERE, 'scale-app.mjs'), ...(target.startsWith('link:') ? ['-', '--link', target.slice(5)] : [target]),
          '--label', label, '--steps', steps, '--out', out, '--engine', engine, '--cells', share.cells,
          ...(share.sample === null ? [] : ['--sample', share.sample]), ...(gene === null ? [] : ['--gene', gene]), ...(geneNext === null ? [] : ['--gene-next', geneNext])];
        const started = Date.now();
        // At the deadline the run is asked to stop (Playwright closes its
        // browser on SIGTERM, the run its servers), then killed.
        const child = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'inherit'] });
        const term = setTimeout(() => child.kill('SIGTERM'), timeout * 1000);
        const kill = setTimeout(() => child.kill('SIGKILL'), timeout * 1000 + 30_000);
        const status = await new Promise(resolve => child.on('exit', (code, signal) => resolve(code ?? signal)));
        clearTimeout(term); clearTimeout(kill);
        console.log(`${label} ${share.text}: ${status} in ${Math.round((Date.now() - started) / 1000)} s`);
        if (pause > 0) await new Promise(resolve => setTimeout(resolve, pause * 1000));
      }
    }
  }
}
