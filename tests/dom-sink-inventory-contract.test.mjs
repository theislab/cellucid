/**
 * Every place the web app's code hands a string to a parser that can run it
 * (HTML, a URL a link or a script opens, code) is listed here with why what
 * reaches it is safe, and no other exists (round 8 security lens). A
 * dataset's own text (obs and var names, categories, `uns`, file names),
 * session and history text, notes, community annotations and agent replies
 * reach the page as text nodes (`textContent`, `createTextNode`, the chat's
 * Markdown as elements, `agent/chat/markdown.js`); where HTML is built, every
 * value in it is escaped (`utils/dom-utils.js` `escapeHtml`) or a constant;
 * a link the data names is an http(s) one (`anndata-cellucid-metadata.js`
 * `requireUrl`, `renderFactList`, `markdown.js` `parseInline`).
 *
 * A new sink fails this test with its file and line: build the elements
 * instead (`textContent`, `replaceChildren`), or escape every value in the
 * markup and add the line here with the reason. An entry whose line is gone
 * fails too, so the list stays the code's.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../assets/js/', import.meta.url));

/** What a string can become at each sink. */
const SINKS = Object.freeze([
  ['html', /\.(?:innerHTML|outerHTML)\s*\+?=(?!=)(?!\s*(?:''|""|``)\s*;)/],
  ['html', /\binsertAdjacentHTML\s*\(|\bcreateContextualFragment\s*\(|\b(?:set|parse)HTMLUnsafe\s*\(|\bDOMParser\b|\.srcdoc\s*=(?!=)/],
  ['html', /\bdocument\.write(?:ln)?\s*\(/],
  ['code', /\bnew Function\s*\(|(?<![\w.$])eval\s*\(|\bsetAttribute\(\s*['"]on|\bimportScripts\s*\((?!\))/i],
  ['url', /(?<!this)\.(?:href|src)\s*=(?!=)|\bsetAttribute\(\s*['"](?:href|src|action|formaction|xlink:href)['"]|\b(?:window|globalThis|win)\.open\s*\((?!\))|\blocation\.(?:assign|replace)\s*\((?!\))/],
]);

/** Why what reaches the sinks after it is safe. */
const why = text => Object.freeze({ why: text });
const CONSTANT = why('constant markup');

/** file → [why(…), …the sink lines it explains (trimmed), one per occurrence; another why(…), …] */
const ALLOWED = Object.freeze({
  'app/agent/chat/index.js': [why('the provider\'s own "Get a key" page (providers/*.js keyUrl, a constant)'),
    'dom.keyLink.href = chosen.keyUrl;'],
  'app/agent/chat/markdown.js': [why('an agent reply\'s link, only when http(s) (parseInline matches https?:// only)'),
    'link.href = run.href;'],
  'app/agent/presence/index.js': [CONSTANT,
    'header.innerHTML = \'<span class="disclosure-title">Details</span><span class="disclosure-chevron" aria-hidden="true"></span>\';'],
  'app/analysis/comparison-module.js': [why('the analysis modes\' titles and tips: constants of ANALYSIS_SECTIONS'),
    'list.innerHTML = section.modes.map(modeRow).join(\'\');'],
  'app/analysis/plots/plotly-loader.js': [why('the app\'s own Plotly file'),
    'script.src = versionedAssetUrl(\'external/plotly.min.js\');'],
  'app/analysis/ui/analysis-types/base/form-based-analysis.js': [CONSTANT,
    'container.innerHTML = \'<p class="empty-state">Statistics not available</p>\';',
    'container.innerHTML = \'<p class="empty-state">Statistical analysis not available</p>\';'],
  'app/analysis/ui/analysis-types/composition-ui.js': [why('labels and values escaped (escapeHtml); the table\'s cells are formatted numbers and escaped names'),
    'container.innerHTML = `<table class="analysis-stats-table">${rows.map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td><strong>${escapeHtml(value)}</strong></td></tr>`).join(\'\')}</table>`;',
    'container.innerHTML = conditions.length < 2'],
  'app/analysis/ui/analysis-types/correlation-analysis-ui.js': [CONSTANT,
    'container.innerHTML = \'<p class="empty-state">Statistics not available</p>\';',
    'container.innerHTML = \'<p class="empty-state">No correlation results</p>\';'],
  'app/analysis/ui/analysis-types/de-analysis-ui.js': [CONSTANT,
    'container.innerHTML = \'<p class="empty-state">Statistics not available</p>\';',
    'table.innerHTML = \'<thead><tr><th>Gene</th><th>Score</th><th>log2FC</th><th>adj p</th><th>% A</th><th>% B</th></tr></thead>\';'],
  'app/analysis/ui/analysis-types/detailed-analysis-ui.js': [why('constant text naming a place (PLACES, a constant)'),
    'this._controlsContainer.innerHTML = `'],
  'app/analysis/ui/analysis-types/dotplot-ui.js': [why('labels and values escaped (escapeHtml), or constant'),
    'container.innerHTML = `<table class="analysis-stats-table">${rows.map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td><strong>${escapeHtml(value)}</strong></td></tr>`).join(\'\')}</table>`;',
    'container.innerHTML = \'<p class="empty-state">Dot color: mean expression in the group. Dot size: share of the group\\\'s cells expressing the gene.</p>\';'],
  'app/analysis/ui/analysis-types/gene-signature-ui.js': [CONSTANT,
    'container.innerHTML = \'<p class="empty-state">Statistics not available</p>\';',
    'container.innerHTML = \'<p class="empty-state">No annotations available</p>\';'],
  'app/analysis/ui/analysis-types/quick-insights-ui.js': [CONSTANT, 'thead.innerHTML = `'],
  'app/analysis/ui/components/modal.js': [CONSTANT, 'closeBtn.innerHTML = \'×\';'],
  'app/analysis/ui/components/stats-display.js': [CONSTANT, 'legend.innerHTML = `'],
  'app/community-annotations/github-auth.js': [why('the Worker\'s own sign-in address (its origin pinned, getGitHubLoginUrl)'),
    'window.location.assign(url.toString());'],
  'app/main.js': [why('a picture of the app\'s own canvas'), 'still.src = canvas.toDataURL(\'image/png\');'],
  'app/notification-center.js': [why('title, message, details and action labels escaped (escapeHtml); the icon a constant of CategoryIcons'),
    'el.innerHTML = html;',
    'holder.innerHTML = notificationDetailsHtml(options.details);'],
  'app/source-sign-in-view.js': [why('a provider\'s help page (provider-config.js, a constant)'), 'help.href = link.url;'],
  'app/startup-failure.js': [why('the app\'s own addresses and help links (constants of the failure page)'),
    'row.setAttribute(\'href\', href);',
    'logo.setAttribute(\'src\', \'assets/img/cellucid-logo.svg\');',
    'link.setAttribute(\'href\', href);'],
  'app/ui/category-builder/dom.js': [CONSTANT, 'wrapper.innerHTML = TEMPLATE;'],
  'app/ui/components/confirm-dialog.js': [why('title, input value, option label and button texts escaped (escapeHtml); the message set as text after'),
    'dialog.innerHTML = `'],
  'app/ui/components/controls.js': [why('an icon: the callers\' constant SVG markup'),
    'button.innerHTML = icon.startsWith(\'<svg \') && !icon.includes(\'aria-hidden\')',
    why('a fact\'s link: only an http(s) address is one (renderFactList)'),
    'link.href = row.href;'],
  'app/ui/components/info-tips.js': [why('the docs site (docsUrl)'), 'anchor.href = docsUrl(link);'],
  'app/ui/core/code-load-watch.js': [why('this page and the docs site'),
    'logo.src = \'assets/img/cellucid-logo.svg\';',
    'retry.href = location.pathname + location.search;',
    'guide.href = \'https://docs.cellucid.com/en/latest/user_guide/web_app/q_troubleshooting_index/index.html\';'],
  'app/ui/core/ga-init.js': [why('the Google tag on the production hosts only (a constant address)'), 'script.src ='],
  'app/ui/core/preconnect-init.js': [why('an origin only (URL.origin), as a preconnect hint'), 'link.href = origin;'],
  'app/ui/modules/cinematic-camera/index.js': [why('keyframe labels (session text) and ids escaped (escapeHtml); icons constant'),
    'listEl.innerHTML = \'<p class="empty-state">No keyframes saved yet.</p>\';',
    'listEl.innerHTML = html;'],
  'app/ui/modules/cinematic-camera/transport-bar.js': [CONSTANT,
    'barEl.innerHTML = `',
    'playBtn.innerHTML = ICON_PAUSE;',
    'playBtn.innerHTML = ICON_PLAY;'],
  'app/ui/modules/cite-dialog.js': [why('the docs site'), 'link.href = CITING_PAGE_URL;'],
  'app/ui/modules/community-annotation/browser-integration.js': [why('an exact https address only (openExternalUrl), in a window cut from this one'),
    'const opened = window.open(\'about:blank\', \'_blank\');',
    'opened.location.replace(parsed.toString());'],
  'app/ui/modules/field-selector-gene-expression.js': [why('the docs site'), 'help.href = GENE_PANEL_HELP_URL;'],
  'app/ui/modules/highlight/annotation-selection.js': [why('counts formatted, constant tags; notices one of SELECTION_NOTICE (requireSelectionNotice)'),
    'highlightModeDescriptionEl.innerHTML = idleSelectionNoticeHtml(notice);',
    'highlightModeDescriptionEl.innerHTML = `${stepInfo}${noticeHtml}`;',
    'highlightModeDescriptionEl.innerHTML = `${stepInfo}${noticeHtml}`;'],
  'app/ui/modules/highlight/highlight-pages-ui.js': [CONSTANT, 'deleteBtn.innerHTML = \'×\';'],
  'app/ui/modules/highlight/knn-selection.js': [why('counts formatted, constant tags; notices one of SELECTION_NOTICE'),
    'highlightModeDescriptionEl.innerHTML = idleSelectionNoticeHtml(notice);',
    'highlightModeDescriptionEl.innerHTML = `${stepInfo}${noticeHtml}`;',
    'highlightModeDescriptionEl.innerHTML = `${stepInfo}${noticeHtml}`;'],
  'app/ui/modules/highlight/lasso-selection.js': [why('counts formatted, constant tags; notices one of SELECTION_NOTICE'),
    'highlightModeDescriptionEl.innerHTML = idleSelectionNoticeHtml(notice);',
    'highlightModeDescriptionEl.innerHTML = `${stepInfo}${noticeHtml}`;',
    'highlightModeDescriptionEl.innerHTML = `${stepInfo}${noticeHtml}`;'],
  'app/ui/modules/highlight/proximity-selection.js': [why('counts formatted, constant tags; notices one of SELECTION_NOTICE'),
    'highlightModeDescriptionEl.innerHTML = idleSelectionNoticeHtml(notice);',
    'highlightModeDescriptionEl.innerHTML = `${stepInfo}${noticeHtml}`;',
    'highlightModeDescriptionEl.innerHTML = `${stepInfo}${noticeHtml}`;'],
  'app/ui/modules/highlight/step-controls.js': [why('constant buttons; the tool name one of the selection tools'), 'controls.innerHTML = `'],
  'app/ui/modules/state/graph.js': [why('the history rows\' icons: constants (DETAILS_ICON, MORE_ICON, …); labels set as attributes'), 'button.innerHTML = html;'],
  'app/ui/modules/state/share.js': [why('the printable report (history/exports/report.js): every text escaped (esc), in a window of its own'),
    'win.document.write(html);',
    'const win = globalThis.open(\'\', \'_blank\');'],
  'app/ui/modules/state/tour.js': [why('constant icons (STATE_ICONS)'),
    'b.innerHTML = icon;',
    'session.ui.pause.innerHTML = session.paused ? STATE_ICONS.play : STATE_ICONS.pause;'],
  'app/utils/download.js': [why('a blob address this page made'), 'anchor.href = url;'],
  'data/sources/auth/google.js': [why('Google\'s sign-in scripts (GIS_SCRIPT_URL, GAPI_SCRIPT_URL constants)'), 'script.src = url;'],
  'data/sources/auth/microsoft.js': [why('Microsoft\'s sign-in page (authorizeUrl: the tenant\'s constant address), in a popup of its own'),
    'const popup = win.open(\'\', SIGN_IN_WINDOW, SIGN_IN_WINDOW_FEATURES);',
    'popup.location.replace(authorizeUrl(more, pkce));'],
  'dev/benchmark.js': [why('the developer benchmark panel: numbers and constant styles only'),
    'panel.innerHTML = `',
    'panel.innerHTML = `'],
});

const walk = dir => readdirSync(dir).flatMap(name => {
  const file = path.join(dir, name);
  return statSync(file).isDirectory() ? walk(file) : file.endsWith('.js') ? [file] : [];
});

/** Every sink of the code: `file\tline` → occurrences. */
function sinksOfCode() {
  const found = new Map();
  for (const file of walk(ROOT)) {
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const text = line.trim();
      if (text.startsWith('*') || text.startsWith('//') || text.startsWith('/*')) continue;
      if (!SINKS.some(([, pattern]) => pattern.test(line))) continue;
      const key = `${relative}\t${text}`;
      found.set(key, (found.get(key) ?? 0) + 1);
    }
  }
  return found;
}

/** The allowed sinks: `file\tline` → occurrences (each entry's strings after its reasons). */
function allowedSinks() {
  const allowed = new Map();
  for (const [file, entries] of Object.entries(ALLOWED)) {
    let lines = 0;
    assert.equal(typeof entries[0]?.why, 'string', `${file}: the list starts with why its sinks are safe`);
    for (const entry of entries) {
      if (typeof entry !== 'string') continue;
      lines++;
      const key = `${file}\t${entry}`;
      allowed.set(key, (allowed.get(key) ?? 0) + 1);
    }
    assert.ok(lines > 0, `${file}: an entry needs its sink lines`);
  }
  return allowed;
}

test('every place a string can become HTML, code or an address opened is one this list explains', () => {
  const found = sinksOfCode();
  const allowed = allowedSinks();
  const unexplained = [...found].filter(([key, count]) => (allowed.get(key) ?? 0) < count)
    .map(([key, count]) => `${key.replace('\t', ': ')} (${count - (allowed.get(key) ?? 0)} not listed)`);
  assert.deepEqual(unexplained, [], 'Build elements with textContent, or escape every value (escapeHtml) and list the line with why it is safe');
  const stale = [...allowed].filter(([key, count]) => (found.get(key) ?? 0) < count).map(([key]) => key.replace('\t', ': '));
  assert.deepEqual(stale, [], 'These listed sinks are gone: remove them from the list');
});

test('the list finds what it looks for (a new sink of each kind is caught)', () => {
  const caught = line => SINKS.some(([, pattern]) => pattern.test(line));
  for (const line of [
    'el.innerHTML = name;', 'el.innerHTML += `<b>${x}</b>`;', 'el.outerHTML = s;', 'el.insertAdjacentHTML(\'beforeend\', s);',
    'range.createContextualFragment(s)', 'new DOMParser().parseFromString(s, \'text/html\')', 'frame.srcdoc = s;',
    'doc.document.write(s);', 'document.write(s)', 'new Function(s)', 'eval(s)', 'el.setAttribute(\'onclick\', s)',
    'a.href = url;', 'img.src = url;', 'a.setAttribute(\'href\', url)', 'window.open(url)', 'location.assign(url)',
  ]) assert.equal(caught(line), true, line);
  for (const line of ['el.innerHTML = \'\';', 'el.innerHTML = "";', 'el.textContent = s;', 'this.src = src;', 'if (a.href === b)']) {
    assert.equal(caught(line), false, line);
  }
});
