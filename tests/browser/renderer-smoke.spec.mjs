import { expect, test } from '@playwright/test';
import { dismissWelcome } from './helpers/welcome.mjs';

const CURRENT_UI_DATASET =
  '/tests/browser/fixtures/exports/current-ui-prepared/';

async function installReadPixelsAudit(page) {
  await page.addInitScript(() => {
    const original = WebGL2RenderingContext.prototype.readPixels;
    let calls = 0;
    WebGL2RenderingContext.prototype.readPixels = function (...args) {
      calls++;
      return Reflect.apply(original, this, args);
    };
    Object.defineProperty(window, '__cellucidReadPixelsCalls', {
      configurable: false,
      enumerable: false,
      get() {
        return calls;
      },
    });
  });
}

function createVelocityBytes(nCells) {
  const bytes = Buffer.alloc(
    nCells * 2 * Float32Array.BYTES_PER_ELEMENT,
  );
  for (let index = 0; index < nCells; index++) {
    bytes.writeFloatLE(0.01, index * 2 * 4);
    bytes.writeFloatLE((index % 3) * 0.0025, ((index * 2) + 1) * 4);
  }
  return bytes;
}

test('volumetric smoke completes its exact GPU density and noise path', async ({ page }) => {
  const browserErrors = [];
  let publishDensityReady;
  const densityReady = new Promise(resolve => {
    publishDensityReady = resolve;
  });
  let publishNoiseReady;
  const noiseReady = new Promise(resolve => {
    publishNoiseReady = resolve;
  });

  page.on('console', message => {
    if (message.type() === 'error') {
      browserErrors.push(`console: ${message.text()}`);
    }
    if (
      message.text().includes(
        '[SmokeRenderer] Created 3D density texture (32³)',
      )
    ) {
      publishDensityReady();
    }
    if (message.text().includes('[SmokeRenderer] Cloud noise textures ready')) {
      publishNoiseReady();
    }
  });
  page.on('pageerror', error => {
    browserErrors.push(`page: ${error.stack || error.message}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      browserErrors.push(`http ${response.status()}: ${response.url()}`);
    }
  });

  await page.goto(
    '/?exportsBaseUrl=http%3A%2F%2F127.0.0.1%3A4173%2Ftests%2Fbrowser%2Ffixtures%2Fexports%2F&dataset=current-ui-prepared&acceptance=renderer-smoke-ci',
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI prepared fixture');
  await page.locator('#smoke-grid').evaluate(input => {
    input.value = '0';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('#noise-resolution').evaluate(input => {
    input.value = '0';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#smoke-grid-display')).toHaveText('32³');
  await expect(page.locator('#noise-resolution-display')).toHaveText('32³');

  const renderMode = page.locator('#render-mode');
  await expect(renderMode).toHaveValue('points');
  await renderMode.selectOption('smoke');
  await expect(renderMode).toHaveValue('smoke');
  await Promise.all([densityReady, noiseReady]);
  await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));

  const webglError = await page.locator('#glcanvas').evaluate(canvas => (
    canvas.getContext('webgl2').getError()
  ));
  expect(webglError).toBe(0);
  expect(browserErrors).toEqual([]);
});

test('unavailable smoke mode rolls back the selector and retries cleanly', async ({
  page,
}) => {
  const browserErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') {
      browserErrors.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', error => {
    browserErrors.push(`page: ${error.stack || error.message}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      browserErrors.push(`http ${response.status()}: ${response.url()}`);
    }
  });
  await page.goto(
    '/?exportsBaseUrl=http%3A%2F%2F127.0.0.1%3A4173%2Ftests%2Fbrowser%2Ffixtures%2Fexports%2F&dataset=current-ui-prepared&acceptance=smoke-mode-rollback',
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );
  await page.locator('#smoke-grid').evaluate(input => {
    input.value = '0';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.evaluate(() => {
    const canvas = document.querySelector('#glcanvas');
    const gl = canvas?.getContext('webgl2');
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error('Smoke rollback fixture requires WebGL2');
    }
    const prototype = WebGL2RenderingContext.prototype;
    const original = prototype.getExtension;
    let rejectFloatBlend = true;
    prototype.getExtension = function (name) {
      if (
        this === gl
        && rejectFloatBlend
        && name === 'EXT_float_blend'
      ) {
        rejectFloatBlend = false;
        return null;
      }
      return Reflect.apply(original, this, [name]);
    };
    window.__restoreSmokeExtensionProbe = () => {
      prototype.getExtension = original;
      delete window.__restoreSmokeExtensionProbe;
    };
  });

  await page.locator('#render-mode').selectOption('smoke');
  await expect(page.locator('#render-mode')).toHaveValue('points');
  await expect(page.locator('#smoke-controls')).not.toHaveClass(/\bvisible\b/);
  await expect(page.locator('#points-controls')).toHaveClass(/\bvisible\b/);
  await expect(page.locator('#notification-center')).toContainText(
    'Smoke density unavailable',
  );
  await page.evaluate(() => window.__restoreSmokeExtensionProbe());

  await page.locator('#render-mode').selectOption('smoke');
  await expect(page.locator('#render-mode')).toHaveValue('smoke');
  await expect(page.locator('#smoke-controls')).toHaveClass(/\bvisible\b/);
  await expect(page.locator('#points-controls')).not.toHaveClass(/\bvisible\b/);
  expect(browserErrors).toEqual([]);
});

test('GPU smoke density matches its prior GPU reference without product readback', async ({
  page,
}) => {
  await installReadPixelsAudit(page);
  await page.goto(
    '/?exportsBaseUrl=http%3A%2F%2F127.0.0.1%3A4173%2Ftests%2Fbrowser%2Ffixtures%2Fexports%2F&dataset=current-ui-prepared&acceptance=smoke-density-oracle',
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );

  const proofs = await page.evaluate(async () => {
    const [
      {
        buildDensityTextureGPU,
        disposeDensityPipelineResources,
      },
      { buildPriorSmokeDensityReference },
    ] = await Promise.all([
      import('/assets/js/rendering/smoke-cloud/smoke-density.js'),
      import('/tests/browser/helpers/smoke-density-reference.mjs'),
    ]);
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const gl = canvas.getContext('webgl2');
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error('Smoke density oracle requires WebGL2');
    }
    const referenceCanvas = document.createElement('canvas');
    referenceCanvas.width = 16;
    referenceCanvas.height = 16;
    const referenceGl = referenceCanvas.getContext('webgl2');
    if (!(referenceGl instanceof WebGL2RenderingContext)) {
      throw new Error('Prior smoke density reference requires WebGL2');
    }
    const compileFixtureShader = (type, source) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('Smoke state shader allocation failed');
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(
          gl.getShaderInfoLog(shader) || 'Smoke state shader compilation failed'
        );
      }
      return shader;
    };
    const priorVertexShader = compileFixtureShader(
      gl.VERTEX_SHADER,
      '#version 300 es\nvoid main(){gl_Position=vec4(0.0);}',
    );
    const priorFragmentShader = compileFixtureShader(
      gl.FRAGMENT_SHADER,
      '#version 300 es\nprecision highp float;out vec4 color;void main(){color=vec4(1.0);}',
    );
    const priorProgram = gl.createProgram();
    if (!priorProgram) {
      throw new Error('Smoke density state program allocation failed');
    }
    gl.attachShader(priorProgram, priorVertexShader);
    gl.attachShader(priorProgram, priorFragmentShader);
    gl.linkProgram(priorProgram);
    gl.deleteShader(priorVertexShader);
    gl.deleteShader(priorFragmentShader);
    if (!gl.getProgramParameter(priorProgram, gl.LINK_STATUS)) {
      throw new Error(
        gl.getProgramInfoLog(priorProgram) || 'Smoke state program link failed'
      );
    }
    const priorDrawFramebuffer = gl.createFramebuffer();
    const priorReadFramebuffer = gl.createFramebuffer();
    const priorBuffer = gl.createBuffer();
    const priorVertexArray = gl.createVertexArray();
    if (
      !priorDrawFramebuffer
      || !priorReadFramebuffer
      || !priorBuffer
      || !priorVertexArray
    ) {
      throw new Error('Smoke density state fixture allocation failed');
    }
    const textureUnits = [gl.TEXTURE0, gl.TEXTURE1, gl.TEXTURE0 + 5];
    const priorTextures = [];
    const priorSamplers = [];
    for (const unit of textureUnits) {
      const texture2D = gl.createTexture();
      const texture3D = gl.createTexture();
      const sampler = gl.createSampler();
      if (!texture2D || !texture3D || !sampler) {
        throw new Error('Smoke density state texture allocation failed');
      }
      priorTextures.push(texture2D, texture3D);
      priorSamplers.push(sampler);
      gl.activeTexture(unit);
      gl.bindTexture(gl.TEXTURE_2D, texture2D);
      gl.bindTexture(gl.TEXTURE_3D, texture3D);
      gl.samplerParameteri(sampler, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.samplerParameteri(sampler, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.bindSampler(unit - gl.TEXTURE0, sampler);
    }
    gl.activeTexture(gl.TEXTURE0 + 5);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, priorDrawFramebuffer);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, priorReadFramebuffer);
    gl.bindVertexArray(priorVertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, priorBuffer);
    gl.useProgram(priorProgram);
    gl.enable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.RASTERIZER_DISCARD);
    gl.enable(gl.SCISSOR_TEST);
    gl.enable(gl.STENCIL_TEST);
    gl.disable(gl.DITHER);
    gl.blendFuncSeparate(
      gl.SRC_ALPHA,
      gl.ONE_MINUS_SRC_ALPHA,
      gl.DST_ALPHA,
      gl.ONE_MINUS_DST_ALPHA,
    );
    gl.blendEquationSeparate(gl.FUNC_REVERSE_SUBTRACT, gl.FUNC_SUBTRACT);
    gl.clearColor(0.125, 0.25, 0.5, 0.75);
    gl.colorMask(true, false, true, false);
    gl.viewport(1, 2, 3, 4);
    const snapshotState = () => {
      const activeTexture = gl.getParameter(gl.ACTIVE_TEXTURE);
      const textureBindings = textureUnits.map(unit => {
        gl.activeTexture(unit);
        return [
          gl.getParameter(gl.TEXTURE_BINDING_2D),
          gl.getParameter(gl.TEXTURE_BINDING_3D),
          gl.getParameter(gl.SAMPLER_BINDING),
        ];
      });
      gl.activeTexture(activeTexture);
      return {
        activeTexture,
        arrayBuffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING),
        blend: gl.isEnabled(gl.BLEND),
        blendDstAlpha: gl.getParameter(gl.BLEND_DST_ALPHA),
        blendDstRgb: gl.getParameter(gl.BLEND_DST_RGB),
        blendEquationAlpha: gl.getParameter(gl.BLEND_EQUATION_ALPHA),
        blendEquationRgb: gl.getParameter(gl.BLEND_EQUATION_RGB),
        blendSrcAlpha: gl.getParameter(gl.BLEND_SRC_ALPHA),
        blendSrcRgb: gl.getParameter(gl.BLEND_SRC_RGB),
        clearColor: Array.from(gl.getParameter(gl.COLOR_CLEAR_VALUE)),
        colorMask: Array.from(gl.getParameter(gl.COLOR_WRITEMASK)),
        cullFace: gl.isEnabled(gl.CULL_FACE),
        depthTest: gl.isEnabled(gl.DEPTH_TEST),
        dither: gl.isEnabled(gl.DITHER),
        drawFramebuffer: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),
        program: gl.getParameter(gl.CURRENT_PROGRAM),
        rasterizerDiscard: gl.isEnabled(gl.RASTERIZER_DISCARD),
        readFramebuffer: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
        scissorTest: gl.isEnabled(gl.SCISSOR_TEST),
        stencilTest: gl.isEnabled(gl.STENCIL_TEST),
        textureBindings,
        vertexArray: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
        viewport: Array.from(gl.getParameter(gl.VIEWPORT)),
      };
    };
    const stateMatches = (actual, expected) => (
      actual.activeTexture === expected.activeTexture
      && actual.arrayBuffer === expected.arrayBuffer
      && actual.blend === expected.blend
      && actual.blendDstAlpha === expected.blendDstAlpha
      && actual.blendDstRgb === expected.blendDstRgb
      && actual.blendEquationAlpha === expected.blendEquationAlpha
      && actual.blendEquationRgb === expected.blendEquationRgb
      && actual.blendSrcAlpha === expected.blendSrcAlpha
      && actual.blendSrcRgb === expected.blendSrcRgb
      && actual.clearColor.every(
        (value, index) => value === expected.clearColor[index]
      )
      && actual.colorMask.every(
        (value, index) => value === expected.colorMask[index]
      )
      && actual.cullFace === expected.cullFace
      && actual.depthTest === expected.depthTest
      && actual.dither === expected.dither
      && actual.drawFramebuffer === expected.drawFramebuffer
      && actual.program === expected.program
      && actual.rasterizerDiscard === expected.rasterizerDiscard
      && actual.readFramebuffer === expected.readFramebuffer
      && actual.scissorTest === expected.scissorTest
      && actual.stencilTest === expected.stencilTest
      && actual.textureBindings.every((bindings, unitIndex) => (
        bindings[0] === expected.textureBindings[unitIndex][0]
        && bindings[1] === expected.textureBindings[unitIndex][1]
        && bindings[2] === expected.textureBindings[unitIndex][2]
      ))
      && actual.vertexArray === expected.vertexArray
      && actual.viewport.every(
        (value, index) => value === expected.viewport[index]
      )
    );
    const stateBefore = snapshotState();

    const floatBuffer = new ArrayBuffer(Float32Array.BYTES_PER_ELEMENT);
    const floatValue = new Float32Array(floatBuffer);
    const floatBits = new Uint32Array(floatBuffer);
    const adjacentFloat32 = (value, direction) => {
      floatValue[0] = value;
      if (floatValue[0] === 0) {
        floatBits[0] = direction > 0 ? 1 : 0x80000001;
        return floatValue[0];
      }
      const increasingBits = (floatValue[0] > 0) === (direction > 0);
      floatBits[0] += increasingBits ? 1 : -1;
      return floatValue[0];
    };
    const overlappingWeights = [];
    const overlapBase = Math.fround(-1 / 7);
    const overlapBelow = adjacentFloat32(overlapBase, -1);
    const overlapAbove = adjacentFloat32(overlapBase, 1);
    for (let index = 0; index < 192; index++) {
      const values = [overlapBelow, overlapBase, overlapAbove];
      overlappingWeights.push(
        values[index % 3],
        values[(index * 5 + 1) % 3],
        values[(index * 7 + 2) % 3],
      );
    }
    const cases = [
      {
        gamma: 0.01,
        gridSize: 8,
        name: 'float32 cutoff discontinuity',
        positions: new Float32Array([
          -0.13999995589256287,
          -0.11428534239530563,
          -0.11428608745336533,
        ]),
      },
      {
        gamma: 5.101158048384629,
        gridSize: 8,
        name: 'high-gamma one-code boundary',
        positions: new Float32Array([
          -0.8637852668762207,
          0.303114116191864,
          -0.49895915389060974,
        ]),
      },
      {
        gamma: Math.fround(2.718281828459045),
        gridSize: 8,
        name: 'float32 additive accumulation',
        positions: new Float32Array(overlappingWeights),
      },
    ];

    const binary64Diagnostic = ({ gamma, gridSize, positions }) => {
      const accumulation = new Float32Array(gridSize ** 3);
      for (let point = 0; point < positions.length; point += 3) {
        const mapped = [
          ((positions[point] + 1) / 2) * (gridSize - 1),
          ((positions[point + 1] + 1) / 2) * (gridSize - 1),
          ((positions[point + 2] + 1) / 2) * (gridSize - 1),
        ];
        const base = mapped.map(value => Math.min(
          gridSize - 1,
          Math.max(0, Math.floor(value)),
        ));
        const fraction = mapped.map((value, axis) => value - base[axis]);
        for (let corner = 0; corner < 8; corner++) {
          const dx = corner & 1;
          const dy = (corner >> 1) & 1;
          const dz = (corner >> 2) & 1;
          const weight = (
            (dx === 0 ? 1 - fraction[0] : fraction[0])
            * (dy === 0 ? 1 - fraction[1] : fraction[1])
            * (dz === 0 ? 1 - fraction[2] : fraction[2])
          );
          if (weight < 0.0001) continue;
          const x = Math.min(gridSize - 1, base[0] + dx);
          const y = Math.min(gridSize - 1, base[1] + dy);
          const z = Math.min(gridSize - 1, base[2] + dz);
          accumulation[x + gridSize * (y + gridSize * z)] += weight;
        }
      }
      let maximum = 0;
      for (const value of accumulation) maximum = Math.max(maximum, value);
      return Uint8Array.from(
        accumulation,
        value => Math.floor(
          Math.pow(Math.min(1, value / maximum), gamma) * 255 + 0.5
        ),
      );
    };
    const maximumDifference = (left, right) => {
      let maximum = 0;
      for (let index = 0; index < left.length; index++) {
        maximum = Math.max(maximum, Math.abs(left[index] - right[index]));
      }
      return maximum;
    };
    const results = [];
    for (const testCase of cases) {
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, priorDrawFramebuffer);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, priorReadFramebuffer);
      const readbacksBeforeProduct = window.__cellucidReadPixelsCalls;
      const candidate = buildDensityTextureGPU(gl, testCase.positions, {
        gamma: testCase.gamma,
        gridSize: testCase.gridSize,
      });
      const readbacksBeforeReference = window.__cellucidReadPixelsCalls;
      const productReadbacks = (
        readbacksBeforeReference - readbacksBeforeProduct
      );
      const stateRestored = stateMatches(snapshotState(), stateBefore);

      const referenceReadbacksBefore = window.__cellucidReadPixelsCalls;
      const reference = buildPriorSmokeDensityReference(
        referenceGl,
        testCase.positions,
        {
          gamma: testCase.gamma,
          gridSize: testCase.gridSize,
        }
      );
      const referenceReadbacks = (
        window.__cellucidReadPixelsCalls - referenceReadbacksBefore
      );
      const framebuffer = gl.createFramebuffer();
      if (!framebuffer) {
        throw new Error('Product smoke oracle framebuffer allocation failed');
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      const actual = new Uint8Array(testCase.gridSize ** 3);
      for (let z = 0; z < testCase.gridSize; z++) {
        gl.framebufferTextureLayer(
          gl.FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          candidate.texture,
          0,
          z,
        );
        if (
          gl.checkFramebufferStatus(gl.FRAMEBUFFER)
          !== gl.FRAMEBUFFER_COMPLETE
        ) {
          throw new Error(
            `Product smoke oracle framebuffer layer ${z} is incomplete`
          );
        }
        gl.readPixels(
          0,
          0,
          testCase.gridSize,
          testCase.gridSize,
          gl.RED,
          gl.UNSIGNED_BYTE,
          actual,
          z * testCase.gridSize * testCase.gridSize,
        );
      }
      const diagnostic = binary64Diagnostic(testCase);
      results.push({
        binary64Difference: maximumDifference(
          diagnostic,
          reference.voxels
        ),
        maximumDifference: maximumDifference(actual, reference.voxels),
        name: testCase.name,
        productReadbacks,
        referenceReadbackPasses: reference.readbackPasses,
        referenceReadbacks,
        referenceResourcesReleased: reference.resourcesReleased,
        referenceWebglError: referenceGl.getError(),
        stateRestored,
        webglError: gl.getError(),
      });
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(candidate.texture);
    }

    const pipelineResourcesDisposed = disposeDensityPipelineResources(gl);
    for (const result of results) {
      result.nonNullProgramRestored = stateBefore.program === priorProgram;
      result.pipelineResourcesDisposed = pipelineResourcesDisposed;
    }
    gl.useProgram(null);
    gl.deleteProgram(priorProgram);
    gl.deleteFramebuffer(priorDrawFramebuffer);
    gl.deleteFramebuffer(priorReadFramebuffer);
    gl.deleteBuffer(priorBuffer);
    gl.deleteVertexArray(priorVertexArray);
    for (const texture of priorTextures) gl.deleteTexture(texture);
    for (const sampler of priorSamplers) gl.deleteSampler(sampler);
    return results;
  });

  expect(proofs).toHaveLength(3);
  for (const proof of proofs) {
    expect(proof.maximumDifference, proof.name).toBeLessThanOrEqual(1);
    expect(proof, proof.name).toMatchObject({
      productReadbacks: 0,
      nonNullProgramRestored: true,
      pipelineResourcesDisposed: true,
      referenceReadbackPasses: 2,
      referenceReadbacks: 2,
      referenceResourcesReleased: true,
      referenceWebglError: 0,
      stateRestored: true,
      webglError: 0,
    });
  }
  expect(
    proofs.some(proof => proof.binary64Difference > 0),
    JSON.stringify(proofs),
  ).toBe(true);
  expect(
    proofs.find(
      proof => proof.name === 'float32 cutoff discontinuity'
    )?.binary64Difference,
  ).toBeGreaterThanOrEqual(100);
});

test('smoke owns an empty filtered view without errors or stale density', async ({
  browserName,
  page,
}) => {
  await installReadPixelsAudit(page);
  const productErrors = [];
  const browserDiagnostics = [];
  page.on('console', message => {
    if (
      message.type() === 'warning' &&
      /GL Driver Message .*GPU stall due to ReadPixels/.test(message.text())
    ) {
      browserDiagnostics.push(message.text());
    } else if (message.type() === 'error' || message.type() === 'warning') {
      productErrors.push(`console ${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', error => {
    productErrors.push(`page: ${error.stack || error.message}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      productErrors.push(`http ${response.status()}: ${response.url()}`);
    }
  });

  await page.goto(
    '/?exportsBaseUrl=http%3A%2F%2F127.0.0.1%3A4173%2Ftests%2Fbrowser%2Ffixtures%2Fexports%2F&dataset=current-ui-prepared&acceptance=smoke-empty-filter',
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );
  await page.locator('#smoke-grid').evaluate(input => {
    input.value = '0';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#smoke-grid-display')).toHaveText('32³');
  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });

  const legend = page.locator('#legend');
  await legend.getByRole('button', { name: 'Hide All', exact: true }).click();
  await expect(page.locator('#filter-count')).toHaveText(
    'Showing 0 of 120 points',
  );

  const renderMode = page.locator('#render-mode');
  await renderMode.selectOption('smoke');
  await expect(renderMode).toHaveValue('smoke');
  await expect(page.locator('#smoke-controls')).toHaveClass(/visible/);
  await expect(page.locator('#points-controls')).not.toHaveClass(/visible/);
  expect(await page.evaluate(
    () => window._cellucidViewer.hasSmokeVolume(),
  )).toBe(false);

  await legend.getByRole('button', { name: 'Show All', exact: true }).click();
  await expect(page.locator('#filter-count')).toHaveText(
    'Showing all 120 points',
  );
  await expect.poll(
    () => page.evaluate(() => window._cellucidViewer.hasSmokeVolume()),
  ).toBe(true);

  await legend.getByRole('button', { name: 'Hide All', exact: true }).click();
  await expect(page.locator('#filter-count')).toHaveText(
    'Showing 0 of 120 points',
  );
  await expect.poll(
    () => page.evaluate(() => window._cellucidViewer.hasSmokeVolume()),
  ).toBe(false);
  await renderMode.selectOption('points');
  await renderMode.selectOption('smoke');
  await expect(renderMode).toHaveValue('smoke');
  await expect(page.locator('#smoke-controls')).toHaveClass(/visible/);
  expect(await page.evaluate(
    () => window._cellucidViewer.hasSmokeVolume(),
  )).toBe(false);
  expect(await page.evaluate(
    () => window.__cellucidReadPixelsCalls,
  )).toBe(0);

  const webglError = await page.locator('#glcanvas').evaluate(canvas => (
    canvas.getContext('webgl2').getError()
  ));
  expect(webglError).toBe(0);
  expect(productErrors).toEqual([]);
  expect(
    browserDiagnostics.every(message =>
      /GL Driver Message .*GPU stall due to ReadPixels/.test(message),
    ),
  ).toBe(true);
  expect(browserDiagnostics.length).toBeLessThanOrEqual(4);
  if (browserName !== 'chromium') {
    expect(browserDiagnostics).toEqual([]);
  }
});

test('every visible velocity slider endpoint reaches the GPU unchanged', async ({
  browserName,
  page,
}) => {
  const browserErrors = [];
  const browserDiagnostics = [];
  page.on('console', message => {
    if (
      message.type() === 'warning' &&
      /GL Driver Message .*GPU stall due to ReadPixels/.test(message.text())
    ) {
      browserDiagnostics.push(message.text());
    } else if (message.type() === 'error' || message.type() === 'warning') {
      browserErrors.push(`console ${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', error => {
    browserErrors.push(`page: ${error.stack || error.message}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      browserErrors.push(`http ${response.status()}: ${response.url()}`);
    }
  });

  await page.route(
    `**${CURRENT_UI_DATASET}dataset_identity.json`,
    async route => {
      const response = await route.fetch();
      const identity = await response.json();
      identity.vector_fields = {
        default_field: 'velocity_umap',
        fields: {
          velocity_umap: {
            label: 'velocity_umap',
            basis: 'umap',
            available_dimensions: [2],
            default_dimension: 2,
            files: {
              '2d': 'vectors/velocity_umap_2d.bin',
            },
          },
        },
      };
      await route.fulfill({ response, json: identity });
    },
  );
  await page.route(
    `**${CURRENT_UI_DATASET}vectors/velocity_umap_2d.bin`,
    route => route.fulfill({
      status: 200,
      contentType: 'application/octet-stream',
      body: createVelocityBytes(120),
    }),
  );

  await page.goto(
    '/?exportsBaseUrl=http%3A%2F%2F127.0.0.1%3A4173%2Ftests%2Fbrowser%2Ffixtures%2Fexports%2F&dataset=current-ui-prepared&acceptance=velocity-slider-endpoints',
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );
  await expect(page.locator('#velocity-overlay-enabled')).toBeEnabled();
  await page.locator('#velocity-overlay-enabled').check();
  await expect(
    page.getByText('Velocity overlay ready', { exact: true }),
  ).toBeVisible();

  const endpoints = [
    ['#velocity-speed', '5'],
    ['#velocity-lifetime', '10'],
    ['#velocity-size', '0.5'],
    ['#velocity-intensity', '0.05'],
    ['#velocity-exposure', '0.1'],
  ];
  for (const [selector, value] of endpoints) {
    await page.locator(selector).evaluate((input, nextValue) => {
      input.value = nextValue;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
    await expect(page.locator(selector)).toHaveValue(value);
  }

  await expect(page.locator('#velocity-speed-display')).toHaveText('0.05×');
  await expect(page.locator('#velocity-lifetime-display')).toHaveText('0.1s');
  await expect(page.locator('#velocity-size-display')).toHaveText('0.5');
  await expect(page.locator('#velocity-intensity-display')).toHaveText('0.05');
  await expect(page.locator('#velocity-exposure-display')).toHaveText('0.10');
  await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));

  const webglError = await page.locator('#glcanvas').evaluate(canvas => (
    canvas.getContext('webgl2').getError()
  ));
  expect(webglError).toBe(0);
  expect(browserErrors).toEqual([]);
  expect(
    browserDiagnostics.every(message =>
      /GL Driver Message .*GPU stall due to ReadPixels/.test(message),
    ),
  ).toBe(true);
  expect(browserDiagnostics.length).toBeLessThanOrEqual(4);
  if (browserName !== 'chromium') {
    expect(browserDiagnostics).toEqual([]);
  }
});

test('projectiles use the published full-resolution collision index', async ({ page }) => {
  const browserErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') {
      browserErrors.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', error => {
    browserErrors.push(`page: ${error.stack || error.message}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      browserErrors.push(`http ${response.status()}: ${response.url()}`);
    }
  });

  await page.goto(
    '/?exportsBaseUrl=http%3A%2F%2F127.0.0.1%3A4173%2Ftests%2Fbrowser%2Ffixtures%2Fexports%2F&dataset=current-ui-prepared&acceptance=renderer-projectile-ci',
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI prepared fixture');

  await page.locator('#navigation-mode').selectOption('free');
  await expect(page.locator('#navigation-mode')).toHaveValue('free');
  await page.locator('#projectiles-enabled').check();
  await page.waitForFunction(
    () => window._cellucidViewer.isProjectileSpatialIndexReady(),
  );

  const bounds = await page.locator('#glcanvas').boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(
    bounds.x + bounds.width * 0.75,
    bounds.y + bounds.height * 0.5,
  );
  await page.mouse.down();
  await page.waitForTimeout(120);
  await page.mouse.up();
  await page.waitForTimeout(750);

  const webglError = await page.locator('#glcanvas').evaluate(canvas => (
    canvas.getContext('webgl2').getError()
  ));
  expect(webglError).toBe(0);
  expect(browserErrors).toEqual([]);
});

test('spatial-index construction failures settle every owned notification', async ({
  page,
}) => {
  const browserErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') {
      browserErrors.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', error => {
    browserErrors.push(`page: ${error.stack || error.message}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      browserErrors.push(`http ${response.status()}: ${response.url()}`);
    }
  });

  await page.goto(
    '/?exportsBaseUrl=http%3A%2F%2F127.0.0.1%3A4173%2Ftests%2Fbrowser%2Ffixtures%2Fexports%2F&dataset=current-ui-prepared&acceptance=renderer-spatial-failure-ci',
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI prepared fixture');

  const result = await page.evaluate(async () => {
    const viewer = window._cellucidViewer;
    const originalTime = console.time;
    console.time = (label) => {
      if (label === 'Quadtree build') {
        throw new Error('synthetic spatial-index construction failure');
      }
      return originalTime.call(console, label);
    };
    try {
      return await new Promise((resolve) => {
        viewer.setProjectilesEnabled(true, resolve);
      });
    } finally {
      console.time = originalTime;
    }
  });

  expect(result).toEqual({
    status: 'error',
    message:
      'Projectile preparation failed: synthetic spatial-index construction failure',
  });
  await expect(page.locator('.notification-loading')).toHaveCount(0);
  await expect(page.locator('.notification-error')).toContainText(
    '2D Quadtree failed: synthetic spatial-index construction failure',
  );
  const webglError = await page.locator('#glcanvas').evaluate(canvas => (
    canvas.getContext('webgl2').getError()
  ));
  expect(webglError).toBe(0);
  expect(browserErrors).toEqual([]);
});
