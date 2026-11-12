/**
 * L6-2 (2026-11-11): a legend entry stands at one place in both formats.
 *
 * The SVG set an entry label's bottom at the swatch's bottom
 * (`dominant-baseline="ideographic"`), the PNG its alphabetic baseline there:
 * the two formats of one export placed every label differently, and in a
 * legend font larger than the swatch (Auto text on a large grid figure) the
 * first label rose into the legend's title. Now swatch and label are centered
 * on the entry's row, the label on an alphabetic baseline, in both formats.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  drawCanvasLegend,
  planLegend,
  renderSvgLegend,
} from '../assets/js/app/ui/modules/figure-export/components/legend-builder.js';
import { estimateTextWidth } from '../assets/js/app/ui/modules/figure-export/utils/text-measure.js';

const model = {
  kind: 'category',
  categories: ['Ductal', 'Ngn3 low EP', 'Beta'],
  colors: new Uint8Array(9).fill(90),
  visible: Uint8Array.from([1, 0, 1]),
  picker: [],
  counts: null,
};

/** The calls a Canvas2D legend makes, recorded. */
function recordingContext() {
  const calls = { texts: [], rects: [] };
  const ctx = new Proxy({}, {
    get(target, name) {
      if (name === 'fillText') return (text, x, y) => calls.texts.push({ text, x, y, font: target.font });
      if (name === 'fillRect' || name === 'strokeRect') return (x, y, w, h) => calls.rects.push({ x, y, w, h });
      if (name in target) return target[name];
      return () => {};
    },
    set(target, name, value) {
      target[name] = value;
      return true;
    },
  });
  return { ctx, calls };
}

for (const fontPx of [10, 12, 18, 28]) {
  test(`legend entries at ${fontPx} px stand where they do in the other format, under the title`, () => {
    const plan = planLegend({ model, fieldKey: 'cell_type', fontPx, measureText: estimateTextWidth, placement: 'beside', extentPx: 400 });
    const legendRect = { x: 40, y: 30, width: plan.width, height: plan.height };
    const { svg } = renderSvgLegend({ legendRect, legendPlan: plan, model });
    const { ctx, calls } = recordingContext();
    drawCanvasLegend({ ctx, legendRect, legendPlan: plan, model });

    assert.doesNotMatch(svg, /dominant-baseline/);
    const svgEntries = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="10" height="10"[^>]*\/><text x="([\d.]+)" y="([\d.]+)"[^>]*>([^<]*)<\/text>/g)]
      .map(([, , swatchY, , y, text]) => ({ swatchY: Number(swatchY), y: Number(y), text }));
    assert.deepEqual(svgEntries.map(entry => entry.text), ['Ductal', 'Ngn3 low EP (hidden)', 'Beta']);
    const canvasEntries = calls.texts.slice(1);
    const titleBaseline = calls.texts[0].y;
    svgEntries.forEach((entry, index) => {
      assert.equal(canvasEntries[index].text, entry.text);
      assert.equal(canvasEntries[index].y, entry.y, `${entry.text}: one baseline in both formats`);
      // The swatch and the label share a center line.
      const swatchCentre = entry.swatchY + 5;
      assert.ok(Math.abs(entry.y - 0.35 * fontPx - swatchCentre) < 1e-9);
      // The label's capitals clear the title's descenders.
      assert.ok(entry.y - 0.72 * fontPx > titleBaseline + 0.3 * fontPx, `${entry.text} below the title`);
      // And its descenders stay inside the legend box.
      assert.ok(entry.y + 0.3 * fontPx <= legendRect.y + legendRect.height);
    });
    // The canvas swatches are the SVG's.
    const canvasSwatches = calls.rects.filter(rect => rect.w === 10 && rect.h === 10).map(rect => rect.y);
    for (const entry of svgEntries) assert.ok(canvasSwatches.includes(entry.swatchY));
  });
}
