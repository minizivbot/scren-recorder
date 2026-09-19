/**
 * App wiring: one continuous recording, markers dropped into it live, and a
 * library for reviewing them afterwards.
 */
import {
  SessionRecorder, SESSION_STATUS, listSessions, recoverInterruptedSessions,
  storageEstimate, recordingsFootprint, requestPersistentStorage, isQuotaError, formatBytes,
} from './session-recorder.js';
import { loadSettings, saveSettings, captureOptions, estimateBytesPerHour, PRESETS } from './settings.js';
import { ReviewView } from './review.js';
import { BridgeClient } from './bridge-client.js';
import { isDesktop, initDesktop, toAccelerators } from './desktop.js';
import { $, el, clear, formatDate, formatClock, formatDuration } from './dom.js';
import { renderDashboard, renderJournal, renderTrades, stepCalendar, setCalendarMonth } from './views.js';
import { SessionWizard } from './wizard.js';
import { getDayReview } from './trades.js';
import { eraseEverything } from './erase.js';
import { confirmTyped } from './dialog.js';
import { wireUpdates } from './updates-ui.js';

const KIND_LABEL = { entry: 'Entry', exit: 'Exit', note: 'Note' };

let settings = loadSettings();
let recorder = null;
let elapsedTimer = null;
let liveMarkers = [];

const wizard = new SessionWizard({
  getPois: async () => settings.pois,
  onDone: () => refreshAll(),
});

const review = new ReviewView({
  getSettings: () => settings,
  setSettings: (patch) => commitSettings(patch),
  onChanged: () => refreshAll(),
  onClose: () => showView(currentView === 'review' ? 'recordings' : currentView),
});

// ─────────────────────────── navigation ───────────────────────────

const VIEWS = [
  { id: 'dashboard', label: 'Overview', icon: '◎' },
  { id: 'journal', label: 'Journal', icon: '▤' },
  { id: 'trades', label: 'Trades', icon: '⇅' },
  { id: 'recordings', label: 'Recordings', icon: '▶' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
];

let currentView = 'dashboard';

function renderNav() {
  const nav = clear($('#sidenav'));
  for (const view of VIEWS) {
    nav.append(el('button', {
      class: `nav-item${view.id === currentView ? ' is-active' : ''}`,
      type: 'button',
      dataset: { view: view.id },
      onclick: () => showView(view.id),
    },
      el('span', { class: 'nav-icon', 'aria-hidden': 'true' }, view.icon),
      el('span', { class: 'nav-label' }, view.label),
    ));
  }
}

async function showView(id) {
  // Leaving review releases the video's object URL; a session blob can be over
  // a gigabyte and holding it pins that memory.
  if (!$('#view-review').hidden && id !== 'review') review.close();

  currentView = id;
  for (const view of VIEWS) $(`#view-${view.id}`).hidden = view.id !== id;
  renderNav();
  await refreshView(id);
}

async function refreshView(id = currentView) {
  if (id === 'dashboard') {
    await renderDashboard({
      rangeId: settings.range,
      onRangeChange: (range) => { commitSettings({ range }); refreshView('dashboard'); },
    });
  } else if (id === 'journal') {
    await renderJournal({
      onOpenSession: (sessionId) => openRecording(sessionId),
      onEditDay: (day) => editDayNote(day),
      // Clicking a box opens that day, whether or not it has trades yet — an
      // empty day is where you add the ones you forgot to log.
      onPickDay: (cell) => editDayNote({ date: cell.key }),
    });
  } else if (id === 'trades') {
    await renderTrades({
      onEdit: (trade) => wizard.open(null, { editTrade: trade }),
      onChanged: () => refreshAll(),
    });
  } else if (id === 'recordings') {
    await renderLibrary();
  }
}

/** Anything that changes trades changes several pages at once. */
async function refreshAll() {
  await refreshView(currentView);
  await renderStorage();
}

function openRecording(sessionId) {
  for (const view of VIEWS) $(`#view-${view.id}`).hidden = true;
  review.open(sessionId);
}

// ─────────────────────────── recording ───────────────────────────

/**
 * getDisplayMedia must be reached synchronously from the gesture, so this
 * handler awaits nothing before calling start(). Anything that needs doing
 * first (opening the DB, asking for persistent storage) happens at page load.
 */
function onRecordClick() {
  if (recorder && recorder.state === 'recording') {
    stopRecording();
    return;
  }
  startRecording();
}

function startRecording() {
  const support = SessionRecorder.support();
  if (!support.ok) {
    showAlert(support.message);
    return;
  }

  recorder = new SessionRecorder(captureOptions(settings));
  liveMarkers = [];

  recorder.on('start', () => {
    window.desktop?.setRecordingState(true);
    setRecordingUi(true);
    renderLiveMarkers();
    startElapsedTimer();
  });

  recorder.on('marker', (m) => {
    liveMarkers = [...liveMarkers, m];
    renderLiveMarkers();
  });

  recorder.on('chunk', () => { /* keeps the storage meter honest during long sessions */ });

  recorder.on('source-ended', () => {
    // The user hit Chrome's own "Stop sharing" bar. The session still finalizes.
    showAlert('Screen sharing was stopped from the browser bar. The session was saved.', 'warn');
  });

  recorder.on('quota-exceeded', () => {
    showAlert(
      'Storage is full. Recording stopped to avoid recording into the void — everything captured '
      + 'before this point was saved. Delete some sessions to free space.',
    );
  });

  recorder.on('error', (err) => {
    if (isQuotaError(err)) return; // already reported, loudly
    console.error('[recorder]', err);
    showAlert(`Recorder error: ${err?.message || err}`, 'warn');
  });

  recorder.on('stop', (session) => {
    window.desktop?.setRecordingState(false);
    setRecordingUi(false);
    stopElapsedTimer();
    refreshAll();

    // Ask now, while you still remember why you did what you did. A day later
    // the reasons have already been rewritten by the outcome.
    if (session) wizard.open(session);
  });

  // Not awaited: the gesture must reach getDisplayMedia synchronously.
  recorder.start({ startedFrom: 'ui' }).catch((err) => {
    recorder = null;
    setRecordingUi(false);
    stopElapsedTimer();
    if (err?.name === 'NotAllowedError') {
      showAlert('Screen capture was declined, so nothing is being recorded.', 'warn');
    } else {
      showAlert(`Could not start recording: ${err?.message || err}`);
    }
  });
}

async function stopRecording() {
  try {
    await recorder?.stop();
  } catch (err) {
    showAlert(`Error while finalizing: ${err?.message || err}`);
  }
}

/**
 * The marking entry point.
 *
 * Deliberately hung off window, and also driven by the local bridge: both exist
 * so that marking can happen while another application is focused, which the
 * in-page key handler below fundamentally cannot do.
 */
function mark(data = {}) {
  if (!recorder || recorder.state !== 'recording') return null;
  return recorder.mark(data);
}

// ─────────────────────────── global hotkeys ───────────────────────────

function handleRemoteCommand(cmd) {
  if (cmd.command === 'stop') {
    // Stopping this way is fine. Starting is not: getDisplayMedia needs a real
    // gesture in the window, so no hotkey can begin a session.
    stopRecording();
    return;
  }

  if (!recorder || recorder.state !== 'recording') {
    showAlert('A global hotkey fired, but nothing is recording — the marker was not saved.', 'warn');
    return;
  }

  mark({
    kind: cmd.kind,
    symbol: cmd.symbol || '',
    direction: cmd.direction || '',
    account: cmd.account || '',
    note: cmd.note || '',
    source: 'hotkey',
  });
}

// In a browser the commands arrive over the local HTTP bridge. In the desktop
// app the OS delivers them directly, so no bridge and no helper tool.
const bridge = isDesktop() ? null : new BridgeClient({
  onCommand: handleRemoteCommand,
  onStatus: ({ connected, message }) => renderBridgeStatus(connected, message),
});

/** Reports which OS shortcuts registered, and which another app already owns. */
function renderShortcutStatus(result) {
  const taken = Object.entries(result || {})
    .filter(([, v]) => !v.ok)
    .map(([name, v]) => `${name} (${v.accelerator})`);

  const state = $('#bridge-state');
  state.dataset.connected = String(taken.length === 0);
  $('#bridge-label').textContent = taken.length === 0
    ? 'Global hotkeys: ready'
    : 'Global hotkeys: some are taken';

  $('#bridge-help').textContent = taken.length === 0
    ? 'Marking works while Tradovate has focus — these are registered with Windows itself, '
      + 'so this window does not need to be in front.'
    : `Another application already owns ${taken.join(', ')}. Change them in Settings.`;
}

function renderBridgeStatus(connected, message) {
  const state = $('#bridge-state');
  state.dataset.connected = String(connected);
  $('#bridge-label').textContent = connected
    ? 'Global hotkeys: ready'
    : 'Global hotkeys: not connected';

  if (message) $('#bridge-help').textContent = message;
  else if (connected) {
    $('#bridge-help').textContent =
      'Marking works while Tradovate has focus — browser or desktop app — as long as this tab stays '
      + 'open and your hotkey tool is running.';
  }
}

function onKeyDown(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const target = e.target;
  if (target instanceof HTMLElement
      && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) {
    return;
  }
  if (!recorder || recorder.state !== 'recording') return;

  const key = e.key.toLowerCase();
  const kind = Object.keys(settings.hotkeys).find((k) => settings.hotkeys[k] === key);
  if (!kind) return;

  e.preventDefault();
  mark({ kind });
}

// ─────────────────────────── recording UI ───────────────────────────

function setRecordingUi(isRecording) {
  $('#live-markers').hidden = !isRecording;
  const btn = $('#btn-record');
  btn.dataset.state = isRecording ? 'recording' : 'idle';
  $('#btn-record-label').textContent = isRecording ? 'Stop recording' : 'Start recording';

  const status = $('#record-status');
  status.dataset.state = isRecording ? 'recording' : 'idle';
  $('#status-text').textContent = isRecording ? 'RECORDING' : 'Not recording';
  $('#elapsed').hidden = !isRecording;
  if (!isRecording) $('#elapsed').textContent = '00:00';
}

function startElapsedTimer() {
  stopElapsedTimer();
  elapsedTimer = setInterval(() => {
    $('#elapsed').textContent = formatDuration(recorder?.elapsedMs || 0);
  }, 250);
}

function stopElapsedTimer() {
  clearInterval(elapsedTimer);
  elapsedTimer = null;
}

function renderLiveMarkers() {
  $('#live-marker-count').textContent = String(liveMarkers.length);
  $('#live-marker-empty').hidden = liveMarkers.length > 0;

  const list = clear($('#live-marker-list'));
  // Newest first: the mark just dropped is the one being looked at.
  for (const m of [...liveMarkers].reverse()) {
    // A hotkey can carry a symbol and direction, so show what actually arrived
    // rather than always telling you to fill it in later.
    const details = [m.symbol, m.direction, m.account && `(${m.account})`].filter(Boolean);

    list.append(el('li', { class: 'marker', dataset: { kind: m.kind } },
      el('span', { class: 'marker-time' }, formatDuration(m.offsetMs)),
      el('div', { class: 'marker-body' },
        el('div', { class: 'marker-label' },
          el('span', { class: 'marker-kind' }, KIND_LABEL[m.kind] || m.kind),
          details.length ? el('span', { class: 'marker-sym' }, details.join(' ')) : null,
          el('span', { class: 'muted' }, `at ${formatClock(Date.parse(m.wallClock))}`),
          m.source === 'hotkey' ? el('span', { class: 'badge' }, 'hotkey') : null,
        ),
        el('div', { class: 'marker-note' },
          m.note || (details.length ? 'Add notes in review.' : 'Add symbol, direction and notes in review.')),
      ),
    ));
  }
}

function renderHotkeys() {
  const strip = clear($('#hotkeys-strip'));
  for (const [kind, key] of Object.entries(settings.hotkeys)) {
    strip.append(el('span', { class: 'hotkey', dataset: { kind } },
      el('kbd', {}, key), KIND_LABEL[kind] || kind));
  }
}

// ─────────────────────────── library ───────────────────────────

async function renderLibrary() {
  const sessions = await listSessions();
  $('#session-count').textContent = String(sessions.length);
  $('#session-empty').hidden = sessions.length > 0;

  const list = clear($('#session-list'));
  for (const s of sessions) list.append(sessionRow(s));
}

function sessionRow(s) {
  const markers = (s.markers || []).length;
  const badges = [];
  if (s.status === SESSION_STATUS.INTERRUPTED) {
    badges.push(el('span', { class: 'badge badge-interrupted', title: 'Recovered after a refresh or crash — playable up to the last stored timeslice' }, 'interrupted'));
  }
  if (s.status === SESSION_STATUS.RECORDING) {
    badges.push(el('span', { class: 'badge badge-recording' }, 'recording'));
  }
  if (s.storageError?.kind === 'quota') {
    badges.push(el('span', { class: 'badge badge-quota' }, 'storage full'));
  }

  return el('button', {
    class: 'session', type: 'button', dataset: { sessionId: s.id },
    onclick: () => review.open(s.id),
  },
    el('div', { class: 'session-when' },
      el('div', { class: 'session-date' }, formatDate(s.startedAt)),
      el('div', { class: 'session-time' }, formatClock(s.startedAt)),
    ),
    el('div', { class: 'session-stats' },
      stat(formatDuration(s.durationMs || 0), 'length'),
      stat(String(markers), markers === 1 ? 'marker' : 'markers'),
      stat(formatBytes(s.bytes || 0), 'size'),
    ),
    el('div', { class: 'marker-actions' }, ...badges),
  );
}

function stat(value, label) {
  return el('div', { class: 'stat' },
    el('span', { class: 'stat-value' }, value),
    el('span', { class: 'stat-label' }, label),
  );
}

// ─────────────────────────── storage meter ───────────────────────────

let wasStorageLow = false;

async function renderStorage() {
  const fill = $('#storage-fill');
  const text = $('#storage-text');

  // On the desktop the recordings are files, so the folder is the honest
  // measure — the browser's quota has nothing to do with them.
  if (isDesktop()) {
    const usage = await window.desktop.recordings.usage();
    text.textContent = `${formatBytes(usage.bytes)} in ${usage.files} recording${usage.files === 1 ? '' : 's'}`;
    fill.style.width = '0%';
    $('#storage-meter').title = usage.dir;
    return;
  }

  const [est, own] = await Promise.all([storageEstimate(), recordingsFootprint()]);

  // Our own total, which is exact and drops the moment a session is deleted.
  const mine = `${formatBytes(own.bytes)} in ${own.sessions} session${own.sessions === 1 ? '' : 's'}`;

  if (!est) {
    text.textContent = mine;
    return;
  }

  // The bar tracks the browser's quota, since that is what causes eviction.
  fill.style.width = `${Math.min(100, est.pct)}%`;
  fill.dataset.level = est.pct > 90 ? 'danger' : est.pct > 75 ? 'warn' : 'ok';
  text.textContent = mine;
  $('#storage-meter').title =
    `Recordings: ${mine}\nBrowser reports ${formatBytes(est.usage)} of ${formatBytes(est.quota)} used for this site.\n`
    + 'The browser\'s figure lags after a delete; the recordings total is exact.';

  // Only when it crosses, not on every poll — a banner every 15 seconds trains
  // you to ignore banners.
  const low = est.pct > 90;
  if (low && !wasStorageLow) {
    showAlert('Storage is over 90% full. Delete some sessions before recording again.', 'warn');
  }
  wasStorageLow = low;
}

// ─────────────────────────── settings ───────────────────────────

function renderSettings() {
  $('#set-preroll').value = String(Math.round(settings.preRollMs / 1000));
  $('#set-width').value = String(settings.width);
  $('#set-height').value = String(settings.height);
  $('#set-fps').value = String(settings.frameRate);
  $('#set-bitrate').value = String(Math.round(settings.videoBitsPerSecond / 1000));
  $('#set-key-entry').value = settings.hotkeys.entry;
  $('#set-key-exit').value = settings.hotkeys.exit;
  $('#set-key-note').value = settings.hotkeys.note;

  const presets = clear($('#set-preset'));
  presets.append(el('option', { value: '' }, 'Custom'));
  PRESETS.forEach((p, i) => {
    const matches = p.width === settings.width && p.height === settings.height
      && p.frameRate === settings.frameRate && p.videoBitsPerSecond === settings.videoBitsPerSecond;
    presets.append(el('option', { value: String(i), selected: matches }, p.label));
  });

  const perHour = estimateBytesPerHour(settings);
  $('#size-estimate').textContent =
    `About ${formatBytes(perHour)} per hour — roughly ${formatBytes(perHour * 2)} for a two-hour session.`;

  renderHotkeys();
  renderPois();
  renderRecordingsFolder().catch(() => {});
}

function commitSettings(patch) {
  settings = saveSettings({ ...settings, ...patch });
  renderSettings();

  // The OS holds the shortcuts, so a rebind has to be handed back to it.
  if (isDesktop() && patch.hotkeys) {
    window.desktop.registerShortcuts(toAccelerators(settings.hotkeys)).then(renderShortcutStatus);
  }
}

function wireSettings() {
  $('#set-preroll').addEventListener('change', (e) => {
    commitSettings({ preRollMs: Math.max(0, Number(e.target.value) || 0) * 1000 });
  });

  $('#set-preset').addEventListener('change', (e) => {
    const preset = PRESETS[Number(e.target.value)];
    if (!preset) return;
    const { label, ...values } = preset;
    commitSettings(values);
  });

  const numeric = [
    ['#set-width', 'width', 1],
    ['#set-height', 'height', 1],
    ['#set-fps', 'frameRate', 1],
    ['#set-bitrate', 'videoBitsPerSecond', 1000],
  ];
  for (const [sel, key, scale] of numeric) {
    $(sel).addEventListener('change', (e) => {
      const value = Math.max(1, Number(e.target.value) || 0) * scale;
      commitSettings({ [key]: value });
    });
  }

  for (const [sel, kind] of [['#set-key-entry', 'entry'], ['#set-key-exit', 'exit'], ['#set-key-note', 'note']]) {
    $(sel).addEventListener('change', (e) => {
      const key = (e.target.value || '').toLowerCase().slice(0, 1);
      if (!key) { renderSettings(); return; }
      commitSettings({ hotkeys: { ...settings.hotkeys, [kind]: key } });
    });
  }

  $('#btn-choose-folder').addEventListener('click', async () => {
    const result = await window.desktop.recordings.chooseDir();
    if (result.changed) await renderRecordingsFolder();
  });

  $('#btn-open-folder').addEventListener('click', () => window.desktop.recordings.reveal());

  $('#btn-terms').addEventListener('click', () => openDoc('TERMS'));
  $('#btn-privacy').addEventListener('click', () => openDoc('PRIVACY'));
  $('#btn-erase').addEventListener('click', () => confirmErase());

  $('#btn-persist').addEventListener('click', async () => {
    const granted = await requestPersistentStorage();
    $('#persist-state').textContent = granted
      ? 'Granted — recordings will not be evicted.'
      : 'Denied. The browser may evict recordings under storage pressure.';
  });
}

/**
 * Asks for persistent storage up front rather than behind a button, so a long
 * session is not recording into data the browser considers evictable.
 *
 * Chromium grants this silently from engagement heuristics. Firefox prompts, and
 * a permission prompt on page load is obnoxious, so there it stays manual.
 */
async function ensurePersistentStorage() {
  if (!navigator.storage?.persisted) return;

  const state = $('#persist-state');
  if (await navigator.storage.persisted()) {
    state.textContent = 'Granted — recordings will not be evicted.';
    return;
  }

  const isChromium = /Chrome|Chromium|Edg\//.test(navigator.userAgent);
  if (!isChromium) {
    state.textContent = 'Not granted. Request it before a long session.';
    return;
  }

  const granted = await requestPersistentStorage().catch(() => false);
  state.textContent = granted
    ? 'Granted — recordings will not be evicted.'
    : 'Not granted. The browser may evict recordings under storage pressure.';
}

/** Shows which folder recordings go to, and what is in it. */
async function renderRecordingsFolder() {
  if (!isDesktop()) return;

  $('#folder-setting').hidden = false;
  const { dir } = await window.desktop.recordings.dir();
  $('#recordings-path').textContent = dir;

  const usage = await window.desktop.recordings.usage();
  $('#recordings-usage').textContent = usage.files
    ? `${usage.files} recording${usage.files === 1 ? '' : 's'}, ${formatBytes(usage.bytes)}`
    : 'No recordings in this folder yet.';
}

// ─────────────────────────── legal and data ───────────────────────────

/** Opens a document in the real browser rather than inside the app window. */
function openDoc(name) {
  const url = `https://github.com/minizivbot/scren-recorder/blob/main/docs/${name}.md`;
  if (window.desktop) window.open(url, '_blank');
  else window.open(url, '_blank', 'noopener');
}

/**
 * Typed confirmation, because this cannot be undone and there is no copy
 * anywhere else to recover from.
 */
async function confirmErase() {
  const summary = await describeEverything();
  const ok = await confirmTyped({
    title: 'Delete everything?',
    body: `${summary}\n\nThe recordings are removed from disk as well.\nThis cannot be undone.`,
    word: 'DELETE',
    confirmLabel: 'Delete everything',
  });

  if (!ok) {
    $('#erase-state').textContent = 'Cancelled — nothing was deleted.';
    return;
  }

  $('#erase-state').textContent = 'Deleting…';
  const removed = await eraseEverything();

  settings = loadSettings();
  renderSettings();
  $('#erase-state').textContent =
    `Deleted ${removed.sessions} recording${removed.sessions === 1 ? '' : 's'} `
    + `and ${removed.trades} trade${removed.trades === 1 ? '' : 's'}`
    + `${removed.bytes ? `, freeing ${formatBytes(removed.bytes)}` : ''}.`;

  await refreshAll();
}

/** Says what is about to go, so the confirmation is not an abstraction. */
async function describeEverything() {
  const [sessions, trades] = await Promise.all([listSessions(), listTradesForCount()]);
  const bytes = sessions.reduce((sum, s) => sum + (s.bytes || 0), 0);
  return [
    `${sessions.length} recording${sessions.length === 1 ? '' : 's'} (${formatBytes(bytes)})`,
    `${trades} trade${trades === 1 ? '' : 's'}`,
    'all day notes, markers and settings',
  ].join('\n');
}

async function listTradesForCount() {
  const { listTrades } = await import('./trades.js');
  return (await listTrades()).length;
}

// ─────────────────────────── setups (POIs) ───────────────────────────

function renderPois() {
  const host = clear($('#poi-tags'));

  if (!settings.pois.length) {
    host.append(el('p', { class: 'muted' },
      'No setups yet. Add the reasons you actually take trades — they become the choices on the '
      + 'trade form, and the Trades page scores each one.'));
    return;
  }

  for (const poi of settings.pois) {
    host.append(el('span', { class: 'tag tag-removable' }, poi,
      el('button', {
        class: 'tag-x', type: 'button', 'aria-label': `Remove ${poi}`,
        onclick: () => {
          // Trades already tagged keep the tag; removing it only stops it being
          // offered, so history is never rewritten.
          commitSettings({ pois: settings.pois.filter((p) => p !== poi) });
          renderPois();
        },
      }, '×'),
    ));
  }
}

function wirePois() {
  $('#poi-add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#poi-input');
    const value = input.value.trim();
    if (!value) return;

    if (settings.pois.some((p) => p.toLowerCase() === value.toLowerCase())) {
      input.value = '';
      return;
    }
    commitSettings({ pois: [...settings.pois, value] });
    input.value = '';
    renderPois();
  });
}

/**
 * The journal's note button opens the same rating-and-note step the
 * end-of-session review starts with, so a note written later is the same
 * thing as one written at the time.
 *
 * This used to be a window.prompt(). Electron does not implement prompt() —
 * it returns null without showing anything — so the button did nothing at all
 * in the desktop app.
 */
async function editDayNote(day) {
  await wizard.openDayReview(day.date);
  await refreshView('journal');
}

/** Calendar vs. list. Both read the same journal; only the shape differs. */
function wireJournalModes() {
  const modes = $('#journal-modes');
  if (!modes) return;

  modes.addEventListener('click', (e) => {
    const btn = e.target.closest('.mode-btn');
    if (!btn) return;
    const calendar = btn.dataset.mode === 'calendar';
    for (const b of modes.querySelectorAll('.mode-btn')) {
      b.classList.toggle('is-on', b === btn);
    }
    $('#journal-calendar').hidden = !calendar;
    $('#journal-list').hidden = calendar;
  });

  $('#cal-prev').addEventListener('click', async () => { stepCalendar(-1); await refreshView('journal'); });
  $('#cal-next').addEventListener('click', async () => { stepCalendar(1); await refreshView('journal'); });
  $('#cal-today').addEventListener('click', async () => {
    const now = new Date();
    setCalendarMonth({ year: now.getFullYear(), month: now.getMonth() });
    await refreshView('journal');
  });
}

// ─────────────────────────── banners ───────────────────────────

let alertTimer = null;

function showAlert(message, level = 'error') {
  const banner = $('#alert-banner');
  banner.hidden = false;
  banner.className = `banner banner-${level === 'warn' ? 'warn' : 'error'}`;
  banner.textContent = message;

  clearTimeout(alertTimer);
  alertTimer = setTimeout(() => { banner.hidden = true; }, 12_000);
}

function renderSupport() {
  const support = SessionRecorder.support();
  if (support.ok) return true;

  const banner = $('#support-banner');
  banner.hidden = false;
  banner.append(
    el('strong', {}, 'Recording is not available in this browser.'),
    document.createTextNode(support.message),
  );
  $('#btn-record').disabled = true;
  return false;
}

// ─────────────────────────── boot ───────────────────────────

async function boot() {
  wireSettings();
  wirePois();
  renderSettings();
  renderNav();
  $('#btn-add-trade').addEventListener('click', () => wizard.open(null));
  $('#btn-record').addEventListener('click', onRecordClick);
  window.addEventListener('keydown', onKeyDown);

  window.addEventListener('beforeunload', (e) => {
    if (recorder?.state === 'recording') {
      // Leaving mid-session is recoverable, but costs the buffered timeslice.
      e.preventDefault();
      e.returnValue = '';
    }
  });

  renderSupport();

  if (isDesktop()) {
    // Shortcuts come from the OS; nothing else to install and nothing to leave
    // running. This is the whole reason the desktop app exists.
    const desktop = await initDesktop({
      onCommand: handleRemoteCommand,
      onShortcuts: renderShortcutStatus,
    });
    await desktop?.registerShortcuts(toAccelerators(settings.hotkeys));
  } else {
    bridge.connect();
  }

  // Anything that would delay the record gesture happens here, not in the click.
  const recovered = await recoverInterruptedSessions();
  if (recovered.length) {
    showAlert(
      `${recovered.length} session${recovered.length === 1 ? ' was' : 's were'} interrupted by a refresh or crash. `
      + 'Recovered and playable up to the last stored timeslice.',
      'warn',
    );
  }

  wireJournalModes();

  if (isDesktop()) {
    await renderRecordingsFolder();
    // Reports what the main process is doing; it starts checking on its own.
    wireUpdates();
  } else {
    await ensurePersistentStorage();
  }

  await showView('dashboard');
  await renderStorage();
  setInterval(renderStorage, 15_000);
}

// The external marking seam, and enough state for a wrapper to drive the app.
window.tradeJournal = {
  mark,
  bridge,
  handleRemoteCommand,
  start: startRecording,
  stop: stopRecording,
  get state() { return recorder?.state || 'idle'; },
  get sessionId() { return recorder?.sessionId || null; },
  get markers() { return [...liveMarkers]; },
  review,
  wizard,
  showView,
  refreshAll,
  get view() { return currentView; },
  get settings() { return { ...settings }; },
};

boot().catch((err) => {
  console.error(err);
  showAlert(`Startup failed: ${err?.message || err}`);
});
