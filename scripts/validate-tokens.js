#!/usr/bin/env node
// @ts-check

/**
 * Validates that design-token-looking `var(--...)` references resolve to a
 * custom property defined in `assets/css/tokens` or `assets/css/themes`.
 *
 * Usage:
 *   node cellucid/scripts/validate-tokens.js
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');

const DEFINITIONS_DIRS = [
  path.join(PROJECT_ROOT, 'assets', 'css', 'tokens'),
  path.join(PROJECT_ROOT, 'assets', 'css', 'themes'),
];

const SCAN_DIRS = [
  path.join(PROJECT_ROOT, 'assets'),
  path.join(PROJECT_ROOT, 'index.html'),
];

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

const ALLOWED_NON_TOKEN_VARS = new Set([
  // Dynamic vars driven by JS (StyleManager).
  '--z-layer',
  '--pos-x',
  '--pos-y',
  '--pos-width',
  '--pos-height',
]);

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
 * @param {string} token
 * @returns {boolean}
 */
function shouldValidate(token) {
  if (ALLOWED_NON_TOKEN_VARS.has(token)) return false;
  if (!token.startsWith('--')) return false;
  const name = token.slice(2);
  return DESIGN_PREFIXES.some((prefix) => name.startsWith(prefix)) || name === 'white' || name === 'black' || name === 'transparent';
}

/** @returns {Set<string>} */
function collectDefinedTokens() {
  const tokens = new Set();
  const definitionFiles = DEFINITIONS_DIRS.flatMap((dir) => listFilesRecursively(dir))
    .filter((file) => file.endsWith('.css'));

  const defRe = /(^|[^a-zA-Z0-9_-])(--[a-z0-9-]+)\s*:/g;

  for (const file of definitionFiles) {
    const text = readText(file);
    let match;
    while ((match = defRe.exec(text))) {
      tokens.add(match[2]);
    }
  }
  return tokens;
}

/**
 * @param {string} filePath
 * @param {Set<string>} defined
 * @returns {Array<{ file: string; token: string }>}
 */
function validateFile(filePath, defined) {
  const text = readText(filePath);
  /** @type {Array<{ file: string; token: string }>} */
  const errors = [];

  const varRe = /var\(\s*(--[a-z0-9-]+)\b/g;
  let match;
  while ((match = varRe.exec(text))) {
    const token = match[1];
    if (!shouldValidate(token)) continue;
    if (!defined.has(token)) errors.push({ file: filePath, token });
  }
  return errors;
}

function main() {
  const defined = collectDefinedTokens();
  if (defined.size === 0) {
    console.error('[validate-tokens] No tokens found. Check the definitions directories.'); // eslint-disable-line no-console
    process.exit(1);
  }

  const scanFiles = SCAN_DIRS.flatMap((p) => listFilesRecursively(p))
    .filter((file) => file.endsWith('.css') || file.endsWith('.js') || file.endsWith('.html'));

  /** @type {Array<{ file: string; token: string }>} */
  const errors = [];
  for (const file of scanFiles) {
    errors.push(...validateFile(file, defined));
  }

  if (errors.length > 0) {
    console.error('[validate-tokens] Unknown design token references found:'); // eslint-disable-line no-console
    for (const { file, token } of errors) {
      console.error(`- ${path.relative(PROJECT_ROOT, file)}: ${token}`); // eslint-disable-line no-console
    }
    process.exit(1);
  }

  console.log(`[validate-tokens] OK (${defined.size} tokens, ${scanFiles.length} files scanned)`); // eslint-disable-line no-console
}

main();
