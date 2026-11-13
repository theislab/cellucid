/**
 * No comment, test title, workflow comment, stylesheet comment, HTML comment
 * of a shipped page, `about` or `description` field of a JSON fixture, or
 * Markdown page of the web repository holds an id, a run address or a pointer
 * into a repository the reader cannot open (`CONTRIBUTING.md`, "Comments say
 * what the code does").
 *
 * JavaScript and TypeScript sources are read with TypeScript's scanner, so
 * a string that looks like a comment is not one and a comment inside a
 * template literal's `${}` is. The comments of a GLSL template string are
 * read too. Stylesheets, the shipped pages and JSON files have a reader of
 * their own. A planted id, run in this file on source text, shows that each
 * rule fails where it must.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The folders and files whose comments are held to the rule, from the repository root. */
const SCANNED = ['assets/js', 'assets/css', 'tests', 'scripts', 'relay', 'service-worker.js', 'types', '.github', 'docs'];

/** The pages the site ships: the root pages and the pages under `assets/`. A page of a test harness is not shipped. */
const SHIPPED_PAGES = () => [
  ...readdirSync(ROOT).filter(name => name.endsWith('.html')),
  ...filesUnder('assets'),
].filter(file => file.endsWith('.html'));

/** The JSON fields whose text is prose. */
const PROSE_FIELDS = new Set(['about', 'description']);
const SKIPPED_FOLDERS = new Set(['node_modules', '.git', 'generated']);

/**
 * The shapes of history, each tested on one line of comment text. An id is a
 * letter code and a number that only the maintenance ledgers define; the key
 * names F1 to F12 are not ids.
 */
const RULES = [
  ['finding id', /(?<![\w+`-])F(?:1[3-9]|[2-9]\d|\d{3})\b(?!-)/],
  ['finding id', /\bL\d{1,2}-\d{1,2}\b/],
  ['finding id', /\bR\d{1,2}[A-Z]{1,2}-\d{1,3}\b/],
  ['finding id', /\bRC[A-Z]-\d{1,2}\b/],
  ['finding id', /\bCEL-(?:AUDIT-)?\d{2,4}\b/],
  ['finding id', /\b(?:CE|NS|MB|LB|LF|LG|LA|LC|ST|UX)-W?\d{1,2}\b/],
  ['finding id', /\bK-(?:\d{2}|nn)\b/],
  ['finding id', /\b(?:bug hunt|audit) (?:[A-Z]\d{1,2}|F-\d{1,2})\b/],
  ['round', /\bround[- ]\d+\b/i],
  ['bug hunt', /\bbug[- ]?hunt/i],
  ['live pass', /\blive[- ](?:pass )?\d+\b/i],
  ['lens label', /\blens-[a-z0-9]+|\b(?:security|wording|a11y|accessibility|privacy|backend|coverage) lens\b/i],
  ['CI run', /\bactions\/runs\/\d+|\brun #?\d{8,}\b|\b4[0-4]\d{9}\b/],
  ['private path', /\bcellucid-private\b/],
  ['plan pointer', /\bHistory v2 ?§/],
];

/** The history found on each line of `lines` (comment text), as `{ line, rule, text }`. */
function historyIn(lines) {
  const found = [];
  for (const { line, text } of lines) {
    for (const [rule, pattern] of RULES) {
      const match = pattern.exec(text);
      if (match) found.push({ line, rule, text: match[0] });
    }
  }
  return found;
}

/** Comment lines of a GLSL string: `//` to the end of a line and `/* ... *\/`. */
function glslCommentLines(text, firstLine) {
  const lines = [];
  const pattern = /\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const before = text.slice(0, match.index);
    const start = firstLine + (before.match(/\n/g)?.length ?? 0);
    match[0].split('\n').forEach((part, i) => lines.push({ line: start + i, text: part }));
  }
  return lines;
}

const GLSL = /\bvoid\s+main\s*\(|\bgl_(?:Position|FragColor|FragCoord)\b|\bprecision\s+(?:highp|mediump|lowp)\b/;
const TITLE_CALLS = new Set(['test', 'it', 'describe', 'step', 'suite']);

/**
 * The comment lines, test titles and GLSL comments of one JavaScript or
 * TypeScript source, as `{ line, text }`.
 */
export function commentLinesOf(source, fileName = 'source.js') {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source);
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const lineAt = (position) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid] <= position) low = mid; else high = mid - 1;
    }
    return low + 1;
  };

  const out = [];
  const templates = [];
  const recent = [];
  const SK = ts.SyntaxKind;
  const isTitleString = () => {
    // `test(`, `test.skip(`, `describe(`, `test.step(` right before this string.
    const [open, name, dot, base] = [recent.at(-1), recent.at(-2), recent.at(-3), recent.at(-4)];
    if (open?.kind !== SK.OpenParenToken || name?.kind !== SK.Identifier) return false;
    if (TITLE_CALLS.has(name.text)) return true;
    return dot?.kind === SK.DotToken && base?.kind === SK.Identifier && TITLE_CALLS.has(base.text);
  };

  for (let kind = scanner.scan(); kind !== SK.EndOfFileToken; kind = scanner.scan()) {
    const start = scanner.getTokenStart();
    const text = scanner.getTokenText();
    if (kind === SK.SingleLineCommentTrivia) {
      out.push({ line: lineAt(start), text: text.replace(/^\/\/+/, '') });
      continue;
    }
    if (kind === SK.MultiLineCommentTrivia) {
      text.split('\n').forEach((part, i) => out.push({ line: lineAt(start) + i, text: part.replace(/^\s*(?:\/\*+|\*+\/?)/, '').replace(/\*\/\s*$/, '') }));
      continue;
    }
    if (kind === SK.WhitespaceTrivia || kind === SK.NewLineTrivia || kind === SK.ShebangTrivia || kind === SK.ConflictMarkerTrivia) continue;

    if (kind === SK.StringLiteral || kind === SK.NoSubstitutionTemplateLiteral) {
      if (isTitleString()) out.push({ line: lineAt(start), text });
      if (kind === SK.NoSubstitutionTemplateLiteral && GLSL.test(text)) out.push(...glslCommentLines(text, lineAt(start)));
    } else if (kind === SK.TemplateHead) {
      templates.push({ depth: 0, segments: [{ text, line: lineAt(start) }] });
    } else if (kind === SK.OpenBraceToken && templates.length) {
      templates.at(-1).depth += 1;
    } else if (kind === SK.CloseBraceToken && templates.length) {
      const current = templates.at(-1);
      if (current.depth > 0) {
        current.depth -= 1;
      } else {
        const next = scanner.reScanTemplateToken(false);
        current.segments.push({ text: scanner.getTokenText(), line: lineAt(scanner.getTokenStart()) });
        if (next === SK.TemplateTail) {
          templates.pop();
          if (GLSL.test(current.segments.map(s => s.text).join(' '))) {
            for (const segment of current.segments) out.push(...glslCommentLines(segment.text, segment.line));
          }
        }
      }
    } else if (kind === SK.SlashToken || kind === SK.SlashEqualsToken) {
      // A slash after a value divides; after anything else it opens a regular expression.
      const previous = recent.at(-1);
      const afterValue = previous && (
        (previous.kind === SK.Identifier && !/^(?:return|typeof|in|of|case|do|else|void|delete|throw|new|yield|await)$/.test(previous.text))
        || previous.kind === SK.NumericLiteral || previous.kind === SK.StringLiteral
        || previous.kind === SK.RegularExpressionLiteral || previous.kind === SK.CloseParenToken
        || previous.kind === SK.CloseBracketToken || previous.kind === SK.NoSubstitutionTemplateLiteral
        || previous.kind === SK.PlusPlusToken || previous.kind === SK.MinusMinusToken
        || previous.kind === SK.ThisKeyword || previous.kind === SK.SuperKeyword
        || previous.kind === SK.TrueKeyword || previous.kind === SK.FalseKeyword || previous.kind === SK.NullKeyword
        || (previous.kind === SK.CloseBraceToken && previous.endsTemplate)
      );
      if (!afterValue) {
        scanner.reScanSlashToken();
        recent.push({ kind: SK.RegularExpressionLiteral, text: scanner.getTokenText() });
        if (recent.length > 4) recent.shift();
        continue;
      }
    }
    const token = { kind, text };
    if (kind === SK.TemplateHead) token.kind = SK.StringLiteral;
    // A keyword that is also a name (`test`, `of`) scans as its keyword kind; title detection reads the text.
    if (token.kind !== SK.Identifier && /^[A-Za-z_$][\w$]*$/.test(text) && ts.tokenToString(kind) === undefined) token.kind = SK.Identifier;
    else if (ts.tokenToString(kind) !== undefined && /^[a-z]+$/.test(text) && kind >= SK.FirstKeyword && kind <= SK.LastKeyword && !isValueKeyword(kind)) token.kind = SK.Identifier;
    recent.push(token);
    if (recent.length > 4) recent.shift();
  }
  void fileName;
  return out;
}

function isValueKeyword(kind) {
  const SK = ts.SyntaxKind;
  return kind === SK.ThisKeyword || kind === SK.SuperKeyword || kind === SK.TrueKeyword || kind === SK.FalseKeyword || kind === SK.NullKeyword;
}

/**
 * The `#` comments of a YAML file, as `{ line, text }`: a `#` that opens a
 * line or follows white space outside a quoted string. The comments inside a
 * block scalar (a step's shell script) are read too.
 */
export function yamlCommentLines(source) {
  const out = [];
  source.split('\n').forEach((lineText, index) => {
    let quote = null;
    for (let i = 0; i < lineText.length; i++) {
      const ch = lineText[i];
      if (quote) {
        if (ch === '\\' && quote === '"') i += 1;
        else if (ch === quote) quote = null;
      } else if ((ch === '"' || ch === "'") && (i === 0 || /[\s:[{,-]/.test(lineText[i - 1]))) {
        quote = ch;
      } else if (ch === '#' && (i === 0 || /\s/.test(lineText[i - 1]))) {
        out.push({ line: index + 1, text: lineText.slice(i + 1) });
        break;
      }
    }
  });
  return out;
}

/** The `/* ... *\/` comments of a stylesheet, as `{ line, text }`, one entry per line; a quoted string is skipped. */
export function cssCommentLines(source) {
  const out = [];
  const pattern = /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\/\*[\s\S]*?\*\//g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    if (!match[0].startsWith('/*')) continue;
    const start = source.slice(0, match.index).split('\n').length;
    match[0].split('\n').forEach((part, i) => out.push({ line: start + i, text: part.replace(/^\s*(?:\/\*+|\*+\/?)/, '').replace(/\*\/\s*$/, '') }));
  }
  return out;
}

/** The `<!-- ... -->` comments of an HTML page, as `{ line, text }`, one entry per line. */
export function htmlCommentLines(source) {
  const out = [];
  const pattern = /<!--[\s\S]*?-->/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const start = source.slice(0, match.index).split('\n').length;
    match[0].split('\n').forEach((part, i) => out.push({ line: start + i, text: part.replace(/^<!--/, '').replace(/-->$/, '') }));
  }
  return out;
}

/** The text of every `about` and `description` field of a JSON document, as `{ line: 0, text }` (JSON has no line to name). */
export function jsonProseLines(source) {
  const out = [];
  const walk = (value, key) => {
    if (typeof value === 'string') {
      if (PROSE_FIELDS.has(key)) out.push({ line: 0, text: value });
    } else if (value && typeof value === 'object') {
      for (const [name, child] of Object.entries(value)) walk(child, name);
    }
  };
  walk(JSON.parse(source), '');
  return out;
}

/** Every line of a Markdown page. */
function markdownLines(source) {
  return source.split('\n').map((text, index) => ({ line: index + 1, text }));
}

function filesUnder(entry) {
  const full = path.join(ROOT, entry);
  let stats;
  try { stats = readdirSync(full, { withFileTypes: true }); } catch { return [entry]; }
  return stats.flatMap(child => {
    if (child.isDirectory()) return SKIPPED_FOLDERS.has(child.name) ? [] : filesUnder(`${entry}/${child.name}`);
    return /\.(?:m?js|cjs|ts|md|ya?ml|css|json)$/.test(child.name) ? [`${entry}/${child.name}`] : [];
  });
}

/** Every history finding of the scanned tree, as `file:line rule "text"`. */
function historyOfTree() {
  const found = [];
  const files = [...new Set([...SCANNED.flatMap(filesUnder), ...SHIPPED_PAGES()])];
  for (const file of files) {
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    // Comment text is a part of the source text, so a source no rule matches holds no history: only
    // the sources a rule matches anywhere are tokenized.
    if (!RULES.some(([, pattern]) => pattern.test(source))) continue;
    const lines = file.endsWith('.md') ? markdownLines(source)
      : /\.ya?ml$/.test(file) ? yamlCommentLines(source)
      : file.endsWith('.css') ? cssCommentLines(source)
      : file.endsWith('.html') ? htmlCommentLines(source)
      : file.endsWith('.json') ? jsonProseLines(source)
      : commentLinesOf(source, file);
    for (const { line, rule, text } of historyIn(lines)) found.push(`${file}:${line} ${rule} "${text}"`);
  }
  return found;
}

test('no comment, test title, workflow comment or Markdown page of the tree holds an id, a run address or a private pointer', () => {
  const found = historyOfTree();
  assert.deepEqual(found, [], `History in the tree. Say what the code does and why, with no id, run or private path:\n${found.join('\n')}`);
});

test('each rule fails on a planted id, in a comment, a JSDoc, a test title, a template and a GLSL string', () => {
  const planted = [
    ['finding id', '// fixes F123 here'],
    ['finding id', '// the L25-3 case'],
    ['finding id', '// see R9W-5'],
    ['finding id', '// RCB-2 again'],
    ['finding id', '// CEL-0249 and CEL-AUDIT-12'],
    ['finding id', '// LB-4 said so'],
    ['finding id', '// K-07 holds'],
    ['finding id', '// audit F-3 said so'],
    ['round', '// found in round 9'],
    ['bug hunt', '// a bug hunt result'],
    ['live pass', '// the live pass 5 showed it'],
    ['lens label', '// the security lens asked'],
    ['CI run', '// run 12345678901 failed'],
    ['CI run', '// https://github.com/x/y/actions/runs/998877'],
    ['private path', '// in cellucid-private/plans'],
    ['plan pointer', '// History v2 §3.8'],
  ];
  for (const [rule, comment] of planted) {
    assert.deepEqual(historyIn(commentLinesOf(`const a = 1;\n${comment}\n`)).map(f => [f.rule, f.line]), [[rule, 2]], comment);
    const jsdoc = `/**\n * Says what it does\n * ${comment.replace(/^\/\/ /, '')}\n */\nfunction f() {}\n`;
    assert.deepEqual(historyIn(commentLinesOf(jsdoc)).map(f => [f.rule, f.line]), [[rule, 3]], `JSDoc: ${comment}`);
  }
  const title = "test('the F123 case', () => {});\ndescribe(\"CEL-0224 shows\", () => {});\ntest.step('round 9 walk', () => {});\n";
  assert.deepEqual(historyIn(commentLinesOf(title)).map(f => f.line), [1, 2, 3]);
  const template = 'const s = `line\n${x} // in a template K-07\n`;\nconst g = `void main() {\n  // CEL-0249 in a shader\n  gl_Position = vec4(1.0); /* L25-3 */\n}`;\n';
  assert.deepEqual(historyIn(commentLinesOf(template)).map(f => f.line), [5, 6]);
  const interpolated = 'const g = `void main() {\n  // F123 before\n  float a = ${n};\n  // F124 after\n}`;\n';
  assert.deepEqual(historyIn(commentLinesOf(interpolated)).map(f => f.line), [2, 4]);
});

test('a planted run address fails in a workflow comment and not in a string or a name', () => {
  const planted = 'name: a\n# run 12345678901 failed\nsteps:\n  - run: echo hi # fixed in round 9\n';
  assert.deepEqual(historyIn(yamlCommentLines(planted)).map(f => [f.rule, f.line]), [['CI run', 2], ['round', 4]]);
  const clean = 'env:\n  NOTE: "a # round 9"\n  URL: https://x.test/page#round-9\n  TOKEN: \'#round 9\'\nscript: echo "$#" ${{ matrix.os }}\n';
  assert.deepEqual(historyIn(yamlCommentLines(clean)), []);
});

test('a planted id fails in a stylesheet comment, an HTML comment and a JSON prose field, and not in a string, a rule or another field', () => {
  const css = '.a { color: red; } /* kept for F123 */\n.b::after { content: "/* F123 */"; }\n/* a\n   plan in cellucid-private/plans */\n';
  assert.deepEqual(historyIn(cssCommentLines(css)).map(f => [f.rule, f.line]), [['finding id', 1], ['private path', 4]]);
  const html = '<p>F123 in the page</p>\n<!-- History v2 §3.10 says so -->\n<!-- a\n     bug hunt -->\n';
  assert.deepEqual(historyIn(htmlCommentLines(html)).map(f => [f.rule, f.line]), [['plan pointer', 2], ['bug hunt', 4]]);
  const json = JSON.stringify({ about: 'script in cellucid-private notes', nested: { description: 'found in round 9' }, id: 'F123', note: 'F123' });
  assert.deepEqual(historyIn(jsonProseLines(json)).map(f => f.rule), ['private path', 'round']);
});

test('what is not a comment is not read, and the key names are not ids', () => {
  const clean = [
    "const url = 'http://example.test/F123'; const note = 'CEL-0249 in a string'; const re = /\\/\\/ F123/;",
    'const half = a / b; // press F2 or F10 or F12, then Shift+F11\n',
    "const t = `a // F123 ${'x'} b`;\n",
    "test('opens the file', () => { const q = x / 2; /* the keys F1 to F9 */ });\n",
    'const glslNote = `plain text // F123 with no shader in it`;\n',
  ].join('\n');
  assert.deepEqual(historyIn(commentLinesOf(clean)), []);
});
