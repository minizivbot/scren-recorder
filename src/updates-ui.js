/**
 * The visible half of self-update.
 *
 * The main process does the work; this only reports it. Two surfaces:
 * a row in Settings that is always accurate, and a banner that appears once an
 * update is actually ready to install — nothing earlier, because a download in
 * progress is not something anyone needs to act on.
 */
import { STATUS, updateMessage } from './update-policy.js';

const $ = (sel) => document.querySelector(sel);

/** Dismissing the banner should last the session, not forever. */
let dismissedVersion = null;

export function renderUpdateState(state) {
  const panel = $('#update-panel');
  if (!panel) return;
  panel.hidden = false;

  $('#update-current').textContent = state.currentVersion || '—';

  const message = updateMessage(state);
  $('#update-status').textContent = message || '';

  const ready = state.status === STATUS.READY || state.status === STATUS.WAITING;
  $('#btn-install-update').hidden = !ready;
  // Nothing to restart into while a session is live; the message says so.
  $('#btn-install-update').disabled = state.status === STATUS.WAITING;

  const bar = $('#update-bar');
  const downloading = state.status === STATUS.DOWNLOADING;
  bar.hidden = !downloading;
  if (downloading) $('#update-bar-fill').style.width = `${Math.round(state.percent || 0)}%`;

  renderBanner(state);
}

function renderBanner(state) {
  const banner = $('#update-banner');
  if (!banner) return;

  const ready = state.status === STATUS.READY || state.status === STATUS.WAITING;
  const show = ready && state.version && state.version !== dismissedVersion;
  banner.hidden = !show;
  if (!show) return;

  $('#update-banner-text').textContent = updateMessage(state);
  // While recording, restarting is exactly the wrong thing to offer.
  $('#btn-banner-install').hidden = state.status === STATUS.WAITING;
}

export function wireUpdates() {
  const api = globalThis.desktop?.updates;
  if (!api) return; // Browser build: nothing to update.

  $('#btn-check-update').addEventListener('click', async () => {
    $('#update-status').textContent = 'Checking for updates…';
    renderUpdateState(await api.check());
  });

  $('#btn-install-update').addEventListener('click', () => api.installNow());
  $('#btn-banner-install').addEventListener('click', () => api.installNow());

  $('#btn-banner-dismiss').addEventListener('click', async () => {
    const state = await api.state();
    dismissedVersion = state.version;
    $('#update-banner').hidden = true;
  });

  api.onState(renderUpdateState);
  api.state().then(renderUpdateState).catch(() => {});
}
