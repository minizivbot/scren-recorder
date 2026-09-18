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
});
