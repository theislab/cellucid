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
 * The acceptance is geometric, measured from the rendered SVG rather than from
 * the layout object that was supposed to produce it. Tick labels are compared
 * as rotated quadrilaterals: an axis-aligned rectangle around diagonal text
 * reports overlaps that no reader can see, and a check built on that would
 * demand a thinning far more aggressive than the glyphs need.
 */
import { expect, test } from '@playwright/test';
import { appUrl } from './helpers/origins.mjs';

const HARNESS_URL = appUrl('/tests/browser/fixtures/analysis-plot-harness.html');

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
    await page.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
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
});
