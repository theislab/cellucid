import { expect, test } from './helpers/test.mjs';

test('browser runtime provides the working WebGL2 contract Cellucid requires', async ({
  page,
}, testInfo) => {
  await page.goto('about:blank');

  const runtime = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      powerPreference: 'high-performance',
    });
    const environment = {
      userAgent: navigator.userAgent,
      visibilityState: document.visibilityState,
    };
    if (gl === null) {
      return {
        ...environment,
        supported: false,
      };
    }

    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    gl.viewport(0, 0, 2, 2);
    gl.clearColor(1, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const pixel = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);

    return {
      ...environment,
      supported: true,
      isWebGL2: gl instanceof WebGL2RenderingContext,
      version: gl.getParameter(gl.VERSION),
      renderer: debugInfo
        ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER),
      vendor: debugInfo
        ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
        : gl.getParameter(gl.VENDOR),
      pixel: [...pixel],
      error: gl.getError(),
    };
  });

  await testInfo.attach('webgl2-runtime.json', {
    body: Buffer.from(`${JSON.stringify(runtime, null, 2)}\n`),
    contentType: 'application/json',
  });

  expect(runtime.supported, JSON.stringify(runtime)).toBe(true);
  expect(runtime.isWebGL2).toBe(true);
  expect(runtime.version).toMatch(/^WebGL 2(?:\.0)?\b/);
  expect(runtime.pixel).toEqual([255, 0, 0, 255]);
  expect(runtime.error).toBe(0);
});
