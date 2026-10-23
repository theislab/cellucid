/**
 * @fileoverview Packed per-item texture helpers.
 *
 * These helpers upload 1D per-cell arrays into 2D textures, avoiding GPU buffer
 * readbacks and avoiding padded CPU copies for large datasets by streaming
 * row-by-row with `texSubImage2D`.
 *
 * A texture whose storage already has the packed shape is rewritten in place:
 * rows written into storage WebGL has accepted allocate nothing, so only a lost
 * context can refuse them and no error is read back (`requireLiveContext`).
 * `getError()` is a synchronous round trip to the GPU process that waits for
 * every queued command, the previous frames' draws included: a velocity
 * overlay rebuilding the tables of seven restored views spent 112 ms there.
 * Only a new allocation reads the error queue, once, so a refused allocation is
 * deleted instead of published: at once (`allocationCheck: 'now'`), or by the
 * caller before it publishes (`'caller'`), which lets it read once for several
 * textures, a task later, when the GPU process has caught up.
 *
 * @module rendering/overlays/shared/packed-texture
 */

import { requireCleanWebGLState, requireLiveContext } from '../../gl-errors.js';
import { deleteTextureTracked, restorableTexture } from '../../gl-utils.js';

/**
 * Compute width/height for a packed 2D texture.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {number} itemCount
 */
function computePackedDims(gl, itemCount) {
  if (!Number.isSafeInteger(itemCount) || itemCount < 0) {
    throw new RangeError(
      'Packed texture itemCount must be a non-negative safe integer.'
    );
  }
  const maxTexSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  if (!Number.isSafeInteger(maxTexSize) || maxTexSize <= 0) {
    throw new Error('WebGL MAX_TEXTURE_SIZE must be a positive safe integer.');
  }
  const packedCount = itemCount === 0 ? 1 : itemCount;
  const width = Math.min(packedCount, maxTexSize);
  const height = Math.ceil(packedCount / width);
  if (height > maxTexSize) {
    throw new Error(`Packed texture dims ${width}x${height} exceed MAX_TEXTURE_SIZE=${maxTexSize}`);
  }
  return { width, height, maxTexSize };
}

/**
 * Whether `existing` (a packed texture record or null) has exactly the shape
 * `itemCount` items of `components` values pack into: a write of that many
 * items then goes in place.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {{texture: WebGLTexture, width: number, height: number, components: number}|null} existing
 * @param {number} itemCount
 * @param {number} components
 * @returns {boolean}
 */
export function packedTextureFits(gl, existing, itemCount, components) {
  const { width, height } = computePackedDims(gl, itemCount);
  return fitsExisting(existing, width, height, components, 'Packed texture');
}

/**
 * Whether `existing` -- a texture this module returned, still owned by the
 * caller -- has exactly this shape. Ownership is the caller's record, not a
 * `gl.isTexture` query: that is a synchronous GPU round trip as well.
 *
 * @returns {boolean}
 */
function fitsExisting(existing, width, height, components, label) {
  if (existing === null) return false;
  if (
    typeof existing !== 'object' ||
    existing.texture === null ||
    typeof existing.texture !== 'object'
  ) {
    throw new TypeError(`${label} existing texture must be a packed texture record or null.`);
  }
  return existing.width === width &&
    existing.height === height &&
    existing.components === components;
}

/**
 * Write `itemCount` items, `components` values each, row by row from the top
 * of the bound texture.
 */
function writeRows(gl, width, itemCount, components, format, type, data) {
  let remaining = itemCount;
  let srcOffset = 0;
  for (let y = 0; remaining > 0; y++) {
    const rowItems = Math.min(width, remaining);
    const rowLen = rowItems * components;
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      y,
      rowItems,
      1,
      format,
      type,
      data.subarray(srcOffset, srcOffset + rowLen)
    );
    remaining -= rowItems;
    srcOffset += rowLen;
  }
}

/**
 * Write the packed items into `existing` when it has the shape, else into a new
 * texture. The caller owns both: a new texture is returned for it to publish
 * and `existing` is left for it to retire.
 *
 * @returns {{ texture: WebGLTexture, width: number, height: number, components: number }}
 */
function uploadPacked(gl, existing, spec) {
  const {
    label,
    width,
    height,
    components,
    internalFormat,
    format,
    type,
    data,
    itemCount,
    allocationCheck
  } = spec;
  if (allocationCheck !== 'now' && allocationCheck !== 'caller') {
    throw new TypeError(`${label} allocationCheck must be exactly 'now' or 'caller'.`);
  }
  const inPlace = fitsExisting(existing, width, height, components, label);
  if (!inPlace) requireLiveContext(gl, `${label} preflight`);
  const previousBinding = gl.getParameter(gl.TEXTURE_BINDING_2D);
  const previousAlignment = gl.getParameter(gl.UNPACK_ALIGNMENT);
  const previousPixelUnpackBuffer =
    gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING);
  const target = inPlace ? existing.texture : gl.createTexture();
  if (target === null) {
    throw new Error(`WebGL failed to allocate ${label}.`);
  }
  try {
    gl.bindTexture(gl.TEXTURE_2D, target);
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (!inPlace) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      // Allocate storage, then stream rows to avoid padded CPU copies.
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        internalFormat,
        width,
        height,
        0,
        format,
        type,
        null
      );
    }
    writeRows(gl, width, itemCount, components, format, type, data);
    if (inPlace || allocationCheck === 'caller') {
      requireLiveContext(gl, `${label} upload`);
    } else {
      // The one read: a refused allocation must not stay resident.
      requireCleanWebGLState(gl, `${label} allocation`);
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, previousAlignment);
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, previousPixelUnpackBuffer);
    gl.bindTexture(gl.TEXTURE_2D, restorableTexture(previousBinding));
  } catch (error) {
    const cleanupErrors = [];
    const cleanups = [
      () => gl.pixelStorei(gl.UNPACK_ALIGNMENT, previousAlignment),
      () => gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, previousPixelUnpackBuffer),
      () => gl.bindTexture(gl.TEXTURE_2D, restorableTexture(previousBinding)),
    ];
    if (!inPlace) cleanups.push(() => deleteTextureTracked(gl, target));
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        `${label} upload failed and cleanup was incomplete.`
      );
    }
    throw error;
  }
  return inPlace ? existing : { texture: target, width, height, components };
}

function requireExactOptions(options, keys, label) {
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.getPrototypeOf(options) !== Object.prototype ||
    Object.keys(options).sort().join(',') !== keys
  ) {
    throw new TypeError(
      `${label} options must contain exactly ${keys.split(',').join(', ')}.`
    );
  }
}

function requireItemCount(count, label) {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError(
      `${label} itemCount must be a non-negative safe integer.`
    );
  }
}

/**
 * Write a packed float texture: into `texture` when it has the shape, else into
 * a new one (the caller retires `texture`).
 *
 * @param {WebGL2RenderingContext} gl
 * @param {object} options
 * @param {{texture: WebGLTexture, width: number, height: number, components: number}|null} options.texture
 *   The texture this one replaces, or null.
 * @param {Float32Array} options.data
 * @param {number} options.itemCount
 * @param {1|2|3|4} options.components
 * @param {'now'|'caller'} options.allocationCheck - Who reads the error queue
 *   after a new allocation (an in-place write reads none).
 * @returns {{ texture: WebGLTexture, width: number, height: number, components: number }}
 */
export function createOrUpdatePackedFloatTexture(gl, options) {
  requireExactOptions(
    options,
    'allocationCheck,components,data,itemCount,texture',
    'Packed float texture'
  );
  const {
    texture: existing,
    data,
    itemCount: count,
    components: comps,
    allocationCheck
  } = options;
  if (![1, 2, 3, 4].includes(comps)) {
    throw new RangeError('Packed float texture components must be exactly 1, 2, 3, or 4.');
  }
  requireItemCount(count, 'Packed float texture');
  if (!(data instanceof Float32Array)) {
    throw new TypeError('Packed float texture data must be a Float32Array.');
  }
  if (data.length !== count * comps) {
    throw new RangeError(
      `Packed float texture data must contain exactly ${count * comps} values; received ${data.length}.`
    );
  }

  const { width, height } = computePackedDims(gl, count);
  return uploadPacked(gl, existing, {
    label: 'packed float texture',
    width,
    height,
    components: comps,
    internalFormat:
      comps === 1 ? gl.R32F :
      comps === 2 ? gl.RG32F :
      comps === 3 ? gl.RGB32F :
      gl.RGBA32F,
    format:
      comps === 1 ? gl.RED :
      comps === 2 ? gl.RG :
      comps === 3 ? gl.RGB :
      gl.RGBA,
    type: gl.FLOAT,
    data,
    itemCount: count,
    allocationCheck
  });
}

/**
 * Write the packed per-cell visibility texture (R8UI) from point transparency:
 * one byte a cell, exactly 0 or 1 (rendering/alpha-visibility.js), uploaded as
 * it is held; the shader reads it through a `usampler2D`. Into `texture` when
 * it has the shape, else into a new one (the caller retires `texture`).
 *
 * @param {WebGL2RenderingContext} gl
 * @param {object} options
 * @param {{texture: WebGLTexture, width: number, height: number, components: number}|null} options.texture
 * @param {Uint8Array} options.data
 * @param {number} options.itemCount
 * @param {'now'|'caller'} options.allocationCheck
 * @returns {{ texture: WebGLTexture, width: number, height: number, components: number }}
 */
export function createOrUpdatePackedVisibilityTexture(gl, options) {
  requireExactOptions(
    options,
    'allocationCheck,data,itemCount,texture',
    'Packed visibility texture'
  );
  const { texture: existing, data, itemCount: count, allocationCheck } = options;
  requireItemCount(count, 'Packed visibility texture');
  if (!(data instanceof Uint8Array)) {
    throw new TypeError('Packed visibility texture data must be a Uint8Array.');
  }
  if (data.length !== count) {
    throw new RangeError(
      `Packed visibility texture data must contain exactly ${count} values; received ${data.length}.`
    );
  }

  const { width, height } = computePackedDims(gl, count);
  // One unsigned byte a cell, as the visibility is held (0 or 1): no float
  // conversion, a quarter of a float texture's bytes.
  return uploadPacked(gl, existing, {
    label: 'packed visibility texture',
    width,
    height,
    components: 1,
    internalFormat: gl.R8UI,
    format: gl.RED_INTEGER,
    type: gl.UNSIGNED_BYTE,
    data,
    itemCount: count,
    allocationCheck
  });
}

/**
 * Write a packed unsigned-int texture (R32UI) shaped for `capacity` items and
 * holding the first `itemCount` of them: a table that refills with fewer items
 * keeps its storage. Into `texture` when it has the shape, else into a new one
 * (the caller retires `texture`).
 *
 * @param {WebGL2RenderingContext} gl
 * @param {object} options
 * @param {{texture: WebGLTexture, width: number, height: number, components: number}|null} options.texture
 * @param {Uint32Array} options.data
 * @param {number} options.itemCount
 * @param {number} options.capacity - Items the shape holds; at least `itemCount`.
 * @param {'now'|'caller'} options.allocationCheck
 * @returns {{ texture: WebGLTexture, width: number, height: number, components: number }}
 */
export function createOrUpdatePackedUintTexture(gl, options) {
  requireExactOptions(
    options,
    'allocationCheck,capacity,data,itemCount,texture',
    'Packed uint texture'
  );
  const {
    texture: existing,
    data,
    itemCount: count,
    capacity,
    allocationCheck
  } = options;
  requireItemCount(count, 'Packed uint texture');
  if (!Number.isSafeInteger(capacity) || capacity < count) {
    throw new RangeError(
      `Packed uint texture capacity must be a safe integer of at least ${count}.`
    );
  }
  if (!(data instanceof Uint32Array)) {
    throw new TypeError('Packed uint texture data must be a Uint32Array.');
  }
  if (data.length !== count) {
    throw new RangeError(
      `Packed uint texture data must contain exactly ${count} values; received ${data.length}.`
    );
  }

  const { width, height } = computePackedDims(gl, capacity);
  return uploadPacked(gl, existing, {
    label: 'packed uint texture',
    width,
    height,
    components: 1,
    internalFormat: gl.R32UI,
    format: gl.RED_INTEGER,
    type: gl.UNSIGNED_INT,
    data,
    itemCount: count,
    allocationCheck
  });
}
