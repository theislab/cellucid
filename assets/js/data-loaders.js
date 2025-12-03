// Fetch helpers for loading binary positions and obs payloads (manifest + per-field data).
// Supports quantized data with transparent dequantization and gzip-compressed files.

// Check browser capabilities at startup
const HAS_DECOMPRESSION_STREAM = typeof DecompressionStream !== 'undefined';
const HAS_PAKO = typeof pako !== 'undefined';
if (!HAS_DECOMPRESSION_STREAM && !HAS_PAKO) {
  console.warn('Neither DecompressionStream nor pako available. Gzip-compressed files will not work.');
  console.warn('Use a modern browser (Chrome 80+, Firefox 113+, Safari 16.4+) or include pako library.');
}

/**
 * Convert ArrayBuffer to typed array based on dtype.
 * @param {ArrayBuffer} buffer - Raw binary data
 * @param {string} dtype - Data type ('float32', 'uint8', 'uint16', 'uint32')
 * @param {string} url - URL for error messages
 * @returns {TypedArray} Appropriate typed array
 */
function typedArrayFromBuffer(buffer, dtype, url) {
  switch (dtype) {
    case 'float32':
      return new Float32Array(buffer);
    case 'uint8':
      return new Uint8Array(buffer);
    case 'uint16':
      return new Uint16Array(buffer);
    case 'uint32':
      return new Uint32Array(buffer);
    default:
      throw new Error(`Unsupported dtype "${dtype}" for ${url}`);
  }
}

/**
 * Dequantize uint8/uint16 values back to float32.
 * This is transparent to the rest of the application.
 * 
 * @param {Uint8Array|Uint16Array} quantized - Quantized values
 * @param {number} minValue - Original minimum value
 * @param {number} maxValue - Original maximum value
 * @param {number} bits - Quantization bits (8 or 16)
 * @returns {Float32Array} Dequantized float32 values
 */
function dequantize(quantized, minValue, maxValue, bits) {
  const n = quantized.length;
  const result = new Float32Array(n);
  
  // Determine max quantized value and NaN marker
  const maxQuant = bits === 8 ? 254 : 65534;
  const nanMarker = bits === 8 ? 255 : 65535;
  const range = maxValue - minValue;
  const scale = range / maxQuant;
  
  for (let i = 0; i < n; i++) {
    const q = quantized[i];
    if (q === nanMarker) {
      result[i] = NaN;
    } else {
      result[i] = minValue + q * scale;
    }
  }
  
  return result;
}

function resolveUrl(base, relative) {
  try {
    const baseUrl = base ? new URL(base, window.location.href) : new URL(window.location.href);
    return new URL(relative, baseUrl).toString();
  } catch (_err) {
    return relative;
  }
}

async function fetchOk(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const err = new Error('Failed to load ' + url + ': ' + response.statusText);
    err.status = response.status;
    throw err;
  }
  return response;
}

/**
 * Fetch binary data, automatically decompressing gzip if URL ends with .gz
 * Uses native DecompressionStream API (modern browsers).
 * 
 * @param {string} url - URL to fetch
 * @returns {ArrayBuffer} Decompressed binary data
 */
async function fetchBinary(url) {
  const response = await fetchOk(url);
  
  // Check if this is a gzipped file by URL extension
  const isGzipped = url.endsWith('.gz');
  
  if (isGzipped && typeof DecompressionStream !== 'undefined') {
    // Use native DecompressionStream API for decompression
    try {
      const ds = new DecompressionStream('gzip');
      const decompressedStream = response.body.pipeThrough(ds);
      const decompressedResponse = new Response(decompressedStream);
      return decompressedResponse.arrayBuffer();
    } catch (e) {
      console.error('DecompressionStream failed for:', url, e);
      throw e;
    }
  } else if (isGzipped) {
    // Fallback: try to use pako if available (for older browsers)
    const compressedBuffer = await response.arrayBuffer();
    if (typeof pako !== 'undefined') {
      const decompressed = pako.inflate(new Uint8Array(compressedBuffer));
      return decompressed.buffer;
    } else {
      console.error('Gzip decompression not supported: DecompressionStream unavailable and pako not loaded');
      console.error('Either use a modern browser or include pako library, or regenerate data without compression');
      throw new Error('Gzip decompression not supported in this browser. Regenerate data with compression=None');
    }
  }
  
  // Not gzipped, return as-is
  return response.arrayBuffer();
}

/**
 * Load points binary, trying .gz version first if the URL doesn't already end in .gz
 * This handles both compressed and uncompressed data transparently.
 */
export async function loadPointsBinary(url) {
  // If URL already ends with .gz, just fetch it directly
  if (url.endsWith('.gz')) {
    const arrayBuffer = await fetchBinary(url);
    return new Float32Array(arrayBuffer);
  }
  
  // Try .gz version first
  const gzUrl = url + '.gz';
  try {
    const response = await fetch(gzUrl);
    if (response.ok) {
      console.log('Found compressed points file:', gzUrl);
      // Gzip version exists, decompress it
      if (typeof DecompressionStream !== 'undefined') {
        const ds = new DecompressionStream('gzip');
        const decompressedStream = response.body.pipeThrough(ds);
        const decompressedResponse = new Response(decompressedStream);
        const arrayBuffer = await decompressedResponse.arrayBuffer();
        return new Float32Array(arrayBuffer);
      } else if (typeof pako !== 'undefined') {
        const compressedBuffer = await response.arrayBuffer();
        const decompressed = pako.inflate(new Uint8Array(compressedBuffer));
        return new Float32Array(decompressed.buffer);
      } else {
        console.warn('DecompressionStream not available and pako not loaded, trying uncompressed file');
      }
    }
  } catch (e) {
    console.log('Compressed file not available or failed:', e.message || e);
  }
  
  // Fall back to original URL (non-gzipped)
  console.log('Loading uncompressed points file:', url);
  const arrayBuffer = await fetchBinary(url);
  return new Float32Array(arrayBuffer);
}

export async function loadObsManifest(url) {
  const response = await fetchOk(url);
  return response.json();
}

/**
 * Load obs field data with automatic dequantization for quantized fields.
 * Fully backward compatible with existing non-quantized data.
 * Handles gzip-compressed files automatically.
 * 
 * @param {string} manifestUrl - Base URL for resolving paths
 * @param {object} field - Field metadata from manifest
 * @returns {object} Loaded data with values/codes/outlierQuantiles
 */
export async function loadObsFieldData(manifestUrl, field) {
  if (!field) throw new Error('No field metadata provided for obs field fetch.');
  const outputs = { loaded: true };
  
  // Load continuous values
  if (field.valuesPath) {
    const url = resolveUrl(manifestUrl, field.valuesPath);
    const buffer = await fetchBinary(url);
    const dtype = field.valuesDtype || 'float32';
    const raw = typedArrayFromBuffer(buffer, dtype, url);
    
    // Check if quantized and needs dequantization
    if (field.quantized && (dtype === 'uint8' || dtype === 'uint16') && 
        field.minValue !== undefined && field.maxValue !== undefined) {
      const bits = field.quantizationBits || (dtype === 'uint8' ? 8 : 16);
      outputs.values = dequantize(raw, field.minValue, field.maxValue, bits);
    } else {
      // Non-quantized or already float32
      outputs.values = raw;
    }
  }
  
  // Load categorical codes
  if (field.codesPath) {
    const url = resolveUrl(manifestUrl, field.codesPath);
    const buffer = await fetchBinary(url);
    const dtype = field.codesDtype || 'uint16';
    const raw = typedArrayFromBuffer(buffer, dtype, url);
    
    // If uint8 codes, convert to uint16 for consistency with rest of app
    if (dtype === 'uint8') {
      const u16 = new Uint16Array(raw.length);
      const missingU8 = 255;
      const missingU16 = field.codesMissingValue !== undefined ? field.codesMissingValue : 65535;
      for (let i = 0; i < raw.length; i++) {
        u16[i] = raw[i] === missingU8 ? missingU16 : raw[i];
      }
      outputs.codes = u16;
    } else {
      outputs.codes = raw;
    }
  }
  
  // Load outlier quantiles
  if (field.outlierQuantilesPath) {
    const url = resolveUrl(manifestUrl, field.outlierQuantilesPath);
    const buffer = await fetchBinary(url);
    const dtype = field.outlierDtype || 'float32';
    const raw = typedArrayFromBuffer(buffer, dtype, url);
    
    // Check if quantized and needs dequantization
    if (field.outlierQuantized && (dtype === 'uint8' || dtype === 'uint16')) {
      const bits = dtype === 'uint8' ? 8 : 16;
      outputs.outlierQuantiles = dequantize(
        raw,
        field.outlierMinValue !== undefined ? field.outlierMinValue : 0,
        field.outlierMaxValue !== undefined ? field.outlierMaxValue : 1,
        bits
      );
    } else {
      outputs.outlierQuantiles = raw;
    }
  }
  
  return outputs;
}

// Var/gene expression manifest loader
export async function loadVarManifest(url) {
  const response = await fetchOk(url);
  return response.json();
}

/**
 * Load gene expression field data with automatic dequantization.
 * Handles gzip-compressed files automatically.
 * 
 * @param {string} manifestUrl - Base URL for resolving paths
 * @param {object} field - Field metadata from manifest
 * @returns {object} Loaded data with values as Float32Array
 */
export async function loadVarFieldData(manifestUrl, field) {
  if (!field) throw new Error('No field metadata provided for var field fetch.');
  const outputs = { loaded: true };
  
  if (field.valuesPath) {
    const url = resolveUrl(manifestUrl, field.valuesPath);
    const buffer = await fetchBinary(url);
    const dtype = field.valuesDtype || 'float32';
    const raw = typedArrayFromBuffer(buffer, dtype, url);
    
    // Check if quantized and needs dequantization
    if (field.quantized && (dtype === 'uint8' || dtype === 'uint16') &&
        field.minValue !== undefined && field.maxValue !== undefined) {
      const bits = field.quantizationBits || (dtype === 'uint8' ? 8 : 16);
      outputs.values = dequantize(raw, field.minValue, field.maxValue, bits);
    } else {
      outputs.values = raw;
    }
  }
  
  return outputs;
}

// Legacy loader kept for backward compatibility (single large JSON payload).
export async function loadObsJson(url) {
  const response = await fetchOk(url);
  return response.json();
}

// Connectivity manifest loader
export async function loadConnectivityManifest(url) {
  const response = await fetchOk(url);
  return response.json();
}

// Load CSR indptr array (small - n_cells + 1 elements)
export async function loadConnectivityIndptr(manifestUrl, manifest) {
  if (!manifest || !manifest.indptrPath) {
    throw new Error('No indptr path in connectivity manifest.');
  }
  const url = resolveUrl(manifestUrl, manifest.indptrPath);
  const buffer = await fetchBinary(url);
  return typedArrayFromBuffer(buffer, manifest.dtype || 'uint32', url);
}

// Load CSR indices array (larger - nnz elements)
export async function loadConnectivityIndices(manifestUrl, manifest) {
  if (!manifest || !manifest.indicesPath) {
    throw new Error('No indices path in connectivity manifest.');
  }
  const url = resolveUrl(manifestUrl, manifest.indicesPath);
  const buffer = await fetchBinary(url);
  return typedArrayFromBuffer(buffer, manifest.dtype || 'uint32', url);
}
