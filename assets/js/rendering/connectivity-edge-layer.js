/**
 * Connectivity (KNN graph) edges: what each pane shows and how it is drawn.
 *
 * The graph stays on the CPU as the reader worker built it: its edges as
 * 12-byte records already in the fixed random order the panes show them in
 * (connectivity-edge-selection.js), and its adjacency (forward offsets,
 * neighbours) for the visible-cell walk and the count. A pane shows the first K of its visible edges; only
 * those K records reach the GPU, in buffers owned by the pane: the 12-byte
 * selection records (both endpoints' cells and the strength), and the
 * 28-byte instance records the draw reads (both endpoints' positions,
 * missing axes 0, and the strength), which a transform-feedback pass
 * gathers from the pane geometry's position texture (one texel a cell, held
 * once per geometry) by copying bits. So:
 *
 * - GPU memory is K x 40 bytes a pane plus one position texture a geometry,
 *   whatever the graph's size (a 110M-edge graph at the default K = 250,000
 *   costs 10 MB a pane); the CPU never gathers positions;
 * - the vertex shader tests nothing: hidden edges are never in the records;
 * - a camera move costs nothing; a filter or level-of-detail change
 *   re-selects, uploads K selection records and gathers on the GPU; a
 *   representation switch only gathers (and uploads the new geometry's
 *   position texture the first time).
 *
 * The visible-edge count (the slider's range) is known at once when the
 * selection walked the visible cells; otherwise it is counted over the
 * visible cells in time-boxed slices after the selection, so a filter change
 * never waits for it. `onVisibleCount` reports each pane's count when it is
 * known.
 */

import {
  configureStraightAlphaBlending,
  createProgram,
  createTransformFeedbackProgram,
  deleteProgramReleasingUse,
  deleteTextureTracked,
  drawPointsInSegments,
  restorableTexture,
} from './gl-utils.js';
import {
  allocateLinearTexture,
  planLinearTextureFor,
  setLinearLayoutUniform,
  writeLinearTextureRows,
} from './linear-texture.js';
import {
  EDGE_GATHER_FS_SOURCE,
  EDGE_GATHER_VARYINGS,
  EDGE_GATHER_VS_SOURCE,
  LINE_INSTANCED_FS_SOURCE,
  LINE_INSTANCED_VS_SOURCE,
} from './shaders/edge-grid-shaders.js';
import { writeFogUniforms } from './shaders/fog-shaders.js';
import {
  CONNECTIVITY_RECORD_WORDS,
  connectivityVisibleCells,
  countVisibleConnectivityEdges,
  createConnectivityEdgeIndex,
  createConnectivitySelectionScratch,
  requireConnectivityVisibility,
  selectConnectivityEdges,
} from './connectivity-edge-selection.js';

/** Bytes in one selection record: source cell, destination cell (uint32), strength (float32). */
export const CONNECTIVITY_RECORD_BYTES = CONNECTIVITY_RECORD_WORDS * Uint32Array.BYTES_PER_ELEMENT;
/** Floats in one instance record: source xyz, destination xyz, strength. */
export const CONNECTIVITY_INSTANCE_FLOATS = 7;
const INSTANCE_BYTES = CONNECTIVITY_INSTANCE_FLOATS * Float32Array.BYTES_PER_ELEMENT;

/**
 * Edges a newly published graph shows until the caller sets K: the edge
 * slider's starting value. GPU memory is 40 bytes an edge shown.
 */
export const CONNECTIVITY_DEFAULT_VISIBLE_TARGET = 250_000;
/** Longest a background count slice runs before it yields, in milliseconds. */
const SLICE_MS = 6;
/** Cells counted between two clock reads. */
const SLICE_CHECK_CELLS = 1 << 16;
/** Texture unit the position texture is bound to while edges draw. */
const POSITION_UNIT = 0;

function defaultSchedule(callback) {
  return setTimeout(callback, 0);
}

function defaultCancel(handle) {
  clearTimeout(handle);
}

/**
 * @param {object} options
 * @param {WebGL2RenderingContext} options.gl
 * @param {(viewId: string) => {positions: Float32Array, dimension: number, generation: number}} options.getViewGeometry
 *   The positions a pane draws, in source order (never written once
 *   published), and their geometry generation.
 * @param {(positions: Float32Array) => boolean} [options.retainsPositions]
 *   Whether the renderer still holds a geometry over these positions; their
 *   texture then outlives the last pane drawing them (a quick switch back
 *   uploads nothing).
 * @param {(viewId: string, stats: object) => void} [options.onVisibleCount]
 * @param {(callback: () => void) => unknown} [options.schedule]
 * @param {(handle: unknown) => void} [options.cancel]
 * @param {() => number} [options.now]
 */
export function createConnectivityEdgeLayer({
  gl,
  getViewGeometry,
  retainsPositions = () => false,
  onVisibleCount = () => {},
  schedule = defaultSchedule,
  cancel = defaultCancel,
  now = () => performance.now(),
}) {
  let program = createProgram(gl, LINE_INSTANCED_VS_SOURCE, LINE_INSTANCED_FS_SOURCE);
  const uniforms = {
    mvpMatrix: gl.getUniformLocation(program, 'u_mvpMatrix'),
    modelViewMatrix: gl.getUniformLocation(program, 'u_modelViewMatrix'),
    viewportSize: gl.getUniformLocation(program, 'u_viewportSize'),
    lineWidth: gl.getUniformLocation(program, 'u_lineWidth'),
    lineColor: gl.getUniformLocation(program, 'u_lineColor'),
    lineAlpha: gl.getUniformLocation(program, 'u_lineAlpha'),
    fogNear: gl.getUniformLocation(program, 'u_fogNear'),
    fogScale: gl.getUniformLocation(program, 'u_fogScale'),
  };
  let gatherProgram = createTransformFeedbackProgram(
    gl, EDGE_GATHER_VS_SOURCE, EDGE_GATHER_FS_SOURCE, EDGE_GATHER_VARYINGS
  );
  const gatherUniforms = {
    positions: gl.getUniformLocation(gatherProgram, 'u_positions'),
    positionsShape: gl.getUniformLocation(gatherProgram, 'u_positionsShape'),
  };
  let gatherFeedback = gl.createTransformFeedback();
  if (!gatherFeedback) throw new Error('Connectivity edges could not allocate their transform feedback.');
  // One 4-vertex triangle strip: (endpoint, side), endpoint -1 = source,
  // +1 = destination; side -1 = left, +1 = right.
  let quadBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  /** @type {null|ReturnType<typeof createConnectivityEdgeIndex>} */
  let graph = null;
  let target = 0;
  const views = new Map();
  const scratch = createConnectivitySelectionScratch();
  /** Position textures by the positions they hold: {texture, plan, bytes, views: Set<string>}. */
  const positionTextures = new Map();

  function requireGraph(label) {
    if (graph === null) throw new Error(`${label} requires a published connectivity graph.`);
    return graph;
  }

  function createView() {
    return {
      visibility: null, // null: every cell visible
      revision: 1,
      mask: null,
      maskRevision: 1, // the null visibility's mask is null
      maskScratch: null,
      records: new Uint32Array(0),
      shownCount: 0,
      selectedRevision: 0,
      selectedTarget: -1,
      selectionGeneration: 0,
      uploadedGeneration: -1,
      gatheredGeneration: -1,
      gatheredPositions: null,
      recordBuffer: null,
      recordBytes: 0,
      gatherVao: null,
      instanceBuffer: null,
      instanceBytes: 0,
      drawVao: null,
      positions: null,
      visibleCount: null,
      countedRevision: 0,
      reportedRevision: 0,
      countJob: null,
    };
  }

  function deletePositionTexture(positions, entry) {
    positionTextures.delete(positions);
    deleteTextureTracked(gl, entry.texture);
  }

  function releasePositions(viewId, view) {
    const positions = view.positions;
    view.positions = null;
    if (positions === null) return;
    const entry = positionTextures.get(positions);
    if (entry === undefined) return;
    entry.views.delete(viewId);
    if (entry.views.size === 0 && !retainsPositions(positions)) deletePositionTexture(positions, entry);
  }

  /** Delete the textures no pane draws whose geometry the renderer let go. */
  function prunePositionTextures() {
    for (const [positions, entry] of positionTextures) {
      if (entry.views.size === 0 && !retainsPositions(positions)) deletePositionTexture(positions, entry);
    }
  }

  function forgetViewGl(view) {
    view.gatherVao = null;
    view.drawVao = null;
    view.recordBuffer = null;
    view.instanceBuffer = null;
    view.recordBytes = 0;
    view.instanceBytes = 0;
    view.uploadedGeneration = -1;
    view.gatheredGeneration = -1;
    view.gatheredPositions = null;
  }

  function releaseViewGl(viewId, view) {
    if (view.gatherVao !== null) gl.deleteVertexArray(view.gatherVao);
    if (view.drawVao !== null) gl.deleteVertexArray(view.drawVao);
    if (view.recordBuffer !== null) gl.deleteBuffer(view.recordBuffer);
    if (view.instanceBuffer !== null) gl.deleteBuffer(view.instanceBuffer);
    forgetViewGl(view);
    releasePositions(viewId, view);
  }

  function cancelCount(view) {
    if (view.countJob !== null) {
      cancel(view.countJob.handle);
      view.countJob = null;
    }
  }

  function describe(viewId, view) {
    return Object.freeze({
      viewId,
      current: view.selectedRevision === view.revision && view.selectedTarget === target,
      shownCount: view.shownCount,
      visibleCount: view.countedRevision === view.revision ? view.visibleCount : null,
      visibilityRevision: view.revision,
    });
  }

  function maskOf(view) {
    if (view.maskRevision !== view.revision) {
      const cells = connectivityVisibleCells(view.visibility, view.maskScratch);
      view.mask = cells.mask;
      view.maskScratch = cells.scratch;
      view.maskRevision = view.revision;
    }
    return view.mask;
  }

  function setCount(view, revision, count) {
    view.visibleCount = count;
    view.countedRevision = revision;
  }

  /** Report a pane's count once it is known; count it first, in slices, if it is not. */
  function startCount(viewId, view) {
    cancelCount(view);
    const current = graph;
    const revision = view.revision;
    const job = { handle: null, cell: 0, count: 0 };
    const step = () => {
      if (view.countJob !== job || graph !== current || view.revision !== revision) return;
      if (view.countedRevision !== revision) {
        const mask = maskOf(view);
        if (mask === null) {
          setCount(view, revision, current.edgeCount);
        } else {
          const deadline = now() + SLICE_MS;
          while (job.cell < current.cellCount && now() < deadline) {
            const end = Math.min(current.cellCount, job.cell + SLICE_CHECK_CELLS);
            job.count += countVisibleConnectivityEdges(current, mask, job.cell, end);
            job.cell = end;
          }
          if (job.cell < current.cellCount) {
            job.handle = schedule(step);
            return;
          }
          setCount(view, revision, job.count);
        }
      }
      view.countJob = null;
      view.reportedRevision = revision;
      onVisibleCount(viewId, describe(viewId, view));
    };
    view.countJob = job;
    job.handle = schedule(step);
  }

  function select(view) {
    const current = requireGraph('Connectivity selection');
    const wanted = Math.min(target, current.edgeCount);
    if (view.records.length < wanted * CONNECTIVITY_RECORD_WORDS) {
      view.records = new Uint32Array(wanted * CONNECTIVITY_RECORD_WORDS);
    }
    const selection = selectConnectivityEdges(current, maskOf(view), wanted, view.records, scratch);
    view.shownCount = selection.shown;
    if (selection.visibleCount !== null) setCount(view, view.revision, selection.visibleCount);
    view.selectedRevision = view.revision;
    view.selectedTarget = target;
    view.selectionGeneration += 1;
  }

  /** Grow a pane buffer to `bytes`, checking the allocation once. */
  function allocate(buffer, bytes, label) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, bytes, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    const error = gl.getError();
    if (error !== gl.NO_ERROR) {
      throw new Error(`Connectivity edges could not allocate ${bytes} bytes of ${label} (WebGL error 0x${error.toString(16)}).`);
    }
  }

  function createViewGl(view) {
    view.recordBuffer = gl.createBuffer();
    view.instanceBuffer = gl.createBuffer();
    view.gatherVao = gl.createVertexArray();
    view.drawVao = gl.createVertexArray();
    if (!view.recordBuffer || !view.instanceBuffer || !view.gatherVao || !view.drawVao) {
      throw new Error('Connectivity edges could not allocate their instance buffers.');
    }
    // The gather reads one selection record a point.
    gl.bindVertexArray(view.gatherVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, view.recordBuffer);
    for (let word = 0; word < CONNECTIVITY_RECORD_WORDS; word++) {
      gl.enableVertexAttribArray(word);
      gl.vertexAttribIPointer(word, 1, gl.UNSIGNED_INT, CONNECTIVITY_RECORD_BYTES, word * 4);
    }
    // The draw reads one instance record an instance.
    gl.bindVertexArray(view.drawVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, view.instanceBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, INSTANCE_BYTES, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, INSTANCE_BYTES, 12);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, INSTANCE_BYTES, 24);
    gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  /** Upload a pane's selection records. */
  function upload(view) {
    if (view.recordBuffer === null) createViewGl(view);
    const count = view.shownCount;
    if (count * INSTANCE_BYTES > view.instanceBytes) {
      // Grow to the target's full size at once, so a shrinking or regrowing
      // selection rewrites in place.
      const capacity = Math.max(count, Math.min(target, graph.edgeCount));
      allocate(view.recordBuffer, capacity * CONNECTIVITY_RECORD_BYTES, 'selection records');
      view.recordBytes = capacity * CONNECTIVITY_RECORD_BYTES;
      allocate(view.instanceBuffer, capacity * INSTANCE_BYTES, 'instance records');
      view.instanceBytes = capacity * INSTANCE_BYTES;
    }
    if (count > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, view.recordBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, view.records, 0, count * CONNECTIVITY_RECORD_WORDS);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
    view.uploadedGeneration = view.selectionGeneration;
  }

  /**
   * Write a pane's instance records from its selection records and its
   * geometry's position texture: one transform-feedback point an edge,
   * every word copied as bits.
   */
  function gather(view, positions, positionTexture) {
    gl.useProgram(gatherProgram);
    gl.activeTexture(gl.TEXTURE0 + POSITION_UNIT);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, positionTexture.texture);
    gl.uniform1i(gatherUniforms.positions, POSITION_UNIT);
    setLinearLayoutUniform(gl, gatherUniforms.positionsShape, positionTexture.plan);
    gl.bindVertexArray(view.gatherVao);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, gatherFeedback);
    gl.bindBufferRange(gl.TRANSFORM_FEEDBACK_BUFFER, 0, view.instanceBuffer, 0, view.shownCount * INSTANCE_BYTES);
    gl.enable(gl.RASTERIZER_DISCARD);
    gl.beginTransformFeedback(gl.POINTS);
    try {
      drawPointsInSegments(gl, 0, view.shownCount);
    } finally {
      gl.endTransformFeedback();
      gl.disable(gl.RASTERIZER_DISCARD);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
      gl.bindVertexArray(null);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    }
    view.gatheredGeneration = view.selectionGeneration;
    view.gatheredPositions = positions;
  }

  /** The position texture of a pane's geometry, uploaded the first time any pane draws it. */
  function positionTextureFor(viewId, view, geometry) {
    const { positions, dimension } = geometry;
    if (view.positions !== positions) {
      releasePositions(viewId, view);
      prunePositionTextures();
    }
    let entry = positionTextures.get(positions);
    if (entry === undefined) {
      const plan = planLinearTextureFor(gl, graph.cellCount);
      const internalFormat = dimension === 1 ? gl.R32F : dimension === 2 ? gl.RG32F : gl.RGB32F;
      const format = dimension === 1 ? gl.RED : dimension === 2 ? gl.RG : gl.RGB;
      const texture = gl.createTexture();
      if (!texture) throw new Error('Connectivity edges could not allocate a position texture.');
      const previousUnit = gl.getParameter(gl.ACTIVE_TEXTURE);
      const previousAlignment = gl.getParameter(gl.UNPACK_ALIGNMENT);
      const previousUnpackBuffer = gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING);
      gl.activeTexture(gl.TEXTURE0 + POSITION_UNIT);
      const previousTexture = gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY);
      let error;
      try {
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
        gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        allocateLinearTexture(gl, internalFormat, plan);
        writeLinearTextureRows(gl, plan, format, gl.FLOAT, positions, dimension);
        error = gl.getError();
      } finally {
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, restorableTexture(previousTexture));
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, previousAlignment);
        gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, previousUnpackBuffer);
        gl.activeTexture(previousUnit);
      }
      if (error !== gl.NO_ERROR) {
        deleteTextureTracked(gl, texture);
        throw new Error(
          `Connectivity edges could not upload a ${graph.cellCount}-cell position texture (WebGL error 0x${error.toString(16)}).`
        );
      }
      entry = {
        texture,
        plan,
        bytes: plan.texels * dimension * Float32Array.BYTES_PER_ELEMENT,
        views: new Set(),
      };
      positionTextures.set(positions, entry);
    }
    entry.views.add(viewId);
    view.positions = positions;
    return entry;
  }

  return {
    /**
     * Publish a graph (`ConnectivityEdges`, built by the reader worker).
     * Its arrays are kept by reference, as loaded: the records arrive in
     * draw order.
     */
    setGraph(edges) {
      const index = createConnectivityEdgeIndex(edges);
      this.clear();
      graph = index;
      // The default K until the caller sets one (`setVisibleTarget`).
      target = Math.min(index.edgeCount, CONNECTIVITY_DEFAULT_VISIBLE_TARGET);
      return true;
    },
    hasGraph() {
      return graph !== null;
    },
    getEdgeCount() {
      return graph?.edgeCount ?? 0;
    },
    getCellCount() {
      return graph?.cellCount ?? 0;
    },
    getVisibleTarget() {
      return target;
    },
    /** Add a pane (every cell visible until its visibility is published). */
    addView(viewId) {
      requireGraph('Connectivity pane');
      const existing = views.get(viewId);
      if (existing !== undefined) {
        cancelCount(existing);
        releaseViewGl(viewId, existing);
      }
      views.set(viewId, createView());
      return true;
    },
    hasView(viewId) {
      return views.has(viewId);
    },
    getViewIds() {
      return Array.from(views.keys());
    },
    deleteView(viewId) {
      const view = views.get(viewId);
      if (view === undefined) return false;
      cancelCount(view);
      releaseViewGl(viewId, view);
      views.delete(viewId);
      return true;
    },
    /**
     * Publish a pane's endpoint visibility (null: every cell). The arrays are
     * read when the pane re-selects and while its count runs; a newer
     * publication supersedes both.
     */
    publishVisibility(viewId, visibility) {
      const current = requireGraph('Connectivity visibility');
      const view = views.get(viewId);
      if (view === undefined) return false;
      view.visibility = visibility === null ? null : requireConnectivityVisibility(visibility, current.cellCount);
      view.revision += 1;
      cancelCount(view);
      return true;
    },
    /** Re-select a pane's shown edges if its visibility or K moved; report its count. */
    refresh(viewId) {
      requireGraph('Connectivity refresh');
      const view = views.get(viewId);
      if (view === undefined) return null;
      if (view.selectedRevision !== view.revision || view.selectedTarget !== target) {
        select(view);
      }
      if (view.reportedRevision !== view.revision && view.countJob === null) {
        startCount(viewId, view);
      }
      return describe(viewId, view);
    },
    /** Show the first `next` visible edges in every pane. */
    setVisibleTarget(next) {
      const current = requireGraph('Connectivity edge target');
      if (!Number.isSafeInteger(next) || next < 0 || next > current.edgeCount) {
        throw new RangeError(`Connectivity edge target must be an integer in [0, ${current.edgeCount}].`);
      }
      target = next;
      for (const view of views.values()) {
        if (view.selectedTarget !== target || view.selectedRevision !== view.revision) select(view);
      }
      return true;
    },
    getStats(viewId) {
      const view = views.get(viewId);
      return view === undefined ? null : describe(viewId, view);
    },
    /**
     * Draw a pane's shown edges. Uploads its records first when its
     * selection changed since the last upload, and its geometry's positions
     * the first time a pane draws them.
     */
    draw(viewId, frame) {
      const view = views.get(viewId);
      if (graph === null || view === undefined) return 0;
      // A pane added or re-published since its last selection selects now.
      if (view.selectedRevision !== view.revision || view.selectedTarget !== target) {
        select(view);
      }
      if (view.shownCount === 0) return 0;
      const geometry = getViewGeometry(viewId);
      if (geometry.positions.length !== graph.cellCount * geometry.dimension) {
        throw new RangeError(`Connectivity positions of view "${viewId}" do not match the graph's cell count.`);
      }
      const positionTexture = positionTextureFor(viewId, view, geometry);
      if (view.uploadedGeneration !== view.selectionGeneration) upload(view);
      if (
        view.gatheredGeneration !== view.selectionGeneration ||
        view.gatheredPositions !== geometry.positions
      ) {
        gather(view, geometry.positions, positionTexture);
      }
      gl.useProgram(program);
      configureStraightAlphaBlending(gl);
      gl.uniformMatrix4fv(uniforms.mvpMatrix, false, frame.mvpMatrix);
      gl.uniformMatrix4fv(uniforms.modelViewMatrix, false, frame.modelViewMatrix);
      gl.uniform2f(uniforms.viewportSize, frame.widthPx, frame.heightPx);
      gl.uniform1f(uniforms.lineWidth, frame.lineWidth);
      gl.uniform3fv(uniforms.lineColor, frame.lineColor);
      gl.uniform1f(uniforms.lineAlpha, frame.lineAlpha);
      writeFogUniforms(gl, uniforms.fogNear, uniforms.fogScale, frame.fogDensity, frame.fogNear, frame.fogFar);
      gl.bindVertexArray(view.drawVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, view.shownCount);
      gl.bindVertexArray(null);
      return view.shownCount;
    },
    /** GPU and CPU bytes this layer holds, by pane. */
    describeMemory() {
      const panes = [];
      let recordBytes = 0;
      for (const [viewId, view] of views) {
        recordBytes += view.recordBytes + view.instanceBytes;
        panes.push(Object.freeze({
          viewId,
          gpuBytes: view.recordBytes + view.instanceBytes,
          cpuBytes: view.records.byteLength,
          shownCount: view.shownCount,
        }));
      }
      let positionTextureBytes = 0;
      for (const entry of positionTextures.values()) positionTextureBytes += entry.bytes;
      return Object.freeze({
        graphBytes: graph === null ? 0
          : graph.records.byteLength + graph.forwardOffsets.byteLength +
            graph.neighborOffsets.byteLength + graph.neighbors.byteLength,
        gpuBytes: recordBytes + positionTextureBytes,
        positionTextureBytes,
        panes: Object.freeze(panes),
        visibleTarget: target,
      });
    },
    /** Drop the graph, every pane's GPU records and every position texture. */
    clear() {
      for (const [viewId, view] of views) {
        cancelCount(view);
        releaseViewGl(viewId, view);
      }
      views.clear();
      for (const [positions, entry] of positionTextures) deletePositionTexture(positions, entry);
      graph = null;
      target = 0;
    },
    dispose() {
      this.clear();
      if (quadBuffer !== null) gl.deleteBuffer(quadBuffer);
      deleteProgramReleasingUse(gl, program);
      deleteProgramReleasingUse(gl, gatherProgram);
      if (gatherFeedback !== null) gl.deleteTransformFeedback(gatherFeedback);
      quadBuffer = null;
      program = null;
      gatherProgram = null;
      gatherFeedback = null;
    },
    /** Forget every GL handle without deleting it (the context was lost). */
    abandon() {
      for (const view of views.values()) {
        cancelCount(view);
        forgetViewGl(view);
        view.positions = null;
      }
      views.clear();
      positionTextures.clear();
      graph = null;
      quadBuffer = null;
      program = null;
      gatherProgram = null;
      gatherFeedback = null;
    },
  };
}
