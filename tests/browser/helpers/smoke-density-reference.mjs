const REFERENCE_SPLAT_VERTEX_SHADER = `#version 300 es
precision highp float;

// Per-vertex: point position
in vec3 a_position;

// Per-instance: corner offset (0-7 for 8 trilinear corners)
in float a_cornerIndex;

uniform float u_gridSize;
uniform float u_atlasWidth;  // gridSize * slicesPerRow
uniform float u_atlasHeight; // gridSize * numRows
uniform float u_slicesPerRow;

out float v_weight;

void main() {
  float gridSize = u_gridSize;
  float halfExtent = 1.0;

  // Map position from [-1,1] to [0, gridSize-1]
  vec3 fp = (a_position + halfExtent) / (2.0 * halfExtent) * (gridSize - 1.0);

  // Skip if outside bounds
  if (any(lessThan(a_position, vec3(-halfExtent))) || any(greaterThan(a_position, vec3(halfExtent)))) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0); // off-screen
    v_weight = 0.0;
    return;
  }

  // Base voxel indices
  ivec3 i0 = ivec3(floor(fp));
  i0 = clamp(i0, ivec3(0), ivec3(int(gridSize) - 1));

  // Fractional position within voxel
  vec3 t = fp - vec3(i0);

  // Determine which corner this instance represents (0-7)
  int corner = int(a_cornerIndex);
  int dx = corner & 1;
  int dy = (corner >> 1) & 1;
  int dz = (corner >> 2) & 1;

  // Target voxel
  ivec3 iv = i0 + ivec3(dx, dy, dz);
  iv = clamp(iv, ivec3(0), ivec3(int(gridSize) - 1));

  // Trilinear weight
  float wx = (dx == 0) ? (1.0 - t.x) : t.x;
  float wy = (dy == 0) ? (1.0 - t.y) : t.y;
  float wz = (dz == 0) ? (1.0 - t.z) : t.z;
  v_weight = wx * wy * wz;

  // Skip zero-weight contributions
  if (v_weight < 0.0001) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    return;
  }

  // Map 3D voxel to 2D atlas position
  // Atlas layout: Z slices arranged in a grid
  int sliceIdx = iv.z;
  int sliceRow = sliceIdx / int(u_slicesPerRow);
  int sliceCol = sliceIdx - sliceRow * int(u_slicesPerRow);

  // Pixel position in atlas
  float px = float(sliceCol) * gridSize + float(iv.x) + 0.5;
  float py = float(sliceRow) * gridSize + float(iv.y) + 0.5;

  // Convert to clip space [-1, 1]
  float clipX = (px / u_atlasWidth) * 2.0 - 1.0;
  float clipY = (py / u_atlasHeight) * 2.0 - 1.0;

  gl_Position = vec4(clipX, clipY, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`;

const REFERENCE_SPLAT_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in float v_weight;
out vec4 fragColor;

void main() {
  fragColor = vec4(v_weight, 0.0, 0.0, 1.0);
}
`;

const REFERENCE_NORMALIZE_VERTEX_SHADER = `#version 300 es
in vec2 a_position;
out vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const REFERENCE_NORMALIZE_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_atlas;
uniform float u_maxValue;
uniform float u_gamma;

in vec2 v_uv;
out vec4 fragColor;

void main() {
  float density = texture(u_atlas, v_uv).r;
  float normalized = density / max(u_maxValue, 0.0001);
  float result = pow(normalized, u_gamma);
  fragColor = vec4(result, 0.0, 0.0, 1.0);
}
`;

function createProgram(gl, vertexSource, fragmentSource, resources) {
  function compile(type, source) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('Prior smoke reference shader allocation failed');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`Prior smoke reference shader failed: ${log}`);
    }
    return shader;
  }

  let vertexShader = null;
  let fragmentShader = null;
  let program = null;
  try {
    vertexShader = compile(gl.VERTEX_SHADER, vertexSource);
    fragmentShader = compile(gl.FRAGMENT_SHADER, fragmentSource);
    program = gl.createProgram();
    if (!program) throw new Error('Prior smoke reference program allocation failed');
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(
        `Prior smoke reference program failed: ${gl.getProgramInfoLog(program)}`
      );
    }
    resources.programs.push(program);
    return program;
  } catch (error) {
    if (program !== null) gl.deleteProgram(program);
    throw error;
  } finally {
    if (vertexShader !== null) gl.deleteShader(vertexShader);
    if (fragmentShader !== null) gl.deleteShader(fragmentShader);
  }
}

function requireAttribute(gl, program, name) {
  const location = gl.getAttribLocation(program, name);
  if (!Number.isInteger(location) || location < 0) {
    throw new Error(`Prior smoke reference attribute ${name} is unavailable`);
  }
  return location;
}

function requireUniform(gl, program, name) {
  const location = gl.getUniformLocation(program, name);
  if (location === null) {
    throw new Error(`Prior smoke reference uniform ${name} is unavailable`);
  }
  return location;
}

function createTexture(gl, resources) {
  const texture = gl.createTexture();
  if (!texture) throw new Error('Prior smoke reference texture allocation failed');
  resources.textures.push(texture);
  return texture;
}

function createBuffer(gl, resources) {
  const buffer = gl.createBuffer();
  if (!buffer) throw new Error('Prior smoke reference buffer allocation failed');
  resources.buffers.push(buffer);
  return buffer;
}

function createVertexArray(gl, resources) {
  const vertexArray = gl.createVertexArray();
  if (!vertexArray) {
    throw new Error('Prior smoke reference vertex-array allocation failed');
  }
  resources.vertexArrays.push(vertexArray);
  return vertexArray;
}

function captureState(gl) {
  const activeTexture = gl.getParameter(gl.ACTIVE_TEXTURE);
  gl.activeTexture(gl.TEXTURE0);
  const texture2D = gl.getParameter(gl.TEXTURE_BINDING_2D);
  gl.activeTexture(activeTexture);
  return {
    activeTexture,
    arrayBuffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING),
    blend: gl.isEnabled(gl.BLEND),
    blendDstAlpha: gl.getParameter(gl.BLEND_DST_ALPHA),
    blendDstRgb: gl.getParameter(gl.BLEND_DST_RGB),
    blendEquationAlpha: gl.getParameter(gl.BLEND_EQUATION_ALPHA),
    blendEquationRgb: gl.getParameter(gl.BLEND_EQUATION_RGB),
    blendSrcAlpha: gl.getParameter(gl.BLEND_SRC_ALPHA),
    blendSrcRgb: gl.getParameter(gl.BLEND_SRC_RGB),
    clearColor: Array.from(gl.getParameter(gl.COLOR_CLEAR_VALUE)),
    colorMask: Array.from(gl.getParameter(gl.COLOR_WRITEMASK)),
    drawFramebuffer: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),
    program: gl.getParameter(gl.CURRENT_PROGRAM),
    readFramebuffer: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
    texture2D,
    vertexArray: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
    viewport: Array.from(gl.getParameter(gl.VIEWPORT)),
  };
}

function restoreState(gl, state) {
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, state.drawFramebuffer);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, state.readFramebuffer);
  gl.viewport(...state.viewport);
  gl.clearColor(...state.clearColor);
  gl.colorMask(...state.colorMask);
  gl.blendEquationSeparate(
    state.blendEquationRgb,
    state.blendEquationAlpha
  );
  gl.blendFuncSeparate(
    state.blendSrcRgb,
    state.blendDstRgb,
    state.blendSrcAlpha,
    state.blendDstAlpha
  );
  if (state.blend) gl.enable(gl.BLEND);
  else gl.disable(gl.BLEND);
  gl.useProgram(state.program);
  gl.bindVertexArray(state.vertexArray);
  gl.bindBuffer(gl.ARRAY_BUFFER, state.arrayBuffer);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, state.texture2D);
  gl.activeTexture(state.activeTexture);
}

function releaseResources(gl, resources) {
  for (const vertexArray of resources.vertexArrays) {
    gl.deleteVertexArray(vertexArray);
  }
  for (const buffer of resources.buffers) gl.deleteBuffer(buffer);
  for (const texture of resources.textures) gl.deleteTexture(texture);
  for (const framebuffer of resources.framebuffers) {
    gl.deleteFramebuffer(framebuffer);
  }
  for (const program of resources.programs) gl.deleteProgram(program);
}

/**
 * Test-only reference that preserves the historical smoke-density algorithm:
 * R32F splat -> readback/max in JavaScript -> R32F normalize -> readback.
 */
export function buildPriorSmokeDensityReference(
  gl,
  positions,
  { gamma, gridSize }
) {
  if (!(positions instanceof Float32Array) || positions.length % 3 !== 0) {
    throw new TypeError('Prior smoke reference requires float32 xyz positions');
  }
  if (!gl.getExtension('EXT_color_buffer_float')) {
    throw new Error('Prior smoke reference requires EXT_color_buffer_float');
  }
  if (!gl.getExtension('EXT_float_blend')) {
    throw new Error('Prior smoke reference requires EXT_float_blend');
  }
  const slicesPerRow = Math.ceil(Math.sqrt(gridSize));
  const rowCount = Math.ceil(gridSize / slicesPerRow);
  const atlasWidth = gridSize * slicesPerRow;
  const atlasHeight = gridSize * rowCount;
  const resources = {
    buffers: [],
    framebuffers: [],
    programs: [],
    textures: [],
    vertexArrays: [],
  };
  const state = captureState(gl);
  let voxels = null;
  let maximum = 0;
  let pipelineError = null;

  try {
    const splatProgram = createProgram(
      gl,
      REFERENCE_SPLAT_VERTEX_SHADER,
      REFERENCE_SPLAT_FRAGMENT_SHADER,
      resources
    );
    const normalizeProgram = createProgram(
      gl,
      REFERENCE_NORMALIZE_VERTEX_SHADER,
      REFERENCE_NORMALIZE_FRAGMENT_SHADER,
      resources
    );
    const splatLocations = {
      corner: requireAttribute(gl, splatProgram, 'a_cornerIndex'),
      position: requireAttribute(gl, splatProgram, 'a_position'),
      atlasHeight: requireUniform(gl, splatProgram, 'u_atlasHeight'),
      atlasWidth: requireUniform(gl, splatProgram, 'u_atlasWidth'),
      gridSize: requireUniform(gl, splatProgram, 'u_gridSize'),
      slicesPerRow: requireUniform(gl, splatProgram, 'u_slicesPerRow'),
    };
    const normalizeLocations = {
      position: requireAttribute(gl, normalizeProgram, 'a_position'),
      atlas: requireUniform(gl, normalizeProgram, 'u_atlas'),
      gamma: requireUniform(gl, normalizeProgram, 'u_gamma'),
      maximum: requireUniform(gl, normalizeProgram, 'u_maxValue'),
    };

    const cornerBuffer = createBuffer(gl, resources);
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 1, 2, 3, 4, 5, 6, 7]),
      gl.STATIC_DRAW
    );
    const quadBuffer = createBuffer(gl, resources);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW
    );
    const positionBuffer = createBuffer(gl, resources);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

    const accumulationTexture = createTexture(gl, resources);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, accumulationTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R32F,
      atlasWidth,
      atlasHeight,
      0,
      gl.RED,
      gl.FLOAT,
      null
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const framebuffer = gl.createFramebuffer();
    if (!framebuffer) {
      throw new Error('Prior smoke reference framebuffer allocation failed');
    }
    resources.framebuffers.push(framebuffer);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      accumulationTexture,
      0
    );
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('Prior smoke reference accumulation framebuffer failed');
    }
    gl.viewport(0, 0, atlasWidth, atlasHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.colorMask(true, true, true, true);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const splatVertexArray = createVertexArray(gl, resources);
    gl.bindVertexArray(splatVertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.enableVertexAttribArray(splatLocations.position);
    gl.vertexAttribPointer(
      splatLocations.position,
      3,
      gl.FLOAT,
      false,
      0,
      0
    );
    gl.vertexAttribDivisor(splatLocations.position, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
    gl.enableVertexAttribArray(splatLocations.corner);
    gl.vertexAttribPointer(
      splatLocations.corner,
      1,
      gl.FLOAT,
      false,
      0,
      0
    );
    gl.vertexAttribDivisor(splatLocations.corner, 0);
    gl.useProgram(splatProgram);
    gl.uniform1f(splatLocations.gridSize, gridSize);
    gl.uniform1f(splatLocations.atlasWidth, atlasWidth);
    gl.uniform1f(splatLocations.atlasHeight, atlasHeight);
    gl.uniform1f(splatLocations.slicesPerRow, slicesPerRow);
    gl.enable(gl.BLEND);
    gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
    gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE);
    gl.drawArraysInstanced(
      gl.POINTS,
      0,
      8,
      positions.length / 3
    );

    const accumulation = new Float32Array(atlasWidth * atlasHeight);
    gl.readPixels(
      0,
      0,
      atlasWidth,
      atlasHeight,
      gl.RED,
      gl.FLOAT,
      accumulation
    );
    for (const value of accumulation) maximum = Math.max(maximum, value);
    if (!(maximum > 0)) {
      throw new Error('Prior smoke reference produced an empty volume');
    }

    const normalizedTexture = createTexture(gl, resources);
    gl.bindTexture(gl.TEXTURE_2D, normalizedTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R32F,
      atlasWidth,
      atlasHeight,
      0,
      gl.RED,
      gl.FLOAT,
      null
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      normalizedTexture,
      0
    );
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('Prior smoke reference normalization framebuffer failed');
    }
    gl.viewport(0, 0, atlasWidth, atlasHeight);
    gl.useProgram(normalizeProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, accumulationTexture);
    gl.uniform1i(normalizeLocations.atlas, 0);
    gl.uniform1f(normalizeLocations.maximum, maximum);
    gl.uniform1f(normalizeLocations.gamma, gamma);
    gl.disable(gl.BLEND);
    const normalizeVertexArray = createVertexArray(gl, resources);
    gl.bindVertexArray(normalizeVertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.enableVertexAttribArray(normalizeLocations.position);
    gl.vertexAttribPointer(
      normalizeLocations.position,
      2,
      gl.FLOAT,
      false,
      0,
      0
    );
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    const normalized = new Float32Array(atlasWidth * atlasHeight);
    gl.readPixels(
      0,
      0,
      atlasWidth,
      atlasHeight,
      gl.RED,
      gl.FLOAT,
      normalized
    );
    voxels = new Uint8Array(gridSize ** 3);
    for (let z = 0; z < gridSize; z++) {
      const sliceRow = Math.floor(z / slicesPerRow);
      const sliceColumn = z % slicesPerRow;
      for (let y = 0; y < gridSize; y++) {
        for (let x = 0; x < gridSize; x++) {
          const atlasIndex = (
            (sliceRow * gridSize + y) * atlasWidth
            + sliceColumn * gridSize
            + x
          );
          const voxelIndex = x + gridSize * (y + gridSize * z);
          voxels[voxelIndex] = Math.floor(
            normalized[atlasIndex] * 255 + 0.5
          );
        }
      }
    }
    const error = gl.getError();
    if (error !== gl.NO_ERROR) {
      throw new Error(
        `Prior smoke reference failed with WebGL error 0x${error.toString(16)}`
      );
    }
  } catch (error) {
    pipelineError = error;
  } finally {
    restoreState(gl, state);
    releaseResources(gl, resources);
  }

  const resourcesReleased = (
    resources.vertexArrays.every(resource => !gl.isVertexArray(resource))
    && resources.buffers.every(resource => !gl.isBuffer(resource))
    && resources.textures.every(resource => !gl.isTexture(resource))
    && resources.framebuffers.every(resource => !gl.isFramebuffer(resource))
    && resources.programs.every(resource => !gl.isProgram(resource))
  );
  if (!resourcesReleased) {
    throw new Error('Prior smoke reference leaked a WebGL resource');
  }
  if (pipelineError !== null) throw pipelineError;
  return Object.freeze({
    maximum,
    readbackPasses: 2,
    resourcesReleased,
    voxels,
  });
}
