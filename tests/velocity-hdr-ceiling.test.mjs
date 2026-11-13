/**
 * A flow blown out at the dials' far ends must not draw magenta and cyan rims
 * on a light backdrop. The trail holds no NaN or infinity there; a composite
 * that tone-maps channel by channel would clip red and blue of a bright
 * purple (viridis's slow end, green near 0) first and pass through magenta, a
 * teal through cyan, and a contrast curve and a screen blend would assume
 * display values on HDR ones. The composite maps the luminance and keeps the
 * hue. Beside it: every pass reading the trail clamps it to a finite ceiling
 * (a half-float sum can overflow), and every blur takes its weights from one
 * normalized Gaussian (a hand-typed kernel can sum to other than 1 and read a
 * zero tap).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANAMORPHIC_BLUR_FS,
  ANAMORPHIC_BLUR_WEIGHTS,
  BLOOM_BLUR_WEIGHTS,
  BLUR_FS,
  COMPOSITE_FS,
  gaussianBlurWeights,
  THRESHOLD_FS,
  TRAIL_ENERGY_CEILING,
  TRAIL_FADE_FS,
} from '../assets/js/rendering/overlays/velocity/velocity-shaders.js';

const CEILING = `vec4(${TRAIL_ENERGY_CEILING.toFixed(1)})`;

test('every pass that reads the trail or the bloom clamps it to a finite ceiling before any arithmetic', () => {
  assert.ok(TRAIL_ENERGY_CEILING > 0 && TRAIL_ENERGY_CEILING < 65504, 'within a half float');
  assert.match(TRAIL_FADE_FS, new RegExp(`vec4 prev = min\\(texture\\(u_previousFrame, v_uv\\), ${CEILING.replace(/[().]/g, '\\$&')}\\);`));
  assert.match(THRESHOLD_FS, new RegExp(`vec4 color = min\\(texture\\(u_source, v_uv\\), ${CEILING.replace(/[().]/g, '\\$&')}\\);`));
  const composite = COMPOSITE_FS.slice(COMPOSITE_FS.indexOf('void main()'));
  const clampAt = composite.indexOf(`trail = min(trail, ${CEILING});`);
  assert.ok(clampAt > 0 && composite.indexOf(`bloom = min(bloom, ${CEILING});`) > clampAt);
  // Nothing reads the samples between their fetch and the clamp.
  assert.ok(composite.indexOf('totalAlpha') > clampAt, 'the clamp comes before the first use');
});

test('every blur takes its weights from one normalized Gaussian: no zero tap, the sum one within float precision', () => {
  for (const [shader, weights, name] of [
    [BLUR_FS, BLOOM_BLUR_WEIGHTS, 'bloom'],
    [ANAMORPHIC_BLUR_FS, ANAMORPHIC_BLUR_WEIGHTS, 'anamorphic'],
  ]) {
    const list = shader.match(/const float weights\[(\d+)\] = float\[\d+\]\(([^)]*)\)/);
    assert.ok(list, `the ${name} blur declares its weights`);
    const glsl = list[2].split(',').map(Number);
    assert.equal(glsl.length, Number(list[1]));
    // The shader's literals are the definition's, as float32.
    assert.deepEqual(glsl.map(Math.fround), weights.map(Math.fround), `${name}: written from gaussianBlurWeights`);
    assert.match(shader, new RegExp(`for \\(int i = 1; i < ${weights.length}; i\\+\\+\\)`));
    assert.ok(glsl.every(weight => weight > 0), `${name}: a zero tap times an infinite texel is NaN`);
    assert.ok(glsl.every((weight, i) => i === 0 || weight < glsl[i - 1]), `${name}: a Gaussian falls from its center`);
    // Summed as the GPU does, in float32: the center once, each side twice.
    let total = Math.fround(glsl[0]);
    for (const weight of glsl.slice(1)) total = Math.fround(total + Math.fround(2 * Math.fround(weight)));
    assert.ok(Math.abs(total - 1) <= 4 * 2 ** -23, `${name} weights sum to ${total}`);
  }
  assert.deepEqual(gaussianBlurWeights(1, 2).map(weight => Number(weight.toFixed(6))), [0.451863, 0.274069]);
  assert.throws(() => gaussianBlurWeights(0, 3), /positive width/);
  // The arithmetic the clamp prevents, as IEEE floats do it on the GPU.
  assert.ok(Number.isNaN(Infinity * 0));
  assert.ok(Number.isNaN(Infinity / Infinity));
  assert.ok(Number.isFinite(Math.min(Infinity, TRAIL_ENERGY_CEILING) * 0));
});

test('the composite maps luminance, keeping each color\'s hue; grading that assumes display values runs on display values', () => {
  const main = COMPOSITE_FS.slice(COMPOSITE_FS.indexOf('void main()'));
  // Tone mapping is of the luminance, the color scaled with it, and past the
  // display's range desaturated toward white along its own hue.
  assert.match(COMPOSITE_FS, /vec3 toneMapPreservingHue\(vec3 color\) \{[\s\S]*ACESFilmEnhanced\(vec3\(lumIn\)\)\.x;[\s\S]*color \* \(lumOut \/ lumIn\)[\s\S]*mix\(mapped, vec3\(lumOut\)/);
  assert.doesNotMatch(main, /color = ACESFilmEnhanced\(color\)/, 'never channel by channel');
  const toneAt = main.indexOf('color = toneMapPreservingHue(color);');
  const contrastAt = main.indexOf('color = softContrast(color, u_contrast);');
  assert.ok(toneAt > 0 && contrastAt > toneAt, 'the S-curve (which clamps to [0, 1]) comes after the tone mapping');
  // The screen blend's (1 - color) is of display values only.
  assert.match(main, /1\.0 - \(1\.0 - min\(color, vec3\(1\.0\)\)\) \* \(1\.0 - bloomColor \* 0\.5\)/);
});
