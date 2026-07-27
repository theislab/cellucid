// SmokeRenderer - Volumetric Cloud Rendering Module
// =================================================
// Encapsulates all smoke/cloud rendering logic extracted from viewer.js
// Provides a clean API for volumetric cloud visualization

import { SMOKE_VS_SOURCE, SMOKE_FS_SOURCE, SMOKE_COMPOSITE_VS, SMOKE_COMPOSITE_FS } from '../shaders/smoke-shaders.js';
import { createDensityTexture3D, buildDensityVolumeGPU } from './smoke-density.js';
import {
  generateCloudNoiseTextures,
  setNoiseResolution,
  getResolutionScaleFactor,
} from './noise-textures.js';
import { getNotificationCenter } from '../../app/notification-center.js';

function requireFiniteNumber(value, owner, minimum = -Infinity, maximum = Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${owner} must be an exact finite number.`);
  }
  if (value < minimum || value > maximum) {
    throw new RangeError(
      `${owner} must be between ${minimum} and ${maximum}; received ${value}.`
    );
  }
  return value;
}

function requireVector3(value, owner) {
  if (
    !(Array.isArray(value) || value instanceof Float32Array) ||
    value.length !== 3 ||
    Array.from(value).some((entry) => !Number.isFinite(entry))
  ) {
    throw new TypeError(`${owner} must contain exactly three finite numbers.`);
  }
  return value;
}

function requireCleanWebGLState(gl, owner) {
  const errorCode = gl.getError();
  if (errorCode !== gl.NO_ERROR) {
    throw new Error(
      `${owner} encountered WebGL error 0x${errorCode.toString(16)}.`
    );
  }
}

export class SmokeRenderer {
  constructor(gl, createProgram) {
    if (!gl || typeof gl !== 'object') {
      throw new TypeError('SmokeRenderer requires a WebGL2 rendering context.');
    }
    if (typeof createProgram !== 'function') {
      throw new TypeError('SmokeRenderer requires the exact shader-program factory.');
    }
    this.gl = gl;

    // === PROGRAMS ===
    this.smokeProgram = createProgram(gl, SMOKE_VS_SOURCE, SMOKE_FS_SOURCE);
    this.compositeProgram = createProgram(gl, SMOKE_COMPOSITE_VS, SMOKE_COMPOSITE_FS);
    if (!this.smokeProgram || !this.compositeProgram) {
      throw new Error('SmokeRenderer shader program creation failed.');
    }

    // === ATTRIBUTE LOCATIONS ===
    this.smokeAttribLocations = {
      position: gl.getAttribLocation(this.smokeProgram, 'a_position'),
    };
    this.compositeAttribLocations = {
      position: gl.getAttribLocation(this.compositeProgram, 'a_position'),
    };

    // === UNIFORM LOCATIONS ===
    this.smokeUniformLocations = {
      invViewProj:       gl.getUniformLocation(this.smokeProgram, 'u_invViewProj'),
      cameraPos:         gl.getUniformLocation(this.smokeProgram, 'u_cameraPos'),
      volumeMin:         gl.getUniformLocation(this.smokeProgram, 'u_volumeMin'),
      volumeMax:         gl.getUniformLocation(this.smokeProgram, 'u_volumeMax'),
      densityTex3D:      gl.getUniformLocation(this.smokeProgram, 'u_densityTex3D'),
      gridSize:          gl.getUniformLocation(this.smokeProgram, 'u_gridSize'),
      shapeNoise:        gl.getUniformLocation(this.smokeProgram, 'u_shapeNoise'),
      detailNoise:       gl.getUniformLocation(this.smokeProgram, 'u_detailNoise'),
      blueNoise:         gl.getUniformLocation(this.smokeProgram, 'u_blueNoise'),
      blueNoiseOffset:   gl.getUniformLocation(this.smokeProgram, 'u_blueNoiseOffset'),
      bgColor:           gl.getUniformLocation(this.smokeProgram, 'u_bgColor'),
      smokeColor:        gl.getUniformLocation(this.smokeProgram, 'u_smokeColor'),
      lightDir:          gl.getUniformLocation(this.smokeProgram, 'u_lightDir'),
      time:              gl.getUniformLocation(this.smokeProgram, 'u_time'),
      animationSpeed:    gl.getUniformLocation(this.smokeProgram, 'u_animationSpeed'),
      densityMultiplier: gl.getUniformLocation(this.smokeProgram, 'u_densityMultiplier'),
      stepMultiplier:    gl.getUniformLocation(this.smokeProgram, 'u_stepMultiplier'),
      noiseScale:        gl.getUniformLocation(this.smokeProgram, 'u_noiseScale'),
      warpStrength:      gl.getUniformLocation(this.smokeProgram, 'u_warpStrength'),
      detailLevel:       gl.getUniformLocation(this.smokeProgram, 'u_detailLevel'),
      lightAbsorption:   gl.getUniformLocation(this.smokeProgram, 'u_lightAbsorption'),
      scatterStrength:   gl.getUniformLocation(this.smokeProgram, 'u_scatterStrength'),
      edgeSoftness:      gl.getUniformLocation(this.smokeProgram, 'u_edgeSoftness'),
      directLight:       gl.getUniformLocation(this.smokeProgram, 'u_directLightIntensity'),
      lightSamples:      gl.getUniformLocation(this.smokeProgram, 'u_lightSamples'),
    };
    this.compositeUniformLocations = {
      smokeTex:          gl.getUniformLocation(this.compositeProgram, 'u_smokeTex'),
      inverseResolution: gl.getUniformLocation(this.compositeProgram, 'u_inverseResolution'),
      intensity:         gl.getUniformLocation(this.compositeProgram, 'u_intensity'),
    };

    // === BUFFERS ===
    // Fullscreen triangle for smoke rendering
    this.quadBuffer = gl.createBuffer();
    if (!this.quadBuffer) {
      throw new Error('SmokeRenderer fullscreen-buffer allocation failed.');
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    // === STATE ===
    this.textureInfo = null;
    this.volumeMin = new Float32Array([-1, -1, -1]);
    this.volumeMax = new Float32Array([1, 1, 1]);

    // Tuned default values for visible, realistic volumetric clouds
    this.density = 8.0;
    this.noiseScale = getResolutionScaleFactor();
    this.warpStrength = 0.2;
    this.stepMultiplier = 2.8;
    this.animationSpeed = 1.0;
    this.detailLevel = 3.8;
    this.lightAbsorption = 1.5;
    this.scatterStrength = 0.0;
    this.edgeSoftness = 0.3;
    this.lightSamples = 6;
    this.directLight = 0.06;
    this.color = new Float32Array([0.98, 0.98, 1.0]);

    // Resolution scaling
    this.resolutionScale = 0.5;
    this.framebuffer = null;
    this.colorTex = null;
    this.targetWidth = 0;
    this.targetHeight = 0;

    // Noise textures
    this.noiseTextures = null;
    this.noiseResolution = 128;
    this.noiseGenerationInProgress = false;
    this.noiseGenerationError = null;

    // Animation
    this.startTime = performance.now();
    this.frameIndex = 0;
  }

  // === VOLUME MANAGEMENT ===

  setVolume(volumeDesc) {
    const gl = this.gl;
    if (
      volumeDesc === null ||
      typeof volumeDesc !== 'object' ||
      Array.isArray(volumeDesc) ||
      Object.getPrototypeOf(volumeDesc) !== Object.prototype ||
      Object.keys(volumeDesc).sort().join(',') !==
        'boundsMax,boundsMin,data,gridSize'
    ) {
      throw new TypeError(
        'SmokeRenderer volume descriptor must contain exactly boundsMax, boundsMin, data, and gridSize.'
      );
    }
    if (!(volumeDesc.data instanceof Float32Array)) {
      throw new TypeError('SmokeRenderer volume data must be a Float32Array.');
    }
    if (!Number.isInteger(volumeDesc.gridSize) || volumeDesc.gridSize < 8) {
      throw new RangeError(
        'SmokeRenderer volume gridSize must be an integer of at least 8.'
      );
    }
    const boundsMin = requireVector3(
      volumeDesc.boundsMin,
      'SmokeRenderer boundsMin'
    );
    const boundsMax = requireVector3(
      volumeDesc.boundsMax,
      'SmokeRenderer boundsMax'
    );
    for (let axis = 0; axis < 3; axis++) {
      if (boundsMin[axis] >= boundsMax[axis]) {
        throw new RangeError(
          `SmokeRenderer boundsMin[${axis}] must be smaller than boundsMax[${axis}].`
        );
      }
    }

    const nextTextureInfo = createDensityTexture3D(gl, volumeDesc);
    const previousTexture = this.textureInfo?.texture ?? null;
    this.textureInfo = nextTextureInfo;
    this.volumeMin.set(boundsMin);
    this.volumeMax.set(boundsMax);
    if (previousTexture) {
      gl.deleteTexture(previousTexture);
    }
    console.log(`[SmokeRenderer] Created 3D density texture (${volumeDesc.gridSize}³)`);
  }

  clearVolume() {
    const previousTexture = this.textureInfo?.texture ?? null;
    this.textureInfo = null;
    if (previousTexture) {
      this.gl.deleteTexture(previousTexture);
    }
  }

  buildVolumeGPU(positions, options = {}) {
    const volumeDesc = buildDensityVolumeGPU(this.gl, positions, options);
    this.setVolume(volumeDesc);
    return volumeDesc;
  }

  hasVolume() {
    return this.textureInfo !== null;
  }

  // === PARAMETER SETTERS ===

  setParams(params) {
    if (
      params === null ||
      typeof params !== 'object' ||
      Array.isArray(params) ||
      Object.getPrototypeOf(params) !== Object.prototype
    ) {
      throw new TypeError(
        'SmokeRenderer parameters must be one exact plain object.'
      );
    }
    const validators = {
      density: (value) => ['density', requireFiniteNumber(value, 'SmokeRenderer density', 0)],
      noiseScale: (value) => ['noiseScale', requireFiniteNumber(value, 'SmokeRenderer noiseScale', Number.MIN_VALUE)],
      warpStrength: (value) => ['warpStrength', requireFiniteNumber(value, 'SmokeRenderer warpStrength', 0)],
      stepMultiplier: (value) => ['stepMultiplier', requireFiniteNumber(value, 'SmokeRenderer stepMultiplier', Number.MIN_VALUE)],
      animationSpeed: (value) => ['animationSpeed', requireFiniteNumber(value, 'SmokeRenderer animationSpeed', 0)],
      detailLevel: (value) => ['detailLevel', requireFiniteNumber(value, 'SmokeRenderer detailLevel', 0)],
      lightAbsorption: (value) => ['lightAbsorption', requireFiniteNumber(value, 'SmokeRenderer lightAbsorption', 0)],
      scatterStrength: (value) => ['scatterStrength', requireFiniteNumber(value, 'SmokeRenderer scatterStrength', 0)],
      edgeSoftness: (value) => ['edgeSoftness', requireFiniteNumber(value, 'SmokeRenderer edgeSoftness', 0)],
      directLightIntensity: (value) => [
        'directLight',
        requireFiniteNumber(
          value,
          'SmokeRenderer directLightIntensity',
          0,
          2
        )
      ],
      lightSamples: (value) => {
        requireFiniteNumber(
          value,
          'SmokeRenderer lightSamples',
          1,
          12
        );
        if (!Number.isInteger(value)) {
          throw new TypeError(
            'SmokeRenderer lightSamples must be an integer.'
          );
        }
        return ['lightSamples', value];
      },
    };
    const staged = {};
    for (const [key, value] of Object.entries(params)) {
      const validate = validators[key];
      if (!validate) {
        throw new RangeError(`SmokeRenderer parameter "${key}" is unknown.`);
      }
      const [ownedKey, exactValue] = validate(value);
      staged[ownedKey] = exactValue;
    }
    Object.assign(this, staged);
  }

  setResolutionScale(scale) {
    this.resolutionScale = requireFiniteNumber(
      scale,
      'SmokeRenderer resolutionScale',
      0.25,
      2
    );
    this.targetWidth = 0;
    this.targetHeight = 0;
  }

  getResolutionScale() {
    return this.resolutionScale;
  }

  setNoiseTextureResolution(size) {
    requireFiniteNumber(size, 'SmokeRenderer noise resolution', 32, 256);
    if (!Number.isInteger(size)) {
      throw new TypeError('SmokeRenderer noise resolution must be an integer.');
    }
    const prevScale = getResolutionScaleFactor();
    const newSize = size;
    if (newSize !== this.noiseResolution) {
      this.noiseResolution = newSize;
      setNoiseResolution(newSize, newSize);
      const newScale = getResolutionScaleFactor();
      this.noiseScale *= newScale / prevScale;
      if (this.noiseTextures) {
        const gl = this.gl;
        if (this.noiseTextures.shape) gl.deleteTexture(this.noiseTextures.shape);
        if (this.noiseTextures.detail) gl.deleteTexture(this.noiseTextures.detail);
        if (this.noiseTextures.blueNoise) gl.deleteTexture(this.noiseTextures.blueNoise);
        this.noiseTextures = null;
      }
      this.noiseGenerationError = null;
      console.log(`[SmokeRenderer] Noise resolution changed to ${newSize}³, will regenerate`);
    }
  }

  getNoiseTextureResolution() {
    return this.noiseResolution;
  }

  getAdaptiveScaleFactor() {
    return getResolutionScaleFactor();
  }

  setQualityPreset(preset) {
    switch (preset) {
      case 'performance':
        this.stepMultiplier = 0.6;
        this.detailLevel = 1.0;
        this.lightSamples = 3;
        this.resolutionScale = 0.5;
        break;
      case 'balanced':
        this.stepMultiplier = 1.0;
        this.detailLevel = 2.0;
        this.lightSamples = 6;
        this.resolutionScale = 0.5;
        break;
      case 'quality':
        this.stepMultiplier = 1.5;
        this.detailLevel = 3.0;
        this.lightSamples = 8;
        this.resolutionScale = 1.0;
        break;
      case 'ultra':
        this.stepMultiplier = 2.0;
        this.detailLevel = 4.0;
        this.lightSamples = 12;
        this.resolutionScale = 1.0;
        break;
      default:
        throw new RangeError(
          'SmokeRenderer quality preset must be performance, balanced, quality, or ultra.'
        );
    }
    this.targetWidth = 0;
    this.targetHeight = 0;
  }

  // === FRAMEBUFFER MANAGEMENT ===

  ensureRenderTarget(w, h) {
    const gl = this.gl;
    requireFiniteNumber(w, 'SmokeRenderer target width', Number.MIN_VALUE);
    requireFiniteNumber(h, 'SmokeRenderer target height', Number.MIN_VALUE);
    const scale = this.resolutionScale;
    const targetW = Math.max(1, Math.floor(w * scale));
    const targetH = Math.max(1, Math.floor(h * scale));

    if (this.framebuffer && targetW === this.targetWidth && targetH === this.targetHeight) {
      return;
    }

    requireCleanWebGLState(gl, 'SmokeRenderer render-target publication');
    const previousFramebufferBinding =
      gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const previousTextureBinding =
      gl.getParameter(gl.TEXTURE_BINDING_2D);
    let candidateTexture = null;
    let candidateFramebuffer = null;
    try {
      candidateTexture = gl.createTexture();
      if (!candidateTexture) {
        throw new Error(
          'SmokeRenderer target texture allocation failed.'
        );
      }
      gl.bindTexture(gl.TEXTURE_2D, candidateTexture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        targetW,
        targetH,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null
      );
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MIN_FILTER,
        gl.LINEAR
      );
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MAG_FILTER,
        gl.LINEAR
      );
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_WRAP_S,
        gl.CLAMP_TO_EDGE
      );
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_WRAP_T,
        gl.CLAMP_TO_EDGE
      );

      candidateFramebuffer = gl.createFramebuffer();
      if (!candidateFramebuffer) {
        throw new Error(
          'SmokeRenderer framebuffer allocation failed.'
        );
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, candidateFramebuffer);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        candidateTexture,
        0
      );

      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        const statusNames = {
          [gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT]:
            'INCOMPLETE_ATTACHMENT',
          [gl.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT]:
            'INCOMPLETE_MISSING_ATTACHMENT',
          [gl.FRAMEBUFFER_INCOMPLETE_DIMENSIONS]:
            'INCOMPLETE_DIMENSIONS',
          [gl.FRAMEBUFFER_UNSUPPORTED]: 'UNSUPPORTED',
        };
        const statusName = Object.hasOwn(statusNames, status)
          ? statusNames[status]
          : `0x${status.toString(16)}`;
        throw new Error(
          `SmokeRenderer framebuffer is incomplete: ${statusName} (${targetW}x${targetH}).`
        );
      }
      requireCleanWebGLState(
        gl,
        'SmokeRenderer candidate render-target publication'
      );
    } catch (error) {
      gl.bindFramebuffer(
        gl.FRAMEBUFFER,
        previousFramebufferBinding
      );
      gl.bindTexture(gl.TEXTURE_2D, previousTextureBinding);
      if (candidateFramebuffer) {
        gl.deleteFramebuffer(candidateFramebuffer);
      }
      if (candidateTexture) gl.deleteTexture(candidateTexture);
      gl.getError();
      throw error;
    }

    const previousFramebuffer = this.framebuffer;
    const previousTexture = this.colorTex;
    this.framebuffer = candidateFramebuffer;
    this.colorTex = candidateTexture;
    this.targetWidth = targetW;
    this.targetHeight = targetH;

    gl.bindFramebuffer(
      gl.FRAMEBUFFER,
      previousFramebufferBinding === previousFramebuffer
        ? candidateFramebuffer
        : previousFramebufferBinding
    );
    gl.bindTexture(
      gl.TEXTURE_2D,
      previousTextureBinding === previousTexture
        ? candidateTexture
        : previousTextureBinding
    );
    if (previousFramebuffer) {
      gl.deleteFramebuffer(previousFramebuffer);
    }
    if (previousTexture) gl.deleteTexture(previousTexture);
  }

  // === MAIN RENDER METHOD ===

  render({ invViewProjMatrix, eye, lightDir, bgColor, width, height }) {
    const gl = this.gl;

    if (!this.textureInfo) return;

    if (this.noiseGenerationError) {
      throw this.noiseGenerationError;
    }

    // Generate noise textures on first use.
    if (!this.noiseTextures && !this.noiseGenerationInProgress) {
      this.noiseGenerationInProgress = true;
      console.log('[SmokeRenderer] Generating cloud noise textures...');

      let generation;
      try {
        generation = generateCloudNoiseTextures(gl);
      } catch (error) {
        this.noiseGenerationInProgress = false;
        this.noiseGenerationError = error;
        getNotificationCenter().error(
          `Smoke noise generation failed: ${error.message}`,
          { category: 'render' }
        );
        throw error;
      }
      generation.then((textures) => {
        if (
          !textures?.shape ||
          !textures.detail ||
          !textures.blueNoise
        ) {
          throw new Error(
            'Smoke noise generation did not publish the complete GPU texture set.'
          );
        }
        this.noiseTextures = textures;
        this.noiseGenerationInProgress = false;
        console.log('[SmokeRenderer] Cloud noise textures ready');
      }).catch((error) => {
        this.noiseGenerationInProgress = false;
        this.noiseGenerationError = error;
        getNotificationCenter().error(
          `Smoke noise generation failed: ${error.message}`,
          { category: 'render' }
        );
      });
      return;
    }

    // The existing scene remains visible while exact GPU noise generation finishes.
    if (!this.noiseTextures) {
      return;
    }

    gl.disable(gl.DEPTH_TEST);

    // Determine if we need an off-screen render target
    const needsOffscreen = this.resolutionScale !== 1.0;
    let targetW = width, targetH = height;

    if (needsOffscreen) {
      this.ensureRenderTarget(width, height);
      targetW = this.targetWidth;
      targetH = this.targetHeight;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      gl.viewport(0, 0, targetW, targetH);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }

    gl.useProgram(this.smokeProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(this.smokeAttribLocations.position);
    gl.vertexAttribPointer(this.smokeAttribLocations.position, 2, gl.FLOAT, false, 0, 0);

    // Camera and volume uniforms
    gl.uniformMatrix4fv(this.smokeUniformLocations.invViewProj, false, invViewProjMatrix);
    gl.uniform3fv(this.smokeUniformLocations.cameraPos, eye);
    gl.uniform3fv(this.smokeUniformLocations.volumeMin, this.volumeMin);
    gl.uniform3fv(this.smokeUniformLocations.volumeMax, this.volumeMax);
    gl.uniform1f(this.smokeUniformLocations.gridSize, this.textureInfo.gridSize);

    // Colors and lighting
    gl.uniform3fv(this.smokeUniformLocations.bgColor, bgColor);
    gl.uniform3fv(this.smokeUniformLocations.smokeColor, this.color);
    gl.uniform3fv(this.smokeUniformLocations.lightDir, lightDir);

    // Animation and quality parameters
    const timeSeconds = (performance.now() - this.startTime) * 0.001;
    gl.uniform1f(this.smokeUniformLocations.time, timeSeconds);
    gl.uniform1f(this.smokeUniformLocations.animationSpeed, this.animationSpeed);
    gl.uniform1f(this.smokeUniformLocations.densityMultiplier, this.density);
    gl.uniform1f(this.smokeUniformLocations.stepMultiplier, this.stepMultiplier);
    gl.uniform1f(this.smokeUniformLocations.noiseScale, this.noiseScale);
    gl.uniform1f(this.smokeUniformLocations.warpStrength, this.warpStrength);
    gl.uniform1f(this.smokeUniformLocations.detailLevel, this.detailLevel);
    gl.uniform1f(this.smokeUniformLocations.lightAbsorption, this.lightAbsorption);
    gl.uniform1f(this.smokeUniformLocations.scatterStrength, this.scatterStrength);
    gl.uniform1f(this.smokeUniformLocations.edgeSoftness, this.edgeSoftness);
    gl.uniform1f(this.smokeUniformLocations.directLight, this.directLight);
    gl.uniform1i(this.smokeUniformLocations.lightSamples, this.lightSamples);

    // Blue noise offset for temporal jittering (R2 sequence)
    this.frameIndex++;
    const phi = 1.618033988749895;
    const blueNoiseOffsetX = ((this.frameIndex * phi) % 1.0) * 128.0;
    const blueNoiseOffsetY = ((this.frameIndex * phi * phi) % 1.0) * 128.0;
    gl.uniform2f(this.smokeUniformLocations.blueNoiseOffset, blueNoiseOffsetX, blueNoiseOffsetY);

    // Bind textures
    // Texture unit 0: Density volume (3D texture)
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this.textureInfo.texture);
    gl.uniform1i(this.smokeUniformLocations.densityTex3D, 0);

    // Texture unit 1: Shape noise (3D texture)
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.noiseTextures.shape);
    gl.uniform1i(this.smokeUniformLocations.shapeNoise, 1);

    // Texture unit 2: Detail noise (3D texture)
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_3D, this.noiseTextures.detail);
    gl.uniform1i(this.smokeUniformLocations.detailNoise, 2);

    // Texture unit 3: Blue noise (2D texture)
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.noiseTextures.blueNoise);
    gl.uniform1i(this.smokeUniformLocations.blueNoise, 3);

    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Composite pass (upsampling) if needed
    if (needsOffscreen) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      gl.useProgram(this.compositeProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
      gl.enableVertexAttribArray(this.compositeAttribLocations.position);
      gl.vertexAttribPointer(this.compositeAttribLocations.position, 2, gl.FLOAT, false, 0, 0);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.colorTex);
      gl.uniform1i(this.compositeUniformLocations.smokeTex, 0);
      gl.uniform2f(this.compositeUniformLocations.inverseResolution, 1 / targetW, 1 / targetH);
      gl.uniform1f(this.compositeUniformLocations.intensity, 1.0);

      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // Restore default blend mode and re-enable depth test
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
  }

  // === CLEANUP ===

  dispose() {
    const gl = this.gl;

    if (this.textureInfo?.texture) {
      gl.deleteTexture(this.textureInfo.texture);
    }
    if (this.noiseTextures) {
      if (this.noiseTextures.shape) gl.deleteTexture(this.noiseTextures.shape);
      if (this.noiseTextures.detail) gl.deleteTexture(this.noiseTextures.detail);
      if (this.noiseTextures.blueNoise) gl.deleteTexture(this.noiseTextures.blueNoise);
    }
    if (this.framebuffer) {
      gl.deleteFramebuffer(this.framebuffer);
      gl.deleteTexture(this.colorTex);
    }
    if (this.quadBuffer) {
      gl.deleteBuffer(this.quadBuffer);
    }

    gl.deleteProgram(this.smokeProgram);
    gl.deleteProgram(this.compositeProgram);
  }
}
