/**
 * A figure's physical size: the person (and
 * `figure-export.set`) gives the figure's width in millimetres or as a
 * journal column, and the figure fills it exactly at its own height; text is
 * set in points and keeps its printed size; the SVG states millimetres, a
 * PNG is the width at its DPI. One model (`utils/figure-size.js`), used by the
 * layout both renderers draw (`fillSingleViewWidth`, `fillGridWidth`,
 * `computeFigureLayout` with `height: null`) and by the preview.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeFigureLayout,
  computeGridFigureLayout,
  computeSingleViewLayout,
  fillGridWidth,
  fillSingleViewWidth,
} from '../assets/js/app/ui/modules/figure-export/utils/layout.js';
import {
  FIGURE_STANDARD_TEXT_PT,
  FIGURE_WIDTH_PRESETS,
  devicePxOf,
  figurePxOfPt,
  figureSizeText,
  figureWidthPxOf,
  mmOfFigurePx,
} from '../assets/js/app/ui/modules/figure-export/utils/figure-size.js';
import { estimateTextWidth } from '../assets/js/app/ui/modules/figure-export/utils/text-measure.js';

const CATEGORIES = ['Ductal', 'Ngn3 low EP', 'Ngn3 high EP', 'Pre-endocrine', 'Beta', 'Alpha', 'Delta', 'Epsilon'];
const categoryModel = (categories = CATEGORIES) => ({
  kind: 'category',
  categories,
  colors: new Uint8Array(categories.length * 3).fill(120),
  visible: new Uint8Array(categories.length).fill(1),
  picker: [],
  counts: null,
});
const AXES = { bounds: { minX: -8, maxX: 12, minY: -6, maxY: 9 }, xLabel: 'UMAP 1', yLabel: 'UMAP 2', tickFontPx: figurePxOfPt(6), labelFontPx: figurePxOfPt(7) };

test('one unit model: millimetres and points to figure pixels (1/96 inch), a PNG\'s pixels at its DPI', () => {
  assert.deepEqual(FIGURE_WIDTH_PRESETS, { 'single-column': 89, 'one-and-half-column': 120, 'double-column': 183 });
  assert.equal(figureWidthPxOf(183), 692);
  assert.equal(figureWidthPxOf(89), 336);
  // 180 mm is 680 figure pixels, not 1800.
  assert.equal(figureWidthPxOf(180), 680);
  assert.ok(Math.abs(mmOfFigurePx(680) - 179.92) < 0.01);
  // 7 pt is 9 1/3 figure pixels: never rounded to whole pixels.
  assert.equal(figurePxOfPt(7), 28 / 3);
  assert.equal(figurePxOfPt(FIGURE_STANDARD_TEXT_PT.title), 32 / 3);
  // A 183 mm PNG at 300 dpi is 2163 px wide: 7.2 inches.
  assert.equal(devicePxOf(692, 300), 2163);
  assert.equal(figureSizeText({ width: 692, height: 400 }, 300), '183 × 106 mm, 2163 × 1250 px at 300 dpi');
  // Whole millimetres, as columns are given: an 89 mm column is 336 figure pixels (88.9 mm).
  assert.equal(figureSizeText({ width: 336, height: 200 }), '89 × 53 mm');
  assert.equal(figureSizeText({ width: 40, height: 30 }), '10.6 × 7.9 mm');
  assert.throws(() => figureWidthPxOf(0), /positive number of millimetres/);
});

test('a single view fills the width exactly, at its own height, whatever its shape, legend and title', () => {
  let filled = 0;
  for (const [label, width] of Object.entries(FIGURE_WIDTH_PRESETS)) {
    const px = figureWidthPxOf(width);
    for (const plotAspect of [0.5, 1, 1.6, 3]) {
      for (const legendPosition of ['right', 'bottom']) {
        for (const axes of [null, AXES]) {
          const options = {
            width: px,
            plotAspect,
            title: 'Pancreas · endocrine lineage',
            titleFontSizePx: figurePxOfPt(8),
            axes,
            includeLegend: true,
            legendPosition,
            legendModel: categoryModel(),
            legendFieldKey: 'clusters',
            legendFontSizePx: figurePxOfPt(7),
            measureText: estimateTextWidth,
          };
          const layout = fillSingleViewWidth(options);
          const at = `${label} aspect ${plotAspect} legend ${legendPosition} axes ${axes !== null}`;
          // Exactly the width whenever a readable plot (80 px, 21 mm) fits it; else
          // a figure with a readable plot, wider than asked (said by the export
          // picture's notes), never a thumbnail beside an eight-column legend.
          const least = computeSingleViewLayout({ ...options, width: 80, height: Math.ceil(80 / plotAspect) });
          if (layout.totalWidth !== px) {
            assert.ok(layout.totalWidth > px && layout.plotRect.width >= 80 && layout.totalWidth <= least.totalWidth, at);
          }
          // A double column, and every legend below its plot, always fill it.
          if (label === 'double-column' || legendPosition === 'bottom') assert.equal(layout.totalWidth, px, at);
          // The plot keeps its view's shape, and its height is the figure's own.
          assert.ok(Math.abs(layout.plotRect.width / layout.plotRect.height - plotAspect) < 0.02, at);
          assert.ok(layout.totalHeight >= layout.plotRect.y + layout.plotRect.height, at);
          // The widest plot that fits: one figure pixel wider would not.
          if (layout.totalWidth === px) {
            const wider = computeSingleViewLayout({ ...options, width: layout.plotRect.width + 1, height: Math.ceil((layout.plotRect.width + 1) / plotAspect) });
            assert.ok(wider.totalWidth > px || wider.plotRect.width === layout.plotRect.width, at);
          }
          assert.equal(layout.titleRect.width, layout.totalWidth - layout.outerPadding * 2, at);
          if (layout.totalWidth === px) filled += 1;
        }
      }
    }
  }
  // Every one: a legend of eight names that would widen a short, wide plot's figure past its
  // column stands below the plot instead (`legendMovedBelow`), as a grid's legends do.
  assert.equal(filled, 48);
  const moved = fillSingleViewWidth({
    width: figureWidthPxOf(89), plotAspect: 3, includeLegend: true, legendPosition: 'right',
    legendModel: categoryModel(), legendFieldKey: 'clusters', legendFontSizePx: figurePxOfPt(7), measureText: estimateTextWidth,
  });
  assert.equal(moved.legendMovedBelow, true);
  assert.ok(moved.legendRect.y >= moved.plotRect.y + moved.plotRect.height);
  const kept = fillSingleViewWidth({
    width: figureWidthPxOf(183), plotAspect: 1, includeLegend: true, legendPosition: 'right',
    legendModel: categoryModel(), legendFieldKey: 'clusters', legendFontSizePx: figurePxOfPt(7), measureText: estimateTextWidth,
  });
  assert.equal(kept.legendMovedBelow, false);
  assert.ok(kept.legendRect.x >= kept.plotRect.x + kept.plotRect.width);
});

test('text keeps its point size at any width: the layout gives it as asked, never floored or rounded', () => {
  const at = width => fillSingleViewWidth({
    width: figureWidthPxOf(width), plotAspect: 1, title: 'T', titleFontSizePx: figurePxOfPt(8), includeLegend: true,
    legendModel: categoryModel(), legendFieldKey: 'clusters', legendFontSizePx: figurePxOfPt(7), measureText: estimateTextWidth,
  });
  for (const width of [89, 183, 400]) {
    const layout = at(width);
    assert.equal(layout.titleFontPx, figurePxOfPt(8), `${width} mm`);
    assert.equal(layout.legendPlan.fontPx, figurePxOfPt(7), `${width} mm`);
  }
});

test('a figure whose text alone is wider than asked keeps a readable plot and is as wide as it needs', () => {
  const layout = fillSingleViewWidth({
    width: figureWidthPxOf(10), plotAspect: 1, title: 'A title far wider than ten millimetres', titleFontSizePx: figurePxOfPt(8),
    includeLegend: false, measureText: estimateTextWidth,
  });
  assert.ok(layout.plotRect.width >= 37, `plot ${layout.plotRect.width}`);
  assert.ok(layout.totalWidth > figureWidthPxOf(10));
});

test('a grid fills the width exactly in the on-screen arrangement, at its own height', () => {
  const view = key => ({ scientificState: { fieldKey: key, legendModel: categoryModel() } });
  const fill = (count, columns, width) => {
    const views = Array.from({ length: count }, (_, index) => view(index % 2 === 0 ? 'a' : 'b'));
    return fillGridWidth({
      width: figureWidthPxOf(width),
      columns,
      views,
      plotAspects: views.map(() => 1.4),
      panelAxes: views.map(() => null),
      fontSize: figurePxOfPt(7),
      legendFontSizePx: figurePxOfPt(7),
      titleFontSizePx: figurePxOfPt(8),
      legendPosition: 'bottom',
      measureText: estimateTextWidth,
    });
  };
  for (const [count, columns, width] of [[2, 2, 89], [2, 1, 89], [3, 3, 183], [3, 1, 89], [4, 2, 183], [5, 3, 183]]) {
    const layout = fill(count, columns, width);
    const at = `${count} views in ${columns} columns, ${width} mm`;
    assert.equal(layout.totalWidth, figureWidthPxOf(width), at);
    assert.equal(new Set(layout.panes.map(pane => pane.plotRect.y)).size, Math.ceil(count / columns), at);
  }
  // Three panels side by side with their own legends do not fit a single
  // column at a readable size: the figure keeps readable plots and is wider.
  const crowded = fill(3, 3, 89);
  assert.ok(crowded.totalWidth > figureWidthPxOf(89));
  for (const pane of crowded.panes) assert.ok(pane.plotRect.width >= 80);
  // The arrangement is the screen's: a grid needs it given.
  assert.throws(() => computeGridFigureLayout({
    width: 600, height: 400, views: [view('a'), view('b')], plotAspects: [1, 1], panelAxes: [null, null], fontSize: 12, measureText: estimateTextWidth,
  }), /arrangement's columns/);
});

test('a payload of height null fills its width; a payload of a box fits the box (a picture of a view)', () => {
  const renderState = {
    viewportWidth: 800, viewportHeight: 500, mvpMatrix: new Float32Array(16), viewMatrix: new Float32Array(16),
  };
  const payload = height => ({
    width: figureWidthPxOf(120),
    height,
    gridColumns: 1,
    title: 'T',
    options: {
      crop: null, includeAxes: false, xLabel: '', yLabel: '', tickFontSizePx: 8, axisLabelFontSizePx: 9,
      titleFontSizePx: figurePxOfPt(8), includeLegend: false, legendPosition: 'right', legendFontSizePx: figurePxOfPt(7),
      fontFamily: 'Arial, Helvetica, sans-serif', fontSizePx: figurePxOfPt(7),
    },
    views: [{ renderState, scientificState: { dimensionLevel: 3, legendModel: null, fieldKey: null }, cameraState: null }],
    selection: { highlightArray: null, pageName: null, totalCount: 0, visibleCount: 0 },
  });
  const filled = computeFigureLayout(payload(null)).single;
  assert.equal(filled.totalWidth, figureWidthPxOf(120));
  assert.ok(Math.abs(filled.plotRect.width / filled.plotRect.height - 1.6) < 0.01);
  const boxed = computeFigureLayout(payload(100)).single;
  assert.equal(boxed.plotRect.height, 100);
});
