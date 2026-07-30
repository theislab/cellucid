function requireFunction(value, label) {
  if (typeof value !== 'function') {
    throw new TypeError(`${label} must be one function.`);
  }
  return value;
}

function requireFinitePosition(position, label) {
  if (
    position === null ||
    typeof position !== 'object' ||
    Array.isArray(position) ||
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y) ||
    !Number.isFinite(position.z)
  ) {
    throw new TypeError(`${label} must contain finite x, y, and z values.`);
  }
  return Object.freeze({
    x: position.x,
    y: position.y,
    z: position.z,
  });
}

function captureHoverIntent(intent) {
  if (intent === null) return null;
  if (
    typeof intent !== 'object' ||
    Array.isArray(intent) ||
    typeof intent.viewId !== 'string' ||
    intent.viewId.length === 0 ||
    !Number.isSafeInteger(intent.cellIndex) ||
    intent.cellIndex < 0
  ) {
    throw new TypeError(
      'Jupyter hover intent must be null or one exact per-view cell record.'
    );
  }
  return Object.freeze({
    viewId: intent.viewId,
    cellIndex: intent.cellIndex,
    position: requireFinitePosition(
      intent.position,
      'Jupyter hover intent position'
    ),
  });
}

function captureClickIntent(intent) {
  if (
    intent === null ||
    typeof intent !== 'object' ||
    Array.isArray(intent) ||
    !Number.isSafeInteger(intent.cellIndex) ||
    intent.cellIndex < 0 ||
    !Number.isSafeInteger(intent.button) ||
    intent.button < 0 ||
    intent.button > 2 ||
    typeof intent.shift !== 'boolean' ||
    typeof intent.ctrl !== 'boolean'
  ) {
    throw new TypeError(
      'Jupyter click intent must contain an exact cell, button, shift, and ctrl state.'
    );
  }
  return Object.freeze({
    cellIndex: intent.cellIndex,
    button: intent.button,
    shift: intent.shift,
    ctrl: intent.ctrl,
  });
}

function hoverIntentsEqual(left, right) {
  if (left === null || right === null) return left === right;
  return (
    left.viewId === right.viewId &&
    left.cellIndex === right.cellIndex &&
    left.position.x === right.position.x &&
    left.position.y === right.position.y &&
    left.position.z === right.position.z
  );
}

/**
 * Own one non-overlapping Jupyter health-probe lifecycle. A new timeout is
 * armed only after the prior probe succeeds; freeze invalidates every late
 * settlement and a terminal failure is published at most once.
 */
export function createJupyterHealthMonitor({
  checkHealth,
  onFailure,
  intervalMs = 3000,
  scheduleTimeout = globalThis.setTimeout,
  cancelTimeout = globalThis.clearTimeout,
}) {
  const probeHealth = requireFunction(
    checkHealth,
    'Jupyter health probe'
  );
  const publishFailure = requireFunction(
    onFailure,
    'Jupyter health failure handler'
  );
  const scheduleProbeTimeout = requireFunction(
    scheduleTimeout,
    'Jupyter health timeout scheduler'
  );
  const cancelProbeTimeout = requireFunction(
    cancelTimeout,
    'Jupyter health timeout canceller'
  );
  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new RangeError(
      'Jupyter health interval must be a finite non-negative number.'
    );
  }

  let started = false;
  let frozen = false;
  let lifecycleGeneration = 0;
  let timer = null;
  let probeInFlight = false;

  const clearScheduledProbe = () => {
    if (timer !== null) {
      cancelProbeTimeout(timer);
      timer = null;
    }
  };

  const freeze = () => {
    if (frozen) return false;
    frozen = true;
    lifecycleGeneration += 1;
    clearScheduledProbe();
    return true;
  };

  const schedule = generation => {
    if (
      frozen ||
      generation !== lifecycleGeneration ||
      timer !== null ||
      probeInFlight
    ) {
      return;
    }
    timer = scheduleProbeTimeout(() => {
      timer = null;
      void runProbe(generation);
    }, intervalMs);
  };

  async function runProbe(generation) {
    if (
      frozen ||
      generation !== lifecycleGeneration ||
      probeInFlight
    ) {
      return;
    }
    probeInFlight = true;
    let failure = null;
    try {
      await probeHealth();
    } catch (error) {
      failure = error;
    } finally {
      probeInFlight = false;
    }

    if (frozen || generation !== lifecycleGeneration) return;
    if (failure === null) {
      schedule(generation);
      return;
    }

    // Fence before external notification so reentrancy cannot schedule or
    // publish another terminal result.
    freeze();
    try {
      await publishFailure(failure);
    } catch (reportingError) {
      console.error(
        '[Main] Jupyter health failure handler failed:',
        reportingError
      );
    }
  }

  return Object.freeze({
    start() {
      if (started || frozen) return false;
      started = true;
      schedule(lifecycleGeneration);
      return true;
    },
    freeze,
    isFrozen() {
      return frozen;
    },
    isProbeInFlight() {
      return probeInFlight;
    },
  });
}

/**
 * Serialize Jupyter pointer delivery without allowing network completion order
 * to rewrite pointer order. Hover keeps only the latest pending intent while
 * one send is active; clicks retain every intent in FIFO order.
 */
export function createJupyterPointerDelivery({
  notifyHover,
  notifyClick,
  reportError,
}) {
  const sendHover = requireFunction(
    notifyHover,
    'Jupyter hover notifier'
  );
  const sendClick = requireFunction(
    notifyClick,
    'Jupyter click notifier'
  );
  const publishError = requireFunction(
    reportError,
    'Jupyter pointer error reporter'
  );

  const NO_HOVER_INTENT = Symbol('no-hover-intent');
  let frozen = false;
  let lifecycleGeneration = 0;
  let deliveredHover = null;
  let pendingHover = NO_HOVER_INTENT;
  let inFlightHover = NO_HOVER_INTENT;
  let hoverDraining = false;
  const clickQueue = [];
  let clickDraining = false;
  const idleWaiters = new Set();

  const report = (error, channel) => {
    try {
      const outcome = publishError(error, channel);
      if (
        outcome !== null &&
        typeof outcome === 'object' &&
        typeof outcome.then === 'function'
      ) {
        void Promise.resolve(outcome).catch(reportingError => {
          console.error(
            '[Main] Jupyter pointer error reporter failed:',
            reportingError
          );
        });
      }
    } catch (reportingError) {
      // A diagnostic observer cannot turn a caught listener failure into an
      // unhandled rejection.
      console.error(
        '[Main] Jupyter pointer error reporter failed:',
        reportingError
      );
    }
  };

  const settleIdleWaiters = () => {
    if (
      hoverDraining ||
      clickDraining ||
      pendingHover !== NO_HOVER_INTENT ||
      clickQueue.length > 0
    ) {
      return;
    }
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };

  const drainHover = async generation => {
    try {
      while (
        !frozen &&
        generation === lifecycleGeneration &&
        pendingHover !== NO_HOVER_INTENT
      ) {
        const intent = pendingHover;
        pendingHover = NO_HOVER_INTENT;
        if (hoverIntentsEqual(intent, deliveredHover)) continue;
        inFlightHover = intent;
        try {
          if (intent === null) {
            await sendHover(null, null);
          } else {
            await sendHover(intent.cellIndex, intent.position);
          }
        } catch (error) {
          if (!frozen && generation === lifecycleGeneration) {
            report(error, 'hover');
          }
          continue;
        } finally {
          inFlightHover = NO_HOVER_INTENT;
        }
        if (frozen || generation !== lifecycleGeneration) return;
        // Commit the deduplication cache only after confirmed delivery. A
        // failed send therefore remains retryable with the same intent.
        deliveredHover = intent;
      }
    } catch (error) {
      report(error, 'hover');
    } finally {
      hoverDraining = false;
      if (
        !frozen &&
        generation === lifecycleGeneration &&
        pendingHover !== NO_HOVER_INTENT
      ) {
        startHoverDrain();
      }
      settleIdleWaiters();
    }
  };

  function startHoverDrain() {
    if (
      frozen ||
      hoverDraining ||
      pendingHover === NO_HOVER_INTENT
    ) {
      return;
    }
    hoverDraining = true;
    void drainHover(lifecycleGeneration);
  }

  const drainClicks = async generation => {
    try {
      while (
        !frozen &&
        generation === lifecycleGeneration &&
        clickQueue.length > 0
      ) {
        const intent = clickQueue.shift();
        try {
          await sendClick(intent.cellIndex, {
            button: intent.button,
            shift: intent.shift,
            ctrl: intent.ctrl,
          });
        } catch (error) {
          if (!frozen && generation === lifecycleGeneration) {
            report(error, 'click');
          }
        }
      }
    } catch (error) {
      report(error, 'click');
    } finally {
      clickDraining = false;
      if (
        !frozen &&
        generation === lifecycleGeneration &&
        clickQueue.length > 0
      ) {
        startClickDrain();
      }
      settleIdleWaiters();
    }
  };

  function startClickDrain() {
    if (frozen || clickDraining || clickQueue.length === 0) return;
    clickDraining = true;
    void drainClicks(lifecycleGeneration);
  }

  return Object.freeze({
    requestHover(intent) {
      if (frozen) return false;
      const captured = captureHoverIntent(intent);
      if (
        pendingHover !== NO_HOVER_INTENT &&
        hoverIntentsEqual(pendingHover, captured)
      ) {
        return false;
      }
      if (
        pendingHover === NO_HOVER_INTENT &&
        inFlightHover === NO_HOVER_INTENT &&
        hoverIntentsEqual(deliveredHover, captured)
      ) {
        return false;
      }
      pendingHover = captured;
      startHoverDrain();
      return true;
    },

    requestClick(intent) {
      if (frozen) return false;
      clickQueue.push(captureClickIntent(intent));
      startClickDrain();
      return true;
    },

    freeze() {
      if (frozen) return false;
      frozen = true;
      lifecycleGeneration += 1;
      pendingHover = NO_HOVER_INTENT;
      clickQueue.length = 0;
      settleIdleWaiters();
      return true;
    },

    isFrozen() {
      return frozen;
    },

    async whenIdle() {
      while (
        hoverDraining ||
        clickDraining ||
        pendingHover !== NO_HOVER_INTENT ||
        clickQueue.length > 0
      ) {
        await new Promise(resolve => {
          idleWaiters.add(resolve);
        });
      }
    },
  });
}
