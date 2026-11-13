/**
 * No near fade: a cell near
 * the camera is drawn whole and opaque at its perspective size, up to the
 * 160 px cap (within the GPU's own largest point, rendering/point-sprite.js),
 * is picked, and is in the figure, however near the camera comes and in
 * every shader quality. The spec fails if any distance-based fade or shrink
 * returns.
 *
 * One camera eye, one direction, targets on the same line of sight: with the
 * target at the subject the near cell lies at 0.13 of the orbit radius; with
 * the target in front of it, at 0.52 (the removed fade ran from 0.5 to 0.2 of
 * it). The near cell covers the line of sight in front of the subject.
 */
import { expect, test } from './helpers/test.mjs';

import { serveSyntheticCatalog } from './helpers/anndata-zarr-zip.mjs';
import { appUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { waitForDatasetReady, waitForPageAtRest } from './helpers/dataset-ready.mjs';
import { decodePng } from './helpers/png-pixels.mjs';

const DATASET = 'near-camera';
const ROOT = appUrl('/tests/browser/fixtures/generated-near-camera/');
const FIELD = { source: 'obs', key: 'part' };
// Nine subject cells about the origin, one near cell in front of them on +z,
// four frame cells far out that set the embedding's scale.
const SUBJECT = Array.from({ length: 9 }, (_, index) => [((index % 3) - 1) * 0.05, (Math.floor(index / 3) - 1) * 0.05, 0]);
const NEAR = [[0, 0, 2]];
const FRAME = [[-3, -3, -2], [3, -3, -2], [-3, 3, -2], [3, 3, -2]];
const CELLS = [...SUBJECT, ...NEAR, ...FRAME];
const NEAR_INDEX = SUBJECT.length;

function observeErrors(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(`page: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  return errors;
}

function dispatch(page, type, params) {
  return page.evaluate(async ([actionType, actionParams]) => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    return (await getActions().dispatch(actionType, actionParams)).outcome;
  }, [type, params]);
}

async function open(page) {
  await serveSyntheticCatalog(page, ROOT, {
    id: DATASET,
    name: 'Near camera fixture',
    cells: CELLS.length,
    obs: {
      part: {
        categories: ['subject', 'near', 'frame'],
        codes: Int8Array.from(CELLS.map((_, index) => (index < NEAR_INDEX ? 0 : index === NEAR_INDEX ? 1 : 2))),
      },
    },
    obsm: { X_umap: { data: Float32Array.from(CELLS.flat()), columns: 3 } },
  });
  await page.goto(`/?sampleCatalog=${encodeURIComponent(ROOT)}&dataset=${DATASET}`, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await waitForDatasetReady(page, CELLS.length);
  await dispatch(page, 'layout.sidebar.show', { shown: false });
  await dispatch(page, 'color.by', { field: FIELD });
  for (const [category, color] of [['subject', '#0000ff'], ['near', '#ff0000'], ['frame', '#00ff00']]) {
    await dispatch(page, 'color.category', { field: FIELD, category, color });
  }
  // Flat discs, no lighting or fog: a cell's pixels are its color.
  await dispatch(page, 'setting.set', { setting: 'hp-shader-quality', value: 'ultralight' });
  // And nothing else drawn in a cell's color: the orbit anchor's compass has
  // a red mark, which shows as one red pixel beside the near cell once the
  // target comes close to the eye (WebKit: "310 px against the cap 160").
  await dispatch(page, 'setting.set', { setting: 'show-orbit-anchor', value: false });
  await dispatch(page, 'setting.set', { setting: 'size-attenuation', value: 100 });
}

/**
 * The camera on the near cell's line of sight to the subject, its eye 0.15
 * of their distance in front of the near cell, its target `targetAt` of the
 * eye-to-subject distance along that line.
 */
async function cameraOnTheLine(page, targetAt) {
  const framing = await dispatch(page, 'camera.framing', { field: FIELD, categories: ['subject', 'near'], fill: 0.5 });
  const center = label => framing.groups.find(group => group.label === label).center;
  const subject = center('subject');
  const near = center('near');
  const span = Math.hypot(near[0] - subject[0], near[1] - subject[1], near[2] - subject[2]);
  const direction = near.map((value, axis) => (value - subject[axis]) / span);
  const eyeDistance = span * 1.15;
  const eye = subject.map((value, axis) => value + direction[axis] * eyeDistance);
  const radius = eyeDistance * targetAt;
  const target = eye.map((value, axis) => value - direction[axis] * radius);
  const phi = Math.acos(Math.max(-1, Math.min(1, direction[1])));
  const theta = Math.atan2(direction[2], direction[0]);
  return {
    navigationMode: 'orbit',
    orbit: { radius, targetRadius: radius, theta, phi, target },
    freefly: {
      position: eye,
      yaw: Math.atan2(-direction[2], -direction[0]),
      pitch: Math.asin(Math.max(-1, Math.min(1, -direction[1]))),
    },
  };
}

/**
 * Pixels of the near cell (red: its red channel well above the others, so a
 * lit or glossed red counts too) and of the subject (pure blue) in a PNG, and
 * the red ones' width.
 */
function census(png) {
  const { width, height, channels, pixels } = decodePng(png);
  const counts = { red: 0, blue: 0 };
  let minX = Infinity;
  let maxX = -Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * channels;
      const [r, g, b] = [pixels[at], pixels[at + 1], pixels[at + 2]];
      if (r > 60 && r > g + 60 && r > b + 60) {
        counts.red++;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
      } else if (b > 220 && r < 40 && g < 40) counts.blue++;
    }
  }
  return { ...counts, redWidth: counts.red === 0 ? 0 : maxX - minX + 1 };
}

async function screen(page) {
  // Drawn and at rest: the camera's frame presented, and the sidebar hidden
  // in `open` done sliding, so the pane's center is the canvas's (a pick at
  // the canvas center then reads what the screenshot shows there).
  await waitForPageAtRest(page);
  return census(await page.locator('#glcanvas').screenshot());
}

async function picture(page) {
  const { png } = await dispatch(page, 'view.picture', { width: 640, height: 400, legend: false });
  return census(Buffer.from(png, 'base64'));
}

/** The cell drawn at the canvas center (the line of sight). */
function pickAtCentre(page) {
  return page.evaluate(() => {
    const box = document.getElementById('glcanvas').getBoundingClientRect();
    return window._cellucidViewer.pickCellAtScreen(box.left + box.width / 2, box.top + box.height / 2);
  });
}

async function gpuCap(page) {
  return page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    return Math.min(160, gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1]);
  });
}

test('a cell near the camera is drawn whole at the cap, picked and in the figure, at every distance from 0.13 to 0.54 of the orbit radius, in every shader quality', async ({ page }) => {
  const errors = observeErrors(page);
  await open(page);
  const view = (await dispatch(page, 'views.state', {})).active;
  await dispatch(page, 'setting.set', { setting: 'point-size', value: 60 });
  const cap = await gpuCap(page);

  // The eye stays; the target moves along the line of sight, so the near
  // cell's depth over the orbit radius runs from 0.13 (target at the subject)
  // through the removed fade's whole range.
  const ratios = [0.13, ...Array.from({ length: 13 }, (_, step) => 0.18 + step * 0.03)];
  for (const ratio of ratios) {
    await dispatch(page, 'camera.set', { view, camera: await cameraOnTheLine(page, 0.15 / (1.15 * ratio)) });
    const frame = await screen(page);
    const at = `at ${ratio.toFixed(2)} of the orbit radius`;
    // A square sprite of `cap` device pixels (Ultra-light, device pixel
    // ratio 1); its edge columns may be shared with the background.
    expect(Math.abs(frame.redWidth - cap), `${at}: ${frame.redWidth} px against the cap ${cap}`).toBeLessThanOrEqual(1);
    expect(Math.abs(frame.red / (cap * cap) - 1), `${at}: the whole sprite is drawn (${frame.red} px)`).toBeLessThan(0.03);
    expect(await pickAtCentre(page), `${at}: the near cell is picked`).toBe(NEAR_INDEX);
  }

  // Target at the subject (0.13): the figure draws the near cell too, as
  // large a share of the picture as the screen shows.
  await dispatch(page, 'camera.set', { view, camera: await cameraOnTheLine(page, 1) });
  const onScreen = await screen(page);
  const figure = await picture(page);
  expect(figure.red, 'the near cell is in the figure').toBeGreaterThan(0);
  const canvas = await page.locator('#glcanvas').boundingBox();
  const screenShare = onScreen.red / (canvas.width * canvas.height);
  const figureShare = figure.red / (640 * 400);
  expect(figureShare / screenShare, `figure ${figureShare} against screen ${screenShare}`).toBeGreaterThan(0.5);

  await test.step('every shader quality draws and picks a cell near the camera whole', async () => {
    await dispatch(page, 'camera.set', { view, camera: await cameraOnTheLine(page, 1) });
    for (const quality of ['full', 'sculpted', 'light', 'ultralight']) {
      await dispatch(page, 'setting.set', { setting: 'hp-shader-quality', value: quality });
      const frame = await screen(page);
      // A disc covers pi/4 of its square; Ultra-light draws the square.
      const whole = quality === 'ultralight' ? cap * cap : (Math.PI / 4) * cap * cap;
      expect(frame.red / whole, `${quality}: the near cell's share drawn (${frame.red} px)`).toBeGreaterThan(0.9);
      expect(Math.abs(frame.redWidth - cap), `${quality}: ${frame.redWidth} px against the cap ${cap}`).toBeLessThanOrEqual(2);
      expect(await pickAtCentre(page), `${quality}: the near cell is picked`).toBe(NEAR_INDEX);
    }
  });
  expect(errors).toEqual([]);
});
