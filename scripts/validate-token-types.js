#!/usr/bin/env node
// @ts-check

/**
 * Validates that `types/design-tokens.d.ts` stays in sync with token definitions in:
 * - `assets/css/tokens`
 * - `assets/css/themes`
 *
 * Usage:
 *   node cellucid/scripts/validate-token-types.js
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');

const DEFINITIONS_DIRS = [
  path.join(PROJECT_ROOT, 'assets', 'css', 'tokens'),
  path.join(PROJECT_ROOT, 'assets', 'css', 'themes'),
];

const TYPES_FILE = path.join(PROJECT_ROOT, 'types', 'design-tokens.d.ts');

const DESIGN_PREFIXES = [
  // Semantic tokens
  'color-',
  // Primitives
  'gray-',
  'cyan-',
  'red-',
  'green-',
  'blue-',
  'yellow-',
  'viewer-',
  // Scales / layout
  'space-',
  'breakpoint-',
  'sidebar-',
  'accordion-',
  'header-',
  // Typography
  'font-',
  'text-',
  'tracking-',
  'leading-',
  // Borders / shadows / stacking / effects
  'border-',
  'radius-',
  'shadow-',
  'z-',
  'opacity-',
  // Motion
  'duration-',
  'easing-',
  'transition-',
];

/**
 * @param {string} input
 * @returns {string[]}
 */
function listFilesRecursively(input) {
  if (!fs.existsSync(input)) return [];
  const stat = fs.statSync(input);
  if (stat.isFile()) return [input];
  if (!stat.isDirectory()) return [];

  /** @type {string[]} */
  const files = [];
  for (const entry of fs.readdirSync(input)) {
    const full = path.join(input, entry);
    const childStat = fs.statSync(full);
    if (childStat.isDirectory()) {
      files.push(...listFilesRecursively(full));
    } else if (childStat.isFile()) {
      files.push(full);
    }
  }
  return files;
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function isDesignTokenName(name) {
  if (name === 'white' || name === 'black' || name === 'transparent') return true;
  return DESIGN_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * @returns {Set<string>}
 */
function collectDefinedTokenNames() {
  const cssFiles = DEFINITIONS_DIRS.flatMap((dir) => listFilesRecursively(dir))
    .filter((file) => file.endsWith('.css'));

  const tokenRe = /(^|[^a-zA-Z0-9_-])(--[a-z0-9-]+)\s*:/g;
  const tokens = new Set();

  for (const file of cssFiles) {
    const text = readText(file);
    let match;
    while ((match = tokenRe.exec(text))) {
      const full = match[2];
      const name = full.startsWith('--') ? full.slice(2) : full;
      if (!isDesignTokenName(name)) continue;
      tokens.add(name);
    }
  }

  return tokens;
}

/**
 * @returns {Set<string>}
 */
function collectTypeTokenNames() {
  if (!fs.existsSync(TYPES_FILE)) return new Set();
  const text = readText(TYPES_FILE);

  const tokenNames = new Set();
  const stringLiteralRe = /'([^']+)'/g;

  let match;
  while ((match = stringLiteralRe.exec(text))) {
    const name = match[1];
    if (!isDesignTokenName(name)) continue;
    tokenNames.add(name);
  }

  return tokenNames;
}

function main() {
  const defined = collectDefinedTokenNames();
  if (defined.size === 0) {
    console.error('[validate-token-types] No CSS token definitions found.'); // eslint-disable-line no-console
    process.exit(1);
  }

  const typed = collectTypeTokenNames();
  if (typed.size === 0) {
    console.error('[validate-token-types] No token names found in types/design-tokens.d.ts.'); // eslint-disable-line no-console
    process.exit(1);
  }

  const missingInTypes = Array.from(defined).filter((name) => !typed.has(name)).sort();
  const extraInTypes = Array.from(typed).filter((name) => !defined.has(name)).sort();

  if (missingInTypes.length || extraInTypes.length) {
    console.error('[validate-token-types] Token/type mismatch:'); // eslint-disable-line no-console
    if (missingInTypes.length) {
      console.error(`- Missing in ${path.relative(PROJECT_ROOT, TYPES_FILE)} (${missingInTypes.length}):`); // eslint-disable-line no-console
      for (const name of missingInTypes) console.error(`  - ${name}`); // eslint-disable-line no-console
    }
    if (extraInTypes.length) {
      console.error(`- Extra in ${path.relative(PROJECT_ROOT, TYPES_FILE)} (${extraInTypes.length}):`); // eslint-disable-line no-console
      for (const name of extraInTypes) console.error(`  - ${name}`); // eslint-disable-line no-console
    }
    process.exit(1);
  }

  console.log(`[validate-token-types] OK (${defined.size} tokens)`); // eslint-disable-line no-console
}

main();
