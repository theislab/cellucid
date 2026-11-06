// assets/js/utils/format-units.js
var BYTE_UNITS = Object.freeze(["B", "KB", "MB", "GB", "TB", "PB"]);
var GROUPED_INTEGER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0
});
function formatCount(value) {
  requireCount(value);
  return GROUPED_INTEGER.format(value);
}
function requireCount(value) {
  if (typeof value === "bigint") return;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("Count must be a finite number");
  }
}
function formatCountOf(value, singular, plural = `${singular}s`) {
  return `${formatCount(value)} ${countNoun(value, singular, plural)}`;
}
function countNoun(value, singular, plural = `${singular}s`) {
  if (typeof singular !== "string" || singular.length === 0) {
    throw new TypeError("A counted noun must be non-empty text");
  }
  requireCount(value);
  return Number(value) === 1 ? singular : plural;
}

// assets/js/rendering/high-perf/spatial-tree.js
function placedIds(positions, count2, stride) {
  let placed = 0;
  for (let i = 0; i < count2; i++) if (positions[i * stride] === positions[i * stride]) placed++;
  const indices = new Uint32Array(placed);
  if (placed === count2) {
    for (let i = 0; i < count2; i++) indices[i] = i;
    return indices;
  }
  for (let i = 0, at = 0; i < count2; i++) if (positions[i * stride] === positions[i * stride]) indices[at++] = i;
  return indices;
}
function calculateBounds(tree) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const positions = tree.positions;
  const count2 = tree.pointCount;
  const stride = tree.dimensionLevel;
  for (let i = 0; i < count2; i++) {
    const x = positions[i * stride];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }
  if (stride >= 2) {
    for (let i = 0; i < count2; i++) {
      const y = positions[i * stride + 1];
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  } else {
    minY = 0;
    maxY = 0;
  }
  if (stride >= 3) {
    for (let i = 0; i < count2; i++) {
      const z = positions[i * stride + 2];
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  } else {
    minZ = 0;
    maxZ = 0;
  }
  if (!(minX <= maxX)) {
    minX = maxX = minY = maxY = minZ = maxZ = 0;
  }
  const extentX = maxX - minX;
  const extentY = maxY - minY;
  const extentZ = maxZ - minZ;
  const maxExtent = Math.max(extentX, extentY, extentZ, 1e-3);
  const basePad = maxExtent * 1e-3;
  const flatThreshold = maxExtent * 0.01;
  const flatPad = maxExtent * 0.5;
  const padX = extentX < flatThreshold ? flatPad : basePad;
  const padY = extentY < flatThreshold ? flatPad : basePad;
  const padZ = extentZ < flatThreshold ? flatPad : basePad;
  return {
    minX: minX - padX,
    minY: minY - padY,
    minZ: minZ - padZ,
    maxX: maxX + padX,
    maxY: maxY + padY,
    maxZ: maxZ + padZ
  };
}
function buildNode(tree, indices, bounds, depth) {
  const node = {
    bounds,
    indices: null,
    children: null,
    pointCount: indices.length
  };
  if (indices.length <= tree.maxPointsPerNode || depth >= tree.maxDepth) {
    node.indices = indices;
    return node;
  }
  const midX = (bounds.minX + bounds.maxX) * 0.5;
  const midY = (bounds.minY + bounds.maxY) * 0.5;
  const midZ = (bounds.minZ + bounds.maxZ) * 0.5;
  const dimLevel = tree.dimensionLevel;
  const numChildren = tree.childCount;
  const childBounds = [];
  for (let c = 0; c < numChildren; c++) {
    const xSplit = (c & 1) !== 0;
    const ySplit = dimLevel >= 2 ? (c & 2) !== 0 : false;
    const zSplit = dimLevel >= 3 ? (c & 4) !== 0 : false;
    childBounds.push({
      minX: xSplit ? midX : bounds.minX,
      maxX: xSplit ? bounds.maxX : midX,
      // Y bounds: split into halves if dimLevel >= 2, otherwise inherit full range
      minY: ySplit ? midY : bounds.minY,
      maxY: dimLevel >= 2 ? ySplit ? bounds.maxY : midY : bounds.maxY,
      // Z bounds: split into halves if dimLevel >= 3, otherwise inherit full range
      minZ: zSplit ? midZ : bounds.minZ,
      maxZ: dimLevel >= 3 ? zSplit ? bounds.maxZ : midZ : bounds.maxZ
    });
  }
  const positions = tree.positions;
  const n = indices.length;
  const childCounts = new Uint32Array(numChildren);
  let occupiedChildCount = 0;
  let onlyOccupiedChild = -1;
  for (let i = 0; i < n; i++) {
    const idx = indices[i];
    const base = idx * dimLevel;
    let childIdx = positions[base] >= midX | 0;
    if (dimLevel >= 2) childIdx += (positions[base + 1] >= midY | 0) << 1;
    if (dimLevel >= 3) childIdx += (positions[base + 2] >= midZ | 0) << 2;
    if (childCounts[childIdx] === 0) {
      occupiedChildCount++;
      onlyOccupiedChild = childIdx;
    }
    childCounts[childIdx]++;
  }
  if (occupiedChildCount === 1) {
    node.children = new Array(numChildren).fill(null);
    node.children[onlyOccupiedChild] = buildNode(
      tree,
      indices,
      childBounds[onlyOccupiedChild],
      depth + 1
    );
    return node;
  }
  const childIndices = childBounds.map(
    (_, i) => childCounts[i] > 0 ? new Uint32Array(childCounts[i]) : null
  );
  const childOffsets = new Uint32Array(numChildren);
  for (let i = 0; i < n; i++) {
    const idx = indices[i];
    const base = idx * dimLevel;
    let childIdx = positions[base] >= midX | 0;
    if (dimLevel >= 2) {
      childIdx += (positions[base + 1] >= midY | 0) << 1;
    }
    if (dimLevel >= 3) {
      childIdx += (positions[base + 2] >= midZ | 0) << 2;
    }
    childIndices[childIdx][childOffsets[childIdx]++] = idx;
  }
  node.children = childBounds.map(
    (cb, i) => childIndices[i] !== null ? buildNode(tree, childIndices[i], cb, depth + 1) : null
  );
  return node;
}
function buildSpatialTree(positions, dimensionLevel, maxPointsPerNode, maxDepth) {
  const tree = {
    positions,
    dimensionLevel,
    pointCount: positions.length / dimensionLevel,
    childCount: 1 << dimensionLevel,
    maxPointsPerNode,
    maxDepth
  };
  const bounds = calculateBounds(tree);
  const root = buildNode(tree, placedIds(positions, tree.pointCount, dimensionLevel), bounds, 0);
  return { bounds, root };
}
function encodeSpatialTree(tree, dimensionLevel) {
  const childCount = 1 << dimensionLevel;
  const nodes = [];
  const stack = [tree.root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null) continue;
    nodes.push(node);
    if (node.children) for (const child of node.children) stack.push(child);
  }
  const count2 = nodes.length;
  const ids = /* @__PURE__ */ new Map();
  for (let id = 0; id < count2; id++) ids.set(nodes[id], id);
  const bounds = new Float64Array(count2 * 6);
  const pointCounts = new Float64Array(count2);
  const leafRanges = new Float64Array(count2 * 2).fill(-1);
  const drawUnits = new Int8Array(count2).fill(-1);
  const hasChildren = new Uint8Array(count2);
  const children = new Int32Array(count2 * childCount).fill(-1);
  const indexStarts = new Float64Array(count2).fill(-1);
  let packed = null;
  for (let id = 0; id < count2; id++) {
    const node = nodes[id];
    const b = node.bounds;
    bounds.set([b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ], id * 6);
    pointCounts[id] = node.pointCount;
    if (node.leafStart !== void 0) {
      leafRanges[id * 2] = node.leafStart;
      leafRanges[id * 2 + 1] = node.leafEnd;
    }
    if (node.drawUnit !== void 0) drawUnits[id] = node.drawUnit ? 1 : 0;
    if (node.children) {
      hasChildren[id] = 1;
      for (let slot = 0; slot < node.children.length; slot++) {
        const child = node.children[slot];
        if (child !== null) children[id * childCount + slot] = ids.get(child);
      }
    }
    if (node.indices) {
      if (packed === null) packed = node.indices.buffer;
      if (node.indices.buffer !== packed) {
        throw new Error("A spatial tree to encode must keep every leaf's ids in one buffer.");
      }
      indexStarts[id] = node.indices.byteOffset / 4;
    }
  }
  const indices = packed === null ? new Uint32Array(0) : new Uint32Array(packed);
  const encoded = {
    nodeCount: count2,
    childCount,
    bounds,
    pointCounts,
    leafRanges,
    drawUnits,
    hasChildren,
    children,
    indexStarts,
    indices
  };
  const transfer = [bounds, pointCounts, leafRanges, drawUnits, hasChildren, children, indexStarts, indices].map((array) => array.buffer);
  return { encoded, transfer };
}

// assets/js/formats/io/byte-order.js
var HOST_LITTLE_ENDIAN = new Uint8Array(Uint32Array.of(1).buffer)[0] === 1;

// assets/js/formats/zip/crc32.js
var TABLES = (() => {
  const tables = new Uint32Array(16 * 256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    tables[n] = c >>> 0;
  }
  for (let n = 0; n < 256; n++) {
    let c = tables[n];
    for (let t = 1; t < 16; t++) {
      c = tables[c & 255] ^ c >>> 8;
      tables[t * 256 + n] = c >>> 0;
    }
  }
  return tables;
})();

// assets/js/formats/io/read-witness.js
var WITNESS_BYTES = 64 * 1024;

// assets/js/utils/abort.js
var CANCEL_KINDS = Object.freeze(["user", "superseded", "closed", "released", "page-left"]);
var KINDS = new Set(CANCEL_KINDS);
function cancelled(kind, words, cause = void 0) {
  if (!KINDS.has(kind)) throw new RangeError(`Unknown cancellation kind '${String(kind)}'.`);
  if (typeof words !== "string" || words.length === 0) throw new TypeError("A cancellation says what stopped.");
  const error = new DOMException(words, "AbortError");
  Object.defineProperty(error, "kind", { value: kind, enumerable: true, configurable: true });
  if (cause !== void 0) Object.defineProperty(error, "cause", { value: cause, configurable: true, writable: true });
  return error;
}
function abortReason(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error || typeof reason?.name === "string" && typeof reason?.message === "string") return reason;
  return cancelled("user", "The work was cancelled.", reason);
}
var registries = /* @__PURE__ */ new WeakMap();
var NOTHING = () => {
};
function onAbort(signal, callback) {
  if (signal === null || signal === void 0) return NOTHING;
  if (signal.aborted) {
    callback();
    return NOTHING;
  }
  let registry = registries.get(signal);
  if (registry === void 0) {
    const entries = /* @__PURE__ */ new Set();
    const fire = () => {
      if (registries.get(signal) === registry) registries.delete(signal);
      for (const entry2 of [...entries]) {
        try {
          entry2.callback();
        } catch (error) {
          queueMicrotask(() => {
            throw error;
          });
        }
      }
      entries.clear();
    };
    registry = { entries, fire };
    registries.set(signal, registry);
    signal.addEventListener("abort", fire, { once: true });
  }
  const entry = { callback };
  const owner = registry;
  owner.entries.add(entry);
  return () => {
    if (!owner.entries.delete(entry) || owner.entries.size > 0) return;
    if (registries.get(signal) === owner) registries.delete(signal);
    signal.removeEventListener("abort", owner.fire);
  };
}

// assets/js/app/utils/sha256.js
var ROUND_CONSTANTS = new Uint32Array([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var INITIAL_STATE = new Uint32Array([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]);
var HEX = [];
for (let value = 0; value < 256; value++) {
  HEX.push((value + 256).toString(16).slice(1));
}

// assets/js/workers/worker-script.js
var THIS_MACHINE_HOSTS = Object.freeze(["localhost", "127.0.0.1", "[::1]"]);
var THIS_MACHINE = new Set(THIS_MACHINE_HOSTS);
var handed = /* @__PURE__ */ new Map();
var HANDED_MARK = "#handed=";
function handToWorkers(key, read) {
  if (typeof key !== "string" || key === "") throw new TypeError("What is handed to workers has a key.");
  if (typeof read !== "function") throw new TypeError("What is handed to workers is read when one starts: a function.");
  handed.set(key, read);
}
function handedByStarter(key, scope = globalThis) {
  const Scope = scope.DedicatedWorkerGlobalScope;
  if (typeof Scope !== "function" || !(scope instanceof Scope)) return void 0;
  const fragment = scope.location?.hash;
  if (typeof fragment !== "string" || !fragment.startsWith(HANDED_MARK)) return void 0;
  const record = JSON.parse(decodeURIComponent(fragment.slice(HANDED_MARK.length)));
  return Object.hasOwn(record, key) ? record[key] : void 0;
}

// assets/js/utils/machine.js
var finite = (value) => typeof value === "number" && Number.isFinite(value);
var positive = (value) => finite(value) && value > 0;
var notNegative = (value) => finite(value) && value >= 0;
var INDEX_PASS_KINDS = Object.freeze(["index", "view", "placeWhole", "placeOwn"]);
var MEASURES = Object.freeze({
  link: Object.freeze({
    holds: (value) => value !== null && typeof value === "object" && Object.keys(value).every((key) => key === "latencyMs" || key === "bytesPerMs") && notNegative(value.latencyMs) && positive(value.bytesPerMs),
    is: "{latencyMs, bytesPerMs}: a round trip of 0 or more milliseconds and a rate above 0 bytes a millisecond"
  }),
  decodeBytesPerMs: Object.freeze({ holds: positive, is: "a number of bytes a millisecond above 0" }),
  orderMadeMs: Object.freeze({ holds: notNegative, is: "0 or more milliseconds" }),
  keptReadBytesPerMs: Object.freeze({ holds: (value) => value === null || positive(value), is: "a number of bytes a millisecond above 0, or null" }),
  indexPassMs: Object.freeze({
    holds: (value) => value === null || typeof value === "object" && Object.keys(value).every((key) => INDEX_PASS_KINDS.includes(key) && positive(value[key])),
    is: `null, or milliseconds an entry above 0 under any of ${INDEX_PASS_KINDS.join(", ")}`
  }),
  shownCellMs: Object.freeze({ holds: (value) => value === null || notNegative(value), is: "0 or more milliseconds a cell, or null" }),
  cores: Object.freeze({ holds: (value) => Number.isInteger(value) && value >= 1, is: "a whole number of cores, 1 or more" })
});
var MACHINE_MEASURES = Object.freeze(Object.keys(MEASURES));
var HANDED_KEY = "machine";
function checked(measures) {
  if (measures === null || measures === void 0) return null;
  if (typeof measures !== "object" || Array.isArray(measures)) throw new TypeError("A held machine is an object of measures, or null.");
  const held = {};
  for (const [name, value] of Object.entries(measures)) {
    const measure = MEASURES[name];
    if (measure === void 0) throw new TypeError(`Unknown machine measure "${name}" (the measures: ${MACHINE_MEASURES.join(", ")}).`);
    if (!measure.holds(value)) throw new RangeError(`A held ${name} is ${measure.is} (got ${JSON.stringify(value) ?? String(value)}).`);
    held[name] = value !== null && typeof value === "object" ? Object.freeze({ ...value }) : value;
  }
  return Object.keys(held).length === 0 ? null : Object.freeze(held);
}
var holds = checked(handedByStarter(HANDED_KEY) ?? null);
handToWorkers(HANDED_KEY, () => holds ?? void 0);

// assets/js/formats/io/link.js
var READ_AHEAD_BYTES_PER_MS = 64 * 1e3;
var MIN_STALL_TIMEOUT_MS = 1e3;

// assets/js/formats/io/hosts.js
var DELIVERY_TOLD_EVERY_MS = MIN_STALL_TIMEOUT_MS / 2;
var MAX_QUIET_MS = 6e4;
var PACE_WINDOW_MS = 6e4;
var RESET_RESOLUTION_MS = 1e3;
var EPOCH_SECONDS_FROM = 1e9;
var HostNotAnswering = class extends Error {
  /** @param {string} host */
  constructor(host) {
    super(`${host} gave no answer to the requests before this one; it was not sent.`);
    this.name = "HostNotAnswering";
    this.host = host;
  }
};
var HOSTS_CHANNEL = "cellucid-hosts";
function addressOf(url) {
  const at = String(url).indexOf("#");
  return at === -1 ? String(url) : String(url).slice(0, at);
}
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
function siteOf(origin) {
  const name = new URL(origin).hostname;
  if (/^[\d.]+$/.test(name) || name.includes(":")) return name;
  return name.split(".").slice(-2).join(".");
}
function count(value) {
  if (typeof value !== "string" || !/^\s*\d+\s*$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}
function structuredItems(value) {
  if (typeof value !== "string" || value.trim() === "") return [];
  return value.split(",").map((item) => {
    const parameters = {};
    for (const match of item.matchAll(/;\s*([a-z][a-z0-9_-]*)\s*=\s*(\d+)/gi)) parameters[match[1].toLowerCase()] = Number(match[2]);
    return parameters;
  });
}
function budgetOf(headers, epochNow = Date.now()) {
  const get = (name) => headers?.get?.(name) ?? null;
  let limit = count(get("X-RateLimit-Limit")) ?? count(get("RateLimit-Limit"));
  let remaining = count(get("X-RateLimit-Remaining")) ?? count(get("RateLimit-Remaining"));
  let resetInMs = null;
  const legacyReset = count(get("X-RateLimit-Reset"));
  if (legacyReset !== null) {
    resetInMs = legacyReset >= EPOCH_SECONDS_FROM ? Math.max(0, legacyReset * 1e3 - epochNow) : legacyReset * 1e3;
  } else {
    const reset = count(get("RateLimit-Reset"));
    if (reset !== null) resetInMs = reset * 1e3;
  }
  if (remaining === null) {
    const items = structuredItems(get("RateLimit")).filter((item) => Number.isSafeInteger(item.r));
    if (items.length > 0) {
      const tightest = items.reduce((left, right) => right.r < left.r ? right : left);
      remaining = tightest.r;
      if (Number.isSafeInteger(tightest.t)) resetInMs = tightest.t * 1e3;
      const policies = structuredItems(get("RateLimit-Policy")).filter((item) => Number.isSafeInteger(item.q));
      if (limit === null && policies.length > 0) limit = Math.min(...policies.map((item) => item.q));
    }
  }
  if (limit === null && remaining === null && resetInMs === null) return null;
  return { limit, remaining, resetInMs };
}
function createHostBook({
  now = () => performance.now(),
  after = (ms, callback) => {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
  epoch = () => Date.now(),
  channel = null
} = {}) {
  const hosts = /* @__PURE__ */ new Map();
  const lostAt = /* @__PURE__ */ new Map();
  let answeredAt = -Infinity;
  const paceWatchers = /* @__PURE__ */ new Set();
  function hostOf(origin) {
    let host = hosts.get(origin);
    if (host === void 0) {
      host = {
        origin,
        answeredMs: null,
        deliveries: 0,
        toldAt: -Infinity,
        limit: null,
        remaining: null,
        resetAt: null,
        windowAsked: false,
        holdUntil: -Infinity,
        // The window a budget is counted over, as far as it is known (the
        // longest reset stated with a window's whole count), and whether a
        // request has waited for the budget (`requestCostMs`).
        windowMs: null,
        bound: false,
        // What each address of the host lost (`lose`), by address: an
        // address it answers again is forgotten.
        losses: /* @__PURE__ */ new Map(),
        inFlight: 0,
        cap: Infinity,
        capCeiling: Infinity,
        queue: [],
        wake: null,
        wakeAt: Infinity,
        // When each recent request was sent (the latest `PACE_WINDOW_MS`),
        // the least time between two requests the host was found to bear
        // (`learnPace`; 0: none known), and when the last one was sent.
        sentAt: [],
        answeredAt: [],
        paceMs: 0,
        lastSentAt: -Infinity
      };
      hosts.set(origin, host);
    }
    return host;
  }
  function tell(message) {
    if (channel === null) return;
    try {
      channel.postMessage(message);
    } catch {
    }
  }
  function nextFree(host) {
    const at = now();
    if (at < host.holdUntil) return host.holdUntil;
    if (host.paceMs > 0 && at < host.lastSentAt + host.paceMs) return host.lastSentAt + host.paceMs;
    if (host.resetAt !== null && at >= host.resetAt) {
      host.remaining = host.limit === null ? null : 1;
      host.windowAsked = host.limit !== null;
      host.resetAt = null;
    }
    if (host.inFlight >= Math.floor(host.cap)) return Infinity;
    if (host.remaining !== null && host.remaining - host.inFlight <= 0) {
      if (host.inFlight > 0) return Infinity;
      if (host.resetAt !== null) return host.resetAt;
    }
    return at;
  }
  function pump(host) {
    host.wake?.();
    host.wake = null;
    host.wakeAt = Infinity;
    while (host.queue.length > 0) {
      const free = nextFree(host);
      if (free > now()) {
        if (Number.isFinite(free)) {
          host.wakeAt = free;
          host.wake = after(free - now(), () => {
            host.wake = null;
            pump(host);
          });
        }
        for (const waiter2 of host.queue) waiter2.waiting(free);
        if (host.remaining !== null && host.remaining - host.inFlight <= 0) host.bound = true;
        return;
      }
      const waiter = host.queue.shift();
      waiter.admitted();
    }
  }
  function learnBudget(host, said, { limiting = false, waitMs = null } = {}) {
    const at = now();
    if (host.windowAsked && (said === null || said.remaining === null)) {
      host.windowAsked = false;
      host.remaining = host.limit;
    }
    if (said !== null) {
      if (said.limit !== null) host.limit = said.limit;
      if (said.remaining !== null) {
        const resetAt = said.resetInMs === null ? null : at + said.resetInMs;
        const sameWindow = !host.windowAsked && host.remaining !== null && (resetAt === null || host.resetAt === null || resetAt <= host.resetAt + RESET_RESOLUTION_MS);
        host.windowAsked = false;
        if (sameWindow) {
          host.remaining = Math.min(host.remaining, said.remaining);
          if (resetAt !== null) host.resetAt = host.resetAt === null ? resetAt : Math.max(host.resetAt, resetAt);
        } else {
          host.remaining = said.remaining;
          host.resetAt = resetAt;
          if (said.resetInMs !== null && said.resetInMs > 0) host.windowMs = Math.max(host.windowMs ?? 0, said.resetInMs);
        }
      }
    }
    if (waitMs !== null && waitMs > 0) host.holdUntil = Math.max(host.holdUntil, at + waitMs);
    if (limiting && said?.remaining === 0 && said.resetInMs !== null && said.resetInMs < RESET_RESOLUTION_MS) {
      host.holdUntil = Math.max(host.holdUntil, at + RESET_RESOLUTION_MS);
    }
    if (limiting) slowDown(host);
  }
  function lossesOf(host, address) {
    let loss = host.losses.get(address);
    if (loss === void 0) {
      loss = { streak: 0, round: 0, quietUntil: -Infinity };
      host.losses.set(address, loss);
    }
    return loss;
  }
  function lose(host, address) {
    const loss = lossesOf(host, address);
    loss.round++;
    loss.streak++;
    if (loss.streak < 2) return;
    loss.quietUntil = now() + Math.min(MAX_QUIET_MS, MIN_STALL_TIMEOUT_MS * 2 ** (loss.streak - 2));
    if (loss.streak === 2 && host.deliveries > 0) learnPace(host);
    const refused = host.queue.filter((waiter) => waiter.address === address);
    host.queue = host.queue.filter((waiter) => waiter.address !== address);
    for (const waiter of refused) waiter.refused();
  }
  function sent(host) {
    const at = now();
    host.inFlight++;
    host.lastSentAt = at;
    host.sentAt.push(at);
    let old = 0;
    while (old < host.sentAt.length && host.sentAt[old] < at - PACE_WINDOW_MS) old++;
    if (old > 0) host.sentAt.splice(0, old);
  }
  function learnPace(host) {
    const at = now();
    const recent = host.sentAt.filter((time) => time >= at - PACE_WINDOW_MS).length;
    const answered = host.answeredAt.filter((time) => time >= at - PACE_WINDOW_MS).length;
    if (recent < 2 || answered * 2 <= recent) return;
    const refusedMs = PACE_WINDOW_MS / recent;
    const paceMs = Math.max(2 * refusedMs, host.paceMs > 0 ? 2 * host.paceMs : 0);
    setPace(host, paceMs, true);
  }
  function setPace(host, paceMs, tellOthers) {
    if (!(paceMs > host.paceMs) || !Number.isFinite(paceMs)) return;
    host.paceMs = paceMs;
    if (tellOthers) tell({ pace: { origin: host.origin, paceMs } });
    for (const watcher of paceWatchers) {
      try {
        watcher(host.origin, paceMs);
      } catch {
      }
    }
    pump(host);
  }
  function slowDown(host) {
    host.capCeiling = Math.max(1, host.inFlight + 1);
    host.cap = Math.max(1, Math.floor((host.inFlight + 1) / 2));
  }
  function tellBudget(host) {
    const at = now();
    const wall = epoch();
    tell({
      budget: {
        origin: host.origin,
        limit: host.limit,
        remaining: host.remaining,
        resetEpoch: host.resetAt === null ? null : wall + (host.resetAt - at),
        holdEpoch: host.holdUntil > at ? wall + (host.holdUntil - at) : null
      }
    });
  }
  if (channel !== null) {
    channel.onmessage = (event) => {
      const message = event?.data ?? {};
      const origin = message.delivered ?? message.budget?.origin ?? message.pace?.origin ?? null;
      if (typeof origin !== "string") return;
      const host = hostOf(origin);
      if (typeof message.delivered === "string") {
        host.deliveries++;
        return;
      }
      if (message.pace !== void 0) {
        setPace(host, Number(message.pace.paceMs), false);
        return;
      }
      const { limit, remaining, resetEpoch, holdEpoch } = message.budget;
      const wall = epoch();
      learnBudget(host, {
        limit: Number.isSafeInteger(limit) ? limit : null,
        remaining: Number.isSafeInteger(remaining) ? remaining : null,
        resetInMs: Number.isFinite(resetEpoch) ? Math.max(0, resetEpoch - wall) : null
      }, { waitMs: Number.isFinite(holdEpoch) ? holdEpoch - wall : null });
      pump(host);
    };
  }
  return Object.freeze({
    /** Remember that the host of `url` answered a request in `waitedMs`. */
    rememberAnswer(url, waitedMs) {
      const origin = originOf(url);
      if (origin === null || !(waitedMs >= 0)) return;
      hostOf(origin).answeredMs = waitedMs;
    },
    /** How long the host of `url` last took to answer here, or null. */
    rememberedAnswer(url) {
      const origin = originOf(url);
      return origin === null ? null : hosts.get(origin)?.answeredMs ?? null;
    },
    /** Something arrived from the host of `url` (an answer, or a piece of a body). */
    delivered(url) {
      const origin = originOf(url);
      if (origin === null) return;
      const host = hostOf(origin);
      host.deliveries++;
      const at = now();
      if (at - host.toldAt >= DELIVERY_TOLD_EVERY_MS) {
        host.toldAt = at;
        tell({ delivered: origin });
      }
    },
    /**
     * Whether the host of `url` answered this site so a page could read it
     * (a delivery of any realm of this site): a request to it that gets no
     * such answer now is not refused for CORS.
     */
    answeredBefore(url) {
      const origin = originOf(url);
      return origin !== null && (hosts.get(origin)?.deliveries ?? 0) > 0;
    },
    /**
     * Whether the connection on this side, not the host of `url`, is the
     * likely reason it gave no answer: at least two unrelated sites
     * (`siteOf`) that had answered this site before (so neither CORS nor a
     * mistyped name is why) lost a request within one maximum
     * retransmission timeout (`MAX_QUIET_MS`, RFC 6298 2.5: a request not
     * answered within it is lost by TCP's own measure), and no host has
     * answered since the earliest of those losses. One host's outage leaves
     * the others answering; a dropped connection silences every host at once.
     */
    connectionDown(url) {
      if (originOf(url) === null) return false;
      const at = now();
      const recent = [...lostAt.values()].filter((when) => at - when <= MAX_QUIET_MS);
      return recent.length >= 2 && answeredAt < Math.min(...recent);
    },
    /** How many deliveries of the host of `url` this realm knows of: a watch compares two counts. */
    deliveries(url) {
      const origin = originOf(url);
      return origin === null ? 0 : hosts.get(origin)?.deliveries ?? 0;
    },
    /**
     * Wait until the host of `url` may be sent one more request
     * (`signal` ends the wait), then count it as on its way. Answers what to
     * call once it is answered -- at once when the host may be asked now
     * (nothing waits, so a request goes out in the task that asked for it),
     * else a promise of it: `answered(response, {limiting,
     * waitMs, lost})` with the answer (null: none came), `limiting` when it
     * refused the request for the host's limit, `waitMs` the wait it named
     * for the whole host, `lost` when no answer a page may read came (not
     * a request cancelled or ended as stalled). `onWait(info)` hears when the request waits
     * (`{host, untilMs}`, `untilMs` from now, null: until an answer) and
     * `onWait(null)` when it no longer does.
     *
     * `waits` false: a request whose answer is optional (GitHub's commit of a
     * file, without which it is read at its branch) is not held for the
     * budget: null when the host may not be asked now.
     *
     * `burst`: one of many requests to its address, sent without a person
     * asking each: `true`, a file's range reads, whose address is the URL;
     * a URL, the address the request is one of (a store folder's root, for
     * each of its objects). Its losses are counted by address, and while
     * the address is left unasked it fails unsent (`HostNotAnswering`). A
     * provider's request (a record, a file's details) is asked as the
     * person asked (`withRetries`: twice).
     *
     * @param {string} url
     * @param {{signal?: AbortSignal|null, onWait?: ((info: {host: string, untilMs: number|null, limit: number|null}|null) => void)|null,
     *   waits?: boolean, burst?: boolean|string}} [options]
     * @returns {Answered|Promise<Answered>|null} `Answered`: `(response: Response|null,
     *   options?: {limiting?: boolean, waitMs?: number|null}) => void`
     */
    admit(url, { signal = null, onWait = null, waits = true, burst = false } = {}) {
      const origin = originOf(url);
      if (signal?.aborted) return Promise.reject(abortReason(signal));
      if (origin === null) return () => {
      };
      const host = hostOf(origin);
      const address = addressOf(typeof burst === "string" ? burst : url);
      let round = null;
      let probe = false;
      const answered = (response, { limiting = false, waitMs = null, lost = false } = {}) => {
        host.inFlight = Math.max(0, host.inFlight - 1);
        if (probe) {
          const loss2 = host.losses.get(address);
          if (loss2 !== void 0) loss2.probing = false;
        }
        if (response === null && lost) {
          if (burst && round === (host.losses.get(address)?.round ?? 0)) lose(host, address);
          if (host.deliveries > 0) lostAt.set(siteOf(origin), now());
        } else if (response !== null) {
          answeredAt = now();
          lostAt.delete(siteOf(origin));
          host.losses.delete(address);
          const at = now();
          host.answeredAt.push(at);
          let old = 0;
          while (old < host.answeredAt.length && host.answeredAt[old] < at - PACE_WINDOW_MS) old++;
          if (old > 0) host.answeredAt.splice(0, old);
        }
        const said = response === null ? null : budgetOf(response.headers, epoch());
        if (response !== null && !limiting && host.cap !== Infinity) {
          host.cap += 1 / host.cap;
          if (host.cap >= host.capCeiling) {
            host.cap = Infinity;
            host.capCeiling = Infinity;
          }
        }
        learnBudget(host, said, { limiting, waitMs });
        if (said !== null || limiting || (waitMs ?? 0) > 0) tellBudget(host);
        pump(host);
      };
      const loss = burst ? host.losses.get(address) : void 0;
      if (loss !== void 0 && (now() < (loss.quietUntil ?? -Infinity) || loss.streak >= 2 && loss.probing === true)) {
        return waits ? Promise.reject(new HostNotAnswering(new URL(origin).host)) : null;
      }
      if (loss !== void 0 && loss.streak >= 2) {
        loss.probing = true;
        probe = true;
      }
      const free = nextFree(host);
      if (host.queue.length === 0 && free <= now()) {
        sent(host);
        round = host.losses.get(address)?.round ?? 0;
        return answered;
      }
      if (!waits) return null;
      return new Promise((resolve, reject) => {
        let told = false;
        const waiter = {
          admitted: () => {
            stopWaiting();
            if (told) onWait?.(null);
            sent(host);
            round = host.losses.get(address)?.round ?? 0;
            resolve(answered);
          },
          address: burst ? address : null,
          refused: () => {
            stopWaiting();
            if (told) onWait?.(null);
            reject(new HostNotAnswering(new URL(origin).host));
          },
          waiting: (untilAt) => {
            if (told) return;
            told = true;
            onWait?.({ host: new URL(origin).host, untilMs: Number.isFinite(untilAt) ? Math.max(0, untilAt - now()) : null, limit: host.limit });
          }
        };
        host.queue.push(waiter);
        const stopWaiting = onAbort(signal, () => {
          const at = host.queue.indexOf(waiter);
          if (at >= 0) host.queue.splice(at, 1);
          if (told) onWait?.(null);
          reject(abortReason(signal));
        });
        pump(host);
      });
    },
    /**
     * What one more request to the host of `url` costs in time, as its
     * request budget prices it: 0 while the host has stated no budget (or
     * no window). Otherwise the budget's interval, its window over its limit
     * (Zenodo: 60 s / 133, 0.45 s; the window learnt from the longest reset
     * stated whole), in the share of this window already spent: a request
     * is nearly free while most of the window remains, so early reads stay
     * exact, and costs the whole interval once nothing remains for what is
     * asked, or once a request has waited for the budget. Readers price a
     * request at no less (`link.js` `requestCostMs`, which `requestMs` and the
     * byte reader's `planMergeGap` read): as the budget runs down
     * they read through larger gaps, so an opening fits the window in fewer,
     * larger requests instead of waiting for the next one.
     */
    requestCostMs(url) {
      const origin = originOf(url);
      const host = origin === null ? void 0 : hosts.get(origin);
      if (host === void 0) return 0;
      if (!(host.limit > 0) || !(host.windowMs > 0)) return host.paceMs;
      const interval = host.windowMs / host.limit;
      const left = host.remaining === null ? host.limit : host.remaining - host.inFlight - host.queue.length;
      if (host.bound || left <= 0) return Math.max(interval, host.paceMs);
      return Math.max(host.paceMs, interval * Math.min(1, Math.max(0, 1 - left / host.limit)));
    },
    /** The least time between two requests to the host of `url` it was found to bear (0: none known). */
    pace(url) {
      const origin = originOf(url);
      return origin === null ? 0 : hosts.get(origin)?.paceMs ?? 0;
    },
    /**
     * Start the host of `url` (a URL or an origin) at a pace kept from an
     * earlier visit (`data/host-link-memory.js`): its requests are spaced
     * at least `paceMs` apart. Never makes a known pace faster.
     */
    seedPace(url, paceMs) {
      const origin = originOf(url);
      if (origin === null || !(paceMs > 0)) return;
      setPace(hostOf(origin), paceMs, false);
    },
    /** Hear every host's pace as it is learnt or told (`(origin, paceMs) => void`); returns what stops it. */
    watchPace(listener) {
      paceWatchers.add(listener);
      return () => paceWatchers.delete(listener);
    },
    /**
     * How long the host of `url` is held now (milliseconds; 0 when it may be
     * asked): a wait it named, or, with nothing of its budget left and
     * nothing on its way, its reset.
     */
    heldForMs(url) {
      const origin = originOf(url);
      const host = origin === null ? void 0 : hosts.get(origin);
      if (host === void 0) return 0;
      const at = now();
      let until = host.holdUntil;
      if (host.remaining !== null && host.remaining - host.inFlight <= 0 && host.inFlight === 0 && host.resetAt !== null) {
        until = Math.max(until, host.resetAt);
      }
      return Math.max(0, until - at);
    },
    /** What this realm knows of the host of `url`'s budget (tests, the Transfers log). */
    budget(url) {
      const origin = originOf(url);
      const host = origin === null ? void 0 : hosts.get(origin);
      if (host === void 0) return null;
      const at = now();
      return {
        limit: host.limit,
        remaining: host.remaining,
        resetInMs: host.resetAt === null ? null : Math.max(0, host.resetAt - at),
        heldForMs: Math.max(0, host.holdUntil - at),
        inFlight: host.inFlight,
        cap: host.cap,
        waiting: host.queue.length
      };
    }
  });
}
function realmChannel() {
  if (typeof BroadcastChannel !== "function") return null;
  try {
    const channel = new BroadcastChannel(HOSTS_CHANNEL);
    channel.unref?.();
    return channel;
  } catch {
    return null;
  }
}
var realmHosts = createHostBook({ channel: realmChannel() });

// assets/js/formats/io/page-checks.js
var CHECK_PAGE_BYTES = 16 * 1024;

// assets/js/formats/io/byte-source.js
var BYTE_SOURCE_FAILURES = Object.freeze({
  NETWORK: "network",
  STALLED: "stalled",
  RANGE_IGNORED: "range-ignored",
  RATE_LIMITED: "rate-limited",
  UNAVAILABLE: "unavailable",
  HTTP: "http",
  SHORT_READ: "short-read",
  CHANGED: "changed",
  UNREADABLE: "unreadable",
  SIZE_UNKNOWN: "size-unknown",
  /** A copy kept in this browser whose bytes do not match their checksums (`page-checks.js`). */
  DAMAGED: "damaged"
});
var KiB = 1024;
var MiB = 1024 * KiB;
var REMOTE_POLICY = Object.freeze({
  blockBytes: 16 * KiB,
  mergeGapBytes: 64 * KiB,
  maxRequestBytes: 8 * MiB,
  concurrency: 6,
  streams: 100,
  cacheBytes: 64 * MiB,
  // Nothing is assumed of a web host: it is read ahead only once measured.
  bytesPerMs: 0
});
var LOCAL_POLICY = Object.freeze({
  blockBytes: 64 * KiB,
  mergeGapBytes: 4 * KiB,
  maxRequestBytes: 32 * MiB,
  concurrency: 4,
  cacheBytes: 32 * MiB,
  // A disk (1 GB/s), read ahead from the start.
  bytesPerMs: 1e6
});
var HEAD_BYTES = 512 * KiB;
var HOST_FAULTS = Object.freeze(["failing", "limiting", "refusing", "refused", "missing", "offline", "connection"]);
var TRANSIENT_FAILURES = /* @__PURE__ */ new Set([
  BYTE_SOURCE_FAILURES.NETWORK,
  BYTE_SOURCE_FAILURES.STALLED,
  BYTE_SOURCE_FAILURES.RATE_LIMITED,
  BYTE_SOURCE_FAILURES.UNAVAILABLE
]);

// assets/js/data/memory-budget.js
var GIB = 1024 ** 3;
var DEVICE_MEMORY_TOP_BUCKET_GIB = 8;
var HEAP_TO_PHYSICAL_RATIO = 4;
var UNREPORTED_DEVICE_BYTES = DEVICE_MEMORY_TOP_BUCKET_GIB * GIB;
var ALLOWANCE_OF_DEVICE = 1 / 2;
var RESIDENCY_SHARES = Object.freeze({
  /**
   * A gene-column index held in memory before it spills to disk (8 bytes per
   * stored entry), with the row pointers of the cell-major matrices it is
   * built from (8 bytes a stored row).
   */
  columnIndex: 3 / 8,
  /** Decoded embedding positions of layouts no view shows. */
  positions: 1 / 8,
  /** Loaded but unused field arrays kept for fast re-selection. */
  inactiveFields: 1 / 8,
  /**
   * An analysis run's memory: the genes it buffers (marker discovery,
   * differential expression, dot plots), the per-cell context each analysis
   * worker keeps for it (its groups), and the marker results kept for the
   * next look.
   */
  analysis: 1 / 16,
  /**
   * The values analysis windows read for their pages, kept for the next read
   * (`app/analysis/data/data-layer.js`), with the page cell lists made for
   * them (unions of groups, "rest of" pages, first-pass samples).
   */
  analysisPages: 1 / 16,
  /**
   * The AnnData adapter's cached copies: normalized coordinates, obs field
   * payloads not handed to a view, and the neighbour graph read last while
   * no view shows its edges.
   */
  adapterCache: 1 / 16,
  /** A latent space the reader worker holds for outlier quantiles. */
  latentHold: 1 / 16,
  /**
   * Decoded chunks of the open store, every cache of them together (`formats/io/decoded-budget.js`):
   * the store's own (dense strips shared by their genes, chunks read in part) and the whole chunks a
   * subsample is read through (`anndata/decoded-chunks.js`), every open store together.
   */
  decodedBlocks: 1 / 32,
  /**
   * Bytes of remote files kept for the reader workers: the page's byte-range cache (`byte-range-cache.js`), whichever
   * worker fetched them, and each worker's own held reads (`heldReaderBytes`, registered by `anndata-reader-worker.js`).
   */
  fetchedRanges: 1 / 32,
  /** Decode workers while they decompress chunks (`formats/io/decode-pool.js`). */
  decodeWorkers: 1 / 32,
  /** Earlier selection steps a highlight tool can undo to (every tool together). */
  undoHistory: 1 / 32
});
var RELEASE_ORDER = Object.freeze([
  "decodedBlocks",
  "fetchedRanges",
  "decodeWorkers",
  "adapterCache",
  "inactiveFields",
  "analysisPages",
  "analysis",
  "positions",
  "latentHold",
  "columnIndex",
  "undoHistory"
]);
var RELEASE_LEVELS = Object.freeze({
  caches: Object.freeze(RELEASE_ORDER.filter((name) => name !== "columnIndex" && name !== "undoHistory")),
  all: Object.freeze(RELEASE_ORDER.filter((name) => name !== "undoHistory"))
});
if (RELEASE_ORDER.length !== Object.keys(RESIDENCY_SHARES).length || !RELEASE_ORDER.every((name) => Object.hasOwn(RESIDENCY_SHARES, name))) {
  throw new Error("Every residency share has one place in the release order.");
}
function requireShare(name) {
  if (!Object.hasOwn(RESIDENCY_SHARES, name)) throw new TypeError(`Unknown residency budget '${String(name)}'`);
  return name;
}
var handed2 = null;
var allowanceScale = 1;
var refusedBytes = 0;
var otherInstances = { count: 0, heldBytes: 0 };
var workingSet = /* @__PURE__ */ new Map();
var openCells = 0;
function estimatedDeviceMemory(environment = globalThis) {
  if (handed2 !== null && environment === globalThis) return { bytes: handed2.deviceBytes, source: handed2.deviceSource };
  const deviceMemory = environment?.navigator?.deviceMemory;
  const reported = typeof deviceMemory === "number" && Number.isFinite(deviceMemory) && deviceMemory > 0 ? Math.floor(deviceMemory * GIB) : null;
  const heapLimit = environment?.performance?.memory?.jsHeapSizeLimit;
  const fromHeap = typeof heapLimit === "number" && Number.isFinite(heapLimit) && heapLimit > 0 ? Math.floor(heapLimit * HEAP_TO_PHYSICAL_RATIO) : null;
  if (reported !== null && (reported < DEVICE_MEMORY_TOP_BUCKET_GIB * GIB || fromHeap === null || fromHeap <= reported)) {
    return { bytes: reported, source: "deviceMemory" };
  }
  if (fromHeap !== null) return { bytes: fromHeap, source: "jsHeapSizeLimit" };
  return { bytes: UNREPORTED_DEVICE_BYTES, source: "unreported" };
}
function currentScale() {
  return handed2 === null ? allowanceScale : handed2.scale;
}
function currentOthers() {
  return handed2 === null ? otherInstances : handed2.otherInstances;
}
function memoryAllowanceBytes(environment = globalThis) {
  const device = estimatedDeviceMemory(environment).bytes * ALLOWANCE_OF_DEVICE * currentScale();
  const others = currentOthers();
  const shared = others.count === 0 ? device : Math.max(device / (others.count + 1), device - others.heldBytes);
  return Math.floor(shared);
}
function workingSetBytes() {
  if (handed2 !== null) return handed2.workingSetBytes;
  let total = 0;
  for (const bytes of workingSet.values()) total += bytes;
  return total;
}
function cacheRoomBytes({ workingSetBytes: drawn = workingSetBytes(), environment = globalThis } = {}) {
  return Math.max(0, memoryAllowanceBytes(environment) - drawn);
}
function residencyBudgetBytes(name, environment = globalThis, { workingSetBytes: drawn = workingSetBytes() } = {}) {
  requireShare(name);
  return Math.floor(cacheRoomBytes({ workingSetBytes: drawn, environment }) * RESIDENCY_SHARES[name]);
}
var holders = /* @__PURE__ */ new Set();
var workerHeld = /* @__PURE__ */ new Map();
function holderBytes(entry) {
  const bytes = entry.bytes();
  return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
}
function localHeld(share) {
  let total = 0;
  for (const entry of holders) if (entry.share === share) total += holderBytes(entry);
  return total;
}
function heldByShare() {
  const shares = {};
  for (const name of RELEASE_ORDER) shares[name] = localHeld(name);
  for (const report2 of workerHeld.values()) {
    for (const [name, bytes] of Object.entries(report2)) if (Object.hasOwn(shares, name)) shares[name] += bytes;
  }
  return shares;
}
function heldBytes() {
  let total = 0;
  for (const bytes of Object.values(heldByShare())) total += bytes;
  return total;
}
function wordsOf(result) {
  if (typeof result === "string") return result.length > 0 ? [result] : [];
  if (Array.isArray(result)) return result.filter((item) => typeof item === "string" && item.length > 0);
  return [];
}
function trimShare(share, budget, released) {
  const entries = [...holders].filter((entry) => entry.share === share);
  let held = entries.reduce((sum, entry) => sum + holderBytes(entry), 0);
  if (held <= budget) return;
  for (const entry of entries) {
    if (held <= budget) break;
    const own = holderBytes(entry);
    released.push(...wordsOf(entry.trim(Math.max(0, budget - (held - own)))));
    held += holderBytes(entry) - own;
  }
}
function settleMemory(reason = "settle") {
  const released = [];
  for (const share of RELEASE_ORDER) trimShare(share, residencyBudgetBytes(share), released);
  announceRelease(reason, released);
  return released;
}
function recordAllocationFailure(bytes, environment = globalThis) {
  if (!(bytes > 0) || bytes >= memoryAllowanceBytes(environment)) return false;
  if (handed2 !== null) {
    handed2 = Object.freeze({ ...handed2, scale: handed2.scale / 2, refusedBytes: bytes });
    report({ refused: bytes });
    settleMemory("refused");
    return true;
  }
  allowanceScale /= 2;
  refusedBytes = bytes;
  stateChanged("refused");
  return true;
}
function recordAllocationSuccess(bytes) {
  const refused = handed2 === null ? refusedBytes : handed2.refusedBytes;
  if (refused === 0 || !(bytes >= refused)) return;
  if (handed2 !== null) {
    report({ granted: bytes });
    return;
  }
  if (workingSetBytes() + heldBytes() + bytes < memoryAllowanceBytes()) return;
  raiseAllowance("granted");
}
function raiseAllowance(reason) {
  allowanceScale = Math.min(1, allowanceScale * 2);
  if (allowanceScale === 1) refusedBytes = 0;
  stateChanged(reason);
}
var changeListeners = /* @__PURE__ */ new Set();
var releaseListeners = /* @__PURE__ */ new Set();
function announceRelease(reason, released) {
  if (released.length === 0) return;
  if (handed2 !== null) report({ released, reason });
  for (const listener of [...releaseListeners]) listener({ reason, released: [...released] });
}
function stateChanged(reason) {
  settleMemory(reason);
  const state = memoryState();
  for (const connection of connections) connection.post({ memoryState: state, reason });
  for (const listener of [...changeListeners]) listener(reason);
  noteMemoryChanged();
}
function memoryState() {
  const device = estimatedDeviceMemory();
  return Object.freeze({
    deviceBytes: device.bytes,
    deviceSource: device.source,
    scale: allowanceScale,
    refusedBytes,
    otherInstances,
    workingSetBytes: workingSetBytes(),
    openCells
  });
}
var connections = /* @__PURE__ */ new Set();
var reporter = null;
var reportScheduled = false;
function report(extra) {
  if (reporter === null) return;
  if (extra !== void 0) {
    reporter({ event: "memory", held: localHeldByShare(), ...extra });
    return;
  }
  reporter({ event: "memory", held: localHeldByShare() });
}
function localHeldByShare() {
  const shares = {};
  for (const name of RELEASE_ORDER) {
    const bytes = localHeld(name);
    if (bytes > 0) shares[name] = bytes;
  }
  return shares;
}
var heldListeners = /* @__PURE__ */ new Set();
function noteMemoryChanged() {
  if (reportScheduled) return;
  reportScheduled = true;
  setTimeout(() => {
    reportScheduled = false;
    if (reporter !== null) report();
    else for (const listener of [...heldListeners]) listener(workingSetBytes() + heldBytes());
  }, 0);
}

// assets/js/utils/large-arrays.js
var MEMORY_PAGE_BYTES = 65536;
var MEMORY_MAX_BYTES = 2 ** 32;
var ARRAY_PIECE_BYTES = 2 ** 24 * 3 * 4;
var TYPED_ARRAYS = Object.freeze({
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array
});
var memoryBuffers = /* @__PURE__ */ new WeakSet();
function allocateInMemory(ArrayType, length) {
  const bytes = length * ArrayType.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError(`A typed array holds a non-negative whole number of elements, not ${length}.`);
  }
  if (bytes > MEMORY_MAX_BYTES) {
    throw new RangeError(
      `${formatCountOf(bytes, "byte")} is more than one WebAssembly memory holds (${formatCountOf(MEMORY_MAX_BYTES, "byte")}), the largest array a browser page can allocate.`
    );
  }
  const pages = Math.ceil(bytes / MEMORY_PAGE_BYTES);
  const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
  memoryBuffers.add(memory.buffer);
  return new ArrayType(memory.buffer, 0, length);
}
function allocateLargeArray(ArrayType, length) {
  try {
    return new ArrayType(length);
  } catch (refused) {
    if (!(refused instanceof RangeError) || typeof WebAssembly?.Memory !== "function" || !(length * ArrayType.BYTES_PER_ELEMENT <= MEMORY_MAX_BYTES)) throw refused;
    try {
      return allocateInMemory(ArrayType, length);
    } catch {
      throw refused;
    }
  }
}
var ArrayAssembly = class {
  /**
   * @param {new (length: number) => ArrayBufferView} ArrayType
   * @param {number} length
   */
  constructor(ArrayType, length) {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new RangeError(`An assembled array holds a non-negative whole number of elements, not ${length}.`);
    }
    this.ArrayType = ArrayType;
    this.length = length;
    this.array = null;
    this.filled = 0;
  }
  /**
   * Copy one piece in.
   *
   * @param {number} offset - Its first element in the whole array
   * @param {ArrayBufferView} values
   */
  put(offset, values) {
    if (!(values instanceof this.ArrayType)) {
      throw new TypeError(`A piece of a ${this.ArrayType.name} is one too, not ${values?.constructor?.name}.`);
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + values.length > this.length) {
      throw new RangeError(`A piece at ${offset} of ${formatCountOf(values.length, "element")} lies outside an array of ${formatCountOf(this.length, "element")}.`);
    }
    if (this.array === null && offset === 0 && values.length === this.length) {
      this.array = values;
    } else {
      this.array ??= allocateLargeArray(this.ArrayType, this.length);
      this.array.set(values, offset);
    }
    this.filled += values.length;
  }
  /** The whole array, once every element arrived. */
  get result() {
    if (this.filled !== this.length) {
      throw new RangeError(`An array of ${formatCountOf(this.length, "element")} was assembled from ${formatCountOf(this.filled, "element")}.`);
    }
    return this.array ?? new this.ArrayType(0);
  }
};

// assets/js/data/sparse-column-index.js
var SEGMENT_ELEMENTS = 2 ** 27;
function allocateTypedArray(ArrayType, length, label) {
  let array;
  try {
    array = allocateLargeArray(ArrayType, length);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    const bytes = length * ArrayType.BYTES_PER_ELEMENT;
    recordAllocationFailure(bytes);
    const failure = new RangeError(
      `${label} needs ${formatCountOf(bytes, "byte")}, more memory than the browser could allocate.`
    );
    failure.code = "TOO_LARGE";
    failure.bytes = bytes;
    throw failure;
  }
  recordAllocationSuccess(length * ArrayType.BYTES_PER_ELEMENT);
  return array;
}
var PRIOR_COSTS = Object.freeze({
  mergeGapBytes: REMOTE_POLICY.mergeGapBytes,
  roundTripBytes: null,
  shapingConcurrency: REMOTE_POLICY.concurrency
});
var WHOLE_VALUES_STEP = 1 << 20;
var DISK_GROUP_BUFFER_ENTRIES = 1 << 18;
var DISK_BUFFER_BUDGET_ENTRIES = 1 << 24;
var KEPT_PIECE_BYTES = 16 * 1024 * 1024;
var KEPT_TYPES = Object.freeze({ f64: Float64Array, u32: Uint32Array, f32: Float32Array });
var KEPT_READ_GAP_BYTES = 1 << 20;

// assets/js/data/cell-identity.js
function fmix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
}

// assets/js/data/subsample.js
var SUBSAMPLE_METHODS = Object.freeze(["uniform", "blocks", "stratified", "spatial"]);
var STRATIFIED_ALLOCATIONS = Object.freeze(["proportional", "balanced"]);
var DEFAULT_SUBSAMPLE_SEED = 0;
var MAX_CELLS = 4294967295;
function requireUint32(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_CELLS) {
    throw new RangeError(`${label} must be an integer in [0, 2^32 - 1]; got ${String(value)}.`);
  }
  return value;
}
function seedKey(seed) {
  return fmix32((requireUint32(seed, "A subsample seed") ^ 2654435769) >>> 0);
}
var RANK_SPACE = 2 ** 32;

// assets/js/data/cell-priority.js
var OPEN_ORDER_PRIORITY = Object.freeze({ seed: null, originals: null });
var DEFAULT_CELL_PRIORITY = Object.freeze({ seed: DEFAULT_SUBSAMPLE_SEED, originals: null });
function rankedCellPriority(seed, originals = null) {
  seedKey(seed);
  if (originals !== null && !(originals instanceof Uint32Array)) {
    throw new TypeError("A cell priority names original positions as a Uint32Array.");
  }
  return seed === DEFAULT_SUBSAMPLE_SEED && originals === null ? DEFAULT_CELL_PRIORITY : Object.freeze({ seed, originals });
}
function reviveCellPriority(message) {
  if (message === null || typeof message !== "object") throw new TypeError("A cell priority message must be an object.");
  return message.seed === null && message.originals === null ? OPEN_ORDER_PRIORITY : rankedCellPriority(message.seed, message.originals ?? null);
}
function requireCellPriority(priority, n) {
  if (priority === null || typeof priority !== "object" || !Object.isFrozen(priority)) {
    throw new TypeError("A cell priority must be a frozen descriptor (data/cell-priority.js).");
  }
  if (priority.seed === null) {
    if (priority.originals !== null) throw new TypeError("An open-order cell priority names no original positions.");
    return priority;
  }
  seedKey(priority.seed);
  if (priority.originals !== null) {
    if (!(priority.originals instanceof Uint32Array)) {
      throw new TypeError("A cell priority names original positions as a Uint32Array.");
    }
    if (priority.originals.length !== n) {
      throw new RangeError(`A cell priority names ${formatCountOf(priority.originals.length, "cell")}, not the ${formatCountOf(n, "open cell")}.`);
    }
  }
  return priority;
}
var RADIX_BITS = 16;
var RADIX_SIZE = 1 << RADIX_BITS;
var RADIX_MASK = RADIX_SIZE - 1;
function inverseFmix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 2127672349);
  h ^= h >>> 13 ^ h >>> 26;
  h = Math.imul(h, 2781581891);
  h ^= h >>> 16;
  return h >>> 0;
}
function digitOffsets(keys) {
  const low = new Uint32Array(RADIX_SIZE);
  const high = new Uint32Array(RADIX_SIZE);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    low[key & RADIX_MASK]++;
    high[key >>> RADIX_BITS]++;
  }
  let lowAt = 0;
  let highAt = 0;
  for (let digit = 0; digit < RADIX_SIZE; digit++) {
    const lowCount = low[digit];
    low[digit] = lowAt;
    lowAt += lowCount;
    const highCount = high[digit];
    high[digit] = highAt;
    highAt += highCount;
  }
  return { low, high };
}
function buildPriorityOrder(n, priority) {
  requireCellPriority(priority, n);
  if (priority.seed === null) {
    const order = allocateTypedArray(Uint32Array, n, "Cell priority order");
    for (let i = 0; i < n; i++) order[i] = i;
    return order;
  }
  const key = seedKey(priority.seed);
  const originals = priority.originals;
  let keys = allocateTypedArray(Uint32Array, n, "Cell priority ranks");
  if (originals === null) {
    for (let i = 0; i < n; i++) keys[i] = fmix32((i ^ key) >>> 0);
  } else {
    for (let i = 0; i < n; i++) keys[i] = fmix32((originals[i] ^ key) >>> 0);
  }
  const { low, high } = digitOffsets(keys);
  let scratch = allocateTypedArray(Uint32Array, n, "Cell priority ranks");
  if (originals === null) {
    for (let i = 0; i < n; i++) {
      const value = keys[i];
      scratch[low[value & RADIX_MASK]++] = value;
    }
    for (let i = 0; i < n; i++) {
      const value = scratch[i];
      keys[high[value >>> RADIX_BITS]++] = value;
    }
    for (let i = 0; i < n; i++) keys[i] = (inverseFmix32(keys[i]) ^ key) >>> 0;
    scratch = null;
    return keys;
  }
  const ids = allocateTypedArray(Uint32Array, n, "Cell priority order");
  let scratchIds = allocateTypedArray(Uint32Array, n, "Cell priority order");
  for (let i = 0; i < n; i++) {
    const at = low[keys[i] & RADIX_MASK]++;
    scratch[at] = keys[i];
    scratchIds[at] = i;
  }
  keys = null;
  for (let i = 0; i < n; i++) ids[high[scratch[i] >>> RADIX_BITS]++] = scratchIds[i];
  scratch = null;
  scratchIds = null;
  return ids;
}

// assets/js/rendering/shader-quality.js
var SHADER_QUALITIES = Object.freeze([
  "full",
  "sculpted",
  "light",
  "ultralight"
]);
var SHADER_QUALITY_TRAITS = Object.freeze({
  full: Object.freeze({ fog: true, fogAlpha: true, sphere: true }),
  sculpted: Object.freeze({ fog: true, fogAlpha: false, sphere: true }),
  light: Object.freeze({ fog: false, fogAlpha: false, sphere: false }),
  ultralight: Object.freeze({ fog: false, fogAlpha: false, sphere: false })
});
var DESCRIBED_QUALITIES = `${SHADER_QUALITIES.slice(0, -1).map((quality) => `"${quality}"`).join(", ")}, or "${SHADER_QUALITIES.at(-1)}"`;

// assets/js/rendering/high-perf/renderer-contracts.js
var SUPPORTED_SHADER_QUALITIES = new Set(SHADER_QUALITIES);
var REQUIRED_RENDER_SCALAR_KEYS = Object.freeze([
  "pointSize",
  "sizeAttenuation",
  "viewportHeight",
  "viewportWidth",
  "fov",
  "lightingStrength",
  "fogDensity",
  "cameraDistance"
]);
var REQUIRED_RENDER_VECTOR_CONTRACTS = Object.freeze([
  Object.freeze(["mvpMatrix", 16]),
  Object.freeze(["viewMatrix", 16]),
  Object.freeze(["modelMatrix", 16]),
  Object.freeze(["projectionMatrix", 16]),
  Object.freeze(["fogColor", 3]),
  Object.freeze(["lightDir", 3]),
  Object.freeze(["cameraPosition", 3])
]);
var LOD_FULL_DETAIL_ADMISSION_LEVEL = 255;

// assets/js/rendering/high-perf/draw-order.js
var DRAW_UNIT_DEPTH_BY_DIMENSION = Object.freeze([0, 6, 3, Infinity]);
function numberDrawUnits(root, dimensionLevel) {
  const unitDepth = DRAW_UNIT_DEPTH_BY_DIMENSION[dimensionLevel];
  const units = [];
  const visit = (node, depth) => {
    node.leafStart = units.length;
    if (node.indices !== null || node.children === null || depth >= unitDepth) {
      if (node.indices !== null && !(node.indices instanceof Uint32Array)) {
        throw new TypeError("Spatial tree leaf membership must be an exact Uint32Array.");
      }
      node.drawUnit = true;
      units.push(node);
    } else if (node.children) {
      node.drawUnit = false;
      for (const child of node.children) {
        if (child) visit(child, depth + 1);
      }
    }
    node.leafEnd = units.length;
  };
  visit(root, 0);
  return units;
}
function leafIdsFollowDrawOrder(dimensionLevel) {
  return DRAW_UNIT_DEPTH_BY_DIMENSION[dimensionLevel] === Infinity;
}
function dropDerivableLeafIds(root, dimensionLevel) {
  if (!leafIdsFollowDrawOrder(dimensionLevel)) return;
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null) continue;
    if (node.children === null) {
      if (node.drawUnit !== true) throw new Error("A tree's leaf ids are dropped only after its draw order numbered its leaves.");
      node.indices = null;
    } else {
      for (const child of node.children) stack.push(child);
    }
  }
}
var LOD_LADDER_FIRST_COUNT = 1e3;
var DRAW_BAND_POINTS = 2 ** 21;
function lodLadder(pointCount) {
  if (!Number.isSafeInteger(pointCount) || pointCount < 0) {
    throw new RangeError(`A level-of-detail ladder needs a cell count, not ${pointCount}.`);
  }
  const counts = [];
  for (let count2 = LOD_LADDER_FIRST_COUNT; count2 < pointCount; count2 = Math.floor(count2 * 5 / 4)) {
    counts.push(count2);
  }
  counts.push(pointCount);
  return counts;
}
function drawBands(pointCount, bandPoints = DRAW_BAND_POINTS) {
  if (!Number.isSafeInteger(bandPoints) || bandPoints <= 0) {
    throw new RangeError(`A draw band holds a positive number of cells, not ${bandPoints}.`);
  }
  const ladder = lodLadder(pointCount);
  const ends = [];
  const levelBands = new Uint8Array(ladder.length);
  let previous = 0;
  for (let level = 0; level < ladder.length; level++) {
    const end = ladder[level];
    for (let split = (Math.floor(previous / bandPoints) + 1) * bandPoints; split < end; split += bandPoints) {
      ends.push(split);
    }
    if (end > previous || ends.length === 0) ends.push(end);
    if (ends.length > LOD_FULL_DETAIL_ADMISSION_LEVEL) {
      throw new RangeError(`A draw order of ${formatCountOf(pointCount, "cell")} needs more than ${LOD_FULL_DETAIL_ADMISSION_LEVEL} bands.`);
    }
    levelBands[level] = ends.length - 1;
    previous = end;
  }
  return { bandEnds: Uint32Array.from(ends), levelBands, ladder };
}
function buildDrawOrder(root, dimensionLevel, pointCount, bands, priorityOrder) {
  const n = pointCount;
  const leaves = numberDrawUnits(root, dimensionLevel);
  const leafCount = leaves.length;
  const bandEnds = bands === null ? Uint32Array.of(n) : bands.bandEnds;
  const bandCount = bandEnds.length;
  if (bandCount > LOD_FULL_DETAIL_ADMISSION_LEVEL) {
    throw new RangeError(`Draw order supports at most ${LOD_FULL_DETAIL_ADMISSION_LEVEL} bands.`);
  }
  let previousEnd = 0;
  for (let band = 0; band < bandCount; band++) {
    const end = bandEnds[band];
    if (end < previousEnd || end > n || end === previousEnd && band > 0) {
      throw new RangeError(`Draw order: band ${band} is not one monotonic run of ranks.`);
    }
    previousEnd = end;
  }
  if (previousEnd !== n) {
    throw new RangeError("Draw order: bands must end with every point.");
  }
  let bandOf = null;
  if (bands !== null && bandCount > 1) {
    bandOf = new Uint8Array(n);
    if (priorityOrder === null) {
      let rank = 0;
      for (let band = 0; band < bandCount; band++) {
        bandOf.fill(band, rank, bandEnds[band]);
        rank = bandEnds[band];
      }
    } else {
      if (!(priorityOrder instanceof Uint32Array) || priorityOrder.length !== n) {
        throw new Error("Draw order requires one exact priority order of every point.");
      }
      let rank = 0;
      for (let band = 0; band < bandCount; band++) {
        const end = bandEnds[band];
        for (; rank < end; rank++) bandOf[priorityOrder[rank]] = band;
      }
    }
  }
  const unitOf = new Uint32Array(n).fill(leafCount);
  let placed = 0;
  const assign = (node, unit) => {
    if (node.children === null && node.indices === null && node.pointCount > 0) {
      throw new Error("Draw order: the tree's leaf ids follow its published draw order (`dropDerivableLeafIds`); a new order needs a new tree.");
    }
    if (node.indices !== null) {
      const leafIndices = node.indices;
      for (let i = 0; i < leafIndices.length; i++) {
        const id = leafIndices[i];
        if (id >= n) {
          throw new RangeError(`Draw order: leaf contains source ID ${id} outside ${formatCountOf(n, "point")}.`);
        }
        unitOf[id] = unit;
      }
      placed += leafIndices.length;
      return;
    }
    if (node.children) {
      for (const child of node.children) {
        if (child) assign(child, unit);
      }
    }
  };
  for (let unit = 0; unit < leafCount; unit++) assign(leaves[unit], unit);
  if (placed > n) {
    throw new Error(`Draw order: leaves own ${placed} source IDs but the dataset contains ${n}.`);
  }
  const unplacedCount = n - placed;
  const stride = leafCount + 1;
  const leafOffsets = new Uint32Array(bandCount * stride);
  const tails = unplacedCount > 0 ? new Uint32Array(bandCount) : null;
  for (let id = 0; id < n; id++) {
    const band = bandOf === null ? 0 : bandOf[id];
    const unit = unitOf[id];
    if (unit === leafCount) tails[band]++;
    else leafOffsets[band * stride + unit + 1]++;
  }
  for (let band = 0; band < bandCount; band++) {
    const base = band * stride;
    let running = band === 0 ? 0 : bandEnds[band - 1];
    leafOffsets[base] = running;
    for (let unit = 1; unit <= leafCount; unit++) {
      running += leafOffsets[base + unit];
      leafOffsets[base + unit] = running;
    }
    if (tails !== null) running += tails[band];
    if (running !== bandEnds[band]) {
      throw new Error(`Draw order: units place ${formatCountOf(running, "point")} in band ${band}, not ${bandEnds[band]}.`);
    }
  }
  const indices = priorityOrder ?? new Uint32Array(n);
  const cursors = leafOffsets.slice();
  for (let id = 0; id < n; id++) {
    const band = bandOf === null ? 0 : bandOf[id];
    indices[cursors[band * stride + unitOf[id]]++] = id;
  }
  return {
    indices,
    bandCount,
    bandEnds,
    levelBands: bands === null ? null : bands.levelBands,
    leafCount,
    leafOffsets,
    pointCount: n
  };
}
function computeTreeDrawOrder(pointCount, tree, dimensionLevel, buildLOD, priority) {
  const inPriorityOrder = priority.seed === null;
  if (!buildLOD && !inPriorityOrder) {
    return { ...buildDrawOrder(tree.root, dimensionLevel, pointCount, null, null), ranked: false };
  }
  const order = buildDrawOrder(
    tree.root,
    dimensionLevel,
    pointCount,
    drawBands(pointCount),
    inPriorityOrder ? null : buildPriorityOrder(pointCount, priority)
  );
  return { ...order, ranked: inPriorityOrder };
}
function drawOrderTransferList(order) {
  const list = [order.indices.buffer, order.bandEnds.buffer, order.leafOffsets.buffer];
  if (order.levelBands !== null) list.push(order.levelBands.buffer);
  return list;
}

// assets/js/rendering/high-perf/spatial-tree-job.js
function buildSpatialTreeJob(request, { releasePositions = false } = {}) {
  const { dimensionLevel, maxPointsPerNode, maxDepth, buildLOD, priority = DEFAULT_CELL_PRIORITY } = request;
  const pointCount = request.positions.length / dimensionLevel;
  const tree = buildSpatialTree(request.positions, dimensionLevel, maxPointsPerNode, maxDepth);
  if (releasePositions) request.positions = null;
  const derivable = leafIdsFollowDrawOrder(dimensionLevel);
  if (!derivable) packLeafIndices(tree, tree.root.pointCount);
  const order = computeTreeDrawOrder(pointCount, tree, dimensionLevel, buildLOD === true, reviveCellPriority(priority));
  if (derivable) dropDerivableLeafIds(tree.root, dimensionLevel);
  return { tree, order };
}
function packLeafIndices(tree, pointCount) {
  const packed = new Uint32Array(pointCount);
  let offset = 0;
  const stack = [tree.root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null) continue;
    if (node.indices) {
      packed.set(node.indices, offset);
      node.indices = packed.subarray(offset, offset + node.indices.length);
      offset += node.indices.length;
    }
    if (node.children) for (const child of node.children) stack.push(child);
  }
}
function encodeSpatialTreeJobResult(result, dimensionLevel) {
  const { encoded, transfer } = encodeSpatialTree(result.tree, dimensionLevel);
  return {
    reply: { tree: encoded, order: result.order },
    transfer: [...transfer, ...drawOrderTransferList(result.order)]
  };
}

// assets/js/rendering/high-perf/spatial-tree-worker.js
var pendingPositions = /* @__PURE__ */ new Map();
self.onmessage = ({ data }) => {
  const { id } = data;
  try {
    if (data.kind === "positions") {
      let positions = pendingPositions.get(id);
      if (positions === void 0) {
        positions = new ArrayAssembly(Float32Array, data.total);
        pendingPositions.set(id, positions);
      }
      if (data.slice.length > 0) positions.put(data.offset, data.slice);
      return;
    }
    const assembly = pendingPositions.get(id);
    pendingPositions.delete(id);
    if (assembly === void 0) throw new Error("build request arrived without its positions");
    const request = { ...data, positions: assembly.result };
    delete request.kind;
    const { reply, transfer } = encodeSpatialTreeJobResult(
      buildSpatialTreeJob(request, { releasePositions: true }),
      request.dimensionLevel
    );
    self.postMessage({ id, ...reply }, transfer);
  } catch (error) {
    pendingPositions.delete(id);
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
//# sourceMappingURL=spatial-tree-worker.0b8973c151ea.js.map
