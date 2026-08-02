/**
 * Analysis plots must fill exactly the box they are given, in the sidebar
 * preview and in the expanded overlay alike.
 *
 * Two defects this pins down:
 *
 * 1. The overlay opens under `transform: scale(0.96)`. A host measured with
 *    `getBoundingClientRect()` reports that animation's visual box, so the plot
 *    was rendered 4% small and stayed that way - a transform change never
 *    notifies a ResizeObserver, so nothing ever corrected it.
 * 2. A plot type that pins `layout.height` overflows the 180px sidebar preview,
 *    paints over the actions bar, and swallows clicks on the Expand button.
 *
 * The acceptance is geometric, not a screenshot: the rendered Plotly SVG must
 * match the plot host's layout box, and the sidebar plot must not paint below
 * its host.
 */
import {
  closeContextWithApplicationRetirement,
  expect,
  test,
} from './helpers/test.mjs';
import { encodedAppUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

/**
 * The Detailed mode panel. Addressed by `data-mode` rather than by id: the
 * analysis UI manager only assigns an id when the host markup has none, so the
 * id is not a stable contract while the markup owns it.
 */
const DETAILED_PANEL = '.analysis-accordion-content[data-mode="detailed"]';

/**
 * A `<select>` inside the Detailed panel, addressed by an option it owns.
 *
 * Control ids in this panel are generated and are being reshaped by an
 * accessibility pass, so an option value - which is the analysis contract
 * itself (`categorical`, `timepoint`, `barplot`) - is the durable handle.
 */
function panelSelect(page, optionValue) {
  return page
    .locator(`${DETAILED_PANEL} select`)
    .filter({ has: page.locator(`option[value="${optionValue}"]`) })
    .first();
}

const DATASET_URL =
  `/?exportsBaseUrl=${encodedAppUrl('/tests/browser/fixtures/demo-custom-exports/')}`
  + '&dataset=synthetic-development-3d&acceptance=analysis-plot-surface-parity';
const VIEWPORT = { width: 1440, height: 1000 };
const RETIREMENT_CYCLES = 20;

/** Plot type id -> the Plotly trace type its committed render must publish. */
const CATEGORICAL_PLOTS = Object.freeze([
  Object.freeze({ id: 'barplot', trace: 'bar' }),
  Object.freeze({ id: 'pieplot', trace: 'pie' }),
  Object.freeze({ id: 'heatmap', trace: 'heatmap' }),
]);
const CONTINUOUS_PLOTS = Object.freeze([
  Object.freeze({ id: 'boxplot', trace: 'box' }),
  Object.freeze({ id: 'violinplot', trace: 'violin' }),
  Object.freeze({ id: 'histogram', trace: 'histogram' }),
  Object.freeze({ id: 'densityplot', trace: 'scatter' }),
]);

function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => {
    errors.push(`page: ${error.stack || error.message}`);
  });
  return errors;
}

async function openDetailedAnalysis(page) {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  // Page Analysis mounts its mode UIs once the dataset is published.
  await expect(page.locator('#dataset-name'))
    .toHaveText('Synthetic branching development — 3D');
  await expect(page.locator('#dataset-cells')).toHaveText('96');
  await page.locator('#analysis-header-detailed').click();
  await expect(page.locator(DETAILED_PANEL)).toBeAttached();
  await expect(panelSelect(page, 'categorical')).toBeVisible();
}

/**
 * Geometry of one plot surface, read from the live DOM.
 *
 * `host` is the layout box a candidate occupies; `svg` is what Plotly actually
 * drew; `overflowBottom` is how far the drawn plot spills past its host.
 */
function readSurfaces(page) {
  return page.evaluate(() => {
    const surface = host => {
      if (!host) return null;
      const graph = host.querySelector('.js-plotly-plot');
      const svg = host.querySelector('svg.main-svg');
      const drawn = host.querySelector('.svg-container');
      const hostBounds = host.getBoundingClientRect();
      return {
        host: { w: host.clientWidth, h: host.clientHeight },
        svg: svg
          ? {
            w: Math.round(Number(svg.getAttribute('width'))),
            h: Math.round(Number(svg.getAttribute('height'))),
          }
          : null,
        traceTypes: graph && Array.isArray(graph._fullData)
          ? graph._fullData.map(trace => trace.type)
          : null,
        overflowBottom: drawn
          ? Math.round(drawn.getBoundingClientRect().bottom - hostBounds.bottom)
          : null,
        overflowRight: drawn
          ? Math.round(drawn.getBoundingClientRect().right - hostBounds.right)
          : null,
      };
    };
    const panel = document.querySelector('.analysis-accordion-content[data-mode="detailed"]');
    return {
      preview: surface(panel?.querySelector('.analysis-preview-container') ?? null),
      overlay: surface(
        document.querySelector('.analysis-modal.open .analysis-modal-plot') ?? null,
      ),
      plotlyGraphs: document.querySelectorAll('.js-plotly-plot').length,
      openOverlays: document.querySelectorAll('.analysis-modal').length,
    };
  });
}

/** Poll until `surfaceName` holds a settled plot of exactly `traceType`. */
async function expectSettledPlot(page, surfaceName, traceType) {
  await expect
    .poll(async () => {
      const surfaces = await readSurfaces(page);
      const surface = surfaces[surfaceName];
      if (!surface || !surface.svg || !surface.traceTypes) return 'no plot';
      if (!surface.traceTypes.every(type => type === traceType)) {
        return `trace types ${JSON.stringify(surface.traceTypes)}`;
      }
      return `${surface.svg.w}x${surface.svg.h} in ${surface.host.w}x${surface.host.h}`;
    }, { message: `${surfaceName} settles on a ${traceType} plot` })
    .toMatch(/^(\d+)x(\d+) in \1x\2$/);
}

async function selectVariable(page, kind, field, initialPlot) {
  await panelSelect(page, kind).selectOption(kind);
  const fieldSelect = panelSelect(page, field);
  await expect(fieldSelect).toBeVisible();
  await fieldSelect.selectOption(field);
  await expect(panelSelect(page, initialPlot.id)).toHaveValue(initialPlot.id);
  await expectSettledPlot(page, 'preview', initialPlot.trace);
  await expect(
    page.locator(`${DETAILED_PANEL} .analysis-expand-btn`),
  ).toBeVisible();
}

/**
 * Render each plot type in the sidebar, expand it, and check both surfaces.
 *
 * Each variable kind gets its own page load so its first committed publication
 * has one unambiguous data and plot-type owner.
 */
async function checkPlotSurfaces(page, kind, field, plots) {
  const productErrors = observeProductErrors(page);
  await openDetailedAnalysis(page);
  await selectVariable(page, kind, field, plots[0]);

  const expandButton = page.locator(`${DETAILED_PANEL} .analysis-expand-btn`);
  const overlay = page.locator('.analysis-modal.open');

  for (const plot of plots) {
    const plotSelect = panelSelect(page, plot.id);
    if (await plotSelect.inputValue() !== plot.id) {
      const previousAction = await expandButton.elementHandle();
      if (previousAction === null) {
        throw new Error('Committed analysis action disappeared before replacement');
      }
      await plotSelect.selectOption(plot.id);

      // A plot candidate is connected while hidden. Its trace can therefore
      // look settled before it commits. The action button is replaced only by
      // `_renderActions()` after that commit, so retirement of this exact old
      // button is the publication fence for the click below.
      await expect
        .poll(
          () => previousAction.evaluate(element => element.isConnected),
          { message: `${plot.id} publishes a new analysis generation` },
        )
        .toBe(false);
      await previousAction.dispose();
      await expect(expandButton).toBeVisible();
    }
    await expectSettledPlot(page, 'preview', plot.trace);

    // A plot that draws past its host paints over the actions bar.
    const preview = (await readSurfaces(page)).preview;
    expect(
      preview.overflowBottom,
      `${plot.id} sidebar plot must not paint below its host`,
    ).toBeLessThanOrEqual(0);
    expect(
      preview.overflowRight,
      `${plot.id} sidebar plot must not paint past its host`,
    ).toBeLessThanOrEqual(0);

    // A real click: an overflowing preview would intercept it.
    await expandButton.click();
    await expect(overlay).toBeVisible();
    await expectSettledPlot(page, 'overlay', plot.trace);

    await page.keyboard.press('Escape');
    await expect(page.locator('.analysis-modal')).toHaveCount(0);
  }

  expect(productErrors).toEqual([]);
}

test.describe('analysis plot surfaces', () => {
  test('categorical plot types fill the sidebar preview and the expanded overlay', async ({ page }) => {
    await checkPlotSurfaces(page, 'categorical', 'timepoint', CATEGORICAL_PLOTS);
  });

  test('continuous plot types fill the sidebar preview and the expanded overlay', async ({ page }) => {
    await checkPlotSurfaces(
      page,
      'continuous',
      'differentiation_score',
      CONTINUOUS_PLOTS,
    );
  });

});

test.describe.serial('analysis overlay retirement soak', () => {
  let context = null;
  let page = null;
  let productErrors = null;

  test.beforeAll(async ({ browser }) => {
    // Keep one real application alive across every cycle: splitting the soak
    // into test-sized operations must not reset the Plotly ownership whose
    // accumulation this contract is designed to detect.
    expect(browser.contexts()).toHaveLength(0);
    context = await browser.newContext({ viewport: VIEWPORT });
    page = await context.newPage();
    productErrors = observeProductErrors(page);

    await openDetailedAnalysis(page);
    await selectVariable(page, 'continuous', 'differentiation_score', {
      id: 'boxplot',
      trace: 'box',
    });

    const baseline = await readSurfaces(page);
    expect(baseline.plotlyGraphs).toBe(1);
    expect(baseline.openOverlays).toBe(0);
  });

  test.afterAll(async () => {
    if (context !== null) {
      await closeContextWithApplicationRetirement(context);
    }
  });

  // Hosted macOS Firefox can legitimately spend several seconds creating and
  // purging each real Plotly surface. Each cycle is independently fenced by
  // the normal test timeout while all twenty still share one application and
  // therefore retain the original cumulative leak-detection contract.
  for (let cycle = 1; cycle <= RETIREMENT_CYCLES; cycle += 1) {
    test(`cycle ${cycle} retires its exact overlay plot`, async () => {
      if (page === null || productErrors === null) {
        throw new Error('Analysis overlay retirement owner was not initialized.');
      }
      const expandButton = page.locator(
        `${DETAILED_PANEL} .analysis-expand-btn`,
      );
      await expandButton.click();
      await expect(page.locator('.analysis-modal.open')).toBeVisible();
      await expectSettledPlot(page, 'overlay', 'box');
      await page.keyboard.press('Escape');
      await expect(page.locator('.analysis-modal')).toHaveCount(0);

      const settled = await readSurfaces(page);
      expect(
        settled.plotlyGraphs,
        `cycle ${cycle} must leave exactly the sidebar plot`,
      ).toBe(1);
      expect(settled.openOverlays).toBe(0);
      expect(productErrors).toEqual([]);
    });
  }
});
