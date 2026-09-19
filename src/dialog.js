/**
 * In-app dialogs.
 *
 * Electron does not implement window.prompt() — it returns null without
 * showing anything, so a button wired to it silently does nothing. That is
 * what broke "Edit note", and it would have made the delete confirmation
 * impossible to complete in the desktop app.
 *
 * window.confirm() does work in Electron, but it is modal to the whole process
 * and looks nothing like the app, so anything with more than a yes/no answer
 * is built here instead.
 */
import { el, clear } from './dom.js';

function overlay(...children) {
  const root = el('div', { class: 'wizard-overlay' },
    el('div', { class: 'wizard' }, ...children));
  document.body.append(root);
  return root;
}

/**
 * A text prompt. Resolves with the text, or null if cancelled.
 * Escape cancels and Enter submits, because a dialog that traps you is worse
 * than no dialog.
 */
export function promptText({
  title, label, value = '', placeholder = '', multiline = false,
  confirmLabel = 'Save', hint = '',
}) {
  return new Promise((resolve) => {
    const input = multiline
      ? el('textarea', { rows: 5, placeholder, value })
      : el('input', { type: 'text', placeholder, value });

    let root;
    const finish = (result) => {
      document.removeEventListener('keydown', onKey, true);
      root.remove();
      resolve(result);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
      if (e.key === 'Enter' && !multiline) { e.preventDefault(); finish(input.value); }
    };
    document.addEventListener('keydown', onKey, true);

    root = overlay(
      el('div', { class: 'wizard-head' }, el('h2', {}, title)),
      el('div', { class: 'wizard-body' },
        label ? el('label', { class: 'field-label' }, label) : null,
        input,
        hint ? el('p', { class: 'wizard-hint' }, hint) : null,
      ),
      el('div', { class: 'wizard-actions' },
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => finish(null) }, 'Cancel'),
        el('button', {
          class: 'btn btn-primary', type: 'button', onclick: () => finish(input.value),
        }, confirmLabel),
      ),
    );

    input.focus();
    input.select?.();
  });
}

/**
 * A confirmation that has to be typed out.
 *
 * For something with no undo and no copy anywhere else, a single click is too
 * easy to make by accident.
 */
export function confirmTyped({ title, body, word = 'DELETE', confirmLabel = 'Delete' }) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'text', placeholder: word, autocomplete: 'off' });
    const button = el('button', { class: 'btn btn-danger', type: 'button', disabled: true },
      confirmLabel);

    let root;
    const finish = (ok) => {
      document.removeEventListener('keydown', onKey, true);
      root.remove();
      resolve(ok);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    };
    document.addEventListener('keydown', onKey, true);

    // The button stays dead until the word matches, so the dialog cannot be
    // dismissed into a deletion by hammering Enter.
    input.addEventListener('input', () => {
      button.disabled = input.value.trim().toUpperCase() !== word;
    });
    button.addEventListener('click', () => finish(true));

    root = overlay(
      el('div', { class: 'wizard-head' }, el('h2', {}, title)),
      el('div', { class: 'wizard-body' },
        el('pre', { class: 'confirm-body' }, body),
        el('label', { class: 'field-label' }, `Type ${word} to confirm`),
        input,
      ),
      el('div', { class: 'wizard-actions' },
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => finish(false) }, 'Cancel'),
        button,
      ),
    );
    input.focus();
  });
}
