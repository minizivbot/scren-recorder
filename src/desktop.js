/**
 * Desktop-app behaviour, loaded only when running inside Electron.
 *
 * Two jobs:
 *  - Global shortcuts arrive from the OS, so marking works while Tradovate has
 *    focus. No AutoHotkey, no local HTTP bridge, no tab that must stay focused.
 *  - A screen picker, because Electron has no built-in share dialog. The
 *    recorder core still just calls getDisplayMedia; this answers it.
 */
import { el, clear } from './dom.js';

export function isDesktop() {
  return typeof window !== 'undefined' && window.desktop?.isDesktop === true;
}

/**
 * Shows the screen/window picker and resolves with the chosen source.
 *
 * This runs while getDisplayMedia is pending, which is why it cannot be a
 * confirm() — the page has to stay responsive to keep the request alive.
 */
function showPicker(sources) {
  return new Promise((resolve) => {
    const overlay = el('div', { class: 'picker-overlay' });

    const finish = (id) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(id);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') finish(null);
    };
    document.addEventListener('keydown', onKey);

    const screens = sources.filter((s) => s.kind === 'screen');
    const windows = sources.filter((s) => s.kind === 'window');

    const grid = (list) => el('div', { class: 'picker-grid' },
      ...list.map((s) => el('button', {
        class: 'picker-item',
        type: 'button',
        onclick: () => finish(s.id),
      },
        el('img', { src: s.thumbnail, alt: '' }),
        el('span', { class: 'picker-name', title: s.name }, s.name),
      )),
    );

    overlay.append(el('div', { class: 'picker' },
      el('div', { class: 'picker-head' },
        el('h2', {}, 'What should be recorded?'),
        el('p', { class: 'muted' },
          'Pick the screen your charts are on. The whole session is recorded continuously — '
          + 'nothing is cut, so you can always scrub back.'),
      ),
      screens.length ? el('h3', { class: 'picker-group' }, 'Screens') : null,
      screens.length ? grid(screens) : null,
      windows.length ? el('h3', { class: 'picker-group' }, 'Windows') : null,
      windows.length ? grid(windows) : null,
      el('div', { class: 'picker-actions' },
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => finish(null) }, 'Cancel'),
      ),
    ));

    document.body.append(overlay);
  });
}

/**
 * Wires the desktop app up.
 *
 * `onCommand` receives the same shape the local bridge sends in the browser
 * version, so the app handles a hotkey identically either way.
 */
export async function initDesktop({ onCommand, onShortcuts }) {
  if (!isDesktop()) return null;

  document.body.dataset.desktop = 'true';

  window.desktop.onPickSource(async (sources) => {
    const id = await showPicker(sources);
    await window.desktop.pickSource(id);
  });

  window.desktop.onHotkey((payload) => onCommand?.(payload));

  const info = await window.desktop.info();
  return { info, registerShortcuts: (s) => registerAndReport(s, onShortcuts) };
}

/**
 * Registers shortcuts and reports which ones the OS refused.
 *
 * A combination another application already owns silently fails to register.
 * Surfacing that matters more here than anywhere else: you would otherwise
 * discover it mid-trade, or worse, at review time.
 */
async function registerAndReport(shortcuts, onShortcuts) {
  const result = await window.desktop.registerShortcuts(shortcuts);
  onShortcuts?.(result);
  return result;
}

/** Accelerator strings for Electron, from the app's own settings shape. */
export function toAccelerators(hotkeys) {
  return {
    entry: `Control+Alt+${hotkeys.entry.toUpperCase()}`,
    exit: `Control+Alt+${hotkeys.exit.toUpperCase()}`,
    note: `Control+Alt+${hotkeys.note.toUpperCase()}`,
    long: 'Control+Alt+L',
    short: 'Control+Alt+S',
    stop: 'Control+Alt+Q',
  };
}
