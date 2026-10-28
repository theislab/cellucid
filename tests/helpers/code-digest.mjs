/**
 * The digest of the code a kept format depends on, for the revision guards
 * of what this browser keeps (`tests/transcode-cache-contract.test.mjs`:
 * converted stores, `KEPT_STORE_REVISION`; `tests/kept-column-index-contract.test.mjs`:
 * gene indexes, `KEPT_INDEX_REVISION`). A guard pins the digest of its
 * modules' code to its revision, so a change to that code fails until the
 * revision is raised (what an earlier revision kept is then removed, never
 * read).
 *
 * - **Which modules**: `sourceClosure` follows every relative import
 *   (static, re-export, side-effect and dynamic `import('…')`) from the
 *   entries, so a module newly imported by a guarded one is guarded; a
 *   module listed as left out is not, nor what only it imports.
 * - **What of them**: `codeOf` prints each with esbuild, comments and layout
 *   removed and nothing else changed (no renaming, no folding: a
 *   semantics-preserving print), so a comment or a re-wrapped line changes
 *   nothing and any change to what runs changes the digest. esbuild is
 *   pinned in `package.json`; a new version that prints differently changes
 *   the digest once, and is taken as a change.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { transformSync } from 'esbuild';

/** A module's code: comments and layout removed, everything that runs kept. */
export function codeOf(source, file = 'module.js') {
  return transformSync(source, { loader: 'js', format: 'esm', minifyWhitespace: true, legalComments: 'none', sourcefile: file }).code;
}

/**
 * Every module reached from `entries` through relative imports, and those
 * guarded (reached, not left out), repository-relative and sorted.
 *
 * @param {string} root - The repository's folder
 * @param {string[]} entries
 * @param {Set<string>|Map<string, string>} leftOut
 * @returns {{guarded: string[], reached: Set<string>}}
 */
export function sourceClosure(root, entries, leftOut) {
  const seen = new Set();
  const stack = [...entries];
  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    // What a left-out module imports is left out with it.
    if (leftOut.has(file)) continue;
    const source = readFileSync(path.join(root, file), 'utf8');
    for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*'([^']+)'|(?:^|\n)\s*import\s*'([^']+)'|import\(\s*'([^']+)'\s*\)/g)) {
      const target = match[1] ?? match[2] ?? match[3];
      if (target.startsWith('.')) stack.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), target)));
    }
  }
  return { guarded: [...seen].filter(file => !leftOut.has(file)).sort(), reached: seen };
}

/**
 * The digest of `files`' code (`codeOf`), each named by its path.
 *
 * @param {string} root
 * @param {string[]} files
 * @returns {string}
 */
export function codeDigest(root, files) {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(`${file}\n`);
    hash.update(codeOf(readFileSync(path.join(root, file), 'utf8'), file));
    hash.update('\n');
  }
  return hash.digest('hex');
}
