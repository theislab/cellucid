/**
 * The studio backgrounds (`Studio (light)`, `Studio (dark)`) in every
 * combination a user can reach.
 *
 * - Every camera mode × embedding dimension × layout draws the backdrop with
 *   finite uniforms and no WebGL error, on the surface the pane should have:
 *   the floor for a 3-D pane in orbit or free-fly, the dot surface otherwise.
 * - Switching through all six backgrounds in a multiview grid, mid-fade, is
 *   stable, keeps the page colour equal to the canvas colour, and the scene
 *   goes quiet afterwards — also after a floor ↔ dots crossfade.
 * - A session carries the new values out and back.
 * - Figure export reproduces the backdrop in SVG and PNG.
 */

import { expect, test } from './helpers/test.mjs';
import { appUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openCollapsedPanels } from './helpers/panels.mjs';
import { sceneQuietness } from './helpers/frame-scheduling.mjs';
import { installMultiDimensionFixture } from './helpers/multi-dimension-fixture.mjs';
import { VIEWER_BACKGROUNDS } from '../../assets/js/rendering/viewer-backgrounds.js';
import { STUDIO_PALETTES } from '../../assets/js/rendering/studio-backdrop.js';

// Each test draws many frames, some in a multiview grid; the macOS Firefox
// runners render in software, so the file carries its own budget, as the
// other frame-driven WebGL specs do.
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

/** Write a control and dispatch the event its owner listens to. */
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

async function nextFrames(page, count = 2) {
  await page.evaluate(frames => new Promise(resolve => {
    let remaining = frames;
    const step = () => {
      remaining -= 1;
      if (remaining <= 0) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }), count);
}

/** Show the live view and its kept view side by side, the live view focused. */
async function openGridFocusedOnLive(page) {
  await page.evaluate(() => {
    window._cellucidViewer.setViewLayout('grid', 'live');
    // The sidebar controls (representation, navigation) act on the focused view.
    window._cellucidState.setActiveView('live');
  });
  await expect(page.locator('.view-title-chip')).toHaveCount(2);
  await expect.poll(() => page.evaluate(
    () => window._cellucidViewer.getViewLayout().activeId,
  )).toBe('live');
}

/**
 * Show the representation of one dimension (the fixture has one per
 * dimension) in the selected view, through the "Shows" picker.
 */
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

/**
 * Count the studio pass's draws and record any non-finite value handed to
 * one of its uniforms. The studio program is recognised by its own source.
 */
async function installStudioProbe(page) {
  await page.evaluate(() => {
    const gl = window._cellucidViewer.getGLContext();
    const probe = { draws: 0, nonFinite: [] };
    const studioPrograms = new WeakMap();
    const studioIsCurrent = () => {
      const program = gl.getParameter(gl.CURRENT_PROGRAM);
      if (program === null) return false;
      if (!studioPrograms.has(program)) {
        const shaders = gl.getAttachedShaders(program) ?? [];
        studioPrograms.set(program, shaders.some(
          shader => (gl.getShaderSource(shader) ?? '').includes('studioLatticeMarks'),
        ));
      }
      return studioPrograms.get(program);
    };
    for (const name of [
      'uniform1f',
      'uniform2f',
      'uniform3fv',
      'uniformMatrix2fv',
      'uniformMatrix4fv',
    ]) {
      const original = gl[name];
      gl[name] = function probedUniform(location, ...values) {
        if (studioIsCurrent()) {
          const numbers = values.flatMap(value => (
            ArrayBuffer.isView(value) || Array.isArray(value)
              ? Array.from(value)
              : [value]
          )).filter(value => typeof value === 'number');
          if (numbers.some(value => !Number.isFinite(value))) {
            probe.nonFinite.push(name);
          }
        }
        return Reflect.apply(original, this, [location, ...values]);
      };
    }
    const drawArrays = gl.drawArrays;
    gl.drawArrays = function probedDrawArrays(...args) {
      if (studioIsCurrent()) probe.draws += 1;
      return Reflect.apply(drawArrays, this, args);
    };
    window.__studioProbe = probe;
  });
}

async function resetProbe(page) {
  await page.evaluate(() => {
    window.__studioProbe.draws = 0;
    window.__studioProbe.nonFinite.length = 0;
  });
}

async function readProbe(page) {
  return page.evaluate(() => {
    const gl = window._cellucidViewer.getGLContext();
    return {
      draws: window.__studioProbe.draws,
      nonFinite: [...window.__studioProbe.nonFinite],
      glError: gl.getError(),
    };
  });
}

async function presentedPlanarity(page, viewId) {
  return page.evaluate(
    id => window._cellucidViewer.getPresentedViewState(id).renderState.backdrop.planarity,
    viewId,
  );
}

async function expectStudioFrame(page, { panes, label }) {
  await resetProbe(page);
  // Force a frame: re-selecting the active navigation mode publishes none.
  // The viewer re-arms its frame callback at the start of every frame, so two
  // frames from here contain the one this mutation invalidated.
  await page.evaluate(() => window._cellucidViewer.setPointSize(3));
  await nextFrames(page, 2);
  const probe = await readProbe(page);
  expect(probe.nonFinite, `${label}: non-finite studio uniforms`).toEqual([]);
  expect(probe.glError, `${label}: WebGL error`).toBe(0);
  expect(probe.draws, `${label}: studio passes drawn`).toBeGreaterThanOrEqual(panes);
}

// One test per background, and per camera lock in a grid. Every combination
// is still drawn and checked; split, each test is a share of the frames the
// single test drew, and the single test drew more frames than its budget
// holds on a runner that takes seconds per frame.
for (const background of ['studio', 'studio-dark']) {
  test(`every camera mode and dimension draws the ${background} backdrop`, async ({
    page,
  }) => {
    const productErrors = observeProductErrors(page);
    await openFixture(page);
    await installStudioProbe(page);

    await setControl(page, 'background-select', background);
    for (const dimension of [3, 2, 1]) {
      await setDimension(page, 'live', dimension);
      for (const mode of ['orbit', 'planar', 'free']) {
        await setControl(page, 'navigation-mode', mode);
        const label = `${background}, ${dimension}-D, ${mode}`;
        await expectStudioFrame(page, { panes: 1, label });
        expect(await presentedPlanarity(page, 'live'), label).toBe(
          dimension === 3 && mode !== 'planar' ? 0 : 1,
        );
      }
    }

    expect(productErrors).toEqual([]);
  });

  for (const locked of [true, false]) {
    const cameras = locked ? 'locked' : 'independent';
    test(`two panes of different dimensions with ${cameras} cameras draw the ${background} backdrop`, async ({
      page,
    }) => {
      const productErrors = observeProductErrors(page);
      await openFixture(page);
      await installStudioProbe(page);

      await setDimension(page, 'live', 3);
      await setControl(page, 'navigation-mode', 'orbit');
      await page.locator('#split-keep-view-btn').click();
      await expect(page.locator('.split-badge')).toHaveCount(2);
      const snapshotId = await page.evaluate(
        () => window._cellucidViewer.getSnapshotViews()[0].id,
      );
      await openGridFocusedOnLive(page);
      await setControl(page, 'background-select', background);
      await page.evaluate(
        value => window._cellucidViewer.setCamerasLocked(value),
        locked,
      );
      for (const dimension of [2, 3, 1]) {
        await setDimension(page, 'live', dimension);
        for (const mode of ['orbit', 'planar', 'free']) {
          await setControl(page, 'navigation-mode', mode);
          await expectStudioFrame(page, {
            panes: 2,
            label: `${background}, ${cameras}, live ${dimension}-D, ${mode}`,
          });
        }
      }
      expect(await page.evaluate(
        id => window._cellucidViewer.getViewDimension(id),
        snapshotId,
      )).toBe(3);

      expect(productErrors).toEqual([]);
    });
  }
}

test('a projectile fired down at the studio floor lands on it', async ({ page }) => {
  const productErrors = observeProductErrors(page);
  await openFixture(page);
  await setControl(page, 'background-select', 'studio');
  await setDimension(page, 'live', 3);
  await setControl(page, 'navigation-mode', 'free');
  await page.locator('#projectiles-enabled').check();
  await page.waitForFunction(
    () => window._cellucidViewer.isProjectileSpatialIndexReady(),
  );
  const floorY = await page.evaluate(
    () => window._cellucidViewer.getPresentedViewState('live').renderState.backdrop.floorY,
  );
  // Aim at the bottom of the canvas, so the shot heads down toward the floor.
  const box = await page.locator('#glcanvas').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 8);
  await page.mouse.down();
  await page.waitForTimeout(100);
  await page.mouse.up();
  // Follow every projectile until it has come down, and some frames after.
  // The simulation advances once per drawn frame by that frame's time, clamped
  // to a quarter second (`MAX_FRAME_DT`), so wall-clock time is not flight
  // time. This shot needs about two seconds of flight to reach the floor; four
  // wall-clock seconds on a runner whose frames each take longer than a
  // quarter second were less than that, and the shot was still in the air.
  // Frames are counted instead: 240 are four seconds of flight at 60 Hz and
  // more wherever frames are slower.
  const heights = await page.evaluate(({ floorY, maxFrames, framesAfter }) => (
    new Promise(resolve => {
      const viewer = window._cellucidViewer;
      const samples = [];
      let frames = 0;
      let landedAt = null;
      const sample = () => {
        frames += 1;
        for (const [, y] of viewer.getProjectilePositions()) {
          samples.push(y);
          if (landedAt === null && y < floorY + 0.05) landedAt = frames;
        }
        if (frames >= maxFrames || (landedAt !== null && frames - landedAt >= framesAfter)) {
          resolve(samples);
        } else {
          requestAnimationFrame(sample);
        }
      };
      requestAnimationFrame(sample);
    })
  ), { floorY, maxFrames: 240, framesAfter: 30 });
  expect(heights.length, 'the shot was fired').toBeGreaterThan(0);
  const lowest = Math.min(...heights);
  expect(lowest, 'no projectile passes below the floor').toBeGreaterThanOrEqual(floorY);
  expect(lowest, 'the projectile reaches the floor').toBeLessThan(floorY + 0.05);
  expect(productErrors).toEqual([]);
});

test('switching through every background in a grid is stable and the scene goes quiet', async ({
  page,
}) => {
  const productErrors = observeProductErrors(page);
  await openFixture(page);
  await page.locator('#split-keep-view-btn').click();
  await expect(page.locator('.split-badge')).toHaveCount(2);
  await openGridFocusedOnLive(page);

  // Forward and back, one frame apart: every switch lands mid-fade.
  for (const background of [...VIEWER_BACKGROUNDS, ...[...VIEWER_BACKGROUNDS].reverse()]) {
    await setControl(page, 'background-select', background);
    await nextFrames(page, 1);
    expect(await page.evaluate(
      () => document.documentElement.dataset.viewerBackground,
    )).toBe(background);
  }

  for (const background of ['studio', 'studio-dark']) {
    await setControl(page, 'background-select', background);
    // The page behind the canvas is exactly the colour the canvas clears to.
    const [r, g, b] = STUDIO_PALETTES[background].surface;
    await expect.poll(() => page.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    )).toBe(`rgb(${r}, ${g}, ${b})`);
    const clear = await page.evaluate(() => Array.from(
      window._cellucidViewer.getPresentedViewState('live').renderState.bgColor,
      channel => Math.round(channel * 255),
    ));
    expect(clear).toEqual([r, g, b]);
  }

  // The fade settles: nothing is drawn once it is over.
  await expect.poll(() => sceneQuietness(page)).toBe('quiet');

  // A floor ↔ dot-surface crossfade settles too.
  await setControl(page, 'navigation-mode', 'planar');
  await expect.poll(() => sceneQuietness(page)).toBe('quiet');
  await setDimension(page, 'live', 2);
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

test('a session carries the studio backgrounds out and back', async ({
  page,
}, testInfo) => {
  const productErrors = observeProductErrors(page);
  await openFixture(page);
  for (const background of ['studio-dark', 'studio']) {
    await setControl(page, 'background-select', background);
    const sessionPath = await saveSession(page, testInfo, `${background}.cellucid-session`);
    await setControl(page, 'background-select', 'white');
    await expect(page.locator('#background-select')).toHaveValue('white');
    await loadSession(page, sessionPath);
    await expect(page.locator('#background-select')).toHaveValue(background);
    await expect.poll(() => page.evaluate(
      () => document.documentElement.dataset.viewerBackground,
    )).toBe(background);
    const [r, g, b] = STUDIO_PALETTES[background].surface;
    await expect.poll(() => page.evaluate(() => Array.from(
      window._cellucidViewer.getPresentedViewState('live').renderState.bgColor,
      channel => Math.round(channel * 255),
    ))).toEqual([r, g, b]);
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

test('figure export reproduces the studio floor and dot surface', async ({
  page,
}) => {
  const productErrors = observeProductErrors(page);
  await openFixture(page);
  await page.locator('#figure-export-section > summary').click();
  await page.getByRole('button', { name: /^Download\b/ }).click();
  await expect(page.locator('#figure-export-reference-grid')).toBeChecked();

  // A 3-D orbit pane: floor rules stroked with gradients, glow and pool.
  await setControl(page, 'background-select', 'studio-dark');
  await setDimension(page, 'live', 3);
  await setControl(page, 'navigation-mode', 'orbit');
  await expect(page.locator('#figure-export-reference-grid')).toBeEnabled();
  const floorSvg = (await exportFigure(page, 'svg')).toString('utf8');
  expect(floorSvg).toContain('<g class="cellucid-studio-backdrop">');
  expect(floorSvg).toMatch(/<radialGradient id="reference_layer-tone-0"/);
  expect(floorSvg).toMatch(/<line [^>]*stroke="url\(#reference_layer-rule-\d+\)"/);
  const floorPng = await exportFigure(page, 'png');
  expect(floorPng.subarray(1, 4).toString('ascii')).toBe('PNG');
  expect(floorPng.length).toBeGreaterThan(1000);

  // A 2-D planar pane: the dot surface.
  await setControl(page, 'background-select', 'studio');
  await setDimension(page, 'live', 2);
  const dotsSvg = (await exportFigure(page, 'svg')).toString('utf8');
  const backdrop = dotsSvg.slice(dotsSvg.indexOf('<g class="cellucid-studio-backdrop">'));
  expect(backdrop.length).toBeGreaterThan(0);
  expect(backdrop).toMatch(/<g stroke="none"><circle /);
  expect(dotsSvg).not.toMatch(/stroke="url\(#reference_layer-rule-/);
  const dotsPng = await exportFigure(page, 'png');
  expect(dotsPng.length).toBeGreaterThan(1000);

  expect(productErrors).toEqual([]);
});
