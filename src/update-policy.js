/**
 * When the app is allowed to update itself, and when it must not.
 *
 * Kept free of Electron so it can be tested directly. electron/updater.js is
 * the thin part that talks to electron-updater; every judgement call lives
 * here.
 *
 * The rule that matters: never install while recording. An installer quits the
 * app to swap the binary, and a session cut off mid-timeslice loses whatever
 * was buffered. Trading footage is not reproducible — you cannot re-record
 * this morning. So a downloaded update waits, however long it has to.
 */

/** Statuses the renderer knows how to display. */
export const STATUS = {
  UNSUPPORTED: 'unsupported',
  IDLE: 'idle',
  CHECKING: 'checking',
  CURRENT: 'current',
  AVAILABLE: 'available',
  DOWNLOADING: 'downloading',
  READY: 'ready',
  WAITING: 'waiting-for-recording-to-end',
  ERROR: 'error',
};

/**
 * Whether this copy of the app can update itself at all.
 *
 * Says why not, rather than failing silently — a portable .exe genuinely
 * cannot replace itself, and the user deserves to be told that instead of
 * wondering why updates never arrive.
 */
export function updateSupport({ packaged, execPath = '', platform = process.platform }) {
  if (!packaged) {
    return { supported: false, reason: 'Running from source — updates apply to the installed app only.' };
  }
  if (platform !== 'win32') {
    return { supported: false, reason: `No update channel is published for ${platform}.` };
  }
  // The portable build unpacks itself to a temp folder on each run, so there is
  // no install to replace. Its own filename is the only reliable marker.
  if (/portable/i.test(execPath)) {
    return {
      supported: false,
      reason: 'This is the portable build, which cannot update itself. Install the setup version for automatic updates.',
    };
  }
  return { supported: true, reason: null };
}

/**
 * What to do with an update that has finished downloading.
 *
 * 'install' quits and swaps the binary. 'wait' holds it — the installer is
 * already on disk, so this costs nothing but patience.
 */
export function installDecision({ downloaded, recording, userAsked = false }) {
  if (!downloaded) return { action: 'none', reason: 'Nothing downloaded yet.' };
  if (recording) {
    return {
      action: 'wait',
      reason: 'A session is recording. The update installs when you stop.',
    };
  }
  return { action: 'install', reason: userAsked ? 'Restarting to install.' : 'Installing on quit.' };
}

/**
 * Compares two versions the way the updater does, so the UI can say "you are
 * on the newest one" without asking the server twice.
 *
 * Returns > 0 when `a` is newer. Plain numeric dotted versions only, which is
 * all this app ships; anything unparseable sorts as 0 rather than throwing.
 */
export function compareVersions(a, b) {
  const parts = (v) => String(v ?? '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * How often to look. Hourly is plenty for a tool someone opens in the morning
 * and closes at the bell, and it keeps the check off the startup path when the
 * app is left open for days.
 */
export const CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** Whether enough time has passed to check again. */
export function shouldCheck({ lastCheckAt, now, intervalMs = CHECK_INTERVAL_MS, supported }) {
  if (!supported) return false;
  if (!lastCheckAt) return true;
  return now - lastCheckAt >= intervalMs;
}

/** One line for the UI, from the raw state. Null means show nothing. */
export function updateMessage(state) {
  switch (state?.status) {
    case STATUS.AVAILABLE:
      return `Version ${state.version} is available — downloading it now.`;
    case STATUS.DOWNLOADING:
      return `Downloading version ${state.version}… ${Math.round(state.percent || 0)}%`;
    case STATUS.READY:
      return `Version ${state.version} is ready. It installs when you close the app.`;
    case STATUS.WAITING:
      return `Version ${state.version} is ready. It installs once you stop recording.`;
    case STATUS.CURRENT:
      return 'You are on the newest version.';
    case STATUS.CHECKING:
      return 'Checking for updates…';
    case STATUS.ERROR:
      return `Could not check for updates: ${state.error}`;
    case STATUS.UNSUPPORTED:
      return state.reason;
    default:
      return null;
  }
}
