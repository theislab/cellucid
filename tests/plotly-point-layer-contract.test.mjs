/**
 * The vendored Plotly's point layer (`_cellucidPointLayer`; see the header of
 * assets/external/plotly.min.js): box and violin points, and a scatter
 * trace's markers, are handed to the layer instead of becoming SVG paths;
 * hover reads the positions the layer lays out (point-layout.js mirrors
 * Plotly's point loop); a box or violin of every value keeps its sorted values
 * as one array. The bundle must carry each patched spot
 * exactly once and none of the upstream text it replaced.
 * tests/browser/analysis-point-layer-identity.spec.mjs compares the positions
 * and the hover with Plotly's SVG points in the real engine.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const BUNDLE = readFileSync(new URL('../assets/external/plotly.min.js', import.meta.url), 'utf8');

const once = (text, label) => {
  const first = BUNDLE.indexOf(text);
  assert.notEqual(first, -1, `${label} is present`);
  assert.equal(BUNDLE.indexOf(text, first + 1), -1, `${label} is present once`);
};

test('every point-layer patch is present once and the upstream text it replaced is gone', () => {
  once('function cellucidPointLayer(t,e,r,n,o,s,c,D){', 'the point hand-off');
  once('if(r._input&&r._input._cellucidPointLayer){var D=0;return void f.each((function(t){D+=cellucidPointLayer(this,t,r,n,o,s,c,D)}))}', 'the layer branch of plotPoints');
  once('function cellucidNearestPoint(o,h,c,f,p,d,D){', 'the typed hover');
  once('if((o=u[y])._cellucidPos){var Q=cellucidNearestPoint(o,h,c,f,p,d,t.distance);', 'the hover branch');
  once('l=-1===g[1]?(o=u[g[0]])._cellucidHover:(o=u[g[0]]).pts[g[1]];', 'the hovered point');
  once('o._input&&o._input._cellucidPointLayer&&o._input._cellucidPointLayer.restyle(this,o)', 'the box restyle');
  once('r._input&&r._input._cellucidPointLayer&&r._input._cellucidPointLayer.restyle(this,r)', 'the violin restyle');
  once('function cellucidSortedPoints(e,U,r){', 'the box typed points');
  once('L=[],!(E._cellucidVals=cellucidSortedPoints(e,U,r))&&U&&o.isArrayOrTypedArray(U[r]))', 'the box calc guard');
  once('E._cellucidVals=e._input._cellucidPointLayer&&"all"===(e.boxpoints||e.points)&&0===P.pts.length?P.sorted:void 0,', 'the violin typed points');
  assert.equal(BUNDLE.includes('o=u[y];for(var m=0;m<(o.pts||[]).length;m++)'), false);
  assert.equal(BUNDLE.includes('L=[],U&&o.isArrayOrTypedArray(U[r]))for('), false);
  assert.equal(BUNDLE.includes('if(E.pts=L.sort(f),P=(C=E[x]=L.map(h)).length,'), false);
  once('if(!Array.isArray(l)&&l&&"object"==typeof l&&!a(l))for(r=0;r<i.length;r++)o.clean(i[r])', 'Color.clean skips typed arrays');
  once('f&&c._input&&c._input._cellucidPointLayer&&(c._input._cellucidPointLayer.drawScatter(e.node(),{points:d(a),trace:c,xa:b,ya:_,fns:l.makePointStyleFns(c)}),d=rt);', 'the scatter point layer');
  once('r._input&&r._input._cellucidPointLayer&&r._input._cellucidPointLayer.restyleScatter(this,r,i.makePointStyleFns(r))', 'the scatter restyle');
  assert.equal(BUNDLE.includes('if(!Array.isArray(l)&&l&&"object"==typeof l)for(r=0;r<i.length;r++)o.clean(i[r])'), false);
});

test('the layer is handed everything the upstream point loop reads', () => {
  const start = BUNDLE.indexOf('function cellucidPointLayer(');
  const source = BUNDLE.slice(start, BUNDLE.indexOf('function s(t,e,r,n){', start));
  // Upstream reads t.max, t.min, t.q1, t.q3, t.lf, t.uf, t.lo, t.uo, t.pos,
  // r.jitter, r.pointpos, n.bPos, n.bdPos and the points mode.
  for (const field of ['min:e.min', 'max:e.max', 'q1:e.q1', 'q3:e.q3', 'lf:e.lf', 'uf:e.uf', 'lo:e.lo', 'uo:e.uo', 'pos:e.pos',
    'jitter:r.jitter', 'pointpos:r.pointpos', 'bPos:n.bPos', 'bdPos:n.bdPos', 'mode:c', 'drawsBefore:D']) {
    assert.ok(source.includes(field), field);
  }
  // The upstream loop the layout mirrors (point-layout.js) is unchanged.
  assert.ok(BUNDLE.includes('var m=Math.sqrt(f*(g-d)/(y-v+s))||0;m=i.constrain(Math.abs(m),0,1),h.push(m),p=Math.max(m,p)}n=2*r.jitter/(p||1)}'));
  assert.ok(BUNDLE.includes('_=r.jitter?n*h[e]*(i.pseudoRandom()-.5):0,w=t.pos+u+l*(r.pointpos+_)'));
  // The seed is reset once per trace, before the layer branch, and only box
  // and violin points draw from it.
  const plotPoints = BUNDLE.slice(BUNDLE.indexOf('function s(t,e,r,n){var o=e.x,s=e.y'), BUNDLE.indexOf('D+=cellucidPointLayer('));
  assert.ok(plotPoints.includes('i.seedPseudoRandom();'));
  assert.equal(BUNDLE.split('pseudoRandom()').length - 1, 2, 'pseudoRandom is drawn by its own recursion and the box point loop only');
});

test('the layout draws Plotly\'s pseudo-random sequence', async () => {
  const { plotlyPseudoRandom } = await import('../assets/js/app/analysis/plots/point-layout.js');
  const source = BUNDLE.slice(BUNDLE.indexOf('var V=2e9;f.seedPseudoRandom='), BUNDLE.indexOf(',f.fillText=function'));
  const f = {};
  new Function('f', source)(f);
  f.seedPseudoRandom();
  const mine = plotlyPseudoRandom();
  for (let i = 0; i < 100000; i++) assert.equal(mine(), f.pseudoRandom(), `draw ${i}`);
});
