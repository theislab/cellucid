import { expect, test } from '@playwright/test';
import { dismissWelcome } from './helpers/welcome.mjs';

const CURRENT_UI_DATASET =
  '/tests/browser/fixtures/exports/current-ui-prepared/';
const WEBGL_HARNESS = '/tests/browser/fixtures/webgl-harness.html';

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

  const clearColorBefore = await page.locator('#glcanvas').evaluate(canvas => {
    const gl = canvas.getContext('webgl2');
    return Array.from(gl.getParameter(gl.COLOR_CLEAR_VALUE));
  });
  const renderMode = page.locator('#render-mode');
  await expect(renderMode).toHaveValue('points');
  await renderMode.selectOption('smoke');
  await expect(renderMode).toHaveValue('smoke');
  await Promise.all([densityReady, noiseReady]);
  await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));

  const smokeState = await page.locator('#glcanvas').evaluate(canvas => {
    const gl = canvas.getContext('webgl2');
    return {
      clearColor: Array.from(gl.getParameter(gl.COLOR_CLEAR_VALUE)),
      depth: gl.isEnabled(gl.DEPTH_TEST),
      error: gl.getError(),
      framebufferIsDefault:
        gl.getParameter(gl.FRAMEBUFFER_BINDING) === null,
    };
  });
  expect(smokeState).toEqual({
    clearColor: clearColorBefore,
    depth: true,
    error: 0,
    framebufferIsDefault: true,
  });
  await renderMode.selectOption('points');
  await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  const pointsState = await page.locator('#glcanvas').evaluate(canvas => {
    const gl = canvas.getContext('webgl2');
    return {
      clearColor: Array.from(gl.getParameter(gl.COLOR_CLEAR_VALUE)),
      error: gl.getError(),
      framebufferIsDefault:
        gl.getParameter(gl.FRAMEBUFFER_BINDING) === null,
    };
  });
  expect(pointsState).toEqual({
    clearColor: clearColorBefore,
    error: 0,
    framebufferIsDefault: true,
  });
  expect(browserErrors).toEqual([]);
});

test('render-mode switch cancels one pending noise transaction and restarts cleanly', async ({
  page,
}) => {
  const browserErrors = [];
  let noiseReadyPublications = 0;
  let publishNoiseReady;
  const noiseReady = new Promise(resolve => {
    publishNoiseReady = resolve;
  });
  page.on('console', message => {
    if (message.type() === 'error') {
      browserErrors.push(`console: ${message.text()}`);
    }
    if (message.text().includes('[SmokeRenderer] Cloud noise textures ready')) {
      noiseReadyPublications++;
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
    '/?exportsBaseUrl=http%3A%2F%2F127.0.0.1%3A4173%2Ftests%2Fbrowser%2Ffixtures%2Fexports%2F&dataset=current-ui-prepared&acceptance=smoke-mode-generation-cancellation',
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await page.locator('#smoke-grid').evaluate(input => {
    input.value = '0';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('#noise-resolution').evaluate(input => {
    input.value = '0';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  const renderMode = page.locator('#render-mode');
  await renderMode.selectOption('smoke');
  await page.waitForFunction(() =>
    window._cellucidViewer?.hasPendingSmokeNoiseGeneration() === true
  );
  expect(await page.evaluate(() => ({
    pending:
      window._cellucidViewer.hasPendingSmokeNoiseGeneration(),
    textures: window._cellucidViewer.hasSmokeNoiseTextures(),
  }))).toEqual({
    pending: true,
    textures: false,
  });

  await renderMode.selectOption('points');
  await expect(renderMode).toHaveValue('points');
  await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  expect(await page.evaluate(() => ({
    pending:
      window._cellucidViewer.hasPendingSmokeNoiseGeneration(),
    textures: window._cellucidViewer.hasSmokeNoiseTextures(),
  }))).toEqual({
    pending: false,
    textures: false,
  });
  expect(noiseReadyPublications).toBe(0);

  await renderMode.selectOption('smoke');
  await Promise.all([
    noiseReady,
    expect(renderMode).toHaveValue('smoke'),
  ]);
  expect(await page.evaluate(() => ({
    pending:
      window._cellucidViewer.hasPendingSmokeNoiseGeneration(),
    textures: window._cellucidViewer.hasSmokeNoiseTextures(),
  }))).toEqual({
    pending: false,
    textures: true,
  });
  expect(noiseReadyPublications).toBe(1);
  expect(browserErrors).toEqual([]);
});

test('smoke noise resolution remains isolated between renderer instances', async ({
  page,
}) => {
  await page.goto(WEBGL_HARNESS);
  const proof = await page.evaluate(async () => {
    const [
      { createProgram },
      { SmokeRenderer },
    ] = await Promise.all([
      import('/assets/js/rendering/gl-utils.js'),
      import('/assets/js/rendering/smoke-cloud/smoke-renderer.js'),
    ]);
    const createRenderer = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 4;
      canvas.height = 4;
      const gl = canvas.getContext('webgl2', {
        alpha: true,
        antialias: false,
      });
      if (!(gl instanceof WebGL2RenderingContext)) {
        throw new Error('Smoke resolution isolation requires WebGL2');
      }
      return {
        gl,
        renderer: new SmokeRenderer(gl, createProgram),
      };
    };
    const first = createRenderer();
    const second = createRenderer();
    let firstDisposed = false;
    let secondDisposed = false;
    try {
      first.renderer.setNoiseTextureResolution(32);
      const secondDefault = {
        adaptiveScale: second.renderer.getAdaptiveScaleFactor(),
        noiseResolution: second.renderer.getNoiseTextureResolution(),
        noiseScale: second.renderer.noiseScale,
      };
      second.renderer.setNoiseTextureResolution(64);

      for (const owner of [first, second]) {
        const densityTexture = owner.gl.createTexture();
        if (!densityTexture) {
          throw new Error('Smoke resolution density allocation failed');
        }
        owner.renderer.textureInfo = {
          gridSize: 8,
          is3D: true,
          texture: densityTexture,
        };
        owner.renderer.render({});
      }
      const transactions = [
        first.renderer._noiseGenerationTransaction,
        second.renderer._noiseGenerationTransaction,
      ];
      if (transactions.some(transaction => transaction === null)) {
        throw new Error('Smoke resolution generation transaction was not started');
      }
      await Promise.all(
        transactions.map(transaction => transaction.completion)
      );
      await Promise.resolve();

      const generated = {
        first: {
          advertised: first.renderer.getNoiseTextureResolution(),
          detail: first.renderer.noiseTextures?.detailSize,
          shape: first.renderer.noiseTextures?.shapeSize,
        },
        second: {
          advertised: second.renderer.getNoiseTextureResolution(),
          detail: second.renderer.noiseTextures?.detailSize,
          shape: second.renderer.noiseTextures?.shapeSize,
        },
      };
      firstDisposed = first.renderer.dispose();
      secondDisposed = second.renderer.dispose();
      return {
        disposed: {
          first: firstDisposed,
          second: secondDisposed,
        },
        errors: [
          first.gl.getError(),
          second.gl.getError(),
        ],
        generated,
        secondDefault,
      };
    } finally {
      if (!firstDisposed) first.renderer.dispose();
      if (!secondDisposed) second.renderer.dispose();
    }
  });

  expect(proof).toEqual({
    disposed: {
      first: true,
      second: true,
    },
    errors: [0, 0],
    generated: {
      first: {
        advertised: 32,
        detail: 32,
        shape: 32,
      },
      second: {
        advertised: 64,
        detail: 64,
        shape: 64,
      },
    },
    secondDefault: {
      adaptiveScale: 0.75,
      noiseResolution: 128,
      noiseScale: 0.75,
    },
  });
});

test('smoke shader consumes the exact CPU light-sample ceiling', async ({
  page,
}) => {
  await page.goto(WEBGL_HARNESS);
  const proof = await page.evaluate(async () => {
    const [
      { createProgram },
      { SmokeRenderer },
      { MAX_SMOKE_LIGHT_SAMPLES },
    ] = await Promise.all([
      import('/assets/js/rendering/gl-utils.js'),
      import('/assets/js/rendering/smoke-cloud/smoke-renderer.js'),
      import('/assets/js/rendering/shaders/smoke-shaders.js'),
    ]);
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      preserveDrawingBuffer: true,
    });
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error('Smoke light-sample proof requires WebGL2');
    }
    const renderer = new SmokeRenderer(gl, createProgram);
    let disposed = false;
    const createTexture3D = (
      internalFormat,
      format,
      channelCount,
      value,
    ) => {
      const size = 8;
      const texture = gl.createTexture();
      if (!texture) {
        throw new Error('Smoke light-sample 3D texture allocation failed');
      }
      const data = new Uint8Array(
        size * size * size * channelCount,
      );
      data.fill(value);
      gl.bindTexture(gl.TEXTURE_3D, texture);
      gl.texImage3D(
        gl.TEXTURE_3D,
        0,
        internalFormat,
        size,
        size,
        size,
        0,
        format,
        gl.UNSIGNED_BYTE,
        data,
      );
      gl.generateMipmap(gl.TEXTURE_3D);
      gl.texParameteri(
        gl.TEXTURE_3D,
        gl.TEXTURE_MIN_FILTER,
        gl.LINEAR_MIPMAP_LINEAR,
      );
      gl.texParameteri(
        gl.TEXTURE_3D,
        gl.TEXTURE_MAG_FILTER,
        gl.LINEAR,
      );
      for (const parameter of [
        gl.TEXTURE_WRAP_S,
        gl.TEXTURE_WRAP_T,
        gl.TEXTURE_WRAP_R,
      ]) {
        gl.texParameteri(gl.TEXTURE_3D, parameter, gl.REPEAT);
      }
      return texture;
    };
    try {
      const densityTexture = createTexture3D(
        gl.R8,
        gl.RED,
        1,
        96,
      );
      const shapeTexture = createTexture3D(
        gl.RGBA8,
        gl.RGBA,
        4,
        128,
      );
      const detailTexture = createTexture3D(
        gl.RGBA8,
        gl.RGBA,
        4,
        128,
      );
      const blueNoiseTexture = gl.createTexture();
      if (!blueNoiseTexture) {
        throw new Error('Smoke light-sample blue-noise allocation failed');
      }
      gl.bindTexture(gl.TEXTURE_2D, blueNoiseTexture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RG8,
        1,
        1,
        0,
        gl.RG,
        gl.UNSIGNED_BYTE,
        new Uint8Array([0, 0]),
      );
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MIN_FILTER,
        gl.NEAREST,
      );
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MAG_FILTER,
        gl.NEAREST,
      );

      renderer.textureInfo = {
        gridSize: 128,
        is3D: true,
        texture: densityTexture,
      };
      renderer.noiseTextures = {
        blueNoise: blueNoiseTexture,
        detail: detailTexture,
        shape: shapeTexture,
      };
      renderer.setResolutionScale(1);
      renderer.setParams({
        animationSpeed: 0,
        density: 0.02,
        detailLevel: 0,
        directLightIntensity: 2,
        edgeSoftness: 0,
        lightAbsorption: 2,
        noiseScale: 1,
        scatterStrength: 1,
        stepMultiplier: 4,
        warpStrength: 0,
      });

      const renderArgs = {
        eye: new Float32Array([0, 0, 2]),
        height: 64,
        invViewProjMatrix: new Float32Array([
          1, 0, 0, 0,
          0, 1, 0, 0,
          0, 0, 1, 0,
          0, 0, 0, 1,
        ]),
        lightDir: new Float32Array([1, 0, 0]),
        width: 64,
      };
      const frames = new Map();
      for (const lightSamples of [
        7,
        8,
        MAX_SMOKE_LIGHT_SAMPLES,
      ]) {
        renderer.setParams({ lightSamples });
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        renderer.render(renderArgs);
        const pixels = new Uint8Array(64 * 64 * 4);
        gl.readPixels(
          0,
          0,
          64,
          64,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          pixels,
        );
        frames.set(lightSamples, pixels);
      }
      const differingBytes = (left, right) => {
        let count = 0;
        for (let index = 0; index < left.length; index++) {
          if (left[index] !== right[index]) count++;
        }
        return count;
      };
      const result = {
        error: gl.getError(),
        maximum: MAX_SMOKE_LIGHT_SAMPLES,
        sevenToEight: differingBytes(frames.get(7), frames.get(8)),
        eightToMaximum: differingBytes(
          frames.get(8),
          frames.get(MAX_SMOKE_LIGHT_SAMPLES),
        ),
      };
      disposed = renderer.dispose();
      return {
        ...result,
        disposed,
      };
    } finally {
      if (!disposed) renderer.dispose();
    }
  });

  expect(proof.maximum).toBe(12);
  expect(proof.sevenToEight).toBeGreaterThan(0);
  expect(proof.eightToMaximum).toBeGreaterThan(0);
  expect(proof.error).toBe(0);
  expect(proof.disposed).toBe(true);
});

test('UI restore synchronously owns real DOM listener failures', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => {
    pageErrors.push(error.stack || error.message);
  });
  await page.goto(WEBGL_HARNESS);

  const proof = await page.evaluate(async () => {
    const { createUiControlSerializer } = await import(
      '/assets/js/app/state-serializer/ui-controls.js'
    );
    const sidebar = document.createElement('div');
    const resolution = document.createElement('input');
    resolution.id = 'cloud-resolution';
    resolution.type = 'range';
    resolution.min = '0';
    resolution.max = '100';
    resolution.value = '15';
    sidebar.appendChild(resolution);
    document.body.appendChild(sidebar);

    const ownerFailure = new Error(
      'synthetic smoke target owner failure',
    );
    resolution.addEventListener('input', () => {
      throw ownerFailure;
    });
    const serializer = createUiControlSerializer({ sidebar });
    let caught = null;
    try {
      serializer.restoreUIControls({
        'cloud-resolution': { type: 'range', value: '43' },
      });
    } catch (error) {
      caught = {
        message: error.message,
        sameOwner: error === ownerFailure,
      };
    }
    await Promise.resolve();
    return {
      caught,
      publishedValue: resolution.value,
    };
  });

  expect(proof).toEqual({
    caught: {
      message: 'synthetic smoke target owner failure',
      sameOwner: true,
    },
    publishedValue: '43',
  });
  expect(pageErrors).toEqual([]);
});

test('half-resolution smoke overwrites its private target without corrupting persistent GL state', async ({
  page,
}) => {
  await page.goto(WEBGL_HARNESS);
  const proof = await page.evaluate(async () => {
    const { SmokeRenderer } = await import(
      '/assets/js/rendering/smoke-cloud/smoke-renderer.js'
    );
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 4;
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: true,
      preserveDrawingBuffer: true,
    });
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error('Half-resolution smoke proof requires WebGL2');
    }

    const compileProgram = (vertexSource, fragmentSource) => {
      const compile = (type, source) => {
        const shader = gl.createShader(type);
        if (!shader) throw new Error('Smoke proof shader allocation failed');
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          const message = gl.getShaderInfoLog(shader);
          gl.deleteShader(shader);
          throw new Error(message || 'Smoke proof shader compilation failed');
        }
        return shader;
      };
      const vertexShader = compile(gl.VERTEX_SHADER, vertexSource);
      const fragmentShader = compile(gl.FRAGMENT_SHADER, fragmentSource);
      const program = gl.createProgram();
      if (!program) throw new Error('Smoke proof program allocation failed');
      gl.attachShader(program, vertexShader);
      gl.attachShader(program, fragmentShader);
      gl.linkProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(
          gl.getProgramInfoLog(program) || 'Smoke proof program link failed'
        );
      }
      return program;
    };
    const vertexSource = `#version 300 es
      in vec2 a_position;
      out vec2 v_uv;
      void main() {
        v_uv = a_position * 0.5 + 0.5;
        gl_Position = vec4(a_position, 0.0, 1.0);
      }`;
    const smokeProgram = compileProgram(
      vertexSource,
      `#version 300 es
        precision highp float;
        out vec4 fragColor;
        void main() {
          fragColor = vec4(0.4, 0.2, 0.1, 0.5);
        }`,
    );
    const compositeProgram = compileProgram(
      vertexSource,
      `#version 300 es
        precision highp float;
        in vec2 v_uv;
        uniform sampler2D u_smokeTex;
        out vec4 fragColor;
        void main() {
          fragColor = texture(u_smokeTex, v_uv);
        }`,
    );
    const quadBuffer = gl.createBuffer();
    const smokeVertexArray = gl.createVertexArray();
    const compositeVertexArray = gl.createVertexArray();
    const densityTexture = gl.createTexture();
    const shapeTexture = gl.createTexture();
    const detailTexture = gl.createTexture();
    const blueNoiseTexture = gl.createTexture();
    if (
      !quadBuffer
      || !smokeVertexArray
      || !compositeVertexArray
      || !densityTexture
      || !shapeTexture
      || !detailTexture
      || !blueNoiseTexture
    ) {
      throw new Error('Smoke proof resource allocation failed');
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    const configureVertexArray = (vertexArray, program) => {
      gl.bindVertexArray(vertexArray);
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
      const location = gl.getAttribLocation(program, 'a_position');
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
      return location;
    };
    const smokePosition = configureVertexArray(smokeVertexArray, smokeProgram);
    const compositePosition = configureVertexArray(
      compositeVertexArray,
      compositeProgram,
    );
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    const renderer = Object.create(SmokeRenderer.prototype);
    Object.assign(renderer, {
      animationSpeed: 0,
      color: new Float32Array([1, 1, 1]),
      colorTex: null,
      compositeAttribLocations: { position: compositePosition },
      compositeProgram,
      compositeUniformLocations: {
        intensity: null,
        inverseResolution: null,
        smokeTex: gl.getUniformLocation(compositeProgram, 'u_smokeTex'),
      },
      compositeVertexArray,
      density: 1,
      detailLevel: 1,
      directLight: 0,
      edgeSoftness: 0,
      frameIndex: 0,
      framebuffer: null,
      gl,
      lightAbsorption: 1,
      lightSamples: 1,
      noiseGenerationError: null,
      noiseGenerationInProgress: false,
      noiseScale: 1,
      noiseTextures: {
        blueNoise: blueNoiseTexture,
        detail: detailTexture,
        shape: shapeTexture,
      },
      quadBuffer,
      resolutionScale: 0.5,
      scatterStrength: 0,
      smokeAttribLocations: { position: smokePosition },
      smokeProgram,
      smokeUniformLocations: Object.fromEntries([
        'animationSpeed',
        'bgColor',
        'blueNoise',
        'blueNoiseOffset',
        'cameraPos',
        'densityMultiplier',
        'densityTex3D',
        'detailLevel',
        'detailNoise',
        'directLight',
        'edgeSoftness',
        'gridSize',
        'invViewProj',
        'lightAbsorption',
        'lightDir',
        'lightSamples',
        'noiseScale',
        'scatterStrength',
        'shapeNoise',
        'smokeColor',
        'stepMultiplier',
        'time',
        'volumeMax',
        'volumeMin',
        'warpStrength',
      ].map(name => [name, null])),
      smokeVertexArray,
      startTime: performance.now(),
      stepMultiplier: 1,
      targetHeight: 0,
      targetWidth: 0,
      textureInfo: {
        gridSize: 8,
        is3D: true,
        texture: densityTexture,
      },
      volumeMax: new Float32Array([1, 1, 1]),
      volumeMin: new Float32Array([-1, -1, -1]),
      warpStrength: 0,
    });
    const renderArgs = {
      bgColor: new Float32Array([0, 0, 0]),
      eye: new Float32Array([0, 0, 2]),
      height: 4,
      invViewProjMatrix: new Float32Array([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
      ]),
      lightDir: new Float32Array([0, 0, 1]),
      width: 4,
    };
    const readOwnedPixel = () => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, renderer.framebuffer);
      const pixel = new Uint8Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return Array.from(pixel);
    };

    gl.clearColor(0.125, 0.25, 0.5, 0.75);
    const clearColorBefore = Array.from(
      gl.getParameter(gl.COLOR_CLEAR_VALUE),
    );
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    renderer.render(renderArgs);
    const firstPixel = readOwnedPixel();
    renderer.render(renderArgs);
    const secondPixel = readOwnedPixel();
    const frameIndexBeforeFailure = renderer.frameIndex;
    const prototype = WebGL2RenderingContext.prototype;
    const originalDrawArrays = prototype.drawArrays;
    let rejectNextDraw = true;
    prototype.drawArrays = function (...args) {
      if (this === gl && rejectNextDraw) {
        rejectNextDraw = false;
        throw new Error('synthetic smoke ray-march draw failure');
      }
      return Reflect.apply(originalDrawArrays, this, args);
    };
    let failure = null;
    try {
      renderer.render(renderArgs);
    } catch (error) {
      failure = {
        message: error.message,
        name: error.name,
      };
    } finally {
      prototype.drawArrays = originalDrawArrays;
    }
    const failureState = {
      blend: gl.isEnabled(gl.BLEND),
      clearColor: Array.from(gl.getParameter(gl.COLOR_CLEAR_VALUE)),
      depth: gl.isEnabled(gl.DEPTH_TEST),
      error: gl.getError(),
      frameIndex: renderer.frameIndex,
      framebufferIsDefault:
        gl.getParameter(gl.FRAMEBUFFER_BINDING) === null,
      viewport: Array.from(gl.getParameter(gl.VIEWPORT)),
    };
    renderer.render(renderArgs);
    const retryPixel = readOwnedPixel();
    const state = {
      blend: gl.isEnabled(gl.BLEND),
      clearColor: Array.from(gl.getParameter(gl.COLOR_CLEAR_VALUE)),
      depth: gl.isEnabled(gl.DEPTH_TEST),
      error: gl.getError(),
      framebuffer: gl.getParameter(gl.FRAMEBUFFER_BINDING),
      viewport: Array.from(gl.getParameter(gl.VIEWPORT)),
    };

    gl.deleteFramebuffer(renderer.framebuffer);
    gl.deleteTexture(renderer.colorTex);
    gl.deleteTexture(densityTexture);
    gl.deleteTexture(shapeTexture);
    gl.deleteTexture(detailTexture);
    gl.deleteTexture(blueNoiseTexture);
    gl.deleteBuffer(quadBuffer);
    gl.deleteVertexArray(smokeVertexArray);
    gl.deleteVertexArray(compositeVertexArray);
    gl.deleteProgram(smokeProgram);
    gl.deleteProgram(compositeProgram);
    return {
      clearColorBefore,
      failure,
      failureState,
      firstPixel,
      frameIndexBeforeFailure,
      retryPixel,
      secondPixel,
      state: {
        ...state,
        framebufferIsDefault: state.framebuffer === null,
      },
    };
  });

  const expectedPixel = [102, 51, 26, 128];
  for (const pixel of [
    proof.firstPixel,
    proof.secondPixel,
    proof.retryPixel,
  ]) {
    pixel.forEach((value, index) => {
      expect(Math.abs(value - expectedPixel[index])).toBeLessThanOrEqual(1);
    });
  }
  expect(proof.failure).toEqual({
    message: 'synthetic smoke ray-march draw failure',
    name: 'Error',
  });
  expect(proof.failureState).toEqual({
    blend: true,
    clearColor: proof.clearColorBefore,
    depth: true,
    error: 0,
    frameIndex: proof.frameIndexBeforeFailure,
    framebufferIsDefault: true,
    viewport: [0, 0, 4, 4],
  });
  expect(proof.state).toEqual({
    blend: true,
    clearColor: proof.clearColorBefore,
    depth: true,
    error: 0,
    framebuffer: null,
    framebufferIsDefault: true,
    viewport: [0, 0, 4, 4],
  });
});

test('failed real smoke target allocation reports and drains its WebGL error', async ({
  page,
}) => {
  await page.goto(WEBGL_HARNESS);
  const proof = await page.evaluate(async () => {
    const { SmokeRenderer } = await import(
      '/assets/js/rendering/smoke-cloud/smoke-renderer.js'
    );
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error('Smoke target failure proof requires WebGL2');
    }

    const callerDrawFramebuffer = gl.createFramebuffer();
    const callerReadFramebuffer = gl.createFramebuffer();
    const callerPixelUnpackBuffer = gl.createBuffer();
    const callerTexture = gl.createTexture();
    if (
      !callerDrawFramebuffer
      || !callerReadFramebuffer
      || !callerPixelUnpackBuffer
      || !callerTexture
    ) {
      throw new Error('Smoke target failure fixture allocation failed');
    }
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, callerTexture);
    gl.bindFramebuffer(
      gl.DRAW_FRAMEBUFFER,
      callerDrawFramebuffer,
    );
    gl.bindFramebuffer(
      gl.READ_FRAMEBUFFER,
      callerReadFramebuffer,
    );
    gl.bindBuffer(
      gl.PIXEL_UNPACK_BUFFER,
      callerPixelUnpackBuffer,
    );
    gl.bufferData(gl.PIXEL_UNPACK_BUFFER, 16, gl.STATIC_DRAW);

    const renderer = Object.assign(
      Object.create(SmokeRenderer.prototype),
      {
        colorTex: null,
        framebuffer: null,
        gl,
        resolutionScale: 1,
        targetHeight: 0,
        targetWidth: 0,
      },
    );
    const maximumTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    let failure = null;
    try {
      renderer.ensureRenderTarget(maximumTextureSize + 1, 1);
    } catch (error) {
      failure = {
        message: error.message,
        name: error.name,
      };
    }
    const state = {
      activeTexturePreserved:
        gl.getParameter(gl.ACTIVE_TEXTURE) === gl.TEXTURE2,
      drawFramebufferPreserved:
        gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
          === callerDrawFramebuffer,
      error: gl.getError(),
      pixelUnpackBufferPreserved:
        gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING)
          === callerPixelUnpackBuffer,
      publishedFramebuffer: renderer.framebuffer !== null,
      publishedHeight: renderer.targetHeight,
      publishedTexture: renderer.colorTex !== null,
      publishedWidth: renderer.targetWidth,
      readFramebufferPreserved:
        gl.getParameter(gl.READ_FRAMEBUFFER_BINDING)
          === callerReadFramebuffer,
      texturePreserved:
        gl.getParameter(gl.TEXTURE_BINDING_2D) === callerTexture,
    };

    renderer.ensureRenderTarget(4, 4);
    const success = {
      error: gl.getError(),
      pixelUnpackBufferPreserved:
        gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING)
          === callerPixelUnpackBuffer,
      publishedFramebuffer: renderer.framebuffer !== null,
      publishedHeight: renderer.targetHeight,
      publishedTexture: renderer.colorTex !== null,
      publishedWidth: renderer.targetWidth,
    };

    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.deleteFramebuffer(renderer.framebuffer);
    gl.deleteTexture(renderer.colorTex);
    gl.deleteFramebuffer(callerDrawFramebuffer);
    gl.deleteFramebuffer(callerReadFramebuffer);
    gl.deleteBuffer(callerPixelUnpackBuffer);
    gl.deleteTexture(callerTexture);
    return { failure, state, success };
  });

  expect(proof.failure.name).toBe('Error');
  expect(proof.failure.message).toMatch(
    /candidate render-target publication.*0x501/i,
  );
  expect(proof.state).toEqual({
    activeTexturePreserved: true,
    drawFramebufferPreserved: true,
    error: 0,
    pixelUnpackBufferPreserved: true,
    publishedFramebuffer: false,
    publishedHeight: 0,
    publishedTexture: false,
    publishedWidth: 0,
    readFramebufferPreserved: true,
    texturePreserved: true,
  });
  expect(proof.success).toEqual({
    error: 0,
    pixelUnpackBufferPreserved: true,
    publishedFramebuffer: true,
    publishedHeight: 4,
    publishedTexture: true,
    publishedWidth: 4,
  });
});

test('smoke resolution change cancels partial noise generation and retries exact cleanup', async ({
  page,
}) => {
  await page.goto(WEBGL_HARNESS);
  const proof = await page.evaluate(async () => {
    const { SmokeRenderer } = await import(
      '/assets/js/rendering/smoke-cloud/smoke-renderer.js'
    );
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error('Stale smoke noise proof requires WebGL2');
    }
    const renderer = Object.assign(
      Object.create(SmokeRenderer.prototype),
      {
        contextLost: false,
        disposed: false,
        gl,
        noiseGenerationError: null,
        noiseGenerationInProgress: false,
        noiseGenerationToken: 0,
        noiseResolution: 128,
        noiseScale: 1,
        noiseTextures: null,
        textureInfo: {},
      },
    );
    renderer.setNoiseTextureResolution(32);
    renderer.render({});
    while (
      renderer._noiseGenerationTransaction?._phase !== 'shape-slices'
    ) {
      await new Promise(resolve => requestAnimationFrame(resolve));
    }

    const prototype = WebGL2RenderingContext.prototype;
    const originalDeleteTexture = prototype.deleteTexture;
    const attemptedTextures = [];
    let rejectedTexture = null;
    prototype.deleteTexture = function (texture) {
      if (this === gl) {
        attemptedTextures.push(texture);
        if (rejectedTexture === null) {
          rejectedTexture = texture;
          throw new Error('synthetic stale smoke texture deletion failure');
        }
      }
      return Reflect.apply(originalDeleteTexture, this, [texture]);
    };
    let changeFailure = null;
    try {
      renderer.setNoiseTextureResolution(64);
    } catch (error) {
      changeFailure = {
        message: error.message,
        name: error.name,
      };
    } finally {
      prototype.deleteTexture = originalDeleteTexture;
    }
    await Promise.resolve();
    const transactionRetainedAfterFailure =
      renderer._noiseGenerationTransaction !== null;
    renderer.setNoiseTextureResolution(64);
    const result = {
      attemptedTextureCount: attemptedTextures.length,
      changeFailure,
      contextLost: renderer.contextLost,
      disposed: renderer.disposed,
      generationError: renderer.noiseGenerationError,
      generationInProgress: renderer.noiseGenerationInProgress,
      publishedTextures: renderer.noiseTextures !== null,
      retryResolution: renderer.noiseResolution,
      transactionRetainedAfterFailure,
      transactionRetiredAfterRetry:
        renderer._noiseGenerationTransaction === null,
      webglError: gl.getError(),
    };
    return result;
  });

  expect(proof).toEqual({
    attemptedTextureCount: 1,
    changeFailure: {
      message: 'synthetic stale smoke texture deletion failure',
      name: 'Error',
    },
    contextLost: false,
    disposed: false,
    generationError: null,
    generationInProgress: false,
    publishedTextures: false,
    retryResolution: 64,
    transactionRetainedAfterFailure: true,
    transactionRetiredAfterRetry: true,
    webglError: 0,
  });
});

test('terminal smoke noise cancellation is synchronous, retry-owned, and context-loss safe', async ({
  page,
}) => {
  await page.goto(WEBGL_HARNESS);
  const proof = await page.evaluate(async () => {
    const { SmokeRenderer } = await import(
      '/assets/js/rendering/smoke-cloud/smoke-renderer.js'
    );
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error('Terminal smoke noise proof requires WebGL2');
    }
    const prototype = WebGL2RenderingContext.prototype;
    const originalDeleteTexture = prototype.deleteTexture;

    const runScenario = async (transition) => {
      const renderer = Object.assign(
        Object.create(SmokeRenderer.prototype),
        {
          colorTex: null,
          compositeProgram: null,
          compositeVertexArray: null,
          contextLost: false,
          disposed: false,
          framebuffer: null,
          gl,
          noiseGenerationError: null,
          noiseGenerationInProgress: false,
          noiseGenerationToken: 0,
          noiseResolution: 32,
          noiseScale: 1,
          noiseTextures: null,
          quadBuffer: null,
          smokeProgram: null,
          smokeVertexArray: null,
          targetHeight: 0,
          targetWidth: 0,
          textureInfo: {},
        },
      );
      renderer.render({});
      while (
        renderer._noiseGenerationTransaction?._phase !== 'shape-slices'
      ) {
        await new Promise(resolve => requestAnimationFrame(resolve));
      }

      let attemptedTextureCount = 0;
      let firstFailure = null;
      prototype.deleteTexture = function (texture) {
        if (this === gl) {
          attemptedTextureCount++;
          throw new Error(
            `synthetic ${transition} smoke texture deletion failure`
          );
        }
        return Reflect.apply(originalDeleteTexture, this, [texture]);
      };

      try {
        if (transition === 'disposed') {
          try {
            renderer.dispose();
          } catch (error) {
            firstFailure = {
              message: error.message,
              name: error.name,
            };
          }
        } else {
          renderer.handleContextLost();
        }
        await Promise.resolve();
      } finally {
        prototype.deleteTexture = originalDeleteTexture;
      }
      const retainedAfterFirst =
        renderer._noiseGenerationTransaction !== null;
      const retryDispose = renderer.dispose();
      return {
        attemptedTextureCount,
        contextLost: renderer.contextLost,
        disposed: renderer.disposed,
        firstFailure,
        generationError: renderer.noiseGenerationError,
        generationInProgress: renderer.noiseGenerationInProgress,
        publishedTextures: renderer.noiseTextures !== null,
        retainedAfterFirst,
        retryDispose,
      };
    };

    try {
      return {
        contextLost: await runScenario('context-lost'),
        disposed: await runScenario('disposed'),
      };
    } finally {
      prototype.deleteTexture = originalDeleteTexture;
    }
  });

  expect(proof).toEqual({
    contextLost: {
      attemptedTextureCount: 0,
      contextLost: true,
      disposed: true,
      firstFailure: null,
      generationError: null,
      generationInProgress: false,
      publishedTextures: false,
      retainedAfterFirst: false,
      retryDispose: true,
    },
    disposed: {
      attemptedTextureCount: 1,
      contextLost: false,
      disposed: true,
      firstFailure: {
        message: 'synthetic disposed smoke texture deletion failure',
        name: 'Error',
      },
      generationError: null,
      generationInProgress: false,
      publishedTextures: false,
      retainedAfterFirst: true,
      retryDispose: true,
    },
  });
});

test('GPU noise generation restores hostile caller state and rolls back every failed resource', async ({
  page,
}) => {
  await page.goto(WEBGL_HARNESS);
  const proof = await page.evaluate(async () => {
    const { generateCloudNoiseTexturesGPU } = await import(
      '/assets/js/rendering/smoke-cloud/gpu-noise-generator.js'
    );
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: true,
    });
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error('GPU noise transaction proof requires WebGL2');
    }

    const compile = (type, source) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('Noise state shader allocation failed');
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(
          gl.getShaderInfoLog(shader) || 'Noise state shader compile failed'
        );
      }
      return shader;
    };
    const vertexShader = compile(
      gl.VERTEX_SHADER,
      '#version 300 es\nvoid main(){gl_Position=vec4(0.0);}',
    );
    const fragmentShader = compile(
      gl.FRAGMENT_SHADER,
      '#version 300 es\nprecision highp float;out vec4 c;void main(){c=vec4(1.0);}',
    );
    const priorProgram = gl.createProgram();
    if (!priorProgram) throw new Error('Noise state program allocation failed');
    gl.attachShader(priorProgram, vertexShader);
    gl.attachShader(priorProgram, fragmentShader);
    gl.linkProgram(priorProgram);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    if (!gl.getProgramParameter(priorProgram, gl.LINK_STATUS)) {
      throw new Error(
        gl.getProgramInfoLog(priorProgram) || 'Noise state program link failed'
      );
    }
    const priorDrawFramebuffer = gl.createFramebuffer();
    const priorReadFramebuffer = gl.createFramebuffer();
    const priorVertexArray = gl.createVertexArray();
    const priorBuffer = gl.createBuffer();
    const priorPixelUnpackBuffer = gl.createBuffer();
    const priorTexture2D = gl.createTexture();
    const priorTexture3D = gl.createTexture();
    if (
      !priorDrawFramebuffer
      || !priorReadFramebuffer
      || !priorVertexArray
      || !priorBuffer
      || !priorPixelUnpackBuffer
      || !priorTexture2D
      || !priorTexture3D
    ) {
      throw new Error('Noise state fixture allocation failed');
    }
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, priorTexture2D);
    gl.bindTexture(gl.TEXTURE_3D, priorTexture3D);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, priorDrawFramebuffer);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, priorReadFramebuffer);
    gl.bindVertexArray(priorVertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, priorBuffer);
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, priorPixelUnpackBuffer);
    gl.bufferData(gl.PIXEL_UNPACK_BUFFER, 16, gl.STATIC_DRAW);
    gl.useProgram(priorProgram);
    gl.viewport(1, 2, 7, 8);
    gl.colorMask(false, true, false, true);
    gl.enable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.DITHER);
    gl.enable(gl.RASTERIZER_DISCARD);
    gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
    gl.enable(gl.SAMPLE_COVERAGE);
    gl.enable(gl.SCISSOR_TEST);
    gl.enable(gl.STENCIL_TEST);

    const capabilities = [
      gl.BLEND,
      gl.CULL_FACE,
      gl.DEPTH_TEST,
      gl.DITHER,
      gl.RASTERIZER_DISCARD,
      gl.SAMPLE_ALPHA_TO_COVERAGE,
      gl.SAMPLE_COVERAGE,
      gl.SCISSOR_TEST,
      gl.STENCIL_TEST,
    ];
    const snapshotState = () => ({
      activeTexture: gl.getParameter(gl.ACTIVE_TEXTURE),
      arrayBuffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING),
      capabilities: capabilities.map(capability => (
        gl.isEnabled(capability)
      )),
      colorMask: Array.from(gl.getParameter(gl.COLOR_WRITEMASK)),
      drawFramebuffer: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),
      pixelUnpackBuffer: gl.getParameter(
        gl.PIXEL_UNPACK_BUFFER_BINDING,
      ),
      program: gl.getParameter(gl.CURRENT_PROGRAM),
      readFramebuffer: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
      texture2D: gl.getParameter(gl.TEXTURE_BINDING_2D),
      texture3D: gl.getParameter(gl.TEXTURE_BINDING_3D),
      vertexArray: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
      viewport: Array.from(gl.getParameter(gl.VIEWPORT)),
    });
    const stateMatches = (actual, expected) => (
      actual.activeTexture === expected.activeTexture
      && actual.arrayBuffer === expected.arrayBuffer
      && actual.capabilities.every(
        (value, index) => value === expected.capabilities[index]
      )
      && actual.colorMask.every(
        (value, index) => value === expected.colorMask[index]
      )
      && actual.drawFramebuffer === expected.drawFramebuffer
      && actual.pixelUnpackBuffer === expected.pixelUnpackBuffer
      && actual.program === expected.program
      && actual.readFramebuffer === expected.readFramebuffer
      && actual.texture2D === expected.texture2D
      && actual.texture3D === expected.texture3D
      && actual.vertexArray === expected.vertexArray
      && actual.viewport.every(
        (value, index) => value === expected.viewport[index]
      )
    );
    const stateBefore = snapshotState();

    const prototype = WebGL2RenderingContext.prototype;
    const resourceMethods = [
      ['Shader', 'shader'],
      ['Program', 'program'],
      ['Buffer', 'buffer'],
      ['VertexArray', 'vertexArray'],
      ['Texture', 'texture'],
      ['Framebuffer', 'framebuffer'],
    ];
    const originals = {};
    const live = Object.fromEntries(
      resourceMethods.map(([, name]) => [name, new Set()]),
    );
    for (const [suffix, name] of resourceMethods) {
      const createName = `create${suffix}`;
      const deleteName = `delete${suffix}`;
      originals[createName] = prototype[createName];
      originals[deleteName] = prototype[deleteName];
      prototype[createName] = function (...args) {
        const resource = Reflect.apply(
          originals[createName],
          this,
          args,
        );
        if (this === gl && resource) live[name].add(resource);
        return resource;
      };
      prototype[deleteName] = function (resource) {
        if (this === gl) live[name].delete(resource);
        return Reflect.apply(originals[deleteName], this, [resource]);
      };
    }
    const originalDrawArrays = prototype.drawArrays;
    const originalCheckFramebufferStatus =
      prototype.checkFramebufferStatus;
    originals.drawArrays = originalDrawArrays;
    originals.checkFramebufferStatus = originalCheckFramebufferStatus;
    let failNextDraw = true;
    let framebufferChecks = 0;
    let drawState = null;
    prototype.drawArrays = function (...args) {
      if (this === gl && failNextDraw) {
        failNextDraw = false;
        drawState = {
          blend: gl.isEnabled(gl.BLEND),
          colorMask: Array.from(gl.getParameter(gl.COLOR_WRITEMASK)),
          cull: gl.isEnabled(gl.CULL_FACE),
          depth: gl.isEnabled(gl.DEPTH_TEST),
          dither: gl.isEnabled(gl.DITHER),
          pixelUnpackBufferIsNull:
            gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING) === null,
          rasterizerDiscard: gl.isEnabled(gl.RASTERIZER_DISCARD),
          scissor: gl.isEnabled(gl.SCISSOR_TEST),
          stencil: gl.isEnabled(gl.STENCIL_TEST),
          viewport: Array.from(gl.getParameter(gl.VIEWPORT)),
        };
        throw new Error('synthetic GPU noise slice draw failure');
      }
      return Reflect.apply(originalDrawArrays, this, args);
    };
    prototype.checkFramebufferStatus = function (...args) {
      if (this === gl) framebufferChecks++;
      return Reflect.apply(originalCheckFramebufferStatus, this, args);
    };

    let failureMessage = null;
    let failureStateRestored = false;
    let failureLiveCounts = null;
    let successStateRestored = false;
    let successFramebufferChecks = null;
    let successLiveCounts = null;
    let textures = null;
    try {
      try {
        generateCloudNoiseTexturesGPU(gl, 32, 32);
      } catch (error) {
        failureMessage = error.message;
      }
      failureStateRestored = stateMatches(snapshotState(), stateBefore);
      failureLiveCounts = Object.fromEntries(
        Object.entries(live).map(([name, resources]) => [
          name,
          resources.size,
        ]),
      );

      const checksBeforeSuccess = framebufferChecks;
      textures = generateCloudNoiseTexturesGPU(gl, 32, 32);
      successFramebufferChecks = framebufferChecks - checksBeforeSuccess;
      successStateRestored = stateMatches(snapshotState(), stateBefore);
      gl.deleteTexture(textures.shape);
      gl.deleteTexture(textures.detail);
      gl.deleteTexture(textures.blueNoise);
      textures = null;
      successLiveCounts = Object.fromEntries(
        Object.entries(live).map(([name, resources]) => [
          name,
          resources.size,
        ]),
      );
    } finally {
      if (textures) {
        gl.deleteTexture(textures.shape);
        gl.deleteTexture(textures.detail);
        gl.deleteTexture(textures.blueNoise);
      }
      for (const [suffix] of resourceMethods) {
        prototype[`create${suffix}`] = originals[`create${suffix}`];
        prototype[`delete${suffix}`] = originals[`delete${suffix}`];
      }
      prototype.drawArrays = originals.drawArrays;
      prototype.checkFramebufferStatus =
        originals.checkFramebufferStatus;
    }

    const webglError = gl.getError();
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
    gl.useProgram(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindTexture(gl.TEXTURE_3D, null);
    gl.deleteProgram(priorProgram);
    gl.deleteFramebuffer(priorDrawFramebuffer);
    gl.deleteFramebuffer(priorReadFramebuffer);
    gl.deleteVertexArray(priorVertexArray);
    gl.deleteBuffer(priorBuffer);
    gl.deleteBuffer(priorPixelUnpackBuffer);
    gl.deleteTexture(priorTexture2D);
    gl.deleteTexture(priorTexture3D);
    return {
      drawState,
      failureLiveCounts,
      failureMessage,
      failureStateRestored,
      successFramebufferChecks,
      successLiveCounts,
      successStateRestored,
      webglError,
    };
  });

  expect(proof.failureMessage).toContain(
    'synthetic GPU noise slice draw failure',
  );
  expect(proof.drawState).toEqual({
    blend: false,
    colorMask: [true, true, true, true],
    cull: false,
    depth: false,
    dither: false,
    pixelUnpackBufferIsNull: true,
    rasterizerDiscard: false,
    scissor: false,
    stencil: false,
    viewport: [0, 0, 32, 32],
  });
  expect(proof.failureStateRestored).toBe(true);
  expect(proof.failureLiveCounts).toEqual({
    buffer: 0,
    framebuffer: 0,
    program: 0,
    shader: 0,
    texture: 0,
    vertexArray: 0,
  });
  expect(proof.successStateRestored).toBe(true);
  expect(proof.successFramebufferChecks).toBe(3);
  expect(proof.successLiveCounts).toEqual({
    buffer: 0,
    framebuffer: 0,
    program: 0,
    shader: 0,
    texture: 0,
    vertexArray: 0,
  });
  expect(proof.webglError).toBe(0);
});

test('disposing smoke before its first scheduled noise batch allocates nothing', async ({
  page,
}) => {
  await page.goto(WEBGL_HARNESS);
  const proof = await page.evaluate(async () => {
    const [
      { createProgram },
      { SmokeRenderer },
    ] = await Promise.all([
      import('/assets/js/rendering/gl-utils.js'),
      import('/assets/js/rendering/smoke-cloud/smoke-renderer.js'),
    ]);
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 4;
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: true,
    });
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error('Pending smoke disposal proof requires WebGL2');
    }
    const renderer = new SmokeRenderer(gl, createProgram);
    renderer.setNoiseTextureResolution(32);
    const densityTexture = gl.createTexture();
    if (!densityTexture) {
      throw new Error('Pending smoke density allocation failed');
    }
    renderer.textureInfo = {
      gridSize: 8,
      is3D: true,
      texture: densityTexture,
    };

    const prototype = WebGL2RenderingContext.prototype;
    const originalCreateTexture = prototype.createTexture;
    const originalDeleteTexture = prototype.deleteTexture;
    const liveTextures = new Set();
    prototype.createTexture = function (...args) {
      const texture = Reflect.apply(originalCreateTexture, this, args);
      if (this === gl && texture) liveTextures.add(texture);
      return texture;
    };
    prototype.deleteTexture = function (texture) {
      if (this === gl) liveTextures.delete(texture);
      return Reflect.apply(originalDeleteTexture, this, [texture]);
    };
    let liveWhilePending = null;
    let firstDispose = null;
    let secondDispose = null;
    try {
      renderer.render({
        eye: new Float32Array([0, 0, 2]),
        height: 4,
        invViewProjMatrix: new Float32Array([
          1, 0, 0, 0,
          0, 1, 0, 0,
          0, 0, 1, 0,
          0, 0, 0, 1,
        ]),
        lightDir: new Float32Array([0, 0, 1]),
        width: 4,
      });
      liveWhilePending = liveTextures.size;
      firstDispose = renderer.dispose();
      await Promise.resolve();
      await Promise.resolve();
      secondDispose = renderer.dispose();
    } finally {
      prototype.createTexture = originalCreateTexture;
      prototype.deleteTexture = originalDeleteTexture;
    }
    return {
      disposed: renderer.disposed,
      firstDispose,
      liveAfterSettlement: liveTextures.size,
      liveWhilePending,
      noiseTextures: renderer.noiseTextures,
      secondDispose,
      webglError: gl.getError(),
    };
  });

  expect(proof).toEqual({
    disposed: true,
    firstDispose: true,
    liveAfterSettlement: 0,
    liveWhilePending: 0,
    noiseTextures: null,
    secondDispose: false,
    webglError: 0,
  });
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

test('runtime smoke noise failure settles once to points and retries cleanly', async ({
  page,
}) => {
  const browserErrors = [];
  let publishNoiseReady;
  const noiseReady = new Promise(resolve => {
    publishNoiseReady = resolve;
  });
  page.on('console', message => {
    if (message.type() === 'error') {
      browserErrors.push(`console: ${message.text()}`);
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
    '/?exportsBaseUrl=http%3A%2F%2F127.0.0.1%3A4173%2Ftests%2Fbrowser%2Ffixtures%2Fexports%2F&dataset=current-ui-prepared&acceptance=smoke-runtime-failure-settlement',
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );
  await page.evaluate(() => {
    const state = window._cellucidState;
    const viewer = window._cellucidViewer;
    const originalSetActiveView = state.setActiveView;
    const originalSetViewLayout = viewer.setViewLayout;
    let activeViewPublications = 0;
    const layoutPublications = [];
    state.setActiveView = function (...args) {
      activeViewPublications++;
      return Reflect.apply(originalSetActiveView, this, args);
    };
    viewer.setViewLayout = function (...args) {
      layoutPublications.push([...args]);
      return Reflect.apply(originalSetViewLayout, this, args);
    };
    window.__getSmokeModeActiveViewPublications = () =>
      activeViewPublications;
    window.__getSmokeModeLayoutPublications = () =>
      layoutPublications.map(args => [...args]);
  });
  await page.locator('#smoke-grid').evaluate(input => {
    input.value = '0';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('#noise-resolution').evaluate(input => {
    input.value = '0';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#view-layout-mode')).toHaveValue('grid');
  expect(await page.evaluate(
    () => window._cellucidViewer.getViewLayout(),
  )).toEqual({
    mode: 'grid',
    activeId: 'live',
    liveViewHidden: false,
  });
  await page.evaluate(() => window._cellucidViewer.pause());
  await page.locator('#render-mode').selectOption('smoke');
  await expect(page.locator('#render-mode')).toHaveValue('smoke');
  await expect(page.locator('#split-keep-view-btn')).toBeDisabled();
  await expect(page.locator('#view-layout-mode')).toHaveValue('single');
  expect(await page.evaluate(
    () => window._cellucidViewer.getViewLayout(),
  )).toEqual({
    mode: 'single',
    activeId: 'live',
    liveViewHidden: false,
  });
  expect(await page.evaluate(
    () => window.__getSmokeModeActiveViewPublications(),
  )).toBe(0);
  expect(await page.evaluate(
    () => window.__getSmokeModeLayoutPublications(),
  )).toEqual([['single', 'live']]);
  await page.evaluate(() => {
    const canvas = document.querySelector('#glcanvas');
    const gl = canvas?.getContext('webgl2');
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error('Smoke runtime failure fixture requires WebGL2');
    }
    const prototype = WebGL2RenderingContext.prototype;
    const original = prototype.getProgramParameter;
    let rejectNextLink = true;
    prototype.getProgramParameter = function (program, parameter) {
      if (
        this === gl
        && rejectNextLink
        && parameter === gl.LINK_STATUS
      ) {
        rejectNextLink = false;
        return false;
      }
      return Reflect.apply(original, this, [program, parameter]);
    };
    window.__restoreSmokeCompileProbe = () => {
      prototype.getProgramParameter = original;
      delete window.__restoreSmokeCompileProbe;
    };
    window._cellucidViewer.resume();
  });

  await expect(page.locator('#render-mode')).toHaveValue('points');
  await expect(page.locator('#smoke-controls')).not.toHaveClass(/\bvisible\b/);
  await expect(page.locator('#points-controls')).toHaveClass(/\bvisible\b/);
  await expect(page.locator('#split-keep-view-btn')).toBeEnabled();
  await expect(page.locator('#view-layout-mode')).toHaveValue('single');
  expect(await page.evaluate(
    () => window.__getSmokeModeActiveViewPublications(),
  )).toBe(0);
  expect(await page.evaluate(
    () => window.__getSmokeModeLayoutPublications(),
  )).toEqual([['single', 'live']]);
  const runtimeNotifications = page.locator('.notification-error').filter({
    hasText: 'Smoke rendering failed:',
  });
  await expect(runtimeNotifications).toHaveCount(1);
  await page.waitForTimeout(500);
  await expect(runtimeNotifications).toHaveCount(1);
  expect(browserErrors).toEqual([]);

  await page.evaluate(() => window.__restoreSmokeCompileProbe());
  await page.locator('#render-mode').selectOption('smoke');
  await expect(page.locator('#render-mode')).toHaveValue('smoke');
  await noiseReady;
  await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  const webglState = await page.locator('#glcanvas').evaluate(canvas => {
    const gl = canvas.getContext('webgl2');
    return {
      depth: gl.isEnabled(gl.DEPTH_TEST),
      error: gl.getError(),
      framebufferIsDefault:
        gl.getParameter(gl.FRAMEBUFFER_BINDING) === null,
    };
  });
  expect(webglState).toEqual({
    depth: true,
    error: 0,
    framebufferIsDefault: true,
  });
  expect(await page.evaluate(
    () => window.__getSmokeModeActiveViewPublications(),
  )).toBe(0);
  expect(await page.evaluate(
    () => window.__getSmokeModeLayoutPublications(),
  )).toEqual([
    ['single', 'live'],
    ['single', 'live'],
  ]);
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
              '2d': 'vectors/0_2d.bin',
            },
          },
        },
      };
      await route.fulfill({ response, json: identity });
    },
  );
  await page.route(
    `**${CURRENT_UI_DATASET}vectors/0_2d.bin`,
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
  const clearColorBefore = await page.locator('#glcanvas').evaluate(canvas => {
    const gl = canvas.getContext('webgl2');
    return Array.from(gl.getParameter(gl.COLOR_CLEAR_VALUE));
  });
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

  const webglState = await page.locator('#glcanvas').evaluate(canvas => {
    const gl = canvas.getContext('webgl2');
    return {
      clearColor: Array.from(gl.getParameter(gl.COLOR_CLEAR_VALUE)),
      depthTest: gl.isEnabled(gl.DEPTH_TEST),
      depthWrite: gl.getParameter(gl.DEPTH_WRITEMASK),
      error: gl.getError(),
      framebufferIsDefault:
        gl.getParameter(gl.FRAMEBUFFER_BINDING) === null,
    };
  });
  expect(webglState).toEqual({
    clearColor: clearColorBefore,
    depthTest: true,
    depthWrite: true,
    error: 0,
    framebufferIsDefault: true,
  });
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

test('recoloring and position changes retain the published filter generation', async ({
  page,
}) => {
  const productErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') {
      productErrors.push(`console: ${message.text()}`);
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
    '/?exportsBaseUrl=http%3A%2F%2F127.0.0.1%3A4173%2Ftests%2Fbrowser%2Ffixtures%2Fexports%2F&dataset=current-ui-prepared&acceptance=renderer-alpha-generation',
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );

  const result = await page.evaluate(async () => {
    const viewer = window._cellucidViewer;
    const transparency = new Float32Array(viewer.getPointCount()).fill(1);
    transparency[0] = 0;
    viewer.updateTransparency(transparency);

    const readVisibility = () => {
      const alpha = viewer.getViewTransparency('live');
      const membership = viewer.getCurrentLodMembership(
        'live',
        2,
      );
      const admissionLevels = membership?.admissionLevels ?? null;
      const lodLevel = membership?.lodLevel ?? -1;
      return [0, 1].map(index => (
        alpha[index] >= Math.fround(2.5 / 255) &&
        (
          admissionLevels === null ||
          admissionLevels[index] <= lodLevel
        )
      ) ? 1 : 0);
    };

    const colors = viewer.getColors().slice();
    colors[0] = (colors[0] + 17) % 256;
    viewer.updateColors(colors);
    const afterRecolor = readVisibility();

    viewer.updatePositions(viewer.getPositions().slice(), 2);
    const afterPositions = readVisibility();
    await new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });

    return {
      afterPositions,
      afterRecolor,
      webglError: viewer.getGLContext().getError(),
    };
  });

  expect(result).toEqual({
    afterPositions: [0, 1],
    afterRecolor: [0, 1],
    webglError: 0,
  });
  expect(productErrors).toEqual([]);
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
