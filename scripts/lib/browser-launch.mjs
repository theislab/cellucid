/**
 * One browser launch for every measuring script (`render-scenarios.mjs`,
 * `benchmark-*.mjs`, `efficiency-floor/*`): the machine's GPU, and the WebGL
 * renderer each run drew with, recorded and checked.
 *
 * A software rasterizer (SwiftShader, llvmpipe) draws every frame on the CPU:
 * a frame of millions of points then costs seconds, and a synchronous GL call
 * (a frame-cost measurement, a read-back) holds the main thread for it, so a
 * timing taken on one measures the rasterizer, not the app. Chromium starts
 * on the GPU (Metal through ANGLE on macOS), Firefox with WebGL forced on;
 * `requireHardwareRenderer` refuses a run that still lands on a software
 * renderer unless the run asked for one (`--software-gl`: a machine without
 * a GPU, a check of drawing alone, never a timing).
 *
 * @module scripts/lib/browser-launch
 */

import { classifyRasterizer } from '../../assets/js/app/ui/modules/benchmark/renderer-identity.js';

/**
 * Whether the command line asks for a software renderer (`--software-gl`).
 *
 * @param {string[]} [argv]
 * @returns {boolean}
 */
export function softwareGlRequested(argv = process.argv) {
  return argv.includes('--software-gl');
}

/**
 * Playwright launch options for `engine` on the machine's GPU (or, with
 * `softwareGl`, Chromium's SwiftShader).
 *
 * @param {'chromium'|'firefox'|'webkit'} engine
 * @param {{args?: string[], headless?: boolean, softwareGl?: boolean}} [options]
 *   `args`: more Chromium switches (a debugging port, certificate errors)
 * @returns {object}
 */
export function browserLaunchOptions(engine, { args = [], headless = true, softwareGl = softwareGlRequested() } = {}) {
  if (engine === 'chromium') {
    const gpu = softwareGl
      ? ['--enable-unsafe-swiftshader']
      : ['--enable-gpu', '--ignore-gpu-blocklist', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : [])];
    return { headless, args: [...gpu, '--enable-precise-memory-info', ...args] };
  }
  if (engine === 'firefox') {
    return {
      headless,
      firefoxUserPrefs: {
        'webgl.disabled': false,
        'webgl.enable-webgl2': true,
        'webgl.forbid-software': false,
        'webgl.force-enabled': true,
      },
    };
  }
  if (engine === 'webkit') return { headless };
  throw new TypeError(`Unknown browser engine "${engine}".`);
}

/**
 * The WebGL renderer `page` draws with (`WEBGL_debug_renderer_info`'s
 * unmasked renderer), classified by the app's own rule
 * (`renderer-identity.js`, `classifyRasterizer`). Throws when WebGL 2 is
 * missing, or when the rasterizer is software or cannot be identified and
 * `softwareGl` is not set: a run records this string with its results.
 *
 * @param {import('playwright').Page|import('playwright').Frame} page
 * @param {{softwareGl?: boolean}} [options]
 * @returns {Promise<string>}
 */
export async function requireHardwareRenderer(page, { softwareGl = softwareGlRequested() } = {}) {
  const identity = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return null;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const read = parameter => {
      const value = gl.getParameter(parameter);
      return typeof value === 'string' && value.length > 0 ? value : null;
    };
    const record = {
      unmaskedRenderer: info ? read(info.UNMASKED_RENDERER_WEBGL) : null,
      unmaskedVendor: info ? read(info.UNMASKED_VENDOR_WEBGL) : null,
      maskedRenderer: read(gl.RENDERER),
    };
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return record;
  });
  if (identity === null) throw new Error('This browser has no WebGL 2: the run would not draw.');
  const classification = classifyRasterizer(identity);
  if (!softwareGl && classification.kind !== 'hardware') {
    throw new Error(
      `${classification.reason} A timing on it would not be the app's: run on a machine with a GPU, ` +
      'or pass --software-gl for a run that times nothing.'
    );
  }
  return identity.unmaskedRenderer ?? identity.maskedRenderer ?? 'unknown';
}
