/**
 * The words a person reads when something fails, and the marks every message
 * shares (`assets/css/README.md`, Tone and Wording and numbers).
 *
 * - **A failure is said in a sentence, its technical words under Details.**
 *   A notification or a status line that quotes an error's own message (or
 *   `failureText`) shows whatever the thrower wrote: an invariant of the code
 *   ("options cannot replace the owned key field"), a tracker's uuid, a GPU
 *   code. Every such line goes through `sayFailure`, which says a broken
 *   invariant as one, and `failureDetails`, which folds its words under the
 *   card's Details (`utils/errors.js`). Live pass 3 met it as "Loading failed ·
 *   Saved state: tracker 4f3c…: a group cuts the run of turn …"; the lens
 *   found nine local copies of "an error in words" (`describeError`,
 *   `errorText`, `describeThrownError`, `failureMessage`, `failureWords`, …).
 * - **"…", never "...".** In-progress text and anything that opens a further
 *   step end in the ellipsis character.
 * - **Sentence case.** A notification's title is sentence case ("Generating
 *   data", not "Generating Data").
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../assets/js/', import.meta.url));

async function sources(dir = ROOT) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Vendored code, and the developer benchmark (its words are for the console).
      if (entry.name !== 'vendor' && full !== path.join(ROOT, 'dev')) out.push(...await sources(full));
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out.sort();
}

/** The source with comments blanked out, line numbers kept. */
function withoutComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, block => block.replace(/[^\n]/g, ' '))
    .split('\n')
    .map(line => (/^\s*\/\//.test(line) ? '' : line));
}

/** A call that shows words to the person: a notification, or a status line. */
const SAYS = /\b(?:notifications?|_notifications|center|getNotificationCenter\(\))\.(?:error|fail|warning|info|failCalculation|failDownload)\(|\bnotify\(|\b(?:status|statusElement)\.textContent\s*=|\btext:\s*`|\bsaid\s*=\s*`/;
/** An error's own words, quoted as they are. */
const RAW = /\$\{[^}]*\b(?:err|error|exactError|failure|cause)\??\.message\b|\b(?:err|error|exactError|failure)\??\.message\s*(?:\|\||\?\?|\))|failureText\(/;

test('a failure shown to a person is said with sayFailure, never in its own raw words', async () => {
  const offenders = [];
  for (const file of await sources()) {
    const lines = withoutComments(await readFile(file, 'utf8'));
    lines.forEach((line, index) => {
      // The call and the words it shows may sit on the next lines.
      const call = lines.slice(index, index + 3).join(' ');
      if (!SAYS.test(line) || !RAW.test(call)) return;
      // Details are where the raw words belong.
      // A hover title holds them too (`status.title = failureText(error)`).
      const shown = call.replace(/details:\s*[^,}]+/g, '').replace(/failureDetails\([^)]*\)/g, '').replace(/\.title\s*=\s*failureText\([^)]*\)/g, '');
      if (!RAW.test(shown)) return;
      offenders.push(`${path.relative(ROOT, file)}:${index + 1}: ${line.trim().slice(0, 140)}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('no file keeps its own copy of "an error in words"', async () => {
  // `utils/errors.js` is the one place: `failureText`, `sayFailure`, `failureDetails`.
  const COPY = /function\s+(describeError|errorText|errorMessage|describeThrownError|failureMessage|failureWords|describeErrorMessage)\s*\(/;
  const offenders = [];
  for (const file of await sources()) {
    const relative = path.relative(ROOT, file);
    // Analytics records an error's class, never its words (`analytics/schema.js`).
    if (relative === path.join('analytics', 'schema.js')) continue;
    withoutComments(await readFile(file, 'utf8')).forEach((line, index) => {
      const found = line.match(COPY);
      if (found !== null) offenders.push(`${relative}:${index + 1}: ${found[1]}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('a failure said after its lead is said once: "X could not be opened: The linked data could not be opened: …" never (F141)', async () => {
  // Live pass 5: every link refusal read "… could not be opened: The linked data could not be opened: …".
  const { joinFailure, sayFailure } = await import('../assets/js/utils/errors.js');
  assert.equal(joinFailure('"Beta" could not be opened', 'The linked data could not be opened: the server answered 404.'), '"Beta" could not be opened: the server answered 404.');
  assert.equal(joinFailure('"Beta" could not be opened', 'The linked data could not be opened. Try again; if it keeps failing, report it.'), '"Beta" could not be opened. Try again; if it keeps failing, report it.');
  assert.equal(joinFailure('The neighbor graph could not be read on the new cells', 'The neighbor graph could not be read: the server answered 404.'), 'The neighbor graph could not be read on the new cells: the server answered 404.');
  assert.equal(joinFailure('X could not be opened', 'it could not be opened'), 'X could not be opened.');
  // Another failure, or the same verb said of something else as the whole reason, stays.
  assert.equal(joinFailure('The gene names could not be read', 'the var index could not be read'), 'The gene names could not be read: the var index could not be read');
  assert.equal(joinFailure('The vector field could not be shown', sayFailure(new TypeError('x'))), 'The vector field could not be shown: a problem inside Cellucid stopped it.');
  // Every wrapper of a failure's sentence in a lead naming what failed goes through it.
  const WRAPPED = /`[^`\n]*?(?:could not|cannot|can not|did not|was not|were not)(?: be)? \w+[^`\n]*?: \$\{(?:sayFailure|failureSentence|failureText)\(/;
  const offenders = [];
  for (const file of await sources()) {
    withoutComments(await readFile(file, 'utf8')).forEach((line, index) => {
      if (/\b(?:console|debug)\.\w+\(/.test(line)) return;
      if (WRAPPED.test(line)) offenders.push(`${path.relative(ROOT, file)}:${index + 1}: ${line.trim().slice(0, 140)}`);
    });
  }
  assert.deepEqual(offenders, [], 'use joinFailure(lead, sayFailure(error))');
});

test('an error whose message names a code class is an InternalError: the person reads that a problem inside Cellucid stopped it', async () => {
  // "The vector field could not be shown: VelocityOverlay could not allocate transform-feedback ownership."
  // (wording lens): a code class's own words, said to the person. Names of products and web APIs are not code.
  const { InternalError, isInternalFailure, sayFailure, failureDetails } = await import('../assets/js/utils/errors.js');
  const error = new InternalError('VelocityOverlay could not allocate transform-feedback ownership.');
  assert.ok(isInternalFailure(error));
  assert.equal(sayFailure(error), 'a problem inside Cellucid stopped it.');
  assert.match(failureDetails(error).details, /transform-feedback/);
  const NOT_CODE = new Set(['GitHub', 'AnnData', 'IndexedDB', 'WebGL', 'WebGL2', 'TextEncoder', 'LinkedIn', 'CustomEvent', 'AbortController', 'MuData', 'OneDrive', 'JavaScript', 'SharePoint', 'WebAssembly', 'ReadableStream', 'OffscreenCanvas', 'SharedArrayBuffer', 'WebGPU', 'DataView', 'ArrayBuffer']);
  const offenders = [];
  for (const file of await sources()) {
    const text = withoutComments(await readFile(file, 'utf8')).join('\n');
    for (const found of text.matchAll(/new Error\(\s*['`]([A-Z][a-z]+(?:[A-Z][a-z0-9]*)+)\b/g)) {
      if (!NOT_CODE.has(found[1])) offenders.push(`${path.relative(ROOT, file)}: ${found[1]}`);
    }
  }
  assert.deepEqual(offenders, [], 'throw new InternalError(…) (utils/errors.js)');
});

test('in-progress and further-step text ends in "…", never "..."', async () => {
  const offenders = [];
  for (const file of await sources()) {
    withoutComments(await readFile(file, 'utf8')).forEach((line, index) => {
      if (/\b(?:console|debug)\.\w+\(/.test(line)) return;
      for (const [literal] of line.matchAll(/(['"`])(?:(?!\1)[^\\]|\\.)*?\1/g)) {
        // A console line's tag ("[HighPerfRenderer] Loading..." on a call's next line).
        if (/^['"`]\[\w/.test(literal)) continue;
        if (/[\w}%)]\.\.\.(?![\w$.[({])|(^['"`])\.\.\.\s/.test(literal)) {
          offenders.push(`${path.relative(ROOT, file)}:${index + 1}: ${literal.slice(0, 100)}`);
        }
      }
    });
  }
  assert.deepEqual(offenders, []);
});

test('a notification title is sentence case', async () => {
  // A capitalised word after the first is a name (GitHub, Google Drive, AnnData) or Title Case.
  // …and the names of controls and places (Share… and Load…, My datasets).
  const NAMES = /^(?:Cellucid|GitHub|Google|Drive|AnnData|MuData|Zarr|Python|R|Recently|Cell|Annotation|Platform|CSV|PNG|SVG|GMT|UMAP|HTTP|Share|Load|My|Esc|Enter)$/;
  const offenders = [];
  for (const file of await sources()) {
    withoutComments(await readFile(file, 'utf8')).forEach((line, index) => {
      for (const [, title] of line.matchAll(/\btitle:\s*'([^'.]+)'/g)) {
        // A title of a few words; a sentence is a tip, not a title.
        const words = title.split(/\s+/).slice(1);
        if (words.length > 4) continue;
        if (words.some(word => /^[A-Z][a-z]+$/.test(word) && !NAMES.test(word))) {
          offenders.push(`${path.relative(ROOT, file)}:${index + 1}: ${title}`);
        }
      }
    });
  }
  assert.deepEqual(offenders, []);
});

test('the page\'s own labels end in no colon and its text in no "..."', async () => {
  // `assets/css/README.md`: labels and headings never end in a colon; the
  // performance panel's details once read "GPU Mem:", "Frame Time:".
  const html = (await readFile(new URL('../index.html', import.meta.url), 'utf8'))
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/g, '');
  const colons = [...html.matchAll(/>\s*([A-Za-z][^<>]{0,38}):\s*</g)].map(([, label]) => `${label}:`);
  assert.deepEqual(colons, []);
  const dots = [...html.matchAll(/[^<>"]*\.\.\.[^<>"]*/g)].map(([text]) => text.trim());
  assert.deepEqual(dots, []);
});

/**
 * British spellings with a US one (ledger F118, F141). A word of a list, in
 * prose (a compound too: "TMM-normalized"): never part of an identifier, a
 * path or a flag (a letter, `_`, `.`, `/`, `--` or `$` beside it), nor inside backticks (a parameter or a
 * key named, as `normalise` of `expression.transform.set`).
 */
// The word list is shared with cellucid-python (tests/test_spelling_contract.py) and cellucid-r
// (tests/testthat/test-spelling.R), byte for byte, at this digest: the packages' messages, help
// and the documentation are held to the same words (R9N-1). Update all three together.
const SPELLING_URL = new URL('./fixtures/spelling.json', import.meta.url);
const SPELLING_SHA256 = 'f195abcd84ce15a4d39575042ac1ad205a0b4e1b6b8b439d361d4c0dfbbfa77c';
const SPELLING = JSON.parse(readFileSync(SPELLING_URL, 'utf8'));
const UK_WORDS = new RegExp(String.raw`(?<![\w.$/\\]|--)(?:${SPELLING.british.map(({ pattern }) => pattern).join('|')})(?![\w$/\\]|\.\w|\s*=(?!=)|\()`, 'gi');

test('the British word list is the one shared with the Python and R packages, at the pinned digest', () => {
  assert.equal(createHash('sha256').update(readFileSync(SPELLING_URL)).digest('hex'), SPELLING_SHA256);
  assert.equal(SPELLING.version, 1);
  // Every pattern finds its own British example and leaves the US word alone.
  for (const [british, us] of [['neighbour', 'neighbor'], ['Colours', 'Colors'], ['greyed', 'grayed'], ['cancelled', 'canceled'],
    ['catalogue', 'catalog'], ['unrecognised', 'unrecognized'], ['reorganisation', 'reorganization'],     ['learnt', 'learned'], ['acknowledgement', 'acknowledgment'], ['honoured', 'honored'], ['analysed', 'analyzed'], ['relabelled', 'relabeled'], ['centred', 'centered']]) {
    assert.deepEqual(ukSpellings(`the ${british} one`), [british], british);
    assert.deepEqual(ukSpellings(`the ${us} one`), [], us);
  }
  // Never a name: an identifier, a path, a flag, a key assigned, a call, a backtick span.
  assert.deepEqual(ukSpellings('asyncio.CancelledError notifications/cancelled --colour colour= normalise( `cancelled` de-cancelled.png'), []);
  assert.deepEqual(ukSpellings('cancellation, analyses, organism, summaries, precise, raised'), []);
  // A template over lines is read whole, its `${…}` (and a template inside one) apart.
  const templates = templatesOf("const a = 'x`y'; const t = `First line\n${n ? `inner` : 'b'} was\ncancelled.`; f(`one`);");
  assert.deepEqual(templates.map(({ words }) => words), ['inner', 'First line\n  was\ncancelled.', 'one']);
});

/**
 * Every template literal of `code` (comments already blanked) with its words: the text between
 * its backticks, each `${…}` read as a space (a template inside one is a template of its own).
 * Quoted strings are skipped whole, so a backtick inside one opens nothing.
 */
function templatesOf(code) {
  const out = [];
  let i = 0;
  const skipQuoted = quote => {
    for (i++; i < code.length && code[i] !== quote && code[i] !== '\n'; i++) if (code[i] === '\\') i++;
    i++;
  };
  // Code up to the `}` closing a `${`, or to the end.
  const scanCode = () => {
    let depth = 0;
    while (i < code.length) {
      const ch = code[i];
      if (ch === "'" || ch === '"') skipQuoted(ch);
      else if (ch === '`') scanTemplate();
      else if (ch === '{') { depth++; i++; } else if (ch === '}') { if (depth === 0) return; depth--; i++; } else i++;
    }
  };
  function scanTemplate() {
    const at = i;
    let words = '';
    for (i++; i < code.length && code[i] !== '`';) {
      if (code[i] === '\\') { words += code.slice(i, i + 2); i += 2; } else if (code[i] === '$' && code[i + 1] === '{') {
        i += 2; words += ' '; scanCode(); i++;
      } else words += code[i++];
    }
    i++;
    out.push({ at, words });
  }
  scanCode();
  return out;
}

/** The British spellings in prose `text` (backtick spans left out). */
function ukSpellings(text) {
  // An escaped quote is the quote itself: "organisation\\'s" in a quoted string is "organization's"
  // (R9U-1: the backslash after the word hid it).
  return [...text.replace(/\\(.)/g, '$1').replace(/`[^`]*`/g, ' ').matchAll(UK_WORDS)].map(([word]) => word);
}

test('one spelling: US ("color", "neighbor", "gray", "normalize"…), never British, in every string a person or an agent reads', async () => {
  // Labels said "Color by" while step names, notices and action summaries said
  // "Coloured by …", "Colour cells by …" (ledger F118); the same mix stayed
  // with "neighbour"/"neighbor", "grey"/"gray", "normalised"/"normalized",
  // "catalogue"/"catalog" (F141): US spelling throughout — the page, the
  // action catalog (its titles, summaries and descriptions are generated
  // from these sources), step names, notices and tips. "Canceled" (one l;
  // the app said both, round 9) and "analyses" (the plural of analysis);
  // "cancellation" keeps its two. A template's words and a one-word sentence
  // ("Canceled.") are read too: neither was before round 9.
  const offenders = [];
  for (const file of await sources()) {
    withoutComments(await readFile(file, 'utf8')).forEach((line, index) => {
      for (const [literal, quote] of line.matchAll(/(['"`])(?:(?!\1)[^\\]|\\.)*?\1/g)) {
        // Prose (words with a space between, or one word said as a sentence: "Canceled."); any
        // other one-word literal is a key or a value of a format, which the catalog and history
        // model test below holds to the same spelling.
        if (!/\s/.test(literal) && !/^.[A-Za-z]+[.!?…]+.$/.test(literal)) continue;
        // A template's interpolations are code; its own backticks are no backtick span (a
        // name quoted inside prose), or a template's words would never be read.
        const prose = quote === '`' ? literal.slice(1, -1).replace(/\$\{[^}]*\}/g, ' ') : literal.replace(/^['"]|['"]$/g, ' ');
        const found = ukSpellings(prose);
        if (found.length > 0) offenders.push(`${path.relative(ROOT, file)}:${index + 1}: ${found.join(', ')}: ${literal.slice(0, 100)}`);
      }
    });
    // A template over several lines (a tip, a page section, a report) is prose too; a shader's
    // source (GLSL) is code. Neither was read line by line above.
    const text = withoutComments(await readFile(file, 'utf8')).join('\n');
    for (const { at, words: template } of templatesOf(text)) {
      if (!template.includes('\n') || /#version|gl_Position|gl_FragColor|\bprecision\s+(?:high|medium|low)p\b|\buniform\s+\w+\s+u_/.test(template)) continue;
      const words = ukSpellings(template);
      if (words.length > 0) offenders.push(`${path.relative(ROOT, file)}:${text.slice(0, at).split('\n').length}: ${words.join(', ')}: ${template.trim().slice(0, 100)}`);
    }
  }
  // The relay's own words (an agent reads them: its answers, its approval page, its view card);
  // its generated bundle is the web app's sources above.
  const RELAY = fileURLToPath(new URL('../relay/', import.meta.url));
  for (const name of (await readdir(RELAY)).filter(entry => entry.endsWith('.js')).sort()) {
    withoutComments(await readFile(path.join(RELAY, name), 'utf8')).forEach((line, index) => {
      for (const [literal, quote] of line.matchAll(/(['"`])(?:(?!\1)[^\\]|\\.)*?\1/g)) {
        if (!/\s/.test(literal) && !/^.[A-Za-z]+[.!?…]+.$/.test(literal)) continue;
        const prose = quote === '`' ? literal.slice(1, -1).replace(/\$\{[^}]*\}/g, ' ') : literal.replace(/^['"]|['"]$/g, ' ');
        const found = ukSpellings(prose);
        if (found.length > 0) offenders.push(`relay/${name}:${index + 1}: ${found.join(', ')}: ${literal.slice(0, 100)}`);
      }
    });
  }
  for (const page of ['index.html', '404.html', 'accessibility.html', 'privacy.html', 'terms.html']) {
    const html = await readFile(new URL(`../${page}`, import.meta.url), 'utf8').catch(() => '');
    // The page's words: its text and attribute values, never its scripts' module paths.
    const words = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<script\b[\s\S]*?<\/script>/g, ' ').replace(/\b(?:href|src|id|class|for|aria-labelledby|aria-controls|aria-describedby)="[^"]*"/g, ' ');
    for (const word of ukSpellings(words)) offenders.push(`${page}: "${word}"`);
  }
  // The catalog's titles, summaries and descriptions: its prose, not the setting kind's value.
  const catalog = await readFile(new URL('./fixtures/action-catalog.json', import.meta.url), 'utf8');
  for (const [prose] of catalog.matchAll(/"(?:title|summary|description)":\s*"(?:[^"\\]|\\.)*"/g)) {
    const found = ukSpellings(prose.slice(prose.indexOf(':') + 1));
    if (found.length > 0) offenders.push(`tests/fixtures/action-catalog.json: ${found.join(', ')}: ${prose.slice(0, 100)}`);
  }
  assert.deepEqual(offenders, []);
});

test('one spelling in the repository\'s own pages too: every README, guide and policy is US (R9N-1)', async () => {
  // The app's strings were held to US spelling while its READMEs, ARCHITECTURE.md, the relay's and
  // the scripts' guides and SECURITY.md kept "neighbour", "catalogue", "behaviour" and
  // "anonymisation" (round 9): a developer or an agent reading the code read both. Code in
  // backticks is a name and is left out.
  const REPO = fileURLToPath(new URL('../', import.meta.url));
  const pages = [];
  const walk = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', '.git', 'vendor', 'external', 'page', 'fixtures', 'test-results', 'playwright-report'].includes(entry.name)) await walk(full);
      } else if (entry.name.endsWith('.md')) pages.push(full);
    }
  };
  await walk(REPO);
  assert.ok(pages.some(page => page.endsWith(path.join('assets', 'js', 'ARCHITECTURE.md'))), 'the walk reaches the guides');
  const offenders = [];
  for (const page of pages.sort()) {
    (await readFile(page, 'utf8')).split('\n').forEach((line, index) => {
      const words = ukSpellings(line);
      if (words.length > 0) offenders.push(`${path.relative(REPO, page)}:${index + 1}: ${words.join(', ')}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('every test expects the words the product says: US spelling in every expected text, browser specs and node tests (F141, R9N-1)', async () => {
  // Specs kept expecting "labelled", "neighbour", "normalised" after the product said "labeled"…:
  // an expectation in another spelling fails only in a browser run, or matches nothing at all.
  // Node tests did the same (round 9: `source-sign-in-contract` matched "your organisation's
  // administrator" after the step said "organization's"), and no test read them.
  // Test files are read on purpose: a test that pins British text forces the source back to it
  // (or fails the day the source is right), so an expected value is held to the product's words.
  // What the test only feeds in (a scripted model's reply, a recorded label, an assertion's own
  // message) is not read; a reply the product echoes back is written in US spelling too, so the
  // expectation that quotes it reads as the product would.
  const SPECS = fileURLToPath(new URL('./', import.meta.url));
  const specs = [];
  const walk = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'fixtures' && entry.name !== 'node_modules') await walk(full); } else if (entry.name.endsWith('.mjs') && full !== fileURLToPath(import.meta.url)) specs.push(full);
    }
  };
  await walk(SPECS);
  // An expectation's argument (over lines too), a locator's text, an accessible name.
  const EXPECTS = /\bassert\.(?:equal|strictEqual|deepEqual|deepStrictEqual|match|throws|rejects|partialDeepStrictEqual)\(|\b(?:toHaveText|toContainText|toHaveAccessibleName|toHaveAccessibleDescription|toBe|toEqual|toStrictEqual|toMatch|toMatchObject|toHaveAttribute|toHaveTitle|getByText|getByLabel)\(|\b(?:hasText|name):\s*/g;
  /** The text of an expectation's argument: up to its closing parenthesis (or the end of a `key:` value). */
  const argumentAt = (text, start) => {
    let depth = 0;
    for (let at = start; at < text.length; at++) {
      const ch = text[at];
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) return text.slice(start, at); depth--; }
      else if (depth === 0 && (ch === ';' || ch === ',') ) return text.slice(start, at);
    }
    return text.slice(start);
  };
  const offenders = [];
  for (const file of specs.sort()) {
    const text = withoutComments(await readFile(file, 'utf8')).join('\n');
    for (const found of text.matchAll(EXPECTS)) {
      // `name:` and `hasText:` are a locator's options in a browser spec; in a node test a case's name.
      if (/^(?:hasText|name):/.test(found[0]) && !file.includes(`${path.sep}browser${path.sep}`)) continue;
      let start = found.index + found[0].length;
      // node:assert: the expected value, the second argument (the actual one before it is the
      // product's, the message after it the test's own words).
      if (found[0].startsWith('assert')) start += argumentAt(text, start).length + 1;
      const expected = argumentAt(text, start);
      for (const [literal] of expected.matchAll(/(['"`])(?:(?!\1)[^\\]|\\.)*?\1|\/(?:[^/\\\n]|\\.)+\/[a-z]*/g)) {
        if (!/\s/.test(literal)) continue;
        // A name the test gave, echoed in quotes ('has no parameter "colour"') or as the key a
        // refusal names ("(unexpected: colour)"), is its input: a misspelled name on purpose.
        const words = ukSpellings(literal.replace(/\$\{[^}]*\}/g, ' ').replace(/\\?"[\w.-]+\\?"/g, ' ').replace(/unexpected: \w+/g, ' '));
        const line = text.slice(0, found.index).split('\n').length;
        if (words.length > 0) offenders.push(`${path.relative(SPECS, file)}:${line}: ${words.join(', ')}: ${literal.slice(0, 90)}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('an option list shows words, never an API or enum value capitalised', async () => {
  // The chat's Effort menu read "Xhigh": the provider's value with its first
  // letter raised. A value is shown through its labels.
  const { EFFORT_LABELS } = await import('../assets/js/app/agent/providers/contract.js');
  const { ANTHROPIC_EFFORTS } = await import('../assets/js/app/agent/providers/anthropic.js');
  const { OPENAI_EFFORTS } = await import('../assets/js/app/agent/providers/openai.js');
  for (const effort of new Set([...ANTHROPIC_EFFORTS, ...OPENAI_EFFORTS])) {
    assert.equal(typeof EFFORT_LABELS[effort], 'string', `effort "${effort}" has a label`);
  }
  assert.equal(EFFORT_LABELS.xhigh, 'Extra high');
  const { CHOICE_LABELS, PERMISSION_CHOICES } = await import('../assets/js/app/agent/presence/permissions.js');
  assert.deepEqual(Object.keys(CHOICE_LABELS).sort(), [...PERMISSION_CHOICES].sort());
  const offenders = [];
  for (const file of await sources()) {
    withoutComments(await readFile(file, 'utf8')).forEach((line, index) => {
      if (/new Option\([^)]*(?:\[0\]|charAt\(0\))\.toUpperCase\(\)/.test(line)) offenders.push(`${path.relative(ROOT, file)}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('one spelling in names too: every parameter, result key and value of the catalog and every field of the history model is US (F149)', async () => {
  // `expression.transform.set` took `normalise`, `vector-field.summary` `neighbours`, `camera.framing`
  // answered `centre`, `settings.list` named a kind `colour`, and saved states kept `{normalise, log1p}`:
  // an agent or a script spelled the words one way and the names the other.
  // A name agents and scripts already hold, kept as a contract: `history.branch.cancel` answers
  // `{cancelled}` (its prose says "canceled"). Nothing else is listed here.
  const CONTRACT_NAMES = new Set(['cancelled']);
  const offenders = [];
  const walk = (node, where, colormap = false) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${where}[${index}]`, colormap));
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' || key === 'fields') {
        for (const name of Object.keys(value ?? {})) {
          if (ukSpellings(name).length > 0 && !CONTRACT_NAMES.has(name)) offenders.push(`${where}.${key}: ${name}`);
        }
      }
      // matplotlib's colormap names (`greys`) are its own.
      if ((key === 'required' || key === 'enum') && Array.isArray(value) && !colormap) {
        for (const name of value) {
          if (typeof name === 'string' && ukSpellings(name).length > 0 && !CONTRACT_NAMES.has(name)) offenders.push(`${where}.${key}: ${name}`);
        }
      }
      walk(value, `${where}.${key}`, key === 'colormap');
    }
  };
  for (const fixture of ['action-catalog.json', 'history-model.schema.json']) {
    walk(JSON.parse(await readFile(new URL(`./fixtures/${fixture}`, import.meta.url), 'utf8')), fixture);
  }
  assert.deepEqual(offenders, []);
});
