/**
 * A zero-alpha fragment draws exactly what a discard draws, in a pass without
 * depth.
 *
 * `HP_FS_LIGHT_NO_DEPTH` and `HP_FS_FULL_NO_DEPTH` never discard: where their
 * disc is not covered they output alpha 0, which the straight-alpha blend
 * leaves as the destination it found, because a discard serialises the blend.
 * The renderer draws every pass without depth (1-D and 2-D views) with them,
 * so they are only correct if that zero is indistinguishable from the discard
 * it stands for: the same pixels, single-sampled and multisampled, whatever
 * the overlap, size, sub-pixel position or alpha of the points — hidden ones
 * included. Each is compared with itself rewritten to discard exactly where it
 * writes zero, within one rounding step per channel: both programs compute the
 * antialiased rim's coverage, and each compiles that arithmetic anew.
 */
import { expect, test } from './helpers/test.mjs';

const WEBGL_HARNESS = '/tests/browser/fixtures/webgl-harness.html';

test('the no-depth point shaders draw what discarding draws where they write zero', async ({
  page,
}) => {
  await page.goto(WEBGL_HARNESS);

  const result = await page.evaluate(async () => {
    const shaders = await import('/assets/js/rendering/shaders/high-perf-shaders.js');
    const { configureStraightAlphaBlending } = await import('/assets/js/rendering/gl-utils.js');
    const canvas = document.createElement('canvas');
    canvas.width = 192;
    canvas.height = 160;
    document.body.append(canvas);
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      depth: false,
      preserveDrawingBuffer: true,
    });
    if (!(gl instanceof WebGL2RenderingContext)) return { supported: false };
    const width = canvas.width;
    const height = canvas.height;

    const compile = (vertexSource, fragmentSource) => {
      const program = gl.createProgram();
      for (const [type, source] of [
        [gl.VERTEX_SHADER, vertexSource],
        [gl.FRAGMENT_SHADER, fragmentSource],
      ]) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          throw new Error(gl.getShaderInfoLog(shader));
        }
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program));
      }
      return program;
    };
    const discarding = source => {
      const rewritten = source.replace(
        /fragColor = covered \? (vec4\([^;]*\)) : vec4\(0\.0\);/,
        'if (!covered) discard;\n  fragColor = $1;'
      );
      if (rewritten === source) throw new Error('no zero-alpha output to rewrite');
      return rewritten;
    };
    const programs = {
      light: compile(shaders.HP_VS_LIGHT, discarding(shaders.HP_FS_LIGHT_NO_DEPTH)),
      lightNoDepth: compile(shaders.HP_VS_LIGHT, shaders.HP_FS_LIGHT_NO_DEPTH),
      full: compile(shaders.HP_VS_FULL, discarding(shaders.HP_FS_FULL_NO_DEPTH)),
      fullNoDepth: compile(shaders.HP_VS_FULL, shaders.HP_FS_FULL_NO_DEPTH),
      sculpted: compile(shaders.HP_VS_FULL, discarding(shaders.HP_FS_SCULPTED_NO_DEPTH)),
      sculptedNoDepth: compile(shaders.HP_VS_FULL, shaders.HP_FS_SCULPTED_NO_DEPTH),
    };

    // Deterministic, heavily overlapping points: fractional positions, sizes
    // from sub-pixel to 24 px, varied colours, and alphas that include hidden
    // (< 0.01), barely visible, translucent and opaque points.
    const count = 3000;
    let seed = 12345;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const positions = new Float32Array(count * 2);
    const colors = new Uint8Array(count * 4);
    const alphaValues = [0, 1, 2, 3, 40, 128, 200, 254, 255];
    for (let index = 0; index < count; index++) {
      positions[index * 2] = (random() * 2 - 1) * 0.6;
      positions[index * 2 + 1] = (random() * 2 - 1) * 0.6;
      colors[index * 4] = Math.floor(random() * 256);
      colors[index * 4 + 1] = Math.floor(random() * 256);
      colors[index * 4 + 2] = Math.floor(random() * 256);
      colors[index * 4 + 3] = alphaValues[index % alphaValues.length];
    }
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    const colorBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 4, 0);
    gl.bindVertexArray(null);

    // The renderer's usampler2D needs an unsigned texture bound even when the
    // LOD index lookup is off.
    const dummyIndexTexture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, dummyIndexTexture);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.R32UI, 1, 1, 0,
      gl.RED_INTEGER, gl.UNSIGNED_INT, new Uint32Array(1)
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.activeTexture(gl.TEXTURE0);

    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const makeTarget = samples => {
      const framebuffer = gl.createFramebuffer();
      const color = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, color);
      if (samples > 0) {
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, width, height);
      } else {
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, width, height);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
      return framebuffer;
    };
    const resolveTarget = makeTarget(0);
    const maxSamples = gl.getParameter(gl.MAX_SAMPLES);
    const multisampleTarget = maxSamples >= 4 ? makeTarget(4) : null;

    const draw = (programName, framebuffer, pointSize) => {
      const program = programs[programName];
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.viewport(0, 0, width, height);
      gl.disable(gl.DEPTH_TEST);
      gl.clearColor(0.2, 0.4, 0.6, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      configureStraightAlphaBlending(gl);
      gl.useProgram(program);
      const uniform = name => gl.getUniformLocation(program, name);
      for (const name of ['u_modelViewMatrix', 'u_projectionMatrix']) {
        gl.uniformMatrix4fv(uniform(name), false, identity);
      }
      gl.uniform1f(uniform('u_pointSize'), pointSize);
      gl.uniform1f(uniform('u_pointSizeMax'), 0);
      gl.uniform1f(uniform('u_sizeAttenuation'), 0);
      gl.uniform1f(uniform('u_pointScale'), height / (2 * Math.tan(0.4)) * 0.01);
      // Full's lighting and fog, so its whole fragment path is exercised.
      gl.uniform1f(uniform('u_lightingStrength'), 0.6);
      gl.uniform3f(uniform('u_lightDir'), 0.48, 0.67, 0.48);
      gl.uniform3f(uniform('u_halfDir'), 0.26, 0.37, 0.89);
      gl.uniform1f(uniform('u_fogDensity'), 0.5);
      gl.uniform1f(uniform('u_fogNear'), 0);
      gl.uniform1f(uniform('u_fogFar'), 2);
      gl.uniform3f(uniform('u_fogColor'), 0.9, 0.9, 0.95);
      gl.uniform1f(uniform('u_invCenterShade'), 1 / shaders.sculptedCenterShade([0.48, 0.67, 0.48]));
      gl.uniform1i(uniform('u_useAlphaTex'), 0);
      gl.uniform1i(uniform('u_orderedSlots'), 0);
      gl.uniform1i(uniform('u_lodIndexTex'), 1);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.POINTS, 0, count);
      gl.bindVertexArray(null);
      if (framebuffer !== resolveTarget) {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, resolveTarget);
        gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, resolveTarget);
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    };

    const cases = [];
    for (const [label, framebuffer] of [
      ['single-sample', resolveTarget],
      ['4x multisample', multisampleTarget],
    ]) {
      if (framebuffer === null) continue;
      for (const [quality, pointSize] of [0.7, 1, 1.5, 2.5, 7.3, 24].flatMap(
        size => [['light', size], ['full', size], ['sculpted', size]]
      )) {
        const discarded = draw(quality, framebuffer, pointSize);
        const zeroAlpha = draw(`${quality}NoDepth`, framebuffer, pointSize);
        // Every quality computes the rim's coverage, and light's alpha is its
        // vertex alpha times that coverage, so no quality outputs a value the
        // two programs must agree on to the bit. The arithmetic is compiled
        // twice, once per program, and a driver may contract it into fused
        // multiply-adds differently in each. That moves a channel by at most
        // one step, including where the coverage test itself flips: there the
        // coverage is within rounding of zero, and so is the alpha it blends
        // with. A coverage difference of substance moves a pixel by far more.
        // (Light was held to the bit after it gained a rim, and hosted macOS
        // Firefox, a software renderer, then drew one pixel differently.)
        const tolerance = 1;
        let differing = 0;
        let largestDelta = 0;
        let painted = 0;
        for (let index = 0; index < discarded.length; index += 4) {
          let delta = 0;
          for (let channel = 0; channel < 4; channel++) {
            delta = Math.max(
              delta,
              Math.abs(discarded[index + channel] - zeroAlpha[index + channel])
            );
          }
          if (delta > tolerance) differing++;
          largestDelta = Math.max(largestDelta, delta);
          if (discarded[index] !== 51 || discarded[index + 1] !== 102 || discarded[index + 2] !== 153) {
            painted++;
          }
        }
        cases.push({
          label: `${quality} ${label}`,
          pointSize,
          differing,
          largestDelta,
          painted,
        });
      }
    }
    return { supported: true, cases, error: gl.getError() };
  });

  expect(result.supported).toBe(true);
  expect(result.error).toBe(0);
  expect(result.cases.length).toBeGreaterThanOrEqual(18);
  for (const entry of result.cases) {
    // The scene must actually be drawn, or equality would prove nothing.
    expect(entry.painted, `${entry.label} at ${entry.pointSize} px`).toBeGreaterThan(500);
    expect(
      entry.differing,
      `${entry.label} at ${entry.pointSize} px (largest channel difference ${entry.largestDelta})`,
    ).toBe(0);
  }
});
