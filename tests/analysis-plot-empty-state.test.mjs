/**
 * Degenerate analysis data must produce an honest empty state.
 *
 * Every distribution plot type drops pages it cannot draw: a violin needs two
 * finite values, a density curve needs a non-empty kernel estimate. When that
 * leaves no traces at all, the shared render pipeline used to hand Plotly the
 * normal axis layout, so a single-cell page produced bare 0-6 axes around
 * nothing - indistinguishable from a broken plot.
 *
 * These assertions read the shipped source rather than executing Plotly, which
 * the contract suite has no browser for.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const FACTORY = new URL(
  '../assets/js/app/analysis/plots/plot-factory.js',
  import.meta.url,
);

async function factorySource() {
  return (await readFile(FACTORY, 'utf8')).replaceAll('\r\n', '\n');
}

function block(text, header) {
  const start = text.indexOf(header);
  assert.notEqual(start, -1, `missing ${header}`);
  // Skip the signature, whose destructured parameters carry their own braces.
  const signatureEnd = text.indexOf(') {', start);
  assert.notEqual(signatureEnd, -1, `missing body for ${header}`);
  let depth = 0;
  let index = signatureEnd + 2;
  const bodyStart = index;
  for (; index < text.length; index++) {
    if (text[index] === '{') depth++;
    else if (text[index] === '}') {
      depth--;
      if (depth === 0) return text.slice(bodyStart, index + 1);
    }
  }
  throw new assert.AssertionError({ message: `unbalanced body for ${header}` });
}

test('the shared render pipeline routes empty trace sets to the empty state', async () => {
  const source = await factorySource();
  const selector = block(source, 'static layoutForTraces(');

  assert.match(
    selector,
    /traces\.length === 0/,
    'layoutForTraces must recognise an empty trace set',
  );
  assert.match(
    selector,
    /PlotFactory\.createEmptyStateLayout\(/,
    'an empty trace set must use the empty-state layout',
  );
  assert.match(
    selector,
    /definition\.buildLayout\(pageData, options, layoutEngine\)/,
    'a non-empty trace set must still use the plot type layout',
  );
});

test('render and update both select the layout through layoutForTraces', async () => {
  const source = await factorySource();

  for (const header of ['static async render(', 'static async update(']) {
    const body = block(source, header);
    assert.match(
      body,
      /PlotFactory\.layoutForTraces\(/,
      `${header} must select its layout through layoutForTraces`,
    );
    assert.doesNotMatch(
      body,
      /definition\.buildLayout\(/,
      `${header} must not bypass the empty-state selection`,
    );
  }
});

test('the empty state hides axes and uses the theme text size', async () => {
  const source = await factorySource();
  const body = block(source, 'static createEmptyStateLayout(');

  assert.match(
    body,
    /layout\.xaxis = \{ visible: false \}/,
    'the empty state must not draw an x axis over no data',
  );
  assert.match(
    body,
    /layout\.yaxis = \{ visible: false \}/,
    'the empty state must not draw a y axis over no data',
  );
  assert.match(
    body,
    /size: theme\.fontSize/,
    'the empty-state message must use the theme text size, not a literal',
  );
  assert.match(
    body,
    /family: theme\.fontFamily/,
    'the empty-state message must use the theme font family',
  );
  assert.doesNotMatch(
    body,
    /size: \d+/,
    'the empty state must not hard-code a font size',
  );
});

test('no plot type pins a pixel layout height', async () => {
  const types = new URL(
    '../assets/js/app/analysis/plots/types/',
    import.meta.url,
  );
  const names = [
    'barplot', 'boxplot', 'densityplot', 'gene-heatmap', 'heatmap',
    'histogram', 'pieplot', 'scatterplot', 'violinplot', 'volcanoplot',
  ];

  for (const name of names) {
    const source = (await readFile(new URL(`${name}.js`, types), 'utf8'))
      .replaceAll('\r\n', '\n');
    assert.doesNotMatch(
      source,
      /^\s*layout\.height\s*=/m,
      `${name} must let the render slot own its height: a pixel height `
      + 'overflows the sidebar preview and leaves dead space in the overlay',
    );
    assert.doesNotMatch(
      source,
      /^\s*layout\.width\s*=/m,
      `${name} must let the render slot own its width`,
    );
  }
});
