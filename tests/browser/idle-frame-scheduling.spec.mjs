/**
 * A scene that cannot change is not redrawn.
 *
 * The viewer used to redraw every animation frame, so an untouched dataset of
 * any size cost a full GPU pass sixty times a second. It now draws only after
 * something can have changed — a public mutation, viewer input, a resize, or a
 * time-driven effect — plus a short settle window. These checks pin both
 * halves: a static scene goes quiet, and any mutation draws again with the
 * canvas still holding the last frame in between.
 */

import { closeContextWithApplicationRetirement, expect, test } from './helpers/test.mjs';
import { ENCODED_SAMPLE_CATALOG_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import {
  QUIET_WINDOW_MS,
  countDrawsDuring,
  countDrawsOverFrames,
  sceneQuietness,
} from './helpers/frame-scheduling.mjs';

const DATASET_URL =
  `/?sampleCatalog=${ENCODED_SAMPLE_CATALOG_URL}`
  + '&dataset=current-ui&acceptance=idle-frame-scheduling-ci';

test('a static scene stops drawing and a mutation draws it again', async ({
  page,
}) => {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture',
  );

  // The scene goes quiet once startup work and the settle window run out. How
  // long startup work keeps invalidating frames depends on the runner, so
  // poll until the viewer reports the scene settled and a window passes with
  // no draw; a viewer that never stops drawing still fails.
  await page.evaluate(() => window._cellucidViewer.setFrameInvalidationTracing(true));
  await expect.poll(() => sceneQuietness(page)).toBe('quiet');

  // The presented frame is still readable while nothing is drawn.
  const litPixels = await page.evaluate(() => {
    const gl = window._cellucidViewer.getGLContext();
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const pixels = new Uint8Array(width * height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let lit = 0;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] !== 0) lit += 1;
    }
    return lit;
  });
  expect(litPixels).toBeGreaterThan(0);

  // A public mutation draws again, then the scene goes quiet once more.
  expect(
    await countDrawsDuring(page, null, { mutate: true }),
  ).toBeGreaterThan(0);

  // Nothing else is in flight now, so the mutation's frame is the last cause.
  // Settling needs both the settle time and a minimum number of drawn frames,
  // so on a host that draws slowly it takes longer than the time alone; it
  // must then go quiet.
  await page.evaluate(() => window._cellucidViewer.setFrameInvalidationTracing(true));
  await expect.poll(() => sceneQuietness(page)).toBe('quiet');
});

test('a still highlight lets the scene go quiet; only a pulsing one keeps drawing', async ({
  page,
}) => {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture',
  );

  const selectQuality = quality => page.evaluate(value => {
    const select = document.getElementById('hp-shader-quality');
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, quality);

  // Highlight a few cells. In `light` the ring is a still picture, so once the
  // settle window passes the viewer must stop drawing, selection or not.
  await selectQuality('light');
  await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const highlight = new Uint8Array(window._cellucidState.pointCount);
    highlight[0] = 255;
    highlight[1] = 255;
    viewer.updateHighlight(highlight);
  });
  await expect.poll(() => page.evaluate(() => window._cellucidViewer.getHighlightedCount())).toBeGreaterThan(0);
  await expect.poll(() => sceneQuietness(page)).toBe('quiet');

  // `sculpted` draws the same 3-D ring as `full`, held still.
  await selectQuality('sculpted');
  await expect.poll(() => sceneQuietness(page)).toBe('quiet');

  // `full` pulses its ring, which is a time-driven effect that draws: the loop
  // names it as the reason for the next frame, so it never settles, and the
  // frames keep being drawn. Frames, not a wall-clock window, because a slow
  // renderer may draw none in a short window.
  await selectQuality('full');
  await expect.poll(() => page.evaluate(
    () => window._cellucidViewer.getFrameScheduleState().animationCause,
  )).toBe('highlight');
  expect(await countDrawsOverFrames(page, 2)).toBeGreaterThan(0);

  // Clearing the selection ends the animation and the scene goes quiet again.
  await page.evaluate(() => {
    window._cellucidViewer.updateHighlight(
      new Uint8Array(window._cellucidState.pointCount),
    );
  });
  await expect.poll(() => sceneQuietness(page)).toBe('quiet');
});

test('a selection preview republished with the same cells does not redraw the scene', async ({
  page,
}) => {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture',
  );
  // A still ring, so a highlight alone is no reason to keep drawing.
  await page.evaluate(() => {
    const select = document.getElementById('hp-shader-quality');
    select.value = 'light';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.evaluate(() => window._cellucidState.setPreviewHighlightFromIndices(Uint32Array.of(0, 1, 2)));
  await expect.poll(() => sceneQuietness(page)).toBe('quiet');

  // What a lasso does on every pointer move: publish the preview again. The
  // same cells are the same picture, so the frame stays valid and nothing is
  // re-uploaded; a different set redraws.
  const invalidatedBy = indices => page.evaluate(cells => {
    window._cellucidState.setPreviewHighlightFromIndices(Uint32Array.from(cells));
    return window._cellucidViewer.getFrameScheduleState().invalidated;
  }, indices);
  expect(await invalidatedBy([0, 1, 2])).toBe(false);
  expect(await invalidatedBy([0, 1, 2])).toBe(false);
  expect(await countDrawsDuring(page, QUIET_WINDOW_MS)).toBe(0);
  expect(await invalidatedBy([0, 1, 3])).toBe(true);
  await expect.poll(() => page.evaluate(() => window._cellucidViewer.getHighlightedCount())).toBe(3);
  await expect.poll(() => sceneQuietness(page)).toBe('quiet');

  // Clearing a preview that is shown redraws; clearing again does not.
  expect(await page.evaluate(() => {
    window._cellucidState.clearPreviewHighlight();
    return window._cellucidViewer.getFrameScheduleState().invalidated;
  })).toBe(true);
  await expect.poll(() => sceneQuietness(page)).toBe('quiet');
  expect(await page.evaluate(() => {
    window._cellucidState.clearPreviewHighlight();
    return window._cellucidViewer.getFrameScheduleState().invalidated;
  })).toBe(false);
});

test('a renderer slower than the settle window still settles the camera', async ({
  page,
}) => {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture',
  );

  // The dataset's first frames publish its presented state (its LOD among
  // it); on a slow renderer they can still be coming after the name shows.
  // Subscribe once the scene has settled, then let a frame establish the
  // subscriber's baseline.
  await expect.poll(() => sceneQuietness(page)).toBe('quiet');
  await page.evaluate(async () => {
    const viewer = window._cellucidViewer;
    const events = [];
    window.__slowFrameSettlement = {
      events,
      unsubscribe: viewer.onPresentedViewStateChanged(event => {
        events.push(event.reason);
      }),
    };
    await new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  });

  // Frames now arrive further apart than the wall-clock settle window, as on
  // a throttled or software-rendered CI host. Settlement still needs its
  // unchanged frames, so drawing must not stop after the first frame past the
  // window.
  await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    window.requestAnimationFrame = callback => originalRequestAnimationFrame(
      () => {
        setTimeout(() => originalRequestAnimationFrame(callback), 1_100);
      },
    );
    window.__slowFrameSettlement.restore = () => {
      window.requestAnimationFrame = originalRequestAnimationFrame;
    };
    const camera = viewer.getCameraState();
    viewer.setCameraState({
      ...camera,
      orbit: { ...camera.orbit, theta: camera.orbit.theta + 0.05 },
    });
  });

  await expect.poll(
    () => page.evaluate(() => window.__slowFrameSettlement.events),
    { timeout: 30_000 },
  ).toEqual(['camera-changing', 'camera-settled']);
  await page.evaluate(() => {
    window.__slowFrameSettlement.unsubscribe();
    window.__slowFrameSettlement.restore();
  });
});

/**
 * Count draw calls while `actions` drive real input, then restore the context.
 * Each counted draw also records why the frame loop drew it
 * (`getFrameScheduleState`), so a failure names its cause.
 */
async function countDrawsDuringInput(page, actions) {
  await page.evaluate(() => {
    const viewer = window._cellucidViewer;
    const gl = viewer.getGLContext();
    const counter = { draws: 0, causes: new Set(), restore: null };
    const names = [
      'drawArrays',
      'drawElements',
      'drawArraysInstanced',
      'drawElementsInstanced',
    ];
    for (const name of names) {
      const original = gl[name];
      gl[name] = function countedDraw(...args) {
        counter.draws += 1;
        const state = viewer.getFrameScheduleState();
        // With tracing on, the nearest callers of the last invalidation.
        const trace = (state.lastInvalidationTrace ?? '')
          .split('\n')
          .slice(2, 6)
          .map(line => line.trim().replace(/\s*\(?https?:\/\/[^/]+\//, ' ').replace(/\)$/, ''))
          .join(' < ');
        counter.causes.add(`${state.lastCause}/${state.animationCause}${trace ? ` @ ${trace}` : ''}`);
        return Reflect.apply(original, this, args);
      };
    }
    counter.restore = () => {
      for (const name of names) delete gl[name];
    };
    window.__inputDrawCounter = counter;
  });
  try {
    await actions();
    // Two frames, so a frame the input invalidated has been drawn.
    await page.evaluate(() => new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
  } finally {
    return page.evaluate(() => {
      const counter = window.__inputDrawCounter;
      counter.restore();
      delete window.__inputDrawCounter;
      return { draws: counter.draws, causes: [...counter.causes].join(', ') };
    });
  }
}

test('pointer movement and typing that change nothing do not redraw the scene', async ({
  page,
}) => {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture',
  );
  await page.evaluate(() => window._cellucidViewer.setFrameInvalidationTracing(true));
  await expect.poll(() => sceneQuietness(page)).toBe('quiet');

  const canvas = await page.locator('#glcanvas').boundingBox();
  const field = page.locator('#remote-server-url');
  const fieldBox = await field.boundingBox();
  expect(canvas).not.toBeNull();
  expect(fieldBox).not.toBeNull();
  const x = canvas.x + canvas.width * 0.7;
  const y = canvas.y + canvas.height * 0.5;

  // Hovering the canvas and the sidebar, and typing into a sidebar field, are
  // page-wide input the viewer listens to but does not act on. Each used to
  // invalidate the frame, and every invalidation keeps drawing for a whole
  // settle window.
  const idleInputDraws = await countDrawsDuringInput(page, async () => {
    for (let step = 0; step < 20; step++) {
      await page.mouse.move(x + step * 3, y + step * 2);
    }
    for (let step = 0; step < 10; step++) {
      await page.mouse.move(fieldBox.x + 5 + step, fieldBox.y + fieldBox.height / 2);
    }
    await field.focus();
    await page.keyboard.type('abc');
    await page.waitForTimeout(250);
  });
  expect(idleInputDraws.draws, `draws caused by: ${idleInputDraws.causes}`).toBe(0);
  await field.fill('');

  // A drag on the canvas moves the camera and is drawn.
  const dragDraws = await countDrawsDuringInput(page, async () => {
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let step = 1; step <= 10; step++) {
      await page.mouse.move(x + step * 8, y + step * 4);
      await page.evaluate(() => new Promise(resolve => {
        requestAnimationFrame(resolve);
      }));
    }
    await page.mouse.up();
  });
  expect(dragDraws.draws).toBeGreaterThan(0);
});

test('focus and visibility changes that end no input do not redraw the scene', async ({
  page,
}) => {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture',
  );
  await expect.poll(() => sceneQuietness(page)).toBe('quiet');

  // Another window or a system dialog taking focus, and the tab being hidden
  // and shown, change nothing on screen. Each used to invalidate the frame,
  // so focus shuffling between windows redrew the scene for a settle window.
  const focusDraws = await countDrawsDuringInput(page, async () => {
    await page.evaluate(() => {
      for (let round = 0; round < 5; round++) {
        window.dispatchEvent(new Event('blur'));
        window.dispatchEvent(new Event('focus'));
        document.dispatchEvent(new Event('visibilitychange'));
      }
    });
    await page.waitForTimeout(250);
  });
  expect(focusDraws.draws, `draws caused by: ${focusDraws.causes}`).toBe(0);

  // A held navigation key released by losing focus does change the frame.
  const releaseDraws = await countDrawsDuringInput(page, async () => {
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true }));
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  });
  expect(releaseDraws.draws).toBeGreaterThan(0);
  // The key is no longer held, so the camera coasts to a stop instead of
  // moving for good.
  expect(await page.evaluate(
    () => window._cellucidViewer.getFrameScheduleState().animationCause,
  )).not.toBe('movement-key');
  // Coming to rest is counted in frames (inertia decays once per frame), so
  // the poll keeps the suite's expect timeout rather than a fixed ten seconds
  // a renderer at one frame every couple of seconds cannot meet.
  await expect.poll(
    () => page.evaluate(() => window._cellucidViewer.isCameraInMotion()),
  ).toBe(false);
});

test('cell lookups under the pointer, and the Cell info card, do not redraw the scene', async ({
  page,
}) => {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI fixture',
  );
  // The field activation is asynchronous and redraws the scene when it lands
  // (new colours, labels and centroids). Its legend is the sign it has landed;
  // until then its redraw can fall into any window measured below.
  await page.locator('#categorical-field').selectOption({ label: 'cell_type' });
  await expect(page.locator('.legend-item')).toHaveCount(3);
  await page.evaluate(() => window._cellucidViewer.setFrameInvalidationTracing(true));
  await expect.poll(() => sceneQuietness(page)).toBe('quiet');

  // Looking a cell up reads the scene. It used to count as a mutation, so a
  // hover reader redrew everything for a settle window after every lookup.
  const lookupDraws = await countDrawsDuringInput(page, async () => {
    await page.evaluate(async () => {
      const viewer = window._cellucidViewer;
      for (let index = 0; index < 20; index++) {
        viewer.pickCellRecordAtScreen(400 + index * 7, 300 + index * 5);
        viewer.pickReadyCellRecordAtScreen(400 + index * 7, 300 + index * 5);
        viewer.pickCellAtScreen(400 + index * 7, 300 + index * 5);
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      viewer.prepareCellPicking();
    });
    await page.waitForTimeout(250);
  });
  expect(lookupDraws.draws, `draws caused by: ${lookupDraws.causes}`).toBe(0);

  // The Cell info card on, swept across cells: a page element moves, the
  // scene does not.
  // Switching it on prepares the lookup index, which changes nothing drawn.
  const toggleDraws = await countDrawsDuringInput(page, async () => {
    await page.locator('#cell-info-toggle').check();
    await page.waitForTimeout(250);
  });
  expect(toggleDraws.draws, `draws caused by: ${toggleDraws.causes}`).toBe(0);
  const canvas = await page.locator('#glcanvas').boundingBox();
  const cardDraws = await countDrawsDuringInput(page, async () => {
    for (let step = 0; step < 30; step++) {
      await page.mouse.move(
        canvas.x + canvas.width * (0.4 + step * 0.01),
        canvas.y + canvas.height * (0.4 + (step % 5) * 0.03),
      );
    }
    await page.waitForTimeout(250);
  });
  expect(cardDraws.draws, `draws caused by: ${cardDraws.causes}`).toBe(0);
});

test('a backdrop whose opacity target drops still settles, and reduced motion skips fades', async ({
  browser,
}) => {
  for (const reducedMotion of ['no-preference', 'reduce']) {
    const context = await browser.newContext({ reducedMotion });
    const page = await context.newPage();
    try {
      await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
      await dismissWelcome(page);
      await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
      // Grid (light) fades the grid to 0.85, Grid (dark) to 0.75. The fade used
      // to move only upwards, so after this switch the opacity stayed above
      // its target and the scene was redrawn on every frame, indefinitely.
      for (const background of ['grid', 'grid-dark', 'studio', 'studio-dark', 'white']) {
        await page.evaluate(mode => window._cellucidViewer.setBackground(mode), background);
        if (reducedMotion === 'reduce') {
          // No decorative transition is left running after the switch frame.
          await page.evaluate(() => new Promise(resolve => {
            requestAnimationFrame(() => requestAnimationFrame(resolve));
          }));
          expect(
            await page.evaluate(() => window._cellucidViewer.getFrameScheduleState().animationCause),
            `${background} under reduced motion`,
          ).toBeNull();
        }
        await expect.poll(
          () => sceneQuietness(page),
          { message: `${background} (${reducedMotion}) goes quiet` },
        ).toBe('quiet');
      }
    } finally {
      await closeContextWithApplicationRetirement(context);
    }
  }
});


test('a settled scene requests no animation frames; input, a resize and a mutation start the loop again', async ({
  page,
}) => {
  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
  const frames = count => page.evaluate(n => new Promise(resolve => {
    const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  }), count);
  const armed = () => page.evaluate(() => window._cellucidViewer.getFrameScheduleState().frameArmed);
  const quietAndStopped = async () => {
    await expect.poll(() => sceneQuietness(page)).toBe('quiet');
    // The frame that found nothing to draw was the last one requested.
    await frames(2);
    expect(await armed()).toBe(false);
    await frames(4);
    expect(await armed()).toBe(false);
  };
  await quietAndStopped();

  // A slider drag (coalesced input) draws while the loop was stopped.
  const sliderDraws = await page.evaluate(async () => {
    const gl = window._cellucidViewer.getGLContext();
    const original = gl.drawArrays;
    let draws = 0;
    gl.drawArrays = function countedDraw(...args) {
      draws += 1;
      return Reflect.apply(original, this, args);
    };
    try {
      const input = document.getElementById('point-size');
      input.value = String(Number(input.value) + 4);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    } finally {
      delete gl.drawArrays;
    }
    return draws;
  });
  expect(sliderDraws).toBeGreaterThan(0);
  await quietAndStopped();

  // A canvas resize draws at the new size.
  const before = await page.evaluate(() => window._cellucidViewer.getGLContext().drawingBufferWidth);
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: viewport.width - 120, height: viewport.height });
  await expect.poll(
    () => page.evaluate(() => window._cellucidViewer.getGLContext().drawingBufferWidth),
  ).not.toBe(before);
  await expect.poll(
    () => page.evaluate(() => window._cellucidViewer.getFrameScheduleState().canvasResized),
  ).toBe(false);
  await quietAndStopped();

  // A public mutation draws again.
  expect(await countDrawsDuring(page, null, { mutate: true })).toBeGreaterThan(0);
  await quietAndStopped();
});
