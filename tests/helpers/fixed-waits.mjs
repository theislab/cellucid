/**
 * Find the fixed waits in browser-spec source.
 *
 * A fixed wait is a pause of a set length whose end proves nothing about the
 * page: `page.waitForTimeout(ms)`, or a promise that a timer resolves
 * (`new Promise(resolve => setTimeout(resolve, ms))`, and a timer callback
 * that resolves the promise it sits in). A pause that covered some work on a
 * developer machine does not on a loaded runner, so a spec that sleeps where
 * it should wait for the product's state passes or fails with the host's
 * speed (`tests/browser-spec-fixed-waits-contract.test.mjs` holds the specs
 * to that).
 *
 * Not fixed waits, so not reported:
 * - a timer of no delay (`setTimeout(resolve, 0)`, `setTimeout(resolve)`):
 *   a turn of the event loop, an ordering step rather than a length of time;
 * - a timer whose callback does not resolve the promise around it (one that
 *   rejects is a deadline that fails the wait; one that runs the page's own
 *   code is input);
 * - `test.setTimeout(ms)`, Playwright's test budget;
 * - a page's `setTimeout` replaced by an instrumented one.
 *
 * The scan is lexical: it reads code, comment lines excepted, and the page
 * code specs carry in template literals, which runs in the page just the same.
 *
 * @module tests/helpers/fixed-waits
 */

const WAIT_FOR_TIMEOUT = /\.waitForTimeout\s*\(/g;
// `setTimeout(` called as a function: not `test.setTimeout(`, nor a
// replacement assigned to `window.setTimeout`. A call through the global
// object (`window.setTimeout(`) is still one.
const SET_TIMEOUT_CALL = /(?<![\w$])(?:(?:window|globalThis|self)\s*\.\s*)?setTimeout\s*\(/g;
const NEW_PROMISE = /\bnew\s+Promise\s*\(/g;
// The executor's first parameter, the resolver: `resolve => …`,
// `(resolve, reject) => …`, `async resolve => …`, `function (resolve) …`.
const EXECUTOR_RESOLVER =
  /^\s*(?:async\s+)?(?:\(\s*([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)\s*=>|function\s*[\w$]*\s*\(\s*([A-Za-z_$][\w$]*))/;
const ZERO_DELAY = /^(?:0+|0x0+|0n)?$/;

/**
 * The index just past the parenthesis that closes the one opened at `open`,
 * or -1. Quoted strings are skipped and a backslash escapes the next
 * character (a regular expression's `\(`); template literals are read as
 * code, since the specs' page code lives in them.
 */
function closingParenthesis(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '\'' || character === '"') {
      for (index += 1; index < text.length && text[index] !== character; index += 1) {
        if (text[index] === '\\') index += 1;
        if (text[index] === '\n') break;
      }
      continue;
    }
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

/** The top-level comma-separated arguments between `open` and `close`. */
function splitArguments(text, open, close) {
  const parts = [];
  let depth = 0;
  let start = open + 1;
  for (let index = open + 1; index < close - 1; index += 1) {
    const character = text[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '\'' || character === '"') {
      for (index += 1; index < close && text[index] !== character; index += 1) {
        if (text[index] === '\\') index += 1;
      }
      continue;
    }
    if ('([{'.includes(character)) depth += 1;
    else if (')]}'.includes(character)) depth -= 1;
    else if (character === ',' && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start, close - 1));
  return parts.map(part => part.trim()).filter(part => part !== '');
}

/** Comment lines blanked to spaces, so offsets and line numbers stay. */
function withoutCommentLines(source) {
  let inBlock = false;
  return source.split('\n').map(line => {
    const trimmed = line.trimStart();
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false;
      return ' '.repeat(line.length);
    }
    if (trimmed.startsWith('/*')) {
      inBlock = !trimmed.includes('*/');
      return ' '.repeat(line.length);
    }
    return trimmed.startsWith('//') ? ' '.repeat(line.length) : line;
  }).join('\n');
}

function lineOf(text, index) {
  let line = 1;
  for (let at = text.indexOf('\n'); at !== -1 && at < index; at = text.indexOf('\n', at + 1)) {
    line += 1;
  }
  return line;
}

/**
 * Every fixed wait in one file's source.
 *
 * @param {string} source
 * @returns {Array<{line: number, source: string, form: 'waitForTimeout'|'timer-resolved promise'}>}
 *   `source` is the trimmed text of the line the wait starts on.
 */
export function findFixedWaits(source) {
  const text = withoutCommentLines(source);
  const lines = source.split('\n');
  const found = [];
  const record = (index, form) => {
    const line = lineOf(text, index);
    found.push({ line, source: lines[line - 1].trim(), form });
  };

  for (const match of text.matchAll(WAIT_FOR_TIMEOUT)) {
    record(match.index, 'waitForTimeout');
  }

  const promises = [];
  for (const match of text.matchAll(NEW_PROMISE)) {
    const open = match.index + match[0].length - 1;
    const close = closingParenthesis(text, open);
    if (close === -1) continue;
    const resolver = EXECUTOR_RESOLVER.exec(text.slice(open + 1, close));
    const name = resolver?.[1] ?? resolver?.[2] ?? resolver?.[3];
    if (name !== undefined) promises.push({ open, close, name });
  }

  for (const match of text.matchAll(SET_TIMEOUT_CALL)) {
    const open = match.index + match[0].length - 1;
    const close = closingParenthesis(text, open);
    if (close === -1) continue;
    const [callback = '', delay = ''] = splitArguments(text, open, close);
    if (ZERO_DELAY.test(delay)) continue;
    // The innermost promise this timer sits in.
    const around = promises
      .filter(promise => promise.open < match.index && match.index < promise.close)
      .sort((left, right) => right.open - left.open)[0];
    if (around === undefined) continue;
    if (!new RegExp(`(?<![\\w$.])${around.name.replace(/\$/g, '\\$')}(?![\\w$])`).test(callback)) continue;
    record(match.index, 'timer-resolved promise');
  }

  return found.sort((left, right) => left.line - right.line);
}
