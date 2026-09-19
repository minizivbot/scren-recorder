/**
 * The only channel between the app and the OS.
 *
 * contextIsolation is on and nodeIntegration is off, so the page cannot reach
 * Node directly. Everything it is allowed to do is listed here.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  /** Present only in the desktop app; the web version leaves this undefined. */
  isDesktop: true,

  info: () => ipcRenderer.invoke('app-info'),

  /** OS-level shortcuts. Returns which ones registered and which were taken. */
  registerShortcuts: (shortcuts) => ipcRenderer.invoke('register-shortcuts', shortcuts),

  onHotkey: (fn) => {
    const handler = (_event, payload) => fn(payload);
    ipcRenderer.on('hotkey', handler);
    return () => ipcRenderer.removeListener('hotkey', handler);
  },

  /** The screen picker, standing in for Chrome's own share dialog. */
  onPickSource: (fn) => {
    const handler = (_event, sources) => fn(sources);
    ipcRenderer.on('pick-source', handler);
    return () => ipcRenderer.removeListener('pick-source', handler);
  },
  pickSource: (id) => ipcRenderer.invoke('source-picked', id),

  /** Lets the main process warn before quitting mid-session. */
  setRecordingState: (isRecording) => ipcRenderer.send('recording-state', isRecording),

  revealRecordings: () => ipcRenderer.invoke('reveal-recordings'),

  /**
   * Self-update. The app checks and downloads on its own; these are for
   * showing what it is doing and for the "check now" button in Settings.
   */
  updates: {
    state: () => ipcRenderer.invoke('update-state'),
    check: () => ipcRenderer.invoke('update-check'),
    installNow: () => ipcRenderer.invoke('update-install'),
    onState: (fn) => {
      const handler = (_event, state) => fn(state);
      ipcRenderer.on('update-state', handler);
      return () => ipcRenderer.removeListener('update-state', handler);
    },
  },

  /**
   * Recordings on disk.
   *
   * The browser build keeps video in IndexedDB because it has nowhere else to
   * put it. Here it goes to a real folder the user picks — visible, backup-able
   * and free of storage quotas.
   */
  recordings: {
    dir: () => ipcRenderer.invoke('recordings-dir'),
    chooseDir: () => ipcRenderer.invoke('choose-recordings-dir'),
    reveal: () => ipcRenderer.invoke('reveal-recordings'),
    usage: () => ipcRenderer.invoke('recordings-usage'),

    open: (sessionId) => ipcRenderer.invoke('recording-open', sessionId),
    write: (sessionId, bytes) => ipcRenderer.invoke('recording-write', sessionId, bytes),
    close: (sessionId) => ipcRenderer.invoke('recording-close', sessionId),
    url: (sessionId) => ipcRenderer.invoke('recording-url', sessionId),
    remove: (sessionId) => ipcRenderer.invoke('recording-delete', sessionId),
  },
});
