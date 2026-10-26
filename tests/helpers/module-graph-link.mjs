/**
 * Link every ES module below a folder, as a browser links the page's module
 * graph: each is imported, and a module that imports a name its source does
 * not export (or a file that is not there) fails before any of its graph
 * runs. That failure stops the whole app from starting, so it is reported;
 * a module that links and then fails to run outside a browser (it reaches
 * for `window`, `document`, a worker scope) is not.
 *
 * Run as a process of its own (modules may leave timers behind):
 * `node tests/helpers/module-graph-link.mjs <folder>`; it prints one JSON
 * line `{modules, linked, failures: [{module, message}]}` and exits.
 */
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function modulesBelow(folder) {
  const found = [];
  for (const name of readdirSync(folder).sort()) {
    const full = path.join(folder, name);
    if (statSync(full).isDirectory()) found.push(...modulesBelow(full));
    else if (name.endsWith('.js') || name.endsWith('.mjs')) found.push(full);
  }
  return found;
}

/** Whether an import failed while the graph was linked, not while it ran. */
function isLinkFailure(error) {
  return error?.name === 'SyntaxError' || (typeof error?.code === 'string' && error.code.startsWith('ERR_'));
}

const folder = path.resolve(process.argv[2]);
const modules = modulesBelow(folder);
const failures = [];
let linked = 0;
for (const module of modules) {
  try {
    await import(pathToFileURL(module).href);
    linked += 1;
  } catch (error) {
    if (isLinkFailure(error)) {
      failures.push({ module: path.relative(folder, module), message: String(error.message) });
    } else {
      linked += 1;
    }
  }
}
process.stdout.write(`${JSON.stringify({ modules: modules.length, linked, failures })}\n`);
process.exit(0);
