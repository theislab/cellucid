/**
 * Plotly-specific owner built on top of PlotRenderSlot.
 *
 * The generic slot owns candidate commit/retirement and export leases. This
 * adapter adds exact Plotly cleanup plus one coalesced responsive-resize owner
 * for the committed child.
 */

import { loadPlotly, purgePlot } from '../plots/plotly-loader.js';
import { PlotRenderSlot, readHostLayoutBox } from './plot-render-slot.js';

function combineErrors(errors, message) {
  const present = [...new Set(errors.filter(Boolean))];
  if (present.length === 0) return null;
  if (present.length === 1) return present[0];
  return new AggregateError(present, message);
}

function requireError(error, context) {
  if (error instanceof Error) return error;
  return new TypeError(`${context} rejected with a non-Error value`);
}

/**
 * The host's layout box - the same box `PlotRenderSlot` renders candidates
 * into, so a commit and a later resize can never disagree about the size.
 */
function requirePositiveMeasurement(host) {
  try {
    return readHostLayoutBox(host);
  } catch (error) {
    throw new TypeError(
      `Plotly render slot host must be measurable: ${error.message}`,
      { cause: error }
    );
  }
}

function sameMeasurement(left, right) {
  return (
    left !== null &&
    right !== null &&
    left.width === right.width &&
    left.height === right.height
  );
}

/**
 * Transactional owner for one stable Plotly host.
 */
export class PlotlyRenderSlot {
  constructor({
    host,
    candidateClassName,
    onResizeError = null
  } = {}) {
    if (!host || typeof host !== 'object') {
      throw new TypeError('PlotlyRenderSlot requires a host element');
    }
    if (
      typeof candidateClassName !== 'string' ||
      candidateClassName.length === 0 ||
      candidateClassName.trim() !== candidateClassName
    ) {
      throw new TypeError(
        'PlotlyRenderSlot candidateClassName must be exact non-empty text'
      );
    }
    if (onResizeError !== null && typeof onResizeError !== 'function') {
      throw new TypeError('PlotlyRenderSlot onResizeError must be a function');
    }
    if (typeof globalThis.ResizeObserver !== 'function') {
      throw new TypeError('PlotlyRenderSlot requires ResizeObserver');
    }
    if (
      typeof globalThis.requestAnimationFrame !== 'function' ||
      typeof globalThis.cancelAnimationFrame !== 'function'
    ) {
      throw new TypeError(
        'PlotlyRenderSlot requires animation-frame scheduling'
      );
    }

    this._host = host;
    this._candidateClassName = candidateClassName;
    this._onResizeError = onResizeError;
    this._committedCandidate = null;
    this._committedMeasurement = null;
    this._resizeFrame = null;
    this._resizeLease = null;
    this._resizeAgain = false;
    this._resizeFailures = [];
    this._candidateRetirements = new WeakMap();
    this._destroyed = false;
    this._destroyPromise = null;

    if (host.style && !host.style.position) {
      host.style.position = 'relative';
    }

    this._slot = new PlotRenderSlot({
      host,
      createCandidate: ({ host: candidateHost }) => {
        const ownerDocument = candidateHost.ownerDocument;
        if (
          !ownerDocument ||
          typeof ownerDocument.createElement !== 'function'
        ) {
          throw new TypeError(
            'PlotlyRenderSlot host must provide an owner document'
          );
        }
        const candidate = ownerDocument.createElement('div');
        candidate.className = this._candidateClassName;
        candidate.style.position = 'absolute';
        candidate.style.inset = '0';
        candidate.style.boxSizing = 'border-box';
        this._candidateRetirements.set(candidate, {
          cleanup: null,
          cleanupDone: false,
          purgeDone: false
        });
        return candidate;
      },
      render: async ({ candidate, payload, measurement }) => {
        if (
          payload === null ||
          typeof payload !== 'object' ||
          typeof payload.render !== 'function'
        ) {
          throw new TypeError(
            'PlotlyRenderSlot payload must provide render(candidate, measurement)'
          );
        }
        const value = await payload.render(candidate, measurement);
        let cleanup = null;
        if (payload.onRendered !== undefined) {
          if (typeof payload.onRendered !== 'function') {
            throw new TypeError(
              'PlotlyRenderSlot onRendered must be a function'
            );
          }
          cleanup = await payload.onRendered(candidate, value);
          if (cleanup !== null && cleanup !== undefined &&
              typeof cleanup !== 'function') {
            throw new TypeError(
              'PlotlyRenderSlot onRendered must return a cleanup function'
            );
          }
        }
        const retirement = this._candidateRetirements.get(candidate);
        if (retirement) retirement.cleanup = cleanup ?? null;
        candidate.style.width = '100%';
        candidate.style.height = '100%';
        return {
          cleanup: cleanup ?? null,
          measurement: {
            width: Number(measurement.width),
            height: Number(measurement.height)
          },
          payload,
          value
        };
      },
      purge: async ({ candidate, renderResult }) => {
        const errors = [];
        const retirement = this._candidateRetirements.get(candidate) ?? {
          cleanup: renderResult?.cleanup ?? null,
          cleanupDone: false,
          purgeDone: false
        };
        this._candidateRetirements.set(candidate, retirement);
        if (!retirement.cleanupDone &&
            typeof retirement.cleanup === 'function') {
          try {
            await retirement.cleanup();
            retirement.cleanupDone = true;
          } catch (error) {
            errors.push(requireError(error, 'Plot candidate cleanup'));
          }
        } else if (typeof retirement.cleanup !== 'function') {
          retirement.cleanupDone = true;
        }
        if (!retirement.purgeDone) {
          try {
            await purgePlot(candidate);
            retirement.purgeDone = true;
          } catch (error) {
            errors.push(requireError(error, 'Plot candidate purge'));
          }
        }
        const failure = combineErrors(
          errors,
          'Plot candidate cleanup failed'
        );
        if (failure) throw failure;
      }
    });

    this._resizeObserver = new globalThis.ResizeObserver(() => {
      this._scheduleResize();
    });
    if (
      typeof this._resizeObserver.observe !== 'function' ||
      typeof this._resizeObserver.disconnect !== 'function'
    ) {
      throw new TypeError(
        'PlotlyRenderSlot ResizeObserver must expose observe and disconnect'
      );
    }
    this._resizeObserver.observe(host);
  }

  render(payload, options = {}) {
    if (this._destroyed) {
      return Promise.reject(new Error('PlotlyRenderSlot has been destroyed'));
    }
    const rendering = this._slot.render(payload, options);
    return rendering.then(candidate => {
      if (candidate !== null) {
        this._committedCandidate = candidate;
        this._committedMeasurement = requirePositiveMeasurement(this._host);
        this._scheduleResize();
      }
      return candidate;
    });
  }

  invalidate() {
    if (this._destroyed) {
      return this._destroyPromise ?? Promise.resolve();
    }
    this._committedCandidate = null;
    this._committedMeasurement = null;
    this._cancelScheduledResize();
    return this._slot.invalidate();
  }

  withCommittedPlot(operation) {
    return this._slot.withCommittedPlot(operation);
  }

  hasCommittedPlot() {
    return this._committedCandidate !== null;
  }

  waitForCommittedLeases() {
    if (!this.hasCommittedPlot()) return Promise.resolve();
    return this._slot.withCommittedPlot(() => {});
  }

  destroy() {
    if (this._destroyPromise !== null) return this._destroyPromise;
    this._destroyed = true;
    this._committedCandidate = null;
    this._committedMeasurement = null;
    const resizeLease = this._resizeLease;
    const errors = [];
    try {
      this._resizeObserver.disconnect();
    } catch (error) {
      errors.push(requireError(error, 'Plot resize observer cleanup'));
    }
    try {
      this._cancelScheduledResize();
    } catch (error) {
      errors.push(requireError(error, 'Plot resize frame cleanup'));
    }

    this._destroyPromise = (async () => {
      if (resizeLease !== null) {
        try {
          await resizeLease;
        } catch (error) {
          errors.push(requireError(error, 'Plot resize lease cleanup'));
        }
      }
      try {
        await this._slot.destroy();
      } catch (error) {
        errors.push(requireError(error, 'Plot slot cleanup'));
      }
      errors.push(...this._resizeFailures);
      const failure = combineErrors(
        errors,
        'PlotlyRenderSlot destruction failed'
      );
      if (failure) throw failure;
    })();
    return this._destroyPromise;
  }

  _cancelScheduledResize() {
    if (this._resizeFrame === null) return;
    globalThis.cancelAnimationFrame(this._resizeFrame);
    this._resizeFrame = null;
  }

  _scheduleResize() {
    if (this._destroyed || this._committedCandidate === null) return;
    if (this._resizeFrame !== null || this._resizeLease !== null) {
      this._resizeAgain = true;
      return;
    }
    this._resizeFrame = globalThis.requestAnimationFrame(() => {
      this._resizeFrame = null;
      if (this._destroyed || this._committedCandidate === null) return;
      const expectedCandidate = this._committedCandidate;
      const lease = this._slot.withCommittedPlot(async candidate => {
        if (
          this._destroyed ||
          candidate !== expectedCandidate ||
          candidate !== this._committedCandidate
        ) {
          return;
        }
        const measurement = requirePositiveMeasurement(this._host);
        if (measurement.width === 0 || measurement.height === 0) return;
        if (sameMeasurement(measurement, this._committedMeasurement)) {
          candidate.style.width = '100%';
          candidate.style.height = '100%';
          return;
        }
        candidate.style.width = `${measurement.width}px`;
        candidate.style.height = `${measurement.height}px`;
        const Plotly = await loadPlotly();
        if (typeof Plotly?.Plots?.resize !== 'function') {
          throw new TypeError(
            'Responsive plot rendering requires Plotly.Plots.resize'
          );
        }
        await Plotly.Plots.resize(candidate);
        candidate.style.width = '100%';
        candidate.style.height = '100%';
        this._committedMeasurement = measurement;
      });
      this._resizeLease = lease;
      void lease.catch(error => {
        const exactError = requireError(error, 'Responsive plot resize');
        this._resizeFailures.push(exactError);
        if (this._onResizeError !== null) {
          try {
            this._onResizeError(exactError);
          } catch (reportError) {
            this._resizeFailures.push(
              new AggregateError(
                [
                  exactError,
                  requireError(reportError, 'Responsive resize error report')
                ],
                'Responsive resize and error reporting both failed'
              )
            );
          }
        }
      });
      lease.then(
        () => this._finishResizeLease(lease),
        () => this._finishResizeLease(lease)
      );
    });
  }

  _finishResizeLease(lease) {
    if (this._resizeLease === lease) this._resizeLease = null;
    if (this._resizeAgain) {
      this._resizeAgain = false;
      this._scheduleResize();
    }
  }
}

export default PlotlyRenderSlot;
