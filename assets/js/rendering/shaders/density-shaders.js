// density-shaders.js - GPU-Accelerated Density Volume Splatting Shaders
// Used for splatting points into a 2D atlas (representing 3D volume)

// Shader for splatting points into a 2D atlas (representing 3D volume)
export const SPLAT_VS = `#version 300 es
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

export const SPLAT_FS = `#version 300 es
precision highp float;

in float v_weight;
out vec4 fragColor;

void main() {
  fragColor = vec4(v_weight, 0.0, 0.0, 1.0);
}
`;

// Shader for normalizing and applying gamma to the atlas
export const NORMALIZE_VS = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

export const NORMALIZE_FS = `#version 300 es
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
