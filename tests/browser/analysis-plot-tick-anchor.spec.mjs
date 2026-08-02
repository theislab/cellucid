/**
 * CEL-0217 — a thinned categorical axis still names both of its ends.
 *
 * `analysis-plot-label-collisions.spec.mjs` proves the sidebar stops
 * overprinting eighteen cell-type names. It cannot see the other end of the
 * same range: eighteen categories make `configureCategoricalAxes` rotate the
 * axis, which multiplies the capacity, and its acceptance is "at least three
 * labels survive". The failure below the fit was to keep exactly one.
 *
 * Eight categories is the case that reaches it, and it is the case the product
 * actually ships: `cell_type` and `clusters` in the published pancreas dataset
 * hold eight, one short of the rotation threshold, so the axis is drawn upright
 * and a name like `Pre-endocrine` needs most of the 149px the sidebar leaves
 * between its margins. The capacity is one, and one label under eight bars tells
 * a reader nothing — it was visible in the committed screenshot
 * `cellucid-python/docs/_static/screenshots/analysis/detailed-categorical.png`.
 *
 * The acceptance is measured from the rendered SVG, not from the layout that
 * was meant to produce it, because the whole question is whether two labels
 * drawn at the ends of a narrow box actually clear each other.
 */
import { expect, test } from '@playwright/test';
import { appUrl } from './helpers/origins.mjs';

const HARNESS_URL = appUrl('/tests/browser/fixtures/analysis-plot-harness.html');

/** The accordion preview: `--analysis-panel-width` less its padding. */
const SIDEBAR = Object.freeze({ width: 224, height: 180 });

// exports/pancreas/obs_manifest.json, field `cell_type`, in descending count
// order so `PlotFactory.getSortedCategories(pageData, 'count')` reproduces it.
const PANCREAS_CELL_TYPES = Object.freeze([
  'Ductal', 'Ngn3 high EP', 'Pre-endocrine', 'Beta',
  'Alpha', 'Ngn3 low EP', 'Delta', 'Epsilon',
]);

/**
 * Separating-axis test over the rotated quadrilaterals tick labels occupy. An
 * axis-aligned rectangle around diagonal text reports overlaps no reader sees.
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

async function measureCategoricalTicks(page, { values, width, height }) {
  return await page.evaluate(
    async ({ values: cellValues, width: w, height: h }) => {
      const host = document.getElementById('plot-host');
      host.style.width = `${w}px`;
      host.style.height = `${h}px`;
      host.replaceChildren();

      const definition = (
        await import('/assets/js/app/analysis/plots/types/barplot.js')
      ).default;
      await definition.render(
        [{ pageName: 'Page 1', values: cellValues, cellCount: cellValues.length }],
        {
          orientation: 'vertical',
          showValues: false,
          sortBy: 'count',
          normalize: false,
          barMode: 'group',
          showLegend: true,
          logScale: false,
        },
        host,
      );

      const hostBox = host.getBoundingClientRect();
      const cornersOf = node => {
        const box = node.getBBox();
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

      return {
        bars: host.querySelectorAll('.barlayer .point').length,
        ticks: [...host.querySelectorAll('.xaxislayer-above .xtick text')]
          .map(node => ({ text: node.textContent, corners: cornersOf(node) })),
      };
    },
    { values, width, height },
  );
}

test.describe('categorical tick anchoring', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
  });

  test('eight upright cell types keep both ends of the sidebar axis', async ({ page }) => {
    // Strictly descending counts, so the drawn order is the listed order.
    const values = [];
    PANCREAS_CELL_TYPES.forEach((category, index) => {
      for (let repeat = 0; repeat < PANCREAS_CELL_TYPES.length - index; repeat++) {
        values.push(category);
      }
    });

    const measured = await measureCategoricalTicks(page, {
      values,
      width: SIDEBAR.width,
      height: SIDEBAR.height,
    });

    expect(
      measured.bars,
      'the fixture must draw every one of the eight categories',
    ).toBe(PANCREAS_CELL_TYPES.length);

    const drawn = measured.ticks.map(tick => tick.text);
    expect(
      drawn.length,
      'a sidebar that answers a crowded axis with a single label is not a '
        + 'thinned axis, it is an unreadable one',
    ).toBeGreaterThanOrEqual(2);
    expect(drawn[0]).toBe(PANCREAS_CELL_TYPES[0]);
    expect(drawn.at(-1)).toBe(PANCREAS_CELL_TYPES.at(-1));

    // Every label drawn still names a real category: thinning drops labels, it
    // never rewrites them.
    for (const text of drawn) {
      expect(PANCREAS_CELL_TYPES).toContain(text);
    }

    const collisions = [];
    for (let i = 0; i < measured.ticks.length; i++) {
      for (let j = i + 1; j < measured.ticks.length; j++) {
        const left = measured.ticks[i];
        const right = measured.ticks[j];
        if (quadsOverlap(left.corners, right.corners)) {
          collisions.push(
            `${left.text} ${describeQuad(left.corners)} × `
              + `${right.text} ${describeQuad(right.corners)}`,
          );
        }
      }
    }
    expect(
      collisions,
      'anchoring both ends must not reintroduce the overprinting it replaced',
    ).toEqual([]);
  });
});
