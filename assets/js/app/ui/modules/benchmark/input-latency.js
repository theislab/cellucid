/**
 * @fileoverview Input-to-first-drawn-frame latency, per input type.
 *
 * Every pointer, wheel and key event is time-stamped by the browser on the
 * same clock as `performance.now()`. The tracker keeps the inputs that have
 * not been answered by a frame yet; the first frame the viewer draws after
 * them answers all of them, and its time minus each input's `timeStamp` is
 * that input's latency. An input followed by another input of the same type
 * before any frame is drawn is counted as unanswered, not as slow: pointer
 * moves arrive faster than frames, and only the frames tell what the user saw.
 *
 * The same counts measure the opposite defect. A gesture whose moves change
 * nothing on screen should draw nothing; `drawnFrames / inputs` near one for
 * such a gesture is a redraw per move.
 *
 * @module app/ui/modules/benchmark/input-latency
 */

import { percentileOfSorted } from './frame-recorder.js';

/** Event types tracked, listened for in the capture phase on the window. */
export const TRACKED_INPUT_TYPES = Object.freeze([
  'pointerdown',
  'pointermove',
  'pointerup',
  'wheel',
  'keydown'
]);

function createTypeRecord() {
  return { inputs: 0, answered: 0, unanswered: 0, latencies: [] };
}

function summarizeType(record) {
  const sorted = record.latencies.slice().sort((a, b) => a - b);
  return {
    inputs: record.inputs,
    answered: record.answered,
    unanswered: record.unanswered,
    p50Ms: sorted.length > 0 ? percentileOfSorted(sorted, sorted.length, 0.5) : null,
    p95Ms: sorted.length > 0 ? percentileOfSorted(sorted, sorted.length, 0.95) : null,
    maxMs: sorted.length > 0 ? sorted[sorted.length - 1] : null
  };
}

/**
 * Create a tracker fed by a frame-cause sampler.
 *
 * @param {Object} options
 * @param {Object} options.sampler - From `createFrameCauseSampler`, started.
 * @param {EventTarget} [options.target] - Where inputs are observed (window).
 * @returns {Object} Tracker handle.
 */
export function createInputLatencyTracker(options = {}) {
  const sampler = options.sampler;
  if (sampler === null || typeof sampler?.subscribe !== 'function') {
    throw new TypeError('The input-latency tracker requires a frame-cause sampler.');
  }
  const target = options.target ?? globalThis;

  const windows = new Set();
  /** Pending inputs: type → timeStamp of the latest unanswered one. */
  const pending = new Map();
  let unsubscribe = null;

  function recordFor(windowRecord, type) {
    let record = windowRecord.types.get(type);
    if (record === undefined) {
      record = createTypeRecord();
      windowRecord.types.set(type, record);
    }
    return record;
  }

  function onInput(event) {
    const type = event.type;
    if (pending.has(type)) {
      for (const windowRecord of windows) recordFor(windowRecord, type).unanswered++;
    }
    pending.set(type, event.timeStamp);
    for (const windowRecord of windows) recordFor(windowRecord, type).inputs++;
  }

  function onTick(event) {
    if (!event.drawn || pending.size === 0) return;
    for (const [type, timeStamp] of pending) {
      const latency = event.at - timeStamp;
      for (const windowRecord of windows) {
        const record = recordFor(windowRecord, type);
        record.answered++;
        if (record.latencies.length < 10_000) record.latencies.push(latency);
      }
    }
    pending.clear();
  }

  return Object.freeze({
    /** Start listening. Idempotent. */
    start() {
      if (unsubscribe !== null) return;
      for (const type of TRACKED_INPUT_TYPES) {
        target.addEventListener(type, onInput, { capture: true, passive: true });
      }
      unsubscribe = sampler.subscribe(onTick);
    },

    /** Stop listening. Idempotent. */
    stop() {
      if (unsubscribe === null) return;
      for (const type of TRACKED_INPUT_TYPES) {
        target.removeEventListener(type, onInput, { capture: true });
      }
      unsubscribe();
      unsubscribe = null;
      pending.clear();
      windows.clear();
    },

    /** Open a window. */
    openWindow() {
      const windowRecord = { types: new Map() };
      windows.add(windowRecord);
      return windowRecord;
    },

    /**
     * Close a window. Inputs still waiting for a frame count as unanswered.
     *
     * @param {Object} windowRecord
     * @returns {Object} Per-type latency summaries.
     */
    closeWindow(windowRecord) {
      if (!windows.delete(windowRecord)) {
        throw new Error('The input-latency window is not open.');
      }
      for (const type of pending.keys()) recordFor(windowRecord, type).unanswered++;
      const types = {};
      for (const [type, record] of windowRecord.types) types[type] = summarizeType(record);
      return types;
    }
  });
}
