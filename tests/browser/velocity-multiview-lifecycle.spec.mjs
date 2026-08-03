import { expect, test } from './helpers/test.mjs';
import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const CURRENT_UI_DATASET =
  '/tests/browser/fixtures/exports/current-ui-prepared/';
const PROCESS_INTENSIVE = Object.freeze({
  tag: '@browser-process-intensive',
});

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

async function installVelocityGlAudit(page) {
  await page.addInitScript(() => {
    const prototype = WebGL2RenderingContext.prototype;
    const programRoles = new WeakMap();
    const objectIds = new WeakMap();
    let nextObjectId = 1;
    let currentProgram = null;
    let currentVertexArray = null;
    let currentTransformFeedbackBuffer = null;
    let currentFramebuffer = null;
    let currentViewport = [0, 0, 0, 0];
    let currentScissor = [0, 0, 0, 0];
    let scissorEnabled = false;
    let records = [];

    const idFor = value => {
      if (value === null) return null;
      if (!objectIds.has(value)) objectIds.set(value, nextObjectId++);
      return objectIds.get(value);
    };
    const wrap = (name, replacement) => {
      const original = prototype[name];
      prototype[name] = replacement(original);
    };

    wrap('getUniformLocation', original => function (program, name) {
      const result = Reflect.apply(original, this, [program, name]);
      if (name === 'u_spawnTableSize') {
        programRoles.set(program, 'simulate');
      } else if (name === 'u_particleSize') {
        programRoles.set(program, 'particles');
      } else if (name === 'u_trailTex') {
        programRoles.set(program, 'composite');
      }
      return result;
    });
    wrap('useProgram', original => function (program) {
      currentProgram = program;
      return Reflect.apply(original, this, [program]);
    });
    wrap('bindVertexArray', original => function (value) {
      currentVertexArray = value;
      return Reflect.apply(original, this, [value]);
    });
    wrap('bindBufferBase', original => function (target, index, value) {
      if (target === this.TRANSFORM_FEEDBACK_BUFFER && index === 0) {
        currentTransformFeedbackBuffer = value;
      }
      return Reflect.apply(original, this, [target, index, value]);
    });
    wrap('bindFramebuffer', original => function (target, value) {
      if (
        target === this.FRAMEBUFFER ||
        target === this.DRAW_FRAMEBUFFER
      ) {
        currentFramebuffer = value;
      }
      return Reflect.apply(original, this, [target, value]);
    });
    wrap('viewport', original => function (x, y, width, height) {
      currentViewport = [x, y, width, height];
      return Reflect.apply(original, this, [x, y, width, height]);
    });
    wrap('scissor', original => function (x, y, width, height) {
      currentScissor = [x, y, width, height];
      return Reflect.apply(original, this, [x, y, width, height]);
    });
    wrap('enable', original => function (capability) {
      if (capability === this.SCISSOR_TEST) scissorEnabled = true;
      return Reflect.apply(original, this, [capability]);
    });
    wrap('disable', original => function (capability) {
      if (capability === this.SCISSOR_TEST) scissorEnabled = false;
      return Reflect.apply(original, this, [capability]);
    });
    wrap('drawArrays', original => function (mode, first, count) {
      const role = currentProgram === null
        ? null
        : programRoles.get(currentProgram) ?? null;
      if (role !== null) {
        records.push({
          count,
          framebufferId: idFor(currentFramebuffer),
          mode,
          role,
          scissor: currentScissor.slice(),
          scissorEnabled,
          transformFeedbackBufferId:
            idFor(currentTransformFeedbackBuffer),
          vertexArrayId: idFor(currentVertexArray),
          viewport: currentViewport.slice(),
        });
      }
      return Reflect.apply(original, this, [mode, first, count]);
    });

    Object.defineProperty(window, '__cellucidVelocityAudit', {
      configurable: false,
      enumerable: false,
      value: Object.freeze({
        reset() {
          records = [];
        },
        snapshot() {
          return records.map(record => ({
            ...record,
            scissor: record.scissor.slice(),
            viewport: record.viewport.slice(),
          }));
        },
      }),
    });
  });
}

async function installVelocityFixture(page) {
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
}

async function advanceFrames(page, count) {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new RangeError('Velocity audit frame count must be a positive integer.');
  }
  await page.evaluate(frameCount => new Promise(resolve => {
    let remaining = frameCount;
    const advance = () => {
      remaining -= 1;
      if (remaining === 0) {
        resolve();
        return;
      }
      requestAnimationFrame(advance);
    };
    requestAnimationFrame(advance);
  }), count);
}

async function resetAudit(page) {
  await page.evaluate(() => window.__cellucidVelocityAudit.reset());
}

async function readAudit(page) {
  return page.evaluate(() => window.__cellucidVelocityAudit.snapshot());
}

test(
  'velocity owns exact all-hidden and multiview GPU generations in every pane',
  PROCESS_INTENSIVE,
  async ({ page }) => {
    const productErrors = [];
    const browserDiagnostics = [];
    page.on('console', message => {
      if (
        message.type() === 'warning' &&
        /GL Driver Message .*GPU stall due to ReadPixels/.test(
          message.text(),
        )
      ) {
        browserDiagnostics.push(message.text());
        return;
      }
      if (message.type() === 'error' || message.type() === 'warning') {
        productErrors.push(
          `console ${message.type()}: ${message.text()}`,
        );
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

    await installVelocityGlAudit(page);
    await installVelocityFixture(page);
    await page.goto(
      `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}&dataset=current-ui-prepared&acceptance=velocity-multiview-lifecycle`,
      { waitUntil: 'domcontentloaded' },
    );
    await dismissWelcome(page);
    await expect(page.locator('#dataset-name')).toHaveText(
      'Current UI prepared fixture',
    );
    await page.locator('#categorical-field').selectOption({
      label: 'cell_type',
    });
    await expect(page.locator('.legend-item')).toHaveCount(3);
    // This contract measures generation ownership, not particle throughput.
    // Keep the real transform-feedback and compositor paths while avoiding a
    // default 15K-particle workload on every deliberately sampled frame.
    await page.locator('#velocity-density').evaluate(input => {
      input.value = '1';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(page.locator('#velocity-density-display')).toHaveText('1K');
    await page.locator('#velocity-overlay-enabled').check();
    await expect(
      page.getByText('Velocity overlay ready', { exact: true }),
    ).toBeVisible();

    await resetAudit(page);
    // Two consecutive frames are the complete ping-pong ownership cycle.
    await advanceFrames(page, 2);
    const singleRecords = await readAudit(page);
    const singleSimulation = singleRecords.filter(
      record => record.role === 'simulate',
    );
    const singleParticles = singleRecords.filter(
      record => record.role === 'particles',
    );
    expect(singleSimulation.length).toBeGreaterThanOrEqual(2);
    expect(singleParticles.length).toBeGreaterThanOrEqual(2);
    expect(new Set(singleSimulation.map(
      record => record.transformFeedbackBufferId,
    )).size).toBe(2);
    expect(new Set(singleParticles.map(
      record => record.vertexArrayId,
    )).size).toBe(2);

    const legend = page.locator('#legend');
    await legend.getByRole('button', {
      name: 'Hide All',
      exact: true,
    }).click();
    await expect(page.locator('#filter-count')).toHaveText(
      'Showing 0 of 120 points',
    );
    // Existing generations rebuild silently; wait past the idle-callback
    // timeout so this proves the committed empty table, not only its fence.
    await page.waitForTimeout(750);
    await resetAudit(page);
    await advanceFrames(page, 2);
    const hiddenRecords = await readAudit(page);
    expect(
      hiddenRecords.filter(record => record.role === 'simulate'),
    ).toEqual([]);
    expect(
      hiddenRecords.filter(record => record.role === 'particles'),
    ).toEqual([]);

    await legend.getByRole('button', {
      name: 'Show All',
      exact: true,
    }).click();
    await expect(page.locator('#filter-count')).toHaveText(
      'Showing all 120 points',
    );
    // Accumulate real frames until the rebuilt generation renders. Resetting
    // inside the poll discarded valid evidence and multiplied GPU work on a
    // slow native renderer.
    await resetAudit(page);
    await expect.poll(async () => {
      await advanceFrames(page, 1);
      return (await readAudit(page)).filter(
        record => record.role === 'simulate',
      ).length;
    }).toBeGreaterThan(0);

    await page.locator('#split-keep-view-btn').click();
    await expect.poll(() => page.evaluate(() => (
      window._cellucidViewer.getSnapshotViews().map(view => view.id)
    ))).toEqual(['snap_1']);
    // The two views expose four ping-pong owners over two or more frames. Keep
    // the audit cumulative so every poll advances the proof instead of erasing
    // it and starting another four-frame GPU window.
    await resetAudit(page);
    await expect.poll(async () => {
      await advanceFrames(page, 1);
      const records = await readAudit(page);
      return new Set(records.filter(
        record => record.role === 'simulate',
      ).map(record => record.transformFeedbackBufferId)).size;
    }).toBe(4);

    // The successful poll already owns a complete multiview audit window;
    // re-running a second GPU window here adds no ownership evidence.
    const gridRecords = await readAudit(page);
    const gridSimulation = gridRecords.filter(
      record => record.role === 'simulate',
    );
    const gridParticles = gridRecords.filter(
      record => record.role === 'particles',
    );
    const gridComposite = gridRecords.filter(
      record => record.role === 'composite',
    );
    expect(gridSimulation.length).toBeGreaterThanOrEqual(4);
    expect(gridParticles.length).toBeGreaterThanOrEqual(4);
    expect(gridComposite.length).toBeGreaterThanOrEqual(4);

    // Two views own four ping-pong buffers/VAOs, not one shared pair.
    expect(new Set(gridSimulation.map(
      record => record.transformFeedbackBufferId,
    )).size).toBe(4);
    expect(new Set(gridParticles.map(
      record => record.vertexArrayId,
    )).size).toBe(4);

    // Every offscreen particle pass owns an origin-local target with scissor
    // disabled; every composite owns its exact canvas-space pane.
    expect(gridParticles.every(record => (
      record.framebufferId !== null &&
      record.scissorEnabled === false &&
      record.viewport[0] === 0 &&
      record.viewport[1] === 0
    ))).toBe(true);

    // The composite draws into the frame's own scene target, which is the
    // default framebuffer only while antialiasing is off. With it on the scene
    // is drawn into a multisampled renderbuffer and blitted at the end of the
    // frame, so a composite that went to framebuffer zero would be painted over
    // by that blit and the flow would vanish. What must hold in both states is
    // that every pane composites into the SAME target, and that the target is
    // the one the frame is being drawn into.
    const compositeTargets = new Set(
      gridComposite.map(record => record.framebufferId),
    );
    expect(compositeTargets.size).toBe(1);
    const antialiasing = await page.evaluate(
      () => window._cellucidViewer.getAntialiasing(),
    );
    expect([...compositeTargets][0] === null).toBe(!antialiasing);
    expect(gridComposite.every(record => (
      record.scissorEnabled === true &&
      record.viewport.join(',') === record.scissor.join(',')
    ))).toBe(true);
    expect(new Set(gridComposite.map(
      record => record.viewport[0],
    )).size).toBe(2);

    const glError = await page.locator('#glcanvas').evaluate(canvas => (
      canvas.getContext('webgl2').getError()
    ));
    expect(glError).toBe(0);
    expect(page.locator('#velocity-overlay-enabled')).toBeChecked();
    expect(productErrors).toEqual([]);
    expect(browserDiagnostics.length).toBeLessThanOrEqual(4);
  },
);

test(
  'velocity allocation failure settles once without poisoning the viewer loop',
  PROCESS_INTENSIVE,
  async ({ page }) => {
    const productErrors = [];
    page.on('console', message => {
      if (
        message.type() === 'warning' &&
        /GL Driver Message .*GPU stall due to ReadPixels/.test(
          message.text(),
        )
      ) {
        return;
      }
      if (message.type() === 'error' || message.type() === 'warning') {
        productErrors.push(
          `console ${message.type()}: ${message.text()}`,
        );
      }
    });
    page.on('pageerror', error => {
      productErrors.push(`page: ${error.stack || error.message}`);
    });

    await installVelocityFixture(page);
    await page.goto(
      `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}&dataset=current-ui-prepared&acceptance=velocity-allocation-failure`,
      { waitUntil: 'domcontentloaded' },
    );
    await dismissWelcome(page);
    await expect(page.locator('#dataset-name')).toHaveText(
      'Current UI prepared fixture',
    );
    await page.locator('#glcanvas').evaluate(canvas => {
      const gl = canvas.getContext('webgl2');
      const original = gl.createFramebuffer.bind(gl);
      let failed = false;
      gl.createFramebuffer = () => {
        if (!failed) {
          failed = true;
          gl.createFramebuffer = original;
          return null;
        }
        return original();
      };
    });

    await page.locator('#velocity-overlay-enabled').check();
    await expect(page.locator('#velocity-overlay-enabled')).not.toBeChecked();
    await expect(page.locator('#velocity-overlay-info')).toHaveText(
      'Velocity rendering unavailable.',
    );
    await expect(page.locator('.notification-error')).toContainText(
      'Velocity rendering stopped:',
    );
    // Two completed viewer frames prove failure settlement across a full
    // ping-pong cycle without adding unrelated GPU soak work.
    await advanceFrames(page, 2);

    const viewerState = await page.locator('#glcanvas').evaluate(canvas => {
      const gl = canvas.getContext('webgl2');
      return {
        depth: gl.isEnabled(gl.DEPTH_TEST),
        error: gl.getError(),
        framebufferIsDefault:
          gl.getParameter(gl.FRAMEBUFFER_BINDING) === null,
      };
    });
    expect(viewerState).toEqual({
      depth: true,
      error: 0,
      framebufferIsDefault: true,
    });
    expect(productErrors).toEqual([]);
  },
);

test(
  'transient velocity initialization failure cleans up and retries on the same overlay',
  PROCESS_INTENSIVE,
  async ({ page }) => {
    const productErrors = [];
    page.on('console', message => {
      if (
        message.type() === 'warning' &&
        /GL Driver Message .*GPU stall due to ReadPixels/.test(
          message.text(),
        )
      ) {
        return;
      }
      if (message.type() === 'error' || message.type() === 'warning') {
        productErrors.push(
          `console ${message.type()}: ${message.text()}`,
        );
      }
    });
    page.on('pageerror', error => {
      productErrors.push(`page: ${error.stack || error.message}`);
    });

    await installVelocityFixture(page);
    await page.goto(
      `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}&dataset=current-ui-prepared&acceptance=velocity-init-retry`,
      { waitUntil: 'domcontentloaded' },
    );
    await dismissWelcome(page);
    await expect(page.locator('#dataset-name')).toHaveText(
      'Current UI prepared fixture',
    );
    await page.locator('#glcanvas').evaluate(canvas => {
      const gl = canvas.getContext('webgl2');
      const original = gl.createTransformFeedback.bind(gl);
      gl.createTransformFeedback = () => {
        gl.createTransformFeedback = original;
        return null;
      };
    });

    const checkbox = page.locator('#velocity-overlay-enabled');
    await checkbox.click();
    await expect(checkbox).not.toBeChecked();
    await expect(page.locator('#velocity-overlay-info')).toHaveText(
      'Failed to load vector field.',
    );
    await expect(page.locator('.notification-error')).toContainText(
      'transform-feedback',
    );

    await checkbox.click();
    await expect(checkbox).toBeChecked();
    await expect(
      page.getByText('Velocity overlay ready', { exact: true }),
    ).toBeVisible();
    await advanceFrames(page, 2);

    const glError = await page.locator('#glcanvas').evaluate(canvas => (
      canvas.getContext('webgl2').getError()
    ));
    expect(glError).toBe(0);
    expect(productErrors).toEqual([]);
  },
);
