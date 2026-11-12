/**
 * Fit the cells (F161) and the preview's shape note (F119): a figure keeps
 * the screen's framing (F62), so a narrow pane gives a narrow plot of a wide
 * embedding; one click frames every cell drawn, and the preview says when a
 * panel is far from the shape asked for.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CELLS_FRAME_MARGIN,
  SHAPE_FAR,
  cellsFrameRect01,
  panelShapeAgainstCells,
  unionCellsFrames,
} from '../assets/js/app/ui/modules/figure-export/utils/cells-frame.js';
import { assertCropRect01 } from '../assets/js/app/ui/modules/figure-export/utils/crop.js';
import { figureSourceAspect, fitPlotSize } from '../assets/js/app/ui/modules/figure-export/utils/plot-fit.js';

// A planar camera: x, y in -1..1 straight to NDC (column-major identity).
const IDENTITY = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
const valid = rect => assertCropRect01({ enabled: true, ...rect });

/** A wide embedding (x ±0.9, y ±0.3) in a pane twice as tall as wide: the chat open. */
function wideCellsInTallPane() {
  const positions = Float32Array.of(-0.9, 0, 0.9, 0, 0, -0.3, 0, 0.3, 0.2, 0.1);
  return {
    positions, dimension: 2, transparency: Uint8Array.of(1, 1, 1, 1, 1),
    mvpMatrix: IDENTITY, viewportWidth: 400, viewportHeight: 800, pointRadius: 2,
  };
}

test('the frame holds every cell drawn with a margin, so a wide embedding in a tall pane gives a wide plot', () => {
  const view = wideCellsInTallPane();
  const rect = cellsFrameRect01(view);
  valid(rect);
  // Cells span x 20..380 px, y 280..520 px (to Float32's precision); margin = radius + 3% of
  // the larger extent (360 px).
  const margin = 2 + CELLS_FRAME_MARGIN * 360;
  assert.ok(Math.abs(rect.x - (20 - margin) / 400) < 1e-6);
  assert.ok(Math.abs(rect.y - (280 - margin) / 800) < 1e-6);
  assert.ok(Math.abs(rect.width - (360 + 2 * margin) / 400) < 1e-6);
  assert.ok(Math.abs(rect.height - (240 + 2 * margin) / 800) < 1e-6);
  // The pane's plot in 1200 × 900 is a tall strip; the framed one is wide and fills the width.
  const renderState = { viewportWidth: 400, viewportHeight: 800 };
  const pane = fitPlotSize({ aspect: figureSourceAspect({ renderState }), width: 1200, height: 900 });
  const framed = fitPlotSize({ aspect: figureSourceAspect({ renderState, crop: { enabled: true, ...rect } }), width: 1200, height: 900 });
  assert.equal(pane.height, 900);
  assert.ok(pane.width < 460, `the pane's plot is a strip (${pane.width} px wide)`);
  assert.equal(framed.width, 1200);
  assert.ok(framed.width * framed.height > 1.5 * pane.width * pane.height, 'the cells fill a larger plot');
});

test('hidden cells, cells off screen and behind the camera do not count; none drawn is null', () => {
  const view = wideCellsInTallPane();
  // Hide the two widest cells: the frame narrows to the others.
  const narrower = cellsFrameRect01({ ...view, transparency: Uint8Array.of(0, 0, 1, 1, 1) });
  assert.ok(narrower.width < cellsFrameRect01(view).width);
  // A cell outside the viewport (x = 3) is not drawn, so it never widens the frame.
  const outside = cellsFrameRect01({ ...view, positions: Float32Array.of(3, 0, 0.9, 0, 0, -0.3, 0, 0.3, 0.2, 0.1) });
  assert.ok(outside.x > 0.4, 'the frame starts at the drawn cells');
  assert.equal(cellsFrameRect01({ ...view, transparency: new Uint8Array(5) }), null);
  // 1-D and 3-D positions read as the view draws them.
  const oneD = cellsFrameRect01({ ...view, positions: Float32Array.of(-0.5, 0.5), dimension: 1, transparency: Uint8Array.of(1, 1) });
  valid(oneD);
  assert.throws(() => cellsFrameRect01({ ...view, positions: Float32Array.of(0, 0) }), /one position a cell/);
});

test('the frame stays inside the viewport exactly and is never smaller than a frame can be', () => {
  // Cells to the very edges: the margin is clipped, the frame is the whole viewport, and
  // origin + size never rounds past 1 (the frame's own check refuses that).
  for (const width of [301, 333, 777, 1000, 1366]) {
    const rect = cellsFrameRect01({
      positions: Float32Array.of(-1, -1, 1, 1), dimension: 2, transparency: Uint8Array.of(1, 1),
      mvpMatrix: IDENTITY, viewportWidth: width, viewportHeight: 517, pointRadius: 3,
    });
    valid(rect);
    assert.equal(rect.x, 0);
    assert.ok(rect.width > 0.999);
  }
  // One cell: grown to the least frame, centered on it, inside the viewport.
  const single = cellsFrameRect01({
    positions: Float32Array.of(0.99, 0), dimension: 2, transparency: Uint8Array.of(1),
    mvpMatrix: IDENTITY, viewportWidth: 1000, viewportHeight: 1000, pointRadius: 0,
  });
  valid(single);
  assert.ok(single.width >= 0.02 && single.x + single.width <= 1);
  for (let x = 0.0001; x < 1; x += 0.0731) {
    valid(unionCellsFrames([{ x, y: 0.1, width: Math.min(0.5, 1 - x), height: 0.2 }]));
  }
});

test('several panels share one frame: the union of each panel\'s', () => {
  const union = unionCellsFrames([{ x: 0.1, y: 0.3, width: 0.5, height: 0.2 }, null, { x: 0.2, y: 0.25, width: 0.7, height: 0.1 }]);
  assert.deepEqual(Object.keys(union), ['x', 'y', 'width', 'height']);
  assert.ok(Math.abs(union.x - 0.1) < 1e-12 && Math.abs(union.y - 0.25) < 1e-12);
  assert.ok(Math.abs(union.x + union.width - 0.9) < 1e-12 && Math.abs(union.y + union.height - 0.5) < 1e-12);
  assert.equal(unionCellsFrames([null, null]), null);
});

test('the preview says when a panel is far from the shape of its cells (F119, F271)', () => {
  assert.equal(SHAPE_FAR, 1.5);
  // One view: a 400 × 800 pane (0.5) of square cells is far, narrower: a tall
  // figure, the cells in a band across it.
  assert.deepEqual(panelShapeAgainstCells([{ source: 0.5, cells: 1 }]), { far: true, narrower: true, ratio: 0.5 });
  // A pane near its cells' shape is not.
  assert.equal(panelShapeAgainstCells([{ source: 1.2, cells: 1 }]).far, false);
  // The farthest panel decides, and its side: a very wide frame of square cells is far and wider.
  assert.equal(panelShapeAgainstCells([{ source: 0.7, cells: 0.66 }, { source: 1.1, cells: 1 }]).far, false);
  const wide = panelShapeAgainstCells([{ source: 0.66, cells: 0.7 }, { source: 2.5, cells: 1 }]);
  assert.equal(wide.far, true);
  assert.equal(wide.narrower, false);
  // Exactly at the threshold counts as far; just inside does not.
  assert.equal(panelShapeAgainstCells([{ source: 1.5, cells: 1 }]).far, true);
  assert.equal(panelShapeAgainstCells([{ source: 1.49, cells: 1 }]).far, false);
  // No panel (no cell drawn): nothing to say.
  assert.equal(panelShapeAgainstCells([]).far, false);
  assert.throws(() => panelShapeAgainstCells([{ source: 0, cells: 1 }]), /positive aspects/);
});
