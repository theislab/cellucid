// orbit-anchor-shaders.js - Precision Scientific Compass Shaders
// Shaders for 3D and 2D compass visualization

// 3D Version - Solid mesh with proper lighting and fog
export const ORBIT_ANCHOR_3D_VS = `#version 300 es
precision highp float;

in vec3 a_position;
in vec3 a_normal;
in vec4 a_color;

uniform mat4 u_mvpMatrix;
uniform mat4 u_viewMatrix;
uniform mat4 u_modelMatrix;
uniform vec3 u_cameraPos;

out vec4 v_color;
out vec3 v_normal;
out vec3 v_worldPos;
out float v_eyeDepth;

void main() {
  vec4 worldPos = u_modelMatrix * vec4(a_position, 1.0);
  v_worldPos = worldPos.xyz;
  vec4 eyePos = u_viewMatrix * worldPos;
  v_eyeDepth = -eyePos.z;
  gl_Position = u_mvpMatrix * vec4(a_position, 1.0);
  v_color = a_color;
  v_normal = normalize(mat3(u_modelMatrix) * a_normal);
}
`;

export const ORBIT_ANCHOR_3D_FS = `#version 300 es
precision highp float;

in vec4 v_color;
in vec3 v_normal;
in vec3 v_worldPos;
in float v_eyeDepth;

uniform float u_fogDensity;
uniform float u_fogNear;
uniform float u_fogFar;
uniform vec3 u_fogColor;
uniform float u_lightingStrength;
uniform vec3 u_lightDir;
uniform vec3 u_cameraPos;
uniform float u_emissive;

out vec4 fragColor;

void main() {
  if (v_color.a < 0.01) discard;

  vec3 N = normalize(v_normal);
  vec3 L = normalize(u_lightDir);
  vec3 V = normalize(u_cameraPos - v_worldPos);
  vec3 H = normalize(L + V);

  float NdotL = max(dot(N, L), 0.0);
  float NdotH = max(dot(N, H), 0.0);

  // Metallic instrument lighting
  float ambient = 0.30;
  float diffuse = 0.50 * NdotL;
  float specular = pow(NdotH, 80.0) * 0.35;
  float fresnel = pow(1.0 - max(dot(N, V), 0.0), 3.5) * 0.20;

  float lighting = mix(1.0, ambient + diffuse + specular + fresnel, u_lightingStrength);
  vec3 litColor = v_color.rgb * lighting + v_color.rgb * u_emissive * 0.5;

  // Fog
  float fogFactor = 0.0;
  if (u_fogDensity > 0.001) {
    float fogSpan = max(u_fogFar - u_fogNear, 0.0001);
    float normalizedDist = max(v_eyeDepth - u_fogNear, 0.0) / fogSpan;
    float extinction = u_fogDensity * u_fogDensity * 0.6;
    fogFactor = 1.0 - exp(-extinction * normalizedDist);
  }

  vec3 finalColor = mix(litColor, u_fogColor, fogFactor);
  float finalAlpha = v_color.a * (1.0 - fogFactor * 0.85);

  fragColor = vec4(finalColor, finalAlpha);
}
`;

// 2D Version - Clean flat rendering
export const ORBIT_ANCHOR_2D_VS = `#version 300 es
precision highp float;

in vec3 a_position;
in vec4 a_color;

uniform mat4 u_mvpMatrix;
uniform mat4 u_viewMatrix;

out vec4 v_color;
out float v_eyeDepth;

void main() {
  vec4 eyePos = u_viewMatrix * vec4(a_position, 1.0);
  v_eyeDepth = -eyePos.z;
  gl_Position = u_mvpMatrix * vec4(a_position, 1.0);
  v_color = a_color;
}
`;

export const ORBIT_ANCHOR_2D_FS = `#version 300 es
precision highp float;

in vec4 v_color;
in float v_eyeDepth;

uniform float u_fogDensity;
uniform float u_fogNear;
uniform float u_fogFar;
uniform vec3 u_fogColor;

out vec4 fragColor;

void main() {
  if (v_color.a < 0.01) discard;

  float fogFactor = 0.0;
  if (u_fogDensity > 0.001) {
    float fogSpan = max(u_fogFar - u_fogNear, 0.0001);
    float normalizedDist = max(v_eyeDepth - u_fogNear, 0.0) / fogSpan;
    float extinction = u_fogDensity * u_fogDensity * 0.6;
    fogFactor = 1.0 - exp(-extinction * normalizedDist);
  }

  vec3 finalColor = mix(v_color.rgb, u_fogColor, fogFactor);
  float finalAlpha = v_color.a * (1.0 - fogFactor * 0.85);

  fragColor = vec4(finalColor, finalAlpha);
}
`;
