/**
 * Categorical tick labels are thinned to the drawn box, and only ever dropped.
 *
 * A category axis draws every category it is handed. In the sidebar preview
 * that put eighteen cell-type names on top of one another; measured through the
 * real renderer, ten pairs of labels genuinely overlapped at 224×180 while the
 * same eighteen fitted at 720×380 (`tests/browser/analysis-plot-label-collisions.spec.mjs`).
 * So the crowding is a function of the box, and the fit belongs where the box
 * is known — `PlotFactory.render`, not `buildLayout`.
 *
 * The invariants below are the ones that make thinning safe rather than merely
 * quieter: a dropped label is never a rewritten label, `tickvals` and
 * `ticktext` are thinned by the same indices so an axis that shortened its own
 * labels keeps them shortened, both ends of the axis stay anchored, and a plot
 * rendered into a container with no measurable box is left exactly as its type
 * built it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { PlotFactory } from '../assets/js/app/analysis/plots/plot-factory.js';

const CATEGORIES = [
  'Erythroid progenitor', 'Megakaryocyte', 'Pro-B cell', 'Pre-B cell',
  'Naive B cell', 'Memory B cell', 'CD4 T cell', 'CD8 T cell',
  'Regulatory T cell', 'NK cell', 'Classical monocyte',
  'Non-classical monocyte', 'Plasmacytoid DC', 'Conventional DC',
  'Neutrophil', 'Eosinophil', 'Basophil', 'Mast cell',
];

function barLayout() {
  return {
    margin: { l: 55, r: 20, t: 40, b: 55 },
    xaxis: { title: '', tickangle: -45, automargin: true, tickfont: { size: 11 } },
    yaxis: { title: 'Count', type: 'linear' },
  };
}

function barTraces() {
  return [{
    type: 'bar',
    x: [...CATEGORIES],
    y: CATEGORIES.map((_, index) => index + 1),
  }];
}

const SIDEBAR = { clientWidth: 224, clientHeight: 180 };
const EXPANDED = { clientWidth: 720, clientHeight: 380 };

test('a narrow box keeps fewer category labels, and only real ones', () => {
  const layout = barLayout();
  PlotFactory.fitCategoricalTickLabels(layout, barTraces(), SIDEBAR);

  assert.equal(layout.xaxis.tickmode, 'array');
  assert.ok(
    layout.xaxis.tickvals.length < CATEGORIES.length,
    'a 224-pixel axis cannot show eighteen cell-type names',
  );
  assert.ok(layout.xaxis.tickvals.length >= 3);
  for (const value of layout.xaxis.tickvals) {
    assert.ok(
      CATEGORIES.includes(value),
      `tick ${JSON.stringify(value)} is not one of the categories; labels may `
        + 'be dropped but never rewritten',
    );
  }
  assert.equal(layout.xaxis.tickvals[0], CATEGORIES[0]);
  assert.equal(
    layout.xaxis.tickvals.at(-1),
    CATEGORIES.at(-1),
    'both ends of the axis stay anchored',
  );
  assert.deepEqual(
    layout.xaxis.tickvals,
    layout.xaxis.ticktext,
    'an axis that never shortened its labels draws them as they are',
  );
});

test('a box with room is left alone', () => {
  const layout = barLayout();
  PlotFactory.fitCategoricalTickLabels(layout, barTraces(), EXPANDED);

  assert.equal(
    layout.xaxis.tickmode,
    undefined,
    'eighteen labels fit at 720 pixels, so nothing should be selected away',
  );
  assert.equal(layout.xaxis.tickvals, undefined);
});

test('thinning an already-selected axis keeps its shortened text', () => {
  // The gene heatmap picks its own ticks and draws middle-ellipsis labels, so
  // `ticktext` is deliberately not equal to `tickvals`. Thinning must carry the
  // pairing through rather than redrawing the full-length coordinates.
  const genes = Array.from({ length: 40 }, (_, index) => `LONGGENENAME${index}`);
  const shortened = genes.map(gene => `${gene.slice(0, 5)}…${gene.slice(-3)}`);
  const layout = {
    margin: { l: 55, r: 20, t: 40, b: 55 },
    xaxis: {
      tickangle: -35,
      tickfont: { size: 9 },
      tickmode: 'array',
      tickvals: [...genes],
      ticktext: [...shortened],
    },
  };

  PlotFactory.fitCategoricalTickLabels(layout, [{ type: 'heatmap', x: genes }], SIDEBAR);

  assert.ok(layout.xaxis.tickvals.length < genes.length);
  assert.equal(layout.xaxis.tickvals.length, layout.xaxis.ticktext.length);
  for (const [index, value] of layout.xaxis.tickvals.entries()) {
    assert.equal(
      layout.xaxis.ticktext[index],
      shortened[genes.indexOf(value)],
      `tick ${value} lost the shortened text the plot type chose for it`,
    );
  }
});

test('a categorical y axis is thinned by height, not by width', () => {
  const layout = {
    margin: { l: 100, r: 60, t: 30, b: 60 },
    yaxis: { title: '', automargin: true, tickfont: { size: 10 } },
  };
  const rows = Array.from({ length: 60 }, (_, index) => `Cluster ${index}`);

  PlotFactory.fitCategoricalTickLabels(
    layout,
    [{ type: 'heatmap', y: rows }],
    SIDEBAR,
  );

  assert.equal(layout.yaxis.tickmode, 'array');
  assert.ok(
    layout.yaxis.tickvals.length < rows.length,
    'sixty rows cannot be labelled down a 180-pixel host',
  );
  assert.equal(layout.yaxis.tickvals[0], rows[0]);
  assert.equal(layout.yaxis.tickvals.at(-1), rows.at(-1));
});

test('repeated categories are counted once', () => {
  // Box and violin traces publish one x per observation, not one per category.
  const observations = [];
  for (const category of CATEGORIES) {
    for (let repeat = 0; repeat < 25; repeat++) observations.push(category);
  }
  const layout = barLayout();
  PlotFactory.fitCategoricalTickLabels(
    layout,
    [{ type: 'box', x: observations, y: observations.map((_, i) => i) }],
    EXPANDED,
  );

  assert.equal(
    layout.xaxis.tickmode,
    undefined,
    'eighteen distinct categories fit; 450 observations are not 450 labels',
  );
});

test('a container with no measurable box changes nothing', () => {
  for (const container of [{}, null, undefined, { clientWidth: 0, clientHeight: 0 }]) {
    const layout = barLayout();
    const before = structuredClone(layout);
    PlotFactory.fitCategoricalTickLabels(layout, barTraces(), container);
    assert.deepEqual(
      layout,
      before,
      'an unmeasured host must not have its axes rewritten by a guess',
    );
  }
});

test('a numeric axis is left to Plotly', () => {
  const layout = {
    margin: { l: 55, r: 20, t: 40, b: 55 },
    xaxis: { title: 'log₂ Fold Change', tickfont: { size: 10 } },
  };
  const before = structuredClone(layout);

  PlotFactory.fitCategoricalTickLabels(
    layout,
    [{ type: 'scatter', x: [1, 2, 3, 4, 5], y: [5, 4, 3, 2, 1] }],
    SIDEBAR,
  );

  assert.deepEqual(layout, before);
});
