import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { HighPerfRenderer } from '../assets/js/rendering/high-perf-renderer.js';

/**
 * A pass drawn without depth may use a quality's no-depth program, and only
 * such a pass.
 *
 * `HP_FS_LIGHT_NO_DEPTH` writes zero-alpha fragments where `HP_FS_LIGHT`
 * discards. That is pixel-identical only while the pass neither tests nor
 * writes depth: with depth writes on, those fragments would occlude what lies
 * behind them. The renderer disables DEPTH_TEST for exactly the dimension
 * levels at or below its threshold (1-D and 2-D views), so the program choice
 * must follow the same rule at every draw site, live and snapshot alike.
 */

function rendererWithQuality(activeQuality) {
  return Object.assign(Object.create(HighPerfRenderer.prototype), {
    activeQuality,
  });
}

test('light draws 1-D and 2-D passes with its no-depth program and 3-D with its own', () => {
  const light = rendererWithQuality('light');
  assert.equal(light._pointProgramName(1), 'lightNoDepth');
  assert.equal(light._pointProgramName(2), 'lightNoDepth');
  assert.equal(light._pointProgramName(3), 'light');
});

test('full draws 1-D and 2-D passes with its no-depth program and 3-D with its own', () => {
  const full = rendererWithQuality('full');
  assert.equal(full._pointProgramName(1), 'fullNoDepth');
  assert.equal(full._pointProgramName(2), 'fullNoDepth');
  assert.equal(full._pointProgramName(3), 'full');
});

test('sculpted draws 1-D and 2-D passes with its no-depth program and 3-D with its own', () => {
  const sculpted = rendererWithQuality('sculpted');
  assert.equal(sculpted._pointProgramName(1), 'sculptedNoDepth');
  assert.equal(sculpted._pointProgramName(2), 'sculptedNoDepth');
  assert.equal(sculpted._pointProgramName(3), 'sculpted');
});

test('ultralight draws every pass with its own program', () => {
  const renderer = rendererWithQuality('ultralight');
  for (const dimensionLevel of [1, 2, 3]) {
    assert.equal(renderer._pointProgramName(dimensionLevel), 'ultralight');
  }
});

test('every point draw site resolves its program per pass', async () => {
  const source = await readFile(
    new URL('../assets/js/rendering/high-perf-renderer.js', import.meta.url),
    'utf8'
  );
  // A site that read the quality's program directly would draw a 2-D pass
  // with the discarding shader, or a 3-D pass with the no-depth one.
  assert.doesNotMatch(source, /const program = this\.activeProgram;/);
  assert.doesNotMatch(
    source,
    /uniformLocations\.get\(this\.activeQuality\)/
  );
  const sites = source.match(
    /const programName = this\._pointProgramName\([A-Za-z.]+\);\n\s*const program = this\.programs\[programName\];\n\s*const uniforms = this\.uniformLocations\.get\(programName\);/g
  ) ?? [];
  // Every live and snapshot point pass draws through `_drawPoints`, which
  // resolves the program from the pass's own dimension.
  assert.equal(sites.length, 1);
  assert.match(
    HighPerfRenderer.prototype._drawPoints.toString(),
    /this\._pointProgramName\(params\.dimensionLevel\)/,
  );
  // The depth decision and the program decision share one threshold.
  assert.match(
    source,
    /_pointProgramName\(dimensionLevel\) \{\n\s*if \(dimensionLevel <= DEPTH_TEST_DIMENSION_THRESHOLD\) \{/
  );
});
