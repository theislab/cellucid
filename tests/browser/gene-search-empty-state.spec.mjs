import { expect, test } from '@playwright/test';
import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const PREPARED_DATASET_URL =
  `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}`
  + '&dataset=current-ui-prepared'
  + '&acceptance=gene-search-empty-state-ci';

/* The fixture publishes exactly these six gene names. */
const PUBLISHED_GENE_COUNT = 6;
const GENE_PANEL_NOTE =
  `This dataset publishes ${PUBLISHED_GENE_COUNT} gene names, chosen when it `
  + 'was prepared and possibly a subset of the source data. '
  + 'Check for typos too.';
const HELP_URL =
  'https://cellucid.readthedocs.io/en/latest/user_guide/web_app/'
  + 'd_fields_coloring_legends/05_troubleshooting_fields_legends.html'
  + '#symptom-gene-search-returns-nothing-enter-selects-the-wrong-gene';

function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => {
    errors.push(`page: ${error.stack || error.message}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      errors.push(`http ${response.status()}: ${response.url()}`);
    }
  });
  return errors;
}

async function openGeneSearch(page) {
  await page.goto(PREPARED_DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture'
  );
  await expect(page.locator('#gene-expression-container')).toHaveClass(
    /\bvisible\b/
  );
  await page.locator('#gene-expression-search').click();
  await expect(page.locator('#gene-expression-dropdown')).toHaveClass(
    /\bvisible\b/
  );
}

test('a gene search with no match explains this dataset gene panel', async ({
  page,
}) => {
  const productErrors = observeProductErrors(page);
  await openGeneSearch(page);

  const dropdown = page.locator('#gene-expression-dropdown');
  const emptyState = dropdown.locator('.dropdown-no-results');

  await page.locator('#gene-expression-search').fill('EGFR');
  await expect(emptyState).toBeVisible();

  // The reader is told what failed, how large this dataset's panel is, that
  // the panel was decided upstream, and that a typo is equally possible.
  await expect(emptyState).toContainText('No gene matches');
  await expect(emptyState).toContainText('“EGFR”.');
  await expect(emptyState).toContainText(GENE_PANEL_NOTE);

  // It never claims to know that a specific gene was taken out: the export
  // records nothing about what preparation left behind.
  const copy = (await emptyState.innerText()).toLowerCase();
  for (const forbidden of [
    'was removed',
    'were removed',
    'dropped',
    'excluded',
    'filtered out',
    'unnamed',
  ]) {
    expect(copy, `must not claim "${forbidden}"`).not.toContain(forbidden);
  }

  // The full explanation lives in the documentation, not in this dropdown.
  const help = emptyState.getByRole('link', {
    name: 'Why a gene may be missing',
  });
  await expect(help).toHaveAttribute('href', HELP_URL);
  await expect(help).toHaveAttribute('target', '_blank');
  await expect(help).toHaveAttribute('rel', 'noopener noreferrer');

  // Nothing clips and nothing scrolls sideways, at this width or a narrow one.
  for (const width of [1440, 900]) {
    await page.setViewportSize({ width, height: 900 });
    const box = await dropdown.evaluate(element => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
    }));
    expect(box.scrollHeight, `${width}px vertical fit`).toBeLessThanOrEqual(
      box.clientHeight
    );
    expect(box.scrollWidth, `${width}px horizontal fit`).toBeLessThanOrEqual(
      box.clientWidth
    );
    expect(box.documentScrollWidth).toBeLessThanOrEqual(
      box.documentClientWidth
    );
  }

  expect(productErrors).toEqual([]);
});

test('a long query cannot widen the sidebar', async ({ page }) => {
  await openGeneSearch(page);
  await page
    .locator('#gene-expression-search')
    .fill('ENSG00000141510ENSG00000141510ENSG00000141510');

  const dropdown = page.locator('#gene-expression-dropdown');
  await expect(dropdown.locator('.dropdown-no-results')).toBeVisible();
  const fit = await dropdown.evaluate(element => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    documentClientWidth: document.documentElement.clientWidth,
  }));
  expect(fit.scrollWidth).toBeLessThanOrEqual(fit.clientWidth);
  expect(fit.documentScrollWidth).toBeLessThanOrEqual(fit.documentClientWidth);
});

test('a matching gene search shows results and no gene panel note', async ({
  page,
}) => {
  await openGeneSearch(page);
  const dropdown = page.locator('#gene-expression-dropdown');

  await page.locator('#gene-expression-search').fill('CD3');
  await expect(dropdown.locator('.dropdown-item')).toHaveText(['CD3E']);
  await expect(dropdown.locator('.dropdown-no-results')).toHaveCount(0);
  await expect(dropdown).not.toContainText('This dataset publishes');
});

test('the empty state reaches a screen reader through a live status', async ({
  page,
}) => {
  await openGeneSearch(page);
  // Scoped to the gene panel on purpose. The sidebar owns a second, unrelated
  // `role=status` for data-source readiness, and two live regions are correct
  // here -- they announce different things at different times, and a live
  // region speaks on change. What this test cares about is the gene panel's own.
  const status = page.locator('#gene-expression-container').getByRole('status');

  // The live region is already in the accessible tree before the search runs,
  // which is what makes the later text change announceable.
  await expect(status).toHaveCount(1);
  await expect(status).toHaveAttribute('aria-live', 'polite');
  await expect(status).toHaveText('');

  await page.locator('#gene-expression-search').fill('EGFR');
  await expect(status).toHaveText(
    `No gene matches your search. ${GENE_PANEL_NOTE}`
  );

  // Extending a query that still finds nothing must not repeat the whole
  // explanation on every keystroke.
  await page.locator('#gene-expression-search').fill('EGFR1');
  await expect(status).toHaveText(
    `No gene matches your search. ${GENE_PANEL_NOTE}`
  );

  // A match clears it, so the next miss announces again.
  await page.locator('#gene-expression-search').fill('CD3');
  await expect(status).toHaveText('');
});

test('the empty state reads in both themes', async ({ page }) => {
  const productErrors = observeProductErrors(page);
  await openGeneSearch(page);
  const emptyState = page.locator(
    '#gene-expression-dropdown .dropdown-no-results'
  );

  for (const theme of ['light', 'dark']) {
    await page.locator('#theme-select').selectOption(theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.locator('#gene-expression-search').click();
    await page.locator('#gene-expression-search').fill('EGFR');
    await expect(emptyState).toBeVisible();
    await expect(emptyState).toContainText(GENE_PANEL_NOTE);

    // Every part of the note is painted with a themed token, never a literal.
    const painted = await emptyState.evaluate(element => {
      const styles = [element, ...element.querySelectorAll('*')].map(node => (
        getComputedStyle(node).color
      ));
      return { styles, background: getComputedStyle(element).backgroundColor };
    });
    for (const color of painted.styles) {
      expect(color).toMatch(/^(rgb|color|oklch)/);
    }
  }

  expect(productErrors).toEqual([]);
});
