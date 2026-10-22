/**
 * @fileoverview The Cellucid citation, read from the deployed CITATION.cff.
 *
 * `CITATION.cff` in this repository is the one place the citation is written
 * (between its `# BEGIN/END cellucid preferred-citation` markers). Every other
 * surface is generated from it: the README sections, the documentation's
 * "Citing Cellucid" page and the R package's citation by
 * `cellucid-private/scripts/sync_citation.py`, and the in-app Cite dialog here,
 * at runtime. This module is that script's reader and formatters in
 * JavaScript, so the dialog says exactly what the documentation says:
 * `tests/citation-contract.test.mjs` compares the two whenever the
 * documentation is checked out.
 *
 * A citation without a DOI is a placeholder — derived, never declared — and
 * every format says so.
 *
 * @module app/citation
 */

export const CITATION_PATH = 'CITATION.cff';
export const CITING_PAGE_URL = 'https://docs.cellucid.com/en/latest/citing.html';
const BIBTEX_KEY = 'cellucid';
const BEGIN_MARKER = '# BEGIN cellucid preferred-citation';
const END_MARKER = '# END cellucid preferred-citation';

const CITATION_KEYS = new Set(['type', 'status', 'title', 'authors', 'journal', 'doi', 'year', 'url']);
const AUTHOR_KEYS = new Set(['family-names', 'given-names', 'orcid', 'affiliation']);
const TOKEN_PATTERN = /^[a-z][a-z-]*$/;

export const PLACEHOLDER_NOTE =
  'bioRxiv preprint in preparation. Placeholder citation without a DOI; '
  + 'it will be replaced when the preprint is published.';

function scalar(raw, key) {
  const text = raw.trim();
  if (text.startsWith('"')) {
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw new TypeError(`Citation \`${key}\` is not a valid double-quoted string.`);
    }
    if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()) {
      throw new TypeError(`Citation \`${key}\` must be a non-empty string without outer spaces.`);
    }
    return value;
  }
  if (/^\d+$/.test(text)) return Number(text);
  if (TOKEN_PATTERN.test(text)) return text;
  throw new TypeError(`Citation \`${key}\` has an unsupported value.`);
}

function authorField(author, text) {
  const separator = text.indexOf(':');
  const key = separator < 0 ? '' : text.slice(0, separator);
  if (!AUTHOR_KEYS.has(key)) throw new TypeError(`Unsupported citation author line: ${text}`);
  if (Object.hasOwn(author, key)) throw new TypeError(`Citation author \`${key}\` appears twice.`);
  const value = text.slice(separator + 1);
  if (!value.trim().startsWith('"')) {
    throw new TypeError(`Citation author \`${key}\` must be a double-quoted string.`);
  }
  author[key] = scalar(value, key);
}

/**
 * Read the preferred citation out of a CITATION.cff file.
 *
 * @param {string} cffText - The whole file.
 * @returns {{status: string|null, title: string, authors: Array<{family: string, given: string}>,
 *   journal: string, doi: string|null, year: number|null, url: string|null, placeholder: boolean}}
 */
export function parsePreferredCitation(cffText) {
  if (typeof cffText !== 'string') throw new TypeError('CITATION.cff must be text.');
  const begin = cffText.indexOf(BEGIN_MARKER);
  const end = cffText.indexOf(END_MARKER);
  if (begin < 0 || end < begin) {
    throw new TypeError('CITATION.cff has no preferred-citation block.');
  }
  const lines = cffText
    .slice(begin, end)
    .split('\n')
    .map(line => line.replace(/\s+$/, ''))
    .filter(line => line.trim() !== '' && !line.trimStart().startsWith('#'));
  if (lines[0] !== 'preferred-citation:') {
    throw new TypeError('The citation block must hold one `preferred-citation:` mapping.');
  }
  const fields = {};
  const authors = [];
  let inAuthors = false;
  for (const line of lines.slice(1)) {
    if (line.startsWith('  ') && !line.startsWith('   ')) {
      const separator = line.indexOf(':');
      const key = separator < 0 ? '' : line.slice(2, separator);
      if (!CITATION_KEYS.has(key)) throw new TypeError(`Unsupported citation line: ${line}`);
      if (Object.hasOwn(fields, key) || (key === 'authors' && authors.length > 0)) {
        throw new TypeError(`Citation \`${key}\` appears twice.`);
      }
      const value = line.slice(separator + 1);
      if (key === 'authors') {
        if (value.trim() !== '') throw new TypeError('`authors:` must be followed by a list.');
        inAuthors = true;
        continue;
      }
      inAuthors = false;
      fields[key] = scalar(value, key);
    } else if (inAuthors && line.startsWith('    - ')) {
      authors.push({});
      authorField(authors.at(-1), line.slice(6));
    } else if (inAuthors && authors.length > 0 && /^ {6}\S/.test(line)) {
      authorField(authors.at(-1), line.slice(6));
    } else {
      throw new TypeError(`Unsupported citation structure: ${line}`);
    }
  }
  if (fields.type !== 'article') throw new TypeError('The citation `type` must be `article`.');
  if (typeof fields.title !== 'string' || typeof fields.journal !== 'string') {
    throw new TypeError('The citation needs a `title` and a `journal`.');
  }
  if (authors.length === 0) throw new TypeError('The citation must list at least one author.');
  const doi = typeof fields.doi === 'string' ? fields.doi : null;
  const year = typeof fields.year === 'number' ? fields.year : null;
  const placeholder = doi === null;
  if (!placeholder && year === null) throw new TypeError('A citation with a DOI needs a year.');
  return Object.freeze({
    status: typeof fields.status === 'string' ? fields.status : null,
    title: fields.title,
    authors: Object.freeze(authors.map(author => {
      if (typeof author['family-names'] !== 'string' || typeof author['given-names'] !== 'string') {
        throw new TypeError('Every citation author needs family-names and given-names.');
      }
      return Object.freeze({ family: author['family-names'], given: author['given-names'] });
    })),
    journal: fields.journal,
    doi,
    year,
    url: typeof fields.url === 'string' ? fields.url : null,
    placeholder,
  });
}

function initials(given) {
  return given
    .split(/\s+/)
    .filter(Boolean)
    .map(word => word.split('-').filter(Boolean).map(piece => `${piece[0]}.`).join('-'))
    .join(' ');
}

function apaAuthors(authors) {
  const names = authors.map(author => `${author.family}, ${initials(author.given)}`);
  if (names.length === 1) return names[0];
  if (names.length > 20) return `${names.slice(0, 19).join(', ')}, . . . ${names.at(-1)}`;
  return `${names.slice(0, -1).join(', ')}, & ${names.at(-1)}`;
}

function sentence(text) {
  return /[.?!]$/.test(text) ? text : `${text}.`;
}

/**
 * The APA-style reference as parts, so a caller can set the journal in
 * italics without building HTML from text: `before + journal + after`.
 */
export function apaParts(citation) {
  const authors = sentence(apaAuthors(citation.authors));
  if (citation.placeholder) {
    return { before: `${authors} ${sentence(citation.title)} `, journal: citation.journal, after: ' (in preparation).' };
  }
  return {
    before: `${authors} (${citation.year}). ${sentence(citation.title)} `,
    journal: citation.journal,
    after: `. https://doi.org/${citation.doi}`,
  };
}

/** The APA-style reference as plain text. */
export function apa(citation) {
  const { before, journal, after } = apaParts(citation);
  return `${before}${journal}${after}`;
}

function bibtexEscape(text) {
  let out = text.replaceAll('\\', '\\textbackslash{}');
  for (const character of '&%$#_') out = out.replaceAll(character, `\\${character}`);
  return out.replaceAll('{', '\\{').replaceAll('}', '\\}').replaceAll('~', '\\textasciitilde{}');
}

/** The BibTeX entry, ending in a newline. */
export function bibtex(citation) {
  const authors = citation.authors
    .map(author => `${bibtexEscape(author.family)}, ${bibtexEscape(author.given)}`)
    .join(' and ');
  const title = `{${bibtexEscape(citation.title)}}`;
  const [entry, fields] = citation.placeholder
    ? ['unpublished', [['author', authors], ['title', title], ['note', bibtexEscape(PLACEHOLDER_NOTE)]]]
    : ['article', [
        ['author', authors],
        ['title', title],
        ['journal', bibtexEscape(citation.journal)],
        ['year', String(citation.year)],
        ['doi', citation.doi],
        ['url', citation.url ?? `https://doi.org/${citation.doi}`],
      ]];
  const width = Math.max(...fields.map(([name]) => name.length));
  const body = fields.map(([name, value]) => `  ${name.padEnd(width)} = {${value}},\n`).join('');
  return `@${entry}{${BIBTEX_KEY},\n${body}}\n`;
}
