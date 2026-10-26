// assets/js/app/analysis/plots/point-layout.js
function plotlyPseudoRandom() {
  let state = 2e9;
  const next = () => {
    const previous = state;
    state = (69069 * state + 1) % 4294967296;
    return Math.abs(state - previous) < 429496729 ? next() : state / 4294967296;
  };
  return next;
}
function layoutPoints(input) {
  const { vals, min, max, q1, q3, lf, uf, pos, jitter, pointpos, bPos, bdPos, mode, drawsBefore } = input;
  const count = vals.length;
  const span = Math.max((max - min) / 10, q3 - q1);
  const eps = 1e-9 * span;
  const scale = 0.01 * span;
  const spread = new Float64Array(count);
  let largest = 0;
  let factor = 0;
  if (jitter) {
    if (span === 0) {
      largest = 1;
      spread.fill(1);
    } else {
      for (let i = 0; i < count; i++) {
        const d = Math.max(0, i - 5);
        let low = vals[d];
        const g = Math.min(count - 1, i + 5);
        let high = vals[g];
        if (mode !== "all") {
          if (vals[i] < lf) high = Math.min(high, lf);
          else low = Math.max(low, uf);
        }
        let m = Math.sqrt(scale * (g - d) / (high - low + eps)) || 0;
        m = Math.max(0, Math.min(1, Math.abs(m)));
        spread[i] = m;
        largest = Math.max(m, largest);
      }
    }
    factor = 2 * jitter / (largest || 1);
  }
  const random = plotlyPseudoRandom();
  if (jitter) for (let i = 0; i < drawsBefore; i++) random();
  const positions = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const offset = jitter ? factor * spread[i] * (random() - 0.5) : 0;
    positions[i] = pos + bPos + bdPos * (pointpos + offset);
  }
  return positions;
}
function axisToPixels({ type, m, b }) {
  const round2 = (v) => Math.round(v * 100) / 100;
  if (type === "log") {
    return (v) => v > 0 ? round2(b + m * (Math.log(v) / Math.LN10)) : NaN;
  }
  if (type === "linear" || type === "category" || type === "-") {
    return (v) => Number.isFinite(v) ? round2(b + m * v) : NaN;
  }
  throw new RangeError(`Points cannot be laid out on a ${type} axis`);
}

// assets/js/app/analysis/plots/point-raster-worker.js
var SUBPIXEL = 8;
var SAMPLES = 8;
function discMasks(radius) {
  const reach = Math.ceil(radius) + 1;
  const side = 2 * reach + 1;
  const masks = [];
  const r2 = radius * radius;
  for (let sy = 0; sy < SUBPIXEL; sy++) {
    for (let sx = 0; sx < SUBPIXEL; sx++) {
      const cx = (sx + 0.5) / SUBPIXEL;
      const cy = (sy + 0.5) / SUBPIXEL;
      const mask = new Float32Array(side * side);
      for (let py = 0; py < side; py++) {
        for (let px = 0; px < side; px++) {
          let inside = 0;
          for (let a = 0; a < SAMPLES; a++) {
            const dy = py - reach + (a + 0.5) / SAMPLES - cy;
            for (let b = 0; b < SAMPLES; b++) {
              const dx = px - reach + (b + 0.5) / SAMPLES - cx;
              if (dx * dx + dy * dy <= r2) inside++;
            }
          }
          mask[py * side + px] = inside / (SAMPLES * SAMPLES);
        }
      }
      masks.push(mask);
    }
  }
  return { masks, reach, side };
}
function rasterizePoints({ xs, ys, width, height, scale, radius, rgb, alpha }) {
  const w = Math.max(1, Math.ceil(width * scale));
  const h = Math.max(1, Math.ceil(height * scale));
  const transmit = new Float32Array(w * h).fill(1);
  if (radius > 0 && alpha > 0) {
    const { masks, reach, side } = discMasks(radius * scale);
    const inner = masks.map((mask) => {
      const offsets = [];
      const factors = [];
      for (let py = 0; py < side; py++) {
        for (let px = 0; px < side; px++) {
          const coverage = mask[py * side + px];
          if (coverage > 0) {
            offsets.push(py * w + px);
            factors.push(1 - alpha * coverage);
          }
        }
      }
      return { offsets: Int32Array.from(offsets), factors: Float32Array.from(factors) };
    });
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i] * scale;
      const y = ys[i] * scale;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const ix = Math.floor(x);
      const iy = Math.floor(y);
      const cell = Math.min(SUBPIXEL - 1, Math.floor((y - iy) * SUBPIXEL)) * SUBPIXEL + Math.min(SUBPIXEL - 1, Math.floor((x - ix) * SUBPIXEL));
      const top = iy - reach;
      const left = ix - reach;
      if (left >= 0 && top >= 0 && left + side <= w && top + side <= h) {
        const { offsets, factors } = inner[cell];
        const origin = top * w + left;
        for (let k = 0; k < offsets.length; k++) transmit[origin + offsets[k]] *= factors[k];
        continue;
      }
      const mask = masks[cell];
      const y0 = Math.max(0, top);
      const y1 = Math.min(h, top + side);
      const x0 = Math.max(0, left);
      const x1 = Math.min(w, left + side);
      for (let py = y0; py < y1; py++) {
        const maskRow = (py - top) * side - left;
        const row = py * w;
        for (let px = x0; px < x1; px++) {
          const coverage = mask[maskRow + px];
          if (coverage > 0) transmit[row + px] *= Math.fround(1 - alpha * coverage);
        }
      }
    }
  }
  const pixels = new Uint8ClampedArray(w * h * 4);
  const [red, green, blue] = rgb;
  for (let p = 0, q = 0; p < transmit.length; p++, q += 4) {
    const a = 1 - transmit[p];
    if (a <= 0) continue;
    pixels[q] = red;
    pixels[q + 1] = green;
    pixels[q + 2] = blue;
    pixels[q + 3] = Math.round(a * 255);
  }
  return { width: w, height: h, pixels };
}
function rasterizeColoredPoints({ xs, ys, colorIndex, palette, width, height, scale, radius }) {
  const w = Math.max(1, Math.ceil(width * scale));
  const h = Math.max(1, Math.ceil(height * scale));
  const red = new Float32Array(w * h);
  const green = new Float32Array(w * h);
  const blue = new Float32Array(w * h);
  const transmit = new Float32Array(w * h).fill(1);
  if (radius > 0) {
    const { masks, reach, side } = discMasks(radius * scale);
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i] * scale;
      const y = ys[i] * scale;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const [r, g, b, alpha] = palette[colorIndex[i]];
      if (!(alpha > 0)) continue;
      const ix = Math.floor(x);
      const iy = Math.floor(y);
      const mask = masks[Math.min(SUBPIXEL - 1, Math.floor((y - iy) * SUBPIXEL)) * SUBPIXEL + Math.min(SUBPIXEL - 1, Math.floor((x - ix) * SUBPIXEL))];
      const top = iy - reach;
      const left = ix - reach;
      const y0 = Math.max(0, top);
      const y1 = Math.min(h, top + side);
      const x0 = Math.max(0, left);
      const x1 = Math.min(w, left + side);
      for (let py = y0; py < y1; py++) {
        const maskRow = (py - top) * side - left;
        const row = py * w;
        for (let px = x0; px < x1; px++) {
          const coverage = mask[maskRow + px];
          if (!(coverage > 0)) continue;
          const a = alpha * coverage;
          const keep = 1 - a;
          const at = row + px;
          red[at] = red[at] * keep + r * a;
          green[at] = green[at] * keep + g * a;
          blue[at] = blue[at] * keep + b * a;
          transmit[at] *= keep;
        }
      }
    }
  }
  const pixels = new Uint8ClampedArray(w * h * 4);
  for (let p = 0, q = 0; p < transmit.length; p++, q += 4) {
    const a = 1 - transmit[p];
    if (a <= 0) continue;
    pixels[q] = Math.round(red[p] / a);
    pixels[q + 1] = Math.round(green[p] / a);
    pixels[q + 2] = Math.round(blue[p] / a);
    pixels[q + 3] = Math.round(a * 255);
  }
  return { width: w, height: h, pixels };
}
if (typeof self !== "undefined" && typeof self.postMessage === "function" && typeof window === "undefined") {
  self.onmessage = async ({ data }) => {
    const { id } = data;
    try {
      let positions = null;
      let image;
      if (data.kind === "scatter") {
        image = rasterizeColoredPoints(data);
      } else {
        const { vals, layout, xAxis, yAxis, horizontal } = data;
        positions = layoutPoints({ ...layout, vals });
        const toX = axisToPixels(xAxis);
        const toY = axisToPixels(yAxis);
        const xs = new Float32Array(vals.length);
        const ys = new Float32Array(vals.length);
        for (let i = 0; i < vals.length; i++) {
          xs[i] = toX(horizontal ? vals[i] : positions[i]);
          ys[i] = toY(horizontal ? positions[i] : vals[i]);
        }
        image = rasterizePoints({ ...data, xs, ys });
      }
      const { width, height, pixels } = image;
      const canvas = new OffscreenCanvas(width, height);
      canvas.getContext("2d").putImageData(new ImageData(pixels, width, height), 0, 0);
      const blob = await canvas.convertToBlob({ type: "image/png" });
      self.postMessage({ id, blob, positions }, positions === null ? [] : [positions.buffer]);
    } catch (error) {
      self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    }
  };
}
export {
  rasterizeColoredPoints,
  rasterizePoints
};
//# sourceMappingURL=point-raster-worker.70368d8ed712.js.map
