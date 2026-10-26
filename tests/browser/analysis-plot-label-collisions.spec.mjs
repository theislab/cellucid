/**
 * No analysis plot may draw one label on top of another, at any surface size.
 *
 * The sidebar preview and the expanded overlay are the same plot code given two
 * very different boxes. Text placed with a constant that happens to work in one
 * box lands on top of something in the other, and the result reads to a user as
 * a rendering bug rather than as a layout constant that was never checked.
 *
 * Two collisions this pins down, both reported against the committed
 * documentation screenshots:
 *
 * 1. The volcano plot's x-axis title `log₂ Fold Change` was drawn across the
 *    `Down (n)` entry of its own legend, in the sidebar preview and in the
 *    expanded overlay alike. The legend sat at `y: -0.14` — a fraction of the
 *    plot area's height — while Plotly places a bottom axis title within the
 *    bottom margin, which is a fixed pixel band. Two independent offsets into
 *    one band collide as soon as the box changes size.
 *
 * 2. Categorical tick labels ran into each other in the 224-pixel sidebar
 *    preview: every category was drawn however many of them there were. Ten
 *    pairs genuinely overlapped at 224×180 and none at 720×380, so the axis is
 *    thinned to what the drawn box can hold rather than to a fixed count.
 *
 * 3. The dot plot's size legend title ran into its colour bar in the sidebar
 *    preview, its dots into each other in the expanded view, and its gene names
 *    into each other where the panel was narrow: the legends were placed in
 *    fractions of a plot area whose height the preview does not fix.
 *
 * 4. The correlation plot's per-page R² boxes were stacked 15% of the plot's
 *    height apart, less than one box is tall, so the second covered the first
 *    in the two-page preview and in the expanded view, and they ran under the
 *    legend in a narrow panel.
 *
 * Every plot laid out for its size is laid out again when it is resized
 * (`plots/size-fit.js`), so the checks also resize a drawn plot.
 *
 * The acceptance is geometric, measured from the rendered SVG rather than from
 * the layout object that was supposed to produce it. Tick labels are compared
 * as rotated quadrilaterals: an axis-aligned rectangle around diagonal text
 * reports overlaps that no reader can see, and a check built on that would
 * demand a thinning far more aggressive than the glyphs need.
 */
import { expect, test } from './helpers/test.mjs';
import { openPlotHarness } from './helpers/plot-harness.mjs';


/**
 * The two boxes an analysis plot is drawn into.
 *
 * `sidebar` is the accordion preview: `--analysis-panel-width` minus its
 * padding, at the preview height the form-based UIs request. `expanded` is the
 * overlay's plot pane at the 860-pixel viewport the screenshots were taken at.
 */
const SURFACES = Object.freeze([
  Object.freeze({ name: 'sidebar', width: 224, height: 180 }),
  Object.freeze({ name: 'expanded', width: 720, height: 380 }),
]);

/** Deterministic differential-expression results: 40 up, 70 down, 150 neutral. */
function volcanoResults() {
  const results = [];
  for (let index = 0; index < 40; index++) {
    results.push({
      gene: `UP${index}`,
      log2FoldChange: 1.5 + (index % 7) * 0.4,
      pValue: 1e-8 * (index + 1),
      adjustedPValue: 1e-7 * (index + 1),
    });
  }
  for (let index = 0; index < 70; index++) {
    results.push({
      gene: `DOWN${index}`,
      log2FoldChange: -1.5 - (index % 9) * 0.35,
      pValue: 1e-6 * (index + 1),
      adjustedPValue: 1e-5 * (index + 1),
    });
  }
  for (let index = 0; index < 150; index++) {
    results.push({
      gene: `NS${index}`,
      log2FoldChange: (index % 5) * 0.1 - 0.2,
      pValue: 0.2 + (index % 40) * 0.01,
      adjustedPValue: 0.4 + (index % 40) * 0.01,
    });
  }
  return results;
}

const VOLCANO_OPTIONS = Object.freeze({
  pValueThreshold: 0.05,
  foldChangeThreshold: 1,
  useAdjustedPValue: true,
  labelTopN: 15,
  pointSize: 6,
  showThresholdLines: true,
  highlightGenes: [],
  colorScheme: 'default',
  legendPosition: 'auto',
});

/**
 * Render one plot type into a host of an exact size and measure its text.
 *
 * Returns the bounding boxes, in host-relative pixels, of the x-axis title, the
 * legend, and every x tick label that Plotly actually drew.
 */
async function measurePlot(page, { modulePath, data, options, width, height }) {
  return await page.evaluate(
    async ({ modulePath: path, data: plotData, options: plotOptions, width: w, height: h }) => {
      const host = document.getElementById('plot-host');
      host.style.width = `${w}px`;
      host.style.height = `${h}px`;
      host.replaceChildren();

      const definition = (await import(path)).default;
      await definition.render(plotData, plotOptions, host);

      const hostBox = host.getBoundingClientRect();
      const relative = element => {
        const box = element.getBoundingClientRect();
        return {
          left: box.left - hostBox.left,
          right: box.right - hostBox.left,
          top: box.top - hostBox.top,
          bottom: box.bottom - hostBox.top,
        };
      };
      const boxOf = selector => {
        const element = host.querySelector(selector);
        return element === null ? null : relative(element);
      };

      // Tick labels are rotated, so an axis-aligned rectangle is the wrong
      // shape to compare: two diagonal labels can have overlapping enclosing
      // rectangles while no glyph of one touches a glyph of the other. Each
      // label is returned as the four corners of its own box carried through
      // its own transform, which is the shape the reader actually sees.
      const cornersOf = node => {
        const box = node.getBBox();
        // `getScreenCTM` maps the element's own coordinates to viewport CSS
        // pixels — the same space `getBoundingClientRect` reports — so the host
        // origin is subtracted rather than inverted through a second matrix.
        const matrix = node.getScreenCTM();
        return [
          [box.x, box.y],
          [box.x + box.width, box.y],
          [box.x + box.width, box.y + box.height],
          [box.x, box.y + box.height],
        ].map(([x, y]) => ({
          x: (matrix.a * x) + (matrix.c * y) + matrix.e - hostBox.left,
          y: (matrix.b * x) + (matrix.d * y) + matrix.f - hostBox.top,
        }));
      };

      const tickNodes = [...host.querySelectorAll('.xaxislayer-above .xtick text')];
      return {
        host: { width: hostBox.width, height: hostBox.height },
        axisTitle: boxOf('.g-xtitle'),
        legend: boxOf('.legend'),
        ticks: tickNodes.map(node => ({
          text: node.textContent,
          corners: cornersOf(node),
        })),
      };
    },
    { modulePath, data, options, width, height }
  );
}

function overlaps(first, second) {
  if (first === null || second === null) return false;
  return (
    first.left < second.right &&
    second.left < first.right &&
    first.top < second.bottom &&
    second.top < first.bottom
  );
}

function describe(box) {
  return box === null
    ? 'absent'
    : `[${box.left.toFixed(1)},${box.top.toFixed(1)} → `
      + `${box.right.toFixed(1)},${box.bottom.toFixed(1)}]`;
}

/**
 * Do two convex quadrilaterals share any area?
 *
 * Separating-axis test: two convex shapes are disjoint exactly when some edge
 * normal of one separates their projections. Exact for the rotated rectangles
 * tick labels occupy, where an axis-aligned test is not.
 */
function quadsOverlap(first, second) {
  for (const polygon of [first, second]) {
    for (let index = 0; index < polygon.length; index++) {
      const start = polygon[index];
      const end = polygon[(index + 1) % polygon.length];
      const axis = { x: -(end.y - start.y), y: end.x - start.x };
      const project = points => {
        let min = Infinity;
        let max = -Infinity;
        for (const point of points) {
          const value = (point.x * axis.x) + (point.y * axis.y);
          if (value < min) min = value;
          if (value > max) max = value;
        }
        return { min, max };
      };
      const a = project(first);
      const b = project(second);
      // A shared edge is contact, not overlap; require real interpenetration.
      if (a.max <= b.min + 1e-6 || b.max <= a.min + 1e-6) return false;
    }
  }
  return true;
}

function describeQuad(corners) {
  const xs = corners.map(corner => corner.x);
  const ys = corners.map(corner => corner.y);
  return `[${Math.min(...xs).toFixed(1)},${Math.min(...ys).toFixed(1)} → `
    + `${Math.max(...xs).toFixed(1)},${Math.max(...ys).toFixed(1)}]`;
}

test.describe('analysis plot label collisions', () => {
  test.beforeEach(async ({ page }) => {
    await openPlotHarness(page);
  });

  for (const surface of SURFACES) {
    test(`volcano axis title clears its legend (${surface.name})`, async ({ page }) => {
      const measured = await measurePlot(page, {
        modulePath: '/assets/js/app/analysis/plots/types/volcanoplot.js',
        data: { results: volcanoResults() },
        options: VOLCANO_OPTIONS,
        width: surface.width,
        height: surface.height,
      });

      // The axis title is not optional: an unlabelled axis cannot be read at
      // any size, so it is drawn on every surface.
      expect(measured.axisTitle, 'the volcano must draw its x-axis title')
        .not.toBeNull();
      expect(measured.axisTitle.bottom).toBeLessThanOrEqual(measured.host.height + 0.5);

      if (measured.legend !== null) {
        expect(
          overlaps(measured.axisTitle, measured.legend),
          `x-axis title ${describe(measured.axisTitle)} overlaps legend `
            + `${describe(measured.legend)} in the ${surface.name} surface`,
        ).toBe(false);

        // Below the title, not merely beside it: a legend that cleared the
        // title by drifting sideways would still cover the plot.
        expect(
          measured.legend.top,
          `the legend must sit below the x-axis title in the ${surface.name} surface`,
        ).toBeGreaterThanOrEqual(measured.axisTitle.bottom);

        // A label painted past the bottom edge is clipped away, not merely ugly.
        expect(measured.legend.bottom)
          .toBeLessThanOrEqual(measured.host.height + 0.5);
      }
    });
  }

  test('the volcano legend is kept wherever it fits', async ({ page }) => {
    const measured = await measurePlot(page, {
      modulePath: '/assets/js/app/analysis/plots/types/volcanoplot.js',
      data: { results: volcanoResults() },
      options: VOLCANO_OPTIONS,
      width: 720,
      height: 380,
    });

    // Dropping the legend is the concession the layout makes only when the band
    // it needs would squeeze the plot below its minimum. A surface with room
    // must still show it, or the collision would have been "fixed" by deleting
    // one of the two things that collided.
    expect(measured.legend, 'the expanded surface has room for the legend')
      .not.toBeNull();
  });

  for (const surface of SURFACES) {
    test(`gene heatmap axes never overprint (${surface.name})`, async ({ page }) => {
      const genes = Array.from({ length: 45 }, (_, index) => `MARKERGENE${index}`);
      const groups = Array.from({ length: 12 }, (_, index) => `Cell type ${index}`);
      const values = new Array(genes.length * groups.length);
      for (let index = 0; index < values.length; index++) {
        values[index] = Math.sin(index) * 2;
      }
      const measured = await measurePlot(page, {
        modulePath: '/assets/js/app/analysis/plots/types/gene-heatmap.js',
        data: {
          matrix: {
            values,
            genes,
            groupNames: groups,
            nRows: genes.length,
            nCols: groups.length,
            transform: 'zscore',
          },
        },
        options: {
          colorscale: 'RdBu',
          transform: 'zscore',
          reverseColorscale: true,
          rangeMode: 'auto',
          zmin: -3,
          zmax: 3,
          showValues: false,
          hasClustering: false,
          showRowDendrogram: false,
          showColDendrogram: false,
          legendPosition: 'auto',
        },
        width: surface.width,
        height: surface.height,
      });

      const collisions = [];
      for (let i = 0; i < measured.ticks.length; i++) {
        for (let j = i + 1; j < measured.ticks.length; j++) {
          const left = measured.ticks[i];
          const right = measured.ticks[j];
          if (quadsOverlap(left.corners, right.corners)) {
            collisions.push(
              `${left.text} ${describeQuad(left.corners)} × `
                + `${right.text} ${describeQuad(right.corners)}`
            );
          }
        }
      }
      expect(
        collisions,
        `overlapping gene tick labels in the ${surface.name} surface`,
      ).toEqual([]);
    });
  }

  for (const surface of SURFACES) {
    test(`categorical tick labels never overprint (${surface.name})`, async ({ page }) => {
      const categories = [
        'Erythroid progenitor', 'Megakaryocyte', 'Pro-B cell', 'Pre-B cell',
        'Naive B cell', 'Memory B cell', 'CD4 T cell', 'CD8 T cell',
        'Regulatory T cell', 'NK cell', 'Classical monocyte',
        'Non-classical monocyte', 'Plasmacytoid DC', 'Conventional DC',
        'Neutrophil', 'Eosinophil', 'Basophil', 'Mast cell',
      ];
      // One page whose cells carry each category a deterministic number of
      // times, which is the shape `PlotFactory.getSortedCategories` reads.
      const values = [];
      categories.forEach((category, index) => {
        for (let repeat = 0; repeat <= index; repeat++) values.push(category);
      });
      const measured = await measurePlot(page, {
        modulePath: '/assets/js/app/analysis/plots/types/barplot.js',
        data: [{ pageName: 'Page 1', values, cellCount: values.length }],
        options: {
          orientation: 'vertical',
          showValues: false,
          sortBy: 'count',
          normalize: false,
          barMode: 'group',
          showLegend: true,
          logScale: false,
        },
        width: surface.width,
        height: surface.height,
      });

      // Thinning is not hiding: an axis that answered the collision by drawing
      // one label, or none, would pass a pure overlap check while telling the
      // reader nothing. Both ends stay anchored so the axis remains readable.
      expect(
        measured.ticks.length,
        `the ${surface.name} surface must keep several category labels`,
      ).toBeGreaterThanOrEqual(3);
      const drawn = measured.ticks.map(tick => tick.text);
      expect(drawn).toContain('Erythroid progenitor');
      expect(drawn).toContain('Mast cell');

      const collisions = [];
      for (let i = 0; i < measured.ticks.length; i++) {
        for (let j = i + 1; j < measured.ticks.length; j++) {
          const left = measured.ticks[i];
          const right = measured.ticks[j];
          if (quadsOverlap(left.corners, right.corners)) {
            collisions.push(
              `${left.text} ${describeQuad(left.corners)} × `
                + `${right.text} ${describeQuad(right.corners)}`
            );
          }
        }
      }
      expect(
        collisions,
        `overlapping category tick labels in the ${surface.name} surface`,
      ).toEqual([]);
    });
  }

  for (const surface of [...SURFACES, Object.freeze({ name: 'narrow sidebar', width: 200, height: 316 })]) {
    test(`dot plot names and legends never overprint (${surface.name})`, async ({ page }) => {
      const found = await measureLabels(page, {
        modulePath: '/assets/js/app/analysis/plots/types/dotplot.js',
        data: dotplotData(),
        width: surface.width,
        height: Math.max(surface.height, 316),
        minimumWidth: true,
      });
      expect(found.items.some(item => item.key.startsWith('colorbar'))).toBe(true);
      expect(found.items.filter(item => item.key.startsWith('dot ')).length).toBe(5);
      expect(found.overlaps, `overlapping labels in the ${surface.name} dot plot`).toEqual([]);
      expect(found.outside, `labels past the edge of the ${surface.name} dot plot`).toEqual([]);
    });
  }

  for (const surface of [...SURFACES, Object.freeze({ name: 'narrow sidebar', width: 200, height: 180 })]) {
    test(`correlation statistics never overprint each other or the legend (${surface.name})`, async ({ page }) => {
      const found = await measureLabels(page, {
        modulePath: '/assets/js/app/analysis/plots/types/scatterplot.js',
        data: correlationData(),
        options: { showTrendline: true, showR2: true, showConfidenceInterval: true },
        width: surface.width,
        height: surface.height,
      });
      expect(found.items.some(item => item.key.includes('R²')), 'the statistics are shown').toBe(true);
      expect(found.overlaps, `overlapping labels in the ${surface.name} correlation plot`).toEqual([]);
      expect(found.outside, `labels past the edge of the ${surface.name} correlation plot`).toEqual([]);
    });
  }

  test('the expanded correlation keeps one framed box per page', async ({ page }) => {
    const found = await measureLabels(page, {
      modulePath: '/assets/js/app/analysis/plots/types/scatterplot.js',
      data: correlationData(),
      options: { showTrendline: true, showR2: true, showConfidenceInterval: true },
      width: 720,
      height: 380,
    });
    expect(found.items.filter(item => item.key.includes('R²')).map(item => item.key)).toEqual([
      'annotation Page 1R² = 0.090**r = 0.300n = 300',
      'annotation Rest of Page 1R² = 0.160***r = 0.400n = 300',
    ]);
    expect(found.items.some(item => item.key === 'legend')).toBe(true);
  });

  for (const modulePath of [
    '/assets/js/app/analysis/plots/types/dotplot.js',
    '/assets/js/app/analysis/plots/types/scatterplot.js',
  ]) {
    test(`a ${modulePath.split('/').at(-1)} drawn wide and then narrowed is laid out again`, async ({ page }) => {
      const dot = modulePath.endsWith('dotplot.js');
      const found = await measureLabels(page, {
        modulePath,
        data: dot ? dotplotData() : correlationData(),
        options: dot ? {} : { showTrendline: true, showR2: true, showConfidenceInterval: true },
        width: 480,
        height: dot ? 316 : 180,
        resizeTo: dot ? 240 : 200,
      });
      expect(found.overlaps).toEqual([]);
      expect(found.outside).toEqual([]);
    });
  }
});

/** A dot plot of eight genes in eight groups, as the dot plot analysis builds it. */
function dotplotData() {
  const genes = ['Krt19', 'Sox9', 'Neurog3', 'Fev', 'Ins1', 'Gcg', 'Sst', 'Ghrl'];
  const groups = ['Ductal', 'Ngn3 low EP', 'Ngn3 high EP', 'Pre-endocrine', 'Beta', 'Alpha', 'Delta', 'Epsilon'];
  const n = genes.length * groups.length;
  const color = Array.from({ length: n }, (_, index) => (index * 37) % 100);
  return {
    genes,
    geneSets: [{ name: 'Set 1', start: 0, end: genes.length }],
    groups,
    cellCounts: groups.map(() => 400),
    color,
    fraction: Array.from({ length: n }, (_, index) => ((index * 53) % 100) / 100),
    mean: color,
    colorLabel: 'Mean expression',
    colorMap: 'Reds',
    maxDotSize: 'auto',
    cellSizePx: 21,
    layout: 'dot',
    swap: false,
  };
}

/** Two pages of a correlation coloured by cell type. */
function correlationData() {
  const types = ['Ngn3 low EP', 'Alpha', 'Beta', 'Delta', 'Ductal', 'Epsilon', 'Ngn3 high EP', 'Pre-endocrine'];
  return [0, 1].map(pageIndex => {
    const x = [];
    const y = [];
    const colorValues = [];
    for (let index = 0; index < 300; index++) {
      const seed = Math.sin(index * 12.9898 + pageIndex) * 43758.5453;
      const unit = seed - Math.floor(seed);
      x.push(unit * 1.2 - 0.2);
      y.push(unit * 0.5 + Math.cos(index) * 0.4);
      colorValues.push(types[index % types.length]);
    }
    const r = 0.3 + pageIndex * 0.1;
    return {
      pageId: `page-${pageIndex}`,
      pageName: pageIndex === 0 ? 'Page 1' : 'Rest of Page 1',
      xValues: x,
      yValues: y,
      r,
      rSquared: r * r,
      pValue: pageIndex === 0 ? 0.002 : 1e-6,
      slope: 0.4,
      intercept: -0.1,
      xVariable: 'S_score',
      yVariable: 'G2M_score',
      colorValues,
      colorVariable: 'cell_type',
    };
  });
}

/**
 * Draw one plot into a host of an exact size (a dot plot no narrower than it
 * names every gene and group, as its preview is) and measure every label it
 * drew: annotations, the legend's box, the colour bar's bar, ticks and title,
 * the size legend's dots and the tick labels. Returns the labels, every pair
 * that overlaps and every label past the host's edge.
 */
async function measureLabels(page, { modulePath, data, options = {}, width, height, minimumWidth = false, resizeTo = null }) {
  return await page.evaluate(async args => {
    const host = document.getElementById('plot-host');
    host.replaceChildren();
    const plotModule = await import(args.modulePath);
    const definition = plotModule.default;
    let drawnWidth = args.width;
    if (args.minimumWidth) drawnWidth = Math.max(drawnWidth, plotModule.dotplotMinimumWidth(args.data, args.height));
    host.style.width = `${drawnWidth}px`;
    host.style.height = `${args.height}px`;
    const { PlotRegistry } = await import('/assets/js/app/analysis/plots/plot-factory.js');
    const { loadPlotly } = await import('/assets/js/app/analysis/plots/plotly-loader.js');
    const Plotly = await loadPlotly();
    const figure = await definition.render(args.data, PlotRegistry.mergeOptions(definition.id, args.options), host, null);
    if (args.resizeTo !== null) {
      // As the responsive resize does (`shared/plotly-render-slot.js`).
      const { refitToSize } = await import('/assets/js/app/analysis/plots/size-fit.js');
      drawnWidth = args.resizeTo;
      host.style.width = `${drawnWidth}px`;
      await Plotly.Plots.resize(figure);
      await refitToSize(figure);
    }
    const hostBox = host.getBoundingClientRect();
    const union = boxes => ({
      left: Math.min(...boxes.map(box => box.left)),
      top: Math.min(...boxes.map(box => box.top)),
      right: Math.max(...boxes.map(box => box.right)),
      bottom: Math.max(...boxes.map(box => box.bottom)),
    });
    // What is drawn, in host pixels: a box in an element's own coordinates
    // carried through its transform to the page (`getScreenCTM`, the space
    // `getBoundingClientRect` reports). Text is measured by its glyph cells
    // (`getExtentOfChar`: each character's advance and the font's height),
    // not by its client rectangle or `getBBox`: Firefox pads both past the
    // glyphs (a 7 px name turned to run down is 10.8 px across in its client
    // rectangle, 8.8 px in its box, and its advance is narrower still), and
    // Plotly frames an annotation by that padded box, so an annotation is
    // measured by its frame only where the frame is drawn.
    const toHost = (element, box) => {
      const matrix = element.getScreenCTM();
      const corners = [[box.x, box.y], [box.x + box.width, box.y], [box.x, box.y + box.height], [box.x + box.width, box.y + box.height]]
        .map(([x, y]) => ({ x: matrix.a * x + matrix.c * y + matrix.e - hostBox.left, y: matrix.b * x + matrix.d * y + matrix.f - hostBox.top }));
      return {
        left: Math.min(...corners.map(corner => corner.x)),
        top: Math.min(...corners.map(corner => corner.y)),
        right: Math.max(...corners.map(corner => corner.x)),
        bottom: Math.max(...corners.map(corner => corner.y)),
      };
    };
    const glyphBoxes = element => {
      const texts = element instanceof SVGTextElement ? [element] : [...element.querySelectorAll('text')];
      const boxes = [];
      for (const text of texts) {
        for (let index = 0; index < text.getNumberOfChars(); index++) {
          boxes.push(toHost(text, text.getExtentOfChar(index)));
        }
      }
      return boxes;
    };
    const drawnFrame = element => {
      const frame = element.querySelector('rect.bg');
      if (frame === null) return null;
      const style = getComputedStyle(frame);
      const stroked = style.stroke !== 'none' && Number.parseFloat(style.strokeWidth) > 0 && Number.parseFloat(style.strokeOpacity) > 0;
      const filled = style.fill !== 'none' && Number.parseFloat(style.fillOpacity) > 0 && !/rgba\(\d+, \d+, \d+, 0\)/.test(style.fill);
      return stroked || filled ? toHost(frame, frame.getBBox()) : null;
    };
    const boxOf = element => {
      if (element instanceof SVGTextElement || (element instanceof SVGGElement && element.querySelector('text') !== null)) {
        const parts = glyphBoxes(element);
        const frame = drawnFrame(element);
        if (frame !== null) parts.push(frame);
        if (parts.length > 0) return union(parts);
      }
      return toHost(element, element.getBBox());
    };
    const items = [];
    host.querySelectorAll('.infolayer .annotation').forEach(element => {
      items.push({ key: `annotation ${element.textContent}`, ...boxOf(element) });
    });
    host.querySelectorAll('.infolayer .legend rect.bg').forEach(element => items.push({ key: 'legend', ...boxOf(element) }));
    host.querySelectorAll('.infolayer .colorbar').forEach((element, index) => {
      const parts = [...element.querySelectorAll('.cbfills, .cbaxis text, .cbtitle text')].map(boxOf);
      if (parts.length > 0) items.push({ key: `colorbar ${index}`, ...union(parts) });
    });
    // The size legend's dots: the round shapes.
    host.querySelectorAll('.shapelayer path').forEach((element, index) => {
      const box = element.getBBox();
      if (box.width > 0 && Math.abs(box.width - box.height) < 1) items.push({ key: `dot ${index}`, ...boxOf(element) });
    });
    host.querySelectorAll('.xtick text, .ytick text, .g-xtitle, .g-ytitle').forEach(element => {
      if (element.textContent) items.push({ key: `label ${element.textContent}`, ...boxOf(element) });
    });
    const overlaps = [];
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        // Touching is not overlapping: half a pixel of anti-aliasing either way.
        if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) {
          overlaps.push(`${a.key} × ${b.key}`);
        }
      }
    }
    const outside = items
      .filter(item => item.left < -0.5 || item.top < -0.5 || item.right > drawnWidth + 0.5 || item.bottom > args.height + 0.5)
      .map(item => item.key);
    return { items, overlaps, outside };
  }, { modulePath, data, options, width, height, minimumWidth, resizeTo });
}

