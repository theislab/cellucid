/**
 * CEL-0217 — a categorical axis is anchored at both ends, or not thinned at all.
 *
 * `PlotFactory.fitCategoricalTickLabels` documents that "the first and the last
 * are always kept so the axis stays anchored at both ends". It did not hold at
 * the narrowest end of its own range: `horizontalTickCapacity` floors its answer
 * at one, and `spreadTickIndices(length, 1)` returns `[0]`, so the last label was
 * dropped and the axis was anchored at one end only.
 *
 * `tests/analysis-plot-tick-fit-contract.test.mjs` cannot see this. Its fixture
 * is eighteen cell-type names, and eighteen categories make
 * `PlotFactory.configureCategoricalAxes` rotate the axis (`tickangle: -45` above
 * eight categories), which multiplies the capacity; it then asserts only that at
 * least three labels survive. A fixture that cannot reach the branch proves
 * nothing about it.
 *
 * The published pancreas dataset reaches it exactly. `cell_type` and `clusters`
 * each hold eight categories — one short of the rotation threshold — so the axis
 * is drawn upright, and the longest name, `Pre-endocrine`, needs
 * 13 × 11 × 0.58 + 6 ≈ 89 px of slot. The sidebar preview measures 224 px wide
 * and the base layout reserves l:55 r:20, leaving 149 px: capacity one. The
 * committed screenshot
 * `cellucid-python/docs/_static/screenshots/analysis/detailed-categorical.png`
 * shows the result — eight bars under a single tick reading `Ductal`.
 *
 * The geometry is why the floor is two rather than a qualified invariant. The
 * capacity model tiles fixed-width slots across the axis, but the thinner draws
 * at category positions: two labels at the ends of an eight-band axis sit
 * (7/8) × 149 ≈ 130 px apart, while `Ductal` and `Epsilon` need 41 px between
 * their centres to clear each other. Anchoring both ends is not a crowded
 * compromise here; it is three times the room the pair needs.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { PlotFactory } from '../assets/js/app/analysis/plots/plot-factory.js';

// exports/pancreas/obs_manifest.json, fields `clusters` and `cell_type`.
const PANCREAS_CELL_TYPES = [
  'Ductal', 'Ngn3 low EP', 'Ngn3 high EP', 'Pre-endocrine',
  'Beta', 'Alpha', 'Delta', 'Epsilon',
];

const SIDEBAR = { clientWidth: 224, clientHeight: 180 };

/** What `barplot.buildLayout` produces for these eight categories. */
function pancreasBarLayout() {
  return {
    margin: { l: 55, r: 20, t: 40, b: 55 },
    xaxis: {
      title: '',
      // PlotFactory.configureCategoricalAxes: rotation starts above eight.
      tickangle: PANCREAS_CELL_TYPES.length > 8 ? -45 : 0,
      automargin: true,
    },
    yaxis: { title: 'Count', type: 'linear' },
  };
}

function pancreasBarTraces() {
  return [{
    type: 'bar',
    x: [...PANCREAS_CELL_TYPES],
    y: [916, 262, 642, 592, 591, 481, 70, 142],
  }];
}

test('the pancreas bar plot really does reach a capacity of one', () => {
  // Guards the fixture itself: if the box, the font, the margins or the
  // rotation rule move, this fixture stops exercising the branch it exists for
  // and the assertions below would pass without meaning anything.
  const layout = pancreasBarLayout();
  assert.equal(layout.xaxis.tickangle, 0, 'eight categories are drawn upright');
  assert.equal(
    PlotFactory.horizontalTickCapacity({
      available: SIDEBAR.clientWidth - layout.margin.l - layout.margin.r,
      labels: PANCREAS_CELL_TYPES,
      fontSize: 11,
      tickangle: layout.xaxis.tickangle,
    }),
    1,
    'the sidebar fits one upright pancreas cell-type name',
  );
});

test('a capacity of one still anchors both ends of the axis', () => {
  const layout = pancreasBarLayout();
  PlotFactory.fitCategoricalTickLabels(layout, pancreasBarTraces(), SIDEBAR);

  assert.equal(layout.xaxis.tickmode, 'array');
  assert.equal(
    layout.xaxis.tickvals.at(-1),
    PANCREAS_CELL_TYPES.at(-1),
    'the far end of the axis was left unlabelled, so the axis is anchored at '
      + 'one end only — which is what the function says it never does',
  );
  assert.equal(layout.xaxis.tickvals[0], PANCREAS_CELL_TYPES[0]);
  assert.equal(layout.xaxis.tickvals.length, 2);
  assert.deepEqual(layout.xaxis.tickvals, layout.xaxis.ticktext);
  for (const value of layout.xaxis.tickvals) {
    assert.ok(
      PANCREAS_CELL_TYPES.includes(value),
      `tick ${JSON.stringify(value)} is not one of the categories`,
    );
  }
});

test('a categorical y axis crushed to one row keeps both ends too', () => {
  // The vertical capacity has the same floor, reached when the host is short
  // rather than narrow.
  const rows = ['Ductal', 'Ngn3 low EP', 'Ngn3 high EP', 'Pre-endocrine'];
  const layout = {
    margin: { l: 100, r: 20, t: 30, b: 30 },
    yaxis: { title: '', automargin: true, tickfont: { size: 11 } },
  };

  PlotFactory.fitCategoricalTickLabels(
    layout,
    [{ type: 'heatmap', y: rows }],
    { clientWidth: 224, clientHeight: 78 },
  );

  assert.equal(layout.yaxis.tickmode, 'array');
  assert.equal(layout.yaxis.tickvals[0], rows[0]);
  assert.equal(
    layout.yaxis.tickvals.at(-1),
    rows.at(-1),
    'a short host anchors both ends exactly as a narrow one does',
  );
});

test('an axis with a single category keeps its one label', () => {
  // The only axis that can honestly carry one tick is the one that has one
  // category: both of its ends are the same band.
  const layout = {
    margin: { l: 55, r: 20, t: 40, b: 55 },
    xaxis: { title: '', tickangle: 0, automargin: true },
  };
  const only = ['A single very long pancreatic cell type name'];

  PlotFactory.fitCategoricalTickLabels(
    layout,
    [{ type: 'bar', x: [...only], y: [1] }],
    SIDEBAR,
  );

  assert.equal(
    layout.xaxis.tickmode,
    undefined,
    'one label is never more than the axis was asked to draw',
  );
});

test('spreadTickIndices never leaves the far end unlabelled', () => {
  // The documented contract of the helper itself: "`count` indices spread
  // evenly across `length`, first and last included."
  for (const count of [2, 3, 5, 7]) {
    const indices = PlotFactory.spreadTickIndices(8, count);
    assert.equal(indices[0], 0, `count ${count} lost the first index`);
    assert.equal(indices.at(-1), 7, `count ${count} lost the last index`);
  }
});
