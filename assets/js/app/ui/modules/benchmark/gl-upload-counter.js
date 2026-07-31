/**
 * @fileoverview Per-frame GPU upload and synchronous-stall counters.
 *
 * The renderer publishes one per-frame counter, `drawCalls`. It publishes
 * nothing about how much data crosses the bus, which is why the standing
 * suspicion about a full element-buffer reallocation on every frame of camera
 * motion can be neither confirmed nor refuted from the existing harness.
 *
 * This module counts uploads without editing the renderer. A WebGL context is
 * an ordinary object whose methods live on `WebGL2RenderingContext.prototype`;
 * defining an own property of the same name on the live context shadows the
 * prototype method for every subsequent call, including calls made by code
 * that captured the context long ago. The renderer keeps calling
 * `gl.bufferData(...)` exactly as before and resolves to the counting wrapper.
 *
 * What is counted, and why each one matters:
 *
 * - `bufferData` reallocates the whole buffer store. A per-frame `bufferData`
 *   at index-buffer size is the specific defect this counter exists to price,
 *   so store reallocations are counted separately from bytes copied, and
 *   element-array-buffer traffic is separated from vertex traffic.
 * - `bufferSubData` copies into an existing store. Same bytes, no realloc.
 * - `texImage2D` / `texSubImage2D` carry the overlay and alpha-texture traffic.
 * - `getError`, `finish`, `flush`, `readPixels` and `getBufferSubData` are the
 *   synchronous points. On Chrome/ANGLE `getError` drains the command buffer
 *   to the GPU process; two of them per view per frame is a pipeline stall
 *   twice a frame, and until now nothing counted them.
 *
 * The wrappers are fixed-arity and dispatch on `arguments.length`, so a
 * counted call allocates nothing and the measurement window stays clean.
 *
 * @module app/ui/modules/benchmark/gl-upload-counter
 */

/** Names shadowed on the live context while instrumentation is installed. */
export const INSTRUMENTED_METHOD_NAMES = Object.freeze([
  'bufferData',
  'bufferSubData',
  'texImage2D',
  'texSubImage2D',
  'drawArrays',
  'drawElements',
  'drawArraysInstanced',
  'drawElementsInstanced',
  'getError',
  'finish',
  'flush',
  'readPixels',
  'getBufferSubData'
]);

const COUNTER_FIELDS = Object.freeze([
  'bufferStoreAllocations',
  'bufferStoreAllocationBytes',
  'elementBufferStoreAllocations',
  'elementBufferStoreAllocationBytes',
  'bufferSubUpdates',
  'bufferSubUpdateBytes',
  'elementBufferSubUpdates',
  'elementBufferSubUpdateBytes',
  'textureUploads',
  'textureUploadBytes',
  'textureUploadsWithUnmeasuredBytes',
  'drawCalls',
  'syncStalls',
  'getErrorCalls',
  'finishCalls',
  'flushCalls',
  'readPixelsCalls',
  'getBufferSubDataCalls'
]);

/** Bytes per texel for the format/type pairs this renderer actually uploads. */
const TEXEL_BYTES = new Map([
  ['RED|UNSIGNED_BYTE', 1],
  ['RED_INTEGER|UNSIGNED_BYTE', 1],
  ['RED|FLOAT', 4],
  ['RED_INTEGER|UNSIGNED_INT', 4],
  ['RG|UNSIGNED_BYTE', 2],
  ['RG|FLOAT', 8],
  ['RGB|UNSIGNED_BYTE', 3],
  ['RGB|FLOAT', 12],
  ['RGBA|UNSIGNED_BYTE', 4],
  ['RGBA_INTEGER|UNSIGNED_INT', 16],
  ['RGBA|FLOAT', 16],
  ['RGBA|HALF_FLOAT', 8]
]);

function requireContext(gl) {
  if (
    gl === null ||
    typeof gl !== 'object' ||
    typeof gl.bufferData !== 'function' ||
    typeof gl.getError !== 'function'
  ) {
    throw new TypeError(
      'GL upload instrumentation requires one WebGL rendering context.'
    );
  }
  return gl;
}

function createZeroedCounters() {
  const counters = {};
  for (const field of COUNTER_FIELDS) counters[field] = 0;
  return counters;
}

function zeroCounters(counters) {
  for (const field of COUNTER_FIELDS) counters[field] = 0;
}

function addCounters(destination, source) {
  for (const field of COUNTER_FIELDS) destination[field] += source[field];
}

/**
 * Bytes a buffer source contributes, honouring the WebGL2 element-range form.
 *
 * @param {*} source - `ArrayBuffer`, `ArrayBufferView`, or a byte count.
 * @param {number} argumentCount - Total arguments the call supplied.
 * @param {number} rangeArityStart - Arity at which `srcOffset` first appears.
 * @param {*} srcOffset - Element offset, when supplied.
 * @param {*} length - Element length, when supplied.
 * @returns {number} Bytes copied from the CPU.
 */
function bufferSourceBytes(
  source,
  argumentCount,
  rangeArityStart,
  srcOffset,
  length
) {
  if (source === null || source === undefined) return 0;
  if (typeof source === 'number') return 0;
  const bytesPerElement =
    typeof source.BYTES_PER_ELEMENT === 'number' ? source.BYTES_PER_ELEMENT : 1;
  if (argumentCount >= rangeArityStart + 1 && typeof length === 'number') {
    return length * bytesPerElement;
  }
  if (argumentCount >= rangeArityStart && typeof srcOffset === 'number') {
    const elements =
      typeof source.length === 'number'
        ? source.length - srcOffset
        : (source.byteLength ?? 0) / bytesPerElement - srcOffset;
    return Math.max(0, elements) * bytesPerElement;
  }
  return typeof source.byteLength === 'number' ? source.byteLength : 0;
}

function enumName(gl, value, names) {
  for (const name of names) {
    if (gl[name] === value) return name;
  }
  return null;
}

/**
 * Bytes a tightly packed 2-D texture upload transfers, when the call form
 * carries an explicit width, height, format and type. Other forms are counted
 * as uploads with unmeasured byte volume rather than guessed at.
 *
 * @param {WebGLRenderingContext} gl - Context supplying the enum values.
 * @param {number|undefined} width - Texel width.
 * @param {number|undefined} height - Texel height.
 * @param {number|undefined} format - Format enum.
 * @param {number|undefined} type - Type enum.
 * @returns {number|null} Byte count, or null when it cannot be determined.
 */
function textureUploadBytes(gl, width, height, format, type) {
  if (typeof width !== 'number' || typeof height !== 'number') return null;
  const formatName = enumName(gl, format, [
    'RED',
    'RED_INTEGER',
    'RG',
    'RGB',
    'RGBA',
    'RGBA_INTEGER'
  ]);
  const typeName = enumName(gl, type, [
    'UNSIGNED_BYTE',
    'UNSIGNED_INT',
    'FLOAT',
    'HALF_FLOAT'
  ]);
  if (formatName === null || typeName === null) return null;
  const texelBytes = TEXEL_BYTES.get(`${formatName}|${typeName}`);
  if (texelBytes === undefined) return null;
  return width * height * texelBytes;
}

/**
 * Install upload counters on a live WebGL context.
 *
 * @param {WebGL2RenderingContext} gl - Context handed to the renderer.
 * @returns {Object} Instrumentation handle.
 */
export function instrumentGlUploads(gl) {
  requireContext(gl);

  const previousDescriptors = new Map();
  for (const name of INSTRUMENTED_METHOD_NAMES) {
    previousDescriptors.set(
      name,
      Object.getOwnPropertyDescriptor(gl, name) ?? null
    );
  }

  const frame = createZeroedCounters();
  const total = createZeroedCounters();
  const elementArrayBuffer = gl.ELEMENT_ARRAY_BUFFER;

  const originals = {};
  for (const name of INSTRUMENTED_METHOD_NAMES) {
    const method = gl[name];
    if (typeof method !== 'function') {
      throw new TypeError(
        `GL upload instrumentation requires context method ${name}().`
      );
    }
    originals[name] = method;
  }

  const wrappers = {
    bufferData(target, source, usage, srcOffset, length) {
      const argumentCount = arguments.length;
      const bytes = bufferSourceBytes(
        source,
        argumentCount,
        4,
        srcOffset,
        length
      );
      const storeBytes = typeof source === 'number' ? source : bytes;
      if (target === elementArrayBuffer) {
        frame.elementBufferStoreAllocations++;
        frame.elementBufferStoreAllocationBytes += storeBytes;
      }
      frame.bufferStoreAllocations++;
      frame.bufferStoreAllocationBytes += storeBytes;
      if (argumentCount === 3) {
        return originals.bufferData.call(gl, target, source, usage);
      }
      if (argumentCount === 4) {
        return originals.bufferData.call(gl, target, source, usage, srcOffset);
      }
      if (argumentCount === 5) {
        return originals.bufferData.call(
          gl,
          target,
          source,
          usage,
          srcOffset,
          length
        );
      }
      return originals.bufferData.apply(gl, arguments);
    },

    bufferSubData(target, dstByteOffset, source, srcOffset, length) {
      const argumentCount = arguments.length;
      const bytes = bufferSourceBytes(
        source,
        argumentCount,
        4,
        srcOffset,
        length
      );
      if (target === elementArrayBuffer) {
        frame.elementBufferSubUpdates++;
        frame.elementBufferSubUpdateBytes += bytes;
      }
      frame.bufferSubUpdates++;
      frame.bufferSubUpdateBytes += bytes;
      if (argumentCount === 3) {
        return originals.bufferSubData.call(gl, target, dstByteOffset, source);
      }
      if (argumentCount === 4) {
        return originals.bufferSubData.call(
          gl,
          target,
          dstByteOffset,
          source,
          srcOffset
        );
      }
      if (argumentCount === 5) {
        return originals.bufferSubData.call(
          gl,
          target,
          dstByteOffset,
          source,
          srcOffset,
          length
        );
      }
      return originals.bufferSubData.apply(gl, arguments);
    },

    texImage2D(a0, a1, a2, a3, a4, a5, a6, a7, a8, a9) {
      const argumentCount = arguments.length;
      frame.textureUploads++;
      // (target, level, internalformat, width, height, border, format, type, …)
      const bytes =
        argumentCount >= 8
          ? textureUploadBytes(gl, a3, a4, a6, a7)
          : null;
      if (bytes === null) {
        frame.textureUploadsWithUnmeasuredBytes++;
      } else {
        frame.textureUploadBytes += bytes;
      }
      switch (argumentCount) {
        case 6:
          return originals.texImage2D.call(gl, a0, a1, a2, a3, a4, a5);
        case 9:
          return originals.texImage2D.call(
            gl, a0, a1, a2, a3, a4, a5, a6, a7, a8
          );
        case 10:
          return originals.texImage2D.call(
            gl, a0, a1, a2, a3, a4, a5, a6, a7, a8, a9
          );
        default:
          // An arity WebGL2 does not define today. Forward it verbatim rather
          // than inventing arguments; the allocation is off the counted path.
          return originals.texImage2D.apply(gl, arguments);
      }
    },

    texSubImage2D(a0, a1, a2, a3, a4, a5, a6, a7, a8, a9) {
      const argumentCount = arguments.length;
      frame.textureUploads++;
      // (target, level, xoffset, yoffset, width, height, format, type, …)
      const bytes =
        argumentCount >= 8
          ? textureUploadBytes(gl, a4, a5, a6, a7)
          : null;
      if (bytes === null) {
        frame.textureUploadsWithUnmeasuredBytes++;
      } else {
        frame.textureUploadBytes += bytes;
      }
      switch (argumentCount) {
        case 7:
          return originals.texSubImage2D.call(gl, a0, a1, a2, a3, a4, a5, a6);
        case 9:
          return originals.texSubImage2D.call(
            gl, a0, a1, a2, a3, a4, a5, a6, a7, a8
          );
        case 10:
          return originals.texSubImage2D.call(
            gl, a0, a1, a2, a3, a4, a5, a6, a7, a8, a9
          );
        default:
          return originals.texSubImage2D.apply(gl, arguments);
      }
    },

    drawArrays(mode, first, count) {
      frame.drawCalls++;
      return originals.drawArrays.call(gl, mode, first, count);
    },

    drawElements(mode, count, type, offset) {
      frame.drawCalls++;
      return originals.drawElements.call(gl, mode, count, type, offset);
    },

    drawArraysInstanced(mode, first, count, instanceCount) {
      frame.drawCalls++;
      return originals.drawArraysInstanced.call(
        gl,
        mode,
        first,
        count,
        instanceCount
      );
    },

    drawElementsInstanced(mode, count, type, offset, instanceCount) {
      frame.drawCalls++;
      return originals.drawElementsInstanced.call(
        gl,
        mode,
        count,
        type,
        offset,
        instanceCount
      );
    },

    getError() {
      frame.syncStalls++;
      frame.getErrorCalls++;
      return originals.getError.call(gl);
    },

    finish() {
      frame.syncStalls++;
      frame.finishCalls++;
      return originals.finish.call(gl);
    },

    flush() {
      frame.syncStalls++;
      frame.flushCalls++;
      return originals.flush.call(gl);
    },

    readPixels(a0, a1, a2, a3, a4, a5, a6, a7) {
      const argumentCount = arguments.length;
      frame.syncStalls++;
      frame.readPixelsCalls++;
      if (argumentCount === 7) {
        return originals.readPixels.call(gl, a0, a1, a2, a3, a4, a5, a6);
      }
      if (argumentCount === 8) {
        return originals.readPixels.call(gl, a0, a1, a2, a3, a4, a5, a6, a7);
      }
      return originals.readPixels.apply(gl, arguments);
    },

    getBufferSubData(a0, a1, a2, a3, a4) {
      const argumentCount = arguments.length;
      frame.syncStalls++;
      frame.getBufferSubDataCalls++;
      if (argumentCount === 3) {
        return originals.getBufferSubData.call(gl, a0, a1, a2);
      }
      if (argumentCount === 4) {
        return originals.getBufferSubData.call(gl, a0, a1, a2, a3);
      }
      if (argumentCount === 5) {
        return originals.getBufferSubData.call(gl, a0, a1, a2, a3, a4);
      }
      return originals.getBufferSubData.apply(gl, arguments);
    }
  };

  for (const name of INSTRUMENTED_METHOD_NAMES) {
    Object.defineProperty(gl, name, {
      value: wrappers[name],
      writable: true,
      configurable: true,
      enumerable: false
    });
  }

  let installed = true;

  return {
    /** Live per-frame counters. Read fields directly; never re-created. */
    frame,
    /** Live cumulative counters across every closed frame. */
    total,
    /** @returns {boolean} True while the wrappers are installed. */
    get installed() {
      return installed;
    },
    /**
     * Fold the current frame into the totals and zero the frame counters.
     * Allocation-free; call once per rendered frame after reading `frame`.
     */
    closeFrame() {
      addCounters(total, frame);
      zeroCounters(frame);
    },
    /** Zero both the frame and the cumulative counters. */
    reset() {
      zeroCounters(frame);
      zeroCounters(total);
    },
    /**
     * Remove the wrappers, restoring the context to its exact prior shape.
     * Idempotent.
     */
    restore() {
      if (!installed) return;
      for (const name of INSTRUMENTED_METHOD_NAMES) {
        const descriptor = previousDescriptors.get(name);
        if (descriptor === null) {
          delete gl[name];
        } else {
          Object.defineProperty(gl, name, descriptor);
        }
        if (gl[name] !== originals[name]) {
          throw new Error(
            `GL upload instrumentation could not restore context method ${name}().`
          );
        }
      }
      installed = false;
    }
  };
}

/**
 * Field names carried by both the frame and total counter records.
 *
 * @returns {readonly string[]} Counter field names.
 */
export function uploadCounterFields() {
  return COUNTER_FIELDS;
}
