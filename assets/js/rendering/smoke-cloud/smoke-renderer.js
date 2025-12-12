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

export class SmokeRenderer {
  constructor(gl, createProgram) {
    this.gl = gl;

    // === PROGRAMS ===
    this.smokeProgram = createProgram(gl, SMOKE_VS_SOURCE, SMOKE_FS_SOURCE);
    this.compositeProgram = createProgram(gl, SMOKE_COMPOSITE_VS, SMOKE_COMPOSITE_FS);

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

    // Animation
    this.startTime = performance.now();
    this.frameIndex = 0;
  }

  // === VOLUME MANAGEMENT ===

  setVolume(volumeDesc) {
    const gl = this.gl;
    if (!volumeDesc || !volumeDesc.data) {
      this.textureInfo = null;
      return;
    }
    if (this.textureInfo?.texture) {
      gl.deleteTexture(this.textureInfo.texture);
    }
    this.textureInfo = createDensityTexture3D(gl, volumeDesc);
    console.log(`[SmokeRenderer] Created 3D density texture (${volumeDesc.gridSize}³)`);

    if (volumeDesc.boundsMin && volumeDesc.boundsMax) {
      this.volumeMin.set(volumeDesc.boundsMin);
      this.volumeMax.set(volumeDesc.boundsMax);
    } else {
      this.volumeMin.set([-1, -1, -1]);
      this.volumeMax.set([1, 1, 1]);
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
    if (!params) return;
    if (typeof params.density === 'number') this.density = params.density;
    if (typeof params.noiseScale === 'number') this.noiseScale = params.noiseScale;
    if (typeof params.warpStrength === 'number') this.warpStrength = params.warpStrength;
    if (typeof params.stepMultiplier === 'number') this.stepMultiplier = params.stepMultiplier;
    if (typeof params.animationSpeed === 'number') this.animationSpeed = params.animationSpeed;
    if (typeof params.detailLevel === 'number') this.detailLevel = params.detailLevel;
    if (typeof params.lightAbsorption === 'number') this.lightAbsorption = params.lightAbsorption;
    if (typeof params.scatterStrength === 'number') this.scatterStrength = params.scatterStrength;
    if (typeof params.edgeSoftness === 'number') this.edgeSoftness = params.edgeSoftness;
    if (typeof params.directLightIntensity === 'number') {
      this.directLight = Math.max(0.0, Math.min(2.0, params.directLightIntensity));
    }
    if (typeof params.lightSamples === 'number') {
      this.lightSamples = Math.max(1, Math.min(12, params.lightSamples));
    }
  }

  setResolutionScale(scale) {
    this.resolutionScale = Math.max(0.25, Math.min(2.0, scale));
    this.targetWidth = 0;
    this.targetHeight = 0;
  }

  getResolutionScale() {
    return this.resolutionScale;
  }

  setNoiseTextureResolution(size) {
    const prevScale = getResolutionScaleFactor();
    const newSize = Math.max(32, Math.min(256, size));
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
      console.log(`[SmokeRenderer] Noise resolution changed to ${newSize}³, will regenerate`);
    }
  }

  getNoiseTextureResolution() {
    return this.noiseResolution;
  }

  getAdaptiveScaleFactor() {
    return getResolutionScaleFactor();
  }

  // Backwards compatibility
  setHalfResolution(enabled) {
    this.resolutionScale = enabled ? 0.5 : 1.0;
    this.targetWidth = 0;
    this.targetHeight = 0;
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
    }
    this.targetWidth = 0;
    this.targetHeight = 0;
  }

  // === FRAMEBUFFER MANAGEMENT ===

  ensureRenderTarget(w, h) {
    const gl = this.gl;
    const scale = this.resolutionScale;
    const targetW = Math.max(1, Math.floor(w * scale));
    const targetH = Math.max(1, Math.floor(h * scale));

    if (this.framebuffer && targetW === this.targetWidth && targetH === this.targetHeight) {
      return;
    }

    if (this.framebuffer) {
      gl.deleteFramebuffer(this.framebuffer);
      gl.deleteTexture(this.colorTex);
    }

    this.targetWidth = targetW;
    this.targetHeight = targetH;

    this.colorTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.colorTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, targetW, targetH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.colorTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // === MAIN RENDER METHOD ===

  render({ invViewProjMatrix, eye, lightDir, bgColor, width, height }) {
    const gl = this.gl;

    if (!this.textureInfo) return;

    // Generate noise textures on first use (lazy initialization)
    if (!this.noiseTextures && !this.noiseGenerationInProgress) {
      this.noiseGenerationInProgress = true;
      console.log('[SmokeRenderer] Generating cloud noise textures...');

      generateCloudNoiseTextures(gl).then(textures => {
        this.noiseTextures = textures;
        this.noiseGenerationInProgress = false;
        console.log('[SmokeRenderer] Cloud noise textures ready');
      }).catch(err => {
        console.error('[SmokeRenderer] Failed to generate noise textures:', err);
        this.noiseGenerationInProgress = false;
      });

      // Show loading state
      gl.viewport(0, 0, width, height);
      gl.clearColor(bgColor[0], bgColor[1], bgColor[2], 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }

    // Still generating - show loading state
    if (!this.noiseTextures) {
      gl.viewport(0, 0, width, height);
      gl.clearColor(bgColor[0], bgColor[1], bgColor[2], 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT);
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
