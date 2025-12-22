/**
 * @fileoverview Post-export citation modal.
 *
 * Shown after successful exports (unless the user opts out) to encourage
 * attribution and improve reproducibility.
 *
 * @module ui/modules/figure-export/components/citation-modal
 */

import { createElement } from '../../../../utils/dom-utils.js';
import { showFigureExportModal } from './modal.js';

const STORAGE_KEY = 'cellucid:figure-export:hide-citation';

function getHidePreference() {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function setHidePreference(value) {
  try {
    localStorage.setItem(STORAGE_KEY, value ? 'true' : 'false');
  } catch {
    // ignore
  }
}

async function copyText(text) {
  const value = String(text || '');
  if (!value) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // fall back
  }

  const ta = document.createElement('textarea');
  ta.value = value;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  try {
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    document.body.removeChild(ta);
    return false;
  }
}

/**
 * @param {object} options
 * @param {string|null} [options.datasetName]
 * @param {string|null} [options.fieldKey]
 * @param {string|null} [options.viewLabel]
 * @param {string|null} [options.filename]
 */
export function maybeShowCitationModal({ datasetName = null, fieldKey = null, viewLabel = null, filename = null } = {}) {
  if (getHidePreference()) return;

  const sourceLabel = datasetName ? `Dataset: ${datasetName}` : null;
  const fieldLabel = fieldKey ? `Field: ${fieldKey}` : null;
  const viewLine = viewLabel ? `View: ${viewLabel}` : null;
  const fileLine = filename ? `File: ${filename}` : null;

  const details = [sourceLabel, fieldLabel, viewLine, fileLine].filter(Boolean).join(' • ');
  const now = new Date().toISOString();

  const plain = [
    'Figure created with Cellucid.',
    'https://cellucid.io',
    details ? `(${details})` : null
  ].filter(Boolean).join(' ');

  const bibNote = `Figure exported ${now}${details ? `; ${details}` : ''}`;
  const bib = `@software{cellucid,
  title        = {Cellucid},
  url          = {https://cellucid.io},
  note         = {${bibNote}}
}`;

  const content = createElement('div', {}, [
    createElement('div', { className: 'legend-help' }, [
      'Citing Cellucid helps sustain the project and makes figures reproducible.'
    ]),

    createElement('div', { className: 'control-block figure-export-divider' }, [
      createElement('label', {}, ['Plain text:']),
      createElement('pre', { className: 'figure-export-codeblock' }, [plain]),
      createElement('button', {
        type: 'button',
        className: 'btn-small',
        onClick: async () => { await copyText(plain); }
      }, ['Copy'])
    ]),

    createElement('div', { className: 'control-block' }, [
      createElement('label', {}, ['BibTeX:']),
      createElement('pre', { className: 'figure-export-codeblock' }, [bib]),
      createElement('button', {
        type: 'button',
        className: 'btn-small',
        onClick: async () => { await copyText(bib); }
      }, ['Copy'])
    ]),

    createElement('label', { className: 'checkbox-inline figure-export-divider' }, [
      createElement('input', {
        type: 'checkbox',
        onChange: (e) => setHidePreference(e.target.checked)
      }),
      ' Don’t show this again'
    ])
  ]);

  const actions = createElement('div', { className: 'figure-export-modal-actions' }, [
    createElement('button', { type: 'button', className: 'btn-small' }, ['Close'])
  ]);
  content.appendChild(actions);

  const { close } = showFigureExportModal({
    title: 'Cite Your Figure',
    content,
  });

  actions.querySelector('button')?.addEventListener('click', close);
}
