// centroid-shaders.js - Simple centroid point rendering shaders
// Used for small number of centroid points (WebGL2)
// Uses RGBA uint8 normalized colors (same as main points)

import { FULL_LIGHTING } from './high-perf-shaders.js';
import { POINT_SPRITE_GLSL } from '../point-sprite.js';

export const CENTROID_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_position;
layout(location = 1) in vec4 a_color; // RGBA packed as uint8, auto-normalized by WebGL

uniform mat4 u_mvpMatrix;
uniform mat4 u_viewMatrix;
uniform mat4 u_modelMatrix;
${POINT_SPRITE_GLSL}
out vec3 v_color;
out float v_alpha;

void main() {
  gl_Position = u_mvpMatrix * vec4(a_position, 1.0);

  // Eye-space depth for the sprite's size (as HP_VS_FULL)
  vec4 worldPos = u_modelMatrix * vec4(a_position, 1.0);
  vec4 eyePos = u_viewMatrix * worldPos;
  float eyeDepth = -eyePos.z;

  // The sprite of every point shader (rendering/point-sprite.js), with its cap.
  gl_PointSize = pointSpriteSize(eyeDepth);

  // Reject hidden centroids before rasterisation — see HP_VS_FULL. Zeroing the
  // size alone does not hide one: the driver clamps it back to a pixel.
  //
  // This branch is live. A category filtered down to no visible cells arrives
  // with alpha 0 (app/state/managers/field/summary.js), and the centroid pass
  // draws on the renderer's depthMask(true) (viewer.js, drawCentroids), so
  // without this rejection the only thing keeping a hidden centroid from
  // writing depth over a visible point is the discard in CENTROID_FS below.
  if (a_color.a < 0.01) {
    gl_PointSize = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }

  v_color = a_color.rgb;
  v_alpha = a_color.a;
}
`;

export const CENTROID_FS = `#version 300 es
precision highp float;

in vec3 v_color;
in float v_alpha;

out vec4 fragColor;

void main() {
  if (v_alpha < 0.01) discard;
  vec2 coord = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(coord, coord);
  if (r2 > 1.0) discard;

  // Simple sphere shading
  float z = sqrt(1.0 - r2);
  vec3 normal = vec3(coord.x, -coord.y, z);
  vec3 lightDir = normalize(vec3(0.5, 0.7, 0.5));
  float NdotL = max(dot(normal, lightDir), 0.0);
  float lighting = ${FULL_LIGHTING.ambient.toFixed(2)} + ${FULL_LIGHTING.diffuse.toFixed(2)} * NdotL;

  fragColor = vec4(v_color * lighting, v_alpha);
}
`;
