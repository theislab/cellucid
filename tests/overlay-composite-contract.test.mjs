/**
 * The full-window selection overlay canvas (lasso, proximity and KNN
 * indicators, the projectile charge ring) is hidden whenever nothing is drawn
 * on it, so a transparent layer the size of the window is not composited over
 * the scene every frame (GX-4).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('the overlay starts hidden, shows while drawn and hides when cleared', () => {
  const highlight = readFileSync(new URL('../assets/js/rendering/highlight-renderer.js', import.meta.url), 'utf8');
  assert.match(highlight, /z-index: 10;\n\s*display: none;/);
  const clear = highlight.slice(highlight.indexOf('function clearLassoOverlay('), highlight.indexOf('export function drawProximityIndicator('));
  assert.match(clear, /setOverlayShown\(lassoCtx, false\);/);
  for (const drawer of ['function drawLasso(', 'export function drawProximityIndicator(']) {
    const body = highlight.slice(highlight.indexOf(drawer), highlight.indexOf('\n}\n', highlight.indexOf(drawer)));
    assert.match(body, /setOverlayShown\(lassoCtx, true\);/, drawer);
  }
  const projectiles = readFileSync(new URL('../assets/js/rendering/projectiles.js', import.meta.url), 'utf8');
  assert.match(projectiles, /overlayStyle\.display = '';/);
  assert.match(projectiles, /overlayStyle\.display = 'none';/);
});

test('legend counts refresh only while the legend can be seen', () => {
  // A visibility frame used to recount every category even with the legend's
  // panel collapsed; the gate defers it until the panel is shown.
  const legend = readFileSync(new URL('../assets/js/app/ui/modules/legend-renderer.js', import.meta.url), 'utf8');
  assert.match(legend, /countsGate \?\?= createVisibilityGatedRender\(legendEl,/);
  assert.match(legend, /countsGate\.request\(\);/);
  assert.match(legend, /\(\) => countsGate\?\.destroy\(\)/);
});
