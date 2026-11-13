/**
 * A panel title wider than its column is not cut off at the panel's edge.
 *
 * The grid sizes a column by its plots, axis margins and legends and by its
 * panel title, because both renderers clip the title to the panel (seven named
 * views at 24 px text in three columns would read "C. Neurog3 (endocrine
 * pro"). One function makes the title (`panelTitle`), the layout measures it
 * and both renderers draw it.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { computeGridFigureLayout } from '../assets/js/app/ui/modules/figure-export/utils/layout.js';
import { panelTitle } from '../assets/js/app/ui/modules/figure-export/utils/panel-label.js';
import { estimateTextWidth } from '../assets/js/app/ui/modules/figure-export/utils/text-measure.js';

const NAMES = ['Cell type', 'Sox9 (ductal)', 'Neurog3 (endocrine progenitor)', 'Ins2 (beta)', 'Gcg (alpha)', 'Arx (alpha TF)', 'Pdx1 (beta TF)'];

function colorBar(max) {
  return { kind: 'continuous', colorbar: { min: 0, max }, colorStops: [], stats: { min: 0, max } };
}

function namedView(name, index) {
  return { id: `v${index}`, name, label: `View ${index + 1}`, scientificState: { fieldKey: 'Ins2', legendModel: colorBar(4 + index) } };
}

/** The S1 figure: seven panels of a wide crop, 24 px text, in the 1600 × 1200 box asked for. */
function s1Layout({ names = NAMES, width = 1600, height = 1200, aspect = 2.3, fontSize = 24 } = {}) {
  const views = names.map(namedView);
  return {
    views,
    layout: computeGridFigureLayout({ columns: views.length <= 3 ? views.length : Math.ceil(Math.sqrt(views.length)), 
      width,
      height,
      views,
      plotAspects: views.map(() => aspect),
      panelAxes: views.map(() => null),
      title: 'Figure 2',
      titleFontSizePx: 30,
      fontSize,
      legendFontSizePx: 22,
      legendPosition: 'right',
      measureText: estimateTextWidth,
    }),
  };
}

test('every panel title fits inside its panel; the figure still keeps to the box', () => {
  const { views, layout } = s1Layout();
  layout.panes.forEach((pane, index) => {
    const title = panelTitle(views[index], index);
    const right = pane.labelX + estimateTextWidth(title, 24);
    assert.ok(
      right <= pane.panelRect.x + pane.panelRect.width,
      `"${title}" ends at ${right.toFixed(1)}, past its panel's edge ${pane.panelRect.x + pane.panelRect.width}`,
    );
  });
  // The plots gave way to the titles: the composed figure is no wider than the box.
  assert.ok(layout.totalWidth <= 1600, `figure ${layout.totalWidth} wide in a 1600 box`);
  assert.ok(layout.totalHeight <= 1200, `figure ${layout.totalHeight} tall in a 1200 box`);
});

test('a title wider than its plot widens only its own column', () => {
  const short = ['A', 'B', 'C'];
  const long = ['A', 'B', 'A much longer panel name than any plot or legend in this narrow figure, by far'];
  const { layout: before } = s1Layout({ names: short, width: 3000, height: 300, aspect: 1, fontSize: 12 });
  const { layout: after } = s1Layout({ names: long, width: 3000, height: 300, aspect: 1, fontSize: 12 });
  const widthOf = (layout, index) => layout.panes[index].panelRect.width;
  assert.equal(widthOf(after, 0), widthOf(before, 0), 'first column unchanged');
  assert.ok(widthOf(after, 2) > widthOf(before, 2), 'the long title widened its column');
  const title = panelTitle({ name: long[2] }, 2);
  assert.ok(after.panes[2].labelX + estimateTextWidth(title, 12) <= after.panes[2].panelRect.x + after.panes[2].panelRect.width);
});

test('a panel title is its letter and its view\'s name, else its label, else its id', () => {
  assert.equal(panelTitle({ id: 'v1', name: 'Cell type', label: 'View 2' }, 0), 'A. Cell type');
  assert.equal(panelTitle({ id: 'v1', name: null, label: 'cell_type · UMAP' }, 1), 'B. cell_type · UMAP');
  assert.equal(panelTitle({ id: 'v9' }, 26), 'AA. v9');
  assert.equal(panelTitle(null, 2), 'C. live');
});

test('both renderers draw the title the layout measured', () => {
  for (const file of ['png-renderer.js', 'svg-renderer.js']) {
    const source = readFileSync(new URL(`../assets/js/app/ui/modules/figure-export/renderers/${file}`, import.meta.url), 'utf8');
    assert.match(source, /const viewTitle = panelTitle\(view, idx\);/, `${file} titles a panel with panelTitle`);
    assert.doesNotMatch(source, /panelLetter\(idx\)\}?\.\s*\$\{/, `${file} builds no title of its own`);
  }
});
