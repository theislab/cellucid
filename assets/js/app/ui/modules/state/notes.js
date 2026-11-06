/**
 * @fileoverview Notes on a step, a branch, a group, a turn or the tracker
 * (History v2 §3.13): each with its author and time ("edited" once edited),
 * its text in the Markdown subset (emphasis, inline code, http(s) links)
 * built from text nodes only, Edit and Remove, and "+ Note". Every change is
 * a history action (`history.note.add`, `.edit`, `.remove`), kept in the
 * tracker's journal, so it is undone from the toast or Recently deleted;
 * Ctrl+Z stays for the state.
 *
 * The person may edit or remove any note; an agent only its own (the core
 * refuses it, §5 #30).
 *
 * @module ui/modules/state/notes
 */

import { authorOf, formatStepTime } from './model.js';
import { renderInlineMarkdown } from '../../../agent/chat/markdown.js';

/**
 * @param {object} options
 * @param {Document} options.doc
 * @param {object[]} options.notes - the target's `Note` records
 * @param {object} options.target - `{step}`, `{branch}`, `{group}`, `{turn}` or `{tracker}`
 * @param {(type: string, params: object) => Promise<unknown>} options.act
 * @param {() => number} options.now
 * @param {string} [options.addLabel]
 * @returns {HTMLElement}
 */
export function notesBlock({ doc, notes, target, act, now, addLabel = 'Note' }) {
  const root = doc.createElement('div');
  root.className = 'history-notes';
  const list = doc.createElement('ul');
  list.className = 'history-note-list';
  list.hidden = notes.length === 0;
  for (const note of notes) list.append(noteItem(doc, note, { act, now }));
  const add = doc.createElement('button');
  add.type = 'button';
  add.className = 'btn btn-compact history-note-add';
  add.textContent = `+ ${addLabel}`;
  add.addEventListener('click', () => {
    add.hidden = true;
    root.append(editor(doc, {
      value: '',
      label: 'New note',
      save: text => act('history.note.add', { target, text }),
      done: () => { add.hidden = false; add.focus(); },
    }));
  });
  root.append(list, add);
  return root;
}

function noteItem(doc, note, { act, now }) {
  const item = doc.createElement('li');
  item.className = 'history-note';
  item.dataset.noteId = note.id;
  const text = doc.createElement('p');
  text.className = 'history-note-text';
  text.append(renderInlineMarkdown(doc, note.text));
  const meta = doc.createElement('span');
  meta.className = 'history-note-meta';
  const author = authorOf(note.by, null);
  const when = note.at === null ? '' : `, ${formatStepTime(note.at, now())}`;
  meta.textContent = `— ${author.name}${when}${note.editedAt !== null ? ', edited' : ''}${note.fromReply ? ', from the reply' : ''}`;
  const edit = doc.createElement('button');
  edit.type = 'button';
  edit.className = 'btn btn-compact history-note-edit';
  edit.textContent = 'Edit';
  edit.setAttribute('aria-label', `Edit the note “${note.text}”`);
  const remove = doc.createElement('button');
  remove.type = 'button';
  remove.className = 'btn btn-compact history-note-remove';
  remove.textContent = 'Remove';
  remove.setAttribute('aria-label', `Remove the note “${note.text}”`);
  edit.addEventListener('click', () => {
    item.replaceChildren(editor(doc, {
      value: note.text,
      label: 'Edit the note',
      save: next => act('history.note.edit', { note: note.id, text: next }),
      done: () => {},
    }));
  });
  remove.addEventListener('click', () => void act('history.note.remove', { note: note.id }));
  item.append(text, meta, edit, remove);
  return item;
}

/** A note's text field with Save and Cancel; Ctrl/⌘+Enter saves, Escape cancels. */
function editor(doc, { value, label, save, done }) {
  const form = doc.createElement('div');
  form.className = 'history-note-editor';
  const area = doc.createElement('textarea');
  area.className = 'obs-select history-note-input';
  area.rows = 3;
  area.value = value;
  area.setAttribute('aria-label', label);
  area.placeholder = 'Markdown: *emphasis*, `code`, [links](https://…)';
  const row = doc.createElement('div');
  row.className = 'app-dialog-actions';
  const ok = doc.createElement('button');
  ok.type = 'button';
  ok.className = 'btn btn-compact btn-primary';
  ok.textContent = 'Save';
  const cancel = doc.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-compact';
  cancel.textContent = 'Cancel';
  row.append(cancel, ok);
  form.append(area, row);
  const close = () => {
    const host = form.parentElement;
    form.remove();
    done();
    // The row's details kept still while it was open (`graph.js`): they may be built again now.
    host?.dispatchEvent(new CustomEvent('history-editor-closed', { bubbles: true }));
  };
  const commit = async () => {
    const text = area.value.trim();
    if (text.length === 0) {
      area.focus();
      return;
    }
    ok.disabled = true;
    try {
      await save(text);
    } finally {
      ok.disabled = false;
    }
    close();
  };
  ok.addEventListener('click', () => void commit());
  cancel.addEventListener('click', close);
  area.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void commit();
    }
  });
  queueMicrotask(() => area.focus());
  return form;
}
