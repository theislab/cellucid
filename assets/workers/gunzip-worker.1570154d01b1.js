// assets/js/formats/rds/gunzip-worker.js
var INFLATE_SLICE_BYTES = 64 * 1024;
var OUTPUT_BYTES = 1 << 20;
var stream = new DecompressionStream("gzip");
var writer = stream.writable.getWriter();
var reader = stream.readable.getReader();
var inputs = [];
var ended = false;
var wakeFeeder = null;
var credit = 0;
var wakeReader = null;
var failed = false;
function fail(error) {
  if (failed) return;
  failed = true;
  self.postMessage({ error: String(error?.message ?? error) });
}
async function feed() {
  for (; ; ) {
    while (inputs.length === 0 && !ended) await new Promise((resolve) => {
      wakeFeeder = resolve;
    });
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
    while (credit === 0) await new Promise((resolve) => {
      wakeReader = resolve;
    });
    credit--;
    const own = gathered.map((piece) => piece.byteOffset === 0 && piece.byteLength === piece.buffer.byteLength ? piece : piece.slice());
    self.postMessage({ output: own }, own.map((piece) => piece.buffer));
    gathered = [];
    bytes = 0;
  };
  for (; ; ) {
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
  if (data.input !== void 0) {
    inputs.push(data.input);
    wakeFeeder?.();
    wakeFeeder = null;
  } else if (data.end === true) {
    ended = true;
    wakeFeeder?.();
    wakeFeeder = null;
  } else if (data.credit !== void 0) {
    credit += data.credit;
    wakeReader?.();
    wakeReader = null;
  }
};
feed().catch(fail);
drain().catch(fail);
self.postMessage({ ready: true });
//# sourceMappingURL=gunzip-worker.1570154d01b1.js.map
