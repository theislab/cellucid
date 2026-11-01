/**
 * A count and its noun agree: "1 cell", "2 cells", never "1 cells".
 *
 * Every count written with a noun goes through `formatCountOf` (or, for a
 * count written another way, `countNoun`) in `utils/format-units.js`. A
 * template that writes `${n} cells` reads "1 cells" the day `n` is one, and
 * the legend once did exactly that; hand-rolled `n === 1 ? '' : 's'` copies
 * drift from the shared rule. Both are refused here, for the whole source.
 *
 * What is not a count is not refused: a label before a plural noun
 * (`${label} values must be…`), an upper-case limit constant
 * (`${MAX_TREE_ITEMS} entries`, always above one), an index before a verb
 * (`Category ${index} duplicates…`) and a product of sizes
 * (`${width} × ${height} pixels`).
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { countNoun, formatCountOf, formatOpenCells } from '../assets/js/utils/format-units.js';

const ROOT = fileURLToPath(new URL('../assets/js/', import.meta.url));

const PLURAL_NOUNS = [
  'cells', 'points', 'genes', 'values', 'entries', 'categories', 'options', 'columns', 'rows',
  'pages', 'items', 'fields', 'characters', 'edges', 'operations', 'elements', 'datasets',
  'views', 'codes', 'groups', 'pixels', 'indices', 'stores', 'positions', 'frames', 'samples',
  'records', 'triangles', 'lists', 'comments', 'candidates', 'exports', 'files', 'workers',
  'results', 'conflicts', 'channels', 'arrays', 'vertices', 'clusters', 'colours', 'colors',
  'parameters', 'layers', 'features', 'upvotes', 'downvotes', 'suggestions', 'controls',
  'requests', 'steps', 'keyframes', 'objects', 'modalities', 'embeddings', 'annotators',
  'voters', 'votes', 'chunks', 'parts', 'matrices', 'sets', 'nodes', 'neighbours', 'neighbors',
  'repositories', 'users', 'members', 'labels', 'matches', 'lines', 'words', 'failures',
  'errors', 'warnings', 'retries', 'attempts', 'threads', 'tiles', 'batches', 'levels', 'bytes',
  'digits', 'dimensions', 'axes', 'keys', 'components', 'messages', 'times', 'reads',
];

const COUNT_TEMPLATE = new RegExp(
  String.raw`\$\{([^{}]+)\}\s+(${PLURAL_NOUNS.join('|')})(?![\w/-])`,
  'g'
);
/** Words that name what a value is, not how many there are. */
const LABEL = /(label|name|context|\bid\b|Id\b|field|path|source|title|kind|owner|key|prefix|type|Type|method|mode|what|scope|role|section|header|\bgene\b|\bgroup\b|\bpage\b|dtype|codec|format|location|where|parent|base|tag|stage|\bstep\b|which|noun|unit|attribute|\bdataset\b|subject|\bitem\b|JSON\.stringify|escape|\.join\()/i;
const COUNT_WORD = /length|count|Count|size|Size|total|Total|formatCount|toLocale|^n[A-Z_]|^n$|\bn_|Number\(|Math\./;
const LIMIT_CONSTANT = /^[A-Z0-9_.]+(\.[a-zA-Z0-9_]+)*$/;
const INDEX = /^(i|index|\w*Index|index \+ 1|module)$/;
const HAND_ROLLED = /={2,3} ?1 ?\? ?'' ?: ?'s'|={2,3} ?1 ?\? ?'y' ?: ?'ies'|={2,3} ?1 ?\? ?'([a-z]+)' ?: ?'\1s'/g;

async function sources(dir = ROOT) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'vendor') out.push(...await sources(full));
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out.sort();
}

/** The source with comments blanked out, line numbers kept. */
function withoutComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, block => block.replace(/[^\n]/g, ' '))
    .split('\n')
    .map(line => (/^\s*\/\//.test(line) ? '' : line));
}

test('formatCountOf and countNoun make a count and its noun agree', () => {
  assert.equal(formatCountOf(1, 'cell'), '1 cell');
  assert.equal(formatCountOf(0, 'cell'), '0 cells');
  assert.equal(formatCountOf(12000, 'cell'), '12,000 cells');
  assert.equal(formatCountOf(1, 'category', 'categories'), '1 category');
  assert.equal(formatCountOf(3, 'category', 'categories'), '3 categories');
  assert.equal(countNoun(1, 'edge'), 'edge');
  assert.equal(countNoun(1500, 'edge'), 'edges');
  assert.throws(() => countNoun(Number.NaN, 'cell'), /finite/);
  assert.throws(() => formatCountOf(2, ''), /non-empty/);
});

test('a count of the open cells is said against every cell on a subsample, its noun agreeing with the last count', async () => {
  // Every cell open: the count alone.
  assert.equal(formatOpenCells(1200, 1200), '1,200 cells');
  assert.equal(formatOpenCells(1200, null), '1,200 cells');
  assert.equal(formatOpenCells(1, 1), '1 cell');
  // A subsample: "k of n cells", the one way every shown count of them reads.
  assert.equal(formatOpenCells(300, 1200), '300 of 1,200 cells');
  assert.equal(formatOpenCells(1, 2), '1 of 2 cells');
  assert.equal(formatOpenCells(300, 1200, value => `${value / 100}h`), '3h of 12h cells');
  assert.throws(() => formatOpenCells(3, 2), /never more/);
  const { describeCountedCells } = await import('../assets/js/app/ui/modules/legend/categorical-legend.js');
  assert.equal(describeCountedCells({ pointCount: 240, cellIdentity: { nOriginal: 1200 } }), 'Counted on the 240 of 1,200 cells open.');
  assert.equal(describeCountedCells({ pointCount: 1200, cellIdentity: { nOriginal: 1200 } }), '');
  const { initStatsDisplay } = await import('../assets/js/app/ui/modules/stats-display.js');
  const el = { textContent: '' };
  const { updateStats } = initStatsDisplay({ dom: { el } });
  updateStats({ field: { key: 'cell_type', kind: 'category' }, pointCount: 240, cellTotal: 1200, centroidInfo: '' });
  assert.equal(el.textContent, '240 of 1,200 cells • Field: cell_type (category)');
  updateStats({ field: null, pointCount: 1200, cellTotal: 1200 });
  assert.equal(el.textContent, '1,200 cells • Field: None');
});

test('no count is written before a plural noun it may not agree with', async () => {
  const offenders = [];
  for (const file of await sources()) {
    const lines = withoutComments(await readFile(file, 'utf8'));
    lines.forEach((line, index) => {
      const where = `${path.relative(ROOT, file)}:${index + 1}`;
      for (const [whole, expression, noun] of line.matchAll(COUNT_TEMPLATE)) {
        const value = expression.trim();
        if (LIMIT_CONSTANT.test(value) || INDEX.test(value)) continue;
        if (LABEL.test(value) && !COUNT_WORD.test(value)) continue;
        if (line.slice(0, line.indexOf(whole)).trimEnd().endsWith('×')) continue;
        offenders.push(`${where}: ${whole} (use formatCountOf or countNoun for "${noun}")`);
      }
      for (const [whole] of line.matchAll(HAND_ROLLED)) {
        offenders.push(`${where}: ${whole} (use countNoun or formatCountOf)`);
      }
    });
  }
  assert.deepEqual(offenders, []);
});

test('no number is grouped in the browser locale', async () => {
  // `toLocaleString()` with no locale writes "40.000.000" on a German or
  // Turkish machine inside English copy; counts use `formatCount` (en-US).
  const offenders = [];
  for (const file of await sources()) {
    withoutComments(await readFile(file, 'utf8')).forEach((line, index) => {
      for (const [whole, receiver] of line.matchAll(/([\w.\]\)]+)\.toLocaleString\(\)/g)) {
        // A date for a person reads in their own locale.
        if (/\b(now|date|Date)\b/.test(receiver)) continue;
        offenders.push(`${path.relative(ROOT, file)}:${index + 1}: ${whole}`);
      }
    });
  }
  assert.deepEqual(offenders, []);
});
