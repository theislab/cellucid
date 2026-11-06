/**
 * @fileoverview The agent's replies, written in Markdown, as page elements.
 *
 * Models answer in Markdown: paragraphs, headings, lists, tables of marker
 * genes, code, bold and italic words, links. This reads the part of it a
 * chat reply uses and builds elements from it with text nodes only: a reply
 * never becomes HTML, so nothing it says can run in the page. A link opens
 * in a new tab and only when it is http(s); anything not understood is shown
 * as the text it is.
 *
 * `parseMarkdown` is pure (tests); `renderMarkdown` builds the elements;
 * `createMarkdownStream` keeps a reply being streamed drawn, redrawing only
 * the blocks that changed (the last one, as it grows): the same elements
 * `renderMarkdown` builds, at a cost that does not grow with the reply.
 *
 * @module app/agent/chat/markdown
 */

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function cellsOf(line) {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  return text.split(/(?<!\\)\|/).map(cell => cell.trim().replaceAll('\\|', '|'));
}

/**
 * A reply as blocks: `{type: 'paragraph'|'heading'|'list'|'code'|'quote'|'table'|'rule', ...}`.
 * @param {string} text
 */
export function parseMarkdown(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let paragraph = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(FENCE);
    if (fence) {
      flush();
      const code = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) code.push(lines[i]);
      blocks.push({ type: 'code', text: code.join('\n') });
      continue;
    }
    if (line.trim() === '') { flush(); continue; }
    const heading = line.match(HEADING);
    if (heading) { flush(); blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] }); continue; }
    if (RULE.test(line)) { flush(); blocks.push({ type: 'rule' }); continue; }
    if (line.includes('|') && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      flush();
      const head = cellsOf(line);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim() !== ''; i++) rows.push(cellsOf(lines[i]));
      i--;
      blocks.push({ type: 'table', head, rows });
      continue;
    }
    const bullet = line.match(BULLET);
    const numbered = line.match(NUMBERED);
    if (bullet || numbered) {
      flush();
      const ordered = numbered !== null && bullet === null;
      const items = [];
      const start = ordered ? Number(numbered[2]) : 1;
      for (; i < lines.length; i++) {
        const b = lines[i].match(BULLET);
        const n = lines[i].match(NUMBERED);
        const item = ordered ? n : b;
        if (item) {
          const indent = item[1].length;
          items.push({ text: ordered ? item[3] : item[2], depth: indent >= 2 ? 1 : 0 });
        } else if (lines[i].trim() !== '' && /^\s+\S/.test(lines[i]) && items.length > 0 && !(b || n)) {
          items[items.length - 1].text += `\n${lines[i].trim()}`;
        } else {
          break;
        }
      }
      i--;
      blocks.push({ type: 'list', ordered, start, items });
      continue;
    }
    const quote = line.match(QUOTE);
    if (quote) {
      flush();
      const quoted = [];
      for (; i < lines.length && QUOTE.test(lines[i]); i++) quoted.push(lines[i].match(QUOTE)[1]);
      i--;
      blocks.push({ type: 'quote', text: quoted.join('\n') });
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

const INLINE = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|(?<![\w*])\*(?!\s)([\s\S]+?)(?<!\s)\*(?![\w*])|(?<![\w_])_(?!\s)([\s\S]+?)(?<!\s)_(?![\w_])|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/;

/**
 * Inline Markdown as runs: `{text}`, `{code}`, `{strong: runs}`, `{em: runs}`, `{link, href}`.
 * @param {string} text
 */
export function parseInline(text) {
  const runs = [];
  let rest = String(text);
  while (rest.length > 0) {
    const match = rest.match(INLINE);
    if (match === null) { runs.push({ text: rest }); break; }
    if (match.index > 0) runs.push({ text: rest.slice(0, match.index) });
    if (match[1] !== undefined) runs.push({ code: match[2] });
    else if (match[3] !== undefined || match[4] !== undefined) runs.push({ strong: parseInline(match[3] ?? match[4]) });
    else if (match[5] !== undefined || match[6] !== undefined) runs.push({ em: parseInline(match[5] ?? match[6]) });
    else runs.push({ link: match[7], href: match[8] });
    rest = rest.slice(match.index + match[0].length);
  }
  return runs;
}

function appendInline(doc, parent, text) {
  const lines = String(text).split('\n');
  lines.forEach((line, index) => {
    if (index > 0) parent.appendChild(doc.createElement('br'));
    for (const run of parseInline(line)) parent.appendChild(runNode(doc, run));
  });
}

function runNode(doc, run) {
  if (run.code !== undefined) {
    const code = doc.createElement('code');
    code.textContent = run.code;
    return code;
  }
  if (run.strong !== undefined || run.em !== undefined) {
    const element = doc.createElement(run.strong !== undefined ? 'strong' : 'em');
    for (const inner of run.strong ?? run.em) element.appendChild(runNode(doc, inner));
    return element;
  }
  if (run.link !== undefined) {
    const link = doc.createElement('a');
    link.href = run.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = run.link;
    return link;
  }
  return doc.createTextNode(run.text);
}

/**
 * One line of inline Markdown (emphasis, inline code, http(s) links) as
 * elements, text nodes only: the history's notes (History v2 §3.13) are
 * written in this subset.
 * @param {Document} doc
 * @param {string} text
 * @returns {DocumentFragment}
 */
export function renderInlineMarkdown(doc, text) {
  const fragment = doc.createDocumentFragment();
  appendInline(doc, fragment, text);
  return fragment;
}

/**
 * A reply as elements (a fragment), text nodes only.
 * @param {Document} doc
 * @param {string} text
 */
export function renderMarkdown(doc, text) {
  const fragment = doc.createDocumentFragment();
  for (const block of parseMarkdown(text)) fragment.appendChild(blockElement(doc, block));
  return fragment;
}

/**
 * A reply being streamed into `container`: `update(text)` with the whole
 * text so far draws it as `renderMarkdown` would, keeping the element of
 * every block that did not change (all but the last, while it grows).
 * @param {Document} doc
 * @param {HTMLElement} container
 */
export function createMarkdownStream(doc, container) {
  /** The blocks drawn, in order: {key, element}. */
  let drawn = [];
  return Object.freeze({
    update(text) {
      const blocks = parseMarkdown(text);
      const next = blocks.map((block, index) => {
        const key = JSON.stringify(block);
        return drawn[index]?.key === key ? drawn[index] : { key, element: blockElement(doc, block) };
      });
      next.forEach(({ element }, index) => {
        if (container.children[index] !== element) container.insertBefore(element, container.children[index] ?? null);
      });
      while (container.children.length > next.length) container.lastElementChild.remove();
      drawn = next;
    },
    /** Forget what was drawn (the reply ended). */
    clear() {
      drawn = [];
      container.replaceChildren();
    },
  });
}

/** One block (`parseMarkdown`) as its element. */
function blockElement(doc, block) {
  switch (block.type) {
    case 'heading': {
      const p = doc.createElement('p');
      p.className = 'agent-md-heading';
      appendInline(doc, p, block.text);
      return p;
    }
    case 'code': {
      const pre = doc.createElement('pre');
      pre.className = 'agent-md-code';
      const code = doc.createElement('code');
      code.textContent = block.text;
      pre.appendChild(code);
      return pre;
    }
    case 'list': {
      const list = doc.createElement(block.ordered ? 'ol' : 'ul');
      if (block.ordered && block.start !== 1) list.start = block.start;
      for (const item of block.items) {
        const li = doc.createElement('li');
        if (item.depth > 0) li.className = 'agent-md-nested';
        appendInline(doc, li, item.text);
        list.appendChild(li);
      }
      return list;
    }
    case 'quote': {
      const quote = doc.createElement('blockquote');
      appendInline(doc, quote, block.text);
      return quote;
    }
    case 'table': {
      const wrap = doc.createElement('div');
      wrap.className = 'agent-md-table';
      const table = doc.createElement('table');
      const head = doc.createElement('thead');
      const headRow = doc.createElement('tr');
      for (const cell of block.head) {
        const th = doc.createElement('th');
        appendInline(doc, th, cell);
        headRow.appendChild(th);
      }
      head.appendChild(headRow);
      const body = doc.createElement('tbody');
      for (const row of block.rows) {
        const tr = doc.createElement('tr');
        for (const cell of row) {
          const td = doc.createElement('td');
          appendInline(doc, td, cell);
          tr.appendChild(td);
        }
        body.appendChild(tr);
      }
      table.append(head, body);
      wrap.appendChild(table);
      return wrap;
    }
    case 'rule':
      return doc.createElement('hr');
    default: {
      const p = doc.createElement('p');
      appendInline(doc, p, block.text);
      return p;
    }
  }
}
