/**
 * The chat's Markdown export runs nothing in a renderer that does not
 * sanitise. `markdownSafe` does not guess where CommonMark puts code: a guess
 * (a backtick run to any backtick run, fences as a toggle) leaves what it
 * took for code unescaped, and every misguess is live HTML (`` `<img onerror>`` ``
 * with an unequal closing run, a code span opened on an earlier line, fences
 * out of phase, a fence inside a list that the list's end closes, a fence left
 * open into the next reply); link reference definitions (`[a]: javascript:…`)
 * and images are looked at too. The structure is the chat's own
 * (`markdown.js`), written back in a form CommonMark reads one way.
 *
 * The invariant checked here is what makes any CommonMark renderer safe:
 * outside a fenced block of the export's own form, every character that can
 * start markup (`<`, `[`, `!`, `~`, a backtick) is escaped, or is the fence
 * of a code span that no run inside it can close, or opens a link to an
 * http(s) address. Rendered with markdown-it 3.0 (CommonMark, HTML on, link
 * validation off), generated texts yield no tag but p, code, pre, em, strong,
 * br, blockquote, lists, headings, hr and http(s) links.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { markdownInlineSafe, markdownSafe } from '../assets/js/app/agent/chat/export.js';

const FENCE_LINE = /^(`{3,})([\w+#.-]*)$/;
const LINK = /^\[(?:[^\\[\]`<!~]|\\.)*\]\(https?:\/\/[^\s()<>\\`]+\)/;

/** Where `line` (outside a fence) leaves markup a renderer would read, or null. */
function activeMarkupIn(line) {
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '`') {
      let n = 1;
      while (line[i + n] === '`') n++;
      // The span closes at the next run of exactly n backticks.
      const rest = line.slice(i + n);
      const close = [...rest.matchAll(/`+/g)].find(run => run[0].length === n);
      if (close === undefined) return `an unpaired backtick run at ${i}`;
      i += n + close.index + n - 1;
      continue;
    }
    if (ch === '[') {
      if (line[i - 1] === '!' && line[i - 2] !== '\\') return `an image at ${i}`;
      const link = LINK.exec(line.slice(i));
      if (link === null) return `a bracket that is not an http(s) link at ${i}`;
      i += link[0].length - 1;
      continue;
    }
    if (ch === '<' || ch === '~') return `${ch} at ${i}`;
    if (ch === '!' && line[i + 1] === '[') return `an image at ${i}`;
  }
  return null;
}

/** The export's text as fences and lines: null when everything outside its fences is inert. */
function activeMarkup(text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const fence = FENCE_LINE.exec(lines[i]);
    if (fence !== null) {
      const closing = lines.indexOf(fence[1], i + 1);
      if (closing === -1) return `a fence left open at line ${i}`;
      for (const code of lines.slice(i + 1, closing)) {
        if (new RegExp(`^ {0,3}\`{${fence[1].length},}\\s*$`).test(code)) return `a line of code that closes its fence at line ${i}`;
      }
      i = closing;
      continue;
    }
    const found = activeMarkupIn(lines[i]);
    if (found !== null) return `line ${i} (${JSON.stringify(lines[i])}): ${found}`;
  }
  return null;
}

const HOSTILE = [
  ['an unequal closing run', '`<img src=x onerror=alert(1)>``'],
  ['a code span opened on the line before', 'a ` b\n`<img src=x onerror=alert(1)>`'],
  ['fences out of phase', '```\n~~~\n```\n<img src=x onerror=alert(1)>\n```'],
  ['a fence inside a list item, ended by the list', '- a\n\n  ```\n<img src=x onerror=alert(1)>\n```'],
  ['a fence left open', '```\n<b>open</b>'],
  ['a carriage return ending a line', '```\nfoo\r```\r<img src=x onerror=alert(1)>\n```'],
  ['a reference definition', '[click][a]\n\n[a]: javascript:alert(1)'],
  ['a collapsed reference', '[click]\n\n[click]: javascript:alert(1)'],
  ['an image (loads when the file is viewed)', '![x](https://evil.example/?q=1)'],
  ['an autolink', '<javascript:alert(1)>'],
  ['an escape before a backtick', '\\`<img src=x onerror=alert(1)>`'],
  ['a tilde fence indented', '  ~~~\n~~~\n<img src=x onerror=alert(1)>'],
  ['a script link', '[go](javascript:alert(1))'],
  ['a footnote', 'see[^1]\n\n[^1]: javascript:alert(1)'],
];

test('every known way past the old escaping is inert now, block and inline', () => {
  for (const [why, text] of HOSTILE) {
    assert.equal(activeMarkup(markdownSafe(text)), null, `${why}: ${JSON.stringify(markdownSafe(text))}`);
    assert.equal(activeMarkup(markdownInlineSafe(text)), null, `${why} (inline)`);
    assert.doesNotMatch(markdownInlineSafe(text), /\n/, `${why}: inline text stays on its line`);
  }
});

test('what the chat draws is kept: code, fenced code, emphasis and http(s) links', () => {
  assert.equal(markdownSafe('Use `x < 5` and **bold** *it* [docs](https://docs.cellucid.com/a_(b))'),
    'Use `x < 5` and **bold** *it* [docs](https://docs.cellucid.com/a_%28b))'); // as the chat: the link ends at its first )
  // Fenced code is written as it is, at the margin, with a fence longer than any run in it, always closed.
  assert.equal(markdownSafe("1. step\n   ```python\n   a[0] < b\n   s = '```'\n   ```"),
    "1. step\n````python\na[0] < b\ns = '```'\n````");
  assert.equal(markdownSafe('```\n<also kept>\n```'), '```\n<also kept>\n```');
  // A language that is not a plain name is left out.
  assert.equal(markdownSafe('```js onload=x\ncode\n```'), '```\ncode\n```');
  // Every other character that could start markup reads as itself.
  assert.equal(markdownSafe('a<b [c] ~d~ !e \\f'), 'a\\<b \\[c] \\~d\\~ \\!e \\\\f');
  // A name with double underscores inside it is written as it is, never as bold: the chat draws it as text.
  assert.equal(markdownSafe('obs snake__case__name and window.__xss=(window.__xss)'), 'obs snake__case__name and window.__xss=(window.__xss)');
  assert.equal(markdownInlineSafe('Renamed a to x__y__z'), 'Renamed a to x__y__z');
});

test('generated texts: nothing outside the export\'s own code and links can start markup', () => {
  const tokens = ['`', '``', '```', '~~~', '````', '\\', '<img src=x onerror=alert(1)>', '[a]', '(javascript:alert(1))',
    ']: javascript:alert(1)', '![i](https://e.x/p.png)', '[l](https://ok.x)', '\n', '\n\n', '  ', '    ', '- ', '> ', '1. ',
    'text', ' ', '*', '**', '_', '<', '&#60;', '\r', '|', '<https://x>'];
  let seed = 12345;
  const next = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let k = 0; k < 4000; k++) {
    let text = '';
    for (let j = 1 + next(14); j > 0; j--) text += tokens[next(tokens.length)];
    assert.equal(activeMarkup(markdownSafe(text)), null, JSON.stringify(text));
    assert.equal(activeMarkup(markdownInlineSafe(text)), null, JSON.stringify(text));
  }
});
