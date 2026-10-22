/**
 * The vendored Plotly's precomputed violin calc (`_precomputedViolin`; see the
 * header of assets/external/plotly.min.js). The bundle must carry each patched
 * spot exactly once and none of the upstream text it replaced, the fast path
 * must be guarded by every condition under which Plotly's own calc would build
 * a different entry, and the entry it returns must be the fields Plotly's raw
 * box calc sets. tests/browser/analysis-violin-precomputed-identity.spec.mjs
 * compares the two calcs' output in each engine.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { plotlyViolinBox, sortLikePlotly } from '../assets/js/app/analysis/plots/plotly-box-statistics.js';

const BUNDLE = readFileSync(new URL('../assets/external/plotly.min.js', import.meta.url), 'utf8');

const once = (text, label) => {
  const first = BUNDLE.indexOf(text);
  assert.notEqual(first, -1, `${label} is present`);
  assert.equal(BUNDLE.indexOf(text, first + 1), -1, `${label} is present once`);
};

test('every patched spot is present once and the upstream text it replaced is gone', () => {
  once('if(e._input&&e._input._precomputedViolin&&"violin"===e.type&&!w&&"linear"===e.quartilemethod&&_+"0"in e&&!(_ in e)&&!("d"+_ in e)&&e._input._precomputedViolin.sorted.length===e._length)return cellucidPrecomputedViolin(t,e,m,x,b,_,T,S);', 'the guarded fast path');
  once('function cellucidPrecomputedViolin(t,e,m,x,b,_,T,S){', 'the precomputed calc');
  once('y=g._vals||g.pts.map(o.extractVal)', 'the violin calc reader');
  once('var i=t._vals||t.pts.map(e.extractVal);', 'the KDE hover reader');
  once('M.maxCount/(t._vals||t.pts).length', 'the count scaling reader');
  once('o=void 0!==e._sampleSd?e._sampleSd:n.stdev(r,a-1,e.mean)', 'the bandwidth deviation reader');
  assert.equal(BUNDLE.includes('y=g.pts.map(o.extractVal)'), false);
  assert.equal(BUNDLE.includes('var i=t.pts.map(e.extractVal);'), false);
  assert.equal(BUNDLE.includes('M.maxCount/t.pts.length'), false);
  assert.equal(BUNDLE.includes('var a=r.length,o=n.stdev(r,a-1,e.mean);'), false);
});

test('the precomputed calc sets the fields of the raw box calc, from the entry given', () => {
  const start = BUNDLE.indexOf('function cellucidPrecomputedViolin(');
  const source = BUNDLE.slice(start, BUNDLE.indexOf('function c(t,e,r){', start));
  for (const field of ['pos', 'pts', 'min', 'max', 'mean', 'sd', 'med', 'q1', 'q3', 'lf', 'uf', 'lo', 'uo', 'ln', 'un', 'pts2']) {
    assert.match(source, new RegExp(`E\\.${field}=`), field);
  }
  // Plotly multiplies the standard deviation by the trace's sdmultiple, which
  // violins do not define: the raw calc's sd is NaN, and so is this one's.
  assert.match(source, /E\.sd=g\.sd\*e\.sdmultiple/);
  // The raw calc's labels, verbatim.
  const raw = BUNDLE.slice(BUNDLE.indexOf('48518:function(t,e,r)'), start);
  const labels = 'labels:{med:l(t,"median:"),min:l(t,"min:"),q1:l(t,"q1:"),q3:l(t,"q3:"),max:l(t,"max:"),mean:"sd"===e.boxmean||"sd"===e.sizemode?l(t,"mean ± σ:").replace("σ",1===e.sdmultiple?"σ":e.sdmultiple+"σ"):l(t,"mean:"),lf:l(t,"lower fence:"),uf:l(t,"upper fence:")}';
  assert.ok(raw.includes(labels) && source.includes(labels));
});

test('plotlyViolinBox draws the outliers, at most 16 copies of a value, with their indices', () => {
  const values = Float64Array.from([...Array(40).fill(0), ...Array(30).fill(2), 1, 1.5, 50, ...Array(20).fill(60)]);
  const sorted = sortLikePlotly(values);
  const box = plotlyViolinBox(sorted, 'outliers');
  assert.equal(box.min, 0);
  assert.equal(box.max, 60);
  const drawn = box.pts.map(p => p.v);
  assert.deepEqual([...new Set(drawn)], [50, 60]);
  assert.equal(drawn.filter(v => v === 60).length, 16);
  for (const { v, i } of box.pts) assert.equal(sorted[i], v);
  assert.deepEqual(plotlyViolinBox(sorted, 'none').pts, []);
  assert.throws(() => plotlyViolinBox(sorted, 'all'), /outliers or no points/);
  assert.throws(() => plotlyViolinBox(values.subarray(0, 0), 'none'), /at least one value/);
});
