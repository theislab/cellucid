/**
 * A figure's axes are laid out once, from their measured text, and both
 * formats draw that one plan.
 *
 * The y-axis label stands past the widest tick label, whatever the tick
 * labels' width and the text size (1–500 px): a fixed offset runs the label
 * into the ticks, and fixed axis margins cut large text at the figure's edge
 * or run it into the legend. Both formats place the y tick labels alike, not
 * one 2 px from the tick and the other 8 px.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  drawCanvasAxes,
  placeFigureAxes,
  planFigureAxes,
  renderSvgAxes,
} from '../assets/js/app/ui/modules/figure-export/components/axes-builder.js';
import {
  computeGridFigureLayout,
  computeSingleViewLayout,
} from '../assets/js/app/ui/modules/figure-export/utils/layout.js';
import { estimateTextWidth } from '../assets/js/app/ui/modules/figure-export/utils/text-measure.js';
import { FIGURE_EXPORT_SETTING_RANGES } from '../assets/js/app/ui/modules/figure-export/utils/session-settings.js';

/** How far a glyph reaches above and below its baseline, in font sizes. */
const ASCENT = 0.8;
const DESCENT = 0.3;

const BOUNDS = { minX: -12.3, maxX: 14.8, minY: -0.53, maxY: 12.3 };

/** The ink box of one placed axis text, measured as the layout measures. */
function textBox(text) {
  const width = estimateTextWidth(text.text, text.fontPx);
  const up = ASCENT * text.fontPx;
  const down = DESCENT * text.fontPx;
  if (text.vertical) {
    // Read upwards: the ascent points left of the baseline.
    return { left: text.x - up, right: text.x + down, top: text.y - width / 2, bottom: text.y + width / 2 };
  }
  const left = text.anchor === 'middle' ? text.x - width / 2 : text.x - width;
  return { left, right: left + width, top: text.y - up, bottom: text.y + down };
}

function lineBox(line) {
  return {
    left: Math.min(line.x1, line.x2),
    right: Math.max(line.x1, line.x2),
    top: Math.min(line.y1, line.y2),
    bottom: Math.max(line.y1, line.y2),
  };
}

const overlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/** Every text clear of every other text, every line and the plot; all ink inside the margins. */
function assertAxesClear(axes, label) {
  const plot = { left: 0, right: axes.plotWidth, top: 0, bottom: axes.plotHeight };
  const texts = axes.texts.map(text => ({ name: text.text, box: textBox(text) }));
  for (let i = 0; i < texts.length; i++) {
    assert.equal(overlap(texts[i].box, plot), false, `${label}: "${texts[i].name}" over the plot`);
    for (const line of axes.lines) {
      assert.equal(overlap(texts[i].box, lineBox(line)), false, `${label}: "${texts[i].name}" over an axis line or tick`);
    }
    for (let j = i + 1; j < texts.length; j++) {
      assert.equal(overlap(texts[i].box, texts[j].box), false, `${label}: "${texts[i].name}" runs into "${texts[j].name}"`);
    }
  }
  const { margins } = axes;
  for (const { name, box } of [...texts, ...axes.lines.map(line => ({ name: 'a line', box: lineBox(line) }))]) {
    assert.ok(box.left >= -margins.left && box.right <= axes.plotWidth + margins.right, `${label}: ${name} inside the side margins`);
    assert.ok(box.top >= -margins.top && box.bottom <= axes.plotHeight + margins.bottom, `${label}: ${name} inside the top and bottom margins`);
  }
}

test('the y-axis label stands past the widest tick label at every text size', () => {
  // The S1b export picture: ticks 17 px, axis labels 20 px, "UMAP 2" touched "-0.5".
  const s1b = planFigureAxes({
    bounds: BOUNDS, plotWidth: 600, plotHeight: 400, xLabel: 'UMAP 1', yLabel: 'UMAP 2',
    tickFontPx: 17, labelFontPx: 20, measureText: estimateTextWidth,
  });
  const yLabel = textBox(s1b.texts.find(text => text.text === 'UMAP 2'));
  const yTicks = s1b.texts.filter(text => text.anchor === 'end').map(textBox);
  assert.ok(yTicks.length >= 2);
  assert.ok(yLabel.right < Math.min(...yTicks.map(box => box.left)), 'the label is past the widest tick label');

  const [least, most] = FIGURE_EXPORT_SETTING_RANGES.fontSize;
  const sizes = [least, 6, 12, 17, 20, 24, 40, 80, 200, most];
  const plots = [[600, 400], [110, 60], [80, 64], [1200, 300]];
  const bounds = [
    BOUNDS,
    { minX: -0.45, maxX: 0.45, minY: -0.62, maxY: 0.62 },
    { minX: -12345.6, maxX: 9876.5, minY: 0.001, maxY: 0.0042 },
    // A tick at the bottom-left corner on both axes: "-200000" under "-200000".
    { minX: -200000, maxX: 200000, minY: -200000, maxY: 200000 },
  ];
  for (const tickFontPx of sizes) {
    for (const labelFontPx of sizes) {
      for (const [plotWidth, plotHeight] of plots) {
        for (const [index, each] of bounds.entries()) {
          const axes = planFigureAxes({
            bounds: each, plotWidth, plotHeight, xLabel: 'UMAP 1', yLabel: 'UMAP 2',
            tickFontPx, labelFontPx, measureText: estimateTextWidth,
          });
          assertAxesClear(axes, `ticks ${tickFontPx} / labels ${labelFontPx} px, ${plotWidth} × ${plotHeight}, bounds ${index}`);
        }
      }
    }
  }
});

test('the margins grow with the text: nothing is cut at the figure\'s edge, nothing runs into the legend', () => {
  const axesAt = (tickFontPx, labelFontPx) => ({ bounds: BOUNDS, xLabel: 'UMAP 1', yLabel: 'UMAP 2', tickFontPx, labelFontPx });
  let previousLeft = 0;
  for (const [tickFontPx, labelFontPx] of [[12, 12], [17, 20], [40, 20], [80, 40], [500, 500]]) {
    for (const legendPosition of ['right', 'bottom']) {
      const layout = computeSingleViewLayout({
        width: 600, height: 400, plotAspect: 1.5, title: 'A title', titleFontSizePx: 20,
        axes: axesAt(tickFontPx, labelFontPx), includeLegend: true, legendPosition,
        legendModel: { kind: 'category', categories: ['Alpha', 'Beta'], colors: new Uint8Array(6) },
        legendFieldKey: 'cluster', measureText: estimateTextWidth,
      });
      const { plotRect, axes, legendRect, titleRect } = layout;
      const label = `ticks ${tickFontPx} / labels ${labelFontPx} px, legend ${legendPosition}`;
      // The axes' ink, in figure coordinates.
      const ink = {
        left: plotRect.x - axes.margins.left,
        right: plotRect.x + plotRect.width + axes.margins.right,
        top: plotRect.y - axes.margins.top,
        bottom: plotRect.y + plotRect.height + axes.margins.bottom,
      };
      assert.ok(ink.left >= 0 && ink.top >= 0, `${label}: inside the figure's top-left`);
      assert.ok(ink.right <= layout.totalWidth && ink.bottom <= layout.totalHeight, `${label}: inside the figure's bottom-right`);
      assert.ok(ink.top >= titleRect.y + titleRect.height, `${label}: under the title`);
      const legend = { left: legendRect.x, right: legendRect.x + legendRect.width, top: legendRect.y, bottom: legendRect.y + legendRect.height };
      assert.equal(overlap(ink, legend), false, `${label}: the legend clear of the axes`);
      if (legendPosition === 'right') {
        assert.ok(axes.margins.left >= previousLeft, `${label}: a larger text, no smaller margin`);
        previousLeft = axes.margins.left;
      }
    }
  }
});

test('a grid reserves each panel\'s axes in its column and row, under the panel\'s title', () => {
  const views = [0, 1, 2, 3].map(() => ({ scientificState: { fieldKey: null, legendModel: null } }));
  for (const tickFontPx of [12, 40, 120]) {
    const spec = { bounds: BOUNDS, xLabel: 'UMAP 1', yLabel: 'UMAP 2', tickFontPx, labelFontPx: tickFontPx };
    const layout = computeGridFigureLayout({ columns: views.length <= 3 ? views.length : Math.ceil(Math.sqrt(views.length)), 
      width: 1200, height: 900, views, plotAspects: [1.6, 1.6, 1.6, 1.6],
      panelAxes: [spec, null, spec, spec], fontSize: 12, measureText: estimateTextWidth,
    });
    const inks = layout.panes.map((pane) => {
      if (pane.axes === null) return null;
      const { plotRect, axes } = pane;
      assertAxesClear(axes, `ticks ${tickFontPx}`);
      return {
        left: plotRect.x - axes.margins.left,
        right: plotRect.x + plotRect.width + axes.margins.right,
        top: plotRect.y - axes.margins.top,
        bottom: plotRect.y + plotRect.height + axes.margins.bottom,
      };
    });
    layout.panes.forEach((pane, index) => {
      const ink = inks[index];
      if (ink === null) return;
      const panel = pane.panelRect;
      assert.ok(ink.left >= panel.x && ink.right <= panel.x + panel.width, `ticks ${tickFontPx}: panel ${index}'s axes inside its panel`);
      assert.ok(ink.bottom <= panel.y + panel.height, `ticks ${tickFontPx}: panel ${index}'s axes inside its panel`);
      // The panel's title stands above them (its baseline, and its descenders).
      assert.ok(ink.top >= pane.labelY + DESCENT * 12, `ticks ${tickFontPx}: panel ${index}'s axes under its title`);
      layout.panes.forEach((other, at) => {
        if (at !== index) assert.equal(overlap(ink, { left: other.plotRect.x, right: other.plotRect.x + other.plotRect.width, top: other.plotRect.y, bottom: other.plotRect.y + other.plotRect.height }), false);
      });
    });
  }
});

/** Canvas2D recorder for the axes: lines and texts in figure coordinates. */
function recordingContext() {
  const record = { lines: [], texts: [] };
  let origin = { x: 0, y: 0, turned: false };
  const stack = [];
  let pen = null;
  const ctx = {
    font: '', textAlign: 'left', textBaseline: 'alphabetic', strokeStyle: '#000', fillStyle: '#000', lineWidth: 1,
    save() { stack.push({ ...origin }); },
    restore() { origin = stack.pop(); },
    beginPath() {},
    stroke() {},
    translate(x, y) { origin = { ...origin, x: origin.x + x, y: origin.y + y }; },
    rotate(angle) { origin = { ...origin, turned: Math.abs(angle + Math.PI / 2) < 1e-12 }; },
    moveTo(x, y) { pen = { x, y }; },
    lineTo(x, y) { record.lines.push({ x1: pen.x, y1: pen.y, x2: x, y2: y }); pen = { x, y }; },
    fillText(text, x, y) {
      record.texts.push({
        text, x: origin.x + x, y: origin.y + y, align: ctx.textAlign, fontPx: Number.parseFloat(ctx.font), vertical: origin.turned,
      });
    },
  };
  return { ctx, record };
}

test('the PNG and the SVG draw one axes plan: every line and text at the same place', () => {
  const plotRect = { x: 94.5, y: 30, width: 600, height: 400 };
  for (const [tickFontPx, labelFontPx] of [[12, 12], [17, 20], [64, 30]]) {
    const axes = planFigureAxes({
      bounds: BOUNDS, plotWidth: plotRect.width, plotHeight: plotRect.height, xLabel: 'UMAP 1', yLabel: 'UMAP 2 <b>',
      tickFontPx, labelFontPx, measureText: estimateTextWidth,
    });
    const svg = renderSvgAxes({ plotRect, axes });
    const svgLines = [...svg.matchAll(/<line x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)"\/>/g)]
      .map(([, x1, y1, x2, y2]) => ({ x1: Number(x1), y1: Number(y1), x2: Number(x2), y2: Number(y2) }));
    const svgTexts = [...svg.matchAll(/<text x="([^"]+)" y="([^"]+)" text-anchor="([^"]+)" font-size="([^"]+)" stroke="none"( transform="rotate\(-90 [^)]+\)")?>([^<]*)<\/text>/g)]
      .map(([, x, y, anchor, fontPx, turn, text]) => ({
        text: text.replace('&lt;', '<').replace('&gt;', '>'), x: Number(x), y: Number(y),
        align: { middle: 'center', end: 'right' }[anchor], fontPx: Number(fontPx), vertical: turn !== undefined,
      }));
    const { ctx, record } = recordingContext();
    drawCanvasAxes({ ctx, plotRect, axes });
    const label = `ticks ${tickFontPx} / labels ${labelFontPx} px`;
    assert.ok(svgTexts.length === axes.texts.length && svgLines.length === axes.lines.length, `${label}: the SVG writes the whole plan`);
    assert.deepEqual(record.texts, svgTexts, `${label}: the same texts at the same places`);
    assert.deepEqual(record.lines, svgLines, `${label}: the same lines`);
    // Both are the plan, placed on the plot.
    assert.deepEqual(svgLines, placeFigureAxes(axes, plotRect).lines);
  }
  // A plan is drawn only on the plot it was planned for.
  const axes = planFigureAxes({ bounds: BOUNDS, plotWidth: 600, plotHeight: 400, tickFontPx: 12, measureText: estimateTextWidth });
  assert.throws(() => renderSvgAxes({ plotRect: { x: 0, y: 0, width: 601, height: 400 }, axes }), /planned for/);
});
