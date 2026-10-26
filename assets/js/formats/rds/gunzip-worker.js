/**
 * A gzip stream decompressed on its own thread (`stream.js`): the reader
 * thread hands over the compressed pieces as it reads them and takes the
 * decompressed bytes back, so the decompression runs beside whatever the
 * reader thread does with the bytes (parse, write) instead of before it.
 *
 * Messages in: `{input: Uint8Array}` (transferred), `{end: true}` after the
 * last input, `{credit: n}` (n more output messages may be sent). Out:
 * `{ready: true}` once, `{consumed: 1}` per input written into the
 * decompressor, `{output: Uint8Array[]}` (the decompressor's pieces as they
 * are, transferred, about `OUTPUT_BYTES` a message), `{done: true}`, or
 * `{error: message}`.
 *
 * @module formats/rds/gunzip-worker
 */

/** Input bytes handed to the decompressor per write, as `stream.js` writes them in this thread. */
const INFLATE_SLICE_BYTES = 64 * 1024;

/**
 * Decompressed bytes gathered into one message (a scheduling choice): a
 * message a megabyte costs far less than the decompression it carries,
 * whatever piece size the engine's decompressor makes (16 KB in Firefox,
 * 64 KB in Chromium, 256 KB in WebKit).
 */
const OUTPUT_BYTES = 1 << 20;

const stream = new DecompressionStream('gzip');
const writer = stream.writable.getWriter();
const reader = stream.readable.getReader();
const inputs = [];
let ended = false;
let wakeFeeder = null;
let credit = 0;
let wakeReader = null;
let failed = false;

function fail(error) {
  if (failed) return;
  failed = true;
  self.postMessage({ error: String(error?.message ?? error) });
}

async function feed() {
  for (;;) {
    while (inputs.length === 0 && !ended) await new Promise(resolve => { wakeFeeder = resolve; });
    if (inputs.length === 0) break;
    const input = inputs.shift();
    for (let offset = 0; offset < input.length; offset += INFLATE_SLICE_BYTES) {
      await writer.ready;
      await writer.write(input.subarray(offset, offset + INFLATE_SLICE_BYTES));
    }
    self.postMessage({ consumed: 1 });
  }
  await writer.close();
}

async function drain() {
  let gathered = [];
  let bytes = 0;
  const send = async () => {
    while (credit === 0) await new Promise(resolve => { wakeReader = resolve; });
    credit--;
    // A piece that is a view of a larger buffer is copied, so each goes by transfer alone.
    const own = gathered.map(piece => (piece.byteOffset === 0 && piece.byteLength === piece.buffer.byteLength ? piece : piece.slice()));
    self.postMessage({ output: own }, own.map(piece => piece.buffer));
    gathered = [];
    bytes = 0;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.length === 0) continue;
    gathered.push(value);
    bytes += value.length;
    if (bytes >= OUTPUT_BYTES) await send();
  }
  if (bytes > 0) await send();
  self.postMessage({ done: true });
}

self.onmessage = ({ data }) => {
  if (data.input !== undefined) {
    inputs.push(data.input);
    wakeFeeder?.();
    wakeFeeder = null;
  } else if (data.end === true) {
    ended = true;
    wakeFeeder?.();
    wakeFeeder = null;
  } else if (data.credit !== undefined) {
    credit += data.credit;
    wakeReader?.();
    wakeReader = null;
  }
};

feed().catch(fail);
drain().catch(fail);
self.postMessage({ ready: true });
