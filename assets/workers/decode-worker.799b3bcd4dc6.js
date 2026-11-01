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

// assets/js/utils/yield-macrotask.js
var channel = null;
var waiting = [];
function sharedChannel() {
  if (channel !== null) return channel;
  channel = new MessageChannel();
  channel.port1.onmessage = () => {
    const resolve = waiting.shift();
    resolve?.();
  };
  return channel;
}
function yieldToMacrotask() {
  if (typeof setImmediate === "function") {
    return new Promise((resolve) => setImmediate(resolve));
  }
  if (typeof MessageChannel !== "function") {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  const { port2 } = sharedChannel();
  return new Promise((resolve) => {
    waiting.push(resolve);
    port2.postMessage(null);
  });
}

// assets/external/fflate-0.8.2/browser.js
var u8 = Uint8Array;
var u16 = Uint16Array;
var i32 = Int32Array;
var fleb = new u8([
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  1,
  1,
  1,
  1,
  2,
  2,
  2,
  2,
  3,
  3,
  3,
  3,
  4,
  4,
  4,
  4,
  5,
  5,
  5,
  5,
  0,
  /* unused */
  0,
  0,
  /* impossible */
  0
]);
var fdeb = new u8([
  0,
  0,
  0,
  0,
  1,
  1,
  2,
  2,
  3,
  3,
  4,
  4,
  5,
  5,
  6,
  6,
  7,
  7,
  8,
  8,
  9,
  9,
  10,
  10,
  11,
  11,
  12,
  12,
  13,
  13,
  /* unused */
  0,
  0
]);
var clim = new u8([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
var freb = function(eb, start) {
  var b = new u16(31);
  for (var i2 = 0; i2 < 31; ++i2) {
    b[i2] = start += 1 << eb[i2 - 1];
  }
  var r = new i32(b[30]);
  for (var i2 = 1; i2 < 30; ++i2) {
    for (var j = b[i2]; j < b[i2 + 1]; ++j) {
      r[j] = j - b[i2] << 5 | i2;
    }
  }
  return { b, r };
};
var _a = freb(fleb, 2);
var fl = _a.b;
var revfl = _a.r;
fl[28] = 258, revfl[258] = 28;
var _b = freb(fdeb, 0);
var fd = _b.b;
var revfd = _b.r;
var rev = new u16(32768);
for (i = 0; i < 32768; ++i) {
  x = (i & 43690) >> 1 | (i & 21845) << 1;
  x = (x & 52428) >> 2 | (x & 13107) << 2;
  x = (x & 61680) >> 4 | (x & 3855) << 4;
  rev[i] = ((x & 65280) >> 8 | (x & 255) << 8) >> 1;
}
var x;
var i;
var hMap = (function(cd, mb, r) {
  var s = cd.length;
  var i2 = 0;
  var l = new u16(mb);
  for (; i2 < s; ++i2) {
    if (cd[i2])
      ++l[cd[i2] - 1];
  }
  var le = new u16(mb);
  for (i2 = 1; i2 < mb; ++i2) {
    le[i2] = le[i2 - 1] + l[i2 - 1] << 1;
  }
  var co;
  if (r) {
    co = new u16(1 << mb);
    var rvb = 15 - mb;
    for (i2 = 0; i2 < s; ++i2) {
      if (cd[i2]) {
        var sv = i2 << 4 | cd[i2];
        var r_1 = mb - cd[i2];
        var v = le[cd[i2] - 1]++ << r_1;
        for (var m = v | (1 << r_1) - 1; v <= m; ++v) {
          co[rev[v] >> rvb] = sv;
        }
      }
    }
  } else {
    co = new u16(s);
    for (i2 = 0; i2 < s; ++i2) {
      if (cd[i2]) {
        co[i2] = rev[le[cd[i2] - 1]++] >> 15 - cd[i2];
      }
    }
  }
  return co;
});
var flt = new u8(288);
for (i = 0; i < 144; ++i)
  flt[i] = 8;
var i;
for (i = 144; i < 256; ++i)
  flt[i] = 9;
var i;
for (i = 256; i < 280; ++i)
  flt[i] = 7;
var i;
for (i = 280; i < 288; ++i)
  flt[i] = 8;
var i;
var fdt = new u8(32);
for (i = 0; i < 32; ++i)
  fdt[i] = 5;
var i;
var flrm = /* @__PURE__ */ hMap(flt, 9, 1);
var fdrm = /* @__PURE__ */ hMap(fdt, 5, 1);
var max = function(a) {
  var m = a[0];
  for (var i2 = 1; i2 < a.length; ++i2) {
    if (a[i2] > m)
      m = a[i2];
  }
  return m;
};
var bits = function(d, p, m) {
  var o = p / 8 | 0;
  return (d[o] | d[o + 1] << 8) >> (p & 7) & m;
};
var bits16 = function(d, p) {
  var o = p / 8 | 0;
  return (d[o] | d[o + 1] << 8 | d[o + 2] << 16) >> (p & 7);
};
var shft = function(p) {
  return (p + 7) / 8 | 0;
};
var slc = function(v, s, e) {
  if (s == null || s < 0)
    s = 0;
  if (e == null || e > v.length)
    e = v.length;
  return new u8(v.subarray(s, e));
};
var ec = [
  "unexpected EOF",
  "invalid block type",
  "invalid length/literal",
  "invalid distance",
  "stream finished",
  "no stream handler",
  ,
  "no callback",
  "invalid UTF-8 data",
  "extra field too long",
  "date not in range 1980-2099",
  "filename too long",
  "stream finishing",
  "invalid zip data"
  // determined by unknown compression method
];
var err = function(ind, msg, nt) {
  var e = new Error(msg || ec[ind]);
  e.code = ind;
  if (Error.captureStackTrace)
    Error.captureStackTrace(e, err);
  if (!nt)
    throw e;
  return e;
};
var inflt = function(dat, st, buf, dict) {
  var sl = dat.length, dl = dict ? dict.length : 0;
  if (!sl || st.f && !st.l)
    return buf || new u8(0);
  var noBuf = !buf;
  var resize = noBuf || st.i != 2;
  var noSt = st.i;
  if (noBuf)
    buf = new u8(sl * 3);
  var cbuf = function(l2) {
    var bl = buf.length;
    if (l2 > bl) {
      var nbuf = new u8(Math.max(bl * 2, l2));
      nbuf.set(buf);
      buf = nbuf;
    }
  };
  var final = st.f || 0, pos = st.p || 0, bt = st.b || 0, lm = st.l, dm = st.d, lbt = st.m, dbt = st.n;
  var tbts = sl * 8;
  do {
    if (!lm) {
      final = bits(dat, pos, 1);
      var type = bits(dat, pos + 1, 3);
      pos += 3;
      if (!type) {
        var s = shft(pos) + 4, l = dat[s - 4] | dat[s - 3] << 8, t = s + l;
        if (t > sl) {
          if (noSt)
            err(0);
          break;
        }
        if (resize)
          cbuf(bt + l);
        buf.set(dat.subarray(s, t), bt);
        st.b = bt += l, st.p = pos = t * 8, st.f = final;
        continue;
      } else if (type == 1)
        lm = flrm, dm = fdrm, lbt = 9, dbt = 5;
      else if (type == 2) {
        var hLit = bits(dat, pos, 31) + 257, hcLen = bits(dat, pos + 10, 15) + 4;
        var tl = hLit + bits(dat, pos + 5, 31) + 1;
        pos += 14;
        var ldt = new u8(tl);
        var clt = new u8(19);
        for (var i2 = 0; i2 < hcLen; ++i2) {
          clt[clim[i2]] = bits(dat, pos + i2 * 3, 7);
        }
        pos += hcLen * 3;
        var clb = max(clt), clbmsk = (1 << clb) - 1;
        var clm = hMap(clt, clb, 1);
        for (var i2 = 0; i2 < tl; ) {
          var r = clm[bits(dat, pos, clbmsk)];
          pos += r & 15;
          var s = r >> 4;
          if (s < 16) {
            ldt[i2++] = s;
          } else {
            var c = 0, n = 0;
            if (s == 16)
              n = 3 + bits(dat, pos, 3), pos += 2, c = ldt[i2 - 1];
            else if (s == 17)
              n = 3 + bits(dat, pos, 7), pos += 3;
            else if (s == 18)
              n = 11 + bits(dat, pos, 127), pos += 7;
            while (n--)
              ldt[i2++] = c;
          }
        }
        var lt = ldt.subarray(0, hLit), dt = ldt.subarray(hLit);
        lbt = max(lt);
        dbt = max(dt);
        lm = hMap(lt, lbt, 1);
        dm = hMap(dt, dbt, 1);
      } else
        err(1);
      if (pos > tbts) {
        if (noSt)
          err(0);
        break;
      }
    }
    if (resize)
      cbuf(bt + 131072);
    var lms = (1 << lbt) - 1, dms = (1 << dbt) - 1;
    var lpos = pos;
    for (; ; lpos = pos) {
      var c = lm[bits16(dat, pos) & lms], sym = c >> 4;
      pos += c & 15;
      if (pos > tbts) {
        if (noSt)
          err(0);
        break;
      }
      if (!c)
        err(2);
      if (sym < 256)
        buf[bt++] = sym;
      else if (sym == 256) {
        lpos = pos, lm = null;
        break;
      } else {
        var add = sym - 254;
        if (sym > 264) {
          var i2 = sym - 257, b = fleb[i2];
          add = bits(dat, pos, (1 << b) - 1) + fl[i2];
          pos += b;
        }
        var d = dm[bits16(dat, pos) & dms], dsym = d >> 4;
        if (!d)
          err(3);
        pos += d & 15;
        var dt = fd[dsym];
        if (dsym > 3) {
          var b = fdeb[dsym];
          dt += bits16(dat, pos) & (1 << b) - 1, pos += b;
        }
        if (pos > tbts) {
          if (noSt)
            err(0);
          break;
        }
        if (resize)
          cbuf(bt + 131072);
        var end = bt + add;
        if (bt < dt) {
          var shift = dl - dt, dend = Math.min(dt, end);
          if (shift + bt < 0)
            err(3);
          for (; bt < dend; ++bt)
            buf[bt] = dict[shift + bt];
        }
        for (; bt < end; ++bt)
          buf[bt] = buf[bt - dt];
      }
    }
    st.l = lm, st.p = lpos, st.b = bt, st.f = final;
    if (lm)
      final = 1, st.m = lbt, st.d = dm, st.n = dbt;
  } while (!final);
  return bt != buf.length && noBuf ? slc(buf, 0, bt) : buf.subarray(0, bt);
};
var et = /* @__PURE__ */ new u8(0);
var gzs = function(d) {
  if (d[0] != 31 || d[1] != 139 || d[2] != 8)
    err(6, "invalid gzip data");
  var flg = d[3];
  var st = 10;
  if (flg & 4)
    st += (d[10] | d[11] << 8) + 2;
  for (var zs = (flg >> 3 & 1) + (flg >> 4 & 1); zs > 0; zs -= !d[st++])
    ;
  return st + (flg & 2);
};
var gzl = function(d) {
  var l = d.length;
  return (d[l - 4] | d[l - 3] << 8 | d[l - 2] << 16 | d[l - 1] << 24) >>> 0;
};
var zls = function(d, dict) {
  if ((d[0] & 15) != 8 || d[0] >> 4 > 7 || (d[0] << 8 | d[1]) % 31)
    err(6, "invalid zlib data");
  if ((d[1] >> 5 & 1) == +!dict)
    err(6, "invalid zlib data: " + (d[1] & 32 ? "need" : "unexpected") + " dictionary");
  return (d[1] >> 3 & 4) + 2;
};
function inflateSync(data, opts) {
  return inflt(data, { i: 2 }, opts && opts.out, opts && opts.dictionary);
}
function gunzipSync(data, opts) {
  var st = gzs(data);
  if (st + 8 > data.length)
    err(6, "invalid gzip data");
  return inflt(data.subarray(st, -8), { i: 2 }, opts && opts.out || new u8(gzl(data)), opts && opts.dictionary);
}
function unzlibSync(data, opts) {
  return inflt(data.subarray(zls(data, opts && opts.dictionary), -4), { i: 2 }, opts && opts.out, opts && opts.dictionary);
}
var td = typeof TextDecoder != "undefined" && /* @__PURE__ */ new TextDecoder();
var tds = 0;
try {
  td.decode(et, { stream: true });
  tds = 1;
} catch (e) {
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
function step16(t, a, b, c, d) {
  return t[3840 + (a & 255)] ^ t[3584 + (a >>> 8 & 255)] ^ t[3328 + (a >>> 16 & 255)] ^ t[3072 + (a >>> 24)] ^ t[2816 + (b & 255)] ^ t[2560 + (b >>> 8 & 255)] ^ t[2304 + (b >>> 16 & 255)] ^ t[2048 + (b >>> 24)] ^ t[1792 + (c & 255)] ^ t[1536 + (c >>> 8 & 255)] ^ t[1280 + (c >>> 16 & 255)] ^ t[1024 + (c >>> 24)] ^ t[768 + (d & 255)] ^ t[512 + (d >>> 8 & 255)] ^ t[256 + (d >>> 16 & 255)] ^ t[d >>> 24];
}
function crc32(bytes, previous = 0) {
  const t = TABLES;
  let crc = ~previous >>> 0;
  let i2 = 0;
  const length = bytes.length;
  if (HOST_LITTLE_ENDIAN) {
    while (i2 < length && (bytes.byteOffset + i2 & 3) !== 0) crc = t[(crc ^ bytes[i2++]) & 255] ^ crc >>> 8;
    const fast = length - i2 >>> 4 << 2;
    if (fast > 0) {
      const words = new Uint32Array(bytes.buffer, bytes.byteOffset + i2, fast);
      for (let w = 0; w < fast; w += 4) crc = step16(t, words[w] ^ crc, words[w + 1], words[w + 2], words[w + 3]);
      i2 += fast * 4;
    }
  } else {
    const word = (at) => bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16 | bytes[at + 3] << 24;
    const fast = length - length % 16;
    for (; i2 < fast; i2 += 16) crc = step16(t, word(i2) ^ crc, word(i2 + 4), word(i2 + 8), word(i2 + 12));
  }
  for (; i2 < length; i2++) crc = t[(crc ^ bytes[i2]) & 255] ^ crc >>> 8;
  return ~crc >>> 0;
}

// assets/js/formats/io/decoder-choice.js
var DECODERS = Object.freeze({
  deflate: Object.freeze(["native", "fflate"]),
  zstd: Object.freeze(["wasm", "js"]),
  lz4: Object.freeze(["wasm", "js"]),
  blosc: Object.freeze(["wasm", "js"])
});
var ENGINE_PRIORS = Object.freeze({
  blink: Object.freeze({ zstd: "js", blosc: "js" }),
  gecko: Object.freeze({ deflate: "fflate", zstd: "js", lz4: "js", blosc: "js" }),
  webkit: Object.freeze({})
});
function engineOf(userAgent) {
  if (typeof userAgent !== "string") return null;
  if (/\b(CriOS|FxiOS|EdgiOS)\//.test(userAgent)) return "webkit";
  if (/\bGecko\/\d/.test(userAgent) && !/like Gecko/.test(userAgent)) return "gecko";
  if (/\b(Chrome|Chromium)\//.test(userAgent)) return "blink";
  if (/\bAppleWebKit\//.test(userAgent)) return "webkit";
  return null;
}
var priors = ENGINE_PRIORS[engineOf(globalThis.navigator?.userAgent)] ?? {};
function priorDecoder(family) {
  const decoders = DECODERS[family];
  if (decoders === void 0) return null;
  return decoders.includes(priors[family]) ? priors[family] : decoders[0];
}
function choiceKey(family, size) {
  return `${family}:${Math.floor(Math.log2(Math.max(1, size)))}`;
}
function familyOfKey(key) {
  return key.slice(0, key.indexOf(":"));
}
var decided = /* @__PURE__ */ new Map();
var fixed = {};
function decoderFor(family, size, choices = null) {
  const decoders = DECODERS[family];
  if (decoders === void 0) return null;
  if (fixed[family] !== void 0) return fixed[family];
  if (choices !== null) {
    const named = size === null ? void 0 : choices[choiceKey(family, size)];
    if (named !== void 0) return named;
    for (const [key, decoder] of Object.entries(choices)) if (key.startsWith(`${family}:`)) return decoder;
  }
  if (size === null) return decoders[0];
  return decided.get(choiceKey(family, size)) ?? priorDecoder(family);
}

// assets/js/formats/io/inflate.js
var FORMATS = /* @__PURE__ */ new Set(["deflate", "gzip", "deflate-raw"]);
var InflateError = class extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "InflateError";
  }
};
function requireDecompressionStream(format, label) {
  if (typeof globalThis.DecompressionStream !== "function") {
    throw new InflateError(
      `${label}: this browser cannot decompress ${format} data; a current browser is required.`
    );
  }
}
var NATIVE_INFLATE_INPUT_SLICE_BYTES = 32 * 1024;
var NATIVE_CODEC_SLICE_MS = 12;
function createSlicedInputStream(parts) {
  for (const part of parts) {
    if (!(part instanceof Uint8Array)) {
      throw new TypeError("Native decompressor input must be Uint8Array parts.");
    }
  }
  let partIndex = 0;
  let partOffset = 0;
  let sliceStart = performance.now();
  return new ReadableStream({
    async pull(controller) {
      if (performance.now() - sliceStart >= NATIVE_CODEC_SLICE_MS) {
        await yieldToMacrotask();
        sliceStart = performance.now();
      }
      while (partIndex < parts.length && partOffset >= parts[partIndex].byteLength) {
        partIndex += 1;
        partOffset = 0;
      }
      if (partIndex === parts.length) {
        controller.close();
        return;
      }
      const part = parts[partIndex];
      const end = Math.min(
        part.byteLength,
        partOffset + NATIVE_INFLATE_INPUT_SLICE_BYTES
      );
      controller.enqueue(part.subarray(partOffset, end));
      partOffset = end;
    }
  }, { highWaterMark: 0 });
}
function decompressed(input, format) {
  return createSlicedInputStream([input]).pipeThrough(new globalThis.DecompressionStream(format));
}
async function inflate(input, { format = "deflate", expectedSize = null, maxSize = null, label = "Compressed data", choices = null, decoder = null, into = null } = {}) {
  if (!(input instanceof Uint8Array)) throw new TypeError("inflate reads a Uint8Array.");
  if (!FORMATS.has(format)) throw new TypeError(`Unknown DEFLATE format '${format}'.`);
  if (expectedSize !== null && (!Number.isSafeInteger(expectedSize) || expectedSize < 0)) {
    throw new TypeError("An expected decompressed size must be a whole number of bytes.");
  }
  if (maxSize !== null && (!Number.isSafeInteger(maxSize) || maxSize < 0)) {
    throw new TypeError("A maximum decompressed size must be a whole number of bytes.");
  }
  if (into !== null && (expectedSize === null || into.length !== expectedSize)) {
    throw new TypeError("inflate fills `into` only with exactly the expected size.");
  }
  if (expectedSize !== null && (decoder ?? decoderFor("deflate", expectedSize, choices)) === "fflate") {
    const whole = inflateWhole(input, format, expectedSize, label);
    if (into === null) return whole;
    into.set(whole);
    return into;
  }
  requireDecompressionStream(format, label);
  const stream = decompressed(input, format);
  if (expectedSize === null && maxSize === null) {
    try {
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (cause) {
      throw new InflateError(`${label} could not be decompressed; the data is corrupt.`, { cause });
    }
  }
  if (expectedSize === null) {
    const reader2 = stream.getReader();
    const pieces = [];
    let total = 0;
    try {
      for (; ; ) {
        const { value, done } = await reader2.read();
        if (done) break;
        total += value.length;
        if (total > maxSize) {
          throw new InflateError(`${label} decompresses to more than the ${formatCountOf(maxSize, "byte")} it may hold.`);
        }
        pieces.push(value);
      }
    } catch (error) {
      await reader2.cancel().catch(() => {
      });
      if (error instanceof InflateError) throw error;
      throw new InflateError(`${label} could not be decompressed; the data is corrupt.`, { cause: error });
    }
    const output2 = new Uint8Array(total);
    let at = 0;
    for (const piece of pieces) {
      output2.set(piece, at);
      at += piece.length;
    }
    return output2;
  }
  const output = into ?? new Uint8Array(expectedSize);
  const reader = stream.getReader();
  let filled = 0;
  try {
    for (; ; ) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.length > expectedSize - filled) {
        throw new InflateError(`${label} decompresses to more than the ${formatCountOf(expectedSize, "byte")} it declares.`);
      }
      output.set(value, filled);
      filled += value.length;
    }
  } catch (error) {
    await reader.cancel().catch(() => {
    });
    if (error instanceof InflateError) throw error;
    throw new InflateError(`${label} could not be decompressed; the data is corrupt.`, { cause: error });
  }
  if (filled !== expectedSize) {
    throw new InflateError(`${label} decompresses to ${formatCountOf(filled, "byte")}, not the ${expectedSize} it declares.`);
  }
  return output;
}
function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (let start = 0; start < bytes.length; start += 5552) {
    const end = Math.min(bytes.length, start + 5552);
    for (let i2 = start; i2 < end; i2++) {
      a += bytes[i2];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return (b << 16 | a) >>> 0;
}
function inflateWhole(input, format, expectedSize, label) {
  const out = new Uint8Array(expectedSize + 1);
  let output;
  try {
    output = format === "deflate" ? unzlibSync(input, { out }) : format === "gzip" ? gunzipSync(input, { out }) : inflateSync(input, { out });
  } catch (cause) {
    throw new InflateError(`${label} could not be decompressed; the data is corrupt.`, { cause });
  }
  if (output.length > expectedSize) {
    throw new InflateError(`${label} decompresses to more than the ${formatCountOf(expectedSize, "byte")} it declares.`);
  }
  if (output.length !== expectedSize) {
    throw new InflateError(`${label} decompresses to ${formatCountOf(output.length, "byte")}, not the ${expectedSize} it declares.`);
  }
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const intact = format === "deflate" ? input.length >= 6 && view.getUint32(input.length - 4) === adler32(output) : format === "gzip" ? input.length >= 18 && view.getUint32(input.length - 8, true) === crc32(output) && view.getUint32(input.length - 4, true) === expectedSize >>> 0 : true;
  if (!intact) throw new InflateError(`${label} could not be decompressed; the data is corrupt (its checksum does not match).`);
  return output;
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
function isCancellation(error) {
  return error?.name === "AbortError";
}
function cancellationKind(error) {
  if (!isCancellation(error)) return null;
  return KINDS.has(error.kind) ? error.kind : "user";
}
function abortReason(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error || typeof reason?.name === "string" && typeof reason?.message === "string") return reason;
  return cancelled("user", "The work was cancelled.", reason);
}
function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
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

// assets/js/utils/errors.js
var REPORTED = /* @__PURE__ */ Symbol.for("cellucid.failureReported");
function isReported(error) {
  return error !== null && typeof error === "object" && error[REPORTED] === true;
}

// assets/js/utils/error-wire.js
var KEPT = ["code", "key", "reason", "bytes", "details", "columns", "feature", "offset", "status", "url"];
function toWire(error, seen = /* @__PURE__ */ new Set()) {
  if (error === null || typeof error !== "object" || typeof error.message !== "string") {
    return { name: "Error", message: String(error) };
  }
  const record = { name: typeof error.name === "string" ? error.name : "Error", message: error.message };
  seen.add(error);
  const kind = cancellationKind(error);
  if (kind !== null) record.kind = kind;
  if (isReported(error)) record.reported = true;
  if (typeof error.source === "string") record.sourceType = error.source;
  for (const key of KEPT) {
    if (key === "code" && typeof DOMException === "function" && error instanceof DOMException) continue;
    if (error[key] === void 0) continue;
    try {
      record[key] = structuredClone(error[key]);
    } catch {
      record[key] = String(error[key]);
    }
  }
  if (error.cause !== void 0 && !seen.has(error.cause)) record.cause = toWire(error.cause, seen);
  if (Array.isArray(error.errors)) record.errors = error.errors.filter((item) => !seen.has(item)).map((item) => toWire(item, seen));
  return record;
}

// assets/js/formats/io/shuffle.js
function transposeInto(words, w, step, w0, w1, w2, w3) {
  words[w] = w0 & 255 | (w1 & 255) << 8 | (w2 & 255) << 16 | w3 << 24;
  words[w + step] = w0 >>> 8 & 255 | w1 & 65280 | (w2 & 65280) << 8 | (w3 & 65280) << 16;
  words[w + 2 * step] = w0 >>> 16 & 255 | w1 >>> 8 & 65280 | w2 & 16711680 | (w3 & 16711680) << 8;
  words[w + 3 * step] = w0 >>> 24 | w1 >>> 16 & 65280 | w2 >>> 8 & 16711680 | w3 & 4278190080;
}
function byteUnshuffleInto(src, dest, at, size, typesize) {
  const count2 = Math.floor(size / typesize);
  let e = 0;
  if (HOST_LITTLE_ENDIAN && (typesize === 2 || typesize === 4 || typesize === 8) && (dest.byteOffset + at) % 4 === 0 && count2 >= 4) {
    const lanes = new DataView(src.buffer, src.byteOffset, size);
    const words = new Int32Array(dest.buffer, dest.byteOffset + at, count2 * typesize >>> 2);
    const quads = count2 - count2 % 4;
    if (typesize === 4) {
      for (let w = 0; e < quads; e += 4, w += 4) {
        transposeInto(
          words,
          w,
          1,
          lanes.getInt32(e, true),
          lanes.getInt32(count2 + e, true),
          lanes.getInt32(2 * count2 + e, true),
          lanes.getInt32(3 * count2 + e, true)
        );
      }
    } else if (typesize === 8) {
      for (let w = 0; e < quads; e += 4, w += 8) {
        transposeInto(
          words,
          w,
          2,
          lanes.getInt32(e, true),
          lanes.getInt32(count2 + e, true),
          lanes.getInt32(2 * count2 + e, true),
          lanes.getInt32(3 * count2 + e, true)
        );
        transposeInto(
          words,
          w + 1,
          2,
          lanes.getInt32(4 * count2 + e, true),
          lanes.getInt32(5 * count2 + e, true),
          lanes.getInt32(6 * count2 + e, true),
          lanes.getInt32(7 * count2 + e, true)
        );
      }
    } else {
      for (let w = 0; e < quads; e += 4, w += 2) {
        const low = lanes.getInt32(e, true);
        const high = lanes.getInt32(count2 + e, true);
        words[w] = low & 255 | (high & 255) << 8 | (low & 65280) << 8 | (high & 65280) << 16;
        words[w + 1] = low >>> 16 & 255 | high >>> 8 & 65280 | low >>> 8 & 16711680 | high & 4278190080;
      }
    }
  }
  for (let byte = 0; byte < typesize; byte++) {
    const lane = byte * count2;
    for (let i2 = e, o = at + e * typesize + byte; i2 < count2; i2++, o += typesize) dest[o] = src[lane + i2];
  }
  const done = count2 * typesize;
  if (done < size) dest.set(src.subarray(done, size), at + done);
}
function byteUnshuffle(input, typesize) {
  const output = new Uint8Array(input.length);
  if (typesize <= 1) output.set(input);
  else byteUnshuffleInto(input, output, 0, input.length, typesize);
  return output;
}

// assets/js/formats/zarr/errors.js
var ZarrFormatError = class extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ZarrFormatError";
  }
};
var ZarrUnsupportedError = class extends Error {
  /**
   * @param {string} feature - What is not supported, in a few words
   * @param {string} message
   */
  constructor(feature, message, options) {
    super(message, options);
    this.name = "ZarrUnsupportedError";
    this.feature = feature;
  }
};

// assets/js/formats/store.js
var INTEGER_NAMES = Object.freeze({
  int: Object.freeze({ 1: "int8", 2: "int16", 4: "int32", 8: "int64" }),
  uint: Object.freeze({ 1: "uint8", 2: "uint16", 4: "uint32", 8: "uint64" })
});
var FLOAT_NAMES = Object.freeze({ 2: "float16", 4: "float32", 8: "float64" });
var INTEGER_ARRAYS = Object.freeze({
  int: Object.freeze({ 1: Int8Array, 2: Int16Array, 4: Int32Array, 8: BigInt64Array }),
  uint: Object.freeze({ 1: Uint8Array, 2: Uint16Array, 4: Uint32Array, 8: BigUint64Array })
});
var BOOL_DTYPE = Object.freeze({ kind: "bool", name: "bool", bytes: 1, littleEndian: null });

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
  channel: channel2 = null
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
    if (channel2 === null) return;
    try {
      channel2.postMessage(message);
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
  if (channel2 !== null) {
    channel2.onmessage = (event) => {
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
    const channel2 = new BroadcastChannel(HOSTS_CHANNEL);
    channel2.unref?.();
    return channel2;
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
var handed = null;
var allowanceScale = 1;
var refusedBytes = 0;
var otherInstances = { count: 0, heldBytes: 0 };
var workingSet = /* @__PURE__ */ new Map();
var openCells = 0;
function estimatedDeviceMemory(environment = globalThis) {
  if (handed !== null && environment === globalThis) return { bytes: handed.deviceBytes, source: handed.deviceSource };
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
  return handed === null ? allowanceScale : handed.scale;
}
function currentOthers() {
  return handed === null ? otherInstances : handed.otherInstances;
}
function memoryAllowanceBytes(environment = globalThis) {
  const device = estimatedDeviceMemory(environment).bytes * ALLOWANCE_OF_DEVICE * currentScale();
  const others = currentOthers();
  const shared = others.count === 0 ? device : Math.max(device / (others.count + 1), device - others.heldBytes);
  return Math.floor(shared);
}
function workingSetBytes() {
  if (handed !== null) return handed.workingSetBytes;
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
  if (handed !== null) {
    handed = Object.freeze({ ...handed, scale: handed.scale / 2, refusedBytes: bytes });
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
  const refused = handed === null ? refusedBytes : handed.refusedBytes;
  if (refused === 0 || !(bytes >= refused)) return;
  if (handed !== null) {
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
  if (handed !== null) report({ released, reason });
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

// assets/js/formats/zarr/codecs/vlen.js
var utf8 = new TextDecoder("utf-8", { fatal: true });

// assets/js/workers/worker-script.js
var THIS_MACHINE_HOSTS = Object.freeze(["localhost", "127.0.0.1", "[::1]"]);
var THIS_MACHINE = new Set(THIS_MACHINE_HOSTS);

// assets/workers/scripts.js
var codecsWasm = () => new URL("../wasm/codecs.wasm?v=e19ba7156cb8", import.meta.url);

// assets/js/formats/io/decode-pool.js
var POOL_MIN_BYTES = 32 * 1024;
var DECODE_WORKER_BYTES = 40 * 1024 * 1024;

// assets/js/formats/io/wasm-codecs.js
var WasmCodecError = class extends Error {
  /**
   * @param {string} message
   * @param {string} code - The library's reason, in words
   */
  constructor(message, code) {
    super(message);
    this.name = "WasmCodecError";
    this.code = code;
  }
};
var CODES = /* @__PURE__ */ new Map([[-1, "out of memory"], [-2, "corrupt data"], [-3, "the wrong decoded size"]]);
var ZSTD_CODES = /* @__PURE__ */ new Map([
  [1, "a generic error"],
  [10, "an unknown frame prefix"],
  [12, "an unsupported version"],
  [14, "an unsupported frame parameter"],
  [16, "a window too large"],
  [20, "corruption detected"],
  [22, "a wrong checksum"],
  [24, "a literals header that is wrong"],
  [30, "a dictionary that is corrupt"],
  [32, "a wrong dictionary"],
  [34, "a dictionary creation failure"],
  [40, "an unsupported parameter"],
  [42, "a parameter out of bound"],
  [44, "a table log too large"],
  [46, "a max symbol value too large"],
  [48, "a max symbol value too small"],
  [50, "a stability condition not respected"],
  [60, "a stage error"],
  [62, "an init missing"],
  [64, "a memory allocation failure"],
  [66, "a workspace too small"],
  [70, "a destination too small"],
  [72, "a source too small"],
  [74, "a destination buffer that is null"],
  [80, "no forward progress on the destination"],
  [82, "no forward progress on the input"]
]);
function codeOf(result, codes = CODES) {
  return codes.get(-result) ?? codes.get(result) ?? `code ${result}`;
}
var compiled = null;
var current = null;
function unavailable(cause) {
  return new Error(
    "This data is compressed with Zstandard, LZ4 or Blosc, which Cellucid decodes with WebAssembly, and this browser does not run WebAssembly here (Lockdown Mode, an enhanced security mode or a policy turns it off). Allow WebAssembly for this site, or open the data in another browser.",
    { cause }
  );
}
async function compile() {
  if (typeof globalThis.WebAssembly?.compile !== "function") throw unavailable(null);
  try {
    return await load();
  } catch (error) {
    if (error?.name === "CompileError" || error?.name === "EvalError" || error?.name === "SecurityError") throw unavailable(error);
    throw error;
  }
}
async function load() {
  const url = codecsWasm();
  if (url.protocol === "file:") {
    const { readFileSync } = globalThis.process.getBuiltinModule("node:fs");
    const { fileURLToPath } = globalThis.process.getBuiltinModule("node:url");
    return WebAssembly.compile(readFileSync(fileURLToPath(url)));
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`The decoders (${url.pathname}) could not be loaded: the server answered ${response.status}.`);
  return WebAssembly.compileStreaming(response);
}
async function wasmCodecs() {
  if (current !== null) return current;
  compiled ??= compile().catch((error) => {
    compiled = null;
    throw error;
  });
  const module = await compiled;
  current ??= new Codecs(module);
  return current;
}
var Codecs = class {
  /** @param {WebAssembly.Module} module */
  constructor(module) {
    this.module = module;
    this.exports = new WebAssembly.Instance(module, {}).exports;
  }
  /** The bytes of the module's memory (a fresh view: memory growth detaches the old one). */
  get memory() {
    return new Uint8Array(this.exports.memory.buffer);
  }
  /**
   * Run one call over `input` copied into the module and an output region of
   * `outputSize` bytes: `decode(inputAddress, outputAddress)` returns the
   * bytes written, or a negative code. Returns the output, copied out.
   */
  call(input, outputSize, decode2) {
    const at = this.exports.codecs_buffers(input.length, outputSize);
    if (at === 0) throw new WasmCodecError(`${formatCountOf(input.length + outputSize, "byte")} do not fit in this thread's memory.`, "out of memory");
    const out = this.exports.codecs_output();
    this.memory.set(input, at);
    const written = decode2(at, out);
    const output = written > 0 ? this.memory.slice(out, out + written) : new Uint8Array(0);
    if (this.exports.memory.buffer.byteLength > DECODE_WORKER_BYTES && current === this) current = null;
    return { written, output };
  }
  /**
   * Every Zstandard frame of `input` (skippable frames skipped): into
   * exactly `expectedSize` bytes when it is known; else into the size the
   * frames state (no more than `bound`); else, when a frame states none,
   * into no more than `bound` bytes.
   *
   * @param {Uint8Array} input
   * @param {number|null} expectedSize
   * @param {number|null} [bound]
   * @returns {Uint8Array}
   */
  zstd(input, expectedSize, bound = null) {
    if (expectedSize !== null) return this.zstdInto(input, expectedSize);
    const stated = this.statedZstdSize(input);
    if (stated === -2) throw new WasmCodecError("It is not Zstandard frames.", ZSTD_CODES.get(10));
    if (stated >= 0) {
      if (bound !== null && stated > bound) throw new WasmCodecError(`Its frames state ${formatCountOf(stated, "byte")}, more than the ${bound} it may hold.`, ZSTD_CODES.get(70));
      return this.zstdInto(input, stated);
    }
    return this.zstdGrowing(input, bound);
  }
  /** Frames that must decode to exactly `size` bytes. */
  zstdInto(input, size) {
    const { written, output } = this.call(input, size, (at, out) => this.exports.codecs_zstd(at, input.length, out, size));
    if (written < 0) throw new WasmCodecError(`It could not be decoded: ${codeOf(written, ZSTD_CODES)}.`, codeOf(written, ZSTD_CODES));
    if (written !== size) throw new WasmCodecError(`It decodes to ${formatCountOf(written, "byte")}, not the ${size} expected.`, "the wrong decoded size");
    return output;
  }
  /** The decoded size `input`'s frames state (-1 when one does not, -2 when it is not frames). */
  statedZstdSize(input) {
    const at = this.exports.codecs_buffers(input.length, 0);
    if (at === 0) throw new WasmCodecError(`${formatCountOf(input.length, "byte")} do not fit in this thread's memory.`, "out of memory");
    this.memory.set(input, at);
    return this.exports.codecs_zstd_content_size(at, input.length);
  }
  /**
   * Frames that state no size: decoded into a buffer doubled until they fit,
   * from four times their size, up to `bound` (a block decodes to at most
   * 128 KiB, so without a bound this still ends).
   */
  zstdGrowing(input, bound) {
    let capacity = Math.max(4 * input.length, 64 * 1024);
    if (bound !== null) capacity = Math.min(capacity, bound);
    for (; ; ) {
      const size = capacity;
      const { written, output } = this.call(input, size, (at, out) => this.exports.codecs_zstd(at, input.length, out, size));
      if (written >= 0) return output;
      if (-written !== 70) throw new WasmCodecError(`It could not be decoded: ${codeOf(written, ZSTD_CODES)}.`, codeOf(written, ZSTD_CODES));
      if (bound !== null && capacity >= bound) throw new WasmCodecError(`It decodes to more than the ${formatCountOf(bound, "byte")} it may hold.`, ZSTD_CODES.get(70));
      capacity = bound === null ? capacity * 2 : Math.min(capacity * 2, bound);
    }
  }
  /**
   * One LZ4 block, which must decode to exactly `size` bytes.
   *
   * @param {Uint8Array} input
   * @param {number} size
   * @returns {Uint8Array}
   */
  lz4Block(input, size) {
    const { written, output } = this.call(input, size, (at, out) => this.exports.codecs_lz4_block(at, input.length, out, size));
    if (written < 0 && size > 0) throw new WasmCodecError(`An LZ4 block could not be decoded: ${codeOf(written)}.`, codeOf(written));
    return size === 0 ? new Uint8Array(0) : output;
  }
  /**
   * Blocks of one buffer into one output of `total` bytes: each segment
   * `{at, stored, start, size}` is `input[at, at + stored)`, an LZ4 block
   * that must fill `output[start, start + size)`, or those bytes as they are
   * when `stored === size`. Segments are checked against both buffers.
   *
   * @param {Uint8Array} input
   * @param {Array<{at: number, stored: number, start: number, size: number}>} segments
   * @param {number} total
   * @returns {Uint8Array}
   */
  lz4Blocks(input, segments, total) {
    let failed = null;
    const { output } = this.call(input, total, (inputAt, outputAt) => {
      const memory = this.memory;
      for (const { at, stored, start, size } of segments) {
        if (at < 0 || stored < 0 || at + stored > input.length || start < 0 || size < 0 || start + size > total) {
          failed = "a block lies outside its buffers";
          return -2;
        }
        if (stored === size) {
          memory.copyWithin(outputAt + start, inputAt + at, inputAt + at + stored);
          continue;
        }
        const written = this.exports.codecs_lz4_block(inputAt + at, stored, outputAt + start, size);
        if (written < 0) {
          failed = codeOf(written);
          return written;
        }
      }
      return total;
    });
    if (failed !== null) throw new WasmCodecError(`An LZ4 block could not be decoded: ${failed}.`, failed);
    return total === 0 ? new Uint8Array(0) : output;
  }
  /**
   * One Blosc 1 frame, which must decode to exactly `size` bytes (what its
   * header declares).
   *
   * @param {Uint8Array} input
   * @param {number} size
   * @returns {Uint8Array}
   */
  blosc(input, size) {
    const { written, output } = this.call(input, size, (at, out) => this.exports.codecs_blosc(at, input.length, out, size));
    if (written < 0 || written === 0 && size > 0) throw new WasmCodecError(`It could not be decoded: ${codeOf(written)}.`, codeOf(written));
    return size === 0 ? new Uint8Array(0) : output;
  }
  /**
   * One Blosc 1 frame whose streams are zlib-compressed. c-blosc reads the
   * frame (its header, block table and stream lengths checked as for any
   * frame), places its stored streams and names each zlib stream with where
   * its bytes go; `inflateStream(bytes, into)` inflates each into its place
   * (with the page's DEFLATE decoder, all at once); then the blocks are
   * un-shuffled as c-blosc does (a byte shuffle here, `byteUnshuffleInto`;
   * a bit shuffle or a delta by c-blosc's code, `codecs_blosc_unshuffle`).
   *
   * @param {Uint8Array} input
   * @param {number} size - What its header declares
   * @param {(bytes: Uint8Array, into: Uint8Array) => Promise<Uint8Array>} inflateStream
   * @returns {Promise<Uint8Array>}
   */
  async bloscZlib(input, size, inflateStream) {
    const fail = (result) => new WasmCodecError(`It could not be decoded: ${codeOf(result)}.`, codeOf(result));
    const at = this.exports.codecs_buffers(input.length, size);
    if (at === 0) throw new WasmCodecError(`${formatCountOf(input.length + size, "byte")} do not fit in this thread's memory.`, "out of memory");
    this.memory.set(input, at);
    const out = this.exports.codecs_output();
    const count2 = this.exports.codecs_blosc_zlib_record(at, input.length, out, size);
    if (count2 < 0) throw fail(count2);
    const table = new Uint32Array(this.exports.memory.buffer, this.exports.codecs_blosc_zlib_streams(), 4 * count2).slice();
    let inflated = 0;
    for (let i2 = 0; i2 < count2; i2++) inflated += table[4 * i2 + 3];
    const blocks = inflated < size ? this.memory.slice(out, out + size) : new Uint8Array(size);
    const streams = [];
    for (let i2 = 0; i2 < count2; i2++) {
      const [offset, length, place, bytes] = table.subarray(4 * i2, 4 * i2 + 4);
      if (offset + length > input.length || place + bytes > size) throw fail(-2);
      streams.push(inflateStream(input.subarray(offset, offset + length), blocks.subarray(place, place + bytes)));
    }
    await Promise.all(streams);
    const flags = input[2];
    const typesize = input[3];
    const blocksize = new DataView(input.buffer, input.byteOffset, 16).getUint32(8, true);
    const shuffled = (flags & 1) !== 0 && typesize > 1;
    if ((flags & 8) === 0 && (shuffled || (flags & 4) === 0)) {
      if (!shuffled) return blocks;
      const output2 = new Uint8Array(size);
      for (let start = 0; start < size; start += blocksize) {
        const block = Math.min(blocksize, size - start);
        byteUnshuffleInto(blocks.subarray(start, start + block), output2, start, block, typesize);
      }
      return output2;
    }
    const again = this.exports.codecs_buffers(16 + size, size);
    if (again === 0) throw new WasmCodecError(`${formatCountOf(16 + 2 * size, "byte")} do not fit in this thread's memory.`, "out of memory");
    const memory = this.memory;
    memory.set(input.subarray(0, 16), again);
    memory.set(blocks, again + 16);
    const target = this.exports.codecs_output();
    const written = this.exports.codecs_blosc_unshuffle(again, again + 16, target, size);
    if (written < 0) throw fail(written);
    const output = this.memory.slice(target, target + size);
    if (this.exports.memory.buffer.byteLength > DECODE_WORKER_BYTES && current === this) current = null;
    return output;
  }
  /**
   * One chunk through the HDF5 bitshuffle filter (32008), undone: `size`
   * bytes of elements of `elemSize` bytes, from bit-transposed blocks of
   * `blockElems` elements (0: bitshuffle's default) stored as they are
   * (`compression` 0) or each compressed with LZ4 (2) or zstd (3), the
   * filter's parameters (`codecs.c` `codecs_bitshuffle_chunk`).
   *
   * @param {Uint8Array} input
   * @param {number} size
   * @param {number} elemSize
   * @param {number} blockElems
   * @param {number} compression
   * @returns {Uint8Array}
   */
  bitshuffleChunk(input, size, elemSize, blockElems, compression) {
    const { written, output } = this.call(input, size, (at, out) => this.exports.codecs_bitshuffle_chunk(at, input.length, out, size, elemSize, blockElems, compression));
    if (written < 0) throw new WasmCodecError(`It could not be decoded: ${codeOf(written)}.`, codeOf(written));
    return size === 0 ? new Uint8Array(0) : output;
  }
  /**
   * Bitshuffle's inverse bit transpose of `count` elements of `typesize`
   * bytes (`count` a multiple of 8): `input.length` must be
   * `count * typesize`.
   *
   * @param {Uint8Array} input
   * @param {number} count
   * @param {number} typesize
   * @returns {Uint8Array}
   */
  bitshuffleUntranspose(input, count2, typesize) {
    const size = count2 * typesize;
    if (input.length !== size) throw new WasmCodecError(`${formatCountOf(input.length, "byte")} are not ${formatCountOf(count2, "element")} of ${formatCountOf(typesize, "byte")}.`, "the wrong decoded size");
    const { written, output } = this.call(input, size, (at, out) => this.exports.codecs_bitshuffle_untranspose(at, out, count2, typesize));
    if (written < 0) throw new WasmCodecError(`It could not be un-transposed: ${codeOf(written)}.`, codeOf(written));
    return size === 0 ? new Uint8Array(0) : output;
  }
};

// assets/js/formats/io/lz-match.js
var BLOCK_COPY_BYTES = 256;
function copyMatch(out, view, at, offset, length) {
  const stop = at + length;
  let from = at - offset;
  let o = at;
  if (length >= BLOCK_COPY_BYTES) {
    const base = from;
    while (o < stop) {
      const step = Math.min(o - base, stop - o);
      out.copyWithin(o, base, base + step);
      o += step;
    }
    return;
  }
  if (offset < 4) {
    if (length < 16) {
      while (o < stop) out[o++] = out[from++];
      return;
    }
    const period = offset === 3 ? 6 : 4;
    const head = at + period - offset;
    while (o < head) out[o++] = out[from++];
    from = o - period;
  }
  const last = stop - 4;
  while (o <= last) {
    view.setInt32(o, view.getInt32(from, true), true);
    o += 4;
    from += 4;
  }
  while (o < stop) out[o++] = out[from++];
}

// assets/js/formats/zarr/codecs/javascript/lz4.js
function corrupt(detail) {
  return new ZarrFormatError(`LZ4 data is corrupt: ${detail}.`);
}
function lz4DecodeBlockInto(input, output, outputStart = 0, outputEnd = output.length) {
  const inputEnd = input.length;
  const inputView = new DataView(input.buffer, input.byteOffset, input.length);
  const view = new DataView(output.buffer, output.byteOffset, output.length);
  let i2 = 0;
  let o = outputStart;
  for (; ; ) {
    if (i2 >= inputEnd) throw corrupt("the block ends without its final literals");
    const token = input[i2++];
    let literals = token >>> 4;
    if (literals === 15) {
      let byte;
      do {
        if (i2 >= inputEnd) throw corrupt("a literal length is truncated");
        byte = input[i2++];
        literals += byte;
      } while (byte === 255);
    }
    if (i2 + literals > inputEnd || o + literals > outputEnd) throw corrupt("a literal run exceeds its bounds");
    if (literals <= 16 && i2 + 16 <= inputEnd && o + 16 <= outputEnd) {
      view.setInt32(o, inputView.getInt32(i2, true), true);
      view.setInt32(o + 4, inputView.getInt32(i2 + 4, true), true);
      view.setInt32(o + 8, inputView.getInt32(i2 + 8, true), true);
      view.setInt32(o + 12, inputView.getInt32(i2 + 12, true), true);
    } else if (literals > 32) {
      output.set(input.subarray(i2, i2 + literals), o);
    } else {
      for (let k = 0; k < literals; k++) output[o + k] = input[i2 + k];
    }
    i2 += literals;
    o += literals;
    if (i2 === inputEnd) break;
    if (i2 + 2 > inputEnd) throw corrupt("a match offset is truncated");
    const offset = input[i2] | input[i2 + 1] << 8;
    i2 += 2;
    if (offset === 0 || offset > o - outputStart) throw corrupt("a match offset reaches before the output");
    let length = token & 15;
    if (length === 15) {
      let byte;
      do {
        if (i2 >= inputEnd) throw corrupt("a match length is truncated");
        byte = input[i2++];
        length += byte;
      } while (byte === 255);
    }
    length += 4;
    const stop = o + length;
    if (stop > outputEnd) throw corrupt("a match exceeds the output");
    if (offset >= 8 && length < BLOCK_COPY_BYTES && stop + 8 <= outputEnd) {
      let from = o - offset;
      do {
        view.setInt32(o, view.getInt32(from, true), true);
        view.setInt32(o + 4, view.getInt32(from + 4, true), true);
        o += 8;
        from += 8;
      } while (o < stop);
    } else {
      copyMatch(output, view, o, offset, length);
    }
    o = stop;
  }
  if (o !== outputEnd) throw corrupt(`it decodes to ${formatCountOf(o - outputStart, "byte")}, not ${outputEnd - outputStart}`);
}
function numcodecsLz4Decode(input, expectedSize) {
  if (input.length < 4) throw corrupt("the size header is truncated");
  const size = (input[0] | input[1] << 8 | input[2] << 16 | input[3] << 24) >>> 0;
  if (expectedSize !== null && size !== expectedSize) {
    throw corrupt(`it declares ${formatCountOf(size, "byte")}, not the ${expectedSize} expected`);
  }
  if (size > (input.length - 4) * 255 + 16) throw corrupt(`it declares more bytes than LZ4 can encode in ${input.length}`);
  const output = new Uint8Array(size);
  if (size > 0) lz4DecodeBlockInto(input.subarray(4), output);
  return output;
}

// assets/js/formats/zarr/codecs/javascript/zstd.js
var FRAME_MAGIC = 4247762216;
var SKIPPABLE_MASK = 4294967280;
var SKIPPABLE_MAGIC = 407710288;
var MAX_BLOCK_BYTES = 128 * 1024;
var LITERALS = new Uint8Array(MAX_BLOCK_BYTES);
function corrupt2(detail) {
  return new ZarrFormatError(`Zstandard data is corrupt: ${detail}.`);
}
function highBit(value) {
  return 31 - Math.clz32(value);
}
var LL_BASE = new Int32Array([
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  16,
  18,
  20,
  22,
  24,
  28,
  32,
  40,
  48,
  64,
  128,
  256,
  512,
  1024,
  2048,
  4096,
  8192,
  16384,
  32768,
  65536
]);
var LL_BITS = new Uint8Array([
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  1,
  1,
  1,
  1,
  2,
  2,
  3,
  3,
  4,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  16
]);
var ML_BASE = new Int32Array(53);
var ML_BITS = new Uint8Array(53);
(() => {
  for (let code = 0; code < 32; code++) ML_BASE[code] = code + 3;
  const base = [35, 37, 39, 41, 43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051, 4099, 8195, 16387, 32771, 65539];
  const bits2 = [1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  for (let i2 = 0; i2 < base.length; i2++) {
    ML_BASE[32 + i2] = base[i2];
    ML_BITS[32 + i2] = bits2[i2];
  }
})();
var LL_DEFAULT = [4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1, -1, -1, -1, -1];
var ML_DEFAULT = [1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1];
var OF_DEFAULT = [1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1];
function buildFseTable(counts, symbolCount, accuracyLog) {
  const size = 1 << accuracyLog;
  const symbol = new Uint8Array(size);
  const bits2 = new Uint8Array(size);
  const base = new Uint16Array(size);
  const next = new Uint16Array(symbolCount);
  let high = size - 1;
  for (let s = 0; s < symbolCount; s++) {
    if (counts[s] === -1) {
      symbol[high--] = s;
      next[s] = 1;
    } else {
      next[s] = counts[s];
    }
  }
  const step = (size >> 1) + (size >> 3) + 3;
  const mask = size - 1;
  let position = 0;
  for (let s = 0; s < symbolCount; s++) {
    for (let i2 = 0; i2 < counts[s]; i2++) {
      symbol[position] = s;
      do
        position = position + step & mask;
      while (position > high);
    }
  }
  if (position !== 0) throw corrupt2("an FSE table does not fill its states");
  for (let state = 0; state < size; state++) {
    const x2 = next[symbol[state]]++;
    const n = accuracyLog - highBit(x2);
    bits2[state] = n;
    base[state] = (x2 << n) - size;
  }
  return { symbol, bits: bits2, base, accuracyLog };
}
function rleTable(value) {
  return { symbol: Uint8Array.of(value), bits: new Uint8Array(1), base: new Uint16Array(1), accuracyLog: 0 };
}
var LL_PREDEFINED = buildFseTable(LL_DEFAULT, LL_DEFAULT.length, 6);
var ML_PREDEFINED = buildFseTable(ML_DEFAULT, ML_DEFAULT.length, 6);
var OF_PREDEFINED = buildFseTable(OF_DEFAULT, OF_DEFAULT.length, 5);
function peekForward(src, position, count2) {
  const at = position >>> 3;
  const word = (src[at] | src[at + 1] << 8 | src[at + 2] << 16 | src[at + 3] << 24) >>> (position & 7);
  return word & (1 << count2) - 1;
}
function readFseTable(src, start, end, maxSymbol, maxAccuracyLog) {
  if (start >= end) throw corrupt2("an FSE table description is missing");
  let position = start * 8;
  const accuracyLog = peekForward(src, position, 4) + 5;
  position += 4;
  if (accuracyLog > maxAccuracyLog) throw corrupt2(`an FSE table has accuracy ${accuracyLog}, above ${maxAccuracyLog}`);
  const counts = new Int16Array(maxSymbol + 1);
  let remaining = (1 << accuracyLog) + 1;
  let threshold = 1 << accuracyLog;
  let bitCount = accuracyLog + 1;
  let symbol = 0;
  let previousZero = false;
  while (remaining > 1 && symbol <= maxSymbol) {
    if (previousZero) {
      let zeros = symbol;
      for (; ; ) {
        const flag = peekForward(src, position, 2);
        position += 2;
        zeros += flag;
        if (flag !== 3) break;
      }
      if (zeros > maxSymbol) throw corrupt2("an FSE table names too many symbols");
      while (symbol < zeros) counts[symbol++] = 0;
    }
    const max2 = 2 * threshold - 1 - remaining;
    const value = peekForward(src, position, bitCount);
    let count2;
    if ((value & threshold - 1) < max2) {
      count2 = value & threshold - 1;
      position += bitCount - 1;
    } else {
      count2 = value & 2 * threshold - 1;
      if (count2 >= threshold) count2 -= max2;
      position += bitCount;
    }
    count2--;
    remaining -= count2 < 0 ? -count2 : count2;
    counts[symbol++] = count2;
    previousZero = count2 === 0;
    while (remaining < threshold) {
      bitCount--;
      threshold >>= 1;
    }
  }
  if (remaining !== 1) throw corrupt2("an FSE table does not add up");
  const next = position + 7 >>> 3;
  if (next > end) throw corrupt2("an FSE table description runs past its block");
  return { table: buildFseTable(counts, symbol, accuracyLog), next };
}
var BackwardBits = class {
  constructor(src, start, end) {
    if (end <= start) throw corrupt2("a bit stream is empty");
    const last = src[end - 1];
    if (last === 0) throw corrupt2("a bit stream has no end marker");
    this.src = src;
    this.start = start;
    this.position = (end - 1 - start) * 8 + highBit(last);
  }
  /** Read `count` (at most 31) bits. */
  read(count2) {
    if (count2 === 0) return 0;
    this.position -= count2;
    return this.at(this.position, count2);
  }
  /** The `count` bits at `position` (bits below the stream are zero). */
  at(position, count2) {
    if (position < 0) {
      if (position + count2 <= 0) return 0;
      return this.at(0, position + count2) << -position;
    }
    if (count2 > 24) return this.at(position, 16) + this.at(position + 16, count2 - 16) * 65536;
    const src = this.src;
    const index = this.start + (position >>> 3);
    const word = (src[index] | src[index + 1] << 8 | src[index + 2] << 16 | src[index + 3] << 24) >>> (position & 7);
    return word & (1 << count2) - 1;
  }
};
function fseWeights(src, start, end) {
  const { table, next } = readFseTable(src, start, end, 255, 6);
  const bits2 = new BackwardBits(src, next, end);
  const weights = [];
  let state1 = bits2.read(table.accuracyLog);
  let state2 = bits2.read(table.accuracyLog);
  for (; ; ) {
    if (weights.length > 255) throw corrupt2("a Huffman table has too many weights");
    weights.push(table.symbol[state1]);
    state1 = table.base[state1] + bits2.read(table.bits[state1]);
    if (bits2.position < 0) {
      weights.push(table.symbol[state2]);
      break;
    }
    weights.push(table.symbol[state2]);
    state2 = table.base[state2] + bits2.read(table.bits[state2]);
    if (bits2.position < 0) {
      weights.push(table.symbol[state1]);
      break;
    }
  }
  if (weights.length > 255) throw corrupt2("a Huffman table has too many weights");
  return weights;
}
function readHuffmanTable(src, start, end) {
  if (start >= end) throw corrupt2("a Huffman table is missing");
  const header = src[start];
  let weights;
  let next;
  if (header < 128) {
    next = start + 1 + header;
    if (next > end) throw corrupt2("a Huffman table runs past its block");
    weights = fseWeights(src, start + 1, next);
  } else {
    const count2 = header - 127;
    next = start + 1 + (count2 + 1 >> 1);
    if (next > end) throw corrupt2("a Huffman table runs past its block");
    weights = new Array(count2);
    for (let i2 = 0; i2 < count2; i2++) {
      const byte = src[start + 1 + (i2 >> 1)];
      weights[i2] = (i2 & 1) === 0 ? byte >> 4 : byte & 15;
    }
  }
  let total = 0;
  for (const weight of weights) {
    if (weight > 11) throw corrupt2("a Huffman weight is above 11");
    if (weight > 0) total += 1 << weight - 1;
  }
  if (total === 0) throw corrupt2("a Huffman table is empty");
  const maxBits = highBit(total) + 1;
  if (maxBits > 11) throw corrupt2("a Huffman code is longer than 11 bits");
  const rest = (1 << maxBits) - total;
  if ((rest & rest - 1) !== 0) throw corrupt2("Huffman weights do not add up");
  weights.push(highBit(rest) + 1);
  if (weights.length > 256) throw corrupt2("a Huffman table has too many symbols");
  const size = 1 << maxBits;
  const symbol = new Uint8Array(size);
  const bits2 = new Uint8Array(size);
  const rankStart = new Uint32Array(maxBits + 2);
  for (const weight of weights) if (weight > 0) rankStart[weight + 1] += 1 << weight - 1;
  for (let w = 1; w <= maxBits + 1; w++) rankStart[w] += rankStart[w - 1];
  for (let s = 0; s < weights.length; s++) {
    const weight = weights[s];
    if (weight === 0) continue;
    const length = 1 << weight - 1;
    const from = rankStart[weight];
    symbol.fill(s, from, from + length);
    bits2.fill(maxBits + 1 - weight, from, from + length);
    rankStart[weight] = from + length;
  }
  return { table: { symbol, bits: bits2, maxBits }, next };
}
function huffmanStream(src, start, end, table, out, from, to) {
  const { symbol, bits: bits2, maxBits } = table;
  if (end <= start) throw corrupt2("a Huffman stream is empty");
  const last = src[end - 1];
  if (last === 0) throw corrupt2("a Huffman stream has no end marker");
  let position = (end - 1 - start) * 8 + highBit(last);
  const mask = (1 << maxBits) - 1;
  let o = from;
  if (position >= 24 && to - from >= 2) {
    const view = new DataView(src.buffer, src.byteOffset, src.length);
    const pairsEnd = to - 1;
    while (o < pairsEnd && position >= 24) {
      const at = (position >> 3) - 3;
      const cont = view.getInt32(start + at, true);
      let avail = position - (at << 3);
      let prefix = cont >>> avail - maxBits & mask;
      out[o++] = symbol[prefix];
      avail -= bits2[prefix];
      prefix = cont >>> avail - maxBits & mask;
      out[o++] = symbol[prefix];
      avail -= bits2[prefix];
      position = (at << 3) + avail;
    }
  }
  while (o < to && position >= maxBits) {
    const at = position - maxBits;
    const index = start + (at >>> 3);
    const prefix = (src[index] | src[index + 1] << 8 | src[index + 2] << 16) >>> (at & 7) & mask;
    out[o++] = symbol[prefix];
    position -= bits2[prefix];
  }
  while (o < to) {
    if (position <= 0) throw corrupt2("a Huffman stream ends early");
    const index = start;
    const word = (src[index] | src[index + 1] << 8 | src[index + 2] << 16) & (1 << position) - 1;
    const prefix = word << maxBits - position & mask;
    out[o++] = symbol[prefix];
    position -= bits2[prefix];
  }
  if (position !== 0) throw corrupt2("a Huffman stream does not end where it should");
}
var Output = class {
  constructor(expectedSize) {
    this.fixed = expectedSize !== null;
    this.bytes = new Uint8Array(this.fixed ? expectedSize : 64 * 1024);
    this.length = 0;
  }
  reserve(count2) {
    const needed = this.length + count2;
    if (needed <= this.bytes.length) return;
    if (this.fixed) throw corrupt2(`it decodes to more than the ${formatCountOf(this.bytes.length, "byte")} expected`);
    const grown = new Uint8Array(Math.max(needed, this.bytes.length * 2));
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
  }
};
function readLiterals(src, start, end, frame) {
  const b0 = src[start];
  const type = b0 & 3;
  const sizeFormat = b0 >> 2 & 3;
  let p = start;
  if (type < 2) {
    let size2;
    if ((sizeFormat & 1) === 0) {
      size2 = b0 >> 3;
      p += 1;
    } else if (sizeFormat === 1) {
      size2 = b0 >> 4 | src[p + 1] << 4;
      p += 2;
    } else {
      size2 = b0 >> 4 | src[p + 1] << 4 | src[p + 2] << 12;
      p += 3;
    }
    if (size2 > MAX_BLOCK_BYTES) throw corrupt2("a literals section is larger than a block");
    if (type === 0) {
      if (p + size2 > end) throw corrupt2("raw literals run past their block");
      return { literals: src.subarray(p, p + size2), next: p + size2 };
    }
    if (p >= end) throw corrupt2("run-length literals are missing their byte");
    return { literals: frame.literalBuffer.subarray(0, size2).fill(src[p]), next: p + 1 };
  }
  let size;
  let compressedSize;
  let streams = sizeFormat === 0 ? 1 : 4;
  if (sizeFormat < 2) {
    const v = b0 | src[p + 1] << 8 | src[p + 2] << 16;
    size = v >> 4 & 1023;
    compressedSize = v >> 14 & 1023;
    p += 3;
  } else if (sizeFormat === 2) {
    const v = (b0 | src[p + 1] << 8 | src[p + 2] << 16 | src[p + 3] << 24) >>> 0;
    size = v >>> 4 & 16383;
    compressedSize = v >>> 18;
    p += 4;
  } else {
    size = b0 >> 4 | src[p + 1] << 4 | (src[p + 2] & 63) << 12;
    compressedSize = src[p + 2] >> 6 | src[p + 3] << 2 | src[p + 4] << 10;
    p += 5;
  }
  if (size > MAX_BLOCK_BYTES) throw corrupt2("a literals section is larger than a block");
  const literalsEnd = p + compressedSize;
  if (literalsEnd > end) throw corrupt2("compressed literals run past their block");
  if (type === 2) {
    const { table, next } = readHuffmanTable(src, p, literalsEnd);
    frame.huffman = table;
    p = next;
  } else if (frame.huffman === null) {
    throw corrupt2("literals repeat a Huffman table that was never sent");
  }
  const out = frame.literalBuffer;
  if (streams === 1) {
    huffmanStream(src, p, literalsEnd, frame.huffman, out, 0, size);
  } else {
    if (p + 6 > literalsEnd) throw corrupt2("a four-stream jump table is truncated");
    const size1 = src[p] | src[p + 1] << 8;
    const size2 = src[p + 2] | src[p + 3] << 8;
    const size3 = src[p + 4] | src[p + 5] << 8;
    const s1 = p + 6;
    const s2 = s1 + size1;
    const s3 = s2 + size2;
    const s4 = s3 + size3;
    if (s4 > literalsEnd) throw corrupt2("four-stream literals run past their section");
    const segment = size + 3 >> 2;
    if (3 * segment > size) throw corrupt2("four-stream literals are too short");
    huffmanStream(src, s1, s2, frame.huffman, out, 0, segment);
    huffmanStream(src, s2, s3, frame.huffman, out, segment, 2 * segment);
    huffmanStream(src, s3, s4, frame.huffman, out, 2 * segment, 3 * segment);
    huffmanStream(src, s4, literalsEnd, frame.huffman, out, 3 * segment, size);
  }
  return { literals: out.subarray(0, size), next: literalsEnd };
}
function sequenceTable(mode, src, p, end, predefined, maxSymbol, maxAccuracyLog, previous, what) {
  if (mode === 0) return { table: predefined, next: p };
  if (mode === 1) {
    if (p >= end) throw corrupt2(`the ${what} code is missing`);
    if (src[p] > maxSymbol) throw corrupt2(`a ${what} code is out of range`);
    return { table: rleTable(src[p]), next: p + 1 };
  }
  if (mode === 2) return readFseTable(src, p, end, maxSymbol, maxAccuracyLog);
  if (previous === null) throw corrupt2(`${what} codes repeat a table that was never sent`);
  return { table: previous, next: p };
}
function copyLiterals(out, o, literals, from, count2) {
  if (count2 > 32) {
    out.set(literals.subarray(from, from + count2), o);
  } else {
    for (let i2 = 0; i2 < count2; i2++) out[o + i2] = literals[from + i2];
  }
}
function sequenceCodes(table, bases, extraBits) {
  if (table.transition === void 0) {
    const size = table.symbol.length;
    const transition = new Int32Array(size);
    const code = new Int32Array(size);
    for (let state = 0; state < size; state++) {
      const symbol = table.symbol[state];
      transition[state] = table.base[state] << 4 | table.bits[state];
      code[state] = bases === null ? symbol : bases[symbol] << 5 | extraBits[symbol];
    }
    table.transition = transition;
    table.code = code;
  }
  return table;
}
function compressedBlock(src, start, end, frame, output) {
  const { literals, next } = readLiterals(src, start, end, frame);
  let p = next;
  if (p >= end) throw corrupt2("a block has no sequences section");
  let sequences = src[p++];
  if (sequences >= 128) {
    if (sequences === 255) {
      if (p + 2 > end) throw corrupt2("a sequence count is truncated");
      sequences = src[p] + (src[p + 1] << 8) + 32512;
      p += 2;
    } else {
      if (p >= end) throw corrupt2("a sequence count is truncated");
      sequences = (sequences - 128 << 8) + src[p++];
    }
  }
  if (sequences === 0) {
    if (p !== end) throw corrupt2("a block has bytes after its literals");
    output.reserve(literals.length);
    copyLiterals(output.bytes, output.length, literals, 0, literals.length);
    output.length += literals.length;
    return;
  }
  if (p >= end) throw corrupt2("the sequence compression modes are missing");
  const modes = src[p++];
  if ((modes & 3) !== 0) throw corrupt2("reserved sequence mode bits are set");
  let found = sequenceTable(modes >> 6, src, p, end, LL_PREDEFINED, 35, 9, frame.literalLengths, "literal length");
  const ll = found.table;
  found = sequenceTable(modes >> 4 & 3, src, found.next, end, OF_PREDEFINED, 31, 8, frame.offsets, "offset");
  const of = found.table;
  found = sequenceTable(modes >> 2 & 3, src, found.next, end, ML_PREDEFINED, 52, 9, frame.matchLengths, "match length");
  const ml = found.table;
  frame.literalLengths = ll;
  frame.offsets = of;
  frame.matchLengths = ml;
  sequenceCodes(ll, LL_BASE, LL_BITS);
  sequenceCodes(ml, ML_BASE, ML_BITS);
  sequenceCodes(of, null, null);
  const llCodes = ll.code;
  const llNext = ll.transition;
  const mlCodes = ml.code;
  const mlNext = ml.transition;
  const ofCodes = of.code;
  const ofNext = of.transition;
  const stateBits = ll.accuracyLog + ml.accuracyLog;
  let bitStart = found.next;
  if (end <= bitStart) throw corrupt2("a bit stream is empty");
  const lastByte = src[end - 1];
  if (lastByte === 0) throw corrupt2("a bit stream has no end marker");
  let avail = (end - 1 - bitStart) * 8 + highBit(lastByte);
  let bitSource = src;
  if (end - bitStart < 4) {
    bitSource = new Uint8Array(4);
    bitSource.set(src.subarray(bitStart, end));
    bitStart = 0;
  }
  const bitView = new DataView(bitSource.buffer, bitSource.byteOffset, bitSource.length);
  let at = 0;
  let cont = 0;
  avail += at << 3;
  at = (avail >> 3) - 3;
  if (at < 0) at = 0;
  avail -= at << 3;
  cont = bitView.getInt32(bitStart + at, true);
  let n = ll.accuracyLog;
  avail -= n;
  let llState = cont >>> avail & (1 << n) - 1;
  n = of.accuracyLog;
  if (avail < n) {
    avail += at << 3;
    at = (avail >> 3) - 3;
    if (at < 0) at = 0;
    avail -= at << 3;
    cont = bitView.getInt32(bitStart + at, true);
  }
  avail -= n;
  let ofState = cont >>> avail & (1 << n) - 1;
  n = ml.accuracyLog;
  if (avail < n) {
    avail += at << 3;
    at = (avail >> 3) - 3;
    if (at < 0) at = 0;
    avail -= at << 3;
    cont = bitView.getInt32(bitStart + at, true);
  }
  avail -= n;
  let mlState = cont >>> avail & (1 << n) - 1;
  const repeats = frame.repeats;
  let rep0 = repeats[0];
  let rep1 = repeats[1];
  let rep2 = repeats[2];
  let literalPos = 0;
  const literalCount = literals.length;
  const literalView = new DataView(literals.buffer, literals.byteOffset, literals.length);
  const frameStart = frame.outputStart;
  let out = output.bytes;
  let view = new DataView(out.buffer, out.byteOffset, out.length);
  let capacity = out.length;
  let o = output.length;
  for (let i2 = 0; i2 < sequences; i2++) {
    const ofCode = ofCodes[ofState];
    if (avail < 24) {
      avail += at << 3;
      at = (avail >> 3) - 3;
      if (at < 0) at = 0;
      avail -= at << 3;
      cont = bitView.getInt32(bitStart + at, true);
    }
    let offset;
    if (ofCode <= 24) {
      avail -= ofCode;
      offset = (1 << ofCode) + (cont >>> avail & (1 << ofCode) - 1);
    } else {
      if (ofCode > 31) throw corrupt2("an offset code is out of range");
      n = ofCode - 16;
      avail -= n;
      const high = 1 << n | cont >>> avail & (1 << n) - 1;
      avail += at << 3;
      at = (avail >> 3) - 3;
      if (at < 0) at = 0;
      avail -= at << 3;
      cont = bitView.getInt32(bitStart + at, true);
      avail -= 16;
      offset = (high << 16 | cont >>> avail & 65535) >>> 0;
    }
    const mlCode = mlCodes[mlState];
    n = mlCode & 31;
    if (avail < n) {
      avail += at << 3;
      at = (avail >> 3) - 3;
      if (at < 0) at = 0;
      avail -= at << 3;
      cont = bitView.getInt32(bitStart + at, true);
    }
    avail -= n;
    const matchLength = (mlCode >> 5) + (cont >>> avail & (1 << n) - 1);
    const llCode = llCodes[llState];
    n = llCode & 31;
    if (avail < n) {
      avail += at << 3;
      at = (avail >> 3) - 3;
      if (at < 0) at = 0;
      avail -= at << 3;
      cont = bitView.getInt32(bitStart + at, true);
    }
    avail -= n;
    const literalLength = (llCode >> 5) + (cont >>> avail & (1 << n) - 1);
    if (offset > 3) {
      offset -= 3;
      rep2 = rep1;
      rep1 = rep0;
      rep0 = offset;
    } else {
      const index = offset - (literalLength !== 0 ? 1 : 0);
      if (index === 0) {
        offset = rep0;
      } else {
        offset = index === 3 ? rep0 - 1 : index === 1 ? rep1 : rep2;
        if (index > 1) rep2 = rep1;
        rep1 = rep0;
        rep0 = offset;
      }
    }
    if (i2 + 1 < sequences) {
      if (avail < stateBits) {
        avail += at << 3;
        at = (avail >> 3) - 3;
        if (at < 0) at = 0;
        avail -= at << 3;
        cont = bitView.getInt32(bitStart + at, true);
      }
      let step = llNext[llState];
      n = step & 15;
      avail -= n;
      llState = (step >> 4) + (cont >>> avail & (1 << n) - 1);
      step = mlNext[mlState];
      n = step & 15;
      avail -= n;
      mlState = (step >> 4) + (cont >>> avail & (1 << n) - 1);
      step = ofNext[ofState];
      n = step & 15;
      if (avail < n) {
        avail += at << 3;
        at = (avail >> 3) - 3;
        if (at < 0) at = 0;
        avail -= at << 3;
        cont = bitView.getInt32(bitStart + at, true);
      }
      avail -= n;
      ofState = (step >> 4) + (cont >>> avail & (1 << n) - 1);
    }
    if (literalPos + literalLength > literalCount) throw corrupt2("a sequence uses more literals than the block holds");
    if (o + literalLength + matchLength > capacity) {
      output.length = o;
      output.reserve(literalLength + matchLength);
      out = output.bytes;
      view = new DataView(out.buffer, out.byteOffset, out.length);
      capacity = out.length;
    }
    if (literalLength > 0) {
      if (literalLength <= 8 && literalPos + 8 <= literalCount && o + 8 <= capacity) {
        view.setInt32(o, literalView.getInt32(literalPos, true), true);
        view.setInt32(o + 4, literalView.getInt32(literalPos + 4, true), true);
        o += literalLength;
        literalPos += literalLength;
      } else if (literalLength > 32) {
        out.set(literals.subarray(literalPos, literalPos + literalLength), o);
        o += literalLength;
        literalPos += literalLength;
      } else {
        for (const literalStop = literalPos + literalLength; literalPos < literalStop; ) out[o++] = literals[literalPos++];
      }
    }
    if (offset < 1 || offset > o - frameStart) throw corrupt2("a match reaches before the start of the frame");
    const stop = o + matchLength;
    if (offset >= 8 && matchLength < BLOCK_COPY_BYTES && stop + 8 <= capacity) {
      let from = o - offset;
      do {
        view.setInt32(o, view.getInt32(from, true), true);
        view.setInt32(o + 4, view.getInt32(from + 4, true), true);
        o += 8;
        from += 8;
      } while (o < stop);
    } else {
      copyMatch(out, view, o, offset, matchLength);
    }
    o = stop;
  }
  output.length = o;
  repeats[0] = rep0;
  repeats[1] = rep1;
  repeats[2] = rep2;
  if (8 * at + avail !== 0) throw corrupt2("the sequence bit stream does not end where it should");
  const rest = literalCount - literalPos;
  output.reserve(rest);
  copyLiterals(output.bytes, output.length, literals, literalPos, rest);
  output.length += rest;
}
function readUint32(src, at) {
  return (src[at] | src[at + 1] << 8 | src[at + 2] << 16 | src[at + 3] << 24) >>> 0;
}
function decodeFrame(src, start, output) {
  let p = start + 4;
  if (p >= src.length) throw corrupt2("a frame header is truncated");
  const descriptor = src[p++];
  const contentSizeFlag = descriptor >> 6;
  const singleSegment = descriptor >> 5 & 1;
  const hasChecksum = descriptor >> 2 & 1;
  const dictionaryFlag = descriptor & 3;
  if ((descriptor & 8) !== 0) throw corrupt2("a reserved frame header bit is set");
  if (!singleSegment) p++;
  const dictionaryBytes = [0, 1, 2, 4][dictionaryFlag];
  let dictionary = 0;
  for (let i2 = 0; i2 < dictionaryBytes; i2++) dictionary += src[p + i2] * 2 ** (8 * i2);
  p += dictionaryBytes;
  if (dictionary !== 0) {
    throw new ZarrUnsupportedError("Zstandard dictionary", "This Zstandard data was compressed with a dictionary, which Zarr never uses and this reader does not read.");
  }
  const sizeBytes = [singleSegment ? 1 : 0, 2, 4, 8][contentSizeFlag];
  let contentSize = null;
  if (sizeBytes > 0) {
    if (p + sizeBytes > src.length) throw corrupt2("a frame header is truncated");
    contentSize = 0;
    for (let i2 = 0; i2 < sizeBytes; i2++) contentSize += src[p + i2] * 2 ** (8 * i2);
    if (sizeBytes === 2) contentSize += 256;
    p += sizeBytes;
  }
  if (contentSize !== null) output.reserve(contentSize);
  const frame = {
    outputStart: output.length,
    // Offsets reach 2^32 - 4 (code 31), past what an Int32Array holds.
    repeats: new Uint32Array([1, 4, 8]),
    huffman: null,
    literalLengths: null,
    offsets: null,
    matchLengths: null,
    literalBuffer: LITERALS
  };
  for (let last = 0; !last; ) {
    if (p + 3 > src.length) throw corrupt2("a block header is truncated");
    const header = src[p] | src[p + 1] << 8 | src[p + 2] << 16;
    p += 3;
    last = header & 1;
    const type = header >> 1 & 3;
    const size = header >>> 3;
    if (type === 0) {
      if (p + size > src.length) throw corrupt2("a raw block is truncated");
      output.reserve(size);
      output.bytes.set(src.subarray(p, p + size), output.length);
      output.length += size;
      p += size;
    } else if (type === 1) {
      if (p >= src.length) throw corrupt2("a run-length block is truncated");
      output.reserve(size);
      output.bytes.fill(src[p], output.length, output.length + size);
      output.length += size;
      p += 1;
    } else if (type === 2) {
      if (size > MAX_BLOCK_BYTES || p + size > src.length) throw corrupt2("a compressed block is truncated");
      compressedBlock(src, p, p + size, frame, output);
      p += size;
    } else {
      throw corrupt2("a block has the reserved type");
    }
  }
  if (hasChecksum) p += 4;
  if (p > src.length) throw corrupt2("the frame checksum is truncated");
  if (contentSize !== null && output.length - frame.outputStart !== contentSize) {
    throw corrupt2(`a frame declares ${formatCountOf(contentSize, "byte")} and holds ${output.length - frame.outputStart}`);
  }
  return p;
}
function zstdDecompress(input, expectedSize = null) {
  const output = new Output(expectedSize);
  let p = 0;
  while (p < input.length) {
    if (p + 4 > input.length) throw corrupt2("trailing bytes follow the last frame");
    const magic = readUint32(input, p);
    if (magic === FRAME_MAGIC) {
      p = decodeFrame(input, p, output);
    } else if ((magic & SKIPPABLE_MASK) >>> 0 === SKIPPABLE_MAGIC) {
      p += 8 + readUint32(input, p + 4);
    } else {
      throw corrupt2("it does not start with a Zstandard frame");
    }
  }
  if (p > input.length) throw corrupt2("a skippable frame is truncated");
  if (expectedSize !== null) {
    if (output.length !== expectedSize) {
      throw corrupt2(`it decodes to ${formatCountOf(output.length, "byte")}, not the ${expectedSize} expected`);
    }
    return output.bytes;
  }
  return output.bytes.length === output.length ? output.bytes : output.bytes.slice(0, output.length);
}

// assets/js/formats/zarr/codecs/javascript/blosc.js
var HEADER_BYTES = 16;
var DO_SHUFFLE = 1;
var MEMCPYED = 2;
var DO_BITSHUFFLE = 4;
var DO_DELTA = 8;
var DONT_SPLIT = 16;
var MAX_SPLITS = 16;
var MIN_SPLIT_ELEMENTS = 128;
var BLOSCLZ_MAX_DISTANCE = 8191;
var LZ4_MAX_EXPANSION = 255;
var CODEC_NAMES = ["blosclz", "lz4", "snappy", "zlib", "zstd"];
function corrupt3(detail) {
  return new ZarrFormatError(`Blosc data is corrupt: ${detail}.`);
}
function blosclzDecodeInto(input, output, start, end) {
  const limit = input.length;
  if (limit === 0) throw corrupt3("a blosclz stream is empty");
  const view = new DataView(output.buffer, output.byteOffset, output.length);
  let ip = 0;
  let op = start;
  let control = input[ip++] & 31;
  for (; ; ) {
    if (control >= 32) {
      let length = (control >>> 5) - 1;
      let distance = (control & 31) << 8;
      if (length === 6) {
        let code2;
        do {
          if (ip + 1 >= limit) throw corrupt3("a blosclz match is truncated");
          code2 = input[ip++];
          length += code2;
        } while (code2 === 255);
      } else if (ip + 1 >= limit) {
        throw corrupt3("a blosclz match is truncated");
      }
      const code = input[ip++];
      length += 3;
      let ref = op - distance - code;
      if (code === 255 && distance === 31 << 8) {
        if (ip + 1 >= limit) throw corrupt3("a blosclz match is truncated");
        distance = (input[ip] << 8) + input[ip + 1];
        ip += 2;
        ref = op - distance - BLOSCLZ_MAX_DISTANCE;
      }
      if (op + length > end) throw corrupt3("a blosclz match exceeds its block");
      if (ref - 1 < start) throw corrupt3("a blosclz match reaches before its block");
      if (ip >= limit) break;
      control = input[ip++];
      copyMatch(output, view, op, op - (ref - 1), length);
      op += length;
    } else {
      const run2 = control + 1;
      if (op + run2 > end || ip + run2 > limit) throw corrupt3("a blosclz literal run exceeds its bounds");
      if (run2 > 16) output.set(input.subarray(ip, ip + run2), op);
      else for (let k = 0; k < run2; k++) output[op + k] = input[ip + k];
      op += run2;
      ip += run2;
      if (ip >= limit) break;
      control = input[ip++];
    }
  }
  if (op !== end) throw corrupt3(`a blosclz stream decodes to ${formatCountOf(op - start, "byte")}, not ${end - start}`);
}
async function decodeStream(codec, stream, output, start, end) {
  if (codec === 1) {
    lz4DecodeBlockInto(stream, output, start, end);
  } else if (codec === 0) {
    blosclzDecodeInto(stream, output, start, end);
  } else if (codec === 4) {
    output.set(zstdDecompress(stream, end - start), start);
  } else if (codec === 3) {
    output.set(await inflate(stream, { format: "deflate", expectedSize: end - start, label: "A Blosc zlib stream" }), start);
  } else {
    const name = CODEC_NAMES[codec] ?? `codec ${codec}`;
    throw new ZarrUnsupportedError(`Blosc ${name}`, `This array is compressed with Blosc using ${name}, which this reader cannot decompress.`);
  }
}
function bitUntranspose(src, dest, at, count2, typesize, scratch) {
  const rowBytes = count2 >>> 3;
  for (let j = 0; j < typesize; j++) {
    for (let i2 = 0; i2 < rowBytes; i2++) {
      const base = i2 * 8 * typesize + j * 8;
      for (let k = 0; k < 8; k++) scratch[base + k] = src[(j * 8 + k) * rowBytes + i2];
    }
  }
  const total = count2 * typesize;
  const groupBytes = 8 * typesize;
  for (let j = 0; j < groupBytes; j += 8) {
    const byteInElement = j >>> 3;
    for (let i2 = 0; i2 + groupBytes <= total; i2 += groupBytes) {
      const b = i2 + j;
      const b0 = scratch[b];
      const b1 = scratch[b + 1];
      const b2 = scratch[b + 2];
      const b3 = scratch[b + 3];
      const b4 = scratch[b + 4];
      const b5 = scratch[b + 5];
      const b6 = scratch[b + 6];
      const b7 = scratch[b + 7];
      for (let k = 0; k < 8; k++) {
        dest[at + i2 + byteInElement + k * typesize] = b0 >> k & 1 | (b1 >> k & 1) << 1 | (b2 >> k & 1) << 2 | (b3 >> k & 1) << 3 | (b4 >> k & 1) << 4 | (b5 >> k & 1) << 5 | (b6 >> k & 1) << 6 | (b7 >> k & 1) << 7;
      }
    }
  }
}
function bitUnshuffle(src, dest, at, size, typesize, version) {
  let count2 = Math.floor(size / typesize);
  if (version <= 2 && count2 % 8 !== 0) {
    dest.set(src.subarray(0, size), at);
    return;
  }
  count2 -= count2 % 8;
  if (count2 > 0) bitUntranspose(src, dest, at, count2, typesize, new Uint8Array(count2 * typesize));
  const done = count2 * typesize;
  if (done < size) dest.set(src.subarray(done, size), at + done);
}
async function bloscDecode(input, expectedSize) {
  if (input.length < HEADER_BYTES) throw corrupt3("the header is truncated");
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const version = input[0];
  const codecVersion = input[1];
  const flags = input[2];
  const typesize = input[3];
  const nbytes = view.getUint32(4, true);
  const blocksize = view.getUint32(8, true);
  const cbytes = view.getUint32(12, true);
  if (version < 1 || version > 2) {
    throw new ZarrUnsupportedError(`Blosc format version ${version}`, `This array uses Blosc format version ${version}; this reader reads Blosc 1 frames (versions 1 and 2), as numcodecs writes them.`);
  }
  if (cbytes !== input.length) throw corrupt3(`the frame declares ${formatCountOf(cbytes, "byte")} and holds ${input.length}`);
  if (expectedSize !== null && nbytes !== expectedSize) {
    throw corrupt3(`the frame decodes to ${formatCountOf(nbytes, "byte")}, not the ${expectedSize} expected`);
  }
  if (expectedSize === null && nbytes > input.length * LZ4_MAX_EXPANSION + 64) {
    throw corrupt3(`the frame declares more bytes than its codecs can encode in ${input.length}`);
  }
  if (typesize === 0) throw corrupt3("the element size is zero");
  const codec = flags >>> 5;
  if ((flags & MEMCPYED) !== 0) {
    if (cbytes !== HEADER_BYTES + nbytes) throw corrupt3("a plain-copy frame has the wrong size");
    return input.slice(HEADER_BYTES);
  }
  if (codec > 4) throw corrupt3(`the codec format ${codec} is unknown`);
  if (codecVersion !== 1 && codec !== 4 && codec !== 3) {
    throw new ZarrUnsupportedError(`Blosc ${CODEC_NAMES[codec]} format ${codecVersion}`, `This array uses Blosc ${CODEC_NAMES[codec]} stream format ${codecVersion}, which this reader does not read.`);
  }
  const output = new Uint8Array(nbytes);
  if (nbytes === 0) return output;
  if (blocksize === 0 || blocksize > nbytes) throw corrupt3("the block size is invalid");
  const blocks = Math.ceil(nbytes / blocksize);
  const tableEnd = HEADER_BYTES + blocks * 4;
  if (tableEnd > cbytes) throw corrupt3("the block table is truncated");
  const byteShuffle = (flags & DO_SHUFFLE) !== 0 && typesize > 1;
  const bitShuffle = !byteShuffle && (flags & DO_BITSHUFFLE) !== 0 && blocksize >= typesize;
  const shuffled = byteShuffle || bitShuffle;
  const dontSplit = (flags & DONT_SPLIT) !== 0;
  const scratch = shuffled ? new Uint8Array(blocksize) : null;
  const pending = [];
  for (let block = 0; block < blocks; block++) {
    const outStart = block * blocksize;
    const size = Math.min(blocksize, nbytes - outStart);
    const leftover = size !== blocksize;
    const splits = !dontSplit && !leftover && typesize <= MAX_SPLITS && Math.floor(blocksize / typesize) >= MIN_SPLIT_ELEMENTS ? typesize : 1;
    if (size % splits !== 0) throw corrupt3("a block cannot be divided into its streams");
    const streamBytes = size / splits;
    const target = shuffled ? scratch : output;
    const targetStart = shuffled ? 0 : outStart;
    let cursor = view.getUint32(HEADER_BYTES + block * 4, true);
    if (cursor < tableEnd || cursor >= cbytes) throw corrupt3("a block offset is outside the frame");
    const streams = [];
    for (let split = 0; split < splits; split++) {
      if (cursor + 4 > cbytes) throw corrupt3("a stream length is truncated");
      const length = view.getInt32(cursor, true);
      cursor += 4;
      if (length <= 0 || length > streamBytes || cursor + length > cbytes) throw corrupt3("a stream length is invalid");
      const stream = input.subarray(cursor, cursor + length);
      cursor += length;
      const from = targetStart + split * streamBytes;
      if (length === streamBytes) target.set(stream, from);
      else {
        const decoding = decodeStream(codec, stream, target, from, from + streamBytes);
        decoding.catch(() => {
        });
        streams.push(decoding);
      }
    }
    if (shuffled) {
      await Promise.all(streams);
      if (byteShuffle) byteUnshuffleInto(scratch, output, outStart, size, typesize);
      else bitUnshuffle(scratch, output, outStart, size, typesize, version);
    } else {
      pending.push(...streams);
    }
  }
  await Promise.all(pending);
  if ((flags & DO_DELTA) !== 0) undoDelta(output, blocksize, typesize);
  return output;
}
function undoDelta(output, blocksize, typesize) {
  const word = typesize === 1 || typesize === 2 || typesize === 4 || typesize === 8 ? typesize : typesize % 8 === 0 ? 8 : 1;
  const first = Math.min(blocksize, output.length);
  const whole = first - first % word;
  for (let at = word; at < whole; at++) output[at] ^= output[at - word];
  for (let start = blocksize; start < output.length; start += blocksize) {
    const size = Math.min(blocksize, output.length - start);
    const end = start + size - size % word;
    for (let at = start; at < end; at++) output[at] ^= output[at - start];
  }
}

// assets/js/formats/zarr/codecs/blosc.js
var HEADER_BYTES2 = 16;
var MEMCPYED2 = 2;
var LZ4_MAX_EXPANSION2 = 255;
var CODEC_NAMES2 = ["blosclz", "lz4", "snappy", "zlib", "zstd"];
var ZLIB = 3;
var VERSIONED_CODECS = /* @__PURE__ */ new Set([0, 1, 2]);
function corrupt4(detail) {
  return new ZarrFormatError(`Blosc data is corrupt: ${detail}.`);
}
async function bloscDecode2(input, expectedSize, choices = null) {
  if (input.length < HEADER_BYTES2) throw corrupt4("the header is truncated");
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const version = input[0];
  const codecVersion = input[1];
  const flags = input[2];
  const nbytes = view.getUint32(4, true);
  const cbytes = view.getUint32(12, true);
  if (version < 1 || version > 2) {
    throw new ZarrUnsupportedError(`Blosc format version ${version}`, `This array uses Blosc format version ${version}; this reader reads Blosc 1 frames (versions 1 and 2), as numcodecs writes them.`);
  }
  if (cbytes !== input.length) throw corrupt4(`the frame declares ${formatCountOf(cbytes, "byte")} and holds ${input.length}`);
  if (expectedSize !== null && nbytes !== expectedSize) {
    throw corrupt4(`the frame decodes to ${formatCountOf(nbytes, "byte")}, not the ${expectedSize} expected`);
  }
  if (expectedSize === null && nbytes > input.length * LZ4_MAX_EXPANSION2 + 64) {
    throw corrupt4(`the frame declares more bytes than its codecs can encode in ${input.length}`);
  }
  if (input[3] === 0) throw corrupt4("the element size is zero");
  if ((flags & MEMCPYED2) === 0) {
    const codec = flags >>> 5;
    if (codec > 4) throw corrupt4(`the codec format ${codec} is unknown`);
    if (codec === 2) {
      throw new ZarrUnsupportedError("Blosc snappy", "This array is compressed with Blosc using snappy, which this reader cannot decompress.");
    }
    if (codecVersion !== 1 && VERSIONED_CODECS.has(codec)) {
      throw new ZarrUnsupportedError(`Blosc ${CODEC_NAMES2[codec]} format ${codecVersion}`, `This array uses Blosc ${CODEC_NAMES2[codec]} stream format ${codecVersion}, which this reader does not read.`);
    }
  }
  if (nbytes === 0) return new Uint8Array(0);
  const codecs = await wasmCodecs();
  try {
    if ((flags & MEMCPYED2) === 0 && flags >>> 5 === ZLIB) {
      const decoder = decoderFor("deflate", nbytes, choices);
      return await codecs.bloscZlib(input, nbytes, (stream, into) => inflate(stream, { format: "deflate", expectedSize: into.length, label: "A Blosc zlib stream", decoder, into }));
    }
    if (decoderFor("blosc", nbytes, choices) === "js") return await bloscDecode(input, expectedSize);
    return codecs.blosc(input, nbytes);
  } catch (error) {
    if (error?.name === "InflateError") throw corrupt4(error.message.replace(/\.$/, ""));
    if (!(error instanceof WasmCodecError)) throw error;
    throw corrupt4(`c-blosc refused it (${error.code})`);
  }
}

// assets/js/formats/zarr/codecs/crc32c.js
var TABLES2 = (() => {
  const tables = new Uint32Array(8 * 256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 2197175160 ^ c >>> 1 : c >>> 1;
    tables[n] = c >>> 0;
  }
  for (let n = 0; n < 256; n++) {
    let c = tables[n];
    for (let t = 1; t < 8; t++) {
      c = tables[c & 255] ^ c >>> 8;
      tables[t * 256 + n] = c >>> 0;
    }
  }
  return tables;
})();
function crc32c(bytes) {
  const t = TABLES2;
  let crc = 4294967295;
  let i2 = 0;
  const length = bytes.length;
  const fast = length - length % 8;
  const view = new DataView(bytes.buffer, bytes.byteOffset, length);
  for (; i2 < fast; i2 += 8) {
    const a = view.getInt32(i2, true) ^ crc;
    const b = view.getInt32(i2 + 4, true);
    crc = t[1792 + (a & 255)] ^ t[1536 + (a >>> 8 & 255)] ^ t[1280 + (a >>> 16 & 255)] ^ t[1024 + (a >>> 24)] ^ t[768 + (b & 255)] ^ t[512 + (b >>> 8 & 255)] ^ t[256 + (b >>> 16 & 255)] ^ t[b >>> 24];
  }
  for (; i2 < length; i2++) crc = t[(crc ^ bytes[i2]) & 255] ^ crc >>> 8;
  return ~crc >>> 0;
}
function crc32cDecode(input) {
  if (input.length < 4) throw new ZarrFormatError("A CRC-32C checksum is truncated.");
  const end = input.length - 4;
  const stored = (input[end] | input[end + 1] << 8 | input[end + 2] << 16 | input[end + 3] << 24) >>> 0;
  if (crc32c(input.subarray(0, end)) !== stored) {
    throw new ZarrFormatError("A chunk is damaged: its CRC-32C checksum does not match.");
  }
  return input.subarray(0, end);
}

// assets/js/formats/zarr/codecs/lz4.js
function corrupt5(detail) {
  return new ZarrFormatError(`LZ4 data is corrupt: ${detail}.`);
}
function asFormatError(error) {
  if (!(error instanceof WasmCodecError)) return error;
  return corrupt5(`a block does not decode to its size (${error.code})`);
}
async function lz4DecodeBlocks(input, segments, total, choices = null) {
  if (decoderFor("lz4", total, choices) === "js") {
    const output = new Uint8Array(total);
    for (const { at, stored, start, size } of segments) {
      if (at < 0 || stored < 0 || at + stored > input.length || start < 0 || size < 0 || start + size > total) {
        throw corrupt5("a block does not decode to its size (a block lies outside its buffers)");
      }
      if (stored === size) output.set(input.subarray(at, at + stored), start);
      else lz4DecodeBlockInto(input.subarray(at, at + stored), output, start, start + size);
    }
    return output;
  }
  const codecs = await wasmCodecs();
  try {
    return codecs.lz4Blocks(input, segments, total);
  } catch (error) {
    throw asFormatError(error);
  }
}
async function numcodecsLz4Decode2(input, expectedSize, choices = null) {
  if (input.length < 4) throw corrupt5("the size header is truncated");
  const size = (input[0] | input[1] << 8 | input[2] << 16 | input[3] << 24) >>> 0;
  if (expectedSize !== null && size !== expectedSize) {
    throw corrupt5(`it declares ${formatCountOf(size, "byte")}, not the ${expectedSize} expected`);
  }
  if (size > (input.length - 4) * 255 + 16) throw corrupt5(`it declares more bytes than LZ4 can encode in ${input.length}`);
  if (size === 0) return new Uint8Array(0);
  if (decoderFor("lz4", size, choices) === "js") return numcodecsLz4Decode(input, expectedSize);
  const codecs = await wasmCodecs();
  try {
    return codecs.lz4Block(input.subarray(4), size);
  } catch (error) {
    throw asFormatError(error);
  }
}

// assets/js/formats/zarr/codecs/zstd.js
var FRAME_MAGIC2 = 4247762216;
var SKIPPABLE_MASK2 = 4294967280;
var SKIPPABLE_MAGIC2 = 407710288;
var DICTIONARY_WRONG = "a wrong dictionary";
function corrupt6(detail) {
  return new ZarrFormatError(`Zstandard data is corrupt: ${detail}.`);
}
function startsWithFrame(input) {
  if (input.length < 4) return false;
  const magic = (input[0] | input[1] << 8 | input[2] << 16 | input[3] << 24) >>> 0;
  return magic === FRAME_MAGIC2 || (magic & SKIPPABLE_MASK2) >>> 0 === SKIPPABLE_MAGIC2;
}
function lowered(message) {
  return message.charAt(0).toLowerCase() + message.slice(1).replace(/\.$/, "");
}
async function zstdDecompress2(input, expectedSize = null, { bound = null, choices = null } = {}) {
  if (!startsWithFrame(input)) throw corrupt6("it does not start with a Zstandard frame");
  if (decoderFor("zstd", expectedSize, choices) === "js") {
    const output = zstdDecompress(input, expectedSize);
    if (bound !== null && output.length > bound) throw corrupt6(`it decodes to more than the ${formatCountOf(bound, "byte")} it may hold`);
    return output;
  }
  const codecs = await wasmCodecs();
  try {
    return codecs.zstd(input, expectedSize, bound);
  } catch (error) {
    if (!(error instanceof WasmCodecError)) throw error;
    if (error.code === DICTIONARY_WRONG) {
      throw new ZarrUnsupportedError("Zstandard dictionary", "This Zstandard data was compressed with a dictionary, which Zarr never uses and this reader does not read.");
    }
    throw corrupt6(lowered(error.message));
  }
}

// assets/js/formats/rds/errors.js
var RdsFormatError = class extends Error {
  /**
   * @param {string} message
   * @param {{slot?: string|null, cause?: unknown}} [options]
   */
  constructor(message, { slot = null, cause } = {}) {
    super(slot === null ? message : `${message} (at ${slot})`, cause === void 0 ? void 0 : { cause });
    this.name = "RdsFormatError";
    this.slot = slot;
  }
};
var RdsUnsupportedError = class extends Error {
  /**
   * @param {string} feature - What is not supported, in a few words
   * @param {string} message - What it is and what to do, in plain words
   * @param {{slot?: string|null, cause?: unknown}} [options]
   */
  constructor(feature, message, { slot = null, cause } = {}) {
    super(message, cause === void 0 ? void 0 : { cause });
    this.name = "RdsUnsupportedError";
    this.feature = feature;
    this.slot = slot;
  }
};

// assets/js/formats/rds/bzip2.js
var BLOCK_MAGIC_HIGH = 3227993;
var BLOCK_MAGIC_LOW = 2511705;
var END_MAGIC_HIGH = 1536581;
var END_MAGIC_LOW = 3690640;
var GROUP_SIZE = 50;
var MAX_GROUPS = 6;
var MAX_CODE_LENGTH = 20;
var MAX_SELECTORS = 18002;
var crcTable = null;
function crcTableOf() {
  if (crcTable !== null) return crcTable;
  crcTable = new Uint32Array(256);
  for (let i2 = 0; i2 < 256; i2++) {
    let c = i2 << 24;
    for (let k = 0; k < 8; k++) c = c & 2147483648 ? c << 1 ^ 79764919 : c << 1;
    crcTable[i2] = c >>> 0;
  }
  return crcTable;
}
function damaged(message) {
  return new RdsFormatError(`The bzip2 stream is damaged: ${message}.`);
}
var Bits = class {
  constructor() {
    this.bytes = new Uint8Array(0);
    this.pos = 0;
    this.buffer = 0;
    this.count = 0;
  }
  /** Append input, dropping what was read. */
  append(piece) {
    const rest = this.bytes.length - this.pos;
    const joined = new Uint8Array(rest + piece.length);
    joined.set(this.bytes.subarray(this.pos));
    joined.set(piece, rest);
    this.bytes = joined;
    this.pos = 0;
  }
  get buffered() {
    return this.bytes.length - this.pos;
  }
  read(n) {
    while (this.count < n) {
      if (this.pos >= this.bytes.length) throw damaged("it ends inside a block");
      this.buffer = (this.buffer << 8 | this.bytes[this.pos++]) >>> 0;
      this.count += 8;
    }
    this.count -= n;
    return this.buffer >>> this.count & (1 << n) - 1;
  }
  bit() {
    if (this.count === 0) {
      if (this.pos >= this.bytes.length) throw damaged("it ends inside a block");
      this.buffer = this.bytes[this.pos++];
      this.count = 8;
    }
    this.count -= 1;
    return this.buffer >>> this.count & 1;
  }
  read32() {
    return (this.read(16) << 16 | this.read(16)) >>> 0;
  }
  /** Drop the bits left in the current byte (a stream ends on a byte boundary). */
  align() {
    this.count -= this.count % 8;
  }
  /** Whole bytes left, counting buffered bits. */
  get bytesLeft() {
    return this.bytes.length - this.pos + Math.floor(this.count / 8);
  }
};
function decodeTables(lengths, alphaSize) {
  let minLength = 32;
  let maxLength = 0;
  for (let i2 = 0; i2 < alphaSize; i2++) {
    if (lengths[i2] > maxLength) maxLength = lengths[i2];
    if (lengths[i2] < minLength) minLength = lengths[i2];
  }
  const perm = new Int32Array(alphaSize);
  let p = 0;
  for (let length = minLength; length <= maxLength; length++) {
    for (let symbol = 0; symbol < alphaSize; symbol++) if (lengths[symbol] === length) perm[p++] = symbol;
  }
  const base = new Int32Array(MAX_CODE_LENGTH + 2);
  const limit = new Int32Array(MAX_CODE_LENGTH + 2).fill(-1);
  for (let i2 = 0; i2 < alphaSize; i2++) base[lengths[i2] + 1]++;
  for (let i2 = 1; i2 < base.length; i2++) base[i2] += base[i2 - 1];
  let vec = 0;
  for (let length = minLength; length <= maxLength; length++) {
    vec += base[length + 1] - base[length];
    limit[length] = vec - 1;
    vec <<= 1;
  }
  for (let length = minLength + 1; length <= maxLength; length++) {
    base[length] = (limit[length - 1] + 1 << 1) - base[length];
  }
  return { minLength, maxLength, perm, base, limit };
}
function decodeBlock(bits2, blockSize, tt) {
  const storedCrc = bits2.read32();
  if (bits2.bit()) {
    throw new RdsUnsupportedError("randomised bzip2 block", "This bzip2 file uses randomised blocks, which no current bzip2 writes. Compress it again with bzip2 or gzip.");
  }
  const origPtr = bits2.read(24);
  const used = bits2.read(16);
  const seqToUnseq = [];
  for (let i2 = 0; i2 < 16; i2++) {
    if (used & 1 << 15 - i2) {
      const word = bits2.read(16);
      for (let j = 0; j < 16; j++) if (word & 1 << 15 - j) seqToUnseq.push(i2 * 16 + j);
    }
  }
  if (seqToUnseq.length === 0) throw damaged("a block uses no byte value");
  const alphaSize = seqToUnseq.length + 2;
  const groups = bits2.read(3);
  if (groups < 2 || groups > MAX_GROUPS) throw damaged(`a block has ${groups} Huffman tables`);
  const selectorCount = bits2.read(15);
  if (selectorCount < 1) throw damaged("a block has no table selectors");
  const order = [0, 1, 2, 3, 4, 5].slice(0, groups);
  const selectors = new Uint8Array(Math.min(selectorCount, MAX_SELECTORS));
  for (let i2 = 0; i2 < selectorCount; i2++) {
    let j = 0;
    while (bits2.bit()) {
      j++;
      if (j >= groups) throw damaged("a table selector names no table");
    }
    const value = order[j];
    for (let k = j; k > 0; k--) order[k] = order[k - 1];
    order[0] = value;
    if (i2 < MAX_SELECTORS) selectors[i2] = value;
  }
  const tables = [];
  for (let t = 0; t < groups; t++) {
    const lengths = new Uint8Array(alphaSize);
    let length = bits2.read(5);
    for (let symbol2 = 0; symbol2 < alphaSize; symbol2++) {
      for (; ; ) {
        if (length < 1 || length > MAX_CODE_LENGTH) throw damaged("a code length is out of range");
        if (!bits2.bit()) break;
        length += bits2.bit() ? -1 : 1;
      }
      lengths[symbol2] = length;
    }
    tables.push(decodeTables(lengths, alphaSize));
  }
  const endOfBlock = alphaSize - 1;
  const counts = new Int32Array(256);
  const mtf = new Uint8Array(256);
  for (let i2 = 0; i2 < 256; i2++) mtf[i2] = i2;
  let groupIndex = -1;
  let groupLeft = 0;
  let table = null;
  const nextSymbol = () => {
    if (groupLeft === 0) {
      groupIndex++;
      if (groupIndex >= selectors.length) throw damaged("a block uses more table selectors than it has");
      table = tables[selectors[groupIndex]];
      groupLeft = GROUP_SIZE;
    }
    groupLeft--;
    let length = table.minLength;
    let code = bits2.read(length);
    while (code > table.limit[length]) {
      length++;
      if (length > table.maxLength) throw damaged("a Huffman code is not in its table");
      code = code << 1 | bits2.bit();
    }
    const index = code - table.base[length];
    if (index < 0 || index >= table.perm.length) throw damaged("a Huffman code is not in its table");
    return table.perm[index];
  };
  let count2 = 0;
  let symbol = nextSymbol();
  for (; ; ) {
    if (symbol === endOfBlock) break;
    if (symbol <= 1) {
      let run2 = 0;
      let weight = 1;
      do {
        run2 += symbol === 0 ? weight : 2 * weight;
        weight *= 2;
        if (run2 > blockSize) throw damaged("a run is longer than its block");
        symbol = nextSymbol();
      } while (symbol <= 1);
      const value2 = seqToUnseq[mtf[0]];
      if (count2 + run2 > blockSize) throw damaged("a block is longer than its block size");
      counts[value2] += run2;
      tt.fill(value2, count2, count2 + run2);
      count2 += run2;
      continue;
    }
    const position2 = symbol - 1;
    if (position2 >= seqToUnseq.length) throw damaged("a symbol is outside the block alphabet");
    const front = mtf[position2];
    mtf.copyWithin(1, 0, position2);
    mtf[0] = front;
    const value = seqToUnseq[front];
    if (count2 >= blockSize) throw damaged("a block is longer than its block size");
    counts[value]++;
    tt[count2++] = value;
    symbol = nextSymbol();
  }
  if (origPtr >= count2) throw damaged("a block starts outside itself");
  const start = new Int32Array(256);
  for (let i2 = 0, sum = 0; i2 < 256; i2++) {
    start[i2] = sum;
    sum += counts[i2];
  }
  for (let i2 = 0; i2 < count2; i2++) {
    const value = tt[i2] & 255;
    tt[start[value]++] |= i2 << 8;
  }
  const out = new Uint8Array(count2);
  let position = tt[origPtr] >>> 8;
  for (let i2 = 0; i2 < count2; i2++) {
    const entry = tt[position];
    out[i2] = entry & 255;
    position = entry >>> 8;
  }
  return { out, storedCrc };
}
function expandRuns(bytes) {
  let total = 0;
  for (let i2 = 0, run2 = 0, last = -1; i2 < bytes.length; i2++) {
    if (run2 === 4) {
      total += bytes[i2];
      run2 = 0;
      last = -1;
      continue;
    }
    const value = bytes[i2];
    run2 = value === last ? run2 + 1 : 1;
    last = value;
    total++;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (let i2 = 0, run2 = 0, last = -1; i2 < bytes.length; i2++) {
    if (run2 === 4) {
      out.fill(last, o, o + bytes[i2]);
      o += bytes[i2];
      run2 = 0;
      last = -1;
      continue;
    }
    const value = bytes[i2];
    run2 = value === last ? run2 + 1 : 1;
    last = value;
    out[o++] = value;
  }
  return out;
}
function blockCrc(bytes) {
  const table = crcTableOf();
  let crc = 4294967295;
  for (let i2 = 0; i2 < bytes.length; i2++) crc = (crc << 8 ^ table[(crc >>> 24 ^ bytes[i2]) & 255]) >>> 0;
  return ~crc >>> 0;
}
async function* bunzip2(pieces, { signal = null } = {}) {
  const iterator = pieces[Symbol.asyncIterator]();
  const bits2 = new Bits();
  let ended = false;
  const ensure = async (bytes) => {
    while (!ended && bits2.buffered < bytes) {
      const { value, done } = await iterator.next();
      if (done) ended = true;
      else bits2.append(value);
    }
  };
  let streams = 0;
  for (; ; ) {
    await ensure(4);
    if (bits2.bytesLeft === 0 && streams > 0) return;
    if (bits2.read(8) !== 66 || bits2.read(8) !== 90 || bits2.read(8) !== 104) {
      if (streams > 0) throw damaged("data follows its end");
      throw damaged("it does not start with BZh");
    }
    const level = bits2.read(8) - 48;
    if (level < 1 || level > 9) throw damaged(`its block size digit is ${level}`);
    const blockSize = level * 1e5;
    const tt = new Uint32Array(blockSize);
    streams++;
    for (; ; ) {
      throwIfAborted(signal);
      await ensure(blockSize * 1.25 + 4096);
      const high = bits2.read(24);
      const low = bits2.read(24);
      if (high === END_MAGIC_HIGH && low === END_MAGIC_LOW) {
        bits2.read32();
        bits2.align();
        break;
      }
      if (high !== BLOCK_MAGIC_HIGH || low !== BLOCK_MAGIC_LOW) throw damaged("a block does not start with its marker");
      const { out, storedCrc } = decodeBlock(bits2, blockSize, tt);
      const expanded = expandRuns(out);
      if (blockCrc(expanded) !== storedCrc) throw damaged("a block does not match its checksum");
      yield expanded;
    }
    await ensure(1);
    if (ended && bits2.bytesLeft === 0) return;
  }
}

// assets/js/formats/rds/xz.js
function damaged2(message) {
  return new RdsFormatError(`The xz stream is damaged: ${message}.`);
}
var Input = class {
  constructor(iterator) {
    this.iterator = iterator;
    this.bytes = new Uint8Array(0);
    this.pos = 0;
    this.ended = false;
    this.base = 0;
  }
  /** The absolute position in the compressed stream. */
  get position() {
    return this.base + this.pos;
  }
  get buffered() {
    return this.bytes.length - this.pos;
  }
  async ensure(count2) {
    while (this.bytes.length - this.pos < count2 && !this.ended) {
      const { value, done } = await this.iterator.next();
      if (done) {
        this.ended = true;
        break;
      }
      const rest = this.bytes.length - this.pos;
      const joined = new Uint8Array(rest + value.length);
      joined.set(this.bytes.subarray(this.pos));
      joined.set(value, rest);
      this.base += this.pos;
      this.bytes = joined;
      this.pos = 0;
    }
    if (this.bytes.length - this.pos < count2) throw damaged2("it ends early");
  }
  byte() {
    return this.bytes[this.pos++];
  }
  /** A multibyte integer, reading more input as it needs. */
  async varintAsync() {
    let value = 0;
    for (let shift = 0; shift < 63; shift += 7) {
      await this.ensure(1);
      const b = this.bytes[this.pos++];
      value += (b & 127) * 2 ** shift;
      if ((b & 128) === 0) return value;
    }
    throw damaged2("a size field is too long");
  }
  /** A multibyte integer (7 bits per byte, low first). */
  varint() {
    let value = 0;
    for (let shift = 0; shift < 63; shift += 7) {
      if (this.pos >= this.bytes.length) throw damaged2("a size field ends early");
      const b = this.bytes[this.pos++];
      value += (b & 127) * 2 ** shift;
      if ((b & 128) === 0) return value;
    }
    throw damaged2("a size field is too long");
  }
};
var STATES = 12;
var POS_STATES_MAX = 16;
var LITERAL_STATES = 7;
var END_POS_MODEL_INDEX = 14;
var FULL_DISTANCES = 128;
var ALIGN_BITS = 4;
var MATCH_MIN = 2;
var LengthModel = class {
  constructor() {
    this.choice = new Uint16Array(2);
    this.low = new Uint16Array(POS_STATES_MAX << 3);
    this.mid = new Uint16Array(POS_STATES_MAX << 3);
    this.high = new Uint16Array(256);
  }
  reset() {
    this.choice.fill(1024);
    this.low.fill(1024);
    this.mid.fill(1024);
    this.high.fill(1024);
  }
};
var Lzma = class {
  constructor(dictionarySize) {
    this.dict = new Uint8Array(dictionarySize);
    this.dictSize = dictionarySize;
    this.pos = 0;
    this.full = 0;
    this.pending = 0;
    this.isMatch = new Uint16Array(STATES << 4);
    this.isRep = new Uint16Array(STATES);
    this.isRepG0 = new Uint16Array(STATES);
    this.isRepG1 = new Uint16Array(STATES);
    this.isRepG2 = new Uint16Array(STATES);
    this.isRep0Long = new Uint16Array(STATES << 4);
    this.posSlot = new Uint16Array(4 << 6);
    this.specPos = new Uint16Array(FULL_DISTANCES - END_POS_MODEL_INDEX + 1);
    this.align = new Uint16Array(1 << ALIGN_BITS);
    this.lengths = new LengthModel();
    this.repLengths = new LengthModel();
    this.literal = new Uint16Array(768 << 4);
    this.lc = 0;
    this.lp = 0;
    this.pb = 0;
    this.state = 0;
    this.reps = [0, 0, 0, 0];
    this.haveProperties = false;
    this.total = 0;
  }
  resetDictionary() {
    this.pos = 0;
    this.full = 0;
  }
  setProperties(byte) {
    if (byte > (4 * 5 + 4) * 9 + 8) throw damaged2("an LZMA properties byte is out of range");
    this.lc = byte % 9;
    const rest = Math.floor(byte / 9);
    this.lp = rest % 5;
    this.pb = Math.floor(rest / 5);
    if (this.lc + this.lp > 4) throw damaged2("LZMA2 literal bits exceed four");
    const size = 768 << this.lc + this.lp;
    if (this.literal.length !== size) this.literal = new Uint16Array(size);
    this.haveProperties = true;
  }
  resetState() {
    this.isMatch.fill(1024);
    this.isRep.fill(1024);
    this.isRepG0.fill(1024);
    this.isRepG1.fill(1024);
    this.isRepG2.fill(1024);
    this.isRep0Long.fill(1024);
    this.posSlot.fill(1024);
    this.specPos.fill(1024);
    this.align.fill(1024);
    this.lengths.reset();
    this.repLengths.reset();
    this.literal.fill(1024);
    this.state = 0;
    this.reps = [0, 0, 0, 0];
  }
  /** Copy `length` stored bytes into the dictionary. */
  putStored(bytes, start, length, emit) {
    for (let i2 = 0; i2 < length; i2++) {
      this.dict[this.pos++] = bytes[start + i2];
      this.pending++;
      if (this.pos === this.dictSize) this.wrap(emit);
    }
    this.full = Math.min(this.dictSize, this.full + length);
  }
  /** The dictionary filled to its end: hand on what it holds, start again at 0. */
  wrap(emit) {
    this.flush(emit);
    this.pos = 0;
  }
  /** Hand on the bytes written since the last flush. */
  flush(emit) {
    if (this.pending === 0) return;
    emit(this.dict.slice(this.pos - this.pending, this.pos));
    this.pending = 0;
  }
  /**
   * Decode one LZMA chunk of `outSize` bytes from `input[start, start +
   * inSize)`.
   */
  decodeChunk(input, start, inSize, outSize, emit) {
    const end = start + inSize;
    let p = start;
    if (input[p++] !== 0) throw damaged2("a range coder does not start with 0");
    let range = 4294967295;
    let code = 0;
    for (let i2 = 0; i2 < 4; i2++) code = (code << 8 | input[p++]) >>> 0;
    const dict = this.dict;
    const dictSize = this.dictSize;
    const { isMatch, isRep, isRepG0, isRepG1, isRepG2, isRep0Long, posSlot, specPos, align, literal } = this;
    const lc = this.lc;
    const lpMask = (1 << this.lp) - 1;
    const pbMask = (1 << this.pb) - 1;
    let state = this.state;
    let [rep0, rep1, rep2, rep3] = this.reps;
    let pos = this.pos;
    let full = this.full;
    let pending = this.pending;
    let total = this.total;
    let left = outSize;
    const bit = (probs, index) => {
      if (range < 16777216) {
        if (p >= end) throw damaged2("an LZMA chunk ends early");
        range = range << 8 >>> 0;
        code = (code << 8 | input[p++]) >>> 0;
      }
      const prob = probs[index];
      const bound = (range >>> 11) * prob;
      if (code < bound) {
        range = bound;
        probs[index] = prob + (2048 - prob >>> 5);
        return 0;
      }
      range = range - bound >>> 0;
      code = code - bound >>> 0;
      probs[index] = prob - (prob >>> 5);
      return 1;
    };
    const tree = (probs, offset, bits2) => {
      let m = 1;
      for (let i2 = 0; i2 < bits2; i2++) m = m << 1 | bit(probs, offset + m);
      return m - (1 << bits2);
    };
    const reverseTree = (probs, offset, bits2) => {
      let m = 1;
      let symbol = 0;
      for (let i2 = 0; i2 < bits2; i2++) {
        const b = bit(probs, offset + m);
        m = m << 1 | b;
        symbol |= b << i2;
      }
      return symbol;
    };
    const direct = (bits2) => {
      let result = 0;
      for (let i2 = 0; i2 < bits2; i2++) {
        if (range < 16777216) {
          if (p >= end) throw damaged2("an LZMA chunk ends early");
          range = range << 8 >>> 0;
          code = (code << 8 | input[p++]) >>> 0;
        }
        range >>>= 1;
        if (code >= range) {
          code = code - range >>> 0;
          result = result * 2 + 1;
        } else {
          result *= 2;
        }
      }
      return result;
    };
    const length = (model, posState) => {
      if (bit(model.choice, 0) === 0) return tree(model.low, posState << 3, 3);
      if (bit(model.choice, 1) === 0) return 8 + tree(model.mid, posState << 3, 3);
      return 16 + tree(model.high, 0, 8);
    };
    const byteAt = (distance) => {
      let index = pos - distance - 1;
      if (index < 0) index += dictSize;
      return dict[index];
    };
    const put = (value) => {
      dict[pos++] = value;
      pending++;
      if (pos === dictSize) {
        emit(dict.slice(pos - pending, pos));
        pending = 0;
        pos = 0;
      }
      if (full < dictSize) full++;
    };
    while (left > 0) {
      const posState = total & pbMask;
      if (bit(isMatch, state << 4 | posState) === 0) {
        const previous = full > 0 ? byteAt(0) : 0;
        const base = 768 * (((total & lpMask) << lc) + (previous >>> 8 - lc));
        let symbol = 1;
        if (state < LITERAL_STATES) {
          do
            symbol = symbol << 1 | bit(literal, base + symbol);
          while (symbol < 256);
        } else {
          let matchByte = byteAt(rep0);
          do {
            const matchBit = matchByte >>> 7 & 1;
            matchByte <<= 1;
            const b = bit(literal, base + (1 + matchBit << 8) + symbol);
            symbol = symbol << 1 | b;
            if (matchBit !== b) {
              while (symbol < 256) symbol = symbol << 1 | bit(literal, base + symbol);
              break;
            }
          } while (symbol < 256);
        }
        put(symbol & 255);
        total++;
        left--;
        state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
        continue;
      }
      let len;
      if (bit(isRep, state) === 0) {
        rep3 = rep2;
        rep2 = rep1;
        rep1 = rep0;
        len = length(this.lengths, posState);
        state = state < LITERAL_STATES ? 7 : 10;
        const lenState = len < 4 ? len : 3;
        const slot = tree(posSlot, lenState << 6, 6);
        if (slot < 4) {
          rep0 = slot;
        } else {
          const bits2 = (slot >>> 1) - 1;
          let distance = (2 | slot & 1) * 2 ** bits2;
          if (slot < END_POS_MODEL_INDEX) {
            distance += reverseTree(specPos, distance - slot - 1, bits2);
          } else {
            distance += direct(bits2 - ALIGN_BITS) * (1 << ALIGN_BITS);
            distance += reverseTree(align, 0, ALIGN_BITS);
          }
          rep0 = distance;
        }
        if (rep0 === 4294967295) throw damaged2("an LZMA chunk holds an end marker");
      } else {
        if (bit(isRepG0, state) === 0) {
          if (bit(isRep0Long, state << 4 | posState) === 0) {
            if (full === 0) throw damaged2("a repeated byte refers before the start");
            state = state < LITERAL_STATES ? 9 : 11;
            put(byteAt(rep0));
            total++;
            left--;
            continue;
          }
        } else {
          let distance;
          if (bit(isRepG1, state) === 0) {
            distance = rep1;
          } else {
            if (bit(isRepG2, state) === 0) {
              distance = rep2;
            } else {
              distance = rep3;
              rep3 = rep2;
            }
            rep2 = rep1;
          }
          rep1 = rep0;
          rep0 = distance;
        }
        len = length(this.repLengths, posState);
        state = state < LITERAL_STATES ? 8 : 11;
      }
      len += MATCH_MIN;
      if (rep0 >= full) throw damaged2("a match refers before the start of the dictionary");
      if (len > left) throw damaged2("a match runs past its chunk");
      let from = pos - rep0 - 1;
      if (from < 0) from += dictSize;
      for (let i2 = 0; i2 < len; i2++) {
        dict[pos++] = dict[from++];
        if (from === dictSize) from = 0;
        if (pos === dictSize) {
          emit(dict.slice(pos - pending - i2 - 1, pos));
          pending = -i2 - 1;
          pos = 0;
        }
      }
      pending += len;
      full = Math.min(dictSize, full + len);
      total += len;
      left -= len;
    }
    this.state = state;
    this.reps = [rep0, rep1, rep2, rep3];
    this.pos = pos;
    this.full = full;
    this.pending = pending;
    this.total = total;
    this.flush(emit);
    return p;
  }
};
var CHECK_SIZES = [0, 4, 4, 4, 8, 8, 8, 16, 16, 16, 32, 32, 32, 64, 64, 64];
async function* decodeLzma2(input, lzma, signal) {
  const out = [];
  const emit = (bytes) => out.push(bytes);
  for (; ; ) {
    throwIfAborted(signal);
    await input.ensure(1);
    const control = input.byte();
    if (control === 0) return;
    if (control === 1 || control === 2) {
      await input.ensure(2);
      const size = (input.byte() << 8 | input.byte()) + 1;
      if (control === 1) lzma.resetDictionary();
      await input.ensure(size);
      lzma.putStored(input.bytes, input.pos, size, emit);
      lzma.total += size;
      input.pos += size;
      lzma.flush(emit);
    } else if (control >= 128) {
      await input.ensure(4);
      const outSize = ((control & 31) << 16) + (input.byte() << 8 | input.byte()) + 1;
      const inSize = (input.byte() << 8 | input.byte()) + 1;
      const reset = control >>> 5 & 3;
      if (reset >= 2) {
        await input.ensure(1);
        lzma.setProperties(input.byte());
      }
      if (reset === 3) lzma.resetDictionary();
      if (!lzma.haveProperties) throw damaged2("an LZMA chunk comes before its properties");
      if (reset >= 1) lzma.resetState();
      await input.ensure(inSize);
      const used = lzma.decodeChunk(input.bytes, input.pos, inSize, outSize, emit);
      if (used > input.pos + inSize) throw damaged2("an LZMA chunk is longer than it says");
      input.pos += inSize;
    } else {
      throw damaged2(`an LZMA2 chunk has the control byte ${control}`);
    }
    while (out.length > 0) yield out.shift();
  }
}
function dictionarySizeOf(byte) {
  if (byte > 40) throw damaged2("the LZMA2 dictionary size is out of range");
  if (byte === 40) return 4294967295;
  return (2 | byte & 1) * 2 ** (Math.floor(byte / 2) + 11);
}
async function* unxz(pieces, { signal = null } = {}) {
  const input = new Input(pieces[Symbol.asyncIterator]());
  let streams = 0;
  for (; ; ) {
    if (streams > 0) {
      try {
        await input.ensure(1);
      } catch {
        return;
      }
      while (input.buffered > 0 && input.bytes[input.pos] === 0) {
        await input.ensure(4);
        input.pos += 4;
        if (input.buffered === 0) {
          try {
            await input.ensure(1);
          } catch {
            return;
          }
        }
      }
    }
    await input.ensure(12);
    const header = input.pos;
    const magic = [253, 55, 122, 88, 90, 0];
    for (let i2 = 0; i2 < 6; i2++) if (input.bytes[header + i2] !== magic[i2]) throw damaged2(streams === 0 ? "it does not start with the xz signature" : "data follows its end");
    const check = input.bytes[header + 7] & 15;
    const storedHeaderCrc = new DataView(input.bytes.buffer, input.bytes.byteOffset + header + 8, 4).getUint32(0, true);
    if (crc32(input.bytes.subarray(header + 6, header + 8)) !== storedHeaderCrc) throw damaged2("its stream header does not match its checksum");
    input.pos += 12;
    streams++;
    for (; ; ) {
      await input.ensure(1);
      const sizeByte = input.bytes[input.pos];
      if (sizeByte === 0) break;
      const headerSize = (sizeByte + 1) * 4;
      await input.ensure(headerSize);
      const headerAt = input.pos;
      const blockStart = input.position;
      const storedCrc = new DataView(input.bytes.buffer, input.bytes.byteOffset + headerAt + headerSize - 4, 4).getUint32(0, true);
      if (crc32(input.bytes.subarray(headerAt, headerAt + headerSize - 4)) !== storedCrc) throw damaged2("a block header does not match its checksum");
      input.pos += 1;
      const flags = input.byte();
      const filters = (flags & 3) + 1;
      let uncompressedSize = null;
      if (flags & 64) input.varint();
      if (flags & 128) uncompressedSize = input.varint();
      let lzma2Properties = null;
      for (let f = 0; f < filters; f++) {
        const id = input.varint();
        const size = input.varint();
        if (id !== 33 || f !== filters - 1) {
          throw new RdsUnsupportedError("xz filter", `This xz file uses the filter ${id} besides LZMA2, which Cellucid does not read. Compress it again with xz defaults, or with gzip.`);
        }
        if (size !== 1) throw damaged2("the LZMA2 filter properties are not one byte");
        lzma2Properties = input.byte();
      }
      input.pos = headerAt + headerSize;
      let dictionarySize = dictionarySizeOf(lzma2Properties);
      if (uncompressedSize !== null) dictionarySize = Math.max(4096, Math.min(dictionarySize, uncompressedSize));
      const lzma = new Lzma(dictionarySize);
      let produced = 0;
      let crc = check === 1 ? 0 : null;
      for await (const piece of decodeLzma2(input, lzma, signal)) {
        produced += piece.length;
        if (crc !== null) {
          crc = crc32(piece, crc);
        }
        yield piece;
      }
      if (uncompressedSize !== null && produced !== uncompressedSize) throw damaged2("a block does not decode to the size its header states");
      while ((input.position - blockStart) % 4 !== 0) {
        await input.ensure(1);
        if (input.byte() !== 0) throw damaged2("block padding is not zero");
      }
      const checkSize = CHECK_SIZES[check];
      await input.ensure(checkSize);
      if (check === 1) {
        const stored = new DataView(input.bytes.buffer, input.bytes.byteOffset + input.pos, 4).getUint32(0, true);
        if (crc !== stored) throw damaged2("a block does not match its CRC32");
      }
      input.pos += checkSize;
    }
    const indexStart = input.position;
    input.pos += 1;
    const records = await input.varintAsync();
    for (let i2 = 0; i2 < records; i2++) {
      await input.varintAsync();
      await input.varintAsync();
    }
    while ((input.position - indexStart) % 4 !== 0) {
      await input.ensure(1);
      input.pos += 1;
    }
    await input.ensure(4 + 12);
    input.pos += 4;
    if (input.bytes[input.pos + 10] !== 89 || input.bytes[input.pos + 11] !== 90) throw damaged2("its stream footer is missing");
    input.pos += 12;
  }
}

// assets/js/formats/zarr/codecs/pipeline.js
var unknownSize = () => null;
var sameSize = (size) => size;
function inflateDecoder(name, format) {
  return {
    name,
    allocates: true,
    inputSize: unknownSize,
    async decode(bytes, expectedSize, choices = null) {
      try {
        return await inflate(bytes, { format, expectedSize, label: `A ${name} chunk`, choices });
      } catch (cause) {
        if (cause?.name === "InflateError") throw new ZarrFormatError(cause.message, { cause });
        throw cause;
      }
    }
  };
}
function streamDecoder(name, decompress) {
  return {
    name,
    allocates: true,
    inputSize: unknownSize,
    async decode(bytes, expectedSize) {
      const pieces = [];
      let length = 0;
      try {
        for await (const piece of decompress((async function* one() {
          yield bytes;
        })())) {
          length += piece.length;
          if (expectedSize !== null && length > expectedSize) {
            throw new ZarrFormatError(`A ${name} chunk decodes to more than its ${formatCountOf(expectedSize, "byte")}.`);
          }
          pieces.push(piece);
        }
      } catch (cause) {
        if (cause instanceof ZarrFormatError) throw cause;
        throw new ZarrFormatError(`A ${name} chunk could not be decompressed: ${cause?.message ?? cause}`, { cause });
      }
      if (expectedSize !== null && length !== expectedSize) {
        throw new ZarrFormatError(`A ${name} chunk decodes to ${formatCountOf(length, "byte")}, not its ${expectedSize}.`);
      }
      const output = allocateTypedArray(Uint8Array, length, `A ${name} chunk`);
      let at = 0;
      for (const piece of pieces) {
        output.set(piece, at);
        at += piece.length;
      }
      return output;
    }
  };
}
function shuffleDecoder(elementSize) {
  if (!Number.isSafeInteger(elementSize) || elementSize < 1) {
    throw new ZarrFormatError("A shuffle codec needs a positive element size.");
  }
  return {
    name: "shuffle",
    allocates: true,
    inputSize: sameSize,
    decode: (bytes) => byteUnshuffle(bytes, elementSize)
  };
}
var CRC32C = {
  name: "crc32c",
  allocates: false,
  inputSize: (size) => size === null ? null : size + 4,
  decode: (bytes) => crc32cDecode(bytes)
};
var IDENTITY = { name: "bitround", allocates: false, inputSize: sameSize, decode: (bytes) => bytes };
var Unsupported = class extends Error {
  constructor(feature, message) {
    super(message);
    this.error = new ZarrUnsupportedError(feature, message);
  }
};
function unsupportedCodec(name, what) {
  return new Unsupported(`codec ${name}`, `${what} is compressed or encoded with '${name}', which this reader cannot decode.`);
}
function numcodecsDecoder(id, configuration, what) {
  const decoder = numcodecsDecoderOf(id, configuration, what);
  return decoder === null ? null : { ...decoder, codec: { id, configuration: plainConfiguration(id, configuration) } };
}
function plainConfiguration(id, configuration) {
  return id === "shuffle" ? { elementsize: configuration?.elementsize ?? 4 } : {};
}
function numcodecsDecoderOf(id, configuration, what) {
  switch (id) {
    case "gzip":
      return inflateDecoder("gzip", "gzip");
    case "zlib":
      return inflateDecoder("zlib", "deflate");
    case "blosc":
      return { name: "blosc", allocates: true, inputSize: unknownSize, decode: bloscDecode2 };
    case "zstd":
      return { name: "zstd", allocates: true, inputSize: unknownSize, decode: (bytes, expectedSize, choices = null) => zstdDecompress2(bytes, expectedSize, { choices }) };
    case "lz4":
      return { name: "lz4", allocates: true, inputSize: unknownSize, decode: numcodecsLz4Decode2 };
    case "crc32c":
      return CRC32C;
    case "shuffle":
      return shuffleDecoder(configuration?.elementsize ?? 4);
    case "bitround":
      return IDENTITY;
    case "bz2":
      return streamDecoder("bz2", bunzip2);
    case "lzma":
      return streamDecoder("lzma", unxz);
    case "lzf":
    case "snappy":
    case "zfpy":
    case "pcodec":
      throw unsupportedCodec(id, what);
    default:
      return null;
  }
}
var rebuilt = /* @__PURE__ */ new Map();
var FAMILIES = Object.freeze({ gzip: "deflate", zlib: "deflate", zstd: "zstd", lz4: "lz4", blosc: "blosc" });
async function decodeWithCodecs(input, codecs, sizes, choices = null) {
  const key = JSON.stringify(codecs);
  let decoders = rebuilt.get(key);
  if (decoders === void 0) {
    decoders = codecs.map(({ id, configuration }) => {
      const decoder = numcodecsDecoder(id, configuration, "A chunk");
      if (decoder === null) throw new ZarrUnsupportedError(`codec ${id}`, `A chunk is compressed or encoded with '${id}', which this reader cannot decode.`);
      return decoder;
    });
    rebuilt.set(key, decoders);
  }
  let bytes = input;
  for (let i2 = 0; i2 < decoders.length; i2++) bytes = await decoders[i2].decode(bytes, sizes[i2], choices);
  return bytes;
}

// assets/js/formats/hdf5/checksum.js
function fold(sum) {
  return (sum & 65535) + (sum >>> 16);
}
function fletcher32(bytes) {
  const words = bytes.length >>> 1;
  let sum1 = 0;
  let sum2 = 0;
  let index = 0;
  let remaining = words;
  while (remaining > 0) {
    let block = remaining > 360 ? 360 : remaining;
    remaining -= block;
    while (block-- > 0) {
      sum1 = sum1 + (bytes[index] << 8 | bytes[index + 1]) >>> 0;
      index += 2;
      sum2 = sum2 + sum1 >>> 0;
    }
    sum1 = fold(sum1);
    sum2 = fold(sum2);
  }
  if (bytes.length & 1) {
    sum1 = sum1 + (bytes[index] << 8) >>> 0;
    sum2 = sum2 + sum1 >>> 0;
    sum1 = fold(sum1);
    sum2 = fold(sum2);
  }
  sum1 = fold(sum1);
  sum2 = fold(sum2);
  return (sum2 << 16 | sum1) >>> 0;
}

// assets/js/formats/hdf5/errors.js
var Hdf5FormatError = class extends Error {
  /**
   * @param {string} message
   * @param {{cause?: unknown, offset?: number|null}} [options]
   */
  constructor(message, { cause, offset = null } = {}) {
    super(message, cause === void 0 ? void 0 : { cause });
    this.name = "Hdf5FormatError";
    this.offset = offset;
  }
};
var Hdf5UnsupportedError = class extends Error {
  /**
   * @param {string} feature - Short identifier, e.g. `'filter:szip'`
   * @param {string} message
   * @param {{cause?: unknown}} [options]
   */
  constructor(feature, message, { cause } = {}) {
    super(message, cause === void 0 ? void 0 : { cause });
    this.name = "Hdf5UnsupportedError";
    this.feature = feature;
  }
};

// assets/js/formats/hdf5/lzf.js
function lzfDecompress(input, outputSize) {
  const output = new Uint8Array(outputSize);
  const view = new DataView(output.buffer);
  const inputLength = input.length;
  let ip = 0;
  let op = 0;
  while (ip < inputLength) {
    const ctrl = input[ip++];
    if (ctrl < 32) {
      const length = ctrl + 1;
      if (op + length > outputSize || ip + length > inputLength) return null;
      if (length < 16) {
        for (let i2 = 0; i2 < length; i2++) output[op++] = input[ip++];
      } else {
        output.set(input.subarray(ip, ip + length), op);
        ip += length;
        op += length;
      }
    } else {
      let length = ctrl >> 5;
      if (length === 7) {
        if (ip >= inputLength) return null;
        length += input[ip++];
      }
      length += 2;
      if (ip >= inputLength) return null;
      const offset = ((ctrl & 31) << 8) + input[ip++] + 1;
      if (offset > op || op + length > outputSize) return null;
      copyMatch(output, view, op, offset, length);
      op += length;
    }
  }
  return op === outputSize ? output : null;
}

// assets/js/formats/hdf5/filters.js
var FILTER = Object.freeze({ DEFLATE: 1, SHUFFLE: 2, FLETCHER32: 3, LZF: 32e3, BLOSC: 32001, LZ4: 32004, BITSHUFFLE: 32008, ZSTD: 32015 });
var KNOWN_FILTERS = /* @__PURE__ */ new Map([
  [4, "szip"],
  [5, "nbit"],
  [6, "scaleoffset"],
  [305, "LZO"],
  [307, "bzip2"],
  [32001, "Blosc"],
  [32002, "MAFISC"],
  [32003, "Snappy"],
  [32004, "LZ4"],
  [32005, "APAX"],
  [32006, "CBF"],
  [32007, "JPEG-XR"],
  [32008, "bitshuffle"],
  [32009, "SPDP"],
  [32010, "LPC-Rice"],
  [32011, "CCSDS-123"],
  [32012, "JPEG-LS"],
  [32013, "zfp"],
  [32014, "fpzip"],
  [32015, "Zstandard"],
  [32016, "B³D"],
  [32017, "SZ"],
  [32018, "FCIDECOMP"],
  [32019, "JPEG"],
  [32020, "VBZ"],
  [32022, "FAPEC"],
  [32023, "BitGroom"],
  [32024, "Granular BitRound"],
  [32025, "SZ3"],
  [32026, "Blosc2"],
  [32028, "Delta-Rice"]
]);
var SUPPORTED = /* @__PURE__ */ new Set([FILTER.DEFLATE, FILTER.SHUFFLE, FILTER.FLETCHER32, FILTER.LZF, FILTER.BLOSC, FILTER.LZ4, FILTER.BITSHUFFLE, FILTER.ZSTD]);
function filterName(filter) {
  if (filter.id === FILTER.DEFLATE) return "deflate";
  if (filter.id === FILTER.SHUFFLE) return "shuffle";
  if (filter.id === FILTER.FLETCHER32) return "fletcher32";
  if (filter.id === FILTER.LZF) return "lzf";
  if (filter.id === FILTER.BLOSC) return "Blosc";
  if (filter.id === FILTER.LZ4) return "LZ4";
  if (filter.id === FILTER.BITSHUFFLE) return "bitshuffle";
  if (filter.id === FILTER.ZSTD) return "Zstandard";
  return KNOWN_FILTERS.get(filter.id) ?? (filter.name || `filter ${filter.id}`);
}
function unsupportedFilter(filter, label) {
  const name = filterName(filter);
  return new Hdf5UnsupportedError(
    `filter:${name}`,
    `${label} is compressed with the ${name} filter (HDF5 filter id ${filter.id}), which this reader cannot decompress.`
  );
}
var FAMILIES2 = /* @__PURE__ */ new Map([[FILTER.DEFLATE, "deflate"], [FILTER.ZSTD, "zstd"], [FILTER.LZ4, "lz4"], [FILTER.BLOSC, "blosc"], [FILTER.BITSHUFFLE, "bitshuffle"]]);
function verifyFletcher32(input, label) {
  if (input.length < 4) throw new Hdf5FormatError(`${label} is too short to hold its Fletcher-32 checksum.`);
  const data = input.subarray(0, input.length - 4);
  const end = input.length - 4;
  const stored = (input[end] | input[end + 1] << 8 | input[end + 2] << 16 | input[end + 3] << 24) >>> 0;
  const computed = fletcher32(data);
  const reversed = ((computed & 255) << 8 | computed >>> 8 & 255 | (computed >>> 16 & 255) << 24 | (computed >>> 24 & 255) << 16) >>> 0;
  if (stored !== computed && stored !== reversed) {
    throw new Hdf5FormatError(`${label} fails its Fletcher-32 checksum: the data is corrupt.`);
  }
  return data;
}
function deflateBound(n) {
  return n + Math.floor(n / 4096) + Math.floor(n / 16384) + Math.floor(n / 33554432) + 13;
}
function lzfBound(n) {
  return n + Math.ceil(n / 32);
}
function sizeBefore(filters, mask, i2, chunkBytes, label) {
  let size = chunkBytes;
  let exact = true;
  for (let j = 0; j < i2; j++) {
    if (mask & 1 << j) continue;
    switch (filters[j].id) {
      case FILTER.SHUFFLE:
        break;
      case FILTER.FLETCHER32:
        size += 4;
        break;
      case FILTER.DEFLATE:
        size = deflateBound(size);
        exact = false;
        break;
      case FILTER.LZF:
        size = lzfBound(size);
        exact = false;
        break;
      case FILTER.BITSHUFFLE:
        if ((filters[j].clientData[4] ?? 0) === 0) break;
        size = Number.MAX_SAFE_INTEGER;
        exact = false;
        break;
      case FILTER.BLOSC:
      case FILTER.LZ4:
      case FILTER.ZSTD:
        size = Number.MAX_SAFE_INTEGER;
        exact = false;
        break;
      default:
        throw unsupportedFilter(filters[j], label);
    }
  }
  return { size, exact };
}
async function unfilter(stored, filters, mask, chunkBytes, label, choices = null) {
  let bytes = stored;
  for (let i2 = filters.length - 1; i2 >= 0; i2--) {
    if (mask & 1 << i2) continue;
    const filter = filters[i2];
    const before = sizeBefore(filters, mask, i2, chunkBytes, label);
    switch (filter.id) {
      case FILTER.DEFLATE:
        try {
          bytes = await inflate(bytes, before.exact ? { format: "deflate", expectedSize: before.size, label, choices } : { format: "deflate", maxSize: before.size, label, choices });
        } catch (error) {
          if (error instanceof InflateError) throw new Hdf5FormatError(error.message, { cause: error });
          throw error;
        }
        break;
      case FILTER.SHUFFLE: {
        const typesize = filter.clientData[0] ?? 1;
        if (typesize > 1) bytes = byteUnshuffle(bytes, typesize);
        break;
      }
      case FILTER.FLETCHER32:
        bytes = verifyFletcher32(bytes, label);
        break;
      case FILTER.LZF: {
        const declared = filter.clientData[2] ?? 0;
        const size = before.exact ? before.size : declared;
        if (!(size > 0)) throw new Hdf5FormatError(`${label}: the size of its LZF-compressed data is unknown.`);
        if (size > before.size) {
          throw new Hdf5FormatError(`${label} declares ${formatCountOf(size, "byte")} of LZF-compressed data, more than the ${before.size} its chunk can hold.`);
        }
        const output = lzfDecompress(bytes, size);
        if (output === null) throw new Hdf5FormatError(`${label} could not be LZF-decompressed; the data is corrupt.`);
        bytes = output;
        break;
      }
      case FILTER.BLOSC:
      case FILTER.ZSTD:
        bytes = await decodedBy(filter, bytes, before, label, choices);
        break;
      case FILTER.LZ4:
        bytes = await hdf5Lz4Decode(bytes, before, label, choices);
        break;
      case FILTER.BITSHUFFLE:
        bytes = await hdf5BitshuffleDecode(bytes, filter, before, label);
        break;
      default:
        throw unsupportedFilter(filter, label);
    }
  }
  if (bytes.length !== chunkBytes) {
    throw new Hdf5FormatError(`${label} holds ${formatCountOf(bytes.length, "byte")} once decoded, not the ${chunkBytes} of a chunk.`);
  }
  return bytes;
}
async function decodedBy(filter, bytes, before, label, choices) {
  const name = filterName(filter);
  try {
    const output = filter.id === FILTER.BLOSC ? await bloscDecode2(bytes, before.exact ? before.size : null, choices) : await zstdDecompress2(bytes, before.exact ? before.size : null, { bound: before.size, choices });
    if (output.length > before.size) {
      throw new Hdf5FormatError(`${label} decodes with the ${name} filter to ${formatCountOf(output.length, "byte")}, more than its chunk holds.`);
    }
    return output;
  } catch (error) {
    if (error instanceof Hdf5FormatError) throw error;
    throw new Hdf5FormatError(`${label} could not be decompressed with the ${name} filter: ${error?.message ?? error}`, { cause: error });
  }
}
async function hdf5Lz4Decode(bytes, before, label, choices = null) {
  const corrupt7 = (detail) => new Hdf5FormatError(`${label} is not a valid LZ4 filter chunk: ${detail}.`);
  if (bytes.length < 12) throw corrupt7("it is shorter than its header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const total = view.getUint32(0) * 4294967296 + view.getUint32(4);
  const blockSize = view.getUint32(8);
  if (before.exact && total !== before.size || total > before.size) throw corrupt7(`it decodes to ${formatCountOf(total, "byte")}, not its chunk's ${before.size}`);
  if (blockSize === 0 && total > 0) throw corrupt7("its block size is zero");
  const segments = [];
  let at = 12;
  for (let start = 0; start < total; start += blockSize) {
    const size = Math.min(blockSize, total - start);
    if (at + 4 > bytes.length) throw corrupt7("a block is missing");
    const stored = view.getUint32(at);
    at += 4;
    if (at + stored > bytes.length) throw corrupt7("a block runs past the chunk");
    segments.push({ at, stored, start, size });
    at += stored;
  }
  try {
    return await lz4DecodeBlocks(bytes, segments, total, choices);
  } catch (error) {
    if (error instanceof Hdf5FormatError) throw error;
    throw corrupt7(error?.message ?? String(error));
  }
}
var BITSHUFFLE_COMPRESSION = /* @__PURE__ */ new Map([[0, "none"], [2, "LZ4"], [3, "zstd"]]);
async function hdf5BitshuffleDecode(bytes, filter, before, label) {
  const [, , elemSize = 0, blockElems = 0, compression = 0] = filter.clientData;
  if (!BITSHUFFLE_COMPRESSION.has(compression)) {
    throw new Hdf5UnsupportedError("filter:bitshuffle", `${label} is compressed with the bitshuffle filter's compression ${compression}, which this reader does not decode (none, LZ4 and zstd are read).`);
  }
  if (!(elemSize > 0)) throw new Hdf5FormatError(`${label}: the bitshuffle filter names no element size.`);
  let size = before.size;
  if (compression !== 0) {
    if (bytes.length < 12) throw new Hdf5FormatError(`${label} is not a valid bitshuffle chunk: it is shorter than its header.`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    size = view.getUint32(0) * 4294967296 + view.getUint32(4);
  } else if (!before.exact) {
    size = bytes.length;
  }
  if (before.exact && size !== before.size || size > before.size) {
    throw new Hdf5FormatError(`${label} is not a valid bitshuffle chunk: it decodes to ${formatCountOf(size, "byte")}, not its chunk's ${before.size}.`);
  }
  const codecs = await wasmCodecs();
  try {
    return codecs.bitshuffleChunk(bytes, size, elemSize, blockElems, compression);
  } catch (error) {
    if (!(error instanceof WasmCodecError)) throw error;
    throw new Hdf5FormatError(`${label} is not a valid bitshuffle chunk (${BITSHUFFLE_COMPRESSION.get(compression)}): ${error.code}.`, { cause: error });
  }
}

// assets/js/formats/io/decode-worker.js
function decode({ kind, description, input }, choices) {
  if (kind === "zarr") return decodeWithCodecs(input, description.codecs, description.sizes, choices);
  if (kind === "hdf5") return unfilter(input, description.filters, description.mask, description.chunkBytes, description.label, choices);
  throw new TypeError(`A decode worker cannot decode '${kind}' chunks.`);
}
function referenceOf(choices) {
  if (choices === null || choices === void 0) return null;
  let differs = false;
  const reference = {};
  for (const [key, decoder] of Object.entries(choices)) {
    reference[key] = DECODERS[familyOfKey(key)]?.[0] ?? decoder;
    differs ||= reference[key] !== decoder;
  }
  return differs ? reference : null;
}
function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i2 = 0; i2 < a.length; i2++) if (a[i2] !== b[i2]) return false;
  return true;
}
async function decodeChosen(task, choices, check, dropped) {
  const reference = referenceOf(choices);
  if (reference === null) return decode(task, choices);
  let output;
  try {
    output = await decode(task, choices);
  } catch (error) {
    const referenceBytes = await decode(task, reference);
    for (const key of Object.keys(choices)) if (choices[key] !== reference[key]) dropped.add(key);
    return referenceBytes;
  }
  if (!check) return output;
  const expected = await decode(task, reference);
  if (sameBytes(output, expected)) return output;
  for (const key of Object.keys(choices)) if (choices[key] !== reference[key]) dropped.add(key);
  return expected;
}
var contexts = /* @__PURE__ */ new Map();
function transferablesOf(value, found = /* @__PURE__ */ new Set()) {
  if (ArrayBuffer.isView(value)) {
    if (value.byteOffset === 0 && value.byteLength === value.buffer.byteLength) found.add(value.buffer);
  } else if (Array.isArray(value)) {
    for (const item of value) transferablesOf(item, found);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) transferablesOf(item, found);
  }
  return found;
}
async function run({ module, name, args, context }) {
  const data = context === null ? void 0 : contexts.get(context);
  const exported = (await import(module))[name];
  if (typeof exported !== "function") throw new TypeError(`${module} exports no function '${name}'.`);
  return exported(args, data);
}
self.addEventListener("message", async (event) => {
  const task = event.data;
  if (task.context !== void 0 && task.data !== void 0 && task.id === void 0) {
    contexts.set(task.context, task.data);
    return;
  }
  if (task.release !== void 0) {
    contexts.delete(task.release);
    return;
  }
  if (task.kind === "run") {
    try {
      const output = await run(task);
      self.postMessage({ id: task.id, output }, [...transferablesOf(output)]);
    } catch (error) {
      self.postMessage({ id: task.id, error: toWire(error) });
    }
    return;
  }
  const choices = task.choices ?? null;
  const dropped = /* @__PURE__ */ new Set();
  if (Array.isArray(task.items)) {
    const transfer = [];
    const results = await Promise.all(task.items.map(async (item, index) => {
      try {
        const output = await decodeChosen({ ...item, input: task.input.subarray(item.start, item.end) }, choices, task.check === true && index === 0, dropped);
        const own = output.buffer === task.input.buffer ? output.slice() : output;
        transfer.push(own.buffer);
        return { output: own };
      } catch (error) {
        return { error: toWire(error) };
      }
    }));
    self.postMessage({ id: task.id, results, dropped: [...dropped] }, transfer);
    return;
  }
  try {
    const output = await decodeChosen(task, choices, task.check === true, dropped);
    self.postMessage({ id: task.id, output, dropped: [...dropped] }, [output.buffer]);
  } catch (error) {
    self.postMessage({ id: task.id, error: toWire(error) });
  }
});
//# sourceMappingURL=decode-worker.799b3bcd4dc6.js.map
