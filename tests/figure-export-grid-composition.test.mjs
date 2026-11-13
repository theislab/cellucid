/**
 * A multi-panel figure is a composed figure.
 *
 * Every panel's plot has one height and its view's shape, the figure is
 * exactly the composition of its panels, legends and labels at the largest
 * plot height that fits the requested box, axis margins exist only where a
 * panel has axes, and a legend's box is the box its entries need. Fitting each
 * plot inside a cell cut from the requested size, after its own legend has
 * taken its width, gives panels of different heights, tall strips in the
 * middle of a mostly empty canvas, legend frames stretched to the plot's
 * height around a few entries, and X/Y rulers on a 3-D orbit view.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { computeGridFigureLayout } from '../assets/js/app/ui/modules/figure-export/utils/layout.js';
import { estimateTextWidth } from '../assets/js/app/ui/modules/figure-export/utils/text-measure.js';

const CELL_TYPES = ['Ductal', 'Ngn3 low EP', 'Ngn3 high EP', 'Pre-endocrine', 'Beta', 'Alpha', 'Delta', 'Epsilon'];

function categoryModel(categories) {
  return {
    kind: 'category',
    categories,
    colors: new Uint8Array(categories.length * 3).fill(120),
    visible: new Uint8Array(categories.length).fill(1),
    picker: [],
    counts: null,
  };
}

function colorBar(max) {
  return { kind: 'continuous', colorbar: { min: 0, max }, colorStops: [], stats: { min: 0, max } };
}

function view(fieldKey, legendModel) {
  return { scientificState: { fieldKey, legendModel } };
}

/** What a flat 2-D panel's axes show (`AxesSpec`): UMAP coordinates. */
const AXES = { bounds: { minX: -8, maxX: 12, minY: -6, maxY: 9 }, xLabel: 'UMAP 1', yLabel: 'UMAP 2', tickFontPx: 12, labelFontPx: 12 };

/** The grid cell padding the layout uses for a 12 px label font. */
const PADDING = 8;
const OUTER = 20;

function overlaps(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Every drawn rectangle: inside the figure, disjoint from every other. */
function assertComposed(layout) {
  const rects = [];
  layout.panes.forEach((pane, index) => {
    rects.push([`plot ${index}`, pane.plotRect]);
    if (pane.legendRect) {
      rects.push([`legend ${index}`, pane.legendRect]);
      // A legend's frame is the box its entries need, not the plot's height.
      assert.equal(pane.legendRect.height, pane.legendPlan.height, `legend ${index} hugs its entries`);
      assert.equal(pane.legendRect.width, pane.legendPlan.width, `legend ${index} hugs its entries`);
    }
  });
  if (layout.sharedLegendRect) {
    rects.push(['shared legend', layout.sharedLegendRect]);
    assert.equal(layout.sharedLegendRect.height, layout.sharedLegendPlan.height);
  }
  let right = 0;
  let bottom = 0;
  for (let i = 0; i < rects.length; i++) {
    const [name, rect] = rects[i];
    assert.ok(rect.x >= OUTER && rect.y >= OUTER, `${name} inside the figure`);
    assert.ok(rect.x + rect.width <= layout.totalWidth - OUTER + 1e-9, `${name} inside the figure`);
    assert.ok(rect.y + rect.height <= layout.totalHeight - OUTER + 1e-9, `${name} inside the figure`);
    right = Math.max(right, rect.x + rect.width);
    bottom = Math.max(bottom, rect.y + rect.height);
    for (let j = i + 1; j < rects.length; j++) {
      assert.equal(overlaps(rect, rects[j][1]), false, `${name} overlaps ${rects[j][0]}`);
    }
  }
  return { right, bottom };
}

test('the two-view figure: equal panels, legends hugging their entries, no axes on 3-D, no empty canvas', () => {
  // The director's figure: two panes of a narrow window (0.43 wide for
  // tall), 3-D orbit views, legends on the right, 1400 × 800 asked for.
  const views = [view('cell_type', categoryModel(CELL_TYPES)), view('Ins1', colorBar(1260))];
  const aspect = 0.43;
  const layout = computeGridFigureLayout({ columns: views.length <= 3 ? views.length : Math.ceil(Math.sqrt(views.length)), 
    width: 1400,
    height: 800,
    views,
    plotAspects: [aspect, aspect],
    panelAxes: [null, null],
    title: 'Pancreatic endocrine cells (E15.5): cell type and Ins1 expression',
    fontSize: 12,
    legendPosition: 'right',
    measureText: estimateTextWidth,
  });
  const [a, b] = layout.panes;
  const extent = assertComposed(layout);

  // One plot size for panels of one shape, side by side at one height.
  assert.deepEqual([a.plotRect.width, a.plotRect.height], [b.plotRect.width, b.plotRect.height]);
  assert.equal(a.plotRect.y, b.plotRect.y);
  assert.ok(Math.abs(a.plotRect.width / a.plotRect.height - aspect) < 1e-9);
  // Each legend beside its plot, its top level with the plot's.
  assert.equal(a.legendSide, 'right');
  assert.equal(b.legendSide, 'right');
  assert.equal(a.legendRect.y, a.plotRect.y);
  assert.ok(a.legendRect.x > a.plotRect.x + a.plotRect.width);
  // A 3-D panel has no axis gutter: its plot starts at the cell's padding.
  assert.equal(a.plotRect.x - (a.panelRect.x - 1), PADDING);
  // The figure fits the box and is its composition: one side reaches the box
  // (the next whole plot height would not fit), and nothing pads the figure
  // past its content.
  assert.ok(layout.totalWidth <= 1400 && layout.totalHeight <= 800, `${layout.totalWidth} × ${layout.totalHeight}`);
  assert.ok(layout.totalHeight >= 800 - 1 || layout.totalWidth >= 1400 - 2, `${layout.totalWidth} × ${layout.totalHeight}`);
  assert.ok(layout.totalWidth - extent.right <= OUTER + PADDING + 1, 'no band right of the content');
  assert.ok(layout.totalHeight - extent.bottom <= OUTER + PADDING + 1, 'no band below the content');
  // The plots are the figure, not strips in the middle of a mostly empty
  // 1400 × 800 figure.
  assert.ok(a.plotRect.height > 600, `plot ${a.plotRect.width} × ${a.plotRect.height}`);
});

test('a 2 × 2 grid lines its plots up in rows and columns, axis margins only where axes are drawn', () => {
  const model = categoryModel(CELL_TYPES);
  const views = [0, 1, 2, 3].map(() => view('cell_type', structuredClone(model)));
  for (const legendPosition of ['right', 'bottom']) {
    const layout = computeGridFigureLayout({ columns: views.length <= 3 ? views.length : Math.ceil(Math.sqrt(views.length)), 
      width: 1200,
      height: 900,
      views,
      plotAspects: [1.6, 1.6, 1.6, 1.6],
      // Left column flat 2-D views with axes, right column 3-D views.
      panelAxes: [AXES, null, AXES, null],
      fontSize: 12,
      legendPosition,
      measureText: estimateTextWidth,
    });
    assertComposed(layout);
    // One shared legend: every panel agrees.
    assert.ok(layout.sharedLegendRect);
    assert.ok(layout.panes.every(pane => pane.legendRect === null));
    const [p0, p1, p2, p3] = layout.panes.map(pane => pane.plotRect);
    for (const plot of [p1, p2, p3]) assert.deepEqual([plot.width, plot.height], [p0.width, p0.height]);
    assert.equal(p0.y, p1.y);
    assert.equal(p2.y, p3.y);
    assert.equal(p0.x, p2.x);
    assert.equal(p1.x, p3.x);
    // The axis column keeps the gutter its axes need, the 3-D column none.
    assert.equal(p0.x - (layout.panes[0].panelRect.x - 1), PADDING + layout.panes[0].axes.margins.left);
    assert.equal(layout.panes[1].axes, null);
    assert.equal(p1.x - (layout.panes[1].panelRect.x - 1), PADDING);
    // The shared legend's top is level with the first row's plots, or it
    // stands below the grid.
    if (legendPosition === 'right') assert.equal(layout.sharedLegendRect.y, p0.y);
    else assert.ok(layout.sharedLegendRect.y > p2.y + p2.height);
    assert.ok(layout.totalWidth <= 1200 && layout.totalHeight <= 900);
  }
});

test('views of different shapes share one plot height, each at its own width', () => {
  const views = [view(null, null), view(null, null)];
  const layout = computeGridFigureLayout({ columns: views.length <= 3 ? views.length : Math.ceil(Math.sqrt(views.length)), 
    width: 1200,
    height: 600,
    views,
    plotAspects: [1.6, 0.8],
    panelAxes: [null, null],
    fontSize: 12,
    measureText: estimateTextWidth,
  });
  assertComposed(layout);
  const [a, b] = layout.panes.map(pane => pane.plotRect);
  assert.equal(a.height, b.height);
  assert.equal(a.y, b.y);
  assert.ok(Math.abs(a.width - 2 * b.width) < 1e-9);
  // A larger box gives larger plots; a smaller one smaller plots.
  const larger = computeGridFigureLayout({ columns: views.length <= 3 ? views.length : Math.ceil(Math.sqrt(views.length)),  width: 2400, height: 1200, views, plotAspects: [1.6, 0.8], panelAxes: [null, null], fontSize: 12, measureText: estimateTextWidth });
  assert.ok(larger.plotHeight > layout.plotHeight);
});

test('a long legend gets its room without shrinking the plots to thumbnails', () => {
  const long = categoryModel(Array.from({ length: 69 }, (_, index) => `Cell type with a long name ${index + 1}`));
  const views = [view('cell_type', long), view('organ', categoryModel(['Blood', 'Liver', 'Skin']))];
  const bare = computeGridFigureLayout({ columns: views.length <= 3 ? views.length : Math.ceil(Math.sqrt(views.length)), 
    width: 720,
    height: 500,
    views,
    plotAspects: [1.6, 1.6],
    panelAxes: [AXES, AXES],
    includeLegend: false,
    fontSize: 12,
    measureText: estimateTextWidth,
  });
  for (const legendPosition of ['right', 'bottom']) {
    const layout = computeGridFigureLayout({ columns: views.length <= 3 ? views.length : Math.ceil(Math.sqrt(views.length)), 
      width: 720,
      height: 500,
      views,
      plotAspects: [1.6, 1.6],
      panelAxes: [AXES, AXES],
      fontSize: 12,
      legendPosition,
      measureText: estimateTextWidth,
    });
    assertComposed(layout);
    // The 69 names do not fit beside a plot no wider than they are: below.
    assert.equal(layout.panes[0].legendSide, 'below');
    // The plots keep at least half the height the box gives them bare, and
    // the figure grows for the legend instead.
    assert.ok(layout.plotHeight >= Math.ceil(bare.plotHeight / 2), `${layout.plotHeight} of ${bare.plotHeight}`);
    assert.ok(layout.totalHeight > 500);
    assert.equal(layout.panes[0].plotRect.height, layout.panes[1].plotRect.height);
  }
});

test('a grid figure is refused panels without an axes decision', () => {
  const views = [view(null, null)];
  assert.throws(
    () => computeGridFigureLayout({ columns: views.length <= 3 ? views.length : Math.ceil(Math.sqrt(views.length)),  width: 400, height: 300, views, plotAspects: [1], fontSize: 12, measureText: estimateTextWidth }),
    /what each panel's axes show/
  );
  assert.throws(
    () => computeGridFigureLayout({ columns: views.length <= 3 ? views.length : Math.ceil(Math.sqrt(views.length)),  width: 400, height: 300, views, plotAspects: [0], panelAxes: [null], fontSize: 12, measureText: estimateTextWidth }),
    /finite positive/
  );
});

test('the panel legends stand where the plots get the most room, and the figure keeps to the box', () => {
  // He, two views: LVL2 kept to the epithelial cells (11 of 42 types with
  // cells: the legend lists those) and LVL0. Decided against the plot the grid
  // has without legends, a legend would stand beside a plot the legends then
  // shrink, and be planned again beside the shorter plot in more columns:
  // strips beside legends wider than the figure's box, and a figure wider
  // than the box.
  const lvl2 = Array.from({ length: 42 }, (_, i) => (i < 11 ? `Lung_epithelial_type_${i}` : `Other_type_${i}`));
  const lvl2Model = { ...categoryModel(lvl2), counts: { available: lvl2.map((_, i) => (i < 11 ? 10 : 0)), visible: lvl2.map((_, i) => (i < 11 ? 10 : 0)) } };
  const views = [view('LVL2', lvl2Model), view('LVL0', categoryModel(['Endothelial', 'Epithelial', 'Haematopoeitic_lineage', 'Neuronal_and_Glial', 'Stromal']))];
  const layoutOf = (width, height, aspect) => computeGridFigureLayout({ columns: views.length <= 3 ? views.length : Math.ceil(Math.sqrt(views.length)), 
    width, height, views, plotAspects: [aspect, aspect], panelAxes: [null, null],
    title: 'Developing human lung (He)', fontSize: 12, legendPosition: 'right', measureText: estimateTextWidth,
  });
  for (const [width, height, aspect, least] of [[800, 600, 1.6, 360], [1200, 800, 1.6, 560], [622, 1065, 375 / 860, 250], [1200, 800, 375 / 860, 280]]) {
    const layout = layoutOf(width, height, aspect);
    const label = `${width} × ${height}, aspect ${aspect.toFixed(2)}`;
    assert.ok(layout.totalWidth <= width && layout.totalHeight <= height, `${label}: ${layout.totalWidth} × ${layout.totalHeight} keeps to the box`);
    assert.ok(layout.panes[0].plotRect.width >= least, `${label}: plots ${Math.round(layout.panes[0].plotRect.width)} px wide`);
    assert.equal(layout.panes[0].legendPlan.entries.length, 11, 'the legend lists the types with cells');
    // No legend is a wall of columns beside a plot shorter than its entries.
    for (const pane of layout.panes) {
      if (pane.legendSide === 'right') assert.ok(pane.legendRect.width <= Math.max(pane.plotRect.width, 300), `${label}: legend ${pane.legendRect.width} px beside a ${Math.round(pane.plotRect.width)} px plot`);
    }
    assertComposed(layout);
  }
});
