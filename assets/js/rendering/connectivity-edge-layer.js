/**
 * Connectivity (KNN graph) edges: what each pane shows and how it is drawn.
 *
 * The graph stays on the CPU exactly as loaded (Uint32 endpoints in storage
 * order, one Float32 relative strength an edge). A pane shows the first K of
 * its visible edges in one fixed stateless random order
 * (connectivity-edge-selection.js); only those K edges reach the GPU, as one
 * instance record each -- both endpoints' positions (missing axes 0) and the
 * edge's strength, 28 bytes -- in a buffer owned by the pane. So:
 *
 * - GPU memory is K x 28 bytes a pane, whatever the graph's size (a 110M-edge
 *   graph at the default K = 250,000 costs 7 MB a pane, where per-edge
 *   textures cost 12 bytes an edge plus a position texture a geometry and a
 *   visibility texture a pane);
 * - the vertex shader fetches nothing and tests nothing: hidden edges are
 *   never in the records;
 * - a camera move costs nothing; a filter or level-of-detail change re-selects
 *   (O(K / visible fraction)) and re-gathers K records; a representation
 *   switch re-gathers only.
 *
 * Counting every visible edge (the slider's range) is one pass over the
 * graph. It runs in time-boxed slices after the selection, so a filter change
 * never waits for it; `onVisibleCount` reports each pane's count when it is
 * known.
 */

import {
  configureStraightAlphaBlending,
  createProgram,
} from './gl-utils.js';
import {
  LINE_INSTANCED_FS_SOURCE,
  LINE_INSTANCED_VS_SOURCE,
} from './shaders/edge-grid-shaders.js';
import { writeFogUniforms } from './shaders/fog-shaders.js';
import { createConnectivityRenderWeights } from './connectivity-weights.js';
import {
  countVisibleConnectivityEdges,
  createConnectivityEdgeOrder,
  isEveryConnectivityCellVisible,
  requireConnectivityVisibility,
  selectVisibleConnectivityEdges,
} from './connectivity-edge-selection.js';

/** Floats in one instance record: source xyz, destination xyz, strength. */
export const CONNECTIVITY_INSTANCE_FLOATS = 7;

/**
 * Edges a newly published graph shows until the caller sets K: the edge
 * slider's starting value. GPU memory is 28 bytes an edge shown.
 */
export const CONNECTIVITY_DEFAULT_VISIBLE_TARGET = 250_000;
const INSTANCE_BYTES = CONNECTIVITY_INSTANCE_FLOATS * Float32Array.BYTES_PER_ELEMENT;
/** Longest a counting slice runs before it yields, in milliseconds. */
const COUNT_SLICE_MS = 6;
/** Edges counted between two clock reads. */
const COUNT_CHECK_EDGES = 1 << 20;

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
 *   The positions a pane draws, in source order, and their geometry generation.
 * @param {(viewId: string, stats: object) => void} [options.onVisibleCount]
 * @param {(callback: () => void) => unknown} [options.schedule]
 * @param {(handle: unknown) => void} [options.cancel]
 * @param {() => number} [options.now]
 */
export function createConnectivityEdgeLayer({
  gl,
  getViewGeometry,
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
  // One 4-vertex triangle strip: (endpoint, side), endpoint -1 = source,
  // +1 = destination; side -1 = left, +1 = right.
  let quadBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  /** @type {null|{sources: Uint32Array, destinations: Uint32Array, strength: Float32Array, edgeCount: number, cellCount: number, order: object}} */
  let graph = null;
  let target = 0;
  const views = new Map();

  function requireGraph(label) {
    if (graph === null) throw new Error(`${label} requires a published connectivity graph.`);
    return graph;
  }

  function createView() {
    return {
      visibility: null, // null: every cell visible
      revision: 1,
      selection: new Uint32Array(0),
      selectedCount: 0,
      selectedRevision: 0,
      selectedTarget: -1,
      selectionGeneration: 0,
      gatheredSelection: -1,
      gatheredGeometry: -1,
      gatheredPositions: null,
      records: new Float32Array(0),
      buffer: null,
      bufferBytes: 0,
      vao: null,
      visibleCount: null,
      countedRevision: 0,
      countJob: null,
    };
  }

  function releaseViewGl(view) {
    if (view.vao !== null) gl.deleteVertexArray(view.vao);
    if (view.buffer !== null) gl.deleteBuffer(view.buffer);
    view.vao = null;
    view.buffer = null;
    view.bufferBytes = 0;
    view.gatheredSelection = -1;
    view.gatheredGeometry = -1;
    view.gatheredPositions = null;
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
      shownCount: view.selectedCount,
      visibleCount: view.countedRevision === view.revision ? view.visibleCount : null,
      visibilityRevision: view.revision,
    });
  }

  function startCount(viewId, view) {
    cancelCount(view);
    const current = graph;
    const visibility = view.visibility;
    const revision = view.revision;
    if (visibility === null) {
      view.visibleCount = current.edgeCount;
      view.countedRevision = revision;
      return;
    }
    const job = { handle: null, position: -1, count: 0 };
    const step = () => {
      if (view.countJob !== job || graph !== current || view.revision !== revision) return;
      const deadline = now() + COUNT_SLICE_MS;
      if (job.position < 0) {
        // Every cell visible: every edge is, with no pass over the edges.
        if (isEveryConnectivityCellVisible(visibility)) {
          job.count = current.edgeCount;
          job.position = current.edgeCount;
        } else {
          job.position = 0;
        }
      }
      while (job.position < current.edgeCount && now() < deadline) {
        const end = Math.min(current.edgeCount, job.position + COUNT_CHECK_EDGES);
        job.count += countVisibleConnectivityEdges(
          current.sources, current.destinations, visibility, job.position, end
        );
        job.position = end;
      }
      if (job.position < current.edgeCount) {
        job.handle = schedule(step);
        return;
      }
      view.countJob = null;
      view.visibleCount = job.count;
      view.countedRevision = revision;
      onVisibleCount(viewId, describe(viewId, view));
    };
    view.countJob = job;
    job.handle = schedule(step);
  }

  function select(viewId, view) {
    const current = requireGraph('Connectivity selection');
    const wanted = Math.min(target, current.edgeCount);
    if (view.selection.length < wanted) view.selection = new Uint32Array(wanted);
    if (view.visibility === null) {
      for (let index = 0; index < wanted; index++) view.selection[index] = current.order.at(index);
      view.selectedCount = wanted;
    } else {
      view.selectedCount = selectVisibleConnectivityEdges(
        current.order, current.sources, current.destinations, view.visibility, wanted, view.selection
      );
    }
    view.selectedRevision = view.revision;
    view.selectedTarget = target;
    view.selectionGeneration += 1;
  }

  function gather(view, geometry) {
    const current = graph;
    const count = view.selectedCount;
    const floats = count * CONNECTIVITY_INSTANCE_FLOATS;
    if (view.records.length < floats) view.records = new Float32Array(Math.max(floats, view.records.length * 2));
    const records = view.records;
    const { positions, dimension } = geometry;
    const { sources, destinations, strength } = current;
    const selection = view.selection;
    for (let index = 0; index < count; index++) {
      const edge = selection[index];
      const out = index * CONNECTIVITY_INSTANCE_FLOATS;
      const source = sources[edge] * dimension;
      const destination = destinations[edge] * dimension;
      // Copied bytes: the endpoints are the pane's own float32 positions.
      records[out] = positions[source];
      records[out + 1] = dimension > 1 ? positions[source + 1] : 0;
      records[out + 2] = dimension > 2 ? positions[source + 2] : 0;
      records[out + 3] = positions[destination];
      records[out + 4] = dimension > 1 ? positions[destination + 1] : 0;
      records[out + 5] = dimension > 2 ? positions[destination + 2] : 0;
      records[out + 6] = strength[edge];
    }
    if (view.buffer === null) {
      view.buffer = gl.createBuffer();
      view.vao = gl.createVertexArray();
      if (!view.buffer || !view.vao) throw new Error('Connectivity edges could not allocate their instance buffer.');
      gl.bindVertexArray(view.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, view.buffer);
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
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, view.buffer);
    const bytes = count * INSTANCE_BYTES;
    if (bytes > view.bufferBytes) {
      // Grow to the target's full size at once, so a shrinking or regrowing
      // selection rewrites in place.
      const capacity = Math.max(bytes, Math.min(target, current.edgeCount) * INSTANCE_BYTES);
      gl.bufferData(gl.ARRAY_BUFFER, capacity, gl.DYNAMIC_DRAW);
      const error = gl.getError();
      if (error !== gl.NO_ERROR) {
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        releaseViewGl(view);
        throw new Error(`Connectivity edges could not allocate ${capacity} bytes (WebGL error 0x${error.toString(16)}).`);
      }
      view.bufferBytes = capacity;
    }
    if (count > 0) gl.bufferSubData(gl.ARRAY_BUFFER, 0, records, 0, floats);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    view.gatheredSelection = view.selectionGeneration;
    view.gatheredGeometry = geometry.generation;
    view.gatheredPositions = positions;
  }

  return {
    /**
     * Publish a graph. Endpoints are kept by reference, as loaded; the
     * Float64 weights are read once into Float32 relative strengths and not
     * retained.
     */
    setGraph({ sources, destinations, weights, nEdges, nCells }) {
      if (
        !(sources instanceof Uint32Array) ||
        !(destinations instanceof Uint32Array) ||
        !(weights instanceof Float64Array) ||
        !Number.isSafeInteger(nEdges) || nEdges < 0 ||
        !Number.isSafeInteger(nCells) || nCells <= 0 ||
        sources.length !== nEdges || destinations.length !== nEdges || weights.length !== nEdges
      ) {
        throw new TypeError(
          'Connectivity edges need Uint32 endpoints and Float64 weights, one of each an edge, and a positive cell count.'
        );
      }
      const strength = createConnectivityRenderWeights(weights).values;
      this.clear();
      graph = Object.freeze({
        sources,
        destinations,
        strength,
        edgeCount: nEdges,
        cellCount: nCells,
        order: createConnectivityEdgeOrder(nEdges),
      });
      // The default K until the caller sets one (`setVisibleTarget`).
      target = Math.min(nEdges, CONNECTIVITY_DEFAULT_VISIBLE_TARGET);
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
        releaseViewGl(existing);
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
      releaseViewGl(view);
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
    /** Re-select a pane's shown edges if its visibility or K moved; start its count. */
    refresh(viewId) {
      requireGraph('Connectivity refresh');
      const view = views.get(viewId);
      if (view === undefined) return null;
      if (view.selectedRevision !== view.revision || view.selectedTarget !== target) {
        select(viewId, view);
      }
      if (view.countedRevision !== view.revision && view.countJob === null) {
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
      for (const [viewId, view] of views) {
        if (view.selectedTarget !== target || view.selectedRevision !== view.revision) select(viewId, view);
      }
      return true;
    },
    getStats(viewId) {
      const view = views.get(viewId);
      return view === undefined ? null : describe(viewId, view);
    },
    /**
     * Draw a pane's shown edges. Re-gathers its instance records first when
     * its selection or its geometry changed since the last gather.
     */
    draw(viewId, frame) {
      const view = views.get(viewId);
      if (graph === null || view === undefined) return 0;
      // A pane added or re-published since its last selection selects now.
      if (view.selectedRevision !== view.revision || view.selectedTarget !== target) {
        select(viewId, view);
      }
      if (view.selectedCount === 0) return 0;
      const geometry = getViewGeometry(viewId);
      if (geometry.positions.length !== graph.cellCount * geometry.dimension) {
        throw new RangeError(`Connectivity positions of view "${viewId}" do not match the graph's cell count.`);
      }
      if (
        view.gatheredSelection !== view.selectionGeneration ||
        view.gatheredGeometry !== geometry.generation ||
        view.gatheredPositions !== geometry.positions
      ) {
        gather(view, geometry);
      }
      if (view.selectedCount === 0) return 0;
      gl.useProgram(program);
      configureStraightAlphaBlending(gl);
      gl.uniformMatrix4fv(uniforms.mvpMatrix, false, frame.mvpMatrix);
      gl.uniformMatrix4fv(uniforms.modelViewMatrix, false, frame.modelViewMatrix);
      gl.uniform2f(uniforms.viewportSize, frame.widthPx, frame.heightPx);
      gl.uniform1f(uniforms.lineWidth, frame.lineWidth);
      gl.uniform3fv(uniforms.lineColor, frame.lineColor);
      gl.uniform1f(uniforms.lineAlpha, frame.lineAlpha);
      writeFogUniforms(gl, uniforms.fogNear, uniforms.fogScale, frame.fogDensity, frame.fogNear, frame.fogFar);
      gl.bindVertexArray(view.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, view.selectedCount);
      gl.bindVertexArray(null);
      return view.selectedCount;
    },
    /** GPU and CPU bytes this layer holds, by pane. */
    describeMemory() {
      const panes = [];
      let gpuBytes = 0;
      for (const [viewId, view] of views) {
        gpuBytes += view.bufferBytes;
        panes.push(Object.freeze({
          viewId,
          gpuBytes: view.bufferBytes,
          cpuBytes: view.selection.byteLength + view.records.byteLength,
          shownCount: view.selectedCount,
        }));
      }
      return Object.freeze({
        graphBytes: graph === null ? 0
          : graph.sources.byteLength + graph.destinations.byteLength + graph.strength.byteLength,
        gpuBytes,
        panes: Object.freeze(panes),
        visibleTarget: target,
      });
    },
    /** Drop the graph and every pane's GPU records. */
    clear() {
      for (const view of views.values()) {
        cancelCount(view);
        releaseViewGl(view);
      }
      views.clear();
      graph = null;
      target = 0;
    },
    dispose() {
      this.clear();
      if (quadBuffer !== null) gl.deleteBuffer(quadBuffer);
      if (program !== null) gl.deleteProgram(program);
      quadBuffer = null;
      program = null;
    },
    /** Forget every GL handle without deleting it (the context was lost). */
    abandon() {
      for (const view of views.values()) {
        cancelCount(view);
        view.vao = null;
        view.buffer = null;
        view.bufferBytes = 0;
      }
      views.clear();
      graph = null;
      quadBuffer = null;
      program = null;
    },
  };
}
