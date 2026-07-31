// Deterministic rig for measuring what the smoke ray march reconstructs from a
// known density volume.
//
// The shipped SMOKE_VS_SOURCE / SMOKE_FS_SOURCE are compiled unmodified and
// driven with uniforms that neutralise everything except the base density:
// curl warping off, detail off, erosion off, a constant shape-noise volume so
// the shape modifier is exactly 1, and an all-zero blue-noise target so the
// march jitter is zero unless a test asks for it. What comes back is therefore
// the density field the shader believes the volume holds, sampled on a
// near-orthographic grid of rays down -Z.

import {
  SMOKE_FS_SOURCE,
  SMOKE_VS_SOURCE,
} from '/assets/js/rendering/shaders/smoke-shaders.js';

// The splat writes a point at p in [-1,1] to index (p + 1) / 2 * (gridSize - 1),
// so index i is the density of world position -1 + 2 * i / (gridSize - 1) and
// one index step is this far apart in world units.
export function indexToWorld(index, gridSize) {
  return -1 + (2 * index) / (gridSize - 1);
}

export function indexStepWorld(gridSize) {
  return 2 / (gridSize - 1);
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Smoke volume probe shader allocation failed');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Smoke volume probe shader compilation failed: ${log}`);
  }
  return shader;
}

function link(gl, vertexSource, fragmentSource) {
  const vertexShader = compile(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) throw new Error('Smoke volume probe program allocation failed');
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Smoke volume probe program linking failed: ${log}`);
  }
  return program;
}

function constantVolume(gl, size, fill) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D, texture);
  gl.texImage3D(
    gl.TEXTURE_3D,
    0,
    gl.RGBA,
    size,
    size,
    size,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array(size * size * size * 4).fill(fill)
  );
  gl.generateMipmap(gl.TEXTURE_3D);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.REPEAT);
  return texture;
}

function blueNoise(gl, jitter) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  const data = new Uint8Array(128 * 128 * 2);
  if (jitter) {
    let state = 22695477;
    for (let index = 0; index < data.length; index++) {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      data[index] = (state >> 16) & 255;
    }
  }
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, 128, 128, 0, gl.RG, gl.UNSIGNED_BYTE, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  return texture;
}

// Inverse of a perspective view-projection for an eye at (0, 0, distance)
// looking down -Z with a half-height of `half` at the origin. A large distance
// makes the rays parallel to well under a hundredth of a texel across the
// volume, so a pixel column is one world-space X.
function inverseViewProjection(distance, half) {
  const near = distance - 4;
  const far = distance + 4;
  const focal = distance / half;
  const a = (far + near) / (near - far);
  const b = (2 * far * near) / (near - far);
  const inverseProjection = [
    1 / focal, 0, 0, 0,
    0, 1 / focal, 0, 0,
    0, 0, 0, 1 / b,
    0, 0, -1, a / b,
  ];
  const inverseView = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, distance, 1];
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += inverseView[k * 4 + row] * inverseProjection[column * 4 + k];
      }
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

/**
 * Marches `densityTexture` with the shipped smoke shader and returns the
 * premultiplied RGBA8 readback plus the pixel-to-world mapping used.
 */
export function marchVolume(gl, {
  densityTexture,
  gridSize,
  size = 256,
  half = 1.2,
  distance = 2000,
  jitter = false,
  densityMultiplier = 0.03,
  stepMultiplier = 1.0,
}) {
  const shape = constantVolume(gl, 8, 255);
  const detail = constantVolume(gl, 8, 128);
  const noise = blueNoise(gl, jitter);

  const program = link(gl, SMOKE_VS_SOURCE, SMOKE_FS_SOURCE);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const vertexArray = gl.createVertexArray();
  gl.bindVertexArray(vertexArray);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  const positionLocation = gl.getAttribLocation(program, 'a_position');
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

  const target = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, target);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    target,
    0
  );
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error('Smoke volume probe framebuffer is incomplete');
  }

  gl.viewport(0, 0, size, size);
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.DITHER);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(program);
  gl.bindVertexArray(vertexArray);

  const uniform = name => gl.getUniformLocation(program, name);
  gl.uniformMatrix4fv(uniform('u_invViewProj'), false, inverseViewProjection(distance, half));
  gl.uniform3f(uniform('u_cameraPos'), 0, 0, distance);
  gl.uniform3f(uniform('u_volumeMin'), -1, -1, -1);
  gl.uniform3f(uniform('u_volumeMax'), 1, 1, 1);
  gl.uniform1f(uniform('u_gridSize'), gridSize);
  gl.uniform3f(uniform('u_smokeColor'), 1, 1, 1);
  gl.uniform3f(uniform('u_lightDir'), 0, 1, 0);
  gl.uniform1f(uniform('u_time'), 0);
  gl.uniform1f(uniform('u_animationSpeed'), 0);
  gl.uniform1f(uniform('u_densityMultiplier'), densityMultiplier);
  gl.uniform1f(uniform('u_stepMultiplier'), stepMultiplier);
  gl.uniform1f(uniform('u_noiseScale'), 1);
  gl.uniform1f(uniform('u_warpStrength'), 0);
  gl.uniform1f(uniform('u_detailLevel'), 0);
  gl.uniform1f(uniform('u_lightAbsorption'), 1);
  gl.uniform1f(uniform('u_scatterStrength'), 0);
  gl.uniform1f(uniform('u_edgeSoftness'), 0);
  gl.uniform1f(uniform('u_directLightIntensity'), 0.5);
  gl.uniform1i(uniform('u_lightSamples'), 1);
  gl.uniform2f(uniform('u_blueNoiseOffset'), 0, 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_3D, densityTexture);
  gl.uniform1i(uniform('u_densityTex3D'), 0);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_3D, shape);
  gl.uniform1i(uniform('u_shapeNoise'), 1);
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_3D, detail);
  gl.uniform1i(uniform('u_detailNoise'), 2);
  gl.activeTexture(gl.TEXTURE3);
  gl.bindTexture(gl.TEXTURE_2D, noise);
  gl.uniform1i(uniform('u_blueNoise'), 3);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  const pixels = new Uint8Array(size * size * 4);
  gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

  // Detach everything before deleting it. A deleted object that is still bound
  // stays live in this context, and the next caller that captures and restores
  // the binding gets an INVALID_OPERATION on a name it no longer owns.
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.useProgram(null);
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  for (const unit of [0, 1, 2, 3]) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindTexture(gl.TEXTURE_3D, null);
  }
  gl.activeTexture(gl.TEXTURE0);
  gl.deleteFramebuffer(framebuffer);
  gl.deleteTexture(target);
  gl.deleteTexture(shape);
  gl.deleteTexture(detail);
  gl.deleteTexture(noise);
  gl.deleteVertexArray(vertexArray);
  gl.deleteBuffer(buffer);
  gl.deleteProgram(program);
  let pending = gl.getError();
  while (pending !== gl.NO_ERROR) {
    throw new Error(`Smoke volume probe left WebGL error 0x${pending.toString(16)}`);
  }

  return {
    pixels,
    size,
    half,
    worldOf: index => (2 * (index + 0.5) / size - 1) * half,
    alphaAt: (x, y) => pixels[((y * size) + x) * 4 + 3],
  };
}

/**
 * Reduces a marched frame to the reconstructed line density along X.
 *
 * Alpha saturates; optical depth does not. -ln(1 - alpha) is proportional to
 * the density integrated along the ray, which for a column that is uniform in
 * Z is proportional to the reconstructed 2-D footprint.
 */
export function columnWeights(frame, rowCentreWorld) {
  const { pixels, size, half } = frame;
  const centreRow = Math.round(((rowCentreWorld / half + 1) / 2) * size - 0.5);
  const rowLow = Math.max(0, centreRow - 2);
  const rowHigh = Math.min(size - 1, centreRow + 2);
  const weights = new Float64Array(size);
  for (let x = 0; x < size; x++) {
    let sum = 0;
    for (let y = rowLow; y <= rowHigh; y++) {
      const alpha = pixels[((y * size) + x) * 4 + 3] / 255;
      sum += alpha >= 1 ? 8 : -Math.log(1 - alpha);
    }
    weights[x] = sum / (rowHigh - rowLow + 1);
  }
  return weights;
}

/** Weighted centroid, in world X, of everything above `floorFraction` of peak. */
export function weightedCentroid(frame, weights, floorFraction = 0.02) {
  let peak = 0;
  for (const value of weights) if (value > peak) peak = value;
  const floor = peak * floorFraction;
  let numerator = 0;
  let denominator = 0;
  for (let x = 0; x < weights.length; x++) {
    if (weights[x] <= floor) continue;
    numerator += frame.worldOf(x) * weights[x];
    denominator += weights[x];
  }
  return { centroid: denominator > 0 ? numerator / denominator : NaN, peak };
}

/** Builds one exact gridSize^3 volume from a per-voxel callback. */
export function voxelVolume(gridSize, valueAt) {
  const data = new Float32Array(gridSize * gridSize * gridSize);
  for (let z = 0; z < gridSize; z++) {
    for (let y = 0; y < gridSize; y++) {
      for (let x = 0; x < gridSize; x++) {
        data[(z * gridSize + y) * gridSize + x] = valueAt(x, y, z);
      }
    }
  }
  return {
    boundsMax: [1, 1, 1],
    boundsMin: [-1, -1, -1],
    data,
    gridSize,
  };
}
