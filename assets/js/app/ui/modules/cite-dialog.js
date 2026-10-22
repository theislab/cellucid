/**
 * @fileoverview The Cite Cellucid dialog.
 *
 * Opened from the sidebar footer. The opener is a real link to the
 * documentation's "Citing Cellucid" page, so it still works if this module
 * never runs; here a click opens the dialog instead.
 *
 * The citation is read from the deployed `CITATION.cff` the first time the
 * dialog opens (see `app/citation.js`): the dialog never carries a copy that
 * could drift from it. While the citation has no DOI it is a placeholder, and
 * the dialog says so above the reference.
 *
 * @module ui/modules/cite-dialog
 */

import {
  CITATION_PATH,
  CITING_PAGE_URL,
  apa,
  apaParts,
  bibtex,
  parsePreferredCitation,
} from '../../citation.js';
import { copyWithFeedback, wireAppDialog } from '../components/app-dialog.js';

function requireById(ownerDocument, id) {
  const element = ownerDocument.getElementById(id);
  if (element === null) throw new TypeError(`Cite dialog requires #${id}.`);
  return element;
}

/**
 * Fill the dialog from one citation.
 *
 * @param {Document} ownerDocument
 * @param {ReturnType<typeof parsePreferredCitation>} citation
 */
export function renderCitation(ownerDocument, citation) {
  const placeholder = requireById(ownerDocument, 'cite-placeholder');
  const reference = requireById(ownerDocument, 'cite-reference');
  const bib = requireById(ownerDocument, 'cite-bibtex');
  placeholder.hidden = !citation.placeholder;
  if (citation.placeholder) {
    const strong = ownerDocument.createElement('strong');
    strong.textContent = 'Placeholder.';
    placeholder.replaceChildren(strong, ' The bioRxiv preprint is in preparation; no DOI yet.');
  } else {
    placeholder.replaceChildren();
  }
  const { before, journal, after } = apaParts(citation);
  const em = ownerDocument.createElement('em');
  em.textContent = journal;
  reference.replaceChildren(before, em, after);
  bib.textContent = bibtex(citation);
  bib.parentElement.hidden = false;
}

export function initCiteDialog({ ownerDocument = document, fetchText = null } = {}) {
  const dialog = requireById(ownerDocument, 'cite-dialog');
  const reference = requireById(ownerDocument, 'cite-reference');
  const copyReference = requireById(ownerDocument, 'cite-copy-reference');
  const copyBibtex = requireById(ownerDocument, 'cite-copy-bibtex');
  const openers = Array.from(ownerDocument.querySelectorAll('[data-cite-open]'));
  if (openers.length === 0) throw new TypeError('The Cite dialog has no opener.');
  const read = fetchText ?? (async () => {
    const response = await fetch(CITATION_PATH, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`CITATION.cff answered ${response.status}.`);
    return response.text();
  });

  const owner = wireAppDialog(dialog);
  const controller = new AbortController();
  let citation = null;
  let loading = null;

  function load() {
    if (citation !== null) return Promise.resolve(citation);
    loading ??= read()
      .then(text => {
        citation = parsePreferredCitation(text);
        renderCitation(ownerDocument, citation);
        copyReference.disabled = false;
        copyBibtex.disabled = false;
        return citation;
      })
      .catch(error => {
        loading = null;
        const link = ownerDocument.createElement('a');
        link.href = CITING_PAGE_URL;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'Citing Cellucid';
        reference.replaceChildren('The citation could not be loaded; see ', link, '.');
        console.error('[Cite] Could not read CITATION.cff:', error);
        return null;
      });
    return loading;
  }

  for (const opener of openers) {
    opener.addEventListener('click', event => {
      event.preventDefault();
      owner.open(opener);
      void load();
    }, { signal: controller.signal });
  }
  copyReference.addEventListener('click', () => {
    if (citation !== null) void copyWithFeedback(copyReference, apa(citation));
  }, { signal: controller.signal });
  copyBibtex.addEventListener('click', () => {
    if (citation !== null) void copyWithFeedback(copyBibtex, bibtex(citation));
  }, { signal: controller.signal });

  return {
    open() {
      owner.open();
      return load();
    },
    destroy() {
      controller.abort();
      owner.destroy();
    },
  };
}
