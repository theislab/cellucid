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
      'Viewer host hover intent must be null or one exact per-view cell record.'
    );
  }
  return Object.freeze({
    viewId: intent.viewId,
    cellIndex: intent.cellIndex,
    position: requireFinitePosition(
      intent.position,
      'Viewer host hover intent position'
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
      'Viewer host click intent must contain an exact cell, button, shift, and ctrl state.'
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
 * Serialize viewer host pointer delivery without allowing network completion order
 * to rewrite pointer order. Hover keeps only the latest pending intent while
 * one send is active; clicks retain every intent in FIFO order.
 */
export function createViewerHostPointerDelivery({
  notifyHover,
  notifyClick,
  reportError,
}) {
  const sendHover = requireFunction(
    notifyHover,
    'Viewer host hover notifier'
  );
  const sendClick = requireFunction(
    notifyClick,
    'Viewer host click notifier'
  );
  const publishError = requireFunction(
    reportError,
    'Viewer host pointer error reporter'
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
            '[Main] Viewer host pointer error reporter failed:',
            reportingError
          );
        });
      }
    } catch (reportingError) {
      // A diagnostic observer cannot turn a caught listener failure into an
      // unhandled rejection.
      console.error(
        '[Main] Viewer host pointer error reporter failed:',
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
