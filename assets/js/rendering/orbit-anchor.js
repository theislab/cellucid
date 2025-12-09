// orbit-anchor.js - Professional Scientific Compass Visualization
// Clean, minimal design inspired by precision scientific instruments
// Features:
// - Slim compass ring with fine graduations
// - Elegant needle design
// - Vertical elevation arc with clear degree markings
// - Per-view independent state for unlocked camera mode

// === SHADERS ===

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

  float ambient = 0.35;
  float diffuse = 0.55 * NdotL;
  float specular = pow(NdotH, 64.0) * 0.25;
  float fresnel = pow(1.0 - max(dot(N, V), 0.0), 3.0) * 0.15;

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

// === ORBIT ANCHOR RENDERER CLASS ===

export class OrbitAnchorRenderer {
  constructor(gl, canvas) {
    this.gl = gl;
    this.canvas = canvas;

    // Per-view state
    this.viewStates = new Map();

    // Global settings
    this.showAnchor = true;

    // Compile shaders and create programs
    this.program3D = this._createProgram(ORBIT_ANCHOR_3D_VS, ORBIT_ANCHOR_3D_FS);
    this.program2D = this._createProgram(ORBIT_ANCHOR_2D_VS, ORBIT_ANCHOR_2D_FS);

    // Get attribute and uniform locations
    this._setupLocations();
  }

  _createShader(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Orbit anchor shader compile error:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  _createProgram(vsSource, fsSource) {
    const gl = this.gl;
    const vs = this._createShader(gl.VERTEX_SHADER, vsSource);
    const fs = this._createShader(gl.FRAGMENT_SHADER, fsSource);
    if (!vs || !fs) return null;

    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Orbit anchor program link error:', gl.getProgramInfoLog(program));
      return null;
    }

    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return program;
  }

  _setupLocations() {
    const gl = this.gl;

    // 3D program locations
    this.attribs3D = {
      position: gl.getAttribLocation(this.program3D, 'a_position'),
      normal: gl.getAttribLocation(this.program3D, 'a_normal'),
      color: gl.getAttribLocation(this.program3D, 'a_color'),
    };
    this.uniforms3D = {
      mvpMatrix: gl.getUniformLocation(this.program3D, 'u_mvpMatrix'),
      viewMatrix: gl.getUniformLocation(this.program3D, 'u_viewMatrix'),
      modelMatrix: gl.getUniformLocation(this.program3D, 'u_modelMatrix'),
      cameraPos: gl.getUniformLocation(this.program3D, 'u_cameraPos'),
      fogDensity: gl.getUniformLocation(this.program3D, 'u_fogDensity'),
      fogNear: gl.getUniformLocation(this.program3D, 'u_fogNear'),
      fogFar: gl.getUniformLocation(this.program3D, 'u_fogFar'),
      fogColor: gl.getUniformLocation(this.program3D, 'u_fogColor'),
      lightingStrength: gl.getUniformLocation(this.program3D, 'u_lightingStrength'),
      lightDir: gl.getUniformLocation(this.program3D, 'u_lightDir'),
      emissive: gl.getUniformLocation(this.program3D, 'u_emissive'),
    };

    // 2D program locations
    this.attribs2D = {
      position: gl.getAttribLocation(this.program2D, 'a_position'),
      color: gl.getAttribLocation(this.program2D, 'a_color'),
    };
    this.uniforms2D = {
      mvpMatrix: gl.getUniformLocation(this.program2D, 'u_mvpMatrix'),
      viewMatrix: gl.getUniformLocation(this.program2D, 'u_viewMatrix'),
      fogDensity: gl.getUniformLocation(this.program2D, 'u_fogDensity'),
      fogNear: gl.getUniformLocation(this.program2D, 'u_fogNear'),
      fogFar: gl.getUniformLocation(this.program2D, 'u_fogFar'),
      fogColor: gl.getUniformLocation(this.program2D, 'u_fogColor'),
    };
  }

  // Get or create per-view state
  getViewState(viewId) {
    if (!this.viewStates.has(viewId)) {
      const gl = this.gl;
      this.viewStates.set(viewId, {
        positionBuffer: gl.createBuffer(),
        normalBuffer: gl.createBuffer(),
        colorBuffer: gl.createBuffer(),
        indexBuffer: gl.createBuffer(),
        linePositionBuffer: gl.createBuffer(),
        lineNormalBuffer: gl.createBuffer(),
        lineColorBuffer: gl.createBuffer(),
        vertexCount: 0,
        indexCount: 0,
        lineCount: 0,
        lineData: null,
        needsRebuild: true,
        is3D: true,
        lastX: NaN, lastY: NaN, lastZ: NaN,
        lastRadius: NaN,
        lastTheta: NaN, lastPhi: NaN,
        lastBgLuminance: -1
      });
    }
    return this.viewStates.get(viewId);
  }

  // Clean up view state
  deleteViewState(viewId) {
    const gl = this.gl;
    const state = this.viewStates.get(viewId);
    if (state) {
      gl.deleteBuffer(state.positionBuffer);
      gl.deleteBuffer(state.normalBuffer);
      gl.deleteBuffer(state.colorBuffer);
      gl.deleteBuffer(state.indexBuffer);
      gl.deleteBuffer(state.linePositionBuffer);
      gl.deleteBuffer(state.lineNormalBuffer);
      gl.deleteBuffer(state.lineColorBuffer);
      this.viewStates.delete(viewId);
    }
  }

  // Trigger rebuild for all views
  markAllNeedsRebuild() {
    for (const state of this.viewStates.values()) {
      state.needsRebuild = true;
    }
  }

  // Professional scientific color palette
  getColors(bgColor) {
    const luminance = bgColor[0] * 0.299 + bgColor[1] * 0.587 + bgColor[2] * 0.114;
    const isDark = luminance < 0.5;

    if (isDark) {
      return {
        // Chrome/steel ring
        ring: [0.75, 0.78, 0.82, 0.90],
        ringInner: [0.65, 0.68, 0.72, 0.85],
        // Fine tick marks
        tickMinor: [0.60, 0.63, 0.68, 0.70],
        tickMajor: [0.80, 0.82, 0.85, 0.90],
        tickCardinal: [0.90, 0.92, 0.95, 1.0],
        // North indicator - red
        north: [0.95, 0.25, 0.20, 1.0],
        // Center pivot - small and precise
        center: [0.85, 0.87, 0.90, 1.0],
        // Azimuth needle - cyan/blue
        needle: [0.30, 0.75, 0.95, 1.0],
        needleTip: [0.50, 0.85, 1.0, 1.0],
        // Elevation arc - subtle blue
        arc: [0.45, 0.65, 0.85, 0.75],
        arcTick: [0.55, 0.72, 0.88, 0.85],
        // Elevation indicator - warm gold
        elevIndicator: [1.0, 0.78, 0.20, 1.0],
        elevGlow: [1.0, 0.85, 0.40, 0.50],
      };
    } else {
      return {
        // Darker steel for light backgrounds
        ring: [0.35, 0.38, 0.42, 0.88],
        ringInner: [0.45, 0.48, 0.52, 0.82],
        // Tick marks
        tickMinor: [0.50, 0.52, 0.55, 0.60],
        tickMajor: [0.35, 0.38, 0.42, 0.85],
        tickCardinal: [0.25, 0.28, 0.32, 1.0],
        // North indicator
        north: [0.85, 0.18, 0.12, 1.0],
        // Center pivot
        center: [0.30, 0.32, 0.35, 1.0],
        // Azimuth needle
        needle: [0.15, 0.50, 0.75, 1.0],
        needleTip: [0.20, 0.55, 0.80, 1.0],
        // Elevation arc
        arc: [0.30, 0.50, 0.70, 0.70],
        arcTick: [0.25, 0.45, 0.65, 0.80],
        // Elevation indicator
        elevIndicator: [0.90, 0.60, 0.10, 1.0],
        elevGlow: [0.95, 0.70, 0.20, 0.45],
      };
    }
  }

  // Fixed anchor radius based on data bounds
  computeAnchorRadius(pointBoundsRadius) {
    // Make the compass a prominent gyroscopic instrument at the center of the data.
    // Slightly larger than previous versions so it reads clearly even in dense scenes.
    const base = (pointBoundsRadius || 1.0);
    return base * 0.04;
  }

  // === 3D GEOMETRY BUILDERS ===

  // Smooth sphere (icosphere)
  _generateSphere(cx, cy, cz, radius, subdivisions, color) {
    const positions = [];
    const normals = [];
    const colors = [];
    const indices = [];

    const t = (1.0 + Math.sqrt(5.0)) / 2.0;
    const icoVerts = [
      [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
      [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
      [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]
    ].map(v => {
      const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
      return [v[0] / len, v[1] / len, v[2] / len];
    });

    const icoFaces = [
      [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
      [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
      [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
      [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]
    ];

    const midPointCache = {};
    function getMidPoint(p1Idx, p2Idx, verts) {
      const key = p1Idx < p2Idx ? `${p1Idx}_${p2Idx}` : `${p2Idx}_${p1Idx}`;
      if (midPointCache[key] !== undefined) return midPointCache[key];
      const p1 = verts[p1Idx], p2 = verts[p2Idx];
      const mid = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2, (p1[2] + p2[2]) / 2];
      const len = Math.sqrt(mid[0] * mid[0] + mid[1] * mid[1] + mid[2] * mid[2]);
      mid[0] /= len; mid[1] /= len; mid[2] /= len;
      const newIdx = verts.length;
      verts.push(mid);
      midPointCache[key] = newIdx;
      return newIdx;
    }

    let verts = [...icoVerts];
    let faces = [...icoFaces];
    for (let s = 0; s < subdivisions; s++) {
      const newFaces = [];
      for (const face of faces) {
        const a = getMidPoint(face[0], face[1], verts);
        const b = getMidPoint(face[1], face[2], verts);
        const c = getMidPoint(face[2], face[0], verts);
        newFaces.push([face[0], a, c], [face[1], b, a], [face[2], c, b], [a, b, c]);
      }
      faces = newFaces;
    }

    for (const v of verts) {
      positions.push(cx + v[0] * radius, cy + v[1] * radius, cz + v[2] * radius);
      normals.push(v[0], v[1], v[2]);
      colors.push(color[0], color[1], color[2], color[3]);
    }
    for (const face of faces) indices.push(face[0], face[1], face[2]);

    return { positions, normals, colors, indices, vertexCount: positions.length / 3 };
  }

  // Thin torus for ring
  _generateTorus(cx, cy, cz, majorRadius, minorRadius, majorSegs, minorSegs, color, axis = 'y', startAngle = 0, endAngle = Math.PI * 2) {
    const positions = [], normals = [], colors = [], indices = [];
    const angleRange = endAngle - startAngle;

    for (let i = 0; i <= majorSegs; i++) {
      const u = startAngle + (i / majorSegs) * angleRange;
      const cosU = Math.cos(u), sinU = Math.sin(u);

      for (let j = 0; j <= minorSegs; j++) {
        const v = (j / minorSegs) * Math.PI * 2;
        const cosV = Math.cos(v), sinV = Math.sin(v);
        const tubeRadius = majorRadius + minorRadius * cosV;

        let px, py, pz, nx, ny, nz;
        if (axis === 'y') {
          px = tubeRadius * cosU; py = minorRadius * sinV; pz = tubeRadius * sinU;
          nx = cosV * cosU; ny = sinV; nz = cosV * sinU;
        } else if (axis === 'x') {
          py = tubeRadius * cosU; pz = tubeRadius * sinU; px = minorRadius * sinV;
          ny = cosV * cosU; nz = cosV * sinU; nx = sinV;
        } else {
          px = tubeRadius * cosU; pz = minorRadius * sinV; py = tubeRadius * sinU;
          nx = cosV * cosU; nz = sinV; ny = cosV * sinU;
        }

        positions.push(cx + px, cy + py, cz + pz);
        normals.push(nx, ny, nz);
        colors.push(color[0], color[1], color[2], color[3]);
      }
    }

    for (let i = 0; i < majorSegs; i++) {
      for (let j = 0; j < minorSegs; j++) {
        const a = i * (minorSegs + 1) + j;
        const b = a + minorSegs + 1;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }

    return { positions, normals, colors, indices, vertexCount: positions.length / 3 };
  }

  // Cylinder for tick marks
  _generateCylinder(x1, y1, z1, x2, y2, z2, radius, segments, color) {
    const positions = [], normals = [], colors = [], indices = [];
    const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 0.0001) return { positions: [], normals: [], colors: [], indices: [], vertexCount: 0 };

    const ax = dx / len, ay = dy / len, az = dz / len;
    let px, py, pz;
    if (Math.abs(ay) < 0.9) { px = -az; py = 0; pz = ax; }
    else { px = 1; py = 0; pz = 0; }
    const pLen = Math.sqrt(px * px + py * py + pz * pz);
    px /= pLen; py /= pLen; pz /= pLen;
    const qx = ay * pz - az * py, qy = az * px - ax * pz, qz = ax * py - ay * px;

    for (let cap = 0; cap < 2; cap++) {
      const bx = cap === 0 ? x1 : x2, by = cap === 0 ? y1 : y2, bz = cap === 0 ? z1 : z2;
      for (let i = 0; i <= segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        const c = Math.cos(angle), s = Math.sin(angle);
        const nx = px * c + qx * s, ny = py * c + qy * s, nz = pz * c + qz * s;
        positions.push(bx + nx * radius, by + ny * radius, bz + nz * radius);
        normals.push(nx, ny, nz);
        colors.push(color[0], color[1], color[2], color[3]);
      }
    }

    for (let i = 0; i < segments; i++) {
      indices.push(i, i + segments + 1, i + 1, i + 1, i + segments + 1, i + segments + 2);
    }

    return { positions, normals, colors, indices, vertexCount: positions.length / 3 };
  }

  // Diamond/rhombus shape for needle tip
  _generateDiamond(cx, cy, cz, length, width, height, color, rotationY = 0) {
    const positions = [], normals = [], colors = [], indices = [];

    // Diamond vertices: front tip, back tip, left, right, top, bottom
    const cosR = Math.cos(rotationY), sinR = Math.sin(rotationY);

    const verts = [
      [length, 0, 0],      // front tip
      [-length * 0.3, 0, 0], // back
      [0, 0, width],       // left
      [0, 0, -width],      // right
      [0, height, 0],      // top
      [0, -height, 0],     // bottom
    ];

    // Rotate and translate
    const transformed = verts.map(v => [
      cx + v[0] * cosR - v[2] * sinR,
      cy + v[1],
      cz + v[0] * sinR + v[2] * cosR
    ]);

    // Faces: front-top-left, front-top-right, front-bottom-left, front-bottom-right
    //        back-top-left, back-top-right, back-bottom-left, back-bottom-right
    const faces = [
      [0, 4, 2], [0, 3, 4], [0, 2, 5], [0, 5, 3],  // front faces
      [1, 2, 4], [1, 4, 3], [1, 5, 2], [1, 3, 5],  // back faces
    ];

    for (const face of faces) {
      const v0 = transformed[face[0]], v1 = transformed[face[1]], v2 = transformed[face[2]];
      const e1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
      const e2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
      let nx = e1[1] * e2[2] - e1[2] * e2[1];
      let ny = e1[2] * e2[0] - e1[0] * e2[2];
      let nz = e1[0] * e2[1] - e1[1] * e2[0];
      const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (nLen > 0) { nx /= nLen; ny /= nLen; nz /= nLen; }

      const baseIdx = positions.length / 3;
      for (const idx of face) {
        positions.push(transformed[idx][0], transformed[idx][1], transformed[idx][2]);
        normals.push(nx, ny, nz);
        colors.push(color[0], color[1], color[2], color[3]);
      }
      indices.push(baseIdx, baseIdx + 1, baseIdx + 2);
    }

    return { positions, normals, colors, indices, vertexCount: positions.length / 3 };
  }

  // Build 3D compass geometry - Professional scientific design
  buildGeometry3D(cx, cy, cz, r, viewTheta, viewPhi, bgColor) {
    const palette = this.getColors(bgColor);

    let allPositions = [], allNormals = [], allColors = [], allIndices = [];
    let linePositions = [], lineNormals = [], lineColors = [];

    const mergeGeometry = (geom) => {
      if (!geom || geom.positions.length === 0) return;
      const baseIdx = allPositions.length / 3;
      allPositions.push(...geom.positions);
      allNormals.push(...geom.normals);
      allColors.push(...geom.colors);
      for (const idx of geom.indices) allIndices.push(baseIdx + idx);
    };

    const addLine = (x1, y1, z1, x2, y2, z2, color, normal) => {
      linePositions.push(x1, y1, z1, x2, y2, z2);
      lineNormals.push(...normal, ...normal);
      lineColors.push(...color, ...color);
    };

    // === MAIN OUTER GYRO RING (3D compass body) ===
    // Compact, high-visibility ring that frames the orbit target without dominating.
    const ringRadius = r * 0.65;
    const ringThickness = r * 0.014;
    const mainRing = this._generateTorus(cx, cy, cz, ringRadius, ringThickness, 80, 14, palette.ring, 'y');
    mergeGeometry(mainRing);

    // Inner chapter ring gives a real-compass feel and breaks up the face.
    const innerRingRadius = ringRadius * 0.75;
    const innerRingThickness = ringThickness * 0.6;
    const innerRing = this._generateTorus(cx, cy, cz, innerRingRadius, innerRingThickness, 72, 10, palette.ringInner, 'y');
    mergeGeometry(innerRing);

    // Max tick length so that cardinal ticks reach exactly to the outer ring.
    const maxTickLen = ringRadius - innerRingRadius;

    // === CENTER PIVOT - compact, precise sphere that anchors all rings ===
    const centerSphere = this._generateSphere(cx, cy, cz, r * 0.030, 2, palette.center);
    mergeGeometry(centerSphere);

    // === TICK MARKS - cardinal / major / minor, like a real compass ===
    // 10° spacing feels scientific but not cluttered.
    for (let deg = 0; deg < 360; deg += 10) {
      const angle = deg * Math.PI / 180;
      const isCardinal = deg % 90 === 0;
      const isMajor = deg % 30 === 0;
      const isMinor = !isCardinal && !isMajor;

      // Ticks run from the inner ring toward the outer ring.
      // Cardinal ticks end exactly on the outer ring so that:
      // outer radius = inner radius + tick length.
      let tickInner, tickOuter, tickRadius, tickColor;

      const baseInner = innerRingRadius;

      if (isCardinal) {
        tickInner = baseInner;
        tickOuter = baseInner + maxTickLen; // = ringRadius
        tickRadius = r * 0.006;
        tickColor = deg === 0 ? palette.north : palette.tickCardinal;
      } else if (isMajor) {
        tickInner = baseInner + maxTickLen * 0.15;
        tickOuter = baseInner + maxTickLen * 0.75;
        tickRadius = r * 0.0045;
        tickColor = palette.tickMajor;
      } else {
        tickInner = baseInner + maxTickLen * 0.30;
        tickOuter = baseInner + maxTickLen * 0.55;
        tickRadius = r * 0.0035;
        tickColor = palette.tickMinor;
      }

      const cosA = Math.cos(angle), sinA = Math.sin(angle);
      const tick = this._generateCylinder(
        cx + cosA * tickInner, cy, cz + sinA * tickInner,
        cx + cosA * tickOuter, cy, cz + sinA * tickOuter,
        tickRadius, 6, tickColor
      );
      mergeGeometry(tick);
    }

    // === NORTH ARROW - luminous marker on the outer gyro ring ===
    const northDist = ringRadius + r * 0.045;
    const northTip = this._generateDiamond(
      cx + northDist, cy + r * 0.018, cz,
      r * 0.040, r * 0.022, r * 0.013,
      palette.north, 0
    );
    mergeGeometry(northTip);

    // === AZIMUTH NEEDLE - points to camera heading ===
    // Adjust needle angle: viewTheta is the azimuth, add PI to point toward camera
    const needleAngle = viewTheta + Math.PI;
    const needleLen = innerRingRadius - r * 0.05;
    const needleStart = r * 0.055;

    // Needle body - slim cylinder floating slightly above the face
    const needleBody = this._generateCylinder(
      cx + Math.cos(needleAngle) * needleStart, cy + r * 0.020, cz + Math.sin(needleAngle) * needleStart,
      cx + Math.cos(needleAngle) * needleLen,   cy + r * 0.020, cz + Math.sin(needleAngle) * needleLen,
      r * 0.006, 8, palette.needle
    );
    mergeGeometry(needleBody);

    // Needle tip - diamond shape at the forward end
    const needleTip = this._generateDiamond(
      cx + Math.cos(needleAngle) * needleLen, cy + r * 0.020, cz + Math.sin(needleAngle) * needleLen,
      r * 0.030, r * 0.018, r * 0.011,
      palette.needleTip, needleAngle
    );
    mergeGeometry(needleTip);

    // === ELEVATION ARC - slim vertical semicircle kept close to the compass ===
    const arcRadius = innerRingRadius * 0.70;
    const arcThickness = r * 0.007;
    const arcRotation = 0;  // Fixed at North (0°) direction

    // Create arc as series of small segments
    const arcSegs = 40;
    for (let i = 0; i < arcSegs; i++) {
      // Arc goes from -90° to +90° (bottom to top)
      const el1 = -Math.PI * 0.5 + (i / arcSegs) * Math.PI;
      const el2 = -Math.PI * 0.5 + ((i + 1) / arcSegs) * Math.PI;

      const x1 = arcRadius * Math.cos(el1), y1 = arcRadius * Math.sin(el1);
      const x2 = arcRadius * Math.cos(el2), y2 = arcRadius * Math.sin(el2);

      // Rotate to face camera
      const wx1 = x1 * Math.cos(arcRotation), wz1 = -x1 * Math.sin(arcRotation);
      const wx2 = x2 * Math.cos(arcRotation), wz2 = -x2 * Math.sin(arcRotation);

      const arcSeg = this._generateCylinder(
        cx + wx1, cy + y1, cz + wz1,
        cx + wx2, cy + y2, cz + wz2,
        arcThickness, 6, palette.arc
      );
      mergeGeometry(arcSeg);
    }

    // === ELEVATION TICK MARKS ===
    const elevTicks = [-90, -60, -30, 0, 30, 60, 90];
    for (const deg of elevTicks) {
      const elRad = deg * Math.PI / 180;
      const isMajor = deg === 0 || Math.abs(deg) === 90;

      const arcX = arcRadius * Math.cos(elRad);
      const arcY = arcRadius * Math.sin(elRad);
      const worldX = arcX * Math.cos(arcRotation);
      const worldZ = -arcX * Math.sin(arcRotation);

      const tickLen = isMajor ? r * 0.022 : r * 0.015;
      const tickRadius = isMajor ? r * 0.0050 : r * 0.0035;

      // Tick extends outward from arc
      const outX = (arcRadius + tickLen) * Math.cos(elRad);
      const outY = (arcRadius + tickLen) * Math.sin(elRad);
      const owx = outX * Math.cos(arcRotation);
      const owz = -outX * Math.sin(arcRotation);

      const tick = this._generateCylinder(
        cx + worldX, cy + arcY, cz + worldZ,
        cx + owx, cy + outY, cz + owz,
        tickRadius, 5, palette.arcTick
      );
      mergeGeometry(tick);
    }

    // === ELEVATION INDICATOR ===
    // Adjust elevation by -90° to match coordinate system:
    // - viewPhi = PI/2 (90°, horizontal view) → shows at 0° on arc (middle)
    // - viewPhi = PI (180°, looking up) → shows at +90° (top)
    // - viewPhi = 0 (looking down) → shows at -90° (bottom)
    const adjustedPhi = viewPhi - Math.PI * 0.5;
    const clampedEl = Math.max(-Math.PI * 0.5, Math.min(Math.PI * 0.5, adjustedPhi));

    const elX = arcRadius * Math.cos(clampedEl);
    const elY = arcRadius * Math.sin(clampedEl);
    const elWX = elX * Math.cos(arcRotation);
    const elWZ = -elX * Math.sin(arcRotation);

    // Main indicator sphere
    const elevSphere = this._generateSphere(
      cx + elWX, cy + elY, cz + elWZ,
      r * 0.026, 2, palette.elevIndicator
    );
    mergeGeometry(elevSphere);

    // Subtle glow ring
    const glowRing = this._generateTorus(
      cx + elWX, cy + elY, cz + elWZ,
      r * 0.035, r * 0.004, 12, 6, palette.elevGlow, 'z'
    );
    mergeGeometry(glowRing);

    // === SUBTLE CROSSHAIR at center ===
    const crossLen = innerRingRadius * 0.68;
    const crossColor = [palette.tickMinor[0], palette.tickMinor[1], palette.tickMinor[2], 0.55];
    addLine(cx - crossLen, cy, cz, cx + crossLen, cy, cz, crossColor, [0, 1, 0]);
    addLine(cx, cy, cz - crossLen, cx, cy, cz + crossLen, crossColor, [0, 1, 0]);

    return {
      positions: new Float32Array(allPositions),
      normals: new Float32Array(allNormals),
      colors: new Float32Array(allColors),
      indices: new Uint16Array(allIndices),
      indexCount: allIndices.length,
      vertexCount: allPositions.length / 3,
      linePositions: new Float32Array(linePositions),
      lineNormals: new Float32Array(lineNormals),
      lineColors: new Float32Array(lineColors),
      lineCount: linePositions.length / 3
    };
  }

  // Build 2D compass geometry - Uses triangles for thick, visible lines
  // This creates a clean, minimal but VISIBLE design for light/ultralight shaders
  buildGeometry2D(cx, cy, cz, r, viewTheta, viewPhi, bgColor) {
    const positions = [];
    const normals = [];
    const colors = [];
    const indices = [];
    const palette = this.getColors(bgColor);

    const addVertex = (x, y, z, color) => {
      const idx = positions.length / 3;
      positions.push(x, y, z);
      normals.push(0, 1, 0);  // All normals point up for 2D
      colors.push(color[0], color[1], color[2], color[3]);
      return idx;
    };

    const addTriangle = (i1, i2, i3) => {
      indices.push(i1, i2, i3);
    };

    // Draw a thick line as a flat quad (billboard-style, lying flat)
    const addThickLine = (x1, y1, z1, x2, y2, z2, color, width) => {
      const dx = x2 - x1, dz = z2 - z1;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len < 0.0001) return;

      // Perpendicular vector in XZ plane
      const px = -dz / len * width;
      const pz = dx / len * width;

      // Create quad corners
      const i1 = addVertex(x1 + px, y1, z1 + pz, color);
      const i2 = addVertex(x1 - px, y1, z1 - pz, color);
      const i3 = addVertex(x2 + px, y2, z2 + pz, color);
      const i4 = addVertex(x2 - px, y2, z2 - pz, color);

      addTriangle(i1, i2, i3);
      addTriangle(i2, i4, i3);
    };

    // Draw a thick 3D line (for elevation arc)
    const addThickLine3D = (x1, y1, z1, x2, y2, z2, color, width) => {
      const dx = x2 - x1, dz = z2 - z1;
      const lenXZ = Math.sqrt(dx * dx + dz * dz);
      if (lenXZ < 0.0001) return;

      // Get perpendicular in XZ plane
      const px = -dz / lenXZ * width;
      const pz = dx / lenXZ * width;

      const i1 = addVertex(x1 + px, y1, z1 + pz, color);
      const i2 = addVertex(x1 - px, y1, z1 - pz, color);
      const i3 = addVertex(x2 + px, y2, z2 + pz, color);
      const i4 = addVertex(x2 - px, y2, z2 - pz, color);

      addTriangle(i1, i2, i3);
      addTriangle(i2, i4, i3);
    };

    // Draw a filled circle (flat disc)
    const addDisc = (ccx, ccy, ccz, radius, segments, color) => {
      const centerIdx = addVertex(ccx, ccy, ccz, color);
      const firstIdx = positions.length / 3;

      for (let i = 0; i <= segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        addVertex(ccx + Math.cos(angle) * radius, ccy, ccz + Math.sin(angle) * radius, color);
      }

      for (let i = 0; i < segments; i++) {
        addTriangle(centerIdx, firstIdx + i, firstIdx + i + 1);
      }
    };

    // Draw ring (thick circle outline)
    const addRing = (ccx, ccy, ccz, innerRadius, outerRadius, segments, color) => {
      const firstInner = positions.length / 3;

      for (let i = 0; i <= segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        const cos = Math.cos(angle), sin = Math.sin(angle);
        addVertex(ccx + cos * innerRadius, ccy, ccz + sin * innerRadius, color);
        addVertex(ccx + cos * outerRadius, ccy, ccz + sin * outerRadius, color);
      }

      for (let i = 0; i < segments; i++) {
        const base = firstInner + i * 2;
        addTriangle(base, base + 1, base + 2);
        addTriangle(base + 1, base + 3, base + 2);
      }
    };

    // Draw filled triangle
    const addFilledTriangle = (x1, y1, z1, x2, y2, z2, x3, y3, z3, color) => {
      const i1 = addVertex(x1, y1, z1, color);
      const i2 = addVertex(x2, y2, z2, color);
      const i3 = addVertex(x3, y3, z3, color);
      addTriangle(i1, i2, i3);
    };

    const baseWidth = r * 0.010;  // Base line width
    const ringRadius = r * 0.65;
    const ringWidth = r * 0.015;
    const innerRingRadius = ringRadius * 0.75;
    const innerRingWidth = ringWidth * 0.60;
    const maxTickLen = ringRadius - innerRingRadius;

    // === MAIN OUTER RING - gyro bezel ===
    addRing(cx, cy, cz, ringRadius - ringWidth, ringRadius + ringWidth, 80, palette.ring);

    // === INNER CHAPTER RING ===
    addRing(
      cx,
      cy,
      cz,
      innerRingRadius - innerRingWidth,
      innerRingRadius + innerRingWidth,
      72,
      palette.ringInner
    );

    // === CENTER DISC ===
    addDisc(cx, cy + r * 0.002, cz, r * 0.038, 16, palette.center);

    // === TICK MARKS ===
    for (let deg = 0; deg < 360; deg += 10) {
      const angle = deg * Math.PI / 180;
      const isCardinal = deg % 90 === 0;
      const isMajor = deg % 30 === 0;

      const tickBaseInner = innerRingRadius;
      let tickInner, tickOuter, tickWidth, tickColor;

      if (isCardinal) {
        tickInner = tickBaseInner;
        tickOuter = tickBaseInner + maxTickLen; // = ringRadius
        tickWidth = baseWidth * 1.6;
        tickColor = deg === 0 ? palette.north : palette.tickCardinal;
      } else if (isMajor) {
        tickInner = tickBaseInner + maxTickLen * 0.15;
        tickOuter = tickBaseInner + maxTickLen * 0.75;
        tickWidth = baseWidth * 1.2;
        tickColor = palette.tickMajor;
      } else {
        tickInner = tickBaseInner + maxTickLen * 0.30;
        tickOuter = tickBaseInner + maxTickLen * 0.55;
        tickWidth = baseWidth * 0.9;
        tickColor = palette.tickMinor;
      }

      const cosA = Math.cos(angle), sinA = Math.sin(angle);
      addThickLine(
        cx + cosA * tickInner, cy, cz + sinA * tickInner,
        cx + cosA * tickOuter, cy, cz + sinA * tickOuter,
        tickColor, tickWidth
      );
    }

    // === NORTH ARROW - luminous marker on gyro ring ===
    const northBase = ringRadius + ringWidth * 1.6;
    const northTip = ringRadius + ringWidth * 2.8;
    const northWidth = r * 0.035;
    addFilledTriangle(
      cx + northTip, cy + r * 0.003, cz,
      cx + northBase, cy, cz - northWidth,
      cx + northBase, cy, cz + northWidth,
      palette.north
    );

    // === AZIMUTH NEEDLE - tapered thick line ===
    const needleAngle = viewTheta + Math.PI;
    const needleLen = innerRingRadius - r * 0.045;
    const needleStart = r * 0.060;
    const cosN = Math.cos(needleAngle), sinN = Math.sin(needleAngle);

    // Needle as filled triangle (tapered)
    addFilledTriangle(
      cx + cosN * needleLen, cy + r * 0.003, cz + sinN * needleLen,
      cx + cosN * needleStart + Math.cos(needleAngle + Math.PI/2) * baseWidth * 2, cy, cz + sinN * needleStart + Math.sin(needleAngle + Math.PI/2) * baseWidth * 2,
      cx + cosN * needleStart + Math.cos(needleAngle - Math.PI/2) * baseWidth * 2, cy, cz + sinN * needleStart + Math.sin(needleAngle - Math.PI/2) * baseWidth * 2,
      palette.needle
    );

    // Needle tip disc
    addDisc(cx + cosN * needleLen, cy + r * 0.003, cz + sinN * needleLen, r * 0.025, 12, palette.needleTip);

    // === ELEVATION ARC - thick arc kept close to compass ===
    const arcRadius2 = innerRingRadius * 0.70;
    const arcWidth = baseWidth * 1.0;
    const arcSegs = 32;
    const arcRotation2D = 0;  // Fixed at North (0°) direction
    const cosArc = Math.cos(arcRotation2D), sinArc = Math.sin(arcRotation2D);

    for (let i = 0; i < arcSegs; i++) {
      const el1 = -Math.PI * 0.5 + (i / arcSegs) * Math.PI;
      const el2 = -Math.PI * 0.5 + ((i + 1) / arcSegs) * Math.PI;

      const x1 = arcRadius2 * Math.cos(el1), y1 = arcRadius2 * Math.sin(el1);
      const x2 = arcRadius2 * Math.cos(el2), y2 = arcRadius2 * Math.sin(el2);

      const wx1 = x1 * cosArc, wz1 = -x1 * sinArc;
      const wx2 = x2 * cosArc, wz2 = -x2 * sinArc;

      addThickLine3D(cx + wx1, cy + y1, cz + wz1, cx + wx2, cy + y2, cz + wz2, palette.arc, arcWidth);
    }

    // === ELEVATION TICKS ===
    for (const deg of [-90, -45, 0, 45, 90]) {
      const elRad = deg * Math.PI / 180;
      const isMajor = deg === 0 || Math.abs(deg) === 90;

      const arcX = arcRadius2 * Math.cos(elRad);
      const arcY = arcRadius2 * Math.sin(elRad);
      const worldX = arcX * cosArc;
      const worldZ = -arcX * sinArc;

      const tickLen = isMajor ? r * 0.032 : r * 0.020;
      const outX = (arcRadius2 + tickLen) * Math.cos(elRad);
      const outY = (arcRadius2 + tickLen) * Math.sin(elRad);
      const owx = outX * cosArc;
      const owz = -outX * sinArc;

      addThickLine3D(
        cx + worldX, cy + arcY, cz + worldZ,
        cx + owx, cy + outY, cz + owz,
        palette.arcTick, isMajor ? baseWidth * 1.2 : baseWidth * 0.8
      );
    }

    // === ELEVATION INDICATOR - filled disc ===
    // Adjust by -90° to match coordinate system
    const adjustedPhi = viewPhi - Math.PI * 0.5;
    const clampedEl = Math.max(-Math.PI * 0.5, Math.min(Math.PI * 0.5, adjustedPhi));
    const elX = arcRadius2 * Math.cos(clampedEl);
    const elY = arcRadius2 * Math.sin(clampedEl);
    const elWX = elX * cosArc;
    const elWZ = -elX * sinArc;

    // Indicator as bright disc
    addDisc(cx + elWX, cy + elY, cz + elWZ, r * 0.04, 12, palette.elevIndicator);

    // Glow ring around indicator
    const glowColor = [palette.elevIndicator[0], palette.elevIndicator[1], palette.elevIndicator[2], palette.elevIndicator[3] * 0.4];
    addRing(cx + elWX, cy + elY, cz + elWZ, r * 0.04, r * 0.055, 12, glowColor);

    return {
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      colors: new Float32Array(colors),
      indices: new Uint16Array(indices),
      indexCount: indices.length,
      vertexCount: positions.length / 3,
      useTriangles: true  // Flag to indicate this uses indexed triangles
    };
  }

  // Update buffers for a view
  updateBuffers(viewState, cx, cy, cz, r, use3D, viewTheta, viewPhi, bgColor) {
    const gl = this.gl;

    if (use3D) {
      const geom = this.buildGeometry3D(cx, cy, cz, r, viewTheta, viewPhi, bgColor);

      gl.bindBuffer(gl.ARRAY_BUFFER, viewState.positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, geom.positions, gl.DYNAMIC_DRAW);

      gl.bindBuffer(gl.ARRAY_BUFFER, viewState.normalBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, geom.normals, gl.DYNAMIC_DRAW);

      gl.bindBuffer(gl.ARRAY_BUFFER, viewState.colorBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, geom.colors, gl.DYNAMIC_DRAW);

      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, viewState.indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geom.indices, gl.DYNAMIC_DRAW);

      viewState.vertexCount = geom.vertexCount;
      viewState.indexCount = geom.indexCount;
      viewState.lineCount = geom.lineCount;

      viewState.lineData = {
        positions: geom.linePositions,
        normals: geom.lineNormals,
        colors: geom.lineColors
      };
    } else {
      const geom = this.buildGeometry2D(cx, cy, cz, r, viewTheta, viewPhi, bgColor);

      gl.bindBuffer(gl.ARRAY_BUFFER, viewState.positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, geom.positions, gl.DYNAMIC_DRAW);

      gl.bindBuffer(gl.ARRAY_BUFFER, viewState.normalBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, geom.normals, gl.DYNAMIC_DRAW);

      gl.bindBuffer(gl.ARRAY_BUFFER, viewState.colorBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, geom.colors, gl.DYNAMIC_DRAW);

      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, viewState.indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geom.indices, gl.DYNAMIC_DRAW);

      viewState.vertexCount = geom.vertexCount;
      viewState.indexCount = geom.indexCount;
      viewState.lineCount = 0;
      viewState.lineData = null;
    }

    viewState.needsRebuild = false;
  }

  // Draw the orbit anchor for a view
  draw(params) {
    const {
      viewId,
      viewTheta,
      viewPhi,
      viewTarget,
      viewRadius,
      pointBoundsRadius,
      bgColor,
      use3D,
      mvpMatrix,
      viewMatrix,
      modelMatrix,
      fogDensity,
      fogColor,
      lightingStrength,
      lightDir,
      navigationMode
    } = params;

    if (!this.showAnchor || navigationMode !== 'orbit') {
      return;
    }

    const gl = this.gl;
    const viewState = this.getViewState(viewId);

    const anchorRadius = this.computeAnchorRadius(pointBoundsRadius);

    // Check if rebuild needed
    const posChanged = viewTarget[0] !== viewState.lastX || viewTarget[1] !== viewState.lastY || viewTarget[2] !== viewState.lastZ;
    const sizeChanged = Math.abs(anchorRadius - (viewState.lastRadius || 0)) > 0.0005;
    const modeChanged = viewState.is3D !== use3D;
    const angleChanged = Math.abs(viewTheta - (viewState.lastTheta || 0)) > 0.01 || Math.abs(viewPhi - (viewState.lastPhi || 0)) > 0.01;

    const currentLuminance = bgColor[0] * 0.299 + bgColor[1] * 0.587 + bgColor[2] * 0.114;
    const bgChanged = Math.abs(currentLuminance - viewState.lastBgLuminance) > 0.1;

    if (viewState.needsRebuild || posChanged || sizeChanged || modeChanged || angleChanged || bgChanged || viewState.vertexCount === 0) {
      this.updateBuffers(viewState, viewTarget[0], viewTarget[1], viewTarget[2], anchorRadius, use3D, viewTheta, viewPhi, bgColor);
      viewState.lastX = viewTarget[0];
      viewState.lastY = viewTarget[1];
      viewState.lastZ = viewTarget[2];
      viewState.lastRadius = anchorRadius;
      viewState.lastTheta = viewTheta;
      viewState.lastPhi = viewPhi;
      viewState.lastBgLuminance = currentLuminance;
      viewState.is3D = use3D;

      if (use3D && viewState.lineData) {
        gl.bindBuffer(gl.ARRAY_BUFFER, viewState.linePositionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, viewState.lineData.positions, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, viewState.lineNormalBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, viewState.lineData.normals, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, viewState.lineColorBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, viewState.lineData.colors, gl.DYNAMIC_DRAW);
      }
    }

    if (viewState.vertexCount === 0) return;

    const fogNear = viewRadius * 0.2;
    const fogFar = viewRadius * 4.0;

    const camX = viewTarget[0] + viewRadius * Math.sin(viewTheta) * Math.cos(viewPhi);
    const camY = viewTarget[1] + viewRadius * Math.sin(viewPhi);
    const camZ = viewTarget[2] + viewRadius * Math.cos(viewTheta) * Math.cos(viewPhi);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    if (use3D) {
      gl.useProgram(this.program3D);
      gl.uniformMatrix4fv(this.uniforms3D.mvpMatrix, false, mvpMatrix);
      gl.uniformMatrix4fv(this.uniforms3D.viewMatrix, false, viewMatrix);
      gl.uniformMatrix4fv(this.uniforms3D.modelMatrix, false, modelMatrix);
      gl.uniform3f(this.uniforms3D.cameraPos, camX, camY, camZ);
      gl.uniform1f(this.uniforms3D.fogDensity, fogDensity);
      gl.uniform1f(this.uniforms3D.fogNear, fogNear);
      gl.uniform1f(this.uniforms3D.fogFar, fogFar);
      gl.uniform3fv(this.uniforms3D.fogColor, fogColor);
      gl.uniform1f(this.uniforms3D.lightingStrength, lightingStrength);
      gl.uniform3fv(this.uniforms3D.lightDir, lightDir);
      gl.uniform1f(this.uniforms3D.emissive, 0.15);

      gl.bindBuffer(gl.ARRAY_BUFFER, viewState.positionBuffer);
      gl.enableVertexAttribArray(this.attribs3D.position);
      gl.vertexAttribPointer(this.attribs3D.position, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, viewState.normalBuffer);
      gl.enableVertexAttribArray(this.attribs3D.normal);
      gl.vertexAttribPointer(this.attribs3D.normal, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, viewState.colorBuffer);
      gl.enableVertexAttribArray(this.attribs3D.color);
      gl.vertexAttribPointer(this.attribs3D.color, 4, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, viewState.indexBuffer);
      gl.drawElements(gl.TRIANGLES, viewState.indexCount, gl.UNSIGNED_SHORT, 0);

      if (viewState.lineCount > 0 && viewState.lineData) {
        gl.uniform1f(this.uniforms3D.emissive, 0.0);

        gl.bindBuffer(gl.ARRAY_BUFFER, viewState.linePositionBuffer);
        gl.vertexAttribPointer(this.attribs3D.position, 3, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, viewState.lineNormalBuffer);
        gl.vertexAttribPointer(this.attribs3D.normal, 3, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, viewState.lineColorBuffer);
        gl.vertexAttribPointer(this.attribs3D.color, 4, gl.FLOAT, false, 0, 0);

        gl.drawArrays(gl.LINES, 0, viewState.lineCount);
      }

      gl.disableVertexAttribArray(this.attribs3D.position);
      gl.disableVertexAttribArray(this.attribs3D.normal);
      gl.disableVertexAttribArray(this.attribs3D.color);
    } else {
      // 2D mode now uses triangles for thick, visible lines
      // Use the 3D program but with minimal lighting for flat appearance
      gl.useProgram(this.program3D);
      gl.uniformMatrix4fv(this.uniforms3D.mvpMatrix, false, mvpMatrix);
      gl.uniformMatrix4fv(this.uniforms3D.viewMatrix, false, viewMatrix);
      gl.uniformMatrix4fv(this.uniforms3D.modelMatrix, false, modelMatrix);
      gl.uniform3f(this.uniforms3D.cameraPos, camX, camY, camZ);
      gl.uniform1f(this.uniforms3D.fogDensity, fogDensity);
      gl.uniform1f(this.uniforms3D.fogNear, fogNear);
      gl.uniform1f(this.uniforms3D.fogFar, fogFar);
      gl.uniform3fv(this.uniforms3D.fogColor, fogColor);
      gl.uniform1f(this.uniforms3D.lightingStrength, 0.3);  // Subtle lighting for 2D
      gl.uniform3fv(this.uniforms3D.lightDir, lightDir);
      gl.uniform1f(this.uniforms3D.emissive, 0.4);  // Higher emissive for flatter look

      gl.bindBuffer(gl.ARRAY_BUFFER, viewState.positionBuffer);
      gl.enableVertexAttribArray(this.attribs3D.position);
      gl.vertexAttribPointer(this.attribs3D.position, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, viewState.normalBuffer);
      gl.enableVertexAttribArray(this.attribs3D.normal);
      gl.vertexAttribPointer(this.attribs3D.normal, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, viewState.colorBuffer);
      gl.enableVertexAttribArray(this.attribs3D.color);
      gl.vertexAttribPointer(this.attribs3D.color, 4, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, viewState.indexBuffer);
      gl.drawElements(gl.TRIANGLES, viewState.indexCount, gl.UNSIGNED_SHORT, 0);

      gl.disableVertexAttribArray(this.attribs3D.position);
      gl.disableVertexAttribArray(this.attribs3D.normal);
      gl.disableVertexAttribArray(this.attribs3D.color);
    }
  }

  setShowAnchor(show) {
    this.showAnchor = !!show;
    if (show) this.markAllNeedsRebuild();
  }

  getShowAnchor() {
    return this.showAnchor;
  }

  updateLabels() {}
}
