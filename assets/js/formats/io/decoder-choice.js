/**
 * Which decoder decodes a codec family, chosen by measuring the decoders
 * against each other where the app decodes: on the decode workers, at the
 * pool's width, on the chunks being read, and kept in this browser.
 *
 * A family with more than one decoder lists them in `DECODERS`, the first
 * the reference. An engine whose decoder is fast on one core can be the
 * slowest at eight (Firefox's `DecompressionStream` on small DEFLATE
 * chunks: one worker 292-310 MB/s, eight 159-160 MB/s in total, the
 * per-stream cost contending across threads), so a choice made on one core,
 * or by name, is wrong somewhere: names only seed the first guess.
 *
 * - **Keys**: a decoder is chosen per family and size class of the decoded
 *   chunk (`choiceKey`, a power of two), since chunk size moves the balance
 *   (a stream's fixed cost against its inflate).
 * - **Before a decision** every chunk is decoded with the engine's prior
 *   (`ENGINE_PRIORS`: the decoder measured fastest on that engine at every
 *   width, measured on 2026-10-30 with `scripts/efficiency-floor/cpu-browser.mjs`; the reference where
 *   the engine is not known), never with a decoder untested here: a
 *   person's reads are not where decoders are tried.
 * - **Probe** (`DecoderProbe`, in the thread that runs the decode pool):
 *   the decoders are measured once the pool has had nothing else to do for
 *   a second (`decode-pool.js` `EXPLORE_AFTER_IDLE_MS`), on
 *   copies of chunks it was given (`decode-pool.js` keeps a few per key),
 *   in phases: each phase sends `PHASE_MESSAGES_PER_WORKER` messages per
 *   worker, all with one decoder, so each decoder is measured under the
 *   contention its own copies on the other workers make. A message's time
 *   is its worker's busy time for it, measured in this thread: from when it
 *   was sent, or the worker's previous answer if it was still busy, to its
 *   answer. A phase's rate is its decoded bytes over the sum of its
 *   messages' times. Each decoder's first phase warms its workers (their
 *   engines compile it, tier by tier); then decoders alternate, the prior
 *   first, until each has `PROBE_PHASES` phases after it, and the decoder
 *   of the most bytes per busy millisecond over all its phases, the warm-up
 *   included, is kept: a person's reads are short (a gene is a few chunks a
 *   worker), so a decoder fast only once its engine has optimised it (cold
 *   WebAssembly in Chromium) is charged what it costs cold.
 *   A chunk a person's read sends meanwhile voids the phase under way (its
 *   contention is no longer one decoder's): it is measured again later.
 * - **Kept** (`decoder-memory.js`): a decision is kept in this browser,
 *   under a version naming the WebAssembly module's digest, the decoder
 *   lists, the browser and its cores, so a later visit starts decided and
 *   only a first visit (or a new version) measures.
 * - **Checked**: the first measuring message of a key sent with a decoder
 *   other than the reference decodes one chunk with both, and the decoder
 *   is dropped for the key if their bytes differ; a decoder that throws on
 *   a chunk the reference decodes is dropped as well (on a read too). The
 *   reference's bytes are used either way. A read's chunks are never
 *   decoded twice: the priors are the decoders the reader shipped with.
 * - **This thread**: chunks decoded in the pool's own thread (small ones,
 *   or every chunk where no worker runs) use the key's decided decoder, the
 *   prior until there is one.
 *
 * @module formats/io/decoder-choice
 */

/**
 * Each family with more than one decoder, its reference first: DEFLATE
 * through the platform's stream (`io/inflate.js`) or fflate's inflater
 * (`assets/external/fflate-0.8.2/`: a whole chunk of known size; it cannot
 * seek); Zstandard, LZ4 and Blosc by their own libraries in WebAssembly
 * (`io/wasm-codecs.js`) or by the JavaScript decoders written for this
 * reader (`zarr/codecs/javascript/`), which some engines run faster.
 */
export const DECODERS = Object.freeze({
  deflate: Object.freeze(['native', 'fflate']),
  zstd: Object.freeze(['wasm', 'js']),
  lz4: Object.freeze(['wasm', 'js']),
  blosc: Object.freeze(['wasm', 'js']),
});

/**
 * Each engine's prior: the decoder of each family measured fastest on it,
 * at one core and at every pool width, on the real chunks of the corpus
 * (M1 Pro, 2026-10-30, `cpu-browser.mjs`; the probe picked the same in
 * 21 of 21 engine x codec cases). Firefox (Gecko) runs the JavaScript
 * decoders faster than its WebAssembly (zstd 1,653 against 532 MB/s for
 * the pool, LZ4 3,606 against 2,938, Blosc-LZ4 1,935 against 902) and
 * fflate faster than its own DEFLATE stream on small chunks (620 against
 * 115); WebKit runs the references fastest. Chromium (Blink) runs
 * WebAssembly fastest once V8 has optimised it, but a read of a gene finds
 * it cold in each decode worker (compiled there, still in its baseline
 * tier): the first gene of a 10M-cell store, same tree, JavaScript against
 * WebAssembly, zstd 175-244 against 386-678 ms, bit-shuffled Blosc-LZ4
 * 111-360 against 357-488 (LZ4 319 against 196: WebAssembly even cold), so
 * Chromium starts Zstandard and Blosc from JavaScript (2026-10-30, r4). A
 * family an engine does not name, or an engine not known, starts from the
 * reference. Only a first guess: the probe measures, and its decision wins.
 */
export const ENGINE_PRIORS = Object.freeze({
  blink: Object.freeze({ zstd: 'js', blosc: 'js' }),
  gecko: Object.freeze({ deflate: 'fflate', zstd: 'js', lz4: 'js', blosc: 'js' }),
  webkit: Object.freeze({}),
});

/**
 * The engine of a browser by its user agent: `'gecko'` (Firefox), `'blink'`
 * (Chromium, Chrome, Edge, Opera) or `'webkit'` (Safari, and every browser
 * on iOS), else null (Node, an engine not known).
 *
 * @param {string|undefined} userAgent
 * @returns {'gecko'|'blink'|'webkit'|null}
 */
export function engineOf(userAgent) {
  if (typeof userAgent !== 'string') return null;
  // Every browser on iOS is WebKit, whatever it names.
  if (/\b(CriOS|FxiOS|EdgiOS)\//.test(userAgent)) return 'webkit';
  if (/\bGecko\/\d/.test(userAgent) && !/like Gecko/.test(userAgent)) return 'gecko';
  if (/\b(Chrome|Chromium)\//.test(userAgent)) return 'blink';
  if (/\bAppleWebKit\//.test(userAgent)) return 'webkit';
  return null;
}

/** This thread's priors, by family (`ENGINE_PRIORS` of this browser's engine). */
let priors = ENGINE_PRIORS[engineOf(globalThis.navigator?.userAgent)] ?? {};

/**
 * The decoder a family starts from before the probe decides: this engine's
 * prior when it names one of the family's decoders, else the reference.
 *
 * @param {string} family
 * @returns {string|null} Null for a family with one decoder
 */
export function priorDecoder(family) {
  const decoders = DECODERS[family];
  if (decoders === undefined) return null;
  return decoders.includes(priors[family]) ? priors[family] : decoders[0];
}

/**
 * Seed the priors as another engine's (tests, benchmarks); null for this
 * browser's own.
 *
 * @param {'gecko'|'blink'|'webkit'|null} engine
 */
export function usePriorsOf(engine) {
  priors = ENGINE_PRIORS[engine ?? engineOf(globalThis.navigator?.userAgent)] ?? {};
}

/** Counted phases of each decoder before the probe decides (a measuring choice: two, so one disturbed phase does not decide). */
export const PROBE_PHASES = 2;

/**
 * Messages per worker in one phase (a measuring choice): enough bytes for
 * an engine's compiler tiers to settle within the warm-up phase, and the
 * messages of the phases around it, one per worker in flight at its edges
 * (`decode-pool.js`), an eighth of it at most.
 */
export const PHASE_MESSAGES_PER_WORKER = 8;

/**
 * The key a decoder is chosen for: the family and the size class of the
 * decoded chunk (powers of two).
 *
 * @param {string} family
 * @param {number} size - Decoded bytes, or the best estimate of them
 * @returns {string}
 */
export function choiceKey(family, size) {
  return `${family}:${Math.floor(Math.log2(Math.max(1, size)))}`;
}

/** The family a key names. */
export function familyOfKey(key) {
  return key.slice(0, key.indexOf(':'));
}

/** This thread's decided decoders, by key. */
const decided = new Map();

/** Decoders set by family for every chunk, the probe not run for them (benchmarks: `configureDecodePool({decoders})`). */
let fixed = {};

/**
 * Decode every chunk of each family named with the decoder named, in this
 * thread and on the decode workers (no probe for it): what a benchmark sets
 * to measure each decoder in the app's own pool.
 *
 * @param {Object<string, string>} decoders - By family
 */
export function fixDecoders(decoders) {
  for (const [family, decoder] of Object.entries(decoders)) {
    if (!DECODERS[family]?.includes(decoder)) throw new TypeError(`'${decoder}' is not a decoder of the ${family} family.`);
  }
  fixed = { ...decoders };
}

/**
 * The decoder a chunk of `family` decoding to `size` bytes is decoded with:
 * the one `choices` names for its key (a task's, on a decode worker), else
 * this thread's decided one, else the family's prior. Null for a family
 * with one decoder.
 *
 * @param {string} family
 * @param {number|null} size
 * @param {Object<string, string>|null} [choices]
 * @returns {string|null}
 */
export function decoderFor(family, size, choices = null) {
  const decoders = DECODERS[family];
  if (decoders === undefined) return null;
  if (fixed[family] !== undefined) return fixed[family];
  if (choices !== null) {
    // A task names one decoder per family, for its chunk's size class: a
    // part of the chunk (a Blosc stream, a filter's input) takes it too.
    const named = size === null ? undefined : choices[choiceKey(family, size)];
    if (named !== undefined) return named;
    for (const [key, decoder] of Object.entries(choices)) if (key.startsWith(`${family}:`)) return decoder;
  }
  // A stream of no known size: only the reference reads one (fflate needs the whole chunk).
  if (size === null) return decoders[0];
  return decided.get(choiceKey(family, size)) ?? priorDecoder(family);
}

/** The decoders this thread has decided on, by key (diagnostics, benchmarks, `decoder-memory.js`). */
export function decidedDecoders() {
  return Object.fromEntries(decided);
}

/**
 * Take decisions made earlier (kept in this browser, `decoder-memory.js`):
 * each key whose decoder is still one of its family's, and not decided
 * here already.
 *
 * @param {Object<string, string>} decisions - By key
 * @returns {number} The decisions taken
 */
export function adoptDecidedDecoders(decisions) {
  let taken = 0;
  for (const [key, decoder] of Object.entries(decisions ?? {})) {
    if (decided.has(key) || !DECODERS[familyOfKey(key)]?.includes(decoder)) continue;
    decided.set(key, decoder);
    taken++;
  }
  return taken;
}

/** Forget every decision (a new decode pool measures afresh, or takes those kept). */
export function forgetDecidedDecoders() {
  decided.clear();
}

/**
 * The probe of one decode pool: which decoder each message of a key goes
 * with (the decided one, else the prior), and the measuring phases run
 * while the pool is otherwise idle, on copies of chunks it was given.
 */
export class DecoderProbe {
  /**
   * @param {() => number} width - The workers the pool runs now
   * @param {{onDecided?: (key: string, decoder: string) => void}} [options] -
   *   `onDecided`: told each decision the probe makes (kept in this browser)
   */
  constructor(width, { onDecided = () => {} } = {}) {
    this.width = width;
    this.onDecided = onDecided;
    /** @type {Map<string, Object>} */
    this.keys = new Map();
    /** The phase being measured (one at a time: the workers are shared), or null. */
    this.phase = null;
  }

  state(key, family) {
    let state = this.keys.get(key);
    if (state === undefined) {
      const decoders = [...DECODERS[family]];
      const prior = priorDecoder(family);
      // The prior first: its warm-up, then the others', then counted phases in turn.
      const order = [prior, ...decoders.filter(decoder => decoder !== prior)];
      state = {
        key,
        decoders,
        order,
        schedule: order.map(decoder => ({ decoder, warm: true })),
        rates: new Map(decoders.map(decoder => [decoder, { bytes: 0, ms: 0, phases: 0 }])),
        checked: new Set(),
        dropped: new Set(),
      };
      this.keys.set(key, state);
    }
    return state;
  }

  /** Whether the first message of `decoder` for `state`'s key is checked against the reference (and marks it checked). */
  checks(state, decoder) {
    if (decoder === state.decoders[0] || state.checked.has(decoder)) return false;
    state.checked.add(decoder);
    return true;
  }

  /**
   * The decoder a chunk of a person's read goes with: the key's decided
   * one, else its prior (never a decoder untested here). Null when the
   * family has one decoder.
   *
   * @param {string} family
   * @param {number} size
   * @returns {{key: string, decoder: string, check: boolean, phase: null}|null}
   */
  assign(family, size) {
    if (DECODERS[family] === undefined) return null;
    const key = choiceKey(family, size);
    if (fixed[family] !== undefined) return { key, decoder: fixed[family], check: false, phase: null };
    const state = this.state(key, family);
    if (state.decoders.length === 1 && !decided.has(key)) this.decide(key, state.decoders[0]);
    let decoder = decided.get(key) ?? priorDecoder(family);
    if (state.dropped.has(decoder)) decoder = state.decoders[0];
    // Never checked on a read: a second decode of its chunk with the
    // reference (compiled cold in that worker) would sit on the read's path;
    // the measuring messages check each decoder (`explore`).
    return { key, decoder, check: false, phase: null };
  }

  /** Whether `key` still has decoders to measure. */
  undecided(key) {
    const family = familyOfKey(key);
    return DECODERS[family] !== undefined && fixed[family] === undefined && !decided.has(key);
  }

  /**
   * A message of a person's read was sent: the phase under way no longer
   * measures one decoder's contention, so it is not counted and runs again.
   */
  disturbed() {
    const phase = this.phase;
    if (phase === null) return;
    phase.void = true;
    this.phase = null;
    const state = this.keys.get(phase.key);
    if (state !== undefined && state.decoders.includes(phase.decoder)) state.schedule.unshift({ decoder: phase.decoder, warm: phase.warm });
  }

  /**
   * The next measuring message for one of `keys` (the keys the pool holds
   * copies of chunks for), or null when no phase has a message to send
   * (none to measure, or the phase under way has sent all of its own).
   *
   * @param {Iterable<string>} keys
   * @returns {{key: string, decoder: string, check: boolean, phase: Object}|null}
   */
  explore(keys) {
    let phase = this.phase;
    if (phase !== null && (phase.void || decided.has(phase.key))) phase = this.phase = null;
    if (phase === null) {
      for (const key of keys) {
        if (!this.undecided(key)) continue;
        const state = this.state(key, familyOfKey(key));
        if (state.schedule.length === 0) {
          // Every decoder short of its counted phases runs another, in turn.
          for (const decoder of state.order) {
            if (state.decoders.includes(decoder) && state.rates.get(decoder).phases < PROBE_PHASES) state.schedule.push({ decoder, warm: false });
          }
        }
        const next = state.schedule.shift();
        if (next === undefined) continue;
        phase = this.phase = {
          key, decoder: next.decoder, warm: next.warm, void: false,
          messages: PHASE_MESSAGES_PER_WORKER * Math.max(1, this.width()),
          sent: 0, answered: 0, bytes: 0, busy: 0,
        };
        break;
      }
      if (phase === null) return null;
    }
    if (phase.sent >= phase.messages) return null;
    phase.sent += 1;
    const state = this.keys.get(phase.key);
    return { key: phase.key, decoder: phase.decoder, check: this.checks(state, phase.decoder), phase };
  }

  /**
   * A message of `phase` was answered: `bytes` decoded in `busy`
   * milliseconds of its worker's time.
   */
  answered(phase, bytes, busy) {
    if (phase.void) return;
    const state = this.keys.get(phase.key);
    if (state === undefined || decided.has(phase.key)) return;
    phase.answered += 1;
    phase.bytes += bytes;
    phase.busy += busy;
    if (phase.sent < phase.messages || phase.answered < phase.sent) return;
    if (this.phase === phase) this.phase = null;
    if (!state.decoders.includes(phase.decoder)) return;
    // Every phase counts in the rate, the warm-up too (its cold cost is what
    // a short read pays); the phases after it decide when there are enough.
    const rate = state.rates.get(phase.decoder);
    rate.bytes += phase.bytes;
    rate.ms += Math.max(phase.busy, 1e-3);
    if (!phase.warm) rate.phases += 1;
    if (state.decoders.every(decoder => state.rates.get(decoder).phases >= PROBE_PHASES)) {
      let best = state.decoders[0];
      for (const decoder of state.decoders) {
        const rate = state.rates.get(decoder);
        const top = state.rates.get(best);
        if (rate.bytes / rate.ms > top.bytes / top.ms) best = decoder;
      }
      this.decide(phase.key, best);
    }
  }

  /** `decoder` threw, or gave other bytes than the reference, for `key`: it is not used for it again. */
  drop(key, decoder) {
    const state = this.state(key, familyOfKey(key));
    if (decoder === state.decoders[0]) return;
    state.dropped.add(decoder);
    state.decoders = state.decoders.filter(name => name !== decoder);
    state.order = state.order.filter(name => name !== decoder);
    state.schedule = state.schedule.filter(entry => entry.decoder !== decoder);
    state.rates.delete(decoder);
    if (this.phase?.key === key && this.phase.decoder === decoder) {
      this.phase.void = true;
      this.phase = null;
    }
    // One decoder left (the reference), or a decision now wrong: the reference.
    if (state.decoders.length === 1 || decided.get(key) === decoder) {
      decided.delete(key);
      this.decide(key, state.decoders[0]);
    }
  }

  decide(key, decoder) {
    decided.set(key, decoder);
    this.onDecided(key, decoder);
  }

  /** What each decoder decoded per busy millisecond of a worker, and which was kept, by key (diagnostics, benchmarks). */
  summary() {
    const out = {};
    for (const [key, state] of this.keys) {
      out[key] = {
        decided: decided.get(key) ?? null,
        prior: priorDecoder(familyOfKey(key)),
        // Per worker while busy: the pool's rate is this times the workers decoding at once.
        MBps: Object.fromEntries([...state.rates].filter(([, { ms }]) => ms > 0)
          .map(([name, { bytes, ms }]) => [name, Math.round(bytes / ms / 1e3)])),
      };
    }
    // Decisions taken from an earlier visit, for keys not met yet on this page.
    for (const [key, decoder] of decided) out[key] ??= { decided: decoder, prior: priorDecoder(familyOfKey(key)), MBps: {} };
    return out;
  }
}
