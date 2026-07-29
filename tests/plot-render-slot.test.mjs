import assert from 'node:assert/strict';
import test from 'node:test';

import { PlotRenderSlot } from '../assets/js/app/analysis/shared/plot-render-slot.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeDom() {
  let nextCandidate = 0;
  const host = {
    isConnected: true,
    bounds: { width: 640, height: 480 },
    children: [],
    ownerDocument: {
      createElement(tagName) {
        return {
          tagName: tagName.toUpperCase(),
          serial: ++nextCandidate,
          style: {},
          attributes: new Map(),
          isConnected: false,
          parentNode: null,
          setAttribute(name, value) {
            this.attributes.set(name, value);
          },
          removeAttribute(name) {
            this.attributes.delete(name);
          },
          remove() {
            if (this.parentNode) {
              const index = this.parentNode.children.indexOf(this);
              if (index >= 0) this.parentNode.children.splice(index, 1);
            }
            this.parentNode = null;
            this.isConnected = false;
          }
        };
      }
    },
    append(candidate) {
      this.children.push(candidate);
      candidate.parentNode = this;
      candidate.isConnected = this.isConnected;
    },
    getBoundingClientRect() {
      return { ...this.bounds };
    }
  };
  return host;
}

function createHarness(overrides = {}) {
  const host = overrides.host ?? fakeDom();
  const events = [];
  const purgeCounts = new Map();
  const removeCounts = new Map();
  const slot = new PlotRenderSlot({
    host,
    measure: overrides.measure ?? (({ candidate }) => {
      events.push(`measure:${candidate.serial}`);
      assert.equal(candidate.isConnected, true);
      assert.equal(candidate.style.visibility, 'hidden');
      return { width: 640, height: 480 };
    }),
    resize: overrides.resize ?? (({ candidate, measurement }) => {
      events.push(`resize:${candidate.serial}`);
      candidate.style.width = `${measurement.width}px`;
      candidate.style.height = `${measurement.height}px`;
    }),
    createResizeObserver: overrides.createResizeObserver,
    render: overrides.render ?? (async ({ candidate, payload }) => {
      events.push(`render:${candidate.serial}:${payload.name}`);
      return { name: payload.name };
    }),
    purge: overrides.purge ?? (async ({ candidate }) => {
      purgeCounts.set(candidate.serial, (purgeCounts.get(candidate.serial) ?? 0) + 1);
      events.push(`purge:${candidate.serial}`);
    }),
    removeCandidate: overrides.removeCandidate ?? (async ({ candidate }) => {
      removeCounts.set(candidate.serial, (removeCounts.get(candidate.serial) ?? 0) + 1);
      events.push(`remove:${candidate.serial}`);
      candidate.remove();
    })
  });
  return { host, slot, events, purgeCounts, removeCounts };
}

function createZeroSizeObserverHarness({ disconnectError = null } = {}) {
  const host = fakeDom();
  host.bounds = { width: 0, height: 0 };
  const observerReady = deferred();
  let observerCallback = null;
  let disconnectCount = 0;
  let renderCount = 0;
  let purgeCount = 0;

  const slot = new PlotRenderSlot({
    host,
    createResizeObserver(callback) {
      observerCallback = callback;
      return {
        observe(target) {
          assert.equal(target, host);
          assert.equal(host.children[0].isConnected, true);
          assert.equal(host.children[0].style.visibility, 'hidden');
          observerReady.resolve();
        },
        disconnect() {
          disconnectCount += 1;
          if (disconnectError) throw disconnectError;
        }
      };
    },
    render: async () => {
      renderCount += 1;
      return 'rendered';
    },
    purge: async () => {
      purgeCount += 1;
    }
  });

  return {
    host,
    slot,
    observerReady,
    notifyResize() {
      observerCallback?.([]);
    },
    get disconnectCount() {
      return disconnectCount;
    },
    get renderCount() {
      return renderCount;
    },
    get purgeCount() {
      return purgeCount;
    }
  };
}

test('renders the exact payload in a connected, hidden, measurable candidate', async () => {
  const payload = { name: 'exact', matrix: new Float32Array([1, 2, 3]) };
  let receivedPayload = null;
  const harness = createHarness({
    render: async ({ candidate, payload: received }) => {
      receivedPayload = received;
      assert.equal(candidate.isConnected, true);
      assert.equal(candidate.style.visibility, 'hidden');
      assert.equal(candidate.style.pointerEvents, 'none');
      assert.equal(candidate.style.width, '640px');
      assert.equal(candidate.style.height, '480px');
      assert.equal(candidate.attributes.get('aria-hidden'), 'true');
      assert.equal('id' in candidate, false);
      return { rendered: true };
    }
  });

  const candidate = await harness.slot.render(payload);

  assert.equal(receivedPayload, payload);
  assert.equal(candidate, harness.host.children[0]);
  assert.equal(candidate.style.visibility, '');
  assert.equal(candidate.style.pointerEvents, '');
  assert.equal(candidate.attributes.has('aria-hidden'), false);
  assert.deepEqual(harness.events, ['measure:1', 'resize:1']);
});

test('zero-size hosts wait for an observed positive box without guessed dimensions', async () => {
  const harness = createZeroSizeObserverHarness();
  const result = harness.slot.render({ name: 'positive-box' });
  await harness.observerReady.promise;

  assert.equal(harness.renderCount, 0);
  assert.equal(harness.disconnectCount, 0);
  assert.equal(harness.host.children[0].style.visibility, 'hidden');

  harness.host.bounds = { width: 321, height: 234 };
  harness.notifyResize();
  const candidate = await result;

  assert.equal(harness.renderCount, 1);
  assert.equal(harness.disconnectCount, 1);
  assert.equal(candidate.style.width, '321px');
  assert.equal(candidate.style.height, '234px');
  assert.equal(candidate.style.visibility, '');
});

for (const lifecycleAction of ['invalidate', 'destroy']) {
  test(`${lifecycleAction} releases a zero-size measurement waiter`, { timeout: 1000 }, async () => {
    const harness = createZeroSizeObserverHarness();
    const result = harness.slot.render({ name: lifecycleAction });
    await harness.observerReady.promise;

    const lifecycle = harness.slot[lifecycleAction]();
    assert.equal(await result, null);
    await lifecycle;

    assert.equal(harness.renderCount, 0);
    assert.equal(harness.disconnectCount, 1);
    assert.equal(harness.purgeCount, 1);
    assert.equal(harness.host.children.length, 0);
  });
}

test('measurement-observer cleanup failures survive stale-request suppression', async () => {
  const disconnectError = new Error('observer disconnect failed');
  const harness = createZeroSizeObserverHarness({ disconnectError });
  const render = harness.slot.render({ name: 'cleanup-failure' });
  const renderOutcome = render.catch(error => error);
  await harness.observerReady.promise;

  const destroyOutcome = harness.slot.destroy().catch(error => error);
  const [renderError, destroyError] = await Promise.all([renderOutcome, destroyOutcome]);

  assert.equal(renderError, destroyError);
  assert.ok(renderError instanceof AggregateError);
  assert.equal(
    renderError.errors.filter(error => error === disconnectError).length,
    1
  );
  assert.equal(harness.renderCount, 0);
  assert.equal(harness.purgeCount, 1);
});

test('keeps one renderer running and coalesces pending requests to the newest', async () => {
  const firstGate = deferred();
  const firstStarted = deferred();
  const rendered = [];
  let firstCandidate = null;
  const harness = createHarness({
    render: async ({ candidate, payload }) => {
      rendered.push(payload.name);
      if (payload.name === 'first') {
        firstCandidate = candidate;
        firstStarted.resolve();
        await firstGate.promise;
      }
      return payload.name;
    }
  });

  const first = harness.slot.render({ name: 'first' });
  await firstStarted.promise;
  const second = harness.slot.render({ name: 'second' });
  const third = harness.slot.render({ name: 'third' });

  assert.equal(await second, null);
  assert.deepEqual(rendered, ['first']);
  assert.equal(harness.purgeCounts.get(firstCandidate.serial), undefined);
  assert.equal(firstCandidate.isConnected, true);

  firstGate.resolve();
  assert.equal(await first, null);
  const committed = await third;

  assert.deepEqual(rendered, ['first', 'third']);
  assert.equal(harness.purgeCounts.get(firstCandidate.serial), 1);
  assert.equal(harness.removeCounts.get(firstCandidate.serial), 1);
  assert.equal(firstCandidate.isConnected, false);
  assert.equal(committed.serial, 2);
});

test('a synchronous burst skips expensive rendering for a stale prepared candidate', async () => {
  const rendered = [];
  const harness = createHarness({
    render: async ({ payload }) => {
      rendered.push(payload.name);
      return payload.name;
    }
  });

  const first = harness.slot.render({ name: 'first' });
  const second = harness.slot.render({ name: 'second' });

  assert.equal(await first, null);
  assert.ok(await second);
  assert.deepEqual(rendered, ['second']);
  assert.equal(harness.purgeCounts.get(1), 1);
  assert.equal(harness.removeCounts.get(1), 1);
});

test('suppresses a stale renderer failure after retiring its candidate', async () => {
  const gate = deferred();
  const staleError = new Error('stale render failed');
  const harness = createHarness({
    render: async ({ payload }) => {
      if (payload.name === 'first') {
        await gate.promise;
        throw staleError;
      }
      return payload.name;
    }
  });

  const first = harness.slot.render({ name: 'first' });
  const second = harness.slot.render({ name: 'second' });
  gate.resolve();

  assert.equal(await first, null);
  assert.ok(await second);
  assert.equal(harness.purgeCounts.get(1), 1);
  assert.equal(harness.removeCounts.get(1), 1);
});

test('rejects a current renderer failure and still retires exactly once', async () => {
  const renderError = new Error('current render failed');
  const harness = createHarness({
    render: async () => {
      throw renderError;
    }
  });

  await assert.rejects(harness.slot.render({ name: 'current' }), error => error === renderError);
  assert.equal(harness.purgeCounts.get(1), 1);
  assert.equal(harness.removeCounts.get(1), 1);
  assert.equal(harness.host.children.length, 0);
});

test('external ownership can make a successful render stale before commit', async () => {
  const gate = deferred();
  let current = true;
  const harness = createHarness({
    render: async () => {
      await gate.promise;
      return 'finished';
    }
  });

  const result = harness.slot.render(
    { name: 'external' },
    { isCurrent: () => current }
  );
  current = false;
  gate.resolve();

  assert.equal(await result, null);
  assert.equal(harness.purgeCounts.get(1), 1);
  assert.equal(harness.removeCounts.get(1), 1);
  await assert.rejects(
    harness.slot.withCommittedPlot(() => {}),
    /no committed plot/
  );
});

test('an ownership-predicate failure is cleaned and surfaced exactly once', async () => {
  const ownershipError = new Error('ownership failed');
  let ownershipChecks = 0;
  const harness = createHarness();
  const render = harness.slot.render(
    { name: 'ownership-error' },
    {
      isCurrent() {
        ownershipChecks += 1;
        if (ownershipChecks === 1) return true;
        throw ownershipError;
      }
    }
  );

  await assert.rejects(render, error => error === ownershipError);
  assert.equal(ownershipChecks, 2);
  assert.equal(harness.purgeCounts.get(1), 1);
  assert.equal(harness.removeCounts.get(1), 1);
});

test('surfaces cleanup failures even when the render failure is stale', async () => {
  const renderStarted = deferred();
  const renderGate = deferred();
  const renderError = new Error('stale render failure');
  const purgeError = new Error('purge failure');
  const removeError = new Error('remove failure');
  const harness = createHarness({
    render: async () => {
      renderStarted.resolve();
      await renderGate.promise;
      throw renderError;
    },
    purge: async () => {
      throw purgeError;
    },
    removeCandidate: async ({ candidate }) => {
      candidate.remove();
      throw removeError;
    }
  });

  let current = true;
  const result = harness.slot.render(
    { name: 'stale-cleanup' },
    { isCurrent: () => current }
  );
  await renderStarted.promise;
  current = false;
  renderGate.resolve();

  await assert.rejects(result, error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [purgeError, removeError]);
    assert.equal(error.errors.includes(renderError), false);
    return true;
  });
});

test('aggregates a current renderer failure with every cleanup failure', async () => {
  const renderError = new Error('render');
  const purgeError = new Error('purge');
  const removeError = new Error('remove');
  const harness = createHarness({
    render: async () => {
      throw renderError;
    },
    purge: async () => {
      throw purgeError;
    },
    removeCandidate: async ({ candidate }) => {
      candidate.remove();
      throw removeError;
    }
  });

  await assert.rejects(harness.slot.render({ name: 'current-cleanup' }), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0], renderError);
    assert.ok(error.errors[1] instanceof AggregateError);
    assert.deepEqual(error.errors[1].errors, [purgeError, removeError]);
    return true;
  });
});

test('retires each replaced and invalidated committed plot exactly once', async () => {
  const harness = createHarness();
  const first = await harness.slot.render({ name: 'first' });
  const second = await harness.slot.render({ name: 'second' });

  assert.equal(harness.purgeCounts.get(first.serial), 1);
  assert.equal(harness.removeCounts.get(first.serial), 1);
  assert.equal(harness.purgeCounts.get(second.serial), undefined);

  await harness.slot.invalidate();
  await harness.slot.invalidate();

  assert.equal(harness.purgeCounts.get(second.serial), 1);
  assert.equal(harness.removeCounts.get(second.serial), 1);
});

test('a replacement stays coherently committed while failed prior retirement remains retryably owned', async () => {
  const purgeAttempts = new Map();
  const removeAttempts = new Map();
  let firstCandidate = null;
  const harness = createHarness({
    purge: async ({ candidate }) => {
      const attempts = (purgeAttempts.get(candidate) ?? 0) + 1;
      purgeAttempts.set(candidate, attempts);
      if (candidate === firstCandidate && attempts === 1) {
        throw new Error('transient prior purge failure');
      }
    },
    removeCandidate: async ({ candidate }) => {
      const attempts = (removeAttempts.get(candidate) ?? 0) + 1;
      removeAttempts.set(candidate, attempts);
      if (candidate === firstCandidate && attempts === 1) {
        throw new Error('transient prior removal failure');
      }
      candidate.remove();
    }
  });

  firstCandidate = await harness.slot.render({ name: 'first' });
  const replacement = await harness.slot.render({ name: 'replacement' });

  assert.equal(
    await harness.slot.withCommittedPlot(candidate => candidate),
    replacement,
  );
  assert.equal(replacement.style.visibility, '');
  assert.equal(firstCandidate.isConnected, true);
  assert.equal(firstCandidate.style.visibility, 'hidden');

  await harness.slot.destroy();

  assert.equal(purgeAttempts.get(firstCandidate), 2);
  assert.equal(removeAttempts.get(firstCandidate), 2);
  assert.equal(firstCandidate.isConnected, false);
  assert.equal(replacement.isConnected, false);
  assert.equal(harness.host.children.length, 0);
});

test('invalidate retires the commit but never tears down a running candidate', async () => {
  const runningGate = deferred();
  const runningStarted = deferred();
  let runningCandidate = null;
  const harness = createHarness({
    render: async ({ candidate, payload }) => {
      if (payload.name === 'running') {
        runningCandidate = candidate;
        runningStarted.resolve();
        await runningGate.promise;
      }
      return payload.name;
    }
  });
  const committed = await harness.slot.render({ name: 'committed' });
  const running = harness.slot.render({ name: 'running' });
  await runningStarted.promise;

  await harness.slot.invalidate();

  assert.equal(harness.purgeCounts.get(committed.serial), 1);
  assert.equal(harness.removeCounts.get(committed.serial), 1);
  assert.equal(runningCandidate.isConnected, true);
  assert.equal(harness.purgeCounts.get(runningCandidate.serial), undefined);

  runningGate.resolve();
  assert.equal(await running, null);
  assert.equal(harness.purgeCounts.get(runningCandidate.serial), 1);
  assert.equal(harness.removeCounts.get(runningCandidate.serial), 1);
});

test('serializes committed-plot leases and prevents retirement during export', async () => {
  const firstLeaseGate = deferred();
  const secondLeaseGate = deferred();
  const secondRenderGate = deferred();
  const order = [];
  const harness = createHarness({
    render: async ({ payload }) => {
      if (payload.name === 'second') await secondRenderGate.promise;
      return { name: payload.name };
    },
    purge: async ({ candidate }) => {
      order.push(`purge:${candidate.serial}`);
      harness.purgeCounts.set(
        candidate.serial,
        (harness.purgeCounts.get(candidate.serial) ?? 0) + 1
      );
    }
  });
  const first = await harness.slot.render({ name: 'first' });

  const leaseOne = harness.slot.withCommittedPlot(async (candidate, renderResult) => {
    order.push('lease-1:start');
    assert.equal(candidate, first);
    assert.deepEqual(renderResult, { name: 'first' });
    await firstLeaseGate.promise;
    order.push('lease-1:end');
  });
  const leaseTwo = harness.slot.withCommittedPlot(async candidate => {
    order.push('lease-2:start');
    assert.equal(candidate, first);
    await secondLeaseGate.promise;
    order.push('lease-2:end');
  });
  const second = harness.slot.render({ name: 'second' });
  secondRenderGate.resolve();

  await Promise.resolve();
  assert.deepEqual(order, ['lease-1:start']);
  assert.equal(harness.purgeCounts.get(first.serial), undefined);

  firstLeaseGate.resolve();
  await leaseOne;
  await Promise.resolve();
  assert.deepEqual(order, ['lease-1:start', 'lease-1:end', 'lease-2:start']);
  assert.equal(harness.purgeCounts.get(first.serial), undefined);

  secondLeaseGate.resolve();
  await leaseTwo;
  const secondCandidate = await second;
  assert.deepEqual(order, [
    'lease-1:start',
    'lease-1:end',
    'lease-2:start',
    'lease-2:end',
    `purge:${first.serial}`
  ]);

  const leased = await harness.slot.withCommittedPlot(candidate => candidate);
  assert.equal(leased, secondCandidate);
});

test('a failed committed-plot lease does not poison later leases', async () => {
  const harness = createHarness();
  const candidate = await harness.slot.render({ name: 'committed' });
  const exportError = new Error('export failed');

  await assert.rejects(
    harness.slot.withCommittedPlot(() => {
      throw exportError;
    }),
    error => error === exportError
  );
  assert.equal(
    await harness.slot.withCommittedPlot(current => current),
    candidate
  );
});

test('destroy waits for an active committed-plot lease without tail deadlock', { timeout: 1000 }, async () => {
  const leaseGate = deferred();
  const leaseStarted = deferred();
  const harness = createHarness();
  const candidate = await harness.slot.render({ name: 'leased' });

  const lease = harness.slot.withCommittedPlot(async leasedCandidate => {
    assert.equal(leasedCandidate, candidate);
    leaseStarted.resolve();
    await leaseGate.promise;
  });
  await leaseStarted.promise;

  const destroy = harness.slot.destroy();
  let destroySettled = false;
  destroy.finally(() => {
    destroySettled = true;
  });
  await Promise.resolve();
  assert.equal(destroySettled, false);
  assert.equal(harness.purgeCounts.get(candidate.serial), undefined);

  leaseGate.resolve();
  await lease;
  await destroy;
  assert.equal(destroySettled, true);
  assert.equal(harness.purgeCounts.get(candidate.serial), 1);
  assert.equal(harness.removeCounts.get(candidate.serial), 1);
});

test('destroy invalidates pending work and waits to retire a running candidate', async () => {
  const runningGate = deferred();
  const runningStarted = deferred();
  let runningCandidate = null;
  const harness = createHarness({
    render: async ({ candidate, payload }) => {
      if (payload.name === 'running') {
        runningCandidate = candidate;
        runningStarted.resolve();
        await runningGate.promise;
      }
      return payload.name;
    }
  });

  const running = harness.slot.render({ name: 'running' });
  await runningStarted.promise;
  const pending = harness.slot.render({ name: 'pending' });
  const destroyed = harness.slot.destroy();
  let destroySettled = false;
  destroyed.then(() => {
    destroySettled = true;
  });

  assert.equal(await pending, null);
  await Promise.resolve();
  assert.equal(destroySettled, false);
  assert.equal(runningCandidate.isConnected, true);
  assert.equal(harness.purgeCounts.get(runningCandidate.serial), undefined);

  runningGate.resolve();
  assert.equal(await running, null);
  await destroyed;

  assert.equal(destroySettled, true);
  assert.equal(harness.purgeCounts.get(runningCandidate.serial), 1);
  assert.equal(harness.removeCounts.get(runningCandidate.serial), 1);
  await harness.slot.destroy();
  await assert.rejects(harness.slot.render({ name: 'late' }), /destroyed/);
  await assert.rejects(harness.slot.withCommittedPlot(() => {}), /destroyed/);
});
