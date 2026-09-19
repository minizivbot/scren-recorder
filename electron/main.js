/**
 * Desktop app main process.
 *
 * Two things this gives that the browser version fundamentally cannot:
 *
 *  1. Global shortcuts. globalShortcut registers with the OS, so marking works
 *     while Tradovate has focus — desktop app or browser, does not matter. In
 *     the browser version this needed a separate AutoHotkey script, because a
 *     web page only receives keydown while its own tab is focused.
 *
 *  2. One icon to double-click. No terminal, no server to leave running, no
 *     tab to keep open.
 *
 * The recorder itself is unchanged: this loads the same index.html and src/,
 * so the capture, storage and review code is the same tested code. The only
 * Electron-specific piece is how a screen gets chosen and how the shortcuts
 * arrive.
 */
import { app, BrowserWindow, globalShortcut, desktopCapturer, ipcMain, shell, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { initUpdater, check as checkForUpdate, installNow, installOnQuitIfReady, getUpdateState, stopUpdater } from './updater.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Defaults; the renderer can re-register these from its settings. */
const DEFAULT_SHORTCUTS = {
  entry: 'Control+Alt+E',
  exit: 'Control+Alt+X',
  note: 'Control+Alt+N',
  long: 'Control+Alt+L',
  short: 'Control+Alt+S',
  stop: 'Control+Alt+Q',
};

let mainWindow = null;
let pendingPick = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0e1116',
    title: 'Trade Journal',
    icon: path.join(ROOT, 'build', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(ROOT, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Links to AutoHotkey, docs and so on open in the real browser, not in here.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  /**
   * getDisplayMedia needs an explicit handler in Electron — without one it just
   * fails. The recorder core still calls getDisplayMedia exactly as it does in
   * the browser; the picker below stands in for Chrome's own share dialog.
   */
  mainWindow.webContents.session.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: false,
      });

      const choices = sources.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.id.startsWith('screen:') ? 'screen' : 'window',
        thumbnail: s.thumbnail.toDataURL(),
      }));

      // Ask the renderer to show the picker, and wait for the answer.
      const chosenId = await new Promise((resolve) => {
        pendingPick = resolve;
        mainWindow.webContents.send('pick-source', choices);
      });

      const source = sources.find((s) => s.id === chosenId);
      if (!source) {
        // Cancelled. Electron has no "denied" signal, so an empty callback is
        // how the request is refused; getDisplayMedia then rejects in the page.
        callback({});
        return;
      }

      // audio: deliberately absent. A fill chime carries one bit of information
      // and breaks the moment you mute — the hotkeys are the signal.
      callback({ video: source });
    } catch (err) {
      console.error('[picker]', err);
      callback({});
    }
  }, { useSystemPicker: false });
}

ipcMain.handle('source-picked', (_event, id) => {
  pendingPick?.(id);
  pendingPick = null;
});

// ── global shortcuts ────────────────────────────────────────────────────────

/**
 * Registers the OS-level shortcuts. Returns which ones actually took, because
 * another application may already own a combination — and a shortcut that
 * silently does nothing is worse than no shortcut, since you would not find out
 * until review time that the mark was never recorded.
 */
function registerShortcuts(shortcuts = DEFAULT_SHORTCUTS) {
  globalShortcut.unregisterAll();
  const result = {};

  const send = (payload) => mainWindow?.webContents.send('hotkey', payload);

  const actions = {
    entry: () => send({ command: 'mark', kind: 'entry' }),
    exit: () => send({ command: 'mark', kind: 'exit' }),
    note: () => send({ command: 'mark', kind: 'note' }),
    long: () => send({ command: 'mark', kind: 'entry', direction: 'long' }),
    short: () => send({ command: 'mark', kind: 'entry', direction: 'short' }),
    stop: () => send({ command: 'stop' }),
  };

  for (const [name, accelerator] of Object.entries(shortcuts)) {
    if (!accelerator || !actions[name]) continue;
    try {
      result[name] = { accelerator, ok: globalShortcut.register(accelerator, actions[name]) };
    } catch (err) {
      result[name] = { accelerator, ok: false, error: err.message };
    }
  }

  return result;
}

ipcMain.handle('register-shortcuts', (_event, shortcuts) => registerShortcuts(shortcuts));
ipcMain.handle('app-info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  recordingsPath: app.getPath('userData'),
}));

// ── self-update ─────────────────────────────────────────────────────────────
ipcMain.handle('update-state', () => getUpdateState());
ipcMain.handle('update-check', () => checkForUpdate(true));
ipcMain.handle('update-install', () => installNow());

// ── recordings on disk ──────────────────────────────────────────────────────
//
// In the browser, chunks live in IndexedDB because there is nowhere else to put
// them. A desktop app has a filesystem, so recordings go to a real folder you
// choose: visible in Explorer, backup-able, movable to another drive, and not
// subject to a browser storage quota at all.

const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'recordings-path.json');

function defaultRecordingsDir() {
  return path.join(app.getPath('videos'), 'Trade Journal');
}

function readRecordingsDir() {
  // An explicit override, for a portable install on a memory stick, a machine
  // where the videos drive is not the user profile drive, and for tests.
  if (process.env.TRADE_JOURNAL_RECORDINGS_DIR) {
    return process.env.TRADE_JOURNAL_RECORDINGS_DIR;
  }
  try {
    const raw = fs.readFileSync(SETTINGS_FILE(), 'utf8');
    const dir = JSON.parse(raw).dir;
    if (dir && typeof dir === 'string') return dir;
  } catch { /* first run, or the file was removed */ }
  return defaultRecordingsDir();
}

function writeRecordingsDir(dir) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify({ dir }, null, 2));
}

/** Open file handles, one per recording in progress. */
const writers = new Map();

ipcMain.handle('recordings-dir', () => ({
  dir: readRecordingsDir(),
  isDefault: readRecordingsDir() === defaultRecordingsDir(),
}));

ipcMain.handle('choose-recordings-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Where should recordings be saved?',
    defaultPath: readRecordingsDir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return { dir: readRecordingsDir(), changed: false };

  // Existing recordings are deliberately left where they are. Moving gigabytes
  // behind a settings click is not something to do without being asked.
  writeRecordingsDir(result.filePaths[0]);
  return { dir: result.filePaths[0], changed: true };
});

ipcMain.handle('reveal-recordings', async () => {
  const dir = readRecordingsDir();
  await fsp.mkdir(dir, { recursive: true });
  shell.openPath(dir);
  return dir;
});

ipcMain.handle('recording-open', async (_event, sessionId) => {
  const dir = readRecordingsDir();
  await fsp.mkdir(dir, { recursive: true });

  const file = path.join(dir, `${sessionId}.webm`);
  const handle = await fsp.open(file, 'w');
  writers.set(sessionId, handle);
  return file;
});

/**
 * Appends one timeslice.
 *
 * Written and flushed as it arrives, exactly like the IndexedDB path: a crash
 * costs the timeslice being buffered, never the session.
 */
ipcMain.handle('recording-write', async (_event, sessionId, chunk) => {
  const handle = writers.get(sessionId);
  if (!handle) throw new Error(`No open recording for ${sessionId}`);
  const { bytesWritten } = await handle.write(Buffer.from(chunk));
  return bytesWritten;
});

ipcMain.handle('recording-close', async (_event, sessionId) => {
  const handle = writers.get(sessionId);
  if (!handle) return null;
  await handle.close();
  writers.delete(sessionId);

  const file = path.join(readRecordingsDir(), `${sessionId}.webm`);
  const stat = await fsp.stat(file).catch(() => null);
  return { file, bytes: stat?.size ?? 0 };
});

/** Hands the renderer a file:// URL the video element can play directly. */
ipcMain.handle('recording-url', async (_event, sessionId) => {
  const file = path.join(readRecordingsDir(), `${sessionId}.webm`);
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat) return null;
  return { url: `file://${file.split(path.sep).join('/')}`, bytes: stat.size };
});

ipcMain.handle('recording-delete', async (_event, sessionId) => {
  const file = path.join(readRecordingsDir(), `${sessionId}.webm`);
  const stat = await fsp.stat(file).catch(() => null);
  await fsp.rm(file, { force: true });
  return { bytes: stat?.size ?? 0 };
});

/** Total size of everything in the recordings folder. */
ipcMain.handle('recordings-usage', async () => {
  const dir = readRecordingsDir();
  const names = await fsp.readdir(dir).catch(() => []);
  let bytes = 0;
  for (const name of names) {
    if (!name.endsWith('.webm')) continue;
    const stat = await fsp.stat(path.join(dir, name)).catch(() => null);
    bytes += stat?.size ?? 0;
  }
  return { dir, bytes, files: names.filter((n) => n.endsWith('.webm')).length };
});

// ── lifecycle ───────────────────────────────────────────────────────────────

// One instance only: a second copy would fight over the global shortcuts and
// open a second window onto the same recordings.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // Without this Windows groups the window under "electron" in the taskbar
    // and shows the wrong icon on the jump list.
    if (process.platform === 'win32') app.setAppUserModelId('com.tradejournal.recorder');
    createWindow();
    registerShortcuts();

    // Downloads in the background and swaps itself on close. It will not
    // install over a live recording — see electron/updater.js.
    initUpdater({
      recording: () => !!global.__isRecording,
      onState: (state) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('update-state', state);
        }
      },
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

/**
 * Closing the window mid-recording would lose the timeslice being buffered, so
 * check first. The session is still recoverable either way, but it is worth a
 * question rather than a surprise.
 */
app.on('before-quit', (e) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // The renderer sets this whenever recording starts or stops.
  if (!global.__isRecording) return;

  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: 'warning',
    buttons: ['Keep recording', 'Stop and quit'],
    defaultId: 0,
    cancelId: 0,
    title: 'Still recording',
    message: 'A session is still recording.',
    detail: 'Quitting now stops it. Everything captured so far is saved either way.',
  });
  if (choice === 0) e.preventDefault();
});

/**
 * Closing is the safe moment to swap the binary: nothing is recording by the
 * time the window-close check above has passed. quitAndInstall takes over the
 * quit, so this runs last.
 */
app.on('before-quit', () => {
  if (global.__isRecording) return;
  installOnQuitIfReady();
});

ipcMain.on('recording-state', (_event, isRecording) => {
  global.__isRecording = !!isRecording;
});

app.on('will-quit', async () => {
  stopUpdater();
  globalShortcut.unregisterAll();
  // Flush whatever was open, so an interrupted session is still a valid prefix.
  for (const [id, handle] of writers) {
    await handle.close().catch(() => {});
    writers.delete(id);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
