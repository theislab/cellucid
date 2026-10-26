/**
 * A decode worker: decodes the chunks `decode-pool.js` sends it.
 *
 * A message is `{id, kind, description, input}`; the reply is `{id, output}`
 * (the decoded bytes, transferred) or `{id, error}` (the error as data). A
 * message of small chunks is `{id, items: [{kind, description, start, end}],
 * input}`, each item's bytes `input[start, end)`; the reply is `{id, results}`,
 * one `{output}` or `{error}` per item, every output transferred.
 *
 * - `'zarr'`: `description` is `{codecs, sizes}`, the bytes-to-bytes codecs
 *   of a Zarr chunk in decode order and the size each must produce
 *   (`codecs/pipeline.js`). The decoders of a codec list are rebuilt once
 *   and kept for the next chunk with the same list.
 * - `'hdf5'`: `description` is `{filters, mask, chunkBytes, label}`, the
 *   dataset's filter pipeline, the chunk's filter mask, its decoded size and
 *   what it is for messages (`hdf5/filters.js`).
 *
 * Work on decoded values (`runOnDecodeWorker`) is `{id, kind: 'run', module,
 * name, args, context}`: the reply is `{id, output}`, `output` the value the
 * module's function returned, every typed array in it transferred. A context
 * comes before the first task that names it, as `{context, data}`, and is
 * kept until `{release}` names it.
 *
 * @module formats/io/decode-worker
 */

import { decodeWithCodecs } from '../zarr/codecs/pipeline.js';
import { unfilter } from '../hdf5/filters.js';
import { errorData } from './decode-pool.js';

/** @param {{kind: string, description: Object, input: Uint8Array}} task */
function decode({ kind, description, input }) {
  if (kind === 'zarr') return decodeWithCodecs(input, description.codecs, description.sizes);
  if (kind === 'hdf5') return unfilter(input, description.filters, description.mask, description.chunkBytes, description.label);
  throw new TypeError(`A decode worker cannot decode '${kind}' chunks.`);
}

/** Contexts of work tasks, by key. */
const contexts = new Map();

/** The buffers of every typed array in `value` that spans its buffer: what goes back transferred. */
function transferablesOf(value, found = new Set()) {
  if (ArrayBuffer.isView(value)) {
    if (value.byteOffset === 0 && value.byteLength === value.buffer.byteLength) found.add(value.buffer);
  } else if (Array.isArray(value)) {
    for (const item of value) transferablesOf(item, found);
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) transferablesOf(item, found);
  }
  return found;
}

async function run({ module, name, args, context }) {
  // The context as the task arrived: a release behind it may come while the module loads.
  const data = context === null ? undefined : contexts.get(context);
  const exported = (await import(module))[name];
  if (typeof exported !== 'function') throw new TypeError(`${module} exports no function '${name}'.`);
  return exported(args, data);
}

self.addEventListener('message', async event => {
  const task = event.data;
  if (task.context !== undefined && task.data !== undefined && task.id === undefined) {
    contexts.set(task.context, task.data);
    return;
  }
  if (task.release !== undefined) {
    contexts.delete(task.release);
    return;
  }
  if (task.kind === 'run') {
    try {
      const output = await run(task);
      self.postMessage({ id: task.id, output }, [...transferablesOf(output)]);
    } catch (error) {
      self.postMessage({ id: task.id, error: errorData(error) });
    }
    return;
  }
  if (Array.isArray(task.items)) {
    const transfer = [];
    const results = await Promise.all(task.items.map(async item => {
      try {
        const output = await decode({ ...item, input: task.input.subarray(item.start, item.end) });
        // A view of the shared input cannot go back alone: it is copied out.
        const own = output.buffer === task.input.buffer ? output.slice() : output;
        transfer.push(own.buffer);
        return { output: own };
      } catch (error) {
        return { error: errorData(error) };
      }
    }));
    self.postMessage({ id: task.id, results }, transfer);
    return;
  }
  try {
    const output = await decode(task);
    // A view of a buffer this worker owns (it was made here, or is the input
    // the reader transferred): the whole buffer goes back with it.
    self.postMessage({ id: task.id, output }, [output.buffer]);
  } catch (error) {
    self.postMessage({ id: task.id, error: errorData(error) });
  }
});
