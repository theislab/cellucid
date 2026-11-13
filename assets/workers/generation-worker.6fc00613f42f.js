// assets/js/app/ui/modules/benchmark/generation-contract.js
var SYNTHETIC_PATTERNS = Object.freeze([
  "atlas",
  "batches",
  "clusters",
  "flatumap",
  "glb",
  "octopus",
  "spirals",
  "uniform"
]);
var FETCHED_PATTERNS = Object.freeze(["glb"]);
var MIN_SYNTHETIC_COUNT = 1;
var MAX_SYNTHETIC_COUNT = 25e7;
function assertSyntheticPattern(pattern) {
  if (!SYNTHETIC_PATTERNS.includes(pattern)) {
    throw new RangeError(
      `Synthetic pattern must be one of ${SYNTHETIC_PATTERNS.join(", ")}; received ${String(pattern)}.`
    );
  }
  return pattern;
}
function assertSyntheticCount(count2) {
  if (!Number.isSafeInteger(count2) || count2 < MIN_SYNTHETIC_COUNT || count2 > MAX_SYNTHETIC_COUNT) {
    throw new TypeError(
      `Synthetic point count must be one integer between ${MIN_SYNTHETIC_COUNT} and ${MAX_SYNTHETIC_COUNT}; received ${String(count2)}.`
    );
  }
  return count2;
}
function isAbsoluteUrl(value) {
  if (typeof value !== "string") return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}
function assertGenerationRequest(request) {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new TypeError("Generation request must be one plain object.");
  }
  if (!Number.isSafeInteger(request.requestId) || request.requestId < 0) {
    throw new TypeError(
      "Generation request id must be one non-negative safe integer."
    );
  }
  const pattern = assertSyntheticPattern(request.pattern);
  const count2 = assertSyntheticCount(request.count);
  const sourceUrl = request.sourceUrl ?? null;
  if (FETCHED_PATTERNS.includes(pattern)) {
    if (!isAbsoluteUrl(sourceUrl)) {
      throw new TypeError(
        `Generation pattern "${pattern}" requires one absolute sourceUrl; a worker cannot resolve a document-relative one.`
      );
    }
  } else if (sourceUrl !== null) {
    throw new TypeError(
      `Generation pattern "${pattern}" is computed and takes no sourceUrl.`
    );
  }
  return Object.freeze({ requestId: request.requestId, pattern, count: count2, sourceUrl });
}

// assets/js/app/ui/place-names.js
function place(name, where) {
  return Object.freeze({ name, ...where });
}
var PLACES = Object.freeze({
  // Panels.
  session: place("Session", { panel: "session-section" }),
  state: place("State", { panel: "state-section" }),
  visualization: place("Visualization", { panel: "visualization-section" }),
  navigation: place("Navigation", { panel: "navigation-section" }),
  compareViews: place("Compare views", { panel: "compare-views-section" }),
  coloringFiltering: place("Coloring & filtering", { panel: "coloring-filtering-section" }),
  highlighting: place("Highlighting", { panel: "highlighted-cells-section" }),
  benchmark: place("Benchmark", { panel: "benchmark-section" }),
  analysis: place("Analysis", { panel: "page-analysis-section" }),
  // Blocks of the Session panel.
  dataset: place("Dataset", { heading: "dataset-facts-title" }),
  openData: place("Open data", { heading: "open-data-title" }),
  myDatasets: place("My datasets", { heading: "my-datasets-title" }),
  stored: place("Stored", { heading: "kept-stores-title" }),
  subsampling: place("Subsampling", { heading: "reading-title" }),
  dataMapping: place("Data mapping", { heading: "data-mapping-title" }),
  // Blocks of the State panel.
  sessionFile: place("Session", { heading: "session-state-title" }),
  history: place("History", { heading: "history-title" }),
  // The Agents panel and its block.
  agents: place("Agents", { panel: "agents-section" }),
  agentConnect: place("Claude and ChatGPT", { heading: "agent-connect-title" }),
  // Blocks of the Visualization panel.
  performance: place("Performance", { heading: "renderer-settings-title" }),
  vectorField: place("Vector field", { heading: "vector-field-title" }),
  // Places the page builds itself, headed with these names: the legend's
  // range of a continuous field (`legend-renderer.js`), the community
  // annotation panel's columns (`community-annotation/controls-panel.js`),
  // Data mapping's expression transform (`data-mapping/expression-values.js`).
  visibleRange: place("Visible range", {}),
  expressionValues: place("Expression values", {}),
  annotatedColumns: place("Annotated columns", {})
});

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
function formatCompactCount(value) {
  const number = requireFiniteNumber(value, "Compact count");
  const sign = number < 0 ? "-" : "";
  const magnitude = Math.abs(number);
  const scales = [[1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (let at = 0; at < scales.length; at++) {
    const [scale, suffix] = scales[at];
    if (magnitude >= scale) {
      const scaled = magnitude / scale;
      const text = scaled >= 100 ? Math.round(scaled).toString() : scaled.toFixed(1).replace(/\.0$/, "");
      if (text === "1000" && at > 0) return `${sign}1${scales[at - 1][1]}`;
      return `${sign}${text}${suffix}`;
    }
  }
  const whole = Math.round(magnitude);
  return whole === 1e3 ? `${sign}1K` : `${sign}${whole}`;
}
function requireFiniteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${label} must be a finite number`);
  return value;
}

// assets/js/utils/exact-record.js
var EMPTY_KEYS = Object.freeze([]);

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
function sameKind(array, length) {
  return new /** @type {TypedArrayConstructor<T>} */
  array.constructor(length);
}
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
function isMemoryBacked(view) {
  return ArrayBuffer.isView(view) && memoryBuffers.has(view.buffer);
}
function canTransfer(view) {
  return ArrayBuffer.isView(view) && view.buffer instanceof ArrayBuffer && !memoryBuffers.has(view.buffer) && view.byteOffset === 0 && view.byteLength === view.buffer.byteLength;
}
function pieceElements(ArrayType, width = 1) {
  if (!Number.isSafeInteger(width) || width < 1) throw new RangeError(`A piece holds whole groups of 1 or more elements, not ${width}.`);
  return Math.floor(ARRAY_PIECE_BYTES / ArrayType.BYTES_PER_ELEMENT / width) * width;
}
function* arrayPieces(view, width = 1) {
  const step = pieceElements(view.constructor, width);
  for (let offset = 0; offset < view.length; offset += step) {
    yield { offset, values: view.slice(offset, Math.min(view.length, offset + step)) };
  }
}
function typedArrayOf(name) {
  const ArrayType = Object.hasOwn(TYPED_ARRAYS, name) ? TYPED_ARRAYS[name] : void 0;
  if (ArrayType === void 0) throw new TypeError(`'${String(name)}' is not a typed array a piece can hold.`);
  return ArrayType;
}
function placeholder(index) {
  return { arrayPieces: index };
}
function mapChanged(items, map) {
  let out = null;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item === null || typeof item !== "object") continue;
    const mapped = map(item);
    if (mapped !== item) {
      out ??= items.slice();
      out[i] = mapped;
    }
  }
  return out ?? items;
}
function placeArrays(value, send, depth = 0) {
  if (value === null || typeof value !== "object" || depth > 4) return value;
  if (ArrayBuffer.isView(value)) return isMemoryBacked(value) ? send(value) : value;
  if (Array.isArray(value)) return mapChanged(value, (item) => placeArrays(item, send, depth + 1));
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  let copy = null;
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!("value" in descriptor)) continue;
    const placed = placeArrays(descriptor.value, send, depth + 1);
    if (placed !== descriptor.value) {
      copy ??= Object.defineProperties({}, Object.getOwnPropertyDescriptors(value));
      Object.defineProperty(copy, key, { ...descriptor, value: placed });
    }
  }
  return copy ?? value;
}
var PieceSender = class {
  /** @param {(piece: Object, transfer: ArrayBuffer[]) => void} post */
  constructor(post) {
    this._post = post;
    this._next = 0;
  }
  /**
   * Start an array of `length` elements of `ArrayType` sent as it is made:
   * `put(offset, values)` posts one piece (`values` is transferred, so the
   * caller lets it go); `result` is its placeholder.
   *
   * @param {new (length: number) => ArrayBufferView} ArrayType
   * @param {number} length
   * @returns {{put: (offset: number, values: ArrayBufferView) => void, result: {arrayPieces: number}}}
   */
  begin(ArrayType, length) {
    const array = this._next++;
    const type = ArrayType.name;
    typedArrayOf(type);
    return {
      put: (offset, values) => {
        if (!canTransfer(values)) throw new TypeError("A piece is a whole buffer of its own.");
        this._post({ array, type, length, offset, values }, [values.buffer]);
      },
      result: placeholder(array)
    };
  }
  /**
   * Send a whole array in pieces of at most `ARRAY_PIECE_BYTES`; its placeholder.
   *
   * @param {ArrayBufferView} view
   * @returns {{arrayPieces: number}}
   */
  send(view) {
    const sink = this.begin(view.constructor, view.length);
    for (const { offset, values } of arrayPieces(view)) sink.put(offset, values);
    if (view.length === 0) sink.put(0, sameKind(view, 0));
    return sink.result;
  }
};

// assets/js/utils/listener-set.js
function reportListenerFailure(name, error) {
  console.error(`[cellucid] A listener of ${name} failed:`, error);
}
function createListenerSet(name) {
  if (typeof name !== "string" || name.trim() === "") throw new TypeError("A listener set has a name.");
  const listeners = /* @__PURE__ */ new Map();
  function tell(isCurrent, args) {
    if (listeners.size === 0) return true;
    for (const [listener, subscription] of [...listeners]) {
      if (listeners.get(listener) !== subscription) continue;
      try {
        listener(...args);
      } catch (error) {
        reportListenerFailure(name, error);
      }
      if (isCurrent !== null && !isCurrent()) return false;
    }
    return true;
  }
  return Object.freeze({
    add(listener) {
      if (typeof listener !== "function") throw new TypeError(`A listener of ${name} is a function.`);
      let subscription = listeners.get(listener);
      if (subscription === void 0) {
        subscription = {};
        listeners.set(listener, subscription);
      }
      const own = subscription;
      return () => {
        if (listeners.get(listener) === own) listeners.delete(listener);
      };
    },
    delete(listener) {
      return listeners.delete(listener);
    },
    notify(...args) {
      tell(null, args);
    },
    notifyWhile(isCurrent, ...args) {
      if (typeof isCurrent !== "function") throw new TypeError(`What keeps a notice of ${name} current is a function.`);
      return tell(isCurrent, args) && isCurrent();
    },
    clear() {
      listeners.clear();
    },
    get size() {
      return listeners.size;
    }
  });
}

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
  return cancelled("user", "The work was canceled.", reason);
}
var SIGNAL_ABORTED = typeof AbortSignal === "function" ? Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get ?? null : null;
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
          reportListenerFailure("a signal aborting", error);
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

// assets/js/workers/worker-script.js
var THIS_MACHINE_HOSTS = Object.freeze(["localhost", "127.0.0.1", "[::1]"]);
var THIS_MACHINE = new Set(THIS_MACHINE_HOSTS);
var failureListeners = createListenerSet("a worker's script failing");
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

// assets/js/utils/loopback.js
function bareHost(hostname) {
  return String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "");
}
function isSecureContextLoopbackHost(hostname) {
  const host = bareHost(hostname);
  return host === "localhost" || host.endsWith(".localhost") || /^127(?:\.\d{1,3}){3}$/.test(host) || host === "::1";
}
function isLoopbackHostname(hostname) {
  return isSecureContextLoopbackHost(hostname) || bareHost(hostname) === "0.0.0.0";
}
function isLoopbackUrl(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  return (url.protocol === "http:" || url.protocol === "https:") && isLoopbackHostname(url.hostname);
}

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
  channel = null,
  online = () => globalThis.navigator?.onLine !== false
} = {}) {
  const hosts = /* @__PURE__ */ new Map();
  const lostAt = /* @__PURE__ */ new Map();
  let answeredAt = -Infinity;
  const paceWatchers = createListenerSet("a host's pace");
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
        lastSentAt: -Infinity,
        // The quickest answer it gave (from its request sent to the answer):
        // no answer of it comes sooner, so a request lost sooner than half of
        // it never reached it (`lostOnThisSide`).
        fastestAnswerMs: Infinity
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
  function lose(host, address, onThisSide = false) {
    const loss = lossesOf(host, address);
    loss.thisSide = loss.streak === 0 ? onThisSide : loss.thisSide || onThisSide;
    const offline = !online();
    loss.offline = loss.streak === 0 ? offline : loss.offline && offline;
    loss.round++;
    loss.streak++;
    if (loss.streak < 2) return;
    loss.quietUntil = now() + Math.min(MAX_QUIET_MS, MIN_STALL_TIMEOUT_MS * 2 ** (loss.streak - 2));
    if (loss.streak === 2 && host.deliveries > 0 && !loss.thisSide) learnPace(host);
    const refused = host.queue.filter((waiter) => waiter.address === address);
    host.queue = host.queue.filter((waiter) => waiter.address !== address);
    for (const waiter of refused) waiter.refused();
  }
  function lostOnThisSide(host, elapsedMs) {
    if (!online()) return true;
    return elapsedMs !== null && Number.isFinite(host.fastestAnswerMs) && elapsedMs < host.fastestAnswerMs / 2;
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
    if (isLoopbackUrl(host.origin)) return;
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
    paceWatchers.notify(host.origin, paceMs);
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
      host.deliveredUrl = String(url);
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
     * The address of the host of `url` that last delivered to this realm, or
     * null: asked again, it tells a host that still serves this site (and
     * lets it read some of its files, not `url`) from one refusing it.
     */
    deliveredAddress(url) {
      const origin = originOf(url);
      return origin === null ? null : hosts.get(origin)?.deliveredUrl ?? null;
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
    /** Whether this computer says it is online (`navigator.onLine`; the book's `online`). */
    online() {
      return online();
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
     * a request canceled or ended as stalled). `onWait(info)` hears when the request waits
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
     * @returns {Answered|Promise<Answered>|null}
     */
    admit(url, { signal = null, onWait = null, waits = true, burst = false } = {}) {
      const origin = originOf(url);
      if (signal?.aborted) return Promise.reject(abortReason(signal));
      if (origin === null) return () => {
      };
      const host = hostOf(origin);
      const address = addressOf(typeof burst === "string" ? burst : url);
      let round = null;
      let sentMs = null;
      let probe = false;
      const answered = (response, { limiting = false, waitMs = null, lost = false } = {}) => {
        host.inFlight = Math.max(0, host.inFlight - 1);
        const elapsedMs = sentMs === null ? null : now() - sentMs;
        if (probe) {
          const loss2 = host.losses.get(address);
          if (loss2 !== void 0) loss2.probing = false;
        }
        if (response === null && lost) {
          if (burst && round === (host.losses.get(address)?.round ?? 0)) lose(host, address, lostOnThisSide(host, elapsedMs));
          if (host.deliveries > 0) lostAt.set(siteOf(origin), now());
        } else if (response !== null) {
          answeredAt = now();
          lostAt.delete(siteOf(origin));
          host.losses.delete(address);
          if (elapsedMs !== null) host.fastestAnswerMs = Math.min(host.fastestAnswerMs, elapsedMs);
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
      if (loss !== void 0 && loss.offline && online() && loss.quietUntil > now()) {
        loss.quietUntil = -Infinity;
        loss.probing = false;
      }
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
        sentMs = now();
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
            sentMs = now();
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
     * (Zenodo: 60 s / 133, 0.45 s; the window learned from the longest reset
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
    /** Hear every host's pace as it is learned or told (`(origin, paceMs) => void`); returns what stops it. */
    watchPace(listener) {
      return paceWatchers.add(listener);
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

// assets/js/dev/benchmark.js
var glbBufferPromises = /* @__PURE__ */ new Map();
var MEBIBYTE = 1024 * 1024;
function requireSyntheticPointCount(count2) {
  if (!Number.isSafeInteger(count2) || count2 < MIN_SYNTHETIC_COUNT || count2 > MAX_SYNTHETIC_COUNT) {
    throw new RangeError(
      `Synthetic point count must be one integer between ${MIN_SYNTHETIC_COUNT} and ${MAX_SYNTHETIC_COUNT}; received ${String(count2)}.`
    );
  }
  return count2;
}
function hueToRgbChannel(p, q, rawT) {
  let t = rawT;
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}
function normalizedByte(value) {
  return Math.round(Math.max(0, Math.min(1, value)) * 255);
}
var DEFAULT_SYNTHETIC_SEED = 6221086;
function createSeededUnitStream(seed) {
  if (!Number.isSafeInteger(seed)) {
    throw new TypeError("Synthetic generation seed must be one safe integer.");
  }
  let state = seed >>> 0;
  return function nextUnit() {
    state = state + 2654435769 >>> 0;
    let z = state;
    z = Math.imul(z ^ z >>> 16, 569420461) >>> 0;
    z = Math.imul(z ^ z >>> 15, 1935289751) >>> 0;
    z = (z ^ z >>> 15) >>> 0;
    return z / 4294967296;
  };
}
var activeSyntheticSeed = DEFAULT_SYNTHETIC_SEED;
var syntheticUnitRandom = createSeededUnitStream(activeSyntheticSeed);
function restartSyntheticStream() {
  syntheticUnitRandom = createSeededUnitStream(activeSyntheticSeed);
}
var GLBParser = class {
  /**
   * Parse a GLB file and extract mesh data
   * @param {ArrayBuffer} buffer - The GLB file data
   * @returns {Object} - { positions: Float32Array, indices: Uint32Array, normals?: Float32Array }
   */
  static parse(buffer) {
    const view = new DataView(buffer);
    const magic = view.getUint32(0, true);
    if (magic !== 1179937895) {
      throw new Error("Invalid GLB magic number");
    }
    const version = view.getUint32(4, true);
    if (version !== 2) {
      throw new Error(`Unsupported GLB version: ${version}`);
    }
    let offset = 12;
    let jsonChunk = null;
    let binChunk = null;
    while (offset < buffer.byteLength) {
      const chunkLength = view.getUint32(offset, true);
      const chunkType = view.getUint32(offset + 4, true);
      const chunkData = buffer.slice(offset + 8, offset + 8 + chunkLength);
      if (chunkType === 1313821514) {
        const decoder = new TextDecoder("utf-8");
        jsonChunk = JSON.parse(decoder.decode(chunkData));
      } else if (chunkType === 5130562) {
        binChunk = chunkData;
      }
      offset += 8 + chunkLength;
    }
    if (!jsonChunk || !binChunk) {
      throw new Error("GLB missing JSON or BIN chunk");
    }
    return this._extractMeshData(jsonChunk, binChunk);
  }
  static _extractMeshData(gltf, binBuffer) {
    const accessors = gltf.accessors;
    const bufferViews = gltf.bufferViews;
    const copyToAligned = (srcBuffer, byteOffset, byteLength, TypedArrayClass) => {
      const srcView = new Uint8Array(srcBuffer, byteOffset, byteLength);
      const alignedBuffer = new ArrayBuffer(byteLength);
      new Uint8Array(alignedBuffer).set(srcView);
      return new TypedArrayClass(alignedBuffer);
    };
    const allPositions = [];
    const allIndices = [];
    let vertexOffset = 0;
    for (const mesh of gltf.meshes || []) {
      for (const primitive of mesh.primitives || []) {
        const posAccessorIdx = primitive.attributes?.POSITION;
        if (posAccessorIdx === void 0) continue;
        const posAccessor = accessors[posAccessorIdx];
        const posView = bufferViews[posAccessor.bufferView];
        const posOffset = (posView.byteOffset || 0) + (posAccessor.byteOffset || 0);
        const posByteLength = posAccessor.count * 3 * 4;
        const positions2 = copyToAligned(binBuffer, posOffset, posByteLength, Float32Array);
        allPositions.push(positions2);
        if (primitive.indices !== void 0) {
          const idxAccessor = accessors[primitive.indices];
          const idxView = bufferViews[idxAccessor.bufferView];
          const idxOffset = (idxView.byteOffset || 0) + (idxAccessor.byteOffset || 0);
          let indices2;
          if (idxAccessor.componentType === 5123) {
            const idxByteLength = idxAccessor.count * 2;
            const shortIndices = copyToAligned(binBuffer, idxOffset, idxByteLength, Uint16Array);
            indices2 = new Uint32Array(shortIndices);
          } else if (idxAccessor.componentType === 5125) {
            const idxByteLength = idxAccessor.count * 4;
            indices2 = copyToAligned(binBuffer, idxOffset, idxByteLength, Uint32Array);
          } else if (idxAccessor.componentType === 5121) {
            const byteIndices = new Uint8Array(binBuffer, idxOffset, idxAccessor.count);
            indices2 = new Uint32Array(byteIndices);
          }
          if (indices2) {
            const offsetIndices = new Uint32Array(indices2.length);
            for (let i = 0; i < indices2.length; i++) {
              offsetIndices[i] = indices2[i] + vertexOffset;
            }
            allIndices.push(offsetIndices);
          }
        }
        vertexOffset += posAccessor.count;
      }
    }
    if (allPositions.length === 0) {
      throw new Error("No meshes with positions found in GLB");
    }
    const totalVertices = allPositions.reduce((sum, p) => sum + p.length, 0);
    const positions = new Float32Array(totalVertices);
    let offset = 0;
    for (const p of allPositions) {
      positions.set(p, offset);
      offset += p.length;
    }
    let indices = null;
    if (allIndices.length > 0) {
      const totalIndices = allIndices.reduce((sum, i) => sum + i.length, 0);
      indices = new Uint32Array(totalIndices);
      offset = 0;
      for (const i of allIndices) {
        indices.set(i, offset);
        offset += i.length;
      }
    }
    console.log(`[GLBParser] Merged ${allPositions.length} primitives: ${formatCountOf(positions.length / 3, "vertex", "vertices")}, ${formatCountOf(indices ? indices.length / 3 : 0, "triangle")}`);
    return { positions, indices, normals: null };
  }
};
var MeshSurfaceSampler = class {
  /**
   * @param {Float32Array} positions - XYZ vertices.
   * @param {Uint8Array|Uint16Array|Uint32Array|null} indices - Triangle indices.
   * @param {(() => number)|null} [unitRandom] - Unit-interval source. Defaults
   *   to the module's seeded generation stream, so a sampler built during a
   *   generator call inherits that call's determinism.
   */
  constructor(positions, indices, unitRandom = null) {
    if (!(positions instanceof Float32Array) || positions.length < 9 || positions.length % 3 !== 0) {
      throw new TypeError(
        "Mesh surface positions must be non-empty Float32 XYZ vertices."
      );
    }
    if (indices !== null && !(indices instanceof Uint8Array || indices instanceof Uint16Array || indices instanceof Uint32Array)) {
      throw new TypeError(
        "Mesh surface indices must be null or an unsigned integer array."
      );
    }
    if (indices !== null && (indices.length < 3 || indices.length % 3 !== 0)) {
      throw new TypeError(
        "Mesh surface indices must contain complete triangles."
      );
    }
    if (indices === null && positions.length % 9 !== 0) {
      throw new TypeError(
        "A non-indexed mesh must contain complete triangle vertices."
      );
    }
    if (unitRandom !== null && typeof unitRandom !== "function") {
      throw new TypeError(
        "Mesh surface unit-random source must be null or a function."
      );
    }
    this.positions = positions;
    this.indices = indices;
    this._unitRandom = unitRandom;
    this.triangleCount = indices ? indices.length / 3 : positions.length / 9;
    this.areas = new Float64Array(this.triangleCount);
    this.cumulativeAreas = new Float64Array(this.triangleCount);
    this.triangleData = new Float32Array(this.triangleCount * 12);
    this.totalArea = 0;
    this._computeAreas();
  }
  _computeAreas() {
    const positions = this.positions;
    const indices = this.indices;
    const vertexCount = positions.length / 3;
    for (let i = 0; i < this.triangleCount; i++) {
      const triangleOffset = i * 3;
      const i0 = indices === null ? triangleOffset : indices[triangleOffset];
      const i1 = indices === null ? triangleOffset + 1 : indices[triangleOffset + 1];
      const i2 = indices === null ? triangleOffset + 2 : indices[triangleOffset + 2];
      if (i0 >= vertexCount || i1 >= vertexCount || i2 >= vertexCount) {
        throw new RangeError(
          `Mesh triangle ${i} references a vertex outside the mesh.`
        );
      }
      const v0Offset = i0 * 3;
      const v1Offset = i1 * 3;
      const v2Offset = i2 * 3;
      const x0 = positions[v0Offset];
      const y0 = positions[v0Offset + 1];
      const z0 = positions[v0Offset + 2];
      const ax = positions[v1Offset] - x0;
      const ay = positions[v1Offset + 1] - y0;
      const az = positions[v1Offset + 2] - z0;
      const bx = positions[v2Offset] - x0;
      const by = positions[v2Offset + 1] - y0;
      const bz = positions[v2Offset + 2] - z0;
      const cx = ay * bz - az * by;
      const cy = az * bx - ax * bz;
      const cz = ax * by - ay * bx;
      const crossLength = Math.sqrt(cx * cx + cy * cy + cz * cz);
      const area = 0.5 * crossLength;
      if (!Number.isFinite(area)) {
        throw new RangeError(
          `Mesh triangle ${i} has non-finite geometry.`
        );
      }
      const dataOffset = i * 12;
      this.triangleData[dataOffset] = x0;
      this.triangleData[dataOffset + 1] = y0;
      this.triangleData[dataOffset + 2] = z0;
      this.triangleData[dataOffset + 3] = ax;
      this.triangleData[dataOffset + 4] = ay;
      this.triangleData[dataOffset + 5] = az;
      this.triangleData[dataOffset + 6] = bx;
      this.triangleData[dataOffset + 7] = by;
      this.triangleData[dataOffset + 8] = bz;
      if (crossLength > 0) {
        this.triangleData[dataOffset + 9] = cx / crossLength;
        this.triangleData[dataOffset + 10] = cy / crossLength;
        this.triangleData[dataOffset + 11] = cz / crossLength;
      }
      this.areas[i] = area;
      this.totalArea += area;
      this.cumulativeAreas[i] = this.totalArea;
    }
    if (!Number.isFinite(this.totalArea) || this.totalArea <= 0) {
      throw new RangeError(
        "Mesh surface must contain at least one finite non-degenerate triangle."
      );
    }
  }
  /**
   * Binary search to find triangle index
   */
  _binarySearchTriangle(r) {
    let lo = 0, hi = this.triangleCount - 1;
    while (lo < hi) {
      const mid = lo + hi >>> 1;
      if (this.cumulativeAreas[mid] <= r) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }
  /**
   * Internal allocation-free sample used by the tens-of-millions generator.
   */
  _sampleIntoUnchecked(positionTarget, positionOffset, normalTarget, normalOffset) {
    const nextUnit = this._unitRandom === null ? syntheticUnitRandom : this._unitRandom;
    const r = nextUnit() * this.totalArea;
    const triIdx = this._binarySearchTriangle(r);
    const dataOffset = triIdx * 12;
    let u = nextUnit();
    let v = nextUnit();
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }
    const triangleData = this.triangleData;
    positionTarget[positionOffset] = triangleData[dataOffset] + u * triangleData[dataOffset + 3] + v * triangleData[dataOffset + 6];
    positionTarget[positionOffset + 1] = triangleData[dataOffset + 1] + u * triangleData[dataOffset + 4] + v * triangleData[dataOffset + 7];
    positionTarget[positionOffset + 2] = triangleData[dataOffset + 2] + u * triangleData[dataOffset + 5] + v * triangleData[dataOffset + 8];
    normalTarget[normalOffset] = triangleData[dataOffset + 9];
    normalTarget[normalOffset + 1] = triangleData[dataOffset + 10];
    normalTarget[normalOffset + 2] = triangleData[dataOffset + 11];
  }
  /**
   * Sample into caller-owned buffers.
   *
   * @param {Float32Array|Float64Array} positionTarget
   * @param {number} positionOffset
   * @param {Float32Array|Float64Array} normalTarget
   * @param {number} normalOffset
   */
  sampleInto(positionTarget, positionOffset, normalTarget, normalOffset = 0) {
    if (!(positionTarget instanceof Float32Array || positionTarget instanceof Float64Array) || !(normalTarget instanceof Float32Array || normalTarget instanceof Float64Array)) {
      throw new TypeError(
        "Mesh samples require floating-point position and normal targets."
      );
    }
    if (!Number.isSafeInteger(positionOffset) || positionOffset < 0 || positionOffset + 3 > positionTarget.length || !Number.isSafeInteger(normalOffset) || normalOffset < 0 || normalOffset + 3 > normalTarget.length) {
      throw new RangeError(
        "Mesh sample target offsets must own three writable values."
      );
    }
    this._sampleIntoUnchecked(
      positionTarget,
      positionOffset,
      normalTarget,
      normalOffset
    );
  }
  /**
   * Sample a random point on the mesh surface.
   *
   * @returns {{position: number[], normal: number[]}}
   */
  sample() {
    const position = new Float64Array(3);
    const normal = new Float64Array(3);
    this._sampleIntoUnchecked(position, 0, normal, 0);
    return {
      position: Array.from(position),
      normal: Array.from(normal)
    };
  }
};
var SyntheticDataGenerator = class {
  /**
   * The seed the next generator call will restart from.
   *
   * @returns {number} Active seed.
   */
  static get seed() {
    return activeSyntheticSeed;
  }
  /**
   * Vary the dataset deliberately. Comparing two runs is only meaningful when
   * they share a seed, so this is the single place a run declares that it
   * wants a different point cloud rather than getting one by accident.
   *
   * @param {number} seed - Safe-integer seed.
   * @returns {number} The accepted seed.
   */
  static setSeed(seed) {
    if (!Number.isSafeInteger(seed)) {
      throw new TypeError("Synthetic generation seed must be one safe integer.");
    }
    activeSyntheticSeed = seed;
    restartSyntheticStream();
    return activeSyntheticSeed;
  }
  /**
   * Generate octopus-like structure with body and tentacles
   */
  static octopus(count2, numTentacles = 10) {
    requireSyntheticPointCount(count2);
    restartSyntheticStream();
    console.log(`Generating ${formatCountOf(count2, "point")} (octopus with ${numTentacles} tentacles)...`);
    const startTime = performance.now();
    const positions = allocateLargeArray(Float32Array, count2 * 3);
    const colors = allocateLargeArray(Uint8Array, count2 * 4);
    const bodyRadius = 0.36;
    const bodyCenter = [0, 0.28, 0];
    const bodyFreq = 0.4;
    const bodyHotspots = Array.from({ length: 5 }, () => ({
      theta: syntheticUnitRandom() * Math.PI * 2,
      phi: Math.PI * 0.5 + (syntheticUnitRandom() - 0.5) * 0.4,
      boost: 0.4 + syntheticUnitRandom() * 0.7
    }));
    const tentacleLength = 1.1;
    const tentacleThickness = 0.055;
    const tentacleWave = 0.18;
    const tentacleFreq = (1 - bodyFreq) / numTentacles;
    const bodyColor = [0.9, 0.4, 0.3];
    const tentacles = [];
    for (let t = 0; t < numTentacles; t++) {
      const baseAngle = t / numTentacles * Math.PI * 2 + (syntheticUnitRandom() - 0.5) * 0.28;
      const tiltAngle = Math.PI * 0.58 + (syntheticUnitRandom() - 0.5) * 0.32;
      const hue = 0.02 + t * 0.015;
      const wrapTurns = 2.5 + syntheticUnitRandom() * 2.5;
      const wrapRadius = 0.35 + syntheticUnitRandom() * 0.35;
      const wrapPhase = syntheticUnitRandom() * Math.PI * 2;
      const wobblePhase = syntheticUnitRandom() * Math.PI * 2;
      const suctionBands = 3 + Math.floor(syntheticUnitRandom() * 4);
      tentacles.push({ baseAngle, tiltAngle, hue, wrapTurns, wrapRadius, wrapPhase, wobblePhase, suctionBands });
    }
    for (let i = 0; i < count2; i++) {
      const idx = i * 3;
      const r = syntheticUnitRandom();
      if (r < bodyFreq) {
        const hotspot = bodyHotspots[Math.floor(syntheticUnitRandom() * bodyHotspots.length)];
        const useHotspot = syntheticUnitRandom() < 0.65;
        const theta = useHotspot ? hotspot.theta + (syntheticUnitRandom() - 0.5) * 0.35 : syntheticUnitRandom() * Math.PI * 2;
        const phi = useHotspot ? hotspot.phi + (syntheticUnitRandom() - 0.5) * 0.35 : Math.acos(2 * syntheticUnitRandom() - 1);
        const radiusScale = useHotspot ? hotspot.boost : 1;
        const radius = bodyRadius * (0.3 + Math.pow(syntheticUnitRandom(), useHotspot ? 1.35 : 1.8) * 0.9) * radiusScale;
        positions[idx] = bodyCenter[0] + radius * Math.sin(phi) * Math.cos(theta) * 1.35;
        positions[idx + 1] = bodyCenter[1] + radius * Math.cos(phi) * 0.9;
        positions[idx + 2] = bodyCenter[2] + radius * Math.sin(phi) * Math.sin(theta) * 1.35;
        const cidx = i * 4;
        colors[cidx] = Math.round(Math.max(0, Math.min(1, bodyColor[0] + (syntheticUnitRandom() - 0.5) * 0.12)) * 255);
        colors[cidx + 1] = Math.round(Math.max(0, Math.min(1, bodyColor[1] + (syntheticUnitRandom() - 0.5) * 0.12)) * 255);
        colors[cidx + 2] = Math.round(Math.max(0, Math.min(1, bodyColor[2] + (syntheticUnitRandom() - 0.5) * 0.12)) * 255);
        colors[cidx + 3] = 255;
      } else {
        const tentacleIdx = Math.floor((r - bodyFreq) / tentacleFreq);
        const tent = tentacles[Math.min(tentacleIdx, numTentacles - 1)];
        const t = Math.pow(syntheticUnitRandom(), 1.35);
        const thickness = tentacleThickness * (1.1 - t * 0.5);
        const baseX = bodyCenter[0] + bodyRadius * 0.85 * Math.sin(tent.tiltAngle) * Math.cos(tent.baseAngle);
        const baseY = bodyCenter[1] - bodyRadius * 0.55 + this._gaussianRandom() * 0.015;
        const baseZ = bodyCenter[2] + bodyRadius * 0.85 * Math.sin(tent.tiltAngle) * Math.sin(tent.baseAngle);
        const wave1 = Math.sin(t * Math.PI * 4 + tent.wobblePhase) * tentacleWave * t * 1.2;
        const wave2 = Math.cos(t * Math.PI * 3.5 + tent.wobblePhase * 0.8) * tentacleWave * t;
        const wrapAngle = tent.wrapPhase + t * tent.wrapTurns * Math.PI * 2;
        const wrapR = tent.wrapRadius * (1 - t * 0.35);
        const swirlX = Math.cos(wrapAngle) * wrapR;
        const swirlZ = Math.sin(wrapAngle) * wrapR;
        const bend = Math.sin(t * Math.PI * tent.suctionBands) * 0.25;
        const tentX = baseX + t * tentacleLength * Math.sin(tent.tiltAngle + bend * 0.35) * Math.cos(tent.baseAngle + bend) + wave1 + swirlX;
        const tentY = baseY - t * tentacleLength * (0.95 - 0.25 * t) + Math.sin(t * Math.PI * 2) * 0.05;
        const tentZ = baseZ + t * tentacleLength * Math.sin(tent.tiltAngle + bend * 0.35) * Math.sin(tent.baseAngle + bend) + wave2 + swirlZ;
        const thickAngle = syntheticUnitRandom() * Math.PI * 2;
        const ring = (Math.sin(t * tent.suctionBands * Math.PI * 2 + tent.wobblePhase) + 1) * 0.5;
        const thickR = Math.sqrt(syntheticUnitRandom()) * thickness * (1 + ring * 0.65);
        positions[idx] = tentX + thickR * Math.cos(thickAngle);
        positions[idx + 1] = tentY + thickR * Math.sin(thickAngle) * 0.6;
        positions[idx + 2] = tentZ + thickR * Math.sin(thickAngle);
        const tentColor = this._hslToRgb(tent.hue, 0.72, 0.48 - t * 0.22 + ring * 0.08);
        const cidx = i * 4;
        colors[cidx] = Math.round(Math.max(0, Math.min(1, tentColor[0] + (syntheticUnitRandom() - 0.5) * 0.08)) * 255);
        colors[cidx + 1] = Math.round(Math.max(0, Math.min(1, tentColor[1] + (syntheticUnitRandom() - 0.5) * 0.08)) * 255);
        colors[cidx + 2] = Math.round(Math.max(0, Math.min(1, tentColor[2] + (syntheticUnitRandom() - 0.5) * 0.08)) * 255);
        colors[cidx + 3] = 255;
      }
    }
    const elapsed = performance.now() - startTime;
    console.log(`Generated in ${elapsed.toFixed(0)}ms`);
    return { positions, colors, dimensionLevel: 3 };
  }
  /**
   * Generate 3D spiral/helix structures
   */
  static spirals(count2, numSpirals = 7) {
    requireSyntheticPointCount(count2);
    restartSyntheticStream();
    console.log(`Generating ${formatCountOf(count2, "point")} (${numSpirals} spirals)...`);
    const startTime = performance.now();
    const positions = allocateLargeArray(Float32Array, count2 * 3);
    const colors = allocateLargeArray(Uint8Array, count2 * 4);
    const spiralConfigs = [];
    const globalBraidPhase = syntheticUnitRandom() * Math.PI * 2;
    for (let s = 0; s < numSpirals; s++) {
      spiralConfigs.push({
        // Starting position
        startX: (syntheticUnitRandom() - 0.5) * 0.8,
        startY: (syntheticUnitRandom() - 0.5) * 0.8,
        startZ: (syntheticUnitRandom() - 0.5) * 0.8,
        // Direction (normalized)
        dirTheta: syntheticUnitRandom() * Math.PI * 2,
        dirPhi: Math.PI * 0.35 + syntheticUnitRandom() * Math.PI * 0.6,
        // Spiral parameters
        radius: 0.18 + syntheticUnitRandom() * 0.18,
        length: 0.9 + syntheticUnitRandom() * 1.1,
        turns: 4 + syntheticUnitRandom() * 4,
        thickness: 0.035 + syntheticUnitRandom() * 0.035,
        // Color
        hue: s / Math.max(1, numSpirals - 1),
        // Taper
        taper: syntheticUnitRandom() < 0.65,
        orbitRadius: 0.25 + syntheticUnitRandom() * 0.25,
        orbitTurns: 2 + syntheticUnitRandom() * 3,
        strandCount: 2 + Math.floor(syntheticUnitRandom() * 3),
        kink: 0.06 + syntheticUnitRandom() * 0.08,
        noiseFreq: 2 + syntheticUnitRandom() * 4,
        orbitPhase: globalBraidPhase + (syntheticUnitRandom() - 0.5) * Math.PI
      });
    }
    const pointsPerSpiral = Math.max(1, Math.floor(count2 / numSpirals));
    for (let i = 0; i < count2; i++) {
      const idx = i * 3;
      const spiralIdx = Math.min(Math.floor(i / pointsPerSpiral), numSpirals - 1);
      const sp = spiralConfigs[spiralIdx];
      const t = Math.pow(syntheticUnitRandom(), 1.25);
      const dirX = Math.sin(sp.dirPhi) * Math.cos(sp.dirTheta);
      const dirY = Math.cos(sp.dirPhi);
      const dirZ = Math.sin(sp.dirPhi) * Math.sin(sp.dirTheta);
      const perpX = -Math.sin(sp.dirTheta);
      const perpZ = Math.cos(sp.dirTheta);
      const perp2X = -Math.cos(sp.dirPhi) * Math.cos(sp.dirTheta);
      const perp2Y = Math.sin(sp.dirPhi);
      const perp2Z = -Math.cos(sp.dirPhi) * Math.sin(sp.dirTheta);
      const orbitAngle = sp.orbitPhase + t * sp.orbitTurns * Math.PI * 2;
      const orbitR = sp.orbitRadius * (1 - t * 0.3);
      const strandPhase = Math.floor(syntheticUnitRandom() * sp.strandCount) / sp.strandCount * Math.PI * 2;
      const wobble = Math.sin(t * sp.noiseFreq * Math.PI * 2 + sp.orbitPhase) * sp.kink + Math.cos(t * sp.noiseFreq * Math.PI + sp.orbitPhase * 0.5) * sp.kink * 0.5;
      const angle = t * sp.turns * Math.PI * 2 + strandPhase + wobble;
      const radius = sp.taper ? sp.radius * (1 - t * 0.6) : sp.radius;
      const spiralX = sp.startX + t * sp.length * dirX + radius * (Math.cos(angle) * perpX + Math.sin(angle) * perp2X);
      const spiralY = sp.startY + t * sp.length * dirY + radius * (Math.sin(angle) * perp2Y + Math.cos(angle) * 0.05);
      const spiralZ = sp.startZ + t * sp.length * dirZ + radius * (Math.cos(angle) * perpZ + Math.sin(angle) * perp2Z);
      const braidedX = spiralX + Math.cos(orbitAngle) * orbitR;
      const braidedY = spiralY + Math.sin(orbitAngle * 0.5) * sp.kink * 0.8;
      const braidedZ = spiralZ + Math.sin(orbitAngle) * orbitR;
      const thick = sp.thickness * (1.25 - t * 0.35);
      positions[idx] = braidedX + this._gaussianRandom() * thick;
      positions[idx + 1] = braidedY + this._gaussianRandom() * thick * 0.9;
      positions[idx + 2] = braidedZ + this._gaussianRandom() * thick;
      const band = (Math.sin(angle * 0.5 + sp.orbitPhase) + 1) * 0.12;
      const color = this._hslToRgb((sp.hue + t * 0.12 + band * 0.1) % 1, 0.78, 0.42 + t * 0.18 + band * 0.15);
      const cidx = i * 4;
      colors[cidx] = Math.round(Math.max(0, Math.min(1, color[0] + (syntheticUnitRandom() - 0.5) * 0.08)) * 255);
      colors[cidx + 1] = Math.round(Math.max(0, Math.min(1, color[1] + (syntheticUnitRandom() - 0.5) * 0.08)) * 255);
      colors[cidx + 2] = Math.round(Math.max(0, Math.min(1, color[2] + (syntheticUnitRandom() - 0.5) * 0.08)) * 255);
      colors[cidx + 3] = 255;
    }
    const elapsed = performance.now() - startTime;
    console.log(`Generated in ${elapsed.toFixed(0)}ms`);
    return { positions, colors, dimensionLevel: 3 };
  }
  /**
   * Generate 2D UMAP-like flat structure with clusters
   */
  static flatUMAP(count2, numClusters = 25) {
    requireSyntheticPointCount(count2);
    restartSyntheticStream();
    console.log(`Generating ${formatCountOf(count2, "point")} (2D UMAP, ${formatCountOf(numClusters, "cluster")})...`);
    const startTime = performance.now();
    const positions = allocateLargeArray(Float32Array, count2 * 2);
    const colors = allocateLargeArray(Uint8Array, count2 * 4);
    const clusters = [];
    for (let c = 0; c < numClusters; c++) {
      let cx, cy, attempts = 0;
      do {
        cx = (syntheticUnitRandom() - 0.5) * 1.8;
        cy = (syntheticUnitRandom() - 0.5) * 1.8;
        attempts++;
      } while (attempts < 50 && clusters.some(
        (cl) => Math.hypot(cl.center[0] - cx, cl.center[1] - cy) < 0.2
      ));
      const isElongated = syntheticUnitRandom() < 0.4;
      const angle = syntheticUnitRandom() * Math.PI;
      clusters.push({
        center: [cx, cy],
        spread: 0.04 + syntheticUnitRandom() * 0.08,
        elongation: isElongated ? [1.5 + syntheticUnitRandom(), 0.4 + syntheticUnitRandom() * 0.3] : [1, 1],
        angle,
        color: this._hslToRgb(c / numClusters, 0.7, 0.5),
        weight: 0.5 + syntheticUnitRandom() * 1.5
      });
    }
    const numBridges = Math.floor(numClusters * 0.2);
    for (let b = 0; b < numBridges; b++) {
      const c1 = clusters[Math.floor(syntheticUnitRandom() * numClusters)];
      const c2 = clusters[Math.floor(syntheticUnitRandom() * numClusters)];
      if (c1 !== c2) {
        clusters.push({
          center: [(c1.center[0] + c2.center[0]) / 2, (c1.center[1] + c2.center[1]) / 2],
          spread: 0.02,
          isBridge: true,
          bridgeFrom: c1.center,
          bridgeTo: c2.center,
          color: [
            (c1.color[0] + c2.color[0]) / 2,
            (c1.color[1] + c2.color[1]) / 2,
            (c1.color[2] + c2.color[2]) / 2
          ],
          weight: 0.2
        });
      }
    }
    const totalWeight = clusters.reduce((s, c) => s + c.weight, 0);
    clusters.forEach((c) => c.weight /= totalWeight);
    let cumulative = 0;
    const cumDist = clusters.map((c) => {
      cumulative += c.weight;
      return cumulative;
    });
    for (let i = 0; i < count2; i++) {
      const idx = i * 2;
      const r = syntheticUnitRandom();
      let clusterIdx = cumDist.findIndex((c) => r <= c);
      if (clusterIdx < 0) clusterIdx = clusters.length - 1;
      const cluster = clusters[clusterIdx];
      let x, y;
      if (cluster.isBridge) {
        const t = syntheticUnitRandom();
        x = cluster.bridgeFrom[0] + t * (cluster.bridgeTo[0] - cluster.bridgeFrom[0]);
        y = cluster.bridgeFrom[1] + t * (cluster.bridgeTo[1] - cluster.bridgeFrom[1]);
        x += this._gaussianRandom() * cluster.spread;
        y += this._gaussianRandom() * cluster.spread;
      } else {
        let dx = this._gaussianRandom() * cluster.spread * cluster.elongation[0];
        let dy = this._gaussianRandom() * cluster.spread * cluster.elongation[1];
        const cos = Math.cos(cluster.angle);
        const sin = Math.sin(cluster.angle);
        x = cluster.center[0] + dx * cos - dy * sin;
        y = cluster.center[1] + dx * sin + dy * cos;
      }
      positions[idx] = x;
      positions[idx + 1] = y;
      const cidx = i * 4;
      colors[cidx] = Math.round(Math.max(0, Math.min(1, cluster.color[0] + (syntheticUnitRandom() - 0.5) * 0.06)) * 255);
      colors[cidx + 1] = Math.round(Math.max(0, Math.min(1, cluster.color[1] + (syntheticUnitRandom() - 0.5) * 0.06)) * 255);
      colors[cidx + 2] = Math.round(Math.max(0, Math.min(1, cluster.color[2] + (syntheticUnitRandom() - 0.5) * 0.06)) * 255);
      colors[cidx + 3] = 255;
    }
    const elapsed = performance.now() - startTime;
    console.log(`Generated in ${elapsed.toFixed(0)}ms`);
    return { positions, colors, dimensionLevel: 2 };
  }
  /**
   * Generate atlas-like data with multiscale clusters, bridges, and batches.
   * Designed to look closer to real embeddings while stressing LOD/culling.
   */
  static atlasLike(count2, options = {}) {
    requireSyntheticPointCount(count2);
    restartSyntheticStream();
    const {
      batches = 3,
      cellTypes = Math.max(16, Math.floor(count2 / 3500)),
      trajectoryFraction = 0.22,
      rareFraction = 0.05,
      layerDepth = 0.35,
      strongBatchEffects = false,
      label = "Atlas-like (multiscale clusters)"
    } = options;
    console.log(`Generating ${formatCountOf(count2, "point")} (${label})...`);
    const startTime = performance.now();
    const positions = allocateLargeArray(Float32Array, count2 * 3);
    const colors = allocateLargeArray(Uint8Array, count2 * 4);
    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    const safeCellTypes = Math.max(12, Math.min(45, Math.floor(cellTypes)));
    const trajFrac = clamp01(Math.min(0.35, trajectoryFraction));
    const rareFrac = clamp01(Math.min(0.12, rareFraction));
    const anchorFrac = clamp01(1 - trajFrac - rareFrac);
    const goldenAngle = 2.399963229728653;
    const batchOffsets = Array.from({ length: Math.max(1, Math.floor(batches)) }, () => ({
      offset: [
        (syntheticUnitRandom() - 0.5) * (strongBatchEffects ? 0.45 : 0.18),
        (syntheticUnitRandom() - 0.5) * (strongBatchEffects ? 0.35 : 0.14),
        (syntheticUnitRandom() - 0.5) * (strongBatchEffects ? 0.55 : 0.22)
      ],
      tint: (syntheticUnitRandom() - 0.5) * (strongBatchEffects ? 0.18 : 0.08)
    }));
    const anchors = [];
    for (let i = 0; i < safeCellTypes; i++) {
      const angle = i * goldenAngle + (syntheticUnitRandom() - 0.5) * 0.1;
      const radius = 0.25 + syntheticUnitRandom() * 1.15;
      const layer = (i % 3 - 1) * layerDepth * 0.5;
      const center = [
        Math.cos(angle) * radius + (syntheticUnitRandom() - 0.5) * 0.1,
        Math.sin(angle) * radius + (syntheticUnitRandom() - 0.5) * 0.1,
        layer
      ];
      const major = 0.025 + syntheticUnitRandom() * 0.05;
      const minor = major * (0.55 + syntheticUnitRandom() * 0.9);
      const theta = syntheticUnitRandom() * Math.PI;
      const color = this._hslToRgb(i / safeCellTypes, 0.68, 0.52);
      const weight = 0.6 + syntheticUnitRandom() * 1.6;
      anchors.push({
        center,
        spread: [major, minor],
        angle: theta,
        color,
        weight,
        layerOffset: layer + (syntheticUnitRandom() - 0.5) * 0.08,
        sin: Math.sin(theta),
        cos: Math.cos(theta)
      });
    }
    const anchorWeightTotal = anchors.reduce((s, a) => s + a.weight, 0);
    let anchorCum = 0;
    const anchorCumDist = anchors.map((a) => {
      anchorCum += a.weight / anchorWeightTotal;
      return anchorCum;
    });
    const trajectoryCount = Math.max(5, Math.floor(safeCellTypes * 0.45));
    const trajectories = [];
    for (let t = 0; t < trajectoryCount; t++) {
      const a = anchors[Math.floor(syntheticUnitRandom() * anchors.length)];
      let b = anchors[Math.floor(syntheticUnitRandom() * anchors.length)];
      if (a === b) b = anchors[(anchors.indexOf(a) + 1) % anchors.length];
      const midX = (a.center[0] + b.center[0]) / 2 + (syntheticUnitRandom() - 0.5) * 0.25;
      const midY = (a.center[1] + b.center[1]) / 2 + (syntheticUnitRandom() - 0.5) * 0.25;
      const arch = (syntheticUnitRandom() - 0.5) * 0.25;
      const spread = 0.015 + syntheticUnitRandom() * 0.03;
      const weight = 0.4 + syntheticUnitRandom() * 1.1;
      trajectories.push({
        from: a,
        to: b,
        control: [midX, midY, (a.layerOffset + b.layerOffset) / 2 + arch],
        spread,
        weight
      });
    }
    const trajWeightTotal = trajectories.reduce((s, tr) => s + tr.weight, 0);
    let trajCum = 0;
    const trajCumDist = trajectories.map((tr) => {
      trajCum += tr.weight / trajWeightTotal;
      return trajCum;
    });
    const pickAnchor = () => {
      const r = syntheticUnitRandom();
      let idx = anchorCumDist.findIndex((c) => r <= c);
      if (idx < 0) idx = anchors.length - 1;
      return anchors[idx];
    };
    const pickTrajectory = () => {
      const r = syntheticUnitRandom();
      let idx = trajCumDist.findIndex((c) => r <= c);
      if (idx < 0) idx = trajectories.length - 1;
      return trajectories[idx];
    };
    const anchorPoints = Math.floor(count2 * anchorFrac);
    const trajectoryPoints = Math.floor(count2 * trajFrac);
    for (let i = 0; i < anchorPoints; i++) {
      const idx = i * 3;
      const batch = batchOffsets[Math.floor(syntheticUnitRandom() * batchOffsets.length)];
      const anchor = pickAnchor();
      const dx = this._gaussianRandom() * anchor.spread[0];
      const dy = this._gaussianRandom() * anchor.spread[1];
      positions[idx] = anchor.center[0] + dx * anchor.cos - dy * anchor.sin + batch.offset[0];
      positions[idx + 1] = anchor.center[1] + dx * anchor.sin + dy * anchor.cos + batch.offset[1];
      positions[idx + 2] = anchor.layerOffset + this._gaussianRandom() * 0.03 + batch.offset[2];
      const baseColor = anchor.color;
      const shade = (syntheticUnitRandom() - 0.5) * 0.08 + batch.tint;
      const cidx = i * 4;
      colors[cidx] = Math.round(clamp01(baseColor[0] + shade) * 255);
      colors[cidx + 1] = Math.round(clamp01(baseColor[1] + shade * 0.6) * 255);
      colors[cidx + 2] = Math.round(clamp01(baseColor[2] - shade * 0.6) * 255);
      colors[cidx + 3] = 255;
    }
    for (let i = anchorPoints; i < anchorPoints + trajectoryPoints; i++) {
      const idx = i * 3;
      const batch = batchOffsets[Math.floor(syntheticUnitRandom() * batchOffsets.length)];
      const traj = pickTrajectory();
      const t = syntheticUnitRandom();
      const eased = t * t * (3 - 2 * t);
      const inv = 1 - eased;
      const px = inv * inv * traj.from.center[0] + 2 * inv * eased * traj.control[0] + eased * eased * traj.to.center[0];
      const py = inv * inv * traj.from.center[1] + 2 * inv * eased * traj.control[1] + eased * eased * traj.to.center[1];
      const pz = inv * inv * traj.from.layerOffset + 2 * inv * eased * traj.control[2] + eased * eased * traj.to.layerOffset;
      positions[idx] = px + this._gaussianRandom() * traj.spread + batch.offset[0] * 0.6;
      positions[idx + 1] = py + this._gaussianRandom() * traj.spread + batch.offset[1] * 0.6;
      positions[idx + 2] = pz + this._gaussianRandom() * traj.spread * 0.6 + batch.offset[2] * 0.8;
      const mixColor = [
        traj.from.color[0] * (1 - eased) + traj.to.color[0] * eased,
        traj.from.color[1] * (1 - eased) + traj.to.color[1] * eased,
        traj.from.color[2] * (1 - eased) + traj.to.color[2] * eased
      ];
      const shade = (syntheticUnitRandom() - 0.5) * 0.06 + batch.tint * 0.6;
      const cidx = i * 4;
      colors[cidx] = Math.round(clamp01(mixColor[0] + shade) * 255);
      colors[cidx + 1] = Math.round(clamp01(mixColor[1] + shade * 0.6) * 255);
      colors[cidx + 2] = Math.round(clamp01(mixColor[2] - shade * 0.4) * 255);
      colors[cidx + 3] = 255;
    }
    for (let i = anchorPoints + trajectoryPoints; i < count2; i++) {
      const idx = i * 3;
      const batch = batchOffsets[Math.floor(syntheticUnitRandom() * batchOffsets.length)];
      if (syntheticUnitRandom() < 0.7) {
        const anchor = pickAnchor();
        const radius = anchor.spread[0] * (0.2 + syntheticUnitRandom() * 0.4);
        const theta = syntheticUnitRandom() * Math.PI * 2;
        positions[idx] = anchor.center[0] + Math.cos(theta) * radius + batch.offset[0] * (strongBatchEffects ? 1 : 0.4);
        positions[idx + 1] = anchor.center[1] + Math.sin(theta) * radius + batch.offset[1] * (strongBatchEffects ? 1 : 0.4);
        positions[idx + 2] = anchor.layerOffset + this._gaussianRandom() * 0.02 + batch.offset[2];
        const cidx = i * 4;
        const shade = 0.1 + (syntheticUnitRandom() - 0.5) * 0.08 + batch.tint;
        colors[cidx] = Math.round(clamp01(anchor.color[0] + shade) * 255);
        colors[cidx + 1] = Math.round(clamp01(anchor.color[1] + shade * 0.5) * 255);
        colors[cidx + 2] = Math.round(clamp01(anchor.color[2] - shade * 0.5) * 255);
        colors[cidx + 3] = 255;
      } else {
        positions[idx] = (syntheticUnitRandom() - 0.5) * 3 + batch.offset[0] * 0.5;
        positions[idx + 1] = (syntheticUnitRandom() - 0.5) * 3 + batch.offset[1] * 0.5;
        positions[idx + 2] = (syntheticUnitRandom() - 0.5) * (strongBatchEffects ? 2 : 1) + batch.offset[2] * 0.7;
        const cidx = i * 4;
        const base = this._hslToRgb(syntheticUnitRandom(), 0.2, 0.55);
        colors[cidx] = Math.round(clamp01(base[0]) * 255);
        colors[cidx + 1] = Math.round(clamp01(base[1]) * 255);
        colors[cidx + 2] = Math.round(clamp01(base[2]) * 255);
        colors[cidx + 3] = 200 + Math.floor(syntheticUnitRandom() * 55);
      }
    }
    const elapsed = performance.now() - startTime;
    console.log(`Generated in ${elapsed.toFixed(0)}ms`);
    return { positions, colors, dimensionLevel: 3 };
  }
  /**
   * Variant of atlasLike with intentionally strong batch shifts for stress tests.
   */
  static batchEffects(count2, batches = 4) {
    return this.atlasLike(count2, {
      batches,
      strongBatchEffects: true,
      trajectoryFraction: 0.18,
      rareFraction: 0.06,
      layerDepth: 0.65,
      label: "Batch effects (misaligned batches)"
    });
  }
  /**
   * Generate Gaussian clusters (100-200 clusters by default)
   */
  static gaussianClusters(count2, numClusters = 150, clusterSpread = 0.06) {
    requireSyntheticPointCount(count2);
    restartSyntheticStream();
    const actualClusters = numClusters === 150 ? 100 + Math.floor(syntheticUnitRandom() * 100) : numClusters;
    console.log(`Generating ${formatCountOf(count2, "point")} in ${formatCountOf(actualClusters, "cluster")}...`);
    const startTime = performance.now();
    const positions = allocateLargeArray(Float32Array, count2 * 3);
    const colors = allocateLargeArray(Uint8Array, count2 * 4);
    const clusters = [];
    for (let c = 0; c < actualClusters; c++) {
      const center = [
        (syntheticUnitRandom() - 0.5) * 2,
        (syntheticUnitRandom() - 0.5) * 2,
        (syntheticUnitRandom() - 0.5) * 2
      ];
      const size = clusterSpread * (0.5 + syntheticUnitRandom() * 1.5);
      const elongation = [
        0.5 + syntheticUnitRandom() * 1,
        0.5 + syntheticUnitRandom() * 1,
        0.5 + syntheticUnitRandom() * 1
      ];
      const hue = (Math.atan2(center[1], center[0]) / Math.PI + 1) / 2;
      const sat = 0.5 + center[2] * 0.25;
      const color = this._hslToRgb(hue, Math.max(0.4, Math.min(0.9, sat)), 0.5);
      const weight = 0.5 + syntheticUnitRandom() * 1.5;
      clusters.push({ center, size, elongation, color, weight });
    }
    const totalWeight = clusters.reduce((s, c) => s + c.weight, 0);
    clusters.forEach((c) => c.weight /= totalWeight);
    let cumulative = 0;
    const cumDist = clusters.map((c) => {
      cumulative += c.weight;
      return cumulative;
    });
    for (let i = 0; i < count2; i++) {
      const idx = i * 3;
      const r = syntheticUnitRandom();
      let clusterIdx = cumDist.findIndex((c) => r <= c);
      if (clusterIdx < 0) clusterIdx = actualClusters - 1;
      const cluster = clusters[clusterIdx];
      positions[idx] = cluster.center[0] + this._gaussianRandom() * cluster.size * cluster.elongation[0];
      positions[idx + 1] = cluster.center[1] + this._gaussianRandom() * cluster.size * cluster.elongation[1];
      positions[idx + 2] = cluster.center[2] + this._gaussianRandom() * cluster.size * cluster.elongation[2];
      const cidx = i * 4;
      colors[cidx] = Math.round(Math.max(0, Math.min(1, cluster.color[0] + (syntheticUnitRandom() - 0.5) * 0.1)) * 255);
      colors[cidx + 1] = Math.round(Math.max(0, Math.min(1, cluster.color[1] + (syntheticUnitRandom() - 0.5) * 0.1)) * 255);
      colors[cidx + 2] = Math.round(Math.max(0, Math.min(1, cluster.color[2] + (syntheticUnitRandom() - 0.5) * 0.1)) * 255);
      colors[cidx + 3] = 255;
    }
    const elapsed = performance.now() - startTime;
    console.log(`Generated in ${elapsed.toFixed(0)}ms`);
    return { positions, colors, dimensionLevel: 3 };
  }
  /**
   * Generate uniform random distribution
   */
  static uniformRandom(count2, scale = 2) {
    requireSyntheticPointCount(count2);
    restartSyntheticStream();
    console.log(`Generating ${formatCount(count2)} random ${countNoun(count2, "point")}...`);
    const startTime = performance.now();
    const positions = allocateLargeArray(Float32Array, count2 * 3);
    const colors = allocateLargeArray(Uint8Array, count2 * 4);
    for (let i = 0; i < count2; i++) {
      const idx = i * 3;
      positions[idx] = (syntheticUnitRandom() - 0.5) * scale * 2;
      positions[idx + 1] = (syntheticUnitRandom() - 0.5) * scale * 2;
      positions[idx + 2] = (syntheticUnitRandom() - 0.5) * scale * 2;
      const cidx = i * 4;
      colors[cidx] = Math.floor(syntheticUnitRandom() * 256);
      colors[cidx + 1] = Math.floor(syntheticUnitRandom() * 256);
      colors[cidx + 2] = Math.floor(syntheticUnitRandom() * 256);
      colors[cidx + 3] = 255;
    }
    const elapsed = performance.now() - startTime;
    console.log(`Generated in ${elapsed.toFixed(0)}ms`);
    return { positions, colors, dimensionLevel: 3 };
  }
  /**
   * Generate points by sampling from a GLB mesh surface
   * @param {number} count - Number of points to generate
   * @param {ArrayBuffer} glbBuffer - The loaded GLB file as ArrayBuffer
   * @returns {Object} - { positions: Float32Array, colors: Uint8Array (RGBA), dimensionLevel: number }
   */
  static fromGLB(count2, glbBuffer) {
    requireSyntheticPointCount(count2);
    restartSyntheticStream();
    if (!(glbBuffer instanceof ArrayBuffer) || glbBuffer.byteLength === 0) {
      throw new TypeError(
        "GLB benchmark input must be one non-empty ArrayBuffer."
      );
    }
    console.log(`[GLB] Sampling ${formatCountOf(count2, "point")} from GLB mesh...`);
    const startTime = performance.now();
    console.log("[GLB] Parsing GLB file...");
    const meshData = GLBParser.parse(glbBuffer);
    console.log(`[GLB] Parsed: ${formatCountOf(meshData.positions.length / 3, "vertex", "vertices")}, ${meshData.indices ? formatCountOf(meshData.indices.length / 3, "triangle") : "no triangles"} (${(performance.now() - startTime).toFixed(0)}ms)`);
    console.log("[GLB] Building surface sampler...");
    const sampler = new MeshSurfaceSampler(meshData.positions, meshData.indices);
    console.log(`[GLB] Sampler ready: ${formatCountOf(sampler.triangleCount, "triangle")}, area=${sampler.totalArea.toFixed(4)} (${(performance.now() - startTime).toFixed(0)}ms)`);
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < meshData.positions.length; i += 3) {
      minX = Math.min(minX, meshData.positions[i]);
      maxX = Math.max(maxX, meshData.positions[i]);
      minY = Math.min(minY, meshData.positions[i + 1]);
      maxY = Math.max(maxY, meshData.positions[i + 1]);
      minZ = Math.min(minZ, meshData.positions[i + 2]);
      maxZ = Math.max(maxZ, meshData.positions[i + 2]);
    }
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const centerZ = (minZ + maxZ) / 2;
    const scale = 2 / Math.max(maxX - minX, maxY - minY, maxZ - minZ);
    console.log("[GLB] Sampling points...");
    const positions = allocateLargeArray(Float32Array, count2 * 3);
    const colors = allocateLargeArray(Uint8Array, count2 * 4);
    const normal = new Float64Array(3);
    const logInterval = Math.max(1e5, Math.floor(count2 / 10));
    for (let i = 0; i < count2; i++) {
      if (i > 0 && i % logInterval === 0) {
        console.log(`[GLB] Sampled ${formatCompactCount(i)} / ${formatCompactCount(count2)} ${countNoun(count2, "point")}...`);
      }
      const idx = i * 3;
      sampler._sampleIntoUnchecked(positions, idx, normal, 0);
      positions[idx] = (positions[idx] - centerX) * scale;
      positions[idx + 1] = (positions[idx + 1] - centerY) * scale;
      positions[idx + 2] = (positions[idx + 2] - centerZ) * scale;
      const nx = normal[0];
      const ny = normal[1];
      const nz = normal[2];
      const warmCool = (ny + 1) * 0.5;
      const hue = 0.55 - warmCool * 0.4;
      const sat = 0.6 + Math.abs(nz) * 0.2;
      const light = 0.45 + Math.abs(nx) * 0.15;
      const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
      const p = 2 * light - q;
      const red = hueToRgbChannel(p, q, hue + 1 / 3);
      const green = hueToRgbChannel(p, q, hue);
      const blue = hueToRgbChannel(p, q, hue - 1 / 3);
      const cidx = i * 4;
      colors[cidx] = normalizedByte(
        red + (syntheticUnitRandom() - 0.5) * 0.05
      );
      colors[cidx + 1] = normalizedByte(
        green + (syntheticUnitRandom() - 0.5) * 0.05
      );
      colors[cidx + 2] = normalizedByte(
        blue + (syntheticUnitRandom() - 0.5) * 0.05
      );
      colors[cidx + 3] = 255;
    }
    const elapsed = performance.now() - startTime;
    console.log(`[GLB] Done! Sampled ${formatCountOf(count2, "point")} in ${elapsed.toFixed(0)}ms`);
    return { positions, colors, dimensionLevel: 3 };
  }
  /**
   * Load GLB file from URL and sample points
   * @param {number} count - Number of points to generate
   * @param {string} url - The GLB file's absolute URL, which the page
   *   resolves (`generation.js`): this runs in the generation worker, which
   *   resolves a relative URL against its own script and has no page address.
   * @returns {Promise<Object>} - { positions: Float32Array, colors: Uint8Array (RGBA), dimensionLevel: number }
   */
  static async fromGLBUrl(count2, url) {
    requireSyntheticPointCount(count2);
    if (typeof url !== "string" || url.length === 0 || url !== url.trim()) {
      throw new TypeError(
        "GLB benchmark URL must be one non-empty exact string."
      );
    }
    console.log(`Loading GLB from: ${url}`);
    let bufferPromise = glbBufferPromises.get(url);
    if (bufferPromise === void 0) {
      bufferPromise = (async () => {
        const response = await fetch(url, { cache: "default" });
        if (!response.ok) {
          throw new Error(
            `Failed to load GLB: ${response.status} ${response.statusText}`
          );
        }
        const buffer2 = await response.arrayBuffer();
        if (buffer2.byteLength === 0) {
          throw new Error("Failed to load GLB: response body is empty");
        }
        return buffer2;
      })();
      glbBufferPromises.set(url, bufferPromise);
    }
    let buffer;
    try {
      buffer = await bufferPromise;
    } catch (error) {
      if (glbBufferPromises.get(url) === bufferPromise) {
        glbBufferPromises.delete(url);
      }
      throw error;
    }
    console.log(`GLB loaded: ${(buffer.byteLength / 1024).toFixed(1)} KB`);
    return this.fromGLB(count2, buffer);
  }
  static _gaussianRandom() {
    let u = 0, v = 0;
    while (u === 0) u = syntheticUnitRandom();
    while (v === 0) v = syntheticUnitRandom();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  static _hslToRgb(h, s, l) {
    let r, g, b;
    if (s === 0) {
      r = g = b = l;
    } else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hueToRgbChannel(p, q, h + 1 / 3);
      g = hueToRgbChannel(p, q, h);
      b = hueToRgbChannel(p, q, h - 1 / 3);
    }
    return [r, g, b];
  }
};

// assets/js/app/ui/modules/benchmark/generation-worker.js
var GENERATORS = Object.freeze({
  atlas: (count2) => SyntheticDataGenerator.atlasLike(count2),
  batches: (count2) => SyntheticDataGenerator.batchEffects(count2),
  clusters: (count2) => SyntheticDataGenerator.gaussianClusters(count2),
  flatumap: (count2) => SyntheticDataGenerator.flatUMAP(count2),
  glb: (count2, sourceUrl) => SyntheticDataGenerator.fromGLBUrl(count2, sourceUrl),
  octopus: (count2) => SyntheticDataGenerator.octopus(count2),
  spirals: (count2) => SyntheticDataGenerator.spirals(count2),
  uniform: (count2) => SyntheticDataGenerator.uniformRandom(count2)
});
self.addEventListener("message", async (event) => {
  let request;
  try {
    request = assertGenerationRequest(event.data);
  } catch (error) {
    self.postMessage({
      requestId: Number.isSafeInteger(event.data?.requestId) ? event.data.requestId : -1,
      ok: false,
      name: error.name,
      message: error.message
    });
    return;
  }
  const startedAt = performance.now();
  try {
    const data = await GENERATORS[request.pattern](
      request.count,
      request.sourceUrl
    );
    const elapsedMs = performance.now() - startedAt;
    const sender = new PieceSender(
      (piece, transfer) => self.postMessage({ requestId: request.requestId, piece }, transfer)
    );
    const arrays = placeArrays(
      { positions: data.positions, colors: data.colors },
      (view) => sender.send(view)
    );
    self.postMessage(
      {
        requestId: request.requestId,
        ok: true,
        positions: arrays.positions,
        colors: arrays.colors,
        dimensionLevel: data.dimensionLevel,
        elapsedMs
      },
      [data.positions, data.colors].filter(canTransfer).map((view) => view.buffer)
    );
  } catch (error) {
    self.postMessage({
      requestId: request.requestId,
      ok: false,
      name: error.name,
      message: error.message
    });
  }
});
//# sourceMappingURL=generation-worker.6fc00613f42f.js.map
