/**
 * Self-update.
 *
 * Downloading a 100 MB installer by hand every time a fix lands is not a thing
 * anyone keeps doing, so the app does it: it checks on its own, downloads in
 * the background, and swaps itself on the next close.
 *
 * Two deliberate choices:
 *
 *  1. **It never installs while recording.** The installer has to quit the app
 *     to replace the binary. Doing that mid-session would cut the recording,
 *     and a trading morning cannot be re-recorded. A ready update waits for as
 *     long as it takes — see src/update-policy.js.
 *
 *  2. **It installs on close, not by interrupting.** No modal in the middle of
 *     a session asking to restart now.
 *
 * Updates also sidestep SmartScreen entirely: it warns on a file you
 * downloaded from a browser, and these do not come through a browser. So the
 * warning is a once-per-machine event even though the app keeps changing.
 */
import { app } from 'electron';
import electronUpdater from 'electron-updater';
import {
  STATUS,
  updateSupport,
  installDecision,
  shouldCheck,
  CHECK_INTERVAL_MS,
} from '../src/update-policy.js';

const { autoUpdater } = electronUpdater;

let state = { status: STATUS.IDLE, version: null, percent: 0, error: null, reason: null };
let lastCheckAt = 0;
let timer = null;
let notify = () => {};
let isRecording = () => false;

function set(next) {
  state = { ...state, ...next };
  try {
    notify(state);
  } catch {
    // A closed window is not an error worth crashing the updater over.
  }
}

export function getUpdateState() {
  return { ...state, currentVersion: app.getVersion() };
}

/**
 * Starts the updater.
 *
 * @param {object} options
 * @param {(state: object) => void} options.onState  called on every change
 * @param {() => boolean} options.recording          true while capturing
 */
export function initUpdater({ onState, recording } = {}) {
  notify = onState || notify;
  isRecording = recording || isRecording;

  const support = updateSupport({ packaged: app.isPackaged, execPath: process.execPath });
  if (!support.supported) {
    set({ status: STATUS.UNSUPPORTED, reason: support.reason });
    return { check: async () => getUpdateState(), installNow: () => false };
  }

  // We install on quit ourselves, at a moment we choose, rather than letting
  // the library pick one.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => set({ status: STATUS.CHECKING, error: null }));
  autoUpdater.on('update-not-available', () => set({ status: STATUS.CURRENT, error: null }));
  autoUpdater.on('update-available', (info) =>
    set({ status: STATUS.AVAILABLE, version: info?.version, percent: 0, error: null }));
  autoUpdater.on('download-progress', (p) =>
    set({ status: STATUS.DOWNLOADING, percent: p?.percent || 0 }));

  autoUpdater.on('update-downloaded', (info) => {
    const decision = installDecision({ downloaded: true, recording: isRecording() });
    set({
      status: decision.action === 'wait' ? STATUS.WAITING : STATUS.READY,
      version: info?.version,
      percent: 100,
      reason: decision.reason,
    });
  });

  autoUpdater.on('error', (err) => {
    // Offline is the common case and is not worth alarming anyone about, but
    // it should still be visible in settings rather than swallowed.
    set({ status: STATUS.ERROR, error: String(err?.message || err) });
  });

  // Not on the startup path: the first thing the app should do is open, not
  // talk to the network. Thirty seconds in, nobody is waiting on it.
  setTimeout(() => void check(), 30_000);
  timer = setInterval(() => void check(), CHECK_INTERVAL_MS);

  return { check, installNow };
}

/** Asks the server. `force` skips the interval, for the Settings button. */
export async function check(force = false) {
  const support = updateSupport({ packaged: app.isPackaged, execPath: process.execPath });
  if (!support.supported) return getUpdateState();
  if (!force && !shouldCheck({ lastCheckAt, now: Date.now(), supported: true })) {
    return getUpdateState();
  }
  lastCheckAt = Date.now();
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    set({ status: STATUS.ERROR, error: String(err?.message || err) });
  }
  return getUpdateState();
}

/**
 * Installs a downloaded update now, if it is safe to.
 *
 * Returns false and leaves it downloaded when a session is recording — the
 * caller should show why rather than treating it as a failure.
 */
export function installNow() {
  const decision = installDecision({
    downloaded: state.status === STATUS.READY || state.status === STATUS.WAITING,
    recording: isRecording(),
    userAsked: true,
  });
  if (decision.action !== 'install') {
    set({ status: state.status, reason: decision.reason });
    return false;
  }
  // isSilent, isForceRunAfter: swap it and reopen, no wizard.
  autoUpdater.quitAndInstall(true, true);
  return true;
}

/**
 * Called as the app is closing. If an update is sitting downloaded and nothing
 * is recording, this is the moment it was waiting for.
 */
export function installOnQuitIfReady() {
  const decision = installDecision({
    downloaded: state.status === STATUS.READY || state.status === STATUS.WAITING,
    recording: isRecording(),
  });
  if (decision.action !== 'install') return false;
  autoUpdater.quitAndInstall(true, false);
  return true;
}

export function stopUpdater() {
  if (timer) clearInterval(timer);
  timer = null;
}
