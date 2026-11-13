/**
 * A percent is written one way: the sign attached ("50%", never "50 %"), by
 * `formatPercent` or `formatShare` (`utils/format-units.js`, beside the count
 * nouns). Hand-built `${n}%` and `${n} %` strings put both forms side by side
 * ("100 % cells · genes 6 %" over "Loading fields… 40%", "Hid outliers of x
 * above 95 %" beside "outlier threshold 95%"), each rounding its own way
 * ("5.0%", "5%", "5.5%" for one share); the one function rounds one way.
 * The Python and R packages write a share of the cells by the same rule
 * (`history.py`, `history.R`: the methods paragraph).
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { formatPercent, formatShare, shareText } from '../assets/js/utils/format-units.js';

const ROOT = fileURLToPath(new URL('../assets/js/', import.meta.url));
const FORMATTER = path.join(ROOT, 'utils', 'format-units.js');

async function sources(dir = ROOT) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Vendored code, and the developer benchmark (its words are for the console).
      if (entry.name !== 'vendor' && full !== path.join(ROOT, 'dev')) out.push(...await sources(full));
    } else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out.sort();
}

/**
 * The string and template literals of `code`, comments left out: `{kind, text, at, afterInterpolation}`,
 * one per quoted string and one per run of template text (a run after `${…}` says so).
 */
function literalsOf(code) {
  const out = [];
  let i = 0;
  let lastSignificant = '';
  const regexMayStart = () => lastSignificant === '' || /[(,=:[!&|?{};+\-*%<>~^]$/.test(lastSignificant)
    || /\b(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/.test(lastSignificant);
  function scanTemplate() {
    i++;
    let start = i;
    let afterInterpolation = false;
    while (i < code.length && code[i] !== '`') {
      if (code[i] === '\\') { i += 2; continue; }
      if (code[i] === '$' && code[i + 1] === '{') {
        out.push({ kind: 'template', text: code.slice(start, i), at: start, afterInterpolation });
        i += 2;
        scanCode(true);
        i++;
        start = i;
        afterInterpolation = true;
        continue;
      }
      i++;
    }
    out.push({ kind: 'template', text: code.slice(start, i), at: start, afterInterpolation });
    i++;
    lastSignificant = 'x';
  }
  function scanCode(inInterpolation) {
    let depth = 0;
    while (i < code.length) {
      const ch = code[i];
      if (ch === '/' && code[i + 1] === '/') { while (i < code.length && code[i] !== '\n') i++; continue; }
      if (ch === '/' && code[i + 1] === '*') { const end = code.indexOf('*/', i + 2); i = end < 0 ? code.length : end + 2; continue; }
      if (ch === "'" || ch === '"') {
        const start = i;
        for (i++; i < code.length && code[i] !== ch && code[i] !== '\n'; i++) if (code[i] === '\\') i++;
        out.push({ kind: 'string', text: code.slice(start + 1, i), at: start + 1, afterInterpolation: false });
        i++;
        lastSignificant = 'x';
        continue;
      }
      if (ch === '`') { scanTemplate(); continue; }
      if (ch === '/' && regexMayStart()) {
        let inClass = false;
        for (i++; i < code.length && code[i] !== '\n'; i++) {
          if (code[i] === '\\') { i++; continue; }
          if (code[i] === '[') inClass = true;
          else if (code[i] === ']') inClass = false;
          else if (code[i] === '/' && !inClass) break;
        }
        i++;
        lastSignificant = 'x';
        continue;
      }
      if (ch === '{') depth++;
      if (ch === '}') {
        if (inInterpolation && depth === 0) return;
        depth--;
      }
      if (!/\s/.test(ch)) {
        const word = /[\w$]/.test(ch) ? code.slice(i).match(/^[\w$]+/)[0] : ch;
        lastSignificant = /[)\]}]/.test(ch) ? 'x' : word;
        i += word.length;
        continue;
      }
      i++;
    }
  }
  scanCode(false);
  return out;
}

/** CSS a script writes (a width, a position, a gradient stop): its percent is no text a person reads. */
const CSS_LINE = /\.style\.|\bstyle\s*=|setProperty\(|setVariable\(|\b(?:width|height|left|right|top|bottom|offset|inset|transform|translate[XY]?|max-width)\b\s*[:=(]|translate[XY]?\(|stop-color|\bdvh\b|\w(?:Width|Height|Left|Top)\s*=(?!=)/;

function lineOf(code, at) {
  const start = code.lastIndexOf('\n', at - 1) + 1;
  const end = code.indexOf('\n', at);
  return code.slice(start, end < 0 ? code.length : end);
}

test('formatPercent writes the sign attached; formatShare a share whole from 10, two figures below, never 100 short or 0 above none', () => {
  assert.equal(formatPercent(60), '60%');
  assert.equal(formatPercent(12.345, 1), '12.3%');
  assert.equal(formatPercent(2.5, { figures: 6 }), '2.5%');
  assert.equal(formatPercent(0.5671, { figures: 3 }), '0.567%');
  assert.throws(() => formatPercent(Number.NaN), /finite/);
  assert.throws(() => formatPercent(5, 7), /digits/);
  assert.equal(formatShare(1, 4), '25%');
  assert.equal(formatShare(1_100, 20_000), '5.5%');
  assert.equal(formatShare(19_999, 20_000), '99%');
  assert.equal(formatShare(19_900, 20_000), '99%');
  assert.equal(formatShare(3_769, 2_282_447), '0.17%');
  assert.equal(formatShare(0, 5), '0%');
  assert.equal(formatShare(5, 5), '100%');
  assert.equal(formatShare(5, 0), '100%');
  assert.equal(shareText(22_824, 2_282_447), '1');
  assert.equal(shareText(31_539, 200_000), '16');
});

test('no text writes a number and then " %": the sign is attached, as in "50%"', async () => {
  const offenders = [];
  for (const file of await sources()) {
    const code = await readFile(file, 'utf8');
    for (const literal of literalsOf(code)) {
      // "50 %", "${n} %": a digit, or the end of an interpolation, then a space and the sign.
      const spaced = /\d %(?![\d=])/.test(literal.text) || (literal.afterInterpolation && /^ %(?![\d=])/.test(literal.text));
      if (spaced) offenders.push(`${path.relative(ROOT, file)}:${code.slice(0, literal.at).split('\n').length}: ${literal.text.slice(0, 80)}`);
    }
  }
  const page = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  for (const [text] of page.replace(/<!--[\s\S]*?-->/g, ' ').matchAll(/\d %(?![\d=])/g)) offenders.push(`index.html: ${text}`);
  assert.deepEqual(offenders, []);
});

test('no text builds its own percent: `${n}%` and n + "%" are formatPercent or formatShare', async () => {
  const offenders = [];
  for (const file of await sources()) {
    if (file === FORMATTER) continue;
    const code = await readFile(file, 'utf8');
    for (const literal of literalsOf(code)) {
      const line = lineOf(code, literal.at);
      if (CSS_LINE.test(line)) continue;
      // An interpolation followed by the sign (`${x}%`), or a string that is the sign alone ('%'),
      // added to a number ("n + '%'").
      const built = (literal.afterInterpolation && literal.text.startsWith('%') && !literal.text.startsWith('%{'))
        || (literal.kind === 'string' && literal.text === '%' && /\+\s*['"]%['"]|['"]%['"]\s*\+/.test(line));
      if (built) offenders.push(`${path.relative(ROOT, file)}:${code.slice(0, literal.at).split('\n').length}: ${line.trim().slice(0, 100)}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the check sees a spaced and a hand-built percent, and leaves CSS and Plotly formats alone', () => {
  const literals = literalsOf("const a = `${n} % of cells`; const b = `${n}%`; el.style.width = `${w}%`; const t = '%{y:.1f}%'; const c = x + '%'; // `${z} %`\n");
  assert.deepEqual(literals.map(({ text, afterInterpolation }) => [text, afterInterpolation]), [
    ['', false], [' % of cells', true], ['', false], ['%', true], ['', false], ['%', true], ['%{y:.1f}%', false], ['%', false],
  ]);
});
