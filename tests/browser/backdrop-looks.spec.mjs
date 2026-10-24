/**
 * The baked backdrop looks (`Atelier`, `Nebula`, `Abyss`, `Aurora` in light
 * and dark; `rendering/backdrops/`) in the places a user reaches them.
 *
 * - Every look draws in a 3-D and a 2-D pane with finite state and no WebGL
 *   error, on a page coloured exactly like the canvas, and the scene goes
 *   quiet once its bake has landed: no frame is drawn while nothing changes.
 * - In a two-pane grid each pane draws the look, and the panes go quiet.
 * - Below the Atelier floor the look still draws (the backlit paper).
 * - With reduced motion the look appears without a fade and ambient motion
 *   cannot start; without it, ambient motion runs at no more than 30 Hz and
 *   stops when switched off.
 * - A session carries a look out and back.
 * - Figure export redraws the look under the points, in PNG and in SVG.
 */

import { expect, test } from './helpers/test.mjs';
import { appUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { sceneQuietness } from './helpers/frame-scheduling.mjs';
import { installMultiDimensionFixture } from './helpers/multi-dimension-fixture.mjs';
import { decodePng } from './helpers/png-pixels.mjs';
import { BACKDROP_LOOKS, BACKDROP_LOOK_IDS } from '../../assets/js/rendering/backdrops/backdrop-looks.js';

// Bakes, several looks and multiview frames: the macOS Firefox runners render
// in software, so the file carries its own budget, like the other WebGL specs.
test.describe.configure({ timeout: 240_000 });

const ROOT = appUrl('/tests/browser/fixtures/generated-studio-dimensions/');
const DATASET_ID = 'studio-1d-2d-3d';
const DATASET_NAME = 'Studio dimensions fixture';

function observeProductErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => {
    errors.push(`page: ${error.stack || error.message}`);
  });
  return errors;
}

async function openFixture(page) {
  await installMultiDimensionFixture(page, {
    root: ROOT,
    datasetId: DATASET_ID,
    name: DATASET_NAME,
    cellCount: 3_000,
  });
  await page.goto(
    `/?sampleCatalog=${encodeURIComponent(ROOT)}&dataset=${DATASET_ID}`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await openCollapsedPanels(page);
  await expect(page.locator('#dataset-name')).toHaveText(DATASET_NAME);
}

async function setControl(page, id, value) {
  await page.evaluate(([controlId, controlValue]) => {
    const element = document.getElementById(controlId);
    if (element === null) throw new Error(`no control #${controlId}`);
    element.value = String(controlValue);
    if (element.value !== String(controlValue)) {
      throw new Error(`#${controlId} has no option "${controlValue}"`);
    }
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, [id, value]);
}

async function setDimension(page, viewId, dimension) {
  const option = page
    .locator(`#view-representation-select optgroup[label="${dimension}D"] option`)
    .first();
  await page.selectOption(
    '#view-representation-select',
    await option.getAttribute('value'),
  );
  await expect.poll(() => page.evaluate(
    id => window._cellucidViewer.getViewDimension(id),
    viewId,
  )).toBe(dimension);
}

/** Select a look and wait until it is baked, faded in and the scene is quiet. */
async function showLook(page, look) {
  await setControl(page, 'background-select', look);
  await expect.poll(() => page.evaluate(() => {
    const d = window._cellucidViewer.getBackdropLookDiagnostics();
    return { activeId: d.activeId, opacity: d.opacity, queued: d.jobsQueued };
  }), { timeout: 60_000 }).toEqual({ activeId: look, opacity: 1, queued: 0 });
  await expect.poll(() => sceneQuietness(page), { timeout: 60_000 }).toBe('quiet');
}

/**
 * Count the look passes drawn, and record any non-finite uniform handed to a
 * look program or a WebGL error. Look programs are recognised by their source.
 */
async function installLookProbe(page) {
  await page.evaluate(() => {
    const gl = window._cellucidViewer.getGLContext();
    const probe = { draws: 0, nonFinite: [] };
    const lookPrograms = new WeakMap();
    const lookIsCurrent = () => {
      const program = gl.getParameter(gl.CURRENT_PROGRAM);
      if (program === null) return false;
      if (!lookPrograms.has(program)) {
        const shaders = gl.getAttachedShaders(program) ?? [];
        lookPrograms.set(program, shaders.some(
          shader => (gl.getShaderSource(shader) ?? '').includes('virtualSkyRay'),
        ));
      }
      return lookPrograms.get(program);
    };
    // Wrapped on the prototype, for the viewer's context only: the draw
    // counters of helpers/frame-scheduling.mjs wrap and then delete the
    // context's own properties, which would remove an instance wrapper.
    const proto = Object.getPrototypeOf(gl);
    for (const name of ['uniform1f', 'uniform3f', 'uniform4f', 'uniform2f', 'uniformMatrix4fv']) {
      const original = proto[name];
      proto[name] = function probedUniform(location, ...values) {
        if (this === gl && lookIsCurrent()) {
          const numbers = values.flatMap(value => (
            ArrayBuffer.isView(value) || Array.isArray(value) ? Array.from(value) : [value]
          )).filter(value => typeof value === 'number');
          if (numbers.some(value => !Number.isFinite(value))) probe.nonFinite.push(name);
        }
        return Reflect.apply(original, this, [location, ...values]);
      };
    }
    const drawArrays = proto.drawArrays;
    proto.drawArrays = function probedDrawArrays(mode, ...rest) {
      if (this === gl && mode === gl.TRIANGLES && lookIsCurrent()) probe.draws += 1;
      return Reflect.apply(drawArrays, this, [mode, ...rest]);
    };
    window.__lookProbe = probe;
  });
}

/** Force one frame and return what the look passes did in it. */
async function lookFrame(page) {
  await page.evaluate(() => {
    window.__lookProbe.draws = 0;
    window.__lookProbe.nonFinite.length = 0;
  });
  // A real change (setters ignore an unchanged value), then two frames: the
  // viewer re-arms its frame first, so they contain the one it owes.
  await page.evaluate(() => new Promise(resolve => {
    const viewer = window._cellucidViewer;
    const size = viewer.getPresentedViewState('live').renderState.pointSize;
    viewer.setPointSize(size === 3 ? 3.5 : 3);
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  return page.evaluate(() => {
    const gl = window._cellucidViewer.getGLContext();
    return {
      draws: window.__lookProbe.draws,
      nonFinite: [...window.__lookProbe.nonFinite],
      glError: gl.getError(),
    };
  });
}

/**
 * The spread of the canvas corner (where the fixture draws no cell): a look
 * paints structure and grain there, a plain clear colour paints none.
 */
async function cornerSpread(page) {
  const image = decodePng(await page.locator('#glcanvas').screenshot());
  const { width, channels, pixels } = image;
  let min = 255;
  let max = 0;
  for (let y = 4; y < 44; y++) {
    for (let x = width - 44; x < width - 4; x++) {
      const at = (y * width + x) * channels;
      const value = (pixels[at] + pixels[at + 1] + pixels[at + 2]) / 3;
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  }
  return max - min;
}

for (const look of BACKDROP_LOOK_IDS) {
  test(`the ${look} look draws in 3-D and 2-D panes and the scene goes quiet`, async ({ page }) => {
    const productErrors = observeProductErrors(page);
    await openFixture(page);
    await installLookProbe(page);
    for (const dimension of [3, 2]) {
      await setDimension(page, 'live', dimension);
      await showLook(page, look);
      if (dimension === 3) {
        // Which level the sky reached and how the GPU measured: a CI cell on
        // a software rasterizer stops early, and the log says where.
        console.log(`[backdrop-looks] ${look}: ${await page.evaluate(() => {
          const d = window._cellucidViewer.getBackdropLookDiagnostics();
          const family = Object.entries(d.families).find(([, f]) => f.ready)?.[1] ?? null;
          return JSON.stringify(family === null ? null : {
            family: family.family, cubeSize: family.cubeSize, readyMs: Math.round(family.readyMs),
            wallMs: Math.round(family.wallMs), texelRateMs: family.texelRateMs,
            levels: (family.levels ?? []).map(l => ({ size: l.size, bands: l.bands, gpuMs: Math.round(l.gpuMs), wallMs: Math.round(l.wallMs) })),
          });
        })}`);
      }
      const frame = await lookFrame(page);
      expect(frame.nonFinite, `${look} ${dimension}-D: non-finite uniforms`).toEqual([]);
      expect(frame.glError, `${look} ${dimension}-D: WebGL error`).toBe(0);
      expect(frame.draws, `${look} ${dimension}-D: look passes drawn`).toBeGreaterThanOrEqual(1);
      await expect.poll(() => sceneQuietness(page)).toBe('quiet');
      expect(await cornerSpread(page), `${look} ${dimension}-D: the corner shows the look`)
        .toBeGreaterThan(0);
    }
    // The page behind the canvas is exactly the colour the canvas clears to.
    const [r, g, b] = BACKDROP_LOOKS[look].surface;
    await expect.poll(() => page.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    )).toBe(`rgb(${r}, ${g}, ${b})`);
    expect(await page.evaluate(() => Array.from(
      window._cellucidViewer.getPresentedViewState('live').renderState.bgColor,
      channel => Math.round(channel * 255),
    ))).toEqual([r, g, b]);
    expect(productErrors).toEqual([]);
  });
}

test('every pane of a grid draws the look, and the grid goes quiet', async ({ page }) => {
  const productErrors = observeProductErrors(page);
  await openFixture(page);
  await installLookProbe(page);
  await page.locator('#split-keep-view-btn').click();
  await expect(page.locator('.split-badge')).toHaveCount(2);
  await page.evaluate(() => {
    window._cellucidViewer.setViewLayout('grid', 'live');
    window._cellucidState.setActiveView('live');
  });
  await expect(page.locator('.view-title-chip')).toHaveCount(2);
  for (const look of ['nebula', 'atelier']) {
    await showLook(page, look);
    const frame = await lookFrame(page);
    expect(frame.glError).toBe(0);
    expect(frame.draws, `${look}: one look pass per pane`).toBeGreaterThanOrEqual(2);
    await expect.poll(() => sceneQuietness(page)).toBe('quiet');
  }
  // Leaving the looks releases their bakes; nothing keeps working.
  await setControl(page, 'background-select', 'white');
  await expect.poll(() => page.evaluate(
    () => window._cellucidViewer.getBackdropLookDiagnostics().jobsQueued,
  )).toBe(0);
  await expect.poll(() => sceneQuietness(page)).toBe('quiet');
  expect(productErrors).toEqual([]);
});

test('below the Atelier floor the look still draws', async ({ page }) => {
  const productErrors = observeProductErrors(page);
  await openFixture(page);
  await installLookProbe(page);
  await setDimension(page, 'live', 3);
  await showLook(page, 'atelier');
  await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const camera = viewer.getCameraState();
    camera.navigationMode = 'orbit';
    // Well below the equator: the camera looks up from under the floor.
    camera.orbit.phi = 2.5;
    viewer.setCameraState(camera);
  });
  const eyeBelowFloor = await page.evaluate(() => {
    const state = window._cellucidViewer.getPresentedViewState('live').renderState;
    return state.cameraPosition[1] < state.backdrop.floorY;
  });
  expect(eyeBelowFloor).toBe(true);
  const frame = await lookFrame(page);
  expect(frame.glError).toBe(0);
  expect(frame.draws).toBeGreaterThanOrEqual(1);
  expect(await cornerSpread(page)).toBeGreaterThan(0);
  expect(productErrors).toEqual([]);
});

test('reduced motion: no fade and no ambient motion; otherwise ambient motion is capped', async ({
  page,
}) => {
  const productErrors = observeProductErrors(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openFixture(page);
  await setControl(page, 'background-select', 'nebula');
  // The look appears at full strength in the frame its bake lands in.
  await expect.poll(() => page.evaluate(() => {
    const d = window._cellucidViewer.getBackdropLookDiagnostics();
    return d.families.nebula?.ready === true;
  }), { timeout: 60_000 }).toBe(true);
  await expect.poll(() => page.evaluate(
    () => window._cellucidViewer.getBackdropLookDiagnostics().opacity,
  )).toBe(1);
  expect(await page.evaluate(() => {
    window._cellucidViewer.setBackdropAmbientMotion(true);
    return window._cellucidViewer.getBackdropLookDiagnostics().ambient;
  })).toBe(false);
  await expect.poll(() => sceneQuietness(page)).toBe('quiet');

  // The system setting changes: ambient motion may start, at most 30 Hz.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(() => page.evaluate(
    () => window._cellucidViewer.getBackdropLookDiagnostics().ambient,
  )).toBe(true);
  // Ambient motion draws: a look pass lands, however long a frame takes on
  // this renderer (a software rasterizer can need more than a second for
  // one), so the proof waits for a draw rather than a clock.
  await installLookProbe(page);
  await page.evaluate(() => { window.__lookProbe.draws = 0; });
  await expect.poll(
    () => page.evaluate(() => window.__lookProbe.draws),
    { timeout: 60_000 },
  ).toBeGreaterThan(0);
  // And at most 30 Hz: look passes drawn in one second (one per frame: a
  // single pane), each 30 Hz tick owing one frame and its settle frame.
  const frames = await page.evaluate(async () => {
    window.__lookProbe.draws = 0;
    await new Promise(resolve => setTimeout(resolve, 1000));
    return window.__lookProbe.draws;
  });
  expect(frames).toBeLessThanOrEqual(62);
  await page.evaluate(() => window._cellucidViewer.setBackdropAmbientMotion(false));
  await expect.poll(() => sceneQuietness(page)).toBe('quiet');
  expect(productErrors).toEqual([]);
});

async function saveSession(page, testInfo, name) {
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#save-state-btn').click();
  const download = await downloadPromise;
  const sessionPath = testInfo.outputPath(name);
  await download.saveAs(sessionPath);
  return sessionPath;
}

async function loadSession(page, sessionPath) {
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('#load-state-btn').click();
  const chooser = await chooserPromise;
  await chooser.setFiles(sessionPath);
}

test('a session carries a look out and back', async ({ page }, testInfo) => {
  const productErrors = observeProductErrors(page);
  await openFixture(page);
  for (const look of ['aurora-dark', 'atelier']) {
    await showLook(page, look);
    const sessionPath = await saveSession(page, testInfo, `${look}.cellucid-session`);
    await setControl(page, 'background-select', 'white');
    await expect(page.locator('#background-select')).toHaveValue('white');
    await loadSession(page, sessionPath);
    await expect(page.locator('#background-select')).toHaveValue(look);
    await expect.poll(() => page.evaluate(
      () => window._cellucidViewer.getBackdropLookDiagnostics().activeId,
    )).toBe(look);
  }
  expect(productErrors).toEqual([]);
});

async function exportFigure(page, format) {
  await page.getByLabel('Download format').selectOption(format);
  if (format === 'svg') {
    await page.getByLabel('SVG point strategy').selectOption('full-vector');
  }
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#figure-export-btn').click();
  const download = await downloadPromise;
  await expect(page.locator('#figure-export-btn')).toHaveText('Export');
  expect(await download.failure()).toBeNull();
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Distinct colours on a 7-pixel lattice over the middle of a PNG's plot area. */
function plotAreaColours({ width, height, channels, pixels }) {
  const values = new Set();
  for (let y = Math.floor(height * 0.2); y < Math.floor(height * 0.8); y += 7) {
    for (let x = Math.floor(width * 0.2); x < Math.floor(width * 0.7); x += 7) {
      const at = (y * width + x) * channels;
      values.add((pixels[at] << 16) | (pixels[at + 1] << 8) | pixels[at + 2]);
    }
  }
  return values;
}

/**
 * The share of the same lattice darker than 192 (mean of R, G and B): on a
 * white paper the paper and its grid are lighter, the shaded spheres of the
 * point pass are not. Measured over this fixture's figure: 0.16 (WebKit) and
 * 0.12 (Chromium). The PNG Linux WebKit wrote while the composed figure
 * reached the encoder as an ImageBitmap held no point and measured 0, while
 * its blurred grid passed a count of more than five colours (it had 28).
 */
function plotAreaShadedShare({ width, height, channels, pixels }) {
  let samples = 0;
  let shaded = 0;
  for (let y = Math.floor(height * 0.2); y < Math.floor(height * 0.8); y += 7) {
    for (let x = Math.floor(width * 0.2); x < Math.floor(width * 0.7); x += 7) {
      const at = (y * width + x) * channels;
      samples += 1;
      if (pixels[at] + pixels[at + 1] + pixels[at + 2] < 3 * 192) shaded += 1;
    }
  }
  return shaded / samples;
}

/** Distinct colours of the look raster an SVG export embeds. */
function svgLookColours(svg) {
  const match = svg.match(
    /<image class="cellucid-backdrop-look" [^>]*href="data:image\/png;base64,([A-Za-z0-9+/=]+)"/,
  );
  if (match === null) return null;
  const look = decodePng(Buffer.from(match[1], 'base64'));
  const values = new Set();
  for (let y = 0; y < look.height; y += 7) {
    for (let x = 0; x < look.width; x += 7) {
      const at = (y * look.width + x) * look.channels;
      values.add((look.pixels[at] << 16) | (look.pixels[at + 1] << 8) | look.pixels[at + 2]);
    }
  }
  return values;
}

test('figure export redraws the look under the points', async ({ page }, testInfo) => {
  const productErrors = observeProductErrors(page);
  await openFixture(page);
  await page.locator('#figure-export-section > summary').click();
  await page.getByRole('button', { name: /^Download\b/ }).click();
  // Each exported file goes with a failure, so a PNG that lost a layer can be
  // looked at; the checks below each name the layer they read.
  const keep = (name, body, contentType) => testInfo.attach(name, { body, contentType });
  // The point pass on its own, on a plain paper: the plot area holds points.
  await setControl(page, 'figure-export-background', 'white');
  const plainPngBytes = await exportFigure(page, 'png');
  await keep('plain.png', plainPngBytes, 'image/png');
  expect.soft(
    plotAreaShadedShare(decodePng(plainPngBytes)),
    'on white paper: the PNG plot area shows the shaded points',
  ).toBeGreaterThan(0.05);
  await setControl(page, 'figure-export-background', 'viewer');
  for (const [look, dimension] of [['nebula', 3], ['atelier', 2], ['abyss-dark', 3]]) {
    await setDimension(page, 'live', dimension);
    await showLook(page, look);
    const svg = (await exportFigure(page, 'svg')).toString('utf8');
    await keep(`${look}.svg`, Buffer.from(svg, 'utf8'), 'image/svg+xml');
    expect(svg, `${look}: the SVG embeds the look`).toMatch(
      /<image class="cellucid-backdrop-look" [^>]*href="data:image\/png;base64,/,
    );
    // Under the points: the image comes before the first point.
    expect(svg.indexOf('cellucid-backdrop-look')).toBeLessThan(svg.indexOf('<circle'));
    // The look raster on its own, as the SVG carries it: it has structure.
    expect.soft(svgLookColours(svg).size, `${look}: the look raster has structure`).toBeGreaterThan(20);
    const pngBytes = await exportFigure(page, 'png');
    await keep(`${look}.png`, pngBytes, 'image/png');
    // The plot area is not the plain surface: the look has structure there.
    expect(
      plotAreaColours(decodePng(pngBytes)).size,
      `${look}: the PNG plot area shows the look`,
    ).toBeGreaterThan(20);
  }
  // On a white paper the figure keeps the paper it was asked for.
  await setControl(page, 'figure-export-background', 'white');
  const plainSvg = (await exportFigure(page, 'svg')).toString('utf8');
  expect(plainSvg).not.toContain('cellucid-backdrop-look');
  expect(productErrors).toEqual([]);
});
